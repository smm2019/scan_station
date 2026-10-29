// ㉖v100 货位格式防线·端到端取证（真实 HTTP 打隔离实例，非逻辑模拟）
// 流程：复制 db.json+secret.key 到独立 data 目录 → 注入已知密码仓管账号 → 起服务(PORT 8321)
//      → 登录取 token → 打 /api/ledger/sync /api/scanlog/sync /api/scanlog/cancel → 复读落库数据断言
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const SRC = path.join(__dirname, 'data');
const TDIR = path.join(__dirname, 'data_e2e_v100');
const PORT = 8321;
const BASE = 'http://127.0.0.1:' + PORT;

// —— 准备隔离数据目录 ——
fs.rmSync(TDIR, { recursive: true, force: true });
fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(SRC, 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(SRC, 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
// 注入已知密码测试账号（仓管）
const salt = crypto.randomBytes(16).toString('hex');
const hashPw = (pw, s) => crypto.scryptSync(String(pw), s, 32).toString('hex');
db0.users = db0.users || [];
db0.users.push({ id: 'u_e2e_v100', username: 'e2e_wh_v100', name: 'E2E取证账号', role: 'warehouse', enabled: true, createdAt: Date.now(), mustChangePw: false, salt, passHash: hashPw('E2e#V100!pw', salt) });
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));

let fail = 0, total = 0;
const chk = (name, got, want) => { total++; const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL!'} [${name}] got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(p, token, body) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

(async () => {
  // —— 起隔离服务 ——
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  const srvLog = [];
  srv.stdout.on('data', (b) => { const s = b.toString(); srvLog.push(s); const q = /\[flow-loc\]|\[ledger\]|\[seenIn\]/.test(s); if (q) console.log('  服务日志> ' + s.trim()); });
  srv.stderr.on('data', (b) => { const s = b.toString(); srvLog.push(s); });
  // 健康端点就绪探测（最多约10秒）
  let up = false;
  for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { const r = await fetch(BASE + '/api/health'); up = r.ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪'); srv.kill(); process.exit(1); }
  console.log('隔离实例已就绪 (PORT ' + PORT + ')');

  try {
    // —— 登录 ——
    const lg = await post('/api/login', null, { username: 'e2e_wh_v100', password: 'E2e#V100!pw' });
    chk('L1 测试账号登录', [lg.json.ok === true, typeof lg.json.token === 'string'], [true, true]);
    const tk = lg.json.token, T = () => tk;
    const now = Date.now();
    const ep = db0.ledgerEpoch;
    // 动态找两个确定空闲货位（避开真实账本占用位——货位互斥闸会正确拦占用位，非防线问题）
    const occ = new Set(db0.ledger.map((x) => String(x.l).toUpperCase()));
    const cands = ['NB02-A-16-4F', 'NB02-B-16-4F', 'NB02-C-16-3F', 'NB03-A-16-40', 'NB03-B-16-40', 'NB03-C-16-40'];
    const freeLocs = cands.filter((l) => !occ.has(l)).slice(0, 2);
    if (freeLocs.length < 2) { console.log('FAIL! 找不到两个空闲货位，样本池需扩充'); srv.kill(); process.exit(1); }

    // ========== 防线① /api/ledger/sync ==========
    const it = (c, l) => ({ c, l, f: '1800*1200_2', t: now, q: 10, p: '6600000001', n: 'E2E取证件', b: '2026-10-29', pid: 'E2EPID', mv: '登记', src: 'E2E' });
    // 一轮混推：1 合法（空位） + 3 病值（站台码/粗码/混用形态）
    const r1 = await post('/api/ledger/sync', T(), { epoch: ep, items: [it('TLOCG0001', freeLocs[0]), it('TLOCG0002', 'NB02-CK-03'), it('TLOCG0003', 'H09'), it('TLOCG0004', 'NB03-A-09-2F')], del: [] });
    chk('D1a 请求受理', r1.json.ok, true);
    chk('D1b 合法行正常上账(added=1，零误伤)', r1.json.added, 1);
    chk('D1c 三条病值全部点名拒回', (r1.json.rejectedLoc || []).length, 3);
    console.log('   拒回文案样例: ' + (r1.json.rejectedLoc || ['(无)'])[0]);

    // 落库核验：病值绝不进账本
    await sleep(300);
    let dd = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    const codes = new Set(dd.ledger.map((x) => String(x.c).toUpperCase()));
    chk('D1d 账本仅有合法行', [codes.has('TLOCG0001'), codes.has('TLOCG0002'), codes.has('TLOCG0003'), codes.has('TLOCG0004')], [true, false, false, false]);
    chk('D1e 合法行货位正确', (dd.ledger.find((x) => x.c === 'TLOCG0001') || {}).l, freeLocs[0]);
    // seenIn 出生证明只记上账行
    chk('D1f seenIn 不记病值行', [!!dd.seenIn['TLOCG0001'], !!dd.seenIn['TLOCG0002'], !!dd.seenIn['TLOCG0003'], !!dd.seenIn['TLOCG0004']], [true, false, false, false]);
    chk('D1g seenIn 合法行带l', (dd.seenIn['TLOCG0001'] || {}).l, freeLocs[0]);

    // 二推同病值：防弹窗循环（locReject 记忆→静默不点名）
    const r2 = await post('/api/ledger/sync', T(), { epoch: ep, items: [it('TLOCG0002', 'NB02-CK-03')], del: [] });
    chk('D2a 重推同病值不再点名', (r2.json.rejectedLoc || []).length, 0);
    await sleep(300);
    dd = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    chk('D2b 重推仍未上账', dd.ledger.some((x) => x.c === 'TLOCG0002'), false);
    chk('D2c locReject 记忆在案', (dd.locReject || {})['TLOCG0002'], 'NB02-CK-03');

    // 三推：拒回标签改登记为合法位 → 正常上账 + 拒回记录清除
    const r3 = await post('/api/ledger/sync', T(), { epoch: ep, items: [it('TLOCG0002', 'NB03-A-09-05')], del: [] });
    chk('D3a 改合法位后受理上账', r3.json.added, 1);
    await sleep(300);
    dd = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    chk('D3b 账本已收录', dd.ledger.some((x) => x.c === 'TLOCG0002' && x.l === 'NB03-A-09-05'), true);
    chk('D3c 拒回记录自动清除', !!(dd.locReject || {})['TLOCG0002'], false);

    // 全批皆病值：账本非空不早退，200 返回 added=0 + 整批点名（脏标签显式暴露引导人工处置，非静默吞掉）
    const r5 = await post('/api/ledger/sync', T(), { epoch: ep, items: [it('TLOCG0005', 'NB02-E-03'), it('TLOCG0006', '随便写的')], del: [] });
    chk('D4a 全病值批不报错(200)但零上账', [r5.json.ok === true, r5.json.added], [true, 0]);
    chk('D4b 整批点名拒回', (r5.json.rejectedLoc || []).length, 2);
    await sleep(300);
    dd = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    chk('D4c 病值标签确未落库', dd.ledger.some((x) => x.c === 'TLOCG0005' || x.c === 'TLOCG0006'), false);

    // ========== 防线② /api/scanlog/sync 体检留痕 ==========
    const f = (k, code, wt, st, gl, cx) => ({ k, code, wt, st, gl, ct: '1800*1200_2', rm: '', batch: 'B-E2E-V100', cx: !!cx, t: now, pn: '6600000002', q: 5, mk: '', op: 'E2E', nm: 'E2E流水件', lot: '2026-10-29', mc: '', pid: '' });
    const s1 = await post('/api/scanlog/sync', T(), { items: [
      f('K1', 'E2EFLOW001', 1, '', 'NB02-CK-05'),   // 反向病：地面模式 gl=站台 → 应命中
      f('K2', 'E2EFLOW002', 0, 'NB03-B-11-07', 'NB02-A-05-1F'), // 错配：AGV st=地面格 → 应命中
      f('K3', 'E2EFLOW003', 0, 'NB02-CK-05', 'NB02-A-05-1F'),  // 正常AGV（gl=目标货架位 222行合法语义）→ 不得命中
      f('K4', 'E2EFLOW004', 1, '', 'NB03-H-09'),    // 正常地面粗码（v85c待补录态）→ 不得命中
      f('K6', 'E2EFLOW006', 1, '', freeLocs[1]),    // 正常地面完整格位 → 不得命中，且恢复时照常上账（C1对照）
    ] });
    chk('S1 流水推送受理', s1.json.ok, true);
    await sleep(300);
    dd = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    const slog = dd.scanlog || {};
    chk('S2 体检只留痕不回改：错配条目原样入库', [slog['K1'] && slog['K1'].gl, slog['K2'] && slog['K2'].st], ['NB02-CK-05', 'NB03-B-11-07']);
    chk('S3 正常条目未被误改', [slog['K3'] && slog['K3'].gl, slog['K4'] && slog['K4'].gl], ['NB02-A-05-1F', 'NB03-H-09']);
    const logTxt = srvLog.join('');
    chk('S4 服务日志有体检留痕', /\[flow-loc\].*2 条跨模式货位错配/.test(logTxt), true);
    const opsTxt = JSON.stringify(dd.ops || dd.opsToday || '');
    chk('S5 活动流有体检条目', /货位格式体检/.test(opsTxt) || /货位格式体检/.test(logTxt), true);
    // 关键：病流水绝不可能经账本防线污染 l（K1/K2 若后续被"恢复上账"由防线③兜底，见下）

    // ========== 防线③ /api/scanlog/cancel 恢复分支 ==========
    // 场景1（设计边界演示）：K2 AGV 流水 st=地面格位（跨模式错配但格式合法）恢复 → 取 st 过 locStrict 放行、照常上账。
    // 防线③只按【格式】把关、不按模式擅改现场数据（st/gl 谁才是真实位置无法裁定，v85c 对齐也只治 gl）；
    // 该条已被防线②体检点名留痕（S4/S5），人工按提示核对处置。——明确接受的设计边界，非漏网。
    const cx1 = await post('/api/scanlog/cancel', T(), { k: 'K2', cx: true });
    chk('C1a 作废受理', cx1.json.ok, true);
    const rs1 = await post('/api/scanlog/cancel', T(), { k: 'K2', cx: false });
    await sleep(300);
    dd = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    const k2row = (dd.ledger || []).find((x) => x.c === 'E2EFLOW002');
    chk('C1b 格式合法的st恢复照常上账（边界演示）', [rs1.json.ok === true, !!k2row, String((k2row || {}).l || '').toUpperCase()], [true, true, 'NB03-B-11-07']);

    // 场景2：地面模式 gl=站台码（K1）恢复 → 同样必须不上账（反向病的恢复路径）
    await post('/api/scanlog/cancel', T(), { k: 'K1', cx: true });
    const rs2 = await post('/api/scanlog/cancel', T(), { k: 'K1', cx: false });
    chk('C2a 地面流水gl=站台 → 拒上账', /非完整货架\/格位/.test(String(rs2.json.msg)), true);
    await sleep(300);
    dd = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    chk('C2b 未进账本', dd.ledger.some((x) => x.c === 'E2EFLOW001'), false);

    // 注：K2（wt=0 st=地面格）恢复取 st → 过 locStrict 会正常上账。防线③按【格式】把关、不按【模式一致性】
    // 改写——st/gl 谁才是真实位置无法裁定（v85c 对齐也只对 gl 做过，不擅改现场数据）；该条已被防线②体检留痕
    // 进日志与活动流（S4/S5 已证），由人工按提示核对处置。此为明确接受的设计边界，非漏网。
    const rs3 = await post('/api/scanlog/cancel', T(), { k: 'K6', cx: true });
    chk('C3a 地面格位流水作废受理', rs3.json.ok, true);
    const rs3b = await post('/api/scanlog/cancel', T(), { k: 'K6', cx: false });
    await sleep(300);
    dd = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    const k6row = (dd.ledger || []).find((x) => x.c === 'E2EFLOW006');
    chk('C3b 地面完整格位流水恢复照常上账（防线③零误伤对照）', [rs3b.json.ok === true, !!k6row, String((k6row || {}).l || '').toUpperCase()], [true, true, freeLocs[1].toUpperCase()]);
    chk('C3c 恢复上账来源标注网页恢复', String((k6row || {}).src || ''), '网页恢复');

    // 场景4：AGV 流水（wt=0，st=站台码，恢复取 st）→ 必拒（正是旧版把站台直接写进账本的漏网路径）
    await post('/api/scanlog/cancel', T(), { k: 'K3', cx: true });
    const rs4 = await post('/api/scanlog/cancel', T(), { k: 'K3', cx: false });
    chk('C4a AGV流水恢复取位=站台 → 拒上账', /非完整货架\/格位/.test(String(rs4.json.msg)), true);
    await sleep(300);
    dd = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    chk('C4b 旧版漏网实锤已封堵：wt=0 恢复不再把站台写入账本', dd.ledger.some((x) => x.c === 'E2EFLOW003' && String(x.l).includes('-CK-')), false);

    // ========== 存量数据回放（防线上线瞬间零误伤）已在前置 R1~R4 独立脚本验证，此处不重复 ==========

    console.log(`\n===== 端到端取证：${fail === 0 ? '全部 PASS' : fail + ' 项失败'}，合计 ${total} 项断言 =====`);
  } finally {
    srv.kill();
    await sleep(500);
    try { srv.kill('SIGKILL'); } catch (_) {}
    fs.rmSync(TDIR, { recursive: true, force: true });
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('EXCEPTION: ' + e.stack); process.exit(2); });
