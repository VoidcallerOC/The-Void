// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IGenesisClaimRelease {
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

interface IGenesisClaimSale {
    function sales(uint256 tokenId)
        external
        view
        returns (
            uint256 priceWei,
            uint256 maxSupply,
            uint256 sold,
            uint256 perWalletLimit,
            uint64 startTime,
            uint64 endTime,
            bool paused,
            bool configured
        );
}

/// @title GenesisHolderClaim
/// @notice One release-specific voucher redemption gate. Minting is delegated to the
/// release's existing ISSUER_ROLE path; this contract can mint only its immutable token.
contract GenesisHolderClaim {
    address public constant GENESIS_CONTRACT = 0xD1B4367dd9f235f9ee61878019d66E31511E98eE;
    uint256 public constant GENESIS_CHAIN_ID = 43114;
    address public constant LEGACY_FUJI_SINGLETON = 0x7Bba0690a43E2FFE9ad553fbDa0451177B7B95B6;
    bytes32 public constant ELIGIBILITY_RULE = keccak256(
        "the-void:genesis-eligibility:v1:balanceOf(wallet,0)>0|balanceOf(wallet,1)>0|balanceOf(wallet,2)>0|balanceOf(wallet,3)>0"
    );
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("The Void Genesis Holder Claim");
    bytes32 private constant VERSION_HASH = keccak256("1");
    bytes32 private constant VOUCHER_TYPEHASH = keccak256(
        "ClaimVoucher(address claimant,address genesisContract,uint256 genesisChainId,bytes32 eligibilityRule,uint256 destinationChainId,address releaseContract,uint256 tokenId,uint256 quantity,uint256 allocation,uint256 nonce,uint256 deadline)"
    );
    // secp256k1n / 2; rejects malleable ECDSA signatures.
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

    address public immutable releaseContract;
    address public immutable primarySale;
    uint256 public immutable destinationChainId;
    uint256 public immutable tokenId;
    uint256 public immutable allocation;
    uint256 public immutable publicAllocation;
    uint256 public immutable claimsOpenedAt;

    address public admin;
    address public signer;
    uint256 public claimedSupply;
    bool public paused;
    mapping(address => bool) public hasClaimed;
    mapping(uint256 => bool) public usedNonces;

    error Unauthorized();
    error InvalidAddress();
    error InvalidConfiguration();
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
    error PublicSaleWindow(uint64 saleStart, uint256 minimumStart, uint256 currentTime);

    event SignerUpdated(address indexed previousSigner, address indexed newSigner);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);
    event ClaimPaused(address indexed account);
    event ClaimUnpaused(address indexed account);
    event GenesisHolderClaimed(
        address indexed claimant,
        address indexed releaseContract,
        uint256 indexed tokenId,
        uint256 quantity,
        uint256 nonce,
        bytes32 voucherHash
    );

    modifier onlyAdmin() {
        if (msg.sender != admin) revert Unauthorized();
        _;
    }

    constructor(
        address releaseContract_,
        address primarySale_,
        uint256 tokenId_,
        uint256 allocation_,
        uint256 publicAllocation_,
        address admin_,
        address signer_
    ) {
        if (
            releaseContract_ == address(0) || primarySale_ == address(0) || admin_ == address(0)
                || signer_ == address(0) || releaseContract_ == LEGACY_FUJI_SINGLETON || allocation_ == 0
                || (block.chainid != 43113 && block.chainid != 43114)
        ) revert InvalidConfiguration();
        uint256 releaseMaxSupply = IGenesisClaimRelease(releaseContract_).maxSupplyOf(tokenId_);
        if (allocation_ > releaseMaxSupply || publicAllocation_ > releaseMaxSupply - allocation_) {
            revert InvalidConfiguration();
        }
        releaseContract = releaseContract_;
        primarySale = primarySale_;
        destinationChainId = block.chainid;
        tokenId = tokenId_;
        allocation = allocation_;
        publicAllocation = publicAllocation_;
        claimsOpenedAt = block.timestamp;
        admin = admin_;
        signer = signer_;
        _assertPublicAllocation();
    }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function voucherDigest(ClaimVoucher calldata voucher) external view returns (bytes32) {
        return _digest(voucher);
    }

    function setSigner(address newSigner) external onlyAdmin {
        if (newSigner == address(0)) revert InvalidAddress();
        address previous = signer;
        signer = newSigner;
        emit SignerUpdated(previous, newSigner);
    }

    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert InvalidAddress();
        address previous = admin;
        admin = newAdmin;
        emit AdminTransferred(previous, newAdmin);
    }

    function pause() external onlyAdmin {
        paused = true;
        emit ClaimPaused(msg.sender);
    }

    function unpause() external onlyAdmin {
        paused = false;
        emit ClaimUnpaused(msg.sender);
    }

    function claim(ClaimVoucher calldata voucher, bytes calldata signature) external {
        if (paused) revert Paused();
        if (block.chainid != destinationChainId) revert WrongDestinationChain(destinationChainId, block.chainid);
        if (voucher.deadline < block.timestamp) revert ExpiredVoucher();
        if (voucher.claimant == address(0) || voucher.claimant != msg.sender) revert InvalidVoucher();
        if (
            voucher.genesisContract != GENESIS_CONTRACT || voucher.genesisChainId != GENESIS_CHAIN_ID
                || voucher.eligibilityRule != ELIGIBILITY_RULE || voucher.destinationChainId != destinationChainId
                || voucher.releaseContract != releaseContract || voucher.tokenId != tokenId
                || voucher.allocation != allocation || voucher.quantity == 0
        ) revert InvalidVoucher();
        if (hasClaimed[voucher.claimant]) revert AlreadyClaimed();
        if (usedNonces[voucher.nonce]) revert Replay();
        uint256 remaining = allocation - claimedSupply;
        if (voucher.quantity > remaining) revert AllocationExhausted(remaining, voucher.quantity);
        _assertPublicAllocation();
        address recovered = _recover(_digest(voucher), signature);
        if (recovered == address(0) || recovered != signer) revert InvalidSignature();

        // Effects before the issuer call prevent callback reentrancy. A failed mint reverts all state.
        hasClaimed[voucher.claimant] = true;
        usedNonces[voucher.nonce] = true;
        claimedSupply += voucher.quantity;
        IGenesisClaimRelease(releaseContract).mint(voucher.claimant, tokenId, voucher.quantity, "");
        emit GenesisHolderClaimed(
            voucher.claimant, releaseContract, tokenId, voucher.quantity, voucher.nonce, _digest(voucher)
        );
    }

    function _assertPublicAllocation() private view {
        (, uint256 saleMaxSupply, uint256 saleSold,, uint64 saleStart,,, bool configured) =
            IGenesisClaimSale(primarySale).sales(tokenId);
        if (!configured || saleMaxSupply != publicAllocation) {
            revert PublicAllocationChanged(publicAllocation, saleMaxSupply);
        }
        uint256 minimumSaleStart = claimsOpenedAt + 1 days;
        if (uint256(saleStart) < minimumSaleStart || block.timestamp >= saleStart) {
            revert PublicSaleWindow(saleStart, minimumSaleStart, block.timestamp);
        }
        IGenesisClaimRelease.EditionData memory editionData = IGenesisClaimRelease(releaseContract).edition(tokenId);
        uint256 releaseMinted = editionData.mintedSupply;
        if (releaseMinted != saleSold + claimedSupply) {
            revert SupplyAccountingMismatch(releaseMinted, saleSold, claimedSupply);
        }
    }

    function _digest(ClaimVoucher calldata voucher) private view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                VOUCHER_TYPEHASH,
                voucher.claimant,
                voucher.genesisContract,
                voucher.genesisChainId,
                voucher.eligibilityRule,
                voucher.destinationChainId,
                voucher.releaseContract,
                voucher.tokenId,
                voucher.quantity,
                voucher.allocation,
                voucher.nonce,
                voucher.deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
    }

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address) {
        if (signature.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(s) > SECP256K1N_HALF || (v != 27 && v != 28)) return address(0);
        return ecrecover(digest, v, r, s);
    }
}
