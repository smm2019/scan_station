// ㉖v226 备料排队看板·AGV失败上卡 端到端验证（隔离实例，生产库零写入）
// 背景（用户 11-23 问"看板有没有 AGV 错误信息和持续影响时间"）：旧版头部只算被挡、排除失败；
//   失败只挂在带 reqId 的单卡上 → ①头部看着健康、失败在暗处；②采集/返架/检验搬运等无单号失败全看板静默。
// 修法：头部统计并入失败维度（全仓库口径不挑 reqId，24 小时窗防旧失败长红）；PDA 头部红行展示"错误+持续时长"。
// 夹具一次构造：带单号失败30分 / 无单号失败90分 / 无单号失败26小时(窗外) / 被挡10分 / 正常排队 / 完成(带残留blockRsn)。
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const TDIR = path.join(__dirname, '_qf_v226'), PORT = Number(process.env.HS_PORT || 9957);
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
    const salt = crypto.randomBytes(16).toString('hex'), PW = 'E2e#Hs!226';
    const now = Date.now(), MIN = 60000;
    const db0 = {
      users: [{ id: 'u_qf226', username: 'qf_u', name: '看板测试管理', role: 'admin', enabled: true, createdAt: new Date().toISOString(), mustChangePw: false, salt, passHash: crypto.scryptSync(PW, salt, 32).toString('hex') }],
      sessions: {}, devices: {}, ops: [], notifications: [],
      scanlog: {}, outbound: {}, ledger: [], ledgerTomb: [], inspects: [], seenIn: {}, seenOut: {},
      features: { material: {}, warehouse: { requisition: true }, inspector: {}, admin: { requisition: true, admin_panel: true } },
      rcsConfig: null, wmasConfig: null, rcsStations: {},
      requisitions: [{
        id: 'RQ_F226', no: 'LL202611231111', status: 'pending', byName: '张三',
        createdAt: new Date(now - 40 * MIN).toISOString(), needDate: '', rush: false,
        items: [{ pn: '6600000001', nm: '测试件', qty: 2, issued: [] }],
      }],
      agvQueue: [
        { id: 'Q1', code: 'N26J111111', reqId: 'RQ_F226', state: '失败', err: '目标货位被占', updAt: now - 30 * MIN, at: now - 60 * MIN },
        { id: 'Q2', code: 'N26J222222', state: '失败', err: '站台预约冲突', updAt: now - 90 * MIN, at: now - 120 * MIN },          // 无单号失败=旧版全看板静默的那种
        { id: 'Q3', code: 'N26J333333', state: '失败', err: '久远的旧失败', updAt: now - 26 * 60 * MIN, at: now - 30 * 60 * MIN },   // 超24h窗=不计
        { id: 'Q4', code: 'N26J444444', reqId: 'RQ_F226', state: '排队', blockRsn: '无空闲台', blockSince: now - 10 * MIN, at: now - 15 * MIN },
        { id: 'Q5', code: 'N26J555555', state: '排队', at: now - 5 * MIN },                                                            // 正常排队=不进任何告警
        { id: 'Q6', code: 'N26J666666', state: '完成', blockRsn: '残留未闭', at: now - 3 * 60 * MIN, updAt: now - 2 * 60 * MIN },      // 完成带残留blockRsn=不算被挡
      ],
    };
    fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
    srv = cp.spawn(process.execPath, ['server.js'], { cwd: __dirname, env: Object.assign({}, process.env, { SELFTEST_NO_LIVE: '1', PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }), stdio: ['ignore', 'pipe', 'pipe'] });
    process.on('exit', killTree);
    let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(600) })).ok; } catch (_) {} }
    C('护栏 实例就绪', up); if (!up) throw new Error('实例未起');
    const tk = (await post('/api/login', null, { username: 'qf_u', password: PW, dev: 'QF', kind: 'pda' })).json.token;
    C('护栏 管理员登录', !!tk); if (!tk) throw new Error('登录失败');
    const rs = await get2('/api/requisitions/queue', tk);
    const b = rs.json.board || {};
    C('护栏 看板接口返回', rs.json.ok === true && !!rs.json.board, JSON.stringify(rs.json).slice(0, 100));

    // ★★ v226 失败上头部（全仓库口径）
    C('★★★ ① 失败数进头部=2（带单号+无单号各1；26h窗外那条不计入）', b.agvFail === 2, 'agvFail=' + b.agvFail);
    C('★★★ ② 最久失败时长≈90分钟（无单号那条）', b.agvFailMaxMin >= 85 && b.agvFailMaxMin <= 95, 'agvFailMaxMin=' + b.agvFailMaxMin);
    C('★★★ ③ 最久失败原因=无单号那条的"站台预约冲突"（旧版此失败全看板不可见）', b.agvWorstFailRsn === '站台预约冲突', 'rsn=' + b.agvWorstFailRsn);

    // ★ 被挡口径零回归（v202 语义逐字不变）
    C('★★ ④ 被挡仍只算活跃+带原因=1（完成带残留blockRsn不算）', b.agvBlocked === 1, 'agvBlocked=' + b.agvBlocked);
    C('★★ ④ 被挡时长≈10分·原因"无空闲台"', b.agvBlockedMaxMin >= 8 && b.agvBlockedMaxMin <= 12 && b.agvWorstRsn === '无空闲台', 'min=' + b.agvBlockedMaxMin + ' rsn=' + b.agvWorstRsn);

    // ★ 单卡失败照挂（reqId 关联口径不变）
    const it0 = (b.items || []).find((x) => x.id === 'RQ_F226');
    C('★★ ⑤ 带单号失败仍挂本单卡片 agvIssue=fail·目标货位被占', !!it0 && !!it0.agvIssue && it0.agvIssue.kind === 'fail' && String(it0.agvIssue.rsn).includes('目标货位被占'), JSON.stringify((it0 || {}).agvIssue || null));

    // ★ 活跃数不受失败影响（排队2条=活跃）
    C('★★ ⑥ 在跑活跃数=2（失败/完成不进 agvActive）', b.agvActive === 2, 'agvActive=' + b.agvActive);

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
