export type EnvKind = 'string' | 'port' | 'int' | 'url' | 'host';

export interface EnvVarSpec {
  kind?: EnvKind;
  required?: boolean;
  default?: string;
  min?: number;
}

export type EnvSpec = Record<string, EnvVarSpec>;

/** Carries NAMES only. Env values are never put into the message. */
export class ConfigError extends Error {
  missing: string[];
  invalid: string[];
  /** `detail` must name variables only, never contain a value. */
  constructor(missing: string[], invalid: string[], detail?: string) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing required env: ${missing.join(', ')}`);
    if (invalid.length > 0) parts.push(`invalid env: ${invalid.join(', ')}`);
    if (detail) parts.push(detail);
    super(parts.join('; '));
    this.name = 'ConfigError';
    this.missing = missing;
    this.invalid = invalid;
  }
}

function valid(kind: EnvKind, value: string, min: number | undefined): boolean {
  switch (kind) {
    case 'port': {
      return /^\d{1,5}$/.test(value) && Number(value) >= 1 && Number(value) <= 65535;
    }
    case 'int': {
      return /^\d{1,9}$/.test(value) && Number(value) >= (min ?? 0);
    }
    case 'url': {
      try {
        const u = new URL(value);
        return u.protocol === 'http:' || u.protocol === 'https:';
      } catch {
        return false;
      }
    }
    case 'host': {
      return /^[A-Za-z0-9.:-]{1,253}$/.test(value);
    }
    default:
      return value.length > 0;
  }
}

export function parseEnv<S extends EnvSpec>(spec: S, env: Record<string, string | undefined>): Record<keyof S & string, string> {
  const out: Record<string, string> = {};
  const missing: string[] = [];
  const invalid: string[] = [];
  for (const [name, def] of Object.entries(spec)) {
    const raw = env[name];
    const value = raw === undefined || raw === '' ? def.default : raw;
    if (value === undefined) {
      if (def.required !== false) missing.push(name);
      continue;
    }
    if (!valid(def.kind ?? 'string', value, def.min)) {
      invalid.push(name);
      continue;
    }
    out[name] = value;
  }
  if (missing.length > 0 || invalid.length > 0) throw new ConfigError(missing, invalid);
  return out as Record<keyof S & string, string>;
}

/** Run config loading; on a config error print the message (names only) and exit 1 before listening. */
export function loadConfigOrExit<T>(load: () => T): T {
  try {
    return load();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}
