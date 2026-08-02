export type AssetBalance = {
  key: string;
  symbol: string;
  balance: string;
  decimals?: number;
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

  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
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
  return assets.filter((asset) => {
    const normalized = Number(asset.balance);
    return Number.isFinite(normalized) && normalized > 0;
  });
};
