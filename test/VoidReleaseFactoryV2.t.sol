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
    struct ReleaseBundle {
        address releaseContract;
        address sale;
        address anchor;
        bytes32 key;
    }

    VmFactoryV2 internal constant vm = VmFactoryV2(address(uint160(uint256(keccak256("hevm cheat code")))));
    address internal constant PLATFORM = address(0xFEE);
    address internal constant ARTIST_A = address(0xA11CE);
    address internal constant ARTIST_B = address(0xB0B);
    bytes32 internal constant APP_A1 = keccak256("application-release-a1");
    bytes32 internal constant APP_A2 = keccak256("application-release-a2");
    bytes32 internal constant APP_B1 = keccak256("application-release-b1");

    function releaseKey(VoidReleaseFactoryV2 factory, bytes32 applicationReleaseId, address artist) internal view returns (bytes32) {
        return keccak256(abi.encode("the-void:studio-release:v2", block.chainid, address(factory), applicationReleaseId, artist));
    }

    function createRelease(VoidReleaseFactoryV2 factory, bytes32 applicationReleaseId, address artist, string memory name, string memory symbol, string memory contractURI) internal returns (ReleaseBundle memory bundle) {
        bundle.key = releaseKey(factory, applicationReleaseId, artist);
        vm.prank(artist);
        (bundle.releaseContract, bundle.sale, bundle.anchor) = factory.createRelease(applicationReleaseId, bundle.key, name, symbol, contractURI);
    }

    function testArtistsDirectlyCreateTheirOwnIsolatedReleases() public {
        VoidReleaseFactoryV2 factory = new VoidReleaseFactoryV2(PLATFORM);
        vm.deal(ARTIST_A, 1 ether);
        vm.deal(ARTIST_B, 1 ether);

        ReleaseBundle memory a1 = createRelease(factory, APP_A1, ARTIST_A, "A1", "A1", "ipfs://a1");
        ReleaseBundle memory a2 = createRelease(factory, APP_A2, ARTIST_A, "A2", "A2", "ipfs://a2");
        ReleaseBundle memory b1 = createRelease(factory, APP_B1, ARTIST_B, "B1", "B1", "ipfs://b1");

        require(a1.releaseContract != a2.releaseContract && a1.releaseContract != b1.releaseContract && a2.releaseContract != b1.releaseContract, "release clones must be distinct");
        require(a1.sale != a2.sale && a1.sale != b1.sale && a2.sale != b1.sale, "sales must be distinct");
        require(a1.anchor != a2.anchor && a1.anchor != b1.anchor && a2.anchor != b1.anchor, "anchors must be distinct");
        require(factory.isRelease(a1.releaseContract) && factory.isRelease(a2.releaseContract) && factory.isRelease(b1.releaseContract), "all clones registered");
        require(factory.artistOf(a1.releaseContract) == ARTIST_A && factory.artistOf(a2.releaseContract) == ARTIST_A, "artist A registry");
        require(factory.artistOf(b1.releaseContract) == ARTIST_B, "artist B registry");
        require(factory.platformRecipient() == PLATFORM, "existing permanent treasury preserved");
        require(factory.releaseContractOf(a1.key) == a1.releaseContract && factory.releaseContractOf(a2.key) == a2.releaseContract, "A key registry");
        require(factory.releaseContractOf(b1.key) == b1.releaseContract, "B key registry");

        VoidRelease1155V4 a1Contract = VoidRelease1155V4(a1.releaseContract);
        VoidRelease1155V4 a2Contract = VoidRelease1155V4(a2.releaseContract);
        VoidRelease1155V4 b1Contract = VoidRelease1155V4(b1.releaseContract);
        require(a1Contract.owner() == ARTIST_A && a2Contract.owner() == ARTIST_A && b1Contract.owner() == ARTIST_B, "clone owner must be artist");
        require(a1Contract.releaseKey() == a1.key && a2Contract.releaseKey() == a2.key && b1Contract.releaseKey() == b1.key, "clone keys");
        require(keccak256(bytes(a1Contract.name())) == keccak256(bytes("A1")), "exact name");
        require(keccak256(bytes(a1Contract.symbol())) == keccak256(bytes("A1")), "exact symbol");
        require(keccak256(bytes(a1Contract.contractURI())) == keccak256(bytes("ipfs://a1")), "exact contract URI");
        require(VoidPrimarySale(a1.sale).owner() == address(factory), "fee control sealed in ownerless factory");
        require(address(VoidPrimarySale(a1.sale).releases()) == a1.releaseContract, "sale bound to exact release");
        require(VoidPrimarySale(a1.sale).platformRecipient() == PLATFORM, "primary fee uses permanent treasury");
        require(VoidPrimarySale(a1.sale).platformFeeBps() == 250 && VoidPrimarySale(a1.sale).platformFeeCapBps() == 250, "primary fee locked at 2.5 percent");
        vm.prank(ARTIST_A);
        (bool feeChange,) = a1.sale.call(abi.encodeWithSignature("setPlatformFeeBps(uint256)", 0));
        require(!feeChange, "artist cannot change locked platform fee");
        require(VoidProvenanceAnchor(a1.anchor).releaseContract() == a1.releaseContract, "anchor bound to exact release");
        require(factory.PLATFORM_FEE_BPS() == 250, "primary platform fee must be 2.5 percent");
    }

    function testDuplicateKeyCannotCreateSecondRelease() public {
        VoidReleaseFactoryV2 factory = new VoidReleaseFactoryV2(PLATFORM);
        vm.prank(ARTIST_A);
        bytes32 keyA1 = releaseKey(factory, APP_A1, ARTIST_A);
        (address first,,) = factory.createRelease(APP_A1, keyA1, "A1", "A1", "uri");
        vm.prank(ARTIST_B);
        (bool success,) = address(factory).call(abi.encodeWithSelector(factory.createRelease.selector, APP_A1, keyA1, "B1", "B1", "uri"));
        require(!success, "duplicate release key must revert");
        require(factory.releaseContractOf(keyA1) == first && factory.releaseCount() == 1, "duplicate did not mutate registry");
    }

    function testOwnershipTransferFailsClosed() public {
        VoidReleaseFactoryV2 factory = new VoidReleaseFactoryV2(PLATFORM);
        vm.prank(ARTIST_A);
        bytes32 keyA1 = releaseKey(factory, APP_A1, ARTIST_A);
        (address created,,) = factory.createRelease(APP_A1, keyA1, "A1", "A1", "uri");
        vm.prank(ARTIST_A);
        (bool success,) = created.call(abi.encodeWithSignature("transferOwnership(address)", ARTIST_B));
        require(!success, "release ownership transfer must be disabled");
        require(VoidRelease1155V4(created).owner() == ARTIST_A, "owner unchanged");
    }

    function testFactoryHasNoOwnerOperatorOrPrivilegedCreationEntryPoint() public {
        VoidReleaseFactoryV2 factory = new VoidReleaseFactoryV2(PLATFORM);
        (bool success,) = address(factory).staticcall(abi.encodeWithSignature("owner()"));
        require(!success, "V2 factory must have no owner bypass");
        (success,) = address(factory).staticcall(abi.encodeWithSignature("createRelease(bytes32,bytes32,string,string,string)", APP_A1, bytes32(uint256(1)), "A", "A", "uri"));
        require(!success, "owner-style release creation must not exist");
    }
}
