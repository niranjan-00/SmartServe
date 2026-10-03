import { getToken } from 'next-auth/jwt'
import { NextRequest, NextResponse } from 'next/server'

/**
 * Route protection (spec §8/§10): unauthenticated users are bounced to
 * /login; authenticated users skip the auth pages. Page-level data
 * authorization stays server-side in the API layer.
 */

const PUBLIC_PATHS = ['/login', '/register']

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl

  const token = await getToken({ req, secret: process.env.AUTH_SECRET })
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))

  if (!token && !isPublic) {
    const loginUrl = new URL('/login', req.url)
    if (pathname !== '/') loginUrl.searchParams.set('callbackUrl', pathname)
    return NextResponse.redirect(loginUrl)
  }

  if (token && isPublic) {
    return NextResponse.redirect(new URL('/', req.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|icon|apple-icon|public|.*\\.png$|.*\\.svg$|.*\\.jpg$).*)'],
}
