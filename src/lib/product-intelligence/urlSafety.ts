import { lookup } from 'dns/promises';
import { request as requestHttp, type IncomingHttpHeaders, type RequestOptions } from 'node:http';
import { request as requestHttps } from 'node:https';

import {
  isBlockedHostname,
  isPrivateNetworkAddress,
  validateExternalUrl,
} from './urlValidation';
export {
  isBlockedHostname,
  isPrivateNetworkAddress,
  validateExternalUrl,
} from './urlValidation';
export type { UrlSafetyResult } from './urlValidation';

export interface PublicDnsAddress {
  address: string;
  family: 4 | 6;
}

export async function resolvePublicDns(
  hostname: string,
  lookupImpl: typeof lookup = lookup,
): Promise<PublicDnsAddress[]> {
  if (isBlockedHostname(hostname)) throw new Error('PRIVATE_NETWORK');
  const records = await lookupImpl(hostname, { all: true, verbatim: true });
  if (!records.length || records.some(record => isPrivateNetworkAddress(record.address))) {
    throw new Error('PRIVATE_NETWORK');
  }
  return records.map(record => ({ address: record.address, family: record.family as 4 | 6 }));
}

export async function assertPublicDns(hostname: string): Promise<void> {
  await resolvePublicDns(hostname);
}

async function resolvePublicDnsWithTimeout(hostname: string, timeoutMs: number): Promise<PublicDnsAddress[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      resolvePublicDns(hostname),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new DOMException('External DNS resolution timed out', 'TimeoutError')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function responseHeaders(input: IncomingHttpHeaders): Headers {
  const output = new Headers();
  for (const [key, value] of Object.entries(input)) {
    if (Array.isArray(value)) value.forEach(item => output.append(key, item));
    else if (value !== undefined) output.set(key, value);
  }
  return output;
}

async function requestPinnedPublicAddress(input: {
  url: URL;
  method: 'GET' | 'HEAD';
  headers: Record<string, string>;
  timeoutMs: number;
  maximumBytes: number;
  allowPartialBody: boolean;
}): Promise<Response> {
  const resolutionStartedAt = Date.now();
  const addresses = await resolvePublicDnsWithTimeout(input.url.hostname, input.timeoutMs);
  const transportTimeoutMs = Math.max(1, input.timeoutMs - (Date.now() - resolutionStartedAt));
  const pinned = addresses[0];
  const requestFunction = input.url.protocol === 'https:' ? requestHttps : requestHttp;
  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const clearDeadline = () => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      deadlineTimer = undefined;
    };
    const finishReject = (error: Error) => {
      if (settled) return;
      settled = true;
      clearDeadline();
      reject(error);
    };
    const lookupPinned = (
      _hostname: string,
      options: unknown,
      callback: (...args: unknown[]) => void,
    ) => {
      const wantsAll = Boolean(options && typeof options === 'object' && 'all' in options && (options as { all?: boolean }).all);
      if (wantsAll) callback(null, [pinned]);
      else callback(null, pinned.address, pinned.family);
    };
    const requestOptions: RequestOptions = {
      protocol: input.url.protocol,
      hostname: input.url.hostname,
      port: input.url.port || undefined,
      path: `${input.url.pathname}${input.url.search}`,
      method: input.method,
      headers: {
        ...input.headers,
        'Accept-Encoding': 'identity',
      },
      agent: false,
      lookup: lookupPinned as RequestOptions['lookup'],
    };
    const request = requestFunction(requestOptions, response => {
      const status = response.statusCode || 502;
      const headers = responseHeaders(response.headers);
      const encoding = String(headers.get('content-encoding') || 'identity').trim().toLowerCase();
      if (encoding && encoding !== 'identity') {
        response.destroy();
        finishReject(new Error('UNSAFE_CONTENT_ENCODING'));
        return;
      }
      const declared = Number(headers.get('content-length') || 0);
      if (!input.allowPartialBody && declared > input.maximumBytes) {
        response.destroy();
        finishReject(new Error('RESPONSE_TOO_LARGE'));
        return;
      }
      if (input.method === 'HEAD') {
        response.resume();
        const output = new Response(null, { status, headers });
        Object.defineProperty(output, 'url', { value: input.url.toString() });
        settled = true;
        clearDeadline();
        resolve(output);
        return;
      }

      const chunks: Uint8Array[] = [];
      let total = 0;
      const finishResponse = () => {
        if (settled) return;
        settled = true;
        const body = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const responseBody = [204, 205, 304].includes(status) ? null : body;
        const output = new Response(responseBody, { status, headers });
        Object.defineProperty(output, 'url', { value: input.url.toString() });
        clearDeadline();
        resolve(output);
      };
      response.on('data', (chunk: Buffer) => {
        if (settled) return;
        const remaining = input.maximumBytes - total;
        if (chunk.byteLength > remaining) {
          if (!input.allowPartialBody) {
            response.destroy();
            finishReject(new Error('RESPONSE_TOO_LARGE'));
            return;
          }
          if (remaining > 0) {
            const partial = chunk.subarray(0, remaining);
            chunks.push(partial);
            total += partial.byteLength;
          }
          finishResponse();
          response.destroy();
          return;
        }
        chunks.push(chunk);
        total += chunk.byteLength;
      });
      response.on('end', finishResponse);
      response.on('error', finishReject);
    });
    deadlineTimer = setTimeout(() => {
      const error = new DOMException('External request timed out', 'TimeoutError');
      request.destroy(error);
    }, transportTimeoutMs);
    request.on('error', finishReject);
    request.end();
  });
}

export async function fetchExternalSafely(
  value: string,
  options: {
    timeoutMs?: number;
    maxBytes?: number;
    maxRedirects?: number;
    resolveDns?: boolean;
    fetchImpl?: typeof fetch;
    method?: 'GET' | 'HEAD';
    headers?: Record<string, string>;
    allowPartialBody?: boolean;
  } = {},
): Promise<{ response: Response; finalUrl: string; body: Uint8Array }> {
  const timeoutMs = Math.max(500, Math.min(options.timeoutMs || 8_000, 20_000));
  const maxBytes = Math.max(1_024, Math.min(options.maxBytes || 512 * 1_024, 2 * 1024 * 1024));
  const maxRedirects = Math.max(0, Math.min(options.maxRedirects ?? 4, 5));
  const method = options.method || 'GET';
  const headers = {
    Accept: 'text/html,application/json;q=0.9,*/*;q=0.1',
    ...(method === 'GET' && !options.allowPartialBody ? { Range: `bytes=0-${maxBytes - 1}` } : {}),
    ...(options.headers || {}),
  };
  const fetchImpl = options.fetchImpl;
  let current = value;
  const visited = new Set<string>();
  const deadline = Date.now() + timeoutMs;
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const validated = validateExternalUrl(current);
    if (!validated.safe || !validated.normalizedUrl) throw new Error(validated.code || 'INVALID_URL');
    current = validated.normalizedUrl;
    if (visited.has(current)) throw new Error('REDIRECT_LOOP');
    visited.add(current);
    const parsed = new URL(current);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new DOMException('External request timed out', 'TimeoutError');
    let response: Response;
    if (fetchImpl) {
      if (options.resolveDns !== false) await assertPublicDns(parsed.hostname);
      response = await fetchImpl(current, {
        method,
        redirect: 'manual',
        headers,
        signal: AbortSignal.timeout(remainingMs),
      });
    } else {
      response = await requestPinnedPublicAddress({
        url: parsed,
        method,
        headers,
        timeoutMs: remainingMs,
        maximumBytes: maxBytes,
        allowPartialBody: options.allowPartialBody === true,
      });
    }
    const contentEncoding = String(response.headers.get('content-encoding') || 'identity').trim().toLowerCase();
    if (contentEncoding && contentEncoding !== 'identity') throw new Error('UNSAFE_CONTENT_ENCODING');
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      if (redirect === maxRedirects) throw new Error('TOO_MANY_REDIRECTS');
      current = new URL(response.headers.get('location')!, current).toString();
      try {
        await response.body?.cancel();
      } catch {
        // The bounded response may already be fully consumed by the pinned transport.
      }
      continue;
    }
    const declared = Number(response.headers.get('content-length') || 0);
    if (!options.allowPartialBody && declared > maxBytes) throw new Error('RESPONSE_TOO_LARGE');
    if (!response.body) return { response, finalUrl: current, body: new Uint8Array() };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      total += chunk.byteLength;
      if (total > maxBytes) {
        const overflow = total - maxBytes;
        const retained = overflow > 0 ? chunk.subarray(0, chunk.byteLength - overflow) : chunk;
        if (retained.byteLength) chunks.push(retained);
        total = maxBytes;
        await reader.cancel();
        if (!options.allowPartialBody) throw new Error('RESPONSE_TOO_LARGE');
        break;
      }
      chunks.push(chunk);
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    const responseBody = method === 'HEAD' || [204, 205, 304].includes(response.status) ? null : body;
    const replayable = new Response(responseBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    Object.defineProperty(replayable, 'url', { value: current });
    return { response: replayable, finalUrl: current, body };
  }
  throw new Error('TOO_MANY_REDIRECTS');
}
