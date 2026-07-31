import { ethers } from 'ethers';

const ARCNAME_FALLBACK_LOOKUP: Record<string, string> = {
  'jxhan.arc': '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
};

const ARCNAME_PROTOCOL_REGISTRY_ADDRESS = '0x0000000000000000000000000000000000000000';

const ARCNAME_REGISTRY_ABI = [
  'function resolve(string identifier) view returns (address)',
  'function getAddress(string identifier) view returns (address)',
];

const getLiveRegistryResolver = (provider: ethers.Provider) => {
  return new ethers.Contract(ARCNAME_PROTOCOL_REGISTRY_ADDRESS, ARCNAME_REGISTRY_ABI, provider);
};

export const resolveArcName = async (identifier: string, provider: ethers.Provider): Promise<string> => {
  const input = String(identifier).trim();

  if (!input) {
    throw new Error('Enter a recipient address or ArcName handle.');
  }

  const looksLikeAddress = /^0x[a-fA-F0-9]{40}$/.test(input);
  if (looksLikeAddress) {
    return ethers.getAddress(input);
  }

  const normalizedLower = input.toLowerCase();
  if (!normalizedLower.endsWith('.arc')) {
    throw new Error('Enter a valid checksummed address or a handle ending in .arc.');
  }

  const fallbackAddress = ARCNAME_FALLBACK_LOOKUP[normalizedLower];
  if (fallbackAddress) {
    return ethers.getAddress(fallbackAddress);
  }

  try {
    const registry = getLiveRegistryResolver(provider);
    const liveAddress = await registry.resolve(input);
    const normalizedResolvedAddress = typeof liveAddress === 'string' ? liveAddress : '';

    if (normalizedResolvedAddress && /^0x[a-fA-F0-9]{40}$/.test(normalizedResolvedAddress)) {
      return ethers.getAddress(normalizedResolvedAddress);
    }
  } catch {
    // Fall through to the friendly user-facing error below.
  }

  throw new Error(`Unable to resolve ArcName handle "${input}". Supported handles include "jxhan.arc".`);
};
