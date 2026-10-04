// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VoidRelease1155V4} from "./VoidRelease1155V4.sol";
import {VoidPrimarySale} from "./VoidPrimarySale.sol";
import {VoidProvenanceAnchor} from "./VoidProvenanceAnchor.sol";

/// @title The-Void release factory
/// @notice Creates exactly one independent ERC-1155 clone, dedicated primary sale, and
/// provenance anchor for each immutable release key. The factory is a registry and holds
/// no role on any resulting release clone after initialization.
contract VoidReleaseFactory {
    uint16 public constant RELEASE_VERSION = 1;
    uint256 public constant BPS_DENOMINATOR = 10_000;

    address public immutable implementation;
    address public immutable platformRecipient;
    uint256 public immutable platformFeeBps;
    address public immutable saleOwner;
    address public owner;

    mapping(address => bool) public isRelease;
    mapping(address => bytes32) public releaseOf;
    mapping(bytes32 => address) public releaseContractOf;
    mapping(address => address) public primarySaleOf;
    mapping(address => address) public provenanceAnchorOf;
    mapping(address => address) public artistOf;
    address[] private _releases;
    mapping(address => address[]) private _releasesByArtist;

    error NotOwner();
    error InvalidAddress();
    error InvalidReleaseKey();
    error ReleaseAlreadyExists(bytes32 releaseKey, address releaseContract);
    error FeeAboveCap(uint256 requested, uint256 cap);
    error CloneFailed();

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
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

    constructor(address platformRecipient_, uint256 platformFeeBps_, address saleOwner_) {
        if (platformRecipient_ == address(0) || saleOwner_ == address(0)) revert InvalidAddress();
        if (platformFeeBps_ > BPS_DENOMINATOR) revert FeeAboveCap(platformFeeBps_, BPS_DENOMINATOR);
        owner = msg.sender;
        platformRecipient = platformRecipient_;
        platformFeeBps = platformFeeBps_;
        saleOwner = saleOwner_;
        implementation = address(new VoidRelease1155V4());
        emit OwnershipTransferred(address(0), msg.sender);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @notice Deploys and fully initializes the isolated on-chain stack for one release.
    /// @dev The caller is a controlled deployment service/Safe. The artist receives release
    /// administration; the configured sale owner receives the dedicated sale immediately.
    function createRelease(
        address artist,
        bytes32 releaseKey,
        string calldata name,
        string calldata symbol,
        string calldata contractURI
    ) external onlyOwner returns (address releaseContract, address primarySale, address provenanceAnchor) {
        if (artist == address(0)) revert InvalidAddress();
        if (releaseKey == bytes32(0)) revert InvalidReleaseKey();
        address existing = releaseContractOf[releaseKey];
        if (existing != address(0)) revert ReleaseAlreadyExists(releaseKey, existing);

        releaseContract = _clone(implementation);
        primarySale = address(new VoidPrimarySale(releaseContract, platformRecipient, platformFeeBps));
        provenanceAnchor = address(new VoidProvenanceAnchor(releaseContract));
        VoidRelease1155V4(releaseContract).initializeRelease(artist, primarySale, releaseKey, name, symbol, contractURI);
        VoidPrimarySale(primarySale).transferOwnership(saleOwner);

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

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function releaseCount() external view returns (uint256) { return _releases.length; }
    function releaseAt(uint256 index) external view returns (address) { return _releases[index]; }
    function releasesOf(address artist) external view returns (address[] memory) { return _releasesByArtist[artist]; }

    /// @dev EIP-1167 minimal proxy: delegates every call to the versioned implementation.
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
