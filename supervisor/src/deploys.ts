import { appendFile, mkdir, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Ring } from '@haunted-lab/common';
import { isServiceName, type DeployRecord } from './types.ts';

export const FIRST_DEPLOY_ID = 101;
/** Records kept in memory for `/lab/deploys` (the file keeps everything). */
export const DEPLOY_TAIL = 1000;

const ID = /^d-(\d{1,12})$/;

function parseRecord(line: string): DeployRecord | undefined {
  try {
    const r = JSON.parse(line) as Partial<DeployRecord>;
    if (
      typeof r.id === 'string' &&
      ID.test(r.id) &&
      isServiceName(r.service) &&
      typeof r.ref === 'string' &&
      typeof r.sha === 'string' &&
      typeof r.time === 'string' &&
      (r.actor === 'supervisor' || r.actor === 'chaos' || r.actor === 'exorcist')
    ) {
      return { id: r.id, service: r.service, ref: r.ref, sha: r.sha, time: r.time, actor: r.actor };
    }
  } catch {
    // skip malformed line
  }
  return undefined;
}

const idNumber = (id: string): number => Number(ID.exec(id)?.[1] ?? '0');

/** Read and parse a whole deploy log file (used once at open). */
export async function readDeployFile(file: string): Promise<DeployRecord[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  const out: DeployRecord[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const r = parseRecord(line);
    if (r) out.push(r);
  }
  return out;
}

/** Chunk size for reading the deploy log from its end. */
export const TAIL_CHUNK_BYTES = 256 * 1024;

/**
 * Read the newest records from the end of a deploy log, chunk by chunk, without reading the whole
 * file: stop once `tailSize` valid records were found, or once at least one was found and
 * `maxBytes` were read, or at the file start. A line cut by a chunk boundary is completed by the
 * next (earlier) chunk. Returns the records oldest first and the bytes read.
 */
export async function readDeployTail(
  file: string,
  tailSize: number,
  chunkBytes: number = TAIL_CHUNK_BYTES,
  maxBytes: number = TAIL_CHUNK_BYTES,
): Promise<{ records: DeployRecord[]; bytesRead: number }> {
  let fh;
  try {
    fh = await open(file, 'r');
  } catch {
    return { records: [], bytesRead: 0 };
  }
  try {
    const size = (await fh.stat()).size;
    let start = size;
    let buf = Buffer.alloc(0);
    let records: DeployRecord[] = [];
    while (start > 0) {
      const from = Math.max(0, start - chunkBytes);
      const chunk = Buffer.alloc(start - from);
      await fh.read(chunk, 0, chunk.length, from);
      buf = Buffer.concat([chunk, buf]);
      start = from;
      const lines = buf.toString('utf8').split('\n');
      if (start > 0) lines.shift(); // may be partial: completed by the next chunk
      records = [];
      for (const line of lines) {
        if (line.trim() === '') continue;
        const r = parseRecord(line);
        if (r) records.push(r);
      }
      const read = size - start;
      if (records.length >= tailSize || (records.length >= 1 && read >= maxBytes)) break;
    }
    return { records: records.slice(Math.max(0, records.length - tailSize)), bytesRead: size - start };
  } finally {
    await fh.close();
  }
}

/**
 * Append-only JSON Lines deploy log (`data/deploys.jsonl`). Never rewritten or truncated.
 * Only the end of the file is read at open; afterwards a bounded in-memory tail serves reads.
 */
export class DeployLog {
  readonly file: string;
  #next = FIRST_DEPLOY_ID;
  #queue: Promise<unknown> = Promise.resolve();
  #tail: Ring<DeployRecord>;

  private constructor(file: string, tailSize: number) {
    this.file = file;
    this.#tail = new Ring<DeployRecord>(tailSize);
  }

  static async open(file: string, tailSize: number = DEPLOY_TAIL): Promise<DeployLog> {
    const log = new DeployLog(file, tailSize);
    await mkdir(dirname(file), { recursive: true });
    // Only the end of the file is read: ids only grow, so the newest valid record has the highest id.
    const { records } = await readDeployTail(file, tailSize);
    const max = records.reduce((m, r) => Math.max(m, idNumber(r.id)), FIRST_DEPLOY_ID - 1);
    log.#next = max + 1;
    for (const r of records) log.#tail.push(r);
    return log;
  }

  /** Newest records (at most the tail size), oldest first. No file access. */
  records(): DeployRecord[] {
    return this.#tail.latest();
  }

  /** Assign the next id and append. Calls are serialized so ids stay strictly increasing. */
  append(record: Omit<DeployRecord, 'id'>): Promise<DeployRecord> {
    const run = async () => {
      const full: DeployRecord = { id: `d-${this.#next}`, ...record };
      await appendFile(this.file, `${JSON.stringify(full)}\n`, { flag: 'a', encoding: 'utf8' });
      this.#next++;
      this.#tail.push(full);
      return full;
    };
    const p = this.#queue.then(run, run);
    this.#queue = p.catch(() => undefined);
    return p;
  }
}
