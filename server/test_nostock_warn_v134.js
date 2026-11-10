// ㉖v134 建单"无在架库存"三处警示 · 实例证明
// 用户痛点：搜一个彻底没货的零件，界面和有货零件看起来几乎一样，提交也不弹警告，仓管接单才发现发不出
// 三处改动（纯网页 console.html）：
//   ① 联想下拉右侧：boxes=0 从"空白"改显橙色"⚠ 无在架库存"
//   ② 框数灰字：字典有号但零在架 → "⚠ 在架 0 框 · 无货可发"（旧版只说"无每框均值"，没点破因由）
//   ③ 提交前警示：新增 empty 分支（avail=0 整类纳入），与 over 分两段点名；不在字典的顺带标注"需人工核对名称"
// 手法：vm 沙箱抽真实函数源码跑行为用例（nrowHint 三分支、联想渲染两分支、提交警示九组合），非纯 grep 锚点
const fs = require('fs'), vm = require('vm');
const html = fs.readFileSync(__dirname + '/public/console.html', 'utf8');
let fail = 0, total = 0;
const chk = (n, got, want) => { total++; const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL!'} [${n}] got=${String(JSON.stringify(got)).slice(0, 170)} want=${String(JSON.stringify(want)).slice(0, 170)}`); };
const chkT = (n, c, why) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]${c ? '' : ' ←' + (why || '')}`); };
const grab = (startSig, endSig) => { const i = html.indexOf(startSig); if (i < 0) throw new Error('锚点未找到: ' + startSig.slice(0, 40)); const j = html.indexOf(endSig, i + startSig.length); return html.slice(i, j); };

console.log('== A组 nrowHint 三分支（真实源码执行） ==');
{
  const hintSrc = grab('function nrowHint(inp){', '\nfunction nrowFocus');
  const ctx = vm.createContext({ window: {}, Math, Number, String });
  vm.runInContext(hintSrc + ';this.hint=nrowHint;', ctx);
  const mkRow = (pn, q, dict) => {
    const h = { textContent: '', innerHTML: '' };
    const inp = { value: String(q), closest: () => row };
    const row = { querySelector: (s) => (s === '.npn' ? { value: pn } : s === '.nqty' ? inp : s === '.nhint' ? h : null) };
    ctx.window._dictCache = dict;
    return { h, inp };
  };
  const { h: h1, inp: i1 } = mkRow('PN001', 3, [{ pn: 'PN001', perBoxQty: 175, boxes: 5 }]);
  ctx.hint(i1);
  chkT('A1 有货零件仍显示≈件数换算（v128 行为回归）', /≈525件/.test(h1.innerHTML) && /在架5框/.test(h1.innerHTML), h1.innerHTML);
  const { h: h2, inp: i2 } = mkRow('6608224302', 1, [{ pn: '6608224302', perBoxQty: 0, boxes: 0 }]);
  ctx.hint(i2);
  chkT('A2 零在架显示"⚠ 在架 0 框 · 无货可发"', /⚠ 在架 0 框 · 无货可发/.test(h2.innerHTML), h2.innerHTML);
  const { h: h3, inp: i3 } = mkRow('PN999X', 2, [{ pn: 'PN001', perBoxQty: 175, boxes: 5 }]);
  ctx.hint(i3);
  chkT('A3 不在字典零件仍走旧"无每框均值"灰字', /无每框均值 · 按 2 件提交/.test(h3.innerHTML), h3.innerHTML);
  const { h: h4, inp: i4 } = mkRow('PN001', 0, [{ pn: 'PN001', perBoxQty: 175, boxes: 0 }]);
  ctx.hint(i4);
  chk('A4 框数为0不显示任何提示', [h4.innerHTML, h4.textContent], ['', '']);
}
console.log('== B组 联想下拉右侧（真实渲染模板执行） ==');
{
  const seg = grab('pop.innerHTML=list.map(x=>', ';pop.style.display');
  const c2 = vm.createContext({ _esc: (s) => String(s), Number, String });
  vm.runInContext('this.render=(list)=>{const pop={innerHTML:"",style:{}};' + seg + ';return pop.innerHTML}', c2);
  const out1 = c2.render([{ pn: 'PN001', nm: '有货件', boxes: 2, perBoxQty: 175 }]);
  const out2 = c2.render([{ pn: '6608224302', nm: '极氪件', boxes: 0, perBoxQty: 0 }]);
  chkT('B1 有货零件显示"在架2框·175件/框"', /在架2框·175件\/框/.test(out1), out1.slice(-120));
  chkT('B2 零在架零件显示橙色"⚠ 无在架库存"', /⚠ 无在架库存/.test(out2) && /var\(--warn\)/.test(out2), out2.slice(-160));
}
console.log('== C组 提交前警示分支（真实 newReqGo 判定段执行） ==');
{
  const seg = grab('const items=[...document.querySelectorAll', 'btn.disabled=true;');
  const dict = [{ pn: 'PNA', perBoxQty: 100, boxes: 2 }, { pn: 'PNB', perBoxQty: 0, boxes: 0 }, { pn: 'PNC', perBoxQty: 50, boxes: 1 }];
  let asked = null;
  const c3 = vm.createContext({
    document: { querySelectorAll: () => c3.__rows },
    window: { _dictCache: dict },
    Math, Number, String, Array, JSON,
    confirm: (msg) => { asked = msg; return true; }, // 记录文案后放行（防 return 短路拿不到结果）
    T: () => {}, btn: {},
  });
  const row = (pn, q) => ({ querySelector: (s) => (s === '.npn' ? { value: pn } : s === '.nqty' ? { value: String(q) } : s === '.nnm' ? { value: '' } : s === '.nrs' ? { checked: false } : null) });
  const run = (rows) => { c3.__rows = rows; asked = null; vm.runInContext('globalThis.__r=null;(function(){' + seg + ';globalThis.__r={over:over.map(i=>i.partNo),empty:empty.map(i=>i.partNo)}})()', c3); return Object.assign({ asked }, c3.__r); };
  // C1/C2 有货但不够 → over 段（旧行为回归）
  let r = run([row('PNA', 5)]); // 5框×100=500件 > 在架2框×100=200件
  chk('C1 超量单进 over 不进 empty', [r.over, r.empty], [['PNA'], []]);
  chkT('C2 超量文案含"超过当前在架量"', !!r.asked && /超过当前在架量/.test(r.asked), String(r.asked).slice(0, 100));
  // C3/C4 彻底没货 → empty 段（旧版此处静默提交=病）
  r = run([row('PNB', 1)]);
  chk('C3 零在架单进 empty（旧版此单直接静默提交）', [r.over, r.empty], [[], ['PNB']]);
  chkT('C4 无货文案含"无在架库存"与在途豁免提示', !!r.asked && /无在架库存/.test(r.asked) && /已在途\/补货已安排/.test(r.asked), String(r.asked).slice(0, 140));
  // C5/C6 不在字典的零件号也进 empty 且标注人工核对
  r = run([row('ZZZ999', 3)]);
  chk('C5 字典外零件号进 empty（顺带防打错号）', r.empty, ['ZZZ999']);
  chkT('C6 字典外标注"不在字典，需人工核对名称"', !!r.asked && /不在字典，提交后仓管需人工核对名称/.test(r.asked), String(r.asked).slice(0, 140));
  // C7/C8 混合单两段同现
  r = run([row('PNA', 5), row('PNB', 1)]);
  chk('C7 混合单两段各自点名', [r.over, r.empty], [['PNA'], ['PNB']]);
  chkT('C8 混合文案两段齐全', !!r.asked && /超过当前在架量/.test(r.asked) && /无在架库存/.test(r.asked), String(r.asked).slice(0, 160));
  // C9 足额单不弹（防误伤回归）
  r = run([row('PNC', 1)]); // 1框×50=50件 ≤ 在架1框×50
  chk('C9 足额单不弹警示直接放行', [r.over, r.empty, r.asked], [[], [], null]);
}
console.log(`\n===== v134 建单无货警示实例证明 ${total - fail}/${total} PASS =====`);
process.exit(fail ? 1 : 0);
