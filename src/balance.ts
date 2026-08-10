export type AssetBalance = {
  key: string;
  symbol: string;
  balance: string;
  decimals?: number;
};

export type NativeBalance = {
  address: string;
  coinBalance: bigint;
  coinBalanceFormatted: string;
  decimals: number;
  updatedAt: number;
};

export type TokenBalance = {
  address: string;
  tokenAddress: string;
  symbol: string;
  balance: bigint;
  balanceFormatted: string;
  decimals: number;
};

const isObjectRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const toBigInt = (value: unknown) => {
  if (typeof value === 'bigint') {
    return value;
  }

  const rawValue = String(value ?? '0').trim();
  if (!rawValue) {
    return 0n;
  }

  if (/^0x[0-9a-fA-F]+$/.test(rawValue)) {
    return BigInt(rawValue);
  }

  return BigInt(rawValue);
};

export const isStableUsdPegged = (symbol?: string) => {
  const normalized = String(symbol ?? '').toUpperCase();
  return normalized === 'USDC' || normalized === 'EURC';
};

export const getAssetDecimals = (symbol?: string) => {
  const normalized = String(symbol ?? '').toUpperCase();
  if (isStableUsdPegged(symbol)) {
    return 6;
  }

  if (normalized === 'CIRBTC') {
    return 8;
  }

  return 18;
};

export const parseTransactionDirection = (walletAddress: string, from: string, to: string) => {
  const normalizedWallet = String(walletAddress ?? '').toLowerCase();
  const normalizedFrom = String(from ?? '').toLowerCase();
  const normalizedTo = String(to ?? '').toLowerCase();

  if (normalizedFrom === normalizedWallet) {
    return 'sent';
  }

  if (normalizedTo === normalizedWallet) {
    return 'received';
  }

  return 'sent';
};

export const getTransactionDisplayMeta = (transaction: Record<string, unknown>) => {
  const tokenPayload = isObjectRecord(transaction.token) ? transaction.token : null;
  const tokenTransfers = Array.isArray(transaction.token_transfers)
    ? transaction.token_transfers.filter(isObjectRecord)
    : [];
  const firstTransfer = tokenTransfers[0] ?? null;
  const firstTransferTotal = isObjectRecord(firstTransfer?.total) ? firstTransfer.total : null;
  const transactionTotal = isObjectRecord(transaction.total) ? transaction.total : null;
  const transferToken = isObjectRecord(firstTransfer?.token) ? firstTransfer.token : null;
  const tokenIsPresent = Object.prototype.hasOwnProperty.call(transaction, 'token');
  const hasTokenPayload = tokenIsPresent && tokenPayload !== null;
  const isNativeTransfer = !hasTokenPayload && tokenTransfers.length === 0;

  if (isNativeTransfer) {
    const nativeValue = String(transaction.value ?? transaction.amount ?? '0');
    const rawValue = toBigInt(nativeValue);
    return {
      symbol: 'USDC',
      decimals: 18,
      rawValue,
    };
  }

  const transferSymbol = String(
    transferToken?.symbol
      ?? firstTransfer?.symbol
      ?? tokenPayload?.symbol
      ?? 'TOKEN',
  );
  const transferDecimals = Number(
    transferToken?.decimals
      ?? firstTransfer?.decimals
      ?? tokenPayload?.decimals
      ?? getAssetDecimals(transferSymbol),
  );
  const transferValueCandidates = [
    firstTransferTotal?.value,
    firstTransfer?.value,
    transactionTotal?.value,
    transaction.amount,
    transaction.value,
  ];
  const transferValue = String(
    transferValueCandidates.find((candidate) => {
      const normalized = String(candidate ?? '').trim();
      if (!normalized) {
        return false;
      }

      return toBigInt(normalized) !== 0n;
    }) ?? '0',
  );
  const rawValue = toBigInt(transferValue);
  const normalizedAmount = Number(formatTokenBalance(rawValue, Number.isFinite(transferDecimals) ? transferDecimals : getAssetDecimals(transferSymbol)));

  if (Number.isFinite(normalizedAmount) && Math.abs(normalizedAmount) > 1_000_000) {
    console.warn('[arcpay:tx-display-meta] suspicious amount detected', {
      transaction,
      symbol: transferSymbol,
      decimals: Number.isFinite(transferDecimals) ? transferDecimals : getAssetDecimals(transferSymbol),
      rawValue: transferValue,
      normalizedAmount,
    });
  }

  return {
    symbol: transferSymbol,
    decimals: Number.isFinite(transferDecimals) ? transferDecimals : getAssetDecimals(transferSymbol),
    rawValue,
  };
};

export const formatTokenBalance = (rawBalance: bigint, decimals: number) => {
  const scale = 10n ** BigInt(decimals);
  const whole = rawBalance / scale;
  const fraction = rawBalance % scale;

  if (fraction === 0n) {
    return whole.toString();
  }

  const fractionString = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole}.${fractionString}`;
};

export const formatDisplayBalance = (balance: string | number) => {
  const numericValue = Number.parseFloat(String(balance));
  if (!Number.isFinite(numericValue)) {
    return '0.00';
  }

  if (numericValue === 0) {
    return '0.00';
  }

  // For small nonzero balances, preserve enough precision to avoid rounding to zero.
  // Use up to 8 decimal places, but at least 2.
  const absValue = Math.abs(numericValue);
  let fractionDigits = 2;
  if (absValue > 0 && absValue < 0.01) {
    // Find enough digits to show the first significant digit
    const decimalStr = absValue.toFixed(8);
    const match = decimalStr.match(/^0\.0*(\d)/);
    if (match) {
      const leadingZeros = match[0].length - 2; // subtract "0."
      fractionDigits = Math.min(8, leadingZeros + 1);
    }
  }

  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: fractionDigits,
  }).format(numericValue);
};

export const buildRequestLink = (id: string, amount: string, note = '') => {
  const normalizedId = id.trim();
  const normalizedAmount = amount.trim();
  const normalizedNote = note.trim();

  if (!normalizedId || !normalizedAmount) {
    return '';
  }

  const baseLink = `arcpay://request?id=${normalizedId}&amount=${normalizedAmount}`;
  if (!normalizedNote) {
    return baseLink;
  }

  return `${baseLink}&note=${encodeURIComponent(normalizedNote)}`;
};

export const filterNonZeroAssetBalances = (assets: AssetBalance[]) => {
  const nonZeroAssets = assets.filter((asset) => {
    const normalized = Number(asset.balance);
    return Number.isFinite(normalized) && normalized > 0;
  });

  return nonZeroAssets.sort((left, right) => {
    if (left.symbol === 'USDC') {
      return -1;
    }
    if (right.symbol === 'USDC') {
      return 1;
    }
    return 0;
  });
};

export const parseNativeBalance = (
  payload: Record<string, unknown>,
  address: string,
): NativeBalance | null => {
  const coinBalanceRaw = payload.coin_balance;
  if (!coinBalanceRaw) {
    return null;
  }

  const coinBalance = toBigInt(coinBalanceRaw);
  const decimals = 18; // Native USDC on Arc uses 18 decimals
  const coinBalanceFormatted = formatTokenBalance(coinBalance, decimals);

  return {
    address,
    coinBalance,
    coinBalanceFormatted,
    decimals,
    updatedAt: Date.now(),
  };
};

export const parseTokenBalances = (
  payload: Array<Record<string, unknown>>,
  address: string,
): TokenBalance[] => {
  if (!Array.isArray(payload)) {
    return [];
  }

  return payload
    .filter((item) => {
      const token = isObjectRecord(item.token) ? item.token : null;
      return token?.symbol && item.value;
    })
    .map((item) => {
      const token = isObjectRecord(item.token) ? item.token : {};
      const rawSymbol = token.symbol;
      const symbol = typeof rawSymbol === 'string' ? rawSymbol : 'TOKEN';
      const decimals = Number(token.decimals ?? getAssetDecimals(symbol));
      const balance = toBigInt(item.value ?? '0');
      const balanceFormatted = formatTokenBalance(balance, Number.isFinite(decimals) ? decimals : getAssetDecimals(symbol));
      const tokenAddress = String(token.address_hash ?? symbol);

      return {
        address,
        tokenAddress,
        symbol,
        balance,
        balanceFormatted,
        decimals: Number.isFinite(decimals) ? decimals : getAssetDecimals(symbol),
      };
    });
};
