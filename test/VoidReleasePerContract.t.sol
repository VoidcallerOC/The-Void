// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VoidReleaseFactory} from "../contracts/VoidReleaseFactory.sol";
import {VoidRelease1155V4} from "../contracts/VoidRelease1155V4.sol";
import {VoidPrimarySale} from "../contracts/VoidPrimarySale.sol";
import {VoidProvenanceAnchor} from "../contracts/VoidProvenanceAnchor.sol";
import {ReleaseMarketplaceV3} from "../contracts/ReleaseMarketplaceV3.sol";

interface Vm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }
    function prank(address) external;
    function deal(address, uint256) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

contract VoidReleasePerContractTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    VoidReleaseFactory internal factory;
    VoidRelease1155V4 internal releaseA;
    VoidRelease1155V4 internal releaseB;
    VoidPrimarySale internal saleA;
    VoidPrimarySale internal saleB;
    VoidProvenanceAnchor internal anchorA;
    VoidProvenanceAnchor internal anchorB;
    ReleaseMarketplaceV3 internal marketplace;

    address internal constant ARTIST = address(0xA11CE);
    address internal constant SAFE = address(0x5AFE);
    address internal constant PLATFORM = address(0xFEE);
    address internal constant COLLECTOR = address(0xC011);
    address internal constant BUYER = address(0xB0B);
    address internal constant OTHER = address(0xB0B1);
    address internal constant PAYOUT_A = address(0xAAA1);
    address internal constant PAYOUT_B = address(0xBBB1);
    bytes32 internal constant RELEASE_A = keccak256("release-per-contract-a");
    bytes32 internal constant RELEASE_B = keccak256("release-per-contract-b");
    bytes32 internal constant EDITION = keccak256("shared-edition");
    uint256 internal constant PRICE = 1 ether;

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

    function setUp() public {
        factory = new VoidReleaseFactory(PLATFORM, 500, SAFE);
        vm.recordLogs();
        (address addressA, address primarySaleA, address provenanceA) = factory.createRelease(
            ARTIST, RELEASE_A, "Release A", "A", "ipfs://release-a"
        );
        Vm.Log[] memory logs = vm.getRecordedLogs();
        _assertReleaseCreated(logs, addressA, RELEASE_A, ARTIST, primarySaleA, provenanceA, factory.implementation(), 0, 1);

        (address addressB, address primarySaleB, address provenanceB) = factory.createRelease(
            ARTIST, RELEASE_B, "Release B", "B", "ipfs://release-b"
        );
        releaseA = VoidRelease1155V4(addressA);
        releaseB = VoidRelease1155V4(addressB);
        saleA = VoidPrimarySale(primarySaleA);
        saleB = VoidPrimarySale(primarySaleB);
        anchorA = VoidProvenanceAnchor(provenanceA);
        anchorB = VoidProvenanceAnchor(provenanceB);
        marketplace = new ReleaseMarketplaceV3(PLATFORM, 250, address(factory));
    }

    function testABRuntimeIsolation() public {
        require(address(releaseA) != address(releaseB), "release addresses must differ");
        require(address(saleA) != address(saleB), "sale addresses must differ");
        require(address(anchorA) != address(anchorB), "anchor addresses must differ");
        require(factory.releaseCount() == 2, "two releases registered");
        require(factory.isRelease(address(releaseA)) && factory.isRelease(address(releaseB)), "registered exactly once");
        require(factory.releaseContractOf(RELEASE_A) == address(releaseA), "A forward mapping");
        require(factory.releaseContractOf(RELEASE_B) == address(releaseB), "B forward mapping");
        require(factory.releaseOf(address(releaseA)) == RELEASE_A, "A reverse mapping");
        require(factory.releaseOf(address(releaseB)) == RELEASE_B, "B reverse mapping");
        require(factory.artistOf(address(releaseA)) == ARTIST && factory.artistOf(address(releaseB)) == ARTIST, "artist mapping");
        require(address(saleA.releases()) == address(releaseA), "sale A binding");
        require(address(saleB.releases()) == address(releaseB), "sale B binding");
        require(anchorA.releaseContract() == address(releaseA), "anchor A binding");
        require(anchorB.releaseContract() == address(releaseB), "anchor B binding");

        try factory.createRelease(ARTIST, RELEASE_A, "duplicate", "D", "") {
            revert("duplicate release key accepted");
        } catch {}
        try releaseA.initialize(ARTIST, address(saleA), "reinit", "R", "") {
            revert("clone reinitialized");
        } catch {}

        vm.prank(ARTIST);
        try releaseA.createEdition(RELEASE_B, EDITION, 5, "ipfs://foreign", ARTIST, 500) {
            revert("foreign release key accepted");
        } catch {}

        vm.prank(ARTIST);
        uint256 tokenA = releaseA.createEdition(RELEASE_A, EDITION, 5, "ipfs://a", PAYOUT_A, 100);
        vm.prank(ARTIST);
        uint256 tokenB = releaseB.createEdition(RELEASE_B, EDITION, 9, "ipfs://b", PAYOUT_B, 900);

        // V4 intentionally derives IDs locally from the edition ID. The contract address is
        // the namespace boundary, so equal numeric IDs across clones remain distinct assets.
        require(tokenA == releaseA.tokenIdFor(RELEASE_A, EDITION), "A token ID is not contract-derived");
        require(tokenB == releaseB.tokenIdFor(RELEASE_B, EDITION), "B token ID is not contract-derived");
        require(tokenA == tokenB, "same edition ID did not derive the same numeric ID");
        require(address(releaseA) != address(releaseB), "equal token IDs collided across contracts");

        bytes32 rootA = keccak256("provenance-a");
        bytes32 rootB = keccak256("provenance-b");
        vm.prank(ARTIST);
        anchorA.anchor(RELEASE_A, EDITION, rootA);
        vm.prank(ARTIST);
        anchorB.anchor(RELEASE_B, EDITION, rootB);
        require(anchorA.isAnchored(RELEASE_A, EDITION, rootA), "A provenance missing");
        require(anchorB.isAnchored(RELEASE_B, EDITION, rootB), "B provenance missing");
        require(!anchorA.isAnchored(RELEASE_B, EDITION, rootB), "A accepted B provenance identity");
        require(!anchorB.isAnchored(RELEASE_A, EDITION, rootA), "B accepted A provenance identity");

        require(keccak256(bytes(releaseA.uri(tokenA))) != keccak256(bytes(releaseB.uri(tokenB))), "metadata shared");
        require(releaseA.maxSupplyOf(tokenA) == 5 && releaseB.maxSupplyOf(tokenB) == 9, "supply shared");
        require(releaseA.payoutOf(tokenA) == PAYOUT_A && releaseB.payoutOf(tokenB) == PAYOUT_B, "payout shared");
        require(releaseA.royaltyBpsOf(tokenA) == 100 && releaseB.royaltyBpsOf(tokenB) == 900, "royalty shared");
        require(releaseA.artistOf(tokenA) == ARTIST && releaseB.artistOf(tokenB) == ARTIST, "artist state shared");
        require(releaseA.hasRole(releaseA.ARTIST_ROLE(), ARTIST), "A artist role missing");
        require(releaseB.hasRole(releaseB.ARTIST_ROLE(), ARTIST), "B artist role missing");
        require(releaseA.hasRole(releaseA.ISSUER_ROLE(), address(saleA)), "A issuer missing");
        require(releaseB.hasRole(releaseB.ISSUER_ROLE(), address(saleB)), "B issuer missing");

        vm.prank(ARTIST);
        releaseA.setApprovalForAll(address(marketplace), true);
        require(releaseA.isApprovedForAll(ARTIST, address(marketplace)), "A approval missing");
        require(!releaseB.isApprovedForAll(ARTIST, address(marketplace)), "approval crossed to B");
        vm.prank(ARTIST);
        releaseA.pause();
        require(releaseA.paused() && !releaseB.paused(), "pause crossed to B");
        vm.prank(ARTIST);
        releaseA.unpause();

        vm.prank(address(saleA));
        releaseA.mint(COLLECTOR, tokenA, 2, "");
        require(releaseA.balanceOf(COLLECTOR, tokenA) == 2 && releaseB.balanceOf(COLLECTOR, tokenB) == 0, "balance crossed");
        require(releaseA.edition(tokenA).mintedSupply == 2 && releaseB.edition(tokenB).mintedSupply == 0, "minted supply crossed");

        vm.prank(ARTIST);
        saleB.configureSale(tokenB, PRICE, 2, 2, 0, 0, false);
        vm.deal(COLLECTOR, PRICE);
        vm.prank(COLLECTOR);
        try saleA.purchase{value: PRICE}(tokenB, 1) {
            revert("sale A sold release B");
        } catch {}
        vm.prank(COLLECTOR);
        saleB.purchase{value: PRICE}(tokenB, 1);
        require(releaseA.balanceOf(COLLECTOR, tokenA) == 2, "sale B changed A balance");
        require(releaseB.balanceOf(COLLECTOR, tokenB) == 1, "sale B did not mint B");
        (,, uint256 soldA,,,,,) = saleA.sales(tokenA);
        (,, uint256 soldB,,,,,) = saleB.sales(tokenB);
        require(soldA == 0 && soldB == 1, "sale state crossed");

        vm.prank(COLLECTOR);
        releaseA.setApprovalForAll(address(marketplace), true);
        vm.prank(COLLECTOR);
        releaseB.setApprovalForAll(address(marketplace), true);
        vm.prank(COLLECTOR);
        uint256 listingA = marketplace.createListing(address(releaseA), COLLECTOR, tokenA, 1, PRICE, 0);
        vm.prank(COLLECTOR);
        uint256 listingB = marketplace.createListing(address(releaseB), COLLECTOR, tokenB, 1, PRICE, 0);
        vm.deal(BUYER, PRICE);
        vm.prank(BUYER);
        marketplace.buy{value: PRICE}(listingA, 1);
        require(releaseA.balanceOf(BUYER, tokenA) == 1, "A marketplace settlement failed");
        require(releaseB.balanceOf(BUYER, tokenB) == 0, "A marketplace touched B");
        vm.deal(BUYER, PRICE);
        vm.prank(BUYER);
        marketplace.buy{value: PRICE}(listingB, 1);
        require(releaseB.balanceOf(BUYER, tokenB) == 1, "B marketplace settlement failed");
    }

    function testThirtyOneReleasesRemainRegisteredAndIsolated() public {
        address[31] memory releases;
        address[31] memory sales;
        address[31] memory anchors;
        bytes32[31] memory keys;

        for (uint256 i; i < 31; ++i) {
            bytes32 key = keccak256(abi.encode("thirty-one-release", i));
            keys[i] = key;
            (releases[i], sales[i], anchors[i]) = factory.createRelease(ARTIST, key, "Release", "R", "");
            require(factory.isRelease(releases[i]), "release not registered");
            require(factory.releaseContractOf(key) == releases[i], "factory mapping incorrect");
            require(factory.releaseOf(releases[i]) == key, "release key reverse mapping incorrect");
            require(factory.artistOf(releases[i]) == ARTIST, "artist mapping incorrect");
            VoidRelease1155V4 createdRelease = VoidRelease1155V4(releases[i]);
            vm.prank(ARTIST);
            uint256 createdToken = createdRelease.createEdition(key, EDITION, i + 1, "ipfs://release", ARTIST, 100);
            require(createdToken == createdRelease.tokenIdFor(key, EDITION), "created ID is not derived");
            for (uint256 j; j < i; ++j) {
                require(releases[i] != releases[j], "duplicate release contract");
                require(sales[i] != sales[j], "duplicate sale");
                require(anchors[i] != anchors[j], "duplicate anchor");
                require(keys[i] != keys[j], "duplicate release key");
            }
        }

        VoidRelease1155V4 first = VoidRelease1155V4(releases[0]);
        VoidRelease1155V4 last = VoidRelease1155V4(releases[30]);
        uint256 firstToken = first.tokenIdFor(keys[0], EDITION);
        uint256 lastToken = last.tokenIdFor(keys[30], EDITION);
        require(firstToken == lastToken, "same edition did not derive the same numeric ID");
        vm.prank(sales[0]);
        first.mint(COLLECTOR, firstToken, 1, "");
        vm.prank(sales[30]);
        last.mint(COLLECTOR, lastToken, 2, "");
        require(first.balanceOf(COLLECTOR, firstToken) == 1, "first release balance not isolated");
        require(last.balanceOf(COLLECTOR, lastToken) == 2, "last release balance not isolated");
        require(first.edition(firstToken).mintedSupply == 1 && last.edition(lastToken).mintedSupply == 2, "31-release supply not isolated");
    }

    function _assertReleaseCreated(
        Vm.Log[] memory logs,
        address expectedRelease,
        bytes32 expectedKey,
        address expectedArtist,
        address expectedSale,
        address expectedAnchor,
        address expectedImplementation,
        uint256 expectedIndex,
        uint16 expectedVersion
    ) internal pure {
        bytes32 signature = keccak256("ReleaseCreated(address,bytes32,address,address,address,address,uint256,uint16)");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length != 4 || logs[i].topics[0] != signature) continue;
            require(address(uint160(uint256(logs[i].topics[1]))) == expectedRelease, "event release mismatch");
            require(logs[i].topics[2] == expectedKey, "event key mismatch");
            require(address(uint160(uint256(logs[i].topics[3]))) == expectedArtist, "event artist mismatch");
            (address sale, address anchor, address implementation, uint256 index, uint16 version) = abi.decode(
                logs[i].data, (address, address, address, uint256, uint16)
            );
            require(sale == expectedSale, "event sale mismatch");
            require(anchor == expectedAnchor, "event anchor mismatch");
            require(implementation == expectedImplementation, "event implementation mismatch");
            require(index == expectedIndex, "event index mismatch");
            require(version == expectedVersion, "event version mismatch");
            return;
        }
        revert("ReleaseCreated event not found");
    }
}
