const DISPLAY: Record<string, string> = {
  ts: 'TypeScript', js: 'JavaScript', py: 'Python', rs: 'Rust', go: 'Go',
  md: 'Markdown', sql: 'SQL', css: 'CSS', html: 'HTML', sh: 'Shell',
  yml: 'YAML', yaml: 'YAML', json: 'JSON', tf: 'Terraform', other: 'Other',
}
const COLORS = ['bg-sky-500', 'bg-emerald-500', 'bg-amber-500', 'bg-violet-500', 'bg-rose-500', 'bg-zinc-400']

export function LanguageBar({ languages }: { languages: Record<string, number> }) {
  const entries = Object.entries(languages).sort((a, b) => b[1] - a[1])
  if (entries.length === 0) return null
  const top = entries.slice(0, 5)
  const rest = entries.slice(5).reduce((a, [, v]) => a + v, 0)
  const parts = rest > 0 ? [...top, ['other', rest] as [string, number]] : top
  const total = parts.reduce((a, [, v]) => a + v, 0)
  return (
    <div>
      <div className="flex h-2 w-full overflow-hidden rounded-full">
        {parts.map(([k, v], i) => (
          <div key={k} className={COLORS[i % COLORS.length]} style={{ width: `${(v / total) * 100}%` }} />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {parts.map(([k, v], i) => (
          <span key={k} className="flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${COLORS[i % COLORS.length]}`} />
            {DISPLAY[k] ?? k} {Math.round((v / total) * 100)}%
          </span>
        ))}
      </div>
    </div>
  )
}
