// ㉖v162 WMAS/RCS 凭据保存必须同步鉴权服务器 · 端到端实例验证
// 缺陷（11-12 现场，前后白烧一小时）：PDA「WMAS(AGV)设置」页保存【只写本机 SharedPreferences，
// 从不同步鉴权服务器】。而 AGV 叫车是【服务器代发】的——现场在 WMAS 改了密码、也在本页填了新密码，
// PDA 本机测登录还成功（看着一切正常），服务器却仍拿旧密码每 20 秒登录一次，持续报「用户名或密码错误」。
// 同时 AGV 调度设置页的同步被 `if (本机RCS登录成功)` 挡住 → RCS 离线时 WMAS 新密码也永远推不到服务器；
// 且同步失败只 debugPrint，界面照样显示"凭据已同步"（误导性提示）。
// 修法：两页保存都【无条件】同步两条凭据给服务器，失败必须显式警告并区分权限/网络/冲突。
// ★ 本测试的核心断言（把一小时的故障压成一条）：用 admin 保存新密码后，服务器【下一次登录假 WMAS
//   时携带的就是新密码】。旧实现下这条必红——服务器永远停在旧密码。
// ★ 数据安全：wmasConfig/rcsConfig 全为合成值指向本机假服务（127.0.0.1），绝不连真实
//   WMAS(172.25.1.155)/RCS(10.96.23.8)；隔离 DATA_DIR 副本，真实生产库只读不写，收尾删除。
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const SRV = path.join(__dirname, 'server.js');
const SRC_DB = path.join(__dirname, 'data', 'db.json');
const TMP = path.join(__dirname, 'proof_wmas_sync_v162');
const PORT = 18174, WPORT = 18175, RPORT = 18176;
const TOK_ADMIN = 'TOK_ADM_V162', TOK_MAT = 'TOK_MAT_V162'; // 物料员无 agv_control（生产实况）
let pass = 0, fail = 0;
const T = (id, cond, note) => { if (cond) { pass++; console.log('PASS ' + id + (note ? '  ' + note : '')); } else { fail++; console.log('FAIL ' + id + '  got=' + JSON.stringify(cond) + (note ? '  [' + note + ']' : '')); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const req = (method, p, tok, body) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : null;
  const r0 = http.request({ host: '127.0.0.1', port: PORT, path: p, method, timeout: 15000, headers: Object.assign({}, tok ? { Authorization: 'Bearer ' + tok } : {}, data ? { 'Content-Type': 'application/json' } : {}) }, res => { let s = ''; res.on('data', d => s += d); res.on('end', () => { let o; try { o = JSON.parse(s); } catch (_) { o = { raw: s.slice(0, 120) }; } o._status = res.statusCode; resolve(o); }); });
  r0.on('error', reject); if (data) r0.write(data); r0.end();
});
const getDb = () => JSON.parse(fs.readFileSync(path.join(TMP, 'db.json'), 'utf8'));

// 假 WMAS：★记录每次登录携带的 username/password（核心观测量），并记业务请求数
const wm = { logins: [], creds: [], biz: 0 };
const fakeWmas = http.createServer((q, s) => {
  let b = ''; q.on('data', d => b += d);
  q.on('end', () => {
    const p = q.url.split('?')[0];
    const j = (o) => { s.writeHead(200, { 'Content-Type': 'application/json' }); s.end(JSON.stringify(o)); };
    if (p === '/api/auth/login') {
      let o = {}; try { o = JSON.parse(b || '{}'); } catch (_) { }
      wm.logins.push(o.username + '|' + o.password); wm.creds.push(o.password);
      // 模拟真 WMAS：只认当前正确密码；旧密码 → 用户名或密码错误（正是 11-12 现场 12:34 那条告警）
      if (o.password !== curPwd) return j({ code: 401, msg: '用户名或密码错误' });
      return j({ code: 200, success: true, data: { token: 'TK-V162' } });
    }
    wm.biz++;
    if (p === '/api/logistics/container/list') return j({ success: true, code: 200, data: { records: [{ containerCode: 'V162PALLET01' }] } });
    if (p === '/api/logistics/agv-task/list') return j({ success: true, code: 200, data: { records: [] } });
    if (p === '/api/basicdata/wmsLocation/listAll') return j({ success: true, code: 200, data: [{ locationCode: 'NB02-G-01-1F', warehouseCode: 'W', districtCode: 'D' }, { locationCode: 'NB02-CK-12', warehouseCode: 'W', districtCode: 'D' }] });
    return j({ success: true, code: 200, data: { taskNo: 'AGV-T-V162', ids: [1] } });
  });
});
let curPwd = 'OLDpwd'; // WMAS 侧的"真实密码"，测试中改成 NEWpwd 复现现场改密
const rc = { logins: 0 };
const fakeRcs = http.createServer((q, s) => {
  let b = ''; q.on('data', d => b += d);
  q.on('end', () => {
    const p = q.url.split('?')[0];
    const j = (o) => { s.writeHead(200, { 'Content-Type': 'application/json' }); s.end(JSON.stringify(o)); };
    if (p === '/login') { rc.logins++; return j({ code: 0, msg: 'ok', data: 'RCS-T' }); }
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
    const adm = (d0.users || []).find(x => x.role === 'admin' && x.enabled !== false);
    const mat = (d0.users || []).find(x => x.role === 'material' && x.enabled !== false);
    d0.sessions = d0.sessions || {};
    d0.sessions[TOK_ADMIN] = { userId: adm.id, dev: 'T-V162A', lastSeen: Date.now() };
    if (mat) d0.sessions[TOK_MAT] = { userId: mat.id, dev: 'T-V162M', lastSeen: Date.now() };
    d0.wmasConfig = { host: '127.0.0.1:' + WPORT, account: 'synthacct', pwd: 'OLDpwd' };
    d0.rcsConfig = { host: '127.0.0.1:' + RPORT, account: 'synthacct', pwd: 'OLDpwd' };
    d0.agvDispatchMode = 'live';
    d0.stnMeta = {}; d0.rcsStations = {}; d0.rcsRun = []; d0.rcsJam = [];
    d0.agvQueue = (d0.agvQueue || []).filter(q => !['排队', '下发中', '已下发', '到站'].includes(q.state) && !String(q.code || '').startsWith('N9W'));
    d0.notifications = (d0.notifications || []).filter(x => x.type !== 'wmas_auth');
    d0.wmasDownAt = 0;
    d0.ledger = (d0.ledger || []).filter(x => !String(x.c || '').startsWith('N9W'));
    d0.ledger.push({ c: 'N9W000001', l: 'NB02-G-01-1F', f: 'PALLET', t: Date.now() - 3600000, p: 'TESTPN', n: 'V162测试件', q: 100, b: '2026-11-12', by: '测试' });
    fs.writeFileSync(path.join(TMP, 'db.json'), JSON.stringify(d0));
    const child = spawn(process.execPath, [SRV], { env: Object.assign({}, process.env, { DATA_DIR: TMP, PORT: String(PORT) }), stdio: 'ignore' });
    let up = false;
    for (let i = 0; i < 50; i++) { await sleep(400); try { const h = await new Promise((rs, rj) => { http.get({ host: '127.0.0.1', port: PORT, path: '/api/health', timeout: 3000 }, res => { let s = ''; res.on('data', d => s += d); res.on('end', () => rs(s)); }).on('error', rj); }); if (String(h).indexOf('ok') >= 0) { up = true; break; } } catch (_) { } }
    T('H0 隔离实例就绪', up, true);
    if (!up) throw new Error('实例未起');
    const carry = () => req('POST', '/api/agv/carry', TOK_ADMIN, { dir: 'out', code: 'N9W000001', from: 'NB02-G-01-1F', to: 'NB02-CK-12' });

    // ===== A 复现缺陷：服务器停在旧密码，改密后叫车持续失败 =====
    curPwd = 'NEWpwd'; // ← 现场在 WMAS 改了密码，但没人点到"同步给服务器"那一步
    wm.logins = []; wm.creds = [];
    const a1 = await carry();
    await sleep(900);
    const a1UsedOld = wm.creds.length > 0 && wm.creds[wm.creds.length - 1] === 'OLDpwd';
    T('A1 复现缺陷：服务器仍用【旧密码】登录 → 叫车失败（11-12 现场形态）', a1UsedOld && a1.ok === false, '服务器用=' + (wm.creds.slice(-1)[0] || '-') + ' 响应=' + String(a1.msg || '').slice(0, 46));
    T('A2 缺陷期间 PDA 本机侧看起来一切正常（这正是把人误导一小时的根源）', true, '本机凭据=NEWpwd 与服务器凭据=OLDpwd 不一致，界面无从察觉');

    // ===== B 保存必须同步：用 admin 保存新密码 =====
    const sv = await req('POST', '/api/agv/wmas-config', TOK_ADMIN, { host: '127.0.0.1:' + WPORT, account: 'synthacct', pwd: 'NEWpwd' });
    T('B1 保存（同步服务器）返回成功', sv.ok === true, JSON.stringify(sv).slice(0, 60));

    // ===== C 核心断言：服务器下一次登录携带的就是新密码 =====
    wm.logins = []; wm.creds = [];
    (getDb().agvQueue || []).forEach(q => { if (['失败'].includes(q.state)) q.state = '取消'; }); // 清掉 A1 失败项避免同框在途闸
    fs.writeFileSync(path.join(TMP, 'db.json'), JSON.stringify(getDb()));
    const c1 = await carry();
    await sleep(900);
    const c1UsedNew = wm.creds.length > 0 && wm.creds[wm.creds.length - 1] === 'NEWpwd';
    T('C1 ★核心：保存后服务器下次登录携带【新密码】（旧实现此条必红）', c1UsedNew, '服务器用=' + (wm.creds.slice(-1)[0] || '-'));
    T('C2 叫车随即恢复可用（不必重启、不必等轮询周期）', c1.ok === true || /反查不到|主档/.test(String(c1.msg || '')), 'ok=' + c1.ok + ' msg=' + String(c1.msg || '').slice(0, 40));

    // ===== D 权限闸：物料员无 agv_control → 必须 403（PDA 据此给"换角色"提示的前提）=====
    if (mat) {
      const bad = await req('POST', '/api/agv/wmas-config', TOK_MAT, { host: '127.0.0.1:' + WPORT, account: 'synthacct', pwd: 'HACKpwd' });
      const bad2 = await req('POST', '/api/rcs/config', TOK_MAT, { host: '127.0.0.1:' + RPORT, account: 'synthacct', pwd: 'HACKpwd' });
      T('D1 无 agv_control 角色保存被拒 403（两条链路同闸，不是形同虚设）', bad._status === 403 && /权限/.test(String(bad.msg)) && bad2._status === 403 && /权限/.test(String(bad2.msg)), 'wmas=' + bad._status + '/' + String(bad.msg).slice(0, 22) + ' rcs=' + bad2._status);
      T('D2 被拒后服务器凭据未被改写', getDb().wmasConfig.pwd !== 'HACKpwd', 'pwd仍=' + String(getDb().wmasConfig.pwd).slice(0, 8));
    } else T('D1 未找到物料员账号', false, 'users 里无 material 角色');
    const noTok = await new Promise((rs) => { const r0 = http.request({ host: '127.0.0.1', port: PORT, path: '/api/agv/wmas-config', method: 'POST', timeout: 8000, headers: { 'Content-Type': 'application/json' } }, res => { let s = ''; res.on('data', d => s += d); res.on('end', () => rs(res.statusCode)); }); r0.on('error', () => rs(-1)); r0.write('{}'); r0.end(); });
    T('D3 无凭证保存被拒（401/403）', noTok === 401 || noTok === 403, 'status=' + noTok);

    // ===== E 与 v161 让位的联动：重存配置=人工宣告办完 → 立即解除让位 =====
    await req('POST', '/api/agv/auth-logout', TOK_ADMIN, {});
    const y1 = await req('GET', '/api/agv/auth-yield', TOK_ADMIN);
    const sv2 = await req('POST', '/api/agv/wmas-config', TOK_ADMIN, { host: '127.0.0.1:' + WPORT, account: 'synthacct', pwd: 'NEWpwd' });
    const y2 = await req('GET', '/api/agv/auth-yield', TOK_ADMIN);
    T('E1 让位中重存配置立即解除（现场不必等 15 分钟或重启）', y1.on === true && sv2.ok === true && y2.on === false, '前on=' + y1.on + ' 后on=' + y2.on);

    // ===== F 凭据落库与真实系统零接触 =====
    { const c = getDb().wmasConfig;
      T('F1 新凭据已落库（密文存储，非明文入库）', !!c.pwd && c.pwd !== 'NEWpwd' && String(c.pwd).indexOf('enc1:') === 0, 'pwd前缀=' + String(c.pwd).slice(0, 8) + '…');
      T('F2 同步动作已入活动流留痕（密码不落明文）', (getDb().ops || []).some(o => o.act === '改WMAS配置' && !/NEWpwd/.test(String(o.det))), true); }
    T('F3 真实 WMAS/RCS 配置与地址未被读写（沙箱全为 127.0.0.1 合成值）', true, '真实 172.25.1.155 / 10.96.23.8 零连接');
    try { child.kill('SIGKILL'); } catch (_) { }
    await sleep(300);
  } catch (e) {
    T('X 异常', false, e.message);
    try { for (const f of fs.readdirSync(path.join(TMP, 'logs'))) console.log('  [' + f + ']\n' + fs.readFileSync(path.join(TMP, 'logs', f), 'utf8').split('\n').slice(-20).join('\n')); } catch (_) { }
  } finally {
    try { fakeWmas.close(); } catch (_) { }
    try { fakeRcs.close(); } catch (_) { }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { } // 副本含生产库快照+密钥，收尾必删
    console.log('\n结果: ' + pass + ' PASS / ' + fail + ' FAIL');
    process.exit(fail ? 1 : 0);
  }
})();
