// ㉖v231 AGV 出队归档：链路节点重建 + 车号一一对应 端到端验证（隔离实例，生产库零写入）
// 背景（用户 11-23 实锤）：同 AGV 站台模式两框链路一半节点蒸发（N26K230045 完成>2h 已出队 vs N26K210018 仍在队），
//   且要求"哪台 AGV 拉的要和标签一一对应"。旧病=队列项出队后 ①决策trace/进入队列/到达站台蒸发
//   ②agvTaskForCode 失去 wmsTask 精确锚点退回"同站台+时间窗"猜 → 抓到邻框任务显示邻框车号。
// 夹具：目标框的队列项已出队（不在 agvQueue），只在 agvArch 留精确快照 + agvTasks 底仓两任务两车；
//   放一个同起点邻框完成项（占活跃队列、指向邻框任务/邻框车）当干扰，验证目标框不串到邻框车。
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const TDIR = path.join(__dirname, '_ag_v231'), PORT = Number(process.env.HS_PORT || 9963);
const BASE = 'http://127.0.0.1:' + PORT;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + String(i).slice(0, 160) + ']' : ''}`); };
const post = async (p2, tk, body) => { const r = await fetch(BASE + p2, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: JSON.stringify(body || {}) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
const get2 = async (p2, tk) => { const r = await fetch(BASE + p2, { headers: tk ? { Authorization: 'Bearer ' + tk } : {} }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
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
    if (probe === 'busy') throw new Error('端口 ' + PORT + ' 被占用——HS_PORT 换端口重跑');
    const salt = crypto.randomBytes(16).toString('hex'), PW = 'E2e#Hs!231';
    const now = Date.now(), MIN = 60000;
    // 目标框 N26K990001：队列项已出队（不在 agvQueue），agvArch 有精确快照，底仓 agvTasks[T1] 车7
    // 邻框   N26K990002：仍在 agvQueue（完成态占同起点 CK-05 干扰），agvTasks[T2] 车8
    const T1 = 'AGV-T1-TARGET', T2 = 'AGV-T2-NEIGHBOR';
    const db0 = {
      users: [{ id: 'u_ag231', username: 'ag_u', name: '归档测试管理', role: 'admin', enabled: true, createdAt: new Date().toISOString(), mustChangePw: false, salt, passHash: crypto.scryptSync(PW, salt, 32).toString('hex') }],
      sessions: {}, devices: {}, ops: [], notifications: [],
      requisitions: [], outbound: {}, ledger: [{ c: 'N26K990002', l: 'NB02-B-09-2F', p: '6609000002', q: 500, mv: 'AGV', src: 'NB02-CK-05', t: now - 60 * MIN, by: '邻框人' }],
      inspects: [], seenIn: {}, seenOut: {},
      features: { material: {}, warehouse: {}, inspector: {}, admin: { agv_control: true } },
      rcsConfig: null, wmasConfig: null, rcsStations: {},
      scanlog: {
        'N26K990001|B2026-11-23-0900|1': { code: 'N26K990001', wt: 0, st: 'NB02-CK-05', gl: '', ct: '纸箱', cx: false, q: 300, pn: '6609000001', op: '目标人', t: now - 200 * MIN, nm: '目标件' },
      },
      // 目标框精确归档（模拟已出队）：框码↔任务号T1↔决策trace↔到站时刻，全部带
      agvArch: [{ code: 'N26K990001', wmsTask: T1, state: '完成', station: 'NB02-B-08-1F', fromLoc: 'NB02-CK-05', type: 'inbound', by: '目标人', reqId: '', at: now - 190 * MIN, finAt: now - 170 * MIN, trace: ['指定台 NB02-B-08-1F 可用，按指定执行', '预约站台窗至 09:20（行程+缓冲）', 'WMAS建任务' + T1 + '下发成功'] }],
      // 目标框底仓车7（finAt 用 ex 派生），邻框底仓车8
      agvTasks: {
        [T1]: { car: 7, st: 'FINISH', ex: now - 178 * MIN, fin: now - 170 * MIN, pick: now - 176 * MIN, dur: 480, sp: 'NB02-CK-05', ep: 'NB02-B-08-1F', ck: 'in' },
        [T2]: { car: 8, st: 'FINISH', ex: now - 150 * MIN, fin: now - 143 * MIN, pick: now - 148 * MIN, dur: 420, sp: 'NB02-CK-05', ep: 'NB02-B-09-2F', ck: 'in' },
      },
      agvQueue: [
        // 邻框仍在队列（完成、同起点 CK-05、终点 B-09、指向 T2 车8）——若目标框退回时间窗猜，会抓到 T2 显示车8
        { id: 'nq1', code: 'N26K990002', fromLoc: 'NB02-CK-05', stationManual: 'NB02-B-09-2F', station: 'NB02-B-09-2F', type: 'inbound', by: '邻框人', state: '完成', wmsTask: T2, at: now - 155 * MIN, updAt: now - 143 * MIN, trace: ['邻框决策'] },
      ],
    };
    fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
    srv = cp.spawn(process.execPath, ['server.js'], { cwd: __dirname, env: Object.assign({}, process.env, { SELFTEST_NO_LIVE: '1', PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }), stdio: ['ignore', 'pipe', 'pipe'] });
    process.on('exit', killTree);
    let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(600) })).ok; } catch (_) {} }
    C('护栏 实例就绪', up); if (!up) throw new Error('实例未起');
    const tk = (await post('/api/login', null, { username: 'ag_u', password: PW, dev: 'AG', kind: 'web' })).json.token;
    C('护栏 管理员登录', !!tk); if (!tk) throw new Error('登录失败');

    const rs = await get2('/api/trace?q=N26K990001', tk);
    const evs = (rs.json.trace || rs.json).events || rs.json.events || [];
    const kinds = evs.map((e) => e.kind);
    const titles = evs.map((e) => (e.title || '') + '|' + (e.detail || ''));
    const has = (kw) => titles.some((t) => t.includes(kw));

    C('★★★ ① 出队框链路仍重建 🚦进入调度队列（旧版蒸发）', has('🚦 进入调度队列'), JSON.stringify(kinds));
    C('★★★ ② 决策 trace 重建（指定台/预约窗/下发三节点，旧版蒸发）', has('指定台 NB02-B-08-1F') && has('WMAS建任务' + T1), JSON.stringify(titles.filter((t) => t.startsWith('🧭'))));
    C('★★★ ③ 🏁到达站台 重建（旧版蒸发）', has('🏁 到达站台 NB02-B-08-1F'), '');
    C('★★★ ④ 车号一一对应：执行完成显示【车7】（本框任务T1的底仓车），非邻框车8', titles.some((t) => t.includes('执行完成') && t.includes('车7')), JSON.stringify(titles.filter((t) => t.includes('执行完成') || t.includes('车'))));
    C('★★★ ④ 绝不串到邻框车8（邻框T2不在本框任务集）', !titles.some((t) => /车\s*8|T2|NEIGHBOR|B-09/.test(t)), JSON.stringify(titles.filter((t) => /车8|T2|NEIGHBOR|B-09/.test(t))));
    C('★★ ⑤ 采集入库蓝节点照常（重建不误伤既有节点）', has('📥 采集入库'), '');

    // 出队归档写入路径冒烟：目标框不在 agvQueue，查邻框应命中活跃队列项走旧路（去重不误伤）
    const rs2 = await get2('/api/trace?q=N26K990002', tk);
    const t2 = ((rs2.json.trace || rs2.json).events || rs2.json.events || []).map((e) => (e.title || '') + '|' + (e.detail || ''));
    C('★★ ⑥ 邻框（活跃队列项）链路正常、显示车8、不重复重建归档节点', t2.some((t) => t.includes('车8')) && t2.some((t) => t.includes('🚦 进入调度队列')), JSON.stringify(t2.filter((t) => t.includes('车'))));

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
