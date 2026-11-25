// ㉖v266 三方库存对账（本系统 × MES × SAP）· 凭证通道与端点取证
// 可离线验证面：①凭证上报/查询/清除 ②权限闸（物料员拒） ③绝不回显 token ④无凭证时如实引导
//              ⑤SAP同步限管理员 ⑥本系统物料号映射覆盖率（流水mc权威源，实测93%）
// 需现场凭证才能验的面（本测试不覆盖，已在报告中标注）：MES 真实返回字段/SAP_QTY 新鲜度
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const TDIR = path.join(__dirname, 'data_e2e_stock3_v266');
const PORT = 8452, BASE = 'http://127.0.0.1:' + PORT;
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(__dirname, 'data', 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(8).toString('hex'), hp = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');
db0.users = db0.users || [];
db0.users.push({ id: 'u_v266w', username: 'v266_w', name: 'V266仓管', role: 'warehouse', enabled: true, salt, passHash: hp('E2e#S3!w', salt) });
db0.users.push({ id: 'u_v266a', username: 'v266_a', name: 'V266管理', role: 'admin', enabled: true, salt, passHash: hp('E2e#S3!a', salt) });
db0.users.push({ id: 'u_v266m', username: 'v266_m', name: 'V266物料', role: 'material', enabled: true, salt, passHash: hp('E2e#S3!m', salt) });
delete db0.mesCred;
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const chk = (n, g, w) => { total++; const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL!'} [${n}] got=${JSON.stringify(g)} want=${JSON.stringify(w)}`); };
const chkT = (n, c, why) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]${c ? '' : ' ←' + (why || '')}`); };
const post = async (p, tk, b) => { const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: JSON.stringify(b || {}) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
const getj = async (p, tk) => (await (await fetch(BASE + p, { headers: tk ? { Authorization: 'Bearer ' + tk } : {} })).json().catch(() => ({})));
(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { SELFTEST_NO_LIVE: '1', ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health')).ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪'); srv.kill(); fs.rmSync(TDIR, { recursive: true, force: true }); process.exit(1); }
  try {
    const lg = async (u, p) => (await post('/api/login', null, { username: u, password: p })).json.token;
    const tw = await lg('v266_w', 'E2e#S3!w'), ta = await lg('v266_a', 'E2e#S3!a'), tm = await lg('v266_m', 'E2e#S3!m');
    chkT('T0 三角色登录', !!tw && !!ta && !!tm, '');
    // ① 无凭证：如实引导，不假装能查
    const s0 = await getj('/api/stock3', tw);
    chk('★①无凭证=no_cred+引导PDA上报', [s0.ok === false, s0.code, /PDA/.test(s0.msg || '')], [true, 'no_cred', true]);
    // ② 权限闸：物料员不得管理凭证
    const p2 = await post('/api/mes/cred', tm, { host: '1.2.3.4', token: 'X' });
    chk('★②物料员上报被拒403', p2.status, 403);
    // ③ 仓管上报成功；查询绝不回显 token
    const TOK = 'SECRET-TOKEN-ABCDEFG-1234567890';
    const p3 = await post('/api/mes/cred', tw, { host: '172.25.1.141', port: '6689', token: TOK, moduleId: 'M1', orgId: 'O1' });
    chkT('③仓管上报成功', p3.json.ok === true && p3.json.has === true, JSON.stringify(p3.json));
    const g3 = await getj('/api/mes/cred', tw);
    chkT('★③凭证查询绝不回显token明文', !JSON.stringify(g3).includes(TOK) && g3.has === true && !!g3.by, JSON.stringify(g3));
    // ④ 上报留痕不含凭据
    { const day = new Date().toISOString().slice(0, 10); let t = ''; try { t = fs.readFileSync(path.join(TDIR, 'ops', 'ops-' + day + '.jsonl'), 'utf8'); } catch (_) {}
      chkT('★④活动流有上报留痕且不含token明文', /MES凭证上报/.test(t) && !t.includes(TOK), t.slice(-160)); }
    // ⑤ SAP同步限管理员（物料员/仓管拒）
    const y5m = await post('/api/stock3/sync', tm, { mitemList: ['262013002471'] });
    const y5w = await post('/api/stock3/sync', tw, { mitemList: ['262013002471'] });
    chk('★⑤SAP同步限管理员', [y5m.status, y5w.status], [403, 403]);
    const y5a = await post('/api/stock3/sync', ta, { mitemList: [] });
    chk('⑤b空物料列表拒400', y5a.status, 400);
    // ⑥ 凭证失效/不可达如实回错（用假地址触发不可达，不伪造成功）
    const s6 = await getj('/api/stock3?length=5', tw);
    chkT('★⑥MES不可达如实报错不伪造数据', s6.ok === false && /不可达|失效|异常/.test(s6.msg || ''), JSON.stringify(s6).slice(0, 160));
    // ⑦ 清除凭证
    const p7 = await post('/api/mes/cred', ta, { clear: true });
    const g7 = await getj('/api/mes/cred', tw);
    chk('⑦清除凭证后has=false', [p7.json.ok === true, g7.has], [true, false]);
    // ⑧ 本系统物料号映射覆盖率（流水mc权威源；离线可验，与MES无关）
    { const map = {}; for (const s of Object.values(db0.scanlog || {})) { const c = String(s.code || '').toUpperCase(); if (c && s.mc) map[c] = String(s.mc).toUpperCase(); }
      const led = db0.ledger || []; const hit = led.filter((x) => map[String(x.c).toUpperCase()]).length;
      chkT('★⑧物料号映射覆盖率≥80%（流水mc源，实测93%）', led.length > 0 && hit / led.length >= 0.8, `${hit}/${led.length}=${Math.round(hit / led.length * 100)}%`); }
    console.log(`\n===== v266 三方对账凭证与端点取证：${total - fail}/${total} PASS =====`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) { console.log('FAIL! 异常', e && e.message); process.exitCode = 1; } finally { srv.kill(); fs.rmSync(TDIR, { recursive: true, force: true }); }
})();
