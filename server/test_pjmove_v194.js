// ㉖v194 清单落后警示 + 按项目直接移地面 · 实例证明
// 用户拍板两件事（11-15 双设备"20 vs 32框"两个答案实锤 + V446K整项目腾库需求）：
// ①PDA 展开应扫清单时同口径校验：本机账本行数<服务器行数→清单头红字"落后N行可能缺框"（账本快照v98同款警告补齐）
// ②网页呆滞卡加"按项目直接移地面"：不限呆滞天数，项目→在架货架框多选批量 shelf→ground（复用 /api/agv/transfer 零新后端）
const fs = require('fs');
const path = require('path');
const dart = fs.readFileSync(path.join(__dirname, '..', 'lib', 'inventory_page.dart'), 'utf8').replace(/\r\n/g, '\n');
const html = fs.readFileSync(path.join(__dirname, 'public', 'console.html'), 'utf8').replace(/\r\n/g, '\n');
const srv = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
let t = 0, f = 0;
const chk = (n, c, x) => { t++; if (!c) { f++; console.log('FAIL! [' + n + '] ' + (x || '')); } else console.log('PASS [' + n + ']'); };

// ── A组 PDA 清单落后警示 ──
chk('A1 buildPickPlan 捕获拉取返回并取服务器行数', dart.includes('final pr = await ledgerPullMerge(force: true);') && dart.includes('pr["total"]'), '');
chk('A2 落后判定=本机行数<服务器行数（total>0 才判，跳过/失败不误报）', dart.includes('if (_svrRows > 0 && sp.length < _svrRows)'), '');
chk('A3 警示文案含 落后N行+先拉取对齐指引', dart.includes('本机账本 ${sp.length} 行 < 服务器 $_svrRows 行') && dart.includes('拉取对齐后重新展开'), '');
chk('A4 警示走 warn 通道（向导清单头可见，与既有警示同机制）', /warn\.add\('⚠️ 本机账本/.test(dart), '');
chk('A5 校验在逐条展开循环之前（红字先于逐条信息）', dart.indexOf('if (_svrRows > 0 && sp.length < _svrRows)') < dart.indexOf('for (final t in toks) {'), ''); // 锚点用循环起始（旧版误写 const locRe，代码实为 final 致 indexOf=-1 假失败）

// ── B组 网页按项目移地面 ──
chk('B1 呆滞卡入口按钮在位（按项目直接移地面）', html.includes('onclick="pjmvOpen()"') && html.includes('按项目直接移地面'), '');
chk('B2 项目来源=本地项目映射（零新后端接口）', html.includes('Object.entries(window._pjMap||{})'), '');
chk('B3 只列在架AGV货架框（NB02前缀过滤，地面/来料框排除）', html.includes("if(!pns.has(pn)||!/^NB02-/.test(l))continue;"), '');
chk('B4 按货架格位去重=一格一框（多标签同格=1条移库任务）', html.includes('bx[l]=bx[l]||{l,pn,') && html.includes('Object.values(bx).sort'), '');
chk('B5 目标地面格自动建议=同区排换算（NB02→NB03 尾段-01）', /_pjmTo=/.test(html) && html.includes(".replace('NB02','NB03')"), '');
chk('B6 目标格可逐格手改+清空失焦回落建议', html.includes('onblur="pjmvAuto(') && html.includes('if(!v)el.value=_pjmTo(_pjm.rows[i].l)'), '');
chk('B7 提交前端预检：地面格格式+不等起点', /NB03-\[A-H\]-\\d\{2\}-\\d\{1,2\}/.test(html), '');
chk('B8 目标重复红框点名（两框不能进同一地面格）', html.includes('目标重复，两框不能进同一地面格'), '');
const sub = html.slice(html.indexOf('async function pjmvSubmit'), html.indexOf('async function pjmvSubmit') + 3000);
chk('B9 发起复用同款 transfer 接口 kind:toGround', sub.includes('/api/agv/transfer') && sub.includes("kind:'toGround'"), '');
chk('B10 busy防重入+进度提示+逐条失败聚合（部分成功不谎报）', sub.includes('if(_pjm.busy)return;') && sub.includes('发起中 ') && sub.includes('fails'), '');
chk('B11 二次确认含后续动作指引（人工入格+位置登记收账）', sub.includes('位置登记') && sub.includes('人工入格'), '');
chk('B12 提交后重刷列表', sub.includes('pjmvFill();'), '');

// ── C组 安全边界 ──
chk('C1 服务器互斥兜底仍在（同格进行中移库/出库任务被服务器拒）', srv.includes("x.type === 'transfer' && (x.from === from || x.to === to)"), '');
chk('C2 弹层函数齐全7个（open/fill/tg/selAll/auto/cnt/submit）', ['pjmvOpen', 'pjmvFill', 'pjmvTg', 'pjmvSelAll', 'pjmvAuto', 'pjmvCnt', 'pjmvSubmit'].every((k) => html.includes('function ' + k)), '');
try { let bad = ''; [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].forEach((x, i) => { try { new Function(x[1]); } catch (e) { bad += 's' + i + ':' + e.message; } }); chk('C3 网页全部脚本语法通过', bad === '', bad.slice(0, 120)); } catch (e) { chk('C3', false, e.message); }

console.log('\n===== v194 清单警示+按项目移地面实例证明 ' + (t - f) + '/' + t + ' PASS =====');
process.exit(f ? 1 : 0);
