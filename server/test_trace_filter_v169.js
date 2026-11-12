// ㉖v169 全链路修正验证：查单个框不再列出兄弟出库单里别人的货
// 现场实锤（11-12 截图）：查 N26K070124 全链路，列出 3 条出库，其中 2 条明细根本不含该框
//   （DT20261110081451 = N26J270476/N26K070221/N26K070220/N26K080140 各220件；
//     DT20261110081834 = N26K060211/N26K060216/N26K060215 各800件）
// 根因：同一领料单 LL2026111007592767 拆成 3 张出库单，trace 只要 linkReqNo 命中就把整单摊出来。
// 修正口径：查框/查零件 → 只列相关行，无关兄弟单整条不列；查单号/领料单/任务 → 仍列全单。
// ★ 三道防假绿护栏（沿用上轮教训：曾因数据文件路径写错致实例空库启动、登录401，
//   脚本却继续跑完，8 条断言读自写文件全成自证假绿）：
//   ①登录失败立即退出 ②断言只读服务端 API 不读文件 ③先证明 API 能查到预期基线数据
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const crypto = require("crypto");

const TDIR = path.join(__dirname, "_trace_v169");
const PORT = 8383;
const BASE = "http://127.0.0.1:" + PORT;
if (fs.existsSync(TDIR)) fs.rmSync(TDIR, { recursive: true, force: true });
fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(__dirname, "data", "db.json"), path.join(TDIR, "db.json")); // 服务端读 DATA_DIR 根
const sk = path.join(__dirname, "data", "secret.key");
if (fs.existsSync(sk)) fs.copyFileSync(sk, path.join(TDIR, "secret.key"));

const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, "db.json"), "utf8"));
const salt = crypto.randomBytes(16).toString("hex");
const hp = (p, s) => crypto.scryptSync(String(p), s, 32).toString("hex");
db0.users.push({ id: "u_t9", username: "tr9", name: "链路验证", role: "admin", enabled: true, createdAt: Date.now(), mustChangePw: false, salt, passHash: hp("E2e#T9!169", salt) });
db0.rcsConfig = null; db0.wmasConfig = null; db0.rcsStations = {}; db0.agvQueue = [];
fs.writeFileSync(path.join(TDIR, "db.json"), JSON.stringify(db0));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? "✅" : "❌"} ${n}${i !== undefined ? "  [" + i + "]" : ""}`); };

const FOREIGN = ["N26J270476", "N26K070221", "N26K070220", "N26K080140", "N26K060211", "N26K060216", "N26K060215"];
const SELF = "N26K070124";
const OWN_ORDER = "DT20261110082224";
const SIB_ORDERS = ["DT20261110081451", "DT20261110081834"];

(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, "server.js")], { env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", DATA_DIR: TDIR }, stdio: ["ignore", "pipe", "pipe"] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + "/api/health")).ok; } catch (_) {} }
  if (!up) { console.log("❌ 实例未就绪"); srv.kill(); process.exit(1); }
  try {
    const lg = await (await fetch(BASE + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "tr9", password: "E2e#T9!169", dev: "T9-1", kind: "pda" }) })).json();
    const tk = lg.token;
    if (!tk) { console.log("❌ 登录失败，终止不产出结论 status=" + lg.status + " " + JSON.stringify(lg).slice(0, 160)); srv.kill(); process.exit(1); }
    console.log("✅ 登录成功（护栏1）");
    const H = { Authorization: "Bearer " + tk };
    const tr = async (q) => (await (await fetch(BASE + "/api/trace?q=" + encodeURIComponent(q), { headers: H })).json());

    // 护栏3：先证明这个框在服务器上真有历史（否则"看不到泄漏"会因为本来就查不到而恒真）
    const jSelf = await tr(SELF);
    const evSelf = (jSelf.events || []).filter((e) => e.kind === "out");
    C("护栏3 该框在服务器确有出库历史（≥1条，否则后续断言无意义）", evSelf.length >= 1, "出库事件 " + evSelf.length + " 条");
    C("护栏3b 该框真实那张单查得到（基线，防改丢）", evSelf.some((e) => String(e.title).includes(OWN_ORDER) && String(e.detail).includes(SELF + "×448")));

    console.log("\n--- 【核心】查框 " + SELF + "：不再出现不含本框的出库明细 ---");
    let leak = 0;
    for (const o of evSelf) {
      const has = String(o.detail).includes(SELF);
      const hasForeign = FOREIGN.some((f) => String(o.detail).includes(f));
      if (!has || hasForeign) leak++;
      console.log(`   ${has && !hasForeign ? "✅" : "❌"} ${o.title} | ${String(o.detail).slice(0, 86)}`);
    }
    C("★★ 出库明细全部含本框、且不含任何别框条码", leak === 0, "泄漏 " + leak + " 条");
    C("★★ 兄弟出库单号不再出现在该框链路里", !evSelf.some((e) => SIB_ORDERS.some((s) => String(e.title).includes(s))), evSelf.map((e) => String(e.title).replace(/[^\d]/g, "").slice(0, 8)).join(","));
    C("★ 该框自身出库事件未被改丢（仍 ≥1 条且含 448 件）", evSelf.length >= 1 && evSelf.every((e) => /448/.test(String(e.detail))));
    C("★ 其它事件类别未被误删（采集入库仍在）", (jSelf.events || []).some((e) => /采集入库|入库/.test(String(e.title))));

    console.log("\n--- 【反向】查单号仍应看全单（本来就该看全，不能被改坏）---");
    for (const so of SIB_ORDERS) {
      const js = await tr(so);
      const o = (js.events || []).find((e) => e.kind === "out" && String(e.title).includes(so));
      C("按 " + so + " 查显示全单多框明细", o && FOREIGN.filter((f) => String(o.detail).includes(f)).length >= 2, o ? String(o.detail).slice(0, 56) : "未找到出库事件");
    }
    const jOwn = await tr(OWN_ORDER);
    C("查本框那张单也能看到本框", (jOwn.events || []).some((e) => e.kind === "out" && String(e.detail).includes(SELF)));

    console.log("\n--- 【防自相矛盾】提示『未列出』时，正文里不能有无关条码 ---");
    const badTip = evSelf.filter((e) => {
      const d = String(e.detail);
      if (!/（同单另有 \d+ 框/.test(d)) return false;
      const head = d.split("（同单另有")[0];
      return FOREIGN.some((f) => head.includes(f));
    });
    C("提示与正文自洽（首版缺陷：提示未列出、内容却列出别人的货）", badTip.length === 0, badTip.length + " 条矛盾");

    console.log("\n--- 【不崩溃】其它种子类型仍可用 ---");
    for (const [q, label] of [["6608197900", "按零件号"], ["LL2026111007592767", "按领料单"], ["不存在码ZZZ9999", "不存在"]]) {
      const j = await tr(q);
      C(label + " 查询正常返回", j && j.ok !== false && Array.isArray(j.events), (j.events || []).length + " 事件 kind=" + (j.kind || "?"));
    }
  } catch (e) {
    total++; fail++; console.log("❌ 异常：" + e.message + "\n" + (e.stack || "").split("\n").slice(0, 3).join("\n"));
  } finally {
    srv.kill(); await sleep(400);
    try { fs.rmSync(TDIR, { recursive: true, force: true }); } catch (_) {}
  }
  console.log("\n结果: " + (total - fail) + " 通过 / " + fail + " 失败  （生产库仅只读复制，零写入）");
  process.exit(fail ? 1 : 0);
})();
