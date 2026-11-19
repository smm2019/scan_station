// ㉖v202 备料排队看板·AGV 异常上卡（用户：看板增加 agv 错误信息和持续时间）
// queueBoardOf 聚合验证：①活跃被挡(blockRsn+blockSince)→头部 agvBlocked 计数+最堵原因+最长时长
// ②单级 agvIssue 按 reqId 关联(一单多框取卡最久) ③失败项 err→kind=fail ④反证:完成/无挡正常排队不误报
// 隔离 DATA_DIR + 独立端口，生产库零写入。
const fs = require('fs'), path = require('path'), crypto = require('crypto'), cp = require('child_process');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + i + ']' : ''}`); };
(async () => {
  const TDIR = path.join(__dirname, '_tdata_qagv202');
  const PORT = Number(process.env.QA_PORT || (9850 + Math.floor(Math.random() * 40)));
  fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
  const salt = crypto.randomBytes(16).toString('hex');
  const mkU = (id, un, nm, role) => ({ id, username: un, name: nm, role, enabled: true, createdAt: new Date().toISOString(), mustChangePw: false, salt, passHash: crypto.scryptSync('Qa#202', salt, 32).toString('hex') });
  const now = Date.now(), MIN = 60000;
  const iso = (ms) => new Date(ms).toISOString();
  const d0 = {
    users: [mkU('u_a', 'qa_a', '看板测试', 'admin'), mkU('u_w', 'qa_w', '仓管', 'warehouse')],
    features: {}, sessions: {}, devices: {}, ops: [], exports: [], inventories: [], ledger: [], scanlog: {}, outbound: {}, carEvents: [], ledgerTomb: [], inspects: [],
    requisitions: [
      { id: 'rqA', no: 'LL-A', by: 'u_w', byName: '张三', status: 'pending', createdAt: iso(now - 2 * 60 * MIN), items: [{ partNo: 'P1', qty: 10, issued: [] }], history: [] },
      { id: 'rqB', no: 'LL-B', by: 'u_w', byName: '李四', status: 'accepted', createdAt: iso(now - 60 * MIN), acceptedAt: iso(now - 50 * MIN), acceptedBy: '王仓', items: [{ partNo: 'P2', qty: 10, issued: [] }], history: [] },
      { id: 'rqC', no: 'LL-C', by: 'u_w', byName: '王五', status: 'accepted', createdAt: iso(now - 40 * MIN), acceptedAt: iso(now - 35 * MIN), acceptedBy: '王仓', items: [{ partNo: 'P3', qty: 10, issued: [] }], history: [] },
    ],
    agvQueue: [
      // rqB 两个框被挡：无空闲台(90分最久) + 巷道节流(20分) → 单级取最久的"无空闲台"
      { code: 'BXB1', fromLoc: 'NB02-C-01-1F', reqId: 'rqB', reqNo: 'LL-B', by: '李四', state: '排队', at: now - 95 * MIN, updAt: now - 2 * MIN, blockRsn: '无空闲台', blockKey: '站台', blockSince: now - 90 * MIN },
      { code: 'BXB2', fromLoc: 'NB02-C-02-1F', reqId: 'rqB', reqNo: 'LL-B', by: '李四', state: '排队', at: now - 25 * MIN, updAt: now - 2 * MIN, blockRsn: '巷道并发', blockKey: 'NB02-C-0', blockSince: now - 20 * MIN },
      // rqC 叫车下发失败 → kind=fail, rsn=err, min=距updAt
      { code: 'BXC1', fromLoc: 'NB02-C-03-1F', reqId: 'rqC', reqNo: 'LL-C', by: '王五', state: '失败', err: 'AGV任务在WMAS查无记录', at: now - 40 * MIN, updAt: now - 30 * MIN },
      // 反证1：rqA 正常排队叫车（无 blockRsn）→ 不误报 agvIssue
      { code: 'BXA1', fromLoc: 'NB02-C-09-1F', reqId: 'rqA', reqNo: 'LL-A', by: '张三', state: '排队', at: now - 10 * MIN, updAt: now - 10 * MIN },
      // 反证2：rqA 已完成叫车 → 不计入
      { code: 'BXA2', fromLoc: 'NB02-C-10-1F', reqId: 'rqA', reqNo: 'LL-A', by: '张三', state: '完成', at: now - 100 * MIN, updAt: now - 80 * MIN },
    ],
  };
  fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(d0));
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch('http://127.0.0.1:' + PORT + '/api/health')).ok; } catch (_) {} }
  let out = ''; srv.stdout.on('data', (d) => { out += d; }); srv.stderr.on('data', (d) => { out += d; });
  try {
    const tk = up && (await (await fetch('http://127.0.0.1:' + PORT + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'qa_a', password: 'Qa#202' }) })).json()).token;
    C('护栏 启动+登录', up && !!tk, '');
    const j = await (await fetch('http://127.0.0.1:' + PORT + '/api/requisitions/queue', { headers: { Authorization: 'Bearer ' + tk } })).json();
    const b = j.board || {};
    const near = (a, lo, hi) => typeof a === 'number' && a >= lo && a <= hi;
    const byId = {}; (b.items || []).forEach((x) => { byId[x.id] = x; });
    C('T0 看板返回含异常字段(新结构)', j.ok === true && 'agvBlocked' in b && 'agvWorstRsn' in b && 'agvBlockedMaxMin' in b, 'keys=' + ['agvBlocked', 'agvWorstRsn', 'agvBlockedMaxMin'].filter((k) => k in b).join(','));
    // 头部：2 个活跃被挡(rqB 两框), 最堵=无空闲台 90分, 失败rqC 不计入被挡数
    C('T1 ★★★ 头部 agvBlocked=2(仅活跃被挡,失败/完成/无挡正常排队都不计)', b.agvBlocked === 2, 'agvBlocked=' + b.agvBlocked);
    C('T2 ★★★ 头部 agvWorstRsn=无空闲台 + 最长≈90分', b.agvWorstRsn === '无空闲台' && near(b.agvBlockedMaxMin, 88, 92), 'worst=' + b.agvWorstRsn + ' max=' + b.agvBlockedMaxMin);
    // 单级：rqB 取两框里卡最久的(无空闲台90分, 非巷道20分)
    const ib = byId['rqB'] && byId['rqB'].agvIssue;
    C('T3 ★★★ 单级 rqB.agvIssue=最久那条(无空闲台 block ≈90分,非巷道并发20分)', ib && ib.kind === 'block' && ib.rsn === '无空闲台' && near(ib.min, 88, 92), JSON.stringify(ib));
    // 失败态：rqC kind=fail rsn=err min≈30
    const ic = byId['rqC'] && byId['rqC'].agvIssue;
    C('T4 ★★★ 单级 rqC.agvIssue=失败(kind=fail, rsn=WMAS查无记录, ≈30分)', ic && ic.kind === 'fail' && /WMAS查无记录/.test(ic.rsn) && near(ic.min, 28, 32), JSON.stringify(ic));
    // 反证：rqA 正常排队(无挡)+完成 → agvIssue=null 不误报
    const ia = byId['rqA'] && byId['rqA'].agvIssue;
    C('T5 ★★★ 反证：正常排队/已完成叫车不误报(rqA.agvIssue 空)', ia == null, JSON.stringify(ia));
    // 活跃数 agvActive：非完成取消失败 = rqB两框+rqA正常排队 = 3（失败rqC不计）
    C('T6 agvActive=3(失败项不计活跃)', b.agvActive === 3, 'agvActive=' + b.agvActive);
    C('★ 无未捕获异常', !/Unhandled|TypeError: |ReferenceError/.test(out), out.split('\n').slice(-2).join(' ').slice(0, 80));
  } catch (e) { total++; fail++; console.log('❌ 异常：' + e.message); } finally {
    try { srv.kill(); } catch (_) {}
    await sleep(400); try { srv.kill('SIGKILL'); } catch (_) {}
    try { fs.rmSync(TDIR, { recursive: true, force: true }); } catch (_) {}
  }
  console.log('\n结果: ' + (total - fail) + ' 通过 / ' + fail + ' 失败  （隔离副本，生产库零写入）');
  process.exit(fail ? 1 : 0);
})();
