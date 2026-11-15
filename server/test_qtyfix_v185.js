// ㉖v185 领料申请数服务端 FIFO 核准 端到端验证
// 事故原型（11-15 实锤 LL2026111508381316）：零件 8894086418 十框混装（40/80×7/90/80，
// 总770 均值77），用户网页填 7 框 → 端上均值换算 7×77=539 → FIFO 实发 530 → 单永挂
// "缺 9"假缺口。v185 把换算移到服务端（与 /api/req/preview 逐字同码），前端预览只负责展示。
// ★ 为什么必须真跑：①换算调 pickSuggest 读全库账本，静态只能证明代码在；②"与预览同码"
// 是本设计的命门——两处必须对同一 boxes 给出同一个数，只有同时真实调用两端才能证明；
// ③向后兼容（旧版 PDA 无 boxes 字段）与零在架保护（纯提醒单不被清零）都必须实测。
// 夹具：复制生产库后【清空该零件全部真实行】再注入 10 框标准混框，断言环境绝对干净。
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const crypto = require("crypto");

const TDIR = path.join(__dirname, "_qtyfix_v185");
const PORT = Number(process.env.QF_PORT || (8400 + Math.floor(Math.random() * 500))); // 随机段防僵尸进程占口致挂起/串库假象（11-15 复盘：8490 被历史遗留实例占用，新测连上僵尸库出现 770 幻觉）
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
const PW = "E2e#Qf!185";
db0.users.push({ id: "u_qf_mat", username: "qf_mat", name: "换算测试物料员", role: "material", enabled: true, createdAt: Date.now(), mustChangePw: false, salt, passHash: hp(PW, salt) });
db0.params = Object.assign(db0.params || {}, { receivingOn: 0, reqHoursOn: 0 });

// ── 复刻事故：清空目标零件真实行 → 注入 10 框混装（批次升序=40,80×5,90,80×3）──
const PN = "8894086418";
const PNC = "8894086418Z"; // 零在架对照件（账本保证无行）
db0.ledger = (db0.ledger || []).filter((x) => U(x.p) !== PN && U(x.p) !== PNC);
const mix = [
  { q: 40, lot: "2026-11-01" }, { q: 80, lot: "2026-11-02" }, { q: 80, lot: "2026-11-03" },
  { q: 80, lot: "2026-11-04" }, { q: 80, lot: "2026-11-05" }, { q: 80, lot: "2026-11-06" },
  { q: 90, lot: "2026-11-07" }, { q: 80, lot: "2026-11-08" }, { q: 80, lot: "2026-11-09" }, { q: 80, lot: "2026-11-10" },
];
mix.forEach((m, i) => {
  // 夹具必须像真实账本：每框唯一托号 + 格位不重叠（首轮失败根因=pid 缺失且格位重叠，
  // boxKeyOf 把 10 行归并成 1 框 770 件，slice 取 7 框实际只拿到 1 框 → 夹具失真非产品缺陷）
  const z = ["A", "B", "C"][Math.floor(i / 4)], row = 16 + Math.floor(i / 4), slot = (i % 2) + 1;
  db0.ledger.push({ c: "N26Q18500" + i + "X", l: `NB02-${z}-${row}-${slot}F`, f: "1800*1200_2", t: Date.now() - (10 - i) * 3600e3, p: PN, n: "混框换算测试件", q: m.q, b: m.lot, mv: "登记", src: "TEST", pid: `PLQ1850${i}` });
});
fs.writeFileSync(path.join(TDIR, "db.json"), JSON.stringify(db0));

// 期望值（夹具自算，独立于被测代码的公式核对）：
// FIFO 前 7 框 = 40+80+80+80+80+80+90 = 530；均值 = 770/10 = 77；端上旧算法 = 7×77 = 539
const EXP_FIFO7 = 530, EXP_AVG7 = 539;

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
    const tk = (await post("/api/login", null, { username: "qf_mat", password: PW, dev: "QF", kind: "web" })).json.token;
    C("护栏 物料员登录 + 夹具注入 10 框混装（总770/均值77）", !!tk, tk ? "" : "登录失败");
    if (!tk) throw new Error("无法登录");

    // ① 事故复刻：qty=539(端均值) + boxes=7 → 服务端核准为 FIFO 530，留痕
    const a = await post("/api/requisitions", tk, { items: [{ partNo: PN, itemName: "混框换算测试件", qty: EXP_AVG7, boxes: 7 }], remark: "v185核准验证" });
    const itA = ((a.json.req || {}).items || [])[0] || {};
    C("★★★ 带 boxes=7 提交：申请数被核准为 FIFO 实数 530（事故值 539 被纠正）", a.json.ok === true && itA.qty === EXP_FIFO7, `status=${a.status} qty=${itA.qty}`);
    C("★★ 核准差异留痕 _qtyFix 可审计", typeof itA._qtyFix === "string" && /539.*530/.test(itA._qtyFix), String(itA._qtyFix || "").slice(0, 46));

    // ② 与预览端点逐字一致（设计命门：两处同码）
    const pv = await getj(`/api/req/preview?items=${PN}:7`, tk);
    const rowPv = ((pv.json.rows || [])[0] || {});
    C("★★★ /api/req/preview 对同零件同框数返回 estQty=530，与落库申请数逐字一致", rowPv.mode === "real" && Math.round(rowPv.estQty) === EXP_FIFO7 && Math.round(itA.qty) === Math.round(rowPv.estQty), `预览=${rowPv.estQty} 落库=${itA.qty}`);

    // ③ 向后兼容：无 boxes 字段（旧版 PDA）→ 保留端上原值不误改
    const b = await post("/api/requisitions", tk, { items: [{ partNo: PN, itemName: "旧版无框数字段", qty: EXP_AVG7 }], remark: "旧版兼容" });
    const itB = ((b.json.req || {}).items || [])[0] || {};
    C("★★ 不带 boxes（旧版APK）：落 539 原值、无 _qtyFix（向后兼容）", b.json.ok === true && itB.qty === EXP_AVG7 && itB._qtyFix === undefined, `qty=${itB.qty} fix=${itB._qtyFix}`);

    // ④ 零在架保护：账本无行 + boxes → 不换算不清零（纯提醒/在途单语义不变）
    const c1 = await post("/api/requisitions", tk, { items: [{ partNo: PNC, itemName: "零在架纯提醒", qty: 1, boxes: 1 }], remark: "零在架保护" });
    const itC = ((c1.json.req || {}).items || [])[0] || {};
    C("★★★ 零在架带 boxes 提交：保留端值 1 不被清零（在途/提醒单不误伤）", c1.json.ok === true && itC.qty === 1 && itC._qtyFix === undefined, `qty=${itC.qty}`);

    // ⑤ FIFO 已一致时不产生差异留痕（正常单零打扰）
    const d = await post("/api/requisitions", tk, { items: [{ partNo: PN, itemName: "本来就对", qty: EXP_FIFO7, boxes: 7 }], remark: "无需修正" });
    const itD = ((d.json.req || {}).items || [])[0] || {};
    C("★★ 端值恰等于 FIFO 实数：落 530 且不写 _qtyFix（无差异不留痕）", d.json.ok === true && itD.qty === EXP_FIFO7 && itD._qtyFix === undefined, `qty=${itD.qty} fix=${itD._qtyFix}`);

    // ⑥ 异常框数上限防御：boxes>50 不换算（原值保留）
    const e = await post("/api/requisitions", tk, { items: [{ partNo: PN, itemName: "异常框数", qty: EXP_AVG7, boxes: 60 }], remark: "上限防御" });
    const itE = ((e.json.req || {}).items || [])[0] || {};
    C("⑥ boxes=60 超上限：不换算保留 539（防御性跳过）", e.json.ok === true && itE.qty === EXP_AVG7 && itE._qtyFix === undefined, `qty=${itE.qty}`);

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
