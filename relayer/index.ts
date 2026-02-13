/**
 * FXRP Gasless Payment Relayer Service
 *
 * This service accepts signed payment requests from users and submits them
 * to the blockchain, paying gas fees on behalf of users.
 *
 * Usage:
 *   npx ts-node relayer/index.ts
 *
 * Environment variables required:
 *   RELAYER_PRIVATE_KEY - Private key of the relayer wallet
 *   FORWARDER_ADDRESS - Address of the deployed GaslessPaymentForwarder contract
 *   RPC_URL - Flare network RPC URL (optional, defaults to Coston2 testnet)
 */

import { ethers, Contract, Wallet, JsonRpcProvider } from "ethers";
import { erc20Abi, recoverTypedDataAddress, type TypedDataDomain, type TypedData } from "viem";
import http, { IncomingMessage, ServerResponse } from "http";
import "dotenv/config";
import type { GaslessPaymentForwarder } from "../typechain-types/contracts/GaslessPaymentForwarder";
import { GaslessPaymentForwarder__factory } from "../typechain-types/factories/contracts/GaslessPaymentForwarder__factory";

// EIP-712 domain and types (viem format, must match contract)
const EIP712_DOMAIN: TypedDataDomain = {
  name: "GaslessPaymentForwarder",
  version: "1",
};

const PAYMENT_REQUEST_TYPES = {
  PaymentRequest: [
    { name: "from", type: "address" as const },
    { name: "to", type: "address" as const },
    { name: "amount", type: "uint256" as const },
    { name: "fee", type: "uint256" as const },
    { name: "nonce", type: "uint256" as const },
    { name: "deadline", type: "uint256" as const },
  ],
} satisfies TypedData;

// Network configurations
const NETWORKS: Record<string, { rpc: string; chainId: number }> = {
  flare: {
    rpc: "https://flare-api.flare.network/ext/C/rpc",
    chainId: 14,
  },
  coston2: {
    rpc: "https://coston2-api.flare.network/ext/C/rpc",
    chainId: 114,
  },
  songbird: {
    rpc: "https://songbird-api.flare.network/ext/C/rpc",
    chainId: 19,
  },
};

// Type definitions
export interface RelayerConfig {
  relayerPrivateKey: string;
  forwarderAddress: string;
  rpcUrl?: string;
}

export interface PaymentRequest {
  from: string;
  to: string;
  amount: string;
  fee: string;
  deadline: number;
  signature: string;
}

export interface ExecuteResult {
  success: boolean;
  transactionHash: string;
  blockNumber: number | null;
  gasUsed: string;
}

export interface BatchExecuteResult extends ExecuteResult {
  paymentsProcessed: number;
}

export class GaslessRelayer {
  private config: RelayerConfig;
  private provider: JsonRpcProvider;
  private wallet: Wallet;
  private forwarder: GaslessPaymentForwarder;

  constructor(config: RelayerConfig) {
    this.config = config;

    // Setup provider and wallet
    const rpcUrl = config.rpcUrl || NETWORKS.coston2.rpc;
    this.provider = new JsonRpcProvider(rpcUrl);
    this.wallet = new Wallet(config.relayerPrivateKey, this.provider);

    // Setup contract (generated ABI from typechain-types)
    this.forwarder = GaslessPaymentForwarder__factory.connect(
      config.forwarderAddress,
      this.wallet
    );

    console.log(`Relayer initialized`);
    console.log(`  Relayer address: ${this.wallet.address}`);
    console.log(`  Forwarder contract: ${config.forwarderAddress}`);
  }

  /**
   * Execute a single gasless payment
   */
  async executePayment(request: PaymentRequest): Promise<ExecuteResult> {
    // Normalize and validate request format
    const from = ethers.getAddress(request.from);
    const to = ethers.getAddress(request.to);
    const amount = BigInt(request.amount);
    const fee = BigInt(request.fee);
    const deadline = Number(request.deadline);
    const sig = request.signature;
    if (typeof sig !== "string" || sig.length < 130) {
      throw new Error("Invalid signature: must be a hex string");
    }
    const signature = sig.startsWith("0x") ? sig : "0x" + sig;

    const normalizedRequest: PaymentRequest = {
      from,
      to,
      amount: amount.toString(),
      fee: fee.toString(),
      deadline,
      signature,
    };

    // Verify EIP-712 signature off-chain (catches domain/nonce mismatches before submitting)
    const chainId = (await this.provider.getNetwork()).chainId;
    const nonce = await this.forwarder.getNonce(from);
    const domain: TypedDataDomain = {
      ...EIP712_DOMAIN,
      chainId: Number(chainId),
      verifyingContract: ethers.getAddress(this.config.forwarderAddress) as `0x${string}`,
    };
    const message = {
      from,
      to,
      amount,
      fee,
      nonce,
      deadline,
    };
    let recoveredAddress: string;
    try {
      recoveredAddress = await recoverTypedDataAddress({
        domain,
        types: PAYMENT_REQUEST_TYPES,
        primaryType: "PaymentRequest",
        message,
        signature: signature as `0x${string}`,
      });
    } catch (e) {
      throw new Error(
        `Invalid signature format: ${e instanceof Error ? e.message : String(e)}`
      );
    }
    if (recoveredAddress.toLowerCase() !== from.toLowerCase()) {
      throw new Error(
        `Signature invalid: recovered ${recoveredAddress} but expected ${from}. ` +
          `Check chainId (expected ${chainId}), forwarder address, and nonce (expected ${nonce}).`
      );
    }

    // Validate the request
    await this.validateRequest(normalizedRequest);

    // Simulate first (fails fast, may yield better revert reason)
    try {
      await this.forwarder.executePayment.staticCall(
        from,
        to,
        amount,
        fee,
        deadline,
        signature
      );
    } catch (simError) {
      const err = simError as Error & { reason?: string; data?: string };
      const msg =
        err.reason ||
        (err.data ? `revert data: ${err.data}` : err.message);
      throw new Error(`Contract simulation failed: ${msg}`);
    }

    // Re-check nonce right before send (prevents race if another request executed first)
    const nonceNow = await this.forwarder.getNonce(from);
    if (nonceNow !== nonce) {
      throw new Error(
        `Nonce changed (was ${nonce}, now ${nonceNow}). ` +
          `Payment may have been submitted by another request. Please create a new payment request.`
      );
    }

    // Estimate gas (staticCall uses block limit, so we must estimate for real tx)
    let gasLimit: bigint;
    try {
      const estimated = await this.forwarder.executePayment.estimateGas(
        from,
        to,
        amount,
        fee,
        deadline,
        signature
      );
      gasLimit = (estimated * 130n) / 100n; // 30% buffer
    } catch (estError) {
      const err = estError as Error;
      throw new Error(
        `Gas estimation failed (contract would revert): ${err.message}`
      );
    }

    // Execute the payment
    let tx: ethers.ContractTransactionResponse;
    try {
      tx = await this.forwarder.executePayment(
        from,
        to,
        amount,
        fee,
        deadline,
        signature,
        { gasLimit }
      );
    } catch (sendError) {
      throw this.enrichRevertError(sendError, "sendTransaction");
    }

    // Wait for confirmation
    let receipt: ethers.TransactionReceipt | null;
    try {
      receipt = await tx.wait();
    } catch (waitError) {
      throw await this.enrichRevertErrorAsync(
        waitError,
        "transaction",
        tx.hash
      );
    }

    return {
      success: true,
      transactionHash: tx.hash,
      blockNumber: receipt?.blockNumber ?? null,
      gasUsed: receipt?.gasUsed?.toString() ?? "0",
    };
  }

  /**
   * Execute multiple payments in a batch
   */
  async executeBatchPayments(
    requests: PaymentRequest[]
  ): Promise<BatchExecuteResult> {
    // Validate all requests
    for (const request of requests) {
      await this.validateRequest(request);
    }

    // Format requests for the contract
    const formattedRequests = requests.map((r) => ({
      from: r.from,
      to: r.to,
      amount: r.amount,
      fee: r.fee,
      deadline: r.deadline,
      signature: r.signature,
    }));

    // Execute batch
    const tx = await this.forwarder.executeBatchPayments(formattedRequests, {
      gasLimit: 100000n * BigInt(requests.length),
    });

    const receipt = await tx.wait();

    return {
      success: true,
      transactionHash: tx.hash,
      blockNumber: receipt?.blockNumber ?? null,
      gasUsed: receipt?.gasUsed?.toString() ?? "0",
      paymentsProcessed: requests.length,
    };
  }

  /**
   * Validate a payment request before submission
   */
  async validateRequest(request: PaymentRequest): Promise<void> {
    const { from, amount, fee, deadline } = request;

    // Check deadline against chain time (not local clock - avoids skew)
    const block = await this.provider.getBlock("latest");
    const chainTime = block?.timestamp ?? Math.floor(Date.now() / 1000);
    if (deadline <= chainTime) {
      throw new Error(
        `Payment request has expired (deadline: ${deadline}, chain: ${chainTime})`
      );
    }

    // Get FXRP token from forwarder
    const fxrpAddress: string = await this.forwarder.fxrp();
    const fxrp = new Contract(fxrpAddress, erc20Abi as ethers.InterfaceAbi, this.provider);
    const decimals = (await fxrp.decimals()) as number;

    // Check sender's FXRP balance
    const balance: bigint = await fxrp.balanceOf(from);
    const totalRequired = BigInt(amount) + BigInt(fee);
    if (balance < totalRequired) {
      throw new Error(
        `Insufficient FXRP balance. Required: ${ethers.formatUnits(totalRequired, decimals)}, Available: ${ethers.formatUnits(balance, decimals)}`
      );
    }

    // Check allowance
    const allowance: bigint = await fxrp.allowance(
      from,
      this.config.forwarderAddress
    );
    if (allowance < totalRequired) {
      throw new Error(
        `Insufficient FXRP allowance. Required: ${ethers.formatUnits(totalRequired, decimals)}, Approved: ${ethers.formatUnits(allowance, decimals)}`
      );
    }

    // Check minimum fee
    const minFee: bigint = await this.forwarder.relayerFee();
    if (BigInt(fee) < minFee) {
      throw new Error(
        `Fee too low. Minimum: ${ethers.formatUnits(minFee, decimals)} FXRP`
      );
    }
  }

  /**
   * Decode revert reason from contract errors
   */
  private enrichRevertError(
    err: unknown,
    phase: string,
    txHash?: string
  ): Error {
    const msg = this.parseRevertReason(err);
    const hint =
      txHash &&
      ` Inspect tx: https://coston2-explorer.flare.network/tx/${txHash}`;
    return new Error(`${phase} failed: ${msg}${hint || ""}`);
  }

  /**
   * Async version: fetch failed tx from chain to diagnose empty-data issue
   */
  private async enrichRevertErrorAsync(
    err: unknown,
    phase: string,
    txHash: string
  ): Promise<Error> {
    let msg = this.parseRevertReason(err);

    // Fetch tx from chain to verify calldata
    try {
      const tx = await this.provider.getTransaction(txHash);
      if (tx?.data === "0x" || tx?.data === undefined) {
        msg += " [TX had no calldata - relayer bug]";
      } else {
        msg += ` [calldata length: ${tx?.data?.length ?? 0} chars]`;
      }
    } catch {
      // Ignore fetch errors
    }

    const hint = ` Inspect tx: https://coston2-explorer.flare.network/tx/${txHash}`;
    return new Error(`${phase} failed: ${msg}${hint}`);
  }

  private parseRevertReason(err: unknown): string {
    const e = err as Error & {
      data?: string;
      revert?: { name: string };
    };
    let msg = e.message;

    if (e.revert?.name) {
      msg = `Contract reverted: ${e.revert.name}`;
    } else if (e.data && typeof e.data === "string" && e.data.startsWith("0x")) {
      try {
        const iface = GaslessPaymentForwarder__factory.createInterface();
        const parsed = iface.parseError(e.data);
        if (parsed) msg = `Contract reverted: ${parsed.name}`;
      } catch {
        /* ignore */
      }
    }
    return msg;
  }

  /**
   * Get the current nonce for an address
   */
  async getNonce(address: string): Promise<bigint> {
    return await this.forwarder.getNonce(address);
  }

  /**
   * Get the minimum relayer fee
   */
  async getRelayerFee(): Promise<bigint> {
    return await this.forwarder.relayerFee();
  }

  /**
   * Get FXRP token decimals
   */
  async getTokenDecimals(): Promise<number> {
    const fxrpAddress: string = await this.forwarder.fxrp();
    const fxrp = new Contract(fxrpAddress, erc20Abi as ethers.InterfaceAbi, this.provider);
    return (await fxrp.decimals()) as number;
  }

  /**
   * Check relayer's FLR balance for gas
   */
  async getRelayerBalance(): Promise<string> {
    const balance = await this.provider.getBalance(this.wallet.address);
    return ethers.formatEther(balance);
  }
}

// Simple HTTP server for receiving payment requests
async function startServer(
  relayer: GaslessRelayer,
  port: number = 3000
): Promise<void> {
  const server = http.createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      // CORS headers
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");

      if (req.method === "OPTIONS") {
        res.writeHead(200);
        res.end();
        return;
      }

      // Get nonce for an address
      if (req.method === "GET" && req.url?.startsWith("/nonce/")) {
        const address = req.url.split("/nonce/")[1];
        try {
          const nonce = await relayer.getNonce(address);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ nonce: nonce.toString() }));
        } catch (error) {
          const err = error as Error;
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // Get relayer fee
      if (req.method === "GET" && req.url === "/fee") {
        const [fee, decimals] = await Promise.all([
          relayer.getRelayerFee(),
          relayer.getTokenDecimals(),
        ]);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            fee: fee.toString(),
            feeFormatted: ethers.formatUnits(fee, decimals) + " FXRP",
          })
        );
        return;
      }

      // Execute payment
      if (req.method === "POST" && req.url?.split("?")[0] === "/execute") {
        let body = "";
        req.on("data", (chunk: Buffer) => (body += chunk));
        req.on("end", async () => {
          try {
            const request: PaymentRequest = JSON.parse(body);
            const result = await relayer.executePayment(request);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(result));
          } catch (error) {
            const err = error as Error;
            console.error("Payment execution failed:", err.message);
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      // Execute batch payments
      if (req.method === "POST" && req.url === "/execute-batch") {
        let body = "";
        req.on("data", (chunk: Buffer) => (body += chunk));
        req.on("end", async () => {
          try {
            const requests: PaymentRequest[] = JSON.parse(body);
            const result = await relayer.executeBatchPayments(requests);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(result));
          } catch (error) {
            const err = error as Error;
            console.error("Batch execution failed:", err.message);
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    }
  );

  server.listen(port, () => {
    console.log(`\nRelayer server running on http://localhost:${port}`);
    console.log(`\nEndpoints:`);
    console.log(`  GET  /nonce/:addr   - Get nonce for address`);
    console.log(`  GET  /fee           - Get relayer fee`);
    console.log(`  POST /execute       - Execute single payment`);
    console.log(`  POST /execute-batch - Execute batch payments`);
  });
}

// Main entry point
async function main(): Promise<void> {
  const relayerPrivateKey = process.env.RELAYER_PRIVATE_KEY;
  const forwarderAddress = process.env.FORWARDER_ADDRESS;
  const rpcUrl = process.env.RPC_URL;
  const port = parseInt(process.env.PORT || "3000", 10);

  if (!relayerPrivateKey) {
    console.error("Error: RELAYER_PRIVATE_KEY environment variable required");
    process.exit(1);
  }

  if (!forwarderAddress) {
    console.error("Error: FORWARDER_ADDRESS environment variable required");
    process.exit(1);
  }

  const relayer = new GaslessRelayer({
    relayerPrivateKey,
    forwarderAddress,
    rpcUrl,
  });

  // Check relayer balance
  const balance = await relayer.getRelayerBalance();
  console.log(`Relayer FLR balance: ${balance} FLR`);

  if (parseFloat(balance) < 0.1) {
    console.warn(
      "Warning: Low relayer balance. Please fund the relayer wallet."
    );
  }

  await startServer(relayer, port);
}

// Run if executed directly
if (require.main === module) {
  main().catch(console.error);
}
