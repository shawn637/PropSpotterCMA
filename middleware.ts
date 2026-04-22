import { NextRequest, NextResponse } from 'next/server';

/**
 * Shared-password gate via HTTP Basic auth. Reads APP_PASSWORD from the env.
 * If APP_PASSWORD is unset the gate is disabled — leave it unset only for
 * local development.
 *
 * The username is not checked. Use any non-empty value at the browser prompt
 * (e.g. "propspotter") and the password Shawn has set in Vercel.
 */
export function middleware(req: NextRequest) {
  const expected = process.env.APP_PASSWORD;
  if (!expected) return NextResponse.next();

  const auth = req.headers.get('authorization') ?? '';
  if (auth.startsWith('Basic ')) {
    try {
      const decoded = atob(auth.slice(6));
      const idx = decoded.indexOf(':');
      const password = idx === -1 ? decoded : decoded.slice(idx + 1);
      if (timingSafeEqual(password, expected)) {
        return NextResponse.next();
      }
    } catch {
      /* fall through to 401 */
    }
  }

  return new NextResponse('Authentication required.', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="PropSpotter", charset="UTF-8"',
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) {
    out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return out === 0;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
