// ㉖v285 三方对账全量排序取证（用户 11-27 需求：表头能排序）
// 核心语义：①服务端全量排序（非只排本页）②未同步行(sapStale)在 SAP三列 升/降都永远沉底
// ③文字列字典序/数字列数值序 ④不传 sort 保持聚合原序 ⑤仅看差异+排序叠加（先筛后排）
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto'), http = require('http');
const TDIR = path.join(__dirname, 'data_e2e_sort_v285');
const PORT = 8484, MPORT = 8485, BASE = 'http://127.0.0.1:' + PORT;
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(__dirname, 'data', 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(8).toString('hex'), hp = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');
db0.users = (db0.users || []).filter((u) => u.role === 'admin');
db0.users.push({ id: 'u_ad', username: 'u_ad', name: '管理员', role: 'admin', enabled: true, salt, passHash: hp('E2e#Z5!d', salt) });
const ACC = 'sorttest', PWD = 'Sort#285';
db0.mesAccConfig = { host: '127.0.0.1', port: String(MPORT), account: ACC, pwd: PWD };
delete db0.mesCred;
db0.ledger = []; db0.scanlog = {};
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
// mock MES：5 行库存，3 新鲜 2 陈旧(未同步)；mesQty 各不相同
const fresh = new Date(Date.now() - 3600e3).toISOString().slice(0, 19).replace('T', ' ');
const stale = new Date(Date.now() - 17 * 864e5).toISOString().slice(0, 19).replace('T', ' ');
const ROWS = [
  { MITEM_CODE: 'MC05', MITEM_NAME: '戊件', PartCode: 'P05', WAREHOUSE: 'W1', MES_QTY: 100, SAP_QTY: 60, DATETIME_MODIFIED_ERP: fresh },   // sapDiff +40
  { MITEM_CODE: 'MC01', MITEM_NAME: '甲件', PartCode: 'P01', WAREHOUSE: 'W1', MES_QTY: 300, SAP_QTY: 300, DATETIME_MODIFIED_ERP: fresh },  // sapDiff 0
  { MITEM_CODE: 'MC09', MITEM_NAME: '丙件', PartCode: 'P09', WAREHOUSE: 'W1', MES_QTY: 50, SAP_QTY: 45, DATETIME_MODIFIED_ERP: stale },    // 未同步
  { MITEM_CODE: 'MC02', MITEM_NAME: '乙件', PartCode: 'P02', WAREHOUSE: 'W1', MES_QTY: 400, SAP_QTY: 500, DATETIME_MODIFIED_ERP: fresh },  // sapDiff -100
  { MITEM_CODE: 'MC07', MITEM_NAME: '丁件', PartCode: 'P07', WAREHOUSE: 'W1', MES_QTY: 20, SAP_QTY: 5, DATETIME_MODIFIED_ERP: stale },     // 未同步
];
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const pubB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
let validTk = '';
const mock = http.createServer((req, res) => {
  const u2 = new URL(req.url, 'http://x');
  const send = (o, hdr) => { res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, hdr || {})); res.end(JSON.stringify(o)); };
  if (u2.pathname === '/platform/sign/getvalidatekey2') return send({ success: true, data: { PublicKey: pubB64, KeyToken: 'KT1' } });
  if (u2.pathname === '/platform/sign/signin2') {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      let pwd = ''; try { pwd = crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(String(JSON.parse(b)[1]), 'base64')).toString('utf8'); } catch (_) {}
      if (JSON.parse(b)[0] !== ACC || pwd !== PWD) return send({ success: false, message: '错' });
      validTk = 'stk1'; send({ success: true, data: { orgId: 'O1' } }, { token: validTk, moduleid: 'M1' });
    });
    return;
  }
  if (u2.pathname === '/api/logistics/inv/GetOnhandQtyPage') {
    if (req.headers.token !== validTk) return send({ success: false, message: '登录失效' });
    return send({ success: true, data: { recordsTotal: ROWS.length, data: ROWS } }); // 内层recordsTotal（真机同构）
  }
  send({ success: false });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const chkT = (n, c, why) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]${c ? '' : ' ←' + (why || '')}`); };
(async () => {
  await new Promise((r) => mock.listen(MPORT, '127.0.0.1', r));
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { SELFTEST_NO_LIVE: '1', ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'ignore', 'ignore'] });
  let up = false; for (let i = 0; i < 60 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health')).ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪'); srv.kill(); mock.close(); fs.rmSync(TDIR, { recursive: true, force: true }); process.exit(1); }
  for (let i = 0; i < 60; i++) { const _gr = await fetch(BASE + '/api/requisitions/gate').catch(() => null); if (_gr && _gr.status !== 503) break; await sleep(1000); } // ㉖自愈窗等待：sweep自检在RCS慢日拖20秒+（11-28实锤），不等窗后续断言全空跑
  const tkA = (await (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'u_ad', password: 'E2e#Z5!d' }) })).json()).token;
  const q = async (extra) => (await (await fetch(BASE + '/api/stock3?start=0&length=50' + extra, { headers: { Authorization: 'Bearer ' + tkA } })).json());
  const mcs = (j) => (j.list || []).map((r) => r.mc).join(',');
  try {
    chkT('基线·不传sort保持聚合原序', mcs(await q('')) === 'MC05,MC01,MC09,MC02,MC07', mcs(await q('')));
    const a1 = mcs(await q('&sort=sapDiff&dir=1'));
    chkT('★MES−SAP升序：有值升[-100,0,40]·未同步两行沉底', a1 === 'MC02,MC01,MC05,MC09,MC07', a1);
    const a2 = mcs(await q('&sort=sapDiff&dir=-1'));
    chkT('★MES−SAP降序：有值降[40,0,-100]·未同步仍沉底(不谎称有数)', a2 === 'MC05,MC01,MC02,MC09,MC07', a2);
    // 自纠：sapQty 升序=数值 60→300→500（我上一版按编码手滑写错期望，实际输出才是对的）；未同步(sapDiff null→列显"—")沉底
    chkT('SAP现有量升序=数值升·未同步沉底', mcs(await q('&sort=sapQty&dir=1')) === 'MC05,MC01,MC02,MC09,MC07', mcs(await q('&sort=sapQty&dir=1')));
    // sapAt 列对陈旧行显示【真实时间】（非"—"，截图实锤 11/10 10:38 可见）→ 按真实时间值排、更久未更新在前，不沉底
    chkT('SAP更新时间升序=真实时间值排(陈旧=更久未更新在前)', mcs(await q('&sort=sapAt&dir=1')) === 'MC09,MC07,MC05,MC01,MC02', mcs(await q('&sort=sapAt&dir=1')));
    chkT('★物料编码字典升序', mcs(await q('&sort=mc&dir=1')) === 'MC01,MC02,MC05,MC07,MC09', mcs(await q('&sort=mc&dir=1')));
    chkT('MES现有量降序(全量非本页)', mcs(await q('&sort=mesQty&dir=-1')) === 'MC02,MC01,MC05,MC09,MC07', mcs(await q('&sort=mesQty&dir=-1')));
    // 仅看差异(本系统0全对不上→5行都算差异? myDiff=0-mesQty≠0 全中) + 排序叠加：用MES−SAP口径筛？diff=1按myDiff/sapDiff——myDiff全≠0仍5行，排序正确即可
    const ad = await q('&diff=1&sort=mc&dir=1');
    chkT('仅看差异+排序叠加先筛后排', ad.ok === true && mcs(ad) === 'MC01,MC02,MC05,MC07,MC09' && ad.total === 5, mcs(ad));
    console.log(`\n===== v285 三方对账排序取证：${total - fail}/${total} PASS =====`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) { console.log('FAIL! 异常', e && e.stack || e); process.exitCode = 1; } finally { srv.kill(); mock.close(); await sleep(300); fs.rmSync(TDIR, { recursive: true, force: true }); }
})();
