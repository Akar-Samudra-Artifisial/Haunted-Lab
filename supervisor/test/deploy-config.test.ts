import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const deploy = (f: string) => readFileSync(resolve(import.meta.dirname, '..', '..', 'deploy', f), 'utf8');

describe('deploy config', () => {
  it('Mac: Prometheus published on 127.0.0.1 only, services reached through the host gateway', () => {
    const base = deploy('compose.yaml');
    expect(base).toMatch(/image: prom\/prometheus:v\d+\.\d+\.\d+\n/);
    expect(base).toContain('"127.0.0.1:${PROMETHEUS_PORT:-9090}:9090"');
    expect(base).toContain('lab-host:${LAB_HOST_ADDR:-host-gateway}');
  });

  it('Linux: host network, no published ports, Prometheus and lab-host on 127.0.0.1', () => {
    const linux = deploy('compose.linux.yaml');
    expect(linux).toContain('network_mode: host');
    expect(linux).toContain('ports: !reset []');
    expect(linux).toContain('"lab-host:127.0.0.1"');
    expect(linux).toContain('--web.listen-address=127.0.0.1:${PROMETHEUS_PORT:-9090}');
    const settings = linux.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
    expect(settings).not.toContain('0.0.0.0');
  });

  it('targets carry a service label and point at lab-host', () => {
    const targets = JSON.parse(deploy('targets/lab.json')) as { targets: string[]; labels: { service: string } }[];
    expect(targets.map((t) => t.labels.service)).toEqual(['gate', 'orders', 'payments', 'ledger']);
    expect(targets.flatMap((t) => t.targets).every((t) => t.startsWith('lab-host:'))).toBe(true);
  });
});
