export function TurnkeyBadge({ className = '' }: { className?: string }) {
  return (
    <a
      href="/about"
      className={`inline-flex items-center opacity-80 transition-opacity hover:opacity-100 ${className}`}
      title="Protected by Turnkey — learn how"
    >
      <img src="/turnkey/secured-by-turnkey-white.svg" alt="Secured by Turnkey" className="h-6" />
    </a>
  )
}
