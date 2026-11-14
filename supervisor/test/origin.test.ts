import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '@haunted-lab/common';
import { DEFAULT_ORIGIN_URL, parseOriginUrl } from '../src/origin.ts';

const accepts = (v: string, allowFile = false) => {
  try {
    parseOriginUrl(v, allowFile);
    return true;
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    expect((e as Error).message).toBe('invalid env: LAB_ORIGIN_URL');
    return false;
  }
};

describe('parseOriginUrl', () => {
  it('accepts plain public https and, only when allowed, absolute file URLs', () => {
    expect(accepts(DEFAULT_ORIGIN_URL)).toBe(true);
    expect(accepts('https://git.example.org/lab')).toBe(true);
    for (const bad of [
      'http://github.com/a/b.git',
      'https://user:pw@github.com/a/b.git',
      'https://token@github.com/a/b.git',
      'https://github.com/a/b.git?x=1',
      'https://github.com/a/b.git#x',
      'https://127.0.0.1/a.git',
      'https://0x7f000001/a.git',
      'https://[::1]/a.git',
      'https://localhost/a.git',
      'ssh://git@github.com/a/b.git',
      'git@github.com:a/b.git',
      'ext::sh -c touch% /tmp/x',
      'file:///tmp/x.git',
      'https://github.com/a b',
      '',
    ]) {
      expect(accepts(bad), bad).toBe(false);
    }
    expect(accepts('file:///tmp/x.git', true)).toBe(true);
    expect(accepts('file://host/tmp/x.git', true)).toBe(false);
  });

  // Feature: fix-deploy, Property 4
  it('accepts exactly plain https with a non-IP host (or file URLs when allowed), never echoing the value', () => {
    const host = fc.oneof(
      fc.stringMatching(/^[a-z][a-z0-9-]{0,10}\.[a-z]{2,6}$/),
      fc.constantFrom('127.0.0.1', '10.0.0.1', '[::1]', 'localhost', '0x7f.1'),
    );
    const urlArb = fc.oneof(
      fc.record({
        scheme: fc.constantFrom('https', 'http', 'ssh', 'file', 'git'),
        userinfo: fc.constantFrom('', 'u@', 'u:p@'),
        host,
        path: fc.stringMatching(/^\/[A-Za-z0-9._/-]{0,20}$/),
        suffix: fc.constantFrom('', '', '?q=1', '#f'),
      }).map((r) => `${r.scheme}://${r.userinfo}${r.host}${r.path}${r.suffix}`),
      fc.string({ maxLength: 40 }),
    );
    fc.assert(
      fc.property(urlArb, fc.boolean(), (v, allowFile) => {
        let expected = false;
        try {
          const u = new URL(v);
          const plain = !u.username && !u.password && !u.search && !u.hash && !v.includes('?') && !v.includes('#') && !/[\s\x00-\x1f\x7f]/.test(v); // eslint-disable-line no-control-regex
          const ipOrLocal = u.hostname.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname) || !u.hostname.includes('.');
          if (u.protocol === 'https:') expected = plain && u.hostname !== '' && !ipOrLocal;
          else if (u.protocol === 'file:') expected = allowFile && plain && u.host === '' && u.pathname.length > 1;
        } catch {
          expected = false;
        }
        expect(accepts(v, allowFile)).toBe(expected);
      }),
      { numRuns: 1000 },
    );
  });
});
