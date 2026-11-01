// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IWeekendClaimRelease {
    struct EditionData {
        bytes32 releaseId;
        bytes32 editionId;
        address artist;
        uint256 maxSupply;
        uint256 mintedSupply;
        string metadataUri;
        bool exists;
    }

    function edition(uint256 tokenId) external view returns (EditionData memory);
    function mint(address to, uint256 tokenId, uint256 amount, bytes calldata data) external;
}

interface IWeekendClaimSale {
    function releases() external view returns (address);
    function sales(uint256 tokenId) external view returns (
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

interface IPriorGenesisClaim {
    function hasClaimed(address claimant) external view returns (bool);
    function releaseContract() external view returns (address);
    function tokenId() external view returns (uint256);
    function claimedSupply() external view returns (uint256);
}

/// @title The Void Genesis weekend claim (C-Chain and The Grotto)
/// @notice One free edition of `tokenId` per wallet on a fixed snapshot allowlist of Genesis holders on
/// Avalanche C-Chain or The Grotto, excluding every wallet that already claimed through an earlier
/// Genesis claim contract. Eligibility is a Merkle root fixed at deployment: no signer, no voucher.
/// The contract deploys paused and inactive. Only the admin can activate it, once, before `claimEnd`.
/// `claimEnd` is immutable: the window cannot be extended. Claims mint through the release's
/// ISSUER_ROLE, so the role must be granted to this contract and should be revoked after `claimEnd`.
contract GenesisWeekendClaim {
    uint256 public constant GENESIS_CHAIN_ID = 43114;
    uint256 public constant GROTTO_CHAIN_ID = 36463;
    address public constant GENESIS_CONTRACT = 0xD1B4367dd9f235f9ee61878019d66E31511E98eE;
    address public constant GROTTO_WRAPPED_COLLECTION = 0x0d6Fa9968aa57295217737379c44eBbc1130B1Fa;
    uint256 public constant CLAIM_QUANTITY = 1;
    /// @notice The owner-approved close: 2026-11-02 04:59:59 UTC (Sunday 2026-11-01 11:59:59 PM EST).
    uint256 public constant WEEKEND_CLAIM_END = 1_793_595_599;
    uint256 public constant PRIOR_CLAIM_COUNT = 3;
    bytes32 public constant CAMPAIGN = keccak256("the-void:genesis-weekend-claim:v1");
    bytes32 public constant ELIGIBILITY_RULE = keccak256(
        "the-void:genesis-weekend:v1:snapshot(cchain-balanceOf(wallet,0..3)>0|grotto-wrapped-balanceOf(wallet,0..3)>0)"
        ";excluding-bridge-custody,zero-address,prior-claimants;one-per-wallet"
    );
    // Studio and API compatibility: the weekend claim never caps or reserves supply.
    uint256 public constant allocation = 0;
    uint256 public constant publicAllocation = 0;

    struct Config {
        address releaseContract;
        address primarySale;
        uint256 tokenId;
        bytes32 merkleRoot;
        uint256 eligibleWallets;
        uint256 snapshotCChainBlock;
        uint256 snapshotGrottoBlock;
        bytes32 snapshotHash;
        uint256 claimEnd;
        uint256 baselineClaimedSupply;
        address admin;
        address[3] priorClaims;
    }

    address public immutable releaseContract;
    address public immutable primarySale;
    uint256 public immutable tokenId;
    bytes32 public immutable merkleRoot;
    uint256 public immutable eligibleWallets;
    uint256 public immutable snapshotCChainBlock;
    uint256 public immutable snapshotGrottoBlock;
    bytes32 public immutable snapshotHash;
    uint256 public immutable claimEnd;
    uint256 public immutable baselineClaimedSupply;
    // The live paid sale's schedule and price at deployment, for Artist Studio's claim guard.
    uint256 public immutable publicSaleStart;
    uint256 public immutable publicSaleEnd;
    uint256 public immutable publicPriceWei;
    address public immutable priorClaimOne;
    address public immutable priorClaimTwo;
    address public immutable priorClaimThree;

    address public admin;
    bool public active;
    bool public paused = true;
    uint256 public claimStart;
    uint256 public claimedSupply;
    mapping(address => bool) public hasClaimed;

    uint256 private _locked = 1;

    error InvalidConfiguration();
    error InvalidBaseline(uint256 minted, uint256 sold, uint256 baseline);
    error NotAdmin(address account);
    error AlreadyActive();
    error NotActive();
    error ClaimPaused();
    error ClaimWindowClosed(uint256 claimEnd, uint256 currentTime);
    error AlreadyClaimed(address claimant);
    error PriorClaimRecorded(address claimant, address priorClaim);
    error NotEligible(address claimant);
    error SupplyAccountingMismatch(uint256 minted, uint256 sold, uint256 claimed);
    error AllowlistExhausted(uint256 claimedSupply, uint256 limit);
    error Reentrancy();

    event Activated(address indexed admin, uint256 claimStart, uint256 claimEnd);
    event ClaimPausedBy(address indexed admin);
    event ClaimUnpausedBy(address indexed admin);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);
    event GenesisWeekendClaimed(address indexed claimant, address indexed releaseContract, uint256 indexed tokenId, uint256 quantity);

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin(msg.sender);
        _;
    }

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(Config memory cfg) {
        if (block.chainid != GENESIS_CHAIN_ID || cfg.releaseContract == address(0) || cfg.primarySale == address(0)
            || cfg.admin == address(0) || cfg.releaseContract.code.length == 0 || cfg.primarySale.code.length == 0
            || cfg.releaseContract == GENESIS_CONTRACT || cfg.merkleRoot == bytes32(0) || cfg.eligibleWallets == 0
            || cfg.snapshotCChainBlock == 0 || cfg.snapshotCChainBlock >= block.number || cfg.snapshotGrottoBlock == 0
            || cfg.snapshotHash == bytes32(0) || cfg.claimEnd != WEEKEND_CLAIM_END || cfg.claimEnd <= block.timestamp) revert InvalidConfiguration();
        if (IWeekendClaimSale(cfg.primarySale).releases() != cfg.releaseContract) revert InvalidConfiguration();
        IWeekendClaimRelease.EditionData memory edition = IWeekendClaimRelease(cfg.releaseContract).edition(cfg.tokenId);
        if (!edition.exists) revert InvalidConfiguration();

        for (uint256 i; i < PRIOR_CLAIM_COUNT; ++i) {
            address prior = cfg.priorClaims[i];
            if (prior == address(0) || prior.code.length == 0 || prior == cfg.releaseContract) revert InvalidConfiguration();
            for (uint256 j; j < i; ++j) if (cfg.priorClaims[j] == prior) revert InvalidConfiguration();
            if (IPriorGenesisClaim(prior).releaseContract() != cfg.releaseContract || IPriorGenesisClaim(prior).tokenId() != cfg.tokenId) {
                revert InvalidConfiguration();
            }
        }
        // The last prior claim carries every earlier claim in its own baseline, so its claimedSupply is
        // the authoritative count of historical Genesis claims, and the edition must be fully accounted for.
        uint256 historical = IPriorGenesisClaim(cfg.priorClaims[PRIOR_CLAIM_COUNT - 1]).claimedSupply();
        (uint256 price,, uint256 sold,, uint64 start, uint64 end,, bool configured) = IWeekendClaimSale(cfg.primarySale).sales(cfg.tokenId);
        if (!configured || cfg.baselineClaimedSupply != historical || edition.mintedSupply != sold + historical) {
            revert InvalidBaseline(edition.mintedSupply, sold, cfg.baselineClaimedSupply);
        }

        releaseContract = cfg.releaseContract;
        primarySale = cfg.primarySale;
        tokenId = cfg.tokenId;
        merkleRoot = cfg.merkleRoot;
        eligibleWallets = cfg.eligibleWallets;
        snapshotCChainBlock = cfg.snapshotCChainBlock;
        snapshotGrottoBlock = cfg.snapshotGrottoBlock;
        snapshotHash = cfg.snapshotHash;
        claimEnd = cfg.claimEnd;
        baselineClaimedSupply = cfg.baselineClaimedSupply;
        publicSaleStart = start;
        publicSaleEnd = end;
        publicPriceWei = price;
        priorClaimOne = cfg.priorClaims[0];
        priorClaimTwo = cfg.priorClaims[1];
        priorClaimThree = cfg.priorClaims[2];
        admin = cfg.admin;
        claimedSupply = cfg.baselineClaimedSupply;
    }

    /// @notice Opens the claim. Callable once, by the admin, before `claimEnd`, and only while the
    /// edition's supply accounting balances.
    function activate() external onlyAdmin {
        if (active) revert AlreadyActive();
        if (block.timestamp >= claimEnd) revert ClaimWindowClosed(claimEnd, block.timestamp);
        _assertSupplyAccounting();
        active = true;
        paused = false;
        claimStart = block.timestamp;
        emit Activated(msg.sender, block.timestamp, claimEnd);
    }

    function pause() external onlyAdmin {
        if (!active) revert NotActive();
        paused = true;
        emit ClaimPausedBy(msg.sender);
    }

    function unpause() external onlyAdmin {
        if (!active) revert NotActive();
        if (block.timestamp >= claimEnd) revert ClaimWindowClosed(claimEnd, block.timestamp);
        paused = false;
        emit ClaimUnpausedBy(msg.sender);
    }

    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert InvalidConfiguration();
        emit AdminTransferred(admin, newAdmin);
        admin = newAdmin;
    }

    /// @notice Claims one edition for the caller. The proof must place the caller's own address in the
    /// snapshot allowlist; it cannot be used by, or for, any other wallet.
    function claim(bytes32[] calldata proof) external nonReentrant {
        if (!active) revert NotActive();
        if (paused) revert ClaimPaused();
        if (block.timestamp >= claimEnd) revert ClaimWindowClosed(claimEnd, block.timestamp);
        if (hasClaimed[msg.sender]) revert AlreadyClaimed(msg.sender);
        _assertNoPriorClaim(msg.sender);
        if (!_verify(proof, leaf(msg.sender))) revert NotEligible(msg.sender);
        _assertSupplyAccounting();
        // Defense in depth for the release's unlimited ISSUER_ROLE: never more claims than allowlisted wallets.
        if (claimedSupply + CLAIM_QUANTITY > baselineClaimedSupply + eligibleWallets) {
            revert AllowlistExhausted(claimedSupply, baselineClaimedSupply + eligibleWallets);
        }

        hasClaimed[msg.sender] = true;
        claimedSupply += CLAIM_QUANTITY;
        IWeekendClaimRelease(releaseContract).mint(msg.sender, tokenId, CLAIM_QUANTITY, "");
        _assertSupplyAccounting();
        emit GenesisWeekendClaimed(msg.sender, releaseContract, tokenId, CLAIM_QUANTITY);
    }

    /// @notice The allowlist leaf for `account`: bound to this campaign and to C-Chain.
    function leaf(address account) public pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(CAMPAIGN, GENESIS_CHAIN_ID, account))));
    }

    function isEligible(address account, bytes32[] calldata proof) external view returns (bool) {
        return _verify(proof, leaf(account));
    }

    /// @notice True when `account` has claimed here or through any earlier Genesis claim contract.
    function hasClaimedAnywhere(address account) external view returns (bool) {
        if (hasClaimed[account]) return true;
        return IPriorGenesisClaim(priorClaimOne).hasClaimed(account) || IPriorGenesisClaim(priorClaimTwo).hasClaimed(account)
            || IPriorGenesisClaim(priorClaimThree).hasClaimed(account);
    }

    function claimable() external view returns (bool) {
        return active && !paused && block.timestamp < claimEnd;
    }

    function _assertNoPriorClaim(address account) private view {
        if (IPriorGenesisClaim(priorClaimOne).hasClaimed(account)) revert PriorClaimRecorded(account, priorClaimOne);
        if (IPriorGenesisClaim(priorClaimTwo).hasClaimed(account)) revert PriorClaimRecorded(account, priorClaimTwo);
        if (IPriorGenesisClaim(priorClaimThree).hasClaimed(account)) revert PriorClaimRecorded(account, priorClaimThree);
    }

    function _assertSupplyAccounting() private view {
        uint256 minted = IWeekendClaimRelease(releaseContract).edition(tokenId).mintedSupply;
        (,, uint256 sold,,,,,) = IWeekendClaimSale(primarySale).sales(tokenId);
        if (minted != sold + claimedSupply) revert SupplyAccountingMismatch(minted, sold, claimedSupply);
    }

    // Sorted-pair Merkle verification (OpenZeppelin MerkleProof semantics).
    function _verify(bytes32[] calldata proof, bytes32 node) private view returns (bool) {
        bytes32 computed = node;
        for (uint256 i; i < proof.length; ++i) {
            bytes32 sibling = proof[i];
            computed = computed < sibling ? keccak256(abi.encode(computed, sibling)) : keccak256(abi.encode(sibling, computed));
        }
        return computed == merkleRoot;
    }
}
