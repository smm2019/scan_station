// ㉖v150 概览两楼拆分 KPI：一楼来料登记(标签) + 待入库(来料区) · 实例证明
// 用户提议：概览"入库标签"现只认二楼上架扫码，应补一楼扫码后的"待入库"计数。
// 查实现发现更基础的问题：inToday 未按货位分层——一楼登记与二楼上架混计在"今日入库(标签)"里。
// 落地：kpi 新增 recvToday（今日最新一行货位=NB04 的标签数）+ pendRecv（当前账本仍停 NB04 的标签数，跨日积压口径）。
// 证明面：A 服务器接口真实返回两字段且口径正确；B 网页 KARR/K 白名单锚点；C 口径手工复算比对。
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const TDIR = path.join(__dirname, '_tdata_recv150');
let total = 0, fail = 0;
const chk = (name, got, want) => { total++; const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) { fail++; console.log(`FAIL! [${name}] got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); } else console.log(`PASS [${name}]`); };
const chkT = (name, cond, extra) => { total++; if (!cond) { fail++; console.log(`FAIL! [${name}] ${extra || ''}`); } else console.log(`PASS [${name}]`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');
const dayMs = 86400000;

async function main() {
  fs.rmSync(TDIR, { recursive: true, force: true });
  fs.mkdirSync(TDIR, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'data/db.json'), path.join(TDIR, 'db.json'));
  fs.copyFileSync(path.join(__dirname, 'data/secret.key'), path.join(TDIR, 'secret.key'));
  const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
  db0.users = db0.users || [];
  const salt = crypto.randomBytes(8).toString('hex');
  db0.users.push({ username: 'u_wh', id: 'u_wh', name: '仓管甲', role: 'warehouse', enabled: true, salt, passHash: hashPw('pw123', salt) });
  // 夹具：今日一楼登记3标签（其中2个仍停NB04=待入库，1个已转二楼），今日二楼直接上架1标签，昨日一楼登记1个仍在NB04（跨日积压）
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const t0 = today.getTime();
  db0.scanlog = db0.scanlog || {};
  db0.scanlog['T_A1'] = { code: 'NTEST0001', t: t0 + 3600000, q: 10, wt: 2, gl: 'NB04-A-01-001', op: '一楼员' };
  db0.scanlog['T_A1b'] = { code: 'NTEST0001', t: t0 + 7200000, q: 10, wt: 0, st: 'NB02-A-05-01', op: '二楼员' }; // 同标签后转二楼→最新行非NB04
  db0.scanlog['T_B1'] = { code: 'NTEST0002', t: t0 + 3600000, q: 20, wt: 2, gl: 'NB04-A-01-002', op: '一楼员' }; // 仍停一楼
  db0.scanlog['T_C1'] = { code: 'NTEST0003', t: t0 + 3600000, q: 30, wt: 2, gl: 'NB04-A-01-003', op: '一楼员' }; // 仍停一楼
  db0.scanlog['T_D1'] = { code: 'NTEST0004', t: t0 + 3600000, q: 40, wt: 0, st: 'NB02-B-06-02', op: '二楼员' }; // 今日直接二楼上架
  db0.scanlog['T_E1'] = { code: 'NTEST0005', t: t0 - dayMs + 3600000, q: 50, wt: 2, gl: 'NB04-A-01-004', op: '一楼员' }; // 昨日一楼登记
  db0.ledger = (db0.ledger || []).filter((x) => !String(x.c || '').startsWith('NTEST'));
  db0.ledger.push({ c: 'NTEST0002', l: 'NB04-A-01-002', p: 'P1', q: 20, t: t0 + 3600000 });
  db0.ledger.push({ c: 'NTEST0003', l: 'NB04-A-01-003', p: 'P2', q: 30, t: t0 + 3600000 });
  db0.ledger.push({ c: 'NTEST0005', l: 'NB04-A-01-004', p: 'P3', q: 50, t: t0 - dayMs + 3600000 });
  db0.ledger.push({ c: 'NTEST0001', l: 'NB02-A-05-01', p: 'P0', q: 10, t: t0 + 7200000 });
  db0.ledger.push({ c: 'NTEST0004', l: 'NB02-B-06-02', p: 'P4', q: 40, t: t0 + 3600000 });
  fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
  const PORT = 8171;
  const proc = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: Object.assign({}, process.env, { PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }), stdio: ['ignore', 'pipe', 'pipe'] });
  await sleep(1500);
  const api = async (u, p, opt) => { const r = await fetch('http://127.0.0.1:' + PORT + u, Object.assign({ headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (opt && opt.tk || '') } }, opt || {})); return r.json(); };
  const lg = await api('/api/login', null, { method: 'POST', body: JSON.stringify({ username: 'u_wh', password: 'pw123' }) });
  const TK = lg.token;
  const dash = await api('/api/dashboard', null, { tk: TK });
  const k = (dash.kpi || {});
  console.log('== A组 dashboard 接口两字段 ==');
  chkT('A0 接口调用成功', dash.ok === true, JSON.stringify(dash).slice(0, 120));
  chk('A1 recvToday=3（A1,B1,C1 今日一楼扫过，含已转二楼的A1）', k.recvToday, 3);
  chk('A2 pendRecv 当前停NB04标签=3（B1,C1,昨日E1跨日积压）', k.pendRecv, 3);
  // 手工复算二楼上架口径（夹具继承生产库，不能断言绝对值）：今日有非NB04行的标签
  const _up = new Set();
  for (const s of Object.values(db0.scanlog)) { if (s.cx || !s.t || s.t < t0 || !s.code) continue; if (!/^NB04-/.test(String((s.st || s.gl) || '').toUpperCase())) _up.add(s.code); }
  chk('A3 inBoxes 今日入库=二楼上架口径（含生产存量）', k.inBoxes, _up.size);
  console.log('== B组 网页锚点 ==');
  const html = fs.readFileSync(path.join(__dirname, 'public', 'console.html'), 'utf8');
  chkT('B1 KARR 含一楼来料登记卡', html.includes("['一楼来料登记(标签)',k.recvToday||0"), '');
  chkT('B2 KARR 含待入库卡且非0橙色', html.includes("['待入库(来料区)',k.pendRecv||0,(k.pendRecv||0)?'var(--warn)'"), '');
  chkT('B3 K 白名单注册两新名', html.includes("'一楼来料登记(标签)','待入库(来料区)'"), '');
  chkT('B4 来料登记卡下钻预填 NB04 过滤流水', html.includes("['一楼来料登记(标签)',k.recvToday||0,'',\"go('flow');TF={k:'in',d:todayStr(),q:'NB04'};pgFlow()\""), '');
  chkT('B5 待入库卡下钻账本预填 NB04', html.includes("TM.lq='NB04';go('ledger')"), '');
  chkT('B6 流水搜索字段含货位 loc', /String\(x\.loc\|\|''\)\.toUpperCase\(\)\.includes\(k\)/.test(html), '');
  console.log('== C组 口径手工复算 ==');
  // 复算：今日一楼扫过的标签集合（含已转二楼）
  const _rc = new Set();
  for (const s of Object.values(db0.scanlog)) { if (s.cx || !s.t || s.t < t0 || !s.code) continue; if (/^NB04-/.test(String((s.st || s.gl) || '').toUpperCase())) _rc.add(s.code); }
  chk('C1 recvToday 与手工复算一致', k.recvToday, _rc.size);
  const pendCalc = new Set(db0.ledger.filter((x) => /^NB04-/.test(String(x.l || '').toUpperCase())).map((x) => String(x.c).toUpperCase())).size;
  chk('C2 pendRecv 与手工复算一致', k.pendRecv, pendCalc);
  proc.kill();
  await sleep(300);
  fs.rmSync(TDIR, { recursive: true, force: true });
  console.log(`\n===== v150 两楼KPI实例证明 ${total - fail}/${total} PASS =====`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.log(e.stack); process.exit(1); });
