// ㉖v196 transfer 轻量节流 · vm 真实函数行为证明
// 用户拍板：按项目移地面"一次铺满直发"改「待节流」——超并发/巷道闸门部分排队，调度tick按序补发。
// 关键正确性点（代码审查）：①双腿 waiting 已排除 transfer（否则被 dispatchOne 误捡坏掉）
// ②补发段在双腿 waiting空return 之前（双腿无单时移库仍补发）③aisleBusy 起终点巷道双向占名额。
// ★闸门逻辑必须 vm 真跑：静态只能证代码在，测不出"并发满排队/巷道满排队/失败不静默删"。
const fs = require('fs'), path = require('path');
const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
function grab(name) { const s0 = server.indexOf('function ' + name + '('); const s = s0 >= 6 && server.slice(s0 - 6, s0) === 'async ' ? s0 - 6 : s0; let d = 0, i = server.indexOf('{', s0); for (let j = i; j < server.length; j++) { if (server[j] === '{') d++; else if (server[j] === '}') { d--; if (!d) return server.slice(s, j + 1); } } throw new Error(name + ' 未闭合'); }
const vm = require('vm');
let total = 0, fail = 0;
const C = (n, c, i) => { total++; if (!c) { fail++; console.log('FAIL! [' + n + '] ' + (i || '')); } else console.log('PASS [' + n + ']'); };

// 假 DB + 假参数 + 假 wmasDispatchOne（可控成功/失败/计数）
const DB = { agvQueue: [] }, PP = { transferConc: 2, aisleCap: 2 };
let dispCalls = [], dispFailSet = new Set();
const ctx = { P: () => PP, wmasDispatchOne: async (a, tk, o) => { dispCalls.push(o.ref); return dispFailSet.has(o.ref) ? { ok: false, msg: '模拟下发失败' } : { ok: true, taskNo: 'T' + dispCalls.length }; } };
vm.createContext(ctx);
ctx.DB = DB; // aisleBusy 用 db.agvQueue：别名 const db=DB 同引用，测试刷 DB.agvQueue 即生效
vm.runInContext('const db = DB;\n' + grab('aisleBusy') + '\n' + grab('tryDispatchTransfer'), ctx);
const AB = () => vm.runInContext('aisleBusy()', ctx);
const TD = (item, tk, ab, flow) => vm.runInContext('tryDispatchTransfer', ctx).call(ctx, item, tk, ab, flow);

(async () => {
  // ① aisleBusy 双腿源货位巷道计数
  DB.agvQueue = [
    { type: 'outbound', state: '下发中', fromLoc: 'NB02-A-05-1F', code: 'C1' }, { type: 'outbound', state: '下发中', fromLoc: 'NB02-A-05-2F', code: 'C2' },
    { type: 'outbound', state: '已下发', fromLoc: 'NB02-B-09-1F', code: 'C3' }, { type: 'outbound', state: '已下发', fromLoc: 'NB02-B-09-2F', code: 'C4' }, { type: 'outbound', state: '已下发', fromLoc: 'NB02-B-09-3F', code: 'C5' },
  ];
  const ab0 = AB();
  C('★ aisleBusy 双腿源货位巷道计数正确', ab0['NB02-A-05'] === 2 && ab0['NB02-B-09'] === 3, JSON.stringify(ab0));

  // ② aisleBusy 含 transfer：shelf2shelf 双端占位 / toGround 终点地面不计
  DB.agvQueue.push({ type: 'transfer', state: '已下发', kind: 'shelf2shelf', from: 'NB02-C-11-1F', to: 'NB02-C-11-2F', code: 'T1' });
  DB.agvQueue.push({ type: 'transfer', state: '已下发', kind: 'toGround', from: 'NB02-D-10-1F', to: 'NB03-A-01-03', code: 'T2' });
  const ab1 = AB();
  C('★★★ shelf2shelf 起终点同巷道双计（移库占 aisleCap 与双腿共闸门）', ab1['NB02-C-11'] === 2, JSON.stringify(ab1));
  C('★★★ toGround 终点地面(NB03)不计、仅起点巷道计1', ab1['NB02-D-10'] === 1 && ab1['NB03-A-01'] === undefined, JSON.stringify(ab1));

  // ③ 移库并发闸门：flow.n 已达上限 → queued，绝不调 WMAS
  DB.agvQueue = [{ type: 'outbound', state: '已下发', fromLoc: 'NB02-E-01-1F', code: 'X1' }];
  dispCalls = []; dispFailSet = new Set();
  {
    const t = { type: 'transfer', kind: 'toGround', state: '排队', from: 'NB02-A-02-1F', to: 'NB03-A-02-01', code: 'B', trace: [] };
    const r = await TD(t, 'tk', AB(), { n: PP.transferConc }); // 在途已满
    C('★★★ 移库并发已满 → queued、state保持排队、未调 WMAS', r.queued === true && t.state === '排队' && dispCalls.length === 0, JSON.stringify(r));
  }

  // ④ aisleCap 巷道闸门：起点巷道满（并发有空位也拦）→ queued（防与双腿出库同巷道对开死锁）
  {
    DB.agvQueue = []; for (let i = 1; i <= 2; i++) DB.agvQueue.push({ type: 'outbound', state: '已下发', fromLoc: 'NB02-A-05-' + i + 'F', code: 'B' + i });
    const t = { type: 'transfer', kind: 'toGround', state: '排队', from: 'NB02-A-05-3F', to: 'NB03-A-05-01', code: 'Z', trace: [] };
    const r = await TD(t, 'tk', AB(), { n: 0 });
    C('★★★ 起点巷道在途满 → 排队（共享 aisleCap 防对开死锁）', r.queued === true && t.state === '排队', JSON.stringify(r));
  }

  // ⑤ 闸门空 → 正常下发：置已下发+sentAt+占位计数各+1
  {
    DB.agvQueue = [];
    const t = { type: 'transfer', kind: 'shelf2shelf', state: '排队', from: 'NB02-B-01-1F', to: 'NB02-B-02-1F', code: 'OK1', palletType: 'F', trace: [] };
    const ab = AB(), flow = { n: 0 };
    const r = await TD(t, 'tk', ab, flow);
    C('★★★ 闸门空 → 下发成功置已下发 + 起终点巷道占位各+1', r.ok === true && t.state === '已下发' && t.sentAt > 0 && flow.n === 1 && ab['NB02-B-01'] === 1 && ab['NB02-B-02'] === 1, JSON.stringify(r) + JSON.stringify(ab));
  }

  // ⑥ WMAS 下发失败：state=失败 + trace 留痕，不静默删除（旧版 filter 掉=批量失败无声消失）
  {
    DB.agvQueue = []; dispFailSet = new Set(['YK-BAD']);
    const t = { type: 'transfer', kind: 'toGround', state: '排队', from: 'NB02-C-01-1F', to: 'NB03-C-01-01', code: 'BAD', trace: [] };
    const r = await TD(t, 'tk', AB(), { n: 0 });
    C('★★★ WMAS下发失败 → 标失败留trace（不再静默删项）', r.ok === false && r.dispatched === false && t.state === '失败' && /WMAS下发失败/.test((t.trace || []).join()), JSON.stringify(r) + (t.trace || []).join());
    dispFailSet = new Set();
  }

  // ⑦ 静态：waiting 排除 transfer + 补发段在双腿 return 之前（双腿空时移库仍补发）
  {
    const iw = server.indexOf("q.state === '排队' && q.type !== 'transfer'");
    const ifill = server.indexOf('移库/返架排队补发');
    const iret = server.indexOf('if (!waiting.length) return;');
    C('★★★ waiting排除transfer + 补发段在双腿return之前', iw > 0 && ifill > iw && ifill < iret, `wait=${iw} fill=${ifill} ret=${iret}`);
  }
  C('★★ 补发队列按 at 升序 FIFO（后排队不饿死）', /transfer' && !q\.dry && q\.state === '排队'\)\.sort\(\(a, b\) => \(a\.at \|\| 0\) - \(b\.at \|\| 0\)\)/.test(server), '');
  C('★★ transferConc 参数入调度节奏组（默认2，0=回退直发）', /transferConc:\s*\{ grp: '调度节奏'[\s\S]*?d: 2/.test(server), '');

  console.log('\n结果: ' + (total - fail) + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
