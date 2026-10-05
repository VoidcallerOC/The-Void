// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VoidReleaseFactory} from "../contracts/VoidReleaseFactory.sol";
import {VoidRelease1155V4} from "../contracts/VoidRelease1155V4.sol";
import {VoidPrimarySale} from "../contracts/VoidPrimarySale.sol";
import {VoidProvenanceAnchor} from "../contracts/VoidProvenanceAnchor.sol";

interface Vm {
    function prank(address) external;
    function deal(address, uint256) external;
}

contract VoidReleaseFactoryTest {
    VoidReleaseFactory internal factory;
    VoidRelease1155V4 internal releaseA;
    VoidRelease1155V4 internal releaseB;
    VoidPrimarySale internal saleA;
    VoidPrimarySale internal saleB;
    VoidProvenanceAnchor internal anchorA;
    VoidProvenanceAnchor internal anchorB;

    address internal artist = address(0xA11CE);
    address internal safe = address(0x5AFE);
    address internal platform = address(0xFEE);
    address internal collector = address(0xC011);
    address internal other = address(0xB0B);
    bytes32 internal constant RELEASE_A = keccak256("release-a");
    bytes32 internal constant RELEASE_B = keccak256("release-b");
    bytes32 internal constant EDITION = keccak256("edition-one");
    uint256 internal constant PRICE = 1 ether;

    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function setUp() public {
        factory = new VoidReleaseFactory(platform, 500, safe);
        (address contractA, address primarySaleA, address provenanceA) = factory.createRelease(artist, RELEASE_A, "Genesis", "GEN", "ipfs://genesis");
        (address contractB, address primarySaleB, address provenanceB) = factory.createRelease(artist, RELEASE_B, "Aftermath", "AFT", "ipfs://aftermath");
        releaseA = VoidRelease1155V4(contractA);
        releaseB = VoidRelease1155V4(contractB);
        saleA = VoidPrimarySale(primarySaleA);
        saleB = VoidPrimarySale(primarySaleB);
        anchorA = VoidProvenanceAnchor(provenanceA);
        anchorB = VoidProvenanceAnchor(provenanceB);
    }

    function _edition(VoidRelease1155V4 release, bytes32 releaseKey, uint256 supply) internal returns (uint256 tokenId) {
        vm.prank(artist);
        tokenId = release.createEdition(releaseKey, EDITION, supply, "ipfs://edition", artist, 500);
    }

    function testSameArtistGetsTwoIndependentReleaseContracts() public view {
        require(address(releaseA) != address(releaseB), "release contracts must differ");
        require(factory.isRelease(address(releaseA)) && factory.isRelease(address(releaseB)), "registered releases");
        require(factory.releaseContractOf(RELEASE_A) == address(releaseA), "A mapping");
        require(factory.releaseContractOf(RELEASE_B) == address(releaseB), "B mapping");
        require(factory.releaseOf(address(releaseA)) == RELEASE_A && factory.releaseOf(address(releaseB)) == RELEASE_B, "reverse mappings");
        require(factory.releasesOf(artist).length == 2 && factory.releaseCount() == 2, "artist release history");
        require(releaseA.releaseKey() == RELEASE_A && releaseB.releaseKey() == RELEASE_B, "clone release keys");
        require(releaseA.owner() == artist && releaseB.owner() == artist, "artist owns each clone");
        require(!releaseA.hasRole(releaseA.ISSUER_ROLE(), artist) && !releaseB.hasRole(releaseB.ISSUER_ROLE(), artist), "artist cannot directly issue");
        require(releaseA.hasRole(releaseA.ISSUER_ROLE(), address(saleA)), "A sale issuer");
        require(releaseB.hasRole(releaseB.ISSUER_ROLE(), address(saleB)), "B sale issuer");
        require(saleA.owner() == safe && saleB.owner() == safe, "safe owns dedicated sales");
        require(address(saleA.releases()) == address(releaseA) && address(saleB.releases()) == address(releaseB), "sales bound to their release");
        require(anchorA.releaseContract() == address(releaseA) && anchorB.releaseContract() == address(releaseB), "anchors bound to their release");
    }

    function testSameTokenIdHasIsolatedBalancesSupplyAndPauseState() public {
        uint256 idA = _edition(releaseA, RELEASE_A, 5);
        uint256 idB = _edition(releaseB, RELEASE_B, 9);
        require(idA == idB, "same edition id may repeat across contracts");
        vm.prank(address(saleA));
        releaseA.mint(collector, idA, 2, "");
        require(releaseA.balanceOf(collector, idA) == 2, "A balance");
        require(releaseB.balanceOf(collector, idB) == 0, "B isolated balance");
        require(releaseA.maxSupplyOf(idA) == 5 && releaseB.maxSupplyOf(idB) == 9, "isolated supply");
        vm.prank(artist);
        releaseA.pause();
        require(releaseA.paused() && !releaseB.paused(), "pause cannot cross releases");
        vm.prank(address(saleB));
        releaseB.mint(collector, idB, 1, "");
        require(releaseB.balanceOf(collector, idB) == 1, "B remains mutable while A paused");
    }

    function testCloneRejectsForeignReleaseKeyAndUnauthorizedMutation() public {
        vm.prank(artist);
        try releaseA.createEdition(RELEASE_B, EDITION, 1, "ipfs://wrong", artist, 500) { revert("foreign key accepted"); } catch {}
        vm.prank(other);
        try releaseA.createEdition(RELEASE_A, EDITION, 1, "ipfs://wrong", other, 500) { revert("unrelated wallet mutated release"); } catch {}
    }

    function testDedicatedPrimarySaleCannotSellTheOtherRelease() public {
        uint256 idA = _edition(releaseA, RELEASE_A, 2);
        uint256 idB = _edition(releaseB, RELEASE_B, 2);
        require(idA == idB, "same token id test fixture");
        vm.prank(artist);
        saleB.configureSale(idB, PRICE, 2, 2, 0, 0, false);
        vm.deal(collector, PRICE);
        vm.prank(collector);
        try saleA.purchase{value: PRICE}(idA, 1) { revert("A sale sold B configuration"); } catch {}
        require(releaseA.balanceOf(collector, idA) == 0 && releaseB.balanceOf(collector, idB) == 0, "failed cross sale changes neither release");
        vm.prank(collector);
        saleB.purchase{value: PRICE}(idB, 1);
        require(releaseA.balanceOf(collector, idA) == 0 && releaseB.balanceOf(collector, idB) == 1, "B sale mints only B");
    }

    function testReleaseKeyCannotBeReboundOrCloneReinitialized() public {
        try factory.createRelease(artist, RELEASE_A, "Duplicate", "DUP", "") { revert("duplicate release key accepted"); } catch {}
        try releaseA.initialize(artist, address(saleA), "x", "X", "") { revert("direct initializer accepted"); } catch {}
        try releaseA.initializeRelease(artist, address(saleA), RELEASE_A, "x", "X", "") { revert("clone reinitialized"); } catch {}
    }
}
