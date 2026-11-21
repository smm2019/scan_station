// ㉖v210 运营转速表三件套 + 复合阻塞归因 端到端验证
// 背景（用户拍板"先做转速表→复合归因"）：分析层从"看数字"升级到"量健康"——
// ①账实相符率（盘点差异聚合）②自愈补丁触发计数（高频触发=主流程薄弱点信号）
// ③缺料 open→销案时效分位数 ④复合阻塞（同段多因共存，旧版后写覆盖前写不可检出）。
// 夹具全自造不碰生产库。核心硬证：启动真触发 seenInBackfill → selfHealStats 真落库（计数链路走通）。
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const TDIR = path.join(__dirname, '_t210'), START = Number(process.env.HS_PORT || 9961);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + String(i).slice(0, 140) + ']' : ''}`); };
(async () => {
  let srv = null, URL2 = '';
  const killTree = () => { try { if (srv && srv.exitCode === null) cp.execSync(`taskkill /pid ${srv.pid} /T /F`, { stdio: 'ignore', windowsHide: true }); } catch (_) {} };
  try {
    fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
    const salt = crypto.randomBytes(16).toString('hex'), PW = 'E2e#Hs!210';
    const hp = (p) => crypto.scryptSync(p, salt, 32).toString('hex');
    const ts = new Date().toISOString(), now = Date.now(), H = 36e5, D864 = 864e5;
    const db0 = {
      users: [
        { id: 'u_a', username: 'audm', name: '转速管理', role: 'admin', enabled: true, createdAt: ts, mustChangePw: false, salt, passHash: hp(PW) },
        { id: 'u_w', username: 'awh', name: '转速仓管', role: 'warehouse', enabled: true, createdAt: ts, mustChangePw: false, salt, passHash: hp(PW) },
      ],
      features: { admin: {}, warehouse: {} }, sessions: {}, devices: {}, ops: [], notifications: [],
      outbound: {}, scanlog: {}, agvTasks: {}, carEvents: [], inspects: [], requisitions: [],
      // 盘点批次：Σbook=1700 Σ|diff|=210 → qtyAcc=(1-210/1700)=87.6%；货位3行2差(P1差10/P3整框亏200)→boxAcc=33.3；账外1件；矛盾1行
      inventories: { B1: { batchId: 'B1', at: now - 2 * D864, by: '盘点王', blind: true, applied: true,
        parts: [{ pn: 'P1', nm: '件一', book: 1000, real: 990, boxes: 5, out: 0, warn: 0 },
                { pn: 'P2', nm: '件二', book: 500, real: 500, boxes: 3, out: 0, warn: 0 },
                { pn: 'P3', nm: '件三', book: 200, real: 0, boxes: 0, out: 1, warn: 7 }],
        locs: [{ loc: 'NB03-A-11-01', pn: 'P1', book: 1000, real: 990 }, { loc: 'NB03-A-12-02', pn: 'P2', book: 500, real: 500 }, { loc: 'NB03-A-13-03', pn: 'P3', book: 200, real: 0 }] } },
      // 缺料 3 销案 + 1 在办超7天；auto 2/3=67%；ETA 偏差 +5h
      shortages: [
        { id: 's1', pn: 'P1', firstAt: now - 10 * D864, at: now - 10 * D864, status: 'resolved', doneAt: now - 2 * D864, doneBy: '系统', doneByName: '到料自动核销', n: 2, byList: [] },
        { id: 's2', pn: 'P2', firstAt: now - 7 * D864 - 7 * H, at: now - 7 * D864, status: 'resolved', doneAt: now - 7 * H, doneBy: 'u_w', doneByName: '转速仓管', eta: now - 12 * H, n: 1, byList: [] },
        { id: 's3', pn: 'P3', firstAt: now - 3 * D864, at: now - 3 * D864, status: 'resolved', doneAt: now - 3 * D864 + 144 * H, doneBy: '系统', n: 1, byList: [] },
        { id: 's4', pn: 'P9', firstAt: now - 10 * D864, at: now - 10 * D864, status: 'open', n: 1, byList: [] },
      ],
      // 自愈统计预置（验证周汇总）；seenInBackfilled 故意不设 → 启动真触发回填并计数
      selfHealStats: [{ d: new Date().getFullYear() + String(new Date().getMonth() + 1).padStart(2, '0') + String(new Date().getDate()).padStart(2, '0'), c: { ledgerQtyFixV103: 5 } }],
      // 调度拦截桶：旧格式无 mn（兼容不崩）+ 新格式共存段 mn=1 combos 顶组合
      schedBlock: [
        { hr: Math.floor((now - 2 * D864) / 36e5) * 36e5, key: 'NB02-E-06', rsn: '无空闲台', n: 3, sec: 600, max: 300 },
        { hr: Math.floor((now - D864) / 36e5) * 36e5, key: 'NB02-E-12', rsn: '巷道并发', n: 2, sec: 300, max: 200, mn: 1, combos: { '巷道并发+无空闲台': 1 } },
      ],
      ledger: [{ c: 'N26T210A0001', l: 'NB03-A-11-01', p: 'P1', n: '件一', q: 100, f: '托盘', t: now - 5 * D864, by: '张三' },
               { c: 'N26T210A0002', l: 'NB03-A-11-02', p: 'P2', n: '件二', q: 50, f: '托盘', t: now - 5 * D864, by: '李四' }],
      ledgerRev: 1, params: {}, wmasConfig: null, rcsConfig: null, rcsStations: {},
    };
    fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
    const spawnUp = async (start) => {
      for (let p = start; p < start + 20; p++) {
        const myStart = Date.now() - 2000, url = 'http://127.0.0.1:' + p;
        const s = cp.spawn(process.execPath, ['server.js'], { cwd: __dirname, env: Object.assign({}, process.env, { SELFTEST_NO_LIVE: '1', PORT: String(p), HOST: '127.0.0.1', DATA_DIR: TDIR }), stdio: ['ignore', 'pipe', 'pipe'] });
        let mine = false;
        for (let i = 0; i < 24 && !mine; i++) { await sleep(250); try { const hj = await (await fetch(url + '/api/health', { signal: AbortSignal.timeout(700) })).json(); if (hj && hj.code && hj.code.startedAt && Date.parse(hj.code.startedAt) >= myStart) mine = true; } catch (_) {} }
        if (mine) return { s, url };
        try { cp.execSync(`taskkill /pid ${s.pid} /T /F`, { stdio: 'ignore', windowsHide: true }); } catch (_) {}
        await sleep(300);
      }
      throw new Error('无本轮实例（僵尸占口）');
    };
    const up = await spawnUp(START); srv = up.s; URL2 = up.url;
    const get2 = async (p2, tk) => { const r = await fetch(URL2 + p2, { headers: tk ? { Authorization: 'Bearer ' + tk } : {} }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
    const post2 = async (p2, tk, body) => { const r = await fetch(URL2 + p2, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: JSON.stringify(body || {}) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
    const tkA = (await post2('/api/login', null, { username: 'audm', password: PW, dev: 'AU', kind: 'web' })).json.token;
    const tkW = (await post2('/api/login', null, { username: 'awh', password: PW, dev: 'AW', kind: 'web' })).json.token;
    C('护栏 双账号登录', !!tkA && !!tkW); if (!tkA) throw new Error('登录失败');
    await sleep(12000); // 等启动补丁链（3秒+8秒两波）真触发并计数落库
    // ① 账实相符率
    const j = await get2('/api/admin/opsaudit?days=30', tkA);
    const acc = j.json.acc || {};
    C('★★★ ① 转速表端点通（admin）', j.json.ok === true && acc.batches === 1, 'st=' + j.status + ' batches=' + acc.batches);
    C('★★★ ① 件数相符率=87.6%（1-210/1700 手算对账）', acc.qtyAcc === 87.6, 'qtyAcc=' + acc.qtyAcc);
    C('★★ ① 货位准确率=33.3%（3行2差：P1差10+P3整框亏200）+ 账外1件 + 矛盾1行如实列报', acc.boxAcc === 33.3 && acc.outQty === 1 && acc.warnRows === 1, JSON.stringify({ b: acc.boxAcc, o: acc.outQty, w: acc.warnRows }));
    // ② 缺料时效：p50=三值[2.4,167,192]中位=167 前 p50=168？手算：h1=(now-2d - (now-10d))/H=192；h2=((now-7H)-(now-7d-7H))/H=168；h3=144
    const st = j.json.shortage || {};
    C('★★★ ② 销案 3 条 · p50=168 时 · 自动核销 67%', st.resolved === 3 && st.p50H === 168 && st.autoPct === 67, JSON.stringify({ r: st.resolved, p50: st.p50H, a: st.autoPct }));
    C('★★ ② ETA 偏差 p50=+5h（晚于承诺）· 在办1条超7天', st.etaN === 1 && st.etaLateP50H === 5 && st.openN === 1 && st.openOver7d === 1, JSON.stringify({ e: st.etaN, ep: st.etaLateP50H, o: st.openN, oo: st.openOver7d }));
    // ③ 自愈计数：预置的 ledgerQtyFixV103=5 聚合 + 启动真触发 seenInBackfill（计数链路走通=宝藏变仪表）
    const sh = j.json.selfHeal || [];
    const shMap = {}; sh.forEach((x) => { shMap[x.name] = x; });
    C('★★★ ③ 启动补丁链真触发：seenInBackfill 计数落库（回填 2 标签）', shMap.seenInBackfill && shMap.seenInBackfill.n >= 2, JSON.stringify(shMap.seenInBackfill || {}));
    C('★★ ③ 预置统计聚合正确：ledgerQtyFixV103 n=5 触发1天', shMap.ledgerQtyFixV103 && shMap.ledgerQtyFixV103.n === 5 && shMap.ledgerQtyFixV103.days === 1, JSON.stringify(shMap.ledgerQtyFixV103 || {}));
    // 落库铁证：selfHealStats 里真新增了今天启动的条目
    const disk = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    const todayKey = disk.selfHealStats.map((b) => b.d).sort().pop();
    const todayB = (disk.selfHealStats.find((b) => b.d === todayKey) || {}).c || {};
    C('★★★ ③ 落库铁证：selfHealStats 当日桶含 seenInBackfill', (todayB.seenInBackfill || 0) >= 2, 'c=' + JSON.stringify(todayB));
    // ④ 复合阻塞：新格式 mn=1 段 → coexist.n=1 顶组合；旧格式无 mn 兼容不崩
    const ss = await get2('/api/agv/schedstats?days=14', tkA);
    const co = (ss.json.block || {}).coexist || {};
    C('★★★ ④ coexist 输出：共存段 n=1 + 顶组合「巷道并发+无空闲台」', co.n === 1 && co.top && co.top[0] && co.top[0].combo === '巷道并发+无空闲台' && co.top[0].n === 1, JSON.stringify(co));
    C('★★ ④ 回归：byRsn/byAisle 原结构不回归', Array.isArray(ss.json.block.byRsn) && ss.json.block.byRsn.length === 2 && Array.isArray(ss.json.block.byAisle) && ss.json.block.byAisle.length === 2, 'rsn=' + ((ss.json.block || {}).byRsn || []).length);
    // ⑤ 权限：非 admin 403
    const p5 = await get2('/api/admin/opsaudit', tkW);
    C('★★★ ⑤ 非管理员 403（转速表不扩面）', p5.status === 403, 'st=' + p5.status);
    C('★ 进程存活', (await fetch(URL2 + '/api/health')).ok === true);
  } catch (e) { total++; fail++; console.log('❌ 异常：' + e.message); }
  finally {
    killTree();
    await sleep(400);
    try { fs.rmSync(TDIR, { recursive: true, force: true }); } catch (_) {}
  }
  console.log('\n结果: ' + (total - fail) + ' 通过 / ' + fail + ' 失败  （隔离副本，生产库零写入）');
  process.exit(fail ? 1 : 0);
})();
