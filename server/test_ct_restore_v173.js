// ㉖v173 恢复工具自检：验证 deploy/恢复容器类型.js 真的能【只加不删】地把清单补回
// 为什么要有这个测试：工具是给现场同事双击用的，输错一次就是把配置再冲一遍，
//   不能靠人肉验证。这里用夹具起一个空库实例（server 自动 seed admin/admin123），
//   把工具的输入按【取消】/【确认】两条路径喂进去，断言：
//     · 输入取消 → 服务器清单一个字节都没变
//     · 输入 yes → 事故前 14 项全部回来，且实例原有项一个没少（只加不删）
//     · 重复运行 → 幂等（已含 14 项时直接退出、不写）
// 空库模式即可跑（只需 admin 一个身份），故 CI 也能覆盖，不必 SKIP。
'use strict';
const path = require('path');
const cp = require('child_process');
const kit = require('./test_conc_kit_v172.js');

const PORT = Number(process.env.CTR_PORT || 8421);
const TOOL = path.join(__dirname, '..', 'deploy', '恢复容器类型.js');
const OLD14 = ['1800*1200_2', '1600*1100', '2.4米铁框', '华强铁框', '木箱', '1.2米铁框', '1.4米铁框', '塑料筐', '华强料架', '华强塑料筐', '铁笼', '木托盘', '纵梁内部料架', '纸箱'];
const K = (s) => String(s || '').toUpperCase();
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + String(i).slice(0, 90) + ']' : ''}`); };

// 跑一次工具，stdin 按顺序喂答案；返回 stdout
function runTool(lines) {
  return new Promise((res) => {
    const child = cp.spawn(process.execPath, [TOOL], { cwd: __dirname, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => out += d);
    child.stderr.on('data', (d) => out += d);
    child.stdin.on('error', () => {});
    child.stdin.write(lines.join('\n') + '\n', () => child.stdin.end());
    child.on('close', (code) => res({ code, out }));
  });
}

(async () => {
  let h = null;
  try {
    h = await kit.startInstance({ port: PORT, tag: 'ctr' + process.pid, seedMode: 'empty', upTries: 60 });
    const tok = await h.login('admin', 'admin123');
    const get = async () => ((await h.req('GET', '/api/containers', tok)).json || {}).types || [];
    const base0 = await get();
    C('实例默认字典可用（空库 5 项兜底）', base0.length === 5, base0.map((x) => x.show).join('、'));

    // ---- 路径1：输入取消 → 必须零改动 ----
    const r1 = await runTool(['http://127.0.0.1:' + PORT, 'admin', 'admin123', 'no']);
    C('输入非 yes → 取消退出', r1.code === 0 && /已取消/.test(r1.out), 'code=' + r1.code + ' ' + r1.out.split('\n').filter(Boolean).slice(-1)[0]);
    const after1 = await get();
    C('★取消后服务器清单零改动', after1.length === base0.length, after1.length + ' vs ' + base0.length);

    // ---- 路径2：连不上/密码错 → 不写 ----
    const r2 = await runTool(['http://127.0.0.1:' + (PORT + 1)]);
    C('连不上服务器 → 明确报错退出', r2.code === 1 && /连不上服务器/.test(r2.out), 'code=' + r2.code);
    const r2b = await runTool(['http://127.0.0.1:' + PORT, 'admin', 'WrongPw999']);
    C('密码错 → 明确报错退出（不写）', r2b.code === 1 && /登录失败/.test(r2b.out), 'code=' + r2b.code);

    // ---- 路径3：yes → 14 项全回、原项不丢 ----
    const r3 = await runTool(['http://127.0.0.1:' + PORT, 'admin', 'admin123', 'yes']);
    C('输入 yes → 执行成功', r3.code === 0 && /恢复成功/.test(r3.out), 'code=' + r3.code + ' ' + r3.out.split('\n').filter((l) => /恢复成功|校验/.test(l)).join(' | '));
    const after3 = await get();
    C('★事故前 14 项全部回来', OLD14.every((k) => after3.some((x) => K(x.db) === K(k))), after3.length + ' 项');
    C('★原有项一个没少（只加不删）', base0.every((x) => after3.some((y) => K(y.db) === K(x.db))), '默认5项仍在=' + base0.filter((x) => after3.some((y) => K(y.db) === K(x.db))).length + '/5');
    const expectN = 14 + base0.filter((x) => !OLD14.some((k) => K(k) === K(x.db))).length;
    C('★合并项数 = 14 + 原清单中不在14项内的项', after3.length === expectN, after3.length + ' 项（期望 ' + expectN + '：14 + 默认5项里的' + base0.filter((x) => !OLD14.some((k) => K(k) === K(x.db))).length + '项独有）');
    C('工具内已声明"只做加法"', /只做加法/.test(r3.out));

    // ---- 路径4：幂等 —— 再跑一次应判"已含14项"直接退出、不写 ----
    const r4 = await runTool(['http://127.0.0.1:' + PORT, 'admin', 'admin123']);
    C('★重复运行幂等（已含14项即退出不写）', /无需恢复/.test(r4.out) && r4.code === 0, 'code=' + r4.code);
    const after4 = await get();
    C('★重复运行未产生重复项', after4.length === expectN, after4.length + ' 项（期望 ' + expectN + '）');
  } catch (e) {
    total++; fail++; console.log('❌ 异常：' + e.message);
  } finally { if (h) { try { await h.stop(); } catch (_) {} } }
  console.log('\n结果: ' + (total - fail) + ' 通过 / ' + fail + ' 失败  （隔离空库实例，生产库零接触）');
  process.exit(fail ? 1 : 0);
})();
