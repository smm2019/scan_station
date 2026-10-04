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
  material: { collect: false, inventory: false, export: true, mes_query: true, direct_transfer: false, requisition: true, receive_confirm: true, admin_panel: false },
  warehouse: { collect: true, inventory: true, export: true, mes_query: true, direct_transfer: true, requisition: false, receive_confirm: false, admin_panel: false },
  admin: { collect: true, inventory: true, export: true, mes_query: true, direct_transfer: true, requisition: true, receive_confirm: true, admin_panel: true },
};
const FEATURE_NAMES = { collect: '采集录入', inventory: '盘点模式', export: '导出下载', mes_query: 'MES查询', direct_transfer: '直调转单', requisition: '领料下单', receive_confirm: '签收确认', admin_panel: '管理后台' };

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
// 取货建议：PDA 同步的货位账本（含补齐的零件号 p / 数量 q / 批次 b）→ 该零件在架标签，FIFO 选框
function pickSuggest(partNo, needQty, excludeCodes) {
  const ex = excludeCodes || new Set();
  const boxes = db.ledger
    .filter(x => String(x.p || '').toUpperCase() === String(partNo || '').toUpperCase() && !ex.has(String(x.c).toUpperCase()))
    .map(x => ({ c: x.c, l: x.l, q: Number(x.q) || 0, b: String(x.b || ''), f: String(x.f || '') }))
    .sort((a, b) => (a.b || '9999').localeCompare(b.b || '9999') || a.l.localeCompare(b.l)); // 批次早优先
  let acc = 0; const pick = [];
  for (const x of boxes) {
    pick.push(x);
    acc += x.q;
    if (needQty > 0 && acc >= needQty) break;
    if (pick.length >= 8) break; // 最多建议 8 框
  }
  const noInfo = db.ledger.filter(x => String(x.p || '').toUpperCase() === String(partNo || '').toUpperCase() && !x.q).length;
  return { boxes: pick, total: acc, inStock: boxes.length, noInfoQty: noInfo };
}
function reqView(r) {
  const items = (r.items || []).map(i => {
    const excl = new Set(((i.issued || []).map(x => String(typeof x === 'string' ? x : (x.c || '')).toUpperCase()).filter(Boolean)));
    return { ...i, suggest: pickSuggest(i.partNo, Number(i.qty) || 0, excl) };
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
    // PDA 转单进度回写纸面：已转→绿色✓；跳过→灰色✗
    let stMark = '';
    if (i.transferred) stMark = ` <span style="color:#0a7d32;font-weight:bold">✓已转${got >= (Number(i.qty) || 0) ? '' : '(短装)'}</span>`;
    else if (i.skipped) stMark = ' <span style="color:#999">✗跳过</span>';
    // 货位列：系统按同步账本 FIFO 给建议；没数据则留手写格
    const sg = i.transferred || i.skipped ? null : pickSuggest(i.partNo, Number(i.qty) || 0, new Set(issuedOf(i).map(e => String(e.c).toUpperCase())));
    let locCell = '';
    if (sg && sg.boxes.length) {
      locCell = sg.boxes.slice(0, 4).map(b => `<div style="font-size:11px;line-height:1.35">${esc(b.l)}<span style="color:#666;font-family:Consolas,monospace"> ${esc(b.c)}</span>${b.q ? ` <span style="color:#888">${b.q}件</span>` : ''}</div>`).join('')
        + (sg.boxes.length > 4 ? `<div style="font-size:10px;color:#888">…共${sg.boxes.length}框</div>` : '');
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
    <th style="width:6%">#</th><th style="width:22%">零件号</th><th style="width:24%">物料名称</th>
    <th style="width:9%">申请数</th><th style="width:9%">已发数</th><th style="width:14%">货位(手写)</th><th style="width:16%">箱标签/实发(手写)</th>
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

// 货位账本查询页（电脑端公开）：按货位排序，同位多标签并排；顶部搜索框支持标签号/货位前缀
function renderLedgerBoard() {
  const meta = `共 ${db.ledger.length} 个标签 · ${new Set(db.ledger.map(x => x.l)).size} 个货位有货`;
  const info = db.ledgerAt ? `最后同步 ${esc(String(db.ledgerAt).slice(0, 19).replace('T', ' '))}（${esc(db.ledgerBy || '-')}，v${db.ledgerRev}）` : '尚未从 PDA 同步过';
  const rows = db.ledger.slice().sort((a, b) => String(a.l).localeCompare(String(b.l)) || String(a.c).localeCompare(String(b.c)));
  const bodyRows = rows.map(x => {
    const t = x.t ? new Date(x.t).toLocaleString('zh-CN', { hour12: false }) : '';
    return `<tr data-c="${esc(x.c)}" data-l="${esc(x.l)}" data-p="${esc(x.p || '')}" data-n="${esc(x.n || '')}"><td class="loc">${esc(x.l)}</td><td class="code">${esc(x.c)}</td><td class="pn">${esc(x.p || '')}</td><td>${esc(x.n || '')}</td><td class="num">${x.q ? esc(x.q) : ''}</td><td>${esc(x.b || '')}</td><td>${esc(x.f || '')}</td><td class="tm">${esc(t)}</td></tr>`;
  }).join('');
  const empty = rows.length ? '' : `<div class="empty">账本为空：请在 PDA「位置登记」导入账本或登记库位，同步后这里自动出现数据。</div>`;
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
  tr.hl{background:#fff3cd}
  .empty{text-align:center;color:#c77700;font-size:14px;padding:40px;background:#fff;border-radius:10px}
</style></head><body>
<h1>货位账本（PDA 同步）</h1>
<div class="sub">${meta} ｜ ${info}</div>
<div class="bar"><input id="q" placeholder="输入标签号或货位前缀（如 NB03-A-13）过滤" oninput="flt()"><button onclick="location.reload()">⟳ 刷新</button><span class="cnt" id="cnt"></span></div>
${empty}<table id="tb"${rows.length ? '' : ' style="display:none"'}><thead><tr><th style="width:14%">货位</th><th style="width:16%">标签号</th><th style="width:14%">零件号</th><th style="width:20%">物料名称</th><th style="width:8%">数量</th><th style="width:9%">批次</th><th style="width:11%">料框</th><th>登记时间</th></tr></thead><tbody>${bodyRows}</tbody></table>
<script>
function flt(){
  const q=document.getElementById('q').value.trim().toUpperCase();
  const rs=document.querySelectorAll('#tb tbody tr');
  let n=0;
  rs.forEach(r=>{
    const hit=!q || r.dataset.c.includes(q) || r.dataset.l.includes(q) || (r.dataset.p||'').toUpperCase().includes(q) || (r.dataset.n||'').toUpperCase().includes(q);
    r.style.display=hit?'':'none';
    r.classList.toggle('hl', !!q && r.dataset.c===q);
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
      return '<tr><td class="mono">'+esc(o.orderNo)+'</td><td class="mono">'+t2s(o.createdAt)+'</td><td>'+esc(o.operator||'')+'</td><td>'+esc(o.toLoc||'')+'</td><td class="mono">'+esc(o.linkReqNo||'')+'</td><td>'+its.length+'</td><td>'+(its.length&&cked===its.length?'<span class="ck">全部已核对</span>':cked+'/'+its.length)+'</td><td style="max-width:460px">'+its.map(function(e){return '<div class="mono" style="font-size:11px">'+esc(e.barcode)+' · '+esc(e.code)+' · '+esc(e.qty)+(e.fromLoc?' · <b>原 '+esc(e.fromLoc)+'</b>':'')+'</div>'}).join('')+'</td></tr>'
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
      return send(res, 200, { ok: true, rev: db.ledgerRev, at: db.ledgerAt, by: db.ledgerBy, total: db.ledger.length, count: list.length, items: list });
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
        if (!raw.length) return send(res, 400, { ok: false, msg: 'items 为空，已拒绝（防止误清空白账本）' });
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
            q: Number(it && it.q) || 0, b: String((it && it.b) || '').slice(0, 40) });
        }
        if (!clean.length) return send(res, 400, { ok: false, msg: '无有效条目（需 c=标签 且 l=货位）' });
        db.ledger = clean;
        db.ledgerRev = (db.ledgerRev || 0) + 1;
        db.ledgerAt = new Date().toISOString();
        db.ledgerBy = u.name;
        save();
        console.log(`[ledger] ${u.name} 同步账本 ${clean.length} 条 → v${db.ledgerRev}`);
        return send(res, 200, { ok: true, rev: db.ledgerRev, count: clean.length });
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
        db.scanlog = snap; db.scanlogAt = new Date().toISOString(); db.scanlogCount = Object.keys(snap).length;
        save();
        console.log(`[scanlog] ${u.name} 同步流水 ${db.scanlogCount} 条`);
        return send(res, 200, { ok: true, count: db.scanlogCount });
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
      if (p === '/api/requisitions' || p.startsWith('/api/requisitions/') || p === '/api/notifications') {
        const canReq = (db.features[u.role] || {}).requisition === true;
        const canRcv = (db.features[u.role] || {}).receive_confirm === true;
        const isWh = u.role === 'warehouse' || u.role === 'admin';

        // 下单
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
          const now = new Date();
          const ts = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
          const r = {
            id: newId('rq'), no: `LL${ts}${String(db.requisitions.length % 100).padStart(2, '0')}`,
            by: u.id, byName: u.name, items: clean, status: 'pending',
            remark: String(b.remark || ''), createdAt: now.toISOString(), history: [],
          };
          db.requisitions.push(r);
          db.users.filter(x => x.role === 'warehouse' && x.enabled).forEach(x =>
            notify(x.id, 'req_new', `${u.name} 提交了领料单 ${r.no}：${reqItemsSuggestText(r)}`, r.id));
          save();
          console.log(`[req] ${u.name} 下单 ${r.no}`);
          return send(res, 200, { ok: true, req: reqView(r) });
        }

        // 列表：物料员看自己的，仓管/管理员看全部；scope=todo 只看待办
        if (req.method === 'GET' && p === '/api/requisitions') {
          const q = (url.searchParams.get('scope') || '').trim();
          let list = db.requisitions.slice().reverse();
          if (u.role === 'material') list = list.filter(r => r.by === u.id);
          if (q === 'todo') list = isWh ? list.filter(r => r.status === 'pending' || r.status === 'accepted')
                                        : list.filter(r => r.status === 'ready' && r.by === u.id);
          return send(res, 200, { ok: true, reqs: list.map(reqView) });
        }

        // 通知拉取（取回即标记已读）
        if (req.method === 'GET' && p === '/api/notifications') {
          const mine = db.notifications.filter(n => n.to === u.id && !n.read);
          mine.forEach(n => n.read = true);
          if (mine.length) save();
          return send(res, 200, { ok: true, notifications: mine });
        }

        // 状态动作：/:id/accept|reject|scan|transfer|skip|loc|confirm|cancel
        const mAct = p.match(/^\/api\/requisitions\/([\w-]+)\/(accept|reject|scan|transfer|skip|loc|confirm|cancel)$/);
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
            r.status = 'accepted'; r.acceptedBy = u.name;
            hpush(`接单（${u.name}）`);
            notify(r.by, 'req_accept', `你的领料单 ${r.no} 已由 ${u.name} 接单备料`, r.id);
          } else if (act === 'reject') {
            if (!isWh) return send(res, 403, { ok: false, msg: '仅仓管员可拒单' });
            if (r.status !== 'pending') return send(res, 400, { ok: false, msg: `当前状态[${r.status}]不可拒单` });
            const reason = String(b.reason || '').trim() || '未说明';
            r.status = 'rejected'; r.rejectReason = reason;
            hpush(`拒单：${reason}`);
            notify(r.by, 'req_reject', `你的领料单 ${r.no} 被 ${u.name} 拒绝：${reason}`, r.id);
          } else if (act === 'scan') {
            if (!isWh) return send(res, 403, { ok: false, msg: '仅仓管员可扫码发料' });
            if (r.status !== 'accepted') return send(res, 400, { ok: false, msg: `当前状态[${r.status}]不可发料` });
            const code = String(b.barcode || '').trim();
            if (!code) return send(res, 400, { ok: false, msg: '缺少 barcode' });
            if (r.items.some(i => normIssued(i).some(e => e.c === code))) return send(res, 400, { ok: false, msg: `标签 ${code} 已扫过` });
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

server.listen(PORT, HOST, () => console.log(`[auth-server] http://${HOST}:${PORT} 已启动（数据文件 ${DB_FILE}）`));
