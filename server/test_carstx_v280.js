// ㉖v280 车辆细态推导 carPhaseTxt 取证（地图/PDA/车辆页三端共用的单源判据）
// 断言 = RCS 原生心智（取货/卸货/返回待命中）+ 我们更细的阶段，与两端显示口径锁死
const fs = require('fs');
const src = fs.readFileSync(path_join_fix(), 'utf8');
function path_join_fix() { return require('path').join(__dirname, 'server.js'); }
// vm 抽取纯函数（既有取证模式：不依赖 db，直测判据）
const vm = require('vm');
const m = src.match(/function carPhaseTxt\(c, rt, isBlocked, alarmTxt\) \{[\s\S]*?\n\}/);
if (!m) { console.log('FAIL! 未抽取到 carPhaseTxt（函数名或签名变更，两端注释同步要求失效）'); process.exit(1); }
const ctx = {}; vm.createContext(ctx); vm.runInContext(m[0], ctx);
const f = ctx.carPhaseTxt;
let fail = 0, total = 0;
const chk = (n, c, got) => { total++; if (c !== got) { fail++; console.log(`FAIL! [${n}] 期望=${c} 实得=${got}`); } else console.log(`PASS [${n}] → ${got}`); };
const online = { online: true, enable: 1, communicationBreak: false, emerg: false, mstop: false, charging: false, state: 'running', power: 80 };
// 优先级链
chk('急停压过一切', f({ ...online, emerg: true }, { no: 'LL1', state: 1 }, false, '告警x'), '急停');
chk('人工停', f({ ...online, mstop: true }, null, false, ''), '人工停');
chk('被交管', f(online, { no: 'LL1', state: 1 }, true, ''), '被交管');
chk('离线', f({ ...online, online: false, communicationBreak: true }, null, false, ''), '离线');
chk('告警', f(online, { no: 'LL1', state: 1 }, false, 'fp串'), '告警');
chk('充电中', f({ ...online, charging: true }, null, false, ''), '充电');
chk('充满', f({ ...online, charging: true, full: true }, null, false, ''), '充满');
// 空闲与车体态
chk('无任务空闲', f({ ...online, state: 'idle' }, null, false, ''), '空闲');
chk('暂停', f({ ...online, state: 'pause' }, null, false, ''), '暂停');
chk('故障', f({ ...online, state: 'error' }, null, false, ''), '故障');
// 自主导航（UUID调度号）
chk('UUID低电→去充电', f({ ...online, power: 18 }, { no: '12345678-abcd-ef01-2345-6789abcdef01', state: 1 }, false, ''), '去充电');
chk('UUID正常电→返航待命', f(online, { no: '12345678-abcd-ef01-2345-6789abcdef01', state: 1 }, false, ''), '返航待命');
// 业务任务阶段（字段=db.rcsRun 行：no/state/pickAt/putAt）
chk('排队待接', f(online, { no: 'LL20261126001', state: 0 }, false, ''), '排队待接');
chk('去取货(执行中未叉起)', f(online, { no: 'LL20261126001', state: 1 }, false, ''), '去取货');
chk('去放架(叉起未放)', f(online, { no: 'LL20261126001', state: 1, pickAt: 111 }, false, ''), '去放架');
chk('放架收尾(state=2)', f(online, { no: 'LL20261126001', state: 2, pickAt: 111, putAt: 222 }, false, ''), '放架收尾');
chk('叉起又重置不放架? 仍去放架(货在车上)', f(online, { no: 'LL20261126001', state: 1, pickAt: 111, putAt: 0 }, false, ''), '去放架');
// 车辆页字段口径（task/executeTaskNo 兜底 + carState）
chk('车辆页无rt用task兜底', f({ ...online, task: 'LL20261126002', carState: 'running' }, undefined, false, ''), '去取货');
chk('车辆页task=UUID+低电power', f({ ...online, task: 'aaaabbbb-cccc-dddd-eeee-ffff00001111', power: 10 }, undefined, false, ''), '去充电');
console.log(`\n===== v280 车辆细态取证：${total - fail}/${total} PASS =====`);
process.exitCode = fail ? 1 : 0;
