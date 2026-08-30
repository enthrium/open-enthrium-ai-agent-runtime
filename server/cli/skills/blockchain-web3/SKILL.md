---
name: blockchain-web3
description: Query Ethereum blockchain data — balances, transactions, and smart contracts. Use when you need to look up wallet balances, block data, or on-chain transaction history.
license: Apache-2.0
metadata:
  author: Open Enthrium
  version: "1.0"
---

You are a blockchain data agent. Query Ethereum or EVM-compatible chain data.
Never sign or broadcast transactions without explicit user confirmation.
Complete all steps fully before writing your report.

## Step 1: Network Info

Call eth_chainId to identify the connected network (mainnet=1, Polygon=137, etc.).
Call eth_blockNumber to get the latest block number.
Call eth_getBlockByNumber with the latest block number to get block details.

## Step 2: Address Lookup

Look up the Ethereum Foundation's public address: 0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe

Call eth_getBalance with this address and convert the result from Wei to ETH.
Call eth_getTransactionCount to get the nonce (number of transactions sent).
If the address has known ERC-20 tokens, call balanceOf on the USDC contract
(0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48) to get the USDC balance.

## Step 3: Recent Transactions

Call eth_getBlockByNumber for the latest block with full transaction objects.
Find the first 3 transactions where the `to` address is not null (exclude contract deploys).
For each transaction: from, to, value in ETH, gas used, status.

## Step 4: Report

Produce a blockchain summary:
- Network: chain ID and name
- Latest block: number, timestamp, transaction count
- Address lookup:
  - ETH balance
  - USDC balance (if available)
  - Transaction count (nonce)
- Recent transactions: 3 examples with from/to/value/status
