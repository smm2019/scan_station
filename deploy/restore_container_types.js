// ㉖v173 容器类型恢复工具（零停机，走服务器正规配置接口，不需要重启服务、不需要管理员权限）
//
// 背景：11-12 14:49 一次误保存把 14 项容器类型冲成 5 项，9 类消失、166 只在架实物失去类型口径。
// 本工具做的事：读服务器当前清单 → 按「事故前 14 项 + 事故后新增项」合并 → 写回 → 回读校验。
//   · 只做加法，绝不删除任何现有项（要删仍受服务端 v173 防线保护）
//   · 幂等：清单已齐时直接退出、不重复写，可随时重跑
//   · 任何一步不对就停下不写，不会写一半
//
// 用法：双击 RestoreContainerTypes.cmd，按提示输服务器地址与仓管/管理员账号
//   只看不动（预览）：双击 RestoreContainerTypes_预览.cmd，或 node restore_container_types.js --check
//   账号密码只用于登录你们自己的服务器，不写入任何文件。
'use strict';
const http = require('http');
const https = require('https');
const readline = require('readline');

// 事故前完整清单，取自 data/backups/db-20261112-1441.json（11-12 14:41 快照，误覆盖前最后一份）
const OLD14 = [
  { db: '1800*1200_2', show: '1.8米铁框' }, { db: '1600*1100', show: '1.6米铁框' },
  { db: '2.4米铁框', show: '2.4米铁框' }, { db: '华强铁框', show: '华强铁框' },
  { db: '木箱', show: '木箱' }, { db: '1.2米铁框', show: '1.2米铁框' },
  { db: '1.4米铁框', show: '1.4米铁框' }, { db: '塑料筐', show: '塑料筐' },
  { db: '华强料架', show: '华强料架' }, { db: '华强塑料筐', show: '华强塑料筐' },
  { db: '铁笼', show: '铁笼' }, { db: '木托盘', show: '木托盘' },
  { db: '纵梁内部料架', show: '纵梁内板料架' }, { db: '纸箱', show: '纸箱' },
];
const K = (x) => String(x.db || '').toUpperCase();
const DRY = process.argv.slice(2).some((a) => a === '--check' || a === '--preview');
const DEFAULT_BASE = 'http://10.96.7.200:8099'; // 现场实际地址（11-13 截图实证可达），回车即用

// ===== 输入层：一条 readline + 自建队列，绝不碰 rawMode =====
// 两次现场翻车都出在这里，记下来：
//  ① 逐键读取(rawMode)隐藏密码：读完 pause(stdin) 却没 resume → 下一次 question 永远读不到按键，
//     事件循环无待办 → node 静默退出(0)。现场表现就是"输入 y 就闪退"，且批处理误报 [DONE]。
//     （11-13 截图：确认那行后面直接 [DONE]，连"已取消"都没打印 = 根本没读到输入）
//  ② 用 rl.question 逐题问 + 管道输入：第一个 question 期间，readline 已把后面几行连 EOF 一起
//     消费掉，无人接收 → 后续 question 拿不到值或直接 "readline was closed"。
// 做法：自启动就挂一个常驻 line 监听，早到的行先进队列，问到就取；EOF 让 waiter 拿到空串，
//     由上层明确报错退出，杜绝静默退出。键盘逐行输入与文件重定向走同一条路。
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const earlyLines = [];
let waiter = null;
let inputClosed = false;
rl.on('line', (l) => {
  const v = String(l).trim();
  if (waiter) { const w = waiter; waiter = null; w(v); }
  else earlyLines.push(v);
});
rl.on('close', () => {
  inputClosed = true;
  if (waiter) { const w = waiter; waiter = null; w(''); }
});
const ask = (q) => {
  if (q) process.stdout.write(q);
  if (earlyLines.length) {
    const v = earlyLines.shift();
    process.stdout.write(v + '\n'); // 重定向输入时回显一行，日志里看得清输入了什么
    return Promise.resolve(v);
  }
  if (inputClosed) return Promise.resolve('');
  return new Promise((res) => { waiter = res; });
};

function req(method, urlStr, body, tok) {
  return new Promise((res) => {
    let u; try { u = new URL(urlStr); } catch (_) { return res({ status: 0, json: null, raw: '地址格式不对' }); }
    const lib = u.protocol === 'https:' ? https : http;
    const data = body === undefined ? null : JSON.stringify(body);
    const r = lib.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method,
      headers: Object.assign({ 'Content-Type': 'application/json' },
        data ? { 'Content-Length': Buffer.byteLength(data) } : {},
        tok ? { Authorization: 'Bearer ' + tok } : {}),
      timeout: 15000,
    }, (resp) => {
      let b = '';
      resp.on('data', (d) => b += d);
      resp.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} res({ status: resp.statusCode, json: j, raw: b.slice(0, 200) }); });
    });
    r.on('error', (e) => res({ status: 0, json: null, raw: e.message }));
    r.on('timeout', () => { r.destroy(); res({ status: 0, json: null, raw: '请求超时' }); });
    if (data) r.write(data);
    r.end();
  });
}

const bad = (msg) => { console.log('\n❌ ' + msg + '\n（服务器未做任何改动）'); rl.close(); process.exit(1); };

(async () => {
  console.log(DRY
    ? '=== 容器类型检查（只看不动，不写服务器）===\n'
    : '=== 容器类型恢复（事故前 14 项 + 现有新增项，只做加法，不删除）===\n');

  let base = await ask('服务器地址 [回车 ' + DEFAULT_BASE + ']: ');
  if (!base) base = DEFAULT_BASE;
  base = base.replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) base = 'http://' + base;

  const h = await req('GET', base + '/api/health');
  if (!h.json || h.json.ok !== true) bad('连不上服务器：' + (h.raw || h.status) + '\n请确认地址与车间网络后重跑。');
  console.log('  √ 已连上服务器\n');

  const user = await ask('仓管/管理员账号: ');
  const pass = await ask('密码（会显示在屏幕上，输完按回车；不会写入任何文件）: ');
  if (!user || !pass) bad('未输入完整账号密码（需要能改容器类型的仓管/管理员账号）。');
  const lg = await req('POST', base + '/api/login', { username: user, password: pass, dev: 'CT-RESTORE', kind: 'pda' });
  if (!lg.json || !lg.json.ok || !lg.json.token) bad('登录失败：' + String((lg.json || {}).msg || lg.raw || '').slice(0, 80) + '\n（需要能改容器类型的账号：仓管或管理员）');
  const tok = lg.json.token;
  console.log('  √ 登录成功：' + ((lg.json.user || {}).name || user));

  const g = await req('GET', base + '/api/containers', undefined, tok);
  if (!g.json || g.json.ok !== true) bad('读取当前清单失败：' + String((g.json || {}).msg || g.raw || '').slice(0, 80) + '\n（若提示权限不足，请换仓管/管理员账号）');
  const cur = (g.json.types || []).filter((x) => x && x.db && x.show);
  if (!cur.length) bad('服务器返回空清单，异常，停止写入。');
  console.log('\n服务器当前 ' + cur.length + ' 项：' + cur.map((x) => x.show).join('、'));

  // 合并：事故前 14 项为主序，现有清单里 14 项没有的追加在后（只加不删）
  const merged = OLD14.slice();
  const keys = new Set(OLD14.map(K));
  const added = [];
  for (const x of cur) if (!keys.has(K(x))) { merged.push(x); added.push(x); keys.add(K(x)); }
  const curKeys = new Set(cur.map(K));
  const back = OLD14.filter((x) => !curKeys.has(K(x)));

  console.log('\n将恢复 ' + back.length + ' 项：' + (back.map((x) => x.show).join('、') || '无（已齐全）'));
  console.log('将保留 ' + added.length + ' 项（现有新增，不动）：' + (added.map((x) => x.show).join('、') || '无'));
  console.log('合并后共 ' + merged.length + ' 项。');

  if (!back.length) { console.log('\n✅ 服务器清单已含全部 14 项，无需恢复，未做任何改动。'); rl.close(); process.exit(0); }
  if (merged.length > 20) bad('合并后 ' + merged.length + ' 项超过接口上限 20，请联系开发调整后再执行。');
  if (DRY) { console.log('\n（预览模式：未写入服务器。去掉 --check 再运行才会写入）'); rl.close(); process.exit(0); }

  console.log('\n正在写入服务器…');
  const p = await req('POST', base + '/api/containers', { types: merged }, tok);
  if (!p.json || p.json.ok !== true) bad('写入被拒：' + String((p.json || {}).msg || p.raw || '').slice(0, 240));

  const v = await req('GET', base + '/api/containers', undefined, tok);
  const after = (v.json && v.json.types) || [];
  const okBack = OLD14.every((x) => after.some((y) => K(y) === K(x)));
  const okKeep = cur.every((x) => after.some((y) => K(y) === K(x)));
  console.log('\n' + (okBack && okKeep ? '✅ 恢复成功，回读校验通过' : '⚠ 已写入，但回读校验未全通过，请人工核对') + '：现在共 ' + after.length + ' 项');
  after.forEach((x, i) => console.log('  ' + String(i + 1).padStart(2) + '. ' + x.show + '   [db=' + x.db + ']'));
  console.log('\nPDA 退出采集页重新进入即可看到恢复的按钮（下次进入生效）。');
  rl.close();
  process.exit(okBack && okKeep ? 0 : 2);
})().catch((e) => bad('异常：' + (e && e.message)));
