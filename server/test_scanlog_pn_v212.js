// ㉖v212 流水接口 pn 过滤先于 limit 截断 + 档案页按件精确拉取 端到端验证
// 背景（v211 收口时主动报备的"过几天就会越界"隐患，用户拍板"要修"）：
//   零件档案页"补全别台设备采集的框"拉服务器流水，旧写法无过滤全量拉（limit=5000）回端上筛。
//   全库流水 4438 条，上限一到，时刻最早的老框流水沉到截断线以下 → 该框在档案页整段隐身
//   （v109 补收层救不了：它补的是"账本独有"，而老框账本已无行、流水又被截 → 两头空）。
// 修复：封装加 pn=（服务器 4638 行 fpn 过滤在 4648 行 slice(0,lim) 之前），档案页带零件号查询。
// ★ 真跑理由：①"pn 过滤确实排在 limit 截断之前"只有构造越界数据才能证明——现在库内还没越界，
//   静态看代码顺序对了没用，必须造 >limit 的库真验老行能透出；②端上旧筛选逻辑保留后新过滤参数
//   是否与之兼容（大小写/空串）要真验；③无 pn= 零回归。
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const TDIR = path.join(__dirname, '_slpn_v212'), PORT = Number(process.env.HS_PORT || 9941);
const BASE = 'http://127.0.0.1:' + PORT;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + String(i).slice(0, 130) + ']' : ''}`); };
const getj = async (p2, tk) => { const r = await fetch(BASE + p2, { headers: tk ? { Authorization: 'Bearer ' + tk } : {} }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
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
    if (probe === 'busy') throw new Error('端口 ' + PORT + ' 被占用——用 HS_PORT=其他端口 重跑');
    const db0 = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'db.json'), 'utf8'));
    const salt = crypto.randomBytes(16).toString('hex'), PW = 'E2e#Hs!212';
    db0.users.push({ id: 'u_hs_sp_adm', username: '流水测试管理', name: '流水测试管理', role: 'admin', enabled: true, createdAt: Date.now(), mustChangePw: false, salt, passHash: crypto.scryptSync(PW, salt, 32).toString('hex') });
    db0.wmasConfig = null; db0.rcsConfig = null;
    // 造越界：注入 50 条"填充框"流水（时刻=现在，全排在倒序头部），把 1 条"老框"流水
    // （时刻=30 天前，倒序尾部）挤出 limit=50 截断线——复刻"全库越界后老框隐身"的真实结构
    const OLD_PN = 'T212OLDPN1';
    const oldT = Date.now() - 30 * 864e5;
    db0.scanlog['T212OLD|B|' + oldT] = { code: 'T212OLDCODE', pn: OLD_PN, q: 200, t: oldT, op: '老框测试', gl: 'NB03-A-12', cx: false, wt: 1, lot: 'L212', pid: '', batch: 'B212', nm: '越界老框' };
    for (let i = 0; i < 50; i++) {
      const ti = Date.now() - i * 1000; // 都比老框新，倒序全压它
      db0.scanlog['T212FILL' + i + '|B|' + ti] = { code: 'T212FILL' + i, pn: 'T212FILLPN', q: 10, t: ti, op: '填充', gl: 'NB03-B-01', cx: false, wt: 1, lot: '', pid: '', batch: 'B', nm: '填充框' };
    }
    fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
    srv = cp.spawn(process.execPath, ['server.js'], { cwd: __dirname, env: Object.assign({}, process.env, { SELFTEST_NO_LIVE: '1', PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }), stdio: ['ignore', 'pipe', 'pipe'] });
    process.on('exit', killTree);
    let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(600) })).ok; } catch (_) {} }
    C('护栏 实例就绪', up); if (!up) throw new Error('实例未起');
    const login = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: '流水测试管理', password: PW, dev: 'SP', kind: 'pda' }) });
    const tk = (await login.json()).token;
    C('护栏 管理员登录', !!tk); if (!tk) throw new Error('登录失败');
    // ① 复现盲区前提：limit=50 且无 pn 过滤时，老框被 51 条新流水挤出
    const r0 = await getj('/api/scanlog?limit=50', tk);
    const seenOld0 = (r0.json.items || []).some((x) => x.code === 'T212OLDCODE');
    C('★★★ ① 无过滤越界复现：limit=50 时老框流水被挤出（隐患真实结构）', seenOld0 === false && (r0.json.items || []).length === 50, '老框在?=' + seenOld0);
    // ② 核心：带 pn 后老框透出，且过滤先于 limit（limit=1 也只回它）
    const r1 = await getj('/api/scanlog?pn=' + OLD_PN + '&limit=1', tk);
    C('★★★ ② 带 pn 老框流水透出且过滤先于 limit（limit=1 也命中）', (r1.json.items || []).length === 1 && r1.json.items[0].code === 'T212OLDCODE', JSON.stringify((r1.json.items || [])[0] || {}).slice(0, 90));
    const r2 = await getj('/api/scanlog?pn=' + OLD_PN, tk);
    C('★★ ② pn 只回本件行（端上兜底筛不产生额外丢行）', (r2.json.items || []).length === 1 && r2.json.items.every((x) => String(x.pn || '').toUpperCase() === OLD_PN));
    // ③ 大小写/空格容错（与档案页 key 大写口径双保险）
    const r3 = await getj('/api/scanlog?pn=  ' + OLD_PN.toLowerCase() + ' ', tk);
    C('★★ ③ pn 去空格转大写容错', (r3.json.items || []).length === 1);
    // ④ 填充件 pn 正常（过滤不误伤常规件）
    const r4 = await getj('/api/scanlog?pn=T212FILLPN&limit=50', tk);
    C('★ ④ 常规件 pn 过滤完整（50 条填充全回）', (r4.json.items || []).length === 50);
    // ⑤ c= 与 pn= 可叠加（AND，v211+v212 参数共存回归）
    const r5 = await getj('/api/scanlog?pn=' + OLD_PN + '&c=T212OLDCODE', tk);
    const r5x = await getj('/api/scanlog?pn=T212FILLPN&c=T212OLDCODE', tk);
    C('★★ ⑤ pn+c 叠加为 AND（同框命中1/跨框返空）', (r5.json.items || []).length === 1 && (r5x.json.items || []).length === 0);
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
