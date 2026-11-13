import { createServer, type Server } from 'node:net';
import type { Deployment, Runner } from '../src/runner.ts';
import { SERVICES, type ServiceName, type ServiceState } from '../src/types.ts';

export interface FakeRunner extends Runner {
  deploys: Deployment[];
}

export function fakeRunner(service: ServiceName): FakeRunner {
  let current: Deployment | undefined;
  const deploys: Deployment[] = [];
  return {
    service,
    deploys,
    get deployment() {
      return current;
    },
    async deploy(d) {
      current = d;
      deploys.push(d);
    },
    async stop() {},
    state(): ServiceState {
      return { service, ref: current?.ref ?? '', sha: current?.sha ?? '', status: current ? 'running' : 'stopped', restarts: 0, since: '' };
    },
    logs: () => [],
    exits: () => [],
  };
}

export const fakeRunners = (): Record<ServiceName, FakeRunner> =>
  Object.fromEntries(SERVICES.map((s) => [s, fakeRunner(s)])) as Record<ServiceName, FakeRunner>;

/** Ask the OS for `n` distinct free loopback ports. */
export async function freePorts(n: number): Promise<number[]> {
  const servers = await Promise.all(
    Array.from(
      { length: n },
      () =>
        new Promise<Server>((resolve) => {
          const s = createServer();
          s.listen(0, '127.0.0.1', () => resolve(s));
        }),
    ),
  );
  const ports = servers.map((s) => {
    const a = s.address();
    return typeof a === 'object' && a ? a.port : 0;
  });
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  return ports;
}
