// ㉖v175b 产线模板「原地编辑」回归（用户诉求：保存后可再编辑、加/减零件、改框数，公共模板按需改）
// 地基验证：编辑最终靠 POST /api/req-templates 带 id 原地更新母本（v62 已具备）。本次纯 UI 解锁
//   （PDA/网页编辑弹层从"只改名"升级为"可增删行+改框数"），端点零改动。此测把编辑语义钉死防回归：
//   ① 带 id 编辑=原地更新同一 id（不是新建副本），items 行数可增可减  ② 使用计数 use 编辑后保留
//   ③ 越权：他人（非 owner 非 admin）带 id 编辑 → 403  ④ 共享置 true 后他人可见（公共模板），
//   但他人只能载入另存、改不动母本（→ 各自 fork 后编辑，互不影响）  ⑤ 空 items/21行/不存在id 拒绝。
// 空库实例即可跑（不依赖生产库），CI 可跑。
'use strict';
const kit = require('./test_conc_kit_v172.js');
const PORT = Number(process.env.TPL_PORT || 8437);
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + String(i).slice(0, 100) + ']' : ''}`); };
const mkItems = (n, off = 0) => Array.from({ length: n }, (_, i) => ({ partNo: 'TPLP' + String(off + i).padStart(6, '0'), itemName: '模板件' + (off + i), qty: i + 1 }));
const find = (list, id) => (list || []).find((x) => String(x.id) === String(id));

(async () => {
  let h = null;
  try {
    h = await kit.startInstance({ port: PORT, tag: 'tpl' + process.pid, seedMode: 'empty', upTries: 60 });
    const tokA = await h.login('admin', 'admin123'); // admin=owner
    // 夹具空库模式不注入自定义用户（既有已知限制）→ 用 admin 经正规接口建第二个仓管当"他人"
    const mkU = await h.req('POST', '/api/users', tokA, { username: 'tplwh01', password: 'Tp#Pass1', role: 'warehouse', name: '另一个仓管' });
    C('建第二个仓管账号（供越权/公共可见断言）', mkU.status === 200 && mkU.json.ok === true, 'status=' + mkU.status + ' ' + String((mkU.json || {}).msg || ''));
    const tokW = await h.login('tplwh01', 'Tp#Pass1'); // 另一仓管=他人

    // ① 建模板 3 行
    const cr = await h.req('POST', '/api/req-templates', tokA, { name: '焊装一线常领', items: mkItems(3), shared: false });
    const id = (cr.json || {}).id;
    C('★建模板成功返回 id（3 行）', cr.status === 200 && cr.json.ok === true && !!id, 'id=' + id);

    // 使用一次，攒计数（编辑后须保留）
    await h.req('POST', '/api/req-templates/' + id + '/use', tokW, {});

    // ② 原地编辑：增到 5 行、置共享
    const ed = await h.req('POST', '/api/req-templates', tokA, { id, name: '焊装一线常领', items: mkItems(5), shared: true });
    C('★带 id 编辑返回同一 id（原地更新非新建）', ed.status === 200 && ed.json.ok === true && String(ed.json.id) === String(id), 'id=' + (ed.json || {}).id);
    const gA = await h.req('GET', '/api/req-templates', tokA);
    const tA = find(gA.json.list, id);
    C('★编辑后行数 3→5（增零件生效）', !!tA && (tA.items || []).length === 5, '行数=' + ((tA || {}).items || []).length);
    C('★编辑后使用计数保留（use≥1，未被清零）', !!tA && (tA.use || 0) >= 1, 'use=' + ((tA || {}).use));
    C('★列表仅此一个该模板（未产生重复副本）', ((gA.json.list || []).filter((x) => x.name === '焊装一线常领')).length === 1, '重名数=' + ((gA.json.list || []).filter((x) => x.name === '焊装一线常领')).length);

    // ④ 共享后他人可见（公共模板）
    const gW = await h.req('GET', '/api/req-templates', tokW);
    C('★共享置为公共后他人可见该模板', !!find(gW.json.list, id), '他人可见=' + !!find(gW.json.list, id));

    // ③ 越权：他人带 id 编辑母本 → 403
    const bad = await h.req('POST', '/api/req-templates', tokW, { id, name: '被别人乱改', items: mkItems(1), shared: false });
    C('★他人无法原地编辑他人母本（403，公共模板靠载入另存各自改）', bad.status === 403, 'status=' + bad.status);
    const gA2 = await h.req('GET', '/api/req-templates', tokA);
    const tA2 = find(gA2.json.list, id);
    C('★越权编辑未污染母本（仍 5 行、名未改）', !!tA2 && (tA2.items || []).length === 5 && tA2.name === '焊装一线常领', '行数=' + ((tA2 || {}).items || []).length + ' 名=' + (tA2 || {}).name);

    // ⑤ 健壮性：空 items / 21 行 / 不存在 id
    const e1 = await h.req('POST', '/api/req-templates', tokA, { id, name: '空', items: [] });
    C('空 items 编辑被拒（不能把模板清空）', e1.json && e1.json.ok === false, 'msg=' + ((e1.json || {}).msg || '').slice(0, 20));
    const e2 = await h.req('POST', '/api/req-templates', tokA, { name: '太多', items: mkItems(21) });
    C('★超过 20 行被拒（与服务端上限一致，PDA/网页编辑器同限）', e2.json && e2.json.ok === false && /20/.test(String((e2.json || {}).msg || '')), 'msg=' + ((e2.json || {}).msg || '').slice(0, 24));
    const e3 = await h.req('POST', '/api/req-templates', tokA, { id: 'nope_x', name: '不存在', items: mkItems(2) });
    C('编辑不存在 id → 404/拒绝（不静默新建）', (e3.json || {}).ok === false || e3.status === 404, 'status=' + e3.status);

    // 减零件：编辑减到 2 行
    const cut = await h.req('POST', '/api/req-templates', tokA, { id, name: '焊装一线常领', items: mkItems(2), shared: true });
    const gA3 = await h.req('GET', '/api/req-templates', tokA);
    const tA3 = find(gA3.json.list, id);
    C('★原地减零件生效（5→2 行）', cut.json.ok === true && !!tA3 && (tA3.items || []).length === 2, '行数=' + ((tA3 || {}).items || []).length);

    // owner 删除
    const dl = await h.req('DELETE', '/api/req-templates?id=' + encodeURIComponent(id), tokA);
    const gA4 = await h.req('GET', '/api/req-templates', tokA);
    C('owner 可删除（删除后列表不含）', dl.json.ok === true && !find(gA4.json.list, id), '仍在=' + !!find(gA4.json.list, id));
  } catch (e) { total++; fail++; console.log('❌ 异常：' + (e && e.stack || e)); }
  finally { if (h) { try { await h.stop(); } catch (_) {} } }
  console.log('\n结果: ' + (total - fail) + ' 通过 / ' + fail + ' 失败  （隔离空库实例，CI 可跑）');
  process.exit(fail ? 1 : 0);
})();
