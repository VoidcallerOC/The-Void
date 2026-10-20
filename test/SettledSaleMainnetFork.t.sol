// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VoidReleaseFactoryV2Royalty} from "../contracts/VoidReleaseFactoryV2Royalty.sol";
import {VoidRelease1155V4} from "../contracts/VoidRelease1155V4.sol";
import {VoidPrimarySale} from "../contracts/VoidPrimarySale.sol";
import {VoidPrimarySaleSettled} from "../contracts/VoidPrimarySaleSettled.sol";
import {ReleaseMarketplaceV4} from "../contracts/ReleaseMarketplaceV4.sol";

interface VmSettledFork {
    function createSelectFork(string calldata) external returns (uint256);
    function createSelectFork(string calldata, uint256) external returns (uint256);
    function envOr(string calldata, string calldata) external returns (string memory);
    function envOr(string calldata, uint256) external returns (uint256);
    function skip(bool) external;
    function prank(address) external;
    function deal(address, uint256) external;
    function warp(uint256) external;
    function etch(address, bytes calldata) external;
}

interface IGenesisBalanceFork {
    function balanceOf(address account, uint256 id) external view returns (uint256);
}

/// @dev A minter that an artist (release admin) could authorize in place of the sale. It mints with no fee.
contract ForkRogueMinter {
    VoidRelease1155V4 internal immutable release;

    constructor(address release_) {
        release = VoidRelease1155V4(release_);
    }

    function sell(uint256 tokenId, address to) external payable {
        release.mint(to, tokenId, 1, "");
    }
}

/// @dev Stands in for a platform wallet that refuses AVAX (etched over the real address on the fork only).
contract ForkRejectingWallet {
    receive() external payable {
        revert("no AVAX");
    }
}

/// @notice Runs the settled-sale activation against the REAL deployed Avalanche C-Chain contracts on a
/// local fork (existing release, factory, old sale, marketplace). Only Foundry cheatcodes are used: nothing is
/// broadcast, signed or sent to the network, so these tests prove behaviour under the tested conditions and
/// do NOT prove that any transfer happened on mainnet. Skipped unless MAINNET_FORK_URL is set. Optionally set
/// MAINNET_FORK_BLOCK to pin the latest-state tests to one block (fewer RPC calls, reproducible).
///
/// testPinned_* asserts exact historical values at block 98046247 (the block of the 0.25 AVAX purchase).
/// The other tests read the live state at the fork block into a baseline and assert relative invariants, so they
/// stay correct if the artist or the platform wallet withdraws on mainnet later.
contract SettledSaleMainnetForkTest {
    VmSettledFork internal constant vm = VmSettledFork(address(uint160(uint256(keccak256("hevm cheat code")))));

    address internal constant FACTORY = 0x262B774cf9a1949170B58E2d57F6189980FE757b;
    address internal constant RELEASE = 0x9Aa6165B493ac50d0f8CDee2FD48a3C5155FD103;
    address internal constant OLD_SALE = 0x6ae84A51F100f10f0535A514555043ae9eDf9aA3;
    address internal constant MARKET = 0x0e77116142844478a55EEd2Ab79de9F93770F8f5;
    address internal constant ARTIST = 0x284C09a7CC187E096cbbdc88d99DEFE6df32180a;
    address internal constant PLATFORM = 0xb65C575CaE01574296Fab6E620B9A15cC0121ce4;
    address internal constant HIST_BUYER = 0x6a86EfA012fEDA64b70112022487fEE22E67d2fb;
    uint256 internal constant TOKEN = 25679935302133066722236771263728427871936411831072189551573738559199048803312;
    uint256 internal constant PURCHASE_BLOCK = 98046247;
    bytes32 internal constant RELEASE_KEY = 0x1d7747cc5e69477b677c87f290142d4b705a81812129e6094ed5e116fa6d0731;
    address internal constant FAN = address(0xFA1);
    address internal constant FAN2 = address(0xFA2);
    address internal constant BUYER2 = address(0xB02);

    bytes4 internal constant ACCESS_DENIED = bytes4(keccak256("AccessDenied(bytes32,address)"));

    VoidRelease1155V4 internal release = VoidRelease1155V4(RELEASE);
    VoidPrimarySale internal oldSale = VoidPrimarySale(payable(OLD_SALE));
    VoidReleaseFactoryV2Royalty internal factory = VoidReleaseFactoryV2Royalty(FACTORY);
    ReleaseMarketplaceV4 internal market = ReleaseMarketplaceV4(MARKET);
    VoidPrimarySaleSettled internal newSale;

    string internal url;
    bool internal configured;

    struct Base {
        uint256 oldSold;
        uint256 creditArtist;
        uint256 creditPlatform;
        uint256 saleBalance;
        uint256 histBuyer;
        uint256 minted;
        uint256 artistNative;
        uint256 platformNative;
    }

    function setUp() public {
        url = vm.envOr("MAINNET_FORK_URL", string(""));
        if (bytes(url).length == 0) url = vm.envOr("MAINNET_FORK_RPC", string(""));
        configured = bytes(url).length != 0;
    }

    modifier onlyFork() {
        vm.skip(!configured);
        _;
    }

    // ------------------------------------------------------------------ helpers

    function _forkLatest() internal {
        uint256 pinned = vm.envOr("MAINNET_FORK_BLOCK", uint256(0));
        if (pinned == 0) vm.createSelectFork(url);
        else vm.createSelectFork(url, pinned);
        require(block.chainid == 43114, "not Avalanche C-Chain");
    }

    function _oldSold() internal view returns (uint256 sold) {
        (,, sold,,,,,) = oldSale.sales(TOKEN);
    }

    function _base() internal view returns (Base memory b) {
        b.oldSold = _oldSold();
        b.creditArtist = oldSale.balances(ARTIST);
        b.creditPlatform = oldSale.balances(PLATFORM);
        b.saleBalance = OLD_SALE.balance;
        b.histBuyer = release.balanceOf(HIST_BUYER, TOKEN);
        b.minted = release.edition(TOKEN).mintedSupply;
        b.artistNative = ARTIST.balance;
        b.platformNative = PLATFORM.balance;
    }

    function _activate() internal {
        newSale = new VoidPrimarySaleSettled(RELEASE, PLATFORM);
        bytes32 issuer = release.ISSUER_ROLE();
        vm.prank(ARTIST);
        release.grantRole(issuer, address(newSale));
        vm.prank(ARTIST);
        release.revokeRole(issuer, OLD_SALE);
    }

    function _configureNewSale() internal {
        vm.prank(ARTIST);
        newSale.configureSale(TOKEN, 1 ether, 0, 2, 0, uint64(block.timestamp + 30 days), false);
    }

    function _selector(bytes memory ret) internal pure returns (bytes4 sel) {
        if (ret.length < 4) return bytes4(0);
        assembly ("memory-safe") {
            sel := mload(add(ret, 0x20))
        }
    }

    function _withdrawFrom(address caller, address sale) internal returns (bool ok, bytes memory ret) {
        vm.prank(caller);
        (ok, ret) = sale.call(abi.encodeCall(VoidPrimarySale.withdraw, ()));
    }

    function _buyNew(address fan) internal {
        vm.deal(fan, 1 ether);
        vm.prank(fan);
        newSale.purchase{value: 1 ether}(TOKEN, 1);
    }

    // ------------------------------------------------------------------ (a) exact historical state

    function testPinned_HistoricalStateAtThePurchaseBlock() public onlyFork {
        vm.createSelectFork(url, PURCHASE_BLOCK);
        require(block.chainid == 43114 && block.number == PURCHASE_BLOCK, "pinned to the purchase block");
        // The sale holds exactly the 0.25 AVAX purchase and both shares are credited, nothing transferred out.
        require(OLD_SALE.balance == 0.25 ether, "sale holds the full purchase");
        require(oldSale.balances(ARTIST) == 0.24375 ether, "artist credit 97.5%");
        require(oldSale.balances(PLATFORM) == 0.00625 ether, "platform credit 2.5%, still inside the contract");
        require(oldSale.balances(ARTIST) + oldSale.balances(PLATFORM) == OLD_SALE.balance, "credits account for every wei held");
        (uint256 price, uint256 cap, uint256 sold, uint256 perWallet,,, bool paused, bool isConfigured) = oldSale.sales(TOKEN);
        require(price == 0.25 ether && cap == 1 && sold == 1 && perWallet == 1 && !paused && isConfigured, "old sale state");
        require(oldSale.walletPurchased(TOKEN, HIST_BUYER) == 1, "wallet counter");
        // The external wallets received nothing from that purchase.
        require(ARTIST.balance == 153706083007228403 && PLATFORM.balance == 11600000000000, "wallet balances at the purchase block");
        // Release identity and registry.
        require(keccak256(bytes(release.name())) == keccak256("Forgive & Forget") && keccak256(bytes(release.symbol())) == keccak256("FNF"), "release name and symbol");
        require(release.releaseKey() == RELEASE_KEY, "release key");
        require(release.artistOf(TOKEN) == ARTIST && release.payoutOf(TOKEN) == ARTIST && release.royaltyBpsOf(TOKEN) == 250, "artist, payout, royalty");
        require(release.maxSupplyOf(TOKEN) == 0 && release.edition(TOKEN).mintedSupply == 1, "open edition, one minted");
        require(keccak256(bytes(release.uri(TOKEN))) == keccak256("ipfs://QmNiMnuYs1yrzPEgzit3AbJZBnBxSeh41sZbk4guN7y2A6"), "metadata uri");
        require(release.balanceOf(HIST_BUYER, TOKEN) == 1, "historical buyer owns the token");
        require(factory.isRelease(RELEASE) && factory.primarySaleOf(RELEASE) == OLD_SALE, "factory registry");
        require(address(market.registry()) == FACTORY && market.feeRecipient() == PLATFORM && market.platformFeeBps() == 250, "marketplace is bound to the factory and the platform wallet");
        require(release.hasRole(release.ISSUER_ROLE(), OLD_SALE) && release.hasRole(release.DEFAULT_ADMIN_ROLE(), ARTIST), "roles before activation");
        require(PLATFORM.code.length == 0 && ARTIST.code.length == 0, "both recipients are plain wallets");
    }

    function testLatest_ReleaseIdentityRegistryAndRolesBeforeActivation() public onlyFork {
        _forkLatest();
        require(release.releaseKey() == RELEASE_KEY, "release key unchanged");
        require(release.artistOf(TOKEN) == ARTIST && release.payoutOf(TOKEN) == ARTIST && release.royaltyBpsOf(TOKEN) == 250, "artist, payout, royalty unchanged");
        require(release.maxSupplyOf(TOKEN) == 0, "open edition unchanged");
        require(release.balanceOf(HIST_BUYER, TOKEN) >= 1, "historical buyer still owns the token");
        require(factory.isRelease(RELEASE) && factory.primarySaleOf(RELEASE) == OLD_SALE, "factory registry unchanged");
        require(address(market.registry()) == FACTORY, "marketplace registry is the existing factory");
        require(release.hasRole(release.DEFAULT_ADMIN_ROLE(), ARTIST), "the artist administers the release");
        Base memory b = _base();
        require(b.oldSold == 1, "old sale sold exactly one");
        require(b.saleBalance >= b.creditArtist + b.creditPlatform, "the sale holds at least every credit");
    }

    // ------------------------------------------------------------------ (b)(c) activation, old sale retired, credits intact

    function testActivation_OldSaleCannotMintButItsCreditsAndTheArtistsWithdrawalSurvive() public onlyFork {
        _forkLatest();
        Base memory b = _base();
        _activate();
        bytes32 issuer = release.ISSUER_ROLE();
        require(release.hasRole(issuer, address(newSale)) && !release.hasRole(issuer, OLD_SALE), "issuer moved to the new sale");
        require(release.hasRole(release.DEFAULT_ADMIN_ROLE(), ARTIST) && release.releaseKey() == RELEASE_KEY, "release identity and ownership unchanged");
        require(factory.primarySaleOf(RELEASE) == OLD_SALE && factory.isRelease(RELEASE), "the factory registry is untouched");

        // The old sale cannot mint any more, directly...
        vm.prank(OLD_SALE);
        (bool ok, bytes memory ret) = address(release).call(abi.encodeCall(release.mint, (FAN, TOKEN, 1, "")));
        require(!ok && _selector(ret) == ACCESS_DENIED, "direct mint from the old sale is refused");
        // ...and not through a purchase, even if the artist reopens the old sale: the whole purchase reverts.
        vm.prank(ARTIST);
        oldSale.configureSale(TOKEN, 1 ether, 0, 0, 0, uint64(block.timestamp + 30 days), false);
        vm.deal(FAN, 1 ether);
        vm.prank(FAN);
        (ok, ret) = OLD_SALE.call{value: 1 ether}(abi.encodeCall(oldSale.purchase, (TOKEN, 1)));
        require(!ok && _selector(ret) == ACCESS_DENIED, "a purchase on the old sale reverts at the mint");
        require(FAN.balance == 1 ether && release.balanceOf(FAN, TOKEN) == 0, "the fan keeps the AVAX and receives nothing");
        require(_oldSold() == b.oldSold && OLD_SALE.balance == b.saleBalance, "no sold counter change, no escrow change: no duplicate issuance");
        require(release.edition(TOKEN).mintedSupply == b.minted, "minted supply unchanged");

        // Credits are untouched by the role change.
        require(oldSale.balances(ARTIST) == b.creditArtist && oldSale.balances(PLATFORM) == b.creditPlatform, "credits intact after retiring the sale");
        require(release.balanceOf(HIST_BUYER, TOKEN) == b.histBuyer, "historical ownership intact");

        // The artist's own withdrawal still pays exactly the credited amount. (Simulation on the fork only.)
        if (b.creditArtist == 0) {
            (ok, ret) = _withdrawFrom(ARTIST, OLD_SALE);
            require(!ok && _selector(ret) == VoidPrimarySale.NothingToWithdraw.selector, "already withdrawn on mainnet: nothing to withdraw");
            return;
        }
        uint256 before = ARTIST.balance;
        (ok,) = _withdrawFrom(ARTIST, OLD_SALE);
        require(ok, "artist withdrawal still works after the issuer swap");
        require(ARTIST.balance - before == b.creditArtist, "artist receives exactly the credited share");
        require(oldSale.balances(ARTIST) == 0 && OLD_SALE.balance == b.saleBalance - b.creditArtist, "only the artist share left the old sale");
        require(oldSale.balances(PLATFORM) == b.creditPlatform, "the platform credit is untouched by the artist's withdrawal");
    }

    // ------------------------------------------------------------------ (d) who can move the historical platform credit

    function testHistoricalPlatformCreditCanOnlyBeMovedByThePlatformWalletItself() public onlyFork {
        _forkLatest();
        _activate();
        Base memory b = _base();
        if (b.creditPlatform == 0) return; // already withdrawn on mainnet
        address[9] memory others = [FACTORY, address(0xFA1CE), address(newSale), OLD_SALE, MARKET, RELEASE, address(this), HIST_BUYER, address(0xDEAD)];
        for (uint256 i; i < others.length; ++i) {
            (bool ok, bytes memory ret) = _withdrawFrom(others[i], OLD_SALE);
            require(!ok && _selector(ret) == VoidPrimarySale.NothingToWithdraw.selector, "a non-recipient has nothing to withdraw");
        }
        require(oldSale.balances(PLATFORM) == b.creditPlatform && PLATFORM.balance == b.platformNative, "the platform credit did not move");
        // The artist (and an ownerless factory) have no path to it either: the artist only drains its own credit.
        if (b.creditArtist > 0) {
            (bool ok,) = _withdrawFrom(ARTIST, OLD_SALE);
            require(ok && oldSale.balances(PLATFORM) == b.creditPlatform, "the artist withdraws only the artist credit");
        }
        require(OLD_SALE.balance == b.creditPlatform + (b.creditArtist == 0 ? b.saleBalance - b.creditPlatform : 0), "the sale still holds the platform credit");
        // The sale's owner is the factory, which exposes no function that could act as owner.
        require(oldSale.owner() == FACTORY, "owner is the ownerless factory");
        // The platform recipient is a plain wallet: the credit leaves only through a transaction signed by it.
        // This pranks the platform wallet on the fork to prove the path exists; it proves nothing about mainnet transfers.
        require(PLATFORM.code.length == 0, "platform recipient is an EOA");
        uint256 before = PLATFORM.balance;
        vm.prank(PLATFORM);
        oldSale.withdraw();
        require(PLATFORM.balance - before == b.creditPlatform && oldSale.balances(PLATFORM) == 0, "withdraw() by the platform wallet itself would pay exactly its credit");
    }

    // ------------------------------------------------------------------ (e) new sale on the existing token

    function testNewSalePushesThePlatformFeeCreditsTheArtistAndEnforcesLimitsOnTheExistingToken() public onlyFork {
        _forkLatest();
        Base memory b = _base();
        string memory uriBefore = release.uri(TOKEN);
        _activate();
        _configureNewSale();

        uint256 platformBefore = PLATFORM.balance;
        _buyNew(FAN);
        require(PLATFORM.balance - platformBefore == 0.025 ether, "the platform wallet received exactly 2.5% inside the purchase");
        require(newSale.balances(PLATFORM) == 0 && newSale.balances(ARTIST) == 0.975 ether, "no platform credit; artist credited 97.5% as a pull balance");
        require(address(newSale).balance == 0.975 ether, "the new sale holds only the artist share");
        require(release.balanceOf(FAN, TOKEN) == 1 && release.edition(TOKEN).mintedSupply == b.minted + 1, "the fan owns the existing token");

        _buyNew(FAN);
        vm.deal(FAN, 1 ether);
        vm.prank(FAN);
        (bool ok, bytes memory ret) = address(newSale).call{value: 1 ether}(abi.encodeCall(newSale.purchase, (TOKEN, 1)));
        require(!ok && _selector(ret) == VoidPrimarySaleSettled.WalletLimitExceeded.selector, "per-wallet limit of 2 enforced");
        require(release.balanceOf(FAN, TOKEN) == 2 && PLATFORM.balance - platformBefore == 0.05 ether, "state after the refused third purchase");

        // Edition and release identity unchanged; old sale and historical ownership unchanged.
        require(release.maxSupplyOf(TOKEN) == 0 && release.payoutOf(TOKEN) == ARTIST && release.royaltyBpsOf(TOKEN) == 250, "edition economics unchanged");
        require(keccak256(bytes(release.uri(TOKEN))) == keccak256(bytes(uriBefore)), "metadata uri unchanged");
        require(release.releaseKey() == RELEASE_KEY && release.artistOf(TOKEN) == ARTIST, "release identity unchanged");
        require(_oldSold() == b.oldSold && release.balanceOf(HIST_BUYER, TOKEN) == b.histBuyer, "old sale sold counter and historical ownership unchanged");
        require(oldSale.balances(ARTIST) == b.creditArtist && oldSale.balances(PLATFORM) == b.creditPlatform, "old credits unchanged by new sales");

        // The artist withdraws the new sale's credit: exactly 97.5% of the two purchases.
        uint256 before = ARTIST.balance;
        vm.prank(ARTIST);
        newSale.withdraw();
        require(ARTIST.balance - before == 1.95 ether && address(newSale).balance == 0, "artist withdraws exactly the two artist shares");
    }

    function testNewSaleRevertsTheWholePurchaseWhenTheRealPlatformWalletRefusesAVAX() public onlyFork {
        _forkLatest();
        Base memory b = _base();
        _activate();
        _configureNewSale();
        ForkRejectingWallet rejecting = new ForkRejectingWallet();
        // Fork-only: replace the platform wallet's code so it rejects AVAX. Nothing real is changed.
        vm.etch(PLATFORM, address(rejecting).code);
        vm.deal(FAN, 1 ether);
        vm.prank(FAN);
        (bool ok, bytes memory ret) = address(newSale).call{value: 1 ether}(abi.encodeCall(newSale.purchase, (TOKEN, 1)));
        require(!ok && _selector(ret) == VoidPrimarySaleSettled.PlatformTransferFailed.selector, "a failed platform transfer reverts the sale");
        require(FAN.balance == 1 ether && release.balanceOf(FAN, TOKEN) == 0, "the fan keeps the AVAX and gets no token");
        require(release.edition(TOKEN).mintedSupply == b.minted && address(newSale).balance == 0 && newSale.balances(ARTIST) == 0, "no mint, no escrow, no artist credit");
        (,, uint256 soldNew,,,,,) = newSale.sales(TOKEN);
        require(soldNew == 0 && newSale.walletPurchased(TOKEN, FAN) == 0, "no sale recorded");
    }

    function testGenesisBalancesAndCodeAreUnchangedByActivationAndSettledPurchases() public onlyFork {
        _forkLatest();
        IGenesisBalanceFork genesis = IGenesisBalanceFork(0xD1B4367dd9f235f9ee61878019d66E31511E98eE);
        bytes32 codeBefore = keccak256(address(genesis).code);
        address[5] memory holders = [FAN, ARTIST, PLATFORM, OLD_SALE, HIST_BUYER];
        uint256[20] memory before_;
        for (uint256 h = 0; h < 5; h++) {
            for (uint256 id = 0; id < 4; id++) before_[h * 4 + id] = genesis.balanceOf(holders[h], id);
        }

        _activate();
        _configureNewSale();
        _buyNew(FAN);

        require(keccak256(address(genesis).code) == codeBefore, "Genesis code unchanged");
        for (uint256 h = 0; h < 5; h++) {
            for (uint256 id = 0; id < 4; id++) {
                require(genesis.balanceOf(holders[h], id) == before_[h * 4 + id], "Genesis balance changed");
            }
        }
    }

    // ------------------------------------------------------------------ (f) the real marketplace

    function _listAndBuyOnRealMarket(address seller, address buyer) internal {
        vm.prank(seller);
        release.setApprovalForAll(MARKET, true);
        vm.prank(seller);
        uint256 listingId = market.createListing(RELEASE, seller, TOKEN, 1, 1 ether, 0);
        vm.deal(buyer, 1 ether);
        uint256 platformBefore = PLATFORM.balance;
        uint256 payoutBefore = ARTIST.balance;
        uint256 sellerBefore = seller.balance;
        vm.prank(buyer);
        market.buy{value: 1 ether}(listingId, 1);
        require(PLATFORM.balance - platformBefore == 0.025 ether, "marketplace fee 2.5% to the platform wallet");
        require(ARTIST.balance - payoutBefore == 0.025 ether, "royalty 2.5% to the edition payout 0x284C");
        require(seller.balance - sellerBefore == 0.95 ether, "seller receives 95%");
        require(address(market).balance == 0, "the marketplace keeps nothing");
        require(release.balanceOf(buyer, TOKEN) == 1 && release.balanceOf(seller, TOKEN) == 0, "ownership moved");
        require(uint8(market.listingStatus(listingId)) == uint8(ReleaseMarketplaceV4.Status.SOLD), "listing sold");
    }

    function testMarketplaceAcceptsTheExistingReleaseAndSettlesAResale95_2p5_2p5() public onlyFork {
        _forkLatest();
        require(factory.isRelease(RELEASE) && address(market.registry()) == FACTORY, "the immutable registry accepts the existing release");
        require(market.deploymentChainId() == 43114 && market.feeRecipient() == PLATFORM && market.platformFeeBps() == 250, "marketplace configuration");
        _activate();
        _configureNewSale();
        _buyNew(FAN);
        _listAndBuyOnRealMarket(FAN, BUYER2);
    }

    // ------------------------------------------------------------------ (g) documented immutable-release limitation

    function testLimitation_AnArtistWhoAdministersTheReleaseCanAuthorizeARogueMinterThatBypassesThePrimaryFee() public onlyFork {
        _forkLatest();
        _activate();
        ForkRogueMinter rogue = new ForkRogueMinter(RELEASE);
        bytes32 issuer = release.ISSUER_ROLE();
        // The release contract is immutable and gives its artist the admin role, so nothing on-chain stops this.
        vm.prank(ARTIST);
        release.grantRole(issuer, address(rogue));
        require(release.hasRole(issuer, address(rogue)), "the rogue minter holds ISSUER_ROLE");
        uint256 platformBefore = PLATFORM.balance;
        vm.deal(FAN2, 1 ether);
        vm.prank(FAN2);
        rogue.sell{value: 1 ether}(TOKEN, FAN2);
        require(release.balanceOf(FAN2, TOKEN) == 1, "the rogue minter issued a token");
        require(PLATFORM.balance == platformBefore, "...and the platform received no primary fee");
        // The marketplace still enforces the secondary fee and royalty for a token minted that way.
        _listAndBuyOnRealMarket(FAN2, BUYER2);
    }
}
