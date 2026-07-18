// Dynamic Open Graph preview images: a 1200×630 render of the passport
// spread, generated in the Worker with satori (workers-og). Fonts are
// fetched once and cached via the Cache API.

import { ImageResponse } from 'workers-og'
import type { CardData } from './score'

const FONTS = [
  {
    name: 'Fraunces',
    url: 'https://cdn.jsdelivr.net/npm/@fontsource/fraunces@5.2.5/files/fraunces-latin-600-normal.woff',
    weight: 600 as const,
  },
  {
    name: 'Mono',
    url: 'https://cdn.jsdelivr.net/npm/@fontsource/jetbrains-mono@5.2.5/files/jetbrains-mono-latin-400-normal.woff',
    weight: 400 as const,
  },
  {
    name: 'Mono',
    url: 'https://cdn.jsdelivr.net/npm/@fontsource/jetbrains-mono@5.2.5/files/jetbrains-mono-latin-700-normal.woff',
    weight: 700 as const,
  },
]

async function loadFont(url: string): Promise<ArrayBuffer> {
  const cache = caches.default
  const cached = await cache.match(url)
  if (cached) return cached.arrayBuffer()
  const res = await fetch(url)
  if (!res.ok) throw new Error(`font fetch failed: ${url}`)
  await cache.put(url, res.clone())
  return res.arrayBuffer()
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function mrzLine(name: string): string {
  const clean = name
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z0-9 ]/g, '')
    .trim()
    .replace(/\s+/g, '<')
  return (`P<AIPASS<<${clean}` + '<'.repeat(44)).slice(0, 44)
}

const HARNESS_LABELS: Record<string, string> = {
  'claude-code': 'CLAUDE CODE',
  codex: 'CODEX CLI',
}

function stat(value: string, label: string): string {
  return `<div style="display:flex;flex-direction:column;align-items:center;padding:14px 22px;border:1px solid #d8cbae;border-radius:8px;background:rgba(255,255,255,0.4)">
    <span style="font-size:34px;font-weight:700;font-family:Mono;color:#2b2118">${value}</span>
    <span style="font-size:15px;font-family:Mono;color:#756449">${label}</span>
  </div>`
}

export async function renderCardOg(
  name: string,
  card: CardData | null,
): Promise<Response> {
  const fonts = await Promise.all(
    FONTS.map(async (f) => ({ name: f.name, data: await loadFont(f.url), weight: f.weight })),
  )

  const stamps = (card?.harnesses ?? [])
    .map(
      (h, i) => `<div style="display:flex;transform:rotate(${i % 2 ? 4 : -5}deg);border:3px solid ${
        i % 2 ? '#a03333' : '#2e6e4e'
      };color:${i % 2 ? '#a03333' : '#2e6e4e'};border-radius:10px;padding:8px 16px;font-family:Mono;font-weight:700;font-size:18px;letter-spacing:2px;opacity:0.85">${
        HARNESS_LABELS[h] ?? esc(h.toUpperCase())
      }</div>`,
    )
    .join('')

  const statsRow = card
    ? `<div style="display:flex;gap:14px;margin-top:26px">
        ${stat(String(card.totalSessions), 'sessions')}
        ${stat(String(card.repositories), 'repos')}
        ${stat(fmt(card.totalToolCalls), 'tool calls')}
        ${stat(fmt(card.totalOutputTokens), 'tokens out')}
        ${stat(String(card.achievements.filter((a) => a.earned).length), 'endorsements')}
      </div>`
    : `<div style="display:flex;margin-top:26px;font-family:Mono;font-size:22px;color:#756449">Enclave-verified proof of AI fluency</div>`

  const seal = card
    ? `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;width:190px;height:190px;border-radius:999px;background:radial-gradient(circle at 32% 28%, #f0d98b 0%, #d0a94e 34%, #a8842f 68%, #8a6a20 100%);box-shadow:inset 0 2px 4px rgba(255,245,210,0.75)">
        <span style="font-size:64px;font-weight:700;font-family:Mono;color:#2b2118">${card.score}</span>
        <span style="font-size:16px;font-family:Mono;font-weight:700;letter-spacing:2px;color:#4a3a14">${esc(card.grade.toUpperCase())}</span>
      </div>`
    : `<div style="display:flex;align-items:center;justify-content:center;width:190px;height:190px;border-radius:999px;background:radial-gradient(circle at 32% 28%, #f0d98b 0%, #d0a94e 34%, #a8842f 68%, #8a6a20 100%)">
        <span style="font-size:70px">✓</span>
      </div>`

  const html = `
  <div style="display:flex;flex-direction:column;width:1200px;height:630px;background:#180e11;padding:34px">
    <div style="display:flex;flex-direction:column;flex:1;background:#f3ecdd;border-radius:14px;border:1px solid rgba(200,184,143,0.5);padding:44px 54px;position:relative">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex:1">
        <div style="display:flex;flex-direction:column;max-width:820px">
          <span style="font-family:Mono;font-size:19px;letter-spacing:6px;color:#756449">AI PASSPORT · VERIFIED AI USE</span>
          <span style="font-family:Fraunces;font-size:76px;color:#2b2118;margin-top:14px">${esc(name)}</span>
          <div style="display:flex;gap:18px;margin-top:22px">${stamps}</div>
          ${statsRow}
        </div>
        ${seal}
      </div>
      <div style="display:flex;align-items:center;border-top:2px solid #d8cbae;margin-top:24px;padding-top:18px">
        <span style="font-family:Mono;font-size:24px;letter-spacing:4px;color:#3a2f22">${mrzLine(name).replace(/</g, '\u2039')}</span>
      </div>
    </div>
    <div style="display:flex;justify-content:center;margin-top:16px">
      <span style="font-family:Mono;font-size:18px;letter-spacing:3px;color:#8a7a5f">AIPASSPORT.DEV · SECURED BY TURNKEY</span>
    </div>
  </div>`

  return new ImageResponse(html, {
    width: 1200,
    height: 630,
    fonts,
    headers: {
      'content-type': 'image/png',
      'cache-control': 'public, max-age=3600',
    },
  })
}
