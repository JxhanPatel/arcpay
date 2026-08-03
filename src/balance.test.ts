import { describe, expect, it } from 'vitest';
import {
  buildRequestLink,
  filterNonZeroAssetBalances,
  formatDisplayBalance,
  formatTokenBalance,
  getAssetDecimals,
  getTransactionDisplayMeta,
  parseTransactionDirection,
} from './balance';

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

describe('parseTransactionDirection', () => {
  it('classifies wallet-owned outbound transactions as sent and inbound transactions as received', () => {
    expect(parseTransactionDirection('0x1111111111111111111111111111111111111111', '0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222')).toBe('sent');
    expect(parseTransactionDirection('0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222', '0x1111111111111111111111111111111111111111')).toBe('received');
  });

  it('matches addresses case-insensitively', () => {
    expect(parseTransactionDirection('0xAbC1234567890abcdef1234567890abcdef1234', '0xAbC1234567890abcdef1234567890abcdef1234', '0xDEF1234567890abcdef1234567890abcdef1234')).toBe('sent');
    expect(parseTransactionDirection('0xAbC1234567890abcdef1234567890abcdef1234', '0xDEF1234567890abcdef1234567890abcdef1234', '0xabc1234567890abcdef1234567890abcdef1234')).toBe('received');
  });
});

describe('getAssetDecimals', () => {
  it('uses the Arc Pay token precision rules for stable assets', () => {
    expect(getAssetDecimals('USDC')).toBe(6);
    expect(getAssetDecimals('EURC')).toBe(6);
    expect(getAssetDecimals('ARC')).toBe(18);
  });
});

describe('getTransactionDisplayMeta', () => {
  it('formats native transfers as USDC with 6 decimals instead of defaulting to ARC', () => {
    const nativeTx = {
      value: '100000',
      token: null,
      token_transfers: [],
    };

    const meta = getTransactionDisplayMeta(nativeTx as Record<string, unknown>);

    expect(meta.symbol).toBe('USDC');
    expect(meta.decimals).toBe(6);
    expect(formatTokenBalance(meta.rawValue, meta.decimals)).toBe('0.1');
    expect(formatDisplayBalance(formatTokenBalance(meta.rawValue, meta.decimals))).toBe('0.10');
    expect(meta.symbol).not.toBe('ARC');
  });

  it('preserves explicit token symbol and decimals for token transfers', () => {
    const tokenTx = {
      value: '0',
      token: null,
      token_transfers: [
        {
          value: '2500000',
          total: { value: '2500000' },
          token: {
            symbol: 'EURC',
            decimals: 6,
          },
        },
      ],
    };

    const meta = getTransactionDisplayMeta(tokenTx as Record<string, unknown>);

    expect(meta.symbol).toBe('EURC');
    expect(meta.decimals).toBe(6);
    expect(formatTokenBalance(meta.rawValue, meta.decimals)).toBe('2.5');
    expect(meta.symbol).not.toBe('USDC');
  });
});

describe('buildRequestLink', () => {
  it('builds a request deep link with URL-encoded note text and a positive amount', () => {
    expect(buildRequestLink('0x1234567890abcdef1234567890abcdef12345678', '12.50', 'Dinner Split')).toBe(
      'arcpay://request?id=0x1234567890abcdef1234567890abcdef12345678&amount=12.50&note=Dinner%20Split',
    );
  });

  it('omits the note parameter entirely when the note is empty', () => {
    expect(buildRequestLink('0x1234567890abcdef1234567890abcdef12345678', '12.50', '')).toBe(
      'arcpay://request?id=0x1234567890abcdef1234567890abcdef12345678&amount=12.50',
    );
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

  it('keeps USDC first even when the explorer response returns it later in the array', () => {
    const assets = [
      { key: 'arc', symbol: 'ARC', balance: '5' },
      { key: 'eurc', symbol: 'EURC', balance: '2' },
      { key: 'usdc', symbol: 'USDC', balance: '20' },
    ];

    expect(filterNonZeroAssetBalances(assets)).toEqual([
      { key: 'usdc', symbol: 'USDC', balance: '20' },
      { key: 'arc', symbol: 'ARC', balance: '5' },
      { key: 'eurc', symbol: 'EURC', balance: '2' },
    ]);
  });
});
