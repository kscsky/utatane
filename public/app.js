/* 歌種 utatane — M0
 * 图片谱无法逐音符高亮，所以这里做「时间锚点滚动」：
 * 谱按页分段，每段绑一个时间戳，播放时钟驱动分段插值。
 */

const $ = (s) => document.querySelector(s)
const $$ = (s) => [...document.querySelectorAll(s)]

const el = {
  q: $('#q'), results: $('#results'), resEmpty: $('#resEmpty'),
  chartPick: $('#chartPick'), onlySheet: $('#onlySheet'),
  sheets: $('#sheets'), sheetEmpty: $('#sheetEmpty'), sheetCount: $('#sheetCount'),
  strip: $('#strip'), ruler: $('#ruler'), frame: $('#frame'), overlay: $('#overlay'),
  pageInfo: $('#pageInfo'), anchorInfo: $('#anchorInfo'),
  nowLyric: $('#nowLyric'), nextLyric: $('#nextLyric'),
  audio: $('#audio'), art: $('#art'), pTitle: $('#pTitle'), pSub: $('#pSub'),
  btnPlay: $('#btnPlay'), seek: $('#seek'), tCur: $('#tCur'), tDur: $('#tDur'), vol: $('#vol'),
  mode: $('#mode'), lead: $('#lead'), leadV: $('#leadV'), dwell: $('#dwell'), dwellV: $('#dwellV'),
  easing: $('#easing'), fx: $('#fx'), fxV: $('#fxV'), pal: $('#pal'),
  anchorList: $('#anchorList'), btnStamp: $('#btnStamp'), btnReset: $('#btnReset'),
  btnLogin: $('#btnLogin'), who: $('#who'), btnDemo: $('#btnDemo'),
  loginModal: $('#loginModal'), qrImg: $('#qrImg'), qrState: $('#qrState'), btnQr: $('#btnQr'),
  bgCover: $('#bgCover'), bgCanvas: $('#bgCanvas'),
}

const S = {
  song: null, sheets: [], sheet: null, pages: [],
  lrc: [], dur: 0, anchors: [], stamps: [],
  mode: 'auto', lead: 0, dwell: 0.18, easing: 'smooth',
  t: 0, demo: false, clockOn: false, pulse: 0,
  pal: ['#ff6b9d', '#7c5cff', '#40e0d0'],
}
const LS = 'utatane.v1'

/* ---------- 工具 ---------- */
const mmss = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
const lerp = (a, b, t) => a + (b - a) * t
// 统一时长：接口值 > 末句歌词 + 尾奏 > 兜底
const durMs = () => S.dur || (S.lrc.length ? S.lrc[S.lrc.length - 1].ms + 15000 : 0) || 180000
const smoother = (t) => (t = clamp(t, 0, 1), t * t * t * (t * (t * 6 - 15) + 10))

function toast(msg, bad) {
  let n = $('.toast')
  if (!n) { n = document.createElement('div'); n.className = 'toast'; document.body.appendChild(n) }
  n.textContent = msg
  n.classList.toggle('bad', !!bad)
  n.classList.add('on')
  clearTimeout(n._t)
  n._t = setTimeout(() => n.classList.remove('on'), 2600)
}

async function api(path, opts) {
  const r = await fetch(path, opts)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}
const imgSrc = (u) => (u ? `/api/img?u=${encodeURIComponent(u)}` : '')
let rulerAt = -1e9 // 刻度 DOM 重建节流时戳

/* ---------- 歌词解析 ---------- */
// 制作信息行不是歌词
const SKIP = /^(?:\s*\[[^\]]*\]\s*)*(?:作词|作曲|编曲|制作人|制作|录音|混音|母带|和声|吉他|贝斯|钢琴|弦乐|鼓|谱|曲谱|乐谱|Lyrics?|Composer|Arranger|Producer|Mixed\s?by|Recorded)/i
function parseLrc(text) {
  const out = []
  const seen = new Set()
  for (const line of (text || '').split(/\r?\n/)) {
    const tags = [...line.matchAll(/\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)]
    if (!tags.length) continue
    const content = line.replace(/\[[^\]]*\]/g, '').trim()
    if (!content || SKIP.test(content)) continue
    for (const t of tags) {
      const ms = (Number(t[1]) * 60 + Number(t[2]) + Number((t[3] || '0').padEnd(3, '0')) / 1000) * 1000
      const key = `${ms}|${content}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ ms, text: content })
    }
  }
  return out.sort((a, b) => a.ms - b.ms)
}

/* ---------- 锚点：谱页 ↔ 时间 ---------- */
function bpmOf(sheet) {
  return sheet?.bpm && sheet.bpm >= 30 && sheet.bpm <= 240 ? sheet.bpm : 0
}

// 自动生成锚点：把每页起点均摊到时长上
function autoAnchors() {
  const n = S.pages.length || 1
  const dur = durMs()
  const intro = Math.min(6000, dur * 0.03)
  const outro = Math.min(8000, dur * 0.04)
  const span = dur - intro - outro
  // n 个页起点 + 1 个曲终点
  return Array.from({ length: n + 1 }, (_, i) => Math.round(intro + (span * i) / n))
}

// 节拍锚点：按 BPM 推算每页小节数
function bpmAnchors() {
  const bpm = bpmOf(S.sheet)
  if (!bpm) return null
  const n = S.pages.length || 1
  const barMs = (60000 / bpm) * 4
  const totalBars = Math.max(n, Math.round(durMs() / barMs))
  const barsPerPage = totalBars / n
  return Array.from({ length: n + 1 }, (_, i) => Math.round(i * barsPerPage * barMs))
}

/* 控制点模型：t[] 与 y[] 等长，表示“时刻 t 时读谱线对准谱带位置 y”。
 * 自动/节拍模式按页顶分布；手工模式把打点均布到整条谱带，
 * 因此单页长图（吉他谱常见形态）也能靠打点做到段内精确同步。 */
function controlPoints() {
  const n = S.pages.length
  if (!n) return { t: [], y: [] }
  const H = S.stripH || (S.pages[n - 1]?.top || 0) + 900

  if (S.mode === 'manual') {
    const st = S.stamps.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
    if (st.length >= 2) {
      const k = st.length
      return {
        // 打点如实对应时间：早于首个打点时谱面停在起点，不做“强制 0 点”假设
        t: st.map((v) => Math.round(v)),
        y: st.map((_, i) => Math.round((H * i) / (k - 1))),
      }
    }
  }
  const times = S.mode === 'bpm' ? (bpmAnchors() || autoAnchors()) : autoAnchors()
  const tops = S.pages.map((p) => p.top)
  tops.push(H)
  return { t: times, y: tops }
}

function at(t, cp) {
  const { t: a, y } = cp
  if (!a || a.length < 2) return y?.[0] || 0
  if (t <= a[0]) return y[0]
  if (t >= a[a.length - 1]) return y[y.length - 1]
  let i = 0
  for (let k = 0; k < a.length - 1; k++) if (t >= a[k] && t < a[k + 1]) { i = k; break }
  const seg = a[i + 1] - a[i]
  let f = seg > 0 ? (t - a[i]) / seg : 1
  const hold = clamp(S.dwell, 0, 0.9)
  if (S.easing === 'step') f = f < 1 ? 0 : 1
  else if (hold > 0) f = f < hold ? 0 : (f - hold) / (1 - hold)
  f = S.easing === 'linear' ? clamp(f, 0, 1) : smoother(f)
  return lerp(y[i], y[i + 1], f)
}

function pageAt(t, cp) {
  const a = cp.t
  for (let k = a.length - 2; k >= 0; k--) if (t >= a[k]) return Math.min(k, S.pages.length - 1)
  return 0
}

/* ---------- 时钟 ----------
 * S.t 是唯一的谱面时间线（ms）。真音频播放时由 audio 驱动，
 * 无音源时由本机演示时钟驱动；两者都支持拖动进度条。 */
const now = () => S.t
const isRunning = () => S.demo ? S.clockOn : !el.audio.paused
const audioLive = () => !S.demo && !!el.audio.src && !!el.audio.duration

/* ---------- 谱页 DOM ---------- */
function mountPages() {
  const strip = el.strip
  strip.innerHTML = ''
  const gap = 26
  let y = 0
  S.pages.forEach((p, i) => {
    const img = document.createElement('img')
    img.src = imgSrc(p.url)
    img.alt = `第 ${i + 1} 页`
    img.draggable = false
    img.decoding = 'async'
    img.onload = () => { p.h = img.naturalHeight * (frameW() / img.naturalWidth) || 600; layout() }
    strip.appendChild(img)
    p.el = img
  })
  layout()

  function layout() {
    let acc = 0
    S.pages.forEach((p, i) => {
      p.top = acc
      if (p.el) p.el.style.top = `${acc}px`
      acc += (p.h || 900)
      if (i < S.pages.length - 1) acc += gap
    })
    S.stripH = acc
    render()
  }
  layout()
}
const frameW = () => el.frame.clientWidth || 800

/* ---------- 渲染 ---------- */
function render() {
  renderSheet()
  renderClock()
}

// 谱面：只有挂了谱页才动
function renderSheet() {
  const t = now()
  if (!S.pages.length) { el.pageInfo.textContent = `无谱 · ${mmss(t)}`; return }
  const fh = el.frame.clientHeight || 400
  const readY = Math.round(fh * 0.34)
  const cp = controlPoints()
  const wy = at(t, cp)
  el.strip.style.transform = `translate3d(0, ${readY - wy}px, 0)`
  el.strip.dataset.t = String(Math.round(t))
  el.strip.dataset.wy = String(Math.round(wy))

  // 当前页
  const cur = pageAt(t, cp)
  el.pageInfo.textContent = `P${cur + 1}/${S.pages.length} · ${mmss(t)}`
  S.pages.forEach((p, i) => p.el?.classList.toggle('dim', i !== cur))

  // 左侧刻度：BPM 模式给小节号，手工模式给打点号，否则给页号
  // 刻度 DOM 重建比 transform 贵，节流到 ~9fps；位置本身仍按帧连续
  const bpm = bpmOf(S.sheet)
  const tk = performance.now()
  if (tk - rulerAt > 110) {
    rulerAt = tk
    let html = ''
    if (S.mode === 'bpm' && bpm) {
      const barMs = (60000 / bpm) * 4
      const total = Math.ceil(durMs() / barMs)
      for (let b = 0; b <= total; b++) {
        const sy = Math.round(readY + (at(b * barMs, cp) - wy))
        if (sy < -14 || sy > fh + 14) continue
        html += `<i style="top:${sy}px">${b + 1}</i>`
      }
    } else {
      cp.t.forEach((ms, i) => {
        const sy = Math.round(readY + (cp.y[i] - wy))
        if (sy < -14 || sy > fh + 14) return
        html += `<i style="top:${sy}px">${S.mode === 'manual' ? mmss(ms) : `P${Math.min(i + 1, S.pages.length)}`}</i>`
      })
    }
    el.ruler.innerHTML = html
  }
}

// 时钟与歌词：无谱时也必须更新，否则界面看起来像坏了
function renderClock() {
  const t = now()
  const bpm = bpmOf(S.sheet)

  // 歌词
  if (S.lrc.length) {
    let i = -1
    for (let k = 0; k < S.lrc.length; k++) if (t >= S.lrc[k].ms) i = k
    el.nowLyric.textContent = i >= 0 ? S.lrc[i].text : ''
    el.nextLyric.textContent = i + 1 < S.lrc.length ? S.lrc[i + 1].text : ''
    S.pulse = Math.max(S.pulse, i !== S._li ? 1 : 0)
    S._li = i
  }

  const st = S.mode === 'manual' ? '手工锚点' : S.mode === 'bpm' ? (bpm ? `BPM ${bpm} 推算` : 'BPM 缺失，退回匀速') : '时长均摊'
  el.anchorInfo.textContent = `${st} · 提前量 ${S.lead}ms`

  const total = durMs()
  el.seek.max = String(Math.round(total))
  el.seek.value = Math.round(clamp(t, 0, total))
  el.tCur.textContent = mmss(t)
  el.tDur.textContent = mmss(total)
}

/* ---------- 背景视觉 ---------- */
const cv = el.bgCanvas
const ctx = cv.getContext('2d')
let parts = []
let analyser = null, freq = null, actx = null
const VIZ = { w: 1, h: 1 } // canvas 显示尺寸，随 resize() 更新

function seedParts() {
  const n = 90 + Math.round((Number(el.fx.value) / 100) * 140)
  parts = Array.from({ length: n }, () => ({
    x: Math.random(), y: Math.random(), r: 0.6 + Math.random() * 2.4,
    v: 0.02 + Math.random() * 0.12, a: Math.random() * Math.PI * 2,
    k: Math.random() < 0.34 ? 1 : Math.random() < 0.7 ? 2 : 0,
  }))
}

function resize() {
  const dpr = Math.min(2, devicePixelRatio || 1)
  // 以元素实际显示尺寸为准，避免粒子纵向拉伸
  const r = cv.getBoundingClientRect()
  const w = Math.max(1, Math.round(r.width || innerWidth))
  const h = Math.max(1, Math.round(r.height || innerHeight))
  cv.width = Math.floor(w * dpr)
  cv.height = Math.floor(h * dpr)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  VIZ.w = w
  VIZ.h = h
}
addEventListener('resize', () => { resize(); seedParts(); render() })

function paint(dt) {
  const w = VIZ.w, h = VIZ.h
  ctx.clearRect(0, 0, w, h)
  const amt = Number(el.fx.value) / 100
  if (amt <= 0.01) return

  let energy = 0
  if (analyser) {
    analyser.getByteFrequencyData(freq)
    let lo = 0
    for (let i = 0; i < 24; i++) lo += freq[i]
    energy = (lo / 24 / 255) * 1.4
  }
  const beat = Math.max(energy, S.pulse)
  S.pulse = Math.max(0, S.pulse - dt * 2.2)

  for (const p of parts) {
    p.y -= (p.v * dt) / 60
    if (p.y < -0.05) { p.y = 1.05; p.x = Math.random() }
    p.a += dt * 0.7
    const boost = 1 + beat * 2.6
    const x = (p.x + Math.sin(p.a) * 0.02) * w
    const y = p.y * h
    const r = p.r * boost * (0.5 + amt)
    ctx.beginPath()
    ctx.arc(x, y, r, 0, 6.2832)
    ctx.fillStyle = S.pal[p.k]
    ctx.globalAlpha = (0.1 + amt * 0.3) * (0.35 + beat * 0.8)
    ctx.fill()
    if (beat > 0.32 && p.k === 1) {
      ctx.globalAlpha = 0.06 * amt * beat
      ctx.beginPath(); ctx.arc(x, y, r * 6, 0, 6.2832); ctx.fill()
    }
  }
  ctx.globalAlpha = 1
}

function hookAudio() {
  if (actx || !el.audio.src) return
  try {
    actx = new AudioContext()
    const src = actx.createMediaElementSource(el.audio)
    analyser = actx.createAnalyser()
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.72
    freq = new Uint8Array(analyser.frequencyBinCount)
    src.connect(analyser)
    analyser.connect(actx.destination)
  } catch { /* 跨域或已连接：视觉退回歌词脉冲 */ }
}

/* ---------- 封面取色 ---------- */
const FIXED = { sakura: ['#ff9ec7', '#b17cff', '#ffd6e8'], ocean: ['#4fd8e8', '#4a7cff', '#a9f4ff'], night: ['#8f7bff', '#5b3fd6', '#c8b6ff'] }
async function pickPalette(url) {
  if (el.pal.value !== 'auto') { S.pal = FIXED[el.pal.value]; return }
  try {
    const im = new Image()
    im.src = imgSrc(url)
    await im.decode()
    const c = document.createElement('canvas')
    c.width = 28; c.height = 28
    const x = c.getContext('2d')
    x.drawImage(im, 0, 0, 28, 28)
    const d = x.getImageData(0, 0, 28, 28).data
    const bins = new Map()
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 200) continue
      const k = [d[i] >> 5, d[i + 1] >> 5, d[i + 2] >> 5].join(',')
      bins.set(k, (bins.get(k) || 0) + 1)
    }
    const top = [...bins].sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([k]) => k.split(',').map(v => Math.min(255, Number(v) * 32 + 90)))
    while (top.length < 3) top.push([124, 92, 255])
    S.pal = top.map(c => `rgb(${c.join(',')})`)
  } catch {
    S.pal = FIXED.night
  }
}

/* ---------- 载入 ---------- */
// 榜单要逐首查谱（数秒），搜索几十毫秒；慢响应不许覆盖新列表
let listSeq = 0

function loadList(row, fetchRows) {
  const seq = ++listSeq
  el.resEmpty.textContent = row.loading
  el.resEmpty.hidden = false
  return fetchRows().then(rows => {
    if (seq !== listSeq) return
    el.results.innerHTML = ''
    el.results.dataset.src = row.src
    if (!rows.length) { el.resEmpty.textContent = row.none; el.resEmpty.hidden = false; return }
    el.resEmpty.hidden = true
    rows.forEach(s => {
      const li = document.createElement('li')
      li.innerHTML = row.cell(s)
      li.onclick = () => pick(li, s)
      el.results.appendChild(li)
    })
  }).catch(e => {
    if (seq !== listSeq) return
    el.resEmpty.textContent = row.fail + e.message
  })
}

const SEARCH_ROW = {
  src: 'search',
  loading: '搜索中…',
  none: '没搜到。',
  fail: '搜索失败：',
  cell: (s) => `<div class="t">${esc(s.name)}</div><div class="s">${esc(s.artist)} · ${mmss(s.duration)}</div>`,
}
// 官方榜单：搜索结果里翻唱/翻弹占比高，榜单是更可靠的入口
const CHART_ROW = {
  src: 'chart',
  loading: '榜单载入中（要逐首查谱，约几秒）…',
  none: '这个榜单没有可显示的歌。',
  fail: '榜单载入失败：',
  cell: (s) => {
    const badge = s.sheetCount ? `<b>谱${s.sheetCount}份</b>` : '无谱'
    const bpm = s.bpm ? ` · ${s.bpm}BPM` : ''
    return `<div class="t">${esc(s.name)}</div><div class="s">${esc(s.artist)} · ${mmss(s.duration)} · ${badge}${bpm}</div>`
  },
}

let chartId = '3778678'

// 搜索总是切到搜索视图：从榜单里搜不会两边打架
function doSearch(kw = el.q.value.trim()) {
  if (!kw) return
  showTab('search')
  return loadList(SEARCH_ROW, () => api(`/api/search?q=${encodeURIComponent(kw)}`).then(r => r.songs || []))
}

const loadChart = () =>
  loadList(CHART_ROW, () =>
    api(`/api/chart?id=${chartId}&sheets=${el.onlySheet.checked ? 1 : 0}`).then(r => r.tracks || []))

async function loadCharts() {
  try {
    const r = await api('/api/charts')
    el.chartPick.innerHTML = ''
    r.charts.forEach(c => {
      const b = document.createElement('button')
      b.textContent = c.name
      b.classList.toggle('on', c.id === chartId)
      b.onclick = () => {
        chartId = c.id
        $$('#chartPick button').forEach(n => n.classList.remove('on'))
        b.classList.add('on')
        loadChart()
      }
      el.chartPick.appendChild(b)
    })
  } catch { el.chartPick.hidden = true }
}

let tab = 'chart'

function showTab(mode) {
  tab = mode
  $$('.tab').forEach(b => b.classList.toggle('on', b.dataset.tab === mode))
  el.chartPick.hidden = mode !== 'chart'
  el.onlySheet.closest('label').hidden = mode !== 'chart'
}

function setTab(mode) {
  showTab(mode)
  if (mode === 'chart') return loadChart()
  if (el.q.value.trim()) return doSearch()
  ++listSeq // 作废在途的榜单请求，别让它回填到搜索视图
  el.results.innerHTML = ''
  el.resEmpty.hidden = false
  el.resEmpty.textContent = '输入关键词后回车。搜到的歌若有官方谱，选中即可走带。'
}

// 深链：/ ?song=<网易云歌曲 id> 直接载入，绕过搜索只有翻唱的局限
async function loadById(id) {
  const d = await api(`/api/song?id=${id}`)
  const s = {
    id: Number(id),
    name: d.info?.name || `歌曲 ${id}`,
    artist: d.info?.artist || '',
    album: d.info?.album || '',
    duration: d.info?.duration || 0,
    cover: d.info?.cover || '',
  }
  await pick(null, s, d)
  return d
}

async function pick(li, s, preset) {
  $$('#results li').forEach(n => n.classList.remove('on'))
  li?.classList.add('on')
  el.overlay.classList.remove('off')
  $('#ovInner .ov-sub').innerHTML = '载入中…'
  S.song = s
  S.dur = s.duration
  S.sheet = null
  S.pages = []
  S.stamps = []
  S.lrc = []
  el.strip.innerHTML = ''
  try {
    const d = preset || await api(`/api/song?id=${s.id}`)
    S.dur = d.info?.duration || s.duration
    S.lrc = parseLrc(d.lrc)
    el.sheets.innerHTML = ''
    S.sheets = d.sheets || []
    el.sheetCount.textContent = S.sheets.length ? `${S.sheets.length} 份` : ''
    if (!S.sheets.length) {
      el.sheetEmpty.hidden = false
      el.sheetEmpty.innerHTML = `<b>官方曲谱库没有这首歌</b>（实测热歌榜约 28% 无谱，冷门歌更高）。<br>
        可换一首，或把谱页图片拖到谱面上自己标注。`
      $('#ovInner .ov-sub').innerHTML = '这首歌没有官方谱。<br>把谱页图片拖到这里，可自建谱面并打点。'
    } else {
      el.sheetEmpty.hidden = true
      S.sheets.forEach((sh, i) => {
        const li = document.createElement('li')
        li.innerHTML = `<div class="t">${esc(sh.name)}</div>
          <div class="s">${sh.pages} 页 · ${esc(sh.key || '?')} · ${sh.instruments || '—'}${sh.bpm ? ` · <b>${sh.bpm} BPM</b>` : ''}</div>`
        li.onclick = () => { $$('#sheets li').forEach(n => n.classList.remove('on')); li.classList.add('on'); useSheet(sh) }
        el.sheets.appendChild(li)
        if (i === 0) setTimeout(() => li.click(), 30)
      })
    }
    await setupAudio(d)
  } catch (e) { toast('载入失败：' + e.message, 1) }
}

async function setupAudio(d) {
  el.pTitle.textContent = d.info?.name || S.song?.name || ''
  el.pSub.textContent = `${d.info?.artist || S.song?.artist || ''} · ${d.info?.album || ''}`
  const cover = d.info?.cover || S.song?.cover
  if (cover) {
    el.art.style.backgroundImage = `url('${imgSrc(cover)}')`
    el.bgCover.style.backgroundImage = `url('${imgSrc(cover)}')`
    el.bgCover.classList.add('on')
    await pickPalette(cover)
  }
  const a = d.audio
  el.btnPlay.disabled = true
  if (!a?.ok) {
    // 没音源不代表看不到效果：切到本机时钟驱动，谱面照常滚动
    S.demo = true
    el.btnDemo.classList.add('accent')
    el.btnPlay.disabled = false
    toast(a?.needLogin
      ? '未登录 · 谱图可用，已切到演示时钟，按空格即可看滚动'
      : `音源不可用：${a?.reason || '未知'} · 已切到演示时钟`)
    return
  }
  S.demo = false
  el.btnDemo.classList.remove('accent')
  el.btnPlay.disabled = false
  el.audio.src = `/api/audio?k=${encodeURIComponent(a.key)}`
  el.audio.load()
}

function useSheet(sh) {
  S.sheet = sh
  S.stamps = loadStamps(sh.id) || []
  // 官方 list 接口只给首页图，且未公开分页规律；其余页由本地补图
  S.pages = [{ url: sh.cover }]
  el.overlay.classList.add('off')
  mountPages()
  renderAnchors()
  render()
  loadLocalPages(sh.id).then((extra) => {
    if (S.sheet !== sh) return
    if (!extra.length) {
      if (sh.pages > 1) toast(`第 1/${sh.pages} 页已载入 · 把其余谱页图片拖到谱面上可补全`)
      return
    }
    extra.forEach(u => S.pages.push({ url: u, local: true }))
    mountPages()
    renderAnchors()
    render()
    toast(`已恢复本机标注的 ${extra.length} 页补充谱面`)
  })
}

function renderAnchors() {
  el.anchorList.innerHTML = ''
  if (!S.stamps.length) {
    const li = document.createElement('li')
    li.innerHTML = '<i>尚无打点</i><span style="color:var(--faint)">自动均摊</span>'
    el.anchorList.appendChild(li)
    return
  }
  const last = S.stamps.length - 1
  S.stamps.forEach((ms, i) => {
    const li = document.createElement('li')
    const pos = last > 0 ? Math.round((i / last) * 100) : 0
    li.innerHTML = `<i>#${i + 1} · ${mmss(ms)}</i><span style="color:var(--c3)">${pos}% 谱位</span>`
    el.anchorList.appendChild(li)
  })
}

/* ---------- 打点持久化 ---------- */
function keyFor(id) { return `${LS}.stamp.${id}` }
function loadStamps(id) {
  try {
    const raw = JSON.parse(localStorage.getItem(keyFor(id)))
    if (!Array.isArray(raw)) return null
    // 单调递增 + 去重：乱序锚点会让谱面回跳
    const a = raw.filter(v => Number.isFinite(v) && v >= 0).sort((x, y) => x - y)
    return a.filter((v, i) => i === 0 || v > a[i - 1])
  } catch { return null }
}
function saveStamps() {
  if (!S.sheet) return
  localStorage.setItem(keyFor(S.sheet.id), JSON.stringify(S.stamps))
  localStorage.setItem(`${LS}.cfg`, JSON.stringify({ mode: S.mode, lead: S.lead, dwell: S.dwell, easing: S.easing, fx: el.fx.value, pal: el.pal.value }))
}

/* 本地补图：dataURL 存 IndexedDB，标注一次永久复用 */
let dbp = null
function db() {
  if (dbp) return dbp
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open('utatane', 1)
    r.onupgradeneeded = () => r.result.createObjectStore('pages', { keyPath: 'id' })
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
  return dbp
}
async function loadLocalPages(sheetId) {
  try {
    const d = await db()
    const rec = await new Promise((res) => {
      const q = d.transaction('pages').objectStore('pages').get(sheetId)
      q.onsuccess = () => res(q.result)
      q.onerror = () => res(null)
    })
    return rec?.urls || []
  } catch { return [] }
}
async function saveLocalPages(sheetId, urls) {
  try {
    const d = await db()
    const tx = d.transaction('pages', 'readwrite')
    tx.objectStore('pages').put({ id: sheetId, urls })
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
  } catch { /* 隐私模式等：不影响本次使用 */ }
}
const toDataURL = (file) => new Promise((res, rej) => {
  const fr = new FileReader()
  fr.onload = () => res(fr.result)
  fr.onerror = () => rej(fr.error)
  fr.readAsDataURL(file)
})

function stamp() {
  if (!S.pages.length) { toast('先选一首歌和一份谱', 1); return }
  const t = Math.round(now())
  if (S.stamps.length && t <= S.stamps[S.stamps.length - 1]) { toast('该点不晚于上一个打点，已忽略（请先往后走带）', 1); return }
  S.stamps.push(t)
  S.mode = 'manual'; el.mode.value = 'manual'
  saveStamps(); renderAnchors(); render()
  toast(`第 ${S.stamps.length} 点 → ${mmss(S.stamps.at(-1))}`)
}

/* ---------- 登录 ---------- */
let unikey = null, poll = null
async function openLogin() {
  el.loginModal.hidden = false
  await newQr()
}
async function newQr() {
  el.qrState.textContent = '生成中…'
  el.qrImg.style.opacity = .3
  try {
    const r = await api('/api/qr/create')
    if (r.error) { el.qrState.textContent = r.error; return }
    unikey = r.unikey
    el.qrImg.src = r.image
    el.qrImg.style.opacity = 1
    el.qrState.textContent = '用网易云 App 扫码'
    clearInterval(poll)
    poll = setInterval(async () => {
      const c = await api('/api/qr/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ unikey }) })
      if (c.code === 803) {
        clearInterval(poll)
        el.qrState.textContent = '登录成功'
        el.loginModal.hidden = true
        el.btnLogin.textContent = '已登录'
        await refreshSession(true)
        if (S.song) { const d = await api(`/api/song?id=${S.song.id}`); await setupAudio(d) }
      } else if (c.code === 800) { el.qrState.textContent = '二维码过期，点下方重新生成' }
      else if (c.code === 802) el.qrState.textContent = '等待扫码…'
      else if (c.code === 801) el.qrState.textContent = '已扫码，请在手机上确认'
    }, 2000)
  } catch (e) { el.qrState.textContent = '失败：' + e.message }
}

async function refreshSession(reload) {
  const s = await api('/api/session')
  el.btnLogin.textContent = s.logged ? '退出' : '扫码登录'
  el.who.textContent = s.logged ? '● 会话有效' : '○ 未登录（谱图可看，音源需登录）'
  return s.logged
}

const esc = (t) => String(t || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

/* ---------- 事件 ---------- */
$('#btnSearch').onclick = () => doSearch()
el.q.onkeydown = (e) => { if (e.key === 'Enter') doSearch() }
$$('.tab').forEach(b => { b.onclick = () => setTab(b.dataset.tab) })
el.onlySheet.onchange = () => { if (tab === 'chart') loadChart() }
el.btnLogin.onclick = async () => {
  const s = await api('/api/session')
  if (s.logged) { await api('/api/logout', { method: 'POST' }); await refreshSession(); return }
  openLogin()
}
$('#loginClose').onclick = () => { clearInterval(poll); el.loginModal.hidden = true }
el.btnQr.onclick = newQr

function setPlaying(on) {
  if (audioLive()) {
    if (on) { hookAudio(); actx?.resume?.(); el.audio.play().catch(() => startLocal('音源播放失败')) }
    else el.audio.pause()
  } else {
    if (on) startLocal()
    else S.clockOn = false
  }
  el.btnPlay.textContent = isRunning() ? '❚❚' : '▶'
}
el.btnPlay.onclick = () => setPlaying(!isRunning())
el.audio.onplaying = () => { el.btnPlay.textContent = '❚❚' }
el.audio.onpause = () => { el.btnPlay.textContent = '▶' }
el.audio.onended = () => { el.btnPlay.textContent = '▶' }
el.btnDemo.onclick = () => {
  S.demo = !S.demo
  el.btnDemo.classList.toggle('accent', S.demo)
  if (S.demo) { el.audio.pause(); startLocal(); toast('本机时钟已接管，按空格走带') }
  else { S.clockOn = false; el.btnPlay.textContent = '▶'; render() }
  render()
}

el.seek.oninput = () => {
  const v = Number(el.seek.value)
  S.t = v
  if (audioLive()) el.audio.currentTime = v / 1000
  render()
}
el.vol.oninput = () => { el.audio.volume = el.vol.value / 100 }

el.mode.onchange = () => { S.mode = el.mode.value; saveStamps(); render() }
el.lead.oninput = () => { S.lead = Number(el.lead.value); el.leadV.textContent = S.lead + 'ms'; render() }
el.dwell.oninput = () => { S.dwell = Number(el.dwell.value) / 100; el.dwellV.textContent = el.dwell.value + '%'; render() }
el.easing.onchange = () => { S.easing = el.easing.value; saveStamps(); render() }
el.fx.oninput = () => { el.fxV.textContent = el.fx.value; seedParts() }
el.pal.onchange = async () => {
  saveStamps()
  if (el.pal.value === 'auto') await pickPalette(S.sheet?.cover || S.song?.cover)
  else S.pal = FIXED[el.pal.value]
}
el.btnStamp.onclick = stamp
el.btnReset.onclick = () => {
  S.stamps = []
  if (S.sheet) localStorage.removeItem(keyFor(S.sheet.id))
  S.mode = 'auto'; el.mode.value = 'auto'
  renderAnchors(); render(); toast('锚点已清空，回到自动均摊')
}

addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return
  if (e.code === 'Space') { e.preventDefault(); if (!isRunning()) el.btnPlay.click(); else stamp() }
  if (e.key === 'ArrowLeft') { seekTo(S.t - 3000); render() }
  if (e.key === 'ArrowRight') { seekTo(S.t + 3000); render() }
})

// 拖入本地谱页图片，补全多页（存 IndexedDB，下次自动载入）
el.frame.addEventListener('dragover', (e) => { e.preventDefault(); el.frame.style.outline = '2px dashed rgba(124,92,255,.6)' })
el.frame.addEventListener('dragleave', () => { el.frame.style.outline = '' })
el.frame.addEventListener('drop', async (e) => {
  e.preventDefault()
  el.frame.style.outline = ''
  const files = [...e.dataTransfer.files].filter(f => /^image\//.test(f.type))
  if (!files.length || !S.sheet) { if (!S.sheet) toast('先选一首歌和一份谱', 1); return }
  for (const f of files) {
    try { S.pages.push({ url: await toDataURL(f), local: true }) } catch { /* 跳过坏文件 */ }
  }
  await saveLocalPages(S.sheet.id, S.pages.filter(p => p.local).map(p => p.url))
  mountPages()
  renderAnchors()
  render()
  toast(`已加入 ${files.length} 页，永久保存在本机`)
})

/* ---------- 走带控制 ---------- */
// 本机时钟接管：无音源或演示模式时用它，保证谱面在任何情况下都能动
function startLocal() {
  S.demo = true
  S.clockOn = true
  el.btnDemo.classList.add('accent')
  el.btnPlay.textContent = '❚❚'
}
function seekTo(ms) {
  S.t = clamp(Math.round(ms), 0, durMs())
  if (audioLive()) {
    try { el.audio.currentTime = S.t / 1000 } catch { /* seek 超界 */ }
  }
}

let last = performance.now()
function frame(nowMs) {
  const dt = Math.min(0.05, (nowMs - last) / 1000)
  last = nowMs
  if (audioLive() && !el.audio.paused) S.t = el.audio.currentTime * 1000 + S.lead
  else if (S.clockOn) {
    S.t += dt * 1000
    if (S.t > durMs()) S.t = 0
  }
  paint(dt)
  render()
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)

/* ---------- 启动 ---------- */
;(async () => {
  try {
    const m = JSON.parse(localStorage.getItem(`${LS}.cfg`) || '{}')
    if (m.mode) { S.mode = m.mode; el.mode.value = m.mode }
    if (m.lead != null) { S.lead = m.lead; el.lead.value = m.lead; el.leadV.textContent = m.lead + 'ms' }
    if (m.dwell != null) { S.dwell = m.dwell; el.dwell.value = Math.round(m.dwell * 100); el.dwellV.textContent = el.dwell.value + '%' }
    if (m.easing) { S.easing = m.easing; el.easing.value = m.easing }
    if (m.fx != null) { el.fx.value = m.fx; el.fxV.textContent = m.fx }
    if (m.pal) el.pal.value = m.pal
  } catch { /* 首次无配置 */ }
  el.audio.volume = el.vol.value / 100
  resize(); seedParts()
  await refreshSession()
  loadCharts()
  const deep = new URLSearchParams(location.search).get('song')
  if (deep) { el.q.value = ''; await loadById(deep) }
  setTab('chart')
})()
