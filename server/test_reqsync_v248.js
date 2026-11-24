// ㉖v248 多仓管协同·单据搭车同步的契约验证（隔离实例，生产库零写入）
// 用户实锤：两人同备一单，同事扫码发走的框要关页面重进才看得见。PDA 修法=AGV 定时链每轮
// reqOne 比对 rev、前进即拉回整单刷新。本测锁这条链依赖的服务器契约：
//   ① 他人动作(扫码)即时反映在 GET 单张返回（issued 即时可见）——同步数据源成立；
//   ② GET 单张回带 rev 且每次成功动作单调 +1 ——rev 比对判据成立；
//   ③ 陈旧包可识别（持动作前快照 rev<当前 rev → 客户端 sRev<=_rev 丢弃不回退）；
//   ④ 非下单人仓管 GET 单张放行 200（协同双方都要能看，仅 material 限本人）；
//   ⑤ v208 软模式并发语义（默认 reqConcOn=0）：陈旧 baseRev 动作放行但 history 必留
//     "⚡并发提醒"——同步永不静默互盖，事后可查；（硬模式 409 属参数开关，不在此测）
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const TDIR = path.join(__dirname, '_rs_v248'), PORT0 = Number(process.env.HS_PORT || 9979);
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + String(i).slice(0, 150) + ']' : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  let srv = null, BASE = '';
  const killTree = () => { try { if (srv && srv.exitCode === null) cp.execSync(`taskkill /pid ${srv.pid} /T /F`, { stdio: 'ignore', windowsHide: true }); } catch (_) {} };
  const post = async (p2, tk, body) => { const r = await fetch(BASE + p2, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: JSON.stringify(body || {}) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
  const get2 = async (p2, tk) => { const r = await fetch(BASE + p2, { headers: tk ? { Authorization: 'Bearer ' + tk } : {} }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
  try {
    fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
    const salt = crypto.randomBytes(16).toString('hex'), PW = 'E2e#Rs!248';
    const mk = (id, un, nm, role) => ({ id, username: un, name: nm, role, enabled: true, createdAt: new Date().toISOString(), mustChangePw: false, salt, passHash: crypto.scryptSync(PW, salt, 32).toString('hex') });
    const now = Date.now();
    const box = (c, l) => ({ c, l, p: 'PNR1', n: '协同件1', q: 100, t: now - 864e5, by: '宋明明' });
    const slog = (c, l, i) => [`N26R00000${i}|B1|${i}`, { code: c, wt: 0, st: l, gl: '', t: now - 864e5, cx: false, pn: 'PNR1', q: 100, op: '宋明明' }];
    const boxes = [['N26R0000001', 'NB02-E-14-1F', 1], ['N26R0000002', 'NB02-E-14-2F', 2], ['N26R0000003', 'NB02-E-14-3F', 3]];
    const db0 = {
      users: [mk('u_mat248', 'rs_mat', '下单物料员', 'material'), mk('u_whA', 'rs_wha', '仓管甲', 'warehouse'), mk('u_whB', 'rs_whb', '仓管乙', 'warehouse')],
      sessions: {}, devices: {}, ops: [], notifications: [], params: { strictFifo: 0 },
      features: { material: {}, warehouse: {}, inspector: {}, admin: {} },
      outbound: {}, inspects: [], seenIn: {}, seenOut: {}, agvQueue: [], carEvents: [], ledgerTomb: [],
      ledger: boxes.map(([c, l]) => box(c, l)),
      scanlog: Object.fromEntries(boxes.map(([c, l, i]) => slog(c, l, i))),
      requisitions: [{
        id: 'RQ_RS248', no: 'LL2026112416000001', by: 'u_mat248', byName: '下单物料员', status: 'accepted', acceptedBy: '仓管甲',
        createdAt: new Date(now - 36e5).toISOString(), history: [], rev: 0,
        items: [{ partNo: 'PNR1', qty: 300, issued: [] }, { partNo: 'PNR9', qty: 50, issued: [] }],
      }],
    };
    fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
    const _t0 = Date.now();
    for (let _try = 0; _try < 8 && !srv; _try++) {
      const _p = PORT0 + _try * 3, _b = 'http://127.0.0.1:' + _p;
      const _s = cp.spawn(process.execPath, ['server.js'], { cwd: __dirname, env: Object.assign({}, process.env, { SELFTEST_NO_LIVE: '1', PORT: String(_p), HOST: '127.0.0.1', DATA_DIR: TDIR }), stdio: ['ignore', 'pipe', 'pipe'] });
      let up = false;
      for (let i = 0; i < 24 && !up; i++) {
        await sleep(250);
        try { const h = await fetch(_b + '/api/health', { signal: AbortSignal.timeout(800) }); if (!h.ok) continue; const hj = await h.json().catch(() => ({})); const sa = Date.parse(((hj.code || {}).startedAt) || '') || 0; if (sa && sa >= _t0 - 3000) up = true; } catch (_) {}
      }
      if (up) { srv = _s; BASE = _b; } else { try { cp.execSync(`taskkill /pid ${_s.pid} /T /F`, { stdio: 'ignore', windowsHide: true }); } catch (_) {} await sleep(300); }
    }
    C('护栏 实例就绪(身份校验过)', !!srv); if (!srv) throw new Error('实例未起');
    process.on('exit', killTree);
    const tkA = (await post('/api/login', null, { username: 'rs_wha', password: PW, dev: 'RSA', kind: 'pda' })).json.token;
    const tkB = (await post('/api/login', null, { username: 'rs_whb', password: PW, dev: 'RSB', kind: 'pda' })).json.token;
    C('护栏 双仓管登录', !!tkA && !!tkB); if (!tkA || !tkB) throw new Error('登录失败');

    const v0 = await get2('/api/requisitions/RQ_RS248', tkA);
    C('★ ④ 非下单人仓管可 GET 单张(协同数据源)', v0.status === 200 && v0.json.ok === true, 'st=' + v0.status);
    const rev0 = (v0.json.req || {}).rev ?? 0;
    C('★ GET 单张回带 rev(同步判据字段在位)', typeof rev0 === 'number', 'rev0=' + rev0);

    const sc1 = await post('/api/requisitions/RQ_RS248/scan', tkB, { barcode: 'N26R0000001', partNo: 'PNR1', qty: 100 });
    C('★★★ 乙扫码动作成功', sc1.json.ok === true, JSON.stringify(sc1.json).slice(0, 90));
    const vA = await get2('/api/requisitions/RQ_RS248', tkA); // 甲不关页面、直接重拉=定时链语义
    const it0 = ((vA.json.req || {}).items || [])[0] || {};
    const rev1 = (vA.json.req || {}).rev ?? 0;
    C('★★★ ① 甲视角即时看到乙发走的框(issued=1,无需关页重进)', (it0.issued || []).length === 1, 'issuedN=' + ((it0.issued || []).length));
    C('★★★ ② rev 动作后单调前进', rev1 === rev0 + 1, 'rev0→rev1=' + rev0 + '→' + rev1);

    const sk = await post('/api/requisitions/RQ_RS248/skip', tkB, { partNo: 'PNR9' });
    const vB = await get2('/api/requisitions/RQ_RS248', tkA);
    const rev2 = (vB.json.req || {}).rev ?? 0;
    C('★★ ② 第二动作(skip)再 +1(rev 持续单调)', sk.json.ok === true && rev2 === rev1 + 1, 'rev2=' + rev2);
    C('★★ ③ 陈旧包可识别(甲持 rev0/rev1 旧快照均 < rev2,客户端 sRev<=_rev 即丢弃)', rev0 < rev2 && rev1 < rev2);

    const my = await post('/api/requisitions/RQ_RS248/scan', tkA, { barcode: 'N26R0000002', partNo: 'PNR1', qty: 100, baseRev: rev2 });
    C('★★ 甲带最新 rev 自己的扫码动作正常成功(同步不伤己方动作)', my.json.ok === true, JSON.stringify(my.json).slice(0, 80));
    const vC = await get2('/api/requisitions/RQ_RS248', tkA);
    const rev3 = (vC.json.req || {}).rev ?? 0;
    C('★★ 甲动作后 rev 继续前进', rev3 === rev2 + 1, 'rev3=' + rev3);

    // ⑤ v208 软模式(默认 reqConcOn=0)真实语义：陈旧 baseRev 放行 + history 必留"⚡并发提醒"
    const stale = await post('/api/requisitions/RQ_RS248/scan', tkA, { barcode: 'N26R0000003', partNo: 'PNR1', qty: 100, baseRev: rev1 });
    C('★★ ⑤ 软模式陈旧 rev 动作放行(默认并发策略不硬断备料)', stale.json.ok === true, 'st=' + stale.status + ' ' + JSON.stringify(stale.json).slice(0, 60));
    const vD = await get2('/api/requisitions/RQ_RS248', tkA);
    const hs = JSON.stringify((vD.json.req || {}).history || []);
    C('★★★ ⑤ 软模式并发必留痕(history 含"并发提醒"，同步永不静默互盖、事后可查)', hs.includes('并发提醒'), hs.slice(-160));

    C('★ 进程存活', (await fetch(BASE + '/api/health')).ok === true);
  } catch (e) { total++; fail++; console.log('❌ 异常：' + e.message); }
  finally { killTree(); await sleep(400); try { fs.rmSync(TDIR, { recursive: true, force: true }); } catch (_) {} }
  console.log('\n结果: ' + (total - fail) + ' 通过 / ' + fail + ' 失败  （隔离副本，生产库零写入）');
  process.exit(fail ? 1 : 0);
})();
