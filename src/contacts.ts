import { ethers } from 'ethers';

export type Contact = {
  id: string;
  label: string;
  address: string;
  lastUsedAt: number;
};

export const CONTACTS_STORAGE_KEY = 'arc_contacts';

const normalizeAddress = (value: string) => {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) {
    return '';
  }

  try {
    return ethers.getAddress(trimmed);
  } catch {
    return '';
  }
};

const getStorage = (): Storage | null => {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }

    if ('localStorage' in globalThis && globalThis.localStorage) {
      return globalThis.localStorage;
    }
  } catch {
    // Ignore storage access errors and fall back to an empty list.
  }

  return null;
};

const sortContacts = (items: Contact[]) => {
  return [...items].sort((left, right) => (right.lastUsedAt ?? 0) - (left.lastUsedAt ?? 0));
};

export const getContacts = (): Contact[] => {
  const storage = getStorage();
  if (!storage) {
    return [];
  }

  try {
    const raw = storage.getItem(CONTACTS_STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    const nextContacts = parsed.flatMap((item) => {
      if (typeof item !== 'object' || item === null) {
        return [];
      }

      const candidate = item as Partial<Record<string, unknown>>;
      const normalizedAddress = normalizeAddress(String(candidate.address ?? ''));
      if (!normalizedAddress) {
        return [];
      }

      const label = typeof candidate.label === 'string' ? candidate.label.trim() : '';
      const lastUsedAt = Number(candidate.lastUsedAt ?? 0);

      return [{
        id: normalizedAddress,
        label,
        address: normalizedAddress,
        lastUsedAt: Number.isFinite(lastUsedAt) ? lastUsedAt : 0,
      } satisfies Contact];
    });

    return sortContacts(nextContacts);
  } catch {
    return [];
  }
};

export const saveContact = (address: string, label?: string): Contact[] => {
  const normalizedAddress = normalizeAddress(address);
  if (!normalizedAddress) {
    return getContacts();
  }

  const storage = getStorage();
  const nextLabel = typeof label === 'string' ? label.trim() : '';
  const existingContacts = getContacts();
  const matchIndex = existingContacts.findIndex((contact) => contact.address.toLowerCase() === normalizedAddress.toLowerCase());

  const nextContacts = [...existingContacts];
  const nextEntry: Contact = {
    id: normalizedAddress,
    label: nextLabel || existingContacts[matchIndex]?.label || '',
    address: normalizedAddress,
    lastUsedAt: Date.now(),
  };

  if (matchIndex >= 0) {
    nextContacts[matchIndex] = nextEntry;
  } else {
    nextContacts.push(nextEntry);
  }

  const sortedContacts = sortContacts(nextContacts);

  if (storage) {
    try {
      storage.setItem(CONTACTS_STORAGE_KEY, JSON.stringify(sortedContacts));
    } catch {
      // Ignore write failures for unavailable localStorage.
    }
  }

  return sortedContacts;
};

export const removeContact = (address: string): Contact[] => {
  const normalizedAddress = normalizeAddress(address);
  if (!normalizedAddress) {
    return getContacts();
  }

  const storage = getStorage();
  const remainingContacts = getContacts().filter((contact) => contact.address.toLowerCase() !== normalizedAddress.toLowerCase());

  if (storage) {
    try {
      storage.setItem(CONTACTS_STORAGE_KEY, JSON.stringify(remainingContacts));
    } catch {
      // Ignore write failures for unavailable localStorage.
    }
  }

  return remainingContacts;
};

export const formatContactLabel = (contact: Contact): string => {
  const normalizedLabel = String(contact.label ?? '').trim();
  if (normalizedLabel) {
    return normalizedLabel;
  }

  const address = String(contact.address ?? '').trim();
  if (!address) {
    return 'Unknown';
  }

  if (address.length <= 10) {
    return address;
  }

  return `${address.slice(0, 6)}...${address.slice(-4)}`;
};
