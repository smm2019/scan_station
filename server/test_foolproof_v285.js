// ㉖v285 错发体检口径修正 端到端验证（用生产库只读副本，隔离端口，绝不碰生产）
// 用户截图实锤：网页防呆页"高危 4998"，同框同单重复多行。根因=体检①用 it.code(零件号) 查
// scanlog/ledger(键是 N 框码) 必然全落空 + 证据链漏 seenOut/墓碑。本测试真实起服务调 /api/foolproof，
// 对比"修正前口径(code)"与"修正后口径(barcode+全证据链)"的高危数，证明误报被消除且真隐患不遗漏。
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const SRC = path.join(__dirname, 'data', 'db.json');
const TDIR = path.join(__dirname, '_fp_v285'), PORT = Number(process.env.HS_PORT || 9933);
const BASE = 'http://127.0.0.1:' + PORT;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + String(i).slice(0, 160) + ']' : ''}`); };
const PW = 'Fp#V285!Test';
const mkAdmin = () => { const salt = crypto.randomBytes(16).toString('hex'); return { id: 'u_fp285', username: 'fp285admin', name: '体检验证', role: 'admin', enabled: true, createdAt: Date.now(), mustChangePw: false, salt, passHash: crypto.scryptSync(PW, salt, 32).toString('hex') }; };
const getj = async (p2, tk) => { const r = await fetch(BASE + p2, { headers: tk ? { Authorization: 'Bearer ' + tk } : {} }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
const postj = async (p2, tk, body) => { const r = await fetch(BASE + p2, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: JSON.stringify(body || {}) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };

(async () => {
  let srv;
  const kill = () => { try { if (srv && srv.exitCode === null) cp.execSync(`taskkill /pid ${srv.pid} /T /F`, { stdio: 'ignore', windowsHide: true }); } catch (_) {} };
  try {
    if (!fs.existsSync(SRC)) throw new Error('生产库副本源不存在: ' + SRC);
    fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
    // 复制生产库到临时目录（只读副本，服务所有写入都落在 TDIR，不碰 data/）
    const db0 = JSON.parse(fs.readFileSync(SRC, 'utf8'));
    db0.users = (db0.users || []).filter(u => u.id !== 'u_fp285'); db0.users.push(mkAdmin());
    db0.sessions = db0.sessions || {};
    fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
    // 同步复制 secret.key（token 签名依赖，缺失会重新生成但不影响本测试）
    try { fs.copyFileSync(path.join(__dirname, 'data', 'secret.key'), path.join(TDIR, 'secret.key')); } catch (_) {}

    const probe = await Promise.race([
      fetch(BASE + '/api/health', { signal: AbortSignal.timeout(1000) }).then(() => 'busy').catch(e => ((e && (e.name === 'AbortError' || e.name === 'TimeoutError')) ? 'busy' : 'free')),
      sleep(1400).then(() => 'free')
    ]);
    if (probe === 'busy') throw new Error('端口 ' + PORT + ' 被占用，换 HS_PORT 重跑');

    srv = cp.spawn(process.execPath, ['server.js'], { cwd: __dirname, env: Object.assign({}, process.env, { SELFTEST_NO_LIVE: '1', PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }), stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; srv.stdout.on('data', d => log += d); srv.stderr.on('data', d => log += d);
    const t = setTimeout(() => { console.log('❌ 超时\n' + log.slice(-1200)); kill(); process.exit(1); }, 70000);

    // 等 ready（自愈锁闸门：ready 前 503）
    let up = false, boot = null;
    for (let i = 0; i < 120 && !up; i++) { await sleep(500); try { const h = await getj('/api/health'); if (h.status === 200 && h.json.boot) { boot = h.json.boot; up = h.json.boot.ready === true; } } catch (_) {} }
    C('护栏 隔离实例就绪(ready)', up, 'readyAt boot=' + JSON.stringify(boot && boot.phase));
    if (!up) throw new Error('实例未就绪\n' + log.slice(-1000));

    const lg = await postj('/api/login', null, { username: 'fp285admin', password: PW, dev: 'FP285', kind: 'web' });
    const tk = lg.json.token;
    C('护栏 测试管理员登录', !!tk, 'status=' + lg.status);
    if (!tk) throw new Error('登录失败 ' + JSON.stringify(lg.json).slice(0, 200));

    // 真实调用修正后的体检接口
    const fp = await getj('/api/foolproof', tk);
    C('护栏 foolproof 200', fp.status === 200 && fp.json.ok === true, 'status=' + fp.status);
    const d = fp.json;
    console.log('\n== 修正后 foolproof 输出 ==');
    console.log('总项 count=', d.count, ' bySev=', JSON.stringify(d.bySev), ' byType=', JSON.stringify(d.byType));

    // 核心断言1：错发类高危应大幅下降（修正前 4998，修正后按 barcode+全证据链应接近 0）
    const errCount = (d.byType || {})['错发'] || 0;
    C('★错发类隐患从 4998 降到 <50（误报消除）', errCount < 50, '错发=' + errCount);
    C('★高危总数大幅下降（不再满屏假红）', (d.bySev || {}).high < 100, 'high=' + ((d.bySev || {}).high));

    // 核心断言2：返回的错发行对象必须是 N 框码（不是纯数字零件号）——证明口径已切到 barcode
    const errIssues = (d.issues || []).filter(x => x.type === '错发');
    const allNCode = errIssues.every(x => /^[A-Z]\d{6,}$/.test(String(x.code || '')));
    C('错发行对象=N框码(非零件号)，口径已修正', errIssues.length === 0 || allNCode, errIssues.length ? ('样例 ' + JSON.stringify(errIssues.slice(0, 2).map(x => x.code))) : '错发行=0');

    // 独立复算：用副本库按【修正后口径】算错发数，应与接口一致（交叉验证接口逻辑）
    const sc = {}, led = {}, so = db0.seenOut || {}; const tb = new Set((db0.ledgerTomb || []).map(x => String((x && x.c) || '').toUpperCase()));
    for (const st of Object.values(db0.scanlog || {})) if (!st.cx) sc[String(st.code || '').toUpperCase()] = 1;
    for (const x of (db0.ledger || [])) led[String(x.c || '').toUpperCase()] = 1;
    let calcErr = 0, calcOld = 0;
    for (const o of Object.values(db0.outbound || {})) {
      if (Number(o.status) === 1) continue;
      for (const it of o.items || []) {
        const bc = String(it.barcode || '').toUpperCase(), cd = String(it.code || '').toUpperCase();
        const c = bc || cd;
        if (c && !(sc[c] || led[c] || so[c] || tb.has(c))) calcErr++;
        // 旧口径复算：只用 code 查 scanlog+ledger 两源
        if (cd && !(sc[cd] || led[cd])) calcOld++;
      }
    }
    C('独立复算 旧口径(code,两源)错发数≈4998', Math.abs(calcOld - 4998) < 800 || calcOld > 4000, 'calcOld=' + calcOld);
    C('独立复算 新口径(barcode,四源)错发数≈接口值', Math.abs(calcErr - errCount) <= 5, 'calcErr=' + calcErr + ' 接口=' + errCount);
    C('★新口径错发数极低(真·来源不明几乎没有)', calcErr < 50, 'calcErr=' + calcErr);

    clearTimeout(t);
  } catch (e) {
    C('测试异常', false, e.message);
    try { console.log('--- log尾 ---\n' + log.slice(-800)); } catch (_) {}
  } finally {
    kill(); await sleep(400);
    try { fs.rmSync(TDIR, { recursive: true, force: true }); } catch (_) {}
  }
  console.log(`\n==== v285 错发体检口径修正：${total - fail}/${total} 通过${fail ? '（' + fail + ' 失败）' : ' ✅ 全绿'} ====`);
  process.exit(fail ? 1 : 0);
})();
