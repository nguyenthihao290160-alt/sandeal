import { getAutomationSettings } from '@/lib/storage/automationSettings';
import { getPrimaryCredential } from '@/lib/storage/tokenVault';
import { canUseCircuit, getAiUsage, getAutomationControl, reserveAiUsage } from './store';

export type ProviderFailureCode =
  | 'PROVIDER_NOT_IMPLEMENTED'
  | 'CONFIGURATION_REQUIRED'
  | 'INVALID_CREDENTIAL'
  | 'CREDENTIAL_EXPIRED'
  | 'QUOTA_EXCEEDED'
  | 'RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'INVALID_PROVIDER_RESPONSE'
  | 'SCHEMA_VALIDATION_FAILED'
  | 'SAFETY_POLICY_BLOCKED';

export type RequestedExecutionMode = 'AUTO' | 'API_ONLY' | 'LOCAL_ONLY' | 'MANUAL_ONLY';
export type ActualExecutionMode = 'API' | 'LOCAL_RULES' | 'LOCAL_TEMPLATE' | 'MANUAL_INPUT' | 'SHADOW_MODE';
export type LocalExecutionKind = Extract<ActualExecutionMode, 'LOCAL_RULES' | 'LOCAL_TEMPLATE'>;

export interface ProviderRouteRequest {
  capability: string;
  requestedMode: RequestedExecutionMode;
  provider?: 'gemini';
  providerAdapterAvailable: boolean;
  localMode?: LocalExecutionKind;
  deterministicFirst?: boolean;
  allowLocalFallback?: boolean;
  allowManualFallback?: boolean;
  allowPaidFallback?: boolean;
  shadowMode?: boolean;
  estimatedRequests?: number;
  estimatedTokens?: number;
}

export interface ProviderRouteDecision {
  requestedMode: RequestedExecutionMode;
  executionMode: ActualExecutionMode;
  provider: 'gemini' | 'local' | 'manual';
  providerConfigured: boolean;
  providerReady: boolean;
  failureCode?: ProviderFailureCode;
  fallbackReason?: string;
  aiRequests: number;
  externalRequests: number;
  requiresManualInput: boolean;
  limitations: string[];
}

function manualDecision(
  request: ProviderRouteRequest,
  reason: ProviderFailureCode | 'MANUAL_REQUESTED',
  providerConfigured = false,
): ProviderRouteDecision {
  return {
    requestedMode: request.requestedMode,
    executionMode: request.shadowMode ? 'SHADOW_MODE' : 'MANUAL_INPUT',
    provider: 'manual',
    providerConfigured,
    providerReady: false,
    failureCode: reason === 'MANUAL_REQUESTED' ? undefined : reason,
    fallbackReason: reason,
    aiRequests: 0,
    externalRequests: 0,
    requiresManualInput: true,
    limitations: ['Cần dữ liệu đầu vào được người vận hành xác minh.'],
  };
}

function localDecision(
  request: ProviderRouteRequest,
  fallbackReason?: string,
  providerConfigured = false,
): ProviderRouteDecision {
  return {
    requestedMode: request.requestedMode,
    executionMode: request.shadowMode ? 'SHADOW_MODE' : request.localMode!,
    provider: 'local',
    providerConfigured,
    providerReady: true,
    fallbackReason,
    aiRequests: 0,
    externalRequests: 0,
    requiresManualInput: false,
    limitations: ['Kết quả chỉ dựa trên rules/template deterministic và không tạo canonical fact mới.'],
  };
}

async function providerReadiness(request: ProviderRouteRequest): Promise<{
  configured: boolean;
  ready: boolean;
  failureCode?: ProviderFailureCode;
}> {
  const provider = request.provider || 'gemini';
  const [control, settings, credential, circuit, usage] = await Promise.all([
    getAutomationControl(),
    getAutomationSettings(),
    getPrimaryCredential(provider),
    canUseCircuit(provider),
    getAiUsage(),
  ]);
  if (control.killSwitch || !settings.freeOnly || settings.allowPaidAi || request.allowPaidFallback) {
    return { configured: Boolean(credential), ready: false, failureCode: 'SAFETY_POLICY_BLOCKED' };
  }
  if (!request.providerAdapterAvailable) {
    return { configured: Boolean(credential), ready: false, failureCode: 'PROVIDER_NOT_IMPLEMENTED' };
  }
  if (!credential) return { configured: false, ready: false, failureCode: 'CONFIGURATION_REQUIRED' };
  if (credential.status === 'disabled') return { configured: true, ready: false, failureCode: 'INVALID_CREDENTIAL' };
  if (credential.status !== 'valid') return { configured: true, ready: false, failureCode: 'CREDENTIAL_EXPIRED' };
  if (!circuit.allowed) return { configured: true, ready: false, failureCode: 'PROVIDER_UNAVAILABLE' };
  if (
    usage.requests + Math.max(0, request.estimatedRequests || 0) > usage.requestLimit
    || usage.tokens + Math.max(0, request.estimatedTokens || 0) > usage.tokenLimit
  ) {
    return { configured: true, ready: false, failureCode: 'QUOTA_EXCEEDED' };
  }
  return { configured: true, ready: true };
}

export async function routeProviderExecution(request: ProviderRouteRequest): Promise<ProviderRouteDecision> {
  const allowLocal = request.allowLocalFallback !== false;
  const allowManual = request.allowManualFallback !== false;
  if (request.requestedMode === 'MANUAL_ONLY') return manualDecision(request, 'MANUAL_REQUESTED');
  if (request.requestedMode === 'LOCAL_ONLY') {
    if (request.localMode) return localDecision(request);
    return manualDecision(request, 'PROVIDER_NOT_IMPLEMENTED');
  }
  if (request.requestedMode === 'AUTO' && request.deterministicFirst && request.localMode) {
    return localDecision(request);
  }

  const readiness = await providerReadiness(request);
  if (readiness.ready) {
    return {
      requestedMode: request.requestedMode,
      executionMode: request.shadowMode ? 'SHADOW_MODE' : 'API',
      provider: request.provider || 'gemini',
      providerConfigured: true,
      providerReady: true,
      aiRequests: 0,
      externalRequests: 0,
      requiresManualInput: false,
      limitations: [],
    };
  }
  if (request.requestedMode === 'AUTO' && allowLocal && request.localMode) {
    return localDecision(request, readiness.failureCode, readiness.configured);
  }
  if (allowManual) return manualDecision(request, readiness.failureCode || 'PROVIDER_UNAVAILABLE', readiness.configured);
  return {
    requestedMode: request.requestedMode,
    executionMode: request.shadowMode ? 'SHADOW_MODE' : 'API',
    provider: request.provider || 'gemini',
    providerConfigured: readiness.configured,
    providerReady: false,
    failureCode: readiness.failureCode || 'PROVIDER_UNAVAILABLE',
    aiRequests: 0,
    externalRequests: 0,
    requiresManualInput: false,
    limitations: ['Không có fallback được policy cho phép.'],
  };
}

export async function reserveProviderBudget(requests: number, tokens: number): Promise<void> {
  const reserved = await reserveAiUsage(Math.max(0, requests), Math.max(0, tokens));
  if (!reserved.allowed) throw new Error('QUOTA_EXCEEDED');
}

export function classifyProviderFailure(error: unknown, status?: number): ProviderFailureCode {
  const message = error instanceof Error ? error.message : String(error || '');
  if (status === 401) return 'INVALID_CREDENTIAL';
  if (status === 403) return 'CREDENTIAL_EXPIRED';
  if (status === 429 || /rate.?limit/i.test(message)) return 'RATE_LIMITED';
  if (/quota|budget/i.test(message)) return 'QUOTA_EXCEEDED';
  if (/timeout|abort/i.test(message)) return 'TIMEOUT';
  if (/network|fetch|socket|dns/i.test(message)) return 'NETWORK_ERROR';
  if (/schema/i.test(message)) return 'SCHEMA_VALIDATION_FAILED';
  if (/response|json|parse/i.test(message)) return 'INVALID_PROVIDER_RESPONSE';
  if (/not.?implemented|unavailable handler/i.test(message)) return 'PROVIDER_NOT_IMPLEMENTED';
  if (/credential|api.?key|configuration/i.test(message)) return 'CONFIGURATION_REQUIRED';
  if (/safety|policy|kill.?switch|paid/i.test(message)) return 'SAFETY_POLICY_BLOCKED';
  return 'PROVIDER_UNAVAILABLE';
}
