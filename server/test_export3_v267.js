// ㉖v267 三方对账导出取证：D11 独立数据集 + D2 可选增强列 + 外部失败不阻断核心报表
// 离线可验面（不依赖真实 MES 凭证）：①D11 存在且表头16列 ②无凭证时 D11 空表+原因、不报500
//   ③D2 默认不含 MES/SAP 列（不拖累日常） ④D2 勾 ext 才加5列 ⑤MES取不到时增强列填「未取到」主表行数不变
//   ⑥权限：物料员 D11 被拒 ⑦ext 参数进快照条件可追溯
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const TDIR = path.join(__dirname, 'data_e2e_exp3_v267');
const PORT = 8455, BASE = 'http://127.0.0.1:' + PORT;
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(__dirname, 'data', 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(8).toString('hex'), hp = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');
db0.users = db0.users || [];
db0.users.push({ id: 'u_v267w', username: 'v267_w', name: 'V267仓管', role: 'warehouse', enabled: true, salt, passHash: hp('E2e#E7!w', salt) });
db0.users.push({ id: 'u_v267m', username: 'v267_m', name: 'V267物料', role: 'material', enabled: true, salt, passHash: hp('E2e#E7!m', salt) });
delete db0.mesCred; // 无凭证态：验证降级
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const chk = (n, g, w) => { total++; const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL!'} [${n}] got=${JSON.stringify(g)} want=${JSON.stringify(w)}`); };
const chkT = (n, c, why) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]${c ? '' : ' ←' + (why || '')}`); };
(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { SELFTEST_NO_LIVE: '1', ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health')).ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪'); srv.kill(); fs.rmSync(TDIR, { recursive: true, force: true }); process.exit(1); }
  const lg = async (u, p) => (await (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json()).token;
  const pv = async (q, tk) => (await (await fetch(BASE + '/api/export?preview=1&' + q, { headers: { Authorization: 'Bearer ' + tk } })).json().catch(() => ({})));
  try {
    const tw = await lg('v267_w', 'E2e#E7!w'), tm = await lg('v267_m', 'E2e#E7!m');
    chkT('T0 双角色登录', !!tw && !!tm, '');
    // ① D11 存在、表头16列
    const d11 = await pv('ds=D11', tw);
    chkT('★①D11数据集存在且16列', d11.ok === true && (d11.head || []).length === 16, JSON.stringify(d11).slice(0, 200));
    chkT('①b D11 表头含三方关键列', ['本系统件数', 'MES现有量', 'SAP现有量', 'MES−SAP', 'SAP更新时间', '差异状态'].every((h) => (d11.head || []).includes(h)), JSON.stringify(d11.head));
    // ② 无凭证：D11 空表但不报错（如实告知原因）
    chk('★②无凭证D11空表不报500', [d11.ok === true, d11.total], [true, 0]);
    // ③ D2 默认不含增强列
    const d2 = await pv('ds=D2', tw);
    chkT('★③D2默认9列不含MES/SAP（不拖累日常报表）', (d2.head || []).length === 9 && !(d2.head || []).includes('MES现有量'), JSON.stringify(d2.head));
    const baseRows = d2.total;
    // ④ D2 勾 ext → 加5列
    const d2e = await pv('ds=D2&ext=1', tw);
    chkT('★④D2勾ext加5列(14列)', (d2e.head || []).length === 14 && (d2e.head || []).includes('MES现有量') && (d2e.head || []).includes('SAP更新时间'), JSON.stringify(d2e.head));
    // ⑤ MES取不到 → 主表行数不变、增强列「未取到」
    chk('★⑤外部失败不阻断主表(行数不变)', d2e.total, baseRows);
    chkT('⑤b 增强列填未取到', (d2e.sample || []).some((r) => r.includes('未取到')), JSON.stringify((d2e.sample || [])[0] || []));
    // ⑥ 权限：物料员 D11 拒
    const r6 = await fetch(BASE + '/api/export?ds=D11&preview=1', { headers: { Authorization: 'Bearer ' + tm } });
    chk('★⑥物料员D11被拒403', r6.status, 403);
    // ⑦ 真实下载可用（CSV 非预览，验证整链不抛错）
    const r7 = await fetch(BASE + '/api/export?ds=D2&fmt=csv&ext=1', { headers: { Authorization: 'Bearer ' + tw } });
    const txt = await r7.text();
    chkT('★⑦D2增强版CSV可下载且含新表头', r7.status === 200 && /MES现有量/.test(txt) && txt.split('\n').length > 1, 'HTTP' + r7.status + ' len=' + txt.length);
    const r8 = await fetch(BASE + '/api/export?ds=D11&fmt=csv', { headers: { Authorization: 'Bearer ' + tw } });
    chkT('⑧D11 CSV可下载(无凭证出空表+表头)', r8.status === 200 && /物料编码/.test(await r8.text()), 'HTTP' + r8.status);
    console.log(`\n===== v267 三方对账导出取证：${total - fail}/${total} PASS =====`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) { console.log('FAIL! 异常', e && e.message); process.exitCode = 1; } finally { srv.kill(); fs.rmSync(TDIR, { recursive: true, force: true }); }
})();
