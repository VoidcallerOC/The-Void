// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GenesisHolderClaim} from "../contracts/GenesisHolderClaim.sol";
import {VoidRelease1155V4} from "../contracts/VoidRelease1155V4.sol";
import {VoidPrimarySale} from "../contracts/VoidPrimarySale.sol";

/// Runs the merged concurrent claim against the REAL Forgive & Forget release clone and primary sale on
/// Avalanche C-Chain, on a local fork. Nothing is broadcast. Skipped unless MAINNET_FORK_RPC is set.
interface VmFork {
    function createSelectFork(string calldata) external returns (uint256);
    function envOr(string calldata, string calldata) external returns (string memory);
    function skip(bool) external;
    function warp(uint256) external;
    function deal(address, uint256) external;
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function prank(address) external;
    function expectPartialRevert(bytes4) external;
}

contract GenesisHolderClaimMainnetForkTest {
    VmFork internal constant vm = VmFork(address(uint160(uint256(keccak256("hevm cheat code")))));
    address internal constant CLONE = 0x9Aa6165B493ac50d0f8CDee2FD48a3C5155FD103;
    address internal constant SALE = 0x6ae84A51F100f10f0535A514555043ae9eDf9aA3;
    address internal constant ARTIST = 0x284C09a7CC187E096cbbdc88d99DEFE6df32180a;
    address internal constant NANO = 0xb65C575CaE01574296Fab6E620B9A15cC0121ce4;
    bytes32 internal constant RELEASE_KEY = 0x1d7747cc5e69477b677c87f290142d4b705a81812129e6094ed5e116fa6d0731;
    bytes32 internal constant EDITION_ID = bytes32("forgive-forget");
    uint256 internal constant EXPECTED_TOKEN_ID = 25679935302133066722236771263728427871936411831072189551573738559199048803312;
    uint256 internal constant PRICE = 0.25 ether;
    uint256 internal constant SIGNER_KEY = 0xA11CE;
    address internal constant CLAIMANT = address(0xC1A1);
    address internal constant BUYER = address(0xB0B);

    VoidRelease1155V4 internal release = VoidRelease1155V4(CLONE);
    VoidPrimarySale internal sale = VoidPrimarySale(payable(SALE));
    GenesisHolderClaim internal claimContract;
    uint256 internal tokenId;
    uint256 internal T;
    bool internal forked;

    function setUp() public {
        string memory rpc = vm.envOr("MAINNET_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forked = true;
        require(block.chainid == 43114, "not C-Chain");
        T = block.timestamp + 1 hours;
        // Artist-signed steps of the launch plan, replayed on the fork.
        vm.prank(ARTIST);
        tokenId = release.createEditionWithMintEnd(RELEASE_KEY, EDITION_ID, 0, "ipfs://forgive-forget-edition", ARTIST, 250, uint64(T + 7 days - 1));
        vm.prank(ARTIST);
        sale.configureSale(tokenId, PRICE, 0, 0, uint64(T), uint64(T + 7 days - 1), false);
        claimContract = new GenesisHolderClaim(CLONE, SALE, tokenId, 0, 0, T, 1 days, 7 days, PRICE, ARTIST, vm.addr(SIGNER_KEY));
        bytes32 issuerRole = release.ISSUER_ROLE();
        vm.prank(ARTIST);
        release.grantRole(issuerRole, address(claimContract));
    }

    modifier onlyFork() {
        vm.skip(!forked);
        _;
    }

    function testTargetsAndScheduleBindToTheRealClone() public onlyFork {
        require(tokenId == EXPECTED_TOKEN_ID, "token id differs from the catalog token");
        require(release.maxSupplyOf(tokenId) == 0, "edition is not open");
        require(release.payoutOf(tokenId) == ARTIST && release.royaltyBpsOf(tokenId) == 250, "royalty");
        require(claimContract.publicSaleStart() == T && claimContract.claimEnd() == T + 1 days && claimContract.publicSaleEnd() == T + 7 days - 1, "schedule");
        require(claimContract.publicPriceWei() == PRICE && claimContract.allocation() == 0 && claimContract.publicAllocation() == 0, "economics");
        (uint256 p, uint256 cap,, uint256 perWallet, uint64 start, uint64 end, bool paused, bool configured) = sale.sales(tokenId);
        require(configured && !paused && p == PRICE && cap == 0 && perWallet == 0 && start == T && end == T + 7 days - 1, "sale");
        require(release.hasRole(release.ISSUER_ROLE(), address(claimContract)) && release.hasRole(release.ISSUER_ROLE(), SALE), "issuers");
    }

    function testBothPathsOpenAtLaunchOnTheRealContracts() public onlyFork {
        vm.warp(T);
        _claim(CLAIMANT, 1);
        vm.deal(BUYER, PRICE);
        vm.prank(BUYER);
        sale.purchase{value: PRICE}(tokenId, 1);
        require(release.balanceOf(CLAIMANT, tokenId) == 1 && release.balanceOf(BUYER, tokenId) == 1, "same token for both paths");
        _assertAccounting(1, 1);
        uint256 platformCut = (PRICE * sale.platformFeeBps()) / 10_000;
        require(sale.balances(NANO) == platformCut && sale.balances(ARTIST) == PRICE - platformCut, "2.5% / 97.5% split");
    }

    function testBuyerFirstThenClaimAndClaimantThenBuy() public onlyFork {
        vm.warp(T + 10 minutes);
        vm.deal(CLAIMANT, PRICE);
        vm.prank(CLAIMANT);
        sale.purchase{value: PRICE}(tokenId, 1);
        require(!claimContract.hasClaimed(CLAIMANT), "purchase consumed the claim");
        _claim(CLAIMANT, 2);
        vm.deal(BUYER, PRICE);
        _claim(BUYER, 3);
        vm.prank(BUYER);
        sale.purchase{value: PRICE}(tokenId, 1);
        require(release.balanceOf(CLAIMANT, tokenId) == 2 && release.balanceOf(BUYER, tokenId) == 2, "balances");
        _assertAccounting(2, 2);
    }

    function testClaimProtectionsOnTheRealContracts() public onlyFork {
        vm.warp(T);
        GenesisHolderClaim.ClaimVoucher memory voucher = _voucher(CLAIMANT, 4, block.timestamp + 300);
        bytes memory signature = _sign(SIGNER_KEY, voucher);
        vm.prank(CLAIMANT);
        claimContract.claim(voucher, signature);
        // replayed voucher, second voucher for the same wallet, nonce reuse by another wallet, wrong signer, expired voucher
        vm.expectPartialRevert(GenesisHolderClaim.AlreadyClaimed.selector);
        vm.prank(CLAIMANT);
        claimContract.claim(voucher, signature);
        _expectClaimRevert(CLAIMANT, _voucher(CLAIMANT, 5, block.timestamp + 300), SIGNER_KEY, GenesisHolderClaim.AlreadyClaimed.selector);
        _expectClaimRevert(BUYER, _voucher(BUYER, 4, block.timestamp + 300), SIGNER_KEY, GenesisHolderClaim.Replay.selector);
        _expectClaimRevert(BUYER, _voucher(BUYER, 6, block.timestamp + 300), 0xBAD, GenesisHolderClaim.InvalidSignature.selector);
        _expectClaimRevert(BUYER, _voucher(BUYER, 7, block.timestamp - 1), SIGNER_KEY, GenesisHolderClaim.ExpiredVoucher.selector);
        // a free claim can carry no value
        GenesisHolderClaim.ClaimVoucher memory paid = _voucher(BUYER, 8, block.timestamp + 300);
        bytes memory paidSig = _sign(SIGNER_KEY, paid);
        vm.deal(BUYER, 1 ether);
        vm.prank(BUYER);
        (bool ok,) = address(claimContract).call{value: 1 wei}(abi.encodeCall(GenesisHolderClaim.claim, (paid, paidSig)));
        require(!ok, "claim accepted value");
        require(claimContract.claimedSupply() == 1, "only one free mint");
    }

    function testHour24ClosesClaimsNotSalesAndDay7ClosesBoth() public onlyFork {
        vm.deal(BUYER, PRICE * 4);
        vm.warp(T + 1 days - 1);
        _claim(CLAIMANT, 9);
        vm.prank(BUYER);
        sale.purchase{value: PRICE}(tokenId, 1);
        vm.warp(T + 1 days);
        _expectClaimRevert(BUYER, _voucher(BUYER, 10, block.timestamp + 300), SIGNER_KEY, GenesisHolderClaim.ClaimWindowClosed.selector);
        vm.prank(BUYER);
        sale.purchase{value: PRICE}(tokenId, 1);
        vm.warp(T + 7 days - 1);
        vm.prank(BUYER);
        sale.purchase{value: PRICE}(tokenId, 1);
        vm.warp(T + 7 days);
        vm.expectPartialRevert(VoidPrimarySale.SaleEnded.selector);
        vm.prank(BUYER);
        sale.purchase{value: PRICE}(tokenId, 1);
        _expectClaimRevert(BUYER, _voucher(BUYER, 11, block.timestamp + 300), SIGNER_KEY, GenesisHolderClaim.ClaimWindowClosed.selector);
        _assertAccounting(1, 3);
    }

    function testWrongPaymentIsRejectedOnTheRealSale() public onlyFork {
        vm.warp(T);
        vm.deal(BUYER, 1 ether);
        vm.expectPartialRevert(VoidPrimarySale.WrongPayment.selector);
        vm.prank(BUYER);
        sale.purchase{value: PRICE - 1}(tokenId, 1);
        vm.expectPartialRevert(VoidPrimarySale.WrongPayment.selector);
        vm.prank(BUYER);
        sale.purchase{value: 0}(tokenId, 1);
        require(release.edition(tokenId).mintedSupply == 0, "minted on wrong payment");
    }

    function _assertAccounting(uint256 claimed, uint256 sold) internal view {
        (,, uint256 saleSold,,,,,) = sale.sales(tokenId);
        require(saleSold == sold && claimContract.claimedSupply() == claimed, "counters");
        require(release.edition(tokenId).mintedSupply == saleSold + claimContract.claimedSupply(), "mintedSupply != sold + claimed");
    }

    function _claim(address claimant, uint256 nonce) internal {
        GenesisHolderClaim.ClaimVoucher memory voucher = _voucher(claimant, nonce, block.timestamp + 300);
        bytes memory signature = _sign(SIGNER_KEY, voucher);
        vm.prank(claimant);
        claimContract.claim(voucher, signature);
    }

    function _expectClaimRevert(address caller, GenesisHolderClaim.ClaimVoucher memory voucher, uint256 key, bytes4 selector) internal {
        bytes memory signature = _sign(key, voucher);
        vm.expectPartialRevert(selector);
        vm.prank(caller);
        claimContract.claim(voucher, signature);
    }

    function _voucher(address claimant, uint256 nonce, uint256 deadline) internal view returns (GenesisHolderClaim.ClaimVoucher memory) {
        return GenesisHolderClaim.ClaimVoucher({
            claimant: claimant,
            genesisContract: claimContract.GENESIS_CONTRACT(),
            genesisChainId: claimContract.GENESIS_CHAIN_ID(),
            eligibilityRule: claimContract.ELIGIBILITY_RULE(),
            destinationChainId: 43114,
            releaseContract: CLONE,
            tokenId: tokenId,
            quantity: 1,
            allocation: 0,
            nonce: nonce,
            deadline: deadline
        });
    }

    function _sign(uint256 key, GenesisHolderClaim.ClaimVoucher memory voucher) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, claimContract.voucherDigest(voucher));
        return abi.encodePacked(r, s, v);
    }
}
