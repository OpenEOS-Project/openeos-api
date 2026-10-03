import * as crypto from 'crypto';

import { ShiftsService } from './shifts.service';

jest.mock('uuid', () => ({
  v4: () => jest.requireActual<typeof import('crypto')>('crypto').randomUUID(),
}));

jest.mock('crypto', () => {
  const actual = jest.requireActual<typeof import('crypto')>('crypto');
  return { ...actual, randomBytes: jest.fn(actual.randomBytes) };
});

const none = {} as never;

function generateToken(): string {
  const service = new ShiftsService(none, none, none, none, none, none, none);
  // generateToken is private; the format is what matters for the columns.
  return (service as unknown as { generateToken(): string }).generateToken();
}

describe('ShiftsService.generateToken', () => {
  afterEach(() => jest.mocked(crypto.randomBytes).mockClear());

  it('produces 64 characters from [0-9a-z], as before', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generateToken()).toMatch(/^[0-9a-z]{64}$/);
    }
  });

  it('draws from crypto.randomBytes', () => {
    generateToken();
    expect(crypto.randomBytes).toHaveBeenCalled();
  });

  it('skips bytes that would bias the alphabet', () => {
    const randomBytes = jest.mocked(crypto.randomBytes) as unknown as jest.Mock;
    // First batch: only rejected bytes; then bytes that all map to "1".
    randomBytes
      .mockImplementationOnce(() => Buffer.alloc(64, 255))
      .mockImplementationOnce(() => Buffer.alloc(64, 37));

    expect(generateToken()).toBe('1'.repeat(64));
    expect(randomBytes).toHaveBeenCalledTimes(2);
  });

  it('does not repeat', () => {
    const tokens = new Set(Array.from({ length: 200 }, generateToken));
    expect(tokens.size).toBe(200);
  });
});
