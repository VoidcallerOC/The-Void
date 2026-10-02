// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VoidCollection1155} from "./VoidCollection1155.sol";

/// @title The-Void Collection Factory
/// @notice The platform deploys one ERC-1155 contract per collection for an artist. Each is
/// an EIP-1167 minimal-proxy clone of a single VoidCollection1155 implementation, so a new
/// collection costs a small fraction of a full deployment. The artist owns the clone from
/// the moment it exists; the factory keeps no role in it.
/// @dev `isCollection` is the registry of genuine Void collections. The primary sale and
/// the marketplace accept only registered collections, so an arbitrary ERC-1155 that copies
/// the interface cannot be sold or listed through them.
contract VoidCollectionFactory {
    address public immutable implementation;
    address public owner;
    address public primarySale;
    mapping(address => bool) public isCollection;
    address[] private _collections;
    mapping(address => address[]) private _collectionsByArtist;

    error NotOwner();
    error InvalidAddress();
    error PrimarySaleAlreadySet();
    error PrimarySaleNotSet();
    error CloneFailed();

    event CollectionCreated(address indexed collection, address indexed artist, uint256 indexed index, string name, string symbol, string contractURI);
    event PrimarySaleSet(address indexed primarySale);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    constructor() {
        owner = msg.sender;
        implementation = address(new VoidCollection1155());
        emit OwnershipTransferred(address(0), msg.sender);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @notice One-time link to the primary-sale contract, which every new collection
    /// grants ISSUER_ROLE. (The sale contract needs this factory's address first.)
    function setPrimarySale(address sale) external onlyOwner {
        if (sale == address(0)) revert InvalidAddress();
        if (primarySale != address(0)) revert PrimarySaleAlreadySet();
        primarySale = sale;
        emit PrimarySaleSet(sale);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Deploys a collection owned by `artist`. Only the platform may call this.
    function createCollection(address artist, string calldata name, string calldata symbol, string calldata contractURI)
        external onlyOwner returns (address collection)
    {
        if (artist == address(0)) revert InvalidAddress();
        if (primarySale == address(0)) revert PrimarySaleNotSet();
        collection = _clone(implementation);
        isCollection[collection] = true;
        _collections.push(collection);
        _collectionsByArtist[artist].push(collection);
        VoidCollection1155(collection).initialize(artist, primarySale, name, symbol, contractURI);
        emit CollectionCreated(collection, artist, _collections.length - 1, name, symbol, contractURI);
    }

    function collectionCount() external view returns (uint256) { return _collections.length; }
    function collectionAt(uint256 index) external view returns (address) { return _collections[index]; }
    function collectionsOf(address artist) external view returns (address[] memory) { return _collectionsByArtist[artist]; }

    /// @dev EIP-1167 minimal proxy: delegates every call to `target`.
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
