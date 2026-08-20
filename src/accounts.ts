import { ethers } from 'ethers';

export type AccountMeta = {
  index: number;
  label: string;
  address: string;
};

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

      if (!Number.isFinite(index) || !address) {
        return [];
      }

      return [{ index, label, address } satisfies AccountMeta];
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
