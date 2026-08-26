import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  ADD_ACCOUNT_UNAVAILABLE_MESSAGES,
  addDerivedAccount,
  clearSessionSeed,
  deriveAccountAtIndex,
  getAddAccountUnavailableReason,
  getKeystoreForAccount,
  getNextDerivationIndex,
  getSessionSeed,
  getStoredAccountsMeta,
  loadSessionSeedFromVault,
  persistSeedVault,
  saveAccountsMeta,
  setActiveAccountIndex,
  setKeystoreForAccount,
  setSessionSeed,
} from './accounts';
import {
  SEED_VAULT_STORAGE_KEY,
  decryptPrivateKey,
  getSeedVaultFromStorage,
  hasSeedVault,
  parseVaultPayload,
} from './utils/pinVault';

// The keystore encryption (ethers scrypt) is slow and irrelevant to these
// assertions, so it is mocked at the ethers.js layer. Nothing here touches the
// network or live testnet RPC — derivation is pure offline BIP44 math.
vi.mock('./utils/walletStorage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./utils/walletStorage')>();
  return {
    ...actual,
    encryptWallet: vi.fn(
      async (privateKey: string) => JSON.stringify({ mockedKeystore: true, privateKey }),
    ),
  };
});

const TEST_MNEMONIC = 'test test test test test test test test test test test junk';
const TEST_PIN = '123456';
const WRONG_PIN = '987654';
const RAW_PRIVATE_KEY =
  '0x1111111111111111111111111111111111111111111111111111111111111111';

const expectedAddressAt = (index: number): string =>
  ethers.HDNodeWallet.fromPhrase(TEST_MNEMONIC, undefined, `m/44'/60'/0'/0/${index}`).address;

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

const localStorageEntries = (): Array<[string, string]> => {
  const entries: Array<[string, string]> = [];
  for (let i = 0; i < globalThis.localStorage.length; i += 1) {
    const key = globalThis.localStorage.key(i) as string;
    entries.push([key, globalThis.localStorage.getItem(key) as string]);
  }
  return entries;
};

describe('seed vault persistence (arc_wallet_seed_vault)', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: createStorage(),
      configurable: true,
    });
    clearSessionSeed();
  });

  it('stores the mnemonic under its own dedicated encrypted storage key', async () => {
    await persistSeedVault(TEST_MNEMONIC, TEST_PIN);

    expect(globalThis.localStorage.getItem(SEED_VAULT_STORAGE_KEY)).not.toBeNull();
    expect(hasSeedVault()).toBe(true);
    const raw = getSeedVaultFromStorage();
    expect(raw).not.toBeNull();

    // Stored value is an AES-GCM payload — not plaintext.
    const payload = parseVaultPayload(raw!);
    expect(payload).not.toBeNull();

    const decrypted = await decryptPrivateKey(payload!, TEST_PIN);
    expect(decrypted).toBe(TEST_MNEMONIC);
  });

  it('rejects a wrong PIN and never stores the plaintext mnemonic in localStorage', async () => {
    await persistSeedVault(TEST_MNEMONIC, TEST_PIN);

    const payload = parseVaultPayload(getSeedVaultFromStorage()!);
    await expect(decryptPrivateKey(payload!, WRONG_PIN)).rejects.toThrow(Error);

    // No localStorage entry anywhere contains the plaintext phrase.
    for (const [, value] of localStorageEntries()) {
      expect(value).not.toContain(TEST_MNEMONIC);
    }
  });
});

describe('session seed lifecycle (in-memory only)', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: createStorage(),
      configurable: true,
    });
    clearSessionSeed();
  });

  it('restores the seed into memory on unlock when a seed vault exists', async () => {
    await persistSeedVault(TEST_MNEMONIC, TEST_PIN);

    const restored = await loadSessionSeedFromVault(TEST_PIN);

    expect(restored).toBe(TEST_MNEMONIC);
    expect(getSessionSeed()).toBe(TEST_MNEMONIC);
  });

  it('returns null when no seed vault exists (raw-private-key wallet)', async () => {
    const restored = await loadSessionSeedFromVault(TEST_PIN);

    expect(restored).toBeNull();
    expect(getSessionSeed()).toBeNull();
  });

  it('returns null and holds nothing on a wrong PIN', async () => {
    await persistSeedVault(TEST_MNEMONIC, TEST_PIN);

    const restored = await loadSessionSeedFromVault(WRONG_PIN);

    expect(restored).toBeNull();
    expect(getSessionSeed()).toBeNull();
  });

  it('clears the in-memory mnemonic on lock — no residual derivation possible', async () => {
    await persistSeedVault(TEST_MNEMONIC, TEST_PIN);
    await loadSessionSeedFromVault(TEST_PIN);
    expect(getSessionSeed()).not.toBeNull();

    // Simulate handleLock().
    clearSessionSeed();

    expect(getSessionSeed()).toBeNull();
    const outcome = await addDerivedAccount(TEST_PIN);
    expect(outcome.status).toBe('unavailable');
    // No keystore was written for the next index while locked.
    expect(getKeystoreForAccount(1)).toBeNull();
  });
});

describe('Add Account regression scenarios', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: createStorage(),
      configurable: true,
    });
    clearSessionSeed();
  });

  it('imports via seed phrase → unlock → Add Account succeeds WITHOUT re-import prompt', async () => {
    // Arrange: wallet imported from a seed phrase and finalized with a PIN.
    const accountZero = deriveAccountAtIndex(TEST_MNEMONIC, 0);
    await persistSeedVault(TEST_MNEMONIC, TEST_PIN);
    saveAccountsMeta([
      { index: 0, label: 'Account 1', address: accountZero.address, source: 'seed' },
    ]);
    setKeystoreForAccount(0, JSON.stringify({ mockedKeystore: true }));

    // Act: unlock (PIN entry decrypts the seed vault), then Add Account.
    const restored = await loadSessionSeedFromVault(TEST_PIN);
    expect(restored).not.toBeNull();
    expect(getAddAccountUnavailableReason()).toBeNull(); // no re-import messaging

    const outcome = await addDerivedAccount(TEST_PIN);

    // Assert
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.account.index).toBe(1);
    expect(outcome.account.address).toBe(expectedAddressAt(1));
    expect(getKeystoreForAccount(1)).not.toBeNull();
    expect(getStoredAccountsMeta().map((a) => a.index)).toEqual([0, 1]);
  });

  it('imports via raw private key → Add Account shows the DISTINCT not-derivable message', async () => {
    // Arrange: raw-key wallet — keystore exists, NO seed vault, source flagged.
    saveAccountsMeta([
      {
        index: 0,
        label: 'Account 1',
        address: new ethers.Wallet(RAW_PRIVATE_KEY).address,
        source: 'private-key',
      },
    ]);
    setKeystoreForAccount(0, JSON.stringify({ mockedKeystore: true }));
    await loadSessionSeedFromVault(TEST_PIN); // unlock: no vault → null

    const reason = getAddAccountUnavailableReason();
    const outcome = await addDerivedAccount(TEST_PIN);

    expect(reason).toBe('private-key');
    expect(outcome.status).toBe('unavailable');
    if (outcome.status !== 'unavailable') return;
    expect(outcome.reason).toBe('private-key');

    const message = ADD_ACCOUNT_UNAVAILABLE_MESSAGES[outcome.reason];
    // Distinct from the generic re-import wording AND from the migration message.
    expect(message).toContain('raw private key');
    expect(message).not.toBe(ADD_ACCOUNT_UNAVAILABLE_MESSAGES.migration);
    expect(getStoredAccountsMeta()).toHaveLength(1); // nothing added
  });

  it('pre-fix migration case (keystore_0 present, seed_vault absent) → ONE-TIME re-import messaging', async () => {
    // Arrange: a user who hit the bug pre-fix — account 0 exists, no source flag,
    // no persisted seed. Their seed cannot be recovered retroactively.
    const accountZero = deriveAccountAtIndex(TEST_MNEMONIC, 0);
    saveAccountsMeta([{ index: 0, label: 'Account 1', address: accountZero.address }]);
    setKeystoreForAccount(0, JSON.stringify({ mockedKeystore: true }));
    await loadSessionSeedFromVault(TEST_PIN); // unlock: no vault

    // First session: one-time migration message (NOT the raw-key message).
    expect(getAddAccountUnavailableReason()).toBe('migration');
    const outcomeBefore = await addDerivedAccount(TEST_PIN);
    expect(outcomeBefore.status).toBe('unavailable');
    if (outcomeBefore.status === 'unavailable') {
      expect(outcomeBefore.reason).toBe('migration');
      expect(ADD_ACCOUNT_UNAVAILABLE_MESSAGES.migration).toContain('Re-import your seed phrase once');
      expect(ADD_ACCOUNT_UNAVAILABLE_MESSAGES.migration).not.toBe(
        ADD_ACCOUNT_UNAVAILABLE_MESSAGES['private-key'],
      );
    }
    expect(getKeystoreForAccount(1)).toBeNull();

    // Act: user re-imports once → seed persists, then Add Account works.
    await persistSeedVault(TEST_MNEMONIC, TEST_PIN);
    saveAccountsMeta([{ index: 0, label: 'Account 1', address: accountZero.address, source: 'seed' }]);

    // Post-migration behavior: every later lock/unlock restores derivation —
    // the migration message never appears again.
    await loadSessionSeedFromVault(TEST_PIN);
    expect(getAddAccountUnavailableReason()).toBeNull();
    const outcomeAfter = await addDerivedAccount(TEST_PIN);
    expect(outcomeAfter.status).toBe('ok');

    // Simulate a full subsequent session: lock → unlock.
    clearSessionSeed();
    await loadSessionSeedFromVault(TEST_PIN);
    expect(getAddAccountUnavailableReason()).toBeNull();
    expect(await addDerivedAccount(TEST_PIN)).toMatchObject({ status: 'ok' });
  });

  it("derives indices 1, 2, 3 sequentially with addresses matching m/44'/60'/0'/0/{index}", async () => {
    // Arrange: unlocked seed-phrase session with only account 0 on disk.
    const accountZero = deriveAccountAtIndex(TEST_MNEMONIC, 0);
    await persistSeedVault(TEST_MNEMONIC, TEST_PIN);
    saveAccountsMeta([
      { index: 0, label: 'Account 1', address: accountZero.address, source: 'seed' },
    ]);
    setKeystoreForAccount(0, JSON.stringify({ mockedKeystore: true }));
    await loadSessionSeedFromVault(TEST_PIN);

    // Act: three sequential Add Account calls.
    const first = await addDerivedAccount(TEST_PIN);
    const second = await addDerivedAccount(TEST_PIN);
    const third = await addDerivedAccount(TEST_PIN);

    // Assert: sequential indices, correct BIP44 addresses, keystores + metadata.
    [first, second, third].forEach((outcome, i) => {
      expect(outcome.status).toBe('ok');
      if (outcome.status !== 'ok') return;
      const index = i + 1;
      expect(outcome.account.index).toBe(index);
      expect(outcome.account.address).toBe(expectedAddressAt(index));
      expect(outcome.privateKey).toBe(
        deriveAccountAtIndex(TEST_MNEMONIC, index).privateKey,
      );

      const keystore = getKeystoreForAccount(index);
      expect(keystore).not.toBeNull();
      expect(JSON.parse(keystore!)).toEqual({
        mockedKeystore: true,
        privateKey: deriveAccountAtIndex(TEST_MNEMONIC, index).privateKey,
      });
    });

    expect(getStoredAccountsMeta().map((a) => a.index)).toEqual([0, 1, 2, 3]);
    expect(getNextDerivationIndex()).toBe(4);
    expect(getSessionSeed()).toBe(TEST_MNEMONIC); // still held for the session
    setActiveAccountIndex(3);
  });
});

describe('setSessionSeed guard rails', () => {
  beforeEach(() => {
    clearSessionSeed();
  });

  it('ignores empty strings', () => {
    setSessionSeed('');
    expect(getSessionSeed()).toBeNull();
  });
});
