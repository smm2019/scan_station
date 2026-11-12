#!/usr/bin/env node
// ===================== ㉖v171 第0层②：一键测试门禁 =====================
// 动因（用户质问"难道只能问你吗"的技术答案）：
//   仓库里有 106 个 test_*.js，但 CI（.github/workflows/build_apk.yml）只做
//   build_runner → flutter analyze → build apk，【一个测试都不跑】。这些测试只有人
//   手工 node 执行时才有效力 → 质量保障是单点人力依赖，助手不在场就归零。
//
// 必须解决的四个真问题（否则门禁第一天就被禁用）：
//  ① 94/106 读 server/data/db.json，而 server/data/ 在 .gitignore 里 —— CI 全新 checkout
//     拿不到它。若按"跑不了=失败"CI 必然全红。故依赖生产库且库不存在时判 SKIP 并明确
//     计数，绝不判 FAIL（SKIP 数醒目打印，不藏）。
//  ② 存在既有测试债（例 test_fifo_lock_v114 沙箱缺 P 注入报 ReferenceError，已用 HEAD
//     对照确认非本次引入）。若算失败，门禁第一次跑就红 → 必然被关掉。故用 baseline 只卡
//     【新增】失败，并把豁免数量醒目打出来（可被审查、不会静默当成绿）。
//  ③ 只看退出码会漏判：有测试打印 FAIL 却仍 exit 0。故双判定（退出码 + 输出内容），
//     并识别崩溃特征（ReferenceError/TypeError/ENOENT），它比 FAIL 更该拦。
//  ④ ★执行器不能用 spawnSync：套件自己 cp.spawn 起的 server 若因失败路径没被 kill，
//     孙进程会持续持有 stdout/stderr 管道 → spawnSync 的 timeout 只杀直接子进程、
//     管道不关就一直等 → 整套门禁永久卡死（11-12 实测：基线跑到第 5 个套件即无输出，
//     587s 无汇总、无 EXIT 行）。故改异步 spawn + 超时杀【整个进程树】。
//     跨平台：Linux 用 detached 进程组 kill(-pid)；Windows 用 taskkill /T /F。
//
// 串行执行：多个套件共用固定名临时目录（实测 v152 并发会 ENOTEMPTY 抢目录），并行会带来
// 假失败，宁可慢。
//
// 用法：
//   node selftest_ci_runner.js                    # 门禁：新增失败→exit 1
//   node selftest_ci_runner.js --update-baseline  # 重生成豁免清单（人工评审后提交）
//   node selftest_ci_runner.js --only a,b         # 只跑指定套件
//   node selftest_ci_runner.js --list             # 只列分类不执行
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const HERE = __dirname;
const BASELINE = path.join(HERE, 'selftest-baseline.json');
const DB_FILE = path.join(HERE, 'data', 'db.json');
const PER_TIMEOUT_MS = Number(process.env.SELFTEST_TIMEOUT_MS || 180000);

const args = process.argv.slice(2);
const MODE_BASELINE = args.includes('--update-baseline');
const MODE_LIST = args.includes('--list');
const onlyArg = (args.find((a) => a.startsWith('--only=')) || '').slice(7);
const onlySet = onlyArg ? new Set(onlyArg.split(',').map((s) => s.trim()).filter(Boolean)) : null;

const CRASH_RE = /ReferenceError|TypeError: |SyntaxError|Cannot find module|ENOENT: no such|EACCES|throw er|FATAL ERROR|RangeError/;
const PASS_MARK_RE = /(通过|PASS|全绿|✅)/;

// 杀整棵进程树（关键：孙进程 server 实例必须一起带走，否则管道不关、端口被占）
function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') cp.spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 8000 });
    else process.kill(-pid, 'SIGKILL'); // detached 进程组
  } catch (_) { try { process.kill(pid, 'SIGKILL'); } catch (__) {} }
}

function classify(code, out, timedOut, needDb) {
  if (needDb && !fs.existsSync(DB_FILE)) return { s: 'SKIP', why: '依赖 data/db.json（CI 无此文件，.gitignore 排除）' };
  if (timedOut) return { s: 'TIMEOUT', why: '超 ' + Math.round(PER_TIMEOUT_MS / 1000) + 's 未退出（已强制终止进程树）' };
  if (code !== 0 && CRASH_RE.test(out)) return { s: 'CRASH', why: '进程异常退出 code=' + code };
  const failLines = out.split('\n').filter((l) => /^\s*(FAIL!|FAIL\s|❌)/.test(l) || /\bFAIL\b.*(实际=|期望=)/.test(l));
  const sumFail = (out.match(/(\d+)\s*(?:\/\s*\d+\s*)?失败/g) || []).filter((m) => !/^\s*0\s*(?:\/\s*\d+)?\s*失败/.test(m));
  if (failLines.length || sumFail.length) return { s: 'FAIL', why: '断言失败 ' + (failLines.length || sumFail.length) + ' 处' + (code !== 0 ? ' (code=' + code + ')' : '') };
  if (code !== 0) return { s: 'FAIL', why: '退出码 ' + code + ' 但无失败明细（按失败处理）' };
  if (!PASS_MARK_RE.test(out)) return { s: 'NOTAG', why: 'exit=0 但输出无通过标记（可能中途静默退出）' };
  return { s: 'PASS' };
}

function runOne(file) {
  return new Promise((resolve) => {
    let out = '', timedOut = false, done = false;
    const child = cp.spawn(process.execPath, [path.join(HERE, file)], {
      cwd: HERE, env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32', // Linux 独立进程组，便于整组回收
    });
    const finish = (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, out, timedOut }); };
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); setTimeout(() => finish(-1), 3000); }, PER_TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; if (out.length > 8e6) out = out.slice(-4e6); });
    child.stderr.on('data', (d) => { out += d; if (out.length > 8e6) out = out.slice(-4e6); });
    child.on('error', (e) => { out += '\nSPAWN_ERROR ' + e.message; finish(-1); });
    child.on('close', (c) => finish(c === null ? -1 : c));
  });
}

async function main() {
  let files = fs.readdirSync(HERE).filter((f) => /^test_.*\.js$/.test(f)).sort();
  if (onlySet) files = files.filter((f) => onlySet.has(f) || onlySet.has(f.replace(/\.js$/, '')));
  const needDbOf = (f) => {
    try { return /data['"]?\s*[,+]\s*['"]?db\.json|data\/db\.json|readFileSync\(.*db\.json/.test(fs.readFileSync(path.join(HERE, f), 'utf8')); } catch (_) { return false; }
  };

  if (MODE_LIST) {
    const nd = files.filter(needDbOf).length;
    console.log('套件总数 ' + files.length + '；依赖生产库快照 ' + nd + ' 个（CI 里将 SKIP）；可跑 ' + (files.length - nd) + ' 个');
    console.log('data/db.json 存在: ' + (fs.existsSync(DB_FILE) ? '是（本机可全跑）' : '否（CI 环境）'));
    return 0;
  }

  console.log('=== selftest 门禁 ===');
  console.log('套件 ' + files.length + ' 个 · 串行 · 单套上限 ' + Math.round(PER_TIMEOUT_MS / 1000) + 's');
  console.log('data/db.json: ' + (fs.existsSync(DB_FILE) ? '存在 → 全量可跑' : '【不存在 → 依赖它的判 SKIP（CI 正常态）】') + '\n');

  const results = {};
  const t0 = Date.now();
  for (const f of files) {
    const needDb = needDbOf(f);
    if (needDb && !fs.existsSync(DB_FILE)) { results[f] = { s: 'SKIP', why: '依赖 data/db.json（CI 无此文件）' }; continue; }
    const r = await runOne(f);
    results[f] = classify(r.code, r.out, r.timedOut, needDb);
    const icon = results[f].s === 'PASS' ? '✅' : results[f].s === 'SKIP' ? '⏭ ' : '❌';
    console.log(icon + ' ' + f.padEnd(36) + results[f].s.padEnd(8) + (results[f].why ? '｜' + String(results[f].why).slice(0, 64) : ''));
  }

  const by = (s) => Object.keys(results).filter((k) => results[k].s === s);
  const pass = by('PASS'), skip = by('SKIP');
  const badAll = [].concat(by('FAIL'), by('CRASH'), by('TIMEOUT'), by('NOTAG'));
  console.log('\n--- 汇总（' + Math.round((Date.now() - t0) / 1000) + 's）---');
  console.log('PASS ' + pass.length + ' · SKIP ' + skip.length + ' · 不良 ' + badAll.length + '（' + badAll.map((k) => results[k].s).join(',') + '）');

  if (MODE_BASELINE) {
    const exempt = {};
    badAll.forEach((k) => { exempt[k] = { s: results[k].s, why: results[k].why || '', recordedAt: new Date().toISOString().slice(0, 10) }; });
    fs.writeFileSync(BASELINE, JSON.stringify({ _说明: '既有失败豁免清单：门禁只卡【新增】失败。收紧需人工评审后 --update-baseline 重新生成，并在提交说明里写明为何可豁免。', exempt }, null, 2) + '\n');
    console.log('\n✅ baseline 已写入，豁免 ' + Object.keys(exempt).length + ' 项（需人工评审，别当绿）');
    return 0;
  }

  let exempt = {};
  if (fs.existsSync(BASELINE)) { try { exempt = JSON.parse(fs.readFileSync(BASELINE, 'utf8')).exempt || {}; } catch (e) { console.log('⚠ baseline 解析失败，按无豁免处理：' + e.message); } }
  else console.log('\n⚠ 无 selftest-baseline.json —— 先 --update-baseline 生成豁免清单，否则历史债会把门禁一次卡死');

  const fresh = badAll.filter((k) => !exempt[k]), waived = badAll.filter((k) => !!exempt[k]);
  if (waived.length) { console.log('\n⚠ ' + waived.length + ' 项为【已记录豁免】，本次不拦（不是通过）：'); waived.forEach((k) => console.log('   · ' + k + ' [' + results[k].s + '] ' + String(results[k].why || '').slice(0, 58))); }
  if (skip.length) console.log('\n⏭ ' + skip.length + ' 项因缺 data/db.json 被跳过 —— 本机带库跑可覆盖。');
  if (fresh.length) {
    console.log('\n❌❌ 门禁不通过：新增失败 ' + fresh.length + ' 项 ❌❌');
    fresh.forEach((k) => console.log('   ★ ' + k + ' [' + results[k].s + '] ' + String(results[k].why || '').slice(0, 78)));
    console.log('\n处置：修到绿；确属测试自身缺陷需豁免，则 --update-baseline 并在提交说明写清理由。');
    return 1;
  }
  console.log('\n✅ 门禁通过：无新增失败（PASS ' + pass.length + ' / 豁免 ' + waived.length + ' / 跳过 ' + skip.length + '）');
  return 0;
}

main().then((code) => process.exit(code)).catch((e) => { console.log('RUNNER 自身异常：' + (e && e.stack || e)); process.exit(2); });
