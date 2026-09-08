import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { verifyToken } from '@/lib/auth';

const ROLE_ALLOWED_PREFIXES: Record<string, string[]> = {
  citizen: ['/citizen'],
  student: ['/academic'],
  institution: ['/academic'],
  ngo: ['/industry'],
  govt_admin: ['/admin'],
};

const PROTECTED_PREFIXES = ['/admin', '/academic', '/industry', '/citizen'];

export function middleware(req: NextRequest) {
  const isProtectedPath = PROTECTED_PREFIXES.some((p) => req.nextUrl.pathname.startsWith(p));
  if (!isProtectedPath) return NextResponse.next();

  const token = req.cookies.get('token')?.value;
  const user = token ? verifyToken(token) : null;

  if (!user) {
    return NextResponse.redirect(new URL('/login', req.url));
  }

  const allowedPrefixes = ROLE_ALLOWED_PREFIXES[user.role] ?? [];
  const isAllowed = allowedPrefixes.some((p) => req.nextUrl.pathname.startsWith(p));

  if (!isAllowed) {
    return NextResponse.redirect(new URL('/unauthorized', req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/admin/:path*', '/academic/:path*', '/industry/:path*', '/citizen/:path*'],
};