// ===========================================
// API Response Helper — Standard response format
// ===========================================

import { NextResponse } from 'next/server';

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
  const errorMessage = err instanceof Error ? err.message : 'Lỗi không xác định';
  // Never log full tokens/secrets — only log safe error messages
  console.error(`[API Error] ${message}:`, errorMessage);
  return NextResponse.json(
    { ok: false, message, error: errorMessage },
    { status: 500 }
  );
}
