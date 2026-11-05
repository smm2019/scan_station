// ㉖v109 物料号冒充零件号修复 · 实例验证
// 隔离 DATA_DIR=生产库副本起真实服务器：
//  V1 存量自愈：真实污染单 DT20261105162049 的 code=162010000787 → 启动后回正 6608625843 + 审计留痕
//  V2 新单纠正：POST /api/outbound/sync 带物料号形态 code → 落库前回正
//  V3 多义不猜：mc 映射多件号 → 保持物料号形态（宁缺勿错改）
//  V4 正常单不误改：code≠mitemCode → 原样
//  V5 幂等：重启自愈不重复改
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const SRV = path.join(__dirname, 'server.js');
const TMP = path.join(__dirname, 'test_mitemfix_data');
const PORT = 18106;
const TOKEN = 'TESTTOK_mitemfix';
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
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP, 'logs'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), path.join(TMP, 'db.json'));
  if (fs.existsSync(path.join(__dirname, 'data', 'secret.key'))) fs.copyFileSync(path.join(__dirname, 'data', 'secret.key'), path.join(TMP, 'secret.key'));
  const db = JSON.parse(fs.readFileSync(path.join(TMP, 'db.json'), 'utf8'));
  const admin = (db.users || []).find((x) => x.role === 'admin' && x.enabled !== false);
  db.sessions = db.sessions || {};
  db.sessions[TOKEN] = { userId: admin.id, dev: 'TEST-MITEMFIX', lastSeen: Date.now() };
  if (db.rcsConfig) db.rcsConfig.host = '192.0.2.1:8080';
  if (db.wmasConfig) db.wmasConfig.host = '192.0.2.1:8081';
  db.outboundMitemFixedV109 = 0; // 确保自愈真跑
  // 自带合成污染夹具（不依赖生产现状——真实污染单 DT20261105162049 已被生产自愈纠正）：
  // TESTPOLL：出库明细 code=mitemCode=物料号形态 → 自愈应回正 6608625843（字典 162010000787 唯一映射）
  db.outbound = db.outbound || {}; db.itemDict = db.itemDict || {};
  const _tpn = Date.now();
  db.outbound['TESTPOLL' + _tpn] = { orderNo: 'TESTPOLL' + _tpn, createdAt: _tpn, toLoc: '焊-宁波-线边仓/线边仓/线边仓', operator: 'T', status: 1, linkReqNo: '', items: [{ code: '162010000787', mitemCode: '162010000787', name: '污染夹具', qty: 24, barcode: 'TESTPOLLCODE', fromLoc: '' }] };
  // 字典假键夹具：物料号形态键 + pn===mc 自指键 → 自愈应清除
  db.itemDict['162010000787'] = { nm: '假键夹具', src: 'test', at: _tpn };
  db.itemDict['162999000001'] = { nm: '假键夹具2', mc: '162999000001', src: 'test', at: _tpn };
  T('V0a 夹具：合成污染单已注入 code=物料号', db.outbound['TESTPOLL' + _tpn].items[0].code, '162010000787');
  T('V0b 夹具：字典假键已注入', Object.keys(db.itemDict).some((k) => /^16\d{10}$/.test(k)), true);
  const POLLNO = 'TESTPOLL' + _tpn;
  // 注入多义物料号场景（V3）：TESTAMCMC → 两个件号
  db.mitemDict = db.mitemDict || {};
  db.mitemDict['6609990001'] = { mc: 'TESTAMCMC', src: 'test', at: Date.now() };
  db.mitemDict['6609990002'] = { mc: 'TESTAMCMC', src: 'test', at: Date.now() };
  fs.writeFileSync(path.join(TMP, 'db.json'), JSON.stringify(db));

  const child = spawn(process.execPath, [SRV], { env: Object.assign({}, process.env, { DATA_DIR: TMP, PORT: String(PORT) }), stdio: ['ignore', 'pipe', 'pipe'] });
  let srvLog = '';
  child.stdout.on('data', (d) => { srvLog += d; }); child.stderr.on('data', (d) => { srvLog += d; });
  const cleanup = () => { try { child.kill('SIGKILL'); } catch (_) {} };
  process.on('exit', cleanup);
  let up = false;
  for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 1000)); try { const h = await req('GET', '/api/health', null, null, 5000); if (h.j && h.j.ok) { up = true; break; } } catch (_) {} }
  T('H0 隔离服务器就绪（存量自愈已执行）', up, true);
  if (!up) { console.log(srvLog.slice(0, 2000)); process.exit(1); }
  const readDb = () => JSON.parse(fs.readFileSync(path.join(TMP, 'db.json'), 'utf8'));
  await new Promise((r) => setTimeout(r, 1500));

  // ===== V1 存量自愈 =====
  const d1 = readDb();
  const fixed = (d1.outbound[POLLNO].items[0] || {}).code;
  T('V1a 合成污染单已回正 6608625843', fixed, '6608625843');
  T('V1b 自愈开关置位', d1.outboundMitemFixedV109, 1);
  T('V1c 启动日志含纠正计数', /v109 存量自愈：纠正物料号冒充零件号明细 \d+ 行，清除字典假键 \d+ 个/.test(srvLog), true);
  const aud = (d1.ledgerFixes || []).filter((x) => x.act === '明细纠正');
  T('V1d 审计留痕含单号', aud.length >= 1 && aud.some((x) => x.code === POLLNO), true);

  // ===== V2 新单纠正（落库前） =====
  const now = Date.now();
  const r2 = await req('POST', '/api/outbound/sync', TOKEN, { orderNo: 'TESTMF' + now, createdAt: now, toLoc: '焊-宁波-线边仓/线边仓/线边仓', operator: 'T', status: 1, items: [{ code: '162010000787', mitemCode: '162010000787', name: '纠正测试', qty: 5, barcode: 'TESTMFCODE01', fromLoc: '' }] });
  T('V2a 同步成功', r2.j.ok === true, true);
  await new Promise((r) => setTimeout(r, 1200));
  const d2 = readDb();
  T('V2b 新单 code 落库前已回正', (d2.outbound['TESTMF' + now].items[0] || {}).code, '6608625843');

  // ===== V3 多义不猜 =====
  const r3 = await req('POST', '/api/outbound/sync', TOKEN, { orderNo: 'TESTAM' + now, createdAt: now, toLoc: '焊-宁波-线边仓/线边仓/线边仓', operator: 'T', status: 1, items: [{ code: 'TESTAMCMC', mitemCode: 'TESTAMCMC', name: '多义测试', qty: 5, barcode: 'TESTAMCODE01', fromLoc: '' }] });
  await new Promise((r) => setTimeout(r, 1200));
  const d3 = readDb();
  T('V3 多义物料号保持原样不猜改', (d3.outbound['TESTAM' + now].items[0] || {}).code, 'TESTAMCMC');

  // ===== V4 正常单不误改 =====
  const r4 = await req('POST', '/api/outbound/sync', TOKEN, { orderNo: 'TESTOK' + now, createdAt: now, toLoc: '焊-宁波-线边仓/线边仓/线边仓', operator: 'T', status: 1, items: [{ code: '6608453824', mitemCode: '263003000099', name: '正常测试', qty: 5, barcode: 'TESTOKCODE01', fromLoc: '' }] });
  await new Promise((r) => setTimeout(r, 1200));
  const d4 = readDb();
  T('V4 正常单 code≠mitemCode 原样不动', (d4.outbound['TESTOK' + now].items[0] || {}).code, '6608453824');

  // ===== V5 字典未被物料号污染（纠正先于沉淀） =====
  T('V5 itemDict 无物料号形态假键', Object.keys(d4.itemDict || {}).some((k) => /^16\d{10}$/.test(k)), false);

  // ===== V6 幂等（重启进程再跑自愈=0 新纠正） =====
  child.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 800));
  const child2 = spawn(process.execPath, [SRV], { env: Object.assign({}, process.env, { DATA_DIR: TMP, PORT: String(PORT + 1) }), stdio: ['ignore', 'pipe', 'pipe'] });
  let srvLog2 = '';
  child2.stdout.on('data', (dd) => { srvLog2 += dd; }); child2.stderr.on('data', (dd) => { srvLog2 += dd; });
  const cleanup2 = () => { try { child2.kill('SIGKILL'); } catch (_) {} };
  process.on('exit', cleanup2);
  let up2 = false;
  for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 1000)); try { const h = await new Promise((res2, rej2) => { http.get({ host: '127.0.0.1', port: PORT + 1, path: '/api/health', timeout: 5000 }, (rr) => { let s = ''; rr.on('data', (c) => s += c); rr.on('end', () => { try { res2(JSON.parse(s)); } catch (_) { rej2(new Error('x')); } }); }).on('error', rej2); }); if (h.ok) { up2 = true; break; } } catch (_) {} }
  T('V6a 二次启动就绪', up2, true);
  await new Promise((r) => setTimeout(r, 1000));
  T('V6b 二次启动无重复纠正日志（幂等）', /v109 存量自愈/.test(srvLog2), false);
  const d6 = JSON.parse(fs.readFileSync(path.join(TMP, 'db.json'), 'utf8'));
  T('V6c 纠正后数据稳定（仍为真件号）', d6.outbound[POLLNO].items[0].code, '6608625843');
  T('V6d 字典假键保持清除（幂等不回潮）', Object.keys(d6.itemDict || {}).some((k) => /^16\d{10}$/.test(k)), false);

  console.log('\n===== 物料号冒充修复验证 ' + (total - fail) + '/' + total + ' 通过 =====');
  if (fail) { console.log(srvLog.slice(-1200)); console.log(srvLog2.slice(-600)); }
  cleanup2();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FATAL ' + e.message); try { child.kill('SIGKILL'); } catch (_) {} process.exit(2); });
