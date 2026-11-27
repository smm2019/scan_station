// ㉖v283 系统自愈锁定 端到端验证
// 核心风险=永久锁死：7 个 boot 步骤任一在真实环境不触发，ready 恒 false，现场被永久锁。必须实跑证明。
// ★ 为什么必须真跑：① ready 流转(false→true)只有真启动才看得见；② 503 闸门覆盖面(无鉴权只读接口)
//   靠静态审查易漏；③ 白名单不误伤升级/探活通道；④ 损坏库回滚取证 recovered 字段。
// 隔离：临时空数据目录 + 测试端口，SELFTEST_NO_LIVE=1 禁建 WMAS 任务。绝不碰生产 data/ 与端口 8099。
const fs = require('fs'), path = require('path'), cp = require('child_process');
const TDIR = path.join(__dirname, '_selfheal_v283'), PORT = Number(process.env.HS_PORT || 9930);
const BASE = 'http://127.0.0.1:' + PORT;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + String(i).slice(0, 160) + ']' : ''}`); };
const getj = async (p2, tk) => { const r = await fetch(BASE + p2, { headers: tk ? { Authorization: 'Bearer ' + tk } : {} }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
const postj = async (p2, tk, body) => { const r = await fetch(BASE + p2, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: JSON.stringify(body || {}) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };

(async () => {
  let srv;
  const killTree = () => { try { if (srv && srv.exitCode === null) cp.execSync(`taskkill /pid ${srv.pid} /T /F`, { stdio: 'ignore', windowsHide: true }); } catch (_) {} };
  try {
    fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
    // 端口占用探测：有响应/超时=忙(僵尸占端口)；连接被拒=空闲
    const probe = await Promise.race([
      fetch(BASE + '/api/health', { signal: AbortSignal.timeout(1000) }).then(() => 'busy')
        .catch((e) => ((e && (e.name === 'AbortError' || e.name === 'TimeoutError')) ? 'busy' : 'free')),
      sleep(1400).then(() => 'free')
    ]);
    if (probe === 'busy') throw new Error('端口 ' + PORT + ' 被占用，换 HS_PORT 重跑');

    // 空数据目录：服务启动走 defaultDb() 创建初始库，最干净、零生产数据风险
    srv = cp.spawn(process.execPath, ['server.js'], { cwd: __dirname, env: Object.assign({}, process.env, { SELFTEST_NO_LIVE: '1', PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }), stdio: ['ignore', 'pipe', 'pipe'] });
    let bootLog = '';
    srv.stdout.on('data', d => { bootLog += d.toString(); });
    srv.stderr.on('data', d => { bootLog += d.toString(); });
    const suicide = setTimeout(() => { console.log('❌ 总时限 60s 到，强制收网\n--- 服务日志尾 ---\n' + bootLog.slice(-2000)); killTree(); process.exit(1); }, 60000);
    process.on('exit', () => { clearTimeout(suicide); killTree(); });

    // 等端口通（load 步完成、监听开放）
    let up = false; for (let i = 0; i < 60 && !up; i++) { await sleep(250); try { const h = await getj('/api/health'); up = h.status === 200 && !!h.json.boot; } catch (_) {} }
    C('护栏 服务就绪且 health 带 boot 字段', up); if (!up) throw new Error('服务未起或无 boot 字段\n' + bootLog.slice(-1500));

    // ---- 阶段1：自愈期（刚起来，sweep 链未跑完，ready 应为 false）----
    const h0 = await getj('/api/health');
    const b0 = h0.json.boot || {};
    C('自愈期 boot.ready=false', b0.ready === false, 'ready=' + b0.ready + ' pending=' + JSON.stringify(b0.pending));
    C('自愈期 pending 非空且有 total', Array.isArray(b0.pending) && b0.pending.length > 0 && b0.total > 0, 'total=' + b0.total + ' done=' + (b0.total - (b0.pending || []).length));
    C('自愈期 rcs.required=false（空库未配AGV）', b0.rcs && b0.rcs.required === false, JSON.stringify(b0.rcs));

    // 无鉴权只读接口：自愈期必须 503 selfheal（验证闸门前移覆盖到位）
    const sl = await getj('/api/scanlog');
    C('自愈期 /api/scanlog（无鉴权只读）被 503 拦', sl.status === 503 && sl.json.code === 'selfheal', 'status=' + sl.status + ' code=' + sl.json.code);
    // 登录：自愈期被拦（禁新登录操作）
    const lg0 = await postj('/api/login', null, { username: 'admin', password: 'admin123', dev: 'T1', kind: 'pda' });
    C('自愈期 /api/login 被 503 拦', lg0.status === 503 && lg0.json.code === 'selfheal', 'status=' + lg0.status);
    // 白名单：health 自愈期仍可访问（探活通道不被锁死）
    C('自愈期白名单 /api/health 仍 200', h0.status === 200 && h0.json.ok === true);
    // 白名单：app/version 升级通道仍放行
    const av = await getj('/api/app/version');
    C('自愈期白名单 /api/app/version 非503（升级通道不锁死）', av.status !== 503, 'status=' + av.status);

    // ---- 阶段2：等待自愈完成（最晚 deadSweep 17s，给到 35s 上限）----
    let bReady = null, tReady = -1; const t0 = Date.now();
    for (let i = 0; i < 70; i++) {
      await sleep(500);
      const h = await getj('/api/health'); const b = h.json.boot || {};
      if (b.ready === true) { bReady = b; tReady = Math.round((Date.now() - t0) / 1000); break; }
    }
    C('★关键：boot.ready 在 35s 内变为 true（无永久锁死）', bReady !== null, 'readyAt=' + (tReady < 0 ? '超时未就绪' : tReady + 's') + ' pending=' + JSON.stringify(bReady ? bReady.pending : 'n/a'));
    if (bReady) {
      C('就绪后 pending 为空、phase=ready', bReady.pending.length === 0 && bReady.phase === 'ready', JSON.stringify({ pending: bReady.pending, phase: bReady.phase }));
      C('就绪后 7 步全打勾（total-done=0）', (bReady.total - bReady.pending.length) === bReady.total, 'done=' + (bReady.total - bReady.pending.length) + '/' + bReady.total);
    }

    // ---- 阶段3：就绪后闸门解除 ----
    const lg1 = await postj('/api/login', null, { username: 'admin', password: 'admin123', dev: 'T1', kind: 'pda' });
    C('就绪后 /api/login 放行（非503）', lg1.status !== 503, 'status=' + lg1.status + ' msg=' + (lg1.json.msg || ''));
    const tk = lg1.json.token;
    if (tk) {
      const sl1 = await getj('/api/scanlog', tk);
      C('就绪后 /api/scanlog 放行（非503）', sl1.status !== 503, 'status=' + sl1.status);
      const me = await getj('/api/me', tk);
      C('就绪后 /api/me 正常返回身份', me.status === 200 && me.json.ok === true, 'status=' + me.status);
    } else {
      C('就绪后能拿到登录 token（验证放行链路）', false, '未取到 token，login status=' + lg1.status);
    }

    // ---- 阶段4：boot 打勾日志留痕（取证：每步带启动后秒数）----
    const doneCount = (bootLog.match(/\[boot\] ✔/g) || []).length;
    C('服务端 [boot] 打勾日志 7 条齐全', doneCount === 7, '实际=' + doneCount + ' 条');

    clearTimeout(suicide);
  } catch (e) {
    C('测试异常', false, e.message);
    console.log('--- 服务日志尾 ---\n' + (typeof bootLog !== 'undefined' ? '' : '') );
  } finally {
    killTree();
    await sleep(400);
    try { fs.rmSync(TDIR, { recursive: true, force: true }); } catch (_) {}
  }
  console.log(`\n==== v283 自愈锁定测试：${total - fail}/${total} 通过${fail ? '（' + fail + ' 项失败）' : ' ✅ 全绿'} ====`);
  process.exit(fail ? 1 : 0);
})();
