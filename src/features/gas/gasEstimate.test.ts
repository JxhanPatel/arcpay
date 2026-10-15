import { describe, expect, it } from 'vitest';
import { formatGasFeeUsdc, buildFeeSummary } from './gasEstimate';

describe('formatGasFeeUsdc', () => {
  it('formats a standard 21 000 gas × 20 gwei fee as an 18-decimal USDC string', () => {
    // 21000 * 20_000_000_000 = 420_000_000_000_000
    // 420_000_000_000_000 / 10^18 = 0.00042
    const result = formatGasFeeUsdc(21000n, 20_000_000_000n);
    expect(result).toBe('0.00042');
  });

  it('returns "0" when the gas limit is zero', () => {
    expect(formatGasFeeUsdc(0n, 20_000_000_000n)).toBe('0');
  });

  it('returns "0" when the gas price is zero', () => {
    expect(formatGasFeeUsdc(21000n, 0n)).toBe('0');
  });

  it('handles large gas limits without overflow', () => {
    // 1_000_000 gas * 100 gwei = 100_000_000_000_000_000 = 0.1 USDC (18 dec)
    const result = formatGasFeeUsdc(1_000_000n, 100_000_000_000n);
    expect(result).toBe('0.1');
  });

  it('preserves fractional precision', () => {
    // 21000 * 1_000_000_000 = 21_000_000_000_000
    // 21_000_000_000_000 / 10^18 = 0.000021
    const result = formatGasFeeUsdc(21000n, 1_000_000_000n);
    expect(result).toBe('0.000021');
  });
});

describe('buildFeeSummary', () => {
  it('returns showTotal true with the correct sum when symbol is USDC and fee is present', () => {
    const result = buildFeeSummary({
      sentAmount: '1.5',
      sentSymbol: 'USDC',
      estimatedFeeUsdc: '0.00042',
    });

    expect(result.showTotal).toBe(true);
    expect(result.total).toBe('1.50042');
  });

  it('returns showTotal false when symbol is not USDC', () => {
    const result = buildFeeSummary({
      sentAmount: '10',
      sentSymbol: 'EURC',
      estimatedFeeUsdc: '0.00042',
    });

    expect(result.showTotal).toBe(false);
    expect(result.total).toBeNull();
  });

  it('returns showTotal false when symbol is cirBTC even with a fee', () => {
    const result = buildFeeSummary({
      sentAmount: '0.001',
      sentSymbol: 'cirBTC',
      estimatedFeeUsdc: '0.00042',
    });

    expect(result.showTotal).toBe(false);
    expect(result.total).toBeNull();
  });

  it('returns showTotal false when estimatedFeeUsdc is null even for USDC', () => {
    const result = buildFeeSummary({
      sentAmount: '5',
      sentSymbol: 'USDC',
      estimatedFeeUsdc: null,
    });

    expect(result.showTotal).toBe(false);
    expect(result.total).toBeNull();
  });

  it('uses bigint arithmetic to avoid floating-point drift', () => {
    // 0.1 + 0.2 in IEEE-754 = 0.30000000000000004
    // BigInt addition must produce exactly "0.3"
    const result = buildFeeSummary({
      sentAmount: '0.1',
      sentSymbol: 'USDC',
      estimatedFeeUsdc: '0.2',
    });

    expect(result.showTotal).toBe(true);
    expect(result.total).toBe('0.3');
  });

  it('handles very small fee values correctly', () => {
    const result = buildFeeSummary({
      sentAmount: '100',
      sentSymbol: 'USDC',
      estimatedFeeUsdc: '0.000000000000000001',
    });

    expect(result.showTotal).toBe(true);
    expect(result.total).toBe('100.000000000000000001');
  });

  it('gracefully returns no total when sentAmount is not parseable', () => {
    const result = buildFeeSummary({
      sentAmount: 'not-a-number',
      sentSymbol: 'USDC',
      estimatedFeeUsdc: '0.00042',
    });

    expect(result.showTotal).toBe(false);
    expect(result.total).toBeNull();
  });
});
