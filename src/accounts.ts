import { ethers } from 'ethers';
import {
  decryptPrivateKey,
  encryptPrivateKey,
  getSeedVaultFromStorage,
  parseVaultPayload,
  removeSeedVaultFromStorage,
  serializeVaultPayload,
  setSeedVaultInStorage,
} from './utils/pinVault';
import { encryptWallet } from './utils/walletStorage';

export type AccountMeta = {
  index: number;
  label: string;
  address: string;
  /**
   * How the wallet was originally brought onto this device.
   * - 'seed': imported/created from a BIP44 seed phrase (extra accounts derivable).
   * - 'private-key': imported from a raw 0x private key (no derivable seed).
   * Optional because wallets created before this field existed have no value —
   * those are the pre-fix users handled by the one-time migration messaging.
   */
  source?: AccountSource;
};

export type AccountSource = 'seed' | 'private-key';

export const ACCOUNTS_META_KEY = 'arc_wallet_accounts_meta';
export const ACTIVE_ACCOUNT_KEY = 'arc_wallet_active_index';
const KEYSTORE_PREFIX = 'arc_wallet_keystore_';

const getStorage = (): Storage | null => {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }

    if ('localStorage' in globalThis && globalThis.localStorage) {
      return globalThis.localStorage;
    }
  } catch {
    // Ignore storage access errors.
  }

  return null;
};

export const buildKeystoreKey = (index: number): string => {
  return `${KEYSTORE_PREFIX}${index}`;
};

export const deriveAccountAtIndex = (
  mnemonic: string,
  index: number,
): { address: string; privateKey: string } => {
  const path = `m/44'/60'/0'/0/${index}`;
  const hdNode = ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, path);
  return {
    address: hdNode.address,
    privateKey: hdNode.privateKey,
  };
};

export const getStoredAccountsMeta = (): AccountMeta[] => {
  const storage = getStorage();
  if (!storage) {
    return [];
  }

  try {
    const raw = storage.getItem(ACCOUNTS_META_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.flatMap((item) => {
      if (typeof item !== 'object' || item === null) {
        return [];
      }

      const candidate = item as Partial<Record<string, unknown>>;
      const index = Number(candidate.index);
      const label = typeof candidate.label === 'string' ? candidate.label : '';
      const address = typeof candidate.address === 'string' ? candidate.address : '';
      const source =
        candidate.source === 'seed' || candidate.source === 'private-key'
          ? (candidate.source as AccountSource)
          : undefined;

      if (!Number.isFinite(index) || !address) {
        return [];
      }

      // `source` is only included when present so legacy payloads round-trip
      // without gaining a spurious field.
      return [
        (source ? { index, label, address, source } : { index, label, address }) satisfies AccountMeta,
      ];
    });
  } catch {
    return [];
  }
};

export const saveAccountsMeta = (accounts: AccountMeta[]): void => {
  const storage = getStorage();
  if (!storage) {
    return;
  }

  try {
    storage.setItem(ACCOUNTS_META_KEY, JSON.stringify(accounts));
  } catch {
    // Ignore write failures.
  }
};

export const getActiveAccountIndex = (): number => {
  const storage = getStorage();
  if (!storage) {
    return 0;
  }

  try {
    const raw = storage.getItem(ACTIVE_ACCOUNT_KEY);
    if (raw === null) {
      return 0;
    }

    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
};

export const setActiveAccountIndex = (index: number): void => {
  const storage = getStorage();
  if (!storage) {
    return;
  }

  try {
    storage.setItem(ACTIVE_ACCOUNT_KEY, String(index));
  } catch {
    // Ignore write failures.
  }
};

export const getKeystoreForAccount = (index: number): string | null => {
  const storage = getStorage();
  if (!storage) {
    return null;
  }

  try {
    return storage.getItem(buildKeystoreKey(index));
  } catch {
    return null;
  }
};

export const setKeystoreForAccount = (index: number, keystoreJson: string): void => {
  const storage = getStorage();
  if (!storage) {
    return;
  }

  try {
    storage.setItem(buildKeystoreKey(index), keystoreJson);
  } catch {
    // Ignore write failures.
  }
};

export const removeKeystoreForAccount = (index: number): void => {
  const storage = getStorage();
  if (!storage) {
    return;
  }

  try {
    storage.removeItem(buildKeystoreKey(index));
  } catch {
    // Ignore write failures.
  }
};

export const removeAccount = (
  index: number,
): { accounts: AccountMeta[]; activeIndex: number } | null => {
  const accounts = getStoredAccountsMeta();
  if (accounts.length <= 1) {
    return null;
  }

  const activeIndex = getActiveAccountIndex();
  const filtered = accounts.filter((a) => a.index !== index);

  removeKeystoreForAccount(index);
  saveAccountsMeta(filtered);

  let nextActive = activeIndex;
  if (activeIndex === index) {
    nextActive = filtered[0]?.index ?? 0;
    setActiveAccountIndex(nextActive);
  }

  return { accounts: filtered, activeIndex: nextActive };
};

export const removeAllAccountData = (): void => {
  const accounts = getStoredAccountsMeta();
  for (const account of accounts) {
    removeKeystoreForAccount(account.index);
  }

  const storage = getStorage();
  if (storage) {
    try {
      storage.removeItem(ACCOUNTS_META_KEY);
      storage.removeItem(ACTIVE_ACCOUNT_KEY);
      removeSeedVaultFromStorage();
    } catch {
      // Ignore write failures.
    }
  }
};

export const renameAccount = (index: number, label: string): AccountMeta[] => {
  const accounts = getStoredAccountsMeta();
  const next = accounts.map((a) =>
    a.index === index ? { ...a, label } : a,
  );
  saveAccountsMeta(next);
  return next;
};

export const getNextDerivationIndex = (): number => {
  const accounts = getStoredAccountsMeta();
  if (accounts.length === 0) {
    return 0;
  }

  return Math.max(...accounts.map((a) => a.index)) + 1;
};

/**
 * One-time migration: if the legacy single-account keystore (`arc_wallet_keystore`)
 * exists but no per-index keystore for account 0 (`arc_wallet_keystore_0`) has been
 * written yet, copy the legacy keystore into the new per-index scheme and ensure
 * `arc_wallet_accounts_meta` has a matching entry for index 0.
 *
 * Idempotent — safe to call on every app load. Returns true if a migration was
 * performed, false if nothing needed to be done.
 */
export const migrateLegacyKeystoreToIndexZero = (
  legacyKeystoreJson: string,
  address: string,
): boolean => {
  // Nothing to migrate from (fresh install / missing legacy data) — no-op.
  if (!legacyKeystoreJson || !legacyKeystoreJson.trim()) {
    return false;
  }

  // If arc_wallet_keystore_0 already exists, nothing to migrate.
  const existing = getKeystoreForAccount(0);
  if (existing !== null) {
    return false;
  }

  // Write the legacy keystore into the per-index slot for account 0.
  setKeystoreForAccount(0, legacyKeystoreJson);

  // Verify the write succeeded before touching metadata.
  const verify = getKeystoreForAccount(0);
  if (verify === null) {
    return false;
  }

  // Ensure accounts_meta has an entry for index 0.
  const accounts = getStoredAccountsMeta();
  const hasIndexZero = accounts.some((a) => a.index === 0);
  if (!hasIndexZero) {
    const next: AccountMeta[] = [
      { index: 0, label: 'Main', address },
      ...accounts,
    ];
    saveAccountsMeta(next);
  }

  return true;
};

// --- In-memory session seed -------------------------------------------------
//
// The plaintext mnemonic is held in a module-level variable (NOT React state)
// so it does not show up in component state inspectors. It exists only for the
// lifetime of an unlocked session:
//   - set at unlock time when `arc_wallet_seed_vault` decrypts successfully,
//     or at create/import finalize before the first lock;
//   - cleared on lock/logout/wallet removal.
// It is never written to localStorage, console, or any network request.

let sessionSeedMnemonic: string | null = null;

export const setSessionSeed = (mnemonic: string | null): void => {
  sessionSeedMnemonic = typeof mnemonic === 'string' && mnemonic ? mnemonic : null;
};

export const getSessionSeed = (): string | null => {
  return sessionSeedMnemonic;
};

export const clearSessionSeed = (): void => {
  sessionSeedMnemonic = null;
};

// --- Seed vault persistence (encrypted at rest) -----------------------------

/** Encrypts the mnemonic with the PIN and persists it under `arc_wallet_seed_vault`. */
export const persistSeedVault = async (mnemonic: string, pin: string): Promise<void> => {
  const payload = await encryptPrivateKey(mnemonic, pin);
  setSeedVaultInStorage(serializeVaultPayload(payload));
};

/**
 * Decrypts `arc_wallet_seed_vault` with the PIN and holds the plaintext
 * mnemonic in memory for the unlocked session. Returns the mnemonic, or null
 * when no seed vault exists (e.g. raw-private-key imports) or decryption fails.
 */
export const loadSessionSeedFromVault = async (pin: string): Promise<string | null> => {
  // Any previously held seed belongs to a prior locked session.
  clearSessionSeed();

  const raw = getSeedVaultFromStorage();
  if (!raw) {
    return null;
  }

  const payload = parseVaultPayload(raw);
  if (!payload) {
    return null;
  }

  try {
    const mnemonic = await decryptPrivateKey(payload, pin);
    if (!mnemonic) {
      return null;
    }
    sessionSeedMnemonic = mnemonic;
    return mnemonic;
  } catch {
    // Wrong PIN or corrupted payload — treat as "no derivable seed this session".
    return null;
  }
};

// --- Add Account ------------------------------------------------------------

export type AddAccountUnavailableReason = 'private-key' | 'migration';

/**
 * Distinct, user-facing explanations for why additional accounts can't be
 * derived right now. Deliberately two different messages:
 * - 'private-key': the wallet was imported from a raw 0x key — there is no
 *   seed to derive from, ever; they'd need to import a seed phrase instead.
 * - 'migration': pre-fix wallets have keystore_0 but no persisted seed vault.
 *   The seed cannot be recovered retroactively, so ask for a one-time
 *   re-import; after that it persists and this message never appears again.
 */
export const ADD_ACCOUNT_UNAVAILABLE_MESSAGES: Record<AddAccountUnavailableReason, string> = {
  'private-key':
    "This wallet was imported with a raw private key, which can't derive additional accounts. Import your seed phrase instead if you want multiple accounts.",
  migration:
    'Re-import your seed phrase once to enable multiple accounts — after that it will be remembered securely.',
};

/**
 * Why "Add Account" is unavailable right now, or null when derivation is
 * possible (an unlocked session holds the seed).
 *
 * Resolution order matters:
 * 1. Session seed present → available.
 * 2. Index-0 account explicitly marked 'private-key' → distinct not-derivable message.
 * 3. Everything else (keystore_0 present but no source flag and no seed vault,
 *    i.e. the pre-fix bug) → one-time migration message ONLY.
 */
export const getAddAccountUnavailableReason = (): AddAccountUnavailableReason | null => {
  if (sessionSeedMnemonic) {
    return null;
  }

  const primary = getStoredAccountsMeta().find((account) => account.index === 0);
  if (primary?.source === 'private-key') {
    return 'private-key';
  }

  return 'migration';
};

export type AddAccountOutcome =
  | {
      status: 'ok';
      /** Newly created account metadata (also appended to accounts_meta). */
      account: AccountMeta;
      /** Private key of the new account — in-memory only, never persisted in plaintext. */
      privateKey: string;
      /** Encrypted keystore JSON written to `arc_wallet_keystore_{index}`. */
      keystoreJson: string;
    }
  | { status: 'unavailable'; reason: AddAccountUnavailableReason };

/**
 * Derives the next sequential HD account (m/44'/60'/0'/0/{index}) from the
 * in-memory session seed, encrypts its private key into a fresh per-index
 * keystore, appends it to accounts_meta, and returns the result. No prompts:
 * requires only the already-unlocked session seed and the session PIN.
 *
 * Returns `{ status: 'unavailable' }` instead of throwing when there is no
 * derivable seed, so callers can surface reason-specific messaging.
 */
export const addDerivedAccount = async (pin: string): Promise<AddAccountOutcome> => {
  const unavailableReason = getAddAccountUnavailableReason();
  if (unavailableReason || !sessionSeedMnemonic) {
    return { status: 'unavailable', reason: unavailableReason ?? 'migration' };
  }

  const seed = sessionSeedMnemonic;
  const nextIndex = getNextDerivationIndex();
  const derived = deriveAccountAtIndex(seed, nextIndex);
  const keystoreJson = await encryptWallet(derived.privateKey, pin);

  setKeystoreForAccount(nextIndex, keystoreJson);

  const nextAccounts: AccountMeta[] = [
    ...getStoredAccountsMeta(),
    { index: nextIndex, label: `Account ${nextIndex + 1}`, address: derived.address },
  ];
  saveAccountsMeta(nextAccounts);

  return {
    status: 'ok',
    account: nextAccounts[nextAccounts.length - 1],
    privateKey: derived.privateKey,
    keystoreJson,
  };
};
