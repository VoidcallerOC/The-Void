// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RabbySigningProbe} from "../contracts/RabbySigningProbe.sol";

interface VmProbe {
    function prank(address) external;
    function deal(address, uint256) external;
}

/// @notice The Fuji Rabby test contract: records its label and creator, holds no value, has no functions that change state.
contract RabbySigningProbeTest {
    VmProbe constant vm = VmProbe(address(uint160(uint256(keccak256("hevm cheat code")))));
    bytes32 constant LABEL = keccak256("the-void/fuji-rabby-probe/1");
    address constant CREATOR = address(0xC0FFEE);

    function _deploy() internal returns (RabbySigningProbe probe) {
        vm.prank(CREATOR);
        probe = new RabbySigningProbe(LABEL);
    }

    function test_recordsLabelAndCreator() public {
        RabbySigningProbe probe = _deploy();
        require(probe.label() == LABEL, "label");
        require(probe.creator() == CREATOR, "creator");
        require(address(probe).balance == 0, "balance");
    }

    function test_refusesValue() public {
        RabbySigningProbe probe = _deploy();
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(probe).call{value: 1}("");
        require(!ok, "accepted value");
        (ok,) = address(probe).call{value: 1}(hex"deadbeef");
        require(!ok, "accepted value via fallback");
        require(address(probe).balance == 0, "balance");
    }
}
