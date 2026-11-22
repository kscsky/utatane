// utatane M0 — 极简本机服务：网易云代理 + 静态前端
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import QRCode from 'qrcode'
import * as ncm from './ncm.mjs'

const audioMap = new Map()

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')
const PORT = Number(process.env.PORT || 5177)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

const json = (res, code, data) => {
  const body = JSON.stringify(data)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { return {} }
}

const api = {
  'GET /api/session': async () => ({ logged: ncm.loggedIn() }),

  'POST /api/qr/create': async () => {
    const r = await ncm.qr.create()
    if (!r.unikey) return { error: 'unikey 获取失败', raw: r }
    const png = await QRCode.toDataURL(`https://music.163.com/login?codekey=${r.unikey}`, {
      margin: 1, width: 260, color: { dark: '#0d0d10', light: '#ffffff' },
    })
    return { unikey: r.unikey, image: png }
  },

  'POST /api/qr/check': async (req) => {
    const { unikey } = await readBody(req)
    if (!unikey) return { error: '缺少 unikey' }
    const r = await ncm.qr.check(unikey)
    return { code: r.code, message: r.message }
  },

  'POST /api/logout': async () => { ncm.logout(); return { ok: true } },

  'GET /api/search': async (req, url) => {
    const keyword = url.searchParams.get('q') || ''
    if (!keyword) return { songs: [] }
    const r = await ncm.search(keyword, Number(url.searchParams.get('limit') || 20))
    const list = (r?.result?.songs || []).map(s => ({
      id: s.id,
      name: s.name,
      artist: (s.artists || []).map(a => a.name).join(' / '),
      album: s.album?.name || '',
      duration: s.duration || 0,
      cover: s.album?.picUrl || '',
      fee: s.fee,
    }))
    return { songs: list }
  },

  'GET /api/song': async (req, url) => {
    const id = Number(url.searchParams.get('id'))
    if (!id) return { error: '缺少 id' }

    const [detail, sheetRes, lyricRes, audioRes] = await Promise.all([
      ncm.song.detail([id]).catch(() => null),
      ncm.song.sheets(id).catch(() => null),
      ncm.song.lyric(id).catch(() => null),
      ncm.song.audio([id]).catch(() => null),
    ])

    const s = detail?.songs?.[0]
    const info = {
      id,
      name: s?.name || '',
      artist: (s?.ar || s?.artists || []).map(a => a.name).join(' / '),
      album: s?.al?.name || s?.album?.name || '',
      duration: s?.duration || s?.dt || 0,
      cover: (s?.al?.picUrl || s?.album?.picUrl || ''),
    }

    const sheets = (sheetRes?.data?.musicSheetSimpleInfoVOS || []).map(x => ({
      id: x.id,
      name: x.name,
      pages: x.totalPageSize || 1,
      key: x.musicKey || '',
      bpm: x.bpm || 0,
      difficulty: x.difficulty || '',
      version: x.playVersion || '',
      instruments: (x.type || []).map(t => t.name).join('/'),
      cover: x.coverImageUrl || '',
    }))

    const lrc = lyricRes?.lrc?.lyric || ''
    audioRes?.data?.[0]

    return {
      info,
      sheets,
      instruments: sheetRes?.data?.sheetInstrumentTypeVOList?.map(i => i.name) || [],
      lrc,
      tlyric: lyricRes?.tlyric?.lyric || '',
      audio: audioInfo(audioRes?.data?.[0]),
    }
  },

  'GET /api/chart': async (req, url) => {
    const id = url.searchParams.get('id') || '3778678'
    const only = url.searchParams.get('sheets') === '1'
    const c = await ncm.chart(id)
    const sheeted = c.tracks.filter(t => t.sheetCount > 0)
    return {
      name: c.name,
      total: c.tracks.length,
      sheeted: sheeted.length,
      pages: sheeted.reduce((a, t) => a + t.sheetCount, 0),
      tracks: only ? sheeted : c.tracks,
    }
  },

  'GET /api/charts': async () => ({ charts: ncm.CHARTS }),

  'GET /api/img': async (req, url) => {
    const src = url.searchParams.get('u')
    if (!src || !/^https?:/.test(src)) return { error: 'bad url' }
    const { buf, type } = await ncm.proxyImage(src)
    return { raw: buf, type }
  },
}

function audioInfo(d) {
  if (!d) return { ok: false, reason: 'no-data' }
  if (!d.url) {
    const r = d.freeTrialPrivilege || {}
    const reason = !ncm.loggedIn()
      ? '未登录，音源不可用'
      : d.code === 403 ? '需要会员或版权方限制'
      : d.code === 404 ? '该版本无音源（可能是翻唱/下架）'
      : '拿不到地址'
    return { ok: false, code: d.code, reason, canTry: !!r.resConsumable, needLogin: !ncm.loggedIn() }
  }
  // 直链含临时 token，只在服务端留存，前端拿到的是本机短 id
  const key = ncm.uid()
  audioMap.set(key, { url: d.url, at: Date.now() })
  if (audioMap.size > 200) {
    for (const [k, v] of audioMap) { if (Date.now() - v.at > 30 * 60 * 1000) audioMap.delete(k) }
  }
  return { ok: true, key, ext: d.type || 'mp3', br: d.br, size: d.size, level: d.level }
}


function match(method, pathname) {
  return api[`${method} ${pathname}`] || null
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const handler = match(req.method, url.pathname)

  try {
    if (handler) {
      const out = await handler(req, url)
      if (out?.raw) {
        res.writeHead(200, { 'content-type': out.type, 'cache-control': 'public, max-age=3600' })
        return res.end(out.raw)
      }
      return json(res, 200, out)
    }

    // 音频流转发：支持 Range，让进度条可拖动
    if (url.pathname === '/api/audio') {
      const rec = audioMap.get(url.searchParams.get('k'))
      if (!rec) { res.writeHead(410); return res.end('stale audio key') }
      audioMap.set(rec.key || url.searchParams.get('k'), { ...rec, at: Date.now() })
      const target = rec.url
      process.utataneRange = req.headers.range || undefined
      const { upstream } = await ncm.proxyAudio(target)
      const buf = Buffer.from(await upstream.arrayBuffer())
      const headers = { 'cache-control': 'no-store', 'accept-ranges': 'bytes' }
      for (const k of ['content-type', 'content-length', 'content-range']) {
        const v = upstream.headers.get(k)
        if (v) headers[k] = v
      }
      headers['content-length'] = String(buf.length)
      const code = upstream.status === 206 ? 206 : 200
      res.writeHead(code, headers)
      return res.end(buf)
    }

    // 静态文件
    let file = url.pathname === '/' ? '/index.html' : url.pathname
    file = path.join(ROOT, path.normalize(file).replace(/^([/\\])+/, ''))
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end() }
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end('not found') }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' })
    return res.end(fs.readFileSync(file))
  } catch (e) {
    return json(res, 500, { error: String(e?.message || e) })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`utatane M0 → http://127.0.0.1:${PORT}  (登录态: ${ncm.loggedIn() ? '已有' : '未登录'})`)
})
