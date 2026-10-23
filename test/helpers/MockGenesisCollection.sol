// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface VmEtchGenesis {
    function etch(address target, bytes calldata code) external;
}

/// @notice Local stand-in for the Genesis collection (ERC-1155 balances only), etched at the real C-Chain
/// address so GenesisHolderClaim's on-chain holder check runs on the local EVM with chain id 43114. Fork
/// tests use the real collection instead. Test-only; never deployed.
contract MockGenesisCollection {
    mapping(address => mapping(uint256 => uint256)) public balanceOf;
    /// @notice When set, every account also holds one unit of token 0 (for suites that do not test eligibility).
    bool public everyoneHolds;
    bool public reverting;

    function setBalance(address account, uint256 id, uint256 amount) external {
        balanceOf[account][id] = amount;
    }

    function setEveryoneHolds(bool value) external {
        everyoneHolds = value;
    }

    function setReverting(bool value) external {
        reverting = value;
    }

    function balanceOfBatch(address[] calldata accounts, uint256[] calldata ids) external view returns (uint256[] memory out) {
        require(!reverting, "genesis unavailable");
        require(accounts.length == ids.length, "length mismatch");
        out = new uint256[](accounts.length);
        for (uint256 i; i < accounts.length; ++i) {
            out[i] = balanceOf[accounts[i]][ids[i]] + (everyoneHolds && ids[i] == 0 ? 1 : 0);
        }
    }
}

address constant GENESIS_COLLECTION_ADDRESS = 0xD1B4367dd9f235f9ee61878019d66E31511E98eE;

/// @notice Etches the stand-in at the Genesis address and returns it.
function installGenesisStandIn(bool everyoneHolds) returns (MockGenesisCollection genesis) {
    MockGenesisCollection implementation = new MockGenesisCollection();
    VmEtchGenesis(address(uint160(uint256(keccak256("hevm cheat code"))))).etch(GENESIS_COLLECTION_ADDRESS, address(implementation).code);
    genesis = MockGenesisCollection(GENESIS_COLLECTION_ADDRESS);
    genesis.setEveryoneHolds(everyoneHolds);
}
