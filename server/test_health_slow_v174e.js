// ㉖v174e 健康分慢接口分组扣分回归（用户实问"都慢成这样健康分怎么还100"→批准拆分）
// 病根：旧版整行 items.push 纯观测不扣分，外部依赖慢（含对方系统耗时，不是本服务的病）与
//       本服务接口慢（真信号）混一行，谁都不扣 → "100分+需关注"低估。
// 拆法：ext=观测不扣分（外部真不通由 RCS/WMAS 通道项各扣15分兜底）；local p95≥2s 且样本≥5 → 扣8分。
// 分层（本项目血泪：抽函数绿≠端点真的会算）：
//   A 抽函数：路径归属判定（截图真值+负例防误伤）+ 分组过滤 + 持续判定规则 + 源码静态断言扣分常量
//   B 真实实例（空库，CI 可跑）：/api/admin/healthscore 实际返回里两行命名/形状正确、
//     旧"慢接口TOP"已不存在、且无虚假 8 分扣减（score 与各项 ok 一致）
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const kit = require('./test_conc_kit_v172.js');

const SRC = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + String(i).slice(0, 100) + ']' : ''}`); };
// 括号配对计数抽取（跳过字符串/正则/注释），从声明起点到首个括号平衡点——单行函数不再跨函数截断
function grab(name) {
  const pats = ['function ' + name + '(', 'const ' + name + ' =', 'const ' + name + '='];
  let st = -1; for (const p of pats) { const i = SRC.indexOf(p); if (i >= 0) { st = i; break; } }
  if (st < 0) throw new Error('找不到 ' + name);
  let depth = 0, seen = false, i = st, inS = null, esc = false, inLC = false, inBC = false, inRE = false;
  for (; i < SRC.length; i++) {
    const ch = SRC[i], nx = SRC[i + 1];
    if (inLC) { if (ch === '\n') inLC = false; continue; }
    if (inBC) { if (ch === '*' && nx === '/') { inBC = false; i++; } continue; }
    if (inS) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === inS) inS = null; continue; }
    if (inRE) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '[') { i = SRC.indexOf(']', i); if (i < 0) return SRC.slice(st, i); } else if (ch === '/') inRE = false; continue; }
    if (ch === '/' && nx === '/') { inLC = true; i++; continue; }
    if (ch === '/' && nx === '*') { inBC = true; i++; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { inS = ch; continue; }
    if (ch === '/' && seen === false) { inRE = true; continue; } // 函数体首个 / 视作正则字面
    if (ch === '{') { depth++; seen = true; }
    else if (ch === '}') { depth--; if (seen && depth === 0) return SRC.slice(st, i + 1); }
    else if (ch === ';' && depth === 0 && !seen) return SRC.slice(st, i + 1); // 无括号 const 声明（正则字面量整行）
  }
  throw new Error('收尾未找到 ' + name);
}
const fn = grab, seg = grab;

console.log('--- A 抽函数：归属判定 + 分组 + 持续规则 ---');
const ctx = vm.createContext({ Object, Array, String, Number, Math, JSON, RegExp, Set, Map, Error });
vm.runInContext('const _apiStat = {};\n' + fn('apiStatMark') + '\n' + seg('API_EXT_RE') + '\n' + fn('apiIsExt') + '\n' + fn('apiStatSplit'), ctx);
{
  const R = (expr) => vm.runInContext(expr, ctx);
  // 1) 归属判定：截图真值（外部）
  C('api/agv/carry → 外部（截图 p95=9907ms 那类）', R(`apiIsExt('/api/agv/carry')`) === true);
  C('api/rcs/traffic → 外部', R(`apiIsExt('/api/rcs/traffic')`) === true);
  C('api/wmas/token → 外部', R(`apiIsExt('/api/wmas/token')`) === true);
  C('api/agv/events → 外部（AGV 通道含对方系统）', R(`apiIsExt('/api/agv/events')`) === true);
  // 2) 归属判定：截图真值（本地）
  C('api/ledger/sync → 本地（截图 p95=3732ms×80 那类，必须算本服务的病）', R(`apiIsExt('/api/ledger/sync')`) === false);
  C('api/ledger → 本地', R(`apiIsExt('/api/ledger')`) === false);
  C('api/scanlog → 本地（不能被 agv 规则误伤）', R(`apiIsExt('/api/scanlog')`) === false);
  // 3) 负例防误伤：子串含关键字但非路径段
  C('api/average 不被 agv 误判（整段匹配）', R(`apiIsExt('/api/average')`) === false);
  C('api/watchlist 不被 wms 误判', R(`apiIsExt('/api/watchlist')`) === false);
  C('api/ragv-x 不误判（整段）', R(`apiIsExt('/api/ragv-x')`) === false);
  C('空/undefined 归本地（不抛）', R(`apiIsExt(undefined)`) === false);
  // 4) 分组与过滤：灌数据验 split
  R(`
    const put=(p,msArr)=>{for(const m of msArr)apiStatMark(p,m)};
    // 外部 3 个（含被 TOP8 截断风险的第 9 个慢本地接口，验全量口径）
    put('/api/agv/carry', Array(20).fill(9907));
    put('/api/rcs/traffic', Array(12).fill(3200));
    put('/api/wmas/x', Array(8).fill(2400));
    put('/api/ledger/sync', Array(80).fill(3732));
    put('/api/health', Array(60).fill(12));          // 快接口 → 不该进任何组
    put('/api/counts', Array(9).fill(450));          // 慢但<2s → 进组不判坏
    put('/api/ops', Array(2).fill(5000));            // p95≥2s 但样本<5 → 不算持续坏
  `);
  const sp = R(`apiStatSplit(300)`);
  const ep = sp.ext.map((x) => x.p), lp = sp.local.map((x) => x.p);
  C('★split：3 个外部接口全进 ext 组', ep.length === 3 && ep.includes('/api/agv/carry') && ep.includes('/api/rcs/traffic'), ep.join(','));
  C('★split：ledger/sync 与 counts/ops 进 local 组', lp.includes('/api/ledger/sync') && lp.includes('/api/counts') && lp.includes('/api/ops'), lp.join(','));
  C('★快接口 health 不进任何组（300ms 展示线）', !ep.includes('/api/health') && !lp.includes('/api/health'));
  C('ext 组按 p95 降序（carry 首位）', ep[0] === '/api/agv/carry', ep.join('>'));
  const bad = R(`apiStatSplit(300).local.filter(x=>x.n>=5&&x.p95>=2000).map(x=>x.p)`);
  C('★持续坏判定：仅 ledger/sync（ops 样本2 不足5 → 不冤枉）', bad.length === 1 && bad[0] === '/api/ledger/sync', JSON.stringify(bad));
  const sp2 = R(`apiStatSplit(500)`);
  C('minP95 参数生效（提到500ms 后 counts(450) 出组、sync 仍留）', !sp2.local.map(x => x.p).includes('/api/counts') && sp2.local.map(x => x.p).includes('/api/ledger/sync'), sp2.local.map(x => x.p).join(','));
  // 5) 源码静态断言：健康分确实把这组接进扣分公式（防"实现了但没接线"）
  C('★端点接线：健康分用 apiStatSplit 分组', /const _sp = apiStatSplit\(300\)/.test(SRC));
  C('★端点接线：本地组走 cut(8,...) 真扣分', /cut\(8, '慢接口·本服务'/.test(SRC));
  C('★端点接线：外部组保持纯观测（ok:true 不进 cut）', /'慢接口·外部依赖\(观测\)'[\s\S]{0,400}ok: true/.test(SRC));
  C('★旧"慢接口TOP"整行观测项已移除（不再混淆归属）', !/name: '慢接口TOP'/.test(SRC));
}

console.log('\n--- B 真实实例：healthscore 实际返回结构（空库，CI 可跑）---');
const PORT = Number(process.env.HSL_PORT || 8429);
(async () => {
  let h = null;
  try {
    h = await kit.startInstance({ port: PORT, tag: 'hsl' + process.pid, seedMode: 'empty', upTries: 60 });
    const tok = await h.login('admin', 'admin123');
    await h.req('GET', '/api/counts', tok);   // 制造若干本地请求进 _apiStat
    await h.req('GET', '/api/ledger?l=', tok);
    const j = (await h.req('GET', '/api/admin/healthscore', tok)).json;
    C('健康分接口可达（admin）', j && j.ok === true && Array.isArray(j.items), 'items=' + ((j || {}).items || []).length);
    const names = (j.items || []).map((x) => x.name);
    const local = (j.items || []).find((x) => x.name === '慢接口·本服务');
    const extRow = (j.items || []).find((x) => x.name === '慢接口·外部依赖(观测)');
    C('★新行"慢接口·本服务"存在（无条件进项，红绿都可见）', !!local, names.join(' | ').slice(0, 140));
    C('★旧行"慢接口TOP"不存在（归属已拆清）', !names.includes('慢接口TOP'));
    C('本服务项在空载下 ok=true（无虚假扣分）', local && local.ok === true, local && local.val);
    C('空载时外部观测行缺省或 ok=true（外部组为空不显形）', !extRow || extRow.ok === true, extRow ? extRow.val : '（未出现，符合预期）');
    // score 与各项 ok 一致性：ok=true 的本服务项不得让分数少 8
    // score 自洽：每个红项（cut 类）扣 5~25 分，故 score 不低于 100-红项数×25；
    // 本服务项 ok=true 时不得扣分、也不得挂误导性处置文案。
    const ded = (j.items || []).filter((x) => x.ok === false).length;
    C('★score 与红项自洽（不因 ok 项虚扣；下界核算）', typeof j.score === 'number' && j.score <= 100 && j.score >= 100 - ded * 25, 'score=' + j.score + ' 红项=' + ded);
    C('★本服务项绿时无 fix 误导文案（只在红时给处置指引）', !!local && (local.ok === true ? !local.fix : true), JSON.stringify((local && local.fix) || '(无)'));
  } catch (e) { total++; fail++; console.log('❌ 异常：' + e.message); }
  finally { if (h) { try { await h.stop(); } catch (_) {} } }
  console.log('\n结果: ' + (total - fail) + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
