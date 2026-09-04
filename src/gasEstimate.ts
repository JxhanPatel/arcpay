import { ethers } from 'ethers';
import { formatTokenBalance } from './balance';

const GAS_FEE_DECIMALS = 18;

/**
 * Multiply gasLimit by gasPrice and format the product as an 18-decimal USDC
 * string.  Pure — no provider calls, safe to unit-test offline.
 */
export const formatGasFeeUsdc = (gasLimit: bigint, gasPrice: bigint): string => {
  const fee = gasLimit * gasPrice;
  return formatTokenBalance(fee, GAS_FEE_DECIMALS);
};

/**
 * Decide whether to render a "Total" row on the send review screen and, if so,
 * compute the bigint-safe sum of the sent amount and the estimated fee.
 *
 * Both `sentAmount` and `estimatedFeeUsdc` are human-readable display strings
 * denominated at 18 decimals (Arc's native USDC gas token basis).
 */
export const buildFeeSummary = (params: {
  sentAmount: string;
  sentSymbol: string;
  estimatedFeeUsdc: string | null;
}): { showTotal: boolean; total: string | null } => {
  const { sentAmount, sentSymbol, estimatedFeeUsdc } = params;

  if (sentSymbol !== 'USDC' || estimatedFeeUsdc === null) {
    return { showTotal: false, total: null };
  }

  try {
    const sentRaw = ethers.parseUnits(sentAmount, GAS_FEE_DECIMALS);
    const feeRaw = ethers.parseUnits(estimatedFeeUsdc, GAS_FEE_DECIMALS);
    const totalRaw = sentRaw + feeRaw;

    return {
      showTotal: true,
      total: formatTokenBalance(totalRaw, GAS_FEE_DECIMALS),
    };
  } catch {
    return { showTotal: false, total: null };
  }
};
