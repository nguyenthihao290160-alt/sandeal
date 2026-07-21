import type { Instrumentation } from 'next';
import { classifyRequestError } from '@/lib/buildMismatch';
import { getReleaseIdentity } from '@/lib/releaseIdentity';

function safePath(value: string): string {
  return String(value || '/').split('?')[0].slice(0, 300);
}

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  const classification = classifyRequestError(error, context.routeType);
  const errorMetadata = error && typeof error === 'object'
    ? error as { name?: unknown; digest?: unknown }
    : {};
  const event = {
    event: 'SANDEAL_REQUEST_ERROR',
    classification: classification.classification,
    currentIncident: classification.currentIncident,
    severity: classification.severity,
    releaseId: getReleaseIdentity().releaseId,
    method: request.method,
    path: safePath(request.path),
    routePath: safePath(context.routePath),
    routeType: context.routeType,
    errorName: typeof errorMetadata.name === 'string' ? errorMetadata.name.slice(0, 80) : 'RequestError',
    digest: typeof errorMetadata.digest === 'string' ? errorMetadata.digest.slice(0, 160) : undefined,
  };
  if (classification.currentIncident) console.error(JSON.stringify(event));
  else console.info(JSON.stringify(event));
};
