// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VoidCollection1155} from "./VoidCollection1155.sol";

/// @title The-Void release ERC-1155 (one clone per release)
/// @notice A release-specific successor to VoidCollection1155. Each EIP-1167 clone has
/// its own storage, roles, supply, balances, approvals and pause state. The initialized
/// releaseKey is immutable in practice and every edition must belong to that one release.
contract VoidRelease1155V4 is VoidCollection1155 {
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

    event ReleaseInitialized(bytes32 indexed releaseKey, address indexed artist, address indexed issuer);
    event ExpandedReleaseApproved(uint256 maxTracks, uint256 maxSingles);
    event AlbumCreated(bytes32 indexed releaseKey);
    event AlbumTrackCreated(uint256 indexed tokenId, bool indexed single, uint64 mintEnd);
    event AlbumClosed(bytes32 indexed releaseKey);

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
    /// Existing callers remain unchanged; this overload is the additive deadline path.
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

    /// @notice Adds one album track. Tracks and singles share this release contract.
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

    function _assertValidMintEnd(uint64 mintEnd) private view {
        if (mintEnd != 0 && mintEnd <= block.timestamp) revert InvalidMintEnd();
    }

    function _assertReleaseKey(bytes32 supplied) private view {
        if (supplied != releaseKey) revert ReleaseKeyMismatch(releaseKey, supplied);
    }
}
