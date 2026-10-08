// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {DemoMerchantV1} from "../src/DemoMerchantV1.sol";
import {DemoMerchantV2} from "../src/DemoMerchantV2.sol";

contract DemoMerchantTest is Test {
    bytes32 constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    uint256 constant ORDER_CREATOR_SLOT = 1; // _orders is slot 0; orderCreator took the first slot of the former gap
    address admin = makeAddr("admin");
    address payer = makeAddr("payer");
    address stranger = makeAddr("stranger");
    address creator = makeAddr("creator");
    DemoMerchantV1 implA;
    DemoMerchantV2 implB;
    DemoMerchantV1 m; // proxy as V1 interface
    bytes32 orderId = keccak256("order-1");
    bytes32 orderId2 = keccak256("order-2");
    uint256 amount = 0.05e18; // 0.05 native USDC

    function setUp() public {
        implA = new DemoMerchantV1();
        implB = new DemoMerchantV2();
        ERC1967Proxy proxy = new ERC1967Proxy(address(implA), abi.encodeCall(DemoMerchantV1.initialize, (admin)));
        m = DemoMerchantV1(payable(address(proxy)));
        vm.deal(payer, 1e18);
        vm.deal(stranger, 1e18);
        vm.deal(creator, 1e18);
    }

    function _implOf(address proxy) internal view returns (address) {
        return address(uint160(uint256(vm.load(proxy, IMPL_SLOT))));
    }

    function _notOwner(address who) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, who);
    }

    function test_createAndPay_exactAmount() public {
        vm.prank(admin);
        m.createOrder(orderId, payer, amount);
        vm.prank(payer);
        m.pay{value: amount}(orderId);
        (address p, uint256 a, bool paid,,) = m.getOrder(orderId);
        assertEq(p, payer);
        assertEq(a, amount);
        assertTrue(paid);
        assertEq(address(m).balance, amount);
    }

    function test_pay_wrongUnit_6decimals_reverts() public {
        vm.prank(admin);
        m.createOrder(orderId, payer, amount);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(DemoMerchantV1.WrongAmount.selector, orderId, amount, 50000));
        m.pay{value: 50000}(orderId); // 0.05 USDC encoded in ERC-20 6-dec units -> wrong on native path
    }

    function test_pay_wrongPayer_reverts() public {
        vm.prank(admin);
        m.createOrder(orderId, payer, amount);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(DemoMerchantV1.WrongPayer.selector, orderId, payer, stranger));
        m.pay{value: amount}(orderId);
    }

    function test_pay_twice_reverts() public {
        vm.prank(admin);
        m.createOrder(orderId, payer, amount);
        vm.prank(payer);
        m.pay{value: amount}(orderId);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(DemoMerchantV1.OrderAlreadyPaid.selector, orderId));
        m.pay{value: amount}(orderId);
    }

    function test_pay_unknownOrder_reverts() public {
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(DemoMerchantV1.OrderUnknown.selector, orderId));
        m.pay{value: amount}(orderId);
    }

    function test_paused_blocks_pay() public {
        vm.prank(admin);
        m.createOrder(orderId, payer, amount);
        vm.prank(admin);
        m.pause();
        vm.prank(payer);
        vm.expectRevert();
        m.pay{value: amount}(orderId);
    }

    function test_directSend_rejected() public {
        vm.prank(payer);
        (bool ok,) = address(m).call{value: 1}("");
        assertFalse(ok);
    }

    function test_onlyOwner_createOrder_pause_withdraw_upgrade() public {
        vm.prank(stranger);
        vm.expectRevert();
        m.createOrder(orderId, payer, amount);
        vm.prank(stranger);
        vm.expectRevert();
        m.pause();
        vm.prank(stranger);
        vm.expectRevert();
        m.withdraw(payable(stranger), 0);
        vm.prank(stranger);
        vm.expectRevert();
        m.upgradeToAndCall(address(implB), "");
    }

    function test_upgrade_A_to_B_changes_impl_slot_and_version_keeps_state() public {
        vm.prank(admin);
        m.createOrder(orderId, payer, amount);
        vm.prank(admin);
        m.setOrderCreator(creator);
        assertEq(_implOf(address(m)), address(implA));
        assertEq(m.version(), "1");
        vm.prank(admin);
        m.upgradeToAndCall(address(implB), "");
        assertEq(_implOf(address(m)), address(implB));
        assertEq(m.version(), "2");
        (address p, uint256 a, bool paid,,) = m.getOrder(orderId);
        assertEq(p, payer);
        assertEq(a, amount);
        assertFalse(paid);
        assertTrue(address(implA).codehash != address(implB).codehash);
        // the role survives the upgrade (same slot in A and B) and still works on B
        assertEq(m.orderCreator(), creator);
        vm.prank(creator);
        m.createOrder(orderId2, payer, amount);
        (address p2,,,,) = m.getOrder(orderId2);
        assertEq(p2, payer);
    }

    function test_withdraw_by_owner() public {
        vm.prank(admin);
        m.createOrder(orderId, payer, amount);
        vm.prank(payer);
        m.pay{value: amount}(orderId);
        vm.prank(admin);
        m.withdraw(payable(admin), amount);
        assertEq(admin.balance, amount);
    }

    function test_initialize_cannot_rerun() public {
        vm.expectRevert();
        m.initialize(stranger);
    }

    // ---- order-creator role ----

    function test_orderCreator_default_unset_and_stored_in_slot_1() public {
        assertEq(m.orderCreator(), address(0));
        vm.prank(admin);
        m.createOrder(orderId, payer, amount); // _orders in slot 0 is untouched by the new variable
        vm.prank(admin);
        m.setOrderCreator(creator);
        assertEq(m.orderCreator(), creator);
        assertEq(address(uint160(uint256(vm.load(address(m), bytes32(ORDER_CREATOR_SLOT))))), creator);
        (address p,,,,) = m.getOrder(orderId);
        assertEq(p, payer);
    }

    function test_setOrderCreator_emits_event_and_is_owner_only() public {
        vm.expectEmit(true, false, false, false, address(m));
        emit DemoMerchantV1.OrderCreatorSet(creator);
        vm.prank(admin);
        m.setOrderCreator(creator);
        vm.prank(stranger);
        vm.expectRevert(_notOwner(stranger));
        m.setOrderCreator(stranger);
    }

    function test_orderCreator_can_createOrder_and_payer_pays() public {
        vm.prank(admin);
        m.setOrderCreator(creator);
        vm.prank(creator);
        m.createOrder(orderId, payer, amount);
        vm.prank(payer);
        m.pay{value: amount}(orderId);
        (, , bool paid,,) = m.getOrder(orderId);
        assertTrue(paid);
    }

    function test_orderCreator_cannot_pause_withdraw_upgrade_or_reassign() public {
        vm.prank(admin);
        m.setOrderCreator(creator);
        vm.prank(creator);
        vm.expectRevert(_notOwner(creator));
        m.pause();
        vm.prank(creator);
        vm.expectRevert(_notOwner(creator));
        m.unpause();
        vm.prank(creator);
        vm.expectRevert(_notOwner(creator));
        m.withdraw(payable(creator), 0);
        vm.prank(creator);
        vm.expectRevert(_notOwner(creator));
        m.upgradeToAndCall(address(implB), "");
        vm.prank(creator);
        vm.expectRevert(_notOwner(creator));
        m.setOrderCreator(stranger);
        assertEq(_implOf(address(m)), address(implA));
        assertEq(m.orderCreator(), creator);
    }

    function test_owner_still_creates_orders_when_creator_is_set() public {
        vm.prank(admin);
        m.setOrderCreator(creator);
        vm.prank(admin);
        m.createOrder(orderId, payer, amount);
        (address p,,,,) = m.getOrder(orderId);
        assertEq(p, payer);
    }

    function test_clearing_orderCreator_revokes_the_role() public {
        vm.prank(admin);
        m.setOrderCreator(creator);
        vm.prank(admin);
        m.setOrderCreator(address(0));
        assertEq(m.orderCreator(), address(0));
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(DemoMerchantV1.NotOrderCreator.selector, creator));
        m.createOrder(orderId, payer, amount);
    }

    function test_stranger_createOrder_reverts_NotOrderCreator() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(DemoMerchantV1.NotOrderCreator.selector, stranger));
        m.createOrder(orderId, payer, amount);
    }
}
