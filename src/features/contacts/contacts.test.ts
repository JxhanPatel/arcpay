import { beforeEach, describe, expect, it } from 'vitest';
import { CONTACTS_STORAGE_KEY, getContacts, saveContact, filterContacts } from './contacts';

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

describe('filterContacts', () => {
  it('returns all contacts when query is empty', () => {
    const contacts = [
      { id: '1', label: 'Alice', address: '0x123', lastUsedAt: 0 },
      { id: '2', label: 'Bob', address: '0x456', lastUsedAt: 0 },
    ];
    
    const result = filterContacts(contacts, '');
    expect(result).toEqual(contacts);
  });

  it('returns all contacts when query is whitespace-only', () => {
    const contacts = [
      { id: '1', label: 'Alice', address: '0x123', lastUsedAt: 0 },
      { id: '2', label: 'Bob', address: '0x456', lastUsedAt: 0 },
    ];
    
    const result = filterContacts(contacts, '   ');
    expect(result).toEqual(contacts);
  });

  it('matches on label substring, case-insensitively', () => {
    const contacts = [
      { id: '1', label: 'Alice', address: '0x123', lastUsedAt: 0 },
      { id: '2', label: 'Bob', address: '0x456', lastUsedAt: 0 },
      { id: '3', label: 'Charlie', address: '0x789', lastUsedAt: 0 },
    ];
    
    // Case insensitive match
    expect(filterContacts(contacts, 'alice')).toEqual([{ id: '1', label: 'Alice', address: '0x123', lastUsedAt: 0 }]);
    expect(filterContacts(contacts, 'ALICE')).toEqual([{ id: '1', label: 'Alice', address: '0x123', lastUsedAt: 0 }]);
    expect(filterContacts(contacts, 'lic')).toEqual([{ id: '1', label: 'Alice', address: '0x123', lastUsedAt: 0 }]);
  });

  it('matches on address substring, case-insensitively', () => {
    const contacts = [
      { id: '1', label: 'Alice', address: '0x123abc', lastUsedAt: 0 },
      { id: '2', label: 'Bob', address: '0x456def', lastUsedAt: 0 },
      { id: '3', label: 'Charlie', address: '0x789ghi', lastUsedAt: 0 },
    ];
    
    // Case insensitive match
    expect(filterContacts(contacts, '123ABC')).toEqual([{ id: '1', label: 'Alice', address: '0x123abc', lastUsedAt: 0 }]);
    expect(filterContacts(contacts, '456')).toEqual([{ id: '2', label: 'Bob', address: '0x456def', lastUsedAt: 0 }]);
    expect(filterContacts(contacts, 'DEF')).toEqual([{ id: '2', label: 'Bob', address: '0x456def', lastUsedAt: 0 }]);
  });

  it('returns an empty array when nothing matches', () => {
    const contacts = [
      { id: '1', label: 'Alice', address: '0x123', lastUsedAt: 0 },
      { id: '2', label: 'Bob', address: '0x456', lastUsedAt: 0 },
    ];
    
    const result = filterContacts(contacts, 'nonexistent');
    expect(result).toEqual([]);
  });

  it('handles contacts with an empty/undefined label gracefully', () => {
    const contacts = [
      { id: '1', label: '', address: '0x123abc', lastUsedAt: 0 },
      { id: '2', label: undefined as any, address: '0x456def', lastUsedAt: 0 },
      { id: '3', label: 'Bob', address: '0x789ghi', lastUsedAt: 0 },
    ];
    
    // Should still match by address even if label is empty/undefined
    expect(filterContacts(contacts, '123')).toEqual([{ id: '1', label: '', address: '0x123abc', lastUsedAt: 0 }]);
    expect(filterContacts(contacts, '456')).toEqual([{ id: '2', label: undefined as any, address: '0x456def', lastUsedAt: 0 }]);
  });

  it('matches on both label and address', () => {
    const contacts = [
      { id: '1', label: 'Alice', address: '0x123abc', lastUsedAt: 0 },
      { id: '2', label: 'Bob', address: '0x456def', lastUsedAt: 0 },
      { id: '3', label: 'Charlie', address: '0x789alice', lastUsedAt: 0 },
    ];
    
    // Should match both Alice (by label) and Charlie (by address containing 'alice')
    const result = filterContacts(contacts, 'alice');
    expect(result).toEqual([
      { id: '1', label: 'Alice', address: '0x123abc', lastUsedAt: 0 },
      { id: '3', label: 'Charlie', address: '0x789alice', lastUsedAt: 0 },
    ]);
  });
});
