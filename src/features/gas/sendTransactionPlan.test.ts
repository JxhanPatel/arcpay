import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { buildSendTransactionPlan, ERC20_TRANSFER_ABI } from './App';

describe('buildSendTransactionPlan', () => {
  it('uses a native value transaction for USDC', () => {
    const plan = buildSendTransactionPlan(
      { key: 'usdc', symbol: 'USDC', balance: '1', decimals: 6 },
      '0x1111111111111111111111111111111111111111',
      '1.5',
    );

    expect(plan.kind).toBe('native');
    if (plan.kind !== 'native') {
      throw new Error('Expected native plan.');
    }
    expect(plan.tx).toEqual({
      to: '0x1111111111111111111111111111111111111111',
      value: ethers.parseUnits('1.5', 18),
    });
  });

  it('uses an ERC-20 transfer for non-USDC assets when the token address is present', () => {
    const plan = buildSendTransactionPlan(
      {
        key: '0x2222222222222222222222222222222222222222',
        symbol: 'EURC',
        balance: '2',
        decimals: 6,
      },
      '0x3333333333333333333333333333333333333333',
      '2.5',
    );

    expect(plan.kind).toBe('token');
    if (plan.kind !== 'token') {
      throw new Error('Expected token plan.');
    }
    expect(plan.tokenAddress).toBe('0x2222222222222222222222222222222222222222');
    expect(plan.abi).toEqual(ERC20_TRANSFER_ABI);
    expect(plan.args).toEqual([
      '0x3333333333333333333333333333333333333333',
      ethers.parseUnits('2.5', 6),
    ]);
  });

  it('throws a clear error when a non-USDC asset has no usable token contract address', () => {
    expect(() =>
      buildSendTransactionPlan(
        { key: 'not-an-address', symbol: 'EURC', balance: '2', decimals: 6 },
        '0x3333333333333333333333333333333333333333',
        '2.5',
      ),
    ).toThrow('Unable to determine the EURC contract address.');
  });
});
