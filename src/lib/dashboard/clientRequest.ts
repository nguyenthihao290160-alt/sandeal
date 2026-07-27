export type ClientRequestErrorCode =
  | 'REQUEST_ABORTED'
  | 'REQUEST_TIMEOUT'
  | 'NETWORK_ERROR'
  | 'HTTP_ERROR'
  | 'EMPTY_RESPONSE'
  | 'INVALID_JSON'
  | 'RESPONSE_TOO_LARGE';

export class ClientRequestError extends Error {
  readonly code: ClientRequestErrorCode;
  readonly status?: number;
  readonly details?: unknown;

  constructor(
    code: ClientRequestErrorCode,
    message: string,
    options: { status?: number; details?: unknown; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ClientRequestError';
    this.code = code;
    this.status = options.status;
    this.details = options.details;
  }
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ClientJsonRequestOptions extends RequestInit {
  timeoutMs?: number;
  maximumResponseBytes?: number;
  fetchImpl?: FetchLike;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAXIMUM_RESPONSE_BYTES = 1024 * 1024;

function boundedPositiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(maximum, Math.floor(value!)));
}

async function readBoundedText(response: Response, maximumBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new ClientRequestError('RESPONSE_TOO_LARGE', 'The response exceeded the client response-size limit.', {
      status: response.status,
    });
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const chunks: string[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel();
        throw new ClientRequestError('RESPONSE_TOO_LARGE', 'The response exceeded the client response-size limit.', {
          status: response.status,
        });
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The stream may already be cancelled after a size-limit violation.
    }
  }
}

function parseJson(text: string, status: number): unknown {
  if (!text.trim()) {
    throw new ClientRequestError('EMPTY_RESPONSE', 'The server returned an empty response.', { status });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new ClientRequestError('INVALID_JSON', 'The server returned invalid JSON.', { status, cause });
  }
}

export async function requestClientJson<T>(
  input: RequestInfo | URL,
  options: ClientJsonRequestOptions = {},
): Promise<T> {
  const {
    timeoutMs: configuredTimeoutMs,
    maximumResponseBytes: configuredMaximumBytes,
    fetchImpl = fetch,
    signal: callerSignal,
    ...requestInit
  } = options;
  const timeoutMs = boundedPositiveInteger(configuredTimeoutMs, DEFAULT_TIMEOUT_MS, 60_000);
  const maximumResponseBytes = boundedPositiveInteger(
    configuredMaximumBytes,
    DEFAULT_MAXIMUM_RESPONSE_BYTES,
    4 * 1024 * 1024,
  );
  const controller = new AbortController();
  let timedOut = false;
  let rejectCallerAbort: ((reason: ClientRequestError) => void) | undefined;
  const callerAbort = new Promise<never>((_resolve, reject) => {
    rejectCallerAbort = reject;
  });
  const forwardAbort = () => {
    controller.abort(callerSignal?.reason);
    rejectCallerAbort?.(new ClientRequestError('REQUEST_ABORTED', 'The client request was cancelled.', {
      cause: callerSignal?.reason,
    }));
  };
  callerSignal?.addEventListener('abort', forwardAbort, { once: true });
  if (callerSignal?.aborted) forwardAbort();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      const cause = new DOMException('The client request timed out.', 'TimeoutError');
      controller.abort(cause);
      reject(new ClientRequestError('REQUEST_TIMEOUT', 'The client request timed out.', { cause }));
    }, timeoutMs);
  });

  try {
    const response = await Promise.race([
      fetchImpl(input, { ...requestInit, signal: controller.signal }),
      timeout,
      callerAbort,
    ]);
    const body = parseJson(await readBoundedText(response, maximumResponseBytes), response.status);
    if (!response.ok) {
      throw new ClientRequestError('HTTP_ERROR', `The server returned HTTP ${response.status}.`, {
        status: response.status,
        details: body,
      });
    }
    return body as T;
  } catch (cause) {
    if (cause instanceof ClientRequestError) throw cause;
    if (callerSignal?.aborted) {
      throw new ClientRequestError('REQUEST_ABORTED', 'The client request was cancelled.', { cause });
    }
    if (timedOut) {
      throw new ClientRequestError('REQUEST_TIMEOUT', 'The client request timed out.', { cause });
    }
    throw new ClientRequestError('NETWORK_ERROR', 'The client request failed before a valid response was received.', {
      cause,
    });
  } finally {
    if (timer) clearTimeout(timer);
    callerSignal?.removeEventListener('abort', forwardAbort);
  }
}

function safeMessageText(message: unknown): string | undefined {
  if (typeof message !== 'string') return undefined;
  const sanitized = message.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return sanitized ? sanitized.slice(0, 300) : undefined;
}

function safeServerMessage(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return safeMessageText('message' in value ? (value as { message?: unknown }).message : undefined);
}

export function clientRequestMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ClientRequestError)) {
    return error instanceof Error ? safeMessageText(error.message) || fallback : fallback;
  }
  const serverMessage = safeServerMessage(error.details);
  if (serverMessage) return serverMessage;
  if (error.code === 'REQUEST_TIMEOUT') return 'Yêu cầu đã hết thời gian chờ. Dữ liệu hiện tại không bị thay đổi.';
  if (error.code === 'REQUEST_ABORTED') return 'Yêu cầu đã được thay thế hoặc hủy an toàn.';
  if (error.code === 'INVALID_JSON' || error.code === 'EMPTY_RESPONSE') {
    return 'Máy chủ trả về phản hồi không hợp lệ. Dữ liệu hiện tại không bị thay đổi.';
  }
  if (error.code === 'RESPONSE_TOO_LARGE') {
    return 'Phản hồi vượt quá giới hạn an toàn. Dữ liệu hiện tại không bị thay đổi.';
  }
  if (error.status) return `Máy chủ từ chối yêu cầu (HTTP ${error.status}). Dữ liệu hiện tại không bị thay đổi.`;
  return fallback;
}
