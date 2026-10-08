// ABI fragments and topics of the supported DemoMerchant template, shared by the runner, the reconciler and the CLI.
import { keccak256, toHex } from "viem";

export const CREATE_ORDER_ABI = [{ type: "function", name: "createOrder", stateMutability: "nonpayable", inputs: [{ name: "orderId", type: "bytes32" }, { name: "payer", type: "address" }, { name: "amountNativeAtomic", type: "uint256" }], outputs: [] }] as const;
export const GET_ORDER_ABI = [{ type: "function", name: "getOrder", stateMutability: "view", inputs: [{ name: "orderId", type: "bytes32" }], outputs: [{ type: "address" }, { type: "uint256" }, { type: "bool" }, { type: "uint64" }, { type: "uint64" }] }] as const;
export const PAUSED_ABI = [{ type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] }] as const;
export const ORDER_PAID_TOPIC = keccak256(toHex("OrderPaid(bytes32,address,uint256)"));
export const ORDER_CREATED_TOPIC = keccak256(toHex("OrderCreated(bytes32,address,uint256)"));
