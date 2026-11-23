// ㉖v235 重复单空转防护 端到端验证（隔离实例，生产库零写入）
// 背景（用户 11-23 拍板三层修法）：胡志文 34 秒双单同人同零件同数量，第二单被接单后无货可派
//   全靠"跳过"收尾，旧文案"短装：跳过(0件)"污染短装统计且 ready 态无法取消只能挂死。
// 三层：①建单 10 分钟同组合软拦(409 dup_req)+confirmDup 直通+急料豁免带 dupWarn；
//   ②接单带"同一需求更早单在处理"软警示(warn)；③零发料收尾改"空转"文案+idleSpin 放行取消，
//   有实物/有转账的 ready 单取消仍拦死（红线）。
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const TDIR = path.join(__dirname, '_dup_v235'), PORT = Number(process.env.HS_PORT || 9967);
const BASE = 'http://127.0.0.1:' + PORT;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + String(i).slice(0, 150) + ']' : ''}`); };
const post = async (p2, tk, body) => { const r = await fetch(BASE + p2, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: JSON.stringify(body || {}) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
(async () => {
  let srv;
  const killTreeOf = (p) => { try { if (p && p.exitCode === null) cp.execSync(`taskkill /pid ${p.pid} /T /F`, { stdio: 'ignore', windowsHide: true }); } catch (_) {} };
  const killTree = () => killTreeOf(srv);
  try {
    fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
    const probe = await Promise.race([
      fetch(BASE + '/api/health', { signal: AbortSignal.timeout(1200) }).then(() => 'busy')
        .catch((e) => ((e && (e.name === 'AbortError' || e.name === 'TimeoutError')) ? 'busy' : 'free')),
      sleep(1800).then(() => 'free')
    ]);
    if (probe === 'busy') throw new Error('端口 ' + PORT + ' 被占用——HS_PORT 换端口重跑');
    const mk = (id, name, role) => { const salt = crypto.randomBytes(16).toString('hex'); return { id, username: 'u_' + id.slice(2), name, role, enabled: true, createdAt: new Date().toISOString(), mustChangePw: false, salt, passHash: crypto.scryptSync('E2e#Dp!235', salt, 32).toString('hex') }; };
    const PW = 'E2e#Dp!235';
    const db0 = {
      users: [mk('u_mat235', '测试物料员', 'material'), mk('u_whs235', '测试仓管', 'warehouse'), mk('u_adm235', '测试管理', 'admin')],
      sessions: {}, devices: {}, ops: [], notifications: [],
      requisitions: [], outbound: {}, ledger: [], scanlog: {}, agvQueue: [], inspects: [], seenIn: {}, seenOut: {},
      features: { material: { requisition: true }, warehouse: { requisition: true }, inspector: {}, admin: { requisition: true, admin_panel: true } },
      rcsConfig: null, wmasConfig: null, rcsStations: {}, params: null,
    };
    fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
    srv = cp.spawn(process.execPath, ['server.js'], { cwd: __dirname, env: Object.assign({}, process.env, { SELFTEST_NO_LIVE: '1', PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }), stdio: ['ignore', 'pipe', 'pipe'] });
    process.on('exit', killTree);
    let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(600) })).ok; } catch (_) {} }
    C('护栏 实例就绪', up); if (!up) throw new Error('实例未起');
    const tkMat = (await post('/api/login', null, { username: 'u_mat235', password: PW, dev: 'DP', kind: 'pda' })).json.token;
    const tkWh = (await post('/api/login', null, { username: 'u_whs235', password: PW, dev: 'DW', kind: 'pda' })).json.token;
    C('护栏 登录', !!tkMat && !!tkWh); if (!tkMat || !tkWh) throw new Error('登录失败');
    const item = [{ partNo: '6609990001', itemName: '测试件', qty: 767 }];
    const r1 = await post('/api/requisitions', tkMat, { items: item });
    C('护栏 首单提交成功', r1.json.ok === true, JSON.stringify(r1.json).slice(0, 90));
    const id1 = ((r1.json.req || {}).id) || '';

    // —— 第1层：建单软拦 ——
    const r2 = await post('/api/requisitions', tkMat, { items: item });
    C('★★★ ① 10分钟内同人同零件同数量→409 dup_req+dups详情', r2.status === 409 && r2.json.code === 'dup_req' && Array.isArray(r2.json.dups) && r2.json.dups.length === 1 && r2.json.dups[0].no === (r1.json.req || {}).no, JSON.stringify({ st: r2.status, cd: r2.json.code, d: (r2.json.dups || []).length }));
    const r3 = await post('/api/requisitions', tkMat, { items: [{ partNo: '6609990002', itemName: '另一件', qty: 100 }] });
    C('★★ ② 不同零件号正常放行', r3.json.ok === true, JSON.stringify(r3.json).slice(0, 60));
    const r4 = await post('/api/requisitions', tkMat, { items: item, confirmDup: 1 });
    C('★★★ ③ confirmDup=1 直通（合法补料出路）', r4.json.ok === true, JSON.stringify(r4.json).slice(0, 90));
    const id4 = ((r4.json.req || {}).id) || '';
    const r5 = await post('/api/requisitions', tkMat, { items: item, rush: true });
    C('★★ ④ 急料豁免不硬拦：放行且响应带 dupWarn', r5.json.ok === true && Array.isArray(r5.json.dupWarn) && r5.json.dupWarn.length >= 1, JSON.stringify({ ok: r5.json.ok, w: (r5.json.dupWarn || []).length }));

    // —— 第2层：接单重复警示（第二张同组合单被接单时 warn）——
    const a4 = await post(`/api/requisitions/${id4}/accept`, tkWh, {});
    C('★★★ ⑤ 重复单接单成功+warn"更早同需求单在处理中"', a4.json.ok === true && typeof a4.json.warn === 'string' && a4.json.warn.includes('同一需求'), JSON.stringify(a4.json.warn || '').slice(0, 120));
    const a1 = await post(`/api/requisitions/${id1}/accept`, tkWh, {});
    C('★★ ⑥ 首单（更早那张）接单不受警示干扰', a1.json.ok === true && !a1.json.warn, JSON.stringify({ ok: a1.json.ok, w: !!a1.json.warn }));

    // —— 第3层：空转收口+取消放行 ——
    const sk = await post(`/api/requisitions/${id4}/skip`, tkWh, { partNo: '6609990001', reason: '无货' });
    const rq4 = (sk.json.req || {});
    C('★★★ ⑦ 零发料收尾=空转文案非"短装"(idleSpin=1、历史含"空转")', sk.json.ok === true && rq4.status === 'ready' && rq4.idleSpin === 1 && JSON.stringify(rq4.history || []).includes('空转') && !JSON.stringify((rq4.history || []).slice(-1)).includes('短装'), JSON.stringify({ st: rq4.status, sp: rq4.idleSpin }));
    const c4 = await post(`/api/requisitions/${id4}/cancel`, tkMat, { reason: '重复提交' });
    C('★★★ ⑧ 空转单 ready 态可取消（下单人一键出路）', c4.json.ok === true && (c4.json.req || {}).status === 'cancelled', JSON.stringify({ ok: c4.json.ok, st: (c4.json.req || {}).status }));

    // 红线：有转MES的 ready 单不可取消。构造必须"改文件→重启加载"：服务运行中是内存态，
    // 直接改文件会被下一次 save() 覆写（首跑⑨假通过的根因=内存里根本没有 transferred）。
    const st1 = srv; killTreeOf(st1); await sleep(600);
    const dbNow = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    const rq1 = dbNow.requisitions.find((x) => x.id === id1);
    rq1.status = 'ready';
    rq1.items[0].transferred = true; rq1.items[0].transferQty = 767; rq1.items[0].issued = [{ c: 'N26K9900001', q: 767 }];
    fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(dbNow));
    srv = cp.spawn(process.execPath, ['server.js'], { cwd: __dirname, env: Object.assign({}, process.env, { SELFTEST_NO_LIVE: '1', PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }), stdio: ['ignore', 'pipe', 'pipe'] });
    let up2 = false; for (let i = 0; i < 40 && !up2; i++) { await sleep(250); try { up2 = (await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(600) })).ok; } catch (_) {} }
    C('护栏 改库重启成功（红线夹具经重启加载）', up2); if (!up2) throw new Error('实例未重启');
    const tkMat2 = (await post('/api/login', null, { username: 'u_mat235', password: PW, dev: 'DP2', kind: 'pda' })).json.token;
    const c1 = await post(`/api/requisitions/${id1}/cancel`, tkMat2, { reason: '想反悔' });
    C('★★★ ⑨ 红线：有转MES的ready单取消仍拦死（状态闸优先于空转放行）', c1.json.ok !== true && /不能整单取消|不可取消/.test(c1.json.msg || ''), JSON.stringify({ ok: c1.json.ok, m: (c1.json.msg || '').slice(0, 50) }));

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
