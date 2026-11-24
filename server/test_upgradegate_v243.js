// ㉖v243 强制升级闸门·服务端下发 端到端验证（隔离实例，生产库零写入）
// 用户拍板：不更新不让用（防拖延不更新致旧版缺陷持续造数据）。闸门 UI 在 PDA 侧（analyze 基线+审查覆盖），
// 本测锁服务端职责：minBuild 参数默认 0（关，不误伤）→ 管理员调线即时随登录/心跳下发 → 非法值 400 钳制。
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const TDIR = path.join(__dirname, '_ug_v243'), PORT0 = Number(process.env.HS_PORT || 9973);
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
    const salt = crypto.randomBytes(16).toString('hex'), PW = 'E2e#Ug!243';
    const mk = (id, un, nm, role) => ({ id, username: un, name: nm, role, enabled: true, createdAt: new Date().toISOString(), mustChangePw: false, salt, passHash: crypto.scryptSync(PW, salt, 32).toString('hex') });
    const db0 = {
      users: [mk('u_ad243', 'ug_adm', '闸门管理员', 'admin'), mk('u_wh243', 'ug_wh', '仓管甲', 'warehouse')],
      sessions: {}, devices: {}, ops: [], notifications: [], params: null,
      features: { material: {}, warehouse: {}, inspector: {}, admin: { admin_panel: true } },
      requisitions: [], outbound: {}, ledger: [], scanlog: {}, agvQueue: [], inspects: [], seenIn: {}, seenOut: {},
    };
    fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
    // 逐端口试启 + startedAt 身份校验（认亲儿子，僵尸换口）
    const _t0 = Date.now();
    for (let _try = 0; _try < 8 && !srv; _try++) {
      const _p = PORT0 + _try * 3; const _b = 'http://127.0.0.1:' + _p;
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
    const tkAd = (await post('/api/login', null, { username: 'ug_adm', password: PW, dev: 'UGA', kind: 'web' })).json.token;
    const tkWh = (await post('/api/login', null, { username: 'ug_wh', password: PW, dev: 'UGW', kind: 'pda' })).json.token;
    C('护栏 登录(管理+仓管)', !!tkAd && !!tkWh); if (!tkAd) throw new Error('登录失败');

    C('★★★ ① 默认 minBuild=0（关闸不误伤）：登录响应带 minBuild 字段且=0', typeof (await post('/api/login', null, { username: 'ug_wh', password: PW, dev: 'UGW2', kind: 'pda' })).json.minBuild === 'number' && (await post('/api/login', null, { username: 'ug_wh', password: PW, dev: 'UGW3', kind: 'pda' })).json.minBuild === 0);
    C('★★ ② 参数定义在册：GET /api/admin/params 含 minBuild', JSON.stringify(await get2('/api/admin/params', tkAd)).includes('minBuild'));

    // 取当前 cfgRev 走乐观锁（容错 0）
    const gp = await get2('/api/admin/params', tkAd);
    const rev = (gp.json.cfgRev != null ? gp.json.cfgRev : ((gp.json.params && gp.json.params.cfgRev) || 0));
    const set = async (v) => post('/api/admin/params', tkAd, { values: { minBuild: v }, baseRev: rev });
    const s1 = await set(216);
    C('★★★ ③ 管理员调线 216 成功', s1.json.ok === true, JSON.stringify(s1.json).slice(0, 90));
    const lr = (await post('/api/login', null, { username: 'ug_wh', password: PW, dev: 'UGW4', kind: 'pda' })).json;
    C('★★★ ④ 调线后登录即时回带 minBuild=216（旧设备下次登录即被拦）', lr.minBuild === 216, 'minBuild=' + lr.minBuild);
    const me = await get2('/api/me', tkWh);
    C('★★★ ⑤ 心跳 /api/me 也回带 minBuild=216（在线期改线前台恢复可见）', me.json.minBuild === 216, 'minBuild=' + me.json.minBuild);

    // 非法值须走到范围校验=先重取 cfgRev（③调线后已 bump），否则被乐观锁 409 提前挡=测不到 400
    const gpB = await get2('/api/admin/params', tkAd);
    const revB = (gpB.json.cfgRev != null ? gpB.json.cfgRev : rev);
    const s2 = await post('/api/admin/params', tkAd, { values: { minBuild: 999999 }, baseRev: revB });
    C('★★ ⑥ 非法值(>max9999) 走到校验被 400 拒', s2.status === 400 && s2.json.ok === false, 'st=' + s2.status + ' ' + JSON.stringify(s2.json).slice(0, 70));

    // 调回 0：即时关闸（另取 cfgRev 防 409）
    const gp2 = await get2('/api/admin/params', tkAd);
    const rev2 = (gp2.json.cfgRev != null ? gp2.json.cfgRev : rev);
    await post('/api/admin/params', tkAd, { values: { minBuild: 0 }, baseRev: rev2 });
    const lr2 = (await post('/api/login', null, { username: 'ug_wh', password: PW, dev: 'UGW5', kind: 'pda' })).json;
    C('★★★ ⑦ 调回 0 即时关闸：登录回带 minBuild=0', lr2.minBuild === 0, 'minBuild=' + lr2.minBuild);

    C('★ 进程存活', (await fetch(BASE + '/api/health')).ok === true);
  } catch (e) { total++; fail++; console.log('❌ 异常：' + e.message); }
  finally { killTree(); await sleep(400); try { fs.rmSync(TDIR, { recursive: true, force: true }); } catch (_) {} }
  console.log('\n结果: ' + (total - fail) + ' 通过 / ' + fail + ' 失败  （隔离副本，生产库零写入）');
  process.exit(fail ? 1 : 0);
})();
