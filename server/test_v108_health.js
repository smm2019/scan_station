// ㉖v108 生命体征健康检测 · 集成测试
// 起真实服务器（隔离 DATA_DIR=生产库副本+注入测试会话），验证：
// /api/health-ping 心跳字段 → /api/admin/healthscore 新检测项与fix指引 → /api/admin/diagnose 病历文本 → watchdog.ps1 判活
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const SRV = path.join(__dirname, 'server.js');
const TMP = path.join(__dirname, 'test_v108_health_data');
const PORT = 18099;
const TOKEN = 'TESTTOK_v108_health';
let fail = 0, total = 0;
function T(n, a, b) { total++; const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) { fail++; console.log('FAIL ' + n + '\n  实际=' + JSON.stringify(a) + '\n  期望=' + JSON.stringify(b)); } else console.log('PASS ' + n); }
const get = (p, tok) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p, headers: tok ? { Authorization: 'Bearer ' + tok } : {}, timeout: 15000 }, (res) => {
    let s = ''; res.on('data', (c) => s += c); res.on('end', () => { try { resolve({ code: res.statusCode, j: JSON.parse(s) }); } catch (e) { reject(new Error(p + ' 解析失败: ' + s.slice(0, 200))); } });
  }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error(p + ' 超时')); });
});

// ---- 1. 隔离数据目录：生产库副本 + 注入会话（admin 身份） ----
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(path.join(TMP, 'logs'), { recursive: true });
fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), path.join(TMP, 'db.json'));
if (fs.existsSync(path.join(__dirname, 'data', 'secret.key'))) fs.copyFileSync(path.join(__dirname, 'data', 'secret.key'), path.join(TMP, 'secret.key'));
const db = JSON.parse(fs.readFileSync(path.join(TMP, 'db.json'), 'utf8'));
const admin = (db.users || []).find((x) => x.role === 'admin' && x.enabled !== false);
if (!admin) { console.log('FATAL：生产库无启用 admin，测试无法进行'); process.exit(2); }
db.sessions = db.sessions || {};
db.sessions[TOKEN] = { userId: admin.id, dev: 'TEST-WATCHDOG', lastSeen: Date.now() };
// 注入不可达地址（TEST-NET 保留段）：RCS/WMAS 必然连不通 → 依赖检测行为确定（不碰生产内网服务）
if (db.rcsConfig) db.rcsConfig.host = '192.0.2.1:8080';
if (db.wmasConfig) db.wmasConfig.host = '192.0.2.1:8081';
fs.writeFileSync(path.join(TMP, 'db.json'), JSON.stringify(db));
console.log('[准备] 隔离目录就绪，admin=' + admin.name + '，会话已注入');

// ---- 2. 起服务器 ----
const child = spawn(process.execPath, [SRV], { env: Object.assign({}, process.env, { DATA_DIR: TMP, PORT: String(PORT) }), stdio: ['ignore', 'pipe', 'pipe'] });
let srvLog = '';
child.stdout.on('data', (d) => { srvLog += d; }); child.stderr.on('data', (d) => { srvLog += d; });
const cleanup = () => { try { child.kill('SIGKILL'); } catch (_) {} };
process.on('exit', cleanup);

(async () => {
  // 等健康端点就绪（最长 40 秒）
  let up = false;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try { const h = await get('/api/health'); if (h.j && h.j.ok) { up = true; break; } } catch (_) {}
  }
  T('H0 服务器在隔离目录启动并就绪', up, true);
  if (!up) { console.log(srvLog.slice(0, 2000)); cleanup(); process.exit(1); }

  // ---- 3. /api/health-ping（无鉴权，看门狗数据源） ----
  const ping = await get('/api/health-ping');
  T('P1 health-ping 免鉴权可达', ping.code, 200);
  T('P2 返回心跳结构（rcs/检验年龄+近1分请求+节拍）', [typeof ping.j.hb.rcsAgeS, typeof ping.j.hb.inspAgeS, typeof ping.j.req1m, typeof ping.j.pollSec], ['number', 'number', 'number', 'number']);
  T('P3 检验循环心跳已建立（15秒循环，5秒内必跳）', ping.j.hb.inspAgeS >= 0 && ping.j.hb.inspAgeS <= 20, true);
  T('P4 请求面已聚合（本测试已发≥1请求）', ping.j.req1m >= 1, true);
  // RCS 心跳：setInterval 首拍在 pollSec（20秒）后才落，先等首拍再断言
  await new Promise((r) => setTimeout(r, 25000));
  const ping2 = await get('/api/health-ping');
  T('P5 RCS轮询循环在跑（登录失败也按拍盖心跳，非-1）', ping2.j.hb.rcsAgeS >= 0 && ping2.j.hb.rcsAgeS < 300, true);

  // ---- 4. 等过启动宽限期（设计：RCS 3分钟/WMAS 4分钟内"从未成功"不判坏，防刚启动误报）----
  console.log('[准备] 等待启动宽限期结束（约 4.3 分钟，验证真·红灯路径）…');
  await new Promise((r) => setTimeout(r, 260000));
  const hs = await get('/api/admin/healthscore', TOKEN);
  T('S1 健康分端点可达', hs.code && hs.j.ok, true);
  const names = (hs.j.items || []).map((x) => x.name);
  for (const need of ['RCS 通道', 'WMAS 通道', '循环心跳', '磁盘空间', '近1小时系统错误', '请求面(近1分)']) {
    T('S2 新增检测项「' + need + '」在面板', names.includes(need), true);
  }
  const byName = {}; for (const x of hs.j.items || []) byName[x.name] = x;
  T('S3 RCS通道如实反映不可达（隔离环境连不上内网RCS）', byName['RCS 通道'].ok, false);
  T('S4 红灯项自带处置指引（fix 非空）', typeof byName['RCS 通道'].fix === 'string' && byName['RCS 通道'].fix.includes('ping'), true);
  T('S5 WMAS通道同样红灯带指引', byName['WMAS 通道'].ok === false && String(byName['WMAS 通道'].fix || '').includes('mom-logistics'), true);
  T('S6 循环心跳判定正常（两循环都按拍）', byName['循环心跳'].ok, true);
  T('S7 磁盘空间给出GB数值（Windows fsutil 生效）', /\d+(\.\d+)?GB 可用/.test(byName['磁盘空间'].val), true);
  T('S8 请求面格式正确', /\d+ 请求 · \d+ 个5xx · \d+ 个慢/.test(byName['请求面(近1分)'].val), true);
  // 人性化：所有红灯项必须有 fix（不让人对着红灯发呆）
  const badNoFix = (hs.j.items || []).filter((x) => !x.ok && !x.fix).map((x) => x.name);
  T('S9 全部红灯项都带处置指引（无裸红灯）', badNoFix, []);
  // 盲区诚实：MES 不出现在检测项里（无数据源不假装）
  T('S10 MES 不虚标为可测（盲区如实）', names.some((n) => n.includes('MES')), false);

  // ---- 5. /api/admin/diagnose 病历文本 ----
  const dg = await get('/api/admin/diagnose', TOKEN);
  const txt = (dg.j && dg.j.text) || '';
  T('D1 诊断快照生成成功', dg.j.ok && txt.length > 500, true);
  T('D2 文件名含时间戳', /^诊断快照_\d{14}\.txt$/.test(dg.j.name), true);
  for (const sec of ['循环心跳（进程假死探测）', '外部依赖活性', '请求面（近10分钟）', '近1小时系统错误 TOP', '慢接口 TOP', '落盘与数据', '关键参数现值', '队列与工单现场']) {
    T('D3 病历含「' + sec + '」', txt.includes(sec), true);
  }
  T('D4 病历声明 MES 盲区', txt.includes('盲区如实声明'), true);
  T('D5 病历不含凭据（口令/token 字样零出现）', /passHash|salt|"pwd"|rcsToken/i.test(txt), false);
  T('D6 病历含 RCS 最近错误（供维护人直接定位）', /RCS：最后成功.*连续失败.*最近错误/.test(txt), true);

  // ---- 6. watchdog.ps1 判活（对着本测试服务器跑一轮） ----
  let wdOut = '';
  try {
    wdOut = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '..', 'deploy', 'watchdog.ps1'), '-Port', String(PORT), '-HbStaleSec', '60'], { timeout: 60000, windowsHide: true }).toString();
  } catch (e) { wdOut = String(e.stdout || '') + String(e.stderr || '') + String(e.message || ''); }
  console.log('[watchdog 输出] ' + wdOut.trim().slice(0, 300));
  T('W1 看门狗判活通过（[OK]+双心跳秒数）', /\[OK\].*RCS心跳\d+s.*检验心跳\d+s/.test(wdOut), true);
  T('W2 看门狗无异常不重启（无[重启]字样）', wdOut.includes('[重启]'), false);
  // 异常路径：指向不存在端口 → 应记 [异常 1/3] 且不立即重启（防误杀）
  let wdBad = '';
  try {
    wdBad = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '..', 'deploy', 'watchdog.ps1'), '-Port', '18998'], { timeout: 60000, windowsHide: true }).toString();
  } catch (e) { wdBad = String(e.stdout || '') + String(e.stderr || '') + String(e.message || ''); }
  T('W3 无应答端口判异常且计数', /\[异常 1\/3\].*HTTP无应答/.test(wdBad), true);
  T('W4 单次异常不触发重启（阈值保护）', wdBad.includes('[重启]'), false);

  console.log(`\n===== ${total - fail}/${total} 通过 =====`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('测试异常：' + e.message); console.log(srvLog.slice(-1500)); cleanup(); process.exit(2); });
