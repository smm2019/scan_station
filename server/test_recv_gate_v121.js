// ㉖v121 来料区源头闸 · 实例验证（路线A，11-07 拍板）
// 规则：receivingOn=1 时，全新框（无账本/无流水/无录入留痕/无出库留痕）二楼采集直接上架 → 拦；
// 豁免：曾出库（生产退料）、一楼已登记NB04（转入）、recv=1登记模式、开关=0（惰性恢复v120行为）；强过出口保留。
// G1 启用+新框=拦且文案三要素齐（指引/豁免说明/强过出路） G2 停用+新框=放
// G3 曾出库框不被新闸拦 G4 NB04在账框走转入豁免 G5 recv=1不受闸 G6 拦截走 blockIn 弹窗通道（非403）
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const SRV = path.join(__dirname, 'server.js');
const SRC = path.join(__dirname, 'data', 'db.json');
const TMP = path.join(__dirname, 'proof_recv_gate');
const PORT = 18147;
const VT = 'TESTTOK_v121';
let fail = 0, total = 0;
function T(n, a, b) { total++; const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) { fail++; console.log('FAIL ' + n + '\n  实际=' + JSON.stringify(a) + '\n  期望=' + JSON.stringify(b)); } else console.log('PASS ' + n); }
const rq = (p, tok) => new Promise((resolve, reject) => { http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 12000, headers: tok ? { Authorization: 'Bearer ' + tok } : {} }, (res) => { let s = ''; res.on('data', (c) => s += c); res.on('end', () => { try { resolve({ status: res.statusCode, j: JSON.parse(s) }); } catch (e) { reject(new Error(p + ' 解析失败(状态' + res.statusCode + '): ' + s.slice(0, 120))); } }); }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('超时')); }); });
const post = (p, body, tok) => new Promise((resolve, reject) => { const data = JSON.stringify(body); const r0 = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST', timeout: 12000, headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (r) => { let s = ''; r.on('data', (c) => s += c); r.on('end', () => { try { resolve({ status: r.statusCode, j: JSON.parse(s) }); } catch (e) { reject(new Error('bad json')); } }); }); r0.on('error', reject); r0.write(data); r0.end(); });

(async () => {
  // 隔离副本：真实数据 + 注入 admin 会话 + 保证有 NB04 在账样本（转入场景）
  fs.rmSync(TMP, { recursive: true, force: true }); fs.mkdirSync(path.join(TMP, 'logs'), { recursive: true });
  fs.copyFileSync(SRC, path.join(TMP, 'db.json'));
  if (fs.existsSync(path.join(__dirname, 'data', 'secret.key'))) fs.copyFileSync(path.join(__dirname, 'data', 'secret.key'), path.join(TMP, 'secret.key'));
  const db = JSON.parse(fs.readFileSync(path.join(TMP, 'db.json'), 'utf8'));
  const a = (db.users || []).find((x) => x.role === 'admin' && x.enabled !== false);
  if (!a) { console.log('FATAL: 无启用 admin'); process.exit(2); }
  db.sessions = db.sessions || {}; db.sessions[VT] = { userId: a.id, dev: 'TEST-V121', lastSeen: Date.now() };
  if (!db.ledger.some((x) => /^NB04-/.test(String(x.l || '').toUpperCase()))) {
    db.ledger.push({ c: 'N26K990001', l: 'NB04-A-01-001', f: '框', t: Date.now() - 3600000, p: '6608453824', n: '测试件', q: 25, b: '2026-11-06', pid: '', mv: '登记', src: '来料区', by: '测试一楼' });
    db.seenIn = db.seenIn || {}; db.seenIn['N26K990001'] = { by: '测试一楼', t: Date.now() - 3600000, l: 'NB04-A-01-001', p: '6608453824', q: 25, lot: '2026-11-06', pid: '' };
  }
  fs.writeFileSync(path.join(TMP, 'db.json'), JSON.stringify(db));

  const inst = spawn(process.execPath, [SRV], { env: Object.assign({}, process.env, { DATA_DIR: TMP, PORT: String(PORT) }), stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false;
  for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 1000)); try { const h = await rq('/api/health'); if (h.j && h.j.ok) { up = true; break; } } catch (_) {} }
  T('H0 隔离服务器就绪', up, true);
  if (!up) { try { inst.kill('SIGKILL'); } catch (_) {} process.exit(1); }

  try {
    const d2 = JSON.parse(fs.readFileSync(path.join(TMP, 'db.json'), 'utf8'));
    const known = new Set([...Object.keys(d2.seenOut || {}), ...Object.keys(d2.seenIn || {}), ...Object.keys(d2.scanlog || {}), ...(d2.ledger || []).map((x) => String(x.c).toUpperCase())]);
    const fresh = 'N99X000001';
    if (known.has(fresh)) { console.log('FATAL: 样本码不干净'); process.exit(2); }
    const inSet = new Set((d2.ledger || []).map((x) => String(x.c).toUpperCase()));
    const outCode = Object.keys(d2.seenOut || {}).find((c) => !inSet.has(String(c).toUpperCase()));
    const recvRow = (d2.ledger || []).find((x) => /^NB04-/.test(String(x.l || '').toUpperCase()));
    const NEW_GATE = /来料区已启用：此框未经一楼/;
    const setRecv = async (v) => { const r = await post('/api/admin/params', { values: { receivingOn: v } }, VT); if (!r.j.ok) throw new Error('设参数失败' + JSON.stringify(r.j)); };

    // G1 启用 + 全新框 → 拦，文案三要素
    await setRecv(1);
    let r = await rq('/api/label/check?c=' + fresh, VT);
    T('G1a 启用+新框=拦', r.j.blockIn, true);
    T('G1b 文案含一楼指引', /先在一楼扫入登记/.test(String(r.j.reason || '')), true);
    T('G1c 文案含退料豁免说明', /生产退料/.test(String(r.j.reason || '')), true);
    T('G1d 文案保留强过出路', /强制继续/.test(String(r.j.reason || '')), true);
    T('G6 拦截走弹窗通道(200+ok+blockIn，非403)', [r.status, r.j.ok, r.j.blockIn], [200, true, true]);

    // G2 停用 + 全新框 → 放（v120 惰性行为恢复）
    await setRecv(0);
    r = await rq('/api/label/check?c=' + fresh, VT);
    T('G2 停用+新框=放行', r.j.blockIn, false);

    // G3 启用 + 曾出库框 → 不被新闸拦（退料豁免；既有 everOut 复用拦属旧行为不算新闸）
    await setRecv(1);
    if (outCode) { r = await rq('/api/label/check?c=' + outCode, VT); T('G3 曾出库框不被新闸拦', NEW_GATE.test(String(r.j.reason || '')), false); }
    else console.log('SKIP G3 无曾出库不在架样本');

    // G4 启用 + 一楼已登记NB04框 → 转入豁免（1407 旧分支，非新闸）
    if (recvRow) { r = await rq('/api/label/check?c=' + recvRow.c, VT); T('G4 NB04在账走转入豁免', NEW_GATE.test(String(r.j.reason || '')), false); }
    else console.log('SKIP G4 无NB04样本');

    // G5 一楼登记模式 recv=1 扫新框 → 不受新闸影响（登记本来就该能扫）
    r = await rq('/api/label/check?c=' + fresh + '&recv=1', VT);
    T('G5 一楼登记模式不被新闸拦', NEW_GATE.test(String(r.j.reason || '')), false);
  } finally {
    try { inst.kill('SIGKILL'); } catch (_) {}
    fs.rmSync(TMP, { recursive: true, force: true });
  }
  console.log('\n===== v121 来料区源头闸验证 ' + (total - fail) + '/' + total + ' 通过 =====');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERR', e.message); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} process.exit(2); });
