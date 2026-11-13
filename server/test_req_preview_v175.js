// ㉖v175 领料预占预览回归（用户批准方案：建单填框数 → 见"将发哪几筐/实发件数"，两端共用此端点）
// 病根（用户实锤）：建单换算 件数=框数×perBoxQty(在架均值)。混框零件（同零件既有 100 件框又有
//   1000 件框，均值 550）下"要 1 框"被记成 550 件、FIFO 够不了便连发 2 筐——意图被均值吃掉，
//   签收对账与实发脱节。修法=把发料选框提前到建单：复用 pickSuggest（need=天文数→够数即停失效，
//   纯 FIFO 走完），取前 N 框＝「按 FIFO 取 N 框」真预演，件数按筐实数。
// ★核心断言：预览件数 ≠ 均值×框数（直接钉死病灶，与 FIFO 顺序无关）；且 = 所选筐实数之和。
// 依赖生产库副本（pickSuggest 需真实账本分组能力），CI 无库整份 SKIP。
'use strict';
const fs = require('fs');
const path = require('path');
const kit = require('./test_conc_kit_v172.js');

if (!fs.existsSync(path.join(__dirname, 'data', 'db.json'))) {
  console.log('⏭ SKIP test_req_preview_v175：需生产库副本（pickSuggest 依赖真实账本），CI 无库本机覆盖');
  process.exit(0);
}
const PORT = Number(process.env.RPV_PORT || 8426);
const PN = 'PVPREVIEW99';
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + String(i).slice(0, 110) + ']' : ''}`); };

(async () => {
  let h = null;
  try {
    h = await kit.startInstance({
      port: PORT, tag: 'rpv' + process.pid, upTries: 60,
      users: [{ username: 'rpv_mat', role: 'warehouse', password: 'Rp#Pass1' }],
      mutate: (d) => { // 造混框：同零件两框，实数 100(批次10-01) 与 1000(批次10-09)，均值恰=(100+1000)/2=550
        d.ledger = (d.ledger || []).filter((x) => String(x.p || '').toUpperCase() !== PN);
        d.ledger.push({ c: 'PVPV0000A1', l: 'NB03-A-01-01', q: 100, p: PN, n: '预览测试件', f: '塑料筐', b: '2026-10-01', t: Date.now() - 9 * 864e5, pid: 'PVLOT_A' });
        d.ledger.push({ c: 'PVPV0000B2', l: 'NB03-A-01-02', q: 1000, p: PN, n: '预览测试件', f: '塑料筐', b: '2026-10-09', t: Date.now() - 5 * 864e5, pid: 'PVLOT_B' });
      },
    });
    const tok = await h.login('rpv_mat', 'Rp#Pass1');
    const pv = async (items) => { const r = await h.req('GET', '/api/req/preview?items=' + encodeURIComponent(items), tok); return r.json || {}; };

    // ① 物料员（非管理员）可读——路由必须并入领料块，否则落 requireAdmin 直接 403
    const one = await pv(`${PN}:1`);
    C('★物料员可读预览（路由未落入管理员闸）', one.ok === true && Array.isArray(one.rows), 'ok=' + one.ok + ' rows=' + ((one.rows) || []).length);
    const r1 = ((one.rows) || [])[0] || {};
    const per = (r1.perBox || 0);
    C('档案均值确为 550（混框前提坐实，perBox=' + per + '）', Math.abs(per - 550) < 1, 'perBox=' + per);
    C('★要 1 框 → 实发件数=真实筐量(100或1000)，绝不再是均值 550', r1.mode === 'real' && r1.estQty !== 550 && [100, 1000].includes(r1.estQty), 'estQty=' + r1.estQty);
    C('★预览筐明细=1 筐且该筐件数=estQty（不是框数×均值）', Array.isArray(r1.boxes) && r1.boxes.length === 1 && r1.boxes[0].q === r1.estQty, JSON.stringify(r1.boxes || []).slice(0, 80));
    C('boxesReq 回显=1（前端据此判预览是否过期）', r1.boxesReq === 1, 'boxesReq=' + r1.boxesReq);

    // ② 要 2 框 → 两筐全发，合计 1100（=100+1000，均值×2=1100 恰好相等，故用筐数校验为主）
    const two = await pv(`${PN}:2`);
    const r2 = ((two.rows) || [])[0] || {};
    C('要 2 框 → 实发 1100 件 = 两筐实数之和', r2.mode === 'real' && r2.estQty === 1100 && r2.boxes.length === 2, 'estQty=' + r2.estQty + ' 筐=' + ((r2.boxes) || []).length);

    // ③ 天文数 need 修复验证：要 1 框只回 1 框（旧 bug：首框 100 件≥1×24=48 即"够数"，要 2 框也只回 1 框）
    const capTest = await pv(`${PN}:2`);
    const ct = ((capTest.rows) || [])[0] || {};
    C('★框数=2 时 pickedN=2（旧 need 传值缺陷只回 1 框，件数会算少）', ct.pickedN === 2 || (ct.boxes || []).length === 2, 'pickedN=' + ct.pickedN);

    // ④ 要 3 框（在架只 2）→ 2 框 + shortN=1，不虚报够数
    const three = await pv(`${PN}:3`);
    const r3 = ((three.rows) || [])[0] || {};
    C('在架不足：要 3 框只发 2 筐 + shortN=1（不谎报够数）', r3.mode === 'real' && (r3.boxes || []).length === 2 && r3.shortN === 1, 'picked=' + ((r3.boxes) || []).length + ' shortN=' + r3.shortN);

    // ⑤ 零在架零件 → fallback 均值折算（现行"无货仍可下单"语义不变）
    const none = await pv('PVNOSTOCK99:2');
    const rn = ((none.rows) || [])[0] || {};
    C('零在架 → mode=fallback（按均值/原值折算，仍可下单）', rn.mode === 'fallback' && Array.isArray(rn.boxes) && rn.boxes.length === 0, 'mode=' + rn.mode);

    // ⑥ 多行一次请求（性能：一次 fetch 带全部行）+ 保序
    const multi = await pv(`${PN}:1,PVNOSTOCK99:1`);
    C('★多行一次请求按序返回 2 行', (multi.rows || []).length === 2 && multi.rows[0].pn === PN && multi.rows[1].pn === 'PVNOSTOCK99', 'n=' + ((multi.rows) || []).length);

    // ⑦ 入参健壮：垃圾入参不炸（pn 空/框数 0/非数字）
    const junk = await h.req('GET', '/api/req/preview?items=' + encodeURIComponent('a:0,:3,xx:notanumber'), tok);
    C('垃圾入参安全返回（不 500）', junk.status === 200 && junk.json && junk.json.ok === true && (junk.json.rows || []).length === 0, 'status=' + junk.status);
  } catch (e) { total++; fail++; console.log('❌ 异常：' + e.message); }
  finally { if (h) { try { await h.stop(); } catch (_) {} } }
  console.log('\n结果: ' + (total - fail) + ' 通过 / ' + fail + ' 失败  （夹具副本，生产库零写入）');
  process.exit(fail ? 1 : 0);
})();
