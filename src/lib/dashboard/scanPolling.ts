export interface ScanJobResult {
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
  lastErrorCode?: string;
  lastErrorMessage?: string;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export async function pollScanJob(options: {
  jobId: string;
  fetchImpl?: FetchLike;
  wait?: (milliseconds: number) => Promise<void>;
  intervalMs?: number;
  maximumPolls?: number;
}): Promise<ScanJobSnapshot> {
  const fetchImpl = options.fetchImpl || fetch;
  const wait = options.wait || ((milliseconds: number) => new Promise(resolve => window.setTimeout(resolve, milliseconds)));
  const intervalMs = options.intervalMs ?? 1_500;
  const maximumPolls = options.maximumPolls ?? 240;
  for (let attempt = 0; attempt < maximumPolls; attempt += 1) {
    const response = await fetchImpl(`/api/automation/jobs/${encodeURIComponent(options.jobId)}`, { cache: 'no-store' });
    const envelope = await response.json().catch(() => null) as { ok?: boolean; message?: string; data?: ScanJobSnapshot } | null;
    if (!response.ok || !envelope?.ok || !envelope.data) {
      throw new Error(envelope?.message || `Không đọc được trạng thái tác vụ (HTTP ${response.status}).`);
    }
    const job = envelope.data;
    if (['SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED'].includes(job.status)) return job;
    if (attempt + 1 < maximumPolls) await wait(intervalMs);
  }
  throw new Error('Hết thời gian chờ tác vụ quét hoàn tất. Tác vụ vẫn được giữ trong hàng đợi.');
}
