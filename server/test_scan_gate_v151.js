// ㉖v151 出库预检闸行为验证（本次把 scanCheck 从"只有网页调用"接成 PDA 直调硬闸）
// 关键风险：闸一旦误拦，车间直调就发不出货。故逐态确认"在架正常框必须放行"，
// 只有真正的高危信号（来源不明 / 已发料重复出库 / 检验中）才 block。
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const SRV = path.join(__dirname, 'server.js');
const SRC = path.join(__dirname, 'data', 'db.json');
const TMP = path.join(__dirname, 'proof_scan_gate');
const PORT = 18152, VT = 'TESTTOK_gate151';
let fail = 0, total = 0;
function T(n, a, b) { total++; const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) { fail++; console.log('FAIL ' + n + '\n  实际=' + JSON.stringify(a) + '\n  期望=' + JSON.stringify(b)); } else console.log('PASS ' + n); }
const rq = (p, tok) => new Promise((resolve, reject) => { http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 12000, headers: tok ? { Authorization: 'Bearer ' + tok } : {} }, (r) => { let s = ''; r.on('data', (c) => s += c); r.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(new Error(p + ' 解析失败(' + r.statusCode + ')')); } }); }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('超时')); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const TAG_LED = 'N99G000101', TAG_REG = 'N99G000102', TAG_GHOST = 'N99G000103', TAG_ISSUED = 'N99G000104', TAG_INSP = 'N99G000105', TAG_RETV = 'N99G000106';
  fs.rmSync(TMP, { recursive: true, force: true }); fs.mkdirSync(path.join(TMP, 'logs'), { recursive: true });
  fs.copyFileSync(SRC, path.join(TMP, 'db.json'));
  const sk = path.join(__dirname, 'data', 'secret.key'); if (fs.existsSync(sk)) fs.copyFileSync(sk, path.join(TMP, 'secret.key'));
  const d0 = JSON.parse(fs.readFileSync(path.join(TMP, 'db.json'), 'utf8'));
  const wh = (d0.users || []).find((x) => x.role === 'warehouse' && x.enabled !== false);
  d0.sessions = d0.sessions || {}; d0.sessions[VT] = { userId: wh.id, dev: 'TEST-GATE', lastSeen: Date.now() };
  d0.ledger = (d0.ledger || []).filter((x) => !String(x.c || '').startsWith('N99G'));
  const row = (c) => ({ c, l: 'NB02-A-07-1F', f: '框', t: Date.now() - 86400000, p: '6608453824', n: '测试件', q: 25, b: '2026-11-01', pid: '', mv: '人工', src: 'NB02-CK-05', by: '测试', hist: [] });
  d0.ledger.push(row(TAG_LED), row(TAG_ISSUED), row(TAG_INSP), row(TAG_RETV));
  // TAG_REG 只在流水、不在账本（地面模式只选区排的"未登记"常态框）——必须能发，否则误伤现场
  d0.scanlog = d0.scanlog || {};
  d0.scanlog[TAG_REG + '|B1|1'] = { code: TAG_REG, wt: 1, gl: 'NB03-A-11-07', st: '', cx: false, t: Date.now() - 3600000, pn: '6608453824', q: 25 };
  d0.scanlog[TAG_ISSUED + '|B1|2'] = { code: TAG_ISSUED, wt: 1, gl: 'NB03-A-11-08', st: '', cx: false, t: Date.now() - 3600000, pn: '6608453824', q: 25 };
  d0.inspects = (d0.inspects || []).filter((x) => !String(x.code || '').startsWith('N99G'));
  d0.inspects.push({ id: 'i_g1', code: TAG_INSP, state: 'atStation', partNo: '6608453824', at: Date.now() });
  d0.inspects.push({ id: 'i_g2', code: TAG_RETV, state: 'waitReturn', partNo: '6608453824', at: Date.now() }); // 判退货=允许走出库通道
  // TAG_ISSUED 挂到活跃领料单已发明细
  d0.requisitions = d0.requisitions || [];
  d0.requisitions.push({ id: 'rq_gate1', no: 'LL-GATE-1', by: wh.id, byName: wh.name, items: [{ partNo: '6608453824', qty: 25, issued: [{ c: TAG_ISSUED, q: 25 }], rush: false }], status: 'accepted', createdAt: new Date().toISOString(), history: [] });
  fs.writeFileSync(path.join(TMP, 'db.json'), JSON.stringify(d0));

  const inst = spawn(process.execPath, [SRV], { env: Object.assign({}, process.env, { DATA_DIR: TMP, PORT: String(PORT) }), stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    let up = false;
    for (let i = 0; i < 45; i++) { await sleep(1000); try { const h = await rq('/api/health', ''); if (h && h.ok) { up = true; break } } catch (_) { } }
    T('H0 隔离服务器就绪', up, true);
    if (!up) throw new Error('服务未起');
    const lvl = async (c) => { const j = await rq('/api/outbound/scanCheck?c=' + c, VT); return [j.ok === true, j.level]; };

    // ===== 正常在架框必须放行（误拦=车间发不出货）=====
    T('G1 在架框不被拦（无活跃单→warn 提示，仍放行）', await lvl(TAG_LED), [true, 'warn']);
    T('G2 仅有流水未上账的常态框不被硬拦（地面未登记框照发）', await lvl(TAG_REG), [true, 'warn']);
    T('G3 检验判退货框允许走直调出账', await lvl(TAG_RETV), [true, 'warn']);
    // ===== 高危信号必须拦 =====
    T('G4 从未入账且无流水=来源不明→硬拦', (await lvl(TAG_GHOST))[1], 'block');
    T('G5 已发料到领料单→硬拦（防重复出库）', (await lvl(TAG_ISSUED))[1], 'block');
    T('G6 检验中(非退货)→硬拦', (await lvl(TAG_INSP))[1], 'block');
    // ===== 拦/放都必须带可执行指引（现场看得懂怎么办）=====
    { const j = await rq('/api/outbound/scanCheck?c=' + TAG_GHOST, VT);
      T('G7 拦截附带原因与处置建议', [!!j.reason, !!j.advice], [true, true]); }
  } catch (e) {
    T('E0 端到端异常', String((e && e.message) || e), '无异常');
  } finally {
    try { inst.kill('SIGKILL'); } catch (_) { }
    fs.rmSync(TMP, { recursive: true, force: true });
  }
  console.log('\n===== v151 出库预检闸验证 ' + (total - fail) + '/' + total + ' 通过 =====');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FATAL', e.message); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { } process.exit(2); });
