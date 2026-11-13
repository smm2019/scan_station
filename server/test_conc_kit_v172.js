// ===================== ㉖v172 第2层②：并发测试公共夹具 =====================
// 用户诉求："这类 bug 只有并发才暴露，test_conc_scan_v168 已是雏形，抽成公共夹具，新功能必须过。"
// 依据（实测）：仓库里 47 个文件各自写了一遍「cp.spawn 起 server + for 循环轮询 /api/health
//   就绪 + 收尾 srv.kill」。每份都在重复解决同一批坑，且各有隐性 bug：
//     · srv.kill() 只杀 node 直接子进程；套件里再 cp.spawn 起的 server 是【孙进程】，
//       失败路径没 kill 就残留 → ① 占端口令下一个套件起不来 ② 持有 stdout 管道令
//       父级 spawnSync/execSync 的 timeout 永久失效（v171 selftest runner 就栽过这个，
//       基线跑到第 5 个套件卡死 587s 无输出）。→ 夹具统一用【杀整棵进程树】。
//     · 就绪探测超时后各套件处置不一（有的 process.exit、有的继续跑出假绿）。
//       → 夹具统一：起不来直接 throw，杜绝"没起来还继续判通过"。
//     · 端口各套件硬编码，并发跑/崩溃残留会撞车。→ 夹具端口可配 + 崩溃残留自动回收。
// 定位：这是【基础设施】，不是某个用例。新的并发/竞态用例基于 startInstance + conc 写，
//   不必再手抄那三段。本文件自带 selftest（=夹具契约测试），被 selftest_ci_runner 纳入门禁。
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const HERE = __dirname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');

// 杀整棵进程树（夹具核心：孙进程 server 必须带走，否则端口被占 + 管道不关卡死上游等待）
function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') cp.spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 8000 });
    else process.kill(-pid, 'SIGKILL'); // detached 独立进程组，整组回收
  } catch (_) { try { process.kill(pid, 'SIGKILL'); } catch (__) {} }
}

// 起一个隔离 server 实例。opts:
//   port(默认8415) tag(临时目录后缀) users[{username,role,password,name}](注入账号)
//   params(覆盖参数,如 {receivingOn:0}) resetStations(true=清空 rcsStations)
//   seedMode('empty'=不复制生产库,用空库 seed admin/admin123；默认复制生产库副本)
// 返回 handle：{ base, port, tdir, pid, log, login(user,pw), post(p2,tok,body), get(p2,tok), stop() }
async function startInstance(opts = {}) {
  const port = opts.port || 8415;
  const tag = opts.tag || ('kit_' + port + '_' + process.pid);
  const tdir = path.join(HERE, '_' + tag);
  if (fs.existsSync(tdir)) fs.rmSync(tdir, { recursive: true, force: true });
  fs.mkdirSync(tdir, { recursive: true });
  const dbFile = path.join(tdir, 'db.json');
  const prodDb = path.join(HERE, 'data', 'db.json');
  const useProd = opts.seedMode !== 'empty' && fs.existsSync(prodDb);
  if (useProd) {
    const dbObj = JSON.parse(fs.readFileSync(prodDb, 'utf8'));
    const sk = path.join(HERE, 'data', 'secret.key');
    if (fs.existsSync(sk)) fs.copyFileSync(sk, path.join(tdir, 'secret.key'));
    dbObj.rcsConfig = null; dbObj.wmasConfig = null; dbObj.agvQueue = []; // 断开外部系统：夹具实例绝不发外联/不叫车
    if (opts.resetStations) dbObj.rcsStations = {};
    if (opts.params) dbObj.params = Object.assign(dbObj.params || {}, opts.params);
    if (opts.users && opts.users.length) {
      const salt = crypto.randomBytes(16).toString('hex');
      dbObj.users = dbObj.users || [];
      for (const su of opts.users) dbObj.users.push({ id: 'u_' + su.username, username: su.username, name: su.name || su.username, role: su.role || 'warehouse', enabled: true, createdAt: Date.now(), mustChangePw: false, salt, passHash: hashPw(su.password || 'Kit#Pass1', salt) });
    }
    if (typeof opts.mutate === 'function') opts.mutate(dbObj); // 夹具钩子：用例就地改副本库（清测试区排/预置撞位等），免"改库→stop→重启"两步
    fs.writeFileSync(dbFile, JSON.stringify(dbObj));
  }
  // ⚠ 空库(seedMode=empty 或 CI 无生产库)：【不写 db.json】，交给 server 自己 defaultDb 建完整库
  //   （含 features 等必需结构）。夹具不自造最小库——自造会漏 features 等字段令 server loadDb
  //   访问 d.features[role] 崩溃(11-13 实测)。代价：空库只有 admin 一个身份，需多身份的夹具
  //   selftest/effect 用例须在无生产库时自行 SKIP（见各文件顶部判断），CI 里与其余依赖库测试同类。
  let log = '';
  const t0 = Date.now(); // 就绪检测基线：用于识别"应答来自残留旧实例"而非本次新进程
  const child = cp.spawn(process.execPath, [path.join(HERE, 'server.js')], { cwd: HERE, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: tdir }, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  const cap = (d) => { log += d; if (log.length > 4e6) log = log.slice(-2e6); };
  child.stdout.on('data', cap); child.stderr.on('data', cap);
  const base = 'http://127.0.0.1:' + port;
  let up = false; const tries = opts.upTries || 60;
  for (let i = 0; i < tries && !up; i++) {
    await sleep(300);
    // ★不能只判 fetch().ok：端口若被上一次崩溃残留的 server 占着，应答照样 200，夹具会误认
    //   "本次实例已就绪"，随后用例连的其实是那个【没有本次注入数据】的旧实例 →
    //   表现为"哨兵/断言没检出"的假失败（11-13 实测：默认端口 8419 被调试残留实例占用，
    //   test_invariant_sweep 连挂 4 条，换端口立刻 26/26）。
    //   新实例的 health.code.startedAt 必然晚于本次 spawn 前时刻，旧残留实例更早 → 据此识别。
    try {
      const rr = await fetch(base + '/api/health');
      if (rr.ok) {
        const j = await rr.json().catch(() => ({}));
        const st = j && j.code && Date.parse(j.code.startedAt || '');
        if (!Number.isFinite(st)) up = true; // 服务端无 code 指纹（老版本），退回旧行为
        else if (st >= t0 - 5000) up = true; // 是本次新起的
        else { log += '\n[KIT] 端口 ' + port + ' 被残留实例占用（startedAt 早于本次启动），等待其退出…'; }
      }
    } catch (_) {}
    if (child.exitCode !== null && child.exitCode !== undefined) break;
  }
  if (!up) { // ★防假绿：起不来绝不返回半残 handle 让调用方"继续跑判通过"
    const info = '隔离实例未就绪 ' + base + ' exitCode=' + child.exitCode + '\n' + log.split('\n').slice(-25).join('\n');
    killTree(child.pid); try { fs.rmSync(tdir, { recursive: true, force: true }); } catch (_) {}
    throw new Error(info);
  }
  const handle = {
    base, port, tdir, pid: child.pid, get log() { return log; },
    async login(username, password) {
      const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password, dev: 'KIT-' + username, kind: 'pda' }) });
      const j = await r.json().catch(() => ({}));
      if (!j.ok || !j.token) throw new Error('夹具登录失败 ' + username + ' → ' + JSON.stringify(j).slice(0, 140)); // ★防假绿
      return j.token;
    },
    async req(method, p2, tok, body) {
      const r = await fetch(base + p2, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      let json = null; try { json = await r.json(); } catch (_) {}
      return { status: r.status, json };
    },
    async stop() { killTree(child.pid); await sleep(350); if (opts.keepDir !== '1') { try { fs.rmSync(tdir, { recursive: true, force: true }); } catch (_) {} } },
  };
  return handle;
}

// 并发发起：传入【返回 Promise 的工厂函数】数组，同时起跑（真并发，非串行 .map(await)）
async function conc(factories) { return await Promise.all(factories.map((f) => f())); }

module.exports = { startInstance, conc, killTree, sleep };

// ===================== selftest：夹具契约测试（被 selftest_ci_runner 纳入）=====================
// 证明夹具【本身】可用——隔离起实例 / 多账号 / 真并发 / 崩溃残留自动回收 / stop 清理干净。
// 业务并发用例（抢同格、盲窗、并发写）由各套件用夹具自行编写；本 selftest 只测夹具能力本身。
if (require.main === module) {
  (async () => {
    let fail = 0, total = 0;
    const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + i + ']' : ''}`); };
    const PORT = Number(process.env.KIT_SELFTEST_PORT || 8415);
    console.log('=== 并发夹具 selftest（端口 ' + PORT + '）===');
    const users = [{ username: 'kit_a', role: 'warehouse', password: 'Kit#Pass1' }, { username: 'kit_b', role: 'warehouse', password: 'Kit#Pass1' }];
    let h = null;
    try {
      h = await startInstance({ port: PORT, tag: 'kitself', users, params: { receivingOn: 0 } });
      C('✅ 夹具能起隔离实例并就绪', !!h.base && (await h.req('GET', '/api/health')).status === 200);

      const [tA, tB] = await conc([() => h.login('kit_a', 'Kit#Pass1'), () => h.login('kit_b', 'Kit#Pass1')]);
      C('✅ 多账号并发登录各拿 token', !!tA && !!tB && tA !== tB);

      // 真并发：6 路 health 同时打（无鉴权）→ 全 200，证明并发下 HTTP 栈稳
      const rr = await conc(Array.from({ length: 6 }, () => () => h.req('GET', '/api/health')));
      C('✅ 6 路并发只读全 200（并发下 HTTP 栈存活）', rr.every((r) => r.status === 200), rr.map((r) => r.status).join(','));
      // 两个 token 并发打带鉴权只读 → 全 200（并发鉴权链）
      const rr2 = await conc([() => h.req('GET', '/api/counts', tA), () => h.req('GET', '/api/counts', tB), () => h.req('GET', '/api/ledger?l=', tA), () => h.req('GET', '/api/ledger?l=', tB)]);
      C('✅ 双 token 并发带鉴权只读全 200', rr2.every((r) => r.status === 200), rr2.map((r) => r.status).join(','));

      const tdir = h.tdir;
      await h.stop(); h = null;
      C('✅ stop 后临时目录已清理', !fs.existsSync(tdir));

      // ★崩溃残留自动回收：stop（杀进程树）后同端口能再起 → 证明孙进程没占端口
      let h2 = null;
      try { h2 = await startInstance({ port: PORT, tag: 'kitself2', users, upTries: 40 }); C('✅ 同端口可再起（进程树已回收、端口已释放）', true); }
      catch (e) { C('✅ 同端口可再起（进程树已回收、端口已释放）', false, e.message.split('\n')[0]); }
      if (h2) await h2.stop();
    } catch (e) {
      C('❌ 夹具 selftest 异常', false, String(e.message).split('\n')[0]);
      if (h) { try { await h.stop(); } catch (_) {} }
    }
    console.log('\n结果: ' + (total - fail) + ' 通过 / ' + fail + ' 失败  （隔离副本，生产库零写入）');
    process.exit(fail ? 1 : 0);
  })();
}
