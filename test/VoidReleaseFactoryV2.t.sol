// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VoidReleaseFactoryV2} from "../contracts/VoidReleaseFactoryV2.sol";
import {VoidRelease1155V4} from "../contracts/VoidRelease1155V4.sol";
import {VoidPrimarySale} from "../contracts/VoidPrimarySale.sol";
import {VoidProvenanceAnchor} from "../contracts/VoidProvenanceAnchor.sol";

interface VmFactoryV2 {
    function prank(address) external;
    function deal(address, uint256) external;
}

contract VoidReleaseFactoryV2Test {
    VmFactoryV2 internal constant vm = VmFactoryV2(address(uint160(uint256(keccak256("hevm cheat code")))));
    address internal constant PLATFORM = address(0xFEE);
    address internal constant ARTIST_A = address(0xA11CE);
    address internal constant ARTIST_B = address(0xB0B);
    bytes32 internal constant KEY_A1 = keccak256("application-release-a1");
    bytes32 internal constant KEY_A2 = keccak256("application-release-a2");
    bytes32 internal constant KEY_B1 = keccak256("application-release-b1");

    function testArtistsDirectlyCreateTheirOwnIsolatedReleases() public {
        VoidReleaseFactoryV2 factory = new VoidReleaseFactoryV2(PLATFORM);
        vm.deal(ARTIST_A, 1 ether);
        vm.deal(ARTIST_B, 1 ether);

        vm.prank(ARTIST_A);
        (address releaseA1, address saleA1, address anchorA1) = factory.createRelease(KEY_A1, "A1", "A1", "ipfs://a1");
        vm.prank(ARTIST_A);
        (address releaseA2, address saleA2, address anchorA2) = factory.createRelease(KEY_A2, "A2", "A2", "ipfs://a2");
        vm.prank(ARTIST_B);
        (address releaseB1, address saleB1, address anchorB1) = factory.createRelease(KEY_B1, "B1", "B1", "ipfs://b1");

        require(releaseA1 != releaseA2 && releaseA1 != releaseB1 && releaseA2 != releaseB1, "release clones must be distinct");
        require(saleA1 != saleA2 && saleA1 != saleB1 && saleA2 != saleB1, "sales must be distinct");
        require(anchorA1 != anchorA2 && anchorA1 != anchorB1 && anchorA2 != anchorB1, "anchors must be distinct");
        require(factory.isRelease(releaseA1) && factory.isRelease(releaseA2) && factory.isRelease(releaseB1), "all clones registered");
        require(factory.artistOf(releaseA1) == ARTIST_A && factory.artistOf(releaseA2) == ARTIST_A, "artist A registry");
        require(factory.artistOf(releaseB1) == ARTIST_B, "artist B registry");
        require(factory.platformRecipient() == PLATFORM, "existing permanent treasury preserved");
        require(factory.releaseContractOf(KEY_A1) == releaseA1 && factory.releaseContractOf(KEY_A2) == releaseA2, "A key registry");
        require(factory.releaseContractOf(KEY_B1) == releaseB1, "B key registry");

        VoidRelease1155V4 a1 = VoidRelease1155V4(releaseA1);
        VoidRelease1155V4 a2 = VoidRelease1155V4(releaseA2);
        VoidRelease1155V4 b1 = VoidRelease1155V4(releaseB1);
        require(a1.owner() == ARTIST_A && a2.owner() == ARTIST_A && b1.owner() == ARTIST_B, "clone owner must be artist");
        require(a1.releaseKey() == KEY_A1 && a2.releaseKey() == KEY_A2 && b1.releaseKey() == KEY_B1, "clone keys");
        require(keccak256(bytes(a1.name())) == keccak256(bytes("A1")), "exact name");
        require(keccak256(bytes(a1.symbol())) == keccak256(bytes("A1")), "exact symbol");
        require(keccak256(bytes(a1.contractURI())) == keccak256(bytes("ipfs://a1")), "exact contract URI");
        require(VoidPrimarySale(saleA1).owner() == address(factory), "fee control sealed in ownerless factory");
        require(address(VoidPrimarySale(saleA1).releases()) == releaseA1, "sale bound to exact release");
        require(VoidPrimarySale(saleA1).platformRecipient() == PLATFORM, "primary fee uses permanent treasury");
        require(VoidPrimarySale(saleA1).platformFeeBps() == 250 && VoidPrimarySale(saleA1).platformFeeCapBps() == 250, "primary fee locked at 2.5 percent");
        vm.prank(ARTIST_A);
        (bool feeChange,) = saleA1.call(abi.encodeWithSignature("setPlatformFeeBps(uint256)", 0));
        require(!feeChange, "artist cannot change locked platform fee");
        require(VoidProvenanceAnchor(anchorA1).releaseContract() == releaseA1, "anchor bound to exact release");
        require(factory.PLATFORM_FEE_BPS() == 250, "primary platform fee must be 2.5 percent");
    }

    function testDuplicateKeyCannotCreateSecondRelease() public {
        VoidReleaseFactoryV2 factory = new VoidReleaseFactoryV2(PLATFORM);
        vm.prank(ARTIST_A);
        (address first,,) = factory.createRelease(KEY_A1, "A1", "A1", "uri");
        vm.prank(ARTIST_B);
        (bool success,) = address(factory).call(abi.encodeWithSelector(factory.createRelease.selector, KEY_A1, "B1", "B1", "uri"));
        require(!success, "duplicate release key must revert");
        require(factory.releaseContractOf(KEY_A1) == first && factory.releaseCount() == 1, "duplicate did not mutate registry");
    }

    function testOwnershipTransferFailsClosed() public {
        VoidReleaseFactoryV2 factory = new VoidReleaseFactoryV2(PLATFORM);
        vm.prank(ARTIST_A);
        (address created,,) = factory.createRelease(KEY_A1, "A1", "A1", "uri");
        vm.prank(ARTIST_A);
        (bool success,) = created.call(abi.encodeWithSignature("transferOwnership(address)", ARTIST_B));
        require(!success, "release ownership transfer must be disabled");
        require(VoidRelease1155V4(created).owner() == ARTIST_A, "owner unchanged");
    }

    function testFactoryHasNoOwnerOperatorOrPrivilegedCreationEntryPoint() public {
        VoidReleaseFactoryV2 factory = new VoidReleaseFactoryV2(PLATFORM);
        (bool success,) = address(factory).staticcall(abi.encodeWithSignature("owner()"));
        require(!success, "V2 factory must have no owner bypass");
        (success,) = address(factory).staticcall(abi.encodeWithSignature("createRelease(address,bytes32,string,string,string)", ARTIST_A, KEY_A1, "A", "A", "uri"));
        require(!success, "owner-style release creation must not exist");
    }
}
