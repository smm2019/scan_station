// ㉖v227 全链路"曾被采集（已被覆盖）"假覆盖噪声根治 端到端验证（隔离实例，生产库零写入）
// 背景（用户 11-23 实锤 N26K230060）：全链路 3 条灰色"♻曾被采集"节点与活跃行逐字段全同=谎报覆盖。
// 根因：v205 真覆盖判定在前、v85b gl粗码对齐段在后——AGV模式推送行 gl=空串与库内完整格位"不同"→误产 hist，
//   随后对齐段把 v.gl 填回完整值 → hist 摘要与活跃行全同。判定在时序上被后段抹平=结构性漏洞。
// 修法：①写入端——对齐落定后剔除与自身窄字段摘要全同的 hist（断根+周期回灌自然清洗存量=自愈）；
//   ②显示端——/api/trace 渲染时跳过全同 hist（从未再被推送的存量脏行立即止血）；真覆盖（位置/数量变）逐字保留。
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const TDIR = path.join(__dirname, '_hn_v227'), PORT = Number(process.env.HS_PORT || 9959);
const BASE = 'http://127.0.0.1:' + PORT;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + String(i).slice(0, 150) + ']' : ''}`); };
const post = async (p2, tk, body) => { const r = await fetch(BASE + p2, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: JSON.stringify(body || {}) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
const get2 = async (p2, tk) => { const r = await fetch(BASE + p2, { headers: tk ? { Authorization: 'Bearer ' + tk } : {} }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
const row = (k, code, extra) => Object.assign({ k, code, wt: 0, st: 'NB02-CK-01', gl: '', ct: '纸箱', rm: '', cx: false, q: 80, pn: '6608360021', op: '刘向轩', batch: 'B2026-11-23-1047' }, extra || {});
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
    const salt = crypto.randomBytes(16).toString('hex'), PW = 'E2e#Hs!227';
    const now = Date.now();
    // 夹具预置三行流水：
    // KA=现场复刻（库内 gl 已是完整格位=首推+对齐后的态，无 hist）
    // KB=存量脏 hist（一条与自身全同=假覆盖，一条真覆盖 gl 不同）→ 验显示端只跳全同、真覆盖保留
    const KA = 'N26K230060|B2026-11-23-1047|' + (now - 60 * 60000);
    const KB = 'N26K230061|B2026-11-23-1047|' + (now - 60 * 60000);
    const mkRow = (code, gl, hist) => ({ code, wt: 0, st: 'NB02-CK-01', gl, ct: '纸箱', rm: '', cx: false, q: 80, pn: '6608360021', op: '刘向轩', batch: 'B2026-11-23-1047', t: now - 60 * 60000, hist });
    const sameH = { t: now - 60 * 60000, q: 80, gl: 'NB02-A-02-3F', st: 'NB02-CK-01', wt: 0, cx: false, op: '刘向轩' };
    // 真覆盖体现为站台 st 差异（AGV 模式显示端位置列取 st=口径一致；gl 差异在 AGV 展示里不可见，不作断言依据）
    const realH = { t: now - 60 * 60000, q: 80, gl: 'NB02-A-02-3F', st: 'NB02-CK-02', wt: 0, cx: false, op: '刘向轩' };
    const db0 = {
      users: [{ id: 'u_hn227', username: 'hn_u', name: '去噪测试管理', role: 'admin', enabled: true, createdAt: new Date().toISOString(), mustChangePw: false, salt, passHash: crypto.scryptSync(PW, salt, 32).toString('hex') }],
      sessions: {}, devices: {}, ops: [], notifications: [],
      requisitions: [], outbound: {}, ledger: [], agvQueue: [], inspects: [], seenIn: {}, seenOut: {},
      features: { material: {}, warehouse: { collect: true }, inspector: {}, admin: { collect: true } },
      rcsConfig: null, wmasConfig: null, rcsStations: {},
      // KA 的账本行=gl 粗码升级源（现场假覆盖链的必备环节：推送行 gl=空串被对齐段从账本填回完整格位，
      // 填回后与 hist 摘要全同——这才是 N26K230060 假覆盖的确切成因，缺这行则复现的是"真降级"非假覆盖）
      ledger: [{ c: 'N26K230060', l: 'NB02-A-02-3F', f: '纸箱', p: '6608360021', n: '测试件', q: 80, t: now - 60 * 60000, by: '刘向轩', rec: now - 60 * 60000 }],
      scanlog: {
        [KA]: mkRow('N26K230060', 'NB02-A-02-3F', []),
        [KB]: mkRow('N26K230061', 'NB02-A-02-3F', [Object.assign({}, sameH), Object.assign({}, realH)]),
      },
    };
    fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
    srv = cp.spawn(process.execPath, ['server.js'], { cwd: __dirname, env: Object.assign({}, process.env, { SELFTEST_NO_LIVE: '1', PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }), stdio: ['ignore', 'pipe', 'pipe'] });
    process.on('exit', killTree);
    let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(600) })).ok; } catch (_) {} }
    C('护栏 实例就绪', up); if (!up) throw new Error('实例未起');
    const tk = (await post('/api/login', null, { username: 'hn_u', password: PW, dev: 'HN', kind: 'pda' })).json.token;
    C('护栏 管理员登录', !!tk); if (!tk) throw new Error('登录失败');

    // ① 复刻现场：同键重推，gl=空串（PDA 原始形态）、其余与库内全同 → 旧版必产 1 条全同 hist
    const rs1 = await post('/api/scanlog/sync', tk, { items: [row(KA, 'N26K230060', { t: now - 60 * 60000, gl: '' })] });
    C('护栏 流水同步被受理', rs1.json.ok === true, JSON.stringify(rs1.json).slice(0, 110));

    // ② 真覆盖对照：同键重推 q 80→90 且 gl 完整且变化 → 真 hist 必须保留
    const rs2 = await post('/api/scanlog/sync', tk, { items: [row(KA, 'N26K230060', { t: now - 60 * 60000, gl: 'NB02-A-02-3F', q: 90 })] });
    C('护栏 真覆盖推送被受理', rs2.json.ok === true);

    // 轮询等异步落盘（v225 教训：读早了是假失败；判据=KA 行 q 已变 90=第二推已落）
    let dbA = null;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      try { dbA = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8')); } catch (_) { continue; }
      const ka = (dbA.scanlog || {})[KA];
      if (ka && Number(ka.q) === 90) break;
    }
    const ka = (dbA.scanlog || {})[KA] || {};
    const _hsum = (x) => [Number(x.t) || 0, Number(x.q) || 0, String(x.gl || ''), String(x.st || ''), Number(x.wt) || 0, !!x.cx].join('\u0001');
    const sameInKa = (ka.hist || []).filter((h) => _hsum(h) === _hsum(ka)).length;
    C('★★★ ① 假覆盖断根：重推(gl空对齐回填)后 KA 的 hist 里没有与自身全同的条目', sameInKa === 0, 'hist=' + JSON.stringify(ka.hist || []).slice(0, 160));
    C('★★★ ② 真覆盖保留：q 80→90 那条真 hist 仍在（v205 防蒸发能力零损失）', (ka.hist || []).some((h) => Number(h.q) === 80) && (ka.hist || []).length > 0, 'hist=' + JSON.stringify(ka.hist || []).slice(0, 160));

    // ③ 显示端止血：KB 存量脏 hist（1全同+1真覆盖）从未再推送=文件里原样，trace 必须只报真覆盖那条
    const tr = await get2('/api/trace?q=N26K230061', tk);
    const evs = ((tr.json.trace || tr.json.events) || []).filter((e) => e.kind === 'hist');
    const titles = evs.map((e) => (e.detail || '') + '|' + (e.title || ''));
    C('★★★ ③ 显示端：全链路 hist 节点只剩真覆盖 1 条（全同那条已跳过）', evs.length === 1 && String(titles[0]).includes('NB02-CK-02'), JSON.stringify(titles).slice(0, 180));
    C('★★ ③ 该框活跃采集蓝节点照常存在（去噪不误伤正常节点）', ((tr.json.trace || tr.json.events) || []).some((e) => e.kind === 'scan' && String(e.title || '').includes('N26K230061')), JSON.stringify(((tr.json.trace || tr.json.events) || []).map((e) => e.kind)).slice(0, 120));

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
