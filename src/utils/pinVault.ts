export type EncryptedVaultPayload = {
  v: number;
  salt: string;
  iv: string;
  ciphertext: string;
};

const VAULT_STORAGE_KEY = 'arc_wallet_vault';

const arrayBufferToBase64 = (buffer: ArrayBuffer | Uint8Array<ArrayBuffer>): string => {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

const base64ToArrayBuffer = (base64: string): ArrayBuffer => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer as ArrayBuffer;
};

const deriveKey = async (pin: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> => {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(pin),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
};

export const encryptPrivateKeyWithPin = async (privateKey: string, pin: string): Promise<string> => {
  const salt = crypto.getRandomValues(new Uint8Array(16)) as Uint8Array<ArrayBuffer>;
  const iv = crypto.getRandomValues(new Uint8Array(12)) as Uint8Array<ArrayBuffer>;
  const key = await deriveKey(pin, salt);

  const encoder = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer> },
    key,
    encoder.encode(privateKey)
  );

  const payload: EncryptedVaultPayload = {
    v: 1,
    salt: arrayBufferToBase64(salt),
    iv: arrayBufferToBase64(iv),
    ciphertext: arrayBufferToBase64(ciphertext),
  };

  return JSON.stringify(payload);
};

export const decryptPrivateKeyWithPin = async (vaultJson: string, pin: string): Promise<string> => {
  const payload = JSON.parse(vaultJson) as EncryptedVaultPayload;
  if (payload.v !== 1) {
    throw new Error('Unsupported vault version');
  }

  const salt = new Uint8Array(base64ToArrayBuffer(payload.salt)) as Uint8Array<ArrayBuffer>;
  const iv = new Uint8Array(base64ToArrayBuffer(payload.iv)) as Uint8Array<ArrayBuffer>;
  const ciphertext = base64ToArrayBuffer(payload.ciphertext);

  const key = await deriveKey(pin, salt);

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer> },
    key,
    ciphertext
  );

  const decoder = new TextDecoder();
  return decoder.decode(decrypted);
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
    // Ignore write failures
  }
};

export const removeVaultFromStorage = (): void => {
  try {
    localStorage.removeItem(VAULT_STORAGE_KEY);
  } catch {
    // Ignore
  }
};
