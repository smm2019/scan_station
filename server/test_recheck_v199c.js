// ㉖v199c 再检必留因（检验闭环入口闸）· 隔离实例端到端
// 用户需求：已完成检验的框再次检验必须弹窗写原因；与方案一"归位必有结论"配成闭环
// 闸：/api/inspect/start 对 inspSeen 有记录的框（含同框兄弟码）不带 recheckReason → 409 needRecheck
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const cp = require('child_process');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + i + ']' : ''}`); };

(async () => {
  const TDIR = path.join(__dirname, '_tdata_rc199c');
  const PORT = Number(process.env.RC_PORT || (8500 + Math.floor(Math.random() * 90)));
  fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
  const CODE = 'N26K880001', SIB = 'N26K880002', FRESH = 'N26K880009', GND = 'NB02-A-20-1F', GND2 = 'NB02-A-20-2F';
  const salt = crypto.randomBytes(16).toString('hex');
  {
    const d0 = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'db.json'), 'utf8'));
    d0.users = [{ id: 'u_wh', username: 'wh_u', name: '测试仓管', role: 'warehouse', enabled: true, createdAt: new Date().toISOString(), mustChangePw: false, salt, passHash: crypto.scryptSync('Wh#199', salt, 32).toString('hex') }];
    d0.features = JSON.parse(JSON.stringify(d0.features || {}));
    ['agv_control', 'inspect_mode', 'insp_assist', 'collect'].forEach((k) => { d0.features.warehouse[k] = true; });
    d0.ledger = [
      { c: CODE, l: GND, p: 'PNR', f: '1800*1200_2', n: '再检件', t: Date.now() - 600000, q: 5 },
      { c: SIB, l: GND, p: 'PNR', f: '1800*1200_2', n: '再检件', t: Date.now() - 600000, q: 5 }, // 同框兄弟码(同l同p)
      { c: FRESH, l: GND2, p: 'PNF', f: '1800*1200_2', n: '首检件', t: Date.now() - 600000, q: 5 },
    ];
    d0.inspSeen = { [SIB]: { v: '通过', at: Date.now() - 864e5, pn: 'PNR', n: '再检件', by: '李检验' } };
    d0.inspects = []; d0.agvQueue = []; d0.agvDispatchMode = 'dry'; d0.rcsStations = {}; d0.rcsCleared = {}; d0.rcsDone = {}; d0.stnMeta = {}; d0.locReserve = {}; d0.ops = []; d0.ledgerTomb = [];
    fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(d0));
  }
  let srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch('http://127.0.0.1:' + PORT + '/api/health')).ok; } catch (_) {} }
  let out = ''; srv.stdout.on('data', (d) => { out += d; }); srv.stderr.on('data', (d) => { out += d; });
  const API = (p, o = {}, tk) => fetch('http://127.0.0.1:' + PORT + p, { method: o.method || 'GET', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined }).then((r) => r.json());
  try {
    C('护栏 实例启动', up, '');
    const tk = (await API('/api/login', { method: 'POST', body: { username: 'wh_u', password: 'Wh#199' } }, null)).token;

    // ① 已检框无原因再发 → 409 needRecheck（兄弟码 SIB 有记录，CODE 同框也须拦=inspSibs 口径）
    const r1 = await API('/api/inspect/start', { method: 'POST', body: { from: GND, note: '再看一眼' } }, tk);
    C('R1 ★★★ 已检框(兄弟码留痕)无原因再发被拒409', r1.ok === false && r1.code === 'needRecheck', 'code=' + r1.code + ' msg=' + String(r1.msg || '').slice(0, 40));
    C('R1b 拒回带前检信息供前端弹窗展示', r1.prev && r1.prev.v === '通过' && r1.prev.by === '李检验', JSON.stringify(r1.prev || null).slice(0, 60));

    // ② 带原因再发 → 放行，原因拼入工单 note + ops 单独留痕
    const r2 = await API('/api/inspect/start', { method: 'POST', body: { from: GND, note: '复核', recheckReason: '上级要求复核批次' } }, tk);
    C('R2 ★★★ 带再检原因放行发单', r2.ok === true, 'msg=' + String(r2.msg || '').slice(0, 40));
    await sleep(4500);
    const dbA = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    const rec = (dbA.inspects || [])[0] || {};
    C('R2b 再检原因+前检信息拼入工单note(两端可见)', /再检原因：上级要求复核批次/.test(rec.note || '') && /前检：李检验 判通过/.test(rec.note || ''), String(rec.note || '').slice(0, 70));
    C('R2c ops 活动流单独留痕', (dbA.ops || []).some((o) => o.act === '检验再发单' && /上级要求复核批次/.test(String(o.det || ''))), '');

    // ③ 首次检验(无 inspSeen)不受影响, 不带原因可发
    const r3 = await API('/api/inspect/start', { method: 'POST', body: { from: GND2, note: '首检' } }, tk);
    C('R3 未检框首检正常放行(闸不误伤)', r3.ok === true, 'msg=' + String(r3.msg || '').slice(0, 36));

    C('★ 进程无未捕获异常', !/Unhandled|TypeError: |ReferenceError/.test(out), out.split('\n').slice(-2).join(' ').slice(0, 90));
  } catch (e) {
    total++; fail++; console.log('❌ 异常：' + e.message + '\n' + String(out).split('\n').slice(-8).join('\n'));
  } finally {
    try { srv.kill(); } catch (_) {}
    await sleep(400);
    try { srv.kill('SIGKILL'); } catch (_) {}
    try { fs.rmSync(TDIR, { recursive: true, force: true }); } catch (_) {}
  }
  console.log('\n结果: ' + (total - fail) + ' 通过 / ' + fail + ' 失败  （隔离副本，生产库零写入）');
  process.exit(fail ? 1 : 0);
})();
