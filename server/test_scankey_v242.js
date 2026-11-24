// ㉖v242 scanlog 键归一+三要素回填 端到端验证（真实库副本跑迁移，生产 db.json 零写入）
// 用户 11-24 拍板一次性修复 3 条手输小写键有效行：N26K230106/109/110（已出库、缺物料名/采集人/格位）。
// 断言=迁移前生产实况快照逐值对照（快照值若与现实不符直接 FAIL，防静默漏修/多修）：
//   键归一 3 条（小写→大写，全库仅这 3 条小写键）
//   物料名回填：109/110=左前纵梁内板(6608482076-A)、106=动力总成托架右上安装支架(6608465042-A)
//   采集人回填：同批次 B2026-11-24-0822 众数=宋明明（21 条实测）
//   格位回填：出库单 DT20261124083042 fromLoc → 106=A-01-01, 110=A-01-02, 109=A-01-03
//   其余行零扰动：迁移前后 scanlog 行数不变、230111 大写有效行内容不变
//   幂等：同库二次启动 → fixLog 不再增长、行数不变
const fs = require('fs'), path = require('path'), cp = require('child_process');
const TDIR = path.join(__dirname, '_sk_v242'), PORT = Number(process.env.HS_PORT || 9971);
const BASE = 'http://127.0.0.1:' + PORT;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + String(i).slice(0, 160) + ']' : ''}`); };
(async () => {
  let srv;
  const killTree = () => { try { if (srv && srv.exitCode === null) cp.execSync(`taskkill /pid ${srv.pid} /T /F`, { stdio: 'ignore', windowsHide: true }); } catch (_) {} };
  const boot = async (t0) => {
    let up = false, h = null;
    for (let i = 0; i < 24 && !up; i++) {
      await sleep(250);
      try { const r = await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(800) }); if (!r.ok) continue; const hj = await r.json().catch(() => ({})); const sa = Date.parse(((hj.code || {}).startedAt) || '') || 0; if (sa && sa >= t0 - 3000) { up = true; h = hj; } } catch (_) {}
    }
    return { up, h };
  };
  try {
    fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), path.join(TDIR, 'db.json'));
    // 迁移前快照锚点（与 11-24 生产实况核对，漂移即 FAIL）
    const pre = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    const preKeys = Object.keys(pre.scanlog || {});
    const preLower = preKeys.filter((k) => k.split('|')[0] !== k.split('|')[0].toUpperCase());
    C('护栏 迁移前生产键态快照（全库小写键=5：目标三码有效+230111两作废）', preLower.length === 5 && ['230106', '230109', '230110'].every((s) => preLower.some((k) => k.toLowerCase().includes(s))), preLower.map((k) => k.split('|')[0]).join(','));
    const rowOf = (db, codeUp) => { for (const [k, v] of Object.entries(db.scanlog || {})) if (String(v.code || k.split('|')[0]).toUpperCase() === codeUp && v.cx !== true) return { k, v }; return null; };
    const preN = Object.keys(pre.scanlog || {}).length;
    const pre230111 = rowOf(pre, 'N26K230111');
    C('护栏 迁移前 230111 大写有效行在册（零扰动对照基线）', !!pre230111 && pre230111.k.startsWith('N26K230111|'), pre230111 ? pre230111.k.slice(0, 46) : '(缺)');
    // —— 首启：8 秒链跑迁移 ——
    const t0 = Date.now();
    srv = cp.spawn(process.execPath, ['server.js'], { cwd: __dirname, env: Object.assign({}, process.env, { SELFTEST_NO_LIVE: '1', PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }), stdio: ['ignore', 'pipe', 'pipe'] });
    process.on('exit', killTree);
    const b1 = await boot(t0);
    C('护栏 首启实例就绪(身份校验过)', b1.up); if (!b1.up) throw new Error('实例未起');
    let post = null;
    for (let i = 0; i < 50; i++) { await sleep(400); try { const d = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8')); if (d.scanKeyUpperV242 === 1) { post = d; break; } } catch (_) {} }
    C('★★★ ① v242 迁移执行并落标志', !!post);
    if (!post) throw new Error('迁移未落库');
    // 键归一断言
    const postLower = Object.keys(post.scanlog || {}).filter((k) => k.split('|')[0] !== k.split('|')[0].toUpperCase());
    C('★★★ ② 键归一：迁移后全库零小写键', postLower.length === 0, postLower.join(','));
    C('★★ ③ 行数不变（键改名+零增删）', Object.keys(post.scanlog || {}).length === preN, Object.keys(post.scanlog || {}).length + ' vs ' + preN);
    // 三码逐值断言（快照对照）
    const want = {
      N26K230106: { nm: '07-吉利E281动力总成托架右上安装支架6608465042-A分总成', gl: 'NB03-A-01-01' },
      N26K230109: { nm: '07-吉利E281左前纵梁内板本体6608482076-A分总成', gl: 'NB03-A-01-03' },
      N26K230110: { nm: '07-吉利E281左前纵梁内板本体6608482076-A分总成', gl: 'NB03-A-01-02' },
    };
    for (const code of Object.keys(want)) {
      const r = rowOf(post, code);
      C('★★★ ④ ' + code + ' 物料名/采集人/格位三要素回填精确到位', !!r && r.k.startsWith(code + '|') && String(r.v.nm) === want[code].nm && String(r.v.op) === '宋明明' && String(r.v.gl) === want[code].gl, r ? ('nm=' + String(r.v.nm).slice(0, 14) + ' op=' + r.v.op + ' gl=' + r.v.gl) : '(行缺)');
    }
    // 零扰动 + 留档
    const post230111 = rowOf(post, 'N26K230111');
    C('★★ ⑤ 230111 大写有效行零扰动', !!post230111 && post230111.k === pre230111.k && String(post230111.v.nm) === String(pre230111.v.nm), post230111 ? post230111.v.op : '(缺)');
    const lg = post.scanKeyFixLogV242 || [];
    C('★★ ⑥ 修复留档在册=5（仅被键归一行，回填严格限定批准范围）', lg.length === 5 && lg.every((x) => x.before && x.after), 'log=' + lg.length + ' 条');
    // 越权防护：两库共存键（未改名行）且不在留档内 → 内容必须逐字段全等
    const fixedKs = new Set(lg.map((x) => x.k));
    let touched = 0; for (const k of Object.keys(post.scanlog || {})) { const b = (pre.scanlog || {})[k]; if (b && !fixedKs.has(k) && JSON.stringify(b) !== JSON.stringify(post.scanlog[k])) touched++; }
    C('★★★ ⑥b 越权防护：留档之外零行被改动', touched === 0, 'touched=' + touched);
    killTree(); await sleep(900);
    // —— 二次启动：幂等 ——
    const preLogN = (post.scanKeyFixLogV242 || []).length, preN2 = Object.keys(post.scanlog || {}).length;
    srv = cp.spawn(process.execPath, ['server.js'], { cwd: __dirname, env: Object.assign({}, process.env, { SELFTEST_NO_LIVE: '1', PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }), stdio: ['ignore', 'pipe', 'pipe'] });
    const t2 = Date.now(); const b2 = await boot(t2);
    C('护栏 二次启动就绪', b2.up); if (!b2.up) throw new Error('二启未起');
    await sleep(11500); // 过 8 秒迁移链窗口
    const p3 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    C('★★★ ⑦ 幂等：二启不二次改动（标志仍在、fixLog/行数不变）', p3.scanKeyUpperV242 === 1 && (p3.scanKeyFixLogV242 || []).length === preLogN && Object.keys(p3.scanlog || {}).length === preN2, 'log=' + (p3.scanKeyFixLogV242 || []).length + ' 行=' + Object.keys(p3.scanlog || {}).length);
    C('★ 进程存活', (await fetch(BASE + '/api/health')).ok === true);
  } catch (e) { total++; fail++; console.log('❌ 异常：' + e.message); }
  finally {
    killTree();
    await sleep(400);
    try { fs.rmSync(TDIR, { recursive: true, force: true }); } catch (_) {}
  }
  console.log('\n结果: ' + (total - fail) + ' 通过 / ' + fail + ' 失败  （真实库副本跑迁移，生产零写入）');
  process.exit(fail ? 1 : 0);
})();
