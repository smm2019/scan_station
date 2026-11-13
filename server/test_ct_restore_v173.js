// ㉖v173 恢复工具自检：验证 deploy/restore_container_types.js 真能【只加不删】把清单补回
// 为什么要自动化测：工具是给现场同事在自己机器上双击的，我这台机器一切正常≠他那台正常。
//   11-13 真实翻车：现场跑到确认环节"输入 y 就闪退"——根因是工具用 rawMode 隐藏密码后
//   pause(stdin) 未 resume，下一次提问读不到按键且事件循环无待办 → node 静默退出(0)，
//   批处理据此误报 [DONE]。该路径必须被测试覆盖，故本套件用【管道喂输入】跑全流程。
// 覆盖：预览不写 / 连不上不写 / 密码错不写 / 正常执行 14 项全回且原项不丢 / 幂等重跑不重复
'use strict';
const path = require('path');
const cp = require('child_process');
const kit = require('./test_conc_kit_v172.js');

const PORT = Number(process.env.CTR_PORT || 8421);
const TOOL = path.join(__dirname, '..', 'deploy', 'restore_container_types.js');
const OLD14 = ['1800*1200_2', '1600*1100', '2.4米铁框', '华强铁框', '木箱', '1.2米铁框', '1.4米铁框', '塑料筐', '华强料架', '华强塑料筐', '铁笼', '木托盘', '纵梁内部料架', '纸箱'];
const K = (s) => String(s || '').toUpperCase();
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + String(i).slice(0, 90) + ']' : ''}`); };

// 跑工具：stdin 用管道喂（复现现场重定向场景），lines 依次为 地址/账号/密码
function runTool(lines, extraArgs) {
  return new Promise((res) => {
    const child = cp.spawn(process.execPath, [TOOL].concat(extraArgs || []), { cwd: __dirname, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] });
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
    const url = 'http://127.0.0.1:' + PORT;
    C('实例默认字典可用（空库 5 项兜底）', base0.length === 5, base0.map((x) => x.show).join('、'));
    const expectN = 14 + base0.filter((x) => !OLD14.some((k) => K(k) === K(x.db))).length;

    // ---- 预览模式：必须不动服务器 ----
    const rc = await runTool([url, 'admin', 'admin123'], ['--check']);
    C('预览模式跑通并提示未写入', rc.code === 0 && /未写入服务器/.test(rc.out), 'code=' + rc.code);
    C('★预览后服务器零改动', (await get()).length === base0.length);

    // ---- 连不上 / 密码错：必须不写 ----
    const r2 = await runTool(['http://127.0.0.1:' + (PORT + 1)]);
    C('连不上服务器 → 报错退出(1)', r2.code === 1 && /连不上服务器/.test(r2.out), 'code=' + r2.code);
    const r2b = await runTool([url, 'admin', 'WrongPw999']);
    C('密码错 → 报错退出(1)且不写', r2b.code === 1 && /登录失败/.test(r2b.out) && (await get()).length === base0.length, 'code=' + r2b.code);

    // ---- ★核心：复现现场闪退场景 —— 管道喂到最后一问，必须真把密码读完并写成功 ----
    const r3 = await runTool([url, 'admin', 'admin123']);
    C('★输入经管道喂入 → 正常执行（不再静默退出）', r3.code === 0 && /恢复成功/.test(r3.out), 'code=' + r3.code + ' ' + r3.out.split('\n').filter((l) => /恢复成功|校验/.test(l)).join(' | '));
    const after3 = await get();
    C('★事故前 14 项全部回来', OLD14.every((k) => after3.some((x) => K(x.db) === K(k))), after3.length + ' 项');
    C('★原有项一个没少（只加不删）', base0.every((x) => after3.some((y) => K(y.db) === K(x.db))), '默认5项仍在=' + base0.filter((x) => after3.some((y) => K(y.db) === K(x.db))).length + '/5');
    C('★合并项数 = 14 + 原清单中不在14项内的项', after3.length === expectN, after3.length + ' 项（期望 ' + expectN + '）');
    C('★不打印任何"等待输入确认"（去掉确认环节，杜绝读不到输入即中止）', !/输入 yes/.test(r3.out));

    // ---- 幂等：已齐全再跑，判"无需恢复"且不写 ----
    const r4 = await runTool([url, 'admin', 'admin123']);
    C('★重复运行幂等（已含14项即退出不写）', /无需恢复/.test(r4.out) && r4.code === 0, 'code=' + r4.code);
    C('★重复运行未产生重复项', (await get()).length === expectN, (await get()).length + ' 项（期望 ' + expectN + '）');

    // ---- 输入提前耗尽（现场直接关窗/回车空输入）：必须明确报错而非静默成功 ----
    const r5 = await runTool([]);
    C('★空输入 → 明确报错退出，绝不报成功', r5.code === 1 && !/恢复成功/.test(r5.out), 'code=' + r5.code);
  } catch (e) {
    total++; fail++; console.log('❌ 异常：' + e.message);
  } finally { if (h) { try { await h.stop(); } catch (_) {} } }
  console.log('\n结果: ' + (total - fail) + ' 通过 / ' + fail + ' 失败  （隔离空库实例，生产库零接触）');
  process.exit(fail ? 1 : 0);
})();
