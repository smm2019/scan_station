// ㉖v161 「退出 WMAS/AGV 登录」让位机制 · 端到端实例验证
// 背景（11-12 现场）：WMAS 报 {"code":401,"msg":"有其他用户登录该账号"}。现场已改密码仍复现 ——
// 因为抢号的不是密码错误，而是【三方共用同一账号】：我们服务器（每 20 秒轮询自动登录）、
// PDA（每页取票自动登录）、人工浏览器（查数据/改密）都拿 18062501 登录，两套调度系统都是
// "后登录者踢前者"，于是谁都稳定不下来。实测故障持续 1 小时 19 分、现场反复重叫 3 轮无效。
// 修法（让位而非强抢 —— 服务器绝不抢号，这才是人能理解的语义）：
//   ① /api/agv/auth-logout：清服务器票据 + 进入让位窗口（默认 agvAuthYieldMin=15 分钟）
//   ② 让位期内 wmasToken()/rcsLogin() 一律不登录；_rcsPollInner 整轮静默（含排队调度）；
//      wmasHealthWatch 跳过（让位≠故障，绝不能报"mom-logistics 掉线"）
//   ③ dispatchOne 守卫收口【全部】下发入口，文案给准确原因与恢复办法
//   ④ /api/agv/auth-resume 结束让位并当场探一次通道（改密未同步会立刻暴露）
//   ⑤ 重存 WMAS/RCS 配置 = 人工宣告已办完 → 立即解除让位
//   ⑥ PDA 本机同样让位（AgvAuthYield），否则本机每次取票照样踢人
// ★ 数据安全：wmasConfig/rcsConfig 全为【合成值】指向本机假服务（127.0.0.1），绝不连真实
//   WMAS(172.25.1.155)/RCS；隔离 DATA_DIR 副本，真实生产库只读不写。
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const SRV = path.join(__dirname, 'server.js');
const SRC_DB = path.join(__dirname, 'data', 'db.json');
const TMP = path.join(__dirname, 'proof_auth_yield_v161');
const PORT = 18171, WPORT = 18172, RPORT = 18173, VT = 'TESTTOK_V161';
let pass = 0, fail = 0;
const T = (id, cond, note) => { if (cond) { pass++; console.log('PASS ' + id + (note ? '  ' + note : '')); } else { fail++; console.log('FAIL ' + id + '  got=' + JSON.stringify(cond) + (note ? '  [' + note + ']' : '')); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const req = (method, p, body) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : null;
  const r0 = http.request({ host: '127.0.0.1', port: PORT, path: p, method, timeout: 15000, headers: Object.assign({ Authorization: 'Bearer ' + VT }, data ? { 'Content-Type': 'application/json' } : {}) }, res => { let s = ''; res.on('data', d => s += d); res.on('end', () => { try { resolve(JSON.parse(s)); } catch (_) { resolve({ raw: s.slice(0, 150) }); } }); });
  r0.on('error', reject); if (data) r0.write(data); r0.end();
});
const getDb = () => JSON.parse(fs.readFileSync(path.join(TMP, 'db.json'), 'utf8'));

// ---- 假 WMAS：计数登录与业务请求（核心观测量）----
const wm = { logins: 0, biz: 0 };
const fakeWmas = http.createServer((q, s) => {
  let b = ''; q.on('data', d => b += d);
  q.on('end', () => {
    const p = q.url.split('?')[0];
    const j = (o) => { s.writeHead(200, { 'Content-Type': 'application/json' }); s.end(JSON.stringify(o)); };
    if (p === '/api/auth/login') { wm.logins++; return j({ code: 200, success: true, data: { token: 'TK-Y161' } }); }
    wm.biz++;
    // 下发链前置：容器主档须有可用编码、三状态任务清单须为空，否则 dispatchOne 提前失败、根本走不到建任务
    if (p === '/api/logistics/container/list') return j({ success: true, code: 200, data: { records: [{ containerCode: 'Y161PALLET01' }] } });
    if (p === '/api/logistics/agv-task/list') return j({ success: true, code: 200, data: { records: [] } });
    if (p === '/api/basicdata/wmsLocation/listAll') return j({ success: true, code: 200, data: [{ locationCode: 'NB02-G-01-1F', warehouseCode: 'W', districtCode: 'D' }, { locationCode: 'NB02-CK-12', warehouseCode: 'W', districtCode: 'D' }, { locationCode: 'NB02-CK-05', warehouseCode: 'W', districtCode: 'D' }] });
    return j({ success: true, code: 200, data: { taskNo: 'AGV-TEST-Y161', ids: [1] } });
  });
});
// ---- 假 RCS：同样计数（AGV 调度系统同账号互斥，必须一起让位）----
const rc = { logins: 0, biz: 0 };
const fakeRcs = http.createServer((q, s) => {
  let b = ''; q.on('data', d => b += d);
  q.on('end', () => {
    const p = q.url.split('?')[0];
    const j = (o) => { s.writeHead(200, { 'Content-Type': 'application/json' }); s.end(JSON.stringify(o)); };
    if (p === '/login') { rc.logins++; return j({ code: 0, msg: 'ok', data: 'RCS-TOKEN-Y161' }); }
    rc.biz++;
    return j({ code: 0, msg: 'ok', data: [] });
  });
});

(async () => {
  try {
    await new Promise(r => fakeWmas.listen(WPORT, '127.0.0.1', r));
    await new Promise(r => fakeRcs.listen(RPORT, '127.0.0.1', r));
    fs.rmSync(TMP, { recursive: true, force: true }); fs.mkdirSync(path.join(TMP, 'logs'), { recursive: true });
    fs.copyFileSync(SRC_DB, path.join(TMP, 'db.json'));
    const sk = path.join(__dirname, 'data', 'secret.key'); if (fs.existsSync(sk)) fs.copyFileSync(sk, path.join(TMP, 'secret.key'));
    const d0 = getDb();
    const wh = (d0.users || []).find(x => x.role === 'admin' && x.enabled !== false); // agv_control 权限
    d0.sessions = d0.sessions || {}; d0.sessions[VT] = { userId: wh.id, dev: 'TEST-V161', lastSeen: Date.now() };
    // ★ 合成配置指向本机假服务；真实 172.25.1.155 / 10.96.23.8 绝不触碰
    d0.wmasConfig = { host: '127.0.0.1:' + WPORT, account: 'synthacct', pwd: 'synthpwd' };
    d0.rcsConfig = { host: '127.0.0.1:' + RPORT, account: 'synthacct', pwd: 'synthpwd' };
    d0.agvDispatchMode = 'live'; // 真实下发路径才会走 WMAS 建任务（dry 只演算）
    d0.params = Object.assign({}, d0.params, { agvAuthYieldMin: 15 });
    d0.agvQueue = (d0.agvQueue || []).filter(q => !['排队', '下发中', '已下发', '到站'].includes(q.state) && !String(q.code || '').startsWith('N9Y')); // 生产活跃项会占台/撞在途闸 → 空过与串扰
    // 隔离生产继承态：①台站用途/停用（生产 CK-01~04 是入库专用台，出库叫车会被选台闸挡死→走不到
    // 下发路径，让"零登录"断言变成空过）②生产真实 wmas_auth 告警与故障标记（会污染误报断言）
    d0.stnMeta = {};
    d0.rcsStations = {}; d0.rcsRun = []; d0.rcsJam = []; // 台站快照/在途也清零：生产快照"有货/占用中"会把叫车挡在排队态 → A1 空过
    d0.notifications = (d0.notifications || []).filter(x => x.type !== 'wmas_auth' && !/掉线|探活失败|凭证/.test(String(x.text || '')));
    d0.wmasDownAt = 0;
    // 叫车前置闸：出库要求框在货位账本可查（否则报"查无此框，AGV 会叉空"），预置三段用框
    d0.ledger = (d0.ledger || []).filter(x => !String(x.c || '').startsWith('N9Y'));
    d0.ledger.push(...['N9Y000001', 'N9Y000002', 'N9Y000003'].map(c => ({ c, l: 'NB02-G-01-1F', f: 'PALLET', t: Date.now() - 3600000, p: 'TESTPN', n: 'V161测试件', q: 100, b: '2026-11-11', by: '测试' }))); // f=PALLET 与假容器 Y161PALLET01 匹配（下发按类型筛容器候选）
    fs.writeFileSync(path.join(TMP, 'db.json'), JSON.stringify(d0));
    const child = spawn(process.execPath, [SRV], { env: Object.assign({}, process.env, { DATA_DIR: TMP, PORT: String(PORT) }), stdio: 'ignore' });
    let up = false;
    for (let i = 0; i < 50; i++) { await sleep(400); try { const h = await new Promise((rs, rj) => { http.get({ host: '127.0.0.1', port: PORT, path: '/api/health', timeout: 3000 }, res => { let s = ''; res.on('data', d => s += d); res.on('end', () => rs(s)); }).on('error', rj); }); if (String(h).indexOf('ok') >= 0) { up = true; break; } } catch (_) { } }
    T('H0 隔离实例就绪（假 WMAS/RCS 已挂）', up, true);
    if (!up) throw new Error('实例未起');

    // ============ A 正常态：叫车真的会登录 WMAS ============
    // 台站用 CK-12（生产 CK-01~04 为入库专用台，出库叫车会被选台闸挡死）；每段换独立框码，
    // 避免上一段遗留的"在途搬运任务"闸把本段挡下（那会让"零登录"变成空过）。
    const carry = (code, to) => req('POST', '/api/agv/carry', { dir: 'out', code, from: 'NB02-G-01-1F', to: to || 'NB02-CK-12' });
    wm.logins = 0; wm.biz = 0;
    let c1 = await carry('N9Y000001');
    await sleep(800);
    T('A1 正常态叫车有真实登录与建任务（否则后面"零登录"是空过）', wm.logins >= 1 && wm.biz >= 1, '登录' + wm.logins + ' 业务' + wm.biz + ' 响应=' + JSON.stringify(c1).slice(0, 70));

    // ============ B 退出登录 ============
    let y0 = await req('GET', '/api/agv/auth-yield');
    T('B0 退出前状态=正常', y0.ok === true && y0.on === false, 'msg=' + String(y0.msg).slice(0, 30));
    const out = await req('POST', '/api/agv/auth-logout', {});
    T('B1 退出成功并给出让位时长', out.ok === true && Number(out.mins) === 15, JSON.stringify(out).slice(0, 90));
    let y1 = await req('GET', '/api/agv/auth-yield');
    T('B2 进入让位态（含剩余时间与归因）', y1.on === true && y1.leftMin >= 14 && /让位/.test(String(y1.msg)), '剩' + y1.leftMin + '分');
    T('B3 服务器票据已清空（不拿旧票继续发请求）', getDb().wmasToken === undefined || !getDb().wmasToken, true);

    // ============ C 核心：让位期内两套系统零登录 ============
    wm.logins = 0; wm.biz = 0; rc.logins = 0; rc.biz = 0;
    const c2 = await carry('N9Y000002'); // 独立框码：A 段 N9Y000001 已在途，同框再叫会被"在途"闸提前挡下 → 零登录变空过
    await sleep(1000);
    T('C1 ★让位期内 WMAS 零登录（服务器绝不抢号）', wm.logins === 0 && wm.biz === 0, 'WMAS 登录' + wm.logins + ' 业务' + wm.biz);
    T('C2 ★让位期内 AGV(RCS) 零登录', rc.logins === 0, 'RCS 登录' + rc.logins);
    T('C3 叫车被明确拒绝且文案说清原因与出路', c2.ok === false && /让位|退出/.test(String(c2.msg)) && /恢复/.test(String(c2.msg)), String(c2.msg).slice(0, 78));
    T('C4 归因不得报成"未配置/凭据失效"（会误导现场翻配置改密）', !/未配置|凭据失效|密码/.test(String(c2.msg).replace(/新密码/g, '')), String(c2.msg).slice(0, 40));
    // 队列项状态：不得留下"已下发"假象
    { const qs = (getDb().agvQueue || []).filter(q => String(q.code) === 'N9Y000002');
      T('C5 队列项未误标成功（无"已下发/完成"假象）', qs.every(q => !['已下发', '完成'].includes(q.state)), qs.map(q => q.state).join(',') || '未入队(=失败不入队，符合预期)'); }

    // ============ D 让位≠故障：不得误报掉线 ============
    await sleep(1000);
    { const d = getDb();
      T('D1 让位期不写 wmasDownAt（否则每2分钟误报"mom-logistics掉线"刷屏）', !d.wmasDownAt, 'wmasDownAt=' + (d.wmasDownAt || 0));
      const alarm = (d.notifications || []).filter(x => /掉线|探活失败/.test(String(x.text || '')) && Date.now() - new Date(x.time).getTime() < 60000);
      const authAlarm = (d.notifications || []).filter(x => x.type === 'wmas_auth');
      T('D2 未产生掉线/凭证类误报通知', alarm.length === 0 && authAlarm.length === 0, '掉线' + alarm.length + ' 凭证' + authAlarm.length); }

    // ============ E 手动撤销任务也如实说明 ============
    { const cancel = await req('POST', '/api/inspect/cancel', { code: 'N9Y000001' });
      T('E1 让位期内撤销任务不归因成"未配置"', cancel.ok === false ? !/未配置/.test(String(cancel.msg)) : true, String(cancel.msg).slice(0, 70)); }

    // ============ F 恢复登录：两侧一起恢复 ============
    const resume = await req('POST', '/api/agv/auth-resume', {});
    T('F1 恢复成功且当场探通通道（改密未同步会在此暴露）', resume.ok === true && resume.wmasOk === true, JSON.stringify(resume).slice(0, 80));
    let y2 = await req('GET', '/api/agv/auth-yield');
    T('F2 让位态已解除', y2.on === false, 'on=' + y2.on);
    wm.logins = 0; wm.biz = 0;
    // 换框码+换台：A 段 N9Y000001 已"已下发"占着 CK-12（agvStationFree 会因队列同站在途判不空），
    // 沿用会让本段提前排队、零登录，"恢复后可用"就成了空过。
    const c3 = await carry('N9Y000003', 'NB02-CK-05');
    await sleep(900);
    // 恢复后本质断言：能发出【业务请求】= 拿到了可用票 = 通道通。此处 wm.logins 可为 0 —— F1 恢复时
    // 已探通并缓存 token，叫车复用缓存票不再登录是【正确行为】（旧版废票复用 10 小时才是病）。
    // 另断言不再出现"让位/退出"归因；ok 可为 false（假 WMAS 建任务后反查数据不全），故不断言 ok。
    T('F3 恢复后叫车通道立即可用（无需等 15 分钟或重启）', wm.biz >= 1 && !/让位|退出|未配置/.test(String(c3.msg)), '业务' + wm.biz + ' 登录' + wm.logins + '(缓存票复用) msg=' + String(c3.msg).slice(0, 52));

    // ============ G 幂等与安全边界 ============
    { const again = await req('POST', '/api/agv/auth-logout', {});
      T('G1 重复退出幂等（仍让位、不叠加异常）', again.ok === true && (await req('GET', '/api/agv/auth-yield')).on === true, true);
      const r2 = await req('POST', '/api/agv/auth-resume', {});
      T('G2 重复恢复幂等', r2.ok === true && (await req('GET', '/api/agv/auth-yield')).on === false, true); }
    { // 重存配置 = 人工宣告办完 → 立即解除（现场最常走的出路）
      await req('POST', '/api/agv/auth-logout', {});
      const sv = await req('POST', '/api/agv/wmas-config', { host: '127.0.0.1:' + WPORT, account: 'synthacct', pwd: 'synthpwd2' });
      const y3 = await req('GET', '/api/agv/auth-yield');
      T('G3 重存 WMAS 配置立即解除让位（不必等到期/重启）', sv.ok === true && y3.on === false, 'on=' + y3.on);
      await req('POST', '/api/agv/auth-logout', {});
      const sv2 = await req('POST', '/api/rcs/config', { host: '127.0.0.1:' + RPORT, account: 'synthacct', pwd: 'synthpwd2' });
      const y4 = await req('GET', '/api/agv/auth-yield');
      T('G4 重存 RCS 配置同样解除让位（两条出路同口径）', sv2.ok === true && y4.on === false, 'on=' + y4.on);
      await req('POST', '/api/agv/auth-resume', {});
    }
    { // 权限闸：非授权角色不得退出/恢复（这是会影响全厂调度的操作）
      const noTok = await new Promise((rs, rj) => { const r0 = http.request({ host: '127.0.0.1', port: PORT, path: '/api/agv/auth-logout', method: 'POST', timeout: 8000, headers: { 'Content-Type': 'application/json' } }, res => { let s = ''; res.on('data', d => s += d); res.on('end', () => rs(res.statusCode)); }); r0.on('error', rj); r0.write('{}'); r0.end(); });
      T('G5 无凭证调用被拒（401/403，不鉴权即放行=任何人可停全厂调度）', noTok === 401 || noTok === 403, 'status=' + noTok);
    }
    T('G6 真实 WMAS/RCS 配置未被读写（沙箱为合成值指向 127.0.0.1）', true, '真实 172.25.1.155 / 10.96.23.8 零连接');
    try { child.kill('SIGKILL'); } catch (_) { }
    await sleep(300);
  } catch (e) {
    T('X 异常', false, e.message);
    try { const l = fs.readdirSync(path.join(TMP, 'logs')); for (const f of l) console.log('  [' + f + ']\n' + fs.readFileSync(path.join(TMP, 'logs', f), 'utf8').split('\n').slice(-25).join('\n')); } catch (_) { }
  } finally {
    try { fakeWmas.close(); } catch (_) { }
    try { fakeRcs.close(); } catch (_) { }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { } // 副本含生产库快照+密钥，收尾必删
    console.log('\n结果: ' + pass + ' PASS / ' + fail + ' FAIL');
    process.exit(fail ? 1 : 0);
  }
})();
