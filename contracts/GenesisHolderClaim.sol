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
/// @dev Fixed schedule: free Genesis claims for exactly CLAIM_WINDOW from claimStart, then the
/// token's own primary sale must open at claimEnd and close PUBLIC_WINDOW later at publicPriceWei.
/// The sale is the artist's VoidPrimarySale; this contract re-checks its configuration on every
/// claim and fails closed if it drifts. Eligibility is fixed at a C-Chain snapshot block that the
/// immutable ELIGIBILITY_RULE commits to; the server signs vouchers only for snapshot holders.
contract GenesisHolderClaim {
    address public constant GENESIS_CONTRACT = 0xD1B4367dd9f235f9ee61878019d66E31511E98eE;
    uint256 public constant GENESIS_CHAIN_ID = 43114;
    address public constant LEGACY_FUJI_SINGLETON = 0x7Bba0690a43E2FFE9ad553fbDa0451177B7B95B6;
    uint256 public constant CLAIM_WINDOW = 1 days;
    uint256 public constant PUBLIC_WINDOW = 7 days;
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
    /// @notice Reserved claim cap; 0 means uncapped (open editions only: one claim per snapshot wallet).
    uint256 public immutable allocation;
    /// @notice Must equal the sale's maxSupply; 0 means the open-edition sale is uncapped.
    uint256 public immutable publicAllocation;
    /// @notice Claims are accepted while claimStart <= block.timestamp < claimEnd.
    uint256 public immutable claimStart;
    uint256 public immutable claimEnd;
    /// @notice The sale's endTime. VoidPrimarySale accepts purchases while startTime <= now <= endTime,
    /// so endTime = claimEnd + PUBLIC_WINDOW - 1 gives a public window of exactly PUBLIC_WINDOW.
    uint256 public immutable publicSaleEnd;
    uint256 public immutable publicPriceWei;
    /// @notice Commitment to the snapshot eligibility rule (chain, collection, block, block hash, token IDs).
    bytes32 public immutable ELIGIBILITY_RULE;

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
    error PublicSaleSchedule(uint64 saleStart, uint64 saleEnd, uint256 expectedStart, uint256 expectedEnd);
    error PublicPriceChanged(uint256 expected, uint256 actual);
    error ClaimNotOpen(uint256 claimStart, uint256 currentTime);
    error ClaimWindowClosed(uint256 claimEnd, uint256 currentTime);

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
        uint256 claimStart_,
        uint256 publicPriceWei_,
        bytes32 eligibilityRule_,
        address admin_,
        address signer_
    ) {
        if (
            releaseContract_ == address(0) || primarySale_ == address(0) || admin_ == address(0)
                || signer_ == address(0) || releaseContract_ == LEGACY_FUJI_SINGLETON
                || eligibilityRule_ == bytes32(0) || publicPriceWei_ == 0 || claimStart_ < block.timestamp
                || (block.chainid != 43113 && block.chainid != 43114)
        ) revert InvalidConfiguration();
        uint256 releaseMaxSupply = IGenesisClaimRelease(releaseContract_).maxSupplyOf(tokenId_);
        if (releaseMaxSupply != 0) {
            // A capped edition needs finite, non-overlapping claim and public allocations.
            if (allocation_ == 0 || allocation_ > releaseMaxSupply || publicAllocation_ > releaseMaxSupply - allocation_) {
                revert InvalidConfiguration();
            }
        }
        // An open edition (maxSupply 0) may leave both allocations at 0: no supply cap exists, and
        // each snapshot wallet can still claim only once (hasClaimed).
        releaseContract = releaseContract_;
        primarySale = primarySale_;
        destinationChainId = block.chainid;
        tokenId = tokenId_;
        allocation = allocation_;
        publicAllocation = publicAllocation_;
        claimStart = claimStart_;
        claimEnd = claimStart_ + CLAIM_WINDOW;
        publicSaleEnd = claimStart_ + CLAIM_WINDOW + PUBLIC_WINDOW - 1;
        publicPriceWei = publicPriceWei_;
        ELIGIBILITY_RULE = eligibilityRule_;
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
        if (block.timestamp < claimStart) revert ClaimNotOpen(claimStart, block.timestamp);
        if (block.timestamp >= claimEnd) revert ClaimWindowClosed(claimEnd, block.timestamp);
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
        if (allocation != 0) {
            uint256 remaining = allocation - claimedSupply;
            if (voucher.quantity > remaining) revert AllocationExhausted(remaining, voucher.quantity);
        }
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

    /// @dev The public sale must be exactly the scheduled phase: it opens when claims close, stays open
    /// for PUBLIC_WINDOW at publicPriceWei, and its cap is publicAllocation (0 = uncapped).
    function _assertPublicAllocation() private view {
        (uint256 salePrice, uint256 saleMaxSupply, uint256 saleSold,, uint64 saleStart, uint64 saleEnd,, bool configured) =
            IGenesisClaimSale(primarySale).sales(tokenId);
        if (!configured || saleMaxSupply != publicAllocation) {
            revert PublicAllocationChanged(publicAllocation, saleMaxSupply);
        }
        if (uint256(saleStart) != claimEnd || uint256(saleEnd) != publicSaleEnd) {
            revert PublicSaleSchedule(saleStart, saleEnd, claimEnd, publicSaleEnd);
        }
        if (salePrice != publicPriceWei) revert PublicPriceChanged(publicPriceWei, salePrice);
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
