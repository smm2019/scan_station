// ㉖v200 月度对账包·运营看板 sheet（用户：加仓库看板，媲美顶级公司，结合仓库专用+领导视角）
// 关键验证：手写 SpreadsheetML 必须 XML 良构（用 python 内置 xml.etree 独立验，非自吹）；看板 sheet 存在；CSV 出口不炸；D10 裸表回归不破
const fs = require('fs'), path = require('path'), crypto = require('crypto'), cp = require('child_process');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + i + ']' : ''}`); };

// ===== ㉖v201b PACK 已改 .xlsx 二进制：zip/部件级校验辅助 =====
// 关键坑（本测试自身踩中）：Windows 下 cp.spawn('python',['-c', 含双引号长码]) 会被引号转义破坏
// ——R3 首版 err 里回显的代码变成 len(ws._charts)] 就是被吃掉的括号，误判成 xlsx 有问题。
// 统一改为把 python 代码落成临时 .py 文件再执行（与手工 python -c 单行验证结果一致）。
function pyRun(code, file, tmpDir) {
  return new Promise((res) => {
    const fp = path.join(tmpDir || '.', '_pychk_' + Date.now() + '_' + Math.floor(Math.random() * 1e5) + '.py');
    try { fs.writeFileSync(fp, code); } catch (_) { return res({ code: -1, out: '', err: '临时脚本写入失败' }); }
    const p = cp.spawn('python', [fp, file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '', e = ''; p.stdout.on('data', (d) => { o += d; }); p.stderr.on('data', (d) => { e += d; });
    p.on('close', (c) => { try { fs.unlinkSync(fp); } catch (_) {} res({ code: c, out: o.trim(), err: (e || o).slice(-1200) }); });
    p.on('error', (er) => { try { fs.unlinkSync(fp); } catch (_) {} res({ code: -1, out: '', err: String(er) }); });
  });
}
// 取 zip 内某部件文本（部件名走环境变量传参，且同样落地 .py 绕开引号）
function unzipPart(file, part, tmpDir) {
  const code = 'import sys,zipfile,os\nsys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read(os.environ["PP"]))';
  return new Promise((res) => {
    const fp = path.join(tmpDir || '.', '_pyup_' + Date.now() + '_' + Math.floor(Math.random() * 1e5) + '.py');
    try { fs.writeFileSync(fp, code); } catch (_) { return res(''); }
    const p = cp.spawn('python', [fp, file], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PP: part } });
    let o = ''; p.stdout.on('data', (d) => { o += d; });
    p.on('close', () => { try { fs.unlinkSync(fp); } catch (_) {} res(o); });
    p.on('error', () => { try { fs.unlinkSync(fp); } catch (_) {} res(''); });
  });
}
// 全部件 XML 良构 + zip 无坏项（zipfile 真解压，比整文件 ET.parse 更贴合 xlsx）
function zipWellFormed(file) {
  const code = 'import sys,zipfile,xml.etree.ElementTree as ET;' +
    'z=zipfile.ZipFile(sys.argv[1]);b=z.testzip();assert b is None,"zip-bad:"+str(b);' +
    'ns=[n for n in z.namelist() if n.endswith((".xml",".rels"))];' +
    '[ET.fromstring(z.read(n)) for n in ns];print("OK",len(z.namelist()),"parts")';
  return pyRun(code, file);
}
// openpyxl 严格模式真加载 + 数图表；未安装 openpyxl → skip（CI 无该库环境判 SKIP 不跑红）
async function openpyxlCheck(file) {
  const code = 'import sys,warnings;warnings.simplefilter("error");import openpyxl;' +
    'wb=openpyxl.load_workbook(sys.argv[1]);ws=wb[wb.sheetnames[0]];' +
    'print("SHEETS","|".join(wb.sheetnames));print("CHARTS",len(ws._charts));' +
    'print("TYPES",",".join(type(c).__name__ for c in ws._charts))';
  const r = await pyRun(code, file);
  if (/ModuleNotFoundError|No module named/i.test(r.err)) return { skip: true };
  return { ok: r.code === 0 && /SHEETS/.test(r.out), out: r.out, err: r.err };
}

// 独立 XML 良构校验（python 内置严格解析器，能抓标签不闭合/实体错误/属性引号）
function xmlWellFormed(file) {
  return new Promise((res) => {
    const py = 'import sys,xml.etree.ElementTree as ET;ET.parse(sys.argv[1]);print("WELLFORMED")';
    const p = cp.spawn('python', ['-c', py, file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '', e = ''; p.stdout.on('data', (d) => { o += d; }); p.stderr.on('data', (d) => { e += d; });
    p.on('close', (code) => res({ ok: code === 0 && /WELLFORMED/.test(o), err: (e || o).slice(0, 300) }));
    p.on('error', (err) => res({ ok: false, err: String(err) }));
  });
}

(async () => {
  const TDIR = path.join(__dirname, '_tdata_board200');
  const OUT = path.join(TDIR, 'pack.xlsx'); // ㉖v201b 扩展名必须是 .xlsx：openpyxl 按扩展名判格式，.xls 直接拒读（本测试首版踩中，非产物问题）
  const PORT = Number(process.env.BD_PORT || (9000 + Math.floor(Math.random() * 80)));
  fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
  const salt = crypto.randomBytes(16).toString('hex');
  const mkU = (id, un, nm, role) => ({ id, username: un, name: nm, role, enabled: true, createdAt: new Date().toISOString(), mustChangePw: false, salt, passHash: crypto.scryptSync('Bd#200', salt, 32).toString('hex') });
  const now = Date.now(), D = 864e5;
  {
    const d0 = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'db.json'), 'utf8'));
    d0.users = [mkU('u_ad', 'ad_u', '测试管理', 'admin')];
    d0.features = JSON.parse(JSON.stringify(d0.features || {}));
    d0.itemDict = { PN001: { nm: '左前大灯总成' }, PN002: { nm: '保险杠' }, PN003: { nm: '门把手' } };
    // 账本：整托多码(同pid 2码=1框)、台挂(不计占用)、呆滞(t老)、地面、正常
    d0.ledger = [
      { c: 'BX1', l: 'NB02-A-05-1F', p: 'PN001', pid: 'PAL01', f: '1800*1200_2', t: now - 3 * D, q: 20 },
      { c: 'BX1B', l: 'NB02-A-05-1F', p: 'PN001', pid: 'PAL01', f: '1800*1200_2', t: now - 3 * D, q: 20 }, // 同托=同框
      { c: 'BX2', l: 'NB02-B-06-2F', p: 'PN002', f: '1800*1200_2', t: now - 40 * D, q: 8 }, // 呆滞
      { c: 'BX3', l: 'NB02-B-CK-09', p: 'PN003', f: '1800*1200_2', t: now - 50 * D, q: 5 }, // 台挂(排占用/呆滞)
      { c: 'BX4', l: 'NB03-A-11-05', p: 'PN002', f: '1800*1200_2', t: now - 20 * D, q: 12 }, // 地面
      { c: 'BX5', l: 'NB02-C-07-3F', p: 'PN001', f: '1800*1200_2', t: now - 1 * D, q: 30 },
    ];
    d0.ledgerTomb = [];
    // 流水：入库(NB02 wt0/地面 wt1)、来料(NB04 剔除)、作废(排除)
    d0.scanlog = {
      'BX1|B1|1': { code: 'BX1', wt: 0, st: 'NB02-CK-05', gl: '', t: now - 3 * D, cx: false, batch: 'B1', pn: 'PN001', q: 20, op: '测试管理' },
      'BX5|B2|2': { code: 'BX5', wt: 0, st: 'NB02-CK-06', gl: '', t: now - 1 * D, cx: false, batch: 'B2', pn: 'PN001', q: 30, op: '测试管理' },
      'BXR|B3|3': { code: 'BXR', wt: 2, st: 'NB04-A-01-001', gl: '', t: now - 2 * D, cx: false, batch: 'B3', pn: 'PN002', q: 9, op: '测试管理' }, // 来料区不计入库
      'BXD|B4|4': { code: 'BXD', wt: 0, st: 'NB02-CK-05', gl: '', t: now - 2 * D, cx: true, batch: 'B4', pn: 'PN003', q: 7, op: '测试管理' }, // 作废排除
    };
    d0.outbound = { OB1: { orderNo: 'OB1', createdAt: now - 2 * D, operator: '测试管理', toLoc: '线边', items: [{ code: 'PN002', barcode: 'BX2;BX4', qty: 20 }] } };
    d0.requisitions = [
      { id: 'r1', no: 'LL01', by: 'u_ad', byName: '测试管理', status: 'done', createdAt: new Date(now - 5 * D).toISOString(), readyAt: now - 4 * D, items: [{ partNo: 'PN001', qty: 20, issued: [{ c: 'BX1', q: 20 }] }], history: [{ time: new Date(now - 5 * D).toISOString(), text: '接单', by: '测试管理' }, { time: new Date(now - 4 * D).toISOString(), text: '签收', by: '测试管理' }] },
      { id: 'r2', no: 'LL02', by: 'u_ad', byName: '测试管理', status: 'pending', createdAt: new Date(now - 1 * D).toISOString(), items: [{ partNo: 'PN002', qty: 100, issued: [] }], history: [] },
    ];
    d0.agvQueue = [
      { type: 'outbound', fromLoc: 'NB02-B-06-2F', code: 'BX2', state: '完成', at: now - 2 * D, sentAt: now - 2 * D, updAt: now - 2 * D, wmsTask: 'T1' },
      { type: 'inbound', fromLoc: 'NB02-CK-05', code: 'BX1', state: '完成', at: now - 3 * D, sentAt: now - 3 * D, updAt: now - 3 * D, wmsTask: 'T2' },
      { type: 'inbound', fromLoc: 'NB02-CK-06', code: 'BX5', state: '失败', at: now - 1 * D, sentAt: now - 1 * D, updAt: now - 1 * D, err: '超时' },
    ];
    d0.rcsRun = [];
    d0.carEvents = [
      { ts: now - 2 * D, kind: '告警', who: 'AGV06', msg: '障碍物' }, { ts: now - 2 * D + 6e4, kind: '恢复', who: 'AGV06', msg: '恢复' },
      { ts: now - 1 * D, kind: '堵点', who: 'AGV08', msg: '交管' }, { ts: now - 1 * D, kind: 'FIFO违反', who: '', msg: '业务类不进看板' },
    ];
    d0.exports = []; d0.ops = []; d0.seenIn = {}; d0.seenOut = {}; d0.inventories = {};
    d0.params = Object.assign({}, d0.params || {});
    fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(d0));
  }
  let srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch('http://127.0.0.1:' + PORT + '/api/health')).ok; } catch (_) {} }
  let out = ''; srv.stdout.on('data', (d) => { out += d; }); srv.stderr.on('data', (d) => { out += d; });
  const API = (p, o = {}, tk) => fetch('http://127.0.0.1:' + PORT + p, { method: o.method || 'GET', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined });
  const dl = async (qs, tk) => { const r = await API('/api/export?' + qs, {}, tk); const buf = Buffer.from(await r.arrayBuffer()); return { ok: r.ok, status: r.status, buf, text: buf.toString('utf8'), ct: r.headers.get('Content-Type') || '' }; };
  try {
    const tk = up && (await (await API('/api/login', { method: 'POST', body: { username: 'ad_u', password: 'Bd#200' } }, null)).json()).token;
    C('护栏 实例启动+登录', up && !!tk, '');
    // ① PACK 导出（㉖v201 起强制 .xlsx 带原生图表）：故意传 fmt=xls，验证规范升级不由调用方决定
    const px = await dl('ds=PACK&fmt=xls', tk);
    C('R1 ★★★ PACK 返回 xlsx 二进制（ZIP 魔数+正确MIME；dr 作用域崩溃的回归锁）', px.ok === true && px.status === 200 && /spreadsheetml\.sheet/.test(px.ct) && px.buf.slice(0, 4).toString('hex') === '504b0304', 'status=' + px.status + ' ct=' + px.ct.slice(0, 58));
    fs.writeFileSync(OUT, px.buf); // 写服务器原始字节流（非 text 再编码），验真实响应
    const zw = await zipWellFormed(OUT);
    C('R2 ★★★ zip 无坏项 + 全部件 XML 良构（zipfile+ET 独立验，非自吹）', zw.code === 0 && /OK/.test(zw.out), zw.err || zw.out);
    const ob = await openpyxlCheck(OUT);
    if (ob.skip) {
      C('R3 openpyxl 真打开（本环境无该库 → SKIP，CI 无库形态判正常）', true, 'SKIP');
      C('R4 看板内嵌图表数 ≥1', true, 'SKIP');
      C('R5 sheet 清单（看板置首+对账四表）', true, 'SKIP');
    } else {
      C('R3 ★★★ openpyxl 严格模式真打开（UserWarning 升级为错误仍通过）', ob.ok, ob.err);
      C('R4 ★★★ 看板首 sheet 内嵌原生图表 ≥1（真图表，非 v200 色块伪可视化）', Number((/CHARTS (\d+)/.exec(ob.out) || [])[1]) >= 1, 'types=' + ((/TYPES (.*)/.exec(ob.out) || [])[1] || ''));
      C('R5 看板置首 + 对账四表齐全（openpyxl 实读 sheet 清单）', /^SHEETS 仓库运营看板\|/m.test(ob.out) && /库位表/.test(ob.out) && /库存汇总/.test(ob.out) && /入库流水/.test(ob.out) && /出库流水/.test(ob.out), ob.out.slice(0, 130));
    }
    const s1 = await unzipPart(OUT, 'xl/worksheets/sheet1.xml');
    C('R6 看板指标入表（标题/占用率/呆滞 落 sheet1）', /仓 库 运 营 看 板/.test(s1) && /货架占用率/.test(s1) && /呆滞框/.test(s1), '');
    const c1 = await unzipPart(OUT, 'xl/charts/chart1_1.xml');
    C('R7 图表 part 为 OOXML 原生 chartSpace（line/bar/pie 之一）', /<c:chartSpace/.test(c1) && /<c:(lineChart|barChart|pieChart)/.test(c1), c1.slice(0, 50));
    const stx = await unzipPart(OUT, 'xl/styles.xml');
    C('R8 ★★★ styles.xml 合规（fill 包裹层在位 + alignment 无错误自闭合）', /<fills[^>]*><fill><patternFill/.test(stx) && !/<alignment[^>]*\/><\/alignment>/.test(stx) && /<cellStyles/.test(stx), '');
    const ctx_ = await unzipPart(OUT, '[Content_Types].xml');
    C('R9 图表/drawing/样式部件在 Content_Types 全登记（缺则 Excel 报修复）', /chart1_\d/.test(ctx_) && /drawings\/drawing1\.xml/.test(ctx_) && /styles\.xml/.test(ctx_), '');
    const wrx = await unzipPart(OUT, 'xl/_rels/workbook.xml.rels');
    C('R10 workbook rels 数=sheet数+样式（重下/打开链路对齐）', (wrx.match(/<Relationship /g) || []).length >= 7 && /styles\.xml/.test(wrx), '');
    // ② CSV 出口不炸（看板降级不崩主流程）
    const pc = await dl('ds=PACK&fmt=csv', tk);
    C('R11 CSV 出口不炸（看板 board 无 headers 不崩）', pc.ok === true && pc.status === 200 && pc.text.length > 50, 'status=' + pc.status + ' len=' + pc.text.length);
    // ③ D10 回归：仍走 SpreadsheetML，没被 xlsx 改造破坏（含 fmt 白名单补 xlsx 后 D10 不被误升级）
    const d10 = await dl('ds=D10&fmt=xls', tk);
    C('R12 ★ D10(xls) 回归不破（仍 SpreadsheetML 文本，未被误转 xlsx）', d10.ok === true && /<Worksheet/.test(d10.text) && !/spreadsheetml\.sheet/.test(d10.ct), 'status=' + d10.status + ' ct=' + d10.ct.slice(0, 40));
    // ④ 显式 fmt=xlsx 白名单（此前被"超范围"拒未落盘，本条锁死）+ 周期窗口跟随
    const pw = await dl('ds=PACK&fmt=xlsx&from=2026-01-01&to=2099-12-31', tk);
    C('R13 ★★★ 显式 fmt=xlsx 白名单生效 + 周期窗口跟随看板', pw.ok === true && /spreadsheetml\.sheet/.test(pw.ct) && pw.buf.slice(0, 4).toString('hex') === '504b0304', 'status=' + pw.status);
    C('★ 无看板装配失败日志（try 未触发）', !/运营看板装配失败/.test(out), out.split('\n').filter((l) => /board/.test(l)).slice(-2).join(' ').slice(0, 90));
    C('★ 进程无未捕获异常', !/Unhandled|TypeError: |ReferenceError/.test(out), out.split('\n').slice(-2).join(' ').slice(0, 90));
  } catch (e) {
    total++; fail++; console.log('❌ 异常：' + e.message + '\n' + String(out).split('\n').slice(-10).join('\n'));
  } finally {
    try { srv.kill(); } catch (_) {}
    await sleep(400);
    try { srv.kill('SIGKILL'); } catch (_) {}
    try { fs.rmSync(TDIR, { recursive: true, force: true }); } catch (_) {}
  }
  console.log('\n结果: ' + (total - fail) + ' 通过 / ' + fail + ' 失败  （隔离副本，生产库零写入）');
  process.exit(fail ? 1 : 0);
})();
