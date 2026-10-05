// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GenesisHolderClaim} from "../contracts/GenesisHolderClaim.sol";
import {VoidReleaseFactory} from "../contracts/VoidReleaseFactory.sol";
import {VoidRelease1155V4} from "../contracts/VoidRelease1155V4.sol";
import {VoidPrimarySale} from "../contracts/VoidPrimarySale.sol";

interface VmClaim {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }
    function chainId(uint256) external;
    function warp(uint256) external;
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function prank(address) external;
    function expectPartialRevert(bytes4) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

contract GenesisHolderClaimTest {
    VmClaim internal constant vm = VmClaim(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 internal constant SIGNER_KEY = 0xA11CE;
    uint256 internal constant OTHER_SIGNER_KEY = 0xB0B;
    address internal constant ARTIST = address(0xA7157);
    address internal constant ADMIN = address(0xAD01);
    address internal constant CLAIMANT = address(0xCA11);
    address internal constant CLAIMANT_TWO = address(0xCA12);
    address internal constant PLATFORM = address(0xFEE);
    address internal constant SAFE = address(0x5AFE);
    uint256 internal tokenId;
    uint256 internal constant GENESIS_ALLOCATION = 3;
    uint256 internal constant PUBLIC_ALLOCATION = 7;
    bytes32 internal constant RELEASE_KEY = keccak256("genesis-holder-claim-test-release");
    bytes32 internal constant EDITION_ID = keccak256("genesis-holder-claim-test-edition");

    VoidRelease1155V4 internal release;
    VoidPrimarySale internal sale;
    GenesisHolderClaim internal claimContract;
    uint256 internal signerKey;
    address internal signer;

    function setUp() public {
        vm.chainId(43113);
        vm.warp(1_800_000_000);
        signerKey = SIGNER_KEY;
        signer = vm.addr(signerKey);
        VoidReleaseFactory factory = new VoidReleaseFactory(PLATFORM, 500, SAFE);
        (address releaseAddress, address saleAddress,) =
            factory.createRelease(ARTIST, RELEASE_KEY, "Claim rehearsal release", "VCR", "ipfs://claim-test");
        release = VoidRelease1155V4(releaseAddress);
        sale = VoidPrimarySale(payable(saleAddress));
        vm.prank(ARTIST);
        uint256 actualTokenId = release.createEdition(RELEASE_KEY, EDITION_ID, 10, "ipfs://claim-edition", ARTIST, 0);
        tokenId = actualTokenId;
        uint64 saleStart = uint64(block.timestamp + 1 days);
        vm.prank(ARTIST);
        sale.configureSale(tokenId, 1, PUBLIC_ALLOCATION, PUBLIC_ALLOCATION, saleStart, saleStart + 1 days, false);
        claimContract = new GenesisHolderClaim(
            address(release), address(sale), tokenId, GENESIS_ALLOCATION, PUBLIC_ALLOCATION, ADMIN, signer
        );
        bytes32 issuerRole = release.ISSUER_ROLE();
        vm.prank(ARTIST);
        release.grantRole(issuerRole, address(claimContract));
    }

    function testDomainSeparatorUsesEip712DestinationChainAndVerifyingContract() public {
        bytes32 initialDomain = claimContract.DOMAIN_SEPARATOR();
        require(initialDomain != bytes32(0), "empty EIP-712 domain");
        vm.chainId(43114);
        require(claimContract.DOMAIN_SEPARATOR() != initialDomain, "domain did not separate chain id");
        vm.chainId(43113);
        GenesisHolderClaim second = new GenesisHolderClaim(
            address(release), address(sale), tokenId, GENESIS_ALLOCATION, PUBLIC_ALLOCATION, ADMIN, signer
        );
        require(
            second.DOMAIN_SEPARATOR() != claimContract.DOMAIN_SEPARATOR(), "domain did not separate verifying contract"
        );
    }

    function testValidVoucherMintsThroughReleaseIssuerAndEmitsIndexedClaimEvent() public {
        GenesisHolderClaim.ClaimVoucher memory voucher = _voucher(CLAIMANT, 11, 1, block.timestamp + 300);
        bytes memory signature = _sign(claimContract, voucher, signerKey);
        vm.recordLogs();
        vm.prank(CLAIMANT);
        claimContract.claim(voucher, signature);

        require(release.balanceOf(CLAIMANT, tokenId) == 1, "release token not minted to claimant");
        require(claimContract.hasClaimed(CLAIMANT), "claim state missing");
        require(claimContract.claimedSupply() == 1, "reserved supply not recorded");
        require(claimContract.usedNonces(11), "nonce not consumed");
        _assertClaimEvent(vm.getRecordedLogs(), voucher, signature);
    }

    function testInvalidSignerRejected() public {
        GenesisHolderClaim.ClaimVoucher memory voucher = _voucher(CLAIMANT, 12, 1, block.timestamp + 300);
        _expectClaimRevert(
            CLAIMANT,
            voucher,
            _sign(claimContract, voucher, OTHER_SIGNER_KEY),
            GenesisHolderClaim.InvalidSignature.selector
        );
    }

    function testSignerRotationIsAdminControlled() public {
        address nextSigner = vm.addr(OTHER_SIGNER_KEY);
        vm.expectPartialRevert(GenesisHolderClaim.Unauthorized.selector);
        vm.prank(CLAIMANT);
        claimContract.setSigner(nextSigner);
        vm.prank(ADMIN);
        claimContract.setSigner(nextSigner);
        require(claimContract.signer() == nextSigner, "signer not rotated");
        GenesisHolderClaim.ClaimVoucher memory voucher = _voucher(CLAIMANT, 13, 1, block.timestamp + 300);
        bytes memory rotatedSignature = _sign(claimContract, voucher, OTHER_SIGNER_KEY);
        vm.prank(CLAIMANT);
        claimContract.claim(voucher, rotatedSignature);
        require(release.balanceOf(CLAIMANT, tokenId) == 1, "rotated signer voucher failed");
    }

    function testClaimantMismatchRejected() public {
        GenesisHolderClaim.ClaimVoucher memory voucher = _voucher(CLAIMANT, 14, 1, block.timestamp + 300);
        _expectClaimRevert(
            CLAIMANT_TWO, voucher, _sign(claimContract, voucher, signerKey), GenesisHolderClaim.InvalidVoucher.selector
        );
    }

    function testGenesisContractMismatchRejected() public {
        GenesisHolderClaim.ClaimVoucher memory voucher = _voucher(CLAIMANT, 15, 1, block.timestamp + 300);
        voucher.genesisContract = address(0x1234);
        _expectInvalidVoucher(voucher);
    }

    function testGenesisChainMismatchRejected() public {
        GenesisHolderClaim.ClaimVoucher memory voucher = _voucher(CLAIMANT, 16, 1, block.timestamp + 300);
        voucher.genesisChainId = 43113;
        _expectInvalidVoucher(voucher);
    }

    function testEligibilityRuleMismatchRejected() public {
        GenesisHolderClaim.ClaimVoucher memory voucher = _voucher(CLAIMANT, 161, 1, block.timestamp + 300);
        voucher.eligibilityRule = bytes32(uint256(1));
        _expectInvalidVoucher(voucher);
    }

    function testDestinationChainMismatchAndWrongDomainRejected() public {
        GenesisHolderClaim.ClaimVoucher memory voucher = _voucher(CLAIMANT, 17, 1, block.timestamp + 300);
        voucher.destinationChainId = 43114;
        _expectInvalidVoucher(voucher);
        bytes32 signedDomain = claimContract.DOMAIN_SEPARATOR();
        vm.chainId(43114);
        require(claimContract.DOMAIN_SEPARATOR() != signedDomain, "wrong chain reused domain");
        GenesisHolderClaim.ClaimVoucher memory wrongChainVoucher = _voucher(CLAIMANT, 18, 1, block.timestamp + 300);
        _expectClaimRevert(CLAIMANT, wrongChainVoucher, bytes(""), GenesisHolderClaim.WrongDestinationChain.selector);
    }

    function testReleaseMismatchRejected() public {
        GenesisHolderClaim.ClaimVoucher memory voucher = _voucher(CLAIMANT, 19, 1, block.timestamp + 300);
        voucher.releaseContract = address(0x4321);
        _expectInvalidVoucher(voucher);
    }

    function testTokenMismatchRejected() public {
        GenesisHolderClaim.ClaimVoucher memory voucher = _voucher(CLAIMANT, 20, 1, block.timestamp + 300);
        voucher.tokenId += 1;
        _expectInvalidVoucher(voucher);
    }

    function testQuantityMutationInvalidatesEip712Signature() public {
        GenesisHolderClaim.ClaimVoucher memory voucher = _voucher(CLAIMANT, 21, 1, block.timestamp + 300);
        bytes memory signature = _sign(claimContract, voucher, signerKey);
        voucher.quantity = 2;
        vm.prank(CLAIMANT);
        vm.expectPartialRevert(GenesisHolderClaim.InvalidSignature.selector);
        claimContract.claim(voucher, signature);
    }

    function testAllocationMismatchRejected() public {
        GenesisHolderClaim.ClaimVoucher memory voucher = _voucher(CLAIMANT, 22, 1, block.timestamp + 300);
        voucher.allocation += 1;
        _expectInvalidVoucher(voucher);
    }

    function testExpiredVoucherRejected() public {
        GenesisHolderClaim.ClaimVoucher memory voucher = _voucher(CLAIMANT, 23, 1, block.timestamp - 1);
        _expectClaimRevert(
            CLAIMANT, voucher, _sign(claimContract, voucher, signerKey), GenesisHolderClaim.ExpiredVoucher.selector
        );
    }

    function testNonceReplayRejectedAcrossClaimants() public {
        GenesisHolderClaim.ClaimVoucher memory first = _voucher(CLAIMANT, 24, 1, block.timestamp + 300);
        bytes memory firstSignature = _sign(claimContract, first, signerKey);
        vm.prank(CLAIMANT);
        claimContract.claim(first, firstSignature);
        GenesisHolderClaim.ClaimVoucher memory replay = _voucher(CLAIMANT_TWO, 24, 1, block.timestamp + 300);
        _expectClaimRevert(
            CLAIMANT_TWO, replay, _sign(claimContract, replay, signerKey), GenesisHolderClaim.Replay.selector
        );
    }

    function testSameWalletCannotClaimTwiceEvenWithDifferentValidVoucher() public {
        GenesisHolderClaim.ClaimVoucher memory first = _voucher(CLAIMANT, 25, 1, block.timestamp + 300);
        bytes memory firstSignature = _sign(claimContract, first, signerKey);
        vm.prank(CLAIMANT);
        claimContract.claim(first, firstSignature);
        GenesisHolderClaim.ClaimVoucher memory second = _voucher(CLAIMANT, 26, 1, block.timestamp + 300);
        _expectClaimRevert(
            CLAIMANT, second, _sign(claimContract, second, signerKey), GenesisHolderClaim.AlreadyClaimed.selector
        );
    }

    function testPausedClaimRejectedAndAdminCanResume() public {
        vm.prank(ADMIN);
        claimContract.pause();
        GenesisHolderClaim.ClaimVoucher memory voucher = _voucher(CLAIMANT, 27, 1, block.timestamp + 300);
        bytes memory signature = _sign(claimContract, voucher, signerKey);
        _expectClaimRevert(CLAIMANT, voucher, signature, GenesisHolderClaim.Paused.selector);
        vm.prank(ADMIN);
        claimContract.unpause();
        vm.prank(CLAIMANT);
        claimContract.claim(voucher, signature);
        require(release.balanceOf(CLAIMANT, tokenId) == 1, "claim failed after unpause");
    }

    function testAllocationExhaustionRejected() public {
        GenesisHolderClaim.ClaimVoucher memory first = _voucher(CLAIMANT, 28, GENESIS_ALLOCATION, block.timestamp + 300);
        bytes memory firstSignature = _sign(claimContract, first, signerKey);
        vm.prank(CLAIMANT);
        claimContract.claim(first, firstSignature);
        GenesisHolderClaim.ClaimVoucher memory second = _voucher(CLAIMANT_TWO, 29, 1, block.timestamp + 300);
        _expectClaimRevert(
            CLAIMANT_TWO,
            second,
            _sign(claimContract, second, signerKey),
            GenesisHolderClaim.AllocationExhausted.selector
        );
    }

    function testPublicSaleAllocationDriftFailsClosed() public {
        vm.prank(ARTIST);
        sale.configureSale(tokenId, 1, 8, 8, 0, 0, false);
        GenesisHolderClaim.ClaimVoucher memory voucher = _voucher(CLAIMANT, 30, 1, block.timestamp + 300);
        _expectClaimRevert(
            CLAIMANT,
            voucher,
            _sign(claimContract, voucher, signerKey),
            GenesisHolderClaim.PublicAllocationChanged.selector
        );
    }

    function testUnexpectedIssuerMintCannotConsumeReservedGenesisSupply() public {
        bytes32 issuerRole = release.ISSUER_ROLE();
        address otherIssuer = address(uint160(OTHER_SIGNER_KEY));
        vm.prank(ARTIST);
        release.grantRole(issuerRole, otherIssuer);
        vm.prank(otherIssuer);
        release.mint(CLAIMANT_TWO, tokenId, 1, "");
        GenesisHolderClaim.ClaimVoucher memory voucher = _voucher(CLAIMANT, 32, 1, block.timestamp + 300);
        _expectClaimRevert(
            CLAIMANT,
            voucher,
            _sign(claimContract, voucher, signerKey),
            GenesisHolderClaim.SupplyAccountingMismatch.selector
        );
    }

    function testPublicSaleMustStartAtLeastOneDayAfterClaimDeployment() public {
        uint64 tooSoon = uint64(block.timestamp + 1 hours);
        vm.prank(ARTIST);
        sale.configureSale(tokenId, 1, PUBLIC_ALLOCATION, PUBLIC_ALLOCATION, tooSoon, tooSoon + 1 days, false);
        vm.expectPartialRevert(GenesisHolderClaim.PublicSaleWindow.selector);
        new GenesisHolderClaim(
            address(release), address(sale), tokenId, GENESIS_ALLOCATION, PUBLIC_ALLOCATION, ADMIN, signer
        );
    }

    function testClaimRedemptionClosesWhenPublicSaleOpens() public {
        (,,,, uint64 saleStart,,,) = sale.sales(tokenId);
        vm.warp(saleStart);
        GenesisHolderClaim.ClaimVoucher memory voucher = _voucher(CLAIMANT, 33, 1, block.timestamp + 300);
        _expectClaimRevert(
            CLAIMANT, voucher, _sign(claimContract, voucher, signerKey), GenesisHolderClaim.PublicSaleWindow.selector
        );
    }

    function testZeroQuantityRejected() public {
        GenesisHolderClaim.ClaimVoucher memory voucher = _voucher(CLAIMANT, 31, 0, block.timestamp + 300);
        _expectClaimRevert(
            CLAIMANT, voucher, _sign(claimContract, voucher, signerKey), GenesisHolderClaim.InvalidVoucher.selector
        );
    }

    function _expectInvalidVoucher(GenesisHolderClaim.ClaimVoucher memory voucher) internal {
        _expectClaimRevert(
            CLAIMANT, voucher, _sign(claimContract, voucher, signerKey), GenesisHolderClaim.InvalidVoucher.selector
        );
    }

    function _expectClaimRevert(
        address caller,
        GenesisHolderClaim.ClaimVoucher memory voucher,
        bytes memory signature,
        bytes4 errorSelector
    ) internal {
        vm.expectPartialRevert(errorSelector);
        vm.prank(caller);
        claimContract.claim(voucher, signature);
    }

    function _voucher(address claimant, uint256 nonce, uint256 quantity, uint256 deadline)
        internal
        view
        returns (GenesisHolderClaim.ClaimVoucher memory)
    {
        return GenesisHolderClaim.ClaimVoucher({
            claimant: claimant,
            genesisContract: claimContract.GENESIS_CONTRACT(),
            genesisChainId: claimContract.GENESIS_CHAIN_ID(),
            eligibilityRule: claimContract.ELIGIBILITY_RULE(),
            destinationChainId: 43113,
            releaseContract: address(release),
            tokenId: tokenId,
            quantity: quantity,
            allocation: GENESIS_ALLOCATION,
            nonce: nonce,
            deadline: deadline
        });
    }

    function _sign(GenesisHolderClaim target, GenesisHolderClaim.ClaimVoucher memory voucher, uint256 key)
        internal
        returns (bytes memory)
    {
        bytes32 digest = target.voucherDigest(voucher);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _assertClaimEvent(
        VmClaim.Log[] memory logs,
        GenesisHolderClaim.ClaimVoucher memory voucher,
        bytes memory signature
    ) internal view {
        bytes32 eventSignature = keccak256("GenesisHolderClaimed(address,address,uint256,uint256,uint256,bytes32)");
        bytes32 expectedHash = claimContract.voucherDigest(voucher);
        // The event digest is also independently bound to EIP-712, not merely to the signature bytes.
        signature;
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter != address(claimContract) || logs[i].topics.length != 4
                    || logs[i].topics[0] != eventSignature
            ) continue;
            require(address(uint160(uint256(logs[i].topics[1]))) == voucher.claimant, "claimant topic mismatch");
            require(address(uint160(uint256(logs[i].topics[2]))) == address(release), "release topic mismatch");
            require(uint256(logs[i].topics[3]) == tokenId, "token topic mismatch");
            (uint256 quantity, uint256 nonce, bytes32 voucherHash) =
                abi.decode(logs[i].data, (uint256, uint256, bytes32));
            require(
                quantity == voucher.quantity && nonce == voucher.nonce && voucherHash == expectedHash,
                "claim event data mismatch"
            );
            return;
        }
        revert("GenesisHolderClaimed event not found");
    }
}
