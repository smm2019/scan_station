// ㉖v224 网页 WMAS 凭证+让位面板 端到端验证（服务端侧契约；面板 JS 走语法闸+人工冒烟）
// 背景：WMAS 单账号后登录踢前登录，凭证失效告警在网页弹、恢复动作（重存配置/让位）只有 PDA 能做
// ——网页"看得见够不着"。本次=管理页加 🔐 WMAS 凭证 面板：保存（带 cfgRev 乐观锁）+ 退出让位 + 恢复。
// 服务端契约：①sysstatus 下发 cfgRev + wmas.host（脱协议头，账号密码零回显=红线断言）
// ②wmas-config 带对 baseRev→保存且 cfgRev+1；带旧值→409 不落库；不带→兼容放行（旧PDA 行为不变）
// ③auth-logout→让位激活（sysstatus login 灯随之转灭）；auth-resume→解除让位+如实回测。
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const TDIR = path.join(__dirname, '_wmp_v224'), PORT = Number(process.env.HS_PORT || 9953);
const BASE = 'http://127.0.0.1:' + PORT;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + String(i).slice(0, 130) + ']' : ''}`); };
const post = async (p2, tk, body) => { const r = await fetch(BASE + p2, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: JSON.stringify(body || {}) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
const get2 = async (p2, tk) => { const r = await fetch(BASE + p2, { headers: tk ? { Authorization: 'Bearer ' + tk } : {} }); const t = await r.text(); let j = {}; try { j = JSON.parse(t) } catch (_) {} return { status: r.status, text: t, json: j }; };
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
    if (probe === 'busy') throw new Error('端口 ' + PORT + ' 被占用——HS_PORT 换端口重跑');
    const salt = crypto.randomBytes(16).toString('hex'), PW = 'E2e#Hs!224';
    const db0 = {
      users: [{ id: 'u_wm224', username: 'wm_u', name: '凭证测试管理', role: 'admin', enabled: true, createdAt: new Date().toISOString(), mustChangePw: false, salt, passHash: crypto.scryptSync(PW, salt, 32).toString('hex') }],
      sessions: {}, devices: {}, ops: [], notifications: [],
      requisitions: [], outbound: {}, ledger: [], scanlog: {}, agvQueue: [], agvTasks: {}, carEvents: [], inspects: [],
      // 假主机指向 127.0.0.1:1（秒断拒连，防测试挂在真实网络超时上）；带 http:// 前缀验脱敏
      wmasConfig: { host: 'http://127.0.0.1:1', account: 'secret_acc_224', pwd: 'secret_pwd_224' },
      rcsConfig: null, rcsStations: {},
    };
    fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
    srv = cp.spawn(process.execPath, ['server.js'], { cwd: __dirname, env: Object.assign({}, process.env, { SELFTEST_NO_LIVE: '1', PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }), stdio: ['ignore', 'pipe', 'pipe'] });
    process.on('exit', killTree);
    let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(600) })).ok; } catch (_) {} }
    C('护栏 实例就绪', up); if (!up) throw new Error('实例未起');
    const tk = (await post('/api/login', null, { username: 'wm_u', password: PW, dev: 'WM', kind: 'web' })).json.token;
    C('护栏 管理员登录', !!tk); if (!tk) throw new Error('登录失败');
    // ① sysstatus：cfgRev 下发 + host 脱敏带出 + 【红线】不回显账号/密码
    let s1 = await get2('/api/sysstatus', tk);
    C('★★★ ① sysstatus 带 cfgRev（乐观锁基线）', typeof s1.json.cfgRev === 'number', 'cfgRev=' + s1.json.cfgRev);
    C('★★★ ① wmas.host 脱协议头带出（面板"已带出"不撒谎）', s1.json.wmas && s1.json.wmas.host === '127.0.0.1:1', JSON.stringify((s1.json.wmas || {}).host));
    C('★★★ ① 红线：sysstatus 全文不含账号/密码明文', !s1.text.includes('secret_acc_224') && !s1.text.includes('secret_pwd_224') && !/pwd/i.test(s1.text), '泄露=致命');
    const rev0 = s1.json.cfgRev || 0;
    // ② 带对 baseRev 保存 → cfgRev+1 且 host 更新
    const w2 = await post('/api/agv/wmas-config', tk, { host: 'http://127.0.0.1:2', account: 'new_acc_224', pwd: 'new_pwd_224', baseRev: rev0 });
    C('★★★ ② baseRev 正确→保存成功且 cfgRev 递增', w2.json.ok === true && w2.json.cfgRev === rev0 + 1, 'cfgRev=' + w2.json.cfgRev + ' 应=' + (rev0 + 1));
    let s2 = await get2('/api/sysstatus', tk);
    C('★★ ② 保存后 host 即时更新（面板回测可见）', s2.json.wmas.host === '127.0.0.1:2', s2.json.wmas.host);
    // ③ 带旧 baseRev → 409 冲突，不落库（两人同改不静默互盖）
    const w3 = await post('/api/agv/wmas-config', tk, { host: 'http://127.0.0.1:3', account: 'evil_acc', pwd: 'evil_pwd', baseRev: rev0 });
    C('★★★ ③ 旧 baseRev→409 conflict 拒保存', w3.status === 409 && w3.json.code === 'conflict', 'st=' + w3.status + ' code=' + w3.json.code);
    let s3 = await get2('/api/sysstatus', tk);
    C('★★★ ③ 409 后配置纹丝未动（host 仍是②的新值，非 evil）', s3.json.wmas.host === '127.0.0.1:2' && s3.json.cfgRev === rev0 + 1, 'host=' + s3.json.wmas.host + ' rev=' + s3.json.cfgRev);
    // ④ 不带 baseRev → 兼容放行（旧 PDA 行为逐字不变）
    const w4 = await post('/api/agv/wmas-config', tk, { host: 'http://127.0.0.1:4', account: 'legacy_acc', pwd: 'legacy_pwd' });
    C('★★ ④ 无 baseRev 兼容放行（旧 PDA 零回归）', w4.json.ok === true && w4.json.cfgRev === rev0 + 2, 'st=' + w4.status);
    // ⑤ 退出让位闭环
    const l5 = await post('/api/agv/auth-logout', tk, {});
    C('★★★ ⑤ auth-logout→让位激活', l5.json.ok === true && l5.json.msg.includes('让位'), JSON.stringify(l5.json.msg || '').slice(0, 60));
    const y5 = await get2('/api/agv/auth-yield', tk);
    C('★★ ⑤ auth-yield 状态可查（面板显示剩余/归因）', y5.json.on === true && y5.json.leftMin >= 1 && y5.json.by === '凭证测试管理', 'left=' + y5.json.leftMin + ' by=' + y5.json.by);
    let s5 = await get2('/api/sysstatus', tk);
    C('★★ ⑤ 让位期 sysstatus 登录灯随之转灭（不谎报在线）', s5.json.wmas.login === false && s5.json.wmas.ok === false, JSON.stringify(s5.json.wmas));
    // ⑥ 恢复：解除让位 + 如实回测（假主机连不通必须报 false，绝不假绿）
    const r6 = await post('/api/agv/auth-resume', tk, {});
    C('★★★ ⑥ auth-resume 解除让位', r6.json.ok === true, JSON.stringify(r6.json.msg || '').slice(0, 60));
    const y6 = await get2('/api/agv/auth-yield', tk);
    C('★★ ⑥ 让位态清零', y6.json.on === false);
    C('★★★ ⑥ 红线：恢复回测如实报假——主机不通时 wmasOk 必为 false，面板不假绿', r6.json.wmasOk === false, 'wmasOk=' + r6.json.wmasOk);
    // ⑦ 留痕：改配置记入活动流且密码不进留痕
    const ops = await get2('/api/admin/ops?limit=50', tk);
    const oline = ((ops.json.list) || []).find((x) => String(x.act || '').includes('WMAS') || String(x.act || '').includes('改WMAS'));
    C('★★ ⑦ 改配置留痕存在且不含密码', !!oline && !JSON.stringify(oline).includes('legacy_pwd'), JSON.stringify((oline || {}).act || ''));
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
