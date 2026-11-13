import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { cleanDiff, cleanField, FIELD_CAPS, stripControls, stripPaths } from '../src/untrusted.ts';

// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f-\x9f]/;
// Synthetic home roots, built at run time so no home-like path literal sits in the repo.
const MAC_HOME = ['', 'Users', 'someone'].join('/');
const LINUX_HOME = ['', 'home', 'someone'].join('/');

describe('untrusted text', () => {
  it('removes ANSI escapes and control characters', () => {
    expect(stripControls('\x1b[31mred\x1b[0m done')).toBe('red done');
    expect(stripControls('a\x1b]0;title\x07b')).toBe('ab');
    expect(stripControls('x\x00y\u0085z\x7f')).toBe('x y z ');
    expect(stripControls('one\ntwo\tthree')).toBe('one two three');
    expect(cleanDiff('+line\n-\x1b[2Kold\r\n\tx')).toBe('+line\n-old\n\tx');
  });

  it('single-line fields never contain a control character, for any input', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 400 }), fc.constantFrom(...(Object.keys(FIELD_CAPS) as (keyof typeof FIELD_CAPS)[])), (s, field) => {
        const out = cleanField(s, field);
        expect(CONTROL.test(out)).toBe(false);
        expect(out.length).toBeLessThanOrEqual(FIELD_CAPS[field]);
      }),
      { numRuns: 300 },
    );
    expect(cleanField(42, 'message')).toBe('');
  });

  it('strips every absolute path: repo files, dependencies and anything else', () => {
    expect(stripPaths('at refundTerms (file:///private/tmp/x/wt/payments@abc/services/payments/src/refunds.ts:31:31)')).toBe(
      'at refundTerms (services/payments/src/refunds.ts:31:31)',
    );
    expect(stripPaths('at Counter.inc (/srv/lab/node_modules/.pnpm/prom-client@15.1.3/node_modules/prom-client/lib/counter.js:49:10)')).toBe(
      'at Counter.inc (node_modules/prom-client/lib/counter.js:49:10)',
    );
    expect(stripPaths(`at x (${LINUX_HOME}/lab/packages/lab-common/src/http.ts:5:1)`)).toBe('at x (packages/lab-common/src/http.ts:5:1)');
    expect(stripPaths(`ENOENT: no such file, open '${MAC_HOME}/secret/notes.txt'`)).toBe("ENOENT: no such file, open 'notes.txt'");
    expect(stripPaths('at main (/opt/app/dist/main.mjs:1:2)')).toBe('at main (main.mjs:1:2)');
    // Routes and other non-filesystem slashes are left alone.
    expect(stripPaths('req POST /checkout 502 12ms rid=r-1')).toBe('req POST /checkout 502 12ms rid=r-1');
    expect(stripPaths('downstream /ledger/entries unreachable')).toBe('downstream /ledger/entries unreachable');
  });

  it('no home or temp path survives, whatever surrounds it', () => {
    const seg = fc.stringMatching(/^[A-Za-z0-9._@-]{1,12}$/);
    fc.assert(
      fc.property(
        fc.constantFrom(MAC_HOME.slice(0, -'/someone'.length), LINUX_HOME.slice(0, -'/someone'.length), '/private/tmp', '/tmp', '/var/folders'),
        fc.array(seg, { minLength: 1, maxLength: 5 }),
        fc.string({ maxLength: 30 }),
        fc.string({ maxLength: 30 }),
        (root, segs, before, after) => {
          const path = `${root}/${segs.join('/')}`;
          const out = cleanField(`${before} (${path}:1:2) ${after}`, 'line');
          expect(out).not.toContain(`${root}/`);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('bounds the input before any regex runs', () => {
    const huge = `${`${MAC_HOME}/`.repeat(100_000)}end`;
    const t0 = performance.now();
    const out = cleanField(huge, 'frame');
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(out.length).toBeLessThanOrEqual(FIELD_CAPS.frame);
  });
});
