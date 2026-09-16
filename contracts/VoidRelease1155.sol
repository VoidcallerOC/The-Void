// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title The-Void Release Editions
/// @notice Music-native ERC-1155 issuance infrastructure. Large media and protected
/// content remain off-chain; each edition token carries only a public metadata URI.
/// DEFAULT_ADMIN_ROLE controls roles and pause state. ARTIST_ROLE creates editions.
/// ISSUER_ROLE is a trusted platform-level minting authority and is not automatically
/// restricted to the artist recorded on an edition. An admin may renounce its access;
/// no recovery mechanism is intentionally built into this first deployment.
contract VoidRelease1155 {
    string public constant name = "The-Void Release Editions";
    string public constant symbol = "VOID";
    bytes32 public constant DEFAULT_ADMIN_ROLE = 0x00;
    bytes32 public constant ARTIST_ROLE = keccak256("ARTIST_ROLE");
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");

    struct Edition {
        bytes32 releaseId;
        bytes32 editionId;
        address artist;
        uint256 maxSupply;
        uint256 mintedSupply;
        string metadataUri;
        bool exists;
    }

    mapping(bytes32 => mapping(address => bool)) private _roles;
    mapping(uint256 => Edition) private _editions;
    mapping(uint256 => mapping(address => uint256)) private _balances;
    mapping(address => mapping(address => bool)) private _operatorApprovals;
    bool public paused;

    error AccessDenied(bytes32 role, address account);
    error AlreadyInitialized(uint256 tokenId);
    error InvalidAddress();
    error InvalidSupply();
    error InvalidIdentifier();
    error EditionNotFound(uint256 tokenId);
    error InactiveEdition(uint256 tokenId);
    error ExceedsSupply(uint256 tokenId, uint256 available, uint256 requested);
    error InsufficientBalance(address account, uint256 tokenId, uint256 available, uint256 requested);
    error LengthMismatch();
    error ZeroQuantity();
    error ContractPaused();
    error UnsafeRecipient();

    event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender);
    event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender);
    event Paused(address indexed account);
    event Unpaused(address indexed account);
    event EditionCreated(uint256 indexed tokenId, bytes32 indexed releaseId, bytes32 indexed editionId, address artist, uint256 maxSupply, string metadataUri);
    event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value);
    event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values);
    event ApprovalForAll(address indexed account, address indexed operator, bool approved);
    event URI(string value, uint256 indexed id);

    constructor(address admin) {
        if (admin == address(0)) revert InvalidAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ARTIST_ROLE, admin);
        _grantRole(ISSUER_ROLE, admin);
    }

    modifier onlyRole(bytes32 role) {
        if (!_roles[role][msg.sender]) revert AccessDenied(role, msg.sender);
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert ContractPaused();
        _;
    }

    function hasRole(bytes32 role, address account) external view returns (bool) { return _roles[role][account]; }
    function grantRole(bytes32 role, address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (account == address(0)) revert InvalidAddress();
        _grantRole(role, account);
    }
    function revokeRole(bytes32 role, address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_roles[role][account]) { _roles[role][account] = false; emit RoleRevoked(role, account, msg.sender); }
    }
    function renounceRole(bytes32 role) external {
        if (_roles[role][msg.sender]) { _roles[role][msg.sender] = false; emit RoleRevoked(role, msg.sender, msg.sender); }
    }
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) { paused = true; emit Paused(msg.sender); }
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) { paused = false; emit Unpaused(msg.sender); }

    /// @dev Token IDs are uint256(keccak256("the-void:edition:v1", releaseId, editionId));
    ///      the zero value is rejected. IDs never depend on database ordering.
    function tokenIdFor(bytes32 releaseId, bytes32 editionId) public pure returns (uint256) {
        uint256 tokenId = uint256(keccak256(abi.encode("the-void:edition:v1", releaseId, editionId)));
        return tokenId == 0 ? 1 : tokenId;
    }

    function createEdition(bytes32 releaseId, bytes32 editionId, uint256 maxSupply, string calldata metadataUri)
        external onlyRole(ARTIST_ROLE) whenNotPaused returns (uint256 tokenId)
    {
        if (releaseId == bytes32(0) || editionId == bytes32(0)) revert InvalidIdentifier();
        if (maxSupply == 0) revert InvalidSupply();
        tokenId = tokenIdFor(releaseId, editionId);
        if (_editions[tokenId].exists) revert AlreadyInitialized(tokenId);
        _editions[tokenId] = Edition(releaseId, editionId, msg.sender, maxSupply, 0, metadataUri, true);
        emit EditionCreated(tokenId, releaseId, editionId, msg.sender, maxSupply, metadataUri);
        emit URI(metadataUri, tokenId);
    }

    function edition(uint256 tokenId) external view returns (Edition memory) {
        if (!_editions[tokenId].exists) revert EditionNotFound(tokenId);
        return _editions[tokenId];
    }
    function uri(uint256 tokenId) public view returns (string memory) {
        if (!_editions[tokenId].exists) revert EditionNotFound(tokenId);
        return _editions[tokenId].metadataUri;
    }
    function balanceOf(address account, uint256 tokenId) public view returns (uint256) {
        if (account == address(0)) revert InvalidAddress();
        return _balances[tokenId][account];
    }
    function balanceOfBatch(address[] calldata accounts, uint256[] calldata ids) external view returns (uint256[] memory values) {
        if (accounts.length != ids.length) revert LengthMismatch();
        values = new uint256[](accounts.length);
        for (uint256 i; i < accounts.length; ++i) values[i] = balanceOf(accounts[i], ids[i]);
    }
    function setApprovalForAll(address operator, bool approved) external {
        if (operator == address(0)) revert InvalidAddress();
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }
    function isApprovedForAll(address account, address operator) external view returns (bool) { return _operatorApprovals[account][operator]; }

    function mint(address to, uint256 tokenId, uint256 amount, bytes calldata data) external onlyRole(ISSUER_ROLE) whenNotPaused {
        if (to == address(0)) revert InvalidAddress();
        _mint(to, tokenId, amount, data);
    }
    function mintBatch(address to, uint256[] calldata ids, uint256[] calldata amounts, bytes calldata data)
        external onlyRole(ISSUER_ROLE) whenNotPaused
    {
        if (to == address(0)) revert InvalidAddress();
        if (ids.length != amounts.length) revert LengthMismatch();
        for (uint256 i; i < ids.length; ++i) _consumeSupply(ids[i], amounts[i]);
        for (uint256 i; i < ids.length; ++i) _balances[ids[i]][to] += amounts[i];
        emit TransferBatch(msg.sender, address(0), to, ids, amounts);
        _checkOnERC1155BatchReceived(msg.sender, address(0), to, ids, amounts, data);
    }
    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata data) external whenNotPaused {
        if (from != msg.sender && !_operatorApprovals[from][msg.sender]) revert AccessDenied(ISSUER_ROLE, msg.sender);
        if (to == address(0)) revert InvalidAddress();
        uint256 available = _balances[id][from];
        if (available < amount) revert InsufficientBalance(from, id, available, amount);
        unchecked { _balances[id][from] = available - amount; }
        _balances[id][to] += amount;
        emit TransferSingle(msg.sender, from, to, id, amount);
        _checkOnERC1155Received(msg.sender, from, to, id, amount, data);
    }
    function safeBatchTransferFrom(address from, address to, uint256[] calldata ids, uint256[] calldata amounts, bytes calldata data) external whenNotPaused {
        if (from != msg.sender && !_operatorApprovals[from][msg.sender]) revert AccessDenied(ISSUER_ROLE, msg.sender);
        if (to == address(0)) revert InvalidAddress();
        if (ids.length != amounts.length) revert LengthMismatch();
        for (uint256 i; i < ids.length; ++i) {
            uint256 available = _balances[ids[i]][from];
            if (available < amounts[i]) revert InsufficientBalance(from, ids[i], available, amounts[i]);
            unchecked { _balances[ids[i]][from] = available - amounts[i]; }
            _balances[ids[i]][to] += amounts[i];
        }
        emit TransferBatch(msg.sender, from, to, ids, amounts);
        _checkOnERC1155BatchReceived(msg.sender, from, to, ids, amounts, data);
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == 0xd9b67a26 || interfaceId == 0x0e89341c;
    }

    function _grantRole(bytes32 role, address account) internal { if (!_roles[role][account]) { _roles[role][account] = true; emit RoleGranted(role, account, msg.sender); } }
    function _mint(address to, uint256 tokenId, uint256 amount, bytes calldata data) internal {
        _consumeSupply(tokenId, amount);
        _balances[tokenId][to] += amount;
        emit TransferSingle(msg.sender, address(0), to, tokenId, amount);
        _checkOnERC1155Received(msg.sender, address(0), to, tokenId, amount, data);
    }
    function _consumeSupply(uint256 tokenId, uint256 amount) internal {
        Edition storage item = _editions[tokenId];
        if (!item.exists) revert EditionNotFound(tokenId);
        if (amount == 0) revert ZeroQuantity();
        uint256 available = item.maxSupply - item.mintedSupply;
        if (amount > available) revert ExceedsSupply(tokenId, available, amount);
        item.mintedSupply += amount;
    }
    function _checkOnERC1155Received(address operator, address from, address to, uint256 id, uint256 amount, bytes calldata data) private {
        if (to.code.length != 0) {
            try IERC1155Receiver(to).onERC1155Received(operator, from, id, amount, data) returns (bytes4 response) {
                if (response != IERC1155Receiver.onERC1155Received.selector) revert UnsafeRecipient();
            } catch { revert UnsafeRecipient(); }
        }
    }
    function _checkOnERC1155BatchReceived(address operator, address from, address to, uint256[] calldata ids, uint256[] calldata amounts, bytes calldata data) private {
        if (to.code.length != 0) {
            try IERC1155Receiver(to).onERC1155BatchReceived(operator, from, ids, amounts, data) returns (bytes4 response) {
                if (response != IERC1155Receiver.onERC1155BatchReceived.selector) revert UnsafeRecipient();
            } catch { revert UnsafeRecipient(); }
        }
    }
}

interface IERC1155Receiver {
    function onERC1155Received(address operator, address from, uint256 id, uint256 value, bytes calldata data) external returns (bytes4);
    function onERC1155BatchReceived(address operator, address from, uint256[] calldata ids, uint256[] calldata values, bytes calldata data) external returns (bytes4);
}
