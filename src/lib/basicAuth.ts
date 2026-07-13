import { timingSafeEqual } from 'crypto';

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

/** Validate a Basic authorization header without ever accepting an empty configuration. */
export function validateBasicAuthHeader(
  authHeader: string | null,
  expectedUsername: string,
  expectedPassword: string,
): boolean {
  if (!expectedUsername || !expectedPassword || !authHeader) return false;
  const separator = authHeader.indexOf(' ');
  if (separator < 1 || authHeader.slice(0, separator).toLowerCase() !== 'basic') return false;
  try {
    const decoded = Buffer.from(authHeader.slice(separator + 1).trim(), 'base64').toString('utf8');
    const credentialSeparator = decoded.indexOf(':');
    if (credentialSeparator < 0) return false;
    return safeEqual(decoded.slice(0, credentialSeparator), expectedUsername)
      && safeEqual(decoded.slice(credentialSeparator + 1), expectedPassword);
  } catch {
    return false;
  }
}
