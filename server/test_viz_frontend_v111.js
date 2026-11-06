// ㉖v111 目视化 · 前端真实函数沙箱验证（跑 console.html 真代码，构造六类天气断言分类映射）
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const h = fs.readFileSync(path.join(__dirname, 'public', 'console.html'), 'utf8');
const db = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'db.json'), 'utf8'));
let fail = 0, total = 0;
function T(n, a, b) { total++; const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) { fail++; console.log('FAIL ' + n + '\n  实际=' + JSON.stringify(a) + '\n  期望=' + JSON.stringify(b)); } else console.log('PASS ' + n); }

const lineOf = (prefix) => { const m = h.split(String.fromCharCode(10)).find((l) => l.trim().startsWith(prefix)); if (!m) throw new Error('未找到: ' + prefix); return m; };
const s0 = h.indexOf('function ctWeatherHtml(){'); const e0 = h.indexOf('async function ctMap(){');
const src = [lineOf('const _esc='), lineOf('const CT_CARC='), lineOf('function ctCarOf'), lineOf('function ctCarColor'), h.slice(s0, e0)].join(String.fromCharCode(10));

// ===== 构造六类典型巷道（占用率 st.u/st.t、滞留 sr=w.stale/w.boxes、今日出库 outT）=====
// 期望图标：晴☀️ / 多云⛅(占用≥50) / 雨🌧(滞留>50) / 冻❄️(滞留>70且无出) / 台风🌪(出≥15) / 空置⬜(无货无占用)
const cases = [
  { z: 'NB02-A', w: { boxes: 10, stale: 1, outT: 2, inT: 1 }, st: { t: 64, u: 10 }, exp: '☀️', why: '占用16%滞留10%' },
  { z: 'NB02-B', w: { boxes: 40, stale: 12, outT: 3, inT: 2 }, st: { t: 64, u: 40 }, exp: '⛅', why: '占用63%滞留30%' },
  { z: 'NB02-C', w: { boxes: 30, stale: 20, outT: 5, inT: 1 }, st: { t: 64, u: 30 }, exp: '🌧', why: '滞留67%>50' },
  { z: 'NB02-D', w: { boxes: 20, stale: 18, outT: 0, inT: 0 }, st: { t: 64, u: 20 }, exp: '❄️', why: '滞留90%>70且零出库' },
  { z: 'NB02-E', w: { boxes: 20, stale: 4, outT: 19, inT: 1 }, st: { t: 64, u: 20 }, exp: '🌪', why: '今日出19≥15' },
  { z: 'NB02-G', w: { boxes: 0, stale: 0, outT: 0, inT: 0 }, st: { t: 64, u: 0 }, exp: '⬜', why: '空置' },
];
const zones = {}; const _zoneSt = {};
cases.forEach((c) => { zones[c.z] = c.w; _zoneSt[c.z] = c.st; });
const ctx = { window: { _pjMap: db.projMap || {} }, CTN: { weather: { zones, at: Date.now() }, _zoneSt, rack: { count: 8, cols: 16, tiers: 4 }, types: {}, zf: '' }, console, Math, Date, Object, JSON, String, Number, Array, RegExp, Set };
vm.createContext(ctx);
let out = '', ran = true;
try { out = vm.runInContext(src + String.fromCharCode(10) + 'ctWeatherHtml()', ctx); } catch (e) { ran = false; console.log('  抛错: ' + e.message); }
T('F1 真实 ctWeatherHtml 执行不抛异常', ran, true);

// 按卡片切分解析图标：每卡以 ctZone('NB02-X') 起始，图标是该卡首个 emoji
function iconOfCard(html, z) {
  const key = "ctZone('" + z + "')";
  const i = html.indexOf(key); if (i < 0) return null;
  const next = html.indexOf("ctZone('", i + key.length);
  const seg = html.slice(i, next < 0 ? i + 400 : next);
  const m = seg.match(/font-size:26px;line-height:1">([^\s<]+)</);
  return m ? m[1] : (seg.match(/>(☀️|⛅|🌧|❄️|🌪|⬜)</) || [])[1] || null;
}
let allOk = true;
cases.forEach((c) => { const got = iconOfCard(out, c.z); if (got !== c.exp) { allOk = false; console.log('  ' + c.z + ' 期望 ' + c.exp + ' 实得 ' + got + '（' + c.why + '）'); } else console.log('  ✓ ' + c.z + ' ' + c.exp + ' ' + c.why); });
T('F2 六类天气图标全部分类正确（晴/多云/雨/冻/台风/空置）', allOk, true);
T('F3 渲染含占用率进度条与周转数字', /width:\d+%;background/.test(out) && /今日 出\d+ · 入\d+ · 在架\d+框/.test(out), true);

// ===== 车型彩虹：真实 ctCarOf 对真实件号（字典优先） =====
const pjSample = Object.entries(db.projMap || {}).find(([, cs]) => (cs || []).some((c) => ['EX11','EX1H','E281','V446K','EF2H'].includes(String(c).toUpperCase())));
if (pjSample) { const car = vm.runInContext('ctCarOf({p:' + JSON.stringify(pjSample[0]) + ',n:"无关ZZZ"})', ctx); T('F4 真实 ctCarOf 项目字典优先命中车型', ['EX11', 'EX1H', 'E281', 'V446K', 'EF2H'].includes(car), true); }
else T('F4 无字典车型样本跳过', true, true);
// 正则兜底：名称含 EX1H 但字典无此件号
const car2 = vm.runInContext('ctCarOf({p:"ZZZ9999999",n:"10-吉利EX1H-中通道"})', ctx);
T('F5 真实 ctCarOf 名称正则兜底 EX1H', car2, 'EX1H');

console.log('\n===== 前端真实函数沙箱验证 ' + (total - fail) + '/' + total + ' 通过 =====');
process.exit(fail ? 1 : 0);
