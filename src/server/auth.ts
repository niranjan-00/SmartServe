import type { NextAuthOptions } from 'next-auth'
import CredentialsProvider from 'next-auth/providers/credentials'
import GoogleProvider from 'next-auth/providers/google'
import GitHubProvider from 'next-auth/providers/github'
import bcrypt from 'bcryptjs'
import { db } from '@/lib/db'
import { createLogger } from '@/server/logger'

const log = createLogger('auth')

/**
 * Auth.js (NextAuth v4) configuration — spec §8/§10.
 * - Email/password with bcrypt hashing (never plaintext)
 * - Google / GitHub OAuth enabled automatically when credentials exist
 * - JWT session strategy (works on serverless + node hosts)
 * - OAuth login never auto-creates an organization (spec §10)
 */

const providers: NextAuthOptions['providers'] = [
  CredentialsProvider({
    name: 'Email and password',
    credentials: {
      email: { label: 'Email', type: 'email' },
      password: { label: 'Password', type: 'password' },
    },
    async authorize(credentials) {
      if (!credentials?.email || !credentials?.password) return null
      const user = await db.user.findUnique({ where: { email: credentials.email.toLowerCase() } })
      if (!user || !user.passwordHash) return null
      const valid = await bcrypt.compare(credentials.password, user.passwordHash)
      if (!valid) return null
      log.info('login.success', { userId: user.id })
      return { id: user.id, name: user.name, email: user.email, image: user.image }
    },
  }),
]

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  providers.push(
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      allowDangerousEmailAccountLinking: true,
    }),
  )
}

if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
  providers.push(
    GitHubProvider({
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
      allowDangerousEmailAccountLinking: true,
    }),
  )
}

export const authOptions: NextAuthOptions = {
  providers,
  session: { strategy: 'jwt', maxAge: 60 * 60 * 24 * 7 },
  secret: process.env.AUTH_SECRET,
  pages: { signIn: '/login', error: '/login' },
  cookies: {
    sessionToken: {
      name: process.env.NODE_ENV === 'production' ? '__Secure-next-auth.session-token' : 'next-auth.session-token',
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: process.env.NODE_ENV === 'production',
      },
    },
  },
  callbacks: {
    async jwt({ token, user, account }) {
      if (user) {
        token.id = user.id
        token.email = user.email
        token.name = user.name
        token.picture = user.image ?? undefined
      }
      if (account?.provider && account.provider !== 'credentials') {
        // OAuth sign-in: upsert the user record on first login
        if (user?.email) {
          const existing = await db.user.findUnique({ where: { email: user.email.toLowerCase() } })
          if (!existing) {
            const created = await db.user.create({
              data: {
                email: user.email.toLowerCase(),
                name: user.name,
                image: user.image,
                emailVerified: new Date(),
              },
            })
            token.id = created.id
          } else {
            token.id = existing.id
          }
        }
      }
      return token
    },
    async session({ session, token }) {
      if (session.user && token.id) {
        ;(session.user as { id?: string }).id = token.id as string
      }
      return session
    },
  },
  events: {
    async signIn({ user, isNewUser }) {
      log.info('auth.signIn', { userId: user?.id, isNewUser })
    },
  },
}

/** Minimal server session shape used across services. */
export interface SessionUser {
  id: string
  name?: string | null
  email?: string | null
  image?: string | null
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const { getServerSession } = await import('next-auth')
  const session = await getServerSession(authOptions)
  if (!session?.user) return null
  const su = session.user as { id?: string; email?: string | null; name?: string | null; image?: string | null }
  if (!su.id && su.email) {
    const dbUser = await db.user.findUnique({ where: { email: su.email.toLowerCase() } })
    if (!dbUser) return null
    return { id: dbUser.id, name: dbUser.name, email: dbUser.email, image: dbUser.image }
  }
  return su.id ? { id: su.id, name: su.name, email: su.email, image: su.image } : null
}
