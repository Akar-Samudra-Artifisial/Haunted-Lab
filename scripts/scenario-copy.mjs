// Test helper: copy a service's src/ with one scenario patch applied, next to the service, so the
// planted fault can be exercised in-process (imports of @haunted-lab/common still resolve through
// the service's node_modules). The copy lives in services/<svc>/.scenario-*/ (git-ignored).
import { randomBytes } from 'node:crypto';
import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { SCENARIO_PATCHES } from './lab-git.mjs';

/**
 * @param {string} serviceDir absolute path of services/<svc>
 * @param {string} scenario 'error-spike' | 'fog' | 'dark-room'
 * @returns {Promise<{ src: string, cleanup: () => Promise<void> }>}
 */
export async function patchedServiceCopy(serviceDir, scenario) {
  const s = SCENARIO_PATCHES.find((p) => p.name === scenario);
  if (!s) throw new Error(`unknown scenario ${scenario}`);
  const service = basename(serviceDir);
  if (s.service !== service) throw new Error(`${scenario} patches ${s.service}, not ${service}`);
  const root = join(serviceDir, `.scenario-${scenario}-${randomBytes(4).toString('hex')}`);
  const src = join(root, 'src');
  await cp(join(serviceDir, 'src'), src, { recursive: true });
  const inService = relative(`services/${service}`, s.file); // e.g. src/refunds.ts
  const file = join(root, inService);
  await writeFile(file, s.patch(await readFile(file, 'utf8'), s.file));
  return { src, cleanup: () => rm(root, { recursive: true, force: true }) };
}
