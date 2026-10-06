import type { Event } from '@sentry/nestjs';
import {
  filterReportHeaders,
  reportUser,
  scrubSentryBreadcrumb,
  scrubSentryEvent,
  stripQueryString,
} from './sentry-scrub.util';

describe('sentry-scrub.util', () => {
  describe('stripQueryString', () => {
    it('removes query string and fragment', () => {
      expect(stripQueryString('/api/x?token=abc#f')).toBe('/api/x');
      expect(stripQueryString('https://example.org/a?b=1')).toBe(
        'https://example.org/a',
      );
      expect(stripQueryString('/plain')).toBe('/plain');
      expect(stripQueryString(undefined)).toBeUndefined();
    });
  });

  describe('filterReportHeaders', () => {
    it('keeps only allowlisted headers', () => {
      expect(
        filterReportHeaders({
          'User-Agent': 'UA',
          'accept-language': 'de-DE',
          referer: 'https://example.org/de/device?token=secret',
          cookie: 'session=abc',
          authorization: 'Bearer xyz',
          'x-device-token': 'dev-123',
          'set-cookie': ['a=1', 'b=2'],
          'x-forwarded-for': '203.0.113.7',
          'x-api-key': 'key',
        }),
      ).toEqual({
        'user-agent': 'UA',
        'accept-language': 'de-DE',
        referer: 'https://example.org/de/device',
      });
      expect(filterReportHeaders(undefined)).toEqual({});
    });
  });

  describe('reportUser', () => {
    it('keeps only the id', () => {
      expect(reportUser({ id: 'u1' })).toEqual({ id: 'u1' });
      expect(reportUser(undefined)).toBeNull();
      expect(reportUser({ id: '' })).toBeNull();
    });
  });

  describe('scrubSentryEvent', () => {
    it('removes cookies, body, query, ip and e-mail', () => {
      const event: Event = {
        request: {
          url: 'https://api.example.org/api/x?token=abc',
          method: 'POST',
          query_string: 'token=abc',
          cookies: { session: 'abc' },
          data: { password: 'pw' },
          env: { REMOTE_ADDR: '203.0.113.7' },
          headers: {
            cookie: 'session=abc',
            authorization: 'Bearer x',
            'x-device-token': 't',
            'user-agent': 'UA',
          },
        },
        user: {
          id: 'u1',
          email: 'a@example.org',
          ip_address: '203.0.113.7',
          username: 'a',
        },
        tags: { url: '/api/x?token=abc', method: 'POST' },
        breadcrumbs: [
          {
            category: 'http',
            data: { url: 'https://x.example/y?k=1', 'http.query': 'k=1' },
          },
        ],
        contexts: {
          trace: {
            trace_id: 't',
            span_id: 's',
            data: { 'http.target': '/api/x?token=abc', 'url.query': 'a' },
          },
        },
        spans: [
          {
            span_id: 's2',
            trace_id: 't',
            start_timestamp: 0,
            data: { 'http.url': 'https://x.example/y?k=1' },
          },
        ],
      };

      const result = scrubSentryEvent(event);

      expect(result).toBe(event);
      expect(result.request).toEqual({
        url: 'https://api.example.org/api/x',
        method: 'POST',
        headers: { 'user-agent': 'UA' },
      });
      expect(result.user).toEqual({ id: 'u1' });
      expect(result.tags).toEqual({ url: '/api/x', method: 'POST' });
      expect(result.breadcrumbs?.[0].data).toEqual({
        url: 'https://x.example/y',
      });
      expect(result.contexts?.trace?.data).toEqual({ 'http.target': '/api/x' });
      expect(result.spans?.[0].data).toEqual({
        'http.url': 'https://x.example/y',
      });
    });

    it('drops user data without id', () => {
      const result = scrubSentryEvent({ user: { ip_address: '203.0.113.7' } });
      expect(result.user).toBeUndefined();
    });
  });

  describe('scrubSentryBreadcrumb', () => {
    it('strips query strings from navigation data', () => {
      expect(
        scrubSentryBreadcrumb({ data: { from: '/a?x=1', to: '/b#y' } }).data,
      ).toEqual({ from: '/a', to: '/b' });
    });
  });
});
