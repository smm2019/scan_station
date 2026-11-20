// ㉖v198 检验「人已移走收口」+「重新上架窄豁免」+「整框随动」· 隔离实例端到端
// 现场实锤（11-15）：8 框检验下架后人把货搬去地面，站台被 atStation 工单永久挂占 →
// 检验可用 8 台全占满，界面一直"暂无空闲站台"；人工把站台标空闲也无效（只解 rcsStations
// 状态判据、不解工单占用判据）。本套件先复现该症状，再证明收口端点把两侧一起解开。
// 另验：rs=1 重新上架豁免收窄 + reserve 换货架新格 + ledger/sync 整框随动（只在 地面→货架 方向）。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const cp = require('child_process');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + i + ']' : ''}`); };

(async () => {
  // ===== 组0：网页脚本语法闸（服务端由隔离实例启动隐式验证）=====
  {
    const s = fs.readFileSync(path.join(__dirname, 'public', 'console.html'), 'utf8');
    const mm = s.match(/<script>([\s\S]*)<\/script>/);
    let ok = false, err = '';
    try { new vm.Script(mm[1]); ok = true; } catch (e) { err = e.message; }
    C('G0 网页控制台脚本语法完好', ok, err.slice(0, 70));
    C('G0 网页收口按钮与提交函数存在', /inspRemove\b/.test(mm[1]) && /inspRemoveGo/.test(mm[1]) && mm[1].includes('/api/inspect/remove'), '');
  }

  const crypto = require('crypto');
  const TDIR = path.join(__dirname, '_tdata_rmv198');
  const PORT = Number(process.env.RV_PORT || (8500 + Math.floor(Math.random() * 400)));
  fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
  const STN = 'NB02-CK-07', SHELF0 = 'NB02-A-08-2F';
  const GA = 'NB03-A-11-05';   // 收口去向（地面格）
  const GB = 'NB03-A-11-06';   // B 框：整框在地面
  const GD = 'NB03-A-12-03';   // D 框：混框的地面那一行
  const GE = 'NB03-B-05-02';   // E 框：随动测试原位
  const SHELF1 = 'NB02-H-77-1F'; // 随动目标货架格
  const NOW = Date.now();
  const mkUser = (id, un, nm, role, pw) => { const salt = crypto.randomBytes(16).toString('hex'); return { id, username: un, name: nm, role, enabled: true, createdAt: new Date().toISOString(), mustChangePw: false, salt, passHash: crypto.scryptSync(pw, salt, 32).toString('hex') }; };
  {
    const d0 = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'db.json'), 'utf8'));
    d0.users = (d0.users || []).filter((u) => u.role === 'admin').concat([mkUser('u_wh', 'rv_wh', '收口测试仓', 'warehouse', 'Rv#198'), mkUser('u_in', 'rv_in', '收口测试检', 'inspector', 'Rv#198')]);
    d0.features = JSON.parse(JSON.stringify(d0.features || {}));
    if (!d0.features.warehouse) d0.features.warehouse = {};
    d0.features.warehouse.insp_assist = true; d0.features.warehouse.agv_control = true; d0.features.warehouse.collect = true; d0.features.warehouse.location_reg = true;
    d0.inspects = []; d0.agvQueue = []; d0.rcsStations = {}; d0.rcsCleared = {}; d0.rcsManual = {}; d0.rcsDone = {}; d0.stnMeta = {}; d0.locReserve = {}; d0.ledgerFixes = [];
    // 地面布局夹具：真实排号清单/停用排/逐排格数全部改成已知值，使「空闲格查询」断言确定
    d0.gndZoneList = { A: [11, 12], B: [4, 5], C: [1] }; d0.gndZoneRows = {}; d0.gndRowOff = { 'NB03-A-12': 1 }; d0.groundSlots = { 'NB03-B-05': 4 };
    // 夹具腾位：测试要占用的地面格上，生产副本原有行一律挪走（否则收口的"目标格被他人占用"
    // 校验会正常工作并把测试挡掉——那是正确行为，不是被测缺陷）
    const USED = [GA, GB, GD, GE, SHELF1, SHELF0];
    d0.ledger = (d0.ledger || []).filter((x) => !USED.includes(String(x.l || '').toUpperCase()));
    const led = d0.ledger;
    led.push({ c: 'T198A001', l: SHELF0, f: '1800*1200_2', t: NOW - 864e5, p: 'T198PN', n: '收口件', q: 25, b: '2026-11-01', pid: 'PLT198A', mv: 'AGV', by: '张三' });
    led.push({ c: 'T198A002', l: SHELF0, f: '1800*1200_2', t: NOW - 864e5, p: 'T198PN', n: '收口件', q: 25, b: '2026-11-01', pid: 'PLT198A', mv: 'AGV', by: '张三' });
    d0.inspects.push({ id: 'iq_a1', uid: 'u_in', username: 'rv_in', code: 'T198A001', from: SHELF0, station: STN, state: 'atStation', at: NOW - 3600e3, arriveAt: NOW - 3000e3, updAt: NOW - 3000e3, taskNo: 'WM0000001981', part: 'T198PN', nm: '收口件', palletType: '1800*1200_2' });
    d0.agvQueue.push({ id: 'qq_a1', inspId: 'iq_a1', type: 'insp', code: 'T198A001', fromLoc: SHELF0, station: STN, state: '到站', at: NOW - 3600e3, trace: [] });
    led.push({ c: 'T198B001', l: GB, f: '1800*1200_2', t: NOW - 72e5, p: 'T198P2', n: '地面件', q: 10, b: '2026-11-05', pid: 'PLT198B', by: '李四' });
    led.push({ c: 'T198C001', l: 'NB02-B-03-1F', f: '1800*1200_2', t: NOW - 72e5, p: 'T198P3', n: '货架件', q: 10, b: '2026-11-05', pid: 'PLT198C', by: '李四' });
    led.push({ c: 'T198D001', l: GD, f: '1800*1200_2', t: NOW - 72e5, p: 'T198P4', n: '混框码1', q: 5, b: '2026-11-05', pid: 'PLT198D', by: '李四' });
    led.push({ c: 'T198D002', l: 'NB02-B-04-1F', f: '1800*1200_2', t: NOW - 72e5, p: 'T198P4', n: '混框码2', q: 5, b: '2026-11-05', pid: 'PLT198D', by: '李四' });
    led.push({ c: 'T198E001', l: GE, f: '1800*1200_2', t: NOW - 36e5, p: 'T198P5', n: '随动码1', q: 8, b: '2026-11-06', pid: 'PLT198E', by: '李四' });
    led.push({ c: 'T198E002', l: GE, f: '1800*1200_2', t: NOW - 36e5, p: 'T198P5', n: '随动码2', q: 8, b: '2026-11-06', pid: 'PLT198E', by: '李四' });
    fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(d0));
  }
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { SELFTEST_NO_LIVE: '1', ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch('http://127.0.0.1:' + PORT + '/api/health')).ok; } catch (_) {} }
  let out = ''; srv.stdout.on('data', (d) => { out += d; }); srv.stderr.on('data', (d) => { out += d; });
  const API = (p, o = {}, tk) => fetch('http://127.0.0.1:' + PORT + p, { method: o.method || 'GET', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined }).then((r) => r.json());
  const LED = async (code, tk) => { const r = await API('/api/ledger?c=' + code, {}, tk); const it = r.items || []; return it.find((x) => String(x.c).toUpperCase() === code) || {}; };

  try {
    C('护栏 隔离实例启动（server.js 加载完好）', up, '');
    const tkWh = up && (await API('/api/login', { method: 'POST', body: { username: 'rv_wh', password: 'Rv#198' } }, null)).token;
    const tkIn = up && (await API('/api/login', { method: 'POST', body: { username: 'rv_in', password: 'Rv#198' } }, null)).token;
    C('护栏 登录取 token（仓管/检验员）', !!tkWh && !!tkIn, '');

    // ===== 组A：复现现场症状 → 收口修复 =====
    let j = await API('/api/inspect/list', {}, tkWh);
    C('A0 ★★★ 复现用户症状：工单 atStation 挂着 → 该台不在空闲列表', !(j.freeStns || []).includes(STN), 'freeStns=' + (j.freeStns || []).length + ' 台');
    const cl = await API('/api/rcs/clear', { method: 'POST', body: { station: STN, state: '空闲' } }, tkWh);
    const j2 = await API('/api/inspect/list', {}, tkWh);
    C('A0b ★★★ 复现"人工清台了却还显示没有空闲站台"', cl.ok === true && !(j2.freeStns || []).includes(STN), '清台=' + cl.ok + ' 仍不空闲=' + !(j2.freeStns || []).includes(STN));

    const bad1 = await API('/api/inspect/remove', { method: 'POST', body: { id: 'iq_a1', loc: STN } }, tkWh);
    C('A1 去向填站台被拒（AGV到不了且语义错）', bad1.ok === false && /地面格|货架格/.test(bad1.msg || ''), (bad1.msg || '').slice(0, 34));
    const bad2 = await API('/api/inspect/remove', { method: 'POST', body: { id: 'iq_a1', loc: 'NB04-A-01-005' } }, tkWh);
    C('A2 去向填来料区格被拒', bad2.ok === false, (bad2.msg || '').slice(0, 34));
    const badP = await API('/api/inspect/remove', { method: 'POST', body: { id: 'iq_a1', loc: GA } }, tkIn);
    C('A3 检验员无 insp_assist 权限被拒', badP.ok === false && /仓管员/.test(badP.msg || ''), (badP.msg || '').slice(0, 30));

    const rm = await API('/api/inspect/remove', { method: 'POST', body: { id: 'iq_a1', loc: GA } }, tkWh);
    C('A4 ★★★ 收口成功（账本改位＋站台释放）', rm.ok === true && /收口完成/.test(rm.msg || '') && /释放/.test(rm.msg || ''), (rm.msg || '').slice(0, 66));
    const a1 = await LED('T198A001', tkWh);
    C('A5 ★★★ 账本随单改位到地面格（mv=人工 src=检验收口）', String(a1.l).toUpperCase() === GA && a1.mv === '人工' && a1.src === '检验收口', 'l=' + a1.l + ' mv=' + a1.mv + ' src=' + a1.src);
    const a2 = await LED('T198A002', tkWh);
    C('A6 ★★★ 整框兄弟码一起改位（不留半框幽灵）', String(a2.l).toUpperCase() === GA, '兄弟码 l=' + a2.l);
    const j3 = await API('/api/inspect/list', {}, tkWh);
    C('A7 ★★★ 站台立释：收口后台子回到空闲列表（用户卡死那一步）', (j3.freeStns || []).includes(STN), 'freeStns=' + (j3.freeStns || []).length);
    const recJ = (j3.list || []).find((x) => x.id === 'iq_a1') || {};
    C('A8 工单闭环 done ＋ 去向写进工单留痕', recJ.state === 'done' && /人工移走收口/.test(recJ.note || ''), 'state=' + recJ.state);
    C('A8b removed 标志位下发（链/看板据此区分"收口离场"与"已归位"）', recJ.removed === 1, 'removed=' + recJ.removed);
    const q3 = await API('/api/agv/taskOf?c=T198A001', {}, tkWh);
    C('A9 到站队列项已回收（不再被当作台上有货）', q3.found !== true || ['取消', '完成'].includes(q3.state), 'state=' + q3.state);
    const d2 = await API('/api/ledger/fixes?limit=30', {}, tkWh);
    const fx2 = (d2.list || []).find((x) => x.code === 'T198A001' && x.act === '人工移走') || {};
    C('A10 审计留痕（账本修正台账 act/from/to 齐）', fx2.act === '人工移走' && String(fx2.from).toUpperCase() === SHELF0 && String(fx2.to).toUpperCase() === GA, 'act=' + fx2.act + ' ' + fx2.from + '→' + fx2.to);
    await sleep(1200);
    const disk = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    C('A11 清台时刻已落库（rcsCleared 防 RCS 轮询刷回有货）', (disk.rcsCleared || {})[STN] > 0, '');
    const again = await API('/api/inspect/remove', { method: 'POST', body: { id: 'iq_a1', loc: GA } }, tkWh);
    C('A12 重复收口被拒（done 态不可再收）', again.ok === false && /不可收口/.test(again.msg || ''), (again.msg || '').slice(0, 40));

    // ===== 组B：重新上架窄豁免 =====
    const bRs = await API('/api/label/check?c=T198B001&rs=1', {}, tkWh);
    C('B1 ★★★ 地面框带 rs=1 → 放行（不再"已在库"拦死回架）', bRs.ok === true && bRs.blockIn !== true, 'blockIn=' + bRs.blockIn);
    const bNo = await API('/api/label/check?c=T198B001', {}, tkWh);
    C('B2 同框不带 rs → 照拦（豁免非默认，普通采集防重不变）', bNo.blockIn === true && /已在库/.test(bNo.reason || ''), (bNo.reason || '').slice(0, 26));
    const cRs = await API('/api/label/check?c=T198C001&rs=1', {}, tkWh);
    C('B3 ★★★ 账本在货架的框带 rs=1 仍拦（不收成万能口子）', cRs.blockIn === true && /已在库/.test(cRs.reason || ''), 'blockIn=' + cRs.blockIn);
    const dRs = await API('/api/label/check?c=T198D001&rs=1', {}, tkWh);
    const dNo = await API('/api/label/check?c=T198D001', {}, tkWh);
    C('B4 同框兄弟码一个在地面一个在货架：地面码 rs 放行、不带 rs 照拦', dRs.blockIn !== true && dNo.blockIn === true, 'rs=' + dRs.blockIn + ' 无rs=' + dNo.blockIn);
    const bNew = await API('/api/label/check?c=T198NOTEXIST&rs=1', {}, tkWh);
    C('B5 全新标签带 rs=1 行为不变（不借此放行重复录入）', bNew.ok === true && bNew.blockIn !== true && bNew.seen === false, 'seen=' + bNew.seen);

    // ===== 组C：reserve rs=1 换货架新格 =====
    const rNo = await API('/api/ledger/reserve', { method: 'POST', body: { code: 'T198B001', partNo: 'T198P2' } }, tkWh);
    C('C1 不带 rs：旧行为不变（回吐地面现位 kept=true）', rNo.ok === true && String(rNo.loc).toUpperCase() === GB && rNo.kept === true, 'loc=' + rNo.loc);
    const rRs = await API('/api/ledger/reserve', { method: 'POST', body: { code: 'T198B001', partNo: 'T198P2', rs: 1 } }, tkWh);
    C('C2 ★★★ 带 rs=1：分到货架新格（AGV 可达），不回吐地面位', rRs.ok === true && /^NB02-/.test(String(rRs.loc)) && !/-CK-/.test(String(rRs.loc)) && rRs.kept !== true, 'loc=' + rRs.loc);
    const cRs2 = await API('/api/ledger/reserve', { method: 'POST', body: { code: 'T198C001', partNo: 'T198P3', rs: 1 } }, tkWh);
    C('C3 已在货架的框带 rs=1 → 回现位幂等（不占新格）', cRs2.ok === true && String(cRs2.loc).toUpperCase() === 'NB02-B-03-1F' && cRs2.kept === true, 'loc=' + cRs2.loc);

    // ===== 组D：ledger/sync 整框随动 =====
    const rev0 = (await API('/api/ledger?c=T198E001', {}, tkWh)).rev || 0;
    const sync = await API('/api/ledger/sync', { method: 'POST', body: { items: [{ c: 'T198E001', l: SHELF1, f: '1800*1200_2', t: Date.now(), p: 'T198P5', n: '随动码1', q: 8, b: '2026-11-06', pid: 'PLT198E', mv: '人工' }], del: [] } }, tkWh);
    const e1 = await LED('T198E001', tkWh), e2 = await LED('T198E002', tkWh);
    C('D1 ★★★ 兄弟码整框随动到新货架格', sync.ok === true && String(e2.l).toUpperCase() === SHELF1, 'E001=' + e1.l + ' E002=' + e2.l + ' 拒回=' + JSON.stringify(sync.rejected || []).slice(0, 50));
    const rev1 = (await API('/api/ledger?c=T198E001', {}, tkWh)).rev || 0;
    C('D2 随动后账本版本 bump（各 PDA 缓存按 rev 失效）', rev1 > rev0, 'rev ' + rev0 + '→' + rev1);
    const sync2 = await API('/api/ledger/sync', { method: 'POST', body: { items: [{ c: 'T198E001', l: 'NB02-A-09-2F', f: '1800*1200_2', t: Date.now(), p: 'T198P5', n: '随动码1', q: 8, b: '2026-11-06', pid: 'PLT198E', mv: '人工' }], del: [] } }, tkWh);
    const e2b = await LED('T198E002', tkWh);
    C('D3 ★★★ 货架→货架 不随动（判据收窄，兄弟码留在原位）', sync2.ok === true && String(e2b.l).toUpperCase() === SHELF1, '兄弟码仍在 l=' + e2b.l);

    // ===== 组E：v198b 地面空闲格查询 /api/ground-free（收口「点选地面空格」数据源）=====
    // 此刻实况：T198A001+A002 整框占 GA(NB03-A-11-05)（A4 收口整框改位）、T198B001 占
    // GB(NB03-A-11-06)、A-12 停用、B-05 夹具 4 格；生产副本占着其余大量真实格
    const gfA = await API('/api/ground-free?c=T198A001', {}, tkWh);
    const gArow = (k) => ((gfA.rows) || []).find((r) => r.key === k) || {};
    C('E1 ★★★ 整框自排除：本框+兄弟码都占着 GA，带本框号查询 GA-05 依然可选（纠正收口不挡自己）',
      gfA.ok === true && (gArow('NB03-A-11').freeCells || []).includes('05'), 'A11空=' + (gArow('NB03-A-11').freeCells || []).join(','));
    C('E2 selfLoc 回显账本现位（弹层"已排除本框现住"提示数据源）', String(gfA.selfLoc).toUpperCase() === GA, 'selfLoc=' + gfA.selfLoc);
    const gfX = await API('/api/ground-free?c=T198E001', {}, tkWh);
    const gxRow = ((gfX.rows) || []).find((r) => r.key === 'NB03-A-11') || {};
    C('E3 ★★★ 别人的框照实占用：换别框查询 GA-05/06 不可选', !(gxRow.freeCells || []).includes('05') && !(gxRow.freeCells || []).includes('06'), 'A11空=' + (gxRow.freeCells || []).join(','));
    C('E4 真实排号清单+停用排生效：A区只列11排(12停用不列)、B区列4/5', !(gfA.rows || []).some((r) => r.key === 'NB03-A-12') && (gfA.rows || []).some((r) => r.key === 'NB03-A-11') && (gfA.rows || []).some((r) => r.key === 'NB03-B-05'), '');
    C('E5 逐排格数覆盖生效（B-05 slots=4 ≤ 默认12）', gArow('NB03-B-05').slots === 4, 'slots=' + gArow('NB03-B-05').slots);
    const rsv = await API('/api/ledger/reserve', { method: 'POST', body: { code: 'ZZZ9PDA', zone: 'B04', partNo: '' } }, tkWh);
    const gfR = await API('/api/ground-free?c=T198E001', {}, tkWh);
    const b04 = ((gfR.rows) || []).find((r) => r.key === 'NB03-B-04') || {};
    const rsvCell = String(rsv.loc || '').slice(-2);
    C('E6 ★★★ 预占即占用避让：他机刚预占的格从空闲清单实时消失', rsv.ok === true && /^NB03-B-04-/.test(String(rsv.loc)) && rsvCell !== '' && !(b04.freeCells || []).includes(rsvCell), '预占=' + rsv.loc);
    const rs = gfA.rows || [];
    C('E7 空格多的排靠前 + totalFree=逐排之和', rs.every((r, i) => i === 0 || rs[i - 1].free >= r.free) && gfA.totalFree === rs.reduce((s, r) => s + r.free, 0), 'totalFree=' + gfA.totalFree);
    C('★ 服务进程无未捕获异常', !/Unhandled|TypeError: |ReferenceError/.test(out), out.split('\n').slice(-2).join(' ').slice(0, 80));
  } catch (e) {
    total++; fail++; console.log('❌ 异常：' + e.message + '\n' + String(out).split('\n').slice(-10).join('\n'));
  } finally {
    srv.kill(); await sleep(400);
    try { fs.rmSync(TDIR, { recursive: true, force: true }); } catch (_) {}
  }
  console.log('\n结果: ' + (total - fail) + ' 通过 / ' + fail + ' 失败  （隔离副本，生产库零写入）');
  process.exit(fail ? 1 : 0);
})();
