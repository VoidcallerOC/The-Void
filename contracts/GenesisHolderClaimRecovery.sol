// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "./VoidPrimarySale.sol";

interface IGenesisRecoveryCollection {
    function balanceOfBatch(address[] calldata accounts, uint256[] calldata ids) external view returns (uint256[] memory);
}

interface IGenesisRecoveryRelease {
    struct EditionData {
        bytes32 releaseId;
        bytes32 editionId;
        address artist;
        uint256 maxSupply;
        uint256 mintedSupply;
        string metadataUri;
        bool exists;
    }
    function mint(address to, uint256 tokenId, uint256 amount, bytes calldata data) external;
    function maxSupplyOf(uint256 tokenId) external view returns (uint256);
    function edition(uint256 tokenId) external view returns (EditionData memory);
}

interface IGenesisRecoverySale {
    function releases() external view returns (address);
    function sales(uint256 tokenId) external view returns (
        uint256 priceWei, uint256 maxSupply, uint256 sold, uint256 perWalletLimit,
        uint64 startTime, uint64 endTime, bool paused, bool configured
    );
}

/// @title GenesisHolderClaimRecovery
/// @notice Recovery-only Genesis claim gate. It is intentionally separate from the original
/// GenesisHolderClaim so the deployed contract and its immutable deadline remain untouched.
/// The constructor requires an explicit live-state baseline and seeds every prior claimant.
contract GenesisHolderClaimRecovery is ReentrancyGuard {
    address public constant GENESIS_CONTRACT = 0xD1B4367dd9f235f9ee61878019d66E31511E98eE;
    uint256 public constant GENESIS_CHAIN_ID = 43114;
    uint256 public constant GENESIS_MAX_TOKEN_ID = 3;
    uint256 public constant CLAIM_QUANTITY = 1;
    address public constant LEGACY_FUJI_SINGLETON = 0x7Bba0690a43E2FFE9ad553fbDa0451177B7B95B6;
    uint256 public constant PRODUCTION_CLAIM_WINDOW = 1 days;
    uint256 public constant PRODUCTION_PUBLIC_MIN = 7 days;
    uint256 public constant PRODUCTION_PUBLIC_MAX = 14 days;
    uint256 public constant PRODUCTION_PUBLIC_STEP = 1 hours;
    uint256 public constant PRODUCTION_PRICE = 0.25 ether;
    bytes32 public constant ELIGIBILITY_RULE = keccak256(
        "the-void:genesis-eligibility:v3:live-balanceOf(wallet,0..3)-minus-units-used-by-earlier-claims>0;used-units-follow-transfers"
    );
    bytes32 private constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("The Void Genesis Holder Claim");
    bytes32 private constant VERSION_HASH = keccak256("1");
    bytes32 private constant VOUCHER_TYPEHASH = keccak256(
        "ClaimVoucher(address claimant,address genesisContract,uint256 genesisChainId,bytes32 eligibilityRule,uint256 destinationChainId,address releaseContract,uint256 tokenId,uint256 quantity,uint256 allocation,uint256 nonce,uint256 deadline)"
    );
    uint256 private constant SECP256K1N_HALF = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    struct ClaimVoucher {
        address claimant;
        address genesisContract;
        uint256 genesisChainId;
        bytes32 eligibilityRule;
        uint256 destinationChainId;
        address releaseContract;
        uint256 tokenId;
        uint256 quantity;
        uint256 allocation;
        uint256 nonce;
        uint256 deadline;
    }

    struct SaleState {
        uint256 price;
        uint256 maxSupply;
        uint256 sold;
        uint64 start;
        uint64 end;
        bool configured;
    }

    struct RecoveryConfig {
        address releaseContract;
        address primarySale;
        uint256 tokenId;
        uint256 allocation;
        uint256 publicAllocation;
        uint256 claimStart;
        uint256 claimWindow;
        uint256 publicSaleStart;
        uint256 publicSaleEnd;
        uint256 publicPriceWei;
        uint256 baselineClaimedSupply;
        address admin;
        address signer;
    }

    address public immutable releaseContract;
    address public immutable primarySale;
    uint256 public immutable destinationChainId;
    uint256 public immutable tokenId;
    uint256 public immutable allocation;
    uint256 public immutable publicAllocation;
    uint256 public immutable claimStart;
    uint256 public immutable claimWindow;
    uint256 public immutable publicWindow;
    uint256 public immutable claimEnd;
    uint256 public immutable publicSaleStart;
    uint256 public immutable publicSaleEnd;
    uint256 public immutable publicPriceWei;

    address public admin;
    address public signer;
    uint256 public claimedSupply;
    bool public paused;
    mapping(address => bool) public hasClaimed;
    mapping(uint256 => bool) public usedNonces;

    error Unauthorized();
    error InvalidAddress();
    error InvalidConfiguration();
    error InvalidBaseline(uint256 releaseMinted, uint256 saleSold, uint256 baseline);
    error InvalidVoucher();
    error InvalidSignature();
    error ExpiredVoucher();
    error Replay();
    error AlreadyClaimed();
    error Paused();
    error AllocationExhausted(uint256 remaining, uint256 requested);
    error PublicAllocationChanged(uint256 expected, uint256 actual);
    error WrongDestinationChain(uint256 expected, uint256 actual);
    error SupplyAccountingMismatch(uint256 releaseMinted, uint256 saleSold, uint256 claimsMinted);
    error PublicPriceChanged(uint256 expected, uint256 actual);
    error PublicSaleSchedule(uint64 saleStart, uint64 saleEnd, uint256 expectedStart, uint256 expectedEnd);
    error ClaimNotOpen(uint256 claimStart, uint256 currentTime);
    error ClaimWindowClosed(uint256 claimEnd, uint256 currentTime);
    error NotGenesisHolder(address account);

    event SignerUpdated(address indexed previousSigner, address indexed newSigner);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);
    event ClaimPaused(address indexed account);
    event ClaimUnpaused(address indexed account);
    event GenesisHolderClaimed(address indexed claimant, address indexed releaseContract, uint256 indexed tokenId, uint256 quantity, uint256 nonce, bytes32 voucherHash);

    modifier onlyAdmin() {
        if (msg.sender != admin) revert Unauthorized();
        _;
    }

    constructor(RecoveryConfig memory cfg, address[] memory priorClaimants) {
        if (cfg.releaseContract == address(0) || cfg.primarySale == address(0) || cfg.admin == address(0) || cfg.signer == address(0)
            || cfg.signer == cfg.admin || cfg.releaseContract == cfg.primarySale || cfg.releaseContract == GENESIS_CONTRACT
            || cfg.primarySale == GENESIS_CONTRACT || cfg.releaseContract == LEGACY_FUJI_SINGLETON
            || cfg.releaseContract.code.length == 0 || cfg.primarySale.code.length == 0 || block.chainid != GENESIS_CHAIN_ID) {
            revert InvalidConfiguration();
        }
        uint256 publicWindow_ = cfg.publicSaleEnd - cfg.publicSaleStart + 1;
        if (cfg.claimWindow != PRODUCTION_CLAIM_WINDOW || cfg.publicPriceWei != PRODUCTION_PRICE
            || cfg.publicSaleEnd < cfg.publicSaleStart || publicWindow_ < PRODUCTION_PUBLIC_MIN
            || publicWindow_ > PRODUCTION_PUBLIC_MAX || publicWindow_ % PRODUCTION_PUBLIC_STEP != 0 || cfg.claimWindow == 0) revert InvalidConfiguration();
        if (IGenesisRecoverySale(cfg.primarySale).releases() != cfg.releaseContract) revert InvalidConfiguration();
        if (!IGenesisRecoveryRelease(cfg.releaseContract).edition(cfg.tokenId).exists) revert InvalidConfiguration();
        SaleState memory sale = _saleState(cfg.primarySale, cfg.tokenId);
        if (!sale.configured || sale.price != cfg.publicPriceWei || sale.maxSupply != cfg.publicAllocation) revert InvalidConfiguration();
        if (uint256(sale.start) != cfg.publicSaleStart || uint256(sale.end) != cfg.publicSaleEnd) revert InvalidConfiguration();
        if (cfg.allocation != 0 && cfg.allocation < cfg.baselineClaimedSupply) revert InvalidConfiguration();
        if (priorClaimants.length != cfg.baselineClaimedSupply) revert InvalidBaseline(0, sale.sold, cfg.baselineClaimedSupply);
        uint256 releaseMinted = IGenesisRecoveryRelease(cfg.releaseContract).edition(cfg.tokenId).mintedSupply;
        if (releaseMinted != sale.sold + cfg.baselineClaimedSupply) revert InvalidBaseline(releaseMinted, sale.sold, cfg.baselineClaimedSupply);

        releaseContract = cfg.releaseContract;
        primarySale = cfg.primarySale;
        destinationChainId = block.chainid;
        tokenId = cfg.tokenId;
        allocation = cfg.allocation;
        publicAllocation = cfg.publicAllocation;
        claimStart = cfg.claimStart;
        claimWindow = cfg.claimWindow;
        claimEnd = cfg.claimStart + cfg.claimWindow;
        publicSaleStart = cfg.publicSaleStart;
        publicSaleEnd = cfg.publicSaleEnd;
        publicWindow = publicWindow_;
        publicPriceWei = cfg.publicPriceWei;
        admin = cfg.admin;
        signer = cfg.signer;
        claimedSupply = cfg.baselineClaimedSupply;
        for (uint256 i; i < priorClaimants.length; ++i) {
            address claimant = priorClaimants[i];
            if (claimant == address(0) || hasClaimed[claimant]) revert InvalidBaseline(0, sale.sold, cfg.baselineClaimedSupply);
            hasClaimed[claimant] = true;
        }
    }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function voucherDigest(ClaimVoucher calldata voucher) external view returns (bytes32) { return _digest(voucher); }

    function setSigner(address newSigner) external onlyAdmin {
        if (newSigner == address(0) || newSigner == admin) revert InvalidAddress();
        address previous = signer;
        signer = newSigner;
        emit SignerUpdated(previous, newSigner);
    }

    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0) || newAdmin == signer) revert InvalidAddress();
        address previous = admin;
        admin = newAdmin;
        emit AdminTransferred(previous, newAdmin);
    }

    function pause() external onlyAdmin { paused = true; emit ClaimPaused(msg.sender); }
    function unpause() external onlyAdmin { paused = false; emit ClaimUnpaused(msg.sender); }

    function claim(ClaimVoucher calldata voucher, bytes calldata signature) external nonReentrant {
        if (paused) revert Paused();
        if (block.chainid != destinationChainId) revert WrongDestinationChain(destinationChainId, block.chainid);
        if (block.timestamp < claimStart) revert ClaimNotOpen(claimStart, block.timestamp);
        if (block.timestamp >= claimEnd) revert ClaimWindowClosed(claimEnd, block.timestamp);
        if (voucher.deadline < block.timestamp) revert ExpiredVoucher();
        if (voucher.claimant == address(0) || voucher.claimant != msg.sender) revert InvalidVoucher();
        if (voucher.genesisContract != GENESIS_CONTRACT || voucher.genesisChainId != GENESIS_CHAIN_ID
            || voucher.eligibilityRule != ELIGIBILITY_RULE || voucher.destinationChainId != destinationChainId
            || voucher.releaseContract != releaseContract || voucher.tokenId != tokenId
            || voucher.allocation != allocation || voucher.quantity != CLAIM_QUANTITY) revert InvalidVoucher();
        if (hasClaimed[voucher.claimant]) revert AlreadyClaimed();
        if (usedNonces[voucher.nonce]) revert Replay();
        if (allocation != 0 && voucher.quantity > allocation - claimedSupply) revert AllocationExhausted(allocation - claimedSupply, voucher.quantity);
        _assertPublicAllocation();
        if (_recover(_digest(voucher), signature) != signer) revert InvalidSignature();
        _assertGenesisHolder(voucher.claimant);
        hasClaimed[voucher.claimant] = true;
        usedNonces[voucher.nonce] = true;
        claimedSupply += voucher.quantity;
        IGenesisRecoveryRelease(releaseContract).mint(voucher.claimant, tokenId, voucher.quantity, "");
        emit GenesisHolderClaimed(voucher.claimant, releaseContract, tokenId, voucher.quantity, voucher.nonce, _digest(voucher));
    }

    function _assertPublicAllocation() private view {
        SaleState memory sale = _saleState(primarySale, tokenId);
        if (!sale.configured || sale.maxSupply != publicAllocation) revert PublicAllocationChanged(publicAllocation, sale.maxSupply);
        if (uint256(sale.start) != publicSaleStart || uint256(sale.end) != publicSaleEnd) revert PublicSaleSchedule(sale.start, sale.end, publicSaleStart, publicSaleEnd);
        if (sale.price != publicPriceWei) revert PublicPriceChanged(publicPriceWei, sale.price);
        uint256 releaseMinted = IGenesisRecoveryRelease(releaseContract).edition(tokenId).mintedSupply;
        if (releaseMinted != sale.sold + claimedSupply) revert SupplyAccountingMismatch(releaseMinted, sale.sold, claimedSupply);
    }

    function _saleState(address saleAddress, uint256 id) private view returns (SaleState memory state) {
        (state.price, state.maxSupply, state.sold,, state.start, state.end,, state.configured) = IGenesisRecoverySale(saleAddress).sales(id);
    }

    function _assertGenesisHolder(address account) private view {
        address[] memory accounts = new address[](GENESIS_MAX_TOKEN_ID + 1);
        uint256[] memory ids = new uint256[](GENESIS_MAX_TOKEN_ID + 1);
        for (uint256 i; i <= GENESIS_MAX_TOKEN_ID; ++i) { accounts[i] = account; ids[i] = i; }
        uint256[] memory balances = IGenesisRecoveryCollection(GENESIS_CONTRACT).balanceOfBatch(accounts, ids);
        for (uint256 i; i < balances.length; ++i) if (balances[i] != 0) return;
        revert NotGenesisHolder(account);
    }

    function _digest(ClaimVoucher calldata voucher) private view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(VOUCHER_TYPEHASH, voucher.claimant, voucher.genesisContract, voucher.genesisChainId, voucher.eligibilityRule, voucher.destinationChainId, voucher.releaseContract, voucher.tokenId, voucher.quantity, voucher.allocation, voucher.nonce, voucher.deadline));
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
    }

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address) {
        if (signature.length != 65) return address(0);
        bytes32 r; bytes32 s; uint8 v;
        assembly { r := calldataload(signature.offset) s := calldataload(add(signature.offset, 32)) v := byte(0, calldataload(add(signature.offset, 64))) }
        if (uint256(s) > SECP256K1N_HALF || (v != 27 && v != 28)) return address(0);
        return ecrecover(digest, v, r, s);
    }
}
