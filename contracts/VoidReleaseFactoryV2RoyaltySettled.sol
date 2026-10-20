// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VoidRelease1155V4} from "./VoidRelease1155V4.sol";
import {VoidRelease1155V4Royalty} from "./VoidRelease1155V4Royalty.sol";
import {VoidPrimarySaleSettled} from "./VoidPrimarySaleSettled.sol";
import {VoidProvenanceAnchor} from "./VoidProvenanceAnchor.sol";

/// @title VoidReleaseFactoryV2Royalty with automatic platform settlement on every primary sale
/// @notice NOT DEPLOYED. Identical to VoidReleaseFactoryV2Royalty (ownerless, one royalty-locked clone, one
/// sale and one provenance anchor per release, same events, RELEASE_VERSION and release-key derivation)
/// with ONE change: each release's primary sale is a VoidPrimarySaleSettled, which pushes the 2.5% platform
/// share to `platformRecipient` inside the purchase transaction (and reverts the whole purchase if that
/// transfer fails) instead of crediting it as a balance. The artist's 97.5% stays a pull balance.
/// Releases created by the production factory 0x262B774c... are not touched, and its marketplace
/// 0x0e77... only recognises that factory's releases (its registry is immutable), so releases from this
/// factory need a ReleaseMarketplaceV4 constructed with this factory's address.
contract VoidReleaseFactoryV2RoyaltySettled {
    uint16 public constant RELEASE_VERSION = 2;
    uint96 public constant REQUIRED_ROYALTY_BPS = 250;
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant PLATFORM_FEE_BPS = 250;

    address public immutable implementation;
    address public immutable platformRecipient;

    mapping(address => bool) public isRelease;
    mapping(address => bytes32) public releaseOf;
    mapping(bytes32 => address) public releaseContractOf;
    mapping(address => address) public primarySaleOf;
    mapping(address => address) public provenanceAnchorOf;
    mapping(address => address) public artistOf;
    address[] private _releases;
    mapping(address => address[]) private _releasesByArtist;

    error InvalidAddress();
    error InvalidReleaseKey();
    error ReleaseKeyMismatch(bytes32 expected, bytes32 actual);
    error ReleaseAlreadyExists(bytes32 releaseKey, address releaseContract);
    error CloneFailed();

    event ReleaseCreated(
        address indexed releaseContract,
        bytes32 indexed releaseKey,
        address indexed artist,
        address primarySale,
        address provenanceAnchor,
        address implementation,
        uint256 index,
        uint16 version
    );

    constructor(address platformRecipient_) {
        if (platformRecipient_ == address(0)) revert InvalidAddress();
        platformRecipient = platformRecipient_;
        implementation = address(new VoidRelease1155V4Royalty(platformRecipient_));
    }

    /// @notice Creates the complete per-release infrastructure from the artist's wallet.
    /// @param releaseKey Deterministic, non-zero key allocated to this application release.
    /// @return releaseContract The artist-administered V4 clone.
    /// @return primarySale The release-specific settled primary-sale contract.
    /// @return provenanceAnchor The release-specific provenance anchor.
    function createRelease(bytes32 applicationReleaseId, bytes32 releaseKey, string calldata name, string calldata symbol, string calldata contractURI)
        external
        returns (address releaseContract, address primarySale, address provenanceAnchor)
    {
        address artist = msg.sender;
        if (artist == address(0)) revert InvalidAddress();
        if (applicationReleaseId == bytes32(0)) revert InvalidReleaseKey();
        if (releaseKey == bytes32(0)) revert InvalidReleaseKey();
        bytes32 expectedKey = keccak256(abi.encode("the-void:studio-release:v2", block.chainid, address(this), applicationReleaseId, artist));
        if (releaseKey != expectedKey) revert ReleaseKeyMismatch(expectedKey, releaseKey);
        return _createRelease(artist, releaseKey, name, symbol, contractURI);
    }

    function _createRelease(
        address artist,
        bytes32 releaseKey,
        string calldata name,
        string calldata symbol,
        string calldata contractURI
    ) private returns (address releaseContract, address primarySale, address provenanceAnchor) {
        address existing = releaseContractOf[releaseKey];
        if (existing != address(0)) revert ReleaseAlreadyExists(releaseKey, existing);

        (releaseContract, primarySale, provenanceAnchor) = _deployInfrastructure();
        VoidRelease1155V4(releaseContract).initializeRelease(artist, primarySale, releaseKey, name, symbol, contractURI);

        isRelease[releaseContract] = true;
        releaseOf[releaseContract] = releaseKey;
        releaseContractOf[releaseKey] = releaseContract;
        primarySaleOf[releaseContract] = primarySale;
        provenanceAnchorOf[releaseContract] = provenanceAnchor;
        artistOf[releaseContract] = artist;
        _releases.push(releaseContract);
        _releasesByArtist[artist].push(releaseContract);

        emit ReleaseCreated(releaseContract, releaseKey, artist, primarySale, provenanceAnchor, implementation, _releases.length - 1, RELEASE_VERSION);
    }

    function releaseCount() external view returns (uint256) { return _releases.length; }
    function releaseAt(uint256 index) external view returns (address) { return _releases[index]; }
    function releasesOf(address artist) external view returns (address[] memory) { return _releasesByArtist[artist]; }

    function _deployInfrastructure()
        private
        returns (address releaseContract, address primarySale, address provenanceAnchor)
    {
        releaseContract = _clone(implementation);
        primarySale = address(new VoidPrimarySaleSettled(releaseContract, platformRecipient));
        provenanceAnchor = address(new VoidProvenanceAnchor(releaseContract));
    }

    /// @dev EIP-1167 minimal proxy.
    function _clone(address target) private returns (address instance) {
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000000000000000000000)
            mstore(add(ptr, 0x14), shl(0x60, target))
            mstore(add(ptr, 0x28), 0x5af43d82803e903d91602b57fd5bf30000000000000000000000000000000000)
            instance := create(0, ptr, 0x37)
        }
        if (instance == address(0)) revert CloneFailed();
    }
}
