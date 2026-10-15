import { describe, expect, it } from 'vitest';
import { parseNativeBalance, parseTokenBalances } from './balance';

describe('parseNativeBalance', () => {
  it('parses native balance from address endpoint response at 18 decimals', () => {
    const fixture = {
      "block_number_balance_updated_at": 56265081,
      "coin_balance": "35360050196662244098162422",
      "hash": "0xD4c0B787aA2ff9Eb751Bb515c877EbBF2Daddaae",
      "creation_status": null,
      "creation_transaction_hash": null,
    };

    const result = parseNativeBalance(fixture, '0xD4c0B787aA2ff9Eb751Bb515c877EbBF2Daddaae');

    expect(result).toEqual({
      address: '0xD4c0B787aA2ff9Eb751Bb515c877EbBF2Daddaae',
      coinBalance: 35360050196662244098162422n,
      coinBalanceFormatted: '35360050.196662244098162422',
      decimals: 18,
      updatedAt: expect.any(Number),
    });
  });

  it('handles missing coin_balance gracefully', () => {
    const fixture = {
      "hash": "0xD4c0B787aA2ff9Eb751Bb515c877EbBF2Daddaae",
    };

    const result = parseNativeBalance(fixture, '0xD4c0B787aA2ff9Eb751Bb515c877EbBF2Daddaae');

    expect(result).toBeNull();
  });
});

describe('parseTokenBalances', () => {
  it('parses USDC token balance from token-balances endpoint at 6 decimals', () => {
    const fixture = [
      {
        "token": {
          "address_hash": "0x1234567890123456789012345678901234567890",
          "symbol": "USDC",
          "decimals": "6",
          "name": "USD Coin",
          "type": "ERC-20"
        },
        "value": "35359990191014"
      }
    ];

    const result = parseTokenBalances(fixture, '0xD4c0B787aA2ff9Eb751Bb515c877EbBF2Daddaae');

    expect(result).toEqual([
      {
        address: '0xD4c0B787aA2ff9Eb751Bb515c877EbBF2Daddaae',
        tokenAddress: '0x1234567890123456789012345678901234567890',
        symbol: 'USDC',
        balance: 35359990191014n,
        balanceFormatted: '35359990.191014',
        decimals: 6,
      }
    ]);
  });

  it('handles multiple token balances correctly', () => {
    const fixture = [
      {
        "token": {
          "address_hash": "0x1234567890123456789012345678901234567890",
          "symbol": "USDC",
          "decimals": "6",
          "name": "USD Coin",
          "type": "ERC-20"
        },
        "value": "35359990191014"
      },
      {
        "token": {
          "address_hash": "0xabcdef1234567890abcdef1234567890abcdef12",
          "symbol": "EURC",
          "decimals": "6",
          "name": "Euro Coin",
          "type": "ERC-20"
        },
        "value": "1000000000000"
      }
    ];

    const result = parseTokenBalances(fixture, '0xD4c0B787aA2ff9Eb751Bb515c877EbBF2Daddaae');

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      symbol: 'USDC',
      balance: 35359990191014n,
      balanceFormatted: '35359990.191014',
      decimals: 6,
    });
    expect(result[1]).toMatchObject({
      symbol: 'EURC',
      balance: 1000000000000n,
      balanceFormatted: '1000000',
      decimals: 6,
    });
  });

  it('filters out tokens without symbol or value', () => {
    const fixture = [
      {
        "token": {
          "address_hash": "0x1234567890123456789012345678901234567890",
          "symbol": "USDC",
          "decimals": "6",
          "name": "USD Coin",
          "type": "ERC-20"
        },
        "value": "35359990191014"
      },
      {
        "token": {
          "address_hash": "0xabcdef1234567890abcdef1234567890abcdef12",
          "symbol": "", // Empty symbol
          "decimals": "6",
          "name": "Invalid Token",
          "type": "ERC-20"
        },
        "value": "1000000000000"
      },
      {
        "token": {
          "address_hash": "0xdeadbeef1234567890deadbeef1234567890dead",
          "symbol": "VALID",
          "decimals": "18",
          "name": "Valid Token",
          "type": "ERC-20"
        },
        "value": "" // Empty value
      }
    ];

    const result = parseTokenBalances(fixture, '0xD4c0B787aA2ff9Eb751Bb515c877EbBF2Daddaae');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      symbol: 'USDC',
      balance: 35359990191014n,
      balanceFormatted: '35359990.191014',
      decimals: 6,
    });
  });
});