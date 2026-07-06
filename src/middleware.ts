// ===========================================
// Next.js Middleware — Basic Auth for Dashboard
// ===========================================

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Only protect dashboard and API routes (not public pages)
  if (pathname.startsWith('/dashboard') || pathname.startsWith('/api/')) {
    // Skip auth for public routes
    const isPublicRoute =
      pathname === '/api/app-health' ||
      (pathname.startsWith('/api/products') && request.method === 'GET');

    if (isPublicRoute) {
      return NextResponse.next();
    }

    const basicAuthEnabled = process.env.BASIC_AUTH_ENABLED === 'true';
    if (!basicAuthEnabled) return NextResponse.next();

    const authHeader = request.headers.get('authorization');
    if (!authHeader) {
      return new NextResponse('Authentication required', {
        status: 401,
        headers: {
          'WWW-Authenticate': 'Basic realm="ReviewPilot AI Dashboard", charset="UTF-8"',
        },
      });
    }

    const [scheme, encoded] = authHeader.split(' ');
    if (scheme !== 'Basic' || !encoded) {
      return new NextResponse('Invalid authentication', {
        status: 401,
        headers: {
          'WWW-Authenticate': 'Basic realm="ReviewPilot AI Dashboard", charset="UTF-8"',
        },
      });
    }

    try {
      const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
      const [username, password] = decoded.split(':');
      const validUser = process.env.BASIC_AUTH_USER || process.env.BASIC_AUTH_USERNAME || '';
      const validPass = process.env.BASIC_AUTH_PASSWORD || '';

      if (username !== validUser || password !== validPass) {
        return new NextResponse('Invalid credentials', {
          status: 401,
          headers: {
            'WWW-Authenticate': 'Basic realm="ReviewPilot AI Dashboard", charset="UTF-8"',
          },
        });
      }
    } catch {
      return new NextResponse('Invalid authentication', { status: 401 });
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/dashboard/:path*', '/api/:path*'],
};
