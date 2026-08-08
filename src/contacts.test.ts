import { beforeEach, describe, expect, it } from 'vitest';
import { CONTACTS_STORAGE_KEY, getContacts, saveContact } from './contacts';

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

describe('contacts', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: createStorage(),
      configurable: true,
    });
  });

  it('upserts a contact by address and keeps the latest activity timestamp', () => {
    const address = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e';
    const first = saveContact(address, 'Alice');
    const second = saveContact(address.toLowerCase(), 'Alice Updated');

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({
      address,
      label: 'Alice Updated',
    });
    expect(second[0].lastUsedAt).toBeGreaterThanOrEqual(first[0].lastUsedAt);
  });

  it('sorts contacts by lastUsedAt descending', () => {
    const older = '0x1111111111111111111111111111111111111111';
    const newer = '0x2222222222222222222222222222222222222222';

    const items = [
      { id: older, label: 'Older', address: older, lastUsedAt: Date.now() - 60000 },
      { id: newer, label: 'Newer', address: newer, lastUsedAt: Date.now() },
    ];

    globalThis.localStorage.setItem(CONTACTS_STORAGE_KEY, JSON.stringify(items));

    const contacts = getContacts();
    expect(contacts.map((contact) => contact.label)).toEqual(['Newer', 'Older']);
  });

  it('falls back to an empty array for corrupt localStorage data', () => {
    globalThis.localStorage.setItem(CONTACTS_STORAGE_KEY, '{not-valid-json');
    expect(getContacts()).toEqual([]);
  });
});
