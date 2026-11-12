// ㉖v167 重复入库源头防重测试（11-12 现场 N26K120114 实锤回归）
// 事故：同一框 14:41 扫入(粗码未上账)→14:47 补格位入账→14:49 新开批次重扫→14:50 点「强制继续」原因只填「1」
//       → 放行 → 同框两条有效流水、件数翻倍。真因不是"系统没拦"，是【拦了但出口无门槛、放行后旧记录不作废】。
// 本测试直接抽 server.js 的【真实函数源码】与【真实合并钩子代码块】在 vm 沙箱执行，不复制实现、不改写逻辑。
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "server.js"), "utf8").replace(/\r\n/g, "\n");
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log("  PASS  " + name + (extra ? "  ｜ " + extra : "")); }
  else { fail++; console.log("  FAIL  " + name + (extra ? "  ｜ " + extra : "")); }
};

// —— 抽取顶层真实函数（与 v163/v166 测试同一手法）——
function topFn(name) {
  const i = SRC.indexOf("function " + name + "(");
  if (i < 0) throw new Error("server.js 找不到函数 " + name);
  for (let j = i; j < SRC.length; j++) {
    if (SRC.slice(j, j + 2) === "\n}" && (j + 2 >= SRC.length || SRC[j + 2] === "\n")) return SRC.slice(i, j + 2);
  }
  throw new Error("函数未闭合 " + name);
}
// —— 抽取 /api/ledger/merge 内的【真实取代兑现代码块】（连文本一起跑，防止测试与实现漂移）——
function mergeHook() {
  const a = SRC.indexOf("// ㉖v167 兑现「取代」");
  if (a < 0) throw new Error("merge 里找不到 v167 取代钩子");
  const b = SRC.indexOf("save();", a);
  if (b < 0) throw new Error("取代钩子后找不到 save()");
  return SRC.slice(a, b);
}
const TTL = Number((SRC.match(/const SUPERSEDE_TTL_MS = (\d+)/) || [0, 1200000])[1]);

function mkCtx(dbObj, forceMinLen) {
  const ctx = vm.createContext({
    db: dbObj,
    P: () => ({ forceWhyMinLen: forceMinLen === undefined ? 6 : forceMinLen }),
    SUPERSEDE_TTL_MS: TTL,
    Date, Math, Object, Array, String, Number, Set, Map, RegExp, Infinity, JSON, isNaN, parseInt,
    console: { log: () => {} },
    pushOps: (u, act, obj, det) => { (ctx.__ops = ctx.__ops || []).push({ act, obj, det }); },
    u: { name: "测试员" },
  });
  for (const f of ["forceWhyBad", "pruneSupersede", "settleSupersede"]) vm.runInContext(topFn(f), ctx);
  // 在 vm 上下文内执行真实钩子代码块：db/u/console/pushOps/pruneSupersede/settleSupersede
  // 全部走上下文里的真实绑定（与 server 运行时同一组名字），只把本次写入集与时刻当变量注入
  ctx.__mergeHook = function (dbArg, uArg, wrote, rec0) {
    ctx.db = dbArg; ctx.u = uArg; ctx._wroteCodes = wrote; ctx.rec0 = rec0;
    return vm.runInContext("(function () {\n" + mergeHook() + "\n return _supDone;\n})()", ctx);
  };
  return ctx;
}
const flow = (code, batch, t, loc, q) => ({ code, batch, t, cx: false, q: q || 30, gl: loc, op: "刘向轩" });

console.log("\n=== A 组｜强过原因门槛（复刻现场填「1」被放行）===");
{
  const c = mkCtx({ supersede: {}, scanlog: {} });
  ok("A1 现场原文「1」被拒", c.forceWhyBad("1") !== "", c.forceWhyBad("1").slice(0, 18));
  ok("A2 长串纯数字「1111111」被拒（绕长度）", c.forceWhyBad("1111111").includes("不能只填数字"));
  ok("A3 纯符号「。。。。。。」被拒", c.forceWhyBad("。。。。。。").includes("不能只填数字"));
  ok("A4 空格串「       」被拒", c.forceWhyBad("       ").length > 0);
  ok("A5 历史真实原因「测试」被拒", c.forceWhyBad("测试") !== "");
  ok("A6 正常纠正原因放行", c.forceWhyBad("位置录错，实物实际在H-09-05格位") === "");
  ok("A7 退料复用原因放行", c.forceWhyBad("生产退料重新上架，标签确实复用") === "");
  const c0 = mkCtx({ supersede: {}, scanlog: {} }, 0);
  ok("A8 参数=0 回退旧行为（不拦）", c0.forceWhyBad("1") === "");
}

console.log("\n=== B 组｜取代兑现（真实 merge 钩子）===");
{
  const T = Date.now();
  const kOld = "N26K120114|B2026-11-12-1441|" + (T - 600000);
  const kNew = "N26K120114|B2026-11-12-1449|" + T;
  const db = {
    scanlog: { [kOld]: flow("N26K120114", "B2026-11-12-1441", T - 600000, "NB03-H-09-04"), [kNew]: flow("N26K120114", "B2026-11-12-1449", T, "NB03-H-09-05") },
    ledger: [{ c: "N26K120114", l: "NB03-H-09-05", q: 30 }],
    supersede: {},
  };
  const c = mkCtx(db);
  // 复刻现场：先强过（登记快照=当时已存在的有效流水），再推账本
  const snapKeys = Object.keys(db.scanlog).filter((k) => !db.scanlog[k].cx && db.scanlog[k].code === "N26K120114" && k !== kNew);
  db.supersede["N26K120114"] = { at: T, by: "刘向轩", why: "位置录错，实物在H-09-05", keys: snapKeys };
  const done = c.__mergeHook(db, c.u, new Set(["N26K120114"]), T);
  ok("B1 新记录入账后，旧流水自动作废", db.scanlog[kOld].cx === true);
  ok("B2 本次新流水保持有效（关键）", db.scanlog[kNew].cx === false);
  ok("B3 账本行未被删除（绝不误消账）", db.ledger.length === 1 && db.ledger[0].l === "NB03-H-09-05");
  ok("B4 作废留痕写明原因与后果", (c.__ops[0] || {}).act === "重复入库取代" && String((c.__ops[0] || {}).det).includes("位置录错"));
  ok("B5 凭证已消费", db.supersede["N26K120114"] === undefined);
  const done2 = c.__mergeHook(db, c.u, new Set(["N26K120114"]), T + 1);
  ok("B6 幂等：再推一次不会重复作废", (done2 || []).length === 0 && c.__ops.length === 1);
}

console.log("\n=== C 组｜安全边界（不能误伤）===");
{
  // C1 新流水设备时钟早于旧流水（时钟偏差）：靠快照隔离，仍不得作废新记录
  const T = Date.now();
  const kOld = "C1|B1|99999999999999", kNew = "C1|B2|1"; // 故意让新记录 t 更小
  const db = { scanlog: { [kOld]: flow("C1", "B1", T - 9000, "NB03-A-01-01"), [kNew]: flow("C1", "B2", 1, "NB03-A-01-02") }, ledger: [], supersede: { C1: { at: T, keys: [kOld] } } };
  const c = mkCtx(db);
  c.__mergeHook(db, c.u, new Set(["C1"]), T);
  ok("C1 设备时钟偏差下，新流水仍不被作废（快照隔离，不比时刻）", db.scanlog[kNew].cx === false && db.scanlog[kOld].cx === true);

  // C2 强过后没保存（凭证挂着）→ 到期清除，旧流水原样保留
  const db2 = { scanlog: { K1: flow("C2", "B1", T - 60000, "NB03-A-02-01") }, ledger: [], supersede: { C2: { at: T - TTL - 1000, keys: ["K1"] } } };
  const c2 = mkCtx(db2);
  ok("C2 过期凭证被清除", c2.pruneSupersede(T) === 1 && Object.keys(db2.supersede).length === 0);
  ok("C3 过期不兑现，旧流水未被误作废", db2.scanlog.K1.cx === false);

  // C4 过期但未 prune，直接 settle 也不得兑现
  const db3 = { scanlog: { K1: flow("C3", "B1", T - 60000, "NB03-A-03-01") }, ledger: [], supersede: { C3: { at: T - TTL - 1000, keys: ["K1"] } } };
  const c3 = mkCtx(db3);
  ok("C4 过期凭证 settle 返回空且不作废", c3.settleSupersede("C3", "x") === null && db3.scanlog.K1.cx === false);

  // C5 本次被格式闸拒收（不进 _wroteCodes）→ 旧流水保持有效、凭证留待过期
  const db4 = { scanlog: { K1: flow("C4", "B1", T - 60000, "H9") }, ledger: [], supersede: { C4: { at: T, keys: ["K1"] } } };
  const c4 = mkCtx(db4);
  const r4 = c4.__mergeHook(db4, c.u, new Set(), T); // 账本本次一行都没写
  ok("C5 未入账则不取代（旧流水仍是唯一事实）", (r4 || []).length === 0 && db4.scanlog.K1.cx === false && !!db4.supersede.C4);

  // C6 同托多码：凭证只作废登记过的键，别码不受牵连
  const db5 = {
    scanlog: { A: flow("C5", "B1", T, "NB03-A-05-01"), B: flow("C5-SIB", "B1", T, "NB03-A-05-01") },
    ledger: [], supersede: { C5: { at: T, keys: ["A"] } },
  };
  const c5 = mkCtx(db5);
  c5.__mergeHook(db5, c.u, new Set(["C5"]), T);
  ok("C6 同托兄弟码流水不被连坐", db5.scanlog.A.cx === true && db5.scanlog.B.cx === false);

  // C7 已作废的旧键再兑现也不报错
  const db6 = { scanlog: { A: Object.assign(flow("C6", "B1", T, "NB03-A-06-01"), { cx: true }) }, ledger: [], supersede: { C6: { at: T, keys: ["A"] } } };
  const c6 = mkCtx(db6);
  const r6 = c6.__mergeHook(db6, c.u, new Set(["C6"]), T);
  ok("C7 键已作废时静默跳过，不报错", (r6 || []).length === 0);
}

console.log("\n=== D 组｜真实数据：重启后不会突然作废任何流水 ===");
{
  const real = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "db.json"), "utf8"));
  const db = { scanlog: real.scanlog, ledger: real.ledger, supersede: {} }; // 旧库无 supersede → 初始化为空
  const c = mkCtx(db);
  ok("D1 空凭证时 prune/settle 均无副作用", c.pruneSupersede(Date.now()) === 0 && c.settleSupersede("N26K120114", "x") === null);
  const beforeLive = Object.values(db.scanlog).filter((x) => !x.cx).length;
  c.__mergeHook(db, c.u, new Set(Object.keys(db.scanlog).slice(0, 200).map((k) => db.scanlog[k].code)), Date.now());
  const afterLive = Object.values(db.scanlog).filter((x) => !x.cx).length;
  ok("D2 对全库真实流水跑取代钩子：有效流水条数不变（不追溯历史）", beforeLive === afterLive, beforeLive + " → " + afterLive);
  const ledBefore = (real.ledger || []).length;
  ok("D3 账本行数不变", db.ledger.length === ledBefore, ledBefore + " 行");
}

console.log("\n=== E 组｜静态接线（防止改了函数忘了调用）===");
{
  ok("E1 强过接口调用原因门槛", /_bad = forceWhyBad\(_why\)/.test(SRC));
  ok("E2 强过接口登记取代凭证", /\(db\.supersede = db\.supersede \|\| \{\}\)\[fc\]/.test(SRC));
  ok("E3 门槛不合格返回 400 不放行", /return send\(res, 400, \{ ok: false, msg: _bad \}\)/.test(SRC));
  ok("E4 merge 收集本次写入标签", /_wroteCodes\.add\(key\)/.test(SRC));
  ok("E5 sync 顺带清理过期凭证", /pruneSupersede\(Date\.now\(\)\)/.test(SRC));
  ok("E6 门槛参数已进参数表（可调）", /forceWhyMinLen:\s*\{/.test(SRC));
  // E7 抽【函数体自身】检查（旧写法用 {0,600} 窗口会跨过函数边界，命中 /api/scanlog/cancel 里
  // 原有的 db.ledger = [...cur.values()] 而误报）——取代只改流水 cx，绝不重建/删除账本数组
  let _sdBody = "";
  { const si = SRC.indexOf("function settleSupersede("); let d = 0, e = -1;
    for (let j = SRC.indexOf("{", si); j < SRC.length; j++) { if (SRC[j] === "{") d++; else if (SRC[j] === "}") { d--; if (d === 0) { e = j + 1; break; } } }
    _sdBody = SRC.slice(si, e); }
  ok("E7a settleSupersede 函数体内不重建账本数组", !/db\.ledger\s*=/.test(_sdBody));
  ok("E7b settleSupersede 函数体内不删账本行/不写墓碑", !/ledgerTomb|cur\.delete|\.splice\(/.test(_sdBody));
  ok("E7c 取代只写流水 cx 标记（确有该动作）", /rec0\.cx = true/.test(_sdBody));
  const dart = fs.readFileSync(path.join(__dirname, "..", "lib", "main.dart"), "utf8");
  ok("E8 PDA 不再吞掉服务端拒绝", !/await AuthApi\.labelForce\(code, why\);\s*\}\s*catch/.test(dart) && /fr\["ok"\] != true/.test(dart));
  ok("E9 PDA 服务端不可达时不放行", /无法登记取代/.test(dart));
}

console.log("\n结果：PASS " + pass + " / FAIL " + fail + (fail ? "  ⚠️ 有失败项" : "  ✅ 全绿"));
process.exit(fail ? 1 : 0);
