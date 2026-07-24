import type { ProviderHealthStatus } from '@/lib/automation/runtimeGuardian';
import { listCredentials } from '@/lib/storage/tokenVault';
import { getCredentialTruth } from './credentialTruth';

export interface GeminiProviderReadiness {
  status: ProviderHealthStatus;
  adapterAvailable: true;
  configured: boolean;
  totalConnections: number;
  enabledConnections: number;
  validConnections: number;
  generationReadyConnections: number;
  productionReadyConnections: number;
  primaryCredentialId: string | null;
  primaryReady: boolean;
  reason: 'NOT_CONFIGURED' | 'READY' | 'READY_CONNECTION_NOT_PRIMARY' | 'FREE_POLICY_UNVERIFIED' | 'CONFIGURED_NOT_READY';
}

export async function getGeminiProviderReadiness(now = Date.now()): Promise<GeminiProviderReadiness> {
  const credentials = await listCredentials({ platform: 'gemini' });
  const enabled = credentials.filter((credential) => credential.role !== 'disabled' && credential.status !== 'disabled');
  const rows = enabled.map((credential) => ({ credential, truth: getCredentialTruth(credential, now) }));
  const generationReady = rows.filter((row) => row.truth.generationReady);
  const productionReady = rows.filter((row) => row.truth.productionReady);
  const valid = rows.filter((row) => row.truth.valid);
  const primary = rows.find((row) => row.credential.role === 'primary') || null;
  const configured = enabled.length > 0 || Boolean(process.env.GEMINI_API_KEY?.trim());
  const primaryReady = Boolean(primary?.truth.productionReady);
  const policyUnverified = valid.length > 0 && generationReady.length === 0
    && valid.some((row) => Boolean(row.truth.lastGenerationSucceededAt) && !row.truth.freePolicyEligible);

  const status: ProviderHealthStatus = !configured ? 'not_configured'
    : productionReady.length > 0 ? 'ready'
      : generationReady.length > 0 ? 'degraded'
      : policyUnverified ? 'blocked_by_policy'
        : 'configured_not_ready';
  const reason: GeminiProviderReadiness['reason'] = !configured ? 'NOT_CONFIGURED'
    : productionReady.length > 0 ? 'READY'
      : generationReady.length > 0 ? 'READY_CONNECTION_NOT_PRIMARY'
      : policyUnverified ? 'FREE_POLICY_UNVERIFIED'
        : 'CONFIGURED_NOT_READY';

  return {
    status,
    adapterAvailable: true,
    configured,
    totalConnections: credentials.length,
    enabledConnections: enabled.length,
    validConnections: valid.length,
    generationReadyConnections: generationReady.length,
    productionReadyConnections: productionReady.length,
    primaryCredentialId: primary?.credential.id || null,
    primaryReady,
    reason,
  };
}
