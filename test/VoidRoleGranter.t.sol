// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VoidRelease1155V2} from "../contracts/VoidRelease1155V2.sol";
import {VoidRoleGranter} from "../contracts/VoidRoleGranter.sol";

interface Vm {
    function prank(address) external;
}

contract VoidRoleGranterTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    VoidRelease1155V2 internal release;
    VoidRoleGranter internal granter;
    address internal admin = address(this);
    address internal owner = address(0x0A11);
    address internal reviewer = address(0x4330);
    address internal reviewer2 = address(0x6A86);
    address internal artist = address(0xA11CE);
    address internal stranger = address(0xBAD);

    function setUp() public {
        release = new VoidRelease1155V2(admin);
        address[] memory reviewers = new address[](2);
        reviewers[0] = reviewer;
        reviewers[1] = reviewer2;
        granter = new VoidRoleGranter(address(release), owner, reviewers);
        // The one-time setup: the release admin hands the granter DEFAULT_ADMIN.
        release.grantRole(release.DEFAULT_ADMIN_ROLE(), address(granter));
    }

    function testReviewerGrantsBothPublishingRolesWithoutAdmin() public {
        require(!release.hasRole(release.DEFAULT_ADMIN_ROLE(), reviewer), "reviewer must not be admin");
        vm.prank(reviewer);
        granter.grantPublishingRoles(artist);
        require(release.hasRole(release.ARTIST_ROLE(), artist), "artist role");
        require(release.hasRole(release.ISSUER_ROLE(), artist), "issuer role");
        require(!release.hasRole(release.DEFAULT_ADMIN_ROLE(), artist), "never admin");
    }

    function testReviewerCanRevoke() public {
        vm.prank(reviewer);
        granter.grantPublishingRoles(artist);
        vm.prank(reviewer2);
        granter.revokePublishingRoles(artist);
        require(!release.hasRole(release.ARTIST_ROLE(), artist), "artist revoked");
        require(!release.hasRole(release.ISSUER_ROLE(), artist), "issuer revoked");
    }

    function testNonReviewerCannotGrant() public {
        vm.prank(stranger);
        try granter.grantPublishingRoles(artist) { revert("stranger granted"); } catch {}
        require(!release.hasRole(release.ARTIST_ROLE(), artist), "no role");
    }

    function testOwnerIsNotAReviewer() public {
        vm.prank(owner);
        try granter.grantPublishingRoles(artist) { revert("owner granted"); } catch {}
    }

    function testReviewerCannotGrantThemselves() public {
        vm.prank(reviewer);
        try granter.grantPublishingRoles(reviewer) { revert("self grant"); } catch {}
        require(!release.hasRole(release.ARTIST_ROLE(), reviewer), "no self role");
    }

    function testZeroAddressRejected() public {
        vm.prank(reviewer);
        try granter.grantPublishingRoles(address(0)) { revert("zero"); } catch {}
    }

    function testRemovedReviewerLosesAccess() public {
        vm.prank(owner);
        granter.setReviewer(reviewer, false);
        vm.prank(reviewer);
        try granter.grantPublishingRoles(artist) { revert("removed reviewer granted"); } catch {}
    }

    function testOnlyOwnerManagesReviewers() public {
        vm.prank(reviewer);
        try granter.setReviewer(stranger, true) { revert("reviewer added reviewer"); } catch {}
        vm.prank(stranger);
        try granter.transferOwnership(stranger) { revert("stranger took ownership"); } catch {}
        vm.prank(owner);
        granter.transferOwnership(reviewer2);
        require(granter.owner() == reviewer2, "ownership moved");
    }

    function testAdminCanSwitchTheGranterOff() public {
        release.revokeRole(release.DEFAULT_ADMIN_ROLE(), address(granter));
        vm.prank(reviewer);
        try granter.grantPublishingRoles(artist) { revert("granted after switch-off"); } catch {}
    }

    function testGranterWithoutAdminRoleCannotGrant() public {
        address[] memory reviewers = new address[](1);
        reviewers[0] = reviewer;
        VoidRoleGranter unprivileged = new VoidRoleGranter(address(release), owner, reviewers);
        vm.prank(reviewer);
        try unprivileged.grantPublishingRoles(artist) { revert("granted without admin"); } catch {}
    }
}
