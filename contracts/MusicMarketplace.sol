// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC1155Marketplace {
    function balanceOf(address account, uint256 id) external view returns (uint256);
    function isApprovedForAll(address account, address operator) external view returns (bool);
    function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes calldata data) external;
}

interface IERC2981Marketplace {
    function royaltyInfo(uint256 tokenId, uint256 salePrice) external view returns (address receiver, uint256 royaltyAmount);
}

interface IERC1155ReceiverMarketplace {
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4);
    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata) external pure returns (bytes4);
}

/// @notice Approval-based, non-custodial native-currency listings for arbitrary ERC-1155 contracts.
/// @dev Listing price is the native-currency unit price. A listing may be filled partially.
contract MusicMarketplace is IERC1155ReceiverMarketplace {
    enum Status { ACTIVE, SOLD, CANCELLED, EXPIRED }

    struct Listing {
        uint256 listingId;
        address seller;
        address tokenContract;
        uint256 tokenId;
        uint256 amount;
        uint256 price;
        uint64 createdAt;
        uint64 expiresAt;
        Status status;
    }

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public nextListingId = 1;
    address public immutable feeRecipient;
    uint256 public immutable platformFeeBps;
    mapping(uint256 => Listing) private listings;
    bool private entered;

    event ListingCreated(uint256 indexed listingId, address indexed seller, address indexed tokenContract, uint256 tokenId, uint256 amount, uint256 price, uint64 expiresAt);
    event ListingCancelled(uint256 indexed listingId);
    event ListingExpired(uint256 indexed listingId);
    event ListingSold(uint256 indexed listingId, address indexed buyer, address indexed seller, address tokenContract, uint256 tokenId, uint256 amount, uint256 price, uint256 platformFee, uint256 royalty);

    error InvalidAddress();
    error InvalidAmount();
    error InvalidPrice();
    error InvalidExpiry();
    error NotOwnerOrApproved();
    error ListingNotActive();
    error NotSeller();
    error Expired();
    error IncorrectPayment();
    error InsufficientBalance();
    error InsufficientApproval();
    error InsufficientQuantity();
    error FeeTooHigh();
    error RoyaltyTooHigh();
    error TransferFailed();
    error Reentrancy();

    constructor(address feeRecipient_, uint256 platformFeeBps_) {
        if (feeRecipient_ == address(0)) revert InvalidAddress();
        if (platformFeeBps_ > BPS_DENOMINATOR) revert FeeTooHigh();
        feeRecipient = feeRecipient_;
        platformFeeBps = platformFeeBps_;
    }

    function createListing(address tokenContract, address seller, uint256 tokenId, uint256 amount, uint256 price, uint64 expiresAt) external returns (uint256 listingId) {
        if (seller != msg.sender || seller == address(0) || tokenContract == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        if (price == 0) revert InvalidPrice();
        if (expiresAt != 0 && expiresAt <= block.timestamp) revert InvalidExpiry();
        IERC1155Marketplace token = IERC1155Marketplace(tokenContract);
        if (token.balanceOf(seller, tokenId) < amount) revert InsufficientBalance();
        if (!token.isApprovedForAll(seller, address(this))) revert InsufficientApproval();
        listingId = nextListingId++;
        listings[listingId] = Listing(listingId, seller, tokenContract, tokenId, amount, price, uint64(block.timestamp), expiresAt, Status.ACTIVE);
        emit ListingCreated(listingId, seller, tokenContract, tokenId, amount, price, expiresAt);
    }

    function cancelListing(uint256 listingId) external {
        Listing storage listing = listings[listingId];
        if (listing.status != Status.ACTIVE) revert ListingNotActive();
        if (listing.seller != msg.sender) revert NotSeller();
        listing.status = Status.CANCELLED;
        emit ListingCancelled(listingId);
    }

    function expireListing(uint256 listingId) external {
        Listing storage listing = listings[listingId];
        if (listing.status != Status.ACTIVE) revert ListingNotActive();
        if (listing.expiresAt == 0 || block.timestamp <= listing.expiresAt) revert InvalidExpiry();
        listing.status = Status.EXPIRED;
        emit ListingExpired(listingId);
    }

    function buy(uint256 listingId, uint256 quantity) external payable nonReentrant {
        Listing storage listing = listings[listingId];
        if (listing.status != Status.ACTIVE) revert ListingNotActive();
        if (listing.expiresAt != 0 && block.timestamp > listing.expiresAt) revert Expired();
        if (quantity == 0 || quantity > listing.amount) revert InsufficientQuantity();
        uint256 salePrice = listing.price * quantity;
        if (msg.value != salePrice) revert IncorrectPayment();
        if (IERC1155Marketplace(listing.tokenContract).balanceOf(listing.seller, listing.tokenId) < quantity) revert InsufficientBalance();
        if (!IERC1155Marketplace(listing.tokenContract).isApprovedForAll(listing.seller, address(this))) revert InsufficientApproval();

        listing.amount -= quantity;
        if (listing.amount == 0) listing.status = Status.SOLD;
        uint256 platformFee = (salePrice * platformFeeBps) / BPS_DENOMINATOR;
        (address royaltyReceiver, uint256 royaltyAmount) = _royalty(listing.tokenContract, listing.tokenId, salePrice);
        if (royaltyAmount > salePrice - platformFee) revert RoyaltyTooHigh();
        uint256 sellerProceeds = salePrice - platformFee - royaltyAmount;

        IERC1155Marketplace(listing.tokenContract).safeTransferFrom(listing.seller, msg.sender, listing.tokenId, quantity, "");
        _pay(feeRecipient, platformFee);
        _pay(royaltyReceiver, royaltyAmount);
        _pay(listing.seller, sellerProceeds);
        emit ListingSold(listingId, msg.sender, listing.seller, listing.tokenContract, listing.tokenId, quantity, salePrice, platformFee, royaltyAmount);
    }

    function getListing(uint256 listingId) external view returns (Listing memory) { return listings[listingId]; }
    function listingStatus(uint256 listingId) external view returns (Status) { return listings[listingId].status; }

    function _royalty(address tokenContract, uint256 tokenId, uint256 salePrice) private view returns (address receiver, uint256 amount) {
        try IERC2981Marketplace(tokenContract).royaltyInfo(tokenId, salePrice) returns (address receiver_, uint256 amount_) {
            if (receiver_ != address(0)) return (receiver_, amount_);
        } catch {}
        return (address(0), 0);
    }

    function _pay(address recipient, uint256 amount) private {
        if (amount == 0) return;
        (bool success,) = payable(recipient).call{value: amount}("");
        if (!success) revert TransferFailed();
    }

    modifier nonReentrant() {
        if (entered) revert Reentrancy();
        entered = true;
        _;
        entered = false;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) { return this.onERC1155Received.selector; }
    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata) external pure returns (bytes4) { return this.onERC1155BatchReceived.selector; }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == type(IERC1155ReceiverMarketplace).interfaceId;
    }
}
