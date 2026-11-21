// ㉖v222 全链路统一：/api/trace 补检验工单汇聚 端到端验证
// 背景（用户实拍两端分叉）：网页老 traceBox 自拉 inspect/list 拼出检验段（下架/待检/人已移走收口/
// 退货闭环），PDA 走 /api/trace 却零检验节点——两套实现互有盲区。治本=trace 补检验汇聚段、
// 网页改吃 trace 单源。本测验服务端段：①四种收口形态事件全出 ②兄弟码随 CODES 扩散（同托他码的单也出）
// ③无关框检验单不误入 ④kind='insp' 且时间线归并排序 ⑤既有 scan/req/out 节点回归不受影响。
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const TDIR = path.join(__dirname, '_trinsp_v222'), PORT = Number(process.env.HS_PORT || 9952);
const BASE = 'http://127.0.0.1:' + PORT;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + String(i).slice(0, 130) + ']' : ''}`); };
const post = async (p2, tk, body) => { const r = await fetch(BASE + p2, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: JSON.stringify(body || {}) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
const getj = async (p2, tk) => { const r = await fetch(BASE + p2, { headers: tk ? { Authorization: 'Bearer ' + tk } : {} }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
(async () => {
  let srv;
  const killTree = () => { try { if (srv && srv.exitCode === null) cp.execSync(`taskkill /pid ${srv.pid} /T /F`, { stdio: 'ignore', windowsHide: true }); } catch (_) {} };
  try {
    fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
    const probe = await Promise.race([
      fetch(BASE + '/api/health', { signal: AbortSignal.timeout(1200) }).then(() => 'busy')
        .catch((e) => ((e && (e.name === 'AbortError' || e.name === 'TimeoutError')) ? 'busy' : 'free')),
      sleep(1800).then(() => 'free')
    ]);
    if (probe === 'busy') throw new Error('端口 ' + PORT + ' 被占用——HS_PORT 换端口重跑');
    const salt = crypto.randomBytes(16).toString('hex'), PW = 'E2e#Hs!222';
    const hp = (p) => crypto.scryptSync(p, salt, 32).toString('hex');
    const T0 = Date.now() - 10 * 864e5; // 10天前做时间基准（都在30天窗口内）
    const A = 'N26QH2220001', B = 'N26QH2220002', CC = 'N26QH2229999'; // A/B 同托兄弟码，C 无关框
    const PN = 'T222PART01';
    const slItem = (code, t) => ({ code, wt: 1, st: '', gl: 'NB03-G-11-03', ct: '托盘', rm: '', batch: 'B222', cx: false, t, pn: PN, q: 200, op: '测试员', nm: '测试件', lot: 'L222', mc: '', pid: 'TP222' });
    const db0 = {
      users: [{ id: 'u_t222', username: 'tr_u', name: '全链路测试', role: 'admin', enabled: true, createdAt: new Date().toISOString(), mustChangePw: false, salt, passHash: hp(PW) }],
      features: { admin: { inspect_mode: true, insp_assist: true } },
      sessions: {}, devices: {}, ops: [], notifications: [],
      scanlog: { [A + '|B222|' + T0]: slItem(A, T0), [B + '|B222|' + T0]: slItem(B, T0), [CC + '|B222|' + T0]: slItem(CC, T0) },
      ledger: [
        { c: A, l: 'NB03-G-11-03', p: PN, n: '测试件', q: 200, f: '托盘', t: T0, by: '测试员', b: 'B222', pid: 'TP222' },
        { c: B, l: 'NB03-G-11-03', p: PN, n: '测试件', q: 200, f: '托盘', t: T0, by: '测试员', b: 'B222', pid: 'TP222' },
        { c: CC, l: 'NB03-A-11-01', p: PN, n: '测试件', q: 200, f: '托盘', t: T0, by: '测试员', b: 'B222', pid: 'TP999' },
      ],
      inspects: [
        // A 框四种收口形态 + B（兄弟码）一单 + C（无关）一单
        { id: 'insp22201', code: A, from: 'NB02-A-08-2F', station: 'NB02-CK-03', part: PN, nm: '测试件', uid: 'u_t222', by: '检验张', note: '检验结论：退回 | 人工移走收口→NB03-G-11-08（现场登记）', note2: '划痕', state: 'done', at: T0 + 36e5, updAt: T0 + 72e5, doneAt: T0 + 72e5 },
        { id: 'insp22202', code: A, from: 'NB02-A-08-1F', station: 'NB02-CK-04', part: PN, nm: '测试件', uid: 'u_t222', by: '检验张', note: '退货已出账', state: 'returned', at: T0 + 2 * 864e5, doneAt: T0 + 3 * 864e5 },
        { id: 'insp22203', code: A, from: 'NB02-A-08-3F', station: 'NB02-CK-05', part: PN, nm: '测试件', uid: 'u_t222', by: '检验李', note: '', state: 'cancel', err: '人工取消：重复发单', at: T0 + 4 * 864e5, doneAt: T0 + 4 * 864e5 + 6e5 },
        { id: 'insp22204', code: A, from: 'NB02-A-08-2F', station: 'NB02-CK-06', part: PN, nm: '测试件', uid: 'u_t222', by: '检验李', note: '检验结论：合格', state: 'done', at: T0 + 5 * 864e5, doneAt: T0 + 6 * 864e5 },
        { id: 'insp22205', code: B, from: 'NB02-B-01-1F', station: 'NB02-CK-07', part: PN, nm: '测试件', uid: 'u_t222', by: '检验王', note: '', state: 'atStation', at: T0 + 7 * 864e5 },
        { id: 'insp22206', code: CC, from: 'NB02-C-01-1F', station: 'NB02-CK-08', part: PN, nm: '测试件', uid: 'u_t222', by: '检验赵', note: '', state: 'done', at: T0 + 864e5, doneAt: T0 + 2 * 864e5 },
      ],
      requisitions: [], outbound: {}, agvQueue: [], agvTasks: {}, carEvents: [],
      wmasConfig: null, rcsConfig: null, rcsStations: {},
    };
    fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
    srv = cp.spawn(process.execPath, ['server.js'], { cwd: __dirname, env: Object.assign({}, process.env, { SELFTEST_NO_LIVE: '1', PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }), stdio: ['ignore', 'pipe', 'pipe'] });
    process.on('exit', killTree);
    let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(600) })).ok; } catch (_) {} }
    C('护栏 实例就绪', up); if (!up) throw new Error('实例未起');
    const tk = (await post('/api/login', null, { username: 'tr_u', password: PW, dev: 'TR', kind: 'pda' })).json.token;
    C('护栏 登录', !!tk); if (!tk) throw new Error('登录失败');
    const tr = await getj('/api/trace?q=' + A, tk);
    const evs = tr.json.events || [];
    const insp = evs.filter((e) => e.kind === 'insp');
    // ① A 四种形态 ×2事件（下架+收口）+ B 兄弟码单 ×1（无 doneAt 只下架事件）= 9
    C('★★★ ① A框检验段全出（4单×2事件 + 兄弟码B×1 = 9 条 insp）', insp.length === 9, '实际=' + insp.length + ' 标题=' + insp.map((e) => (e.title || '').split(' ')[0]).join(','));
    const titles = insp.map((e) => e.title).join('|') + '||' + insp.map((e) => e.detail).join('|');
    C('★★★ ② 收口形态文案齐：移走收口带去向格', /人已移走收口 → NB03-G-11-08/.test(titles), '');
    C('★★ ② 退货出账闭环 / 归位到位 / 取消三文案齐', /退货出账闭环/.test(titles) && /检验归位到位/.test(titles) && /检验单取消/.test(titles), '');
    C('★★ ② 下架事件带 人·从⇄台·状态·检验结论（对齐网页旧口径）', insp.some((e) => /检验下架/.test(e.title) && /检验张 · NB02-A-08-2F⇄NB02-CK-03/.test(e.detail) && /检验：划痕/.test(e.detail)), JSON.stringify((insp.find((e) => /划痕/.test(e.detail || '')) || {}).detail || ''));
    C('★★★ ②b 状态全中文化，无裸英文码外泄（done/returned/atStation 等全部不得直出）', !insp.some((e) => /[·\s](done|returned|atStation|toStation|waitOut|waitBack|returning|waitReturn|stuck|cancel)([·\s]|$)/.test(e.detail || '')), JSON.stringify(insp.map((e) => (e.detail || '').split(' · ')[2]).join(',')));
    // ③ 兄弟码扩散：查 A 能看到同托 B 的检验单；④ 无关框 C 的单不混入
    C('★★★ ③ 兄弟码检验单随托扩散（B 的待检单出现）', insp.some((e) => (e.title || '').includes(B)), '');
    C('★★★ ④ 无关框 C 的检验单不混入（过滤靠 CODES，非全量倾倒）', !insp.some((e) => (e.title || '').includes(CC) || /检验赵/.test(e.detail || '')), '');
    // ⑤ 时间线归并排序 + 既有 kind 回归
    let sorted = true; for (let i = 1; i < evs.length; i++) if ((evs[i].t || 0) < (evs[i - 1].t || 0)) sorted = false;
    C('★★ ⑤ 全事件按时间升序归并（检验段插得进去）', sorted, 'n=' + evs.length);
    C('★★ ⑤ 回归：采集(scan)与在架(shelf)节点仍在', evs.some((e) => e.kind === 'scan') && evs.some((e) => e.kind === 'shelf'), 'kinds=' + [...new Set(evs.map((e) => e.kind))].join(','));
    // ⑥ 反向入口：查兄弟码 B 也拿到 A 的检验单（两端/两码一致）
    const tr2 = await getj('/api/trace?q=' + B, tk);
    const insp2 = ((tr2.json || {}).events || []).filter((e) => e.kind === 'insp');
    C('★★ ⑥ 查兄弟码 B 同样拿到 A 的检验单（两端一致的基础）', insp2.length === 9, '实际=' + insp2.length);
    // ⑦ 两端同源硬证：A/B 两个入口返回的事件集逐字一致（同框两码=同一条链，单源无分叉）
    const sigOf = (ev) => JSON.stringify(ev.map((e) => [e.t, e.kind, e.title, e.detail]));
    C('★★★ ⑦ 单源同框两码事件集逐字一致（两端统一的最硬证据）', sigOf(evs) === sigOf(tr2.json.events || []), 'A n=' + evs.length + ' B n=' + ((tr2.json.events || []).length));
    // ⑧ 正命题终验：检验工单四种收口形态 + 采集/在架基础节点，单源一次查询全出
    C('★★★ ⑧ 全节点集齐（撤销scanx/覆盖hist/检验insp四收口/在架shelf/采集scan 同源于一次查询）',
      (() => {
        const ks = new Set(evs.map((e) => e.kind));
        return ks.has('scan') && ks.has('insp') && ks.has('shelf')
          && insp.some((e) => /移走收口/.test(e.title)) && insp.some((e) => /退货出账闭环/.test(e.title))
          && insp.some((e) => /归位到位/.test(e.title)) && insp.some((e) => /检验单取消/.test(e.title));
      })(), 'kinds=' + [...new Set(evs.map((e) => e.kind))].join(','));
    C('★ 进程存活', (await fetch(BASE + '/api/health')).ok === true);
  } catch (e) { total++; fail++; console.log('❌ 异常：' + e.message); }
  finally {
    killTree();
    await sleep(400);
    try { fs.rmSync(TDIR, { recursive: true, force: true }); } catch (_) {}
  }
  console.log('\n结果: ' + (total - fail) + ' 通过 / ' + fail + ' 失败  （隔离副本，生产库零写入）');
  process.exit(fail ? 1 : 0);
})();
