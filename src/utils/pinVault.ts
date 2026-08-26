/**
 * PIN-encrypted vault for the ArcPay wallet private key.
 *
 * The private key NEVER touches persistent storage in plaintext form:
 * - The encryption key is derived from the user's PIN using PBKDF2
 *   (SHA-256, 100,000 iterations) with a random per-wallet salt.
 * - The private key is encrypted with AES-GCM (256-bit key) using a fresh
 *   random IV for every encryption.
 * - Only the resulting ciphertext plus its salt and IV (neither of which is
 *   secret) is persisted, as a JSON payload under the long-standing
 *   `arc_wallet_pk` localStorage key. The shape of the stored value changed
 *   from a raw hex string to this encrypted payload — the key name did not.
 *
 * Uses only the browser-native Web Crypto API (`window.crypto.subtle`,
 * `window.crypto.getRandomValues`) — no external dependencies.
 */

const VAULT_STORAGE_KEY = 'arc_wallet_pk';
const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const IV_BYTES = 12; // 96-bit IV is the recommended size for AES-GCM

/** Generic failure message — deliberately does not distinguish a wrong PIN
 * from corrupted data, and never leaks Web Crypto internals. */
const DECRYPTION_FAILED_MESSAGE = 'Vault decryption failed.';

export type EncryptedVaultPayload = {
  salt: string; // base64
  iv: string; // base64
  ciphertext: string; // base64
};

const toBase64 = (buffer: ArrayBuffer | Uint8Array): string => {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

const fromBase64 = (value: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

/**
 * Derives an AES-GCM CryptoKey from a PIN string and a salt.
 * PBKDF2 with SHA-256 and 100,000 iterations.
 */
export async function deriveVaultKey(
  pin: string,
  salt: Uint8Array<ArrayBuffer>,
): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,
    ['deriveKey'],
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Encrypts a private key string with a freshly generated salt + IV.
 * Returns a JSON-serializable payload ready for localStorage.
 */
export async function encryptPrivateKey(
  privateKey: string,
  pin: string,
): Promise<EncryptedVaultPayload> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveVaultKey(pin, salt as Uint8Array<ArrayBuffer>);

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(privateKey),
  );

  return {
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: toBase64(ciphertext),
  };
}

/**
 * Decrypts a stored payload with the given PIN.
 * Throws a generic Error (never leaking crypto internals) if the PIN is wrong
 * or the payload is malformed/corrupted — both fail exactly the same way,
 * because AES-GCM auth tag verification rejects either case.
 */
export async function decryptPrivateKey(
  payload: EncryptedVaultPayload,
  pin: string,
): Promise<string> {
  let salt: Uint8Array<ArrayBuffer>;
  let iv: Uint8Array<ArrayBuffer>;
  let ciphertext: Uint8Array<ArrayBuffer>;

  try {
    salt = fromBase64(payload.salt);
    iv = fromBase64(payload.iv);
    ciphertext = fromBase64(payload.ciphertext);
  } catch {
    // Malformed base64 anywhere in the payload is treated identically to a
    // wrong PIN — no information about *what* failed escapes this module.
    throw new Error(DECRYPTION_FAILED_MESSAGE);
  }

  try {
    const key = await deriveVaultKey(pin, salt as Uint8Array<ArrayBuffer>);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext,
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new Error(DECRYPTION_FAILED_MESSAGE);
  }
}

/** Serializes the payload to the exact string format persisted in localStorage. */
export function serializeVaultPayload(payload: EncryptedVaultPayload): string {
  return JSON.stringify({
    salt: payload.salt,
    iv: payload.iv,
    ciphertext: payload.ciphertext,
  });
}

/**
 * Parses a raw localStorage string back into a payload.
 * Returns null (never throws) for anything that is not a well-formed vault
 * payload — including leftover plaintext private keys from before this vault
 * existed. Callers treat null as "no valid vault found".
 */
export function parseVaultPayload(raw: string): EncryptedVaultPayload | null {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }

    const candidate = parsed as Partial<Record<string, unknown>>;
    if (
      typeof candidate.salt !== 'string' ||
      candidate.salt === '' ||
      typeof candidate.iv !== 'string' ||
      candidate.iv === '' ||
      typeof candidate.ciphertext !== 'string' ||
      candidate.ciphertext === ''
    ) {
      return null;
    }

    return {
      salt: candidate.salt,
      iv: candidate.iv,
      ciphertext: candidate.ciphertext,
    };
  } catch {
    return null;
  }
}

// --- localStorage helpers -------------------------------------------------

// --- Seed phrase vault ------------------------------------------------------
//
// The BIP44 mnemonic is encrypted with the exact same PIN-derived AES-GCM key
// scheme as the private-key vault above (PBKDF2/SHA-256, 100,000 iterations,
// random per-entry salt + 96-bit IV) and persisted under its own dedicated
// localStorage key so it can be versioned/migrated independently of the
// per-index keystores and the `arc_wallet_pk` vault.
//
// Only the ciphertext ever touches persistent storage. The plaintext mnemonic
// lives exclusively in memory for the duration of an unlocked session (see
// src/accounts.ts) and is never logged, sent over the network, or written to
// localStorage unencrypted.

export const SEED_VAULT_STORAGE_KEY = 'arc_wallet_seed_vault';

/** Encrypts a mnemonic phrase using the same scheme as `encryptPrivateKey`. */
export async function encryptSeedPhrase(
  mnemonic: string,
  pin: string,
): Promise<EncryptedVaultPayload> {
  return encryptPrivateKey(mnemonic, pin);
}

/** Decrypts a seed vault payload. Throws the same generic error on a wrong PIN or corrupted data. */
export async function decryptSeedPhrase(
  payload: EncryptedVaultPayload,
  pin: string,
): Promise<string> {
  return decryptPrivateKey(payload, pin);
}

export const getSeedVaultFromStorage = (): string | null => {
  try {
    return localStorage.getItem(SEED_VAULT_STORAGE_KEY);
  } catch {
    return null;
  }
};

export const setSeedVaultInStorage = (vaultJson: string): void => {
  try {
    localStorage.setItem(SEED_VAULT_STORAGE_KEY, vaultJson);
  } catch {
    // Ignore write failures (e.g. quota exceeded / storage disabled)
  }
};

export const removeSeedVaultFromStorage = (): void => {
  try {
    localStorage.removeItem(SEED_VAULT_STORAGE_KEY);
  } catch {
    // Ignore removal failures
  }
};

/** True when an encrypted seed vault entry exists in storage (present ≠ unlocked). */
export const hasSeedVault = (): boolean => {
  try {
    return localStorage.getItem(SEED_VAULT_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
};

export const getVaultFromStorage = (): string | null => {
  try {
    return localStorage.getItem(VAULT_STORAGE_KEY);
  } catch {
    return null;
  }
};

export const setVaultInStorage = (vaultJson: string): void => {
  try {
    localStorage.setItem(VAULT_STORAGE_KEY, vaultJson);
  } catch {
    // Ignore write failures (e.g. quota exceeded / storage disabled)
  }
};

export const removeVaultFromStorage = (): void => {
  try {
    localStorage.removeItem(VAULT_STORAGE_KEY);
  } catch {
    // Ignore removal failures
  }
};
