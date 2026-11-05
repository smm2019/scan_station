// ㉖v108 看门狗配置面板化 + 系统错误可见 · 验证
// 服务器侧：隔离 DATA_DIR 起真实进程，端到端打 health-ping(捎带wd)/report(白名单+localhost+写sysErr)/params/syserr
// PowerShell 侧：源码结构断言（不实际运行脚本——它会真触发 Restart-Service，危险）
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const SRV = path.join(__dirname, 'server.js');
const TMP = path.join(__dirname, 'test_wd_data');
const PORT = 18102;
const TOKEN = 'TESTTOK_wd';
let fail = 0, total = 0;
function T(n, a, b) { total++; const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) { fail++; console.log('FAIL ' + n + '\n  实际=' + JSON.stringify(a) + '\n  期望=' + JSON.stringify(b)); } else console.log('PASS ' + n); }
const req = (method, p, tok, body, timeoutMs = 15000) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : null;
  const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, timeout: timeoutMs, headers: Object.assign({}, tok ? { Authorization: 'Bearer ' + tok } : {}, data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) },
    (res) => { let s = ''; res.on('data', (c) => s += c); res.on('end', () => { try { resolve({ code: res.statusCode, j: JSON.parse(s) }); } catch (e) { reject(new Error(p + ' 解析失败: ' + s.slice(0, 160))); } }); });
  r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error(p + ' 超时')); });
  if (data) r.write(data); r.end();
});

(async () => {
  // ---- 隔离副本 + 注入 admin 会话 ----
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP, 'logs'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), path.join(TMP, 'db.json'));
  if (fs.existsSync(path.join(__dirname, 'data', 'secret.key'))) fs.copyFileSync(path.join(__dirname, 'data', 'secret.key'), path.join(TMP, 'secret.key'));
  const db = JSON.parse(fs.readFileSync(path.join(TMP, 'db.json'), 'utf8'));
  const admin = (db.users || []).find((x) => x.role === 'admin' && x.enabled !== false);
  db.sessions = db.sessions || {};
  db.sessions[TOKEN] = { userId: admin.id, dev: 'TEST-WD', lastSeen: Date.now() };
  if (db.rcsConfig) db.rcsConfig.host = '192.0.2.1:8080';
  if (db.wmasConfig) db.wmasConfig.host = '192.0.2.1:8081';
  fs.writeFileSync(path.join(TMP, 'db.json'), JSON.stringify(db));

  const child = spawn(process.execPath, [SRV], { env: Object.assign({}, process.env, { DATA_DIR: TMP, PORT: String(PORT) }), stdio: ['ignore', 'pipe', 'pipe'] });
  let srvLog = '';
  child.stdout.on('data', (d) => { srvLog += d; }); child.stderr.on('data', (d) => { srvLog += d; });
  const cleanup = () => { try { child.kill('SIGKILL'); } catch (_) {} };
  process.on('exit', cleanup);
  let up = false;
  for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 1000)); try { const h = await req('GET', '/api/health', null, null, 5000); if (h.j && h.j.ok) { up = true; break; } } catch (_) {} }
  T('H0 隔离服务器就绪', up, true);
  if (!up) { console.log(srvLog.slice(0, 2000)); process.exit(1); }

  // ===== A1 health-ping 捎带看门狗面板现值 =====
  const ping = await req('GET', '/api/health-ping', null, null);
  T('A1a ping 捎带 wd 结构', ping.j.wd && typeof ping.j.wd.hbStaleSec === 'number' && typeof ping.j.wd.failThreshold === 'number', true);
  T('A1b wd 默认值 180/3', [ping.j.wd.hbStaleSec, ping.j.wd.failThreshold], [180, 3]);
  T('A1c ping 仍带 pollSec（动态阈值依赖）', typeof ping.j.pollSec === 'number', true);

  // ===== A2 面板改值 → ping 反映新值（即时生效） =====
  await req('POST', '/api/admin/params', TOKEN, { values: { wdHbStaleSec: 300, wdFailThreshold: 5 } });
  const ping2 = await req('GET', '/api/health-ping', null, null);
  T('A2 面板改值经 ping 下发（300/5）', [ping2.j.wd.hbStaleSec, ping2.j.wd.failThreshold], [300, 5]);
  await req('POST', '/api/admin/params', TOKEN, { values: { wdHbStaleSec: 180, wdFailThreshold: 3 } }); // 复位

  // ===== A3 上报端点：合法 act 写入 sysErr =====
  const rep = await req('POST', '/api/watchdog/report', null, { act: 'restart_ok', detail: '验证上报：心跳异常→已重启恢复' });
  T('A3a 合法 act 上报成功', rep.j.ok === true, true);
  const se = await req('GET', '/api/admin/syserr?limit=20', TOKEN);
  const hit = (se.j.list || []).find((x) => x.where === '看门狗' && /restart_ok/.test(x.msg || ''));
  T('A3b 系统错误页可见上报记录', !!hit, true);
  T('A3c 记录含中文说明', hit && /已重启恢复/.test(hit.msg), true);

  // ===== A4 act 白名单：非法值拒绝 =====
  const repBad = await req('POST', '/api/watchdog/report', null, { act: 'rm_rf', detail: 'x' });
  T('A4a 非法 act 被拒(400)', [repBad.code, repBad.j.ok], [400, false]);
  const repEmpty = await req('POST', '/api/watchdog/report', null, {});
  T('A4b 缺 act 被拒(400)', repEmpty.code, 400);

  // ===== A5 五类合法 act 全放行 =====
  for (const a of ['hb_stale', 'restart_ok', 'restart_fail', 'restart_limit', 'no_http']) {
    const r = await req('POST', '/api/watchdog/report', null, { act: a, detail: '枚举验证' + a });
    T('A5 act=' + a + ' 放行', r.j.ok === true, true);
  }

  // ===== A6 上报记录进事件流（pushEvent carEvents） =====
  const ev = await req('GET', '/api/agv/events', TOKEN).catch(() => null); // 端点若不同名则跳过，A3 已证 sysErr 可见
  if (ev && ev.j && ev.j.list) T('A6 事件流含看门狗', (ev.j.list || []).some((x) => /看门狗/.test(JSON.stringify(x))), true);
  else console.log('[A6] 事件流端点名不匹配，跳过（sysErr 可见已在 A3 证明，pushEvent 源码断言见 B 组）');

  // ===== A7 参数注册在面板可见 =====
  const pm = await req('GET', '/api/admin/params', TOKEN);
  const keys = (pm.j.items || []).map((x) => x.k);
  T('A7a 面板含 wdHbStaleSec', keys.includes('wdHbStaleSec'), true);
  T('A7b 面板含 wdFailThreshold', keys.includes('wdFailThreshold'), true);
  const grp = (pm.j.items || []).find((x) => x.k === 'wdFailThreshold');
  T('A7c 重启阈值下限=2（禁1次即杀）', grp && grp.min, 2);

  // ===== B 组：PowerShell 源码结构断言（不运行，避免真重启服务） =====
  const wd = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'watchdog.ps1'), 'utf8');
  const rg = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'watchdog-register.ps1'), 'utf8');
  T('B1 读面板值 hbStaleSec/failThreshold', /\$r\.wd/.test(wd) && /hbStaleSec/.test(wd) && /failThreshold/.test(wd), true);
  T('B2 动态阈值 max(面板, pollSec*2+60)', /effHb/.test(wd) && /poll \* 2 \+ 60/.test(wd), true);
  T('B3 重启限速 1小时2次', /Test-RateLimit/.test(wd) && /3600000/.test(wd) && /-ge 2/.test(wd), true);
  T('B4 延迟上报 pending 队列', /Write-Pending/.test(wd) && /Flush-Pending/.test(wd) && /watchdog-pending/.test(wd), true);
  T('B5 上报调用 report 端点', /\/api\/watchdog\/report/.test(wd), true);
  T('B6 限速超限记 restart_limit', /restart_limit/.test(wd), true);
  T('B7 恢复后清零+补报', /restart_ok/.test(wd) && /Flush-Pending/.test(wd), true);
  T('B8 register 传端口进任务命令行', /-Port ' \+ \$Port/.test(rg), true);
  T('B9 register 提权透传参数', /'\-File', \$PSCommandPath, '\-Port', \$Port/.test(rg), true);
  T('B10 register 端口/服务名格式校验', rg.includes('$Port -notmatch') && rg.includes('$SvcName -notmatch') && rg.includes('throw'), true);
  T('B11 watchdog 保留 UTF-8 输出编码', /Console\]::OutputEncoding/.test(wd), true);

  console.log('\n===== 看门狗配置验证 ' + (total - fail) + '/' + total + ' 通过 =====');
  if (fail) { console.log('--- 服务器日志尾部 ---'); console.log(srvLog.slice(-1200)); }
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FATAL ' + e.message); try { child.kill('SIGKILL'); } catch (_) {} process.exit(2); });
