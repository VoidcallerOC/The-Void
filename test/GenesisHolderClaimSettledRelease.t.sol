// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GenesisHolderClaim} from "../contracts/GenesisHolderClaim.sol";
import {VoidReleaseFactoryV2RoyaltySettled} from "../contracts/VoidReleaseFactoryV2RoyaltySettled.sol";
import {VoidRelease1155V4Royalty} from "../contracts/VoidRelease1155V4Royalty.sol";
import {VoidPrimarySaleSettled} from "../contracts/VoidPrimarySaleSettled.sol";
import {ReleaseMarketplaceV4} from "../contracts/ReleaseMarketplaceV4.sol";

interface VmClaimSettled {
    function chainId(uint256) external;
    function warp(uint256) external;
    function deal(address, uint256) external;
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function prank(address) external;
}

/// @notice GenesisHolderClaimRoyaltyRelease on the corrected factory (local EVM, nothing deployed): the unchanged
/// GenesisHolderClaim composes with a VoidReleaseFactoryV2RoyaltySettled release and its VoidPrimarySaleSettled.
/// The free claim moves no AVAX; public purchases push 2.5% to the platform during the purchase and credit 97.5%;
/// a claimed token resells on the marketplace built for this factory. Test keys are local cheat-code fixtures only.
contract GenesisHolderClaimSettledReleaseTest {
    VmClaimSettled internal constant vm = VmClaimSettled(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 internal constant SIGNER_KEY = 0xA11CE;
    address internal constant NANO = 0xb65C575CaE01574296Fab6E620B9A15cC0121ce4;
    address internal constant ARTIST = address(0xA7157);
    address internal constant ADMIN = address(0xAD01);
    address internal constant CLAIMANT = address(0xCA11);
    address internal constant COLLECTOR = address(0xC011);
    address internal constant BUYER = address(0xB0B);
    bytes32 internal constant APP = keccak256("forgive-and-forget-replacement");
    bytes32 internal constant EDITION_ID = keccak256("forgive-and-forget");
    uint256 internal constant PRICE = 0.25 ether;
    uint256 internal constant T0 = 1_800_000_000;
    uint256 internal constant CLAIM_START = T0 + 1 hours;
    uint256 internal constant CLAIM_END = CLAIM_START + 1 days;
    uint256 internal constant PUBLIC_END = CLAIM_START + 7 days - 1;

    VoidReleaseFactoryV2RoyaltySettled internal factory;
    ReleaseMarketplaceV4 internal market;
    VoidRelease1155V4Royalty internal release;
    VoidPrimarySaleSettled internal sale;
    GenesisHolderClaim internal claimContract;
    uint256 internal tokenId;

    function setUp() public {
        vm.chainId(43114);
        vm.warp(T0);
        factory = new VoidReleaseFactoryV2RoyaltySettled(NANO);
        market = new ReleaseMarketplaceV4(NANO, 250, address(factory));
        bytes32 releaseKey = keccak256(abi.encode("the-void:studio-release:v2", block.chainid, address(factory), APP, ARTIST));
        vm.prank(ARTIST);
        (address releaseAddress, address saleAddress,) = factory.createRelease(APP, releaseKey, "Forgive & Forget", "FNF", "ipfs://fnf");
        release = VoidRelease1155V4Royalty(releaseAddress);
        sale = VoidPrimarySaleSettled(saleAddress);
        vm.prank(ARTIST);
        tokenId = release.createEditionWithMintEnd(releaseKey, EDITION_ID, 0, "ipfs://fnf-edition", ARTIST, 250, uint64(PUBLIC_END));
        vm.prank(ARTIST);
        sale.configureSale(tokenId, PRICE, 0, 0, uint64(CLAIM_START), uint64(PUBLIC_END), false);
        claimContract = new GenesisHolderClaim(address(release), address(sale), tokenId, 0, 0, CLAIM_START, 1 days, 7 days, PRICE, ADMIN, vm.addr(SIGNER_KEY));
        bytes32 issuerRole = release.ISSUER_ROLE();
        vm.prank(ARTIST);
        release.grantRole(issuerRole, address(claimContract));
    }

    function voucher(address claimant, uint256 nonce) internal view returns (GenesisHolderClaim.ClaimVoucher memory) {
        return GenesisHolderClaim.ClaimVoucher({
            claimant: claimant,
            genesisContract: claimContract.GENESIS_CONTRACT(),
            genesisChainId: claimContract.GENESIS_CHAIN_ID(),
            eligibilityRule: claimContract.ELIGIBILITY_RULE(),
            destinationChainId: 43114,
            releaseContract: address(release),
            tokenId: tokenId,
            quantity: 1,
            allocation: claimContract.allocation(),
            nonce: nonce,
            deadline: block.timestamp + 300
        });
    }

    function claim(address caller, GenesisHolderClaim.ClaimVoucher memory v) internal returns (bool ok) {
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, claimContract.voucherDigest(v));
        vm.prank(caller);
        (ok,) = address(claimContract).call(abi.encodeCall(GenesisHolderClaim.claim, (v, abi.encodePacked(r, s, sv))));
    }

    function testClaimBindsToTheSettledSaleAndTheGenesisCollectionIsUnchanged() public view {
        require(claimContract.releaseContract() == address(release) && claimContract.primarySale() == address(sale), "claim bound to this release and sale");
        require(claimContract.GENESIS_CONTRACT() == 0xD1B4367dd9f235f9ee61878019d66E31511E98eE, "Genesis identity is the existing collection");
        require(factory.primarySaleOf(address(release)) == address(sale), "the factory registered the settled sale");
    }

    function testFreeClaimMovesNoAvaxAndPublicPurchasesPushTheFee() public {
        vm.warp(CLAIM_START);
        require(claim(CLAIMANT, voucher(CLAIMANT, 1)), "valid claim succeeds");
        require(release.balanceOf(CLAIMANT, tokenId) == 1, "token minted to the claimant");
        require(NANO.balance == 0 && address(sale).balance == 0 && sale.balances(ARTIST) == 0, "the free claim moves no AVAX");
        require(!claim(CLAIMANT, voucher(CLAIMANT, 2)), "second claim by the same wallet rejected");

        vm.deal(COLLECTOR, PRICE * 2);
        vm.prank(COLLECTOR);
        sale.purchase{value: PRICE}(tokenId, 1);
        require(NANO.balance == 0.00625 ether && sale.balances(NANO) == 0, "2.5% paid to the platform during the purchase, never credited");
        require(sale.balances(ARTIST) == 0.24375 ether && address(sale).balance == 0.24375 ether, "97.5% claimable by the artist");

        vm.warp(CLAIM_END);
        require(!claim(COLLECTOR, voucher(COLLECTOR, 3)), "no free claim after the window");
        vm.prank(COLLECTOR);
        sale.purchase{value: PRICE}(tokenId, 1);
        require(NANO.balance == 0.0125 ether && sale.balances(ARTIST) == 0.4875 ether, "each purchase settles once");

        uint256 before = ARTIST.balance;
        vm.prank(ARTIST);
        sale.withdraw();
        require(ARTIST.balance - before == 0.4875 ether && address(sale).balance == 0, "artist claims the 97.5%");
    }

    function testAClaimedTokenResellsOnTheCorrectedFactoryMarketplace() public {
        vm.warp(CLAIM_START);
        require(claim(CLAIMANT, voucher(CLAIMANT, 1)), "claim");
        vm.prank(CLAIMANT);
        release.setApprovalForAll(address(market), true);
        vm.prank(CLAIMANT);
        uint256 listingId = market.createListing(address(release), CLAIMANT, tokenId, 1, 1 ether, 0);
        vm.deal(BUYER, 1 ether);
        vm.prank(BUYER);
        market.buy{value: 1 ether}(listingId, 1);
        require(NANO.balance == 0.025 ether && ARTIST.balance == 0.025 ether && CLAIMANT.balance == 0.95 ether, "95/2.5/2.5");
        require(release.balanceOf(BUYER, tokenId) == 1, "ownership moved");
    }
}
