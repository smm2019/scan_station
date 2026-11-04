// ㉖v106 A+B 转单预检与对账入账 · 判据复刻 + 源码断言（v106b 升级：双形态查询/仓库级比对/文案确认入账）
// 主库已被生产服务跑过迁移，判据不依赖"主库停在哪个时刻"：F 系列只断言不可变事实。
const fs = require('fs'), path = require('path');
const d = require('./data/db.json');
let fail = 0, total = 0;
function T(n, a, b) { total++; const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) { fail++; console.log('FAIL ' + n + '\n  实际=' + JSON.stringify(a) + '\n  期望=' + JSON.stringify(b)); } else console.log('PASS ' + n); }

// 现场目标仓（history 实证三段同名拼接）与源仓；mesState 值=该框当前所在【仓名】
const TO_WH = '焊-宁波-线边仓', SRC_WH = '焊-宁波-原料仓';
const codes1104 = ['N26J250226', 'N26J250225'];

// 仓库级比对复刻（v106b：优先 WAREHOUSE_NAME 相等，非全串）
const atTarget = (wh, mesState, c) => wh === '焊-宁波-线边仓' && mesState[c] === TO_WH;
// MES 拒绝文案解析复刻
function saysAtTarget(msg, toWh) {
  const m = /已在(.{1,40}?)，?不能重复调拨/.exec(msg.replace(/。/g, ''));
  if (!m) return false;
  const norm = (s) => s.trim().replace(/·/g, '-');
  const claimed = norm(m[1]), tw = norm(toWh);
  return !!claimed && !!tw && (claimed === tw || tw.includes(claimed) || claimed.includes(tw));
}

// 决策流复刻：preState 首次预检结果，reconState 兜底重预检结果（默认同 preState）
// opts: {mesReject 实转被拒, rejectMsg 拒绝文案, userConfirm 人工窗是否点"按已转单入账"}
function runFlow(codes, preState, opts) {
  opts = opts || {};
  const reconState = opts.reconState || preState;
  const flow = { steps: [], retried: false, rejectDone: false };
  const inT = (st) => codes.filter((c) => st[c] === TO_WH);
  function oneRun(tC, rc) {
    if (tC.length > 0) {
      if (opts.mesReject && !opts.rejectDone) {
        opts.rejectDone = true;
        flow.steps.push({ act: 'MES拒绝', payload: tC.slice(), msg: opts.rejectMsg });
        if (!flow.retried) {
          flow.retried = true;
          const it2 = inT(reconState);
          if (it2.length) { flow.steps.push({ act: 'A兜底重预检命中', rc: it2.slice() }); return oneRun(codes.filter((c) => !it2.includes(c)), it2); }
          // 兜底查无仓位 → 解析拒绝文案
          if (saysAtTarget(opts.rejectMsg || '', TO_WH)) {
            flow.steps.push({ act: '文案确认在目标仓→人工窗' });
            if (opts.userConfirm) { flow.steps.push({ act: '用户确认入账' }); return oneRun([], codes); } // recon=全部，纯对账
            flow.steps.push({ act: '用户取消不入账' }); return flow;
          }
          flow.steps.push({ act: '真不在目标仓→仅提示逐框' }); return flow;
        }
        flow.steps.push({ act: '仍被拒' }); return flow;
      }
      flow.steps.push({ act: 'MES转单', payload: tC.slice() });
    }
    flow.writeCodes = codes.slice();
    flow.reconMark = rc.length ? rc.slice() : null;
    flow.ledgerCodes = codes.slice();
    return flow;
  }
  const pre = inT(preState);
  flow.precheck = pre.slice();
  return oneRun(codes.filter((c) => !pre.includes(c)), pre);
}

console.log('===== A1 11/4 现场卡单回放（两框 MES 均在线边仓 → 纯对账）=====');
const f1 = runFlow(codes1104, { N26J250226: TO_WH, N26J250225: TO_WH }, {});
T('A1a 预检识别两框均在目标仓', f1.precheck, codes1104);
T('A1b 纯对账零MES调用', f1.steps, []);
T('A1c 回写codes=全部勾选框', f1.writeCodes, codes1104);
T('A1d recon标记送服务器留痕', f1.reconMark, codes1104);

console.log('\n===== A2 部分对账（250226 已转、250225 仍在源仓）=====');
const f2 = runFlow(codes1104, { N26J250226: TO_WH, N26J250225: SRC_WH }, {});
T('A2a 预检只认已转的250226', f2.precheck, ['N26J250226']);
T('A2b MES报文只含未转的250225', f2.steps, [{ act: 'MES转单', payload: ['N26J250225'], msg: undefined }]);
T('A2c 回写仍=两框', f2.writeCodes, codes1104);
T('A2d recon=250226', f2.reconMark, ['N26J250226']);

console.log('\n===== A3 正常全转（两框都在源仓）——旧行为零变化 =====');
const f3 = runFlow(codes1104, { N26J250226: SRC_WH, N26J250225: SRC_WH }, {});
T('A3a 预检空集=不弹对账窗', f3.precheck, []);
T('A3b MES报文=两框', f3.steps, [{ act: 'MES转单', payload: codes1104, msg: undefined }]);
T('A3c 无recon标记', f3.reconMark, null);

console.log('\n===== A4 首次预检漏网→MES拒绝→兜底重预检命中（双形态修复后典型）=====');
const f4 = runFlow(codes1104, {}, { mesReject: true, rejectMsg: '条码N26J250226已在焊·宁波-线边仓，不能重复调拨', reconState: { N26J250226: TO_WH, N26J250225: TO_WH } });
T('A4a 兜底链路：拒绝→重预检命中→纯对账', f4.steps, [{ act: 'MES拒绝', payload: codes1104, msg: '条码N26J250226已在焊·宁波-线边仓，不能重复调拨' }, { act: 'A兜底重预检命中', rc: codes1104 }]);
T('A4b 兜底后回写两框+recon', [f4.writeCodes, f4.reconMark], [codes1104, codes1104]);

console.log('\n===== A5 兜底也查无仓位→解析拒绝文案→人工确认入账（现场死局真解）=====');
const REJ = '条码N26J250226已在焊·宁波-线边仓，不能重复调拨';
const f5 = runFlow(codes1104, {}, { mesReject: true, rejectMsg: REJ, reconState: {}, userConfirm: true });
T('A5a 文案确认走人工窗+入账', f5.steps, [{ act: 'MES拒绝', payload: codes1104, msg: REJ }, { act: '文案确认在目标仓→人工窗' }, { act: '用户确认入账' }]);
T('A5b 确认后回写两框+recon（纯对账）', [f5.writeCodes, f5.reconMark], [codes1104, codes1104]);
const f5c = runFlow(codes1104, {}, { mesReject: true, rejectMsg: REJ, reconState: {}, userConfirm: false });
T('A5c 用户取消→不入账（单据保持备料中）', [f5c.steps.map((s) => s.act), f5c.writeCodes], [['MES拒绝', '文案确认在目标仓→人工窗', '用户取消不入账'], undefined]);
const f5d = runFlow(codes1104, {}, { mesReject: true, rejectMsg: '条码N26J250226已在焊-宁波-成品仓，不能重复调拨', reconState: {} });
T('A5d 文案仓名≠目标仓（真转去别处）→仅提示逐框不入账', [f5d.steps.map((s) => s.act), f5d.writeCodes], [['MES拒绝', '真不在目标仓→仅提示逐框'], undefined]);

console.log('\n===== A6 文案解析函数单测（·/-归一、含仓名判定）=====');
T('A6-1 中文间隔号·归一后相等', saysAtTarget('已在焊·宁波-线边仓，不能重复调拨', '焊-宁波-线边仓'), true);
T('A6-2 目标仓含claimed（子串）', saysAtTarget('已在焊-宁波-线边仓A区，不能重复调拨', '焊-宁波-线边仓'), true);
T('A6-3 仓名不符判否', saysAtTarget('已在焊-宁波-成品仓，不能重复调拨', '焊-宁波-线边仓'), false);
T('A6-4 无"已在"句式判否', saysAtTarget('条码非法，不能重复调拨', '焊-宁波-线边仓'), false);

console.log('\n===== A7 源码断言（实现与判据同步，防漂移）=====');
const pda = fs.readFileSync(path.join(__dirname, '../lib/requisition_page.dart'), 'utf8');
T('A7a 双形态查询（单参失败后带仓参重试）', /if \(got == null\) \{[\s\S]{0,340}warehouseCode/.test(pda), true);
T('A7b 仓库级比对（WAREHOUSE_NAME相等优先，未回名回退全串）', /if \(w\.isNotEmpty && tw\.isNotEmpty\) return w == tw;/.test(pda), true);
T('A7c 拒绝文案解析函数存在', /bool mesSaysAtTarget\(String msg\)/.test(pda), true);
T('A7d 文案确认走人工入账窗（列逐框诊断，不静默入账）', /mesSaysAtTarget\(msg\)[\s\S]{0,3200}按已转单入账/.test(pda), true);
T('A7e 入账走纯对账通道（runTransfer空实传+全recon）', /recon = codes;[\s\S]{0,90}runTransfer\(\[\], codes\)/.test(pda), true);
T('A7f 取消路径不入账（单据保持备料中）', /已取消：未入账，单据保持备料中/.test(pda), true);
T('A7g 纯对账跳过MES（boxes空不调SaveTR）', /if \(boxes\.isNotEmpty\) \{/.test(pda), true);
T('A7h 回写codes=全部issued勾选集（非仅实传）', /"codes": List\.from\(item\["issued"\] \?\? \[\]\)/.test(pda), true);
T('A7i recon 送服务器留痕', /if \(rc\.isNotEmpty\) "recon": rc/.test(pda), true);
T('A7j A兜底单次闸防死循环', /msg\.contains\("重复调拨"\) && !retriedRecon/.test(pda) && /retriedRecon = true/.test(pda), true);
T('A7k 预检并发分片5路+上限60框', /for \(var s = 0; s < cs\.length; s \+= 5\)/.test(pda) && /codes\.take\(60\)/.test(pda), true);
T('A7l 逐框诊断函数（查无/仓位可读）', /String mesLocDesc\(String c\)/.test(pda), true);
T('A7m 无残留旧死路文案（未检测到…请先在MES核对后重试）', /且未检测到已在目标仓的框——请先在 MES 核对该框位置后重试/.test(pda), false);
const svr = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
T('A7n 服务器留痕对账框', /对账入账：框 \$\{_rc\.join\('\/'\)\}/.test(svr), true);
T('A7o 服务器记账口径不受recon影响（codes唯一真源）', /const _sent = Array\.isArray\(b\.codes\)/.test(svr), true);

console.log('\n===== A8 真实卡单数据基线（服务器实况，不可变事实源）=====');
const r = (d.requisitions || []).find((x) => x.no === 'LL2026110409555589');
const it = r.items.find((i) => String(i.partNo) === '6608225548');
T('A8a 实况：accepted 未转单、两框在issued', [r.status, it.transferred ? 1 : 0, (it.issued || []).length], ['accepted', 0, 2]);
T('A8b 两框均已消位（实物离架，入账后端不复活）', (d.ledger || []).some((x) => codes1104.includes(x.c)), false);
T('A8c 服务器无任何出库单含这两码（本地确无转单记录=MES侧外部完成）', (() => { for (const o of Object.values(d.outbound || {})) for (const l of o.items || []) if (codes1104.includes(String(l.barcode || '').toUpperCase())) return false; return true; })(), true);

console.log(fail === 0 ? '\n===== 全部 PASS，合计 ' + total + ' 项 =====' : '\n===== ' + fail + '/' + total + ' 失败 =====');
process.exit(fail === 0 ? 0 : 1);
