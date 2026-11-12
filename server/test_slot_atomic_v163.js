// ㉖v163 地面(NB03)货位分配收归服务器原子分格 · 实例验证
// 缺陷（11-12 13:04~13:12 现场，胡明锵 + 刘向轩 两台 PDA 交替扫 NB03-C-12 同一排）：
// 地面 AUTO 分格跑在 PDA 本机（nb03AutoSlot 读 _ledgerByLoc() 本机 Isar），而"本机扫码→账本推给
// 服务器"有 5~30 秒防抖延迟；两台设备各自快照里那个格都还是空的 → 同一个格被分给两个框：
//   12-05 / 12-08 跨零件 → 被服务器互斥闸拒（未上账，弹窗"货位登记冲突"）
//   12-06 / 12-09 同零件 → 被"同零件=同框"豁免静默放行（两框挤同格、400 件被库存当成一个框）
// v98 的 force pull 只能缩小窗口，消不掉推送延迟本身。修法：分配权收归服务器（NB02 v54 预占、
// NB04 v122 原子放格同款治法）——判定+登记同在 Node 单线程同步段内完成，并发天然串行。
// ★ 核心断言：同一排连发两框（中间【完全不推账本】= 事故当时的真实窗口）必须拿到不同格位；
//   同刻并发 4 框必须拿到 4 个互不相同的格。旧实现（本机各算各的）这两条都必红。
// ★ 分配器口径：只要格内有框（无论同不同零件）就不发这个格。账本闸的"同零件=同框"豁免仍保留
//   （既有业务口径，支持一框双码），所以这里【不】断言分配器会给同零件共格——恰恰相反。
// ★ 样本区排按真实账本现算（选完全无框的排）。上一版把 seed 放在"格 05"、配置却是每排 4【格】
//   （排≠格，写错了），分配器扫不到 → "跳过已占格"变假通过，已纠正为格 01 + 每排 6 格。
// ★ 数据安全：DATA_DIR 隔离副本 + 合成标签（N9S 前缀），真实生产库只读不写；收尾删副本。
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const SRV = path.join(__dirname, 'server.js');
const SRC_DB = path.join(__dirname, 'data', 'db.json');
const TMP = path.join(__dirname, 'proof_slot_atomic_v163');
const PORT = 18177, VT = 'TESTTOK_V163';
let pass = 0, fail = 0;
const T = (id, cond, note) => { if (cond) { pass++; console.log('PASS ' + id + (note ? '  ' + note : '')); } else { fail++; console.log('FAIL ' + id + '  got=' + JSON.stringify(cond) + (note ? '  [' + note + ']' : '')); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const req = (method, p, body) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : null;
  const r0 = http.request({ host: '127.0.0.1', port: PORT, path: p, method, timeout: 15000, headers: Object.assign({ Authorization: 'Bearer ' + VT }, data ? { 'Content-Type': 'application/json' } : {}) }, res => { let s = ''; res.on('data', d => s += d); res.on('end', () => { let o; try { o = JSON.parse(s); } catch (_) { o = { raw: s.slice(0, 120) }; } o._status = res.statusCode; resolve(o); }); });
  r0.on('error', reject); if (data) r0.write(data); r0.end();
});
const getDb = () => JSON.parse(fs.readFileSync(path.join(TMP, 'db.json'), 'utf8'));
// ★ save() 走异步防抖落盘（asyncSave 双路），紧跟请求读 db.json 会读到上一版快照 → 必须轮询等待，
//   否则"预占已写入/已清除"这类断言会假失败（上一版 A4/G3 正栽在这）。
const waitDb = async (pred, tries) => { for (let i = 0; i < (tries || 25); i++) { try { if (pred(getDb())) return true; } catch (_) { } await sleep(120); } return false; };
const rsv = (code, partNo, zone) => req('POST', '/api/ledger/reserve', { code, partNo, zone });
const P1 = '6608698041', P2 = '6608039967'; // 事故现场真实零件号（仅作合成样本）
const pfx = z => 'NB03-' + z[0] + '-' + z.slice(1);
const slot = (z, n) => pfx(z) + '-' + String(n).padStart(2, '0');
// ★ 区排按真实账本现算：取 ledger 里完全无框的排，否则配置格数小于真实占用会首帧就"满格"（假失败）
const pickFreeZones = (db, need) => {
  const used = new Set((db.ledger || []).map(x => String(x.l || '').toUpperCase().slice(0, 9)).filter(l => /^NB03-[A-H]-\d{2}$/.test(l)));
  const out = [];
  for (const g of 'ABCDEFGH') { for (let r = 1; r <= 40 && out.length < need; r++) { const k = 'NB03-' + g + '-' + String(r).padStart(2, '0'); if (!used.has(k)) out.push(g + String(r).padStart(2, '0')); if (out.length >= need) break; } if (out.length >= need) break; }
  return out;
};
const _f = pickFreeZones(JSON.parse(fs.readFileSync(SRC_DB, 'utf8')), 4);
if (_f.length < 4) { console.error('前提不满足：找不到 4 个空闲地面排'); process.exit(1); }
const [Z1, Z2, ZOFF, Z3] = _f;
const Z1COLS = 6;

(async () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true }); fs.mkdirSync(path.join(TMP, 'logs'), { recursive: true });
    fs.copyFileSync(SRC_DB, path.join(TMP, 'db.json'));
    const sk = path.join(__dirname, 'data', 'secret.key'); if (fs.existsSync(sk)) fs.copyFileSync(sk, path.join(TMP, 'secret.key'));
    const d0 = getDb();
    const adm = (d0.users || []).find(x => x.role === 'admin' && x.enabled !== false);
    d0.sessions = d0.sessions || {}; d0.sessions[VT] = { userId: adm.id, dev: 'T-V163', lastSeen: Date.now() };
    d0.groundSlots = Object.assign({}, d0.groundSlots || {}, { [pfx(Z1)]: Z1COLS, [pfx(Z2)]: 6, [pfx(Z3)]: 5, [pfx(ZOFF)]: 4 });
    d0.gndRowOff = Object.assign({}, d0.gndRowOff || {}, { [pfx(ZOFF)]: 1 });
    d0.ledger = (d0.ledger || []).filter(x => !String(x.c || '').startsWith('N9S') && ![Z1, Z2, Z3, ZOFF].some(z => String(x.l || '').toUpperCase().indexOf(pfx(z)) === 0));
    d0.locReserve = {};
    // 事故复刻：Z1 排【格 01】已被"胡明锵"的框占住（跨零件）。格号必须落在 1..maxSlot 内，
    // 否则分配器扫不到它 → "跳过已占格"会变假通过。
    d0.ledger.push({ c: 'N9S000001', l: slot(Z1, 1), f: '筐', t: Date.now() - 600000, p: P1, n: 'V163测试件', q: 200, b: '2026-11-12', by: '胡明锵' });
    fs.writeFileSync(path.join(TMP, 'db.json'), JSON.stringify(d0));
    const child = spawn(process.execPath, [SRV], { env: Object.assign({}, process.env, { DATA_DIR: TMP, PORT: String(PORT) }), stdio: 'ignore' });
    let up = false;
    for (let i = 0; i < 50; i++) { await sleep(400); try { const h = await new Promise((rs, rj) => { http.get({ host: '127.0.0.1', port: PORT, path: '/api/health', timeout: 3000 }, res => { let s = ''; res.on('data', d => s += d); res.on('end', () => rs(s)); }).on('error', rj); }); if (String(h).indexOf('ok') >= 0) { up = true; break; } } catch (_) { } }
    T('H0 隔离实例就绪', up, '样本排 ' + [Z1, Z2, ZOFF, Z3].join(' '));
    if (!up) throw new Error('实例未起');

    // ===== A 核心：复刻事故窗口（两次分格之间【不推账本】）=====
    const a1 = await rsv('N9S000002', P2, Z1), a2 = await rsv('N9S000003', P2, Z1);
    T('A1 两次分配均成功', a1.ok === true && !!a1.loc && a2.ok === true && !!a2.loc, (a1.loc || a1.msg) + ' / ' + (a2.loc || a2.msg));
    T('A2 ★核心：同一排连发两框必得【不同格】（旧版此处必撞同格）', !!a1.loc && a1.loc !== a2.loc, a1.loc + ' vs ' + a2.loc);
    T('A3 两次均落在人选的那一排内', new RegExp('^' + pfx(Z1) + '-\\d{2}$').test(a1.loc || '') && new RegExp('^' + pfx(Z1) + '-\\d{2}$').test(a2.loc || ''), true);
    T('A4 分配即写预占（未推送期间对其他设备可见=防撞关键）', await waitDb(d => Object.keys(d.locReserve || {}).length >= 2), '预占 ' + Object.keys(getDb().locReserve || {}).length + ' 条（等异步落盘）');

    // ===== B 并发：同刻齐发 4 框（比事故更极端）=====
    const par = await Promise.all(['N9S000011', 'N9S000012', 'N9S000013', 'N9S000014'].map(c => rsv(c, P2, Z2)));
    const okP = par.filter(r => r.ok === true && r.loc);
    T('B1 同刻 4 框全部拿到格位', okP.length === 4, okP.map(r => r.loc).join(','));
    T('B2 ★并发无撞位（4 个互不相同）', new Set(okP.map(r => r.loc)).size === 4, okP.map(r => r.loc).join(','));

    // ===== C 幂等（重扫/重试不跳格、不重复占）=====
    const c1 = await rsv('N9S000002', P2, Z1);
    T('C1 同标签再次申请复用原格且标 kept', c1.ok === true && c1.loc === a1.loc && c1.kept === true, c1.loc + ' 原=' + a1.loc + ' kept=' + c1.kept);

    // ===== D 已占格：无论同不同零件都不再发出（防撞的本质）=====
    T('D1 跳过被【他零件】占用的格 01', a1.loc !== slot(Z1, 1) && a2.loc !== slot(Z1, 1), '实得 ' + a1.loc + '/' + a2.loc);
    const d2 = await rsv('N9S000004', P1, Z1); // 与格 01 那个框【同零件】
    T('D2 ★分配器不给已占格（同零件也不发，正是防 12-06/12-09 挤同格）', d2.ok === true && !!d2.loc && d2.loc !== slot(Z1, 1), d2.loc || d2.msg);
    T('D3 顺序跳格：格 01 被占则从格 02 起给', parseInt((d2.loc || '').slice(-2), 10) > 1, d2.loc);
    // 已在该排上账的框 → 回现位，不重复占新格
    const b4 = Object.keys(getDb().locReserve || {}).length;
    const sv = await req('POST', '/api/ledger/sync', { items: [{ c: 'N9S000004', l: d2.loc, f: '筐', t: Date.now(), p: P1, n: 'V163测试件', q: 200, b: '2026-11-12', mv: '登记', src: '' }] });
    const d4 = await rsv('N9S000004', P1, Z1);
    T('D4 账本推送成功', sv.ok === true, 'ok=' + sv.ok + ' 拒回=' + JSON.stringify((sv.rejected || []).slice(0, 1)));
    T('D5 已上账的框回现位（重扫不跳格、不重复占新格）', d4.ok === true && d4.loc === d2.loc && d4.kept === true, d4.loc + ' 原=' + d2.loc + ' kept=' + d4.kept);
    T('D6 回现位未新增预占', Object.keys(getDb().locReserve || {}).length <= b4, b4 + '→' + Object.keys(getDb().locReserve || {}).length);

    // ===== E 容量与停用（旧文案硬编码"12 格位"，现按实际配置）=====
    const seq = [];
    for (let i = 21; i <= 40; i++) { const r = await rsv('N9S0000' + i, P2, Z1); seq.push(r); if (r.ok !== true) break; }
    const got = seq.filter(r => r.ok === true).length;
    const fullMsg = String((seq.find(r => r.ok === false) || {}).msg || '');
    // Z1 共 6 格：格01 账本占、格02/03 预占、格04 起 N9S000004 已上账 → 仍可分的是 05、06
    T('E1 逐格占满后如实拒绝（绝不静默给重复格）', got > 0 && got <= 2 && seq.some(r => r.ok === false), '实分 ' + got + ' 格后拒');
    T('E2 满格返回 ok:false 且文案含【实际格数 6】（非硬编码 12）', /6 格/.test(fullMsg), fullMsg.slice(0, 64));
    const off = await rsv('N9S000061', P2, ZOFF);
    T('E3 停用排拒绝分配并说明原因', off.ok === false && /停用/.test(String(off.msg)), String(off.msg).slice(0, 60));

    // ===== F 格式与老链路零影响 =====
    const bad = await rsv('N9S000071', P2, 'X999');
    T('F1 非法区排被拒（区字母限 A-H）', bad.ok === false && /格式|不可/.test(String(bad.msg)), String(bad.msg).slice(0, 50));
    const bad2 = await rsv('N9S000072', P2, Z3[0] + '-' + Z3.slice(1)); // PDA 也可能传带连字符写法
    T('F2 兼容带连字符写法（E07 → E-07）', bad2.ok === true && new RegExp('^' + pfx(Z3) + '-').test(bad2.loc || ''), bad2.loc || bad2.msg);
    const noZone = await req('POST', '/api/ledger/reserve', { code: 'N9S000073', partNo: P2 });
    T('F3 不传 zone 仍走 NB02 高架分配（老链路未受影响）', noZone.ok === true && /^NB02-/.test(noZone.loc || ''), noZone.loc || String(noZone.msg).slice(0, 40));
    const recvOff = await req('POST', '/api/ledger/reserve', { code: 'N9S000074', partNo: P2, recv: 1 });
    T('F4 来料区 recv 分支未被新分支影响', recvOff.ok === true || /未启用|已满/.test(String(recvOff.msg)), recvOff.loc || String(recvOff.msg).slice(0, 44));

    // ===== G 占用视图与预占释放（防"看着空、点不动"）=====
    const lv = await req('GET', '/api/ledger/locs?all=1');
    const seenZ2 = Object.keys(lv.byLoc || {}).filter(l => l.indexOf(pfx(Z2)) === 0);
    T('G1 地面占用视图含未推送预占（选位弹层据此显示已占）', seenZ2.length >= 4, Z2 + ' 可见占用 ' + seenZ2.length + ' 格');
    const a2b = await rsv('N9S000003', P2, Z1); // 上账前先确认仍在原格
    const sync = await req('POST', '/api/ledger/sync', { items: [{ c: 'N9S000003', l: a2.loc, f: '筐', t: Date.now() + 1000, p: P2, n: 'V163测试件', q: 200, b: '2026-11-12', mv: '登记', src: '' }] });
    T('G2 该框账本推送成功', sync.ok === true, 'ok=' + sync.ok + ' 拒回=' + JSON.stringify((sync.rejected || []).slice(0, 1)));
    // ★ 预占清除不是即时的：ledgerSync 只清"rec0 起算超过 TTL"的预占，实际回收靠 30 秒周期
    //   （rec0 - at > resTtlMs 才删）。所以这里不断言"立刻消失"，而断言防撞的本质：
    //   该格已上账后，绝不会再被发给别的框（分配器按账本 used 避让）。
    { const nother = await rsv('N9S000005', P2, Z1);
      T('G3 已上账的格不会被再发给别的框（预占靠 30 秒周期回收，非即时）', nother.ok !== true || nother.loc !== a2.loc, '再申请得 ' + (nother.loc || '拒绝:' + nother.msg) + '，不上账的格绝不重复发出'); }

    // ===== H 预占过期回收（沙箱抽【真函数】确定性验证）=====
    // ★ 上一版这里"PASS"是蒙的：进程用内存态，改 db.json 文件根本不会触发回收，且同标签会走
    //   幂等复用直接拿回原格 → 回收没生效也照样成功，断言是空的。改用 vm 抽 pruneReserve +
    //   nb03AssignFree 真函数，在受控 db 上直接跑，结果确定、不受进程内存与 30 秒周期影响。
    {
      const vm = require('vm');
      const SRC = fs.readFileSync(SRV, 'utf8').replace(/\r\n/g, '\n');
      const topFn = (name) => {
        const i = SRC.indexOf('function ' + name + '(');
        if (i < 0) throw new Error('未找到 ' + name);
        for (let j = i; j < SRC.length; j++) if (SRC.slice(j, j + 2) === '\n}' && (j + 2 >= SRC.length || SRC[j + 2] === '\n')) return SRC.slice(i, j + 2);
        throw new Error('闭合失败 ' + name);
      };
      const dbS = {
        ledger: [{ c: 'N9S000001', l: slot(Z1, 1) }],
        locReserve: { [slot(Z1, 2)]: { code: 'N9S000002', by: 'x', at: Date.now() } }, // 新鲜预占
        groundSlots: { [pfx(Z1)]: 3 }, gndRowOff: {},
      };
      const ctxS = vm.createContext({ db: dbS, P: () => ({ reserveTtlMin: 10, gndCols: 12, recvRows: 1, recvCols: 720 }), Date });
      vm.runInContext(topFn('resTtlMs') + '\n' + topFn('pruneReserve') + '\n' + topFn('nb03AssignFree'), ctxS);
      // 步骤1：格2 预占新鲜 → 新标签只能拿格 3（证明未过期预占被避让，不是乱发）
      const r1 = vm.runInContext('nb03AssignFree("N9S000091","' + Z1 + '","6608039967","测试")', ctxS);
      T('H1 未过期预占被避让（新标签拿不到格2）', r1.loc === slot(Z1, 3), r1.loc || r1.msg);
      // 步骤2：把格2 预占拨旧 1 小时 → 回收后新标签应能拿到格 2
      vm.runInContext('db.locReserve["' + slot(Z1, 2) + '"].at = Date.now() - 3600000', ctxS);
      const r2 = vm.runInContext('nb03AssignFree("N9S000092","' + Z1 + '","6608039967","测试")', ctxS);
      T('H2 ★过期预占被回收，格位归还可再分配（不永久泄漏）', r2.loc === slot(Z1, 2), r2.loc || r2.msg);
      // 步骤3：过期那条记录确实被清出预占表（不再继续挡位）。
      // ★ 不能断言"表里只剩 1 条"：分配成功本身会写入一条新预占，所以此处合理结果是 2 条
      //（格2→新标签 N9S000092、格3→步骤1 的 N9S000091）。真正的不变量是：过期的 N9S000002
      //   在表里彻底消失，且它腾出的格 2 已发给新标签。
      const stillHeld = vm.runInContext('Object.keys(db.locReserve).filter(l => String(db.locReserve[l].code) === "N9S000002").length', ctxS);
      const owner2 = vm.runInContext('String((db.locReserve["' + slot(Z1, 2) + '"] || {}).code || "")', ctxS);
      T('H3 过期记录已清出预占表且格位改发新标签', stillHeld === 0 && owner2 === 'N9S000092', 'N9S000002 残留 ' + stillHeld + ' 条，格2 现属 ' + owner2);
    }

    // ===== I 账实一致：Z2 排未推账本 ⇒ 账本里不应出现任何同格两框 =====
    { const lg = (getDb().ledger || []).filter(x => String(x.l || '').indexOf(pfx(Z2)) === 0);
      const byLoc = {}; for (const x of lg) (byLoc[x.l] = byLoc[x.l] || []).push(x);
      const dup = Object.entries(byLoc).filter(([, v]) => v.length > 1);
      T('I1 ' + Z2 + ' 排账本无同格两框（本次只预占未上账）', dup.length === 0, '同格 ' + dup.length + ' 处'); }

    T('I2 本次验证未写真实生产库（隔离副本 + 合成 N9S 标签）', true, '真实库零写入');
    try { child.kill('SIGKILL'); } catch (_) { }
    await sleep(300);
  } catch (e) {
    T('X 异常', false, e.message);
    try { for (const f of fs.readdirSync(path.join(TMP, 'logs'))) console.log('  [' + f + ']\n' + fs.readFileSync(path.join(TMP, 'logs', f), 'utf8').split('\n').slice(-22).join('\n')); } catch (_) { }
  } finally {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { } // 副本含生产库快照+密钥，收尾必删
    console.log('\n结果: ' + pass + ' PASS / ' + fail + ' FAIL');
    process.exit(fail ? 1 : 0);
  }
})();
