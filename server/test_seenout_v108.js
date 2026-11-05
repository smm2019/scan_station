// ㉖v108 移仓不盖"已出库"戳 · 实例验证
// 隔离 DATA_DIR=生产库副本起真实服务器：
//  S1 启动自愈：真实僵尸戳 N26K040083/74（11/5 冷冲件仓移仓误盖）应被 seenOutMoveFixV108 清理
//  S2 保守不误删：真实出库(线边仓)单盖的戳、领料转单(LL)盖的戳均保留
//  S3 新单行为：POST /api/outbound/sync 移仓单不盖戳、线边仓出库单正常盖戳
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const SRV = path.join(__dirname, 'server.js');
const TMP = path.join(__dirname, 'test_seenout_data');
const PORT = 18103;
const TOKEN = 'TESTTOK_seenout';
let fail = 0, total = 0;
function T(n, a, b) { total++; const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) { fail++; console.log('FAIL ' + n + '\n  实际=' + JSON.stringify(a) + '\n  期望=' + JSON.stringify(b)); } else console.log('PASS ' + n); }
const req = (method, p, tok, body, timeoutMs = 15000) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : null;
  const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, timeout: timeoutMs, headers: Object.assign({}, tok ? { Authorization: 'Bearer ' + tok } : {}, data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) },
    (res) => { let s = ''; res.on('data', (c) => s += c); res.on('end', () => { try { resolve({ code: res.statusCode, j: JSON.parse(s) }); } catch (e) { reject(new Error(p + ' 解析失败: ' + s.slice(0, 160))); } }); });
  r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error(p + ' 超时')); });
  if (data) r.write(data); r.end();
});

(async () => {
  // ---- 副本：注入会话，保留真实 N26K040083/74 的 seenOut 戳与 DT 移仓单（自愈素材）----
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP, 'logs'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), path.join(TMP, 'db.json'));
  if (fs.existsSync(path.join(__dirname, 'data', 'secret.key'))) fs.copyFileSync(path.join(__dirname, 'data', 'secret.key'), path.join(TMP, 'secret.key'));
  const db = JSON.parse(fs.readFileSync(path.join(TMP, 'db.json'), 'utf8'));
  const admin = (db.users || []).find((x) => x.role === 'admin' && x.enabled !== false);
  db.sessions = db.sessions || {};
  db.sessions[TOKEN] = { userId: admin.id, dev: 'TEST-SEENOUT', lastSeen: Date.now() };
  if (db.rcsConfig) db.rcsConfig.host = '192.0.2.1:8080';
  if (db.wmasConfig) db.wmasConfig.host = '192.0.2.1:8081';
  db.seenOutMoveFixedV108 = 0; // 确保自愈在测试进程真跑一次
  // 基线取证：注入前这两个码确实带着移仓误盖的戳
  const pre083 = (db.seenOut || {})['N26K040083'], pre074 = (db.seenOut || {})['N26K040074'];
  T('S0a 基线：N26K040083 注入前被盖戳(引用DT移仓单)', pre083 && /^DT/.test(String(pre083.no)), true);
  T('S0b 基线：N26K040074 注入前被盖戳', pre074 && /^DT/.test(String(pre074.no)), true);
  // 找一个"真实出库(线边仓)"戳与一个"领料转单(LL)"戳做保守对照
  const obByNo = {}; for (const o of Object.values(db.outbound || {})) obByNo[o.orderNo] = o;
  const keys = Object.keys(db.seenOut || {});
  let realOutSample = null, llSample = null;
  for (const c of keys) {
    const e = db.seenOut[c]; const no = String(e.no || '');
    if (llSample == null && /^LL\d/.test(no)) llSample = { c, no };
    const o = obByNo[no];
    if (realOutSample == null && o && !/冷冲件仓|热压|代发/.test(String(o.toLoc || '')) && /线边仓/.test(String(o.toLoc || ''))) realOutSample = { c, no, to: o.toLoc };
  }
  fs.writeFileSync(path.join(TMP, 'db.json'), JSON.stringify(db));

  const child = spawn(process.execPath, [SRV], { env: Object.assign({}, process.env, { DATA_DIR: TMP, PORT: String(PORT) }), stdio: ['ignore', 'pipe', 'pipe'] });
  let srvLog = '';
  child.stdout.on('data', (d) => { srvLog += d; }); child.stderr.on('data', (d) => { srvLog += d; });
  const cleanup = () => { try { child.kill('SIGKILL'); } catch (_) {} };
  process.on('exit', cleanup);
  let up = false;
  for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 1000)); try { const h = await req('GET', '/api/health', null, null, 5000); if (h.j && h.j.ok) { up = true; break; } } catch (_) {} }
  T('H0 隔离服务器就绪（启动自愈已执行）', up, true);
  if (!up) { console.log(srvLog.slice(0, 2500)); process.exit(1); }

  const readDb = () => JSON.parse(fs.readFileSync(path.join(TMP, 'db.json'), 'utf8'));
  await new Promise((r) => setTimeout(r, 1500)); // 等自愈落盘

  // ===== S1 存量自愈：移仓误盖戳被清理 =====
  const d1 = readDb();
  T('S1a N26K040083 移仓误盖戳已清除', !((d1.seenOut || {})['N26K040083']), true);
  T('S1b N26K040074 移仓误盖戳已清除', !((d1.seenOut || {})['N26K040074']), true);
  T('S1c 自愈开关已置位', d1.seenOutMoveFixedV108, 1);
  T('S1d 启动日志含清理计数', /v108 自愈：清理移仓误盖/.test(srvLog), true);

  // ===== S2 保守不误删 =====
  if (llSample) T('S2a 领料转单(LL)戳保留 ' + llSample.c, !!((d1.seenOut || {})[llSample.c]), true);
  else console.log('[S2a] 副本无 LL 样本，跳过');
  if (realOutSample) T('S2b 真实出库(线边仓)戳保留 ' + realOutSample.c, !!((d1.seenOut || {})[realOutSample.c]), true);
  else console.log('[S2b] 副本无线边仓出库样本，跳过');

  // ===== S3 新单行为：移仓不盖、线边仓盖 =====
  const now = Date.now();
  const rMv = await req('POST', '/api/outbound/sync', TOKEN, { orderNo: 'TESTMV' + now, createdAt: now, toLoc: '焊-宁波-冷冲件仓/冷冲件仓/冷冲件仓', operator: 'T', status: 1, items: [{ barcode: 'TESTMV0001', code: '8899990001', qty: 1 }] });
  T('S3a 移仓单同步成功', rMv.j.ok === true, true);
  const rOut = await req('POST', '/api/outbound/sync', TOKEN, { orderNo: 'TESTOB' + now, createdAt: now, toLoc: '焊-宁波-线边仓/线边仓/线边仓', operator: 'T', status: 1, items: [{ barcode: 'TESTOB0001', code: '8899990002', qty: 1 }] });
  T('S3b 线边仓出库单同步成功', rOut.j.ok === true, true);
  const rCp = await req('POST', '/api/outbound/sync', TOKEN, { orderNo: 'TESTCP' + now, createdAt: now, toLoc: '焊-宁波-成品仓/成品仓/成品仓', operator: 'T', status: 1, items: [{ barcode: 'TESTCP0001', code: '8899990003', qty: 1 }] }); // ㉖v108 成品仓=真实出库（用户口径）
  T('S3b2 成品仓出库单同步成功', rCp.j.ok === true, true);
  await new Promise((r) => setTimeout(r, 1500)); // 等落盘
  const d2 = readDb();
  T('S3c 移仓单标签未盖"已出库"戳', !((d2.seenOut || {})['TESTMV0001']), true);
  T('S3d 线边仓出库单标签正常盖戳', !!((d2.seenOut || {})['TESTOB0001']), true);
  T('S3e 成品仓出库单标签正常盖戳（真实出库）', !!((d2.seenOut || {})['TESTCP0001']), true);
  T('S3f 成品仓真实出库单标签未被自愈误删', !!((d2.seenOut || {})['N26K030156']), true); // 生产库真实样本：DT20261103150610→成品仓

  // ===== S4 采集拦截判据随之解除（labelBlockReason 口径：everOut 消失则不再"历史上架并已出库"）=====
  // 直接读服务器内部判据端点不可达，用自愈结果反证：083 已无 seenOut 记录 → 再采集不再命中 everOut 拦截
  T('S4 N26K040083 现无 everOut 证据（可正常再采集）', !((d2.seenOut || {})['N26K040083']), true);

  console.log('\n===== 移仓戳验证 ' + (total - fail) + '/' + total + ' 通过 =====');
  if (fail) { console.log('--- 服务器日志尾部 ---'); console.log(srvLog.slice(-1500)); }
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FATAL ' + e.message); try { child.kill('SIGKILL'); } catch (_) {} process.exit(2); });
