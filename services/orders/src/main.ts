import { listen, loadConfigOrExit } from '@haunted-lab/common';
import { createOrders } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfigOrExit(() => loadConfig());
const lab = createOrders({ paymentsUrl: config.paymentsUrl });
const port = await listen(lab.server, config.port, config.host);
lab.log(`orders listening on ${config.host}:${port}`);
