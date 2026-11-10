// ㉖v136 流水"未上账"误标修复 · 实例证明
// 用户实锤（N26K080033 截图）：框已正常出库，流水页却挂橙色"未上账"——全库扫描该态 1872 条里 1870 条（99.9%）
// 其实已正常出库，真空挂仅 2 条被淹没。根因：reg 判据只查"当前账本在不在"，没排除出库史（出库后账本行被删=正常流转）；
// 而零件档案页 unreg 判据排除了 seenOut——同义标签两处口径不一致，流水页漏了排除。
// 修复：reg 四态 =1 账本在 / -1 已作废 / 2 已出库（账本无但 seenOut 有，灰色不警示）/ 0 真·未上账（两者都无，橙警保留）
// 网页状态列加"已出库"灰标分支；tooltip 同步改口径说明。
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const SRC = path.join(__dirname, 'data'), TDIR = path.join(__dirname, 'data_e2e_regout_v136');
const PORT = 8399, BASE = 'http://127.0.0.1:' + PORT;
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(SRC, 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(SRC, 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(16).toString('hex');
const hashPw = (pw, s) => crypto.scryptSync(String(pw), s, 32).toString('hex');
const now = Date.now();
db0.users.push({ id: 'u_rg', username: 'v136_wh', name: 'V136仓管', role: 'warehouse', enabled: true, createdAt: now, mustChangePw: false, salt, passHash: hashPw('E2e#Rg!136', salt) });
const mk = (code, cx) => { const k = code + '|BRG|' + now; db0.scanlog[k] = { code, wt: 1, st: '', gl: 'NB03-B-11-08', ct: '', rm: '', batch: 'BRG', cx: !!cx, t: now, pn: 'PNV136RG', q: 500, mk: '', lot: '2026-11-09', mc: '', pid: '', op: 'V136仓管', nm: '回归件', cxAt: 0 }; };
mk('V136INSTOCK', false);  // 账本在 → reg=1
mk('V136GONE', false);      // 账本无+出库史有 → reg=2（旧版误标 0）
mk('V136ORPHAN', false);    // 账本无+出库史无 → reg=0（真·未上账，保留警示）
mk('V136CANC', true);       // 作废 → reg=-1
db0.ledger.push({ c: 'V136INSTOCK', l: 'NB03-B-11-08', f: '', t: now, p: 'PNV136RG', n: '回归件', q: 500, b: 'BRG', pid: '', mv: '人工', src: '', by: 'V136仓管', rec: now, hist: [] });
db0.seenOut = db0.seenOut || {};
db0.seenOut['V136GONE'] = { at: now - 1000, no: 'LLV136OUT001', by: 'V136仓管' };
db0.seenOut['V136CANC'] = { at: now - 1000, no: 'LLV136OUT002', by: 'V136仓管' }; // R4 断"作废优先于出库史"须真给出库史
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const chk = (n, g, w) => { total++; const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL!'} [${n}] got=${String(JSON.stringify(g)).slice(0, 140)} want=${String(JSON.stringify(w)).slice(0, 140)}`); };
const chkT = (n, c, why) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]${c ? '' : ' ←' + (why || '')}`); };
(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = []; srv.stdout.on('data', (b) => log.push(String(b))); srv.stderr.on('data', (b) => log.push(String(b)));
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health')).ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪'); srv.kill(); process.exit(1); }
  console.log('隔离实例已就绪 (PORT ' + PORT + ') —— v136 未上账误标修复证明');
  try {
    const tk = (await (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'v136_wh', password: 'E2e#Rg!136' }) })).json()).token;
    const j = await (await fetch(BASE + '/api/scanlog?pn=PNV136RG&limit=100', { headers: { Authorization: 'Bearer ' + tk } })).json();
    const regOf = (c) => { const x = (j.items || []).find((y) => String(y.code).toUpperCase() === c); return x ? x.reg : '(缺行)'; };
    chk('R1 账本在 → reg=1（正常，回归不变）', regOf('V136INSTOCK'), 1);
    chk('R2 账本无+出库史有 → reg=2 已出库（旧版此处=0 误标橙警）', regOf('V136GONE'), 2);
    chk('R3 账本无+出库史无 → reg=0 真·未上账（警示保留，修复不误伤）', regOf('V136ORPHAN'), 0);
    chk('R4 已作废 → reg=-1（优先级最高，即便有出库史）', regOf('V136CANC'), -1);
    // 前端锚点
    const html = fs.readFileSync(path.join(__dirname, 'public', 'console.html'), 'utf8');
    chkT('F1 状态列已出库灰标分支', html.includes("x.reg===2?'<span class=\"tag\" style=\"background:rgba(120,140,170,.12)") && html.includes('已出库</span>'), '');
    chkT('F2 未上账 tooltip 同步新口径（含"且无出库史"）', html.includes('流水正常但货位账本无此框且无出库史'), '');
    chkT('F3 reg=0 橙警示样式保留（真空挂仍显眼）', /x\.reg===0\?'<span class="tag" style="background:rgba\(230,81,0,\.12\)/.test(html), '');
    // 生产库全量口径复算（用修复后逻辑重放，量化误标消除）
    const dbp = JSON.parse(fs.readFileSync(path.join(SRC, 'db.json'), 'utf8'));
    const led = new Set((dbp.ledger || []).map((x) => String(x.c || '').toUpperCase()));
    const so = dbp.seenOut || {};
    let old0 = 0, new2 = 0, new0 = 0;
    for (const s of Object.values(dbp.scanlog || {})) {
      if (s.cx) continue;
      const c = String(s.code || '').toUpperCase();
      if (led.has(c)) continue;
      old0++;
      if (so[c]) new2++; else new0++;
    }
    chkT('P1 生产复算：旧 reg=0 总量 ' + old0 + ' 中已出库 ' + new2 + ' 转灰、真空挂 ' + new0 + ' 保留橙', new2 > 0 && new0 < new2 && new2 + new0 === old0, JSON.stringify([old0, new2, new0]));
    const uncaught = log.join('').split('\n').filter((s) => /uncaught|referenceerror|typeerror/i.test(s));
    chkT('Z 服务日志无未捕获异常', uncaught.length === 0, uncaught.join('\n').slice(0, 200));
  } catch (e) { console.log(e.stack); chkT('X 异常 ' + e.message, false); }
  srv.kill('SIGKILL'); fs.rmSync(TDIR, { recursive: true, force: true });
  console.log(`\n===== v136 未上账误标修复实例证明 ${total - fail}/${total} PASS =====`);
  process.exit(fail ? 1 : 0);
})();
