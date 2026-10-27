// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GenesisHolderClaimRecovery} from "../contracts/GenesisHolderClaimRecovery.sol";
import {VoidPrimarySale} from "../contracts/VoidPrimarySale.sol";

interface VmRecoveryMainnetFork {
    function createSelectFork(string calldata url, uint256 blockNumber) external returns (uint256);
    function envOr(string calldata name, string calldata defaultValue) external returns (string memory);
    function warp(uint256 timestamp) external;
    function prank(address account) external;
    function deal(address account, uint256 value) external;
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8, bytes32, bytes32);
    function expectPartialRevert(bytes4 selector) external;
}

interface RecoveryMainnetRelease {
    struct EditionData {
        bytes32 releaseId;
        bytes32 editionId;
        address artist;
        uint256 maxSupply;
        uint256 mintedSupply;
        string metadataUri;
        bool exists;
    }
    function edition(uint256 tokenId) external view returns (EditionData memory);
    function ISSUER_ROLE() external view returns (bytes32);
    function grantRole(bytes32 role, address account) external;
    function balanceOf(address account, uint256 tokenId) external view returns (uint256);
}

interface RecoveryMainnetGenesis {
    function balanceOf(address account, uint256 tokenId) external view returns (uint256);
}

/// @notice Fork-backed recovery verification. It uses the real C-Chain state at PINNED_BLOCK and
/// performs all mutations only on the local Anvil/Forge fork.
contract GenesisHolderClaimRecoveryMainnetForkTest {
    VmRecoveryMainnetFork internal constant vm = VmRecoveryMainnetFork(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 internal constant PINNED_BLOCK = 98_687_887;
    uint256 internal constant TOKEN_ID = 1;
    uint256 internal constant PRICE = 0.25 ether;
    uint256 internal constant SIGNER_KEY = 0xA11CE;
    address internal constant RELEASE = 0xF0C091A159DE16cF0F306b2B61d37685EC5A830e;
    address internal constant SALE = 0xB4dAAe78a53c33f52C6EB573c4d6EFC7B86F3845;
    address internal constant ARTIST = 0x284C09a7CC187E096cbbdc88d99DEFE6df32180a;
    address internal constant PRIOR_ONE = 0x6a86EfA012fEDA64b70112022487fEE22E67d2fb;
    address internal constant PRIOR_TWO = 0xaBd3746e8b852f55bE52FC44faB6cAb908b1c174;
    address internal constant LIVE_HOLDER = 0xAe78E365285dB9BfA0FB231038f75f8f3Cc11588;
    address internal constant ADMIN = address(0xAD01);

    RecoveryMainnetRelease internal release;
    RecoveryMainnetGenesis internal genesis;
    VoidPrimarySale internal sale;
    GenesisHolderClaimRecovery internal recovery;
    address internal signer;
    uint256 internal claimStart;

    function setUp() public {
        string memory rpc = vm.envOr("MAINNET_FORK_RPC", "https://api.avax.network/ext/bc/C/rpc");
        vm.createSelectFork(rpc, PINNED_BLOCK);
        require(block.chainid == 43114, "not C-Chain");
        release = RecoveryMainnetRelease(RELEASE);
        genesis = RecoveryMainnetGenesis(0xD1B4367dd9f235f9ee61878019d66E31511E98eE);
        sale = VoidPrimarySale(payable(SALE));
        signer = vm.addr(SIGNER_KEY);
        claimStart = block.timestamp + 1 hours;

        RecoveryMainnetRelease.EditionData memory edition = release.edition(TOKEN_ID);
        (uint256 price, uint256 maxSupply, uint256 sold,,,, bool paused, bool configured) = sale.sales(TOKEN_ID);
        require(edition.exists && edition.mintedSupply == 3, "unexpected live mintedSupply");
        require(price == PRICE && maxSupply == 0 && sold == 1 && !paused && configured, "unexpected live sale");
        require(genesis.balanceOf(PRIOR_ONE, 0) + genesis.balanceOf(PRIOR_ONE, 1) + genesis.balanceOf(PRIOR_ONE, 2) + genesis.balanceOf(PRIOR_ONE, 3) > 0, "prior one not Genesis holder");
        require(genesis.balanceOf(PRIOR_TWO, 0) + genesis.balanceOf(PRIOR_TWO, 1) + genesis.balanceOf(PRIOR_TWO, 2) + genesis.balanceOf(PRIOR_TWO, 3) > 0, "prior two not Genesis holder");
        require(genesis.balanceOf(LIVE_HOLDER, 0) + genesis.balanceOf(LIVE_HOLDER, 1) + genesis.balanceOf(LIVE_HOLDER, 2) + genesis.balanceOf(LIVE_HOLDER, 3) > 0, "live holder not Genesis holder");

        (, , , uint256 perWallet, uint64 saleStart, uint64 saleEnd,,) = sale.sales(TOKEN_ID);
        require(perWallet == 3 && saleStart == 1_793_019_600 && saleEnd == 1_793_710_799, "sale schedule drift");
        GenesisHolderClaimRecovery.RecoveryConfig memory cfg = GenesisHolderClaimRecovery.RecoveryConfig({
            releaseContract: RELEASE, primarySale: SALE, tokenId: TOKEN_ID, allocation: 0, publicAllocation: 0,
            claimStart: claimStart, claimWindow: 1 days, publicSaleStart: saleStart, publicSaleEnd: saleEnd,
            publicPriceWei: PRICE, baselineClaimedSupply: 2, admin: ADMIN, signer: signer
        });
        address[] memory prior = new address[](2);
        prior[0] = PRIOR_ONE;
        prior[1] = PRIOR_TWO;
        recovery = new GenesisHolderClaimRecovery(cfg, prior);
        require(edition.mintedSupply == sold + recovery.claimedSupply(), "pre-claim invariant");

        // This role grant is deliberately made only on the local fork so the real release mint path can be exercised.
        bytes32 issuerRole = release.ISSUER_ROLE();
        vm.prank(ARTIST);
        release.grantRole(issuerRole, address(recovery));
    }

    function testRealStateBaselineAndPriorClaimants() public {
        require(recovery.hasClaimed(PRIOR_ONE) && recovery.hasClaimed(PRIOR_TWO), "prior claimant seed missing");
        vm.warp(claimStart);
        GenesisHolderClaimRecovery.ClaimVoucher memory voucher = GenesisHolderClaimRecovery.ClaimVoucher({
            claimant: PRIOR_ONE, genesisContract: recovery.GENESIS_CONTRACT(), genesisChainId: recovery.GENESIS_CHAIN_ID(),
            eligibilityRule: recovery.ELIGIBILITY_RULE(), destinationChainId: 43114, releaseContract: RELEASE,
            tokenId: TOKEN_ID, quantity: 1, allocation: 0, nonce: 1, deadline: claimStart + 1 days - 1
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, recovery.voucherDigest(voucher));
        vm.expectPartialRevert(GenesisHolderClaimRecovery.AlreadyClaimed.selector);
        vm.prank(PRIOR_ONE);
        recovery.claim(voucher, abi.encodePacked(r, s, v));
    }

    function testRealSaleMintThenRecoveryClaimPreservesInvariant() public {
        vm.warp(claimStart);
        vm.deal(address(0xBEEF), PRICE);
        vm.prank(address(0xBEEF));
        sale.purchase{value: PRICE}(TOKEN_ID, 1);
        uint256 saleSold;
        (, , saleSold,,,,,) = sale.sales(TOKEN_ID);
        uint256 minted = release.edition(TOKEN_ID).mintedSupply;
        require(minted == saleSold + recovery.claimedSupply(), "post-sale invariant");

        _claim(LIVE_HOLDER, 2);
        saleSold = 0;
        (, , saleSold,,,,,) = sale.sales(TOKEN_ID);
        minted = release.edition(TOKEN_ID).mintedSupply;
        require(minted == saleSold + recovery.claimedSupply(), "post-recovery invariant");
    }

    function _claim(address claimant, uint256 nonce) internal {
        GenesisHolderClaimRecovery.ClaimVoucher memory voucher = GenesisHolderClaimRecovery.ClaimVoucher({
            claimant: claimant, genesisContract: recovery.GENESIS_CONTRACT(), genesisChainId: recovery.GENESIS_CHAIN_ID(),
            eligibilityRule: recovery.ELIGIBILITY_RULE(), destinationChainId: 43114, releaseContract: RELEASE,
            tokenId: TOKEN_ID, quantity: 1, allocation: 0, nonce: nonce, deadline: claimStart + 1 days - 1
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, recovery.voucherDigest(voucher));
        vm.prank(claimant);
        recovery.claim(voucher, abi.encodePacked(r, s, v));
    }
}
