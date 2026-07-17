import { Home } from '@/pages/Home'
import { Passport } from '@/pages/Passport'

export default function App() {
  const match = location.pathname.match(/^\/p\/([\w-]+)\/?$/)
  if (match) return <Passport slug={match[1]} />
  return <Home />
}
