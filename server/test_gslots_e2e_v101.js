// ㉖v101 地面格数修复 · 端到端取证（真实 HTTP 打隔离实例）
// 覆盖：①启动迁移 gsCleanV101 只删=默认冗余、保留真实覆盖（现网3条）②幂等二次启动静默
// ③GET 返回 App 需要的 def/rows/lists/offs 完整契约 ④POST count=0=删除该排覆盖恢复默认
const fs = require('fs'), path = require('path'), cp = require('child_process');
const PORT = 8327, BASE = `http://127.0.0.1:${PORT}`;
const TDIR = path.join(__dirname, 'data_gslots_e2e');
let fail = 0, total = 0;
function chk(name, got, want) { total++; const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `\n  got=${JSON.stringify(got)}\n want=${JSON.stringify(want)}`}`); return ok; }
function sha(s) { return require('crypto').createHash('sha256').update(s).digest('hex'); }
async function req(method, p, { body, tok } = {}) {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await r.json(); } catch (_) {}
  return { status: r.status, j };
}
function waitReady(tok) { const t0 = Date.now(); return new Promise((res, rej) => { const iv = setInterval(async () => { try { const s = await req('GET', '/api/health', { tok }); if (s.status) { clearInterval(iv); res(); } } catch (_) { if (Date.now() - t0 > 30000) { clearInterval(iv); rej(new Error('启动超时')); } } }, 400); }); }
function startSrv() { const sv = cp.spawn('node', [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] }); let out = ''; sv.stdout.on('data', (b) => { out += b; }); sv.stderr.on('data', (b) => { out += b; }); sv.__out = () => out; return sv; }
(async () => {
  fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/db.json'), 'utf8'));
  const realBefore = Object.entries(d.groundSlots || {}).filter(([, v]) => Number(v) !== 12);
  const badBefore = Object.entries(d.groundSlots || {}).filter(([, v]) => Number(v) === 12).length;
  console.log(`副本 groundSlots：${Object.keys(d.groundSlots || {}).length} 条（冗余=12 共 ${badBefore} 条，真实覆盖 ${realBefore.length} 条：${realBefore.map(([k, v]) => k + '=' + v).join(', ')}）`);
  d.users = d.users || [];
  const salt = require('crypto').randomBytes(16).toString('hex');
  d.users.push({ id: 'gs-u1', name: '仓管测试', username: 'gs_wh', role: 'warehouse', enabled: true, createdAt: Date.now(), mustChangePw: false, salt, passHash: require('crypto').scryptSync('Gs#Pass1', salt, 32).toString('hex') });
  delete d.gscCleanedV101; // 副本清开关：主库被正式服务清理过后继承开关会让隔离实例短路（脚本必须真实重跑迁移）
  fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(d));
  for (const f of ['secret.key']) { const src = path.join(__dirname, 'data', f); if (fs.existsSync(src)) fs.copyFileSync(src, path.join(TDIR, f)); }
  let sv = startSrv(); await waitReady();
  let out1 = sv.__out();
  console.log('\n=== A. 启动迁移 gsCleanV101 ===');
  const dd1 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
  const gs1 = dd1.groundSlots || {};
  chk('A1 冗余=12全删（副本现况）', Object.values(gs1).filter((v) => Number(v) === 12).length, 0);
  chk('A2 真实覆盖保留=3条', Object.keys(gs1).length, realBefore.length);
  for (const [k, v] of realBefore) chk(`A2b ${k} 值原样=${v}`, gs1[k], v);
  chk('A3 幂等开关落库', dd1.gscCleanedV101, 1);
  chk('A4 启动日志留痕（主库已清理时条数0不打日志=两态兼容）', badBefore > 0 ? out1.includes('[gnd-slots] v101 清理冗余格数覆盖') : !out1.includes('[gnd-slots] v101'), true);
  const L = (out1.match(/\[gnd-slots\][^\n]*/) || [''])[0]; console.log('  实证：', L.trim() || '(无冗余可清理)');
  chk('A5 日志数字=删除条数', badBefore > 0 ? L.includes(badBefore + ' 条') : true, true);
  const lk = await req('POST', '/api/login', { body: { username: 'gs_wh', password: 'Gs#Pass1' } });
  chk('L0 登录', lk.j.ok, true); const tok = lk.j.token;
  console.log('\n=== B. GET 契约（App 清单数据源）===');
  const g = await req('GET', '/api/ground-slots', { tok });
  chk('B1 def 含 cols/rows/zones', [g.j.def && typeof g.j.def.cols, g.j.def && typeof g.j.def.rows], ['number', 'number']);
  chk('B2 def.cols=12', g.j.def.cols, 12);
  chk('B3 slots 只剩真实覆盖', Object.keys(g.j.slots || {}).length, realBefore.length);
  chk('B4 rows/offs/lists 字段齐', [typeof g.j.rows, typeof g.j.offs, typeof g.j.lists], ['object', 'object', 'object']);
  const g0 = await req('GET', '/api/ground-slots');
  chk('B5 未登录拒读', [g0.status === 401 || g0.status === 403, g0.j.ok === false], [true, true]);
  console.log('\n=== C. POST count=0=恢复默认（App diff提交依赖语义）===');
  const c1 = await req('POST', '/api/ground-slots', { tok, body: { entries: [{ prefix: 'NB03-F-05', count: 14 }, { prefix: 'NB03-F-06', count: 13 }] } });
  chk('C1 新配置两排成功', c1.j.ok, true);
  let g2 = await req('GET', '/api/ground-slots', { tok });
  chk('C2 F-05=14 生效', g2.j.slots['NB03-F-05'], 14);
  const c3 = await req('POST', '/api/ground-slots', { tok, body: { entries: [{ prefix: 'NB03-F-05', count: 0 }, { prefix: 'NB03-H-99', count: 99 }, { prefix: 'NB03-X-X', count: 5 }] } });
  chk('C3 提交成功', c3.j.ok, true);
  g2 = await req('GET', '/api/ground-slots', { tok });
  chk('C4 count=0 → 删除恢复默认', g2.j.slots['NB03-F-05'], undefined);
  chk('C5 越界99=同删除（1~60外恢复默认）', g2.j.slots['NB03-H-99'], undefined);
  chk('C6 非法前缀不入库', g2.j.slots['NB03-X-X'], undefined);
  chk('C7 F-06=13 未被误动', g2.j.slots['NB03-F-06'], 13);
  chk('C8 原真实覆盖 B-18=13 仍在', g2.j.slots['NB03-B-18'], 13);
  console.log('\n=== D. 幂等：二次启动不重复清理 ===');
  await new Promise((r) => setTimeout(r, 400)); // save()为120ms防抖合写：等待落盘后再kill，防丢C轮配置（脚本时序，非产品缺陷）
  sv.kill(); await new Promise((r) => setTimeout(r, 600));
  sv = startSrv(); await waitReady();
  const out2 = sv.__out();
  chk('D1 二次启动无清理日志（开关短路）', out2.includes('[gnd-slots] v101'), false);
  const dd3 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
  chk('D2 C轮新配置不受迁移影响', dd3.groundSlots['NB03-F-06'], 13);
  sv.kill(); fs.rmSync(TDIR, { recursive: true, force: true });
  console.log(`\n===== 端到端取证：${fail === 0 ? '全部 PASS' : fail + ' 项失败'}，合计 ${total} 项断言 =====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('脚本异常：', e.message); try { fs.rmSync(TDIR, { recursive: true, force: true }); } catch (_) {} process.exit(2); });
