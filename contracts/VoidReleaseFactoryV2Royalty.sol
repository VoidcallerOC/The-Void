// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VoidReleaseFactoryV2} from "./VoidReleaseFactoryV2.sol";
import {VoidRelease1155V4Royalty} from "./VoidRelease1155V4Royalty.sol";

/// @title VoidReleaseFactoryV2 with a contract-enforced artist royalty (mainnet)
/// @notice Identical to VoidReleaseFactoryV2 (ownerless, 250 bps primary fee sealed, one clone,
/// sale and provenance anchor per release, same events and RELEASE_VERSION) except that its clone
/// implementation is VoidRelease1155V4Royalty: every edition of every release it creates pays
/// exactly 2.5% royalty to an artist wallet of that release, never to the platform fee recipient.
contract VoidReleaseFactoryV2Royalty is VoidReleaseFactoryV2 {
    uint96 public constant REQUIRED_ROYALTY_BPS = 250;

    constructor(address platformRecipient_) VoidReleaseFactoryV2(platformRecipient_) {}

    function _deployImplementation(address platformRecipient_) internal override returns (address) {
        return address(new VoidRelease1155V4Royalty(platformRecipient_));
    }
}
