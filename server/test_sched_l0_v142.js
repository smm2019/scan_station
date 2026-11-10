// ㉖v142 L0 调度观测地基 · 实例证明（正确性优先）
// 三项观测：①等待分位数（含秒发0值，修正现有 stat 的 v>0 过滤致 p50 虚高）②节流计数器（真实时长口径，防 pollSec=3 秒按轮次放大6~20倍）③车辆健康分（近7天 carEvents 聚合，扣分+原始计数并列）。
// 证法：纯函数段(quantile/schedBlock*/schedCarHealth)用可控时钟 new Function 注入做确定性断言；端到端起隔离实例验 /api/agv/schedstats 三源聚合。
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const SRC = path.join(__dirname, 'data');
let fail = 0, total = 0;
const chk = (n, g, w) => { total++; const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL!'} [${n}] got=${String(JSON.stringify(g)).slice(0, 200)} want=${String(JSON.stringify(w)).slice(0, 200)}`); };
const chkT = (n, g, diag) => { total++; if (!g) fail++; console.log(`${g ? 'PASS' : 'FAIL!'} [${n}]${g ? '' : ' ' + String(diag || '').slice(0, 180)}`); };

// ===== 抽取纯函数段（从 _schedPruneAt 到 buildFunnel 之前），注入 db 与可控 Date =====
const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const s0 = src.indexOf('let _schedPruneAt = 0;');
const s1 = src.indexOf('function buildFunnel');
chkT('Z0 纯函数段边界定位成功', s0 > 0 && s1 > s0, `s0=${s0} s1=${s1}`);
const code = src.slice(s0, s1);
const make = new Function('db', 'Date', code + '\nreturn {schedBlockMark,schedBlockClose,schedBlockPrune,schedBlockAgg,schedCarHealth,quantile};');

// ===== Q组 quantile 正确性 =====
{
  const db = {}; let CLOCK = 1700000000000; const A = make(db, { now: () => CLOCK });
  chk('Q1 空数组返0', A.quantile([], 0.5), 0);
  chk('Q2 单元素返自身', A.quantile([7], 0.9), 7);
  const dist = [0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 5, 5, 5, 5, 5, 10, 10, 10, 10, 10];
  chk('Q3 p50 线性插值(含0值=3)', A.quantile(dist, 0.5), 3);   // idx9.5→1+(5-1)*.5=3
  chk('Q4 p90=10', A.quantile(dist, 0.9), 10);
  chk('Q5 p99=10', A.quantile(dist, 0.99), 10);
  chk('Q6 偶数中位插值', A.quantile([1, 2, 3, 4], 0.5), 2.5);
}

// ===== B组 节流计时：真实时长口径 + 防重复 + 归类 + 清理 =====
{
  const db = {}; let CLOCK = 1300000; const A = make(db, { now: () => CLOCK });
  const q = {};
  A.schedBlockMark(q, 1000000);
  chk('B1 首次打点记起点', q.blockSince, 1000000);
  A.schedBlockMark(q, 2000000);
  chk('B2 重复打点不移动起点(防每轮刷新致时长恒=一轮)', q.blockSince, 1000000);
  q.blockRsn = '巷道并发'; q.blockKey = 'NB02-E-12';
  A.schedBlockClose(q, 1300000); // dur=(1300000-1000000)/1000=300秒
  chk('B3 放行结算真实时长300秒入桶', [db.schedBlock.length, db.schedBlock[0].sec, db.schedBlock[0].n], [1, 300, 1]);
  chk('B4 结算后起点清零', q.blockSince, 0);
  A.schedBlockClose(q, 1400000); // blockSince=0 → no-op
  chk('B5 无起点再结算不重复计数', db.schedBlock.length, 1);
  const q2 = {}; A.schedBlockMark(q2, 5000); A.schedBlockClose(q2, 5000); // dur=0
  chk('B6 同轮放行0秒不计(防瞬时抖动灌桶)', db.schedBlock.length, 1);
  // 关键：模拟 100 个 3 秒调度轮次持续被挡，只在最后放行结算一次 → n 必须=1（非100），证真实时长非轮次
  const q3 = { blockRsn: '巷道并发', blockKey: 'NB02-A-09' };
  A.schedBlockMark(q3, 2000000);
  for (let i = 1; i <= 100; i++) A.schedBlockMark(q3, 2000000 + i * 3000); // 每轮重复打点（应被忽略）
  A.schedBlockClose(q3, 2000000 + 100 * 3000); // 300秒后放行
  const b3 = db.schedBlock.find((x) => x.key === 'NB02-A-09');
  chk('B7 100轮持续被挡→单段300秒 n=1 非100(轮次膨胀防护)', [b3.n, b3.sec], [1, 300]);
  // 归类：站台类不进 byAisle
  const q4 = { blockRsn: '无空闲台', blockKey: '站台' };
  A.schedBlockMark(q4, 1000); A.schedBlockClose(q4, 61000); // 60秒
  const ag = A.schedBlockAgg(14);
  chk('B8 byAisle 仅含 NB02- 巷道(站台类排除)', ag.byAisle.map((x) => x.k).sort(), ['NB02-A-09', 'NB02-E-12']);
  chkT('B9 byRsn 含 无空闲台 与 巷道并发', ['无空闲台', '巷道并发'].every((r) => ag.byRsn.some((x) => x.k === r)), JSON.stringify(ag.byRsn));
  // 清理过期
  db.schedBlock.push({ hr: CLOCK - 31 * 864e5, key: 'NB02-Z-99', rsn: '巷道并发', n: 1, sec: 10, max: 10 });
  A.schedBlockPrune(CLOCK);
  chk('B10 超30天桶被清理', db.schedBlock.some((x) => x.key === 'NB02-Z-99'), false);
}

// ===== C组 车辆健康分：分类 + 扣分 + 排除WMAS/超窗 =====
{
  const db = {}; let CLOCK = 1700000000000; const A = make(db, { now: () => CLOCK });
  const t = CLOCK - 864e5; // 1天前，在7天窗内
  db.carEvents = [
    ...[0, 1, 2, 3, 4].map(() => ({ ts: t, kind: '告警', who: 'AGV07', msg: '🚨 AGV07 车辆告警：通讯断开|错误:车辆网络连接异常' })),
    ...[0, 1].map(() => ({ ts: t, kind: '急停', who: 'AGV08', msg: '急停按下' })),
    ...[0, 1, 2].map(() => ({ ts: t, kind: '堵点', who: 'AGV06', msg: '被卡超3分钟：交管区域13' })),
    ...[0, 1, 2, 3].map(() => ({ ts: t, kind: '告警', who: 'AGV05', msg: '低电量 12%' })),
    ...[0, 1, 2, 3, 4, 5].map(() => ({ ts: t, kind: '告警', who: 'AGV04', msg: '🚨 AGV04 车辆告警：错误:车辆内部' })),
    { ts: t, kind: '告警', who: 'WMAS', msg: 'WMAS 调度服务探活失败' }, // 非车，排除
    { ts: CLOCK - 8 * 864e5, kind: '告警', who: 'AGV07', msg: '通讯断开' }, // 超7天，排除
  ];
  const cars = A.schedCarHealth();
  const find = (id) => cars.find((c) => c.id === id) || {};
  chk('C1 仅统计车辆(WMAS排除、超窗排除)=5辆', cars.length, 5);
  chk('C2 AGV07 通讯5次 comm=5', find('AGV07').comm, 5);
  chk('C3 AGV07 扣分 100-5*3=85', find('AGV07').score, 85);
  chk('C4 AGV08 急停2 estop=2 扣10', [find('AGV08').estop, find('AGV08').score], [2, 90]);
  chk('C5 AGV06 堵点3 jam=3 扣6', [find('AGV06').jam, find('AGV06').score], [3, 94]);
  chk('C6 AGV05 低电4 lowBat=4 扣6', [find('AGV05').lowBat, find('AGV05').score], [4, 94]);
  chk('C7 AGV04 一般错误6 err=6 扣6', [find('AGV04').err, find('AGV04').score], [6, 94]);
  chk('C8 排序按分数升序(最差在前)', cars[0].id, 'AGV07');
}

// ===== D组 聚合单位换算（分钟口径正确，防 sec/6 放大10倍类 bug）=====
{
  const db = {}; let CLOCK = 1700000000000; const A = make(db, { now: () => CLOCK });
  const hr = Math.floor(CLOCK / 3600000) * 3600000;
  db.schedBlock = [
    { hr, key: 'NB02-E-12', rsn: '巷道并发', n: 4, sec: 600, max: 300 },
    { hr, key: 'NB02-D-07', rsn: '巷道并发', n: 1, sec: 120, max: 120 },
  ];
  const ag = A.schedBlockAgg(14);
  const e12 = ag.byAisle.find((x) => x.k === 'NB02-E-12');
  chk('D1 巷道E-12 平均分钟=600/4/60=2.5', e12.avgMin, 2.5);
  chk('D2 巷道E-12 总分钟=600/60=10', e12.totMin, 10);
  chk('D3 巷道E-12 最大分钟=300/60=5', e12.maxMin, 5);
  const hc = ag.byRsn.find((x) => x.k === '巷道并发');
  chk('D4 原因汇总 巷道并发 n=5 总分钟=(600+120)/60=12', [hc.n, hc.totMin], [5, 12]);
}

// ===== E组 端到端：隔离实例 /api/agv/schedstats 三源聚合 =====
(async () => {
  const TDIR = path.join(__dirname, '_tmp_v142');
  fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
  fs.copyFileSync(path.join(SRC, 'db.json'), path.join(TDIR, 'db.json'));
  fs.copyFileSync(path.join(SRC, 'secret.key'), path.join(TDIR, 'secret.json').replace('.json', '.key'));
  const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
  const salt = crypto.randomBytes(16).toString('hex'); const hashPw = (pw, s) => crypto.scryptSync(String(pw), s, 32).toString('hex');
  const now = Date.now();
  db0.users = [{ id: 'u_w', username: 'v142_wh', name: '观测仓管', role: 'warehouse', enabled: true, createdAt: now, mustChangePw: false, salt, passHash: hashPw('V142#Wh!', salt) }];
  db0.params = Object.assign(db0.params || {}, { pollSec: 3 });
  delete db0.rcsConfig; delete db0.wmasConfig; db0.agvDispatchMode = 'dry';
  // 纯净夹具：requisitions 只留一条含 20 个叫车样本（queue 分钟 0×5,1×5,5×5,10×5）
  const base = Math.floor(now / 1000) * 1000 - 2 * 864e5;
  const mins = [0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 5, 5, 5, 5, 5, 10, 10, 10, 10, 10];
  db0.requisitions = [{ id: 'rq_s', no: 'LLV142', status: 'done', createdAt: new Date(base).toISOString(), items: [{ partNo: '66SQ', qty: 100, agvCalled: mins.map((m, i) => ({ c: 'SQ' + String(i).padStart(4, '0'), t: new Date(base).toISOString(), sent: base, disp: base + m * 60000 })) }] }];
  db0.agvQueue = [];
  // 节流桶 + 车辆事件（与 C/D 同分布，证接口用真实函数）
  const hr = Math.floor(now / 3600000) * 3600000;
  db0.schedBlock = [
    { hr, key: 'NB02-E-12', rsn: '巷道并发', n: 4, sec: 600, max: 300 },
    { hr, key: '站台', rsn: '无空闲台', n: 2, sec: 240, max: 120 },
    { hr, key: 'NB02-D-07', rsn: '巷道并发', n: 1, sec: 120, max: 120 },
  ];
  const ct = now - 864e5;
  db0.carEvents = [
    ...[0, 1, 2, 3, 4].map(() => ({ ts: ct, kind: '告警', who: 'AGV07', msg: '通讯断开|错误:车辆网络连接异常' })),
    ...[0, 1].map(() => ({ ts: ct, kind: '急停', who: 'AGV08', msg: '急停按下' })),
    ...[0, 1, 2].map(() => ({ ts: ct, kind: '堵点', who: 'AGV06', msg: '被卡超3分钟' })),
    ...[0, 1, 2, 3].map(() => ({ ts: ct, kind: '告警', who: 'AGV05', msg: '低电量 12%' })),
    ...[0, 1, 2, 3, 4, 5].map(() => ({ ts: ct, kind: '告警', who: 'AGV04', msg: '错误:车辆内部' })),
    { ts: ct, kind: '告警', who: 'WMAS', msg: '探活失败' },
  ];
  fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
  const PORT = 8372, BASE = 'http://127.0.0.1:' + PORT;
  const uncaught = [];
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stderr.on('d', (b) => { const s = String(b); if (/uncaught|Error|异常/.test(s)) uncaught.push(s); });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const req = async (p, opt, tk) => { const r = await fetch(BASE + p, { headers: tk ? { Authorization: 'Bearer ' + tk } : {}, ...(opt || {}) }); return await r.json(); };
  try {
    await sleep(1200);
    const lg = await req('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'v142_wh', password: 'V142#Wh!' }) });
    const tk = lg.token;
    chkT('E0 登录成功', !!tk, JSON.stringify(lg).slice(0, 120));
    const j = await req('/api/agv/schedstats?days=14', null, tk);
    chkT('E1 schedstats 返回 ok', j.ok === true, JSON.stringify(j).slice(0, 150));
    // queue 含0分位数（若沿用旧 stat v>0 过滤，n 会=15、p50 会=5；此处 n=20、p50=3 证修正生效）
    chk('E2 等待样本含秒发20个(旧口径会只剩15)', j.queue.n, 20);
    chk('E3 p50=3(含0值，旧口径会虚高到5)', j.queue.p50, 3);
    chk('E4 p90=10 p99=10', [j.queue.p90, j.queue.p99], [10, 10]);
    chk('E5 等待均值=4', j.queue.avg, 4);
    // block 聚合
    const e12 = (j.block.byAisle || []).find((x) => x.k === 'NB02-E-12');
    chkT('E6 byAisle 含 NB02-E-12 且 totMin=10', e12 && e12.totMin === 10, JSON.stringify(j.block.byAisle));
    chkT('E7 站台类不进 byAisle(归类正确)', !(j.block.byAisle || []).some((x) => x.k === '站台'), JSON.stringify(j.block.byAisle));
    chkT('E8 byRsn 含 无空闲台 totMin=4', (j.block.byRsn || []).some((x) => x.k === '无空闲台' && x.totMin === 4), JSON.stringify(j.block.byRsn));
    // cars
    const a7 = (j.cars || []).find((c) => c.id === 'AGV07');
    chkT('E9 车辆健康分 AGV07 comm5 score85', a7 && a7.comm === 5 && a7.score === 85, JSON.stringify(a7));
    chkT('E10 WMAS 不进车辆榜', !(j.cars || []).some((c) => c.id === 'WMAS'), JSON.stringify((j.cars || []).map((c) => c.id)));
    chkT('E11 服务无未捕获异常', uncaught.length === 0, uncaught.join('\n').slice(0, 160));
  } catch (e) { console.log('ERR', e.stack); fail += 2; total += 2; }
  finally { try { srv.kill('SIGKILL'); } catch (_) {} fs.rmSync(TDIR, { recursive: true, force: true }); }

  // ===== F组 源码锚点（接线与关键逻辑在位）=====
  {
    const sv = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    chkT('F1 schedstats 路由在位', /\/api\/agv\/schedstats/.test(sv), '');
    chkT('F2 排队样本 _q 标记(含0口径)', /s\._q = true/.test(sv), '');
    chkT('F3 queue 用 qPct 含0分位而非 stat', /queue: qPct/.test(sv), '');
    chkT('F4 等待分位过滤含 >=0', /s\._q && s\.queue >= 0/.test(sv), '');
    chkT('F5 拦截三处打点 schedBlockMark', (sv.match(/schedBlockMark\(q, nowMs\);/g) || []).length === 3, (sv.match(/schedBlockMark\(q, nowMs\);/g) || []).length);
    chkT('F6 放行闭合 schedBlockClose', /if \(q\.blockSince\) schedBlockClose\(q, nowMs\)/.test(sv), '');
    chkT('F7 终态回收闭合(防起点泄漏)', /if \(q\.blockSince\) schedBlockClose\(q, Date\.now\(\)\)/.test(sv), '');
    chkT('F8 三拦截点 blockKey 归类显式设置', /q\.blockKey = '站台'/.test(sv) && /q\.blockKey = '指定台'/.test(sv), '');
    chkT('F9 节流桶低频滚动清理接线', /schedBlockPrune\(nowMs\)/.test(sv), '');
    const html = fs.readFileSync(path.join(__dirname, 'public', 'console.html'), 'utf8');
    chkT('F10 观测子页三处注册(NAV/SUB/KEY)', /\['ops','🏭 调度运作',\['pipe','q','obs'\]\]/.test(html) && /obs:'🔍 调度观测'/.test(html) && /obs:\['ops','obs'\]/.test(html), '');
    chkT('F11 loadObs 消费 schedstats 三源', /async function loadObs/.test(html) && /api\('\/api\/agv\/schedstats/.test(html) && /j\.queue|Q=j\.queue/.test(html) && /j\.block|B=j\.block/.test(html) && /j\.cars|CS=j\.cars/.test(html), '');
    chkT('F12 分派分支挂 obs', /leaf=='obs'\)\{B\.innerHTML=LD;loadObs\(\)/.test(html), '');
  }

  console.log(`\n===== v142 L0 调度观测实例证明 ${total - fail}/${total} PASS =====`);
  process.exit(fail ? 1 : 0);
})();
