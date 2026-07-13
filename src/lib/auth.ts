// ===========================================
// Auth Helper — Basic Auth for Dashboard
// ===========================================

import { config } from './config';
import { NextRequest, NextResponse } from 'next/server';
import { validateBasicAuthHeader } from './basicAuth';

/**
 * Validate Basic Auth credentials from Authorization header.
 * Returns true if auth is disabled or credentials match.
 */
export function validateBasicAuth(authHeader: string | null): boolean {
  if (!config.basicAuthEnabled) return true;
  return validateBasicAuthHeader(authHeader, config.basicAuthUsername, config.basicAuthPassword);
}

/**
 * Create Basic Auth challenge response headers.
 */
export function getAuthChallengeHeaders(): Record<string, string> {
  return {
    'WWW-Authenticate': 'Basic realm="ReviewPilot AI Dashboard", charset="UTF-8"',
  };
}

/**
 * Require auth for API routes. Returns error response if auth fails.
 */
export async function requireAuth(req: NextRequest): Promise<NextResponse | null> {
  const authHeader = req.headers.get('authorization');
  
  if (!validateBasicAuth(authHeader)) {
    return new NextResponse('Unauthorized', {
      status: 401,
      headers: getAuthChallengeHeaders(),
    });
  }
  
  return null;
}
