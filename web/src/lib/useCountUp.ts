import { useEffect, useRef, useState } from 'react'

/**
 * Animate a number toward `target`: counts up from `initial` on mount, then
 * eases between values whenever `target` changes. Respects reduced motion.
 */
export function useCountUp(target: number, { initial, duration = 700 }: { initial?: number; duration?: number } = {}) {
  const first = useRef(true)
  const prevRef = useRef(initial ?? target)
  const [display, setDisplay] = useState(initial ?? target)

  useEffect(() => {
    const from = first.current ? (prevRef.current ?? target) : prevRef.current
    first.current = false
    if (from === target) {
      setDisplay(target)
      return
    }
    prevRef.current = target
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setDisplay(target)
      return
    }
    let raf = 0
    const start = performance.now()
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - t, 3)
      setDisplay(Math.round(from + (target - from) * eased))
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, duration])

  return display
}
