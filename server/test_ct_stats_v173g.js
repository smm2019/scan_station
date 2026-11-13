// ㉖v173g 回归：①服务器异常/PDA上报进事件流水（含 10 分钟抑制窗）②容器类型使用统计下发
// ③容器类型增删改【明细】留痕。
// 为什么两层都要（本项目血泪：抽函数绿≠端点真的会写）：
//   A 抽函数验 logErr 的流水写入与抑制窗（vm 注入，毫秒级）
//   B 夹具起真实实例验：GET 带 cnt/onLed；POST 一次"加一删一改一移"后，ops 尾部真的出现
//     "新增 1/删除 1/改名 1"明细；纯顺序变更记"顺序调整"；删除有在架的类型仍被 v173 防线拒。
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const kit = require('./test_conc_kit_v172.js');

const SRC = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + String(i).slice(0, 100) + ']' : ''}`); };
const topFn = (name) => {
  let i = SRC.indexOf('async function ' + name + '(');
  if (i < 0) i = SRC.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('找不到 ' + name);
  for (let j = i; j < SRC.length; j++) if (SRC.slice(j, j + 2) === '\n}' && (j + 2 >= SRC.length || SRC[j + 2] === '\n')) return SRC.slice(i, j + 2);
};

// ================= A. logErr → 事件流水 =================
console.log('--- A 服务器异常进流水（抽函数）---');
function mkLogCtx() {
  const ops = [];
  const ctx = vm.createContext({
    db: { sysErr: [] }, newId: (p) => p + '_x', SYS_ERR_MAX: 100,
    pushOps: (u, act, obj, det) => ops.push({ act, obj, det }),
    _leOpsAt: new Map(), Date, Math, String, Number, Object, Array, Map, RegExp, JSON,
    console: { log: () => {} },
  });
  vm.runInContext(topFn('logErr'), ctx);
  return { ctx, ops };
}
{
  const { ctx, ops } = mkLogCtx();
  vm.runInContext('logErr("saveDb", new Error("EPERM: operation not permitted, rename"))', ctx);
  C('异常同时进 sysErr 面板与事件流水', ctx.db.sysErr.length === 1 && ops.length === 1 && ops[0].act === '服务器异常', JSON.stringify(ops[0] && { a: ops[0].act, o: ops[0].obj }));
  C('流水详情含消息与栈摘要', /EPERM/.test(ops[0].det), ops[0].det.slice(0, 60));
  vm.runInContext('logErr("saveDb", new Error("EPERM: operation not permitted, rename"))', ctx);
  C('同 where+消息 10 分钟内抑制（不刷爆流水）', ctx.db.sysErr.length === 2 && ops.length === 1, 'sysErr=' + ctx.db.sysErr.length + ' ops=' + ops.length);
  vm.runInContext('logErr("backupDb", new Error("EPERM: operation not permitted, rename"))', ctx);
  C('不同 where 各自独立入流水（抑制键含位置）', ops.length === 2 && ops[1].obj === 'backupDb');
  vm.runInContext('logErr("x", new Error("aborted"))', ctx);
  C('传输层断连降噪未破坏（aborted 两处都不记）', ctx.db.sysErr.length === 3 && ops.length === 2, 'sysErr=' + ctx.db.sysErr.length + ' ops=' + ops.length);
}

// ================= B. 容器统计 + 明细留痕（真实实例）=================
console.log('\n--- B 容器类型统计与明细留痕（夹具实例）---');
const PORT = Number(process.env.CTS_PORT || 8422);
(async () => {
  let h = null;
  try {
    h = await kit.startInstance({ port: PORT, tag: 'cts' + process.pid, upTries: 60, users: [{ username: 'cts_wh', role: 'warehouse', password: 'Ct#Pass1' }] });
    const tok = await h.login('cts_wh', 'Ct#Pass1');
    const g = await h.req('GET', '/api/containers', tok);
    const types = (g.json && g.json.types) || [];
    C('GET 每项带 cnt/onLed 使用统计', types.length > 0 && types.every((t) => typeof t.cnt === 'number' && typeof t.onLed === 'number'), types.length + ' 项');
    const hot = types.find((t) => t.cnt > 0), idle = types.find((t) => t.onLed === 0);
    C('统计口径真实（在用类型 cnt>0；存在 onLed=0 项供删除实验）', !!hot && !!idle, hot && ('最热=' + hot.show + ' cnt=' + hot.cnt) + ' ' + (idle && '闲置=' + idle.show));
    if (hot) C('热门类型=1.8米铁框量级合理（cnt≥100）', hot.cnt >= 100, hot.show + ' cnt=' + hot.cnt);

    // 一次保存：删闲置 + 改名一个 + 新增一个 + 顺序倒转
    const renamed = types.find((t) => t !== idle && t !== hot) || types[0];
    const next = [hot, { db: 'CTSG新增框', show: 'G测试框' }].concat(types.filter((t) => t !== idle && t !== hot).map((t) => t.db === renamed.db ? { db: t.db, show: '改名后' } : { db: t.db, show: t.show })).reverse();
    const p = await h.req('POST', '/api/containers', tok, { types: next });
    C('增删改混合保存被接受（删除项在架=0 不触防线）', p.status === 200 && p.json.ok, 'status=' + p.status + ' ' + String((p.json || {}).msg || '').slice(0, 50));

    // 读实例落盘库的 ops 尾条
    let opRow = null;
    for (let i = 0; i < 24; i++) {
      await kit.sleep(500);
      try {
        const d = JSON.parse(fs.readFileSync(path.join(h.tdir, 'db.json'), 'utf8'));
        opRow = (d.ops || []).filter((o) => /容器类型配置/.test(String(o.act))).slice(-1)[0];
        if (opRow && /新增|顺序/.test(String(o.obj) + String(o.det))) break;
      } catch (_) {}
    }
    C('★留痕含【新增 1】点名', /新增 1[：:]/.test(opRow && opRow.obj || '') && /G测试框/.test((opRow || {}).obj + ''), JSON.stringify(opRow && opRow.obj).slice(0, 90));
    C('★留痕含【删除 1】点名闲置类型', /删除 1[：:]/.test((opRow || {}).obj || '') && new RegExp(idle.show).test(opRow.obj), (opRow || {}).obj);
    C('★留痕含【改名 1】旧→新', /改名 1[：:]/.test((opRow || {}).obj || '') && /→改名后/.test(opRow.obj), (opRow || {}).obj);

    // 纯顺序变更 → 记"顺序调整"
    const cur = ((await h.req('GET', '/api/containers', tok)).json.types || []).map((t) => ({ db: t.db, show: t.show }));
    const p2 = await h.req('POST', '/api/containers', tok, { types: cur.slice().reverse() });
    let op2 = null;
    for (let i = 0; i < 24; i++) {
      await kit.sleep(500);
      try { const d = JSON.parse(fs.readFileSync(path.join(h.tdir, 'db.json'), 'utf8')); op2 = (d.ops || []).filter((o) => /容器类型配置/.test(String(o.act))).slice(-1)[0]; if (op2 && /顺序调整/.test(String(op2.obj))) break; } catch (_) {}
    }
    C('★纯排序变更留痕"顺序调整"（顺序也可追溯）', p2.status === 200 && /顺序调整/.test((op2 || {}).obj || ''), (op2 || {}).obj);

    // 删有在架的类型 → v173 防线仍在（本次改造没破坏它）
    const g3 = ((await h.req('GET', '/api/containers', tok)).json.types || []);
    const withLed = g3.find((t) => t.onLed > 0);
    const p3 = await h.req('POST', '/api/containers', tok, { types: g3.filter((t) => t.db !== withLed.db).map((t) => ({ db: t.db, show: t.show })) });
    C('★删除有在架类型仍被防线拒（明细留痕改造未伤防线）', p3.status === 400 && /在架/.test((p3.json || {}).msg || ''), 'status=' + p3.status);
  } catch (e) { total++; fail++; console.log('❌ 异常：' + e.message); }
  finally { if (h) { try { await h.stop(); } catch (_) {} } }
  console.log('\n结果: ' + (total - fail) + ' 通过 / ' + fail + ' 失败  （夹具副本，生产库零写入）');
  process.exit(fail ? 1 : 0);
})();
