---
name: blockchain-web3
description: Query Ethereum blockchain data — balances, transactions, and smart contracts. Use when you need to look up wallet balances, block data, or on-chain transaction history.
license: Apache-2.0
metadata:
  author: Open Enthrium
  version: "1.1"
---

You are a blockchain data agent. Query Ethereum or EVM-compatible chain data.
Never sign or broadcast transactions without explicit user confirmation.
Complete all steps fully before writing your report.

## Step 1: Network Info

Call eth_chainId with params [] to identify the connected network (mainnet=1, Polygon=137, etc.).
Call eth_blockNumber with params [] to get the latest block number (result is hex — convert to decimal).
Call eth_getBlockByNumber with params [<latest block in hex>, false] to get block details (pass false for transaction hashes only, not full objects).

## Step 2: Address Lookup

Look up the Ethereum Foundation's public address: 0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe

Call eth_getBalance with params ["0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe", "latest"]. The result is a hex string (e.g. "0x1a2b3c...") representing Wei. IMPORTANT: convert the full hex string to a decimal integer first, then divide by 1e18 to get ETH. Do NOT treat hex digits as decimal digits.
Call eth_getTransactionCount with params ["0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe", "latest"] to get the nonce. The result is hex — convert to decimal integer.
To get the USDC balance, call eth_call with params:
  - to: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" (USDC contract)
  - data: "0x70a08231000000000000000000000000de0B295669a9FD93d5F28D9Ec85E40f4cb697BAe" (balanceOf selector + address padded to 32 bytes)
  - block tag: "latest"
The result is a hex string — convert to decimal integer first, then divide by 1e6 (USDC has 6 decimals) to get the USDC amount.

## Step 3: Recent Transactions

From the block fetched in Step 1, take the first 3 transaction hashes from the `transactions` array.
For each hash, call eth_getTransactionByHash with params [<txHash>].
Also call eth_getTransactionReceipt with params [<txHash>] to get the status and gas used.
Skip any transaction where `to` is null (contract deploys). If needed take the next hash.
Record: from, to, value in ETH (convert hex value to decimal integer first, then ÷ 1e18), gas used from receipt (convert hex to decimal), status (1=success, 0=fail).

## Step 4: Report

Produce a blockchain summary:
- Network: chain ID and name
- Latest block: number, timestamp (unix → human readable), transaction count
- Address lookup (0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe):
  - ETH balance
  - USDC balance (if call succeeded)
  - Transaction count (nonce)
- Recent transactions: 3 examples with from / to / value in ETH / status
