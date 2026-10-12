// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VoidReleaseFactoryV2} from "../contracts/VoidReleaseFactoryV2.sol";
import {VoidReleaseFactoryV2Royalty} from "../contracts/VoidReleaseFactoryV2Royalty.sol";
import {VoidRelease1155V4} from "../contracts/VoidRelease1155V4.sol";
import {VoidRelease1155V4Royalty} from "../contracts/VoidRelease1155V4Royalty.sol";
import {VoidPrimarySale} from "../contracts/VoidPrimarySale.sol";
import {ReleaseMarketplaceV4} from "../contracts/ReleaseMarketplaceV4.sol";

interface VmRoyalty {
    function prank(address) external;
    function deal(address, uint256) external;
    function warp(uint256) external;
}

/// @dev A registry that vouches for any token, and a token whose royalty can change after listing:
/// stand-ins for a compromised or foreign release, to prove the marketplace checks on its own.
contract PermissiveRegistry {
    function isRelease(address) external pure returns (bool) { return true; }
}

contract MutableRoyaltyToken {
    mapping(address => mapping(uint256 => uint256)) public balanceOf;
    mapping(address => mapping(address => bool)) public isApprovedForAll;
    uint96 public bps = 250;
    address public payout;
    address public reportedReceiver;
    uint256 public reportedBps = 250;

    constructor(address payout_) { payout = payout_; reportedReceiver = payout_; }
    function mint(address to, uint256 id) external { balanceOf[to][id] += 1; }
    function setApprovalForAll(address operator, bool approved) external { isApprovedForAll[msg.sender][operator] = approved; }
    function setPolicy(uint96 bps_, address payout_) external { bps = bps_; payout = payout_; }
    function setReported(address receiver, uint256 reportedBps_) external { reportedReceiver = receiver; reportedBps = reportedBps_; }
    function royaltyBpsOf(uint256) external view returns (uint96) { return bps; }
    function payoutOf(uint256) external view returns (address) { return payout; }
    function royaltyInfo(uint256, uint256 price) external view returns (address, uint256) { return (reportedReceiver, (price * reportedBps) / 10_000); }
    function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes calldata) external {
        balanceOf[from][id] -= value;
        balanceOf[to][id] += value;
    }
}

/// @notice Adversarial proof that the mainnet contract path (VoidReleaseFactoryV2Royalty →
/// VoidRelease1155V4Royalty clones → ReleaseMarketplaceV4) enforces the 2.5% artist royalty to an
/// artist wallet of the release, at creation, at listing and at settlement, whatever entry point
/// or token an attacker uses.
contract RoyaltyEnforcementTest {
    VmRoyalty internal constant vm = VmRoyalty(address(uint160(uint256(keccak256("hevm cheat code")))));

    address internal constant PLATFORM = address(0xFEE5);
    address internal constant ARTIST = address(0xA11CE);
    address internal constant CO_ARTIST = address(0xA11CE2);
    address internal constant STRANGER = address(0x5757);
    address internal constant COLLECTOR = address(0xC011);
    address internal constant BUYER = address(0xB0B);
    bytes32 internal constant APP = keccak256("royalty-app");

    VoidReleaseFactoryV2Royalty internal factory;
    ReleaseMarketplaceV4 internal market;
    VoidRelease1155V4Royalty internal release;
    VoidPrimarySale internal sale;
    bytes32 internal key;

    function setUp() public {
        factory = new VoidReleaseFactoryV2Royalty(PLATFORM);
        market = new ReleaseMarketplaceV4(PLATFORM, 250, address(factory));
        key = keccak256(abi.encode("the-void:studio-release:v2", block.chainid, address(factory), APP, ARTIST));
        vm.prank(ARTIST);
        (address releaseContract, address primarySale,) = factory.createRelease(APP, key, "Release", "REL", "ipfs://release");
        release = VoidRelease1155V4Royalty(releaseContract);
        sale = VoidPrimarySale(primarySale);
    }

    function expectCreateFails(bytes memory call, string memory reason) internal {
        vm.prank(ARTIST);
        (bool ok,) = address(release).call(call);
        require(!ok, reason);
    }

    // ---------------------------------------------------------------- deployment wiring

    function testFactoryClonesTheRoyaltyLockedImplementation() public view {
        VoidRelease1155V4Royalty implementation = VoidRelease1155V4Royalty(factory.implementation());
        require(implementation.REQUIRED_ROYALTY_BPS() == 250 && factory.REQUIRED_ROYALTY_BPS() == 250, "250 bps everywhere");
        require(implementation.platformFeeRecipient() == PLATFORM && release.platformFeeRecipient() == PLATFORM, "clones share the forbidden recipient");
        require(factory.PLATFORM_FEE_BPS() == 250 && factory.RELEASE_VERSION() == 2, "V2 economics and version unchanged");
        require(market.REQUIRED_ROYALTY_BPS() == 250 && market.platformFeeBps() == 250 && market.feeRecipient() == PLATFORM, "marketplace policy");
    }

    function testMarketplaceRefusesAnyFeeOtherThan250Bps() public {
        try new ReleaseMarketplaceV4(PLATFORM, 500, address(factory)) { revert("500 bps fee must be refused"); } catch {}
        try new ReleaseMarketplaceV4(PLATFORM, 0, address(factory)) { revert("0 bps fee must be refused"); } catch {}
    }

    function testImplementationCannotBeInitializedOrUsedDirectly() public {
        VoidRelease1155V4Royalty implementation = VoidRelease1155V4Royalty(factory.implementation());
        vm.prank(STRANGER);
        try implementation.initializeRelease(STRANGER, STRANGER, key, "x", "x", "x") { revert("only the factory initializes"); } catch {}
        vm.prank(STRANGER);
        try implementation.createEdition(key, "e", 1, "ipfs://e", STRANGER, 500) { revert("implementation has no artist"); } catch {}
    }

    // ---------------------------------------------------------------- creation: every entry point

    function testEveryCreationEntryPointRefusesAnyRoyaltyOtherThan250Bps() public {
        uint96[4] memory bad = [uint96(0), 249, 251, 1000];
        for (uint256 i = 0; i < bad.length; i++) {
            expectCreateFails(abi.encodeWithSignature("createEdition(bytes32,bytes32,uint256,string,address,uint96)", key, bytes32(i + 1), 10, "ipfs://e", ARTIST, bad[i]), "createEdition with a non-250 royalty");
            expectCreateFails(abi.encodeWithSignature("createEditionWithMintEnd(bytes32,bytes32,uint256,string,address,uint96,uint64)", key, bytes32(i + 1), 10, "ipfs://e", ARTIST, bad[i], uint64(0)), "createEditionWithMintEnd with a non-250 royalty");
        }
        // The four-argument overload sets royalty 0, so it can never create an edition here.
        expectCreateFails(abi.encodeWithSignature("createEdition(bytes32,bytes32,uint256,string)", key, bytes32("four"), 10, "ipfs://e"), "four-argument createEdition");

        vm.prank(ARTIST);
        release.createAlbum(key);
        expectCreateFails(abi.encodeWithSignature("createAlbumTrack(bytes32,bytes32,uint256,string,address,uint96,bool,uint64)", key, bytes32("track"), 10, "ipfs://t", ARTIST, uint96(500), false, uint64(0)), "createAlbumTrack with a non-250 royalty");
        vm.prank(ARTIST);
        uint256 track = release.createAlbumTrack(key, "track", 10, "ipfs://t", ARTIST, 250, false, 0);
        require(release.royaltyBpsOf(track) == 250 && release.payoutOf(track) == ARTIST, "a compliant album track is created");
    }

    function testRoyaltyRecipientMustBeAnArtistWalletOfTheReleaseAndNeverThePlatform() public {
        expectCreateFails(abi.encodeWithSignature("createEdition(bytes32,bytes32,uint256,string,address,uint96)", key, bytes32("a"), 10, "ipfs://e", PLATFORM, uint96(250)), "platform as payout");
        expectCreateFails(abi.encodeWithSignature("createEdition(bytes32,bytes32,uint256,string,address,uint96)", key, bytes32("b"), 10, "ipfs://e", STRANGER, uint96(250)), "unauthorized wallet as payout");
        // Even if the artist grants the platform recipient ARTIST_ROLE, it can never be the payout.
        bytes32 artistRole = release.ARTIST_ROLE();
        vm.prank(ARTIST);
        release.grantRole(artistRole, PLATFORM);
        expectCreateFails(abi.encodeWithSignature("createEdition(bytes32,bytes32,uint256,string,address,uint96)", key, bytes32("c"), 10, "ipfs://e", PLATFORM, uint96(250)), "platform with ARTIST_ROLE as payout");
        // A second wallet the artist authorized on this release may receive its own edition's royalty.
        vm.prank(ARTIST);
        release.grantRole(artistRole, CO_ARTIST);
        vm.prank(ARTIST);
        uint256 tokenId = release.createEdition(key, "d", 10, "ipfs://e", CO_ARTIST, 250);
        (address receiver, uint256 amount) = release.royaltyInfo(tokenId, 1 ether);
        require(receiver == CO_ARTIST && amount == 0.025 ether, "authorized edition payout receives exactly 2.5%");
    }

    // ---------------------------------------------------------------- marketplace: independent checks

    function testMarketplaceRefusesAReleaseFromANonEnforcingFactory() public {
        // A plain V2 factory clone can carry a 5% royalty; the policy marketplace still refuses it.
        VoidReleaseFactoryV2 plain = new VoidReleaseFactoryV2(PLATFORM);
        ReleaseMarketplaceV4 strictOnPlain = new ReleaseMarketplaceV4(PLATFORM, 250, address(plain));
        bytes32 plainKey = keccak256(abi.encode("the-void:studio-release:v2", block.chainid, address(plain), APP, ARTIST));
        vm.prank(ARTIST);
        (address plainRelease, address plainSale,) = plain.createRelease(APP, plainKey, "Plain", "P", "ipfs://p");
        vm.prank(ARTIST);
        uint256 tokenId = VoidRelease1155V4(plainRelease).createEdition(plainKey, "e", 10, "ipfs://e", ARTIST, 500);
        vm.prank(ARTIST);
        VoidPrimarySale(plainSale).configureSale(tokenId, 1 ether, 10, 5, 0, 0, false);
        vm.deal(COLLECTOR, 1 ether);
        vm.prank(COLLECTOR);
        VoidPrimarySale(plainSale).purchase{value: 1 ether}(tokenId, 1);
        vm.prank(COLLECTOR);
        VoidRelease1155V4(plainRelease).setApprovalForAll(address(strictOnPlain), true);
        vm.prank(COLLECTOR);
        try strictOnPlain.createListing(plainRelease, COLLECTOR, tokenId, 1, 1 ether, 0) { revert("5% royalty edition must not list"); } catch {}
        // And a release from another factory is not even a supported release of the mainnet marketplace.
        vm.prank(COLLECTOR);
        try market.createListing(plainRelease, COLLECTOR, tokenId, 1, 1 ether, 0) { revert("foreign factory release must not list"); } catch {}
    }

    function testMarketplaceRechecksThePolicyAtSettlement() public {
        PermissiveRegistry registry = new PermissiveRegistry();
        ReleaseMarketplaceV4 open = new ReleaseMarketplaceV4(PLATFORM, 250, address(registry));
        MutableRoyaltyToken token = new MutableRoyaltyToken(ARTIST);
        token.mint(COLLECTOR, 1);
        vm.prank(COLLECTOR);
        token.setApprovalForAll(address(open), true);
        vm.deal(BUYER, 10 ether);

        // Refused at listing: wrong rate, platform payout, zero payout.
        token.setPolicy(500, ARTIST);
        vm.prank(COLLECTOR);
        try open.createListing(address(token), COLLECTOR, 1, 1, 1 ether, 0) { revert("500 bps must not list"); } catch {}
        token.setPolicy(250, PLATFORM);
        vm.prank(COLLECTOR);
        try open.createListing(address(token), COLLECTOR, 1, 1, 1 ether, 0) { revert("platform payout must not list"); } catch {}
        token.setPolicy(250, address(0));
        vm.prank(COLLECTOR);
        try open.createListing(address(token), COLLECTOR, 1, 1, 1 ether, 0) { revert("zero payout must not list"); } catch {}

        // Compliant at listing, then changed before settlement: every change refuses the sale.
        token.setPolicy(250, ARTIST);
        vm.prank(COLLECTOR);
        uint256 listingId = open.createListing(address(token), COLLECTOR, 1, 1, 1 ether, 0);
        token.setPolicy(1000, ARTIST);
        vm.prank(BUYER);
        try open.buy{value: 1 ether}(listingId, 1) { revert("raised royalty must not settle"); } catch {}
        token.setPolicy(250, PLATFORM);
        vm.prank(BUYER);
        try open.buy{value: 1 ether}(listingId, 1) { revert("platform payout must not settle"); } catch {}
        token.setPolicy(250, ARTIST);
        token.setReported(STRANGER, 250);
        vm.prank(BUYER);
        try open.buy{value: 1 ether}(listingId, 1) { revert("royaltyInfo pointing elsewhere must not settle"); } catch {}
        token.setReported(ARTIST, 1000);
        vm.prank(BUYER);
        try open.buy{value: 1 ether}(listingId, 1) { revert("royaltyInfo reporting 10% must not settle"); } catch {}
        require(BUYER.balance == 10 ether && token.balanceOf(COLLECTOR, 1) == 1, "refused sales move nothing");

        // Restored: settles at exactly 2.5% / 2.5% / 95%.
        token.setReported(ARTIST, 250);
        uint256 artistBefore = ARTIST.balance;
        uint256 platformBefore = PLATFORM.balance;
        uint256 sellerBefore = COLLECTOR.balance;
        vm.prank(BUYER);
        open.buy{value: 1 ether}(listingId, 1);
        require(ARTIST.balance == artistBefore + 0.025 ether, "artist 2.5%");
        require(PLATFORM.balance == platformBefore + 0.025 ether, "platform 2.5%");
        require(COLLECTOR.balance == sellerBefore + 0.95 ether, "seller 95%");
    }

    // ---------------------------------------------------------------- the valid mainnet path

    function testValidMainnetResalePaysTheExactSplit() public {
        vm.prank(ARTIST);
        uint256 tokenId = release.createEdition(key, "edition", 10, "ipfs://e", ARTIST, 250);
        vm.prank(ARTIST);
        sale.configureSale(tokenId, 1 ether, 10, 5, 0, 0, false);
        vm.deal(COLLECTOR, 1 ether);
        vm.prank(COLLECTOR);
        sale.purchase{value: 1 ether}(tokenId, 1);
        require(sale.balances(PLATFORM) == 0.025 ether && sale.balances(ARTIST) == 0.975 ether, "primary 2.5% / 97.5%");

        vm.prank(COLLECTOR);
        release.setApprovalForAll(address(market), true);
        vm.prank(COLLECTOR);
        uint256 listingId = market.createListing(address(release), COLLECTOR, tokenId, 1, 1 ether, 0);
        uint256 artistBefore = ARTIST.balance;
        uint256 platformBefore = PLATFORM.balance;
        uint256 sellerBefore = COLLECTOR.balance;
        vm.deal(BUYER, 1 ether);
        vm.prank(BUYER);
        market.buy{value: 1 ether}(listingId, 1);
        require(ARTIST.balance == artistBefore + 0.025 ether, "artist royalty exactly 2.5%");
        require(PLATFORM.balance == platformBefore + 0.025 ether, "marketplace fee exactly 2.5%");
        require(COLLECTOR.balance == sellerBefore + 0.95 ether, "seller exactly 95%");
        require(release.balanceOf(BUYER, tokenId) == 1 && release.balanceOf(COLLECTOR, tokenId) == 0, "ownership moved");
        require(uint8(market.listingStatus(listingId)) == uint8(ReleaseMarketplaceV4.Status.SOLD), "listing sold");
    }
}
