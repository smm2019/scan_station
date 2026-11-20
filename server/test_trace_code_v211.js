// ㉖v211 出库/流水接口按框码精确过滤（过滤先于截断）端到端验证
// 背景：全链路兜底路径（服务器 trace 主路径不可用时才跑）原先无过滤全量拉回再端上筛——
//   /api/outbound 时间倒序砍前 500、/api/scanlog limit=2000。生产库实测：出库单 1771、流水 4438，
//   最老出库框 N26H030146（10-23）的出库单倒序排名 1770 —— 老框的出库/采集节点在兜底路径整段隐身。
// 修复：两端接口各加 c= 精确过滤（c 与既有 pn/f/from 同款，排在 slice/limit 之前），兜底路径带上标签查询。
//   主路径 /api/trace 本就是全表遍历无截断（v210 汇报时我误把主路径也说成有盲区，此处更正：盲区仅兜底路径）。
// ★ 真跑理由：①"c= 过滤是否排在 slice(0,500) 之前"静态看顺序都像对的，写错位置完全无效，
//   必须在 >500 单真库上证明老单能透出来；②分号多码拆开比对是新逻辑，要真验漏配；
//   ③无 c= 时逐字零回归（列表页/网页消费方不受影响）是兼容契约。
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const TDIR = path.join(__dirname, '_tracecode_v211'), PORT = Number(process.env.HS_PORT || 9937);
const BASE = 'http://127.0.0.1:' + PORT;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + String(i).slice(0, 130) + ']' : ''}`); };
const getj = async (p2, tk) => { const r = await fetch(BASE + p2, { headers: tk ? { Authorization: 'Bearer ' + tk } : {} }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
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
    if (probe === 'busy') throw new Error('端口 ' + PORT + ' 被占用——用 HS_PORT=其他端口 重跑');
    // 生产库真实副本（1771 单 > 500、4438 流水 > 2000，测试前提即真实规模）
    const db0 = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'db.json'), 'utf8'));
    const salt = crypto.randomBytes(16).toString('hex'), PW = 'E2e#Hs!211';
    db0.users.push({ id: 'u_hs_tc_adm', username: '追溯测试管理', name: '追溯测试管理', role: 'admin', enabled: true, createdAt: Date.now(), mustChangePw: false, salt, passHash: crypto.scryptSync(PW, salt, 32).toString('hex') });
    db0.wmasConfig = null; db0.rcsConfig = null;
    fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
    // 样本选取（离线自算，不依赖服务端）：出库单在时间倒序排名 ≥500 的老框 = 盲区真实样本
    const obs = Object.values(db0.outbound || {}).sort((a, x) => (x.createdAt || 0) - (a.createdAt || 0));
    const rankOf = (orderNo) => [...obs].reverse().findIndex((o) => o.orderNo === orderNo);
    let OLD = null, OLD_N = 0, OLD_RANK = 0;
    for (const o of obs) {
      const rk = rankOf(o.orderNo);
      if (rk >= 500) { const bc = String((o.items || [])[0]?.barcode || '').toUpperCase().split(/[;；]/)[0].trim(); if (bc) { OLD = bc; OLD_N = obs.filter((x) => (x.items || []).some((i) => String(i.barcode || '').toUpperCase().includes(bc))).length; OLD_RANK = rk; break; } }
    }
    C('护栏 存在盲区样本（有框出库单排名≥500）', !!OLD, '框=' + OLD + ' 排名=' + OLD_RANK);
    if (!OLD) throw new Error('数据中无排名≥500的出库框，测试失去前提');
    // 注入"一托多码"分号串样本（独立新码 T211MULTI01;T211SIB01，只存在于注入行，断言不被原始数据蒙混）
    // ⚠️ 首版夹具把注入写在落盘之后 → 服务器看不到，②④假失败（测试 bug 非产品 bug，修正顺序）
    const inj = obs[obs.length - 1]; // 最新单（排名0），与 OLD（排名≥500）互补覆盖两端
    inj.items = (inj.items || []).concat([{ code: 'T211PART', barcode: 'T211MULTI01;T211SIB01', qty: 111, name: '多码注入' }]);
    fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
    srv = cp.spawn(process.execPath, ['server.js'], { cwd: __dirname, env: Object.assign({}, process.env, { SELFTEST_NO_LIVE: '1', PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }), stdio: ['ignore', 'pipe', 'pipe'] });
    process.on('exit', killTree);
    let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(600) })).ok; } catch (_) {} }
    C('护栏 实例就绪', up); if (!up) throw new Error('实例未起');
    const login = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: '追溯测试管理', password: PW, dev: 'TC', kind: 'pda' }) });
    const tk = (await login.json()).token;
    C('护栏 管理员登录', !!tk); if (!tk) throw new Error('登录失败');
    // ① 核心：c= 过滤后老框出库单透出（旧路径拿不到，排名' + OLD_RANK + '）
    const r1 = await getj('/api/outbound?c=' + OLD, tk);
    const items1 = r1.json.items || [];
    C('★★★ ① c= 过滤后可见该框全部出库单（'+OLD_N+' 单，旧路径因排名'+OLD_RANK+'被截）',
      items1.length >= OLD_N && items1.length === r1.json.count, '接口=' + items1.length + ' 基准≥' + OLD_N);
    // ② 多码分号串：注入行 barcode="T211MULTI01;T211SIB01"（独立新码，原始数据绝无）——
    //    任一段单独查都须命中（拆开比对生效；"整串相等"写法两段全会漏配）
    const rMul = await getj('/api/outbound?c=T211MULTI01', tk);
    C('★★★ ② 一托多码分号串前段单独命中（整串相等会漏配的场景）', (rMul.json.items || []).length >= 1, 'items=' + (rMul.json.items || []).length);
    const rSib = await getj('/api/outbound?c=T211SIB01', tk);
    C('★★ ② 兄弟码同样命中（拆分后任一段可查）', (rSib.json.items || []).length >= 1);
    // ③ 无 c= 零回归：仍恰好 500 条
    const r0 = await getj('/api/outbound', tk);
    C('★★ ③ 不传 c 行为不变（500 条上限，列表页零回归）', (r0.json.items || []).length === 500);
    // ④ c= 与 pn= 可叠加（AND 语义，供未来"框+件"双条件）
    // ④ c+pn 叠加=AND：注入行框码+零件号同单 → 命中 1；框与件不同单（OLD 与 T211PART）→ 正确返空
    const rBoth = await getj('/api/outbound?c=T211MULTI01&pn=T211PART', tk);
    const rXor = await getj('/api/outbound?c=' + OLD + '&pn=T211PART', tk);
    C('★ ④ c+pn 叠加为 AND（同单命中1/跨单返空）', (rBoth.json.items || []).length === 1 && (rXor.json.items || []).length === 0,
      '同单=' + (rBoth.json.items || []).length + ' 跨单=' + (rXor.json.items || []).length);
    // ⑤ scanlog c= 过滤在 limit 之前：老框流水条数少但必须透出（limit=1 时若无过滤会只剩最新框）
    const oldScan = Object.values(db0.scanlog || {}).filter((s) => String(s.code || '').toUpperCase() === OLD);
    const rSl = await getj('/api/scanlog?limit=1&c=' + OLD, tk);
    C('★★★ ⑤ 流水 limit=1 + c= 精确命中该框（证明过滤先于 limit；该框流水'+oldScan.length+'条）',
      (rSl.json.items || []).length >= 1 && (rSl.json.items || []).every((x) => String(x.code || '').toUpperCase() === OLD), 'items=' + (rSl.json.items || []).length);
    // ⑥ 未知框返回空不报错
    const rNone = await getj('/api/outbound?c=ZZ_NOT_EXIST_9999', tk);
    C('★★ ⑥ 未知框返回空集不报错', (rNone.json.items || []).length === 0);
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
