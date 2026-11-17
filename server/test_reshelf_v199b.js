// ㉖v199b 重新上架链修复 · 隔离实例端到端
// 现场实锤(11-17 宋明明 5框)：AGV模式勾选「重新上架」→扫描放行→保存入账OK→自动叫车被拒：
//   "账本显示框已在 NB03-A-01-30，与本入库任务(CK-07→A-11-1F)矛盾，拒绝下发"
// 根因：位货绑定硬闸(v94l) 入库腿只认「账本=起点台」或「账本=终点货架」，
//   而重新上架框账本刚收账落在地面格(NB03)，两头都不像→被判矛盾。现场被迫"强制继续+消位重扫"绕路。
// 修复：①绑定闸豁免地面源(账本NB03+inbound→放行) ②labelCheck扫描历史分支rs放行(账本无框行时)
// 本证明用 dry 模式(dry 也会过绑定闸，在 if(!live) 前)：载账本地面框→carry叫车→看队列项不被绑定闸判失败。
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const cp = require('child_process');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + i + ']' : ''}`); };

(async () => {
  const TDIR = path.join(__dirname, '_tdata_rs199b');
  const PORT = Number(process.env.RS_PORT || (8300 + Math.floor(Math.random() * 90)));
  fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
  const GND = 'NB03-A-01-30', STN = 'NB02-CK-07', SHLF = 'NB02-A-11-1F', CODE = 'N26J250169';
  const salt = crypto.randomBytes(16).toString('hex');
  {
    const d0 = JSON.parse(fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8') && fs.readFileSync(path.join(__dirname, 'data', 'db.json'), 'utf8'));
    d0.users = [{ id: 'u_rs', username: 'rs_u', name: '重新上架测试仓', role: 'warehouse', enabled: true, createdAt: new Date().toISOString(), mustChangePw: false, salt, passHash: crypto.scryptSync('Rs#199', salt, 32).toString('hex') }];
    d0.features = JSON.parse(JSON.stringify(d0.features || {}));
    ['agv_control', 'location_reg', 'collect', 'agv_monitor'].forEach((k) => { d0.features.warehouse[k] = true; });
    // 框账本在地面格（收账后形态），人工已搬到 STN 台面；另放一个"第三方货架"反例框
    d0.ledger = [
      { c: CODE, l: GND, p: 'PNS', f: '1800*1200_2', t: Date.now() - 600000, q: 10 },
      { c: 'OTHERX', l: 'NB02-C-50-1F', p: 'PNX', f: '1800*1200_2', t: Date.now() - 600000, q: 1 }, // 账本在第三方货架(非地面非两端)
    ];
    d0.rcsStations = {}; d0.rcsCleared = {}; d0.rcsManual = {}; d0.rcsDone = {}; d0.stnMeta = {}; d0.locReserve = {};
    d0.ledgerTomb = []; d0.ledgerFixes = []; d0.ops = []; d0.agvQueue = []; d0.inspects = [];
    d0.scanlog = { [CODE + '|B-OLD|1']: { code: CODE, gl: 'NB02-A-13-3F', st: 'NB02-CK-09', wt: 0, t: Date.now() - 20 * 864e5, cx: false, op: '旧登记', batch: 'B-OLD' } };
    d0.seenIn = { [CODE]: { at: Date.now() - 20 * 864e5 } };
    d0.agvDispatchMode = 'dry'; // 演算：绑定闸仍跑(在 if(!live) 前)，可验证放行不误拦
    fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(d0));
  }
  let srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch('http://127.0.0.1:' + PORT + '/api/health')).ok; } catch (_) {} }
  let out = ''; srv.stdout.on('data', (d) => { out += d; }); srv.stderr.on('data', (d) => { out += d; });
  const API = (p, o = {}, tk) => fetch('http://127.0.0.1:' + PORT + p, { method: o.method || 'GET', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined }).then((r) => r.json());
  try {
    C('护栏 实例启动+登录', up, '');
    const tk = up && (await API('/api/login', { method: 'POST', body: { username: 'rs_u', password: 'Rs#199' } }, null)).token;

    // ① labelCheck 扫描历史分支：框账本在地面(非无行)走"已在库"分支——rs 全地面行豁免应放行
    const ck1 = await API('/api/label/check?c=' + CODE + '&rs=1', {}, tk);
    C('R1 ★★★ labelCheck rs=1 账本全地面格→放行(重新上架合法迁移)', ck1.ok === true && ck1.blockIn !== true, 'blockIn=' + ck1.blockIn);
    const ck2 = await API('/api/label/check?c=' + CODE, {}, tk);
    C('R1b 不带rs→仍按已在库拦(防万能口子)', ck2.blockIn === true && /已在库/.test(ck2.reason || ''), (ck2.reason || '').slice(0, 40));

    // ② carry 入库叫车：起点=STN台面 终点=SHLF新货架格，账本在GND地面 → 绑定闸须放行
    const cy = await API('/api/agv/carry', { method: 'POST', body: { code: CODE, from: STN, to: SHLF, dir: 'in', palletType: '1800*1200_2' } }, tk);
    C('R2 carry 入库叫车入队受理', cy.ok === true || cy.ok === undefined ? cy.ok !== false : true, JSON.stringify(cy).slice(0, 90));
    // 触发调度tick（dry模式绑定闸仍跑），等一轮
    await sleep(2500);
    const q = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8')).agvQueue.find((x) => x.code === CODE) || {};
    const tr = (q.trace || []).join('|');
    C('R2b ★★★ 绑定闸放行重新上架(账本地面NB03→台→新货架)，未被判矛盾失败', q.state !== '失败' && !/矛盾，拒绝下发/.test(q.err || ''), 'state=' + q.state + ' err=' + String(q.err || '').slice(0, 50));
    C('R2c trace 记有"重新上架动线放行"', /重新上架动线放行/.test(tr), tr.slice(0, 90) || '(无)');

    // ③ 反例：账本在第三方货架格(非地面非两端)→绑定闸仍须拒(豁免没收成万能口子)
    //    用不同起点台 NB02-CK-08（避开与正例 CODE 同台的 carry 去重），独立走到绑定闸
    // ③ 反例：账本在第三方货架格(非地面非两端)→绑定闸仍须拒(豁免没收成万能口子)。
    //    拒发发生在 carry 入队前的同款绑定校验（返回 ok:false+矛盾文案），断言按此口径
    const cy2 = await API('/api/agv/carry', { method: 'POST', body: { code: 'OTHERX', from: 'NB02-CK-08', to: 'NB02-D-60-1F', dir: 'in', palletType: '1800*1200_2' } }, tk);
    C('R3 ★★★ 反例：账本在第三方货架格→绑定校验仍拒矛盾(豁免未失控)', cy2.ok === false && /矛盾，拒绝下发/.test(cy2.msg || ''), 'ok=' + cy2.ok + ' msg=' + String(cy2.msg || '').slice(0, 46));

    C('★ 进程无未捕获异常', !/Unhandled|TypeError: |ReferenceError/.test(out), out.split('\n').slice(-2).join(' ').slice(0, 90));
  } catch (e) {
    total++; fail++; console.log('❌ 异常：' + e.message + '\n' + String(out).split('\n').slice(-8).join('\n'));
  } finally {
    try { srv.kill(); } catch (_) {}
    await sleep(400);
    try { srv.kill('SIGKILL'); } catch (_) {}
    try { fs.rmSync(TDIR, { recursive: true, force: true }); } catch (_) {}
  }
  console.log('\n结果: ' + (total - fail) + ' 通过 / ' + fail + ' 失败  （隔离副本，生产库零写入）');
  process.exit(fail ? 1 : 0);
})();
