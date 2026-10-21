// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC1155ReleaseMarketplace, IVoidReleaseRegistryMarketplace, IERC1155ReceiverReleaseMarketplace} from "./ReleaseMarketplaceV3.sol";
import {IReleaseRoyaltyPolicyMarketplace} from "./ReleaseMarketplaceV4.sol";

/// @title The Void's single resale marketplace for factory releases and the Genesis collection
/// @notice NOT DEPLOYED. Ownerless and fully immutable: no admin, no setter, no pause, no allowlist that can grow.
/// Every listing is classified once, from immutables only, into exactly one of two economic paths:
///
///   FACTORY_RELEASE  `tokenContract` is registered by `releaseFactory` or `legacyReleaseFactory` (`isRelease`).
///                    Same rules as ReleaseMarketplaceV4: the edition's royalty must be exactly 250 bps to a payout
///                    other than the fee recipient, and ERC-2981 must agree. Settlement: 2.5% platform, 2.5% royalty
///                    to the edition payout, remainder (95% + rounding dust) to the seller.
///   GENESIS          `tokenContract == genesisCollection` and `tokenId <= genesisMaxTokenId`. No factory method is
///                    called. ERC-2981 `royaltyInfo` is read with a bounded staticcall and must report exactly
///                    `genesisRoyaltyReceiver` and exactly 500 bps of the sale price. Settlement: 0% platform, 5%
///                    royalty to that receiver, remainder (95% + dust) to the seller. Genesis is never modified.
///
/// Anything else reverts `UnsupportedAsset`. The Genesis exception is an equality check on one immutable address, so
/// it cannot admit any other contract, and it never skips the registry check for a factory release.
/// @dev Payment is native AVAX only. Non-custodial: tokens move only inside `buy`, and delivery is verified by the
/// buyer's balance delta. Any failed payout or delivery reverts the whole sale.
contract VoidUnifiedMarketplace is IERC1155ReceiverReleaseMarketplace {
    enum Status { ACTIVE, SOLD, CANCELLED, EXPIRED }
    enum AssetClass { UNSUPPORTED, FACTORY_RELEASE, GENESIS }
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
    uint256 public constant FACTORY_PLATFORM_FEE_BPS = 250;
    uint96 public constant FACTORY_ROYALTY_BPS = 250;
    uint256 public constant GENESIS_PLATFORM_FEE_BPS = 0;
    uint256 public constant GENESIS_ROYALTY_BPS = 500;
    uint256 private constant ROYALTY_READ_GAS = 100_000;

    address public immutable feeRecipient;
    IVoidReleaseRegistryMarketplace public immutable releaseFactory;
    /// @notice Optional second registry (the production factory 0x262B…757b on mainnet); address(0) disables it.
    IVoidReleaseRegistryMarketplace public immutable legacyReleaseFactory;
    address public immutable genesisCollection;
    uint256 public immutable genesisMaxTokenId;
    address public immutable genesisRoyaltyReceiver;
    uint256 public immutable deploymentChainId;

    uint256 public nextListingId = 1;
    mapping(uint256 => Listing) private listings;
    bool private entered;

    event ListingCreated(uint256 indexed listingId, address indexed seller, address indexed tokenContract, uint256 tokenId, uint256 amount, uint256 price, uint64 expiresAt);
    event ListingCancelled(uint256 indexed listingId);
    event ListingExpired(uint256 indexed listingId);
    /// @dev Same signature as ReleaseMarketplaceV4.ListingSold, so existing indexers decode it unchanged.
    event ListingSold(uint256 indexed listingId, address indexed buyer, address indexed seller, address tokenContract, uint256 tokenId, uint256 amount, uint256 price, uint256 platformFee, uint256 royalty);
    /// @notice Emitted with every ListingSold: the asset class and every recipient and amount actually paid.
    event SaleSettled(uint256 indexed listingId, AssetClass indexed assetClass, address royaltyReceiver, uint256 sellerProceeds);

    error InvalidAddress(); error InvalidAmount(); error InvalidPrice(); error InvalidExpiry(); error ListingNotActive(); error NotSeller();
    error Expired(); error IncorrectPayment(); error InsufficientBalance(); error InsufficientApproval(); error InsufficientQuantity();
    error RoyaltyTooHigh(); error TransferFailed(); error Reentrancy(); error WrongDeploymentChain(uint256 expected, uint256 actual);
    error UnsupportedAsset(); error RoyaltyPolicyViolation(); error SelfPurchase(); error TokensNotDelivered(); error UnknownListing();

    constructor(
        address feeRecipient_,
        address releaseFactory_,
        address legacyReleaseFactory_,
        address genesisCollection_,
        uint256 genesisMaxTokenId_,
        address genesisRoyaltyReceiver_
    ) {
        if (feeRecipient_ == address(0) || releaseFactory_ == address(0) || genesisCollection_ == address(0) || genesisRoyaltyReceiver_ == address(0)) revert InvalidAddress();
        if (releaseFactory_ == legacyReleaseFactory_ || genesisCollection_ == releaseFactory_ || genesisCollection_ == legacyReleaseFactory_) revert InvalidAddress();
        if (genesisRoyaltyReceiver_ == feeRecipient_) revert InvalidAddress();
        feeRecipient = feeRecipient_;
        releaseFactory = IVoidReleaseRegistryMarketplace(releaseFactory_);
        legacyReleaseFactory = IVoidReleaseRegistryMarketplace(legacyReleaseFactory_);
        genesisCollection = genesisCollection_;
        genesisMaxTokenId = genesisMaxTokenId_;
        genesisRoyaltyReceiver = genesisRoyaltyReceiver_;
        deploymentChainId = block.chainid;
    }

    // ------------------------------------------------------------------ listings

    function createListing(address tokenContract, address seller, uint256 tokenId, uint256 amount, uint256 price, uint64 expiresAt) external onlyDeploymentChain returns (uint256 listingId) {
        if (seller != msg.sender || seller == address(0) || tokenContract == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        if (price == 0) revert InvalidPrice();
        if (expiresAt != 0 && expiresAt <= block.timestamp) revert InvalidExpiry();
        AssetClass assetClass = _requireSupported(tokenContract, tokenId);
        // Refuse up front a listing whose settlement would fail today, at one unit and at the full quantity.
        _settlement(assetClass, tokenContract, tokenId, price);
        _settlement(assetClass, tokenContract, tokenId, price * amount);
        IERC1155ReleaseMarketplace token = IERC1155ReleaseMarketplace(tokenContract);
        if (token.balanceOf(seller, tokenId) < amount) revert InsufficientBalance();
        if (!token.isApprovedForAll(seller, address(this))) revert InsufficientApproval();
        listingId = nextListingId++;
        listings[listingId] = Listing(listingId, seller, tokenContract, tokenId, amount, price, uint64(block.timestamp), expiresAt, Status.ACTIVE);
        emit ListingCreated(listingId, seller, tokenContract, tokenId, amount, price, expiresAt);
    }

    /// @dev Always available to the seller; classification cannot change for an existing listing.
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
        Listing storage listing = listings[listingId];
        if (listing.seller == address(0) || listing.status != Status.ACTIVE) revert ListingNotActive();
        if (listing.seller == msg.sender) revert SelfPurchase();
        if (listing.expiresAt != 0 && block.timestamp > listing.expiresAt) revert Expired();
        if (quantity == 0 || quantity > listing.amount) revert InsufficientQuantity();
        AssetClass assetClass = _requireSupported(listing.tokenContract, listing.tokenId);
        uint256 salePrice = listing.price * quantity;
        if (msg.value != salePrice) revert IncorrectPayment();
        IERC1155ReleaseMarketplace token = IERC1155ReleaseMarketplace(listing.tokenContract);
        if (token.balanceOf(listing.seller, listing.tokenId) < quantity) revert InsufficientBalance();
        if (!token.isApprovedForAll(listing.seller, address(this))) revert InsufficientApproval();
        // Effects before any external call.
        listing.amount -= quantity;
        if (listing.amount == 0) listing.status = Status.SOLD;
        _settle(listingId, assetClass, listing.seller, listing.tokenContract, listing.tokenId, quantity, salePrice);
    }

    /// @dev Delivers the tokens, then pays platform, royalty and seller. Any failure reverts the whole sale.
    function _settle(uint256 listingId, AssetClass assetClass, address seller, address tokenContract, uint256 tokenId, uint256 quantity, uint256 salePrice) private {
        (uint256 platformFee, address royaltyReceiver, uint256 royaltyAmount, uint256 sellerProceeds) = _settlement(assetClass, tokenContract, tokenId, salePrice);
        _deliver(IERC1155ReleaseMarketplace(tokenContract), seller, tokenId, quantity);
        _pay(feeRecipient, platformFee);
        _pay(royaltyReceiver, royaltyAmount);
        _pay(seller, sellerProceeds);
        emit ListingSold(listingId, msg.sender, seller, tokenContract, tokenId, quantity, salePrice, platformFee, royaltyAmount);
        emit SaleSettled(listingId, assetClass, royaltyReceiver, sellerProceeds);
    }

    // ------------------------------------------------------------------ views

    function getListing(uint256 listingId) external view returns (Listing memory) { return listings[listingId]; }

    function listingStatus(uint256 listingId) external view returns (Status) {
        Listing storage listing = listings[listingId];
        if (listing.seller == address(0)) revert UnknownListing();
        return listing.status;
    }

    /// @notice The economic path for an asset, from immutables and the factory registries only.
    function assetClassOf(address tokenContract, uint256 tokenId) public view returns (AssetClass) {
        if (tokenContract == address(0)) return AssetClass.UNSUPPORTED;
        if (tokenContract == genesisCollection) return tokenId <= genesisMaxTokenId ? AssetClass.GENESIS : AssetClass.UNSUPPORTED;
        if (_registered(releaseFactory, tokenContract) || _registered(legacyReleaseFactory, tokenContract)) return AssetClass.FACTORY_RELEASE;
        return AssetClass.UNSUPPORTED;
    }

    /// @notice How a sale of `salePrice` would settle now; reverts exactly where `buy` would on policy grounds.
    function previewSettlement(address tokenContract, uint256 tokenId, uint256 salePrice) external view returns (AssetClass assetClass, uint256 platformFee, address royaltyReceiver, uint256 royaltyAmount, uint256 sellerProceeds) {
        assetClass = _requireSupported(tokenContract, tokenId);
        (platformFee, royaltyReceiver, royaltyAmount, sellerProceeds) = _settlement(assetClass, tokenContract, tokenId, salePrice);
    }

    // ------------------------------------------------------------------ internals

    function _requireSupported(address tokenContract, uint256 tokenId) private view returns (AssetClass assetClass) {
        assetClass = assetClassOf(tokenContract, tokenId);
        if (assetClass == AssetClass.UNSUPPORTED) revert UnsupportedAsset();
    }

    /// @dev A registry that reverts or returns malformed data counts as "not registered".
    function _registered(IVoidReleaseRegistryMarketplace registry, address tokenContract) private view returns (bool) {
        if (address(registry) == address(0)) return false;
        try registry.isRelease(tokenContract) returns (bool value) { return value; } catch { return false; }
    }

    function _settlement(AssetClass assetClass, address tokenContract, uint256 tokenId, uint256 salePrice)
        private view returns (uint256 platformFee, address royaltyReceiver, uint256 royaltyAmount, uint256 sellerProceeds)
    {
        if (salePrice == 0) revert InvalidPrice();
        if (assetClass == AssetClass.GENESIS) {
            royaltyAmount = (salePrice * GENESIS_ROYALTY_BPS) / BPS_DENOMINATOR;
            (address reported, uint256 reportedAmount) = _readRoyalty(tokenContract, tokenId, salePrice);
            if (reported != genesisRoyaltyReceiver || reportedAmount != royaltyAmount) revert RoyaltyPolicyViolation();
            royaltyReceiver = genesisRoyaltyReceiver;
            platformFee = 0;
        } else {
            royaltyReceiver = _factoryPayout(tokenContract, tokenId);
            royaltyAmount = (salePrice * FACTORY_ROYALTY_BPS) / BPS_DENOMINATOR;
            (address reported, uint256 reportedAmount) = _readRoyalty(tokenContract, tokenId, salePrice);
            if (reported != royaltyReceiver || reportedAmount != royaltyAmount) revert RoyaltyPolicyViolation();
            platformFee = (salePrice * FACTORY_PLATFORM_FEE_BPS) / BPS_DENOMINATOR;
        }
        if (platformFee + royaltyAmount > salePrice) revert RoyaltyTooHigh();
        sellerProceeds = salePrice - platformFee - royaltyAmount;
    }

    /// @dev The edition payout, provided its royalty is exactly FACTORY_ROYALTY_BPS and it is not the fee recipient.
    function _factoryPayout(address tokenContract, uint256 tokenId) private view returns (address payout) {
        IReleaseRoyaltyPolicyMarketplace token = IReleaseRoyaltyPolicyMarketplace(tokenContract);
        uint96 royaltyBps;
        try token.royaltyBpsOf(tokenId) returns (uint96 value) { royaltyBps = value; } catch { revert RoyaltyPolicyViolation(); }
        try token.payoutOf(tokenId) returns (address value) { payout = value; } catch { revert RoyaltyPolicyViolation(); }
        if (royaltyBps != FACTORY_ROYALTY_BPS || payout == address(0) || payout == feeRecipient || payout == address(this)) revert RoyaltyPolicyViolation();
    }

    /// @dev Bounded ERC-2981 read: capped gas and an exact 64-byte return, so a hostile or upgraded collection can neither
    /// burn the sale's gas nor smuggle a dirty address.
    function _readRoyalty(address tokenContract, uint256 tokenId, uint256 salePrice) private view returns (address receiver, uint256 amount) {
        bytes memory callData = abi.encodeWithSelector(0x2a55205a, tokenId, salePrice);
        bool ok;
        uint256 returned;
        uint256 rawReceiver;
        assembly {
            ok := staticcall(ROYALTY_READ_GAS, tokenContract, add(callData, 32), mload(callData), 0, 0)
            returned := returndatasize()
            if and(ok, eq(returned, 64)) {
                returndatacopy(0, 0, 64)
                rawReceiver := mload(0)
                amount := mload(32)
            }
        }
        if (!ok || returned != 64 || rawReceiver > type(uint160).max) revert RoyaltyPolicyViolation();
        receiver = address(uint160(rawReceiver));
    }

    /// @dev Self-purchase is refused in `buy`, so the buyer's balance can rise only through this transfer.
    function _deliver(IERC1155ReleaseMarketplace token, address seller, uint256 tokenId, uint256 quantity) private {
        uint256 before = token.balanceOf(msg.sender, tokenId);
        token.safeTransferFrom(seller, msg.sender, tokenId, quantity, "");
        if (token.balanceOf(msg.sender, tokenId) < before + quantity) revert TokensNotDelivered();
    }

    function _pay(address recipient, uint256 amount) private {
        if (amount == 0) return;
        (bool success,) = payable(recipient).call{value: amount}("");
        if (!success) revert TransferFailed();
    }

    modifier onlyDeploymentChain() { if (block.chainid != deploymentChainId) revert WrongDeploymentChain(deploymentChainId, block.chainid); _; }
    modifier nonReentrant() { if (entered) revert Reentrancy(); entered = true; _; entered = false; }
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) { return this.onERC1155Received.selector; }
    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata) external pure returns (bytes4) { return this.onERC1155BatchReceived.selector; }
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) { return interfaceId == 0x01ffc9a7 || interfaceId == type(IERC1155ReceiverReleaseMarketplace).interfaceId; }
}
