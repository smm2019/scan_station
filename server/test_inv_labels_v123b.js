// ㉖v123b 盘点标签级明细上收 · 实例证明
// 需求：网页端盘点详情与 D10 导出能看到具体盘点标签（哪个码几点被盘、账外码、应到未扫到码）
// 链路：PDA 上收 locs 行带 codes/outCodes/bookCodes → 服务器白名单清洗入库 → inventory/get 透传
//       → 网页货位级表标签列 → D10"货位标签明细"sheet（每码一行+判定）
// 证明面：
//  B1 新版上收：三数组原样入库（顺序保留）
//  B2 bookCodes 为"码"（无|件数）也可入库
//  B3 清洗：每项截断60字符、每行截断40项、非数组丢弃、空项过滤
//  B4 旧版兼容：不带三字段 → 入库无该字段（不是空数组假象）
//  B5 脏值容错：null/数字项 → 字符串化或过滤，不 500
//  C1/C2 inventory/get 透传 codes 与缺省字段
//  D1 D10 标签明细 sheet 存在且表头正确
//  D2/D3/D4 判定三态：实扫 / 账外扫入 / ⚠应到未扫到（按码去重，大小写不敏感）
//  D5 老批次（无标签）不报错、不产出该批次行
//  D6/D7 D10 其余 sheet 与既有断言不回归
const fs = require('fs'); const path = require('path'); const cp = require('child_process'); const crypto = require('crypto');
const SRC = path.join(__dirname, 'data'); const TDIR = path.join(__dirname, 'data_e2e_invlbl_v123b'); const PORT = 8359; const BASE = 'http://127.0.0.1:' + PORT;
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(SRC, 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(SRC, 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(16).toString('hex'); const hashPw = (pw, s) => crypto.scryptSync(String(pw), s, 32).toString('hex');
const now = Date.now();
db0.users.push({ id: 'u_il_w', username: 'il_wh', name: 'IL仓管', role: 'warehouse', enabled: true, createdAt: now, mustChangePw: false, salt, passHash: hashPw('E2e#Il!123b', salt) });
delete db0.rcsConfig; delete db0.wmasConfig;
db0.params = Object.assign(db0.params || {}, { agvDryRun: 1 });
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const chk = (n, g, w) => { total++; const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL!'} [${n}] got=${String(JSON.stringify(g)).slice(0, 200)} want=${String(JSON.stringify(w)).slice(0, 200)}`); };
const chkT = (n, c) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]`); };
async function post(p2, tk, body) { const r = await fetch(BASE + p2, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; }
async function getRaw(p2, tk) { const r = await fetch(BASE + p2, { headers: tk ? { Authorization: 'Bearer ' + tk } : {} }); return { status: r.status, text: await r.text() }; }
const BIG = 'X'.repeat(80), BIG_CUT = 'X'.repeat(60);
(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { const r = await fetch(BASE + '/api/health'); up = r.ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪'); srv.kill(); process.exit(1); }
  console.log('隔离实例已就绪 (PORT ' + PORT + ') —— v123b 盘点标签级明细上收证明');
  const errLines = [];
  srv.stderr.on('data', (d) => { const s = String(d); if (!/EADDRINUSE|deprecated/i.test(s)) errLines.push(s.trim()); });
  try {
    const wh = (await post('/api/login', null, { username: 'il_wh', password: 'E2e#Il!123b' })).json.token;
    chkT('A 登录（仓管=盘点权限）', !!wh);

    // ===== 上收三批次：新版全量 / 清洗与容错 / 旧版缺省 =====
    const r1 = await post('/api/inventory/report', wh, {
      batchId: 'INVILB_T1', at: now, totalScans: 5, validScans: 5,
      parts: [{ pn: 'PN001', nm: '件甲', book: 100, real: 100, boxes: 2, out: 0, warn: 0 }],
      locs: [
        { loc: 'nb02-a-01-1f', pn: 'PN001', book: 100, real: 60, boxes: 2, codes: ['CTB1|60', 'ctb2|40'], outCodes: ['CTB9|10'], bookCodes: ['CTB1', 'CTB2', 'CTB3'] },
        { loc: 'NB02-A-02-1F', pn: 'PN001', book: 0, real: 40, boxes: 1, codes: ['CTB2|40'], outCodes: [], bookCodes: [] },
      ],
    });
    chkT('B0a 新版上收受理', r1.json.ok === true);
    const r2 = await post('/api/inventory/report', wh, {
      batchId: 'INVILB_T2', at: now - 1000, totalScans: 1, validScans: 1,
      locs: [
        { loc: 'NB02-B-01-1F', pn: 'PN001', book: 1, real: 1, boxes: 1, codes: [BIG, null, '', 123] },
        { loc: 'NB02-B-02-1F', pn: 'PN001', book: 1, real: 1, boxes: 1, codes: Array.from({ length: 45 }, (_, i) => 'CB' + i + '|1') },
        { loc: 'NB02-B-03-1F', pn: 'PN001', book: 1, real: 1, boxes: 1, codes: 'CTBSTR' },
      ],
    });
    const r3 = await post('/api/inventory/report', wh, {
      batchId: 'INVILB_OLD', at: now - 2000, totalScans: 1, validScans: 1,
      locs: [{ loc: 'NB02-C-01-1F', pn: 'PN001', book: 9, real: 9, boxes: 1 }], // 旧版APK：无三字段
    });
    chkT('B0b 三批次均受理', r2.json.ok === true && r3.json.ok === true);

    // ===== 直读落盘库文件（与 PDA 无关，证明确实入库） =====
    await sleep(800); // save() 有 120ms 防抖 + 异步落盘，等待刷盘完成再读文件
    const dbf = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    const t1 = (dbf.inventories || {}).INVILB_T1 || {}; const L = (t1.locs || [])[0] || {}; const L2 = (t1.locs || [])[1] || {};
    chk('B1 实扫数组原样入库', L.codes, ['CTB1|60', 'ctb2|40']);
    chk('B1 账外数组入库', L.outCodes, ['CTB9|10']);
    chk('B2 账面应到数组入库', L.bookCodes, ['CTB1', 'CTB2', 'CTB3']);
    chk('B6 空数组按缺省处理不入库', [L2.outCodes, L2.bookCodes], [undefined, undefined]);
    const t2 = (dbf.inventories || {}).INVILB_T2 || {}; const C = (t2.locs || [])[0] || {};
    chkT('B3 每项截断60字符', C.codes && C.codes[0] === BIG_CUT);
    chk('B5 脏项容错：null/空串过滤、数字字符串化', C.codes, [BIG_CUT, '123']);
    chkT('B3 每行截断40项', ((t2.locs || [])[1].codes || []).length === 40 && (t2.locs[1].codes || [])[39] === 'CB39|1');
    chk('B3 非数组丢弃为缺省', (t2.locs || [])[2].codes, undefined);
    const old = (dbf.inventories || {}).INVILB_OLD || {}; const O = (old.locs || [])[0] || {};
    chk('B4 旧版兼容：三字段缺省非空数组', [O.codes, O.outCodes, O.bookCodes], [undefined, undefined, undefined]);
    chk('B4 旧版其余字段不受影响', [O.loc, O.book, O.real, O.boxes], ['NB02-C-01-1F', 9, 9, 1]);

    // ===== 接口透传 =====
    const g1 = await getRaw('/api/inventory/get?batchId=INVILB_T1', wh); const gr = JSON.parse(g1.text).rec;
    chk('C1 get 透传 codes', (gr.locs[0].codes || []), ['CTB1|60', 'ctb2|40']);
    const go = JSON.parse((await getRaw('/api/inventory/get?batchId=INVILB_OLD', wh)).text).rec;
    chk('C2 get 老行无标签字段', ['codes', 'outCodes', 'bookCodes'].every((k) => !(k in go.locs[0])), true);

    // ===== D10 标签明细 sheet =====
    const dj = JSON.parse((await getRaw('/api/export?ds=D10&fmt=json&batchId=INVILB_T1', wh)).text);
    const names = (dj.sheets || []).map((s) => s.name);
    chk('D1 D10 四表齐备', names, ['盘点总览', '零件级差异', '货位级差异', '货位标签明细']);
    const tl = (dj.sheets.find((s) => s.name === '货位标签明细') || {}).rows || [];
    chk('D1 表头', (dj.sheets.find((s) => s.name === '货位标签明细') || {}).headers, ['批次', '货位', '零件号', '标签', '件数', '判定']);
    const rowOf = (c) => tl.find((x) => String(x[3]).toUpperCase() === c);
    chk('D2 实扫判定+件数', rowOf('CTB1'), ['INVILB_T1', 'NB02-A-01-1F', 'PN001', 'CTB1', 60, '实扫']);
    chkT('D2 小写码也产实扫行', !!rowOf('CTB2') && rowOf('CTB2')[5] === '实扫' && rowOf('CTB2')[4] === 40);
    chk('D3 账外扫入判定', rowOf('CTB9'), ['INVILB_T1', 'NB02-A-01-1F', 'PN001', 'CTB9', 10, '账外扫入']);
    chk('D4 应到未扫到判定（CTB3 未被实扫点名）', rowOf('CTB3'), ['INVILB_T1', 'NB02-A-01-1F', 'PN001', 'CTB3', 0, '⚠应到未扫到']);
    chkT('D4 CTB1/CTB2 已实扫不再报应到未扫到', !tl.some((x) => String(x[5]).includes('应到') && ['CTB1', 'CTB2'].includes(String(x[3]).toUpperCase())));
    chkT('D4 第2行实扫码不串入第1行去重集（ctb2两处实扫各一行）', tl.filter((x) => String(x[3]).toUpperCase() === 'CTB2' && x[5] === '实扫').length === 2);
    const djOld = JSON.parse((await getRaw('/api/export?ds=D10&fmt=json&batchId=INVILB_OLD', wh)).text);
    chk('D5 老批次标签sheet为空不报错', (djOld.sheets.find((s) => s.name === '货位标签明细') || {}).rows, []);
    chkT('D5 老批次其余sheet仍在', (djOld.sheets || []).length === 4 && (djOld.sheets[0].rows || []).length === 1);
    chk('D6 零件级差异不回归', (dj.sheets.find((s) => s.name === '零件级差异') || {}).rows, []); // book100 real100 无差异
    const locD = (dj.sheets.find((s) => s.name === '货位级差异') || {}).rows || [];
    chkT('D7 货位级差异不回归（两行差异在）', locD.length === 2);

    // ===== 网页渲染锚点（console.html 为运行时静态文件，源码在位证明） =====
    const ch = fs.readFileSync(path.join(__dirname, 'public', 'console.html'), 'utf8');
    chkT('E1 网页标签明细列在位', ch.includes('<th style="min-width:220px">标签明细</th>'));
    chkT('E2 网页应到未扫到点名在位', ch.includes('应到未扫到'));
    chkT('E3 网页旧版兼容提示在位', ch.includes('旧版未上收'));
    // PDA 载荷锚点
    const ip = fs.readFileSync(path.join(__dirname, '..', 'lib', 'inventory_page.dart'), 'utf8');
    chkT('E4 PDA 上收载荷带三数组', ip.includes('"codes": l.labels, "outCodes": l.outsideLabels, "bookCodes": l.bookLabels'));
  } catch (e) { console.log(e.stack); chkT('X 异常 ' + e.message, false); }
  const uncaught = errLines.filter((s) => /uncaught|referenceerror|typeerror|syntaxerror/i.test(s));
  chkT('F 服务日志无未捕获异常', uncaught.length === 0);
  if (uncaught.length) console.log(uncaught.join('\n'));
  srv.kill('SIGKILL');
  console.log(`\n===== v123b 盘点标签级明细上收实例证明 ${total - fail}/${total} PASS =====`);
  process.exit(fail ? 1 : 0);
})();
