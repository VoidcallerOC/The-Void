// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GenesisHolderClaimRecovery} from "../contracts/GenesisHolderClaimRecovery.sol";

interface VmRecovery {
    function chainId(uint256) external;
    function warp(uint256) external;
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function addr(uint256) external returns (address);
    function prank(address) external;
    function expectRevert(bytes4) external;
    function expectRevert() external;
    function expectPartialRevert(bytes4) external;
    function etch(address, bytes calldata) external;
}

contract RecoveryMockCollection {
    address public immutable eligibleOne;
    address public immutable eligibleTwo;
    constructor(address one, address two) { eligibleOne = one; eligibleTwo = two; }
    function balanceOfBatch(address[] calldata accounts, uint256[] calldata ids) external view returns (uint256[] memory values) {
        values = new uint256[](accounts.length);
        for (uint256 i; i < accounts.length; ++i) {
            values[i] = ids[i] <= 3 && (accounts[i] == eligibleOne || accounts[i] == eligibleTwo) ? 1 : 0;
        }
    }
}

contract RecoveryMockRelease {
    struct Edition { bytes32 releaseId; bytes32 editionId; address artist; uint256 maxSupply; uint256 mintedSupply; string metadataUri; bool exists; }
    mapping(address => bool) public issuer;
    mapping(address => mapping(uint256 => uint256)) public balances;
    Edition internal item;
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");
    constructor() { item = Edition(bytes32(0), bytes32(0), msg.sender, 0, 0, "", true); }
    function grantIssuer(address account) external { issuer[account] = true; }
    function revokeIssuer(address account) external { issuer[account] = false; }
    function maxSupplyOf(uint256) external pure returns (uint256) { return 0; }
    function edition(uint256) external view returns (Edition memory) { return item; }
    function mint(address to, uint256 tokenId, uint256 amount, bytes calldata) external {
        require(issuer[msg.sender], "issuer");
        balances[to][tokenId] += amount;
        item.mintedSupply += amount;
    }
}

contract RecoveryMockSale {
    address public immutable release;
    uint256 public sold;
    uint256 public constant PRICE = 0.25 ether;
    uint64 public constant START = 1_800_000_000;
    uint64 public constant END = START + 8 days - 1;
    constructor(address release_) { release = release_; }
    function releases() external view returns (address) { return release; }
    function sales(uint256) external view returns (uint256,uint256,uint256,uint256,uint64,uint64,bool,bool) {
        return (PRICE, 0, sold, 0, START, END, false, true);
    }
    function paidMint(address recipient, uint256 tokenId) external {
        sold += 1;
        RecoveryMockRelease(release).mint(recipient, tokenId, 1, "");
    }
}

contract GenesisHolderClaimRecoveryTest {
    VmRecovery internal constant vm = VmRecovery(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 internal constant SIGNER_KEY = 0xA11CE;
    uint256 internal constant OTHER_KEY = 0xB0B;
    address internal constant PRIOR_ONE = address(0xCA11);
    address internal constant PRIOR_TWO = address(0xCA12);
    address internal constant NEW_ONE = address(0xCA13);
    address internal constant NEW_TWO = address(0xCA14);
    address internal constant ADMIN = address(0xAD01);
    address internal constant GENESIS = 0xD1B4367dd9f235f9ee61878019d66E31511E98eE;
    uint256 internal constant START = 1_800_000_000 + 9 days;
    uint256 internal constant SALE_START = 1_800_000_000;
    uint256 internal constant SALE_END = SALE_START + 8 days - 1;
    uint256 internal constant PRICE = 0.25 ether;

    RecoveryMockRelease internal release;
    RecoveryMockSale internal sale;
    GenesisHolderClaimRecovery internal recovery;
    address internal signer;

    function setUp() public {
        vm.chainId(43114);
        vm.warp(START);
        signer = vm.addr(SIGNER_KEY);
        release = new RecoveryMockRelease();
        sale = new RecoveryMockSale(address(release));
        release.grantIssuer(address(sale));
        release.grantIssuer(address(this));
        release.mint(PRIOR_ONE, 1, 1, "");
        release.mint(PRIOR_TWO, 1, 1, "");
        RecoveryMockCollection collection = new RecoveryMockCollection(NEW_ONE, address(0));
        vm.etch(GENESIS, address(collection).code);
        recovery = _deploy(2, new address[](0));
        release.grantIssuer(address(recovery));
    }

    function _deploy(uint256 baseline, address[] memory prior) internal returns (GenesisHolderClaimRecovery result) {
        if (prior.length == 0) {
            prior = new address[](2);
            prior[0] = PRIOR_ONE;
            prior[1] = PRIOR_TWO;
        }
        GenesisHolderClaimRecovery.RecoveryConfig memory cfg = GenesisHolderClaimRecovery.RecoveryConfig({
            releaseContract: address(release), primarySale: address(sale), tokenId: 1, allocation: 0, publicAllocation: 0,
            claimStart: START, claimWindow: 1 days, publicSaleStart: SALE_START, publicSaleEnd: SALE_END,
            publicPriceWei: PRICE, baselineClaimedSupply: baseline, admin: ADMIN, signer: signer
        });
        result = new GenesisHolderClaimRecovery(cfg, prior);
    }

    function testBaselineAndPriorClaimantsAreSeeded() public {
        require(recovery.claimedSupply() == 2, "baseline");
        require(recovery.hasClaimed(PRIOR_ONE) && recovery.hasClaimed(PRIOR_TWO), "prior claimants not seeded");
        require(release.edition(1).mintedSupply == sale.sold() + recovery.claimedSupply(), "baseline invariant");
    }

    function testIncorrectBaselineOrClaimantSeedReverts() public {
        address[] memory one = new address[](1);
        one[0] = PRIOR_ONE;
        vm.expectRevert();
        _deploy(1, one);
        address[] memory duplicate = new address[](2);
        duplicate[0] = PRIOR_ONE; duplicate[1] = PRIOR_ONE;
        vm.expectRevert();
        _deploy(2, duplicate);
    }

    function testPriorClaimantsCannotClaimAgain() public {
        vm.warp(START);
        _expectClaimRevert(PRIOR_ONE, 1, GenesisHolderClaimRecovery.AlreadyClaimed.selector);
        _expectClaimRevert(PRIOR_TWO, 2, GenesisHolderClaimRecovery.AlreadyClaimed.selector);
    }

    function testEligibleWalletClaimsOnceAndSupplyInvariantHolds() public {
        vm.warp(START);
        _claim(NEW_ONE, 3, SIGNER_KEY);
        require(recovery.hasClaimed(NEW_ONE), "new claim not recorded");
        require(release.balances(NEW_ONE, 1) == 1, "token not delivered");
        require(release.edition(1).mintedSupply == sale.sold() + recovery.claimedSupply(), "post claim invariant");
        _expectClaimRevert(NEW_ONE, 4, GenesisHolderClaimRecovery.AlreadyClaimed.selector);
    }

    function testIneligibleWalletAndConsumedUnitAfterTransferAreRejected() public {
        vm.warp(START);
        _expectClaimRevert(address(0xDEAD), 5, GenesisHolderClaimRecovery.NotGenesisHolder.selector);
        _claim(NEW_ONE, 6, SIGNER_KEY);
        _expectClaimRevert(NEW_TWO, 7, GenesisHolderClaimRecovery.NotGenesisHolder.selector);
    }

    function testPaidSaleDuringRecoveryPreservesInvariant() public {
        vm.warp(START);
        release.grantIssuer(address(sale));
        sale.paidMint(address(0xBEEF), 1);
        require(release.edition(1).mintedSupply == sale.sold() + recovery.claimedSupply(), "sale invariant");
        _claim(NEW_ONE, 8, SIGNER_KEY);
        require(release.edition(1).mintedSupply == sale.sold() + recovery.claimedSupply(), "mixed invariant");
    }

    function testPauseExpiryBadSignatureReplayAndMissingIssuerFailClosed() public {
        vm.warp(START);
        vm.prank(ADMIN);
        recovery.pause();
        _expectClaimRevert(NEW_ONE, 9, GenesisHolderClaimRecovery.Paused.selector);
        vm.prank(ADMIN);
        recovery.unpause();
        GenesisHolderClaimRecovery.ClaimVoucher memory v = _voucher(NEW_ONE, 10);
        bytes memory bad = _sign(v, OTHER_KEY);
        vm.prank(NEW_ONE);
        vm.expectRevert(GenesisHolderClaimRecovery.InvalidSignature.selector);
        recovery.claim(v, bad);
        bytes memory validSignature = _sign(v, SIGNER_KEY);
        release.revokeIssuer(address(recovery));
        vm.prank(NEW_ONE);
        vm.expectRevert();
        recovery.claim(v, validSignature);
        release.grantIssuer(address(recovery));
        validSignature = _sign(v, SIGNER_KEY);
        vm.prank(NEW_ONE);
        recovery.claim(v, validSignature);
        validSignature = _sign(v, SIGNER_KEY);
        vm.prank(NEW_ONE);
        vm.expectRevert(GenesisHolderClaimRecovery.AlreadyClaimed.selector);
        recovery.claim(v, validSignature);
        vm.warp(recovery.claimEnd());
        _expectClaimRevert(NEW_TWO, 11, GenesisHolderClaimRecovery.ClaimWindowClosed.selector);
    }

    function testUnauthorizedAdministrationAndMissingIssuer() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(GenesisHolderClaimRecovery.Unauthorized.selector);
        recovery.pause();
        vm.prank(ADMIN);
        recovery.pause();
        vm.prank(ADMIN);
        recovery.unpause();
    }

    function _claim(address wallet, uint256 nonce, uint256 key) internal {
        GenesisHolderClaimRecovery.ClaimVoucher memory v = _voucher(wallet, nonce);
        bytes memory signature = _sign(v, key);
        vm.prank(wallet);
        recovery.claim(v, signature);
    }

    function _expectClaimRevert(address wallet, uint256 nonce, bytes4 selector) internal {
        GenesisHolderClaimRecovery.ClaimVoucher memory v = _voucher(wallet, nonce);
        bytes memory signature = _sign(v, SIGNER_KEY);
        vm.prank(wallet);
        vm.expectPartialRevert(selector);
        recovery.claim(v, signature);
    }

    function _voucher(address wallet, uint256 nonce) internal view returns (GenesisHolderClaimRecovery.ClaimVoucher memory v) {
        v = GenesisHolderClaimRecovery.ClaimVoucher({
            claimant: wallet, genesisContract: recovery.GENESIS_CONTRACT(), genesisChainId: recovery.GENESIS_CHAIN_ID(),
            eligibilityRule: recovery.ELIGIBILITY_RULE(), destinationChainId: 43114, releaseContract: address(release),
            tokenId: 1, quantity: 1, allocation: 0, nonce: nonce, deadline: START + 1 days - 1
        });
    }

    function _sign(GenesisHolderClaimRecovery.ClaimVoucher memory v, uint256 key) internal returns (bytes memory) {
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(key, recovery.voucherDigest(v));
        return abi.encodePacked(r, s, sv);
    }
}
