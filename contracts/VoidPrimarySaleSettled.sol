// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVoidRelease1155V2, ReentrancyGuard} from "./VoidPrimarySale.sol";

/// @title The-Void primary sale, automatic platform settlement
/// @notice Same sale desk as VoidPrimarySale with one change to settlement. The platform
/// share is transferred to `platformRecipient` inside the purchase transaction. The artist
/// share is still credited to `balances[payoutOf(tokenId)]` and is pulled with `withdraw()`.
/// If the platform transfer fails, the whole purchase reverts: no mint, no credit, no event.
/// `balances[platformRecipient]` is never credited by this contract. The fee is the constant
/// PLATFORM_FEE_BPS and there is no owner: nobody can lower, raise or redirect it after deployment.
/// NOT DEPLOYED. The production sale 0x6ae84a51f100f10f0535a514555043ae9edf9aa3 runs
/// VoidPrimarySale (pull payments for both shares) and is immutable.
contract VoidPrimarySaleSettled is ReentrancyGuard {
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

    /// @dev The established platform fee on a primary sale (2.5%). Fixed at compile time.
    uint256 public constant PLATFORM_FEE_BPS = 250;

    IVoidRelease1155V2 public immutable releases;
    address public immutable platformRecipient;
    mapping(uint256 => Sale) public sales;
    mapping(uint256 => mapping(address => uint256)) public walletPurchased;
    mapping(address => uint256) public balances;

    error InvalidAddress();
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
    error PlatformTransferFailed(address recipient, uint256 amount);

    event SaleConfigured(
        uint256 indexed tokenId,
        address indexed artist,
        uint256 priceWei,
        uint256 maxSupply,
        uint256 perWalletLimit,
        uint64 startTime,
        uint64 endTime,
        bool paused
    );
    event Purchased(uint256 indexed tokenId, address indexed buyer, uint256 qty, uint256 paid, uint256 artistCut, uint256 platformCut);
    event Withdrawn(address indexed account, uint256 amount);
    event PlatformPaid(address indexed recipient, uint256 amount);

    constructor(address releases_, address platformRecipient_) {
        if (releases_ == address(0) || platformRecipient_ == address(0)) revert InvalidAddress();
        releases = IVoidRelease1155V2(releases_);
        platformRecipient = platformRecipient_;
    }

    function configureSale(
        uint256 tokenId,
        uint256 priceWei,
        uint256 maxSupply,
        uint256 perWalletLimit,
        uint64 startTime,
        uint64 endTime,
        bool paused
    ) external {
        if (!releases.hasRole(releases.ARTIST_ROLE(), msg.sender)) revert AccessDenied(msg.sender);
        address artist = releases.artistOf(tokenId);
        uint256 editionSupply = releases.maxSupplyOf(tokenId);
        if (artist != msg.sender) revert NotEditionArtist(tokenId, artist, msg.sender);
        if (priceWei == 0) revert InvalidPrice();
        // editionSupply 0 is an open edition. Its sale may also use maxSupply 0
        // (no sale cap). The end time is the close; endTime 0 is rejected.
        // A capped edition still requires 0 < sale supply <= edition supply.
        bool openEdition = editionSupply == 0;
        if (openEdition) {
            if (endTime == 0) revert InvalidWindow();
        } else if (maxSupply == 0 || maxSupply > editionSupply) {
            revert InvalidSupply();
        }
        Sale storage sale = sales[tokenId];
        if (maxSupply != 0 && maxSupply < sale.sold) revert InvalidSupply();
        if (openEdition) {
            // perWalletLimit 0 means no per-wallet cap. A positive limit still applies,
            // and cannot exceed a positive sale cap.
            if (maxSupply != 0 && perWalletLimit > maxSupply) revert InvalidWalletLimit();
        } else if (perWalletLimit == 0 || perWalletLimit > maxSupply) {
            revert InvalidWalletLimit();
        }
        if (endTime != 0 && startTime != 0 && endTime < startTime) revert InvalidWindow();
        sale.priceWei = priceWei;
        sale.maxSupply = maxSupply;
        sale.perWalletLimit = perWalletLimit;
        sale.startTime = startTime;
        sale.endTime = endTime;
        sale.paused = paused;
        sale.configured = true;
        emit SaleConfigured(tokenId, msg.sender, priceWei, maxSupply, perWalletLimit, startTime, endTime, paused);
    }

    function purchase(uint256 tokenId, uint256 qty) external payable nonReentrant {
        Sale storage sale = sales[tokenId];
        if (!sale.configured) revert SaleNotConfigured(tokenId);
        if (sale.paused) revert SalePaused(tokenId);
        if (sale.startTime != 0 && block.timestamp < sale.startTime) revert SaleNotStarted(tokenId);
        if (sale.endTime != 0 && block.timestamp > sale.endTime) revert SaleEnded(tokenId);
        if (qty == 0) revert ZeroQuantity();
        // Sale maxSupply 0 does not cap copies. The end time is what closes the sale.
        if (sale.maxSupply != 0) {
            uint256 remaining = sale.maxSupply - sale.sold;
            if (qty > remaining) revert SoldOut(tokenId, remaining, qty);
        }
        uint256 already = walletPurchased[tokenId][msg.sender];
        // perWalletLimit 0 means no per-wallet cap (open editions only).
        if (sale.perWalletLimit != 0 && already + qty > sale.perWalletLimit) {
            revert WalletLimitExceeded(tokenId, sale.perWalletLimit, already, qty);
        }
        uint256 paid = sale.priceWei * qty;
        if (msg.value != paid) revert WrongPayment(paid, msg.value);

        sale.sold += qty;
        walletPurchased[tokenId][msg.sender] = already + qty;
        uint256 platformCut = (paid * PLATFORM_FEE_BPS) / BPS_DENOMINATOR;
        uint256 artistCut = paid - platformCut;
        address payout = releases.payoutOf(tokenId);
        balances[payout] += artistCut;

        releases.mint(msg.sender, tokenId, qty, "");
        // Platform share is pushed last, after all state changes. A failed transfer reverts
        // the purchase; Purchased is only emitted once the platform share has been delivered.
        if (platformCut != 0) {
            (bool ok,) = platformRecipient.call{value: platformCut}("");
            if (!ok) revert PlatformTransferFailed(platformRecipient, platformCut);
            emit PlatformPaid(platformRecipient, platformCut);
        }
        emit Purchased(tokenId, msg.sender, qty, paid, artistCut, platformCut);
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
