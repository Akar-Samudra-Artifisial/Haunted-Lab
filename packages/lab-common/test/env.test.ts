import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ConfigError, parseEnv } from '../src/index.ts';

describe('parseEnv', () => {
  const spec = {
    A_PORT: { kind: 'port' as const },
    HOST: { kind: 'host' as const, default: '127.0.0.1' },
    NEXT: { kind: 'url' as const, required: false },
  };

  it('parses defaults and values', () => {
    expect(parseEnv(spec, { A_PORT: '4001' })).toEqual({ A_PORT: '4001', HOST: '127.0.0.1' });
  });

  it('reports missing and invalid NAMES only', () => {
    try {
      parseEnv(spec, { NEXT: 'not a url' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).message).toBe('missing required env: A_PORT; invalid env: NEXT');
    }
  });

  // Feature: haunted-lab, Property 13
  it('never echoes env values in errors', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 6, maxLength: 30 }).filter((s) => !/^[A-Za-z0-9_ :,;.-]*$/.test(s) || s.length > 8), (value) => {
        const marker = `zz${value}zz`;
        try {
          parseEnv(spec, { A_PORT: marker, NEXT: marker });
        } catch (e) {
          expect((e as Error).message).not.toContain(marker);
          return;
        }
        expect.unreachable();
      }),
      { numRuns: 100 },
    );
  });
});
