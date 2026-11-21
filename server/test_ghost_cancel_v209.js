// ㉖v209 领料取消回滚 + 不变量④(在途蒸发哨兵) 端到端验证
// 背景（复核实锤地基漏洞）：scan 成功即从权威账本 splice；旧版 cancel 只清 AGV 队列、
//   对"已扫未转"框零处理 → 账本无行+MES无账+seenOut无记 三处无主=幽灵在途框，下单人即可触发。
// 修复：① cancel 复用 unscanRollbackOne 回挂账本+返架（与关单同款）；② invariantSweep 加不变量④
//   （领料单拣下框三处无主即点名）兜历史遗留/skip残留。
// 夹具全自造、不碰生产库。构造两单：R1=accepted已扫未转(可取消，测回滚)，R2=cancelled已扫未转(历史遗留，测哨兵)。
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const TDIR = path.join(__dirname, '_ghost_v209');
const START = Number(process.env.HS_PORT || 9960);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + String(i).slice(0, 130) + ']' : ''}`); };
(async () => {
  let srv = null, URL2 = '';
  const killTree = () => { try { if (srv && srv.exitCode === null) cp.execSync(`taskkill /pid ${srv.pid} /T /F`, { stdio: 'ignore', windowsHide: true }); } catch (_) {} };
  try {
    fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
    const salt = crypto.randomBytes(16).toString('hex'), PW = 'E2e#Hs!209';
    const hp = (p) => crypto.scryptSync(p, salt, 32).toString('hex');
    const ts = new Date().toISOString();
    const G1 = 'N26QH2090001', G2 = 'N26QH2090002', PN = 'T209PART';
    const db0 = {
      users: [{ id: 'u_g209', username: 'gh_u', name: '幽灵测试管理', role: 'admin', enabled: true, createdAt: ts, mustChangePw: false, salt, passHash: hp(PW) }],
      features: { admin: { requisition: true, agv_control: true } },
      sessions: {}, devices: {}, ops: [], notifications: [], outbound: {}, scanlog: {}, agvQueue: [], agvTasks: {}, carEvents: [], inspects: [],
      params: { invariantAlertOn: 1, outConsumeLedger: 0, strictFifo: 1 }, // 关出库消账避③干扰；①④独立
      ledger: [{ c: 'N26QH209LEDOK', l: 'NB03-A-12-01', p: PN, n: '正常件', q: 100, f: '托盘', t: Date.now() - 864e5, by: '张三', b: 'B', pid: 'TPLED' }],
      requisitions: [
        { id: 'req_v209_r1', no: 'LLV209R1', by: 'u_g209', byName: '幽灵测试管理', status: 'accepted', acceptedBy: '幽灵测试管理', acceptedAt: ts, createdAt: ts, history: [],
          items: [{ partNo: PN, itemName: '幽灵件', qty: 200, issued: [{ c: G1, q: 200, l: 'NB03-A-11-05', b: 'B' }], transferred: false }] },
        { id: 'req_v209_r2', no: 'LLV209R2', by: 'u_g209', byName: '幽灵测试管理', status: 'cancelled', createdAt: ts, history: [],
          items: [{ partNo: PN, itemName: '幽灵件', qty: 300, issued: [{ c: G2, q: 300, l: 'NB03-A-13-02', b: 'B' }], transferred: false }] },
      ],
      wmasConfig: null, rcsConfig: null, rcsStations: {},
    };
    fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
    // spawnUp：身份校验——health.code.startedAt 必须晚于本轮拉起（防僵尸实例劫持端口，v219 教训）
    const spawnUp = async (start) => {
      for (let p = start; p < start + 20; p++) {
        const myStart = Date.now() - 2000;
        const url = 'http://127.0.0.1:' + p;
        const s = cp.spawn(process.execPath, ['server.js'], { cwd: __dirname, env: Object.assign({}, process.env, { SELFTEST_NO_LIVE: '1', PORT: String(p), HOST: '127.0.0.1', DATA_DIR: TDIR }), stdio: ['ignore', 'pipe', 'pipe'] });
        let mine = false;
        for (let i = 0; i < 24 && !mine; i++) {
          await sleep(250);
          try { const hj = await (await fetch(url + '/api/health', { signal: AbortSignal.timeout(700) })).json(); if (hj && hj.code && hj.code.startedAt && Date.parse(hj.code.startedAt) >= myStart) mine = true; } catch (_) {}
        }
        if (mine) return { p, s, url };
        try { cp.execSync(`taskkill /pid ${s.pid} /T /F`, { stdio: 'ignore', windowsHide: true }); } catch (_) {}
        await sleep(300);
      }
      throw new Error('连续 20 端口无【本轮】实例（僵尸占口，请清理残留 server.js）');
    };
    const up = await spawnUp(START); srv = up.s; URL2 = up.url;
    const post2 = async (p2, tk, body) => { const r = await fetch(URL2 + p2, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: JSON.stringify(body || {}) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
    const get2 = async (p2, tk) => { const r = await fetch(URL2 + p2, { headers: tk ? { Authorization: 'Bearer ' + tk } : {} }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
    const tk = (await post2('/api/login', null, { username: 'gh_u', password: PW, dev: 'GH', kind: 'pda' })).json.token;
    C('护栏 实例就绪(身份校验)+登录', !!tk); if (!tk) throw new Error('登录失败');
    // ① 不变量④首跑（启动14秒触发）扫出历史遗留 R2 幽灵；活跃单 R1(accepted未跳过)不应被误判
    await sleep(15000);
    const ic = (await get2('/api/health', tk)).json.invariant || {};
    C('★★★ ① 哨兵在岗：不变量④扫出历史遗留 R2 幽灵（lost≥1）', (ic.lost || 0) >= 1, 'invariant=' + JSON.stringify(ic));
    C('★★ ① 活跃单 R1 不被误判（lost 恰=1，仅 R2）', (ic.lost || 0) === 1, 'lost=' + ic.lost);
    // ② 取消 R1 → 幽灵框 G1 回挂账本（src=退回复位）+ issued 清空 + 单转 cancelled
    const cx = await post2('/api/requisitions/req_v209_r1/cancel', tk, { reason: '现场误下' });
    C('★★★ ② 取消成功且单据转 cancelled', cx.json.ok === true && (cx.json.req || {}).status === 'cancelled', 'st=' + cx.status + ' status=' + (cx.json.req || {}).status);
    const r1item = ((cx.json.req || {}).items || [])[0] || {};
    C('★★ ② 取消后该行 issued 清空（回滚移除，无脏引用）', Array.isArray(r1item.issued) && r1item.issued.length === 0, JSON.stringify(r1item.issued));
    const hTxt = ((cx.json.req || {}).history || []).map((h) => h.text).join('|');
    C('★★ ② 取消履历含回滚留痕（框已退回货架）', /框已退回货架/.test(hTxt), hTxt.slice(0, 100));
    await sleep(700); // 等落盘
    const disk = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    const ledC = new Set((disk.ledger || []).map((x) => String(x.c).toUpperCase()));
    C('★★★ ② 落库铁证：幽灵框 G1 已回挂权威账本（不再蒸发）', ledC.has(G1), '账本码=' + [...ledC].join(','));
    const backRow = (disk.ledger || []).find((x) => String(x.c).toUpperCase() === G1) || {};
    C('★★ ② 回挂位=原货位 NB03-A-11-05 且来源=退回复位', String(backRow.l).toUpperCase() === 'NB03-A-11-05' && String(backRow.src || '') === '退回复位', JSON.stringify({ l: backRow.l, src: backRow.src }));
    C('★★ ② 不误伤正常框 LEDOK（取消只动该单 issued）', ledC.has('N26QH209LEDOK'));
    // ③ R2 的幽灵框 G2 不应被取消逻辑误动（本次只取消 R1）→ 仍无归宿、仍会被哨兵持续点名（不静默消失）
    C('★★ ③ 未取消的 R2 幽灵 G2 不被动（账本仍无它，哨兵持续在岗）', !ledC.has(G2));
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
