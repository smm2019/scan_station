// ㉖v194+v197 清单落后警示 + 按项目批量拉下架 · 实例证明
// v194 原为"按项目直接移地面（目标地面格）"；v197 现场实锤改造：AGV 不能直达地面货位
//（RCS 沉淀数千条任务 0 条含 NB03 端，账本"移库改账"留痕 0 条=该路径从未真正完成过一框），
// 目标改为空闲 CK 站台（合法 shelf2shelf，空闲台轮转负载均衡），到台人工转地面+位置登记收账。
// 本套件同步改造：A组 清单落后警示（v194 原样）；B组 站台化新行为；C组 伪功能清零与静态边界。
const fs = require('fs');
const path = require('path');
const dart = fs.readFileSync(path.join(__dirname, '..', 'lib', 'inventory_page.dart'), 'utf8').replace(/\r\n/g, '\n');
const html = fs.readFileSync(path.join(__dirname, 'public', 'console.html'), 'utf8').replace(/\r\n/g, '\n');
const srv = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
let t = 0, f = 0;
const chk = (n, c, x) => { t++; if (!c) { f++; console.log('FAIL! [' + n + '] ' + (x || '')); } else console.log('PASS [' + n + ']'); };

// ── A组 PDA 清单落后警示（v194 原行为，未受 v197 影响）──
chk('A1 buildPickPlan 捕获拉取返回并取服务器行数', dart.includes('final pr = await ledgerPullMerge(force: true);') && dart.includes('pr["total"]'), '');
chk('A2 落后判定=本机行数<服务器行数（total>0 才判，跳过/失败不误报）', dart.includes('if (_svrRows > 0 && sp.length < _svrRows)'), '');
chk('A3 警示文案含 落后N行+先拉取对齐指引', dart.includes('本机账本 ${sp.length} 行 < 服务器 $_svrRows 行') && dart.includes('拉取对齐后重新展开'), '');
chk('A4 警示走 warn 通道（向导清单头可见）', /warn\.add\('⚠️ 本机账本/.test(dart), '');
chk('A5 校验在逐条展开循环之前（红字先于逐条信息）', dart.indexOf('if (_svrRows > 0 && sp.length < _svrRows)') < dart.indexOf('for (final t in toks) {'), '');

// ── B组 站台化批量拉下架（v197 新行为）──
chk('B1 呆滞卡入口在位（按钮=按项目批量拉下架）', html.includes('onclick="pjmvOpen()"') && html.includes('按项目批量拉下架'), '');
chk('B2 目标台来自看板（_pjmStns 拉 stboard，不手填地面格）', /async function _pjmStns\(\)/.test(html) && html.includes("/api/agv/stboard"), '');
chk('B3 空闲台轮转分配（台间负载均衡，非全部堆一台）', /const _pjmRot=\(i\)=>\{const ok=_pjmUsable\(\)/.test(html) && html.includes('ok[i%ok.length].code'), '');
// ㉖v198c 用户拍板：CK-01~04 现场为入库专用（stnMeta.role=in），拉下架不能压台
chk('B3b ★轮转池排除入库专用台（_pjmUsable=未停用∧role!=in）', /const _pjmUsable=\(\)=>_pjm\.stns\.filter\(s=>!s\.off&&s\.role!=='in'\)/.test(html), '');
chk('B3c ★轮转池无可用台时不再硬塞 CK-01（返回空而非入库台）', html.includes('if(!ok.length)return \'\''), '');
chk('B3d ★服务器端角色闸（/api/agv/transfer 拒 role=in 目标台）', /stnRole\(to\) === 'in'/.test(srv) && /入库专用站台/.test(srv), '');
chk('B3e 单框拉架同步排除+提示（可用数含空闲数，点in台被拦回）', (() => { const s0 = html.slice(html.indexOf('async function slowMove'), html.indexOf('async function slowMove') + 1400); return /_pjmFree\(\)/.test(s0) && s0.includes('入库专用站台'); })(), '');
chk('B4 只列在架AGV货架框（NB02前缀过滤+台挂行剔除，地面/来料/台面框通道不适用）', /if\(!pns\.has\(pn\)\|\|!\/\^NB02-\/\.test\(l\)\|\|\/-CK-\|-RK-\//.test(html), ''); // ㉖v198h 增强：台挂行 NB02-CK- 满足旧前缀会被误列，同步排除
chk('B5 项目来源=本地项目映射（零新后端接口）', html.includes('Object.entries(window._pjMap||{})'), '');
chk('B6 提交前预检：台必须在看板内+未停用+入库专用拒', /const st=_pjm\.stns\.find\(s=>s\.code===to\)/.test(html) && html.includes('if(st.off)') && html.includes("st.role==='in'"), '');
// ㉖v198c B7 语义升级：排除1~4号后可用台<框数成常态，"两框不同台"会整批拦死；
// 改=共台多框确认接力（台面一次一框，前框清走后台空自动补发，服务器串行闸兜底）
chk('B7 共目标台=确认排队接力（不再整批拒），入库台红框点名', html.includes('将排队接力') && html.includes('入库专用台，不能压台'), '');
const sub = html.slice(html.indexOf('async function pjmvSubmit'), html.indexOf('async function pjmvSubmit') + 3000);
const slow = html.slice(html.indexOf('async function slowMove'), html.indexOf('async function slowMove') + 1200);
chk('B8 批量与单框都走 shelf2shelf 合法路径（不再发 toGround）', sub.includes("kind:'shelf2shelf'") && slow.includes("kind:'shelf2shelf'") && !sub.includes("kind:'toGround'") && !slow.includes("kind:'toGround'"), '');
chk('B9 结果行区分排队数（节流补发体感透明）', /框拉下架/.test(sub) && sub.includes('排队中'), '');
chk('B10 单框入口（呆滞行尾按钮）同样站台化+提示到台后续动作', slow.includes('_pjmStns') && slow.includes('位置登记'), '');
chk('B11 二次确认写明正确动线（到台人工转地面+位置登记）', sub.includes('人工把框转去地面') || sub.includes('到台后：人工把框转去地面'), '');

// ── C组 伪功能清零 + 静态边界 ──
chk('C1 ★地面格换算伪功能已彻底清除（_pjmTo 不存在）', !html.includes('_pjmTo'), '');
chk('C2 全站再无 toGround 发起入口（slowMove/pjmv 两处清零）', !slow.includes("kind:'toGround'") && !sub.includes("kind:'toGround'"), '');
chk('C3 改造根因在代码注释留档（后人不再重造地面直送）', html.includes('AGV 地面区不可达') && /RCS 历史任务 0 条含 NB03|RCS 沉淀数千条任务 0 条含 NB03|RCS 沉淀几千条任务 0 条含 NB03/.test(html + sub + slow), '');
const fns = ['pjmvOpen', 'pjmvFill', 'pjmvTg', 'pjmvSelAll', 'pjmvAuto', 'pjmvCnt', 'pjmvSubmit', '_pjmStns', '_pjmRot'];
chk('C4 弹层函数齐全（含新增站台两函数）', fns.every((k) => html.includes('function ' + k) || html.includes('const ' + k + '=')), fns.filter((k) => !html.includes('function ' + k) && !html.includes('const ' + k + '=')).join(',')); // _pjmRot 是 const 箭头函数（旧断言只认 function 前缀致假失败）
// ㉖v198c C5 语义升级：同起点(含反向)重复仍拒；同目标台不再拒提交，改为下发阶段串行接力闸
chk('C5 服务器互斥兜底（同起点重复拒+出库占用拒+目标台串行排队闸）', srv.includes("x.type === 'transfer' && (x.from === from || (x.from === to && x.to === from))") && srv.includes('AGV_STNS.includes(to)') && srv.includes('目标台串行闸'), '');
chk('C6 呆滞行尾按钮路由到站台化单框逻辑（未遗留地面弹窗）', html.includes("onclick=\"slowMove("), '');
try { let bad = ''; [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].forEach((x, i) => { try { new Function(x[1]); } catch (e) { bad += 's' + i + ':' + e.message; } }); chk('C7 网页全部脚本语法通过', bad === '', bad.slice(0, 120)); } catch (e) { chk('C7', false, e.message); }

console.log('\n===== v194/v197 清单警示+按项目批量拉下架实例证明 ' + (t - f) + '/' + t + ' PASS =====');
process.exit(f ? 1 : 0);
