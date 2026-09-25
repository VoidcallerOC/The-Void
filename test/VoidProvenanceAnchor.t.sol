// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VoidProvenanceAnchor} from "../contracts/VoidProvenanceAnchor.sol";
import {VoidRelease1155} from "../contracts/VoidRelease1155.sol";

interface Vm {
    function prank(address) external;
    function recordLogs() external;
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }
    function getRecordedLogs() external view returns (Log[] memory);
}

contract VoidProvenanceAnchorTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    VoidRelease1155 internal token;
    VoidProvenanceAnchor internal anchor;
    address internal admin = address(this);
    address internal artist = address(0xA11CE);
    address internal stranger = address(0x57A);
    bytes32 internal releaseId = bytes32("release");
    bytes32 internal editionId = bytes32("edition");
    bytes32 internal root = bytes32(uint256(0xabc));
    uint256 internal id;

    function setUp() public {
        token = new VoidRelease1155(admin);
        vm.prank(admin);
        token.grantRole(token.ARTIST_ROLE(), artist);
        vm.prank(artist);
        id = token.createEdition(releaseId, editionId, 10, "ipfs://metadata");
        anchor = new VoidProvenanceAnchor(address(token));
    }

    function testArtistAnchorsCanonicalRootOnce() public {
        vm.recordLogs();
        vm.prank(artist);
        anchor.anchor(releaseId, editionId, root);
        require(anchor.isAnchored(releaseId, editionId, root));
        require(anchor.releaseContract() == address(token));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic0 = keccak256("ProvenanceAnchored(bytes32,bytes32,bytes32,uint256,address,address)");
        bool found;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(anchor) && logs[i].topics.length == 4 && logs[i].topics[0] == topic0) {
                require(logs[i].topics[1] == root && logs[i].topics[2] == releaseId && logs[i].topics[3] == editionId);
                found = true;
            }
        }
        require(found);
        vm.prank(artist);
        try anchor.anchor(releaseId, editionId, root) { revert(); } catch {}
        require(anchor.isAnchored(releaseId, editionId, root));
    }

    function testDifferentRootIsASeparateAnchor() public {
        vm.prank(artist);
        anchor.anchor(releaseId, editionId, root);
        bytes32 next = bytes32(uint256(0xdef));
        vm.prank(artist);
        anchor.anchor(releaseId, editionId, next);
        require(anchor.isAnchored(releaseId, editionId, root));
        require(anchor.isAnchored(releaseId, editionId, next));
    }

    function testStrangerArtistAndMissingEditionFailClosed() public {
        vm.prank(stranger);
        try anchor.anchor(releaseId, editionId, root) { revert(); } catch {}
        require(!anchor.isAnchored(releaseId, editionId, root));

        vm.prank(artist);
        try anchor.anchor(bytes32("missing"), editionId, root) { revert(); } catch {}
        require(!anchor.isAnchored(bytes32("missing"), editionId, root));

        vm.prank(artist);
        try anchor.anchor(releaseId, editionId, bytes32(0)) { revert(); } catch {}
        require(!anchor.isAnchored(releaseId, editionId, bytes32(0)));
    }
}
