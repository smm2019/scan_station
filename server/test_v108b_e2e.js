// ㉖v108b 补账 + 未提交代码全量实例验证（E1-E5 真实服务器链路）
// 隔离 DATA_DIR=生产库副本；假 RCS 本地服务（ok/busy/hang 三模式）；真实端点打真实请求。
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const SRV = path.join(__dirname, 'server.js');
const TMP = path.join(__dirname, 'test_v108b_e2e_data');
const PORT = 18101;
const TOKEN = 'TESTTOK_v108b';
let fail = 0, total = 0;
function T(n, a, b) { total++; const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) { fail++; console.log('FAIL ' + n + '\n  实际=' + JSON.stringify(a) + '\n  期望=' + JSON.stringify(b)); } else console.log('PASS ' + n); }
const req = (method, p, tok, body, timeoutMs = 30000) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : null;
  const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, timeout: timeoutMs, headers: Object.assign({}, tok ? { Authorization: 'Bearer ' + tok } : {}, data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) },
    (res) => { let s = ''; res.on('data', (c) => s += c); res.on('end', () => { try { resolve({ code: res.statusCode, j: JSON.parse(s) }); } catch (e) { reject(new Error(p + ' 解析失败: ' + s.slice(0, 160))); } }); });
  r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error(p + ' 超时')); });
  if (data) r.write(data); r.end();
});

// ---- 假 RCS：/login 秒回；数据路径按 MODE 应答（ok=空清单 / busy=每CK台一条在途出库任务 / hang=永不回包） ----
let MODE = 'ok';
const fakeRcs = http.createServer((rq, rs) => {
  const u = String(rq.url || '');
  if (u === '/login') { rs.writeHead(200, { 'Content-Type': 'application/json' }); return rs.end(JSON.stringify({ code: 0, data: { token: 'FAKE-TK', expireTime: Date.now() + 3600000 } })); }
  if (MODE === 'hang') return; // 永不回包 → 客户端 8 秒超时
  let data = '[]';
  if (u === '/task/getTaskInfo' && MODE === 'busy') {
    data = JSON.stringify(Array.from({ length: 12 }, (_, i) => ({
      dispatchNo: 'FAKE-' + (i + 1), taskState: 1, suspensionMsg: JSON.stringify({ startPoint: 'NB02-A-01-1F', endPoint: 'NB02-CK-' + String(i + 1).padStart(2, '0') }),
      taskDetailList: [{ operType: 0, state: 0, landCode: '' }, { operType: 1, state: 0, landCode: '' }],
    })));
  }
  rs.writeHead(200, { 'Content-Type': 'application/json' });
  rs.end(JSON.stringify({ code: 0, data }));
});

(async () => {
  await new Promise((r) => fakeRcs.listen(0, '127.0.0.1', r));
  const RCS_HOST = '127.0.0.1:' + fakeRcs.address().port;

  // ---- 隔离数据目录：生产库副本 + 注入会话 + 假RCS + 干跑模式 ----
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP, 'logs'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), path.join(TMP, 'db.json'));
  if (fs.existsSync(path.join(__dirname, 'data', 'secret.key'))) fs.copyFileSync(path.join(__dirname, 'data', 'secret.key'), path.join(TMP, 'secret.key'));
  const db = JSON.parse(fs.readFileSync(path.join(TMP, 'db.json'), 'utf8'));
  const admin = (db.users || []).find((x) => x.role === 'admin' && x.enabled !== false);
  if (!admin) { console.log('FATAL：生产库无启用 admin'); process.exit(2); }
  db.sessions = db.sessions || {};
  db.sessions[TOKEN] = { userId: admin.id, dev: 'TEST-E2E', lastSeen: Date.now() };
  if (db.rcsConfig) db.rcsConfig.host = RCS_HOST;
  if (db.wmasConfig) db.wmasConfig.host = '192.0.2.1:8081'; // WMAS 不可达：dry 模式不下发，仅影响 carry（本测试不测 carry 成功路径）
  db.agvDispatchMode = 'dry'; // 演算模式：dispatchOne 真实选台+trace，但不建 WMAS 任务
  // 自带合成僵尸单夹具（不依赖生产现状——N26J310080/85 已被 v108 消位闭环自愈成 returned）：
  // TESTZM01/02：atStation 且账本无此码 → 消位闭环应转 returned；TESTZM03CODE：atStation 且账本有码 → 不误伤保持
  db.inspects = db.inspects || []; db.ledger = db.ledger || [];
  const _zn = Date.now();
  db.ledger.push({ c: 'TESTZM03CODE', l: 'NB02-A-99-1F', p: '8899990099', n: '不误伤样本', q: 10, t: _zn, rec: _zn, by: admin.name });
  db.inspects.push({ id: 'insp_zm01', code: 'TESTZM01', state: 'atStation', station: 'NB02-CK-10', from: 'NB02-A-90-1F', uid: admin.id, by: admin.name, part: '8899990097', nm: '僵尸单1', at: _zn, arriveAt: _zn });
  db.inspects.push({ id: 'insp_zm02', code: 'TESTZM02', state: 'atStation', station: 'NB02-CK-11', from: 'NB02-A-91-1F', uid: admin.id, by: admin.name, part: '8899990098', nm: '僵尸单2', at: _zn, arriveAt: _zn });
  db.inspects.push({ id: 'insp_zm03', code: 'TESTZM03CODE', state: 'atStation', station: 'NB02-CK-12', from: 'NB02-A-99-1F', uid: admin.id, by: admin.name, part: '8899990099', nm: '不误伤', at: _zn, arriveAt: _zn });
  console.log('[准备] 合成僵尸检验单 TESTZM01/02(账本无码)+TESTZM03CODE(账本有码不误伤) admin=' + admin.name);
  db.agvQueue = []; // 清空历史队列防干扰（副本内操作，生产不动）
  fs.writeFileSync(path.join(TMP, 'db.json'), JSON.stringify(db));

  // ---- 起服务器 ----
  const child = spawn(process.execPath, [SRV], { env: Object.assign({}, process.env, { DATA_DIR: TMP, PORT: String(PORT) }), stdio: ['ignore', 'pipe', 'pipe'] });
  let srvLog = '';
  child.stdout.on('data', (d) => { srvLog += d; }); child.stderr.on('data', (d) => { srvLog += d; });
  const cleanup = () => { try { child.kill('SIGKILL'); fakeRcs.close(); } catch (_) {} };
  process.on('exit', cleanup);
  let up = false;
  for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 1000)); try { const h = await req('GET', '/api/health', null, null, 5000); if (h.j && h.j.ok) { up = true; break; } } catch (_) {} }
  T('H0 隔离服务器就绪', up, true);
  if (!up) { console.log(srvLog.slice(0, 2000)); process.exit(1); }

  // 读取服务器落盘的副本 db（save 防抖120ms+原子写；断言前留足落盘时间）
  const readDb = () => JSON.parse(fs.readFileSync(path.join(TMP, 'db.json'), 'utf8'));
  // ================= E1/E2 消位闭环（合成僵尸单夹具） =================
  // 基线=注入前副本状态（inspLoop 为启动即执行 IIFE，服务器就绪时闭环已发生，不能再断言"服务后仍 atStation"）
  const z0 = (db.inspects || []).filter((q) => ['TESTZM01', 'TESTZM02'].includes(String(q.code).toUpperCase()) && q.state === 'atStation');
  T('E1a 副本含僵尸单夹具（注入前 atStation）', z0.length, 2);
  console.log('[E1] 等检验状态机推进（15秒循环，等 25 秒）…');
  await new Promise((r) => setTimeout(r, 25000));
  const d1 = readDb();
  const z1 = (d1.inspects || []).filter((q) => ['TESTZM01', 'TESTZM02'].includes(String(q.code).toUpperCase()));
  T('E1b 消位后自动闭环 returned', z1.map((q) => q.state).sort(), ['returned', 'returned']);
  T('E1c 闭环带 doneAt', z1.length === 2 && z1.every((q) => q.doneAt > 0), true);
  // 占用解除：这两单不再处于"占用检验台"的活跃态集合（inspStationFree 判据口径）
  const busy = ['waitOut', 'toStation', 'atStation', 'waitBack', 'returning', 'waitReturn'];
  const stillHold = z1.filter((q) => busy.includes(q.state)).map((q) => q.station);
  T('E1d CK-10/11 检验占用解除', stillHold.length, 0);
  // E2 不误伤：账本命中的 atStation 单保持原态（TESTZM03CODE 账本有码）
  const zm3 = (d1.inspects || []).find((q) => String(q.code).toUpperCase() === 'TESTZM03CODE');
  T('E2 账本命中的 atStation 不误伤', zm3 && zm3.state, 'atStation');

  // ================= E3 trace 判重（dry 模式真实调度链路） =================
  MODE = 'busy'; // 假 RCS：12 台全部在途占用 → 任何叫车必然"暂无可用台"
  const q1 = await req('POST', '/api/agv/queue', TOKEN, { items: [{ code: 'TESTE3CODE', fromLoc: 'NB02-G-01-1F', partNo: 'TESTE3' }], reqId: '', reqNo: 'E2E-E3' }); // G巷道：假任务全在A-F，避开aisleCap节流直达选台失败路径
  T('E3a 入队成功（dry）', q1.j.ok && q1.j.added >= 1, true);
  console.log('[E3] 等 4 轮调度（pollSec=20，等 90 秒）…');
  await new Promise((r) => setTimeout(r, 90000));
  const dq = readDb();
  const tq = (dq.agvQueue || []).find((x) => x.code === 'TESTE3CODE');
  const tr = (tq && tq.trace) || [];
  T('E3b trace 存在且条数≤5', tr.length > 0 && tr.length <= 5, true);
  const last = tr[tr.length - 1] || '';
  T('E3c 末条带 ×N 计数（判重生效）', /×[2-9]|×[1-9]\d/.test(last), true);
  T('E3d 末条为暂无可用台文案', /暂无可用台/.test(last), true);
  T('E3e 同文案不重复占位（trace 中该文案仅 1 条）', tr.filter((s) => /暂无可用台/.test(s)).length, 1);

  // ================= E4 RCS 韧性（真实 /api/rcs/cars 端点） =================
  MODE = 'ok';
  await new Promise((r) => setTimeout(r, 2200)); // 让 busy 期缓存/熔断过期窗口不影响基线
  const t0 = Date.now(); const c1 = await req('GET', '/api/rcs/cars', TOKEN, null, 20000); const dt1 = Date.now() - t0;
  T('E4a 正常期可达', c1.code && c1.j.ok !== undefined, true);
  T('E4b 首打毫秒级（假RCS秒回+并行）', dt1 < 3000, true);
  const t1 = Date.now(); await req('GET', '/api/rcs/cars', TOKEN, null, 20000); const d2 = Date.now() - t1;
  T('E4c 二次命中 8 秒缓存', d2 < Math.max(300, dt1 / 3), true);
  MODE = 'hang';
  await new Promise((r) => setTimeout(r, 8500)); // 越过缓存 TTL，故障首打真实烧超时
  const t2 = Date.now(); const c3 = await req('GET', '/api/rcs/cars', TOKEN, null, 25000); const d3 = Date.now() - t2;
  T('E4d 故障首打 ≤10s（并行等超时，非串行24s）', d3 < 10500, true);
  const t3 = Date.now(); const c4 = await req('GET', '/api/rcs/cars', TOKEN, null, 25000); const d4 = Date.now() - t3;
  const fast = d4 < 1000;
  const staleOk = c4.j && c4.j.stale === true && d4 < 3000;
  T('E4e 故障期熔断快失败或陈旧兜底', fast || staleOk, true);
  MODE = 'ok';
  console.log('[E4] 轮询等熔断恢复回正（探测5秒窗+缓存TTL可能吞一次探测，最多 40 秒）…');
  let c5 = null;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try { c5 = await req('GET', '/api/rcs/cars', TOKEN, null, 25000); } catch (_) { continue; }
    if (c5.j && c5.j.ok === true && c5.j.stale !== true) break;
  }
  T('E4f RCS 恢复后自动回正', c5 && c5.j && c5.j.ok === true && c5.j.stale !== true, true);

  // ================= E5 领料时段闸门（真实 POST /api/requisitions） =================
  await req('POST', '/api/admin/params', TOKEN, { values: { reqHoursOn: 1, reqHours: '00:00-00:01' } }); // 几乎不可能命中的窗口
  const nowH = new Date();
  if (nowH.getHours() === 0 && nowH.getMinutes() < 1) console.log('[E5] 当前恰在窗口内，换窗口');
  const win = (nowH.getHours() === 0 && nowH.getMinutes() < 1) ? '00:02-00:03' : '00:00-00:01';
  await req('POST', '/api/admin/params', TOKEN, { values: { reqHoursOn: 1, reqHours: win } });
  const g = await req('GET', '/api/requisitions/gate', TOKEN);
  T('E5a gate 捎带时段判定', g.j.hours && g.j.hours.allow === false, true);
  const r1 = await req('POST', '/api/requisitions', TOKEN, { items: [{ partNo: 'TESTE5', itemName: 'E2E维护窗测试', qty: 1 }] });
  T('E5b 时段外下单被拦', r1.j.ok === false && r1.j.code === 'maint_window', true);
  T('E5c 文案含"系统维护中"', /系统维护中/.test(r1.j.msg || ''), true);
  await req('POST', '/api/admin/params', TOKEN, { values: { reqHours: '00:00-00:00' } }); // 全天
  const r2 = await req('POST', '/api/requisitions', TOKEN, { items: [{ partNo: 'TESTE5', itemName: 'E2E全天窗测试', qty: 1 }], assigneeId: '' });
  const rid = r2.j && r2.j.req && r2.j.req.id;
  T('E5d 全天窗正常建单', r2.j.ok === true && !!rid, true);
  await req('POST', '/api/admin/params', TOKEN, { values: { reqHoursOn: 0 } }); // 恢复默认关
  if (rid) { try { await req('POST', '/api/requisitions/' + rid + '/cancel', TOKEN, {}); } catch (_) {} } // 测试单回收（副本内，失败不影响断言）

  // ================= E6 生命体征端点在真实进程可用 =================
  const hs = await req('GET', '/api/admin/healthscore', TOKEN);
  const names = (hs.j.items || []).map((x) => x.name);
  T('E6a 新检测项在面板', ['RCS 通道', 'WMAS 通道', '循环心跳', '磁盘空间'].every((n) => names.includes(n)), true);
  const dg = await req('GET', '/api/admin/diagnose', TOKEN);
  T('E6b 诊断病历生成', dg.j && dg.j.ok === true && String(dg.j.text || '').includes('循环心跳'), true);

  console.log('\n===== E2E ' + (total - fail) + '/' + total + ' 通过 =====');
  if (fail) { console.log('--- 服务器日志尾部 ---'); console.log(srvLog.slice(-1500)); }
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FATAL ' + e.message); try { child.kill('SIGKILL'); } catch (_) {} process.exit(2); });
