// ===========================================
// API Response Helper — Standard response format
// ===========================================

import { NextResponse } from 'next/server';
import { sanitizeErrorMessage } from './safety/operationGuard';

export interface ApiResponse<T = unknown> {
  ok: boolean;
  message: string;
  data?: T;
  error?: string;
}

export function successResponse<T>(message: string, data?: T, status = 200): NextResponse<ApiResponse<T>> {
  return NextResponse.json({ ok: true, message, data }, { status });
}

export function errorResponse(message: string, error?: string, status = 400): NextResponse<ApiResponse> {
  return NextResponse.json({ ok: false, message, error }, { status });
}

export function serverErrorResponse(message: string, err?: unknown): NextResponse<ApiResponse> {
  const errorMessage = sanitizeErrorMessage(err instanceof Error ? err.message : 'Unknown error');
  console.error(`[API Error] ${message}:`, errorMessage);
  return NextResponse.json(
    { ok: false, message, error: 'INTERNAL_ERROR' },
    { status: 500 }
  );
}
