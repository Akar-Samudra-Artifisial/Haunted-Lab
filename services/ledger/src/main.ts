import { listen, loadConfigOrExit } from '@haunted-lab/common';
import { createLedger } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfigOrExit(() => loadConfig());
const lab = createLedger();
const port = await listen(lab.server, config.port, config.host);
lab.log(`ledger listening on ${config.host}:${port}`);
