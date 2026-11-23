// ㉖v238 备料看板车队根因 端到端验证（隔离实例，生产库零写入）
// 用户 11-23 场景：①"无空闲台"是果不是因（AGV05-08 通讯断开4台同倒，看板只报无空闲台）
//   ②AGV5 停5分恢复 + AGV7 突发未恢复 → 车故障时长(配对定格/实时增长) + 抖动合并 + 灰显闭合。
// 夹具时间线（相对 now）：
//   AGV5：alarm@-8min(障碍物) → recover@-3min（停5分闭合）→ alarm@-2min 未恢复（修好又坏=抖动段）
//   AGV7：alarm@-6min(通讯断开) 未恢复（实时增长，acked=false）
//   AGV9：alarm@-50min → recover@-45min（纯恢复，停5分，落"最近恢复"灰显，60min窗内）
//   被挡：1 个"无空闲台"活跃队列项 → blockedByCar>0 → hint=car_fault
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const TDIR = path.join(__dirname, '_cp_v238'), PORT = Number(process.env.HS_PORT || 9969);
const BASE = 'http://127.0.0.1:' + PORT;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + String(i).slice(0, 170) + ']' : ''}`); };
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
    const salt = crypto.randomBytes(16).toString('hex'), PW = 'E2e#Cp!238';
    const mk = (id, name, role) => ({ id, username: 'u_' + id.slice(2), name, role, enabled: true, createdAt: new Date().toISOString(), mustChangePw: false, salt, passHash: crypto.scryptSync(PW, salt, 32).toString('hex') });
    const now = Date.now(), MIN = 60000;
    const db0 = {
      users: [mk('u_wh238', '仓管甲', 'warehouse'), mk('u_ad238', '管理甲', 'admin')],
      sessions: {}, devices: {}, ops: [], notifications: [],
      outbound: {}, ledger: [], scanlog: [], inspects: [], seenIn: {}, seenOut: {}, requisitions: [],
      features: { material: {}, warehouse: { requisition: true }, inspector: {}, admin: { requisition: true, admin_panel: true } },
      rcsConfig: null, wmasConfig: null, rcsStations: {}, params: null,
      agvQueue: [
        { id: 'B1', code: 'N26K9900001', type: 'outbound', fromLoc: 'NB02-A-05-3F', stationManual: 'NB02-CK-01', by: '仓管甲', state: '排队', at: now - 10 * MIN, blockRsn: '无空闲台', blockKey: '站台', blockSince: now - 10 * MIN, blockSeq: ['无空闲台'], trace: [] },
      ],
      // carAlarms 升序 append：kind alarm/recover
      carAlarms: [
        { at: now - 8 * MIN, id: 5, name: 'AGV05', kind: 'alarm', msg: '🚨 AGV05 车辆告警：错误:车辆IO检测到障碍物，传感器：fork_tip_right;' },
        { at: now - 3 * MIN, id: 5, name: 'AGV05', kind: 'recover', msg: '✅ AGV05 告警已恢复（原：错误:车辆IO检测到障碍物）' },
        { at: now - 2 * MIN, id: 5, name: 'AGV05', kind: 'alarm', msg: '🚨 AGV05 车辆告警：错误:车辆IO检测到障碍物，传感器：fork_tip_right;' }, // 修好1分又坏=抖动，未恢复
        { at: now - 6 * MIN, id: 7, name: 'AGV07', kind: 'alarm', msg: '🚨 AGV07 车辆告警：通讯断开|错误:车辆网络连接异常' }, // 未恢复实时增长
        { at: now - 50 * MIN, id: 9, name: 'AGV09', kind: 'alarm', msg: '🚨 AGV09 车辆告警：错误:低电量' },
        { at: now - 45 * MIN, id: 9, name: 'AGV09', kind: 'recover', msg: '✅ AGV09 告警已恢复（原：错误:低电量）' }, // 纯恢复灰显（恢复距今45min，在60min窗内）
      ],
    };
    fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
    srv = cp.spawn(process.execPath, ['server.js'], { cwd: __dirname, env: Object.assign({}, process.env, { SELFTEST_NO_LIVE: '1', PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }), stdio: ['ignore', 'pipe', 'pipe'] });
    process.on('exit', killTree);
    let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(600) })).ok; } catch (_) {} }
    C('护栏 实例就绪', up); if (!up) throw new Error('实例未起');
    const tk = (await post('/api/login', null, { username: 'u_wh238', password: PW, dev: 'CP', kind: 'pda' })).json.token;
    C('护栏 登录', !!tk); if (!tk) throw new Error('登录失败');
    const rs = await get2('/api/requisitions/queue', tk);
    const b = rs.json.board || {};
    const ab = b.agvBoard || {};
    const cp2 = ab.carPool || {};
    const act = cp2.act || [], rec = cp2.rec || [];
    const byName = (nm) => act.find((a) => a.car === nm) || rec.find((a) => a.car === nm);
    C('护栏 看板回 carPool', rs.json.ok === true && !!ab.carPool, JSON.stringify(rs.json).slice(0, 80));
    C('★★★ ① 活跃故障=2台（AGV05抖动中 + AGV07通讯断开），按故障时长降序 AGV07(6分)>AGV05(2分)', cp2.nAct === 2 && act[0] && act[0].car === 'AGV07' && act[0].min >= 5 && act[1] && act[1].car === 'AGV05', JSON.stringify(act.map((a) => a.car + ':' + a.min + '分' + (a.open ? '开放' : ''))));
    C('★★★ ② AGV07 未恢复=实时增长(5~7分)、原因"通讯断开"、无人处理', byName('AGV07') && byName('AGV07').open === true && byName('AGV07').min >= 5 && byName('AGV07').min <= 8 && String(byName('AGV07').rsn).includes('通讯断开') && byName('AGV07').acked === false, JSON.stringify(byName('AGV07') || {}));
    C('★★★ ③ AGV05 抖动：修好1分又坏→段数≥2、flap标记、累计时长含前段(≥5分)、当前段开放实时', (() => { const a = byName('AGV05'); return a && a.flap === true && (a.segN || 0) >= 2 && (a.totMin || 0) >= 5 && a.open === true; })(), JSON.stringify(byName('AGV05') || {}));
    C('★★★ ④ AGV09 纯恢复落"最近恢复"灰显、故障时长定格5分（不再实时增长）', (() => { const a = byName('AGV09'); return a && a.open === false && a.min >= 4 && a.min <= 6 && rec.some((r) => r.car === 'AGV09'); })(), JSON.stringify(byName('AGV09') || {}));
    C('★★★ ⑤ 故障车挡着活联动：有1"无空闲台"被挡项 → blockedByCar=1、hint=car_fault（找车）', (cp2.blockedByCar || 0) >= 1 && cp2.hint === 'car_fault', JSON.stringify({ blk: cp2.blockedByCar, hint: cp2.hint }));
    C('★★ ⑥ 兼容旧字段：agvBlocked=1、light 仍在（v237 端不破坏）', b.agvBlocked === 1 && ['red', 'yellow'].includes(ab.light), JSON.stringify({ blk: b.agvBlocked, lt: ab.light }));
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
