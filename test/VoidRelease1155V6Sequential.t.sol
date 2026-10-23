// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VoidReleaseFactoryV4Sequential} from "../contracts/VoidReleaseFactoryV4Sequential.sol";
import {VoidReleaseFactoryV2RoyaltySettled} from "../contracts/VoidReleaseFactoryV2RoyaltySettled.sol";
import {VoidRelease1155V6Sequential} from "../contracts/VoidRelease1155V6Sequential.sol";
import {VoidCollection1155} from "../contracts/VoidCollection1155.sol";
import {VoidPrimarySaleSettled} from "../contracts/VoidPrimarySaleSettled.sol";
import {VoidProvenanceAnchor} from "../contracts/VoidProvenanceAnchor.sol";
import {VoidUnifiedMarketplace} from "../contracts/VoidUnifiedMarketplace.sol";
import {GenesisHolderClaim} from "../contracts/GenesisHolderClaim.sol";
import {installGenesisStandIn} from "./helpers/MockGenesisCollection.sol";

interface VmSequential {
    function chainId(uint256) external;
    function warp(uint256) external;
    function deal(address, uint256) external;
    function prank(address) external;
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function recordLogs() external;
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }
    function getRecordedLogs() external returns (Log[] memory);
}

/// @dev Genesis stand-in: only what VoidUnifiedMarketplace's classification and Genesis preview read.
contract SequentialMockGenesis {
    address public royaltyReceiver;
    constructor(address receiver) { royaltyReceiver = receiver; }
    function royaltyInfo(uint256, uint256 price) external view returns (address, uint256) {
        return (royaltyReceiver, (price * 500) / 10_000);
    }
}

/// @notice Local EVM only, nothing deployed or broadcast. VoidReleaseFactoryV4Sequential and its
/// VoidRelease1155V6Sequential clones: on-chain token IDs 1, 2, 3, ... per release contract, enforced by the
/// contract, with the mainnet royalty lock, issuance split, settled primary sale, per-release provenance
/// anchor, Genesis claim and unified-marketplace paths unchanged.
contract VoidRelease1155V6SequentialTest {
    VmSequential internal constant vm = VmSequential(address(uint160(uint256(keccak256("hevm cheat code")))));

    address internal constant NANO = 0xb65C575CaE01574296Fab6E620B9A15cC0121ce4;
    address internal constant GENESIS_RECEIVER = 0x284C09a7CC187E096cbbdc88d99DEFE6df32180a;
    address internal constant ARTIST = address(0xA7157);
    address internal constant COLLABORATOR = address(0xC0FFEE);
    address internal constant STRANGER = address(0x57A);
    address internal constant HOLDER = address(0xB0B);
    address internal constant BUYER = address(0xB0B2);
    address internal constant ADMIN = address(0xAD01);
    address internal constant CLAIMANT = address(0xCA11);
    uint256 internal constant SIGNER_KEY = 0xA11CE;
    uint256 internal constant T0 = 1_800_000_000;
    bytes32 internal constant APP = keccak256("forgive-and-forget-sequential");
    string internal constant URI = "ipfs://forgive-and-forget";

    VoidReleaseFactoryV4Sequential internal factory;
    VoidRelease1155V6Sequential internal release;
    VoidPrimarySaleSettled internal sale;
    VoidProvenanceAnchor internal anchor;
    bytes32 internal releaseKey;

    function setUp() public {
        vm.chainId(43114);
        vm.warp(T0);
        factory = new VoidReleaseFactoryV4Sequential(NANO);
        (release, sale, anchor, releaseKey) = _newRelease(factory, APP);
    }

    // ------------------------------------------------------------------ helpers

    function _key(address f, bytes32 app, address artist) internal view returns (bytes32) {
        return keccak256(abi.encode("the-void:studio-release:v2", block.chainid, f, app, artist));
    }

    function _newRelease(VoidReleaseFactoryV4Sequential f, bytes32 app)
        internal
        returns (VoidRelease1155V6Sequential r, VoidPrimarySaleSettled s, VoidProvenanceAnchor a, bytes32 key)
    {
        key = _key(address(f), app, ARTIST);
        vm.prank(ARTIST);
        (address releaseAddress, address saleAddress, address anchorAddress) = f.createRelease(app, key, "Forgive & Forget", "FNF", "ipfs://fnf");
        r = VoidRelease1155V6Sequential(releaseAddress);
        s = VoidPrimarySaleSettled(saleAddress);
        a = VoidProvenanceAnchor(anchorAddress);
    }

    function _id(uint256 n) internal pure returns (bytes32) {
        return bytes32(n);
    }

    function _create(VoidRelease1155V6Sequential r, bytes32 key, uint256 n) internal returns (uint256 tokenId) {
        vm.prank(ARTIST);
        tokenId = r.createEdition(key, _id(n), 0, URI, ARTIST, 250);
    }

    function _create6(bytes32 key, bytes32 editionId, address payout, uint96 bps) internal pure returns (bytes memory) {
        return abi.encodeWithSignature("createEdition(bytes32,bytes32,uint256,string,address,uint96)", key, editionId, uint256(0), URI, payout, bps);
    }

    function _create4(bytes32 key, bytes32 editionId) internal pure returns (bytes memory) {
        return abi.encodeWithSignature("createEdition(bytes32,bytes32,uint256,string)", key, editionId, uint256(0), URI);
    }

    function _createWithMintEnd(bytes32 key, bytes32 editionId, uint64 mintEnd) internal pure returns (bytes memory) {
        return abi.encodeWithSignature(
            "createEditionWithMintEnd(bytes32,bytes32,uint256,string,address,uint96,uint64)", key, editionId, uint256(0), URI, ARTIST, uint96(250), mintEnd
        );
    }

    function _albumTrack(bytes32 key, bytes32 editionId, bool single) internal pure returns (bytes memory) {
        return abi.encodeWithSignature(
            "createAlbumTrack(bytes32,bytes32,uint256,string,address,uint96,bool,uint64)", key, editionId, uint256(0), URI, ARTIST, uint96(250), single, uint64(0)
        );
    }

    function _expectRevert(address caller, address target, bytes memory data, bytes memory expected, string memory why) internal {
        vm.prank(caller);
        (bool ok, bytes memory ret) = target.call(data);
        require(!ok, why);
        require(keccak256(ret) == keccak256(expected), string.concat(why, ": wrong revert"));
    }

    function _nonSequential(uint256 expected, uint256 supplied) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(VoidRelease1155V6Sequential.NonSequentialTokenId.selector, expected, supplied);
    }

    function _editionMissing(VoidRelease1155V6Sequential r, uint256 tokenId) internal view returns (bool) {
        try r.edition(tokenId) returns (VoidCollection1155.Edition memory) {
            return false;
        } catch (bytes memory data) {
            return keccak256(data) == keccak256(abi.encodeWithSelector(VoidCollection1155.EditionNotFound.selector, tokenId));
        }
    }

    // ------------------------------------------------------------------ 1. first edition is token 1

    function testFirstEditionIsOnChainTokenOne() public {
        require(release.lastTokenId() == 0 && release.nextTokenId() == 1, "fresh clone starts before 1");
        vm.recordLogs();
        uint256 tokenId = _create(release, releaseKey, 1);
        require(tokenId == 1, "first token ID is 1");
        VmSequential.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic0 = keccak256("EditionCreated(uint256,bytes32,bytes32,address,uint256,string)");
        bool found;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(release) && logs[i].topics.length == 4 && logs[i].topics[0] == topic0) {
                require(logs[i].topics[1] == bytes32(uint256(1)), "EditionCreated tokenId 1");
                require(logs[i].topics[2] == releaseKey && logs[i].topics[3] == _id(1), "EditionCreated identity");
                (address artist, uint256 maxSupply, string memory metadataUri) = abi.decode(logs[i].data, (address, uint256, string));
                require(artist == ARTIST && maxSupply == 0 && keccak256(bytes(metadataUri)) == keccak256(bytes(URI)), "EditionCreated data");
                found = true;
            }
        }
        require(found, "EditionCreated emitted by the clone");
        VoidCollection1155.Edition memory e = release.edition(1);
        require(e.exists && e.releaseId == releaseKey && e.editionId == _id(1) && e.artist == ARTIST, "edition(1) record");
        require(keccak256(bytes(e.metadataUri)) == keccak256(bytes(URI)) && keccak256(bytes(release.uri(1))) == keccak256(bytes(URI)), "metadata URI");
        require(release.lastTokenId() == 1 && release.nextTokenId() == 2, "counter advanced to 1");
        require(release.tokenIdFor(releaseKey, _id(1)) == 1 && release.tokenIdFor(bytes32(0), _id(7)) == 7, "tokenIdFor reads the number");
        (address receiver, uint256 royalty) = release.royaltyInfo(1, 1 ether);
        require(receiver == ARTIST && royalty == 0.025 ether && release.payoutOf(1) == ARTIST, "2.5% royalty to the artist");
    }

    // ------------------------------------------------------------------ 2. contiguous across paths

    function testStandalonePathsShareOneContiguousSequence() public {
        require(_create(release, releaseKey, 1) == 1, "1 via createEdition");
        vm.prank(ARTIST);
        uint256 second = release.createEditionWithMintEnd(releaseKey, _id(2), 0, URI, ARTIST, 250, uint64(T0 + 30 days));
        require(second == 2 && release.mintEndOf(2) == uint64(T0 + 30 days), "2 via createEditionWithMintEnd");
        require(_create(release, releaseKey, 3) == 3, "3 via createEdition");
        require(release.lastTokenId() == 3 && release.nextTokenId() == 4, "counter at 3");
    }

    function testAlbumTracksAreNumberedFromOneOnTheirOwnClone() public {
        (VoidRelease1155V6Sequential album,,, bytes32 key) = _newRelease(factory, keccak256("album"));
        vm.prank(ARTIST);
        album.createAlbum(key);
        vm.prank(ARTIST);
        uint256 first = album.createAlbumTrack(key, _id(1), 0, URI, ARTIST, 250, false, 0);
        vm.prank(ARTIST);
        uint256 second = album.createAlbumTrack(key, _id(2), 0, URI, ARTIST, 250, true, 0);
        require(first == 1 && second == 2, "album tracks 1 and 2");
        require(!album.isAlbumSingle(1) && album.isAlbumSingle(2) && album.albumTrackCount() == 2 && album.albumSingleCount() == 1, "album accounting");
        _expectRevert(ARTIST, address(album), _create6(key, _id(3), ARTIST, 250), abi.encodeWithSelector(VoidRelease1155V6Sequential.AlbumTrackPathRequired.selector), "standalone after album");
        _expectRevert(ARTIST, address(album), _albumTrack(key, _id(4), false), _nonSequential(3, 4), "album track skipping 3");
        require(album.lastTokenId() == 2, "rejected calls consumed nothing");
        vm.prank(ARTIST);
        require(album.createAlbumTrack(key, _id(3), 0, URI, ARTIST, 250, false, 0) == 3, "album track 3");
        require(release.lastTokenId() == 0, "the other clone is untouched");
    }

    // ------------------------------------------------------------------ 3. invalid and stale IDs

    function testInvalidAndStaleIdsRevertWithoutConsumingAnId() public {
        // Zero: the sequential check fires before the base InvalidIdentifier check.
        _expectRevert(ARTIST, address(release), _create6(releaseKey, bytes32(0), ARTIST, 250), _nonSequential(1, 0), "editionId 0");
        _expectRevert(ARTIST, address(release), _create6(releaseKey, _id(2), ARTIST, 250), _nonSequential(1, 2), "2 before 1");
        // The previous hash-derived edition identity is refused outright.
        bytes32 hashed = bytes32(uint256(keccak256(abi.encode("the-void:release-edition:v1", bytes32("forgive-forget")))));
        _expectRevert(ARTIST, address(release), _create6(releaseKey, hashed, ARTIST, 250), _nonSequential(1, uint256(hashed)), "hash-derived id");
        require(release.lastTokenId() == 0 && release.nextTokenId() == 1, "nothing consumed before 1");

        require(_create(release, releaseKey, 1) == 1, "1");
        _expectRevert(ARTIST, address(release), _create6(releaseKey, _id(1), ARTIST, 250), _nonSequential(2, 1), "reused 1");
        _expectRevert(ARTIST, address(release), _createWithMintEnd(releaseKey, _id(1), uint64(T0 + 1 days)), _nonSequential(2, 1), "reused 1 via mint-end path");
        _expectRevert(ARTIST, address(release), _create6(releaseKey, _id(3), ARTIST, 250), _nonSequential(2, 3), "N+2");
        require(release.lastTokenId() == 1 && _editionMissing(release, 2) && _editionMissing(release, 3), "stale and skipped ids consumed nothing");

        require(_create(release, releaseKey, 2) == 2, "2 still next");
        require(release.lastTokenId() == 2, "contiguous after rejections");
    }

    // ------------------------------------------------------------------ 4. independent clones

    function testSeparateClonesEachStartAtOne() public {
        (VoidRelease1155V6Sequential other,,, bytes32 otherKey) = _newRelease(factory, keccak256("another release"));
        require(address(other) != address(release), "distinct clones");
        require(_create(release, releaseKey, 1) == 1 && _create(other, otherKey, 1) == 1, "both start at 1");
        require(_create(release, releaseKey, 2) == 2, "first clone advances");
        require(release.lastTokenId() == 2 && other.lastTokenId() == 1 && other.nextTokenId() == 2, "counters are per clone");
        _expectRevert(ARTIST, address(other), _create6(otherKey, _id(3), ARTIST, 250), _nonSequential(2, 3), "other clone does not follow the first");
        // Same numeric ID, different assets: supply and balances stay isolated.
        require(release.edition(1).releaseId == releaseKey && other.edition(1).releaseId == otherKey, "token 1 of each clone is its own edition");
    }

    // ------------------------------------------------------------------ 5. duplicate titles

    function testDuplicateTitlesGetDistinctSequentialIds() public {
        // Identical metadata (same name, same URI): numbering does not depend on title uniqueness.
        require(_create(release, releaseKey, 1) == 1 && _create(release, releaseKey, 2) == 2, "same title twice is 1 and 2");
        require(keccak256(bytes(release.uri(1))) == keccak256(bytes(release.uri(2))), "same metadata");
        require(release.edition(1).exists && release.edition(2).exists && release.lastTokenId() == 2, "two editions");
    }

    // ------------------------------------------------------------------ 6. royalty lock

    function testRoyaltyLockIsPreservedAndRejectionsConsumeNothing() public {
        bytes memory wrongRate = abi.encodeWithSelector(VoidRelease1155V6Sequential.RoyaltyPolicyViolation.selector, uint96(0), uint96(250));
        _expectRevert(ARTIST, address(release), _create4(releaseKey, _id(1)), wrongRate, "4-arg createEdition (zero royalty)");
        _expectRevert(ARTIST, address(release), _create6(releaseKey, _id(1), ARTIST, 249), abi.encodeWithSelector(VoidRelease1155V6Sequential.RoyaltyPolicyViolation.selector, uint96(249), uint96(250)), "249 bps");
        _expectRevert(ARTIST, address(release), _create6(releaseKey, _id(1), ARTIST, 1000), abi.encodeWithSelector(VoidRelease1155V6Sequential.RoyaltyPolicyViolation.selector, uint96(1000), uint96(250)), "1000 bps");
        _expectRevert(ARTIST, address(release), _create6(releaseKey, _id(1), NANO, 250), abi.encodeWithSelector(VoidRelease1155V6Sequential.UnauthorizedRoyaltyRecipient.selector, NANO), "platform payout");
        _expectRevert(ARTIST, address(release), _create6(releaseKey, _id(1), STRANGER, 250), abi.encodeWithSelector(VoidRelease1155V6Sequential.UnauthorizedRoyaltyRecipient.selector, STRANGER), "payout without ARTIST_ROLE");
        require(release.lastTokenId() == 0, "royalty rejections consumed nothing");

        // A payout wallet the artist granted ARTIST_ROLE is accepted, as on VoidRelease1155V4Royalty.
        bytes32 artistRole = release.ARTIST_ROLE();
        vm.prank(ARTIST);
        release.grantRole(artistRole, COLLABORATOR);
        vm.prank(ARTIST);
        require(release.createEdition(releaseKey, _id(1), 0, URI, COLLABORATOR, 250) == 1, "collaborator payout");
        require(release.payoutOf(1) == COLLABORATOR && release.royaltyBpsOf(1) == 250, "payout recorded");
    }

    // ------------------------------------------------------------------ 7. authorization

    function testIssuanceAndAdministrationAuthority() public {
        bytes32 artistRole = release.ARTIST_ROLE();
        bytes32 issuerRole = release.ISSUER_ROLE();
        bytes32 adminRole = release.DEFAULT_ADMIN_ROLE();
        require(release.hasRole(adminRole, ARTIST) && release.hasRole(artistRole, ARTIST), "artist administers and creates");
        require(!release.hasRole(issuerRole, ARTIST), "artist cannot mint directly");
        require(release.hasRole(issuerRole, address(sale)), "the sale is the issuer");
        require(!release.hasRole(adminRole, NANO) && !release.hasRole(issuerRole, NANO) && !release.hasRole(adminRole, address(factory)), "platform holds no role");

        _expectRevert(STRANGER, address(release), _create6(releaseKey, _id(1), ARTIST, 250), abi.encodeWithSelector(VoidCollection1155.AccessDenied.selector, artistRole, STRANGER), "stranger creates");
        _expectRevert(
            ARTIST, address(release), abi.encodeWithSignature("mint(address,uint256,uint256,bytes)", ARTIST, uint256(1), uint256(1), ""),
            abi.encodeWithSelector(VoidCollection1155.AccessDenied.selector, issuerRole, ARTIST), "artist mints"
        );
        bytes32 wrongKey = keccak256("not this release");
        _expectRevert(ARTIST, address(release), _create6(wrongKey, _id(1), ARTIST, 250), abi.encodeWithSelector(VoidRelease1155V6Sequential.ReleaseKeyMismatch.selector, releaseKey, wrongKey), "wrong release key");
        _expectRevert(ARTIST, address(release), abi.encodeWithSignature("transferOwnership(address)", STRANGER), abi.encodeWithSelector(VoidRelease1155V6Sequential.OwnershipTransferUnsupported.selector), "ownership transfer");

        vm.prank(ARTIST);
        release.pause();
        _expectRevert(ARTIST, address(release), _create6(releaseKey, _id(1), ARTIST, 250), abi.encodeWithSelector(VoidCollection1155.ContractPaused.selector), "paused creation");
        vm.prank(ARTIST);
        release.unpause();
        require(release.lastTokenId() == 0, "unauthorized and paused calls consumed nothing");
        require(_create(release, releaseKey, 1) == 1, "creation after unpause");

        // Album tracks need DEFAULT_ADMIN_ROLE, not just ARTIST_ROLE.
        (VoidRelease1155V6Sequential album,,, bytes32 albumKey) = _newRelease(factory, keccak256("album auth"));
        vm.prank(ARTIST);
        album.createAlbum(albumKey);
        vm.prank(ARTIST);
        album.grantRole(artistRole, COLLABORATOR);
        _expectRevert(COLLABORATOR, address(album), _albumTrack(albumKey, _id(1), false), abi.encodeWithSelector(VoidCollection1155.AccessDenied.selector, adminRole, COLLABORATOR), "album track without admin");
        require(album.lastTokenId() == 0, "denied album track consumed nothing");
    }

    function testImplementationAndClonesCannotBeReinitialized() public {
        VoidRelease1155V6Sequential implementation = VoidRelease1155V6Sequential(factory.implementation());
        _expectRevert(
            STRANGER, address(implementation),
            abi.encodeWithSignature("initializeRelease(address,address,bytes32,string,string,string)", STRANGER, STRANGER, keccak256("k"), "x", "X", ""),
            abi.encodeWithSelector(VoidCollection1155.NotFactory.selector), "implementation initializeRelease"
        );
        _expectRevert(
            STRANGER, address(implementation),
            abi.encodeWithSignature("initialize(address,address,string,string,string)", STRANGER, STRANGER, "x", "X", ""),
            abi.encodeWithSelector(VoidRelease1155V6Sequential.DirectInitializationDisabled.selector), "implementation initialize"
        );
        _expectRevert(
            STRANGER, address(release),
            abi.encodeWithSignature("initializeRelease(address,address,bytes32,string,string,string)", STRANGER, STRANGER, keccak256("k"), "x", "X", ""),
            abi.encodeWithSelector(VoidCollection1155.NotFactory.selector), "clone re-initialization"
        );
        require(implementation.lastTokenId() == 0 && implementation.releaseKey() == bytes32(0), "implementation holds no release");
    }

    // ------------------------------------------------------------------ 8. settled primary sale

    function testSettledPrimarySaleSellsTokenOne() public {
        _create(release, releaseKey, 1);
        vm.prank(ARTIST);
        sale.configureSale(1, 0.4 ether, 0, 0, 0, uint64(T0 + 30 days), false);
        (uint256 price,,,,,,, bool configured) = sale.sales(1);
        require(configured && price == 0.4 ether, "sale configured for token 1");

        uint256 nanoBefore = NANO.balance;
        vm.deal(BUYER, 0.8 ether);
        vm.prank(BUYER);
        sale.purchase{value: 0.8 ether}(1, 2);
        require(release.balanceOf(BUYER, 1) == 2 && release.edition(1).mintedSupply == 2, "token 1 minted to the buyer");
        require(NANO.balance - nanoBefore == 0.02 ether, "platform 2.5% pushed in the purchase");
        require(sale.balances(ARTIST) == 0.78 ether && sale.balances(NANO) == 0, "artist 97.5% pull balance");

        _expectRevert(ARTIST, address(sale), abi.encodeCall(VoidPrimarySaleSettled.configureSale, (2, 0.4 ether, 0, 0, 0, uint64(T0 + 30 days), false)),
            abi.encodeWithSelector(VoidCollection1155.EditionNotFound.selector, 2), "sale for a token that does not exist");
        vm.deal(BUYER, 0.4 ether);
        _expectRevert(BUYER, address(sale), abi.encodeCall(VoidPrimarySaleSettled.purchase, (2, 1)), abi.encodeWithSelector(VoidPrimarySaleSettled.SaleNotConfigured.selector, 2), "purchase of token 2");
    }

    // ------------------------------------------------------------------ 9. provenance anchor

    function testProvenanceAnchorBindsSequentialTokenOne() public {
        _create(release, releaseKey, 1);
        bytes32 root = keccak256("provenance root");
        vm.recordLogs();
        vm.prank(ARTIST);
        anchor.anchor(releaseKey, _id(1), root);
        require(anchor.isAnchored(releaseKey, _id(1), root), "anchored");
        VmSequential.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic0 = keccak256("ProvenanceAnchored(bytes32,bytes32,bytes32,uint256,address,address)");
        bool found;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(anchor) && logs[i].topics.length == 4 && logs[i].topics[0] == topic0) {
                require(logs[i].topics[1] == root && logs[i].topics[2] == releaseKey && logs[i].topics[3] == _id(1), "anchor topics");
                (uint256 tokenId, address artist, address releaseContract) = abi.decode(logs[i].data, (uint256, address, address));
                require(tokenId == 1 && artist == ARTIST && releaseContract == address(release), "anchor names token 1");
                found = true;
            }
        }
        require(found, "ProvenanceAnchored emitted");

        vm.prank(ARTIST);
        (bool ok,) = address(anchor).call(abi.encodeCall(VoidProvenanceAnchor.anchor, (releaseKey, _id(2), keccak256("other root"))));
        require(!ok, "anchoring a token that does not exist");
        vm.prank(STRANGER);
        (ok,) = address(anchor).call(abi.encodeCall(VoidProvenanceAnchor.anchor, (releaseKey, _id(1), keccak256("stranger root"))));
        require(!ok, "only the edition artist anchors");
    }

    // ------------------------------------------------------------------ 10. Genesis holder claim

    function testGenesisHolderClaimBindsAndMintsTokenOne() public {
        // The claim reads Genesis balances on chain id 43114: give the claimant one Genesis unit.
        installGenesisStandIn(false).setBalance(CLAIMANT, 0, 1);
        uint256 claimStart = T0 + 1 hours;
        uint256 publicEnd = claimStart + 7 days - 1;
        vm.prank(ARTIST);
        require(release.createEditionWithMintEnd(releaseKey, _id(1), 0, URI, ARTIST, 250, uint64(publicEnd)) == 1, "token 1");
        vm.prank(ARTIST);
        sale.configureSale(1, 0.25 ether, 0, 20, uint64(claimStart), uint64(publicEnd), false);
        GenesisHolderClaim claim = new GenesisHolderClaim(address(release), address(sale), 1, 0, 0, claimStart, 1 days, 7 days, 0.25 ether, ADMIN, vm.addr(SIGNER_KEY));
        require(claim.tokenId() == 1 && claim.releaseContract() == address(release) && claim.primarySale() == address(sale), "claim bound to token 1");

        bytes32 issuerRole = release.ISSUER_ROLE();
        vm.prank(ARTIST);
        release.grantRole(issuerRole, address(claim));
        vm.warp(claimStart);
        GenesisHolderClaim.ClaimVoucher memory v = GenesisHolderClaim.ClaimVoucher({
            claimant: CLAIMANT,
            genesisContract: claim.GENESIS_CONTRACT(),
            genesisChainId: claim.GENESIS_CHAIN_ID(),
            eligibilityRule: claim.ELIGIBILITY_RULE(),
            destinationChainId: 43114,
            releaseContract: address(release),
            tokenId: 1,
            quantity: 1,
            allocation: claim.allocation(),
            nonce: 1,
            deadline: block.timestamp + 300
        });
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, claim.voucherDigest(v));
        vm.prank(CLAIMANT);
        claim.claim(v, abi.encodePacked(r, s, sv));
        require(release.balanceOf(CLAIMANT, 1) == 1 && claim.claimedSupply() == 1, "claim minted token 1");

        vm.deal(BUYER, 0.25 ether);
        vm.prank(BUYER);
        sale.purchase{value: 0.25 ether}(1, 1);
        require(release.balanceOf(BUYER, 1) == 1 && release.edition(1).mintedSupply == 2, "public sale alongside the claim");

        (bool ok,) = address(this).call(abi.encodeCall(this.deployClaimForMissingToken, (claimStart + 1 days)));
        require(!ok, "a claim for a token that does not exist cannot be deployed");
    }

    function deployClaimForMissingToken(uint256 start) external {
        new GenesisHolderClaim(address(release), address(sale), 2, 0, 0, start, 1 days, 7 days, 0.25 ether, ADMIN, vm.addr(SIGNER_KEY));
    }

    // ------------------------------------------------------------------ 11. unified marketplace

    VoidReleaseFactoryV2RoyaltySettled internal legacyFactory;
    VoidReleaseFactoryV4Sequential internal unknownFactory;
    SequentialMockGenesis internal genesis;
    VoidUnifiedMarketplace internal market;

    function _deployMarket() internal {
        legacyFactory = new VoidReleaseFactoryV2RoyaltySettled(NANO);
        unknownFactory = new VoidReleaseFactoryV4Sequential(NANO);
        genesis = new SequentialMockGenesis(GENESIS_RECEIVER);
        market = new VoidUnifiedMarketplace(NANO, address(factory), address(legacyFactory), address(genesis), 3, GENESIS_RECEIVER);
    }

    function testUnifiedMarketplaceClassifiesSequentialReleasesApartFromGenesis() public {
        _deployMarket();
        _create(release, releaseKey, 1);
        require(market.assetClassOf(address(release), 1) == VoidUnifiedMarketplace.AssetClass.FACTORY_RELEASE, "release token 1 is a factory release");
        require(market.assetClassOf(address(genesis), 1) == VoidUnifiedMarketplace.AssetClass.GENESIS, "Genesis token 1 is Genesis");
        require(market.assetClassOf(address(genesis), 4) == VoidUnifiedMarketplace.AssetClass.UNSUPPORTED, "Genesis range ends at 3");

        bytes32 legacyApp = keccak256("legacy");
        bytes32 legacyKey = _key(address(legacyFactory), legacyApp, ARTIST);
        vm.prank(ARTIST);
        (address legacyRelease,,) = legacyFactory.createRelease(legacyApp, legacyKey, "Legacy", "LEG", "ipfs://legacy");
        require(market.assetClassOf(legacyRelease, 1) == VoidUnifiedMarketplace.AssetClass.FACTORY_RELEASE, "legacy factory still recognised");

        (VoidUnifiedMarketplace.AssetClass c, uint256 fee, address receiver, uint256 royalty, uint256 net) = market.previewSettlement(address(release), 1, 1 ether);
        require(c == VoidUnifiedMarketplace.AssetClass.FACTORY_RELEASE && fee == 0.025 ether && receiver == ARTIST && royalty == 0.025 ether && net == 0.95 ether, "release preview");
        (c, fee, receiver, royalty, net) = market.previewSettlement(address(genesis), 1, 1 ether);
        require(c == VoidUnifiedMarketplace.AssetClass.GENESIS && fee == 0 && receiver == GENESIS_RECEIVER && royalty == 0.05 ether && net == 0.95 ether, "Genesis preview");
    }

    function testUnifiedMarketplaceResellsSequentialTokenOne() public {
        _deployMarket();
        _create(release, releaseKey, 1);
        vm.prank(ARTIST);
        sale.configureSale(1, 0.4 ether, 0, 0, 0, uint64(T0 + 30 days), false);
        vm.deal(HOLDER, 0.4 ether);
        vm.prank(HOLDER);
        sale.purchase{value: 0.4 ether}(1, 1);
        vm.prank(HOLDER);
        release.setApprovalForAll(address(market), true);
        vm.prank(HOLDER);
        uint256 listingId = market.createListing(address(release), HOLDER, 1, 1, 1 ether, 0);
        uint256 nano0 = NANO.balance;
        uint256 artist0 = ARTIST.balance;
        uint256 holder0 = HOLDER.balance;
        vm.deal(BUYER, 1 ether);
        vm.prank(BUYER);
        market.buy{value: 1 ether}(listingId, 1);
        require(NANO.balance - nano0 == 0.025 ether && ARTIST.balance - artist0 == 0.025 ether && HOLDER.balance - holder0 == 0.95 ether, "2.5 / 2.5 / 95");
        require(release.balanceOf(BUYER, 1) == 1 && release.balanceOf(HOLDER, 1) == 0, "token 1 delivered");
    }

    function testUnifiedMarketplaceRefusesAFactoryItWasNotBuiltFor() public {
        _deployMarket();
        (VoidRelease1155V6Sequential stray,,, bytes32 strayKey) = _newRelease(unknownFactory, keccak256("stray"));
        _create(stray, strayKey, 1);
        require(market.assetClassOf(address(stray), 1) == VoidUnifiedMarketplace.AssetClass.UNSUPPORTED, "unknown factory unsupported");
        bytes32 strayIssuer = stray.ISSUER_ROLE();
        vm.prank(ARTIST);
        stray.grantRole(strayIssuer, ARTIST);
        vm.prank(ARTIST);
        stray.mint(HOLDER, 1, 1, "");
        vm.prank(HOLDER);
        stray.setApprovalForAll(address(market), true);
        _expectRevert(HOLDER, address(market), abi.encodeCall(VoidUnifiedMarketplace.createListing, (address(stray), HOLDER, 1, 1, 1 ether, 0)),
            abi.encodeWithSelector(VoidUnifiedMarketplace.UnsupportedAsset.selector), "listing from an unknown factory");
    }

    // ------------------------------------------------------------------ 12. factory

    function testFactoryWiringVersionAndReleaseKeys() public {
        require(factory.RELEASE_VERSION() == 4 && factory.REQUIRED_ROYALTY_BPS() == 250 && factory.PLATFORM_FEE_BPS() == 250, "factory constants");
        require(factory.platformRecipient() == NANO, "platform recipient");
        VoidRelease1155V6Sequential implementation = VoidRelease1155V6Sequential(factory.implementation());
        require(implementation.IMPLEMENTATION_VERSION() == 6 && implementation.platformFeeRecipient() == NANO && implementation.REQUIRED_ROYALTY_BPS() == 250, "implementation");
        require(implementation.factory() == address(factory) && release.factory() == address(factory), "only this factory initializes clones");
        require(release.platformFeeRecipient() == NANO && release.IMPLEMENTATION_VERSION() == 6, "clone shares the immutables");
        require(factory.isRelease(address(release)) && factory.releaseOf(address(release)) == releaseKey && factory.releaseContractOf(releaseKey) == address(release), "registry");
        require(factory.primarySaleOf(address(release)) == address(sale) && factory.provenanceAnchorOf(address(release)) == address(anchor) && factory.artistOf(address(release)) == ARTIST, "infrastructure");
        require(address(sale.releases()) == address(release) && sale.platformRecipient() == NANO && sale.PLATFORM_FEE_BPS() == 250, "settled sale wiring");
        require(anchor.releaseContract() == address(release), "anchor wiring");
        require(keccak256(bytes(release.name())) == keccak256("Forgive & Forget") && keccak256(bytes(release.symbol())) == keccak256("FNF"), "name and symbol");
        require(release.releaseKey() == releaseKey && factory.releaseCount() == 1 && factory.releaseAt(0) == address(release), "release key and index");

        // Same key derivation as VoidReleaseFactoryV2RoyaltySettled, committing to this factory's address.
        bytes32 app = keccak256("second");
        bytes32 expected = keccak256(abi.encode("the-void:studio-release:v2", block.chainid, address(factory), app, ARTIST));
        bytes32 wrong = keccak256(abi.encode("the-void:studio-release:v2", block.chainid, address(0xF00D), app, ARTIST));
        _expectRevert(ARTIST, address(factory), abi.encodeCall(VoidReleaseFactoryV4Sequential.createRelease, (app, wrong, "x", "X", "")),
            abi.encodeWithSelector(VoidReleaseFactoryV4Sequential.ReleaseKeyMismatch.selector, expected, wrong), "key bound to another factory");
        _expectRevert(ARTIST, address(factory), abi.encodeCall(VoidReleaseFactoryV4Sequential.createRelease, (APP, releaseKey, "x", "X", "")),
            abi.encodeWithSelector(VoidReleaseFactoryV4Sequential.ReleaseAlreadyExists.selector, releaseKey, address(release)), "duplicate release key");

        vm.recordLogs();
        vm.prank(ARTIST);
        (address second,,) = factory.createRelease(app, expected, "Second", "SEC", "");
        VmSequential.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic0 = keccak256("ReleaseCreated(address,bytes32,address,address,address,address,uint256,uint16)");
        bool found;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(factory) && logs[i].topics[0] == topic0) {
                (,, address impl, uint256 index, uint16 version) = abi.decode(logs[i].data, (address, address, address, uint256, uint16));
                require(address(uint160(uint256(logs[i].topics[1]))) == second && impl == address(implementation) && index == 1 && version == 4, "ReleaseCreated");
                found = true;
            }
        }
        require(found, "ReleaseCreated emitted with version 4");
    }

    // ------------------------------------------------------------------ 13. fuzz: contiguous 1..n

    function testFuzzIdsAreContiguousFromOne(uint8 raw) public {
        uint256 n = uint256(raw) % 20 + 1;
        for (uint256 i = 1; i <= n; i++) {
            uint256 tokenId;
            if (i % 2 == 0) {
                vm.prank(ARTIST);
                tokenId = release.createEditionWithMintEnd(releaseKey, _id(i), i, URI, ARTIST, 250, uint64(T0 + 1 days));
            } else {
                tokenId = _create(release, releaseKey, i);
            }
            require(tokenId == i, "creation order is the token ID");
        }
        require(release.lastTokenId() == n && release.nextTokenId() == n + 1, "counter equals the edition count");
        for (uint256 i = 1; i <= n; i++) require(release.edition(i).exists && release.edition(i).editionId == _id(i), "every id 1..n exists");
        require(_editionMissing(release, n + 1) && _editionMissing(release, 0), "no id beyond n, none at 0");
    }
}
