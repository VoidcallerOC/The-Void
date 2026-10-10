// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VoidCollection1155} from "./VoidCollection1155.sol";

/// @title The-Void release ERC-1155 with publication-time provenance (one clone per release)
/// @notice Same release, album, mint-end, royalty and open-edition rules as VoidRelease1155V4.
/// Every edition-creating entry point additionally takes the edition's provenance root and
/// records it in the same transaction, so one artist signature both publishes the edition and
/// commits its provenance on-chain. There is no separate anchor contract and no second step.
/// @dev The clone is its own provenance anchor: it emits the VoidProvenanceAnchor-compatible
/// `ProvenanceAnchored` event (emitter = this release contract) and exposes `isAnchored`.
/// The edition artist (msg.sender) is the attester of record. The platform holds no role.
/// A root is a timestamped commitment to the provenance manifest. It does not register copyright.
contract VoidRelease1155V5 is VoidCollection1155 {
    uint16 public constant IMPLEMENTATION_VERSION = 5;

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

    /// @notice The provenance root committed when the edition was created. Zero for unknown tokens.
    mapping(uint256 => bytes32) public provenanceRootOf;
    /// @notice The edition that committed a root. Each root is attested by at most one edition.
    mapping(bytes32 => uint256) public tokenIdForProvenanceRoot;
    mapping(bytes32 => bool) private _anchored;

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
    error ProvenanceRootRequired();
    error InvalidRoot();
    error AlreadyAnchored(bytes32 provenanceRoot);

    event ReleaseInitialized(bytes32 indexed releaseKey, address indexed artist, address indexed issuer);
    event ExpandedReleaseApproved(uint256 maxTracks, uint256 maxSingles);
    event AlbumCreated(bytes32 indexed releaseKey);
    event AlbumTrackCreated(uint256 indexed tokenId, bool indexed single, uint64 mintEnd);
    event AlbumClosed(bytes32 indexed releaseKey);
    /// @dev Identical signature to VoidProvenanceAnchor.ProvenanceAnchored, so one decoder reads both.
    event ProvenanceAnchored(
        bytes32 indexed provenanceRoot,
        bytes32 indexed releaseId,
        bytes32 indexed editionId,
        uint256 tokenId,
        address artist,
        address releaseContract
    );

    /// @notice Direct initialization without a release key is disabled for release clones.
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
        // Artist edition management stays separate from sale mint authority.
        _revokeRole(ISSUER_ROLE, artist);
        emit ReleaseInitialized(releaseKey_, artist, issuer);
    }

    /// @notice Editions retain their original artist identity permanently.
    function transferOwnership(address) external pure override {
        revert OwnershipTransferUnsupported();
    }

    /// @notice Same edition-scoped token IDs as V4: the contract address is part of asset identity.
    function tokenIdFor(bytes32, bytes32 editionId) public pure override returns (uint256) {
        uint256 tokenId = uint256(keccak256(abi.encode("the-void:release-edition:v1", editionId)));
        return tokenId == 0 ? 1 : tokenId;
    }

    /// @notice Root-less creation is disabled: every V5 edition commits its provenance root.
    function createEdition(bytes32, bytes32, uint256, string calldata) public pure override returns (uint256) {
        revert ProvenanceRootRequired();
    }

    /// @notice Root-less creation is disabled: every V5 edition commits its provenance root.
    function createEdition(bytes32, bytes32, uint256, string calldata, address, uint96)
        public
        pure
        override
        returns (uint256)
    {
        revert ProvenanceRootRequired();
    }

    /// @notice Creates a standalone edition and records its provenance root atomically.
    function createEdition(
        bytes32 releaseId,
        bytes32 editionId,
        uint256 maxSupply,
        string calldata metadataUri,
        address payout,
        uint96 royaltyBps,
        bytes32 provenanceRoot
    ) external onlyRole(ARTIST_ROLE) whenNotPaused returns (uint256 tokenId) {
        _assertReleaseKey(releaseId);
        if (albumCreated) revert AlbumTrackPathRequired();
        tokenId = _createAnchoredEdition(releaseId, editionId, maxSupply, metadataUri, payout, royaltyBps, provenanceRoot);
    }

    /// @notice Creates a standalone edition with an optional mint deadline and records its root.
    function createEditionWithMintEnd(
        bytes32 releaseId,
        bytes32 editionId,
        uint256 maxSupply,
        string calldata metadataUri,
        address payout,
        uint96 royaltyBps,
        uint64 mintEnd,
        bytes32 provenanceRoot
    ) external onlyRole(ARTIST_ROLE) whenNotPaused returns (uint256 tokenId) {
        _assertReleaseKey(releaseId);
        if (albumCreated) revert AlbumTrackPathRequired();
        _assertValidMintEnd(mintEnd);
        tokenId = _createAnchoredEdition(releaseId, editionId, maxSupply, metadataUri, payout, royaltyBps, provenanceRoot);
        _setMintEnd(tokenId, mintEnd);
    }

    /// @notice Explicitly opts this release contract into album semantics.
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

    /// @notice Adds one album track and records its provenance root atomically.
    function createAlbumTrack(
        bytes32 releaseId,
        bytes32 editionId,
        uint256 maxSupply,
        string calldata metadataUri,
        address payout,
        uint96 royaltyBps,
        bool single,
        uint64 mintEnd,
        bytes32 provenanceRoot
    ) external onlyRole(DEFAULT_ADMIN_ROLE) onlyRole(ARTIST_ROLE) whenNotPaused returns (uint256 tokenId) {
        _assertReleaseKey(releaseId);
        if (!albumCreated) revert AlbumNotCreated();
        if (albumClosed) revert AlbumAlreadyClosed();
        uint256 trackLimit = expandedReleaseApproved ? approvedMaxTracks : DEFAULT_ALBUM_MAX_TRACKS;
        uint256 singleLimit = expandedReleaseApproved ? approvedMaxSingles : DEFAULT_ALBUM_MAX_SINGLES;
        if (albumTrackCount >= trackLimit) revert AlbumTrackLimitReached(trackLimit);
        if (single && albumSingleCount >= singleLimit) revert AlbumSingleLimitReached(singleLimit);
        _assertValidMintEnd(mintEnd);
        tokenId = _createAnchoredEdition(releaseId, editionId, maxSupply, metadataUri, payout, royaltyBps, provenanceRoot);
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

    /// @notice VoidProvenanceAnchor-compatible view: true only for the root this release's
    /// edition committed at creation.
    function isAnchored(bytes32 releaseId, bytes32 editionId, bytes32 provenanceRoot) external view returns (bool) {
        return _anchored[keccak256(abi.encode(releaseId, editionId, provenanceRoot))];
    }

    function _createAnchoredEdition(
        bytes32 releaseId,
        bytes32 editionId,
        uint256 maxSupply,
        string calldata metadataUri,
        address payout,
        uint96 royaltyBps,
        bytes32 provenanceRoot
    ) private returns (uint256 tokenId) {
        if (provenanceRoot == bytes32(0)) revert InvalidRoot();
        if (tokenIdForProvenanceRoot[provenanceRoot] != 0) revert AlreadyAnchored(provenanceRoot);
        tokenId = _createEdition(releaseId, editionId, maxSupply, metadataUri, payout, royaltyBps);
        provenanceRootOf[tokenId] = provenanceRoot;
        tokenIdForProvenanceRoot[provenanceRoot] = tokenId;
        _anchored[keccak256(abi.encode(releaseId, editionId, provenanceRoot))] = true;
        emit ProvenanceAnchored(provenanceRoot, releaseId, editionId, tokenId, msg.sender, address(this));
    }

    function _assertValidMintEnd(uint64 mintEnd) private view {
        if (mintEnd != 0 && mintEnd <= block.timestamp) revert InvalidMintEnd();
    }

    function _assertReleaseKey(bytes32 supplied) private view {
        if (supplied != releaseKey) revert ReleaseKeyMismatch(releaseKey, supplied);
    }
}
