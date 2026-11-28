// ㉖v291 分格撞账本推送盲窗根治+拦截上报 取证（11-28 18:12 E-09-29 实锤：297 18:11:31登记、
// 账本30秒防抖未达，301分格仍见29空→保存时被合放闸拦下→手工改选31/33才入账）
// 断言：①地面分格避让"流水已占"格（账本无行）②自身流水不挡自己 ③同托双码流水可共格
// ④异托同件流水保守避让 ⑤NB04分格同避让 ⑥过期流水(>2min)不再挡 ⑦作废流水不挡
// ⑧errlog接收"拦截"类（上报白名单服务端侧兼容）
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const TDIR = path.join(__dirname, 'data_e2e_slotblind_v291');
const PORT = 8495, BASE = 'http://127.0.0.1:' + PORT;
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(__dirname, 'data', 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(8).toString('hex'), hp = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');
db0.users = (db0.users || []).filter((u) => u.role === 'admin');
db0.users.push({ id: 'u_wh', username: 'u_wh', name: '仓管甲', role: 'warehouse', enabled: true, salt, passHash: hp('E2e#S1!h', salt) });
db0.features = db0.features || {}; db0.features.warehouse = Object.assign(db0.features.warehouse || {}, { collect: true });
db0.params = Object.assign(db0.params || {}, { receivingOn: 1, gndCols: 40 });
const now = Date.now();
db0.ledger = []; db0.locReserve = {};
// 流水证据：01格被他框新鲜流水占（账本无行）；02格被本框自身流水占；03格同托双码流水；04格异托同件；05格过期流水；06格作废流水
db0.scanlog = {
  s1: { code: 'V291X', wt: 1, gl: 'NB03-E-09-01', t: now - 30000, cx: false, pn: 'P291', q: 100, pid: '' },
  s2: { code: 'V291SELF', wt: 1, gl: 'NB03-E-09-02', t: now - 30000, cx: false, pn: 'P291', q: 100, pid: '' },
  s3: { code: 'V291SIB', wt: 1, gl: 'NB03-E-09-03', t: now - 30000, cx: false, pn: 'P291', q: 100, pid: 'TP1' },
  s4: { code: 'V291OTHER', wt: 1, gl: 'NB03-E-09-04', t: now - 30000, cx: false, pn: 'P291', q: 100, pid: 'TP2' },
  s5: { code: 'V291OLD', wt: 1, gl: 'NB03-E-09-05', t: now - 300000, cx: false, pn: 'P291', q: 100, pid: '' },
  s6: { code: 'V291CX', wt: 1, gl: 'NB03-E-09-06', t: now - 30000, cx: true, pn: 'P291', q: 100, pid: '' },
  s7: { code: 'V291R', wt: 1, gl: 'NB04-A-01-001', t: now - 30000, cx: false, pn: 'P291', q: 100, pid: '' },
};
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const chkT = (n, c, why) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]${c ? '' : ' ←' + (why || '')}`); };
(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { SELFTEST_NO_LIVE: '1', ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'ignore', 'ignore'] });
  let up = false; for (let i = 0; i < 60 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health')).ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪'); srv.kill(); fs.rmSync(TDIR, { recursive: true, force: true }); process.exit(1); }
  for (let i = 0; i < 60; i++) { const rr = await fetch(BASE + '/api/requisitions/gate').catch(() => null); if (rr && rr.status !== 503) break; await sleep(1000); }
  const tok = async (u) => (await (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'E2e#S1!' + u.slice(-1) }) })).json()).token;
  const tk = await tok('u_wh');
  const rsv = (body) => fetch(BASE + '/api/ledger/reserve', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tk }, body: JSON.stringify(body) }).then((r) => r.json());
  try {
    // ① 新框分格：01被流水占→应跳过01；02无他框流水→落02（自身码无关）
    const a = await rsv({ code: 'V291NEW', partNo: 'P291', zone: 'E9' });
    chkT('★①分格避让流水已占01格(账本无行;落05=同件集中规则合法)', a.ok === true && a.loc !== 'NB03-E-09-01' && a.loc === 'NB03-E-09-05', JSON.stringify(a).slice(0, 120));
    // ② 自身流水不挡：SELF 请求应复用02? 02已被NEW预占→SELF应落03? 03同托TP1≠SELF无pid→挡; 落07? 04异托挡05过期不挡→05
    const b = await rsv({ code: 'V291SELF', partNo: 'P291', zone: 'E9' });
    chkT('★②自身流水不挡自己(SELF落02=自己刚占的格)', b.ok === true && b.loc === 'NB03-E-09-02', JSON.stringify(b).slice(0, 120));
    // ③ 同托双码：SIB2 pid=TP1 与03格流水同托→可共格03（若03未被预占）
    const c = await rsv({ code: 'V291SIB2', partNo: 'P291', zone: 'E9', pid: 'TP1' });
    chkT('★③同托双码流水可共格03', c.ok === true && c.loc === 'NB03-E-09-03', JSON.stringify(c).slice(0, 120));
    // ④ 异托同件保守避让：OTHER2 pid=TP3 →04挡；落06(作废不挡)
    const d = await rsv({ code: 'V291OTH2', partNo: 'P291', zone: 'E9', pid: 'TP3' });
    chkT('④异托同件保守避让04(落06作废格不挡)', d.ok === true && d.loc !== 'NB03-E-09-04' && d.loc === 'NB03-E-09-06', JSON.stringify(d).slice(0, 120));
    // ⑤ NB04：001被流水占→落002
    const e = await rsv({ code: 'V291R2', partNo: 'P291', recv: 1 });
    chkT('★⑤NB04分格避让流水已占001', e.ok === true && e.loc === 'NB04-A-01-002', JSON.stringify(e).slice(0, 120));
    // ⑧ errlog 接收拦截类
    const f = await fetch(BASE + '/api/errlog', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tk }, body: JSON.stringify({ dev: 'PDA-TEST', app: '1.0.0+226', items: [{ t: new Date().toString(), e: '拦截', u: '仓管甲', d: '合放拦截 NB03-E-09-29 已有框V291X' }] }) }).then((r) => r.json());
    let dd = {}; let hit = false; for (let i = 0; i < 20 && !hit; i++) { await sleep(250); dd = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8')); hit = (dd.errLogs || []).some((x) => (x.items || []).some((i2) => i2.e === '拦截' && /合放拦截/.test(i2.d || ''))); } // save防抖轮询读盘
    chkT('⑧errlog落库拦截类可查', f.ok === true && hit, JSON.stringify(f).slice(0, 80));
    console.log(`\n===== v291 分格盲窗根治+拦截上报取证：${total - fail}/${total} PASS =====`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) { console.log('FAIL! 异常', e && e.stack || e); process.exitCode = 1; } finally { srv.kill(); await sleep(300); fs.rmSync(TDIR, { recursive: true, force: true }); }
})();
