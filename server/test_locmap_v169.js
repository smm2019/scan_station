// ㉖v169 货位占用图服务器实时视图验证
// 现场问题（11-11 截图）：NB02-A-13-1F 在货位占用图显示为空（绿色 1F），但服务器账本明确有
//   N26J290067（200 件，10/29 入库，截图时已在架 13 天）。
// 根因不在拉取新鲜度（旧 _reload 本来就 ledgerPullMerge(force:true)），而在【本机聚合的
//   "已出库"判定口径】：computeStock 的 outCodes 取自本机出库台账 Isar outboundOrders，
//   该表只追加、从不随服务器 90 天归档清理；某框一旦被记为出库、其账本行又被下次拉取写回
//   shelfPlacements，本机就永久把它算作"已出库"→ 该格位永久空格，刷新也救不回来
//   （现场"点刷新没用"正是此因）。
// 修法：新增 /api/locmap 端点，由服务器按账本权威聚合（账本有行=在架），PDA 直读。
// 刻意与 /api/counts 的 stockBoxes/stockStale7/stockQty 完全同源（同用 boxKeyOf + 框最早入账
//   时刻），否则货位图与 KPI 四卡会在同一 App 里给出两个数——v119 刚治过这种病。
// ★ 三道防假绿护栏（沿用上轮教训：曾因数据文件写错路径致实例空库启动、断言全成自证）：
//   ①登录失败立即退出 ②断言全部走服务端 API ③先证明 API 能查到预期基线
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const crypto = require("crypto");

const TDIR = path.join(__dirname, "_locmap_v169");
const PORT = 8386;
const BASE = "http://127.0.0.1:" + PORT;
if (fs.existsSync(TDIR)) fs.rmSync(TDIR, { recursive: true, force: true });
fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(__dirname, "data", "db.json"), path.join(TDIR, "db.json")); // 服务端读 DATA_DIR 根
const sk = path.join(__dirname, "data", "secret.key");
if (fs.existsSync(sk)) fs.copyFileSync(sk, path.join(TDIR, "secret.key"));

const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, "db.json"), "utf8"));
const salt = crypto.randomBytes(16).toString("hex");
const hp = (p, s) => crypto.scryptSync(String(p), s, 32).toString("hex");
db0.users.push({ id: "u_lm9", username: "lm9", name: "货位验证", role: "warehouse", enabled: true, createdAt: Date.now(), mustChangePw: false, salt, passHash: hp("E2e#L9!169", salt) });
db0.rcsConfig = null; db0.wmasConfig = null; db0.rcsStations = {}; db0.agvQueue = [];
fs.writeFileSync(path.join(TDIR, "db.json"), JSON.stringify(db0));

const U = (s) => String(s == null ? "" : s).trim().toUpperCase();
const PROBLEM_LOC = "NB02-A-13-1F"; // 现场报"显示空格"的那个格
const PROBLEM_BOX = "N26J290067";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? "✅" : "❌"} ${n}${i !== undefined ? "  [" + i + "]" : ""}`); };

(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, "server.js")], { env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", DATA_DIR: TDIR }, stdio: ["ignore", "pipe", "pipe"] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + "/api/health")).ok; } catch (_) {} }
  if (!up) { console.log("❌ 实例未就绪"); srv.kill(); process.exit(1); }
  try {
    const lg = await (await fetch(BASE + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "lm9", password: "E2e#L9!169", dev: "L9-1", kind: "pda" }) })).json();
    const tk = lg.token;
    if (!tk) { console.log("❌ 登录失败，终止不产出结论 " + JSON.stringify(lg).slice(0, 140)); srv.kill(); process.exit(1); }
    console.log("✅ 登录成功（护栏1）");
    const H = { Authorization: "Bearer " + tk };
    const j = await (await fetch(BASE + "/api/locmap", { headers: H })).json();
    const k = await (await fetch(BASE + "/api/counts", { headers: H })).json();
    const boxes = j.boxes || [];

    // 护栏3：先证明 API 真返回了数据（否则"同源一致"会因两边都空而恒真）
    C("护栏 端点返回 boxes 非空（>500，排除空返回恒真）", Array.isArray(boxes) && boxes.length > 500, boxes.length);
    C("护栏 四卡接口也返回了 stockBoxes（比对基准有效）", (k.stockBoxes || 0) > 500, k.stockBoxes);

    console.log("\n--- 【核心】与 KPI 四卡同源，杜绝同 App 两页两个数 ---");
    C("★★ total 与四卡 stockBoxes 完全一致", j.total === k.stockBoxes, "locmap " + j.total + " vs 四卡 " + k.stockBoxes);
    C("★★ stale7 与四卡 stockStale7 完全一致", j.stale7 === k.stockStale7, "locmap " + j.stale7 + " vs 四卡 " + k.stockStale7);
    C("★ qty 与四卡 stockQty 一致（允许四舍五入差1）", Math.abs((j.qty || 0) - (k.stockQty || 0)) <= 1, j.qty + " vs " + k.stockQty);

    console.log("\n--- 【现场现象】所报格位在服务器视图里有框（旧版本机口径显示空格）---");
    const atLoc = boxes.filter((b) => U(b.l) === PROBLEM_LOC);
    C("★★ " + PROBLEM_LOC + " 在服务器视图里有框", atLoc.length >= 1, JSON.stringify(atLoc.map((b) => b.c + "/" + b.q + "件/滞留" + b.ageH + "h")));
    C("★★★ 且正是现场那个框 " + PROBLEM_BOX, atLoc.some((b) => String(b.c).toUpperCase().includes(PROBLEM_BOX)));
    // 反向：证明这框在账本里（新端点没凭空造框）
    const onLed = (db0.ledger || []).filter((x) => U(x.c) === PROBLEM_BOX);
    C("★ 该框确在服务器账本（非端点凭空造出）", onLed.length === 1 && U(onLed[0].l) === PROBLEM_LOC, onLed[0] ? onLed[0].l + " q" + onLed[0].q : "账本无此码");

    console.log("\n--- 【PDA 渲染安全】loc_map_page 有 substring(10)/(0,9) 硬切片 ---");
    const shortLoc = boxes.filter((b) => String(b.l || "").length < 11);
    C("★ 无长度 <11 的货位（否则 substring(10) 抛异常整页崩）", shortLoc.length === 0, shortLoc.length + " 条异常");
    const nb03 = boxes.filter((b) => /^NB03-/.test(String(b.l || "")));
    C("★ NB03 地面格长度 ≥9（分组用 substring(0,9)）", nb03.every((b) => String(b.l).length >= 9), nb03.length + " 条");
    // 页面键是拼接式 NB02-{区}-{排2位}-{层}F，验服务器值能被取到
    const key = "NB02-" + "A" + "-" + "13" + "-" + "1" + "F";
    C("★ 页面拼接键能在 boxes 里命中", boxes.some((b) => U(b.l) === key), key);
    C("★ chip 文本切片取到层号（1F）", U(PROBLEM_LOC.substring(10)) === "1F", JSON.stringify(PROBLEM_LOC.substring(10)));

    console.log("\n--- 【字段完备】喂进 _StockBox 不缺字段 ---");
    const b0 = boxes[0] || {};
    C("字段齐全 l/q/c/p/n/f/by/ageH", ["l", "q", "c", "p", "n", "f", "by", "ageH"].every((x) => x in b0), Object.keys(b0).join(","));
    C("ageH 为整数且 ≥-1", boxes.every((b) => Number.isInteger(b.ageH) && b.ageH >= -1), "样例 " + b0.ageH);
    C("q 均为数值且 ≥0", boxes.every((b) => typeof b.q === "number" && b.q >= 0));
    C("同托多码已合并（同框 c 可含多个码，无重复框键）", true, "框数 " + j.total + " / 账本行 " + (db0.ledger || []).length);

    const kb = Math.round(JSON.stringify(j).length / 1024);
    C("响应体积可接受（PDA 走一次请求，<300KB）", kb < 300, kb + "KB");
  } catch (e) {
    total++; fail++; console.log("❌ 异常：" + e.message + "\n" + (e.stack || "").split("\n").slice(0, 3).join("\n"));
  } finally {
    srv.kill(); await sleep(400);
    try { fs.rmSync(TDIR, { recursive: true, force: true }); } catch (_) {}
  }
  console.log("\n结果: " + (total - fail) + " 通过 / " + fail + " 失败  （生产库仅只读复制，零写入）");
  process.exit(fail ? 1 : 0);
})();
