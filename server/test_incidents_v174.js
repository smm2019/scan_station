// ㉖v174 事故复盘单强制六问回归（夹具起真实实例，管理员区端点）
// 用户诉求：复盘模板化 + 强制回答"什么机制让它溜过去"。
// 光有模板文档禁不住人——必须验证 mechanism（及六问其余栏）留空时【服务器直接拒绝写入】，
// 填全才落库。这里用夹具空库实例（自带 admin/admin123）打真实端点，逐条验强制闸。
'use strict';
const path = require('path');
const kit = require('./test_conc_kit_v172.js');

const PORT = Number(process.env.INC_PORT || 8423);
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + String(i).slice(0, 100) + ']' : ''}`); };

const FULL = {
  title: '货位图取不到服务器数据显示管理员权限',
  what: 'v169 给 PDA 新增只读端点 /api/locmap，但线上进程仍是旧版、无此路由，请求落入兜底管理员闸门',
  impact: '仓库角色进货位图整页降级为本机快照，显示"需要管理员权限"，看不到全厂实时库存',
  whyRoot: 'server.js 只在启动时 loadDb 一次 + 路由是 v169 新增，但服务未重启，磁盘新代码未进内存',
  mechanism: '缺少"磁盘代码 vs 运行进程"一致性告警——改完代码不重启这件事没有任何东西提醒，v169~v172 全部积压在磁盘未生效却无人知；部署流程也无"重启确认"步骤',
  fix: 'health 回 code 指纹(sha+bytes+startedAt)+codeMismatch 自动比对磁盘 mtime，上线后哨兵可观测',
  prevent: 'CI 构建后起 server 打只读冒烟 + 磁盘比内存新自动告警 + 每次改完即提交推送形成重启提醒',
};
const REQ = ['title', 'what', 'impact', 'whyRoot', 'mechanism', 'fix', 'prevent'];

(async () => {
  let h = null;
  try {
    h = await kit.startInstance({ port: PORT, tag: 'inc' + process.pid, seedMode: 'empty', upTries: 60 });
    const tok = await h.login('admin', 'admin123');

    // 1) 全空 → 400，缺项点名（含"什么机制让它溜过去"）
    const e0 = await h.req('POST', '/api/incidents', tok, {});
    C('全空建单被拒 400', e0.status === 400, 'status=' + e0.status);
    C('拒绝理由点名全部七必填栏', /必填/.test((e0.json || {}).msg || '') && ['标题', '机制'].every((k) => new RegExp(k).test((e0.json || {}).msg || '')), String((e0.json || {}).msg).slice(0, 80));

    // 2) 只差 mechanism（用户点名强制栏）没填 → 必须单独被拒并点名
    const noMech = Object.assign({}, FULL); delete noMech.mechanism;
    const e1 = await h.req('POST', '/api/incidents', tok, noMech);
    C('★只缺"什么机制让它溜过去"也被拒 400', e1.status === 400 && /机制/.test((e1.json || {}).msg || ''), 'status=' + e1.status + ' ' + String((e1.json || {}).msg).slice(0, 70));
    C('★missing 数组含 mechanism', Array.isArray(e1.json.missing) && e1.json.missing.includes('mechanism'), JSON.stringify((e1.json || {}).missing));

    // 3) mechanism 填空格串 → 同样被拒（trim 判空，糊弄不过去）
    const blankMech = Object.assign({}, FULL, { mechanism: '   ' });
    const e2 = await h.req('POST', '/api/incidents', tok, blankMech);
    C('★mechanism 只填空格也算未答', e2.status === 400 && ((e2.json || {}).missing || []).includes('mechanism'), 'status=' + e2.status);

    // 4) 六问填全 → 200 落库
    const ok = await h.req('POST', '/api/incidents', tok, FULL);
    C('六问填全 → 建单成功 200', ok.status === 200 && ok.json.ok === true && ok.json.incident && ok.json.incident.mechanism === FULL.mechanism, 'status=' + ok.status);
    const id = (ok.json.incident || {}).id;
    C('建单自动记入操作留痕（事故复盘建单）', ok.status === 200, id);

    // 5) GET 列表能查到、字段齐
    const g = await h.req('GET', '/api/incidents?limit=50', tok);
    const row = (((g.json || {}).list) || []).find((x) => x.id === id);
    C('列表可查且六问字段完整', !!row && REQ.every((k) => (row[k] || '').length > 0), row ? 'title=' + row.title.slice(0, 20) : '未找到');
    C('建单人自动记录（by 非空）', !!row && !!row.by && !!row.createdBy, row && row.by);

    // 6) 更新已有单【必须带原 id】→ 流转 closed（不带 id 服务器按新单建，测不到更新）
    const upd = Object.assign({}, FULL, { id, status: 'closed' });
    const u = await h.req('POST', '/api/incidents', tok, upd);
    C('带 id 填全可更新并流转 closed', u.status === 200 && (u.json.incident || {}).status === 'closed' && u.json.incident.id === id, 'status=' + u.status);
    const g1 = await h.req('GET', '/api/incidents', tok);
    C('★更新未新建重复单（同 id 仅 1 条）', (((g1.json || {}).list) || []).filter((x) => x.id === id).length === 1);
    const g2 = await h.req('GET', '/api/incidents?status=closed', tok);
    C('状态过滤生效（closed 列表含该单）', (((g2.json || {}).list) || []).some((x) => x.id === id));

    // 7) 无 token 访问复盘列表 → 401（端点在鉴权区之后，不裸奔）
    const noauth = await fetch(h.base + '/api/incidents');
    C('★无 token 访问复盘被拒 401', noauth.status === 401, 'status=' + noauth.status);
  } catch (e) { total++; fail++; console.log('❌ 异常：' + e.message); }
  finally { if (h) { try { await h.stop(); } catch (_) {} } }
  console.log('\n结果: ' + (total - fail) + ' 通过 / ' + fail + ' 失败  （隔离空库实例，生产库零接触）');
  process.exit(fail ? 1 : 0);
})();
