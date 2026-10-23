// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VoidCollection1155} from "./VoidCollection1155.sol";

/// @title The-Void release ERC-1155 with sequential token IDs (one clone per release, mainnet royalty lock)
/// @notice VoidRelease1155V4 in every respect except token identity, plus the VoidRelease1155V4Royalty
/// royalty rule:
/// - Token IDs are 1, 2, 3, ... in creation order, counted separately in every release contract. The
///   caller names the next ID as the edition ID (`bytes32(uint256(n))`) and the contract refuses any
///   other value, so a creation transaction either creates exactly that token or reverts and consumes
///   nothing. The contract address is part of the asset identity: token 1 here is not token 1 elsewhere.
/// - Every edition's ERC-2981 royalty is exactly 2.5% (250 bps), paid to a payout wallet that holds
///   ARTIST_ROLE on this release and is never the platform fee recipient.
/// Both rules sit in _createEdition, the single function reached by every creation path (both
/// createEdition overloads, createEditionWithMintEnd and createAlbumTrack), so no entry point bypasses them.
/// A token's human-readable name is its metadata `name`, fixed at creation together with its metadata URI.
/// @dev Deployed once by VoidReleaseFactoryV4Sequential; clones share the immutables.
contract VoidRelease1155V6Sequential is VoidCollection1155 {
    uint16 public constant IMPLEMENTATION_VERSION = 6;
    uint96 public constant REQUIRED_ROYALTY_BPS = 250;
    /// @notice The platform fee recipient, which may never receive an artist royalty.
    address public immutable platformFeeRecipient;

    bytes32 public releaseKey;

    uint256 public constant DEFAULT_ALBUM_MAX_TRACKS = 13;
    uint256 public constant DEFAULT_ALBUM_MAX_SINGLES = 4;
    bool public albumCreated;
    bool public albumClosed;
    bool public expandedReleaseApproved;
    uint256 public approvedMaxTracks;
    uint256 public approvedMaxSingles;
    uint256 public albumTrackCount;
    uint256 public albumSingleCount;
    mapping(uint256 => bool) public isAlbumSingle;
    /// @notice The highest token ID created on this release contract; 0 before the first edition.
    uint256 public lastTokenId;

    error ReleaseKeyRequired();
    error ReleaseKeyMismatch(bytes32 expected, bytes32 actual);
    error DirectInitializationDisabled();
    error OwnershipTransferUnsupported();
    error AlbumAlreadyCreated();
    error AlbumNotCreated();
    error AlbumAlreadyClosed();
    error AlbumTrackLimitReached(uint256 limit);
    error AlbumSingleLimitReached(uint256 limit);
    error AlbumTrackPathRequired();
    error InvalidExpandedLimits();
    error InvalidMintEnd();
    error NonSequentialTokenId(uint256 expected, uint256 supplied);
    error RoyaltyPolicyViolation(uint96 royaltyBps, uint96 requiredBps);
    error UnauthorizedRoyaltyRecipient(address payout);

    event ReleaseInitialized(bytes32 indexed releaseKey, address indexed artist, address indexed issuer);
    event ExpandedReleaseApproved(uint256 maxTracks, uint256 maxSingles);
    event AlbumCreated(bytes32 indexed releaseKey);
    event AlbumTrackCreated(uint256 indexed tokenId, bool indexed single, uint64 mintEnd);
    event AlbumClosed(bytes32 indexed releaseKey);

    constructor(address platformFeeRecipient_) {
        if (platformFeeRecipient_ == address(0)) revert InvalidAddress();
        platformFeeRecipient = platformFeeRecipient_;
    }

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

    /// @notice Editions retain their original artist identity permanently.
    /// @dev Ownership transfer would strand those editions' sale configuration, so fail closed.
    function transferOwnership(address) external pure override {
        revert OwnershipTransferUnsupported();
    }

    /// @notice The token ID the next edition of this release contract must use.
    function nextTokenId() external view returns (uint256) {
        return lastTokenId + 1;
    }

    /// @notice An edition ID is its sequential token ID written as bytes32. Only `nextTokenId()` can be
    /// created; any other edition ID reverts in _createEdition.
    function tokenIdFor(bytes32, bytes32 editionId) public pure override returns (uint256) {
        return uint256(editionId);
    }

    function createEdition(bytes32 releaseId, bytes32 editionId, uint256 maxSupply, string calldata metadataUri)
        public override returns (uint256 tokenId)
    {
        _assertReleaseKey(releaseId);
        if (albumCreated) revert AlbumTrackPathRequired();
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
        if (albumCreated) revert AlbumTrackPathRequired();
        return super.createEdition(releaseId, editionId, maxSupply, metadataUri, payout, royaltyBps);
    }

    /// @notice Creates an ordinary standalone edition with an optional mint deadline.
    function createEditionWithMintEnd(
        bytes32 releaseId,
        bytes32 editionId,
        uint256 maxSupply,
        string calldata metadataUri,
        address payout,
        uint96 royaltyBps,
        uint64 mintEnd
    ) external returns (uint256 tokenId) {
        _assertReleaseKey(releaseId);
        if (albumCreated) revert AlbumTrackPathRequired();
        _assertValidMintEnd(mintEnd);
        tokenId = super.createEdition(releaseId, editionId, maxSupply, metadataUri, payout, royaltyBps);
        _setMintEnd(tokenId, mintEnd);
    }

    /// @notice Explicitly opts this release contract into album semantics.
    /// The artist/admin must call this separately from creating tracks.
    function createAlbum(bytes32 releaseId) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _assertReleaseKey(releaseId);
        if (albumCreated) revert AlbumAlreadyCreated();
        albumCreated = true;
        emit AlbumCreated(releaseId);
    }

    /// @notice Explicit administrative approval for limits beyond the normal album policy.
    function approveExpandedRelease(bytes32 releaseId, uint256 maxTracks, uint256 maxSingles)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        _assertReleaseKey(releaseId);
        if (!albumCreated || albumClosed || maxTracks < DEFAULT_ALBUM_MAX_TRACKS || maxSingles < DEFAULT_ALBUM_MAX_SINGLES) {
            revert InvalidExpandedLimits();
        }
        if (maxTracks < albumTrackCount || maxSingles < albumSingleCount) revert InvalidExpandedLimits();
        expandedReleaseApproved = true;
        approvedMaxTracks = maxTracks;
        approvedMaxSingles = maxSingles;
        emit ExpandedReleaseApproved(maxTracks, maxSingles);
    }

    /// @notice Adds one album track. Tracks and singles share this release contract and its numbering.
    function createAlbumTrack(
        bytes32 releaseId,
        bytes32 editionId,
        uint256 maxSupply,
        string calldata metadataUri,
        address payout,
        uint96 royaltyBps,
        bool single,
        uint64 mintEnd
    ) external onlyRole(DEFAULT_ADMIN_ROLE) returns (uint256 tokenId) {
        _assertReleaseKey(releaseId);
        if (!albumCreated) revert AlbumNotCreated();
        if (albumClosed) revert AlbumAlreadyClosed();
        uint256 trackLimit = expandedReleaseApproved ? approvedMaxTracks : DEFAULT_ALBUM_MAX_TRACKS;
        uint256 singleLimit = expandedReleaseApproved ? approvedMaxSingles : DEFAULT_ALBUM_MAX_SINGLES;
        if (albumTrackCount >= trackLimit) revert AlbumTrackLimitReached(trackLimit);
        if (single && albumSingleCount >= singleLimit) revert AlbumSingleLimitReached(singleLimit);
        _assertValidMintEnd(mintEnd);
        tokenId = super.createEdition(releaseId, editionId, maxSupply, metadataUri, payout, royaltyBps);
        _setMintEnd(tokenId, mintEnd);
        isAlbumSingle[tokenId] = single;
        albumTrackCount += 1;
        if (single) albumSingleCount += 1;
        emit AlbumTrackCreated(tokenId, single, mintEnd);
    }

    /// @notice Permanently closes album track creation. Existing mint deadlines remain active.
    function closeAlbum(bytes32 releaseId) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _assertReleaseKey(releaseId);
        if (!albumCreated) revert AlbumNotCreated();
        if (albumClosed) revert AlbumAlreadyClosed();
        albumClosed = true;
        emit AlbumClosed(releaseId);
    }

    /// @dev The single creation choke point: the next sequential ID, then the royalty policy, then the
    /// base edition record. A revert anywhere leaves lastTokenId unchanged, so no ID is ever skipped.
    function _createEdition(bytes32 releaseId, bytes32 editionId, uint256 maxSupply, string calldata metadataUri, address payout, uint96 royaltyBps)
        internal override returns (uint256 tokenId)
    {
        uint256 expected = lastTokenId + 1;
        if (uint256(editionId) != expected) revert NonSequentialTokenId(expected, uint256(editionId));
        if (royaltyBps != REQUIRED_ROYALTY_BPS) revert RoyaltyPolicyViolation(royaltyBps, REQUIRED_ROYALTY_BPS);
        if (payout == platformFeeRecipient || !_hasRole(ARTIST_ROLE, payout)) revert UnauthorizedRoyaltyRecipient(payout);
        tokenId = super._createEdition(releaseId, editionId, maxSupply, metadataUri, payout, royaltyBps);
        lastTokenId = tokenId;
    }

    function _assertValidMintEnd(uint64 mintEnd) private view {
        if (mintEnd != 0 && mintEnd <= block.timestamp) revert InvalidMintEnd();
    }

    function _assertReleaseKey(bytes32 supplied) private view {
        if (supplied != releaseKey) revert ReleaseKeyMismatch(releaseKey, supplied);
    }
}
