// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VoidReleaseFactoryV2} from "../contracts/VoidReleaseFactoryV2.sol";
import {VoidRelease1155V4} from "../contracts/VoidRelease1155V4.sol";

interface VmV4Open {
    function prank(address) external;
}

contract WrongSelectorV4Receiver {
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) { return bytes4(0); }
    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata) external pure returns (bytes4) { return bytes4(0); }
}

contract VoidRelease1155V4OpenEditionTest {
    VmV4Open internal constant vm = VmV4Open(address(uint160(uint256(keccak256("hevm cheat code")))));
    address internal constant ARTIST = address(0xA11CE);
    address internal constant HOLDER = address(0xB0B);
    address internal constant PLATFORM = address(0xFEE);
    bytes32 internal constant APPLICATION_RELEASE_ID = keccak256("v4-open-application");

    VoidRelease1155V4 internal release;
    address internal issuer;
    bytes32 internal releaseKey;
    uint256 internal openId;

    function setUp() public {
        VoidReleaseFactoryV2 factory = new VoidReleaseFactoryV2(PLATFORM);
        releaseKey = keccak256(
            abi.encode("the-void:studio-release:v2", block.chainid, address(factory), APPLICATION_RELEASE_ID, ARTIST)
        );
        vm.prank(ARTIST);
        (address releaseAddress, address saleAddress,) = factory.createRelease(
            APPLICATION_RELEASE_ID, releaseKey, "Open", "OPEN", "ipfs://open"
        );
        release = VoidRelease1155V4(releaseAddress);
        issuer = saleAddress;
        vm.prank(ARTIST);
        openId = release.createEdition(releaseKey, keccak256("open"), 0, "ipfs://open", ARTIST, 0);
    }

    function testOpenEditionCreationAndMaxSupply() public view {
        require(release.maxSupplyOf(openId) == 0, "zero max supply not preserved");
        require(release.edition(openId).maxSupply == 0, "edition is not open");
    }

    function testOpenEditionMintsRepeatedlyAndTracksActualSupply() public {
        vm.prank(issuer);
        release.mint(HOLDER, openId, 1, "");
        vm.prank(issuer);
        release.mint(HOLDER, openId, 7, "");
        require(release.balanceOf(HOLDER, openId) == 8, "open balance mismatch");
        require(release.edition(openId).mintedSupply == 8, "actual minted supply not tracked");
    }

    function testOpenEditionBatchMintTracksActualSupply() public {
        uint256[] memory ids = new uint256[](2);
        uint256[] memory amounts = new uint256[](2);
        ids[0] = openId;
        ids[1] = openId;
        amounts[0] = 2;
        amounts[1] = 3;
        vm.prank(issuer);
        release.mintBatch(HOLDER, ids, amounts, "");
        require(release.balanceOf(HOLDER, openId) == 5, "batch balance mismatch");
        require(release.edition(openId).mintedSupply == 5, "batch minted supply mismatch");
    }

    function testFiniteEditionStillEnforcesCap() public {
        vm.prank(ARTIST);
        uint256 finiteId = release.createEdition(releaseKey, keccak256("finite"), 2, "ipfs://finite", ARTIST, 0);
        vm.prank(issuer);
        release.mint(HOLDER, finiteId, 2, "");
        vm.prank(issuer);
        try release.mint(HOLDER, finiteId, 1, "") { revert("finite cap bypassed"); } catch {}
        require(release.edition(finiteId).mintedSupply == 2, "finite accounting changed");
    }

    function testZeroQuantityUnknownTokenAndUnauthorizedMintStillRevert() public {
        vm.prank(issuer);
        try release.mint(HOLDER, openId, 0, "") { revert("zero quantity accepted"); } catch {}
        vm.prank(issuer);
        try release.mint(HOLDER, 999, 1, "") { revert("unknown token accepted"); } catch {}
        vm.prank(HOLDER);
        try release.mint(HOLDER, openId, 1, "") { revert("unauthorized mint accepted"); } catch {}
    }

    function testPauseStillBlocksOpenEditionMintAndCreate() public {
        vm.prank(ARTIST);
        release.pause();
        vm.prank(issuer);
        try release.mint(HOLDER, openId, 1, "") { revert("paused mint accepted"); } catch {}
        vm.prank(ARTIST);
        try release.createEdition(releaseKey, keccak256("paused"), 0, "ipfs://paused", ARTIST, 0) { revert("paused create accepted"); } catch {}
    }

    function testUnsafeRecipientStillRevertsAndRollsBackSupply() public {
        WrongSelectorV4Receiver receiver = new WrongSelectorV4Receiver();
        vm.prank(issuer);
        try release.mint(address(receiver), openId, 2, "") { revert("unsafe recipient accepted"); } catch {}
        require(release.edition(openId).mintedSupply == 0, "failed mint changed supply");
        require(release.balanceOf(address(receiver), openId) == 0, "failed mint changed balance");
    }
}
