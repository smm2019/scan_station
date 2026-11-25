// ㉖v255 一楼待转入拆桶取证：/api/part/profile recv 字段、/api/short/list recvBoxes 字段、与手工复算同口径
// 生产快照实据：NB04 压着 6 零件 16 框，其中 5 零件二楼在架=0（"账上有货≠能发"的全命中样本）
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const TDIR = path.join(__dirname, 'data_e2e_recv_v255');
const PORT = 8426, BASE = 'http://127.0.0.1:' + PORT;
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(__dirname, 'data', 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(8).toString('hex');
const hashPw = (pw, s) => crypto.scryptSync(String(pw), s, 32).toString('hex');
db0.users = db0.users || [];
db0.users.push({ username: 'v255_wh', id: 'u_v255', name: 'V255仓管', role: 'warehouse', enabled: true, salt, passHash: hashPw('E2e#R5!pw', salt) });
db0.shortages = (db0.shortages || []).slice();
// ㉖v269 夹具自造楼下样本（现场作业会推进：11-25 全厂已无"仅在NB04"零件，R0/R3 曾因此假失败）
// 造 3 个零件的 NB04 存量（含同托双码验去重），断言不再依赖生产快照恰好有此类数据
{ const now = Date.now();
  db0.ledger = (db0.ledger || []).filter((x) => !String(x.c).startsWith('V255'));
  db0.ledger.push({ c: 'V255R01', l: 'NB04-A-09-201', p: 'V255PN01', n: 'V255样本甲', q: 100, t: now - 600e3, b: '2026-11-25', pid: 'V255T1' });
  db0.ledger.push({ c: 'V255R02', l: 'NB04-A-09-201', p: 'V255PN01', n: 'V255样本甲', q: 100, t: now - 590e3, b: '2026-11-25', pid: 'V255T1' }); // 同托兄弟码=1框
  db0.ledger.push({ c: 'V255R03', l: 'NB04-A-09-202', p: 'V255PN02', n: 'V255样本乙', q: 60, t: now - 500e3, b: '2026-11-25' });
  db0.ledger.push({ c: 'V255R04', l: 'NB04-A-09-203', p: 'V255PN03', n: 'V255样本丙', q: 40, t: now - 400e3, b: '2026-11-25' });
}
const recvPns = [...new Set((db0.ledger || []).filter((x) => /^NB04-/.test(String(x.l || ''))).map((x) => String(x.p || '').toUpperCase()).filter(Boolean))];
if (recvPns.length) db0.shortages.push({ id: 'V255SH1', pn: recvPns[0], nm: 'V255样本件', note: '取证反馈', src: 'e2e', n: 1, byList: [{ id: 'u_v255', name: 'V255仓管', at: Date.now() }], status: 'open', firstAt: Date.now(), at: Date.now(), seen: [] });
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const chk = (n, g, w) => { total++; const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL!'} [${n}] got=${JSON.stringify(g)} want=${JSON.stringify(w)}`); };
const chkT = (n, c, why) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]${c ? '' : ' ←' + (why || '')}`); };
const boxKeyOf = (x) => { const pid = String(x.pid || '').toUpperCase(); if (pid) return 'P|' + pid; const l = String(x.l || '').toUpperCase(), p = String(x.p || '').toUpperCase(); return (l && p) ? 'L|' + l + '|' + p : 'C|' + String(x.c).toUpperCase(); };
(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { SELFTEST_NO_LIVE: '1', ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health')).ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪'); srv.kill(); process.exit(1); }
  try {
    const tk = (await (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'v255_wh', password: 'E2e#R5!pw' }) })).json()).token;
    const H = { Authorization: 'Bearer ' + tk };
    chkT('R0 夹具存在楼下存量零件（测试前提，v269 改自造不依赖现场）', recvPns.length >= 3, '楼下零件=' + recvPns.length);
    // R1 档案 recv 桶 = 手工复算（框按托去重、件数行累加、格位清单剥前缀）
    for (const pn of recvPns.slice(0, 3)) {
      const j = await (await fetch(BASE + '/api/part/profile?pn=' + pn, { headers: H })).json();
      const rows = (db0.ledger || []).filter((x) => /^NB04-/.test(String(x.l || '')) && String(x.p || '').toUpperCase() === pn);
      const bx = new Set(rows.map(boxKeyOf)); const qty = rows.reduce((s, x) => s + (Number(x.q) || 0), 0);
      chk(`R1[${pn}] recv.boxes/qty 与手工复算一致`, j.ok === true && j.recv && [j.recv.boxes, j.recv.qty], [true, bx.size, qty].slice(1));
      chkT(`R1b[${pn}] 在架明细仍含全部账本框（profile.boxes=明细数组，口径未动；拣选排除在建议链不在本口径）`, Array.isArray(j.boxes) && j.boxes.length >= bx.size, `boxes=${'Array('+(j.boxes||[]).length+')'}`);
    }
    // R2 无楼下存量的对照零件 recv.boxes=0（空桶不报错不误报）
    const other = [...new Set((db0.ledger || []).filter((x) => !/^NB04-/.test(String(x.l || ''))).map((x) => String(x.p || '').toUpperCase()))].find((p) => p && !recvPns.includes(p));
    if (other) { const j2 = await (await fetch(BASE + '/api/part/profile?pn=' + other, { headers: H })).json(); chk('R2 对照零件 recv 空桶', [j2.ok === true, (j2.recv || {}).boxes], [true, 0]); }
    // R3 缺料列表 recvBoxes 落字段
    const sl = await (await fetch(BASE + '/api/shortages?status=open', { headers: H })).json();
    const sh = (sl.list || []).find((x) => x.id === 'V255SH1') || {};
    const _rb = new Set((db0.ledger || []).filter((x) => /^NB04-/.test(String(x.l || '')) && String(x.p || '').toUpperCase() === sh.pn).map(boxKeyOf)).size;
    chk('R3 缺料列表 recvBoxes=楼下复算框数', [sh.recvBoxes !== undefined, sh.recvBoxes], [true, _rb]);
    // R4 预约进度文案含"楼下待转入"（源码级：通知模板注入 recv 桶）
    const ssrc = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    chkT('R4 预约进度通知模板带楼下桶', /已到.*框（\$\{pct\}%）.*\$\{_rbk\[p\] \? `（含楼下待转入/.test(ssrc), '');
    console.log(`\n结果：${total - fail}/${total} 通过` + (fail ? ` —— FAIL! ${fail}` : ' ✅'));
    process.exitCode = fail ? 1 : 0;
  } catch (e) { console.log('FAIL! 异常', e); process.exitCode = 1; } finally { srv.kill(); fs.rmSync(TDIR, { recursive: true, force: true }); }
})();
