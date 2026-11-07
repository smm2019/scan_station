// ㉖v120c 出库台账镜像去重+转单宽限期 · 端到端实例证明
// 素材=生产库真实事故：LL2026110709091377 转单与 10 分钟周期扫描同秒竞态，
//   SRV-DT20261107092121-1214 镜像与真单 DT20261107092121 并存（同 2 标签，D4 记成 4 行）。
// 断言面：①孪生镜像被去重删除、真单与账本/领料单零触碰 ②无孪生的历史正确补建单保留
//   ③超宽限(6分钟)转单行启动扫描照常补建 ④宽限内(10秒)转单行不补建（竞态堵死）
//   ⑤D4 出库流水该 2 标签恢复 2 行 ⑥去重留痕进事件流
const fs = require('fs'); const path = require('path'); const cp = require('child_process'); const crypto = require('crypto');
const SRC = path.join(__dirname, 'data'); const TDIR = path.join(__dirname, 'data_e2e_twin_v120c'); const PORT = 8353; const BASE = 'http://127.0.0.1:' + PORT;
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(SRC, 'db.json'), path.join(TDIR, 'db.json')); // 直接复制生产事故现场
fs.copyFileSync(path.join(SRC, 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(16).toString('hex'); const hashPw = (pw, s) => crypto.scryptSync(String(pw), s, 32).toString('hex');
const now = Date.now();
db0.users.push({ id: 'u_tw', username: 'tw_wh', name: 'TW仓管', role: 'warehouse', enabled: true, createdAt: now, mustChangePw: false, salt, passHash: hashPw('E2e#Tw!120c', salt) });
// 注入两条已转单行：A 超宽限(6分钟前转) 应补建；B 宽限内(10秒前转) 应跳过——标签均不在台账不在账本
const mkReq = (id, no, pn, tag, tAt) => ({ id, no, by: 'u_tw', byName: 'TW仓管', status: 'done', createdAt: new Date(tAt).toISOString(), history: [], items: [{ partNo: pn, qty: 100, name: 'TW取证件', issued: [{ c: tag, q: 100, l: 'NB02-A-02-2F' }], transferred: true, transferAt: tAt, transferBy: 'TW仓管', transferQty: 100 }] }); // ㉖v122 createdAt 必须 ISO 字符串（与生产同型）：归档判据 Date.parse(数字毫秒)=NaN→0 会被当超期单在补建扫描前归档删除，致 T5 夜间假失败
db0.requisitions.push(mkReq('q_fix_a', 'LLFIX20261107A', '66FIXPNA0001', 'FIXTAGA0001', now - 6 * 60000));
db0.requisitions.push(mkReq('q_fix_b', 'LLFIX20261107B', '66FIXPNB0001', 'FIXTAGB0001', now - 10000));
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const chk = (n, g, w) => { total++; const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL!'} [${n}] got=${JSON.stringify(g)} want=${JSON.stringify(w)}`); };
const chkT = (n, c) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]`); };
(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { const r = await fetch(BASE + '/api/health'); up = r.ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪'); srv.kill(); process.exit(1); }
  console.log('隔离实例已就绪（生产事故数据副本），等启动补建扫描(8秒)…');
  await sleep(14000); // 启动 8 秒的 outboundLedgerFix 跑完（先去重后补建）
  let db; try { db = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8')); } catch (e) { db = null; }
  try {
    chkT('T0 服务落盘可读', !!db && !!db.outbound);
    // ===== 1. 孪生镜像去重 =====
    chk('T1 事故镜像单 SRV-DT20261107092121-1214 已删除', !!(db.outbound || {})['SRV-DT20261107092121-1214'], false);
    const real = (db.outbound || {})['DT20261107092121'];
    chk('T2 真单保留且 2 标签完整', [!!real, ((real || {}).items || []).length], [true, 2]);
    const tags = ['N26J310237', 'N26J310196'];
    const d4rows = [];
    for (const o of Object.values(db.outbound || {})) for (const i of o.items || []) if (tags.includes(String(i.barcode || '').toUpperCase())) d4rows.push(o.orderNo + '|' + i.barcode);
    chk('T3 D4 出库流水该 2 标签恢复 2 行（原 4 行）', d4rows.length, 2);
    // ===== 2. 无孪生的历史正确补建单保留 =====
    const keepSrv = ['SRV-DT20261025152113-2236', 'SRV-DT20261025192817-8645', 'SRV-DT20261025204542-2091'].filter((k) => !!(db.outbound || {})[k]);
    chk('T4 10/25 三张真丢单补建（无孪生）原样保留', keepSrv.length, 3);
    // ===== 3. 宽限期 =====
    const srvOf = (tag) => Object.values(db.outbound || {}).find((o) => String(o.orderNo).startsWith('SRV-') && (o.items || []).some((i) => String(i.barcode || '').toUpperCase() === tag));
    chk('T5 超宽限行(6分钟前转)启动扫描照常补建', !!srvOf('FIXTAGA0001'), true);
    chk('T6 宽限内行(10秒前转)不补建（竞态堵死，PDA 推送窗口保留）', !!srvOf('FIXTAGB0001'), false);
    // ===== 4. 数据零触碰（账本/领料单/库存） =====
    const led = (db.ledger || []).map((x) => String(x.c || '').toUpperCase());
    chk('T7 账本未被触碰（4 个取证标签均不在账本）', [tags, 'FIXTAGA0001', 'FIXTAGB0001'].flat().some((c) => led.includes(c)), false);
    const r0 = (db.requisitions || []).find((x) => x.no === 'LL2026110709091377');
    const it0 = ((r0 || {}).items || []).find((i) => i.partNo === '8892921214');
    chk('T8 领料单零触碰（仍 done、实发 1500 不变）', [r0 && r0.status, ((it0 || {}).issued || []).reduce((s, e) => s + (Number(e.q) || 0), 0)], ['done', 1500]);
    // ===== 5. 去重留痕 =====
    const ev = (db.carEvents || []).filter((e) => String(e.kind || '').includes('出库台账镜像去重'));
    chk('T9 镜像去重留痕进事件流', ev.length >= 1, true);
    chkT('T10 留痕内容点名镜像单与剔除数', ev.some((e) => String(e.msg || '').includes('SRV-DT20261107092121-1214') || String(e.who || '').includes('SRV-DT20261107092121-1214')));
  } catch (e) { fail++; console.log('FAIL! 异常：', e && e.message); }
  finally { srv.kill(); }
  console.log(`\n===== v120c 镜像去重+宽限期实例证明：${total - fail}/${total} PASS =====`);
  fs.rmSync(TDIR, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
