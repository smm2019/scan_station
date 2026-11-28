// ㉖v281 未上账告警条件降噪取证（11-26 三连"推送中·重试0次"吵、且不许漏报的落地验证）
// 设计：首诊13秒巡检同一轮验三分支（diagPulse 预烤快照=心跳新鲜）：
//  A(滞留3.5min,三闸健康) → 宽限静默：不告警★且 seen 去重标记不写（防漏报洞）
//  B(滞留3.5min,无诊断快照) → 闸1失守 → 必达告警
//  C(滞留7min≥宽限6,即便健康) → 超窗必达
// 另验：pulse 搭车字段 pushSeqAt/trace 落存（服务器三闸数据源）。
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const TDIR = path.join(__dirname, 'data_e2e_grace_v281');
const PORT = 8481, BASE = 'http://127.0.0.1:' + PORT;
const MIN = 60000;
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(__dirname, 'data', 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(8).toString('hex'), hp = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');
const mkU = (id, name, role) => db0.users.push({ id, username: id, name, role, enabled: true, salt, passHash: hp('E2e#G1!' + id.slice(-1), salt) });
mkU('u_ga', '管理员甲', 'admin'); mkU('u_gb', '测试者甲', 'material'); mkU('u_gc', '测试者丙', 'material');
db0.params = Object.assign(db0.params || {}, { fullAlertOn: 1, fullAlertAgeMin: 2, fullAlertGraceMin: 6 });
// 测试流水独占（生产副本 scanlog 清空防历史滞留干扰；测试码三行，账本/出库/墓碑均无）
const now = Date.now();
db0.scanlog = {
  k1: { code: 'V281A000001', gl: 'NB03-E-13-01', op: '测试者甲', t: now - 3.5 * MIN, cx: false, q: 10 },
  k2: { code: 'V281B000002', gl: 'NB03-E-14-01', op: '测试者乙', t: now - 3.5 * MIN, cx: false, q: 10 }, // 乙无账号无快照=闸1失守
  k3: { code: 'V281C000003', gl: 'NB03-E-15-01', op: '测试者丙', t: now - 7 * MIN, cx: false, q: 10 },
};
delete db0.fullAlert;
// 预烤诊断快照：甲=三闸健康（心跳/推进戳都新鲜，spawn 前一刻盖章）；丙=健康但超窗；乙故意缺席
db0.diagPulse = {
  '测试者甲': { at: now, who: '测试者甲', pending: true, retryN: 0, pushSeqAt: now, lastOkAt: now - 60000, trace: 'x' },
  '测试者丙': { at: now, who: '测试者丙', pending: true, retryN: 0, pushSeqAt: now, lastOkAt: now - 60000 },
};
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const chkT = (n, c, why) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]${c ? '' : ' ←' + (why || '')}`); };
(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { SELFTEST_NO_LIVE: '1', ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; srv.stdout.on('data', (b) => { logs += b; });
  let up = false; for (let i = 0; i < 60 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health')).ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪'); srv.kill(); fs.rmSync(TDIR, { recursive: true, force: true }); process.exit(1); }
  for (let i = 0; i < 60; i++) { const _gr = await fetch(BASE + '/api/requisitions/gate').catch(() => null); if (_gr && _gr.status !== 503) break; await sleep(1000); } // ㉖自愈窗等待：sweep自检在RCS慢日拖20秒+（11-28实锤），不等窗后续断言全空跑
  await sleep(14000); // 首诊13秒巡检（预烤快照此时 at≈14秒前=新鲜、甲滞留3.5min在宽限窗内）
  const tok = async (u) => (await (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'E2e#G1!' + u.slice(-1) }) })).json()).token;
  const tkA = await tok('u_gb'), tkAdm = await tok('u_ga');
  try {
    // ① 通知：B/C 必达在列，A 静默不在列
    const nf = (await (await fetch(BASE + '/api/notifications?all=1', { headers: { Authorization: 'Bearer ' + tkAdm } })).json());
    const txt = JSON.stringify(nf);
    chkT('★B无诊断快照→必达告警', txt.includes('V281B000002'), '通知缺B');
    chkT('★C滞留7min超宽限→健康也必达', txt.includes('V281C000003'), '通知缺C');
    chkT('★A三闸健康+宽限窗内→静默不告警', !txt.includes('V281A000001'), 'A被误报=降噪失效');
    // ② 静默不写 seen（漏报洞检查）：退出前触发落盘后读盘验证
    const dv = await (await fetch(BASE + '/api/diag/devices', { headers: { Authorization: 'Bearer ' + tkAdm } })).json();
    const da = (dv.devices || []).find((x) => x.who === '测试者甲') || {};
    chkT('②搭车字段落存(pushSeqAt/trace)', Number(da.pushSeqAt) > 0 && typeof da.trace === 'string', JSON.stringify(da).slice(0, 140));
    // ③ pulse 更新链（登录用户 pushSeqAt/trace 写入快照）
    await fetch(BASE + '/api/diag/pulse', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tkA }, body: JSON.stringify({ diag: { pending: true, retryN: 0, pushSeqAt: Date.now(), trace: '18:40:01|排期15s;18:40:16|发起sync(1行/0删)' } }) });
    await sleep(1200);
    const dv2 = await (await fetch(BASE + '/api/diag/devices', { headers: { Authorization: 'Bearer ' + tkAdm } })).json();
    const da2 = (dv2.devices || []).find((x) => x.who === '测试者甲') || {};
    chkT('③pulse更新pushSeqAt且trace≤200字符', Number(da2.pushSeqAt) > Number(da.pushSeqAt || 0) && /发起sync/.test(da2.trace || '') && (da2.trace || '').length <= 200, JSON.stringify(da2.trace || '').slice(0, 120));
    // ④ seen 标记：B/C 已写（7天不重复吵）、A 未写（静默轮零污染）
    srv.kill(); await sleep(1500); // SIGTERM gracefulExit 落盘
    const dfin = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    const fa = dfin.fullAlert || {};
    chkT('★④静默码不写seen去重(重启不永久静默)', !fa.V281A000001 && (fa.V281B000002 || fa.V281C000003), JSON.stringify(fa).slice(0, 220));
    console.log(`\n===== v281 未上账条件降噪取证：${total - fail}/${total} PASS =====`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) { console.log('FAIL! 异常', e && e.stack || e); process.exitCode = 1; } finally { srv.kill(); await sleep(300); fs.rmSync(TDIR, { recursive: true, force: true }); }
})();
