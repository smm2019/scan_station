// ㉖v184 预约"有货闸"端到端验证（用户确认方案：有库存不配预约等新货，可确认后放行）
// 背景：预约的 got 只数【新上账框】，存量不算 → 架上有 4 框的人约 5 框，要等新货凑够 5 才开单，
//   现有库存白放=干等。与 v181 缺料 in_stock 闸同判据（partBoxCounts）、同套路（可确认放行+打标）。
// ★ 为什么必须真跑：闸判据读实时全库账本（partBoxCounts），且要验证"纯提醒型 qty=0 不拦"
//   这条豁免——静态只能证明代码写了，只有真实请求才能证明有货被拦/零货放行/纯提醒放行三种
//   行为同时成立（漏一条就是现场误伤或漏洞）。
// ★ 预约是 material 角色日常动作，闸误伤=物料员没法预约，比缺料闸更需要防误拦。
const { existsSync, rmSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } = require("fs");
const path = require("path");
const cp = require("child_process");
const crypto = require("crypto");

const TDIR = path.join(__dirname, "_wgate_v184");
const PORT = Number(process.env.WG_PORT || 8486);
const BASE = "http://127.0.0.1:" + PORT;
if (existsSync(TDIR)) rmSync(TDIR, { recursive: true, force: true });
mkdirSync(TDIR, { recursive: true });
copyFileSync(path.join(__dirname, "data", "db.json"), path.join(TDIR, "db.json"));
const sk = path.join(__dirname, "data", "secret.key");
if (existsSync(sk)) copyFileSync(sk, path.join(TDIR, "secret.key"));

const db0 = JSON.parse(readFileSync(path.join(TDIR, "db.json"), "utf8"));
const U = (s) => String(s == null ? "" : s).trim().toUpperCase();
const salt = crypto.randomBytes(16).toString("hex");
const hp = (p, s) => crypto.scryptSync(String(p), s, 32).toString("hex");
const PW = "E2e#Wg!183";
const mk = (id, un, nm, role) => db0.users.push({ id, username: un, name: nm, role, enabled: true, createdAt: Date.now(), mustChangePw: false, salt, passHash: hp(PW, salt) });
mk("u_wg_mat", "wg_mat", "预约物料员", "material");
mk("u_wg_ad", "wg_ad", "预约管理员", "admin");
db0.rcsConfig = null; db0.wmasConfig = null; db0.rcsStations = {}; db0.agvQueue = [];
db0.watchlist = []; // 清夹具自带预约：断言"是否写入"才干净
db0.params = Object.assign(db0.params || {}, { receivingOn: 0, reqHoursOn: 0 });
writeFileSync(path.join(TDIR, "db.json"), JSON.stringify(db0));

// 选样本：HAS=有在架框（应被拦）/ NONE=零在架（应放行）
const boxOf = {};
for (const x of db0.ledger || []) { const p = U(x.p); if (!p) continue; (boxOf[p] = boxOf[p] || new Set()).add([x.pid || "", x.l || "", x.c || ""].join("|")); }
let HAS = null, HAS_N = 0;
for (const p of Object.keys(boxOf)) { if (boxOf[p].size > 0) { HAS = p; HAS_N = boxOf[p].size; break; } }
const inLed = new Set(Object.keys(boxOf));
const NONE = [...new Set([...Object.keys(db0.itemDict || {}).map((k) => U(k)), ...(db0.requisitions || []).flatMap((r) => (r.items || []).map((i) => U(i.partNo)))])].filter((p) => p && !inLed.has(p)).sort()[0] || "";

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
    C("护栏 选到样本（有货/零在架）", !!HAS && !!NONE, `HAS=${HAS}(${HAS_N}框) NONE=${NONE}`);
    if (!HAS || !NONE) throw new Error("样本不足，闸无法验证");
    const lg = async (un) => (await post("/api/login", null, { username: un, password: PW, dev: "WG-" + un, kind: "pda" })).json.token;
    const tkM = await lg("wg_mat");
    C("护栏 物料员登录（预约是其日常动作，须以本人身份验闸）", !!tkM);

    // ① 有货预约 → 拦，且带框数与改开单指引
    const a = await post("/api/watchlist", tkM, { partNo: HAS, qty: 5, auto: true });
    C("★★★ 有货件预约被拦（code=in_stock）", a.status === 400 && a.json.code === "in_stock", `status=${a.status} code=${a.json.code}`);
    C("★★ 拒因带真实框数与指引（现场自证：约它=干等）", (a.json.boxes || 0) === HAS_N && /在架|开领料单/.test(String(a.json.msg || "")), `boxes=${a.json.boxes} msg=${String(a.json.msg || "").slice(0, 34)}`);
    const w1 = await getj("/api/watchlist", tkM);
    C("★★★ 被拦的预约确实未写入（不留下干等条目）", !(w1.json.list || []).some((x) => U(x.partNo) === HAS), `列表含HAS=${(w1.json.list || []).some((x) => U(x.partNo) === HAS)}`);

    // ② 人工裁决通道：明知有货仍要等下批（库存将空排队）→ 可放行
    const b = await post("/api/watchlist", tkM, { partNo: HAS, qty: 5, auto: true, forceStock: true });
    C("★★ forceStock 确认后放行（合理场景不被硬拦）", b.json.ok === true, `status=${b.status} msg=${String(b.json.msg || "").slice(0, 30)}`);
    const w2 = await getj("/api/watchlist", tkM);
    const e2 = (w2.json.list || []).find((x) => U(x.partNo) === HAS) || {};
    C("★★ 确认后预约确实写入且预订数正确", e2.target === 5 || e2.qty === 5, `target=${e2.target} qty=${e2.qty}`);

    // ③ 零在架正常预约完全不受影响（真缺货报缺的正当路径）
    const c = await post("/api/watchlist", tkM, { partNo: NONE, qty: 3, auto: true });
    C("★★★ 零在架件预约成功（真缺货永不拦）", c.json.ok === true, `${NONE} status=${c.status} msg=${String(c.json.msg || "").slice(0, 28)}`);

    // ④ 纯提醒型（qty=0，"到料告诉我"）不受闸影响——它不触发自动开单，不构成干等
    const d = await post("/api/watchlist", tkM, { partNo: HAS, qty: 0, auto: false });
    C("★★★ 纯提醒型预约（qty=0）不被拦（豁免正确，仅提醒无需库存校验）", d.json.ok === true, `status=${d.status}`);

    // ⑤ 取消预约不受闸影响
    const e = await post("/api/watchlist", tkM, { partNo: HAS, on: false });
    C("⑤ 取消预约正常（闸只管建立）", e.json.ok === true && e.json.off === true);
    C("★ 进程存活", (await fetch(BASE + "/api/health")).ok === true);
  } catch (e) {
    total++; fail++; console.log("❌ 异常：" + e.message + "\n" + String(out).split("\n").slice(-10).join("\n"));
  } finally {
    srv.kill(); await sleep(400);
    try { rmSync(TDIR, { recursive: true, force: true }); } catch (_) {}
  }
  console.log("\n结果: " + (total - fail) + " 通过 / " + fail + " 失败  （隔离副本，生产库零写入）");
  process.exit(fail ? 1 : 0);
})();
