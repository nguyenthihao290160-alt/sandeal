import { getFeatureRolloutState } from '../automation/featureRollout';
import {
  parseAiCanonicalProposal,
  type AiCanonicalProposal,
} from './canonicalDataContract';

const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_MINIMUM_FREE_MEMORY_BYTES = 1024 * 1024 * 1024;

export interface LocalAiResourceSnapshot {
  freeMemoryBytes: number;
  eventLoopDelayMs: number;
}

export interface LocalAiAdapterOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  environment?: Readonly<Record<string, string | undefined>>;
  resourceSnapshot?: () => LocalAiResourceSnapshot;
  minimumFreeMemoryBytes?: number;
  maximumConcurrency?: number;
  maximumQueueDepth?: number;
}

export interface LocalAiReadiness {
  configured: boolean;
  featureMode: string;
  reachable: boolean;
  ready: boolean;
  reasonCode:
    | 'READY'
    | 'FEATURE_DISABLED'
    | 'CONFIGURATION_INVALID'
    | 'RESOURCE_GATE_BLOCKED'
    | 'SERVICE_UNAVAILABLE'
    | 'CONTRACT_MISMATCH';
}

export interface LocalAiBenchmarkSample {
  ok: boolean;
  responseMs: number;
  eventLoopDelayMs: number;
  rssDeltaBytes: number;
  guardianPickupMs: number;
}

export interface LocalAiBenchmarkResult {
  sampleCount: number;
  successRate: number;
  responseP95Ms: number | null;
  maximumEventLoopDelayMs: number | null;
  maximumRssDeltaBytes: number | null;
  maximumGuardianPickupMs: number | null;
  eligible: boolean;
  reasonCodes: string[];
}

function loopbackBaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== 'http:'
      || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
      || parsed.username
      || parsed.password
      || !parsed.port
      || !['', '/'].includes(parsed.pathname)
      || parsed.search
      || parsed.hash
    ) {
      return undefined;
    }
    return parsed.origin;
  } catch {
    return undefined;
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error('LOCAL_AI_RESPONSE_TOO_LARGE');
  }
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new Error('LOCAL_AI_RESPONSE_TOO_LARGE');
    }
    return JSON.parse(text);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw new Error('LOCAL_AI_RESPONSE_TOO_LARGE');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function percentile95(values: number[]): number | null {
  const valid = values.filter(value => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (!valid.length) return null;
  return valid[Math.min(valid.length - 1, Math.ceil(valid.length * 0.95) - 1)];
}

export function evaluateLocalAiBenchmark(
  samples: LocalAiBenchmarkSample[],
): LocalAiBenchmarkResult {
  const bounded = samples.slice(0, 1_000);
  const successRate = bounded.length
    ? bounded.filter(sample => sample.ok).length / bounded.length
    : 0;
  const responseP95Ms = percentile95(bounded.map(sample => sample.responseMs));
  const maximumEventLoopDelayMs = bounded.length
    ? Math.max(...bounded.map(sample => sample.eventLoopDelayMs))
    : null;
  const maximumRssDeltaBytes = bounded.length
    ? Math.max(...bounded.map(sample => sample.rssDeltaBytes))
    : null;
  const maximumGuardianPickupMs = bounded.length
    ? Math.max(...bounded.map(sample => sample.guardianPickupMs))
    : null;
  const reasonCodes: string[] = [];
  if (bounded.length < 20) reasonCodes.push('INSUFFICIENT_SAMPLE_SIZE');
  if (successRate < 0.95) reasonCodes.push('SUCCESS_RATE_BELOW_GATE');
  if (responseP95Ms === null || responseP95Ms > 5_000) reasonCodes.push('RESPONSE_P95_ABOVE_GATE');
  if (maximumEventLoopDelayMs === null || maximumEventLoopDelayMs > 100) {
    reasonCodes.push('EVENT_LOOP_DELAY_ABOVE_GATE');
  }
  if (maximumRssDeltaBytes === null || maximumRssDeltaBytes > 512 * 1024 * 1024) {
    reasonCodes.push('MEMORY_DELTA_ABOVE_GATE');
  }
  if (maximumGuardianPickupMs === null || maximumGuardianPickupMs >= 30_000) {
    reasonCodes.push('GUARDIAN_PICKUP_ABOVE_GATE');
  }
  return {
    sampleCount: bounded.length,
    successRate,
    responseP95Ms,
    maximumEventLoopDelayMs,
    maximumRssDeltaBytes,
    maximumGuardianPickupMs,
    eligible: reasonCodes.length === 0,
    reasonCodes,
  };
}

export class LocalAiAdapter {
  private readonly baseUrl?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly environment?: Readonly<Record<string, string | undefined>>;
  private readonly resourceSnapshot: () => LocalAiResourceSnapshot;
  private readonly minimumFreeMemoryBytes: number;
  private readonly maximumConcurrency: number;
  private readonly maximumQueueDepth: number;
  private active = 0;
  private readonly waiters: Array<(release: () => void) => void> = [];

  constructor(options: LocalAiAdapterOptions = {}) {
    this.baseUrl = loopbackBaseUrl(options.baseUrl || options.environment?.SANDEAL_LOCAL_AI_URL);
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.environment = options.environment;
    this.resourceSnapshot = options.resourceSnapshot || (() => ({
      freeMemoryBytes: 0,
      eventLoopDelayMs: Number.POSITIVE_INFINITY,
    }));
    this.minimumFreeMemoryBytes = Math.max(
      256 * 1024 * 1024,
      options.minimumFreeMemoryBytes ?? DEFAULT_MINIMUM_FREE_MEMORY_BYTES,
    );
    this.maximumConcurrency = Math.max(1, Math.min(2, options.maximumConcurrency ?? 1));
    this.maximumQueueDepth = Math.max(0, Math.min(4, options.maximumQueueDepth ?? 2));
  }

  private featureMode(): string {
    return getFeatureRolloutState('AI_LOCAL_FALLBACK', this.environment).mode;
  }

  private resourcesReady(): boolean {
    const snapshot = this.resourceSnapshot();
    return Number.isFinite(snapshot.freeMemoryBytes)
      && snapshot.freeMemoryBytes >= this.minimumFreeMemoryBytes
      && Number.isFinite(snapshot.eventLoopDelayMs)
      && snapshot.eventLoopDelayMs <= 100;
  }

  private async acquire(): Promise<() => void> {
    if (this.active >= this.maximumConcurrency) {
      if (this.waiters.length >= this.maximumQueueDepth) {
        throw new Error('LOCAL_AI_QUEUE_FULL');
      }
      return new Promise<() => void>(resolve => this.waiters.push(resolve));
    }
    this.active += 1;
    return this.releaseHandle();
  }

  private releaseHandle(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      const next = this.waiters.shift();
      if (next && this.active < this.maximumConcurrency) {
        this.active += 1;
        next(this.releaseHandle());
      }
    };
  }

  private async request(pathname: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    if (!this.baseUrl) throw new Error('LOCAL_AI_CONFIGURATION_INVALID');
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('LOCAL_AI_TIMEOUT')),
      Math.max(1, Math.min(MAX_TIMEOUT_MS, timeoutMs)),
    );
    const timeout = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => {
        reject(new Error('LOCAL_AI_TIMEOUT'));
      }, { once: true });
    });
    try {
      return await Promise.race([
        this.fetchImpl(`${this.baseUrl}${pathname}`, {
          ...init,
          redirect: 'error',
          signal: controller.signal,
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            ...(init.headers || {}),
          },
        }),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async readiness(): Promise<LocalAiReadiness> {
    const featureMode = this.featureMode();
    if (featureMode !== 'ACTIVE') {
      return {
        configured: Boolean(this.baseUrl),
        featureMode,
        reachable: false,
        ready: false,
        reasonCode: 'FEATURE_DISABLED',
      };
    }
    if (!this.baseUrl) {
      return {
        configured: false,
        featureMode,
        reachable: false,
        ready: false,
        reasonCode: 'CONFIGURATION_INVALID',
      };
    }
    if (!this.resourcesReady()) {
      return {
        configured: true,
        featureMode,
        reachable: false,
        ready: false,
        reasonCode: 'RESOURCE_GATE_BLOCKED',
      };
    }
    try {
      const response = await this.request('/v1/health', { method: 'GET' }, 2_000);
      if (!response.ok) throw new Error('LOCAL_AI_SERVICE_UNAVAILABLE');
      const payload = await readBoundedJson(response) as {
        ready?: unknown;
        contractVersion?: unknown;
      };
      const contractReady = payload.ready === true
        && payload.contractVersion === 'ai-canonical-proposal-v1';
      return {
        configured: true,
        featureMode,
        reachable: true,
        ready: contractReady,
        reasonCode: contractReady ? 'READY' : 'CONTRACT_MISMATCH',
      };
    } catch {
      return {
        configured: true,
        featureMode,
        reachable: false,
        ready: false,
        reasonCode: 'SERVICE_UNAVAILABLE',
      };
    }
  }

  async generateCanonicalProposal(
    input: unknown,
    allowedEvidenceIds: ReadonlySet<string>,
    timeoutMs = 15_000,
  ): Promise<AiCanonicalProposal> {
    const readiness = await this.readiness();
    if (!readiness.ready) throw new Error(`LOCAL_AI_NOT_READY:${readiness.reasonCode}`);
    if (Buffer.byteLength(JSON.stringify(input), 'utf8') > 128 * 1024) {
      throw new Error('LOCAL_AI_INPUT_TOO_LARGE');
    }
    const release = await this.acquire();
    try {
      const response = await this.request('/v1/generate', {
        method: 'POST',
        body: JSON.stringify(input),
      }, timeoutMs);
      if (!response.ok) throw new Error(`LOCAL_AI_HTTP_${response.status}`);
      return parseAiCanonicalProposal(await readBoundedJson(response), allowedEvidenceIds);
    } finally {
      release();
    }
  }
}
