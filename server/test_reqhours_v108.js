// ㉖v108 领料时段闸门 · 边界测试（复刻 server.js reqHoursGate 逐行一致）
let PARAMS = { reqHoursOn: 0, reqHours: '07:00-22:00' };
function P() { return PARAMS; }
function reqHoursGate(d) {
  d = d || new Date();
  if (!P().reqHoursOn) return { allow: true };
  const spec = String(P().reqHours || '').trim();
  if (!spec) return { allow: true };
  const mins = d.getHours() * 60 + d.getMinutes();
  const segs = spec.split(/[,，;；]/).map((s) => s.trim()).filter(Boolean);
  const parsed = [];
  for (const s of segs) {
    const m = s.match(/^(\d{1,2}):(\d{2})\s*[-~至]\s*(\d{1,2}):(\d{2})$/);
    if (!m) return { allow: true };
    const a = Number(m[1]) * 60 + Number(m[2]), b = Number(m[3]) * 60 + Number(m[4]);
    if (a > 1439 || b > 1439) return { allow: true };
    parsed.push([a, b]);
  }
  const inWin = parsed.some(([a, b]) => (a === b ? true : b > a ? (mins >= a && mins < b) : (mins >= a || mins < b)));
  if (inWin) return { allow: true };
  const fmt = (x) => String(Math.floor(x / 60)).padStart(2, '0') + ':' + String(x % 60).padStart(2, '0');
  return { allow: false, msg: '系统维护中：当前不在领料时段（' + parsed.map(([a, b]) => a === b ? '全天' : (b > a ? fmt(a) + '-' + fmt(b) : fmt(a) + '至次日' + fmt(b))).join('、') + '），时段外暂停下单。已有单据的接单/发料/签收不受影响' };
}
const at = (h, m) => { const d = new Date(2026, 10, 4, h, m); return d; };
let fail = 0, total = 0;
function T(n, a, b) { total++; const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) { fail++; console.log('FAIL ' + n + '\n  实际=' + JSON.stringify(a) + '\n  期望=' + JSON.stringify(b)); } else console.log('PASS ' + n); }

// ===== G1 开关关闭=全天放行（默认态，零行为变化） =====
PARAMS = { reqHoursOn: 0, reqHours: '07:00-22:00' };
T('G1a 开关关·凌晨放行', reqHoursGate(at(3, 0)).allow, true);
T('G1b 开关关·时段内放行', reqHoursGate(at(10, 0)).allow, true);

// ===== G2 单窗口 07:00-22:00（起含止不含） =====
PARAMS = { reqHoursOn: 1, reqHours: '07:00-22:00' };
T('G2a 06:59 拦', reqHoursGate(at(6, 59)).allow, false);
T('G2b 07:00 放行（起含）', reqHoursGate(at(7, 0)).allow, true);
T('G2c 21:59 放行', reqHoursGate(at(21, 59)).allow, true);
T('G2d 22:00 拦（止不含）', reqHoursGate(at(22, 0)).allow, false);
T('G2e 拦截文案含系统维护中+时段', [reqHoursGate(at(23, 0)).msg.includes('系统维护中'), reqHoursGate(at(23, 0)).msg.includes('07:00-22:00')], [true, true]);

// ===== G3 多段窗口（午休拆分） =====
PARAMS = { reqHoursOn: 1, reqHours: '07:00-11:30,13:00-17:30' };
T('G3a 11:30 拦（上午止不含）', reqHoursGate(at(11, 30)).allow, false);
T('G3b 12:00 拦（午休）', reqHoursGate(at(12, 0)).allow, false);
T('G3c 13:00 放行（下午起含）', reqHoursGate(at(13, 0)).allow, true);
T('G3d 17:30 拦', reqHoursGate(at(17, 30)).allow, false);
T('G3e 全角逗号/分号分隔兼容', (PARAMS = { reqHoursOn: 1, reqHours: '08:00-12:00，14:00-18:00' }) && reqHoursGate(at(9, 0)).allow && reqHoursGate(at(13, 0)).allow === false && reqHoursGate(at(15, 0)).allow, true);

// ===== G4 跨天窗口 22:00-06:00（夜班） =====
PARAMS = { reqHoursOn: 1, reqHours: '22:00-06:00' };
T('G4a 23:30 放行（尾段）', reqHoursGate(at(23, 30)).allow, true);
T('G4b 02:00 放行（次日头段）', reqHoursGate(at(2, 0)).allow, true);
T('G4c 06:00 拦（止不含）', reqHoursGate(at(6, 0)).allow, false);
T('G4d 12:00 拦（白天）', reqHoursGate(at(12, 0)).allow, false);
T('G4e 拦截文案标注至次日', reqHoursGate(at(12, 0)).msg.includes('22:00至次日06:00'), true);

// ===== G5 全天窗口（两段相等） =====
PARAMS = { reqHoursOn: 1, reqHours: '00:00-00:00' };
T('G5a 任意时刻放行', [reqHoursGate(at(0, 0)).allow, reqHoursGate(at(13, 0)).allow, reqHoursGate(at(23, 59)).allow], [true, true, true]);

// ===== G6 防锁死：异常配置一律放行（宁可漏拦不错锁全员） =====
T('G6a 空配置放行', (PARAMS = { reqHoursOn: 1, reqHours: '' }) && reqHoursGate(at(3, 0)).allow, true);
T('G6b 纯空格放行', (PARAMS = { reqHoursOn: 1, reqHours: '   ' }) && reqHoursGate(at(3, 0)).allow, true);
T('G6c 格式非法放行（防手滑配错）', (PARAMS = { reqHoursOn: 1, reqHours: '7点到22点' }) && reqHoursGate(at(3, 0)).allow, true);
T('G6d 半角缺分钟放行', (PARAMS = { reqHoursOn: 1, reqHours: '07:00-22' }) && reqHoursGate(at(3, 0)).allow, true);
T('G6e 越界时分放行', (PARAMS = { reqHoursOn: 1, reqHours: '25:00-26:00' }) && reqHoursGate(at(3, 0)).allow, true);
T('G6f 一段合法+一段非法=整体放行', (PARAMS = { reqHoursOn: 1, reqHours: '07:00-22:00,abc' }) && reqHoursGate(at(3, 0)).allow, true);

// ===== G7 生产源码接线核验 =====
const src = require('fs').readFileSync('server.js', 'utf8');
T('G7a POST /api/requisitions 接入时段闸（maint_window）', /reqHoursGate\(\); if \(!_hg\.allow\)[\s\S]{0,160}maint_window/.test(src), true);
T('G7b 闸门位置在权限校验后、读body前（最早拒绝零浪费）', src.indexOf('当前角色未开通领料下单') < src.indexOf('reqHoursGate(); if (!_hg.allow)') && src.indexOf('reqHoursGate(); if (!_hg.allow)') < src.indexOf('const b = await readBody(req);', src.indexOf('reqHoursGate(); if (!_hg.allow)')), true);
T('G7c gate 预检端点捎带 hours', /block: g\.block\.map\(wrap\), hours: reqHoursGate\(\)/.test(src), true);
T('G7d 仅拦 POST 下单：接单/发料/签收端点未引用 reqHoursGate', (src.match(/reqHoursGate/g) || []).length === 3, true); // 定义1 + POST闸1 + gate捎带1
T('G7e 参数已注册（开关+文本）', /reqHoursOn:\s*\{ grp: '领料闸门'/.test(src) && /reqHours:\s*\{ grp: '领料闸门', str: 1/.test(src), true);
const dsrc = require('fs').readFileSync('../lib/requisition_page.dart', 'utf8');
T('G7f PDA建单前预检弹维护窗', /hours[\s\S]{0,80}allow[\s\S]{0,400}系统维护中/.test(dsrc), true);

console.log(`\n===== ${total - fail}/${total} 通过 =====`);
process.exit(fail ? 1 : 0);
