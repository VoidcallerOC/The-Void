// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GenesisHolderClaim} from "../contracts/GenesisHolderClaim.sol";
import {VoidReleaseFactoryV4Sequential} from "../contracts/VoidReleaseFactoryV4Sequential.sol";
import {VoidRelease1155V6Sequential} from "../contracts/VoidRelease1155V6Sequential.sol";
import {VoidCollection1155} from "../contracts/VoidCollection1155.sol";
import {VoidPrimarySaleSettled} from "../contracts/VoidPrimarySaleSettled.sol";
import {MockGenesisCollection, installGenesisStandIn} from "./helpers/MockGenesisCollection.sol";

interface VmHalloween {
    function chainId(uint256) external;
    function warp(uint256) external;
    function deal(address, uint256) external;
    function prank(address) external;
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function expectRevert() external;
    function expectPartialRevert(bytes4) external;
}

/// @notice The Forgive & Forget Halloween launch on the production contracts (VoidReleaseFactoryV4Sequential,
/// VoidRelease1155V6Sequential token 1 created like Studio's single, VoidPrimarySaleSettled), on chain id 43114:
/// the free Genesis claim and the paid sale open together at 2026-10-23 8:00:00 PM America/New_York; claims close
/// exactly 24 hours later; the paid sale (0.25 AVAX, uncapped, 3 per wallet) runs through
/// 2026-10-31 11:59:59 PM America/New_York. Local EVM only; keys are cheat-code fixtures.
contract GenesisHolderClaimHalloweenScheduleTest {
    VmHalloween internal constant vm = VmHalloween(address(uint160(uint256(keccak256("hevm cheat code")))));
    address internal constant NANO = 0xb65C575CaE01574296Fab6E620B9A15cC0121ce4;
    address internal constant ARTIST = address(0xA7157);
    address internal constant ADMIN = address(0xAD01);
    address internal constant CLAIMANT = address(0xCA11);
    address internal constant CLAIMANT_TWO = address(0xCA12);
    address internal constant BUYER = address(0xB0B);
    uint256 internal constant SIGNER_KEY = 0xA11CE;
    uint256 internal constant OTHER_KEY = 0xBAD5;
    bytes32 internal constant APP = keccak256("forgive-and-forget-halloween");
    uint256 internal constant TOKEN_ID = 1;
    uint256 internal constant PRICE = 0.25 ether;
    uint256 internal constant PER_WALLET = 3;

    // 2026-10-23 20:00:00 EDT (UTC-4) = 2026-10-24T00:00:00Z.
    uint256 internal constant START = 1_792_800_000;
    // 2026-10-31 23:59:59 EDT (UTC-4; DST ends 2026-11-01 02:00 local) = 2026-11-01T03:59:59Z.
    uint256 internal constant END = 1_793_505_599;
    // 8 days 4 hours: publicSaleEnd = START + WINDOW - 1.
    uint256 internal constant WINDOW = END - START + 1;
    uint256 internal constant CLAIM_END = START + 1 days;

    VoidReleaseFactoryV4Sequential internal factory;
    VoidRelease1155V6Sequential internal release;
    VoidPrimarySaleSettled internal sale;
    GenesisHolderClaim internal claimContract;
    bytes32 internal releaseKey;

    function setUp() public {
        vm.chainId(43114);
        vm.warp(START - 1 hours);
        // The claim reads Genesis balances on 43114: the wallets that claim here each hold Genesis units.
        MockGenesisCollection genesis = installGenesisStandIn(false);
        genesis.setBalance(CLAIMANT, 0, 1);
        genesis.setBalance(CLAIMANT_TWO, 3, 2);
        genesis.setBalance(BUYER, 1, 1);
        factory = new VoidReleaseFactoryV4Sequential(NANO);
        releaseKey = keccak256(abi.encode("the-void:studio-release:v2", block.chainid, address(factory), APP, ARTIST));
        vm.prank(ARTIST);
        (address releaseAddress, address saleAddress,) = factory.createRelease(APP, releaseKey, "Forgive & Forget", "FNF", "ipfs://fnf");
        release = VoidRelease1155V6Sequential(releaseAddress);
        sale = VoidPrimarySaleSettled(saleAddress);
        // Studio's single path: no mint end (mintEndOf 0), like the live token 1.
        vm.prank(ARTIST);
        require(release.createEdition(releaseKey, bytes32(TOKEN_ID), 0, "ipfs://fnf-1", ARTIST, 250) == TOKEN_ID, "token 1");
        _configureSale(PRICE, 0, START, END);
        claimContract = _deploy(START, 1 days, WINDOW, PRICE, 0, 0, address(release));
        bytes32 issuerRole = release.ISSUER_ROLE();
        vm.prank(ARTIST);
        release.grantRole(issuerRole, address(claimContract));
    }

    // ---- the schedule ------------------------------------------------------------------------

    function testHalloweenScheduleIsAcceptedOnMainnet() public view {
        require(WINDOW == 196 hours && WINDOW == 8 days + 4 hours, "window is 8 days 4 hours");
        require(WINDOW % claimContract.PRODUCTION_PUBLIC_WINDOW_STEP() == 0, "whole hours");
        require(claimContract.destinationChainId() == 43114, "chain");
        require(claimContract.claimStart() == START && claimContract.publicSaleStart() == START, "common start");
        require(claimContract.claimWindow() == 1 days && claimContract.claimEnd() == START + 86_400, "24-hour claim");
        require(claimContract.publicWindow() == WINDOW && claimContract.publicSaleEnd() == END, "Halloween end");
        require(claimContract.publicPriceWei() == PRICE && claimContract.allocation() == 0 && claimContract.publicAllocation() == 0, "economics");
        (uint256 price, uint256 cap,, uint256 perWallet, uint64 start, uint64 end, bool paused, bool configured) = sale.sales(TOKEN_ID);
        require(configured && !paused && price == PRICE && cap == 0 && perWallet == PER_WALLET, "sale");
        require(start == START && end == END, "sale window");
        require(release.mintEndOf(TOKEN_ID) == 0 && release.maxSupplyOf(TOKEN_ID) == 0, "open edition, no mint end");
    }

    function testFreeClaimAndPaidPurchaseBothOpenDuringTheFirst24Hours() public {
        _expectClaimRevert(CLAIMANT, _voucher(CLAIMANT, 1, START + 300), SIGNER_KEY, GenesisHolderClaim.ClaimNotOpen.selector);
        vm.deal(BUYER, PRICE * 2);
        vm.expectPartialRevert(VoidPrimarySaleSettled.SaleNotStarted.selector);
        vm.prank(BUYER);
        sale.purchase{value: PRICE}(TOKEN_ID, 1);

        vm.warp(START);
        _claim(CLAIMANT, 1);
        vm.prank(BUYER);
        sale.purchase{value: PRICE}(TOKEN_ID, 1);
        vm.warp(CLAIM_END - 1);
        _claim(CLAIMANT_TWO, 2);
        vm.prank(BUYER);
        sale.purchase{value: PRICE}(TOKEN_ID, 1);
        require(release.balanceOf(CLAIMANT, TOKEN_ID) == 1 && release.balanceOf(CLAIMANT_TWO, TOKEN_ID) == 1, "claims");
        require(release.balanceOf(BUYER, TOKEN_ID) == 2, "purchases mint the same token");
        _assertAccounting(2, 2);
    }

    function testClaimIsRejectedAtAndAfterClaimEnd() public {
        vm.warp(CLAIM_END);
        _expectClaimRevert(CLAIMANT, _voucher(CLAIMANT, 3, block.timestamp + 300), SIGNER_KEY, GenesisHolderClaim.ClaimWindowClosed.selector);
        vm.warp(CLAIM_END + 1);
        _expectClaimRevert(CLAIMANT, _voucher(CLAIMANT, 4, block.timestamp + 300), SIGNER_KEY, GenesisHolderClaim.ClaimWindowClosed.selector);
        vm.warp(END);
        _expectClaimRevert(CLAIMANT, _voucher(CLAIMANT, 5, block.timestamp + 300), SIGNER_KEY, GenesisHolderClaim.ClaimWindowClosed.selector);
        require(claimContract.claimedSupply() == 0, "no claim after claimEnd");
    }

    function testPaidSaleContinuesThroughTheHalloweenEndAndThenCloses() public {
        vm.deal(BUYER, PRICE * 3);
        vm.warp(CLAIM_END);
        vm.prank(BUYER);
        sale.purchase{value: PRICE}(TOKEN_ID, 1);
        vm.warp(END - 1 days);
        vm.prank(BUYER);
        sale.purchase{value: PRICE}(TOKEN_ID, 1);
        // 2026-10-31 11:59:59 PM America/New_York is still open.
        vm.warp(END);
        vm.prank(BUYER);
        sale.purchase{value: PRICE}(TOKEN_ID, 1);
        // 2026-11-01 12:00:00 AM America/New_York is closed.
        vm.deal(CLAIMANT, PRICE);
        vm.warp(END + 1);
        vm.expectPartialRevert(VoidPrimarySaleSettled.SaleEnded.selector);
        vm.prank(CLAIMANT);
        sale.purchase{value: PRICE}(TOKEN_ID, 1);
        _assertAccounting(0, 3);
    }

    // ---- the schedule must match exactly -----------------------------------------------------

    function testClaimStartAndPaidSaleStartMustMatchExactly() public {
        _expectDeployRevert(START + 1, 1 days, WINDOW - 1, PRICE, 0, 0, address(release), GenesisHolderClaim.InvalidConfiguration.selector);
        // The claim names START but the sale opens a second earlier or later (same end).
        _configureSale(PRICE, 0, START - 1, END);
        _expectDeployRevert(START, 1 days, WINDOW, PRICE, 0, 0, address(release), GenesisHolderClaim.PublicSaleSchedule.selector);
        _configureSale(PRICE, 0, START + 1, END);
        _expectDeployRevert(START, 1 days, WINDOW, PRICE, 0, 0, address(release), GenesisHolderClaim.PublicSaleSchedule.selector);
        // A deployed claim fails closed when the sale start drifts.
        vm.warp(START + 1);
        _expectClaimRevert(CLAIMANT, _voucher(CLAIMANT, 6, block.timestamp + 300), SIGNER_KEY, GenesisHolderClaim.PublicSaleSchedule.selector);
        _configureSale(PRICE, 0, START, END);
        _claim(CLAIMANT, 6);
    }

    function testWrongEndPriceChainTokenReleaseOrAllocationFailsClosed() public {
        // Sale end one second early or late.
        _configureSale(PRICE, 0, START, END - 1);
        _expectDeployRevert(START, 1 days, WINDOW, PRICE, 0, 0, address(release), GenesisHolderClaim.PublicSaleSchedule.selector);
        _configureSale(PRICE, 0, START, END + 1);
        _expectDeployRevert(START, 1 days, WINDOW, PRICE, 0, 0, address(release), GenesisHolderClaim.PublicSaleSchedule.selector);
        // Price: the claim refuses anything but 0.25 AVAX, and refuses a sale at another price.
        _configureSale(0.3 ether, 0, START, END);
        _expectDeployRevert(START, 1 days, WINDOW, 0.3 ether, 0, 0, address(release), GenesisHolderClaim.InvalidConfiguration.selector);
        _expectDeployRevert(START, 1 days, WINDOW, PRICE, 0, 0, address(release), GenesisHolderClaim.PublicPriceChanged.selector);
        // Public allocation must equal the sale cap (0 = uncapped).
        _configureSale(PRICE, 0, START, END);
        _expectDeployRevert(START, 1 days, WINDOW, PRICE, 0, 5, address(release), GenesisHolderClaim.PublicAllocationChanged.selector);
        // A release that does not hold the token.
        vm.expectRevert();
        new GenesisHolderClaim(address(0xDEAD), address(sale), TOKEN_ID, 0, 0, START, 1 days, WINDOW, PRICE, ADMIN, vm.addr(SIGNER_KEY));
        // Another chain id.
        vm.chainId(1);
        _expectDeployRevert(START, 1 days, WINDOW, PRICE, 0, 0, address(release), GenesisHolderClaim.InvalidConfiguration.selector);
        vm.chainId(43114);

        // On the deployed claim: vouchers for another chain, token, release or allocation are refused.
        vm.warp(START);
        GenesisHolderClaim.ClaimVoucher memory v = _voucher(CLAIMANT, 7, block.timestamp + 300);
        v.destinationChainId = 43113;
        _expectClaimRevert(CLAIMANT, v, SIGNER_KEY, GenesisHolderClaim.InvalidVoucher.selector);
        v = _voucher(CLAIMANT, 8, block.timestamp + 300);
        v.tokenId = 2;
        _expectClaimRevert(CLAIMANT, v, SIGNER_KEY, GenesisHolderClaim.InvalidVoucher.selector);
        v = _voucher(CLAIMANT, 9, block.timestamp + 300);
        v.releaseContract = address(sale);
        _expectClaimRevert(CLAIMANT, v, SIGNER_KEY, GenesisHolderClaim.InvalidVoucher.selector);
        v = _voucher(CLAIMANT, 10, block.timestamp + 300);
        v.allocation = 1;
        _expectClaimRevert(CLAIMANT, v, SIGNER_KEY, GenesisHolderClaim.InvalidVoucher.selector);
        // The deployed claim refuses to run on another chain id.
        vm.chainId(43113);
        _expectClaimRevert(CLAIMANT, _voucher(CLAIMANT, 11, block.timestamp + 300), SIGNER_KEY, GenesisHolderClaim.WrongDestinationChain.selector);
        vm.chainId(43114);
        // A sale reconfigured to another price or end after deployment halts claims.
        _configureSale(0.3 ether, 0, START, END);
        _expectClaimRevert(CLAIMANT, _voucher(CLAIMANT, 12, block.timestamp + 300), SIGNER_KEY, GenesisHolderClaim.PublicPriceChanged.selector);
        _configureSale(PRICE, 0, START, END + 1 hours);
        _expectClaimRevert(CLAIMANT, _voucher(CLAIMANT, 13, block.timestamp + 300), SIGNER_KEY, GenesisHolderClaim.PublicSaleSchedule.selector);
        require(claimContract.claimedSupply() == 0, "nothing claimed");
    }

    // ---- the production public-window policy -------------------------------------------------

    function testProductionPublicWindowPolicy() public {
        // Accepted: the 7-day minimum, the Halloween window and the 14-day maximum (each with a matching sale).
        uint256[3] memory accepted = [uint256(7 days), WINDOW, 14 days];
        for (uint256 i = 0; i < accepted.length; i++) {
            _configureSale(PRICE, 0, START, START + accepted[i] - 1);
            GenesisHolderClaim c = _deploy(START, 1 days, accepted[i], PRICE, 0, 0, address(release));
            require(c.publicSaleEnd() == START + accepted[i] - 1 && c.claimEnd() < c.publicSaleEnd(), "accepted window");
        }
        // Refused: shorter than 7 days, longer than 14 days, far too long, or not whole hours (one second off).
        uint256[6] memory refused = [uint256(7 days - 1 hours), 14 days + 1 hours, 365 days, WINDOW - 1, WINDOW + 1, 7 days + 30 minutes];
        for (uint256 i = 0; i < refused.length; i++) {
            _configureSale(PRICE, 0, START, START + refused[i] - 1);
            _expectDeployRevert(START, 1 days, refused[i], PRICE, 0, 0, address(release), GenesisHolderClaim.InvalidConfiguration.selector);
        }
        // The claim window stays exactly 24 hours.
        _configureSale(PRICE, 0, START, END);
        _expectDeployRevert(START, 23 hours, WINDOW, PRICE, 0, 0, address(release), GenesisHolderClaim.InvalidConfiguration.selector);
        _expectDeployRevert(START, 25 hours, WINDOW, PRICE, 0, 0, address(release), GenesisHolderClaim.InvalidConfiguration.selector);
        // A start in the past is refused.
        _expectDeployRevert(block.timestamp - 1, 1 days, WINDOW, PRICE, 0, 0, address(release), GenesisHolderClaim.InvalidConfiguration.selector);
    }

    function testClaimWindowMustCloseBeforeThePaidSaleEnds() public {
        // On Fuji the windows are free but the claim must still close before the sale ends.
        vm.chainId(43113);
        _configureSale(0.01 ether, 0, START, START + 10 minutes - 1);
        _expectDeployRevert(START, 10 minutes, 10 minutes, 0.01 ether, 0, 0, address(release), GenesisHolderClaim.InvalidConfiguration.selector);
        _expectDeployRevert(START, 11 minutes, 10 minutes, 0.01 ether, 0, 0, address(release), GenesisHolderClaim.InvalidConfiguration.selector);
        GenesisHolderClaim c = _deploy(START, 5 minutes, 10 minutes, 0.01 ether, 0, 0, address(release));
        require(c.claimEnd() < c.publicSaleEnd(), "claim closes first");
    }

    // ---- per-wallet limit and accounting -----------------------------------------------------

    function testPaidLimitIsThreePerWalletAndIndependentOfTheFreeClaim() public {
        vm.warp(START + 1 hours);
        // Claim first, then buy the full paid limit.
        _claim(CLAIMANT, 14);
        vm.deal(CLAIMANT, PRICE * 4);
        vm.prank(CLAIMANT);
        sale.purchase{value: PRICE * 3}(TOKEN_ID, 3);
        require(sale.walletPurchased(TOKEN_ID, CLAIMANT) == 3 && release.balanceOf(CLAIMANT, TOKEN_ID) == 4, "1 free + 3 paid");
        vm.expectPartialRevert(VoidPrimarySaleSettled.WalletLimitExceeded.selector);
        vm.prank(CLAIMANT);
        sale.purchase{value: PRICE}(TOKEN_ID, 1);
        // Buy the full paid limit first, then claim.
        vm.deal(CLAIMANT_TWO, PRICE * 4);
        vm.prank(CLAIMANT_TWO);
        sale.purchase{value: PRICE * 2}(TOKEN_ID, 2);
        vm.prank(CLAIMANT_TWO);
        sale.purchase{value: PRICE}(TOKEN_ID, 1);
        _claim(CLAIMANT_TWO, 15);
        require(sale.walletPurchased(TOKEN_ID, CLAIMANT_TWO) == 3 && release.balanceOf(CLAIMANT_TWO, TOKEN_ID) == 4, "3 paid + 1 free");
        // The limit also holds after the claim window, and still counts only paid copies.
        vm.warp(CLAIM_END + 1 hours);
        vm.expectPartialRevert(VoidPrimarySaleSettled.WalletLimitExceeded.selector);
        vm.prank(CLAIMANT_TWO);
        sale.purchase{value: PRICE}(TOKEN_ID, 1);
        _assertAccounting(2, 6);
    }

    function testSettlementAndSupplyAccountingAcrossBothPaths() public {
        vm.warp(START);
        uint256 nanoBefore = NANO.balance;
        _claim(CLAIMANT, 16);
        vm.deal(BUYER, PRICE * 3);
        vm.prank(BUYER);
        sale.purchase{value: PRICE * 3}(TOKEN_ID, 3);
        uint256 platformCut = (PRICE * 3 * 250) / 10_000;
        require(NANO.balance - nanoBefore == platformCut, "2.5% pushed during the purchase");
        require(sale.balances(ARTIST) == PRICE * 3 - platformCut, "97.5% to the artist");
        _assertAccounting(1, 3);
        // A mint outside the sale and the claim breaks sold + claimed and halts claims.
        bytes32 issuerRole = release.ISSUER_ROLE();
        vm.prank(ARTIST);
        release.grantRole(issuerRole, ARTIST);
        vm.prank(ARTIST);
        release.mint(ARTIST, TOKEN_ID, 1, "");
        _expectClaimRevert(CLAIMANT_TWO, _voucher(CLAIMANT_TWO, 17, block.timestamp + 300), SIGNER_KEY, GenesisHolderClaim.SupplyAccountingMismatch.selector);
    }

    // ---- existing protections ----------------------------------------------------------------

    function testReplayExpiryPauseAndRoleSeparationRemainIntact() public {
        vm.warp(START);
        GenesisHolderClaim.ClaimVoucher memory v = _voucher(CLAIMANT, 18, block.timestamp + 300);
        bytes memory signature = _sign(SIGNER_KEY, v);
        vm.expectPartialRevert(GenesisHolderClaim.InvalidVoucher.selector);
        vm.prank(BUYER);
        claimContract.claim(v, signature);
        vm.prank(CLAIMANT);
        claimContract.claim(v, signature);
        vm.expectPartialRevert(GenesisHolderClaim.AlreadyClaimed.selector);
        vm.prank(CLAIMANT);
        claimContract.claim(v, signature);
        _expectClaimRevert(BUYER, _voucher(BUYER, 18, block.timestamp + 300), SIGNER_KEY, GenesisHolderClaim.Replay.selector);
        _expectClaimRevert(BUYER, _voucher(BUYER, 19, block.timestamp - 1), SIGNER_KEY, GenesisHolderClaim.ExpiredVoucher.selector);
        _expectClaimRevert(BUYER, _voucher(BUYER, 20, block.timestamp + 300), OTHER_KEY, GenesisHolderClaim.InvalidSignature.selector);
        // Only the admin pauses or rotates the signer; the artist and the signer cannot.
        vm.expectPartialRevert(GenesisHolderClaim.Unauthorized.selector);
        vm.prank(ARTIST);
        claimContract.pause();
        address signer = vm.addr(SIGNER_KEY);
        vm.expectPartialRevert(GenesisHolderClaim.Unauthorized.selector);
        vm.prank(signer);
        claimContract.setSigner(vm.addr(OTHER_KEY));
        vm.prank(ADMIN);
        claimContract.pause();
        _expectClaimRevert(BUYER, _voucher(BUYER, 21, block.timestamp + 300), SIGNER_KEY, GenesisHolderClaim.Paused.selector);
        vm.prank(ADMIN);
        claimContract.unpause();
        // After rotation only the new signer's vouchers are valid.
        vm.prank(ADMIN);
        claimContract.setSigner(vm.addr(OTHER_KEY));
        _expectClaimRevert(BUYER, _voucher(BUYER, 22, block.timestamp + 300), SIGNER_KEY, GenesisHolderClaim.InvalidSignature.selector);
        GenesisHolderClaim.ClaimVoucher memory rotated = _voucher(BUYER, 22, block.timestamp + 300);
        bytes memory rotatedSig = _sign(OTHER_KEY, rotated);
        vm.prank(BUYER);
        claimContract.claim(rotated, rotatedSig);
        // The release did not give the artist the issuer role, and the claim holds only ISSUER_ROLE.
        require(!release.hasRole(release.ISSUER_ROLE(), ARTIST), "artist issuer role");
        require(!release.hasRole(release.DEFAULT_ADMIN_ROLE(), address(claimContract)), "claim is not a release admin");
        _assertAccounting(2, 0);
    }

    function testAnEditionMintEndBeforeHalloweenWouldStopLatePurchases() public {
        // The live token 1 has no mint end. An edition created with the old 7-day mint end would refuse the
        // Halloween tail of the sale even though the sale is configured through END.
        vm.prank(ARTIST);
        uint256 capped = release.createEditionWithMintEnd(releaseKey, bytes32(uint256(2)), 0, "ipfs://fnf-2", ARTIST, 250, uint64(START + 7 days - 1));
        _configureSaleFor(capped, PRICE, 0, START, END);
        vm.deal(BUYER, PRICE);
        vm.warp(START + 7 days);
        vm.expectPartialRevert(VoidCollection1155.MintingEnded.selector);
        vm.prank(BUYER);
        sale.purchase{value: PRICE}(capped, 1);
    }

    // ---- helpers -----------------------------------------------------------------------------

    function _configureSale(uint256 price, uint256 cap, uint256 start, uint256 end) internal {
        _configureSaleFor(TOKEN_ID, price, cap, start, end);
    }

    function _configureSaleFor(uint256 id, uint256 price, uint256 cap, uint256 start, uint256 end) internal {
        vm.prank(ARTIST);
        sale.configureSale(id, price, cap, PER_WALLET, uint64(start), uint64(end), false);
    }

    function _deploy(uint256 start, uint256 claimWindow, uint256 publicWindow, uint256 price, uint256 allocation, uint256 publicAllocation, address releaseAddress)
        internal
        returns (GenesisHolderClaim)
    {
        return new GenesisHolderClaim(releaseAddress, address(sale), TOKEN_ID, allocation, publicAllocation, start, claimWindow, publicWindow, price, ADMIN, vm.addr(SIGNER_KEY));
    }

    function _expectDeployRevert(
        uint256 start,
        uint256 claimWindow,
        uint256 publicWindow,
        uint256 price,
        uint256 allocation,
        uint256 publicAllocation,
        address releaseAddress,
        bytes4 selector
    ) internal {
        vm.expectPartialRevert(selector);
        _deploy(start, claimWindow, publicWindow, price, allocation, publicAllocation, releaseAddress);
    }

    function _assertAccounting(uint256 claimed, uint256 sold) internal view {
        (,, uint256 saleSold,,,,,) = sale.sales(TOKEN_ID);
        require(saleSold == sold && claimContract.claimedSupply() == claimed, "counters");
        require(release.edition(TOKEN_ID).mintedSupply == saleSold + claimContract.claimedSupply(), "mintedSupply != sold + claimed");
    }

    function _claim(address claimant, uint256 nonce) internal {
        GenesisHolderClaim.ClaimVoucher memory v = _voucher(claimant, nonce, block.timestamp + 300);
        bytes memory signature = _sign(SIGNER_KEY, v);
        vm.prank(claimant);
        claimContract.claim(v, signature);
    }

    function _expectClaimRevert(address caller, GenesisHolderClaim.ClaimVoucher memory v, uint256 key, bytes4 selector) internal {
        bytes memory signature = _sign(key, v);
        vm.expectPartialRevert(selector);
        vm.prank(caller);
        claimContract.claim(v, signature);
    }

    function _voucher(address claimant, uint256 nonce, uint256 deadline) internal view returns (GenesisHolderClaim.ClaimVoucher memory) {
        return GenesisHolderClaim.ClaimVoucher({
            claimant: claimant,
            genesisContract: claimContract.GENESIS_CONTRACT(),
            genesisChainId: claimContract.GENESIS_CHAIN_ID(),
            eligibilityRule: claimContract.ELIGIBILITY_RULE(),
            destinationChainId: 43114,
            releaseContract: address(release),
            tokenId: TOKEN_ID,
            quantity: 1,
            allocation: 0,
            nonce: nonce,
            deadline: deadline
        });
    }

    function _sign(uint256 key, GenesisHolderClaim.ClaimVoucher memory v) internal returns (bytes memory) {
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(key, claimContract.voucherDigest(v));
        return abi.encodePacked(r, s, sv);
    }
}
