// ===========================================
// Auth Helper — Basic Auth for Dashboard
// ===========================================

import { config } from './config';
import { NextRequest, NextResponse } from 'next/server';
import { validateBasicAuthHeader } from './basicAuth';

export type AdminPermission =
  | 'VIEW_PRODUCTS'
  | 'IMPORT_PRODUCTS'
  | 'EDIT_PRODUCTS'
  | 'RUN_QUALITY_CHECK'
  | 'REVIEW_DUPLICATES'
  | 'MERGE_DUPLICATES'
  | 'VIEW_PRICE_HISTORY'
  | 'MANAGE_CONTENT'
  | 'APPROVE_CONTENT'
  | 'PUBLISH_CONTENT'
  | 'VIEW_ANALYTICS'
  | 'MANAGE_ALERTS'
  | 'RUN_BULK_ACTION'
  | 'MANAGE_SOURCES'
  | 'MANAGE_AUTOMATION';

const ADMIN_PERMISSIONS = new Set<AdminPermission>([
  'VIEW_PRODUCTS', 'IMPORT_PRODUCTS', 'EDIT_PRODUCTS', 'RUN_QUALITY_CHECK', 'REVIEW_DUPLICATES',
  'MERGE_DUPLICATES', 'VIEW_PRICE_HISTORY', 'MANAGE_CONTENT', 'APPROVE_CONTENT', 'PUBLISH_CONTENT',
  'VIEW_ANALYTICS', 'MANAGE_ALERTS', 'RUN_BULK_ACTION', 'MANAGE_SOURCES', 'MANAGE_AUTOMATION',
]);

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

function configuredPermissions(): Set<AdminPermission> {
  const configured = process.env.SANDEAL_ADMIN_PERMISSIONS?.trim();
  if (!configured || configured === '*') return ADMIN_PERMISSIONS;
  return new Set(configured.split(',').map(value => value.trim()).filter((value): value is AdminPermission => ADMIN_PERMISSIONS.has(value as AdminPermission)));
}

/** Permissions come only from server configuration, never from request body/headers. */
export async function requirePermission(req: NextRequest, permission: AdminPermission): Promise<NextResponse | null> {
  const authError = await requireAuth(req);
  if (authError) return authError;
  if (!configuredPermissions().has(permission)) {
    return NextResponse.json({ ok: false, code: 'FORBIDDEN', message: 'Tài khoản không có quyền thực hiện thao tác này.' }, { status: 403 });
  }
  return null;
}

export function getServerActor(): string {
  return 'dashboard-admin';
}
