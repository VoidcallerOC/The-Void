// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VoidRelease1155V2} from "../contracts/VoidRelease1155V2.sol";

interface Vm {
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
}

contract VoidRelease1155V2Test {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    VoidRelease1155V2 internal token;
    address internal admin = address(this);
    address internal artist = address(0xA11CE);
    address internal payout = address(0xB0B);
    address internal otherArtist = address(0xA77);
    address internal issuer = address(0x155);
    address internal alice = address(0xA11CE2);
    uint256 internal id;

    function setUp() public {
        token = new VoidRelease1155V2(admin);
        token.grantRole(token.ARTIST_ROLE(), artist);
        token.grantRole(token.ARTIST_ROLE(), otherArtist);
        token.grantRole(token.ISSUER_ROLE(), issuer);
        vm.prank(artist);
        id = token.createEdition(bytes32("release"), bytes32("edition"), 10, "ipfs://metadata", payout, 500);
    }

    function testSupportsErc2981AndErc1155() public view {
        require(token.supportsInterface(0x01ffc9a7), "erc165");
        require(token.supportsInterface(0xd9b67a26), "erc1155");
        require(token.supportsInterface(0x0e89341c), "metadata");
        require(token.supportsInterface(0x2a55205a), "erc2981");
        require(!token.supportsInterface(0xffffffff), "mask");
    }

    function testRoyaltyInfoUsesEditionPayoutAndBps() public view {
        (address receiver, uint256 amount) = token.royaltyInfo(id, 10_000);
        require(receiver == payout, "receiver");
        require(amount == 500, "five percent");
        require(token.payoutOf(id) == payout, "payout");
        require(token.royaltyBpsOf(id) == 500, "bps");
        require(token.edition(id).artist == artist, "artist");
        require(token.edition(id).maxSupply == 10, "supply");
    }

    function testRoyaltyCapIsTenPercent() public {
        vm.prank(artist);
        uint256 capped = token.createEdition(bytes32("cap"), bytes32("ok"), 1, "ipfs://cap", artist, 1_000);
        (, uint256 amount) = token.royaltyInfo(capped, 1_000_000);
        require(amount == 100_000, "ten percent");
        vm.prank(artist);
        try token.createEdition(bytes32("cap"), bytes32("over"), 1, "ipfs://over", artist, 1_001) {
            revert();
        } catch {}
        vm.prank(artist);
        try token.createEdition(bytes32("zero"), bytes32("payout"), 1, "ipfs://zero", address(0), 100) {
            revert();
        } catch {}
    }

    function testLegacyCreateEditionPaysTheArtistWithZeroRoyalty() public {
        vm.prank(artist);
        uint256 created = token.createEdition(bytes32("legacy"), bytes32("edition"), 4, "ipfs://legacy");
        (address receiver, uint256 amount) = token.royaltyInfo(created, 9_999);
        require(receiver == artist && amount == 0, "zero royalty");
        require(token.edition(created).artist == artist, "artist recorded");
    }

    function testUnknownEditionRoyaltyReverts() public view {
        try token.royaltyInfo(999, 1) {
            revert();
        } catch {}
        try token.payoutOf(999) {
            revert();
        } catch {}
    }

    function testIssuerMintStillRequiredAndSupplyHolds() public {
        vm.prank(artist);
        try token.mint(alice, id, 1, "") {
            revert();
        } catch {}
        vm.prank(issuer);
        token.mint(alice, id, 10, "");
        require(token.balanceOf(alice, id) == 10, "minted");
        vm.prank(issuer);
        try token.mint(alice, id, 1, "") {
            revert();
        } catch {}
        require(token.edition(id).mintedSupply == 10, "supply");
    }

    function testOtherArtistCannotReuseTheEditionId() public {
        vm.prank(otherArtist);
        try token.createEdition(bytes32("release"), bytes32("edition"), 1, "", payout, 100) {
            revert();
        } catch {}
    }
}
