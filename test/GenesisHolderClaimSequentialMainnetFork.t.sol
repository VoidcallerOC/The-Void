// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GenesisHolderClaim} from "../contracts/GenesisHolderClaim.sol";
import {VoidRelease1155V6Sequential} from "../contracts/VoidRelease1155V6Sequential.sol";
import {VoidPrimarySaleSettled} from "../contracts/VoidPrimarySaleSettled.sol";
import {VoidCollection1155} from "../contracts/VoidCollection1155.sol";

/// Runs GenesisHolderClaim against the REAL sequential Forgive & Forget release clone, its settled primary
/// sale and its live token 1 on Avalanche C-Chain, on a local fork. Nothing is broadcast. Skipped unless
/// MAINNET_FORK_RPC (or MAINNET_FORK_URL) is set.
/// If the live sale for token 1 is not configured yet, the artist's configureSale is replayed on the fork with
/// the only schedule the claim accepts; if it is configured, the live values are used and must already match.
interface VmSeqClaimFork {
    function createSelectFork(string calldata) external returns (uint256);
    function envOr(string calldata, string calldata) external returns (string memory);
    function skip(bool) external;
    function warp(uint256) external;
    function deal(address, uint256) external;
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function prank(address) external;
    function expectRevert() external;
    function expectPartialRevert(bytes4) external;
}

contract GenesisHolderClaimSequentialMainnetForkTest {
    VmSeqClaimFork internal constant vm = VmSeqClaimFork(address(uint160(uint256(keccak256("hevm cheat code")))));
    address internal constant CLONE = 0xF0C091A159DE16cF0F306b2B61d37685EC5A830e;
    address internal constant SALE = 0xB4dAAe78a53c33f52C6EB573c4d6EFC7B86F3845;
    address internal constant ARTIST = 0x284C09a7CC187E096cbbdc88d99DEFE6df32180a;
    address internal constant NANO = 0xb65C575CaE01574296Fab6E620B9A15cC0121ce4;
    uint256 internal constant TOKEN_ID = 1;
    string internal constant TOKEN_URI = "ipfs://QmNu8GW9VhW4dCuN1nyAF2HMv4FEoGgBCP72BbAYEgUY5U";
    uint256 internal constant PRICE = 0.25 ether;
    uint256 internal constant PLATFORM_CUT = (PRICE * 250) / 10_000;
    uint256 internal constant HALLOWEEN_START = 1_792_800_000;
    uint256 internal constant HALLOWEEN_END = 1_793_505_599;
    // Local cheat-code fixtures; the production admin and voucher signer are chosen separately.
    uint256 internal constant SIGNER_KEY = 0xA11CE;
    address internal constant ADMIN = address(0xAD01);
    address internal constant CLAIMANT = address(0xC1A1);
    address internal constant CLAIMANT_TWO = address(0xC1A2);
    address internal constant BUYER = address(0xB0B);

    VoidRelease1155V6Sequential internal release = VoidRelease1155V6Sequential(CLONE);
    VoidPrimarySaleSettled internal sale = VoidPrimarySaleSettled(SALE);
    GenesisHolderClaim internal claimContract;
    uint256 internal T;
    // The public window: 7 days for the replayed sale, or the live sale's own window once it is configured.
    uint256 internal W;
    uint256 internal mintedAtFork;
    uint256 internal soldAtFork;
    bool internal liveSaleConfigured;
    bytes4 internal deployBeforeSaleRevert;

    function setUp() public {
        string memory rpc = vm.envOr("MAINNET_FORK_RPC", vm.envOr("MAINNET_FORK_URL", string("")));
        if (bytes(rpc).length == 0) { vm.skip(true); return; }
        vm.createSelectFork(rpc);
        require(block.chainid == 43114, "not C-Chain");

        (uint256 price, uint256 cap, uint256 sold,, uint64 start, uint64 end, bool paused, bool configured) = sale.sales(TOKEN_ID);
        soldAtFork = sold;
        mintedAtFork = release.edition(TOKEN_ID).mintedSupply;
        liveSaleConfigured = configured;
        if (configured) {
            // Once the live sale has opened, a claim can no longer be deployed for it (claimStart >= now), and
            // live sales and claims change the accounting: this pre-deployment check is then reported as skipped.
            if (uint256(start) < block.timestamp) { vm.skip(true); return; }
            // A future live sale must already be the claim's schedule.
            T = start;
            require(price == PRICE && cap == 0 && !paused, "live sale price/cap/pause cannot carry the claim");
            // The claim constructor below enforces the production window policy on it.
            W = uint256(end) - T + 1;
        } else {
            T = block.timestamp + 1 hours;
            W = 7 days;
            // The claim cannot be deployed before the sale exists.
            try new GenesisHolderClaim(CLONE, SALE, TOKEN_ID, 0, 0, T, 1 days, W, PRICE, ADMIN, vm.addr(SIGNER_KEY)) {
                deployBeforeSaleRevert = bytes4(0);
            } catch (bytes memory reason) {
                deployBeforeSaleRevert = bytes4(reason);
            }
            vm.prank(ARTIST);
            sale.configureSale(TOKEN_ID, PRICE, 0, 0, uint64(T), uint64(T + W - 1), false);
        }
        claimContract = new GenesisHolderClaim(CLONE, SALE, TOKEN_ID, 0, 0, T, 1 days, W, PRICE, ADMIN, vm.addr(SIGNER_KEY));
        bytes32 issuerRole = release.ISSUER_ROLE();
        vm.prank(ARTIST);
        release.grantRole(issuerRole, address(claimContract));
    }

    function testLiveTokenOneIsAClaimableOpenEdition() public view {
        require(release.lastTokenId() == 1 && release.nextTokenId() == 2, "token counter");
        require(keccak256(bytes(release.uri(TOKEN_ID))) == keccak256(bytes(TOKEN_URI)), "token 1 uri");
        require(release.maxSupplyOf(TOKEN_ID) == 0, "edition is not open");
        require(release.mintEndOf(TOKEN_ID) == 0, "a mint end would have to equal the sale end");
        require(release.artistOf(TOKEN_ID) == ARTIST && release.payoutOf(TOKEN_ID) == ARTIST, "artist/payout");
        require(release.royaltyBpsOf(TOKEN_ID) == 250, "royalty");
        require(address(sale.releases()) == CLONE && sale.platformRecipient() == NANO, "sale binding");
        require(release.hasRole(release.ISSUER_ROLE(), SALE), "sale lost its issuer role");
        require(mintedAtFork == soldAtFork, "token 1 was minted outside the sale: the claim would fail closed");
    }

    function testClaimBindsToTheLiveCloneSaleAndSchedule() public {
        if (!liveSaleConfigured) {
            require(deployBeforeSaleRevert == GenesisHolderClaim.PublicAllocationChanged.selector, "claim deployed before its sale");
        }
        require(claimContract.releaseContract() == CLONE && claimContract.primarySale() == SALE, "targets");
        require(claimContract.tokenId() == TOKEN_ID && claimContract.destinationChainId() == 43114, "token/chain");
        require(claimContract.claimStart() == T && claimContract.claimEnd() == T + 1 days, "claim window");
        require(claimContract.publicSaleStart() == T && claimContract.publicSaleEnd() == T + W - 1, "sale window");
        require(claimContract.publicPriceWei() == PRICE && claimContract.allocation() == 0 && claimContract.publicAllocation() == 0, "economics");
        require(claimContract.admin() == ADMIN && claimContract.signer() == vm.addr(SIGNER_KEY), "roles");
        require(release.hasRole(release.ISSUER_ROLE(), address(claimContract)), "claim issuer role");
    }

    function testOnlyTheExactScheduleDeploys() public {
        // A start in the past, a claim window other than 24 h, or another price.
        _expectDeployRevert(block.timestamp - 1, 1 days, W, PRICE, GenesisHolderClaim.InvalidConfiguration.selector);
        _expectDeployRevert(T, 2 hours, W, PRICE, GenesisHolderClaim.InvalidConfiguration.selector);
        _expectDeployRevert(T, 1 days, W, 0.2 ether, GenesisHolderClaim.InvalidConfiguration.selector);
        // The sale itself must match: end one second late, a cap, or a price change each block deployment.
        vm.prank(ARTIST);
        sale.configureSale(TOKEN_ID, PRICE, 0, 0, uint64(T), uint64(T + W), false);
        _expectDeployRevert(T, 1 days, W, PRICE, GenesisHolderClaim.PublicSaleSchedule.selector);
        vm.prank(ARTIST);
        sale.configureSale(TOKEN_ID, PRICE, 100, 0, uint64(T), uint64(T + W - 1), false);
        _expectDeployRevert(T, 1 days, W, PRICE, GenesisHolderClaim.PublicAllocationChanged.selector);
        vm.prank(ARTIST);
        sale.configureSale(TOKEN_ID, 0.3 ether, 0, 0, uint64(T), uint64(T + W - 1), false);
        vm.expectPartialRevert(GenesisHolderClaim.InvalidConfiguration.selector);
        new GenesisHolderClaim(CLONE, SALE, TOKEN_ID, 0, 0, T, 1 days, W, 0.3 ether, ADMIN, vm.addr(SIGNER_KEY));
        _expectDeployRevert(T, 1 days, W, PRICE, GenesisHolderClaim.PublicPriceChanged.selector);
    }

    function testFreeClaimAndPaidPurchaseMintTheSameTokenAndSettle() public {
        vm.warp(T);
        _claim(CLAIMANT, 1);
        uint256 nanoBefore = NANO.balance;
        uint256 artistOwedBefore = sale.balances(ARTIST);
        vm.deal(BUYER, PRICE);
        vm.prank(BUYER);
        sale.purchase{value: PRICE}(TOKEN_ID, 1);
        require(release.balanceOf(CLAIMANT, TOKEN_ID) == 1 && release.balanceOf(BUYER, TOKEN_ID) == 1, "same token for both paths");
        require(NANO.balance - nanoBefore == PLATFORM_CUT, "2.5% not pushed to the fee recipient during the purchase");
        require(sale.balances(NANO) == 0, "fee recipient credited instead of paid");
        require(sale.balances(ARTIST) - artistOwedBefore == PRICE - PLATFORM_CUT, "97.5% not credited to the artist");
        _assertAccounting(1, 1);
        uint256 artistBefore = ARTIST.balance;
        uint256 owed = sale.balances(ARTIST);
        vm.prank(ARTIST);
        sale.withdraw();
        require(ARTIST.balance - artistBefore == owed && sale.balances(ARTIST) == 0, "artist withdrawal");
    }

    function testClaimProtections() public {
        _expectClaimRevert(CLAIMANT, _voucher(CLAIMANT, 1, T + 300), SIGNER_KEY, GenesisHolderClaim.ClaimNotOpen.selector);
        vm.warp(T);
        GenesisHolderClaim.ClaimVoucher memory voucher = _voucher(CLAIMANT, 2, block.timestamp + 300);
        bytes memory signature = _sign(SIGNER_KEY, voucher);
        // Only the named claimant can redeem a voucher.
        vm.expectPartialRevert(GenesisHolderClaim.InvalidVoucher.selector);
        vm.prank(BUYER);
        claimContract.claim(voucher, signature);
        vm.prank(CLAIMANT);
        claimContract.claim(voucher, signature);
        vm.expectPartialRevert(GenesisHolderClaim.AlreadyClaimed.selector);
        vm.prank(CLAIMANT);
        claimContract.claim(voucher, signature);
        _expectClaimRevert(CLAIMANT, _voucher(CLAIMANT, 3, block.timestamp + 300), SIGNER_KEY, GenesisHolderClaim.AlreadyClaimed.selector);
        _expectClaimRevert(BUYER, _voucher(BUYER, 2, block.timestamp + 300), SIGNER_KEY, GenesisHolderClaim.Replay.selector);
        _expectClaimRevert(BUYER, _voucher(BUYER, 4, block.timestamp + 300), 0xBAD, GenesisHolderClaim.InvalidSignature.selector);
        _expectClaimRevert(BUYER, _voucher(BUYER, 5, block.timestamp - 1), SIGNER_KEY, GenesisHolderClaim.ExpiredVoucher.selector);
        GenesisHolderClaim.ClaimVoucher memory wrongToken = _voucher(BUYER, 6, block.timestamp + 300);
        wrongToken.tokenId = 2;
        _expectClaimRevert(BUYER, wrongToken, SIGNER_KEY, GenesisHolderClaim.InvalidVoucher.selector);
        // Pause is the admin's alone, and blocks claims until lifted.
        vm.expectPartialRevert(GenesisHolderClaim.Unauthorized.selector);
        vm.prank(ARTIST);
        claimContract.pause();
        vm.prank(ADMIN);
        claimContract.pause();
        _expectClaimRevert(BUYER, _voucher(BUYER, 7, block.timestamp + 300), SIGNER_KEY, GenesisHolderClaim.Paused.selector);
        vm.prank(ADMIN);
        claimContract.unpause();
        _claim(BUYER, 7);
        require(claimContract.claimedSupply() == 2, "claimed supply");
        _assertAccounting(2, 0);
    }

    function testHour24ClosesClaimsNotSalesAndTheSaleEndClosesBoth() public {
        vm.deal(BUYER, PRICE * 3);
        vm.warp(T + 1 days - 1);
        _claim(CLAIMANT, 8);
        vm.warp(T + 1 days);
        _expectClaimRevert(CLAIMANT_TWO, _voucher(CLAIMANT_TWO, 9, block.timestamp + 300), SIGNER_KEY, GenesisHolderClaim.ClaimWindowClosed.selector);
        vm.prank(BUYER);
        sale.purchase{value: PRICE}(TOKEN_ID, 1);
        vm.warp(T + W - 1);
        vm.prank(BUYER);
        sale.purchase{value: PRICE}(TOKEN_ID, 1);
        vm.warp(T + W);
        vm.expectPartialRevert(VoidPrimarySaleSettled.SaleEnded.selector);
        vm.prank(BUYER);
        sale.purchase{value: PRICE}(TOKEN_ID, 1);
        _assertAccounting(1, 2);
    }

    function testDriftFailsClosed() public {
        vm.warp(T);
        _claim(CLAIMANT, 10);
        // The release revoked the artist's ISSUER_ROLE at initialization, so a direct mint first needs a grant.
        bytes32 issuerRole = release.ISSUER_ROLE();
        require(!release.hasRole(issuerRole, ARTIST), "artist holds ISSUER_ROLE on the live release");
        vm.expectPartialRevert(VoidCollection1155.AccessDenied.selector);
        vm.prank(ARTIST);
        release.mint(ARTIST, TOKEN_ID, 1, "");
        // If the artist grants it and mints token 1 outside the sale and claim, sold + claimed no longer adds up
        // and claims halt.
        vm.prank(ARTIST);
        release.grantRole(issuerRole, ARTIST);
        vm.prank(ARTIST);
        release.mint(ARTIST, TOKEN_ID, 1, "");
        _expectClaimRevert(CLAIMANT_TWO, _voucher(CLAIMANT_TWO, 11, block.timestamp + 300), SIGNER_KEY, GenesisHolderClaim.SupplyAccountingMismatch.selector);
    }

    function testRepricingOrRevokingTheIssuerHaltsClaims() public {
        vm.warp(T);
        vm.prank(ARTIST);
        sale.configureSale(TOKEN_ID, 0.3 ether, 0, 0, uint64(T), uint64(T + W - 1), false);
        _expectClaimRevert(CLAIMANT, _voucher(CLAIMANT, 12, block.timestamp + 300), SIGNER_KEY, GenesisHolderClaim.PublicPriceChanged.selector);
        vm.prank(ARTIST);
        sale.configureSale(TOKEN_ID, PRICE, 0, 0, uint64(T), uint64(T + W - 1), false);
        _claim(CLAIMANT, 12);
        // Revoking ISSUER_ROLE is the artist's own off switch; the claim then cannot mint.
        bytes32 issuerRole = release.ISSUER_ROLE();
        vm.prank(ARTIST);
        release.revokeRole(issuerRole, address(claimContract));
        GenesisHolderClaim.ClaimVoucher memory voucher = _voucher(CLAIMANT_TWO, 13, block.timestamp + 300);
        bytes memory signature = _sign(SIGNER_KEY, voucher);
        vm.expectRevert();
        vm.prank(CLAIMANT_TWO);
        claimContract.claim(voucher, signature);
        require(!claimContract.hasClaimed(CLAIMANT_TWO) && claimContract.claimedSupply() == 1, "reverted claim left state");
    }

    function testExactHalloweenScheduleOnTheLiveContracts() public {
        // 2026-10-23 8:00:00 PM to 2026-10-31 11:59:59 PM America/New_York, 3 paid per wallet. Only while the
        // start is still ahead of the fork; the live sale is reconfigured on the fork only.
        if (block.timestamp >= HALLOWEEN_START) { vm.skip(true); return; }
        vm.prank(ARTIST);
        sale.configureSale(TOKEN_ID, PRICE, 0, 3, uint64(HALLOWEEN_START), uint64(HALLOWEEN_END), false);
        claimContract = new GenesisHolderClaim(CLONE, SALE, TOKEN_ID, 0, 0, HALLOWEEN_START, 1 days, HALLOWEEN_END - HALLOWEEN_START + 1, PRICE, ADMIN, vm.addr(SIGNER_KEY));
        require(claimContract.publicSaleEnd() == HALLOWEEN_END && claimContract.claimEnd() == HALLOWEEN_START + 1 days, "schedule");
        bytes32 issuerRole = release.ISSUER_ROLE();
        vm.prank(ARTIST);
        release.grantRole(issuerRole, address(claimContract));
        vm.warp(HALLOWEEN_START);
        _claim(CLAIMANT, 30);
        vm.deal(CLAIMANT, PRICE * 4);
        vm.prank(CLAIMANT);
        sale.purchase{value: PRICE * 3}(TOKEN_ID, 3);
        vm.expectPartialRevert(VoidPrimarySaleSettled.WalletLimitExceeded.selector);
        vm.prank(CLAIMANT);
        sale.purchase{value: PRICE}(TOKEN_ID, 1);
        vm.warp(HALLOWEEN_START + 1 days);
        _expectClaimRevert(CLAIMANT_TWO, _voucher(CLAIMANT_TWO, 31, block.timestamp + 300), SIGNER_KEY, GenesisHolderClaim.ClaimWindowClosed.selector);
        vm.deal(BUYER, PRICE * 3);
        vm.prank(BUYER);
        sale.purchase{value: PRICE}(TOKEN_ID, 1);
        vm.warp(HALLOWEEN_END);
        vm.prank(BUYER);
        sale.purchase{value: PRICE}(TOKEN_ID, 1);
        vm.warp(HALLOWEEN_END + 1);
        vm.expectPartialRevert(VoidPrimarySaleSettled.SaleEnded.selector);
        vm.prank(BUYER);
        sale.purchase{value: PRICE}(TOKEN_ID, 1);
        require(release.balanceOf(CLAIMANT, TOKEN_ID) == 4 && release.balanceOf(BUYER, TOKEN_ID) == 2, "balances");
        _assertAccounting(1, 5);
    }

    function _assertAccounting(uint256 claimed, uint256 soldSinceFork) internal view {
        (,, uint256 saleSold,,,,,) = sale.sales(TOKEN_ID);
        require(saleSold == soldAtFork + soldSinceFork && claimContract.claimedSupply() == claimed, "counters");
        require(release.edition(TOKEN_ID).mintedSupply == saleSold + claimContract.claimedSupply(), "mintedSupply != sold + claimed");
    }

    function _expectDeployRevert(uint256 start, uint256 claimWindow, uint256 publicWindow, uint256 price, bytes4 selector) internal {
        vm.expectPartialRevert(selector);
        new GenesisHolderClaim(CLONE, SALE, TOKEN_ID, 0, 0, start, claimWindow, publicWindow, price, ADMIN, vm.addr(SIGNER_KEY));
    }

    function _claim(address claimant, uint256 nonce) internal {
        GenesisHolderClaim.ClaimVoucher memory voucher = _voucher(claimant, nonce, block.timestamp + 300);
        bytes memory signature = _sign(SIGNER_KEY, voucher);
        vm.prank(claimant);
        claimContract.claim(voucher, signature);
    }

    function _expectClaimRevert(address caller, GenesisHolderClaim.ClaimVoucher memory voucher, uint256 key, bytes4 selector) internal {
        bytes memory signature = _sign(key, voucher);
        vm.expectPartialRevert(selector);
        vm.prank(caller);
        claimContract.claim(voucher, signature);
    }

    function _voucher(address claimant, uint256 nonce, uint256 deadline) internal view returns (GenesisHolderClaim.ClaimVoucher memory) {
        return GenesisHolderClaim.ClaimVoucher({
            claimant: claimant,
            genesisContract: claimContract.GENESIS_CONTRACT(),
            genesisChainId: claimContract.GENESIS_CHAIN_ID(),
            eligibilityRule: claimContract.ELIGIBILITY_RULE(),
            destinationChainId: 43114,
            releaseContract: CLONE,
            tokenId: TOKEN_ID,
            quantity: 1,
            allocation: 0,
            nonce: nonce,
            deadline: deadline
        });
    }

    function _sign(uint256 key, GenesisHolderClaim.ClaimVoucher memory voucher) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, claimContract.voucherDigest(voucher));
        return abi.encodePacked(r, s, v);
    }
}
