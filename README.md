# FXRP Gasless Payments

Gasless FXRP (FAsset) transfers on Flare Network using [EIP-712](https://eips.ethereum.org/EIPS/eip-712) signed meta-transactions.
Users sign payment requests off-chain; relayers submit them on-chain and pay gas fees on behalf of users.

## Overview

This project enables users to transfer FXRP without holding FLR for gas. Instead:

1. **User** signs a payment request with EIP-712 (off-chain, no gas).
2. **Relayer** submits the signed request to the blockchain (pays gas).
3. **Contract** verifies the signature and executes the FXRP transfer.

The FXRP token address is resolved dynamically from the Flare Contract Registry via `ContractRegistry.getAssetManagerFXRP() -> AssetManager.fAsset()`.

## Project Structure

```
├── contracts/
│   └── GaslessPaymentForwarder.sol   # Main contract
├── client/
│   └── signer.ts                     # Client utilities for signing
├── relayer/
│   └── index.ts                      # Relayer HTTP service
├── scripts/
│   ├── deploy.ts                    # Deployment script
│   └── example-usage.ts             # Example flow
└── typechain-types/                 # Generated contract types
```

## Prerequisites

- Node.js 18+
- FXRP tokens (mint or bridge on Flare/Coston2)
- FLR for gas (relayer wallet)

## Installation

```bash
npm install
```

## Configuration

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

| Variable | Description |
|----------|-------------|
| `PRIVATE_KEY` | Deployer private key (for deployment) |
| `RELAYER_PRIVATE_KEY` | Relayer wallet (pays gas, receives FXRP fees) |
| `USER_PRIVATE_KEY` | User wallet for testing |
| `FORWARDER_ADDRESS` | Deployed contract address (set after deploy) |
| `RPC_URL` | Flare network RPC (default: Coston2) |
| `RELAYER_URL` | Relayer HTTP URL (default: http://localhost:3000) |

## Usage

### 1. Compile

```bash
npm run compile
```

### 2. Deploy Contract

Deploy to Coston2 (testnet):

```bash
npm run deploy:coston2
```

Set `FORWARDER_ADDRESS` in `.env` with the deployed contract address.

### 3. Start Relayer

The relayer accepts signed payment requests and submits them on-chain:

```bash
npm run relayer
```

Endpoints:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/nonce/:address` | Get nonce for address |
| GET | `/fee` | Get relayer fee |
| POST | `/execute` | Execute single payment |
| POST | `/execute-batch` | Execute batch payments |

### 4. User Flow

#### One-time: Approve FXRP

Users must approve the forwarder contract to spend their FXRP once:

```typescript
import { approveFXRP } from "./client/signer";

await approveFXRP(wallet, forwarderAddress);
```

#### Create & Sign Payment Request

```typescript
import { createPaymentRequest } from "./client/signer";

const request = await createPaymentRequest(
  wallet,
  forwarderAddress,
  recipientAddress,
  "1.5",   // amount in FXRP
  "0.01"   // fee in FXRP (optional, uses contract default if null)
);
```

#### Submit to Relayer

```typescript
const response = await fetch(`${RELAYER_URL}/execute`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(request),
});
const result = await response.json();
```

### 5. Run Example

```bash
npm run example
```

This runs the full flow: check status, approve (if needed), create payment, submit to relayer.

## Client API

From `client/signer.ts`:

| Function | Description |
|----------|-------------|
| `getTokenDecimals(provider, forwarderAddress)` | Get FXRP decimals |
| `getNonce(provider, forwarderAddress, userAddress)` | Get user nonce |
| `getRelayerFee(provider, forwarderAddress)` | Get minimum fee |
| `createPaymentRequest(wallet, forwarderAddress, to, amount, fee?, deadline?)` | Create & sign payment |
| `approveFXRP(wallet, forwarderAddress, amount?)` | Approve forwarder to spend FXRP |
| `checkUserStatus(provider, forwarderAddress, userAddress)` | Balance, allowance, nonce |

## Contract

### GaslessPaymentForwarder

- `fxrp()` – Returns FXRP token address (from Flare Contract Registry)
- `executePayment(from, to, amount, fee, deadline, signature)` – Execute single payment
- `executeBatchPayments(requests[])` – Execute multiple payments
- `getNonce(account)` – Get nonce for replay protection
- `relayerFee()` – Minimum relayer fee in FXRP base units

### Owner Functions

- `setRelayerFee(fee)` – Update minimum fee
- `setRelayerAuthorization(relayer, authorized)` – Authorize relayers

## License

MIT
