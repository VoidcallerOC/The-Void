// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VoidRelease1155V3} from "../contracts/VoidRelease1155V3.sol";
import {VoidPrimarySale} from "../contracts/VoidPrimarySale.sol";
import {MusicMarketplace} from "../contracts/MusicMarketplace.sol";

interface Vm {
    function prank(address) external;
    function deal(address, uint256) external;
    function expectRevert(bytes calldata) external;
}

/// Multi-artist authorization on the shared canonical ERC-1155.
/// Artist keys mirror server/artist-authorization.js artistKeyFor(databaseArtistId).
contract VoidRelease1155V3Test {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 internal constant VOIDCALLER_CERTIFIED_TOKEN_ID =
        33778802922810732976408591241428358474475553907731009337085064305512658576739;

    VoidRelease1155V3 internal token;
    VoidPrimarySale internal sale;
    MusicMarketplace internal market;

    address internal admin = address(this);
    address internal platform = address(0xFEE);

    bytes32 internal testArtist = artistKey("artist-test-artist");
    bytes32 internal artistB = artistKey("artist-b");
    bytes32 internal voidcaller = artistKey("voidcaller");
    bytes32 internal unverified = artistKey("artist-unverified");

    address internal testWallet = address(0x7E57);
    address internal testPayout = address(0x7E58);
    address internal bWallet = address(0xB0B);
    address internal bPayout = address(0xB0C);
    address internal voidcallerWallet = address(0xABD3);
    address internal voidcallerPayout = address(0xABD4);
    address internal stranger = address(0x5757);
    address internal fan = address(0xFA11);
    address internal buyer = address(0xB1E5);

    bytes32 internal constant TEST_RELEASE = bytes32("test-release");
    bytes32 internal constant TEST_EDITION = bytes32("test-edition");
    bytes32 internal constant B_RELEASE = bytes32("artist-b-release");
    bytes32 internal constant B_EDITION = bytes32("artist-b-edition");
    bytes32 internal constant VC_RELEASE = bytes32("voidcaller");
    bytes32 internal constant VC_EDITION = bytes32("voidcaller");

    function artistKey(string memory databaseArtistId) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("the-void:artist:v1:", databaseArtistId));
    }

    function onboard(bytes32 artistId, address wallet, bytes32 releaseId) internal {
        token.registerArtist(artistId);
        token.setArtistWallet(artistId, wallet, true);
        token.bindRelease(releaseId, artistId);
    }

    function setUp() public {
        token = new VoidRelease1155V3(admin);
        sale = new VoidPrimarySale(address(token), platform, 500);
        market = new MusicMarketplace(platform, 250, address(token));
        onboard(testArtist, testWallet, TEST_RELEASE);
        onboard(artistB, bWallet, B_RELEASE);
        onboard(voidcaller, voidcallerWallet, VC_RELEASE);
    }

    function createTestEdition() internal returns (uint256 id) {
        vm.prank(testWallet);
        id = token.createEdition(TEST_RELEASE, TEST_EDITION, 10, "ipfs://test-edition", testPayout, 500);
    }

    function createBEdition() internal returns (uint256 id) {
        vm.prank(bWallet);
        id = token.createEdition(B_RELEASE, B_EDITION, 10, "ipfs://b-edition", bPayout, 700);
    }

    function createVoidcallerEdition() internal returns (uint256 id) {
        vm.prank(voidcallerWallet);
        id = token.createEdition(VC_RELEASE, VC_EDITION, 25, "ipfs://voidcaller", voidcallerPayout, 1_000);
    }

    // ------------------------------------------------------------ second artist E2E

    function testSecondArtistFullLifecycle() public {
        // 1-3: TEST ARTIST created, verified (registered), wallet authorized in setUp.
        require(token.isArtistRegistered(testArtist) && token.isArtistActive(testArtist), "verified");
        require(token.artistIdOfWallet(testWallet) == testArtist, "wallet bound");
        require(token.hasRole(token.ARTIST_ROLE(), testWallet), "derived artist role");
        // 4: TEST RELEASE bound to TEST ARTIST.
        require(token.releaseArtistOf(TEST_RELEASE) == testArtist, "release owned");
        // 5-7: TEST EDITION published on-chain by TEST ARTIST's wallet.
        uint256 id = createTestEdition();
        // 6: deterministic token identity.
        require(id == token.tokenIdFor(TEST_RELEASE, TEST_EDITION), "derived token id");
        require(id != VOIDCALLER_CERTIFIED_TOKEN_ID, "distinct from voidcaller");
        require(token.artistIdOf(id) == testArtist, "edition artist id");
        require(token.artistOf(id) == testWallet, "edition artist wallet");
        // 8: TEST ARTIST mints its own token.
        vm.prank(testWallet);
        token.mint(fan, id, 2, "");
        // 9: ownership.
        require(token.balanceOf(fan, id) == 2, "fan owns");
        require(token.edition(id).mintedSupply == 2, "supply consumed");
        // 10a: primary sale (shared sale contract, artist-consented issuer).
        vm.prank(testWallet);
        token.setArtistIssuer(address(sale), true);
        vm.prank(testWallet);
        sale.configureSale(id, 1 ether, 5, 2, 0, 0, false);
        vm.deal(buyer, 10 ether);
        vm.prank(buyer);
        sale.purchase{value: 1 ether}(id, 1);
        require(token.balanceOf(buyer, id) == 1, "sale minted");
        require(sale.balances(testPayout) == 0.95 ether, "artist proceeds");
        // 10b: secondary marketplace on the canonical contract, royalty to TEST ARTIST payout.
        vm.prank(fan);
        token.setApprovalForAll(address(market), true);
        vm.prank(fan);
        uint256 listingId = market.createListing(address(token), fan, id, 1, 2 ether, 0);
        uint256 payoutBefore = testPayout.balance;
        vm.prank(buyer);
        market.buy{value: 2 ether}(listingId, 1);
        require(token.balanceOf(buyer, id) == 2 && token.balanceOf(fan, id) == 1, "resale settled");
        require(testPayout.balance - payoutBefore == 0.1 ether, "5% royalty to test artist");
        // 11: gating is token-specific balanceOf.
        require(token.balanceOf(buyer, id) > 0, "holder unlocks");
        require(token.balanceOf(stranger, id) == 0, "non-holder locked");
    }

    // ------------------------------------------------------- negative authorization

    function testArtistCannotCreateEditionUnderAnotherArtistsRelease() public {
        vm.prank(testWallet);
        vm.expectRevert(abi.encodeWithSelector(VoidRelease1155V3.ReleaseOwnedByAnotherArtist.selector, B_RELEASE, artistB, testArtist));
        token.createEdition(B_RELEASE, B_EDITION, 1, "ipfs://hijack", testPayout, 0);
        vm.prank(testWallet);
        vm.expectRevert(abi.encodeWithSelector(VoidRelease1155V3.ReleaseOwnedByAnotherArtist.selector, VC_RELEASE, voidcaller, testArtist));
        token.createEdition(VC_RELEASE, VC_EDITION, 1, "ipfs://hijack");
    }

    function testArtistCannotSquatAnUnboundRelease() public {
        vm.prank(testWallet);
        vm.expectRevert(abi.encodeWithSelector(VoidRelease1155V3.ReleaseNotBound.selector, bytes32("artist-b-next")));
        token.createEdition(bytes32("artist-b-next"), B_EDITION, 1, "ipfs://squat", testPayout, 0);
    }

    function testReleaseBindingIsPermanent() public {
        vm.expectRevert(abi.encodeWithSelector(VoidRelease1155V3.ReleaseAlreadyBound.selector, B_RELEASE, artistB));
        token.bindRelease(B_RELEASE, testArtist);
        token.bindRelease(B_RELEASE, artistB); // idempotent for the owner
        require(token.releaseArtistOf(B_RELEASE) == artistB, "still artist b");
    }

    function testArtistCannotMintAnotherArtistsEdition() public {
        uint256 bId = createBEdition();
        vm.prank(testWallet);
        vm.expectRevert(abi.encodeWithSelector(VoidRelease1155V3.NotAuthorizedMinter.selector, bId, artistB, testWallet));
        token.mint(testWallet, bId, 1, "");
        require(token.edition(bId).mintedSupply == 0, "no supply consumed");
    }

    function testMintBatchCrossArtistRejectedAtomically() public {
        uint256 own = createTestEdition();
        uint256 bId = createBEdition();
        uint256[] memory ids = new uint256[](2);
        uint256[] memory amounts = new uint256[](2);
        ids[0] = own; ids[1] = bId; amounts[0] = 1; amounts[1] = 1;
        vm.prank(testWallet);
        vm.expectRevert(abi.encodeWithSelector(VoidRelease1155V3.NotAuthorizedMinter.selector, bId, artistB, testWallet));
        token.mintBatch(fan, ids, amounts, "");
        require(token.balanceOf(fan, own) == 0 && token.edition(own).mintedSupply == 0, "rolled back");
    }

    function testUnverifiedArtistCannotPublish() public {
        address wallet = address(0xDEAD1);
        // Not registered: the registrar cannot authorize wallets or releases for it.
        vm.expectRevert(abi.encodeWithSelector(VoidRelease1155V3.ArtistNotRegistered.selector, unverified));
        token.setArtistWallet(unverified, wallet, true);
        vm.expectRevert(abi.encodeWithSelector(VoidRelease1155V3.ArtistNotRegistered.selector, unverified));
        token.bindRelease(bytes32("unverified-release"), unverified);
        // Its wallet has no artist authority.
        require(!token.hasRole(token.ARTIST_ROLE(), wallet), "no derived role");
        vm.prank(wallet);
        vm.expectRevert(abi.encodeWithSelector(VoidRelease1155V3.NotArtistWallet.selector, wallet));
        token.createEdition(bytes32("unverified-release"), bytes32("e"), 1, "ipfs://x", wallet, 0);
    }

    function testRevokedArtistCannotPublishMintOrApproveIssuers() public {
        uint256 id = createTestEdition();
        vm.prank(testWallet);
        token.mint(fan, id, 1, "");
        vm.prank(testWallet);
        token.setArtistIssuer(address(sale), true);
        token.setArtistActive(testArtist, false);

        require(!token.hasRole(token.ARTIST_ROLE(), testWallet), "role withdrawn");
        require(!token.canMint(testWallet, id) && !token.canMint(address(sale), id), "no minters");
        vm.prank(testWallet);
        vm.expectRevert(abi.encodeWithSelector(VoidRelease1155V3.ArtistInactive.selector, testArtist));
        token.createEdition(TEST_RELEASE, bytes32("after-revoke"), 1, "ipfs://x", testPayout, 0);
        vm.prank(testWallet);
        vm.expectRevert(abi.encodeWithSelector(VoidRelease1155V3.ArtistInactive.selector, testArtist));
        token.mint(fan, id, 1, "");
        vm.prank(address(sale));
        vm.expectRevert(abi.encodeWithSelector(VoidRelease1155V3.ArtistInactive.selector, testArtist));
        token.mint(fan, id, 1, "");
        vm.prank(testWallet);
        vm.expectRevert(abi.encodeWithSelector(VoidRelease1155V3.ArtistInactive.selector, testArtist));
        token.setArtistIssuer(stranger, true);

        // Collectors keep and can move what they already own.
        vm.prank(fan);
        token.safeTransferFrom(fan, buyer, id, 1, "");
        require(token.balanceOf(buyer, id) == 1, "collector asset intact");

        // Revoking TEST ARTIST does not touch artist B.
        uint256 bId = createBEdition();
        vm.prank(bWallet);
        token.mint(fan, bId, 1, "");

        token.setArtistActive(testArtist, true);
        vm.prank(testWallet);
        token.mint(fan, id, 1, "");
        require(token.balanceOf(fan, id) == 1, "reinstated");
    }

    function testUnauthorizedWalletCannotPublish() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(VoidRelease1155V3.NotArtistWallet.selector, stranger));
        token.createEdition(TEST_RELEASE, TEST_EDITION, 1, "ipfs://x", stranger, 0);
        // A wallet removed from the artist loses authority immediately.
        token.setArtistWallet(testArtist, testWallet, false);
        vm.prank(testWallet);
        vm.expectRevert(abi.encodeWithSelector(VoidRelease1155V3.NotArtistWallet.selector, testWallet));
        token.createEdition(TEST_RELEASE, TEST_EDITION, 1, "ipfs://x", testPayout, 0);
    }

    function testWalletCannotServeTwoArtists() public {
        vm.expectRevert(abi.encodeWithSelector(VoidRelease1155V3.WalletBoundToAnotherArtist.selector, testWallet, testArtist));
        token.setArtistWallet(artistB, testWallet, true);
        vm.expectRevert(abi.encodeWithSelector(VoidRelease1155V3.WalletBoundToAnotherArtist.selector, testWallet, testArtist));
        token.setArtistWallet(artistB, testWallet, false);
        require(token.artistIdOfWallet(testWallet) == testArtist, "binding unchanged");
    }

    function testIssuerApprovedByOneArtistCannotMintAnother() public {
        uint256 own = createTestEdition();
        uint256 bId = createBEdition();
        vm.prank(testWallet);
        token.setArtistIssuer(stranger, true);
        vm.prank(stranger);
        token.mint(fan, own, 1, "");
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(VoidRelease1155V3.NotAuthorizedMinter.selector, bId, artistB, stranger));
        token.mint(fan, bId, 1, "");
        require(token.isIssuerApproved(testArtist, stranger) && !token.isIssuerApproved(artistB, stranger), "scoped approval");
    }

    function testPlatformHasNoArtistOrIssuerAuthority() public {
        uint256 id = createTestEdition();
        // Admin/registrar is not an artist and cannot mint any artist's edition.
        vm.expectRevert(abi.encodeWithSelector(VoidRelease1155V3.NotArtistWallet.selector, admin));
        token.createEdition(TEST_RELEASE, bytes32("platform"), 1, "ipfs://x", admin, 0);
        vm.expectRevert(abi.encodeWithSelector(VoidRelease1155V3.NotAuthorizedMinter.selector, id, testArtist, admin));
        token.mint(admin, id, 1, "");
        // No global artist or issuer role can be granted.
        bytes32 artistRole = token.ARTIST_ROLE();
        vm.expectRevert(abi.encodeWithSelector(VoidRelease1155V3.InvalidRole.selector, artistRole));
        token.grantRole(artistRole, stranger);
        bytes32 issuerRole = keccak256("ISSUER_ROLE");
        vm.expectRevert(abi.encodeWithSelector(VoidRelease1155V3.InvalidRole.selector, issuerRole));
        token.grantRole(issuerRole, stranger);
        // Only the registrar manages the registry.
        bytes32 registrar = token.REGISTRAR_ROLE();
        vm.prank(testWallet);
        vm.expectRevert(abi.encodeWithSelector(VoidRelease1155V3.AccessDenied.selector, registrar, testWallet));
        token.bindRelease(bytes32("self-bound"), testArtist);
        vm.prank(testWallet);
        vm.expectRevert(abi.encodeWithSelector(VoidRelease1155V3.AccessDenied.selector, registrar, testWallet));
        token.setArtistWallet(testArtist, stranger, true);
    }

    function testPrimarySaleIsArtistScoped() public {
        uint256 own = createTestEdition();
        uint256 bId = createBEdition();
        // Sale contract cannot mint for an artist that has not approved it.
        vm.prank(bWallet);
        sale.configureSale(bId, 1 ether, 5, 5, 0, 0, false);
        vm.deal(buyer, 10 ether);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(VoidRelease1155V3.NotAuthorizedMinter.selector, bId, artistB, address(sale)));
        sale.purchase{value: 1 ether}(bId, 1);
        // TEST ARTIST cannot configure artist B's sale.
        vm.prank(testWallet);
        vm.expectRevert(abi.encodeWithSelector(VoidPrimarySale.NotEditionArtist.selector, bId, bWallet, testWallet));
        sale.configureSale(bId, 1 wei, 1, 1, 0, 0, false);
        // A revoked artist cannot configure sales either.
        token.setArtistActive(testArtist, false);
        vm.prank(testWallet);
        vm.expectRevert(abi.encodeWithSelector(VoidPrimarySale.AccessDenied.selector, testWallet));
        sale.configureSale(own, 1 ether, 1, 1, 0, 0, false);
    }

    function testWalletMovedToAnotherArtistLosesAuthorityOverOldEditions() public {
        uint256 id = createTestEdition();
        vm.prank(testWallet);
        token.setArtistIssuer(address(sale), true);
        // The registrar moves the wallet from TEST ARTIST to artist B.
        token.setArtistWallet(testArtist, testWallet, false);
        token.setArtistWallet(artistB, testWallet, true);
        require(token.hasRole(token.ARTIST_ROLE(), testWallet), "now an artist-B wallet");
        require(token.artistOf(id) == address(0), "no current artist wallet for the old edition");
        require(token.edition(id).artist == testWallet, "creation record is historical");
        // It cannot mint or configure the sale of TEST ARTIST's edition any more.
        vm.prank(testWallet);
        vm.expectRevert(abi.encodeWithSelector(VoidRelease1155V3.NotAuthorizedMinter.selector, id, testArtist, testWallet));
        token.mint(testWallet, id, 1, "");
        vm.prank(testWallet);
        vm.expectRevert(abi.encodeWithSelector(VoidPrimarySale.NotEditionArtist.selector, id, address(0), testWallet));
        sale.configureSale(id, 1 wei, 10, 10, 0, 0, false);
        // Nor create editions under TEST ARTIST's release.
        vm.prank(testWallet);
        vm.expectRevert(abi.encodeWithSelector(VoidRelease1155V3.ReleaseOwnedByAnotherArtist.selector, TEST_RELEASE, testArtist, artistB));
        token.createEdition(TEST_RELEASE, bytes32("after-move"), 1, "ipfs://x", testWallet, 0);
        // Moving it back restores authority.
        token.setArtistWallet(artistB, testWallet, false);
        token.setArtistWallet(testArtist, testWallet, true);
        require(token.artistOf(id) == testWallet, "restored");
    }

    function testIssuerBoundary() public {
        uint256 own = createTestEdition();
        uint256 bId = createBEdition();
        address issuerA = address(0x1551);
        vm.prank(testWallet);
        token.setArtistIssuer(issuerA, true);
        // Legitimate: the issuer for artist A mints artist A's edition.
        vm.prank(issuerA);
        token.mint(fan, own, 2, "");
        require(token.balanceOf(fan, own) == 2, "issuer minted own artist");
        // Boundary: the same issuer cannot mint artist B's edition, singly or in a batch.
        vm.prank(issuerA);
        vm.expectRevert(abi.encodeWithSelector(VoidRelease1155V3.NotAuthorizedMinter.selector, bId, artistB, issuerA));
        token.mint(fan, bId, 1, "");
        uint256[] memory ids = new uint256[](1);
        uint256[] memory amounts = new uint256[](1);
        ids[0] = bId; amounts[0] = 1;
        vm.prank(issuerA);
        vm.expectRevert(abi.encodeWithSelector(VoidRelease1155V3.NotAuthorizedMinter.selector, bId, artistB, issuerA));
        token.mintBatch(fan, ids, amounts, "");
        // Only artist A's own wallet can withdraw the approval; artist B cannot touch it.
        vm.prank(bWallet);
        token.setArtistIssuer(issuerA, false);
        require(token.isIssuerApproved(testArtist, issuerA), "artist B cannot revoke artist A's issuer");
        vm.prank(testWallet);
        token.setArtistIssuer(issuerA, false);
        vm.prank(issuerA);
        vm.expectRevert(abi.encodeWithSelector(VoidRelease1155V3.NotAuthorizedMinter.selector, own, testArtist, issuerA));
        token.mint(fan, own, 1, "");
    }

    function testCrossArtistTokenReferencesAreDistinct() public {
        // Same edition label under each artist's own release yields different tokens.
        token.bindRelease(bytes32("b-shared"), artistB);
        token.bindRelease(bytes32("t-shared"), testArtist);
        vm.prank(bWallet);
        uint256 bId = token.createEdition(bytes32("b-shared"), bytes32("edition"), 1, "ipfs://b", bPayout, 0);
        vm.prank(testWallet);
        uint256 tId = token.createEdition(bytes32("t-shared"), bytes32("edition"), 1, "ipfs://t", testPayout, 0);
        require(bId != tId, "distinct tokens");
        require(token.artistIdOf(bId) == artistB && token.artistIdOf(tId) == testArtist, "distinct owners");
        // An existing token ID can never be re-created by another artist.
        vm.prank(testWallet);
        vm.expectRevert(abi.encodeWithSelector(VoidRelease1155V3.ReleaseOwnedByAnotherArtist.selector, bytes32("b-shared"), artistB, testArtist));
        token.createEdition(bytes32("b-shared"), bytes32("edition"), 1, "ipfs://t", testPayout, 0);
    }

    function testFuzzForeignAccountNeverMints(address account) public {
        uint256 id = createTestEdition();
        if (account == testWallet || account == address(0)) return;
        require(!token.canMint(account, id), "foreign account cannot mint");
        vm.prank(account);
        vm.expectRevert(abi.encodeWithSelector(VoidRelease1155V3.NotAuthorizedMinter.selector, id, testArtist, account));
        token.mint(fan, id, 1, "");
    }

    function testPauseBlocksPublishAndMint() public {
        uint256 id = createTestEdition();
        token.pause();
        vm.prank(testWallet);
        vm.expectRevert(abi.encodeWithSelector(VoidRelease1155V3.ContractPaused.selector));
        token.mint(fan, id, 1, "");
        token.unpause();
        vm.prank(testWallet);
        token.mint(fan, id, 1, "");
    }

    // ------------------------------------------------------------ VOIDCALLER regression

    function testVoidcallerCertifiedTokenIdUnchanged() public view {
        require(token.tokenIdFor(VC_RELEASE, VC_EDITION) == VOIDCALLER_CERTIFIED_TOKEN_ID, "certified token id");
    }

    function testVoidcallerIsOneArtistAmongMany() public {
        uint256 vc = createVoidcallerEdition();
        require(vc == VOIDCALLER_CERTIFIED_TOKEN_ID, "same identity on the shared contract");
        require(token.artistIdOf(vc) == voidcaller, "voidcaller owns its edition");
        require(token.edition(vc).maxSupply == 25, "edition supply");
        (address receiver, uint256 royalty) = token.royaltyInfo(vc, 10_000);
        require(receiver == voidcallerPayout && royalty == 1_000, "voidcaller royalty");
        // VOIDCALLER is not the platform.
        require(!token.hasRole(token.DEFAULT_ADMIN_ROLE(), voidcallerWallet), "not admin");
        require(!token.hasRole(token.REGISTRAR_ROLE(), voidcallerWallet), "not registrar");
        // VOIDCALLER has no authority over another artist, and vice versa.
        uint256 t = createTestEdition();
        vm.prank(voidcallerWallet);
        vm.expectRevert(abi.encodeWithSelector(VoidRelease1155V3.NotAuthorizedMinter.selector, t, testArtist, voidcallerWallet));
        token.mint(voidcallerWallet, t, 1, "");
        vm.prank(testWallet);
        vm.expectRevert(abi.encodeWithSelector(VoidRelease1155V3.NotAuthorizedMinter.selector, vc, voidcaller, testWallet));
        token.mint(testWallet, vc, 1, "");
        vm.prank(voidcallerWallet);
        token.mint(fan, vc, 1, "");
        require(token.balanceOf(fan, vc) == 1, "voidcaller mint");
    }

    // ------------------------------------------------------------ multi-artist coexistence

    function testArtistsCoexistIndependently() public {
        uint256 vc = createVoidcallerEdition();
        uint256 t = createTestEdition();
        uint256 b = createBEdition();
        vm.prank(voidcallerWallet);
        token.mint(fan, vc, 1, "");
        vm.prank(testWallet);
        token.mint(fan, t, 2, "");
        vm.prank(bWallet);
        token.mint(buyer, b, 3, "");

        require(token.balanceOf(fan, vc) == 1 && token.balanceOf(fan, t) == 2 && token.balanceOf(fan, b) == 0, "fan balances");
        require(token.balanceOf(buyer, b) == 3 && token.balanceOf(buyer, vc) == 0, "buyer balances");
        require(token.payoutOf(vc) == voidcallerPayout && token.payoutOf(t) == testPayout && token.payoutOf(b) == bPayout, "payouts");
        require(token.artistIdOf(vc) != token.artistIdOf(t) && token.artistIdOf(t) != token.artistIdOf(b), "identities");

        // Revoking one artist leaves the others fully operational.
        token.setArtistActive(voidcaller, false);
        vm.prank(testWallet);
        token.mint(fan, t, 1, "");
        vm.prank(bWallet);
        token.mint(fan, b, 1, "");
        require(!token.canMint(voidcallerWallet, vc), "voidcaller paused alone");
        require(token.canMint(testWallet, t) && token.canMint(bWallet, b), "others active");
    }
}
