import { listen, loadConfigOrExit } from '@haunted-lab/common';
import { createGate } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfigOrExit(() => loadConfig());
const lab = createGate({ ordersUrl: config.ordersUrl });
const port = await listen(lab.server, config.port, config.host);
lab.log(`gate listening on ${config.host}:${port}`);
