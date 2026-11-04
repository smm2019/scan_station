// ㉖v105 A+B 转单预检与对账入账 · 判据复刻 + 源码断言
// 复刻 requisition_page.dart 新决策流（Node版，与 Dart 分支逐一对应），用 11/4 现场卡单数据回放
const fs = require('fs'), path = require('path');
const d = require('./data/db.json');
let fail = 0, total = 0;
function T(n, a, b) { total++; const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) { fail++; console.log('FAIL ' + n + '\n  实际=' + JSON.stringify(a) + '\n  期望=' + JSON.stringify(b)); } else console.log('PASS ' + n); }

// mesState: 码→MES当前所在仓展示串（空对象=预检查询全失败）
// opts: {skipPrecheck 模拟预检查询失败, mesReject 实转被拒"不能重复调拨"}
function runFlow(codes, mesState, toDisp, opts) {
  opts = opts || {};
  const inTarget = (cs) => cs.filter((c) => mesState[c] === toDisp);
  const flow = { steps: [], retried: false, rejectDone: false };
  let pcN = 0; // skipPrecheck 仅模拟【首次】预检查询失败；A兜底重预检按 mesState 正常返回
  const preCheck = () => (++pcN === 1 && opts.skipPrecheck ? [] : inTarget(codes));
  function oneRun(tC, rc) {
    if (tC.length > 0) {
      if (opts.mesReject && !opts.rejectDone) {
        opts.rejectDone = true;
        flow.steps.push({ act: 'MES拒绝', payload: tC.slice() });
        if (!flow.retried) {
          flow.retried = true;
          const it2 = preCheck();
          if (it2.length) { flow.steps.push({ act: 'A兜底重预检', rc: it2.slice() }); return oneRun(codes.filter((c) => !it2.includes(c)), it2); }
          flow.steps.push({ act: 'A兜底无果' });
          return flow;
        }
        flow.steps.push({ act: '仍被拒' });
        return flow;
      }
      flow.steps.push({ act: 'MES转单', payload: tC.slice() });
    }
    // 回写与台账：codes=全部勾选框（t∪rc），recon 标记供服务器留痕
    flow.writeCodes = codes.slice();
    flow.reconMark = rc.length ? rc.slice() : null;
    flow.ledgerCodes = codes.slice();
    return flow;
  }
  const pre = preCheck();
  flow.precheck = pre.slice();
  return oneRun(codes.filter((c) => !pre.includes(c)), pre);
}

const TO = '焊-宁波-线边仓/焊-宁波-线边仓/焊-宁波-线边仓';
const SRC1 = '焊-宁波-原料仓/焊-宁波-原料仓/A01';
const codes1104 = ['N26J250226', 'N26J250225'];

console.log('===== A1 11/4 现场卡单回放（两框 MES 均已在线边仓 → 纯对账）=====');
const f1 = runFlow(codes1104, { N26J250226: TO, N26J250225: TO }, TO, {});
T('A1a B预检识别两框均已在目标仓', f1.precheck, codes1104);
T('A1b 纯对账：零MES调用', f1.steps, []);
T('A1c 回写codes=全部勾选框（服务器按实传记账=400件）', f1.writeCodes, codes1104);
T('A1d recon标记送服务器留痕', f1.reconMark, codes1104);

console.log('\n===== A2 部分对账（250226 已转、250225 仍在源仓）=====');
const f2 = runFlow(codes1104, { N26J250226: TO, N26J250225: SRC1 }, TO, {});
T('A2a 预检只认已转的250226', f2.precheck, ['N26J250226']);
T('A2b MES报文只含未转的250225（不重复调拨）', f2.steps, [{ act: 'MES转单', payload: ['N26J250225'] }]);
T('A2c 回写仍=两框（账面400件与实物一致）', f2.writeCodes, codes1104);
T('A2d recon=250226', f2.reconMark, ['N26J250226']);

console.log('\n===== A3 正常全转（两框都在源仓）——旧行为零变化 =====');
const f3 = runFlow(codes1104, { N26J250226: SRC1, N26J250225: SRC1 }, TO, {});
T('A3a 预检空集=不弹对账窗', f3.precheck, []);
T('A3b MES报文=两框', f3.steps, [{ act: 'MES转单', payload: codes1104 }]);
T('A3c 无recon标记', f3.reconMark, null);

console.log('\n===== A4 预检漏网→MES拒绝→A兜底自动降级（单次闸）=====');
const f4 = runFlow(codes1104, { N26J250226: TO, N26J250225: TO }, TO, { skipPrecheck: true, mesReject: true });
T('A4a 兜底链路：拒绝→重预检→纯对账（无死循环）', f4.steps, [{ act: 'MES拒绝', payload: codes1104 }, { act: 'A兜底重预检', rc: codes1104 }]);
T('A4b 兜底后回写两框+recon', [f4.writeCodes, f4.reconMark], [codes1104, codes1104]);
const f5 = runFlow(codes1104, {}, TO, { skipPrecheck: true, mesReject: true });
T('A5 重复调拨且兜底查无仓位→人工核对提示（不静默入账）', [f5.steps.map((s) => s.act), f5.writeCodes], [['MES拒绝', 'A兜底无果'], undefined]);

console.log('\n===== A6 源码断言（实现与判据同步，防漂移）=====');
const pda = fs.readFileSync(path.join(__dirname, '../lib/requisition_page.dart'), 'utf8');
T('A6a B预检存在（仅barcode查询取当前仓位）', /GetBarCodeInfoOnHand", \{"barcode": c\}\)/.test(pda), true);
T('A6b 对账判定=当前仓展示串与目标一致', /== toDisp/.test(pda), true);
T('A6c 纯对账跳过MES（boxes空不调SaveTR）', /if \(boxes\.isNotEmpty\) \{/.test(pda), true);
T('A6d 回写codes=全部issued勾选集（非仅实传）', /"codes": List\.from\(item\["issued"\] \?\? \[\]\)/.test(pda), true);
T('A6e recon 送服务器留痕', /if \(rc\.isNotEmpty\) "recon": rc/.test(pda), true);
T('A6f A兜底：重复调拨→重预检→切对账，单次闸防死循环', /msg\.contains\("重复调拨"\) && !retriedRecon/.test(pda) && /retriedRecon = true/.test(pda), true);
T('A6g 预检并发分片5路+上限60框', /for \(var s = 0; s < cs\.length; s \+= 5\)/.test(pda) && /codes\.take\(60\)/.test(pda), true);
T('A6h 对账框台账行数据源=发料缓存优先、预检兜底', /final cached = _boxData\[c\];/.test(pda), true);
const svr = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
T('A6i 服务器留痕对账框', /对账入账：框 \$\{_rc\.join\('\/'\)\}/.test(svr), true);
T('A6j 服务器记账口径不受recon影响（codes唯一真源）', /const _sent = Array\.isArray\(b\.codes\)/.test(svr), true);

console.log('\n===== A7 真实卡单数据基线（服务器实况，不可变事实源）=====');
const r = (d.requisitions || []).find((x) => x.no === 'LL2026110409555589');
const it = r.items.find((i) => String(i.partNo) === '6608225548');
T('A7a 实况：accepted 未转单、两框在issued', [r.status, it.transferred ? 1 : 0, (it.issued || []).length], ['accepted', 0, 2]);
T('A7b 两框均已消位（发料承诺实物离架，对账入账后端不再复活）', (d.ledger || []).some((x) => codes1104.includes(x.c)), false);
T('A7c 服务器无任何出库单含这两码（本地确无转单记录=MES侧外部完成）', (() => { for (const o of Object.values(d.outbound || {})) for (const l of o.items || []) if (codes1104.includes(String(l.barcode || '').toUpperCase())) return false; return true; })(), true);

console.log(fail === 0 ? '\n===== 全部 PASS，合计 ' + total + ' 项 =====' : '\n===== ' + fail + '/' + total + ' 失败 =====');
process.exit(fail === 0 ? 0 : 1);
