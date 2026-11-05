// ㉖v109 物料号补录联动回写零件号 · 实例验证
// 隔离 DATA_DIR=生产库副本起真实服务器，POST /api/mitem/batch 验证四条路径：
//  R1 空件号框+MES给pn → 回写 ledger.p/seenIn.p + ledgerFixes审计 + ledgerRev++
//  R2 已有件号框 → 一律不动（只补空号）
//  R3 MES没给pn但mc字典唯一件号 → 兜底回写
//  R4 mc字典多义件号 → 放弃不猜（宁缺勿错发）
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const SRV = path.join(__dirname, 'server.js');
const TMP = path.join(__dirname, 'test_pnfix_data');
const PORT = 18105;
const TOKEN = 'TESTTOK_pnfix';
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
  db.sessions[TOKEN] = { userId: admin.id, dev: 'TEST-PNFIX', lastSeen: Date.now() };
  if (db.rcsConfig) db.rcsConfig.host = '192.0.2.1:8080';
  if (db.wmasConfig) db.wmasConfig.host = '192.0.2.1:8081';

  // 注入测试框（合成脏数据，不依赖生产现状——生产 N26J290067 可能已被修复，故自带缺号框做 R1）
  const now = Date.now();
  db.ledger = db.ledger || [];
  db.seenIn = db.seenIn || {};
  db.mitemDict = db.mitemDict || {};
  // R1：注入一个空件号框 TESTPN01（自带脏夹具），配 MES 会给 pn 的场景
  db.ledger.push({ c: 'TESTPN01', l: 'NB02-Z-00-1F', p: '', n: '缺号回写测试', q: 200, t: now, rec: now, by: admin.name });
  db.seenIn['TESTPN01'] = { by: admin.name, t: now, l: 'NB02-Z-00-1F', p: '', q: 200, lot: '', pid: '' };
  // R2：造一个已有件号的框 TESTHASPN
  db.ledger.push({ c: 'TESTHASPN', l: 'NB02-Z-01-1F', p: '6600000001', n: '已有件号测试', q: 10, t: now, rec: now, by: admin.name });
  // R3：造一个空件号框 TESTMCUNIQ，字典里 mc=MCUNIQ 只对应一个件号
  db.ledger.push({ c: 'TESTMCUNIQ', l: 'NB02-Z-02-1F', p: '', n: '物料号唯一反查测试', q: 5, t: now, rec: now, by: admin.name });
  db.mitemDict['6600000099'] = { mc: 'MCUNIQ', src: 'test', at: now };
  // R4：造一个空件号框 TESTMCAMBIG，字典里 mc=MCAMBIG 对应两个件号（多义）
  db.ledger.push({ c: 'TESTMCAMBIG', l: 'NB02-Z-03-1F', p: '', n: '物料号多义测试', q: 5, t: now, rec: now, by: admin.name });
  db.mitemDict['6600000100'] = { mc: 'MCAMBIG', src: 'test', at: now };
  db.mitemDict['6600000101'] = { mc: 'MCAMBIG', src: 'test', at: now };
  const rev0 = db.ledgerRev || 0;
  fs.writeFileSync(path.join(TMP, 'db.json'), JSON.stringify(db));

  const child = spawn(process.execPath, [SRV], { env: Object.assign({}, process.env, { DATA_DIR: TMP, PORT: String(PORT) }), stdio: ['ignore', 'pipe', 'pipe'] });
  let srvLog = '';
  child.stdout.on('data', (d) => { srvLog += d; }); child.stderr.on('data', (d) => { srvLog += d; });
  const cleanup = () => { try { child.kill('SIGKILL'); } catch (_) {} };
  process.on('exit', cleanup);
  let up = false;
  for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 1000)); try { const h = await req('GET', '/api/health', null, null, 5000); if (h.j && h.j.ok) { up = true; break; } } catch (_) {} }
  T('H0 隔离服务器就绪', up, true);
  if (!up) { console.log(srvLog.slice(0, 2000)); process.exit(1); }
  const readDb = () => JSON.parse(fs.readFileSync(path.join(TMP, 'db.json'), 'utf8'));

  // 上收：R1 带 pn（模拟 MES 反查成功），R2 带 pn 但框已有号，R3 只带 mc 不带 pn（走字典唯一兜底），R4 只带多义 mc
  const res = await req('POST', '/api/mitem/batch', TOKEN, { items: [
    { c: 'TESTPN01', pn: '6608625843', mc: '162010000787' }, // R1 缺号框（MES 给 pn）
    { c: 'TESTHASPN', pn: '6600000002', mc: 'MCHAS' }, // R2 已有件号，pn 不同 → 应不动
    { c: 'TESTMCUNIQ', pn: '', mc: 'MCUNIQ' }, // R3 MES 没给 pn，mc 字典唯一 → 兜底回写 6600000099
    { c: 'TESTMCAMBIG', pn: '', mc: 'MCAMBIG' }, // R4 mc 多义 → 放弃
  ] });
  T('A1 上收成功', res.j.ok === true, true);
  T('A2 回写计数=2（R1直给+R3兜底，R2已有不动R4多义不猜）', res.j.pnFix, 2);
  await new Promise((r) => setTimeout(r, 1200));
  const d = readDb();
  const led = {}; for (const x of d.ledger) led[String(x.c).toUpperCase()] = x;
  T('R1 缺号框已回写 6608625843', led['TESTPN01'] && led['TESTPN01'].p, '6608625843');
  T('R1 seenIn 同步', d.seenIn['TESTPN01'] && d.seenIn['TESTPN01'].p, '6608625843');
  T('R2 已有件号框不被覆盖', led['TESTHASPN'].p, '6600000001');
  T('R3 物料号唯一兜底回写', led['TESTMCUNIQ'].p, '6600000099');
  T('R4 物料号多义不猜（仍空）', led['TESTMCAMBIG'].p, '');
  T('A3 ledgerRev 递增', (d.ledgerRev || 0) > rev0, true);
  const fx = (d.ledgerFixes || []).filter((x) => x.act === '补零件号' && ['TESTPN01', 'TESTMCUNIQ'].includes(String(x.code)));
  T('A4 审计留痕2条补零件号', fx.length, 2);
  T('A5 审计含操作人与原因', fx[0] && fx[0].by === admin.name && /物料号补录联动/.test(fx[0].reason), true);
  // A6 幂等：再上收一次同样数据，pnFix 应为 0（已有件号不动）
  const res2 = await req('POST', '/api/mitem/batch', TOKEN, { items: [{ c: 'TESTPN01', pn: '6608625843', mc: '162010000787' }] });
  T('A6 幂等：重复上收不再回写', res2.j.pnFix, 0);

  console.log('\n===== 零件号回写验证 ' + (total - fail) + '/' + total + ' 通过 =====');
  if (fail) { console.log('--- 服务器日志尾部 ---'); console.log(srvLog.slice(-1500)); }
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FATAL ' + e.message); try { child.kill('SIGKILL'); } catch (_) {} process.exit(2); });
