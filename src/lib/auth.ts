// ===========================================
// Auth Helper — Basic Auth for Dashboard
// ===========================================

import { config } from './config';

/**
 * Validate Basic Auth credentials from Authorization header.
 * Returns true if auth is disabled or credentials match.
 */
export function validateBasicAuth(authHeader: string | null): boolean {
  if (!config.basicAuthEnabled) return true;
  if (!authHeader) return false;

  const [scheme, encoded] = authHeader.split(' ');
  if (scheme !== 'Basic' || !encoded) return false;

  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
    const [username, password] = decoded.split(':');
    return username === config.basicAuthUsername && password === config.basicAuthPassword;
  } catch {
    return false;
  }
}

/**
 * Create Basic Auth challenge response headers.
 */
export function getAuthChallengeHeaders(): Record<string, string> {
  return {
    'WWW-Authenticate': 'Basic realm="ReviewPilot AI Dashboard", charset="UTF-8"',
  };
}
