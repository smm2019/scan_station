// ㉖v257 标签全链路「一眼看懂」契约取证：/api/trace 新增 final/finalCol/milestones（服务端单源，两端只渲染）
// 真数据剧本：①全周期框（一楼登记→转入→AGV→领料→出库→签收）②仅在一楼待转入的框（16 框任一）
// ③二楼原生入库框（无一楼登记）——final 一句结论正确 + 里程碑达成/缺失/不适用三态正确
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const TDIR = path.join(__dirname, 'data_e2e_trace_v257');
const PORT = 8433, BASE = 'http://127.0.0.1:' + PORT;
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(__dirname, 'data', 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(8).toString('hex'), hp = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');
db0.users = db0.users || [];
db0.users.push({ username: 'v257_t', id: 'u_v257', name: 'V257测试', role: 'warehouse', enabled: true, salt, passHash: hp('E2e#T7!pw', salt) });
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const chkT = (n, c, why) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]${c ? '' : ' ←' + (why || '')}`); };
// 找三类真标签
const byC = {}; for (const s of Object.values(db0.scanlog || {})) { if (!s.code) continue; (byC[s.code.toUpperCase()] = byC[s.code.toUpperCase()] || []).push(s); }
let FULL = '', RECV = '', NATIVE = '';
for (const [c, rows] of Object.entries(byC)) {
  const r2 = rows.filter((x) => x.wt === 2 && !x.cx), r1 = rows.filter((x) => (x.wt === 0 || x.wt === 1) && !x.cx);
  const tomb = (db0.ledgerTomb || []).find((t) => t.c.toUpperCase() === c);
  const ob = Object.values(db0.outbound || {}).find((o) => (o.items || []).some((i) => String(i.barcode || '').toUpperCase() === c));
  if (!FULL && r2.length && ob) FULL = c;
  if (!RECV && r2.length && !r1.length && (db0.ledger || []).some((x) => x.c.toUpperCase() === c && /^NB04-/.test(x.l))) RECV = c;
}
for (const x of db0.ledger || []) { const c = String(x.c).toUpperCase(); if (!NATIVE && !/^NB04-/.test(x.l) && !(byC[c] || []).some((s) => s.wt === 2) && /^NB0[23]-/.test(x.l)) NATIVE = c; }
(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { SELFTEST_NO_LIVE: '1', ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health')).ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪'); srv.kill(); process.exit(1); }
  try {
    const tk = (await (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'v257_t', password: 'E2e#T7!pw' }) })).json()).token;
    chkT('T0 三类样本齐（前提）', !!(FULL && RECV && NATIVE), `FULL=${FULL} RECV=${RECV} NATIVE=${NATIVE}`);
    const tr = async (q) => (await (await fetch(BASE + '/api/trace?q=' + q, { headers: { Authorization: 'Bearer ' + tk } })).json());
    if (FULL) { const j = await tr(FULL);
      chkT('T1a 全周期框 final=离仓口径', /出库|离仓|MES/.test(j.final || ''), j.final);
      const M = j.milestones || [];
      chkT('T1b 里程碑六道齐', M.length === 6 && ['一楼登记', '二楼入库', '领料', 'AGV搬运', '出库转MES', '签收'].every((n, i) => M[i] && M[i].n === n), JSON.stringify(M.map((x) => x.n)));
      chkT('T1c 全周期框前三站达成带时刻', M[0].t > 0 && M[1].t > 0 && M[2].t > 0 && M[4].t > 0, JSON.stringify(M.map((x) => !!x.t)));
      chkT('T1d 无红!站（need 未达）', !M.some((m) => !m.t && m.need), JSON.stringify(M.filter((m) => !m.t).map((m) => m.n))); }
    if (RECV) { const j = await tr(RECV);
      chkT('T2a 楼下框 final 点破待转入', /一楼|来料|待转入/.test(j.final || '') && /橙|#E65100/i.test(j.finalCol || ''), j.final + '|' + j.finalCol);
      const M = j.milestones || [];
      chkT('T2b 一楼达成、二楼入库红!（need）', M[0] && M[0].t > 0 && M[1] && !M[1].t && M[1].need === true, JSON.stringify(M.slice(0, 2))); }
    if (NATIVE) { const j = await tr(NATIVE);
      chkT('T3a 原生入库框 final=在架带库位', /在架/.test(j.final || ''), j.final);
      const M = j.milestones || [];
      chkT('T3b 原生框一楼=不适用（need=false 不背锅）', M[0] && M[0].need === false, JSON.stringify(M[0])); }
    console.log(`\n结果：${total - fail}/${total} 通过` + (fail ? ` —— FAIL! ${fail}` : ' ✅'));
    process.exitCode = fail ? 1 : 0;
  } catch (e) { console.log('FAIL! 异常', e); process.exitCode = 1; } finally { srv.kill(); fs.rmSync(TDIR, { recursive: true, force: true }); }
})();
