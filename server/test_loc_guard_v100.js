// ㉖v100 货位格式防线判据单元测试（纯函数，不依赖服务/数据）
// 判据直接从 server.js 现行实现抄录，逐值断言合法形态放行、病值/错配拦截。
// ㉖v120d 同步：locStrict 扩来料区结构域 NB04-{区}-{排2位}-{格3位}（固定位数，与 server.js 现行实现逐字一致）；排格上限=在线参数 recvRows×recvCols（默认1×720=720格），由 recvSlotOk 复核
const locStrict = (l) => { const s = String(l || '').trim().toUpperCase(); return /^NB02-[A-H]-\d{1,2}-[1-4]F$/.test(s) || /^NB03-[A-H]-\d{1,2}-\d{1,2}$/.test(s) || /^NB04-[A-H]-\d{2}-\d{3}$/.test(s); };
const recvSlotOk = (l, pr) => { const m = String(l || '').trim().toUpperCase().match(/^NB04-[A-H]-(\d{2})-(\d{3})$/); if (!m) return false; pr = pr || { recvRows: 1, recvCols: 720 }; const r = Number(m[1]), c = Number(m[2]); return r >= 1 && r <= pr.recvRows && c >= 1 && c <= pr.recvCols; };
const locRecv = (l) => /^NB04-/.test(String(l || '').trim().toUpperCase());
const locStation = (l) => /^NB02-CK-\d{1,2}$/.test(String(l || '').trim().toUpperCase());
const flowModeBad = (wt, st, gl) => { const s = String(st || '').trim().toUpperCase(), g = String(gl || '').trim().toUpperCase(); return Number(wt) === 0 ? /^NB03-/.test(s) : locStation(g); };

let pass = 0, fail = 0;
const T = (name, got, want) => { const ok = got === want; ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL!'} [${name}] got=${got} want=${want}`); };

console.log('== A. locStrict：账本/恢复层合法形态必须放行（零误伤）==');
// 高架 4 层 F 形态 + 地面 2 位格位形态（现场真实码样式）
T('A1 高位架 1F', locStrict('NB02-A-08-1F'), true);
T('A2 高位架 4F', locStrict('NB02-H-16-4F'), true);
T('A3 高位架 16列', locStrict('NB02-C-16-2F'), true);
T('A4 地面格 01', locStrict('NB03-A-11-01'), true);
T('A5 地面格 13', locStrict('NB03-B-13-13'), true);
T('A6 小写归一', locStrict('nb02-a-08-2f'), true);
T('A7 前后空格', locStrict('  NB03-A-11-02  '), true);
// 关键：12~16 列与 13 格等两位数区段实测存在，正则 \d{1,2} 必须放行

console.log('== B. locStrict：病值/非法形态必须拒（用户问的反向病源头）==');
T('B1 站台码(AGV误入账本)', locStrict('NB02-CK-03'), false); // 防线①③核心：站台不得上账
T('B2 站台码 12台', locStrict('NB02-CK-12'), false);
T('B3 地面粗码(缺格位)', locStrict('NB03-H-09'), false);
T('B4 高架粗码(缺层)', locStrict('NB02-A-05'), false);
T('B5 区字母+排(C12)', locStrict('C12'), false);
T('B6 单字母(H7)', locStrict('H7'), false);
T('B7 空值', locStrict(''), false);
T('B8 任意串', locStrict('随便写的'), false);
T('B9 错误前缀(NB04)', locStrict('NB04-A-01-1F'), false);
T('B10 层号越界 5F', locStrict('NB02-A-01-5F'), false);
T('B11 地面格层号混用', locStrict('NB03-A-01-1F'), false);

console.log('== C. locStation：站台码识别（flowModeBad 地面模式判据）==');
T('C1 CK-03', locStation('NB02-CK-03'), true);
T('C2 CK-12', locStation('NB02-CK-12'), true);
T('C3 货架位非站台', locStation('NB02-A-08-2F'), false);
T('C4 地面位非站台', locStation('NB03-A-11-02'), false);

console.log('== D. flowModeBad：流水跨模式错配体检（实测存量0行→零误伤；命中即留痕）==');
// AGV 模式（wt=0）：st 应为 NB02-CK 站台；填了地面 NB03 才是错配
T('D1 AGV st=站台 正常', flowModeBad(0, 'NB02-CK-05', ''), false);
T('D2 AGV st=站台 gl=货架 正常', flowModeBad(0, 'NB02-CK-05', 'NB02-A-05-1F'), false); // gl 记目标货架位=222行合法
T('D3 AGV st=地面(错配!)', flowModeBad(0, 'NB03-B-11-07', 'NB02-A-05-1F'), true); // 地面格位填进 AGV 初始位
T('D4 地面 模式 gl=格位 正常', flowModeBad(1, '', 'NB03-B-11-07'), false);
T('D5 地面 模式 gl=粗码 正常', flowModeBad(1, '', 'NB03-H-09'), false); // 7 行待补录不得拦
T('D6 地面 模式 gl=站台(错配!)', flowModeBad(1, '', 'NB02-CK-03'), true); // 反向病：地面框写成站台
T('D7 地面 模式 gl=空 正常', flowModeBad(1, '', ''), false);
T('D8 AGV st=空 正常', flowModeBad(0, '', 'NB02-A-05-1F'), false);

console.log('== E. 防线③恢复分支：按 wt 取到的位 locStrict 闸 ==');
// AGV 流水 wt=0 恢复 → 取 st=站台 → !locStrict 必须不上账
T('E1 恢复取到站台码被闸', !locStrict('NB02-CK-03'), true);
T('E2 恢复取到货架位放行', locStrict('NB02-A-05-1F'), true);
T('E3 恢复取到粗码被闸', !locStrict('NB03-H-09'), true);

console.log('== F. ㉖v120d 来料区 NB04-A-排-格：结构域双层闸（locStrict 结构 + recvSlotOk 参数范围，默认1排×720格=720格）==');
const RP = { recvRows: 1, recvCols: 720 }; // 默认参数快照（与 server PARAMS d 值同源）
T('F1 首格 A-01-001', locStrict('NB04-A-01-001') && recvSlotOk('NB04-A-01-001', RP), true);
T('F2 末格 A-01-720(720格边界内)', locStrict('NB04-A-01-720') && recvSlotOk('NB04-A-01-720', RP), true);
T('F3 小写归一', locStrict('nb04-a-01-007') && recvSlotOk('nb04-a-01-007', RP), true);
T('F4 格721 超参数拒(结构域放行)', locStrict('NB04-A-01-721') && recvSlotOk('NB04-A-01-721', RP), false);
T('F5 排02 超参数拒(结构域放行)', locStrict('NB04-A-02-001') && recvSlotOk('NB04-A-02-001', RP), false);
T('F6 格1000 结构域拒(4位超999)', locStrict('NB04-A-01-1000'), false);
T('F7 格000 结构域放行但超参数拒', locStrict('NB04-A-01-000') && !recvSlotOk('NB04-A-01-000', RP), true);
T('F8 旧NB01-R编码废弃拒', locStrict('NB01-R1-03'), false);
T('F9 旧错格式(带层)', locStrict('NB04-A-01-1F'), false);
T('F10 三段粗码拒', locStrict('NB04-A-01'), false);
T('F11 locRecv 判来料区', locRecv('NB04-A-01-003'), true);
T('F12 locRecv 非来料', locRecv('NB02-A-01-1F'), false);
T('F13 扩排后 A-02-001 放行', locStrict('NB04-A-02-001') && recvSlotOk('NB04-A-02-001', { recvRows: 3, recvCols: 720 }), true);
T('F14 扩格后 A-01-999 结构放行参数内', locStrict('NB04-A-01-999') && recvSlotOk('NB04-A-01-999', { recvRows: 1, recvCols: 999 }), true);
T('F15 排1位(A-1-001) 结构域拒(固定2位)', locStrict('NB04-A-1-001'), false);
T('F16 格2位(A-01-1) 结构域拒(固定3位)', locStrict('NB04-A-01-1'), false);

console.log(`\n===== 判据单测：${pass} PASS / ${fail} FAIL =====`);
process.exit(fail ? 1 : 0);
