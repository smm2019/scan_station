// ㉖v205 同键重扫覆盖留痕（hist）+ 全链路灰节点 端到端验证
// 用户实锤（N26J210016 时间线）：零件第一次采集入库后重扫，旧流水被【同键原地覆盖】——
// 键含批次+时刻（code|batch|ts），同批次重扫 PDA 生成同键、推送整体替换，旧内容（时间/数量/
// 位置/操作人）蒸发，事后无从核对"上次扫的是什么"（v167 取代机制只覆盖换批次+强过的场景）。
// 修复：流水合并覆盖前把旧行摘要存进新行 hist（cap 3），真覆盖才留；trace 还原成灰色事件
//   "♻ 曾被采集（已被覆盖）"。
// ★ 为什么必须真跑：①hist 生成在 Object.assign 之前——插错位（assign 后 old===v 恒真）静态
//   看代码完全发现不了，只有真推真读才暴露（首版就踩中，自查后修正）；②防噪断言（周期回灌
//   同内容不产 hist）是行为契约，必须真实多推几轮验证；③灰节点要真调 /api/trace 验 kind/detail。
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const TDIR = path.join(__dirname, '_hist_v205'), PORT = Number(process.env.HS_PORT || 9911);
const BASE = 'http://127.0.0.1:' + PORT;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + String(i).slice(0, 120) + ']' : ''}`); };
const post = async (p2, tk, body) => { const r = await fetch(BASE + p2, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: JSON.stringify(body || {}) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
const getj = async (p2, tk) => { const r = await fetch(BASE + p2, { headers: tk ? { Authorization: 'Bearer ' + tk } : {} }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
// 流水推送体（对齐 /api/scanlog/sync 契约与 v128 夹具写法）
const slItem = (k, code, o) => Object.assign({ k, code, wt: 1, st: '', gl: 'NB02-A-14-1F', ct: '1800*1200_2', rm: '', batch: 'BHS205', cx: false, t: Date.now(), pn: '8894080205', q: 500, op: '留痕测试仓', nm: '留痕测试件', lot: '2026-11-01', mc: '', pid: '', cxAt: 0 }, o || {});
(async () => {
  let srv;
  try {
    fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
    const db0 = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'db.json'), 'utf8'));
    const salt = crypto.randomBytes(16).toString('hex'), hp = (p, s) => crypto.scryptSync(String(p), s, 32).toString('hex'), PW = 'E2e#Hs!205';
    db0.users.push({ id: 'u_hs_wh', username: 'hs_wh', name: '留痕测试仓管', role: 'warehouse', enabled: true, createdAt: Date.now(), mustChangePw: false, salt, passHash: hp(PW, salt) });
    db0.params = Object.assign(db0.params || {}, { receivingOn: 0, reqHoursOn: 0 });
    db0.wmasConfig = null; db0.rcsConfig = null; db0.rcsStations = {}; db0.agvQueue = [];
    db0.scanlog = {}; // 干净流水，覆盖行为完全由本测试驱动
    fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
    // 保险丝：本测试不涉 AGV，但保险起见注入（任何意外下发都物理断掉）
    srv = cp.spawn(process.execPath, ['server.js'], { cwd: __dirname, env: Object.assign({}, process.env, { SELFTEST_NO_LIVE: '1', PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }), stdio: ['ignore', 'pipe', 'pipe'] });
    let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health')).ok; } catch (_) {} }
    C('护栏 实例就绪', up); if (!up) throw new Error('实例未起');
    const tk = (await post('/api/login', null, { username: 'hs_wh', password: PW, dev: 'HS', kind: 'pda' })).json.token;
    C('护栏 登录', !!tk); if (!tk) throw new Error('登录失败');
    const K = 'N26QH2050001|BHS205|1795000000000'; // 同键固定：批次+时刻不变=同一次采集的重推
    const it0 = slItem(K, 'N26QH2050001'); // 固定行：t 恒定，复刻真实回灌"推本机存储的同一行"
    // ── ① 首推 → 无 hist ──
    await post('/api/scanlog/sync', tk, { items: [it0] });
    await sleep(600);
    let sl = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8')).scanlog || {};
    C('① 首推落库且无 hist（新键无旧行）', !!sl[K] && !(sl[K].hist || []).length, 'hist=' + JSON.stringify((sl[K] || {}).hist));
    // ── ② 周期回灌同内容 ×3 → hist 恒空（防噪：正常同步不产假历史）──
    // 回灌=原样推 it0（t/q 固定）；前版夹具每次重生成 Date.now() 使 t 漂移被服务端判真覆盖
    //（首版踩中——t 变确实是"变了"，留痕反而正确；真实 PDA 回灌推本机存储同一行，t 不变）。
    for (let i = 0; i < 3; i++) await post('/api/scanlog/sync', tk, { items: [it0] });
    await sleep(600);
    sl = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8')).scanlog || {};
    C('★★★ 同内容重复回灌 hist 恒空（防噪声：日常同步不产假历史）', !(sl[K].hist || []).length, 'hist=' + JSON.stringify(sl[K].hist));
    // ── ③ 真覆盖（同 t 仅数量 500→800）→ hist[0] 记旧摘要 ──
    await post('/api/scanlog/sync', tk, { items: [Object.assign({}, it0, { q: 800 })] });
    await sleep(600);
    sl = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8')).scanlog || {};
    const h0 = (sl[K].hist || [])[0] || {};
    C('★★★ 真覆盖留痕：hist[0] 记录被覆盖旧行（q=500/位置/操作人）', h0.q === 500 && h0.gl === 'NB02-A-14-1F' && !!h0.op, JSON.stringify(h0));
    C('★★ 新行本体是新内容（q=800），留痕不影响当前值', Number(sl[K].q) === 800, 'q=' + sl[K].q);
    // ── ④ 链式覆盖 cap 3：再连续真覆盖 4 次（600→620→640→660）→ hist ≤3 且倒序新→旧 ──
    for (const q of [600, 620, 640, 660]) await post('/api/scanlog/sync', tk, { items: [slItem(K, 'N26QH2050001', { q })] });
    await sleep(600);
    sl = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8')).scanlog || {};
    const hs = sl[K].hist || [];
    C('★★★ 链式覆盖 hist 封顶 3 条（体积可控）', hs.length === 3, 'len=' + hs.length);
    C('★★ 倒序=最近被覆盖在前（640→620→600）', hs[0].q === 640 && hs[1].q === 620 && hs[2].q === 600, JSON.stringify(hs.map(x => x.q)));
    // ── ⑤ trace 灰节点：真调 /api/trace 验 kind=hist 与 detail 内容 ──
    const tr = await getj('/api/trace?q=N26QH2050001', tk);
    const hEv = ((tr.json.events) || []).filter(e => e.kind === 'hist');
    C('★★★ 全链路灰节点出现（♻ 曾被采集（已被覆盖））', hEv.length >= 1, 'hist事件=' + hEv.length);
    C('★★ 灰节点 detail 带被覆盖的数量与位置（查问题一眼可见）', hEv.some(e => /数量 \d+/.test(e.detail || '') && /NB02-A-14-1F|位置/.test(e.detail || '')), JSON.stringify((hEv[0] || {}).detail || ''));
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
