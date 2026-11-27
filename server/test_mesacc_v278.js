// ㉖v278 MES 专用账号直登 取证（本地模拟鼎捷 MES：真 RSA 三步登录 + 单点在线互踢模拟）
// 断言：①管理员保存配置→登录回测通过 ②三方对账走专用账号(src=acc) ③二次查询用缓存不重复登录
//   ④被互踢→自动重登自愈(仍成功,登录数+1) ⑤密码落盘为enc1密文且明文不落盘 ⑥错密码保存→login:fail如实报
//   ⑦清除→回退PDA上报凭证(src=pda) ⑧两路全空→no_cred如实报 ⑨非管理员保存→403
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto'), http = require('http');
const TDIR = path.join(__dirname, 'data_e2e_mesacc_v278');
const PORT = 8476, MPORT = 8477, BASE = 'http://127.0.0.1:' + PORT;
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(__dirname, 'data', 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(8).toString('hex'), hp = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');
db0.users = db0.users || [];
const mkU = (id, name, role) => db0.users.push({ id, username: id, name, role, enabled: true, salt, passHash: hp('E2e#A8!' + id.slice(-1), salt) });
mkU('u_ma', '管理员甲', 'admin'); mkU('u_mm', '物料员乙', 'material');
db0.params = Object.assign(db0.params || {}, { reqHoursOn: 0 });
db0.requisitions = []; db0.ledger = []; db0.scanlog = {}; delete db0.mitemFix; delete db0.mesCred; delete db0.mesAccConfig; // ㉖v279 隔离生产账本：myQty 全 0，myDiff=-mesQty 口径可精确断言
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
// ===== 模拟鼎捷 MES =====
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const pubB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const ACC = 'mesrobot', PWD = 'Robot#2026';
let validTk = '', tkSeq = 0, logins = 0;
const mock = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (code, obj, hdr) => { res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, hdr || {})); res.end(JSON.stringify(obj)); };
  if (u.pathname === '/platform/sign/getvalidatekey2') return send(200, { success: true, data: { PublicKey: pubB64, KeyToken: 'KT-' + Date.now() } });
  if (u.pathname === '/platform/sign/signin2' && req.method === 'POST') {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      let arr; try { arr = JSON.parse(b); } catch (_) { return send(200, { success: false, message: '格式错误' }); }
      const [acc, encPwd] = arr;
      let pwd = ''; try { pwd = crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(String(encPwd), 'base64')).toString('utf8'); } catch (_) {}
      if (acc !== ACC || pwd !== PWD) return send(200, { success: false, message: '账号或密码错误' });
      logins++; tkSeq++; validTk = 'tk-' + tkSeq; // 单点在线：新登录踢掉旧 token
      send(200, { success: true, data: { orgId: 'ORG-M', token: 'body-field-ignored' } }, { token: validTk, moduleid: 'MOD-MOCK' });
    });
    return;
  }
  if (u.pathname === '/api/logistics/inv/GetOnhandQtyPage') {
    if (req.headers.token !== validTk) return send(401, { success: false, message: '登录已失效，请重新登录' });
    // ㉖v278b 与真实鼎捷同构：recordsTotal 包在 data 内层（11-26 实测真 MES 结构，夹具曾错放顶层漏测出总数bug）
    // ㉖v279 多仓库/多项目/同键重复行：喂给本地筛选+聚合+分页断言
    const NOW = new Date(Date.now() - 3600e3).toISOString().slice(0, 19).replace('T', ' '); // SAP 新鲜（1小时前）
    const ALL = [
      { MITEM_CODE: 'M278A', MITEM_NAME: '模拟件A', PartCode: 'P278A', WAREHOUSE: 'A101成品仓', PartItemCode: 'EX11', MES_QTY: 100, SAP_QTY: 100, DATETIME_MODIFIED_ERP: NOW },
      { MITEM_CODE: 'M278A', MITEM_NAME: '模拟件A', PartCode: 'P278A', WAREHOUSE: 'A101成品仓', PartItemCode: 'EX11', MES_QTY: 50, SAP_QTY: 0, DATETIME_MODIFIED_ERP: NOW }, // 同键→须聚合
      { MITEM_CODE: 'M278B', MITEM_NAME: '模拟件B', PartCode: 'P278B', WAREHOUSE: 'A102热压仓', PartItemCode: '', MES_QTY: 0, SAP_QTY: 0, DATETIME_MODIFIED_ERP: NOW }, // 三方全 0=无差异
      { MITEM_CODE: 'M278C', MITEM_NAME: '模拟件C', PartCode: 'P278C', WAREHOUSE: 'A101成品仓', PartItemCode: 'V446K', MES_QTY: 7, SAP_QTY: 5, DATETIME_MODIFIED_ERP: '2026-01-01 08:00:00' }, // SAP陈旧不计SAP差异(但myDiff计)
    ];
    const st = Number(u.searchParams.get('start')) || 0, ln = Number(u.searchParams.get('length')) || 50;
    return send(200, { success: true, data: { recordsTotal: ALL.length, data: ALL.slice(st, st + ln) } });
  }
  if (u.pathname === '/kick') { validTk = 'tk-thief-' + (++tkSeq); return send(200, { ok: true }); } // 模拟他人在别处登录抢号
  send(404, { success: false });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const chkT = (n, c, why) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]${c ? '' : ' ←' + (why || '')}`); };
(async () => {
  await new Promise((r) => mock.listen(MPORT, '127.0.0.1', r));
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { SELFTEST_NO_LIVE: '1', ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 60 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health')).ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪'); srv.kill(); mock.close(); fs.rmSync(TDIR, { recursive: true, force: true }); process.exit(1); }
  const tok = async (u) => (await (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'E2e#A8!' + u.slice(-1) }) })).json()).token;
  const adm = await tok('u_ma'), mat = await tok('u_mm');
  const api = async (p, o = {}) => { const r = await fetch(BASE + p, { method: o.method || 'GET', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (o.t || adm) }, body: o.body ? JSON.stringify(o.body) : undefined }); return { st: r.status, j: await r.json().catch(() => ({})) }; };
  const cfg = { host: '127.0.0.1', port: String(MPORT), account: ACC, pwd: PWD };
  try {
    const q0 = await api('/api/stock3?start=0&length=10');
    chkT('⑧前置·两路凭证全空→no_cred如实报', q0.j.ok === false && q0.j.code === 'no_cred', JSON.stringify(q0.j).slice(0, 140));
    const s1 = await api('/api/mes/acc-config', { method: 'POST', body: cfg });
    chkT('①保存配置→登录回测通过', s1.j.ok === true && s1.j.login === 'ok', JSON.stringify(s1.j).slice(0, 160));
    const g1 = await api('/api/mes/cred');
    chkT('①b状态接口acc.on且已登录', g1.j.acc && g1.j.acc.on === true && g1.j.acc.tkAgeMin >= 0, JSON.stringify(g1.j.acc));
    const q1 = await api('/api/stock3?start=0&length=10');
    chkT('②三方对账走专用账号+同键聚合(4行→3)', q1.j.ok === true && q1.j.src === 'acc' && (q1.j.list || []).length === 3 && q1.j.total === 3, JSON.stringify(q1.j).slice(0, 200));
    const rowA = (q1.j.list || []).find((r) => r.mc === 'M278A');
    chkT('★②b聚合口径:A行MES=100+50=150,SAP=100', !!rowA && rowA.mesQty === 150 && rowA.sapQty === 100 && rowA.sapStale === false && rowA.sapDiff === 50, JSON.stringify(rowA));
    const rowC = (q1.j.list || []).find((r) => r.mc === 'M278C');
    chkT('★②c聚合陈旧标记:C行SAP陈旧→sapStale真sapDiff空(自纠点)', !!rowC && rowC.sapStale === true && rowC.sapDiff === null && rowC.sapQty === 0, JSON.stringify(rowC));
    chkT('②d范围内差异计数:nMy=2 nSap=1 nStale=1', q1.j.nMy === 2 && q1.j.nSap === 1 && q1.j.nStale === 1, 'nMy=' + q1.j.nMy + ' nSap=' + q1.j.nSap + ' nStale=' + q1.j.nStale);
    chkT('②e筛选候选:仓库2项目3(含空项)', (q1.j.whs || []).length === 2 && (q1.j.projs || []).length === 3 && (q1.j.projs || []).includes('') && (q1.j.projs || []).includes('EX11'), JSON.stringify(q1.j.whs) + JSON.stringify(q1.j.projs));
    const qf1 = await api('/api/stock3?start=0&length=10&wareHouse=' + encodeURIComponent('A101成品仓'));
    chkT('★②f仓库筛选生效(2行)', qf1.j.total === 2 && (qf1.j.list || []).every((r) => r.wh === 'A101成品仓'), 'total=' + qf1.j.total);
    const qf2 = await api('/api/stock3?start=0&length=10&proj=EX11');
    chkT('★②g项目筛选生效(1行,聚合后)', qf2.j.total === 1 && qf2.j.list[0].mc === 'M278A', 'total=' + qf2.j.total);
    const qf3 = await api('/api/stock3?start=0&length=10&proj=_none');
    chkT('②h无项目筛选(1行B)', qf3.j.total === 1 && qf3.j.list[0].mc === 'M278B', 'total=' + qf3.j.total);
    const qf4 = await api('/api/stock3?start=0&length=10&wareHouse=' + encodeURIComponent('A101成品仓') + '&proj=V446K&mitemCode=' + encodeURIComponent('模拟件C'));
    chkT('★②i仓库+项目+名称模糊三合一(1行C)', qf4.j.total === 1 && qf4.j.list[0].mc === 'M278C', 'total=' + qf4.j.total);
    const qf5 = await api('/api/stock3?start=0&length=10&diff=1');
    chkT('②j仅看差异对全量(2行:B被滤)', qf5.j.total === 2 && !(qf5.j.list || []).some((r) => r.mc === 'M278B'), 'total=' + qf5.j.total);
    const qf6 = await api('/api/stock3?start=1&length=1');
    chkT('②k服务端分页:start1len1→第2行', qf6.j.total === 3 && (qf6.j.list || []).length === 1, 'total=' + qf6.j.total);
    const qf7 = await api('/api/stock3?start=0&length=10');
    chkT('②l 5分钟缓存命中(cached真+logins仍1)', qf7.j.ok === true && qf7.j.cached === true && logins === 1, 'cached=' + qf7.j.cached + ' logins=' + logins);
    const qf8 = await api('/api/stock3?start=0&length=10&refresh=1');
    chkT('②m refresh强刷(旧缓存不复活)', qf8.j.ok === true && logins === 1, 'logins=' + logins); // refresh 强拉但 token 缓存仍新鲜→MES登录数不变
    const qf9 = await api('/api/stock3?start=0&length=5000');
    chkT('②n 全部档length=5000放行(3行全给)', qf9.j.ok === true && (qf9.j.list || []).length === 3, 'n=' + (qf9.j.list || []).length); // v279c：上限200→5000，"全部"页长口径
    const q2 = await api('/api/stock3?start=0&length=10');
    chkT('③二次查询用缓存token(logins仍1)', q2.j.ok === true && q2.j.src === 'acc' && logins === 1, 'logins=' + logins);
    await fetch('http://127.0.0.1:' + MPORT + '/kick'); // 他人抢号
    const q3 = await api('/api/stock3?start=0&length=10&refresh=1'); // refresh 穿透行缓存逼 MES 实查→触发踢线自愈
    chkT('★④被互踢→自动重登自愈', q3.j.ok === true && q3.j.src === 'acc' && logins === 2, 'logins=' + logins + ' ' + JSON.stringify(q3.j).slice(0, 140));
    await sleep(900);
    const raw = fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8');
    chkT('★⑤密码落盘enc1密文且无明文', /"pwd":"enc1:/.test(raw) && raw.indexOf(PWD) < 0, '');
    const s2 = await api('/api/mes/acc-config', { method: 'POST', body: { host: '127.0.0.1', port: String(MPORT), account: ACC, pwd: 'WrongPwd!' } });
    chkT('⑥错密码→保存成功但如实报回测失败', s2.j.ok === true && s2.j.login === 'fail' && /回测失败/.test(s2.j.msg || ''), JSON.stringify(s2.j).slice(0, 160));
    await api('/api/mes/acc-config', { method: 'POST', body: cfg }); // 恢复正确配置
    // PDA 上报一份当前有效 token 的凭证，再清除专用账号 → 应回退 src=pda
    const curTk = validTk; // mock 当前有效票（上一步恢复配置登录后的）
    await api('/api/mes/cred', { method: 'POST', t: adm, body: { host: '127.0.0.1', port: String(MPORT), token: curTk, moduleId: 'MOD-MOCK', orgId: 'ORG-M' } });
    const s3 = await api('/api/mes/acc-config', { method: 'POST', body: { clear: true } });
    chkT('清除专用账号ok', s3.j.ok === true, JSON.stringify(s3.j));
    const q4 = await api('/api/stock3?start=0&length=10');
    chkT('⑦清除后回退PDA凭证(src=pda)', q4.j.ok === true && q4.j.src === 'pda', JSON.stringify(q4.j).slice(0, 140));
    await api('/api/mes/cred', { method: 'POST', t: adm, body: { clear: true } });
    const q5 = await api('/api/stock3?start=0&length=10');
    chkT('⑧两路全空→no_cred如实报', q5.j.ok === false && q5.j.code === 'no_cred', JSON.stringify(q5.j).slice(0, 140));
    const s4 = await api('/api/mes/acc-config', { method: 'POST', t: mat, body: cfg });
    chkT('⑨物料员保存→403', s4.st === 403, s4.st + ' ' + JSON.stringify(s4.j).slice(0, 100));
    console.log(`\n===== v278 MES专用账号直登取证：${total - fail}/${total} PASS =====`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) { console.log('FAIL! 异常', e && e.stack || e); process.exitCode = 1; } finally { srv.kill(); mock.close(); await sleep(300); fs.rmSync(TDIR, { recursive: true, force: true }); }
})();
