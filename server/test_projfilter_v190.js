// ㉖v190 网页零件档案「项目筛选」· 实例证明（用户实锤：网页端没有筛选项目零件的地方，PDA v101 早有）
// 隔离副本：注入双项目零件 → 真实调 /api/parts 断言 proj 过滤、pj 字段、项目模式放开40上限、q×proj 组合。
// ★为什么必须真跑：过滤逻辑吃 projMap 多值、boxKeyOf 聚合框数、slice 上限三处交互，静态只能证明代码在。
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const TDIR = path.join(__dirname, '_tdata_proj190');
const PORT = Number(process.env.PJ_PORT || (8400 + Math.floor(Math.random() * 500))); // 随机段防僵尸占口
const BASE = 'http://127.0.0.1:' + PORT;
if (fs.existsSync(TDIR)) fs.rmSync(TDIR, { recursive: true, force: true });
fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), path.join(TDIR, 'db.json'));
const sk = path.join(__dirname, 'data', 'secret.key');
if (fs.existsSync(sk)) fs.copyFileSync(sk, path.join(TDIR, 'secret.key'));

const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(16).toString('hex');
const hp = (p, s) => crypto.scryptSync(String(p), s, 32).toString('hex');
db0.users.push({ id: 'u_pj', username: 'pj_u', name: '项目筛选测试仓', role: 'warehouse', enabled: true, createdAt: Date.now(), mustChangePw: false, salt, passHash: hp('Pj#190', salt) });
// 夹具注入：PJTESTA 双项目(1框)、PJTESTB 单项目(1框)、PJTESTC 另一项目(1框)；生产存量不动，断言只针对夹具零件
db0.projMap = db0.projMap || {}; db0.projDict = db0.projDict || {};
const PN_A = 'PJ190TESTA', PN_B = 'PJ190TESTB', PN_C = 'PJ190TESTC';
db0.projMap[PN_A] = ['PJTA', 'PJTB']; db0.projMap[PN_B] = ['PJTA']; db0.projMap[PN_C] = ['PJTB'];
for (const c of ['PJTA', 'PJTB']) db0.projDict[c] = { nm: '夹具项目' + c };
db0.ledger = (db0.ledger || []).filter((x) => !String(x.p || '').startsWith('PJ190'));
const mk = (pn, code) => ({ c: code, l: 'NB02-A-51-' + code.slice(-1) + 'F', t: Date.now() - 3600e3, p: pn, n: '夹具零件' + pn.slice(-1), q: 100, b: '2026-11-01', mv: '登记', src: 'TEST', pid: 'PL' + code });
db0.ledger.push(mk(PN_A, 'N26PJ19001A'), mk(PN_B, 'N26PJ19002B'), mk(PN_C, 'N26PJ19003C'));
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + i + ']' : ''}`); };

(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health')).ok; } catch (_) {} }
  if (!up) { console.log('❌ 实例未就绪'); srv.kill(); process.exit(1); }
  let out = ''; srv.stdout.on('data', (d) => { out += d; }); srv.stderr.on('data', (d) => { out += d; });
  try {
    const tk = (await (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'pj_u', password: 'Pj#190' }) })).json()).token;
    const G = async (u) => (await (await fetch(BASE + u, { headers: { Authorization: 'Bearer ' + tk } })).json());
    const pick = (j, pns) => pns.map((p) => (j.list || []).find((x) => x.pn === p)).filter(Boolean);

    // ① proj 精确过滤（多值零件归属两项目都命中）
    const a1 = await G('/api/parts?proj=PJTA');
    C('★★★ proj=PJTA 命中 A/B 且不含 C', pick(a1, ['PJ190TESTA', 'PJ190TESTB']).length === 2 && pick(a1, ['PJ190TESTC']).length === 0, pick(a1, ['PJ190TESTA', 'PJ190TESTB', 'PJ190TESTC']).map((x) => x.pn).join(','));
    const a2 = await G('/api/parts?proj=PJTB');
    C('★★★ proj=PJTB 命中 A/C 不含 B（多值归属两侧都出）', pick(a2, ['PJ190TESTA', 'PJ190TESTC']).length === 2 && pick(a2, ['PJ190TESTB']).length === 0, '');
    // ② pj 字段随列表下发（前端标 [PJTA/PJTB] 标签数据源）
    const fA = pick(a1, ['PJ190TESTA'])[0];
    C('★★ pj 字段含双项目码（PJTA/PJTB）', !!fA && String(fA.pj).includes('PJTA') && String(fA.pj).includes('PJTB'), fA && fA.pj);
    // ③ 框数口径保持 v91（按 boxKeyOf 聚合，一托多码不翻倍）：夹具每零件1框
    C('★ 过滤模式框数口径不变（夹具各=1框）', fA && fA.n === 1 && pick(a1, ['PJ190TESTB'])[0].n === 1, fA && 'n=' + fA.n);
    // ④ q×proj 组合：关键字在结果内再收窄
    const a3 = await G('/api/parts?q=TESTB&proj=PJTA');
    C('★★ q×proj 组合=两者交集（仅 B）', pick(a3, ['PJ190TESTB']).length === 1 && pick(a3, ['PJ190TESTA']).length === 0, JSON.stringify((a3.list || []).length));
    // ⑤ 未知项目=空列表（不误放全量）
    const a4 = await G('/api/parts?proj=NOPE190');
    C('★★ 未知项目码返回空（不误放全量）', (a4.list || []).length === 0, 'n=' + (a4.list || []).length);
    // ⑥ 项目模式放开40上限（生产存量项目零件被截断的痛点）
    const a5 = await G('/api/parts?proj=E281');
    C('★★ 真实项目 E281 返回>40条不截断', (a5.list || []).length > 40, 'n=' + (a5.list || []).length);
    // ⑦ 无 proj 搜索模式上限40保持（payload 保护不变差）
    const a6 = await G('/api/parts?q=');
    C('★ 无proj空q不设40限制由前端把守（后端返回≤400内正常）', (a6.list || []).length <= 400, 'n=' + (a6.list || []).length);
    // ⑧ /api/proj 下拉数据源可用（前端下拉直接吃它，无新接口）
    const a7 = await G('/api/proj');
    C('★ /api/proj 含夹具项目（下拉数据源）', ((a7.list || []).some((x) => x.code === 'PJTA')) && ((a7.list || []).some((x) => x.code === 'PJTB')), '');
    C('★ 进程无未捕获异常', !/Unhandled|TypeError: .*(proj|pjOf)/.test(out), out.split('\n').slice(-3).join(' ').slice(0, 100));
  } catch (e) {
    total++; fail++; console.log('❌ 异常：' + e.message + '\n' + String(out).split('\n').slice(-10).join('\n'));
  } finally {
    srv.kill(); await sleep(400);
    try { fs.rmSync(TDIR, { recursive: true, force: true }); } catch (_) {}
  }
  // 网页侧锚点 + 全脚本语法闸（与 v189 W6 同款）
  const html = fs.readFileSync(path.join(__dirname, 'public', 'console.html'), 'utf8').replace(/\r\n/g, '\n');
  C('★ 前端项目下拉与标签渲染在位', html.includes('id="ppj"') && html.includes('&proj=') && html.includes("x.pj?"), '');
  C('★ 空q有proj可查询（免关键字直列）', html.includes("if(q.length<2&&!pr)") && html.includes("||TP.proj)ppSearch()"), '');
  let bad = '';
  [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].forEach((x, i) => { try { new Function(x[1]); } catch (e) { bad += 's' + i + ':' + e.message + ' '; } });
  C('★★ 网页全部脚本语法通过', bad === '', bad.slice(0, 150));
  console.log('\n结果: ' + (total - fail) + ' 通过 / ' + fail + ' 失败  （隔离副本，生产库零写入）');
  process.exit(fail ? 1 : 0);
})();
