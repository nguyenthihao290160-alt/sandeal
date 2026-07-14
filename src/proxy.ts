// ===========================================
// Next.js Middleware — Basic Auth for Dashboard
// ===========================================

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { validateBasicAuthHeader } from '@/lib/basicAuth';

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Only protect dashboard and API routes (not public pages)
  if (pathname.startsWith('/dashboard') || pathname.startsWith('/api/')) {
    // Skip auth for public routes
    const isPublicRoute =
      pathname === '/api/app-health' ||
      pathname === '/api/ai-bots/scheduler/tick' ||
      pathname.startsWith('/api/public/') ||
      (pathname === '/api/products' && request.method === 'GET' && request.nextUrl.searchParams.get('public') === 'true');

    if (isPublicRoute) {
      return NextResponse.next();
    }

    const basicAuthEnabled = process.env.BASIC_AUTH_ENABLED === 'true';
    if (!basicAuthEnabled) return NextResponse.next();

    const validUser = process.env.BASIC_AUTH_USER || process.env.BASIC_AUTH_USERNAME || '';
    const validPass = process.env.BASIC_AUTH_PASSWORD || '';
    if (!validateBasicAuthHeader(request.headers.get('authorization'), validUser, validPass)) {
      return new NextResponse('Invalid credentials', {
        status: 401,
        headers: {
          'WWW-Authenticate': 'Basic realm="ReviewPilot AI Dashboard", charset="UTF-8"',
        },
      });
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/dashboard/:path*', '/api/:path*'],
};
