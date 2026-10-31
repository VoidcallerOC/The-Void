// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GenesisWeekendClaim} from "../contracts/GenesisWeekendClaim.sol";

interface VmWeekend {
    function warp(uint256 timestamp) external;
    function roll(uint256 blockNumber) external;
    function chainId(uint256 newChainId) external;
    function prank(address account) external;
    function expectRevert(bytes calldata revertData) external;
    function expectRevert(bytes4 revertData) external;
    function expectPartialRevert(bytes4 selector) external;
}

contract WeekendMockRelease {
    struct EditionData {
        bytes32 releaseId;
        bytes32 editionId;
        address artist;
        uint256 maxSupply;
        uint256 mintedSupply;
        string metadataUri;
        bool exists;
    }

    mapping(address => bool) public issuer;
    mapping(address => uint256) public balanceOf;
    uint256 public minted;
    bool public callReceiver;

    function setIssuer(address account, bool allowed) external { issuer[account] = allowed; }
    function setMinted(uint256 value) external { minted = value; }
    function setCallReceiver(bool value) external { callReceiver = value; }

    function edition(uint256 tokenId) external view returns (EditionData memory data) {
        data.exists = tokenId == 1;
        data.mintedSupply = minted;
    }

    function mint(address to, uint256 tokenId, uint256 amount, bytes calldata) external {
        require(issuer[msg.sender], "not issuer");
        require(tokenId == 1, "token");
        minted += amount;
        balanceOf[to] += amount;
        if (callReceiver && to.code.length > 0) WeekendReceiver(to).onERC1155Received(msg.sender, address(0), tokenId, amount, "");
    }
}

contract WeekendMockSale {
    address public releases;
    uint256 public sold;
    uint64 public start = 1_793_019_600;
    uint64 public end = 1_794_315_540;

    constructor(address release_) { releases = release_; }

    function setSold(uint256 value) external { sold = value; }

    function sales(uint256) external view returns (uint256, uint256, uint256, uint256, uint64, uint64, bool, bool) {
        return (0.25 ether, 0, sold, 3, start, end, false, true);
    }

    function purchase(address buyer) external {
        sold += 1;
        WeekendMockRelease(releases).mint(buyer, 1, 1, "");
    }
}

contract WeekendMockPrior {
    address public releaseContract;
    uint256 public tokenId = 1;
    uint256 public claimedSupply;
    mapping(address => bool) public hasClaimed;

    constructor(address release_, uint256 claimed_) { releaseContract = release_; claimedSupply = claimed_; }
    function setClaimed(address account) external { hasClaimed[account] = true; }
}

contract WeekendReceiver {
    GenesisWeekendClaim public target;
    bytes32[] internal proof;
    bool public reenter;

    function arm(GenesisWeekendClaim target_, bytes32[] memory proof_) external { target = target_; proof = proof_; reenter = true; }
    function claim(GenesisWeekendClaim target_, bytes32[] memory proof_) external { target_.claim(proof_); }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external returns (bytes4) {
        if (reenter) { reenter = false; target.claim(proof); }
        return this.onERC1155Received.selector;
    }
}

contract GenesisWeekendClaimTest {
    VmWeekend internal constant vm = VmWeekend(address(uint160(uint256(keccak256("hevm cheat code")))));

    // Fixture produced by server/genesis-weekend-merkle.js (buildWeekendTree) for the five wallets below,
    // so these tests also prove the JavaScript tree and the contract's verification agree.
    bytes32 internal constant ROOT = 0xf17ea286a6647756db17a2329d4375b1478f1cf0a61f0008dedcee5bdfb68669;
    address internal constant HOLDER_A = address(0xa1);
    address internal constant HOLDER_B = address(0xb2);
    address internal constant HOLDER_C = address(0xc3);
    address internal constant GROTTO_ONLY = 0x626b1AeAdB9Fc0b465B40aDE4F4bBF0C01C9Db40;
    address internal constant PRIOR_CLAIMANT = 0x6a86EfA012fEDA64b70112022487fEE22E67d2fb;
    address internal constant ADMIN = address(0xAD);
    address internal constant OUTSIDER = address(0xBAD);
    uint256 internal constant CLOSE = 1_793_595_599; // 2026-11-02 04:59:59 UTC
    uint256 internal constant START = 1_793_500_000;

    WeekendMockRelease internal release;
    WeekendMockSale internal sale;
    WeekendMockPrior internal priorOne;
    WeekendMockPrior internal priorTwo;
    WeekendMockPrior internal priorThree;
    GenesisWeekendClaim internal claim;

    function setUp() public {
        vm.chainId(43114);
        vm.roll(1_000);
        vm.warp(START);
        release = new WeekendMockRelease();
        sale = new WeekendMockSale(address(release));
        priorOne = new WeekendMockPrior(address(release), 0);
        priorTwo = new WeekendMockPrior(address(release), 2);
        priorThree = new WeekendMockPrior(address(release), 4);
        priorThree.setClaimed(PRIOR_CLAIMANT);
        sale.setSold(1);
        release.setMinted(5);
        claim = new GenesisWeekendClaim(_config(ROOT, 4, CLOSE));
        release.setIssuer(address(claim), true);
        release.setIssuer(address(sale), true);
    }

    function _config(bytes32 root, uint256 baseline, uint256 close) internal view returns (GenesisWeekendClaim.Config memory cfg) {
        cfg = GenesisWeekendClaim.Config({
            releaseContract: address(release), primarySale: address(sale), tokenId: 1, merkleRoot: root, eligibleWallets: 5,
            snapshotCChainBlock: 999, snapshotGrottoBlock: 151_791, snapshotHash: keccak256("snapshot"), claimEnd: close,
            baselineClaimedSupply: baseline, admin: ADMIN,
            priorClaims: [address(priorOne), address(priorTwo), address(priorThree)]
        });
    }

    function _proofA() internal pure returns (bytes32[] memory p) {
        p = new bytes32[](3);
        p[0] = 0x5d658e39ae24b2b2c7d834033130db735c4e9c2d6f5fdba15c0e7b1a507d48dc;
        p[1] = 0x3b4de31e1d0013248aaf965dbfb0902c4c283fb9eb2bb6e421ce7abed2bcbf90;
        p[2] = 0xfa8d1d0a17bab1e3d76316a8243285859f1026281684fcdc7db43ca793d8ea55;
    }

    function _proofB() internal pure returns (bytes32[] memory p) {
        p = new bytes32[](3);
        p[0] = 0x96252012c68dc272239dd7746359afa079b84bbcac911f190bb187d63c8611e4;
        p[1] = 0x3b4de31e1d0013248aaf965dbfb0902c4c283fb9eb2bb6e421ce7abed2bcbf90;
        p[2] = 0xfa8d1d0a17bab1e3d76316a8243285859f1026281684fcdc7db43ca793d8ea55;
    }

    function _proofC() internal pure returns (bytes32[] memory p) {
        p = new bytes32[](1);
        p[0] = 0x5193a9be83e998408e583598ac292cb9e8137b8451d661f0d0df1fb7399e9b55;
    }

    function _proofGrotto() internal pure returns (bytes32[] memory p) {
        p = new bytes32[](3);
        p[0] = 0xa8f81af244e056c3f7a725b2e5d599058523fda434192b61b46d9eb82569c350;
        p[1] = 0x75aefcce8768aa4c9b547f549186c958374753c8a54492f07e47ff3ab59766d2;
        p[2] = 0xfa8d1d0a17bab1e3d76316a8243285859f1026281684fcdc7db43ca793d8ea55;
    }

    function _proofPrior() internal pure returns (bytes32[] memory p) {
        p = new bytes32[](3);
        p[0] = 0xd2a33e83612e07e533dbae180ca65209ec8bb2ff13a08a154b151212ec7aba03;
        p[1] = 0x75aefcce8768aa4c9b547f549186c958374753c8a54492f07e47ff3ab59766d2;
        p[2] = 0xfa8d1d0a17bab1e3d76316a8243285859f1026281684fcdc7db43ca793d8ea55;
    }

    function _activate() internal {
        vm.prank(ADMIN);
        claim.activate();
    }

    function _claimAs(address account, bytes32[] memory proof) internal {
        vm.prank(account);
        claim.claim(proof);
    }

    function _invariant() internal view {
        require(release.minted() == sale.sold() + claim.claimedSupply(), "supply invariant");
    }

    // Deployment and activation.

    function testDeploysPausedInactiveWithVerifiedBaseline() public view {
        require(!claim.active() && claim.paused() && claim.claimStart() == 0, "not paused by default");
        require(claim.claimedSupply() == 4 && claim.baselineClaimedSupply() == 4, "baseline");
        require(claim.claimEnd() == CLOSE && claim.merkleRoot() == ROOT, "immutables");
        require(claim.publicSaleStart() == 1_793_019_600 && claim.publicSaleEnd() == 1_794_315_540 && claim.publicPriceWei() == 0.25 ether, "sale mirror");
        require(claim.allocation() == 0 && claim.publicAllocation() == 0 && claim.tokenId() == 1, "studio views");
        require(!claim.claimable(), "claimable before activation");
        _invariant();
    }

    function testClaimBeforeActivationReverts() public {
        vm.prank(HOLDER_A);
        vm.expectRevert(GenesisWeekendClaim.NotActive.selector);
        claim.claim(_proofA());
    }

    function testOnlyAdminActivatesOnceAndOnlyBeforeClose() public {
        vm.prank(OUTSIDER);
        vm.expectPartialRevert(GenesisWeekendClaim.NotAdmin.selector);
        claim.activate();
        _activate();
        require(claim.active() && !claim.paused() && claim.claimStart() == START, "activated");
        vm.prank(ADMIN);
        vm.expectRevert(GenesisWeekendClaim.AlreadyActive.selector);
        claim.activate();
    }

    function testActivationAfterCloseReverts() public {
        vm.warp(CLOSE);
        vm.prank(ADMIN);
        vm.expectPartialRevert(GenesisWeekendClaim.ClaimWindowClosed.selector);
        claim.activate();
    }

    function testRejectsWrongBaselineChainRootOrDeadline() public {
        vm.expectPartialRevert(GenesisWeekendClaim.InvalidBaseline.selector);
        new GenesisWeekendClaim(_config(ROOT, 3, CLOSE));
        vm.expectRevert(GenesisWeekendClaim.InvalidConfiguration.selector);
        new GenesisWeekendClaim(_config(bytes32(0), 4, CLOSE));
        vm.expectRevert(GenesisWeekendClaim.InvalidConfiguration.selector);
        new GenesisWeekendClaim(_config(ROOT, 4, START));
        release.setMinted(6);
        vm.expectPartialRevert(GenesisWeekendClaim.InvalidBaseline.selector);
        new GenesisWeekendClaim(_config(ROOT, 4, CLOSE));
        release.setMinted(5);
        vm.chainId(36463);
        vm.expectRevert(GenesisWeekendClaim.InvalidConfiguration.selector);
        new GenesisWeekendClaim(_config(ROOT, 4, CLOSE));
    }

    function testRejectsDuplicateOrForeignPriorClaims() public {
        GenesisWeekendClaim.Config memory cfg = _config(ROOT, 4, CLOSE);
        cfg.priorClaims[1] = cfg.priorClaims[0];
        vm.expectRevert(GenesisWeekendClaim.InvalidConfiguration.selector);
        new GenesisWeekendClaim(cfg);
        WeekendMockPrior foreign = new WeekendMockPrior(address(sale), 4);
        cfg = _config(ROOT, 4, CLOSE);
        cfg.priorClaims[2] = address(foreign);
        vm.expectRevert(GenesisWeekendClaim.InvalidConfiguration.selector);
        new GenesisWeekendClaim(cfg);
    }

    // Eligibility.

    function testCChainHolderClaimsOnce() public {
        _activate();
        _claimAs(HOLDER_A, _proofA());
        require(release.balanceOf(HOLDER_A) == 1 && claim.hasClaimed(HOLDER_A) && claim.claimedSupply() == 5, "claimed");
        _invariant();
        vm.prank(HOLDER_A);
        vm.expectPartialRevert(GenesisWeekendClaim.AlreadyClaimed.selector);
        claim.claim(_proofA());
    }

    function testGrottoOnlyHolderClaimsWithoutBridgingBack() public {
        _activate();
        _claimAs(GROTTO_ONLY, _proofGrotto());
        require(release.balanceOf(GROTTO_ONLY) == 1 && claim.hasClaimedAnywhere(GROTTO_ONLY), "grotto claim");
        _invariant();
    }

    function testOddTreeCarriedNodeProofWorks() public {
        _activate();
        _claimAs(HOLDER_C, _proofC());
        require(release.balanceOf(HOLDER_C) == 1, "carried node");
    }

    function testPriorClaimantIsRejectedEvenWithAValidProof() public {
        _activate();
        require(claim.isEligible(PRIOR_CLAIMANT, _proofPrior()), "fixture");
        vm.prank(PRIOR_CLAIMANT);
        vm.expectPartialRevert(GenesisWeekendClaim.PriorClaimRecorded.selector);
        claim.claim(_proofPrior());
        priorOne.setClaimed(HOLDER_B);
        vm.prank(HOLDER_B);
        vm.expectPartialRevert(GenesisWeekendClaim.PriorClaimRecorded.selector);
        claim.claim(_proofB());
    }

    function testProofCannotBeUsedByAnotherWalletOrOutsider() public {
        _activate();
        vm.prank(HOLDER_B);
        vm.expectPartialRevert(GenesisWeekendClaim.NotEligible.selector);
        claim.claim(_proofA());
        vm.prank(OUTSIDER);
        vm.expectPartialRevert(GenesisWeekendClaim.NotEligible.selector);
        claim.claim(_proofA());
        bytes32[] memory empty = new bytes32[](0);
        vm.prank(OUTSIDER);
        vm.expectPartialRevert(GenesisWeekendClaim.NotEligible.selector);
        claim.claim(empty);
    }

    function testTamperedProofReverts() public {
        _activate();
        bytes32[] memory p = _proofA();
        p[1] = bytes32(uint256(p[1]) ^ 1);
        vm.prank(HOLDER_A);
        vm.expectPartialRevert(GenesisWeekendClaim.NotEligible.selector);
        claim.claim(p);
    }

    // Window and pause.

    function testClaimAtAndAfterDeadlineReverts() public {
        _activate();
        vm.warp(CLOSE - 1);
        _claimAs(HOLDER_A, _proofA());
        vm.warp(CLOSE);
        vm.prank(HOLDER_B);
        vm.expectPartialRevert(GenesisWeekendClaim.ClaimWindowClosed.selector);
        claim.claim(_proofB());
        vm.prank(ADMIN);
        vm.expectPartialRevert(GenesisWeekendClaim.ClaimWindowClosed.selector);
        claim.unpause();
    }

    function testPauseBlocksClaimsAndOnlyAdminControlsIt() public {
        _activate();
        vm.prank(OUTSIDER);
        vm.expectPartialRevert(GenesisWeekendClaim.NotAdmin.selector);
        claim.pause();
        vm.prank(ADMIN);
        claim.pause();
        vm.prank(HOLDER_A);
        vm.expectRevert(GenesisWeekendClaim.ClaimPaused.selector);
        claim.claim(_proofA());
        vm.prank(ADMIN);
        claim.unpause();
        _claimAs(HOLDER_A, _proofA());
    }

    // Supply accounting and the paid sale.

    function testPaidSaleKeepsWorkingAndInvariantHoldsAcrossBoth() public {
        _activate();
        sale.purchase(OUTSIDER);
        _invariant();
        _claimAs(HOLDER_A, _proofA());
        sale.purchase(OUTSIDER);
        _claimAs(GROTTO_ONLY, _proofGrotto());
        require(release.minted() == 9 && sale.sold() == 3 && claim.claimedSupply() == 6, "counts");
        _invariant();
    }

    function testUnaccountedMintStopsClaims() public {
        _activate();
        release.setIssuer(address(this), true);
        release.mint(OUTSIDER, 1, 1, "");
        vm.prank(HOLDER_A);
        vm.expectPartialRevert(GenesisWeekendClaim.SupplyAccountingMismatch.selector);
        claim.claim(_proofA());
    }

    function testClaimWithoutIssuerRoleReverts() public {
        _activate();
        release.setIssuer(address(claim), false);
        vm.prank(HOLDER_A);
        vm.expectRevert(bytes("not issuer"));
        claim.claim(_proofA());
        require(!claim.hasClaimed(HOLDER_A) && claim.claimedSupply() == 4, "state rolled back");
    }

    function testReentrantSecondClaimIsBlocked() public {
        // A one-wallet allowlist's root is that wallet's leaf, proven by an empty proof. The receiver is an
        // eligible contract wallet that re-enters claim() from the ERC-1155 mint callback.
        WeekendReceiver receiver = new WeekendReceiver();
        bytes32[] memory empty = new bytes32[](0);
        GenesisWeekendClaim single = new GenesisWeekendClaim(_config(claim.leaf(address(receiver)), 4, CLOSE));
        release.setIssuer(address(single), true);
        release.setCallReceiver(true);
        vm.prank(ADMIN);
        single.activate();
        receiver.arm(single, empty);
        vm.expectRevert(GenesisWeekendClaim.Reentrancy.selector);
        receiver.claim(single, empty);
        require(release.balanceOf(address(receiver)) == 0 && single.claimedSupply() == 4, "no partial mint");
    }

    function testAdminTransfer() public {
        vm.prank(ADMIN);
        claim.transferAdmin(OUTSIDER);
        vm.prank(OUTSIDER);
        claim.activate();
        require(claim.admin() == OUTSIDER && claim.active(), "admin transferred");
    }
}
