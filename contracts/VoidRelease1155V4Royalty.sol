// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VoidRelease1155V4} from "./VoidRelease1155V4.sol";

/// @title The-Void release ERC-1155 with a contract-enforced artist royalty (mainnet)
/// @notice VoidRelease1155V4 in every respect except edition creation: each edition's ERC-2981
/// royalty is exactly 2.5% (250 bps), and it is paid to the edition's payout wallet, which must
/// hold ARTIST_ROLE on this release and may never be the platform fee recipient. The check sits
/// in _createEdition, the single function reached by every creation path (both createEdition
/// overloads, createEditionWithMintEnd and createAlbumTrack), so no entry point can bypass it.
/// The royalty and payout cannot change after creation (the base contract has no setter).
contract VoidRelease1155V4Royalty is VoidRelease1155V4 {
    uint96 public constant REQUIRED_ROYALTY_BPS = 250;
    /// @notice The platform fee recipient, which may never receive an artist royalty.
    address public immutable platformFeeRecipient;

    error RoyaltyPolicyViolation(uint96 royaltyBps, uint96 requiredBps);
    error UnauthorizedRoyaltyRecipient(address payout);

    /// @dev Deployed once by VoidReleaseFactoryV2Royalty; clones share this immutable.
    constructor(address platformFeeRecipient_) {
        if (platformFeeRecipient_ == address(0)) revert InvalidAddress();
        platformFeeRecipient = platformFeeRecipient_;
    }

    function _createEdition(bytes32 releaseId, bytes32 editionId, uint256 maxSupply, string calldata metadataUri, address payout, uint96 royaltyBps)
        internal override returns (uint256 tokenId)
    {
        if (royaltyBps != REQUIRED_ROYALTY_BPS) revert RoyaltyPolicyViolation(royaltyBps, REQUIRED_ROYALTY_BPS);
        if (payout == platformFeeRecipient || !_hasRole(ARTIST_ROLE, payout)) revert UnauthorizedRoyaltyRecipient(payout);
        return super._createEdition(releaseId, editionId, maxSupply, metadataUri, payout, royaltyBps);
    }
}
