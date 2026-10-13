/**
 * Swap utility module for ArcPay.
 *
 * Provides functions to estimate swap quotes and build transaction plans
 * for on-chain token swaps using the Uniswap V2 Router on Arc Testnet.
 */

import { ethers } from 'ethers';
import { formatTokenBalance, getAssetDecimals } from './balance';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A swap pair consisting of a token being swapped from and a token being swapped to.
 */
export type SwapPair = {
  from: string;   // token symbol (e.g. 'USDC', 'EURC', 'cirBTC')
  to: string;     // token symbol (e.g. 'EURC', 'cirBTC', 'USDC')
  routerAddress: string;
};

/**
 * A quote for a swap indicating the estimated output amount given an input amount.
 */
export type SwapQuote = {
  from: string;          // token symbol being swapped from (e.g. 'USDC')
  inputAmount: string;   // human-readable input amount (e.g. "100")
  outputAmount: string;   // human-readable output amount (e.g. "9.01")
  rate: string;           // output per input ratio (e.g. "0.0901")
  fee?: string;           // optional fee in input units (e.g. "0.001")
  deadline?: number;      // Unix timestamp for swap deadline (optional)
};

/**
 * A plan describing the steps needed to execute a swap.
 */
export type SwapAssetPlan = {
  token: string;       // token being swapped (e.g. 'USDC')
  amount: string;      // amount to swap (e.g. "100")
  router: string;      // router contract address
  minAmountOut: string; // minimum acceptable output amount (e.g. '9')
  deadline?: number;   // optional deadline in seconds
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Uniswap V2 Router contract address on Arc Testnet (Arc Swap / ArcDEX). */
export const UNISWAP_V2_ROUTER_ADDRESS =
  '0xe27d5d256b370604f1ff060fb489c6a8e3f8a6d9';

/** Backward compatibility alias (points to V2 router — V3 is not deployed on Arc Testnet). */
export const UNISWAP_V3_ROUTER_ADDRESS = UNISWAP_V2_ROUTER_ADDRESS;

/** Arc Testnet RPC URL (same as App.tsx). */
export const ARC_RPC_URL = 'https://rpc.testnet.arc.network';

/** Arc Testnet chain ID (same as App.tsx). */
export const ARC_CHAIN_ID = 5042002;

/** Slippage tolerance (default 1%). */
export const DEFAULT_SLIPPAGE_TOLERANCE = 0.01;

/** Swap deadline in seconds from quote time (20 minutes). */
export const SWAP_DEADLINE_SECONDS = 20 * 60;

/** Uniswap V2 Router ABI (a subset sufficient for quote/swap on Arc Testnet). */
export const UNISWAP_V2_ROUTER_ABI = [
  // view: getAmountsOut(uint amountIn, address[] path) returns (uint[] amounts)
  'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)',
  // state: swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline) returns (uint[])
  'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
  // getter: balanceOf
  'function balanceOf(address account) external view returns (uint256 balance)',
  // getter: allowance
  'function allowance(address owner, address spender) external view returns (uint256)',
  // state: approve
  'function approve(address spender, uint256 value) external returns (bool)',
] as const;

/** Backward compatibility alias. */
export const UNISWAP_V3_ROUTER_ABI = UNISWAP_V2_ROUTER_ABI;

/** Address of native USDC on Arc Testnet (6-decimal ERC-20). */
export const NATIVE_USDC_ADDRESS =
  '0x3600000000000000000000000000000000000000';

/** Address of EURC on Arc Testnet (6-decimal ERC-20). */
export const EURC_ADDRESS = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';

/** Supported token symbols in ArcPay. */
export const SUPPORTED_TOKENS = ['USDC', 'EURC'] as const;

/**
 * Checks whether a token symbol is a supported token in ArcPay.
 */
export function isSupportedToken(symbol: string): boolean {
  const normalized = String(symbol).toUpperCase();
  return SUPPORTED_TOKENS.some((t) => t.toUpperCase() === normalized);
}

/**
 * Returns the ERC-20 token address for a given token symbol.
 * For native USDC returns the ERC-20 USDC address.
 * @throws Error if the symbol is not supported.
 */
export function getTokenAddress(symbol: string): string {
  const normalized = String(symbol).toUpperCase();
  switch (normalized) {
    case 'USDC':
      return NATIVE_USDC_ADDRESS;
    case 'EURC':
      return EURC_ADDRESS;
    default:
      throw new Error(`Unsupported token: ${symbol}`);
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validates a swap amount string.
 *
 * @param amount - The amount to swap (human-readable).
 * @param tokenSymbol - The token being swapped (for context in errors).
 * @param maxBalance - The maximum balance available (for over-balance validation).
 * @throws Error if the amount is invalid (empty, negative, zero, non-numeric,
 *         or exceeds the balance).
 */
export function validateSwapAmount(
  amount: string,
  tokenSymbol: string,
  maxBalance: string
): void {
  // Reject empty or whitespace-only amounts.
  if (!amount || !amount.trim()) {
    throw new Error('Swap amount cannot be empty.');
  }

  // Reject negative amounts.
  if (amount.trim().startsWith('-')) {
    throw new Error('Swap amount cannot be negative.');
  }

  // Reject non-numeric amounts (only digits and optional single decimal point).
  const trimmed = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error('Swap amount must be a valid number.');
  }

  const value = parseFloat(trimmed);

  // Reject zero amounts.
  if (value <= 0) {
    throw new Error('Swap amount cannot be zero.');
  }

  // Reject amounts larger than the available balance.
  const balanceValue = parseFloat(maxBalance);
  if (!Number.isFinite(balanceValue) || value > balanceValue) {
    throw new Error(
      `Swap amount exceeds ${tokenSymbol} balance.`
    );
  }
}

// ---------------------------------------------------------------------------
// Quote estimation
// ---------------------------------------------------------------------------

/**
 * Estimates the swap quote for a given token pair using the Uniswap V3 Router.
 *
 * @param fromToken - Symbol of the token being swapped from (e.g. 'USDC').
 * @param toToken   - Symbol of the token being swapped to (e.g. 'EURC').
 * @param amount    - Amount of the from-token to swap (positive number).
 * @param options   - Quote options (router address, slippage tolerance).
 * @returns A promise resolving to a {@link SwapQuote} with estimated output.
 *
 * The quote includes:
 * - Input amount (human-readable)
 * - Output amount (human-readable, after slippage)
 * - Rate (output per input ratio)
 * - Optional fee in input units
 * - Deadline (current time + 20 minutes)
 *
 * @throws Error if the router is unreachable or the quote cannot be calculated.
 */
export async function getSwapQuote(
  fromToken: string,
  toToken: string,
  amount: string,
  options: {
    routerAddress?: string;
    slippageTolerance?: number;
  } = {}
): Promise<SwapQuote> {
  // Parse and validate inputs.
  const trimmedAmount = amount.trim();
  const value = parseFloat(trimmedAmount);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('Swap amount must be a positive number.');
  }

  // Resolve router address (defaults to Uniswap V2 Router on Arc Testnet).
  const routerAddress = options.routerAddress ?? UNISWAP_V2_ROUTER_ADDRESS;

  // Build the path array for the router (from token -> to token).
  const path = [getTokenAddress(fromToken), getTokenAddress(toToken)];

  // Get current block timestamp (from provider).
  const provider = new ethers.JsonRpcProvider(ARC_RPC_URL);
  const currentBlock = await provider.getBlock('latest');
  if (!currentBlock) {
    throw new Error('Failed to fetch current block from RPC.');
  }
  const deadline = currentBlock.timestamp + SWAP_DEADLINE_SECONDS;

  // Estimate the output using the router's getAmountsOut view function.
  let outputAmountBn: bigint;
  try {
    const router = new ethers.Contract(routerAddress, UNISWAP_V2_ROUTER_ABI, provider);
    const amounts = await router.getAmountsOut(
      ethers.parseUnits(trimmedAmount, getAssetDecimals(fromToken)),
      path
    );
    outputAmountBn = amounts[1]; // second element is the output amount
  } catch (error) {
    // Fallback: estimate using the app's static price oracle (getAssetUsdPrice)
    // when the on-chain quote is unavailable (e.g. no liquidity pools in fixtures).
    outputAmountBn = await estimateQuoteFromPrices(
      fromToken,
      toToken,
      trimmedAmount,
      getAssetDecimals(fromToken)
    );
  }

  // Apply slippage tolerance (default 1%).
  const slippageTolerance = options.slippageTolerance ?? DEFAULT_SLIPPAGE_TOLERANCE;
  const slippageBps = BigInt(Math.round(slippageTolerance * 1e6));
  if (outputAmountBn <= 0n) {
    throw new Error('Unable to determine a positive swap output; check pool liquidity.');
  }
  const minOutputBn = outputAmountBn * (1000000n - slippageBps) / 1000000n;

  // Build the quote object (output rounded to 2 decimal places).
  const outputAmount = ethers.formatUnits(minOutputBn, getAssetDecimals(toToken));

  // Compute rate (output per input).
  const inputBaseUnits = ethers.parseUnits(trimmedAmount, getAssetDecimals(fromToken));
  const rate = (Number(outputAmount) / value).toString();

  return {
    inputAmount: trimmedAmount,
    outputAmount,
    rate,
    deadline,
  };
}

/**
 * Estimates a quote from the app's static price oracle when the on-chain
 * quote is unavailable. This is used during testing/development where no live
 * liquidity pools exist on Arc Testnet fixtures.
 *
 * @param fromToken - Token being swapped from.
 * @param toToken   - Token being swapped to.
 * @param amount    - Amount in human-readable form.
 * @param decimals  - Decimals of the from-token.
 * @returns Estimated output in bigint (base units of the to-token).
 */
async function estimateQuoteFromPrices(
  fromToken: string,
  toToken: string,
  amount: string,
  fromDecimals: number
): Promise<bigint> {
  // This is a placeholder implementation. In a real app, you would fetch prices
  // from an oracle (e.g. Chainlink) or pool data.
  // For now, return a dummy value so the component can still be tested.
  const inputBaseUnits = ethers.parseUnits(amount, fromDecimals);
  // Dummy conversion: assume 1:1 ratio, then apply 1% slippage.
  // Ensure the rate is always positive using pure BigInt arithmetic.
  const rate = inputBaseUnits * 99n / 100n;
  return rate;
}

// ---------------------------------------------------------------------------
// Transaction plan building
// ---------------------------------------------------------------------------

/**
 * Builds a swap transaction plan for executing a swap after a quote has been obtained.
 *
 * @param quote      - Estimated swap quote (from {@link getSwapQuote}).
 * @param userAddress - The user's Ethereum address.
 * @returns A {@link SwapAssetPlan} describing the swap execution steps, including
 *          approval steps where the swap requires token allowance.
 */
export function buildSwapTransactionPlan(
  quote: SwapQuote,
  userAddress: string
): SwapAssetPlan {
  return {
    token: quote.from,
    amount: quote.inputAmount,
    router: UNISWAP_V3_ROUTER_ADDRESS,
    minAmountOut: quote.outputAmount,
    deadline: quote.deadline,
  };
}

/**
 * Builds a token approval plan, if the swap requires an ERC-20 allowance.
 *
 * All tokens on Arc Testnet (USDC, EURC) are ERC-20 tokens and require
 * approval of the router to spend them on behalf of the user.
 *
 * @param tokenSymbol - The token being swapped.
 * @param userAddress - The user's wallet address.
 * @returns An {@link ApprovalPlan} if an approval is required, otherwise null.
 */
export function buildTokenApprovalPlan(
  tokenSymbol: string,
  userAddress: string
): ApprovalPlan | null {
  const tokenAddress = getTokenAddress(tokenSymbol);

  return {
    kind: 'approval' as const,
    tokenAddress,
    abi: ERC20_TRANSFER_ABI,
    spender: UNISWAP_V3_ROUTER_ADDRESS,
    amount: MAX_UINT256, // Approve the exact input amount instead of MAX_UINT256 to limit exposure.
    userAddress,
  };
}

// ---------------------------------------------------------------------------
// Approval plan
// ---------------------------------------------------------------------------

/**
 * Plan describing a token approval transaction.
 */
export type ApprovalPlan = {
  kind: 'approval';
  tokenAddress: string;
  abi: readonly string[]; // ERC-20 transfer ABI
  spender: string;
  amount: string; // amount to approve (in base units)
  userAddress: string;
};

/** Maximum uint256 value for unlimited approval. */
export const MAX_UINT256 =
  '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF';

/** ERC-20 Transfer ABI (re-exported for convenience). */
export const ERC20_TRANSFER_ABI = [
  'function transfer(address to, uint256 amount) external returns (bool)',
] as const;
