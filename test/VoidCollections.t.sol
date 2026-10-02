// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VoidCollection1155} from "../contracts/VoidCollection1155.sol";
import {VoidCollectionFactory} from "../contracts/VoidCollectionFactory.sol";
import {VoidPrimarySaleV2} from "../contracts/VoidPrimarySaleV2.sol";
import {MusicMarketplaceV2} from "../contracts/MusicMarketplaceV2.sol";
import {VoidRelease1155V2} from "../contracts/VoidRelease1155V2.sol";

interface Vm {
    function prank(address) external;
    function deal(address, uint256) external;
}

contract VoidCollectionsTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    VoidCollectionFactory internal factory;
    VoidPrimarySaleV2 internal sale;
    MusicMarketplaceV2 internal market;
    VoidRelease1155V2 internal shared;
    VoidCollection1155 internal alpha;
    VoidCollection1155 internal beta;
    address internal platform = address(this);
    address internal artistA = address(0xA11CE);
    address internal artistB = address(0xB0B);
    address internal payoutA = address(0xA0A0);
    address internal feeRecipient = address(0xFEE);
    address internal buyer = address(0xBEEF);
    address internal collector = address(0xC011);
    uint256 internal constant PRICE = 1 ether;

    function setUp() public {
        factory = new VoidCollectionFactory();
        sale = new VoidPrimarySaleV2(address(factory), feeRecipient, 500);
        factory.setPrimarySale(address(sale));
        shared = new VoidRelease1155V2(platform);
        market = new MusicMarketplaceV2(feeRecipient, 250, address(shared), address(factory));
        alpha = VoidCollection1155(factory.createCollection(artistA, "Alpha Collection", "ALPHA", "ipfs://alpha-contract"));
        beta = VoidCollection1155(factory.createCollection(artistB, "Beta Collection", "BETA", "ipfs://beta-contract"));
    }

    function _edition(VoidCollection1155 collection, address artist, uint256 supply) internal returns (uint256 id) {
        vm.prank(artist);
        id = collection.createEdition(bytes32("release"), bytes32("edition"), supply, "ipfs://metadata", artist == artistA ? payoutA : artist, 500);
    }

    // ---------------------------------------------------------------- factory

    function testCreatesSeparateRegisteredContractPerCollection() public view {
        require(address(alpha) != address(beta), "distinct contracts");
        require(address(alpha) != factory.implementation(), "clone, not implementation");
        require(factory.isCollection(address(alpha)) && factory.isCollection(address(beta)), "registered");
        require(!factory.isCollection(address(shared)) && !factory.isCollection(factory.implementation()), "only clones registered");
        require(factory.collectionCount() == 2 && factory.collectionAt(0) == address(alpha), "index");
        require(factory.collectionsOf(artistA).length == 1 && factory.collectionsOf(artistA)[0] == address(alpha), "by artist");
        require(keccak256(bytes(alpha.name())) == keccak256("Alpha Collection") && keccak256(bytes(alpha.symbol())) == keccak256("ALPHA"), "identity");
        require(keccak256(bytes(alpha.contractURI())) == keccak256("ipfs://alpha-contract"), "contractURI");
    }

    function testOnlyThePlatformCanCreateCollections() public {
        vm.prank(artistA);
        try factory.createCollection(artistA, "Self", "SELF", "") { revert("artist created a collection"); } catch {}
        try factory.createCollection(address(0), "None", "NONE", "") { revert("zero artist accepted"); } catch {}
    }

    function testRequiresPrimarySaleBeforeCreatingAndSetsItOnce() public {
        VoidCollectionFactory fresh = new VoidCollectionFactory();
        try fresh.createCollection(artistA, "x", "X", "") { revert("created without sale"); } catch {}
        fresh.setPrimarySale(address(sale));
        try fresh.setPrimarySale(address(0xDEAD)) { revert("sale replaced"); } catch {}
    }

    function testArtistOwnsTheCollectionAndThePlatformHasNoRole() public view {
        require(alpha.owner() == artistA, "owner");
        require(alpha.hasRole(alpha.DEFAULT_ADMIN_ROLE(), artistA), "artist admin");
        require(alpha.hasRole(alpha.ARTIST_ROLE(), artistA), "artist role");
        require(alpha.hasRole(alpha.ISSUER_ROLE(), artistA), "artist issuer");
        require(alpha.hasRole(alpha.ISSUER_ROLE(), address(sale)), "sale issuer");
        require(!alpha.hasRole(alpha.DEFAULT_ADMIN_ROLE(), platform), "platform admin");
        require(!alpha.hasRole(alpha.ARTIST_ROLE(), platform), "platform artist");
        require(!alpha.hasRole(alpha.ISSUER_ROLE(), platform), "platform issuer");
        require(!alpha.hasRole(alpha.DEFAULT_ADMIN_ROLE(), address(factory)), "factory admin");
        require(!alpha.hasRole(alpha.ARTIST_ROLE(), artistB), "other artist");
    }

    function testPlatformAndOtherArtistsCannotCreateOrMint() public {
        uint256 id = _edition(alpha, artistA, 10);
        try alpha.createEdition(bytes32("r2"), bytes32("e2"), 1, "x") { revert("platform created edition"); } catch {}
        try alpha.mint(platform, id, 1, "") { revert("platform minted"); } catch {}
        vm.prank(artistB);
        try alpha.createEdition(bytes32("r3"), bytes32("e3"), 1, "x") { revert("other artist created edition"); } catch {}
        vm.prank(artistB);
        try alpha.mint(artistB, id, 1, "") { revert("other artist minted"); } catch {}
    }

    function testImplementationAndClonesCannotBeReinitialized() public {
        VoidCollection1155 implementation = VoidCollection1155(factory.implementation());
        vm.prank(address(factory));
        try implementation.initialize(artistB, address(0), "x", "X", "") { revert("implementation initialized"); } catch {}
        vm.prank(address(factory));
        try alpha.initialize(artistB, address(0), "x", "X", "") { revert("clone re-initialized"); } catch {}
        vm.prank(artistB);
        try alpha.initialize(artistB, address(0), "x", "X", "") { revert("non-factory initialized"); } catch {}
        require(alpha.owner() == artistA, "owner unchanged");
    }

    function testCollectionsAreIndependentEvenWithTheSameIds() public {
        uint256 idA = _edition(alpha, artistA, 5);
        uint256 idB = _edition(beta, artistB, 7);
        require(idA == idB, "same derivation");
        vm.prank(artistA);
        alpha.mint(collector, idA, 2, "");
        require(alpha.balanceOf(collector, idA) == 2 && beta.balanceOf(collector, idB) == 0, "separate balances");
        require(alpha.maxSupplyOf(idA) == 5 && beta.maxSupplyOf(idB) == 7, "separate editions");
        require(alpha.artistOf(idA) == artistA && beta.artistOf(idB) == artistB, "separate artists");
    }

    function testOwnershipTransferMovesEveryRoleAndKeepsTheSaleIssuer() public {
        try alpha.transferOwnership(platform) { revert("platform took ownership"); } catch {}
        vm.prank(artistA);
        alpha.transferOwnership(artistB);
        require(alpha.owner() == artistB, "new owner");
        require(alpha.hasRole(alpha.DEFAULT_ADMIN_ROLE(), artistB) && alpha.hasRole(alpha.ARTIST_ROLE(), artistB), "new roles");
        require(!alpha.hasRole(alpha.DEFAULT_ADMIN_ROLE(), artistA) && !alpha.hasRole(alpha.ARTIST_ROLE(), artistA), "old roles removed");
        require(alpha.hasRole(alpha.ISSUER_ROLE(), address(sale)), "sale issuer kept");
    }

    function testOnlyTheOwnerUpdatesContractMetadata() public {
        try alpha.setContractURI("ipfs://hijack") { revert("platform updated metadata"); } catch {}
        vm.prank(artistA);
        alpha.setContractURI("ipfs://alpha-v2");
        require(keccak256(bytes(alpha.contractURI())) == keccak256("ipfs://alpha-v2"), "updated");
    }

    // ---------------------------------------------------------------- primary sale

    function testPrimarySaleMintsFromTheCollectionAndSplitsProceeds() public {
        uint256 id = _edition(alpha, artistA, 10);
        vm.prank(artistA);
        sale.configureSale(address(alpha), id, PRICE, 5, 2, 0, 0, false);
        vm.deal(buyer, 2 ether);
        vm.prank(buyer);
        sale.purchase{value: 2 ether}(address(alpha), id, 2);
        require(alpha.balanceOf(buyer, id) == 2, "minted");
        require(sale.balances(payoutA) == 1.9 ether && sale.balances(feeRecipient) == 0.1 ether, "split");
        require(sale.walletPurchased(address(alpha), id, buyer) == 2, "wallet count");
    }

    function testSaleRejectsContractsTheFactoryDidNotCreate() public {
        uint256 sharedId = shared.createEdition(bytes32("release"), bytes32("edition"), 10, "ipfs://shared");
        try sale.configureSale(address(shared), sharedId, PRICE, 5, 1, 0, 0, false) { revert("unregistered configured"); } catch {}
        vm.deal(buyer, PRICE);
        vm.prank(buyer);
        try sale.purchase{value: PRICE}(address(shared), sharedId, 1) { revert("unregistered sold"); } catch {}
    }

    function testOnlyTheEditionArtistConfiguresItsSale() public {
        uint256 id = _edition(alpha, artistA, 10);
        vm.prank(artistB);
        try sale.configureSale(address(alpha), id, PRICE, 5, 1, 0, 0, false) { revert("other artist configured"); } catch {}
        try sale.configureSale(address(alpha), id, PRICE, 5, 1, 0, 0, false) { revert("platform configured"); } catch {}
    }

    function testArtistCanRevokeTheSaleIssuer() public {
        uint256 id = _edition(alpha, artistA, 10);
        vm.prank(artistA);
        sale.configureSale(address(alpha), id, PRICE, 5, 1, 0, 0, false);
        bytes32 issuerRole = alpha.ISSUER_ROLE();
        vm.prank(artistA);
        alpha.revokeRole(issuerRole, address(sale));
        vm.deal(buyer, PRICE);
        vm.prank(buyer);
        try sale.purchase{value: PRICE}(address(alpha), id, 1) { revert("sold after revoke"); } catch {}
        require(alpha.balanceOf(buyer, id) == 0 && address(sale).balance == 0, "rolled back");
    }

    // ---------------------------------------------------------------- marketplace

    function testMarketplaceListsAndSellsFromARegisteredCollectionWithRoyalty() public {
        uint256 id = _edition(alpha, artistA, 10);
        vm.prank(artistA);
        alpha.mint(collector, id, 3, "");
        vm.prank(collector);
        alpha.setApprovalForAll(address(market), true);
        vm.prank(collector);
        uint256 listingId = market.createListing(address(alpha), collector, id, 2, PRICE, 0);
        uint256 collectorBefore = collector.balance;
        vm.deal(buyer, PRICE);
        vm.prank(buyer);
        market.buy{value: PRICE}(listingId, 1);
        require(alpha.balanceOf(buyer, id) == 1, "delivered");
        require(feeRecipient.balance == 0.025 ether, "platform fee");
        require(payoutA.balance == 0.05 ether, "royalty to artist payout");
        require(collector.balance - collectorBefore == 0.925 ether, "seller proceeds");
    }

    function testMarketplaceStillSupportsTheSharedCanonicalContract() public {
        uint256 id = shared.createEdition(bytes32("release"), bytes32("edition"), 10, "ipfs://shared");
        shared.mint(collector, id, 1, "");
        vm.prank(collector);
        shared.setApprovalForAll(address(market), true);
        vm.prank(collector);
        market.createListing(address(shared), collector, id, 1, PRICE, 0);
    }

    function testMarketplaceRejectsUnregisteredTokens() public {
        VoidRelease1155V2 rogue = new VoidRelease1155V2(collector);
        vm.prank(collector);
        uint256 id = rogue.createEdition(bytes32("release"), bytes32("edition"), 10, "ipfs://rogue");
        vm.prank(collector);
        rogue.mint(collector, id, 1, "");
        vm.prank(collector);
        rogue.setApprovalForAll(address(market), true);
        vm.prank(collector);
        try market.createListing(address(rogue), collector, id, 1, PRICE, 0) { revert("unregistered listed"); } catch {}
    }
}
