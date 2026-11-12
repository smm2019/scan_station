#!/usr/bin/env node
// ===================== ㉖v172 第1层②：APK 构建后服务端冒烟 =====================
// 动因（用户提："CI 反正要 build APK，build 完顺手起个 server 打几个只读接口冒烟，
//   /api/health 是现成靶子"）：现有 selftest 门禁（v171）跑的是逻辑断言，但没有一项验证
//   【真实 server 能否从空库起来、HTTP 栈通不通、鉴权链健不健康】。这类"起不来/启动即崩/
//   health 结构被改坏"的回归，flutter analyze 和逻辑测试都拦不住——本次 v171/v172 恰恰就改了
//   health 返回体，最需要这道冒烟兜底。
//
// 冒烟哲学：只打【只读 + 无外部依赖】端点，不测业务写路径（写路径靠 selftest 门禁）。
//   目的不是覆盖率，是回答"这次改动有没有让服务根本起不来 / 关键只读接口 500"。
//   fresh 空库启动无 rcsConfig/wmasConfig → 不碰任何外部系统，CI 沙箱里必不发外联。
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const HERE = __dirname;
const TDIR = path.join(HERE, '_smoke_v172');
const PORT = Number(process.env.SMOKE_PORT || 8397);
const BASE = 'http://127.0.0.1:' + PORT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + i + ']' : ''}`); };
const killTree = (pid) => { try { if (process.platform === 'win32') cp.spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 8000 }); else process.kill(-pid, 'SIGKILL'); } catch (_) { try { process.kill(pid, 'SIGKILL'); } catch (__) {} } };

function runSmoke() {
  return new Promise(async (resolve) => {
    if (fs.existsSync(TDIR)) fs.rmSync(TDIR, { recursive: true, force: true });
    fs.mkdirSync(TDIR, { recursive: true }); // 空库 → server 自动 defaultDb + seed admin/admin123（loadDb 290 行）
    let srvOut = '';
    const child = cp.spawn(process.execPath, [path.join(HERE, 'server.js')], {
      cwd: HERE, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR },
      stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    child.stdout.on('data', (d) => { srvOut += d; if (srvOut.length > 2e6) srvOut = srvOut.slice(-1e6); });
    child.stderr.on('data', (d) => { srvOut += d; if (srvOut.length > 2e6) srvOut = srvOut.slice(-1e6); });
    const done = () => { killTree(child.pid); setTimeout(async () => { try { fs.rmSync(TDIR, { recursive: true, force: true }); } catch (_) {} resolve(fail); }, 400); };

    try {
      // ① 服务能否起来（HTTP 栈活着）——冒烟最核心的一条
      let up = false, upErr = '';
      for (let i = 0; i < 60 && !up; i++) {
        await sleep(500);
        try { const r = await fetch(BASE + '/api/health'); up = r.ok; } catch (e) { upErr = e.message; }
        // 进程若已退出则无需再等
        if (child.exitCode !== null && child.exitCode !== undefined) { upErr = '进程提前退出 code=' + child.exitCode; break; }
      }
      if (!up) { C('❌ 服务未能启动（/api/health 60 次探测无 200）', false, upErr); console.log('   server 输出尾:\n' + srvOut.split('\n').slice(-20).join('\n')); done(); return; }
      C('✅ 服务从空库成功启动（HTTP 栈存活）', true);

      // ② health 结构未被改坏：v171 加的 code.* 与 v172 加的 invariant 字段都必须在
      const h = await (await fetch(BASE + '/api/health')).json();
      C('✅ health.ok 且既有字段完好（uptime/serverTime/memMB/counts/netmap）',
        h.ok === true && typeof h.uptime === 'number' && !!h.serverTime && h.counts && h.netmap, 'uptime=' + h.uptime);
      C('✅ v171 代码身份字段在位（code.codeSha 12hex + codeMismatch 布尔）',
        h.code && /^[0-9a-f]{12}$/.test(h.code.codeSha) && typeof h.code.codeMismatch === 'boolean', h.code && h.code.codeSha);
      C('✅ v171 部署自检旗正常态=false（刚起未改码，不该误报）', h.code && h.code.codeMismatch === false, h.code && h.code.codeMismatch);
      C('✅ v172 哨兵快照字段存在（invariant，null=启动未满14秒属正常）', h.invariant === null || typeof h.invariant === 'object', JSON.stringify(h.invariant));

      // ③ seed 账号能登录（空库自动建的 admin/admin123）→ 鉴权栈健康
      const lg = await (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123', dev: 'SMOKE', kind: 'pda' }) })).json();
      C('✅ seed admin/admin123 可登录拿到 token（鉴权链健康）', lg.ok === true && !!lg.token, 'ok=' + lg.ok + ' role=' + (lg.user || {}).role);
      if (!lg.token) { C('（后续鉴权用例跳过：登录未拿 token）', false); done(); return; }
      const H = { Authorization: 'Bearer ' + lg.token };

      // ④ 带鉴权只读端点 200（证明 auth→handler→序列化整链通）
      for (const ep of ['/api/counts', '/api/ledger?l=', '/api/scanlog?limit=2']) {
        const r = await fetch(BASE + ep, { headers: H });
        let body = null; try { body = await r.json(); } catch (_) {}
        C('✅ 带 token GET ' + ep + ' → 200 且合法 JSON', r.status === 200 && body && (body.ok === true || body.items !== undefined || body.counts !== undefined), r.status);
      }
      // ⑤ 无鉴权看门狗探测端点（v108，运维/看门狗依赖）
      const ping = await (await fetch(BASE + '/api/health-ping')).json().catch(() => ({}));
      C('✅ 看门狗 /api/health-ping 正常应答（ok + hb 心跳结构完好）', ping.ok === true && ping.hb && typeof ping.hb.rcsAgeS === 'number' && typeof ping.hb.inspAgeS === 'number', 'hb=' + JSON.stringify(ping.hb));

      // ⑥ 哨兵哨兵会首跑（可选，等到 14 秒首跑；等不到不判失败——非阻塞项）
      let sawInvariant = false;
      for (let i = 0; i < 8; i++) { await sleep(1500); const hh = await (await fetch(BASE + '/api/health')).json(); if (hh.invariant && hh.invariant.at) { sawInvariant = true; break; } }
      C('◽ 哨兵首跑可在 health 观测到（非阻塞，超时不判死）', sawInvariant || true, sawInvariant ? '已观测到自检快照' : '14 秒内未观测到（不影响冒烟通过）');
    } catch (e) {
      C('❌ 冒烟脚本异常', false, e.message);
      console.log('   server 输出尾:\n' + srvOut.split('\n').slice(-20).join('\n'));
    }
    done();
  });
}

console.log('=== v172 服务端冒烟（空库起真实 server，只打只读端点）===');
runSmoke().then(() => {
  console.log('\n结果: ' + (total - fail) + ' 通过 / ' + fail + ' 失败  （临时空库 DATA_DIR，生产库零接触）');
  process.exit(fail ? 1 : 0);
});
