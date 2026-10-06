// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VoidReleaseFactoryV2} from "../contracts/VoidReleaseFactoryV2.sol";
import {VoidRelease1155V4} from "../contracts/VoidRelease1155V4.sol";

interface VmAlbum {
    function prank(address) external;
    function warp(uint256) external;
}

contract VoidRelease1155V4AlbumTest {
    VmAlbum internal constant vm = VmAlbum(address(uint160(uint256(keccak256("hevm cheat code")))));
    address internal constant ARTIST = address(0xA11CE);
    address internal constant HOLDER = address(0xB0B);
    address internal constant PLATFORM = address(0xFEE);
    bytes32 internal constant APPLICATION_RELEASE_ID = keccak256("v4-album-application");

    VoidRelease1155V4 internal release;
    address internal issuer;
    bytes32 internal releaseKey;

    function setUp() public {
        VoidReleaseFactoryV2 factory = new VoidReleaseFactoryV2(PLATFORM);
        releaseKey = keccak256(abi.encode(
            "the-void:studio-release:v2", block.chainid, address(factory), APPLICATION_RELEASE_ID, ARTIST
        ));
        vm.prank(ARTIST);
        (address releaseAddress, address saleAddress,) = factory.createRelease(
            APPLICATION_RELEASE_ID, releaseKey, "Album", "ALBUM", "ipfs://album"
        );
        release = VoidRelease1155V4(releaseAddress);
        issuer = saleAddress;
    }

    function _createAlbum() internal {
        vm.prank(ARTIST);
        release.createAlbum(releaseKey);
    }

    function _track(uint256 index, bool single, uint64 mintEnd) internal returns (uint256 tokenId) {
        vm.prank(ARTIST);
        tokenId = release.createAlbumTrack(
            releaseKey,
            keccak256(abi.encode("track", index)),
            0,
            string.concat("ipfs://track/", _uintToString(index)),
            ARTIST,
            0,
            single,
            mintEnd
        );
    }

    function testAlbumAllowsThirteenTracksAndFourSingles() public {
        _createAlbum();
        for (uint256 i = 0; i < 13; i++) _track(i, i < 4, 0);
        require(release.albumTrackCount() == 13, "track count mismatch");
        require(release.albumSingleCount() == 4, "single count mismatch");
        require(release.isAlbumSingle(release.tokenIdFor(releaseKey, keccak256(abi.encode("track", 3)))), "single not recorded");
    }

    function testAlbumRejectsFourteenthTrackAndFifthSingle() public {
        _createAlbum();
        for (uint256 i = 0; i < 13; i++) _track(i, i < 4, 0);
        vm.prank(ARTIST);
        try release.createAlbumTrack(releaseKey, keccak256("track-13"), 0, "ipfs://14", ARTIST, 0, false, 0) {
            revert("fourteenth track accepted");
        } catch {}

        VoidRelease1155V4 second = _newRelease();
        vm.prank(ARTIST);
        second.createAlbum(releaseKeyFor(second));
        for (uint256 i = 0; i < 4; i++) {
            vm.prank(ARTIST);
            second.createAlbumTrack(releaseKeyFor(second), keccak256(abi.encode("single", i)), 0, "ipfs://single", ARTIST, 0, true, 0);
        }
        vm.prank(ARTIST);
        try second.createAlbumTrack(releaseKeyFor(second), keccak256("single-5"), 0, "ipfs://single-5", ARTIST, 0, true, 0) {
            revert("fifth single accepted");
        } catch {}
    }

    function testExpandedReleaseRequiresExplicitAdminApproval() public {
        _createAlbum();
        vm.prank(HOLDER);
        try release.approveExpandedRelease(releaseKey, 20, 6) { revert("unauthorized approval accepted"); } catch {}
        vm.prank(ARTIST);
        release.approveExpandedRelease(releaseKey, 20, 6);
        for (uint256 i = 0; i < 14; i++) _track(i, i < 5, 0);
        require(release.albumTrackCount() == 14, "expanded track count mismatch");
        require(release.albumSingleCount() == 5, "expanded single count mismatch");
    }

    function testAlbumClosureStopsNewTracksButExistingTracksRemainMintable() public {
        _createAlbum();
        uint256 tokenId = _track(0, false, 0);
        vm.prank(ARTIST);
        release.closeAlbum(releaseKey);
        require(release.albumClosed(), "album not closed");
        vm.prank(ARTIST);
        try release.createAlbumTrack(releaseKey, keccak256("late"), 0, "ipfs://late", ARTIST, 0, false, 0) {
            revert("track accepted after close");
        } catch {}
        vm.prank(issuer);
        release.mint(HOLDER, tokenId, 2, "");
        require(release.balanceOf(HOLDER, tokenId) == 2, "existing track stopped unexpectedly");
    }

    function testAlbumActivationDisablesStandaloneEditionBypass() public {
        _createAlbum();
        vm.prank(ARTIST);
        try release.createEdition(releaseKey, keccak256("bypass"), 0, "ipfs://bypass", ARTIST, 0) {
            revert("standalone bypass accepted");
        } catch {}
    }

    function testSingleMintEndIsEnforcedByReleaseForSaleAndIssuer() public {
        _createAlbum();
        uint64 end = uint64(block.timestamp + 100);
        uint256 tokenId = _track(0, true, end);
        vm.warp(end + 1);
        vm.prank(issuer);
        try release.mint(HOLDER, tokenId, 1, "") { revert("expired single minted"); } catch {}
        require(release.mintEndOf(tokenId) == end, "mint end not stored");
    }

    function testStandaloneEditionCanOptIntoMintEndWithoutAlbum() public {
        uint64 end = uint64(block.timestamp + 100);
        vm.prank(ARTIST);
        uint256 tokenId = release.createEditionWithMintEnd(releaseKey, keccak256("standalone"), 0, "ipfs://standalone", ARTIST, 0, end);
        vm.warp(end + 1);
        vm.prank(issuer);
        try release.mint(HOLDER, tokenId, 1, "") { revert("expired standalone minted"); } catch {}
    }

    function _newRelease() internal returns (VoidRelease1155V4 next) {
        VoidReleaseFactoryV2 factory = new VoidReleaseFactoryV2(PLATFORM);
        bytes32 applicationId = keccak256(abi.encode("second", address(this)));
        bytes32 key = keccak256(abi.encode("the-void:studio-release:v2", block.chainid, address(factory), applicationId, ARTIST));
        vm.prank(ARTIST);
        (address releaseAddress,,) = factory.createRelease(applicationId, key, "Second", "SECOND", "ipfs://second");
        next = VoidRelease1155V4(releaseAddress);
        _secondKey = key;
    }

    bytes32 private _secondKey;
    function releaseKeyFor(VoidRelease1155V4 target) internal view returns (bytes32) {
        if (address(target) == address(release)) return releaseKey;
        return _secondKey;
    }

    function _uintToString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 digits;
        uint256 copy = value;
        while (copy != 0) { digits++; copy /= 10; }
        bytes memory buffer = new bytes(digits);
        while (value != 0) { buffer[--digits] = bytes1(uint8(48 + value % 10)); value /= 10; }
        return string(buffer);
    }
}
