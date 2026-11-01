// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GenesisWeekendClaim} from "../contracts/GenesisWeekendClaim.sol";

interface VmWeekendFork {
    function createSelectFork(string calldata url, uint256 blockNumber) external returns (uint256);
    function envOr(string calldata name, string calldata defaultValue) external returns (string memory);
    function warp(uint256 timestamp) external;
    function prank(address account) external;
    function deal(address account, uint256 value) external;
    function expectPartialRevert(bytes4 selector) external;
}

interface WeekendForkRelease {
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
    function ISSUER_ROLE() external view returns (bytes32);
    function grantRole(bytes32 role, address account) external;
    function revokeRole(bytes32 role, address account) external;
    function hasRole(bytes32 role, address account) external view returns (bool);
    function balanceOf(address account, uint256 tokenId) external view returns (uint256);
}

interface WeekendForkSale {
    function sales(uint256 tokenId) external view returns (uint256, uint256, uint256, uint256, uint64, uint64, bool, bool);
    function purchase(uint256 tokenId, uint256 qty) external payable;
}

interface WeekendForkPrior {
    function hasClaimed(address account) external view returns (bool);
    function claimedSupply() external view returns (uint256);
}

/// @notice Fork-backed verification against the real C-Chain state at PINNED_BLOCK (2026-11-01, after the
/// Forgive & Forget sale was extended to 2026-11-10 and the fixed weekend close was replaced by a 24-hour window
/// opened at activation). All mutations happen on the local fork.
contract GenesisWeekendClaimMainnetForkTest {
    VmWeekendFork internal constant vm = VmWeekendFork(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 internal constant PINNED_BLOCK = 99_123_400;
    uint256 internal constant TOKEN_ID = 1;
    uint256 internal constant SALE_END = 1_794_315_540; // 2026-11-10 12:59:00 UTC
    uint256 internal deadline;
    address internal constant RELEASE = 0xF0C091A159DE16cF0F306b2B61d37685EC5A830e;
    address internal constant SALE = 0xB4dAAe78a53c33f52C6EB573c4d6EFC7B86F3845;
    address internal constant ARTIST = 0x284C09a7CC187E096cbbdc88d99DEFE6df32180a;
    address internal constant PRIOR_FAILED = 0x8512be04a4E54cd8551738165F9c05C3303187a0;
    address internal constant PRIOR_ORIGINAL = 0x7D1a068F532aD6c0f591d4Fb9F82fd5b97495363;
    address internal constant PRIOR_RECOVERY = 0xd70dBA7fF6419481d62D4689bDf271ad441766b8;
    address internal constant GROTTO_ONLY = 0x626b1AeAdB9Fc0b465B40aDE4F4bBF0C01C9Db40;
    address internal constant GROTTO_ONLY_TWO = 0x6a228d9405FF5DA1382EE2555E0048FeD469B28D;
    address internal constant BOTH_CHAINS = 0xD43a6388eAD01B950598EA589abC05103650d1a4;
    address internal constant PRIOR_CLAIMANT = 0x6a86EfA012fEDA64b70112022487fEE22E67d2fb;
    address internal constant BUYER = address(0xB0B);
    // Fixture produced by server/genesis-weekend-merkle.js for the four wallets above.
    bytes32 internal constant ROOT = 0xadc280f90ed1e33034b5e0cc978ebb023b6a41a9d23dad543917cef1e9063a28;

    WeekendForkRelease internal release;
    WeekendForkSale internal sale;
    GenesisWeekendClaim internal claim;

    function setUp() public {
        string memory rpc = vm.envOr("MAINNET_FORK_RPC", "https://api.avax.network/ext/bc/C/rpc");
        vm.createSelectFork(rpc, PINNED_BLOCK);
        require(block.chainid == 43114, "not C-Chain");
        release = WeekendForkRelease(RELEASE);
        sale = WeekendForkSale(SALE);

        (uint256 price, uint256 maxSupply, uint256 sold,, uint64 start, uint64 end, bool paused, bool configured) = sale.sales(TOKEN_ID);
        require(price == 0.25 ether && maxSupply == 0 && sold == 1 && !paused && configured, "unexpected live sale");
        require(start == 1_793_019_600 && end == 1_794_315_540, "unexpected sale schedule");
        require(release.edition(TOKEN_ID).mintedSupply == 5, "unexpected minted supply");
        require(WeekendForkPrior(PRIOR_RECOVERY).claimedSupply() == 4, "unexpected historical claims");
        require(WeekendForkPrior(PRIOR_ORIGINAL).hasClaimed(PRIOR_CLAIMANT), "claimant not recorded");

        deadline = block.timestamp + 2 days;
        claim = new GenesisWeekendClaim(GenesisWeekendClaim.Config({
            releaseContract: RELEASE, primarySale: SALE, tokenId: TOKEN_ID, merkleRoot: ROOT, eligibleWallets: 4,
            snapshotCChainBlock: PINNED_BLOCK - 1, snapshotGrottoBlock: 151_791, snapshotHash: keccak256("fork-fixture"),
            activationDeadline: deadline, baselineClaimedSupply: 4, admin: ARTIST,
            priorClaims: [PRIOR_FAILED, PRIOR_ORIGINAL, PRIOR_RECOVERY]
        }));
    }

    function _grantAndActivate() internal {
        bytes32 issuer = release.ISSUER_ROLE();
        vm.prank(ARTIST);
        release.grantRole(issuer, address(claim));
        vm.prank(ARTIST);
        claim.activate();
    }

    function _proof(bytes32 a, bytes32 b) internal pure returns (bytes32[] memory p) {
        p = new bytes32[](2);
        p[0] = a;
        p[1] = b;
    }

    function _invariant() internal view {
        (,, uint256 sold,,,,,) = sale.sales(TOKEN_ID);
        require(release.edition(TOKEN_ID).mintedSupply == sold + claim.claimedSupply(), "supply invariant");
    }

    function testDeploysPausedWithLiveBaselineAndSaleMirror() public view {
        require(!claim.active() && claim.paused() && claim.claimedSupply() == 4, "deploy state");
        require(claim.publicSaleEnd() == SALE_END && claim.publicPriceWei() == 0.25 ether, "sale mirror");
        require(claim.claimStart() == 0 && claim.claimEnd() == 0 && claim.activationDeadline() == deadline, "no window before activation");
        _invariant();
    }

    function testGrottoOnlyHoldersClaimOnTheRealRelease() public {
        _grantAndActivate();
        vm.prank(GROTTO_ONLY);
        claim.claim(_proof(0xa8f81af244e056c3f7a725b2e5d599058523fda434192b61b46d9eb82569c350, 0x15f2821db995c722d97bf66490b9277601d9a27179b35173225044b4adb7c1f2));
        vm.prank(GROTTO_ONLY_TWO);
        claim.claim(_proof(0x49c71b6d1f9680fbba204992e96f8842b3a1d9b9cccb7aceff5db94d92155735, 0x3b4de31e1d0013248aaf965dbfb0902c4c283fb9eb2bb6e421ce7abed2bcbf90));
        require(release.balanceOf(GROTTO_ONLY, TOKEN_ID) == 1 && release.balanceOf(GROTTO_ONLY_TWO, TOKEN_ID) == 1, "minted");
        require(claim.claimedSupply() == 6 && release.edition(TOKEN_ID).mintedSupply == 7, "accounting");
        _invariant();
    }

    function testBothChainHolderClaimsOnceOnly() public {
        _grantAndActivate();
        bytes32[] memory p = _proof(0x5ca9424663af437c26f21450c6eff3d803c0df37e7e8a16b9708bddeb636732b, 0x3b4de31e1d0013248aaf965dbfb0902c4c283fb9eb2bb6e421ce7abed2bcbf90);
        vm.prank(BOTH_CHAINS);
        claim.claim(p);
        vm.prank(BOTH_CHAINS);
        vm.expectPartialRevert(GenesisWeekendClaim.AlreadyClaimed.selector);
        claim.claim(p);
    }

    function testHistoricalClaimantIsRejected() public {
        _grantAndActivate();
        vm.prank(PRIOR_CLAIMANT);
        vm.expectPartialRevert(GenesisWeekendClaim.PriorClaimRecorded.selector);
        claim.claim(_proof(0xd2a33e83612e07e533dbae180ca65209ec8bb2ff13a08a154b151212ec7aba03, 0x15f2821db995c722d97bf66490b9277601d9a27179b35173225044b4adb7c1f2));
    }

    function testPaidSaleStillWorksAndAccountingHoldsAlongsideClaims() public {
        _grantAndActivate();
        vm.deal(BUYER, 1 ether);
        vm.prank(BUYER);
        sale.purchase{value: 0.25 ether}(TOKEN_ID, 1);
        require(release.balanceOf(BUYER, TOKEN_ID) == 1, "paid mint");
        _invariant();
        vm.prank(GROTTO_ONLY);
        claim.claim(_proof(0xa8f81af244e056c3f7a725b2e5d599058523fda434192b61b46d9eb82569c350, 0x15f2821db995c722d97bf66490b9277601d9a27179b35173225044b4adb7c1f2));
        _invariant();
    }

    function testActivationOpensA24HourWindowOnTheRealSale() public {
        uint256 activatedAt = block.timestamp;
        _grantAndActivate();
        require(claim.claimStart() == activatedAt && claim.claimEnd() == activatedAt + 86_400, "24-hour window");
        require(claim.claimEnd() <= SALE_END, "claim closes before the paid sale");
        vm.warp(activatedAt + 86_399);
        vm.prank(GROTTO_ONLY);
        claim.claim(_proof(0xa8f81af244e056c3f7a725b2e5d599058523fda434192b61b46d9eb82569c350, 0x15f2821db995c722d97bf66490b9277601d9a27179b35173225044b4adb7c1f2));
        _invariant();
    }

    function testActivationAfterTheDeadlineIsRefused() public {
        bytes32 issuer = release.ISSUER_ROLE();
        vm.prank(ARTIST);
        release.grantRole(issuer, address(claim));
        vm.warp(deadline + 1);
        vm.prank(ARTIST);
        vm.expectPartialRevert(GenesisWeekendClaim.ActivationWindowClosed.selector);
        claim.activate();
    }

    function testClosesAtDeadlineAndRoleCanBeRevoked() public {
        _grantAndActivate();
        vm.warp(claim.claimEnd());
        vm.prank(GROTTO_ONLY);
        vm.expectPartialRevert(GenesisWeekendClaim.ClaimWindowClosed.selector);
        claim.claim(_proof(0xa8f81af244e056c3f7a725b2e5d599058523fda434192b61b46d9eb82569c350, 0x15f2821db995c722d97bf66490b9277601d9a27179b35173225044b4adb7c1f2));
        bytes32 issuer = release.ISSUER_ROLE();
        vm.prank(ARTIST);
        release.revokeRole(issuer, address(claim));
        require(!release.hasRole(issuer, address(claim)), "role revoked");
    }
}
