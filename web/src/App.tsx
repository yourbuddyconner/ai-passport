import { useCallback, useEffect, useState } from 'react'
import { fetchMe, type Me } from '@/lib/api'
import { Landing } from '@/pages/Landing'
import { Onboarding } from '@/pages/Onboarding'
import { Dashboard } from '@/pages/Dashboard'
import { Passport } from '@/pages/Passport'
import { About } from '@/pages/About'
import { Leaderboard } from '@/pages/Leaderboard'
import { Ladder } from '@/pages/Ladder'

export default function App() {
  const path = location.pathname
  const cardMatch = path.match(/^\/p\/([\w-]+)\/?$/)
  const ladderMatch = path.match(/^\/l\/([\w-]+)\/?$/)
  const isLeaderboard = /^\/leaderboard\/?$/.test(path)
  const isPublic = !!cardMatch || !!ladderMatch || isLeaderboard || /^\/about\/?$/.test(path)

  const [me, setMe] = useState<Me | null>(null)
  const [loading, setLoading] = useState(!isPublic)

  const refresh = useCallback(() => {
    fetchMe()
      .then(setMe)
      .catch(() => setMe(null))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    // Public pages still fetch /api/me in the background — the leaderboard
    // and ladder pages need the visitor's own passport id for the join/leave
    // flow, but must render before that request resolves.
    refresh()
  }, [refresh])

  if (cardMatch) return <Passport slug={cardMatch[1]} />
  if (/^\/about\/?$/.test(path)) return <About />
  if (isLeaderboard) return <Leaderboard />
  if (ladderMatch) return <Ladder slug={ladderMatch[1]} me={me} />
  if (loading)
    return (
      <div className="flex min-h-screen items-center justify-center text-muted-foreground">
        Opening…
      </div>
    )
  if (!me) return <Landing onAuthed={refresh} />
  if (!me.user.onboarded) return <Onboarding me={me} onDone={refresh} />
  return <Dashboard me={me} onRefresh={refresh} onSignOut={() => setMe(null)} />
}
