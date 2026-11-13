// ㉖v172 关键不变量常驻自检验证（第2层"止血"核心）
// 三条账实不变量里，①「同码同格一条有效流水」dupFlowAlert 已覆盖（v167），本套件验证新增两条：
//   ②一个格位只放一个托   ③幽灵框=MES已出库但本地账本仍在架（出库未消账）
// ★ 两层都要测（本项目血泪：抽函数绿了 ≠ 集成通，spawnSync 假崩、路径失真都栽过）：
//   A 抽函数验判据边界（合法同托放过/托号缺失只留痕/开关关不跑/关消账档时幽灵不判/7天去重/快照）
//   B 真实实例验哨兵真的会跑：起 server → 读 health.invariant 看在岗 → 读 db.notifications 看真发通知
//   C 真实全库回归：生产快照里 44 处多码同格必须 0 误报（这是"上线第一天不刷屏"的前提，误报=功能被关）
// 全程隔离副本 + 独立端口，生产库与生产进程零接触。
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const vm = require("vm");

const HERE = __dirname;
const SRC = fs.readFileSync(path.join(HERE, "server.js"), "utf8").replace(/\r\n/g, "\n");
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? "✅" : "❌"} ${n}${i !== undefined ? "  [" + i + "]" : ""}`); };
const topFn = (name) => { const i = SRC.indexOf("function " + name + "("); if (i < 0) throw new Error("找不到 " + name); for (let j = i; j < SRC.length; j++) if (SRC.slice(j, j + 2) === "\n}" && (j + 2 >= SRC.length || SRC[j + 2] === "\n")) return SRC.slice(i, j + 2); };

// 抽函数执行器：注入真实 Date（曾因注入 Date:Object 令 Date.now() 抛异常被 catch 吞→假失败）
function runInvariant(dbObj, params) {
  const ops = [], notified = [], errs = [], logs = [];
  const ctx = vm.createContext({
    db: dbObj, P: () => params, ledgerView: () => dbObj.ledger,
    notify: (id, type, text) => notified.push({ id, type, text }),
    pushOps: (u, act, obj, det) => ops.push({ act, obj, det }),
    logErr: (w, e) => errs.push(w + ":" + (e && e.message)), save: () => {},
    Date, Math, Object, Array, String, Number, Map, Set, RegExp, JSON, isNaN,
    console: { log: (x) => logs.push(String(x)) },
  });
  vm.runInContext(topFn("invariantSweep"), ctx);
  vm.runInContext("invariantSweep()", ctx);
  return { ops, notified, errs, logs };
}
const mkDb = (o) => Object.assign({ ledger: [], scanlog: {}, seenOut: {}, users: [{ id: "w1", enabled: true, role: "warehouse" }] }, o);

// ================= A. 抽函数验判据边界 =================
console.log("--- A 判据边界（抽函数）---");
const NOW = Date.now();
{ // 真撞位：同格两不同托号 → 必报 + 必发 ghost_out
  const db = mkDb({ ledger: [{ c: "AA1", l: "NB02-A-05-1F", pid: "P1" }, { c: "AA2", l: "NB02-A-05-1F", pid: "P2" }] });
  const r = runInvariant(db, { invariantAlertOn: 1, outConsumeLedger: 1 });
  C("②同格两不同托号→报库存自检", /一格多托/.test(r.ops.map((o) => o.act).join("")), r.ops.map((o) => o.act).join(","));
  C("②且发 ghost_out 必达（每人一条，含格位）", r.notified.length === 1 && r.notified[0].type === "ghost_out" && /NB02-A-05-1F/.test(r.notified[0].text));
  C("②快照 lastInvariantCheck.locClash=1", db.lastInvariantCheck && db.lastInvariantCheck.locClash === 1, JSON.stringify(db.lastInvariantCheck));
  C("无异常逃逸", r.errs.length === 0, r.errs.join(";"));
}
{ // 合法同托：整托多码共用一格（同 pid）→ 必须放过，否则现网43处全刷屏=功能被关
  const db = mkDb({ ledger: [{ c: "BB1", l: "NB03-B-08-03", pid: "SAME" }, { c: "BB2", l: "NB03-B-08-03", pid: "SAME" }, { c: "BB3", l: "NB03-B-08-03", pid: "SAME" }] });
  const r = runInvariant(db, { invariantAlertOn: 1, outConsumeLedger: 1 });
  C("②同托多码共用一格→放过（不误报）", r.ops.length === 0 && r.notified.length === 0, "ops=" + r.ops.length);
  C("②快照 locClash=0（合法不计）", db.lastInvariantCheck.locClash === 0, JSON.stringify(db.lastInvariantCheck));
}
{ // 托号缺失：证据不足只留痕不点名
  const db = mkDb({ ledger: [{ c: "CC1", l: "NB02-D-01-2F", pid: "" }, { c: "CC2", l: "NB02-D-01-2F", pid: "" }] });
  const r = runInvariant(db, { invariantAlertOn: 1, outConsumeLedger: 1 });
  C("②托号全缺失→留痕但【不点名不发通知】", /托号缺失/.test(r.ops.map((o) => o.act).join("")) && r.notified.length === 0, "notified=" + r.notified.length);
  C("②托号缺失不计入 locClash（非确证撞位）", db.lastInvariantCheck.locClash === 0);
}
{ // 幽灵框：MES出库晚于最后入库 + 账本仍在 → 报账实自检 + 发通知
  const db = mkDb({ ledger: [{ c: "GH1", l: "NB02-A-09-1F", pid: "P" }], scanlog: { "GH1|b|1": { code: "GH1", t: NOW - 86400000, cx: false } }, seenOut: { GH1: { at: NOW - 3600000, no: "DT9" } } });
  const r = runInvariant(db, { invariantAlertOn: 1, outConsumeLedger: 1 });
  C("③幽灵框→报账实自检", /幽灵框/.test(r.ops.map((o) => o.act).join("")), r.ops.map((o) => o.act).join(","));
  C("③且发 ghost_out 含标签与出库单号", r.notified.length === 1 && /GH1/.test(r.notified[0].text) && /DT9/.test(r.notified[0].text));
  C("③快照 ghost=1", db.lastInvariantCheck.ghost === 1, JSON.stringify(db.lastInvariantCheck));
}
{ // 合法回流：出库后又再入库（最后入库晚于出库）→ 不是幽灵，必须放过
  const db = mkDb({ ledger: [{ c: "GH2", l: "NB02-A-09-2F", pid: "P" }], scanlog: { "GH2|b|1": { code: "GH2", t: NOW - 1000, cx: false } }, seenOut: { GH2: { at: NOW - 86400000, no: "DT8" } } });
  const r = runInvariant(db, { invariantAlertOn: 1, outConsumeLedger: 1 });
  C("③出库后又回流再入库→放过（合法）", !/幽灵框/.test(r.ops.map((o) => o.act).join("")) && db.lastInvariantCheck.ghost === 0, "ghost=" + db.lastInvariantCheck.ghost);
}
{ // ★关消账档（outConsumeLedger=0）：幽灵判据必须整体不启用，否则全部出库框误报
  const db = mkDb({ ledger: [{ c: "GH3", l: "NB02-A-09-3F", pid: "P" }], scanlog: { "GH3|b|1": { code: "GH3", t: NOW - 86400000, cx: false } }, seenOut: { GH3: { at: NOW - 3600000, no: "DT7" } } });
  const r = runInvariant(db, { invariantAlertOn: 1, outConsumeLedger: 0 });
  C("③outConsumeLedger=0→幽灵判据整体关闭（防全量误报）", !/幽灵框/.test(r.ops.map((o) => o.act).join("")) && db.lastInvariantCheck.ghost === 0, "ghost=" + db.lastInvariantCheck.ghost);
}
{ // 开关关闭：哨兵不跑
  const db = mkDb({ ledger: [{ c: "Z1", l: "NB02-A-05-1F", pid: "P1" }, { c: "Z2", l: "NB02-A-05-1F", pid: "P2" }] });
  const r = runInvariant(db, { invariantAlertOn: 0, outConsumeLedger: 1 });
  C("开关=0→哨兵完全停摆（现场可关）", r.ops.length === 0 && r.notified.length === 0 && db.lastInvariantCheck === undefined);
}
{ // 7 天去重：同一撞位第二次跑不再发通知（不刷屏），但快照仍刷新
  const db = mkDb({ ledger: [{ c: "DD1", l: "NB02-A-06-1F", pid: "P1" }, { c: "DD2", l: "NB02-A-06-1F", pid: "P2" }] });
  const r1 = runInvariant(db, { invariantAlertOn: 1, outConsumeLedger: 1 });
  const r2 = runInvariant(db, { invariantAlertOn: 1, outConsumeLedger: 1 });
  C("首次报 + 通知", r1.notified.length >= 1);
  C("★7天去重：第二次跑命中同格位不再发通知（不刷屏）", r2.notified.length === 0, "二次 notified=" + r2.notified.length);
}

// ================= C. 真实全库回归（误报前提）=================
console.log("\n--- C 生产快照回归（必须 0 误报）---");
try {
  const real = JSON.parse(fs.readFileSync(path.join(HERE, "data", "db.json"), "utf8"));
  const db = JSON.parse(JSON.stringify(real));
  const r = runInvariant(db, { invariantAlertOn: 1, outConsumeLedger: Number((real.params || {}).outConsumeLedger ?? 1) });
  C("★真实全库 locClash=0（44处多码同格全是合法同托，无一误报）", db.lastInvariantCheck.locClash === 0, "命中=" + db.lastInvariantCheck.locClash);
  C("★真实全库 ghost=0（现网无幽灵框，或已消账）", db.lastInvariantCheck.ghost === 0, "命中=" + db.lastInvariantCheck.ghost);
  C("★真实全库首次【不发任何点名通知】（上线第一天不刷屏）", r.notified.length === 0, "通知=" + r.notified.length);
  C("无异常逃逸（全库数据无脏值炸哨兵）", r.errs.length === 0, r.errs.join(";"));
} catch (e) { C("读生产快照", false, e.message); }

// ================= B. 真实实例验哨兵会跑（改用并发夹具，消除端口残留 flaky）=================
// ★ 本段原先手抄 cp.spawn + srv.kill()（只杀直接子进程、不杀孙进程）+ 硬编码端口 + 固定 tdir，
//   连跑或经 runner 跑时上一次的 server 孙进程残留占端口 → 本次 server EADDRINUSE 崩，但
//   /api/health 被残留的旧 server 应答（旧库也含 fixture 所以 locClash/ghost 假过），而测试读的是
//   本次那个从没被写过的 tdir/db.json → 通知=0（实测连跑 3 次第 3 次挂）。
//   夹具 startInstance 带 killTree（杀整棵进程树）+ 唯一端口 + 就绪失败即 throw，正是解药。
//   —— 这个测试写于夹具之前，按"新功能必须过夹具"迁它自己。
console.log("\n--- B 真实实例（哨兵会跑/会落health/会发通知）· 经夹具 ---");
const kit = require('./test_conc_kit_v172.js');
const PORT = Number(process.env.INV_PORT || 8419); // 独立默认端口，env 可覆盖避免与其它套件/残留撞车
(async () => {
  let h = null;
  try {
    h = await kit.startInstance({
      port: PORT, tag: 'invb' + process.pid, upTries: 60,
      users: [{ username: 'inv_wh', role: 'warehouse', password: 'Kit#Pass1' }],
      params: { invariantAlertOn: 1, outConsumeLedger: 1 },
      mutate: (dbC) => { // 起实例前注入撞位 + 幽灵框（夹具钩子，免"改库→stop→重启"）
        // ★必须清掉生产库副本里的 lastInvariantCheck：它是【生产服务器上一轮自检】的结果
        //   （locClash/ghost 都是生产的真实计数，与本实例注入的数据无关）。不清则本测试
        //   轮询 health.invariant 会先读到这份旧快照——旧值 ageSec 恰 <120 时立刻 break，
        //   读到 locClash=0/ghost=0（生产计数）→ 判"哨兵没检出"，表现为随机失败
        //   （随生产自检 5 分钟周期与测试启动时刻的相位而时好时坏，11-13 实测同端口时挂时过）。
        delete dbC.lastInvariantCheck;
        dbC.invariantAlert = {}; // 同理：生产的通知去重集会让本实例预置的撞位被判"7天内已报过"而不发通知
        dbC.ledger = dbC.ledger || [];
        dbC.ledger.push({ c: "INVGHO0001", l: "NB02-A-88-1F", q: 10, pid: "INVPA", p: "66TEST", t: Date.now() - 864000000 });
        dbC.ledger.push({ c: "INVCL10001", l: "NB02-A-87-1F", q: 5, pid: "INVPX", p: "66TEST", t: Date.now() - 864000000 });
        dbC.ledger.push({ c: "INVCL10002", l: "NB02-A-87-1F", q: 5, pid: "INVPY", p: "66TEST", t: Date.now() - 864000000 }); // 撞位：同格两托
        dbC.scanlog = dbC.scanlog || {}; dbC.seenOut = dbC.seenOut || {};
        dbC.scanlog["INVGHO0001|B1|1"] = { code: "INVGHO0001", t: Date.now() - 800000000, cx: false, gl: "NB02-A-88-1F" };
        dbC.seenOut["INVGHO0001"] = { at: Date.now() - 100000, no: "INVDT9" }; // 幽灵：出库晚于最后入库
      },
    });
    const tdir = h.tdir, dbFile = path.join(tdir, "db.json");
    // 等哨兵首跑（夹具内已等就绪；这里再轮询 health.invariant 出现且年龄 <120 秒）
    let inv = null;
    for (let i = 0; i < 45; i++) { await kit.sleep(1000); const r = await h.req('GET', '/api/health'); if (r.json && r.json.invariant && r.json.invariant.ageSec < 120) { inv = r.json.invariant; break; } }
    C("★真实实例 health.invariant 出现（哨兵在岗可观测）", !!inv, JSON.stringify(inv));
    C("★★哨兵真检出预置撞位 locClash>=1", inv && inv.locClash >= 1, "locClash=" + (inv && inv.locClash));
    C("★★哨兵真检出预置幽灵 ghost>=1", inv && inv.ghost >= 1, "ghost=" + (inv && inv.ghost));
    // 读落盘副本库看通知真的写进 db.notifications（轮询等 save 防抖落盘）
    let nn = [];
    for (let i = 0; i < 20; i++) { try { const d = JSON.parse(fs.readFileSync(dbFile, "utf8")); nn = (d.notifications || []).filter((n) => /ghost_out/.test(n.type) && /自检/.test(n.text)); if (nn.length >= 1) break; } catch (_) {} await kit.sleep(500); }
    C("★★通知真的落库（ghost_out 自检类 ≥1 条）", nn.length >= 1, "自检通知=" + nn.length + " 条");
    C("★撞位与幽灵两类都点名（各含对应标签）", nn.some((n) => /INVCL/.test(n.text)) && nn.some((n) => /INVGHO0001/.test(n.text)));
    C("★哨兵未误伤生产库（写只发生在夹具副本）", fs.statSync(path.join(HERE, "data", "db.json")).size < 9e7, "生产库未被自检写入");
  } catch (e) { total++; fail++; console.log("❌ 实例测试异常：" + e.message); }
  finally { if (h) { try { await h.stop(); } catch (_) {} } }
  console.log("\n结果: " + (total - fail) + " 通过 / " + fail + " 失败  （隔离副本，生产库零写入）");
  process.exit(fail ? 1 : 0);
})();
