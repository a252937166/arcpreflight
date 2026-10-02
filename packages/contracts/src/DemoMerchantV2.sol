// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {DemoMerchantV1} from "./DemoMerchantV1.sol";

/// @title DemoMerchant implementation B (version "2")
/// @notice Storage-layout compatible with V1. The only behavioral change is the version string and a
///         new view; it exists so the demo can show "approved A, current B" as an UNAPPROVED CHANGE.
///         Nothing about B is malicious; the preflight only reports that the implementation differs
///         from the caller's approved baseline.
contract DemoMerchantV2 is DemoMerchantV1 {
    function version() external pure override returns (string memory) {
        return "2";
    }

    function implementationNote() external pure returns (string memory) {
        return "demo upgrade fixture: identical business logic, different code hash";
    }
}
