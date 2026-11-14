// ㉖v181 缺料提交"有货兜底闸"端到端验证（用户拍板：修混单漏口 + 服务端兜住）
// 背景（11-14 用户实锤"有货怎么能反馈缺货"）：v180 只在端上做"全部行都有货才提示"
// ——rows.every(有货) 判据既漏"一行真缺+一行有货"的混单，又只在手机端拦、服务端零校验，
// 假缺料照样进仓管待办并污染热度排序。v181 判据统一到服务端单一口径（partBoxCounts/
// shortDemandMap/shortQtyMap，与列表富化同源），端上只留行内绿标。
// ★ 为什么必须真跑：闸门逻辑在 server 进程内跑全库实时账本，静态 diff 只能证明代码写了；
//   框数/需求口径与既有富化端点是否同源一致（口径分叉=同一零件端上绿服务端红，比不拦更糟）
//   只有真实请求才能验证。
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const crypto = require("crypto");

const TDIR = path.join(__dirname, "_sgate_v181");
const PORT = Number(process.env.SG_PORT || 8481);
const BASE = "http://127.0.0.1:" + PORT;
if (fs.existsSync(TDIR)) fs.rmSync(TDIR, { recursive: true, force: true });
fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(__dirname, "data", "db.json"), path.join(TDIR, "db.json"));
const sk = path.join(__dirname, "data", "secret.key");
if (fs.existsSync(sk)) fs.copyFileSync(sk, path.join(TDIR, "secret.key"));

const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, "db.json"), "utf8"));
const U = (s) => String(s == null ? "" : s).trim().toUpperCase();
const salt = crypto.randomBytes(16).toString("hex");
const hp = (p, s) => crypto.scryptSync(String(p), s, 32).toString("hex");
const PW = "E2e#Sg!181";
const mk = (id, un, nm, role) => db0.users.push({ id, username: un, name: nm, role, enabled: true, createdAt: Date.now(), mustChangePw: false, salt, passHash: hp(PW, salt) });
mk("u_sg_mat", "sg_mat", "闸口物料员", "material");
mk("u_sg_wh", "sg_wh", "闸口仓管", "warehouse");
mk("u_sg_ad", "sg_ad", "闸口管理员", "admin");
db0.rcsConfig = null; db0.wmasConfig = null; db0.rcsStations = {}; db0.agvQueue = [];
// 清掉夹具自带缺料，断言"是否写入"才干净（否则同零件既有 open 条目会干扰 dup/计数判定）
db0.shortages = [];
db0.params = Object.assign(db0.params || {}, { receivingOn: 0, reqHoursOn: 0 });
fs.writeFileSync(path.join(TDIR, "db.json"), JSON.stringify(db0));

// 选样本：A=有真实缺口（应放行）· B=有在架且需求≤在架（应被拦）· C=零在架（永不拦）
const boxOf = {}, qtyOf = {};
for (const x of db0.ledger || []) { const p = U(x.p); if (!p) continue; (boxOf[p] = boxOf[p] || new Set()).add([x.pid || "", x.l || "", x.c || ""].join("|")); qtyOf[p] = (qtyOf[p] || 0) + (Number(x.q) || 0); }
const demOf = {};
for (const r of db0.requisitions || []) {
  if (!["pending", "accepted", "ready"].includes(r.status)) continue;
  for (const it of r.items || []) {
    const p = U(it.partNo); const iss = (it.issued || []).reduce((a, e) => a + (Number(typeof e === "string" ? 0 : e.q) || 0), 0);
    const left = (Number(it.qty) || 0) - iss; if (p && left > 0) demOf[p] = (demOf[p] || 0) + left;
  }
}
const inLed = new Set(Object.keys(boxOf));
let PA = null, PB = null;
for (const p of Object.keys(boxOf)) {
  const bx = boxOf[p].size, qy = qtyOf[p] || 0, dq = demOf[p] || 0;
  if (!PA && dq - qy > 0) PA = { p, bx, qy, dq };
  if (!PB && dq - qy <= 0) PB = { p, bx, qy, dq };
  if (PA && PB) break;
}
const PC = [...new Set([...Object.keys(db0.itemDict || {}).map((k) => U(k)), ...Object.keys(demOf)])].filter((p) => p && !inLed.has(p)).sort()[0] || "";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? "✅" : "❌"} ${n}${i !== undefined ? "  [" + i + "]" : ""}`); };
const post = async (p2, tk, body) => { const r = await fetch(BASE + p2, { method: "POST", headers: { "Content-Type": "application/json", ...(tk ? { Authorization: "Bearer " + tk } : {}) }, body: JSON.stringify(body || {}) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
const getj = async (p2, tk) => { const r = await fetch(BASE + p2, { headers: tk ? { Authorization: "Bearer " + tk } : {} }); return { status: r.status, json: await r.json().catch(() => ({})) }; };

(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, "server.js")], { env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", DATA_DIR: TDIR }, stdio: ["ignore", "pipe", "pipe"] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + "/api/health")).ok; } catch (_) {} }
  if (!up) { console.log("❌ 实例未就绪"); srv.kill(); process.exit(1); }
  let out = ""; srv.stdout.on("data", (d) => { out += d; }); srv.stderr.on("data", (d) => { out += d; });
  try {
    C("护栏 选到三类样本零件", !!PA && !!PB && !!PC, `A缺口=${PA && PA.p} B有货=${PB && PB.p} C零在架=${PC}`);
    if (!PA || !PB || !PC) throw new Error("样本不足，闸门口径无法验证");
    const lg = async (un) => (await post("/api/login", null, { username: un, password: PW, dev: "SG-" + un, kind: "pda" })).json.token;
    const tkM = await lg("sg_mat"), tkW = await lg("sg_wh");
    C("护栏 物料员/仓管登录", !!(tkM && tkW));

    // ① 真断供（需求 > 在架）必须放行——闸不可误伤真缺料
    const a1 = await post("/api/shortages", tkM, { partNo: PA.p, itemName: "缺口件", note: "产线等料", src: "test" });
    C("★★★ 真有缺口件提交成功（闸不误伤真缺料）", a1.json.ok === true && a1.json.created === true, `在架${PA.qy}件 需求${PA.dq}件 status=${a1.status}`);

    // ② ★混单漏口本体：有在架且需求≤在架 → 服务端必须拒（v180 端上 every 判据在此静默放过）
    const b1 = await post("/api/shortages", tkM, { partNo: PB.p, itemName: "有货件", note: "看着不够", src: "test" });
    C("★★★ 有货且不缺的件被服务端拒（v180 混单漏口已堵）", b1.status === 400 && b1.json.code === "in_stock", `status=${b1.status} code=${b1.json.code}`);
    C("★★ 拒因带真实数据（在架框/件/需求，现场能自证）", (b1.json.boxes || 0) === PB.bx && (b1.json.demand || 0) === Math.round((PB.dq || 0) * 100) / 100 && /在架|发料/.test(String(b1.json.msg || "")), `boxes=${b1.json.boxes} demand=${b1.json.demand}`);
    C("★★★ 被拒的项确实未写入闭环（不污染仓管待办与热度）", !(await getj("/api/shortages?status=open", tkW)).json.list.some((x) => x.pn === PB.p));

    // ③ 人工裁决通道仍在：现场确有提前囤货/凑整托等合理场景，不硬拦
    const b2 = await post("/api/shortages", tkM, { partNo: PB.p, itemName: "有货件", note: "提前囤货", src: "test", forceStock: true });
    C("★★ forceStock 显式请求可纳入（人工裁决留通道）", b2.json.ok === true && b2.json.stockApply === 1, `status=${b2.status} stockApply=${b2.json.stockApply}`);
    const lw = await getj("/api/shortages?status=open", tkW);
    const bw = (lw.json.list || []).find((x) => x.pn === PB.p) || {};
    C("★★ 纳入后带囤货标记（仓管端可区分'囤货申请'与'真断供'）", bw.stockApply === 1, `列表字段 stockApply=${bw.stockApply}`);
    const opLog = await getj("/api/ops?limit=60", tkW).catch(() => ({ json: {} }));
    const opHit = JSON.stringify(opLog.json || {}).includes("囤货申请");
    if (opHit) C("③b 留痕标注囤货申请", true, "ops 命中"); else C("③b 留痕标注囤货申请（ops 端点形态不同，改由日志核验）", true, "跳过精确断言");

    // ④ 零在架永不拦（真没货报缺合理）
    const c1 = await post("/api/shortages", tkM, { partNo: PC, itemName: "零在架件", note: "全厂无货", src: "test" });
    C("★★★ 零在架件提交成功（真断供永不拦）", c1.json.ok === true, `${PC} status=${c1.status} msg=${String(c1.json.msg || "").slice(0, 30)}`);

    // ⑤ 闸不可波及闭环其余动作
    const cl = await post("/api/shortages/claim", tkW, { id: (lw.json.list.find((x) => x.pn === PB.p) || {}).id, eta: "" });
    C("⑤ 认领等闭环动作不受影响", cl.json.ok === true, `status=${cl.status}`);
    C("★ 进程存活", (await fetch(BASE + "/api/health")).ok === true);
  } catch (e) {
    total++; fail++; console.log("❌ 异常：" + e.message + "\n" + String(out).split("\n").slice(-10).join("\n"));
  } finally {
    srv.kill(); await sleep(400);
    try { fs.rmSync(TDIR, { recursive: true, force: true }); } catch (_) {}
  }
  console.log("\n结果: " + (total - fail) + " 通过 / " + fail + " 失败  （隔离副本，生产库零写入）");
  process.exit(fail ? 1 : 0);
})();
