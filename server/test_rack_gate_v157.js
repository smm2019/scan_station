// ㉖v157 返架在途互斥闸 · 端到端实例验证
// 背景（11-11 18:24 刘向轩 N26K100034）：发料→退回（复挂在架+联动自动返架叫车）→6 秒后再扫发料全程放行
// → 账面已出库转 MES、AGV 却仍往货架送（返架任务后被外部取消 st=6，实物去向成谜）。
// 全库 8 例同类。闸口径（用户拍板：在途返架撤销不了）：硬拦，排队态引导撤销、已下发引导等上架；
// 应急登记可旁路但强制 hpush+异常事件双留痕；返架队列项零触碰（撤销是人的决定）。
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const SRV = path.join(__dirname, 'server.js');
const SRC = path.join(__dirname, 'data', 'db.json');
const TMP = path.join(__dirname, 'proof_rackgate_v157');
const PORT = 18157, VT = 'TESTTOK_V157';
let fail = 0, total = 0;
const T = (n, a, b) => { total++; const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) { fail++; console.log('FAIL ' + n + '  got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); } else console.log('PASS ' + n); };
const rq = (p, body) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : null;
  const r0 = http.request({ host: '127.0.0.1', port: PORT, path: p, method: body ? 'POST' : 'GET', timeout: 15000, headers: Object.assign({ Authorization: 'Bearer ' + VT }, data ? { 'Content-Type': 'application/json' } : {}) }, res => { let s = ''; res.on('data', d => s += d); res.on('end', () => { try { resolve(JSON.parse(s)); } catch (_) { resolve({ raw: s.slice(0, 120) }); } }); });
  r0.on('error', reject); if (data) r0.write(data); r0.end();
});
const getDb = () => JSON.parse(fs.readFileSync(path.join(TMP, 'db.json'), 'utf8'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const NOW = Date.now();
const RQNO = 'LLTESTV1570001';
const PN = '6608069999';
const C_RKQ = 'N9V100001'; // 返架[排队]中的框
const C_RKS = 'N9V100002'; // 返架[已下发]中的框
const C_OK = 'N9V100003'; // 正常在架框
const C_FIN = 'N9V100004'; // 返架[完成]的框（应放行）
const C_RKQ2 = 'N9V100005'; // 第二张[排队]返架框（W7 指引闭环专用，避开"已扫过"闸）
const mkLed = (c, l) => ({ c, l, f: '筐', t: NOW - 3600000, p: PN, n: 'V157测试件', q: 200, b: '2026-11-10', by: '测试' });
const mkRk = (code, state, id) => ({ id, code, fromLoc: 'NB02-CK-10', stationManual: 'NB02-C-01-1F', station: '', palletType: '1800*1200_2', type: 'inbound', manualOnly: true, ref: 'RK-' + code, reqNo: RQNO, by: '测试', state, at: NOW - 60000, updAt: NOW - 30000, trace: [] });

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true }); fs.mkdirSync(path.join(TMP, 'logs'), { recursive: true });
  fs.copyFileSync(SRC, path.join(TMP, 'db.json'));
  const sk = path.join(__dirname, 'data', 'secret.key'); if (fs.existsSync(sk)) fs.copyFileSync(sk, path.join(TMP, 'secret.key'));
  const d0 = getDb();
  const wh = (d0.users || []).find(x => x.role === 'admin' && x.enabled !== false) || (d0.users || []).find(x => x.role === 'warehouse' && x.enabled !== false);
  d0.sessions = d0.sessions || {}; d0.sessions[VT] = { userId: wh.id, dev: 'TEST-V157', lastSeen: Date.now() };
  // 宇宙隔离：清 N9V 残留
  d0.ledger = (d0.ledger || []).filter(x => !String(x.c || '').startsWith('N9V'));
  d0.agvQueue = (d0.agvQueue || []).filter(q => !String(q.code || '').startsWith('N9V'));
  d0.requisitions = (d0.requisitions || []).filter(r => String(r.no || '') !== RQNO);
  // 测试单：accepted、单行应发 200（放行用例发 C_OK 后不触发"已发齐"复杂度——C_FIN 用例行已发齐但它是行内已扫过? 不，C_FIN 未扫过 → 超发通道只在 overOk=1 或 leftBoxes；C_FIN 不在 leftBoxes/_allow → strictFifo 先拦？
  // 为避免 FIFO 白名单干扰 C_FIN/C_RKQ 的判定焦点，本行带 agvCalled=四码（白名单含"本单已叫车码"，全程可扫）
  d0.requisitions.push({
    id: 'rq_v157', no: RQNO, by: '测试申请人', status: 'accepted', createdAt: new Date(NOW - 7200000).toISOString(),
    toLoc: { WAREHOUSE_NAME: '线边仓' },
    items: [{
      partNo: PN, itemName: 'V157测试件', qty: 800, issued: [], agvCalled: [{ c: C_RKQ }, { c: C_RKS }, { c: C_OK }, { c: C_FIN }, { c: C_RKQ2 }],
    }],
    history: [],
  });
  d0.ledger.push(mkLed(C_RKQ, 'NB02-C-01-1F'), mkLed(C_RKS, 'NB02-C-02-1F'), mkLed(C_OK, 'NB02-C-03-1F'), mkLed(C_FIN, 'NB02-C-04-1F'), mkLed(C_RKQ2, 'NB02-C-05-1F'));
  d0.agvQueue.push(mkRk(C_RKQ, '排队', 'cq_v157a'), mkRk(C_RKS, '已下发', 'cq_v157b'), mkRk(C_FIN, '完成', 'cq_v157c'), mkRk(C_RKQ2, '排队', 'cq_v157d'));
  d0.params = Object.assign({}, d0.params, { strictFifo: 0 }); // FIFO 关：焦点=返架闸，排除批次白名单干扰
  fs.writeFileSync(path.join(TMP, 'db.json'), JSON.stringify(d0));
  const child = spawn(process.execPath, [SRV], { env: Object.assign({}, process.env, { DATA_DIR: TMP, PORT: String(PORT) }), stdio: 'ignore' });
  try {
    let up = false;
    for (let i = 0; i < 40; i++) { await sleep(500); try { const h = await new Promise((rs, rj) => { http.get({ host: '127.0.0.1', port: PORT, path: '/api/health', timeout: 3000 }, res => { let s = ''; res.on('data', d => s += d); res.on('end', () => rs(s)); }).on('error', rj); }); if (String(h).indexOf('ok') >= 0) { up = true; break; } } catch (_) { } }
    T('H0 隔离实例就绪', up, true);
    const scan = (barcode, extra) => rq('/api/requisitions/rq_v157/scan', Object.assign({ partNo: PN, barcode, qty: 200 }, extra || {}));
    // W1 返架[排队]中 → 拦
    let r = await scan(C_RKQ);
    T('W1a 排队态返架在途→拒绝发料', r.ok, false);
    T('W1b 文案给撤销指引(点名返架路线与状态)', /返架任务在途/.test(String(r.msg || '')) && /NB02-CK-10→NB02-C-01-1F/.test(String(r.msg || '')) && /排队/.test(String(r.msg || '')), true);
    // W2 返架[已下发]中 → 拦 + 文案引导等上架
    r = await scan(C_RKS);
    T('W2 已下发态同样拦截且引导等上架', r.ok === false && /撤销不了/.test(String(r.msg || '')) && /等它上完架/.test(String(r.msg || '')), true);
    // W3 正常框 → 放行
    r = await scan(C_OK);
    T('W3a 无返架任务框正常放行', r.ok, true);
    // W4 返架[完成]（货已回架）→ 放行
    r = await scan(C_FIN);
    T('W4 返架完成框可再发（上完架重扫=正常）', r.ok, true);
    // W5 应急旁路：拦得住也跑得掉，双留痕
    r = await scan(C_RKQ, { emergency: true, why: '产线急用先撤返架人工处理' });
    T('W5a 应急登记可旁路', r.ok, true);
    { let d = getDb();
      for (let i = 0; i < 25; i++) { // 轮询等异步落盘（save 防抖；条件必须先取 issued 数组再 some，旧写法空数组恒真=零等待）
        d = getDb();
        const _it = ((d.requisitions.find(x => x.no === RQNO) || {}).items || []).find(i => i.partNo === PN) || {};
        if ((Array.isArray(_it.issued) ? _it.issued : []).some(e => e.c === C_RKQ)) break;
        await sleep(500);
      }
      const it = ((d.requisitions.find(x => x.no === RQNO) || {}).items || []).find(i => i.partNo === PN) || {};
      T('W5b 应急发料已入账', (it.issued || []).some(e => e.c === C_RKQ && e.e === 1), true);
      T('W5c 工单历史留痕点名返架未闭环', (d.requisitions.find(x => x.no === RQNO).history || []).some(e => /返架在途框应急旁路/.test(String(e.text || ''))), true);
      T('W5d 异常事件表落表', (d.carEvents || []).some(e => String(e.kind || '') === '返架在途应急发料' && String(e.who || '') === C_RKQ), true);
    }
    // W6 返架队列项零触碰（撤销与否是人的决定）
    { const d = getDb();
      const a = d.agvQueue.find(q => q.id === 'cq_v157a'), b2 = d.agvQueue.find(q => q.id === 'cq_v157b');
      T('W6 被拦/旁路全程未改返架队列项状态', a && a.state === '排队' && b2 && b2.state === '已下发', true);
    }
    // W7 事故复演：被拦→按引导撤排队返架→重扫成功（用 C_RKQ2，避开"已扫过"闸干扰）
    { r = await scan(C_RKQ2); T('W7a 排队返架框被拦', r.ok === false && /返架任务在途/.test(String(r.msg || '')), true);
      // 走真实撤销接口（外部改 db.json 会被服务内存态下次落盘覆盖）：排队项未下发可直接取消
      const r2 = await rq('/api/agv/queue/cancel', { codes: [C_RKQ2] });
      T('W7b1 排队返架经真实接口撤销', r2.ok === true && r2.cancelled === 1, true);
      await sleep(1200); // 等落盘
      r = await scan(C_RKQ2);
      T('W7b2 撤销排队返架后重扫成功（文案指引闭环）', r.ok, true);
    }
  } finally {
    try { child.kill('SIGKILL'); } catch (_) { }
    await sleep(300);
    // 收尾必删隔离数据目录：内含生产库副本 + secret.key，留在仓库有泄露与被误提交风险
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { }
    console.log('\n===== v157 返架在途互斥闸端到端：' + (total - fail) + '/' + total + (fail ? ' FAIL ' + fail : ' 全过') + ' =====');
    process.exit(fail ? 1 : 0);
  }
})();
