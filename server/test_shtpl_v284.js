// ㉖v284 网页缺料分享文案=标准【缺料反馈】模板 端到端验证
// 用户截图实锤：网页版发的是自造简化【豪斯特缺料单】两行体，PDA v283 已自纠为系统标准模板，
// 群里出现两种格式。本测试从 console.html 真实抽取网页代码段，注入模拟数据跑真实逻辑，
// 断言产出与 PDA shortFeedText（lib/shortage_entry.dart:215）字段序逐条一致。
const fs = require('fs'), path = require('path'), vm = require('vm');
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + String(i).slice(0, 150) + ']' : ''}`); };

const html = fs.readFileSync(path.join(__dirname, 'public', 'console.html'), 'utf8');
// 抽取从 _tsFmt 到 tplShortCopy 的真实代码段
const a = html.indexOf('let _tsGaps=null');
const b = html.indexOf('async function tplShortSubmit(');
if (a < 0 || b < 0 || b < a) { console.log('❌ 无法抽取网页缺料代码段'); process.exit(1); }
const region = html.slice(a, b);
C('护栏 从 console.html 抽到缺料模板代码段', region.length > 500, region.length + ' 字符');

// 模拟数据：3 个零件（对齐用户截图的三行），全厂零在架、有在途需求、有末次领用
const P1 = '6608043632', P2 = '6608066747', P3 = '6608066748';
const ledItems = []; // 全厂账本：三个零件零在架 → items 为空
const dict = [
  { pn: P1, nm: '13-吉利EX1HA柱限位器加强板CSTD241232-冷冲', boxes: 0, recvBoxes: 0, perBoxQty: 0 },
  { pn: P2, nm: '13-吉利E281后防撞梁左安装座右连接板CSTD230736冷冲', boxes: 0, recvBoxes: 0, perBoxQty: 0 },
  // P3 档案查无此号 → backed=false，文案应带"（系统档案查无此号…）"
];
const lastMap = { [P1]: { t: Date.parse('2026-11-20T09:00:00+08:00'), qty: 200, by: '张三', no: 'LL20261120001' } };
// P2: lastT=0（近一年无人领过）；P3: 无记录条目但 lastOk=true → 也是 0
const demand = { [P1]: { qty: 120, docs: 2 }, [P2]: { qty: 60, docs: 1 } };

const env = {
  U: { name: '系统管理员' },
  _tplShortByPn: Object.fromEntries(dict.map(d => [d.pn, d])),
  _tplShortMiss: [
    { partNo: P1, itemName: dict[0].nm, qty: 1 },
    { partNo: P2, itemName: dict[1].nm, qty: 1 },
    { partNo: P3, itemName: dict[0].nm.slice(0, 8), qty: 1 },
  ],
  document: { querySelectorAll: () => [], getElementById: () => null },
  T: () => {}, api: async (p) => {
    if (p === '/api/ledger') return { ok: true, items: ledItems };
    if (p.startsWith('/api/req/last')) return { ok: true, map: lastMap, demand, windowDays: 365 };
    throw new Error('unexpected ' + p);
  },
};
env.window = env; env.setInterval = () => 0; env.setTimeout = () => 0;
// _tsSel 依赖 DOM 勾选框：这里直接注入全选的 stub
const ctx = vm.createContext(env);
vm.runInContext(region, ctx);
vm.runInContext('globalThis._tsSel=()=>window._tplShortMiss;', ctx); // 全选（与面板默认一致）

(async () => {
  await vm.runInContext(`_tsGapLoad(window._tplShortMiss.map(i=>i.partNo))`, ctx);
  vm.runInContext('tplShortPaint()', ctx);
  const txt = vm.runInContext('window._tplShortTxt', ctx);
  console.log('\n--- 网页产出的分享文案 ---\n' + txt + '\n------------------------\n');

  // 与 PDA shortFeedText 字段序逐条断言（每块 13+ 行）
  const blocks = txt.split('\n\n');
  C('三行缺料 → 三个独立【缺料反馈】块', blocks.length === 3, '块数=' + blocks.length);
  const b1 = blocks[0].split('\n');
  C('块1 首行=【缺料反馈】（非旧版豪斯特缺料单）', b1[0] === '【缺料反馈】', b1[0]);
  C('块1 含 反馈日期：YYYY-MM-DD', /^反馈日期：\d{4}-\d{2}-\d{2}$/.test(b1[1]), b1[1]);
  C('块1 零件号行', b1[2] === '零件号：' + P1, b1[2]);
  C('块1 物料名称行', b1[3] === '物料名称：' + dict[0].nm, b1[3].slice(0, 40));
  C('块1 全厂零在架', b1[4] === '全厂零在架', b1[4]);
  C('块1 在途领料需求行', b1[5] === '在途领料需求：120 件（2 单在等）', b1[5]);
  C('块1 缺件不折框（零在架无均值，防"缺5000件建议1框"）', b1[6] === '缺 120 件（当前无每框均值，不折框数以免误导）', b1[6]);
  C('块1 上次领用行（有记录）', /^上次领用：11-20 200 件（张三 LL20261120001）$/.test(b1[7]), b1[7]);
  C('块1 异常描述', b1[8] === '异常描述：生产急需，请安排采购/到货', b1[8]);
  C('块1 反馈单位（PDA 默认值）', b1[9] === '反馈单位：鄞州豪斯特生产部', b1[9]);
  C('块1 反馈人=当前登录用户', b1[10] === '反馈人：系统管理员', b1[10]);
  C('块1 责任单位/确认人/确认日期/@人', b1[11] === '责任单位：鄞州豪斯特运营部' && b1[12] === '确认人：宋明明' && /^确认日期：\d{4}-\d{2}-\d{2}$/.test(b1[13]) && b1[14] === '@Eleven @星光熠熠 @雪哥儿', b1.slice(11).join('|'));

  const b2 = blocks[1].split('\n');
  C('块2 无人领过行（lastT=0 服务端确认查过）', b2.some(l => l === '上次领用：近365天内无人领过'), JSON.stringify(b2.slice(6, 8)));
  C('块2 在途需求', b2.some(l => l === '在途领料需求：60 件（1 单在等）'));

  const b3 = blocks[2].split('\n');
  C('块3 档案查无此号标注（backed=false）', b3.some(l => l === '全厂零在架（系统档案查无此号，可能新项目/新零件）'), b3[4]);

  // 降级路径：ledger 拉取失败 → noData，绝不写"0 框"假数
  env.api = async (p) => { if (p === '/api/ledger') throw new Error('net'); return { ok: true, map: {}, demand: {}, windowDays: 365 }; };
  await vm.runInContext(`_tsGapLoad(window._tplShortMiss.map(i=>i.partNo))`, ctx);
  vm.runInContext('tplShortPaint()', ctx);
  const txt2 = vm.runInContext('window._tplShortTxt', ctx);
  C('降级：ledger 失败 → 文案标注数据不可用', txt2.includes('缺口数据未核算（服务器暂不可用）'));
  C('降级：绝不出现"全厂在架 0 框"假数', !txt2.includes('全厂在架 0 框'), txt2.slice(0, 80));
  C('降级：不出现"无人领过"（未知≠无记录）', !txt2.includes('无人领过'));

  // req/last 单独失败：在架数据仍正常，末次领用整行不出现（lastT=-1 未知态）
  env.api = async (p) => {
    if (p === '/api/ledger') return { ok: true, items: ledItems };
    throw new Error('req/last down');
  };
  await vm.runInContext(`_tsGapLoad(window._tplShortMiss.map(i=>i.partNo))`, ctx);
  vm.runInContext('tplShortPaint()', ctx);
  const txt3 = vm.runInContext('window._tplShortTxt', ctx);
  C('req/last 失败：零在架行正常输出', txt3.includes('全厂零在架'));
  C('req/last 失败：末次领用行整行不出现（不谎报）', !txt3.includes('上次领用'), (txt3.match(/上次领用[^\n]*/g) || ['(无)'])[0]);

  console.log(`\n==== v284 网页缺料模板同源测试：${total - fail}/${total} 通过${fail ? '（' + fail + ' 失败）' : ' ✅ 全绿'} ====`);
  process.exit(fail ? 1 : 0);
})();
