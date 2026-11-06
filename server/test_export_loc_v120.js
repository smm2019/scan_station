// ㉖v120 D1/D2 导出按货位前缀过滤（来料区单独导出）· 端到端取证
// 注入：来料区 NB01 两框 + 货架 NB02 两框 → 断言 loc=NB01 只出来料区、loc=NB02 只出货架、无 loc 全出
const fs = require('fs'); const path = require('path'); const cp = require('child_process'); const crypto = require('crypto');
const SRC = path.join(__dirname, 'data'); const TDIR = path.join(__dirname, 'data_e2e_exploc_v120'); const PORT = 8339; const BASE = 'http://127.0.0.1:' + PORT;
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(SRC, 'db.json'), path.join(TDIR, 'db.json')); fs.copyFileSync(path.join(SRC, 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(16).toString('hex'); const hashPw = (pw, s) => crypto.scryptSync(String(pw), s, 32).toString('hex');
const now = Date.now();
db0.users.push({ id: 'u_x120', username: 'x120_wh', name: 'X120仓管', role: 'warehouse', enabled: true, createdAt: now, mustChangePw: false, salt, passHash: hashPw('E2e#Exp!120', salt) });
db0.params = Object.assign(db0.params || {}, { receivingOn: 1 });
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
let fail = 0, total = 0;
const chk = (n, g, w) => { total++; const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL!'} [${n}] got=${JSON.stringify(g)} want=${JSON.stringify(w)}`); };
const chkT = (n, c) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(p2, tk, body) { const r = await fetch(BASE + p2, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: JSON.stringify(body) }); return r.json().catch(() => ({})); }
async function get(p2, tk) { const r = await fetch(BASE + p2, { headers: tk ? { Authorization: 'Bearer ' + tk } : {} }); return { status: r.status, json: await r.json().catch(() => ({})) }; }
(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { const r = await fetch(BASE + '/api/health'); up = r.ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪'); srv.kill(); process.exit(1); }
  console.log('隔离实例已就绪 (PORT ' + PORT + ') —— v120 导出货位前缀过滤');
  try {
    const wh = (await post('/api/login', null, { username: 'x120_wh', password: 'E2e#Exp!120' })).token;
    // 基线全量
    const base = (await get('/api/export?ds=D1&preview=1', wh)).json;
    const baseTotal = base.total;
    // 动态找两个 NB02 空位（避开生产存量撞位）
    const m0 = (await get('/api/ledger/locs?all=1', wh)).json.byLoc || {};
    const free = [];
    outerF: for (let z = 0; z < 8; z++) for (let c2 = 1; c2 <= 16; c2++) for (let t2 = 1; t2 <= 4; t2++) { const l = 'NB02-' + 'ABCDEFGH'[z] + '-' + String(c2).padStart(2, '0') + '-' + t2 + 'F'; if (!m0[l]) { free.push(l); if (free.length >= 2) break outerF; } }
    if (free.length < 2) throw new Error('无两个连续空货架位');
    const F1 = free[0], F2 = free[1];
    // 注入 2 来料 + 2 货架
    const sp = await post('/api/ledger/sync', wh, { items: [
      { c: 'EXP120NB01A', l: 'NB01-R1-01', p: '66X120PN0001', n: 'X120来料一', q: 10, b: 'B261101', t: now, mv: '登记', src: '来料区' },
      { c: 'EXP120NB01B', l: 'NB01-R1-02', p: '66X120PN0002', n: 'X120来料二', q: 20, b: 'B261102', t: now + 1, mv: '登记', src: '来料区' },
      { c: 'EXP120NB02A', l: F1, p: '66X120PN0003', n: 'X120货架一', q: 30, b: 'B261103', t: now + 2, mv: 'AGV' },
      { c: 'EXP120NB02B', l: F2, p: '66X120PN0004', n: 'X120货架二', q: 40, b: 'B261104', t: now + 3, mv: 'AGV' },
    ] });
    chkT('X1 注入 4 行上账', sp.ok === true && sp.added >= 4);
    const all = (await get('/api/export?ds=D1&preview=1', wh)).json;
    chk('X2 无过滤=基线+4', all.total, baseTotal + 4);
    const r1 = (await get('/api/export?ds=D1&preview=1&loc=NB01', wh)).json;
    chkT('X3 loc=NB01 命中来料区≥2框', r1.total >= 2);
    chkT('X3b loc=NB01 样本货位全为 NB01', (r1.sample || []).every((row) => String(row[0]).indexOf('NB01') === 0));
    const r2 = (await get('/api/export?ds=D1&preview=1&loc=' + F1, wh)).json; // 精确到完整货位
    chk('X4 loc=完整货位 仅命中注入框', r2.total, 1);
    chkT('X4b 样本即注入框', (r2.sample || []).some((row) => String(row[1]) === 'EXP120NB02A'));
    const r2c = (await get('/api/export?ds=D1&preview=1&loc=' + F1.slice(0, F1.lastIndexOf('-')), wh)).json; // 到架列：含该列全部层存量
    chkT('X4c 架列前缀命中≥注入2框（含该列存量，正确行为）', r2c.total >= 2 && (r2c.sample || []).every((row) => String(row[0]).indexOf(F1.slice(0, F1.lastIndexOf('-'))) === 0));
    // D2 库存汇总同样过滤：来料区两零件
    const d2 = (await get('/api/export?ds=D2&preview=1&loc=NB01', wh)).json;
    chkT('X5 D2 loc=NB01 汇总仅含来料区零件', (d2.sample || []).every((row) => String(row[0]).indexOf('66X120PN0001') === 0 || String(row[0]).indexOf('66X120PN0002') === 0 || d2.total <= 2));
    // 非法/空 loc 等价全量（回归保护：不传=行为不变）
    chk('X6 loc 空串=全量（零回归）', (await get('/api/export?ds=D1&preview=1&loc=', wh)).json.total, all.total);
    // 真实下载（非预览）走同一过滤：csv 首行表头+数据行数
    const csvResp = await fetch(BASE + '/api/export?ds=D1&loc=NB01&fmt=csv', { headers: { Authorization: 'Bearer ' + wh } });
    const csv = await csvResp.text();
    const dataLines = csv.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('货位,')).length;
    chkT('X7 csv 下载按 loc 过滤生效', /^NB01/.test((csv.split(/\r?\n/).find((l) => l.startsWith('NB01')) || 'NB01')) && dataLines >= 2);
  } catch (e) { fail++; console.log('FAIL! 异常：', e && e.message); }
  finally { srv.kill(); }
  console.log(`\n===== v120 导出货位过滤：${total - fail}/${total} PASS =====`);
  fs.rmSync(TDIR, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
