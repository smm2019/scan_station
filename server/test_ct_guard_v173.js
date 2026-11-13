// ㉖v173 容器类型防误覆盖防线验证（11-12 14:49 事故：PDA 断网回落到内置默认5项，
// 当事人当现状保存 → 整表覆盖，14 项冲成 5 项，9 类消失、166 只在架实物失去类型口径）
// 防线口径：账本仍有在架实物的类型，禁止从字典删除（改名等价删除，因为实物上的旧值会变孤儿）。
// 必须经夹具起真实实例（本项目的血泪：抽函数绿了≠端点真的接住了请求）。
// 依赖生产库副本的 ledger 才有"在架实物"，故 CI 无库时整份 SKIP（与同类测试一致）。
'use strict';
const fs = require('fs');
const path = require('path');
const kit = require('./test_conc_kit_v172.js');

if (!fs.existsSync(path.join(__dirname, 'data', 'db.json'))) {
  console.log('⏭ SKIP test_ct_guard_v173：需生产库副本提供真实"在架实物"才能验删除拦截（CI 无库，本机带库时覆盖）');
  process.exit(0);
}

const PORT = Number(process.env.CTG_PORT || 8420);
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + i + ']' : ''}`); };

(async () => {
  let h = null;
  try {
    h = await kit.startInstance({
      port: PORT, tag: 'ctg' + process.pid, upTries: 60,
      users: [{ username: 'ct_wh', role: 'warehouse', password: 'Ct#Pass1' }],
    });
    const tok = await h.login('ct_wh', 'Ct#Pass1');

    // 取当前字典 + 账本在架口径（与哨兵同一份数据）
    const g = await h.req('GET', '/api/containers', tok);
    C('GET /api/containers 可读写（仓管权限）', g.status === 200 && Array.isArray(g.json.types), 'status=' + g.status);
    const cur = g.json.types || [];
    C('夹具副本拿到字典（≥5 项）', cur.length >= 5, cur.length + ' 项');

    // 找一个"账本里确有在架实物"的类型，作为被删对象
    const led = await h.req('GET', '/api/ledger?l=', tok);
    const rows = (led.json && led.json.items) || []; // 台账端点返回体字段名为 items
    if (!rows.length) { total++; fail++; console.log('❌ 台账未取到在架记录，无法验证删除拦截'); }
    const cnt = {};
    for (const r of rows) { const f = String(r.f || ''); if (f) cnt[f] = (cnt[f] || 0) + 1; }
    const victim = cur.find((x) => (cnt[x.db] || 0) + (cnt[x.show] || 0) > 0);
    C('找到在用类型作为被删对象', !!victim, victim ? victim.show + ' 在架=' + ((cnt[victim.db] || 0) + (cnt[victim.show] || 0)) : '(账本无匹配)');

    // ★ 核心：把它从列表里删掉（其余原样保留）→ 必须被拒
    const reduced = cur.filter((x) => x.db !== victim.db);
    const bad = await h.req('POST', '/api/containers', tok, { types: reduced });
    C('★删除仍有在架实物的类型 → 被拒 400', bad.status === 400, 'status=' + bad.status + ' msg=' + String((bad.json || {}).msg || '').slice(0, 40));
    C('★拒绝理由点名"在架"并带数量', /在架/.test(String((bad.json || {}).msg || '')), String((bad.json || {}).msg || '').slice(0, 90));

    const g2 = await h.req('GET', '/api/containers', tok);
    C('★被拒后字典未被改动（不是先写后报）', (g2.json.types || []).length === cur.length, (g2.json.types || []).length + ' vs ' + cur.length);
    C('★被删类型仍在字典里', (g2.json.types || []).some((x) => x.db === victim.db));

    // ★ 只新增不删除 → 必须放行（现场日常操作不能被误伤）
    const superset = cur.concat([{ db: 'CTGTEST框', show: 'CTG测试框' }]);
    const good = await h.req('POST', '/api/containers', tok, { types: superset });
    C('★新增类型（不删旧的）→ 正常放行 200', good.status === 200, 'status=' + good.status + ' msg=' + String((good.json || {}).msg || '').slice(0, 40));
    C('★保存后字典真的变多', ((await h.req('GET', '/api/containers', tok)).json.types || []).length === cur.length + 1);

    // 空列表/超长列表仍按原校验拦（防线没把老校验挤掉）
    const empty = await h.req('POST', '/api/containers', tok, { types: [] });
    C('空列表仍被拒（原校验未被挤掉）', empty.status === 400, 'status=' + empty.status);
  } catch (e) {
    total++; fail++; console.log('❌ 异常：' + e.message);
  } finally { if (h) { try { await h.stop(); } catch (_) {} } }
  console.log('\n结果: ' + (total - fail) + ' 通过 / ' + fail + ' 失败  （夹具副本，生产库零写入）');
  process.exit(fail ? 1 : 0);
})();
