// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GenesisHolderClaim} from "../contracts/GenesisHolderClaim.sol";
import {VoidReleaseFactory} from "../contracts/VoidReleaseFactory.sol";
import {VoidRelease1155V4} from "../contracts/VoidRelease1155V4.sol";
import {VoidPrimarySale} from "../contracts/VoidPrimarySale.sol";
import {installGenesisStandIn} from "./helpers/MockGenesisCollection.sol";

interface VmSchedule {
    function chainId(uint256) external;
    function warp(uint256) external;
    function deal(address, uint256) external;
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function prank(address) external;
    function expectPartialRevert(bytes4) external;
}

/// @notice Environment separation: Fuji may run an accelerated schedule (here 5-minute claims, then a
/// 10-minute public sale at 0.01 AVAX); C-Chain accepts only the production 24 hours and 7 days.
contract GenesisHolderClaimScheduleTest {
    VmSchedule internal constant vm = VmSchedule(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 internal constant SIGNER_KEY = 0xA11CE;
    address internal constant ARTIST = address(0xA7157);
    address internal constant ADMIN = address(0xAD01);
    address internal constant CLAIMANT = address(0xCA11);
    address internal constant COLLECTOR = address(0xC011);
    bytes32 internal constant RULE = keccak256(
        "the-void:genesis-eligibility:v3:live-balanceOf(wallet,0..3)-minus-units-used-by-earlier-claims>0;used-units-follow-transfers"
    );
    uint256 internal constant T0 = 1_800_000_000;
    uint256 internal constant START = T0 + 10 minutes;

    VoidRelease1155V4 internal release;
    VoidPrimarySale internal sale;
    uint256 internal tokenId;
    address internal signer;

    function _setUpChain(uint256 chainId) internal {
        vm.chainId(chainId);
        vm.warp(T0);
        signer = vm.addr(SIGNER_KEY);
        VoidReleaseFactory factory = new VoidReleaseFactory(address(0xFEE), 500, address(0x5AFE));
        (address releaseAddress, address saleAddress,) =
            factory.createRelease(ARTIST, keccak256("schedule-release"), "Schedule", "SCH", "ipfs://schedule");
        release = VoidRelease1155V4(releaseAddress);
        sale = VoidPrimarySale(payable(saleAddress));
        vm.prank(ARTIST);
        tokenId = release.createEdition(keccak256("schedule-release"), keccak256("schedule-edition"), 0, "ipfs://e", ARTIST, 0);
    }

    function _configure(uint256 price, uint256 claimWindow, uint256 publicWindow) internal {
        vm.prank(ARTIST);
        // The sale opens with the claims at START and lasts publicWindow; claimWindow only bounds the free claims.
        claimWindow;
        sale.configureSale(tokenId, price, 0, 0, uint64(START), uint64(START + publicWindow - 1), false);
    }

    function _deploy(uint256 price, uint256 claimWindow, uint256 publicWindow) internal returns (GenesisHolderClaim claim) {
        claim = new GenesisHolderClaim(address(release), address(sale), tokenId, 0, 0, START, claimWindow, publicWindow, price, ADMIN, signer);
        bytes32 issuerRole = release.ISSUER_ROLE();
        vm.prank(ARTIST);
        release.grantRole(issuerRole, address(claim));
    }

    function _signed(GenesisHolderClaim claim, uint256 nonce)
        internal
        returns (GenesisHolderClaim.ClaimVoucher memory voucher, bytes memory signature)
    {
        voucher = GenesisHolderClaim.ClaimVoucher({
            claimant: CLAIMANT, genesisContract: claim.GENESIS_CONTRACT(), genesisChainId: 43114, eligibilityRule: claim.ELIGIBILITY_RULE(),
            destinationChainId: block.chainid, releaseContract: address(release), tokenId: tokenId, quantity: 1, allocation: 0,
            nonce: nonce, deadline: block.timestamp + 60
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, claim.voucherDigest(voucher));
        signature = abi.encodePacked(r, s, v);
    }

    function _claim(GenesisHolderClaim claim, uint256 nonce) internal {
        (GenesisHolderClaim.ClaimVoucher memory voucher, bytes memory signature) = _signed(claim, nonce);
        vm.prank(CLAIMANT);
        claim.claim(voucher, signature);
    }

    function testFujiAcceleratedFiveMinuteClaimInsideATenMinutePublicSaleAtOneCent() public {
        _setUpChain(43113);
        uint256 price = 0.01 ether;
        _configure(price, 5 minutes, 10 minutes);
        GenesisHolderClaim claim = _deploy(price, 5 minutes, 10 minutes);
        require(claim.publicSaleStart() == START && claim.claimEnd() == START + 5 minutes && claim.publicSaleEnd() == START + 10 minutes - 1, "schedule");
        vm.deal(COLLECTOR, 1 ether);
        // Before the shared start neither path is open.
        vm.warp(START - 1);
        vm.expectPartialRevert(VoidPrimarySale.SaleNotStarted.selector);
        vm.prank(COLLECTOR);
        sale.purchase{value: price}(tokenId, 1);
        // Inside the claim window both paths are open at the same timestamp.
        vm.warp(START + 5 minutes - 1);
        _claim(claim, 1);
        vm.prank(COLLECTOR);
        sale.purchase{value: price}(tokenId, 1);
        // At claimEnd the free claim closes while the paid mint continues.
        vm.warp(START + 5 minutes);
        (GenesisHolderClaim.ClaimVoucher memory late, bytes memory lateSignature) = _signed(claim, 2);
        vm.expectPartialRevert(GenesisHolderClaim.ClaimWindowClosed.selector);
        vm.prank(CLAIMANT);
        claim.claim(late, lateSignature);
        vm.prank(COLLECTOR);
        sale.purchase{value: price}(tokenId, 1);
        vm.expectPartialRevert(VoidPrimarySale.WrongPayment.selector);
        vm.prank(COLLECTOR);
        sale.purchase{value: 0.25 ether}(tokenId, 1);
        vm.warp(START + 10 minutes - 1);
        vm.prank(COLLECTOR);
        sale.purchase{value: price}(tokenId, 1);
        // At publicSaleEnd + 1 both paths are closed.
        vm.warp(START + 10 minutes);
        vm.expectPartialRevert(VoidPrimarySale.SaleEnded.selector);
        vm.prank(COLLECTOR);
        sale.purchase{value: price}(tokenId, 1);
        (GenesisHolderClaim.ClaimVoucher memory closed, bytes memory closedSignature) = _signed(claim, 3);
        vm.expectPartialRevert(GenesisHolderClaim.ClaimWindowClosed.selector);
        vm.prank(CLAIMANT);
        claim.claim(closed, closedSignature);
        require(release.balanceOf(COLLECTOR, tokenId) == 3 && release.balanceOf(CLAIMANT, tokenId) == 1, "balances");
        require(address(sale).balance == 3 * price, "funds");
    }

    function testRefusesAClaimWindowThatDoesNotCloseBeforeThePublicSale() public {
        _setUpChain(43113);
        _configure(0.01 ether, 10 minutes, 10 minutes);
        vm.expectPartialRevert(GenesisHolderClaim.InvalidConfiguration.selector);
        new GenesisHolderClaim(address(release), address(sale), tokenId, 0, 0, START, 10 minutes, 10 minutes, 0.01 ether, ADMIN, signer);
        vm.expectPartialRevert(GenesisHolderClaim.InvalidConfiguration.selector);
        new GenesisHolderClaim(address(release), address(sale), tokenId, 0, 0, START, 11 minutes, 10 minutes, 0.01 ether, ADMIN, signer);
    }

    function testFujiRefusesWindowsShorterThanOneMinute() public {
        _setUpChain(43113);
        _configure(0.01 ether, 59, 10 minutes);
        vm.expectPartialRevert(GenesisHolderClaim.InvalidConfiguration.selector);
        new GenesisHolderClaim(address(release), address(sale), tokenId, 0, 0, START, 59, 10 minutes, 0.01 ether, ADMIN, signer);
    }

    function testMainnetRefusesAcceleratedWindows() public {
        _setUpChain(43114);
        _configure(0.25 ether, 5 minutes, 10 minutes);
        vm.expectPartialRevert(GenesisHolderClaim.InvalidConfiguration.selector);
        new GenesisHolderClaim(address(release), address(sale), tokenId, 0, 0, START, 5 minutes, 10 minutes, 0.25 ether, ADMIN, signer);
        vm.expectPartialRevert(GenesisHolderClaim.InvalidConfiguration.selector);
        new GenesisHolderClaim(address(release), address(sale), tokenId, 0, 0, START, 1 days, 7 days + 1, 0.25 ether, ADMIN, signer);
    }

    function testMainnetRefusesAnyPriceOtherThanProduction() public {
        _setUpChain(43114);
        _configure(0.01 ether, 1 days, 7 days);
        vm.expectPartialRevert(GenesisHolderClaim.InvalidConfiguration.selector);
        new GenesisHolderClaim(address(release), address(sale), tokenId, 0, 0, START, 1 days, 7 days, 0.01 ether, ADMIN, signer);
        vm.expectPartialRevert(GenesisHolderClaim.InvalidConfiguration.selector);
        new GenesisHolderClaim(address(release), address(sale), tokenId, 0, 0, START, 1 days, 7 days, 0.25 ether + 1, ADMIN, signer);
    }

    function testMainnetAcceptsOnlyTheProductionSchedule() public {
        _setUpChain(43114);
        // GenesisHolderClaim reads Genesis balances on chain id 43114; this suite does not test eligibility.
        installGenesisStandIn(true);
        _configure(0.25 ether, 1 days, 7 days);
        GenesisHolderClaim claim = _deploy(0.25 ether, 1 days, 7 days);
        require(claim.claimWindow() == 1 days && claim.publicWindow() == 7 days, "windows");
        require(claim.publicPriceWei() == claim.PRODUCTION_PUBLIC_PRICE_WEI(), "price");
        require(claim.publicSaleStart() == START && claim.claimEnd() == START + 1 days, "claims open with the sale and close after 24h");
        require(claim.publicSaleEnd() - claim.publicSaleStart() + 1 == 7 days, "public window");
        require(claim.claimEnd() < claim.publicSaleEnd(), "claims close before the sale");
    }
}
