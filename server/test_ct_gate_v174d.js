// ㉖v174d 料框字典硬闸回归（11-13 "料筐/塑筐"取证定案的实现验证）
// 病理（ops 字段级留痕实证）：台账口语名/旧版自由登记进账本 f → ctNorm 唯一才纠（"料筐"同时是
//   塑料筐/华强塑料筐 子串、"塑筐"同为子序列 → 多匹配歧义放行）→ 多 PDA 全量推送后到者胜
//   乒乓覆盖（实测 20 秒 A→B→A）→ 脏值随机复现；扫码 ct 全正确，脏的只有账本 f。
// 五层闸验证：A 抽函数（ctFixVal/ctSrcVal 判据边界，含歧义核心案例）
//   B 真实实例：sync 推送脏 f → 本轮即被扫码值覆盖（脏值活不过一轮 sync）+ 纠正计数入 diff 留痕
//   C 真实全库：夹具实例加载即完成存量对账——启动日志 fix≥5/存疑=0，加载后全表 f ∈ 字典。
// B/C 依赖生产库副本（真实扫码 ct 与 5 只脏行），CI 无库整份 SKIP。
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const kit = require('./test_conc_kit_v172.js');

const SRC = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + String(i).slice(0, 100) + ']' : ''}`); };
const fnSrc = (name) => { const i = SRC.indexOf('function ' + name + '('); if (i < 0) throw new Error('找不到 ' + name); for (let j = i; j < SRC.length; j++) if (SRC.slice(j, j + 2) === '\n}' && (j + 2 >= SRC.length || SRC[j + 2] === '\n')) return SRC.slice(i, j + 2); };

// ============ A 抽函数：判据边界 ============
const dictArr = [{ db: '塑料筐', show: '塑料筐' }, { db: '华强塑料筐', show: '华强塑料筐' }, { db: '托盘', show: '托盘' }];
const ctx = vm.createContext({ db: { containerTypes: dictArr }, String, Number, Array, Object, Set, JSON, console });
vm.runInContext(fnSrc('ctDictSet') + '\n' + fnSrc('ctFixVal') + '\n' + fnSrc('ctSrcVal'), ctx);
// ctNorm 依赖 _ctBad（模块级正则）：一并注入（与 server 内定义同口径）
const _ctBadSrc = SRC.match(/const _ctBad = [^\n]+/)[0];
vm.runInContext(_ctBadSrc + '\n' + fnSrc('ctNorm'), ctx);
{
  const run = (f, code, scanCt) => vm.runInContext(`(()=>{const dict=ctDictSet(${JSON.stringify(dictArr)});const m={};const cc=${JSON.stringify(code||'')};if(${JSON.stringify(scanCt||null)})m[cc]={ct:${JSON.stringify(scanCt||'')},t:1};return ctFixVal(${JSON.stringify(f)},cc,dict,m,(v)=>ctNorm(v,${JSON.stringify(dictArr)}))})()`, ctx);
  console.log('--- A 判据边界（抽函数）---');
  let r = run('塑料筐', 'A1', '塑料筐');
  C('字典正当值 → 原样不动', r.how === '' && r.f === '塑料筐');
  r = run('料筐', 'A2', '塑料筐');
  C('★料筐(歧义) + 扫码ct在字典 → 扫码覆盖(how=scan)', r.how === 'scan' && r.f === '塑料筐', JSON.stringify(r));
  r = run('塑筐', 'A3', null);
  C('★塑筐 + 无扫码 + 字典有两者(歧义) → 存疑保留不臆造', r.how === 'amb' && r.f === '塑筐', JSON.stringify(r));
  r = run('料筐', 'A4', '料筐');
  C('扫码 ct 本身也是脏值 → 存疑保留（绝不拿脏洗脏）', r.how === 'amb' && r.f === '料筐', JSON.stringify(r));
  // 设计如实：ctNorm 只对【含乱码坏字符】的值做四级归一（干净串早退原样）→ 干净脏值救不回=存疑保留，
  //  不臆造。乒乓场景（PDA 缓存脏）必伴随扫码记录（账本行来自扫码）→ 由 scan 分支救；C1 实证真实 5 框全有扫码。
  const r2 = vm.runInContext(`(()=>{return ctFixVal('塑筐','A5',new Set(['塑料筐']),{},(v)=>ctNorm(v,[{db:'塑料筐'}]))})()`, ctx);
  C('干净脏值+无扫码 → 存疑保留不臆造（ctNorm 只治乱码串，设计如实）', r2.how === 'amb' && r2.f === '塑筐', JSON.stringify(r2));
  let s = vm.runInContext(`ctSrcVal('料筐', ${JSON.stringify(dictArr)})`, ctx);
  C('源头闸：歧义脏值 → 置空（不臆造、带脏不如留空待扫码补正）', s === '', 'got=' + JSON.stringify(s));
  s = vm.runInContext(`ctSrcVal('塑料筐', ${JSON.stringify(dictArr)})`, ctx);
  C('源头闸：字典值直过', s === '塑料筐');
  s = vm.runInContext(`ctSrcVal('塑料筐 ', [{db:'塑料筐'}])`, ctx);
  C('源头闸：trim 后字典值仍直过', s === '塑料筐');
}

// ============ B/C 真实实例 ============
if (!fs.existsSync(path.join(__dirname, 'data', 'db.json'))) {
  console.log('\n⏭ B/C 跳过：CI 无 data/db.json（A 段判据回归不依赖库，照常全跑）');
  console.log('\n结果: ' + (total - fail) + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
}
const PORT = Number(process.env.CTG2_PORT || 8425);
(async () => {
  let h = null;
  try {
    h = await kit.startInstance({ port: PORT, tag: 'ctg2' + process.pid, upTries: 60, users: [{ username: 'ctg_wh', role: 'warehouse', password: 'Cg#Pass1' }] });
    console.log('\n--- B 真实实例：sync 脏 f 一轮即清洗 + C 全库加载对账 ---');
    const tok = await h.login('ctg_wh', 'Cg#Pass1');

    // C1：启动存量对账日志——真实副本含 5 只脏行(料筐/塑筐)且全部有扫码 ct → fix≥5 且 存疑=0
    const lg = (h.log || '').match(/\[ct-gate\] 启动料框字典对账：纠正 (\d+) 行（扫码(\d+)\/字典(\d+)）存疑 (\d+)/);
    C('★C1 启动对账日志：真实库脏行全被扫码救回（fix≥5，存疑=0）', !!lg && Number(lg[1]) >= 5 && Number(lg[4]) === 0, lg ? 'fix=' + lg[1] + ' amb=' + lg[4] : '无日志');

    // C2：加载后全表 f ∈ 字典（用实例自己的 /api/containers 当字典）
    const dict0 = ((await h.req('GET', '/api/containers', tok)).json.types) || [];
    const dset = new Set(); dict0.forEach((t) => { dset.add(String(t.db).trim()); dset.add(String(t.show).trim()); });
    const led = ((await h.req('GET', '/api/ledger?l=', tok)).json.items) || [];
    const bad = led.filter((x) => { const f = String(x.f || '').trim(); return f && !dset.has(f); });
    C('★C2 加载后全表 f ∈ 字典（0 脏值残留）', bad.length === 0, bad.length ? bad.slice(0, 3).map((x) => x.c + ':' + x.f).join(',') : led.length + ' 行全干净');
    const five = led.filter((x) => ['N26K100121', 'N26K100124', 'N26J270204', 'N26J270206', 'N26J220047'].includes(String(x.c).toUpperCase()));
    C('★C3 取证 5 框全部被洗成字典值', five.length > 0 && five.every((x) => dset.has(String(x.f).trim())), five.map((x) => x.c.slice(-4) + '=' + x.f).join(' '));

    // B1：乒乓场景同构测试——必须选【有扫码记录】的码（账本行来自扫码，PDA 缓存脏必伴随扫码参照）。
    // 反查 scanlog 拿在用 ct：/api/scanlog 按 c= 精确查（未作废最新 ct 即字典值，刚被 C1 洗正）。
    const slr = await h.req('GET', '/api/scanlog?c=N26K100121', tok);
    const slRows = ((slr.json || {}).items) || [];
    const ref = slRows.length ? String((slRows.sort((a, b) => (b.t || 0) - (a.t || 0))[0].ct) || '').trim() : '';
    C('B0 测试码 N26K100121 有扫码参照（ct=' + ref + '）', !!ref && dset.has(ref), ref || '无流水');
    const pick = led.find((x) => String(x.c).toUpperCase() === 'N26K100121') || led.find((x) => { const f = String(x.f || '').trim(); return f && dset.has(f); });
    if (pick && ref) {
      const cleanF = String(pick.f).trim();
      const s1 = await h.req('POST', '/api/ledger/sync', tok, { items: [{ c: pick.c, l: pick.l, f: '料筐', p: pick.p, n: pick.n, q: pick.q, b: pick.b, pid: pick.pid, t: Date.now() }], del: [], epoch: (await h.req('GET', '/api/ledger?l=', tok)).json.epoch });
      const row1 = ((await h.req('GET', '/api/ledger?c=' + pick.c, tok)).json.items || [])[0];
      C('★B1 推送脏 f=料筐 → 本轮即被扫码字典值覆盖（脏值活不过一轮 sync）', row1 && String(row1.f).trim() !== '料筐' && dset.has(String(row1.f).trim()), (row1 || {}).f + ' (码=' + pick.c + ')');
      // B2：diff 留痕带纠正计数
      let opRow = null;
      for (let i = 0; i < 16; i++) { await kit.sleep(500); try { const d = JSON.parse(fs.readFileSync(path.join(h.tdir, 'db.json'), 'utf8')); opRow = (d.ops || []).filter((o) => /账本合并diff/.test(String(o.act))).slice(-1)[0]; if (opRow && /料框字典对账/.test(String(o.det))) break; } catch (_) {} }
      C('★B2 纠正计数写入 diff 留痕（可审计）', /料框字典对账\d+/.test((opRow || {}).det || ''), String((opRow || {}).det || '').slice(0, 90));
      // B3：干净值推送不误伤（不产生料框对账计数）
      const s3 = await h.req('POST', '/api/ledger/sync', tok, { items: [{ c: pick.c, l: pick.l, f: cleanF, p: pick.p, n: pick.n, q: pick.q, b: pick.b, pid: pick.pid, t: Date.now() + 1 }], del: [] });
      await kit.sleep(1200);
      let op3 = null; try { const d = JSON.parse(fs.readFileSync(path.join(h.tdir, 'db.json'), 'utf8')); op3 = (d.ops || []).filter((o) => /账本合并diff/.test(String(o.act))).slice(-1)[0]; } catch (_) {}
      C('★B4 字典正当值推送零误伤（无对账计数）', op3 && /料框字典对账/.test(String(op3.det || '')) === false, String((op3 || {}).det || '').slice(0, 80));
    }
  } catch (e) { total++; fail++; console.log('❌ 异常：' + e.message); }
  finally { if (h) { try { await h.stop(); } catch (_) {} } }
  console.log('\n结果: ' + (total - fail) + ' 通过 / ' + fail + ' 失败  （夹具副本，生产库零写入）');
  process.exit(fail ? 1 : 0);
})();
