import { Home } from '@/pages/Home'
import { About } from '@/pages/About'
import { Passport } from '@/pages/Passport'

export default function App() {
  const match = location.pathname.match(/^\/p\/([\w-]+)\/?$/)
  if (match) return <Passport slug={match[1]} />
  if (/^\/about\/?$/.test(location.pathname)) return <About />
  return <Home />
}
