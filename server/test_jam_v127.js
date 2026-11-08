// ㉖v127 地图交管红圈语义修正 · 实例证明
// 现场（用户截图）：巷道里一串红圈遮挡货架格号与车辆标签，误以为是"地面叉车"
// 真相：jam 旧写法 = landmarkOwners 全部锁格无差别画圈。landmarkOwners 是 RCS「车辆预锁的路径格」，
//       实测 46 格 / 4 台车，而 blockedCars 为空、blockingRelations=0（此刻一台都没真卡）→ 满屏红圈零告警价值还挡图
// 修复：jamLands(owners, blocked, lands) 只保留「被拦停车辆」持有的锁格；无车被卡＝空数组＝地图干净
// 证明面：
//  J 沙箱纯函数：全锁无卡→空 / 部分车被卡→只出该车格 / 车被卡但格不在路网→滤 / 空输入容错 / 车号字符串型兼容
//  E 端到端：db.rcsTraffic 塞 46 格 landmarkOwners + 无 RCS 连接（blockedCars 空）→ /api/rcs/map 的 jam 为空数组（现场红圈归零复现）
//  S 源码锚点：jam 行调用 jamLands、旧全量写法消失、三端前端消费字段结构不变
const fs = require('fs'); const vm = require('vm'); const path = require('path'); const cp = require('child_process'); const crypto = require('crypto');
const SRV = path.join(__dirname, 'server.js');
const lines = fs.readFileSync(SRV, 'utf8').split(/\r?\n/);
let fail = 0, total = 0;
const T = (n, a, b) => { total++; const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) { fail++; console.log('FAIL ' + n + '\n  实际=' + JSON.stringify(a) + '\n  期望=' + JSON.stringify(b)); } else console.log('PASS ' + n); };
function grab(startSig, endSig) {
  let s = -1; for (let i = 0; i < lines.length; i++) if (lines[i].trim().startsWith(startSig)) { s = i; break; }
  if (s < 0) throw new Error('未找到起始: ' + startSig);
  let e = -1; for (let i = s + 1; i < lines.length; i++) if (lines[i].trim().startsWith(endSig)) { e = i; break; }
  if (e < 0) throw new Error('未找到结束: ' + endSig);
  return lines.slice(s, e).join('\n');
}
// ===== J 沙箱纯函数 =====
{
  const ctx = { console, Object, Number, Array, String };
  vm.createContext(ctx);
  vm.runInContext(grab('function jamLands', 'function pickSuggest') + '\nglobalThis.__j=jamLands;', ctx);
  const jamLands = ctx.__j;
  const lands = { 800: { x: 1, y: 1 }, 808: { x: 2, y: 2 }, 809: { x: 3, y: 3 }, 1081: { x: 4, y: 4 }, 1082: { x: 5, y: 5 } };
  // 现场复刻：46 格里取 5 格代表，分属 4 台车，全部无车被卡
  const owners = { 800: 6, 808: 6, 809: 6, 1081: 5, 1082: 5 };
  T('J1 现场场景：有锁格但无车被卡 → 红圈为空（旧版会画 5 个）', jamLands(owners, new Set(), lands), []);
  T('J2 车5被拦停 → 只出车5的 2 格', jamLands(owners, new Set([5]), lands).map((j) => Number(j.land)), [1081, 1082]);
  T('J3 车5、车6都被卡 → 出 5 格（全部）', jamLands(owners, new Set([5, 6]), lands).length, 5);
  T('J4 锁格不在路网 → 滤除（不画无坐标圈）', jamLands({ 999: 6 }, new Set([6]), lands), []);
  T('J5 返回结构含 land+car（前端 hitTest/坐标换算兼容）', jamLands(owners, new Set([5]), lands)[0], { land: '1081', car: 5 });
  T('J6 车号字符串型兼容（RCS 偶发回字符串）', jamLands({ 800: '6' }, new Set([6]), lands).length, 1);
  T('J7 空/缺输入容错不抛', [jamLands({}, new Set(), lands), jamLands(null, null, null), jamLands(owners, null, lands)], [[], [], []]);
}
// ===== S 源码锚点 =====
{
  const joined = lines.join('\n');
  T('S1 地图接口改调 jamLands', joined.includes('jam: jamLands(owners, mapBlocked, NetMap.lands)'), true);
  T('S2 旧全量画圈写法已消失', !joined.includes('jam: Object.entries(owners).map'), true);
  T('S3 共享函数定义在位', joined.includes('function jamLands(owners, blocked, lands)'), true);
  // 三端前端消费 MAP.jam 结构不变（[{land,car}]）→ 无需改 APK/网页渲染
  const agv = fs.readFileSync(path.join(__dirname, 'public', 'agvmap.html'), 'utf8');
  const con = fs.readFileSync(path.join(__dirname, 'public', 'console.html'), 'utf8');
  T('S4 移动端地图仍按 jam[].land 渲染（结构未变）', agv.includes('for(const j of(MAP.jam||[])){const l=L[j.land]'), true);
  T('S5 网页指挥舱地图同结构消费', con.includes('for(const j of(MAP.jam||[])){const l=L[j.land]'), true);
}
// ===== E 端到端：现场红圈归零复现 =====
{
  const SRC = path.join(__dirname, 'data'); const TDIR = path.join(__dirname, 'data_e2e_jam_v127'); const PORT = 8367; const BASE = 'http://127.0.0.1:' + PORT;
  fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
  fs.copyFileSync(path.join(SRC, 'db.json'), path.join(TDIR, 'db.json'));
  fs.copyFileSync(path.join(SRC, 'secret.key'), path.join(TDIR, 'secret.key'));
  const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
  const salt = crypto.randomBytes(16).toString('hex'); const hp = (pw) => crypto.scryptSync(pw, salt, 32).toString('hex');
  db0.users.push({ id: 'u_j', username: 'j_wh', name: 'JAM仓管', role: 'warehouse', enabled: true, createdAt: Date.now(), mustChangePw: false, salt, passHash: hp('E2e#Jam!127') });
  // 无 RCS 配置 → cars 空、mapBlocked 空（等价现场"一台都没卡"）
  delete db0.rcsConfig; delete db0.wmasConfig; delete db0.rcsToken;
  // 塞入现场同款 landmarkOwners：46 格 / 4 台车（键唯一）
  const owners = {}; let k = 800;
  for (const car of [5, 6, 7, 8]) { const n = car === 5 ? 12 : 11 + (car % 2); for (let i = 0; i < n; i++) owners[String(k++)] = car; }
  const OWNERS_N = Object.keys(owners).length; // 46
  db0.rcsTraffic = JSON.stringify({ landmarkLocks: { landmarkOwners: owners, totalLocked: OWNERS_N }, zoneLocks: { zoneList: [{ zoneId: 12, blockedCars: [], lockCars: [] }] }, blockingRelations: { blockingMap: {}, totalBlockingRelations: 0 } });
  fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  (async () => {
    const srv = cp.spawn(process.execPath, [SRV], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
    let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health')).ok; } catch (_) {} }
    if (!up) { console.log('FAIL! 服务未就绪'); srv.kill(); process.exit(1); }
    try {
      const lg = await (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'j_wh', password: 'E2e#Jam!127' }) })).json();
      const j = await (await fetch(BASE + '/api/rcs/map', { headers: { Authorization: 'Bearer ' + lg.token } })).json();
      const ownersN = Object.keys(JSON.parse(db0.rcsTraffic).landmarkLocks.landmarkOwners).length;
      T('E1 端到端：46 格预锁 + 无车被卡 → jam 空数组（红圈归零）', [ownersN, Array.isArray(j.jam), j.jam.length], [46, true, 0]);
      T('E2 接口不报错且其余字段齐备（cars/shelf/stations 结构不变）', [j.ok === true, Array.isArray(j.cars), Array.isArray(j.shelf), Array.isArray(j.stations)], [true, true, true, true]);
    } catch (e) { console.log(e.stack); T('E 异常 ' + e.message, false, true); }
    srv.kill('SIGKILL'); fs.rmSync(TDIR, { recursive: true, force: true });
    console.log('\n===== v127 地图红圈语义修正 实例证明 ' + (total - fail) + '/' + total + ' 通过 =====');
    process.exit(fail ? 1 : 0);
  })();
}
