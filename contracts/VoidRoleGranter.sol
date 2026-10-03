// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IVoidReleaseRoles {
    function grantRole(bytes32 role, address account) external;
    function revokeRole(bytes32 role, address account) external;
    function hasRole(bytes32 role, address account) external view returns (bool);
}

/// @notice Lets verification reviewers give a verified artist publishing
/// rights on a VoidRelease1155V2 contract without holding its admin role.
///
/// The release contract only lets DEFAULT_ADMIN grant roles, so this contract
/// is given DEFAULT_ADMIN once. Its code is the limit on that power: it can
/// grant or revoke exactly ARTIST_ROLE and ISSUER_ROLE, nothing else, and
/// only when a listed reviewer calls it. It has no arbitrary call, no upgrade
/// path and no way to grant DEFAULT_ADMIN. The release admin can switch it
/// off at any time by revoking its DEFAULT_ADMIN role.
contract VoidRoleGranter {
    bytes32 public constant ARTIST_ROLE = keccak256("ARTIST_ROLE");
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");

    IVoidReleaseRoles public immutable release;
    address public owner;
    mapping(address => bool) public isReviewer;

    event ReviewerSet(address indexed reviewer, bool allowed, address indexed by);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event PublishingRolesGranted(address indexed artist, address indexed reviewer);
    event PublishingRolesRevoked(address indexed artist, address indexed reviewer);

    error InvalidAddress();
    error NotOwner(address caller);
    error NotReviewer(address caller);
    error SelfGrant(address reviewer);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _;
    }

    modifier onlyReviewer() {
        if (!isReviewer[msg.sender]) revert NotReviewer(msg.sender);
        _;
    }

    constructor(address release_, address owner_, address[] memory reviewers_) {
        if (release_ == address(0) || owner_ == address(0)) revert InvalidAddress();
        release = IVoidReleaseRoles(release_);
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
        for (uint256 i; i < reviewers_.length; ++i) _setReviewer(reviewers_[i], true);
    }

    /// @notice Give a verified artist both publishing roles.
    function grantPublishingRoles(address artist) external onlyReviewer {
        if (artist == address(0)) revert InvalidAddress();
        // A reviewer never verifies themselves.
        if (artist == msg.sender) revert SelfGrant(msg.sender);
        release.grantRole(ARTIST_ROLE, artist);
        release.grantRole(ISSUER_ROLE, artist);
        emit PublishingRolesGranted(artist, msg.sender);
    }

    /// @notice Take publishing roles back, e.g. after a mistaken approval.
    function revokePublishingRoles(address artist) external onlyReviewer {
        if (artist == address(0)) revert InvalidAddress();
        release.revokeRole(ARTIST_ROLE, artist);
        release.revokeRole(ISSUER_ROLE, artist);
        emit PublishingRolesRevoked(artist, msg.sender);
    }

    function setReviewer(address reviewer, bool allowed) external onlyOwner {
        _setReviewer(reviewer, allowed);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function _setReviewer(address reviewer, bool allowed) private {
        if (reviewer == address(0)) revert InvalidAddress();
        isReviewer[reviewer] = allowed;
        emit ReviewerSet(reviewer, allowed, msg.sender);
    }
}
