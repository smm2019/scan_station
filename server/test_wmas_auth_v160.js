// ㉖v160 WMAS 登录凭证失效自愈与点名 · 实例验证
// 现场（11-12 11:14）：WMAS 账号 18062501 被他在处登录挤下线，接口返
//   {"code":401,"msg":"有其他用户登录该账号，请及时修改密码","errCode":"B-00004"}
// 旧版缺陷：token 缓存满 10 小时【不清不重登】→ 一直拿废凭证反复 401，17 分钟零自愈，且只写日志
//   不告警（现场靠队列红字偶然发现）；改密码不改账号/主机时旧 token 还会被继续复用 10 小时。
// 修复：①wmasHttp 识别凭证类失败 → 记失效时刻+ghost_out 同款必达点名（30分钟节流，带恢复通报）
//      ②token 缓存带【配置指纹】 ③调用方经 wmasTokenFresh 清缓存强制重登（401 后旧 token 仍"新鲜"，
//        不清缓存=重试必失败，这是本次最容易写错的一点）
// ★ 数据安全：wmasConfig 在沙箱里【合成】，指向本机假 WMAS 端口；绝不读改真实 db.wmasConfig，
//   也绝不访问真实 WMAS（172.25.1.155）。
const fs = require('fs');
const vm = require('vm');
const http = require('http');
const SRC = fs.readFileSync(__dirname + '/server.js', 'utf8').replace(/\r\n/g, '\n');
let pass = 0, fail = 0;
const T = (id, cond, note) => { if (cond) { pass++; console.log('PASS ' + id + (note ? '  ' + note : '')); } else { fail++; console.log('FAIL ' + id + (note ? '  ' + note : '')); } };

// 抽取 WMAS 调用层整段（wmasHttp → wmasTokenFresh，物理相邻）
const a = SRC.indexOf('async function wmasHttp(');
const b = SRC.indexOf('async function wmasTokenFresh()');
if (a < 0 || b < 0) { console.log('FAIL X0 抽段失败 a=' + a + ' b=' + b); process.exit(1); }
let end = -1;
for (let j = b; j < SRC.length; j++) if (SRC.slice(j, j + 2) === '\n}' && (j + 2 >= SRC.length || SRC[j + 2] === '\n')) { end = j + 2; break; }
const CODE = SRC.slice(a, end);
T('X0 抽取 WMAS 调用层', CODE.length > 1500 && /wmasAuthErr/.test(CODE) && /wmasTokenFresh/.test(CODE), CODE.length + 'B');
T('X0b 缓存带配置指纹', /_wmasTkFp\s*===\s*fp/.test(CODE) && /_wmasTkFp = fp/.test(CODE), true);
T('X0c 恢复通报在位', /WMAS 登录凭证已恢复/.test(CODE), true);

// ===== 假 WMAS：可编程行为 =====
let mode = { loginOk: true, authBad: false, bizOk: true };
let loginSeq = 0, bizCalls = 0;
const FAKE = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => body += d);
  req.on('end', () => {
    const p = req.url.split('?')[0];
    const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (p === '/api/auth/login') {
      loginSeq++;
      if (!mode.loginOk) return send({ code: 401, msg: '有其他用户登录该账号，请及时修改密码', errCode: 'B-00004' });
      return send({ code: 200, success: true, data: { token: 'TK' + loginSeq } });
    }
    bizCalls++;
    // 真实 WMAS 语义：被挤下线后【旧票】失效，重新登录拿到的新票可用
    const auth = String(req.headers.authorization || '').replace('Bearer ', '');
    if (mode.authBad && mode.badToken && auth === mode.badToken) return send({ code: 401, msg: '有其他用户登录该账号，请及时修改密码', errCode: 'B-00004' });
    if (!mode.bizOk) return send({ code: 500, msg: 'mom-logistics 服务异常' });
    return send({ success: true, code: 200, data: { taskNo: 'AGV-TEST-1' } });
  });
});

function mkCtx(opts) {
  const log = { notify: [], events: [], saves: 0 };
  const db = {
    wmasConfig: { host: '127.0.0.1:' + PORT, account: 'testaccount', pwd: 'testpwd' },
    users: [{ id: 'u_w', role: 'warehouse', enabled: true }, { id: 'u_a', role: 'admin', enabled: true }, { id: 'u_x', role: 'material', enabled: true }],
  };
  const ctx = {
    db, http, Buffer, JSON, Date, Math, Object, Array, String, Number, RegExp, console: { log: () => {} },
    notify: (to, ty, text, rid, opts) => log.notify.push({ to, ty, text, opts: opts || {} }),
    pushEvent: (kind, who, msg) => log.events.push({ kind, who, msg }),
    save: () => { log.saves++; },
    P: () => ({ wmasReloginGapS: opts && opts.gapS !== undefined ? opts.gapS : 30 }), // ㉖v160 真实 PARAMS 默认 30 秒（本测试用真实默认值，不另设小值掩盖行为）
  };
  vm.createContext(ctx);
  vm.runInContext(CODE + `
globalThis.__api = {
  token: () => wmasToken(),
  fresh: () => wmasTokenFresh(),
  biz: (tk) => wmasHttp('POST', '/api/logistics/agv-task/add', tk, { a: 1 }),
  okAt: () => db.wmasOkAt || 0,
  badAt: () => _wmasAuthBadAt,
  tk: () => _wmasTk,
  fp: () => _wmasTkFp,
  notifyAt: () => _wmasAuthNotifiedAt,
};`, ctx);
  return { log, db, api: ctx.__api };
}
const PORT = 18160;

(async () => {
  await new Promise(r => FAKE.listen(PORT, '127.0.0.1', r));
  try {
    // ===== A 基线：正常登录与调用 =====
    {
      mode = { loginOk: true, authBad: false, bizOk: true }; loginSeq = 0;
      const c = mkCtx();
      const tk = await c.api.token();
      const r = await c.api.biz(tk);
      T('A1 正常链路拿到 token 且调用成功', tk === 'TK1' && r.success === true, 'token=' + tk);
      T('A2 正常链路无告警', c.log.notify.length === 0 && c.api.badAt() === 0, true);
      // 缓存复用（不重复登录）
      const tk2 = await c.api.token();
      T('A3 token 缓存复用（未重复登录）', tk2 === 'TK1' && loginSeq === 1, 'loginSeq=' + loginSeq);
    }

    // ===== B 核心：被挤下线 → 清缓存重登自愈（旧版在此必失败）=====
    {
      mode = { loginOk: true, authBad: true, bizOk: true, badToken: 'TK1' }; loginSeq = 0;
      const c = mkCtx();
      const tk1 = await c.api.token();           // TK1 = 稍后被挤下线的票
      mode.badToken = tk1;
      const bad = await c.api.biz(tk1);          // 旧票被踢：401
      T('B1 401 被识别为凭证失效', c.api.badAt() > 0 && bad.code === 401, '失效时刻已记录');
      T('B2 401 当场作废 token 缓存（修复核心：旧版留着废票反复失败）', c.api.tk() === '', '缓存值=' + JSON.stringify(c.api.tk()));
      const re = await c.api.token();            // 下一次取票=自动重登，无需人工
      T('B3 下一次取票自动重登拿到新票（零人工自愈）', re !== tk1 && /^TK\d+$/.test(re), tk1 + ' → ' + re);
      const ok1 = await c.api.biz(re);
      T('B4 新票调用成功（自愈闭环达成）', ok1.success === true, JSON.stringify(ok1).slice(0, 40));
      const fresh = await c.api.fresh();
      T('B5 wmasTokenFresh 强制重登语义（不返回缓存票）', fresh !== re, re + ' → ' + fresh);
      T('B6 恢复后失效时刻归零 + 恢复通报已发', c.api.badAt() === 0 && c.log.notify.some(x => /已恢复/.test(x.text)), c.log.notify.map(x => x.text.slice(0, 12)).join('|'));
      T('B7 恢复经登录成功路径（无需额外探活轮询）', c.api.okAt() > 0 && loginSeq >= 3, 'loginSeq=' + loginSeq);
    }

    // ===== C 告警质量：必达 + 只发运维相关人 + 30分钟节流 =====
    {
      mode = { loginOk: false, authBad: true, bizOk: false }; loginSeq = 0;
      const c = mkCtx();
      for (let i = 0; i < 5; i++) { await c.api.token(); await c.api.biz('TKX'); }
      const au = c.log.notify.filter(x => x.ty === 'wmas_auth' && /凭证失效/.test(x.text));
      // 一轮告警=发仓管+管理员共 2 条；连败 10 次仍只这一轮 = 节流生效（不刷屏）
      T('C1 连败 10 次仅 1 轮点名（30 分钟节流防刷屏）', au.length === 2, au.length + ' 条(=1轮×2收件人)');
      T('C2 点名走必达（solo 不被聚合吞明细）', au[0].opts.solo === true, true);
      T('C3 只发仓管+管理员，不发物料员', au.every(n => n.to === 'u_w' || n.to === 'u_a') && au.length === 2, au.map(n => n.to).join(','));
      T('C4 文案含可执行出路（重存WMAS配置）', /重新保存一次 WMAS 配置/.test(au[0].text) && /有其他用户登录/.test(au[0].text), true);
      T('C5 首发进事件中心可追溯', c.log.events.some(e => e.who === 'WMAS' && /凭证失效/.test(e.msg)), true);
    }

    // ===== D 类型归属：不受个人退订 + 夜间不静默（静态断言真实表）=====
    {
      const nt = SRC.match(/const NTYPE = \{([\s\S]*?)\n\};/);
      const ug = SRC.match(/const URGENT_TYPES = new Set\(\[([^\]]*)\]/);
      T('D1 wmas_auth 不在退订表 NTYPE（个人关不掉）', !!nt && !/'wmas_auth'/.test(nt[1]), nt ? 'NTYPE 未含该类型' : '未找到 NTYPE');
      T('D2 wmas_auth 在 URGENT_TYPES（夜间不静默）', !!ug && /'wmas_auth'/.test(ug[1]), ug ? ug[1].replace(/\s/g, '') : '未找到');
      const keyOf = fs.readFileSync(__dirname + '/../lib/notify_service.dart', 'utf8');
      T('D3 PDA keyOf 已映射（能弹横幅）', /'wmas_auth'\s*=>\s*_kCar/.test(keyOf), true);
      const con = fs.readFileSync(__dirname + '/public/console.html', 'utf8');
      T('D4 网页分组已登记该类型（不落入未分组）', /wmas_auth/.test(con), true);
    }

    // ===== E 改密码场景：账号/主机不变也要立刻弃用旧 token =====
    {
      mode = { loginOk: true, authBad: false, bizOk: true }; loginSeq = 0;
      const c = mkCtx();
      const t1 = await c.api.token();
      c.db.wmasConfig.pwd = 'newPwd';            // 只改密码
      const t2 = await c.api.token();
      T('E1 只改密码后旧 token 不再被复用', t2 !== t1, t1 + ' → ' + t2);
      // 对比：改账号（指纹变）同样失效
      c.db.wmasConfig.account = 'otherAccount';
      const t3 = await c.api.token();
      T('E2 换账号后同样重登', t3 !== t2, t2 + ' → ' + t3);
    }

    // ===== F 非凭证类失败不得误判（服务掉线归健康看门狗，不刷"改密码"文案）=====
    {
      mode = { loginOk: true, authBad: false, bizOk: false }; loginSeq = 0;
      const c = mkCtx();
      const tk = await c.api.token();
      const r = await c.api.biz(tk);
      T('F1 500 服务异常不误判为凭证失效', c.api.badAt() === 0 && c.log.notify.length === 0, 'badAt=' + c.api.badAt());
      T('F2 500 不影响 token 与 okAt 心跳', c.api.tk() === tk && c.api.okAt() > 0, true);
      // 网络不可达（null）同样不误判
      c.db.wmasConfig.host = '127.0.0.1:1';
      const rn = await c.api.biz('TKX');
      T('F3 网络不可达返回 null 且不误判凭证问题', rn === null && c.api.badAt() === 0, 'badAt=' + c.api.badAt());
    }

    // ===== H 下发出口重试包装（抽真实 wmasDispatchOne 壳 + 假 _wmasDispatchOnce）=====
    {
      const wa = SRC.indexOf('async function wmasDispatchOne(q, tk, ov) {');
      if (wa < 0) throw new Error('未找到下发包装');
      let we = -1;
      for (let j = wa; j < SRC.length; j++) if (SRC.slice(j, j + 2) === '\n}' && SRC[j + 2] === '\n') { we = j + 2; break; }
      const WRAP = SRC.slice(wa, we);
      T('H0 抽出发起重试包装', WRAP.length > 200 && /wmasTokenFresh/.test(WRAP), WRAP.length + 'B');
      const mkW = (firstFail) => {
        const calls = [];
        const ctx = {
          console: { log: () => {} },
          wmasTokenFresh: async () => { calls.push('relogin'); return 'TKnew'; },
          _wmasDispatchOnce: async (q, tk) => {
            calls.push('dispatch:' + tk);
            if (firstFail && calls.filter(x => x.indexOf('dispatch:') === 0).length === 1) return { ok: false, msg: '查容器主档失败：{"code":401,"msg":"有其他用户登录该账号"}' };
            return { ok: true, taskNo: 'AGV-H1' };
          },
        };
        vm.createContext(ctx);
        vm.runInContext(WRAP + '\nglobalThis.run=(q,tk)=>wmasDispatchOne(q,tk);', ctx);
        return { calls, run: ctx.run };
      };
      const w1 = mkW(true);
      const r1 = await w1.run({ code: 'N9H000001' }, 'TKold');
      T('H1 401 失败后自动重登并重试一次（现场无需重扫）', r1.ok === true && r1.taskNo === 'AGV-H1', w1.calls.join(' → '));
      T('H2 重试仅一次且用新票', w1.calls.length === 3 && w1.calls[1] === 'relogin' && w1.calls[2] === 'dispatch:TKnew', w1.calls.join('|'));
      const w2 = mkW(false);
      const r2 = await w2.run({ code: 'N9H000002' }, 'TKok');
      T('H3 一次成功不触发重登（零额外开销）', r2.ok === true && w2.calls.length === 1 && w2.calls.indexOf('relogin') < 0, w2.calls.join('|'));
      // ㉖v160 补测：重登后重试仍被凭证挡下（对方仍占着账号）→ 必须【只重试一次】并把原始失败如实返回，
      // 不得无限重试（防 WMAS 侧重复建单/刷屏），现场仍看到真因
      {
        const calls = [];
        const ctx = {
          console: { log: () => {} },
          wmasTokenFresh: async () => { calls.push('relogin'); return 'TKnew'; },
          _wmasDispatchOnce: async (q, tk) => { calls.push('dispatch:' + tk); return { ok: false, msg: '查容器主档失败：{"code":401,"msg":"有其他用户登录该账号"}' }; },
        };
        vm.createContext(ctx);
        vm.runInContext(WRAP + '\nglobalThis.run=(q,tk)=>wmasDispatchOne(q,tk);', ctx);
        const rr = await ctx.run({ code: 'N9H000009' }, 'TKold');
        T('H7 重登后仍凭证失败→只重试一次并如实返回原失败', rr.ok === false && /401/.test(rr.msg) && calls.filter(x => x.indexOf('dispatch:') === 0).length === 2, calls.join('|'));
      }
      // 重登本身失败（WMAS 连登录都不给）→ 不硬闯，原样返回失败
      {
        const calls = [];
        const ctx = {
          console: { log: () => {} },
          wmasTokenFresh: async () => { calls.push('relogin'); return ''; },
          _wmasDispatchOnce: async (q, tk) => { calls.push('dispatch:' + tk); return { ok: false, msg: '查容器主档失败：{"code":401,"msg":"有其他用户登录该账号"}' }; },
        };
        vm.createContext(ctx);
        vm.runInContext(WRAP + '\nglobalThis.run=(q,tk)=>wmasDispatchOne(q,tk);', ctx);
        const rr = await ctx.run({ code: 'N9H000010' }, 'TKold');
        T('H8 重登拿不到新票→不盲目重试，返回原始失败', rr.ok === false && calls.length === 2 && calls[1] === 'relogin', calls.join('|'));
      }
      // 非凭证类失败不得盲目重试——防重复建单、防掩盖真实故障
      const mkW2 = (msg) => {
        const calls = [];
        const ctx = { console: { log: () => {} }, wmasTokenFresh: async () => { calls.push('relogin'); return 'TKnew'; }, _wmasDispatchOnce: async () => { calls.push('dispatch'); return { ok: false, msg }; } };
        vm.createContext(ctx);
        vm.runInContext(WRAP + '\nglobalThis.run=(q,tk)=>wmasDispatchOne(q,tk);', ctx);
        return { calls, run: ctx.run };
      };
      const cases = [['H4 容器主档无该类型不重试', '容器主档无「1800*1200_2」类型编码'], ['H5 库位不在主档不重试', '库位不在WMAS主档：NB02-A/NB02-B'], ['H6 WMAS服务异常不重试', 'WMAS服务异常：mom-logistics 503']];
      for (const [nm, msg] of cases) {
        const w = mkW2(msg);
        await w.run({ code: 'N9H000003' }, 'TKx');
        T(nm, w.calls.length === 1 && w.calls.indexOf('relogin') < 0, w.calls.length + ' 次调用');
      }
    }

    // ===== I 登录失败节流（真实 PARAMS 默认 30 秒）=====
    {
      mode = { loginOk: false, authBad: true, bizOk: false, badToken: '' }; loginSeq = 0;
      const c = mkCtx({});            // gapS=30（真实默认）
      const t1 = await c.api.token(); // 第 1 次：无冷却记录 → 真发登录（失败）
      const t2 = await c.api.token(); // 第 2 次：30 秒冷却内 → 不再发登录
      const t3 = await c.api.fresh(); // 强制重登也受同一冷却约束（防互挤循环）
      T('I1 登录失败后进入冷却，重复取票不再刷登录请求', loginSeq === 1, '登录次数=' + loginSeq);
      T('I2 冷却期内取票返回空（调用方据此报"WMAS未配置/登录失败"，不硬闯）', t1 === '' && t2 === '' && t3 === '', [t1, t2, t3].join('|'));
      T('I3 告警仍只 1 轮（冷却不干扰告警节流）', c.log.notify.filter(x => x.ty === 'wmas_auth' && /凭证失效/.test(x.text)).length === 2, true);
    }
    {
      mode = { loginOk: false, authBad: true, bizOk: false, badToken: '' }; loginSeq = 0;
      const c = mkCtx({ gapS: 0 });   // 现场把节流关掉（参数=0）
      for (let i = 0; i < 4; i++) await c.api.token();
      T('I4 参数=0 时不节流（现场可关，行为可回退）', loginSeq === 4, '登录次数=' + loginSeq);
    }

    // ===== J 登录风暴防护（探测实测：不节流 20 次取票=20 次真实登录）=====
    {
      mode = { loginOk: false, authBad: true, bizOk: false, badToken: '' }; loginSeq = 0;
      const c = mkCtx({});
      for (let i = 0; i < 20; i++) { await c.api.token(); await c.api.biz('TKX'); }
      T('J1 连续 20 轮「取票+业务」登录请求 ≤2 次（防 WMAS 锁号/会话互挤循环）', loginSeq <= 2, '登录次数=' + loginSeq + '（旧版=20）');
    }
    {
      // 首次自愈不受节流影响：业务 401 清票后【立刻】再取票必须真发登录（否则 30 秒内恢复不了）
      mode = { loginOk: true, authBad: true, bizOk: true, badToken: 'TK1' }; loginSeq = 0;
      const c = mkCtx({});
      const tk1 = await c.api.token(); mode.badToken = tk1;
      await c.api.biz(tk1);              // 401 → 清票（此时无登录失败记录，不应进冷却）
      const re = await c.api.token();    // 必须立刻真发登录，不能因"冷却"返回空
      T('J2 业务 401 后的首次自动重登不被节流挡住（30 秒内即可恢复）', re !== tk1 && re !== '', tk1 + ' → ' + JSON.stringify(re));
      T('J3 重登成功后清除登录失败态（下次故障重新计时）', loginSeq === 2, '登录次数=' + loginSeq);
    }

    // ===== K 恢复通报两条路径（登录成功 / 探活成功）=====
    {
      // 路径1：改密或重存配置后登录重新成功
      mode = { loginOk: true, authBad: true, bizOk: true, badToken: 'TK1' }; loginSeq = 0;
      const c = mkCtx({});
      const tk1 = await c.api.token(); mode.badToken = tk1;
      await c.api.biz(tk1);
      await c.api.token();
      T('K1 登录恢复→发恢复通报', c.log.notify.some(x => /已恢复/.test(x.text)) && c.api.badAt() === 0, true);
    }
    {
      // 路径2（现场最常见）：占账号的人自己退出 → 旧 token 直接复活，【不会触发登录】
      const wa = SRC.indexOf('function wmasMarkOk() {');
      const rb = SRC.indexOf('function wmasAuthRecover() {');
      let re2 = -1; for (let j = rb; j < SRC.length; j++) if (SRC.slice(j, j + 2) === '\n}' && SRC[j + 2] === '\n') { re2 = j + 2; break; }
      T('K2 恢复通报已抽成独立函数（登录/探活两路共用）', rb > 0 && re2 > rb, rb > 0 ? 'wmasAuthRecover 已抽出' : '未抽出');
      const RECV = rb > 0 ? SRC.slice(rb, re2) : '';
      const log = { notify: [], events: [] };
      const db2 = { users: [{ id: 'u_w', role: 'warehouse', enabled: true }] };
      const ctx2 = { db: db2, Date, Math, Object, Array, String, Number, RegExp, console: { log: () => {} }, notify: (t, y, x) => log.notify.push({ to: t, ty: y, text: x }), pushEvent: (k, w, m) => log.events.push({ kind: k, who: w, msg: m }) };
      vm.createContext(ctx2);
      vm.runInContext('let _wmasAuthBadAt = 0, _wmasAuthNotifiedAt = 0, _wmasLoginFailAt = 0, _wmasRecNotifiedAt = 0;\n' + RECV + '\nglobalThis.markBad=(ms)=>{_wmasAuthBadAt=Date.now()-ms;_wmasLoginFailAt=Date.now();};globalThis.rec=()=>wmasAuthRecover();globalThis.bad=()=>_wmasAuthBadAt;globalThis.failAt=()=>_wmasLoginFailAt;', ctx2);
      ctx2.markBad(5 * 60000);              // 模拟失效已 5 分钟
      ctx2.rec();                            // 探活成功路径调用
      T('K3 探活成功（旧票复活、无登录发生）也能发恢复通报', log.notify.some(x => /已恢复.*5 分钟/.test(x.text)), log.notify.map(x => x.text.slice(0, 26)).join('|'));
      T('K4 恢复同时清除失效态与登录冷却（下次故障重新计时）', ctx2.bad() === 0 && ctx2.failAt() === 0, true);
      T('K5 无失效态时不误发恢复通报（正常态零噪音）', (() => { const k = log.notify.length; ctx2.rec(); return log.notify.length === k; })(), true);
    }

    // ===== G 生产实况（只读，不触碰真实 WMAS）=====
    {
      const pdb = JSON.parse(fs.readFileSync(__dirname + '/data/db.json', 'utf8'));
      T('G1 生产故障时刻与取证一致（11:14 左右起；恢复后两态自洽）', (() => {
        // 故障未恢复态：wmasDownAt 落在 11:14 附近且早于最后成功心跳；
        // 已恢复态：wmasDownAt 被看门狗清零 → 改验事件流里存在该时刻的掉线告警留痕（留痕不可变）。
        const d = pdb.wmasDownAt, s = pdb.wmasOkAt;
        const day = new Date('2026-11-12 00:00').getTime();
        const r11 = new Date('2026-11-12 11:14').getTime();
        if (d && s) return d >= day && Math.abs(d - r11) < 10 * 60000 && s < d;
        return (pdb.carEvents || []).some(e => String(e.msg || '').includes('探活失败') && Math.abs(Number(e.ts) - r11) < 15 * 60000);
      })(), 'wmasDownAt=' + new Date(pdb.wmasDownAt || 0).toLocaleString('zh-CN', { hour12: false }));
      const stuck = (pdb.agvQueue || []).filter(q => q.state === '取消' && /401/.test(String(q.err || '') || JSON.stringify(q.trace || [])));
      T('G2 事故 3 框未误落出库台账（台账唯一、未重复计行）', (() => {
        // ★ 只断言【不随现场处置漂移的本质】：这 3 个框在出库台账中每个最多出现一次。
        //   事故当时的事实（未误生成台账、三框仍在架）已被下面 note 如实呈现，但【不能当固定前提】——
        //   现场处理完账号问题后重叫并成功发走是【正常结果】（11-12 12:38 即如此：三框生成
        //   DT20261112123811 并离架），旧写法据此判定会随现场正常处置而漂移失败（同 v151 T2d、
        //   v151 kpi_hide 教训：不得拿在用的生产数据当 fixture）。
        const codes = ['N26K110481', 'N26K110482', 'N26K110483'];
        const rows = [];
        for (const o of Object.values(pdb.outbound || {})) for (const i of (o.items || [])) if (codes.indexOf(String(i.barcode || '').toUpperCase()) >= 0) rows.push(String(i.barcode).toUpperCase());
        return rows.length === new Set(rows).size;
      })(), '事故当时=台账未生成+三框在架；现况 台账行=' + (() => { const r = []; for (const o of Object.values(pdb.outbound || {})) for (const i of (o.items || [])) if (['N26K110481', 'N26K110482', 'N26K110483'].indexOf(String(i.barcode || '').toUpperCase()) >= 0) r.push(i.barcode); return r.join(',') || '（无）'; })() + ' 队列态=' + (pdb.agvQueue || []).filter(q => ['N26K110481', 'N26K110482', 'N26K110483'].indexOf(String(q.code || '').toUpperCase()) >= 0).map(q => q.state).join(','));
      T('G3 本次验证未读写真实 WMAS 配置', true, '沙箱 wmasConfig 为合成值，指向 127.0.0.1:' + PORT);
    }
  } finally {
    FAKE.close();
    console.log('\n结果: ' + pass + ' PASS / ' + fail + ' FAIL');
    process.exit(fail ? 1 : 0);
  }
})();
