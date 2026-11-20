// ㉖v202 方案B：LIVE 盘点基准=服务器权威账本聚合（/api/inventory/baseline）端到端验证
// 为什么必须真跑：假盘盈根因是"发起机本机视角"（11-18 任务183：账本有226件、基准账面=0），
// 只有真起实例真调端点，才能证明聚合读的是服务器账本而不是任何设备本地状态。
// 关键用例：①183形态复刻——干净账本行(格位+pn+q)必入 books/locs 账面（本机视角缺陷不可能复现）
// ②台挂中转位(-CK-)不入基准（与旧在库口径一致）③缺件号码剔除但 noPn 可查（宁缺勿假不静默）
// ④无盘点权限角色 403 ⑤同托/同件多行按零件号与货位正确合并。隔离 DATA_DIR，生产库零写入。
const fs = require('fs'), path = require('path'), crypto = require('crypto'), cp = require('child_process');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + i + ']' : ''}`); };
(async () => {
  const TDIR = path.join(__dirname, '_tdata_bl202');
  const PORT = Number(process.env.BL_PORT || (9700 + Math.floor(Math.random() * 40)));
  fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
  const salt = crypto.randomBytes(16).toString('hex');
  const mkU = (id, un, nm, role) => ({ id, username: un, name: nm, role, enabled: true, createdAt: new Date().toISOString(), mustChangePw: false, salt, passHash: crypto.scryptSync('Bl#202', salt, 32).toString('hex') });
  const d0 = {
    users: [mkU('u_wh', 'bl_wh', '盘点仓管', 'warehouse'), mkU('u_mt', 'bl_mt', '无盘点员', 'material')],
    features: { material: { inventory: false }, warehouse: { inventory: true }, inspector: {}, admin: { inventory: true } },
    sessions: {}, requisitions: [], notifications: [], outbound: {}, exports: [], ops: [], devices: {}, scanlog: {},
    ledger: [
      // 183 复刻：120009 形态——账本干净行 226 件@地面格（服务器聚合必须看见）
      { c: 'N26K120009', l: 'NB03-C-15-05', p: '6608460402', n: '后横梁左下支撑支架', q: 226, t: Date.now() - 6 * 864e5, by: '刘向轩', f: '1800*1200_2' },
      // 同零件兄弟框（必须与上行合并进同一零件行，且货位各自成行）
      { c: 'N26K120010', l: 'NB03-C-15-07', p: '6608460402', n: '后横梁左下支撑支架', q: 440, t: Date.now() - 6 * 864e5, by: '刘向轩', f: '1800*1200_2' },
      // 台挂中转位：AGV 已送台待搬——不入基准（扫到按账外/待归位口径）
      { c: 'N26K180027', l: 'NB02-CK-05', p: 'PNSTN', n: '台挂件', q: 100, t: Date.now() - 864e5, by: '胡明锵' },
      // 缺零件号：剔除且 noPn 可见（不静默吞）
      { c: 'N26K180028', l: 'NB03-A-12-03', q: 300, t: Date.now() - 864e5, by: '胡明锵' },
      // 同托两码同位同件：零件行加一件、货位行加一件、codes 含两码
      { c: 'BXK1', l: 'NB02-B-06-2F', p: 'PNPAL', n: '整托件', q: 50, t: Date.now() - 3 * 864e5, by: '宋明明', pid: 'PALX' },
      { c: 'BXK2', l: 'NB02-B-06-2F', p: 'PNPAL', n: '整托件', q: 50, t: Date.now() - 3 * 864e5, by: '宋明明', pid: 'PALX' },
    ],
  };
  fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(d0));
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { SELFTEST_NO_LIVE: '1', ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch('http://127.0.0.1:' + PORT + '/api/health')).ok; } catch (_) {} }
  let out = ''; srv.stdout.on('data', (d) => { out += d; }); srv.stderr.on('data', (d) => { out += d; });
  const API = async (p2, tk) => { const r = await fetch('http://127.0.0.1:' + PORT + p2, { headers: tk ? { Authorization: 'Bearer ' + tk } : {} }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
  const lg = async (un) => (await (await fetch('http://127.0.0.1:' + PORT + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: un, password: 'Bl#202' }) })).json()).token;
  try {
    const tkW = up && await lg('bl_wh'), tkM = up && await lg('bl_mt');
    C('护栏 启动+双账号登录', up && !!tkW && !!tkM, '');
    const j = await API('/api/inventory/baseline', tkW);
    const B = j.json, books = {}, locs = {};
    (B.books || []).forEach((x) => { books[x.pn] = x; });
    (B.locs || []).forEach((x) => { locs[x.loc + '|' + x.pn] = x; });
    C('T1 ★★★ 183复刻：226件账本行进零件账面(6608460402 book=666=226+440)', j.status === 200 && B.ok === true && books['6608460402'] && books['6608460402'].book === 666 && books['6608460402'].boxes === 2, JSON.stringify(books['6608460402'] || null));
    C('T2 ★★★ 货位级 C-15-05 行存在且 book=226（旧本机视角此行整行缺失=假盘盈根因）', locs['NB03-C-15-05|6608460402'] && locs['NB03-C-15-05|6608460402'].book === 226 && (locs['NB03-C-15-05|6608460402'].codes || []).join(',').includes('N26K120009'), JSON.stringify(locs['NB03-C-15-05|6608460402'] || null));
    C('T3 台挂中转位(-CK-)不入基准', !books['PNSTN'] && !locs['NB02-CK-05|PNSTN'], '');
    C('T4 ★★★ 缺件号码不入账面但 noPn 点名(宁缺勿假不静默)', !locs['NB03-A-12-03|'] && Array.isArray(B.noPn) && B.noPn.some((x) => x.c === 'N26K180028'), JSON.stringify(B.noPn || null));
    C('T5 整托两码：零件行=100/货位行=100/码清单含两码(同位同件合并)', books['PNPAL'] && books['PNPAL'].book === 100 && books['PNPAL'].boxes === 2 && locs['NB02-B-06-2F|PNPAL'] && (locs['NB02-B-06-2F|PNPAL'].codes || []).length === 2, JSON.stringify(locs['NB02-B-06-2F|PNPAL'] || null).slice(0, 120));
    const jm = await API('/api/inventory/baseline', tkM);
    C('T6 无盘点权限角色 403（端点鉴权与盘点同闸）', jm.status === 403, 'status=' + jm.status);
    C('T7 全量元数据可留痕(rev/srvAt/srvBy/total)', typeof B.rev === 'number' && B.total === 6, 'total=' + B.total + ' rev=' + B.rev);
    C('★ 进程无未捕获异常', !/Unhandled|TypeError: |ReferenceError/.test(out), out.split('\n').slice(-2).join(' ').slice(0, 90));
  } catch (e) { total++; fail++; console.log('❌ 异常：' + e.message); } finally {
    try { srv.kill(); } catch (_) {}
    await sleep(400); try { srv.kill('SIGKILL'); } catch (_) {}
    try { fs.rmSync(TDIR, { recursive: true, force: true }); } catch (_) {}
  }
  console.log('\n结果: ' + (total - fail) + ' 通过 / ' + fail + ' 失败  （隔离副本，生产库零写入）');
  process.exit(fail ? 1 : 0);
})();
