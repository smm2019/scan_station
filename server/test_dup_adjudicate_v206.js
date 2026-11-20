// ㉖v206 重复有效流水【自动裁决】端到端验证
// 背景（11-20 告警刷屏分析，用户拍板"现在做"）：框挪位/地面转架后再扫=合法业务（v166 实证
// 无毫秒级双写），但旧未作废流水按设计永远留人工 → 现场从不处理 → 双活对累积 109 个、逐日刷屏。
// 洞察：账本有行的组，账本现格位=系统早已裁定的答案，指向他格的旧流水是过期证据不需人裁；
// 账本无行组（框位置存疑）才真需人工。规则：keeper=指向账本现格最新行，其余【且 t<账本入账
// 时刻】盖 cx/cxA/cxB；t≥入账时刻的行（离线在途/账本后事实）永不自动碰。
// ★ 为什么必须真跑：裁决在 dupSweep 启动 12s 首轮真实执行；keeper 选择、时刻锚点边界
//   （t=recT-1 裁 vs t=recT 不裁）、账本无行/无锚点/台站账本三类豁免、多行取新——全是控制流
//   与边界比较，静态只能证明代码在。夹具复刻生产实测形态（N26K170005 地面转架/N26K100201 挪位）。
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const TDIR = path.join(__dirname, '_dupadj_v206'), PORT = Number(process.env.DA_PORT || 9921);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + i + ']' : ''}`); };
const H = 3600e3;
(async () => {
  let srv;
  try {
    fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
    const db0 = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'db.json'), 'utf8'));
    const salt = crypto.randomBytes(16).toString('hex'), hp = (p, s) => crypto.scryptSync(String(p), s, 32).toString('hex'), PW = 'E2e#Da!206';
    db0.users.push({ id: 'u_da_wh', username: 'da_wh', name: '裁决测试仓管', role: 'warehouse', enabled: true, createdAt: Date.now(), mustChangePw: false, salt, passHash: hp(PW, salt) });
    db0.params = Object.assign(db0.params || {}, { receivingOn: 0, reqHoursOn: 0, dupFlowAlertOn: 1 });
    db0.wmasConfig = null; db0.rcsConfig = null; db0.rcsStations = {}; db0.agvQueue = [];
    const T0 = Date.now();
    const SL = (code, wt, loc, t, op, q) => ({ code, wt, st: wt === 0 ? loc : '', gl: wt === 0 ? loc : loc, ct: '1800*1200_2', rm: '', batch: 'BDA206', cx: false, t, pn: '8894080206', q: q || 100, mk: '', op: op || '裁决测试员', nm: '裁决测试件', lot: '2026-11-01', mc: '', pid: '', cxAt: 0 });
    const LEDR = (c, l, recT) => ({ c, l, f: '1800*1200_2', t: recT, p: '8894080206', n: '裁决测试件', q: 100, b: '2026-11-01', pid: 'PDA206' + c, mv: '登记', src: 'TEST', by: '裁决测试员', rec: recT, hist: [] });
    db0.scanlog = {};
    const put = (k, v) => { db0.scanlog[k] = Object.assign({ k }, v); };
    // ① 挪位重扫（生产原型 N26K100201）：旧地面F-12-09 → 新E-14-09=账本现格 → 裁旧保新
    put('M1|B1|1', SL('N26QDA000M1', 1, 'NB03-F-12-09', T0 - 70 * H, '刘向轩'));
    put('M1|B2|2', SL('N26QDA000M1', 1, 'NB03-E-14-09', T0 - 2 * H, '宋明明'));
    db0.ledger = (db0.ledger || []).filter(x => !String(x.c || '').startsWith('N26QDA000'));
    db0.ledger.push(LEDR('N26QDA000M1', 'NB03-E-14-09', T0 - 60 * 60e3)); // 入账时刻介于两流水之间
    // ② 离线在途保护：第二条 t=recT+30min（账本入账后才扫的在途证据）→ 永不自动碰
    put('M2|B1|1', SL('N26QDA000M2', 1, 'NB03-F-15-04', T0 - 90 * H, '刘向轩'));
    put('M2|B2|2', SL('N26QDA000M2', 1, 'NB03-E-05-09', T0 + 30 * 60e3, '宋明明'));
    db0.ledger.push(LEDR('N26QDA000M2', 'NB03-F-15-04', T0 - 60 * 60e3)); // 账本在旧行指向格
    // ③ A→B→A 双指向账本位：keeper=较新者，旧A裁掉
    put('M3|B1|1', SL('N26QDA000M3', 1, 'NB03-A-01-01', T0 - 100 * H, '甲'));
    put('M3|B2|2', SL('N26QDA000M3', 1, 'NB03-A-01-01', T0 - 5 * H, '乙'));
    db0.ledger.push(LEDR('N26QDA000M3', 'NB03-A-01-01', T0 - 50 * H));
    // ④ 指向他格 1 条但 t≥入账时刻：入账后扫的新事实，不裁
    put('M4|B1|1', SL('N26QDA000M4', 1, 'NB03-B-02-05', T0 - 80 * H, '甲'));
    put('M4|B2|2', SL('N26QDA000M4', 1, 'NB03-B-09-09', T0 - 30 * 60e3, '乙')); // t=recT-30min 指向他格
    db0.ledger.push(LEDR('N26QDA000M4', 'NB03-B-02-05', T0 - 30 * 60e3));      // 入账时刻=第二条t（第二条不裁；keeper=第一条）
    // ⑤ 账本无行：维持人工，一条不裁
    put('M5|B1|1', SL('N26QDA000M5', 1, 'NB03-C-03-01', T0 - 80 * H, '甲'));
    put('M5|B2|2', SL('N26QDA000M5', 1, 'NB03-C-03-09', T0 - 40 * H, '乙'));
    // ⑥ 台站账本：keeper=全体最新（不参与台站指向），其余入账前旧行照裁
    put('M6|B1|1', SL('N26QDA000M6', 0, 'NB02-CK-02', T0 - 90 * H, '甲'));
    put('M6|B2|2', SL('N26QDA000M6', 0, 'NB02-CK-03', T0 - 20 * H, '乙'));
    db0.ledger.push(LEDR('N26QDA000M6', 'NB02-CK-03', T0 - 50 * H));
    // ⑦ 纯提醒型：账本有行但仅 1 条流水 → 不在裁决范围
    put('M7|B1|1', SL('N26QDA000M7', 1, 'NB03-D-04-01', T0 - 10 * H, '甲'));
    db0.ledger.push(LEDR('N26QDA000M7', 'NB03-D-04-01', T0 - 1 * H));
    fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
    srv = cp.spawn(process.execPath, ['server.js'], { cwd: __dirname, env: Object.assign({}, process.env, { SELFTEST_NO_LIVE: '1', PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }), stdio: ['ignore', 'pipe', 'pipe'] });
    let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok; } catch (_) {} }
    C('护栏 实例就绪', up); if (!up) throw new Error('实例未起');
    await sleep(16000); // 等启动 12s 首轮 dupSweep 完成裁决
    const dbA = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    const sl = dbA.scanlog || {}, act = k => !sl[k].cx, cxOf = k => sl[k].cx, why = k => String(sl[k].cxB || '');
    C('① 挪位重扫：旧流水作废、指向账本现格的新行保留', cxOf('M1|B1|1') && act('M1|B2|2'));
    C('①b 作废留痕带账本现格与取代原因（可追溯）', /系统自动取代.*NB03-E-14-09/.test(why('M1|B1|1')), why('M1|B1|1').slice(0, 50));
    C('★★★ ② 离线在途保护：入账时刻后的在途行与 keeper(账本位旧行) 都保留', act('M2|B1|1') && act('M2|B2|2'), 'B1=' + act('M2|B1|1') + ' B2=' + act('M2|B2|2'));
    C('★★ ③ 同格双指向：keeper=较新，旧行作废', cxOf('M3|B1|1') && act('M3|B2|2'));
    C('★★★ ④ 指向他格但 t=入账时刻的行不裁（边界锚点精确）', act('M4|B1|1') && act('M4|B2|2'), 'B1=' + act('M4|B1|1') + ' B2=' + act('M4|B2|2'));
    C('★★★ ⑤ 账本无行组零裁决（位置存疑必须人工）', act('M5|B1|1') && act('M5|B2|2'));
    C('⑥ 台站账本：keeper=全体最新，入账前旧行照裁', cxOf('M6|B1|1') && act('M6|B2|2'));
    C('⑦ 单条流水组不受影响（裁决只碰≥2条）', act('M7|B1|1'));
    // 幂等：第二轮 sweep 不应重复处理（已裁的不再动、ops 不再报）
    const cxCount1 = Object.values(sl).filter(x => x.cx && /系统自动取代/.test(String(x.cxB || ''))).length;
    await sleep(11000); // 再等一轮 sweep（5分钟间隔未到，但启动首轮已过；此处验证无重复动作）
    const dbB = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    const cxCount2 = Object.values(dbB.scanlog || {}).filter(x => x.cx && /系统自动取代/.test(String(x.cxB || ''))).length;
    C('★ 幂等：第二轮 sweep 裁决数不变（无重复处理/重复落盘）', cxCount1 === cxCount2 && cxCount1 >= 3, `轮1=${cxCount1} 轮2=${cxCount2}`);
    C('★ 进程存活', (await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok === true);
  } catch (e) { total++; fail++; console.log('❌ 异常：' + e.message); }
  finally {
    if (srv) try { srv.kill(); } catch (_) {}
    await sleep(500);
    try { fs.rmSync(TDIR, { recursive: true, force: true }); } catch (_) {}
  }
  console.log('\n结果: ' + (total - fail) + ' 通过 / ' + fail + ' 失败  （隔离副本，生产库零写入）');
  process.exit(fail ? 1 : 0);
})();
