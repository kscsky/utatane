// 网易云 Web API 封装：统一走 /api 前缀，会话 Cookie 只留在本机
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = 'https://music.163.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const SESSION_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'session.json')

let cookieJar = new Map()

export function loadSession() {
  try {
    const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'))
    cookieJar = new Map(Object.entries(raw.cookies || {}))
  } catch {
    cookieJar = new Map()
  }
  persist()
}

function persist() {
  const tmp = SESSION_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify({ cookies: Object.fromEntries(cookieJar), savedAt: Date.now() }, null, 2))
  fs.renameSync(tmp, SESSION_FILE)
}

export function cookieHeader() {
  return [...cookieJar].map(([k, v]) => `${k}=${v}`).join('; ')
}

export function loggedIn() {
  return cookieJar.has('MUSIC_U')
}

export function logout() {
  cookieJar.delete('MUSIC_U')
  cookieJar.delete('MUSIC_A')
  cookieJar.delete('NMTID')
  persist()
}

function absorb(res) {
  let changed = false
  for (const line of res.headers.getSetCookie?.() || []) {
    const m = /^([^=]+)=([^;]*)/.exec(line)
    if (!m) continue
    const [, name, value] = m
    if (!name.startsWith('__Secure-')) continue
    if (!value || /expired/i.test(value)) {
      if (cookieJar.delete(name)) changed = true
      continue
    }
    if (cookieJar.get(name) !== value) {
      cookieJar.set(name, value)
      changed = true
    }
  }
  if (changed) persist()
}

async function send(p, params, { method = 'POST' } = {}) {
  const headers = {
    'User-Agent': UA,
    Referer: `${BASE}/`,
    Origin: BASE,
    Cookie: cookieHeader(),
  }
  let url = BASE + p
  let body
  if (method === 'GET') {
    if (params) url += '?' + new URLSearchParams(params)
  } else {
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
    body = params ? new URLSearchParams(params) : ''
  }
  const res = await fetch(url, { method, headers, body, redirect: 'manual' })
  absorb(res)
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { code: res.status, raw: text.slice(0, 300) } }
  return json
}

export const qr = {
  create: () => send('/api/login/qrcode/unikey', { type: 1 }).then(r => ({ unikey: r.unikey, code: r.code })),
  // 100 已确认 800 已过期 803 已扫描待确认
  check: (key) => send('/api/login/qrcode/client/login', { key, type: 1 }),
}

export const song = {
  detail: (ids) => send('/api/song/detail', { ids: JSON.stringify(ids) }),
  sheets: (id) => send('/api/music/sheet/list/v1', { id, abTest: 'b' }),
  lyric: (id) => send('/api/song/lyric', { id, lv: -1, kv: -1, tv: -1 }, { method: 'GET' }),
  // withCover 在未登录时会被判 400，固定用 br 请求最高可用码率
  audio: (ids) => send('/api/song/enhance/player/url', { ids: JSON.stringify(ids), br: 999000 }),
}

export const search = (keyword, limit = 20) =>
  send('/api/search/get/web', { s: keyword, type: 1, limit, offset: 0 })

const chartCache = new Map()

// 官方榜单：trackIds 在 detail 里为空，直接取 result.tracks
export const CHARTS = [
  { id: '3778678', name: '热歌榜' },
  { id: '88888888', name: '新歌榜' },
  { id: '2884035', name: '原创榜' },
]

export async function chart(id, ttl = 30 * 60 * 1000) {
  const hit = chartCache.get(id)
  if (hit && Date.now() - hit.at < ttl) return hit.data
  const r = await send('/api/playlist/detail', { id })
  const res = r.result || {}
  const tracks = (res.tracks || []).slice(0, 60).map(t => ({
    id: t.id,
    name: t.name,
    artist: (t.ar || t.artists || []).map(a => a.name).join(' / '),
    album: t.al?.name || t.album?.name || '',
    duration: t.dt || t.duration || 0,
    cover: t.al?.picUrl || t.album?.picUrl || '',
    fee: t.fee,
  }))
  // sheet/list 需逐首请求，并发 6
  let i = 0
  const worker = async () => {
    while (i < tracks.length) {
      const t = tracks[i++]
      try {
        const d = await song.sheets(t.id)
        const list = d?.data?.musicSheetSimpleInfoVOS || []
        t.sheetCount = list.length
        t.bpm = list.find(s => s.bpm > 0)?.bpm || 0
      } catch { t.sheetCount = 0; t.bpm = 0 }
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker))
  const data = { name: res.name || '', tracks }
  chartCache.set(id, { at: Date.now(), data })
  return data
}


export async function proxyImage(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: `${BASE}/`, Cookie: cookieHeader() },
    redirect: 'follow',
  })
  const buf = Buffer.from(await res.arrayBuffer())
  return { buf, type: res.headers.get('content-type') || 'image/jpeg', status: res.status }
}

export async function proxyAudio(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Referer: `${BASE}/`,
      Cookie: cookieHeader(),
      Range: process.utataneRange || undefined,
    },
    redirect: 'follow',
  })
  return { upstream: res, status: res.status }
}

export function uid() {
  return crypto.randomBytes(8).toString('hex')
}

loadSession()
