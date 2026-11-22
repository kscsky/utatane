// 滚动数学校核：把 app.js 里的纯函数取出来单测
// 覆盖 控制点构造 / 插值 / 页判定 / LRC 解析
import fs from 'node:fs'

const src = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')

function grab(from, to) {
  const a = src.indexOf(from)
  const b = to ? src.indexOf(to) : src.length
  if (a < 0) throw new Error('找不到片段: ' + from)
  return src.slice(a, b < 0 ? src.length : b)
}

// 取 app.js 里从工具函数到「时钟」结束的全部纯逻辑，注入可变 S 后求值
const bundle = `
${grab('const mmss =', '/* ---------- 谱页 DOM ---------- */')}
return { controlPoints, at, pageAt, parseLrc, autoAnchors, bpmAnchors, bpmOf, durMs, clamp, smoother, mmss }
`

let S
const make = (state) => {
  S = state
  const f = new Function('getState', `
    const S = getState()
    ${bundle}
  `)
  return f(() => S)
}

const base = {
  pages: [], stamps: [], mode: 'auto', easing: 'smooth', dwell: 0.18,
  dur: 0, lrc: [], stripH: 0, sheet: null,
}

let fails = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`)
  if (!cond) fails++
}

/* ---------- 1. LRC ---------- */
{
  const m = make({ ...base })
  const r = m.parseLrc('[00:00.00] 作词 : 郑智化\n[00:27.54]第一句\n[01:55.10][00:45.12]复用句\n和声编写 : 某人\n[00:01.5]第三句')
  ok('LRC 过滤制作信息', !r.some(x => /作词|和声/.test(x.text)), JSON.stringify(r.map(x => x.text)))
  ok('LRC 双时间戳展开', r.filter(x => x.text === '复用句').length === 2)
  ok('LRC 毫秒精度', r.find(x => x.text === '第一句')?.ms === 27540)
  ok('LRC 单位数毫秒补齐 [00:01.5]', r.find(x => x.text === '第三句')?.ms === 1500)
  ok('LRC 按时间升序', r.every((x, i, a) => !i || x.ms >= a[i - 1].ms))
}

/* ---------- 2. 空/单页健壮性 ---------- */
{
  const m = make({ ...base, dur: 269000 })
  ok('零页 → 控制点为空', JSON.stringify(m.controlPoints()) === '{"t":[],"y":[]}')
  ok('零页 → at() 不 NaN', m.at(5000, { t: [], y: [] }) === 0)
  ok('零页 → at() 空 cp 不 NaN', Number.isFinite(m.at(5000, m.controlPoints())))
}

/* ---------- 3. 单页谱必须真的滚动 ---------- */
{
  const m = make({ ...base, dur: 269000, pages: [{ top: 0, h: 1371 }], stripH: 1371 })
  const cp = m.controlPoints()
  ok('单页 → 2 个控制点', cp.t.length === 2 && cp.y.length === 2, `t=${cp.t} y=${cp.y}`)
  const ys = [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1].map(p => m.at(cp.t[0] + (cp.t[1] - cp.t[0]) * p, cp))
  ok('单页纵向扫过全程', ys[0] === 0 && ys.at(-1) === 1371, `y=${ys.map(v => Math.round(v))}`)
  ok('单页位移单调不减', ys.every((v, i, a) => !i || v >= a[i - 1]))
  ok('单页中段确实离开原位', ys[3] > 100 && ys[3] < 1300, `中点=${Math.round(ys[3])}`)
}

/* ---------- 4. 多页匀速 ---------- */
{
  const pages = [0, 1371, 2742, 4113].map(top => ({ top, h: 1371 }))
  const m = make({ ...base, dur: 240000, pages, stripH: 5484 })
  const cp = m.controlPoints()
  ok('4 页 → 5 控制点', cp.t.length === 5 && cp.y.length === 5, `t=${cp.t}`)
  ok('页顶对齐', JSON.stringify(cp.y) === JSON.stringify([0, 1371, 2742, 4113, 5484]), `y=${cp.y}`)
  ok('首点 > 0（有前奏）', cp.t[0] > 0, `intro=${cp.t[0]}`)
  ok('末点 < 时长（有尾奏）', cp.t.at(-1) < 240000, `end=${cp.t.at(-1)}`)
  ok('时间轴单调', cp.t.every((v, i, a) => !i || v > a[i - 1]))
  let prev = -1, mono = true
  for (let t = 0; t <= 240000; t += 1000) {
    const y = m.at(t, cp)
    if (y < prev - 0.001) mono = false
    prev = y
  }
  ok('全程单调不减（无回跳）', mono)
  ok('页判定在末点前不越界', m.pageAt(cp.t.at(-1) - 1, cp) === 3)
  ok('页判定夹紧在末页', m.pageAt(9e9, cp) === 3)
}

/* ---------- 5. BPM 模式 ---------- */
{
  const pages = [{ top: 0, h: 1371 }, { top: 1371, h: 1371 }]
  const m = make({ ...base, dur: 240000, pages, stripH: 2742, mode: 'bpm', sheet: { bpm: 60 } })
  ok('BPM 60 有效', m.bpmOf({ bpm: 60 }) === 60)
  ok('BPM 0 视为缺失', m.bpmOf({ bpm: 0 }) === 0)
  ok('BPM 越界视为缺失', m.bpmOf({ bpm: 9 }) === 0 && m.bpmOf({ bpm: 999 }) === 0)
  const cp = m.controlPoints()
  ok('BPM 模式首点为 0', cp.t[0] === 0, `t=${cp.t}`)
  // 60bpm 4/4 → 每小节 4000ms；240s = 60 小节，2 页 → 每页 30 小节 = 120000ms
  ok('BPM 每页跨度正确', cp.t[1] === 120000, `t=${cp.t}`)
}

/* ---------- 6. 手工打点 ---------- */
{
  const pages = [{ top: 0, h: 1371 }]
  const m = make({ ...base, dur: 240000, pages, stripH: 1371, mode: 'manual', stamps: [0, 60000, 150000] })
  const cp = m.controlPoints()
  ok('3 打点 → 3 控制点', cp.t.length === 3 && cp.y.length === 3, JSON.stringify(cp))
  ok('打点均布谱带', JSON.stringify(cp.y) === JSON.stringify([0, 686, 1371]), `y=${cp.y}`)
  ok('打点如实保留（不强制首点为 0）', cp.t[0] === 0 && cp.t[1] === 60000 && cp.t[2] === 150000, `t=${cp.t}`)
  ok('首个打点之前谱面停在起点', m.at(-1000, cp) === 0 && m.at(0, cp) === 0)
  ok('最后一个打点之后停在末尾', m.at(240000, cp) === 1371)
  ok('单页靠打点也能扫完全程', m.at(150000, cp) === 1371)
  const mf = make({ ...base, dur: 240000, pages, stripH: 1371, mode: 'manual', stamps: [30000, 90000, 150000] })
  const cpf = mf.controlPoints()
  ok('前奏期(首个打点前)不滚动', mf.at(10000, cpf) === 0)
  ok('打点后按段推进', mf.at(90000, cpf) === 686, `${mf.at(90000, cpf)}`)
  const m2 = make({ ...base, dur: 240000, pages, stripH: 1371, mode: 'manual', stamps: [12000] })
  ok('打点不足 2 个 → 回退自动', m2.controlPoints().t.length === 2 && m2.controlPoints().t[0] > 0)
  const m3 = make({ ...base, dur: 240000, pages, stripH: 1371, mode: 'manual', stamps: [null, 5000, NaN] })
  ok('脏打点被过滤', m3.controlPoints().t.length === 2, JSON.stringify(m3.controlPoints()))
}

/* ---------- 7. 手感曲线 ---------- */
{
  const pages = [{ top: 0, h: 1000 }, { top: 1000, h: 1000 }]
  const mk = (easing, dwell) => make({ ...base, dur: 100000, pages, stripH: 2000, easing, dwell })
  const lin = mk('linear', 0), smo = mk('smooth', 0), stp = mk('step', 0), hol = mk('smooth', 0.5)
  const cpL = lin.controlPoints()
  ok('线性中点 = 50%', Math.abs(lin.at((cpL.t[0] + cpL.t[1]) / 2, cpL) - 500) < 20, `${lin.at((cpL.t[0] + cpL.t[1]) / 2, cpL)}`)
  ok('缓入缓出中点 ≈ 50% 但斜率更缓', Math.abs(smo.at((smo.controlPoints().t[0] + smo.controlPoints().t[1]) / 2, smo.controlPoints()) - 500) < 60)
  const cpS = stp.controlPoints()
  ok('逐小节跳：段内不动', stp.at(cpS.t[0] + (cpS.t[1] - cpS.t[0]) * 0.9, cpS) === 0)
  const cpH = hol.controlPoints()
  ok('驻留期内不动', hol.at(cpH.t[0] + (cpH.t[1] - cpH.t[0]) * 0.2, cpH) === 0)
  ok('驻留结束后继续走', hol.at(cpH.t[0] + (cpH.t[1] - cpH.t[0]) * 0.9, cpH) > 400)
}

/* ---------- 8. 时长回退 ---------- */
{
  const m = make({ ...base, dur: 0, lrc: [{ ms: 1000, text: 'a' }, { ms: 200000, text: 'b' }] })
  ok('无时长 → 末句+尾奏', m.durMs() === 215000, `${m.durMs()}`)
  const m2 = make({ ...base, dur: 0, lrc: [] })
  ok('无时长无歌词 → 兜底 180s', m2.durMs() === 180000)
  const m3 = make({ ...base, dur: 269000, lrc: [{ ms: 1, text: 'x' }] })
  ok('有时长优先用时长', m3.durMs() === 269000)
}

console.log(fails ? `\n❌ ${fails} 项未通过` : '\n全部通过')
process.exit(fails ? 1 : 0)
