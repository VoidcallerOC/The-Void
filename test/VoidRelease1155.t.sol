// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VoidRelease1155} from "../contracts/VoidRelease1155.sol";

interface Vm {
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function assume(bool) external;
}

contract WrongSelectorReceiver {
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) { return bytes4(0); }
    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata) external pure returns (bytes4) { return bytes4(0); }
}

contract RevertingReceiver {
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) { revert(); }
    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata) external pure returns (bytes4) { revert(); }
}

contract VoidRelease1155Test {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    VoidRelease1155 internal token;
    address internal admin = address(this);
    address internal artist = address(0xA11CE);
    address internal issuer = address(0x155); // deliberately distinct from artist
    address internal alice = address(0xA11CE2);
    address internal bob = address(0xB0B);
    address internal stranger = address(0x57A);
    address internal recipient = address(0x2345678901234567890123456789012345678901);
    uint256 internal id;

    function setUp() public {
        token = new VoidRelease1155(admin);
        vm.prank(admin); token.grantRole(token.ARTIST_ROLE(), artist);
        vm.prank(admin); token.grantRole(token.ISSUER_ROLE(), issuer);
        vm.prank(artist); id = token.createEdition(bytes32("release"), bytes32("edition"), 10, "ipfs://metadata");
    }

    function _create(bytes32 releaseId, bytes32 editionId, uint256 supply) internal returns (uint256 createdId) {
        vm.prank(artist); createdId = token.createEdition(releaseId, editionId, supply, "ipfs://metadata");
    }

    function _mint(address to, uint256 tokenId, uint256 amount) internal {
        vm.prank(issuer); token.mint(to, tokenId, amount, "");
    }

    function testSupportsAllERC1155Interfaces() public view {
        require(token.supportsInterface(0x01ffc9a7));
        require(token.supportsInterface(0xd9b67a26));
        require(token.supportsInterface(0x0e89341c));
        require(!token.supportsInterface(0xffffffff));
    }

    function testEditionMetadataAndEventsSurface() public view {
        require(bytes(token.uri(id)).length > 0);
        require(token.balanceOf(address(this), id) == 0);
        VoidRelease1155.Edition memory item = token.edition(id);
        require(item.releaseId == bytes32("release") && item.editionId == bytes32("edition"));
        require(item.artist == artist && item.maxSupply == 10 && item.mintedSupply == 0 && item.exists);
    }

    function testMintExactSupplyAndZeroQuantity() public {
        _mint(alice, id, 10);
        require(token.balanceOf(alice, id) == 10);
        vm.prank(issuer); try token.mint(alice, id, 1, "") { revert(); } catch {}
        vm.prank(issuer); try token.mint(alice, id, 0, "") { revert(); } catch {}
        require(token.edition(id).mintedSupply == 10);
    }

    function testReceiverWrongSelectorMintRevertsAndRollsBack() public {
        WrongSelectorReceiver receiver = new WrongSelectorReceiver();
        vm.prank(issuer); try token.mint(address(receiver), id, 2, "") { revert(); } catch {}
        require(token.balanceOf(address(receiver), id) == 0);
        require(token.edition(id).mintedSupply == 0);
    }

    function testReceiverRevertMintRevertsAndRollsBack() public {
        RevertingReceiver receiver = new RevertingReceiver();
        vm.prank(issuer); try token.mint(address(receiver), id, 2, "") { revert(); } catch {}
        require(token.balanceOf(address(receiver), id) == 0);
        require(token.edition(id).mintedSupply == 0);
    }

    function testRejectingSingleTransferRollsBackBalance() public {
        _mint(alice, id, 3);
        WrongSelectorReceiver receiver = new WrongSelectorReceiver();
        vm.prank(alice); try token.safeTransferFrom(alice, address(receiver), id, 2, "") { revert(); } catch {}
        require(token.balanceOf(alice, id) == 3 && token.balanceOf(address(receiver), id) == 0);
    }

    function testRejectingBatchTransferRollsBackBalances() public {
        _mint(alice, id, 3);
        RevertingReceiver receiver = new RevertingReceiver();
        uint256[] memory ids = new uint256[](1); ids[0] = id;
        uint256[] memory amounts = new uint256[](1); amounts[0] = 2;
        vm.prank(alice); try token.safeBatchTransferFrom(alice, address(receiver), ids, amounts, "") { revert(); } catch {}
        require(token.balanceOf(alice, id) == 3 && token.balanceOf(address(receiver), id) == 0);
    }

    function testApprovalLifecycleAndRevocation() public {
        _mint(alice, id, 3);
        vm.prank(alice); token.setApprovalForAll(bob, true);
        require(token.isApprovedForAll(alice, bob));
        vm.prank(bob); token.safeTransferFrom(alice, recipient, id, 1, "");
        require(token.balanceOf(alice, id) == 2 && token.balanceOf(recipient, id) == 1);
        vm.prank(alice); token.setApprovalForAll(bob, false);
        require(!token.isApprovedForAll(alice, bob));
        vm.prank(bob); try token.safeTransferFrom(alice, recipient, id, 1, "") { revert(); } catch {}
        vm.prank(stranger); try token.safeTransferFrom(alice, recipient, id, 1, "") { revert(); } catch {}
    }

    function testRoleIsolationAndRevocation() public {
        vm.prank(artist); uint256 artistOnlyId = token.createEdition(bytes32("artist"), bytes32("only"), 2, "");
        vm.prank(artist); try token.mint(alice, artistOnlyId, 1, "") { revert(); } catch {}
        vm.prank(issuer); token.mint(alice, id, 1, "");
        vm.prank(issuer); try token.createEdition(bytes32("issuer"), bytes32("only"), 2, "") { revert(); } catch {}
        vm.prank(admin); token.revokeRole(token.ARTIST_ROLE(), artist);
        vm.prank(artist); try token.createEdition(bytes32("revoked"), bytes32("artist"), 1, "") { revert(); } catch {}
        vm.prank(admin); token.revokeRole(token.ISSUER_ROLE(), issuer);
        vm.prank(issuer); try token.mint(alice, id, 1, "") { revert(); } catch {}
    }

    function testAdminGrantRevokePauseAndRenounce() public {
        bytes32 artistRole = token.ARTIST_ROLE();
        vm.prank(stranger); try token.grantRole(artistRole, stranger) { revert(); } catch {}
        vm.prank(stranger); try token.revokeRole(artistRole, artist) { revert(); } catch {}
        vm.prank(stranger); try token.pause() { revert(); } catch {}
        vm.prank(admin); token.grantRole(artistRole, stranger);
        vm.prank(stranger); token.renounceRole(artistRole);
        require(!token.hasRole(artistRole, stranger));
        vm.prank(admin); token.pause();
        vm.prank(stranger); try token.unpause() { revert(); } catch {}
        vm.prank(admin); token.unpause();
    }

    function testMultiEditionSupplyIsolation() public {
        uint256 editionB = _create(bytes32("release-b"), bytes32("edition-b"), 2);
        _mint(alice, id, 3);
        _mint(alice, editionB, 2);
        require(token.edition(id).mintedSupply == 3 && token.edition(editionB).mintedSupply == 2);
        vm.prank(issuer); try token.mint(alice, editionB, 1, "") { revert(); } catch {}
        require(token.edition(id).mintedSupply == 3);
    }

    function testDuplicateAndDeterministicIdentifiers() public {
        require(token.tokenIdFor(bytes32("release"), bytes32("edition")) == id);
        uint256 other = token.tokenIdFor(bytes32("release"), bytes32("edition-2"));
        require(other != id && other == token.tokenIdFor(bytes32("release"), bytes32("edition-2")));
        vm.prank(artist); try token.createEdition(bytes32("release"), bytes32("edition"), 1, "") { revert(); } catch {}
    }

    function testInvalidIdentifiersAndSupply() public {
        vm.prank(artist); try token.createEdition(bytes32(0), bytes32("edition"), 1, "") { revert(); } catch {}
        vm.prank(artist); try token.createEdition(bytes32("release"), bytes32(0), 1, "") { revert(); } catch {}
        vm.prank(artist); try token.createEdition(bytes32("zero"), bytes32("supply"), 0, "") { revert(); } catch {}
        vm.prank(issuer); try token.mint(alice, 999, 1, "") { revert(); } catch {}
    }

    function testPauseBlocksAllMutationsAndUnpauseRestores() public {
        uint256 editionB = token.tokenIdFor(bytes32("paused"), bytes32("edition"));
        token.pause();
        vm.prank(artist); try token.createEdition(bytes32("paused"), bytes32("edition"), 1, "") { revert(); } catch {}
        vm.prank(issuer); try token.mint(alice, id, 1, "") { revert(); } catch {}
        vm.prank(issuer); try token.mintBatch(alice, _one(id), _one(1), "") { revert(); } catch {}
        vm.prank(alice); try token.safeTransferFrom(alice, recipient, id, 1, "") { revert(); } catch {}
        vm.prank(alice); try token.safeBatchTransferFrom(alice, recipient, _one(id), _one(1), "") { revert(); } catch {}
        token.unpause();
        require(!token.paused() && editionB != 0);
        _mint(alice, id, 1);
    }

    function testFuzzSupplyInvariant(uint256 firstAmount, uint256 secondAmount) public {
        firstAmount = (firstAmount % 11);
        secondAmount = (secondAmount % 11);
        if (firstAmount == 0) {
            vm.prank(issuer); try token.mint(alice, id, 0, "") { revert(); } catch {}
        } else {
            _mint(alice, id, firstAmount);
        }
        uint256 minted = token.edition(id).mintedSupply;
        require(minted <= token.edition(id).maxSupply);
        if (secondAmount > 0 && minted + secondAmount <= 10) _mint(alice, id, secondAmount);
        else if (secondAmount > 0) { vm.prank(issuer); try token.mint(alice, id, secondAmount, "") { revert(); } catch {} }
        require(token.edition(id).mintedSupply <= token.edition(id).maxSupply);
        require(token.balanceOf(alice, id) == token.edition(id).mintedSupply);
    }

    function testBalanceOfBatchAndLengthErrors() public {
        _mint(alice, id, 2);
        address[] memory accounts = new address[](1); accounts[0] = alice;
        uint256[] memory ids = new uint256[](1); ids[0] = id;
        require(token.balanceOfBatch(accounts, ids)[0] == 2);
        uint256[] memory wrongIds = new uint256[](2);
        try token.balanceOfBatch(accounts, wrongIds) { revert(); } catch {}
    }

    function _one(uint256 value) internal pure returns (uint256[] memory values) {
        values = new uint256[](1); values[0] = value;
    }
}
