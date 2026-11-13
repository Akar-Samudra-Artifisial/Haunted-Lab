#!/usr/bin/env node
// Build a deterministic lab repo from this checkout's runtime files and plant the scenarios in it.
// Used by the tests and by g1-check.mjs while the services are not yet committed to `main`.
//
// Usage: node scripts/build-lab-repo.mjs <dest-dir>   (dest must not exist or be empty)
import { readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSnapshotRepo, plantScenarios } from './lab-git.mjs';

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** @param {string} dest */
export async function buildLabRepo(dest) {
  const entries = await readdir(dest).catch(() => []);
  if (entries.length > 0) throw new Error('destination is not empty');
  const main = await buildSnapshotRepo(checkout, dest);
  const planted = await plantScenarios(dest);
  return { main, shas: planted.shas };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dest = process.argv[2];
  if (!dest) {
    process.stderr.write('usage: node scripts/build-lab-repo.mjs <dest-dir>\n');
    process.exit(2);
  }
  try {
    process.stdout.write(`${JSON.stringify(await buildLabRepo(resolve(dest)))}\n`);
  } catch (err) {
    process.stderr.write(`build-lab-repo: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
