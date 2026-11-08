// ㉖v127 传输层断连降噪 · 实例证明
// 现场：网页「服务器自身异常」面板出现 REQ POST /api/scanlog/sync · aborted（客户端上传中途关页面/切后台/网络抖动，Node 抛传输层错误被 logErr 误记）
// 修复：logErr 统一入口过滤纯传输断连 aborted/ECONNRESET/EPIPE/ERR_STREAM_*/socket hang up；真实 500/后台吞错/连RCS超时照记
// 手法：vm 沙箱跑真实 logErr 函数体（同 fifo/overshoot 套件），断言过滤边界
const fs = require('fs'); const vm = require('vm'); const path = require('path');
const SRV = path.join(__dirname, 'server.js');
const lines = fs.readFileSync(SRV, 'utf8').split(/\r?\n/);
let fail = 0, total = 0;
const T = (n, a, b) => { total++; const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) { fail++; console.log('FAIL ' + n + '\n  实际=' + JSON.stringify(a) + '\n  期望=' + JSON.stringify(b)); } else console.log('PASS ' + n); };
function grab(startSig, endSig) {
  let s = -1; for (let i = 0; i < lines.length; i++) if (lines[i].trim().startsWith(startSig)) { s = i; break; }
  if (s < 0) throw new Error('未找到起始: ' + startSig);
  let e = -1; for (let i = s + 1; i < lines.length; i++) if (lines[i].trim().startsWith(endSig)) { e = i; break; }
  if (e < 0) throw new Error('未找到结束: ' + endSig);
  return lines.slice(s, e).join('\n');
}
const ctx = { console, Math, String, Object, Array, JSON, RegExp, Date, isNaN, db: { sysErr: [] }, newId: (p) => p + '_' + (ctx.__n = (ctx.__n || 0) + 1), SYS_ERR_MAX: 500 };
vm.createContext(ctx);
vm.runInContext(grab('function logErr', '// ----') + '\nglobalThis.__logErr=logErr;', ctx);
const logErr = ctx.__logErr;
const len = () => ctx.db.sysErr.length;
const reset = () => { ctx.db.sysErr = []; };

// ===== 断连类：应被过滤，不入库 =====
reset(); logErr('REQ POST /api/scanlog/sync', Object.assign(new Error('aborted'), { code: 'ECONNABORTED' }));
T('D1 aborted 不入库（截图现场）', len(), 0);
reset(); logErr('REQ POST /api/scanlog/sync', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
T('D2 socket hang up 不入库', len(), 0);
reset(); logErr('REQ GET /api/sse', Object.assign(new Error('Premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' }));
T('D3 ERR_STREAM_PREMATURE_CLOSE 不入库', len(), 0);
reset(); logErr('REQ POST /x', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
T('D4 EPIPE 不入库', len(), 0);
reset(); logErr('REQ POST /x', { message: 'aborted', stack: '' }); // 无 code，仅 message 兜底
T('D5 无code仅message=aborted 不入库', len(), 0);

// ===== 真实错误：必须照记（过滤不能过宽吞真异常） =====
reset(); logErr('REQ POST /api/scanlog/sync', Object.assign(new TypeError('Cannot read properties of undefined'), { stack: 'a\nb\nc\nd\ne' }));
T('R1 TypeError 真实错误入库', len(), 1);
reset(); logErr('REQ GET /api/x', new Error('服务器错误：数据库写入失败'));
T('R2 业务中文错误入库', len(), 1);
reset(); logErr('dailySnap', Object.assign(new Error('ledger merge failed: Unique index violated'), { stack: 'x' }));
T('R3 Isar unique 类真错误入库（若发生在服务器侧须可见）', len(), 1);
reset(); logErr('RCS心跳', Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' })); // 服务器连 RCS 超时=真故障
T('R4 ETIMEDOUT 连接超时不被误吞（已移出过滤列表）', len(), 1);
reset(); logErr('REQ POST /x', new Error('ETIMEDOUT connecting to RCS'));
T('R5 message 含超时词的业务错误入库', len(), 1);

// ===== 环形上限不受影响 =====
reset(); for (let i = 0; i < 600; i++) logErr('REQ GET /x', new Error('err' + i));
T('C1 sysErr 上限 500 生效', len(), 500);

// ===== 源码锚点：过滤块在位且早退 =====
const joined = lines.join('\n');
T('S1 logErr 过滤块在位', joined.includes('传输层断连降噪') && joined.includes('ERR_STREAM_PREMATURE_CLOSE'), true);
T('S2 过滤在 sysErr push 之前（早退）', (() => { const i = joined.indexOf('传输层断连降噪'); const j = joined.indexOf('db.sysErr.push'); return i > 0 && j > 0 && i < j; })(), true);
T('S3 ETIMEDOUT 已从 code 过滤列表移除', !/socket hang up\|ETIMEDOUT/.test(joined), true);

// ===== P 锚点：PDA 账本合并同码去重自愈（collection_ledger.dart） =====
const dart = fs.readFileSync(path.join(__dirname, '..', 'lib', 'collection_ledger.dart'), 'utf8');
T('P1 同码多行自愈块在位', dart.includes('同码多行自愈') && dart.includes('Unique index violated'), true);
T('P2 保留最新行删其余（按 assignedAt 降序）', dart.includes('g.sort((a, b) => b.assignedAt.compareTo(a.assignedAt))') && dart.includes('for (var i = 1; i < g.length; i++) dupIds.add(g[i].id)'), true);
T('P3 去重在 localMap 构建之前（否则仍漏删）', (() => { const i = dart.indexOf('同码多行自愈'); const j = dart.indexOf('final localMap = {for (final p in local)'); return i > 0 && j > 0 && i < j; })(), true);
T('P4 服务器同码重复行兜底去重（_seenCode）', dart.includes('final _seenCode = <String>{}') && dart.includes('if (!_seenCode.add(c)) continue;'), true);

console.log('\n===== v127 传输层断连降噪 实例证明 ' + (total - fail) + '/' + total + ' 通过 =====');
process.exit(fail ? 1 : 0);
