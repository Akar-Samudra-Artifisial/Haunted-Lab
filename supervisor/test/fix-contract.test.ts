import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  deployFixAllowed,
  MANIFEST_FILES,
  MAX_BLOB_BYTES,
  MAX_TOTAL_BYTES,
  validateDeployFixBody,
  type ChainCommit,
  type DeployFixInput,
  type FileChange,
} from '../src/fix-contract.ts';
import { SERVICES } from '../src/types.ts';

const hex40 = fc.stringMatching(/^[0-9a-f]{40}$/);
const cuid = fc.stringMatching(/^c[a-z0-9]{24}$/);
const GOOD = { service: 'payments', ref: 'incident/c000000000000000000000001', sha: 'a'.repeat(40) };

describe('validateDeployFixBody', () => {
  it('accepts the contract body and rejects edge cases', () => {
    expect(validateDeployFixBody(GOOD)).toEqual({ ok: true, request: GOOD });
    for (const bad of [
      null,
      [],
      'x',
      { ...GOOD, extra: 1 },
      { service: 'payments', ref: GOOD.ref },
      { ...GOOD, service: 'vault' },
      { ...GOOD, ref: 'incident/C000000000000000000000001' },
      { ...GOOD, ref: 'incident/c00000000000000000000000;rm' },
      { ...GOOD, ref: '--upload-pack=touch' },
      { ...GOOD, ref: 'incident/../main' },
      { ...GOOD, ref: `${GOOD.ref}\n` },
      { ...GOOD, ref: 'exorcist/c000000000000000000000001' },
      { ...GOOD, sha: 'A'.repeat(40) },
      { ...GOOD, sha: 'a'.repeat(39) },
      { ...GOOD, sha: 7 },
    ]) {
      expect(validateDeployFixBody(bad)).toEqual({ ok: false });
    }
  });

  // Feature: fix-deploy, Property 2
  it('is total and exact for any value', () => {
    const val = fc.oneof(
      fc.constantFrom(...SERVICES, 'vault', ''),
      cuid.map((c) => `incident/${c}`),
      hex40,
      fc.string({ maxLength: 60 }),
      fc.integer(),
      fc.constant(null),
    );
    const body = fc.oneof(
      fc.record({ service: val, ref: val, sha: val }),
      fc.dictionary(fc.constantFrom('service', 'ref', 'sha', 'x'), val),
      fc.anything(),
    );
    fc.assert(
      fc.property(body, (b) => {
        let out: ReturnType<typeof validateDeployFixBody> | undefined;
        expect(() => (out = validateDeployFixBody(b))).not.toThrow();
        const o = b as Record<string, unknown>;
        const expected =
          typeof b === 'object' &&
          b !== null &&
          !Array.isArray(b) &&
          Object.keys(b).sort().join() === 'ref,service,sha' &&
          (SERVICES as readonly unknown[]).includes(o.service) &&
          typeof o.ref === 'string' &&
          /^incident\/c[a-z0-9]{24}$/.test(o.ref) &&
          typeof o.sha === 'string' &&
          /^[0-9a-f]{40}$/.test(o.sha);
        expect(out?.ok).toBe(expected);
        if (out?.ok) {
          const ref = out.request.ref;
          // eslint-disable-next-line no-control-regex
          expect(ref.includes('..') || ref.startsWith('-') || /[\s:\x00-\x1f]/.test(ref)).toBe(false);
        }
      }),
      { numRuns: 1000 },
    );
  });
});

// ---- model for Property 1 ----
const change = (path: string, extra: Partial<FileChange> = {}): FileChange => ({
  path,
  status: 'M',
  oldMode: '100644',
  newMode: '100644',
  binary: false,
  added: 1,
  deleted: 1,
  ...extra,
});

const pathArb = (service: string) =>
  fc.oneof(
    { weight: 6, arbitrary: fc.constantFrom(`services/${service}/src/a.ts`, `services/${service}/src/b.ts`, `services/${service}/README.md`) },
    fc.constantFrom('services/orders/src/a.ts', 'services/gate/src/x.ts', 'packages/lab-common/src/http.ts', 'supervisor/src/app.ts', 'README.md', `services/${service}x/a.ts`),
    fc.constantFrom(`services/${service}/package.json`, 'package.json', 'pnpm-lock.yaml', `services/${service}/yarn.lock`, `services/${service}/node_modules/x/index.js`, `services/${service}/src/node_modules/y.ts`),
  );

const changeArb = (service: string) =>
  fc.record({
    path: pathArb(service),
    oldPath: fc.option(pathArb(service), { nil: undefined }),
    kind: fc.constantFrom('plain', 'plain', 'plain', 'plain', 'binary', 'symlink', 'submodule', 'modechange', 'type', 'newexec', 'added'),
    size: fc.oneof({ weight: 5, arbitrary: fc.integer({ min: 0, max: 4096 }) }, fc.integer({ min: 60_000, max: 70_000 })),
  }).map(({ path, oldPath, kind, size }) => {
    const c = change(path, oldPath ? { oldPath, status: 'R' } : {});
    c.size = size;
    if (kind === 'newexec') Object.assign(c, { status: 'A', oldMode: '000000', newMode: '100755' });
    if (kind === 'added') Object.assign(c, { status: 'A', oldMode: '000000', newMode: '100644' });
    if (kind === 'binary') c.binary = true;
    if (kind === 'symlink') c.newMode = '120000';
    if (kind === 'submodule') c.oldMode = '160000';
    if (kind === 'modechange') c.newMode = '100755';
    if (kind === 'type') c.status = 'T';
    return c;
  });

function expectedDecision(i: DeployFixInput) {
  if (i.sha !== i.head) return { ok: false, status: 409, code: 'not_head' };
  if (i.allowedHeads.includes(i.sha)) return { ok: false, status: 409, code: 'empty_fix' };
  if (i.chain.length > 20) return { ok: false, status: 409, code: 'chain_too_long' };
  if (i.reachedHead === null || !i.allowedHeads.includes(i.reachedHead)) return { ok: false, status: 409, code: i.rootReached ? 'no_allowed_base' : 'chain_too_long' };
  const prefix = `services/${i.service}/`;
  const manifest = (p: string) => MANIFEST_FILES.includes(p.split('/').at(-1) ?? '') || p.split('/').includes('node_modules');
  for (const c of i.chain) {
    for (const f of c.changes) {
      const special =
        f.binary || ['120000', '160000'].includes(f.oldMode) || ['120000', '160000'].includes(f.newMode) || f.status === 'T' || (f.oldMode === '000000' && f.newMode === '100755') || (f.oldMode !== '000000' && f.newMode !== '000000' && f.oldMode !== f.newMode);
      if (special) return { ok: false, status: 422, code: 'binary_or_special_change' };
      if (manifest(f.path) || (f.oldPath && manifest(f.oldPath))) return { ok: false, status: 422, code: 'manifest_change' };
      if (!f.path.startsWith(prefix) || (f.oldPath && !f.oldPath.startsWith(prefix))) return { ok: false, status: 422, code: 'outside_service' };
    }
  }
  if (i.chain.some((c) => c.changes.some((f) => (f.size ?? 0) > MAX_BLOB_BYTES))) return { ok: false, status: 422, code: 'diff_too_large' };
  if ((i.totalBytes ?? 0) > MAX_TOTAL_BYTES) return { ok: false, status: 422, code: 'diff_too_large' };
  if (i.totalLines > 400) return { ok: false, status: 422, code: 'diff_too_large' };
  return { ok: true, base: i.reachedHead };
}

describe('deployFixAllowed', () => {
  const base = (over: Partial<DeployFixInput> = {}): DeployFixInput => ({
    head: 'f'.repeat(40),
    sha: 'f'.repeat(40),
    chain: [{ sha: 'f'.repeat(40), parents: ['1'.repeat(40)], changes: [change('services/payments/src/refunds.ts')] }],
    reachedHead: '1'.repeat(40),
    rootReached: false,
    totalLines: 4,
    allowedHeads: ['1'.repeat(40), '2'.repeat(40)],
    service: 'payments',
    ...over,
  });

  it('accepts a clean fix and refuses each rule with its code', () => {
    expect(deployFixAllowed(base())).toEqual({ ok: true, base: '1'.repeat(40) });
    expect(deployFixAllowed(base({ sha: 'e'.repeat(40) }))).toMatchObject({ status: 409, code: 'not_head' });
    expect(deployFixAllowed(base({ sha: '1'.repeat(40), head: '1'.repeat(40) }))).toMatchObject({ status: 409, code: 'empty_fix' });
    expect(deployFixAllowed(base({ reachedHead: null }))).toMatchObject({ status: 409, code: 'chain_too_long' });
    expect(deployFixAllowed(base({ reachedHead: null, rootReached: true }))).toMatchObject({ status: 409, code: 'no_allowed_base' });
    const chain21: ChainCommit[] = Array.from({ length: 21 }, (_, n) => ({ sha: String(n), parents: [], changes: [] }));
    expect(deployFixAllowed(base({ chain: chain21 }))).toMatchObject({ status: 409, code: 'chain_too_long' });
    const one = (c: FileChange) => base({ chain: [{ sha: 'f'.repeat(40), parents: [], changes: [c] }] });
    expect(deployFixAllowed(one(change('services/orders/src/a.ts')))).toMatchObject({ status: 422, code: 'outside_service' });
    expect(deployFixAllowed(one(change('services/payments/src/a.ts', { oldPath: 'services/orders/src/a.ts', status: 'R' })))).toMatchObject({ code: 'outside_service' });
    expect(deployFixAllowed(one(change('services/payments/package.json')))).toMatchObject({ status: 422, code: 'manifest_change' });
    expect(deployFixAllowed(one(change('services/payments/a.bin', { binary: true })))).toMatchObject({ code: 'binary_or_special_change' });
    expect(deployFixAllowed(one(change('services/payments/link', { newMode: '120000' })))).toMatchObject({ code: 'binary_or_special_change' });
    expect(deployFixAllowed(one(change('services/payments/run.sh', { newMode: '100755' })))).toMatchObject({ code: 'binary_or_special_change' });
    expect(deployFixAllowed(one(change('services/payments/new.ts', { status: 'A', oldMode: '000000' })))).toEqual({ ok: true, base: '1'.repeat(40) });
    expect(deployFixAllowed(base({ totalLines: 401 }))).toMatchObject({ status: 422, code: 'diff_too_large' });
    expect(deployFixAllowed(base({ totalLines: 400 }))).toMatchObject({ ok: true });
    // review fixes: node_modules paths, new executables, blob and total size caps
    expect(deployFixAllowed(one(change('services/payments/node_modules/evil/index.js', { status: 'A', oldMode: '000000' })))).toMatchObject({ status: 422, code: 'manifest_change' });
    expect(deployFixAllowed(one(change('services/payments/src/node_modules/x.ts')))).toMatchObject({ code: 'manifest_change' });
    expect(deployFixAllowed(one(change('services/payments/run.sh', { status: 'A', oldMode: '000000', newMode: '100755' })))).toMatchObject({ status: 422, code: 'binary_or_special_change' });
    expect(deployFixAllowed(one(change('services/payments/src/big.ts', { size: MAX_BLOB_BYTES + 1 })))).toMatchObject({ status: 422, code: 'diff_too_large' });
    expect(deployFixAllowed(one(change('services/payments/src/ok.ts', { size: MAX_BLOB_BYTES })))).toMatchObject({ ok: true });
    expect(deployFixAllowed(base({ totalBytes: MAX_TOTAL_BYTES + 1 }))).toMatchObject({ status: 422, code: 'diff_too_large' });
    expect(deployFixAllowed(base({ totalBytes: MAX_TOTAL_BYTES }))).toMatchObject({ ok: true });
  });

  // Feature: fix-deploy, Property 1
  it('accepts exactly a clean chain from the head to an allowed head, else the first failing rule', () => {
    const heads = ['1'.repeat(40), '2'.repeat(40), '3'.repeat(40)];
    const inputArb = fc
      .record({
        service: fc.constantFrom(...SERVICES),
        headIsSha: fc.boolean(),
        sha: fc.oneof(hex40, fc.constantFrom(...heads)),
        other: hex40,
        chainLen: fc.oneof(fc.integer({ min: 0, max: 4 }), fc.integer({ min: 18, max: 23 })),
        reached: fc.oneof(fc.constantFrom(...heads), fc.constant(null), hex40),
        rootReached: fc.boolean(),
        totalLines: fc.oneof(fc.integer({ min: 0, max: 400 }), fc.integer({ min: 401, max: 5000 })),
        totalBytes: fc.oneof({ weight: 4, arbitrary: fc.integer({ min: 0, max: 256 * 1024 }) }, fc.integer({ min: 256 * 1024 + 1, max: 1e6 })),
        seed: fc.integer(),
      })
      .chain((r) =>
        fc.array(fc.array(changeArb(r.service), { maxLength: 3 }), { minLength: r.chainLen, maxLength: r.chainLen }).map((changes) => {
          const input: DeployFixInput = {
            head: r.headIsSha ? r.sha : r.other,
            sha: r.sha,
            chain: changes.map((c, n) => ({ sha: `${n}`, parents: [], changes: c })),
            reachedHead: r.reached,
            rootReached: r.rootReached,
            totalLines: r.totalLines,
            totalBytes: r.totalBytes,
            allowedHeads: heads,
            service: r.service,
          };
          return input;
        }),
      );
    fc.assert(
      fc.property(inputArb, (input) => {
        expect(deployFixAllowed(input)).toEqual(expectedDecision(input));
      }),
      { numRuns: 1000 },
    );
  });
});
