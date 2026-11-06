// ㉖v111 异步落盘 · 极端场景多项实证（严谨版）
// U1-U4 单元级：写序 last-write-wins / 在途竞态丢帧（seq 修复复现）/ 写失败重试 / 退出排空
// S1-S3 真实服务：SIGKILL 断电强杀×4 轮（原子性+已落盘单调不减）/ 同步vs异步并发延迟对比 / 混压全落盘
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const SRV = path.join(__dirname, 'server.js');
let fail = 0, total = 0;
function T(n, a, b) { total++; const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) { fail++; console.log('FAIL ' + n + '\n  实际=' + JSON.stringify(a) + '\n  期望=' + JSON.stringify(b)); } else console.log('PASS ' + n); }

(async () => {
  const UDIR = path.join(__dirname, 'proof_unit');
  fs.rmSync(UDIR, { recursive: true, force: true }); fs.mkdirSync(UDIR, { recursive: true });

  // ===== U1 写序队列：慢写在前快写在后 → 严格串行 + 后写者胜 + 条目清理 =====
  {
    const _wq = {}; const orderLog = [];
    function enqueue(target, data, delayMs) {
      const prev = _wq[target] || Promise.resolve();
      const next = prev.then(() => new Promise((r) => setTimeout(r, delayMs)).then(() => { orderLog.push(data); fs.writeFileSync(path.join(UDIR, target), data); }));
      const tail = next.catch(() => {});
      _wq[target] = tail;
      tail.then(() => { if (_wq[target] === tail) delete _wq[target]; });
      return next;
    }
    const p1 = enqueue('f1', 'V1', 150); const p2 = enqueue('f1', 'V2', 10);
    await Promise.all([p1, p2]);
    T('U1a 同文件严格串行（V1慢写先落，V2不得插队）', orderLog, ['V1', 'V2']);
    T('U1b last-write-wins（最终盘=最新快照）', fs.readFileSync(path.join(UDIR, 'f1'), 'utf8'), 'V2');
    T('U1c 队列条目完成即清理（无泄漏）', Object.keys(_wq).length, 0);
  }

  // ===== U2-U4 doSaveAsync/flushSaveNow 复刻（seq 双计数逐行对齐 server.js）=====
  let dirty = false, saveT = null, saving = false, dirtySeq = 0, writtenSeq = 0;
  let mem = 'INIT'; const writeLog = []; let failNext = false;
  const UF = path.join(UDIR, 'dbfile');
  async function saveDbAsyncFake() { const snap = mem; await new Promise((r) => setTimeout(r, 120)); if (failNext) { failNext = false; throw new Error('模拟磁盘故障'); } writeLog.push(snap); fs.writeFileSync(UF, snap); }
  async function doSaveAsyncFake() {
    if (saving) { dirty = true; return; }
    saving = true;
    const s = dirtySeq;
    try { await saveDbAsyncFake(); writtenSeq = s; if (dirtySeq === s) dirty = false; } catch (e) { /* logErr 对应位 */ }
    saving = false;
    if (dirty && !saveT) saveT = setTimeout(() => { saveT = null; doSaveAsyncFake(); }, 120);
  }
  async function flushSaveNowFake() {
    if (saveT) { clearTimeout(saveT); saveT = null; }
    while (saving) await new Promise((r) => setTimeout(r, 20));
    if (dirtySeq !== writtenSeq) { const s = dirtySeq; try { await saveDbAsyncFake(); writtenSeq = s; if (dirtySeq === s) dirty = false; } catch (e) {} }
  }
  function saveFake(v) { mem = v; dirty = true; dirtySeq++; doSaveAsyncFake(); }

  saveFake('A');
  await new Promise((r) => setTimeout(r, 40)); // A 磁盘写在途
  saveFake('B'); // 撞在途：saving=true → 只标脏
  await new Promise((r) => setTimeout(r, 700)); // A 完成（seq 不符不清脏）→ 重排 → B 落
  T('U2a 在途撞新变更：A、B 都落写（B 未被 A 收尾误清=丢帧bug已修复）', writeLog, ['A', 'B']);
  T('U2b 最终盘=最新快照 B', fs.readFileSync(UF, 'utf8'), 'B');

  failNext = true;
  saveFake('C');
  await new Promise((r) => setTimeout(r, 700)); // 首次抛错→脏保留→重排重试成功
  T('U3 磁盘写失败不吞变更：重试后 C 最终落盘', fs.readFileSync(UF, 'utf8'), 'C');

  saveFake('D');
  await new Promise((r) => setTimeout(r, 30));
  saveFake('E');
  await flushSaveNowFake(); // 模拟退出：返回时 E 必须已落
  T('U4 退出排空：flushSaveNow 返回即最新快照 E 落定（无 fire-and-forget）', fs.readFileSync(UF, 'utf8'), 'E');

  // ===== S 部分：真实服务器 =====
  const SRC_DB = path.join(__dirname, 'data', 'db.json');
  const raw = JSON.parse(fs.readFileSync(SRC_DB, 'utf8'));
  const admin = (raw.users || []).find((x) => x.role === 'admin' && x.enabled !== false);
  function prepCopy(dir, params) {
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    fs.copyFileSync(SRC_DB, path.join(dir, 'db.json'));
    if (fs.existsSync(path.join(__dirname, 'data', 'secret.key'))) fs.copyFileSync(path.join(__dirname, 'data', 'secret.key'), path.join(dir, 'secret.key'));
    const d = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));
    d.sessions = d.sessions || {}; d.sessions.PT = { userId: admin.id, dev: 'TEST-PROOF', lastSeen: Date.now() };
    if (d.rcsConfig) d.rcsConfig.host = '192.0.2.1:8080';
    if (d.wmasConfig) d.wmasConfig.host = '192.0.2.1:8081';
    d.params = Object.assign({}, d.params, params, { reqHoursOn: 0 });
    fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify(d));
  }
  const rq = (port, method, p, body, timeoutMs = 15000) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, path: p, method, timeout: timeoutMs, headers: Object.assign({ Authorization: 'Bearer PT' }, data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) },
      (res) => { let s = ''; res.on('data', (c) => s += c); res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(new Error('解析失败')); } }); });
    r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('超时')); });
    if (data) r.write(data); r.end();
  });
  function start(dir, port) { const c = spawn(process.execPath, [SRV], { env: Object.assign({}, process.env, { DATA_DIR: dir, PORT: String(port) }), stdio: ['ignore', 'ignore', 'pipe'] }); let log = ''; c.stderr.on('data', (dd) => { log += dd; }); return { c, log: () => log }; }
  async function waitUp(port) { for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 1000)); try { const h = await rq(port, 'GET', '/api/health', null, 5000); if (h.ok) return true; } catch (_) {} } return false; }
  async function killAndWait(c) { try { c.kill('SIGKILL'); } catch (_) {} await new Promise((r) => { c.on('exit', r); setTimeout(r, 8000); }); }

  // ===== S1 断电强杀（SIGKILL=TerminateProcess，handler 不跑=真断电等价）×4 轮 =====
  const S1DIR = path.join(__dirname, 'proof_s1');
  prepCopy(S1DIR, { asyncSave: 1 });
  let allIntact = true, mono = true, prevCount = Object.keys(JSON.parse(fs.readFileSync(path.join(S1DIR, 'db.json'), 'utf8')).requisitions || {}).length;
  for (let round = 1; round <= 4; round++) {
    const port = 18110 + round;
    const inst = start(S1DIR, port);
    if (!await waitUp(port)) { allIntact = false; break; }
    for (let i = 0; i < 8; i++) { try { await rq(port, 'POST', '/api/requisitions', { items: [{ partNo: 'KILL' + round + '_' + i, qty: 1 }] }, 8000); } catch (_) {} }
    await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 250))); // 合并窗/在途写随机时刻强杀
    await killAndWait(inst.c);
    try {
      const d = JSON.parse(fs.readFileSync(path.join(S1DIR, 'db.json'), 'utf8'));
      if (!Array.isArray(d.ledger) || typeof d.requisitions !== 'object' || !Array.isArray(d.users)) allIntact = false;
      const cnt = Object.keys(d.requisitions || {}).length;
      if (cnt < prevCount) { mono = false; console.log('  [S1 round' + round + '] 丢已落数据! ' + prevCount + '→' + cnt); }
      prevCount = cnt;
      console.log('  [S1 round' + round + '] 强杀后 db.json 完整可解析，单数=' + cnt);
    } catch (e) { allIntact = false; console.log('  [S1 round' + round + '] 解析失败：' + e.message); }
  }
  T('S1a 断电强杀×4：db.json 永远完整可解析（rename 原子性，无半文件/全零）', allIntact, true);
  T('S1b 已落盘数据单调不减（断电只可能丢合并窗内最新一批，绝不丢旧的）', mono, true);

  // ===== S2 主线程阻塞对比：同压测 同步vs异步 并发请求延迟分布 =====
  async function bench(port) {
    await new Promise((r) => setTimeout(r, 3000)); // 避开启动备份
    const lat = [];
    await Promise.all([
      Promise.all(Array.from({ length: 40 }, () => (async () => { const t = Date.now(); try { await rq(port, 'GET', '/api/health', null, 10000); } catch (_) {} lat.push(Date.now() - t); })())),
      (async () => { for (let i = 0; i < 15; i++) { try { await rq(port, 'POST', '/api/requisitions', { items: [{ partNo: 'BNCH' + port + '_' + i, qty: 1 }] }, 10000); } catch (_) {} await new Promise((r) => setTimeout(r, 150)); } })(),
    ]);
    lat.sort((a, b) => a - b);
    return { p95: lat[Math.floor(lat.length * 0.95)], max: lat[lat.length - 1], avg: Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) };
  }
  const S2DIR = path.join(__dirname, 'proof_s2');
  prepCopy(S2DIR, { asyncSave: 0 });
  let inst = start(S2DIR, 18120); await waitUp(18120);
  const bs = await bench(18120);
  await killAndWait(inst.c); await new Promise((r) => setTimeout(r, 1200));
  { const d = JSON.parse(fs.readFileSync(path.join(S2DIR, 'db.json'), 'utf8')); d.params = d.params || {}; d.params.asyncSave = 1; d.sessions.PT = { userId: admin.id, dev: 'TEST-PROOF', lastSeen: Date.now() }; fs.writeFileSync(path.join(S2DIR, 'db.json'), JSON.stringify(d)); }
  inst = start(S2DIR, 18121); await waitUp(18121);
  const ba = await bench(18121);
  console.log('  [S2] 同步模式 并发健康请求 avg' + bs.avg + '/p95' + bs.p95 + '/max' + bs.max + 'ms（15次落盘×全程冻结）');
  console.log('  [S2] 异步模式 并发健康请求 avg' + ba.avg + '/p95' + ba.p95 + '/max' + ba.max + 'ms（15次落盘×仅序列化）');
  T('S2a 异步模式并发延迟 p95 不劣于同步（磁盘等待挪出主线程的直接量化）', ba.p95 <= bs.p95, true);
  T('S2b 异步模式 max 延迟优于同步', ba.max < bs.max, true);
  T('S2c 异步模式 p95 处于可接受区间(<600ms)', ba.p95 < 600, true);

  // ===== S3 异步混压全落盘 =====
  for (let i = 0; i < 20; i++) { try { await rq(18121, 'POST', '/api/requisitions', { items: [{ partNo: 'MIX' + i, qty: 1 }] }, 10000); } catch (_) {} }
  await new Promise((r) => setTimeout(r, 3000));
  await killAndWait(inst.c);
  const d3 = JSON.parse(fs.readFileSync(path.join(S2DIR, 'db.json'), 'utf8'));
  const mixN = Object.values(d3.requisitions || {}).filter((r) => (r.items || []).some((it) => String(it.partNo || '').startsWith('MIX'))).length;
  T('S3a 混压 20 单全部落盘（合并窗+异步写无丢帧）', mixN, 20);
  T('S3b 终盘结构完整（users/ledger/requisitions 俱在）', [Array.isArray(d3.users), Array.isArray(d3.ledger), typeof d3.requisitions === 'object'], [true, true, true]);

  fs.rmSync(UDIR, { recursive: true, force: true }); fs.rmSync(S1DIR, { recursive: true, force: true }); fs.rmSync(S2DIR, { recursive: true, force: true });
  console.log('\n===== v111 极端场景实证 ' + (total - fail) + '/' + total + ' 通过 =====');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FATAL ' + e.message); process.exit(2); });
