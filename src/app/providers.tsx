'use client'

import { SessionProvider } from 'next-auth/react'
import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

/** Global providers: auth session + server-state cache. */
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 15_000,
            retry: 1,
            refetchOnWindowFocus: true,
          },
        },
      }),
  )

  return (
    <SessionProvider>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </SessionProvider>
  )
}
