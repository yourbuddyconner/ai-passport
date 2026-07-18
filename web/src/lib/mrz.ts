/** Two-line, 44-character machine-readable zone, like the real document. */
export function mrz(name: string, slug: string, score: number, grade: string): [string, string] {
  const clean = (s: string) =>
    s
      .toUpperCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Z0-9 ]/g, '')
      .trim()
      .replace(/\s+/g, '<')
  const pad = (s: string) => (s + '<'.repeat(44)).slice(0, 44)
  return [
    pad(`P<AIPASS<<${clean(name)}`),
    pad(`${clean(slug.replace(/-/g, ' '))}<<${score}<${clean(grade)}`),
  ]
}
