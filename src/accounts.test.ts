import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AccountMeta,
  ACCOUNTS_META_KEY,
  ACTIVE_ACCOUNT_KEY,
  buildKeystoreKey,
  deriveAccountAtIndex,
  getActiveAccountIndex,
  getNextDerivationIndex,
  getStoredAccountsMeta,
  removeAllAccountData,
  removeAccount,
  renameAccount,
  saveAccountsMeta,
  setActiveAccountIndex,
} from './accounts';

const TEST_MNEMONIC = 'test test test test test test test test test test test junk';

const createStorage = () => {
  const store = new Map<string, string>();

  return {
    getItem: (key: string) => (store.has(key) ? store.get(key) ?? null : null),
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
  } as Storage;
};

describe('deriveAccountAtIndex', () => {
  it('produces deterministic addresses for a given mnemonic and index', () => {
    const first = deriveAccountAtIndex(TEST_MNEMONIC, 0);
    const second = deriveAccountAtIndex(TEST_MNEMONIC, 0);

    expect(first.address).toBe(second.address);
    expect(first.privateKey).toBe(second.privateKey);
  });

  it('produces distinct addresses for different indices', () => {
    const account0 = deriveAccountAtIndex(TEST_MNEMONIC, 0);
    const account1 = deriveAccountAtIndex(TEST_MNEMONIC, 1);
    const account2 = deriveAccountAtIndex(TEST_MNEMONIC, 2);

    expect(account0.address).not.toBe(account1.address);
    expect(account0.address).not.toBe(account2.address);
    expect(account1.address).not.toBe(account2.address);
  });

  it('returns a valid 0x-prefixed private key', () => {
    const result = deriveAccountAtIndex(TEST_MNEMONIC, 0);
    expect(result.privateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });

  it('returns a valid checksummed address', () => {
    const result = deriveAccountAtIndex(TEST_MNEMONIC, 0);
    expect(result.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});

describe('accounts metadata storage', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: createStorage(),
      configurable: true,
    });
  });

  it('returns an empty array when no metadata is stored', () => {
    expect(getStoredAccountsMeta()).toEqual([]);
  });

  it('round-trips account metadata through save and get', () => {
    const accounts: AccountMeta[] = [
      { index: 0, label: 'Account 1', address: '0x1111111111111111111111111111111111111111' },
      { index: 1, label: 'Account 2', address: '0x2222222222222222222222222222222222222222' },
    ];

    saveAccountsMeta(accounts);
    const result = getStoredAccountsMeta();

    expect(result).toEqual(accounts);
  });

  it('returns an empty array for corrupt localStorage data', () => {
    globalThis.localStorage.setItem(ACCOUNTS_META_KEY, '{not-valid-json');
    expect(getStoredAccountsMeta()).toEqual([]);
  });

  it('filters out malformed entries from stored metadata', () => {
    const mixed = [
      { index: 0, label: 'Valid', address: '0x1111111111111111111111111111111111111111' },
      { index: 'bad', label: 'Invalid index', address: '0x2222222222222222222222222222222222222222' },
      null,
      { index: 2 },
    ];

    globalThis.localStorage.setItem(ACCOUNTS_META_KEY, JSON.stringify(mixed));
    const result = getStoredAccountsMeta();

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      index: 0,
      label: 'Valid',
      address: '0x1111111111111111111111111111111111111111',
    });
  });
});

describe('active account index', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: createStorage(),
      configurable: true,
    });
  });

  it('defaults to 0 when no active index is stored', () => {
    expect(getActiveAccountIndex()).toBe(0);
  });

  it('round-trips the active index through set and get', () => {
    setActiveAccountIndex(3);
    expect(getActiveAccountIndex()).toBe(3);
  });

  it('returns 0 for non-numeric stored values', () => {
    globalThis.localStorage.setItem(ACTIVE_ACCOUNT_KEY, 'not-a-number');
    expect(getActiveAccountIndex()).toBe(0);
  });
});

describe('buildKeystoreKey', () => {
  it('builds the correct key for a given index', () => {
    expect(buildKeystoreKey(0)).toBe('arc_wallet_keystore_0');
    expect(buildKeystoreKey(5)).toBe('arc_wallet_keystore_5');
  });
});

describe('removeAccount', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: createStorage(),
      configurable: true,
    });
  });

  it('returns null when trying to remove the last remaining account', () => {
    const accounts: AccountMeta[] = [
      { index: 0, label: 'Account 1', address: '0x1111111111111111111111111111111111111111' },
    ];
    saveAccountsMeta(accounts);

    const result = removeAccount(0);
    expect(result).toBeNull();
    expect(getStoredAccountsMeta()).toHaveLength(1);
  });

  it('removes a non-active account without changing the active index', () => {
    const accounts: AccountMeta[] = [
      { index: 0, label: 'Account 1', address: '0x1111111111111111111111111111111111111111' },
      { index: 1, label: 'Account 2', address: '0x2222222222222222222222222222222222222222' },
      { index: 2, label: 'Account 3', address: '0x3333333333333333333333333333333333333333' },
    ];
    saveAccountsMeta(accounts);
    setActiveAccountIndex(0);

    const result = removeAccount(1);
    expect(result).not.toBeNull();
    expect(result!.accounts).toHaveLength(2);
    expect(result!.activeIndex).toBe(0);
    expect(getActiveAccountIndex()).toBe(0);

    const remaining = getStoredAccountsMeta();
    expect(remaining.map((a) => a.index)).toEqual([0, 2]);
  });

  it('switches active index when the active account is removed', () => {
    const accounts: AccountMeta[] = [
      { index: 0, label: 'Account 1', address: '0x1111111111111111111111111111111111111111' },
      { index: 1, label: 'Account 2', address: '0x2222222222222222222222222222222222222222' },
    ];
    saveAccountsMeta(accounts);
    setActiveAccountIndex(1);

    const result = removeAccount(1);
    expect(result).not.toBeNull();
    expect(result!.accounts).toHaveLength(1);
    expect(result!.activeIndex).toBe(0);
    expect(getActiveAccountIndex()).toBe(0);
  });
});

describe('renameAccount', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: createStorage(),
      configurable: true,
    });
  });

  it('updates the label for the matching account index', () => {
    const accounts: AccountMeta[] = [
      { index: 0, label: 'Account 1', address: '0x1111111111111111111111111111111111111111' },
      { index: 1, label: 'Account 2', address: '0x2222222222222222222222222222222222222222' },
    ];
    saveAccountsMeta(accounts);

    const result = renameAccount(1, 'My Savings');
    expect(result[1].label).toBe('My Savings');
    expect(result[0].label).toBe('Account 1');

    const stored = getStoredAccountsMeta();
    expect(stored[1].label).toBe('My Savings');
  });
});

describe('getNextDerivationIndex', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: createStorage(),
      configurable: true,
    });
  });

  it('returns 0 when no accounts exist', () => {
    expect(getNextDerivationIndex()).toBe(0);
  });

  it('returns the next index after the highest stored index', () => {
    const accounts: AccountMeta[] = [
      { index: 0, label: 'Account 1', address: '0x1111111111111111111111111111111111111111' },
      { index: 3, label: 'Account 4', address: '0x4444444444444444444444444444444444444444' },
    ];
    saveAccountsMeta(accounts);

    expect(getNextDerivationIndex()).toBe(4);
  });
});

describe('removeAllAccountData', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: createStorage(),
      configurable: true,
    });
  });

  it('clears all account metadata and active index', () => {
    const accounts: AccountMeta[] = [
      { index: 0, label: 'Account 1', address: '0x1111111111111111111111111111111111111111' },
    ];
    saveAccountsMeta(accounts);
    setActiveAccountIndex(0);

    removeAllAccountData();

    expect(getStoredAccountsMeta()).toEqual([]);
    expect(globalThis.localStorage.getItem(ACCOUNTS_META_KEY)).toBeNull();
    expect(globalThis.localStorage.getItem(ACTIVE_ACCOUNT_KEY)).toBeNull();
  });
});
