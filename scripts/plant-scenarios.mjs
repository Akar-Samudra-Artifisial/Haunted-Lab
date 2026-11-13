#!/usr/bin/env node
// Plant the three scenario branches (scenario/error-spike, scenario/fog, scenario/dark-room),
// each exactly one commit on top of `main`, with a fixed identity and fixed dates.
// Idempotent: re-running leaves the branches and SHAs unchanged. Never moves `main`, never pushes.
//
// Usage: node scripts/plant-scenarios.mjs [--repo <dir>]
//   Without --repo it plants in this checkout and records { base, shas } in scripts/scenario-shas.json.
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { plantScenarios } from './lab-git.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const checkout = resolve(here, '..');

const { values } = parseArgs({ options: { repo: { type: 'string' } } });
const repo = resolve(values.repo ?? checkout);

try {
  const result = await plantScenarios(repo);
  if (repo === checkout) {
    const record = { base: result.base, shas: result.shas };
    await writeFile(join(here, 'scenario-shas.json'), `${JSON.stringify(record, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify({ base: result.base, shas: result.shas, changed: result.changed })}\n`);
} catch (err) {
  process.stderr.write(`plant-scenarios: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
