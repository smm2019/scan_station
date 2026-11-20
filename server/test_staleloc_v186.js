// ㉖v186 旧骨架改位硬闸 · 事故复刻端到端证明
// 原型事故（11-15 实锤 N26J220047）：宋明明 08:51 正确改位 16-01 → 刘向轩设备 09:08 重推 10/31
// 骨架行（派生字段漂移躲过指纹闸）把位置覆盖回 16-05。v186 判据=【行 t 比服务器现值旧】∧【货位与现值不同】。
// ★为什么必须真跑：闸门在 ledgerSync 深部分支链（墓碑/指纹/v97c/v118 四道闸之后），静态只能证明代码在；
//   误伤面（v95c 字段修正、合法改位、首推回退）只有真实双设备时序才能证明零破坏。
// 夹具：隔离副本；两 warehouse 用户模拟两台设备；T1=13天前(骨架) T2=1小时前(正确登记)。
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const TDIR = path.join(__dirname, '_staleloc_v186');
const PORT = Number(process.env.SL_PORT || (8400 + Math.floor(Math.random() * 500))); // 随机段防僵尸占口（v185 复盘同款）
const BASE = 'http://127.0.0.1:' + PORT;
if (fs.existsSync(TDIR)) fs.rmSync(TDIR, { recursive: true, force: true });
fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), path.join(TDIR, 'db.json'));
const sk = path.join(__dirname, 'data', 'secret.key');
if (fs.existsSync(sk)) fs.copyFileSync(sk, path.join(TDIR, 'secret.key'));

const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const U = (s) => String(s == null ? '' : s).toUpperCase();
const salt = crypto.randomBytes(16).toString('hex');
const hp = (p, s) => crypto.scryptSync(String(p), s, 32).toString('hex');
const PW = 'Stale#Loc186';
for (const [id, un, nm] of [['u_sl_sm', 'sl_sm', '宋明明夹具'], ['u_sl_lx', 'sl_lx', '刘向轩夹具'], ['u_sl_x', 'sl_x', '陌生设备夹具']]) {
  db0.users.push({ id, username: un, name: nm, role: 'warehouse', enabled: true, createdAt: Date.now(), mustChangePw: false, salt, passHash: hp(PW, salt) });
}
db0.params = Object.assign(db0.params || {}, { receivingOn: 1, reqHoursOn: 0 });
// 测试码清场（主码+兄弟码+对照码），并记录生产 epoch 供推送带世代（防 v69 旧世代切割误伤夹具）
const C42 = 'N26SL186042', C47 = 'N26SL186047', C49 = 'N26SL186049';
const delBefore = (x) => [C42, C47, C49].includes(U(x.c));
// 测试格位清场（首轮失败根因=夹具失真）：E-16-05/01/06 三格在生产库里被真框（N26J220047/44 等）
// 占用，骨架行全被"货位互斥闸"拦死、目标闸根本没被触到——占用行一并清空，格位必须空闲
const TEST_LOCS = new Set(['NB03-E-16-05', 'NB03-E-16-01', 'NB03-E-16-06']);
db0.ledger = (db0.ledger || []).filter((x) => !delBefore(x) && !TEST_LOCS.has(U(x.l)));
if (db0.locReserve) for (const k of Object.keys(db0.locReserve)) { if (TEST_LOCS.has(U(k))) delete db0.locReserve[k]; }
db0.ledgerTomb = (db0.ledgerTomb || []).filter((x) => !delBefore(x));
db0.scanlog = Object.fromEntries(Object.entries(db0.scanlog || {}).filter(([, s]) => !delBefore(s)));
const EPOCH = String(db0.ledgerEpoch || '');
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));

const NOW = Date.now();
const T1 = NOW - 13 * 864e5; // 骨架登记时刻（事故里的 10/31）
const T2 = NOW - 3600e3; // 正确改位时刻（事故里的 08:51）
const LOC05 = 'NB03-E-16-05', LOC01 = 'NB03-E-16-01', LOC06 = 'NB03-E-16-06';
const PID = 'TPL1860000001';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + i + ']' : ''}`); };
const post = async (p2, tk, body) => { const r = await fetch(BASE + p2, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: JSON.stringify(body || {}) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
const getj = async (p2, tk) => { const r = await fetch(BASE + p2, { headers: tk ? { Authorization: 'Bearer ' + tk } : {} }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
const skelRow = (c, l, extra) => Object.assign({ c, l, t: T1, f: '塑料筐', pid: PID, mv: '人工', src: LOC05, b: '2026-10-22', p: '8894086418', n: '骨架对照件', q: 1000 }, extra || {});

(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { SELFTEST_NO_LIVE: '1', ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health')).ok; } catch (_) {} }
  if (!up) { console.log('❌ 实例未就绪'); srv.kill(); process.exit(1); }
  let out = ''; srv.stdout.on('data', (d) => { out += d; }); srv.stderr.on('data', (d) => { out += d; });
  try {
    const tkSM = (await post('/api/login', null, { username: 'sl_sm', password: PW })).json.token;
    const tkLX = (await post('/api/login', null, { username: 'sl_lx', password: PW })).json.token;
    const tkX = (await post('/api/login', null, { username: 'sl_x', password: PW })).json.token;
    C('护栏 三设备登录（宋/刘/陌生）', !!tkSM && !!tkLX && !!tkX);

    // ── 第1步：设备B(刘) 首推两条骨架行（=事故里 10/31 登记，两码同托都在 16-05；C49 预置骨架供对照3）──
    const p1 = await post('/api/ledger/sync', tkLX, { epoch: EPOCH, items: [skelRow(C42, LOC05), skelRow(C47, LOC05), skelRow(C49, LOC05)] });
    C('步骤1 设备B骨架行建立（3 条上账）', p1.json.ok === true && (p1.json.added || 0) >= 3, `added=${p1.json.added}`);

    // ── 第2步：设备A(宋) 重新采集正确改位：47→16-01（t=T2 新），42 原位重登 16-05 ──
    const p2 = await post('/api/ledger/sync', tkSM, { epoch: EPOCH, items: [skelRow(C42, LOC05, { t: T2 }), skelRow(C47, LOC01, { t: T2 }), skelRow(C49, LOC06, { t: T2 })] });
    C('步骤2 设备A正确改位上账（无拒回）', p2.json.ok === true && !((p2.json.rejected || []).length), JSON.stringify((p2.json.rejected || []).slice(0, 2)));
    let g = await getj('/api/ledger', tkSM);
    let m = Object.fromEntries((g.json.items || []).filter((x) => [C42, C47].includes(U(x.c))).map((x) => [U(x.c), x]));
    C('★★★ 改位后账本 47=16-01 且登记人=宋明明', m[C47] && m[C47].l === LOC01 && m[C47].by === '宋明明夹具', m[C47] && `${m[C47].l}/${m[C47].by}`);

    // ── 第3步（事故复刻核心）：设备B 重推 10/31 骨架（同 t=T1、47 位置回 16-05）。
    // n 字段带派生漂移：真实事故里 mv归一/批次打印日期重算使内容≠10/31旧指纹，指纹静默闸(4033)脱靶、
    // v97c 又只防"从未推过该行的设备"——这才是旧骨架能冲到服务器的真实形态 ──
    const p3 = await post('/api/ledger/sync', tkLX, { epoch: EPOCH, items: [skelRow(C42, LOC05, { n: '骨架漂移件' }), skelRow(C47, LOC05, { n: '骨架漂移件' })] });
    const rej3 = (p3.json.rejected || []).join(' | ');
    C('★★★ 设备B旧骨架改位 47 被拒（点名"旧缓存改位不生效"）', rej3.includes(C47) && /旧缓存改位不生效/.test(rej3), rej3.slice(0, 120));
    g = await getj('/api/ledger', tkSM);
    m = Object.fromEntries((g.json.items || []).filter((x) => [C42, C47].includes(U(x.c))).map((x) => [U(x.c), x]));
    C('★★★ 数据安全：被拒不改现值——47 仍 16-01 宋明明，t 仍为 T2', m[C47] && m[C47].l === LOC01 && m[C47].by === '宋明明夹具' && Number(m[C47].t) === T2, m[C47] && `${m[C47].l}/${m[C47].by}/t=${Number(m[C47].t) === T2}`);

    // ── 第4步：设备B 再推同样骨架（同内容）→ 命中本轮指纹静默，不二次弹窗 ──
    const p4 = await post('/api/ledger/sync', tkLX, { epoch: EPOCH, items: [skelRow(C42, LOC05), skelRow(C47, LOC05)] });
    C('★★ 二推同骨架静默（不再点名 47，防弹窗循环）', p4.json.ok === true && !(String((p4.json.rejected || []).join()).includes(C47)), String((p4.json.rejected || []).join()).slice(0, 80));

    // ── 第5步：设备B 用旧时刻墓碑删 47 → 服务器必须保住正确行（数据安全第二层）──
    const p5 = await post('/api/ledger/sync', tkLX, { epoch: EPOCH, items: [], del: [{ c: C47, t: T1 }] });
    g = await getj('/api/ledger', tkSM);
    const still = (g.json.items || []).some((x) => U(x.c) === C47 && x.l === LOC01);
    C('★★★ 旧时刻墓碑删不掉被更新过的正确行（delSkipped）', still === true, `delApplied=${p5.json.delApplied} delSkipped=${p5.json.delSkipped} 47仍在=${still}`);

    // ── 对照组1：v95c 字段修正（同 t、同位、补 f/n）→ 必须照常合并不误拒 ──
    const p6 = await post('/api/ledger/sync', tkSM, { epoch: EPOCH, items: [skelRow(C47, LOC01, { t: T2, f: '纸箱', n: '字段修正是合法合并' })] });
    g = await getj('/api/ledger', tkSM);
    const r6 = (g.json.items || []).find((x) => U(x.c) === C47);
    C('★ 对照1 v95c 字段修正（t不变l不变）照常合并，f=纸箱', !(p6.json.rejected || []).length && r6 && r6.f === '纸箱' && r6.n === '字段修正是合法合并', r6 && r6.f + '/' + String((p6.json.rejected || []).length));

    // ── 对照组2：合法改位（新 t）→ 照常生效 ──
    const p7 = await post('/api/ledger/sync', tkSM, { epoch: EPOCH, items: [skelRow(C42, LOC06, { t: NOW - 60000 })] });
    g = await getj('/api/ledger', tkSM);
    const r7 = (g.json.items || []).find((x) => U(x.c) === C42);
    C('★ 对照2 新时刻改位 42→16-06 照常生效（闸不误伤合法改位）', !(p7.json.rejected || []).length && r7 && r7.l === LOC06, r7 && r7.l + '/' + String((p7.json.rejected || []).length));

    // ── 对照组3：陌生设备（无任何指纹档案）推"漂移骨架"（旧时刻+改位）。n 漂移防命中 4033 历史值
    // 静默（真实事故骨架同样因派生字段漂移脱靶静默闸，这才是真实到达形态）；4049 v97c 回退闸
    // 先于 v186 接住（该闸点名=裸 key），账本现值不动 ──
    const p8 = await post('/api/ledger/sync', tkX, { epoch: EPOCH, items: [skelRow(C49, LOC05, { t: T1, n: '骨架漂移件' })] });
    const rej8 = (p8.json.rejected || []).filter((s) => String(s).includes(C49));
    const r8 = ((await getj('/api/ledger', tkSM)).json.items || []).find((x) => U(x.c) === C49);
    C('★ 对照3 无档案设备旧时刻漂移改位被 v97c 接住且现值不动（49 仍 16-06）', rej8.length === 1 && r8 && r8.l === LOC06, rej8.join('|').slice(0, 90) + ' | ' + (r8 && r8.l));

    C('★ 进程存活无异常', (await fetch(BASE + '/api/health')).ok === true && !/Unhandled|TypeError/.test(out), out.split('\n').slice(-3).join(' ').slice(0, 90));
  } catch (e) {
    total++; fail++; console.log('❌ 异常：' + e.message + '\n' + String(out).split('\n').slice(-10).join('\n'));
  } finally {
    srv.kill(); await sleep(400);
    try { fs.rmSync(TDIR, { recursive: true, force: true }); } catch (_) {}
  }
  console.log('\n结果: ' + (total - fail) + ' 通过 / ' + fail + ' 失败  （隔离副本，生产库零写入）');
  process.exit(fail ? 1 : 0);
})();
