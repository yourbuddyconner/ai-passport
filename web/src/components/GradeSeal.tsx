/** The embossed foil seal: score in the center, grade around the rim. */
export function GradeSeal({ score, grade, size = 96 }: { score: number; grade: string; size?: number }) {
  const id = `seal-arc-${size}`
  return (
    <div
      className="seal relative flex shrink-0 items-center justify-center rounded-full"
      style={{ width: size, height: size }}
      role="img"
      aria-label={`Fluency score ${score} out of 100 — grade ${grade}`}
    >
      <svg viewBox="0 0 100 100" className="absolute inset-0" aria-hidden="true">
        <defs>
          <path id={id} d="M 50,50 m -36,0 a 36,36 0 1,1 72,0 a 36,36 0 1,1 -72,0" />
        </defs>
        <circle cx="50" cy="50" r="47" fill="none" stroke="rgba(43,33,24,0.55)" strokeWidth="1.5" />
        <circle
          cx="50"
          cy="50"
          r="30"
          fill="none"
          stroke="rgba(43,33,24,0.55)"
          strokeWidth="1"
          strokeDasharray="2 2"
        />
        <text
          fill="rgba(43,33,24,0.8)"
          fontSize="10.5"
          fontFamily="ui-monospace, monospace"
          fontWeight="700"
          letterSpacing="2.5"
        >
          <textPath href={`#${id}`} startOffset="0%">
            {`${grade} · AI PASSPORT · `.toUpperCase()}
          </textPath>
        </text>
      </svg>
      <span
        className="relative font-bold tabular-nums text-[#2b2118]"
        style={{ fontSize: size * 0.28 }}
      >
        {score}
      </span>
    </div>
  )
}
