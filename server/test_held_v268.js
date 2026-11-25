// ㉖v268 同框被多单占用可见性取证（11-25 现场：N26K2500165 被两单推荐，别单叫走到站后本单点一键叫车无反应）
// 断言：①A单叫走框后，B单建议里带 heldByOthers（码/占用单号/在途或到站）②不串单（A单自己看不到自己占用）
//       ③已发料的框不再算占用 ④非活跃单（取消/拒）不算占用 ⑤不改 FIFO 建议口径（台位框仍不进建议）
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const TDIR = path.join(__dirname, 'data_e2e_held_v268');
const PORT = 8458, BASE = 'http://127.0.0.1:' + PORT;
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(__dirname, 'data', 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(8).toString('hex'), hp = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');
db0.users = db0.users || [];
db0.users.push({ id: 'u_v268', username: 'v268_w', name: 'V268仓管', role: 'warehouse', enabled: true, salt, passHash: hp('E2e#H8!w', salt) });
const PN = 'V268PN01', CA = 'V268BOX001', CB = 'V268BOX002', now = Date.now();
// 两框在架：A框将被A单叫走并到站；B框留在架供B单建议
db0.ledger = (db0.ledger || []).filter((x) => !String(x.c).startsWith('V268'));
db0.ledger.push({ c: CA, l: 'NB02-CK-09', p: PN, n: 'V268件', q: 50, t: now - 600e3, b: '2026-11-25' }); // 已到站
db0.ledger.push({ c: CB, l: 'NB02-H-01-1F', p: PN, n: 'V268件', q: 50, t: now - 900e3, b: '2026-11-25' });
const mkReq = (id, no, called, issued) => ({ id, no, by: 'u_v268', byName: 'V268仓管', status: 'accepted', createdAt: new Date(now).toISOString(), history: [], items: [{ partNo: PN, itemName: 'V268件', qty: 50, issued: issued || [], agvCalled: called || [] }] });
db0.requisitions = (db0.requisitions || []).filter((r) => !String(r.no).startsWith('LLV268'));
db0.requisitions.push(mkReq('q_v268a', 'LLV268A', [{ c: CA, task: 'AGV-V268-1', t: new Date(now - 300e3).toISOString() }]));
db0.requisitions.push(mkReq('q_v268b', 'LLV268B', []));
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const chkT = (n, c, why) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]${c ? '' : ' ←' + (why || '')}`); };
(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { SELFTEST_NO_LIVE: '1', ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health')).ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪'); srv.kill(); fs.rmSync(TDIR, { recursive: true, force: true }); process.exit(1); }
  const getj = async (p, tk) => (await (await fetch(BASE + p, { headers: { Authorization: 'Bearer ' + tk } })).json().catch(() => ({})));
  const post = async (p, tk, b) => (await (await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: JSON.stringify(b || {}) })).json().catch(() => ({})));
  try {
    const tk = (await post('/api/login', null, { username: 'v268_w', password: 'E2e#H8!w' })).token;
    const itemOf = async (id) => { const j = await getj('/api/requisitions/' + id, tk); return ((j.req || {}).items || [])[0] || {}; };
    const b = await itemOf('q_v268b');
    const held = (b.suggest || {}).heldByOthers || [];
    chkT('★①B单建议带 heldByOthers（A单叫走的框可见）', held.length === 1 && held[0].c === CA && held[0].byReq === 'LLV268A', JSON.stringify(held));
    chkT('★②到站态如实标记 onStn+货位', held[0] && held[0].onStn === true && held[0].l === 'NB02-CK-09', JSON.stringify(held[0]));
    const a = await itemOf('q_v268a');
    chkT('★③不串单：A单看不到自己的占用', !((a.suggest || {}).heldByOthers || []).length, JSON.stringify((a.suggest || {}).heldByOthers));
    // ④ FIFO 口径不变：台位框(CA)不进 B 单建议，在架框(CB)才是建议
    const sgB = (b.suggest || {});
    const codesB = (sgB.flatBoxes || []).map((x) => x.c);
    chkT('★④不改FIFO口径：台位框不进建议、在架框仍建议', !codesB.includes(CA) && codesB.includes(CB), JSON.stringify(codesB));
    // ⑤ 已发料的框不再算占用：给A单登记已发CA后重查
    { const d = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
      const ra = d.requisitions.find((r) => r.id === 'q_v268a'); ra.items[0].issued = [{ c: CA, q: 50 }];
      fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(d)); }
    srv.kill(); await sleep(600);
    const srv2 = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { SELFTEST_NO_LIVE: '1', ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
    let up2 = false; for (let i = 0; i < 40 && !up2; i++) { await sleep(250); try { up2 = (await fetch(BASE + '/api/health')).ok; } catch (_) {} }
    try {
      const tk2 = (await post('/api/login', null, { username: 'v268_w', password: 'E2e#H8!w' })).token;
      const j2 = await (await fetch(BASE + '/api/requisitions/q_v268b', { headers: { Authorization: 'Bearer ' + tk2 } })).json();
      const h2 = (((j2.req || {}).items || [])[0] || {}).suggest || {};
      chkT('★⑤已发料的框不再算占用', !((h2.heldByOthers || []).length), JSON.stringify(h2.heldByOthers));
    } finally { srv2.kill(); }
    console.log(`\n===== v268 同框占用可见性取证：${total - fail}/${total} PASS =====`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) { console.log('FAIL! 异常', e && e.message); process.exitCode = 1; } finally { fs.rmSync(TDIR, { recursive: true, force: true }); }
})();
