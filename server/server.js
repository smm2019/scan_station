// ===================== 豪斯特仓储协同 · 鉴权服务端 =====================
// 零依赖 Node.js（v18+），仅用内置模块；数据存 ./data/db.json（原子写）。
// 职责：账号登录发 token、角色与服务端鉴权、远程停用、按角色功能开关。
// 启动：node server.js   （默认 0.0.0.0:8099，可用环境变量 PORT/HOST 覆盖；8098 曾被旧进程占用弃用）
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '8099', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SESSION_TTL_MS = 12 * 3600 * 1000; // 12 小时滑动过期
const LOGIN_FAIL_LIMIT = 5; // 同一账号 1 分钟内最多失败 5 次
const LOGIN_FAIL_WINDOW_MS = 60 * 1000;

const ROLES = ['material', 'warehouse', 'admin']; // 物料员 / 仓管员 / 管理员
const ROLE_NAMES = { material: '物料员', warehouse: '仓管员', admin: '管理员' };
// 按角色功能开关（管理员可在线改；App 登录与心跳时拉取）
const DEFAULT_FEATURES = {
  material: { collect: false, inventory: false, export: true, mes_query: true, direct_transfer: false, requisition: true, receive_confirm: true, location_reg: false, admin_panel: false },
  warehouse: { collect: true, inventory: true, export: true, mes_query: true, direct_transfer: true, requisition: false, receive_confirm: false, location_reg: true, admin_panel: false },
  admin: { collect: true, inventory: true, export: true, mes_query: true, direct_transfer: true, requisition: true, receive_confirm: true, location_reg: true, admin_panel: true },
};
const FEATURE_NAMES = { collect: '采集录入', inventory: '盘点模式', export: '导出下载', mes_query: 'MES查询', direct_transfer: '直调转单', requisition: '领料下单', receive_confirm: '签收确认', location_reg: '位置登记', admin_panel: '管理后台' };

// ---------------- 存储 ----------------
function defaultDb() {
  const salt = crypto.randomBytes(16).toString('hex');
  return {
    users: [{
      id: 'u_admin', username: 'admin', name: '系统管理员', role: 'admin', enabled: true,
      salt, passHash: hashPw('admin123', salt), createdAt: new Date().toISOString(), mustChangePw: true,
    }],
    sessions: {}, // token -> {userId, createdAt, lastSeen}
    features: JSON.parse(JSON.stringify(DEFAULT_FEATURES)),
    requisitions: [], // 领料单
    notifications: [], // 站内通知（拉取即已读）
    ledger: [], // 货位账本（PDA 同步上来的全量快照：[{c:标签,l:货位,f:料框,t:时间戳}]）
    ledgerRev: 0, ledgerAt: '', ledgerBy: '', // 账本版本号/最后同步时间/同步人
    scanlog: {}, // 采集流水（PDA 全量推送，键=标签|批次|时间）
    scanlogAt: '', scanlogCount: 0,
    outbound: {}, // 出库单（按单号存最新快照）
    outboundAt: '', outboundCount: 0,
  };
}
function loadDb() {
  if (!fs.existsSync(DB_FILE)) { const d = defaultDb(); saveDb(d); console.log('[init] 已创建初始账号 admin / admin123（首次登录需改密）'); return d; }
  const d = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  // 合并新增功能键：旧数据文件缺的键按默认值补齐（已有键保留管理员改过的值）
  let merged = false;
  for (const role of ROLES) {
    d.features[role] = d.features[role] || {};
    for (const [k, v] of Object.entries(DEFAULT_FEATURES[role] || {})) {
      if (!(k in d.features[role])) { d.features[role][k] = v; merged = true; }
    }
  }
  if (merged) { saveDb(d); console.log('[init] 功能开关已合并新增键'); }
  // 领料单/通知集合补齐（旧数据文件首次升级）
  let added = false;
  if (!Array.isArray(d.requisitions)) { d.requisitions = []; added = true; }
  if (!Array.isArray(d.notifications)) { d.notifications = []; added = true; }
  if (!Array.isArray(d.ledger)) { d.ledger = []; added = true; }
  if (typeof d.ledgerRev !== 'number') { d.ledgerRev = 0; added = true; }
  if (typeof d.scanlog !== 'object' || d.scanlog === null || Array.isArray(d.scanlog)) { d.scanlog = {}; added = true; }
  if (typeof d.outbound !== 'object' || d.outbound === null || Array.isArray(d.outbound)) { d.outbound = {}; added = true; }
  if (added) { saveDb(d); console.log('[init] 已补齐领料单/通知/货位账本集合'); }
  return d;
}
function saveDb(db) { // 原子写：临时文件 + rename
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DB_FILE);
}
function hashPw(pw, salt) { return crypto.scryptSync(String(pw), salt, 32).toString('hex'); }
function newId(p) { return p + '_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'); }
function newToken() { return crypto.randomBytes(24).toString('hex'); }
function safeUser(u) { return { id: u.id, username: u.username, name: u.name, role: u.role, enabled: u.enabled, mustChangePw: !!u.mustChangePw }; }

// ---------------- 领料单辅助 ----------------
const REQ_STATUS_TEXT = { pending: '待接单', accepted: '备料中', ready: '已备齐', done: '已完成', rejected: '已拒绝', cancelled: '已取消' };
function reqItemsText(r) { return r.items.map(i => `${i.partNo}×${i.qty}`).join('、'); }
// 下单通知用：每行零件×数量→建议货位（同步账本 FIFO），无数据标"待补齐/无货"
function reqItemsSuggestText(r) {
  return r.items.map(i => {
    const excl = new Set(((i.issued || []).map(x => String(typeof x === 'string' ? x : (x.c || '')).toUpperCase()).filter(Boolean)));
    const sg = pickSuggest(i.partNo, Number(i.qty) || 0, excl);
    if (sg.boxes.length) return `${i.partNo}×${i.qty}→${sg.boxes.slice(0, 3).map(b => b.l).join('/')}${sg.boxes.length > 3 ? '…' + sg.boxes.length + '框' : ''}`;
    return `${i.partNo}×${i.qty}→${sg.inStock ? '待补齐' : '无货'}`;
  }).join('、');
}
function notify(toUserId, type, text, reqId) {
  db.notifications.push({ id: newId('n'), to: toUserId, type, text, reqId: reqId || '', time: new Date().toISOString(), read: false });
  if (db.notifications.length > 500) db.notifications = db.notifications.slice(-500); // 只留最近500条防膨胀
}
function findReq(id) { return db.requisitions.find(r => r.id === id); }
// 指定超时清扫：pending 且超过 assignOpenAt → 解除指定锁定，广播给全部仓管可接单
function sweepAssignOpen() {
  const now = Date.now();
  let changed = false;
  for (const r of db.requisitions) {
    if (r.status !== 'pending' || !r.assigneeId || !r.assignOpenAt) continue;
    if (now < Date.parse(r.assignOpenAt)) continue;
    r.assignOpenAt = '';
    r.history.push({ time: new Date().toISOString(), by: '系统', text: `指定 ${r.assigneeName || ''} 超时未接单，已放开给全部仓管` });
    notify(r.assigneeId, 'req_timeout', `领料单 ${r.no} 超时未接单，已放开给全部仓管`, r.id);
    db.users.filter(x => x.role === 'warehouse' && x.enabled && x.id !== r.assigneeId).forEach(x =>
      notify(x.id, 'req_new', `领料单 ${r.no}（${r.byName}）已放开，可接单：${reqItemsSuggestText(r)}`, r.id));
    changed = true;
  }
  if (changed) save();
}
// 框键：有托号按托号合并（整托多码=1框）；无托号按"同货位+同零件号"合并（与PDA库存口径一致）；都缺才一码一框
function boxKeyOf(x) {
  const pid = String(x.pid || '').toUpperCase();
  if (pid) return 'P|' + pid;
  const l = String(x.l || '').toUpperCase(), p = String(x.p || '').toUpperCase();
  return (l && p) ? 'L|' + l + '|' + p : 'C|' + String(x.c).toUpperCase();
}
function groupLedgerBoxes(list) {
  const g = new Map();
  for (const x of list) {
    const k = boxKeyOf(x);
    if (!g.has(k)) g.set(k, { codes: [], items: [], l: x.l, q: 0, b: String(x.b || ''), f: String(x.f || ''), pid: String(x.pid || '') });
    const box = g.get(k);
    box.codes.push(x.c); box.items.push({ c: x.c, q: Number(x.q) || 0 });
    box.q = Math.max(box.q, Number(x.q) || 0); // MES每码数量都是整框数→取单码值不取和，同框多码不翻倍
    if (x.b && (!box.b || String(x.b) < box.b)) box.b = String(x.b); // 批次取最早
  }
  return [...g.values()].sort((a, b) => (a.b || '9999').localeCompare(b.b || '9999') || String(a.l).localeCompare(String(b.l))); // 批次早优先
}
function agvMapOf(i) { const m = {}; for (const e of ((i && i.agvCalled) || [])) m[String(e.c).toUpperCase()] = String(e.s || '') || '已叫'; return m; }
// 取货建议：PDA 同步的货位账本（含托号 pid）→ 按框（同托多码=1框）FIFO 选框；agvMap 标记已叫AGV的框
function pickSuggest(partNo, needQty, excludeCodes, agvMap) {
  const agv = agvMap || {};
  const ex = excludeCodes || new Set();
  const match = db.ledger.filter(x => String(x.p || '').toUpperCase() === String(partNo || '').toUpperCase());
  const boxes = groupLedgerBoxes(match).filter(bx => !bx.codes.some(c => ex.has(String(c).toUpperCase()))); // 框内任一标签已发→整框剔除（一框一发）
  let acc = 0; const pick = [];
  for (const x of boxes) {
    const called = x.codes.map(c => agv[String(c).toUpperCase()]).find(Boolean) || '';
    x.agv = called; // 框内任一标签叫过AGV → 整框标记（一框一车，同托标签一起走）
    pick.push(x);
    acc += x.q;
    if (needQty > 0 && acc >= needQty) break;
    if (pick.length >= 24) break; // 最多建议 24 框（大单一筐20件×25框也能覆盖大半）
  }
  const flatBoxes = pick.flatMap(g0 => g0.items.map(it => ({ c: it.c, q: it.q, l: g0.l, b: g0.b, f: g0.f, agv: g0.agv }))); // 标签级：供逐码复制/扫码
  const noInfoKeys = new Set();
  for (const x of match) if (!x.q) noInfoKeys.add(boxKeyOf(x));
  return { boxes: pick, flatBoxes, total: acc, inStock: boxes.length, noInfoQty: noInfoKeys.size };
}
function reqView(r) {
  const items = (r.items || []).map(i => {
    const excl = new Set(((i.issued || []).map(x => String(typeof x === 'string' ? x : (x.c || '')).toUpperCase()).filter(Boolean)));
    return { ...i, suggest: pickSuggest(i.partNo, Number(i.qty) || 0, excl, agvMapOf(i)) };
  });
  return { ...r, items, statusText: REQ_STATUS_TEXT[r.status] || r.status };
}
function issuedOf(i) { return (i.issued || []).map(x => typeof x === 'string' ? { c: x, q: 0, l: '' } : { c: String(x.c || ''), q: Number(x.q) || 0, l: String(x.l || '') }); }
function uniqCodes(arr) { return [...new Set(arr.map(s => String(s).toUpperCase()))]; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
// 领料单打印页（A4，含零件号/物料名/申请数/已发数 + 手写货位/标签空栏；复制零件号可选文本）
function renderReqPrint(r) {
  const time = (r.createdAt || '').slice(0, 16).replace('T', ' ');
  const rows = r.items.map((i, idx) => {
    const got = issuedOf(i).reduce((s, e) => s + e.q, 0);
    const codes = issuedOf(i).map(e => e.c).join(' ');
    const needQ = Number(i.qty) || 0;
    const overQ = got > needQ ? got - needQ : 0;
    // PDA 转单进度回写纸面：已转→绿色✓；跳过→灰色✗
    let stMark = '';
    if (i.transferred) stMark = ` <span style="color:#0a7d32;font-weight:bold">✓已转${got >= needQ ? '' : '(短装)'}</span>`;
    else if (i.skipped) stMark = ' <span style="color:#999">✗跳过</span>';
    if (overQ > 0) stMark += ` <span style="color:#e65100;font-weight:bold">（多发${overQ}件·整框发出）</span>`;
    // 货位列：系统按同步账本 FIFO 给建议；没数据则留手写格
    const sg = i.transferred || i.skipped ? null : pickSuggest(i.partNo, Number(i.qty) || 0, new Set(issuedOf(i).map(e => String(e.c).toUpperCase())), agvMapOf(i));
    let locCell = '';
    if (sg && sg.boxes.length) {
      // 框级渲染：1框=1行（同托多码并列、件数为框合计），已叫AGV的框标橙色
      locCell = sg.boxes.map(bx => {
        const qs = [...new Set(bx.items.map(it => it.q).filter(Boolean))];
        const qTxt = qs.length === 1 ? `各${qs[0]}件` : (qs.length ? `共${bx.q}件` : '');
        const agvTag = bx.agv ? ` <span style="color:#e65100;font-weight:bold">🚗${esc(bx.agv)}</span>` : '';
        return `<div style="font-size:11px;line-height:1.35;margin-bottom:2px">${esc(bx.l)}${qTxt ? ` <span style="color:#888">${qTxt}</span>` : ''}${agvTag}`
          + `<div style="color:#666;font-family:Consolas,monospace;font-size:10px;padding-left:8px">${bx.codes.map(esc).join(' / ')}</div></div>`;
      }).join('');
    } else if (sg && !sg.boxes.length) {
      locCell = `<span style="color:#c00;font-size:11px">${sg.inStock ? '缺物料信息' : '账本无此件'}</span>`;
    }
    return `<tr${i.transferred ? ' style="background:#f2fbf5"' : (i.skipped ? ' style="background:#f7f7f7;color:#999"' : '')}>
      <td>${idx + 1}</td>
      <td class="pn selectable">${esc(i.partNo)}</td>
      <td>${esc(i.itemName || '')}</td>
      <td class="num">${esc(i.qty)}</td>
      <td class="num">${got}${got >= (Number(i.qty) || 0) && !i.skipped ? ' ✔' : ''}${stMark}</td>
      <td class="handwrite${i.transferred ? '' : ' sug'}">${i.transferred ? esc((r.toLoc && r.toLoc.LOC_NAME) || '') : locCell}</td>
      <td class="handwrite small">${esc(codes)}</td>
    </tr>`;
  }).join('');
  const pad = r.items.length < 6 ? Array.from({ length: 6 - r.items.length }).map((_, k) =>
    `<tr><td class="blank"></td><td class="blank"></td><td class="blank"></td><td class="blank"></td><td class="blank"></td><td class="handwrite blank"></td><td class="handwrite blank"></td></tr>`).join('') : '';
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>领料单 ${esc(r.no)}</title>
<style>
  *{box-sizing:border-box}body{font-family:"Microsoft YaHei",Arial;margin:24px;color:#111}
  h1{font-size:22px;text-align:center;margin:0 0 4px}
  .meta{display:flex;justify-content:space-between;font-size:13px;margin:10px 0 6px}
  .meta span{margin-right:18px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{border:1px solid #333;padding:6px 8px;text-align:left}
  th{background:#f0f0f0;text-align:center}
  .num{text-align:center}.pn{font-family:Consolas,monospace}
  .handwrite{background:#fffef8}
  .handwrite.sug{background:#f0f4ff;padding:3px 5px}
  .handwrite.small{font-size:11px;color:#666;font-family:Consolas,monospace}
  .blank{height:30px}
  .sign{margin-top:26px;font-size:13px;display:flex;justify-content:space-between}
  .sign u{display:inline-block;min-width:120px;border-bottom:1px solid #333}
  .tip{margin-top:14px;font-size:11px;color:#888}
  @media print{body{margin:8mm}.noprint{display:none}}
  .noprint{margin-bottom:14px}.noprint button{font-size:14px;padding:8px 18px;cursor:pointer}
</style></head><body>
  <div class="noprint"><button onclick="window.print()">🖨 打印本单（Ctrl+P 亦可）</button> <span style="font-size:12px;color:#666">零件号可直接鼠标选中复制</span></div>
  <h1>领&nbsp;&nbsp;料&nbsp;&nbsp;单</h1>
  <div class="meta"><span>单号：<b>${esc(r.no)}</b></span><span>领料人：${esc(r.byName)}</span><span>日期：${esc(time)}</span></div>
  <div class="meta"><span>状态：${esc(REQ_STATUS_TEXT[r.status] || r.status)}</span><span>备注：${esc(r.remark || '')}</span></div>
  ${r.shortInfo ? `<div class="meta"><span style="color:#c00">短装：${esc(r.shortInfo)}</span></div>` : ''}
  <table><thead><tr>
    <th style="width:6%">#</th><th style="width:21%">零件号</th><th style="width:21%">物料名称</th>
    <th style="width:9%">申请数</th><th style="width:9%">已发数</th><th style="width:17%">货位(手写)</th><th style="width:17%">箱标签/实发(手写)</th>
  </tr></thead><tbody>${rows}${pad}</tbody></table>
  <div class="sign"><span>发料人：<u></u></span><span>领料人：<u></u></span><span>日期：<u></u></span></div>
  <div class="tip">说明：申请数/已发数按件计；「货位」由仓管备料时手写实际取货库位，便于对照寻找；本单随货流转，双方签字后仓管留存。</div>
</body></html>`;
}

// 领料工作台（电脑端）：待办+备料中单据列表，一键逐张打印
function renderReqBoard() {
  const open = db.requisitions.filter(r => ['pending', 'accepted'].includes(r.status)).reverse();
  const rowsHtml = open.length ? open.map(r => {
    const items = r.items || [];
    const doneN = items.filter(i => i.transferred || i.skipped).length;
    const prog = `${doneN}/${items.length} 行`;
    const stTag = r.status === 'pending' ? '<span style="color:#c77700">待接单</span>' : '<span style="color:#2456c9">备料中</span>';
    const itemLines = items.map(i => {
      const got = issuedOf(i).reduce((s, e) => s + e.q, 0);
      let mark = '';
      if (i.transferred) mark = ` <b style="color:#0a7d32">✓已转${got >= (Number(i.qty) || 0) ? '' : '(短装)'}</b>`;
      else if (i.skipped) mark = ' <span style="color:#999">✗跳过</span>';
      else if (got > 0) mark = ` <span style="color:#c77700">已扫${got}件</span>`;
      let sugHtml = '';
      if (!i.transferred && !i.skipped) {
        const excl = new Set(((i.issued || []).map(x => String(typeof x === 'string' ? x : (x.c || '')).toUpperCase()).filter(Boolean)));
        const sg = pickSuggest(i.partNo, Number(i.qty) || 0, excl);
        sugHtml = sg.boxes.length
          ? ` <span style="color:#3949AB">→ ${sg.boxes.slice(0, 3).map(b => esc(b.l)).join(' / ')}${sg.boxes.length > 3 ? ' …' + sg.boxes.length + '框' : ''}</span>`
          : ` <span style="color:#c00">→ ${sg.inStock ? '待补齐' : '账本无此件'}</span>`;
      }
      return `<div class="it">${esc(i.partNo)} ${esc(i.itemName || '')}　申请${esc(i.qty)}${mark}${sugHtml}</div>`;
    }).join('');
    return `<div class="card">
      <div class="hd"><b>${esc(r.no)}</b> ｜ ${esc(r.byName)} ｜ ${(r.createdAt || '').slice(5, 16).replace('T', ' ')} ｜ ${stTag} ｜ ${prog}
        <button class="btn" onclick="window.open('/print/requisition?id=${encodeURIComponent(r.id)}')">🖨 打印</button></div>
      ${itemLines}
      ${r.remark ? `<div class="rm">备注：${esc(r.remark)}</div>` : ''}
    </div>`;
  }).join('') : '<div class="empty">当前没有待处理领料单 ✅</div>';
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>领料工作台</title>
<style>
  body{font-family:"Microsoft YaHei",Arial;margin:20px;background:#f5f6fa;color:#111}
  h1{font-size:20px;margin:0 0 4px}
  .sub{font-size:12px;color:#777;margin-bottom:14px}
  .bar{margin-bottom:14px}
  .bar button{font-size:14px;padding:8px 16px;cursor:pointer;margin-right:8px}
  .card{background:#fff;border:1px solid #e2e4ee;border-radius:10px;padding:12px 14px;margin-bottom:10px}
  .hd{display:flex;align-items:center;gap:8px;font-size:14px;margin-bottom:6px}
  .hd .btn{margin-left:auto;font-size:13px;padding:5px 12px;cursor:pointer}
  .it{font-size:13px;padding:3px 0;border-top:1px dashed #eee}
  .rm{font-size:12px;color:#888;margin-top:4px}
  .empty{text-align:center;color:#4caf50;font-size:15px;padding:40px;background:#fff;border-radius:10px}
</style></head><body>
<h1>领料工作台</h1>
<div class="sub">仓管接单后自动出现在这里；打印出的单据随货流转，PDA 扫码转单进度会回写到打印页。每 10 秒自动刷新。</div>
<div class="bar"><button onclick="location.reload()">⟳ 刷新</button><button onclick="printAll()">🖨 全部打印（逐张）</button></div>
<div id="list">${rowsHtml}</div>
<script>
function printAll(){
  const ids=${JSON.stringify(open.map(r => r.id))};
  if(!ids.length){alert('没有可打印的单据');return;}
  // 逐张打开打印页（浏览器允许一次多标签即可连续打印）
  ids.forEach((id,i)=>setTimeout(()=>window.open('/print/requisition?id='+encodeURIComponent(id)),i*400));
}
setInterval(()=>location.reload(),10000);
</script></body></html>`;
}

// 货位账本查询页（电脑端公开）：按框一行（同托多码/同位同件合并），顶部搜索框支持标签号/货位前缀
function renderLedgerBoard() {
  const g = new Map();
  for (const x of db.ledger) {
    const k = boxKeyOf(x);
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(x);
  }
  const boxRows = [...g.values()].sort((a, b) => String(a[0].l).localeCompare(String(b[0].l)) || String(a[0].c).localeCompare(String(b[0].c)));
  const meta = `共 ${db.ledger.length} 个标签 · ${boxRows.length} 框 · ${new Set(db.ledger.map(x => x.l)).size} 个货位有货`;
  const info = db.ledgerAt ? `最后同步 ${esc(String(db.ledgerAt).slice(0, 19).replace('T', ' '))}（${esc(db.ledgerBy || '-')}，v${db.ledgerRev}）` : '尚未从 PDA 同步过';
  const bodyRows = boxRows.map(xs => {
    const first = xs[0];
    const q = Math.max(...xs.map(x => Number(x.q) || 0)); // 每码数量都是整框数→取单码值不求和
    const ts = xs.map(x => x.t).filter(Boolean);
    const t = ts.length ? new Date(Math.min(...ts)).toLocaleString('zh-CN', { hour12: false }) : '';
    const codes = xs.map(x => x.c);
    const multi = codes.length > 1 ? ` <span class="multi">${codes.length}码1框</span>` : '';
    const mvTxt = first.mv ? ` <span style="color:${first.mv==='AGV'?'#1565C0':'#888'}">${esc(first.mv)}${first.src&&first.mv==='AGV'?'←'+esc(first.src):''}</span>` : '';
    return `<tr data-c="${esc(codes.join(' '))}" data-l="${esc(first.l)}" data-p="${esc(first.p || '')}" data-n="${esc(first.n || '')}"><td class="loc">${esc(first.l)}</td><td class="code">${esc(codes.join(' / '))}${multi}${mvTxt}</td><td class="pn">${esc(first.p || '')}</td><td>${esc(first.n || '')}</td><td class="num">${q ? esc(q) : ''}</td><td>${esc(first.b || '')}</td><td>${esc(first.f || '')}</td><td class="tm">${esc(t)}</td></tr>`;
  }).join('');
  const empty = boxRows.length ? '' : `<div class="empty">账本为空：请在 PDA「位置登记」导入账本或登记库位，同步后这里自动出现数据。</div>`;
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>货位账本</title>
<style>
  body{font-family:"Microsoft YaHei",Arial;margin:20px;background:#f5f6fa;color:#111}
  h1{font-size:20px;margin:0 0 4px}
  .sub{font-size:12px;color:#777;margin-bottom:12px}
  .bar{margin-bottom:12px;display:flex;gap:8px;align-items:center}
  .bar input{font-size:14px;padding:7px 10px;border:1px solid #ccc;border-radius:6px;width:280px}
  .bar button{font-size:13px;padding:7px 14px;cursor:pointer;border:1px solid #515BD4;background:#fff;color:#515BD4;border-radius:6px}
  .cnt{font-size:12px;color:#666}
  table{width:100%;border-collapse:collapse;font-size:13px;background:#fff}
  th,td{border:1px solid #e2e4ee;padding:5px 8px;text-align:left}
  th{background:#eef0fa;position:sticky;top:0}
  .loc{font-family:Consolas,monospace;font-weight:600;color:#2456c9}
  .code{font-family:Consolas,monospace}
  .tm{color:#888;font-size:12px}
  .multi{font-size:11px;color:#e65100;font-weight:600}
  tr.hl{background:#fff3cd}
  .empty{text-align:center;color:#c77700;font-size:14px;padding:40px;background:#fff;border-radius:10px}
</style></head><body>
<h1>货位账本（PDA 同步）</h1>
<div class="sub">${meta} ｜ ${info}</div>
<div class="bar"><input id="q" placeholder="输入标签号或货位前缀（如 NB03-A-13）过滤" oninput="flt()"><button onclick="location.reload()">⟳ 刷新</button><span class="cnt" id="cnt"></span></div>
${empty}<table id="tb"${boxRows.length ? '' : ' style="display:none"'}><thead><tr><th style="width:14%">货位</th><th style="width:20%">标签号</th><th style="width:13%">零件号</th><th style="width:18%">物料名称</th><th style="width:8%">数量</th><th style="width:9%">批次</th><th style="width:10%">料框</th><th>登记时间</th></tr></thead><tbody>${bodyRows}</tbody></table>
<script>
function flt(){
  const q=document.getElementById('q').value.trim().toUpperCase();
  const rs=document.querySelectorAll('#tb tbody tr');
  let n=0;
  rs.forEach(r=>{
    const hit=!q || r.dataset.c.includes(q) || r.dataset.l.includes(q) || (r.dataset.p||'').toUpperCase().includes(q) || (r.dataset.n||'').toUpperCase().includes(q);
    r.style.display=hit?'':'none';
    r.classList.toggle('hl', !!q && (r.dataset.c === q || r.dataset.c.split(' ').includes(q)));
    if(hit&&q)n++;
  });
  document.getElementById('cnt').textContent=q?('匹配 '+n+' 行'):'';
}
setInterval(()=>{if(!document.getElementById('q').value)location.reload();},60000);
</script></body></html>`;
}

// 数据核对看板（电脑端公开）：展示 PDA 同步上来的采集流水 / 出库单 / 货位账本状态
function renderDataBoard() {
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>数据核对（电脑库）</title>
<style>
  body{font-family:"Microsoft YaHei",Arial;margin:18px;background:#f5f6fa;color:#111}
  h1{font-size:19px;margin:0 0 4px}
  .sub{font-size:12px;color:#777;margin-bottom:10px}
  .badges{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
  .b{background:#fff;border:1px solid #e2e4ee;border-radius:8px;padding:6px 12px;font-size:12px;color:#555}
  .b b{font-size:16px;color:#2456c9;margin-right:4px}
  .tabs{margin-bottom:10px;display:flex;align-items:center;flex-wrap:wrap;gap:6px}
  .tabs button.tb{font-size:13px;padding:6px 14px;cursor:pointer;border:1px solid #515BD4;background:#fff;color:#515BD4;border-radius:6px}
  .tabs button.tb.on{background:#515BD4;color:#fff}
  #q{font-size:13px;padding:6px 9px;border:1px solid #ccc;border-radius:6px;width:260px}
  table{width:100%;border-collapse:collapse;font-size:12.5px;background:#fff}
  th,td{border:1px solid #e2e4ee;padding:4px 6px;text-align:left}
  th{background:#eef0fa}
  .mono{font-family:Consolas,monospace}
  .cx{color:#c00;font-weight:bold}
  .ck{color:#0a7d32}
  .empty{color:#c77700;font-size:14px;padding:24px;background:#fff;border-radius:8px;text-align:center}
</style></head><body>
<h1>数据核对 · 电脑数据库</h1>
<div class="sub" id="meta">加载中…</div>
<div class="badges" id="badges"></div>
<div class="tabs">
  <button class="tb on" id="btScan" onclick="sw('scan')">采集流水</button>
  <button class="tb" id="btOb" onclick="sw('ob')">出库单</button>
  <button class="tb" id="btInv" onclick="sw('inv')">库存(账本)</button>
  <input id="q" placeholder="搜索标签/零件/操作人/货位" oninput="flt()">
  <button class="tb" onclick="loadAll()">⟳ 刷新</button>
  <a href="/board/ledger" style="font-size:12px;color:#515BD4;margin-left:8px">货位账本 →</a>
</div>
<div id="boxScan"><div class="empty">加载中…</div></div>
<div id="boxOb" style="display:none"></div>
<div id="boxInv" style="display:none"></div>
<script>
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function t2s(ms){if(!ms)return '';try{return new Date(ms).toLocaleString('zh-CN',{hour12:false})}catch(e){return ''}}
function iso2s(x){if(!x)return '—';try{return new Date(x).toLocaleString('zh-CN',{hour12:false})}catch(e){return x}}
var scans=[],obs=[],led=[];
function sw(k){['scan','ob','inv'].forEach(function(t){var K=t[0].toUpperCase()+t.slice(1);document.getElementById('bt'+K).className='tb'+(k===t?' on':'');document.getElementById('box'+K).style.display=k===t?'':'none'})}
function jg(u){return fetch(u).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()})}
function loadAll(){
  document.getElementById('meta').textContent='加载中…';
  Promise.all([jg('/api/scanlog?limit=5000'),jg('/api/outbound'),jg('/api/ledger?l=')]).then(function(a){
    var s=a[0],o=a[1],l=a[2];scans=s.items||[];obs=o.items||[];led=l.items||[];
    document.getElementById('badges').innerHTML=
      '<div class="b"><b>'+(s.total||0)+'</b>采集流水<br>最后同步 '+esc(iso2s(s.at))+'</div>'+
      '<div class="b"><b>'+(o.total||0)+'</b>出库单<br>最后同步 '+esc(iso2s(o.at))+'</div>'+
      '<div class="b"><b>'+(l.total||0)+'</b>账本标签 v'+(l.rev||0)+'<br>最后同步 '+esc(iso2s(l.at))+'（'+esc(l.by||'-')+'）</div>';
    document.getElementById('meta').textContent='流水表显示最近 '+scans.length+' 条（库中共 '+(s.total||0)+'）；出库共 '+obs.length+' 张；30 秒自动刷新';
    rs();ro();ri();
  }).catch(function(e){document.getElementById('meta').textContent='加载失败：'+e.message+'（请确认 PDA 已配置服务器并完成同步）'});
}
function flt(){rs();ro();if(document.getElementById('boxInv').style.display!=='none')ri()}
function rs(){
  var q=document.getElementById('q').value.trim().toUpperCase();
  var arr=scans;
  if(q)arr=arr.filter(function(x){return ((x.code||'')+(x.pn||'')+(x.op||'')+(x.gl||'')+(x.st||'')+(x.batch||'')).toUpperCase().indexOf(q)>=0});
  var box=document.getElementById('boxScan');
  if(!arr.length){box.innerHTML='<div class="empty">'+(scans.length?'无匹配记录':'暂无流水：PDA 采集保存后 1 分钟内自动同步到这里')+'</div>';return}
  box.innerHTML='<table><thead><tr><th>时间</th><th>标签</th><th>作业</th><th>位置</th><th>容器</th><th>操作人</th><th>零件号</th><th>数量</th><th>批次</th><th>状态</th></tr></thead><tbody>'+
    arr.map(function(x){
      var pos=x.wt===0?(x.st||''):(x.gl||'');
      return '<tr><td class="mono">'+t2s(x.t)+'</td><td class="mono">'+esc(x.code)+'</td><td>'+(x.wt===0?'AGV站台':'地面')+'</td><td class="mono">'+esc(pos)+'</td><td>'+esc(x.ct||'')+'</td><td>'+esc(x.op||'')+'</td><td class="mono">'+esc(x.pn||'')+'</td><td>'+esc(x.q||'')+'</td><td class="mono">'+esc(x.lot||'')+'</td><td>'+(x.cx?'<span class="cx">已作废</span>':'<span class="ck">正常</span>')+'</td></tr>'}).join('')+'</tbody></table>';
}
function ro(){
  var q=document.getElementById('q').value.trim().toUpperCase();
  var arr=obs;
  if(q)arr=arr.filter(function(x){return ((x.orderNo||'')+(x.operator||'')+(x.toLoc||'')+(x.linkReqNo||'')+JSON.stringify(x.items||[])).toUpperCase().indexOf(q)>=0});
  var box=document.getElementById('boxOb');
  if(!arr.length){box.innerHTML='<div class="empty">'+(obs.length?'无匹配出库单':'暂无出库单：直调/领料转MES 建单后自动同步')+'</div>';return}
  box.innerHTML='<table><thead><tr><th>出库单号</th><th>时间</th><th>操作人</th><th>转入货位</th><th>关联领料单</th><th>标签</th><th>核对</th><th>明细（标签·零件·数量·原货位）</th></tr></thead><tbody>'+
    arr.map(function(o){
      var its=o.items||[];var cked=its.filter(function(e){return e.checked===true}).length;
      return '<tr><td class="mono">'+esc(o.orderNo)+'</td><td class="mono">'+t2s(o.createdAt)+'</td><td>'+esc(o.operator||'')+'</td><td>'+esc(o.toLoc||'')+'</td><td class="mono">'+esc(o.linkReqNo||'')+'</td><td>'+its.length+'</td><td>'+(its.length&&cked===its.length?'<span class="ck">全部已核对</span>':cked+'/'+its.length)+'</td><td style="max-width:460px">'+its.map(function(e){return '<div class="mono" style="font-size:11px">'+esc(e.barcode)+' · '+esc(e.code)+' · '+esc(e.qty)+(e.fromLoc?' · <b>原 '+esc(e.fromLoc)+'</b>':'')+(e.move?' · '+(e.move==='AGV'?'<span style="color:#1565C0">🚗AGV</span>':'<span style="color:#888">🚶人工</span>'):'')+'</div>'}).join('')+'</td></tr>'
    }).join('')+'</tbody></table>';
}
function ri(){
  var box=document.getElementById('boxInv');
  if(!led.length){box.innerHTML='<div class="empty">电脑账本为空：先在 PDA 位置登记页导入或拉取账本，同步后这里自动汇总</div>';return}
  var q=document.getElementById('q').value.trim().toUpperCase();
  var m={};
  led.forEach(function(x){
    var k=(x.p||'').toUpperCase()||'未知零件(待补齐)';
    var r=m[k]||(m[k]={part:k,name:'',boxes:0,qty:0,rack:0,floor:0});
    if(x.n&&!r.name)r.name=x.n;
    r.boxes++;r.qty+=Number(x.q)||0;
    if(String(x.l||'').indexOf('NB02-')===0)r.rack++;else r.floor++;
  });
  var arr=Object.values(m).sort(function(a,b){return b.qty-a.qty||b.boxes-a.boxes});
  if(q)arr=arr.filter(function(r){return r.part.indexOf(q)>=0||(r.name||'').toUpperCase().indexOf(q)>=0});
  var tot=led.length;
  box.innerHTML='<table><thead><tr><th>零件号</th><th>物料名称</th><th>框数</th><th>数量合计</th><th>货架(AGV)</th><th>地面</th></tr></thead><tbody>'+
    arr.map(function(r){return '<tr><td class="mono">'+esc(r.part)+'</td><td>'+esc(r.name)+'</td><td>'+r.boxes+'</td><td>'+r.qty+'</td><td>'+r.rack+'</td><td>'+r.floor+'</td></tr>'}).join('')+
    '</tbody></table><div class="sub" style="margin-top:6px">账本共 '+tot+' 框；数量/零件号来自 PDA 同步，若大量显示「未知零件」请先在 PDA 位置登记页做「批量补齐物料」再点云图标同步</div>';
}
loadAll();setInterval(loadAll,30000);
</script></body></html>`;
}

let db = loadDb();
const save = () => saveDb(db);// ---------------- 会话 ----------------
function touchSession(token) {
  const s = db.sessions[token];
  if (!s) return null;
  if (Date.now() - s.lastSeen > SESSION_TTL_MS) { delete db.sessions[token]; save(); return null; }
  s.lastSeen = Date.now(); // 滑动续期（内存更新；重启即全员重登，属可接受）
  return s;
}
function auth(req) {
  const h = req.headers['authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return { err: 401, msg: '缺少登录凭证' };
  const s = touchSession(token);
  if (!s) return { err: 401, msg: '登录已过期，请重新登录' };
  const u = db.users.find(x => x.id === s.userId);
  if (!u) return { err: 401, msg: '账号不存在' };
  if (!u.enabled) { delete db.sessions[token]; save(); return { err: 403, code: 'disabled', msg: '账号已被管理员停用，请联系管理员' }; }
  return { token, user: u };
}
function requireAdmin(authed) { return authed.user.role === 'admin' ? null : { err: 403, msg: '需要管理员权限' }; }

// 登录失败限速
const failMap = new Map(); // username -> [ts,...]
function failCheck(username) {
  const now = Date.now();
  const arr = (failMap.get(username) || []).filter(t => now - t < LOGIN_FAIL_WINDOW_MS);
  if (arr.length >= LOGIN_FAIL_LIMIT) return false;
  failMap.set(username, arr); return true;
}
function failRecord(username) { const arr = failMap.get(username) || []; arr.push(Date.now()); failMap.set(username, arr); }

// ---------------- HTTP ----------------
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''; let size = 0;
    req.on('data', c => { size += c.length; if (size > 8e6) { reject(new Error('body too large')); req.destroy(); return; } data += c; });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (req.method === 'OPTIONS') return send(res, 204, {});
  try {
    // ---- 健康检查 ----
    if (req.method === 'GET' && p === '/health') return send(res, 200, { ok: true, time: new Date().toISOString() });

    // ---- 领料单打印页（局域网内公开，凭单号打开，浏览器 Ctrl+P 打印）----
    if (req.method === 'GET' && p === '/print/requisition') {
      const rid = (url.searchParams.get('id') || '').trim();
      const r = findReq(rid);
      if (!r) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('领料单不存在'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderReqPrint(r));
      return;
    }

    // ---- 采集流水/出库单公开查询 + 数据核对看板（局域网公开；门户 iframe 不带 token）----
    if (req.method === 'GET' && p === '/api/scanlog') {
      const fc = (url.searchParams.get('c') || '').trim().toUpperCase();
      const lim = Math.min(20000, Math.max(1, Number(url.searchParams.get('limit')) || 2000));
      let arr = Object.values(db.scanlog).sort((a, x) => (x.t || 0) - (a.t || 0));
      if (fc) arr = arr.filter(x => String(x.code).toUpperCase() === fc);
      return send(res, 200, { ok: true, at: db.scanlogAt, total: db.scanlogCount, count: arr.length, items: arr.slice(0, lim) });
    }
    if (req.method === 'GET' && p === '/api/outbound') {
      const fl = (url.searchParams.get('req') || '').trim().toUpperCase();
      let arr = Object.values(db.outbound).sort((a, x) => (x.createdAt || 0) - (a.createdAt || 0));
      if (fl) arr = arr.filter(x => String(x.linkReqNo || '').toUpperCase() === fl);
      return send(res, 200, { ok: true, at: db.outboundAt, total: db.outboundCount, count: arr.length, items: arr.slice(0, 500) });
    }
    if (req.method === 'GET' && p === '/board/data') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderDataBoard());
      return;
    }

    // ---- 货位账本：公开查询（局域网任意设备；?c=标签 / ?l=货位 前缀过滤，无参数=全量+概要）----
    if (req.method === 'GET' && p === '/api/ledger') {
      const fc = (url.searchParams.get('c') || '').trim().toUpperCase();
      const fl = (url.searchParams.get('l') || '').trim().toUpperCase();
      let list = db.ledger;
      if (fc) list = list.filter(x => String(x.c).toUpperCase().startsWith(fc));
      if (fl) list = list.filter(x => String(x.l).toUpperCase().startsWith(fl));
      return send(res, 200, { ok: true, rev: db.ledgerRev, at: db.ledgerAt, by: db.ledgerBy, total: db.ledger.length, count: list.length, items: list, tomb: db.ledgerTomb || [] });
    }

    // ---- 货位账本：电脑查询页（表格地图式：按货位排序，同位多标签并排显示）----
    if (req.method === 'GET' && (p === '/board/ledger' || p === '/ledger')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderLedgerBoard());
      return;
    }

    // ---- 领料工作台（电脑端公开：待办列表 + 逐张/批量打印）----
    if (req.method === 'GET' && (p === '/board/requisitions' || p === '/board')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderReqBoard());
      return;
    }

    // ---- 登录 ----
    if (req.method === 'POST' && p === '/api/login') {
      const b = await readBody(req);
      const username = String(b.username || '').trim();
      const password = String(b.password || '');
      if (!username || !password) return send(res, 400, { ok: false, msg: '账号密码不能为空' });
      if (!failCheck(username)) return send(res, 429, { ok: false, msg: '失败次数过多，请1分钟后再试' });
      const u = db.users.find(x => x.username === username);
      if (!u || hashPw(password, u.salt) !== u.passHash) { failRecord(username); return send(res, 401, { ok: false, msg: '账号或密码错误' }); }
      if (!u.enabled) return send(res, 403, { ok: false, code: 'disabled', msg: '账号已被停用，请联系管理员' });
      const token = newToken();
      db.sessions[token] = { userId: u.id, createdAt: Date.now(), lastSeen: Date.now() };
      save();
      console.log(`[login] ${u.username}(${ROLE_NAMES[u.role]}) 登录成功`);
      return send(res, 200, { ok: true, token, expiresAt: Date.now() + SESSION_TTL_MS, user: safeUser(u), features: db.features[u.role] || {} });
    }

    // ---- 以下均需登录 ----
    if (p.startsWith('/api/')) {
      const a = auth(req);
      if (a.err) return send(res, a.err, { ok: false, code: a.code, msg: a.msg });
      const u = a.user;

      if (req.method === 'POST' && p === '/api/logout') { delete db.sessions[a.token]; save(); return send(res, 200, { ok: true }); }

      // 心跳/取当前身份+功能开关（App 前台恢复与定时轮询调用；停用即时生效靠它）
      if (req.method === 'GET' && p === '/api/me') {
        return send(res, 200, { ok: true, user: safeUser(u), features: db.features[u.role] || {}, serverTime: new Date().toISOString() });
      }

      // 修改自己的密码
      if (req.method === 'POST' && p === '/api/change_password') {
        const b = await readBody(req);
        if (hashPw(String(b.oldPassword || ''), u.salt) !== u.passHash) return send(res, 400, { ok: false, msg: '原密码错误' });
        if (String(b.newPassword || '').length < 6) return send(res, 400, { ok: false, msg: '新密码至少6位' });
        u.salt = crypto.randomBytes(16).toString('hex');
        u.passHash = hashPw(b.newPassword, u.salt);
        u.mustChangePw = false;
        save(); return send(res, 200, { ok: true, msg: '密码已修改' });
      }

      // ================= 货位账本同步（PDA 全量推送；仓管/管理员可写，读取走公开接口） =================
      if (req.method === 'POST' && p === '/api/ledger/sync') {
        if (u.role !== 'warehouse' && u.role !== 'admin') return send(res, 403, { ok: false, msg: '仅仓管员/管理员可同步货位账本' });
        const b = await readBody(req);
        const raw = Array.isArray(b.items) ? b.items : [];
        if (!Array.isArray(b.del)) b.del = [];
        if (!raw.length && !b.del.length) return send(res, 400, { ok: false, msg: 'items/del 均为空，已拒绝（防止误清空白账本）' });
        if (raw.length > 20000) return send(res, 400, { ok: false, msg: '条目超过2万，疑似异常' });
        const seen = new Set(); const clean = [];
        for (const it of raw) {
          const c = String((it && it.c) || '').trim().toUpperCase();
          const l = String((it && it.l) || '').trim().toUpperCase();
          if (!c || !l) continue;
          if (seen.has(c)) continue; // 标签重复取首行，与 PDA 账本唯一索引一致
          seen.add(c);
          clean.push({ c, l, f: String((it && it.f) || '').slice(0, 40), t: Number(it && it.t) || 0,
            p: String((it && it.p) || '').slice(0, 40), n: String((it && it.n) || '').slice(0, 80),
            q: Number(it && it.q) || 0, b: String((it && it.b) || '').slice(0, 40), pid: String((it && it.pid) || '').slice(0, 40),
            mv: String((it && it.mv) || '').slice(0, 10), src: String((it && it.src) || '').slice(0, 40) });
        }
        // 增量合并：按标签号 upsert（登记时间新者胜）+ 墓碑删除，多PDA互不覆盖
        const cur = new Map(db.ledger.map(x => [String(x.c).toUpperCase(), x]));
        const tomb = new Map((db.ledgerTomb || []).map(x => [String(x.c).toUpperCase(), Number(x.t) || 0]));
        const dels = Array.isArray(b.del) ? b.del : [];
        let added = 0, updated = 0, skipped = 0, delApplied = 0, delSkipped = 0;
        for (const it of clean) {
          const key = it.c;
          const old = cur.get(key);
          const tombT = tomb.get(key) || 0;
          const base = Math.max(tombT, old ? (Number(old.t) || 0) : 0);
          if (it.t > 0 && it.t < base) { skipped++; continue; } // 严格更旧才忽略：同时间允许刷新（补齐物料信息）
          if (old) updated++; else added++;
          cur.set(key, { ...it, by: u.name });
          if (tombT) tomb.delete(key); // 比墓碑新=重新登记，复活
        }
        for (const d of dels) {
          const c = String((d && d.c) || '').trim().toUpperCase();
          const t = Number(d && d.t) || 0;
          if (!c || !t) continue;
          const old = cur.get(c);
          const base = Math.max(tomb.get(c) || 0, old ? (Number(old.t) || 0) : 0);
          if (t > base) { cur.delete(c); tomb.set(c, t); delApplied++; } else delSkipped++; // 别台后续又登记→删除作废
        }
        if (!cur.size && !tomb.size && !dels.length) return send(res, 400, { ok: false, msg: '无有效条目（需 c=标签 且 l=货位）' });
        db.ledger = [...cur.values()];
        db.ledgerTomb = [...tomb.entries()].map(([c, t]) => ({ c, t })).sort((a, b2) => b2.t - a.t).slice(0, 20000);
        db.ledgerRev = (db.ledgerRev || 0) + 1;
        db.ledgerAt = new Date().toISOString();
        db.ledgerBy = u.name;
        save();
        console.log(`[ledger] ${u.name} 合并：+${added} 改${updated} 删${delApplied} 忽略${skipped + delSkipped} → v${db.ledgerRev}（共 ${db.ledger.length} 条）`);
        return send(res, 200, { ok: true, rev: db.ledgerRev, count: db.ledger.length, added, updated, skipped, delApplied, delSkipped });
      }

      // ================= 采集流水 / 出库单同步（PDA 全量推送，仓管/管理员） =================
      if (req.method === 'POST' && p === '/api/scanlog/sync') {
        if (u.role !== 'warehouse' && u.role !== 'admin') return send(res, 403, { ok: false, msg: '仅仓管员/管理员可同步采集流水' });
        const b = await readBody(req);
        const raw = Array.isArray(b.items) ? b.items : [];
        if (!raw.length) return send(res, 400, { ok: false, msg: 'items 为空，已拒绝' });
        if (raw.length > 50000) return send(res, 400, { ok: false, msg: '条目超过5万，疑似异常' });
        const snap = {};
        for (const it of raw) {
          const k = String((it && it.k) || '').slice(0, 120);
          if (!k) continue;
          snap[k] = { code: String(it.code || '').toUpperCase(), wt: Number(it.wt) || 0, st: String(it.st || ''), gl: String(it.gl || ''), ct: String(it.ct || ''), rm: String(it.rm || '').slice(0, 120), batch: String(it.batch || ''), cx: !!it.cx, t: Number(it.t) || 0, pn: String(it.pn || ''), q: Number(it.q) || 0, mk: String(it.mk || ''), op: String(it.op || '').slice(0, 40), nm: String(it.nm || '').slice(0, 80), lot: String(it.lot || '').slice(0, 40), pid: String(it.pid || '') };
        }
        if (!Object.keys(snap).length) return send(res, 400, { ok: false, msg: '无有效条目（需 k 主键）' });
        db.scanlog = Object.assign(db.scanlog || {}, snap); // 增量合并：只覆盖本次推送的键，别台设备的流水保留
        db.scanlogAt = new Date().toISOString(); db.scanlogCount = Object.keys(db.scanlog).length;
        save();
        console.log(`[scanlog] ${u.name} 同步流水 +${Object.keys(snap).length} → 共 ${db.scanlogCount} 条`);
        return send(res, 200, { ok: true, count: db.scanlogCount, pushed: Object.keys(snap).length });
      }
      // 删除某批次采集流水（PDA 删批同步电脑，防看板残留）
      if (req.method === 'POST' && p === '/api/scanlog/delete') {
        if (u.role !== 'warehouse' && u.role !== 'admin') return send(res, 403, { ok: false, msg: '仅仓管员/管理员可删除流水' });
        const b = await readBody(req);
        const batch = String(b.batch || '').trim();
        if (!batch) return send(res, 400, { ok: false, msg: '缺少 batch' });
        let n = 0;
        for (const k of Object.keys(db.scanlog || {})) { if (String(db.scanlog[k].batch || '') === batch) { delete db.scanlog[k]; n++; } }
        db.scanlogAt = new Date().toISOString(); db.scanlogCount = Object.keys(db.scanlog).length;
        save();
        console.log(`[scanlog] ${u.name} 删批次 ${batch}：${n} 条 → 共 ${db.scanlogCount} 条`);
        return send(res, 200, { ok: true, deleted: n, count: db.scanlogCount });
      }
      // ================= AGV 叫车占位（原子防重：叫车前占位成功才允许下发任务） =================
      // 规则：同容器占位15分钟（防两人重复叉同一框）；同一站台60秒内不可再次叫车（不限同一人，确保单站台单任务）。
      // PDA 侧还会实时复核 WMAS 在途任务数；MES 下发失败由调用方 release 回滚占位。
      if (req.method === 'POST' && p === '/api/agv/claim') {
        if (u.role !== 'warehouse' && u.role !== 'admin') return send(res, 403, { ok: false, msg: '仅仓管员/管理员可叫车' });
        const b = await readBody(req);
        const cn = String(b.container || '').trim().toUpperCase();
        const stn = String(b.station || '').trim().toUpperCase();
        const from = String(b.fromLoc || '').trim().toUpperCase();
        if (!cn || !stn) return send(res, 400, { ok: false, msg: '缺少 container/station' });
        if (!db.agvClaims) db.agvClaims = {};
        const now = Date.now();
        for (const k of Object.keys(db.agvClaims)) { if ((db.agvClaims[k].at || 0) + 15 * 60 * 1000 < now) delete db.agvClaims[k]; }
        for (const c of Object.values(db.agvClaims)) {
          const age = now - (c.at || 0);
          if (c.cn === cn) return send(res, 200, { ok: false, code: 'agv_busy', msg: `容器 ${cn} 已在叫车流程中（${c.by} ${new Date(c.at).toLocaleTimeString('zh-CN', { hour12: false })} 叫往 ${c.stn}），请勿重复叉取` });
          if (c.stn === stn && age < 60 * 1000) return send(res, 200, { ok: false, code: 'agv_busy', msg: `站台 ${stn} ${age < 5000 ? '刚刚' : Math.round(age / 1000) + '秒前'}刚被叫车（${c.by} ← ${c.from}），同一时间只允许一个任务，请等送达或换站台` });
        }
        db.agvClaims[`${cn}|${stn}`] = { cn, stn, from, by: u.name, at: now };
        save();
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/api/agv/release') {
        const b = await readBody(req);
        const cn = String(b.container || '').trim().toUpperCase();
        const stn = String(b.station || '').trim().toUpperCase();
        if (db.agvClaims) { delete db.agvClaims[`${cn}|${stn}`]; save(); }
        return send(res, 200, { ok: true });
      }
      // ================= RCS(哈工库讯AGV) 配置同步 + 站台状态（服务器60秒轮询RCS） =================
      if (req.method === 'POST' && p === '/api/rcs/config') {
        if (u.role !== 'warehouse' && u.role !== 'admin') return send(res, 403, { ok: false, msg: '仅仓管员/管理员可配置' });
        const b = await readBody(req);
        const host = String(b.host || '').trim(), account = String(b.account || '').trim(), pwd = String(b.pwd || '');
        if (!host || !account || !pwd) return send(res, 400, { ok: false, msg: 'host/account/pwd 不能为空' });
        db.rcsConfig = { host, account, pwd }; db.rcsToken = ''; db.rcsTokenExp = 0;
        save();
        rcsPoll(); // 立即拉一次，让站台面板/催扫马上生效
        return send(res, 200, { ok: true, msg: 'RCS配置已保存，服务器开始轮询' });
      }
      if (req.method === 'GET' && p === '/api/rcs/stations') {
        const list = Object.values(db.rcsStations || {}).sort((a, b) => a.station.localeCompare(b.station));
        return send(res, 200, { ok: true, at: db.rcsAt || '', on: !!(db.rcsConfig && db.rcsConfig.host), run: (db.rcsRun || []).length, stations: list });
      }
      if (req.method === 'POST' && p === '/api/rcs/clear') { // 人工清台：现场已取走但系统未识别时，仓管点一下即刻转空闲
        if (u.role !== 'warehouse' && u.role !== 'admin') return send(res, 403, { ok: false, msg: '仅仓管员/管理员可清台' });
        const b = await readBody(req);
        const stn = String(b.station || '').trim().toUpperCase();
        if (!stn.includes('-CK-')) return send(res, 400, { ok: false, msg: '站台编码无效' });
        db.rcsStations = db.rcsStations || {}; db.rcsCleared = db.rcsCleared || {};
        delete db.rcsStations[stn];
        db.rcsCleared[stn] = Date.now();
        for (const [k, t0] of Object.entries(db.rcsCleared)) { if (Date.now() - t0 > 8 * 3600 * 1000) delete db.rcsCleared[k]; }
        save();
        return send(res, 200, { ok: true, msg: stn + ' 已清台' });
      }
      if (req.method === 'POST' && p === '/api/outbound/sync') {
        if (u.role !== 'warehouse' && u.role !== 'admin') return send(res, 403, { ok: false, msg: '仅仓管员/管理员可同步出库单' });
        const b = await readBody(req);
        const no = String(b.orderNo || '').trim();
        if (!no) return send(res, 400, { ok: false, msg: '缺少 orderNo' });
        db.outbound[no] = { orderNo: no, createdAt: Number(b.createdAt) || 0, toLoc: String(b.toLoc || ''), operator: String(b.operator || ''), status: Number(b.status) || 0, linkReqNo: String(b.linkReqNo || ''), items: Array.isArray(b.items) ? b.items : [] };
        db.outboundAt = new Date().toISOString(); db.outboundCount = Object.keys(db.outbound).length;
        save();
        console.log(`[outbound] ${u.name} 同步出库单 ${no}`);
        return send(res, 200, { ok: true, count: db.outboundCount });
      }
      // ================= 领料单（登录即可访问，内部按角色+状态校验） =================
      if (p === '/api/requisitions' || p.startsWith('/api/requisitions/') || p === '/api/notifications' || p.startsWith('/api/notifications/')) {
        const canReq = (db.features[u.role] || {}).requisition === true;
        const canRcv = (db.features[u.role] || {}).receive_confirm === true;
        const isWh = u.role === 'warehouse' || u.role === 'admin';

        // 下单（可选 assigneeId 指定仓管员：通知只推指定人，30分钟未接自动放开给全员）
        if (req.method === 'POST' && p === '/api/requisitions') {
          if (!canReq) return send(res, 403, { ok: false, msg: '当前角色未开通领料下单' });
          const b = await readBody(req);
          const items = Array.isArray(b.items) ? b.items : [];
          const clean = [];
          for (const it of items) {
            const partNo = String(it.partNo || '').trim();
            const qty = Number(it.qty);
            if (!partNo || !(qty > 0)) continue;
            clean.push({ partNo, itemName: String(it.itemName || ''), qty, issued: [] });
          }
          if (!clean.length) return send(res, 400, { ok: false, msg: '至少一行有效的零件号+数量' });
          if (clean.length > 20) return send(res, 400, { ok: false, msg: '一张单最多20行' });
          let assignee = null;
          const assigneeId = String(b.assigneeId || '').trim();
          if (assigneeId) {
            assignee = db.users.find(x => x.id === assigneeId && x.enabled && (x.role === 'warehouse' || x.role === 'admin'));
            if (!assignee) return send(res, 400, { ok: false, msg: '指定的仓管员不存在或未启用' });
          }
          const now = new Date();
          const ts = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
          const r = {
            id: newId('rq'), no: `LL${ts}${String(db.requisitions.length % 100).padStart(2, '0')}`,
            by: u.id, byName: u.name, items: clean, status: 'pending',
            remark: String(b.remark || ''), createdAt: now.toISOString(), history: [],
            assigneeId: assignee ? assignee.id : '', assigneeName: assignee ? assignee.name : '',
            assignOpenAt: assignee ? new Date(now.getTime() + 30 * 60000).toISOString() : '',
          };
          db.requisitions.push(r);
          if (assignee) {
            notify(assignee.id, 'req_new', `${u.name} 指定你备料：领料单 ${r.no}：${reqItemsSuggestText(r)}（30分钟内未接单将放开给全部仓管）`, r.id);
          } else {
            db.users.filter(x => x.role === 'warehouse' && x.enabled).forEach(x =>
              notify(x.id, 'req_new', `${u.name} 提交了领料单 ${r.no}：${reqItemsSuggestText(r)}`, r.id));
          }
          save();
          console.log(`[req] ${u.name} 下单 ${r.no}${assignee ? ' → 指定 ' + assignee.name : ''}`);
          return send(res, 200, { ok: true, req: reqView(r) });
        }

        // 列表：物料员看自己的，仓管/管理员看全部；scope=todo 只看待办
        if (req.method === 'GET' && p === '/api/requisitions') {
          sweepAssignOpen();
          const q = (url.searchParams.get('scope') || '').trim();
          let list = db.requisitions.slice().reverse();
          if (u.role === 'material') list = list.filter(r => r.by === u.id);
          if (q === 'todo') list = isWh ? list.filter(r => r.status === 'pending' || r.status === 'accepted')
                                        : list.filter(r => r.status === 'ready' && r.by === u.id);
          return send(res, 200, { ok: true, reqs: list.map(reqView) });
        }

        // 可选仓管员列表（新建单指定用）；lastAssigneeId=本人最近一次指定过的仓管（默认带出）
        if (req.method === 'GET' && p === '/api/requisitions/warehouse-users') {
          const wh = db.users.filter(x => x.enabled && (x.role === 'warehouse' || x.role === 'admin')).map(x => ({ id: x.id, name: x.name }));
          const last = db.requisitions.slice().reverse().find(r => r.by === u.id && r.assigneeId);
          const lastAssigneeId = last && wh.some(x => x.id === last.assigneeId) ? last.assigneeId : '';
          return send(res, 200, { ok: true, users: wh, lastAssigneeId });
        }

        // 通知拉取（取回即标记已读）
        if (req.method === 'GET' && p === '/api/notifications') {
          sweepAssignOpen();
          const mine = db.notifications.filter(n => n.to === u.id && !n.read);
          mine.forEach(n => n.read = true);
          if (mine.length) save();
          return send(res, 200, { ok: true, notifications: mine });
        }

        // 消息中心历史（只读，不改read标志；返回本人最近 limit 条，默认30）
        if (req.method === 'GET' && p === '/api/notifications/history') {
          const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '30') || 30));
          const mine = db.notifications.filter(n => n.to === u.id).slice(-limit).reverse();
          return send(res, 200, { ok: true, notifications: mine });
        }

        // 状态动作：/:id/accept|reject|scan|transfer|skip|loc|confirm|cancel|reassign|agv
        const mAct = p.match(/^\/api\/requisitions\/([\w-]+)\/(accept|reject|scan|transfer|skip|loc|confirm|cancel|reassign|agv)$/);
        if (req.method === 'POST' && mAct) {
          const r = findReq(mAct[1]);
          if (!r) return send(res, 404, { ok: false, msg: '领料单不存在' });
          const act = mAct[2];
          const b = await readBody(req);
          const hpush = (text) => { r.history.push({ time: new Date().toISOString(), by: u.name, text }); };
          // issued 统一为 [{c:标签, q:件数}]，兼容旧数据纯字符串（按0件计）
          const normIssued = (i) => (i.issued || []).map(x => typeof x === 'string' ? { c: x, q: 0 } : { c: String(x.c || ''), q: Number(x.q) || 0 });
          const issuedQty = (i) => normIssued(i).reduce((s, e) => s + e.q, 0);
          // 全部行到达终态（已转/已跳过）→ 已备齐，通知含短装明细
          const finalize = () => {
            if (!(r.status === 'accepted' && r.items.every(i => i.transferred || i.skipped))) return;
            r.status = 'ready';
            const shorts = [];
            for (const i of r.items) {
              if (i.skipped) shorts.push(`${i.partNo} 跳过(0件)`);
              else if ((Number(i.transferQty) || 0) < (Number(i.qty) || 0)) shorts.push(`${i.partNo} 短${(Number(i.qty) || 0) - (Number(i.transferQty) || 0)}件(实发${Number(i.transferQty) || 0})`);
            }
            if (shorts.length) r.shortInfo = shorts.join('；');
            hpush(`全部行处理完成${r.shortInfo ? '，短装：' + r.shortInfo : ''}，待签收`);
            notify(r.by, 'req_ready', `你的领料单 ${r.no} 已备齐${r.shortInfo ? '（短装：' + r.shortInfo + '）' : ''}，请确认收货`, r.id);
            db.users.filter(x => x.role === 'warehouse' && x.enabled && x.id !== u.id).forEach(x =>
              notify(x.id, 'req_ready_wh', `领料单 ${r.no}（${r.byName}）已备齐${r.shortInfo ? '，短装：' + r.shortInfo : ''}`, r.id));
          };

          if (act === 'accept') {
            if (!isWh) return send(res, 403, { ok: false, msg: '仅仓管员可接单' });
            if (r.status !== 'pending') return send(res, 400, { ok: false, msg: `当前状态[${r.status}]不可接单` });
            // 指定仓管员优先：时限内只有指定人/管理员可接，超时自动放开给全员
            if (r.assigneeId && u.id !== r.assigneeId && u.role !== 'admin') {
              const openAt = r.assignOpenAt ? Date.parse(r.assignOpenAt) : 0;
              if (openAt && Date.now() < openAt) {
                return send(res, 403, { ok: false, msg: `该单已指定给 ${r.assigneeName || '其他仓管'} 备料（未超时），暂不能接单` });
              }
            }
            r.status = 'accepted'; r.acceptedBy = u.name;
            hpush(`接单（${u.name}）${r.assigneeName && r.assigneeId !== u.id ? '，原指定 ' + r.assigneeName + ' 超时未接' : ''}`);
            notify(r.by, 'req_accept', `你的领料单 ${r.no} 已由 ${u.name} 接单备料`, r.id);
          } else if (act === 'reject') {
            if (!isWh) return send(res, 403, { ok: false, msg: '仅仓管员可拒单' });
            if (r.status !== 'pending') return send(res, 400, { ok: false, msg: `当前状态[${r.status}]不可拒单` });
            if (r.assigneeId && u.id !== r.assigneeId && u.role !== 'admin') {
              const openAt = r.assignOpenAt ? Date.parse(r.assignOpenAt) : 0;
              if (openAt && Date.now() < openAt) {
                return send(res, 403, { ok: false, msg: `该单已指定给 ${r.assigneeName || '其他仓管'}，未超时不能替拒` });
              }
            }
            const reason = String(b.reason || '').trim() || '未说明';
            r.status = 'rejected'; r.rejectReason = reason;
            hpush(`拒单：${reason}`);
            notify(r.by, 'req_reject', `你的领料单 ${r.no} 被 ${u.name} 拒绝：${reason}`, r.id);
          } else if (act === 'reassign') {
            // 管理员转派：仅待接单状态；改指定人并重置30分钟窗口（未指定单也可事后锁定）
            if (u.role !== 'admin') return send(res, 403, { ok: false, msg: '仅管理员可转派' });
            if (r.status !== 'pending') return send(res, 400, { ok: false, msg: `当前状态[${r.status}]不可转派` });
            const tId = String(b.assigneeId || '').trim();
            const t = db.users.find(x => x.id === tId && x.enabled && (x.role === 'warehouse' || x.role === 'admin'));
            if (!t) return send(res, 400, { ok: false, msg: '目标仓管员不存在或未启用' });
            const oldId = r.assigneeId || ''; const oldName = r.assigneeName || '';
            if (oldId === tId) return send(res, 200, { ok: true, req: reqView(r) }); // 幂等：目标就是当前指定人
            r.assigneeId = t.id; r.assigneeName = t.name;
            r.assignOpenAt = new Date(Date.now() + 30 * 60000).toISOString();
            hpush(`${oldName ? `转派：${oldName} → ${t.name}` : `指定给 ${t.name}`}（${u.name}）`);
            if (oldId && oldId !== t.id) notify(oldId, 'req_reassign', `领料单 ${r.no} 已从你转派给 ${t.name}`, r.id);
            notify(t.id, 'req_new', `${u.name} 指定你备料：领料单 ${r.no}：${reqItemsSuggestText(r)}（30分钟内未接单将放开给全部仓管）`, r.id);
            notify(r.by, 'req_reassign', `你的领料单 ${r.no} ${oldName ? '已由管理员从 ' + oldName : '已指定给'} 转派给 ${t.name}`.replace('已由管理员从 转派给', '已由管理员转派给'), r.id);
          } else if (act === 'scan') {
            if (!isWh) return send(res, 403, { ok: false, msg: '仅仓管员可扫码发料' });
            if (r.status !== 'accepted') return send(res, 400, { ok: false, msg: `当前状态[${r.status}]不可发料` });
            const code = String(b.barcode || '').trim();
            if (!code) return send(res, 400, { ok: false, msg: '缺少 barcode' });
            if (r.items.some(i => normIssued(i).some(e => e.c === code))) return send(res, 400, { ok: false, msg: `标签 ${code} 已扫过` });
            // 一框一发：同框兄弟码（同托号/同货位同零件号）已发过则拦截，防整框数量双计
            {
              const self = db.ledger.find(x => String(x.c).toUpperCase() === code.toUpperCase());
              if (self) {
                const bk = boxKeyOf(self);
                const sib = r.items.some(i => normIssued(i).some(e => {
                  const l = db.ledger.find(x => String(x.c).toUpperCase() === String(e.c).toUpperCase());
                  return l && boxKeyOf(l) === bk;
                }));
                if (sib) return send(res, 400, { ok: false, msg: `标签 ${code} 与已发标签同框（一框只发一次），请勿重复扫码` });
              }
            }
            const target = r.items.find(i => i.partNo === b.partNo);
            if (!target) return send(res, 400, { ok: false, msg: '该零件号不在本单内' });
            if (target.transferred) return send(res, 400, { ok: false, msg: `行 ${target.partNo} 已转MES，不可再补扫` });
            const q = Number(b.qty) || 0;
            if (q <= 0) return send(res, 400, { ok: false, msg: '缺少该标签的件数(qty)' });
            target.issued = normIssued(target);
            target.issued.push({ c: code, q, l: String(b.fromLoc || '').trim().toUpperCase() });
            const got = issuedQty(target);
            hpush(`发料 ${b.partNo} 标签 ${code}（${q}件，累计 ${got}/${target.qty}）`);
            // 不再自动置 ready：ready 由每行 transfer/skip 到终态后 finalize 决定
          } else if (act === 'agv') {
            // 叫AGV登记：仓管从货架叫车叉框后记账，建议区该框标"已叫AGV"防重复叫车/漏叫
            if (!isWh) return send(res, 403, { ok: false, msg: '仅仓管员可登记' });
            if (r.status !== 'accepted') return send(res, 400, { ok: false, msg: `当前状态[${r.status}]不可登记` });
            const target = r.items.find(i => i.partNo === b.partNo);
            if (!target) return send(res, 400, { ok: false, msg: '该零件号不在本单内' });
            const code = String(b.barcode || '').trim().toUpperCase();
            if (!code) return send(res, 400, { ok: false, msg: '缺少 barcode' });
            // 防重复叫车：该标签或其同框兄弟码已叫过 → 拒绝登记（叫车前端已先占位，此处兜底）
            const _lk = (s) => { s = String(s || '').trim().toUpperCase(); const i = s.lastIndexOf('-'); return i > 0 ? s.slice(0, i) : s; };
            const called = (target.agvCalled || []).map(e => String(e.c).toUpperCase());
            const self = (db.ledger || []).find(x => String(x.c).toUpperCase() === code);
            const sp = self && self.p ? String(self.p).toUpperCase() : '';
            for (const x of db.ledger || []) {
              const xc = String(x.c).toUpperCase();
              if (called.includes(xc) && (xc === code || (sp && String(x.p || '').toUpperCase() === sp) || (!sp && _lk(x.l) === _lk(self && self.l)))) {
                return send(res, 200, { ok: false, msg: `同框标签 ${xc} 已叫过AGV，请勿重复叉取` });
              }
            }
            target.agvCalled = (target.agvCalled || []).filter(e => String(e.c).toUpperCase() !== code);
            target.agvCalled.push({ c: code, s: String(b.station || '').trim(), by: u.id, t: new Date().toISOString() });
            hpush(`叫AGV ${b.partNo} 标签 ${code} → ${b.station || '?'}`);
          } else if (act === 'transfer') {
            // 行级转MES回写：App 已把该行已扫箱真实转单成功，按实发件数记账（申请600只有500也可转500）
            if (!isWh) return send(res, 403, { ok: false, msg: '仅仓管员可转单' });
            if (r.status !== 'accepted') return send(res, 400, { ok: false, msg: `当前状态[${r.status}]不可转单` });
            const target = r.items.find(i => i.partNo === b.partNo);
            if (!target) return send(res, 400, { ok: false, msg: '该零件号不在本单内' });
            if (target.transferred) return send(res, 200, { ok: true, req: reqView(r) }); // 幂等：重复回写直接成功
            target.issued = normIssued(target);
            const got = issuedQty(target);
            if (got <= 0) return send(res, 400, { ok: false, msg: '该行还没有扫入任何标签，不能转单' });
            target.transferred = true;
            target.transferQty = got;
            target.mesNo = String(b.mesNo || '').trim(); // App 侧出库单号，便于对账
            hpush(`转MES ${target.partNo} 实发${got}件${got < (Number(target.qty) || 0) ? '（短装' + ((Number(target.qty) || 0) - got) + '件）' : ''}（${u.name}）`);
            finalize();
          } else if (act === 'skip') {
            // 行级跳过：仓库无货，0件转单，等下次补货可另开单
            if (!isWh) return send(res, 403, { ok: false, msg: '仅仓管员可跳过' });
            if (r.status !== 'accepted') return send(res, 400, { ok: false, msg: `当前状态[${r.status}]不可跳过` });
            const target = r.items.find(i => i.partNo === b.partNo);
            if (!target) return send(res, 400, { ok: false, msg: '该零件号不在本单内' });
            if (target.transferred) return send(res, 400, { ok: false, msg: `行 ${target.partNo} 已转MES，不可跳过` });
            if (target.skipped) return send(res, 200, { ok: true, req: reqView(r) }); // 幂等
            target.issued = normIssued(target);
            if (issuedQty(target) > 0) return send(res, 400, { ok: false, msg: '该行已有发料记录，请用转单而不是跳过' });
            target.skipped = true; target.skipReason = String(b.reason || '').trim();
            hpush(`跳过 ${target.partNo}${target.skipReason ? '：' + target.skipReason : '（无库存）'}（${u.name}）`);
            finalize();
          } else if (act === 'loc') {
            // 持久化转入货位（App 已用 getwarehousemodelinfo 校验过），本单所有行转同一目标位
            if (!isWh) return send(res, 403, { ok: false, msg: '仅仓管员可设置转入货位' });
            if (!['pending', 'accepted'].includes(r.status)) return send(res, 400, { ok: false, msg: `当前状态[${r.status}]不可设置转入货位` });
            const locCode = String(b.locCode || '').trim();
            if (!locCode) return send(res, 400, { ok: false, msg: '缺少 locCode' });
            r.toLoc = {
              WAREHOUSE_CODE: String(b.warehouseCode || ''), WAREHOUSE_NAME: String(b.warehouseName || ''),
              DISTRICT_CODE: String(b.districtCode || ''), DISTRICT_NAME: String(b.districtName || ''),
              LOC_CODE: locCode, LOC_NAME: String(b.locName || ''),
            };
            hpush(`设置转入货位：${r.toLoc.WAREHOUSE_NAME}/${r.toLoc.DISTRICT_NAME}/${r.toLoc.LOC_NAME}（${locCode}）`);
          } else if (act === 'confirm') {
            if (!canRcv) return send(res, 403, { ok: false, msg: '当前角色未开通签收确认' });
            if (r.status !== 'ready') return send(res, 400, { ok: false, msg: `当前状态[${r.status}]不可签收` });
            r.status = 'done'; r.confirmedBy = u.name; r.confirmedAt = new Date().toISOString();
            hpush(`签收确认（${u.name}）`);
            db.users.filter(x => x.role === 'warehouse' && x.enabled).forEach(x =>
              notify(x.id, 'req_done', `${r.byName} 已签收领料单 ${r.no}`, r.id));
          } else if (act === 'cancel') {
            if (r.by !== u.id && u.role !== 'admin') return send(res, 403, { ok: false, msg: '仅下单人或管理员可取消' });
            if (!['pending', 'accepted'].includes(r.status)) return send(res, 400, { ok: false, msg: `当前状态[${r.status}]不可取消` });
            // 已有行真实转过MES：纸面取消会造成库存与MES不一致，禁止整单取消（剩余行走转单或跳过收尾）
            if (r.items.some(i => i.transferred)) return send(res, 400, { ok: false, msg: '已有行转MES出库，不能整单取消；请对剩余行转单或跳过收尾' });
            r.status = 'cancelled';
            hpush(`取消${b.reason ? '：' + b.reason : ''}`);
            if (r.acceptedBy) db.users.filter(x => x.role === 'warehouse' && x.enabled).forEach(x =>
              notify(x.id, 'req_cancel', `${u.name} 取消了领料单 ${r.no}`, r.id));
          }
          save();
          return send(res, 200, { ok: true, req: reqView(r) });
        }
        return send(res, 404, { ok: false, msg: '接口不存在' });
      }

      const ae = requireAdmin(a);
      if (ae) return send(res, ae.err, { ok: false, msg: ae.msg });

      // ---- 管理员：用户管理 ----
      if (req.method === 'GET' && p === '/api/users') {
        return send(res, 200, { ok: true, users: db.users.map(x => ({ ...safeUser(x), createdAt: x.createdAt })) });
      }
      if (req.method === 'POST' && p === '/api/users') {
        const b = await readBody(req);
        const username = String(b.username || '').trim();
        if (!/^[A-Za-z0-9_.]{3,20}$/.test(username)) return send(res, 400, { ok: false, msg: '账号需3-20位字母数字' });
        if (db.users.some(x => x.username === username)) return send(res, 400, { ok: false, msg: '账号已存在' });
        if (String(b.password || '').length < 6) return send(res, 400, { ok: false, msg: '密码至少6位' });
        if (!ROLES.includes(b.role)) return send(res, 400, { ok: false, msg: '角色无效' });
        const salt = crypto.randomBytes(16).toString('hex');
        const nu = { id: newId('u'), username, name: String(b.name || username), role: b.role, enabled: true, salt, passHash: hashPw(b.password, salt), createdAt: new Date().toISOString(), mustChangePw: true };
        db.users.push(nu); save();
        console.log(`[users] 创建 ${username}(${ROLE_NAMES[b.role]})`);
        return send(res, 200, { ok: true, user: safeUser(nu) });
      }
      const mUser = p.match(/^\/api\/users\/([\w-]+)$/);
      if (req.method === 'PATCH' && mUser) {
        const t = db.users.find(x => x.id === mUser[1]);
        if (!t) return send(res, 404, { ok: false, msg: '用户不存在' });
        const b = await readBody(req);
        if (typeof b.enabled === 'boolean') {
          t.enabled = b.enabled;
          if (!b.enabled) { // 远程停用：踢掉该用户全部会话
            Object.keys(db.sessions).forEach(tk => { if (db.sessions[tk].userId === t.id) delete db.sessions[tk]; });
            console.log(`[users] 停用 ${t.username}，已吊销会话`);
          }
        }
        if (b.role && ROLES.includes(b.role)) t.role = b.role;
        if (b.name) t.name = String(b.name);
        if (b.password) {
          if (String(b.password).length < 6) return send(res, 400, { ok: false, msg: '密码至少6位' });
          t.salt = crypto.randomBytes(16).toString('hex'); t.passHash = hashPw(b.password, t.salt); t.mustChangePw = true;
        }
        save(); return send(res, 200, { ok: true, user: safeUser(t) });
      }
      if (req.method === 'DELETE' && mUser) {
        const t = db.users.find(x => x.id === mUser[1]);
        if (!t) return send(res, 404, { ok: false, msg: '用户不存在' });
        if (t.id === u.id) return send(res, 400, { ok: false, msg: '不能删除自己' });
        db.users = db.users.filter(x => x.id !== t.id);
        Object.keys(db.sessions).forEach(tk => { if (db.sessions[tk].userId === t.id) delete db.sessions[tk]; });
        save(); return send(res, 200, { ok: true });
      }

      // ---- 管理员：功能开关 ----
      if (req.method === 'GET' && p === '/api/config') {
        return send(res, 200, { ok: true, features: db.features, roles: ROLES, roleNames: ROLE_NAMES, featureNames: FEATURE_NAMES });
      }
      if (req.method === 'PATCH' && p === '/api/config') {
        const b = await readBody(req);
        if (b.features && typeof b.features === 'object') {
          for (const role of ROLES) if (b.features[role]) db.features[role] = { ...db.features[role], ...b.features[role] };
          save(); console.log('[config] 功能开关已更新');
        }
        return send(res, 200, { ok: true, features: db.features });
      }
    }
    return send(res, 404, { ok: false, msg: '接口不存在' });
  } catch (e) {
    return send(res, 500, { ok: false, msg: '服务器错误：' + e.message });
  }
});

// 定期清过期会话
setInterval(() => {
  const now = Date.now(); let n = 0;
  Object.keys(db.sessions).forEach(t => { if (now - db.sessions[t].lastSeen > SESSION_TTL_MS) { delete db.sessions[t]; n++; } });
  if (n) save();
}, 10 * 60 * 1000).unref();

// ================= RCS(哈工库讯AGV) 轮询：站台状态 + 到站催扫 =================
// 配置在PDA「AGV调度系统设置」保存后由App同步过来；60秒拉一次任务表。
// 站台规则（用户确认的业务口径）：出库任务(起点=货架位非CK、终点=CK站台)完成→站台"有货"，直到该框扫码出库/人工清台；入库任务(起点=CK、终点=货架)完成→站台"空闲"。
function rcsReq(path, method = 'GET', token = '') {
  return new Promise((resolve) => {
    try {
      const cfg = db.rcsConfig || {};
      const [host, port] = String(cfg.host || '').split(':');
      if (!host) return resolve(null);
      const req = http.request({ host, port: parseInt(port || '80'), path, method, timeout: 8000, headers: token ? { token } : {} },
        (res) => { let s = ''; res.on('data', (c) => s += c); res.on('end', () => { try { resolve(JSON.parse(s)); } catch (_) { resolve(null); } }); });
      req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end();
    } catch (_) { resolve(null); }
  });
}
async function rcsLogin() {
  const cfg = db.rcsConfig || {};
  return new Promise((resolve) => {
    try {
      const [host, port] = String(cfg.host || '').split(':');
      if (!host) return resolve(null);
      const body = JSON.stringify({ username: cfg.account, password: cfg.pwd, captcha: '12345', uuid: Date.now().toString(36) });
      const req = http.request({ host, port: parseInt(port || '80'), path: '/login', method: 'POST', timeout: 8000, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
        (res) => { let s = ''; res.on('data', (c) => s += c); res.on('end', () => { try { const jj = JSON.parse(s); if (jj.code === 0 && jj.data && jj.data.token) { db.rcsToken = jj.data.token; db.rcsTokenExp = Date.now() + 11 * 3600 * 1000; save(); resolve(jj.data.token); } else resolve(null); } catch (_) { resolve(null); } }); });
      req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
      req.write(body); req.end();
    } catch (_) { resolve(null); }
  });
}
function parsePts(t) { try { const s = JSON.parse(t.suspensionMsg || '{}'); return { sp: String(s.startPoint || '').toUpperCase(), ep: String(s.endPoint || '').toUpperCase() }; } catch (_) { return { sp: '', ep: '' }; } }
function rcsTs(s) { s = String(s || ''); if (s.length < 14) return 0; return new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}`).getTime(); }
async function rcsPoll() {
  if (!db.rcsConfig || !db.rcsConfig.host) return;
  let tk = (db.rcsToken && Date.now() < (db.rcsTokenExp || 0)) ? db.rcsToken : await rcsLogin();
  if (!tk) { console.log('[rcs] 登录失败，下轮重试'); return; }
  let run = await rcsReq('/task/getTaskInfo', 'GET', tk);
  if (!run || run.code !== 0) { tk = await rcsLogin(); if (!tk) return; run = await rcsReq('/task/getTaskInfo', 'GET', tk); }
  const done = await rcsReq('/task/getDoneTaskList', 'GET', tk);
  if (!run || run.code !== 0) return;
  const parse = (d) => { try { return JSON.parse(typeof d === 'string' ? d : JSON.stringify(d || [])); } catch (_) { return []; } };
  const runT = parse(run.data), doneT = parse(done && done.code === 0 ? done.data : '[]');
  const isCK = (s) => s.includes('-CK-');
  // 站台状态：出库到站(未清台)=有货；进行中的入库任务=占用中；其余空闲
  const stations = {};
  const mark = (stn, v) => { if (isCK(stn)) stations[stn] = Object.assign(stations[stn] || { station: stn, state: '空闲' }, v); };
  for (const t of runT) {
    const { sp, ep } = parsePts(t);
    if (isCK(ep)) mark(ep, { state: '占用中', via: '任务 ' + (t.dispatchNo || '').slice(-6) }); // 出库在途：车正送来
    if (isCK(sp)) mark(sp, { state: '占用中', via: '任务 ' + (t.dispatchNo || '').slice(-6) }); // 入库取走中
  }
  // 出库完成→有货：按"到站那一刻快照的标签清单"判定清台；清台后的任务记入rcsDone，防止货架位补了新框又被误判有货
  const nowMs = Date.now();
  const issuedAll = new Set();
  for (const r of db.requisitions || []) {
    if (!['accepted', 'ready'].includes(r.status)) continue;
    for (const it of r.items || []) for (const x of (it.issued || [])) issuedAll.add(String(typeof x === 'string' ? x : (x.c || '')).toUpperCase());
  }
  const ledgerCodes = new Set((db.ledger || []).map(x => String(x.c || '').toUpperCase()));
  db.rcsStations = db.rcsStations || {};
  db.rcsCleared = db.rcsCleared || {}; // 人工清台：站台 → 时间戳，早于该时刻到站的任务不再算有货
  db.rcsDone = db.rcsDone || {}; // 已清台任务：站台|任务号 → 时间戳
  const recent = doneT.filter(t => rcsTs(t.finishTime) && nowMs - rcsTs(t.finishTime) < 2 * 3600 * 1000);
  for (const t of recent) {
    const { sp, ep } = parsePts(t);
    if (t.taskState !== 2) continue;
    const dn = (t.dispatchNo || '').slice(-6), finTs = rcsTs(t.finishTime);
    if (!isCK(sp) && isCK(ep)) {
      if ((db.rcsCleared[ep] || 0) >= finTs || db.rcsDone[ep + '|' + dn]) continue; // 人工清台过/已判定清台的任务：跳过
      const old = db.rcsStations[ep];
      const codes = (old && old.via === dn && (old.codes || []).length) ? old.codes // 同一任务沿用首次快照，不被货架位新框干扰
        : (db.ledger || []).filter(x => String(x.l).toUpperCase() === sp).map(x => String(x.c || '').toUpperCase()).filter(Boolean);
      db.rcsStations[ep] = { station: ep, state: '有货', label: sp, codes, goods: (t.palletType || ''), since: t.finishTime || '', ts: finTs, via: dn };
    } else if (isCK(sp) && !isCK(ep)) { delete db.rcsStations[sp]; } // 入库叉回货架 → 站台清
  }
  for (const [stn, s] of Object.entries(db.rcsStations)) {
    if (s.state !== '有货') continue;
    const codes = (s.codes || []).filter(Boolean);
    const cleared = codes.length ? (codes.some(c => issuedAll.has(c)) || !codes.some(c => ledgerCodes.has(c))) : (nowMs - (s.ts || 0) > 2 * 3600 * 1000);
    if (cleared) { delete db.rcsStations[stn]; db.rcsDone[stn + '|' + (s.via || '')] = nowMs; } // 快照标签已发料/已消位 → 清台并记住该任务已完结
    else if (nowMs - (s.ts || 0) > 6 * 3600 * 1000) delete db.rcsStations[stn]; // 超6小时兜底过期
  }
  for (const [k, t0] of Object.entries(db.rcsDone)) { if (nowMs - t0 > 6 * 3600 * 1000) delete db.rcsDone[k]; }
  for (const v of Object.values(stations)) { if (!db.rcsStations[v.station]) db.rcsStations[v.station] = v; }
  db.rcsRun = runT.map(t => ({ no: t.dispatchNo, state: t.taskState, ...parsePts(t) }));
  db.rcsAt = new Date().toISOString();
  // ===== 到站催扫：站台仍"有货"且到站超10分钟 → 通知叫车人（用快照标签，不受货架位补新框干扰） =====
  for (const [stn, s] of Object.entries(db.rcsStations)) {
    if (s.state !== '有货' || !(s.codes || []).length) continue;
    if (nowMs - (s.ts || 0) < 10 * 60 * 1000 || nowMs - (s.ts || 0) > 2 * 3600 * 1000) continue;
    const codes = s.codes.map(c => String(c).toUpperCase());
    const called = [];
    for (const r of db.requisitions || []) {
      if (r.status !== 'accepted') continue;
      for (const it of r.items || []) for (const e of (it.agvCalled || [])) {
        const c = String(e.c || '').toUpperCase();
        if (codes.includes(c)) called.push({ req: r, by: e.by, c });
      }
    }
    for (const cl of called) {
      const key = cl.c + '|' + stn;
      if (db.rcsRemind && db.rcsRemind[key]) continue;
      notify(cl.by || cl.req.by, 'req_arrive', `⏰ 到站催扫：框 ${cl.c} 已到站台 ${stn} 超10分钟未扫码发料（领料单 ${cl.req.no}），请尽快清台`, cl.req.id);
      db.rcsRemind = db.rcsRemind || {}; db.rcsRemind[key] = nowMs;
    }
  }
  if (db.rcsRemind) for (const [k, t0] of Object.entries(db.rcsRemind)) { if (nowMs - t0 > 4 * 3600 * 1000) delete db.rcsRemind[k]; }
  save();
}
setInterval(() => { rcsPoll().catch(e => console.log('[rcs] 轮询异常', e.message)); }, 60 * 1000).unref();

server.listen(PORT, HOST, () => console.log(`[auth-server] http://${HOST}:${PORT} 已启动（数据文件 ${DB_FILE}）`));
