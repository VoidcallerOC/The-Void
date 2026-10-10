// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VoidReleaseFactoryV3} from "../contracts/VoidReleaseFactoryV3.sol";
import {VoidRelease1155V5} from "../contracts/VoidRelease1155V5.sol";
import {VoidCollection1155} from "../contracts/VoidCollection1155.sol";
import {VoidPrimarySale} from "../contracts/VoidPrimarySale.sol";
import {ReleaseMarketplaceV3} from "../contracts/ReleaseMarketplaceV3.sol";

interface VmV5 {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function prank(address) external;
    function warp(uint256) external;
    function deal(address, uint256) external;
    function expectRevert(bytes calldata) external;
    function expectRevert(bytes4) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

/// @notice VoidRelease1155V5 through VoidReleaseFactoryV3: one artist transaction creates an
/// edition and records its provenance root; every V4 invariant still holds.
contract VoidRelease1155V5Test {
    VmV5 internal constant vm = VmV5(address(uint160(uint256(keccak256("hevm cheat code")))));

    address internal constant ARTIST = address(0xA11CE);
    address internal constant OTHER_ARTIST = address(0xA22CE);
    address internal constant STRANGER = address(0x57A);
    address internal constant HOLDER = address(0xB0B);
    address internal constant PLATFORM = address(0xFEE);
    bytes32 internal constant APP_RELEASE = keccak256("v5-application-release");
    bytes32 internal constant EDITION = bytes32("forgive-forget");
    bytes32 internal constant ROOT = 0x72e39f2f98fefaa1266fdeb3e9a7ed1359ce97db5d2d1130e759c15d80042e20;
    bytes32 internal constant ANCHORED_TOPIC =
        keccak256("ProvenanceAnchored(bytes32,bytes32,bytes32,uint256,address,address)");
    bytes32 internal constant EDITION_CREATED_TOPIC =
        keccak256("EditionCreated(uint256,bytes32,bytes32,address,uint256,string)");

    VoidReleaseFactoryV3 internal factory;
    VoidRelease1155V5 internal release;
    address internal sale;
    address internal anchor;
    bytes32 internal key;

    function setUp() public {
        factory = new VoidReleaseFactoryV3(PLATFORM);
        (release, sale, anchor, key) = _newRelease(APP_RELEASE, ARTIST);
    }

    function _keyFor(bytes32 applicationReleaseId, address artist) internal view returns (bytes32) {
        return keccak256(abi.encode("the-void:studio-release:v2", block.chainid, address(factory), applicationReleaseId, artist));
    }

    function _newRelease(bytes32 applicationReleaseId, address artist)
        internal
        returns (VoidRelease1155V5 clone, address primarySale, address provenanceAnchor, bytes32 releaseKey)
    {
        releaseKey = _keyFor(applicationReleaseId, artist);
        vm.prank(artist);
        (address releaseAddress, address saleAddress, address anchorAddress) =
            factory.createRelease(applicationReleaseId, releaseKey, "Release", "REL", "ipfs://release");
        return (VoidRelease1155V5(releaseAddress), saleAddress, anchorAddress, releaseKey);
    }

    function _create(bytes32 editionId, uint256 maxSupply, bytes32 root) internal returns (uint256 tokenId) {
        vm.prank(ARTIST);
        tokenId = release.createEdition(key, editionId, maxSupply, "ipfs://edition", ARTIST, 500, root);
    }

    // ---- factory ----

    function testFactoryV3DeploysV5CloneThatIsItsOwnAnchor() public view {
        require(factory.RELEASE_VERSION() == 3, "factory version");
        require(factory.PLATFORM_FEE_BPS() == 250, "fee");
        require(VoidRelease1155V5(factory.implementation()).IMPLEMENTATION_VERSION() == 5, "implementation version");
        require(anchor == address(release), "anchor is the release contract");
        require(factory.provenanceAnchorOf(address(release)) == address(release), "anchor mapping");
        require(factory.isRelease(address(release)), "registered");
        require(factory.artistOf(address(release)) == ARTIST, "artist");
        require(factory.primarySaleOf(address(release)) == sale, "sale");
        require(release.releaseKey() == key, "key");
        require(release.owner() == ARTIST, "owner");
        require(VoidPrimarySale(sale).owner() == address(factory), "fee control sealed in factory");
        require(VoidPrimarySale(sale).platformFeeBps() == 250, "sale fee");
    }

    function testFactoryV3KeepsDeterministicReleaseKeyScheme() public {
        bytes32 appId = keccak256("other-app");
        bytes32 wrong = keccak256(abi.encode("the-void:studio-release:v2", block.chainid, address(0xdead), appId, ARTIST));
        vm.prank(ARTIST);
        vm.expectRevert(abi.encodeWithSelector(VoidReleaseFactoryV3.ReleaseKeyMismatch.selector, _keyFor(appId, ARTIST), wrong));
        factory.createRelease(appId, wrong, "X", "X", "ipfs://x");

        vm.prank(ARTIST);
        vm.expectRevert(abi.encodeWithSelector(VoidReleaseFactoryV3.ReleaseAlreadyExists.selector, key, address(release)));
        factory.createRelease(APP_RELEASE, key, "Again", "AGAIN", "ipfs://again");
    }

    function testReleaseCreatedEventMatchesV2SignatureWithVersion3() public {
        bytes32 appId = keccak256("event-app");
        bytes32 releaseKey = _keyFor(appId, ARTIST);
        vm.recordLogs();
        vm.prank(ARTIST);
        (address releaseAddress, address saleAddress,) = factory.createRelease(appId, releaseKey, "E", "E", "ipfs://e");
        VmV5.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = keccak256("ReleaseCreated(address,bytes32,address,address,address,address,uint256,uint16)");
        bool found;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != address(factory) || logs[i].topics[0] != topic) continue;
            (address primarySale, address provenanceAnchor, address implementation,, uint16 version) =
                abi.decode(logs[i].data, (address, address, address, uint256, uint16));
            require(address(uint160(uint256(logs[i].topics[1]))) == releaseAddress, "release topic");
            require(primarySale == saleAddress && provenanceAnchor == releaseAddress, "sale/anchor");
            require(implementation == factory.implementation() && version == 3, "implementation/version");
            found = true;
        }
        require(found, "ReleaseCreated not emitted");
    }

    // ---- atomic create + anchor ----

    function testCreateEditionRecordsProvenanceRootAtomically() public {
        vm.recordLogs();
        uint256 tokenId = _create(EDITION, 10, ROOT);
        VmV5.Log[] memory logs = vm.getRecordedLogs();

        require(release.provenanceRootOf(tokenId) == ROOT, "root stored");
        require(release.tokenIdForProvenanceRoot(ROOT) == tokenId, "root reverse lookup");
        require(release.isAnchored(key, EDITION, ROOT), "isAnchored");
        require(!release.isAnchored(key, EDITION, bytes32(uint256(1))), "other root not anchored");
        require(!release.isAnchored(key, bytes32("other"), ROOT), "other edition not anchored");

        bool created;
        bool anchored;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != address(release)) continue;
            if (logs[i].topics[0] == EDITION_CREATED_TOPIC) created = true;
            if (logs[i].topics[0] == ANCHORED_TOPIC) {
                require(created, "anchor emitted after EditionCreated");
                require(logs[i].topics[1] == ROOT && logs[i].topics[2] == key && logs[i].topics[3] == EDITION, "topics");
                (uint256 loggedToken, address artist, address releaseContract) = abi.decode(logs[i].data, (uint256, address, address));
                require(loggedToken == tokenId, "token");
                require(artist == ARTIST, "artist is attester of record");
                require(releaseContract == address(release), "release contract");
                anchored = true;
            }
        }
        require(created && anchored, "both events in one transaction");
    }

    function testCreateEditionWithMintEndRecordsRootAndDeadline() public {
        uint64 end = uint64(block.timestamp + 100);
        vm.prank(ARTIST);
        uint256 tokenId = release.createEditionWithMintEnd(key, EDITION, 0, "ipfs://e", ARTIST, 0, end, ROOT);
        require(release.isAnchored(key, EDITION, ROOT), "anchored");
        require(release.mintEndOf(tokenId) == end, "mint end");
        vm.warp(end + 1);
        vm.prank(sale);
        vm.expectRevert(abi.encodeWithSelector(VoidCollection1155.MintingEnded.selector, tokenId, end));
        release.mint(HOLDER, tokenId, 1, "");
    }

    function testNonArtistCannotCreateOrAnchor() public {
        bytes32 artistRole = release.ARTIST_ROLE();
        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(VoidCollection1155.AccessDenied.selector, artistRole, STRANGER));
        release.createEdition(key, EDITION, 10, "ipfs://e", STRANGER, 0, ROOT);

        // The dedicated sale is an issuer, never an edition creator.
        vm.prank(sale);
        vm.expectRevert(abi.encodeWithSelector(VoidCollection1155.AccessDenied.selector, artistRole, sale));
        release.createEdition(key, EDITION, 10, "ipfs://e", sale, 0, ROOT);

        // The platform (factory fee recipient) holds no role.
        vm.prank(PLATFORM);
        vm.expectRevert(abi.encodeWithSelector(VoidCollection1155.AccessDenied.selector, artistRole, PLATFORM));
        release.createEdition(key, EDITION, 10, "ipfs://e", PLATFORM, 0, ROOT);

        // Another artist's wallet cannot publish into this release.
        vm.prank(OTHER_ARTIST);
        vm.expectRevert(abi.encodeWithSelector(VoidCollection1155.AccessDenied.selector, artistRole, OTHER_ARTIST));
        release.createEdition(key, EDITION, 10, "ipfs://e", OTHER_ARTIST, 0, ROOT);

        require(!release.isAnchored(key, EDITION, ROOT), "nothing anchored");
        require(release.tokenIdForProvenanceRoot(ROOT) == 0, "nothing recorded");
    }

    function testZeroRootRejectedOnEveryPath() public {
        vm.prank(ARTIST);
        vm.expectRevert(VoidRelease1155V5.InvalidRoot.selector);
        release.createEdition(key, EDITION, 10, "ipfs://e", ARTIST, 0, bytes32(0));

        vm.prank(ARTIST);
        vm.expectRevert(VoidRelease1155V5.InvalidRoot.selector);
        release.createEditionWithMintEnd(key, EDITION, 10, "ipfs://e", ARTIST, 0, 0, bytes32(0));

        vm.prank(ARTIST);
        release.createAlbum(key);
        vm.prank(ARTIST);
        vm.expectRevert(VoidRelease1155V5.InvalidRoot.selector);
        release.createAlbumTrack(key, EDITION, 0, "ipfs://t", ARTIST, 0, false, 0, bytes32(0));
        require(release.albumTrackCount() == 0, "no track counted");
    }

    function testDuplicateRootRejected() public {
        _create(EDITION, 10, ROOT);
        vm.prank(ARTIST);
        vm.expectRevert(abi.encodeWithSelector(VoidRelease1155V5.AlreadyAnchored.selector, ROOT));
        release.createEdition(key, bytes32("second-edition"), 10, "ipfs://e2", ARTIST, 0, ROOT);

        // The same edition cannot be created twice, with the same or a different root.
        uint256 tokenId = release.tokenIdFor(key, EDITION);
        vm.prank(ARTIST);
        vm.expectRevert(abi.encodeWithSelector(VoidCollection1155.AlreadyInitialized.selector, tokenId));
        release.createEdition(key, EDITION, 10, "ipfs://e", ARTIST, 0, bytes32(uint256(2)));
        require(release.provenanceRootOf(tokenId) == ROOT, "original root kept");
    }

    function testRootLessEntryPointsAreDisabled() public {
        vm.prank(ARTIST);
        vm.expectRevert(VoidRelease1155V5.ProvenanceRootRequired.selector);
        release.createEdition(key, EDITION, 10, "ipfs://e", ARTIST, uint96(0));

        vm.prank(ARTIST);
        vm.expectRevert(VoidRelease1155V5.ProvenanceRootRequired.selector);
        release.createEdition(key, EDITION, 10, "ipfs://e");
    }

    function testOpenEditionAnchorsAndMintsWithoutCap() public {
        uint256 tokenId = _create(EDITION, 0, ROOT);
        require(release.maxSupplyOf(tokenId) == 0, "open edition");
        require(release.isAnchored(key, EDITION, ROOT), "anchored");
        vm.prank(sale);
        release.mint(HOLDER, tokenId, 1_000, "");
        require(release.balanceOf(HOLDER, tokenId) == 1_000, "open edition minted");
    }

    // ---- album path ----

    function testAlbumTrackRecordsRootAndKeepsAlbumRules() public {
        vm.prank(ARTIST);
        release.createAlbum(key);

        // Standalone creation is closed once the album exists.
        vm.prank(ARTIST);
        vm.expectRevert(VoidRelease1155V5.AlbumTrackPathRequired.selector);
        release.createEdition(key, EDITION, 10, "ipfs://e", ARTIST, 0, ROOT);
        vm.prank(ARTIST);
        vm.expectRevert(VoidRelease1155V5.AlbumTrackPathRequired.selector);
        release.createEditionWithMintEnd(key, EDITION, 10, "ipfs://e", ARTIST, 0, 0, ROOT);

        for (uint256 i = 0; i < 13; i++) {
            bytes32 editionId = keccak256(abi.encode("track", i));
            bytes32 root = keccak256(abi.encode("root", i));
            vm.prank(ARTIST);
            uint256 tokenId = release.createAlbumTrack(key, editionId, 0, "ipfs://t", ARTIST, 0, i < 4, 0, root);
            require(release.isAnchored(key, editionId, root), "track anchored");
            require(release.provenanceRootOf(tokenId) == root, "track root");
            require(release.isAlbumSingle(tokenId) == (i < 4), "single flag");
        }
        require(release.albumTrackCount() == 13 && release.albumSingleCount() == 4, "counts");

        vm.prank(ARTIST);
        vm.expectRevert(abi.encodeWithSelector(VoidRelease1155V5.AlbumTrackLimitReached.selector, 13));
        release.createAlbumTrack(key, bytes32("track-14"), 0, "ipfs://t", ARTIST, 0, false, 0, bytes32("root-14"));
    }

    function testAlbumSingleLimitAndExpandedApproval() public {
        vm.prank(ARTIST);
        release.createAlbum(key);
        for (uint256 i = 0; i < 4; i++) {
            vm.prank(ARTIST);
            release.createAlbumTrack(key, keccak256(abi.encode("s", i)), 0, "ipfs://s", ARTIST, 0, true, 0, keccak256(abi.encode("sr", i)));
        }
        vm.prank(ARTIST);
        vm.expectRevert(abi.encodeWithSelector(VoidRelease1155V5.AlbumSingleLimitReached.selector, 4));
        release.createAlbumTrack(key, bytes32("s-5"), 0, "ipfs://s", ARTIST, 0, true, 0, bytes32("sr-5"));

        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(VoidCollection1155.AccessDenied.selector, bytes32(0), STRANGER));
        release.approveExpandedRelease(key, 20, 6);
        vm.prank(ARTIST);
        release.approveExpandedRelease(key, 20, 6);
        vm.prank(ARTIST);
        release.createAlbumTrack(key, bytes32("s-5"), 0, "ipfs://s", ARTIST, 0, true, 0, bytes32("sr-5"));
        require(release.albumSingleCount() == 5, "expanded single");
    }

    function testAlbumCreateAndCloseRules() public {
        vm.prank(ARTIST);
        vm.expectRevert(VoidRelease1155V5.AlbumNotCreated.selector);
        release.createAlbumTrack(key, EDITION, 0, "ipfs://t", ARTIST, 0, false, 0, ROOT);

        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(VoidCollection1155.AccessDenied.selector, bytes32(0), STRANGER));
        release.createAlbum(key);

        vm.prank(ARTIST);
        release.createAlbum(key);
        vm.prank(ARTIST);
        vm.expectRevert(VoidRelease1155V5.AlbumAlreadyCreated.selector);
        release.createAlbum(key);

        vm.prank(ARTIST);
        uint256 tokenId = release.createAlbumTrack(key, EDITION, 0, "ipfs://t", ARTIST, 0, false, 0, ROOT);
        vm.prank(ARTIST);
        release.closeAlbum(key);
        vm.prank(ARTIST);
        vm.expectRevert(VoidRelease1155V5.AlbumAlreadyClosed.selector);
        release.createAlbumTrack(key, bytes32("late"), 0, "ipfs://late", ARTIST, 0, false, 0, bytes32("late-root"));
        vm.prank(ARTIST);
        vm.expectRevert(VoidRelease1155V5.AlbumAlreadyClosed.selector);
        release.closeAlbum(key);

        vm.prank(sale);
        release.mint(HOLDER, tokenId, 2, "");
        require(release.balanceOf(HOLDER, tokenId) == 2, "existing track still mintable");
    }

    function testAlbumTrackMintEndEnforcedAndPastEndRejected() public {
        vm.prank(ARTIST);
        release.createAlbum(key);
        vm.warp(1_000);
        vm.prank(ARTIST);
        vm.expectRevert(VoidRelease1155V5.InvalidMintEnd.selector);
        release.createAlbumTrack(key, EDITION, 0, "ipfs://t", ARTIST, 0, true, 999, ROOT);

        uint64 end = 1_100;
        vm.prank(ARTIST);
        uint256 tokenId = release.createAlbumTrack(key, EDITION, 0, "ipfs://t", ARTIST, 0, true, end, ROOT);
        vm.warp(end + 1);
        vm.prank(sale);
        vm.expectRevert(abi.encodeWithSelector(VoidCollection1155.MintingEnded.selector, tokenId, end));
        release.mint(HOLDER, tokenId, 1, "");
    }

    // ---- V4 invariants ----

    function testReleaseKeyMismatchRejected() public {
        bytes32 wrong = keccak256("wrong");
        vm.prank(ARTIST);
        vm.expectRevert(abi.encodeWithSelector(VoidRelease1155V5.ReleaseKeyMismatch.selector, key, wrong));
        release.createEdition(wrong, EDITION, 10, "ipfs://e", ARTIST, 0, ROOT);
    }

    function testRoyaltyCapEnforced() public {
        vm.prank(ARTIST);
        vm.expectRevert(abi.encodeWithSelector(VoidCollection1155.RoyaltyTooHigh.selector, uint96(1_001), uint96(1_000)));
        release.createEdition(key, EDITION, 10, "ipfs://e", ARTIST, 1_001, ROOT);
        require(release.tokenIdForProvenanceRoot(ROOT) == 0, "failed create records no root");
    }

    function testSaleIssuerSeparationAndNoOwnershipTransfer() public {
        require(!release.hasRole(release.ISSUER_ROLE(), ARTIST), "artist is not an issuer");
        require(release.hasRole(release.ISSUER_ROLE(), sale), "sale is the issuer");
        require(!release.hasRole(release.ARTIST_ROLE(), sale), "sale is not an artist");
        require(!release.hasRole(bytes32(0), PLATFORM) && !release.hasRole(release.ARTIST_ROLE(), PLATFORM), "platform has no role");
        require(!release.hasRole(release.ISSUER_ROLE(), PLATFORM), "platform is not an issuer");

        uint256 tokenId = _create(EDITION, 10, ROOT);
        bytes32 issuerRole = release.ISSUER_ROLE();
        vm.prank(ARTIST);
        vm.expectRevert(abi.encodeWithSelector(VoidCollection1155.AccessDenied.selector, issuerRole, ARTIST));
        release.mint(ARTIST, tokenId, 1, "");

        vm.prank(ARTIST);
        vm.expectRevert(VoidRelease1155V5.OwnershipTransferUnsupported.selector);
        release.transferOwnership(OTHER_ARTIST);

        vm.expectRevert(VoidRelease1155V5.DirectInitializationDisabled.selector);
        release.initialize(ARTIST, sale, "x", "x", "x");
    }

    function testPausedReleaseRejectsCreation() public {
        vm.prank(ARTIST);
        release.pause();
        vm.prank(ARTIST);
        vm.expectRevert(VoidCollection1155.ContractPaused.selector);
        release.createEdition(key, EDITION, 10, "ipfs://e", ARTIST, 0, ROOT);
    }

    function testCloneCannotBeReinitialized() public {
        vm.expectRevert(VoidCollection1155.NotFactory.selector);
        release.initializeRelease(STRANGER, STRANGER, key, "x", "x", "x");
    }

    function testIndependentReleasesKeepSeparateRoots() public {
        (VoidRelease1155V5 second,,, bytes32 secondKey) = _newRelease(keccak256("second-app"), OTHER_ARTIST);
        _create(EDITION, 10, ROOT);
        vm.prank(OTHER_ARTIST);
        second.createEdition(secondKey, EDITION, 10, "ipfs://e", OTHER_ARTIST, 0, ROOT);
        require(second.isAnchored(secondKey, EDITION, ROOT), "second release anchored");
        require(!second.isAnchored(key, EDITION, ROOT), "first key not anchored on second release");
        require(release.isAnchored(key, EDITION, ROOT), "first release anchored");
    }

    function testPrimarySaleAndMarketplaceV3WorkWithFactoryV3() public {
        ReleaseMarketplaceV3 market = new ReleaseMarketplaceV3(PLATFORM, 250, address(factory));
        uint256 tokenId = _create(EDITION, 3, ROOT);
        vm.prank(ARTIST);
        VoidPrimarySale(sale).configureSale(tokenId, 1 ether, 2, 2, 0, 0, false);
        vm.deal(HOLDER, 1 ether);
        vm.prank(HOLDER);
        VoidPrimarySale(sale).purchase{value: 1 ether}(tokenId, 1);
        require(release.balanceOf(HOLDER, tokenId) == 1, "primary purchase");

        vm.prank(HOLDER);
        release.setApprovalForAll(address(market), true);
        vm.prank(HOLDER);
        uint256 listingId = market.createListing(address(release), HOLDER, tokenId, 1, 1 ether, 0);
        require(uint8(market.listingStatus(listingId)) == uint8(ReleaseMarketplaceV3.Status.ACTIVE), "listed");
        require(release.isAnchored(key, EDITION, ROOT), "still anchored");
    }
}
