// ㉖v173e 原子写重试加固回归测试（vm 抽函数，不碰生产库/生产进程）
// 背景：11-13 10:41:53 线上 saveDb 记 EPERM rename——10MB 库文件被杀软/Windows 索引器
//   瞬时打开时 rename 被拒；旧实现仅"试 2 次、固定等 60ms"，一次锁即放弃。
// 加固：_AW_WAITS=[60,200,600]（共试 4 次，退避递增，末次失败不空等），同步/异步版共用。
// 本测试注入"rename 前 N 次抛 EPERM"的假 fs，验证：
//   A 瞬时锁（前 1/2/3 次失败）→ 最终成功（旧实现只试 2 次，k≥2 必崩 → 回归护栏）
//   B 持续锁（全失败）→ 抛最后错误 + 试满 4 次 + 不留半成品临时文件
//   C 异步版同表同次数：前 3 次失败第 4 次成功；退避=[60,200,600] 且末次不空等
//   D 源码静态断言：表值正确、两版都引用表（不再硬编码 2）、两版都有"末次不空等"判断
// 异步驱动：vm 上下文注入的 setTimeout 由假定时器立即触发，测试 await 微任务链即可，无忙等。
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
function topFn(name) {
  // ★起点必须含 async 前缀：indexOf('function X(') 会命中 'async function X(' 的中段，
  //   从 'function' 起截就丢了 async → vm 里 await 直接 SyntaxError（11-13 实测踩过）
  let i = SRC.indexOf('async function ' + name + '(');
  const isAsync = i >= 0;
  if (!isAsync) i = SRC.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('找不到 ' + name);
  for (let j = i; j < SRC.length; j++) if (SRC.slice(j, j + 2) === '\n}' && (j + 2 >= SRC.length || SRC[j + 2] === '\n')) return SRC.slice(i, j + 2);
  throw new Error('函数结尾未找到: ' + name);
}
const AW_TABLE = (SRC.match(/const _AW_WAITS = (\[[^\]]+\])/) || [])[1];

let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + i + ']' : ''}`); };

// 假 fs：rename 前 failFirst 次抛 EPERM；等待经注入的 setTimeout 立即触发并记录毫秒
function mkCtx(failFirst) {
  const files = Object.create(null);
  const state = { renameCalls: 0, unlinkCalls: 0, tmpLeft: [] };
  const waits = [];
  const err = () => Object.assign(new Error("EPERM: operation not permitted, rename"), { code: 'EPERM' });
  const ok = (from, to) => { delete files[from]; files[to] = 'RENAMED:' + from; state.tmpLeft = Object.keys(files).filter((k) => /tmp-/.test(k)); };
  const failRename = (from) => { state.renameCalls++; if (state.renameCalls <= failFirst) throw err(); ok(from, '__target__'); };
  const fsMock = {
    writeFileSync: (p, d) => { files[p] = d; },
    openSync: () => 7, fsyncSync: () => {}, closeSync: () => {},
    renameSync: (from, to) => failRename(from),
    unlinkSync: (p) => { state.unlinkCalls++; delete files[p]; state.tmpLeft = Object.keys(files).filter((k) => /tmp-/.test(k)); },
    promises: {
      writeFile: async (p, d) => { files[p] = d; },
      open: async () => ({ sync: async () => {}, close: async () => {} }),
      rename: async (from, to) => failRename(from),
      unlink: async (p) => { state.unlinkCalls++; delete files[p]; state.tmpLeft = Object.keys(files).filter((k) => /tmp-/.test(k)); },
    },
  };
  const ctx = vm.createContext({
    fs: fsMock, path: { dirname: () => '/x' }, console, Promise, Error, Object, JSON,
    process, Atomics: { wait: () => {} }, Int32Array, SharedArrayBuffer,
    setTimeout: (f, ms) => { waits.push(ms); return Promise.resolve().then(f); },
  });
  vm.runInContext('let _tmpSeq = 0; const _AW_WAITS = ' + AW_TABLE + ';', ctx); // _tmpSeq 是函数体外依赖，topFn 只截函数体，必须注入
  vm.runInContext(topFn('atomicWrite'), ctx);
  vm.runInContext(topFn('atomicWriteAsync'), ctx);
  return { ctx, state, waits };
}

(async () => {
  // —— A 瞬时锁（同步版）：前 K 次失败应最终成功；k≥2 是旧实现会崩的区域 ——
  for (const k of [1, 2, 3]) {
    const { ctx, state } = mkCtx(k);
    let thrown = null;
    try { vm.runInContext('atomicWrite("/x/db.json","DATA")', ctx); } catch (e) { thrown = e; }
    C(`A 同步版·前 ${k} 次 rename 撞 EPERM → 第 ${k + 1} 次成功`, !thrown && state.renameCalls === k + 1, thrown ? 'code=' + thrown.code : 'rename ' + state.renameCalls + ' 次');
  }
  // —— B 持续锁：全失败 → 抛最后错误、试满 4 次、清尽半成品 ——
  {
    const { ctx, state } = mkCtx(99);
    let threw = null;
    try { vm.runInContext('atomicWrite("/x/db.json","DATA")', ctx); } catch (e) { threw = e; }
    C('B 持续锁 → 抛最后错误 EPERM', threw && threw.code === 'EPERM', threw && threw.code);
    C('B 共尝试 4 次（1+waits.length，与退避表一致）', state.renameCalls === 4, 'rename ' + state.renameCalls + ' 次');
    C('B 每次失败清半成品（unlink 4 次、零残留）', state.unlinkCalls === 4 && state.tmpLeft.length === 0, 'unlink=' + state.unlinkCalls + ' 残留=' + JSON.stringify(state.tmpLeft));
  }
  // —— C 异步版：前 3 次失败第 4 次成功；等待序列=[60,200,600] 共 3 段（末次不空等）——
  {
    const { ctx, state, waits } = mkCtx(3);
    let err = null;
    try {
      await vm.runInContext('atomicWriteAsync("/x/db.json","DATA").then(()=>1).catch(e=>{throw e})', ctx);
    } catch (e) { err = e; }
    C('C 异步版·前 3 次失败第 4 次成功', !err && state.renameCalls === 4, err ? 'code=' + err.code : 'rename ' + state.renameCalls + ' 次');
    C('C 异步版·退避=[60,200,600] 且末次失败不空等（恰好 3 段）', JSON.stringify(waits) === '[60,200,600]', JSON.stringify(waits));
  }
  // —— C2 异步版持续锁：同样试满 4 次并抛错 ——
  {
    const { ctx, state } = mkCtx(99);
    let err = null;
    try { await vm.runInContext('atomicWriteAsync("/x/db.json","DATA")', ctx); } catch (e) { err = e; }
    C('C2 异步版·持续锁试满 4 次后抛 EPERM', err && err.code === 'EPERM' && state.renameCalls === 4, 'code=' + (err && err.code) + ' rename ' + state.renameCalls + ' 次');
  }
  // —— D 源码静态断言 ——
  C('D 退避表=[60, 200, 600]', AW_TABLE && AW_TABLE.replace(/\s/g, '') === '[60,200,600]', AW_TABLE);
  C('D 两版循环都用 _AW_WAITS.length（无硬编码 <2 残留）', (SRC.match(/_try <= _AW_WAITS\.length/g) || []).length === 2 && !/_try < 2;[^_]/.test(SRC));
  const i1 = SRC.indexOf('function atomicWrite('), i2 = SRC.indexOf('async function atomicWriteAsync(');
  const seg1 = SRC.slice(i1, SRC.indexOf('\n}', i1)), seg2 = SRC.slice(i2, SRC.indexOf('\n}', i2));
  C('D 两版均"末次失败不空等"（_try<_AW_WAITS.length 判断）', /if \(_try < _AW_WAITS\.length\)/.test(seg1) && /if \(_try < _AW_WAITS\.length\)/.test(seg2));
  C('D 断电四步语义未动（同步 fsyncSync+renameSync / 异步 open.sync+promises.rename）', /fsyncSync/.test(seg1) && /renameSync/.test(seg1) && /\.sync\(\)/.test(seg2) && /promises\.rename/.test(seg2));

  console.log('\n结果: ' + (total - fail) + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
