// ㉖v210 出库单接口 pn 过滤（过滤先于 500 条截断）端到端验证
// 用户实锤（零件档案页截图 11-20）：6608068396 档案卡"累计出库 2620（13框）· 账外31框"，
// 同页图表"90天 出 9326 件"——档案卡少报 72%，被截掉的老单还全被误判成账外框。
// 根因：/api/outbound 按时间倒序 slice(0,500)，全库 1771 单只下发最新 500 单；
//   该零件涉及 16 单，仅 5 单落在前 500 内（合计恰好 2620）。档案页拼数因此缺 11 张老单。
// 修复：新增 pn= 精确过滤，且必须排在 slice(0,500) 之前。
// ★ 必须真跑：①"过滤先于截断"只有真起服务真发请求才能证明——代码顺序静态看着都对，
//   但若误把 filter 写在 map/slice 之后就完全无效；②无 pn 时必须与旧版逐字一致（列表页零回归）；
//   ③count 字段语义（过滤后总数 vs 实发条数）要真验，PDA/网页两处消费方依赖它。
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const TDIR = path.join(__dirname, '_obpn_v210'), PORT = Number(process.env.HS_PORT || 9935);
const BASE = 'http://127.0.0.1:' + PORT;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + String(i).slice(0, 130) + ']' : ''}`); };
const getj = async (p2, tk) => { const r = await fetch(BASE + p2, { headers: tk ? { Authorization: 'Bearer ' + tk } : {} }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
const PN = '6608068396';
(async () => {
  let srv;
  const killTree = () => { try { if (srv && srv.exitCode === null) cp.execSync(`taskkill /pid ${srv.pid} /T /F`, { stdio: 'ignore', windowsHide: true }); } catch (_) {} };
  try {
    fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
    const probe = await Promise.race([
      fetch(BASE + '/api/health', { signal: AbortSignal.timeout(1200) }).then(() => 'busy')
        .catch((e) => ((e && (e.name === 'AbortError' || e.name === 'TimeoutError')) ? 'busy' : 'free')),
      sleep(1800).then(() => 'free')
    ]);
    if (probe === 'busy') throw new Error('端口 ' + PORT + ' 被占用——用 HS_PORT=其他端口 重跑');
    // 用生产库真实副本：本测试的意义就在真实数据量（1771 单 > 500）上验证截断被绕过
    const db0 = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'db.json'), 'utf8'));
    const salt = crypto.randomBytes(16).toString('hex'), PW = 'E2e#Hs!210';
    db0.users.push({ id: 'u_hs_ob_adm', username: '出库测试管理', name: '出库测试管理', role: 'admin', enabled: true, createdAt: Date.now(), mustChangePw: false, salt, passHash: crypto.scryptSync(PW, salt, 32).toString('hex') });
    db0.wmasConfig = null; db0.rcsConfig = null;
    fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
    // 离线基准：不依赖服务端，独立算出该零件全量出库件数/单数，作为"修好后应等于"的锚
    const allObs = Object.values(db0.outbound || {});
    let baseQ = 0, baseN = 0;
    for (const o of allObs) for (const it of (o.items || [])) if (String(it.code || '').toUpperCase() === PN) { baseQ += Number(it.qty) || 0; }
    baseN = allObs.filter((o) => (o.items || []).some((i) => String(i.code || '').toUpperCase() === PN)).length;
    C('护栏 数据前提成立（出库单总数 > 500，否则测不出截断）', allObs.length > 500, '总数=' + allObs.length);
    srv = cp.spawn(process.execPath, ['server.js'], { cwd: __dirname, env: Object.assign({}, process.env, { SELFTEST_NO_LIVE: '1', PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }), stdio: ['ignore', 'pipe', 'pipe'] });
    process.on('exit', killTree);
    let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(600) })).ok; } catch (_) {} }
    C('护栏 实例就绪', up); if (!up) throw new Error('实例未起');
    const login = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: '出库测试管理', password: PW, dev: 'OB', kind: 'pda' }) });
    const tk = (await login.json()).token;
    C('护栏 管理员登录', !!tk); if (!tk) throw new Error('登录失败');
    // ① 无 pn= 与旧版逐字一致：仍只下发最新 500 单（列表页零回归）
    const r0 = await getj('/api/outbound', tk);
    C('★★ ① 不传 pn 行为不变（下发上限 500 单，列表页零回归）', r0.json.ok === true && r0.json.items.length === 500 && r0.json.total === db0.outboundCount, 'items=' + (r0.json.items || []).length + ' total=' + r0.json.total);
    // ② 核心：传 pn 后拿到该零件【全部】单，件数等于离线基准（过滤确实发生在截断之前）
    const r1 = await getj('/api/outbound?pn=' + PN, tk);
    const items1 = r1.json.items || [];
    let gotQ = 0, gotN = 0;
    for (const o of items1) for (const it of (o.items || [])) if (String(it.code || '').toUpperCase() === PN) { gotQ += Number(it.qty) || 0; gotN++; }
    C('★★★ ② pn 过滤后可见单数=该零件全量（'+baseN+' 单，不再被 500 上限截）', items1.length === baseN, '接口=' + items1.length + ' 基准=' + baseN);
    C('★★★ ② 累计出库件数=全量基准 '+baseQ+'（旧版此处只报 2620）', gotQ === baseQ, '接口=' + gotQ + ' 基准=' + baseQ);
    // ③ 修复有效性前提：旧路径（无过滤直接截断）确实拿不全，否则本次修复无意义
    const legacy = allObs.slice().sort((a, x) => (x.createdAt || 0) - (a.createdAt || 0)).slice(0, 500);
    let legacyQ = 0;
    for (const o of legacy) for (const it of (o.items || [])) if (String(it.code || '').toUpperCase() === PN) legacyQ += Number(it.qty) || 0;
    C('★★★ ③ 旧路径确实少报（复现档案页 2620 类低估）且已被本修复纠正', legacyQ < baseQ && gotQ > legacyQ, '旧=' + legacyQ + ' 新=' + gotQ);
    // ④ 大小写/空格容错 + 未知零件返回空（不误报）
    const rLower = await getj('/api/outbound?pn=  ' + PN.toLowerCase() + ' ', tk);
    C('★★ ④ pn 去空格+转大写容错', (rLower.json.items || []).length === baseN, 'items=' + (rLower.json.items || []).length);
    const rNone = await getj('/api/outbound?pn=ZZ_NOT_EXIST_9999', tk);
    C('★★ ④ 未知零件返回空集不报错', (rNone.json.items || []).length === 0 && rNone.json.count === 0);
    // ⑤ count 语义=过滤后总单数（PDA 消费方据此判断是否还有更多）
    C('★★ ⑤ count=过滤后单数（非全库总数，字段语义自洽）', r1.json.count === baseN && r1.json.total === db0.outboundCount, 'count=' + r1.json.count + ' total=' + r1.json.total);
    C('★ 进程存活', (await fetch(BASE + '/api/health')).ok === true);
  } catch (e) { total++; fail++; console.log('❌ 异常：' + e.message); }
  finally {
    killTree();
    await sleep(400);
    try { fs.rmSync(TDIR, { recursive: true, force: true }); } catch (_) {}
  }
  console.log('\n结果: ' + (total - fail) + ' 通过 / ' + fail + ' 失败  （隔离副本，生产库零写入）');
  process.exit(fail ? 1 : 0);
})();
