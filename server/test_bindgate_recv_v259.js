// ㉖v259 位货绑定闸 NB04 转入豁免 · vm 真实代码行为证明（11-25 N26K250034 竞态实锤）
// 抽 server.js 绑定闸原段真跑：一楼转入/地面重上架放行；真矛盾(第三货架位)/盘点归位/出库语义照拦——豁免不扩大化
const fs = require('fs'), path = require('path'), vm = require('vm');
const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
function grab(name) { const s0 = server.indexOf('function ' + name + '('); let d = 0, i = server.indexOf('{', s0); for (let j = i; j < server.length; j++) { if (server[j] === '{') d++; else if (server[j] === '}') { d--; if (!d) return server.slice(s0, j + 1); } } throw new Error(name + ' 未闭合'); }
let total = 0, fail = 0;
const C = (n, c, i) => { total++; if (!c) { fail++; console.log('FAIL! [' + n + '] ' + (i || '')); } else console.log('PASS [' + n + ']'); };
const sA = server.indexOf('  if (q.code && (!q.type || q.type === \'outbound\'');
const sB = server.indexOf('㉖v79c 入库重复货位终极防线');
if (sA < 0 || sB < 0 || sB < sA) { console.log('FAIL! 闸段锚点失配', sA, sB); process.exit(1); }
const gateSrc = server.slice(sA, server.lastIndexOf('}\n', sB) + 2); // 到绑定闸段闭合（v79c 防线前）
const ctx = { db: { ledger: [] }, nowMs: Date.now(), console };
vm.createContext(ctx);
vm.runInContext('const locRecv = (l) => /^NB04-/.test(String(l||"").toUpperCase());\nfunction bindGate(q, stn){ const assigned=[]; ' + gateSrc + ' return q.state === "失败" ? (q.err || "bad") : ""; }', ctx);
const gate = (q, stn) => { const z = Object.assign({ trace: [] }, q); vm.runInContext('bindGate', ctx).call(ctx, z, stn); Object.assign(q, { state: z.state, err: z.err, trace: z.trace }); return z.state === '失败' ? (z.err || 'bad') : ''; }; // 闸拦截分支原样 return true 结束函数，返回值必须从回写状态取
(async () => {
  const setLed = (c, l) => { ctx.db.ledger = [{ c, l, q: 100, t: Date.now() }]; };
  // ① 一楼转入（v259 新增豁免）：账本 NB04 + from=CK台 → 放行且留痕"一楼转入"
  setLed('N26K250034', 'NB04-A-01-002');
  let q1 = { code: 'N26K250034', type: 'inbound', fromLoc: 'NB02-CK-05' };
  let r1 = gate(q1, 'NB02-A-02-1F');
  C('★一楼转入 NB04→货架 放行（竞态根治）', r1 === '' && (q1.trace || []).some((t) => /一楼转入.*放行/.test(t)), r1 + '|' + JSON.stringify(q1.trace));
  // ② v199b 地面重上架豁免保留
  setLed('T2', 'NB03-C-12-03');
  C('★地面格豁免保留（v199b 回归）', gate({ code: 'T2', type: 'inbound', fromLoc: 'NB02-CK-05' }, 'NB02-B-03-2F') === '', '');
  // ③ 真矛盾照拦：账本在第三货架位（≠台≠终点且非 NB04/NB03）
  setLed('T3', 'NB02-A-09-3F');
  let q3 = { code: 'T3', type: 'inbound', fromLoc: 'NB02-CK-05' };
  C('★★第三货架位真矛盾仍拒（豁免不扩大化）', /矛盾，拒绝下发/.test(gate(q3, 'NB02-A-02-1F')) && q3.state === '失败', '');
  // ④ 盘点归位不豁免：countback + NB04 = 拦（盘点期账本设计上不动）
  setLed('T4', 'NB04-A-01-002');
  C('★★countback 归位腿 NB04 不豁免仍拒', /矛盾，拒绝下发/.test(gate({ code: 'T4', type: 'countback', fromLoc: 'NB02-CK-05' }, 'NB02-A-01-1F')), '');
  // ⑤ 畸形地面码不放行（v199b 格式闸不松）
  setLed('T5', 'NB03-X-99-99');
  C('★畸形"地面码"仍拒（格式闸保留）', /矛盾，拒绝下发/.test(gate({ code: 'T5', type: 'inbound', fromLoc: 'NB02-CK-05' }, 'NB02-B-03-2F')), '');
  // ⑥ 出库语义闸不受累：账本 NB04、起点=货架 → 起点不符拒（AGV 去叉会叉空）
  setLed('T6', 'NB04-A-01-002');
  C('★出库闸不豁免（起点不符照拒）', /与叫车起点.*不符/.test(gate({ code: 'T6', type: 'outbound', fromLoc: 'NB02-A-02-1F' }, 'NB02-CK-05')), '');
  // ⑦ 账本位置=起点站台（搬运前登记合法态）仍放行（原语义回归）
  setLed('T7', 'NB02-CK-05');
  C('★账本已在起点台放行（原豁免①回归）', gate({ code: 'T7', type: 'inbound', fromLoc: 'NB02-CK-05' }, 'NB02-B-03-2F') === '', '');
  console.log(`\n===== v259 绑定闸豁免行为证明：${total - fail}/${total} PASS =====`);
  process.exitCode = fail ? 1 : 0;
})();
