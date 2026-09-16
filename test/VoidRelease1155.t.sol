// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VoidRelease1155} from "../contracts/VoidRelease1155.sol";

interface Vm { function prank(address) external; }

contract Receiver {
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) { return this.onERC1155Received.selector; }
    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata) external pure returns (bytes4) { return this.onERC1155BatchReceived.selector; }
}

contract VoidRelease1155Test {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    VoidRelease1155 internal token;
    address internal artist = address(0xA11CE);
    address internal collector;
    address internal recipient = address(0x2345678901234567890123456789012345678901);
    uint256 internal id;

    function setUp() public {
        token = new VoidRelease1155(address(this));
        collector = address(0x1234567890123456789012345678901234567890);
        token.grantRole(token.ARTIST_ROLE(), artist);
        token.grantRole(token.ISSUER_ROLE(), artist);
        vm.prank(artist);
        token.createEdition(bytes32("release"), bytes32("edition"), 10, "ipfs://metadata");
        id = token.tokenIdFor(bytes32("release"), bytes32("edition"));
    }

    function testEditionAndMetadata() public view {
        require(bytes(token.uri(id)).length > 0);
        require(token.balanceOf(address(this), id) == 0);
        VoidRelease1155.Edition memory item = token.edition(id);
        require(item.releaseId == bytes32("release") && item.editionId == bytes32("edition"));
        require(item.artist == artist && item.maxSupply == 10 && item.mintedSupply == 0 && bytes(item.metadataUri).length > 0 && item.exists);
    }

    function testMintAndExactSupply() public {
        vm.prank(artist);
        token.mint(collector, id, 10, "");
        require(token.balanceOf(collector, id) == 10);
        vm.prank(artist);
        try token.mint(collector, id, 1, "") { revert(); } catch {}
    }

    function testUnauthorizedMintAndCreateFail() public {
        vm.prank(collector);
        try token.mint(collector, id, 1, "") { revert(); } catch {}
        vm.prank(collector);
        try token.createEdition(bytes32("r2"), bytes32("e2"), 1, "") { revert(); } catch {}
    }

    function testTransfersAndBatch() public {
        vm.prank(artist);
        token.mint(collector, id, 5, "");
        require(collector.code.length == 0);
        vm.prank(collector);
        token.safeTransferFrom(collector, recipient, id, 2, "");
        require(token.balanceOf(recipient, id) == 2 && token.balanceOf(collector, id) == 3);
        uint256[] memory ids = new uint256[](1); ids[0] = id;
        uint256[] memory amounts = new uint256[](1); amounts[0] = 1;
        vm.prank(collector);
        token.safeBatchTransferFrom(collector, recipient, ids, amounts, "");
        require(token.balanceOf(recipient, id) == 3);
    }

    function testPauseAndRoles() public {
        token.pause();
        vm.prank(artist);
        try token.mint(collector, id, 1, "") { revert(); } catch {}
        token.unpause();
        token.revokeRole(token.ARTIST_ROLE(), artist);
        vm.prank(artist);
        try token.createEdition(bytes32("r3"), bytes32("e3"), 1, "") { revert(); } catch {}
    }
}
