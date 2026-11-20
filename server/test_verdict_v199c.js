// ㉖v199c 方案一·归位强制质量结论 · 隔离实例端到端
// 现场实锤(11-17 李庆峰4单)：仓管点「检验完·归位」只填备注"1"即上架, verdict/verdictBy 全空=质量判定被跳过
// 修复：/api/inspect/return 归位前 rec.verdict 必须已存在；且归位不再覆盖结论备注 note2
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const cp = require('child_process');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + i + ']' : ''}`); };

(async () => {
  const TDIR = path.join(__dirname, '_tdata_ver199c');
  const PORT = Number(process.env.VER_PORT || (8400 + Math.floor(Math.random() * 90)));
  fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
  const CODE = 'N26K990001', GND = 'NB02-C-13-2F', STN = 'NB02-CK-11';
  const salt = crypto.randomBytes(16).toString('hex');
  {
    const d0 = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'db.json'), 'utf8'));
    d0.users = [
      { id: 'u_wh', username: 'wh_u', name: '测试仓管', role: 'warehouse', enabled: true, createdAt: new Date().toISOString(), mustChangePw: false, salt, passHash: crypto.scryptSync('Wh#199', salt, 32).toString('hex') },
      { id: 'u_in', username: 'in_u', name: '测试检验', role: 'inspector', enabled: true, createdAt: new Date().toISOString(), mustChangePw: false, salt, passHash: crypto.scryptSync('In#199', salt, 32).toString('hex') },
    ];
    d0.features = JSON.parse(JSON.stringify(d0.features || {}));
    ['agv_control', 'inspect_mode', 'insp_assist', 'collect'].forEach((k) => { d0.features.warehouse[k] = true; });
    d0.features.inspector = { inspect_mode: true, mes_query: true }; // 检验员：能判定不能协助
    d0.ledger = [
      { c: CODE, l: GND, p: 'PNV', f: '1800*1200_2', n: '验证件', t: Date.now() - 600000, q: 5 },
      // 检验下架期间账本仍在原货位(设计)；夹具若缺此行，状态机首轮把 atStation 单判"已出库自动闭环"(11-17 调试实锤)
      { c: 'N26K990002', l: GND, p: 'PNV', f: '1800*1200_2', n: '验证件2', t: Date.now() - 600000, q: 5 },
    ];
    d0.inspects = [
      // 场景A：已到台、无结论（复现现场被钻的形态）
      { id: 'insp_noV', code: CODE, from: GND, station: STN, uid: 'u_in', by: '测试检验', note: '验证', state: 'atStation', at: Date.now() - 60000, arriveAt: Date.now() - 30000, palletType: '1800*1200_2', part: 'PNV', nm: '验证件' },
      // 场景B：检验员本人归位路径（不能事后塞盘—服务器内存库会回写覆盖, 必须初始就在）
      { id: 'insp_inP', code: 'N26K990002', from: GND, station: 'NB02-CK-12', uid: 'u_in', by: '测试检验', note: '验证2', state: 'atStation', at: Date.now(), arriveAt: Date.now(), palletType: '1800*1200_2', part: 'PNV', nm: '验证件' },
    ];
    d0.agvQueue = []; d0.agvDispatchMode = 'dry'; d0.rcsStations = {}; d0.rcsCleared = {}; d0.rcsDone = {}; d0.stnMeta = {}; d0.locReserve = {}; d0.ops = []; d0.ledgerTomb = [];
    fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(d0));
  }
  let srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { SELFTEST_NO_LIVE: '1', ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch('http://127.0.0.1:' + PORT + '/api/health')).ok; } catch (_) {} }
  let out = ''; srv.stdout.on('data', (d) => { out += d; }); srv.stderr.on('data', (d) => { out += d; });
  const API = (p, o = {}, tk) => fetch('http://127.0.0.1:' + PORT + p, { method: o.method || 'GET', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined }).then((r) => r.json());
  try {
    C('护栏 实例启动', up, '');
    const tkWh = (await API('/api/login', { method: 'POST', body: { username: 'wh_u', password: 'Wh#199' } }, null)).token;

    // ① 检验员路径不受闸(无 insp_assist，点归位=当场写结论+请协助, 天然满足)——放最前跑：
    //   后续 sleep 窗口里启动对账环会把闲置 atStation 单收敛掉(本轮实锤)，抢先断言"当场写结论"
    const tkIn = (await API('/api/login', { method: 'POST', body: { username: 'in_u', password: 'In#199' } }, null)).token;
    const r5 = await API('/api/inspect/return', { method: 'POST', body: { id: 'insp_inP', verdict: '通过', note: '' } }, tkIn);
    C('R4 检验员归位不受闸(当场写结论请协助)', r5.ok === true && (r5.rec || {}).verdict === '通过' && (r5.rec || {}).verdictBy === '测试检验', 'v=' + (r5.rec || {}).verdict + ' by=' + (r5.rec || {}).verdictBy);

    // ② 无结论直接归位 → 必须被拒（复现的正是"填1就归位"被钻的那条路）
    const r1 = await API('/api/inspect/return', { method: 'POST', body: { id: 'insp_noV', note: '1' } }, tkWh);
    C('R1 ★★★ 仓管无结论点归位被拒(备注"1"钻不了)', r1.ok === false && /先有检验结论/.test(r1.msg || ''), 'msg=' + String(r1.msg || '').slice(0, 42));
    const dbA = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8')).inspects.find((x) => x.id === 'insp_noV');
    C('R1b 被拒后工单仍在站台待检(未偷跑归位)', dbA.state === 'atStation' && !dbA.verdict, 'state=' + dbA.state);

    // ② 补结论（通过）→ 工单转 waitBack；落盘防抖后核结论三要素
    const r2 = await API('/api/inspect/verdict', { method: 'POST', body: { id: 'insp_noV', verdict: '通过', note: '外观完好' } }, tkWh);
    C('R2 仓管补填结论放行(inspect_mode权限不变,转待协助归位)', r2.ok === true && (r2.rec || {}).state === 'waitBack', 'state=' + (r2.rec || {}).state);
    await sleep(4500); // save 防抖~4s，读盘断言前必须等
    const g2 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8')).inspects.find((x) => x.id === 'insp_noV');
    C('R2b 结论三要素落账', g2.verdict === '通过' && g2.verdictBy === '测试仓管' && !!g2.verdictAt, 'v=' + g2.verdict + ' by=' + g2.verdictBy);
    // ③ 有结论后归位（waitBack 走 assist 腿）放行，且结论留痕全程不被洗
    const r3 = await API('/api/inspect/assist', { method: 'POST', body: { id: 'insp_noV' } }, tkWh);
    C('R3 ★★★ 有结论→协助归位放行(正常闭环路径)', r3.ok === true, 'state=' + (r3.rec || {}).state + ' queued=' + r3.queued);
    await sleep(4500);
    const g3 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8')).inspects.find((x) => x.id === 'insp_noV');
    C('R3b ★★★ 全链跑完结论留痕完整(verdict/note2不被归位备注洗掉)', g3.verdict === '通过' && g3.note2 === '外观完好', 'verdict=' + g3.verdict + ' note2=' + JSON.stringify(g3.note2));

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
