// ㉖v117b 空格位编码修复 · 前端真实函数沙箱验证（跑 console.html 真 mxCell）
// 缺陷：占用矩阵空格位（title/点击复制/弹窗）编码=pre+'-'+pad(c)+suf，而调用方 pre 已含列号
// → NB02-B-11 列拼成 NB02-B-11-11-4F（双重列号），现场 11-06 截图实锤。修复后必须=真实账本口径 NB02-B-11-4F。
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const h = fs.readFileSync(path.join(__dirname, 'public', 'console.html'), 'utf8');
const NL = String.fromCharCode(10);
let fail = 0, total = 0;
const T = (n, a, b) => { total++; const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) { fail++; console.log('FAIL ' + n + '\n  实际=' + JSON.stringify(a) + '\n  期望=' + JSON.stringify(b)); } else console.log('PASS ' + n); };

// 抽取真实 mxCell 函数体（到 occBar 前）
const s0 = h.indexOf('const mxCell=(R,c,pre,suf)=>{');
const e0 = h.indexOf('const occBar=');
if (s0 < 0 || e0 < 0) { console.log('FATAL: 未找到 mxCell 段'); process.exit(2); }
const src = h.slice(s0, e0);

const ctx = {
  console, Math, String, Number, Array, Object, JSON,
  _esc: (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
  ctFreeSlot: () => { }, ctCell: () => { }, ctCopy: () => { }, cmode: 'age',
};
vm.createContext(ctx);
vm.runInContext(src + NL + 'globalThis.__mx=mxCell;', ctx);
const mxCell = ctx.__mx;

// 从渲染产物中提取编码（title="XXX · 空货位..." 或 onclick="ctFreeSlot('XXX')"）
function codeOf(htmlStr) {
  const m = String(htmlStr).match(/title="([^"]*) · 空货位/);
  const m2 = String(htmlStr).match(/ctFreeSlot\('([^']*)'\)/);
  return [m ? m[1] : null, m2 ? m2[1] : null];
}

// ===== 高架矩阵口径（调用方 1042 行：pre=k+'-'+pad(c)，suf='-1F'）=====
const rackOut = mxCell({cells:{}}, 11, 'NB02-B-' + String(11).padStart(2, '0'), '-4F');
T('M1 高架空格位编码不再双重列号（用户截图 B-11-11-4F → 应为 B-11-4F）', codeOf(rackOut), ['NB02-B-11-4F', 'NB02-B-11-4F']);
const rackOut2 = mxCell({cells:{}}, 13, 'NB02-B-' + String(13).padStart(2, '0'), '-1F');
T('M2 上一单截图格位同样修复（B-13-13-1F → B-13-1F）', codeOf(rackOut2), ['NB02-B-13-1F', 'NB02-B-13-1F']);

// ===== 地面矩阵口径（调用方 1058 行：pre=rowid+'-'+pad(c)，无 suf）=====
const gndOut = mxCell({cells:{}}, 7, 'NB03-A-11-' + String(7).padStart(2, '0'));
T('M3 地面空格位编码不再双重复位号（旧会拼成 NB03-A-11-07-07）', codeOf(gndOut), ['NB03-A-11-07', 'NB03-A-11-07']);

// ===== 有框格回归：仍用服务端真实 loc，不受影响 =====
ctx.cmode = 'age';
const hitR = { cells: { 11: { loc: 'NB02-B-11-4F', boxes: [{ p: '6608465038', q: 25, _h: 10 }] } } };
const hitOut = mxCell(hitR, 11, 'NB02-B-11', '-4F');
T('M4 有框格编码仍取真实loc（回归不破坏）', /title="NB02-B-11-4F｜1框/.test(hitOut), true);

// ===== 段数硬校验：真实账本 NB02 高架 loc=4段(NB02-巷-列-层)，产物必须一致 =====
const db = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'db.json'), 'utf8'));
const realLocs = [...new Set((db.ledger || []).map((x) => String(x.l || '').toUpperCase()).filter((l) => /^NB02-[A-H]-/.test(l)))];
T('M5 真实账本高架loc全部4段', realLocs.every((l) => l.split('-').length === 4), true);
const produced = codeOf(rackOut)[0].split('-').length;
T('M6 修复产物段数=真实loc口径(4段)', produced, 4);

console.log('\n===== v117b 空格位编码验证 ' + (total - fail) + '/' + total + ' 通过 =====');
process.exit(fail ? 1 : 0);
