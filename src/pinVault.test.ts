import { describe, expect, it } from 'vitest';
import {
  decryptPrivateKey,
  encryptPrivateKey,
  parseVaultPayload,
  serializeVaultPayload,
  type EncryptedVaultPayload,
} from './utils/pinVault';

// Deterministic test inputs — no network, no RPC, no shared state.
const PIN = '123456';
const WRONG_PIN = '987654';
const PRIVATE_KEY =
  '0x1111111111111111111111111111111111111111111111111111111111111111';

describe('pinVault', () => {
  it('round-trips encryptPrivateKey → decryptPrivateKey with the correct PIN', async () => {
    const payload = await encryptPrivateKey(PRIVATE_KEY, PIN);
    expect(payload.salt).toBeTruthy();
    expect(payload.iv).toBeTruthy();
    expect(payload.ciphertext).toBeTruthy();

    const decrypted = await decryptPrivateKey(payload, PIN);
    expect(decrypted).toBe(PRIVATE_KEY);
  });

  it('throws when decrypting with the wrong PIN', async () => {
    const payload = await encryptPrivateKey(PRIVATE_KEY, PIN);
    await expect(decryptPrivateKey(payload, WRONG_PIN)).rejects.toThrow(Error);
  });

  it('throws (does not crash) on tampered/corrupted ciphertext', async () => {
    const payload = await encryptPrivateKey(PRIVATE_KEY, PIN);

    // Flip a bit of the ciphertext while keeping it valid base64.
    const firstChar = payload.ciphertext.charAt(0);
    const flippedChar = firstChar === 'A' ? 'B' : 'A';
    const tampered: EncryptedVaultPayload = {
      ...payload,
      ciphertext: flippedChar + payload.ciphertext.slice(1),
    };

    await expect(decryptPrivateKey(tampered, PIN)).rejects.toThrow(Error);
  });

  it('serialize → parse round-trip preserves the payload', async () => {
    const payload = await encryptPrivateKey(PRIVATE_KEY, PIN);
    const serialized = serializeVaultPayload(payload);
    const parsed = parseVaultPayload(serialized);

    expect(parsed).not.toBeNull();
    expect(parsed).toEqual(payload);
  });

  it('parseVaultPayload returns null (never throws) for malformed input', () => {
    // Non-JSON garbage.
    expect(parseVaultPayload('')).toBeNull();
    expect(parseVaultPayload('not json {{{')).toBeNull();

    // Stale plaintext private key left over from before the vault existed —
    // treated as "no valid vault found", never migrated or auto-decrypted.
    expect(parseVaultPayload(PRIVATE_KEY)).toBeNull();

    // JSON but missing required fields / wrong shapes.
    expect(parseVaultPayload('{}')).toBeNull();
    expect(parseVaultPayload(JSON.stringify({ salt: 'AAAA', iv: 'BBBB' }))).toBeNull();
    expect(parseVaultPayload(JSON.stringify({ salt: 'AAAA', ciphertext: 'CCCC' }))).toBeNull();
    expect(
      parseVaultPayload(JSON.stringify({ salt: '', iv: 'BBBB', ciphertext: 'CCCC' })),
    ).toBeNull();
    expect(parseVaultPayload('[]')).toBeNull();
    expect(parseVaultPayload('null')).toBeNull();
    expect(parseVaultPayload('42')).toBeNull();
  });

  it('encrypts with fresh randomness every call (salt/IV/ciphertext never reused)', async () => {
    const [first, second] = await Promise.all([
      encryptPrivateKey(PRIVATE_KEY, PIN),
      encryptPrivateKey(PRIVATE_KEY, PIN),
    ]);

    expect(first.salt).not.toBe(second.salt);
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });
});