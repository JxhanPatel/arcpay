import { describe, expect, it } from 'vitest';
import { parseScanPayload } from './App';

describe('parseScanPayload', () => {
  it('parses a direct pay deeplink into a send flow payload', () => {
    const parsed = parseScanPayload('arcpay://pay?id=jxhan.arc');
    expect(parsed).toEqual({
      kind: 'pay',
      id: 'jxhan.arc',
    });
  });

  it('parses a request deeplink into a send-flow payload with amount and note', () => {
    const parsed = parseScanPayload('arcpay://request?id=jxhan.arc&amount=12.5&note=Dinner%20Split');
    expect(parsed).toEqual({
      kind: 'request',
      id: 'jxhan.arc',
      amount: '12.5',
      note: 'Dinner Split',
    });
  });

  it('treats a raw address as a send flow payload', () => {
    const parsed = parseScanPayload('0x742d35Cc6634C0532925a3b844Bc454e4438f44e');
    expect(parsed).toEqual({
      kind: 'address',
      id: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
    });
  });
});
