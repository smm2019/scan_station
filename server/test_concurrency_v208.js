// ㉖v208 领料单乐观并发（rev/lastAct/baseRev→409）端到端验证
// 用户实锤："两人同时备一张领料单，信息刷新不及时，这个是大问题"——后提交者把先提交者的
// 操作蒙眼盖掉（B 在 A 接单前就开着页面，B 提交时按旧页面状态改单，A 的成果被无声覆盖）。
// 机制：每单带 rev（每个改变单体的动作 +1）+ lastAct（谁/何时/哪个动作）；客户端提交带
//   baseRev=打开页面时的版本，服务器比对：
//   软模式(reqConcOn=0 默认)=照常执行但履历写"⚡并发提醒"点名（新旧版全兼容）；
//   硬模式(=1)=409 {code:'stale', req:最新单} 物理不落库；
//   不带 baseRev=旧版 APK/纯通知动作，原样放行（防误伤在网旧设备——排序安全：先软后硬）。
// ★ 为什么必须真跑：①"409 不落库"只有真读落库文件才能证明（内存态看不出 save 没跑）；
//   ②"并发双发只一成一"依赖收口处同步盖章的时序，静态审查无法证明；
//   ③旧版兼容（无 baseRev 放行+行为逐字同旧版）是现网安全契约，必须真发无字段请求验证。
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const TDIR = path.join(__dirname, '_conc_v208'), PORT = Number(process.env.HS_PORT || 9912);
const BASE = 'http://127.0.0.1:' + PORT;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + String(i).slice(0, 130) + ']' : ''}`); };
const post = async (p2, tk, body) => { const r = await fetch(BASE + p2, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: JSON.stringify(body || {}) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
const getj = async (p2, tk) => { const r = await fetch(BASE + p2, { headers: tk ? { Authorization: 'Bearer ' + tk } : {} }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
const PW = 'E2e#Hs!208';
const mkUser = (id, name, role) => { const salt = crypto.randomBytes(16).toString('hex'); return { id, username: name, name, role, enabled: true, createdAt: Date.now(), mustChangePw: false, salt, passHash: crypto.scryptSync(PW, salt, 32).toString('hex') }; };
(async () => {
  let srv;
  try {
    fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
    // 防呆（v208 复跑被坑实录）：上一轮实例未死透占着端口时，新实例绑不上端口，请求全打到
    // "库目录已删"的僵尸实例上=无响应卡死（本次超时的真实根因）。启动前先探测，占用即快速失败。
    // 判定：有响应=忙；1.2s 无响应(abort/timeout)=僵尸占端口=忙；连接被拒=端口空闲放行。
    const probe = await Promise.race([
      fetch(BASE + '/api/health', { signal: AbortSignal.timeout(1200) })
        .then(() => 'busy')
        .catch((e) => ((e && (e.name === 'AbortError' || e.name === 'TimeoutError')) ? 'busy' : 'free')),
      sleep(1800).then(() => 'free')
    ]);
    if (probe === 'busy') throw new Error('端口 ' + PORT + ' 被残留实例占用（上一轮测试未死透）——请先结束该 node/server.js 进程，或用 HS_PORT=其他端口 重跑');
    const db0 = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'db.json'), 'utf8'));
    const U1 = mkUser('u_hs_ca', '并发仓A', 'warehouse'), U2 = mkUser('u_hs_cb', '并发仓B', 'warehouse'), UA = mkUser('u_hs_adm', '并发管理', 'admin');
    db0.users.push(U1, U2, UA);
    db0.params = Object.assign(db0.params || {}, { receivingOn: 0, reqHoursOn: 0 }); // 并发开关不注入=默认0(软)
    db0.wmasConfig = null; db0.rcsConfig = null; db0.rcsStations = {}; db0.agvQueue = [];
    const RID = 'req_conc_v208';
    db0.requisitions = [{ id: RID, no: 'LL208TEST0001', by: 'u_outsider', byName: '测试物料员', items: [{ partNo: 'T208PART01', itemName: '并发测试件', qty: 10, issued: [] }], status: 'pending', remark: '', createdAt: new Date().toISOString(), history: [] }];
    fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
    srv = cp.spawn(process.execPath, ['server.js'], { cwd: __dirname, env: Object.assign({}, process.env, { SELFTEST_NO_LIVE: '1', PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }), stdio: ['ignore', 'pipe', 'pipe'] });
    // 防孤儿（v208 复跑被坑实录·根因）：外层 runner 被杀时子实例会存活占端口，坑死下一轮。
    // 任何退出路径（正常/异常/被外部 SIGTERM/总时限）都按进程树强杀。
    const killTree = () => { try { if (srv && srv.exitCode === null) cp.execSync(`taskkill /pid ${srv.pid} /T /F`, { stdio: 'ignore', windowsHide: true }); } catch (_) {} };
    const suicide = setTimeout(() => { console.log('❌ 总时限 120s 到，强制收网'); killTree(); process.exit(1); }, 120000);
    process.on('exit', () => { clearTimeout(suicide); killTree(); });
    process.on('SIGTERM', () => process.exit(1));
    process.on('SIGINT', () => process.exit(1));
    let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(600) })).ok; } catch (_) {} }
    C('护栏 实例就绪', up); if (!up) throw new Error('实例未起');
    const tkA = (await post('/api/login', null, { username: '并发仓A', password: PW, dev: 'CA', kind: 'pda' })).json.token;
    const tkB = (await post('/api/login', null, { username: '并发仓B', password: PW, dev: 'CB', kind: 'pda' })).json.token;
    const tkAdm = (await post('/api/login', null, { username: '并发管理', password: PW, dev: 'AD', kind: 'pda' })).json.token;
    C('护栏 三账号登录', !!tkA && !!tkB && !!tkAdm);
    const ACT = (tk, act, body) => post(`/api/requisitions/${RID}/${act}`, tk, body);
    const locB = (loc, ext) => Object.assign({ locCode: loc, warehouseCode: 'WH', districtCode: 'D' }, ext || {});
    const readDb = () => { const d = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8')); return (d.requisitions || []).find(x => x.id === RID) || {}; };
    // ── ① 新机制首动作：baseRev=0 与初始态一致 → 成功且盖版本+操作人戳 ──
    const g0 = await getj(`/api/requisitions/${RID}`, tkA);
    C('① 初始单无版本（rev 视作 0）', (g0.json.req || {}).rev === undefined || (g0.json.req || {}).rev === 0);
    const a1 = await ACT(tkA, 'loc', locB('V1', { baseRev: 0 }));
    C('★★★ ① 带正确 baseRev 成功，响应带 rev=1 + lastAct 点名(A/loc)', a1.json.req && a1.json.req.rev === 1 && a1.json.req.lastAct && a1.json.req.lastAct.by === U1.id && a1.json.req.lastAct.act === 'loc', JSON.stringify((a1.json.req || {}).lastAct));
    await sleep(600);
    let dr = readDb();
    C('★★ ① 版本与戳随落库持久（重启不丢）', dr.rev === 1 && dr.lastAct && dr.lastAct.name === '并发仓A', 'rev=' + dr.rev);
    // ── ② 软模式（默认）：B 拿着过期 baseRev=0 提交 → 照常执行，履历⚡点名 A ──
    const hLen0 = (readDb().history || []).length;
    const a2 = await ACT(tkB, 'loc', locB('V2', { baseRev: 0 }));
    await sleep(600); dr = readDb();
    C('★★★ ② 软模式不误伤：过期 baseRev 仍 200 且照常落库(V2/rev=2)', a2.status === 200 && a2.json.ok === true && dr.rev === 2 && ((dr.toLoc || {}).LOC_CODE) === 'V2', 'st=' + a2.status + ' rev=' + dr.rev);
    const warn = (dr.history || []).slice(hLen0).find(h => String(h.text || '').includes('⚡并发提醒'));
    C('★★★ ② 履历留痕点名"谁在什么时候动过"（软模式审计线索）', !!warn && warn.text.includes('并发仓A'), JSON.stringify((warn || {}).text || ''));
    // ── ③ 旧版 APK 兼容：请求体不带 baseRev → 行为逐字同旧版，但版本照常盖 ──
    const a3 = await ACT(tkA, 'loc', locB('V3'));
    await sleep(600); dr = readDb();
    C('★★★ ③ 旧版无 baseRev 原样放行（现网旧 APK 零影响）且 rev 连续+1', a3.status === 200 && a3.json.ok === true && dr.rev === 3 && ((dr.toLoc || {}).LOC_CODE) === 'V3', 'st=' + a3.status + ' rev=' + dr.rev);
    // ── ④ 开硬拦开关（模拟两端 PDA 都升级后运维在设置页开启）──
    const sw = await post('/api/admin/params', tkAdm, { values: { reqConcOn: 1 } });
    C('护栏 管理员开启并发硬拦', sw.json.ok === true, JSON.stringify(sw.json).slice(0, 80));
    // ── ⑤ 硬模式：B 过期 baseRev=1 → 409 且物理不落库、附最新单 ──
    const pre = readDb(); const hLen1 = (pre.history || []).length;
    const a5 = await ACT(tkB, 'loc', locB('V_BAD', { baseRev: 1 }));
    await sleep(600); dr = readDb();
    C('★★★ ⑤ 硬拦：过期提交退回 409 code=stale', a5.status === 409 && a5.json.code === 'stale', 'st=' + a5.status + ' code=' + a5.json.code);
    C('★★★ ⑤ 物理不落库：库内 toLoc/rev/history 三者纹丝未动', ((dr.toLoc || {}).LOC_CODE) === 'V3' && dr.rev === pre.rev && (dr.history || []).length === hLen1, 'toLoc=' + (dr.toLoc || {}).LOC_CODE + ' rev=' + dr.rev);
    C('★★ ⑤ 409 附最新单（客户端拿来直接刷新）+ 消息点名操作人', a5.json.req && ((a5.json.req.toLoc || {}).LOC_CODE) === 'V3' && a5.json.req.rev === pre.rev && /并发仓A/.test(a5.json.msg || ''), JSON.stringify(a5.json.msg || '').slice(0, 110));
    // ── ⑥ 硬模式下带正确 rev 的提交不受任何影响 ──
    const a6 = await ACT(tkA, 'loc', locB('V4', { baseRev: 3 }));
    await sleep(600); dr = readDb();
    C('★★ ⑥ 硬模式≠禁用：baseRev 一致照常成功 rev=4', a6.status === 200 && dr.rev === 4 && ((dr.toLoc || {}).LOC_CODE) === 'V4', 'st=' + a6.status + ' rev=' + dr.rev);
    // ── ⑦ 并发双发（同一过期 baseRev 背靠背同射）：恰好一成一 409，版本只涨一次 ──
    const both = await Promise.all([ACT(tkA, 'rush', { rush: true, baseRev: 4 }), ACT(tkB, 'rush', { rush: true, baseRev: 4 })]);
    const okN = both.filter(x => x.status === 200).length, st409 = both.filter(x => x.status === 409).length;
    C('★★★ ⑦ 双设备同射同一动作：恰好一成一 409（覆盖互斥的物理保证）', okN === 1 && st409 === 1, both.map(x => x.status).join('/'));
    await sleep(600); dr = readDb();
    C('★★★ ⑦ 版本恰好 +1（无重复盖章），lastAct=胜出者', dr.rev === 5 && (dr.lastAct.name === '并发仓A' || dr.lastAct.name === '并发仓B'), 'rev=' + dr.rev + ' by=' + (dr.lastAct || {}).name);
    // ── ⑧ 收口验证：验证进程健康（改动未伤及主循环）──
    C('★ 进程存活', (await fetch(BASE + '/api/health')).ok === true);
  } catch (e) { total++; fail++; console.log('❌ 异常：' + e.message); }
  finally {
    if (srv) try { srv.kill(); } catch (_) {}
    await sleep(500);
    try { fs.rmSync(TDIR, { recursive: true, force: true }); } catch (_) {}
  }
  console.log('\n结果: ' + (total - fail) + ' 通过 / ' + fail + ' 失败  （隔离副本，生产库零写入）');
  process.exit(fail ? 1 : 0);
})();
