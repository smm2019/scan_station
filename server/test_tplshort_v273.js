// ㉖v273 产线模板·没料一键分享缺料 取证
// 断言：①模板可建/可读（含零在架物料行）②零在架行提交缺料反馈成功（真缺料合理）
//   ③有货且够需求行被服务端有货闸拦（in_stock，防假缺料）④网页 tplShort/tplShortCopy/tplShortSubmit 在位
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const TDIR = path.join(__dirname, 'data_e2e_tplshort_v273');
const PORT = 8469, BASE = 'http://127.0.0.1:' + PORT;
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(__dirname, 'data', 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(8).toString('hex'), hp = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');
db0.users = db0.users || [];
db0.users.push({ id: 'u_v273', username: 'v273_m', name: 'V273物料', role: 'material', enabled: true, salt, passHash: hp('E2e#T3!m', salt) });
// 有货且无在途需求的零件（用于③有货闸）：取一个真实在架零件
const havePn = (db0.ledger || []).map((x) => String(x.p || '').toUpperCase()).find((p) => p && !p.startsWith('V273'));
// ㉖v275 自造"仅一楼有料"零件：两行同托(NB04)→boxes=1,recvBoxes=1（不算缺料）
db0.ledger.push({ c: 'V275R1', l: 'NB04-A-09-401', p: 'V275RECV', q: 40, t: Date.now() - 600e3, pid: 'V275T' });
db0.ledger.push({ c: 'V275R2', l: 'NB04-A-09-401', p: 'V275RECV', q: 40, t: Date.now() - 500e3, pid: 'V275T' });
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const chkT = (n, c, why) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]${c ? '' : ' ←' + (why || '')}`); };
(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { SELFTEST_NO_LIVE: '1', ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health')).ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪'); srv.kill(); fs.rmSync(TDIR, { recursive: true, force: true }); process.exit(1); }
  const post = async (p, tk, b) => (await (await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tk }, body: JSON.stringify(b) })).json().catch(() => ({})));
  const getj = async (p, tk) => (await (await fetch(BASE + p, { headers: { Authorization: 'Bearer ' + tk } })).json().catch(() => ({})));
  try {
    const tk = (await post('/api/login', null, { username: 'v273_m', password: 'E2e#T3!m' })).token;
    // ① 建模板含零在架行+有货行
    const tpl = await post('/api/req-templates', tk, { name: 'V273产线', shared: true, items: [{ partNo: 'V273ZERO', itemName: '零在架件', qty: 5 }, { partNo: havePn, itemName: '有货件', qty: 1 }] });
    chkT('①模板可建', tpl.ok === true, JSON.stringify(tpl).slice(0, 100));
    const tl = await getj('/api/req-templates', tk);
    const t = (tl.list || []).find((x) => x.name === 'V273产线');
    chkT('①b模板可读含2行', !!t && (t.items || []).length === 2, JSON.stringify(t && t.items));
    // ② 零在架行提交缺料成功
    const s1 = await post('/api/shortages', tk, { partNo: 'V273ZERO', itemName: '零在架件', note: '模板缺料', src: 'tpl', forceStock: true });
    chkT('★②零在架行缺料反馈成功', s1.ok === true, JSON.stringify(s1).slice(0, 120));
    // ③ 有货且够需求行被有货闸拦（不带forceStock）
    const s2 = await post('/api/shortages', tk, { partNo: havePn, note: '模板缺料', src: 'tpl' });
    chkT('★③有货行被有货闸拦(in_stock)', s2.ok === false && s2.code === 'in_stock', JSON.stringify(s2).slice(0, 120));
    // ④ 网页函数在位
    const h = fs.readFileSync(path.join(__dirname, 'public', 'console.html'), 'utf8');
    chkT('④网页tplShort/复制/提交在位', h.includes('async function tplShort(') && h.includes('function tplShortCopy(') && h.includes('async function tplShortSubmit(') && h.includes('缺料分享</a>'), '');
    // ㉖v275 多选+来料区：dict 下发 recvBoxes；仅一楼有料不算缺料
    const dict = await getj('/api/dict', tk);
    const recvPn = 'V275RECV';
    // 造一个仅一楼有料的零件账本行，验证 dict.recvBoxes 且 boxes>0（不算缺料）
    // 直接读现有：找一个 recvBoxes>0 的（若无则跳过数值断言，仅验字段逻辑）
    const vr = (dict.list || []).find((x) => x.pn === 'V275RECV');
    chkT('★⑤仅一楼有料:boxes=1且recvBoxes=1(同托去重,不算缺料)', !!vr && vr.boxes === 1 && vr.recvBoxes === 1, JSON.stringify(vr));
    chkT('⑤b网页多选tsChk+来料区不算缺料在位', h.includes('class="tsChk"') && h.includes('recvOnly') && h.includes('不算缺料') && h.includes('function tplShortPaint('), '');
    console.log(`\n===== v273 模板缺料分享取证：${total - fail}/${total} PASS =====`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) { console.log('FAIL! 异常', e && e.message); process.exitCode = 1; } finally { srv.kill(); fs.rmSync(TDIR, { recursive: true, force: true }); }
})();
