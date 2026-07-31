import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { resolveArcName } from './utils/arcName';

describe('resolveArcName', () => {
  const provider = new ethers.JsonRpcProvider('https://5042002.rpc.thirdweb.com');

  it('returns a valid EVM address immediately', async () => {
    const address = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e';
    await expect(resolveArcName(address, provider)).resolves.toBe(address);
  });

  it('resolves a supported .arc handle through the fallback registry', async () => {
    await expect(resolveArcName('jxhan.arc', provider)).resolves.toBe('0x742d35Cc6634C0532925a3b844Bc454e4438f44e');
  });

  it('throws a user-friendly error for unsupported or malformed handles', async () => {
    await expect(resolveArcName('unknown.arc', provider)).rejects.toThrow('Unable to resolve ArcName handle "unknown.arc"');
  });
});
