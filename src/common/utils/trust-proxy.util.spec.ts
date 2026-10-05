import express from 'express';
import request from 'supertest';
import { DEFAULT_TRUST_PROXY, parseTrustProxy } from './trust-proxy.util';

describe('parseTrustProxy', () => {
  it('defaults to loopback, link-local and private networks', () => {
    expect(parseTrustProxy(undefined)).toEqual({ value: DEFAULT_TRUST_PROXY });
    expect(parseTrustProxy('  ')).toEqual({ value: DEFAULT_TRUST_PROXY });
  });

  it('parses a hop count as a number', () => {
    expect(parseTrustProxy('1')).toEqual({ value: 1 });
    expect(parseTrustProxy('2')).toEqual({ value: 2 });
  });

  it('can be switched off', () => {
    expect(parseTrustProxy('false')).toEqual({ value: false });
    expect(parseTrustProxy('0')).toEqual({ value: false });
    expect(parseTrustProxy('off')).toEqual({ value: false });
  });

  it('accepts addresses, CIDR ranges and presets', () => {
    expect(
      parseTrustProxy('172.18.0.0/16, 10.0.0.1,LOOPBACK, fd00::/8'),
    ).toEqual({ value: '172.18.0.0/16, 10.0.0.1, loopback, fd00::/8' });
  });

  it('refuses "true", which would let clients spoof their IP', () => {
    const parsed = parseTrustProxy('true');
    expect(parsed.value).toBe(DEFAULT_TRUST_PROXY);
    expect(parsed.warning).toMatch(/TRUST_PROXY=true/);
  });

  it('falls back to the default for invalid entries', () => {
    const parsed = parseTrustProxy('traefik, 300.1.1.1');
    expect(parsed.value).toBe(DEFAULT_TRUST_PROXY);
    expect(parsed.warning).toContain('traefik');
    expect(parsed.warning).toContain('300.1.1.1');
  });
});

describe('trust proxy with express', () => {
  // supertest connects from loopback — the position of the reverse proxy.
  const appWith = (raw: string | undefined) => {
    const app = express();
    app.set('trust proxy', parseTrustProxy(raw).value);
    app.get('/ip', (req, res) => {
      res.json({ ip: req.ip });
    });
    return app;
  };

  it('uses the client address appended by the proxy', async () => {
    const res = await request(appWith(undefined))
      .get('/ip')
      .set('X-Forwarded-For', '203.0.113.7');
    expect(res.body).toEqual({ ip: '203.0.113.7' });
  });

  it('ignores a forged X-Forwarded-For entry in front of the real one', async () => {
    for (const setting of [undefined, '1']) {
      const res = await request(appWith(setting))
        .get('/ip')
        .set('X-Forwarded-For', '198.51.100.1, 203.0.113.7');
      expect(res.body).toEqual({ ip: '203.0.113.7' });
    }
  });

  it('uses the socket address when disabled', async () => {
    const res = await request(appWith('false'))
      .get('/ip')
      .set('X-Forwarded-For', '203.0.113.7');
    expect(res.body).not.toEqual({ ip: '203.0.113.7' });
  });
});
