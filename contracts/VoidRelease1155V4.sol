// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VoidCollection1155} from "./VoidCollection1155.sol";

/// @title The-Void release ERC-1155 (one clone per release)
/// @notice A release-specific successor to VoidCollection1155. Each EIP-1167 clone has
/// its own storage, roles, supply, balances, approvals and pause state. The initialized
/// releaseKey is immutable in practice and every edition must belong to that one release.
contract VoidRelease1155V4 is VoidCollection1155 {
    bytes32 public releaseKey;

    error ReleaseKeyRequired();
    error ReleaseKeyMismatch(bytes32 expected, bytes32 actual);
    error DirectInitializationDisabled();
    error OwnershipTransferUnsupported();

    event ReleaseInitialized(bytes32 indexed releaseKey, address indexed artist, address indexed issuer);

    /// @notice Direct initialization without a release key is disabled for release clones.
    /// @dev The factory must call initializeRelease exactly once instead.
    function initialize(address, address, string calldata, string calldata, string calldata) public pure override {
        revert DirectInitializationDisabled();
    }

    /// @notice Initializes one clone for exactly one release. The artist receives clone-local
    /// administration and edition-creation authority. Only the dedicated sale is an issuer.
    function initializeRelease(
        address artist,
        address issuer,
        bytes32 releaseKey_,
        string calldata name_,
        string calldata symbol_,
        string calldata contractURI_
    ) external {
        if (releaseKey_ == bytes32(0)) revert ReleaseKeyRequired();
        super.initialize(artist, issuer, name_, symbol_, contractURI_);
        releaseKey = releaseKey_;
        // The collection base grants the artist an issuer role for legacy collections. New
        // releases deliberately separate artist edition management from sale mint authority.
        _revokeRole(ISSUER_ROLE, artist);
        emit ReleaseInitialized(releaseKey_, artist, issuer);
    }

    /// @notice V4 editions retain their original artist identity permanently.
    /// @dev Ownership transfer would strand those editions' sale configuration, so fail closed.
    function transferOwnership(address) external pure override {
        revert OwnershipTransferUnsupported();
    }

    /// @notice Token IDs are edition-scoped inside a clone. Equal edition IDs intentionally
    /// produce equal token IDs in distinct release contracts; the contract address is part of
    /// the canonical asset identity.
    function tokenIdFor(bytes32, bytes32 editionId) public pure override returns (uint256) {
        uint256 tokenId = uint256(keccak256(abi.encode("the-void:release-edition:v1", editionId)));
        return tokenId == 0 ? 1 : tokenId;
    }

    function createEdition(bytes32 releaseId, bytes32 editionId, uint256 maxSupply, string calldata metadataUri)
        public override returns (uint256 tokenId)
    {
        _assertReleaseKey(releaseId);
        return super.createEdition(releaseId, editionId, maxSupply, metadataUri);
    }

    function createEdition(
        bytes32 releaseId,
        bytes32 editionId,
        uint256 maxSupply,
        string calldata metadataUri,
        address payout,
        uint96 royaltyBps
    ) public override returns (uint256 tokenId) {
        _assertReleaseKey(releaseId);
        return super.createEdition(releaseId, editionId, maxSupply, metadataUri, payout, royaltyBps);
    }

    function _assertReleaseKey(bytes32 supplied) private view {
        if (supplied != releaseKey) revert ReleaseKeyMismatch(releaseKey, supplied);
    }
}
