// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {DemoMerchantV1} from "../src/DemoMerchantV1.sol";
import {DemoMerchantV2} from "../src/DemoMerchantV2.sol";

/// Usage (dry run):  forge script script/DeployDemoMerchant.s.sol --rpc-url arc_testnet
/// Broadcast:        forge script script/DeployDemoMerchant.s.sol --rpc-url arc_testnet --broadcast --private-key $DEPLOYER_ADMIN_PRIVATE_KEY
contract DeployDemoMerchant is Script {
    function run() external {
        address owner = vm.envAddress("DEMO_ADMIN_ADDRESS");
        vm.startBroadcast();
        DemoMerchantV1 implA = new DemoMerchantV1();
        DemoMerchantV2 implB = new DemoMerchantV2();
        bytes memory init = abi.encodeCall(DemoMerchantV1.initialize, (owner));
        ERC1967Proxy proxy = new ERC1967Proxy(address(implA), init);
        vm.stopBroadcast();
        console.log("DemoMerchant proxy:", address(proxy));
        console.log("Implementation A (v1):", address(implA));
        console.log("Implementation B (v2, not yet active):", address(implB));
    }
}
