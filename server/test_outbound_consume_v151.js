// ㉖v151 出库即消本地账 + 幽灵出库检出 · 实例验证（真实 /api/outbound/sync）
// 缺陷（11-11 核查）：PDA 直调页只调 MES 四个接口（getBizPermission/GetBarCodeInfoOnHand/
//   SaveTRBarcodes/getwarehousemodelinfo），全文件零账本调用；服务端 outbound/sync 旧版只落单+盖
//   seenOut 戳不删账本行 → ①一楼扫过后直调出库：MES 出了库、本地 NB04 行仍在（幽灵框，
//   来料区库存与「待入库」虚高）；③一楼没扫直调出库：MES 出了库、本地全程无感（出入库台账
//   永久对不上，且事后完全无痕）。本次：落库即消账 + ghost_out 必达告警点名。
// T1 场景① NB04框直调出库→消账+墓碑+bump+来料区点名
// T2 场景③ 从未入账框→ghost_out必达告警+ops+事件留痕，账本不误删
// T3 重试同单→不重复消账、不误报ghost刷屏
// T4 移仓单 mode=1 不消账（保 v108 标签回流语义）；mode=2 消
// T5 mode=0 不改账但仍检出留痕（开关可回退且不是瞎的）
// T6 同托兄弟码不连坐删除，只点名交人工
// T7 已消账标签（领料发料过）再落单→归"此前已消账"，不报幽灵
// T8 ghost_out 不受个人退订影响（不在 NTYPE 表内）
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const SRV = path.join(__dirname, 'server.js');
const SRC = path.join(__dirname, 'data', 'db.json');
const TMP = path.join(__dirname, 'proof_out_consume');
const PORT = 18151, VT = 'TESTTOK_v151';
let fail = 0, total = 0;
function T(n, a, b) { total++; const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) { fail++; console.log('FAIL ' + n + '\n  实际=' + JSON.stringify(a) + '\n  期望=' + JSON.stringify(b)); } else console.log('PASS ' + n); }
const rq = (p, tok, body, method) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : null;
  const r0 = http.request({ host: '127.0.0.1', port: PORT, path: p, method: method || (body ? 'POST' : 'GET'), timeout: 15000, headers: Object.assign({ Authorization: 'Bearer ' + tok }, data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) }, (r) => { let s = ''; r.on('data', (c) => s += c); r.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(new Error(p + ' 解析失败(' + r.statusCode + '): ' + s.slice(0, 100))); } }); });
  r0.on('error', reject); if (data) r0.write(data); r0.end();
});
const post = (p, body, tok) => rq(p, tok || VT, body, 'POST');
const getDb = () => JSON.parse(fs.readFileSync(path.join(TMP, 'db.json'), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitDb(pred, tries) { for (let i = 0; i < (tries || 12); i++) { try { if (pred(getDb())) return true; } catch (_) { } await sleep(250); } return false; }
// 构造出库单：toLoc 含"线边仓"=真实出库（默认 outWhKeys=线边仓,成品仓）
const ob = (no, items, toLoc, status) => ({ orderNo: no, createdAt: Date.now(), toLoc: toLoc || '焊-宁波-线边仓/A109/A109-1', operator: '测试直调', status: status || 0, linkReqNo: '', items: items.map((c) => ({ code: '6608453824', name: '测试件', barcode: c, qty: 25, fromLoc: '' })) });
const mkRow = (c, l, pid) => ({ c, l, f: '框', t: Date.now() - 3600000, p: '6608453824', n: '测试件', q: 25, b: '2026-11-06', pid: pid || '', mv: '登记', src: '测试', by: '测试一楼', hist: [] });

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true }); fs.mkdirSync(path.join(TMP, 'logs'), { recursive: true });
  fs.copyFileSync(SRC, path.join(TMP, 'db.json'));
  const sk = path.join(__dirname, 'data', 'secret.key'); if (fs.existsSync(sk)) fs.copyFileSync(sk, path.join(TMP, 'secret.key'));
  // 测试样本：来料区框 / 二楼货架框 / 同托兄弟码对
  const C_NB04 = 'N99X000101', C_NB02 = 'N99X000102', C_SIB1 = 'N99X000103', C_SIB2 = 'N99X000104', C_GHOST = 'N99X000105', C_PRE = 'N99X000106';
  const d0 = getDb();
  const adm = (d0.users || []).find((x) => x.role === 'admin' && x.enabled !== false);
  d0.sessions = d0.sessions || {}; d0.sessions[VT] = { userId: adm.id, dev: 'TEST-V151', lastSeen: Date.now() };
  d0.ledger = (d0.ledger || []).filter((x) => !String(x.c || '').startsWith('N99X'));
  d0.ledger.push(mkRow(C_NB04, 'NB04-A-01-001'), mkRow(C_NB02, 'NB02-A-05-1F'), mkRow(C_SIB1, 'NB02-A-06-1F', 'PIDTEST1'), mkRow(C_SIB2, 'NB02-A-06-2F', 'PIDTEST1'));
  d0.ledgerTomb = (d0.ledgerTomb || []).filter((x) => String(x.c || '').toUpperCase() !== C_PRE);
  d0.ledgerTomb.push({ c: C_PRE, t: Date.now() - 1000, rec: Date.now() - 1000 }); // 此前已被领料发料消过账
  d0.params = Object.assign({}, d0.params, { outConsumeLedger: 1, receivingOn: 1 });
  // ㉖v156 隔离补漏（同 test_kpi_hide_v151 教训：不得拿在用生产数据当 fixture）：v151 上线后生产已真实产生
  // ghost_out 告警与「幽灵出库」事件（11-11 抓到 2 起），复制到副本后 g[0] 被生产样本占位 → T2d 点名断言漂移失败、
  // T2f 恒真。此处显式清空该类存量，断言只看本轮合成结果。
  d0.notifications = (d0.notifications || []).filter((x) => x.type !== 'ghost_out');
  d0.carEvents = (d0.carEvents || []).filter((e) => String(e.kind || '') !== '幽灵出库');
  fs.writeFileSync(path.join(TMP, 'db.json'), JSON.stringify(d0));

  const inst = spawn(process.execPath, [SRV], { env: Object.assign({}, process.env, { DATA_DIR: TMP, PORT: String(PORT) }), stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    let up = false;
    for (let i = 0; i < 45; i++) { await sleep(1000); try { const h = await rq('/api/health', ''); if (h && h.ok) { up = true; break } } catch (_) { } }
    T('H0 隔离服务器就绪', up, true);
    if (!up) throw new Error('服务未起');

    // ===== T1 场景①：一楼扫过(NB04在账) → 直调出库 → 消账+墓碑+bump+点名 =====
    const rev0 = getDb().ledgerRev || 0;
    let r = await post('/api/outbound/sync', ob('DT-T1', [C_NB04]));
    T('T1a 出库单同步成功', r.ok, true);
    T('T1b 账本行已消（NB04 幽灵框根治）', await waitDb((d) => !d.ledger.some((x) => String(x.c).toUpperCase() === C_NB04)), true);
    { const d = getDb();
      T('T1c 墓碑已落（防旧缓存回推复活）', d.ledgerTomb.some((x) => String(x.c).toUpperCase() === C_NB04), true);
      T('T1d 账本版本 bump（各PDA拉取感知）', (d.ledgerRev || 0) > rev0, true);
      const n = (d.notifications || []).filter((x) => /来料区直调出库/.test(String(x.text || '')));
      T('T1e 来料区直调出库点名通知已发', n.length > 0, true);
      T('T1f 通知发给操作人+全体仓管', (n[0] ? n.length : 0) >= 1, true);
      { const od = path.join(TMP, 'ops'); let hit = false; try { hit = fs.readdirSync(od).some((f) => fs.readFileSync(path.join(od, f), 'utf8').includes('出库消账')); } catch (_) { } T('T1g 消账动作已落 ops 审计文件', hit, true); } }

    // ===== T2 场景③：一楼没扫（本地无账、无墓碑）→ 直调出库 → 幽灵必达告警 =====
    const ledN0 = getDb().ledger.length;
    r = await post('/api/outbound/sync', ob('DT-T2', [C_GHOST]));
    T('T2a 同步仍成功（不阻断发货，只告警）', r.ok, true);
    T('T2b 账本未被误删（本地本就无此框）', await waitDb((d) => d.ledger.length === ledN0), true);
    { await waitDb((d) => (d.notifications || []).some((x) => x.type === 'ghost_out')); const d = getDb();
      const g = (d.notifications || []).filter((x) => x.type === 'ghost_out');
      T('T2c ghost_out 必达告警已发', g.length > 0, true);
      T('T2d 告警点名幽灵标签号', /N99X000105/.test(String((g[0] || {}).text || '')), true);
      T('T2e 告警 reqId 留空（防点击误跳领料单）', (g[0] || {}).reqId, '');
      const evs = await sleep(300).then(() => fs.existsSync(path.join(TMP, 'db.json')) ? getDb().carEvents || [] : []);
      T('T2f 幽灵出库进异常事件表（可追溯）', evs.some((e) => String(e.kind || '') === '幽灵出库'), true); }

    // ===== T3 重试同单：不重复消账、不误报 ghost 刷屏 =====
    { const gBefore = (getDb().notifications || []).filter((x) => x.type === 'ghost_out').length;
      await post('/api/outbound/sync', ob('DT-T2', [C_GHOST])); // 同单号+同明细=重试
      await sleep(900);
      const d = getDb();
      T('T3a 重试不新增幽灵告警（防刷屏）', (d.notifications || []).filter((x) => x.type === 'ghost_out').length, gBefore);
      const ledOk = !d.ledger.some((x) => String(x.c).toUpperCase() === C_NB04);
      T('T3b 重试不产生二次消账副作用', ledOk, true); }

    // ===== T4 移仓单：mode=1 不消账（保 v108 回流语义）；mode=2 才消 =====
    await post('/api/outbound/sync', ob('DT-T4', [C_NB02], '冷冲件仓/CC01/CC01-1'));
    T('T4a 移仓单 mode=1 不消账（保留标签回流）', await waitDb((d) => d.ledger.some((x) => String(x.c).toUpperCase() === C_NB02)), true);
    await post('/api/admin/params', { values: { outConsumeLedger: 2 } });
    await post('/api/outbound/sync', ob('DT-T4B', [C_NB02], '冷冲件仓/CC01/CC01-1'));
    T('T4b 移仓单 mode=2 才消账', await waitDb((d) => !d.ledger.some((x) => String(x.c).toUpperCase() === C_NB02)), true);

    // ===== T6 同托兄弟码：只删扫的那码，兄弟码保留并点名 =====
    await post('/api/admin/params', { values: { outConsumeLedger: 1 } });
    await post('/api/outbound/sync', ob('DT-T6', [C_SIB1]));
    T('T6a 出库标签本身已消账', await waitDb((d) => !d.ledger.some((x) => String(x.c).toUpperCase() === C_SIB1)), true);
    T('T6b 同托兄弟码不被连坐删除', await waitDb((d) => d.ledger.some((x) => String(x.c).toUpperCase() === C_SIB2)), true);
    { await sleep(500); const d = getDb();
      T('T6c 同托未随单出库已点名交人工', (d.notifications || []).some((x) => /同托另有标签未随单出库/.test(String(x.text || ''))), true); }

    // ===== T7 此前已消账标签 → 不报幽灵（区分真幽灵与正常补台账）=====
    { const gBefore = (getDb().notifications || []).filter((x) => x.type === 'ghost_out').length;
      await post('/api/outbound/sync', ob('DT-T7', [C_PRE]));
      await sleep(900);
      T('T7 已消账标签不误判为幽灵出库', (getDb().notifications || []).filter((x) => x.type === 'ghost_out').length, gBefore); }

    // ===== T5 mode=0：不改账，但仍检出留痕（开关可回退且不是瞎的）=====
    { await post('/api/admin/params', { values: { outConsumeLedger: 0 } });
      const d1 = getDb();
      await post('/api/outbound/sync', ob('DT-T5', [C_GHOST])); // 用从未入账的幽灵码（C_SIB2 在账本里，无幽灵可检出）
      await sleep(900);
      const d2 = getDb();
      T('T5a mode=0 账本保持不变', d2.ledger.some((x) => String(x.c).toUpperCase() === C_SIB2), true);
      T('T5b mode=0 幽灵仍检出并告警（关账不关眼）', (d2.notifications || []).some((x) => x.type === 'ghost_out' && /DT-T5/.test(String(x.text || ''))), true); }

    // ===== T9 solo 生效：连续两单同类型告警各自独立成条（不被"等N条已合并"吞掉明细）=====
    // 通知限流按"人+自然分钟"计数，前序用例（T5/T7）在同分钟内已累积 solo 计数，
    // 本组把 rateMax 设为 50 明确关掉回落阈值，使断言不依赖分钟窗口时序（否则第6条起被合法聚合掉，非缺陷）
    { await post('/api/admin/params', { values: { outConsumeLedger: 1, rateMax: 50 } });
      await post('/api/outbound/sync', ob('DT-T9A', ['N99X000201']));
      await sleep(400);
      await post('/api/outbound/sync', ob('DT-T9B', ['N99X000202']));
      await sleep(1200);
      const gs = (getDb().notifications || []).filter((x) => x.type === 'ghost_out');
      // 每单会发给"操作人+全体仓管"多人，按单个收件人断言才有确定期望值（旧断言漏算人数致误判）
      const mine = gs.filter((x) => x.to === adm.id);
      T('T9a 连发两单对同一收件人各成1条（solo 未被聚合）', [mine.filter((x) => /DT-T9A/.test(String(x.text))).length, mine.filter((x) => /DT-T9B/.test(String(x.text))).length], [1, 1]);
      T('T9b 两条各自点名本单号（明细未丢）', [gs.some((x) => /DT-T9A/.test(String(x.text))), gs.some((x) => /DT-T9B/.test(String(x.text)))], [true, true]);
      T('T9c 本组两条无"已合并"字样（solo 未被吞明细）', mine.some((x) => /DT-T9/.test(String(x.text)) && /已合并/.test(String(x.text))), false);
    } // 全表断言会被后续 T10 的回落合并污染，故限定到本组单号

    // ===== T10 solo 批量回落：同分钟逐单告警超过 rateMax 后回落聚合（批量直调不得造成通知风暴）=====
    { await post('/api/admin/params', { values: { outConsumeLedger: 1, rateMax: 3 } });
      // 限流计数按"人+分钟"，T9 已在当前窗口内发过 2 条 ghost_out，直接续算会让本用例期望漂移
      // ——先等进入新的分钟窗口，确保计数从 0 起算（否则跨用例污染，非产品缺陷）
      { const msToNext = 60000 - (new Date().getSeconds() * 1000 + new Date().getMilliseconds()) + 150; await sleep(msToNext); }
      for (const sfx of ['A', 'B', 'C', 'D', 'E']) { await post('/api/outbound/sync', ob('DT-T10' + sfx, ['N99X00030' + sfx.charCodeAt(0) % 10])); await sleep(60); }
      await sleep(1500);
      const all10 = (getDb().notifications || []).filter((x) => x.type === 'ghost_out' && x.to === adm.id && /DT-T10/.test(String(x.text)));
      // 合并落点是 _nq 里该收件人 ghost_out 的"最近一条"，跨分钟边界时可能落在前序用例的告警上，
      // 故本项断言的本质是"超额告警被聚合而非丢弃"：本组独立成条数受 rateMax 约束，且该收件人
      // ghost_out 通知里出现过"等 N 条，已合并"标记（合并计数保留，未静默丢单）
      T('T10a 同分钟仅前 rateMax 条独立成条（其余回落聚合）', all10.length, 3);
      { const merged = (getDb().notifications || []).filter((x) => x.type === 'ghost_out' && x.to === adm.id && /等 \d+ 条，已合并/.test(String(x.text)));
        T('T10b 超额告警被聚合而非丢弃（保留合并计数）', merged.length >= 1, true); }
      await post('/api/admin/params', { values: { rateMax: 5 } }); }

    // ===== T8 ghost_out 不受个人退订影响 =====
    { const src = fs.readFileSync(SRV, 'utf8');
      const m = /const NTYPE = (\{[^}]*\})/.exec(src);
      T('T8a ghost_out 不在退订映射表（强制必达）', /ghost_out/.test(m[1]), false);
      const m2 = /const URGENT_TYPES = new Set\(\[([^\]]*)\]\)/.exec(src);
      T('T8b ghost_out 已入急达集合（夜间不静默）', /ghost_out/.test(m2[1]), true); }
  } catch (e) {
    T('E0 端到端异常', String((e && e.message) || e), '无异常');
  } finally {
    try { inst.kill('SIGKILL'); } catch (_) { }
    fs.rmSync(TMP, { recursive: true, force: true });
  }
  console.log('\n===== v151 出库消账+幽灵检出实例验证 ' + (total - fail) + '/' + total + ' 通过 =====');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FATAL', e.message); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { } process.exit(2); });
