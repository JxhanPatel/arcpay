export type AssetBalance = {
  key: string;
  symbol: string;
  balance: string;
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

export const filterNonZeroAssetBalances = (assets: AssetBalance[]) => {
  return assets.filter((asset) => {
    const normalized = Number(asset.balance);
    return Number.isFinite(normalized) && normalized > 0;
  });
};
