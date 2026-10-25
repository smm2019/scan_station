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
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SESSION_TTL_MS = 12 * 3600 * 1000; // 12 小时滑动过期
const LOGIN_FAIL_LIMIT = 5; // 同一账号 1 分钟内最多失败 5 次
const LOGIN_FAIL_WINDOW_MS = 60 * 1000;

const ROLES = ['material', 'warehouse', 'inspector', 'admin']; // 物料员 / 仓管员 / 检验员 / 管理员
const ROLE_NAMES = { material: '物料员', warehouse: '仓管员', inspector: '检验员', admin: '管理员' };
// 按角色功能开关（管理员可在线改；App 登录与心跳时拉取）
const DEFAULT_FEATURES = {
  material: { collect: false, inventory: false, export: true, mes_query: true, direct_transfer: false, requisition: true, receive_confirm: true, location_reg: false, agv_monitor: false, agv_control: false, admin_panel: false, inspect_mode: false },
  inspector: { collect: false, inventory: false, export: true, mes_query: true, direct_transfer: false, requisition: false, receive_confirm: false, location_reg: false, agv_monitor: false, agv_control: false, admin_panel: false, inspect_mode: true },
  warehouse: { collect: true, inventory: true, export: true, mes_query: true, direct_transfer: true, requisition: false, receive_confirm: false, location_reg: true, agv_monitor: true, agv_control: true, admin_panel: false, inspect_mode: true },
  admin: { collect: true, inventory: true, export: true, mes_query: true, direct_transfer: true, requisition: true, receive_confirm: true, location_reg: true, agv_monitor: true, agv_control: true, admin_panel: true, inspect_mode: true, insp_assist: true },
  warehouse: { collect: true, inventory: true, export: true, mes_query: true, direct_transfer: true, requisition: false, receive_confirm: false, location_reg: true, agv_monitor: true, agv_control: true, admin_panel: false, inspect_mode: true, insp_assist: true },
};
// 功能开关判定：管理员在线关掉某角色开关后，服务器端同步拒绝（全局生效，不只UI隐藏）
function canFeature(u, key) { return !!(db.features && db.features[u.role] && db.features[u.role][key] === true); }
const FEATURE_NAMES = { collect: '采集录入', inventory: '盘点模式', export: '导出下载', mes_query: 'MES查询', direct_transfer: '直调转单', requisition: '领料下单', receive_confirm: '签收确认', location_reg: '位置登记', agv_monitor: 'AGV监控', agv_control: 'AGV车辆控制', admin_panel: '管理后台', inspect_mode: '检验模式', insp_assist: '检验协助控制' };

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
    watchlist: [], // ⑮预约来料 [{userId,partNo,at, qty:预订框数0=仅提醒, itemName, auto:到货自动开领料单, due:期望到货日YYYY-MM-DD, got:累计到料框, filledReq:已转单id}] // ㉖v94n 预约升级：数量预订+进度+自动开单（旧条目无新字段=纯通知型，行为不变）
    inspects: [], seenIn: {}, seenOut: {}, // ㉖④检验工单 / ①②标签生命周期索引 [{userId,partNo,at}]
    groundSlots: {}, // ⑮地面排格数覆盖 {"NB03-A-11":13}，缺省12
    reqTemplates: [], // ㉖v62 产线领料模板 {id,name,by,byName,shared,items,use,at}
    gndZoneRows: {}, // ㉖v59 地面按区排数覆盖 {"A":15,"B":10}，缺省=每区排数参数；0=整区不用
    gndRowOff: {}, // ㉖v59 地面停用排 {"NB03-A-01":1}，停用排地图灰显、不计入格位统计（账本有货仍显示提醒）
  gndZoneList: {}, // ㉖v90 地面真实排号清单 {"A":[11,12,...],"G":[4,5,6,7,8,9,11]}——现场各区排号不连续（如A区只有11-18），配置后地图/统计按清单画；未配置区沿用按区排数
    stockAlert: {}, // ⑮断料告警去重 {零件号: 最近告警日}
    prefs: {}, // ㉕F5 个人偏好 {userId:{key:{v,at}}}（后写覆盖=方案"到达序新者胜"）
    prefTemplates: [], // ㉕F5 管理员配置模板 [{name,prefs,by,at}]
    errLogs: [], // ㉖⑩ PDA异常日志自动上报 [{id,at,by,dev,app,items:[{t,e,d,u}]}]（180天/2000批滚动）
    stnMeta: {}, // ㉖⑫ 站台身份自定义 {编码:{alias:别名,role:any|out|in|insp,off:停用布尔,by,at}}
    containerTypes: [ // ㉖⑳ 容器类型可配置（采集页按钮动态生成；db=落库值=WMAS主档匹配关键字）
      { db: '1800*1200_2', show: '1.8米铁框' }, { db: '1600*1100', show: '1.6米铁框' }, { db: '2.4米铁框', show: '2.4米铁框' }, { db: '华强铁框', show: '华强铁框' }, { db: '托盘', show: '托盘' },
    ],
  };
}
// ---- ㉕F6 凭据静态加密（AES-256-GCM，密钥 data/secret.key 不进git）+ ㉕F5 偏好/㉕F9 归档工具 ----
const KEY_FILE = path.join(DATA_DIR, 'secret.key');
function secretKey() { try { if (fs.existsSync(KEY_FILE)) return Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex'); } catch (_) {} const k = crypto.randomBytes(32); try { fs.writeFileSync(KEY_FILE, k.toString('hex')); } catch (_) {} return k; }
function encSec(s) { if (!s || String(s).indexOf('enc1:') === 0) return s; try { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', secretKey(), iv); const e = Buffer.concat([c.update(String(s), 'utf8'), c.final()]); return 'enc1:' + iv.toString('base64') + ':' + c.getAuthTag().toString('base64') + ':' + e.toString('base64'); } catch (_) { return s; } }
function decSec(s) { if (!s || String(s).indexOf('enc1:') !== 0) return s; try { const q = String(s).split(':'); const d = crypto.createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(q[1], 'base64')); d.setAuthTag(Buffer.from(q[2], 'base64')); return Buffer.concat([d.update(Buffer.from(q[3], 'base64')), d.final()]).toString('utf8'); } catch (_) { console.log('[sec] secret.key 与 db.json 不匹配：RCS/WMAS 密码需在设置页重录一次'); return ''; } }
function walkSec(o, fn) { for (const k of ['rcsConfig', 'wmasConfig']) { const c = o[k]; if (c && c.pwd) fn(c, 'pwd'); } if (o.rcsToken) fn(o, 'rcsToken'); }
function clientFp(req) { let ip = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, ''); const seg = ip.indexOf(':') >= 0 ? ip.split(':').slice(0, 2).join(':') : ip.split('.').slice(0, 2).join('.'); return crypto.createHash('sha1').update(seg + '|' + String(req.headers['user-agent'] || '')).digest('hex').slice(0, 12); }
function prefsFor(uid) { const o = (db.prefs && db.prefs[uid]) || {}; const r = {}; for (const k in o) { if (k === 'notes') r[k] = o[k].v; else if (k === 'kpi') r[k] = Array.isArray(o[k].v) ? o[k].v : []; else if (k === 'pd_tabs' || k === 'pd_tabuse' || k === 'ck_use' || k === 'ck_tabs' || k === 'ck_tabuse') r[k] = String(o[k].v == null ? '' : o[k].v).slice(0, (k === 'ck_use') ? 8000 : 4000); // v56 网页页签配置/驻留统计透传
    else if (k === 'pd_tab_auto' || k === 'ck_tab_auto') r[k] = o[k].v === true; else if (k === 'ck_accent' || k === 'ck_darkmode' || k === 'ck_density' || k === 'ck_zoom') r[k] = String(o[k].v || ''); else if (k === 'pd_tab_auto') r[k] = o[k].v === true; else if (k === 'work') r[k] = Number(o[k].v) === 1 ? 1 : 0; else if (k === 'rate') r[k] = Math.min(0.9, Math.max(0.3, Number(o[k].v) || 0.55)); else if (k === 'voice') r[k] = o[k].v !== false; else if (k === 'pd_focus' || k === 'pd_defAssignee') r[k] = o[k].v !== false; else if (k === 'pd_font') r[k] = ['std','lg','xl'].includes(String(o[k].v)) ? String(o[k].v) : 'std'; else if (k === 'pd_dateOffset') r[k] = Math.min(90, Math.max(0, Number(o[k].v) || 0)); else if (k === 'pd_defPallet') r[k] = String(o[k].v == null ? '' : o[k].v).slice(0, 20); else r[k] = String(o[k].v == null ? '' : o[k].v).slice(0, 20); } return r; }
function archLoad(kind) { const out = {}; try { const dir = path.join(DATA_DIR, 'archive'); for (const f of fs.readdirSync(dir)) { if (f.indexOf('-' + kind + '.json') < 0) continue; try { Object.assign(out, JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch (_) {} } } catch (_) {} return out; }
// ㉖v56 断电纵深防御：完整性校验 + 启动自动回滚 + 滚动安全副本
const SAFE_FILE = path.join(DATA_DIR, 'db.safe.json'); // 不脱敏全量安全副本（备份目录被误删时的最后兜底）
const _dbHealth = { lastOk: 0, lastRecover: 0, recoverCount: 0, safeAt: 0 }; // 持久化健康状态（供健康分暴露）
function dbIntact(file) { // 文件级完整性：存在/够大/非全零/可解析/含关键字段。返回 {ok, reason}
  try {
    if (!fs.existsSync(file)) return { ok: false, reason: '文件不存在' };
    const st = fs.statSync(file);
    if (st.size < 200) return { ok: false, reason: '文件过小(' + st.size + 'B)' };
    const buf = fs.readFileSync(file);
    let nz = 0; const probe = Math.min(buf.length, 4096); for (let i = 0; i < probe; i++) if (buf[i] !== 0) { nz++; if (nz > 16) break; } // 抽样前4KB，>16个非零即非空洞
    if (nz <= 16) return { ok: false, reason: '疑似全零空洞(断电未刷盘)' };
    const d = JSON.parse(buf.toString('utf8'));
    if (!d || typeof d !== 'object' || !Array.isArray(d.users) || !d.users.length) return { ok: false, reason: '结构异常(无users)' };
    return { ok: true };
  } catch (e) { return { ok: false, reason: 'JSON解析失败:' + String(e.message || '').slice(0, 40) }; }
}
function latestGoodBackup() { // 从新到旧找第一个完好的备份
  try {
    const dir = path.join(DATA_DIR, 'backups');
    if (!fs.existsSync(dir)) return null;
    const all = fs.readdirSync(dir).filter((f) => /^db-.*\.json$/.test(f)).sort().reverse();
    for (const f of all) { const p = path.join(dir, f); if (dbIntact(p).ok) return p; }
  } catch (_) {}
  return null;
}
// ㉖v80 本地时间戳（yyyyMMddHHmmss）：单号/文件名与现场对时一致，替代 toISOString 的 UTC 差8小时问题
function localTs(d) { d = d || new Date(); const p = (n) => String(n).padStart(2, '0'); return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); }
// ㉖v85 唯一临时名原子写（saveDb/安全副本/恢复/备份共用）。旧实现固定 target+'.tmp'：双实例或维护脚本并发时，
// 一方 rename 会把另一方刚写好的同名临时文件"偷走"，后者 rename 即 ENOENT（2026-10-22 22:40~23:41 saveDb×30 事故根因；
// 双实例本身已由 v69 幻影守卫拦截，本改动把文件级串扰整类消除）。失败换名重试一次（防杀软瞬时锁），仍败上抛由 _dirty 重试兜底。
let _tmpSeq = 0;
function atomicWrite(target, data) {
  let lastErr = null;
  for (let _try = 0; _try < 2; _try++) {
    const tmp = target + '.tmp-' + process.pid + '-' + (++_tmpSeq);
    try {
      fs.writeFileSync(tmp, data, 'utf8');
      let _fd = -1; try { _fd = fs.openSync(tmp, 'r+'); fs.fsyncSync(_fd); } catch (_) {} finally { if (_fd >= 0) try { fs.closeSync(_fd); } catch (_) {} } // 数据块强制刷盘后再rename（v56 断电加固语义不变）
      fs.renameSync(tmp, target);
      let _dfd = -1; try { _dfd = fs.openSync(path.dirname(target), 'r'); fs.fsyncSync(_dfd); } catch (_) {} finally { if (_dfd >= 0) try { fs.closeSync(_dfd); } catch (_) {} } // 目录元数据落盘（NTFS 原子写完整姿势）
      return;
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (_) {} // 清掉本次半成品，不留孤儿
      lastErr = e;
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60); } catch (_) {} // 瞬时锁短等60ms后换名重试
    }
  }
  throw lastErr;
}
function cleanOrphanTmp() { // ㉖v85 启动后清理历史孤儿临时文件：只匹配本服务命名模式且 mtime 超60分钟（正常写在途仅毫秒级，绝不误删在途文件）
  try {
    const cut = Date.now() - 60 * 60 * 1000;
    for (const f of fs.readdirSync(DATA_DIR)) {
      if (!/^db(\.safe)?\.json\.tmp(-\d+-\d+)?$/.test(f)) continue;
      const fp = path.join(DATA_DIR, f);
      try { if (fs.statSync(fp).mtimeMs < cut) fs.unlinkSync(fp); } catch (_) {}
    }
  } catch (_) {}
}
function archiveCorrupt(reason) { // 把损坏主文件归档留证（不删），返回是否归档
  try {
    if (!fs.existsSync(DB_FILE)) return false;
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const dst = DB_FILE + '.corrupt-' + ts;
    fs.renameSync(DB_FILE, dst);
    console.log('[recover] 损坏主文件已归档 ' + path.basename(dst) + '（原因：' + reason + '）');
    return true;
  } catch (_) { return false; }
}
function restoreFrom(src, label) { // 从源文件恢复到主文件（原子写），成功返回true
  try {
    const raw = fs.readFileSync(src, 'utf8');
    JSON.parse(raw); // 二次确认
    atomicWrite(DB_FILE, raw); // ㉖v85 唯一临时名
    console.log('[recover] 已从 ' + label + ' 自动恢复主数据文件');
    return true;
  } catch (e) { console.log('[recover] 从 ' + label + ' 恢复失败：', e.message); return false; }
}
function updateSafeCopy(d) { // 用内存态写一份不脱敏安全副本（原子+fsync）
  try {
    atomicWrite(SAFE_FILE, JSON.stringify(d)); // ㉖v85 唯一临时名
    _dbHealth.safeAt = Date.now();
  } catch (_) {}
}
function loadDb() {
  // ㉖v56 启动自检：主文件损坏→安全副本→最新备份，逐级自动回滚（无人值守自愈，杜绝全零文件起不来）
  if (fs.existsSync(DB_FILE)) {
    const chk = dbIntact(DB_FILE);
    if (!chk.ok) {
      console.log('[recover] 主数据文件损坏：' + chk.reason + '，尝试自动恢复…');
      archiveCorrupt(chk.reason);
      let recovered = false;
      if (fs.existsSync(SAFE_FILE) && dbIntact(SAFE_FILE).ok) recovered = restoreFrom(SAFE_FILE, '安全副本 db.safe.json');
      if (!recovered) { const bk = latestGoodBackup(); if (bk) recovered = restoreFrom(bk, '备份 ' + path.basename(bk)); }
      if (recovered) { _dbHealth.lastRecover = Date.now(); _dbHealth.recoverCount++; }
      else { console.log('[recover] 无可用安全副本/备份，将创建空库（请立即从外部备份恢复！）'); }
    } else { _dbHealth.lastOk = Date.now(); }
  }
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
  if (!Array.isArray(d.watchlist)) { d.watchlist = []; added = true; }
  if (!d.params || typeof d.params !== 'object' || Array.isArray(d.params)) { d.params = {}; added = true; }
  if (!Array.isArray(d.carEvents)) { d.carEvents = []; added = true; }
  if (!Array.isArray(d.inspects)) { d.inspects = []; added = true; } // 检验模式工单
  if (!d.seenOut || typeof d.seenOut !== 'object') { d.seenOut = {}; added = true; }
  if (!d.seenIn || typeof d.seenIn !== 'object') { d.seenIn = {}; added = true; } // 历史录入过的标签（跨批次/跨设备永久防重，不受窗口截断） // 曾出库标签登记（跨生命周期防重） // ㉖异常事件持久表（180天滚动，恢复即归档不删除）
  if (typeof d.groundSlots !== 'object' || d.groundSlots === null || Array.isArray(d.groundSlots)) { d.groundSlots = {}; added = true; }
  if (typeof d.gndZoneRows !== 'object' || d.gndZoneRows === null || Array.isArray(d.gndZoneRows)) { d.gndZoneRows = {}; added = true; } // ㉖v59 按区排数覆盖（旧库补齐）
  if (typeof d.gndRowOff !== 'object' || d.gndRowOff === null || Array.isArray(d.gndRowOff)) { d.gndRowOff = {}; added = true; } // ㉖v59 停用排（旧库补齐）
  if (typeof d.gndZoneList !== 'object' || d.gndZoneList === null || Array.isArray(d.gndZoneList)) { d.gndZoneList = {}; added = true; } // ㉖v90 真实排号清单（旧库补齐）
  // ㉖v61 出库流水乱码自愈：PDA/WMAS 推送编码丢失产生的 U+FFFD 与控制字符——name 按标签反查流水/账本/字典回填干净名，查不到则剥替换符；move 归一 AGV/人工
  {
    const _bad = /[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;
    const _has = (s0) => { _bad.lastIndex = 0; return _bad.test(s0); }; // 复检修复：/g 正则 test 有 lastIndex 状态，连续调用会漏检
    const _nmByCode = {};
    for (const s0 of Object.values(d.scanlog || {})) { const c0 = String(s0.code || '').toUpperCase(); if (c0 && s0.nm && !_has(String(s0.nm)) && !_nmByCode[c0]) _nmByCode[c0] = String(s0.nm); }
    for (const x0 of (d.ledger || [])) { const c0 = String(x0.c || '').toUpperCase(); if (c0 && x0.n && !_has(String(x0.n)) && !_nmByCode[c0]) _nmByCode[c0] = String(x0.n); }
    for (const [k0, v0] of Object.entries(d.itemDict || {})) { if (v0 && v0.nm && !_has(String(v0.nm)) && !_nmByCode[String(k0).toUpperCase()]) _nmByCode[String(k0).toUpperCase()] = String(v0.nm); }
    let _fx = 0;
    // ㉖v61b 账本搬运方式自愈：mv 归一枚举（登记/人工/AGV），替换符剥离后按残字判定
    const _mvNorm = (v0) => { const s0 = String(v0 || '').replace(_bad, '').trim(); if (!s0) return ''; if (/AGV/i.test(s0)) return 'AGV'; if (s0.includes('记') || s0.includes('登記')) return '登记'; if (s0.includes('人工')) return '人工'; return s0.length <= 4 ? s0 : '人工'; };
    for (const x0 of (d.ledger || [])) { const mv0 = String(x0.mv || ''); if (mv0 && _has(mv0)) { x0.mv = _mvNorm(mv0); _fx++; } }
    // ㉖v95b 账本容器类型 f 乱码自愈：剥离后与容器类型字典四级匹配归一（共享函数 ctNorm，loadDb 期 db 未就绪显式传字典）
    {
      for (const x0 of (d.ledger || [])) { const f0 = String(x0.f || ''); if (f0 && _has(f0)) { x0.f = ctNorm(f0, d.containerTypes); _fx++; } }
      for (const st0 of Object.values(d.scanlog || {})) { const c0 = String(st0.ct || ''); if (c0 && _has(c0)) { st0.ct = ctNorm(c0, d.containerTypes); _fx++; } }
    }
    // ㉖v61b 字典脏名清理：零件号反查流水/账本干净名覆盖，查不到剥替换符
    for (const [k0, v0] of Object.entries(d.itemDict || {})) {
      if (v0 && _has(String(v0.nm || ''))) {
        const good = _nmByCode[String(k0).toUpperCase()];
        v0.nm = good ? good : String(v0.nm).replace(_bad, '').replace(/\s+/g, ' ').trim();
        _fx++;
      }
    }
    // ㉖v61b 审计文本【不在此清洗】：ops 权威层是按天 JSONL（断链摘要按文件行计算），只清内存 d.ops 会造成双源不一致；
    // 历史乱码留痕在 /api/admin/ops 与 D9 导出的【显示层】剥离（存档与摘要不动），新留痕由推送侧 ctNorm/_cw 源头防污
    for (const o of Object.values(d.outbound || {})) {
      for (const it of (o.items || [])) {
        const nm0 = String(it.name || '');
        if (_has(nm0)) {
          const bc = String(it.barcode || it.code || '').toUpperCase();
          const pc = String(it.code || '').toUpperCase();
          const good = _nmByCode[bc] || _nmByCode[pc];
          it.name = good ? good : nm0.replace(_bad, '').replace(/\s+/g, ' ').trim();
          _fx++;
        }
        const mv0 = String(it.move || '');
        if (mv0 && _has(mv0)) { it.move = /AGV/i.test(mv0.replace(_bad, '')) ? 'AGV' : mv0.replace(_bad, '').includes('人工') || mv0.length <= 6 ? '人工' : mv0.replace(_bad, '').trim() || '人工'; _fx++; }
      }
      if (_has(String(o.operator || ''))) { o.operator = String(o.operator).replace(_bad, '').trim(); _fx++; }
      if (_has(String(o.toLoc || ''))) { o.toLoc = String(o.toLoc).replace(_bad, '').trim(); _fx++; }
    }
    if (_fx) { added = true; console.log('[migrate] 出库流水乱码自愈 ' + _fx + ' 处（name 反查回填/替换符剥离，move 归一）'); }
  }
  // ㉖v69 账本世代标记：数据迁移整表替换盖章一次；旧版PDA缓存凭世代对比清理旧数据，推送侧拦旧世代防污染新账本（今后任何整表重置都换一个新值）
  if (!d.ledgerEpoch) { d.ledgerEpoch = 'IMP-20261022'; d.ledgerEpochAt = Date.now(); added = true; }
  if (typeof d.ledgerAt === 'number') { d.ledgerAt = new Date(d.ledgerAt).toISOString(); added = true; console.log('[migrate] ledgerAt 数字毫秒→ISO 字符串自愈（网页/看板 .slice 依赖字符串格式）'); } // ㉖v69b 补录脚本误写数字致页面加载失败
  if (typeof d.scanlogAt === 'number') { d.scanlogAt = new Date(d.scanlogAt).toISOString(); added = true; } // 同类字段一并防御
  if (typeof d.outboundAt === 'number') { d.outboundAt = new Date(d.outboundAt).toISOString(); added = true; }
  // ㉖v69c 墓碑自愈+世代重盖：导入把行时间设为账本日期(10-21)，比测试期墓碑(10-22晨)更旧，
  // N26J200139 等框被推送侧墓碑闸误判"删除记录复活"拒绝→PDA"货位登记冲突"弹窗循环，且PDA每次拉取重新落墓碑、本地在架行反被删。
  // 整表替换后旧世代墓碑一律失效；与在架行冲突的墓碑无条件清除。世代换新章→各PDA下次进页强制清旧缓存（含误拿的墓碑）重新对齐。
  if (d.ledgerEpoch === 'IMP-20261022') {
    if (Array.isArray(d.ledgerTomb) && d.ledgerTomb.length) {
      const _live = new Set((d.ledger || []).map((x) => String(x.c || '').toUpperCase()));
      const _cut = Number(d.ledgerEpochAt) || 0;
      const _b = d.ledgerTomb.length;
      d.ledgerTomb = d.ledgerTomb.filter((x) => {
        const t = Number(x && x.t) || 0;
        return !(_cut && t && t < _cut) && !_live.has(String((x && x.c) || '').toUpperCase());
      });
      if (d.ledgerTomb.length !== _b) console.log('[migrate] 墓碑自愈清退 ' + (_b - d.ledgerTomb.length) + ' 条过期记录（迁移前测试世代或与在架行冲突）');
    }
    d.ledgerEpoch = 'IMP-20261022b'; d.ledgerEpochAt = Date.now(); added = true;
  }
  // ㉖v79c 拼接标签号自愈：Excel 导入把"一框多标签"整格存成 "A; B" 单行（20行），扫单码匹配不到账本行——
  // 发料不拣下(在架虚高)、原货位查不到(出库流水空)、PDA本地无行(叫车拿错码)三症同源。
  // 拆成每标签一行(q按标签数均分，余数给前行)，其中已出库/已发料的标签直接消账落墓碑
  {
    const _ship = new Set();
    for (const o of Object.values(d.outbound || {})) for (const it of (o.items || [])) String(it.barcode || '').split(/[;；]/).forEach((b) => { const s = b.trim().toUpperCase(); if (s) _ship.add(s); });
    for (const r of d.requisitions || []) for (const it of (r.items || [])) for (const e of (it.issued || [])) String(typeof e === 'string' ? e : (e.c || '')).split(/[;；]/).forEach((b) => { const s = b.trim().toUpperCase(); if (s) _ship.add(s); });
    const _have = new Set((d.ledger || []).map((x) => String(x.c || '').toUpperCase()));
    const _locOf = {}; // 码→原货位（拼接行拆分+队列在途起点），供出库明细回填
    for (const q of d.agvQueue || []) { if (q.code && q.fromLoc && /^NB0/.test(String(q.fromLoc))) _locOf[String(q.code).toUpperCase()] = String(q.fromLoc).toUpperCase(); }
    const _keep = []; let _n = 0, _gone = 0;
    for (const x of d.ledger || []) {
      const cs = String(x.c || '').split(/[;；]/).map((s) => s.trim().toUpperCase()).filter(Boolean);
      if (cs.length < 2) { _keep.push(x); continue; }
      _n++;
      const tot = Number(x.q) || 0; const per = Math.floor(tot / cs.length); let rem = tot - per * cs.length;
      for (const c of cs) {
        if (_have.has(c)) continue; // 已有单码行不重复建
        _have.add(c);
        _locOf[c] = String(x.l || '').toUpperCase();
        if (_ship.has(c)) { (d.ledgerTomb = d.ledgerTomb || []).push({ c, t: Date.now(), rec: Date.now() }); _gone++; continue; } // 已出库/已发料→消账
        _keep.push(Object.assign({}, x, { c, q: per + (rem > 0 ? 1 : 0), hist: [] })); if (rem > 0) rem--;
      }
    }
    if (_n) { d.ledger = _keep; added = true; console.log('[migrate] 拼接标签号自愈：拆 ' + _n + ' 行为单码，其中已出库直接消账 ' + _gone + ' 码'); }
    let _bf = 0;
    // ㉖v80 历史证据回填：这些码发料时旧版PDA未带原货位、队列项又已过期清理，
    // 从导入后完整备份 db-20261022-2152（421行WPS导入签名）逐一取回原货位并核对零件号一致后固化
    // ㉖v84 追加3码：070070/070068 出自拼接行备份(NB02-B-02-3F 一框三码)，200156 出自导入备份行(NB02-B-12-2F)；
    // 其余6码（H030146/144直调、230379/380/461/464世代闸误拒期发料）服务器账本从未有过该行，位置证据不存在，不回填
    const _histEvi = { N26J180283: 'NB02-A-07-3F', N26J210229: 'NB02-C-09-2F', N26J180333: 'NB03-A-12-02', N26J180341: 'NB03-B-11-07', N26J070070: 'NB02-B-02-3F', N26J070068: 'NB02-B-02-3F', N26J200156: 'NB02-B-12-2F' };
    for (const [c, l] of Object.entries(_histEvi)) if (!_locOf[c]) _locOf[c] = l;
    for (const o of Object.values(d.outbound || {})) for (const it of (o.items || [])) { const c = String(it.barcode || '').trim().toUpperCase(); if (!it.fromLoc && c && _locOf[c]) { it.fromLoc = _locOf[c]; _bf++; } }
    if (_bf) { added = true; console.log('[migrate] 出库明细原货位回填 ' + _bf + ' 行（拼接拆分/队列起点）'); }
    // ㉖v85b 流水初始货位自愈：PDA只扫到区排时流水gl是粗码（实测A16/C11/H7×4条挂⚠未登记），
    // 账本同码已是完整格位（网页补录/修正过）→ 启动时对齐升级。10/23复盘：gl2手工补丁脚本未生效且一次性脚本不可靠，
    // 固化进 migrate 后每次启动自动收敛，配合推送侧实时对齐，彻底摆脱人工修数
    {
      const _fullL = {};
      for (const x of d.ledger || []) { const l = String(x.l || ''); if (/^NB\d{2}-[A-Z]-\d+-/.test(l)) _fullL[String(x.c || '').toUpperCase()] = l.toUpperCase(); }
      let _gf = 0;
      for (const s of Object.values(d.scanlog || {})) {
        if (s.cx) continue;
        const gl = String(s.gl || '');
        if (!gl || /^NB\d{2}-[A-Z]-\d+-/.test(gl)) continue; // 空值不动（无证据），已是完整格位不动
        if (_fullL[String(s.code || '').toUpperCase()]) { s.gl = _fullL[String(s.code || '').toUpperCase()]; _gf++; }
      }
      if (_gf) { added = true; console.log('[migrate] 流水初始货位自愈：' + _gf + ' 条粗码已按账本对齐完整格位'); }
    }
    // ㉖v85c 地面入库账本自愈：旧版PDA地面模式"选区自动落格"是死代码（选区在调用前已被清空），
    // 扫完只留粗码流水（gl=H9）、账本无行 → 网页⚠未登记且库存查无（实测 N26J230458/459 19:53 两框）。
    // 对流水粗码、账本缺行、无出库史、无墓碑的框：按该排首个空格位（groundSlots 格数）自动补登账本并把流水升到完整格位。
    // 幂等：补登后 gl 已是完整格位，下次启动不再命中；PDA 端 v85c APK 上线后新扫在源头即落格，本通道只兜底存量与未升级设备
    {
      const _shipAll = new Set();
      for (const o of Object.values(d.outbound || {})) for (const it of (o.items || [])) String(it.barcode || '').split(/[;；]/).forEach((b) => { const s2 = b.trim().toUpperCase(); if (s2) _shipAll.add(s2); });
      for (const r of d.requisitions || []) for (const it of (r.items || [])) for (const e of (it.issued || [])) String(typeof e === 'string' ? e : (e.c || '')).split(/[;；]/).forEach((b) => { const s2 = b.trim().toUpperCase(); if (s2) _shipAll.add(s2); });
      const _tombAll = new Set((d.ledgerTomb || []).map((x) => String(x.c || '').toUpperCase()));
      const _ledCodes = new Set((d.ledger || []).map((x) => String(x.c || '').toUpperCase()));
      const _occByRow = {}; // 'NB03-H-09' → Set('01','02'...)
      for (const x of d.ledger || []) {
        const m2 = String(x.l || '').match(/^(NB\d{2})-([A-H])-(\d{1,2})-(\d{1,2})$/); // 仅地面数字格位（高架3F等不匹配=天然排除）
        if (!m2) continue;
        const pref = m2[1] + '-' + m2[2] + '-' + m2[3].padStart(2, '0');
        (_occByRow[pref] = _occByRow[pref] || new Set()).add(m2[4].padStart(2, '0'));
      }
      const _gs = d.groundSlots || {};
      let _rg = 0;
      for (const s of Object.values(d.scanlog || {})) {
        if (s.cx || Number(s.wt) !== 1) continue;
        const gm = String(s.gl || '').match(/^([A-H])-?(\d{1,2})$/); // 粗码 H9 / H-09 等
        if (!gm) continue;
        const code = String(s.code || '').trim().toUpperCase();
        if (!code || _ledCodes.has(code) || _tombAll.has(code) || _shipAll.has(code)) continue; // 已登记/已消账/已出库不动
        const prefix = 'NB03-' + gm[1] + '-' + gm[2].padStart(2, '0');
        const maxSlot = Number(_gs[prefix]) || 12;
        const occ = _occByRow[prefix] || new Set();
        let slot = '';
        for (let i = 1; i <= maxSlot; i++) { const ss = String(i).padStart(2, '0'); if (!occ.has(ss)) { slot = ss; break; } }
        if (!slot) continue; // 该区排满：留给人工处理，不臆造跨区
        const full = prefix + '-' + slot;
        occ.add(slot);
        (d.ledger = d.ledger || []).push({ c: code, l: full, f: String(s.ct || ''), t: Number(s.t) || Date.now(), p: String(s.pn || ''), n: String(s.nm || ''), q: Number(s.q) || 0, b: String(s.batch || '').slice(0, 20), pid: '', mv: '人工', src: String(s.gl), by: String(s.op || '系统自愈'), rec: Date.now(), hist: [] });
        _ledCodes.add(code);
        s.gl = full;
        _rg++;
        console.log('[migrate] 地面入库自愈补登 ' + code + ' → ' + full);
      }
      if (_rg) { added = true; console.log('[migrate] 地面入库账本自愈：补登 ' + _rg + ' 框（粗码流水升完整格位）'); }
    }
    // ㉖v92c issued 原货位回填：normIssued 旧版丢 l 字段（10/24 复盘：DT 出库流水 7 条 NB03 地面框原货位空白）
    // 从最新每日快照按标签号找回货位；seenIn 次之。一次性、幂等（有 l 不动）
    {
      let _snap = null;
      try {
        const dir0 = path.join(DATA_DIR, 'snapshots');
        const fl = fs.readdirSync(dir0).filter((x) => /^ledger-\d{8}\.json$/.test(x)).sort();
        if (fl.length) _snap = JSON.parse(fs.readFileSync(path.join(dir0, fl[fl.length - 1]), 'utf8'));
      } catch (_) {}
      const _locSnap = {};
      if (_snap) for (const x of _snap.items || []) _locSnap[String(x.c || '').toUpperCase()] = String(x.l || '').toUpperCase();
      let _lf = 0;
      for (const r of d.requisitions || []) for (const it of r.items || []) for (const e of (it.issued || [])) {
        if (typeof e !== 'object' || !e || e.l || !e.c) continue;
        const C = String(e.c).toUpperCase();
        const L0 = _locSnap[C] || String(((d.seenIn || {})[C] || {}).l || '').toUpperCase();
        if (L0) { e.l = L0; _lf++; }
      }
      if (_lf) { added = true; console.log('[migrate] issued 原货位回填 ' + _lf + ' 条（快照/seenIn 溯源）'); }
      // ㉖v92h 出库单层同步回填：outbound 是转单瞬间组装的快照——v92c 修复前 issued[].l 已被抹，快照里 fromLoc 就是空
      // （10/24 复盘：领料单层 14/14 有值但网页出库流水仍空白，读的是这层）。按框码反查领料单 issued[].l，seenIn 兜底
      const _issL = {};
      for (const r0 of d.requisitions || []) for (const it0 of r0.items || []) for (const e0 of it0.issued || []) {
        if (e0 && typeof e0 === 'object' && e0.c && e0.l) _issL[String(e0.c).toUpperCase()] = String(e0.l).toUpperCase();
      }
      let _of = 0;
      for (const o0 of Object.values(d.outbound || {})) for (const it0 of o0.items || []) {
        if (it0.fromLoc) continue;
        const bc = String(it0.barcode || '').toUpperCase();
        if (!bc) continue;
        const L1 = _issL[bc] || String(((d.seenIn || {})[bc] || {}).l || '').toUpperCase();
        if (L1) { it0.fromLoc = L1; _of++; }
      }
      if (_of) { added = true; console.log('[migrate] 出库单原货位回填 ' + _of + ' 行（领料单issued/seenIn 溯源）'); }
    }
  }
  if (typeof d.stockAlert !== 'object' || d.stockAlert === null || Array.isArray(d.stockAlert)) { d.stockAlert = {}; added = true; }
  if (typeof d.cyclePlans !== 'object' || d.cyclePlans === null || Array.isArray(d.cyclePlans)) { d.cyclePlans = {}; added = true; } // ㉖v63 循环盘点当日计划
  if (typeof d.cycleLog !== 'object' || d.cycleLog === null || Array.isArray(d.cycleLog)) { d.cycleLog = {}; added = true; } // ㉖v63 验证留痕 {日:{格:{r,by,at,note}}}
  if (typeof d.prefs !== 'object' || d.prefs === null || Array.isArray(d.prefs)) { d.prefs = {}; added = true; }
  if (!Array.isArray(d.prefTemplates)) { d.prefTemplates = []; added = true; }
  if (!Array.isArray(d.errLogs)) { d.errLogs = []; added = true; } // ㉖ PDA异常上报表（旧库补齐）
  if (typeof d.stnMeta !== 'object' || d.stnMeta === null || Array.isArray(d.stnMeta)) { d.stnMeta = {}; added = true; } // ㉖⑫ 站台身份配置（旧库补齐）
  if (!d.locReserve || typeof d.locReserve !== 'object' || Array.isArray(d.locReserve)) { d.locReserve = {}; added = true; } // ㉖v54 货位预占表（旧库补齐）
  if (!d.inspSeen || typeof d.inspSeen !== 'object' || Array.isArray(d.inspSeen)) { d.inspSeen = {}; added = true; } // ㉖v55 检验历史索引（标签→最近结论）
  if (!d.devices || typeof d.devices !== 'object' || Array.isArray(d.devices)) { d.devices = {}; added = true; } // ㉖v56 登录设备注册表
  if (!Array.isArray(d.devAudit)) { d.devAudit = []; added = true; } // ㉖v56 设备审计（登录/踢出/信任/拉黑留痕）
  if (!Array.isArray(d.containerTypes) || !d.containerTypes.length) { d.containerTypes = defaultDb().containerTypes; added = true; } // ㉖ 容器类型配置（旧库补齐默认5项）
  if (!d.seenOutFixV68) { // ㉖v68 历史出库索引自愈：旧版同步误把 code（零件号）当键登记，按标签查"曾出库"永远落空——
    // 只清"键=零件号且该零件确实在出库单出现过"的误写条目（防误删领料转MES路径写入的正确标签键），再按在用出库单标签全量补登记
    const _pcSet = new Set();
    for (const o of Object.values(d.outbound || {})) for (const it of (o.items || [])) { const p1 = String(it.code || '').toUpperCase(); if (p1) _pcSet.add(p1); }
    let _clr = 0;
    for (const [k0, v0] of Object.entries(d.seenOut || {})) { if (_pcSet.has(String(k0).toUpperCase()) && !/[A-Z]\d{6,}/.test(String(k0))) { delete d.seenOut[k0]; _clr++; } }
    let _add = 0;
    for (const o of Object.values(d.outbound || {})) { for (const it of (o.items || [])) { const c1 = String(it.barcode || '').toUpperCase(); if (c1 && !d.seenOut[c1]) { d.seenOut[c1] = { at: Number(o.createdAt) || Date.now(), no: String(o.orderNo || '') }; _add++; } } }
    d.seenOutFixV68 = 1; added = true;
    console.log('[migrate] v68 历史出库索引自愈：清除零件号误键 ' + _clr + ' 个，按出库单补登标签 ' + _add + ' 个');
  }
  if (added) { saveDb(d); console.log('[init] 已补齐领料单/通知/货位账本集合'); }
  try { walkSec(d, (o, k) => { o[k] = decSec(o[k]); }); } catch (_) {} // ㉕F6 载入解密（明文旧数据直通，下次save自动转密）
  updateSafeCopy(d); // ㉖v56 启动加载成功后刷新不脱敏安全副本（兜底回滚源）
  return d;
}
// ㉖G3 SQLite迁移触发线监控：落盘写耗时滚动统计（近50次 max/avg）
const _saveStat = { ring: [], max: 0, avg: 0, n: 0 };
function saveDb(db) { // ㉖v85 原子写：唯一临时名 + rename（固定 .tmp 在并发写者下 rename 互相偷文件 → ENOENT，10/22 30次事故复盘）
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const _sv = []; // ㉕F6 落盘加密：同步暂换→序列化→还原（单线程无并发观察，免整库深拷贝）
  try { walkSec(db, (o, k) => { const e = encSec(o[k]); if (e !== o[k]) { _sv.push([o, k, o[k]]); o[k] = e; } }); } catch (_) {}
  const _t0 = Date.now();
  let _data; try { _data = JSON.stringify(db); } finally { for (const it of _sv) it[0][it[1]] = it[2]; } // ㉖v56 紧凑序列化：省 40% 体积与近半耗时（读取端 parse 无感）
  atomicWrite(DB_FILE, _data); // 内含数据块 fsync + rename + 目录 fsync（v56 断电加固语义不变）
  updateSafeCopy(db); // ㉖v56 每次成功落盘后刷新不脱敏安全副本（db 此时已还原明文）
  try { const ms = Date.now() - _t0; _saveStat.ring.push(ms); if (_saveStat.ring.length > 50) _saveStat.ring.shift(); _saveStat.n++; _saveStat.max = Math.max.apply(null, _saveStat.ring); _saveStat.avg = Math.round(_saveStat.ring.reduce((a, b) => a + b, 0) / _saveStat.ring.length); } catch (_) {}
}
// ---- 数据自动备份：启动一次 + 每30分钟快照，保留最近72份（约36小时）；误删/损坏可从 data/backups 恢复 ----
function backupDb() {
  try {
    flushSave(); // ㉖v56 备份前把合并窗口脏数据落盘，防快照滞后
    if (!fs.existsSync(DB_FILE)) return;
    const dir = path.join(DATA_DIR, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const p = path.join(dir, `db-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`);
    // ㉔S4 备份脱敏：剥离口令散列/外部系统凭据/会话token（防泄漏面×72）；业务数据完整，恢复备份后需重填 RCS/WMAS 凭据并全员重登
    const _bk = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    (_bk.users || []).forEach((x) => { delete x.salt; delete x.passHash; });
    if (_bk.rcsConfig) delete _bk.rcsConfig.pwd;
    if (_bk.wmasConfig) delete _bk.wmasConfig.pwd;
    delete _bk.rcsToken; delete _bk.rcsTokenExp; delete _bk.sessions;
    atomicWrite(p, JSON.stringify(_bk)); // ㉖v85 唯一临时名
    const all = fs.readdirSync(dir).filter((f) => /^db-.*\.json$/.test(f)).sort();
    while (all.length > 144) { const old = all.shift(); try { fs.unlinkSync(path.join(dir, old)); } catch (_) {} } // ㉖v56 保留144份=10分钟间隔×24小时（断电事故后加密备份）
  } catch (e) { console.log('[backup] 失败：', e.message); logErr('backupDb', e); }
}
setInterval(backupDb, 10 * 60 * 1000).unref(); // ㉖v56 备份间隔30→10分钟：最坏回滚窗口压到10分钟（2026-10-16 断电丢28分钟教训）
// ---- G3 数据归档：每日18:00把超期数据（默认180天）挪入 data/archive/YYYY-MM-*.json 再从主库移除；先写档成功才删，档案可回捞 ----
let _archLast = '';
function archiveOld() {
  try {
    const d = new Date();
    if (d.getHours() < 18) return;
    const day = d.toISOString().slice(0, 10);
    if (_archLast === day) return; _archLast = day;
    const days = P().archDays; const reqDays = P().reqArchDays; // ㉖v56 归档窗口参数化（db.archiveAfterDays 旧值由 PARAMS 默认兼容，不再直读）
    const cut = Date.now() - days * 86400000;
    const dir = path.join(DATA_DIR, 'archive'); fs.mkdirSync(dir, { recursive: true });
    const mon = day.slice(0, 7);
    let moved = 0;
    const move = (name, obj, tOf) => {
      const keep = {}, out = {};
      for (const k of Object.keys(obj || {})) { const t = tOf(obj[k]); if (Number.isFinite(t) && t > 0 && t < cut) out[k] = obj[k]; else keep[k] = obj[k]; }
      const n = Object.keys(out).length; if (!n) return;
      const f = path.join(dir, `${mon}-${name}.json`);
      let all = {}; try { if (fs.existsSync(f)) all = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) {}
      Object.assign(all, out);
      fs.writeFileSync(f + '.tmp', JSON.stringify(all)); fs.renameSync(f + '.tmp', f); // 先落盘成功
      obj === db.scanlog ? db.scanlog = keep : obj === db.outbound ? db.outbound = keep : db.issuedArchive = keep; // 再删主库
      moved += n;
    };
    // ㉖carEvents 超期滚动归档（数组型）
    try { const oldEv = (db.carEvents || []).filter((e) => (e.ts || 0) < cut); const keepEv = (db.carEvents || []).filter((e) => (e.ts || 0) >= cut); if (oldEv.length) { const f = path.join(dir, `${mon}-carEvents.json`); let all = []; try { if (fs.existsSync(f)) all = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) {} all = all.concat(oldEv); fs.writeFileSync(f + '.tmp', JSON.stringify(all)); fs.renameSync(f + '.tmp', f); db.carEvents = keepEv; moved += oldEv.length; } } catch (_) {}
    opsDigestTick(); // ㉖每日断链摘要+ops文件清理
    move('scanlog', db.scanlog, (v) => Number(v && v.t) || 0);
    move('outbound', db.outbound, (v) => Date.parse(v && v.at || v && v.time || '') || 0);
    // ㉖v56 领料单年度归档：仅已终结单（done/rejected/cancelled）且超 reqDays；在途/待处理永不归档；按单号幂等合并
    try {
      const rcut = Date.now() - reqDays * 864e5;
      const done = (db.requisitions || []).filter((r) => ['done', 'rejected', 'cancelled'].includes(r.status) && (Date.parse(r.createdAt) || 0) < rcut);
      if (done.length) {
        const rf = path.join(dir, mon + '-requisitions.json');
        let all = []; try { if (fs.existsSync(rf)) all = JSON.parse(fs.readFileSync(rf, 'utf8')); } catch (_) {}
        const seen = new Set(all.map((x) => x.no)); for (const r of done) if (!seen.has(r.no)) all.push(r);
        fs.writeFileSync(rf + '.tmp', JSON.stringify(all)); fs.renameSync(rf + '.tmp', rf); // 先落盘成功
        const mv = new Set(done.map((r) => r.no)); db.requisitions = db.requisitions.filter((r) => !mv.has(r.no));
        moved += done.length;
      }
    } catch (_) {}
    if ((db.notifications || []).length > 2000) { const old = db.notifications.filter((x) => Date.parse(x.time) < cut); if (old.length) { db.notifications = db.notifications.filter((x) => Date.parse(x.time) >= cut); moved += old.length; } }
    if (moved) { save(); console.log(`[archive] 归档 ${moved} 条超${days}天数据 → data/archive/${mon}-*（${day}）`); }
  } catch (e) { console.log('[archive] 失败：', e.message); logErr('archiveOld', e); }
}
setInterval(archiveOld, 30 * 60 * 1000).unref();
// ---- ㉒G7 物料字典：零件号→名称，由采集流水/出库单自动沉淀 ----
function feedDict(pn, nm, src) {
  try {
    pn = String(pn || '').toUpperCase().trim(); nm = String(nm || '').replace(/[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/\s+/g, ' ').trim(); // ㉖v61b 脏名不沉淀（字典是乱码回填的反查源）
    if (!pn || !nm || pn.length > 40 || nm.length > 80) return;
    db.itemDict = db.itemDict || {};
    const old = db.itemDict[pn];
    if (old && old.nm === nm) return;
    db.itemDict[pn] = { nm, src: src || '', at: Date.now() };
    const keys = Object.keys(db.itemDict);
    if (keys.length > 5000) { keys.sort((a, b) => (db.itemDict[a].at || 0) - (db.itemDict[b].at || 0)).slice(0, keys.length - 5000).forEach((k) => delete db.itemDict[k]); }
  } catch (_) {}
}

// ---- ㉓导出中心：快照登记（谁/何时/数据集/条件/行数/SHA1），CSV带血缘注释头、XLS带口径sheet（SpreadsheetML零依赖） ----
const EXP_LABELS = { D1: '库位表', D2: '库存汇总', D3: '入库流水', D4: '出库流水', D5: 'AGV任务', D6: 'AGV异常事件', D7: '工作量报表', D8: '领料台账', D9: '活动流审计', D10: '盘点结果', PACK: '月度对账包' };
const EXP_CAL = {
  '盘点结果': [['差异类型', '盘亏=实少于账面；盘盈=实多于账面；账外=扫入基准外标签'], ['口径', '零件级按数量合计、货位级按货位×零件组合；双基准矛盾行标记warn'], ['范围', '按盘点上收时间筛选；数据来自PDA结束盘点时自动上收']],
  '库位表': [['货位', '完整库位编码：NB02-区-架-层F / NB03-区-排-格'], ['标签号', '一框可贴多码；同托号多码=同一框'], ['登记时间', '采集设备时钟（展示用）；多机冲突仲裁=内容指纹+服务器到达时刻：真改动才生效，未变重推/旧副本不覆盖他人，删除按墓碑拦截'], ['来源', '采集入账/手工登记/网页修正/返架/移库']],
  '领料台账': [['处理分钟', '接单到签收/拒单/取消的分钟数（服务器时钟）'], ['范围', '按下单时间筛选；全量台账按月导出对账']],
  '活动流审计': [['动作', '登录/账本合并/合并diff/改位/返架/配置/模式/导出/账号/告警认领等关键写操作'], ['范围', '按天JSONL持久留痕近180天（data/ops/，每日摘要哈希断链防篡改）；密码等凭据不入审计流'], ['详情', '账本合并含字段级前值→后值diff（l=货位 p=零件 q=数量 b=批次 f=料框 mv=搬运方式，∅=原无值）；单次合并最多样例40条+总数'], ['断链', 'digest-日期.json 记录 前日链值→当日全行sha256；改任一行历史即校验不通过']],
  '库存汇总': [['在架框数', '按"框=托"去重：同托号多标签计1框；无托号按同货位+同零件号合并'], ['在架数量', '每框取框内标签数量最大值后按框求和（与PDA库存页同口径）'], ['占用货位数', '该零件涉及的货位格数（去重）'], ['货位分布(TOP5)', '按该零件占用格数排序前5货位（NB区简写×框数）'], ['最近入库/最近出库', '采集流水/出库单最大时刻（主库窗口内）'], ['零库存', '勾选后并入曾有出入流水/字典记录但当前在架 0 框的零件（框数/数量/货位均为 0，动向列为历史时刻）']],
  '入库流水': [['初始货位', 'AGV模式=起始站台；地面模式=地面格位'], ['状态', '已作废记录保留导出并标记，供审计回溯'], ['备注', '采集时填写的自定义备注（120字内）']],
  '出库流水': [['转入去向', 'MES转单目标（线边仓/工位）'], ['关联领料单', '领料发料转单生成的出库单带LL号；直调为空'], ['搬运方式', 'AGV=叫车叉至站台；人工=自提']],
  'AGV任务': [['方向', '出库=货架→站台；入库=站台→货架'], ['接令/叉出/到站', 'RCS任务节点完成时刻；空=未发生'], ['时长秒', '接令到完成执行秒数；在途未完成=至今已耗时'], ['状态', '完成（RCS沉淀）/排队/下发中/已下发/到站/失败（在途队列并入）'], ['关联单', '按RCS任务号配对领料单号；配不到=空'], ['范围', 'RCS任务沉淀近30天+当前在途队列（WMAS对执行结果无感知，本表为权威）']],
  'AGV异常事件': [['类型', '告警/恢复/已认领/升级/红牌/堵点/低电/出库超时/改位冲突'], ['范围', '车辆告警近500条+堵点/低电/超时/冲突实时聚合'], ['时间', '事件发生时刻（服务器时钟）'], ['持续时长(分)', '告警→同车下一条恢复的分钟数；未恢复=至今'], ['是否恢复', '已恢复/未恢复/仍在告警；低电=未回充/已回充']],
  '工作量报表': [['入库框', '采集流水按托号去重（同托多码计1框），框数记入首次入库日'], ['出库框/件', '出库单标签去重与件数合计，按出库单创建日'], ['接单', '领料单历史"接单"事件；平均接单=下单到接单分钟'], ['修正/返架', '改位+补登记+消位计修正，返架单列（人工动作，不含系统自动）'], ['范围', '默认近14天；日期归属用服务器时钟本地日']],
  '月度对账包': [['包含', '库位表+库存汇总+入库流水+出库流水 四工作表+口径说明'], ['用途', '与SAP/供应商对账的标准包；文件内口径说明即对账依据']],
};
function expTs(ms) { return ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : ''; }
function expX(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function expCsvCell(v) { v = v == null ? '' : String(v); return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
function expCsv(d, meta) { const L = meta.map((m) => '#' + m); L.push(d.headers.map(expCsvCell).join(',')); for (const r of d.rows) L.push(r.map(expCsvCell).join(',')); return '\uFEFF' + L.join('\r\n') + '\r\n'; }
function expXls(d) {
  const parts = d.parts || [d];
  let x = '<?xml version="1.0" encoding="UTF-8"?>\n<?mso-application progid="Excel.Sheet"?>\n<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">\n';
  for (const p of parts) {
    x += `<Worksheet ss:Name="${expX(p.label).slice(0, 28)}"><Table><Row>` + p.headers.map((h) => `<Cell><Data ss:Type="String">${expX(h)}</Data></Cell>`).join('') + '</Row>\n';
    for (const r of p.rows) x += '<Row>' + r.map((c, i) => { const t = p.types && p.types[i] === 'N' && c !== '' && c != null && Number.isFinite(Number(c)); return `<Cell><Data ss:Type="${t ? 'Number' : 'String'}">${expX(t ? Number(c) : (c == null ? '' : c))}</Data></Cell>`; }).join('') + '</Row>\n';
    x += '</Table></Worksheet>\n';
  }
  const cal = [['口径版本', 'v1'], ['数据集', d.label], ['数据源', parts.map((p) => p.src).join('；')], ['筛选条件', JSON.stringify(d.f || {})], ['导出行数', String(d.total != null ? d.total : (d.rows || []).length)], ['生成时间', new Date().toLocaleString('zh-CN', { hour12: false })]].concat(parts.flatMap((p) => (p.caliber || []).map((c) => [p.label + '·' + c[0], c[1]])));
  x += '<Worksheet ss:Name="口径说明"><Table><Row><Cell><Data ss:Type="String">项目</Data></Cell><Cell><Data ss:Type="String">说明</Data></Cell></Row>\n';
  for (const c of cal) x += `<Row><Cell><Data ss:Type="String">${expX(c[0])}</Data></Cell><Cell><Data ss:Type="String">${expX(c[1])}</Data></Cell></Row>\n`;
  return x + '</Table></Worksheet></Workbook>';
}
// ---- ㉓G12 工作量报表聚合：入库(框=托去重)/出库/修正/返架按人按日 + 领料时效 + AGV按车 ----
function wdstr(ms) { const d = new Date(ms); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function wdName(s) { return String(s || '').trim().replace(/[（(][^）)]*[）)]$/, '').trim() || '未知'; } // MES回写常带(账号)后缀，统计归一
// ===== ㉖v63 断料预测与循环盘点辅助（顶层：路由与 frequent 共用） =====
function stockRiskOf(days) {
  const N = Math.min(180, Math.max(7, Number(days) || 60));
  const cut = Date.now() - N * 864e5;
  const outAgg = {};
  for (const o of Object.values(db.outbound || {})) {
    const t = Number(o.createdAt) || 0; if (t < cut) continue;
    for (const it of o.items || []) { const pn = String(it.code || '').toUpperCase(); if (!pn) continue; const a = outAgg[pn] = outAgg[pn] || { qty: 0, last: 0 }; a.qty += Number(it.qty) || 0; if (t > a.last) a.last = t; }
  }
  const stock = {};
  for (const l of db.ledger || []) { const pn = String(l.p || '').toUpperCase(); if (!pn) continue; stock[pn] = (stock[pn] || 0) + (Number(l.q) || 0); }
  const list = [];
  for (const [pn, a] of Object.entries(outAgg)) {
    if (a.qty <= 0) continue;
    const daily = a.qty / N;
    const st = stock[pn] || 0;
    const dl = daily > 0 ? Math.floor(st / daily) : 999;
    list.push({ pn, nm: (db.itemDict && db.itemDict[pn] && db.itemDict[pn].nm) || '', stockQty: st, daily: Math.round(daily * 10) / 10, daysLeft: Math.min(dl, 999), lvl: dl < 3 ? 'red' : dl <= 7 ? 'yellow' : 'green', lastOut: a.last });
  }
  list.sort((x, y) => x.daysLeft - y.daysLeft || y.daily - x.daily);
  return { days: N, red: list.filter((x) => x.lvl === 'red').length, yellow: list.filter((x) => x.lvl === 'yellow').length, list };
}
function cyclePlanOf(n) { // 当日计划按日期种子洗牌固定（同一天反复拉不变），只抽 NB02 高架格
  const day = new Date().toISOString().slice(0, 10);
  db.cyclePlans = db.cyclePlans || {};
  if (db.cyclePlans[day]) return { day, locs: db.cyclePlans[day] };
  const locs = [...new Set((db.ledger || []).map((l) => String(l.l || '').toUpperCase()).filter((x) => /^NB02-/.test(x)))];
  let seed = 2166136261; for (const ch of day) { seed ^= ch.charCodeAt(0); seed = Math.imul(seed, 16777619) >>> 0; }
  const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
  for (let i = locs.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const tmp = locs[i]; locs[i] = locs[j]; locs[j] = tmp; }
  const pick = locs.slice(0, Math.min(Math.max(1, Number(n) || 20), locs.length));
  db.cyclePlans[day] = pick;
  const ks = Object.keys(db.cyclePlans).sort(); while (ks.length > 7) { delete db.cyclePlans[ks[0]]; ks.shift(); }
  save();
  return { day, locs: pick };
}
function buildWork(from, to) {
  const persons = {}, days = {};
  const P = (name, day) => { name = wdName(name); const p = (persons[name] = persons[name] || { name, inB: 0, outB: 0, outQ: 0, fix: 0, ret: 0, acc: 0, finMin: 0, finN: 0, days: {} }); const d = (p.days[day] = p.days[day] || { inB: 0, outB: 0, acc: 0 }); return p; };
  const D = (day) => (days[day] = days[day] || { inB: 0, outB: 0, outQ: 0, fix: 0, ret: 0, acc: 0, done: 0, rej: 0, agv: 0 });
  // 入库：采集流水按托/框去重，记入首次入库日（作废的不计，操作人记s.op）
  const boxSeen = {};
  for (const s of Object.values(db.scanlog || {})) {
    if (s.cx) continue; const t = s.t || 0; if (t < from || t > to) continue;
    const k = String(s.pid || '').toUpperCase() || String(s.code || '').toUpperCase();
    if (boxSeen[k]) continue; boxSeen[k] = 1;
    const day = wdstr(t), who = String(s.op || '').trim() || '未知';
    P(who, day).inB++; P(who, day).days[day].inB++; D(day).inB++;
  }
  // 出库：㉖v61 按托归并计框（与入库口径统一：框=托）——barcode 反查账本 boxKeyOf（托号优先/同位同件合并/缺则按标签），件数合计；操作人记o.operator
  const _ledMap = {}; for (const x of db.ledger || []) { const c0 = String(x.c || '').toUpperCase(); if (c0 && !_ledMap[c0]) _ledMap[c0] = x; }
  for (const o of Object.values(db.outbound || {})) {
    const t = Number(o.createdAt) || 0; if (t < from || t > to) continue;
    const day = wdstr(t), who = String(o.operator || '').trim() || '未知';
    const boxes = new Set(); let qty = 0;
    for (const i of (o.items || [])) { const c = String(i.barcode || '').toUpperCase(); if (!c) continue; qty += Number(i.qty) || 0; const lx = _ledMap[c]; boxes.add(lx ? boxKeyOf(lx) : 'C|' + c); }
    if (!boxes.size) continue;
    const nb = boxes.size;
    const p = P(who, day); p.outB += nb; p.outQ += qty; p.days[day].outB += nb; D(day).outB += nb; D(day).outQ += qty;
  }
  // 修正/返架：审计流水（改位+补登记+消位=修正，返架单列）
  for (const f of db.ledgerFixes || []) {
    const t = Date.parse(f.time) || 0; if (t < from || t > to) continue;
    const day = wdstr(t), who = String(f.by || '').trim() || '未知';
    const p = P(who, day); if (f.act === '返架') { p.ret++; D(day).ret++; } else { p.fix++; D(day).fix++; }
  }
  // 领料：接单量/处理时效（下单→接单、接单→签收）按单据最终归属日；拒单计日不计人
  const mins = (a, b) => (a && b ? Math.max(0, (b - a) / 60000) : 0);
  for (const r of db.requisitions || []) {
    const accEv = (r.history || []).find((h) => /^接单/.test(h.text)); const finEv = (r.history || []).find((h) => /^签收/.test(h.text));
    const cAt = Date.parse(r.createdAt) || 0, aAt = accEv ? Date.parse(accEv.time) : 0, fAt = finEv ? Date.parse(finEv.time) : (r.status === 'done' ? 0 : 0);
    if (accEv && aAt >= from && aAt <= to) { const day = wdstr(aAt), who = String(accEv.by || '').trim() || '未知'; const p = P(who, day); p.acc++; p.days[day].acc++; p.finMin += mins(cAt, aAt); p.finN++; D(day).acc++; }
    if (r.status === 'done' && fAt >= from && fAt <= to) D(wdstr(fAt)).done++;
    if (r.status === 'rejected') { const rv = (r.history || []).find((h) => /^拒单/.test(h.text)); const t = rv ? Date.parse(rv.time) : 0; if (t >= from && t <= to) D(wdstr(t)).rej++; }
  }
  // AGV：按车统计完成任务（方向+时长），车辆不算"人"单列
  const cars = {};
  for (const [no, t] of Object.entries(db.agvTasks || {})) {
    if ((t.fin || 0) < from || (t.fin || 0) > to) continue;
    const key = t.car ? ('AGV' + String(t.car).padStart(2, '0')) : '车号缺失'; const c = (cars[key] = cars[key] || { out: 0, in: 0, other: 0, dur: 0, n: 0 }); // ㉖v61 RCS未回车号不再伪装成AGV00
    c[t.ck === 'out' ? 'out' : t.ck === 'in' ? 'in' : 'other']++; c.n++; c.dur += t.dur || 0;
    D(wdstr(t.fin)).agv++;
  }
  return { persons, days, cars };
}
function buildExport(ds, fRaw) {
  const f = { from: String((fRaw && fRaw.from) || '').slice(0, 10), to: String((fRaw && fRaw.to) || '').slice(0, 10) };
  if (fRaw && fRaw.arch) f.arch = '1'; if (fRaw && fRaw.zero) f.zero = '1'; // 快照条件登记补全：含归档/零库存开关可追溯
  const _arch = !!(fRaw && (fRaw.arch === '1' || fRaw.arch === true)); // ㉕F9 含归档：主库∪data/archive
  const from = f.from ? Date.parse(f.from + 'T00:00:00') : 0;
  const to = f.to ? Date.parse(f.to + 'T23:59:59') : Infinity;
  const CAP = 20000;
  const mk = (label, headers, types, rows, src) => ({ label, headers, types, rows: rows.slice(0, CAP), total: rows.length, src, f, caliber: EXP_CAL[label] || [] });
  if (ds === 'D1') return mk('库位表', ['货位', '标签号', '零件号', '物料名称', '数量', '批次', '料框', '登记人', '登记时间', '搬运方式', '来源'], ['S', 'S', 'S', 'S', 'N', 'S', 'S', 'S', 'S', 'S', 'S'], ledgerView().map((x) => [x.l, x.c, x.p || '', x.n || '', x.q || 0, x.b || '', x.f || '', x.by || '', expTs(x.t), x.mv || '', x.src || '']).sort((a, b) => String(a[0]).localeCompare(String(b[0]))), '货位账本（服务器合并快照；批次=MES标签打印日期）');
  if (ds === 'D2') { const m = {}; for (const x of db.ledger) { const pn = String(x.p || '').toUpperCase() || '(无零件号)'; const k = boxKeyOf(x); const e = (m[pn] = m[pn] || { b: {}, locs: {}, nm: '' }); e.b[k] = (e.b[k] || 0) + (Number(x.q) || 0); e.locs[String(x.l).toUpperCase()] = (e.locs[String(x.l).toUpperCase()] || 0) + 1; if (!e.nm && x.n) e.nm = x.n; } // ㉖ 框数量=框内各标签之和
    // ㉕B12 最近出入动向：入库=采集流水最大t；出库=出库单明细最大createdAt
    const lastIn = {}, lastOut = {};
    for (const s of Object.values(db.scanlog || {})) { if (s.cx) continue; const pn = String(s.pn || '').toUpperCase(); if (!pn) continue; lastIn[pn] = Math.max(lastIn[pn] || 0, s.t || 0); }
    for (const o of Object.values(db.outbound || {})) { const t = Number(o.createdAt) || 0; for (const i of (o.items || [])) { const pn = String(i.code || '').toUpperCase(); if (pn) lastOut[pn] = Math.max(lastOut[pn] || 0, t); } }
    const mkRow = (pn, e) => { const bs = Object.values(e.b); const locs = Object.entries(e.locs).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([l, n]) => l.split('-').slice(1).join('-') + '×' + n).join('、') + (Object.keys(e.locs).length > 5 ? '…' : ''); return [pn, (db.itemDict && db.itemDict[pn] && db.itemDict[pn].nm) || e.nm, bs.length, bs.reduce((s2, v) => s2 + v, 0), Object.keys(e.locs).length, locs, expTs(lastIn[pn] || 0), expTs(lastOut[pn] || 0)]; };
    let rows = Object.entries(m).map(([pn, e]) => mkRow(pn, e));
    if (fRaw && (fRaw.zero === '1' || fRaw.zero === true)) { for (const pn of new Set([...Object.keys(lastIn), ...Object.keys(lastOut), ...Object.keys(db.itemDict || {})])) if (!m[pn]) rows.push([pn, (db.itemDict && db.itemDict[pn] && db.itemDict[pn].nm) || '', 0, 0, 0, '', expTs(lastIn[pn] || 0), expTs(lastOut[pn] || 0)]); } // 零库存：有过流水但当前无在架
    rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    return mk('库存汇总', ['零件号', '物料名称', '在架框数', '在架数量', '占用货位数', '货位分布(TOP5)', '最近入库', '最近出库'], ['S', 'S', 'N', 'N', 'N', 'S', 'S', 'S'], rows, '货位账本按框聚合（动向取自主库窗口，含归档勾选不影响本表）'); }
  if (ds === 'D3') { const _sl = _arch ? Object.assign(archLoad('scanlog'), db.scanlog || {}) : (db.scanlog || {}); const rows = Object.values(_sl).filter((s) => (s.t || 0) >= (from || 0) && (s.t || 0) <= to).sort((a, b) => (b.t || 0) - (a.t || 0)).map((s) => [expTs(s.t), s.code, s.pn || '', s.nm || '', s.q || 0, printLot(s.mk, s.lot), (s.wt === 0 ? s.st : s.gl) || '', s.ct || '', s.pid || '', s.op || '', s.cx ? '已作废' : '', s.rm || '']); return mk('入库流水', ['时间', '标签号', '零件号', '物料名', '数量', '批次', '初始货位', '容器类型', '托号', '操作人', '状态', '备注'], ['S', 'S', 'S', 'S', 'N', 'S', 'S', 'S', 'S', 'S', 'S', 'S'], rows, '采集流水（全厂合并；批次=MES标签打印日期）'); }
  if (ds === 'D4') { const _ob = _arch ? Object.assign(archLoad('outbound'), db.outbound || {}) : (db.outbound || {}); const rows = []; for (const o of Object.values(_ob)) { const t = Number(o.createdAt) || 0; if ((from && t < from) || t > to) continue; for (const i of (o.items || [])) rows.push([o.orderNo, expTs(t), i.code || '', i.name || '', i.qty || 0, i.barcode || '', i.fromLoc || '', o.toLoc || '', i.move || '', o.linkReqNo || '', o.operator || '']); } rows.sort((a, b) => String(b[0]).localeCompare(String(a[0]))); return mk('出库流水', ['出库单号', '时间', '零件号', '物料名', '数量', '标签号', '原货位', '转入去向', '搬运方式', '关联领料单', '操作人'], ['S', 'S', 'S', 'S', 'N', 'S', 'S', 'S', 'S', 'S', 'S'], rows, '出库单（全厂合并，领料转单+直调）'); }
  if (ds === 'D5') { const reqOfTask = {}; for (const q of db.agvQueue || []) { const tn = String(q.taskNo || ''); if (tn && q.reqNo && !reqOfTask[tn]) reqOfTask[tn] = q.reqNo; } // 关联单=按RCS任务号配对（完成项队列留存可回溯）
    const rows = Object.entries(db.agvTasks || {}).filter(([, t]) => (t.fin || 0) >= (from || 0) && (t.fin || 0) <= to).sort((a, b) => (b[1].fin || 0) - (a[1].fin || 0)).map(([no, t]) => [no, t.ck === 'out' ? '出库' : t.ck === 'in' ? '入库' : '其他', t.sp || '', t.ep || '', t.car ? ('AGV' + String(t.car).padStart(2, '0')) : '车号缺失', expTs(t.ex), expTs(t.pick), expTs(t.fin), t.dur || 0, '完成', reqOfTask[no] || '']);
    // ㉕B10 未完成在途并入同表（状态=排队/下发中/已下发/到站/失败），补"状态/关联单"两列
    for (const q of db.agvQueue || []) { if (['完成', '取消'].includes(q.state)) continue; const at = Number(q.at) || 0; if ((from && at < from) || at > to) continue; rows.push([q.wmsTask || q.taskNo || '未生成', q.type === 'transfer' ? '移库' : q.type === 'inbound' ? '入库' : q.type === 'insp' ? '检验下架' : q.type === 'inspback' ? '检验归位' : '出库', q.fromLoc || q.from || '', q.station || q.to || '', '', '', expTs(q.sentAt || 0) || '', expTs(q.dockAt || 0) || '', Math.round((Date.now() - at) / 1000), q.state, q.reqNo || '']); } // ㉖ 检验任务入队后方向列完整映射
    return mk('AGV任务', ['任务号', '方向', '起点', '终点', '车辆', '接令', '叉出', '到站', '时长秒', '状态', '关联单'], ['S', 'S', 'S', 'S', 'S', 'S', 'S', 'S', 'N', 'S', 'S'], rows, 'RCS任务沉淀（近30天六节点）+未完成在途队列（时长秒=已耗时）'); }
  if (ds === 'D6') { // ㉕B11 补持续时长/是否恢复：同车事件流内配对（告警→该车其后首条恢复；无配对=至今未恢复）
    const evs = buildEvents(); const pend = {};
    for (let i = evs.length - 1; i >= 0; i--) { const e = evs[i]; const w = String(e.who || ''); if (e.kind === '告警' || e.kind === '红牌' || e.kind === '升级') { pend[w] = e; } else if (e.kind === '恢复' && pend[w] && e.ts >= pend[w].ts) { pend[w]._rt = e.ts; pend[w] = null; } }
    const rows = evs.map((e) => {
      let dur = '', recd = '';
      if (e.kind === '告警' || e.kind === '红牌' || e.kind === '升级') { if (e._rt) { dur = Math.max(1, Math.round((e._rt - e.ts) / 60000)); recd = '已恢复'; } else { dur = Math.max(1, Math.round((Date.now() - e.ts) / 60000)); recd = '未恢复'; } }
      else if (e.kind === '恢复') recd = '已恢复';
      else if (e.kind === '低电') recd = (db.rcsLowBat || {})[String(e.who).replace(/\D/g, '')] ? '未回充' : '已回充';
      else if (/超时$/.test(e.kind) || e.kind === '堵点') { dur = Math.max(1, Math.round((Date.now() - e.ts) / 60000)); recd = e.resolved === 1 ? '已了结·' + (e.resMsg || '') : (e.resMsg || '未了结'); }
      return [expTs(e.ts), e.kind, e.who || '', dur, recd, e.msg || ''];
    });
    return mk('AGV异常事件', ['时间', '类型', '对象', '持续时长(分)', '是否恢复', '内容'], ['S', 'S', 'S', 'S', 'S', 'S'], rows, '车辆告警+堵点+低电+出库超时+改位冲突统一聚合；持续时长=告警到恢复分钟（未恢复=至今）'); }
  if (ds === 'D7') {
    const F = from || Date.now() - 14 * 864e5, T = Number.isFinite(to) ? to : Date.now();
    const w = buildWork(F, T);
    const ps = Object.values(w.persons).sort((a, b) => (b.inB + b.outB + b.outQ / 20 + b.acc + b.fix + b.ret) - (a.inB + a.outB + a.outQ / 20 + a.acc + a.fix + a.ret));
    const parts = [
      { label: '按人汇总', headers: ['姓名', '入库框', '出库框', '出库件', '接单', '修正', '返架', '平均接单(分)'], types: ['S', 'N', 'N', 'N', 'N', 'N', 'N', 'N'], rows: ps.map((p) => [p.name, p.inB, p.outB, p.outQ, p.acc, p.fix, p.ret, p.finN ? Math.round(p.finMin / p.finN) : '']), src: '采集流水+出库单+修正审计+领料历史', caliber: EXP_CAL['工作量报表'] },
      { label: '按日汇总', headers: ['日期', '入库框', '出库框', '出库件', '接单', '签收', '拒单', '修正', '返架', 'AGV任务'], types: ['S', 'N', 'N', 'N', 'N', 'N', 'N', 'N', 'N', 'N'], rows: Object.keys(w.days).sort().map((k) => { const d = w.days[k]; return [k, d.inB, d.outB, d.outQ, d.acc, d.done, d.rej, d.fix, d.ret, d.agv]; }), src: '同上（按服务器本地日归属）', caliber: [] },
      { label: 'AGV按车', headers: ['车辆', '出库任务', '入库任务', '其他', '总任务', '平均时长秒'], types: ['S', 'N', 'N', 'N', 'N', 'N'], rows: Object.keys(w.cars).sort().map((k) => { const c = w.cars[k]; return [k, c.out, c.in, c.other, c.n, c.n ? Math.round(c.dur / c.n) : 0]; }), src: 'RCS任务沉淀（近30天）', caliber: [] },
    ];
    return { label: '工作量报表', parts, rows: parts[0].rows, total: parts[0].rows.length + parts[1].rows.length + parts[2].rows.length, f: { from: wdstr(F), to: wdstr(T) } };
  }
  if (ds === 'D8') { const ST = { pending: '待接单', accepted: '备料中', ready: '待签收', done: '已签收', rejected: '已拒单', cancelled: '已取消' }; const _rq = _arch ? db.requisitions.concat((() => { const out = []; try { for (const fd of fs.readdirSync(path.join(DATA_DIR, 'archive'))) { if (fd.indexOf('-requisitions.json') < 0) continue; try { out.push.apply(out, JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'archive', fd), 'utf8'))); } catch (_) {} } } catch (_) {} return out; })()) : (db.requisitions || []); const rows = _rq.filter((r) => { const t = Date.parse(r.createdAt) || 0; return t >= (from || 0) && t <= to; }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map((r) => { const acc = (r.history || []).find((h) => /接单/.test(h.text || '')); const fin = (r.history || []).filter((h) => /签收|拒单|取消/.test(h.text || '')).pop(); const mins = acc && fin ? Math.round((Date.parse(fin.time) - Date.parse(acc.time)) / 60000) : ''; return [r.no, expTs(Date.parse(r.createdAt) || 0), r.byName || r.by || '', (r.items || []).length, (r.items || []).reduce((s, i) => s + (Number(i.qty) || 0), 0), ST[r.status] || r.status, r.acceptedBy || '', r.confirmedBy || '', expTs(Date.parse(r.confirmedAt) || 0), acc ? expTs(Date.parse(acc.time) || 0) : '', mins === '' ? '' : mins, (r.remark || '').slice(0, 60)]; }); return mk('领料台账', ['单号', '下单时间', '下单人', '行数', '件数合计', '状态', '接单人', '签收人', '签收时间', '接单时间', '处理分钟', '备注'], ['S', 'S', 'S', 'N', 'N', 'S', 'S', 'S', 'S', 'S', 'N', 'S'], rows, '领料单（含节点时刻，处理分钟=接单到终结）' + (_arch ? '；含归档=主库∪archive已终结超期归档单' : '；主库窗口，超期已终结单勾「含归档」回查')); }
  if (ds === 'D9') { const _dv = (s0) => String(s0 == null ? '' : s0).replace(/[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ''); const rows = opsLoadDays(OPS_KEEP_DAYS).filter((o) => (o.t || 0) >= (from || 0) && (o.t || 0) <= to).sort((a, b) => (b.t || 0) - (a.t || 0)).map((o) => [expTs(o.t), o.by || '', o.role || '', o.act || '', _dv(o.obj), _dv(o.det)]); return mk('活动流审计', ['时间', '操作人', '角色', '动作', '对象', '详情'], ['S', 'S', 'S', 'S', 'S', 'S'], rows, '关键写操作留痕（滚动5000条，凭据不入流）'); }
  if (ds === 'D10') { const inv = Object.values(db.inventories || {}).filter((r) => { const t = r.at || 0; return t >= (from || 0) && t <= to; }).sort((a, b) => b.at - a.at); const bid = String((fRaw && fRaw.batchId) || '').trim(); const sel = bid ? inv.filter((r) => r.batchId === bid) : inv; const one = sel[0] || {};
    const parts = [
      { label: '盘点总览', headers: ['批次', '备注', '模式', '盘点人', '结束时间', '总扫次', '有效扫次', 'MES失败', '重复', '账外', '已应用改账', '零件行数', '零件差异行'], types: ['S', 'S', 'S', 'S', 'S', 'N', 'N', 'N', 'N', 'N', 'S', 'N', 'N'], rows: sel.map((r) => [r.batchId, r.remark || '', r.blind ? '盲盘' : '监督', r.by || '', expTs(r.at), r.totalScans || 0, r.validScans || 0, r.mesFail || 0, r.dup || 0, r.outside || 0, r.applied ? ('是·' + expTs(r.applyTime)) : '否', (r.parts || []).length, (r.parts || []).filter((p) => Math.abs(p.real - p.book) > 1e-6).length]), src: 'PDA盘点上收汇总', caliber: EXP_CAL['盘点结果'] },
      { label: '零件级差异', headers: ['批次', '零件号', '物料名称', '账面数量', '实盘数量', '差异', '实盘框数', '账外框', '双基准矛盾'], types: ['S', 'S', 'S', 'N', 'N', 'N', 'N', 'N', 'S'], rows: sel.flatMap((r) => (r.parts || []).filter((p) => Math.abs(p.real - p.book) > 1e-6 || p.out > 0 || p.warn === 7).map((p) => [r.batchId, p.pn, p.nm || '', p.book, p.real, Math.round((p.real - p.book) * 100) / 100, p.boxes, p.out, p.warn === 7 ? '⚠矛盾' : ''])), src: '零件级差异（含账外/矛盾）', caliber: [] },
      { label: '货位级差异', headers: ['批次', '货位', '零件号', '台账数量', '实盘数量', '差异', '实盘框数'], types: ['S', 'S', 'S', 'N', 'N', 'N', 'N'], rows: sel.flatMap((r) => (r.locs || []).filter((l) => Math.abs(l.real - l.book) > 1e-6).map((l) => [r.batchId, l.loc, l.pn, l.book, l.real, Math.round((l.real - l.book) * 100) / 100, l.boxes])), src: '货位×零件级差异', caliber: [] },
    ];
    return { label: '盘点结果' + (bid ? '_' + bid : ''), parts, rows: parts[1].rows, total: parts.reduce((s, p) => s + p.rows.length, 0), f: { from: f.from, to: f.to, batchId: bid || '全部' } };
  }
  if (ds === 'PACK') { const parts = ['D1', 'D2', 'D3', 'D4'].map((x) => buildExport(x, fRaw));
    // ㉕丙7 差异说明页：近7日净流入（主库口径，历史月需「含归档」单导）
    const d7 = Date.now() - 7 * 864e5; const mv = {};
    for (const s of Object.values(db.scanlog || {})) { if ((s.t || 0) < d7) continue; const pn = String(s.pn || '').toUpperCase() || '(无零件号)'; (mv[pn] = mv[pn] || { i: 0, o: 0 }).i += Number(s.q) || 0; }
    for (const o of Object.values(db.outbound || {})) { if ((Number(o.createdAt) || 0) < d7) continue; for (const i of (o.items || [])) { const pn = String(i.code || '').toUpperCase() || '(无零件号)'; (mv[pn] = mv[pn] || { i: 0, o: 0 }).o += Number(i.qty) || 0; } }
    const diffRows = Object.entries(mv).filter(([, v]) => v.i !== v.o).sort((a, b) => Math.abs(b[1].i - b[1].o) - Math.abs(a[1].i - a[1].o)).slice(0, 300).map(([pn, v]) => [pn, v.i, v.o, v.i - v.o]);
    parts.push({ label: '差异说明', headers: ['零件号', '近7日入库(件)', '近7日出库(件)', '净流入'], types: ['S', 'N', 'N', 'N'], rows: diffRows, src: '主库近7日流水/出库（更早数据在data/archive）', caliber: [['用途', '对账前先看哪些零件近7日仍在大幅进出；净流入=入-出，为负即净消耗'], ['局限', '主库窗口外历史在归档目录；全月口径用导出中心「含归档」单导D3/D4'], ['注意', '本页不是账实差异——账实差异以盘点结果(D10)为准']] });
    const total = parts.reduce((s, p) => s + p.rows.length, 0); return { label: '月度对账包', parts, rows: [], total, f: parts[0].f }; }
  return null;
}

// ---- ㉔SSE实时推送：订阅者注册/广播/断线清理 ----
const sseSet = new Set();
function sseSend(d) { for (const rs of sseSet) { try { rs.write('data: ' + JSON.stringify(d) + '\n\n'); } catch (_) {} } }
function sseClose(rs) { try { rs.end(); } catch (_) {} sseSet.delete(rs); }

// ---- ㉔回放轨迹采样（近24h滚动）+ 站台状态变化（甘特数据）+ 轮询后广播 ----
function sseTick(nowMs) {
  try {
    sseSend({ t: 'snap', at: db.rcsAt || new Date().toISOString(), run: (db.rcsRun || []).length, queue: (db.agvQueue || []).filter((q) => ['排队', '下发中', '已下发'].includes(q.state)).length, on: !!(db.rcsConfig && db.rcsConfig.host), sc: db.scanlogAt || '', wm: db.wmasOkAt || 0 }); // ㉕F10 健康灯字段
    const tk = (db.rcsToken && Date.now() < (db.rcsTokenExp || 0)) ? db.rcsToken : null;
    if (!tk) return;
    rcsReq('/uds/car/getCarInfoList', 'GET', tk).then((cr) => {
      try {
        const cars = cr && cr.data ? (typeof cr.data === 'string' ? JSON.parse(cr.data) : cr.data) : [];
        db.trail = db.trail || [];
        for (const c of cars) { if (c && c.agvId !== undefined && Number.isFinite(c.x) && Number.isFinite(c.y)) db.trail.push({ ts: nowMs, id: c.agvId, x: Math.round(c.x * 10) / 10, y: Math.round(c.y * 10) / 10, yaw: Math.round((Number(c.yaw) || 0) * 100) / 100 }); }
        const cut = nowMs - P().trailMin * 60 * 1000; // ㉖ 轨迹回放保留时长可调
        db.trail = db.trail.filter((p) => p.ts >= cut);
        if (db.trail.length > 20000) db.trail = db.trail.slice(-20000);
      } catch (_) {}
    }).catch(() => {});
    db.stnTl = db.stnTl || {};
    const st = db.rcsStations || {};
    for (const k of Object.keys(st)) { const want = st[k].state === '有货' ? '有货' : st[k].state === '占用中' ? '占用' : '空闲'; const a = db.stnTl[k] || (db.stnTl[k] = []); const last = a[a.length - 1]; if (!last || last.s !== want) a.push({ s: want, t: nowMs }); if (a.length > 300) db.stnTl[k] = a.slice(-300); }
    for (const k of Object.keys(db.stnTl)) { if (!st[k]) delete db.stnTl[k]; }
  } catch (_) {}
}

// ---- ㉔每日账本快照（18:10，留90天）："昨天的库存什么样"可回放 ----
function snapDay(d) { return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0'); }
function dailySnap() {
  try {
    const d = new Date();
    if (d.getHours() < 18) return;
    const key = snapDay(d);
    const dir = path.join(DATA_DIR, 'snapshots'); fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'ledger-' + key + '.json');
    if (fs.existsSync(f)) return;
    fs.writeFileSync(f + '.tmp', JSON.stringify({ at: d.toISOString(), epoch: db.ledgerEpoch || '', items: db.ledger })); fs.renameSync(f + '.tmp', f); // ㉖v89b 盖世代章：整表替换(迁移)后跨快照对比无意义，reconcile 按章拒比
    const all = fs.readdirSync(dir).filter((x) => /^ledger-\d{8}\.json$/.test(x)).sort();
    while (all.length > 90) { const old = all.shift(); try { fs.unlinkSync(path.join(dir, old)); } catch (_) {} }
    console.log('[snap] 每日账本快照 ' + key + '（' + db.ledger.length + ' 条）');
  } catch (e) { console.log('[snap] 失败：', e.message); logErr('dailySnap', e); }
}
setInterval(dailySnap, 30 * 60 * 1000).unref();
// ---- ㉖v94n 预约到期巡检：每日 9 点后一次——数量预约超期望日未达成→提醒预约人（可改日/取消），并给仓管知会；履行后自动消解 ----
let _bkDueLast = '';
function bookingDueSweep() {
  try {
    const d = new Date();
    if (d.getHours() < 9) return;
    const key = snapDay(d);
    if (_bkDueLast === key) return;
    _bkDueLast = key;
    let n = 0;
    for (const w of db.watchlist || []) {
      const wq = Number(w.qty) || 0;
      if (!wq || w.filledReq || !w.due) continue;
      if (Date.now() <= new Date(w.due + 'T23:59:59').getTime()) continue;
      const user = db.users.find((x) => x.id === w.userId);
      if (!user || !user.enabled) continue;
      const got = Math.max(0, Number(w.got) || 0); // ㉖v94n 与履行链同源：累计到料数
      notify(user.id, 'watch_in', `⏰ 预约逾期：零件 ${w.partNo} 超期望日 ${w.due.slice(5)} 仍未到齐（${got}/${wq} 框）。可调整期望日、等自动开单，或取消预约`, '');
      n++;
    }
    if (n) { save(); console.log('[booking-due] 逾期提醒 ' + n + ' 条'); }
  } catch (e) { console.log('[booking-due] 失败：', e.message); logErr('bookingDue', e); }
}
setInterval(bookingDueSweep, 30 * 60 * 1000).unref();
// ---- ㉔每日自动导出：18点后落 D1库位表+D2库存汇总 到 data/exports/daily（留90天，对账免手工）----
let _expLast = '';
function dailyExport() {
  try {
    const d = new Date();
    if (d.getHours() < 18) return;
    const key = snapDay(d);
    if (_expLast === key) return;
    const dir = path.join(DATA_DIR, 'exports', 'daily'); fs.mkdirSync(dir, { recursive: true });
    const f1 = path.join(dir, '库位表-' + key + '.xls'), f2 = path.join(dir, '库存汇总-' + key + '.xls');
    if (fs.existsSync(f1) && fs.existsSync(f2)) { _expLast = key; return; }
    if (!fs.existsSync(f1)) { const b = expXls(buildExport('D1', {})); fs.writeFileSync(f1 + '.tmp', b); fs.renameSync(f1 + '.tmp', f1); }
    if (!fs.existsSync(f2)) { const b = expXls(buildExport('D2', {})); fs.writeFileSync(f2 + '.tmp', b); fs.renameSync(f2 + '.tmp', f2); }
    _expLast = key;
    const all = fs.readdirSync(dir).filter((x) => /-\d{8}\.xls$/.test(x)).sort();
    while (all.length > 180) { const old = all.shift(); try { fs.unlinkSync(path.join(dir, old)); } catch (_) {} }
    console.log('[export-daily] ' + key + ' 库位表+库存汇总 已归档');
  } catch (e) { console.log('[export-daily] 失败：', e.message); logErr('dailyExport', e); }
}
setInterval(dailyExport, 30 * 60 * 1000).unref();

// ---- ㉖v52 分析报表：每日 18 点后固化当天指标快照（agvTasks 只留30天、队列终态只留2h，不当天固化月报就缺数）；周/月由日快照现场聚合 ----
// 测试数据识别：下单人/首行零件号含「测试」计入 testN（报告端橙色提示，不静默剔除——透明可查）
const RPT_DIR = () => { const p = path.join(DATA_DIR, 'reports'); try { fs.mkdirSync(p, { recursive: true }); } catch (_) {} return p; };
function rptDayKey(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function rptKeys(s) { const a = String(s).split('-').map(Number); return new Date(a[0], a[1] - 1, a[2]).getTime(); }
function buildDayReport(dayKey) {
  const F = Date.parse(dayKey + 'T00:00:00'), T = F + 86399999;
  const w = buildWork(F, T);
  const dd = w.days[dayKey] || { inB: 0, outB: 0, outQ: 0, fix: 0, ret: 0, acc: 0, done: 0, rej: 0, agv: 0 };
  const persons = Object.values(w.persons).map((p) => ({ name: p.name, inB: p.inB, outB: p.outB, outQ: p.outQ, acc: p.acc, fix: p.fix, ret: p.ret }));
  const mins = (a, b) => (a && b ? Math.max(0, (b - a) / 60000) : 0);
  const iqty = (i) => (i.issued || []).reduce((s, e) => s + (typeof e === 'object' ? (Number(e.q) || 0) : 0), 0);
  let created = 0, accepted = 0, doneN = 0, rejected = 0, cancelled = 0, testN = 0, lateAcc = 0, shortN = 0;
  let accS = 0, accC = 0, rdyS = 0, rdyC = 0, finS = 0, finC = 0;
  for (const r of db.requisitions || []) {
    const cAt = Date.parse(r.createdAt) || 0;
    if (cAt >= F && cAt <= T && (/测试/.test(String(r.byName || '')) || /测试|ceshi/i.test(String(r.remark || '')))) testN++; // ㉖ 仅计本期新单
    const accEv = (r.history || []).find((h) => /^接单/.test(h.text));
    const rAt = Number(r.readyAt) || 0; // 备齐时刻用专用字段（㉖起双路径写入），不依赖文案匹配
    const finEv = (r.history || []).find((h) => /^签收/.test(h.text));
    const aAt = accEv ? Date.parse(accEv.time) : 0, fAt = finEv ? Date.parse(finEv.time) : 0;
    if (cAt >= F && cAt <= T) { created++; if (aAt) { const m = mins(cAt, aAt); accS += m; accC++; if (m > P().assignMin) lateAcc++; } }
    if (aAt >= F && aAt <= T) { accepted++; if (rAt > aAt) { rdyS += mins(aAt, rAt); rdyC++; } }
    if (fAt >= F && fAt <= T) { doneN++; finS += mins(cAt, fAt); finC++; if ((r.items || []).some((i) => i.transferred && iqty(i) < (Number(i.qty) || 0))) shortN++; }
    const lastEv = (r.history || []).slice(-1)[0]; const uAt = lastEv ? (Date.parse(lastEv.time) || 0) : 0;
    if (r.status === 'rejected' && !finEv && uAt >= F && uAt <= T) rejected++;
    if (r.status === 'cancelled' && uAt >= F && uAt <= T) cancelled++;
  }
  const evs = {}; let evTot = 0;
  for (const e of db.carEvents || []) { if (e.ts >= F && e.ts <= T) { evs[e.kind] = (evs[e.kind] || 0) + 1; evTot++; } }
  let agvN = 0, agvDur = 0, agvDurN = 0; const cars = {};
  for (const t of Object.values(db.agvTasks || {})) {
    if (!(t.fin >= F && t.fin <= T)) continue; agvN++;
    const du = t.ex ? t.fin - t.ex : 0;
    const ck = t.car ? ('AGV' + String(t.car).padStart(2, '0')) : '车号缺失'; (cars[ck] = cars[ck] || { n: 0, dur: 0, dn: 0 }); cars[ck].n++; // ㉖v61 未回车号单列
    if (du > 0 && du < 4 * 3600e3) { agvDur += du; agvDurN++; cars[ck].dur += du; cars[ck].dn++; }
  }
  // 库存快照：调用时刻的在架状态（历史日回填时此段为"当前值"，量类指标不受影响；注释明示）
  const boxSet = new Set(), locSet = new Set(); let stale7 = 0; const staleTop = [];
  for (const x of ledgerView()) {
    boxSet.add(boxKeyOf(x)); locSet.add(String(x.l || '').toUpperCase());
    const h = (T - (Number(x.t) || T)) / 3600e3;
    if (h >= 168) { stale7++; staleTop.push({ c: String(x.c), p: String(x.p || ''), l: String(x.l || ''), h: Math.floor(h) }); }
  }
  staleTop.sort((a, b) => b.h - a.h);
  const stnUse = {};
  for (const [k, tl] of Object.entries(db.stnTl || {})) {
    const seg = (tl || []).slice().sort((a, b) => a.t - b.t); let busy = 0;
    for (let i = 0; i < seg.length; i++) {
      if (seg[i].t > T || seg[i].s === '空闲') continue;
      const nx = i + 1 < seg.length ? seg[i + 1].t : T + 1;
      const t0 = Math.max(seg[i].t, F), t1 = Math.min(nx, T + 1);
      if (t1 > t0) busy += t1 - t0;
    }
    stnUse[k] = Math.round(busy / 864e5 * 100);
  }
  let errs = 0; for (const e of db.errLogs || []) if ((e.at || 0) >= F && e.at <= T) errs++;
  return {
    day: dayKey, work: dd, persons,
    reqs: { created, accepted, done: doneN, rejected, cancelled, lateAcc, shortN, testN, accS, accC, rdyS, rdyC, finS, finC },
    events: evs, eventsTotal: evTot,
    agv: { n: agvN, dur: agvDur, durN: agvDurN }, cars,
    stock: { boxes: boxSet.size, locs: locSet.size, stale7, staleTop: staleTop.slice(0, 5) },
    stnUse, errs, params: P(),
  };
}
let _rptLast = '';
function dailyReport() {
  try {
    const d = new Date(); if (d.getHours() < 18) return;
    const key = rptDayKey(d); if (_rptLast === key) return;
    const f = path.join(RPT_DIR(), 'daily-' + key + '.json');
    if (!fs.existsSync(f)) { fs.writeFileSync(f + '.tmp', JSON.stringify(buildDayReport(key))); fs.renameSync(f + '.tmp', f); console.log('[report] 日快照 ' + key + ' 已固化'); }
    _rptLast = key;
    const all = fs.readdirSync(RPT_DIR()).filter((x) => /^daily-\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort();
    while (all.length > 400) { const old = all.shift(); try { fs.unlinkSync(path.join(RPT_DIR(), old)); } catch (_) {} }
  } catch (e) { console.log('[report] 日快照失败：' + e.message); logErr('dailyReport', e); }
}
setInterval(dailyReport, 30 * 60 * 1000).unref();
(function rptBackfill() { // 服务曾停机的补快照（量类指标按时间窗可补算；库存快照段为当前值）
  try {
    for (let i = 3; i >= 1; i--) {
      const key = rptDayKey(new Date(Date.now() - i * 864e5));
      const f = path.join(RPT_DIR(), 'daily-' + key + '.json');
      if (!fs.existsSync(f)) { fs.writeFileSync(f, JSON.stringify(buildDayReport(key))); console.log('[report] 补快照 ' + key); }
    }
  } catch (_) {}
})();
function rptAggregate(list) {
  const agg = { inB: 0, outB: 0, outQ: 0, fix: 0, ret: 0, created: 0, accepted: 0, done: 0, rejected: 0, cancelled: 0, lateAcc: 0, shortN: 0, testN: 0, accS: 0, accC: 0, rdyS: 0, rdyC: 0, finS: 0, finC: 0, agvN: 0, agvDur: 0, agvDurN: 0, evTot: 0, errs: 0, evs: {}, persons: {}, cars: {}, stnUse: {} };
  for (const r of list) {
    agg.inB += r.work.inB; agg.outB += r.work.outB; agg.outQ += r.work.outQ; agg.fix += r.work.fix; agg.ret += r.work.ret;
    for (const k of ['created', 'accepted', 'done', 'rejected', 'cancelled', 'lateAcc', 'shortN', 'testN', 'accS', 'accC', 'rdyS', 'rdyC', 'finS', 'finC']) agg[k] += (r.reqs || {})[k] || 0;
    agg.agvN += r.agv.n; agg.agvDur += r.agv.dur; agg.agvDurN += r.agv.durN; agg.evTot += r.eventsTotal || 0; agg.errs += r.errs || 0;
    for (const [k, v] of Object.entries(r.events || {})) agg.evs[k] = (agg.evs[k] || 0) + v;
    for (const p of r.persons || []) { const t = agg.persons[p.name] = agg.persons[p.name] || { name: p.name, inB: 0, outB: 0, outQ: 0, acc: 0, fix: 0, ret: 0 }; t.inB += p.inB; t.outB += p.outB; t.outQ += p.outQ; t.acc += p.acc; t.fix += p.fix; t.ret += p.ret; }
    for (const [k, c] of Object.entries(r.cars || {})) { const t = agg.cars[k] = agg.cars[k] || { n: 0, dur: 0, dn: 0 }; t.n += c.n; t.dur += c.dur || 0; t.dn += c.dn || 0; }
    for (const [k, v] of Object.entries(r.stnUse || {})) { const s = agg.stnUse[k] = agg.stnUse[k] || { sum: 0, n: 0 }; s.sum += v; s.n++; }
  }
  const last = list[list.length - 1];
  if (last) { agg.stock = last.stock; for (const k of Object.keys(agg.stnUse)) agg.stnUse[k] = Math.round(agg.stnUse[k].sum / agg.stnUse[k].n); }
  return agg;
}

// ---- ㉔AGV异常事件统一聚合（车辆告警/堵点/低电/出库超时/改位冲突/认领） ----
// ---- ㉖异常事件统一持久表 db.carEvents：告警/恢复/认领/升级/红牌/堵点/堵点解除/低电/低电恢复/出库超时/改位冲突/FIFO违反（180天滚动归档，恢复不丢历史）----
function pushEvent(kind, who, msg, ts) { try { db.carEvents = db.carEvents || []; db.carEvents.push({ ts: ts || Date.now(), kind, who: String(who || '').slice(0, 30), msg: String(msg || '').slice(0, 160) }); if (db.carEvents.length > 20000) db.carEvents = db.carEvents.slice(-20000); } catch (_) {} }

function eventsMigrateFromAlarms() { // ㉖首次升级：把存量 carAlarms 历史灌进 carEvents（seen 去重防双计）
  try {
    if (db.carEventsMigrated) return;
    db.carEvents = db.carEvents || [];
    for (const a of db.carAlarms || []) { const kind = a.kind === 'recover' ? '恢复' : a.kind === 'ack' ? '已认领' : a.kind === 'escalate' ? '升级' : a.kind === 'redflag' ? '红牌' : '告警'; if (!db.carEvents.some((e) => e.ts === a.at && e.kind === kind && e.who === a.name)) db.carEvents.push({ ts: a.at, kind, who: String(a.name || '').slice(0, 30), msg: String(a.msg || '').slice(0, 160) }); }
    db.carEvents.sort((x, y) => (x.ts || 0) - (y.ts || 0)); db.carEventsMigrated = 1;
    console.log('[carEvents] 存量告警 ' + (db.carAlarms || []).length + ' 条已迁入持久表');
  } catch (_) {}
}

// ---- ㉖v54 异常事件"了结"只读标注：按业务实况推断（不写事件表、不发通知、每次聚合现算，服务重启无残留） ----
// 超时类判据顺序：①该框后续队列项=完成 → 已了结 ②该框有在途新搬运任务 → 处理中(未了结) ③出库/检验下架方向→账本已离架(无此行或已在CK站台位)=实际拣走 ④入库/归位方向→框已不压任何站台=已放置 ⑤都不满足=未了结
function _markTimeoutResolved(ev) {
  try {
    const led = new Map(); for (const x of db.ledger || []) led.set(String(x.c || '').toUpperCase(), String(x.l || '').toUpperCase());
    const qDone = {}, qAct = {};
    for (const q of db.agvQueue || []) { const c = String(q.code || '').toUpperCase(); if (['排队', '下发中', '已下发', '到站'].includes(q.state)) qAct[c] = 1; if (q.state === '完成') qDone[c] = Math.max(qDone[c] || 0, Number(q.updAt || q.dockAt || q.at) || 0); }
    const atStn = new Set(); for (const st of Object.values(db.rcsStations || {})) { if (st && Array.isArray(st.codes)) for (const cd of st.codes) atStn.add(String(cd || '').toUpperCase()); }
    for (const e of ev) {
      if (!/超时$/.test(String(e.kind || ''))) continue;
      const code = String(e.who || '').toUpperCase(); if (!code) continue;
      e.resolved = 0; e.resMsg = '';
      if (qDone[code] && qDone[code] >= (Number(e.ts) || 0)) { e.resolved = 1; e.resMsg = '后续搬运已完成'; continue; }
      if (qAct[code]) { e.resMsg = '处理中（在途新任务）'; continue; }
      const L = led.get(code);
      if (e.kind === '出库超时' || e.kind === '检验下架超时') { if (!L || /-CK-/.test(L)) { e.resolved = 1; e.resMsg = L ? '框已在站台位（已拣出）' : '框已离架出账'; continue; } }
      else if (e.kind === '入库超时' || e.kind === '检验归位超时') { if (!atStn.has(code)) { e.resolved = 1; e.resMsg = '已不压站台'; continue; } }
      const _aged = Date.now() - (Number(e.ts) || 0) > 24 * 3600e3; // ㉖v54 兜底：超24小时无任何后续动作=陈旧告警，自动闭环不再占现役（人工处置常不走扫码，账本旁证永不成立）
      e.resolved = _aged ? 1 : 0; e.resMsg = _aged ? '超24小时无后续动作，自动闭环' : '未了结';
    }
  } catch (_) {}
}
// 堵点判据：同车存在时刻不早于堵点的"堵点解除"事件 → 已了结
function _markJamResolved(ev) {
  try {
    const up = {}; for (const e of ev) if (e.kind === '堵点解除') { const w = String(e.who || ''); if (up[w] === undefined || (Number(up[w]) > Number(e.ts))) up[w] = e.ts; }
    for (const e of ev) { if (e.kind !== '堵点') continue; const u = up[String(e.who || '')]; const _pair = u !== undefined && u >= (Number(e.ts) || 0); const _aged2 = !_pair && Date.now() - (Number(e.ts) || 0) > 24 * 3600e3; e.resolved = (_pair || _aged2) ? 1 : 0; e.resMsg = _pair ? '交管已放行' : (_aged2 ? '超24小时无后续动作，自动闭环' : '仍未放行'); }
  } catch (_) {}
}

function buildEvents() {
  // ㉖数据源升级：持久表 carEvents 为主（含恢复/解除等全部历史），运行时旧聚合兜底（迁移前数据）
  const arr = (x) => (Array.isArray(x) ? x : Object.values(x || {})); // 防御：历史字段万一被存成对象也不再崩
  const ev = arr(db.carEvents).map((e) => ({ ts: e.ts, kind: e.kind, who: e.who || '', msg: e.msg || '' }));
  const seen = new Set(ev.map((e) => e.ts + '|' + e.kind + '|' + e.who));
  const addOld = (ts, kind, who, msg) => { const k = ts + '|' + kind + '|' + who; if (!seen.has(k)) ev.push({ ts, kind, who, msg }); };
  const last = ev.length ? Math.min.apply(null, ev.map((e) => e.ts || 0)) : 0;
  for (const a of arr(db.carAlarms)) { if (last && a.at < last) break; addOld(a.at, a.kind === 'recover' ? '恢复' : a.kind === 'ack' ? '已认领' : a.kind === 'escalate' ? '升级' : a.kind === 'redflag' ? '红牌' : '告警', a.name || '', a.msg || ''); }
  for (const [jid, j] of Object.entries(db.rcsJam || {})) addOld(j.at || 0, '堵点', 'AGV' + String(jid).padStart(2, '0'), '交管被卡：' + (j.zone || '') + '（' + (j.lands || '') + '）'); // ㉖修：rcsJam是对象非数组，此前for-of必抛异常致events接口500、异常中心恒0条
  for (const [id, v] of Object.entries(db.rcsLowBat || {})) { if (v && v.notified) addOld(v.at || 0, '低电', 'AGV' + String(id).padStart(2, '0'), '低电空闲未回充'); }
  ev.sort((a, b) => b.ts - a.ts);
  const out = ev.slice(0, 800); _markTimeoutResolved(out); _markJamResolved(out); /* ㉖v54 只读了结标注 */ return out;
}

// ㉖①② 标签全局状态：返回该标签在各数据域的命中（账本在库/采集流水/出库单/领料已发/AGV队列在途/检验中/历史出库）
// ---- ㉖v54 货位预占：NB02 AUTO 分配服务器原子版（与 PDA nb02AutoAssign 同款算法：同架→同区→全局，前三层优先；预占10分钟过期） ----
const RES_TTL_MS = 10 * 60 * 1000;
function nb02MasterSeq() { const out = []; for (const z of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']) { for (let r = 1; r <= 16; r++) { const rr = String(r).padStart(2, '0'); for (let f = 1; f <= 4; f++) out.push('NB02-' + z + '-' + rr + '-' + f + 'F'); } } return out; }
function pruneReserve() { const R = db.locReserve || {}; const now = Date.now(); for (const l of Object.keys(R)) { if (now - (Number(R[l].at) || 0) > RES_TTL_MS) delete R[l]; } }
function nb02AssignFree(partNo) {
  pruneReserve();
  const R = db.locReserve || {};
  const used = new Set();
  for (const x of db.ledger || []) { const l = String(x.l || '').toUpperCase(); if (/^NB02-/.test(l) && !/-CK-/.test(l)) used.add(l); }
  for (const l of Object.keys(R)) used.add(l);
  const free0 = nb02MasterSeq().filter((l) => !used.has(l));
  if (!free0.length) return '';
  // ㉖v80 常用层硬约束（网页参数lowTier，修"前三层优先"被同架集中规则击穿上到4层）：
  // 先把候选池限死在1~N层，同架/同区/全局各档规则都在层圈内挑；层圈全空才退回全部空位上高层
  const tierCap = Math.min(4, Math.max(1, P().lowTier));
  const freeLow = free0.filter((l) => (Number(l[l.length - 2]) || 9) <= tierCap);
  const free = freeLow.length ? freeLow : free0;
  const low3 = (arr) => { for (const l of arr) { const f = l.length >= 2 ? l[l.length - 2] : ''; if ((Number(f) || 9) <= tierCap) return l; } return arr.length ? arr[0] : ''; };
  const busyRack = new Set(), busyZone = new Set();
  for (const q of db.agvQueue || []) { if (['完成', '取消', '失败'].includes(q.state)) continue; const fl = String(q.fromLoc || '').toUpperCase(); if (!/^NB02-/.test(fl) || /-CK-/.test(fl)) continue; busyRack.add(fl.slice(0, 9)); if (fl.length > 5) busyZone.add(fl[5]); }
  const cap = P().aisleCap; const ab = cap > 0 ? aisleBusy() : null; // B 巷道节流并入候选过滤
  const calmRack = (arr) => arr.filter((l) => !busyRack.has(l.slice(0, 9)) && (!ab || (ab[l.slice(0, 9)] || 0) < cap));
  const calmZone = (arr) => arr.filter((l) => l.length > 5 && !busyZone.has(l[5]));
  // A 周转黄金区：A类件(周转分前abcTop%)候选按"离CK站台距离"升序，其余保持低层优先
  let pick = low3;
  if (partNo && P().abcTop > 0) {
    const turn = partTurnover(); const pnU = String(partNo).toUpperCase(); const sc = turn[pnU] || 0;
    const vals = Object.values(turn).sort((a, b) => b - a);
    const topN = Math.max(1, Math.ceil(vals.length * P().abcTop / 100));
    const dR = ckDistRack();
    if (sc > 0 && vals.length && sc >= (vals[topN - 1] || 0) && Object.keys(dR).length) {
      pick = (arr) => { const ds = (l) => (dR[l.slice(0, 9)] === undefined ? 9999 : dR[l.slice(0, 9)]); const s2 = arr.slice().sort((a, b) => ds(a) - ds(b)); return s2.length ? s2[0] : low3(arr); };
    }
  }
  if (partNo) {
    const shelves = new Set();
    for (const x of db.ledger || []) { if (String(x.p || '').toUpperCase() !== partNo) continue; const l = String(x.l || '').toUpperCase(); if (/^NB02-[A-Z]-\d{2}-\dF$/.test(l)) shelves.add(l.slice(0, 9)); }
    const shelfList = [...shelves].sort();
    for (const sh of shelfList) { const cand = calmRack(free.filter((l) => l.startsWith(sh))); if (cand.length) return pick(cand); }
    const zones = new Set(shelfList.map((x) => x[5]));
    let sz = calmZone(free.filter((l) => l.length > 5 && zones.has(l[5]))); if (sz.length) return pick(sz);
    let g = calmRack(free); if (g.length) return pick(g);
    const gz = calmZone(free); if (gz.length) return pick(gz);
    for (const sh of shelfList) { const cand = free.filter((l) => l.startsWith(sh)); if (cand.length) return low3(cand); }
    sz = free.filter((l) => l.length > 5 && zones.has(l[5])); if (sz.length) return low3(sz);
  } else {
    const g = calmRack(free); if (g.length) return low3(g);
    const gz = calmZone(free); if (gz.length) return low3(gz);
  }
  return low3(free);
}

// ---- ㉖v56 调度策略助手：A周转分 / B巷道在途 / C站台时间窗 ----
function partTurnover() { // 周转分=窗口内出库件数 + 采集入库件数×0.1（出库主导）
  const cut = Date.now() - P().abcWindow * 864e5; const m = {};
  for (const o of Object.values(db.outbound || {})) { const t = Number(o.createdAt) || 0; if (t < cut) continue; for (const i of (o.items || [])) { const p = String(i.code || '').toUpperCase(); if (p) m[p] = (m[p] || 0) + (Number(i.qty) || 0); } }
  for (const sc of Object.values(db.scanlog || {})) { if (sc.cx) continue; const t = Number(sc.t) || 0; if (t < cut) continue; const p = String(sc.pn || '').toUpperCase(); if (p) m[p] = (m[p] || 0) + (Number(sc.q) || 0) * 0.1; }
  return m;
}
function aisleBusy() { // 巷道(区-排)在途任务数：队列活跃项源货位统计
  // ㉖v80 只算【下发中/已下发】真在途——旧版把"排队"也计入：同巷道≥上限个排队项互相计数互锁，
  // 谁也发不出去谁也超不了时（排队项无sentAt不进超时兜底），实测 B-12 两框 12 分钟死锁（"一直排队中"根因）
  const m = {};
  for (const q of db.agvQueue || []) { if (!['下发中', '已下发'].includes(q.state)) continue; const fl = String(q.fromLoc || '').toUpperCase(); if (!/^NB02-/.test(fl) || /-CK-/.test(fl)) continue; const rk = fl.slice(0, 9); m[rk] = (m[rk] || 0) + 1; }
  return m;
}
let _ckd = null, _ckdT = 0;
function _dijL(lc) { const D = { [lc]: 0 }, pq = [[0, lc]], sn = {}; while (pq.length) { pq.sort((a, b) => a[0] - b[0]); const it = pq.shift(); if (sn[it[1]]) continue; sn[it[1]] = 1; for (const e of (NetMap.adj[it[1]] || [])) { const nd = it[0] + e[1]; if (D[e[0]] === undefined || nd < D[e[0]]) { D[e[0]] = nd; pq.push([nd, e[0]]); } } } return D; }
function ckDistRack() { // 每货架列(区-排)到最近CK站台的Dijkstra距离，30分钟缓存
  const now = Date.now(); if (_ckd && now - _ckdT < 1800000) return _ckd;
  _ckdT = now; _ckd = {};
  try {
    if (!NetMap.ready()) return _ckd;
    const Ds = []; for (const st of AGV_STNS) { const lc = NetMap.locLand[st]; if (lc && NetMap.lands[lc]) Ds.push(_dijL(lc)); }
    if (!Ds.length) return _ckd;
    for (let z = 0; z < 8; z++) for (let r = 1; r <= 16; r++) {
      const rk = 'NB02-' + String.fromCharCode(65 + z) + '-' + String(r).padStart(2, '0');
      let best = Infinity;
      for (const D of Ds) for (let f = 1; f <= 4; f++) { const lc = NetMap.locLand[rk + '-' + f + 'F']; if (lc && D[lc] !== undefined && D[lc] < best) best = D[lc]; }
      if (best < Infinity) _ckd[rk] = Math.round(best);
    }
  } catch (_) {}
  return _ckd;
}
const stnBook = {}; // 站台时间窗预约 {stn:{until,by}}
let _outRecAt = 0; // ㉖v72 出库负向对账节流戳
function releaseStnBook(code) { const c = String(code || '').toUpperCase(); if (!c) return; for (const [k, v] of Object.entries(stnBook)) { if (String(v.by || '').toUpperCase() === c) delete stnBook[k]; } } // ㉖v72 队列项取消/失败→立即作废其站台预约：车不来了不该继续锁台
function stnHoldUntil(stn, nowMs) { const s2 = (db.rcsStations || {})[stn]; if (s2 && (s2.state === '有货' || s2.state === '占用中')) return Infinity; const b = stnBook[stn]; return b && b.until > nowMs ? b.until : 0; }
function stnEtaMs(fromLoc, stn) { let trav = 90; try { const dd = NetMap.dist(fromLoc, stn); if (dd > 0) trav = dd / 0.8; } catch (_) {} const hs = (db.rcsHoldStat || {})[stn]; const holdSec = hs && hs.n ? (hs.sum / hs.n) * 60 * P().stnWinPct / 100 : 120 * P().stnWinPct / 100; return Math.round((trav + 60 + holdSec) * 1000); }
function labelStatus(codeRaw) {
  const code = String(codeRaw || '').trim().toUpperCase(); if (!code) return null;
  const inLedger = (db.ledger || []).filter((x) => String(x.c || '').toUpperCase() === code);
  const inScanlog = Object.values(db.scanlog || {}).filter((x) => String(x.code || '').toUpperCase() === code && !x.cx);
  const inOutbound = []; for (const o of Object.values(db.outbound || {})) for (const i of (o.items || [])) if (String(i.code || '').toUpperCase() === code || String(i.barcode || '').toUpperCase() === code) inOutbound.push(o.orderNo);
  const inIssued = []; for (const r of db.requisitions || []) for (const it of (r.items || [])) for (const e of (it.issued || [])) if (String(typeof e === 'string' ? e : (e.c || '')).toUpperCase() === code) inIssued.push(r.no);
  const inQueue = (db.agvQueue || []).filter((q) => String(q.code || '').toUpperCase() === code && ['排队', '下发中', '已下发', '到站'].includes(q.state));
  const inInspect = (db.inspects || []).filter((q) => String(q.code || '').toUpperCase() === code && ['waitOut','toStation','atStation','waitBack','returning','waitReturn'].includes(q.state));
  const everOut = (db.seenOut || {})[code] || null; // ㉖v68 保留登记对象（含 at/no）：旧版 !! 布尔化使下游 st.everOut.at 恒为 undefined，提示只能显示"历史"
  const everIn = !!(db.seenIn || {})[code]; // ㉖ 历史录过（当前不在架也可能曾在上游批次）
  return { code, inLedger, inScanlog, inOutbound, inIssued, inQueue, inInspect, everOut, everIn, inMeta: (db.seenIn || {})[code] || null };
}
function labelBlockReason(st, purpose) { // purpose: in(采集入库)|out(出库/发料)|agvin|agvout
  if (!st) return '';
  if (purpose === 'in' && (st.inLedger.length || st.inScanlog.length || st.everIn || st.everOut)) {
    if (st.inLedger.length) return '该标签已在库（货位 ' + String(st.inLedger[0].l || '') + '），禁止重复录入';
    if (st.inScanlog.length) return '该标签已有采集记录（批次 ' + String(st.inScanlog[0].gl || st.inScanlog[0].st || '') + '），禁止重复录入';
    if (st.everIn && !st.inLedger.length && !st.inScanlog.length) return '该标签此前已被录入过（' + (st.inMeta && st.inMeta.by ? st.inMeta.by + ' ' : '') + (st.inMeta && st.inMeta.t ? new Date(st.inMeta.t).toLocaleDateString('zh-CN') : '历史') + '，可能已出库），标签号不可复用，禁止重复录入';
    if (st.everOut) return '该标签历史上架并已出库（' + (st.everOut.at ? new Date(st.everOut.at).toLocaleDateString('zh-CN') : '历史') + '），标签不可回收复用，禁止重复录入';
  }
  if (purpose === 'out') {
    if (st.inOutbound.length) return '该标签已在出库单 ' + st.inOutbound.slice(0, 3).join('、') + '，禁止重复出库';
    if (st.inIssued.length) return '该标签已发料到领料单 ' + st.inIssued.slice(0, 3).join('、') + '，禁止重复发料';
    // ㉖⑦ 检验判退货(waitReturn)的框：允许走正常出库通道出账；其余检验状态仍拦截
    const blk = (st.inInspect || []).filter((q) => q.state !== 'waitReturn');
    if (blk.length) return '该框正在检验流程中，暂不可操作';
    return '';
  }
  if (st.inInspect.length) return '该框正在检验流程中，暂不可操作';
  return '';
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
// ---- ㉖B8 运营参数：调度/通知/告警阈值集中可调，服务器端统一取值（改完即时生效）----
const PARAMS = {
  pollSec:        { grp: '调度节奏', name: 'RCS轮询间隔', unit: '秒', min: 1, max: 300, d: 20, tip: '站台/车辆/任务刷新频率，越小越实时但越吃RCS负载（1秒=近实时，注意RCS侧压力）' },
  uiRefreshSec:   { grp: '界面刷新', name: '指挥舱页面刷新', unit: '秒', min: 1, max: 600, d: 30, tip: '网页指挥舱各页(车辆/交管/队列/看板等)自动拉取间隔；数据新鲜度受RCS轮询节律限制，设小于轮询间隔时以轮询为准' },
  assignMin:      { grp: '调度节奏', name: '指定单超时放开', unit: '分钟', min: 1, max: 240, d: 30, tip: '指定仓管员下单后，超时未接单自动放开给全员' },
  urgeMin:        { grp: '通知治理', name: '催单最小间隔', unit: '分钟', min: 1, max: 120, d: 10, tip: '同一张领料单两次催单的最小间隔，防轰炸' },
  pushMin:        { grp: '通知治理', name: '急料到站催扫', unit: '分钟', min: 1, max: 60, d: 5, tip: '急料框到站台超此时长未扫码→广播全体仓管' },
  rushRemindMin:  { grp: '通知治理', name: '急料未接单催办', unit: '分钟', min: 1, max: 60, d: 5, tip: '急料单创建后超此时长仍无人接单→催办全体仓管（10/23复盘：插队只作用于AGV队列，接单环节旧版与普通单同文案无感知）' },
  urgeScanMin:    { grp: '通知治理', name: '普通到站催扫', unit: '分钟', min: 1, max: 120, d: 10, tip: '普通框到站台超此时长未扫码→催叫车人' },
  inspUrgeMin:    { grp: '通知治理', name: '检验协助催办', unit: '分钟', min: 1, max: 120, d: 10, tip: '检验工单等待下架/归位超此时长未处理→催办全体协助人' },
  retUrgeMin:     { grp: '通知治理', name: '退货出账催办', unit: '分钟', min: 5, max: 240, d: 30, tip: '判退货的框压站台超此时长未走出库通道→催办仓管' },
  jamMin:         { grp: '告警阈值', name: '交管堵点告警', unit: '分钟', min: 1, max: 60, d: 3, tip: '车辆被交管卡住超此时长→通知在线仓管' },
  lowBatPct:      { grp: '告警阈值', name: '低电阈值', unit: '%', min: 5, max: 80, d: 25, tip: '电量低于此值计入低电观察' },
  lowBatMin:      { grp: '告警阈值', name: '低电未回充告警', unit: '分钟', min: 5, max: 240, d: 20, tip: '低电且空闲超此时长未回充→提醒安排充电' },
  batch:          { grp: '调度节奏', name: '单轮最多下发', unit: '单', min: 1, max: 8, d: 4, tip: '排队调度器每轮最多真实下发几单（保守节奏）' },
  agingMin:       { grp: '调度节奏', name: '排队防饿死升级', unit: '分钟', min: 2, max: 120, d: 10, tip: '普通队列项等待超此时长自动按急料优先级调度' },
  sendTimeoutMin: { grp: '调度节奏', name: '下发无回执判失败', unit: '分钟', min: 1, max: 30, d: 5, tip: '下发中超此时长无回执→判失败可重试，防站台封死' },
  staleMin:       { grp: '调度节奏', name: '在途超时判定', unit: '分钟', min: 5, max: 240, d: 40, tip: '已下发/移库超此时长未完成→判失败并通知' },
  manualHoldMin:  { grp: '调度节奏', name: '人工占台压制', unit: '分钟', min: 1, max: 240, d: 30, tip: '人工标记站台占用后的压制时长，防误叫车撞台' },
  aggMin:         { grp: '通知治理', name: '同类通知聚合窗', unit: '分钟', min: 0, max: 60, d: 5, tip: '同类型通知在此窗口内合并为"等N条"（0=不聚合）' },
  rateMax:        { grp: '通知治理', name: '每人每分钟条数上限', unit: '条', min: 1, max: 50, d: 5, tip: '单人单分钟超此条数→跨类型强制合并防风暴刷屏' },
  nStart:         { grp: '通知治理', name: '夜间静默起(时)', unit: '点', min: 0, max: 23, d: 22, tip: '从该点起非急停类通知进按人缓冲（车辆告警豁免）' },
  nEnd:           { grp: '通知治理', name: '夜间静默止(时)', unit: '点', min: 0, max: 23, d: 6, tip: '到该点发送各自夜间汇总（带原单号可跳转）' },
  ganttH:         { grp: '数据保留', name: '站台甘特时间窗', unit: '小时', min: 1, max: 24, d: 8, tip: '站台甘特图/状态时间线显示最近几小时；无历史的站台补满窗空闲' },
  queueKeepMin:   { grp: '数据保留', name: '完成队列项保留', unit: '分钟', min: 10, max: 1440, d: 120, tip: '队列控制台"最近任务(终态)"里完成/取消项保留时长' },
  failKeepMin:    { grp: '数据保留', name: '失败队列项保留', unit: '分钟', min: 5, max: 720, d: 30, tip: '失败项在队列里保留多久供查看原因后自动出队' },
  trailMin:       { grp: '数据保留', name: '轨迹回放保留', unit: '分钟', min: 30, max: 2880, d: 1440, tip: '车辆轨迹采样点保留时长（轨迹回放可选窗口上限）' },
  notifKeep:      { grp: '数据保留', name: '通知保留条数', unit: '条', min: 100, max: 5000, d: 500, tip: '消息中心滚动保留最近多少条通知（超出丢弃最旧）' },
  archDays:       { grp: '数据保留', name: '流水归档窗口', unit: '天', min: 30, max: 365, d: 90, tip: '采集流水/出库单超期挪归档目录（主库瘦身；导出勾「含归档」仍可查全史）；原硬编码180' },
  reqArchDays:    { grp: '数据保留', name: '领料单归档窗口', unit: '天', min: 90, max: 730, d: 365, tip: '已终结(签收/拒单/取消)领料单超期挪归档，主库只留在途与近一年；未终结单永不归档' },
  rackCount:      { grp: '存储配置', hide: 1, name: '高架货架数', unit: '架', min: 1, max: 40, d: 8, tip: 'NB02 高位货架台数（现场 8 台：A~H 一个字母一台，货位码 NB02-字母-列-层 的字母段即架号）' },
  rackCols:       { grp: '存储配置', hide: 1, name: '每架列数', unit: '列', min: 4, max: 60, d: 16, tip: '每台货架横向格列数（现场 16 列）；总格位=架数×列数×层数' },
  rackTiers:      { grp: '存储配置', hide: 1, name: '每架层数', unit: '层', min: 1, max: 10, d: 4, tip: '每台货架纵向层数（现场 4 层：1F-4F）' },
  gndZones:       { grp: '存储配置', hide: 1, name: '地面区数', unit: '区', min: 1, max: 20, d: 6, tip: 'NB03 地面货区数量（现场 A/B/C/F/G/H 六区）；地面总格位=区数×每区排数×每排格数' },
  gndRows:        { grp: '存储配置', hide: 1, name: '每区排数', unit: '排', min: 1, max: 40, d: 18, tip: '每个地面区的默认排数（现场排号到 18）；可在「地面排配置」按区单独覆盖（如 B 区 15 排），并支持停用指定排（如 A-01 不用）' },
  gndCols:        { grp: '存储配置', hide: 1, name: '每排格数', unit: '格', min: 1, max: 60, d: 12, tip: '每排默认格数（逐排覆盖配置优先：位置登记页可对单排改格数）' },
  abcWindow:      { grp: '调度策略', name: 'ABC周转统计窗', unit: '天', min: 7, max: 365, d: 30, tip: '出库单+采集流水的统计窗口，用于给零件打周转分' },
  abcTop:         { grp: '调度策略', name: 'A类件比例', unit: '%', min: 0, max: 80, d: 20, tip: '周转分前N%判为A类：入库自动分配时优先靠近CK站台的货架列（0=关闭该策略）' },
  aisleCap:       { grp: '调度策略', name: '巷道并发上限', unit: '任务', min: 0, max: 8, d: 2, tip: '同一货架巷道(区-排)在途搬运任务数上限，达到则新出库任务本轮不放行、入库分配避开（0=关闭节流）' },
  stnWinPct:      { grp: '调度策略', name: '站台时间窗系数', unit: '%', min: 50, max: 300, d: 100, tip: '预约窗=路网行程+60秒缓冲+该台平均清台时长×系数；窗内站台不派新单，防两车前后脚撞台' },
  lowTier:        { grp: '调度策略', name: '入库常用层上限', unit: '层', min: 1, max: 4, d: 3, tip: 'AUTO自动分配的硬性层约束：只在1~N层找空位（同架/同区集中也在层圈内生效），圈内全满才上更高层；4=不限。AGV叉高层耗时且重心高风险大，建议3' },
  strictFifo:     { grp: '调度策略', name: '严格FIFO发料', unit: '开关', min: 0, max: 1, d: 1, tip: '1=扫码发料只允许「取货建议」清单里的标签（含同托兄弟码与已叫车框）。晚批次码：PDA弹黄色FIFO提醒，仓管点「确认继续」→服务端复核批次确实更晚后放行（工单+事件双留痕），不再二次拦窗；同批次却不在清单的码（扫错/幽灵码）即使带确认也拒绝。0=回退旧行为（服务端不拦，仅PDA黄提醒）' },
};
function P() { const o = {}; for (const [k, d] of Object.entries(PARAMS)) { const v = (db.params || {})[k]; o[k] = (typeof v === 'number' && Number.isFinite(v)) ? v : d.d; } return o; }
// ㉖v90 排号清单解析："11-18,20" / [11,12,...] / 数组字符串 → 去重排序的 1~40 数字数组；空/非法 → null（=未配置，沿用排数逻辑）
function parseRowList(v) {
  try {
    if (Array.isArray(v)) v = v.join(',');
    const s = String(v == null ? '' : v).trim();
    if (!s || s === '-' || s === 'null') return null;
    const out = new Set();
    for (const seg of s.split(/[,，、;；\s]+/)) {
      if (!seg) continue;
      const rg = seg.match(/^(\d+)\s*[-~至到]\s*(\d+)$/);
      if (rg) { const a = Number(rg[1]), b = Number(rg[2]); for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (i >= 1 && i <= 40) out.add(i); continue; }
      const n = Number(seg);
      if (Number.isFinite(n) && n >= 1 && n <= 40) out.add(Math.round(n));
    }
    return out.size ? [...out].sort((a, b) => a - b) : null;
  } catch (_) { return null; }
}

// ---- ㉖ 系统错误环形日志：服务器自身异常（请求500/后台任务吞错/未捕获）统一留痕，控制后台"系统错误"页可查、凭栈定位 ----
let SYS_ERR_MAX = 500;
function logErr(where, e, extra) {
  try {
    db.sysErr = db.sysErr || [];
    const stack = e && e.stack ? String(e.stack).split('\n').slice(0, 4).join(' | ') : '';
    db.sysErr.push({ id: newId('se'), at: Date.now(), where: String(where).slice(0, 60), msg: String((e && e.message) || e || '').slice(0, 400), stack: stack.slice(0, 600), extra: extra ? String(extra).slice(0, 200) : '' });
    if (db.sysErr.length > SYS_ERR_MAX) db.sysErr = db.sysErr.slice(-SYS_ERR_MAX);
  } catch (_) {}
}

// ---- ㉕T1 通知治理：同类5分钟静默聚合（并入原条"等N条"）/ 每人每分钟超5条跨类型强制聚合 / 夜间22-6点非急停类按人缓冲，早6点各自一条汇总 ----
const _nq = new Map(); const _nrate = new Map(); let _nightFlushed = '';
const URGENT_TYPES = new Set(['car_alarm', 'inspect', 'req_rush']);   // 车辆告警（含急停）与急料单永不夜间静默（v88：夜班急料等早6点才汇总=失去急的意义）
const NTYPE = { req_new: 'req_new', req_timeout: 'req_new', req_reassign: 'req_new', req_urge: 'req_urge', req_arrive: 'req_arrive', req_accept: 'req_flow', req_ready: 'req_flow', req_ready_wh: 'req_flow', req_done: 'req_flow', req_reject: 'req_flow', req_cancel: 'req_flow', watch_in: 'watch_in', stock_out: 'stock_out' }; // ㉕F5 订阅粒度（car_alarm不在表内=强制必达）
function notify(toUserId, type, text, reqId) {
  try {
    const now = Date.now(), hr = new Date(now).getHours();
    if ((hr >= P().nStart || hr < P().nEnd) && !URGENT_TYPES.has(type)) { // 夜间非急停：按人进缓冲，到点各自汇总
      db.nightBuf = db.nightBuf || {};
      const arr = (db.nightBuf[toUserId] = db.nightBuf[toUserId] || []);
      if (arr.length < 40) arr.push({ type, text: String(text).slice(0, 60), reqId: reqId || '', at: new Date(now).toLocaleString('zh-CN', { hour12: false }).slice(5, 16) });
      return;
    }
    { const np = db.prefs && db.prefs[toUserId] && db.prefs[toUserId].notes; if (np && np.v && type !== 'car_alarm' && np.v[NTYPE[type] || type] === false) return; } // ㉕F5 个人退订生效
    const key = toUserId + '|' + type;
    const rk = _nrate.get(toUserId) || [Math.floor(now / 60000), 0];
    if (rk[0] !== Math.floor(now / 60000)) { rk[0] = Math.floor(now / 60000); rk[1] = 0; }
    rk[1]++; _nrate.set(toUserId, rk);
    const last = _nq.get(key);
    // 同类型5分钟聚合；或该人本分钟已超5条→跨类型也合并到其最近一条（限流消费，防风暴刷屏）
    if (last && now - last.at < P().aggMin * 60000) {
      const idx = db.notifications.findIndex((x) => x.id === last.id);
      if (idx >= 0) {
        const n = (last.n || 1) + 1; last.n = n; last.at2 = now;
        const base = db.notifications[idx].text.replace(/（等 \d+ 条，已合并）$/, '');
        db.notifications[idx].text = base + '（等 ' + n + ' 条，已合并）';
        db.notifications[idx].time = new Date(now).toISOString(); db.notifications[idx].read = false;
        try { const uu = db.users.find((x) => x.id === toUserId); sseSend({ t: 'notif', to: toUserId, who: uu ? uu.name : toUserId, type, text: db.notifications[idx].text, reqId: reqId || '' }); } catch (_) {}
        return;
      }
    }
    if (rk[1] > P().rateMax) {
      let newest = null, nIdx = -1;
      for (let i = db.notifications.length - 1; i >= 0 && i >= db.notifications.length - 60; i--) { const x = db.notifications[i]; if (x.to === toUserId && !/已合并/.test(x.text) && now - Date.parse(x.time) < P().aggMin * 60000) { newest = x; nIdx = i; break; } }
      if (newest) {
        const n = (newest._mn || 1) + 1; newest._mn = n;
        const base = newest.text.replace(/（等 \d+ 条，已合并）$/, '');
        newest.text = base + '（等 ' + n + ' 条，已合并）'; newest.time = new Date(now).toISOString(); newest.read = false;
        try { const uu = db.users.find((x) => x.id === toUserId); sseSend({ t: 'notif', to: toUserId, who: uu ? uu.name : toUserId, type, text: newest.text, reqId: reqId || '' }); } catch (_) {}
        return;
      }
    }
    const id = newId('n');
    db.notifications.push({ id, to: toUserId, type, text, reqId: reqId || '', time: new Date().toISOString(), read: false });
    _nq.set(key, { id, at: now, at2: now, n: 0 });
    if (db.notifications.length > P().notifKeep) db.notifications = db.notifications.slice(-P().notifKeep); // ㉖ 保留条数可调（原硬编码500）
    try { const uu = db.users.find((x) => x.id === toUserId); sseSend({ t: 'notif', to: toUserId, who: uu ? uu.name : toUserId, type, text, reqId: reqId || '' }); } catch (_) {}
  } catch (_) {}
}
// 夜间缓冲日出汇总：每人一条（只含本人昨夜通知，带原reqId可跳转；night_digest不在PDA白名单=不弹系统通知，站内/网页可见，不破坏旧APK）
function nightDigest() {
  try {
    const hr = new Date().getHours(); if (hr < P().nEnd || hr >= P().nStart) return;
    if (Array.isArray(db.nightBuf)) db.nightBuf = {}; // ㉕兼容：旧全局数组缓冲已废弃，按人分桶重来
    const day = new Date().getFullYear() + '-' + (new Date().getMonth() + 1) + '-' + new Date().getDate() + 'H' + P().nEnd;
    if (_nightFlushed === day) return;
    _nightFlushed = day;
    const buf = db.nightBuf || {}; db.nightBuf = {}; save();
    let n = 0;
    for (const [uid, arr] of Object.entries(buf)) {
      if (!arr || !arr.length) continue;
      const uu = db.users.find((x) => x.id === uid); if (!uu || !uu.enabled) continue;
      const line = '🌙 夜间静默汇总（' + arr.length + ' 条）：' + arr.slice(0, 15).map((b) => b.at + ' ' + b.text).join('；');
      db.notifications.push({ id: newId('n'), to: uid, type: 'night_digest', text: line.slice(0, 300), reqId: arr[0].reqId || '', time: new Date().toISOString(), read: false });
      if (db.notifications.length > P().notifKeep) db.notifications = db.notifications.slice(-P().notifKeep);
      n++;
    }
    if (n) { save(); console.log('[notify] 夜间汇总按人下发 ' + n + ' 份'); }
  } catch (_) {}
}
setInterval(nightDigest, 5 * 60 * 1000).unref();
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
    db.users.filter(x => x.role === 'admin' && x.enabled).forEach(x =>
      notify(x.id, 'req_timeout', `⏱ 领料单 ${r.no}（${r.byName}）指定 ${r.assigneeName || ''} 超时未接单已放开，请协调仓管尽快处理`, r.id)); // ⑲升级路径：管理员可见
    changed = true;
  }
  if (changed) save();
}
// 框键：有托号按托号合并（整托多码=1框）；无托号按"同货位+同零件号"合并（与PDA库存口径一致）；都缺才一码一框
// ===== ⑮ 库存事件检测：预约到料 + 断料预警（账本合并后调用） =====
// ㉖v94n 预约够数履行：数量预订满额→自动开领料单（与手动建单同构：单号LL+本地时间+序号；pending状态；留痕+双方通知）
// 防呆：已有同零件未完结领料单→不重复开（通知说明）；auto=false→只通知不开单；无领料权限→转告仓管
function bookingFulfill(w, user, pn, got, want, byName) {
  try {
    const open = (db.requisitions || []).find((r) => ['pending', 'accepted'].includes(r.status) && (r.items || []).some((i) => String(i.partNo || '').toUpperCase() === pn));
    if (open) { w.filledReq = 'dup'; notify(user.id, 'watch_in', `📦 预约达成但已有未完结领料单 ${open.no}（含零件 ${pn}），未重复开单。可在那张单里核销，或先处理后再预约`, open.id); return; }
    if (w.auto === false) { w.filledReq = 'auto-off'; notify(user.id, 'watch_in', `📦 预约达成：零件 ${pn} 到料 ${got}/${want} 框（你设置了不自动开单）。请自行开领料单或联系仓管`, ''); (db.users || []).filter((x) => x.enabled && x.role === 'warehouse').forEach((x) => notify(x.id, 'watch_in', `📦 预约到货：${user.name} 预订的零件 ${pn} 已到 ${got} 框（目标 ${want}）`, '')); return; }
    const canReq = (db.features[user.role] || {}).requisition === true;
    if (!canReq) { w.filledReq = 'no-perm'; notify(user.id, 'watch_in', `📦 预约达成：零件 ${pn} 到料 ${got}/${want} 框。当前角色未开领料权限，已转告仓管备料`, ''); (db.users || []).filter((x) => x.enabled && x.role === 'warehouse').forEach((x) => notify(x.id, 'watch_in', `📦 预约到货：${user.name} 预订的零件 ${pn} 已到 ${got} 框，请安排备料`, '')); return; }
    const now = new Date(), ts = localTs(now);
    const r = { id: newId('rq'), no: `LL${ts}${String(db.requisitions.length % 100).padStart(2, '0')}`, by: user.id, byName: user.name,
      items: [{ partNo: pn, itemName: String(w.itemName || ''), qty: got, issued: [], rush: false }], status: 'pending',
      remark: `预约自动开单：${user.name} 预订 ${want} 框，实际到料 ${got} 框（${byName} 入库触发）`, createdAt: now.toISOString(), history: [{ time: now.toISOString(), by: '系统', text: `🤖 预约达成自动开单：零件 ${pn} 到料 ${got}/${want} 框` }],
      assigneeId: '', assigneeName: '', assignOpenAt: '', rush: false, rushBy: '', needDate: w.due || '', fromBooking: true };
    db.requisitions.push(r);
    w.filledReq = r.id; w.filledAt = Date.now();
    (db.users || []).filter((x) => x.role === 'warehouse' && x.enabled).forEach((x) => notify(x.id, 'req_new', `🤖 预约到齐自动开单：${user.name} 预订零件 ${pn} 已到 ${got} 框 → 领料单 ${r.no}（请按 ${got} 框备料）`, r.id));
    notify(user.id, 'watch_in', `✅ 预约达成：零件 ${pn} 到料 ${got}/${want} 框，已自动为你开领料单 ${r.no}`, r.id);
    pushOps(user, '预约自动开单', pn, `到料${got}框 → ${r.no}`);
    console.log('[booking] ' + pn + ' 够数自动开单 ' + r.no);
  } catch (e) { console.log('[booking] 履行异常：', e.message); logErr('bookingFulfill', e); }
}
function partBoxCounts() {
  const m = {}, seen = {}; // 按框计（同托多码=1框）
  for (const x of db.ledger || []) {
    const p = String(x.p || '').toUpperCase(); if (!p) continue;
    const kk = p + '|' + boxKeyOf(x); if (seen[kk]) continue; seen[kk] = 1;
    m[p] = (m[p] || 0) + 1;
  }
  return m;
}
function stockWatchScan(pre, byName) {
  try {
    const post = partBoxCounts();
    const t0 = new Date(); t0.setHours(0, 0, 0, 0);
    // 预约到料：今日新上账框命中 watchlist // ㉖v94n 升级：带数量预订的=算进度→够数自动开领料单(留痕+双方通知)；纯提醒型走旧"每零件每天一次"通知
    const wl = db.watchlist || [];
    if (wl.length) {
      const arrived = {}, _abseen = {};
      for (const x of db.ledger || []) { if ((x.t || 0) < t0.getTime()) continue; const p = String(x.p || '').toUpperCase(); if (!p) continue; const kk = p + '|' + boxKeyOf(x); if (_abseen[kk]) continue; _abseen[kk] = 1; arrived[p] = (arrived[p] || 0) + 1; }
      const dayKey = new Date().toISOString().slice(0, 10); // ㉖ 预约到料=每零件每天一次（旧10分钟窗口：当天只要持续入库就反复轰炸）
      db.watchSeen = (db.watchSeen && typeof db.watchSeen === 'object' && !Array.isArray(db.watchSeen)) ? db.watchSeen : {};
      for (const k of Object.keys(db.watchSeen)) if (!k.endsWith('|' + dayKey)) delete db.watchSeen[k]; // 跨天自动清
      for (const w of wl) {
        const p = String(w.partNo || '').toUpperCase();
        if (!p || !arrived[p]) continue;
        const user = db.users.find((x) => x.id === w.userId);
        const wq = Number(w.qty) || 0;
        if (!wq) { // 纯提醒型（旧预约）：保持原"每零件每天首次到料通知一次"
          const lk = p + '|' + w.userId + '|' + dayKey;
          if (db.watchSeen[lk]) continue; db.watchSeen[lk] = 1; save();
          if (!user || !user.enabled) continue;
          notify(w.userId, 'watch_in', `🛒 预约到料（今日首次）：零件 ${p} 今日已入库 ${arrived[p]} 框，当前在架 ${post[p] || 0} 框`, '');
          continue;
        }
        if (w.filledReq === 'dup' && !(db.requisitions || []).find((r) => ['pending', 'accepted'].includes(r.status) && (r.items || []).some((i) => String(i.partNo || '').toUpperCase() === p))) { w.filledReq = ''; w.got = 0; w.arrDate = ''; w.arrLast = 0; } // 未完单已被处理完→本轮重开计数可再履行
        if (w.filledReq) continue; // 本轮已履行
        // ㉖v94n 到料计数=跨日累计只增不减（当天快照被消耗会回落，增量法防漏计）：新的一天加当天全部，同日只加超出上次快照的增量
        const todayArr = arrived[p] || 0;
        if (String(w.arrDate || '') !== dayKey) { if (todayArr > 0) { w.got = (Number(w.got) || 0) + todayArr; w.arrDate = dayKey; w.arrLast = todayArr; } }
        else if (todayArr > (Number(w.arrLast) || 0)) { w.got = (Number(w.got) || 0) + (todayArr - (Number(w.arrLast) || 0)); w.arrLast = todayArr; }
        const got = Number(w.got) || 0;
        if (got <= (Number(w.notifiedGot) || 0)) continue; // 计数无新增不重复提示
        w.notifiedGot = got;
        const pct = Math.min(100, Math.round(got * 100 / wq));
        if (!user || !user.enabled) continue;
        if (got < wq) {
          notify(w.userId, 'watch_in', `📦 预约进度：零件 ${p} 已到料 ${got}/${wq} 框（${pct}%），在架 ${post[p] || 0}，够数将自动开领料单`, '');
        } else {
          bookingFulfill(w, user, p, got, wq, byName); // 够数→自动开单（内部留痕+通知；auto关闭时降级为提醒）
        }
      }
    }
    // 断料预警：合并前有、合并后清零；每零件每天最多一次
    const day = new Date().toISOString().slice(0, 10);
    db.stockAlert = db.stockAlert || {};
    for (const p of Object.keys(pre)) {
      if (post[p]) { delete db.stockAlert[p]; continue; }
      if (db.stockAlert[p] === day) continue;
      db.stockAlert[p] = day;
      db.users.filter((x) => x.enabled && (x.role === 'warehouse' || x.role === 'admin')).forEach((x) => notify(x.id, 'stock_out', `⚠️ 断料预警：零件 ${p} 在架已清零（${byName} 操作后），请安排补货`, ''));
      (db.requisitions || []).forEach((r) => { if (!['pending', 'accepted'].includes(r.status)) return; if ((r.items || []).some((i) => String(i.partNo || '').toUpperCase() === p)) { const tip = r.status === 'pending' ? '可删除该行或取消重下，或联系仓管协调' : '请联系仓管员协调补料安排'; notify(r.by, 'stock_out', `⚠️ 断料预警：你的领料单 ${r.no} 所需零件 ${p} 在架已清零，${tip}`, r.id); } });
      wl.filter((w) => String(w.partNo || '').toUpperCase() === p).forEach((w) => notify(w.userId, 'stock_out', `⚠️ 你预约的零件 ${p} 在架已清零（补货后会自动通知到料）`, ''));
      console.log('[stock-out] ' + p);
    }
    save();
  } catch (e) { console.log('[stock] 检测异常：', e.message); logErr('stockCheck', e); }
}

function boxKeyOf(x) {
  const pid = String(x.pid || '').toUpperCase();
  if (pid) return 'P|' + pid;
  const l = String(x.l || '').toUpperCase(), p = String(x.p || '').toUpperCase();
  return (l && p) ? 'L|' + l + '|' + p : 'C|' + String(x.c).toUpperCase();
}
// ㉖v95b 容器类型乱码归一（模块级共享：启动迁移自愈 + 推送清洗兜底）：剥离坏字符后与容器类型字典（db值+show值）
// 四级匹配——精确→唯一前缀→唯一包含→唯一子序列（"2.4铁框"中段字符整个丢失仍救回"2.4米铁框"）；多义/无解返回剥离值不臆造
const _ctBad = /[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;
function ctNorm(v0, types) {
  const raw = String(v0 == null ? '' : v0);
  const s0 = raw.replace(_ctBad, '').trim();
  if (!s0 || s0 === raw.trim()) return s0.slice(0, 40); // 无坏字符=原样（trim截断）；全坏=空
  const cts = [];
  for (const ct of (types || db.containerTypes || [])) { if (ct && ct.db) cts.push(ct.db); if (ct && ct.show && ct.show !== ct.db) cts.push(ct.show); }
  if (cts.includes(s0)) return s0;
  const pre = cts.filter((t) => t.startsWith(s0) || s0.startsWith(t)); if (pre.length === 1) return pre[0];
  const inc = cts.filter((t) => t.includes(s0) || s0.includes(t)); if (inc.length === 1) return inc[0];
  const _sub = (a, b) => { let i = 0; for (const ch of b) { const k = a.indexOf(ch, i); if (k < 0) return false; i = k + 1; } return true; };
  const sub = cts.filter((t) => _sub(t, s0)); return sub.length === 1 ? sub[0] : s0.slice(0, 40);
}
// 移库完成：把被搬货架(同框组)在货位账本改到新位，登记时间刷新→增量同步广播各PDA；仅在确认到达后调用
function applyTransferLedger(t) {
  const from = String(t.from || '').toUpperCase(), to = String(t.to || '').toUpperCase();
  if (!from || !to || from === to) return 0;
  const anchor = (db.ledger || []).find(function (x) { return String(x.l).toUpperCase() === from && (!t.code || String(x.c).toUpperCase() === String(t.code).toUpperCase()); });
  if (!anchor) return 0;
  const bk = boxKeyOf(anchor); let n = 0;
  for (const x of db.ledger || []) { if (String(x.l).toUpperCase() === from && boxKeyOf(x) === bk) { x.l = to; x.t = Date.now(); n++; } }
  if (n) { save(); for (const u of db.users || []) if (u.role === 'warehouse' || u.role === 'admin') notify(u.id, 'transfer_done', '移库完成：' + from + ' → ' + to + '（' + n + ' 个标签账本已更新）', ''); }
  return n;
}
function groupLedgerBoxes(list) {
  const g = new Map();
  for (const x of list) {
    const k = boxKeyOf(x);
    if (!g.has(k)) g.set(k, { codes: [], items: [], l: x.l, q: 0, b: String(x.b || ''), f: String(x.f || ''), pid: String(x.pid || '') });
    const box = g.get(k);
    box.codes.push(x.c); box.items.push({ c: x.c, q: Number(x.q) || 0 });
    box.q += Number(x.q) || 0; // ㉖ 框数量=框内各标签之和（一筐两标签各25→50；旧"每码都是整框数取max"假设作废）
    if (x.b && (!box.b || String(x.b) < box.b)) box.b = String(x.b); // 批次取最早
  }
  return [...g.values()].sort((a, b) => (a.b || '9999').localeCompare(b.b || '9999') || String(a.l).localeCompare(String(b.l))); // 批次早优先
}
// ㉖v94p 台号实时回填：叫车登记时 agvCalled.s 写的是空串（那刻还没分配站台），下发分配后也从未回填
// → PDA 取货建议里已叫车的框只显示占位词"已叫"、看不到送往哪个台（10/25 现场反馈）。
// 现在：s 为空时从活跃队列项取真实台号（兼容历史行，无需数据迁移）；确实查不到才兜底"已叫"。
function agvMapOf(i) {
  const m = {};
  for (const e of ((i && i.agvCalled) || [])) {
    const c = String(e.c).toUpperCase();
    let stn = String(e.s || '');
    if (!stn) {
      const q = (db.agvQueue || []).find((x) => String(x.code || '').toUpperCase() === c && ['排队', '下发中', '已下发', '到站', '完成'].includes(x.state));
      if (q) stn = String(q.station || q.stationManual || '');
    }
    m[c] = stn || '已叫';
  }
  return m;
}
// 取货建议：PDA 同步的货位账本（含托号 pid）→ 按框（同托多码=1框）FIFO 选框；agvMap 标记已叫AGV的框
function pickSuggest(partNo, needQty, excludeCodes, agvMap) {
  const agv = agvMap || {};
  const ex = excludeCodes || new Set();
  const match = ledgerView().filter(x => String(x.p || '').toUpperCase() === String(partNo || '').toUpperCase()); // ㉖ 用派生批次视图：FIFO 按 MES 打印日期先后（YYYY-MM-DD 字典序=时间序）
  const boxes = [];
  for (const bx of groupLedgerBoxes(match)) { // ㉖v59 方案B：框内已发码剔除、剩余码保留（逐码发料，半发框继续出现在建议里）；全发完才整框消失
    const left = bx.codes.filter(c => !ex.has(String(c).toUpperCase()));
    if (!left.length) continue;
    bx.allCodes = bx.codes.slice(); // 原全码保留：AGV叫车是整托一车，兄弟码叫过→剩余码同样标记
    bx.codes = left;
    bx.items = bx.items.filter(it => left.includes(it.c));
    bx.q = bx.items.reduce((a, it) => a + (Number(it.q) || 0), 0);
    bx.agv = bx.allCodes.map(c => agv[String(c).toUpperCase()]).find(Boolean) || ''; // 框内任一标签叫过AGV → 整框标记（一框一车，同托标签一起走）
    boxes.push(bx);
  }
  const noInfoKeys = new Set();
  for (const x of match) if (!x.q) noInfoKeys.add(boxKeyOf(x));
  // ㉖v79c 剩余需求≤0=该行已发齐/跳过：不再给任何【新】建议框。
  // 旧版按【原始需求】算——已发600/600仍显示"建议2框≈600件"，物料员照着再叫2框车直接超发（重大bug）
  // ㉖v92b 但"已叫车未扫码"的框必须返回显示：框是应本单叫车、已在途/已到站的——藏码=仓管扫不了记不上，
  // 只能把到站框走直调拆单出库（10/24 LL…4913 复盘：390框到CK-11因发齐被藏码，被迫走DT单）。超发可在转单窗撤扫返架，两害相权可记录优先
  if (!(needQty > 0)) {
    const calledPending = boxes.filter(bx => bx.agv).flatMap(bx => bx.items.map(it => ({ c: it.c, q: it.q, l: bx.l, b: bx.b, f: bx.f, agv: bx.agv })));
    return { boxes: [], flatBoxes: [], total: 0, over: 0, inStock: 0, noInfoQty: noInfoKeys.size, need: 0, done: true, calledPending };
  }
  let acc = 0; const pick = [];
  for (const x of boxes) {
    pick.push(x);
    acc += x.q;
    if (acc >= needQty) break;
    if (pick.length >= 24) break; // 最多建议 24 框（大单一筐20件×25框也能覆盖大半）
  }
  // ㉖v69 末框最小化超发：贪心够数后，若最后一框明显过大，用未选框中"能补足剩余需求且件数最小"的框替换（批次不晚于它，守 FIFO 大序）
  if (needQty > 0 && acc > needQty && pick.length) {
    const last = pick[pick.length - 1];
    const needLast = acc - last.q; // 去掉末框后的累计
    const remain = needQty - needLast; // 末框需覆盖的件数
    const cand = boxes.filter(x => !pick.includes(x) && x.q >= remain && x.q < last.q && String(x.b || '9999') <= String(last.b || '9999'))
      .sort((a, b) => a.q - b.q || String(a.b || '9999').localeCompare(String(b.b || '9999')))[0];
    if (cand) {
      const called2 = cand.allCodes.map(c => agv[String(c).toUpperCase()]).find(Boolean) || '';
      cand.agv = called2;
      pick[pick.length - 1] = cand; acc = needLast + cand.q;
    }
  }
  // ㉖v82b 撤销"单框最小覆盖"（用户拍板：装框不规范时600小筐+3000大筐并存，跳批次选大筐严重违背先进先出；宁可按FIFO多叫筐，不可挑框）
  // 原逻辑：if (needQty > 0 && pick.length > 1) { const one = boxes.filter(x => x.q >= needQty).sort((a, b) => a.q - b.q)[0]; if (one && one.q < acc) {...} }
  const over = Math.max(0, Math.round((acc - needQty) * 100) / 100); // 超发件数（整框发料无法精确凑数时，供UI提示"多备N件/可返架"）
  // ㉖v82 严重超发判定：超发 > 需求本身（如一筐2400只为补109件）——建议区红字提示+接单即派不自动派这种框，人工拍板
  const severeOver = needQty > 0 && pick.length > 0 && over > needQty;
  const flatBoxes = pick.flatMap(g0 => g0.items.map(it => ({ c: it.c, q: it.q, l: g0.l, b: g0.b, f: g0.f, agv: g0.agv }))); // 标签级：供逐码复制/扫码
  return { boxes: pick, flatBoxes, total: acc, over, severeOver, left: Math.max(0, Math.round(needQty * 100) / 100), need: Math.max(0, Math.round((needQty - acc) * 100) / 100), inStock: boxes.length, noInfoQty: noInfoKeys.size }; // ㉖v82 left=本轮建议前还差多少（旧"还差"取need=建议后缺口，够数时显示0件易误导）
}
function reqView(r) {
  const items = (r.items || []).map(i => {
    const excl = new Set(((i.issued || []).map(x => String(typeof x === 'string' ? x : (x.c || '')).toUpperCase()).filter(Boolean)));
    // ㉖v79c 建议口径=【剩余需求】（原始需求−已发件数），发齐即空；旧版传原始需求致"发完还建议"超发隐患
    const _got = (i.issued || []).reduce((s, x) => s + (typeof x === 'string' ? 0 : (Number(x.q) || 0)), 0);
    return { ...i, suggest: pickSuggest(i.partNo, Math.max(0, (Number(i.qty) || 0) - _got), excl, agvMapOf(i)) };
  });
  return { ...r, items, statusText: REQ_STATUS_TEXT[r.status] || r.status };
}
// 接单即派：按建议框自动入队（与PDA一键叫车完全同口径：同托合并/已发已叫剔除/仅NB02货架框）；返回入队数
// ㉖v55 行级急料：该行标急 或 整单标急（旧版兼容）→ 队列项插队
function lineRush(r, it) { return !!(r && (r.rush || (it && it.rush === true))); }
function autoEnqueueOnAccept(r, byName, byId) {
  if (db.autoDispatch === false) return 0; // 全局开关（管理员可在设置关闭）
  db.agvQueue = db.agvQueue || [];
  let n = 0;
  for (const it of r.items || []) {
    const excl = new Set(((it.issued || []).map(x => String(typeof x === 'string' ? x : (x.c || '')).toUpperCase()).filter(Boolean)));
    const sg = pickSuggest(it.partNo, Number(it.qty) || 0, excl, agvMapOf(it));
    // ㉖v82 严重超发闸（事故：需1949自动派1840+2400两筐，发完一筐第二筐2400骑虎难下）：
    // 逐筐累计，从某筐起累计超发>需求本身→该筐及其后不自动派（红字留给人工拍板），前段照常派
    const _needQ = Number(it.qty) || 0; let _accQ = 0; const _keep = [];
    for (const bx of sg.boxes) {
      _accQ += Number(bx.q) || 0;
      if (_needQ > 0 && _accQ - _needQ > _needQ) { console.log(`[auto派] ${r.no} 行 ${it.partNo} 尾筐 ${bx.codes && bx.codes[0]} 起严重超发(累计${_accQ}/需${_needQ})，不自动派，留人工拍板`); break; }
      _keep.push(bx);
    }
    for (const bx of _keep) {
      const l = String(bx.l || '').toUpperCase();
      if (!l.startsWith('NB02-') || l.includes('-CK-')) continue; // 只派货架框；地面/已在站台不动
      const code = String((bx.codes && bx.codes[0]) || '').toUpperCase();
      if (!code) continue;
      if (bx.codes.some((c) => db.agvQueue.some((q) => String(q.code).toUpperCase() === String(c).toUpperCase() && !['完成', '取消', '失败'].includes(q.state)))) continue; // 同框已在队
      db.agvQueue.push({ code, fromLoc: l, palletType: String(bx.f || ''), stationManual: '', reqId: r.id, reqNo: r.no, by: byName, state: '排队', rush: lineRush(r, it), rushBy: lineRush(r, it) ? String(r.rushBy || r.byName || '') : '', auto: 1, station: '', at: Date.now(), updAt: Date.now() }); // v55 行级急料（靠前=加急；旧单无行标回退整单）㉖v61 急料带插队人
      it.agvCalled = (it.agvCalled || []).filter((e) => String(e.c).toUpperCase() !== code);
      it.agvCalled.push({ c: code, s: '', q: 1, by: byId, t: new Date().toISOString() }); // 登记叫车标记（建议区变🚗排队）
      n++;
    }
  }
  if (n) console.log(`[auto派] ${r.no} 接单即派入队 ${n} 框`);
  return n;
}
// ===== ㉖v52 备料排队看板：待接单+备料中的单按下单先后排队，供下单回执与看板接口共用 =====
// nowReq 传入则算"我排在几号"；items 全员可见（单号+下单人），mine 标记本人。ETA 用近 20 单实测备料均时×前方单数，无样本则 null（不臆造）。
function queueBoardOf(nowReq) {
  const min = (ms) => Math.max(0, Math.round(ms / 60000));
  const active = (db.requisitions || []).filter((x) => (x.status === 'pending' || x.status === 'accepted') && x.createdAt)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const myIdx = nowReq ? active.findIndex((x) => x.id === nowReq.id) : -1;
  const agvActive = (db.agvQueue || []).filter((q) => !['完成', '取消', '失败'].includes(q.state)).length;
  // 实测平均备料分钟：已备齐/签收且记了接单时刻的近期单（readyAt 数字毫秒、acceptedAt ISO 串，统一转 ms）
  const msOf = (v) => (typeof v === 'number' ? v : v ? Date.parse(v) : 0);
  const done = (db.requisitions || []).filter((x) => msOf(x.acceptedAt) && (msOf(x.readyAt) || msOf(x.doneAt)) && ['ready', 'done'].includes(x.status)).slice(-20);
  const prepMins = done.length ? Math.round(done.reduce((s, x) => { const a = msOf(x.acceptedAt), z = msOf(x.readyAt) || msOf(x.doneAt); return s + Math.max(0, (z - a) / 60000); }, 0) / done.length) : 0;
  const items = active.map((x, i) => ({
    id: x.id, no: x.no, byName: x.byName || '', status: x.status,
    acceptedBy: x.status === 'accepted' ? (x.acceptedBy || '') : '',
    acceptedMin: x.acceptedAt ? min(Date.now() - Date.parse(x.acceptedAt)) : null,
    waitMin: min(Date.now() - Date.parse(x.createdAt)),
    rush: !!x.rush, mine: nowReq ? x.id === nowReq.id : false, pos: i + 1,
    needDate: x.needDate || '',
  }));
  const ahead = items.slice(0, Math.max(0, myIdx));
  // 前方需处理单里仓管会逐个消化；正在备料=已接单的靠前项
  const servingNow = items.filter((x) => x.status === 'accepted');
  return {
    rank: myIdx >= 0 ? myIdx + 1 : null, total: active.length, agvActive,
    aheadCount: ahead.length, behind: items.slice(myIdx >= 0 ? myIdx + 1 : items.length),
    ahead, servingNow, items,
    // 预计等待=前方单逐个消化：待接单的按均时全算，备料中的只算剩余（均时-已备分钟）
    etaMin: (prepMins && myIdx > 0) ? ahead.reduce((s, x) => s + (x.status === 'accepted' ? Math.max(2, prepMins - (x.acceptedMin || 0)) : prepMins), 0) : null,
    prepAvgMin: prepMins || null,
  };
}
function issuedOf(i) { return (i.issued || []).map(x => typeof x === 'string' ? { c: x, q: 0, l: '' } : { c: String(x.c || ''), q: Number(x.q) || 0, l: String(x.l || '') }); }
function uniqCodes(arr) { return [...new Set(arr.map(s => String(s).toUpperCase()))]; }
// ㉖v94r 出库台账兜底补建（10/25 现场：6608582236/N26J190090 已转MES、账也销了，但出库台账无记录）：
// 根因=DT 出库单只由 PDA 客户端转单成功后推送，而 outboundPushNow 是 fire-and-forget（无重试、失败仅 debugPrint），
// 服务端 transfer 分支只写 seenOut 不建台账 → 推送一旦失败，该行出库记录永久缺失，且无人察觉（实测 75 行中缺 1 行）。
// 兜底：扫描所有 transferred 行，其已发标签若在整个出库台账中查无 → 服务器按行信息补建一条 SRV-DT 台账（幂等：补建后即查到，不再重建）。
function outboundLedgerFix() {
  try {
    const obCodes = new Set();
    for (const o of Object.values(db.outbound || {})) for (const i of o.items || []) { const c = String(i.barcode || '').toUpperCase(); if (c) obCodes.add(c); }
    const dict = db.itemDict || {};
    let fixed = 0;
    for (const r of db.requisitions || []) {
      for (const it of r.items || []) {
        if (it.transferred !== true) continue;
        const rows = issuedOf(it);
        if (!rows.length) continue;
        if (rows.some((e) => obCodes.has(String(e.c || '').toUpperCase()))) continue; // 已有任一条台账记录，视为已落库
        const items = rows.map((e) => {
          const c = String(e.c || '').toUpperCase();
          let fl = String(e.l || '');
          if (!fl) { const led = (db.ledger || []).find((x) => String(x.c || '').toUpperCase() === c); fl = String((led && led.l) || ''); }
          if (!fl) { const si = (db.seenIn || {})[c]; fl = String((si && si.l) || ''); }
          const nm = String((dict[String(it.partNo || '')] || {}).nm || '') || String(it.itemName || '');
          const isAgv = (it.agvCalled || []).some((x) => String(x.c || '').toUpperCase() === c);
          return { code: String(it.partNo || ''), mitemCode: '', name: nm, qty: Number(e.q) || 0, barcode: c, fromLoc: fl, move: isAgv ? 'AGV' : '人工', checked: false };
        });
        const d = new Date(Number(it.transferAt) || Date.now());
        const p2 = (n) => String(n).padStart(2, '0');
        const ts = '' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
        const no = 'SRV-DT' + ts + '-' + String(it.partNo || '').slice(-4);
        if (db.outbound[no]) continue;
        const tl = r.toLoc || {};
        const _so = (db.seenOut || {})[String(items[0].barcode || '').toUpperCase()] || {};
        db.outbound[no] = { orderNo: no, createdAt: Number(it.transferAt) || Number(_so.at) || Date.now(), toLoc: [tl.WAREHOUSE_NAME, tl.DISTRICT_NAME, tl.LOC_NAME].filter(Boolean).join('/') || '', operator: String(it.transferBy || _so.by || u_nameOf(r) || ''), status: 0, linkReqNo: String(r.no || ''), items, srvFix: 1, srvFixAt: Date.now() };
        for (const e of items) { obCodes.add(e.barcode); feedDict(e.code, e.name, '出库台账补建'); }
        fixed++;
        pushEvent('出库台账补建', String(it.partNo || ''), `${r.no} 行 ${it.partNo} 已转MES但出库台账缺失，服务器已补建 ${no}（${items.length} 框 ${items.reduce((s, x) => s + (Number(x.qty) || 0), 0)} 件）`, Date.now());
        console.log('[ob-fix] 补建出库台账 ' + no + ' ← ' + r.no + ' ' + it.partNo);
      }
    }
    if (fixed) { db.outboundAt = new Date().toISOString(); db.outboundCount = Object.keys(db.outbound).length; save(); }
    return fixed;
  } catch (e) { console.log('[ob-fix] 异常：', e.message); logErr('outboundLedgerFix', e); return 0; }
}
function u_nameOf(r) { const u = (db.users || []).find((x) => x.id === (r.by || '')); return u ? u.name : ''; }
setInterval(outboundLedgerFix, 10 * 60 * 1000).unref(); // 每10分钟兜底扫一遍（幂等）
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
// ㉖v80 ISO串→本地 'YYYY-MM-DD HH:mm'（打印页/看板直显用；旧版直接slice UTC串差8小时）
function localDT(s, len) { const d = new Date(s); if (isNaN(d.getTime())) return String(s || '').slice(0, len || 16).replace('T', ' '); const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + (len > 16 ? ':' + p(d.getSeconds()) : ''); }
// 领料单打印页（A4，含零件号/物料名/申请数/已发数 + 手写货位/标签空栏；复制零件号可选文本）
function renderReqPrint(r) {
  const time = localDT(r.createdAt);
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
      <td>${idx + 1}${i.rush ? ' <span style="color:#d32f2f;font-weight:bold">🔥</span>' : ''}</td>
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
  ${r.needDate ? `<div class="meta"><span>期望到货：<b>${esc(r.needDate)}</b></span></div>` : ''}
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
  for (const x of ledgerView()) { // ㉖ 批次按 MES 打印日期派生
    const k = boxKeyOf(x);
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(x);
  }
  const boxRows = [...g.values()].sort((a, b) => String(a[0].l).localeCompare(String(b[0].l)) || String(a[0].c).localeCompare(String(b[0].c)));
  const meta = `共 ${db.ledger.length} 个标签 · ${boxRows.length} 框 · ${new Set(db.ledger.map(x => x.l)).size} 个货位有货`;
  const info = db.ledgerAt ? `最后同步 ${esc(localDT(db.ledgerAt, 19))}（${esc(db.ledgerBy || '-')}，v${db.ledgerRev}）` : '尚未从 PDA 同步过';
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
  Promise.all([jg('/api/scanlog?limit=20000')
,jg('/api/outbound'),jg('/api/ledger?l=')]).then(function(a){
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
// ㉖v56 落盘合并：save() 只标脏，120ms 窗口内的多次变更合并为一次全量写（89 个调用点高频触发，同步写 3MB 会卡事件循环）
// 审计加固：_dirty 在写成功后才清（原实现先清后写，磁盘瞬时故障会静默丢掉重试触发）；失败 2 秒自动重试一次，仍败等下次 save 再试（全量快照写，成功一次即覆盖全部积压）
let _dirty = false, _saveT = null;
function flushSave() { if (_saveT) { clearTimeout(_saveT); _saveT = null; } if (!_dirty) return; saveDb(db); _dirty = false; }
function save() {
  _dirty = true;
  if (_saveT) return;
  _saveT = setTimeout(() => { _saveT = null; try { flushSave(); } catch (e) { logErr('saveDb', e); _saveT = setTimeout(() => { _saveT = null; try { flushSave(); } catch (_) {} }, 2000); } }, 120);
} // ---------------- 会话 ----------------
// ---- ㉖v56 登录设备管理：注册表/审计/信任/拉黑/踢下线 ----
function clientIp(req) { return String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, ''); }
function devAuditPush(act, dev, ip, u, det) { db.devAudit = db.devAudit || []; db.devAudit.push({ at: Date.now(), act, dev: dev || '', ip: ip || '', uid: (u && u.id) || '', name: (u && u.name) || '', det: String(det || '').slice(0, 120) }); if (db.devAudit.length > 2000) db.devAudit = db.devAudit.slice(-2000); }
function devReg(req, b, u) { // 登录时登记设备：id/类型/ip/UA/首末登录/绑定账号
  const dev = String((b && b.dev) || '').trim().slice(0, 60) || ('anon-' + clientFp(req));
  const ua = String((req.headers || {})['user-agent'] || '').slice(0, 120);
  const kind = (b && b.kind) === 'web' ? 'web' : (b && b.kind) === 'pda' ? 'pda' : (/Flutter|Dart/i.test(ua) ? 'pda' : 'web');
  const ip = clientIp(req);
  db.devices = db.devices || {};
  const d = db.devices[dev] || (db.devices[dev] = { id: dev, kind, ip, ua, firstAt: Date.now(), users: {}, trusted: false, blocked: false, note: '' });
  d.kind = kind; d.ip = ip; d.ua = ua; d.lastAt = Date.now(); d.users[u.id] = Date.now();
  devAuditPush('登录', dev, ip, u, kind);
  return d;
}
function devOnline(dev) { for (const t of Object.values(db.sessions || {})) if (t.dev === dev && Date.now() - (t.lastSeen || 0) < SESSION_TTL_MS) return true; return false; }
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
  if (s.fp && s.fp !== clientFp(req)) return { err: 401, msg: '登录环境已变化（设备或IP段），请重新登录' }; // ㉕F6 升级前旧会话无fp不受限
  const u = db.users.find(x => x.id === s.userId);
  if (!u) return { err: 401, msg: '账号不存在' };
  if (!u.enabled) { delete db.sessions[token]; save(); return { err: 403, code: 'disabled', msg: '账号已被管理员停用，请联系管理员' }; }
  return { token, user: u };
}
function requireAdmin(authed) { return authed.user.role === 'admin' ? null : { err: 403, msg: '需要管理员权限' }; }
// ㉔S1 账本行内容哈希（登记时刻+业务字段）：同步合并与网页修正共用
function ledgerHash(x) { return crypto.createHash('sha1').update([Number(x && x.t) || 0, (x && x.l) || '', (x && x.f) || '', (x && x.p) || '', (x && x.n) || '', Number(x && x.q) || 0, (x && x.b) || '', (x && x.mv) || '', (x && x.src) || '', (x && x.pid) || ''].join('\u0001'), 'utf8').digest('hex').slice(0, 32); }
// 写行时滚动保留最近3个历史( t,h )：未拉取设备的旧快照回填=命中历史→判无新到达，防覆盖他人/网页修正结果
function ledgerPut(cur, code, row, prev) { const hist = ((prev && prev.hist) || []).concat(prev ? [{ t: Number(prev.t) || 0, h: ledgerHash(prev) }] : []).slice(-3); cur.set(code, Object.assign({}, row, { hist })); }
// ---- ㉖ 批次口径（用户拍板）：以 MES 标签打印时间(DATETIME_CREATED)的日期为准，如 2026-10-13T08:56:55 → 2026-10-13 ----
// 打印时间缺失/不可解析时回退原 LOT_NO，绝不返回空（避免网页批次列变空白）。
function printLot(mk, fallback) { const s = String(mk || '').trim(); const p = (n) => String(n).padStart(2, '0'); const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/); if (m) return m[1] + '-' + p(+m[2]) + '-' + p(+m[3]); if (s) { const d = new Date(s); if (!isNaN(d.getTime())) return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); } return String(fallback || ''); }
// 标签号 → MES打印时间 映射（账本行不存打印时间，统一从采集流水取；带条数+时间戳失效，防无界增长）
let _metaMap = null, _metaKey = '';
// 标签号 → 采集流水元信息（MES打印时间 + 最新有效一条的零件号/物料名/数量）：
// 旧版 PDA 推的账本行零件字段可能为空——统一从流水回填
function scanMetaOf() { const key = (db.scanlogCount || 0) + '|' + (db.scanlogAt || ''); if (_metaMap && _metaKey === key) return _metaMap; const m = {}; for (const s of Object.values(db.scanlog || {})) { const c = String(s.code || '').toUpperCase(); if (!c) continue; const e = m[c] = m[c] || { mk: '', pn: '', nm: '', q: 0, ct: '', t: -1 }; if (!e.mk && s.mk) e.mk = String(s.mk); const t = Number(s.t) || 0; if (!s.cx && t >= e.t) { e.t = t; e.pn = String(s.pn || ''); e.nm = String(s.nm || ''); e.q = Number(s.q) || 0; e.ct = String(s.ct || ''); } } _metaMap = m; _metaKey = key; return m; }
// 账本只读视图（批次派生 + 空零件字段回填）：仅供查询出口/看板/导出/取货建议/零件档案使用；
// 绝不用于写路径——ledgerHash 依赖库内原值做增量同步仲裁，改派生值会触发全量重推。
function ledgerView() { const mm = scanMetaOf(); return (db.ledger || []).map((x) => { const mt = mm[String(x.c || '').toUpperCase()]; if (!mt) return x; const patch = {}; if (mt.mk) patch.b = printLot(mt.mk, x.b); if (!(x.p || '') && mt.pn) patch.p = mt.pn; if (!(x.n || '') && mt.nm) patch.n = mt.nm; if (!(Number(x.q) > 0) && mt.q) patch.q = mt.q; if (!(x.f || '') && mt.ct) patch.f = mt.ct; return Object.keys(patch).length ? Object.assign({}, x, patch) : x; }); }
// ㉖v52 容器类型兜底：账本行 f 为空（旧版 PDA/异常路径未记录）→ 从采集流水最新有效一条取 ct
function palletTypeOf(code) {
  const c = String(code || '').toUpperCase();
  const led = (db.ledger || []).find((x) => String(x.c || '').toUpperCase() === c);
  const f = led && String(led.f || '').trim();
  if (f) return f;
  const mt = scanMetaOf()[c];
  return mt && mt.ct ? String(mt.ct) : '';
}
// ---- ㉕A1 导出角色门禁（方案6.6）：D9活动流=仅管理员；D8领料台账/D10盘点=仓管+管理员；其余登录即可 ----
function expRoleOk(u, label) { label = String(label || ''); if (label === '活动流审计') return u.role === 'admin'; if (label === '领料台账' || label.indexOf('盘点结果') === 0) return u.role === 'warehouse' || u.role === 'admin'; return true; }
// ---- ㉕B1 ops活动流：关键操作全景留痕（谁/何时/动作/对象/详情），滚动5000条，供控制后台与D9审计导出 ----
function pushOps(u, act, obj, det) { try { db.ops = db.ops || []; const o = { t: Date.now(), by: u ? String(u.name || '-') : '-', role: u ? (u.role || '') : '', act, obj: String(obj || '').slice(0, 80), det: String(det || '').slice(0, 600) }; db.ops.push(o); if (db.ops.length > 5000) db.ops = db.ops.slice(-5000); opsAppendFile(o); } catch (_) {} }
// ---- ㉖活动流按天 JSONL（data/ops/ops-YYYY-MM-DD.jsonl，权威持久层；db.ops 仅内存滚窗加速）+ 每日摘要哈希断链防篡改 ----
const OPS_KEEP_DAYS = 180;
function opsDay(t) { const d = new Date(t == null ? Date.now() : t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function opsDir() { const p = path.join(DATA_DIR, 'ops'); try { fs.mkdirSync(p, { recursive: true }); } catch (_) {} return p; }
function opsFileOf(day) { return path.join(opsDir(), 'ops-' + day + '.jsonl'); }
function opsAppendFile(o) { try { fs.appendFileSync(opsFileOf(opsDay(o.t)), JSON.stringify(o) + '\n'); } catch (_) {} }
function opsLoadDays(n) { // 读近 n 天文件 + 内存，按 t|act|obj|by 去重
  const out = [], seen = new Set();
  for (let i = 0; i < n; i++) { const day = opsDay(Date.now() - i * 864e5); let txt = ''; try { txt = fs.readFileSync(opsFileOf(day), 'utf8'); } catch (_) {}
    for (const l of txt.split('\n')) { if (!l.trim()) continue; let o; try { o = JSON.parse(l); } catch (_) { continue; } const k = o.t + '|' + o.act + '|' + o.obj + '|' + o.by; if (!seen.has(k)) { seen.add(k); out.push(o); } } }
  for (const o of (db.ops || [])) { const k = o.t + '|' + o.act + '|' + o.obj + '|' + o.by; if (!seen.has(k)) { seen.add(k); out.push(o); } }
  return out;
}
function opsDigest(day) { // 当日断链摘要：prev链值+当日全部行 → sha256
  try {
    const dfp = path.join(opsDir(), 'digest-' + day + '.json');
    const rows = opsLoadDays(1).filter((o) => opsDay(o.t) === day);
    let prev = '';
    const pd = opsDay(Date.parse(day + 'T00:00:00') - 864e5);
    try { prev = String(JSON.parse(fs.readFileSync(path.join(opsDir(), 'digest-' + pd + '.json'), 'utf8')).sha || ''); } catch (_) {}
    const sha = crypto.createHash('sha256').update(prev + rows.map((o) => JSON.stringify(o)).join('\n'), 'utf8').digest('hex');
    const cur = { day, rows: rows.length, sha, prev };
    fs.writeFileSync(dfp + '.tmp', JSON.stringify(cur)); fs.renameSync(dfp + '.tmp', dfp);
    return cur;
  } catch (_) { return null; }
}
let _opsDigestDone = '';
function opsDigestTick() { // 每日常规：为昨天出摘要；顺带清理超180天的 ops/digest 文件
  try {
    const y = opsDay(Date.now() - 864e5);
    if (_opsDigestDone !== y) { _opsDigestDone = y; opsDigest(y);
      const cut = Date.now() - OPS_KEEP_DAYS * 864e5;
      for (const f of fs.readdirSync(opsDir())) { const m = /^(?:ops|digest)-(\d{4}-\d{2}-\d{2})/.exec(f); if (m && Date.parse(m[1] + 'T23:59:59') < cut) fs.unlinkSync(path.join(opsDir(), f)); }
    }
  } catch (_) {}
}
function opsMigrateToFiles() { // 首次升级：内存历史5000条落按天文件（幂等标记）
  try {
    if (db.opsMigrated || !(db.ops || []).length) return;
    for (const o of db.ops) opsAppendFile(o);
    db.opsMigrated = 1; console.log('[ops] 内存历史 ' + db.ops.length + ' 条已落按天文件');
  } catch (_) {}
}

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
function send(res, code, obj, extra) {
  const body = JSON.stringify(obj);
  const hs = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS' };
  if (extra) Object.assign(hs, extra);
  res.writeHead(code, hs);
  res.end(body);
}
// ㉔S3 页面鉴权：cookie（登录种）或 ?t=<会话token>；db.pageAuth=true 启用（默认关=PDA门户iframe兼容，出APK后开启）
function pageAuthOk(req, url) {
  if (db.pageAuth !== true) return true;
  const ck = String(req.headers.cookie || '').match(/(?:^|;\s*)hst_tok=([^;]+)/);
  const tok = ck ? decodeURIComponent(ck[1]) : String(url.searchParams.get('t') || '');
  const s = tok ? touchSession(tok) : null;
  return !!s;
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

    // ---- ㉒仓库管理控制台（单页应用；HTML公开，数据接口全部要token）----
    if (req.method === 'GET' && (p === '/console' || p === '/ui' || p === '/console/')) {
      try { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(fs.readFileSync(path.join(__dirname, 'public', 'console.html'))); }
      catch (_) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('console.html 缺失：请确认 server/public/ 目录随 server 一起部署'); }
      return;
    }

    // ---- 领料单打印页（局域网内公开，凭单号打开，浏览器 Ctrl+P 打印；㉔S3 pageAuth 开启后需登录态）----
    if (req.method === 'GET' && p === '/print/requisition') {
      if (!pageAuthOk(req, url)) { const tk = String(url.searchParams.get('t') || ''); res.writeHead(302, { Location: '/console' + (tk ? '?t=' + encodeURIComponent(tk) : '') }); res.end(); return; }
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
      const fpn = (url.searchParams.get('pn') || '').trim().toUpperCase();
      const fft = Number(url.searchParams.get('from')) || 0, ftt = Number(url.searchParams.get('to')) || 0;
      const lim = Math.min(20000, Math.max(1, Number(url.searchParams.get('limit')) || 2000));
      let arr = Object.entries(db.scanlog).map(([k, v]) => { v.k = k; return v; }).sort((a, x) => (x.t || 0) - (a.t || 0)); // ㉖⑯ 附带主键k供网页作废/恢复定位
      if (fc) arr = arr.filter(x => String(x.code).toUpperCase() === fc);
      if (fpn) arr = arr.filter(x => String(x.pn || '').toUpperCase() === fpn); // ㉖B7 零件号过滤
      if (fft || ftt) arr = arr.filter(x => (!fft || (x.t || 0) >= fft) && (!ftt || (x.t || 0) <= ftt)); // ㉖B7 时间窗
      // ㉖ 批次口径：按 MES 标签打印时间派生（浅拷贝返回，不回写 db.scanlog，保持库内原样）
      const _out = arr.slice(0, lim).map((x) => (x.mk ? Object.assign({}, x, { lot: printLot(x.mk, x.lot) }) : x));
      return send(res, 200, { ok: true, at: db.scanlogAt, total: db.scanlogCount, count: arr.length, items: _out });
    }
    if (req.method === 'GET' && p === '/api/outbound') {
      const fl = (url.searchParams.get('req') || '').trim().toUpperCase();
      let arr = Object.values(db.outbound).sort((a, x) => (x.createdAt || 0) - (a.createdAt || 0));
      if (fl) arr = arr.filter(x => String(x.linkReqNo || '').toUpperCase() === fl);
      const fq = (url.searchParams.get('q') || '').trim().toUpperCase();
      if (fq) arr = arr.filter(x => String(x.orderNo || '').toUpperCase().includes(fq) || String(x.linkReqNo || '').toUpperCase().includes(fq) || String(x.toLoc || '').toUpperCase().includes(fq) || String(x.operator || '').toUpperCase().includes(fq) || (x.items || []).some((i) => String(i.code || '').toUpperCase().includes(fq) || String(i.name || '').toUpperCase().includes(fq) || String(i.barcode || '').toUpperCase().includes(fq))); // ㉖B7 关键字过滤
      return send(res, 200, { ok: true, at: db.outboundAt, total: db.outboundCount, count: arr.length, items: arr.slice(0, 500) });
    }
    if (req.method === 'GET' && p === '/board/data') {
      if (!pageAuthOk(req, url)) { const tk = String(url.searchParams.get('t') || ''); res.writeHead(302, { Location: '/console' + (tk ? '?t=' + encodeURIComponent(tk) : '') }); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderDataBoard());
      return;
    }

    // ---- 货位账本：公开查询（局域网任意设备；?c=标签 / ?l=货位 前缀过滤 / ?fz=标签·货位·零件号·物料 任一模糊，无参数=全量+概要）----
    if (req.method === 'GET' && p === '/api/ledger') {
      const fc = (url.searchParams.get('c') || '').trim().toUpperCase();
      const fl = (url.searchParams.get('l') || '').trim().toUpperCase();
      const fz = (url.searchParams.get('fz') || '').trim().toUpperCase();
      let list = ledgerView(); // ㉖ 统一视图：批次派生 + 旧版PDA推的空零件字段从流水回填（零件号搜索因此能命中回填行）
      if (fz) list = list.filter(x => String(x.c).toUpperCase().includes(fz) || String(x.l).toUpperCase().includes(fz) || String(x.p || '').toUpperCase().includes(fz) || String(x.n || '').toUpperCase().includes(fz));
      if (fc) list = list.filter(x => String(x.c).toUpperCase().startsWith(fc));
      if (fl) list = list.filter(x => String(x.l).toUpperCase().startsWith(fl));
      return send(res, 200, { ok: true, rev: db.ledgerRev, at: db.ledgerAt, by: db.ledgerBy, total: db.ledger.length, count: list.length, epoch: db.ledgerEpoch || '', items: list, tomb: db.ledgerTomb || [] }); // ㉖v69 世代标记：PDA旧缓存凭此识别清理
    }

    // ---- 货位账本：电脑查询页（表格地图式：按货位排序，同位多标签并排显示）----
    if (req.method === 'GET' && (p === '/board/ledger' || p === '/ledger')) {
      if (!pageAuthOk(req, url)) { const tk = String(url.searchParams.get('t') || ''); res.writeHead(302, { Location: '/console' + (tk ? '?t=' + encodeURIComponent(tk) : '') }); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderLedgerBoard());
      return;
    }

    // ---- 领料工作台（电脑端公开：待办列表 + 逐张/批量打印）----
    if (req.method === 'GET' && (p === '/board/requisitions' || p === '/board')) {
      if (!pageAuthOk(req, url)) { const tk = String(url.searchParams.get('t') || ''); res.writeHead(302, { Location: '/console' + (tk ? '?t=' + encodeURIComponent(tk) : '') }); res.end(); return; }
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
      if (!u) { failRecord(username); return send(res, 401, { ok: false, msg: '账号或密码错误' }); }
      if (!u.salt || !u.passHash) return send(res, 403, { ok: false, code: 'pwBroken', msg: '该账号密码数据异常，请联系管理员在「用户管理」重置密码' }); // ㉖v59 无盐账号防御：旧数据/异常写入致salt缺失，此前hashPw(undefined)抛500
      if (hashPw(password, u.salt) !== u.passHash) { failRecord(username); return send(res, 401, { ok: false, msg: '账号或密码错误' }); }
      if (!u.enabled) return send(res, 403, { ok: false, code: 'disabled', msg: '账号已被停用，请联系管理员' });
      { const _dv = String(b.dev || '').trim().slice(0, 60); const _drec = _dv && (db.devices || {})[_dv]; if (_drec && _drec.blocked) { devAuditPush('拒绝(拉黑设备)', _dv, clientIp(req), u, ''); return send(res, 403, { ok: false, code: 'devBlocked', msg: '该设备已被管理员拉黑，禁止登录' }); } }
      const token = newToken();
      const _devRec = devReg(req, b, u); db.sessions[token] = { userId: u.id, createdAt: Date.now(), lastSeen: Date.now(), fp: clientFp(req), dev: _devRec.id }; // ㉕F6 token绑设备指纹(IP前两段+UA) ㉖v56 +设备id
      save();
      console.log(`[login] ${u.username}(${ROLE_NAMES[u.role]}) 登录成功`);
      pushOps(u,'登录','',u.username);
      return send(res, 200, { ok: true, token, expiresAt: Date.now() + SESSION_TTL_MS, user: safeUser(u), features: db.features[u.role] || {}, prefs: prefsFor(u.id) }, { 'Set-Cookie': `hst_tok=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}` });
    }

    // ---- G1 健康端点：无鉴权，供PDA失联检测/运维探测/网页健康分 ----
    if (req.method === 'GET' && p === '/api/health') {
      return send(res, 200, { ok: true, uptime: Math.round(process.uptime()), serverTime: new Date().toISOString(), memMB: Math.round(process.memoryUsage().rss / 1048576), netmap: { lands: Object.keys(NetMap.lands).length, edges: Object.keys(NetMap.adj).length, ready: NetMap.ready(), builtAgo: NetMap.builtAt ? Math.round((Date.now() - NetMap.builtAt) / 1000) : -1 }, counts: { reqs: (db.requisitions || []).length, scanlog: Object.keys(db.scanlog || {}).length, outbound: Object.keys(db.outbound || {}).length, queue: (db.agvQueue || []).filter((q) => q.state === '排队').length, sessions: Object.keys(db.sessions || {}).length } });
    }

    // ---- ㉔SSE实时流（EventSource无法带header：token走query，会话校验后长挂） ----
    if (req.method === 'GET' && p === '/api/sse') {
      const qTok = String(url.searchParams.get('token') || '');
      const ss = db.sessions[qTok];
      if (!ss || Date.now() - ss.lastSeen > SESSION_TTL_MS) return send(res, 401, { ok: false, msg: '未登录或会话过期' });
      if (ss.fp && ss.fp !== clientFp(req)) return send(res, 401, { ok: false, msg: '登录环境已变化，请重新登录' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
      res.write('retry: 5000\n\n');
      res.write('data: ' + JSON.stringify({ t: 'hello', at: new Date().toISOString() }) + '\n\n');
      sseSet.add(res);
      req.on('close', () => sseSet.delete(res));
      return;
    }

    // ---- 以下均需登录 ----
    if (p.startsWith('/api/')) {
      const a = auth(req);
      if (a.err) return send(res, a.err, { ok: false, code: a.code, msg: a.msg });
      const u = a.user;

      if (req.method === 'POST' && p === '/api/logout') { delete db.sessions[a.token]; save(); return send(res, 200, { ok: true }, { 'Set-Cookie': 'hst_tok=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/' }); }

      // 心跳/取当前身份+功能开关（App 前台恢复与定时轮询调用；停用即时生效靠它）
      if (req.method === 'GET' && p === '/api/me') {
        return send(res, 200, { ok: true, user: safeUser(u), features: db.features[u.role] || {}, prefs: prefsFor(u.id), uiRefreshSec: P().uiRefreshSec, serverTime: new Date().toISOString() });
      }

      // ㉖v59 个人中心：我的登录设备/会话（本人可见可踢，不含 admin 拉黑等管理动作）
      if (req.method === 'GET' && p === '/api/me/devices') {
        const devs = db.devices || {};
        const mine = [];
        for (const [tok, s] of Object.entries(db.sessions || {})) {
          if (s.userId !== u.id) continue;
          const d = devs[s.dev] || {};
          mine.push({ dev: s.dev || '', kind: d.kind || 'web', ip: d.ip || '', ua: d.ua || '', createdAt: s.createdAt || 0, lastSeen: s.lastSeen || 0, current: tok === a.token });
        }
        mine.sort((x, y) => (y.current ? 1 : 0) - (x.current ? 1 : 0) || (y.lastSeen || 0) - (x.lastSeen || 0));
        return send(res, 200, { ok: true, sessions: mine, mustChangePw: !!u.mustChangePw });
      }
      if (req.method === 'POST' && p === '/api/me/devices/kick') {
        const b = await readBody(req);
        const dev = String(b.dev || '').trim();
        if (!dev) return send(res, 400, { ok: false, msg: '缺少 dev' });
        let n = 0;
        for (const [tok, s] of Object.entries(db.sessions || {})) { if (s.userId === u.id && s.dev === dev && tok !== a.token) { delete db.sessions[tok]; n++; } }
        if (n) { save(); devAuditPush('自踢会话', dev, clientIp(req), u, n + '个'); }
        return send(res, 200, { ok: true, kicked: n });
      }
      // 修改自己的密码
      if (req.method === 'POST' && p === '/api/change_password') {
        const b = await readBody(req);
        if (!u.salt || !u.passHash) return send(res, 403, { ok: false, code: 'pwBroken', msg: '该账号密码数据异常，请联系管理员在「用户管理」重置密码' }); // ㉖v59 无盐防御
        if (hashPw(String(b.oldPassword || ''), u.salt) !== u.passHash) return send(res, 400, { ok: false, msg: '原密码错误' });
        if (String(b.newPassword || '').length < 6) return send(res, 400, { ok: false, msg: '新密码至少6位' });
        u.salt = crypto.randomBytes(16).toString('hex');
        u.passHash = hashPw(b.newPassword, u.salt);
        u.mustChangePw = false;
        pushOps(u, '改自己密码', u.username, '');
        save(); return send(res, 200, { ok: true, msg: '密码已修改' });
      }
      // ㉖v67 个人中心：改自己的姓名（验原密码防手持机被临时拿去改资料；2-20字去控制符）
      if (req.method === 'POST' && p === '/api/change_name') {
        const b = await readBody(req);
        if (!u.salt || !u.passHash) return send(res, 403, { ok: false, code: 'pwBroken', msg: '该账号密码数据异常，请联系管理员重置密码' }); // ㉖v59 无盐防御同款
        if (hashPw(String(b.password || ''), u.salt) !== u.passHash) return send(res, 400, { ok: false, msg: '原密码错误' });
        const name = String(b.name || '').replace(/\s+/g, ' ').trim();
        if (name.length < 2 || name.length > 20) return send(res, 400, { ok: false, msg: '姓名需2-20字' });
        const old = u.name; u.name = name;
        pushOps(u, '改自己姓名', u.username, old + '→' + name);
        save(); return send(res, 200, { ok: true, msg: '姓名已修改', user: safeUser(u) });
      }

      // ================= 货位账本同步（PDA 全量推送；仓管/管理员可写，读取走公开接口） =================
      if (req.method === 'POST' && p === '/api/ledger/sync') {
        if (u.role !== 'warehouse' && u.role !== 'admin') return send(res, 403, { ok: false, msg: '仅仓管员/管理员可同步货位账本' });
        const b = await readBody(req);
        const raw = Array.isArray(b.items) ? b.items : [];
        if (!Array.isArray(b.del)) b.del = [];
        if (!raw.length && !b.del.length) return send(res, 400, { ok: false, msg: 'items/del 均为空，已拒绝（防止误清空白账本）' });
        if (raw.length > 20000) return send(res, 400, { ok: false, msg: '条目超过2万，疑似异常' });
        // ㉖v69 世代闸：账本整表替换（数据迁移）后，新世代PDA拿旧缓存推送必须先去拉取对齐（拉取侧自动清旧缓存）
        // ㉖v82c 回审修正：只拦【声称有世代但不匹配】的新PDA；完全不带世代的旧PDA(v75及以前)放行给下方 _staleCut 切割线处理——
        // 旧版无 epochStale 自愈逻辑，此前一刀切拒绝会把未升级设备的新登记永久挡在门外（与 _staleCut 设计意图矛盾）
        const _epSent = String(b.epoch || '').trim();
        if (db.ledgerEpoch && _epSent && _epSent !== db.ledgerEpoch) return send(res, 200, { ok: false, code: 'epochStale', epoch: db.ledgerEpoch, msg: '本机账本为旧世代（服务器账本已整表替换），请先拉取对齐后再推送' });
        const seen = new Set(); const clean = [];
        // ㉖v80 拼接码防线：PDA 重启前缓存的 Excel 拼接行（"A; B"）会随推送复活，与服务器已拆单码行双计（实测 D-01-2F 双计315件）。
        // 到达即拆成单码行（q均分同迁移口径，t/内容一致→指纹闸自然判"未变"幂等跳过）；已出库码由墓碑闸拦截
        const _pushClean = (it) => {
          const c0 = String((it && it.c) || '').trim().toUpperCase();
          if (!c0.includes(';') && !c0.includes('；')) { clean.push(it); return; }
          const cs = c0.split(/[;；]/).map((s) => s.trim()).filter(Boolean);
          if (cs.length < 2) { clean.push(Object.assign({}, it, { c: cs[0] || '' })); return; }
          const tot = Number(it && it.q) || 0; const per = Math.floor(tot / cs.length); let rem = tot - per * cs.length;
          for (const cc of cs) { const one = Object.assign({}, it, { c: cc, q: per + (rem > 0 ? 1 : 0), _split: 1 }); if (rem > 0) rem--; clean.push(one); }
        };
        for (const it0 of raw) {
          // ㉖v95b 乱码清洗补齐 f/p/b/src（旧版只洗 n/mv，容器类型"托<乱码>"混进账本与合并diff留痕）
          const _cw = (s0, cap) => String(s0 == null ? '' : s0).replace(/[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, cap);
          const it = (() => { const c = String((it0 && it0.c) || '').trim().toUpperCase(); const l = String((it0 && it0.l) || '').trim().toUpperCase(); if (!c || !l) return null; if (seen.has(c)) return null; seen.add(c); return { c, l, f: ctNorm(it0 && it0.f, db.containerTypes), t: Number(it0 && it0.t) || 0, p: _cw(it0 && it0.p, 40).toUpperCase(), n: _cw(it0 && it0.n, 80), q: Number(it0 && it0.q) || 0, b: _cw(it0 && it0.b, 40), pid: _cw(it0 && it0.pid, 40), mv: (() => { const s0 = _cw(it0 && it0.mv, 20); if (!s0) return ''; if (/AGV/i.test(s0)) return 'AGV'; if (s0.includes('记')) return '登记'; if (s0.includes('人工')) return '人工'; return s0.length <= 4 ? s0 : '人工'; })(), src: _cw(it0 && it0.src, 40) }; })(); // ㉓乱码清洗+㉖v61b mv归一+㉖v95b f归一（对账包搬运方式列数据源）
          if (it) _pushClean(it);
        }
        // 增量合并：按标签号 upsert + 墓碑删除，多PDA互不覆盖
        // ㉔S1 时间戳双轨（F2加固）：指纹=登记时刻+内容（含t）；"无新到达"=与本机上次推送一致(含已删行的旧副本)
        // 或与服务器现值完全一致(首拉旧副本重放)——一律不动服务器；真改动(内容/t变)按到达时刻rec裁决，墓碑按t拦截早于它的重登
        const rec0 = Date.now(); const _diffs = []; const _seen = (db.seenIn = db.seenIn || {}); // ㉖方案4.2：服务器diff自动留痕（谁把X从A改到B，字段级前值→后值）
        // ㉖v69 旧版PDA兼容闸：不带世代的推送=未升级设备；迁移时刻之前的旧缓存行一律丢弃（防旧账本回灌/撞改新行），迁移后的新登记照常受理
        const _staleCut = (db.ledgerEpoch && String(b.epoch || '').trim() !== db.ledgerEpoch) ? (Number(db.ledgerEpochAt) || 0) : 0; let _staleDrop = 0;
        const _preCounts = partBoxCounts(); // ⑮合并前在架快照（断料检测基线）
        const cur = new Map(db.ledger.map(x => [String(x.c).toUpperCase(), x]));
        const tomb = new Map((db.ledgerTomb || []).map(x => [String(x.c).toUpperCase(), { t: Number(x.t) || 0, rec: Number(x.rec) || 0 }]));
        const histAll = (db.tombHist = db.tombHist || {});
        const seenNew = new Set(); // 本次合并真正新增上账的标签（急货入库提醒用）
        const dels = Array.isArray(b.del) ? b.del : [];
        const _fpAll = (db.syncFp = db.syncFp || {}); const _fpOld = _fpAll[u.id] || {}; const _fpNew = {};
        const _hash = ledgerHash;
        let added = 0, updated = 0, skipped = 0, kept = 0, delApplied = 0, delSkipped = 0, locConflict = 0; const rejected = []; // ⑲被更新的服务器数据压回的标签（冲突提示用）
        pushLoop: for (const it of clean) {
          const key = it.c;
          const old = cur.get(key);
          const tm = tomb.get(key);
          const tombT = tm ? tm.t : 0;
          const h = _hash(it);
          if (_staleCut && it.t > 0 && it.t < _staleCut) { _staleDrop++; skipped++; continue; } // ㉖v69 旧世代切割：迁移前旧缓存行丢弃
          // 无新到达闸：①与本机上次视图一致（未来时钟的旧副本重放也在这挡死）②与服务器现值逐字段一致（首拉后原样重放）
          // ③命中该行服务器历史值（本机从未推过该行的旧快照回填——PDA真改动必更新t，旧( t,h )组合只可能是过期副本）
          if (_fpOld[key] === h || (old && _hash(old) === h) || (old && (old.hist || []).some((e) => e.t === (Number(it.t) || 0) && e.h === h))) { _fpNew[key] = h; kept++; continue; }
          // ㉖v82 墓碑拒绝【记录指纹】：同一过期旧行下次推送命中"无新到达"闸静默 kept，不再反复进 rejected 弹窗（实测7标签死循环弹）；
          // 若 PDA 真的重新登记该框（t 变新晚于墓碑）→ 指纹不同且过墓碑闸 → 正常复活，不误伤真重登
          // ㉖v82 拼接拆出行(_split)命中"已出库"墓碑是必然（这些码本就出了），直接静默——旧版进rejected致"货位登记冲突"永远循环（幽灵行留PDA缓存每推必弹），实为误报非真冲突
          if (tombT && it.t > 0 && it.t < tombT) { skipped++; _fpNew[key] = h; if (!it._split) rejected.push(key); continue; } // 早于墓碑的真改动重登：作废（首次仍提示，二次起静默）
          if (!_fpOld[key] && !Object.keys(_fpOld).length && old && it.t > 0 && Number(old.t) > it.t) { skipped++; rejected.push(key); continue; } // 设备首推无指纹档案：保守回退旧规则（t更旧者拒），防服务重启窗口倒退
          _fpNew[key] = h; // 本轮该设备视图留档
          // ㉖ 货位互斥闸：同一货位不允许被不同框同时占用（多PDA并发登记、过期副本回填都会撞位）；同框兄弟码（同托号）豁免
          if (it.l) {
            const _bk = boxKeyOf(it);
            for (const [oc, orow] of cur) {
              if (oc === key || String(orow.l || '').toUpperCase() !== it.l) continue;
              // 同框豁免：框键一致，或同零件号（与库存"同货位+同零件号=同框"口径一致；一框先无托号后补托号时两键不同但确属同框）
              if (boxKeyOf(orow) === _bk || (it.p && String(orow.p || '').toUpperCase() === it.p)) continue;
              rejected.push(key + '（目标货位 ' + it.l + ' 已被框 ' + oc + ' 占用）'); skipped++; locConflict++;
              delete _fpNew[key]; // 不记指纹：下次推送仍会再撞再提示，绝不静默吞掉
              _diffs.push(key + ' 货位冲突(' + it.l + '=' + oc + ')');
              continue pushLoop;
            }
          }
          if (!old) { _seen[key] = { by: u.name, t: rec0, l: it.l, p: it.p || '' }; } // ㉖ 首次入账登记，永久防重
          if (old) { // ㉖⑱ 多机字段保护：本机无该框采集流水时 mv 退化为默认"登记"、src/pid 缺失，不得抹掉别机写入的真值（"数据被覆盖"根因之一）
            const _mvIn = String(it.mv || ''), _mvOld = String(old.mv || '');
            if ((!_mvIn || _mvIn === '登记') && _mvOld && _mvOld !== '登记') it.mv = _mvOld;
            if (!it.src && old.src) it.src = old.src;
            if (!it.pid && old.pid) it.pid = old.pid;
            if (!it.p && old.p) it.p = old.p; if (!it.n && old.n) it.n = old.n; if (!it.b && old.b) it.b = old.b; if (!it.q && old.q) it.q = old.q; if (!it.f && old.f) it.f = old.f;
          }
          if (old) { updated++; const fl = []; for (const k of ['l', 'p', 'q', 'b', 'f', 'mv']) { const av = String(old[k] == null ? '' : old[k]), bv = String(it[k] == null ? '' : it[k]); if (av !== bv) fl.push(k + ':' + (av || '∅') + '→' + (bv || '∅')); } if (fl.length) _diffs.push(it.c + ' ' + fl.join(' ')); if (String(old.l) !== String(it.l)) _diffs.length === 0 && _diffs.push(it.c + ' l:' + old.l + '→' + it.l); } else { added++; seenNew.add(key); _diffs.push(it.c + ' 入账@' + it.l + (it.p ? '(' + it.p + ')' : '')); }
          ledgerPut(cur, key, { ...it, by: u.name, rec: rec0 }, old);
          if (tombT) tomb.delete(key); // 新到达=重新登记，复活
        }
        db.syncFp[u.id] = Object.assign({}, _fpOld, _fpNew); // 合并保留：部分推送不清掉未含行的指纹
        for (const d of dels) {
          const c = String((d && d.c) || '').trim().toUpperCase();
          const t = Number(d && d.t) || 0;
          if (!c || !t) continue;
          const old = cur.get(c);
          const tm = tomb.get(c);
          // ㉖v69c 世代墓碑闸：早于本次账本整表替换盖章时刻的删除，对现仍在架的行一律拒绝——
          // 旧版PDA(无世代逻辑)本地缓存的测试期墓碑会随推送反复回灌，不拦截则导入的真货被"复活删除"再吃掉
          if (old && db.ledgerEpochAt && t < db.ledgerEpochAt) { delSkipped++; _diffs.push(c + ' 拒绝过期墓碑(早于迁移盖章)'); continue; }
          const hist = histAll[c];
          if (hist && hist.t === t && old && (Number(old.rec) || 0) >= hist.rec && (Number(old.t) || 0) >= t) { delSkipped++; continue; } // 删除后又被别机重登：旧墓碑重放不二次删除
          const base = Math.max(tm ? tm.t : 0, old ? (Number(old.rec) || Number(old.t) || 0) : 0);
          if (!tm && (!old || t > base)) { cur.delete(c); tomb.set(c, { t, rec: rec0 }); if (!hist || hist.t !== t) histAll[c] = { t, rec: rec0 }; delApplied++; _diffs.push(c + ' 消位' + (old ? '(原' + old.l + ')' : '')); } else if (!tm) delSkipped++; // 别台后续又登记→删除作废
          else { tomb.set(c, { t: tm.t, rec: tm.rec }); delSkipped++; }
        }
        if (!cur.size && !tomb.size && !dels.length) return send(res, 400, { ok: false, msg: '无有效条目（需 c=标签 且 l=货位）' });
        db.ledger = [...cur.values()];
        db.ledgerTomb = [...tomb.entries()].map(([c, v]) => ({ c, t: v.t, rec: v.rec })).sort((a, b2) => b2.t - a.t).slice(0, 20000);
        if (db.locReserve) { for (const l of Object.keys(db.locReserve)) { if (cur.has(String(db.locReserve[l].code || '').toUpperCase()) || rec0 - (Number(db.locReserve[l].at) || 0) > RES_TTL_MS) delete db.locReserve[l]; } } // ㉖v54 标签落账(任意位)或预占过期→释放
        db.ledgerRev = (db.ledgerRev || 0) + 1;
        db.ledgerAt = new Date().toISOString();
        db.ledgerBy = u.name;
        save();
        console.log(`[ledger] ${u.name} 合并：+${added} 改${updated} 删${delApplied} 未变${kept} 忽略${skipped + delSkipped} → v${db.ledgerRev}（共 ${db.ledger.length} 条）`);
        pushOps(u,'账本合并','v'+db.ledgerRev,'+'+added+' 改'+updated+' 删'+delApplied+' 挡回'+(kept+skipped+delSkipped));
        stockWatchScan(_preCounts, u.name); // ⑮预约到料+断料预警
        // ===== ③ 急货入库提醒：本次新上账零件命中待处理领料单 → 通知下单人与全体仓管 =====
        try {
          if (added > 0) {
            const newParts = new Set();
            for (const it of clean) { if (seenNew.has(it.c) && it.p) newParts.add(String(it.p).toUpperCase()); }
            if (newParts.size) {
              const doneK = new Set();
              for (const r of db.requisitions || []) {
                if (!['pending', 'accepted'].includes(r.status)) continue;
                for (const it of r.items || []) {
                  const pn = String(it.partNo || '').toUpperCase();
                  if (!pn || !newParts.has(pn)) continue;
                  const k = r.id + '|' + pn; if (doneK.has(k)) continue; doneK.add(k);
                  const msg = `📦 急货入库提醒：领料单 ${r.no}（${r.byName}）所缺零件 ${pn} 刚有货上账（${u.name} 登记），可安排领用`;
                  notify(r.by, 'req_new', msg, r.id);
                  db.users.filter((x) => (x.role === 'warehouse' || x.role === 'admin') && x.enabled).forEach((x) => notify(x.id, 'req_new', msg, r.id));
                  console.log('[urgent-in] ' + msg);
                }
              }
            }
          }
        } catch (e) { console.log('[urgent-in] 异常：', e.message); }
        // ㉖diff 汇总进活动流：单次合并一条（样例40条+计数，防刷爆滚窗）
        try { pushOps(u, '账本合并diff', 'v' + db.ledgerRev, `+${added} 改${updated} 删${delApplied} 未变${kept} 压回${skipped}${locConflict ? ' 货位冲突' + locConflict : ''}${rejected.length ? ' 拒回' + rejected.length : ''}` + (_diffs.length ? ' | ' + _diffs.slice(0, 40).join(' ; ') + (_diffs.length > 40 ? ` ; …共${_diffs.length}项` : '') : '')); save(); } catch (_) {}
        return send(res, 200, { ok: true, rev: db.ledgerRev, count: db.ledger.length, added, updated, kept, skipped, delApplied, delSkipped, locConflict, rejected: rejected.slice(0, 50) });
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
          snap[k] = { code: String(it.code || '').toUpperCase(), wt: Number(it.wt) || 0, st: String(it.st || ''), gl: String(it.gl || ''), ct: String(it.ct || ''), rm: String(it.rm || '').slice(0, 120), batch: String(it.batch || ''), cx: !!it.cx, t: Number(it.t) || 0, pn: String(it.pn || ''), q: Number(it.q) || 0, mk: String(it.mk || ''), op: String(it.op || '').slice(0, 40), nm: String(it.nm || '').replace(/\uFFFD/g, '').slice(0, 80), lot: String(it.lot || '').slice(0, 40), pid: String(it.pid || '') }; // ㉓乱码清洗
        }
        if (!Object.keys(snap).length) return send(res, 400, { ok: false, msg: '无有效条目（需 k 主键）' });
        db.scanlog = Object.assign(db.scanlog || {}, snap); // 增量合并：只覆盖本次推送的键，别台设备的流水保留
        // v85b gl粗码实时对齐（v84防降级超集）：推送gl非完整格位时——①库里已是完整格位→保留库内值（防旧缓存打回）
        // ②库内也没有但账本同码有完整格位（网页补录过）→ 直接升级，PDA再推粗码也不会让⚠未登记复现
        const _isFullGl = (g) => /^NB\d{2}-[A-Z]-\d+-/.test(String(g || ''));
        let _glIdx = null;
        for (const [k, v] of Object.entries(snap)) {
          if (_isFullGl(v.gl)) continue;
          const old = db.scanlog && db.scanlog[k];
          if (old && _isFullGl(old.gl)) { v.gl = old.gl; db.scanlog[k] = v; continue; }
          if (!_glIdx) { _glIdx = {}; for (const x of db.ledger || []) { const l = String(x.l || ''); if (_isFullGl(l)) _glIdx[String(x.c || '').toUpperCase()] = l.toUpperCase(); } }
          const f = _glIdx[String(v.code || '').toUpperCase()];
          if (f) { v.gl = f; db.scanlog[k] = v; }
        }
        for (const s of Object.values(snap)) feedDict(s.pn, s.nm, '采集流水'); // ㉒G7 字典沉淀
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
      // ---- ㉖⑰ 统一搬运任务端点：PDA 入库/出库叫车全部经服务器入队再下发 ----
      // 根治：PDA 直连 WMAS 建任务时服务器队列/流水线/taskOf 三处全盲（②③问题）；入队后对账循环按 WMAS 状态推进，全链路可见
      if (req.method === 'POST' && p === '/api/agv/carry') {
        if (!canFeature(u, 'agv_control')) return send(res, 403, { ok: false, msg: '当前角色未开通「AGV车辆控制」权限' });
        const b = await readBody(req);
        const from = String(b.from || '').trim().toUpperCase(), to = String(b.to || '').trim().toUpperCase();
        const code = String(b.code || '').trim().toUpperCase(), palletType = String(b.palletType || '').trim().toUpperCase();
        const dir = b.dir === 'out' ? 'out' : 'in'; // in=站台→货架(入库) out=货架→站台(出库)
        if (!from || !to) return send(res, 400, { ok: false, msg: '缺少 from/to' });
        db.agvQueue = db.agvQueue || [];
        // ㉖ 统一搬运补两道基石校验：carry 绕过了 queue 端点校验，此前可重复叫车 / 叫走检验中的框
        if (code) {
          if (db.agvQueue.some((q) => String(q.code).toUpperCase() === code && ['排队', '下发中', '已下发', '到站'].includes(q.state))) return send(res, 200, { ok: false, msg: '框 ' + code + ' 已有在途搬运任务，请勿重复叫车' });
          if (dir === 'out' && (db.inspects || []).some((q) => String(q.code).toUpperCase() === code && ['waitOut', 'toStation', 'atStation', 'waitBack', 'returning'].includes(q.state))) return send(res, 200, { ok: false, msg: '框 ' + code + ' 正在检验中，禁止出库叫车（请先完成检验归位）' });
        }
        // 防重：同容器/同标签在途、同站台60秒内刚被叫车——与 claim 同口径
        // ㉖v79c 入库指定货架位占用校验（服务器权威）：该 NB02 格位账本已有别的框→拒绝叫车
        // （dispatchOne 对非CK终点不做占用判断，旧版PDA输入框残留会把车叫到占用位/拿错框码）
        if (dir === 'in' && code && /^NB02-/.test(to) && !/-CK-/.test(to)) {
          const _rows = (db.ledger || []).filter((x) => String(x.l || '').toUpperCase() === to);
          if (_rows.length && !_rows.some((x) => String(x.c || '').toUpperCase() === code)) return send(res, 200, { ok: false, msg: '货架位 ' + to + ' 已被框 ' + _rows.map((x) => x.c).join('/') + ' 占用，不能叫车到占用位——请「选位」重选空格位' });
        }
        // ㉖v79c 容器号不再拦叫车（用户拍板）：现场同款铁框物理容器号只有一个，WMAS手动下任务也不按容器拦；
        // 旧版"容器在途/容器15分钟防抖"两道闸把第二单合法叫车挡死（物料员"再次扫码叫车就不行"根因）。
        // 防重复叉取只认框标签号（上方 code 在途闸）；同框兄弟码由 agv 端点登记闸另行防护。
        // ㉖⑲ 入队 + 立即下发：复用调度器同一 dispatchOne（遵守 dry/live、manualOnly 不改派、纳入统一状态机与批量/优先级治理）
        const live = (db.agvDispatchMode || 'dry') === 'live';
        const item = { id: newId('cq'), code: code || String(b.container || '').toUpperCase(), fromLoc: from, stationManual: to, station: '', palletType, type: dir === 'in' ? 'inbound' : 'outbound', manualOnly: true, container: b.container ? String(b.container).trim().toUpperCase() : '', ref: (dir === 'in' ? 'RK-' : 'CK-') + (code || ''), by: u.name, state: '排队', at: Date.now(), updAt: Date.now() };
        // 把队列其他活跃项已占用的目的地作为 assigned 传入：并发 carry 送同一台时后者排队等待，杜绝双发同台
        const _taken = db.agvQueue.filter((q) => q !== item && ['排队', '下发中', '已下发', '到站'].includes(q.state) && (q.station || q.stationManual)).map((q) => q.station || q.stationManual);
        await dispatchOne(item, Date.now(), [], _taken, live); // ㉖⑲ 先局部下发（不进全局队列，与定时器轮次零并发窗口），再按结果入队
        if (item.state === '失败') return send(res, 200, { ok: false, msg: item.err || '下发失败' }); // 失败不入队，PDA 可直接重试
        db.agvQueue.push(item); // 已下发→纳入对账；排队(dry/暂无台)→纳入队列控制台，切 live 后自动下发
        if (item.state === '已下发' && item.taskNo) (db.agvClaims = db.agvClaims || {})['carry|' + String(item.taskNo).toUpperCase()] = { cn: item.taskNo, stn: to, from, by: u.name, at: Date.now() };
        save();
        pushOps(u, dir === 'in' ? '入库叫车' : '出库叫车', item.code, from + '→' + to + (item.taskNo ? ' 容器' + item.taskNo : '（排队）'));
        return send(res, 200, { ok: true, state: item.state, queued: item.state === '排队', id: item.id, container: item.taskNo || item.container, taskNo: item.wmsTask || '', msg: item.state === '已下发' ? ('已建任务并下发（容器 ' + item.taskNo + '）') : ('已排入队列 · 演算模式，切 live 后自动下发') });
      }
      // ---- ㉖⑰ 搬运任务状态回查：PDA 叫车后轮询本接口，队列项按 WMAS 对账推进后可拿到终态（按 id 或任务号）----
      if (req.method === 'GET' && p === '/api/agv/carryState') {
        const tn = String(url.searchParams.get('t') || '').trim().toUpperCase();
        const idq = String(url.searchParams.get('id') || '').trim();
        const q = (db.agvQueue || []).find((x) => (idq && String(x.id) === idq) || (tn && (String(x.wmsTask || '').toUpperCase() === tn || String(x.taskNo || '').toUpperCase() === tn)));
        if (!q) return send(res, 200, { ok: true, found: false });
        return send(res, 200, { ok: true, found: true, state: q.state, err: q.err || '', station: q.station || '' });
      }
      // ---- ㉖⑰ 货架位占用查询（服务器账本权威）：PDA 入库自动分配货位用，多PDA不再各算各的 ----
      if (req.method === 'GET' && p === '/api/ledger/locs') {
        const m = {}; for (const x of db.ledger || []) { const L = String(x.l || '').toUpperCase(); if (/^NB02-/.test(L) && !/-CK-/.test(L)) (m[L] = m[L] || []).push(String(x.c || '')); }
        pruneReserve(); for (const [l, r] of Object.entries(db.locReserve || {})) { (m[l] = m[l] || []).push(String(r.code || '')); } // ㉖v54 预占即占用：旧版PDA与picker一并避让
        return send(res, 200, { ok: true, byLoc: m });
      }
      // ㉖v54 货位预占：AUTO 分配由服务器算位并锁位（Node 单线程同步段内完成判定+登记，多PDA并发拿到不同格，根治5~15秒竞态撞位）
      if (req.method === 'POST' && p === '/api/ledger/reserve') {
        if (!canFeature(u, 'collect')) return send(res, 403, { ok: false, msg: '当前角色未开通「采集录入」权限' });
        const b = await readBody(req);
        const code = String((b && b.code) || '').trim().toUpperCase();
        const partNo = String((b && b.partNo) || '').trim().toUpperCase();
        if (!code || code.length > 40) return send(res, 400, { ok: false, msg: '缺少标签号' });
        const inLed = (db.ledger || []).find((x) => String(x.c || '').toUpperCase() === code);
        if (inLed) return send(res, 200, { ok: true, loc: String(inLed.l || '').toUpperCase(), kept: true }); // 已上账：回现位，不重复占
        pruneReserve();
        const R = db.locReserve = db.locReserve || {};
        const usedLoc = new Set(); for (const x of db.ledger || []) { const l = String(x.l || '').toUpperCase(); if (/^NB02-/.test(l) && !/-CK-/.test(l)) usedLoc.add(l); }
        for (const l of Object.keys(R)) { // 幂等：同标签未过期且位置未被占→复用原格
          if (String(R[l].code || '') !== code) continue;
          if (!usedLoc.has(l)) { R[l].at = Date.now(); R[l].by = u.name; save(); return send(res, 200, { ok: true, loc: l, kept: true }); }
          delete R[l];
        }
        const loc = nb02AssignFree(partNo);
        if (!loc) return send(res, 200, { ok: false, msg: '货架已无空位：请手动选位或改地面登记' });
        R[loc] = { code, by: u.name, at: Date.now() };
        save();
        return send(res, 200, { ok: true, loc });
      }
      if (req.method === 'POST' && p === '/api/scanlog/cancel') {
        if (u.role !== 'warehouse' && u.role !== 'admin') return send(res, 403, { ok: false, msg: '仅仓管员/管理员可作废流水' });
        const b = await readBody(req);
        const key = String(b.k || '').trim();
        const rec = (db.scanlog || {})[key];
        if (!rec) return send(res, 404, { ok: false, msg: '流水记录不存在（可能已同步覆盖）' });
        const code = String(rec.code || '').toUpperCase();
        const on = b.cx === true; // true=作废 false=恢复
        if (!!rec.cx === on) return send(res, 200, { ok: true, msg: on ? '已是作废态' : '已是正常态' });
        rec.cx = on; rec.cxB = u.name; rec.cxA = Date.now();
        const cur = new Map(db.ledger.map((x) => [String(x.c).toUpperCase(), x]));
        let ledgerMsg = '';
        if (on) { // 作废：整框消账（墓碑同步所有设备）+ 撤回全局防重允许重扫
          const self = cur.get(code);
          const bk = self ? boxKeyOf(self) : '';
          const kin = bk ? [...cur.values()].filter((x) => boxKeyOf(x) === bk) : [];
          const _nt = Date.now();
          (kin.length ? kin : [{ c: code }]).forEach((x) => { const C = String(x.c).toUpperCase(); cur.delete(C); (db.ledgerTomb = db.ledgerTomb || []).push({ c: C, t: _nt, rec: _nt }); });
          if (db.seenIn) delete db.seenIn[code];
          ledgerMsg = '，整框已消账';
        } else { // 恢复：按原货位重登账本（货位被占则只恢复流水不强行上账）
          const loc = String((rec.wt === 0 ? rec.st : rec.gl) || '').toUpperCase();
          const foreign = [...cur.values()].filter((x) => String(x.l).toUpperCase() === loc && String(x.c).toUpperCase() !== code);
          if (loc && !foreign.length && !cur.has(code)) {
            ledgerPut(cur, code, { c: code, l: loc, f: rec.ct || '', t: Date.now(), p: rec.pn || '', n: rec.nm || '', q: Number(rec.q) || 0, b: rec.lot || '', pid: rec.pid || '', src: '网页恢复' });
            db.ledgerTomb = (db.ledgerTomb || []).filter((x) => String(x.c).toUpperCase() !== code);
            (db.seenIn = db.seenIn || {})[code] = { by: u.name, t: Date.now(), l: loc, p: rec.pn || '' };
            ledgerMsg = '，已按 ' + loc + ' 重登账本';
          } else ledgerMsg = foreign.length ? '，⚠原货位 ' + loc + ' 已被占，仅恢复流水未上账' : '，仅恢复流水';
        }
        db.ledger = [...cur.values()]; db.ledgerRev = (db.ledgerRev || 0) + 1; db.ledgerAt = new Date().toISOString(); db.ledgerBy = u.name;
        db.scanlogAt = new Date().toISOString();
        pushOps(u, on ? '流水作废' : '流水恢复', code, (rec.batch || '') + ledgerMsg);
        save();
        return send(res, 200, { ok: true, msg: (on ? '已作废' : '已恢复') + ledgerMsg + '，账本v' + db.ledgerRev });
      }
      // ---- ㉖ PDA 内嵌控制台会话换发：原生 token（auth 已过指纹）换一枚不绑 UA 的网页 token，供 WebView 免登录 ----
      if (req.method === 'POST' && p === '/api/web/session') {
        const tk = newToken();
        db.sessions[tk] = { userId: u.id, createdAt: Date.now(), lastSeen: Date.now(), fp: '' }; // 不绑指纹：WebView UA 与原生不同
        save();
        return send(res, 200, { ok: true, token: tk });
      }
      // ================= AGV 叫车占位（原子防重：叫车前占位成功才允许下发任务） =================
      // 规则：同容器占位15分钟（防两人重复叉同一框）；同一站台60秒内不可再次叫车（不限同一人，确保单站台单任务）。
      // PDA 侧还会实时复核 WMAS 在途任务数；MES 下发失败由调用方 release 回滚占位。
      if (req.method === 'POST' && p === '/api/agv/claim') {
        if (!canFeature(u, 'agv_control')) return send(res, 403, { ok: false, msg: '当前角色未开通「AGV车辆控制」权限' });
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
          // ㉖v79c 同容器【同站台】才算重复叉取；同容器不同站台=两托合法并发（旧版按容器一刀切，现场容器号唯一致第二单永远被挡）
          if (c.cn === cn && c.stn === stn) return send(res, 200, { ok: false, code: 'agv_busy', msg: `容器 ${cn} 已在叫车流程中（${c.by} ${new Date(c.at).toLocaleTimeString('zh-CN', { hour12: false })} 叫往 ${c.stn}），请勿重复叉取` });
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
      // ---- ㉔G13 配置乐观锁：客户端带 baseRev=读取时看到的 cfgRev，他人已改则409；不带=兼容旧PDA ----
      const cfgGuard = (b) => { if (b.baseRev === undefined || b.baseRev === null || b.baseRev === '') return null; if (Number(b.baseRev) !== (db.cfgRev || 0)) return { err: 409, cur: db.cfgRev || 0, msg: '配置已被他人变更（你看到的是 v' + b.baseRev + '，现在 v' + (db.cfgRev || 0) + '），请刷新后重填' }; return null; };
      const cfgBump = () => { db.cfgRev = (db.cfgRev || 0) + 1; return db.cfgRev; };
      if (req.method === 'POST' && p === '/api/rcs/config') {
        if (!canFeature(u, 'agv_control')) return send(res, 403, { ok: false, msg: '当前角色未开通「AGV车辆控制」权限' });
        const b = await readBody(req);
        const _cg = cfgGuard(b); if (_cg) return send(res, 409, { ok: false, code: 'conflict', cfgRev: _cg.cur, msg: _cg.msg });
        const host = String(b.host || '').trim(), account = String(b.account || '').trim(), pwd = String(b.pwd || '');
        if (!host || !account || !pwd) return send(res, 400, { ok: false, msg: 'host/account/pwd 不能为空' });
        db.rcsConfig = { host, account, pwd }; db.rcsToken = ''; db.rcsTokenExp = 0;
        pushOps(u,'改RCS配置', host, '账号:'+account+'（密码不记）');
        const _cr = cfgBump();
        save();
        rcsPoll(); // 立即拉一次，让站台面板/催扫马上生效
        return send(res, 200, { ok: true, cfgRev: _cr, msg: 'RCS配置已保存，服务器开始轮询' });
      }
      if (req.method === 'GET' && p === '/api/rcs/stations') {
        const list = Object.values(db.rcsStations || {}).sort((a, b) => a.station.localeCompare(b.station)).map((s) => { const m = stnMetaOf(s.station); return { ...s, alias: m.alias || '', role: ['any', 'out', 'in', 'insp'].includes(m.role) ? m.role : 'any', off: m.off === true }; }); // ㉖⑫ 附站台身份（PDA 站台页/叫车/检验选台按此显示与过滤）
        const aliases = {}; for (const c of AGV_STNS) { const a = stnAlias(c); if (a) aliases[c] = a; }
        const holdAvg = {}; for (const [k, v] of Object.entries(db.rcsHoldStat || {})) holdAvg[k] = v.n ? Math.round(v.sum / v.n) : 0;
        return send(res, 200, { ok: true, at: db.rcsAt || '', on: !!(db.rcsConfig && db.rcsConfig.host), run: (db.rcsRun || []).length, stations: list, queue: (db.agvQueue || []).filter((q) => !['完成', '取消'].includes(q.state)).map((q) => Object.assign({}, q, { stage: agvStage(q) })), recent: (db.agvQueue || []).filter((q) => ['完成', '取消'].includes(q.state)).sort((a, b) => (b.updAt || 0) - (a.updAt || 0)).slice(0, 60).map((q) => Object.assign({}, q, { stage: agvStage(q) })), mode: db.agvDispatchMode || 'dry', holdAvg, aliases, agingMin: P().agingMin, cfgRev: db.cfgRev || 0 }); // ㉖ recent=完成/取消终态（留2小时；失败项仍在 queue 活跃表带原因展示），队列控制台"最近任务"卡片数据源；㉖v61 agingMin透传前端同口径排
      }
      // ===== ㉖⑫ 站台看板：每台实时状态+身份(别名/用途/停用)+今日吞吐+在途占用明细（指挥舱新页签，全端共用） =====
      if (req.method === 'GET' && p === '/api/agv/stboard') {
        const nowMs = Date.now();
        const _d0 = new Date(); const today0 = new Date(_d0.getFullYear(), _d0.getMonth(), _d0.getDate()).getTime();
        const stn = db.rcsStations || {}, qAll = db.agvQueue || [], insp = db.inspects || [];
        const tasks = Object.values(db.agvTasks || {});
        const list = AGV_STNS.map((code) => {
          const s = stn[code] || {}, meta = stnMetaOf(code);
          const todayOut = tasks.filter((t) => t.ck === 'out' && (t.fin || 0) >= today0 && String(t.ep || '').toUpperCase() === code).length;
          const todayIn = tasks.filter((t) => t.ck === 'in' && (t.fin || 0) >= today0 && String(t.sp || '').toUpperCase() === code).length;
          const qs = qAll.filter((q) => ((q.station || q.to) === code || (q.type === 'inbound' && String(q.fromLoc || '').toUpperCase() === code)) && ['排队', '下发中', '已下发'].includes(q.state)).map((q) => ({ code: q.code || '', by: q.by || '', reqNo: q.reqNo || '', state: q.state, stage: agvStage(q), dir: q.type === 'inbound' ? 'in' : 'out', at: q.at || 0, sentAt: q.sentAt || 0 })); // ㉖⑰ 入库任务起点=站台，也计入本台占用明细
          const isp = insp.filter((q) => q.station === code && ['waitOut', 'toStation', 'atStation', 'waitBack', 'returning', 'waitReturn'].includes(q.state)).map((q) => ({ code: q.code, state: q.state, by: q.by || '' }));
          const hold = (db.rcsHoldStat || {})[code];
          return { code, alias: String(meta.alias || ''), role: ['any', 'out', 'in', 'insp'].includes(meta.role) ? meta.role : 'any', off: meta.off === true,
            state: s.state || '空闲', label: s.label || '', goods: s.goods || '', dir: s.dir || '', via: s.via || '', pickAt: s.pickAt || 0, startAt: s.startAt || 0, buildAt: s.buildAt || 0, codes: s.codes || [], since: s.since || '', ts: s.ts || 0, manual: !!s.manual, // ㉖v54 透传毫秒到站时刻(旧前端Date.parse紧凑串=NaN致"到站"永不显示)
            holdAvg: hold && hold.n ? Math.round(hold.sum / hold.n) : 0, todayOut, todayIn, queue: qs, insp: isp };
        });
        return send(res, 200, { ok: true, at: new Date().toISOString(), on: !!(db.rcsConfig && db.rcsConfig.host), list });
      }
      if (req.method === 'POST' && p === '/api/agv/stmeta') { // 站台身份：别名/用途/停用（仓管·管理员）
        if (!canFeature(u, 'agv_control')) return send(res, 403, { ok: false, msg: '当前角色未开通「AGV车辆控制」权限' });
        const b = await readBody(req);
        const code = String(b.station || '').trim().toUpperCase();
        if (!AGV_STNS.includes(code)) return send(res, 400, { ok: false, msg: '站台编码不在 CK-01~12 范围' });
        db.stnMeta = db.stnMeta || {};
        const m = db.stnMeta[code] = db.stnMeta[code] || {};
        if (b.alias !== undefined) m.alias = String(b.alias).trim().slice(0, 12);
        if (b.role !== undefined) m.role = ['any', 'out', 'in', 'insp'].includes(String(b.role)) ? String(b.role) : 'any';
        if (b.off !== undefined) m.off = b.off === true;
        m.by = u.name; m.at = Date.now();
        const _cg = cfgGuard(b); if (_cg) return send(res, 409, { ok: false, code: 'conflict', cfgRev: _cg.cur, msg: _cg.msg });
        cfgBump(); save();
        pushOps(u, '站台设置', stnDisp(code), '别名:' + (m.alias || '-') + ' 用途:' + m.role + (m.off ? ' 已停用' : ''));
        return send(res, 200, { ok: true, meta: m, cfgRev: db.cfgRev || 0 });
      }
      // ===== ① 2D实时地图快照：路网(缓存)+车辆(实时)+货架占用(账本)+站台(判定)+交管锁点 =====
      if (req.method === 'GET' && p === '/api/rcs/net') {
        const lands = {}; for (const [k, v] of Object.entries(NetMap.lands)) lands[k] = { x: v.x, y: v.y, r: v.r, t: v.t };
        const edges = []; for (const [a, list] of Object.entries(NetMap.adj)) for (const [b] of list) if (a < b || NetMap.adj[b] === undefined || !NetMap.adj[b].some((e2) => e2[0] === a)) edges.push([a, b]);
        // ㉖v52 货位→地标映射（rack表权威+学习兜底）：容器管理高架平面图按真实坐标定位
        return send(res, 200, { ok: true, ready: NetMap.ready(), lands, edges, locLand: NetMap.locLand || {} });
      }
      if (req.method === 'GET' && p === '/api/rcs/map') {
        const tk = (db.rcsToken && Date.now() < (db.rcsTokenExp || 0)) ? db.rcsToken : await rcsLogin();
        let cars = [];
        if (tk) { try { const cr = await rcsReq('/uds/car/getCarInfoList', 'GET', tk); cars = typeof cr.data === 'string' ? JSON.parse(cr.data) : (cr.data || []); } catch (_) {} }
        let mapBlocked = new Set(); try { const tr = await rcsReq2('/agv/debug/getLockResourceListForStatus'); if (tr.ok) { const t = typeof tr.data === 'string' ? JSON.parse(tr.data) : (tr.data || {}); for (const z of (((t.zoneLocks || {}).zoneList) || [])) for (const x of (z.blockedCars || [])) mapBlocked.add(Number(x)); } } catch (_) {} // ㉖v56 被交管集合（与车辆页同口径）
        const locOf = (lc) => NetMap.landLoc[String(lc)] || '';
        // 货架占用：landmark → {loc, codes}
        const byLoc = {};
        for (const x of db.ledger || []) { const l = String(x.l || '').toUpperCase(); (byLoc[l] = byLoc[l] || []).push(x.c); }
        const locT = {}; for (const x of db.ledger || []) { const l = String(x.l || '').toUpperCase(); if (!x.t) continue; if (!locT[l] || x.t < locT[l]) locT[l] = x.t; } // ㉖v54 新鲜度
        const shelf = [];
        for (const [loc, codes] of Object.entries(byLoc)) { const lc = NetMap.landOf(loc); if (lc && NetMap.lands[lc]) shelf.push({ land: lc, loc, n: codes.length }); }
        // ㉖v54 完整地图①：全量货架列（含空列）——locLand 里所有 NB02-*-xF 按列聚合，坐标取该列地标
        const colAgg = {};
        for (const [loc, lc] of Object.entries(NetMap.locLand)) {
          const m = /^NB02-([A-Z])-(\d{2})-(\dF)$/.exec(loc); if (!m) continue;
          const lk = NetMap.lands[lc]; if (!lk || !Number.isFinite(lk.x)) continue;
          const key = 'NB02-' + m[1] + '-' + m[2];
          const C = colAgg[key] || (colAgg[key] = { key, aisle: m[1], x: lk.x, y: lk.y, tiers: {}, n: 0, ageT: 0 });
          const cnt = (byLoc[loc] || []).length;
          if (cnt) { C.tiers[m[3]] = cnt; C.n += cnt;
            const tmin = locT[loc]; if (tmin && (!C.ageT || tmin < C.ageT)) C.ageT = tmin; }
        }
        const shelfCols = Object.values(colAgg);
        // ㉖v54 完整地图②：NB03 地面排格聚合（AGV 不跑地面区、账本无机器坐标 → 前端以"示意·非等比"面板呈现）
        const gAgg = {};
        for (const x of db.ledger || []) {
          const m = /^NB03-([A-Z])-(\d{2})-(\d{1,2})$/.exec(String(x.l || '').toUpperCase()); if (!m) continue;
          const rk = m[1] + '|' + m[2];
          const R = gAgg[rk] || (gAgg[rk] = { aisle: m[1], row: +m[2], cells: {} });
          const cn = +m[3];
          const cell = R.cells[cn] || (R.cells[cn] = { n: 0, q: 0, codes: [] });
          cell.n++; cell.q += Number(x.q) || 0;
          if (cell.codes.length < 10) cell.codes.push(String(x.c || '').toUpperCase());
        }
        const gSlots = db.groundSlots || {};
        const ground = Object.values(gAgg).map((R) => {
          const key = 'NB03-' + R.aisle + '-' + String(R.row).padStart(2, '0');
          return { key, aisle: R.aisle, row: R.row, slots: gSlots[key] || P().gndCols, off: !!(db.gndRowOff || {})[key], cells: R.cells }; // ㉖v59 格数缺省读参数；附停用标记
        }).sort((a, b) => a.key.localeCompare(b.key));
        const stn = [];
        for (const [loc, lc] of Object.entries(NetMap.locLand)) { // 全量站台：从路网映射取所有CK货位，状态缺省空闲
          if (!/-CK-/.test(loc) || !NetMap.lands[lc]) continue;
          const s = (db.rcsStations || {})[loc];
          stn.push({ land: lc, code: loc, state: s ? s.state : '空闲' });
        }
        stn.sort((a, b) => a.code.localeCompare(b.code));
        const tl = (() => { try { return typeof db.rcsTraffic === 'string' ? JSON.parse(db.rcsTraffic) : (db.rcsTraffic || {}); } catch (_) { return {}; } })();
        const owners = (tl.landmarkLocks && tl.landmarkLocks.landmarkOwners) || {};
                const _runByCar = {}; for (const t of db.rcsRun || []) if (t.wms) _runByCar[Number(t.car)] = t.wms; // ㉖v56 车→WMAS任务号
        // ㉖v92 车→RCS在途任务对象（sp/ep兜底：WMAS直建/队列已回收时路径仍可显示）+ 车→活动告警指纹（rcsCarAlarm 恢复即删，表里有=现役告警）
        const _runObjByCar = {}; for (const t of db.rcsRun || []) { const _cd = Number(t.car); if (_cd && !_runObjByCar[_cd]) _runObjByCar[_cd] = t; }
        const _alarmOf = (id) => { const r = (db.rcsCarAlarm || {})[id]; return r ? String(r.fp || '').slice(0, 46) : ''; };
        const _qByWms = {}; for (const q of db.agvQueue || []) if (q.wmsTask && !['完成', '取消', '失败'].includes(q.state)) _qByWms[String(q.wmsTask).toUpperCase()] = q;
        const _partOf = (code) => { const cu = String(code || '').toUpperCase(); const led = (db.ledger || []).find((x) => String(x.c || '').toUpperCase() === cu); if (led) return { p: String(led.p || ''), q: Number(led.q) || 0 }; const sl = Object.values(db.scanlog || {}).find((x) => String(x.code || '').toUpperCase() === cu && !x.cx); return sl ? { p: String(sl.pn || ''), q: Number(sl.q) || 0 } : { p: '', q: 0 }; };
        const _dirTx = { outbound: '出库', inbound: '入库', insp: '检验下架', inspback: '检验归位', transfer: '移库' };
return send(res, 200, {
          ok: true, at: new Date().toISOString(), netReady: NetMap.ready(), msg: !tk ? 'RCS 连接失败（登录无响应）' : (!NetMap.ready() ? '路网构建中（RCS 接口抖动，约1分钟内自愈）' : ''), // ㉖v92i 失败原因回传前端展示
          cars: cars.map((c) => ({ id: c.agvId, name: c.carName, x: c.x, y: c.y, yaw: c.yaw, state: c.carState, task: c.executeTaskNo || '', site: locOf(c.currentSite) || String(c.currentSite || ''), online: c.communicationBreak !== true && c.enable === 1, emerg: c.emergencyButton === true, mstop: c.manualStop === true, charging: c.charging === true, full: c.fullCharged === true, err: String(c.errorMessage || '').slice(0, 80), blocked: mapBlocked.has(Number(c.agvId)), power: Number(c.power) || 0, alarm: _alarmOf(c.agvId), cargo: (() => { // ㉖v92b 线上实测 rcsRun.wms 恒空（v56 关联从未命中）；RCS调度号 no 即 WMAS 任务号（AGV-/LL 单号），按 no 反查队列项
        const _cid = Number(c.agvId); const _rt = _runObjByCar[_cid]; if (!_rt) return null; if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-/.test(String(_rt.no || ''))) return null; // ㉖v92c UUID调度号=自主导航(充电/回待命)非业务搬运
        const q = _qByWms[String(_rt.no || '').toUpperCase()] || (_rt.wms ? _qByWms[String(_rt.wms).toUpperCase()] : null);
        const _isCk = (x) => /-CK-/.test(String(x || ''));
        const pt = q ? _partOf(q.code) : { p: '', q: 0 };
        const from = (q && (q.fromLoc || q.from)) || _rt.sp || '', to = (q && (q.station || q.stationManual)) || _rt.ep || '';
        const dir = _dirTx[q && q.type] || (_isCk(from) ? '入库' : (_isCk(to) ? '出库' : '搬运'));
        return { dir, p: pt.p, q: pt.q, from, to }; })() })), // ㉖v56 状态字段随地图下发；㉖v92 cargo 带完整 from→to 路径+RCS任务兜底+活动告警
          shelf, shelfCols, ground, stations: stn,
          jam: Object.entries(owners).map(([land, car]) => ({ land, car })).filter((j) => NetMap.lands[j.land]),
        });
      }
      // ===== ㉖ 指挥舱 RCS 代理（PDA AGV模块糅合进网页：任务/车辆/交管 + 操作） =====
      if (req.method === 'GET' && p === '/api/rcs/tasks') { // 进行中+最近历史（RCS原生任务，含PDA直连建的）
        const run = await rcsReq2('/task/getTaskInfo');
        const dn = await rcsReq2('/task/getDoneTaskList');
        const parse = (r) => { try { return typeof r.data === 'string' ? JSON.parse(r.data) : (r.data || []); } catch (_) { return []; } };
        const NAV_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-/; // 与 PDA 同款判定：调度号为 UUID=车辆自主导航(回待命/去充电)，业务任务号是 LL/AGV- 单号
        const row = (t) => { const { sp, ep } = parsePts(t); const nt = nodeTimes(t); const no = String(t.dispatchNo || ''); const ty = String(t.taskType || ''); return { no, nav: NAV_RE.test(no) || ty === 'CHARGE' || ty === 'STANDBY', st: Number(t.taskState), pri: Number(t.taskPriority || 0), car: t.exeAgvId == null ? null : Number(t.exeAgvId), sp, ep, pal: String(t.palletType || ''), type: ty, build: nt.buildAt, exe: nt.startAt, pick: nt.pickAt, put: nt.putAt, det: (t.taskDetailList || []).length }; };
        const runA = run.ok ? parse(run).map(row) : [];
        const doneA = dn.ok ? parse(dn).map(row).sort((a, b) => (b.put || b.exe || 0) - (a.put || a.exe || 0)).slice(0, 80) : [];
        return send(res, 200, { ok: run.ok || dn.ok, live: run.ok, err: run.ok ? '' : run.msg, running: runA, done: doneA, at: new Date().toISOString() });
      }
      if (req.method === 'GET' && p === '/api/rcs/cars') { // 车辆列表（基础+点位/任务号合并+被交管集合）
        const a = await rcsReq2('/uds/car/getCarInfoList');
        const b = await rcsReq2('/agv/debug/getCarListForStatus');
        const tr = await rcsReq2('/agv/debug/getLockResourceListForStatus');
        const parse = (r) => { try { return typeof r.data === 'string' ? JSON.parse(r.data) : (r.data || []); } catch (_) { return []; } };
        const site = {}; if (b.ok) for (const e of parse(b)) site[e.agvId] = e;
        const blocked = new Set();
        if (tr.ok) { try { const t = typeof tr.data === 'string' ? JSON.parse(tr.data) : (tr.data || {}); for (const z of (((t.zoneLocks || {}).zoneList) || [])) for (const x of (z.blockedCars || [])) blocked.add(Number(x)); } catch (_) {} }
        const cars = a.ok ? parse(a).map((c) => { const s = site[c.agvId] || {}; return { id: c.agvId, name: c.carName || ('AGV' + c.agvId), ip: String(c.carIp || ''), online: c.communicationBreak !== true && c.enable === 1, state: c.carState, auto: c.autoMode === true, model: c.carModel || '-', fork: Number(c.forkHeight) || 0, power: Number(c.power) || 0, speed: Number(c.speed) || 0, x: c.x, y: c.y, site: s.currentSite != null ? String(s.currentSite) : (c.currentSite != null ? String(c.currentSite) : ''), task: String(s.executeTaskNo || c.executeTaskNo || ''), locks: (c.routeLockLands || []).slice(0, 16), emerg: c.emergencyButton === true, mstop: c.manualStop === true, charging: c.charging === true, full: c.fullCharged === true, lock: c.lock === true, err: String(c.errorMessage || ''), blocked: blocked.has(Number(c.agvId)), alarm: (() => { const r = (db.rcsCarAlarm || {})[c.agvId]; return r ? String(r.fp || '').slice(0, 46) : ''; })() }; }) : []; // ㉖v92 活动告警随车辆下发（与地图/车辆页统一口径）
        return send(res, 200, { ok: a.ok, err: a.ok ? '' : a.msg, cars, at: new Date().toISOString() });
      }
      if (req.method === 'GET' && p === '/api/rcs/traffic') { // 交管：拦停车辆+点位占用+交管区配置
        const tr = await rcsReq2('/agv/debug/getLockResourceListForStatus');
        const ca = await rcsReq2('/uds/car/getCarInfoList');
        const parse = (r) => { try { return typeof r.data === 'string' ? JSON.parse(r.data) : (r.data || {}); } catch (_) { return {}; } };
        if (!tr.ok) return send(res, 200, { ok: false, msg: tr.msg });
        const t = parse(tr);
        const owners = (t.landmarkLocks || {}).landmarkOwners || {};
        const zones = ((t.zoneLocks || {}).zoneList) || [];
        const blocked = new Set(); for (const z of zones) for (const x of (z.blockedCars || [])) blocked.add(String(x));
        let carList = []; try { carList = (typeof ca.data === 'string' ? JSON.parse(ca.data) : (ca.data || [])); } catch (_) {}
        const jam = carList.filter((c) => blocked.has(String(c.agvId)) || (c.enable === 1 && c.communicationBreak !== true && (c.carState === 'pause' || c.lock === true))).map((c) => ({ id: c.agvId, name: c.carName || ('AGV' + c.agvId), state: c.carState, lock: c.lock === true, site: String(c.currentSite != null ? c.currentSite : (c.routeLockLands && c.routeLockLands[0]) || ''), locks: (c.routeLockLands || []).filter((l) => owners[String(l)] != null && String(owners[String(l)]) !== String(c.agvId)).slice(0, 8) }));
        return send(res, 200, { ok: true, owners, totalLocked: (t.landmarkLocks || {}).totalLocked || Object.keys(owners).length, zones: zones.map((z) => ({ id: z.zoneId, rm: z.remarks || '', carNumber: z.carNumber, lands: (z.landmarkCodesStr || z.landList || '').toString().split(',').filter(Boolean).slice(0, 40) })), jam, at: new Date().toISOString() });
      }
      if (req.method === 'POST' && p === '/api/rcs/taskAct') { // 任务操作：resetPick/resetPut/recoverPick/recoverPut/top/cancelTop/delete
        if (!canFeature(u, 'agv_control')) return send(res, 403, { ok: false, msg: '当前角色未开通「AGV车辆控制」权限' });
        const b = await readBody(req);
        const op = String(b.op || ''), no = String(b.dispatchNo || '').trim();
        if (!no) return send(res, 400, { ok: false, msg: '缺少任务号' });
        const M = { resetPick: ['GET', '/task/resetTask?dispatchNo=', 0], resetPut: ['GET', '/task/resetTask?dispatchNo=', 1], recoverPick: ['GET', '/task/recoverTask?dispatchNo=', 0], recoverPut: ['GET', '/task/recoverTask?dispatchNo=', 1], top: ['DELETE', '/task/taskToTop?dispatchNo=', null], cancelTop: ['DELETE', '/task/taskToCancelTop?dispatchNo=', null], delete: ['DELETE', '/task/deleteByDispatchNo?dispatchNo=', null] };
        const m = M[op]; if (!m) return send(res, 400, { ok: false, msg: '未知操作' });
        const path = m[1] + encodeURIComponent(no) + (m[2] === null ? '' : ('&detailId=' + m[2]));
        const r = await rcsReq2(path, m[0], m[0] === 'DELETE' ? no : null);
        if (r.ok && op === 'delete') { // ㉖v72 删除联动义务：WMAS 记录一并停（防僵尸任务占用容器池），调度器队列项同步取消（三层状态收敛）
          try {
            const rt = (db.rcsRun || []).find((x) => String(x.no) === no);
            const wms = rt ? String(rt.wms || '') : '';
            const hit = (db.agvQueue || []).find((q) => ['下发中', '已下发'].includes(q.state) && (String(q.wmsTask || '') === no || (wms && String(q.wmsTask || '') === wms)));
            const _tk = await wmasToken();
            if (_tk && (wms || no)) await wmasHttp('POST', '/api/logistics/agv-task/cancelTask', _tk, [wms || no]); // ㉖v72 真实签名：cancelTask+任务号数组（探测实测：旧 /cancel+{taskNos} 恒被拒）
            if (hit) { retireQueueItem(hit, '取消', '任务已在RCS被人工删除（调度器已同步取消）'); inspQueueRollback(hit, u); save(); r.msg = (r.msg || '已删除') + '；调度器已同步取消框 ' + hit.code + ' 的任务'; }
            pushOps(u, 'RCS删除联动', no, hit ? '队列项 ' + hit.code + ' 已同步取消' : '未匹配到活跃队列项（出库对账兜底）');
          } catch (_) {}
        }
        if (r.ok && (op === 'top' || op === 'cancelTop')) { // ㉖v52 置顶回读校验：RCS 常回空 data 成功，前端此前"点了没反应"；现回读队列给出位次反馈
          try {
            const t = await rcsReq2('/task/getTaskInfo');
            let arr = t && t.data; try { if (typeof arr === 'string') arr = JSON.parse(arr); } catch (_) { arr = []; }
            if (Array.isArray(arr) && arr.length) {
              const pend = arr.filter((x) => Number(x.taskState) === 0).map((x) => String(x.dispatchNo));
              const pos = pend.indexOf(no);
              if (pos < 0) r.msg = op === 'top' ? '已置顶（任务已不在待执行队列，可能刚被领走）' : '已取消置顶（任务已不在待执行队列）';
              else r.msg = op === 'top'
                ? (pos === 0 ? '已置顶：当前最早待执行就是它' : `已置为待执行第 ${pos + 1} 位（前面还有 ${pos} 个更早任务，调度按建单先后派车）`)
                : `已取消置顶（当前待执行第 ${pos + 1} 位）`;
            }
          } catch (_) { /* 回读失败不影响操作结果本身 */ }
        }
        pushOps(u, 'RCS任务操作', no, op + (r.ok ? ' ✅' : ' ❌' + r.msg));
        return send(res, 200, r);
      }
      if (req.method === 'POST' && p === '/api/rcs/carAct') { // 车辆操作：charge/standby/reset/stop/start（参数=车辆IP）
        if (!canFeature(u, 'agv_control')) return send(res, 403, { ok: false, msg: '当前角色未开通「AGV车辆控制」权限' });
        const b = await readBody(req);
        const act = String(b.action || ''), ip = String(b.ip || '').trim();
        if (!ip) return send(res, 400, { ok: false, msg: '缺少车辆IP' });
        const P = { charge: '/agv/carToCharge', standby: '/agv/carToStandby', reset: '/agv/resetCar', stop: '/agv/stopAgv', start: '/agv/startAgv' };
        const path = P[act]; if (!path) return send(res, 400, { ok: false, msg: '未知操作' });
        const r = await rcsReq2(path + '?ip=' + encodeURIComponent(ip), 'PUT');
        pushOps(u, 'RCS车辆操作', ip, act + (r.ok ? ' ✅' : ' ❌' + r.msg));
        return send(res, 200, r);
      }
      if (req.method === 'POST' && p === '/api/rcs/unlock') { // 解除交管：强制释放点位交管锁（碰撞风险操作，红色二次确认在前端）
        if (!canFeature(u, 'agv_control')) return send(res, 403, { ok: false, msg: '当前角色未开通「AGV车辆控制」权限' });
        const b = await readBody(req);
        const land = String(b.landmarkCode || '').trim();
        if (!land) return send(res, 400, { ok: false, msg: '缺少点位号' });
        const r = await rcsReq2('/agv/debug/unlockStation?landmarkCode=' + encodeURIComponent(land));
        pushOps(u, '解除交管', land, r.ok ? '✅ 已释放' : '❌' + r.msg);
        return send(res, 200, r);
      }
      // ===== AGV 出库排队队列（一键叫车） =====
      if (req.method === 'POST' && p === '/api/agv/queue') { // 批量入队：items=[{code,fromLoc,palletType,partNo,stationManual?}]；入队即登记叫车标记防重复
        if (!canFeature(u, 'agv_control')) return send(res, 403, { ok: false, msg: '当前角色未开通「AGV车辆控制」权限' });
        const b = await readBody(req);
        const items = Array.isArray(b.items) ? b.items : [];
        const reqId = String(b.reqId || ''), reqNo = String(b.reqNo || '');
        if (!items.length || items.length > 30) return send(res, 400, { ok: false, msg: 'items 需1~30条' });
        const _confTrf = (db.agvQueue || []).filter(function (x) { return x.type === 'transfer' && ['排队', '下发中', '已下发'].includes(x.state); });
        db.agvQueue = db.agvQueue || [];
        const rq = db.requisitions.find((x) => x.id === reqId);
        let added = 0, dup = 0, conflict = 0;
        for (const it of items) {
          const code = String(it.code || '').trim().toUpperCase(), fromLoc = String(it.fromLoc || '').trim().toUpperCase();
          if (!code || !fromLoc) continue;
          if (_confTrf.some(function (x) { return String(x.from).toUpperCase() === fromLoc || String(x.to).toUpperCase() === fromLoc; })) { conflict++; continue; } // 该货位有进行中移库
          if (db.agvQueue.some((q) => q.code === code && !['完成', '取消', '失败'].includes(q.state))) { dup++; continue; } // 同框已在队列
          if ((db.inspects || []).some((q) => String(q.code).toUpperCase() === code && ['waitOut','toStation','atStation','waitBack','returning'].includes(q.state))) { conflict++; continue; } // ㉖②④ 检验中禁止出库叫车（waitReturn 待退货除外=放行）
          const ti = rq && (rq.items || []).find((i) => i.partNo === it.partNo); // 登记叫车标记：建议区变🚗排队，单框叫车自动跳过
          db.agvQueue.push({ code, fromLoc, palletType: String(it.palletType || ''), stationManual: String(it.stationManual || '').trim().toUpperCase(), reqId, reqNo, by: u.name, state: '排队', rush: lineRush(rq, ti), station: '', at: Date.now(), updAt: Date.now() }); // v55 行级急料（旧单无行标回退整单）
          if (ti) { ti.agvCalled = (ti.agvCalled || []).filter((e) => String(e.c).toUpperCase() !== code); ti.agvCalled.push({ c: code, s: '', q: 1, by: u.id, t: new Date().toISOString() }); }
          added++;
        }
        save(); rcsPoll(); // 立即调度一轮
        return send(res, 200, { ok: true, added, dup, conflict, mode: db.agvDispatchMode || 'dry', msg: `已排队 ${added} 框${dup ? `（${dup} 框已在队列跳过）` : ''}${conflict ? `（${conflict} 框因移库占用跳过）` : ''}` });
      }
      if (req.method === 'GET' && p === '/api/agv/funnel') {
        const days = Math.min(30, Math.max(1, parseInt(url.searchParams.get('days') || '7') || 7));
        return send(res, 200, { ok: true, days, stages: buildFunnel(days) });
      }
      // 按标签反查AGV搬运链路（采集详情用）：队列项+任务沉淀 起终点/车号/节点时间
      if (req.method === 'GET' && p === '/api/agv/taskOf') {
        const code = String(url.searchParams.get('c') || '').trim().toUpperCase();
        if (!code) return send(res, 400, { ok: false, msg: '缺少 c' });
        const q = (db.agvQueue || []).filter((x) => String(x.code).toUpperCase() === code).sort((a, b) => (b.at || 0) - (a.at || 0))[0];
        let spKey = q ? String(q.fromLoc).toUpperCase() : '';
        let wantCk = q && q.type === 'inbound' ? 'in' : (q && q.type === 'outbound' ? 'out' : ''); // ㉖⑰ 入库搬运链路：按队列项方向匹配沉淀任务（原来只匹配出库，入库详情永远查不到）
        if (!spKey) { // ㉖ 队列项已出队（失败项仅留30分钟/完成项2小时）→ 从流水/账本回退初始站台锚点，否则AGV节点全丢
          const sl0 = Object.values(db.scanlog || {}).find((s) => String(s.code || '').toUpperCase() === code && !s.cx && Number(s.wt) === 0);
          const led0 = (db.ledger || []).find((x) => String(x.c || '').toUpperCase() === code && String(x.mv || '') === 'AGV');
          spKey = String((sl0 && sl0.st) || (led0 && led0.src) || '').toUpperCase();
          if (spKey && !wantCk) wantCk = /-CK-/.test(spKey) ? 'in' : 'out'; // 起点是站台→入库回架任务；起点是货架→出库任务
        }
        let task = null;
        // ㉖v94k 双坐标纠偏（10/24 17:52 N26J240104 现场：链路显示"叉出17:46"早于"采集17:52"，实为同站台上一框 AGV-0039 被错配）：
        // 队列项已出队时只按"起点+最近完成"匹配，同站台连续多框必然张冠李戴。入库方向（起点=站台）改按
        // 起点+终点=账本当前货位 双坐标匹配（仅 mv=AGV 的账本可信）；匹配不到就置空——宁缺毋滥，错配比缺节点更伤信任。
        let epWant = '';
        if (wantCk === 'in') { const led1 = (db.ledger || []).find((x) => String(x.c || '').toUpperCase() === code); if (led1 && String(led1.mv || '') === 'AGV') epWant = String(led1.l || '').toUpperCase(); }
        if (q && q.wmsTask && db.agvTasks && db.agvTasks[q.wmsTask]) { const _t0 = db.agvTasks[q.wmsTask]; if (!epWant || String(_t0.ep || '').toUpperCase() === epWant) task = { ..._t0, no: q.wmsTask }; else task = null; } // ㉖v94k 旧数据wmsTask本身可能串单记错(104记成0039,真单0047)：入库带终点校验，不符弃之走回退匹配
        if (!task) { // 时间窗+起点匹配最近一条任务
          const lo0 = q ? (q.at || 0) - 3600000 : Date.now() - 2 * 86400000;
          const ledR = !q && epWant ? (((db.ledger || []).find((x) => String(x.c || '').toUpperCase() === code) || {}).rec || 0) : 0;
          const lo = ledR ? Math.max(lo0, ledR - 600000) : lo0; // 入库回退：窗口收到采集时刻前10分钟，防抓更早的同站台他框任务
          for (const [no, t] of Object.entries(db.agvTasks || {})) {
            if (!((wantCk ? t.ck === wantCk : (t.ck === 'out' || t.ck === 'in')) && t.sp === spKey && t.fin >= lo && (!task || t.fin > task.fin))) continue;
            if (!q && epWant && String(t.ep || '').toUpperCase() !== epWant) continue; // 已出队+入库：终点必须=账本货位
            task = { ...t, no };
          }
        }
        if (!task && spKey) { // 在途任务（未沉淀）；㉖v94k 入库带终点过滤
          for (const t of db.rcsRun || []) { if (t.sp === spKey && (!epWant || String(t.ep || '').toUpperCase() === epWant)) { task = { no: t.no, sp: t.sp, ep: t.ep, ex: t.startAt || 0, pick: t.pickAt || 0, fin: 0 }; break; } }
        }
        const fmt2 = (ms) => ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
        const stText = task ? (task.fin ? '已完成' : (task.pick ? '已叉出送货中' : (task.ex ? '取货中' : '排队中'))) : '';
        const tl = task ? [task.buildAt ? `建单 ${fmt2(task.buildAt)}` : '', task.ex ? `接令 ${fmt2(task.ex)}` : '', task.pick ? `叉出 ${fmt2(task.pick)}` : '', task.fin ? `到站 ${fmt2(task.fin)}` : ''].filter(Boolean).join(' · ') : '';
        // 完整出库链路：领料单history(下单/接单/发料/转MES/签收) + 队列(入队/下发) + RCS(接令/叉出/到站)
        let rq = null, rit = null;
        for (const r of db.requisitions || []) { for (const i of r.items || []) { if ((i.agvCalled || []).some((e) => String(e.c).toUpperCase() === code)) { rq = r; rit = i; break; } } if (rq) break; }
        const chain = { reqNo: rq ? rq.no : (q ? q.reqNo : ''), created: rq ? (Date.parse(rq.createdAt || '') || 0) : 0 };
        if (rq) {
          const hist = rq.history || [];
          const findT = (pred) => { for (const hh of hist) { if (pred(String(hh.text || ''))) { const t2 = Date.parse(hh.time) || 0; if (t2) return t2; } } return 0; };
          chain.accept = findT((s) => s.startsWith('接单'));
          chain.issue = findT((s) => s.includes('发料') && s.includes(code));
          chain.transfer = findT((s) => s.includes('转MES'));
          chain.confirm = findT((s) => s.startsWith('签收确认'));
          const ce = (rit.agvCalled || []).find((e) => String(e.c).toUpperCase() === code);
          chain.call = Date.parse((ce && ce.t) || '') || 0;
        }
        chain.enqueue = q ? (q.at || 0) : 0;
        chain.dispatch = q ? (q.sentAt || 0) : (task ? (task.ex || 0) : 0); // ㉖ 出队后用RCS接令时刻兜底（接令必在下发后一刻内）
        if (task) { chain.exe = task.ex || 0; chain.pick = task.pick || 0; chain.arrive = task.fin || 0; }
        if (q && q.state === '完成') chain.cleared = q.updAt || 0;
        return send(res, 200, { ok: true, task: task ? { no: task.no, sp: task.sp, ep: task.ep, car: task.car || null, stateText: stText, tl } : null, queueState: q ? q.state : '', queueErr: q ? (q.err || '') : '', qType: q ? (q.type || '') : '', chain });
      }
      if (req.method === 'POST' && p === '/api/agv/queue/cancel') { // ㉖v72 取消排队项/撤销已下发；传 reqId 则整单逐条处理（未下发直接取消，已下发逐条试撤 WMAS）
        if (!canFeature(u, 'agv_control')) return send(res, 403, { ok: false, msg: '当前角色未开通「AGV车辆控制」权限' });
        const b = await readBody(req);
        const reqId = String(b.reqId || '').trim();
        const codes = new Set((Array.isArray(b.codes) ? b.codes : []).map((c) => String(c).toUpperCase()));
        const targets = (db.agvQueue || []).filter((q) => reqId ? String(q.reqId) === reqId : codes.has(String(q.code).toUpperCase()));
        // 单项撤销（下发中/已下发）：先反查 WMAS 任务号再撤，撤得掉（未叉出）才取消；查无记录=任务从未建成，可本地取消但留痕核查
        async function cancelDispatched(q, denied) {
          const tk = await wmasToken();
          if (!tk) { denied.push(q.code + '（WMAS 未连通，未执行撤销——请检查 AGV 系统设置或现场处理）'); return false; }
          const tn = await wmasTaskNoOf(q, tk);
          if (tn === null) { denied.push(q.code + '（WMAS 任务查询无响应，未执行撤销——请稍后重试或现场确认）'); return false; }
          if (!tn) {
            retireQueueItem(q, '取消', ''); inspQueueRollback(q, u);
            (q.trace = q.trace || []).push('WMAS查无该任务记录，仅调度器侧取消，请现场确认车辆未动作');
            return true;
          }
          if (!q.wmsTask) q.wmsTask = tn;
          const cr = await wmasHttp('POST', '/api/logistics/agv-task/cancelTask', tk, [tn]); // ㉖v72 真实签名（探测实测）
          if (wmasOk(cr)) { retireQueueItem(q, '取消', ''); inspQueueRollback(q, u); return true; }
          const why = (cr && (cr.message || cr.msg)) || 'WMAS拒绝';
          if (String(why).includes('不存在')) { // 任务已被下游删除（RCS旁路等）：无单可撤=调度器侧取消即可，留痕核查
            retireQueueItem(q, '取消', ''); inspQueueRollback(q, u);
            (q.trace = q.trace || []).push('WMAS任务已不存在（或已被删除），调度器侧同步取消');
            return true;
          }
          denied.push(q.code + '（撤销被拒：' + String(why).slice(0, 40) + (q.station ? '，车正送往 ' + q.station : '') + '）');
          return false;
        }
        let n = 0, atStn = 0; const denied = [];
        for (const q of targets) {
          if (q.state === '排队' || q.state === '失败') { retireQueueItem(q, '取消', ''); inspQueueRollback(q, u); n++; continue; }
          if (q.state === '到站') { atStn++; continue; } // 货已在台上，取消无意义：扫码发料/清台接管
          if (q.state === '下发中' || q.state === '已下发') { if (await cancelDispatched(q, denied)) n++; continue; }
        }
        save();
        const head = n ? `已取消 ${n} 项` : (denied.length || atStn ? '' : reqId ? '本单没有可取消的排队项' : '未找到可取消的排队项');
        const tail = [denied.length ? '未撤掉：' + denied.join('；') : '', atStn ? `另有 ${atStn} 框已到站台，请扫码发料或清台` : ''].filter(Boolean).join('；');
        return send(res, 200, { ok: true, cancelled: n, denied, atStation: atStn, msg: [head, tail].filter(Boolean).join('；') });
      }
      if (req.method === 'POST' && p === '/api/agv/queue/prio') { // ㉔队列置顶：给排队项打 prio 标记，调度出队优先
        if (!canFeature(u, 'agv_control')) return send(res, 403, { ok: false, msg: '当前角色未开通「AGV车辆控制」权限' });
        const b = await readBody(req);
        const code = String(b.code || '').trim().toUpperCase();
        const q = (db.agvQueue || []).find((x) => String(x.code).toUpperCase() === code && (x.state === '排队' || x.state === '失败'));
        if (!q) return send(res, 400, { ok: false, msg: '该框不在排队中（已下发/完成/取消无法置顶）' });
        if (b.off) { delete q.prio; save(); pushOps(u, '队列取消置顶', code, '框 ' + code); return send(res, 200, { ok: true, msg: '已取消置顶' }); }
        q.prio = Date.now(); pushOps(u, '队列置顶', code, '框 ' + code); save();
        console.log(`[agv-q] ${u.name} 置顶排队框 ${code}`);
        return send(res, 200, { ok: true, msg: '已置顶，下一轮调度优先下发' });
      }
      // ---- ㉖B6 零件档案：搜索 / 全景画像（在库框+出入库史+预约人+待处理需求）/ 管理员代取消预约 ----
      if (req.method === 'GET' && p === '/api/parts') {
        const q = String(url.searchParams.get('q') || '').trim().toUpperCase();
        const m = {};
        const touch = (pn, nm) => { if (!pn) return; const e = (m[pn] = m[pn] || { nm: '', n: 0 }); if (nm && !e.nm) e.nm = String(nm).slice(0, 80); };
        // ㉖v91 修「账本N框」口径：旧版逐账本行+1=标签数（一托5码显示5框，与档案"在架框"按框聚合打架）；
        // 改按 boxKeyOf 聚合（与发料建议/档案明细逐字同源：托号优先/同位同件并框）
        const _bx = {};
        for (const x of db.ledger || []) { const pn = String(x.p || '').toUpperCase(); touch(pn, x.n); if (!pn) continue; (_bx[pn] = _bx[pn] || new Set()).add(boxKeyOf(x)); }
        for (const pn of Object.keys(_bx)) if (m[pn]) m[pn].n = _bx[pn].size;
        for (const st of Object.values(db.scanlog || {})) touch(String(st.pn || '').toUpperCase(), st.nm);
        for (const o of Object.values(db.outbound || {})) for (const i of (o.items || [])) touch(String(i.code || '').toUpperCase(), i.name);
        if (db.itemDict) for (const [pn, dd] of Object.entries(db.itemDict)) touch(String(pn).toUpperCase(), dd && dd.nm);
        let ks = Object.keys(m);
        if (q) ks = ks.filter((k) => k.includes(q) || String(m[k].nm || '').toUpperCase().includes(q));
        ks.sort((a, b) => (m[b].n || 0) - (m[a].n || 0) || a.localeCompare(b));
        return send(res, 200, { ok: true, list: ks.slice(0, 40).map((k) => ({ pn: k, nm: m[k].nm, n: m[k].n })) });
      }
      // ===== ㉖v57 任务/货物追溯看板：跨实体统一时间线（扫码→上架→领料→调度→AGV→到站→出库），只读聚合 =====
      // ===== ㉖v58 错发/漏扫防呆体检：只读扫描全库作业隐患（不改任何数据，供🛡防呆看板展示） =====
      if (req.method === 'GET' && p === '/api/foolproof') {
        const ISS = [];
        const add = (type, code, loc, detail, sev) => { ISS.push({ type: String(type || ''), code: String(code || ''), loc: String(loc || ''), detail: String(detail || ''), sev: sev === 'high' ? 'high' : sev === 'mid' ? 'mid' : 'low' }); };
        // 采集流水按框码索引（有效采集=有入库佐证）
        const scannedCodes = {}; for (const st of Object.values(db.scanlog || {})) { if (!st.cx) scannedCodes[String(st.code || '').toUpperCase()] = st; }
        const ledgerByCode = {}; for (const x of db.ledger || []) ledgerByCode[String(x.c || '').toUpperCase()] = x;
        // — ① 错发：出库单框码无任何采集/账本佐证（来源不明，疑似发错）
        for (const o of Object.values(db.outbound || {})) {
          if (Number(o.status) === 1) continue; // 已完成不再体检
          for (const it of o.items || []) {
            const c = String(it.code || it.barcode || '').toUpperCase(); if (!c) continue;
            if (!scannedCodes[c] && !ledgerByCode[c]) add('错发', c, it.fromLoc || '', '出库单 ' + o.orderNo + ' 中该框无采集流水也无账本记录，来源不明', 'high');
          }
        }
        // — ② 漏扫：领料单已备齐(ready)但有行短装未闭环（实发<需求且未跳过说明）
        for (const r of db.requisitions || []) {
          if (!['ready', 'accepted'].includes(r.status)) continue;
          for (const it of r.items || []) {
            if (it.skipped) continue;
            const need = Number(it.qty) || 0, got = Number(it.transferQty) || 0;
            if (need > 0 && got < need) add('漏扫', String(it.partNo || ''), '', '领料单 ' + (r.no || '') + ' 零件 ' + (it.partNo || '') + ' 需求' + need + '件实发' + got + '件，短' + (need - got) + '件', need - got >= need ? 'high' : 'mid');
          }
        }
        // — ③ 超发：领料单已发数量超过需求（多发货）
        for (const r of db.requisitions || []) {
          if (['done', 'cancelled', 'rejected'].includes(r.status)) continue;
          for (const it of r.items || []) {
            const need = Number(it.qty) || 0;
            const issued = (it.issued || []).reduce((s, e) => s + (Number(typeof e === 'string' ? 0 : e.q) || 0), 0);
            if (need > 0 && issued > need) add('超发', String(it.partNo || ''), '', '领料单 ' + (r.no || '') + ' 零件 ' + (it.partNo || '') + ' 需求' + need + '件已发' + issued + '件，超发' + (issued - need) + '件', 'high');
          }
        }
        // — ④ 同码重复发料：同一标签码在多个活跃领料单被记账（㉖v59 方案B下同框多码拆单发是合法作业，同码双记才是异常）
        const codeOwners = {};
        for (const r of db.requisitions || []) {
          if (['done', 'cancelled', 'rejected'].includes(r.status)) continue;
          for (const it of r.items || []) for (const e of it.issued || []) {
            const c = String(typeof e === 'string' ? e : e.c || '').toUpperCase(); if (!c) continue;
            (codeOwners[c] = codeOwners[c] || new Set()).add(r.no || '');
          }
        }
        for (const [c, owners] of Object.entries(codeOwners)) {
          if (owners.size > 1) add('重复发料', c, '', '同一标签在多个领料单被记账：' + Array.from(owners).slice(0, 5).join('、') + '（数量会双计，请核实）', 'high');
        }
        // — ⑤ 到站滞留：AGV已到站但队列项长时间未交付闭环（漏扫交付）
        const nowMs = Date.now(), staleMs = (Number((db.params || {}).fpStaleMin) || 30) * 60000;
        for (const q of db.agvQueue || []) {
          if (q.state !== '到站') continue;
          const since = Number(q.updAt || q.at) || 0;
          if (since && nowMs - since > staleMs) add('到站滞留', String(q.code || ''), q.station || '', 'AGV已到站台 ' + (q.station || '') + ' 超' + Math.round((nowMs - since) / 60000) + '分钟未交付闭环，疑似漏扫确认', 'mid');
        }
        const order = { high: 0, mid: 1, low: 2 };
        ISS.sort((a, b) => (order[a.sev] - order[b.sev]) || String(a.type).localeCompare(String(b.type)));
        const byType = {}; for (const x of ISS) byType[x.type] = (byType[x.type] || 0) + 1;
        const bySev = { high: 0, mid: 0, low: 0 }; for (const x of ISS) bySev[x.sev] = (bySev[x.sev] || 0) + 1;
        return send(res, 200, { ok: true, count: ISS.length, byType: byType, bySev: bySev, issues: ISS.slice(0, 500), staleMin: Math.round(staleMs / 60000) });
      }
      // ===== ㉖v58 出库扫码防呆校验：PDA/网页出库核对时实时判定该框能否出（block拦截/warn提醒/ok放行），只读不落库 =====
      if (req.method === 'GET' && p === '/api/outbound/scanCheck') {
        const c = String(url.searchParams.get('c') || '').trim().toUpperCase();
        if (!c) return send(res, 400, { ok: false, msg: '缺少框码 c' });
        const st = labelStatus(c);
        if (!st) return send(res, 200, { ok: true, code: c, level: 'block', reason: '空框码', advice: '重新扫码' });
        // 来源佐证：采集流水或账本记录（无佐证=来源不明，最高危错发信号）
        const scanned = Object.values(db.scanlog || {}).some((x) => !x.cx && String(x.code || '').toUpperCase() === c);
        const onLedger = (db.ledger || []).some((x) => String(x.c || '').toUpperCase() === c);
        if (!scanned && !onLedger) return send(res, 200, { ok: true, code: c, level: 'block', reason: '该框无采集流水也无账本记录，来源不明', advice: '疑似发错货，请先核对来源' });
        // 已发料到领料单：会被重复出库，硬拦（出库核对阶段该框不该再随出库单走）
        if (st.inIssued.length) return send(res, 200, { ok: true, code: c, level: 'block', reason: '该标签已发料到领料单 ' + st.inIssued.slice(0, 3).join('、') + '，禁止重复出库', advice: '该框已走领料发料，勿再随出库单发出' });
        // 检验中（非退货放行态）：硬拦
        { const _act = (st.inInspect || []).filter((q) => q.state !== 'waitReturn'); if (_act.length) return send(res, 200, { ok: true, code: c, level: 'block', reason: '该框正在检验流程中，暂不可出库', advice: '待检验完成或判退货后再出' }); }
        // 归属校验：该框在某张活跃出库单明细内=预期状态（放行）；不在任何单=提醒（可能拿错框）
        let inOrder = ''; for (const o of Object.values(db.outbound || {})) { if (Number(o.status) === 1) continue; for (const it of o.items || []) { if (String(it.code || '').toUpperCase() === c || String(it.barcode || '').toUpperCase() === c) { inOrder = o.orderNo; break; } } if (inOrder) break; }
        if (!inOrder) return send(res, 200, { ok: true, code: c, level: 'warn', reason: '该框不在任何活跃出库单明细内', advice: '请确认是否应随本单出库' });
        return send(res, 200, { ok: true, code: c, level: 'ok', reason: '校验通过', order: inOrder, advice: '' });
      }
      if (req.method === 'GET' && p === '/api/trace') {
        const q0 = String(url.searchParams.get('q') || '').trim();
        if (!q0) return send(res, 400, { ok: false, msg: '缺少查询关键字 q' });
        const Q = q0.toUpperCase();
        const _lv = ledgerView();
        const codeOf = (x) => String(x || '').toUpperCase();
        // 种子类型（优先 task>order>box>part），决定扩散粒度
        const isTask = (db.agvQueue || []).some((x) => codeOf(x.wmsTask) === Q || codeOf(x.taskNo) === Q) || (db.rcsRun || []).some((r) => codeOf(r.no) === Q || codeOf(r.wms) === Q) || !!(db.agvTasks && Object.prototype.hasOwnProperty.call(db.agvTasks, Q));
        const isOrder = Object.values(db.outbound || {}).some((o) => codeOf(o.orderNo) === Q) || (db.requisitions || []).some((r) => codeOf(r.no) === Q);
        const isBox = Object.values(db.scanlog || {}).some((st) => codeOf(st.code) === Q) || _lv.some((x) => codeOf(x.c) === Q) || (db.agvQueue || []).some((x) => codeOf(x.code) === Q);
        const isPart = Object.values(db.scanlog || {}).some((st) => codeOf(st.pn) === Q) || _lv.some((x) => codeOf(x.p) === Q);
        const kind = isTask ? 'task' : isOrder ? 'order' : isBox ? 'box' : isPart ? 'part' : 'unknown';
        // ㉖v59 核心修正：仅"按零件号查询"才扩散到该零件全部框/历史；按框/单/任务查询只追自身，避免搜一个框把全仓同零件的38框+无关出库单都拽进来
        const partExpand = isPart && !isTask && !isOrder && !isBox;
        const EV = [];
        const push = (t, k, title, detail, actor) => { const tt = Number(t) || 0; if (tt) EV.push({ t: tt, kind: String(k || ''), title: String(title || ''), detail: String(detail || ''), actor: String(actor || '') }); };
        const CODES = new Set(); const PNS = new Set(); const TASKS = new Set(); const REQS = new Set();
        // — ① 调度队列项：按 code/wmsTask/taskNo/reqNo 命中
        const qItems = [];
        const collectQ = (x) => { if (qItems.indexOf(x) < 0) { qItems.push(x); const c = codeOf(x.code), wt = codeOf(x.wmsTask), tn = codeOf(x.taskNo), rn = codeOf(x.reqNo); if (c) CODES.add(c); if (wt) TASKS.add(wt); if (tn) TASKS.add(tn); if (rn) REQS.add(rn); } };
        for (const x of db.agvQueue || []) { if (codeOf(x.code) === Q || codeOf(x.wmsTask) === Q || codeOf(x.taskNo) === Q || codeOf(x.reqNo) === Q) collectQ(x); }
        if (isBox) CODES.add(Q); // 种子框即使没进过队列也纳入
        // 同托兄弟码=同一物理框，一并纳入（框查询只纳入本框兄弟，非整个零件）
        const boxKeys = new Set();
        for (const c of Array.from(CODES)) { const lx = _lv.find((x) => codeOf(x.c) === c); if (lx) boxKeys.add(boxKeyOf(lx)); }
        if (boxKeys.size) for (const x of _lv) { if (boxKeys.has(boxKeyOf(x))) CODES.add(codeOf(x.c)); }
        for (const x of db.agvQueue || []) { if (CODES.has(codeOf(x.code))) collectQ(x); }
        // ㉖v59 出库单/领料单查询时：预收集命中单据明细的框码（item.barcode），使该框的采集/在架事件反查纳入（单据→货物方向）
        if (isOrder && !partExpand) for (const o of Object.values(db.outbound || {})) { if (codeOf(o.orderNo) === Q || REQS.has(codeOf(o.linkReqNo))) for (const it of o.items || []) { const bc = codeOf(it.barcode); if (bc) CODES.add(bc); } }
        // — ② 扫码采集流水：框查询→仅本框(含兄弟)；零件查询→该零件全部
        const scans = [];
        for (const st of Object.values(db.scanlog || {})) {
          const c = codeOf(st.code), p = codeOf(st.pn);
          if (c === Q || CODES.has(c) || (partExpand && p === Q)) { scans.push(st); if (c) CODES.add(c); if (p) PNS.add(p); }
        }
        scans.sort((a, b) => (Number(b.t) || 0) - (Number(a.t) || 0));
        for (const st of scans.slice(0, 60)) push(st.t, st.cx ? 'scanx' : 'scan', (st.cx ? '❌ 已撤销采集 ' : '📥 采集入库 ') + String(st.code || ''), (st.pn ? '零件 ' + st.pn + ' · ' : '') + '数量 ' + (Number(st.q) || 0) + ((st.wt === 0 ? st.st : st.gl) ? ' · ' + (st.wt === 0 ? st.st : st.gl) : ''), st.op || '');
        // — ③ 领料单：单号命中 / 已发含本框 /（零件查询）含该零件
        for (const r of db.requisitions || []) {
          const no = codeOf(r.no);
          let rel = REQS.has(no) || no === Q;
          if (!rel) for (const it of r.items || []) {
            if (partExpand && PNS.has(codeOf(it.partNo))) { rel = true; break; }
            for (const e2 of it.issued || []) { if (CODES.has(codeOf(typeof e2 === 'string' ? e2 : e2.c))) { rel = true; break; } }
            if (rel) break;
          }
          if (!rel) continue;
          REQS.add(no);
          push(r.createdAt, 'req', '📋 领料下单 ' + no, (r.items || []).map((i) => String(i.partNo || '') + '×' + (Number(i.qty) || 0)).join('、'), r.byName || '');
          for (const h of r.history || []) push(h.time, 'req', '🔸 ' + String(h.text || ''), no, h.by || '');
        }
        // — ㉖v59 ④ 出库单：字段修正 item.code=零件号、item.barcode=框码（旧版写反致框→出库匹配失效）
        // 出库单/领料单查询时：预收集命中单据明细的框码，使该框的采集/在架事件反查纳入（单据→货物方向）
        if (isOrder && !partExpand) for (const o of Object.values(db.outbound || {})) { if (codeOf(o.orderNo) === Q || REQS.has(codeOf(o.linkReqNo))) for (const it of o.items || []) { const bc = codeOf(it.barcode); if (bc) CODES.add(bc); } }
        for (const o of Object.values(db.outbound || {})) {
          const no = codeOf(o.orderNo);
          let rel = no === Q || REQS.has(codeOf(o.linkReqNo));
          if (!rel) for (const it of o.items || []) { if (CODES.has(codeOf(it.barcode)) || (partExpand && PNS.has(codeOf(it.code)))) { rel = true; break; } }
          if (!rel) continue;
          push(o.createdAt, 'out', '📤 出库 ' + no, (o.items || []).map((i) => String(i.barcode || i.code || '') + '×' + (Number(i.qty) || 0)).join('、') + (o.toLoc ? ' → ' + o.toLoc : ''), o.operator || '');
        }
        // — ⑤ AGV 调度状态 + 决策留痕 trace
        for (const x of qItems) {
          push(x.at, 'queue', '🚦 进入调度队列', '框 ' + String(x.code || '') + (x.fromLoc ? ' · ' + x.fromLoc : '') + (x.station ? ' → ' + x.station : '') + ' · 状态 ' + String(x.state || ''), x.by || '');
          for (const tr of x.trace || []) push(x.updAt || x.at, 'trace', '🧭 ' + String(tr), '', '');
          if (x.state === '到站' || x.state === '完成') push(x.updAt || x.at, 'station', '🏁 到达站台 ' + String(x.station || ''), '框 ' + String(x.code || ''), '');
        }
        // — ⑥ RCS 在途任务执行节点
        for (const r of db.rcsRun || []) {
          const no = codeOf(r.no), wms = codeOf(r.wms);
          if (!(no === Q || wms === Q || TASKS.has(no) || TASKS.has(wms))) continue;
          push(r.buildAt, 'agv', '🤖 AGV建任务 ' + no, (r.sp ? r.sp + ' → ' + r.ep : '') + (r.car ? ' · 车' + r.car : ''), '');
          push(r.startAt, 'agv', '▶️ AGV开始执行 ' + no, '车 ' + (r.car || ''), '');
          push(r.pickAt, 'agv', '🔱 叉取货物', r.sp || '', '');
          push(r.putAt, 'agv', '📍 放置到位', r.ep || '', '');
        }
        // — ⑦ 已完成任务底仓
        for (const [dno, r] of Object.entries(db.agvTasks || {})) {
          const D = codeOf(dno);
          if (!(D === Q || TASKS.has(D))) continue;
          push(r.ex, 'agv', '🤖 执行完成 ' + dno, (r.sp ? r.sp + ' → ' + r.ep : '') + ' · 车' + (r.car || '') + ' · 耗时' + (r.dur || 0) + 's', '');
          push(r.fin, 'agv', '✅ 任务归档 ' + dno, '', '');
        }
        // — ⑧ 当前在架位置：框查询→仅本框(含兄弟)；零件查询→该零件全部框
        let onShelf = 0;
        for (const x of _lv) {
          const c = codeOf(x.c), p = codeOf(x.p);
          if (!(CODES.has(c) || c === Q || (partExpand && (PNS.has(p) || p === Q)))) continue;
          if (x.l) { onShelf++; push(x.t, 'shelf', '📦 在架 ' + String(x.c || ''), '库位 ' + String(x.l || '') + (x.p ? ' · 零件 ' + x.p : '') + ' · 数量 ' + (Number(x.q) || 0), ''); }
        }
        EV.sort((a, b) => a.t - b.t);
        const lastQ = qItems.length ? qItems[qItems.length - 1] : null;
        return send(res, 200, { ok: true, q: q0, kind: kind, count: EV.length, onShelf: onShelf, state: lastQ ? lastQ.state : '', codes: Array.from(CODES).slice(0, 20), pns: Array.from(PNS).slice(0, 20), tasks: Array.from(TASKS).slice(0, 20), reqs: Array.from(REQS).slice(0, 20), events: EV.slice(0, 400) });
      }
      if (req.method === 'GET' && p === '/api/part/profile') {
        const pn = String(url.searchParams.get('pn') || '').trim().toUpperCase();
        if (!pn) return send(res, 400, { ok: false, msg: '缺少 pn' });
        const bm = {};
        for (const x of ledgerView()) { // ㉖ 回填视图：旧版PDA推的空零件行按流水零件号归队（否则档案"在架框"漏框）
          if (String(x.p || '').toUpperCase() !== pn) continue;
          const k = boxKeyOf(x); const e = (bm[k] = bm[k] || { tags: [], locs: {}, q: 0, nm: '', last: 0 });
          e.tags.push(x.c); e.locs[String(x.l || '').toUpperCase()] = 1; e.q += Number(x.q) || 0; e.last = Math.max(e.last, Number(x.t) || 0); // ㉖ 框数量=框内各标签之和（一筐两标签各25→50；旧 max 假设作废）
          if (!e.nm && x.n) e.nm = String(x.n).slice(0, 80);
        }
        const boxes = Object.values(bm).map((b) => ({ loc: Object.keys(b.locs)[0] || '', tags: b.tags, q: b.q, last: b.last })).sort((a, x) => x.last - a.last);
        const qty = boxes.reduce((a, b) => a + b.q, 0);
        const _sl = Object.values(db.scanlog || {}).filter((st) => String(st.pn || '').toUpperCase() === pn).sort((a, x) => (x.t || 0) - (a.t || 0));
        // ㉖v83 漏登记标记：地面模式只选区排未落成格位（gl=粗码），或登记步骤失败——未作废、不在账本、也无出库史 = 实物在库系统查无，需去「修正与返架」补登记
        const _outCodes = new Set(); for (const o of Object.values(db.outbound || {})) for (const i of (o.items || [])) _outCodes.add(String(i.barcode || '').toUpperCase());
        const inb = _sl.slice(0, 60).map((st) => ({ t: Number(st.t) || 0, code: st.code, q: Number(st.q) || 0, lot: printLot(st.mk, st.lot), loc: (st.wt === 0 ? st.st : st.gl) || '', op: st.op || '', cx: !!st.cx, unreg: !st.cx && !(db.ledger || []).some((x) => String(x.c || '').toUpperCase() === String(st.code || '').toUpperCase()) && !_outCodes.has(String(st.code || '').toUpperCase()) && !db.seenOut[String(st.code || '').toUpperCase()] }));
        const outAll = [];
        for (const o of Object.values(db.outbound || {})) for (const i of (o.items || [])) { if (String(i.code || '').toUpperCase() !== pn) continue; outAll.push({ t: Number(o.createdAt) || 0, no: o.orderNo, q: Number(i.qty) || 0, tag: i.barcode || '', from: i.fromLoc || '', to: o.toLoc || '', req: o.linkReqNo || '', by: o.operator || '' }); }
        outAll.sort((a, x) => x.t - a.t);
        const demand = [];
        for (const r of db.requisitions || []) {
          if (!['pending', 'accepted'].includes(r.status)) continue;
          for (const it of r.items || []) {
            if (String(it.partNo || '').toUpperCase() !== pn) continue;
            const iss = (it.issued || []).reduce((a, e2) => a + (Number(typeof e2 === 'string' ? 0 : e2.q) || 0), 0);
            const need = (Number(it.qty) || 0) - iss; if (need > 1e-9) demand.push({ no: r.no, by: r.byName || '', status: r.status, need });
          }
        }
        const watchers = (db.watchlist || []).filter((w) => String(w.partNo || '').toUpperCase() === pn).map((w) => { const uu = db.users.find((x) => x.id === w.userId); return { uid: w.userId, name: uu ? uu.name : w.userId, at: w.at }; });
        let nm = ''; for (const b of Object.values(bm)) { if (b.nm) { nm = b.nm; break; } }
        if (!nm && inb.length) { const rec = Object.values(db.scanlog || {}).find((st) => String(st.pn || '').toUpperCase() === pn && st.nm); nm = rec ? rec.nm : ''; }
        if (!nm && db.itemDict && db.itemDict[pn]) nm = db.itemDict[pn].nm || '';
        return send(res, 200, { ok: true, pn, name: String(nm || '').slice(0, 80), boxes, qty, inb, inbTotal: _sl.filter((st) => !st.cx).length, out: outAll.slice(0, 200), outTotal: outAll.length, demand, watchers, watched: watchers.some((w) => w.uid === u.id) });
      }
      if (req.method === 'POST' && p === '/api/watchlist/rm') {
        if (u.role !== 'admin') return send(res, 403, { ok: false, msg: '仅管理员可代他人取消预约' });
        const b = await readBody(req);
        const pn = String(b.partNo || '').trim().toUpperCase(), uid = String(b.userId || '');
        const before = (db.watchlist || []).length;
        db.watchlist = (db.watchlist || []).filter((w) => !(String(w.partNo || '').toUpperCase() === pn && (!uid || w.userId === uid)));
        const cut = before - db.watchlist.length; if (cut) save();
        if (cut) pushOps(u, '取消预约', pn, uid);
        return send(res, 200, { ok: true, removed: cut });
      }
      // ㉖v94n 旧版 GET /api/watchlist 已删（与富化版重复且抢先命中——预约列表统一走下方富化端点）
      // ===== ㉕N5 任务六段流水线：排队→AGV接单→叉取→载货在途→到站→清台（队列+RCS在途节点+站台状态聚合，只读） =====
      if (req.method === 'GET' && p === '/api/agv/pipeline') {
        const nowMs = Date.now();
        const stn = db.rcsStations || {};
        const runBy = {}; for (const r of db.rcsRun || []) runBy[String(r.no)] = r;
        const stageOfCode = {}; // 框在某站台状态表里 → 5(到站有货待清) / 4(载货在途占位)
        for (const [k, v] of Object.entries(stn)) { for (const c of (v.codes || [])) { const C = String(c).toUpperCase(); if (!stageOfCode[C] || v.state === '有货') stageOfCode[C] = v.state === '有货' ? 5 : 4; } }
        const stages = [[], [], [], [], [], []];
        for (const q of db.agvQueue || []) {
          if (['完成', '取消', '失败'].includes(q.state)) continue;
          const code = String(q.code || '').toUpperCase();
          const rr = runBy[String(q.wmsTask || q.taskNo || '')] || null; // ㉖v94k 与 agvStage 同修：旧版拿容器号比RCS调度号永不命中→流水线全卡"AGV已接单"
          let stage;
          if (q.state === '排队') stage = 1;
          else if (stageOfCode[code]) stage = stageOfCode[code];
          else if (rr && rr.pickAt) stage = 4;                          // RCS已叉出货架、还没落进站台状态
          else if (q.state === '下发中' || q.state === '已下发') stage = rr ? 3 : 2; // 任务在RCS=叉取中；未同步到=AGV已接单
          else stage = 2;
          stages[stage - 1].push({ code, from: q.fromLoc || q.from || '', to: stnDisp(q.station || (rr ? (rr.ep || '') : '')), car: rr ? 'AGV' + String(rr.car || '').padStart(2, '0') : '', waitMs: Math.max(0, nowMs - (q.at || nowMs)), reqNo: q.reqNo || '', state: q.state, rush: !!q.rush, tr: ((q.trace || [])[0] || '') });
        }
        let bn = 0; stages.forEach((s, i) => { if (s.length > stages[bn].length) bn = i; });
        const names = ['排队待派', 'AGV已接单', '在架叉取中', '载货在途', '到站待清台', '压站滞留'];
        const bottleneck = stages[bn].length >= 3 ? { stage: bn + 1, name: names[bn], n: stages[bn].length } : null;
        return send(res, 200, { ok: true, at: new Date().toISOString(), names, stages, bottleneck, total: stages.reduce((s, a) => s + a.length, 0) });
      }
      if (req.method === 'GET' && p === '/api/agv/alarms') { // 当前活动告警（车辆页认领按钮数据源）
        const list = Object.entries(db.rcsCarAlarm || {}).map(([id, r]) => ({ id: Number(id) || id, fp: r.fp, since: r.since, severe: !!r.severe, ackBy: r.ackBy || '', ackAt: r.ackAt || 0, esc: r.esc || 0, red: (r.esc || 0) >= 2 })); // ㉖红牌=急停30分未处理(esc>=2)
        return send(res, 200, { ok: true, list });
      }
      if (req.method === 'POST' && p === '/api/agv/alarm/ack') { // G2 告警认领：body={id} 处理人落库+广播，停止升级
        if (!canFeature(u, 'agv_control')) return send(res, 403, { ok: false, msg: '无AGV操作权限' });
        const b = await readBody(req);
        const aid = b && b.id !== undefined && b.id !== null ? String(b.id) : '';
        if (!aid) return send(res, 400, { ok: false, msg: '缺少 id' });
        const rec = (db.rcsCarAlarm || {})[aid];
        if (!rec) return send(res, 400, { ok: false, msg: '该告警已恢复或不存在' });
        rec.ackBy = u.name; rec.ackAt = Date.now(); pushOps(u, '告警认领', 'AGV' + aid, rec.msg || ('车辆 ' + aid));
        const msg = `🙋 ${u.name} 已认领处理：AGV${String(aid).padStart(2, '0')}（${rec.fp}）`;
        db.users.filter((x) => (x.role === 'warehouse' || x.role === 'admin') && x.enabled).forEach((x) => notify(x.id, 'car_alarm', msg, ''));
        if (db.carAlarms) db.carAlarms.push({ at: Date.now(), id: aid, name: 'AGV' + String(aid).padStart(2, '0'), kind: 'ack', msg }); pushEvent('已认领', 'AGV' + String(aid).padStart(2, '0'), msg);
        save();
        return send(res, 200, { ok: true });
      }
      // ===== ㉒G5 账本修正（网页控制台风扇：改位/补登记/消位；原因必填+diff留痕+服务器权威时间戳） =====
      const locOk = (l) => /^NB0[23]-[A-H]-\d{1,2}-(\d{1,2}|[1-4]F)$/.test(l);
      if (req.method === 'POST' && p === '/api/ledger/fix') {
        if (!canFeature(u, 'location_reg')) return send(res, 403, { ok: false, msg: '当前角色未开通「位置登记」权限' });
        const b = await readBody(req);
        const act = String(b.action || ''), code = String(b.code || '').trim().toUpperCase(), loc = String(b.loc || '').trim().toUpperCase(), reason = String(b.reason || '').trim();
        if (!['move', 'add', 'remove'].includes(act)) return send(res, 400, { ok: false, msg: 'action 需为 move/add/remove' });
        if (!/^[A-Z0-9\-]{4,40}$/.test(code)) return send(res, 400, { ok: false, msg: '标签号格式不对' });
        if (!reason) return send(res, 400, { ok: false, msg: '原因必填（进审计）' });
        if (act !== 'remove' && !locOk(loc)) return send(res, 400, { ok: false, msg: '货位编码格式不符（例 NB02-A-08-2F / NB03-B-13-07）' });
        const cur = new Map(db.ledger.map((x) => [String(x.c).toUpperCase(), x]));
        const old = cur.get(code);
        // ㉓G13 行级基线：客户端声明"我以为这标签在哪"，与实况不符说明期间被人改过，拒写防覆盖
        if (b.baseLoc !== undefined) {
          const _bl = String(b.baseLoc || '').toUpperCase();
          const _now = old ? String(old.l).toUpperCase() : '';
          if (_bl !== _now) { pushEvent('改位冲突', u.name, `标签 ${code}：${_bl || '不在库'} → ${_now || '不在库'}（并发覆盖被拦）`); save(); return send(res, 409, { ok: false, code: 'conflict', rev: db.ledgerRev || 0, cur: _now || '不在库', msg: `标签 ${code} 期间已被他人变更（你看到的是${_bl || '不在库'}，现在${_now || '不在库'}），请核对后再操作` }); }
        }
        if (act === 'remove') {
          if (!old) return send(res, 400, { ok: false, msg: '该标签不在账本，无需消位' });
          const _nt = Date.now(); cur.delete(code); (db.ledgerTomb = db.ledgerTomb || []).push({ c: code, t: _nt, rec: _nt });
        } else {
          if (act === 'move' && !old) return send(res, 400, { ok: false, msg: '该标签不在账本，请用「补登记」' });
          if (act === 'add' && old) return send(res, 400, { ok: false, msg: '该标签已在 ' + old.l + '，改位置请用「改位」' });
          if (old && String(old.l).toUpperCase() === loc) return send(res, 400, { ok: false, msg: '目标货位与当前一致，无需修改' });
          const foreign = [...cur.values()].filter((x) => String(x.l).toUpperCase() === loc && String(x.c).toUpperCase() !== code);
          if (foreign.length) return send(res, 400, { ok: false, msg: '货位 ' + loc + ' 已登记给 ' + foreign[0].c + '，请先处理占用' });
          ledgerPut(cur, code, { c: code, l: loc, f: (old && old.f) || '', t: Date.now(), p: (old && old.p) || '', n: (old && old.n) || '', q: (old && old.q) || 0, b: (old && old.b) || '', pid: (old && old.pid) || '', mv: '人工', src: '网页修正', by: u.name, rec: Date.now() }, old);
          db.ledgerTomb = (db.ledgerTomb || []).filter((x) => String(x.c).toUpperCase() !== code); // 修正即复活，墓碑撤销
        }
        const fromL = old ? String(old.l).toUpperCase() : '';
        const _pre = partBoxCounts();
        db.ledger = [...cur.values()]; db.ledgerRev = (db.ledgerRev || 0) + 1; db.ledgerAt = new Date().toISOString(); db.ledgerBy = u.name;
        db.ledgerFixes = db.ledgerFixes || [];
        db.ledgerFixes.push({ time: new Date().toISOString(), by: u.name, act: { move: '改位', add: '补登记', remove: '消位' }[act], code, from: fromL, to: act !== 'remove' ? loc : '', reason });
        pushOps(u,'账本'+{move:'改位',add:'补登记',remove:'消位'}[act], code, (fromL||'无')+'→'+(act!=='remove'?loc:'出库')+' 原因:'+reason);
        if (db.ledgerFixes.length > 500) db.ledgerFixes = db.ledgerFixes.slice(-500);
        save(); stockWatchScan(_pre, u.name + '(网页修正)');
        console.log(`[ledger-fix] ${u.name} ${act} ${code} ${fromL}→${loc || '-'} 原因:${reason}`);
        return send(res, 200, { ok: true, msg: '已修正，账本v' + db.ledgerRev });
      }
      // ===== ㉒G4 返架登记：已出库/错发的框回仓（关联原出库单，服务器权威时间戳） =====
      if (req.method === 'POST' && p === '/api/ledger/return') {
        if (!canFeature(u, 'location_reg')) return send(res, 403, { ok: false, msg: '当前角色未开通「位置登记」权限' });
        const b = await readBody(req);
        const code = String(b.code || '').trim().toUpperCase(), loc = String(b.loc || '').trim().toUpperCase(), reason = String(b.reason || '').trim();
        if (!/^[A-Z0-9\-]{4,40}$/.test(code)) return send(res, 400, { ok: false, msg: '标签号格式不对' });
        if (!locOk(loc)) return send(res, 400, { ok: false, msg: '回库货位格式不符（例 NB02-A-08-2F / NB03-B-13-07）' });
        if (!reason) return send(res, 400, { ok: false, msg: '返架原因必填' });
        const cur = new Map(db.ledger.map((x) => [String(x.c).toUpperCase(), x]));
        if (cur.has(code)) return send(res, 400, { ok: false, msg: '该标签仍在账本（' + cur.get(code).l + '），未出库或已登记——请用「改位」' });
        // 物料信息：优先出库单明细，退回采集流水
        let info = { p: '', n: '', q: 0, b: '', f: '', pid: '' }, obNo = '';
        for (const o of Object.values(db.outbound || {})) { for (const it of (o.items || [])) { if (String(it.barcode || '').toUpperCase() === code) { info = { p: String(it.code || '').toUpperCase(), n: String(it.name || ''), q: Number(it.qty) || 0, b: '', f: '', pid: '' }; obNo = o.orderNo; } } }
        if (!info.p) for (const s of Object.values(db.scanlog || {})) { if (String(s.code || '').toUpperCase() === code) { info = { p: String(s.pn || ''), n: String(s.nm || ''), q: Number(s.q) || 0, b: String(s.lot || ''), f: String(s.ct || ''), pid: String(s.pid || '') }; break; } }
        const foreign = [...cur.values()].filter((x) => String(x.l).toUpperCase() === loc);
        if (foreign.length) return send(res, 400, { ok: false, msg: '货位 ' + loc + ' 已登记给 ' + foreign[0].c + '，请换位或先处理' });
        ledgerPut(cur, code, { c: code, l: loc, f: info.f, t: Date.now(), p: info.p, n: info.n, q: info.q, b: info.b, pid: info.pid, mv: '人工', src: '返架' + (obNo ? '(' + obNo + ')' : ''), by: u.name, rec: Date.now() }, cur.get(code));
        db.ledgerTomb = (db.ledgerTomb || []).filter((x) => String(x.c).toUpperCase() !== code);
        const _pre = partBoxCounts();
        db.ledger = [...cur.values()]; db.ledgerRev = (db.ledgerRev || 0) + 1; db.ledgerAt = new Date().toISOString(); db.ledgerBy = u.name;
        db.ledgerFixes = db.ledgerFixes || [];
        db.ledgerFixes.push({ time: new Date().toISOString(), by: u.name, act: '返架', code, from: obNo || '出库', to: loc, reason });
        pushOps(u,'返架', code, '原单'+(obNo||'?')+'→'+loc+' 原因:'+reason);
        if (db.ledgerFixes.length > 500) db.ledgerFixes = db.ledgerFixes.slice(-500);
        save(); stockWatchScan(_pre, u.name + '(返架)');
        console.log(`[return] ${u.name} 返架 ${code} →${loc} 原单${obNo || '?'} 原因:${reason}`);
        return send(res, 200, { ok: true, msg: '已返架入账本 v' + db.ledgerRev + (obNo ? '（关联原单 ' + obNo + '）' : '') });
      }
      if (req.method === 'GET' && p === '/api/ledger/fixes') {
        const lim = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '20') || 20));
        return send(res, 200, { ok: true, list: (db.ledgerFixes || []).slice(-lim).reverse() });
      }
      // ===== ㉕T2 盘点结果上收（方案6.4数据缺口①）：PDA 结束盘点后推送差异汇总，服务器落库供网页查看与D10导出 =====
      if (req.method === 'POST' && p === '/api/inventory/report') {
        if (!canFeature(u, 'inventory')) return send(res, 403, { ok: false, msg: '当前角色未开通盘点权限' });
        const b = await readBody(req);
        const batchId = String(b.batchId || '').trim().slice(0, 60);
        if (!batchId) return send(res, 400, { ok: false, msg: '缺少 batchId' });
        const num = (v) => Number(v) || 0;
        const parts = (Array.isArray(b.parts) ? b.parts : []).slice(0, 3000).map((x) => ({ pn: String(x.pn || '').toUpperCase().slice(0, 40), nm: String(x.nm || '').replace(/\uFFFD/g, '').slice(0, 80), book: num(x.book), real: num(x.real), boxes: num(x.boxes), out: num(x.out), warn: num(x.warn) }));
        const locs = (Array.isArray(b.locs) ? b.locs : []).slice(0, 5000).map((x) => ({ loc: String(x.loc || '').toUpperCase().slice(0, 40), pn: String(x.pn || '').toUpperCase().slice(0, 40), book: num(x.book), real: num(x.real), boxes: num(x.boxes) }));
        const rec = { batchId, remark: String(b.remark || '').slice(0, 80), scope: String(b.scope || '').slice(0, 120), blind: !!b.blind, bookKey: String(b.bookKey || '').slice(0, 60), locKey: String(b.locKey || '').slice(0, 60), by: u.name, at: num(b.at) || Date.now(), totalScans: num(b.totalScans), validScans: num(b.validScans), mesFail: num(b.mesFail), dup: num(b.dup), outside: num(b.outside), applied: !!b.applied, applyTime: num(b.applyTime), parts, locs };
        // ㉖v95 实时基准快照留痕透传（白名单定长清洗，旧版PDA不带该字段=undefined不影响）
        if (b.liveMeta && typeof b.liveMeta === 'object') {
          rec.liveMeta = {
            pullOk: b.liveMeta.pullOk === true,
            srvRev: num(b.liveMeta.srvRev), srvTotal: num(b.liveMeta.srvTotal),
            srvAt: String(b.liveMeta.srvAt || '').slice(0, 40), srvBy: String(b.liveMeta.srvBy || '').slice(0, 40),
            localRows: num(b.liveMeta.localRows), bookRows: num(b.liveMeta.bookRows), locRows: num(b.liveMeta.locRows),
            msg: String(b.liveMeta.msg || '').replace(/\uFFFD/g, '').slice(0, 160),
          };
        }
        db.inventories = db.inventories || {};
        db.inventories[batchId] = rec; save();
        pushOps(u, '盘点上收', batchId, `零件${parts.length}行 货位${locs.length}行 实扫${rec.validScans}/${rec.totalScans}`);
        console.log(`[inv] ${u.name} 上收盘点 ${batchId}：零件${parts.length} 货位${locs.length} 盈亏异常${parts.filter((p) => Math.abs(p.real - p.book) > 1e-6).length}`);
        return send(res, 200, { ok: true, msg: '盘点结果已上收' });
      }
      if (req.method === 'GET' && p === '/api/inventory/list') {
        const lim = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '20') || 20));
        const list = Object.values(db.inventories || {}).sort((a, b) => b.at - a.at).slice(0, lim).map((r) => ({ batchId: r.batchId, remark: r.remark, by: r.by, at: r.at, blind: r.blind, totalScans: r.totalScans, validScans: r.validScans, partN: (r.parts || []).length, diffN: (r.parts || []).filter((p) => Math.abs(p.real - p.book) > 1e-6).length, locN: (r.locs || []).length, locDiffN: (r.locs || []).filter((l) => Math.abs(l.real - l.book) > 1e-6).length, applied: r.applied }));
        return send(res, 200, { ok: true, list });
      }
      if (req.method === 'GET' && p === '/api/inventory/get') {
        const id = String(url.searchParams.get('batchId') || '').trim();
        const r = (db.inventories || {})[id];
        if (!r) return send(res, 404, { ok: false, msg: '无此盘点记录' });
        return send(res, 200, { ok: true, rec: r });
      }
      // ===== ㉓导出中心：GET /api/export?ds=..&fmt=..&from=&to=[&preview=1] ㉔快照落盘可重下 =====
      if (req.method === 'GET' && p === '/api/export') {
        const ds = String(url.searchParams.get('ds') || '').toUpperCase();
        if (ds === 'D9' && u.role !== 'admin') return send(res, 403, { ok: false, msg: '活动流审计仅管理员可导出' }); // ㉕A1 角色门禁（方案6.6）
        if ((ds === 'D8' || ds === 'D10') && u.role === 'material') return send(res, 403, { ok: false, msg: '该数据集需仓管员/管理员权限' });
        const fmt = ['xls', 'json'].includes(url.searchParams.get('fmt')) ? url.searchParams.get('fmt') : 'csv';
        const fRaw = { from: url.searchParams.get('from') || '', to: url.searchParams.get('to') || '', batchId: url.searchParams.get('batchId') || '', arch: url.searchParams.get('arch') || '', zero: url.searchParams.get('zero') || '' };
        let d;
        try { d = buildExport(ds, fRaw); } catch (e) { return send(res, 500, { ok: false, msg: '导出构建失败：' + e.message }); }
        if (!d) return send(res, 400, { ok: false, msg: 'ds 需为 D1库位表/D2库存汇总/D3入库/D4出库/D5AGV任务/D6异常/D7工作量/D8领料/PACK对账包' });
        if (url.searchParams.get('preview') === '1') { // ㉔铁律4：先预览后导出（前20行+总行数，不落盘不登记）
          const _p0 = (d.parts && d.parts[0]) || d; // ㉖v61 多sheet数据集(D7工作量/PACK对账包)：预览取首sheet表头与样例行
          const cols = (_p0.headers || d.headers || []).length;
          const rowsAll = _p0.rows || d.rows || [];
          const cells = rowsAll.slice(0, 20).map((r) => r.map((v) => String(v === undefined || v === null ? '' : v).slice(0, 40)));
          const flat = rowsAll.reduce((s, r) => s + r.reduce((a, v) => a + String(v === undefined || v === null ? '' : v).length + 1, 0), 0);
          const sheets = d.parts ? d.parts.map((pp) => ({ name: pp.label, rows: (pp.rows || []).length, cols: (pp.headers || []).length })) : null;
          return send(res, 200, { ok: true, label: d.label, total: d.total, cols, head: _p0.headers || d.headers, sample: cells, estBytes: flat, sheets: sheets, sheetName: sheets ? _p0.label : null });
        }
        if (fmt === 'json') { // ㉕F8 JSON导出（SAP/BI对接：血缘+数据双段，同样登记快照可重下）
          const jp = d.parts || [d]; const jo = { lineage: { ds: d.label, src: jp.map((p) => p.src).join('；'), filter: d.f, by: u.name, at: new Date().toISOString(), caliber: (EXP_CAL[d.label] || []).concat(jp.flatMap((p) => p.caliber || [])) }, sheets: jp.map((p) => ({ name: p.label, headers: p.headers || [], rows: p.rows || [] })) };
          const _bx = JSON.stringify(jo, null, 1); const _sj = crypto.createHash('sha1').update(_bx, 'utf8').digest('hex').slice(0, 12);
          db.exports = db.exports || []; const expId = 'exp' + (db.exports.length + 1);
          db.exports.push({ id: expId, at: Date.now(), by: u.name, ds: d.label, fmt: 'json', f: d.f, rows: d.total, sha: _sj }); save();
          try { const _ed = path.join(DATA_DIR, 'exports'); fs.mkdirSync(_ed, { recursive: true }); fs.writeFileSync(path.join(_ed, expId + '.json'), _bx); } catch (_) {}
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${ds}_${expId}.json"; filename*=UTF-8''${encodeURIComponent(d.label + '_' + expId + '.json')}`, 'Content-Length': Buffer.byteLength(_bx) });
          res.end(_bx); pushOps(u, '数据导出', d.label, 'json ' + d.total + '行'); console.log(`[export] ${u.name} 导出 ${d.label} json ${d.total}行 ${expId}`); return;
        }
        const crypto2 = require('crypto');
        let body, mime, ext;
        if (fmt === 'xls' || ds === 'PACK' || ds === 'D7' || ds === 'D10') { body = expXls(d); mime = 'application/vnd.ms-excel'; ext = 'xls'; }
        else { body = expCsv(d, ['expId=待分配', 'ds=' + d.label, 'by=' + u.name, 'at=' + new Date().toISOString(), 'filter=' + JSON.stringify(d.f)]); mime = 'text/csv'; ext = 'csv'; }
        const sha = crypto2.createHash('sha1').update(body, 'utf8').digest('hex').slice(0, 12);
        db.exports = db.exports || [];
        const expId = 'exp' + (db.exports.length + 1);
        db.exports.push({ id: expId, at: Date.now(), by: u.name, ds: d.label, fmt: ext, f: d.f, rows: d.total, sha });
        pushOps(u,'数据导出', d.label, ext+' '+d.total+'行 条件:'+JSON.stringify(d.f));
        if (db.exports.length > 2000) db.exports = db.exports.slice(-2000);
        save();
        if (ext === 'csv') { body = body.replace('#expId=待分配', '#expId=' + expId); } // 血缘回填（哈希与内容不再对应，仅登记用）
        const cn = encodeURIComponent(`${d.label}_${fRaw.from || ''}${fRaw.to ? '~' + fRaw.to : ''}_${expId}.${ext}`);
        try { // ㉔快照落盘：重下同一份字节；90天轮删
          const _ed = path.join(DATA_DIR, 'exports'); fs.mkdirSync(_ed, { recursive: true });
          fs.writeFileSync(path.join(_ed, expId + '.' + ext), body);
          const _fl = fs.readdirSync(_ed).filter((x) => /^exp\d+\./.test(x)).map((x) => [x, fs.statSync(path.join(_ed, x)).mtimeMs]).sort((a, b) => a[1] - b[1]);
          while (_fl.length && Date.now() - _fl[0][1] > 90 * 86400000) { try { fs.unlinkSync(path.join(_ed, _fl.shift()[0])); } catch (_) { break; } }
        } catch (e) { console.log('[export] 快照落盘失败（不影响本次下载）：', e.message); }
        res.writeHead(200, { 'Content-Type': mime + '; charset=utf-8', 'Content-Disposition': `attachment; filename="${ds}_${expId}.${ext}"; filename*=UTF-8''${cn}`, 'Content-Length': Buffer.byteLength(body) });
        res.end(body);
        console.log(`[export] ${u.name} 导出 ${d.label} ${ext} ${d.total}行 ${expId} sha=${sha}`);
        return;
      }
      // ===== ㉔导出重下：凭历史ID取落盘快照（同一份字节） =====
      if (req.method === 'GET' && p === '/api/export/get') {
        const eid = String(url.searchParams.get('id') || '');
        if (!/^exp\d{1,8}$/.test(eid)) return send(res, 400, { ok: false, msg: 'id 格式不对' });
        const rec = (db.exports || []).find((x) => x.id === eid);
        if (!rec) return send(res, 404, { ok: false, msg: '无此导出记录' });
        if (!expRoleOk(u, rec.ds)) return send(res, 403, { ok: false, msg: '该数据集需更高权限' }); // ㉕A1 重下同门禁
        const fp = path.join(DATA_DIR, 'exports', eid + '.' + rec.fmt);
        if (!fs.existsSync(fp)) return send(res, 404, { ok: false, msg: '快照文件已过期清理（保留90天），请重新导出' });
        const buf = fs.readFileSync(fp);
        res.writeHead(200, { 'Content-Type': (rec.fmt === 'xls' ? 'application/vnd.ms-excel' : rec.fmt === 'json' ? 'application/json' : 'text/csv') + '; charset=utf-8', 'Content-Disposition': `attachment; filename="${eid}.${rec.fmt}"; filename*=UTF-8''${encodeURIComponent(rec.ds + '_重下_' + eid + '.' + rec.fmt)}`, 'Content-Length': buf.length });
        res.end(buf);
        console.log(`[export] ${u.name} 重下 ${eid}（${rec.ds}）`);
        return;
      }
      if (req.method === 'GET' && p === '/api/exports') {
        const lim = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') || '50') || 50));
        const vis = (db.exports || []).filter((e) => expRoleOk(u, e.ds)); // ㉕A1 无权重数据集不出现在历史列表
        return send(res, 200, { ok: true, list: vis.slice(-lim).reverse().map((e) => ({ ...e, at: expTs(e.at) })) });
      }
      if (req.method === 'GET' && p === '/api/agv/events') {
        return send(res, 200, { ok: true, list: buildEvents() });
      }
      if (req.method === 'GET' && p === '/api/agv/stntl') { // ㉔站台状态时间线（甘特数据源，近8h）
        const nowMs = Date.now(), cut = nowMs - P().ganttH * 3600 * 1000; // ㉖ 甘特窗可调（原8h）
        const out = {}; for (const [k, a] of Object.entries(db.stnTl || {})) { const seg = a.filter((x) => x.t >= cut); if (seg.length) out[k] = seg; }
        for (const k of AGV_STNS) { if (!out[k]) out[k] = [{ s: '空闲', t: cut }]; else if (Number(out[k][0].t) > cut) out[k] = [{ s: '空闲', t: cut }].concat(out[k]); } // ㉖ 全 12 台都出：窗口内无记录的时段补空闲（含"有部分历史"的台），甘特不再留灰空白
        return send(res, 200, { ok: true, tl: out, all: AGV_STNS, winMs: nowMs - cut, at: new Date(nowMs).toISOString() });
      }
      if (req.method === 'GET' && p === '/api/agv/trail') {
        const mins = Math.min(1440, Math.max(5, parseInt(url.searchParams.get('mins') || '360') || 360));
        const cut = Date.now() - mins * 60000;
        return send(res, 200, { ok: true, points: (db.trail || []).filter((p) => p.ts >= cut) });
      }
      if (req.method === 'GET' && p === '/api/dict') {
        const q = (url.searchParams.get('q') || '').trim().toUpperCase();
        let list = Object.entries(db.itemDict || {}).map(([pn, v]) => ({ pn, nm: v.nm, src: v.src }));
        // ㉖v95b 联想数据源合并账本在架零件（字典可能滞后于账本，领料新建弹层按此自动带名）
        { const _have = new Set(list.map((x) => x.pn));
          for (const x of db.ledger || []) { const pn = String(x.p || '').toUpperCase(); if (!pn || _have.has(pn)) continue; _have.add(pn); list.push({ pn, nm: String(x.n || '').replace(/[\uFFFD]/g, ''), src: '账本' }); } }
        if (q) list = list.filter((x) => x.pn.includes(q) || x.nm.toUpperCase().includes(q));
        list.sort((a, b) => a.pn.localeCompare(b.pn));
        if ((url.searchParams.get('miss') || '') === '1') { // ㉖G8 缺口扫描：出现在账本/流水/出库/领料但字典无名的零件号
          const named = new Set(Object.entries(db.itemDict || {}).filter(([, v]) => String(v && v.nm || '').trim()).map(([k]) => k));
          const seen = {};
          const feed = (pn, hint) => { pn = String(pn || '').toUpperCase().trim(); if (!pn || named.has(pn)) return; const e = (seen[pn] = seen[pn] || { pn, src: '', n: 0 }); e.n++; if (!e.src && hint) e.src = hint; };
          for (const x of db.ledger || []) feed(x.p, '账本');
          for (const st of Object.values(db.scanlog || {})) feed(st.pn, '入库流水');
          for (const o of Object.values(db.outbound || {})) for (const i of (o.items || [])) feed(i.code || i.pn, '出库单');
          for (const r of db.requisitions || []) for (const it of (r.items || [])) feed(it.partNo, '领料单');
          const miss = Object.values(seen).sort((a, b) => b.n - a.n || a.pn.localeCompare(b.pn));
          return send(res, 200, { ok: true, miss: true, total: miss.length, list: miss.slice(0, 500) });
        }
        return send(res, 200, { ok: true, total: list.length, list: list.slice(0, q ? 300 : 6000) }); // ㉖v95b 无q=领料联想全量缓存（局域网一次性拉取）
      }
      // ---- ㉖G8 批量补录：items=[{pn,nm}] 或 text="零件号,名称"逐行；仅仓管/管理员；进字典+活动流 ----
      if (req.method === 'POST' && p === '/api/dict') {
        if (u.role !== 'warehouse' && u.role !== 'admin') return send(res, 403, { ok: false, msg: '仅仓管员/管理员可补录物料字典' });
        const b = await readBody(req);
        let pairs = [];
        if (Array.isArray(b.items)) pairs = b.items.map((it) => [String((it && it.pn) || ''), String((it && it.nm) || '')]);
        else if (typeof b.text === 'string') pairs = b.text.split(/[\r\n]+/).map((l) => { const i = l.search(/[，,\t]/); return i < 0 ? [l, ''] : [l.slice(0, i), l.slice(i + 1)]; });
        db.itemDict = db.itemDict || {};
        let set = 0, skip = 0;
        for (let pr of pairs) {
          let pn = String(pr[0] || '').toUpperCase().trim(), nm = String(pr[1] || '').trim().replace(/[，,\t]/g, ' ');
          if (!pn || pn.length > 40 || !nm) { skip++; continue; }
          if (nm.length > 80) nm = nm.slice(0, 80);
          const old = db.itemDict[pn];
          if (old && old.nm === nm) { skip++; continue; }
          db.itemDict[pn] = { nm, unit: (old && old.unit) || '', src: '手工补录', by: u.name, at: Date.now() };
          set++;
        }
        save(); pushOps(u, '补录字典', set + '项', skip ? ('跳过' + skip) : '');
        console.log(`[dict] ${u.name} 批量补录 ${set} 项`);
        return send(res, 200, { ok: true, set, skip });
      }
      // ---- ㉖G8 交叉自愈：凡同一零件号在 ledger/scanlog/outbound 任一处有名字，补进字典无名项（零外部请求）----
      if (req.method === 'POST' && p === '/api/dict/heal') {
        if (u.role !== 'warehouse' && u.role !== 'admin') return send(res, 403, { ok: false, msg: '仅仓管员/管理员可执行' });
        db.itemDict = db.itemDict || {};
        const cand = {};
        const give = (pn, nm) => { pn = String(pn || '').toUpperCase().trim(); nm = String(nm || '').replace(/\uFFFD/g, '').trim(); if (!pn || !nm || pn.length > 40 || nm.length > 80) return; if (!cand[pn]) cand[pn] = nm.slice(0, 80); };
        for (const x of db.ledger || []) give(x.p, x.n);
        for (const st of Object.values(db.scanlog || {})) give(st.pn, st.nm);
        for (const o of Object.values(db.outbound || {})) for (const i of (o.items || [])) give(i.code || i.pn, i.name);
        let healed = 0;
        for (const kv of Object.entries(cand)) { const pn = kv[0], nm = kv[1]; const old = db.itemDict[pn]; if (!old || !String(old.nm || '').trim()) { db.itemDict[pn] = Object.assign({}, old, { nm, src: (old && old.src) || '交叉补全', by: u.name, at: Date.now() }); healed++; } }
        save(); pushOps(u, '字典交叉补全', healed + '项', '');
        console.log(`[dict] ${u.name} 交叉自愈 ${healed} 项`);
        return send(res, 200, { ok: true, healed });
      }
      // ===== ㉓G12 在线工作量报表：?from=YYYY-MM-DD&to=YYYY-MM-DD（缺省近14天），管理员/仓管可见 =====
      if (req.method === 'GET' && p === '/api/report/work') {
        if (u.role !== 'admin' && u.role !== 'warehouse') return send(res, 403, { ok: false, msg: '工作量报表仅管理员/仓管员可见' });
        const fr = String(url.searchParams.get('from') || ''), tt = String(url.searchParams.get('to') || '');
        const F = fr ? Date.parse(fr + 'T00:00:00') : Date.now() - 14 * 864e5;
        const T = tt ? Date.parse(tt + 'T23:59:59') : Date.now();
        if (!Number.isFinite(F) || !Number.isFinite(T) || F > T) return send(res, 400, { ok: false, msg: '日期范围不对' });
        const w = buildWork(F, T);
        const ps = Object.values(w.persons).sort((a, b) => (b.inB + b.outB + b.outQ / 20 + b.acc + b.fix + b.ret) - (a.inB + a.outB + a.outQ / 20 + a.acc + a.fix + a.ret))
          .map((p) => ({ ...p, avgAccMin: p.finN ? Math.round(p.finMin / p.finN) : null, days: undefined }));
        const ds = Object.keys(w.days).sort().map((k) => ({ day: k, ...w.days[k] }));
        const cs = Object.keys(w.cars).sort().map((k) => ({ car: k, ...w.cars[k], avgDur: w.cars[k].n ? Math.round(w.cars[k].dur / w.cars[k].n) : 0, dur: undefined }));
        return send(res, 200, { ok: true, from: wdstr(F), to: wdstr(T), persons: ps, days: ds, cars: cs });
      }
      // ===== ㉖v52 分析报表：日/周/月（日=当天快照；周/月=日快照现场聚合；缺日标 missing，支持回填）=====
      if (req.method === 'GET' && p === '/api/report/analytics') {
        if (u.role !== 'admin' && u.role !== 'warehouse') return send(res, 403, { ok: false, msg: '分析报表仅管理员/仓管员可见' });
        const g = String(url.searchParams.get('g') || 'day'), end = String(url.searchParams.get('end') || rptDayKey(new Date()));
        if (!/^\d{4}-\d{2}-\d{2}$/.test(end) || rptDayKey(new Date(rptKeys(end))) !== end) return send(res, 400, { ok: false, msg: 'end 需为存在的日期 YYYY-MM-DD' });
        const load = (key) => { try { return JSON.parse(fs.readFileSync(path.join(RPT_DIR(), 'daily-' + key + '.json'), 'utf8')); } catch (_) { return null; } }
        const days = []; const endMs = rptKeys(end);
        if (g === 'week') { const dow = (new Date(endMs).getDay() + 6) % 7; for (let i = 0; i < 7; i++) days.push(rptDayKey(new Date(endMs + (i - dow) * 864e5))); } // 周一为一周起点
        else if (g === 'month') { const [y, m] = end.split('-').map(Number); const last = new Date(y, m, 0).getDate(); for (let d = 1; d <= last; d++) days.push(y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0')); }
        else days.push(end);
        const missing = [];
        let snaps = days.map((k) => { const r = load(k); if (!r) missing.push(k); return r; }).filter(Boolean);
        if (g === 'day' && !snaps.length) { try { snaps = [buildDayReport(end)]; } catch (_) {} } // 当天实时预览（未固化）
        const prevDays = g === 'day' ? [rptDayKey(new Date(endMs - 864e5))] : g === 'week' ? days.map((k) => rptDayKey(new Date(rptKeys(k) - 7 * 864e5))) : (() => { const out = []; const [y, m] = end.split('-').map(Number); const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1; const last = new Date(py, pm, 0).getDate(); for (let d = 1; d <= last; d++) out.push(py + '-' + String(pm).padStart(2, '0') + '-' + String(d).padStart(2, '0')); return out; })();
        const prev = prevDays.map(load).filter(Boolean);
        const cur = rptAggregate(snaps), pv = rptAggregate(prev);
        const rng = days[0] === days[days.length - 1] ? days[0] : days[0] + ' ~ ' + days[days.length - 1];
        return send(res, 200, { ok: true, g, range: rng, days: days.length, loaded: snaps.length, missing, cur, prev: prev.length ? pv : null, prevDays: prev.length, trend: g === 'day' ? null : snaps.map((r) => ({ day: r.day, inB: r.work.inB, outB: r.work.outB, created: (r.reqs || {}).created || 0, agv: r.agv.n, ev: r.eventsTotal || 0 })) });
      }
      if (req.method === 'POST' && p === '/api/report/backfill') {
        if (u.role !== 'admin') return send(res, 403, { ok: false, msg: '仅管理员可回填快照' });
        const b = await readBody(req);
        const from = String(b.from || ''), to = String(b.to || '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return send(res, 400, { ok: false, msg: 'from/to 需为 YYYY-MM-DD' });
        let n = 0, done = 0;
        for (let ms = rptKeys(from); ms <= rptKeys(to); ms += 864e5) {
          n++; const key = rptDayKey(new Date(ms));
          const f = path.join(RPT_DIR(), 'daily-' + key + '.json');
          if (fs.existsSync(f)) continue;
          try { fs.writeFileSync(f, JSON.stringify(buildDayReport(key))); done++; } catch (_) {}
        }
        pushOps(u, '报表回填', from + '~' + to, '新增 ' + done + '/' + n + ' 天快照');
        return send(res, 200, { ok: true, total: n, created: done });
      }
      if (req.method === 'POST' && p === '/api/watchlist') { // ㉖v94n 预约升级：qty=预订框数(0=仅提醒型旧行为)，due=期望到货日，auto=够数自动开领料单
        const b = await readBody(req);
        const pn = String(b.partNo || '').trim().toUpperCase().slice(0, 40);
        if (!pn) return send(res, 400, { ok: false, msg: '缺少 partNo' });
        db.watchlist = db.watchlist || [];
        if (b.on === false) { db.watchlist = db.watchlist.filter((w) => !(w.userId === u.id && w.partNo === pn)); save(); return send(res, 200, { ok: true, off: true }); }
        const qty = Math.max(0, Math.min(9999, Number(b.qty) || 0));
        const due = /^\d{4}-\d{2}-\d{2}$/.test(String(b.due || '')) ? String(b.due) : '';
        const itemName = String(b.itemName || '').slice(0, 60);
        const auto = b.auto !== false;
        let w = db.watchlist.find((x) => x.userId === u.id && x.partNo === pn);
        if (!w) {
          if (db.watchlist.length > 3000) return send(res, 400, { ok: false, msg: '预约条目已满，请先清理' });
          w = { userId: u.id, partNo: pn, at: Date.now() }; db.watchlist.push(w);
        } else if (qty > 0 && (w.qty !== qty || w.filledReq)) { w.got = 0; w.arrDate = ''; w.arrLast = 0; w.notifiedGot = 0; w.filledReq = ''; w.filledAt = 0; } // ㉖v94n 改数量或已履行过=新一轮：到料计数清零重计（旧单消耗不影响新轮计数）
        w.qty = qty; w.auto = auto; w.due = due; if (itemName) w.itemName = itemName;
        save();
        return send(res, 200, { ok: true, entry: w });
      }
      if (req.method === 'GET' && p === '/api/watchlist') { // ㉖v94n 富化：库存/进度/履行状态/逾期，PDA列表直接渲染
        const _post = partBoxCounts();
        const list = (db.watchlist || []).filter((w) => w.userId === u.id).map((w) => {
          const p = String(w.partNo || '').toUpperCase(), cur = _post[p] || 0, wq = Number(w.qty) || 0;
          const req0 = w.filledReq && !['dup', 'auto-off', 'no-user', 'no-perm'].includes(w.filledReq) ? (db.requisitions || []).find((x) => x.id === w.filledReq) : null;
          return Object.assign({}, w, { stock: cur, arrived: Math.max(0, Number(w.got) || 0), target: wq,
            done: !!w.filledReq, reqNo: req0 ? req0.no : w.filledReq === 'dup' ? '已有未完单未重复开' : w.filledReq === 'auto-off' ? '够数已提醒(未自动开)' : w.filledReq ? '已提醒仓管' : '',
            overdue: !!(wq && !w.filledReq && w.due && Date.now() > new Date(w.due + 'T23:59:59').getTime()) });
        });
        return send(res, 200, { ok: true, list });
      }
      // ===== ㉖ 容器类型可配置：GET 登录即可读（采集页按钮数据源）；POST 仓管/管理员整表保存（留痕） =====
      if (req.method === 'GET' && p === '/api/containers') {
        const _gzr = db.gndZoneRows || {}, _goff = db.gndRowOff || {}, _glist = db.gndZoneList || {}; // ㉖v59 按区排数覆盖+停用排下发（zoneRows=各区有效排数，offs=停用排键集）；v90 lists=真实排号清单
        return send(res, 200, { ok: true, types: db.containerTypes || defaultDb().containerTypes, rack: { count: P().rackCount, cols: P().rackCols, tiers: P().rackTiers }, gnd: { zones: P().gndZones, rows: P().gndRows, cols: P().gndCols, zoneRows: _gzr, lists: _glist, offs: _goff } }); // ㉖v56 高架+地面格位规格下发（参数可调）
      }
      if (req.method === 'POST' && p === '/api/containers') {
        if (!canFeature(u, 'location_reg')) return send(res, 403, { ok: false, msg: '当前角色未开通「位置登记」权限' });
        const b = await readBody(req);
        const raw = Array.isArray(b.types) ? b.types : [];
        if (!raw.length || raw.length > 20) return send(res, 400, { ok: false, msg: 'types 需1~20项' });
        const seen = new Set(); const clean = [];
        for (const t of raw) {
          const dbv = String((t && t.db) || '').trim().slice(0, 40), show = String((t && t.show) || '').trim().slice(0, 12);
          if (!dbv || !show || seen.has(dbv.toUpperCase())) continue;
          seen.add(dbv.toUpperCase()); clean.push({ db: dbv, show });
        }
        if (!clean.length) return send(res, 400, { ok: false, msg: '无有效条目（需 db 落库值 + show 显示名）' });
        db.containerTypes = clean; cfgBump(); save();
        pushOps(u, '容器类型配置', clean.length + ' 项', clean.map((x) => x.show).join('、'));
        return send(res, 200, { ok: true, types: clean, msg: '已保存，全端下次进入采集页生效' });
      }
      // ---- ㉖v69 零件全集背书：字典∪账本∪流水∪出库∪领料 出现过的全部零件号（缺料反馈判"零库存"的地基，不随流水清空而丢失）----
      if (req.method === 'GET' && p === '/api/parts/backing') {
        const s = new Set();
        for (const pn of Object.keys(db.itemDict || {})) s.add(pn);
        for (const x of db.ledger || []) { const pn = String(x.p || '').toUpperCase().trim(); if (pn) s.add(pn); }
        for (const st of Object.values(db.scanlog || {})) { const pn = String(st.pn || '').toUpperCase().trim(); if (pn) s.add(pn); }
        for (const o of Object.values(db.outbound || {})) for (const i of (o.items || [])) { const pn = String(i.code || i.pn || '').toUpperCase().trim(); if (pn) s.add(pn); }
        for (const r of db.requisitions || []) for (const it of (r.items || [])) { const pn = String(it.partNo || '').toUpperCase().trim(); if (pn) s.add(pn); }
        return send(res, 200, { ok: true, total: s.size, list: [...s].map((pn) => ({ pn, nm: (db.itemDict && db.itemDict[pn] && db.itemDict[pn].nm) || '' })) });
      }
      // ===== ㉖v63 断料预测：日均耗用（近N天出库）÷ 在架 = 还能撑几天，红<3/黄3~7/绿>7 =====
      if (req.method === 'GET' && p === '/api/stock/risk') {
        const r = stockRiskOf(url.searchParams.get('days'));
        return send(res, 200, { ok: true, days: r.days, red: r.red, yellow: r.yellow, total: r.list.length, list: r.list.slice(0, 300) });
      }
      // ===== ㉖v63 循环盘点：当日随机抽查计划 + 逐格验证留痕（扫到=ok，扫出别的=diff，没货=miss） =====
      if (p === '/api/cycle') {
        if (req.method === 'GET') {
          const pl = cyclePlanOf(Number(url.searchParams.get('n')) || 20);
          const done = (db.cycleLog || {})[pl.day] || {};
          return send(res, 200, { ok: true, day: pl.day, locs: pl.locs.map((l) => { const expect = (db.ledger || []).filter((x) => String(x.l || '').toUpperCase() === l); const d0 = done[l]; return { loc: l, expect: expect.map((x) => ({ c: x.c, p: x.p || '', q: Number(x.q) || 0 })), v: d0 || null }; }) });
        }
        if (req.method === 'POST') {
          if (!canFeature(u, 'inventory')) return send(res, 403, { ok: false, msg: '当前角色未开通盘点权限' });
          const b = await readBody(req);
          const loc = String(b.loc || '').trim().toUpperCase();
          const code = String(b.code || '').trim().toUpperCase();
          if (!loc || !code) return send(res, 400, { ok: false, msg: '缺少 loc/code' });
          const pl = cyclePlanOf(20);
          if (!(pl.locs || []).includes(loc)) return send(res, 400, { ok: false, msg: '该格不在今日抽查计划内' });
          const inLed = (db.ledger || []).filter((x) => String(x.l || '').toUpperCase() === loc);
          const found = inLed.find((x) => String(x.c || '').toUpperCase() === code);
          const v = found ? { r: 'ok', by: u.name, at: Date.now() } : (code === 'EMPTY' ? { r: 'miss', by: u.name, at: Date.now(), note: inLed.length ? '账本记有 ' + inLed.length + ' 框但现场无货' : '账本本就无记录' } : { r: 'diff', by: u.name, at: Date.now(), note: '实扫 ' + code + '，账本记 ' + (inLed.map((x) => x.c).join('、') || '空') });
          db.cycleLog = db.cycleLog || {};
          (db.cycleLog[pl.day] = db.cycleLog[pl.day] || {})[loc] = v;
          const ks = Object.keys(db.cycleLog).sort(); while (ks.length > 7) { delete db.cycleLog[ks[0]]; ks.shift(); }
          if (v.r !== 'ok') pushOps(u, '循环盘点差异', loc, v.note + '（' + u.name + '）');
          save();
          return send(res, 200, { ok: true, r: v.r, note: v.note || '' });
        }
      }
      // ===== ㉖v63 呆滞料排行：按零件聚合 ≥N 天未动格位（格数/件数/最长滞留），一键移地面 =====
      if (req.method === 'GET' && p === '/api/slow-moving') {
        const minD = Math.min(180, Math.max(3, Number(url.searchParams.get('minDays')) || 14));
        const nowMs = Date.now();
        const byPn = {};
        for (const l of db.ledger || []) {
          const t = Number(l.rec || l.t) || 0; const ageD = Math.floor((nowMs - t) / 864e5);
          if (ageD < minD) continue;
          const pn = String(l.p || '').toUpperCase() || '(无零件号)';
          const a = byPn[pn] = byPn[pn] || { pn, nm: (db.itemDict && db.itemDict[pn] && db.itemDict[pn].nm) || l.n || '', cells: {}, qty: 0, maxAge: 0, codes: [] };
          a.cells[String(l.l || '').toUpperCase()] = 1; a.qty += Number(l.q) || 0;
          if (ageD > a.maxAge) a.maxAge = ageD;
          if (a.codes.length < 8) a.codes.push(String(l.c || '').toUpperCase());
        }
        const list = Object.values(byPn).map((a) => ({ ...a, cells: Object.keys(a.cells).length })).sort((x, y) => y.qty - x.qty || y.maxAge - x.maxAge);
        return send(res, 200, { ok: true, minDays: minD, total: list.length, list: list.slice(0, 100) });
      }
      // ===== ㉖v63 AGV 运力体检：近N天任务底仓——车均负载/单趟均时/峰值并发/忙时分布 =====
      if (req.method === 'GET' && p === '/api/agv/capacity') {
        const N = Math.min(90, Math.max(1, Number(url.searchParams.get('days')) || 7));
        const cut = Date.now() - N * 864e5;
        const tasks = Object.values(db.agvTasks || {}).filter((t) => (t.fin || 0) >= cut);
        const byCar = {};
        for (const t of tasks) { const c = t.car || 0; const b = byCar[c] = byCar[c] || { car: c, n: 0, dur: 0, dn: 0, out: 0, in: 0 }; b.n++; if (t.dur > 0) { b.dur += t.dur; b.dn++; } if (t.ck === 'out') b.out++; else if (t.ck === 'in') b.in++; }
        // 峰值并发：ex..fin 区间扫描线（30 分钟粒度采样，防内存爆）
        let peak = 0, peakAt = 0;
        const evs = [];
        for (const t of tasks) { if (!t.ex || !t.fin || t.fin <= t.ex) continue; evs.push([t.ex, 1], [t.fin, -1]); }
        evs.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
        let cur = 0; for (const [ts, d] of evs) { cur += d; if (cur > peak) { peak = cur; peakAt = ts; } }
        // 忙时分布（按完成小时聚合）
        const hours = Array(24).fill(0);
        for (const t of tasks) { const h0 = new Date(t.fin).getHours(); if (h0 >= 0 && h0 < 24) hours[h0]++; }
        const cars = Object.values(byCar).map((b) => ({ ...b, avg: b.dn ? Math.round(b.dur / b.dn) : 0 })).sort((x, y) => y.n - x.n);
        const totalDur = tasks.reduce((s, t) => s + (t.dur || 0), 0);
        return send(res, 200, { ok: true, days: N, total: tasks.length, avgDur: tasks.length ? Math.round(totalDur / tasks.length) : 0, peak, peakAt, cars, hours });
      }
      if (req.method === 'GET' && p === '/api/ground-slots') {
        return send(res, 200, { ok: true, slots: db.groundSlots || {}, rows: db.gndZoneRows || {}, offs: db.gndRowOff || {}, lists: db.gndZoneList || {}, def: { zones: P().gndZones, rows: P().gndRows, cols: P().gndCols } }); // ㉖ v90 lists=真实排号清单v59 附按区排数/停用排/默认参数
      }
      if (req.method === 'POST' && p === '/api/ground-slots') {
        if (!canFeature(u, 'location_reg')) return send(res, 403, { ok: false, msg: '当前角色未开通「位置登记」权限' });
        const b = await readBody(req);
        const _cg = cfgGuard(b); if (_cg) return send(res, 409, { ok: false, code: 'conflict', cfgRev: _cg.cur, msg: _cg.msg });
        const entries = Array.isArray(b.entries) ? b.entries : [];
        db.groundSlots = db.groundSlots || {};
        for (const e of entries) {
          const k = String(e.prefix || '').trim().toUpperCase();
          const v = Number(e.count) || 0;
          if (!/^NB03-[A-Z]-\d{2}$/.test(k)) continue;
          if (v < 1 || v > 60) { delete db.groundSlots[k]; continue; } // 1~60之外=恢复默认12
          db.groundSlots[k] = v;
        }
        // ㉖v59 按区排数覆盖：{"A":15}=该区15排，{"B":0}=整区不用，{"C":null/删除}=恢复默认
        const rowEntries = Array.isArray(b.rowEntries) ? b.rowEntries : [];
        db.gndZoneRows = db.gndZoneRows || {};
        for (const e of rowEntries) {
          const z = String(e.zone || '').trim().toUpperCase();
          if (!/^[A-Z]$/.test(z)) continue;
          if (e.count === null || e.count === '' || e.count === undefined) { delete db.gndZoneRows[z]; continue; }
          const v = Number(e.count);
          if (!Number.isFinite(v) || v < 0 || v > 40) continue;
          db.gndZoneRows[z] = v;
        }
        // ㉖v90 真实排号清单：{"zone":"A","rows":"11-18"或[11,..]}；rows 空/null=清除清单回退排数模式
        const listEntries = Array.isArray(b.listEntries) ? b.listEntries : [];
        db.gndZoneList = db.gndZoneList || {};
        for (const e of listEntries) {
          const z = String(e.zone || '').trim().toUpperCase();
          if (!/^[A-Z]$/.test(z)) continue;
          const arr = parseRowList(e.rows);
          if (arr) db.gndZoneList[z] = arr; else delete db.gndZoneList[z];
        }
        // ㉖v59 停用排：off=true 停用（如 A-01 不用），off=false 恢复
        const offEntries = Array.isArray(b.offEntries) ? b.offEntries : [];
        db.gndRowOff = db.gndRowOff || {};
        for (const e of offEntries) {
          const k = String(e.prefix || '').trim().toUpperCase();
          if (!/^NB03-[A-Z]-\d{2}$/.test(k)) continue;
          if (e.off === true) db.gndRowOff[k] = 1; else delete db.gndRowOff[k];
        }
        const _cr = cfgBump();
        save();
        pushOps(u,'改格数配置','','地面排格数/排数/停用排已更新');
        return send(res, 200, { ok: true, cfgRev: _cr, slots: db.groundSlots, rows: db.gndZoneRows, offs: db.gndRowOff, lists: db.gndZoneList });
      }
      if (req.method === 'POST' && p === '/api/agv/transfer') {
        if (!canFeature(u, 'agv_control')) return send(res, 403, { ok: false, msg: '当前角色未开通「AGV车辆控制」权限' });
        const b = await readBody(req);
        const from = String(b.from || '').trim().toUpperCase();
        const to = String(b.to || '').trim().toUpperCase();
        let palletType = '';
        const kind = String(b.kind || '') === 'toGround' ? 'toGround' : 'shelf2shelf';
        if (!/^[A-Z0-9\-]{3,40}$/.test(from) || !/^[A-Z0-9\-]{3,40}$/.test(to)) return send(res, 400, { ok: false, msg: '货位编码格式不对（应为真实库位码，如 NB02-A-08-2F）' });
        if (from === to) return send(res, 400, { ok: false, msg: '起点与终点相同' });
        const srcBox = (db.ledger || []).find(function (x) { return String(x.l).toUpperCase() === from; });
        if (!srcBox) return send(res, 400, { ok: false, msg: '起点 ' + from + ' 当前无货（货位账本查不到在库框）' });
        palletType = String(b.palletType || '').trim().toUpperCase() || String(srcBox.f || '').trim().toUpperCase();
        const tkq = db.agvQueue || [];
        if (tkq.some(function (x) { return x.type === 'transfer' && (x.from === from || x.to === to) && ['排队', '下发中', '已下发'].includes(x.state); })) return send(res, 400, { ok: false, msg: '该货位已有进行中的移库任务，请勿重复' });
        if (tkq.some(function (x) { return x.type !== 'transfer' && ['排队', '下发中', '已下发'].includes(x.state) && String(x.fromLoc).toUpperCase() === from; })) return send(res, 400, { ok: false, msg: '起点 ' + from + ' 的货架已在出库任务中，不能同时移库' });
        if (AGV_STNS.includes(to) && tkq.some(function (x) { return x.type !== 'transfer' && x.station === to && ['排队', '下发中', '已下发'].includes(x.state); })) return send(res, 400, { ok: false, msg: '目标站台 ' + to + ' 已有出库任务占用' });
        const tk = await wmasToken(); if (!tk) return send(res, 400, { ok: false, msg: 'WMAS未配置/登录失败' });
        if (String(b.dry || '') === '1') { const _ds = await wmasLocOf(from), _de = await wmasLocOf(to); if (!_ds || !_de) return send(res, 400, { ok: false, msg: '演算预检：起点/终点有货位不在WMAS主档，真实下发会失败' }); return send(res, 200, { ok: true, msg: '演算：移库 ' + from + '→' + to + '（' + (palletType || '自动') + '）主档校验通过，未建任务' }); }
        const item = { type: 'transfer', kind: kind, from: from, to: to, palletType: palletType, code: srcBox.c, boxKey: srcBox.p || '', state: '下发中', by: u.name, at: Date.now(), updAt: Date.now(), trace: ['移库/返架直发：' + from + '→' + to + (palletType ? '（容器 ' + palletType + '）' : '') + '，起终点固定不改派'] };
        db.agvQueue = db.agvQueue || []; db.agvQueue.push(item);
        const r = await wmasDispatchOne({ fromLoc: from, palletType: palletType }, tk, { from: from, to: to, pallet: palletType, ref: 'YK-' + (item.code || '') });
        item.state = r.ok ? '已下发' : '失败'; item.taskNo = r.taskNo || ''; item.err = r.ok ? '' : r.msg; item.updAt = Date.now();
        (item.trace = item.trace || []).push(r.ok ? 'WMAS建任务' + (r.taskNo || '') + '下发成功' : 'WMAS下发失败：' + String(r.msg || '').slice(0, 60));
        if (!r.ok) db.agvQueue = db.agvQueue.filter(function (x) { return x !== item; });
        save();
        return send(res, r.ok ? 200 : 400, { ok: r.ok, msg: r.msg, taskNo: item.taskNo || '' });
      }
      if (req.method === 'POST' && p === '/api/agv/transfer/cancel') {
        if (!canFeature(u, 'agv_control')) return send(res, 403, { ok: false, msg: '当前角色未开通「AGV车辆控制」权限' });
        const b = await readBody(req);
        const oid = String(b.id || '');
        const item = (db.agvQueue || []).find(function (x) { return x.type === 'transfer' && String(x.at) === oid; });
        if (!item) return send(res, 400, { ok: false, msg: '未找到该移库任务（可能已完成/取消）' });
        if (item.taskNo) {
          const tk = await wmasToken();
          const cr = tk ? await wmasHttp('POST', '/api/logistics/agv-task/cancelTask', tk, [item.taskNo]) : null; // ㉖v72 真实签名（探测实测）
          if (!tk) return send(res, 400, { ok: false, msg: 'WMAS 未连通，未执行撤销——请稍后重试或现场确认' });
          if (!wmasOk(cr) && !String((cr && (cr.message || cr.msg)) || '').includes('不存在')) {
            return send(res, 400, { ok: false, msg: 'AGV 任务撤销被拒（货架可能已叉出，车正送往 ' + (item.to || item.station || '?') + '）：' + String((cr && (cr.message || cr.msg)) || 'WMAS无响应').slice(0, 60) });
          }
        }
        retireQueueItem(item, '取消', ''); releaseStnBook(item.code); save(); // ㉖v72b 统一回收（无 taskNo 的排队移库项也走此处）
        return send(res, 200, { ok: true, msg: '已取消' });
      }
      // ---- ㉖ 检验搜索：按零件号/物料名片段列在库框（含AGV货架位判定/可下架性），并附空闲站台清单 ----
      if (req.method === 'GET' && p === '/api/inspect/search') {
        const q = String(url.searchParams.get('pn') || '').trim().toUpperCase();
        if (!q) return send(res, 400, { ok: false, msg: '缺少 pn（零件号片段）' });
        const bm = new Map();
        for (const x of db.ledger || []) {
          const pn = String(x.p || '').toUpperCase();
          if (!pn.includes(q) && String(x.n || '').toUpperCase().indexOf(q) < 0 && String(x.c || '').toUpperCase() !== q) continue;
          const k = boxKeyOf(x); if (!bm.has(k)) bm.set(k, { loc: '', codes: [], part: pn, nm: x.n || '', q: 0, ct: x.f || '', last: 0 });
          const b2 = bm.get(k); b2.codes.push(x.c);
          const L = String(x.l || '').toUpperCase(); if (!b2.loc || L < b2.loc) b2.loc = L; // 同框多标签取最小货位代表
          b2.q = Math.max(b2.q, Number(x.q) || 0); if (!b2.nm && x.n) b2.nm = String(x.n); b2.last = Math.max(b2.last, Number(x.t) || 0);
        }
        // v55 每框补批次（MES打印日期，与账本同口径）+ 检验态（inspSeen 取框内最新）；排序：需复检→未检可下架→检验中→未检不可→已检沉底
        const _mm = scanMetaOf(); const _seen = db.inspSeen || {};
        for (const b2 of bm.values()) {
          b2.lot = '';
          for (const c of b2.codes) { const mt = _mm[String(c).toUpperCase()]; if (mt && mt.mk) { b2.lot = printLot(mt.mk, ''); if (!b2.lot) b2.lot = String(mt.mk).slice(0, 10); break; } }
          let best = null; for (const c of b2.codes) { const e = _seen[String(c).toUpperCase()]; if (e && (!best || (Number(e.at) || 0) > (Number(best.at) || 0))) best = e; }
          if (best) b2.insp = { v: String(best.v || ''), at: Number(best.at) || 0 };
        }
        const boxes = [...bm.values()].map((b2) => { const st = inspBoxState({ l: b2.loc, c: b2.codes[0] }); return { ...b2, shelf: st.isShelf, canDown: st.ok, why: st.why }; });
        const _rk = (b2) => b2.why === '检验中' ? 2 : (b2.insp && b2.insp.v === '需复检') ? 0 : (!b2.insp && b2.canDown) ? 1 : (!b2.insp ? 3 : 4);
        boxes.sort((a, x) => _rk(a) - _rk(x) || String(a.loc).localeCompare(String(x.loc)));
        const sum = { boxes: boxes.length, qty: 0, un: 0, ok: 0, re: 0, ret: 0, busy: 0 };
        for (const b2 of boxes) { sum.qty += Number(b2.q) || 0; if (b2.why === '检验中') sum.busy++; else if (!b2.insp) sum.un++; else if (b2.insp.v === '需复检') sum.re++; else if (b2.insp.v === '退货') sum.ret++; else sum.ok++; }
        const freeStns = AGV_STNS.filter((st) => inspStationFree(st, Date.now()));
        const busyStns = {}; for (const st of AGV_STNS) { const v = (db.rcsStations || {})[st]; busyStns[st] = v && v.state && v.state !== '空闲' ? v.state : (freeStns.includes(st) ? '' : '队列/检验占用'); }
        return send(res, 200, { ok: true, boxes: boxes.slice(0, 80), total: boxes.length, sum, freeStns, busyStns, aliases: AGV_STNS.reduce((m, c) => { const a = stnAlias(c); if (a) m[c] = a; return m }, {}) });
      }
      // ---- v55 检验态批量查询（库存页徽章/按钮用）：只读，无权限要求（数据本就在该页可见） ----
      if (req.method === 'POST' && p === '/api/inspect/status') {
        const b = await readBody(req);
        const arr = Array.isArray(b.codes) ? b.codes.slice(0, 300) : [];
        const seen = db.inspSeen || {}; const m = {};
        for (const c of arr) { const k = String(c || '').toUpperCase(); if (!k) continue; const e = seen[k]; m[k] = e ? { v: String(e.v || ''), at: Number(e.at) || 0 } : null; }
        const busy = {}; for (const q of db.inspects || []) { if (['waitOut', 'toStation', 'atStation', 'waitBack', 'returning', 'waitReturn'].includes(q.state)) busy[String(q.code || '').toUpperCase()] = q.state; }
        return send(res, 200, { ok: true, map: m, busy });
      }
      // ---- ㉖④ 检验模式：下架到站台检验，看完备注后原样归位（复用 WMAS CARRY/transfer 通道）----
      if (req.method === 'POST' && p === '/api/inspect/start') {
        if (!canFeature(u, 'inspect_mode')) return send(res, 403, { ok: false, msg: '当前角色未开通「检验模式」权限' });
        const b = await readBody(req);
        const from = String(b.from || '').trim().toUpperCase();
        if (!/^[A-Z0-9\-]{3,40}$/.test(from)) return send(res, 400, { ok: false, msg: '货位编码格式不对（如 NB02-A-08-2F）' });
        const srcBox = (db.ledger || []).find((x) => String(x.l).toUpperCase() === from);
        if (!srcBox) return send(res, 400, { ok: false, msg: '该货位当前无货（货位账本查不到在库框）' });
        const code = String(srcBox.c || '').toUpperCase();
        if ((db.inspects || []).some((q) => (q.from === from || String(q.code).toUpperCase() === code) && ['waitOut','toStation','atStation','waitBack','returning','waitReturn'].includes(q.state))) return send(res, 400, { ok: false, msg: '该货位已有进行中的检验任务' });
        if ((db.agvQueue || []).some((x) => x.type !== 'transfer' && String(x.fromLoc).toUpperCase() === from && ['排队', '下发中', '已下发'].includes(x.state))) return send(res, 400, { ok: false, msg: '该货位已在出库任务中，不能同时检验下架' });
        // ㉖ 指定站台优先：可用性与自动找同一判据；未指定则自动找空闲（CK-01 起顺序找）
        const want = String(b.station || '').trim().toUpperCase(); let to = '';
        if (want) { if (!AGV_STNS.includes(want)) return send(res, 400, { ok: false, msg: '站台编码不在 12 个站台范围（NB02-CK-01~12）' }); if (!inspStationFree(want, Date.now())) return send(res, 400, { ok: false, msg: '站台 ' + want + ' 当前被占用（有货/队列/检验中），请改选或稍后再试' }); to = want; }
        else { for (const st of AGV_STNS) { if (!inspStationFree(st, Date.now())) continue; to = st; break; } }
        if (!to) return send(res, 400, { ok: false, msg: '暂无空闲站台放下架框，请稍后再试' });
        const rec = { id: newId('insp'), code, from, station: to, palletType: (String(srcBox.f || '').trim() || palletTypeOf(code)).toUpperCase(), part: String(srcBox.p || ''), nm: String(srcBox.n || ''), uid: u.id, by: u.name, note: String(b.note || '').slice(0, 120), state: 'toStation', at: Date.now(), updAt: Date.now(), taskNo: '' };
        if (!canFeature(u, 'insp_assist')) { // 检验员发单 → 待协助下架，等仓管/管理员点协助
          rec.state = 'waitOut'; db.inspects = db.inspects || []; db.inspects.push(rec); save();
          pushOps(u, '检验发单', code, from + (to ? ' 期望台' + to : ''));
          db.users.filter((x) => x.enabled && (x.role === 'warehouse' || x.role === 'admin') && canFeature(x, 'insp_assist')).forEach((x) => notify(x.id, 'inspect', '🤝 检验协助请求：' + u.name + ' 申请下架 ' + code + '（' + (rec.nm || rec.part) + '）于 ' + from + (to ? '，期望站台 ' + to : '') + '，请协助', ''));
          return send(res, 200, { ok: true, rec, wait: true });
        }
        // ㉖ 检验下架并入调度队列（与 PDA 手动叫车同款：先试发，演算模式/站台占用则排队，空闲自动发车）——不再绕过调度模式直发
        db.inspects = db.inspects || []; db.inspects.push(rec);
        const item = await inspEnqueue(rec, 'out', u, from, to, 'JC-' + code);
        if (item.state === '失败') { db.inspects = db.inspects.filter((x) => x !== rec); save(); return send(res, 400, { ok: false, msg: '下架任务下发失败：' + item.err }); }
        if (item.state === '已下发') { rec.taskNo = item.wmsTask || ''; }
        else { rec.state = 'waitOut'; rec.outQueued = 1; } // 排队中=尚未发车，工单停在待下架（发车由队列驱动转 toStation）
        save(); pushOps(u, '检验下架', code, from + '→' + to + (item.state === '排队' ? '（已入队：站台空闲/真实下发模式时自动发车）' : ''));
        return send(res, 200, { ok: true, rec, queued: item.state === '排队', msg: item.state === '排队' ? '已入队：站台空闲且真实下发模式时自动发车' : '已下发' });
      }
      // ---- ㉖④ 检验：归位（站台→原货位，leg2）----
      if (req.method === 'POST' && p === '/api/inspect/return') {
        if (!canFeature(u, 'inspect_mode')) return send(res, 403, { ok: false, msg: '当前角色未开通「检验模式」权限' });
        const b = await readBody(req);
        const rec = (db.inspects || []).find((x) => x.id === String(b.id || ''));
        if (!rec) return send(res, 400, { ok: false, msg: '检验工单不存在' });
        if (rec.state !== 'atStation') return send(res, 400, { ok: false, msg: '当前状态[' + rec.state + ']不可归位（需已到站台）' });
        if (!canFeature(u, 'insp_assist')) { // 检验员点归位 = 填结论 + 请求协助
          const vd = ['通过', '不合格', '需复检', '退货'].includes(String(b.verdict || '')) ? String(b.verdict) : '通过';
          const rr = String(b.retReason || '').slice(0, 120);
          if (vd === '退货' && !rr) return send(res, 400, { ok: false, msg: '退货结论必须填写退货原因（如：来料不良/错料/供应商发错）' }); // ㉖⑦ 校验先行，失败不留脏字段
          rec.verdict = vd; rec.note2 = String(b.note || '').slice(0, 200); rec.verdictBy = u.name; rec.verdictAt = Date.now();
          inspMarkSeen(rec, vd, u.name); // ㉖v55 填结论即写检验历史（框内全兄弟标签）
          if (vd === '退货') { // ㉖⑦ 判退货：不回原货位，挂待退货，走正常出库通道出账
            rec.retReason = rr;
            rec.state = 'waitReturn'; rec.updAt = Date.now();
            rec.note = (rec.note ? rec.note + ' | ' : '') + '检验结论：退货·' + rec.retReason + (rec.note2 ? '（' + rec.note2 + '）' : '') + '，货留站台 ' + rec.station + '，请仓管走出库通道出账';
            save(); pushOps(u, '检验结论', rec.code, '退货：' + rec.retReason);
            db.users.filter((x) => x.enabled && (x.role === 'warehouse' || x.role === 'admin')).forEach((x) => notify(x.id, 'inspect', '🔁 检验判退货：' + rec.code + '（' + (rec.nm || rec.part) + '）在 ' + rec.station + '，退货原因：' + rec.retReason + '。请按直调/领料出库流程出账', ''));
            return send(res, 200, { ok: true, rec, wait: true, returned: true });
          }
          rec.state = 'waitBack'; rec.updAt = Date.now();
          if (rec.note2) rec.note = (rec.note ? rec.note + ' | ' : '') + '检验结论：' + vd + '·' + rec.note2;
          save(); pushOps(u, '检验结论', rec.code, vd + (rec.note2 ? '：' + rec.note2 : ''));
          db.users.filter((x) => x.enabled && (x.role === 'warehouse' || x.role === 'admin') && canFeature(x, 'insp_assist')).forEach((x) => notify(x.id, 'inspect', '🤝 检验协助请求：' + rec.code + ' 已出结论[' + vd + ']，请协助归位回 ' + rec.from, ''));
          return send(res, 200, { ok: true, rec, wait: true });
        }
        const item = await inspEnqueue(rec, 'back', u, rec.station, rec.from, 'JCG-' + rec.code);
        if (item.state === '失败') return send(res, 400, { ok: false, msg: '归位任务下发失败：' + item.err });
        rec.note2 = String(b.note || '').slice(0, 200); rec.state = item.state === '已下发' ? 'returning' : 'waitBack'; rec.taskNo2 = item.wmsTask || ''; rec.retAt = Date.now(); rec.updAt = Date.now();
        if (item.state === '排队') rec.backQueued = 1; // ㉖ 已入队待发车：催办暂停，队列驱动转 returning
        save(); pushOps(u, '检验归位', rec.code, '→归位 ' + rec.from + (item.state === '排队' ? '（已入队，空闲自动发车）' : '') + (rec.note2 ? ' 备注:' + rec.note2 : ''));
        if (rec.note2) { rec.note = (rec.note ? rec.note + ' | ' : '') + '检验备注：' + rec.note2; save(); }
        return send(res, 200, { ok: true, rec, queued: item.state === '排队' });
      }
      if (req.method === 'POST' && p === '/api/inspect/assist') { // ㉖ 仓管/管理员协助控制AGV：waitOut→下架 / waitBack→归位（㉖并入调度队列，演算模式/站台忙则排队）
        if (!canFeature(u, 'insp_assist')) return send(res, 403, { ok: false, msg: '当前角色未开通「检验协助控制」权限' });
        const b = await readBody(req);
        const rec = (db.inspects || []).find((x) => x.id === String(b.id || ''));
        if (!rec) return send(res, 400, { ok: false, msg: '检验工单不存在' });
        if (rec.state === 'waitOut') {
          const _ex = (db.agvQueue || []).find((x) => x.inspId === rec.id && ['排队', '下发中', '已下发', '到站'].includes(x.state)); // ㉖ 幂等：排队项活跃时重复点协助直接回已排队
          if (_ex) return send(res, 200, { ok: true, rec, queued: _ex.state === '排队', msg: '该工单已在调度队列（' + _ex.state + '），无需重复协助' });
          let to = String(b.station || '').trim().toUpperCase() || rec.station;
          if (!to) { for (const st of AGV_STNS) { if (inspStationFree(st, Date.now(), rec.id)) { to = st; break; } } }
          else if (!AGV_STNS.includes(to) || (!inspStationFree(to, Date.now(), rec.id) && (db.inspects.find((x) => x.id === rec.id) || {}).station !== to)) return send(res, 400, { ok: false, msg: '站台不可用（范围外或被占用），请改选' });
          if (!to) return send(res, 400, { ok: false, msg: '暂无空闲站台，请稍后再试' });
          const item = await inspEnqueue(rec, 'out', u, rec.from, to, 'JC-' + rec.code);
          if (item.state === '失败') return send(res, 400, { ok: false, msg: '下架任务下发失败：' + item.err });
          rec.station = item.station || to; rec.state = item.state === '已下发' ? 'toStation' : 'waitOut'; rec.taskNo = item.wmsTask || ''; rec.at = Date.now(); rec.updAt = Date.now(); rec.assistBy = u.name;
          if (item.state === '排队') rec.outQueued = 1;
          save(); pushOps(u, '检验协助下架', rec.code, rec.from + '→' + rec.station + (item.state === '排队' ? '（已入队）' : ''));
          notify(rec.uid, 'inspect', '🤝 ' + u.name + ' 已协助下架 ' + rec.code + '，' + (item.state === '排队' ? '已入队排队，站台空闲/真实下发模式时自动发车' : '正送往 ' + rec.station), '');
          return send(res, 200, { ok: true, rec, queued: item.state === '排队' });
        }
        if (rec.state === 'waitBack') {
          const item = await inspEnqueue(rec, 'back', u, rec.station, rec.from, 'JCG-' + rec.code);
          if (item.state === '失败') return send(res, 400, { ok: false, msg: '归位任务下发失败：' + item.err });
          rec.state = item.state === '已下发' ? 'returning' : 'waitBack'; rec.taskNo2 = item.wmsTask || ''; rec.retAt = Date.now(); rec.updAt = Date.now(); rec.assistBy2 = u.name;
          if (item.state === '排队') rec.backQueued = 1;
          save(); pushOps(u, '检验协助归位', rec.code, '→归位 ' + rec.from + (item.state === '排队' ? '（已入队）' : ''));
          notify(rec.uid, 'inspect', '🤝 ' + u.name + ' 已协助归位 ' + rec.code + '，' + (item.state === '排队' ? '已入队排队，空闲自动发车返回 ' + rec.from : '正在返回 ' + rec.from), '');
          return send(res, 200, { ok: true, rec, queued: item.state === '排队' });
        }
        return send(res, 400, { ok: false, msg: '当前状态[' + rec.state + ']无需协助（仅待协助下架/待协助归位可操作）' });
      }
      // ㉖ 取消检验工单：waitOut 未派车可直接作废；toStation/returning 先撤 WMAS 任务（已叉出则拒绝，避免货悬空）
      if (req.method === 'POST' && p === '/api/inspect/cancel') {
        const b = await readBody(req);
        const rec = (db.inspects || []).find((x) => x.id === String(b.id || ''));
        if (!rec) return send(res, 400, { ok: false, msg: '检验工单不存在' });
        const ctl = canFeature(u, 'insp_assist') || u.role === 'admin';
        if (!(rec.uid === u.id || ctl)) return send(res, 403, { ok: false, msg: '只能取消本人发起的工单（仓管/管理员可取消任意工单）' });
        const st0 = rec.state;
        if (!['waitOut', 'toStation', 'returning'].includes(st0)) return send(res, 400, { ok: false, msg: '当前状态[' + st0 + ']不可取消：站台在检/待归位/待退货请走归位或退货通道，已结束无需取消' });
        // ㉖ 反向联动：作废该工单的排队队列项（排队/失败态可直接取消，防调度器随后又发车）
        for (const qi of db.agvQueue || []) { if (qi.inspId === rec.id && (qi.state === '排队' || qi.state === '失败')) retireQueueItem(qi, '取消', ''); } // ㉖v72b 统一回收
        const tn = st0 === 'returning' ? (rec.taskNo2 || '') : (rec.taskNo || '');
        if (tn) {
          const tk = await wmasToken();
          if (!tk) return send(res, 400, { ok: false, msg: 'WMAS 未配置/登录失败，无法撤销已派 AGV 任务' });
          const cr = await wmasHttp('POST', '/api/logistics/agv-task/cancelTask', tk, [tn]); // ㉖v72 真实签名；wmasHttp 失败返回 null（不抛异常）
          if (!wmasOk(cr)) return send(res, 400, { ok: false, msg: 'AGV 任务撤销未成功（可能已叉出，需人工处理）：' + ((cr && (cr.message || cr.code)) || 'WMAS无响应') });
        }
        if (st0 === 'returning') { // ㉖ 归位途中撤单=框仍在站台（未叉出才撤得掉）→ 退回待检态，工单继续有效，可再次协助归位
          rec.state = 'atStation'; rec.taskNo2 = ''; rec.arriveAt = rec.arriveAt || Date.now(); rec.updAt = Date.now(); rec.cancelBy = u.name;
          save(); pushOps(u, '取消检验归位', rec.code, '归位任务已撤，退回站台待检 ' + (rec.station || ''));
          if (rec.uid !== u.id) notify(rec.uid, 'inspect', '⚠ ' + u.name + ' 撤销了 ' + rec.code + ' 的归位任务，框仍在 ' + rec.station + ' 待检', '');
          return send(res, 200, { ok: true, msg: '归位任务已撤销，工单退回「站台待检」' });
        }
        rec.state = 'cancel'; rec.cancelAt = Date.now(); rec.cancelBy = u.name; rec.updAt = Date.now();
        save(); pushOps(u, '取消检验工单', rec.code, rec.from + '→' + (rec.station || '') + '（原状态 ' + st0 + '）');
        if (rec.uid !== u.id) notify(rec.uid, 'inspect', '⚠ ' + u.name + ' 已取消你的检验工单 ' + rec.code + '（' + st0 + '），货仍在 ' + rec.from, '');
        return send(res, 200, { ok: true, msg: tn ? '已撤销 AGV 任务并取消工单，货仍在原货位' : '工单已取消' });
      }
      // ㉖ 检验员填结论（通过/不合格/需复检）：atStation→waitBack 请协助归位；stuck 也可补结论
      if (req.method === 'POST' && p === '/api/inspect/verdict') {
        if (!canFeature(u, 'inspect_mode')) return send(res, 403, { ok: false, msg: '当前角色未开通「检验模式」权限' });
        const b = await readBody(req);
        const rec = (db.inspects || []).find((x) => x.id === String(b.id || ''));
        if (!rec) return send(res, 400, { ok: false, msg: '检验工单不存在' });
        if (!['atStation', 'stuck'].includes(rec.state)) return send(res, 400, { ok: false, msg: '当前状态[' + rec.state + ']不可填写结论' });
        const vd = ['通过', '不合格', '需复检', '退货'].includes(String(b.verdict || '')) ? String(b.verdict) : '通过';
        const rr = String(b.retReason || '').slice(0, 120);
        if (vd === '退货' && !rr) return send(res, 400, { ok: false, msg: '退货结论必须填写退货原因（如：来料不良/错料/供应商发错）' }); // ㉖⑦ 校验先行
        rec.verdict = vd; rec.note2 = String(b.note || '').slice(0, 200); rec.verdictBy = u.name; rec.verdictAt = Date.now(); rec.updAt = Date.now();
        inspMarkSeen(rec, vd, u.name); // v55 填结论即写检验历史（框内全兄弟标签）
        if (vd === '退货') { // ㉖⑦ 仓管/管理员自判退货：货留站台，走出库通道出账
          rec.retReason = rr;
          rec.state = 'waitReturn';
          rec.note = (rec.note ? rec.note + ' | ' : '') + '检验结论：退货·' + rec.retReason + (rec.note2 ? '（' + rec.note2 + '）' : '') + '，货留站台 ' + rec.station + '，请走出库通道出账';
          save(); pushOps(u, '检验结论', rec.code, '退货：' + rec.retReason);
          db.users.filter((x) => x.enabled && (x.role === 'warehouse' || x.role === 'admin')).forEach((x) => notify(x.id, 'inspect', '🔁 检验判退货：' + rec.code + '（' + (rec.nm || rec.part) + '）在 ' + rec.station + '，退货原因：' + rec.retReason + '。请按直调/领料出库流程出账', ''));
          return send(res, 200, { ok: true, rec, returned: true });
        }
        if (rec.note2) rec.note = (rec.note ? rec.note + ' | ' : '') + '检验结论：' + vd + '·' + rec.note2;
        if (rec.state === 'atStation') rec.state = 'waitBack';
        save(); pushOps(u, '检验结论', rec.code, vd + (rec.note2 ? '：' + rec.note2 : ''));
        if (vd !== '通过') db.users.filter((x) => x.enabled && (x.role === 'warehouse' || x.role === 'admin')).forEach((x) => notify(x.id, 'inspect', '⚠ 检验不合格：' + rec.code + '（' + (rec.nm || rec.part) + '）' + vd + (rec.note2 ? '·' + rec.note2 : '') + '，请关注处置', ''));
        db.users.filter((x) => x.enabled && (x.role === 'warehouse' || x.role === 'admin') && canFeature(x, 'insp_assist')).forEach((x) => notify(x.id, 'inspect', '🤝 检验协助请求：' + rec.code + ' 已出结论[' + vd + ']，请协助归位回 ' + rec.from, ''));
        return send(res, 200, { ok: true, rec });
      }
      if (req.method === 'POST' && p === '/api/agv/mode') { // 调度模式：dry演算 / live真下发
        if (!canFeature(u, 'agv_control')) return send(res, 403, { ok: false, msg: '当前角色未开通「AGV车辆控制」权限' });
        const b = await readBody(req);
        const _cg = cfgGuard(b); if (_cg) return send(res, 409, { ok: false, code: 'conflict', cfgRev: _cg.cur, msg: _cg.msg });
        const m = String(b.mode || '') === 'live' ? 'live' : 'dry';
        db.agvDispatchMode = m; const _cr = cfgBump(); save();
        pushOps(u,'切调度模式', m, '');
        console.log(`[agv-q] ${u.name} 切换调度模式 → ${m}`);
        return send(res, 200, { ok: true, mode: m, cfgRev: _cr });
      }
      if (req.method === 'POST' && p === '/api/agv/wmas-config') { // WMAS账号同步（调度器下发通道）
        if (!canFeature(u, 'agv_control')) return send(res, 403, { ok: false, msg: '当前角色未开通「AGV车辆控制」权限' });
        const b = await readBody(req);
        const _cg = cfgGuard(b); if (_cg) return send(res, 409, { ok: false, code: 'conflict', cfgRev: _cg.cur, msg: _cg.msg });
        const host = String(b.host || '').trim(), account = String(b.account || '').trim(), pwd = String(b.pwd || '');
        if (!host || !account || !pwd) return send(res, 400, { ok: false, msg: 'host/account/pwd 不能为空' });
        db.wmasConfig = { host, account, pwd }; _wmasTk = ''; _wmasLoc = null;
        pushOps(u,'改WMAS配置', host, '账号:'+account+'（密码不记）');
        const _cr = cfgBump();
        save();
        return send(res, 200, { ok: true, cfgRev: _cr, msg: 'WMAS配置已保存' });
      }
      // ================= 数据驾驶舱（只读聚合，登录即可看） =================
      // ---- ㉕F5 个人偏好 prefs（落地页/通知订阅/概览卡自选）+ 管理员模板 ----
      // ---- ㉖③ 数据资产总计数：各域在库/流水/出库/队列/留痕/事件/检验 + 归档量，网页"有迹可查"面板 ----
      if (req.method === 'GET' && p === '/api/counts') {
        let archScan = 0, archOut = 0; try { for (const f of fs.readdirSync(path.join(DATA_DIR, 'archive'))) { if (/scanlog/.test(f)) archScan += Object.keys(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'archive', f), 'utf8'))).length; else if (/outbound/.test(f)) archOut += Object.keys(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'archive', f), 'utf8'))).length; } } catch (_) {}
        const live = Object.values(db.scanlog || {}).filter((x) => !x.cx).length;
        return send(res, 200, { ok: true, at: new Date().toISOString(), ledger: (db.ledger || []).length, scanlogLive: live, scanlogTotal: Object.keys(db.scanlog || {}).length, archScan, outbound: Object.keys(db.outbound || {}).length, archOut, reqs: (db.requisitions || []).length, queue: (db.agvQueue || []).filter((q) => !['完成', '取消'].includes(q.state)).length, queueTotal: (db.agvQueue || []).length, tasks: Object.keys(db.agvTasks || {}).length, events: (db.carEvents || []).length, ops: opsLoadDays(30).length, inspects: (db.inspects || []).length, inspectActive: (db.inspects || []).filter((q) => ['waitOut','toStation','atStation','waitBack','returning'].includes(q.state)).length, seenIn: Object.keys(db.seenIn || {}).length, seenOut: Object.keys(db.seenOut || {}).length, dict: Object.keys(db.itemDict || {}).length, ledRev: db.ledgerRev || 0, ledAt: db.ledgerAt || '', backup: fs.existsSync(path.join(DATA_DIR, 'backups')) ? fs.readdirSync(path.join(DATA_DIR, 'backups')).filter((f) => /^db-.*\.json$/.test(f)).length : 0 });
      }
      // ---- ㉖ 系统连接状态：RCS(哈工库讯) / WMAS(AGV下发) 配置与最近成功时刻（MES 凭据在 PDA 本地，由 App 自查）----
      if (req.method === "GET" && p === "/api/sysstatus") {
        const nowMs = Date.now();
        const rcsCfg = !!(db.rcsConfig && db.rcsConfig.host);
        const rcsAge = db.rcsAt ? Math.round((nowMs - Date.parse(db.rcsAt)) / 1000) : -1;
        const wmAge = db.wmasOkAt ? Math.round((nowMs - db.wmasOkAt) / 1000) : -1;
        let wmOk = false; try { const _t = await wmasToken(); wmOk = !!_t; } catch (_) {}
        // ㉖v93d 灯语义=「能不能下发」而非「能不能登录」：登录通道正常但 mom-logistics 业务通道掉线
        // （10/24 复盘：登录成功却建不了任务/查不到容器）时，看门狗 wmasDownAt 在场 → 灯必须红，不能绿着骗人
        const wmDown = !!db.wmasDownAt;
        return send(res, 200, { ok: true, rcs: { cfg: rcsCfg, ok: rcsCfg && rcsAge >= 0 && rcsAge < 120, lastSec: rcsAge, host: rcsCfg ? String(db.rcsConfig.host || "") : "" }, wmas: { cfg: !!(db.wmasConfig && db.wmasConfig.host), ok: wmOk && !wmDown, login: wmOk, down: wmDown, lastSec: wmAge } });
      }
      // ---- ㉖① 标签全局查重：采集入库/出库/AGV 前预检（任何批次命中即拦）----
      if (req.method === 'GET' && p === '/api/label/check') {
        const cs = String(url.searchParams.get('c') || '').trim().toUpperCase();
        if (!cs) return send(res, 400, { ok: false, msg: '缺少 c' });
        const st = labelStatus(cs);
        const inReason = labelBlockReason(st, 'in');
        return send(res, 200, { ok: true, code: cs, seen: !!(inReason || st.inLedger.length || st.inScanlog.length || st.everIn || st.everOut), blockIn: !!inReason, everIn: !!st.everIn, reason: inReason, loc: st.inLedger.length ? String(st.inLedger[0].l || '') : '', part: st.inLedger.length ? String(st.inLedger[0].p || '') : '', batch: st.inScanlog.length ? String(st.inScanlog[0].gl || st.inScanlog[0].st || '') : (st.everOut ? String(st.everOut.batch || '') : ''), by: st.inLedger.length ? String(st.inLedger[0].by || '') : (st.inScanlog.length ? String(st.inScanlog[0].op || '') : ''), everOut: st.everOut ? { at: st.everOut.at, batch: st.everOut.batch || '' } : null });
      }
      // ---- ㉖① 强制继续录入留痕（PDA 全局查重被拦后人工填原因放行）----
      if (req.method === "POST" && p === "/api/label/force") {
        const b = await readBody(req);
        const fc = String(b.code || "").trim().toUpperCase(); if (!fc) return send(res, 400, { ok: false, msg: "缺少 code" });
        pushOps(u, "重复标签强过", fc, String(b.why || "").slice(0, 120));
        save();
        return send(res, 200, { ok: true });
      }
      // ---- ㉖⑭ 采集作废释放防重：该标签业务失效且未真实入库，撤回 seenIn 允许重扫（作废联动调用）----
      if (req.method === "POST" && p === "/api/label/unsee") {
        const b = await readBody(req);
        const uc = String(b.code || "").trim().toUpperCase(); if (!uc) return send(res, 400, { ok: false, msg: "缺少 code" });
        const had = !!(db.seenIn || {})[uc];
        if (had) delete db.seenIn[uc];
        pushOps(u, "采集作废释放", uc, had ? "已撤回全局防重，可重新录入" : "无防重记录（可能未入账）");
        save();
        return send(res, 200, { ok: true, had });
      }
      // ---- ㉖④ 检验模式工单列表 ----
      if (req.method === 'GET' && p === '/api/inspect/list') {
        const only = url.searchParams.get('mine') === '1' ? u.id : '';
        const list = (db.inspects || []).filter((q) => !only || q.uid === only).sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 200);
        // ㉖v56 工单时间线数据：随单返回两腿AGV调度trace（下架腿insp/归位腿inspback），前端合并工单自带时间戳画时间线
        const _qtrace = {}; for (const q2 of db.agvQueue || []) { if (q2.inspId && (q2.trace || []).length) { const arr = _qtrace[q2.inspId] = _qtrace[q2.inspId] || { out: [], back: [] }; if (q2.type === 'insp') arr.out = q2.trace; else if (q2.type === 'inspback') arr.back = q2.trace; } }
        const list2 = list.map((q) => Object.assign({}, q, { legTrace: _qtrace[q.id] || { out: [], back: [] } }));
        return send(res, 200, { ok: true, list: list2, freeStns: AGV_STNS.filter((st) => inspStationFree(st, Date.now())), aliases: AGV_STNS.reduce((m, c) => { const a = stnAlias(c); if (a) m[c] = a; return m }, {}) }); // ㉖ 附空闲台：PDA 协助下架选台不再依赖先搜索
      }
      if (req.method === 'GET' && p === '/api/prefs') {
        return send(res, 200, { ok: true, prefs: prefsFor(u.id), templates: (db.prefTemplates || []).map((t) => ({ name: t.name, by: t.by })) });
      }
      if (req.method === 'POST' && p === '/api/prefs') {
        const b = await readBody(req); const mine = (db.prefs[u.id] = db.prefs[u.id] || {});
        if (b.landing !== undefined) mine.landing = { v: String(b.landing || '').slice(0, 20), at: Date.now() };
        if (b.theme !== undefined) mine.theme = { v: b.theme === 'dark' ? 'dark' : '', at: Date.now() }; // ㉕丙6 主题上云（空=浅色）
        if (Array.isArray(b.kpi)) mine.kpi = { v: b.kpi.slice(0, 30).map((x) => String(x).slice(0, 14)), at: Date.now() };
        if (b.notes && typeof b.notes === 'object') { const nn = {}; for (const t2 of ['req_new', 'req_urge', 'req_arrive', 'req_flow', 'watch_in', 'stock_out', 'car_alarm', 'inspect']) { const v = b.notes[t2]; nn[t2] = (typeof v === 'number') ? v > 0 : v !== false; } mine.notes = { v: nn, at: Date.now() }; } // ㉖v53 三档：数字0=关闭(退订) 1/2=订阅；旧布尔向后兼容
        if (b.work !== undefined) mine.work = { v: Number(b.work) === 1 ? 1 : 0, at: Date.now() }; // ㉖B14 PDA工作模式上云（0=AGV站台 1=人工地面）
        if (b.rate !== undefined) { const rr = Number(b.rate); if (Number.isFinite(rr)) mine.rate = { v: Math.min(0.9, Math.max(0.3, rr)), at: Date.now() }; } // ㉖B14 播报语速上云
        if (b.voice !== undefined) mine.voice = { v: b.voice !== false, at: Date.now() }; // ㉖B14 扫码播报开关上云
        // ㉖第3档 PDA个性化三项：字号档位/扫码自动聚焦/领料默认值(指定仓管/框型/日期偏移)
        if (b.pd_font !== undefined) mine.pd_font = { v: ['std', 'lg', 'xl'].includes(String(b.pd_font)) ? String(b.pd_font) : 'std', at: Date.now() };
        if (b.pd_focus !== undefined) mine.pd_focus = { v: b.pd_focus !== false, at: Date.now() };
        if (b.pd_defAssignee !== undefined) mine.pd_defAssignee = { v: b.pd_defAssignee !== false, at: Date.now() };
        if (b.pd_defPallet !== undefined) mine.pd_defPallet = { v: String(b.pd_defPallet == null ? '' : b.pd_defPallet).slice(0, 20), at: Date.now() };
        if (b.pd_dateOffset !== undefined) { const dd = Number(b.pd_dateOffset); if (Number.isFinite(dd)) mine.pd_dateOffset = { v: Math.min(90, Math.max(0, dd)), at: Date.now() }; }
        if (b.pd_tabs !== undefined) mine.pd_tabs = { v: String(b.pd_tabs == null ? '' : b.pd_tabs).slice(0, 4000), at: Date.now() }; // ㉖v53 首页模块自定义（顺序+显隐 JSON）
        if (b.pd_tabuse !== undefined) mine.pd_tabuse = { v: String(b.pd_tabuse == null ? '' : b.pd_tabuse).slice(0, 4000), at: Date.now() }; // ㉖v53 页签驻留时长统计（近7天）
        if (b.pd_tab_auto !== undefined) mine.pd_tab_auto = { v: b.pd_tab_auto === true, at: Date.now() }; // ㉖v53 按使用频率自动排序开关
        { // ㉖v56 网页界面个性化（值校验白名单，非法值拒收不覆盖）
          if (b.ck_accent !== undefined && ['blue','indigo','teal','green','orange'].includes(String(b.ck_accent))) mine.ck_accent = { v: String(b.ck_accent), at: Date.now() };
          if (b.ck_darkmode !== undefined && ['auto','on','off'].includes(String(b.ck_darkmode))) mine.ck_darkmode = { v: String(b.ck_darkmode), at: Date.now() };
          if (b.ck_density !== undefined && ['cozy','compact','roomy'].includes(String(b.ck_density))) mine.ck_density = { v: String(b.ck_density), at: Date.now() };
          if (b.ck_zoom !== undefined && ['s100','s110','s125'].includes(String(b.ck_zoom))) mine.ck_zoom = { v: String(b.ck_zoom), at: Date.now() };
        }
        if (b.ck_tabs !== undefined) mine.ck_tabs = { v: String(b.ck_tabs == null ? '' : b.ck_tabs).slice(0, 4000), at: Date.now() }; // 网页页签配置 JSON{order,hidden}
        if (b.ck_tabuse !== undefined) mine.ck_tabuse = { v: String(b.ck_tabuse == null ? '' : b.ck_tabuse).slice(0, 4000), at: Date.now() }; // 页签驻留统计（近7天）
        if (b.ck_tab_auto !== undefined) mine.ck_tab_auto = { v: b.ck_tab_auto === true, at: Date.now() }; // 按使用习惯自动排序
        if (b.ck_use !== undefined) mine.ck_use = { v: String(b.ck_use == null ? '' : b.ck_use).slice(0, 8000), at: Date.now() }; // ㉖v55 命令面板使用习惯（JSON计数，跨设备合并取大）
        save(); return send(res, 200, { ok: true, prefs: prefsFor(u.id) });
      }
      if (req.method === 'POST' && p === '/api/prefs/apply') {
        const b = await readBody(req); const t = (db.prefTemplates || []).find((x) => x.name === String(b.name || '').slice(0, 40));
        if (!t) return send(res, 404, { ok: false, msg: '模板不存在' });
        db.prefs[u.id] = db.prefs[u.id] || {}; const nowMs = Date.now();
        for (const k of ['landing', 'theme', 'kpi', 'notes', 'work', 'rate', 'voice']) if (t.prefs[k] !== undefined) db.prefs[u.id][k] = { v: JSON.parse(JSON.stringify(t.prefs[k])), at: nowMs };
        save(); pushOps(u, '套用偏好模板', String(b.name || ''), ''); return send(res, 200, { ok: true, prefs: prefsFor(u.id) });
      }
      if (req.method === 'POST' && p === '/api/admin/prefs/template') {
        if (u.role !== 'admin') return send(res, 403, { ok: false, msg: '仅管理员可存模板' });
        const b = await readBody(req); const name = String(b.name || '').trim().slice(0, 40); if (!name) return send(res, 400, { ok: false, msg: '缺模板名' });
        const src = b.prefs || {}; const clean = {}; for (const k of ['landing', 'theme', 'kpi', 'notes', 'work', 'rate', 'voice']) if (src[k] !== undefined) clean[k] = k === 'kpi' ? (Array.isArray(src[k]) ? src[k].slice(0, 30) : []) : src[k];
        db.prefTemplates = db.prefTemplates || []; const ex = db.prefTemplates.find((x) => x.name === name);
        if (ex) { ex.prefs = clean; ex.by = u.name; ex.at = Date.now(); } else db.prefTemplates.push({ name, prefs: clean, by: u.name, at: Date.now() });
        if (db.prefTemplates.length > 20) db.prefTemplates = db.prefTemplates.slice(-20);
        save(); pushOps(u, '存偏好模板', name, ''); return send(res, 200, { ok: true });
      }
      // ---- ㉕丁1 账本自对账：相邻两份每日快照差异（幽灵框/蒸发框/改位/改量），无需MES ----
      if (req.method === 'GET' && p === '/api/reconcile') {
        const dir = path.join(DATA_DIR, 'snapshots'); let fsn = [];
        try { fsn = fs.readdirSync(dir).filter((x) => /^ledger-\d{8}\.json$/.test(x)).sort(); } catch (_) { return send(res, 200, { ok: true, days: [], msg: '暂无快照（服务运行满一天后自动生成）' }); }
        const pick = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { return null; } };
        // ㉖v89b 世代闸：账本整表替换（WPS导入/迁移）后，新旧快照的码集几乎零重叠，朴素对比会把"换血"全报成幽灵+蒸发
        // （10/23实测：幽灵404/蒸发387，全是迁移前旧码"消失"+迁移后新码"新增"，无一真异常）——只允许同世代快照互比
        // 无章历史快照按快照时刻归代：早于最近一次整表替换时刻=PRE-GEN（10/23复盘：现存两份旧快照均无章，
        // 朴素按 'LEGACY' 归一会被放行互比——正是截图幽灵404/蒸发387的来源）
        const _ep = (o) => { if (!o) return ''; const e = String(o.epoch || ''); if (e) return e; const t = Date.parse(o.at || '') || 0; const cut = Number(db.ledgerEpochAt) || 0; return (cut && t && t < cut) ? 'PRE-GEN' : (String(db.ledgerEpoch || '') || 'LEGACY'); };
        let two = fsn.slice(-2);
        while (two.length === 2 && _ep(pick(two[0])) !== _ep(pick(two[1]))) two = [two[1]]; // 末两份跨世代→最新那份当基线等待
        if (two.length < 2) return send(res, 200, { ok: true, days: fsn.slice(-1), msg: '账本已整表替换（世代变更），跨世代对比无意义；以最新快照为新基线，自下一份同世代快照起恢复正常对账' });
        const A = pick(two[0]), B = pick(two[1]); if (!A || !B) return send(res, 500, { ok: false, msg: '快照读取失败' });
        const ma = {}, mb = {}; for (const x of A.items || []) ma[String(x.c).toUpperCase()] = x; for (const x of B.items || []) mb[String(x.c).toUpperCase()] = x;
        const ghosts = [], evap = [], moved = [], qtyCh = [];
        const _scv = {}; for (const s0 of Object.values(db.scanlog || {})) { if (!s0.cx) _scv[String(s0.code || '').toUpperCase()] = 1; } let _ghHidden = 0; // ㉖v54 白名单佐证：有有效采集流水=正常采集入库（18:10快照后到达的框次日报幽灵是误报）
        const _obv = {}; for (const o of Object.values(db.outbound || {})) { for (const i of (o.items || [])) { const bc = String(i.barcode || '').toUpperCase(); if (bc) _obv[bc] = 1; } } let _evOk = 0; // v55 出库单标签全集（蒸发框佐证）
        for (const [c, x] of Object.entries(mb)) { if (!ma[c]) { if (_scv[c] || (db.seenOut || {})[c]) { _ghHidden++; continue; } const pn = String(x.p || '').toUpperCase(); ghosts.push({ c, loc: x.l, pn, nm: x.n || (db.itemDict && db.itemDict[pn] && db.itemDict[pn].nm) || '', q: x.q || 0, by: x.by || '', at: x.t ? new Date(x.t).toLocaleString('zh-CN', { hour12: false }).slice(5, 16) : '' }); } }
        for (const [c, x] of Object.entries(ma)) { if (!mb[c]) { if (_obv[c] || (db.seenOut || {})[c]) { _evOk++; continue; } const t = x.t ? new Date(x.t).toLocaleString('zh-CN', { hour12: false }).slice(5, 16) : ''; evap.push({ c, loc: x.l, p: x.p || '', q: x.q || 0, reg: t }); } else { const y = mb[c]; if (String(y.l).toUpperCase() !== String(x.l).toUpperCase()) moved.push({ c, from: x.l, to: y.l, by: y.by || '' }); if ((Number(y.q) || 0) !== (Number(x.q) || 0)) qtyCh.push({ c, loc: y.l, a: x.q || 0, b: y.q || 0 }); } }
        return send(res, 200, { ok: true, days: [two[0].slice(7, 15), two[1].slice(7, 15)], ghosts, hidden: _ghHidden, evap, evOk: _evOk, moved, qtyCh, noteA: '幽灵框=快照新增且查无有效采集流水（未走采集直接上账），建议补采核实' + (_ghHidden ? '；另有 ' + _ghHidden + ' 个新增已核为正常采集/返架回库' : ''), noteB: '蒸发框=快照消失且查无出库单佐证（真失踪需人工核实）' + (_evOk ? '；另有 ' + _evOk + ' 个消失已核为正常出库' : '') });
      }
      // ---- ㉕F7 交接日报：今日按人聚合（接单/发框/件数/AGV趟/认领/修正） ----
      if (req.method === 'GET' && p === '/api/report/shift') {
        const y = new Date(); const day0 = new Date(y.getFullYear(), y.getMonth(), y.getDate()).getTime();
        const per = {}; const G = (n) => (per[n] = per[n] || { name: n, orders: 0, boxes: 0, qty: 0, agv: 0, ack: 0, fix: 0 });
        for (const r of db.requisitions || []) {
          if (r.acceptedBy && (r.history || []).some((h) => /^接单/.test(h.text || '') && Date.parse(h.time) >= day0)) G(String(r.acceptedBy)).orders++;
          const cAt = Date.parse(r.createdAt) || 0, fAt = Date.parse(r.confirmedAt || '0') || 0;
          if (r.acceptedBy && (cAt >= day0 || fAt >= day0)) for (const it of r.items || []) for (const e of (it.issued || [])) { const o = typeof e === 'string' ? { c: e, q: 0 } : e; if (!o.c) continue; const p = G(String(r.acceptedBy)); p.boxes++; p.qty += Number(o.q) || 0; }
          for (const it of r.items || []) for (const a of (it.agvCalled || [])) if ((Date.parse(a.t || '') || 0) >= day0) { const uu = db.users.find((x) => x.id === a.by); if (uu) G(uu.name).agv++; }
        }
        for (const o of db.ops || []) { if ((o.t || 0) < day0) continue; if (o.act === '告警认领' && o.by) G(String(o.by)).ack++; }
        for (const f of db.ledgerFixes || []) if ((Date.parse(f.time) || 0) >= day0 && f.by) G(String(f.by)).fix++;
        const rows = Object.values(per).sort((a, b) => (b.orders * 2 + b.boxes) - (a.orders * 2 + a.boxes));
        const sum = (k) => rows.reduce((s, r) => s + (r[k] || 0), 0);
        return send(res, 200, { ok: true, today: { day: y.getFullYear() + '-' + (y.getMonth() + 1) + '-' + y.getDate(), rows, orders: sum('orders'), boxes: sum('boxes'), qty: sum('qty'), agv: sum('agv'), ack: sum('ack'), fix: sum('fix') } });
      }
      if (req.method === 'GET' && p === '/api/dashboard') {
        const dayMs = 86400000;
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const dstr = (ms) => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()}`; };
        // 今日入库：采集流水按标签去重（排除作废）
        const inToday = new Map();
        const trendIn = Array(7).fill(0), trendOut = Array(7).fill(0);
        for (const s of Object.values(db.scanlog || {})) {
          if (s.cx || !s.t) continue;
          const dayIdx = Math.floor((s.t - todayStart) / dayMs);
          if (dayIdx >= 0 && dayIdx <= 6) { trendIn[dayIdx] = 0; } // 占位，下面统一算
          if (s.t >= todayStart) { if (!inToday.has(s.code) || (inToday.get(s.code).t || 0) < s.t) inToday.set(s.code, s); }
        }
        const inBoxes = inToday.size;
        const inQty = [...inToday.values()].reduce((s, x) => s + (Number(x.q) || 0), 0);
        // 7日入库/出库按天分桶（标签数口径）
        const bucket = (arr, m) => { const day = Math.floor((m - todayStart) / dayMs); if (day >= 0 && day <= 6) arr[day]++; };
        const inSeen = new Set(), outSeen = new Set();
        for (const s of Object.values(db.scanlog || {})) {
          if (s.cx || !s.t || !s.code || inSeen.has(s.code + Math.floor(s.t / dayMs))) continue;
          inSeen.add(s.code + Math.floor(s.t / dayMs)); bucket(trendIn, s.t);
        }
        for (const tmb of db.ledgerTomb || []) { if (tmb.t) bucket(trendOut, tmb.t); }
        // 今日AGV搬运：RCS 任务沉淀里完成时刻落在今日的任务数（一次真实搬运=1，含出库/入库/移库）
        // ㉖ 旧口径统计领料单 agvCalled 登记次数：同框重复叫车/取消重叫会多算，PDA手动入库叫车不挂领料单会漏算
        let agvToday = 0, agvDoneToday = 0;
        for (const t of Object.values(db.agvTasks || {})) { if ((t.fin || 0) >= todayStart) agvDoneToday++; }
        const st = { pending: 0, accepted: 0, ready: 0 };
        for (const r of db.requisitions || []) {
          if (st[r.status] !== undefined) st[r.status]++;
          for (const it of r.items || []) for (const e of (it.agvCalled || [])) {
            const ms = Date.parse(String(e.t || '')); if (Number.isFinite(ms) && ms >= todayStart) agvToday++;
          }
        }
        // 在库与站台
        const locs = new Set(db.ledger.map((x) => String(x.l).toUpperCase()));
        const stnBusy = Object.values(db.rcsStations || {}).filter((s) => s.state === '有货' || s.state === '占用中').length;
        let stnOn = AGV_STNS.filter((c) => !stnOff(c)).length; // ㉖⑫ 分母=启用台数（停用台不再占名额）
        const stnToday = {}; // ㉖⑫ 今日各台送达框数（站台看板与概览共用）
        { const _d0 = new Date(); const t0 = new Date(_d0.getFullYear(), _d0.getMonth(), _d0.getDate()).getTime();
          for (const t of Object.values(db.agvTasks || {})) { if (t.ck === 'out' && (t.fin || 0) >= t0) { const ep = String(t.ep || '').toUpperCase(); if (/^NB02-CK-\d+$/.test(ep)) stnToday[ep] = (stnToday[ep] || 0) + 1; } } }
        const stnAliases = {}; for (const c of AGV_STNS) { const a = stnAlias(c); if (a) stnAliases[c] = a; }
        const queueNow = (db.agvQueue || []).filter((q) => ['排队', '下发中', '已下发'].includes(q.state)).length;
        const inspWait = (db.inspects || []).filter((q) => ['waitOut', 'waitBack', 'waitReturn'].includes(q.state)).length;
        return send(res, 200, { ok: true, at: new Date().toISOString(),
          kpi: { inBoxes, inQty, outToday: (db.ledgerTomb || []).filter((x) => x.t >= todayStart).length, agvToday: agvDoneToday, agvQueue: queueNow,
            stockBoxes: new Set(ledgerView().map((x) => boxKeyOf(x))).size, stockLocs: locs.size, pending: st.pending, accepted: st.accepted, ready: st.ready, stnBusy, stnTotal: stnOn, inspWait, stnToday, stnAliases }, // ㉖ 在库框数=按框聚合（同托多标签/同位同件=1框），与库存汇总D2同口径；此前误用标签条数(421)致与占位货位(412)不等
          trend: Array.from({ length: 7 }, (_, i) => ({ d: dstr(todayStart + i * dayMs), in: trendIn[i], out: trendOut[i], ds: new Date(todayStart + i * dayMs).toISOString().slice(0, 10) })) });
      }
      // ================= ⑦ AGV效率报表（只读聚合 db.agvTasks，登录可看；days=1~30） =================
      if (req.method === 'GET' && p === '/api/agv/report') {
        const days = Math.min(30, Math.max(1, parseInt(url.searchParams.get('days') || '7') || 7));
        const since = Date.now() - days * 86400000;
        const tasks = Object.values(db.agvTasks || {}).filter((t) => (t.fin || 0) >= since);
        const byCar = {}; // 车号 → {n,durSum,out,in}
        const heat = Array.from({ length: 7 }, () => Array(24).fill(0)); // 近7日×24h 任务热力
        const dayBase = new Date(); dayBase.setHours(0, 0, 0, 0); dayBase.setDate(dayBase.getDate() - 6);
        let noCarN = 0; // ㉖v61 RCS未回车号的任务（exeAgvId缺失）单列，不再伪装成 AGV00
        for (const t of tasks) {
          if (!t.car) { noCarN++; } else {
            const b = (byCar[t.car] = byCar[t.car] || { n: 0, durSum: 0, out: 0, in: 0 });
            b.n++; if (t.dur) b.durSum += t.dur; if (t.ck === 'out') b.out++; else if (t.ck === 'in') b.in++;
          }
          const di = Math.floor((t.fin - dayBase.getTime()) / 86400000), hr = new Date(t.fin).getHours();
          if (di >= 0 && di < 7 && hr >= 0 && hr < 24) heat[di][hr]++;
        }
        const cars = Object.entries(byCar).map(([id, v]) => ({ car: Number(id), n: v.n, out: v.out, in: v.in, avgDur: v.n && v.durSum ? Math.round(v.durSum / v.n) : 0 }))
          .sort((a, b) => b.n - a.n);
        if (noCarN) cars.push({ car: -1, n: noCarN, out: 0, in: 0, avgDur: 0 }); // car=-1 前端显示"车号缺失"
        const totalN = tasks.length, totalDur = tasks.reduce((s, t) => s + (t.dur || 0), 0);
        return send(res, 200, { ok: true, days, totalN, avgDur: totalN ? Math.round(totalDur / totalN) : 0,
          cars, heat, heatDays: Array.from({ length: 7 }, (_, i) => dstr(dayBase.getTime() + i * 86400000)) });
      }
      // ================= ⑬ APK 自动更新：版本查询 + 下载（登录可用） =================
      const APP_DIR = path.join(DATA_DIR, 'app');
      const APP_VER = path.join(APP_DIR, 'version.json');
      const APP_APK = path.join(APP_DIR, 'app-release.apk');
      if (req.method === 'GET' && p === '/api/app/version') {
        try {
          if (!fs.existsSync(APP_VER)) return send(res, 200, { ok: true, has: false });
          const v = JSON.parse(fs.readFileSync(APP_VER, 'utf8'));
          const apk = path.join(APP_DIR, v.file || 'app-release.apk'); // ㉖v94g 版本化文件名，兼容历史 app-release.apk
          return send(res, 200, { ok: true, has: fs.existsSync(apk), ...v, size: fs.existsSync(apk) ? fs.statSync(apk).size : 0 });
        } catch (e) { return send(res, 200, { ok: false, msg: e.message }); }
      }
      // ⑯离线语音包分发（登录即可拉；zip内含 model.onnx/tokens.txt/espeak-ng-data）
      if (req.method === 'GET' && p === '/api/tts/info') {
        const zf = path.join(DATA_DIR, 'app', 'tts-model.zip');
        if (!fs.existsSync(zf)) return send(res, 200, { ok: false, msg: '服务器未放置 tts-model.zip' });
        return send(res, 200, { ok: true, size: fs.statSync(zf).size });
      }
      if (req.method === 'GET' && p === '/api/tts/model') {
        const zf = path.join(DATA_DIR, 'app', 'tts-model.zip');
        if (!fs.existsSync(zf)) return send(res, 404, { ok: false, msg: '无语音包' });
        const st = fs.statSync(zf);
        res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': st.size });
        fs.createReadStream(zf).pipe(res);
        return;
      }
      if (req.method === 'GET' && p === '/api/app/download') {
        let apk = APP_APK; try { const v = JSON.parse(fs.readFileSync(APP_VER, 'utf8')); if (v.file) apk = path.join(APP_DIR, v.file); } catch (_) {} // ㉖v94g
        if (!fs.existsSync(apk)) return send(res, 404, { ok: false, msg: '尚无上传APK' });
        const st = fs.statSync(apk);
        res.writeHead(200, { 'Content-Type': 'application/vnd.android.package-archive', 'Content-Length': st.size, 'Content-Disposition': 'attachment; filename="app-release.apk"' });
        fs.createReadStream(apk).pipe(res);
        return;
      }
      if (req.method === 'POST' && p === '/api/rcs/clear') { // 人工干预站台：state=有货(占用)/空闲(清台)
        if (!canFeature(u, 'agv_control')) return send(res, 403, { ok: false, msg: '当前角色未开通「AGV车辆控制」权限' });
        const b = await readBody(req);
        const stn = String(b.station || '').trim().toUpperCase();
        const state = String(b.state || '空闲').trim();
        if (!stn.includes('-CK-') && !stn.includes('-RK-')) return send(res, 400, { ok: false, msg: '站台编码无效' });
        db.rcsStations = db.rcsStations || {}; db.rcsCleared = db.rcsCleared || {}; db.rcsManual = db.rcsManual || {};
        if (state === '有货') {
          db.rcsStations[stn] = { station: stn, state: '有货', label: '人工占用', manual: true, ts: Date.now(), since: '' };
          delete db.rcsCleared[stn];
          db.rcsManual[stn] = Date.now();
          save();
          return send(res, 200, { ok: true, msg: stn + ' 已标记有货（30分钟内不被系统覆盖）' });
        }
        delete db.rcsStations[stn];
        delete db.rcsManual[stn];
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
        for (const itx of (Array.isArray(b.items) ? b.items : [])) { const c1 = String(itx.barcode || '').toUpperCase(); if (c1 && !db.seenOut[c1]) db.seenOut[c1] = { at: Number(b.createdAt) || Date.now(), no }; } // ㉖② 历史出库登记（标签生命周期防复用）；㉖v68 修复：键只取标签号 barcode（旧版误取 code=零件号，按标签查曾出库永远落空）
        db.outbound[no] = { orderNo: no, createdAt: Number(b.createdAt) || 0, toLoc: String(b.toLoc || ''), operator: String(b.operator || ''), status: Number(b.status) || 0, linkReqNo: String(b.linkReqNo || ''), items: Array.isArray(b.items) ? b.items : [] };
        // ㉖v61 写入清洗：剥离 U+FFFD 与控制字符（PDA/WMAS 推送编码丢失所致），与账本同步乱码清洗同口径；防止脏 name 再沉淀进字典
        { const _cb = /[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F]/g; const _cl = (s0) => String(s0 == null ? '' : s0).replace(_cb, '').replace(/\s+/g, ' ').trim();
          const _o = db.outbound[no]; _o.toLoc = _cl(_o.toLoc); _o.operator = _cl(_o.operator); _o.linkReqNo = _cl(_o.linkReqNo);
          for (const e of (_o.items || [])) { e.code = _cl(e.code); e.name = _cl(e.name); e.barcode = _cl(e.barcode); e.fromLoc = _cl(e.fromLoc); if (e.move != null) e.move = _cl(e.move); } }
        for (const e of (db.outbound[no].items || [])) feedDict(e.code, e.name, '出库单'); // ㉒G7 字典沉淀
        db.outboundAt = new Date().toISOString(); db.outboundCount = Object.keys(db.outbound).length;
        save();
        console.log(`[outbound] ${u.name} 同步出库单 ${no}`);
        return send(res, 200, { ok: true, count: db.outboundCount });
      }
      // ================= 领料单（登录即可访问，内部按角色+状态校验） =================
      // ---- ㉖⑩ PDA异常日志自动上报：POST {dev,app,items:[{t,e,d,u}]}（每设备一批，180天/2000批滚动） ----
      if (req.method === 'POST' && p === '/api/errlog') {
        const b = await readBody(req);
        const items = Array.isArray(b.items) ? b.items.slice(0, 300) : [];
        if (!items.length) return send(res, 400, { ok: false, msg: 'items为空' });
        const clean = items.map((x) => ({ t: String(x && x.t || '').slice(0, 32), e: String(x && x.e || '').slice(0, 60), u: String(x && x.u || '').slice(0, 30), d: String(x && x.d || '').slice(0, 600) }));
        db.errLogs = db.errLogs || [];
        db.errLogs.push({ id: newId('el'), at: Date.now(), by: u.name, dev: String(b.dev || '').slice(0, 40), app: String(b.app || '').slice(0, 20), items: clean });
        const cut = Date.now() - 180 * 864e5;
        db.errLogs = db.errLogs.filter((x) => (x.at || 0) > cut);
        if (db.errLogs.length > 2000) db.errLogs = db.errLogs.slice(-2000);
        save();
        const nErr = clean.filter((x) => String(x.e).includes('异常')).length;
        if (nErr) { db.users.filter((x) => x.enabled && x.role === 'admin').forEach((x) => notify(x.id, 'car_alarm', ' PDA异常上报：' + u.name + '（' + (b.dev || '?') + ' v' + (b.app || '?') + '）新增 ' + nErr + ' 条异常', '')); pushOps(u, 'PDA异常上报', String(b.dev || ''), nErr + ' 条异常（' + clean.length + ' 条记录）'); }
        return send(res, 200, { ok: true, count: clean.length });
      }
      if (p === '/api/requisitions' || p.startsWith('/api/requisitions/') || p === '/api/req-templates' || p.startsWith('/api/req-templates/') || p === '/api/notifications' || p.startsWith('/api/notifications/')) { // ㉖v62 模板路由并入领料块（此前落入管理员闸门）
        const canReq = (db.features[u.role] || {}).requisition === true;
        const canRcv = (db.features[u.role] || {}).receive_confirm === true;
        const isWh = u.role === 'warehouse' || u.role === 'admin';

// ㉖v62 建单提效：常领清单（近60天本人聚合） + 产线模板（私有+共享）
        // 常领：频次×最近加权排序，带上次数量与在架托数，物料员一键加单不输零件号
        if (req.method === 'GET' && p === '/api/requisitions/frequent') {
          const cut = Date.now() - 60 * 864e5;
          const agg = {}; // partNo -> {pn,nm,n,last,lastQty,lastNo}
          for (const r of db.requisitions) {
            if (r.by !== u.id) continue;
            const t = Date.parse(r.createdAt || ''); if (!(t > cut)) continue;
            for (const it of (r.items || [])) {
              const pn = String(it.partNo || '').toUpperCase(); if (!pn) continue;
              const a = agg[pn] = agg[pn] || { pn, nm: it.itemName || '', n: 0, last: 0, lastQty: 0, lastNo: '' };
              a.n++;
              if (t >= a.last) { a.last = t; a.lastQty = Number(it.qty) || 0; a.lastNo = r.no; if (it.itemName) a.nm = it.itemName; }
            }
          }
          // 在架托数：账本按框键归并（框=托口径）
          const _boxOf = {};
          for (const l of Object.values(db.ledger || {})) {
            if (!l.p) continue;
            const k = boxKeyOf(l); const pn = String(l.p).toUpperCase();
            (_boxOf[pn] = _boxOf[pn] || new Set()).add(k);
          }
          let _risk = {}; try { for (const x of stockRiskOf(60).list) _risk[x.pn] = x.daysLeft; } catch (_) {} // ㉖v63 断料天数并入常领chip
          const list = Object.values(agg).map((a) => ({ ...a, inBoxes: _boxOf[a.pn] ? _boxOf[a.pn].size : 0, daysLeft: _risk[a.pn] === undefined ? null : _risk[a.pn] }))
            .sort((x, y) => (y.n * 1000 + y.last / 864e5) - (x.n * 1000 + x.last / 864e5)).slice(0, 30);
          return send(res, 200, { ok: true, list, days: 60 });
        }
        // 产线模板：本人私有 + 同事共享（shared 标记）；每人上限10个，单模板≤20行
        if (p === '/api/req-templates') {
          db.reqTemplates = db.reqTemplates || [];
          if (req.method === 'GET') {
            const mine = db.reqTemplates.filter(t => t.by === u.id || (t.shared && t.status !== 'off'));
            return send(res, 200, { ok: true, list: mine.map(t => ({ id: t.id, name: t.name, by: t.by, byName: t.byName, shared: !!t.shared, items: t.items, use: t.use || 0, at: t.at })) });
          }
          if (req.method === 'POST') {
            const b = await readBody(req);
            const name = String(b.name || '').trim().slice(0, 20);
            if (!name) return send(res, 400, { ok: false, msg: '模板名必填' });
            const items = [];
            for (const it of (Array.isArray(b.items) ? b.items : [])) {
              const pn = String(it.partNo || '').trim().toUpperCase(); const qty = Number(it.qty);
              if (!pn || !(qty > 0)) continue;
              items.push({ partNo: pn, itemName: String(it.itemName || '').slice(0, 40), qty });
            }
            if (!items.length) return send(res, 400, { ok: false, msg: '模板至少一行有效零件号+数量' });
            if (items.length > 20) return send(res, 400, { ok: false, msg: '单模板最多20行' });
            // ㉖v62 原地编辑：带 id 且是本人（或管理员）→ 更新母本，use 计数保留
            if (b.id) {
              const t0 = db.reqTemplates.find((x) => x.id === String(b.id));
              if (!t0) return send(res, 404, { ok: false, msg: '模板不存在' });
              if (t0.by !== u.id && u.role !== 'admin') return send(res, 403, { ok: false, msg: '只能编辑自己的模板' });
              t0.name = name; t0.items = items; t0.shared = b.shared === true; t0.at = new Date().toISOString();
              save();
              console.log(`[rtpl] ${u.name} 编辑模板「${name}」${items.length}行${t0.shared ? '(共享)' : ''}`);
              return send(res, 200, { ok: true, id: t0.id });
            }
            const mineCnt = db.reqTemplates.filter(t => t.by === u.id).length;
            if (mineCnt >= 10) return send(res, 400, { ok: false, msg: '每人最多10个模板，请先删除旧的' });
            const t = { id: newId('rtpl'), name, by: u.id, byName: u.name, shared: b.shared === true, items, use: 0, at: new Date().toISOString() };
            db.reqTemplates.push(t); save();
            console.log(`[rtpl] ${u.name} 存模板「${name}」${items.length}行${t.shared ? '(共享)' : ''}`);
            return send(res, 200, { ok: true, id: t.id });
          }
          if (req.method === 'DELETE') {
            const id = String(url.searchParams.get('id') || '');
            const t = db.reqTemplates.find(x => x.id === id);
            if (!t) return send(res, 404, { ok: false, msg: '模板不存在' });
            if (t.by !== u.id && u.role !== 'admin') return send(res, 403, { ok: false, msg: '只能删除自己的模板' });
            db.reqTemplates = db.reqTemplates.filter(x => x.id !== id); save();
            return send(res, 200, { ok: true });
          }
        }
        if (req.method === 'POST' && /^\/api\/req-templates\/[\w-]+\/use$/.test(p)) {
          db.reqTemplates = db.reqTemplates || [];
          const t = db.reqTemplates.find(x => x.id === p.split('/')[3]);
          if (t) { t.use = (t.use || 0) + 1; save(); }
          return send(res, 200, { ok: true });
        }
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
            let itemName = String(it.itemName || '').replace(/[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, 80);
            if (!itemName) { // ㉖v95b 人性化：名称留空按物料字典兜底（网页联想未命中/旧版PDA不传名时，单据不再空着名称）
              const dd = db.itemDict && (db.itemDict[partNo.toUpperCase()] || db.itemDict[partNo]);
              if (dd && dd.nm) itemName = String(dd.nm).replace(/[\uFFFD]/g, '').slice(0, 80);
            }
            clean.push({ partNo, itemName, qty, issued: [], rush: it.rush === true }); // v55 行级急料（列表靠前=加急）
          }
          if (!clean.length) return send(res, 400, { ok: false, msg: '至少一行有效的零件号+数量' });
          if (clean.length > 20) return send(res, 400, { ok: false, msg: '一张单最多20行' });
          let assignee = null;
          const assigneeId = String(b.assigneeId || '').trim();
          if (assigneeId) {
            assignee = db.users.find(x => x.id === assigneeId && x.enabled && x.role === 'warehouse'); // ㉖v56 只能指定仓管员备料：admin 是管理角色不进备料链（候选列表与校验同口径）
            if (!assignee) return send(res, 400, { ok: false, msg: '指定的备料人不存在/未启用/非仓管员（管理员不参与备料）' });
          }
          const now = new Date();
          const ts = localTs(now); // ㉖v80 单号=本地时间（旧版toISOString=UTC，10:43的单显示0243差8小时）
          const r = {
            id: newId('rq'), no: `LL${ts}${String(db.requisitions.length % 100).padStart(2, '0')}`,
            by: u.id, byName: u.name, items: clean, status: 'pending',
            remark: String(b.remark || ''), createdAt: now.toISOString(), history: [],
            assigneeId: assignee ? assignee.id : '', assigneeName: assignee ? assignee.name : '',
            assignOpenAt: assignee ? new Date(now.getTime() + P().assignMin * 60000).toISOString() : '',
            rush: b.rush === true || clean.some((i) => i.rush), // 急料：调度优先插队+催扫5分钟广播（v55 任一行急=整单急）
            rushBy: (b.rush === true || clean.some((i) => i.rush)) ? u.name : '', // ㉖v61 标急人（入队与队列控制台展示"插队·谁"）
            needDate: /^\d{4}-\d{2}-\d{2}$/.test(String(b.needDate || '')) ? String(b.needDate) : '', // 第3档 期望到货日期（PDA默认值可预填）
          };
          db.requisitions.push(r);
          // ㉖v88 急料感知前移：物料员勾选急料的单，创建时刻通知即带🔥标识
          // （现场复盘 10/23：两笔急料单"创建→接单"仍等 9.5/10.5 分钟——旧版通知与普通单同文案，
          //   插队只作用于 AGV 队列（接单之后），仓管对"这张单急"毫无感知；另设催办定时器兜底防漏看）
          const rushTag = r.rush ? '🔥急料｜' : '';
          if (assignee) {
            notify(assignee.id, r.rush ? 'req_rush' : 'req_new', `${rushTag}${u.name} 指定你备料：领料单 ${r.no}：${reqItemsSuggestText(r)}（30分钟内未接单将放开给全部仓管）`, r.id);
          } else {
            db.users.filter(x => x.role === 'warehouse' && x.enabled).forEach(x =>
              notify(x.id, r.rush ? 'req_rush' : 'req_new', `${rushTag}${u.name} 提交了领料单 ${r.no}：${reqItemsSuggestText(r)}${r.rush ? '\n请优先接单（AGV 已按急料插队）' : ''}`, r.id));
          }
          if (r.rush) {
            const whIds = () => db.users.filter((x) => x.role === 'warehouse' && x.enabled).map((x) => x.id);
            setTimeout(() => {
              try {
                const cur = db.requisitions.find((x) => x.id === r.id);
                if (!cur || cur.status !== 'pending') return; // 已接单/取消不再催
                for (const uid of whIds()) notify(uid, 'req_rush', `⏰ 急料单 ${r.no}（${cur.byName}）已挂 ${P().rushRemindMin} 分钟无人接单，请优先处理`, r.id);
                console.log(`[rush] 急料单 ${r.no} ${P().rushRemindMin}分钟未接单，催办全体仓管`);
              } catch (_) {}
            }, P().rushRemindMin * 60000).unref();
          }
          save();
          console.log(`[req] ${u.name} 下单 ${r.no}${assignee ? ' → 指定 ' + assignee.name : ''}`);
          // ㉖v52 排队位次看板：本单在待接单/备料中队列里的排位、前方单数、正在给谁备料、AGV 活跃任务数、预计备齐时长
          let board = null; try { board = queueBoardOf(r); } catch (_) {}
          return send(res, 200, { ok: true, req: reqView(r), queueAhead: board ? board.aheadCount : null, queue: board });
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

        // ㉖v52 备料排队看板：带 my=单号算本人排位；不带则全员队列全景（网页看板/仓管督办用）
        if (req.method === 'GET' && p === '/api/requisitions/queue') {
          sweepAssignOpen();
          const my = String(url.searchParams.get('my') || '').trim();
          const nowReq = my ? db.requisitions.find((x) => x.id === my) : null;
          const board = queueBoardOf(nowReq);
          board.at = new Date().toISOString();
          // 全员视角不含 mine 语义时仍可用：rank=null 时前端只渲染 items
          return send(res, 200, { ok: true, board });
        }

        // 可选仓管员列表（新建单指定用）；lastAssigneeId=本人最近一次指定过的仓管（默认带出）
        if (req.method === 'GET' && p === '/api/requisitions/warehouse-users') {
          const wh = db.users.filter(x => x.enabled && x.role === 'warehouse').map(x => ({ id: x.id, name: x.name })); // ㉖v56 指定备料候选人=仅仓管员（与建单校验同口径，PDA/网页弹层共用）
          const last = db.requisitions.slice().reverse().find(r => r.by === u.id && r.assigneeId);
          const lastAssigneeId = last && wh.some(x => x.id === last.assigneeId) ? last.assigneeId : '';
          return send(res, 200, { ok: true, users: wh, lastAssigneeId });
        }

        // 通知拉取（㉖v50 改只读：read 标志仅由消息中枢"进分类看过/清未读"或网页"全部已读"清除；
        // 旧版"取回即已读"会被 30 秒轮询悄悄清空，红点永远显示不出来）
        if (req.method === 'GET' && p === '/api/notifications') {
          sweepAssignOpen();
          const mine = db.notifications.filter(n => n.to === u.id && !n.read).slice(-50);
          return send(res, 200, { ok: true, notifications: mine });
        }

        // 消息中心历史（只读，不改read标志；返回本人最近 limit 条，默认30）
        if (req.method === 'GET' && p === '/api/notifications/history') {
          const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '30') || 30));
          const mine = db.notifications.filter(n => n.to === u.id).slice(-limit).reverse();
          return send(res, 200, { ok: true, notifications: mine });
        }

        // ㉖⑯ 网页铃铛：未读计数+未读列表（只读，绝不标已读，避免轮询误清）
        if (req.method === 'GET' && p === '/api/notifications/unread') {
          const un = db.notifications.filter(n => n.to === u.id && !n.read).slice(-50).reverse();
          const total = db.notifications.filter(n => n.to === u.id && !n.read).length;
          return send(res, 200, { ok: true, unread: total, notifications: un });
        }
        // ㉖⑯ 网页消息中心：显式全部已读（用户点按钮才清，非轮询）
        if (req.method === 'POST' && p === '/api/notifications/readall') {
          let n = 0; db.notifications.forEach((x) => { if (x.to === u.id && !x.read) { x.read = true; n++; } });
          if (n) save();
          return send(res, 200, { ok: true, marked: n });
        }
        // ㉖v50 消息中枢二级页：按分类标记已读（只清本人该类，红点精准消失）
        if (req.method === 'POST' && p === '/api/notifications/readgroup') {
          const b = await readBody(req);
          const types = Array.isArray(b.types) ? b.types.map(String).slice(0, 30) : [];
          if (!types.length) return send(res, 400, { ok: false, msg: '缺 types' });
          let n = 0;
          db.notifications.forEach((x) => { if (x.to === u.id && !x.read && types.includes(String(x.type))) { x.read = true; n++; } });
          if (n) save();
          return send(res, 200, { ok: true, marked: n });
        }

        // 状态动作：/:id/accept|reject|scan|unscan|transfer|skip|loc|confirm|cancel|reassign|agv|rush
        const mAct = p.match(/^\/api\/requisitions\/([\w-]+)\/(accept|reject|scan|unscan|transfer|skip|loc|confirm|cancel|reassign|agv|rush|urge|delitem|ready|back)$/); // ㉖v94m 断链修复：v82加unscan分支时漏改本白名单→PDA转单窗取消勾选的"撤扫"请求从未进过处理代码
        if (req.method === 'POST' && mAct) {
          const r = findReq(mAct[1]);
          if (!r) return send(res, 404, { ok: false, msg: '领料单不存在' });
          const act = mAct[2];
          const b = await readBody(req);
          const hpush = (text) => { r.history.push({ time: new Date().toISOString(), by: u.name, text }); };
          // issued 统一为 [{c:标签, q:件数}]，兼容旧数据纯字符串（按0件计）
          const normIssued = (i) => (i.issued || []).map(x => typeof x === 'string' ? { c: x, q: 0 } : Object.assign({ c: String(x.c || ''), q: Number(x.q) || 0 }, x.l ? { l: String(x.l) } : {}, x.b ? { b: String(x.b) } : {}, x.f ? { f: String(x.f) } : {}, x.pid ? { pid: String(x.pid) } : {}, x.n ? { n: String(x.n) } : {}, x.e ? { e: 1, by: x.by || '', why: x.why || '' } : {})); // ㉖v92c 保留 l：旧版丢字段致出库流水原货位空白；㉖v94q 保留 b/f/pid/n：撤扫复挂要还原批次与托号，否则账本批次被清空→FIFO排序退化成按货位、同托归并失效
          const issuedQty = (i) => normIssued(i).reduce((s, e) => s + e.q, 0);
          // 全部行到达终态（已转/已跳过）→ 已备齐，通知含短装明细
          const finalize = () => {
            if (!(r.status === 'accepted' && r.items.every(i => i.transferred || i.skipped))) return;
            r.status = 'ready'; r.readyAt = Date.now(); // ㉖⑫ 精确"进入待签收"时刻（超30分判定不再被催单等后续事件污染）
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
            r.status = 'accepted'; r.acceptedBy = u.name; r.acceptedAt = new Date().toISOString();
            hpush(`接单（${u.name}）${r.assigneeName && r.assigneeId !== u.id ? '，原指定 ' + r.assigneeName + ' 超时未接' : ''}`);
            notify(r.by, 'req_accept', `你的领料单 ${r.no} 已由 ${u.name} 接单备料`, r.id);
            if (r.assigneeId && r.assigneeId !== u.id) { const aU = db.users.find((x) => x.id === r.assigneeId); if (aU && aU.enabled) notify(r.assigneeId, 'req_reassign', `📢 你被指定的领料单 ${r.no} 已由 ${u.name} 接单，请勿再备料`, r.id); } // ⑲防原指定人白备料
            // 接单即派：建议货架框自动入队（是否真实下发仍由演算/真实模式把关）
            const nAuto = autoEnqueueOnAccept(r, u.name, u.id);
            if (nAuto > 0) {
              hpush(`接单即派：${nAuto} 个货架框已加入AGV队列`);
              rcsPoll(); // 立即调度一轮
            }
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
            r.assignOpenAt = new Date(Date.now() + P().assignMin * 60000).toISOString();
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
            // ㉖② 全局出库防重：该标签已在其他出库单/其他领料单发过 → 拦（应急登记旁路，需原因）
            if (b.emergency !== true) { const _lst = labelStatus(code); const _b2 = labelBlockReason(_lst, 'out') || labelBlockReason(_lst, 'x'); if ((_lst.inOutbound.length || _lst.inIssued.length) && _b2) return send(res, 400, { ok: false, msg: _b2 }); const _act = _lst.inInspect.filter((q) => q.state !== 'waitReturn'); if (_act.length) return send(res, 400, { ok: false, msg: '该框检验中，不可发料出库' }); if (_lst.inInspect.length) hpush('🔁 检验判退货框扫码出库：' + code + '（' + (_lst.inInspect[0].retReason || '') + '，检验单 ' + _lst.inInspect[0].id + '）'); }
            // ㉖v59 方案B（用户拍板2026-10-16）：一框一发闸已移除——一筐多码逐码扫码、各记各的MES数量（10-13数量口径=各标签之和的自然延伸：两标签各25→整筐50须扫两码各记25）。同码防重由上方"已扫过"闸兜底；超发由行级qty与防呆体检兜底。
            // ㉖v58 防呆补强：服务端账本零件号交叉核对——框码在账本的实际零件号必须与所选行一致，堵"PDA选错行/扫错框"错发（PDA端MES零件号校验只在客户端，此闸为服务端兜底；应急登记可旁路但工单历史留痕）
            {
              const _pnSelf = (db.ledger || []).find(x => String(x.c || '').toUpperCase() === code.toUpperCase());
              if (_pnSelf && _pnSelf.p && String(_pnSelf.p).toUpperCase() !== String(b.partNo || '').toUpperCase()) {
                if (b.emergency !== true) return send(res, 400, { ok: false, msg: `框 ${code} 账本零件号 ${_pnSelf.p} 与所选行 ${b.partNo} 不符，是否选错框？如账本有误请走应急登记并注明原因` });
                hpush(`⚠️ 账本零件号不符应急旁路：框 ${code} 账本零件 ${_pnSelf.p} ≠ 所选行 ${b.partNo}（${u.name}${String(b.why || '').trim() ? '：' + String(b.why || '').trim() : ''}）`);
              }
            }
            const target = r.items.find(i => i.partNo === b.partNo);
            if (!target) return send(res, 400, { ok: false, msg: '该零件号不在本单内' });
            if (target.transferred) return send(res, 400, { ok: false, msg: `行 ${target.partNo} 已转MES出库（实发${issuedQty(target)}件），不可再补扫；多叫下来的框请人工返架回库，或走「直调」页出库，或留待下次开单领用` });
            // ㉖v94p 严格FIFO发料闸（用户要求"设置fifo建议只能扫建议中的码"）：
            // 白名单=该行取货建议的标签级清单（flatBoxes）+ 同托兄弟码（boxes[].allCodes，一车整托同到）
            //        + 已叫车未扫框（calledPending）+ **本单已叫车的全部码（agvCalled）**。
            // 最后一项是必需的：pickSuggest 只在"该行已发齐"时才返回 calledPending，未发齐时已叫车到站的框不在建议清单里
            // → 若只认建议清单，现场"叫6框车、建议只列2框"时另外4框到台会扫不了（闸把自己的货挡在门外）。
            // 本单叫过车的框是仓管自己点的，货必然送到台，必须放行；跳批拦截只针对"没叫过车、不在建议里"的码。
            // 不在名单内=跳批拣货或扫错框，直接拒绝并告知该拣哪个批次；旧版只有黄色提醒、确认即放行，等于没有强制力。
            // 应急登记(emergency)可旁路但写工单历史留痕——账本滞后致建议为空时的唯一逃生口，防彻底卡死发料。
            // ㉖v94s 晚批次确认旁路（用户拍板）：旧体验是"弹黄提醒→点确认继续→服务端又拦→再弹红窗"两道窗绕。
            // 现在：客户端FIFO黄窗的确认标记(b.fifo.ok)随scan上报，服务端复核"扫入批次确实晚于建议最早批次"才放行（晚批次属人工可裁决的
            // 正常业务），并写"🟡FIFO违反"审计留痕；而"同批次却不在清单"（扫错单/账本外幽灵码）不给旁路，照拦——不信任未经验证的确认标记。
            if (P().strictFifo === 1 && b.emergency !== true) {
              const _excl = new Set(normIssued(target).map((e) => String(e.c).toUpperCase()));
              const _need = Math.max(0, (Number(target.qty) || 0) - issuedQty(target));
              const _sg = pickSuggest(target.partNo, _need, _excl, agvMapOf(target));
              const _allow = new Set();
              for (const bx of (_sg.boxes || [])) { for (const c of (bx.allCodes || bx.codes || [])) _allow.add(String(c).toUpperCase()); for (const it of (bx.items || [])) _allow.add(String(it.c).toUpperCase()); }
              for (const f of (_sg.flatBoxes || [])) _allow.add(String(f.c || '').toUpperCase());
              for (const f of (_sg.calledPending || [])) _allow.add(String(f.c || '').toUpperCase());
              for (const e of (target.agvCalled || [])) _allow.add(String(e.c || '').toUpperCase()); // 本单已叫车的框：到站必须能扫
              _allow.delete('');
              if (_allow.size && !_allow.has(code.toUpperCase())) {
                const _oldestLot = (_sg.boxes || []).map((x) => String(x.b || '').trim()).find(Boolean) || '';
                const _scanLot = String((((db.ledger || []).find((x) => String(x.c || '').toUpperCase() === code.toUpperCase())) || {}).b || '').trim();
                const _isLater = !!(_oldestLot && _scanLot && _scanLot > _oldestLot); // 晚批次=黄窗场景；同批/未知批=幽灵码场景
                if (_isLater && b.fifo && b.fifo.ok === 1) { // 客户端已人工确认+服务端复核批次成立 → 放行
                  hpush(`🟡FIFO违反放行 ${target.partNo} 标签 ${code}（批${_scanLot}，最早${_oldestLot}，不在建议清单，人工确认继续）（${u.name}）`);
                  pushEvent('FIFO违反', String(target.partNo || ''), `标签 ${code} 扫入批次${_scanLot}（最早${_oldestLot}）人工确认继续（${u.name}）`);
                } else {
                  // 同批次却不在清单（如建议"够数即停"没列到的框）→ 不能误导性地说"请先拣最早批次"，改为直接给可扫清单
                  const _hint = _isLater ? `——请先拣最早批次 ${_oldestLot}${b.fifo && b.fifo.ok === 1 ? '' : '（确认继续可放行）'}` : `——本行可扫：${[..._allow].slice(0, 6).join('/')}${_allow.size > 6 ? ' 等' + _allow.size + '码' : ''}`;
                  hpush(`⛔ 严格FIFO拦截：扫入 ${code}${_scanLot ? '（批' + _scanLot + '）' : ''} 不在建议清单（建议 ${_allow.size} 码：${[..._allow].slice(0, 6).join('/')}）`);
                  save(); // 留痕立即落盘：旧写法只改内存，靠无关周期存盘才落库，重启即丢审计痕迹
                  return send(res, 400, { ok: false, msg: `标签 ${code} 不在本行取货建议清单内（严格FIFO：只能扫建议的框）${_hint}。若账本与实际不符，请先核对货位账本，或走「应急登记」并注明原因` });
                }
              }
              if (!_allow.size) { // 建议为空（该行已发齐或账本无在架框）：不做拦截，交给既有"已发齐/转单锁定"等闸处理
                const _cp = _sg.calledPending || [];
                if (!_cp.length && _need > 0) return send(res, 400, { ok: false, msg: `零件 ${target.partNo} 账本无在架可拣框，取货建议为空——请先核对货位账本（该框可能未登记或已出库），或用「应急登记」` });
              }
            } else if (P().strictFifo === 1 && b.emergency === true) {
              hpush(`⚠️ 严格FIFO应急旁路：框 ${code}（${u.name}${String(b.why || '').trim() ? '：' + String(b.why || '').trim() : ''}）`);
            }
            const q = Number(b.qty) || 0;
            if (q <= 0) return send(res, 400, { ok: false, msg: '缺少该标签的件数(qty)' });
            target.issued = normIssued(target);
            const em = b.emergency === true;
            // ㉖v79c 服务器权威兜底：旧版PDA本地无该标签行（导入行早于测试墓碑被拉取跳过等）→ fromLoc 传空，
            // 旧版靠PDA本地拣下推送，PDA没行就不拣——发完框仍在架：向导卡"叫AGV"、出库流水缺原货位、库存虚高三连
            let _fl = String(b.fromLoc || '').trim().toUpperCase();
            const _ledRow = (db.ledger || []).find(x => String(x.c || '').toUpperCase() === code.toUpperCase());
            if (!_fl && _ledRow) _fl = String(_ledRow.l || '').toUpperCase();
            target.issued.push(Object.assign({ c: code, q, l: _fl }, _ledRow ? { b: String(_ledRow.b || ''), f: String(_ledRow.f || ''), pid: String(_ledRow.pid || ''), n: String(_ledRow.n || '') } : {}, em ? { e: 1, by: u.name, why: String(b.why || '').trim() } : {})); // ㉖v94q 存批次/容器/托号：撤扫复挂据此还原，否则账本批次被清空削弱FIFO
            if (_ledRow) { // 服务器直接拣下（单码，方案B口径）+ 墓碑 + 释放预占，不依赖PDA本地状态
              const _ix = db.ledger.indexOf(_ledRow);
              if (_ix >= 0) db.ledger.splice(_ix, 1);
              (db.ledgerTomb = db.ledgerTomb || []).push({ c: code.toUpperCase(), t: Date.now(), rec: Date.now() });
              db.ledgerRev = (db.ledgerRev || 0) + 1; db.ledgerAt = new Date().toISOString(); db.ledgerBy = u.name;
              if (db.locReserve) delete db.locReserve[String(_ledRow.l || '').toUpperCase()];
            }
            const got = issuedQty(target);
            hpush(`${em ? '⚠️应急发料' : '发料'} ${b.partNo} 标签 ${code}（${q}件，累计 ${got}/${target.qty}）${em ? ' · MES不可用改人工录入（' + u.name + (String(b.why || '').trim() ? '：' + String(b.why || '').trim() : '') + '）' : ''}`);
            const ff = b.fifo; if (ff && ff.ok) pushEvent('FIFO违反', String(b.partNo || ''), `标签 ${code} 扫入批次${String(ff.lot || '')}（最早${String(ff.oldest || '')}）人工确认继续（${u.name}）`);
            const ff2 = b.fifo; if (ff2 && ff2.ok) hpush(`🟡FIFO违反 ${b.partNo} 标签 ${code} 扫入批次${String(ff.lot || '')}（最早${String(ff.oldest || '')}）人工确认继续（${u.name}）`);
            // 不再自动置 ready：ready 由每行 transfer/skip 到终态后 finalize 决定
          } else if (act === 'unscan') {
            // ㉖v82 撤扫（转单确认窗取消勾选=不发的框）：从 issued 移除该码 + 账本复挂原位 + 清墓碑——scan 的对称逆操作
            if (!isWh) return send(res, 403, { ok: false, msg: '仅仓管员可操作' });
            if (r.status !== 'accepted') return send(res, 400, { ok: false, msg: `当前状态[${r.status}]不可撤扫` });
            const target = r.items.find(i => i.partNo === b.partNo);
            if (!target) return send(res, 400, { ok: false, msg: '该零件号不在本单内' });
            if (target.transferred) return send(res, 400, { ok: false, msg: `行 ${target.partNo} 已转MES，不可撤扫` });
            const code = String(b.barcode || '').trim().toUpperCase();
            if (!code) return send(res, 400, { ok: false, msg: '缺少 barcode' });
            target.issued = normIssued(target);
            const _ix = target.issued.findIndex((e) => String(e.c).toUpperCase() === code);
            if (_ix < 0) return send(res, 200, { ok: true, req: reqView(r) }); // 幂等：本就不在已发里
            const _ij = target.issued[_ix];
            target.issued.splice(_ix, 1);
            let _ul = String(_ij.l || '').trim().toUpperCase();
            if (!_ul) { const _meta = (db.seenIn || {})[code]; _ul = String((_meta && _meta.l) || '').trim().toUpperCase(); } // 兜底：首次入账登记位（旧版PDA发料不带l时也能复挂）
            // ㉖v94m 撤扫复挂占用闸（仓管视角审计发现）：发料销行后原货位在账本"显空"，若期间已有另一框合法登记进去，
            // 撤扫强行复挂=双框同位脏行（误导建议区/v94l叫车闸/两框同位互撞）。同托号或同位同件按 boxKeyOf 并框语义=同框放行
            // （半发框多码逐码扫/撤是方案B正常作业）；不同零件占位=必为别框，与网页恢复同策略：只退记账不上账，提示按实物位置补登记。
            const _fk = _ul ? (db.ledger || []).filter((x) => String(x.l || '').toUpperCase() === _ul && String(x.c || '').toUpperCase() !== code && String(x.p || '').toUpperCase() !== String(target.partNo || '').toUpperCase()) : [];
            if (_ul && _fk.length) {
              hpush(`↩️ 撤扫 ${target.partNo} 标签 ${code}（${_ij.q}件，原货位 ${_ul} 现已被 ${_fk.map((x) => x.c).join("/")} 登记占用，未复挂——该框请按实物位置用「位置登记」补账，累计 ${issuedQty(target)}/${target.qty}）（${u.name}）`);
            } else if (_ul && !db.ledger.some((x) => String(x.c || '').toUpperCase() === code)) { // 复挂原位（撤扫≠真出库，货还在站台/架上）
              // ㉖v94q 还原批次/容器/托号：旧版硬写 b:'' f:'' pid:'' → 撤扫一次批次就丢，FIFO 排序退化成按货位、同托归并失效
              db.ledger.push({ c: code, l: _ul, f: String(_ij.f || ''), t: Date.now(), p: String(target.partNo || '').toUpperCase(), n: String(_ij.n || target.itemName || ''), q: Number(_ij.q) || 0, b: String(_ij.b || ''), pid: String(_ij.pid || ''), mv: '登记', src: '撤扫复位', by: u.name });
              (db.ledgerTomb = db.ledgerTomb || []).splice(0, db.ledgerTomb.length, ...db.ledgerTomb.filter((x) => String(x.c).toUpperCase() !== code));
              db.ledgerRev = (db.ledgerRev || 0) + 1; db.ledgerAt = new Date().toISOString(); db.ledgerBy = u.name;
              hpush(`↩️ 撤扫 ${target.partNo} 标签 ${code}（${_ij.q}件退回在架 ${_ul}，累计 ${issuedQty(target)}/${target.qty}）（${u.name}）`); // ㉖v94m 修笔误：旧版写 $_ul 花括号缺失→历史显示字面量"$_ul"
            } else if (!_ul) {
              hpush(`↩️ 撤扫 ${target.partNo} 标签 ${code}（${_ij.q}件，原货位未知未复挂——请在PDA「位置登记」补登记该框实际货位，累计 ${issuedQty(target)}/${target.qty}）（${u.name}）`); // 无位置不复挂，防账本脏行
            } else {
              hpush(`↩️ 撤扫 ${target.partNo} 标签 ${code}（${_ij.q}件，账本已有该码不重复复挂，累计 ${issuedQty(target)}/${target.qty}）（${u.name}）`);
            }
            // ㉖v94o 撤扫物理联动（10/25 N26J220232 现场复盘：账面撤回复位、实物却停在 CK-10 站台——撤扫只动了账，没人管车）：
            //  ① 叫车还没下发 → 顺手撤销排队项（防车白跑）；② 已下发未叉取 → 联动撤 WMAS 任务，车就地终止；
            //  ③ 已到站/搬运完成 → 自动发起"站台→原货位"返架叫车（manualOnly 固定终点，与人工入库叫车同一套闸门与对账链）；撤销被拒（车已叉起）→ 提示人工处置，不盲下返架指令。
            try {
              const bq = (db.agvQueue || []).filter((x) => String(x.code || '').toUpperCase() === code && ['排队', '下发中', '已下发', '到站', '完成'].includes(x.state)).sort((a, b2) => (b2.at || 0) - (a.at || 0))[0];
              if (bq && bq.state === '排队') {
                retireQueueItem(bq, '取消', '撤扫联动：未下发即撤销');
                hpush(`🛑 撤扫联动：框 ${code} 叫车任务未下发，已同步撤销（货仍在架）`);
                save();
              } else if (bq && (bq.state === '下发中' || bq.state === '已下发')) {
                let cancelled = false;
                const tk2 = await wmasToken();
                if (tk2) {
                  const tn2 = bq.wmsTask || await wmasTaskNoOf(bq, tk2);
                  if (!tn2) cancelled = true;
                  else {
                    const cr2 = await wmasHttp('POST', '/api/logistics/agv-task/cancelTask', tk2, [tn2]);
                    cancelled = wmasOk(cr2) || String((cr2 && (cr2.message || cr2.msg)) || '').includes('不存在');
                  }
                }
                if (cancelled) {
                  retireQueueItem(bq, '取消', '撤扫联动：车未叉取，任务已撤销');
                  hpush(`🛑 撤扫联动：框 ${code} 在途叫车已撤销（车未叉取，货仍在架 ${_ul || '原货位'}）`);
                } else {
                  (bq.trace = bq.trace || []).push('撤扫联动：叫车撤销被拒（车可能已叉取）');
                  hpush(`⚠️ 撤扫联动：框 ${code} 叫车撤销被拒——车可能已在搬运，到货后请人工返架（账面已复位 ${_ul || '原货位'}）`);
                  db.users.filter((x) => x.enabled && (x.role === 'warehouse' || x.role === 'admin')).forEach((x) => notify(x.id, 'req_arrive', `⚠️ 撤扫联动：框 ${code}（${target.partNo}）叫车撤销被拒，若已送到站台请人工送回货架`, ''));
                }
                save();
              } else if (bq && (bq.state === '到站' || bq.state === '完成') && _ul && (bq.station || bq.stationManual)) {
                const stn0 = String(bq.station || bq.stationManual || '');
                const dupIn = (db.agvQueue || []).some((x) => x.type === 'inbound' && String(x.code || '').toUpperCase() === code && ['排队', '下发中', '已下发'].includes(x.state));
                if (!dupIn) {
                  const itemB = { id: newId('cq'), code, fromLoc: stn0, stationManual: _ul, station: '', palletType: bq.palletType || palletTypeOf(code), type: 'inbound', manualOnly: true, ref: 'RK-' + code, reqNo: r.no, by: u.name, state: '排队', at: Date.now(), updAt: Date.now(), trace: [], unscanBack: r.no };
                  db.agvQueue = db.agvQueue || [];
                  await dispatchOne(itemB, Date.now(), [], [], (db.agvDispatchMode || 'dry') === 'live');
                  db.agvQueue.push(itemB); save();
                  const ph = itemB.state === '失败' ? `自动返架被拒(${String(itemB.err || '').slice(0, 40)})——请人工把框从 ${stn0} 送回 ${_ul}` : itemB.state === '已下发' ? `已自动发起返架叫车 ${stn0}→${_ul}，车到架边请确认` : `返架任务已排队 ${stn0}→${_ul}（切真实下发后自动发车）`;
                  hpush(`🔙 撤扫联动：框 ${code} 实物在站台 ${stn0}，${ph}`);
                  db.users.filter((x) => x.enabled && (x.role === 'warehouse' || x.role === 'admin')).forEach((x) => notify(x.id, 'req_arrive', `🔙 撤扫返架：框 ${code}（${target.partNo}）${ph}`, ''));
                  notify(r.by, 'req_flow', `你的领料单 ${r.no}：框 ${code} 已撤扫，${ph}`, r.id);
                } else hpush(`🔙 撤扫联动：框 ${code} 已有在途返架任务，不重复发起`);
              }
            } catch (e) { hpush(`⚠️ 撤扫物理联动异常：${e.message}`); }
          } else if (act === 'agv') {
            // 叫AGV登记：仓管从货架叫车叉框后记账，建议区该框标"已叫AGV"防重复叫车/漏叫
            if (!isWh) return send(res, 403, { ok: false, msg: '仅仓管员可登记' });
            if (r.status !== 'accepted') return send(res, 400, { ok: false, msg: `当前状态[${r.status}]不可登记` });
            const target = r.items.find(i => i.partNo === b.partNo);
            if (!target) return send(res, 400, { ok: false, msg: '该零件号不在本单内' });
            const code = String(b.barcode || '').trim().toUpperCase();
            if (!code) return send(res, 400, { ok: false, msg: '缺少 barcode' });
            // 防重复叫车：同框兄弟码已叫过且仍有活跃队列任务 → 拒绝；失败/取消出队的旧标记允许重叫
            const _lk = (s) => { s = String(s || '').trim().toUpperCase(); const i = s.lastIndexOf('-'); return i > 0 ? s.slice(0, i) : s; };
            const activeQ = new Set((db.agvQueue || []).filter((q) => ['排队', '下发中', '已下发', '到站'].includes(q.state)).map((q) => String(q.code).toUpperCase()));
            const called = (target.agvCalled || []).map(e => String(e.c).toUpperCase());
            const self = (db.ledger || []).find(x => String(x.c).toUpperCase() === code);
            const sp = self && self.p ? String(self.p).toUpperCase() : '';
            for (const x of db.ledger || []) {
              const xc = String(x.c).toUpperCase();
              if (called.includes(xc) && activeQ.has(xc) && (xc === code || (sp && String(x.p || '').toUpperCase() === sp) || (!sp && _lk(x.l) === _lk(self && self.l)))) {
                return send(res, 200, { ok: false, msg: `同框标签 ${xc} 正在AGV任务中，请勿重复叉取` });
              }
            }
            target.agvCalled = (target.agvCalled || []).filter(e => String(e.c).toUpperCase() !== code);
            target.agvCalled.push({ c: code, s: String(b.station || '').trim(), by: u.id, t: new Date().toISOString() });
            hpush(`叫AGV ${b.partNo} 标签 ${code} → ${b.station || '?'}`);
          } else if (act === 'rush') {
            // 急料开关：仅仓管/管理员；同步刷新该单未下发队列项的急标
            if (!isWh) return send(res, 403, { ok: false, msg: '仅仓管员/管理员可标记急料' });
            if (!['pending', 'accepted'].includes(r.status)) return send(res, 400, { ok: false, msg: `当前状态[${r.status}]不可标记` });
            r.rush = b.rush === true;
            if (r.rush) r.rushBy = u.name; else delete r.rushBy; // ㉖v61 记录插队人
            for (const q of db.agvQueue || []) { if (String(q.reqId) === r.id && q.state === '排队') { q.rush = r.rush; if (r.rush) q.rushBy = u.name; else delete q.rushBy; } } // ㉖v61 单级：整单排队框统一急标+插队人
            hpush(r.rush ? `标记急料（${u.name}）` : `取消急料（${u.name}）`);
            if (r.rush) db.users.filter((x) => (x.role === 'warehouse' || x.role === 'admin') && x.enabled && x.id !== u.id).forEach((x) =>
              notify(x.id, 'req_new', `🔥 急料单 ${r.no}（${r.byName}），请优先备料`, r.id));
          } else if (act === 'ready') { // ㉖B3 看板拖拽：备料中→标记备齐（仍有未处理行时强制备齐=短装收尾，必须给原因）
            if (!isWh) return send(res, 403, { ok: false, msg: '仅仓管员/管理员可标记备齐' });
            if (r.status !== 'accepted') return send(res, 400, { ok: false, msg: `当前状态[${r.status}]不可标记备齐` });
            const undone = r.items.filter(i => !i.transferred && !i.skipped);
            if (!undone.length) { finalize(); }
            else {
              const note = String(b.note || '').trim().slice(0, 60);
              if (!note) return send(res, 400, { ok: false, msg: `仍有 ${undone.length} 行未处理，强制备齐必须填写原因` });
              r.status = 'ready'; r.readyAt = Date.now(); // ㉖⑫ 强制备齐同样记录待签收时刻
              hpush(`网页标记备齐（强制）：${note}；未处理 ${undone.length} 行：${undone.slice(0, 5).map(i => i.partNo + '×' + i.qty).join('、')}${undone.length > 5 ? ' 等' : ''}`);
              notify(r.by, 'req_ready', `领料单 ${r.no} 已被 ${u.name} 标记备齐（注意：${undone.length} 行未发齐，原因：${note}），请确认收货`, r.id);
              db.users.filter(x => x.role === 'warehouse' && x.enabled && x.id !== u.id).forEach(x =>
                notify(x.id, 'req_ready_wh', `领料单 ${r.no}（${r.byName}）被 ${u.name} 强制标记备齐，未处理 ${undone.length} 行`, r.id));
            }
          } else if (act === 'back') { // ㉖B3 看板拖拽：待签收→退回继续备料
            if (!isWh) return send(res, 403, { ok: false, msg: '仅仓管员/管理员可退回备料' });
            if (r.status !== 'ready') return send(res, 400, { ok: false, msg: `当前状态[${r.status}]无需退回` });
            r.status = 'accepted';
            const note = String(b.note || '').trim().slice(0, 60);
            hpush(`退回继续备料${note ? '：' + note : ''}（${u.name}）`);
            notify(r.by, 'req_flow', `领料单 ${r.no} 被 ${u.name} 退回继续备料${note ? '：' + note : ''}，暂缓签收`, r.id);
            if (r.acceptedBy) db.users.filter(x => x.enabled && (x.role === 'warehouse' || x.role === 'admin') && x.name === r.acceptedBy).forEach(x =>
              notify(x.id, 'req_flow', `你接的领料单 ${r.no} 被 ${u.name} 退回继续备料${note ? '：' + note : ''}`, r.id));
          } else if (act === 'urge') {
            // 催单：仅下单人/管理员；同单10分钟限一次防轰炸；pending催接单、accepted催备料
            if (r.by !== u.id && u.role !== 'admin') return send(res, 403, { ok: false, msg: '仅下单人或管理员可催单' });
            if (!['pending', 'accepted'].includes(r.status)) return send(res, 400, { ok: false, msg: `当前状态[${r.status}]无需催单` });
            const lastU = Date.parse(String(r.lastUrgeAt || '')) || 0;
            const waitMin = Math.ceil((P().urgeMin * 60 * 1000 - (Date.now() - lastU)) / 60000);
            if (waitMin > 0) return send(res, 429, { ok: false, msg: `刚催过，请 ${waitMin} 分钟后再催` });
            const note = String(b.note || '').trim().slice(0, 60);
            r.lastUrgeAt = new Date().toISOString();
            let tg;
            if (r.status === 'accepted') {
              tg = db.users.filter(x => x.enabled && x.name === r.acceptedBy && x.id !== u.id);
              if (!tg.length) tg = db.users.filter(x => x.enabled && (x.role === 'warehouse' || x.role === 'admin') && x.id !== u.id);
            } else if (r.assigneeId && Date.now() < (Date.parse(String(r.assignOpenAt || '')) || 0)) {
              tg = db.users.filter(x => x.id === r.assigneeId && x.enabled && x.id !== u.id);
            } else {
              tg = db.users.filter(x => x.enabled && (x.role === 'warehouse' || x.role === 'admin') && x.id !== u.id);
            }
            const verb = r.status === 'accepted' ? '催备料' : '催接单';
            tg.forEach(x => notify(x.id, 'req_urge', `⏰ ${u.name} ${verb}：领料单 ${r.no}${note ? '（' + note + '）' : ''}`, r.id));
            hpush(`${verb}${note ? '：' + note : ''}（${u.name}，通知 ${tg.length} 人）`);
          } else if (act === 'delitem') {
            // ⑲物料员删行：仅本人pending单、行数>1（最后一行请取消整单）
            if (r.by !== u.id && u.role !== 'admin') return send(res, 403, { ok: false, msg: '仅下单人或管理员可删除行' });
            if (r.status !== 'pending') return send(res, 400, { ok: false, msg: '已接单的订单不能删行，请联系仓管员' });
            if (!Array.isArray(r.items) || r.items.length <= 1) return send(res, 400, { ok: false, msg: '仅剩一行，请取消整单' });
            const delPn = String(b.partNo || '').trim().toUpperCase();
            const di = (r.items || []).findIndex((i) => String(i.partNo || '').toUpperCase() === delPn);
            if (di < 0) return send(res, 400, { ok: false, msg: '该零件号不在本单内' });
            const removed = r.items.splice(di, 1)[0];
            hpush(`删除行 ${removed.partNo}×${removed.qty}（${u.name}）`);
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
            for (const e of target.issued) { const c1 = String((typeof e === 'string' ? e : e.c) || '').toUpperCase(); if (c1 && !db.seenOut[c1]) db.seenOut[c1] = { at: Date.now(), no: r.no, by: u.name }; } // ㉖② 转MES=出库承诺，登记历史防标签复用
            target.mesNo = String(b.mesNo || '').trim(); // App 侧出库单号，便于对账
            target.transferAt = Date.now(); target.transferBy = u.name; // ㉖v94r 转单时刻/人：出库台账兜底补建需要（PDA推送是fire-and-forget，失败即永久缺失）
            hpush(`转MES ${target.partNo} 实发${got}件${got < (Number(target.qty) || 0) ? '（短装' + ((Number(target.qty) || 0) - got) + '件）' : ''}（${u.name}）`);
            finalize();
            setTimeout(() => { try { outboundLedgerFix(); } catch (_) {} }, 3 * 60000); // ㉖v94r 3分钟后自查该行台账是否落库（给PDA推送留足窗口），缺则补建
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
            // 联动：该单未下发的AGV排队项一并取消；已下发的只能去RCS取消任务
            let qn = 0, qd = 0;
            for (const q of db.agvQueue || []) {
              if (String(q.reqId) !== r.id) continue;
              if (q.state === '排队' || q.state === '失败') { retireQueueItem(q, '取消', ''); qn++; } // ㉖v72b 统一回收：清叫车标记+站台预约，防单消后标记残留拦重新叫车
              else if (['下发中', '已下发', '到站'].includes(q.state)) qd++;
            }
            if (qn || qd) hpush(`AGV队列：取消 ${qn} 框排队${qd ? `，${qd} 框已下发需到RCS取消` : ''}`);
            if (qd) notify(u.id, 'req_cancel', `领料单 ${r.no} 有 ${qd} 框AGV任务已下发，取消订单不会自动停车，请到RCS调度界面取消任务`, r.id);
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

      // ---- 管理员：看板页鉴权开关（db.pageAuth，默认关=PDA门户iframe兼容；出APK后开启锁board/print页）----
      if (req.method === 'GET' && p === '/api/admin/pageauth') {
        return send(res, 200, { ok: true, on: db.pageAuth === true });
      }
      if (req.method === 'POST' && p === '/api/admin/pageauth') {
        const b = await readBody(req);
        db.pageAuth = !!b.on; save();
        pushOps(u,'看板门禁'+(db.pageAuth?'开':'关'), '', '');
        console.log(`[admin] ${u.name} 看板页鉴权 → ${db.pageAuth ? '开' : '关'}`);
        return send(res, 200, { ok: true, on: db.pageAuth });
      }

      // ---- ㉖B8 运营参数配置：GET 定义+当前值，POST 校验范围/乐观锁/留痕，保存即时生效 ----
      if (req.method === 'GET' && p === '/api/admin/devices') {
        if (u.role !== 'admin') return send(res, 403, { ok: false, msg: '仅管理员' });
        const list = Object.values(db.devices || {}).map((d) => ({ ...d, online: devOnline(d.id), usersList: Object.keys(d.users || {}).map((uid) => { const uu = db.users.find((x) => x.id === uid); return uu ? uu.name : uid; }) })).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
        return send(res, 200, { ok: true, list, audit: (db.devAudit || []).slice(-200).reverse() });
      }
      if (req.method === 'POST' && p === '/api/admin/devices') {
        if (u.role !== 'admin') return send(res, 403, { ok: false, msg: '仅管理员' });
        const b = await readBody(req); const act = String(b.act || ''), dev = String(b.dev || '');
        const d = (db.devices || {})[dev]; if (!d) return send(res, 404, { ok: false, msg: '设备不存在' });
        if (act === 'trust') { d.trusted = !d.trusted; devAuditPush(d.trusted ? '信任' : '取消信任', dev, d.ip, u, ''); }
        else if (act === 'block') { d.blocked = true; devAuditPush('拉黑', dev, d.ip, u, b.reason || ''); for (const t of Object.keys(db.sessions || {})) if (db.sessions[t].dev === dev) delete db.sessions[t]; }
        else if (act === 'unblock') { d.blocked = false; devAuditPush('解除拉黑', dev, d.ip, u, ''); }
        else if (act === 'kick') { let n = 0; for (const t of Object.keys(db.sessions || {})) if (db.sessions[t].dev === dev) { delete db.sessions[t]; n++; } devAuditPush('踢下线', dev, d.ip, u, n + '会话'); }
        else if (act === 'rename') { d.note = String(b.note || '').slice(0, 40); devAuditPush('备注', dev, d.ip, u, d.note); }
        else if (act === 'del') { delete db.devices[dev]; devAuditPush('删除设备', dev, d.ip, u, ''); }
        else return send(res, 400, { ok: false, msg: '未知操作' });
        save(); return send(res, 200, { ok: true });
      }
      if (req.method === 'GET' && p === '/api/admin/params') {
        const cur = P();
        const items = Object.entries(PARAMS).filter(([, d]) => !d.hide).map(([k, d]) => ({ k, grp: d.grp || '其他', name: d.name, unit: d.unit, min: d.min, max: d.max, def: d.d, val: cur[k], tip: d.tip, set: (db.params || {})[k] !== undefined })); // ㉖v69 hide=下架不展示（存储配置：高架固定/地面有专区）
        return send(res, 200, { ok: true, items, cfgRev: db.cfgRev || 0 });
      }
      // ---- ㉖ 系统错误日志：服务器自身异常留痕（请求500/后台任务/未捕获），供控制后台定位 ----
      if (req.method === 'GET' && p === '/api/admin/syserr') {
        const lim = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit') || '200') || 200));
        const list = (db.sysErr || []).slice().sort((a, b) => (b.at || 0) - (a.at || 0));
        const wheres = {}; for (const x of (db.sysErr || [])) wheres[x.where] = (wheres[x.where] || 0) + 1;
        return send(res, 200, { ok: true, total: list.length, list: list.slice(0, lim), byWhere: Object.entries(wheres).sort((a, b) => b[1] - a[1]).slice(0, 12) });
      }
      if (req.method === 'DELETE' && p === '/api/admin/syserr') {
        const n = (db.sysErr || []).length; db.sysErr = []; save(); pushOps(u, '清理系统错误日志', '', n + ' 条');
        return send(res, 200, { ok: true, msg: '已清理 ' + n + ' 条系统错误记录' });
      }
      if (req.method === 'POST' && p === '/api/admin/params') {
        const b = await readBody(req);
        const _cg = cfgGuard(b); if (_cg) return send(res, 409, { ok: false, code: 'conflict', cfgRev: _cg.cur, msg: _cg.msg });
        const inp = b.values && typeof b.values === 'object' ? b.values : {};
        const changed = [], bad = [];
        for (const [k, v] of Object.entries(inp)) {
          const d = PARAMS[k]; if (!d) { bad.push(String(k)); continue; }
          const num = Number(v);
          if (!Number.isFinite(num) || num < d.min || num > d.max) { bad.push(d.name + '=' + v + '（应 ' + d.min + '~' + d.max + '）'); continue; }
          db.params = db.params || {};
          if (db.params[k] !== num) { db.params[k] = num; changed.push(d.name + '=' + num + d.unit); }
        }
        if (bad.length) return send(res, 400, { ok: false, msg: '取值不合法：' + bad.join('，') });
        if (!changed.length) return send(res, 200, { ok: true, msg: '无改动', cfgRev: db.cfgRev || 0 });
        const _cr = cfgBump(); save();
        pushOps(u, '参数配置', changed.join(' '), '');
        console.log(`[params] ${u.name} ${changed.join(' / ')}`);
        startRcsTimer(); // 轮询间隔等参数即时生效，无需重启
        return send(res, 200, { ok: true, msg: '已保存并即时生效：' + changed.join('，'), cfgRev: _cr });
      }

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
        pushOps(u,'建账号', username, ROLE_NAMES[b.role]);
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
        const _ch = []; if (typeof b.enabled === 'boolean') _ch.push(b.enabled ? '启用' : '停用并吊销会话'); if (b.role) _ch.push('改角色→' + ROLE_NAMES[b.role]); if (b.name) _ch.push('改名→' + b.name); if (b.password) _ch.push('重置密码(首登需改)');
        pushOps(u, '改账号', t.username, _ch.join('、'));
        save(); return send(res, 200, { ok: true, user: safeUser(t) });
      }
      if (req.method === 'DELETE' && mUser) {
        const t = db.users.find(x => x.id === mUser[1]);
        if (!t) return send(res, 404, { ok: false, msg: '用户不存在' });
        if (t.id === u.id) return send(res, 400, { ok: false, msg: '不能删除自己' });
        db.users = db.users.filter(x => x.id !== t.id);
        pushOps(u,'删账号', t.username, '');
        Object.keys(db.sessions).forEach(tk => { if (db.sessions[tk].userId === t.id) delete db.sessions[tk]; });
        save(); return send(res, 200, { ok: true });
      }

      // ---- 管理员：功能开关 ----
      if (req.method === 'GET' && p === '/api/config') {
        return send(res, 200, { ok: true, features: db.features, roles: ROLES, roleNames: ROLE_NAMES, featureNames: FEATURE_NAMES, autoDispatch: db.autoDispatch !== false });
      }
      if (req.method === 'PATCH' && p === '/api/config') {
        const b = await readBody(req);
        if (b.features && typeof b.features === 'object') {
          for (const role of ROLES) if (b.features[role]) db.features[role] = { ...db.features[role], ...b.features[role] };
          save(); console.log('[config] 功能开关已更新');
          pushOps(u,'改权限开关', '', '角色功能矩阵已更新');
        }
        if (typeof b.autoDispatch === 'boolean') { db.autoDispatch = b.autoDispatch; save(); console.log(`[config] 接单即派=${b.autoDispatch}`); }
        return send(res, 200, { ok: true, features: db.features, autoDispatch: db.autoDispatch !== false });
      }
      // ---- ㉕B1 活动流审计：GET /api/admin/ops?by=&limit= 倒序 ----
      if (req.method === 'GET' && p === '/api/admin/ops') {
        const by = String(url.searchParams.get('by') || '').trim();
        const lim = Math.min(1000, Math.max(1, parseInt(url.searchParams.get('limit') || '200') || 200));
        let list = opsLoadDays(OPS_KEEP_DAYS).sort((a, b) => (b.t || 0) - (a.t || 0)); // ㉖近180天全量（文件为主，内存兜底去重）
        if (by) list = list.filter((x) => String(x.by) === by);
        const persons = [...new Set(list.map((x) => x.by))];
        // ㉖v95b 显示层乱码剥离：历史推送把"托<乱码>"等脏值写进过留痕详情；JSONL 存档与断链摘要不动，仅输出时清洗
        const _dv = (s0) => String(s0 == null ? '' : s0).replace(/[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
        return send(res, 200, { ok: true, total: list.length, persons, list: list.slice(0, lim).map((x) => Object.assign({}, x, { obj: _dv(x.obj), det: _dv(x.det) })) });
      }
      // ---- ㉖断链自校验：重算指定日 ops 文件摘要与 digest 存档比对（手改/删行即不符）----
      if (req.method === 'GET' && p === '/api/admin/ops/integrity') {
        const day = String(url.searchParams.get('day') || '') || opsDay(Date.now() - 864e5);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return send(res, 400, { ok: false, msg: 'day需YYYY-MM-DD' });
        const dp = path.join(opsDir(), 'digest-' + day + '.json');
        if (!fs.existsSync(dp)) return send(res, 404, { ok: false, msg: day + ' 无摘要存档（每日摘要在次日生成，当日可先校验昨日）' });
        const saved = JSON.parse(fs.readFileSync(dp, 'utf8'));
        let txt = ''; try { txt = fs.readFileSync(opsFileOf(day), 'utf8'); } catch (_) {}
        const rows = txt.split('\n').filter((x) => x.trim()).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean).filter((o) => opsDay(o.t) === day);
        let prev = '';
        const pdp = path.join(opsDir(), 'digest-' + opsDay(Date.parse(day + 'T00:00:00') - 864e5) + '.json');
        try { prev = String(JSON.parse(fs.readFileSync(pdp, 'utf8')).sha || ''); } catch (_) {}
        const re = crypto.createHash('sha256').update(prev + rows.map((o) => JSON.stringify(o)).join('\n'), 'utf8').digest('hex');
        const okc = re === saved.sha && rows.length === saved.rows;
        pushOps(u, '断链校验', day, okc ? '通过' : `不符！存档${saved.rows}行 现${rows.length}行`);
        return send(res, 200, { ok: true, day, pass: okc, savedRows: saved.rows, nowRows: rows.length, shaHead: String(saved.sha || '').slice(0, 12), reHead: re.slice(0, 12) });
      }
      // ---- ㉕B4 系统健康分0-100：uptime/内存/备份新鲜/路网/队列/账本同步 ----
      if (req.method === 'GET' && p === '/api/admin/healthscore') {
        const nowMs = Date.now();
        let bkAge = -1; try { const dir = path.join(DATA_DIR, 'backups'); if (fs.existsSync(dir)) { const fs2 = fs.readdirSync(dir).filter((f) => /^db-.*\.json$/.test(f)).map((f) => fs.statSync(path.join(dir, f)).mtimeMs).sort((a, b) => b - a); if (fs2.length) bkAge = Math.round((nowMs - fs2[0]) / 1000); } } catch (_) {}
        const queueWait = (db.agvQueue || []).filter((q) => q.state === '排队').length;
        const ledAge = db.ledgerAt ? Math.round((nowMs - Date.parse(db.ledgerAt)) / 1000) : -1;
        const netReady = NetMap.ready();
        const upMin = Math.round(process.uptime() / 60), mem = Math.round(process.memoryUsage().rss / 1048576);
        let score = 100, items = [];
        const cut = (pt, name, val, pass) => { if (!pass) score -= pt; items.push({ name, val, ok: pass }); };
        cut(10, '服务在线', upMin + '分钟', upMin > 0);
        cut(10, '内存占用', mem + 'MB', mem < 400);
        cut(15, '备份新鲜度', bkAge < 0 ? '无备份' : Math.round(bkAge / 60) + '分钟前', bkAge >= 0 && bkAge < 45 * 60);
        cut(10, '路网就绪', netReady ? '已建' : '未建', netReady);
        cut(15, '队列积压', queueWait + '框待下发', queueWait < 30);
        cut(10, '账本同步', ledAge < 0 ? '从未' : Math.round(ledAge / 60) + '分钟前', ledAge >= 0 && ledAge < 6 * 3600);
        // ㉖G3：db.json 体积 + 落盘写耗时（SQLite 迁移触发线预警：>50MB 或 单次>500ms）
        let dbMB = 0; try { dbMB = Math.round(fs.statSync(DB_FILE).size / 104857.6) / 10; } catch (_) {}
        cut(15, '数据文件体积', dbMB + 'MB（触发线50）', dbMB < 45);
        cut(15, '落盘写耗时', (_saveStat.n ? '近' + _saveStat.ring.length + '次 max' + _saveStat.max + '/avg' + _saveStat.avg + 'ms（触发线500）' : '尚无写入'), _saveStat.max <= 500);
        // ㉖v56 断电纵深防御健康项：主文件完好性/安全副本新鲜度/自动恢复次数
        const mainChk = dbIntact(DB_FILE);
        cut(20, '主数据完好', mainChk.ok ? '校验通过' : ('异常：' + mainChk.reason), mainChk.ok);
        const safeAge = _dbHealth.safeAt ? Math.round((nowMs - _dbHealth.safeAt) / 1000) : -1;
        cut(10, '安全副本', safeAge < 0 ? '无' : Math.round(safeAge / 60) + '分钟前', safeAge >= 0 && safeAge < 45 * 60);
        items.push({ name: '断电自愈次数', val: String(_dbHealth.recoverCount) + (_dbHealth.lastRecover ? '（最近 ' + new Date(_dbHealth.lastRecover).toLocaleString('zh-CN', { hour12: false }).slice(5, 16) + '）' : ''), ok: true });
        return send(res, 200, { ok: true, score, items, uptimeMin: upMin, memMB: mem, bkAgeSec: bkAge, queueWait, ledAgeSec: ledAge, netReady, dbMB, saveMaxMs: _saveStat.max, saveAvgMs: _saveStat.avg, saveCount: _saveStat.n, sessions: Object.keys(db.sessions || {}).length, persist: { mainOk: mainChk.ok, safeAgeSec: safeAge, recoverCount: _dbHealth.recoverCount, lastRecover: _dbHealth.lastRecover } });
      }
      // ---- ㉖G9 灾备恢复演练登记：POST 记结论进 ops（滚动留痕）；GET 最近一次/半年到期判定 ----
      if (req.method === 'POST' && p === '/api/admin/drill') {
        const b = await readBody(req);
        const res1 = String(b.result || '').trim().slice(0, 200);
        if (!res1) return send(res, 400, { ok: false, msg: '请填写演练结论（恢复了哪天的快照/验证了什么/有无问题）' });
        const snap = String(b.snapshot || '').trim().slice(0, 60);
        pushOps(u, '恢复演练', snap || 'db.json', `结论：${res1}`);
        db.lastDrill = { at: Date.now(), by: u.name, note: res1, snapshot: snap };
        save();
        console.log(`[drill] ${u.name} 登记灾备演练：${res1.slice(0, 60)}`);
        return send(res, 200, { ok: true, msg: '演练已登记进活动流（每半年一次，检查单 G9）' });
      }
      if (req.method === 'GET' && p === '/api/admin/drill') {
        const hist = opsLoadDays(366).filter((x) => x.act === '恢复演练').sort((a, b) => b.t - a.t);
        const last = db.lastDrill || (hist.length ? { at: hist[0].t, by: hist[0].by, note: hist[0].det || '', snapshot: hist[0].obj || '' } : null);
        const due = last ? (Date.now() - (Number(last.at) || 0) > 180 * 864e5) : true;
        return send(res, 200, { ok: true, last, due, count: hist.length, history: hist.slice(0, 12) });
      }
      // ---- ㉖⑩ PDA异常日志：GET 批次列表（可按设备/人筛）/ 明细 / 删除 ----
      if (req.method === 'GET' && p === '/api/admin/errlog') {
        const dev = String(url.searchParams.get('dev') || '').trim();
        const lim = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit') || '100') || 100));
        let list = (db.errLogs || []).slice().sort((a, b) => (b.at || 0) - (a.at || 0));
        if (dev) list = list.filter((x) => String(x.dev) === dev);
        return send(res, 200, { ok: true, total: list.length, devices: [...new Set((db.errLogs || []).map((x) => x.dev))], list: list.slice(0, lim) });
      }
      if (req.method === 'GET' && p.startsWith('/api/admin/errlog/')) {
        const rec = (db.errLogs || []).find((x) => x.id === p.slice('/api/admin/errlog/'.length));
        return rec ? send(res, 200, { ok: true, rec }) : send(res, 404, { ok: false, msg: '批次不存在' });
      }
      if (req.method === 'DELETE' && p.startsWith('/api/admin/errlog/')) {
        const id = p.slice('/api/admin/errlog/'.length);
        const before = (db.errLogs || []).length;
        db.errLogs = (db.errLogs || []).filter((x) => x.id !== id);
        if (db.errLogs.length === before) return send(res, 404, { ok: false, msg: '批次不存在' });
        save(); pushOps(u, '清理异常日志', id, '');
        return send(res, 200, { ok: true, msg: '已删除' });
      }

      if (req.method === 'POST' && p === '/api/apk/upload') {
        const version = String(url.searchParams.get('version') || '').trim();
        const build = parseInt(url.searchParams.get('build') || '0', 10);
        if (!/^\d+\.\d+\.\d+$/.test(version) || !(build >= 1)) { req.resume(); return send(res, 400, { ok: false, msg: 'version需x.y.z且build≥1' }); }
        const dir = path.join(DATA_DIR, 'app'); fs.mkdirSync(dir, { recursive: true });
        const tmp = path.join(dir, 'upload.tmp');
        const ws = fs.createWriteStream(tmp); let size = 0, aborted = false;
        req.on('data', (c) => { size += c.length; if (size > 200 * 1048576) { aborted = true; ws.close(); try { fs.unlinkSync(tmp); } catch (_) {} req.destroy(); } });
        req.pipe(ws);
        ws.on('finish', () => {
          if (aborted || size < 1000) { try { fs.unlinkSync(tmp); } catch (_) {} return send(res, 400, { ok: false, msg: aborted ? '超过200MB上限' : '空文件' }); }
          // ㉖v94g 版本化文件名落盘：Windows 下若正有 PDA 下载 app-release.apk（读句柄占用），rename 覆盖同名必 EPERM（10/24 发布台"落盘失败"根因）
          let prevFile = ''; try { prevFile = JSON.parse(fs.readFileSync(path.join(dir, 'version.json'), 'utf8')).file || ''; } catch (_) {}
          const fin = path.join(dir, 'app-release-' + version + '-' + build + '.apk');
          try {
            fs.renameSync(tmp, fin);
            fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ version, build, size, file: path.basename(fin), at: new Date().toISOString() }, null, 2));
          } catch (e) { try { fs.unlinkSync(tmp); } catch (_) {} return send(res, 500, { ok: false, msg: '落盘失败:' + e.message }); }
          if (prevFile && prevFile !== path.basename(fin)) { try { fs.unlinkSync(path.join(dir, prevFile)); } catch (_) {} } // 尽力删上一版，正被下载则静默跳过不影响发布
          pushOps(u, '发布APK', 'v' + version + '+' + build, (size / 1048576).toFixed(1) + 'MB');
          console.log(`[publish] ${u.name} 发布 v${version}+${build} ${(size / 1048576).toFixed(1)}MB`);
          return send(res, 200, { ok: true, msg: `已发布 v${version}+${build}（${(size / 1048576).toFixed(1)}MB）`, version, build, size });
        });
        ws.on('error', (e) => { try { fs.unlinkSync(tmp); } catch (_) {} return send(res, 500, { ok: false, msg: '写入失败:' + e.message }); });
        return;
      }
    }
    return send(res, 404, { ok: false, msg: '接口不存在' });
  } catch (e) {
    try { logErr('REQ ' + (req.method || '') + ' ' + (p || url && url.pathname || '?'), e); } catch (_) {}
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
// ㉖ 指挥舱 RCS 读写通道：token 失效自动重登重试一次；plain=DELETE 裸文本 body（置顶/删除任务与门户同款形态）
async function rcsReq2(path, method = 'GET', plainBody = null) {
  if (!db.rcsConfig || !db.rcsConfig.host) return { ok: false, msg: 'RCS 未配置（控制后台→RCS连接）' };
  const getTk = async () => ((db.rcsToken && Date.now() < (db.rcsTokenExp || 0)) ? db.rcsToken : await rcsLogin());
  const call = async () => { const tk = await getTk(); if (!tk) return null; return rcsReq(path, method, tk) || { code: -1, msg: 'RCS无响应' }; };
  let r = await call();
  if (!r) return { ok: false, msg: 'RCS 登录失败或无响应' };
  const authBad = r.code !== 0 && /未登录|过期|token|Token/.test(String(r.msg || ''));
  if (authBad) { db.rcsToken = ''; db.rcsTokenExp = 0; r = await call(); if (!r) return { ok: false, msg: 'RCS 重登失败' }; }
  if (plainBody !== null && r.code !== 0) { // 裸文本 body 重试（部分环境需 body 回显任务号）
    r = await new Promise((resolve) => {
      try {
        const [host, port] = String((db.rcsConfig || {}).host || '').split(':');
        const tk = (db.rcsToken && Date.now() < (db.rcsTokenExp || 0)) ? db.rcsToken : '';
        const rq = http.request({ host, port: parseInt(port || '80'), path, method, timeout: 8000, headers: Object.assign({ 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(plainBody) }, tk ? { token: tk } : {}) },
          (rs) => { let s = ''; rs.on('data', (c) => s += c); rs.on('end', () => { try { resolve(JSON.parse(s)); } catch (_) { resolve({ code: -1, msg: s.slice(0, 80) }); } }); });
        rq.on('error', () => resolve({ code: -1, msg: 'RCS请求失败' })); rq.on('timeout', () => { rq.destroy(); resolve({ code: -1, msg: 'RCS超时' }); });
        rq.write(plainBody); rq.end();
      } catch (_) { resolve({ code: -1, msg: 'RCS请求异常' }); }
    });
  }
  if (r.code === 0) return { ok: true, data: r.data };
  return { ok: false, msg: String(r.msg || ('RCS返回 code=' + r.code)) };
}
function seenInBackfill() { // ㉖ 首次升级：现存账本+采集流水的标签一次性登记进 seenIn（幂等）
  try {
    if (db.seenInBackfilled) return;
    db.seenIn = db.seenIn || {};
    let n = 0;
    for (const x of db.ledger || []) { const c = String(x.c || '').toUpperCase(); if (c && !db.seenIn[c]) { db.seenIn[c] = { by: x.by || '', t: Number(x.t) || Date.now(), l: x.l, p: x.p || '' }; n++; } }
    for (const st of Object.values(db.scanlog || {})) { const c = String(st.code || '').toUpperCase(); if (c && !db.seenIn[c]) { db.seenIn[c] = { by: st.op || '', t: Number(st.t) || Date.now(), l: (st.wt === 0 ? st.gl : st.st) || '', p: st.pn || '' }; n++; } }
    db.seenInBackfilled = 1; if (n) console.log('[seenIn] 历史标签回填 ' + n + ' 个');
  } catch (_) {}
}
// ㉖④ 检验工单状态机推进：toStation→atStation（站台快照出现本框标签）；returning→done（归位后该框回到原货位=账本命中）；waitReturn→returned（该框经出库通道出账）
function updateInspects(nowMs) {
  try {
    let dirty = false; const stn = db.rcsStations || {}; const led = db.ledger || [];
    const assist = () => db.users.filter((x) => x.enabled && (x.role === 'warehouse' || x.role === 'admin') && canFeature(x, 'insp_assist'));
    // ㉖v53 框是否仍在账本：人工从站台搬走出库会消账，但 RCS 站台快照滞后仍显示"有货"，旧判据只看快照致给已出库的框误弹"到站请归位"
    const inLedger = (code) => led.some((x) => String(x.c || '').toUpperCase() === String(code || '').toUpperCase());
    for (const q of db.inspects || []) {
      // ㉖ 队列驱动转态：检验任务已入队且被调度器真实发车 → 工单转在途（催办随排队暂停）
      const _qi = (st) => (db.agvQueue || []).find((x) => x.inspId === q.id && ['下发中', '已下发', '到站', '完成'].includes(x.state) && (!st || x.type === st));
      if (q.state === 'waitOut' && q.outQueued) { const it = _qi('insp'); if (it) { q.state = 'toStation'; q.taskNo = it.wmsTask || ''; q.station = it.station || q.station; q.at = Date.now(); q.outQueued = 0; dirty = true; } }
      else if (q.state === 'waitBack' && q.backQueued) { const it = _qi('inspback'); if (it) { q.state = 'returning'; q.taskNo2 = it.wmsTask || ''; q.retAt = Date.now(); q.backQueued = 0; dirty = true; } }
      const _iu = P().inspUrgeMin, _ru = P().retUrgeMin; // ㉖ 检验催办间隔可调（原硬编码10/10/30分钟）
      if (q.state === 'waitOut' && !q.outQueued && !q.notified && nowMs - (q.at || 0) > _iu * 60000) { q.notified = true; dirty = true; assist().forEach((x) => notify(x.id, 'inspect', '🤝 检验协助催办：' + q.code + '（' + (q.nm || q.part) + '）等待下架已超' + _iu + '分钟，请协助', '')); }
      else if (q.state === 'waitBack' && !q.backQueued && !q.notified2 && nowMs - (q.verdictAt || q.at || 0) > _iu * 60000) { q.notified2 = true; dirty = true; assist().forEach((x) => notify(x.id, 'inspect', '🤝 检验协助催办：' + q.code + ' 检验已出结论，等待归位超' + _iu + '分钟，请协助归位', '')); }
      else if (q.state === 'waitReturn' && !q.notified3 && nowMs - (q.verdictAt || q.at || 0) > _ru * 60000) { q.notified3 = true; dirty = true; assist().forEach((x) => notify(x.id, 'inspect', '🔁 退货催办：' + q.code + ' 判退货已超' + _ru + '分钟仍压站台 ' + q.station + '，请走出库通道出账', '')); }
      if (q.state === 'waitReturn') { // ㉖⑦ 闭环：标签已不在账本 = 已经出库/直调出账
        const still = led.some((x) => String(x.c || '').toUpperCase() === String(q.code || '').toUpperCase());
        if (!still) { q.state = 'returned'; q.doneAt = nowMs; dirty = true; db.users.filter((x) => x.id === q.uid && x.enabled).forEach((x) => notify(x.id, 'req_flow', '✅ 退货框 ' + q.code + ' 已出库出账，检验单闭环（原因：' + (q.retReason || '') + '）', '')); }
      } else if (q.state === 'toStation') {
        const s = stn[q.station];
        if (s && s.state === '有货' && (s.codes || []).map((c) => String(c).toUpperCase()).includes(String(q.code).toUpperCase())) {
          if (!inLedger(q.code)) { q.state = 'returned'; q.doneAt = nowMs; dirty = true; db.users.filter((x) => x.id === q.uid && x.enabled).forEach((x) => notify(x.id, 'req_flow', '✅ 检验框 ' + q.code + ' 已出库出账，检验单自动闭环（RCS 站台快照滞后，实际货已离库）', '')); } // ㉖v53 防误弹
          else { q.state = 'atStation'; q.arriveAt = nowMs; dirty = true; const _it1 = (db.agvQueue || []).find((x) => x.inspId === q.id && x.type === 'insp'); db.users.filter((x) => (x.id === q.uid || x.role === 'warehouse' || x.role === 'admin') && x.enabled).forEach((x) => notify(x.id, 'req_arrive', '🔎 检验框已到站台 ' + q.station + '（' + q.code + '），请核对并归位' + (_it1 && _it1.trace && _it1.trace.length ? ' ｜ 调度：' + _it1.trace[0] : ''), '')); }
        }
        else { // ㉖v52 超时钟从"AGV 接令"起算：RCS 队列拥堵排了 25 分钟才派车，不该算工单超时（旧版从建单起算致假 stuck）
          const it = _qi('insp');
          const tk = it && it.wmsTask ? (db.agvTasks || {})[String(it.wmsTask)] : null;
          const t0 = (tk && (tk.ex || tk.pick)) || (it && it.state !== '排队' ? (it.sentAt || it.at) : (q.at || 0));
          if (nowMs - t0 > 30 * 60000) { q.state = 'stuck'; q.err = (tk && (tk.ex || tk.pick)) ? 'AGV 接令后超30分钟未到站台，请到RCS核查' : 'AGV 超30分钟未接令（RCS 队列拥堵或车辆异常），请检查车辆'; dirty = true; }
        }
      } else if (q.state === 'returning') {
        // ㉖v52 修归位假完成：检验期间账本不动（设计上标签一直在原货位），旧判据"账本命中=done"
        // 在发车当秒就误判完成（框实际还在途）。正确判据=inspback 队列项已完成（入库对账确认 RCS 放货任务 fin）且账本在原位
        const it = _qi('inspback');
        const landed = it && it.state === '完成';
        const back = led.find((x) => String(x.c || '').toUpperCase() === String(q.code).toUpperCase() && String(x.l || '').toUpperCase() === String(q.from).toUpperCase());
        if (landed && back) { q.state = 'done'; q.doneAt = nowMs; dirty = true; db.users.filter((x) => (x.id === q.uid) && x.enabled).forEach((x) => notify(x.id, 'req_flow', '✅ 检验框 ' + q.code + ' 已归位回 ' + q.from, '')); }
        else if (nowMs - (q.retAt || 0) > 30 * 60000) { q.state = 'stuck'; q.err = '归位超30分钟未回原货位，请核查'; dirty = true; }
      } else if (q.state === 'stuck' && !q.retAt) { // ㉖v52 下架腿假 stuck 自愈：误判后框其实送达了站台 → 自动纠正 atStation
        const s = stn[q.station];
        if (s && s.state === '有货' && (s.codes || []).map((c) => String(c).toUpperCase()).includes(String(q.code).toUpperCase())) {
          if (!inLedger(q.code)) { q.state = 'returned'; q.doneAt = nowMs; q.err = ''; dirty = true; db.users.filter((x) => x.id === q.uid && x.enabled).forEach((x) => notify(x.id, 'req_flow', '✅ 检验框 ' + q.code + ' 已出库出账，检验单自动闭环（RCS 站台快照滞后，实际货已离库）', '')); } // ㉖v53 防误弹
          else { q.state = 'atStation'; q.arriveAt = nowMs; q.err = ''; dirty = true; const _it2 = (db.agvQueue || []).find((x) => x.inspId === q.id && x.type === 'insp'); db.users.filter((x) => (x.id === q.uid || x.role === 'warehouse' || x.role === 'admin') && x.enabled).forEach((x) => notify(x.id, 'req_arrive', '🔎 检验框已到站台 ' + q.station + '（' + q.code + '），请核对并归位' + (_it2 && _it2.trace && _it2.trace.length ? ' ｜ 调度：' + _it2.trace[0] : ''), '')); }
        }
      } else if (q.state === 'stuck' && q.retAt) { // ㉖v52 归位慢超30分被误判 stuck 的框后来真放回了 → 自动纠正 done（队列完成项留存2小时内有效）
        const it = _qi('inspback');
        const back = led.find((x) => String(x.c || '').toUpperCase() === String(q.code).toUpperCase() && String(x.l || '').toUpperCase() === String(q.from).toUpperCase());
        if (it && it.state === '完成' && back) { q.state = 'done'; q.doneAt = nowMs; q.err = ''; dirty = true; db.users.filter((x) => (x.id === q.uid) && x.enabled).forEach((x) => notify(x.id, 'req_flow', '✅ 检验框 ' + q.code + ' 已归位回 ' + q.from, '')); }
      }
      if (q.updAt !== nowMs && q.state !== 'toStation' && q.state !== 'returning') q.updAt = nowMs;
    }
    if (dirty) save();
  } catch (_) {}
}
function parsePts(t) { try { const s = JSON.parse(t.suspensionMsg || '{}'); return { sp: String(s.startPoint || '').toUpperCase(), ep: String(s.endPoint || '').toUpperCase() }; } catch (_) { return { sp: '', ep: '' }; } }
function rcsTs(s) { s = String(s || ''); if (s.length < 14) return 0; return new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}`).getTime(); }
function dstr(ms) { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()}`; } // 报表/驾驶舱共用
// 任务节点时间：取货点(operType=0)完成=离开起始库位，放货点(operType=1)完成=到达目标库位
function nodeTimes(t) { let pickAt = 0, putAt = 0; for (const d of (t.taskDetailList || [])) { if (Number(d.state) === 2) { if (Number(d.operType) === 0) pickAt = rcsTs(d.finishTime) || pickAt; else if (Number(d.operType) === 1) putAt = rcsTs(d.finishTime) || putAt; } } return { pickAt, putAt, startAt: rcsTs(t.exeTime), buildAt: rcsTs(t.buildTime) }; }

// ================= 路网模块（地图/最近距离分配共用）：地标坐标+路径边+货位映射，每日刷新 =================
const NetMap = {
  lands: {}, // landCode → {x,y,name}
  adj: {}, // landCode → [[toLand, w], ...]
  locLand: {}, // 货位编码(NB02-…) → landCode
  landLoc: {}, // landCode → 货位编码（反查）
  ckLoc: {}, // 站台编码 → landCode
  builtAt: 0,
  ready() { return Object.keys(this.lands).length > 100 && Object.keys(this.adj).length > 100; },
  async build(rcsGet) {
    try {
      const [lm, seg, rack] = await Promise.all([
        rcsGet('/LandMark/GetLandMark'), rcsGet('/uds/mapSegment/getSegementVOList'), rcsGet('/rack/GetRackInfo'),
      ]);
      const parse = (d) => { try { return typeof d === 'string' ? JSON.parse(d) : (d || []); } catch (_) { return []; } };
      const lands = {}, locLand = { ...(db.locLandLearned || {}) }, landLoc = {};
      for (const l of parse(lm && lm.data)) {
        const code = String(l.landCode || '');
        if (!code) continue;
        lands[code] = { x: Number(l.landX) || 0, y: Number(l.landY) || 0, name: String(l.landName || code), r: l.regionId === undefined ? -1 : Number(l.regionId), t: l.landType === undefined ? -1 : Number(l.landType) };
      }
      const adj = {};
      for (const s of parse(seg && seg.data)) {
        const a = String(s.beginLandmarkCode || ''), b = String(s.endLandmarkCode || '');
        if (!a || !b || !lands[a] || !lands[b]) continue;
        const w = Math.hypot(lands[a].x - lands[b].x, lands[a].y - lands[b].y);
        if (!(s.enable === 0)) { (adj[a] = adj[a] || []).push([b, w]); if (s.direction !== 1) (adj[b] = adj[b] || []).push([a, w]); } // direction=1单向
      }
      // 货位编码↔landCode：rack表权威映射（718条覆盖NB02货架）+ 学习映射（站台等rack未覆盖处）
      for (const r of parse(rack && rack.data)) {
        const code = String(r.rackLandName || '').toUpperCase(), lc = String(r.landCode || '');
        if (code && lc && lands[lc] && !locLand[code]) locLand[code] = lc;
      }
      for (const [loc, lc] of Object.entries(locLand)) { if (lands[lc]) landLoc[lc] = loc; }
      if (Object.keys(lands).length > 100) { this.lands = lands; this.adj = adj; this.locLand = locLand; this.landLoc = landLoc; this.builtAt = Date.now(); console.log(`[netmap] 路网构建：地标${Object.keys(lands).length} 边${Object.keys(adj).length} 货位映射${Object.keys(locLand).length}`); }
      else console.log(`[netmap] 未达阈值不建网：地标${Object.keys(lands).length} 边${Object.keys(adj).length}（需>100）`);
    } catch (e) { console.log('[netmap] 构建失败：', e.message); }
  },
  // 任务学习：从任务起终点编码↔途经点首末landCode 积累映射（rack表不含站台，靠这个学）
  learn(tasks) {
    if (!db.locLandLearned) db.locLandLearned = {};
    let dirty = false;
    for (const t of tasks || []) {
      const { sp, ep } = parsePts(t);
      let det = t.taskDetailList; if (typeof det === 'string') { try { det = JSON.parse(det); } catch (_) { det = []; } }
      det = det || []; if (!det.length) continue;
      const first = String(det[0].landCode || ''), last = String(det[det.length - 1].landCode || '');
      if (sp && first && !db.locLandLearned[sp]) { db.locLandLearned[sp] = first; this.locLand[sp] = first; this.landLoc[first] = this.landLoc[first] || sp; dirty = true; }
      if (ep && last && !db.locLandLearned[ep]) { db.locLandLearned[ep] = last; this.locLand[ep] = last; this.landLoc[last] = this.landLoc[last] || ep; dirty = true; }
    }
    return dirty;
  },
  landOf(loc) { return this.locLand[String(loc || '').toUpperCase()] || ''; },
  // Dijkstra 最短路径米数（路网不可达/缺映射返回 -1）
  dist(fromLoc, toLoc) {
    const s = this.landOf(fromLoc), e = this.landOf(toLoc);
    if (!s || !e) return -1;
    if (s === e) return 0;
    const D = { [s]: 0 }, pq = [[0, s]], seen = {};
    while (pq.length) {
      pq.sort((a, b) => a[0] - b[0]);
      const [d, u] = pq.shift();
      if (seen[u]) continue; seen[u] = 1;
      if (u === e) return Math.round(d);
      for (const [v, w] of (this.adj[u] || [])) { const nd = d + w; if (D[v] === undefined || nd < D[v]) { D[v] = nd; pq.push([nd, v]); } }
    }
    return -1;
  },
};
function netmapRefresh() {
  if (!db.rcsConfig || !db.rcsConfig.host) return;
  const fresh = Date.now() - NetMap.builtAt < 24 * 3600 * 1000;
  if (fresh && NetMap.ready()) return;
  (async () => { const tk = (db.rcsToken && Date.now() < (db.rcsTokenExp || 0)) ? db.rcsToken : await rcsLogin(); if (tk) await NetMap.build((p) => rcsReq(p, 'GET', tk)); })();
}
setTimeout(netmapRefresh, 4000).unref(); // 启动后4秒即建网，不等10分钟首tick
setInterval(netmapRefresh, 60 * 1000).unref(); // ㉖v80 10分钟→60秒：函数自带"已新鲜即返回"，建网失败(启动时RCS接口抖动)后最迟1分钟自愈，实时地图不再白屏干等
// ㉖v92i WMAS 健康看门狗：mom-logistics 等微服务掉线时叫车/容器主档全线失败却无人知晓（10/24 事故复盘：靠用户截图才发现）。
// 每2分钟轻量探活（登录+容器列表1条）；连败2次→通知全体仓管/管理员+进事件中心；恢复→通报掉线时长
let _wmFail = 0;
async function wmasHealthWatch() {
  try {
    if (!db.wmasConfig || !db.wmasConfig.host) return;
    let ok = false;
    const tk = await wmasToken();
    if (tk) { const r = await wmasHttp('GET', '/api/logistics/container/list?pageNum=1&pageSize=1', tk); ok = wmasOk(r); }
    if (ok) {
      _wmFail = 0;
      if (db.wmasDownAt) { const mins = Math.max(1, Math.round((Date.now() - db.wmasDownAt) / 60000)); db.wmasDownAt = 0; save();
        db.users.filter((x) => (x.role === 'warehouse' || x.role === 'admin') && x.enabled).forEach((x) => notify(x.id, 'car_alarm', '✅ WMAS 调度服务已恢复（掉线约 ' + mins + ' 分钟）', ''));
        pushEvent('恢复', 'WMAS', '调度服务恢复，掉线约 ' + mins + ' 分钟', Date.now()); console.log('[wmas-health] 恢复，掉线 ' + mins + ' 分钟'); }
      return;
    }
    _wmFail++;
    if (_wmFail >= 2 && !db.wmasDownAt) {
      db.wmasDownAt = Date.now(); save();
      const msg = '⚠️ WMAS 调度服务探活失败（mom-logistics 可能掉线）：叫车/容器主档将不可用，AGV 任务无法下发——请联系平台运维检查 WMAS 服务';
      db.users.filter((x) => (x.role === 'warehouse' || x.role === 'admin') && x.enabled).forEach((x) => notify(x.id, 'car_alarm', msg, ''));
      pushEvent('告警', 'WMAS', msg, Date.now()); console.log('[wmas-health] ' + msg);
    }
  } catch (_) {}
}
setInterval(wmasHealthWatch, 2 * 60 * 1000).unref();

let _rcsPolling = 0; // ㉖v79c 防重入锁：定时器/接单即派/排队端点多处触发 rcsPoll，并发轮次各自持有 waiting 列表与 assigned 数组，同一队列项被下发两次（实测 N26J180285 双建任务 0019→CK-12 + 0021→CK-03，两车同框）
async function rcsPoll() {
  if (_rcsPolling) return; // 上一轮还没跑完（await WMAS/RCS 网络往返期间），本轮直接跳过——调度是周期性的，下轮自然覆盖
  _rcsPolling = 1;
  try { await _rcsPollInner(); } finally { _rcsPolling = 0; }
}
async function _rcsPollInner() {
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
  // 路网：从任务学站台↔地标映射 + 拉交管（地图快照/堵点告警共用）
  try { NetMap.learn(runT); } catch (_) {}
  const traffic = await rcsReq('/agv/debug/getLockResourceListForStatus', 'GET', tk);
  if (traffic && traffic.code === 0) db.rcsTraffic = traffic.data;
  // 站台状态：出库到站(未清台)=有货；进行中的入库任务=占用中；其余空闲
  const stations = {};
  const mark = (stn, v) => { if (isCK(stn)) stations[stn] = Object.assign(stations[stn] || { station: stn, state: '空闲' }, v); };
  for (const t of runT) {
    const { sp, ep } = parsePts(t);
    const nt = nodeTimes(t);
    if (isCK(ep)) mark(ep, { state: '占用中', dir: 'out', via: '任务 ' + (t.dispatchNo || '').slice(-6), pickAt: nt.pickAt, startAt: nt.startAt, buildAt: nt.buildAt }); // 出库在途：buildAt=建单，startAt=车接令出发，pickAt>0=已叉出货架
    if (isCK(sp)) {
      if (nt.pickAt > 0) { // 入库已叉离站台：物理已空→立即转空闲，并压制该站台旧的"有货"判定（货被叉回货架途中）
        db.rcsStations = db.rcsStations || {};
        db.rcsCleared = db.rcsCleared || {};
        db.rcsCleared[sp] = Math.max(db.rcsCleared[sp] || 0, nt.pickAt);
        delete db.rcsStations[sp];
      } else mark(sp, { state: '占用中', dir: 'in', via: '任务 ' + (t.dispatchNo || '').slice(-6), pickAt: nt.pickAt, putAt: nt.putAt, startAt: nt.startAt, buildAt: nt.buildAt }); // 入库去程：站台预留
    }
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
  db.rcsManual = db.rcsManual || {}; // 人工占用：站台 → 时间戳，30分钟内不被任务事件覆盖
  db.rcsDone = db.rcsDone || {}; // 已清台任务：站台|任务号 → 时间戳
  const recent = doneT.filter(t => rcsTs(t.finishTime) && nowMs - rcsTs(t.finishTime) < 2 * 3600 * 1000)
    .sort((a, b) => rcsTs(a.finishTime) - rcsTs(b.finishTime)); // 按完成时间升序：后发生的事件后处理，防入库旧/新任务乱序清掉刚到的"有货"
  for (const t of recent) {
    const { sp, ep } = parsePts(t);
    if (t.taskState !== 2) continue;
    const dn = (t.dispatchNo || '').slice(-6), finTs = rcsTs(t.finishTime);
    if (!isCK(sp) && isCK(ep)) {
      if ((db.rcsCleared[ep] || 0) >= finTs || db.rcsDone[ep + '|' + dn] || (db.rcsManual[ep] && nowMs - db.rcsManual[ep] < 30 * 60 * 1000)) continue; // 人工清台/人工占用/已完结任务：跳过
      const old = db.rcsStations[ep];
      const codes = (old && old.via === dn && (old.codes || []).length) ? old.codes // 同一任务沿用首次快照，不被货架位新框干扰
        : (db.ledger || []).filter(x => String(x.l).toUpperCase() === sp).map(x => String(x.c || '').toUpperCase()).filter(Boolean);
      const nt2 = nodeTimes(t);
      db.rcsStations[ep] = { station: ep, state: '有货', dir: 'out', label: sp, codes, goods: (t.palletType || ''), since: t.finishTime || '', ts: finTs, via: dn, pickAt: nt2.pickAt, startAt: nt2.startAt, buildAt: nt2.buildAt };
      // ㉖v79c RCS改派纠正：任务实际送达 ep ≠ 我们请求的站台（WMAS/RCS 会自行换台，实测 CK-03→CK-12、CK-02→CK-11）
      // → 队列项目的地改为实际台并留痕，PDA"到站"提示/催扫/领料详情全部跟着对，物料员不再按请求台跑空
      if (codes.length) { const _qq = (db.agvQueue || []).find((x) => codes.includes(String(x.code || '').toUpperCase()) && ['已下发', '到站'].includes(x.state) && x.station && x.station !== ep); if (_qq) { (_qq.trace = _qq.trace || []).push('RCS实际送达 ' + ep + '（请求 ' + _qq.station + '，已自动纠正）'); _qq.station = ep; _qq.updAt = nowMs; } }
    } else if (isCK(sp) && !isCK(ep)) { // 入库叉回货架 → 仅当入库完成时刻晚于站台现有"有货"到站时刻才清台（防乱序穿越删除）
      const cur = db.rcsStations[sp];
      if (!cur || (cur.ts || 0) <= finTs) delete db.rcsStations[sp];
    }
  }
  for (const [stn, s] of Object.entries(db.rcsStations)) {
    if (s.state !== '有货') continue;
    const codes = (s.codes || []).filter(Boolean);
    const cleared = codes.length ? (codes.some(c => issuedAll.has(c)) || !codes.some(c => ledgerCodes.has(c))) : (nowMs - (s.ts || 0) > 2 * 3600 * 1000);
    if (cleared) {
      db.rcsStations = db.rcsStations || {}; db.rcsHoldStat = db.rcsHoldStat || {};
      const hold = Math.round(((nowMs - (s.ts || nowMs)) / 1000) / 60);
      if (s.ts && hold > 0 && hold < 360) { const h = db.rcsHoldStat[stn] || (db.rcsHoldStat[stn] = { n: 0, sum: 0 }); h.n++; h.sum += hold; }
      delete db.rcsStations[stn]; db.rcsDone[stn + '|' + (s.via || '')] = nowMs; delete stnBook[stn]; // C 清台即释放预约窗
    } else if (nowMs - (s.ts || 0) > 6 * 3600 * 1000) {
      db.rcsHoldStat = db.rcsHoldStat || {}; if (s.ts) { const h = db.rcsHoldStat[stn] || (db.rcsHoldStat[stn] = { n: 0, sum: 0 }); h.n++; h.sum += 360; }
      delete db.rcsStations[stn];
    }
  }
  for (const [k, t0] of Object.entries(db.rcsDone)) { if (nowMs - t0 > 6 * 3600 * 1000) delete db.rcsDone[k]; }
  for (const [k, t0] of Object.entries(db.rcsManual)) { if (nowMs - t0 > 30 * 60 * 1000) delete db.rcsManual[k]; }
  // 占用中记录每轮重建：在途任务的接令/叉出时间戳实时刷新（旧逻辑只写一次会冻结），任务取消则记录自动消失
  for (const [k, v] of Object.entries(db.rcsStations)) { if (v.state === '占用中') delete db.rcsStations[k]; }
  for (const v of Object.values(stations)) { if (!db.rcsStations[v.station]) db.rcsStations[v.station] = v; }
  db.rcsRun = runT.map(t => ({ no: t.dispatchNo, state: t.taskState, car: t.exeAgvId ?? 0, start: t.executeTaskNo ? 1 : 0, wms: String(t.executeTaskNo || ''), ...parsePts(t), ...nodeTimes(t) })); // ㉖v56 沉淀WMAS任务号wms：地图车辆标签按车→WMAS任务→队列项带货(方向/零件/数量)
  db.rcsAt = new Date().toISOString();
  // ===== ⑦ AGV效率报表底仓：已完成任务摘要增量落库（RCS只留最近199条，本地攒30天） =====
  db.agvTasks = db.agvTasks || {};
  for (const t of doneT) {
    const fin = rcsTs(t.finishTime);
    if (!fin || !t.dispatchNo) continue;
    if (db.agvTasks[t.dispatchNo]) continue; // 任务号去重
    const { sp, ep } = parsePts(t);
    const ex = rcsTs(t.exeTime);
    db.agvTasks[t.dispatchNo] = { car: t.exeAgvId ?? 0, ex, fin, pick: nodeTimes(t).pickAt, dur: ex && fin > ex ? Math.round((fin - ex) / 1000) : 0, sp, ep, ck: isCK(ep) && !isCK(sp) ? 'out' : isCK(sp) && !isCK(ep) ? 'in' : 'other' };
  }
  { const cutoff = nowMs - 30 * 86400000; for (const [k, v] of Object.entries(db.agvTasks)) { if ((v.fin || 0) < cutoff) delete db.agvTasks[k]; } }
  // ===== 到站催扫：站台仍"有货"且到站超10分钟 → 通知叫车人（用快照标签，不受货架位补新框干扰） =====
  for (const [stn, s] of Object.entries(db.rcsStations)) {
    if (s.state !== '有货' || !(s.codes || []).length) continue;
    if (nowMs - (s.ts || 0) < P().pushMin * 60 * 1000 || nowMs - (s.ts || 0) > 2 * 3600 * 1000) continue; // 急料起催阈值，普通单下方另判
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
      const rush = !!cl.req.rush;
      if (!rush && nowMs - (s.ts || 0) < P().urgeScanMin * 60 * 1000) continue; // 普通单起催阈值
      const _qi = (db.agvQueue || []).find((x) => String(x.code || '').toUpperCase() === cl.c && x.station === stn);
      const msg = `⏰ ${rush ? '🔥急料' : ''}到站催扫：框 ${cl.c} 已到站台 ${stn} 超${rush ? P().pushMin : P().urgeScanMin}分钟未扫码发料（领料单 ${cl.req.no}），请尽快清台${_qi && _qi.trace && _qi.trace.length ? ' ｜ 调度：' + _qi.trace[0] : ''}`;
      if (rush) db.users.filter((x) => (x.role === 'warehouse' || x.role === 'admin') && x.enabled).forEach((x) => notify(x.id, 'req_arrive', msg, cl.req.id));
      else notify(cl.by || cl.req.by, 'req_arrive', msg, cl.req.id);
      db.rcsRemind = db.rcsRemind || {}; db.rcsRemind[key] = nowMs;
    }
  }
  if (db.rcsRemind) for (const [k, t0] of Object.entries(db.rcsRemind)) { if (nowMs - t0 > 4 * 3600 * 1000) delete db.rcsRemind[k]; }
  // ===== ③ 堵点告警：车被交管卡住超3分钟 → 通知全体在线仓管（含锁点与前车） =====
  try {
    const tl = parse(db.rcsTraffic || '{}');
    const owners = (tl.landmarkLocks && tl.landmarkLocks.landmarkOwners) || {};
    const carName = (id) => 'AGV' + String(id).padStart(2, '0');
    const zl = (tl.zoneLocks && tl.zoneLocks.zoneList) || [];
    const blockedNow = {}; // carId → {zone, lockLand, lockers}
    for (const z of zl) {
      const bc = z.blockedCars || [], lc = z.lockCars || [];
      for (const b of bc) {
        const id = b && b.agvId !== undefined ? b.agvId : b;
        if (id === undefined || id === null) continue;
        blockedNow[id] = { zone: z.remarks || ('交管区' + z.zoneId), lockLand: lc.map((x) => (x && x.agvId !== undefined ? x.agvId : x)).map(carName).join('、'), lands: String(z.junctionLandmarkCodes || '') };
      }
    }
    db.rcsJam = db.rcsJam || {};
    for (const [id, info] of Object.entries(blockedNow)) {
      if (!db.rcsJam[id]) { db.rcsJam[id] = { at: nowMs, notified: false, ...info }; continue; }
      const j = db.rcsJam[id];
      if (!j.notified && nowMs - j.at > P().jamMin * 60 * 1000) {
        j.notified = true; pushEvent('堵点', carName(id), '被卡超' + P().jamMin + '分钟：' + info.zone + ' 占行:' + (info.lockLand || '未知'), nowMs);
        const msg = `🚧 交管堵点：${carName(id)} 在 ${info.zone}${info.lands ? '（点位' + info.lands + '）' : ''} 被卡超${P().jamMin}分钟，占行车辆：${info.lockLand || '未知'}`;
        db.users.filter((x) => (x.role === 'warehouse' || x.role === 'admin') && x.enabled).forEach((x) => notify(x.id, 'req_arrive', msg, ''));
        console.log('[jam] ' + msg);
      }
    }
    for (const id of Object.keys(db.rcsJam)) { if (!blockedNow[id]) { const j0 = db.rcsJam[id]; if (j0 && j0.notified) pushEvent('堵点解除', carName(id), '交管放行，被卡约' + Math.round((nowMs - j0.at) / 60000) + '分钟', nowMs); delete db.rcsJam[id]; } } // 已通行→清记录（先落历史）
  } catch (_) {}
  agvDispatch(nowMs, runT).catch((e) => console.log('[agv-q] 调度异常', e.message)); // 排队调度：空闲站台→按队列下发（内部末尾跑超时兜底）
  lowBatWatch(tk, nowMs).catch(() => {}); // ④D 低电不归巢看门狗
  carAlarmWatch(tk, nowMs).catch(() => {}); // ⑱ 车辆告警边沿检测→通知仓管
  save();
  try { sseTick(nowMs); } catch (_) {} // ㉔SSE广播+轨迹/甘特采样
}
let _rcsTimer = null;
function rcsTick() { rcsPoll().catch((e) => console.log('[rcs] 轮询异常', e.message)); }
function startRcsTimer() { if (_rcsTimer) clearInterval(_rcsTimer); _rcsTimer = setInterval(rcsTick, P().pollSec * 1000); if (_rcsTimer.unref) _rcsTimer.unref(); console.log('[rcs] 轮询间隔=' + P().pollSec + '秒'); }
startRcsTimer();
(function inspLoop() { try { updateInspects(Date.now()); } catch (_) {} setTimeout(inspLoop, 15000); })(); // ㉖④ 检验态独立推进（不依赖RCS配置，15秒一轮）

// ================= AGV 出库排队调度（一键叫车→8站台自动分配→空闲即下发；入库优先） =================
// 站台空闲=无有货/占用、无在途任务指向(含入库)、未被人工占用30分钟、未被队列占用；出库任务随时可排队，站台空了才下发。
// 下发走 WMAS（与人工叫车同通道同参数）；容器编码自动取该托盘类型下未被在途任务占用的第一个。
// 模式 db.agvDispatchMode：'dry'(默认，只演算记 plan 不真发) / 'live'(真下发)。PDA 设置页切换。
const AGV_STNS = Array.from({ length: 12 }, (_, i) => 'NB02-CK-' + String(i + 1).padStart(2, '0')); // ㉖ 启用一二三四号台：出库/检验站台白名单扩为 CK-01~12 全部12台
// ---- ㉖⑫ 站台身份：别名/用途/停用（网页指挥舱「站台看板」可编辑，全端按此显示与调度）----
// ㉖v91 统一搬运阶段（权威源 agvQueue.state + RCS在途节点 + 站台codes 归并）：1排队待派 2AGV已接单 3在架叉取中 4载货在途 5到站待清台 6压站滞留 0完成 -1失败 -2取消
// 与 /api/agv/pipeline 六段同口径；队列出口注入 q.stage 后，网页队列控制台/站台看板/PDA 全部按此统一渲染，消除四套异体状态词
function agvStage(q) {
  const st = q.state;
  if (st === '完成') return 0;
  if (st === '失败') return -1;
  if (st === '取消') return -2;
  const code = String(q.code || '').toUpperCase();
  let stc = 0;
  for (const v of Object.values(db.rcsStations || {})) { if ((v.codes || []).some((c) => String(c).toUpperCase() === code)) { stc = v.state === '有货' ? 5 : 4; break; } }
  if (st === '到站') return stc === 4 ? 4 : 5;
  if (st === '排队') return stc || 1;
  if (stc) return stc;
  // ㉖v94k 修匹配键：旧版拿 q.taskNo(容器号 NB-B1800*1200_2-00001) 去比 RCS调度号(AGV-20261024-XXXX)，
  // 永不相等 → 车都叉完到货了状态还卡"AGV已接单"（10/24 15:40 现场）。改按 WMAS任务号 双键匹配（调度号+透传号）。
  const _tn = String(q.wmsTask || q.taskNo || '');
  const rr = _tn ? (db.rcsRun || []).find((r) => String(r.no) === _tn || String(r.wms || '') === _tn) : null;
  if (rr && (rr.pickAt || 0) > 0) return 4;
  if (st === '下发中' || st === '已下发') return rr ? 3 : 2;
  return 2;
}
function stnMetaOf(stn) { return (db.stnMeta || {})[String(stn || '').toUpperCase()] || {}; }
function stnAlias(stn) { return String(stnMetaOf(stn).alias || '').slice(0, 12); }
function stnOff(stn) { return stnMetaOf(stn).off === true; }
function stnRole(stn) { const r = String(stnMetaOf(stn).role || 'any'); return ['any', 'out', 'in', 'insp'].includes(r) ? r : 'any'; }
function stnDisp(stn) { const a = stnAlias(stn); return a ? a + '(' + String(stn).split('-').pop() + ')' : String(stn); }
function stnUsable(stn, need) { if (stnOff(stn)) return false; const r = stnRole(stn); return !need || r === 'any' || r === need; }
function inspStationFree(stn, nowMs, selfId) { // 检验可用站台：未停用且用途允许检验 + 无有货/占用、无出库/移库队列占用、无检验占用（㉖ selfId=协助本工单时：waitOut 尚未叉货，其预订站台不算被自己占用）
  if (!stnUsable(stn, 'insp')) return false;
  const st = (db.rcsStations || {})[stn];
  if (st && st.state && st.state !== '空闲') return false;
  if ((db.agvQueue || []).some((q) => q.station === stn && ['排队', '下发中', '已下发'].includes(q.state))) return false;
  if ((db.inspects || []).some((q) => q.id !== selfId && q.station === stn && ['waitOut','toStation','atStation','waitBack','returning','waitReturn'].includes(q.state))) return false; // waitReturn=待退货框仍压站台
  return true;
}
// ---- v55 检验历史：填结论即按"框=托"记全兄弟标签的最近结论（复检覆盖旧值）；180天/2万键滚动剪枝 ----
function inspSibs(code) {
  code = String(code || '').toUpperCase(); const out = new Set([code]);
  const anchor = (db.ledger || []).find((x) => String(x.c || '').toUpperCase() === code);
  if (anchor) { const bk = boxKeyOf(anchor); for (const x of db.ledger || []) { if (boxKeyOf(x) === bk) out.add(String(x.c || '').toUpperCase()); } }
  return [...out];
}
function inspMarkSeen(rec, vd, byName) {
  try {
    db.inspSeen = db.inspSeen || {};
    const e = { v: String(vd || ''), at: Date.now(), pn: String(rec.part || '').toUpperCase(), n: String(rec.nm || '').slice(0, 40), by: String(byName || '').slice(0, 20) };
    for (const c of inspSibs(rec.code)) db.inspSeen[c] = e;
    const cut = Date.now() - 180 * 864e5;
    for (const k of Object.keys(db.inspSeen)) { if ((Number(db.inspSeen[k].at) || 0) < cut) delete db.inspSeen[k]; }
    const ks = Object.keys(db.inspSeen);
    if (ks.length > 20000) { ks.sort((x, y) => (db.inspSeen[x].at || 0) - (db.inspSeen[y].at || 0)); for (const k of ks.slice(0, ks.length - 20000)) delete db.inspSeen[k]; }
  } catch (_) {}
}
function inspBoxState(x) { // 检验框可下架性：AGV货架位(非CK站台) + 无进行中检验 + 无在途出库
  const from = String(x.l || '').toUpperCase();
  const code = String(x.c || '').toUpperCase();
  const isShelf = /^NB02-/.test(from) && !/-CK-/.test(from);
  const busyInsp = (db.inspects || []).some((q) => (String(q.from).toUpperCase() === from || String(q.code).toUpperCase() === code) && ['waitOut','toStation','atStation','waitBack','returning','waitReturn'].includes(q.state));
  const busyOut = (db.agvQueue || []).some((q) => q.type !== 'transfer' && String(q.fromLoc).toUpperCase() === from && ['排队', '下发中', '已下发'].includes(q.state));
  return { isShelf, ok: isShelf && !busyInsp && !busyOut, why: busyInsp ? '检验中' : busyOut ? '出库在途' : isShelf ? '' : '非AGV货架位（地面框人工搬运）' };
}
function agvStationFree(stn, nowMs, runT, assigned) {
  if (!stnUsable(stn, 'out')) return false; // ㉖⑫ 停用台/检验·入库专用台不参与出库分配
  const s = (db.rcsStations || {})[stn];
  if (s && (s.state === '有货' || s.state === '占用中')) return false;
  if ((db.rcsManual || {})[stn] && nowMs - db.rcsManual[stn] < P().manualHoldMin * 60000) return false;
  for (const t of runT) { const { sp, ep } = parsePts(t); if (ep === stn) return false; if (sp === stn && !(nodeTimes(t).pickAt > 0)) return false; } // 出库将到=占用；入库已叉离=物理已空可用
  if ((assigned || []).includes(stn)) return false;
  for (const q of db.agvQueue || []) if (q.station === stn && (q.state === '下发中' || q.state === '已下发')) return false;
  return true;
}
function wmasHttp(method, path, token, body) {
  return new Promise((resolve) => {
    try {
      const cfg = db.wmasConfig || {};
      const [host, port] = String(cfg.host || '').split(':');
      if (!host) return resolve(null);
      const data = body ? JSON.stringify(body) : null;
      const r = http.request({ host, port: parseInt(port || '80'), path, method, timeout: 8000,
        headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}, data ? { 'Content-Length': Buffer.byteLength(data) } : {}) },
        (res) => { let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => { try { resolve(JSON.parse(s)); } catch (_) { resolve(null); } }); });
      r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); });
      if (data) r.write(data); r.end();
    } catch (_) { resolve(null); }
  });
}
let _wmasTk = '', _wmasTkAt = 0, _wmasLoc = null, _wmasLocAt = 0;
// WMAS 各接口成功标志不统一（登录返回 code:200，业务返回 success:true），统一判定
const wmasOk = (r) => !!r && (r.success === true || r.code === 200 || r.code === 0);
function wmasMarkOk() { try { db.wmasOkAt = Date.now(); } catch (_) {} }
async function wmasToken() {
  if (_wmasTk && Date.now() - _wmasTkAt < 10 * 3600 * 1000) return _wmasTk;
  const cfg = db.wmasConfig || {}; if (!cfg.account || !cfg.pwd) return '';
  const r = await wmasHttp('POST', '/api/auth/login', null, { username: cfg.account, password: cfg.pwd });
  if (wmasOk(r) && r.data && r.data.token) { _wmasTk = r.data.token; _wmasTkAt = Date.now(); wmasMarkOk(); return _wmasTk; }
  console.log('[agv-q] WMAS登录失败：' + JSON.stringify(r).slice(0, 150));
  return '';
}
async function wmasLocOf(code) {
  if (!_wmasLoc || Date.now() - _wmasLocAt > 3600 * 1000) {
    const tk = await wmasToken(); if (!tk) return null;
    const r = await wmasHttp('GET', '/api/basicdata/wmsLocation/listAll', tk);
    if (wmasOk(r) && Array.isArray(r.data)) {
      _wmasLoc = {}; for (const e of r.data) { const c = String(e.locationCode || '').toUpperCase(); if (c) _wmasLoc[c] = { wh: e.warehouseCode || '', zone: e.zoneCode || '' }; }
      _wmasLocAt = Date.now();
    }
  }
  return (_wmasLoc || {})[String(code).toUpperCase()] || null;
}
async function wmasDispatchOne(q, tk, ov) { const from = (ov && ov.from) || q.fromLoc; const to = (ov && ov.to) || q.station; let pallet = (ov && ov.pallet) || q.palletType; if (!String(pallet || '').trim() && q.code) pallet = palletTypeOf(q.code); // ㉖v52 账本空类型兜底：从采集流水取容器类型
  const ref = (ov && ov.ref !== undefined) ? ov.ref : (q.reqNo || "");
  // 容器自动选号：优先挑"近30分钟无在途任务"的号；挑不到就复用（与人工叫车同款行为——WMAS不强校验容器号唯一，复用不影响叉货）
  const cr = await wmasHttp('GET', '/api/logistics/container/list?pageNum=1&pageSize=1000', tk);
  if (!wmasOk(cr)) return { ok: false, msg: '查容器主档失败：' + JSON.stringify(cr).slice(0, 80) };
  const t = String(pallet || '').toUpperCase();
  const forced = (ov && ov.container) ? String(ov.container).trim().toUpperCase() : ''; // ㉖⑰ 调用方已指定容器则跳过类型候选校验
  const cands = ((cr.data && cr.data.records) || []).map((x) => String(x.containerCode || '')).filter((c) => t && c.toUpperCase().includes(t)).sort();
  if (!cands.length && !forced) return { ok: false, msg: `容器主档无「${pallet || '未记录类型'}」类型编码（标签 ${q.code || '?'}），请到货位账本补记容器类型后重试，或人工叫车` };
  const nowMs = Date.now();
  const used = new Set();
  // ㉖v94i 三状态查询并行（旧版串行：WMAS 恢复期每个查询 3~8 秒，串行累加 15~24 秒 → PDA 10 秒超时假失败，任务实际已下发）
  {
    const lrs = await Promise.all(['PUSHED', 'DISPATCHED', 'IN_TRANSIT'].map((st) => wmasHttp('GET', `/api/logistics/agv-task/list?pageNum=1&pageSize=100&status=${st}`, tk).catch(() => null)));
    for (const lr of lrs) {
      if (!wmasOk(lr)) continue;
      for (const x of ((lr.data && lr.data.records) || [])) {
        if (!x.containerNo) continue;
        const ts = Date.parse(String(x.creationDate || '').replace(' ', 'T'));
        if (Number.isFinite(ts) && nowMs - ts > 30 * 60 * 1000) continue; // 30分钟前的PUSHED多为未关闭历史单，不算占用
        used.add(String(x.containerNo));
      }
    }
  }
  const cn = (ov && ov.container) || cands.find((c) => !used.has(c)) || cands[0]; // ㉖⑰ 调用方指定容器优先（PDA 手动提交已人选）
  const s = await wmasLocOf(from), e = await wmasLocOf(to);
  if (!s || !e) return { ok: false, msg: '库位不在WMAS主档：' + from + '/' + to };
  let wmsTask = '';
  // ㉖v94j 建单后必须"认单 + 验推送"（10/24 19:12 AGV-0066、19:49 AGV-0069 永久停在"创建"根因）：
  // WMAS 主档同类型容器号唯一（1800*1200_2 全厂仅 NB-B1800*1200_2-00001 一个号），一键叫车同秒连建多单时
  // 建单响应回传的 id/任务号会串到别的单 → 旧版拿错 id 推送、且不校验推送结果，照样报"下发成功"，车永远不来。
  // 现在：①先认领同坐标+同单号遗留的"创建"任务（重叫不重复建单）②没有才新建，建完按坐标反查真实任务（不信建单响应）
  // ③推送后回查状态确认真的离开"创建"④仍失败→撤回本单（已验证归属，不会误撤他单）并如实报失败。
  let own = await wmasOwnTask(tk, cn, from, to, ref);
  if (!own) {
    const mk = await wmasHttp('POST', '/api/logistics/agv-task', tk, { taskType: 'CARRY', warehouse: s.wh, startArea: s.zone, startPoint: from, endArea: e.zone, endPoint: to, containerNo: cn, refNo: ref });
    if (!wmasOk(mk)) return { ok: false, msg: '建任务失败：' + ((mk && (mk.message || mk.msg)) || '无响应') };
    wmsTask = (mk.data && mk.data.taskNo) || '';
    own = await wmasOwnTask(tk, cn, from, to, ref);
  }
  if (!own) return { ok: false, msg: 'WMAS建任务后反查不到本单记录（接口抖动/串单），请重新叫车' }; // 不盲撤：反查失败时建单响应号可能是串到的他单，误撤代价更大；遗留"创建"单由重叫认领/卡单自愈兜底
  wmsTask = String(own.taskNo || wmsTask || '');
  let pushed = String(own.status || '').toUpperCase() !== 'CREATED';
  for (let i = 0; i < 3 && !pushed; i++) {
    if (i) await new Promise((rr) => setTimeout(rr, 900));
    await wmasHttp('POST', '/api/logistics/agv-task/dispatch', tk, { ids: [own.id] });
    const chk = await wmasHttp('GET', `/api/logistics/agv-task/list?pageNum=1&pageSize=5&taskNo=${encodeURIComponent(wmsTask)}`, tk);
    const rec = ((chk && chk.data && chk.data.records) || []).find((z) => String(z.taskNo) === String(wmsTask));
    pushed = !!rec && String(rec.status || '').toUpperCase() !== 'CREATED';
  }
  if (!pushed) { const _cx = await wmasHttp('POST', '/api/logistics/agv-task/cancelTask', tk, [wmsTask]); return { ok: false, msg: wmasOk(_cx) ? 'WMAS建任务成功但推送失败（已自动撤回，多为WMAS瞬时抖动），请重新叫车' : 'WMAS建任务成功但推送失败，且撤回也失败——请先在WMAS取消任务' + wmsTask + '再重新叫车（防双车撞）' }; }
  return { ok: true, container: cn, taskNo: wmsTask, msg: '已建任务并下发' };
}
// ㉖v94j 按坐标+单号反查"本单"任务（同批多单共用唯一容器号时，只有坐标能区分归属）
async function wmasOwnTask(tk, cn, from, to, ref) {
  const lr = await wmasHttp('GET', `/api/logistics/agv-task/list?pageNum=1&pageSize=20&containerNo=${encodeURIComponent(cn)}`, tk);
  const recs = ((lr && lr.data && lr.data.records) || []).filter((z) => {
    if (String(z.startPoint || '').toUpperCase() !== String(from || '').toUpperCase()) return false;
    if (String(z.endPoint || '').toUpperCase() !== String(to || '').toUpperCase()) return false;
    if (ref && String(z.refNo || '') !== String(ref)) return false;
    const ts = Date.parse(String(z.creationDate || '').replace(' ', 'T'));
    if (Number.isFinite(ts) && Date.now() - ts > 5 * 60 * 1000) return false; // 只认5分钟内新建的，历史同坐标单不算
    return !/CANCEL|REJECT|FINISH|COMPLET|DONE/i.test(String(z.status || ''));
  });
  return recs.length ? recs[0] : null;
}
// ㉖v94j 卡单自愈：WMAS 里停"创建"超60秒、且能对上我方在途队列项的任务 → 自动补推（覆盖历史遗留与推送竞态）
let _stuckPushAt = 0;
async function wmasStuckPush(nowMs) {
  if (nowMs - _stuckPushAt < 60000) return; _stuckPushAt = nowMs;
  const tk = await wmasToken(); if (!tk) return;
  const lr = await wmasHttp('GET', '/api/logistics/agv-task/list?pageNum=1&pageSize=50&status=CREATED', tk);
  if (!wmasOk(lr)) return;
  for (const z of ((lr.data && lr.data.records) || [])) {
    const ts = Date.parse(String(z.creationDate || '').replace(' ', 'T'));
    if (Number.isFinite(ts) && nowMs - ts < 60000) continue; // 刚建的等它自己走完推送链
    const q = (db.agvQueue || []).find((x) => ['下发中', '已下发'].includes(x.state) && String(x.fromLoc || '').toUpperCase() === String(z.startPoint || '').toUpperCase() && String(x.station || x.stationManual || '').toUpperCase() === String(z.endPoint || '').toUpperCase() && (String(x.reqNo || '') === String(z.refNo || '') || String(x.ref || '') === String(z.refNo || '')));
    if (!q) continue; // 不是我方发起的任务：绝不代推（WMAS 侧人工建的单不干涉）
    // ㉖v94j 僵尸单防线：队列项若已有自己的活跃任务（重叫后遗留的旧"创建"单），绝不双推——两车同坐标必撞
    if (q.wmsTask && q.wmsTask !== z.taskNo) {
      const qr = await wmasHttp('GET', '/api/logistics/agv-task/list?pageNum=1&pageSize=3&taskNo=' + encodeURIComponent(q.wmsTask), tk);
      const cur = ((qr && qr.data && qr.data.records) || []).find((y) => String(y.taskNo) === String(q.wmsTask));
      const alive = !!cur && !/CANCEL|REJECT|FINISH|COMPLET|DONE/i.test(String(cur.status || ''));
      const same = alive && String(cur.startPoint || '').toUpperCase() === String(q.fromLoc || '').toUpperCase() && String(cur.endPoint || '').toUpperCase() === String(q.station || q.stationManual || '').toUpperCase();
      if (same) continue; // 该 CREATED 是重叫遗留僵尸：不推，等人工在WMAS取消
    }
    if (await wmasHttp('POST', '/api/logistics/agv-task/dispatch', tk, { ids: [z.id] }).then((r) => wmasOk(r))) {
      q.wmsTask = String(z.taskNo || q.wmsTask || ''); // ㉖v94j 串单遗留：队列里记的可能是别的单的任务号，坐标+单号双验证过归属，一并纠正
      q.updAt = nowMs; (q.trace = q.trace || []).push('补推：任务停在"创建"超1分钟，系统已自动推送 ' + (z.taskNo || ''));
      pushEvent('AGV卡单补推', q.code || '', (q.fromLoc || '') + '→' + (q.station || '') + ' ' + (z.taskNo || ''), nowMs);
      console.log('[stuck-push] ' + q.code + ' ' + z.taskNo + ' 停在创建，已补推');
    }
  }
}
function clearQueueCall(reqId, code) { // 队列项取消/失败出队 → 解除该框排队叫车标记，允许重新叫车
  const rq = db.requisitions.find((x) => x.id === reqId); if (!rq) return;
  for (const it of rq.items || []) {
    if (it.agvCalled && it.agvCalled.some((e) => e.q && String(e.c).toUpperCase() === code)) {
      it.agvCalled = it.agvCalled.filter((e) => !(e.q && String(e.c).toUpperCase() === code));
    }
  }
}
// ㉖v72 队列项终态统一回收：叫车标记 + 站台时间窗预约一并释放（取消/失败/判消失共用，杜绝"车不来了台还锁着"）
function retireQueueItem(q, st, err) {
  q.state = st; q.err = err || ''; q.updAt = Date.now();
  (q.trace = q.trace || []).push((st === '取消' ? '已取消' : '判失败') + (err ? '：' + err : ''));
  if (q.trace.length > 8) q.trace = q.trace.slice(-8);
  clearQueueCall(q.reqId, q.code); releaseStnBook(q.code);
}
// ㉖v72 WMAS 任务号兜底反查：wmsTask 缺失时按容器号查最近一条任务（建单响应没回 taskNo 的历史项/竞态项）
// 返回：任务号=命中 / ''=确认查无（可判消失） / null=查询失败（网络抖动，本轮跳过下轮再核，绝不误杀）
async function wmasTaskNoOf(q, tk) {
  if (q.wmsTask) return String(q.wmsTask);
  const cn = String(q.taskNo || '').trim(); if (!cn) return '';
  try {
    const lr = await wmasHttp('GET', '/api/logistics/agv-task/list?pageNum=1&pageSize=5&containerNo=' + encodeURIComponent(cn), tk);
    if (!lr) return null; // 接口无响应：不可判定
    const recs = (lr.data && lr.data.records) || []; if (!recs.length) return '';
    const live = recs.find((z) => ['PUSHED', 'DISPATCHED', 'IN_TRANSIT'].includes(String(z.status || '').toUpperCase()));
    return String((live || recs[0]).taskNo || '');
  } catch (_) { return null; }
}
// ㉖v72 出库"已下发"负向对账：WMAS 任务被取消/驳回/删除查无 → 判失败释放资源，调度器 1 轮内自愈对齐。
// RCS 旁路删除、WMAS 侧人工清理、车故障 reset 等一切下游变动不再等 40 分钟 watchdog。
// 防误杀三重闸：接口无响应不可判定跳过；站台已有该框货走正向回收；RCS 运行表仍有该起点在途任务不动。
async function outboundReconcile(nowMs) {
  const _out = (db.agvQueue || []).filter((q) => (!q.type || q.type === 'outbound' || q.type === 'insp') && q.state === '已下发' && q.sentAt && nowMs - q.sentAt > 120000); // 2分钟建单竞态宽限；㉖v72b 含检验下架（终点站台走正向回收，被删同样需负向兜底）
  if (!_out.length) return;
  const tk = await wmasToken(); if (!tk) return; // WMAS 不可达：本轮跳过，不误杀在途任务
  for (const q of _out) {
    try {
      const tn = await wmasTaskNoOf(q, tk);
      if (tn === null) continue; // 查询无响应（接口抖动）：不可判定，下轮再核
      let gone = false, st = '';
      if (!tn) gone = true; // 任务号与容器号双缺：WMAS 从未有此任务记录
      else {
        if (!q.wmsTask) q.wmsTask = tn; // 回填，下轮直查
        const lr = await wmasHttp('GET', '/api/logistics/agv-task/list?pageNum=1&pageSize=5&taskNo=' + encodeURIComponent(tn), tk);
        if (!lr) continue; // 无响应：不可判定
        const rec = ((lr.data && lr.data.records) || []).find((z) => String(z.taskNo) === String(tn));
        if (!rec) gone = true; // 接口正常但查无此任务：已被删除
        else { st = String(rec.status || '').toUpperCase(); if (st.includes('CANCEL') || st.includes('REJECT')) gone = true; }
      }
      if (!gone) continue;
      const s = (db.rcsStations || {})[q.station];
      const has = s && Array.isArray(s.codes) && s.codes.map((c) => String(c).toUpperCase()).includes(String(q.code).toUpperCase());
      if (has) continue; // 货已到台：交给正向"到站"回收
      const rcsLive = (db.rcsRun || []).some((t) => String(t.sp || '').toUpperCase() === String(q.fromLoc || '').toUpperCase());
      if (rcsLive) continue; // RCS 仍有该起点在途调度任务：WMAS 记录异常但车在动，交超时兜底与正向回收
      retireQueueItem(q, '失败', tn ? 'AGV任务已不在系统（' + (st || 'WMAS查无记录') + '，可能已在RCS/WMAS删除），货位未变动，可重新叫车' : 'AGV任务在WMAS查无记录（从未建成或被删除），请核查货位后重新叫车');
      inspQueueRollback(q, null); // ㉖v72b 检验下架任务判死→工单回退待协助
      pushEvent(q.type === 'insp' ? '检验任务消失' : '出库任务消失', q.code || '', (q.fromLoc || '') + '→' + (q.station || '?') + ' ' + (st || '查无'), nowMs);
      console.log('[out-rec] ' + q.code + ' 任务消失(' + (st || 'no-rec') + ')，判失败并释放资源');
    } catch (_) {}
  }
}
// ---- ㉖ 单项下发（调度器与 carry 共用同一份逻辑，杜绝两套代码漂移）----
// 返回 true=本轮已处理（下发/演算/失败），false=暂无空闲目的地需继续排队
// ㉖ 检验下架/归位入队：与 carry 同款——先局部试发（manualOnly 指定台不可用则排队等待绝不改派），结果入全局队列统一治理
async function inspEnqueue(rec, leg, u, from, to, ref) {
  db.agvQueue = db.agvQueue || [];
  const item = { id: newId('cq'), code: rec.code, fromLoc: from, stationManual: to, station: '', palletType: String(rec.palletType || '').trim() || palletTypeOf(rec.code), type: leg === 'out' ? 'insp' : 'inspback', inspId: rec.id, ref, manualOnly: true, by: u.name, state: '排队', at: Date.now(), updAt: Date.now() };
  const taken = db.agvQueue.filter((q) => q !== item && ['排队', '下发中', '已下发'].includes(q.state) && (q.station || q.stationManual)).map((q) => q.station || q.stationManual);
  await dispatchOne(item, Date.now(), [], taken, (db.agvDispatchMode || 'dry') === 'live');
  db.agvQueue.push(item);
  return item;
}
// ㉖ 检验队列项被取消/任务判死 → 工单回退待协助态（清排队标记，催办恢复计时）
// ㉖v72b 放宽：toStation/returning 也回退并清任务号——调用时机均为"任务确认已死（取消/查无）货未叉动"，回退后可重新协助
function inspQueueRollback(q, u) {
  if (!q.inspId) return;
  const rec = (db.inspects || []).find((x) => x.id === q.inspId);
  if (!rec) return;
  if (q.type === 'insp' && ['waitOut', 'toStation'].includes(rec.state)) { if (rec.state === 'toStation') rec.taskNo = ''; rec.state = 'waitOut'; rec.outQueued = 0; rec.notified = false; }
  else if (q.type === 'inspback' && ['waitBack', 'returning'].includes(rec.state)) { if (rec.state === 'returning') rec.taskNo2 = ''; rec.state = 'waitBack'; rec.backQueued = 0; rec.notified2 = false; }
  if (u) pushOps(u, '检验队列取消', rec.code, rec.from + '→' + (rec.station || '') + '（工单回退 ' + rec.state + '）');
}
async function dispatchOne(q, nowMs, runT, assigned, live) {
  // ㉖v79c 二次防重（与 rcsPoll 防重入锁互补）：已进入下发/在途/到站/完成态的项绝不重复建任务
  if (['下发中', '已下发', '到站', '完成'].includes(q.state)) return true;
  q.trace = q.trace || [];
  if (q.trace.length > 5) q.trace = q.trace.slice(-5); // ㉖v56 预裁剪：早退路径（等待/演算）也保证 trace 不膨胀
  let stn = '';
  // ㉖ 检验下架项指定台判据换检验口径（出库判据排除检验·入库专用台，会把指定到 insp 台的任务永远卡排队）
  const mfree = q.type === 'insp' ? inspStationFree(q.stationManual, nowMs, q.inspId) : agvStationFree(q.stationManual, nowMs, runT, assigned);
  if (q.stationManual && mfree) { stn = q.stationManual; q.trace.push('指定台 ' + stn + ' 可用，按指定执行'); }
  if (!stn && q.manualOnly) { q.trace.push('起终点固定任务：指定台 ' + (q.stationManual || '?') + ' 当前不可用，排队等待（不自动改派）'); return false; }
  const _capB = P().aisleCap; const _abB = _capB > 0 ? aisleBusy() : null; // B 巷道并发节流：源巷道在途达上限→本轮不放行（指定台任务豁免，人工意图优先）
  if (_abB && !q.stationManual && /^NB02-/.test(String(q.fromLoc || '')) && (_abB[String(q.fromLoc).slice(0, 9)] || 0) >= _capB) { q.trace.push('通道节流：源巷道 ' + String(q.fromLoc).slice(0, 9) + ' 在途 ' + _abB[String(q.fromLoc).slice(0, 9)] + ' ≥上限' + _capB + '，本轮不放行'); return false; }
  if (!stn) {
    const skip = [];
    const free = AGV_STNS.filter((x) => { const ok = agvStationFree(x, nowMs, runT, assigned); if (ok && !q.stationManual) { const w = stnHoldUntil(x, nowMs); if (w > nowMs) { if (skip.length < 4) skip.push(x + '(时间窗预约中)'); return false; } } if (!ok && skip.length < 4) skip.push(x + '(' + stnWhy(x, nowMs, runT, assigned) + ')'); return ok; });
    if (free.length) {
      let best = '', bestD = Infinity;
      if (NetMap.ready()) for (const x of free) { const dd = NetMap.dist(q.fromLoc, x); if (dd >= 0 && dd < bestD) { bestD = dd; best = x; } }
      stn = best || free[0];
      q.trace.push('选台 ' + stn + (bestD < Infinity ? '（' + free.length + '空闲台中路网最近 ' + Math.round(bestD) + 'm）' : '（空闲台首个）'));
      if (skip.length) q.trace.push('已排除 ' + skip.join('、'));
    } else { q.trace.push('暂无可用台：' + (skip.join('、') || '全部站台占用/停用') + '，等待下轮'); }
  }
  if (!stn) return false;
  assigned.push(stn); q.station = stn; q.updAt = nowMs;
  // ㉖v94l 位货绑定硬闸（用户要求：入库必须把该站台的货放到指定货架位，出库必须把指定货架位的货放到指定站台）：
  // 建 WMAS 任务前用服务器账本核"框↔起终点"绑定，杜绝叉错框/叉空位/放错位——
  //  出库（起点=货架）：账本必须有此框且框就在起点货位（不在=拿错框或已挪未登记，AGV 去就是叉空）；
  //  入库（起点=站台、终点=货架）：账本框位置只允许 =起点站台（搬运前登记）或 =终点货位（先登后搬），第三位置=矛盾拒绝；
  //  无框码的纯容器搬运、检验 legs、移库、退货框已在站台的"出库"（起点含CK）不走本闸。
  // 实测账本时序：出库叫车时 l=原货位（1894/1894 同位）；入库叫车时 l=目标位或=站台，两态均放行。
  if (q.code && (!q.type || q.type === 'outbound' || q.type === 'inbound')) {
    const _from = String(q.fromLoc || '').toUpperCase(), _to = String(stn).toUpperCase();
    const _led = (db.ledger || []).filter((x) => String(x.c || '').toUpperCase() === String(q.code).toUpperCase()).sort((a, b) => (b.rec || b.t || 0) - (a.rec || a.t || 0))[0]; // 同框多行取最新登记
    const _l = _led ? String(_led.l || '').toUpperCase() : '';
    let _bad = '';
    if (!/-CK-/.test(_from)) { // 出库：货架→站台
      if (!_led) _bad = '框 ' + q.code + ' 货位账本查无此框（位置不详，AGV 到 ' + _from + ' 会叉空）——请先在位置登记补账再叫车';
      else if (_l !== _from) _bad = '账本显示框 ' + q.code + ' 在 ' + (_l || '未知') + '，与叫车起点 ' + _from + ' 不符（可能拿错框或货已挪动未登记），拒绝下发';
    } else if (q.type === 'inbound' && _l && _l !== _from && _l !== _to) { // 入库：账本位置与任务两端都对不上
      _bad = '账本显示框 ' + q.code + ' 已在 ' + _l + '，与本入库任务（' + _from + '→' + _to + '）矛盾，拒绝下发——请核对框是否在别处/账本是否需要更正';
    }
    if (_bad) {
      q.state = '失败'; q.err = _bad; q.updAt = nowMs;
      q.trace.push('位货绑定闸拦截：' + _bad.slice(0, 70));
      console.log('[agv-bind] 拦截 框 ' + q.code + ' ' + _from + '→' + _to + '：' + _bad);
      return true;
    }
  }
  // ㉖v79c 入库重复货位终极防线（所有叫车入口统一过闸）：目的地货架位账本已有别的框→拒绝下发判失败
  // （carry 端点同款检查只护手动提交；AUTO分配/排队端点/旧版PDA 路径全靠这里兜底，杜绝两框同位撞车）
  if (q.type === 'inbound' && /^NB02-/.test(stn) && !/-CK-/.test(stn) && q.code) {
    const _rows = (db.ledger || []).filter((x) => String(x.l || '').toUpperCase() === stn);
    if (_rows.length && !_rows.some((x) => String(x.c || '').toUpperCase() === String(q.code).toUpperCase())) {
      q.state = '失败'; q.err = '货架位 ' + stn + ' 已被框 ' + _rows.map((x) => x.c).join('/') + ' 占用，请重选空格位再叫车';
      q.trace.push('重复货位防线：' + stn + ' 已占(' + _rows[0].c + ')，拒绝下发');
      console.log(`[agv-q] 拦截 框 ${q.code} → ${stn}：货位已被 ${_rows[0].c} 占用`);
      return true;
    }
  }
  if (!live) { q.plan = stn; q.trace.push('演算模式：计划 ' + stn + '，切真实下发后执行'); console.log(`[agv-q·演算] 框 ${q.code} ${q.fromLoc} → ${stn}（切live后自动下发）`); return true; }
  q.state = '下发中'; q.sentAt = Date.now();
  const tk = await wmasToken();
  if (!tk) { q.state = '失败'; q.err = 'WMAS未配置/登录失败（PDA设置→AGV调度系统同步WMAS账号）'; q.trace.push('下发失败：WMAS未登录'); return true; }
  let r;
  const _ov = {}; if (q.container) _ov.container = q.container; if (q.ref !== undefined) _ov.ref = q.ref;
  try { r = await wmasDispatchOne(q, tk, Object.keys(_ov).length ? _ov : undefined); } catch (e) { r = { ok: false, msg: '下发异常：' + e.message }; }
  if (r && r.ok) { stnBook[stn] = { until: nowMs + stnEtaMs(q.fromLoc, stn), by: q.code }; q.trace.push('预约站台窗至 ' + new Date(stnBook[stn].until).toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5) + '（行程+缓冲+平均清台×' + P().stnWinPct + '%）'); } // ㉖v56 C 时间窗预约（含指定台：检验归位同腿撞台是实测痛点，一并预约）
  q.state = r.ok ? '已下发' : '失败'; q.taskNo = r.container || ''; q.wmsTask = r.taskNo || ''; q.err = r.ok ? '' : r.msg;
  q.trace.push(r.ok ? 'WMAS建任务' + (r.taskNo || '') + '下发成功' : 'WMAS下发失败：' + String(r.msg || '').slice(0, 60)); // ㉖v94j 修字段名笔误：旧版 r.wmsTask 恒 undefined，trace 里任务号丢失
  if (q.trace.length > 8) q.trace = q.trace.slice(-8);
  console.log(`[agv-q] ${q.state} 框 ${q.code} ${q.fromLoc} → ${stn}${r.ok ? ' 容器' + r.container : ' ' + r.msg}`);
  return true;
}
// ㉖v56 站台不可用原因（trace 用，判据与 agvStationFree 逐条对应）
function stnWhy(stn, nowMs, runT, assigned) {
  if (!stnUsable(stn, 'out')) return '停用/用途不符';
  const s = (db.rcsStations || {})[stn];
  if (s && (s.state === '有货' || s.state === '占用中')) return '台上有货或占用中';
  if ((db.rcsManual || {})[stn] && nowMs - db.rcsManual[stn] < P().manualHoldMin * 60000) return '人工占用锁';
  for (const t of runT) { const pp = parsePts(t); if (pp.ep === stn) return '在途任务将到'; if (pp.sp === stn && !(nodeTimes(t).pickAt > 0)) return '在途任务回取'; }
  if ((assigned || []).includes(stn)) return '本轮已分配';
  for (const q of db.agvQueue || []) if (q.station === stn && (q.state === '下发中' || q.state === '已下发')) return '队列在途占用';
  return '占用';
}
async function agvDispatch(nowMs, runT) {
  const queue = db.agvQueue || [];
  // 回收：队列项对应任务已到站/已完成 → 状态跟随（到站后由"有货/催扫/清台"机制接管）
  for (const q of queue) {
    const s = (db.rcsStations || {})[q.station];
    const has = s && Array.isArray(s.codes) && s.codes.map((c) => String(c).toUpperCase()).includes(q.code);
    if (q.state === '下发中') {
      // 下发中超过5分钟无回执（进程中断/异常残留）→ 判失败可重试，防止永久封死该站台
      if (nowMs - (q.updAt || q.at) > P().sendTimeoutMin * 60 * 1000) retireQueueItem(q, '失败', '下发超时未回执，请重新叫车'); // ㉖v72b 统一回收（原仅改状态，叫车标记滞留30分钟）
    } else if (q.state === '已下发') {
      if (s && s.state === '有货' && has) { q.state = '到站'; q.dockAt = s.ts || nowMs; q.updAt = nowMs; releaseStnBook(q.code); } // ㉖v94k 到站刷新时间戳（旧版不刷→完成表"结束时间/全程耗时"显示成下发时刻，1秒假耗时）；㉖v72b 货已上台：预约失去意义立即作废
      else if ((!q.type || q.type === 'outbound') && q.station && q.sentAt) {
        // ㉖v69c 出库RCS沉淀旁证：搬运已完成但站台快照没抓到（货被快速取走/无实体标签框扫不到）→
        // 旧版会一直卡"已下发"40分钟等超时兜底，期间容器号被占用，入库叫车全被"已有在途搬运任务"挡死（物料员"总是不成功"根因）
        let fin = 0;
        for (const t of Object.values(db.agvTasks || {})) {
          if (t.ck !== 'out' || String(t.ep || '').toUpperCase() !== String(q.station).toUpperCase()) continue;
          if (String(t.sp || '').toUpperCase() !== String(q.fromLoc || '').toUpperCase()) continue;
          if ((t.fin || 0) < q.sentAt - 60000) continue;
          if ((t.fin || 0) > fin) fin = t.fin;
        }
        if (fin) { q.state = '到站'; q.dockAt = fin; q.updAt = nowMs; (q.trace = q.trace || []).push('RCS沉淀旁证：搬运已完成，快照未抓到到站，按记录推进'); }
      }
    } else if (q.state === '到站') {
      if (!has) { q.state = '完成'; q.dockAt = q.dockAt || nowMs; q.updAt = nowMs; clearQueueCall(q.reqId, q.code); releaseStnBook(q.code); } // ㉖v94k 完成刷新updAt（完成表"结束时间/全程耗时"取updAt，旧版不刷→显示成下发时刻的1秒假耗时）；㉖v72b 任务闭环：货离台=发走/清台，清叫车标记允许该框未来重新入队
    }
  }
  // 失败项保留30分钟供查看原因后自动出队（重新一键叫车即可再入队）；完成/取消保留2小时
  db.agvQueue = queue.filter((q) => {
    const age = nowMs - (q.updAt || q.at);
    if (q.state === '失败') { if (age >= P().failKeepMin * 60 * 1000) clearQueueCall(q.reqId, q.code); return age < P().failKeepMin * 60 * 1000; } // ㉖ 失败项保留可调
    if (['完成', '取消'].includes(q.state)) return age < P().queueKeepMin * 60 * 1000; // ㉖ 终态项保留可调
    return true;
  });
  const waiting = db.agvQueue.filter((q) => q.state === '排队');
  const _trf = (db.agvQueue || []).filter(function (x) { return x.type === 'transfer' && !x.dry && ['下发中', '已下发'].includes(x.state) && x.taskNo; });
  if (_trf.length) { const _ttk = await wmasToken(); if (_ttk) { for (const _t of _trf) { try { const _lr = await wmasHttp('GET', '/api/logistics/agv-task/list?pageNum=1&pageSize=5&taskNo=' + encodeURIComponent(_t.taskNo), _ttk); const _rec = (_lr && _lr.data && _lr.data.records || []).find(function (z) { return String(z.taskNo) === String(_t.taskNo); }); if (_rec) { const _st = String(_rec.status || '').toUpperCase(); if (['PUSHED', 'DISPATCHED', 'IN_TRANSIT'].includes(_st)) { /* 仍在途 */ } else if (_st.includes('CANCEL') || _st.includes('REJECT')) { retireQueueItem(_t, '取消', 'AGV任务已在下游取消（RCS/WMAS侧操作），资源已释放'); releaseStnBook(_t.code); } else { _t.state = '完成'; _t.updAt = nowMs; releaseStnBook(_t.code); const moved = applyTransferLedger(_t); if (!moved) { _t.err = '已到达但账本未自动更新，请用位置登记核对'; } (_t.trace = _t.trace || []).push(moved ? 'WMAS到达，账本已自动改位' : 'WMAS到达但账本未自动更新，请位置登记核对'); } } else { _t.state = '完成'; _t.updAt = nowMs; releaseStnBook(_t.code); _t.err = 'WMAS任务记录已不可查，未自动改账，请核对货位'; (_t.trace = _t.trace || []).push('WMAS记录不可查，按完成处理未改账'); } if (nowMs - (_t.sentAt || _t.at) > P().staleMin * 60000 && ['下发中', '已下发'].includes(_t.state)) { retireQueueItem(_t, '失败', '超时未完成'); (_t.trace = _t.trace || []).push('超' + P().staleMin + '分钟未完成，判失败'); } } catch (_) {} } } }
  // ㉖⑰ 入库搬运对账：站台→货架，终点非站台不走"到站清台"，按 WMAS 任务状态推进（账本已在扫码时登记，搬运不改账本）；㉖ 检验归位(inspback)同款并入
  const _inb = (db.agvQueue || []).filter((x) => (x.type === 'inbound' || x.type === 'inspback') && ['下发中', '已下发'].includes(x.state) && x.wmsTask);
  if (_inb.length) { const _itk = await wmasToken(); if (_itk) { for (const _q of _inb) { try {
    // ㉖ RCS 本地沉淀旁证：WMAS 任务状态回传可能滞后（实测 AGV 已上架完成，WMAS 仍报 IN_TRANSIT），
    // 此时按 RCS 完成时刻判完成。否则该项会一直停在"已下发"，随后被超时兜底误判为失败。
    // 注意 db.agvTasks 以 RCS 调度号为 key，与队列项 wmsTask(WMAS任务号)/taskNo(容器号)不同域，
    // 直查基本命不中 → 与 /api/agv/taskOf 同口径：按 方向in + 起点=fromLoc + fin≥下发时刻 取最近一条。
    const _rk = String(_q.wmsTask || ''), _rt = (db.agvTasks || {})[_rk] || (() => { const _sp = String(_q.fromLoc || '').toUpperCase(), _lo = (_q.sentAt || _q.at || 0) - 60000; let _b = null; for (const t of Object.values(db.agvTasks || {})) { if (t.ck !== 'in' || String(t.sp || '').toUpperCase() !== _sp || (t.fin || 0) < _lo) continue; if (!_b || (t.fin || 0) > (_b.fin || 0)) _b = t; } return _b; })();
    if (_rt && _rt.fin) { _q.state = '完成'; _q.dockAt = _rt.fin; _q.updAt = nowMs; continue; }
    const _lr = await wmasHttp('GET', '/api/logistics/agv-task/list?pageNum=1&pageSize=5&taskNo=' + encodeURIComponent(_q.wmsTask), _itk); const _rec = ((_lr && _lr.data && _lr.data.records) || []).find((z) => String(z.taskNo) === String(_q.wmsTask)); if (_rec) { const _st = String(_rec.status || '').toUpperCase(); if (['PUSHED', 'DISPATCHED', 'IN_TRANSIT'].includes(_st)) { if (nowMs - (_q.sentAt || _q.at) > P().staleMin * 60000) { retireQueueItem(_q, '失败', (_q.type === 'inspback' ? '检验归位超' : '入库搬运超') + P().staleMin + '分钟未完成，请核查'); } } else if (_st.includes('CANCEL') || _st.includes('REJECT')) { retireQueueItem(_q, '取消', 'AGV任务已在下游取消（RCS/WMAS侧操作），资源已释放'); inspQueueRollback(_q, null); } else { _q.state = '完成'; _q.dockAt = nowMs; _q.updAt = nowMs; clearQueueCall(_q.reqId, _q.code); releaseStnBook(_q.code); } } else if (nowMs - (_q.sentAt || _q.at) > P().staleMin * 60000) { retireQueueItem(_q, '失败', 'WMAS任务记录不可查，请核对货位'); inspQueueRollback(_q, null); } } catch (_) {} } } }
  // ㉖v72 出库负向对账（WMAS取消/驳回/查无→队列同步+资源回收），必须赶在超时兜底前跑；30秒节流防 WMAS 接口高频
  if (nowMs - _outRecAt > 30000) { _outRecAt = nowMs; try { await outboundReconcile(nowMs); } catch (_) {} }
  // ㉖v94j 卡单自愈：WMAS 停在"创建"未推送的任务自动补推（60秒节流）
  try { await wmasStuckPush(nowMs); } catch (_) {}
  // ㉖ 超时兜底必须在上面出库(3663)/入库对账【之后】执行，且要 await：
  // 旧实现由 rcsPoll 同步段先跑，对账还没推进状态就把"已下发"判超时（实测成功入库被误报）。
  try { await dispatchWatchdog(nowMs); } catch (_) {}
  save(); // ㉖ 对账+兜底的状态变更当轮落盘（旧实现依赖下一轮 rcsPoll 的 save，重启会丢刚推进的终态）
  if (!waiting.length) return;
  // 置顶最高优先（网页队列控制台）；急料插队；普通项等待超10分钟自动升级（aging防饿死）；同级保持FIFO
  // ㉖v61 单级整单插队：一张单任一框急/任一框老化 → 该单全部排队框一起按急处理且相邻出队（同单不被别单撕碎穿插）
  const _qKey = (q) => String(q.reqId || q.reqNo || ('C|' + q.code));
  const _grp = {};
  for (const q of waiting) { const g = (_grp[_qKey(q)] = _grp[_qKey(q)] || { rush: false, at: Infinity }); if (q.rush || (nowMs - (q.at || 0) > P().agingMin * 60000)) g.rush = true; if ((q.at || 0) < g.at) g.at = q.at || 0; }
  const _grpOf = (q) => _grp[_qKey(q)];
  waiting.sort((a, b) => ((b.prio || 0) - (a.prio || 0)) || (_grpOf(b).rush ? 1 : 0) - (_grpOf(a).rush ? 1 : 0) || (_grpOf(a).at - _grpOf(b).at) || (a.at || 0) - (b.at || 0));
  const live = (db.agvDispatchMode || 'dry') === 'live';
  const assigned = [];
  for (const q of waiting) {
    if (live && assigned.length >= P().batch) break; // 一轮最多下发 N 单，保守节奏
    await dispatchOne(q, nowMs, runT, assigned, live);
  }
}

// ===== ⑲ 搬运超时兜底：已下发超40分钟仍未到站/未回架 → 判失败+通知全体仓管人工核查 =====
// ㉖ 必须 async 且在 agvDispatch 的出库/入库对账【之后】await 调用：
// 旧实现由 rcsPoll 同步段直接调用，早于对账推进状态，导致 WMAS 已完成上架的入库项被误判超时；
// 且类型硬编码"出库超时"，入库项也记成出库（异常中心显示"明明是入库却报出库超时"）。
async function dispatchWatchdog(nowMs) {
  const stale = (db.agvQueue || []).filter((q) => q.type !== 'transfer' && q.state === '已下发' && q.sentAt && nowMs - q.sentAt > P().staleMin * 60 * 1000);
  for (const q of stale) {
    const isIn = q.type === 'inbound', isIO = q.type === 'insp', isIB = q.type === 'inspback';
    const kind = isIn ? '入库超时' : isIO ? '检验下架超时' : isIB ? '检验归位超时' : '出库超时';
    const toTxt = (isIn || isIB) ? (q.station || q.stationManual || '货架位') : (q.station || '待分配');
    const verb = (isIn || isIO || isIB) ? '未完成' : '未到站';
    q.state = '失败'; q.err = (isIn ? '入库搬运' : isIO ? '检验下架' : isIB ? '检验归位' : '出库') + '下发超' + P().staleMin + '分钟' + verb + '，请核查'; q.updAt = nowMs; q.trace = (q.trace || []); q.trace.push('超' + P().staleMin + '分钟' + verb + '，判失败并通知（RCS可能卡死）');
    clearQueueCall(q.reqId, q.code); releaseStnBook(q.code); // ㉖v72 超时判失败同步作废站台预约，车不来了不该继续锁台
    inspQueueRollback(q, null); // ㉖v72b 检验下架/归位超时→工单回退待协助，可再次叫车（否则工单永远卡 toStation/returning）
    pushEvent(kind, q.code || '', (q.fromLoc || '') + '→' + toTxt + ' 下发超' + P().staleMin + '分钟' + verb, nowMs);
    const msg = `⏰ AGV任务超时：框 ${q.code}（${q.fromLoc}→${toTxt}）下发超${P().staleMin}分钟${verb}${isIn || isIB ? '上架' : ''}，请到RCS核查是否卡死`;
    db.users.filter((x) => (x.role === 'warehouse' || x.role === 'admin') && x.enabled).forEach((x) => notify(x.id, 'req_arrive', msg, q.reqId || ''));
    console.log('[dispatch-timeout] ' + msg);
  }
}

// ===== ④D 低电不归巢看门狗：电量≤25%、不在充电且空闲超20分钟 → 通知全体仓管 =====
async function lowBatWatch(tk, nowMs) {
  if (!tk) return;
  let cars = []; try { const cr = await rcsReq('/uds/car/getCarInfoList', 'GET', tk); cars = typeof cr.data === 'string' ? JSON.parse(cr.data) : (cr.data || []); } catch (_) { return; }
  db.rcsLowBat = db.rcsLowBat || {};
  const seen = {};
  for (const c of cars) {
    const id = c.agvId; const pw = Number(c.power) || 0;
    const idle = !c.executeTaskNo && c.carState === 'idle' && c.charging !== true && c.communicationBreak !== true && c.enable === 1;
    if (id !== undefined && pw > 0 && pw <= P().lowBatPct && idle) {
      seen[id] = 1;
      if (!db.rcsLowBat[id]) { db.rcsLowBat[id] = { at: nowMs, notified: false }; continue; }
      const j = db.rcsLowBat[id];
      if (!j.notified && nowMs - j.at > P().lowBatMin * 60 * 1000) {
        j.notified = true; pushEvent('低电', carName(id), '电量' + pw + '% 空闲' + Math.round((nowMs - j.at) / 60000) + '分钟未回充', nowMs);
        const msg = `🔋 低电提醒：AGV${String(id).padStart(2, '0')} 电量 ${pw}% 已空闲 ${Math.round((nowMs - j.at) / 60000)} 分钟未回充，请安排充电或手动回桩`;
        db.users.filter((x) => (x.role === 'warehouse' || x.role === 'admin') && x.enabled).forEach((x) => notify(x.id, 'req_arrive', msg, ''));
        console.log('[lowbat] ' + msg);
      }
    }
  }
  for (const id of Object.keys(db.rcsLowBat)) { if (!seen[id]) { const v0 = db.rcsLowBat[id]; if (v0 && v0.notified) pushEvent('低电恢复', carName(id), '已回充/接任务/离线', nowMs); delete db.rcsLowBat[id]; } } // 清记录前先落历史
}

// ===== ⑱ AGV车辆告警：边沿检测（急停立即/其余宽限90s防抖），通知全体仓管+落库历史，恢复发复位 =====
async function carAlarmWatch(tk, nowMs) {
  if (!tk) return;
  let cars = []; try { const cr = await rcsReq('/uds/car/getCarInfoList', 'GET', tk); cars = typeof cr.data === 'string' ? JSON.parse(cr.data) : (cr.data || []); } catch (_) { return; }
  db.rcsCarAlarm = db.rcsCarAlarm || {};
  // ㉖v92b 幽灵告警清理：告警表按车id挂记录，若该车已不在 RCS 车辆清单（改名/退役），旧记录永远等不到"恢复"分支
  //（实测 10/20 的 4 条"通讯断开"挂到今），车辆页认领按钮数据源被污染——清单外的 id 直接删
  { const _ids = new Set(cars.map((x) => x.agvId).filter((v) => v !== undefined && v !== null).map(Number));
    for (const id of Object.keys(db.rcsCarAlarm)) if (!_ids.has(Number(id))) delete db.rcsCarAlarm[id]; }
  db.carAlarms = db.carAlarms || []; // 告警历史落库（供追溯）
  const logAlarm = (id, name, kind, msg) => { db.carAlarms.push({ at: nowMs, id, name, kind, msg }); if (db.carAlarms.length > 500) db.carAlarms = db.carAlarms.slice(-500); pushEvent(kind === 'recover' ? '恢复' : kind === 'ack' ? '已认领' : kind === 'escalate' ? '升级' : kind === 'redflag' ? '红牌' : '告警', name, msg, nowMs); };
  for (const c of cars) {
    const id = c.agvId; if (id === undefined || id === null) continue;
    const name = c.carName || ('AGV' + String(id).padStart(2, '0'));
    const estop = c.emergencyButton === true || c.manualStop === true;
    const parts = [];
    if (c.emergencyButton === true) parts.push('急停按下');
    else if (c.manualStop === true) parts.push('人工停止');
    if (c.communicationBreak === true) parts.push('通讯断开');
    if (c.lowPower === true) parts.push('低电量');
    const err = (c.errorMessage || '').toString().trim(); if (err) parts.push('错误:' + err);
    const fp = parts.join('|');
    const rec = db.rcsCarAlarm[id];
    if (!fp) {
      if (rec && rec.notified) { const msg = `✅ ${name} 告警已恢复（原：${rec.fp}）`; db.users.filter((x) => (x.role === 'warehouse' || x.role === 'admin') && x.enabled).forEach((x) => notify(x.id, 'car_alarm', msg, '')); logAlarm(id, name, 'recover', msg); console.log('[car-alarm-recover] ' + msg); }
      delete db.rcsCarAlarm[id];
      continue;
    }
    if (!rec || rec.fp !== fp) { db.rcsCarAlarm[id] = { fp, since: nowMs, notified: false, severe: estop }; continue; } // 新告警/变化：重置计时
    const j = db.rcsCarAlarm[id];
    if (!j.notified) {
      if (nowMs - j.since < (j.severe ? 0 : 90 * 1000)) continue; // 急停立即，其余宽限90s防瞬时抖动
      j.notified = true; j.esc = 0;
      const msg = `🚨 ${name} 车辆告警：${fp}${j.severe ? '（急停，请立即处理·可点认领）' : ''}`;
      db.users.filter((x) => (x.role === 'warehouse' || x.role === 'admin') && x.enabled).forEach((x) => notify(x.id, 'car_alarm', msg, ''));
      logAlarm(id, name, 'alarm', msg);
      console.log('[car-alarm] ' + msg);
    } else if (j.severe && !j.ackBy) { // G2 急停类未认领升级
      const mins = (nowMs - j.since) / 60000;
      if (!j.esc && mins >= 10) { j.esc = 1; const m2 = `⏫ ${name} 急停告警10分钟无人认领，请管理员协调处理`; db.users.filter((x) => x.role === 'admin' && x.enabled).forEach((x) => notify(x.id, 'car_alarm', m2, '')); if (db.carAlarms) db.carAlarms.push({ at: nowMs, id, name, kind: 'escalate', msg: m2 }); pushEvent('升级', name, m2, nowMs); console.log('[car-alarm-esc] ' + m2); }
      else if (j.esc === 1 && mins >= 30) { j.esc = 2; const m3 = `🔴 ${name} 急停告警30分钟仍未处理，请现场核查！`; db.users.filter((x) => (x.role === 'warehouse' || x.role === 'admin') && x.enabled).forEach((x) => notify(x.id, 'car_alarm', m3, '')); if (db.carAlarms) db.carAlarms.push({ at: nowMs, id, name, kind: 'redflag', msg: m3 }); pushEvent('红牌', name, m3, nowMs); console.log('[car-alarm-red] ' + m3); }
    }
  }
}

// ===== ④A 全链路交付漏斗：接单→叫车→排队→下发→叉出→到站→清台 分段平均耗时（起终点+时间窗关联） =====
function buildFunnel(days) {
  const nowMs = Date.now(), since = nowMs - days * 86400000;
  const tasks = Object.values(db.agvTasks || {}).filter((t) => t.ck === 'out' && t.fin >= since);
  const findTask = (sp, ep, lo, hi) => { let best = null; for (const t of tasks) { if (t.sp === sp && t.ep === ep && t.fin >= lo && t.fin <= hi && (!best || t.fin < best.fin)) best = t; } return best; };
  const samples = [];
  const reqs = (db.requisitions || []).filter((r) => r.createdAt && Date.parse(r.createdAt) >= since - 86400000 && ['accepted', 'ready', 'done'].includes(r.status));
  for (const r of reqs) {
    const acceptT = (r.history || []).filter((h) => /接单/.test(String(h.text))).map((h) => Date.parse(h.time)).filter(Number.isFinite).sort((a, b) => a - b)[0] || 0;
    const issuedSet = new Set();
    for (const it of r.items || []) for (const x of (it.issued || [])) issuedSet.add(String(typeof x === 'string' ? x : (x.c || '')).toUpperCase());
    for (const it of r.items || []) for (const e of (it.agvCalled || [])) {
      const code = String(e.c || '').toUpperCase();
      const calledAt = Date.parse(e.t || '') || 0; if (!calledAt || calledAt < since) continue;
      const q = (db.agvQueue || []).find((x) => String(x.code).toUpperCase() === code && Math.abs((x.at || 0) - calledAt) < 120000);
      const sentAt = q ? (q.at || 0) : calledAt, dispAt = q ? (q.sentAt || 0) : 0;
      const stn = ((q && q.station) || String(e.s || '')).toUpperCase();
      const fromLoc = String((q && q.fromLoc) || it.loc || '').toUpperCase();
      const tk = (q && q.wmsTask && db.agvTasks[q.wmsTask]) // ①taskNo精确关联（WMAS与RCS同号）
        || (fromLoc && stn ? findTask(fromLoc, stn, sentAt - 60000, Math.max(dispAt, sentAt) + 6 * 3600000) : null); // ②兜底：起终点+时间窗
      const s = { call: 0, queue: 0, dispatch: 0, pick: 0, arrive: 0, hold: 0, total: 0 };
      if (acceptT) s.call = (calledAt - acceptT) / 60000;
      if (dispAt) s.queue = (dispAt - sentAt) / 60000;
      if (tk) {
        if (tk.ex) s.dispatch = (tk.ex - (dispAt || sentAt)) / 60000;
        if (tk.pick && tk.ex) s.pick = (tk.pick - tk.ex) / 60000;
        if (tk.fin && tk.pick) s.arrive = (tk.fin - tk.pick) / 60000;
        if (s.queue > 0 && s.dispatch > 0 && tk.fin) s.total = (tk.fin - sentAt) / 60000;
        const clearedAt = q && q.state === '完成' ? (q.updAt || 0) : (issuedSet.has(code) ? Math.max(tk.fin, nowMs) : 0);
        if (clearedAt && clearedAt > tk.fin) s.hold = (clearedAt - tk.fin) / 60000;
      }
      samples.push(s);
    }
  }
  const stat = (key) => { const a = samples.map((s) => s[key]).filter((v) => v > 0 && v < 720); return { avg: a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length * 10) / 10 : 0, n: a.length }; };
  return { call: stat('call'), queue: stat('queue'), dispatch: stat('dispatch'), pick: stat('pick'), arrive: stat('arrive'), hold: stat('hold'), total: stat('total') };
}

process.on('uncaughtException', (e) => { try { logErr('uncaughtException', e); flushSave(); } catch (_) {} console.error('[FATAL] 未捕获异常：', e); }); // ㉖ 崩溃前留痕（不退出：调度循环中断比报错更糟）；㉖v56 改 flushSave 同步落盘防合并窗口丢数据
process.on('unhandledRejection', (e) => { try { logErr('unhandledRejection', e instanceof Error ? e : { message: String(e) }); } catch (_) {} console.error('[REJECT] 未处理 Promise 拒绝：', e); });
// ㉖v56 优雅退出：进程终止前把合并窗口脏数据同步落盘（防丢最后 120ms 变更）
// Windows 无真实 SIGTERM（kill=TerminateProcess 强杀无 handler）：NSSM 停服/Ctrl+C 走 SIGINT，Ctrl+Break 走 SIGBREAK；flush 后必须主动 exit，否则监听器会抑制默认退出
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) { process.on(sig, () => { try { flushSave(); } catch (_) {} console.log('[exit] ' + sig + ' 优雅停止：脏数据已落盘'); process.exit(0); }); }
process.on('beforeExit', () => { try { flushSave(); } catch (_) {} }); // 自然退出兜底（事件循环排空时）

server.keepAliveTimeout = 65000; // ㉖v57 间歇登录网络错误：Node默认keep-alive 5s短于浏览器连接池复用窗口，POST落在服务端已关连接上被reset且不自动重试；抬到65s(长于常见代理60s)
server.headersTimeout = 66000; // 需略大于keepAliveTimeout
server.requestTimeout = 300000; // 单请求上限5分钟（SSE长挂走独立路径不受影响：SSE在handler内自持res）
server.on('error', (e) => { if (e && e.code === 'EADDRINUSE') { console.log('[exit] 端口已被占用：本实例为多余副本，立即退出不落盘（防旧快照回写覆盖）'); process.exit(0); } }); // ㉖v69 幻影进程根治：抢不到端口的副本绝不带旧内存继续跑（process.exit 同时跳过 beforeExit 的 flushSave）
server.listen(PORT, HOST, () => { console.log(`[auth-server] http://${HOST}:${PORT} 已启动（数据文件 ${DB_FILE}）`); try { opsMigrateToFiles(); eventsMigrateFromAlarms(); seenInBackfill(); opsDigestTick(); cleanOrphanTmp(); } catch (_) {} backupDb(); archiveOld(); setTimeout(() => { try { const n = outboundLedgerFix(); if (n) console.log('[ob-fix] 启动补建出库台账 ' + n + ' 行'); } catch (_) {} }, 8000); }); // ㉖v94r 启动后补建缺失出库台账（已转MES但PDA推送丢失的行），延迟8秒待服务就绪
