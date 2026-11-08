// ㉖v123c PDA横屏AGV实时地图（/agvmap 独立页）· 实例证明
// 链路：APP webSession 换发 token → WebView 打开 /agvmap?t= → 页面 fetch /api/rcs/{net,map} + EventSource /api/sse?token=
// 证明面：
//  G1 /agvmap 返回 HTML（免登录可取壳，数据接口仍要 token——与 console 同口径）
//  G2 页面脚本含凭证接管/三数据源/横屏 meta/缩放手势锚点
//  G3 rcs/net、rcs/map 带 token 正常应答、无 token 401
//  G4 SSE 带 webSession token（fp=''）可建连（hello 帧）
//  E1 APP 入口锚点：按钮切 AgvWebMapPage、横屏成对锁、凭证走 webSession
const fs = require('fs'); const path = require('path'); const cp = require('child_process'); const crypto = require('crypto');
const SRC = path.join(__dirname, 'data'); const TDIR = path.join(__dirname, 'data_e2e_agvmap_v123c'); const PORT = 8362; const BASE = 'http://127.0.0.1:' + PORT;
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(SRC, 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(SRC, 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(16).toString('hex'); const hashPw = (pw, s) => crypto.scryptSync(String(pw), s, 32).toString('hex');
db0.users.push({ id: 'u_am', username: 'am_wh', name: 'AM仓管', role: 'warehouse', enabled: true, createdAt: Date.now(), mustChangePw: false, salt, passHash: hashPw('E2e#Am!123c', salt) });
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const chk = (n, g, w) => { total++; const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL!'} [${n}] got=${String(JSON.stringify(g)).slice(0, 120)} want=${String(JSON.stringify(w)).slice(0, 120)}`); };
const chkT = (n, c) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]`); };
(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { const r = await fetch(BASE + '/api/health'); up = r.ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪'); srv.kill(); process.exit(1); }
  console.log('隔离实例已就绪 (PORT ' + PORT + ') —— v123c PDA横屏AGV地图证明');
  try {
    // ===== G1 页面壳公开可取 =====
    const r1 = await fetch(BASE + '/agvmap');
    const html = await r1.text();
    chkT('G1a /agvmap 200 且为 HTML', r1.status === 200 && /text\/html/.test(r1.headers.get('content-type') || ''));
    chkT('G1b 页面含标题', html.includes('AGV 实时地图'));
    // ===== G2 关键锚点 =====
    chkT('G2a 凭证接管（?t= 或 localStorage）', html.includes("[?&]t=([^&]+)") && html.includes('ck_tok'));
    chkT('G2b 三数据源齐备', html.includes('/api/rcs/net') && html.includes('/api/rcs/map') && html.includes("/api/sse?token="));
    chkT('G2c 横屏 viewport 禁浏览器缩放', html.includes('user-scalable=no') && html.includes('viewport-fit=cover'));
    chkT('G2d 捏合缩放与平移手势', html.includes('pointerdown') && html.includes('pinch') && html.includes('wheel'));
    chkT('G2e 缩放限幅0.5~16', html.includes('Math.max(.5,Math.min(16,') || html.includes('Math.max(.5,Math.min(16,'));
    chkT('G2f 点选明细（车辆/货架/站台）', html.includes('hitTest') && html.includes('applySel'));
    chkT('G2g SSE断线兜底轮询10秒', html.includes('10000'));
    chkT('G2h 后台隐藏暂停刷新省流量', html.includes('document.hidden'));
    // ===== G3 数据接口鉴权 =====
    const lg = await (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'am_wh', password: 'E2e#Am!123c' }) })).json();
    const noTk = await fetch(BASE + '/api/rcs/map');
    chkT('G3a 无 token 数据接口 401', noTk.status === 401);
    const withTk = await fetch(BASE + '/api/rcs/map', { headers: { Authorization: 'Bearer ' + lg.token } });
    const mj = await withTk.json();
    chkT('G3b 带 token rcs/map 应答结构正常', withTk.status === 200 && mj.ok === true && Array.isArray(mj.cars));
    const nj = await (await fetch(BASE + '/api/rcs/net', { headers: { Authorization: 'Bearer ' + lg.token } })).json();
    chkT('G3c 带 token rcs/net 应答正常', nj.ok === true && nj.lands !== undefined);
    // ===== G4 webSession token 打通 SSE（WebView 真实链路） =====
    const ws = await (await fetch(BASE + '/api/web/session', { method: 'POST', headers: { Authorization: 'Bearer ' + lg.token } })).json();
    chkT('G4a webSession 换发成功', ws.ok === true && !!ws.token);
    const ac = new AbortController();
    const sseRes = await fetch(BASE + '/api/sse?token=' + encodeURIComponent(ws.token), { headers: { Accept: 'text/event-stream' }, signal: ac.signal }).catch((e) => null);
    let gotHello = false;
    if (sseRes && sseRes.ok) {
      const rd = sseRes.body.getReader(); const t0 = Date.now();
      let buf = '';
      while (Date.now() - t0 < 5000) { const { value, done } = await rd.read().catch(() => ({ value: null, done: true })); if (done) break; buf += new TextDecoder().decode(value); if (buf.includes('"t":"hello"')) { gotHello = true; break } }
      ac.abort();
    }
    chkT('G4b webSession token 可建 SSE（hello 帧）', gotHello);
    // ===== E1 APP 侧锚点 =====
    const dart = fs.readFileSync(path.join(__dirname, '..', 'lib', 'agv_api.dart'), 'utf8');
    chkT('E1a 入口按钮切新页', dart.includes('AgvWebMapPage()') && dart.includes('AGV 实时地图（网页版·横屏·捏合缩放）'));
    chkT('E1b 横屏成对锁（进页锁/退页恢复）', dart.includes('DeviceOrientation.landscapeLeft') && (dart.match(/setPreferredOrientations/g) || []).length >= 2 && dart.includes('DeviceOrientation.portraitUp'));
    chkT('E1c 凭证走 webSession+?t=', dart.includes('AuthApi.webSession()') && dart.includes('/agvmap?t='));
    chkT('E1d 旧自绘页不再被引用', !dart.includes('const AgvMapPage()'));
  } catch (e) { console.log(e.stack); chkT('X 异常 ' + e.message, false); }
  srv.kill('SIGKILL');
  fs.rmSync(TDIR, { recursive: true, force: true });
  console.log(`\n===== v123c PDA横屏AGV地图实例证明 ${total - fail}/${total} PASS =====`);
  process.exit(fail ? 1 : 0);
})();
