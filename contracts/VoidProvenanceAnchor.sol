// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title The-Void provenance anchor
/// @notice Commits a 32-byte provenance root for an edition that already exists
/// on the certified VoidRelease1155. The deployed release contract is not
/// upgradeable and its EditionCreated event cannot carry this root.
/// This contract stores no file bytes, URIs, or metadata documents.
/// An anchor is a timestamped commitment. It does not register copyright.
interface IVoidRelease1155 {
    struct Edition {
        bytes32 releaseId;
        bytes32 editionId;
        address artist;
        uint256 maxSupply;
        uint256 mintedSupply;
        string metadataUri;
        bool exists;
    }

    function tokenIdFor(bytes32 releaseId, bytes32 editionId) external pure returns (uint256);
    function edition(uint256 tokenId) external view returns (Edition memory);
}

contract VoidProvenanceAnchor {
    address public immutable releaseContract;
    mapping(bytes32 => bool) private _anchored;
    bool private _entered;

    error InvalidAddress();
    error InvalidIdentifier();
    error InvalidRoot();
    error EditionNotFound(uint256 tokenId);
    error EditionIdentityMismatch();
    error ArtistMismatch(address expected, address actual);
    error AlreadyAnchored(bytes32 provenanceRoot);
    error Reentered();

    event ProvenanceAnchored(
        bytes32 indexed provenanceRoot,
        bytes32 indexed releaseId,
        bytes32 indexed editionId,
        uint256 tokenId,
        address artist,
        address releaseContract
    );

    constructor(address release) {
        if (release == address(0)) revert InvalidAddress();
        releaseContract = release;
    }

    modifier nonReentrant() {
        if (_entered) revert Reentered();
        _entered = true;
        _;
        _entered = false;
    }

    function anchor(bytes32 releaseId, bytes32 editionId, bytes32 provenanceRoot) external nonReentrant {
        if (releaseId == bytes32(0) || editionId == bytes32(0)) revert InvalidIdentifier();
        if (provenanceRoot == bytes32(0)) revert InvalidRoot();
        uint256 tokenId = IVoidRelease1155(releaseContract).tokenIdFor(releaseId, editionId);
        IVoidRelease1155.Edition memory item = IVoidRelease1155(releaseContract).edition(tokenId);
        if (!item.exists) revert EditionNotFound(tokenId);
        if (item.releaseId != releaseId || item.editionId != editionId) revert EditionIdentityMismatch();
        if (item.artist != msg.sender) revert ArtistMismatch(item.artist, msg.sender);
        bytes32 key = keccak256(abi.encode(releaseId, editionId, provenanceRoot));
        if (_anchored[key]) revert AlreadyAnchored(provenanceRoot);
        _anchored[key] = true;
        emit ProvenanceAnchored(provenanceRoot, releaseId, editionId, tokenId, msg.sender, releaseContract);
    }

    function isAnchored(bytes32 releaseId, bytes32 editionId, bytes32 provenanceRoot) external view returns (bool) {
        return _anchored[keccak256(abi.encode(releaseId, editionId, provenanceRoot))];
    }
}
