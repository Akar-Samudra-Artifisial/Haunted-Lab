import { loadConfigOrExit } from '@haunted-lab/common';
import { startSupervisor, type RunningSupervisor } from './app.ts';
import { loadSupervisorConfig } from './config.ts';

const config = loadConfigOrExit(() => loadSupervisorConfig());

let stopping = false;
const starting: Promise<RunningSupervisor> = startSupervisor(config);

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  process.stdout.write(`[supervisor] ${signal}: stopping services\n`);
  // A signal during boot must not orphan the children already started: wait for the boot to
  // finish (or fail, which stops them itself), then stop everything.
  const running = await starting.catch(() => undefined);
  await running?.close();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await starting;
} catch (err) {
  process.stderr.write(`[supervisor] failed to start: ${err instanceof Error ? err.message : 'unknown error'}\n`);
  if (!stopping) process.exit(1);
}
