// ㉖v158 字典乱码（"◆◇外"）三层修复 · 实例验证
// 现场（11-11 零件页搜 5548）：同一零件号出现三行，第三行 "6608225548-◆◇外 · 账本0框" 为脏条目。
// 字节铁证：脏键 hex 尾部 = 2D EFBFBD EFBFBD E5A496 —— "海"(E6B5B7) 被从【字节中间切断】成 E6B5|B7，
//   两半各解码失败各吐 1 个 U+FFFD，"外"(E5A496) 完整存活。全库仅此 2 个零件号中招（均为 -海外 后缀）。
// 根因：readBody 旧写法 let data='' + data += c，每个 TCP 分块 Buffer 被【隐式按 utf8 单独解码】，
//   跨块边界的汉字必碎。旁证：同一段代码 nm/mc 有 \uFFFD 清洗、pn 没有 → 流水被洗干净、pn 带乱码
//   经 feedDict 沉淀进 itemDict/mitemDict 永久留污（那条流水后被干净重推覆盖 → 字典脏、流水干净）。
// 三层修复：①readBody 改 Buffer.concat 后一次解码 ②feedDict/feedMitem 键级拒绝乱码 pn ③启动清理存量脏键
// ★ 数据安全：清理只在【合成数据】上跑；删除前提=存在同零件号干净同族键且名称逐字相同（零信息损失），
//   无同族同值则保留待人工核查；被删键值另存 dictFfdCleanLogV158；真实生产库全程只读、不写。
const fs = require('fs');
const vm = require('vm');
const { Readable } = require('stream');
const SRC = fs.readFileSync(__dirname + '/server.js', 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const T = (id, cond, note) => { if (cond) { pass++; console.log('PASS ' + id + (note ? '  ' + note : '')); } else { fail++; console.log('FAIL ' + id + (note ? '  ' + note : '')); } };

// 抽顶层函数：闭合 } 独占行首（server.js 排版规约）
function top(name) {
  const i = SRC.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('未找到 ' + name);
  for (let j = i; j < SRC.length; j++) if (SRC.slice(j, j + 2) === '\n}' && (j + 2 >= SRC.length || SRC[j + 2] === '\n')) return SRC.slice(i, j + 2);
  throw new Error('闭合失败 ' + name);
}

const PN = '6608225548-海外';
const NM = '10-极氪EX1H副车架右后安装板（海外）-HSTD241425成品';
const DIRTY = '6608225548-\uFFFD\uFFFD外';
const FFD = /[\uFFFD]/;

// ================= L1 readBody 根因：跨字节块边界必须无损 =================
{
  const code = top('readBody');
  const body = JSON.stringify({ items: [{ k: 'A|B|1', code: 'N9Z000001', pn: PN, nm: NM, q: 100 }] });
  const buf = Buffer.from(body, 'utf8');
  const hi = buf.indexOf(Buffer.from('海', 'utf8'));
  const run = (cuts) => new Promise((resolve, reject) => {
    const rs = new Readable({ read() { } });
    const p = new Function(code + '\nreturn readBody(arguments[0]);');
    p(rs).then(resolve, reject);
    for (const c of cuts) rs.push(c);
    rs.push(null);
  });
  (async () => {
    let okAll = true, detail = '';
    // 切点覆盖：海字第1、2字节后（必碎）+ 字边界（本就不碎）+ nm 内 + 整块 + 空块
    const cases = [
      { cuts: [buf.slice(0, hi + 1), buf.slice(hi + 1)], why: '切在海字第1字节后' },
      { cuts: [buf.slice(0, hi + 2), buf.slice(hi + 2)], why: '切在海字第2字节后（生产事故形态）' },
      { cuts: [buf.slice(0, hi), buf.slice(hi)], why: '切在海字前边界' },
      { cuts: [buf.slice(0, 10), buf.slice(10, hi + 2), buf.slice(hi + 2)], why: '三段切碎' },
      { cuts: [buf.slice(0, 1), buf.slice(1)], why: '逐字节切（最极端）' },
    ];
    for (const c of cases) {
      let out = null;
      try { out = await run(c.cuts); } catch (e) { out = { err: e.message }; }
      const pn = out && out.items && out.items[0] ? out.items[0].pn : null;
      const ok = pn === PN;
      if (!ok) { okAll = false; detail += ' [' + c.why + '→' + JSON.stringify(pn) + ']'; }
    }
    T('L1a 任意切块方式下 pn 字节完好', okAll, okAll ? cases.length + ' 种切法全通过' : detail);
    // 对照：旧写法在"生产事故形态"下确实碎成 FFFD（证明测试有效，非空过）
    const oldWay = ((b) => { let d = ''; const chs = [b.slice(0, hi + 2), b.slice(hi + 2)]; for (const c of chs) d += c; return d; })(buf);
    const oldPn = JSON.parse(oldWay).items[0].pn;
    T('L1b 旧写法对照确会产乱码', oldPn === DIRTY, JSON.stringify(oldPn) + '（与生产脏键同形态）');
    T('L1c 乱码形态与生产脏键一致', Buffer.from(oldPn, 'utf8').toString('hex').slice(-24) === Buffer.from(DIRTY, 'utf8').toString('hex').slice(-24), Buffer.from(oldPn, 'utf8').toString('hex').slice(-18));
    // 体积上限与解析失败行为不回归
    const big = new Readable({ read() { } });
    const p2 = new Function(code + '\nreturn readBody(arguments[0]);');
    const rej = p2(big).then(() => 'resolved', () => 'rejected');
    big.push(Buffer.alloc(9e6)); big.push(null);
    rej.then((s) => { T('L1d 超 8MB 仍拒绝（上限不回归）', s === 'rejected', s); });
    const bad = new Readable({ read() { } });
    const p3 = new Function(code + '\nreturn readBody(arguments[0]);');
    p3(bad).then(() => T('L1e 坏 JSON 仍抛 bad json', false, '未抛错'), (e) => T('L1e 坏 JSON 仍抛 bad json', /bad json/.test(e.message), e.message));
    bad.push(Buffer.from('{不是json')); bad.push(null);
    const empty = new Readable({ read() { } });
    new Function(code + '\nreturn readBody(arguments[0]);')(empty).then((v) => T('L1f 空 body 仍返回 {}', v && Object.keys(v).length === 0, JSON.stringify(v)));
    empty.push(null);

    // ================= L2 键级闸：乱码 pn 不得沉淀 =================
    L2();
    // L3（存量清理组）为顶层块，模块加载时已同步执行完毕，此处不再调用
  })();
}

function mkFeed() {
  const db = { itemDict: {}, mitemDict: {} };
  const ctx = { db, console: { log: () => { } }, Date, Math, Object, Array, String, Number, RegExp, JSON, Buffer };
  vm.createContext(ctx);
  ctx._mitemShape = () => false; // 物料号形态闸与本层无关，隔离掉
  vm.runInContext(top('feedDict') + '\n' + top('feedMitem') + '\nglobalThis.fd=(a,b,c)=>feedDict(a,b,c);globalThis.fm=(a,b,c)=>feedMitem(a,b,c);', ctx);
  return { db, fd: ctx.fd, fm: ctx.fm };
}
function L2() {
  const f = mkFeed();
  f.fd(DIRTY, NM, '采集流水');          // 乱码键 + 正常名称
  f.fm(DIRTY, '162010000643', '采集流水');
  f.fd(PN, NM, '采集流水');             // 干净键
  f.fm(PN, '162010000643', '采集流水');
  const ik = Object.keys(f.db.itemDict), mk = Object.keys(f.db.mitemDict);
  T('L2a 乱码 pn 不沉淀进零件名字典', ik.length === 1 && ik[0] === PN, ik.join(','));
  T('L2b 乱码 pn 不沉淀进物料号字典', mk.length === 1 && mk[0] === PN, mk.join(','));
  T('L2c 干净键正常沉淀（闸不误杀）', f.db.itemDict[PN] && f.db.itemDict[PN].nm === NM && f.db.mitemDict[PN].mc === '162010000643', true);
  f.fd('X1\uFFFD', '名称正常', '测试'); // 键含乱码但名称干净：仍须拒
  T('L2d 键含乱码一律拒绝（与名称是否干净无关）', Object.keys(f.db.itemDict).every(k => !FFD.test(k)), true);
}

// ================= L3 存量清理：有同族同值才删，否则保留 =================
function mkClean() {
  const db = { itemDict: {}, mitemDict: {}, saveCalls: 0 };
  const ctx = { db, console: { log: () => { } }, Date, Math, Object, Array, String, Number, RegExp, JSON, Buffer };
  vm.createContext(ctx);
  vm.runInContext(top('dictFfdCleanV158') + '\nglobalThis.run=()=>dictFfdCleanV158();', ctx);
  return { db, run: ctx.run };
}
{
  // A. 有同族同值干净键 → 删除脏键 + 留档
  const a = mkClean();
  a.db.itemDict[PN] = { nm: NM, src: '采集流水', at: 100 };
  a.db.itemDict[DIRTY] = { nm: NM, src: '采集流水', at: 200 };
  a.db.mitemDict[PN] = { mc: '162010000643', src: '采集流水', at: 100 };
  a.db.mitemDict[DIRTY] = { mc: '162010000643', src: '采集流水', at: 200 };
  a.run();
  T('L3a 同族同值脏键被清理（两本字典各1条）', Object.keys(a.db.itemDict).length === 1 && Object.keys(a.db.mitemDict).length === 1 && !Object.keys(a.db.itemDict).some(k => FFD.test(k)), true);
  T('L3b 干净键零触碰（值/来源/时刻全保留）', a.db.itemDict[PN].nm === NM && a.db.itemDict[PN].src === '采集流水' && a.db.itemDict[PN].at === 100, true);
  T('L3c 被删键值留档可回滚', (a.db.dictFfdCleanLogV158 || []).length === 2 && a.db.dictFfdCleanLogV158.every(e => e.sameAs === PN && e.val && (e.dict === 'itemDict' ? e.val.nm === NM : e.val.mc === '162010000643')), (a.db.dictFfdCleanLogV158 || []).map(e => e.dict).join('+'));
  T('L3d 落清理标记（重启不重复执行）', a.db.dictFfdCleanedV158 === 1, true);
  // B. 无同族同值 → 保留待人工核查（绝不擅自删）
  const b = mkClean();
  b.db.itemDict['9999-\uFFFD\uFFFD外'] = { nm: '独一无二的名称', src: '采集流水', at: 1 };
  b.run();
  T('L3e 无同族同值脏键保留待人工核查', !!b.db.itemDict['9999-\uFFFD\uFFFD外'], true);
  T('L3f 保留项不写入留档', !(b.db.dictFfdCleanLogV158 || []).length, true);
  // C. 同族存在但名称不同 → 不删（信息可能独一份）
  const c = mkClean();
  c.db.itemDict[PN] = { nm: '名称与脏键不同', src: '采集流水', at: 1 };
  c.db.itemDict[DIRTY] = { nm: NM, src: '采集流水', at: 2 };
  c.run();
  T('L3g 同族存在但名称不同→不删', !!c.db.itemDict[DIRTY], true);
  // D. 幂等
  const d = mkClean();
  d.db.itemDict[PN] = { nm: NM, src: '采集流水', at: 1 };
  d.db.itemDict[DIRTY] = { nm: NM, src: '采集流水', at: 2 };
  d.run(); const n1 = Object.keys(d.db.itemDict).length;
  delete d.db.dictFfdCleanedV158; d.run(); const n2 = Object.keys(d.db.itemDict).length;
  T('L3h 重复执行幂等（不多删不误删）', n1 === 1 && n2 === 1, n1 + '→' + n2);
}

// ================= 生产实况：只读断言，不写 =================
setTimeout(() => {
  const pdb = JSON.parse(fs.readFileSync(__dirname + '/data/db.json', 'utf8'));
  const dirtyI = Object.keys(pdb.itemDict || {}).filter(k => FFD.test(k));
  const dirtyM = Object.keys(pdb.mitemDict || {}).filter(k => FFD.test(k));
  // ㉖v160 断言改为【清理前后两态自洽】：原写法把"尚未清理"当固定前提，清理一旦实际执行
  // （服务重启即触发）P1/P4 必漂移失败、P2/P3 更危险——脏键为空时 every() 对空数组恒真=静默空过。
  const cleaned = pdb.dictFfdCleanedV158 === 1;
  const nDirty = dirtyI.length + dirtyM.length;
  const logN = (pdb.dictFfdCleanLogV158 || []).length;
  T('P1 字典脏键与清理标记自洽', cleaned
    ? (nDirty === 0 && logN === 4)
    : (nDirty === 4 && dirtyI.concat(dirtyM).every(k => /外$/.test(k))),
    (cleaned ? '已清理：脏键 0 + 留档 ' + logN + ' 条' : '未清理：脏键 ' + nDirty + ' 条（均为 -海外 系）'));
  // 信息未丢失的等价证据：清理前=脏键各有同族同值干净键；清理后=留档点名了同族键且其值仍在
  const sibOk = dirtyI.every(k => { const num = (k.match(/^\d+/) || [''])[0]; return Object.keys(pdb.itemDict).some(x => x !== k && x.indexOf(num) === 0 && !FFD.test(x) && pdb.itemDict[x].nm === pdb.itemDict[k].nm); })
    && dirtyM.every(k => { const num = (k.match(/^\d+/) || [''])[0]; return Object.keys(pdb.mitemDict).some(x => x !== k && x.indexOf(num) === 0 && !FFD.test(x) && pdb.mitemDict[x].mc === pdb.mitemDict[k].mc); });
  const logSibOk = (pdb.dictFfdCleanLogV158 || []).length === 4 && (pdb.dictFfdCleanLogV158 || []).every(e => {
    const D = pdb[e.dict] || {}; const v = D[e.sameAs];
    return !!v && String(v[e.dict === 'itemDict' ? 'nm' : 'mc'] || '') === String(e.val[e.dict === 'itemDict' ? 'nm' : 'mc'] || '');
  });
  T('P2 脏键信息未丢失（同族同值干净键在库）', cleaned ? logSibOk : sibOk, cleaned ? '留档 4 条的同族键值仍一致' : '脏键 4 条均有同族同值干净键');
  T('P3 脏键形态与注入模型一致（有脏键时校验字节形态）', nDirty === 0 ? logN === 4 : dirtyI.concat(dirtyM).every(k => Buffer.from(k, 'utf8').toString('hex').indexOf('efbfbd') > 0), nDirty === 0 ? '脏键已清，改校验留档计数' : '4 条均含 efbfbd 切断形态');
  T('P4 本测试不写生产库（标记状态与脏键数不矛盾）', cleaned ? (nDirty === 0 && logN === 4) : (nDirty === 4 && logN === 0), cleaned ? '清理由服务重启执行，非本测试所为' : '未重启，清理未执行');
  console.log('\n结果: ' + pass + ' PASS / ' + fail + ' FAIL');
  process.exit(fail ? 1 : 0);
}, 600);
