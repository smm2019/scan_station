// ㉖v284 SAP全量分批同步取证（用户11-27实锤：1889个只同步了前面一部分）
// 验证：①450个物料一次受理→mock MES收到3批(200/200/50) ②入参去重 ③进行中再点=互斥拒绝
// ④回执如实"已受理N个+批数" ⑤ops留痕成功计数 ⑥非管理员403
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto'), http = require('http');
const TDIR = path.join(__dirname, 'data_e2e_sapsync_v284');
const PORT = 8482, MPORT = 8483, BASE = 'http://127.0.0.1:' + PORT;
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(__dirname, 'data', 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(8).toString('hex'), hp = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');
db0.users = (db0.users || []).filter((u) => u.role === 'admin');
db0.users.push({ id: 'u_ad', username: 'u_ad', name: '管理员', role: 'admin', enabled: true, salt, passHash: hp('E2e#Y4!d', salt) });
db0.users.push({ id: 'u_mt', username: 'u_mt', name: '物料工', role: 'material', enabled: true, salt, passHash: hp('E2e#Y4!t', salt) });
// 指向本地mock MES（假专用账号，RSA真实现）
const ACC = 'saptest', PWD = 'Sap#284';
db0.mesAccConfig = { host: '127.0.0.1', port: String(MPORT), account: ACC, pwd: PWD };
delete db0.mesCred; delete db0.diagPulse;
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
// ===== mock MES：RSA三步登录 + SyncOnhandQty记录分批 =====
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const pubB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
let tkSeq = 0, validTk = '';
const batches = []; // 每批收到的 mitemList 长度
let syncMode = 'ok'; // 'ok'|'fail' 可切
const mock = http.createServer((req, res) => {
  const u2 = new URL(req.url, 'http://x');
  const send = (o, hdr) => { res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, hdr || {})); res.end(JSON.stringify(o)); };
  if (u2.pathname === '/platform/sign/getvalidatekey2') return send({ success: true, data: { PublicKey: pubB64, KeyToken: 'KT1' } });
  if (u2.pathname === '/platform/sign/signin2') {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      let pwd = ''; try { pwd = crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(String(JSON.parse(b)[1]), 'base64')).toString('utf8'); } catch (_) {}
      if (JSON.parse(b)[0] !== ACC || pwd !== PWD) return send({ success: false, message: '账号或密码错误' });
      validTk = 'stk-' + (++tkSeq);
      send({ success: true, data: { orgId: 'O1' } }, { token: validTk, moduleid: 'M1' });
    });
    return;
  }
  if (u2.pathname === '/api/logistics/inv/SyncOnhandQty') {
    if (req.headers.token !== validTk) return send({ success: false, message: '登录失效' });
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      const n = ((JSON.parse(b) || {}).mitemList || []).length;
      batches.push(n);
      send(syncMode === 'ok' ? { success: true, data: 1 } : { success: false, message: 'ERP侧繁忙' });
    });
    return;
  }
  send({ success: false, message: 'no route' });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const chkT = (n, c, why) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]${c ? '' : ' ←' + (why || '')}`); };
(async () => {
  await new Promise((r) => mock.listen(MPORT, '127.0.0.1', r));
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { SELFTEST_NO_LIVE: '1', ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; srv.stdout.on('data', (b) => { logs += b; });
  let up = false; for (let i = 0; i < 60 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health')).ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪'); srv.kill(); mock.close(); fs.rmSync(TDIR, { recursive: true, force: true }); process.exit(1); }
  const tok = async (u) => (await (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'E2e#Y4!' + u.slice(-1) }) })).json()).token;
  const tkA = await tok('u_ad'), tkM = await tok('u_mt');
  // 452 个编码，内含 2 个重复 → 期望去重后 450 → 分批 200/200/50
  const codes = []; for (let i = 0; i < 450; i++) codes.push('2626TEST' + String(i).padStart(4, '0'));
  codes.push(codes[0], codes[1]);
  try {
    // ⑥ 非管理员 403
    const r0 = await fetch(BASE + '/api/stock3/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tkM }, body: JSON.stringify({ mitemList: codes }) });
    chkT('⑥物料工触发→403', r0.status === 403, 'HTTP' + r0.status);
    // ①④ 全量受理 + 如实回执
    const r1 = await (await fetch(BASE + '/api/stock3/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tkA }, body: JSON.stringify({ mitemList: codes }) })).json();
    chkT('★④回执如实：受理450(去重生效)+批数3', r1.ok === true && /已受理 450 个/.test(r1.msg) && /3 批/.test(r1.msg), JSON.stringify(r1).slice(0, 140));
    // ③ 互斥：后台还在分批时再点
    const r2 = await (await fetch(BASE + '/api/stock3/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tkA }, body: JSON.stringify({ mitemList: ['X1'] }) })).json();
    chkT('③进行中再点→互斥拒绝不叠加', r2.ok === false && /仍在进行/.test(r2.msg || ''), JSON.stringify(r2).slice(0, 120));
    // 等后台跑完（3批=2间歇×2s+请求瞬时）
    await sleep(7000);
    chkT('★①mock收到3批=200/200/50(旧版会静默砍成只此一批200)', JSON.stringify(batches) === JSON.stringify([200, 200, 50]), 'batches=' + JSON.stringify(batches));
    chkT('⑤控制台进度如实', /\[sap-sync\] 管理员 全量450：成功450/.test(logs), logs.slice(-200).replace(/\n/g, ' | '));
    // ⑤a ops留痕文件含成功计数与批数（pushOps直写JSONL权威文件）
    let opsHit = '';
    try { const od = path.join(TDIR, 'ops'); for (const f of fs.readdirSync(od)) for (const l of fs.readFileSync(path.join(od, f), 'utf8').split('\n')) if (/SAP库存同步/.test(l)) opsHit = l; } catch (_) {}
    chkT('★⑤留痕成功450·分批3批可审计', /成功450/.test(opsHit) && /分批3批/.test(opsHit), opsHit.slice(0, 200));
    // ⑤b 互斥释放：完成后可再触发（切mock失败态验失败留痕）
    syncMode = 'fail';
    const r3 = await (await fetch(BASE + '/api/stock3/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tkA }, body: JSON.stringify({ mitemList: ['Z1', 'Z2'] }) })).json();
    chkT('⑤b完成后互斥已释放可再触发', r3.ok === true && /已受理 2 个/.test(r3.msg), JSON.stringify(r3).slice(0, 120));
    await sleep(2500);
    chkT('⑤c失败批如实留痕不谎报', /全量2：成功0 失败2/.test(logs), logs.slice(-200).replace(/\n/g, ' | '));
    console.log(`\n===== v284 SAP全量分批同步取证：${total - fail}/${total} PASS =====`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) { console.log('FAIL! 异常', e && e.stack || e); process.exitCode = 1; } finally { srv.kill(); mock.close(); await sleep(300); fs.rmSync(TDIR, { recursive: true, force: true }); }
})();
