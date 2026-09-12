export const SANDEAL_RUNTIME_MODES = ['legacy', 'cloudflare'] as const;

export type SandealRuntime = (typeof SANDEAL_RUNTIME_MODES)[number];

export class SandealRuntimeConfigurationError extends Error {
  readonly code = 'SANDEAL_RUNTIME_UNSUPPORTED' as const;

  constructor() {
    super('SANDEAL_RUNTIME_UNSUPPORTED');
    this.name = 'SandealRuntimeConfigurationError';
  }
}

/**
 * Resolve infrastructure without changing the established production default.
 * An explicit unknown value is never allowed to fall back to legacy silently.
 */
export function getSandealRuntime(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): SandealRuntime {
  const configured = environment.SANDEAL_RUNTIME;
  if (configured === undefined || configured.trim() === '') return 'legacy';

  const normalized = configured.trim().toLowerCase();
  if (normalized === 'legacy' || normalized === 'cloudflare') return normalized;
  throw new SandealRuntimeConfigurationError();
}
