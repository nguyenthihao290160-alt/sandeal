import type { SandealFeatureFlag } from './featureRollout';

export const PROVIDER_REGISTRY_SCHEMA_VERSION = 1;
export const PROVIDER_CONTRACT_VERSION = 'provider-adapter-v1';

export type ProviderId = 'deterministic-rules' | 'gemini' | 'local-ai';
export type ProviderKind = 'DETERMINISTIC' | 'CLOUD_AI' | 'LOCAL_AI';
export type ProviderTransport = 'IN_PROCESS' | 'HTTPS' | 'LOOPBACK_HTTP';

export interface ProviderRetryDeclaration {
  maximumAttempts: number;
  baseDelayMs: number;
  maximumDelayMs: number;
  retryableCodes: string[];
  terminalCodes: string[];
}

export interface ProviderDeclaration {
  schemaVersion: number;
  contractVersion: string;
  id: ProviderId;
  label: string;
  kind: ProviderKind;
  transport: ProviderTransport;
  capabilities: string[];
  freeOnly: boolean;
  externalNetwork: boolean;
  separateProcess: boolean;
  featureFlag?: SandealFeatureFlag;
  maximumConcurrency: number;
  responseLimitBytes: number;
  retry: ProviderRetryDeclaration;
}

const TRANSIENT_CODES = [
  'NETWORK_ERROR',
  'PROVIDER_UNAVAILABLE',
  'RATE_LIMITED',
  'TIMEOUT',
];

const TERMINAL_CODES = [
  'CONFIGURATION_REQUIRED',
  'CREDENTIAL_EXPIRED',
  'INVALID_CREDENTIAL',
  'INVALID_PROVIDER_RESPONSE',
  'SAFETY_POLICY_BLOCKED',
  'SCHEMA_VALIDATION_FAILED',
];

const PROVIDERS: readonly ProviderDeclaration[] = [
  {
    schemaVersion: PROVIDER_REGISTRY_SCHEMA_VERSION,
    contractVersion: PROVIDER_CONTRACT_VERSION,
    id: 'deterministic-rules',
    label: 'Deterministic rules',
    kind: 'DETERMINISTIC',
    transport: 'IN_PROCESS',
    capabilities: [
      'DETERMINISTIC_EXTRACTION',
      'NORMALIZE_PRODUCT',
      'SMART_CATEGORIZATION',
    ],
    freeOnly: true,
    externalNetwork: false,
    separateProcess: false,
    maximumConcurrency: 4,
    responseLimitBytes: 512 * 1024,
    retry: {
      maximumAttempts: 1,
      baseDelayMs: 0,
      maximumDelayMs: 0,
      retryableCodes: [],
      terminalCodes: TERMINAL_CODES,
    },
  },
  {
    schemaVersion: PROVIDER_REGISTRY_SCHEMA_VERSION,
    contractVersion: PROVIDER_CONTRACT_VERSION,
    id: 'gemini',
    label: 'Gemini cloud adapter',
    kind: 'CLOUD_AI',
    transport: 'HTTPS',
    capabilities: ['ANALYZE_WITH_EVIDENCE', 'EDITORIAL_REVIEW'],
    freeOnly: true,
    externalNetwork: true,
    separateProcess: false,
    featureFlag: 'AI_CLOUD_FALLBACK',
    maximumConcurrency: 1,
    responseLimitBytes: 256 * 1024,
    retry: {
      maximumAttempts: 2,
      baseDelayMs: 1_000,
      maximumDelayMs: 30_000,
      retryableCodes: TRANSIENT_CODES,
      terminalCodes: TERMINAL_CODES,
    },
  },
  {
    schemaVersion: PROVIDER_REGISTRY_SCHEMA_VERSION,
    contractVersion: PROVIDER_CONTRACT_VERSION,
    id: 'local-ai',
    label: 'Separate-process local AI adapter',
    kind: 'LOCAL_AI',
    transport: 'LOOPBACK_HTTP',
    capabilities: ['ANALYZE_WITH_EVIDENCE', 'EDITORIAL_REVIEW'],
    freeOnly: true,
    externalNetwork: false,
    separateProcess: true,
    featureFlag: 'AI_LOCAL_FALLBACK',
    maximumConcurrency: 1,
    responseLimitBytes: 256 * 1024,
    retry: {
      maximumAttempts: 1,
      baseDelayMs: 0,
      maximumDelayMs: 0,
      retryableCodes: TRANSIENT_CODES,
      terminalCodes: TERMINAL_CODES,
    },
  },
];

function cloneProvider(provider: ProviderDeclaration): ProviderDeclaration {
  return {
    ...provider,
    capabilities: [...provider.capabilities],
    retry: {
      ...provider.retry,
      retryableCodes: [...provider.retry.retryableCodes],
      terminalCodes: [...provider.retry.terminalCodes],
    },
  };
}

function validateRegistry(): void {
  const ids = new Set<string>();
  for (const provider of PROVIDERS) {
    if (ids.has(provider.id)) throw new Error(`PROVIDER_REGISTRY_DUPLICATE:${provider.id}`);
    ids.add(provider.id);
    if (
      provider.schemaVersion !== PROVIDER_REGISTRY_SCHEMA_VERSION
      || provider.contractVersion !== PROVIDER_CONTRACT_VERSION
      || provider.maximumConcurrency < 1
      || provider.maximumConcurrency > 4
      || provider.responseLimitBytes < 1
      || provider.responseLimitBytes > 512 * 1024
      || provider.capabilities.length === 0
      || (!provider.freeOnly && provider.kind !== 'DETERMINISTIC')
      || (provider.kind === 'LOCAL_AI' && (
        provider.transport !== 'LOOPBACK_HTTP'
        || !provider.separateProcess
        || provider.externalNetwork
      ))
    ) {
      throw new Error(`PROVIDER_REGISTRY_INVALID:${provider.id}`);
    }
  }
}

validateRegistry();

export function listProviderDeclarations(): ProviderDeclaration[] {
  return PROVIDERS.map(cloneProvider);
}

export function getProviderDeclaration(id: ProviderId): ProviderDeclaration {
  const provider = PROVIDERS.find(item => item.id === id);
  if (!provider) throw new Error(`PROVIDER_NOT_REGISTERED:${id}`);
  return cloneProvider(provider);
}

export function providersForCapability(capability: string): ProviderDeclaration[] {
  return PROVIDERS
    .filter(provider => provider.capabilities.includes(capability))
    .map(cloneProvider);
}
