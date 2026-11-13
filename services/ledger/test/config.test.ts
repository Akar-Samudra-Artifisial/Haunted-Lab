import { describe, expect, it } from 'vitest';
import { ConfigError } from '@haunted-lab/common';
import { loadConfig } from '../src/config.ts';

describe('ledger config', () => {
  it('reads LEDGER_PORT with a loopback default host', () => {
    expect(loadConfig({ LEDGER_PORT: '4004' })).toEqual({ port: 4004, host: '127.0.0.1' });
  });

  it('names the missing variable and nothing else', () => {
    expect(() => loadConfig({ SERVICE_BIND_HOST: '127.0.0.1' })).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow('missing required env: LEDGER_PORT');
  });
});
