import { describe, expect, it } from 'vitest';
import {
  applyOptimisticAssetDecrement,
  createOptimisticSendUpdate,
  decrementDisplayedBalance,
  mergeFetchedTransactions,
  reconcileOptimisticTransaction,
  type TransactionHistoryItem,
} from './App';

const SENDER = '0x1111111111111111111111111111111111111111';
const RECIPIENT = '0x2222222222222222222222222222222222222222';
const EURC_ADDRESS = '0x3333333333333333333333333333333333333333';
const NATIVE_TX_HASH = '0x9fdb3416d883d9a689d0488ddbbd697808fd012c1a6058eb87a78f8bb957e1ef';
const EURC_TX_HASH = '0xd5f5f93bbd8fc3c2fa3f4c21be731d1811efa8b7e0868803b4fa151053e5a366';

describe('decrementDisplayedBalance', () => {
  it('subtracts on the same decimals basis as the displayed balance (6-decimal USDC token display)', () => {
    expect(decrementDisplayedBalance('100.000025', '0.000025', 6)).toBe('100');
  });

  it('handles the 18-decimal native USDC basis without mixing bases', () => {
    // The raw send used ethers.parseUnits(amount, 18); the displayed string is
    // also formatted from that same 18-decimal basis, so subtraction matches.
    expect(decrementDisplayedBalance('10.5', '1.5', 18)).toBe('9');
    expect(decrementDisplayedBalance('10.5', '0.000000000000000001', 18)).toBe('10.499999999999999999');
  });

  it('clamps at zero instead of showing a negative balance', () => {
    expect(decrementDisplayedBalance('1', '2', 6)).toBe('0');
  });
});

describe('optimistic native USDC send (plan.kind === "native")', () => {
  const assetBalances = [{ key: 'native-usdc', symbol: 'USDC', balance: '10.5', decimals: 18 }];
  const result = createOptimisticSendUpdate({
    hash: NATIVE_TX_HASH,
    from: SENDER,
    to: RECIPIENT,
    assetKey: 'native-usdc',
    symbol: 'USDC',
    amount: '1.5',
    decimals: 18,
    balance: '10.5',
    assetBalances,
    tokenAssets: [],
  });

  it('synthesizes a confirming history item with the tx hash before any explorer poll runs', () => {
    expect(result.historyItem).toMatchObject({
      hash: NATIVE_TX_HASH,
      status: 'confirming',
      direction: 'sent',
      tokenSymbol: 'USDC',
      from: SENDER,
      to: RECIPIENT,
      value: '1.5',
      decimals: 18,
    });
    expect(result.historyItem.timestamp).toBeGreaterThan(0);
  });

  it('decrements the displayed balances immediately by the sent amount on the matching basis', () => {
    expect(result.nextAssetBalances[0].balance).toBe('9');
    expect(result.nextBalance).toBe('9');
  });

  it('snapshots the exact pre-send values so a revert can restore them verbatim', () => {
    expect(result.snapshot.balance).toBe('10.5');
    expect(result.snapshot.assetBalances).toEqual(assetBalances);
    expect(result.snapshot.tokenAssets).toEqual([]);
  });

  it('matches both native USDC state keys ("usdc" default and "native-usdc" refreshed)', () => {
    const next = applyOptimisticAssetDecrement(
      [
        { key: 'usdc', symbol: 'USDC', balance: '4', decimals: 18 },
        { key: 'native-usdc', symbol: 'USDC', balance: '4', decimals: 18 },
        { key: EURC_ADDRESS, symbol: 'EURC', balance: '7', decimals: 6 },
      ],
      ['usdc', 'native-usdc'],
      '1.5',
    );
    expect(next[0].balance).toBe('2.5');
    expect(next[1].balance).toBe('2.5');
    expect(next[2].balance).toBe('7');
  });
});

describe('optimistic ERC-20 (EURC) send', () => {
  const tokenAssets = [{ key: EURC_ADDRESS, symbol: 'EURC', balance: '2.5', decimals: 6 }];
  const result = createOptimisticSendUpdate({
    hash: EURC_TX_HASH,
    from: SENDER,
    to: RECIPIENT,
    assetKey: EURC_ADDRESS,
    symbol: 'EURC',
    amount: '2.5',
    decimals: 6,
    balance: '12',
    assetBalances: [],
    tokenAssets,
  });

  it('synthesizes a confirming history item using the token decimals', () => {
    expect(result.historyItem).toMatchObject({
      hash: EURC_TX_HASH,
      status: 'confirming',
      direction: 'sent',
      tokenSymbol: 'EURC',
      value: '2.5',
      decimals: 6,
    });
  });

  it('decrements the token balance immediately and leaves the native balance untouched', () => {
    expect(result.nextTokenAssets[0].balance).toBe('0');
    expect(result.nextBalance).toBe('12');
  });

  it('snapshots the exact pre-send token list for rollback', () => {
    expect(result.snapshot.tokenAssets).toEqual(tokenAssets);
  });
});

describe('confirmation path (explorer returns status ok for the hash)', () => {
  const optimistic = createOptimisticSendUpdate({
    hash: NATIVE_TX_HASH,
    from: SENDER,
    to: RECIPIENT,
    assetKey: 'native-usdc',
    symbol: 'USDC',
    amount: '1.5',
    decimals: 18,
    balance: '10.5',
    assetBalances: [{ key: 'native-usdc', symbol: 'USDC', balance: '10.5', decimals: 18 }],
    tokenAssets: [],
  });

  const realItem: TransactionHistoryItem = {
    hash: NATIVE_TX_HASH,
    from: SENDER,
    to: RECIPIENT,
    value: '1.5',
    tokenSymbol: 'USDC',
    decimals: 18,
    timestamp: 1756160000000,
    direction: 'sent',
    status: 'ok',
  };

  it("flips the synthesized item from 'confirming' to 'ok' keeping its other fields", () => {
    const [reconciled] = reconcileOptimisticTransaction([optimistic.historyItem], NATIVE_TX_HASH, 'ok');
    expect(reconciled.status).toBe('ok');
    expect(reconciled.hash).toBe(NATIVE_TX_HASH);
    expect(reconciled.value).toBe('1.5');
  });

  it('does not duplicate once refreshTransactionHistory returns the real record', () => {
    const merged = mergeFetchedTransactions([optimistic.historyItem], [realItem]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual(realItem);
  });

  it('keeps the optimistic balance decrement as-is on confirmation', () => {
    // The snapshot stays unused on this path; decremented values stand until
    // the next refreshBalance confirms them on-chain.
    expect(optimistic.nextBalance).toBe('9');
    expect(optimistic.snapshot.balance).toBe('10.5');
  });
});

describe('revert path (explorer returns status error for the hash)', () => {
  const optimistic = createOptimisticSendUpdate({
    hash: EURC_TX_HASH,
    from: SENDER,
    to: RECIPIENT,
    assetKey: EURC_ADDRESS,
    symbol: 'EURC',
    amount: '2.5',
    decimals: 6,
    balance: '12',
    assetBalances: [{ key: EURC_ADDRESS, symbol: 'EURC', balance: '2.5', decimals: 6 }],
    tokenAssets: [{ key: EURC_ADDRESS, symbol: 'EURC', balance: '2.5', decimals: 6 }],
  });

  // Rollback exactly as rollbackOptimisticSend does in the component:
  // reapply the verbatim snapshot instead of recomputing.
  const restored = optimistic.snapshot;

  it('restores the exact pre-send balance values (no recomputation drift)', () => {
    expect(restored.tokenAssets[0].balance).toBe('2.5');
    expect(restored.assetBalances[0].balance).toBe('2.5');
    expect(restored.balance).toBe('12');
    // ...which differs from the optimistically decremented values.
    expect(optimistic.nextTokenAssets[0].balance).toBe('0');
  });

  it("marks the synthesized item as 'error' rather than removing it", () => {
    const reconciled = reconcileOptimisticTransaction([optimistic.historyItem], EURC_TX_HASH, 'error');
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0].status).toBe('error');
    expect(reconciled[0].hash).toBe(EURC_TX_HASH);
  });
});

describe('dedupe during mid-flight explorer refreshes', () => {
  const optimisticA = createOptimisticSendUpdate({
    hash: NATIVE_TX_HASH,
    from: SENDER,
    to: RECIPIENT,
    assetKey: 'native-usdc',
    symbol: 'USDC',
    amount: '1.5',
    decimals: 18,
    balance: '10.5',
    assetBalances: [],
    tokenAssets: [],
  }).historyItem;

  const olderConfirmed: TransactionHistoryItem = {
    hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    from: '0x4444444444444444444444444444444444444444',
    to: SENDER,
    value: '3',
    tokenSymbol: 'USDC',
    decimals: 18,
    timestamp: 1756159000000,
    direction: 'received',
    status: 'ok',
  };

  it('keeps pinning a still-confirming item the explorer does not know about yet', () => {
    const merged = mergeFetchedTransactions([optimisticA], [olderConfirmed]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toEqual(optimisticA);
    expect(merged[1]).toEqual(olderConfirmed);
  });

  it('drops the optimistic copy once the explorer returns the real record for the hash', () => {
    const realRecord: TransactionHistoryItem = { ...optimisticA, timestamp: 1756160000000, status: 'ok' };
    const merged = mergeFetchedTransactions([optimisticA], [realRecord, olderConfirmed]);
    expect(merged.filter((tx) => tx.hash === NATIVE_TX_HASH)).toHaveLength(1);
    expect(merged.find((tx) => tx.hash === NATIVE_TX_HASH)).toEqual(realRecord);
  });

  it('compares hashes case-insensitively', () => {
    const checksummedRecord: TransactionHistoryItem = { ...optimisticA, hash: NATIVE_TX_HASH.toUpperCase(), status: 'ok' };
    const merged = mergeFetchedTransactions([optimisticA], [checksummedRecord]);
    expect(merged).toHaveLength(1);
  });

  it('never touches non-confirming items when merging', () => {
    const pendingItem: TransactionHistoryItem = { ...olderConfirmed, status: 'pending' };
    const merged = mergeFetchedTransactions([pendingItem], []);
    expect(merged).toEqual([pendingItem]);
  });
});


