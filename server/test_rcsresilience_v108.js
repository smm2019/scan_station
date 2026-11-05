// ㉖v108 RCS故障韧性 · 仿真测试（11/4 下午 RCS 故障实锤：/api/rcs/cars 串行3×8s超时 p95=21920ms×140）
// 起本地 HTTP 假 RCS：mode=ok 秒回 / mode=hang 永不回包（触发客户端 8 秒超时，模拟不可达）。
// 复刻生产 rcsReq(8s超时)/rcsReq2(重登重试)/rcsGetCache(TTL+熔断+陈旧兜底) 与 cars 端点新旧编排。
const http = require('http');

const srv = http.createServer((req, res) => {
  if (req.url === '/login') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ code: 0, data: { token: 'TK' } })); }
  if (global.__mode === 'hang') return; // 永不回包 → 客户端 8 秒超时
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ code: 0, data: JSON.stringify([{ agvId: 1, carName: 'AGV01' }]) }));
});
srv.listen(0);
const HOST = '127.0.0.1:' + srv.address().port;

// ---- 生产代码复刻（逐行对齐 server.js 改动区）----
const db = { rcsConfig: { host: HOST, account: 'a', pwd: 'p' }, rcsToken: '', rcsTokenExp: 0 };
function rcsReq(path, method = 'GET', token = '') {
  return new Promise((resolve) => {
    try {
      const [host, port] = String(db.rcsConfig.host || '').split(':');
      if (!host) return resolve(null);
      const req = http.request({ host, port: parseInt(port || '80'), path, method, timeout: 8000, headers: token ? { token } : {} },
        (res) => { let s = ''; res.on('data', (c) => s += c); res.on('end', () => { try { resolve(JSON.parse(s)); } catch (_) { resolve(null); } }); });
      req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end();
    } catch (_) { resolve(null); }
  });
}
async function rcsLogin() {
  return new Promise((resolve) => {
    const [host, port] = String(db.rcsConfig.host).split(':');
    const req = http.request({ host, port: parseInt(port), path: '/login', method: 'POST', timeout: 8000 },
      (res) => { let s = ''; res.on('data', (c) => s += c); res.on('end', () => { try { const jj = JSON.parse(s); if (jj.code === 0 && jj.data && jj.data.token) { db.rcsToken = jj.data.token; db.rcsTokenExp = Date.now() + 11 * 3600 * 1000; resolve(jj.data.token); } else resolve(null); } catch (_) { resolve(null); } }); });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); }); req.end();
  });
}
async function rcsReq2(path, method = 'GET') {
  if (!db.rcsConfig || !db.rcsConfig.host) return { ok: false, msg: 'RCS 未配置' };
  const getTk = async () => ((db.rcsToken && Date.now() < (db.rcsTokenExp || 0)) ? db.rcsToken : await rcsLogin());
  const call = async () => { const tk = await getTk(); if (!tk) return null; return rcsReq(path, method, tk) || { code: -1, msg: 'RCS无响应' }; };
  let r = await call();
  if (!r) return { ok: false, msg: 'RCS 登录失败或无响应' };
  const authBad = r.code !== 0 && /未登录|过期|token|Token/.test(String(r.msg || ''));
  if (authBad) { db.rcsToken = ''; db.rcsTokenExp = 0; r = await call(); if (!r) return { ok: false, msg: 'RCS 重登失败' }; }
  if (r.code === 0) return { ok: true, data: r.data };
  return { ok: false, msg: String(r.msg || ('RCS返回 code=' + r.code)) };
}
// ===== 被测：v108 新增（与 server.js 逐行一致）=====
const _rcsCache = {};
async function rcsGetCache(path, ttlMs = 8000) {
  const now = Date.now(), c = _rcsCache[path];
  if (c && !c.bad && now - c.at < ttlMs) return { ok: true, data: c.data, cached: true };
  const stale = c && c.data !== undefined && now - c.at < 60000;
  if (c && c.bad && now < c.nextTry) return stale ? { ok: true, data: c.data, stale: true, staleAt: c.at } : { ok: false, msg: 'RCS故障（熔断窗内，数秒后自动探测恢复）' };
  const r = await rcsReq2(path);
  if (r && r.ok) { _rcsCache[path] = { data: r.data, at: Date.now(), bad: false }; return r; }
  _rcsCache[path] = { data: c ? c.data : undefined, at: c ? c.at : 0, bad: true, nextTry: Date.now() + 5000 };
  return stale ? { ok: true, data: c.data, stale: true, staleAt: c.at } : (r || { ok: false, msg: 'RCS无响应' });
}
// ===== 被测：cars 端点新旧编排 =====
const P3 = ['/uds/car/getCarInfoList', '/agv/debug/getCarListForStatus', '/agv/debug/getLockResourceListForStatus'];
async function carsOld() { const rs = []; for (const p of P3) rs.push(await rcsReq2(p)); return rs; } // 旧串行
async function carsNew() { return Promise.all(P3.map((p) => rcsGetCache(p))); } // 新并行+缓存

// ---- 断言 ----
let fail = 0, total = 0;
function T(n, a, b) { total++; const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) { fail++; console.log('FAIL ' + n + '\n  实际=' + JSON.stringify(a) + '\n  期望=' + JSON.stringify(b)); } else console.log('PASS ' + n); }
const timed = async (f) => { const t = Date.now(); const r = await f(); return { ms: Date.now() - t, r }; };
const reset = () => { db.rcsToken = ''; Object.keys(_rcsCache).forEach((k) => delete _rcsCache[k]); };

(async () => {
  // ===== S1 正常期：新编排毫秒级、热缓存不打RCS、数据可用 =====
  global.__mode = 'ok'; reset();
  const o1 = await timed(carsOld);
  const n1 = await timed(carsNew);
  console.log(`[S1] 正常期：旧串行=${o1.ms}ms 新并行(冷缓存)=${n1.ms}ms`);
  T('S1a 正常期新编排亚秒（并行不慢于串行）', n1.ms < 500, true);
  T('S1b 新编排数据等价（三路径全ok）', n1.r.every((x) => x.ok), true);
  const n2 = await timed(carsNew);
  T('S1c 热缓存毫秒级返回（TTL内不打RCS）', n2.ms < 30 && n2.r.every((x) => x.cached), true);

  // ===== S2 复现11/4故障：RCS挂起>8秒 =====
  global.__mode = 'hang'; reset();
  const o2 = await timed(carsOld);
  console.log(`[S2] 故障期旧串行=${o2.ms}ms（截图 p95=21920ms 复现）`);
  T('S2a 旧串行复现21~24秒级（3×8s超时，与面板吻合）', o2.ms >= 20000 && o2.ms <= 26000, true);
  reset();
  const n3 = await timed(carsNew);
  console.log(`[S2] 故障期新编排冷缓存首探=${n3.ms}ms`);
  T('S2b 新编排故障首探≈8秒（并行等超时，非24秒）', n3.ms >= 7000 && n3.ms <= 11000, true);
  T('S2c 无历史快照时如实失败（不假装成功）', n3.r.every((x) => x.ok === false), true);
  const n4 = await timed(carsNew);
  console.log(`[S2] 熔断窗内=${n4.ms}ms`);
  T('S2d 熔断窗内毫秒级快速失败（PDA狂刷不再烧超时）', n4.ms < 30, true);

  // ===== S3 先成功后故障：陈旧兜底 =====
  global.__mode = 'ok'; reset();
  await carsNew(); // 攒成功快照
  await new Promise((r) => setTimeout(r, 8100)); // 过TTL强制下次真打RCS
  global.__mode = 'hang';
  const n5 = await timed(carsNew);
  T('S3a 故障命中陈旧快照（ok+stale标记）', n5.r.every((x) => x.ok && x.stale), true);
  const n6 = await timed(carsNew);
  console.log(`[S3] 兜底再来=${n6.ms}ms`);
  T('S3b 兜底请求毫秒级返回最后状态（页面不转圈）', n6.ms < 30 && n6.r.every((x) => x.ok && x.stale), true);

  // ===== S4 恢复自愈 =====
  await new Promise((r) => setTimeout(r, 5100)); // 等熔断探测窗到期
  global.__mode = 'ok';
  const n7 = await timed(carsNew);
  T('S4a RCS恢复后自动回正（stale消失）', n7.r.every((x) => x.ok && !x.stale), true);
  const n8 = await timed(carsNew);
  T('S4b 恢复后热缓存毫秒级', n8.ms < 30, true);

  // ===== S5 边界：缓存只许用于只读展示路径 =====
  const src = require('fs').readFileSync('server.js', 'utf8');
  const calls = [...src.matchAll(/rcsGetCache\('([^']+)'/g)].map((m) => m[1]);
  const allowed = new Set(P3);
  T('S5a 生产源码中缓存调用≥6处且全部限于三个只读路径（cars3+traffic2+map1）', calls.length >= 6 && calls.every((c) => allowed.has(c)), true);
  T('S5b 写操作taskAct/unlockStation仍走rcsReq2直连（不经缓存）', /await rcsReq2\(path, m\[0\]/.test(src) && /await rcsReq2\('\/agv\/debug\/unlockStation/.test(src), true);
  T('S5c 状态判定tasks run仍直连rcsReq2（队列对账地基不缓存）', /const run = await rcsReq2\('\/task\/getTaskInfo'\)/.test(src), true);

  console.log(`\n===== ${total - fail}/${total} 通过 =====`);
  srv.close(); process.exit(fail ? 1 : 0);
})();
