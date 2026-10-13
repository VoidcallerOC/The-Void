// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title RabbySigningProbe
/// @notice A disposable Fuji-only contract for testing the owner's browser signing path with the real
/// Rabby extension. It holds no funds, has no owner, no functions that change state and no relation
/// to any platform contract. Deploying it proves, on chain, that the page handed Rabby the exact
/// reviewed creation transaction and that the expected account signed it.
contract RabbySigningProbe {
    /// @notice The plan label the owner reviewed (for example "the-void:rabby-fuji-probe:v1").
    bytes32 public immutable label;
    /// @notice The account that signed the deployment.
    address public immutable creator;

    constructor(bytes32 label_) {
        label = label_;
        creator = msg.sender;
    }
}
