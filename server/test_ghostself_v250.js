// ㉖v250 幽灵行判据（服务端 ghost 集）契约验证（隔离实例，生产库零写入）
// 用户 11-25 实锤：PDA 与手机查同一零件数量不一致——PDA 缓存里躺着一行服务器"账本无行+
// 已出库+墓碑被滚动清理"的幽灵框，靠墓碑删除通道永远摘不掉。本测锁 ghost 判据的服务端契约：
//   ① ?ghost=1 不带 token → 不带 ghost 字段（公开页零泄露历史标签号）
//   ② 带 token → ghost 数组，项为 {c, at}（at=出库时刻，供 PDA 时间戳比对保留回流框）
//   ③ 账本仍有行的框排除（在架正常，非幽灵）
//   ④ 有墓碑的框排除（走既有墓碑通道，不双开）
//   ⑤ 出库留痕超 30 天的排除（老账本不动，控包体）
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const TDIR = path.join(__dirname, '_gh_v250'), PORT0 = Number(process.env.HS_PORT || 9983);
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + String(i).slice(0, 160) + ']' : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  let srv = null, BASE = '';
  const killTree = () => { try { if (srv && srv.exitCode === null) cp.execSync(`taskkill /pid ${srv.pid} /T /F`, { stdio: 'ignore', windowsHide: true }); } catch (_) {} };
  const get2 = async (p2, tk) => { const r = await fetch(BASE + p2, { headers: tk ? { Authorization: 'Bearer ' + tk } : {} }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
  const post = async (p2, body) => { const r = await fetch(BASE + p2, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); return r.json().catch(() => ({})); };
  try {
    fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
    const salt = crypto.randomBytes(16).toString('hex'), PW = 'E2e#Gh!250';
    const now = Date.now(), D = 864e5;
    const db0 = {
      users: [{ id: 'u_gh250', username: 'gh_u', name: '幽灵测试', role: 'admin', enabled: true, createdAt: new Date().toISOString(), mustChangePw: false, salt, passHash: crypto.scryptSync(PW, salt, 32).toString('hex') }],
      sessions: {}, devices: {}, ops: [], notifications: [], params: null,
      features: {}, requisitions: [], outbound: {}, scanlog: {}, inspects: [], seenIn: {}, agvQueue: [], carEvents: [],
      ledger: [{ c: 'N26G0000001', l: 'NB02-A-01-1F', p: 'PNG1', n: '在架件', q: 100, t: now - D, by: '宋明明' }],
      ledgerEpoch: 'IMP-20261022b', ledgerEpochAt: now - 10 * D, // 已新章态：否则 ensureDb 世代新章清退"迁移前旧碑"，测试碑被清=假失败（产品既有逻辑非幽灵代码 bug）
      ledgerTomb: [{ c: 'N26G0000002', t: now - D, rec: now - D }],
      seenOut: {
        'N26G0000001': { at: now - 2 * D, no: 'DT-X1' }, // 账本有行 → 排除③
        'N26G0000002': { at: now - 2 * D, no: 'DT-X2' }, // 有墓碑 → 排除④
        'N26G0000003': { at: now - 3 * D, no: 'DT-X3' }, // 账本无+无碑+近30天 → 幽灵 ✓
        'N26G0000004': { at: now - 40 * D, no: 'DT-X4' }, // 超30天 → 排除⑤
      },
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
    const j = await post('/api/login', { username: 'gh_u', password: PW, dev: 'GH', kind: 'pda' });
    const tk = j.token; C('护栏 登录', !!tk); if (!tk) throw new Error('登录失败');

    const anon = await get2('/api/ledger?ghost=1', null);
    C('★★★ ① 未登录 ?ghost=1 不带 ghost 字段（零泄露）', anon.json.ok === true && anon.json.ghost === undefined, 'ghost=' + JSON.stringify(anon.json.ghost));
    const pub = await get2('/api/ledger', tk);
    C('★ 带 token 但不请求 ghost → 也不带（按需回）', pub.json.ghost === undefined);

    const g = await get2('/api/ledger?ghost=1', tk);
    const gh = g.json.ghost;
    C('★★★ ② ghost 数组且项={c,at}', Array.isArray(gh) && gh.length === 1 && gh[0].c === 'N26G0000003' && Number(gh[0].at) > 0, JSON.stringify(gh));
    C('★★★ ③ 账本在架排除 / ④ 有碑排除 / ⑤ 超窗排除', gh && !gh.some((x) => ['N26G0000001', 'N26G0000002', 'N26G0000004'].includes(x.c)), JSON.stringify((gh || []).map((x) => x.c)));

    C('★ 进程存活', (await fetch(BASE + '/api/health')).ok === true);
  } catch (e) { total++; fail++; console.log('❌ 异常：' + e.message); }
  finally { killTree(); await sleep(400); try { fs.rmSync(TDIR, { recursive: true, force: true }); } catch (_) {} }
  console.log('\n结果: ' + (total - fail) + ' 通过 / ' + fail + ' 失败  （隔离副本，生产库零写入）');
  process.exit(fail ? 1 : 0);
})();
