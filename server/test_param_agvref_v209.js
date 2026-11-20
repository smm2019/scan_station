// ㉖v209 运营参数「PDA领料AGV刷新」闭环冒烟：参数页可见 → 管理员改值 → 心跳下发新值
// 用户问题："AGV状态刷新不及时……能设置成运营参数吗"——本测试证明参数循环成立：
//   ①参数随 PARAMS 元数据自动出现在网页控制台参数页（无需前端改动）；
//   ②管理员保存后，PDA 心跳（GET /api/me）拿到的就是新值——不需要重启服务；
//   ③旧版 PDA 无字段=保留旧值（服务器多带一个字段对其零影响，由 Flutter 端守卫保证）。
// 真跑理由：参数下发走的是"响应体捎带"而非独立接口，静态看代码永远"像是对的"，
// 只有真起实例真发心跳才能证明字段真的在 /api/admin/params 清单与 /api/me 响应里。
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const TDIR = path.join(__dirname, '_prm_v209'), PORT = Number(process.env.HS_PORT || 9933);
const BASE = 'http://127.0.0.1:' + PORT;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + String(i).slice(0, 120) + ']' : ''}`); };
const post = async (p2, tk, body) => { const r = await fetch(BASE + p2, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: JSON.stringify(body || {}) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
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
    const salt = crypto.randomBytes(16).toString('hex'), PW = 'E2e#Hs!209';
    db0.users.push({ id: 'u_hs_prm_adm', username: '参数管理员', name: '参数管理员', role: 'admin', enabled: true, createdAt: Date.now(), mustChangePw: false, salt, passHash: crypto.scryptSync(PW, salt, 32).toString('hex') });
    db0.wmasConfig = null; db0.rcsConfig = null;
    fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
    srv = cp.spawn(process.execPath, ['server.js'], { cwd: __dirname, env: Object.assign({}, process.env, { SELFTEST_NO_LIVE: '1', PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }), stdio: ['ignore', 'pipe', 'pipe'] });
    process.on('exit', killTree);
    let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(600) })).ok; } catch (_) {} }
    C('护栏 实例就绪', up); if (!up) throw new Error('实例未起');
    const tk = (await post('/api/login', null, { username: '参数管理员', password: PW, dev: 'PA', kind: 'pda' })).json.token;
    C('护栏 管理员登录', !!tk); if (!tk) throw new Error('登录失败');
    // ① 参数页清单（网页控制台按 items 元数据自动渲染）：新参数在、归组对、默认 8
    const pv = await getj('/api/admin/params', tk);
    const it = (pv.json.items || []).find(x => x.k === 'pdaAgvRefSec');
    C('★★★ ① 参数自动出现在控制台参数页（组=界面刷新，默认8，范围3~300）',
      !!it && it.grp === '界面刷新' && it.def === 8 && it.min === 3 && it.max === 300, JSON.stringify(it || {}).slice(0, 110));
    // ② 心跳（PDA 的 GET /api/me）默认下发 8
    const me0 = await getj('/api/me', tk);
    C('★★★ ② 心跳下发默认值 8（新版 PDA 打开领料单即 8 秒节奏）', me0.json.pdaAgvRefSec === 8, 'me=' + me0.json.pdaAgvRefSec);
    // ③ 管理员保存新值 → 即时生效（同进程内 P() 现读，无需重启）→ 心跳即带新值
    const sw = await post('/api/admin/params', tk, { values: { pdaAgvRefSec: 5 } });
    C('护栏 保存 pdaAgvRefSec=5', sw.json.ok === true, JSON.stringify(sw.json).slice(0, 80));
    const me1 = await getj('/api/me', tk);
    C('★★★ ③ 改值不重启即时生效：心跳下发 5（PDA 下一轮定时自动采用）', me1.json.pdaAgvRefSec === 5, 'me=' + me1.json.pdaAgvRefSec);
    // ④ 越界值被参数框架拒绝（防手滑 0 秒/超大值打爆 RCS）
    const bad = await post('/api/admin/params', tk, { values: { pdaAgvRefSec: 1 } });
    C('★★ ④ 越界值(1秒)被拒绝', bad.json.ok !== true, JSON.stringify(bad.json).slice(0, 90));
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
