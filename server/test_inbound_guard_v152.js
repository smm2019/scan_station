// ㉖v152 入库三道防线 · 实例验证（隔离实例真实 API + 真实 sweep 函数）
// 背景（11-11 刘向轩 N26K100170/N26K110142）：扫码入账 mv=AGV 记"在架"，叫车请求未达服务器，
// 货在站台压半小时无人知；PDA 读本机账本全绿，仅网页流水偶见端倪。三防线：
// L1 丢单巡检「账称在架、车未叫」：入账2h~28d ∧ 无队列 ∧ 无对应任务 ∧ 台站流水佐证 → ghost_out 必达+solo
//    假阳性排除：有队列(任意态)/有任务/age<2h 或 >28d/无 st 佐证(数据病只留痕)/7天去重/阈值0=关
// L2 粗码未上账：sync 收到 gl=区排粗码(F4/H9)且账本无行 → 即时 ops+必达；同码同排7天去重；完整格位/怪值不误报
// L3 重复有效流水：本次推送 code 全库有效记录≥2 → 留痕；台站分歧→必达点名；一致→只留痕；7天去重
// 时序注：启动首轮巡检挂在 setTimeout 8s（+启动回调内备份/归档耗时），断言窗口须 ≥20s
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const SRV = path.join(__dirname, 'server.js');
const SRC = path.join(__dirname, 'data', 'db.json');
const TMP = path.join(__dirname, 'proof_inbound_guard');
const PORT = 18153, VT = 'TESTTOK_v152', VA = 'TESTADMTOK_v152'; // VT=仓管（流水/告警受众），VA=管理员（参数接口要管理角色）
let fail = 0, total = 0;
function T(n, a, b) { total++; const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) { fail++; console.log('FAIL ' + n + '\n  实际=' + JSON.stringify(a) + '\n  期望=' + JSON.stringify(b)); } else console.log('PASS ' + n); }
const rq = (p, tok, body) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : null;
  const r0 = http.request({ host: '127.0.0.1', port: PORT, path: p, method: body ? 'POST' : 'GET', timeout: 15000, headers: Object.assign({ Authorization: 'Bearer ' + tok }, data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) }, (r) => { let s = ''; r.on('data', (c) => s += c); r.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(new Error(p + ' 解析失败(' + r.statusCode + '): ' + s.slice(0, 90))); } }); });
  r0.on('error', reject); if (data) r0.write(data); r0.end();
});
const rqP = (port, p) => new Promise((resolve, reject) => { http.get({ host: '127.0.0.1', port, path: p, timeout: 5000 }, (r) => { let s = ''; r.on('data', (c) => s += c); r.on('end', () => { try { resolve(JSON.parse(s)); } catch (_) { reject(new Error('bad')); } }); }).on('error', reject); });
const getDb = () => JSON.parse(fs.readFileSync(path.join(TMP, 'db.json'), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitDb(pred, tries) { for (let i = 0; i < (tries || 14); i++) { try { if (pred(getDb())) return true; } catch (_) { } await sleep(250); } return false; }
const H = 3600000, NOW = Date.now();
const mkRow = (c, l, mv, t) => ({ c, l, f: '筐', t: t || NOW - 26 * H, p: '6608453824', n: '测试件', q: 25, b: '2026-11-01', pid: '', mv: mv || 'AGV', src: 'NB02-CK-05', by: '测试', hist: [] });
const mkScan = (c, st, t, op) => ({ k: c + '|B1|' + (t || NOW - 26 * H), code: c, wt: 0, st: st || '', gl: '', cx: false, t: t || NOW - 26 * H, pn: '6608453824', q: 25, op: op || '测试', mk: '' });

const C_LOST = 'N99H000101', C_Q = 'N99H000102', C_T = 'N99H000103', C_NEW = 'N99H000104', C_OLD = 'N99H000105', C_SICK = 'N99H000106';
const C_C1 = 'N99H000201', C_C2 = 'N99H000202';
// ⚠️v165 粗码告警新判据样本：C_C3 滞留【必须报】/ C_C5 已有出库留痕【不报】/ C_C6 账本已有【不报】
const C_C3 = 'N99H000203', C_C5 = 'N99H000205', C_C6 = 'N99H000206';
const C_D1 = 'N99H000301', C_D2 = 'N99H000302';
const lostN = (d) => (d.notifications || []).filter((x) => /入库丢单/.test(String(x.text || '')));

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true }); fs.mkdirSync(path.join(TMP, 'logs'), { recursive: true });
  fs.copyFileSync(SRC, path.join(TMP, 'db.json'));
  const sk = path.join(__dirname, 'data', 'secret.key'); if (fs.existsSync(sk)) fs.copyFileSync(sk, path.join(TMP, 'secret.key'));
  const d0 = getDb();
  const wh = (d0.users || []).find((x) => x.role === 'warehouse' && x.enabled !== false);
  const adm = (d0.users || []).find((x) => x.role === 'admin' && x.enabled !== false);
  d0.sessions = d0.sessions || {};
  d0.sessions[VT] = { userId: wh.id, dev: 'TEST-V152', lastSeen: Date.now() };
  d0.sessions[VA] = { userId: adm.id, dev: 'TEST-V152A', lastSeen: Date.now() };
  // 巡检宇宙隔离：清掉生产复制来的 mv=AGV∧NB02 存量行（启动轮会对全账本评估，真实行自造命中
  // 会淹没点名文本前6条、令合成断言不稳定）——丢单告警对生产真实行的效果由部署时首轮自然验证
  d0.ledger = (d0.ledger || []).filter((x) => !(String(x.mv || '') === 'AGV' && /^NB02-/.test(String(x.l || '')) && !String(x.c || '').startsWith('N99H')));
  d0.ledger.push(
    mkRow(C_LOST, 'NB02-H-01-1F'), mkRow(C_Q, 'NB02-H-01-2F'), mkRow(C_T, 'NB02-H-01-3F'),
    mkRow(C_NEW, 'NB02-H-01-4F', 'AGV', NOW - H), mkRow(C_OLD, 'NB02-H-02-1F', 'AGV', NOW - 30 * 24 * H),
    mkRow(C_SICK, 'NB02-H-02-2F'));
  d0.agvQueue = (d0.agvQueue || []).filter((q) => !String(q.code || '').startsWith('N99H'));
  // 队列项须落在保留窗口内（完成项默认留 120 分钟，超期被启动清理删除；真实完成框另有任务底仓兜底=C_T 用例）
  d0.agvQueue.push({ id: 'q_h1', code: C_Q, fromLoc: 'NB02-CK-05', station: 'NB02-H-01-2F', state: '完成', by: '测试', at: NOW - 40 * 60000, updAt: NOW - 35 * 60000, type: 'inbound', trace: [] });
  d0.agvTasks = d0.agvTasks || {}; d0.agvTasks['AGV-TEST-V152'] = { car: 6, ex: NOW - 25 * H, fin: NOW - 24.7 * H, pick: NOW - 24.9 * H, dur: 300, sp: 'NB02-CK-05', ep: 'NB02-H-01-3F', ck: 'in' };
  d0.scanlog = d0.scanlog || {};
  for (const k of Object.keys(d0.scanlog)) if (!d0.scanlog[k].code || !String(d0.scanlog[k].code).startsWith('N99H')) continue; else delete d0.scanlog[k];
  [mkScan(C_LOST, 'NB02-CK-05'), mkScan(C_Q, 'NB02-CK-05'), mkScan(C_T, 'NB02-CK-05'), mkScan(C_NEW, 'NB02-CK-05', NOW - H), mkScan(C_OLD, 'NB02-CK-05', NOW - 30 * 24 * H), mkScan(C_SICK, '', NOW - 26 * H)]
    .forEach((s) => { d0.scanlog[s.k] = s; });
  d0.lostCallAlert = {}; d0.coarseAlert = {}; d0.dupFlowAlert = {};
  // ⚠️v165 粗码告警改【持续滞留】判定所需的预置样本（ledger 只追加，不可清空——L1 用例依赖上方样本行）
  // C_C5：流水滞留但【已有出库留痕】= 当时已补全格位并发走，非滞留框 → 必须不报（不加③这条，
  //       全库兜底扫描会把历史上 28 条已自愈粗码流水一次全报出来刷屏——现网 28/28 全部已出库）
  d0.seenOut = Object.assign({}, d0.seenOut || {}, { [C_C5]: { at: NOW - 2 * H, no: 'DT-TEST', by: '测试' } });
  // C_C6：流水滞留但【账本已有此框】= 重扫补全自愈 → 必须不报（②）
  d0.ledger.push({ c: C_C6, l: 'NB03-F-09-07', f: '筐', t: NOW - 10 * 60000, p: '6608225548', n: '测试件', q: 25, b: '2026-11-01', pid: '', mv: '登记', by: '测试' });
  // 滞留样本（过判龄，必须报）
  d0.scanlog[C_C3 + '|B9|1'] = { k: C_C3 + '|B9|1', code: C_C3, wt: 1, gl: 'F4', st: '', cx: false, t: NOW - 10 * 60000, pn: '6608225548', q: 25, op: '测试滞留', lot: '2026-11-11' };
  // ★ C_C5/C_C6 也必须有【滞留粗码流水】：否则函数在前面的 filter 阶段就把它们跳过，
  //   ②③ 两条豁免判据从未被执行，"不报"是恒真空过（假绿），测不出判据写错。
  d0.scanlog[C_C5 + '|B9|1'] = { k: C_C5 + '|B9|1', code: C_C5, wt: 1, gl: 'F4', st: '', cx: false, t: NOW - 10 * 60000, pn: '6608225548', q: 25, op: '测试滞留', lot: '2026-11-11' };
  d0.scanlog[C_C6 + '|B9|1'] = { k: C_C6 + '|B9|1', code: C_C6, wt: 1, gl: 'F4', st: '', cx: false, t: NOW - 10 * 60000, pn: '6608225548', q: 25, op: '测试滞留', lot: '2026-11-11' };
  d0.params = Object.assign({}, d0.params, { lostCallAlertM: 15, coarseAlertOn: 1, coarseAlertAgeMin: 5, dupFlowAlertOn: 1 });
  fs.writeFileSync(path.join(TMP, 'db.json'), JSON.stringify(d0));

  const inst = spawn(process.execPath, [SRV], { env: Object.assign({}, process.env, { DATA_DIR: TMP, PORT: String(PORT) }), stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    let up = false;
    for (let i = 0; i < 45; i++) { await sleep(1000); try { const h = await rqP(PORT, '/api/health'); if (h && h.ok) { up = true; break } } catch (_) { } }
    T('H0 隔离服务器就绪', up, true);
    if (!up) throw new Error('服务未起');

    // ===== L1 丢单巡检：启动轮 ≈8s+启动回调耗时，窗口 25s =====
    T('L1a 真丢单必达告警（点名标签号）', await waitDb((d) => lostN(d).some((n) => String(n.text).includes(C_LOST)), 100), true);
    { const n = lostN(getDb())[0], txt = String((n || {}).text || '');
      T('L1b 告警给出账面位+台站+入账时刻（可执行指引）', [txt.includes('NB02-H-01-1F'), txt.includes('NB02-CK-05'), /请回台站核对实物/.test(txt)], [true, true, true]);
      T('L1c 豁免不误报：有队列/有任务/太新/太旧 均不告警', [C_Q, C_T, C_NEW, C_OLD].filter((c) => lostN(getDb()).some((x) => String(x.text).includes(c))), []);
      T('L1d 无台站佐证=数据病不告警（只留痕）', lostN(getDb()).some((x) => String(x.text).includes(C_SICK)), false);
      T('L1e 数据病留痕进 ops', await waitDb((dd) => { try { return fs.readdirSync(path.join(TMP, 'ops')).some((f) => fs.readFileSync(path.join(TMP, 'ops', f), 'utf8').includes('入库流水数据病')); } catch (_) { return false } }, 30), true);
      T('L1f 告警发给全体仓管+管理员（每人一条 solo）', lostN(getDb()).length >= 2, true);
      T('L1g 类型=ghost_out（绕退订+夜间不静默）', [...new Set(lostN(getDb()).map((x) => x.type))].join(','), 'ghost_out'); }

    // ===== L2 粗码未上账（⚠️v165 新语义：【持续滞留】才报，自愈中间态不报）=====
    // C_C1=滞留10分钟(>判龄5分钟) 必须报；C_C2=完整格位 不报；C_C4=刚扫入30秒 不报（★核心：
    // 正是"选区写流水→自动分格→账本经30秒防抖才推达"的中间态窗口，旧版在此误报一天7次）
    const C_C4 = 'N99H000204';
    await rq('/api/scanlog/sync', VT, { items: [
      { k: C_C1 + '|B2|1', code: C_C1, wt: 1, gl: 'F4', st: '', cx: false, t: Date.now() - 10 * 60000, pn: '6608225548', q: 25, op: '测试粗码' },
      { k: C_C2 + '|B2|2', code: C_C2, wt: 1, gl: 'NB03-F-04-12', st: '', cx: false, t: Date.now() - 10 * 60000, pn: '6608225548', q: 25, op: '测试粗码' },
      { k: C_C4 + '|B2|3', code: C_C4, wt: 1, gl: 'F4', st: '', cx: false, t: Date.now(), pn: '6608225548', q: 25, op: '测试粗码' },
    ] });
    T('L2a 滞留过判龄→必达告警（点名标签号+滞留时长）', await waitDb((d) => (d.notifications || []).some((n) => /粗码未上账/.test(String(n.text || '')) && String(n.text).includes(C_C1)), 30), true);
    T('L2b 完整格位不误报', (getDb().notifications || []).some((x) => /粗码未上账/.test(String(x.text || '')) && String(x.text).includes(C_C2)), false);
    T('L2e ★自愈中间态不报（刚扫入未过判龄，旧版此处误报）', (getDb().notifications || []).some((x) => /粗码未上账/.test(String(x.text || '')) && String(x.text).includes(C_C4)), false);
    T('L2f ★已有出库留痕不报（当时已补全格位并发走，非滞留框）', (getDb().notifications || []).some((x) => /粗码未上账/.test(String(x.text || '')) && String(x.text).includes(C_C5)), false);
    T('L2g ★账本已有此框不报（重扫补全自愈）', (getDb().notifications || []).some((x) => /粗码未上账/.test(String(x.text || '')) && String(x.text).includes(C_C6)), false);
    T('L2c 粗码留痕进 ops', await waitDb(() => { try { return fs.readdirSync(path.join(TMP, 'ops')).some((f) => fs.readFileSync(path.join(TMP, 'ops', f), 'utf8').includes('粗码未上账')); } catch (_) { return false } }, 30), true);

    // ===== L2d 同码同排 7 天去重 =====
    // ★ 第二次推送必须【仍过判龄】（t 用 10 分钟前，不能用 NOW）：否则函数在判龄那步就 return，
    //   去重逻辑根本没被执行过，"数量不变"是恒真空过（假绿），去重写坏了也照样绿。
    { const nOf = (d) => (d.notifications || []).filter((x) => /粗码未上账/.test(String(x.text || '')) && String(x.text).includes(C_C1)).length;
      const before = nOf(getDb());
      await rq('/api/scanlog/sync', VT, { items: [{ k: C_C1 + '|B3|1', code: C_C1, wt: 1, gl: 'F4', st: '', cx: false, t: Date.now() - 10 * 60000, pn: '6608225548', q: 25, op: '测试粗码' }] });
      await sleep(1500);
      T('L2d 同码同排去重（重复推送不刷屏，且确已执行到去重判定）', nOf(getDb()), before); }

    // ===== L3 重复有效流水：分歧必达 / 一致只留痕 =====
    await rq('/api/scanlog/sync', VT, { items: [
      mkScan(C_D1, 'NB02-CK-06', NOW - 5 * H), mkScan(C_D2, 'NB02-CK-06', NOW - 4 * H),
    ] });
    await rq('/api/scanlog/sync', VT, { items: [
      mkScan(C_D1, 'NB02-CK-07', NOW - 2 * H), mkScan(C_D2, 'NB02-CK-06', NOW - 2 * H),
    ] });
    // ⚠️v166 语义反转：v152 旧判据"未作废≥2条 + 位置不同"把【先后经过不同台站/挪过位】当异常必达，
    // 现场一次刷出 20+ 条（台站只是中转点，同一框先后经 CK-06、CK-07 完全正常）。新判据只有
    // 【同一排/同列内出现≥2个不同格位】（一个框不可能同时占两格）才必达。
    // 故 L3a 从"必须必达"反转为"必须不再必达"——反向锁住这个 bug，防止有人改回去。
    const NEWMSG = /同一标签有 ≥2 条有效流水指向【不同格位】或【同一格位重复】/;
    T('L3a ★台站分歧不再必达（v152 误判已修，反向锁回归）', (getDb().notifications || []).some((x) => NEWMSG.test(String(x.text || '')) && String(x.text).includes(C_D1)), false);
    T('L3b 台站一致→不点名', (getDb().notifications || []).some((x) => NEWMSG.test(String(x.text || '')) && String(x.text).includes(C_D2)), false);
    { // 真冲突 vs 挪位：同标签两条流水指向【同排不同格】必须点名；【跨排】= 挪位，不点名
      const C_CLASH = 'N99H000303', C_MOVED = 'N99H000304';
      await rq('/api/scanlog/sync', VT, { items: [
        { k: C_CLASH + '|B6|1', code: C_CLASH, wt: 1, gl: 'NB03-D-77-01', st: '', cx: false, t: NOW - 3 * H, pn: '6608225548', q: 25, op: '测试互斥' },
        { k: C_CLASH + '|B6|2', code: C_CLASH, wt: 1, gl: 'NB03-D-77-05', st: '', cx: false, t: NOW - 2 * H, pn: '6608225548', q: 25, op: '测试互斥' },
        { k: C_MOVED + '|B6|1', code: C_MOVED, wt: 1, gl: 'NB03-D-77-02', st: '', cx: false, t: NOW - 3 * H, pn: '6608225548', q: 25, op: '测试挪位' },
        { k: C_MOVED + '|B6|2', code: C_MOVED, wt: 1, gl: 'NB03-E-99-02', st: '', cx: false, t: NOW - 2 * H, pn: '6608225548', q: 25, op: '测试挪位' },
      ] });
      T('L3d ★同排不同格位→必达点名（一个框不可能占两格）', await waitDb((d) => (d.notifications || []).some((n) => NEWMSG.test(String(n.text || '')) && String(n.text).includes(C_CLASH)), 30), true);
      T('L3e ★跨排挪位不升必达（正常业务，只留痕）', (getDb().notifications || []).some((x) => NEWMSG.test(String(x.text || '')) && String(x.text).includes(C_MOVED)), false);
    }
    // ㉖v167 L3f 同一格位出现≥2条有效流水 → 必达（补 v166 盲点）
    // 盲点成因：流水 gl 会被后续 sync 的 v85b 对齐改写到账本【当前格位】，重扫的两条最终 gl 相同，
    // 于是"不同格位互斥"永不触发 → 最该报的"同框双流水"被静默（现场 N26K120114 两条 gl 都是 NB03-H-09-05 即此）。
    // 台站不参与此判定（slotM 只认 NB0X-区-排-格），故 L3b「台站一致不点名」不受影响。
    {
      const C_SAME = 'N99H000305';
      await rq('/api/scanlog/sync', VT, { items: [
        { k: C_SAME + '|B7|1', code: C_SAME, wt: 1, gl: 'NB03-D-77-08', st: '', cx: false, t: NOW - 3 * H, pn: '6608225548', q: 25, op: '测试同格' },
        { k: C_SAME + '|B7|2', code: C_SAME, wt: 1, gl: 'NB03-D-77-08', st: '', cx: false, t: NOW - 2 * H, pn: '6608225548', q: 25, op: '测试同格' },
      ] });
      T('L3f ★同一格位两条有效流水→必达点名（v167 补盲点）', await waitDb((d) => (d.notifications || []).some((n) => NEWMSG.test(String(n.text || '')) && String(n.text).includes(C_SAME)), 30), true);
      T('L3g ★同格重复在提示里显式标注（现场能区分于格位互斥）', (getDb().notifications || []).some((n) => NEWMSG.test(String(n.text || '')) && String(n.text).includes(C_SAME) && /同格重复/.test(String(n.text))), true);
    }
    T('L3c 两类都留痕进 ops', await waitDb(() => { try { return fs.readdirSync(path.join(TMP, 'ops')).some((f) => { const t = fs.readFileSync(path.join(TMP, 'ops', f), 'utf8'); return t.includes('重复有效流水') && t.includes(C_D1) && t.includes(C_D2); }); } catch (_) { return false } }, 30), true);

    // ===== L4 开关=0 回退（参数接口需管理员角色 token）=====
    { const sp = await rq('/api/admin/params', VA, { values: { lostCallAlertM: 0, coarseAlertOn: 0, dupFlowAlertOn: 0 } });
      T('L4a 参数保存成功（管理员角色）', sp.ok, true);
      await rq('/api/scanlog/sync', VT, { items: [{ k: 'N99H000999|B5|1', code: 'N99H000999', wt: 1, gl: 'H9', st: '', cx: false, t: NOW, pn: '6608225548', q: 25, op: '测试' }] });
      await sleep(1500);
      T('L4b 开关=0：粗码新样本不再告警（回退旧行为）', (getDb().notifications || []).some((x) => /粗码未上账/.test(String(x.text || '')) && String(x.text).includes('N99H000999')), false);
      await rq('/api/admin/params', VA, { values: { lostCallAlertM: 15, coarseAlertOn: 1, dupFlowAlertOn: 1 } }); }

    // ===== L5 去重持久：另起实例带同 DATA_DIR 再跑启动巡检，不得重复告警（主实例不杀，供断言读取）=====
    { const before = lostN(getDb()).length;
      T('L5a 基线：启动轮已有丢单告警', before >= 1, true);
      const inst2 = spawn(process.execPath, [SRV], { env: Object.assign({}, process.env, { DATA_DIR: TMP, PORT: String(PORT + 1) }), stdio: ['ignore', 'pipe', 'pipe'] });
      // 二轮启动巡检在其启动后 ~8s；若主实例 30 分钟定时器恰在此间轮转，因映射已写入同样静默——两种时序期望一致
      T('L5b 去重映射持久（二轮巡检不重复告警）', await waitDb((d) => lostN(d).length > before, 40).then((grew) => !grew), true);
      try { inst2.kill('SIGKILL'); } catch (_) { } }
  } catch (e) {
    T('E0 端到端异常', String((e && e.message) || e), '无异常');
    try { inst.kill('SIGKILL'); } catch (_) { }
  } finally {
    fs.rmSync(TMP, { recursive: true, force: true });
  }
  console.log('\n===== v152 入库三道防线实例验证 ' + (total - fail) + '/' + total + ' 通过 =====');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FATAL', e.message); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { } process.exit(2); });
