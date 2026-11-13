// ㉖v176 晚批次确认放行通道删除验证（用户 2026-11-13 裁定）
// 裁定原文：不在本单接单锁定建议框的码——严格拦截，不要弹黄窗，不要人工确认，直接拦截。
// 删掉的通道（v94s 起存在）：PDA 弹黄窗 → 人点"确认继续" → 带 fifo.ok=1 上报 → 服务端复核批次更晚 → 放行 + 记『FIFO违反』。
// ★ 为什么必须真跑（静态 grep 证明不了）：
//   ①"删干净"＝带 fifo.ok=1 的请求也必须 400。若残留一支 else-if 仍读 b.fifo.ok，
//     旧版 PDA（现网还有 174 以前的包）照样能扫出去，而这一层在源码里看着"已经删了"。
//   ②反向也要证：正常建议框必须照常能扫——若把整段闸门连带 _allow 判定误删，
//     现场会当场扫不了任何框（比留通道严重得多）。
//   ③拦截仍要落事件流水并立即落盘（v169 语义不因本轮回退）。
// 全程隔离副本 + 独立端口，绝不连生产 DATA_DIR。
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const crypto = require("crypto");

const TDIR = path.join(__dirname, "_nob_v176");
const PORT = Number(process.env.FNB_PORT || 8456);
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
const mkUser = (id, un, nm, role) => db0.users.push({ id, username: un, name: nm, role, enabled: true, createdAt: Date.now(), mustChangePw: false, salt, passHash: hp("E2e#Ff!176", salt) });
mkUser("u_nb_mat", "nb_mat", "无旁路物料员", "material");
mkUser("u_nb_wh", "nb_wh", "无旁路仓管", "warehouse");
db0.rcsConfig = null; db0.wmasConfig = null; db0.rcsStations = {}; db0.agvQueue = [];
db0.params = Object.assign(db0.params || {}, { receivingOn: 0, reqHoursOn: 0, strictFifo: 1 });
fs.writeFileSync(path.join(TDIR, "db.json"), JSON.stringify(db0));

// 选件：在架多框、跨批次，且存在"批次晚于建议最早批、又不在建议清单内"的框
// ——这个框正是旧通道唯一能过的场景，本轮必须被拦死。
const outC = new Set();
for (const o of Object.values(db0.outbound || {})) for (const i of o.items || []) outC.add(U(i.barcode || ""));
const freeOf = (p) => (db0.ledger || []).filter((x) => U(x.p) === U(p) && !outC.has(U(x.c)) && !(db0.seenOut || {})[U(x.c)]);
const PN = (() => {
  const g = {};
  for (const x of db0.ledger || []) { const p = U(x.p || ""); if (!p) continue; (g[p] = g[p] || []).push(x); }
  const cand = [];
  for (const [p, rows] of Object.entries(g)) {
    const free = rows.filter((x) => !outC.has(U(x.c)) && !(db0.seenOut || {})[U(x.c)]);
    if (free.length < 2) continue;
    if ((db0.agvQueue || []).some((q) => free.some((r) => U(q.code || "") === U(r.c)))) continue;
    const lots = free.map((r) => U(r.b || "")).filter(Boolean).sort();
    if (lots.length < 2) continue;
    cand.push({ p, span: lots[lots.length - 1].localeCompare(lots[0]), n: free.length });
  }
  cand.sort((a, b) => (b.span > 0 ? 1 : 0) - (a.span > 0 ? 1 : 0) || b.n - a.n);
  return cand[0] && cand[0].p;
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? "✅" : "❌"} ${n}${i !== undefined ? "  [" + i + "]" : ""}`); };
const post = async (p2, tk, body) => { const r = await fetch(BASE + p2, { method: "POST", headers: { "Content-Type": "application/json", ...(tk ? { Authorization: "Bearer " + tk } : {}) }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
const getj = async (p2, tk) => (await fetch(BASE + p2, { headers: tk ? { Authorization: "Bearer " + tk } : {} })).json();
// 事件接口列表字段名历史上换过（events/list/items），统一走本函数取，避免调用点取到 undefined 当成"零条"
const evList = async (tk) => { const j = await getj("/api/agv/events?limit=3000", tk); return j.events || j.list || j.items || []; };

(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, "server.js")], { env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", DATA_DIR: TDIR }, stdio: ["ignore", "pipe", "pipe"] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + "/api/health")).ok; } catch (_) {} }
  if (!up) { console.log("❌ 实例未就绪，终止"); srv.kill(); process.exit(1); }
  let srvOut = "";
  srv.stdout.on("data", (d) => { srvOut += d; });
  srv.stderr.on("data", (d) => { srvOut += d; });
  try {
    C("护栏 选到跨批次可用零件", !!PN, PN);
    if (!PN) throw new Error("无跨批次零件，本轮命题无法构造");
    const tkM = (await post("/api/login", null, { username: "nb_mat", password: "E2e#Ff!176", dev: "NB-M", kind: "pda" })).json.token;
    const tkW = (await post("/api/login", null, { username: "nb_wh", password: "E2e#Ff!176", dev: "NB-W", kind: "pda" })).json.token;
    if (!tkM || !tkW) { console.log("❌ 登录失败终止"); srv.kill(); process.exit(1); }
    console.log("✅ 登录成功（物料员+仓管）");

    // 建单只要 1 框（让盖章集尽量小→晚批框必然落在清单外）
    const mk = await post("/api/requisitions", tkM, { items: [{ partNo: PN, qty: 1 }], note: "v176无旁路验证" });
    const rid = (mk.json.req && (mk.json.req.id || mk.json.req.no)) || mk.json.id || mk.json.no;
    C("① 建单成功", mk.json.ok === true && !!rid, "status=" + mk.status);
    if (!rid) throw new Error("建单失败");
    const ac = await post(`/api/requisitions/${rid}/accept`, tkW, {});
    const req0 = ac.json.req || ac.json.r || {};
    const it0 = (req0.items || []).find((i) => U(i.partNo) === U(PN)) || {};
    const sug = (it0.sugCodes || []).map((c) => U(c));
    C("② 接单锁定建议清单", ac.json.ok === true && sug.length > 0, "sugCodes=" + sug.length);
    if (!sug.length) throw new Error("建议清单为空 → _allow.size 为 0 时闸门不拦，命题失效");

    const one0 = await getj(`/api/requisitions/${rid}`, tkW);
    const itV = ((one0.req || {}).items || []).find((i) => U(i.partNo) === U(PN)) || {};
    const sg = itV.suggest || {};
    const lotOfSug = (sg.flatBoxes || []).map((f) => String(f.b || "").trim()).filter(Boolean).sort();
    const oldest = lotOfSug[0] || "";
    const badBox = freeOf(PN).filter((x) => !sug.includes(U(x.c)) && U(x.b || "") > oldest).sort((a, b) => String(b.b).localeCompare(String(a.b)))[0];
    C("③ 存在清单外的晚批框（旧通道唯一放行场景）", !!badBox && !!oldest, badBox ? badBox.c + " 批" + badBox.b + " vs 最早建议批" + oldest : "无");
    if (!badBox) throw new Error("构造不出晚批清单外框");

    const L0 = await evList(tkW);
    C("护栏 记录触发前事件基线（派生视图会漂移，故本轮用标签绑定判定）", true,
      "基线 " + L0.length + " 条，其中 FIFO违反 " + L0.filter((e) => e.kind === "FIFO违反").length + " 条");

    // ④ 核心命题：带"人工已确认"标记扫晚批框 → 仍必须 400（旧版此处放行）
    const sc = await post(`/api/requisitions/${rid}/scan`, tkW, {
      barcode: badBox.c, partNo: PN, qty: 1,
      fifo: { lot: String(badBox.b || ""), oldest: oldest, ok: 1 },
    });
    C("★★★ 带确认标记扫晚批框仍被拦（400 非放行、非 500）", sc.status === 400, "status=" + sc.status + " msg=" + String(sc.json.msg || "").slice(0, 48));
    C("★★★ 服务端未把该框记账发出（拦截是真拦）", !(((await getj(`/api/requisitions/${rid}`, tkW)).req || {}).items || []).some((i) => (i.issued || []).some((e) => U(typeof e === "string" ? e : e.c) === U(badBox.c))));
    const L1 = await evList(tkW);
    // 标签绑定不变量（不用总数差值）：事件接口是派生视图（含账本合并类条目），两次快照窗口会漂移
    // （v169 实测 35→34，与本轮改动无关）。真正要证的是"这个被拦的框没有同时留下放行记录"。
    C("★★ 未写入『FIFO违反』放行记录（通道不再生效）",
      !L1.some((e) => e.kind === "FIFO违反" && String(e.msg || "").includes(badBox.c)),
      "该框放行记录=" + L1.filter((e) => e.kind === "FIFO违反" && String(e.msg || "").includes(badBox.c)).length + " 条（须为0）· 全库FIFO违反 " +
      L1.filter((e) => e.kind === "FIFO违反").length + " 条（派生视图，仅参考）");
    C("★ 拦截仍进事件流水（v169 语义未回退）",
      L1.some((e) => e.kind === "FIFO拦截" && String(e.msg || "").includes(badBox.c)));
    C("★ 提示仍告知该拣哪一批（现场可自助）", /应拣|建议先拣|最早/.test(String(sc.json.msg || "")) || /本单建议先拣/.test(String(sc.json.msg || "")), String(sc.json.msg || "").slice(-58));

    // ⑤ 反向：正常建议框必须照常扫得动（防误删闸门把正常发料一起废掉）
    // 并故意带上 fifo.ok=1 模拟"现网旧版 PDA（174 及以下仍会上报该标记）"：
    // 发料成功的同时，绝不允许被记成『FIFO违反』跳批（主路径残留的补记行已删，本条钉住不复活）
    const sugCode = (sg.flatBoxes || [])[0] || {};
    const sc2 = await post(`/api/requisitions/${rid}/scan`, tkW, {
      barcode: sugCode.c, partNo: PN, qty: Number(sugCode.q) || 1,
      fifo: { lot: String(sugCode.b || ""), oldest: oldest, ok: 1 },
    });
    C("★★★ 建议清单内的框照常能扫（正常发料未被误伤）", sc2.json.ok === true, "status=" + sc2.status + " msg=" + String(sc2.json.msg || "").slice(0, 44));
    const L2 = await evList(tkW);
    C("★★★ 旧版PDA带确认标记扫正常框，未被记成跳批发料（假记录源已消除）",
      !L2.some((e) => e.kind === "FIFO违反" && String(e.msg || "").includes(String(sugCode.c || ""))),
      "该框FIFO违反记录=" + L2.filter((e) => e.kind === "FIFO违反" && String(e.msg || "").includes(String(sugCode.c || ""))).length + " 条（须为0）");

    // ⑥ 应急通道边界仍在：本轮只封黄窗，MES 故障应急登记（emergency）语义不得被顺带改掉
    C("★ 应急旁路入口仍在（服务端仍认 emergency，未被顺带砍掉）",
      /应急登记|应急旁路/.test(fs.readFileSync(path.join(__dirname, "server.js"), "utf8")));
    C("★ 进程存活（改动未引入运行时错误）", (await fetch(BASE + "/api/health")).ok === true);
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
