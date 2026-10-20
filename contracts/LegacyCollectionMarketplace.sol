// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC1155ReleaseMarketplace} from "./ReleaseMarketplaceV3.sol";

/// @notice Native-currency resale marketplace for an explicit allowlist of legacy ERC-1155 collections
/// (the Genesis collection), which are not created by The Void's release factory.
/// @dev Separate from ReleaseMarketplaceV4, whose factory-release trust boundary is untouched.
/// Non-custodial: sellers keep their tokens; this contract moves them only inside `buy`.
/// The 250 bps fee, fee recipient and chain are immutable. The owner can allow or disable a collection, pause,
/// and hand over ownership; it cannot move listings, tokens or AVAX. ERC-2981 only reports a royalty, so
/// settlement here pays it, reading `royaltyInfo` at sale time and refusing the sale if it cannot be paid.
/// Function signatures and event shapes of listing, cancel, expire, buy and getListing match V4.
contract LegacyCollectionMarketplace {
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
    /// @dev `maxRoyaltyBps` caps what the collection's own royalty may charge; it never sets the royalty.
    struct Collection {
        bool enabled;
        uint16 maxRoyaltyBps;
        uint256 minTokenId;
        uint256 maxTokenId;
    }

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant REQUIRED_PLATFORM_FEE_BPS = 250;
    uint16 public constant ROYALTY_CEILING_BPS = 1_000;
    bytes4 private constant ERC1155_INTERFACE_ID = 0xd9b67a26;
    bytes4 private constant ERC2981_INTERFACE_ID = 0x2a55205a;

    uint256 public nextListingId = 1;
    address public immutable feeRecipient;
    uint256 public immutable platformFeeBps;
    uint256 public immutable deploymentChainId;
    address public owner;
    address public pendingOwner;
    bool public paused;
    mapping(address => Collection) private collections;
    mapping(uint256 => Listing) private listings;
    bool private entered;

    event ListingCreated(uint256 indexed listingId, address indexed seller, address indexed tokenContract, uint256 tokenId, uint256 amount, uint256 price, uint64 expiresAt);
    event ListingCancelled(uint256 indexed listingId);
    event ListingExpired(uint256 indexed listingId);
    event ListingSold(uint256 indexed listingId, address indexed buyer, address indexed seller, address tokenContract, uint256 tokenId, uint256 amount, uint256 price, uint256 platformFee, uint256 royalty);
    event CollectionAllowed(address indexed tokenContract, uint16 maxRoyaltyBps, uint256 minTokenId, uint256 maxTokenId);
    event CollectionDisabled(address indexed tokenContract);
    event Paused(bool paused);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error InvalidAddress(); error InvalidAmount(); error InvalidPrice(); error InvalidExpiry(); error ListingNotActive(); error NotSeller();
    error Expired(); error IncorrectPayment(); error InsufficientBalance(); error InsufficientApproval(); error InsufficientQuantity();
    error FeeTooHigh(); error RoyaltyTooHigh(); error TransferFailed(); error Reentrancy(); error WrongDeploymentChain(uint256 expected, uint256 actual);
    error NotOwner(); error PausedMarket(); error UnsupportedCollection(); error UnsupportedToken(); error InvalidCollectionConfig();
    error RoyaltyReadFailed(); error RoyaltyAboveCap(); error InvalidRoyaltyReceiver();

    constructor(address feeRecipient_, uint256 platformFeeBps_, address owner_) {
        if (feeRecipient_ == address(0) || owner_ == address(0)) revert InvalidAddress();
        if (platformFeeBps_ != REQUIRED_PLATFORM_FEE_BPS) revert FeeTooHigh();
        feeRecipient = feeRecipient_;
        platformFeeBps = platformFeeBps_;
        owner = owner_;
        deploymentChainId = block.chainid;
    }

    // ------------------------------------------------------------------ administration (no access to funds or listings)

    /// @notice Allow one explicit collection and token-id range. Re-calling replaces its policy.
    function allowCollection(address tokenContract, uint16 maxRoyaltyBps, uint256 minTokenId, uint256 maxTokenId) external onlyOwner {
        if (tokenContract == address(0) || tokenContract.code.length == 0) revert InvalidAddress();
        if (maxRoyaltyBps > ROYALTY_CEILING_BPS || minTokenId > maxTokenId) revert InvalidCollectionConfig();
        if (!_supportsInterface(tokenContract, ERC1155_INTERFACE_ID) || !_supportsInterface(tokenContract, ERC2981_INTERFACE_ID)) revert UnsupportedCollection();
        collections[tokenContract] = Collection(true, maxRoyaltyBps, minTokenId, maxTokenId);
        emit CollectionAllowed(tokenContract, maxRoyaltyBps, minTokenId, maxTokenId);
    }

    function disableCollection(address tokenContract) external onlyOwner {
        delete collections[tokenContract];
        emit CollectionDisabled(tokenContract);
    }

    function setPaused(bool value) external onlyOwner {
        paused = value;
        emit Paused(value);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // ------------------------------------------------------------------ listings

    function createListing(address tokenContract, address seller, uint256 tokenId, uint256 amount, uint256 price, uint64 expiresAt) external onlyDeploymentChain returns (uint256 listingId) {
        if (paused) revert PausedMarket();
        if (seller != msg.sender || seller == address(0) || tokenContract == address(0)) revert InvalidAddress();
        _requireSupported(tokenContract, tokenId);
        if (amount == 0) revert InvalidAmount();
        if (price == 0) revert InvalidPrice();
        if (expiresAt != 0 && expiresAt <= block.timestamp) revert InvalidExpiry();
        IERC1155ReleaseMarketplace token = IERC1155ReleaseMarketplace(tokenContract);
        if (token.balanceOf(seller, tokenId) < amount) revert InsufficientBalance();
        if (!token.isApprovedForAll(seller, address(this))) revert InsufficientApproval();
        // A listing whose royalty cannot be settled today is refused up front rather than left unbuyable.
        _settlement(tokenContract, tokenId, price);
        listingId = nextListingId++;
        listings[listingId] = Listing(listingId, seller, tokenContract, tokenId, amount, price, uint64(block.timestamp), expiresAt, Status.ACTIVE);
        emit ListingCreated(listingId, seller, tokenContract, tokenId, amount, price, expiresAt);
    }

    /// @dev Always available to the seller, including while paused or after the collection is disabled.
    function cancelListing(uint256 listingId) external onlyDeploymentChain {
        Listing storage listing = listings[listingId];
        if (listing.seller == address(0) || listing.status != Status.ACTIVE) revert ListingNotActive();
        if (listing.seller != msg.sender) revert NotSeller();
        listing.status = Status.CANCELLED;
        emit ListingCancelled(listingId);
    }

    function expireListing(uint256 listingId) external onlyDeploymentChain {
        Listing storage listing = listings[listingId];
        if (listing.seller == address(0) || listing.status != Status.ACTIVE) revert ListingNotActive();
        if (listing.expiresAt == 0 || block.timestamp <= listing.expiresAt) revert InvalidExpiry();
        listing.status = Status.EXPIRED;
        emit ListingExpired(listingId);
    }

    function buy(uint256 listingId, uint256 quantity) external payable nonReentrant onlyDeploymentChain {
        if (paused) revert PausedMarket();
        Listing storage listing = listings[listingId];
        if (listing.seller == address(0) || listing.status != Status.ACTIVE) revert ListingNotActive();
        if (listing.expiresAt != 0 && block.timestamp > listing.expiresAt) revert Expired();
        if (quantity == 0 || quantity > listing.amount) revert InsufficientQuantity();
        _requireSupported(listing.tokenContract, listing.tokenId);
        uint256 salePrice = listing.price * quantity;
        if (msg.value != salePrice) revert IncorrectPayment();
        IERC1155ReleaseMarketplace token = IERC1155ReleaseMarketplace(listing.tokenContract);
        if (token.balanceOf(listing.seller, listing.tokenId) < quantity) revert InsufficientBalance();
        if (!token.isApprovedForAll(listing.seller, address(this))) revert InsufficientApproval();
        // Effects before any external call.
        listing.amount -= quantity;
        if (listing.amount == 0) listing.status = Status.SOLD;
        _settle(listingId, listing.seller, listing.tokenContract, listing.tokenId, quantity, salePrice);
    }

    /// @dev Moves the tokens, then pays the platform fee, the collection's royalty and finally the seller.
    /// Any failed transfer reverts the entire sale, including the token transfer and the listing update.
    function _settle(uint256 listingId, address seller, address tokenContract, uint256 tokenId, uint256 quantity, uint256 salePrice) private {
        (uint256 platformFee, address royaltyReceiver, uint256 royaltyAmount, uint256 sellerProceeds) = _settlement(tokenContract, tokenId, salePrice);
        IERC1155ReleaseMarketplace(tokenContract).safeTransferFrom(seller, msg.sender, tokenId, quantity, "");
        _pay(feeRecipient, platformFee);
        _pay(royaltyReceiver, royaltyAmount);
        _pay(seller, sellerProceeds);
        emit ListingSold(listingId, msg.sender, seller, tokenContract, tokenId, quantity, salePrice, platformFee, royaltyAmount);
    }

    // ------------------------------------------------------------------ views

    function getListing(uint256 listingId) external view returns (Listing memory) { return listings[listingId]; }
    function listingStatus(uint256 listingId) external view returns (Status) { return listings[listingId].status; }
    function getCollection(address tokenContract) external view returns (Collection memory) { return collections[tokenContract]; }
    function isSupported(address tokenContract, uint256 tokenId) public view returns (bool) {
        Collection storage collection = collections[tokenContract];
        return collection.enabled && tokenId >= collection.minTokenId && tokenId <= collection.maxTokenId;
    }
    /// @notice Preview of how a sale of `salePrice` settles today (reverts exactly where `buy` would).
    function previewSettlement(address tokenContract, uint256 tokenId, uint256 salePrice) external view returns (uint256 platformFee, address royaltyReceiver, uint256 royaltyAmount, uint256 sellerProceeds) {
        _requireSupported(tokenContract, tokenId);
        return _settlement(tokenContract, tokenId, salePrice);
    }

    // ------------------------------------------------------------------ internals

    function _requireSupported(address tokenContract, uint256 tokenId) private view {
        Collection storage collection = collections[tokenContract];
        if (!collection.enabled) revert UnsupportedCollection();
        if (tokenId < collection.minTokenId || tokenId > collection.maxTokenId) revert UnsupportedToken();
    }

    /// @dev Fee, royalty and seller proceeds for one sale. The royalty is whatever the collection reports for this
    /// token and price, provided it is within the collection's cap and payable; otherwise the sale is refused.
    function _settlement(address tokenContract, uint256 tokenId, uint256 salePrice) private view returns (uint256 platformFee, address royaltyReceiver, uint256 royaltyAmount, uint256 sellerProceeds) {
        (bool ok, bytes memory data) = tokenContract.staticcall(abi.encodeWithSignature("royaltyInfo(uint256,uint256)", tokenId, salePrice));
        if (!ok || data.length != 64) revert RoyaltyReadFailed();
        uint256 rawReceiver;
        (rawReceiver, royaltyAmount) = abi.decode(data, (uint256, uint256));
        if (rawReceiver > type(uint160).max) revert RoyaltyReadFailed();
        royaltyReceiver = address(uint160(rawReceiver));
        if (royaltyAmount > (salePrice * collections[tokenContract].maxRoyaltyBps) / BPS_DENOMINATOR) revert RoyaltyAboveCap();
        if (royaltyAmount != 0 && (royaltyReceiver == address(0) || royaltyReceiver == address(this))) revert InvalidRoyaltyReceiver();
        platformFee = (salePrice * platformFeeBps) / BPS_DENOMINATOR;
        if (platformFee + royaltyAmount > salePrice) revert RoyaltyTooHigh();
        sellerProceeds = salePrice - platformFee - royaltyAmount;
    }

    function _supportsInterface(address tokenContract, bytes4 interfaceId) private view returns (bool) {
        (bool ok, bytes memory data) = tokenContract.staticcall{gas: 30_000}(abi.encodeWithSignature("supportsInterface(bytes4)", interfaceId));
        return ok && data.length == 32 && abi.decode(data, (uint256)) == 1;
    }

    function _pay(address recipient, uint256 amount) private {
        if (amount == 0) return;
        (bool success,) = payable(recipient).call{value: amount}("");
        if (!success) revert TransferFailed();
    }

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }
    modifier onlyDeploymentChain() { if (block.chainid != deploymentChainId) revert WrongDeploymentChain(deploymentChainId, block.chainid); _; }
    modifier nonReentrant() { if (entered) revert Reentrancy(); entered = true; _; entered = false; }
}
