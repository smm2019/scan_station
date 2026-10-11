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

const ROLES = ['material', 'warehouse', 'admin']; // 物料员 / 仓管员 / 管理员
const ROLE_NAMES = { material: '物料员', warehouse: '仓管员', admin: '管理员' };
// 按角色功能开关（管理员可在线改；App 登录与心跳时拉取）
const DEFAULT_FEATURES = {
  material: { collect: false, inventory: false, export: true, mes_query: true, direct_transfer: false, requisition: true, receive_confirm: true, location_reg: false, agv_monitor: false, agv_control: false, admin_panel: false },
  warehouse: { collect: true, inventory: true, export: true, mes_query: true, direct_transfer: true, requisition: false, receive_confirm: false, location_reg: true, agv_monitor: true, agv_control: true, admin_panel: false },
  admin: { collect: true, inventory: true, export: true, mes_query: true, direct_transfer: true, requisition: true, receive_confirm: true, location_reg: true, agv_monitor: true, agv_control: true, admin_panel: true },
};
// 功能开关判定：管理员在线关掉某角色开关后，服务器端同步拒绝（全局生效，不只UI隐藏）
function canFeature(u, key) { return !!(db.features && db.features[u.role] && db.features[u.role][key] === true); }
const FEATURE_NAMES = { collect: '采集录入', inventory: '盘点模式', export: '导出下载', mes_query: 'MES查询', direct_transfer: '直调转单', requisition: '领料下单', receive_confirm: '签收确认', location_reg: '位置登记', agv_monitor: 'AGV监控', agv_control: 'AGV车辆控制', admin_panel: '管理后台' };

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
    watchlist: [], // ⑮预约来料 [{userId,partNo,at}]
    groundSlots: {}, // ⑮地面排格数覆盖 {"NB03-A-11":13}，缺省12
    stockAlert: {}, // ⑮断料告警去重 {零件号: 最近告警日}
    prefs: {}, // ㉕F5 个人偏好 {userId:{key:{v,at}}}（后写覆盖=方案"到达序新者胜"）
    prefTemplates: [], // ㉕F5 管理员配置模板 [{name,prefs,by,at}]
  };
}
// ---- ㉕F6 凭据静态加密（AES-256-GCM，密钥 data/secret.key 不进git）+ ㉕F5 偏好/㉕F9 归档工具 ----
const KEY_FILE = path.join(DATA_DIR, 'secret.key');
function secretKey() { try { if (fs.existsSync(KEY_FILE)) return Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex'); } catch (_) {} const k = crypto.randomBytes(32); try { fs.writeFileSync(KEY_FILE, k.toString('hex')); } catch (_) {} return k; }
function encSec(s) { if (!s || String(s).indexOf('enc1:') === 0) return s; try { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', secretKey(), iv); const e = Buffer.concat([c.update(String(s), 'utf8'), c.final()]); return 'enc1:' + iv.toString('base64') + ':' + c.getAuthTag().toString('base64') + ':' + e.toString('base64'); } catch (_) { return s; } }
function decSec(s) { if (!s || String(s).indexOf('enc1:') !== 0) return s; try { const q = String(s).split(':'); const d = crypto.createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(q[1], 'base64')); d.setAuthTag(Buffer.from(q[2], 'base64')); return Buffer.concat([d.update(Buffer.from(q[3], 'base64')), d.final()]).toString('utf8'); } catch (_) { console.log('[sec] secret.key 与 db.json 不匹配：RCS/WMAS 密码需在设置页重录一次'); return ''; } }
function walkSec(o, fn) { for (const k of ['rcsConfig', 'wmasConfig']) { const c = o[k]; if (c && c.pwd) fn(c, 'pwd'); } if (o.rcsToken) fn(o, 'rcsToken'); }
function clientFp(req) { let ip = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, ''); const seg = ip.indexOf(':') >= 0 ? ip.split(':').slice(0, 2).join(':') : ip.split('.').slice(0, 2).join('.'); return crypto.createHash('sha1').update(seg + '|' + String(req.headers['user-agent'] || '')).digest('hex').slice(0, 12); }
function prefsFor(uid) { const o = (db.prefs && db.prefs[uid]) || {}; const r = {}; for (const k in o) { if (k === 'notes') r[k] = o[k].v; else if (k === 'kpi') r[k] = Array.isArray(o[k].v) ? o[k].v : []; else if (k === 'work') r[k] = Number(o[k].v) === 1 ? 1 : 0; else if (k === 'rate') r[k] = Math.min(0.9, Math.max(0.3, Number(o[k].v) || 0.55)); else if (k === 'voice') r[k] = o[k].v !== false; else r[k] = String(o[k].v == null ? '' : o[k].v).slice(0, 20); } return r; }
function archLoad(kind) { const out = {}; try { const dir = path.join(DATA_DIR, 'archive'); for (const f of fs.readdirSync(dir)) { if (f.indexOf('-' + kind + '.json') < 0) continue; try { Object.assign(out, JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch (_) {} } } catch (_) {} return out; }
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
  if (!Array.isArray(d.watchlist)) { d.watchlist = []; added = true; }
  if (!d.params || typeof d.params !== 'object' || Array.isArray(d.params)) { d.params = {}; added = true; }
  if (!Array.isArray(d.carEvents)) { d.carEvents = []; added = true; } // ㉖异常事件持久表（180天滚动，恢复即归档不删除）
  if (typeof d.groundSlots !== 'object' || d.groundSlots === null || Array.isArray(d.groundSlots)) { d.groundSlots = {}; added = true; }
  if (typeof d.stockAlert !== 'object' || d.stockAlert === null || Array.isArray(d.stockAlert)) { d.stockAlert = {}; added = true; }
  if (typeof d.prefs !== 'object' || d.prefs === null || Array.isArray(d.prefs)) { d.prefs = {}; added = true; }
  if (!Array.isArray(d.prefTemplates)) { d.prefTemplates = []; added = true; }
  if (added) { saveDb(d); console.log('[init] 已补齐领料单/通知/货位账本集合'); }
  try { walkSec(d, (o, k) => { o[k] = decSec(o[k]); }); } catch (_) {} // ㉕F6 载入解密（明文旧数据直通，下次save自动转密）
  return d;
}
// ㉖G3 SQLite迁移触发线监控：落盘写耗时滚动统计（近50次 max/avg）
const _saveStat = { ring: [], max: 0, avg: 0, n: 0 };
function saveDb(db) { // 原子写：临时文件 + rename
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  const _sv = []; // ㉕F6 落盘加密：同步暂换→序列化→还原（单线程无并发观察，免整库深拷贝）
  try { walkSec(db, (o, k) => { const e = encSec(o[k]); if (e !== o[k]) { _sv.push([o, k, o[k]]); o[k] = e; } }); } catch (_) {}
  const _t0 = Date.now();
  try { fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8'); } finally { for (const it of _sv) it[0][it[1]] = it[2]; }
  fs.renameSync(tmp, DB_FILE);
  try { const ms = Date.now() - _t0; _saveStat.ring.push(ms); if (_saveStat.ring.length > 50) _saveStat.ring.shift(); _saveStat.n++; _saveStat.max = Math.max.apply(null, _saveStat.ring); _saveStat.avg = Math.round(_saveStat.ring.reduce((a, b) => a + b, 0) / _saveStat.ring.length); } catch (_) {}
}
// ---- 数据自动备份：启动一次 + 每30分钟快照，保留最近72份（约36小时）；误删/损坏可从 data/backups 恢复 ----
function backupDb() {
  try {
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
    fs.writeFileSync(p + '.tmp', JSON.stringify(_bk)); fs.renameSync(p + '.tmp', p);
    const all = fs.readdirSync(dir).filter((f) => /^db-.*\.json$/.test(f)).sort();
    while (all.length > 72) { const old = all.shift(); try { fs.unlinkSync(path.join(dir, old)); } catch (_) {} }
  } catch (e) { console.log('[backup] 失败：', e.message); }
}
setInterval(backupDb, 30 * 60 * 1000).unref();
// ---- G3 数据归档：每日18:00把超期数据（默认180天）挪入 data/archive/YYYY-MM-*.json 再从主库移除；先写档成功才删，档案可回捞 ----
let _archLast = '';
function archiveOld() {
  try {
    const d = new Date();
    if (d.getHours() < 18) return;
    const day = d.toISOString().slice(0, 10);
    if (_archLast === day) return; _archLast = day;
    const days = Number(db.archiveAfterDays) || 180;
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
    if ((db.notifications || []).length > 2000) { const old = db.notifications.filter((x) => Date.parse(x.time) < cut); if (old.length) { db.notifications = db.notifications.filter((x) => Date.parse(x.time) >= cut); moved += old.length; } }
    if (moved) { save(); console.log(`[archive] 归档 ${moved} 条超${days}天数据 → data/archive/${mon}-*（${day}）`); }
  } catch (e) { console.log('[archive] 失败：', e.message); }
}
setInterval(archiveOld, 30 * 60 * 1000).unref();
// ---- ㉒G7 物料字典：零件号→名称，由采集流水/出库单自动沉淀 ----
function feedDict(pn, nm, src) {
  try {
    pn = String(pn || '').toUpperCase().trim(); nm = String(nm || '').trim();
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
  '库存汇总': [['在架框数', '按"框=托"去重：同托号多标签计1框；无托号按同货位+同零件号合并'], ['在架数量', '每框取框内标签数量最大值后按框求和（与PDA库存页同口径）'], ['占用货位数', '该零件涉及的货位格数（去重）'], ['货位分布(TOP5)', '按该零件占用格数排序前5货位（NB区简写×框数）'], ['最近入库/最近出库', '采集流水/出库单最大时刻（主库窗口内）']],
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
  // 出库：出库单标签去重计框、件数合计；操作人记o.operator
  for (const o of Object.values(db.outbound || {})) {
    const t = Number(o.createdAt) || 0; if (t < from || t > to) continue;
    const day = wdstr(t), who = String(o.operator || '').trim() || '未知';
    const codes = new Set(); let qty = 0;
    for (const i of (o.items || [])) { const c = String(i.barcode || '').toUpperCase(); if (c && !codes.has(c)) { codes.add(c); qty += Number(i.qty) || 0; } }
    if (!codes.size) continue;
    const p = P(who, day); p.outB += codes.size; p.outQ += qty; p.days[day].outB += codes.size; D(day).outB += codes.size; D(day).outQ += qty;
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
    const key = 'AGV' + String(t.car || 0).padStart(2, '0'); const c = (cars[key] = cars[key] || { out: 0, in: 0, other: 0, dur: 0, n: 0 });
    c[t.ck === 'out' ? 'out' : t.ck === 'in' ? 'in' : 'other']++; c.n++; c.dur += t.dur || 0;
    D(wdstr(t.fin)).agv++;
  }
  return { persons, days, cars };
}
function buildExport(ds, fRaw) {
  const f = { from: String((fRaw && fRaw.from) || '').slice(0, 10), to: String((fRaw && fRaw.to) || '').slice(0, 10) };
  const _arch = !!(fRaw && (fRaw.arch === '1' || fRaw.arch === true)); // ㉕F9 含归档：主库∪data/archive
  const from = f.from ? Date.parse(f.from + 'T00:00:00') : 0;
  const to = f.to ? Date.parse(f.to + 'T23:59:59') : Infinity;
  const CAP = 20000;
  const mk = (label, headers, types, rows, src) => ({ label, headers, types, rows: rows.slice(0, CAP), total: rows.length, src, f, caliber: EXP_CAL[label] || [] });
  if (ds === 'D1') return mk('库位表', ['货位', '标签号', '零件号', '物料名称', '数量', '批次', '料框', '登记人', '登记时间', '搬运方式', '来源'], ['S', 'S', 'S', 'S', 'N', 'S', 'S', 'S', 'S', 'S', 'S'], db.ledger.map((x) => [x.l, x.c, x.p || '', x.n || '', x.q || 0, x.b || '', x.f || '', x.by || '', expTs(x.t), x.mv || '', x.src || '']).sort((a, b) => String(a[0]).localeCompare(String(b[0]))), '货位账本（服务器合并快照）');
  if (ds === 'D2') { const m = {}; for (const x of db.ledger) { const pn = String(x.p || '').toUpperCase() || '(无零件号)'; const k = boxKeyOf(x); const e = (m[pn] = m[pn] || { b: {}, locs: {}, nm: '' }); e.b[k] = Math.max(e.b[k] || 0, Number(x.q) || 0); e.locs[String(x.l).toUpperCase()] = (e.locs[String(x.l).toUpperCase()] || 0) + 1; if (!e.nm && x.n) e.nm = x.n; }
    // ㉕B12 最近出入动向：入库=采集流水最大t；出库=出库单明细最大createdAt
    const lastIn = {}, lastOut = {};
    for (const s of Object.values(db.scanlog || {})) { if (s.cx) continue; const pn = String(s.pn || '').toUpperCase(); if (!pn) continue; lastIn[pn] = Math.max(lastIn[pn] || 0, s.t || 0); }
    for (const o of Object.values(db.outbound || {})) { const t = Number(o.createdAt) || 0; for (const i of (o.items || [])) { const pn = String(i.code || '').toUpperCase(); if (pn) lastOut[pn] = Math.max(lastOut[pn] || 0, t); } }
    const mkRow = (pn, e) => { const bs = Object.values(e.b); const locs = Object.entries(e.locs).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([l, n]) => l.split('-').slice(1).join('-') + '×' + n).join('、') + (Object.keys(e.locs).length > 5 ? '…' : ''); return [pn, (db.itemDict && db.itemDict[pn] && db.itemDict[pn].nm) || e.nm, bs.length, bs.reduce((s2, v) => s2 + v, 0), Object.keys(e.locs).length, locs, expTs(lastIn[pn] || 0), expTs(lastOut[pn] || 0)]; };
    let rows = Object.entries(m).map(([pn, e]) => mkRow(pn, e));
    if (fRaw && (fRaw.zero === '1' || fRaw.zero === true)) { for (const pn of new Set([...Object.keys(lastIn), ...Object.keys(lastOut), ...Object.keys(db.itemDict || {})])) if (!m[pn]) rows.push([pn, (db.itemDict && db.itemDict[pn] && db.itemDict[pn].nm) || '', 0, 0, 0, '', expTs(lastIn[pn] || 0), expTs(lastOut[pn] || 0)]); } // 零库存：有过流水但当前无在架
    rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    return mk('库存汇总', ['零件号', '物料名称', '在架框数', '在架数量', '占用货位数', '货位分布(TOP5)', '最近入库', '最近出库'], ['S', 'S', 'N', 'N', 'N', 'S', 'S', 'S'], rows, '货位账本按框聚合（动向取自主库窗口，含归档勾选不影响本表）'); }
  if (ds === 'D3') { const _sl = _arch ? Object.assign(archLoad('scanlog'), db.scanlog || {}) : (db.scanlog || {}); const rows = Object.values(_sl).filter((s) => (s.t || 0) >= (from || 0) && (s.t || 0) <= to).sort((a, b) => (b.t || 0) - (a.t || 0)).map((s) => [expTs(s.t), s.code, s.pn || '', s.nm || '', s.q || 0, s.lot || '', (s.wt === 0 ? s.st : s.gl) || '', s.ct || '', s.pid || '', s.op || '', s.cx ? '已作废' : '', s.rm || '']); return mk('入库流水', ['时间', '标签号', '零件号', '物料名', '数量', '批次', '初始货位', '容器类型', '托号', '操作人', '状态', '备注'], ['S', 'S', 'S', 'S', 'N', 'S', 'S', 'S', 'S', 'S', 'S', 'S'], rows, '采集流水（全厂合并）'); }
  if (ds === 'D4') { const _ob = _arch ? Object.assign(archLoad('outbound'), db.outbound || {}) : (db.outbound || {}); const rows = []; for (const o of Object.values(_ob)) { const t = Number(o.createdAt) || 0; if ((from && t < from) || t > to) continue; for (const i of (o.items || [])) rows.push([o.orderNo, expTs(t), i.code || '', i.name || '', i.qty || 0, i.barcode || '', i.fromLoc || '', o.toLoc || '', i.move || '', o.linkReqNo || '', o.operator || '']); } rows.sort((a, b) => String(b[0]).localeCompare(String(a[0]))); return mk('出库流水', ['出库单号', '时间', '零件号', '物料名', '数量', '标签号', '原货位', '转入去向', '搬运方式', '关联领料单', '操作人'], ['S', 'S', 'S', 'S', 'N', 'S', 'S', 'S', 'S', 'S', 'S'], rows, '出库单（全厂合并，领料转单+直调）'); }
  if (ds === 'D5') { const reqOfTask = {}; for (const q of db.agvQueue || []) { const tn = String(q.taskNo || ''); if (tn && q.reqNo && !reqOfTask[tn]) reqOfTask[tn] = q.reqNo; } // 关联单=按RCS任务号配对（完成项队列留存可回溯）
    const rows = Object.entries(db.agvTasks || {}).filter(([, t]) => (t.fin || 0) >= (from || 0) && (t.fin || 0) <= to).sort((a, b) => (b[1].fin || 0) - (a[1].fin || 0)).map(([no, t]) => [no, t.ck === 'out' ? '出库' : t.ck === 'in' ? '入库' : '其他', t.sp || '', t.ep || '', 'AGV' + String(t.car || 0).padStart(2, '0'), expTs(t.ex), expTs(t.pick), expTs(t.fin), t.dur || 0, '完成', reqOfTask[no] || '']);
    // ㉕B10 未完成在途并入同表（状态=排队/下发中/已下发/到站/失败），补"状态/关联单"两列
    for (const q of db.agvQueue || []) { if (['完成', '取消'].includes(q.state)) continue; const at = Number(q.at) || 0; if ((from && at < from) || at > to) continue; rows.push([q.taskNo || '未生成', q.type === 'transfer' ? '移库' : '出库', q.fromLoc || q.from || '', q.station || q.to || '', '', '', expTs(q.sentAt || 0) || '', expTs(q.dockAt || 0) || '', Math.round((Date.now() - at) / 1000), q.state, q.reqNo || '']); }
    return mk('AGV任务', ['任务号', '方向', '起点', '终点', '车辆', '接令', '叉出', '到站', '时长秒', '状态', '关联单'], ['S', 'S', 'S', 'S', 'S', 'S', 'S', 'S', 'N', 'S', 'S'], rows, 'RCS任务沉淀（近30天六节点）+未完成在途队列（时长秒=已耗时）'); }
  if (ds === 'D6') { // ㉕B11 补持续时长/是否恢复：同车事件流内配对（告警→该车其后首条恢复；无配对=至今未恢复）
    const evs = buildEvents(); const pend = {};
    for (let i = evs.length - 1; i >= 0; i--) { const e = evs[i]; const w = String(e.who || ''); if (e.kind === '告警' || e.kind === '红牌' || e.kind === '升级') { pend[w] = e; } else if (e.kind === '恢复' && pend[w] && e.ts >= pend[w].ts) { pend[w]._rt = e.ts; pend[w] = null; } }
    const rows = evs.map((e) => {
      let dur = '', recd = '';
      if (e.kind === '告警' || e.kind === '红牌' || e.kind === '升级') { if (e._rt) { dur = Math.max(1, Math.round((e._rt - e.ts) / 60000)); recd = '已恢复'; } else { dur = Math.max(1, Math.round((Date.now() - e.ts) / 60000)); recd = '未恢复'; } }
      else if (e.kind === '恢复') recd = '已恢复';
      else if (e.kind === '低电') recd = (db.rcsLowBat || {})[String(e.who).replace(/\D/g, '')] ? '未回充' : '已回充';
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
  if (ds === 'D8') { const ST = { pending: '待接单', accepted: '备料中', ready: '待签收', done: '已签收', rejected: '已拒单', cancelled: '已取消' }; const rows = (db.requisitions || []).filter((r) => { const t = Date.parse(r.createdAt) || 0; return t >= (from || 0) && t <= to; }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map((r) => { const acc = (r.history || []).find((h) => /接单/.test(h.text || '')); const fin = (r.history || []).filter((h) => /签收|拒单|取消/.test(h.text || '')).pop(); const mins = acc && fin ? Math.round((Date.parse(fin.time) - Date.parse(acc.time)) / 60000) : ''; return [r.no, expTs(Date.parse(r.createdAt) || 0), r.byName || r.by || '', (r.items || []).length, (r.items || []).reduce((s, i) => s + (Number(i.qty) || 0), 0), ST[r.status] || r.status, r.acceptedBy || '', r.confirmedBy || '', expTs(Date.parse(r.confirmedAt) || 0), acc ? expTs(Date.parse(acc.time) || 0) : '', mins === '' ? '' : mins, (r.remark || '').slice(0, 60)]; }); return mk('领料台账', ['单号', '下单时间', '下单人', '行数', '件数合计', '状态', '接单人', '签收人', '签收时间', '接单时间', '处理分钟', '备注'], ['S', 'S', 'S', 'N', 'N', 'S', 'S', 'S', 'S', 'S', 'N', 'S'], rows, '领料单全量（含节点时刻，处理分钟=接单到终结）'); }
  if (ds === 'D9') { const rows = opsLoadDays(OPS_KEEP_DAYS).filter((o) => (o.t || 0) >= (from || 0) && (o.t || 0) <= to).sort((a, b) => (b.t || 0) - (a.t || 0)).map((o) => [expTs(o.t), o.by || '', o.role || '', o.act || '', o.obj || '', o.det || '']); return mk('活动流审计', ['时间', '操作人', '角色', '动作', '对象', '详情'], ['S', 'S', 'S', 'S', 'S', 'S'], rows, '关键写操作留痕（滚动5000条，凭据不入流）'); }
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
    sseSend({ t: 'snap', at: db.rcsAt || new Date().toISOString(), run: (db.rcsRun || []).length, queue: (db.agvQueue || []).filter((q) => ['排队', '下发中', '已下发'].includes(q.state)).length, on: !!(db.rcsConfig && db.rcsConfig.host), sc: db.scanlogAt || '' }); // ㉕F10 健康灯字段
    const tk = (db.rcsToken && Date.now() < (db.rcsTokenExp || 0)) ? db.rcsToken : null;
    if (!tk) return;
    rcsReq('/uds/car/getCarInfoList', 'GET', tk).then((cr) => {
      try {
        const cars = cr && cr.data ? (typeof cr.data === 'string' ? JSON.parse(cr.data) : cr.data) : [];
        db.trail = db.trail || [];
        for (const c of cars) { if (c && c.agvId !== undefined && Number.isFinite(c.x) && Number.isFinite(c.y)) db.trail.push({ ts: nowMs, id: c.agvId, x: Math.round(c.x * 10) / 10, y: Math.round(c.y * 10) / 10, yaw: Math.round((Number(c.yaw) || 0) * 100) / 100 }); }
        const cut = nowMs - 24 * 3600 * 1000;
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
    fs.writeFileSync(f + '.tmp', JSON.stringify({ at: d.toISOString(), items: db.ledger })); fs.renameSync(f + '.tmp', f);
    const all = fs.readdirSync(dir).filter((x) => /^ledger-\d{8}\.json$/.test(x)).sort();
    while (all.length > 90) { const old = all.shift(); try { fs.unlinkSync(path.join(dir, old)); } catch (_) {} }
    console.log('[snap] 每日账本快照 ' + key + '（' + db.ledger.length + ' 条）');
  } catch (e) { console.log('[snap] 失败：', e.message); }
}
setInterval(dailySnap, 30 * 60 * 1000).unref();
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
  } catch (e) { console.log('[export-daily] 失败：', e.message); }
}
setInterval(dailyExport, 30 * 60 * 1000).unref();

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

function buildEvents() {
  // ㉖数据源升级：持久表 carEvents 为主（含恢复/解除等全部历史），运行时旧聚合兜底（迁移前数据）
  const ev = (db.carEvents || []).map((e) => ({ ts: e.ts, kind: e.kind, who: e.who || '', msg: e.msg || '' }));
  const seen = new Set(ev.map((e) => e.ts + '|' + e.kind + '|' + e.who));
  const addOld = (ts, kind, who, msg) => { const k = ts + '|' + kind + '|' + who; if (!seen.has(k)) ev.push({ ts, kind, who, msg }); };
  const last = (db.carEvents || []).length ? (db.carEvents[0].ts || 0) : 0; // carEvents按ts递增追加，首条即最早
  for (const a of db.carAlarms || []) { if (last && a.at < last) break; addOld(a.at, a.kind === 'recover' ? '恢复' : a.kind === 'ack' ? '已认领' : a.kind === 'escalate' ? '升级' : a.kind === 'redflag' ? '红牌' : '告警', a.name || '', a.msg || ''); }
  for (const j of db.rcsJam || []) addOld(j.at || 0, '堵点', 'AGV' + String(j.id).padStart(2, '0'), '交管被卡：' + (j.zone || '') + '（' + (j.lands || '') + '）');
  for (const [id, v] of Object.entries(db.rcsLowBat || {})) { if (v && v.notified) addOld(v.at || 0, '低电', 'AGV' + String(id).padStart(2, '0'), '低电空闲未回充'); }
  ev.sort((a, b) => b.ts - a.ts);
  return ev.slice(0, 800);
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
  pollSec:        { name: 'RCS轮询间隔', unit: '秒', min: 5, max: 300, d: 20, tip: '站台/车辆/任务刷新频率，越小越实时但越吃RCS负载' },
  assignMin:      { name: '指定单超时放开', unit: '分钟', min: 1, max: 240, d: 30, tip: '指定仓管员下单后，超时未接单自动放开给全员' },
  urgeMin:        { name: '催单最小间隔', unit: '分钟', min: 1, max: 120, d: 10, tip: '同一张领料单两次催单的最小间隔，防轰炸' },
  pushMin:        { name: '急料到站催扫', unit: '分钟', min: 1, max: 60, d: 5, tip: '急料框到站台超此时长未扫码→广播全体仓管' },
  urgeScanMin:    { name: '普通到站催扫', unit: '分钟', min: 1, max: 120, d: 10, tip: '普通框到站台超此时长未扫码→催叫车人' },
  jamMin:         { name: '交管堵点告警', unit: '分钟', min: 1, max: 60, d: 3, tip: '车辆被交管卡住超此时长→通知在线仓管' },
  lowBatPct:      { name: '低电阈值', unit: '%', min: 5, max: 80, d: 25, tip: '电量低于此值计入低电观察' },
  lowBatMin:      { name: '低电未回充告警', unit: '分钟', min: 5, max: 240, d: 20, tip: '低电且空闲超此时长未回充→提醒安排充电' },
  batch:          { name: '单轮最多下发', unit: '单', min: 1, max: 8, d: 4, tip: '排队调度器每轮最多真实下发几单（保守节奏）' },
  agingMin:       { name: '排队防饿死升级', unit: '分钟', min: 2, max: 120, d: 10, tip: '普通队列项等待超此时长自动按急料优先级调度' },
  sendTimeoutMin: { name: '下发无回执判失败', unit: '分钟', min: 1, max: 30, d: 5, tip: '下发中超此时长无回执→判失败可重试，防站台封死' },
  staleMin:       { name: '在途超时判定', unit: '分钟', min: 5, max: 240, d: 40, tip: '已下发/移库超此时长未完成→判失败并通知' },
  manualHoldMin:  { name: '人工占台压制', unit: '分钟', min: 1, max: 240, d: 30, tip: '人工标记站台占用后的压制时长，防误叫车撞台' },
  aggMin:         { name: '同类通知聚合窗', unit: '分钟', min: 0, max: 60, d: 5, tip: '同类型通知在此窗口内合并为"等N条"（0=不聚合）' },
  rateMax:        { name: '每人每分钟条数上限', unit: '条', min: 1, max: 50, d: 5, tip: '单人单分钟超此条数→跨类型强制合并防风暴刷屏' },
  nStart:         { name: '夜间静默起(时)', unit: '点', min: 0, max: 23, d: 22, tip: '从该点起非急停类通知进按人缓冲（车辆告警豁免）' },
  nEnd:           { name: '夜间静默止(时)', unit: '点', min: 0, max: 23, d: 6, tip: '到该点发送各自夜间汇总（带原单号可跳转）' },
};
function P() { const o = {}; for (const [k, d] of Object.entries(PARAMS)) { const v = (db.params || {})[k]; o[k] = (typeof v === 'number' && Number.isFinite(v)) ? v : d.d; } return o; }

// ---- ㉕T1 通知治理：同类5分钟静默聚合（并入原条"等N条"）/ 每人每分钟超5条跨类型强制聚合 / 夜间22-6点非急停类按人缓冲，早6点各自一条汇总 ----
const _nq = new Map(); const _nrate = new Map(); let _nightFlushed = '';
const URGENT_TYPES = new Set(['car_alarm']);   // 车辆告警（含急停）永不静默
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
    if (db.notifications.length > 500) db.notifications = db.notifications.slice(-500); // 只留最近500条防膨胀
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
      if (db.notifications.length > 500) db.notifications = db.notifications.slice(-500);
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
const _wseen = new Set(); // 到料通知10分钟聚合去重（内存级，重启即清可接受）
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
    // 预约到料：今日新上账框命中 watchlist
    const wl = db.watchlist || [];
    if (wl.length) {
      const arrived = {}, _abseen = {};
      for (const x of db.ledger || []) { if ((x.t || 0) < t0.getTime()) continue; const p = String(x.p || '').toUpperCase(); if (!p) continue; const kk = p + '|' + boxKeyOf(x); if (_abseen[kk]) continue; _abseen[kk] = 1; arrived[p] = (arrived[p] || 0) + 1; }
      const slot = Math.floor(Date.now() / 600000); // 10分钟窗口
      for (const w of wl) {
        const p = String(w.partNo || '').toUpperCase();
        if (!p || !arrived[p]) continue;
        const lk = p + '|' + w.userId + '|' + slot;
        if (_wseen.has(lk)) continue; _wseen.add(lk);
        if (_wseen.size > 8000) _wseen.clear();
        const user = db.users.find((x) => x.id === w.userId);
        if (!user || !user.enabled) continue;
        notify(w.userId, 'watch_in', `🛒 预约到料：零件 ${p} 今日入库 ${arrived[p]} 框，当前在架 ${post[p] || 0} 框`, '');
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
  } catch (e) { console.log('[stock] 检测异常：', e.message); }
}

function boxKeyOf(x) {
  const pid = String(x.pid || '').toUpperCase();
  if (pid) return 'P|' + pid;
  const l = String(x.l || '').toUpperCase(), p = String(x.p || '').toUpperCase();
  return (l && p) ? 'L|' + l + '|' + p : 'C|' + String(x.c).toUpperCase();
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
// 接单即派：按建议框自动入队（与PDA一键叫车完全同口径：同托合并/已发已叫剔除/仅NB02货架框）；返回入队数
function autoEnqueueOnAccept(r, byName, byId) {
  if (db.autoDispatch === false) return 0; // 全局开关（管理员可在设置关闭）
  db.agvQueue = db.agvQueue || [];
  let n = 0;
  for (const it of r.items || []) {
    const excl = new Set(((it.issued || []).map(x => String(typeof x === 'string' ? x : (x.c || '')).toUpperCase()).filter(Boolean)));
    const sg = pickSuggest(it.partNo, Number(it.qty) || 0, excl, agvMapOf(it));
    for (const bx of sg.boxes) {
      const l = String(bx.l || '').toUpperCase();
      if (!l.startsWith('NB02-') || l.includes('-CK-')) continue; // 只派货架框；地面/已在站台不动
      const code = String((bx.codes && bx.codes[0]) || '').toUpperCase();
      if (!code) continue;
      if (bx.codes.some((c) => db.agvQueue.some((q) => String(q.code).toUpperCase() === String(c).toUpperCase() && !['完成', '取消', '失败'].includes(q.state)))) continue; // 同框已在队
      db.agvQueue.push({ code, fromLoc: l, palletType: String(bx.f || ''), stationManual: '', reqId: r.id, reqNo: r.no, by: byName, state: '排队', rush: !!r.rush, auto: 1, station: '', at: Date.now(), updAt: Date.now() });
      it.agvCalled = (it.agvCalled || []).filter((e) => String(e.c).toUpperCase() !== code);
      it.agvCalled.push({ c: code, s: '', q: 1, by: byId, t: new Date().toISOString() }); // 登记叫车标记（建议区变🚗排队）
      n++;
    }
  }
  if (n) console.log(`[auto派] ${r.no} 接单即派入队 ${n} 框`);
  return n;
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
      let arr = Object.values(db.scanlog).sort((a, x) => (x.t || 0) - (a.t || 0));
      if (fc) arr = arr.filter(x => String(x.code).toUpperCase() === fc);
      if (fpn) arr = arr.filter(x => String(x.pn || '').toUpperCase() === fpn); // ㉖B7 零件号过滤
      if (fft || ftt) arr = arr.filter(x => (!fft || (x.t || 0) >= fft) && (!ftt || (x.t || 0) <= ftt)); // ㉖B7 时间窗
      return send(res, 200, { ok: true, at: db.scanlogAt, total: db.scanlogCount, count: arr.length, items: arr.slice(0, lim) });
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
      let list = db.ledger;
      if (fz) list = list.filter(x => String(x.c).toUpperCase().includes(fz) || String(x.l).toUpperCase().includes(fz) || String(x.p || '').toUpperCase().includes(fz) || String(x.n || '').toUpperCase().includes(fz));
      if (fc) list = list.filter(x => String(x.c).toUpperCase().startsWith(fc));
      if (fl) list = list.filter(x => String(x.l).toUpperCase().startsWith(fl));
      return send(res, 200, { ok: true, rev: db.ledgerRev, at: db.ledgerAt, by: db.ledgerBy, total: db.ledger.length, count: list.length, items: list, tomb: db.ledgerTomb || [] });
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
      if (!u || hashPw(password, u.salt) !== u.passHash) { failRecord(username); return send(res, 401, { ok: false, msg: '账号或密码错误' }); }
      if (!u.enabled) return send(res, 403, { ok: false, code: 'disabled', msg: '账号已被停用，请联系管理员' });
      const token = newToken();
      db.sessions[token] = { userId: u.id, createdAt: Date.now(), lastSeen: Date.now(), fp: clientFp(req) }; // ㉕F6 token绑设备指纹(IP前两段+UA)
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
        return send(res, 200, { ok: true, user: safeUser(u), features: db.features[u.role] || {}, prefs: prefsFor(u.id), serverTime: new Date().toISOString() });
      }

      // 修改自己的密码
      if (req.method === 'POST' && p === '/api/change_password') {
        const b = await readBody(req);
        if (hashPw(String(b.oldPassword || ''), u.salt) !== u.passHash) return send(res, 400, { ok: false, msg: '原密码错误' });
        if (String(b.newPassword || '').length < 6) return send(res, 400, { ok: false, msg: '新密码至少6位' });
        u.salt = crypto.randomBytes(16).toString('hex');
        u.passHash = hashPw(b.newPassword, u.salt);
        u.mustChangePw = false;
        pushOps(u, '改自己密码', u.username, '');
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
            p: String((it && it.p) || '').slice(0, 40), n: String((it && it.n) || '').replace(/\uFFFD/g, '').slice(0, 80), // ㉓乱码清洗
            q: Number(it && it.q) || 0, b: String((it && it.b) || '').slice(0, 40), pid: String((it && it.pid) || '').slice(0, 40),
            mv: String((it && it.mv) || '').slice(0, 10), src: String((it && it.src) || '').slice(0, 40) });
        }
        // 增量合并：按标签号 upsert + 墓碑删除，多PDA互不覆盖
        // ㉔S1 时间戳双轨（F2加固）：指纹=登记时刻+内容（含t）；"无新到达"=与本机上次推送一致(含已删行的旧副本)
        // 或与服务器现值完全一致(首拉旧副本重放)——一律不动服务器；真改动(内容/t变)按到达时刻rec裁决，墓碑按t拦截早于它的重登
        const rec0 = Date.now(); const _diffs = []; // ㉖方案4.2：服务器diff自动留痕（谁把X从A改到B，字段级前值→后值）
        const _preCounts = partBoxCounts(); // ⑮合并前在架快照（断料检测基线）
        const cur = new Map(db.ledger.map(x => [String(x.c).toUpperCase(), x]));
        const tomb = new Map((db.ledgerTomb || []).map(x => [String(x.c).toUpperCase(), { t: Number(x.t) || 0, rec: Number(x.rec) || 0 }]));
        const histAll = (db.tombHist = db.tombHist || {});
        const seenNew = new Set(); // 本次合并真正新增上账的标签（急货入库提醒用）
        const dels = Array.isArray(b.del) ? b.del : [];
        const _fpAll = (db.syncFp = db.syncFp || {}); const _fpOld = _fpAll[u.id] || {}; const _fpNew = {};
        const _hash = ledgerHash;
        let added = 0, updated = 0, skipped = 0, kept = 0, delApplied = 0, delSkipped = 0; const rejected = []; // ⑲被更新的服务器数据压回的标签（冲突提示用）
        for (const it of clean) {
          const key = it.c;
          const old = cur.get(key);
          const tm = tomb.get(key);
          const tombT = tm ? tm.t : 0;
          const h = _hash(it);
          // 无新到达闸：①与本机上次视图一致（未来时钟的旧副本重放也在这挡死）②与服务器现值逐字段一致（首拉后原样重放）
          // ③命中该行服务器历史值（本机从未推过该行的旧快照回填——PDA真改动必更新t，旧( t,h )组合只可能是过期副本）
          if (_fpOld[key] === h || (old && _hash(old) === h) || (old && (old.hist || []).some((e) => e.t === (Number(it.t) || 0) && e.h === h))) { _fpNew[key] = h; kept++; continue; }
          if (tombT && it.t > 0 && it.t < tombT) { skipped++; rejected.push(key); continue; } // 早于墓碑的真改动重登：作废（不记指纹，持续提示冲突待拉取）
          if (!_fpOld[key] && !Object.keys(_fpOld).length && old && it.t > 0 && Number(old.t) > it.t) { skipped++; rejected.push(key); continue; } // 设备首推无指纹档案：保守回退旧规则（t更旧者拒），防服务重启窗口倒退
          _fpNew[key] = h; // 本轮该设备视图留档
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
          const hist = histAll[c];
          if (hist && hist.t === t && old && (Number(old.rec) || 0) >= hist.rec && (Number(old.t) || 0) >= t) { delSkipped++; continue; } // 删除后又被别机重登：旧墓碑重放不二次删除
          const base = Math.max(tm ? tm.t : 0, old ? (Number(old.rec) || Number(old.t) || 0) : 0);
          if (!tm && (!old || t > base)) { cur.delete(c); tomb.set(c, { t, rec: rec0 }); if (!hist || hist.t !== t) histAll[c] = { t, rec: rec0 }; delApplied++; _diffs.push(c + ' 消位' + (old ? '(原' + old.l + ')' : '')); } else if (!tm) delSkipped++; // 别台后续又登记→删除作废
          else { tomb.set(c, { t: tm.t, rec: tm.rec }); delSkipped++; }
        }
        if (!cur.size && !tomb.size && !dels.length) return send(res, 400, { ok: false, msg: '无有效条目（需 c=标签 且 l=货位）' });
        db.ledger = [...cur.values()];
        db.ledgerTomb = [...tomb.entries()].map(([c, v]) => ({ c, t: v.t, rec: v.rec })).sort((a, b2) => b2.t - a.t).slice(0, 20000);
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
        try { pushOps(u, '账本合并diff', 'v' + db.ledgerRev, `+${added} 改${updated} 删${delApplied} 未变${kept} 压回${skipped}${rejected.length ? ' 拒墓碑' + rejected.length : ''}` + (_diffs.length ? ' | ' + _diffs.slice(0, 40).join(' ; ') + (_diffs.length > 40 ? ` ; …共${_diffs.length}项` : '') : '')); save(); } catch (_) {}
        return send(res, 200, { ok: true, rev: db.ledgerRev, count: db.ledger.length, added, updated, kept, skipped, delApplied, delSkipped, rejected: rejected.slice(0, 50) });
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
        const list = Object.values(db.rcsStations || {}).sort((a, b) => a.station.localeCompare(b.station));
        const holdAvg = {}; for (const [k, v] of Object.entries(db.rcsHoldStat || {})) holdAvg[k] = v.n ? Math.round(v.sum / v.n) : 0;
        return send(res, 200, { ok: true, at: db.rcsAt || '', on: !!(db.rcsConfig && db.rcsConfig.host), run: (db.rcsRun || []).length, stations: list, queue: (db.agvQueue || []).filter((q) => !['完成', '取消'].includes(q.state)), mode: db.agvDispatchMode || 'dry', holdAvg, cfgRev: db.cfgRev || 0 });
      }
      // ===== ① 2D实时地图快照：路网(缓存)+车辆(实时)+货架占用(账本)+站台(判定)+交管锁点 =====
      if (req.method === 'GET' && p === '/api/rcs/net') {
        const lands = {}; for (const [k, v] of Object.entries(NetMap.lands)) lands[k] = { x: v.x, y: v.y, r: v.r, t: v.t };
        const edges = []; for (const [a, list] of Object.entries(NetMap.adj)) for (const [b] of list) if (a < b || NetMap.adj[b] === undefined || !NetMap.adj[b].some((e2) => e2[0] === a)) edges.push([a, b]);
        return send(res, 200, { ok: true, ready: NetMap.ready(), lands, edges });
      }
      if (req.method === 'GET' && p === '/api/rcs/map') {
        const tk = (db.rcsToken && Date.now() < (db.rcsTokenExp || 0)) ? db.rcsToken : await rcsLogin();
        let cars = [];
        if (tk) { try { const cr = await rcsReq('/uds/car/getCarInfoList', 'GET', tk); cars = typeof cr.data === 'string' ? JSON.parse(cr.data) : (cr.data || []); } catch (_) {} }
        const locOf = (lc) => NetMap.landLoc[String(lc)] || '';
        // 货架占用：landmark → {loc, codes}
        const byLoc = {};
        for (const x of db.ledger || []) { const l = String(x.l || '').toUpperCase(); (byLoc[l] = byLoc[l] || []).push(x.c); }
        const shelf = [];
        for (const [loc, codes] of Object.entries(byLoc)) { const lc = NetMap.landOf(loc); if (lc && NetMap.lands[lc]) shelf.push({ land: lc, loc, n: codes.length }); }
        const stn = [];
        for (const [loc, lc] of Object.entries(NetMap.locLand)) { // 全量站台：从路网映射取所有CK货位，状态缺省空闲
          if (!/-CK-/.test(loc) || !NetMap.lands[lc]) continue;
          const s = (db.rcsStations || {})[loc];
          stn.push({ land: lc, code: loc, state: s ? s.state : '空闲' });
        }
        stn.sort((a, b) => a.code.localeCompare(b.code));
        const tl = (() => { try { return typeof db.rcsTraffic === 'string' ? JSON.parse(db.rcsTraffic) : (db.rcsTraffic || {}); } catch (_) { return {}; } })();
        const owners = (tl.landmarkLocks && tl.landmarkLocks.landmarkOwners) || {};
        return send(res, 200, {
          ok: true, at: new Date().toISOString(), netReady: NetMap.ready(),
          cars: cars.map((c) => ({ id: c.agvId, name: c.carName, x: c.x, y: c.y, yaw: c.yaw, state: c.carState, task: c.executeTaskNo || '', site: locOf(c.currentSite) || String(c.currentSite || ''), online: c.communicationBreak !== true && c.enable === 1 })),
          shelf, stations: stn,
          jam: Object.entries(owners).map(([land, car]) => ({ land, car })).filter((j) => NetMap.lands[j.land]),
        });
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
          db.agvQueue.push({ code, fromLoc, palletType: String(it.palletType || ''), stationManual: String(it.stationManual || '').trim().toUpperCase(), reqId, reqNo, by: u.name, state: '排队', rush: !!(rq && rq.rush), station: '', at: Date.now(), updAt: Date.now() });
          const ti = rq && (rq.items || []).find((i) => i.partNo === it.partNo); // 登记叫车标记：建议区变🚗排队，单框叫车自动跳过
          if (ti) { ti.agvCalled = (ti.agvCalled || []).filter((e) => String(e.c).toUpperCase() !== code); ti.agvCalled.push({ c: code, s: '', q: 1, by: u.id, t: new Date().toISOString() }); }
          added++;
        }
        save(); rcsPoll(); // 立即调度一轮
        return send(res, 200, { ok: true, added, dup, conflict, msg: `已排队 ${added} 框${dup ? `（${dup} 框已在队列跳过）` : ''}${conflict ? `（${conflict} 框因移库占用跳过）` : ''}` });
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
        const spKey = q ? String(q.fromLoc).toUpperCase() : '';
        let task = null;
        if (q && q.wmsTask && db.agvTasks && db.agvTasks[q.wmsTask]) task = { ...db.agvTasks[q.wmsTask], no: q.wmsTask };
        if (!task) { // 时间窗+起点匹配最近一条出库任务
          const lo = q ? (q.at || 0) - 3600000 : Date.now() - 2 * 86400000;
          for (const [no, t] of Object.entries(db.agvTasks || {})) { if (t.ck === 'out' && t.sp === spKey && t.fin >= lo && (!task || t.fin > task.fin)) task = { ...t, no }; }
        }
        if (!task && spKey) { // 在途任务（未沉淀）
          for (const t of db.rcsRun || []) { if (t.sp === spKey) { task = { no: t.no, sp: t.sp, ep: t.ep, ex: t.startAt || 0, pick: t.pickAt || 0, fin: 0 }; break; } }
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
        chain.dispatch = q ? (q.sentAt || 0) : 0;
        if (task) { chain.exe = task.ex || 0; chain.pick = task.pick || 0; chain.arrive = task.fin || 0; }
        if (q && q.state === '完成') chain.cleared = q.updAt || 0;
        return send(res, 200, { ok: true, task: task ? { no: task.no, sp: task.sp, ep: task.ep, car: task.car || null, stateText: stText, tl } : null, queueState: q ? q.state : '', chain });
      }
      if (req.method === 'POST' && p === '/api/agv/queue/cancel') { // 取消排队项；传 reqId 则清空该单全部未下发项
        if (!canFeature(u, 'agv_control')) return send(res, 403, { ok: false, msg: '当前角色未开通「AGV车辆控制」权限' });
        const b = await readBody(req);
        const reqId = String(b.reqId || '').trim();
        const codes = new Set((Array.isArray(b.codes) ? b.codes : []).map((c) => String(c).toUpperCase()));
        if (reqId) {
          let n = 0, dispatched = 0;
          for (const q of db.agvQueue || []) {
            if (String(q.reqId) !== reqId) continue;
            if (q.state === '排队' || q.state === '失败') { q.state = '取消'; q.updAt = Date.now(); clearQueueCall(reqId, q.code); n++; }
            else if (['下发中', '已下发', '到站'].includes(q.state)) dispatched++; // 已进AGV系统，需去RCS取消
          }
          save();
          return send(res, 200, { ok: true, cancelled: n, msg: n ? `已取消 ${n} 框排队${dispatched ? `；另有 ${dispatched} 框已下发AGV，请到RCS调度界面取消任务` : ''}` : (dispatched ? `${dispatched} 框已下发AGV，需在RCS界面取消任务` : '本单没有排队项') });
        }
        let n = 0;
        for (const q of db.agvQueue || []) { if (codes.has(q.code) && (q.state === '排队' || q.state === '失败')) { q.state = '取消'; q.updAt = Date.now(); clearQueueCall(q.reqId, q.code); n++; } }
        save();
        return send(res, 200, { ok: true, cancelled: n });
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
        for (const x of db.ledger || []) { touch(String(x.p || '').toUpperCase(), x.n); if (x.p) m[String(x.p).toUpperCase()].n++; }
        for (const st of Object.values(db.scanlog || {})) touch(String(st.pn || '').toUpperCase(), st.nm);
        for (const o of Object.values(db.outbound || {})) for (const i of (o.items || [])) touch(String(i.code || '').toUpperCase(), i.name);
        if (db.itemDict) for (const [pn, dd] of Object.entries(db.itemDict)) touch(String(pn).toUpperCase(), dd && dd.nm);
        let ks = Object.keys(m);
        if (q) ks = ks.filter((k) => k.includes(q) || String(m[k].nm || '').toUpperCase().includes(q));
        ks.sort((a, b) => (m[b].n || 0) - (m[a].n || 0) || a.localeCompare(b));
        return send(res, 200, { ok: true, list: ks.slice(0, 40).map((k) => ({ pn: k, nm: m[k].nm, n: m[k].n })) });
      }
      if (req.method === 'GET' && p === '/api/part/profile') {
        const pn = String(url.searchParams.get('pn') || '').trim().toUpperCase();
        if (!pn) return send(res, 400, { ok: false, msg: '缺少 pn' });
        const bm = {};
        for (const x of db.ledger || []) {
          if (String(x.p || '').toUpperCase() !== pn) continue;
          const k = boxKeyOf(x); const e = (bm[k] = bm[k] || { tags: [], locs: {}, q: 0, nm: '', last: 0 });
          e.tags.push(x.c); e.locs[String(x.l || '').toUpperCase()] = 1; e.q = Math.max(e.q, Number(x.q) || 0); e.last = Math.max(e.last, Number(x.t) || 0);
          if (!e.nm && x.n) e.nm = String(x.n).slice(0, 80);
        }
        const boxes = Object.values(bm).map((b) => ({ loc: Object.keys(b.locs)[0] || '', tags: b.tags, q: b.q, last: b.last })).sort((a, x) => x.last - a.last);
        const qty = boxes.reduce((a, b) => a + b.q, 0);
        const _sl = Object.values(db.scanlog || {}).filter((st) => String(st.pn || '').toUpperCase() === pn).sort((a, x) => (x.t || 0) - (a.t || 0));
        const inb = _sl.slice(0, 60).map((st) => ({ t: Number(st.t) || 0, code: st.code, q: Number(st.q) || 0, lot: st.lot || '', loc: (st.wt === 0 ? st.st : st.gl) || '', op: st.op || '', cx: !!st.cx }));
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
      if (req.method === 'GET' && p === '/api/watchlist') {
        return send(res, 200, { ok: true, list: (db.watchlist || []).filter((w) => w.userId === u.id) });
      }
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
          const rr = runBy[String(q.taskNo || '')] || null;
          let stage;
          if (q.state === '排队') stage = 1;
          else if (stageOfCode[code]) stage = stageOfCode[code];
          else if (rr && rr.pickAt) stage = 4;                          // RCS已叉出货架、还没落进站台状态
          else if (q.state === '下发中' || q.state === '已下发') stage = rr ? 3 : 2; // 任务在RCS=叉取中；未同步到=AGV已接单
          else stage = 2;
          stages[stage - 1].push({ code, from: q.fromLoc || q.from || '', to: q.station || (rr ? (rr.ep || '') : ''), car: rr ? 'AGV' + String(rr.car || '').padStart(2, '0') : '', waitMs: Math.max(0, nowMs - (q.at || nowMs)), reqNo: q.reqNo || '', state: q.state, rush: !!q.rush });
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
          const cols = (d.headers || []).length;
          const cells = d.rows.slice(0, 20).map((r) => r.map((v) => String(v === undefined || v === null ? '' : v).slice(0, 40)));
          const flat = d.rows.reduce((s, r) => s + r.reduce((a, v) => a + String(v === undefined || v === null ? '' : v).length + 1, 0), 0);
          return send(res, 200, { ok: true, label: d.label, total: d.total, cols, head: d.headers, sample: cells, estBytes: flat });
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
        const cut = Date.now() - 8 * 3600 * 1000;
        const out = {}; for (const [k, a] of Object.entries(db.stnTl || {})) { const seg = a.filter((x) => x.t >= cut); if (seg.length) out[k] = seg; }
        return send(res, 200, { ok: true, tl: out });
      }
      if (req.method === 'GET' && p === '/api/agv/trail') {
        const mins = Math.min(1440, Math.max(5, parseInt(url.searchParams.get('mins') || '360') || 360));
        const cut = Date.now() - mins * 60000;
        return send(res, 200, { ok: true, points: (db.trail || []).filter((p) => p.ts >= cut) });
      }
      if (req.method === 'GET' && p === '/api/dict') {
        const q = (url.searchParams.get('q') || '').trim().toUpperCase();
        let list = Object.entries(db.itemDict || {}).map(([pn, v]) => ({ pn, nm: v.nm, src: v.src }));
        if (q) list = list.filter((x) => x.pn.includes(q) || x.nm.toUpperCase().includes(q));
        list.sort((a, b) => a.pn.localeCompare(b.pn));
        return send(res, 200, { ok: true, total: list.length, list: list.slice(0, 300) });
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
      if (req.method === 'POST' && p === '/api/watchlist') {
        const b = await readBody(req);
        const pn = String(b.partNo || '').trim().toUpperCase().slice(0, 40);
        if (!pn) return send(res, 400, { ok: false, msg: '缺少 partNo' });
        db.watchlist = db.watchlist || [];
        if (b.on === false) { db.watchlist = db.watchlist.filter((w) => !(w.userId === u.id && w.partNo === pn)); }
        else if (!db.watchlist.some((w) => w.userId === u.id && w.partNo === pn)) {
          if (db.watchlist.length > 3000) return send(res, 400, { ok: false, msg: '预约条目已满，请先清理' });
          db.watchlist.push({ userId: u.id, partNo: pn, at: Date.now() });
        }
        save();
        return send(res, 200, { ok: true });
      }
      if (req.method === 'GET' && p === '/api/ground-slots') {
        return send(res, 200, { ok: true, slots: db.groundSlots || {} });
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
        const _cr = cfgBump();
        save();
        pushOps(u,'改格数配置','','地面排格数已更新');
        return send(res, 200, { ok: true, cfgRev: _cr, slots: db.groundSlots });
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
        const item = { type: 'transfer', kind: kind, from: from, to: to, palletType: palletType, code: srcBox.c, boxKey: srcBox.p || '', state: '下发中', by: u.name, at: Date.now(), updAt: Date.now() };
        db.agvQueue = db.agvQueue || []; db.agvQueue.push(item);
        const r = await wmasDispatchOne({ fromLoc: from, palletType: palletType }, tk, { from: from, to: to, pallet: palletType, ref: 'YK-' + (item.code || '') });
        item.state = r.ok ? '已下发' : '失败'; item.taskNo = r.taskNo || ''; item.err = r.ok ? '' : r.msg; item.updAt = Date.now();
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
        if (item.taskNo) { const tk = await wmasToken(); if (tk) { try { await wmasHttp('POST', '/api/logistics/agv-task/cancel', tk, { taskNos: [item.taskNo] }); } catch (_) {} } }
        item.state = '取消'; item.updAt = Date.now(); save();
        return send(res, 200, { ok: true, msg: '已请求取消（若WMAS已叉出则无法撤回，需人工处理）' });
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
      if (req.method === 'GET' && p === '/api/prefs') {
        return send(res, 200, { ok: true, prefs: prefsFor(u.id), templates: (db.prefTemplates || []).map((t) => ({ name: t.name, by: t.by })) });
      }
      if (req.method === 'POST' && p === '/api/prefs') {
        const b = await readBody(req); const mine = (db.prefs[u.id] = db.prefs[u.id] || {});
        if (b.landing !== undefined) mine.landing = { v: String(b.landing || '').slice(0, 20), at: Date.now() };
        if (b.theme !== undefined) mine.theme = { v: b.theme === 'dark' ? 'dark' : '', at: Date.now() }; // ㉕丙6 主题上云（空=浅色）
        if (Array.isArray(b.kpi)) mine.kpi = { v: b.kpi.slice(0, 30).map((x) => String(x).slice(0, 14)), at: Date.now() };
        if (b.notes && typeof b.notes === 'object') { const nn = {}; for (const t2 of ['req_new', 'req_urge', 'req_arrive', 'req_flow', 'watch_in', 'stock_out']) nn[t2] = b.notes[t2] !== false; mine.notes = { v: nn, at: Date.now() }; }
        if (b.work !== undefined) mine.work = { v: Number(b.work) === 1 ? 1 : 0, at: Date.now() }; // ㉖B14 PDA工作模式上云（0=AGV站台 1=人工地面）
        if (b.rate !== undefined) { const rr = Number(b.rate); if (Number.isFinite(rr)) mine.rate = { v: Math.min(0.9, Math.max(0.3, rr)), at: Date.now() }; } // ㉖B14 播报语速上云
        if (b.voice !== undefined) mine.voice = { v: b.voice !== false, at: Date.now() }; // ㉖B14 扫码播报开关上云
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
        const two = fsn.slice(-2); if (two.length < 2) return send(res, 200, { ok: true, days: two, msg: '快照不足两份，无法对比' });
        const A = pick(two[0]), B = pick(two[1]); if (!A || !B) return send(res, 500, { ok: false, msg: '快照读取失败' });
        const ma = {}, mb = {}; for (const x of A.items || []) ma[String(x.c).toUpperCase()] = x; for (const x of B.items || []) mb[String(x.c).toUpperCase()] = x;
        const ghosts = [], evap = [], moved = [], qtyCh = [];
        for (const [c, x] of Object.entries(mb)) { if (!ma[c]) { const pn = String(x.p || '').toUpperCase(); ghosts.push({ c, loc: x.l, pn, nm: x.n || (db.itemDict && db.itemDict[pn] && db.itemDict[pn].nm) || '', q: x.q || 0, by: x.by || '', at: x.t ? new Date(x.t).toLocaleString('zh-CN', { hour12: false }).slice(5, 16) : '' }); } }
        for (const [c, x] of Object.entries(ma)) { if (!mb[c]) { const t = x.t ? new Date(x.t).toLocaleString('zh-CN', { hour12: false }).slice(5, 16) : ''; evap.push({ c, loc: x.l, p: x.p || '', q: x.q || 0, reg: t }); } else { const y = mb[c]; if (String(y.l).toUpperCase() !== String(x.l).toUpperCase()) moved.push({ c, from: x.l, to: y.l, by: y.by || '' }); if ((Number(y.q) || 0) !== (Number(x.q) || 0)) qtyCh.push({ c, loc: y.l, a: x.q || 0, b: y.q || 0 }); } }
        return send(res, 200, { ok: true, days: [two[0].slice(7, 15), two[1].slice(7, 15)], ghosts, evap, moved, qtyCh, noteA: '幽灵框=后份快照新出现（未采集直接上账），建议补采', noteB: '蒸发框=前份有后份无且无出库流水佐证，优先人工核实' });
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
        // 今日AGV：领料单 agvCalled 时间戳在今天
        let agvToday = 0;
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
        let stnTotal = Object.keys(NetMap.locLand || {}).filter((loc) => /-CK-/.test(loc)).length; if (!stnTotal) stnTotal = 12; // 分母=地图全量CK站台，路网未就绪时兜底
        const queueNow = (db.agvQueue || []).filter((q) => ['排队', '下发中', '已下发'].includes(q.state)).length;
        return send(res, 200, { ok: true, at: new Date().toISOString(),
          kpi: { inBoxes, inQty, outToday: (db.ledgerTomb || []).filter((x) => x.t >= todayStart).length, agvToday, agvQueue: queueNow,
            stockBoxes: db.ledger.length, stockLocs: locs.size, pending: st.pending, accepted: st.accepted, ready: st.ready, stnBusy, stnTotal },
          trend: Array.from({ length: 7 }, (_, i) => ({ d: dstr(todayStart + i * dayMs), in: trendIn[i], out: trendOut[i] })) });
      }
      // ================= ⑦ AGV效率报表（只读聚合 db.agvTasks，登录可看；days=1~30） =================
      if (req.method === 'GET' && p === '/api/agv/report') {
        const days = Math.min(30, Math.max(1, parseInt(url.searchParams.get('days') || '7') || 7));
        const since = Date.now() - days * 86400000;
        const tasks = Object.values(db.agvTasks || {}).filter((t) => (t.fin || 0) >= since);
        const byCar = {}; // 车号 → {n,durSum,out,in}
        const heat = Array.from({ length: 7 }, () => Array(24).fill(0)); // 近7日×24h 任务热力
        const dayBase = new Date(); dayBase.setHours(0, 0, 0, 0); dayBase.setDate(dayBase.getDate() - 6);
        for (const t of tasks) {
          const b = (byCar[t.car] = byCar[t.car] || { n: 0, durSum: 0, out: 0, in: 0 });
          b.n++; if (t.dur) b.durSum += t.dur; if (t.ck === 'out') b.out++; else if (t.ck === 'in') b.in++;
          const di = Math.floor((t.fin - dayBase.getTime()) / 86400000), hr = new Date(t.fin).getHours();
          if (di >= 0 && di < 7 && hr >= 0 && hr < 24) heat[di][hr]++;
        }
        const cars = Object.entries(byCar).map(([id, v]) => ({ car: Number(id), n: v.n, out: v.out, in: v.in, avgDur: v.n && v.durSum ? Math.round(v.durSum / v.n) : 0 }))
          .sort((a, b) => b.n - a.n);
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
          return send(res, 200, { ok: true, has: fs.existsSync(APP_APK), ...v, size: fs.existsSync(APP_APK) ? fs.statSync(APP_APK).size : 0 });
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
        if (!fs.existsSync(APP_APK)) return send(res, 404, { ok: false, msg: '尚无上传APK' });
        const st = fs.statSync(APP_APK);
        res.writeHead(200, { 'Content-Type': 'application/vnd.android.package-archive', 'Content-Length': st.size, 'Content-Disposition': 'attachment; filename="app-release.apk"' });
        fs.createReadStream(APP_APK).pipe(res);
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
        db.outbound[no] = { orderNo: no, createdAt: Number(b.createdAt) || 0, toLoc: String(b.toLoc || ''), operator: String(b.operator || ''), status: Number(b.status) || 0, linkReqNo: String(b.linkReqNo || ''), items: Array.isArray(b.items) ? b.items : [] };
        for (const e of (db.outbound[no].items || [])) feedDict(e.code, e.name, '出库单'); // ㉒G7 字典沉淀
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
            assignOpenAt: assignee ? new Date(now.getTime() + P().assignMin * 60000).toISOString() : '',
            rush: b.rush === true, // 急料：调度优先插队+催扫5分钟广播
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

        // 状态动作：/:id/accept|reject|scan|transfer|skip|loc|confirm|cancel|reassign|agv|rush
        const mAct = p.match(/^\/api\/requisitions\/([\w-]+)\/(accept|reject|scan|transfer|skip|loc|confirm|cancel|reassign|agv|rush|urge|delitem|ready|back)$/);
        if (req.method === 'POST' && mAct) {
          const r = findReq(mAct[1]);
          if (!r) return send(res, 404, { ok: false, msg: '领料单不存在' });
          const act = mAct[2];
          const b = await readBody(req);
          const hpush = (text) => { r.history.push({ time: new Date().toISOString(), by: u.name, text }); };
          // issued 统一为 [{c:标签, q:件数}]，兼容旧数据纯字符串（按0件计）
          const normIssued = (i) => (i.issued || []).map(x => typeof x === 'string' ? { c: x, q: 0 } : Object.assign({ c: String(x.c || ''), q: Number(x.q) || 0 }, x.e ? { e: 1, by: x.by || '', why: x.why || '' } : {}));
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
            const em = b.emergency === true;
            target.issued.push(Object.assign({ c: code, q, l: String(b.fromLoc || '').trim().toUpperCase() }, em ? { e: 1, by: u.name, why: String(b.why || '').trim() } : {}));
            const got = issuedQty(target);
            hpush(`${em ? '⚠️应急发料' : '发料'} ${b.partNo} 标签 ${code}（${q}件，累计 ${got}/${target.qty}）${em ? ' · MES不可用改人工录入（' + u.name + (String(b.why || '').trim() ? '：' + String(b.why || '').trim() : '') + '）' : ''}`);
            const ff = b.fifo; if (ff && ff.ok) pushEvent('FIFO违反', String(b.partNo || ''), `标签 ${code} 扫入批次${String(ff.lot || '')}（最早${String(ff.oldest || '')}）人工确认继续（${u.name}）`);
            const ff2 = b.fifo; if (ff2 && ff2.ok) hpush(`🟡FIFO违反 ${b.partNo} 标签 ${code} 扫入批次${String(ff.lot || '')}（最早${String(ff.oldest || '')}）人工确认继续（${u.name}）`);
            // 不再自动置 ready：ready 由每行 transfer/skip 到终态后 finalize 决定
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
            for (const q of db.agvQueue || []) { if (String(q.reqId) === r.id && q.state === '排队') q.rush = r.rush; }
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
              r.status = 'ready';
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
            // 联动：该单未下发的AGV排队项一并取消；已下发的只能去RCS取消任务
            let qn = 0, qd = 0;
            for (const q of db.agvQueue || []) {
              if (String(q.reqId) !== r.id) continue;
              if (q.state === '排队' || q.state === '失败') { q.state = '取消'; q.updAt = Date.now(); qn++; }
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
      if (req.method === 'GET' && p === '/api/admin/params') {
        const cur = P();
        const items = Object.entries(PARAMS).map(([k, d]) => ({ k, name: d.name, unit: d.unit, min: d.min, max: d.max, def: d.d, val: cur[k], tip: d.tip, set: (db.params || {})[k] !== undefined }));
        return send(res, 200, { ok: true, items, cfgRev: db.cfgRev || 0 });
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
        return send(res, 200, { ok: true, total: list.length, persons, list: list.slice(0, lim) });
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
        return send(res, 200, { ok: true, score, items, uptimeMin: upMin, memMB: mem, bkAgeSec: bkAge, queueWait, ledAgeSec: ledAge, netReady, dbMB, saveMaxMs: _saveStat.max, saveAvgMs: _saveStat.avg, saveCount: _saveStat.n, sessions: Object.keys(db.sessions || {}).length });
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

      if (req.method === 'POST' && p === '/api/apk/upload') {
        const version = String(url.searchParams.get('version') || '').trim();
        const build = parseInt(url.searchParams.get('build') || '0', 10);
        if (!/^\d+\.\d+\.\d+$/.test(version) || !(build >= 1)) { req.resume(); return send(res, 400, { ok: false, msg: 'version需x.y.z且build≥1' }); }
        const dir = path.join(DATA_DIR, 'app'); fs.mkdirSync(dir, { recursive: true });
        const tmp = path.join(dir, 'upload.tmp'), fin = path.join(dir, 'app-release.apk');
        const ws = fs.createWriteStream(tmp); let size = 0, aborted = false;
        req.on('data', (c) => { size += c.length; if (size > 60 * 1048576) { aborted = true; ws.close(); try { fs.unlinkSync(tmp); } catch (_) {} req.destroy(); } });
        req.pipe(ws);
        ws.on('finish', () => {
          if (aborted || size < 1000) { try { fs.unlinkSync(tmp); } catch (_) {} return send(res, 400, { ok: false, msg: aborted ? '超过60MB上限' : '空文件' }); }
          try { fs.renameSync(tmp, fin); fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ version, build, size, at: new Date().toISOString() }, null, 2)); }
          catch (e) { return send(res, 500, { ok: false, msg: '落盘失败:' + e.message }); }
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
setInterval(netmapRefresh, 10 * 60 * 1000).unref();

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
      delete db.rcsStations[stn]; db.rcsDone[stn + '|' + (s.via || '')] = nowMs;
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
  db.rcsRun = runT.map(t => ({ no: t.dispatchNo, state: t.taskState, car: t.exeAgvId ?? 0, start: t.executeTaskNo ? 1 : 0, ...parsePts(t), ...nodeTimes(t) }));
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
      const msg = `⏰ ${rush ? '🔥急料' : ''}到站催扫：框 ${cl.c} 已到站台 ${stn} 超${rush ? P().pushMin : P().urgeScanMin}分钟未扫码发料（领料单 ${cl.req.no}），请尽快清台`;
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
  agvDispatch(nowMs, runT).catch((e) => console.log('[agv-q] 调度异常', e.message)); // 排队调度：空闲站台→按队列下发
  lowBatWatch(tk, nowMs).catch(() => {}); // ④D 低电不归巢看门狗
  carAlarmWatch(tk, nowMs).catch(() => {}); // ⑱ 车辆告警边沿检测→通知仓管
  try { dispatchWatchdog(nowMs); } catch (_) {}
  save();
  try { sseTick(nowMs); } catch (_) {} // ㉔SSE广播+轨迹/甘特采样
}
let _rcsTimer = null;
function startRcsTimer() { if (_rcsTimer) clearInterval(_rcsTimer); _rcsTimer = setInterval(() => { rcsPoll().catch(e => console.log('[rcs] 轮询异常', e.message)); }, P().pollSec * 1000); if (_rcsTimer.unref) _rcsTimer.unref(); console.log('[rcs] 轮询间隔=' + P().pollSec + '秒'); }
startRcsTimer();

// ================= AGV 出库排队调度（一键叫车→8站台自动分配→空闲即下发；入库优先） =================
// 站台空闲=无有货/占用、无在途任务指向(含入库)、未被人工占用30分钟、未被队列占用；出库任务随时可排队，站台空了才下发。
// 下发走 WMAS（与人工叫车同通道同参数）；容器编码自动取该托盘类型下未被在途任务占用的第一个。
// 模式 db.agvDispatchMode：'dry'(默认，只演算记 plan 不真发) / 'live'(真下发)。PDA 设置页切换。
const AGV_STNS = Array.from({ length: 8 }, (_, i) => 'NB02-CK-' + String(i + 5).padStart(2, '0'));
function agvStationFree(stn, nowMs, runT, assigned) {
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
async function wmasToken() {
  if (_wmasTk && Date.now() - _wmasTkAt < 10 * 3600 * 1000) return _wmasTk;
  const cfg = db.wmasConfig || {}; if (!cfg.account || !cfg.pwd) return '';
  const r = await wmasHttp('POST', '/api/auth/login', null, { username: cfg.account, password: cfg.pwd });
  if (wmasOk(r) && r.data && r.data.token) { _wmasTk = r.data.token; _wmasTkAt = Date.now(); return _wmasTk; }
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
async function wmasDispatchOne(q, tk, ov) { const from = (ov && ov.from) || q.fromLoc; const to = (ov && ov.to) || q.station; const pallet = (ov && ov.pallet) || q.palletType; const ref = (ov && ov.ref !== undefined) ? ov.ref : (q.reqNo || "");
  // 容器自动选号：优先挑"近30分钟无在途任务"的号；挑不到就复用（与人工叫车同款行为——WMAS不强校验容器号唯一，复用不影响叉货）
  const cr = await wmasHttp('GET', '/api/logistics/container/list?pageNum=1&pageSize=1000', tk);
  if (!wmasOk(cr)) return { ok: false, msg: '查容器主档失败：' + JSON.stringify(cr).slice(0, 80) };
  const t = String(pallet || '').toUpperCase();
  const cands = ((cr.data && cr.data.records) || []).map((x) => String(x.containerCode || '')).filter((c) => t && c.toUpperCase().includes(t)).sort();
  if (!cands.length) return { ok: false, msg: `容器主档无「${q.palletType}」类型编码，请人工叫车` };
  const nowMs = Date.now();
  const used = new Set();
  for (const st of ['PUSHED', 'DISPATCHED', 'IN_TRANSIT']) {
    const lr = await wmasHttp('GET', `/api/logistics/agv-task/list?pageNum=1&pageSize=100&status=${st}`, tk);
    if (wmasOk(lr)) for (const x of ((lr.data && lr.data.records) || [])) {
      if (!x.containerNo) continue;
      const ts = Date.parse(String(x.creationDate || '').replace(' ', 'T'));
      if (Number.isFinite(ts) && nowMs - ts > 30 * 60 * 1000) continue; // 30分钟前的PUSHED多为未关闭历史单，不算占用
      used.add(String(x.containerNo));
    }
  }
  const cn = cands.find((c) => !used.has(c)) || cands[0];
  const s = await wmasLocOf(from), e = await wmasLocOf(to);
  if (!s || !e) return { ok: false, msg: '库位不在WMAS主档：' + from + '/' + to };
  const mk = await wmasHttp('POST', '/api/logistics/agv-task', tk, { taskType: 'CARRY', warehouse: s.wh, startArea: s.zone, startPoint: from, endArea: e.zone, endPoint: to, containerNo: cn, refNo: ref });
  if (!wmasOk(mk)) return { ok: false, msg: '建任务失败：' + ((mk && (mk.message || mk.msg)) || '无响应') };
  let id = mk.data && mk.data.id;
  let wmsTask = (mk.data && mk.data.taskNo) || '';
  if (!id || !wmsTask) { const q2 = await wmasHttp('GET', `/api/logistics/agv-task/list?pageNum=1&pageSize=3&containerNo=${encodeURIComponent(cn)}`, tk); const recs = (q2 && q2.data && q2.data.records) || []; if (recs.length) { id = id || recs[0].id; wmsTask = wmsTask || String(recs[0].taskNo || ''); } }
  if (id) await wmasHttp('POST', '/api/logistics/agv-task/dispatch', tk, { ids: [id] });
  return { ok: true, container: cn, taskNo: wmsTask, msg: '已建任务并下发' };
}
function clearQueueCall(reqId, code) { // 队列项取消/失败出队 → 解除该框排队叫车标记，允许重新叫车
  const rq = db.requisitions.find((x) => x.id === reqId); if (!rq) return;
  for (const it of rq.items || []) {
    if (it.agvCalled && it.agvCalled.some((e) => e.q && String(e.c).toUpperCase() === code)) {
      it.agvCalled = it.agvCalled.filter((e) => !(e.q && String(e.c).toUpperCase() === code));
    }
  }
}
async function agvDispatch(nowMs, runT) {
  const queue = db.agvQueue || [];
  // 回收：队列项对应任务已到站/已完成 → 状态跟随（到站后由"有货/催扫/清台"机制接管）
  for (const q of queue) {
    const s = (db.rcsStations || {})[q.station];
    const has = s && Array.isArray(s.codes) && s.codes.map((c) => String(c).toUpperCase()).includes(q.code);
    if (q.state === '下发中') {
      // 下发中超过5分钟无回执（进程中断/异常残留）→ 判失败可重试，防止永久封死该站台
      if (nowMs - (q.updAt || q.at) > P().sendTimeoutMin * 60 * 1000) { q.state = '失败'; q.err = '下发超时未回执，请重新叫车'; q.updAt = nowMs; }
    } else if (q.state === '已下发') {
      if (s && s.state === '有货' && has) q.state = '到站'; // 按标签匹配（容器号尾6位≠RCS任务号尾6位，不能用via比对）
    } else if (q.state === '到站') {
      if (!has) q.state = '完成'; // 该框已不在台上（发走/清台）
    }
  }
  // 失败项保留30分钟供查看原因后自动出队（重新一键叫车即可再入队）；完成/取消保留2小时
  db.agvQueue = queue.filter((q) => {
    const age = nowMs - (q.updAt || q.at);
    if (q.state === '失败') { if (age >= 30 * 60 * 1000) clearQueueCall(q.reqId, q.code); return age < 30 * 60 * 1000; }
    if (['完成', '取消'].includes(q.state)) return age < 2 * 3600 * 1000;
    return true;
  });
  const waiting = db.agvQueue.filter((q) => q.state === '排队');
  const _trf = (db.agvQueue || []).filter(function (x) { return x.type === 'transfer' && !x.dry && ['下发中', '已下发'].includes(x.state) && x.taskNo; });
  if (_trf.length) { const _ttk = await wmasToken(); if (_ttk) { for (const _t of _trf) { try { const _lr = await wmasHttp('GET', '/api/logistics/agv-task/list?pageNum=1&pageSize=5&taskNo=' + encodeURIComponent(_t.taskNo), _ttk); const _rec = (_lr && _lr.data && _lr.data.records || []).find(function (z) { return String(z.taskNo) === String(_t.taskNo); }); if (_rec) { const _st = String(_rec.status || '').toUpperCase(); if (['PUSHED', 'DISPATCHED', 'IN_TRANSIT'].includes(_st)) { /* 仍在途 */ } else if (_st.includes('CANCEL') || _st.includes('REJECT')) { _t.state = '取消'; _t.updAt = nowMs; } else { _t.state = '完成'; _t.updAt = nowMs; const moved = applyTransferLedger(_t); if (!moved) { _t.err = '已到达但账本未自动更新，请用位置登记核对'; } } } else { _t.state = '完成'; _t.updAt = nowMs; _t.err = 'WMAS任务记录已不可查，未自动改账，请核对货位'; } if (nowMs - (_t.sentAt || _t.at) > P().staleMin * 60000) { _t.state = '失败'; _t.err = '超时未完成'; _t.updAt = nowMs; } } catch (_) {} } } }
  if (!waiting.length) return;
  // 置顶最高优先（网页队列控制台）；急料插队；普通项等待超10分钟自动升级（aging防饿死）；同级保持FIFO
  const effRush = (q) => !!q.rush || (nowMs - (q.at || 0) > P().agingMin * 60 * 1000);
  waiting.sort((a, b) => ((b.prio || 0) - (a.prio || 0)) || (effRush(b) ? 1 : 0) - (effRush(a) ? 1 : 0) || (a.at || 0) - (b.at || 0));
  const live = (db.agvDispatchMode || 'dry') === 'live';
  const assigned = [];
  for (const q of waiting) {
    if (live && assigned.length >= P().batch) break; // 一轮最多下发 N 单，保守节奏
    const manual = q.stationManual && agvStationFree(q.stationManual, nowMs, runT, assigned) ? q.stationManual : '';
    // 距离感知：路网可用时选"离货架最近"的空闲台（AGV少跑一米是一米）；缺映射/不可达回退首个空闲台
    let stn = manual;
    if (!stn) {
      const free = AGV_STNS.filter((s) => agvStationFree(s, nowMs, runT, assigned));
      if (free.length) {
        let best = '', bestD = Infinity;
        if (NetMap.ready()) for (const s of free) { const d = NetMap.dist(q.fromLoc, s); if (d >= 0 && d < bestD) { bestD = d; best = s; } }
        stn = best || free[0];
      }
    }
    if (!stn) continue; // 暂无空闲台：继续排队，下轮再看
    assigned.push(stn); q.station = stn; q.updAt = nowMs;
    if (!live) { q.plan = stn; console.log(`[agv-q·演算] 框 ${q.code} ${q.fromLoc} → ${stn}（切live后自动下发）`); continue; }
    q.state = '下发中'; q.sentAt = Date.now(); // 漏斗：记录真实下发时刻
    const tk = await wmasToken();
    if (!tk) { q.state = '失败'; q.err = 'WMAS未配置/登录失败（PDA设置→AGV调度系统同步WMAS账号）'; continue; }
    let r;
    try { r = await wmasDispatchOne(q, tk); } catch (e) { r = { ok: false, msg: '下发异常：' + e.message }; }
    q.state = r.ok ? '已下发' : '失败'; q.taskNo = r.container || ''; q.wmsTask = r.taskNo || ''; q.err = r.ok ? '' : r.msg;
    console.log(`[agv-q] ${q.state} 框 ${q.code} ${q.fromLoc} → ${stn}${r.ok ? ' 容器' + r.container : ' ' + r.msg}`);
  }
}

// ===== ⑲ 出库任务超时兜底：已下发超40分钟仍未到站 → 判失败+通知全体仓管人工核查（对齐移库40分钟机制） =====
function dispatchWatchdog(nowMs) {
  const stale = (db.agvQueue || []).filter((q) => q.type !== 'transfer' && q.state === '已下发' && q.sentAt && nowMs - q.sentAt > P().staleMin * 60 * 1000);
  for (const q of stale) {
    q.state = '失败'; q.err = '下发超' + P().staleMin + '分钟未到站，请人工核查'; q.updAt = nowMs; clearQueueCall(q.reqId, q.code); pushEvent('出库超时', q.code || '', (q.fromLoc || '') + '→' + (q.station || '待分配') + ' 下发超' + P().staleMin + '分钟未到站', nowMs);
    const msg = `⏰ AGV任务超时：框 ${q.code}（${q.fromLoc}→${q.station || '待分配'}）下发超${P().staleMin}分钟未到站，请到RCS核查是否卡死`;
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

server.listen(PORT, HOST, () => { console.log(`[auth-server] http://${HOST}:${PORT} 已启动（数据文件 ${DB_FILE}）`); try { opsMigrateToFiles(); eventsMigrateFromAlarms(); opsDigestTick(); } catch (_) {} backupDb(); archiveOld(); });
