// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/// @title DemoMerchant (implementation A, version "1")
/// @notice Project-owned demo merchant on Arc. Orders are created by the admin with an exact native-USDC
///         amount (18 decimals on Arc); `pay(orderId)` only succeeds for the expected payer with the exact value.
///         Native USDC on Arc = msg.value (18 decimals). Nothing here touches the 6-decimal ERC-20 interface.
contract DemoMerchantV1 is Initializable, UUPSUpgradeable, OwnableUpgradeable, PausableUpgradeable {
    struct Order {
        address payer;
        uint256 amountNativeAtomic; // 18-decimal native USDC units
        bool paid;
        uint64 createdAtBlock;
        uint64 paidAtBlock;
    }

    mapping(bytes32 => Order) private _orders;

    event OrderCreated(bytes32 indexed orderId, address indexed payer, uint256 amountNativeAtomic);
    event OrderPaid(bytes32 indexed orderId, address indexed payer, uint256 amountNativeAtomic);
    event Withdrawn(address indexed to, uint256 amountNativeAtomic);

    error OrderExists(bytes32 orderId);
    error OrderUnknown(bytes32 orderId);
    error OrderAlreadyPaid(bytes32 orderId);
    error WrongPayer(bytes32 orderId, address expected, address actual);
    error WrongAmount(bytes32 orderId, uint256 expected, uint256 actual);
    error ZeroAmount();
    error ZeroAddress();
    error DirectSendRejected();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address owner_) external initializer {
        if (owner_ == address(0)) revert ZeroAddress();
        __UUPSUpgradeable_init();
        __Ownable_init(owner_);
        __Pausable_init();
    }

    function version() external pure virtual returns (string memory) {
        return "1";
    }

    // ---- admin ----

    function createOrder(bytes32 orderId, address payer, uint256 amountNativeAtomic) external onlyOwner {
        if (payer == address(0)) revert ZeroAddress();
        if (amountNativeAtomic == 0) revert ZeroAmount();
        Order storage o = _orders[orderId];
        if (o.payer != address(0)) revert OrderExists(orderId);
        o.payer = payer;
        o.amountNativeAtomic = amountNativeAtomic;
        o.createdAtBlock = uint64(block.number);
        emit OrderCreated(orderId, payer, amountNativeAtomic);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Withdraw project-owned demo balance (native USDC). Arc value rules apply (no zero address, no blocklisted).
    function withdraw(address payable to, uint256 amountNativeAtomic) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        (bool ok,) = to.call{value: amountNativeAtomic}("");
        require(ok, "withdraw failed");
        emit Withdrawn(to, amountNativeAtomic);
    }

    // ---- payer ----

    function pay(bytes32 orderId) external payable whenNotPaused {
        Order storage o = _orders[orderId];
        if (o.payer == address(0)) revert OrderUnknown(orderId);
        if (o.paid) revert OrderAlreadyPaid(orderId);
        if (msg.sender != o.payer) revert WrongPayer(orderId, o.payer, msg.sender);
        if (msg.value != o.amountNativeAtomic) revert WrongAmount(orderId, o.amountNativeAtomic, msg.value);
        o.paid = true;
        o.paidAtBlock = uint64(block.number);
        emit OrderPaid(orderId, msg.sender, msg.value);
    }

    // ---- views ----

    function getOrder(bytes32 orderId)
        external
        view
        returns (address payer, uint256 amountNativeAtomic, bool paid, uint64 createdAtBlock, uint64 paidAtBlock)
    {
        Order storage o = _orders[orderId];
        return (o.payer, o.amountNativeAtomic, o.paid, o.createdAtBlock, o.paidAtBlock);
    }

    // Plain native sends are rejected: the only way in is pay(orderId).
    receive() external payable {
        revert DirectSendRejected();
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    uint256[48] private __gap;
}
