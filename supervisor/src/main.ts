import { loadConfigOrExit } from '@haunted-lab/common';
import { startSupervisor } from './app.ts';
import { loadSupervisorConfig } from './config.ts';

const config = loadConfigOrExit(() => loadSupervisorConfig());

let running: Awaited<ReturnType<typeof startSupervisor>> | undefined;
let stopping = false;

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  process.stdout.write(`[supervisor] ${signal}: stopping services\n`);
  await running?.close();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  running = await startSupervisor(config);
} catch (err) {
  process.stderr.write(`[supervisor] failed to start: ${err instanceof Error ? err.message : 'unknown error'}\n`);
  process.exit(1);
}
