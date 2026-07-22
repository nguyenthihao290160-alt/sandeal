export interface ScanJobResult {
  total?: number;
  processed?: number;
  healthy?: number;
  unhealthy?: number;
  unchanged?: number;
  skipped?: number;
  durationMs?: number;
  checked?: number;
  inspected?: number;
  valid?: number;
  blocked?: number;
  failed?: number;
  quarantined?: number;
}

export interface ScanJobSnapshot {
  id: string;
  status: string;
  result?: ScanJobResult;
  progress?: { processed?: number; total?: number; percentage?: number };
  lastErrorCode?: string;
  lastErrorMessage?: string;
  pollingTimedOut?: boolean;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const STOP_POLLING_STATUSES = new Set([
  'SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED',
  'WAITING_APPROVAL', 'WAITING_FOR_MANUAL_INPUT', 'PAUSED',
]);

async function waitWithAbort(
  wait: (milliseconds: number) => Promise<void>,
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) return wait(milliseconds);
  if (signal.aborted) throw new DOMException('Polling aborted', 'AbortError');
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(new DOMException('Polling aborted', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    void wait(milliseconds).then(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, error => {
      signal.removeEventListener('abort', abort);
      reject(error);
    });
  });
}

export async function pollScanJob(options: {
  jobId: string;
  fetchImpl?: FetchLike;
  wait?: (milliseconds: number) => Promise<void>;
  intervalMs?: number;
  maximumIntervalMs?: number;
  maximumPolls?: number;
  maximumDurationMs?: number;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
  onSnapshot?: (snapshot: ScanJobSnapshot) => void;
}): Promise<ScanJobSnapshot> {
  const fetchImpl = options.fetchImpl || fetch;
  const wait = options.wait || ((milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const intervalMs = Math.max(500, options.intervalMs ?? 1_500);
  const maximumIntervalMs = Math.max(intervalMs, options.maximumIntervalMs ?? 10_000);
  const maximumPolls = Math.max(1, options.maximumPolls ?? 80);
  const maximumDurationMs = Math.max(intervalMs, options.maximumDurationMs ?? 2 * 60_000);
  const requestTimeoutMs = Math.max(10, options.requestTimeoutMs ?? 15_000);
  const startedAt = Date.now();
  let lastSnapshot: ScanJobSnapshot = { id: options.jobId, status: 'PENDING' };

  for (let attempt = 0; attempt < maximumPolls; attempt += 1) {
    if (options.signal?.aborted) throw new DOMException('Polling aborted', 'AbortError');
    const requestController = new AbortController();
    let requestTimedOut = false;
    const forwardAbort = () => requestController.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', forwardAbort, { once: true });
    const remainingDurationMs = Math.max(1, maximumDurationMs - (Date.now() - startedAt));
    let requestTimer: ReturnType<typeof setTimeout> | undefined;
    const requestTimeout = new Promise<Response>((_resolve, reject) => {
      requestTimer = setTimeout(() => {
        requestTimedOut = true;
        const timeout = new DOMException('Polling request timed out', 'TimeoutError');
        requestController.abort(timeout);
        reject(timeout);
      }, Math.min(requestTimeoutMs, remainingDurationMs));
    });
    let response: Response;
    try {
      response = await Promise.race([
        fetchImpl(`/api/automation/jobs/${encodeURIComponent(options.jobId)}`, {
          cache: 'no-store',
          signal: requestController.signal,
        }),
        requestTimeout,
      ]);
    } catch (error) {
      if (options.signal?.aborted) throw new DOMException('Polling aborted', 'AbortError');
      if (requestTimedOut) return { ...lastSnapshot, pollingTimedOut: true };
      throw error;
    } finally {
      if (requestTimer) clearTimeout(requestTimer);
      options.signal?.removeEventListener('abort', forwardAbort);
    }
    const envelope = await response.json().catch(() => null) as { ok?: boolean; message?: string; data?: ScanJobSnapshot } | null;
    if (!response.ok || !envelope?.ok || !envelope.data) {
      throw new Error(envelope?.message || `Không đọc được trạng thái tác vụ (HTTP ${response.status}).`);
    }
    lastSnapshot = envelope.data;
    options.onSnapshot?.(lastSnapshot);
    if (STOP_POLLING_STATUSES.has(lastSnapshot.status)) return lastSnapshot;
    if (Date.now() - startedAt >= maximumDurationMs || attempt + 1 >= maximumPolls) {
      return { ...lastSnapshot, pollingTimedOut: true };
    }
    const backoffMs = Math.min(maximumIntervalMs, Math.round(intervalMs * 1.35 ** attempt));
    await waitWithAbort(wait, backoffMs, options.signal);
  }
  return { ...lastSnapshot, pollingTimedOut: true };
}
