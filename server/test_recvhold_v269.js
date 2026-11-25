// ㉖v269 领料侧「货在一楼」人性化提示取证
// 现场问题：来料区开启后料只在 NB04，领料员能搜到能下单，但取货建议为空（pickSuggest 排除 NB04），
//   他看着"有库存"却发不出料，不知道该催谁。本轮补：①建单候选拆"可发/楼下待转入" ②详情建议区讲清去向+找谁
// 断言：①服务端建议带 recvHold（框/件/格位）②全在楼下的零件 recvHold 有值但建议框为空
//       ③二楼有货时建议照常（不改 FIFO 口径）④无来料区库存的零件不带 recvHold（不加噪声）
//       ⑤PDA 两处候选与详情提示锚点在位（格式化免疫）
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const TDIR = path.join(__dirname, 'data_e2e_recvhold_v269');
const PORT = 8461, BASE = 'http://127.0.0.1:' + PORT;
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(__dirname, 'data', 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(8).toString('hex'), hp = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');
db0.users = db0.users || [];
db0.users.push({ id: 'u_v269m', username: 'v269_m', name: 'V269物料', role: 'material', enabled: true, salt, passHash: hp('E2e#R9!m', salt) });
db0.params = Object.assign(db0.params || {}, { receivingOn: 1, gateMode: 0, freezeOn: 0, throttleN: 0 });
const now = Date.now();
const PA = 'V269ONLYRECV', PB = 'V269BOTH', PC = 'V269SHELF';
db0.ledger = (db0.ledger || []).filter((x) => !String(x.c).startsWith('V269'));
// PA：只在来料区（2框）；PB：来料区1框+二楼1框；PC：只在二楼
db0.ledger.push({ c: 'V269A01', l: 'NB04-A-09-101', p: PA, n: 'V269仅楼下', q: 100, t: now - 600e3, b: '2026-11-25' });
db0.ledger.push({ c: 'V269A02', l: 'NB04-A-09-102', p: PA, n: 'V269仅楼下', q: 100, t: now - 590e3, b: '2026-11-25' });
db0.ledger.push({ c: 'V269B01', l: 'NB04-A-09-103', p: PB, n: 'V269两处', q: 80, t: now - 500e3, b: '2026-11-25' });
db0.ledger.push({ c: 'V269B02', l: 'NB02-H-02-1F', p: PB, n: 'V269两处', q: 80, t: now - 400e3, b: '2026-11-25' });
db0.ledger.push({ c: 'V269C01', l: 'NB02-H-03-1F', p: PC, n: 'V269仅二楼', q: 60, t: now - 300e3, b: '2026-11-25' });
const mk = (id, no, pn) => ({ id, no, by: 'u_v269m', byName: 'V269物料', status: 'accepted', createdAt: new Date(now).toISOString(), history: [], items: [{ partNo: pn, itemName: 'V269件', qty: 50, issued: [], agvCalled: [] }] });
db0.requisitions = (db0.requisitions || []).filter((r) => !String(r.no).startsWith('LLV269'));
db0.requisitions.push(mk('q_v269a', 'LLV269A', PA), mk('q_v269b', 'LLV269B', PB), mk('q_v269c', 'LLV269C', PC));
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const chkT = (n, c, why) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]${c ? '' : ' ←' + (why || '')}`); };
const ws = (s) => String(s).replace(/\s+/g, ' '); // 格式化免疫（v259b 教训）
(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { SELFTEST_NO_LIVE: '1', ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health')).ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪'); srv.kill(); fs.rmSync(TDIR, { recursive: true, force: true }); process.exit(1); }
  try {
    const tk = (await (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'v269_m', password: 'E2e#R9!m' }) })).json()).token;
    const sgOf = async (id) => { const j = await (await fetch(BASE + '/api/requisitions/' + id, { headers: { Authorization: 'Bearer ' + tk } })).json(); return (((j.req || {}).items || [])[0] || {}).suggest || {}; };
    // ① 仅楼下：建议空但 recvHold 讲清 2 框 200 件
    const a = await sgOf('q_v269a');
    chkT('★①仅楼下零件带 recvHold（框/件）', (a.recvHold || {}).boxes === 2 && (a.recvHold || {}).qty === 200, JSON.stringify(a.recvHold));
    chkT('★②全厂仅楼下有货→v118兜底把楼下框放回建议（允许人工直拣，非缺陷）', (a.boxes || []).length > 0 && (a.boxes || []).every((x) => /^NB04-/.test(String(x.l || ''))), JSON.stringify((a.boxes || []).map((b) => b.l)));
    chkT('②b 带格位提示便于仓管找货', /A-09/.test(String((a.recvHold || {}).slotsTip || '')), JSON.stringify(a.recvHold));
    // ③ 两处都有：建议给二楼框，recvHold 只算楼下那框
    const b = await sgOf('q_v269b');
    chkT('★③混合零件建议给二楼框', (b.boxes || []).some((x) => /^NB02-/.test(String(x.l || ''))), JSON.stringify((b.boxes || []).map((x) => x.l)));
    chkT('③b recvHold 只算楼下 1 框 80 件', (b.recvHold || {}).boxes === 1 && (b.recvHold || {}).qty === 80, JSON.stringify(b.recvHold));
    // ④ 仅二楼：不带 recvHold（不加噪声）
    const c = await sgOf('q_v269c');
    chkT('★④纯二楼零件不带 recvHold', !c.recvHold, JSON.stringify(c.recvHold));
    // ⑤ PDA 渲染锚点（格式化免疫）
    const rq = ws(fs.readFileSync(path.join(__dirname, '..', 'lib', 'requisition_page.dart'), 'utf8'));
    const iv = ws(fs.readFileSync(path.join(__dirname, '..', 'lib', 'inventory_stock_page.dart'), 'utf8'));
    chkT('★⑤a 聚合层有 recvBoxes 统计（NB04 前缀）', iv.includes("if (box.loc.toUpperCase().startsWith('NB04-'))") && iv.includes('row.recvBoxes++'), '');
    chkT('⑤b 建单候选区分可发/待转入', rq.includes('可发 ${p.readyBoxes} 框') && rq.includes('框全在一楼来料区，转入后才能发料'), '');
    chkT('★⑤c 详情建议区讲清找谁（联系仓管优先转入）', rq.includes('请联系仓管优先转入这批货') && rq.includes('需仓管扫码转入二楼后才能正常发料'), '');
    chkT('★⑤d 兜底态文案不矛盾（建议是楼下框时不说"暂无可发框"）', rq.includes('二楼暂无此料，上面建议的就是一楼这几框') && rq.includes("boxes.any((x) => (x[\"l\"]?.toString().startsWith('NB04-') ?? false))"), '');
    console.log(`\n===== v269 领料侧一楼可见性取证：${total - fail}/${total} PASS =====`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) { console.log('FAIL! 异常', e && e.message); process.exitCode = 1; } finally { srv.kill(); fs.rmSync(TDIR, { recursive: true, force: true }); }
})();
