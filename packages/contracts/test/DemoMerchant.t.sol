// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {DemoMerchantV1} from "../src/DemoMerchantV1.sol";
import {DemoMerchantV2} from "../src/DemoMerchantV2.sol";

contract DemoMerchantTest is Test {
    bytes32 constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    address admin = makeAddr("admin");
    address payer = makeAddr("payer");
    address stranger = makeAddr("stranger");
    DemoMerchantV1 implA;
    DemoMerchantV2 implB;
    DemoMerchantV1 m; // proxy as V1 interface
    bytes32 orderId = keccak256("order-1");
    uint256 amount = 0.05e18; // 0.05 native USDC

    function setUp() public {
        implA = new DemoMerchantV1();
        implB = new DemoMerchantV2();
        ERC1967Proxy proxy = new ERC1967Proxy(address(implA), abi.encodeCall(DemoMerchantV1.initialize, (admin)));
        m = DemoMerchantV1(payable(address(proxy)));
        vm.deal(payer, 1e18);
        vm.deal(stranger, 1e18);
    }

    function _implOf(address proxy) internal view returns (address) {
        return address(uint160(uint256(vm.load(proxy, IMPL_SLOT))));
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
}
