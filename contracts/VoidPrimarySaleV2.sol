// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IVoidCollectionRegistry {
    function isCollection(address collection) external view returns (bool);
}

interface IVoidCollection1155 {
    function ARTIST_ROLE() external view returns (bytes32);
    function hasRole(bytes32 role, address account) external view returns (bool);
    function artistOf(uint256 tokenId) external view returns (address);
    function maxSupplyOf(uint256 tokenId) external view returns (uint256);
    function payoutOf(uint256 tokenId) external view returns (address);
    function mint(address to, uint256 tokenId, uint256 amount, bytes calldata data) external;
}

/// @dev Checks-effects-interactions lock. Reentrant purchase or withdraw calls revert.
abstract contract ReentrancyGuard {
    uint256 private constant NOT_ENTERED = 1;
    uint256 private constant ENTERED = 2;
    uint256 private _status;
    error Reentrancy();

    constructor() {
        _status = NOT_ENTERED;
    }

    modifier nonReentrant() {
        if (_status == ENTERED) revert Reentrancy();
        _status = ENTERED;
        _;
        _status = NOT_ENTERED;
    }
}

/// @title The-Void primary sale V2 (per-collection contracts)
/// @notice Same sale rules as VoidPrimarySale, keyed by (collection, tokenId). It sells only
/// from collections registered in VoidCollectionFactory; each holds ISSUER_ROLE for this
/// contract from initialization. Fans pay native currency. Proceeds are pull payments,
/// split between the edition payout and the platform recipient.
contract VoidPrimarySaleV2 is ReentrancyGuard {
    uint256 public constant BPS_DENOMINATOR = 10_000;

    struct Sale {
        uint256 priceWei;
        uint256 maxSupply;
        uint256 sold;
        uint256 perWalletLimit;
        uint64 startTime;
        uint64 endTime;
        bool paused;
        bool configured;
    }

    IVoidCollectionRegistry public immutable registry;
    address public immutable platformRecipient;
    uint256 public immutable platformFeeCapBps;
    uint256 public platformFeeBps;
    address public owner;
    mapping(address => mapping(uint256 => Sale)) public sales;
    mapping(address => mapping(uint256 => mapping(address => uint256))) public walletPurchased;
    mapping(address => uint256) public balances;

    error InvalidAddress();
    error NotOwner();
    error FeeAboveCap(uint256 requested, uint256 cap);
    error AccessDenied(address account);
    error NotEditionArtist(uint256 tokenId, address artist, address caller);
    error InvalidPrice();
    error InvalidSupply();
    error InvalidWalletLimit();
    error InvalidWindow();
    error SaleNotConfigured(uint256 tokenId);
    error SalePaused(uint256 tokenId);
    error SaleNotStarted(uint256 tokenId);
    error SaleEnded(uint256 tokenId);
    error ZeroQuantity();
    error SoldOut(uint256 tokenId, uint256 remaining, uint256 requested);
    error WalletLimitExceeded(uint256 tokenId, uint256 limit, uint256 already, uint256 requested);
    error WrongPayment(uint256 expected, uint256 actual);
    error NothingToWithdraw();
    error TransferFailed();
    error UnregisteredCollection(address collection);

    event SaleConfigured(
        address indexed collection,
        uint256 indexed tokenId,
        address indexed artist,
        uint256 priceWei,
        uint256 maxSupply,
        uint256 perWalletLimit,
        uint64 startTime,
        uint64 endTime,
        bool paused
    );
    event Purchased(address indexed collection, uint256 indexed tokenId, address indexed buyer, uint256 qty, uint256 paid, uint256 artistCut, uint256 platformCut);
    event PlatformFeeUpdated(uint256 previousBps, uint256 nextBps);
    event Withdrawn(address indexed account, uint256 amount);

    constructor(address registry_, address platformRecipient_, uint256 platformFeeBps_) {
        if (registry_ == address(0) || platformRecipient_ == address(0)) revert InvalidAddress();
        if (platformFeeBps_ > BPS_DENOMINATOR) revert FeeAboveCap(platformFeeBps_, BPS_DENOMINATOR);
        registry = IVoidCollectionRegistry(registry_);
        platformRecipient = platformRecipient_;
        platformFeeCapBps = platformFeeBps_;
        platformFeeBps = platformFeeBps_;
        owner = msg.sender;
    }

    function setPlatformFeeBps(uint256 nextBps) external {
        if (msg.sender != owner) revert NotOwner();
        if (nextBps > platformFeeCapBps) revert FeeAboveCap(nextBps, platformFeeCapBps);
        emit PlatformFeeUpdated(platformFeeBps, nextBps);
        platformFeeBps = nextBps;
    }

    function _collection(address collection) private view returns (IVoidCollection1155) {
        if (!registry.isCollection(collection)) revert UnregisteredCollection(collection);
        return IVoidCollection1155(collection);
    }

    function configureSale(
        address collection,
        uint256 tokenId,
        uint256 priceWei,
        uint256 maxSupply,
        uint256 perWalletLimit,
        uint64 startTime,
        uint64 endTime,
        bool paused
    ) external {
        IVoidCollection1155 releases = _collection(collection);
        if (!releases.hasRole(releases.ARTIST_ROLE(), msg.sender)) revert AccessDenied(msg.sender);
        address artist = releases.artistOf(tokenId);
        uint256 editionSupply = releases.maxSupplyOf(tokenId);
        if (artist != msg.sender) revert NotEditionArtist(tokenId, artist, msg.sender);
        if (priceWei == 0) revert InvalidPrice();
        if (maxSupply == 0 || maxSupply > editionSupply) revert InvalidSupply();
        Sale storage sale = sales[collection][tokenId];
        if (maxSupply < sale.sold) revert InvalidSupply();
        if (perWalletLimit == 0 || perWalletLimit > maxSupply) revert InvalidWalletLimit();
        if (endTime != 0 && startTime != 0 && endTime < startTime) revert InvalidWindow();
        sale.priceWei = priceWei;
        sale.maxSupply = maxSupply;
        sale.perWalletLimit = perWalletLimit;
        sale.startTime = startTime;
        sale.endTime = endTime;
        sale.paused = paused;
        sale.configured = true;
        emit SaleConfigured(collection, tokenId, msg.sender, priceWei, maxSupply, perWalletLimit, startTime, endTime, paused);
    }

    function purchase(address collection, uint256 tokenId, uint256 qty) external payable nonReentrant {
        IVoidCollection1155 releases = _collection(collection);
        Sale storage sale = sales[collection][tokenId];
        if (!sale.configured) revert SaleNotConfigured(tokenId);
        if (sale.paused) revert SalePaused(tokenId);
        if (sale.startTime != 0 && block.timestamp < sale.startTime) revert SaleNotStarted(tokenId);
        if (sale.endTime != 0 && block.timestamp > sale.endTime) revert SaleEnded(tokenId);
        if (qty == 0) revert ZeroQuantity();
        uint256 remaining = sale.maxSupply - sale.sold;
        if (qty > remaining) revert SoldOut(tokenId, remaining, qty);
        uint256 already = walletPurchased[collection][tokenId][msg.sender];
        if (already + qty > sale.perWalletLimit) revert WalletLimitExceeded(tokenId, sale.perWalletLimit, already, qty);
        uint256 paid = sale.priceWei * qty;
        if (msg.value != paid) revert WrongPayment(paid, msg.value);

        sale.sold += qty;
        walletPurchased[collection][tokenId][msg.sender] = already + qty;
        uint256 platformCut = (paid * platformFeeBps) / BPS_DENOMINATOR;
        uint256 artistCut = paid - platformCut;
        address payout = releases.payoutOf(tokenId);
        balances[platformRecipient] += platformCut;
        balances[payout] += artistCut;

        releases.mint(msg.sender, tokenId, qty, "");
        emit Purchased(collection, tokenId, msg.sender, qty, paid, artistCut, platformCut);
    }

    function withdraw() external nonReentrant {
        uint256 amount = balances[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        balances[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }
}
