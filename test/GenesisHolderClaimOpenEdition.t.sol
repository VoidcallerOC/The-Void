// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GenesisHolderClaim} from "../contracts/GenesisHolderClaim.sol";
import {VoidReleaseFactory} from "../contracts/VoidReleaseFactory.sol";
import {VoidRelease1155V4} from "../contracts/VoidRelease1155V4.sol";
import {VoidCollection1155} from "../contracts/VoidCollection1155.sol";
import {VoidPrimarySale} from "../contracts/VoidPrimarySale.sol";

interface VmClaimOpen {
    function chainId(uint256) external;
    function warp(uint256) external;
    function deal(address, uint256) external;
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function prank(address) external;
    function expectPartialRevert(bytes4) external;
}

/// @notice The Forgive & Forget schedule on an uncapped open edition: free Genesis claims for
/// exactly 24 hours, then an ungated public mint at 0.25 AVAX for exactly 7 days, then closed.
contract GenesisHolderClaimOpenEditionTest {
    VmClaimOpen internal constant vm = VmClaimOpen(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 internal constant SIGNER_KEY = 0xA11CE;
    uint256 internal constant OTHER_KEY = 0xB0B;
    address internal constant ARTIST = address(0xA7157);
    address internal constant ADMIN = address(0xAD01);
    address internal constant CLAIMANT = address(0xCA11);
    address internal constant CLAIMANT_TWO = address(0xCA12);
    address internal constant COLLECTOR = address(0xC011);
    address internal constant PLATFORM = address(0xFEE);
    address internal constant SAFE = address(0x5AFE);
    bytes32 internal constant RELEASE_KEY = keccak256("open-claim-release");
    bytes32 internal constant EDITION_ID = keccak256("open-claim-edition");
    bytes32 internal constant RULE = keccak256(
        "the-void:genesis-eligibility:v3:live-balanceOf(wallet,0..3)-minus-units-used-by-earlier-claims>0;used-units-follow-transfers"
    );
    uint256 internal constant PRICE = 0.25 ether;
    uint256 internal constant T0 = 1_800_000_000;
    uint256 internal constant CLAIM_START = T0 + 1 hours;
    uint256 internal constant CLAIM_END = CLAIM_START + 1 days;
    uint256 internal constant PUBLIC_END = CLAIM_END + 7 days - 1;

    VoidRelease1155V4 internal release;
    VoidPrimarySale internal sale;
    GenesisHolderClaim internal claimContract;
    uint256 internal tokenId;
    address internal signer;

    function setUp() public {
        vm.chainId(43113);
        vm.warp(T0);
        signer = vm.addr(SIGNER_KEY);
        VoidReleaseFactory factory = new VoidReleaseFactory(PLATFORM, 500, SAFE);
        (address releaseAddress, address saleAddress,) =
            factory.createRelease(ARTIST, RELEASE_KEY, "Open claim release", "OCR", "ipfs://open-claim");
        release = VoidRelease1155V4(releaseAddress);
        sale = VoidPrimarySale(payable(saleAddress));
        // maxSupply 0 is an open edition; the token's own mint deadline is the end of the public window.
        vm.prank(ARTIST);
        tokenId = release.createEditionWithMintEnd(
            RELEASE_KEY, EDITION_ID, 0, "ipfs://open-edition", ARTIST, 0, uint64(PUBLIC_END)
        );
        // Sale cap 0 and per-wallet limit 0: no cap on an open edition.
        vm.prank(ARTIST);
        sale.configureSale(tokenId, PRICE, 0, 0, uint64(CLAIM_END), uint64(PUBLIC_END), false);
        claimContract = _deploy(CLAIM_START);
        bytes32 issuerRole = release.ISSUER_ROLE();
        vm.prank(ARTIST);
        release.grantRole(issuerRole, address(claimContract));
    }

    // ---- open edition semantics ----

    function testOpenEditionHasNoSupplyCapAndClaimHasNoAllocationCap() public {
        require(release.maxSupplyOf(tokenId) == 0, "edition is not open");
        require(claimContract.allocation() == 0 && claimContract.publicAllocation() == 0, "allocation invented");
        (, uint256 saleCap,, uint256 walletLimit,,,,) = sale.sales(tokenId);
        require(saleCap == 0 && walletLimit == 0, "sale cap invented");
        vm.warp(CLAIM_START);
        for (uint256 i = 0; i < 25; i++) {
            address wallet = address(uint160(0x10000 + i));
            _claim(wallet, 1000 + i);
        }
        require(claimContract.claimedSupply() == 25, "claims not counted");
        vm.warp(CLAIM_END);
        vm.deal(COLLECTOR, PRICE * 500);
        vm.prank(COLLECTOR);
        sale.purchase{value: PRICE * 500}(tokenId, 500);
        require(release.edition(tokenId).mintedSupply == 525, "open edition capped");
    }

    function testUncappedAllocationIsRejectedForACappedEdition() public {
        bytes32 cappedId = keccak256("capped-edition");
        vm.prank(ARTIST);
        uint256 capped = release.createEdition(RELEASE_KEY, cappedId, 10, "ipfs://capped", ARTIST, 0);
        vm.prank(ARTIST);
        sale.configureSale(capped, PRICE, 10, 10, uint64(CLAIM_END), uint64(PUBLIC_END), false);
        vm.expectPartialRevert(GenesisHolderClaim.InvalidConfiguration.selector);
        new GenesisHolderClaim(address(release), address(sale), capped, 0, 10, CLAIM_START, 1 days, 7 days, PRICE, ADMIN, signer);
    }

    // ---- Genesis phase: free, exactly 24 hours ----

    function testClaimRejectedBeforeTheClaimWindowOpens() public {
        vm.warp(CLAIM_START - 1);
        _expectClaimRevert(CLAIMANT, _voucher(CLAIMANT, 1, 1), GenesisHolderClaim.ClaimNotOpen.selector);
    }

    function testClaimIsFreeFromTheFirstToTheLastSecondOfTheWindow() public {
        vm.warp(CLAIM_START);
        uint256 balanceBefore = CLAIMANT.balance;
        _claim(CLAIMANT, 2);
        require(CLAIMANT.balance == balanceBefore, "claim charged the claimant");
        vm.warp(CLAIM_END - 1);
        _claim(CLAIMANT_TWO, 3);
        require(release.balanceOf(CLAIMANT, tokenId) == 1 && release.balanceOf(CLAIMANT_TWO, tokenId) == 1, "claims missing");
        require(address(claimContract).balance == 0 && address(sale).balance == 0, "claim moved funds");
    }

    function testClaimRejectedAtAndAfterTheWindowCloses() public {
        vm.warp(CLAIM_END);
        _expectClaimRevert(CLAIMANT, _voucher(CLAIMANT, 4, 1), GenesisHolderClaim.ClaimWindowClosed.selector);
        vm.warp(CLAIM_END + 1);
        _expectClaimRevert(CLAIMANT, _voucher(CLAIMANT, 5, 1), GenesisHolderClaim.ClaimWindowClosed.selector);
    }

    function testWalletAndNonceProtectionsRemain() public {
        vm.warp(CLAIM_START);
        _claim(CLAIMANT, 6);
        _expectClaimRevert(CLAIMANT, _voucher(CLAIMANT, 7, 1), GenesisHolderClaim.AlreadyClaimed.selector);
        _expectClaimRevert(CLAIMANT_TWO, _voucher(CLAIMANT_TWO, 6, 1), GenesisHolderClaim.Replay.selector);
    }

    /// The same signed voucher submitted twice, and the claimant's voucher used from another wallet, are
    /// refused; after the free-claim window nobody gets a free mint, while the public mint is open to all.
    function testNoSecondFreeMintAndPublicMintAfterTheWindow() public {
        vm.warp(CLAIM_START);
        GenesisHolderClaim.ClaimVoucher memory voucher = _voucher(CLAIMANT, 31, 1);
        bytes memory signature = _sign(voucher);
        vm.prank(CLAIMANT);
        claimContract.claim(voucher, signature);
        vm.expectPartialRevert(GenesisHolderClaim.AlreadyClaimed.selector);
        vm.prank(CLAIMANT);
        claimContract.claim(voucher, signature);
        vm.expectPartialRevert(GenesisHolderClaim.InvalidVoucher.selector);
        vm.prank(CLAIMANT_TWO);
        claimContract.claim(voucher, signature);

        vm.warp(CLAIM_END);
        _expectClaimRevert(CLAIMANT, _voucher(CLAIMANT, 32, 1), GenesisHolderClaim.ClaimWindowClosed.selector);
        _expectClaimRevert(CLAIMANT_TWO, _voucher(CLAIMANT_TWO, 33, 1), GenesisHolderClaim.ClaimWindowClosed.selector);
        vm.deal(CLAIMANT, PRICE);
        vm.prank(CLAIMANT);
        sale.purchase{value: PRICE}(tokenId, 1);
        vm.deal(COLLECTOR, PRICE * 3);
        vm.prank(COLLECTOR);
        sale.purchase{value: PRICE * 3}(tokenId, 3);
        require(release.balanceOf(CLAIMANT, tokenId) == 2, "claimant: one free + one bought");
        require(release.balanceOf(COLLECTOR, tokenId) == 3, "public mint is ungated and uncapped");
        require(claimContract.claimedSupply() == 1, "only one free mint");
    }

    function testInvalidSignerStillFails() public {
        vm.warp(CLAIM_START);
        GenesisHolderClaim.ClaimVoucher memory voucher = _voucher(CLAIMANT, 8, 1);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OTHER_KEY, claimContract.voucherDigest(voucher));
        vm.expectPartialRevert(GenesisHolderClaim.InvalidSignature.selector);
        vm.prank(CLAIMANT);
        claimContract.claim(voucher, abi.encodePacked(r, s, v));
    }

    // ---- public phase: ungated, 0.25 AVAX, exactly 7 days ----

    function testPublicMintBlockedUntilTheGenesisWindowEnds() public {
        vm.deal(COLLECTOR, PRICE);
        vm.warp(CLAIM_END - 1);
        vm.expectPartialRevert(VoidPrimarySale.SaleNotStarted.selector);
        vm.prank(COLLECTOR);
        sale.purchase{value: PRICE}(tokenId, 1);
    }

    function testPublicMintIsUngatedAtExactlyQuarterAvaxFromTheFirstSecond() public {
        vm.warp(CLAIM_END);
        vm.deal(COLLECTOR, PRICE);
        vm.prank(COLLECTOR);
        sale.purchase{value: PRICE}(tokenId, 1);
        require(release.balanceOf(COLLECTOR, tokenId) == 1, "public mint missing");
        uint256 platformCut = (PRICE * sale.platformFeeBps()) / 10_000;
        require(sale.balances(PLATFORM) == platformCut, "platform share");
        require(sale.balances(ARTIST) == PRICE - platformCut, "artist share");
        require(address(sale).balance == PRICE, "payment not held for withdrawal");
    }

    function testWrongPaymentIsRejectedWithoutMintingOrKeepingFunds() public {
        vm.warp(CLAIM_END);
        vm.deal(COLLECTOR, 1 ether);
        uint256[2] memory wrong = [PRICE - 1, PRICE + 1];
        for (uint256 i = 0; i < wrong.length; i++) {
            vm.expectPartialRevert(VoidPrimarySale.WrongPayment.selector);
            vm.prank(COLLECTOR);
            sale.purchase{value: wrong[i]}(tokenId, 1);
        }
        vm.expectPartialRevert(VoidPrimarySale.WrongPayment.selector);
        vm.prank(COLLECTOR);
        sale.purchase{value: 0}(tokenId, 1);
        require(COLLECTOR.balance == 1 ether, "funds trapped");
        require(address(sale).balance == 0 && release.edition(tokenId).mintedSupply == 0, "minted on wrong payment");
    }

    function testPublicMintOpenOnItsLastSecondAndClosedAfterSevenDays() public {
        vm.deal(COLLECTOR, PRICE * 2);
        vm.warp(PUBLIC_END);
        vm.prank(COLLECTOR);
        sale.purchase{value: PRICE}(tokenId, 1);
        vm.warp(PUBLIC_END + 1);
        require(PUBLIC_END + 1 - CLAIM_END == 7 days, "public window is not exactly 7 days");
        vm.expectPartialRevert(VoidPrimarySale.SaleEnded.selector);
        vm.prank(COLLECTOR);
        sale.purchase{value: PRICE}(tokenId, 1);
    }

    function testNoMintPathRemainsAfterClosure() public {
        vm.warp(PUBLIC_END + 1);
        _expectClaimRevert(CLAIMANT, _voucher(CLAIMANT, 9, 1), GenesisHolderClaim.ClaimWindowClosed.selector);
        vm.deal(COLLECTOR, PRICE);
        vm.expectPartialRevert(VoidPrimarySale.SaleEnded.selector);
        vm.prank(COLLECTOR);
        sale.purchase{value: PRICE}(tokenId, 1);
        // Even an issuer calling the release directly is refused by the token's own mint deadline.
        vm.expectPartialRevert(VoidCollection1155.MintingEnded.selector);
        vm.prank(address(sale));
        release.mint(COLLECTOR, tokenId, 1, "");
    }

    // ---- the claim fails closed if the public schedule drifts ----

    function testScheduleOrPriceDriftDuringClaimsFailsClosed() public {
        vm.warp(CLAIM_START);
        vm.prank(ARTIST);
        sale.configureSale(tokenId, PRICE - 1, 0, 0, uint64(CLAIM_END), uint64(PUBLIC_END), false);
        _expectClaimRevert(CLAIMANT, _voucher(CLAIMANT, 10, 1), GenesisHolderClaim.PublicPriceChanged.selector);
        vm.prank(ARTIST);
        sale.configureSale(tokenId, PRICE, 0, 0, uint64(CLAIM_END - 1), uint64(PUBLIC_END), false);
        _expectClaimRevert(CLAIMANT, _voucher(CLAIMANT, 11, 1), GenesisHolderClaim.PublicSaleSchedule.selector);
        vm.prank(ARTIST);
        sale.configureSale(tokenId, PRICE, 0, 0, uint64(CLAIM_END), uint64(PUBLIC_END + 1 days), false);
        _expectClaimRevert(CLAIMANT, _voucher(CLAIMANT, 12, 1), GenesisHolderClaim.PublicSaleSchedule.selector);
        vm.prank(ARTIST);
        sale.configureSale(tokenId, PRICE, 0, 0, uint64(CLAIM_END), uint64(PUBLIC_END), false);
        _claim(CLAIMANT, 13);
    }

    function testDeploymentRequiresTheExactScheduleAndAFutureStart() public {
        vm.expectPartialRevert(GenesisHolderClaim.InvalidConfiguration.selector);
        _deploy(T0 - 1);
        vm.expectPartialRevert(GenesisHolderClaim.PublicSaleSchedule.selector);
        _deploy(CLAIM_START + 1);
        vm.expectPartialRevert(GenesisHolderClaim.InvalidConfiguration.selector);
        new GenesisHolderClaim(address(release), address(sale), tokenId, 0, 0, CLAIM_START, 1 days, 7 days, 0, ADMIN, signer);
    }

    function testMixedClaimAndPublicSaleAccountingRemainsExact() public {
        vm.warp(CLAIM_START);
        _claim(CLAIMANT, 14);
        vm.warp(CLAIM_END);
        vm.deal(CLAIMANT_TWO, PRICE * 3);
        vm.prank(CLAIMANT_TWO);
        sale.purchase{value: PRICE * 3}(tokenId, 3);
        (,, uint256 sold,,,,,) = sale.sales(tokenId);
        require(release.edition(tokenId).mintedSupply == claimContract.claimedSupply() + sold, "mixed accounting mismatch");
    }

    /// Live ownership lets eligibility follow a transferred Genesis token to new wallets. A finite claim
    /// allocation, an existing parameter, bounds total free claims on an open edition without capping the sale.
    function testFiniteClaimAllocationBoundsFreeClaimsOnAnOpenEdition() public {
        claimContract = new GenesisHolderClaim(address(release), address(sale), tokenId, 2, 0, CLAIM_START, 1 days, 7 days, PRICE, ADMIN, signer);
        bytes32 issuerRole = release.ISSUER_ROLE();
        vm.prank(ARTIST);
        release.grantRole(issuerRole, address(claimContract));
        vm.warp(CLAIM_START);
        _claim(CLAIMANT, 21);
        _claim(CLAIMANT_TWO, 22);
        _expectClaimRevert(address(0xCA13), _voucher(address(0xCA13), 23, 1), GenesisHolderClaim.AllocationExhausted.selector);
        require(claimContract.claimedSupply() == 2, "claim cap not applied");
        vm.warp(CLAIM_END);
        vm.deal(CLAIMANT, PRICE * 50);
        vm.prank(CLAIMANT);
        sale.purchase{value: PRICE * 50}(tokenId, 50);
        (,, uint256 sold,,,,,) = sale.sales(tokenId);
        require(sold == 50, "public sale should stay uncapped");
    }

    function _deploy(uint256 claimStart) internal returns (GenesisHolderClaim) {
        return new GenesisHolderClaim(address(release), address(sale), tokenId, 0, 0, claimStart, 1 days, 7 days, PRICE, ADMIN, signer);
    }

    function _claim(address claimant, uint256 nonce) internal {
        GenesisHolderClaim.ClaimVoucher memory voucher = _voucher(claimant, nonce, 1);
        bytes memory signature = _sign(voucher);
        vm.prank(claimant);
        claimContract.claim(voucher, signature);
    }

    function _expectClaimRevert(address caller, GenesisHolderClaim.ClaimVoucher memory voucher, bytes4 selector) internal {
        bytes memory signature = _sign(voucher);
        vm.expectPartialRevert(selector);
        vm.prank(caller);
        claimContract.claim(voucher, signature);
    }

    function _voucher(address claimant, uint256 nonce, uint256 quantity)
        internal
        view
        returns (GenesisHolderClaim.ClaimVoucher memory)
    {
        return GenesisHolderClaim.ClaimVoucher({
            claimant: claimant,
            genesisContract: claimContract.GENESIS_CONTRACT(),
            genesisChainId: claimContract.GENESIS_CHAIN_ID(),
            eligibilityRule: claimContract.ELIGIBILITY_RULE(),
            destinationChainId: 43113,
            releaseContract: address(release),
            tokenId: tokenId,
            quantity: quantity,
            allocation: claimContract.allocation(),
            nonce: nonce,
            deadline: block.timestamp + 300
        });
    }

    function _sign(GenesisHolderClaim.ClaimVoucher memory voucher) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, claimContract.voucherDigest(voucher));
        return abi.encodePacked(r, s, v);
    }
}
