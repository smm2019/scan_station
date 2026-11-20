// ㉖v216 健康分"车队级断开豁免" + 等待热力（周几×小时）端到端验证
// 现场事实（用户告知）：下班集中关机 → RCS 同时看到全车队掉线。实锤数据形态：
//   近7天64次通讯断开，AGV05/06/07/08 小时分布逐时完全一致（7时×3、8时×3、19时×4…同一小时集体断）。
//   旧口径全扣单车分 → 四台健康分 34~49 全红，点名功能废掉。
// 修复：同小时≥3台同断=系统级，计数进 commSys 不扣分；单车独断照旧扣 comm（点名能力不丢）。
//   另补 L0 承诺的按小时热力：buildFunnel 输出 heat[{dow,hr,n,p50,p90}]（东八区，周一=0）。
// ★ 真跑理由：①豁免判据依赖真实 carEvents 小时分布，静态测必须造假数据、判据强度假；
//   生产库副本直接跑出"旧全红→新回正"是硬证据；②heat 的 dow/hr 桶是新增聚合，
//   时区/边界（周一=0、东八区）只有真数据真算才验得实；③单车独断回归路径要单独注入验。
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const TDIR = path.join(__dirname, '_health_v216'), PORT = Number(process.env.HS_PORT || 9945);
const BASE = 'http://127.0.0.1:' + PORT;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + String(i).slice(0, 140) + ']' : ''}`); };
const getj = async (p2, tk) => { const r = await fetch(BASE + p2, { headers: tk ? { Authorization: 'Bearer ' + tk } : {} }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
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
    const db0 = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'db.json'), 'utf8'));
    const salt = crypto.randomBytes(16).toString('hex'), PW = 'E2e#Hs!216';
    db0.users.push({ id: 'u_hs_h_adm', username: '健康测试管理', name: '健康测试管理', role: 'admin', enabled: true, createdAt: Date.now(), mustChangePw: false, salt, passHash: crypto.scryptSync(PW, salt, 32).toString('hex') });
    db0.wmasConfig = null; db0.rcsConfig = null;
    // 注入对照组：AGV05 在【某独享小时】独自断开 6 次（<3台同断→应计 comm 扣分）
    // 取一个生产数据里没有断开的时间点（凌晨3点整，避开真实关机小时）
    const d = new Date(Date.now() - 2 * 864e5); d.setUTCHours(19, 0, 0, 0); // 东八区=次日03时
    for (let i = 0; i < 6; i++) db0.carEvents.push({ ts: d.getTime() + i * 60000, who: 'AGV05', kind: '告警', msg: '通讯断开（测试独断注入' + i + '）' });
    fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
    srv = cp.spawn(process.execPath, ['server.js'], { cwd: __dirname, env: Object.assign({}, process.env, { SELFTEST_NO_LIVE: '1', PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }), stdio: ['ignore', 'pipe', 'pipe'] });
    process.on('exit', killTree);
    let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(600) })).ok; } catch (_) {} }
    C('护栏 实例就绪', up); if (!up) throw new Error('实例未起');
    const login = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: '健康测试管理', password: PW, dev: 'HA', kind: 'pda' }) });
    const tk = (await login.json()).token;
    C('护栏 管理员登录', !!tk); if (!tk) throw new Error('登录失败');
    const j = await getj('/api/agv/schedstats?days=14', tk);
    C('护栏 端点 ok', j.json.ok === true);
    const cars = j.json.cars || [];
    // ① 车队级断开豁免：全部4台车 commSys>0（生产断开全在≥3台同断小时）且 comm（扣分项）仅来自注入
    const withSys = cars.filter(c => (c.commSys || 0) > 0);
    C('★★★ ① 生产64次集体断开被识别为系统级（≥3台 commSys>0 且合计≈64）',
      withSys.length >= 3 && cars.reduce((s, c) => s + (c.commSys || 0), 0) >= 56, 'commSys合计=' + cars.reduce((s, c) => s + (c.commSys || 0), 0) + ' 覆盖车=' + withSys.map(c => c.id).join(','));
    // ② 单车独断照旧扣分：AGV05 注入 6 次独享小时断开 → comm≥6 且 comm 扣分账目=×3 可见
    const c05 = cars.find(c => /^AGV05/.test(c.id)) || {};
    C('★★★ ② 单车独自断开照常扣分（AGV05 comm≥6 注入全数计扣分）', (c05.comm || 0) >= 6, 'AGV05 comm=' + c05.comm + ' commSys=' + c05.commSys);
    C('★★ ② 扣分账目透明：score ≤ 100-comm×3（其余扣分为真实告警项，不跨车赌运气）', (c05.score || 999) <= 100 - (c05.comm || 0) * 3, 'score=' + c05.score + ' 通讯扣分账=' + ((c05.comm || 0) * 3));
    // ③ 豁免生效硬证：AGV08 的通讯史全部进 commSys（comm=0），分数从旧口径 34 回正；
    //    剩余扣分是白天真实故障（告警24×1+低电等），不该由豁免管——回正幅度 ≥30 即口径生效
    const c08 = cars.find(c => /^AGV08/.test(c.id)) || {};
    C('★★★ ③ 豁免生效：AGV08 通讯史全豁免（comm=0、commSys>0），分数 34→70+（残余=真实故障分）', (c08.comm || 0) === 0 && (c08.commSys || 0) > 0 && (c08.score || 0) >= 70, 'score=' + c08.score + ' comm=' + c08.comm + ' commSys=' + c08.commSys);
    // ④ 热力结构：heat 桶存在、dow 0~6、hr 0~23、p90≥p50、样本数>0
    const heat = j.json.heat || []; // ㉖v216 heat 在响应顶层（queue 为分位数对象无子字段位）
    C('★★★ ④ 等待热力桶产出（周几×小时，东八区）', heat.length > 0, '桶数=' + heat.length);
    C('★★ ④ 桶字段合法（dow0-6/hr0-23/n>0/p90≥p50）', heat.every(x => x.dow >= 0 && x.dow <= 6 && x.hr >= 0 && x.hr <= 23 && x.n > 0 && x.p90 >= x.p50), JSON.stringify(heat[0] || {}));
    const hrs = new Set(heat.map(x => x.hr));
    C('★★ ④ 时段多样性（≥2个不同小时=聚合非退化）', hrs.size >= 2, '小时数=' + hrs.size);
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
