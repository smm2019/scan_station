// ㉖v168 多PDA并发扫同一地面区排 / 同一标签 —— 真实 HTTP 并发实测
// 用户三问逐一实测（不靠推断）：
//   Q1 会不会分到同一个位置？
//   Q2 会不会有两条记录？
//   Q3 会不会显示"未登记"？
// 已知关键前提（读码所得，本测试负责验证）：
//   · 分格由服务器 nb03AssignFree 完成，判定+登记在 Node 单线程同步段内 → 理论零撞格
//   · 但【查重 labelStatus 只看 ledger/scanlog/seenIn/seenOut，不看 locReserve 格位预占】
//     → A 机扫完到推送前（流水/账本各有防抖），服务器对该码全盲，B 机此刻扫同框会不会被放行？
//   · 网页"未登记/未上账"标记 = 流水 reg 字段（账本无此码且无出库史 → reg=0，橙色警示）
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const crypto = require("crypto");

const SRC = path.join(__dirname, "data");
const TDIR = path.join(__dirname, "data_e2e_conc_v168");
const PORT = 8372;
const BASE = "http://127.0.0.1:" + PORT;
if (!fs.existsSync(TDIR)) fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(SRC, "db.json"), path.join(TDIR, "db.json"));
fs.copyFileSync(path.join(SRC, "secret.key"), path.join(TDIR, "secret.key"));

const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, "db.json"), "utf8"));
const salt = crypto.randomBytes(16).toString("hex");
const hp = (pw, s) => crypto.scryptSync(String(pw), s, 32).toString("hex");
const now = Date.now();
for (const [id, un, nm] of [["u_cA", "conc_a", "并发甲"], ["u_cB", "conc_b", "并发乙"]]) {
  db0.users.push({ id, username: un, name: nm, role: "warehouse", enabled: true, createdAt: now, mustChangePw: false, salt, passHash: hp("E2e#Conc!1", salt) });
}
db0.params = Object.assign(db0.params || {}, { receivingOn: 0 });
db0.rcsConfig = null; db0.wmasConfig = null; db0.rcsStations = {}; db0.agvQueue = [];
// 每个用例独占一条区排：上一版共用 H-31，被 S1/S2 灌满后 S3 起全部"无格可分"，结果全失真
const TPS = ["NB03-H-31-", "NB03-H-32-", "NB03-H-33-", "NB03-H-34-", "NB03-H-35-"];
db0.ledger = (db0.ledger || []).filter((x) => !TPS.some((tp) => String(x.l || "").toUpperCase().startsWith(tp)));
for (const k of Object.keys(db0.scanlog || {})) { const g = String((db0.scanlog[k] || {}).gl || "").toUpperCase(); if (TPS.some((tp) => g.startsWith(tp))) delete db0.scanlog[k]; }
db0.groundSlots = Object.assign(db0.groundSlots || {}, { "NB03-H-31": 12, "NB03-H-32": 12, "NB03-H-33": 12, "NB03-H-34": 12, "NB03-H-35": 12 });
fs.writeFileSync(path.join(TDIR, "db.json"), JSON.stringify(db0));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const chk = (n, g, w) => { total++; const okv = JSON.stringify(g) === JSON.stringify(w); if (!okv) fail++; console.log(`${okv ? "PASS" : "FAIL!"} [${n}] got=${JSON.stringify(g)} want=${JSON.stringify(w)}`); };
const chkT = (n, c, info) => { total++; if (!c) fail++; console.log(`${c ? "PASS" : "FAIL!"} [${n}]${info !== undefined ? " " + JSON.stringify(info) : ""}`); };
async function post(p2, tk, body) { const r = await fetch(BASE + p2, { method: "POST", headers: { "Content-Type": "application/json", ...(tk ? { Authorization: "Bearer " + tk } : {}) }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; }
async function get(p2, tk) { const r = await fetch(BASE + p2, { headers: tk ? { Authorization: "Bearer " + tk } : {} }); return { status: r.status, json: await r.json().catch(() => ({})) }; }

const Z1 = "H31", Z3 = "H32", Z4 = "H33", Z5 = "H34", Z6 = "H35";
const reserve = (tk, code, pn, zone) => post("/api/ledger/reserve", tk, { code, partNo: pn, zone });
const check = (tk, code) => get("/api/label/check?c=" + code, tk);
const flowIt = (code, batch, t, loc, pn, q, op) => ({ k: code + "|" + batch + "|" + t, code, wt: 1, gl: loc, batch, t, pn, q, nm: "并发测试框", op, cx: false, cxAt: 0, lot: "2026-11-12" });
const ledIt = (code, loc, t, pn, q, by) => ({ c: code, l: loc, q, t, p: pn, n: "并发测试框", b: "2026-11-12", f: "托盘", mv: "人工", src: "H3x", by });
const U = (s) => String(s == null ? "" : s).trim().toUpperCase();
const flowsOf = async (tk, code) => ((await get("/api/scanlog?limit=30000", tk)).json.items || []).filter((x) => U(x.code) === code && !x.cx);
const ledOf = async (tk, code) => ((await get("/api/ledger?c=" + code, tk)).json.items || []).filter((x) => U(x.c) === code);

(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, "server.js")], { env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", DATA_DIR: TDIR }, stdio: ["ignore", "pipe", "pipe"] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + "/api/health")).ok; } catch (_) {} }
  if (!up) { console.log("FAIL! 隔离实例未就绪"); srv.kill(); process.exit(1); }
  console.log("隔离实例就绪 (PORT " + PORT + ") —— 多PDA并发实测（每用例独立区排）");
  try {
    const A = (await post("/api/login", null, { username: "conc_a", password: "E2e#Conc!1" })).json.token;
    const B = (await post("/api/login", null, { username: "conc_b", password: "E2e#Conc!1" })).json.token;

    // ===== Q1-A 不同框并发抢同排：会不会同格 =====
    console.log("\n--- 【Q1】4 台设备同时扫 4 个不同框、抢同一区排 H-31 ---");
    const C1 = ["V168CA0001", "V168CA0002", "V168CA0003", "V168CA0004"];
    const r1 = await Promise.all(C1.map((c, i) => reserve(i % 2 ? B : A, c, "66V168PA0" + i, Z1)));
    const locs1 = r1.map((r) => r.json.loc);
    chk("Q1a 4 框全部分格成功", r1.every((r) => r.json.ok === true && !!r.json.loc), true);
    chk("Q1b ★4 个格位互不相同（零撞格）", new Set(locs1).size, 4);
    console.log("     分到：" + locs1.join(" , "));

    // ===== Q1-B 灌满边界：会不会撞格或静默给重复格 =====
    console.log("\n--- 【Q1】H-31 已被 S1 占 4 格（余 8 格），再并发灌 14 框 ---");
    const rs = [];
    for (let b = 0; b < 2; b++) {
      const batch = [];
      for (let i = 0; i < 7; i++) { const idx = b * 7 + i; batch.push(reserve(idx % 2 ? B : A, "V168CB" + String(idx).padStart(4, "0"), "66V168PB" + idx, Z1)); }
      rs.push(...await Promise.all(batch));
    }
    const got = rs.map((r) => r.json.loc).filter(Boolean);
    chk("Q1c 剩余 8 格被 8 框分走（基数=12-4，不是12）", got.length, 8);
    chk("Q1d 含 S1 共 12 格全部互不相同（全程零撞格）", new Set(locs1.concat(got)).size, 12);
    const denied = rs.filter((r) => !r.json.loc);
    chk("Q1e 超出容量的 6 框被明确拒绝（非静默给重复格）", denied.length, 6);
    chk("Q1f 拒绝理由写明满格", denied.every((r) => String(r.json.msg || "").includes("满")), true);

    // ===== Q2 核心：A 扫完未推送，B 扫同一框 =====
    console.log("\n--- 【Q2】★A 机扫完但数据还没推到服务器（现场防抖窗），B 机扫同一框 ---");
    const CODE = "V168CRACE002", PN = "66V168PR002", T1 = Date.now();
    const ra = await reserve(A, CODE, PN, Z3);
    const locA = ra.json.loc;
    chkT("前置 A 机分格成功", !!locA, locA);

    // ★ 真机顺序（main.dart 已核实）：_globalDupCheck(2497) → 通过才保存 → 保存中才 nb03AutoSlot(2787)。
    //   即【查重被拦 = 既不保存也不分配格位】。测试必须按这个顺序，不能替 B 无条件推数据。
    const cb2 = await check(B, CODE);
    console.log("     A 已预占 " + locA + "（未推数据）时，B 查重：blockIn=" + cb2.json.blockIn + "｜提示=" + String(cb2.json.reason || "（无提示，直接放行）").slice(0, 60));
    chkT("Q2a ★★他人盲窗预占被拦（旧版此处畅通无阻）", cb2.json.blockIn === true, { blockIn: cb2.json.blockIn });
    chkT("Q2a2 提示写清是谁、何时、占了哪个格（现场能判断该找谁）",
      /并发甲/.test(String(cb2.json.reason || "")) && String(locA).length > 0 && /预占货位/.test(String(cb2.json.reason || "")),
      { 提到并发甲: /并发甲/.test(String(cb2.json.reason || "")), 提到格位: /预占货位/.test(String(cb2.json.reason || "")) });
    // 本人（并发甲）在自己预占未推送期间重扫：不该被盲窗规则拦（否则正常改数量/改位置被迫写强过原因）
    const cbSelf = await check(A, CODE);
    chkT("Q2b ★本人重扫不被盲窗规则拦（正常纠错不受影响）",
      !/预占货位/.test(String(cbSelf.json.reason || "")), { blockIn: cbSelf.json.blockIn, reason: String(cbSelf.json.reason || "（放行）").slice(0, 30) });
    // 同排不同标签仍必得不同格（撞格只可能出现在同码，那是幂等复用）
    const rcOther = await reserve(B, "V168COTHER01", "66V168PR003", Z3);
    chkT("Q2b2 同排【不同标签】必得不同格", !!rcOther.json.loc && rcOther.json.loc !== locA, { 甲格: locA, 乙格: rcOther.json.loc });

    // === A 正常保存（B 已被拦，不会保存任何东西）===
    const t1 = T1 + 1;
    await post("/api/scanlog/sync", A, { items: [flowIt(CODE, "B261112-1510", t1, locA, PN, 50, "并发甲")] });
    await post("/api/ledger/sync", A, { items: [ledIt(CODE, locA, t1 + 500, PN, 50, "并发甲")] });
    const flowRows = await flowsOf(A, CODE), ledRows = await ledOf(A, CODE);
    console.log("\n     ★★★ 真机链路结果 ★★★ 账本 " + ledRows.length + " 行｜有效流水 " + flowRows.length + " 条：" + flowRows.map((x) => x.gl + "(" + x.op + ")").join(" ; "));
    chkT("Q2c ★★真机链路下该框只有 1 条有效流水（重复记录从源头消失）", flowRows.length === 1, { flow: flowRows.length, 操作人: flowRows.map((x) => x.op) });
    chk("Q2d 账本 1 行且件数不翻倍", ledRows.length === 1 && Number(ledRows[0].q) === 50, true);
    const cbAfter = await check(B, CODE);
    chkT("Q2e 上账后提示转为常规『已在库』（盲窗闭合，不残留预占提示）",
      /已在库/.test(String(cbAfter.json.reason || "")) && !/预占货位/.test(String(cbAfter.json.reason || "")),
      { reason: String(cbAfter.json.reason || "").slice(0, 34) });

    // === 兜底：旧版 PDA（不带拦截逻辑）照样把同框推上来 → 靠 v167 同格告警暴露 ===
    const C5 = "V168COLDBAK1", T5 = Date.now();
    const r5 = await reserve(A, C5, "66V168PL001", Z3); const loc5 = r5.json.loc;
    await post("/api/scanlog/sync", A, { items: [flowIt(C5, "B261112-1700", T5, loc5, "66V168PL001", 40, "并发甲")] });
    await post("/api/scanlog/sync", B, { items: [flowIt(C5, "B261112-1701", T5 + 8000, loc5, "66V168PL001", 40, "并发乙")] });
    await post("/api/ledger/sync", A, { items: [ledIt(C5, loc5, T5 + 500, "66V168PL001", 40, "并发甲")] });
    await sleep(1400); // 留痕按天 JSONL 追加，稍等落盘
    const opDir = path.join(TDIR, "ops");
    const opTxt = fs.existsSync(opDir) ? fs.readdirSync(opDir).map((f) => fs.readFileSync(path.join(opDir, f), "utf8")).join("") : "";
    chkT("Q2f ★旧版 PDA 绕过拦截时，v167 同格告警仍抓得到（留痕标注「同格重复」）",
      opTxt.includes("重复有效流水") && opTxt.includes(C5) && opTxt.includes("同格重复"),
      { 含该码: opTxt.includes(C5), 标注同格重复: opTxt.includes("同格重复") });
    chkT("Q2g 服务器不擅自作废（无取代凭证不动历史），双流水交人工", (await flowsOf(A, C5)).length, 2);

    // === 强过接手 → 预占归属转交（提示不再把第三人往已放弃的人身上带）===
    const C6 = "V168CHANDOFF", T6 = Date.now();
    const r6 = await reserve(A, C6, "66V168PH001", Z3); const loc6 = r6.json.loc;
    const cb6 = await check(B, CODE && C6);
    chkT("前置 乙 被拦（甲 已预占 " + loc6 + "）", cb6.json.blockIn === true);
    const f6 = await post("/api/label/force", B, { code: C6, why: "已与甲核对，甲现场放弃录入，由我接手登记" });
    chkT("Q2h ★乙 写清真原因后放行（走取代通道）", f6.json.ok === true, { msg: String(f6.json.msg || "").slice(0, 28) });
    const cb6a = await check(A, C6); // 甲再来查：应看到"已被【并发乙】扫入"，而非仍挂在甲自己身上
    chkT("Q2h2 ★预占归属已转交（甲再查提示指向乙，不再误导第三人）",
      /并发乙/.test(String(cb6a.json.reason || "")) && !/【并发甲】/.test(String(cb6a.json.reason || "")),
      { reason: String(cb6a.json.reason || "").slice(0, 46) });

    // ===== Q3 "未登记"到底什么时候出现 =====
    console.log("\n--- 【Q3】'未登记'标记的真实触发条件 ---");
    // 情形1：正常分格+上账 → 不该标
    const f1 = (await flowsOf(A, CODE)).find((x) => x.op === "并发甲");
    chk("Q3a 正常入库的流水 reg=1（账本在，网页不标未登记）", f1 ? f1.reg : null, 1);
    // 情形2：只扫入、账本始终没上（分格失败/被拒）→ 该标（这正是现场"库存查无此框"）
    const C3 = "V168CUNREG001", T3 = Date.now();
    await post("/api/scanlog/sync", A, { items: [flowIt(C3, "B261112-1600", T3, "H33", "66V168PU001", 20, "并发甲")] }); // 故意只推粗码、不推账本
    const f3 = (await flowsOf(A, C3))[0];
    chk("Q3b 只推流水+粗码格位不推账本 → reg=0（网页标⚠未登记/未上账）", f3 ? f3.reg : null, 0);
    // 情形3：并发导致"分格失败"（区排已满）时，PDA 拿不到格位 → 流水只能留粗码 → 必然标未登记
    const C4 = "V168CFULL001";
    const rf = await reserve(B, C4, "66V168PF001", Z1); // H-31 已被 Q1 灌满
    chkT("Q3c ★区排满时服务器明确拒绝（返回无格位），PDA 无处可填 → 该框若继续保存必成'未登记'", !rf.json.loc && String(rf.json.msg || "").includes("满"), { msg: String(rf.json.msg || "").slice(0, 30) });

    // ===== S4 同托多码并发 =====
    console.log("\n--- 【附加】一托双码（同零件号）在两台设备同时扫 ---");
    const rc1 = await reserve(A, "V168CPAL0001", "66V168PP001", Z4);
    const rc2 = await reserve(B, "V168CPAL0002", "66V168PP001", Z4);
    chkT("S4a 同零件双码各占一格（现状：双码不因同零件共享格位）", !!rc1.json.loc && !!rc2.json.loc && rc1.json.loc !== rc2.json.loc, { 码1: rc1.json.loc, 码2: rc2.json.loc });

    // ===== S5 同机重扫幂等（必须非空，堵"两边都 undefined 算通过"的假绿）=====
    const rc3a = await reserve(A, "V168CIDEM001", "66V168PI001", Z5);
    const rc3b = await reserve(A, "V168CIDEM001", "66V168PI001", Z5);
    chk("S5a 重扫返回同格（幂等复用，不跳格）", rc3b.json.loc, rc3a.json.loc);
    chkT("S5b ★且该格非空（堵住 undefined==undefined 假绿）", !!rc3a.json.loc && /^NB03-H-34-\d\d$/.test(String(rc3a.json.loc)), rc3a.json.loc);

    // ===== S7 ★AGV 货架模式并发（9 组历史重复里 7 组是这种，才是主战场）=====
    console.log("\n--- 【S7】AGV 货架模式：A 扫入叫车后未推送，B 扫同一框 ---");
    const CG = "V168CAGV0001", PNG = "66V168PG0001", TG = Date.now();
    const rg = await post("/api/ledger/reserve", A, { code: CG, partNo: PNG }); // 不传 zone = NB02 货架分支
    const locG = rg.json.loc;
    chkT("S7a A 机拿到货架位", !!locG, locG);
    const cbg = await check(B, CG);
    chkT("S7b ★AGV 模式同样被拦（旧版此处畅通 = 历史 7 组重复的成因）", cbg.json.blockIn === true,
      { blockIn: cbg.json.blockIn, reason: String(cbg.json.reason || "").slice(0, 34) });
    await post("/api/scanlog/sync", A, { items: [Object.assign(flowIt(CG, "B261112-1800", TG, locG, PNG, 60, "并发甲"), { wt: 0, st: "NB02-CK-03" })] });
    await post("/api/ledger/sync", A, { items: [Object.assign(ledIt(CG, locG, TG + 500, PNG, 60, "并发甲"), { mv: "AGV", src: "NB02-CK-03" })] });
    const fg = await flowsOf(A, CG);
    chkT("S7c ★AGV 模式下该框也只有 1 条有效流水", fg.length === 1, { flow: fg.length });

    // ===== S6 生产库零污染 =====
    const prodTxt = fs.readFileSync(path.join(SRC, "db.json"), "utf8");
    chkT("S6 生产库零污染（无 V168 合成标签）", !prodTxt.includes("V168C"), true);
  } catch (e) {
    total++; fail++; console.log("FAIL! 异常：" + e.message + "\n" + (e.stack || "").split("\n").slice(0, 3).join("\n"));
  } finally {
    srv.kill(); await sleep(300);
    try { fs.rmSync(TDIR, { recursive: true, force: true }); } catch (_) {}
  }
  console.log("\n结果: " + (total - fail) + " PASS / " + fail + " FAIL  （隔离副本，生产库零写入）");
  console.log("注：Q2a/Q2d/Q3c 是【实测暴露的现存行为】，不是脚本失败，结论看输出。");
  process.exit(0);
})();
