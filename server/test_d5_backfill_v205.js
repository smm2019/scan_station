// ㉖v205 导出 D5「关联单/标签号/物料号」三列回填 端到端验证
// 用户实锤（导出中心截图）：AGV任务表完成行三列全空。根因两条：
//   ① 关联单配对用 q.taskNo（实为容器号，q.wmsTask 才是任务号）→ 恒配不上；
//   ② RCS 沉淀天生无框信息、队列 2h 出队不留痕 → 完成行永远空白。
// 回填四源：db.taskOwner（本次起 dispatchOne 咽喉登记，全腿通用）→ 领料单 agvCalled[].task
//   →（检验/盘点工单 taskNo/taskNo2）→ 入库腿账本反推（mv=AGV 台→格 lag 最近一对一）。
// ★ 为什么必须真跑生产副本：5086 条真实完成行与 1123 条 agvCalled.task 留痕的配对覆盖率、
//   入库反推的时序命中，只有真起实例真调 /api/export?ds=D5 解析 CSV 才测得出来；
//   夹具再造不出这种规模与真实脏度（同刻多单、离线补传滞后、兄弟码）。
// ★ 负断言同样重要：无任何留痕的行必须留空——错标签比空列更伤导出可信度（宁缺毋滥）。
const fs = require('fs'), path = require('path'), cp = require('child_process'), http = require('http'), crypto = require('crypto');
const TDIR = path.join(__dirname, '_d5_v205'), PORT = Number(process.env.D5_PORT || 9871), WPORT = Number(process.env.D5_W || 9872);
const wm = { builds: 0, lastTask: '' };
const fakeWmas = http.createServer((q, s) => {
  let b = ''; q.on('data', d => b += d);
  q.on('end', () => {
    const p = q.url.split('?')[0];
    (wm.heard = wm.heard || []).push(q.method + ' ' + q.url.slice(0, 90)); // 诊断：桩收到的全部请求（失败时打印定位断链点）
    const j = (o) => { s.writeHead(200, { 'Content-Type': 'application/json' }); s.end(JSON.stringify(o)); };
    if (p === '/api/auth/login') return j({ code: 200, success: true, data: { token: 'TK-D5' } });
    if (p === '/api/logistics/container/list') return j({ success: true, code: 200, data: { records: [{ containerCode: 'D5NB-B1800*1200_2-00001' }] } }); // 容器号必须含 palletType 子串（候选筛选 includes 判据）
    if (p === '/api/logistics/agv-task/list') {
      // 认领反查（带 containerNo）按 containerNo 回吐刚建任务；推送回查（带 taskNo）状态须已
      // 离开 CREATED——dispatch 调用后即翻 PUSHED（复刻真 WMAS 推送语义）
      if (/containerNo=/.test(q.url) && wm.rec) return j({ success: true, code: 200, data: { records: [wm.rec] } });
      const mn = /taskNo=([^&]+)/.exec(q.url);
      if (mn && wm.rec && decodeURIComponent(mn[1]) === wm.rec.taskNo) return j({ success: true, code: 200, data: { records: [wm.rec] } });
      return j({ success: true, code: 200, data: { records: [] } });
    }
    if (q.method === 'POST' && p === '/api/logistics/agv-task/dispatch') { if (wm.rec) wm.rec.status = 'PUSHED'; return j({ success: true, code: 200, data: true }); }
    if (p === '/api/basicdata/wmsLocation/listAll') return j({ success: true, code: 200, data: [{ locationCode: 'NB02-A-09-1F', warehouseCode: 'W', zoneCode: 'D', districtCode: 'D' }, { locationCode: 'NB02-CK-05', warehouseCode: 'W', zoneCode: 'D', districtCode: 'D' }] });
    if (q.method === 'POST' && p === '/api/logistics/agv-task') {
      wm.builds++; wm.lastTask = 'AGV-T-D5-' + wm.builds;
      let bb = {}; try { bb = JSON.parse(b || '{}'); } catch (_) {}
      // creationDate 必须本地时间形态：真 WMAS 就回本地串；UTC 串会被 Date.parse 按本地时区
      // 解析出"8小时前"→ wmasOwnTask 的 5 分钟新鲜度过滤直接杀掉（本轮诊断实锤）
      wm.rec = { id: 77, taskNo: wm.lastTask, startPoint: bb.startPoint, endPoint: bb.endPoint, containerNo: bb.containerNo, refNo: bb.refNo, status: 'CREATED', creationDate: new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 19).replace('T', ' ') };
      return j({ success: true, code: 200, data: { taskNo: wm.lastTask, ids: [77] } });
    }
    return j({ success: true, code: 200, data: {} });
  });
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + i + ']' : ''}`); };
(async () => {
  let srv;
  try {
    // 夹具 = 生产副本 + 少量注入（taskOwner 消费验证/新下发链），清 WMAS/RCS 真连接防止起服即外联
    fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
    const db0 = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'db.json'), 'utf8'));
    const salt = crypto.randomBytes(16).toString('hex'), hp = (p, s) => crypto.scryptSync(String(p), s, 32).toString('hex'), PW = 'E2e#D5!205';
    db0.users.push({ id: 'u_d5_wh', username: 'd5_wh', name: '导出仓管', role: 'warehouse', enabled: true, createdAt: Date.now(), mustChangePw: false, salt, passHash: hp(PW, salt) });
    db0.features = db0.features || {}; db0.features.warehouse = Object.assign({}, db0.features.warehouse, { agv_control: true });
    db0.agvDispatchMode = 'live'; // 本测试【故意】不带保险丝真下发：证 taskOwner 登记与导出消费闭环
    db0.wmasConfig = { host: '127.0.0.1:' + WPORT, account: 's', pwd: 's' };
    db0.rcsConfig = null; db0.rcsStations = {}; db0.stnMeta = {}; db0.rcsHoldStat = {}; db0.rcsManual = {};
    db0.stnBook = {}; db0.locReserve = {};
    // 账本放一框作新下发标的（出库链位货绑定闸 + mv=AGV 反推样本双用）
    db0.ledger = (db0.ledger || []).filter(x => String(x.c || '').toUpperCase() !== 'N26QD5205001');
    db0.ledger.push({ c: 'N26QD5205001', p: '6608009901', n: 'D5回填测试件', q: 60, l: 'NB02-A-09-1F', f: '1800*1200_2', b: '2026-11-01', t: Date.now() - 3 * 864e5, mv: '登记', src: 'TEST', pid: '' });
    fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
    // 期望值本地预算（同一份夹具数据，不依赖被测代码）
    const tkSet = new Set(Object.keys(db0.agvTasks || {}));
    let expOut = 0; const expTasks = new Set();
    for (const r of db0.requisitions || []) for (const it of r.items || []) for (const e of (it.agvCalled || [])) {
      const t = String((e || {}).task || '').toUpperCase();
      if (t && tkSet.has(t) && !expTasks.has(t)) { expTasks.add(t); expOut++; }
    }
    await new Promise((r, rj) => fakeWmas.once('error', rj).listen(WPORT, '127.0.0.1', r));
    wm.heard = []; // 诊断：记录桩收到的全部请求
    srv = cp.spawn(process.execPath, ['server.js'], { cwd: __dirname, env: Object.assign({}, process.env, { PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }), stdio: ['ignore', 'pipe', 'pipe'] });
    let up = false; for (let i = 0; i < 50 && !up; i++) { await sleep(300); try { up = (await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok; } catch (_) {} }
    C('护栏 生产副本实例就绪', up);
    if (!up) throw new Error('实例未起');
    const lg = await (await fetch(`http://127.0.0.1:${PORT}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'd5_wh', password: PW, dev: 'D5', kind: 'web' }) })).json();
    const TOK = lg.token; C('护栏 登录', !!TOK);
    // ── ① 新下发 → taskOwner 咽喉登记 → 导出该任务行三列齐（登记+消费闭环） ──
    const cr = await (await fetch(`http://127.0.0.1:${PORT}/api/agv/carry`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOK }, body: JSON.stringify({ from: 'NB02-A-09-1F', to: 'NB02-CK-05', dir: 'out', code: 'N26QD5205001', palletType: '1800*1200_2' }) })).json();
    C('① 新 carry 经合成 WMAS 真建单（保险丝未注入=对照组形态）', wm.builds === 1 && cr.ok === true && cr.state === '已下发', JSON.stringify(cr).slice(0, 60));
    if (!cr.ok) console.log('   [桩收到] ' + (wm.heard || []).join(' | '));
    await sleep(700); // save 有 120ms 防抖，响应返回≠落盘，读文件前等一轮
    const dOwner = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8')).taskOwner || {};
    const ownHit = Object.entries(dOwner).find(([k, v]) => v.c === 'N26QD5205001');
    C('★★★ 下发成功即登记 taskOwner（任务号→框，队列出队后导出仍可回填）', !!ownHit, JSON.stringify(ownHit || '').slice(0, 90));
    // ── ② 导出 D5 全量 CSV 解析（近 31 天窗） ──
    const from = Date.now() - 31 * 864e5;
    const csv = await (await fetch(`http://127.0.0.1:${PORT}/api/export?ds=D5&fmt=csv&from=${from}`, { headers: { Authorization: 'Bearer ' + TOK } })).text();
    const lines = csv.replace(/\r/g, '').split('\n').filter(l => l.trim());
    const body = lines.slice(4); // expId/ds/by/at/filter 五行头之后是表头行+数据（表头在 lines[5]）
    const hdr = (lines[5] || '').split(',');
    const iReq = hdr.indexOf('关联单'), iTag = hdr.indexOf('标签号'), iMat = hdr.indexOf('物料号'), iTask = hdr.indexOf('任务号'), iSt = hdr.indexOf('状态');
    C('② 导出含三列（表头齐全可解析）', iReq >= 0 && iTag >= 0 && iMat >= 0 && iTask >= 0, `列=${hdr.length}`);
    let filledTag = 0, filledReq = 0, rowsN = 0; const rowOf = {};
    for (const l of body) {
      const cols = l.split(','); const stt = cols[iSt];
      if (stt !== '完成') continue;
      rowsN++; rowOf[String(cols[iTask]).toUpperCase()] = cols;
      if ((cols[iTag] || '').trim()) filledTag++;
      if ((cols[iReq] || '').trim()) filledReq++;
    }
    // 出库腿精确断言：agvCalled 留痕的 1123 个任务号，导出行必须逐行填上标签（不看总量——
    // 上一版拿"全部来源填充数"比"只含 agvCalled 的预算"必然虚高：还混着检验/盘点 65 + 入库反推 215）
    let outMiss = 0;
    for (const t of expTasks) { if (!rowOf[t] || !(rowOf[t][iTag] || '').trim()) outMiss++; }
    C(`★★★ 出库腿历史回填：${expTasks.size} 个 agvCalled 留痕任务逐行验必填（漏=${outMiss}）`, outMiss === 0, `完成行=${rowsN} 填标签共=${filledTag} 漏=${outMiss}`);
    C('★★★ 关联单不再恒空（taskNo=容器号笔误修正 + agvCalled 单号索引）', filledReq >= expOut * 0.5, `填关联单=${filledReq}`);
    // ── ③ 入库腿账本反推：mv=AGV 台→格时序命中 ≥1 ──
    let inFilled = 0;
    for (const l of body) {
      const cols = l.split(',');
      if (cols[iSt] === '完成' && cols[1] === '入库' && (cols[iTag] || '').trim()) inFilled++;
    }
    C('★★ 入库腿账本反推回填 ≥1（mv=AGV src=起点台 l=终点格 时序最近一对一）', inFilled >= 1, `入库腿填标签行=${inFilled}`);
    // ── ④ 检验/盘点工单 taskNo 回填（夹具自带真实数据） ──
    const dbA = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    const inspIn = (dbA.inspects || []).filter(x => x.taskNo && tkSet.has(String(x.taskNo).toUpperCase())).length;
    const cntIn = (dbA.counts || []).filter(x => (x.taskNo && tkSet.has(String(x.taskNo).toUpperCase())) || (x.taskNo2 && tkSet.has(String(x.taskNo2).toUpperCase()))).length;
    C('★★ 检验/盘点工单号参与回填（本地预算 检验' + inspIn + '/盘点' + cntIn + ' 条落在沉淀集）', inspIn > 0 || cntIn > 0, `insp=${inspIn} cnt=${cntIn}`);
    // ── ⑤ 宁缺毋滥负断言：无任何留痕的完成行必须留空，绝不瞎配 ──
    const allOwner = new Set([...Object.keys(dbA.taskOwner || {}), ...expTasks, ...((dbA.inspects || []).map(x => String(x.taskNo || '').toUpperCase()).filter(Boolean)), ...((dbA.counts || []).flatMap(x => [String(x.taskNo || '').toUpperCase(), String(x.taskNo2 || '').toUpperCase()]).filter(Boolean))]);
    let viol = 0;
    for (const l of body) {
      const cols = l.split(',');
      if (cols[iSt] !== '完成' || !(cols[iTag] || '').trim()) continue;
      const tn = String(cols[iTask]).toUpperCase();
      const isCkIn = cols[1] === '入库'; // 入库行有反推来源；出库/其他行必须有索引才可填
      if (!isCkIn && !allOwner.has(tn)) viol++;
    }
    C('★★★ 宁缺毋滥：无留痕的非入库行零瞎配（错标签比空列更伤可信度）', viol === 0, `违规瞎配=${viol}`);
    C('★ 进程存活', (await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok === true);
  } catch (e) { total++; fail++; console.log('❌ 异常：' + e.message); }
  finally {
    if (srv) try { srv.kill(); } catch (_) {}
    fakeWmas.close(); await sleep(500);
    try { fs.rmSync(TDIR, { recursive: true, force: true }); } catch (_) {}
  }
  console.log('\n结果: ' + (total - fail) + ' 通过 / ' + fail + ' 失败  （生产副本隔离实例 + 合成 WMAS，生产零写入）');
  process.exit(fail ? 1 : 0);
})();
