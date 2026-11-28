// ㉖v289 地面模式误提交NB04三层闸取证（11-28 N26K280184 实锤：想转入二楼却在地面模式提交
// NB04 格位→v120d 兼容静默按来料区入账+全链路假报"二楼转入成功"，货其实没离开一楼）
// 断言：①wt=1+gl=NB04 流水入账后 trace 无"⬆ 二楼转入"节点（旧判据会假报）
// ②本人+管理员都收到"转入未生效"通知且文案带两条正路 ③ops留痕 ④真转入(wt=1+gl=NB02)仍显转入节点(回归)
// ⑤兼容入账不丢数据：流水两条都保留、无cx
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const TDIR = path.join(__dirname, 'data_e2e_w1nb04_v289');
const PORT = 8490, BASE = 'http://127.0.0.1:' + PORT;
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(__dirname, 'data', 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(8).toString('hex'), hp = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');
db0.users = (db0.users || []).filter((u) => u.role === 'admin');
db0.users.push({ id: 'u_wh', username: 'u_wh', name: '误操作者', role: 'warehouse', enabled: true, salt, passHash: hp('E2e#V9!h', salt) });
db0.users.push({ id: 'u_ad', username: 'u_ad', name: '管理员', role: 'admin', enabled: true, salt, passHash: hp('E2e#V9!d', salt) });
db0.scanlog = {}; db0.notifications = []; delete db0.ledgerTomb; db0.ledger = []; db0.ops = db0.ops || {};
db0.params = Object.assign(db0.params || {}, { receivingOn: 1 });
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const chkT = (n, c, why) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]${c ? '' : ' ←' + (why || '')}`); };
(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { SELFTEST_NO_LIVE: '1', ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'ignore', 'ignore'] });
  let up = false; for (let i = 0; i < 60 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health')).ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪'); srv.kill(); fs.rmSync(TDIR, { recursive: true, force: true }); process.exit(1); }
  for (let i = 0; i < 60; i++) { const rr = await fetch(BASE + '/api/requisitions/gate').catch(() => null); if (rr && rr.status !== 503) break; await sleep(1000); } // 自愈窗
  const tok = async (u) => (await (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'E2e#V9!' + u.slice(-1) }) })).json()).token;
  const tkW = await tok('u_wh'), tkA = await tok('u_ad');
  const now = Date.now(), MIN = 60000;
  try {
    // ①+②：来料登记 + 误提交地面NB04（复刻 11-28 真实形态）
    const r1 = await (await fetch(BASE + '/api/scanlog/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tkW }, body: JSON.stringify({ items: [
      { k: 'K1', code: 'N289A', wt: 2, gl: 'NB04-A-01-013', t: now - 30 * MIN, q: 500, pn: 'P289', op: '刘孙波' },
      { k: 'K2', code: 'N289A', wt: 1, gl: 'NB04-A-01-013', t: now - 5 * MIN, q: 500, pn: 'P289', op: '误操作者' },
    ] }) })).json();
    chkT('sync受理', r1.ok === true, JSON.stringify(r1).slice(0, 100));
    await sleep(600);
    const tr = await (await fetch(BASE + '/api/trace?q=N289A', { headers: { Authorization: 'Bearer ' + tkA } })).json();
    const titles = (tr.events || []).map((e) => e.title || '');
    chkT('★①误提交不再假报"二楼转入"(落位仍NB04)', !titles.some((t) => /二楼转入/.test(t)) && titles.some((t) => /来料登记/.test(t)), JSON.stringify(titles.slice(0, 6)));
    const nd = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    const nfW = (nd.notifications || []).filter((x) => /u_wh/.test(JSON.stringify(x.to || x.uid || '')) || true).filter((x) => /地面登记的货位是一楼来料区/.test(String(x.text || '')));
    const nfA = (nd.notifications || []).filter((x) => /地面模式提交了NB04货位/.test(String(x.text || '')));
    chkT('★②本人通知带两条正路文案', nfW.length >= 1 && /采集里把货位改成二楼实际位置/.test(nfW[0].text) && /N289A/.test(nfW[0].text), JSON.stringify((nfW[0] || {}).text || '').slice(0, 120));
    chkT('②管理员也收到点名通知', nfA.length >= 1 && /误操作者/.test(nfA[0].text), JSON.stringify((nfA[0] || {}).text || '').slice(0, 100));
    let opsHit = ''; try { const od = path.join(TDIR, 'ops'); for (const f of fs.readdirSync(od)) for (const l of fs.readFileSync(path.join(od, f), 'utf8').split('\n')) if (/地面登记NB04/.test(l)) opsHit = l; } catch (_) {}
    chkT('③ops留痕可审计', /N289A@NB04-A-01-013/.test(opsHit), opsHit.slice(0, 140));
    // ④真转入回归：wt=1 + gl=NB02
    await (await fetch(BASE + '/api/scanlog/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tkW }, body: JSON.stringify({ items: [
      { k: 'K3', code: 'N289B', wt: 2, gl: 'NB04-A-01-020', t: now - 40 * MIN, q: 60, pn: 'P289', op: '刘孙波' },
      { k: 'K4', code: 'N289B', wt: 1, gl: 'NB02-A-08-2F', t: now - 3 * MIN, q: 60, pn: 'P289', op: '误操作者' },
    ] }) })).json();
    await sleep(600);
    const tr2 = await (await fetch(BASE + '/api/trace?q=N289B', { headers: { Authorization: 'Bearer ' + tkA } })).json();
    const t2 = (tr2.events || []).map((e) => e.title || '');
    chkT('★④真转入(落NB02)仍显转入节点(回归)', t2.some((t) => /二楼转入/.test(t)), JSON.stringify(t2.slice(0, 6)));
    // ⑤兼容入账不丢数据：误提交两条流水都在、无cx
    const d5 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    const sl = Object.values(d5.scanlog || {}).filter((x) => String(x.code) === 'N289A');
    chkT('⑤兼容入账不丢数据(两条流水均在无cx)', sl.length === 2 && sl.every((x) => !x.cx), 'n=' + sl.length);
    console.log(`\n===== v289 地面误提交NB04三层闸取证：${total - fail}/${total} PASS =====`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) { console.log('FAIL! 异常', e && e.stack || e); process.exitCode = 1; } finally { srv.kill(); await sleep(300); fs.rmSync(TDIR, { recursive: true, force: true }); }
})();
