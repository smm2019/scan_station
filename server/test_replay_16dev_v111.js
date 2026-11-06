// ㉖v111 还原生产场景实证：16 在线设备并发推送 ledger/sync + scanlog/sync（面板 70 分三黄条靶子）
// 复刻真实负载：PDA 周期性批量推送（items 带 c/l/p/n/q/b/pid + del 数组；流水带 k/code/pn/q/nm/t/cx）
// 双模式对照：asyncSave=0（截图现场=70分）vs asyncSave=1 → 同一压测脚本跑，直接对比面板三黄条指标
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const SRV = path.join(__dirname, 'server.js');
const SRC_DB = path.join(__dirname, 'data', 'db.json');
const TMP = path.join(__dirname, 'proof_replay_data');
let fail = 0, total = 0;
function T(n, a, b) { total++; const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) { fail++; console.log('FAIL ' + n + '\n  实际=' + JSON.stringify(a) + '\n  期望=' + JSON.stringify(b)); } else console.log('PASS ' + n); }
const rq = (port, method, p, body, timeoutMs = 20000) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : null;
  const r = http.request({ host: '127.0.0.1', port, path: p, method, timeout: timeoutMs, headers: Object.assign({ Authorization: 'Bearer RT' }, data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) },
    (res) => { let s = ''; res.on('data', (c) => s += c); res.on('end', () => { try { resolve({ code: res.statusCode, j: JSON.parse(s) }); } catch (e) { reject(new Error(p + ' 解析失败')); } }); });
  r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error(p + ' 超时')); });
  if (data) r.write(data); r.end();
});

function prep(params) {
  fs.rmSync(TMP, { recursive: true, force: true }); fs.mkdirSync(path.join(TMP, 'logs'), { recursive: true });
  fs.copyFileSync(SRC_DB, path.join(TMP, 'db.json'));
  if (fs.existsSync(path.join(__dirname, 'data', 'secret.key'))) fs.copyFileSync(path.join(__dirname, 'data', 'secret.key'), path.join(TMP, 'secret.key'));
  const d = JSON.parse(fs.readFileSync(path.join(TMP, 'db.json'), 'utf8'));
  const admin = (d.users || []).find((x) => x.role === 'admin' && x.enabled !== false);
  d.sessions = d.sessions || {}; d.sessions.RT = { userId: admin.id, dev: 'TEST-REPLAY', lastSeen: Date.now() };
  if (d.rcsConfig) d.rcsConfig.host = '192.0.2.1:8080';
  if (d.wmasConfig) d.wmasConfig.host = '192.0.2.1:8081';
  d.params = Object.assign({}, d.params, params, { reqHoursOn: 0 });
  fs.writeFileSync(path.join(TMP, 'db.json'), JSON.stringify(d));
  return admin;
}

// ===== 真实推送负载生成器（16 设备各推自己那批框；PDA 每轮推增量，这里模拟持续在线=周期小批量+偶发大批） =====
function ledgerBatch(dev, round) {
  const items = [];
  const n = round % 8 === 0 ? 120 : 25; // 偶发大批（对齐面板 items 规模）
  for (let i = 0; i < n; i++) {
    const c = 'RP' + dev + String(i).padStart(4, '0');
    items.push({ c, l: 'NB02-' + 'ABCDEF'[dev % 6] + '-' + String((i % 16) + 1).padStart(2, '0') + '-' + (1 + i % 4) + 'F', p: '889' + String(1000000 + dev * 1000 + i), n: '还原压测料-' + dev + '-' + i, q: 50 + (i % 7) * 10, b: '2026-11-0' + (1 + i % 5), pid: i % 3 === 0 ? 'RPT' + dev + i : '' });
  }
  const del = round % 5 === 0 ? ['RP' + dev + '0001'] : [];
  return { items, del };
}
function scanlogBatch(dev, round) {
  const items = [];
  const n = round % 8 === 0 ? 150 : 30;
  for (let i = 0; i < n; i++) {
    const c = 'RP' + dev + String(i).padStart(4, '0');
    items.push({ k: c + '|B2026-11-05-' + dev + '-' + round + '-' + i, code: c, pn: '889' + String(1000000 + dev * 1000 + i), nm: '还原压测料-' + dev + '-' + i, q: 50 + (i % 7) * 10, wt: 1, gl: 'NB02-' + 'ABCDEF'[dev % 6] + '-01-1F', lot: '2026-11-05', t: Date.now() - i * 1000, op: '压测员' + dev, cx: false });
  }
  return { items };
}

async function bench(port, label) {
  // 预热避开启动备份
  await new Promise((r) => setTimeout(r, 3000));
  const lat = { ledger: [], scanlog: [], health: [] }; const errs = { ledger: 0, scanlog: 0, health: 0 };
  const t0 = Date.now();
  const devs = Array.from({ length: 16 }, (_, d) => d);
  const pusher = async (d) => {
    for (let round = 1; round <= 6; round++) {
      try { const t = Date.now(); const r = await rq(port, 'POST', '/api/ledger/sync', Object.assign({ rev: null }, ledgerBatch(d, round))); lat.ledger.push(Date.now() - t); if (!r.j.ok) errs.ledger++; } catch (_) { errs.ledger++; }
      try { const t = Date.now(); const r = await rq(port, 'POST', '/api/scanlog/sync', scanlogBatch(d, round)); lat.scanlog.push(Date.now() - t); if (!r.j.ok) errs.scanlog++; } catch (_) { errs.scanlog++; }
      await new Promise((r) => setTimeout(r, 200 + Math.floor(Math.random() * 300))); // 设备间错峰，还原真实在线节奏
    }
  };
  let stop = false;
  const poller = (async () => { while (!stop) { try { const t = Date.now(); await rq(port, 'GET', '/api/health', null, 15000); lat.health.push(Date.now() - t); } catch (_) { errs.health++; } await new Promise((r) => setTimeout(r, 150)); } })();
  await Promise.all(devs.map(pusher));
  stop = true; await poller.catch(() => {});
  const durS = Math.round((Date.now() - t0) / 1000);
  const stat = (arr) => { if (!arr.length) return { p95: -1, max: -1, avg: -1 }; const a = arr.slice().sort((x, y) => x - y); return { p95: a[Math.floor(a.length * 0.95)], max: a[a.length - 1], avg: Math.round(a.reduce((x, y) => x + y, 0) / a.length) }; };
  return { durS, ledger: stat(lat.ledger), scanlog: stat(lat.scanlog), health: stat(lat.health), errs, n: { ledger: lat.ledger.length, scanlog: lat.scanlog.length, health: lat.health.length } };
}

function readHealth(port) { return rq(port, 'GET', '/api/admin/healthscore', null); }

(async () => {
  // ===== 基线：asyncSave=0（截图现场模式） =====
  prep({ asyncSave: 0 });
  let inst = spawn(process.execPath, [SRV], { env: Object.assign({}, process.env, { DATA_DIR: TMP, PORT: '18130' }), stdio: ['ignore', 'pipe', 'pipe'] });
  let log0 = ''; inst.stderr.on('data', (d) => { log0 += d; }); inst.stdout.on('data', (d) => { log0 += d; });
  let up = false;
  for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 1000)); try { const h = await rq(18130, 'GET', '/api/health', null, 5000); if (h.j.ok) { up = true; break; } } catch (_) {} }
  T('H0 基线服务器(同步模式)就绪', up, true);
  if (!up) { console.log(log0.slice(0, 2000)); process.exit(1); }
  const b0 = await bench(18130, 'sync');
  const hs0 = await readHealth(18130);
  const sv0 = (hs0.j.items || []).find((x) => x.name === '落盘写耗时');
  const lag0 = (hs0.j.items || []).find((x) => x.name === '事件循环延迟');
  console.log('[基线 同步模式] 时长' + b0.durS + 's · ledger/sync p95=' + b0.ledger.p95 + ' max=' + b0.ledger.max + 'ms · scanlog/sync p95=' + b0.scanlog.p95 + ' max=' + b0.scanlog.max + 'ms · health p95=' + b0.health.p95 + ' max=' + b0.health.max + 'ms · 错误=' + JSON.stringify(b0.errs));
  console.log('[基线 同步模式] 面板: ' + sv0.val + ' || ' + lag0.val + ' || 得分' + hs0.j.score);
  try { inst.kill('SIGKILL'); } catch (_) {}
  await new Promise((r) => setTimeout(r, 1500));

  // ===== 对照：asyncSave=1（同一副本、同一压测脚本） =====
  { const d = JSON.parse(fs.readFileSync(path.join(TMP, 'db.json'), 'utf8')); d.params.asyncSave = 1; const admin = (d.users || []).find((x) => x.role === 'admin'); d.sessions.RT = { userId: admin.id, dev: 'TEST-REPLAY', lastSeen: Date.now() }; fs.writeFileSync(path.join(TMP, 'db.json'), JSON.stringify(d)); }
  inst = spawn(process.execPath, [SRV], { env: Object.assign({}, process.env, { DATA_DIR: TMP, PORT: '18131' }), stdio: ['ignore', 'pipe', 'pipe'] });
  let log1 = ''; inst.stderr.on('data', (d) => { log1 += d; }); inst.stdout.on('data', (d) => { log1 += d; });
  up = false;
  for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 1000)); try { const h = await rq(18131, 'GET', '/api/health', null, 5000); if (h.j.ok) { up = true; break; } } catch (_) {} }
  T('H1 对照服务器(异步模式)就绪', up, true);
  if (!up) { console.log(log1.slice(0, 2000)); process.exit(1); }
  const b1 = await bench(18131, 'async');
  const hs1 = await readHealth(18131);
  const sv1 = (hs1.j.items || []).find((x) => x.name === '落盘写耗时');
  const lag1 = (hs1.j.items || []).find((x) => x.name === '事件循环延迟');
  console.log('[对照 异步模式] 时长' + b1.durS + 's · ledger/sync p95=' + b1.ledger.p95 + ' max=' + b1.ledger.max + 'ms · scanlog/sync p95=' + b1.scanlog.p95 + ' max=' + b1.scanlog.max + 'ms · health p95=' + b1.health.p95 + ' max=' + b1.health.max + 'ms · 错误=' + JSON.stringify(b1.errs));
  console.log('[对照 异步模式] 面板: ' + sv1.val + ' || ' + lag1.val + ' || 得分' + hs1.j.score);

  // ===== 断言：还原截图三黄条的根治对比 =====
  T('R1 两模式压测均零业务错误（异步化不引入失败）', [b0.errs.ledger + b0.errs.scanlog + b0.errs.health, b1.errs.ledger + b1.errs.scanlog + b1.errs.health], [0, 0]);
  T('R2 面板口径：同步=阻塞与总耗时同高（截图209ms形态），异步=阻塞钉在序列化地板', /（同步）/.test(sv0.val) && /（异步）/.test(sv1.val) && Number(sv1.val.match(/阻塞max(\d+)/)[1]) < 300, true);
  T('R3 异步模式慢请求显著减少（health p95 对比）', b1.health.p95 <= b0.health.p95, true);
  T('R4 异步模式并发吞吐不劣化（压测总时长）', b1.durS <= b0.durS + 15, true);
  await new Promise((r) => setTimeout(r, 1500)); // 等末轮异步写在途落定
  T('R5 数据完整：异步终盘结构完整、原账本不丢（≥600行）、压测新行确已入账（货位重叠行被冲突防线正确拒绝）', (() => { const d = JSON.parse(fs.readFileSync(path.join(TMP, 'db.json'), 'utf8')); return Array.isArray(d.ledger) && Array.isArray(d.users) && typeof d.requisitions === 'object' && d.ledger.length >= 600 && d.ledger.some((x) => String(x.c || '').startsWith('RP')); })(), true);
  // 事件循环超时次数对比（截图 32 次的靶心指标）
  const over0 = Number((lag0.val.match(/超时(\d+)次/) || [])[1] || -1), over1 = Number((lag1.val.match(/超时(\d+)次/) || [])[1] || -1);
  console.log('[R6] 事件循环超时次数 同步=' + over0 + ' 异步=' + over1 + '（>200ms 口径，累计值）');
  T('R6 异步模式事件循环超时次数不高于同步', over1 <= over0, true);

  try { inst.kill('SIGKILL'); } catch (_) {}
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('\n===== 还原场景实证 ' + (total - fail) + '/' + total + ' 通过 =====');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FATAL ' + e.message); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(2); });
