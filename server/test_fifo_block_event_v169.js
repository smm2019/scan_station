// ㉖v169 严格FIFO拦截写入事件流水验证（第1项）
// 现场问题（11-12 截图）：事件流水筛"FIFO违反"只有 43 条放行、0 条拦截；同日领料单生命周期里
//   明明有 2 条「严格FIFO拦截」（刘向轩 10:25 扫 N26K100138 / N26K100130）。
// 根因：server.js 只在【放行】分支调 pushEvent('FIFO违反')，【拦截】分支只 hpush 进领料单
//   history，从不进事件流水 → 看板"今日FIFO违反"恒为 0，拦截量被系统性读成零。
// 修法：拦截分支补 pushEvent('FIFO拦截',...)。刻意用【新 kind】而非复用『FIFO违反』——
//   后者 KPI 标签是"跳批发料"（只有放行才有那层业务含义），混进去会让跳批次数被拦截数顶高，
//   两个指标各自含义都废掉。本测试同时反向验证这一点。
// ★ 为什么必须真跑：静态 grep 只能证明那行代码存在，证明不了它在拦截路径上能跑通——
//   若 pushEvent 里引用了作用域外的变量（例如 target/r 名字写错），线上会直接 500，
//   比原来"少一条记录"严重得多。只有真实走到该分支才暴露。
// 全程在隔离副本 + 独立端口执行；建单/接单/扫码都会写库，故绝不连生产 DATA_DIR。
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const crypto = require("crypto");

const TDIR = path.join(__dirname, "_fifo_t");
const PORT = 8385;
const BASE = "http://127.0.0.1:" + PORT;
if (fs.existsSync(TDIR)) fs.rmSync(TDIR, { recursive: true, force: true });
fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(__dirname, "data", "db.json"), path.join(TDIR, "db.json")); // 服务端读 DATA_DIR 根
const sk = path.join(__dirname, "data", "secret.key");
if (fs.existsSync(sk)) fs.copyFileSync(sk, path.join(TDIR, "secret.key"));

const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, "db.json"), "utf8"));
const U = (s) => String(s == null ? "" : s).trim().toUpperCase();
const salt = crypto.randomBytes(16).toString("hex");
const hp = (p, s) => crypto.scryptSync(String(p), s, 32).toString("hex");
const mkUser = (id, un, nm, role) => db0.users.push({ id, username: un, name: nm, role, enabled: true, createdAt: Date.now(), mustChangePw: false, salt, passHash: hp("E2e#Ff!169", salt) });
mkUser("u_ff_mat", "ff_mat", "FIFO物料员", "material"); // 建单需 requisition 权限
mkUser("u_ff_wh", "ff_wh", "FIFO仓管", "warehouse");     // 接单/扫码需 isWh
db0.rcsConfig = null; db0.wmasConfig = null; db0.rcsStations = {}; db0.agvQueue = [];
db0.params = Object.assign(db0.params || {}, { receivingOn: 0, reqHoursOn: 0, strictFifo: 1 });
fs.writeFileSync(path.join(TDIR, "db.json"), JSON.stringify(db0));

// 选一个"在架多框、有出库历史之外的码、无在途任务"的零件，并备好候选扫码
const outC = new Set();
for (const o of Object.values(db0.outbound || {})) for (const i of o.items || []) outC.add(U(i.barcode || ""));
const PN = (() => {
  const g = {};
  for (const x of db0.ledger || []) { const p = U(x.p || ""); if (!p) continue; (g[p] = g[p] || []).push(x); }
  const cand = [];
  for (const [p, rows] of Object.entries(g)) {
    const free = rows.filter((x) => !outC.has(U(x.c)) && !(db0.seenOut || {})[U(x.c)]);
    if (free.length < 2) continue;
    if ((db0.agvQueue || []).some((q) => free.some((r) => U(q.code || "") === U(r.c)))) continue;
    const lots = new Set(free.map((r) => U(r.b || "")).filter(Boolean));
    cand.push({ p, n: free.length, multiLot: lots.size >= 2 });
  }
  cand.sort((a, b) => (b.multiLot - a.multiLot) || (b.n - a.n));
  return cand[0] && cand[0].p;
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? "✅" : "❌"} ${n}${i !== undefined ? "  [" + i + "]" : ""}`); };
const post = async (p2, tk, body) => { const r = await fetch(BASE + p2, { method: "POST", headers: { "Content-Type": "application/json", ...(tk ? { Authorization: "Bearer " + tk } : {}) }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
const getj = async (p2, tk) => (await fetch(BASE + p2, { headers: tk ? { Authorization: "Bearer " + tk } : {} })).json();

(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, "server.js")], { env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", DATA_DIR: TDIR }, stdio: ["ignore", "pipe", "pipe"] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + "/api/health")).ok; } catch (_) {} }
  if (!up) { console.log("❌ 实例未就绪，终止"); srv.kill(); process.exit(1); }
  let srvOut = "";
  srv.stdout.on("data", (d) => { srvOut += d; });
  srv.stderr.on("data", (d) => { srvOut += d; });
  try {
    C("护栏 选到可用零件", !!PN, PN);
    if (!PN) throw new Error("无可用零件，测试无意义");
    const lgM = await post("/api/login", null, { username: "ff_mat", password: "E2e#Ff!169", dev: "FF-M", kind: "pda" });
    const lgW = await post("/api/login", null, { username: "ff_wh", password: "E2e#Ff!169", dev: "FF-W", kind: "pda" });
    const tkM = lgM.json.token, tkW = lgW.json.token;
    if (!tkM || !tkW) { console.log("❌ 登录失败终止 " + JSON.stringify(lgM.json).slice(0, 90) + JSON.stringify(lgW.json).slice(0, 90)); srv.kill(); process.exit(1); }
    console.log("✅ 登录成功（护栏1：物料员+仓管）");

    // ① 建单（只要 1 框，让接单锁定的建议清单尽量小，便于构造"清单外"扫码）
    const mk = await post("/api/requisitions", tkM, { items: [{ partNo: PN, qty: 25 }], note: "v169拦截验证" });
    const rid = (mk.json.req && (mk.json.req.id || mk.json.req.no)) || mk.json.id || mk.json.no;
    C("① 建单成功", mk.json.ok === true && !!rid, "status=" + mk.status + " id=" + rid + " msg=" + String(mk.json.msg || "").slice(0, 40));
    if (!rid) throw new Error("建单失败，无法继续");

    // ② 接单 → 服务器盖章锁定 sugCodes
    const ac = await post(`/api/requisitions/${rid}/accept`, tkW, {});
    const req0 = ac.json.req || ac.json.r || {};
    const rNo = String(req0.no || ""); // 业务单号 LL…（事件文案用的是它）；rid 是内部 id rq…，不能拿来比文案
    const it0 = (req0.items || []).find((i) => U(i.partNo) === U(PN)) || {};
    const sug = (it0.sugCodes || []).map((c) => U(c));
    C("② 接单成功且建议清单已锁定", ac.json.ok === true && sug.length > 0, "sugCodes=" + sug.length + " 单号=" + rNo);
    if (!sug.length) throw new Error("建议清单为空，FIFO 拦截分支不会进入（_allow.size 为 0 时不拦）");

    // ③ 找一个"在架、未出库、不在锁定清单内"的框 —— 这就是会被拦下的扫码
    const onLed = (db0.ledger || []).filter((x) => U(x.p) === U(PN) && !outC.has(U(x.c)) && !(db0.seenOut || {})[U(x.c)]);
    const bad = onLed.find((x) => !sug.includes(U(x.c)));
    C("③ 存在清单外的在架框（可触发拦截）", !!bad, bad ? bad.c + " 批" + bad.b : "无");
    if (!bad) throw new Error("构造不出清单外扫码，拦截路径无法验证");

    const evBefore = await getj("/api/agv/events?limit=3000", tkW);
    const list0 = evBefore.events || evBefore.list || evBefore.items || [];
    const cnt0 = list0.filter((e) => e.kind === "FIFO拦截").length; // 基线：生产副本本就带历史拦截（v169 昨天才上线，今天已 5 条），"=0"假设过期（11-13 实测），改差值口径
    const cntViol0 = list0.filter((e) => e.kind === "FIFO违反").length; // 库内已有历史放行事件，"不被污染"须按差值判
    C("护栏 记录触发前拦截基线（差值口径，环境无关）", true, "历史已有 " + cnt0 + " 条（含生产实况）");
    C("护栏 触发前已有 FIFO违反 历史条数（作污染比对基线）", true, cntViol0 + " 条");

    // ④ 扫那个框 → 期望被 400 拦下，且【不能 500】
    const sc = await post(`/api/requisitions/${rid}/scan`, tkW, { barcode: bad.c, partNo: PN });
    C("④ 扫码被拦（400 而非 500）★证明新增事件写入不炸接口", sc.status === 400, "status=" + sc.status + " msg=" + String(sc.json.msg || "").slice(0, 52));
    C("④b 拦截理由确为严格FIFO（不是别的闸先拦掉了）", /严格FIFO|不在本单建议框/.test(String(sc.json.msg || "")), String(sc.json.msg || "").slice(0, 46));
    C("④c 服务进程未崩溃（后续请求仍可应答）", (await fetch(BASE + "/api/health")).ok === true);
    if (sc.status === 500) console.log("   ⚠ 服务日志尾部：\n" + String(srvOut).split("\n").slice(-12).join("\n"));

    // ⑤ 事件流水里必须出现该条拦截，且信息足够定位
    const evAfter = await getj("/api/agv/events?limit=3000", tkW);
    const list1 = evAfter.events || evAfter.list || evAfter.items || [];
    const hit = list1.filter((e) => e.kind === "FIFO拦截" && String(e.msg || "").includes(bad.c));
    C("★★ 事件流水已出现该条 FIFO拦截（净增≥1 且含本次标签）", hit.length >= 1 && list1.filter((e) => e.kind === "FIFO拦截").length - cnt0 >= 1, "命中 " + hit.length + " 条，净增 " + (list1.filter((e) => e.kind === "FIFO拦截").length - cnt0));
    if (hit[0]) {
      console.log("   事件对象: kind=" + hit[0].kind + " who=" + hit[0].who + " msg=" + String(hit[0].msg).slice(0, 92));
      // 业务单号（LL…）而非内部 id（rq…）：现场按单号找单，事件里必须是 LL 号
      C("★ 事件含领料单号/标签/操作人（现场能追到是谁在哪单被拦）",
        String(hit[0].msg).includes(rNo) && String(hit[0].msg).includes(bad.c) && String(hit[0].msg).includes("FIFO仓管"),
        "单号命中=" + String(hit[0].msg).includes(rNo));
    }
    // 反向验证"拦截未变旁路"用标签绑定不变量：事件接口为派生视图（含账本合并类条目），
    // 前后总数相等会因快照窗口漂移误报（11-13 实测 35→34）；正确命题＝被拦的这框绝没有
    // 同时留下一条『FIFO违反』旁路记录（有=拦截形同虚设），与本单号绑定可精确判定。
    C("★★ 放行类指标未被污染（本框无 FIFO违反 旁路记录=拦截未变旁路）",
      !list1.some((e) => e.kind === "FIFO违反" && String(e.msg || "").includes(bad.c)),
      "旁路记录=" + list1.filter((e) => e.kind === "FIFO违反" && String(e.msg || "").includes(bad.c)).length + " 条");
    C("★★ 该框未被误发（拦截仍然有效，只是多了一条记录）",
      !((await getj(`/api/requisitions/${rid}`, tkW).catch(() => ({}))) || {}).ok ||
      !(((await getj(`/api/requisitions/${rid}`, tkW)).req || {}).items || []).some((i) => (i.issued || []).some((e) => U(typeof e === "string" ? e : e.c) === U(bad.c))),
      "未上账即正确");
  } catch (e) {
    total++; fail++; console.log("❌ 异常：" + e.message);
    console.log("   服务日志尾部：\n" + String(srvOut).split("\n").slice(-14).join("\n"));
  } finally {
    srv.kill(); await sleep(400);
    try { fs.rmSync(TDIR, { recursive: true, force: true }); } catch (_) {}
  }
  console.log("\n结果: " + (total - fail) + " 通过 / " + fail + " 失败  （隔离副本，生产库零写入）");
  process.exit(fail ? 1 : 0);
})();
