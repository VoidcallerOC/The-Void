// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title The-Void Release Editions V3 (multi-artist)
/// @notice One shared canonical ERC-1155 for every verified artist on The Void.
/// Authorization is bound to artist identity, not to global roles:
///   VERIFIED ARTIST (registrar) -> AUTHORIZED WALLET (registrar) -> RELEASE (registrar binds)
///   -> EDITION (created by that artist's wallet) -> TOKEN (minted by that artist or an issuer it approved).
/// The platform (REGISTRAR_ROLE) mirrors the off-chain verification decision. It cannot create
/// editions or mint. An artist wallet can act only for its own artist and only while that
/// artist is active. Token IDs keep the V2 derivation so existing identities stay valid.
/// VoidRelease1155V2 remains the certified Fuji deployment; this contract is not deployed.
contract VoidRelease1155V3 {
    string public constant name = "The-Void Release Editions";
    string public constant symbol = "VOID";
    bytes32 public constant DEFAULT_ADMIN_ROLE = 0x00;
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");
    /// @dev Derived, never granted: hasRole(ARTIST_ROLE, a) is true iff `a` is an authorized
    /// wallet of an active artist. Kept so VoidPrimarySale works unchanged.
    bytes32 public constant ARTIST_ROLE = keccak256("ARTIST_ROLE");
    uint96 public constant MAX_ROYALTY_BPS = 1_000;
    uint256 private constant BPS_DENOMINATOR = 10_000;

    /// @dev Same layout as V2 so existing `edition(uint256)` readers keep decoding it.
    struct Edition {
        bytes32 releaseId;
        bytes32 editionId;
        address artist;
        uint256 maxSupply;
        uint256 mintedSupply;
        string metadataUri;
        bool exists;
    }

    struct ArtistRecord {
        bool registered;
        bool active;
    }

    mapping(bytes32 => mapping(address => bool)) private _roles;
    mapping(bytes32 => ArtistRecord) private _artists;
    mapping(address => bytes32) private _walletArtist;
    mapping(bytes32 => bytes32) private _releaseArtist;
    mapping(bytes32 => mapping(address => bool)) private _artistIssuers;
    mapping(uint256 => bytes32) private _editionArtistId;
    mapping(uint256 => Edition) private _editions;
    mapping(uint256 => address) private _payout;
    mapping(uint256 => uint96) private _royaltyBps;
    mapping(uint256 => mapping(address => uint256)) private _balances;
    mapping(address => mapping(address => bool)) private _operatorApprovals;
    bool public paused;

    error AccessDenied(bytes32 role, address account);
    error AlreadyInitialized(uint256 tokenId);
    error InvalidAddress();
    error InvalidSupply();
    error InvalidIdentifier();
    error InvalidRole(bytes32 role);
    error EditionNotFound(uint256 tokenId);
    error ExceedsSupply(uint256 tokenId, uint256 available, uint256 requested);
    error InsufficientBalance(address account, uint256 tokenId, uint256 available, uint256 requested);
    error LengthMismatch();
    error ZeroQuantity();
    error ContractPaused();
    error UnsafeRecipient();
    error RoyaltyTooHigh(uint96 bps, uint96 cap);
    error ArtistAlreadyRegistered(bytes32 artistId);
    error ArtistNotRegistered(bytes32 artistId);
    error ArtistInactive(bytes32 artistId);
    error WalletBoundToAnotherArtist(address wallet, bytes32 artistId);
    error NotArtistWallet(address account);
    error ReleaseAlreadyBound(bytes32 releaseId, bytes32 artistId);
    error ReleaseNotBound(bytes32 releaseId);
    error ReleaseOwnedByAnotherArtist(bytes32 releaseId, bytes32 owner, bytes32 caller);
    error NotAuthorizedMinter(uint256 tokenId, bytes32 artistId, address account);

    event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender);
    event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender);
    event Paused(address indexed account);
    event Unpaused(address indexed account);
    event ArtistRegistered(bytes32 indexed artistId, address indexed registrar);
    event ArtistStatusChanged(bytes32 indexed artistId, bool active, address indexed registrar);
    event ArtistWalletSet(bytes32 indexed artistId, address indexed wallet, bool authorized, address indexed registrar);
    event ReleaseBound(bytes32 indexed releaseId, bytes32 indexed artistId, address indexed registrar);
    event ArtistIssuerSet(bytes32 indexed artistId, address indexed issuer, bool approved, address indexed artistWallet);
    /// @dev Unchanged from V2 so existing publication verifiers and indexers parse it.
    event EditionCreated(uint256 indexed tokenId, bytes32 indexed releaseId, bytes32 indexed editionId, address artist, uint256 maxSupply, string metadataUri);
    event EditionArtist(uint256 indexed tokenId, bytes32 indexed artistId);
    event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value);
    event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values);
    event ApprovalForAll(address indexed account, address indexed operator, bool approved);
    event URI(string value, uint256 indexed id);
    event RoyaltyConfigured(uint256 indexed tokenId, address indexed receiver, uint96 royaltyBps);

    constructor(address admin) {
        if (admin == address(0)) revert InvalidAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(REGISTRAR_ROLE, admin);
    }

    modifier onlyRole(bytes32 role) {
        if (!_roles[role][msg.sender]) revert AccessDenied(role, msg.sender);
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert ContractPaused();
        _;
    }

    // ---------------------------------------------------------------- roles

    function hasRole(bytes32 role, address account) external view returns (bool) {
        if (role == ARTIST_ROLE) {
            bytes32 artistId = _walletArtist[account];
            return artistId != bytes32(0) && _artists[artistId].active;
        }
        return _roles[role][account];
    }
    function grantRole(bytes32 role, address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (role != DEFAULT_ADMIN_ROLE && role != REGISTRAR_ROLE) revert InvalidRole(role);
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

    // ------------------------------------------------------ artist registry

    /// @notice Record an artist the platform has verified off-chain. `artistId` is the
    /// on-chain key of the database artist (see artistKeyFor in server/artist-authorization.js).
    function registerArtist(bytes32 artistId) external onlyRole(REGISTRAR_ROLE) {
        if (artistId == bytes32(0)) revert InvalidIdentifier();
        if (_artists[artistId].registered) revert ArtistAlreadyRegistered(artistId);
        _artists[artistId] = ArtistRecord(true, true);
        emit ArtistRegistered(artistId, msg.sender);
        emit ArtistStatusChanged(artistId, true, msg.sender);
    }

    /// @notice Revoke (false) or reinstate (true) an artist. A revoked artist cannot create
    /// editions, mint, or approve issuers. Tokens already held by collectors are unaffected.
    function setArtistActive(bytes32 artistId, bool active) external onlyRole(REGISTRAR_ROLE) {
        if (!_artists[artistId].registered) revert ArtistNotRegistered(artistId);
        _artists[artistId].active = active;
        emit ArtistStatusChanged(artistId, active, msg.sender);
    }

    /// @notice Authorize or deauthorize a wallet for exactly one artist.
    function setArtistWallet(bytes32 artistId, address wallet, bool authorized) external onlyRole(REGISTRAR_ROLE) {
        if (wallet == address(0)) revert InvalidAddress();
        if (!_artists[artistId].registered) revert ArtistNotRegistered(artistId);
        bytes32 current = _walletArtist[wallet];
        if (authorized) {
            if (current != bytes32(0) && current != artistId) revert WalletBoundToAnotherArtist(wallet, current);
            _walletArtist[wallet] = artistId;
        } else {
            if (current != artistId) revert WalletBoundToAnotherArtist(wallet, current);
            delete _walletArtist[wallet];
        }
        emit ArtistWalletSet(artistId, wallet, authorized, msg.sender);
    }

    /// @notice Bind an on-chain release identifier to its artist. Permanent: a release can
    /// never move to another artist, so no artist can create editions under another's release.
    function bindRelease(bytes32 releaseId, bytes32 artistId) external onlyRole(REGISTRAR_ROLE) {
        if (releaseId == bytes32(0)) revert InvalidIdentifier();
        if (!_artists[artistId].registered) revert ArtistNotRegistered(artistId);
        bytes32 current = _releaseArtist[releaseId];
        if (current == artistId) return;
        if (current != bytes32(0)) revert ReleaseAlreadyBound(releaseId, current);
        _releaseArtist[releaseId] = artistId;
        emit ReleaseBound(releaseId, artistId, msg.sender);
    }

    /// @notice An artist's own wallet approves (or removes) an issuer, such as the shared
    /// primary-sale contract, to mint that artist's editions. No global minter exists.
    function setArtistIssuer(address issuer, bool approved) external {
        if (issuer == address(0)) revert InvalidAddress();
        bytes32 artistId = _activeArtistOf(msg.sender);
        _artistIssuers[artistId][issuer] = approved;
        emit ArtistIssuerSet(artistId, issuer, approved, msg.sender);
    }

    function isArtistRegistered(bytes32 artistId) external view returns (bool) { return _artists[artistId].registered; }
    function isArtistActive(bytes32 artistId) public view returns (bool) { return _artists[artistId].active; }
    function artistIdOfWallet(address wallet) external view returns (bytes32) { return _walletArtist[wallet]; }
    function releaseArtistOf(bytes32 releaseId) external view returns (bytes32) { return _releaseArtist[releaseId]; }
    function isIssuerApproved(bytes32 artistId, address issuer) external view returns (bool) { return _artistIssuers[artistId][issuer]; }
    function artistIdOf(uint256 tokenId) external view returns (bytes32) {
        if (!_editions[tokenId].exists) revert EditionNotFound(tokenId);
        return _editionArtistId[tokenId];
    }

    /// @notice True when `account` may mint `tokenId` right now.
    function canMint(address account, uint256 tokenId) public view returns (bool) {
        if (!_editions[tokenId].exists) return false;
        bytes32 artistId = _editionArtistId[tokenId];
        if (!_artists[artistId].active) return false;
        return _walletArtist[account] == artistId || _artistIssuers[artistId][account];
    }

    // -------------------------------------------------------------- editions

    /// @dev Token IDs are uint256(keccak256("the-void:edition:v1", releaseId, editionId));
    ///      identical to V2. The zero value is rejected. IDs never depend on database ordering.
    function tokenIdFor(bytes32 releaseId, bytes32 editionId) public pure returns (uint256) {
        uint256 tokenId = uint256(keccak256(abi.encode("the-void:edition:v1", releaseId, editionId)));
        return tokenId == 0 ? 1 : tokenId;
    }

    function createEdition(bytes32 releaseId, bytes32 editionId, uint256 maxSupply, string calldata metadataUri)
        external whenNotPaused returns (uint256 tokenId)
    {
        return _createEdition(releaseId, editionId, maxSupply, metadataUri, msg.sender, 0);
    }

    function createEdition(bytes32 releaseId, bytes32 editionId, uint256 maxSupply, string calldata metadataUri, address payout, uint96 royaltyBps)
        external whenNotPaused returns (uint256 tokenId)
    {
        return _createEdition(releaseId, editionId, maxSupply, metadataUri, payout, royaltyBps);
    }

    function payoutOf(uint256 tokenId) external view returns (address) {
        if (!_editions[tokenId].exists) revert EditionNotFound(tokenId);
        return _payout[tokenId];
    }

    /// @notice The edition's creator wallet while it still acts for the edition's artist, else
    /// address(0). VoidPrimarySale authorizes sale configuration with this, so a wallet that
    /// was removed or moved to another artist keeps no authority over earlier editions.
    /// `edition(tokenId).artist` remains the historical creation record.
    function artistOf(uint256 tokenId) external view returns (address) {
        if (!_editions[tokenId].exists) revert EditionNotFound(tokenId);
        address creator = _editions[tokenId].artist;
        bytes32 artistId = _editionArtistId[tokenId];
        if (_walletArtist[creator] != artistId || !_artists[artistId].active) return address(0);
        return creator;
    }

    function maxSupplyOf(uint256 tokenId) external view returns (uint256) {
        if (!_editions[tokenId].exists) revert EditionNotFound(tokenId);
        return _editions[tokenId].maxSupply;
    }

    function royaltyBpsOf(uint256 tokenId) external view returns (uint96) {
        if (!_editions[tokenId].exists) revert EditionNotFound(tokenId);
        return _royaltyBps[tokenId];
    }

    function royaltyInfo(uint256 tokenId, uint256 salePrice) external view returns (address receiver, uint256 royaltyAmount) {
        if (!_editions[tokenId].exists) revert EditionNotFound(tokenId);
        receiver = _payout[tokenId];
        royaltyAmount = (salePrice * _royaltyBps[tokenId]) / BPS_DENOMINATOR;
    }

    function edition(uint256 tokenId) external view returns (Edition memory) {
        if (!_editions[tokenId].exists) revert EditionNotFound(tokenId);
        return _editions[tokenId];
    }
    function uri(uint256 tokenId) public view returns (string memory) {
        if (!_editions[tokenId].exists) revert EditionNotFound(tokenId);
        return _editions[tokenId].metadataUri;
    }

    // ---------------------------------------------------------------- ERC-1155

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

    function mint(address to, uint256 tokenId, uint256 amount, bytes calldata data) external whenNotPaused {
        if (to == address(0)) revert InvalidAddress();
        _authorizeMint(tokenId);
        _consumeSupply(tokenId, amount);
        _balances[tokenId][to] += amount;
        emit TransferSingle(msg.sender, address(0), to, tokenId, amount);
        _checkOnERC1155Received(msg.sender, address(0), to, tokenId, amount, data);
    }
    function mintBatch(address to, uint256[] calldata ids, uint256[] calldata amounts, bytes calldata data) external whenNotPaused {
        if (to == address(0)) revert InvalidAddress();
        if (ids.length != amounts.length) revert LengthMismatch();
        for (uint256 i; i < ids.length; ++i) { _authorizeMint(ids[i]); _consumeSupply(ids[i], amounts[i]); }
        for (uint256 i; i < ids.length; ++i) _balances[ids[i]][to] += amounts[i];
        emit TransferBatch(msg.sender, address(0), to, ids, amounts);
        _checkOnERC1155BatchReceived(msg.sender, address(0), to, ids, amounts, data);
    }
    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata data) external whenNotPaused {
        if (from != msg.sender && !_operatorApprovals[from][msg.sender]) revert AccessDenied(bytes32(0), msg.sender);
        if (to == address(0)) revert InvalidAddress();
        uint256 available = _balances[id][from];
        if (available < amount) revert InsufficientBalance(from, id, available, amount);
        unchecked { _balances[id][from] = available - amount; }
        _balances[id][to] += amount;
        emit TransferSingle(msg.sender, from, to, id, amount);
        _checkOnERC1155Received(msg.sender, from, to, id, amount, data);
    }
    function safeBatchTransferFrom(address from, address to, uint256[] calldata ids, uint256[] calldata amounts, bytes calldata data) external whenNotPaused {
        if (from != msg.sender && !_operatorApprovals[from][msg.sender]) revert AccessDenied(bytes32(0), msg.sender);
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
        return interfaceId == 0x01ffc9a7 || interfaceId == 0xd9b67a26 || interfaceId == 0x0e89341c || interfaceId == 0x2a55205a;
    }

    // ---------------------------------------------------------------- internal

    function _activeArtistOf(address wallet) internal view returns (bytes32 artistId) {
        artistId = _walletArtist[wallet];
        if (artistId == bytes32(0)) revert NotArtistWallet(wallet);
        if (!_artists[artistId].active) revert ArtistInactive(artistId);
    }

    function _authorizeMint(uint256 tokenId) internal view {
        if (!_editions[tokenId].exists) revert EditionNotFound(tokenId);
        bytes32 artistId = _editionArtistId[tokenId];
        if (!_artists[artistId].active) revert ArtistInactive(artistId);
        if (_walletArtist[msg.sender] != artistId && !_artistIssuers[artistId][msg.sender]) {
            revert NotAuthorizedMinter(tokenId, artistId, msg.sender);
        }
    }

    function _createEdition(bytes32 releaseId, bytes32 editionId, uint256 maxSupply, string calldata metadataUri, address payout, uint96 royaltyBps)
        internal returns (uint256 tokenId)
    {
        bytes32 artistId = _activeArtistOf(msg.sender);
        if (releaseId == bytes32(0) || editionId == bytes32(0)) revert InvalidIdentifier();
        bytes32 owner = _releaseArtist[releaseId];
        if (owner == bytes32(0)) revert ReleaseNotBound(releaseId);
        if (owner != artistId) revert ReleaseOwnedByAnotherArtist(releaseId, owner, artistId);
        if (maxSupply == 0) revert InvalidSupply();
        if (payout == address(0)) revert InvalidAddress();
        if (royaltyBps > MAX_ROYALTY_BPS) revert RoyaltyTooHigh(royaltyBps, MAX_ROYALTY_BPS);
        tokenId = tokenIdFor(releaseId, editionId);
        if (_editions[tokenId].exists) revert AlreadyInitialized(tokenId);
        _editions[tokenId] = Edition(releaseId, editionId, msg.sender, maxSupply, 0, metadataUri, true);
        _editionArtistId[tokenId] = artistId;
        _payout[tokenId] = payout;
        _royaltyBps[tokenId] = royaltyBps;
        emit EditionCreated(tokenId, releaseId, editionId, msg.sender, maxSupply, metadataUri);
        emit EditionArtist(tokenId, artistId);
        emit RoyaltyConfigured(tokenId, payout, royaltyBps);
        emit URI(metadataUri, tokenId);
    }

    function _grantRole(bytes32 role, address account) internal { if (!_roles[role][account]) { _roles[role][account] = true; emit RoleGranted(role, account, msg.sender); } }
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
            try IERC1155ReceiverV3(to).onERC1155Received(operator, from, id, amount, data) returns (bytes4 response) {
                if (response != IERC1155ReceiverV3.onERC1155Received.selector) revert UnsafeRecipient();
            } catch { revert UnsafeRecipient(); }
        }
    }
    function _checkOnERC1155BatchReceived(address operator, address from, address to, uint256[] calldata ids, uint256[] calldata amounts, bytes calldata data) private {
        if (to.code.length != 0) {
            try IERC1155ReceiverV3(to).onERC1155BatchReceived(operator, from, ids, amounts, data) returns (bytes4 response) {
                if (response != IERC1155ReceiverV3.onERC1155BatchReceived.selector) revert UnsafeRecipient();
            } catch { revert UnsafeRecipient(); }
        }
    }
}

interface IERC1155ReceiverV3 {
    function onERC1155Received(address operator, address from, uint256 id, uint256 value, bytes calldata data) external returns (bytes4);
    function onERC1155BatchReceived(address operator, address from, uint256[] calldata ids, uint256[] calldata values, bytes calldata data) external returns (bytes4);
}
