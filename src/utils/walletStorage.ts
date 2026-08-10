import { ethers } from 'ethers';

export const STORAGE_KEY_LEGACY = 'arc_wallet_pk';
export const STORAGE_KEY_KEystore = 'arc_wallet_keystore';

export const encryptWallet = async (privateKey: string, password: string): Promise<string> => {
  // Ensure private key has 0x prefix for ethers v6
  const normalizedKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  const wallet = new ethers.Wallet(normalizedKey);
  return wallet.encrypt(password);
};

export const decryptWallet = async (keystoreJson: string, password: string): Promise<ethers.Wallet> => {
  return ethers.Wallet.fromEncryptedJson(keystoreJson, password) as Promise<ethers.Wallet>;
};

export const getKeystoreFromStorage = (): string | null => {
  return localStorage.getItem(STORAGE_KEY_KEystore);
};

export const setKeystoreInStorage = (keystoreJson: string) => {
  localStorage.setItem(STORAGE_KEY_KEystore, keystoreJson);
};

export const removeKeystoreFromStorage = () => {
  localStorage.removeItem(STORAGE_KEY_KEystore);
};

export const hasLegacyKey = (): boolean => {
  return !!localStorage.getItem(STORAGE_KEY_LEGACY);
};

export const removeLegacyKey = () => {
  localStorage.removeItem(STORAGE_KEY_LEGACY);
};