import { listen, loadConfigOrExit } from '@haunted-lab/common';
import { createPayments } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfigOrExit(() => loadConfig());
const lab = createPayments({ ledgerUrl: config.ledgerUrl });
const port = await listen(lab.server, config.port, config.host);
lab.log(`payments listening on ${config.host}:${port}`);
