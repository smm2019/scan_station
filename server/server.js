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
  if (added) { saveDb(d); console.log('[init] 已补齐领料单/通知集合'); }
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
function notify(toUserId, type, text, reqId) {
  db.notifications.push({ id: newId('n'), to: toUserId, type, text, reqId: reqId || '', time: new Date().toISOString(), read: false });
  if (db.notifications.length > 500) db.notifications = db.notifications.slice(-500); // 只留最近500条防膨胀
}
function findReq(id) { return db.requisitions.find(r => r.id === id); }
function reqView(r) { return { ...r, statusText: REQ_STATUS_TEXT[r.status] || r.status }; }
function issuedOf(i) { return (i.issued || []).map(x => typeof x === 'string' ? { c: x, q: 0 } : { c: String(x.c || ''), q: Number(x.q) || 0 }); }
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
    return `<tr${i.transferred ? ' style="background:#f2fbf5"' : (i.skipped ? ' style="background:#f7f7f7;color:#999"' : '')}>
      <td>${idx + 1}</td>
      <td class="pn selectable">${esc(i.partNo)}</td>
      <td>${esc(i.itemName || '')}</td>
      <td class="num">${esc(i.qty)}</td>
      <td class="num">${got}${got >= (Number(i.qty) || 0) && !i.skipped ? ' ✔' : ''}${stMark}</td>
      <td class="handwrite">${i.transferred ? esc((r.toLoc && r.toLoc.LOC_NAME) || '') : ''}</td>
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
      return `<div class="it">${esc(i.partNo)} ${esc(i.itemName || '')}　申请${esc(i.qty)}${mark}</div>`;
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
    req.on('data', c => { size += c.length; if (size > 1e6) { reject(new Error('body too large')); req.destroy(); return; } data += c; });
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
            notify(x.id, 'req_new', `${u.name} 提交了领料单 ${r.no}：${reqItemsText(r)}`, r.id));
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
            target.issued.push({ c: code, q });
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
