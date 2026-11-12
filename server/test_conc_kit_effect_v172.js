// ㉖v172 夹具有效性验证：用并发夹具复现【已修的盲窗缺陷 v168】与【撞格 v163】
// 为什么单独写这个：夹具契约测试只证明"能起实例/能并发发请求"，但那不等于
// "夹具能捕获真实并发缺陷"。若夹具发出去的并发请求其实被序列化了、或时序不对，
// 用它写的用例永远绿灯、抓不到 bug——夹具就成了摆设。
// 本文件用夹具【真的去踩】两个已修缺陷的点，断言"修了=不复发"：
//   ① 盲窗 v168：A 机 reserve 后未推送，B 机同时查同码 → 必须被拦（旧版放行→双记账）
//   ② 撞格 v163：N 个不同码并发抢同一区排 → 必须拿到互不相同的格位（旧版会撞）
// 只有这两条用夹具跑出来是对的，才证明夹具的"并发"是真并发、时序可信。
const fs = require('fs');
const path = require('path');

// ★ CI 无 data/db.json 时显式 SKIP（exit 0，与其余依赖生产库的测试同类）：
//   跨设备盲窗需夹具注入【两个不同身份】(A机/B机)——夹具注入账号只在"复制生产库副本"分支生效；
//   CI 无生产库 → 夹具走空库 → server 只 seed admin 单身份 → 无法验跨设备盲窗(同用户 reserve+check
//   会命中"自己"放行分支)。故无库环境判 SKIP 而非硬跑挂门禁。（此处引用 data/db.json 也令
//   selftest_ci_runner 的 needDbOf 直接把它归入 CI-SKIP，不必跑起来才判。）
if (!fs.existsSync(path.join(__dirname, 'data', 'db.json'))) {
  console.log('⏭ SKIP：无 data/db.json（CI 环境）——跨设备盲窗验证需生产库副本注入多身份，与其余依赖库测试同类跳过');
  process.exit(0);
}

const kit = require('./test_conc_kit_v172.js');
const { startInstance, conc } = kit;

const PORT = Number(process.env.KIT_EFF_PORT || 8416);
const ZONE = 'H31'; // 测试专用区排（副本里用 mutate 清干净）
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + i + ']' : ''}`); };

(async () => {
  let h = null;
  try {
    // 用夹具的 mutate 钩子：起实例前就地清测试区排占用（无需"改库→stop→重启"，
    // 且 stop 会删临时目录，旧写法改库会在重启后丢失——这正是加 mutate 的原因）
    h = await startInstance({
      port: PORT, tag: 'kiteff',
      users: [{ username: 'eff_a', role: 'warehouse', password: 'Kit#Pass1' }, { username: 'eff_b', role: 'warehouse', password: 'Kit#Pass1' }],
      params: { receivingOn: 0 },
      mutate: (db) => {
        db.ledger = (db.ledger || []).filter((x) => !String(x.l || '').toUpperCase().startsWith('NB03-H-31-'));
        db.groundSlots = Object.assign(db.groundSlots || {}, { 'NB03-H-31': 12 });
      },
    });
    const [tA, tB] = await conc([() => h.login('eff_a', 'Kit#Pass1'), () => h.login('eff_b', 'Kit#Pass1')]);
    C('夹具双设备 token 就绪（mutate 钩子已生效）', !!tA && !!tB);

    // ===== ① 盲窗：A reserve 同码未推送，B 同时查同码必须被拦 =====
    {
      const CODE = 'KITBLIND0001', PN = '66KITPN001';
      const rv = await h.req('POST', '/api/ledger/reserve', tA, { code: CODE, partNo: PN, zone: ZONE });
      C('前置 A 机分格成功', rv.status === 200 && rv.json.ok === true && !!rv.json.loc, rv.json && rv.json.loc);
      // A 未推任何数据（盲窗成立）。B 此刻查同码：必须 blockIn=true（旧版=false 放行→双记账）
      const cb = await h.req('GET', '/api/label/check?c=' + CODE, tB);
      C('★★盲窗复现：B 查 A 已预占未推送的同码 → blockIn=true 被拦（v168 已修）', cb.status === 200 && cb.json.blockIn === true, 'blockIn=' + (cb.json || {}).blockIn + ' 提示=' + String((cb.json || {}).reason || '').slice(0, 24));
      // 反向：B 若也去 reserve 同码，应拿到同格（幂等复用），不是抢到新格
      const rvB = await h.req('POST', '/api/ledger/reserve', tB, { code: CODE, partNo: PN, zone: ZONE });
      C('★B 对同码 reserve 复用 A 同格（幂等，非各占一格）', rvB.json.loc === rv.json.loc, 'A=' + rv.json.loc + ' B=' + (rvB.json || {}).loc);
    }

    // ===== ② 撞格：8 个不同码【并发】抢同区排，格位必须互不相同 =====
    {
      const codes = Array.from({ length: 8 }, (_, i) => 'KITGCL' + String(i).padStart(4, '0'));
      // 真并发：8 个 reserve 同时发起（Promise.all 同时到服务器，验证单线程同步段互斥）
      const rs = await conc(codes.map((c, i) => () => h.req('POST', '/api/ledger/reserve', i % 2 ? tB : tA, { code: c, partNo: '66KITGC' + i, zone: ZONE })));
      const got = rs.map((r) => r.json.loc).filter(Boolean);
      C('★★撞格复现：8 框并发分格全部成功', got.length === 8, '成功 ' + got.length + '/8');
      C('★★★并发分格格位互不相同（零撞格，v163 原子分配成立）', new Set(got).size === 8, '去重后 ' + new Set(got).size + '/8');
    }
    C('夹具实例经并发后仍健康', (await h.req('GET', '/api/health')).status === 200);
  } catch (e) {
    C('❌ 夹具有效性验证异常', false, String(e.message).split('\n')[0]);
  } finally {
    if (h) { try { await h.stop(); } catch (_) {} }
  }
  console.log('\n结果: ' + (total - fail) + ' 通过 / ' + fail + ' 失败  （隔离副本，生产库零写入）');
  process.exit(fail ? 1 : 0);
})();
