// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GenesisHolderClaim} from "../contracts/GenesisHolderClaim.sol";
import {VoidReleaseFactoryV2Royalty} from "../contracts/VoidReleaseFactoryV2Royalty.sol";
import {VoidRelease1155V4Royalty} from "../contracts/VoidRelease1155V4Royalty.sol";
import {VoidPrimarySale} from "../contracts/VoidPrimarySale.sol";
import {ReleaseMarketplaceV4} from "../contracts/ReleaseMarketplaceV4.sol";

interface VmClaimRoyalty {
    function chainId(uint256) external;
    function warp(uint256) external;
    function deal(address, uint256) external;
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function prank(address) external;
}

/// @notice The Forgive & Forget Genesis claim on the mainnet launch path: a VoidReleaseFactoryV2Royalty
/// clone (2.5% royalty locked on chain), an open edition, the C-Chain schedule (24 h free claim, then
/// 7 days at 0.25 AVAX) and resale on ReleaseMarketplaceV4. GenesisHolderClaim itself is unchanged by
/// the royalty work; this proves the two compose. Test keys are local cheat-code fixtures only.
contract GenesisHolderClaimRoyaltyReleaseTest {
    VmClaimRoyalty internal constant vm = VmClaimRoyalty(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 internal constant SIGNER_KEY = 0xA11CE;
    address internal constant NANO = 0xb65C575CaE01574296Fab6E620B9A15cC0121ce4;
    address internal constant ARTIST = address(0xA7157);
    address internal constant ADMIN = address(0xAD01);
    address internal constant CLAIMANT = address(0xCA11);
    address internal constant COLLECTOR = address(0xC011);
    address internal constant BUYER = address(0xB0B);
    bytes32 internal constant APP = keccak256("forgive-and-forget-mainnet");
    bytes32 internal constant EDITION_ID = keccak256("forgive-and-forget");
    uint256 internal constant PRICE = 0.25 ether;
    uint256 internal constant T0 = 1_800_000_000;
    uint256 internal constant CLAIM_START = T0 + 1 hours;
    uint256 internal constant CLAIM_END = CLAIM_START + 1 days;
    uint256 internal constant PUBLIC_END = CLAIM_START + 7 days - 1;

    VoidReleaseFactoryV2Royalty internal factory;
    ReleaseMarketplaceV4 internal market;
    VoidRelease1155V4Royalty internal release;
    VoidPrimarySale internal sale;
    GenesisHolderClaim internal claimContract;
    bytes32 internal releaseKey;
    uint256 internal tokenId;

    function setUp() public {
        vm.chainId(43114);
        vm.warp(T0);
        factory = new VoidReleaseFactoryV2Royalty(NANO);
        market = new ReleaseMarketplaceV4(NANO, 250, address(factory));
        releaseKey = keccak256(abi.encode("the-void:studio-release:v2", block.chainid, address(factory), APP, ARTIST));
        vm.prank(ARTIST);
        (address releaseAddress, address saleAddress,) = factory.createRelease(APP, releaseKey, "Forgive & Forget", "FNF", "ipfs://fnf");
        release = VoidRelease1155V4Royalty(releaseAddress);
        sale = VoidPrimarySale(saleAddress);
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

    /// Nobody but the release admin (the artist) can grant or revoke a release role, nobody but the claim
    /// admin can pause, re-sign or hand over the claim, and only issuers can mint. The deployer, the
    /// fee recipient, a claimant and the claim signer each fail.
    function testUnauthorizedRoleChangesAreRejected() public {
        bytes32 issuerRole = release.ISSUER_ROLE();
        bytes32 adminRole = release.DEFAULT_ADMIN_ROLE();
        address[4] memory outsiders = [address(this), NANO, CLAIMANT, vm.addr(SIGNER_KEY)];
        for (uint256 i = 0; i < outsiders.length; i++) {
            address outsider = outsiders[i];
            if (outsider == address(this)) {
                require(!release.hasRole(adminRole, outsider), "deployer holds the release admin role");
            }
            vm.prank(outsider);
            (bool ok,) = address(release).call(abi.encodeCall(release.grantRole, (issuerRole, outsider)));
            require(!ok, "outsider granted ISSUER_ROLE");
            vm.prank(outsider);
            (ok,) = address(release).call(abi.encodeCall(release.grantRole, (adminRole, outsider)));
            require(!ok, "outsider granted the admin role");
            vm.prank(outsider);
            (ok,) = address(release).call(abi.encodeCall(release.revokeRole, (issuerRole, address(claimContract))));
            require(!ok, "outsider revoked the claim's ISSUER_ROLE");
            vm.prank(outsider);
            (ok,) = address(release).call(abi.encodeCall(release.mint, (outsider, tokenId, 1, "")));
            require(!ok, "outsider minted");
            vm.prank(outsider);
            (ok,) = address(claimContract).call(abi.encodeCall(GenesisHolderClaim.setSigner, (outsider)));
            require(!ok, "outsider rotated the signer");
            vm.prank(outsider);
            (ok,) = address(claimContract).call(abi.encodeCall(GenesisHolderClaim.transferAdmin, (outsider)));
            require(!ok, "outsider took the claim admin");
            vm.prank(outsider);
            (ok,) = address(claimContract).call(abi.encodeCall(GenesisHolderClaim.pause, ()));
            require(!ok, "outsider paused the claim");
            vm.prank(outsider);
            (ok,) = address(sale).call(abi.encodeCall(sale.configureSale, (tokenId, 0, 0, 0, uint64(CLAIM_START), uint64(PUBLIC_END), false)));
            require(!ok, "outsider reconfigured the sale");
        }
        require(release.hasRole(issuerRole, address(claimContract)), "claim lost ISSUER_ROLE");
        require(release.hasRole(adminRole, ARTIST), "artist is not the release admin");
        require(!release.hasRole(adminRole, address(factory)), "factory kept the admin role");
    }

    function testEditionCarriesTheLockedRoyaltyAndTheClaimIsBoundToIt() public view {
        require(release.royaltyBpsOf(tokenId) == 250 && release.payoutOf(tokenId) == ARTIST, "2.5% royalty to the artist");
        require(release.maxSupplyOf(tokenId) == 0, "open edition");
        require(claimContract.releaseContract() == address(release) && claimContract.primarySale() == address(sale), "claim bound to this release");
    }

    function testFreeClaimMintsOneTokenToTheClaimantAndRejectsDuplicatesAndReplays() public {
        vm.warp(CLAIM_START);
        GenesisHolderClaim.ClaimVoucher memory first = voucher(CLAIMANT, 1);
        require(claim(CLAIMANT, first), "valid claim succeeds");
        require(release.balanceOf(CLAIMANT, tokenId) == 1, "token minted directly to the claimant");
        require(claimContract.hasClaimed(CLAIMANT), "claim recorded");
        require(!claim(CLAIMANT, first), "replayed voucher rejected");
        require(!claim(CLAIMANT, voucher(CLAIMANT, 2)), "second claim by the same wallet rejected");
        require(!claim(COLLECTOR, first), "another wallet cannot use the voucher");
        require(release.balanceOf(CLAIMANT, tokenId) == 1 && release.edition(tokenId).mintedSupply == 1, "exactly one token minted");
    }

    function testClaimWindowRunsInsideThePublicSaleWithTheTwoPointFivePercentFee() public {
        vm.warp(CLAIM_START);
        require(claim(CLAIMANT, voucher(CLAIMANT, 1)), "claim during the window");
        vm.deal(COLLECTOR, PRICE * 2);
        // The public sale is open at the same time as the claims.
        vm.prank(COLLECTOR);
        sale.purchase{value: PRICE}(tokenId, 1);
        require(sale.balances(NANO) == 0.00625 ether && sale.balances(ARTIST) == 0.24375 ether, "primary 2.5% to the Nano, 97.5% to the artist");
        vm.warp(CLAIM_END);
        require(!claim(COLLECTOR, voucher(COLLECTOR, 3)), "no free claim after the window");
        vm.prank(COLLECTOR);
        sale.purchase{value: PRICE}(tokenId, 1);
        require(release.balanceOf(COLLECTOR, tokenId) == 2, "paid minting continues after the claims close");
        vm.warp(PUBLIC_END + 1);
        vm.deal(BUYER, PRICE);
        vm.prank(BUYER);
        try sale.purchase{value: PRICE}(tokenId, 1) { revert("public sale closes after 7 days"); } catch {}
    }

    function testAClaimedTokenResellsOnMarketplaceV4AtTheExactSplit() public {
        vm.warp(CLAIM_START);
        require(claim(CLAIMANT, voucher(CLAIMANT, 1)), "claim");
        vm.prank(CLAIMANT);
        release.setApprovalForAll(address(market), true);
        vm.prank(CLAIMANT);
        uint256 listingId = market.createListing(address(release), CLAIMANT, tokenId, 1, 1 ether, 0);
        uint256 nanoBefore = NANO.balance;
        uint256 artistBefore = ARTIST.balance;
        uint256 sellerBefore = CLAIMANT.balance;
        vm.deal(BUYER, 1 ether);
        vm.prank(BUYER);
        market.buy{value: 1 ether}(listingId, 1);
        require(NANO.balance == nanoBefore + 0.025 ether, "marketplace fee 2.5% to the Nano");
        require(ARTIST.balance == artistBefore + 0.025 ether, "artist royalty 2.5%");
        require(CLAIMANT.balance == sellerBefore + 0.95 ether, "seller 95%");
        require(release.balanceOf(BUYER, tokenId) == 1, "ownership moved");
    }
}
