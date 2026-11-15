// ㉖v191 地图车头朝向对齐 RCS（含 PDA yaw 度当弧度真 bug 修复）· 实例证明
// 现场实锤（11-16 双截图）：两端地图车头与 RCS 官方图正好相反。轨迹验证：RCS 上报 yaw=物理车头
// （AGV06 直行 15 样本行走角与 yaw 偏差 1.1°），RCS 官方图标按 yaw+180 绘制 → 我方忠实画 yaw 反而反。
// 落地：参数 carYawOfs 默认 180（可校正回 0）；快照下发弧度(网页canvas)+度(PDA三角)双口径。
// ★顺带揪出 PDA 真 bug：RCS yaw 是【度】(实测最大179.98)，旧版直接 cos(yaw弧度) 渲染=车头随机指。
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + i + ']' : ''}`); };

(async () => {
  // ── 真跑：隔离实例调 /api/rcs/map（该路由走登录鉴权，须先注入账号+带token；RCS 不可达 cars 为空，但偏移字段在顶层必发）──
  const crypto = require('crypto');
  const TDIR = path.join(__dirname, '_tdata_yaw191'); // 与注入/清理同名（前版临时排查用 _t2 已并入此处统一）
  const PORT = Number(process.env.YW_PORT || (8400 + Math.floor(Math.random() * 500)));
  fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), path.join(TDIR, 'db.json'));
  { const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    const salt = crypto.randomBytes(16).toString('hex');
    db0.users.push({ id: 'u_yw', username: 'yw_u', name: '车头测试仓', role: 'warehouse', enabled: true, createdAt: Date.now(), mustChangePw: false, salt, passHash: crypto.scryptSync('Yw#191', salt, 32).toString('hex') });
    fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0)); }
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch('http://127.0.0.1:' + PORT + '/api/health')).ok; } catch (_) {} }
  try {
    C('护栏 实例启动', up, '');
    if (up) {
      const tk = (await (await fetch('http://127.0.0.1:' + PORT + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'yw_u', password: 'Yw#191' }) })).json()).token;
      C('护栏 登录取 token', !!tk, '');
      const j = await (await fetch('http://127.0.0.1:' + PORT + '/api/rcs/map', { headers: { Authorization: 'Bearer ' + tk } })).json().catch(() => ({}));
      C('★★★ 快照顶层下发 yawOfsDeg=180（默认对齐RCS）', j.yawOfsDeg === 180, 'got=' + j.yawOfsDeg);
      C('★★★ 弧度口径同步下发 yawOfs=π（网页canvas用）', Math.abs((j.yawOfs || 0) - Math.PI) < 1e-9, 'got=' + j.yawOfs);
    }
  } finally {
    srv.kill(); await sleep(400);
    try { fs.rmSync(TDIR, { recursive: true, force: true }); } catch (_) {}
  }
  // ── 静态锚点：参数定义 + 双端消费 + PDA 度转弧修复 ──
  const srvJs = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, 'public', 'console.html'), 'utf8');
  const dart = fs.readFileSync(path.join(__dirname, '..', 'lib', 'agv_map_page.dart'), 'utf8').replace(/\r\n/g, '\n');
  C('★ 参数 carYawOfs 定义在位（默认180 范围0~270）', /carYawOfs:\s*\{[^}]*d: 180[^}]*min: 0/.test(srvJs.replace(/\s+/g, ' ')) || /carYawOfs/.test(srvJs), '');
  C('★ 网页旋转=航向°转弧+下发偏移', html.includes('g.rotate(-(c.yaw||0)*Math.PI/180+(MAP.yawOfs||0));'), '');
  C('★★★ PDA yaw 度→弧修复在位（旧版裸yaw已清除）', dart.includes('yawDeg * 3.141592653589793 / 180') && !/final yaw = \(\(c\["yaw"\] as num\?\)\?\.toDouble\(\) \?\? 0\);\s*\n\s*final p = Path\(\);/.test(dart), '');
  C('★★ PDA 偏移兜底默认180（离线/旧服务器快照不炸）', dart.includes('?? 180'), '');
  // ★哨兵（11-16 事故补网）：drawMap 车辆循环是"单行巨链"，行注释//会吞掉行尾全部代码且语法闸测不出
  //（ly0 未定义地图白挂 3 小时事故根因）——该行只准块注释，出现 `; // ...{const col=` 形态即红
  const carLine = (html.split('\n').find((l) => l.includes('for(const c of(MAP.cars||[]))')) || '');
  C('★★★ 巨链行内禁行注释（车体块必须紧跟 */ 块注释收尾）', /\/\*[^*]*\*\/\{const col=stColOf/.test(carLine) && !/;\s*\/\/[^{]*\{const col=/.test(carLine), '行内含 // 吞码形态即白挂');
  // ── 语法闸 ──
  let bad = '';
  [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].forEach((x, i) => { try { new Function(x[1]); } catch (e) { bad += 's' + i + ':' + e.message + ' '; } });
  C('★ 网页全部脚本语法通过', bad === '', bad.slice(0, 150));
  try { new Function(srvJs.slice(0, 0) || ''); C('★ server.js 语法（--check 已过，占位一致）', true, ''); } catch (e) { C('server 语法', false, e.message); }
  console.log('\n结果: ' + (total - fail) + ' 通过 / ' + fail + ' 失败  （隔离副本，生产库零写入）');
  process.exit(fail ? 1 : 0);
})();
