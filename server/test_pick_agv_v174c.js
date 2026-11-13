// ㉖v174c 整合回归：count/start 双入口（点名盘指定框 → 盲区抽盘通道）
// 用户诉求：App 已有"货架AGV盲区抽盘"(v123)，点名盘点(cc61daf)要与之整合——指定框复用同一
//   双腿搬运/到台核对/钉死归位状态机。整合点全在 count/start 的 codes 分支，故直接打真实端点验：
//   ① 有效货架框 → 建单成功、挂 pickBatch、src 标注  ② 重复发起 → 点名拒绝（勿重复建单）
//   ③ 账本无此码/非货架区 → 点名拒绝（原因回传给现场看）  ④ 不传 codes → 随机路径照旧（防回归）
// 依赖生产库副本（要有真实 NB02 框），CI 无库整份 SKIP。
'use strict';
const fs = require('fs');
const path = require('path');
const kit = require('./test_conc_kit_v172.js');

if (!fs.existsSync(path.join(__dirname, 'data', 'db.json'))) {
  console.log('⏭ SKIP test_pick_agv_v174c：需生产库副本提供真实 NB02 货架框（CI 无库，本机带库时覆盖）');
  process.exit(0);
}

const PORT = Number(process.env.PAGV_PORT || 8424);
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + String(i).slice(0, 110) + ']' : ''}`); };

(async () => {
  let h = null;
  try {
    h = await kit.startInstance({ port: PORT, tag: 'pagv' + process.pid, upTries: 60, users: [{ username: 'agv_wh', role: 'warehouse', password: 'Ag#Pass1' }] });
    const tok = await h.login('agv_wh', 'Ag#Pass1');

    // 从实例账本里现取一个真 NB02 货架框（实例账本=生产库副本，必有余量）
    const led = await h.req('GET', '/api/ledger?l=NB02-', tok);
    const rows = ((led.json && led.json.items) || []).filter((x) => /^NB02-[A-H]-/.test(String(x.l || '').toUpperCase()) && !/-CK-/.test(String(x.l || '')));
    const code = rows.length ? String(rows[0].c).toUpperCase() : '';
    C('夹具实例账本里有 NB02 货架框可用', !!code, code || '空');
    if (!code) throw new Error('无可用货架框，无法继续');

    // ① 指定框发起：建单成功 + pickBatch 归集
    const batch = 'INVTEST' + Date.now();
    const s1 = await h.req('POST', '/api/count/start', tok, { codes: [code], pickBatch: batch });
    const rec1 = (((s1.json || {}).list) || [])[0];
    C('★指定框发起成功建单（ok=true）', s1.status === 200 && s1.json.ok === true && !!rec1, 'status=' + s1.status + ' picked=' + (s1.json || {}).picked);
    C('★工单挂 pickBatch 且 sid=批次号（结束任务回流靠它）', rec1 && rec1.pickBatch === batch && rec1.sid === batch, rec1 && ('sid=' + rec1.sid));
    C('★工单 src 标注点名来源', rec1 && /^pick/.test(String(rec1.src)), rec1 && rec1.src);
    C('★out 结果该框 ok', (((s1.json || {}).out) || []).some((x) => x.code === code && x.ok === true));

    // ② 重复发起：在途工单挡驾（防一框两单双叫车）
    const s2 = await h.req('POST', '/api/count/start', tok, { codes: [code], pickBatch: batch + 'B' });
    const rep = (((s2.json || {}).out) || []).find((x) => x.code === code);
    C('★同框重复发起被点名拒绝（勿重复发起）', rep && rep.ok === false && /勿重复|在途/.test(String(rep.msg)), JSON.stringify(rep));

    // ③ 账本查无 / 非货架区：各自点名拒绝
    const s3 = await h.req('POST', '/api/count/start', tok, { codes: ['NX99999999'], pickBatch: batch + 'C' });
    const nf = (((s3.json || {}).out) || []).find((x) => x.code === 'NX99999999');
    C('★账本查无的码 → 拒绝并说明（搬运无意义）', nf && nf.ok === false && /账本无|查无/.test(String(nf.msg)), JSON.stringify(nf));
    const gRows = ((await h.req('GET', '/api/ledger?l=NB03-', tok)).json.items) || [];
    const gCode = gRows.length ? String(gRows[0].c).toUpperCase() : '';
    if (gCode) {
      const s4 = await h.req('POST', '/api/count/start', tok, { codes: [gCode], pickBatch: batch + 'D' });
      const gf = (((s4.json || {}).out) || []).find((x) => x.code === gCode);
      C('★地面(NB03)框 → 拒绝并指引走人工/直扫', gf && gf.ok === false && /非高位货架|人工/.test(String(gf.msg)), JSON.stringify(gf));
    }

    // ④ 随机路径回归：不传 codes 行为如旧（ok 或"无候选"都算通道完好，且绝不报错 5xx）
    const s5 = await h.req('POST', '/api/count/start', tok, { pct: 1 });
    C('★不传 codes 随机抽盘路径不回归（200 且结构如旧）', s5.status === 200 && typeof s5.json.ok === 'boolean' && (s5.json.ok === false ? typeof s5.json.msg === 'string' : Array.isArray(s5.json.list)), 'ok=' + s5.json.ok + ' picked=' + s5.json.picked);

    // ⑤ countList 透传 pickBatch（PDA 回流过滤依赖）
    const cl = await h.req('GET', '/api/count/list?all=1', tok);
    const mine = (((cl.json || {}).list) || []).filter((q) => q.pickBatch === batch);
    C('★countList 透传 pickBatch 字段（回流过滤可行）', mine.length >= 1 && mine.every((q) => q.sid === batch), mine.length + ' 条');

    // 清理：把本次测试工单全部取消，别在实例副本里留在途单（实例即弃，但留痕干净）
    for (const q of ((((cl.json || {}).list) || []).filter((x) => x.pickBatch === batch || x.pickBatch === batch + 'B'))) {
      if (!['done', 'canceled'].includes(q.state)) await h.req('POST', '/api/count/cancel', tok, { id: q.id, reason: '测试清理' });
    }
  } catch (e) { total++; fail++; console.log('❌ 异常：' + e.message); }
  finally { if (h) { try { await h.stop(); } catch (_) {} } }
  console.log('\n结果: ' + (total - fail) + ' 通过 / ' + fail + ' 失败  （夹具副本，生产库零写入）');
  process.exit(fail ? 1 : 0);
})();
