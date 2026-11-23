// ㉖v237 备料排队看板·安灯增强 端到端验证（隔离实例，生产库零写入）
// 用户 11-23 按顶尖工厂看板提三问：①为何被挡 ②挡了哪些单 ③中间有没有好转。
// queueBoardOf 新增 agvBoard：light(绿黄红)/byRsn(原因分布)/detail(被挡明细)/trend(近6小时)/worst(红牌点名)。
// 夹具：3 条活跃被挡项(无空闲台×2 挡18/6分、巷道并发×1 挡3分) + schedBlock 近3小时桶(时长递减=好转)。
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const TDIR = path.join(__dirname, '_ab_v237'), PORT = Number(process.env.HS_PORT || 9968);
const BASE = 'http://127.0.0.1:' + PORT;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + String(i).slice(0, 150) + ']' : ''}`); };
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
    const salt = crypto.randomBytes(16).toString('hex'), PW = 'E2e#Ab!237';
    const mk = (id, name, role) => ({ id, username: 'u_' + id.slice(2), name, role, enabled: true, createdAt: new Date().toISOString(), mustChangePw: false, salt, passHash: crypto.scryptSync(PW, salt, 32).toString('hex') });
    const now = Date.now(), MIN = 60000;
    const db0 = {
      users: [mk('u_wh237', '仓管甲', 'warehouse'), mk('u_ad237', '管理甲', 'admin')],
      sessions: {}, devices: {}, ops: [], notifications: [],
      outbound: {}, ledger: [], scanlog: [], inspects: [], seenIn: {}, seenOut: {},
      features: { material: {}, warehouse: { requisition: true }, inspector: {}, admin: { requisition: true, admin_panel: true } },
      rcsConfig: null, wmasConfig: null, rcsStations: {}, params: null,
      requisitions: [
        { id: 'RQ_A', no: 'LLAA2026112315000001', by: 'u_wh237', byName: '仓管甲', status: 'accepted', acceptedBy: '仓管甲', acceptedAt: new Date(now - 24 * MIN).toISOString(), createdAt: new Date(now - 30 * MIN).toISOString(), history: [], items: [{ partNo: '6609000001', qty: 800, issued: [] }] },
      ],
      // 3 条活跃被挡项：2 无空闲台(挡18/6分)、1 巷道并发(挡3分)——最长18≥阈值15→红牌
      agvQueue: [
        { id: 'B1', code: 'N26K9900001', type: 'outbound', fromLoc: 'NB02-A-05-3F', stationManual: 'NB02-CK-01', reqId: 'RQ_A', reqNo: 'LLAA2026112315000001', by: '仓管甲', state: '排队', at: now - 18 * MIN, blockRsn: '无空闲台', blockKey: '站台', blockSince: now - 18 * MIN, blockSeq: ['巷道并发', '无空闲台'], trace: [] },
        { id: 'B2', code: 'N26K9900002', type: 'inbound', fromLoc: 'NB02-CK-02', stationManual: 'NB02-B-03-1F', by: '宋明明', state: '排队', at: now - 6 * MIN, blockRsn: '无空闲台', blockKey: '站台', blockSince: now - 6 * MIN, blockSeq: ['无空闲台'], trace: [] },
        { id: 'B3', code: 'N26K9900003', type: 'outbound', fromLoc: 'NB02-C-11-2F', by: '刘向轩', state: '排队', at: now - 3 * MIN, blockRsn: '巷道并发', blockKey: 'NB02-C-11', blockSince: now - 3 * MIN, blockSeq: ['巷道并发'], trace: [] },
      ],
      // schedBlock 近3小时桶：总时长 30→20→10 分递减=好转（趋势方向 improving）
      schedBlock: (() => {
        const hr = (o) => Math.floor((now - o * 3600000) / 3600000) * 3600000;
        return [
          { hr: hr(2), key: '站台', rsn: '无空闲台', n: 6, sec: 1800, max: 900 },   // 上上小时 30分
          { hr: hr(1), key: '站台', rsn: '无空闲台', n: 4, sec: 1200, max: 600 },   // 上一小时 20分
          { hr: hr(0), key: '站台', rsn: '无空闲台', n: 2, sec: 600, max: 400 },    // 本小时 10分（未满参考）
        ];
      })(),
    };
    fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
    srv = cp.spawn(process.execPath, ['server.js'], { cwd: __dirname, env: Object.assign({}, process.env, { SELFTEST_NO_LIVE: '1', PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }), stdio: ['ignore', 'pipe', 'pipe'] });
    process.on('exit', killTree);
    let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(600) })).ok; } catch (_) {} }
    C('护栏 实例就绪', up); if (!up) throw new Error('实例未起');
    const tk = (await post('/api/login', null, { username: 'u_wh237', password: PW, dev: 'AB', kind: 'pda' })).json.token;
    C('护栏 登录', !!tk); if (!tk) throw new Error('登录失败');
    const rs = await get2('/api/requisitions/queue', tk);
    const b = (rs.json.board) || {};
    const ab = b.agvBoard || {};
    C('护栏 看板接口回 agvBoard', rs.json.ok === true && !!b.agvBoard, JSON.stringify(rs.json).slice(0, 90));
    C('★★★ ① 安灯分级：最长18分≥红牌阈值15 → light=red', ab.light === 'red' && ab.redFlag && ab.redFlag.code === 'N26K9900001', JSON.stringify({ lt: ab.light, rf: ab.redFlag && ab.redFlag.code }));
    C('★★★ ② 原因分布：无空闲台×2(最长18) + 巷道并发×1(最长3)，按数降序', Array.isArray(ab.byRsn) && ab.byRsn.length === 2 && ab.byRsn[0].rsn === '无空闲台' && ab.byRsn[0].n === 2 && ab.byRsn[0].maxMin >= 17 && ab.byRsn[1].rsn === '巷道并发' && ab.byRsn[1].n === 1, JSON.stringify(ab.byRsn));
    C('★★★ ③ 被挡明细：3 条按卡最久降序，首条=挡18分的 N26K9900001（含目的地/叫车人/原因序列）', Array.isArray(ab.detail) && ab.detail.length === 3 && ab.detail[0].code === 'N26K9900001' && ab.detail[0].min >= 17 && ab.detail[2].min <= 4 && Array.isArray(ab.detail[0].seq), JSON.stringify((ab.detail || []).map((d) => d.code + ':' + d.min + '分')));
    C('★★★ ④ 近6小时趋势：6 个点，上一小时(20分)>本小时参考 → trendDir=improving(好转)', Array.isArray(ab.trend) && ab.trend.length === 6 && ab.trendDir === 'improving', JSON.stringify({ n: (ab.trend || []).length, dir: ab.trendDir, delta: ab.trendDeltaMin }));
    C('★★ ⑤ 兼容旧字段仍在：agvBlocked=3、agvBlockedMaxMin≥17（老端不受影响）', b.agvBlocked === 3 && b.agvBlockedMaxMin >= 17, JSON.stringify({ blk: b.agvBlocked, mx: b.agvBlockedMaxMin }));
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
