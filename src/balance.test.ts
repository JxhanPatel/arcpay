import { describe, expect, it } from 'vitest';
import { filterNonZeroAssetBalances, formatDisplayBalance, formatTokenBalance } from './balance';

describe('formatTokenBalance', () => {
  it('formats USDC balances from raw token units', () => {
    expect(formatTokenBalance(20_000_000n, 6)).toBe('20');
    expect(formatTokenBalance(1_234_567n, 6)).toBe('1.234567');
  });
});

describe('formatDisplayBalance', () => {
  it('rounds balances to two visible decimals for mobile display', () => {
    expect(formatDisplayBalance('18.901234')).toBe('18.90');
    expect(formatDisplayBalance('20')).toBe('20.00');
    expect(formatDisplayBalance('0')).toBe('0.00');
  });
});

describe('filterNonZeroAssetBalances', () => {
  it('keeps only assets with a positive balance', () => {
    const assets = [
      { key: 'arc', symbol: 'ARC', balance: '0' },
      { key: 'usdc', symbol: 'USDC', balance: '20' },
      { key: 'usdt', symbol: 'USDT', balance: '0.000000' },
    ];

    expect(filterNonZeroAssetBalances(assets)).toEqual([{ key: 'usdc', symbol: 'USDC', balance: '20' }]);
  });
});
