import * as crypto from 'crypto';

import {
  buildSignatureHeader,
  computeWebhookSignature,
  generateWebhookSecret,
  verifyWebhookSignature,
  webhookSecretHint,
} from './webhook-signature';

describe('webhook signature', () => {
  const secret = 'whsec_test123';
  const body = '{"id":"evt","type":"order.paid","data":{"order":{"id":"1"}}}';
  const t = 1_731_240_000;

  it('is hex(HMAC-SHA256(secret, `${t}.${body}`)) with the whole secret as key', () => {
    const expected = crypto
      .createHmac('sha256', secret)
      .update(`${t}.${body}`)
      .digest('hex');
    expect(computeWebhookSignature(secret, t, body)).toBe(expected);
    expect(buildSignatureHeader([secret], t, body)).toBe(
      `t=${t},v1=${expected}`,
    );
  });

  it('accepts a valid header within the tolerance and rejects tampering', () => {
    const header = buildSignatureHeader([secret], t, body);
    expect(
      verifyWebhookSignature(secret, header, body, { now: t + 299 }),
    ).toEqual({
      valid: true,
    });
    expect(
      verifyWebhookSignature(secret, header, body.replace('1', '2'), {
        now: t,
      }),
    ).toEqual({ valid: false, reason: 'mismatch' });
    expect(
      verifyWebhookSignature('whsec_other', header, body, { now: t }),
    ).toEqual({
      valid: false,
      reason: 'mismatch',
    });
  });

  it('rejects stale and future timestamps (replay protection)', () => {
    const header = buildSignatureHeader([secret], t, body);
    expect(
      verifyWebhookSignature(secret, header, body, { now: t + 301 }),
    ).toEqual({
      valid: false,
      reason: 'expired',
    });
    expect(
      verifyWebhookSignature(secret, header, body, { now: t - 301 }),
    ).toEqual({
      valid: false,
      reason: 'expired',
    });
  });

  it('rejects malformed headers', () => {
    for (const header of [
      '',
      't=abc,v1=00',
      `t=${t}`,
      `v1=${'a'.repeat(64)}`,
      `t=${t},v1=zz`,
    ]) {
      expect(verifyWebhookSignature(secret, header, body, { now: t })).toEqual({
        valid: false,
        reason: 'malformed',
      });
    }
  });

  it('signs with both secrets during a rotation; either one verifies', () => {
    const next = 'whsec_new456';
    const header = buildSignatureHeader([next, secret], t, body);
    expect(header.split(',')).toHaveLength(3);
    expect(verifyWebhookSignature(next, header, body, { now: t }).valid).toBe(
      true,
    );
    expect(verifyWebhookSignature(secret, header, body, { now: t }).valid).toBe(
      true,
    );
  });

  it('generates whsec_ secrets with 256 bits and a short hint', () => {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    expect(a).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(webhookSecretHint(a)).toBe(`${a.slice(0, 10)}…`);
  });
});
