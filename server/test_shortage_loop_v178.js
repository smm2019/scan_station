// ㉖v178 缺料反馈闭环端到端验证（二期）
// 一期只做"生成微信文案"，反馈发完即蒸发（服务端零实体）。二期建 shortages 做闭环：
//   提交（同零件归并计热度）→ 仓管认领（通知全部反馈人）→ 到料自动核销 / 人工核销（幂等）。
// ★ 为什么必须真跑（静态 grep 证明不了）：
//   ①归并计热度要看真实多次提交后 n 与人数的变化，以及"同人重复=幂等不刷热度"；
//   ②自动核销挂在账本合并链路（stockWatchScan→shortageAutoResolve），只有真推一条入账本才走得通——
//     若 shortageAutoResolve 里变量名/参数顺序写错，线上表现是"到料不核销"甚至 500，比没这功能更糟；
//   ③通知是 notify() 落库的，只有真发才能证明反馈人确实收到认领/核销回执（闭环的意义就在这）。
//   ④权限：物料员能提交不能认领；仓管才能认领/核销——服务端二次强制，需真发请求验 403。
// 全程隔离副本 + 独立端口；生产库零写入。
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const crypto = require("crypto");

const TDIR = path.join(__dirname, "_short_v178");
const PORT = Number(process.env.SH_PORT || 8462);
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
const PW = "E2e#Sh!178";
const mkUser = (id, un, nm, role) => { db0.users.push({ id, username: un, name: nm, role, enabled: true, createdAt: Date.now(), mustChangePw: false, salt, passHash: hp(PW, salt) }); return id; };
const A_ID = mkUser("u_sh_a", "sh_a", "反馈员甲", "material");
const B_ID = mkUser("u_sh_b", "sh_b", "反馈员乙", "material");
mkUser("u_sh_wh", "sh_wh", "缺料仓管", "warehouse");
mkUser("u_sh_ad", "sh_ad", "缺料管理员", "admin"); // 自建 admin（生产 admin 带 mustChangePw，登录语义不确定，不借用）
db0.rcsConfig = null; db0.wmasConfig = null; db0.rcsStations = {}; db0.agvQueue = [];
db0.params = Object.assign(db0.params || {}, { receivingOn: 0, reqHoursOn: 0 });
fs.writeFileSync(path.join(TDIR, "db.json"), JSON.stringify(db0));

// 选一个"账本零在架、但系统认识（字典/流水/领料有背书）"的零件——反馈的主力场景
// 实测结构（11-13 核对）：itemDict 是以零件号为键的对象 {pn:{nm,src,at}}；scanlog 值里零件号字段=pn
const PN = (() => {
  const inLed = new Set((db0.ledger || []).map((x) => U(x.p)));
  const known = new Set([
    ...Object.keys(db0.itemDict || {}).map((k) => U(k)),
    ...Object.keys(db0.scanlog || {}).map((k) => U((db0.scanlog[k] || {}).pn || "")),
    ...(db0.requisitions || []).flatMap((r) => (r.items || []).map((i) => U(i.partNo))),
  ]);
  const cand = [...known].filter((p) => p && !inLed.has(p));
  cand.sort();
  return cand[0] || "";
})();
// 备料：账本里已占用的货位（推新行时避开，防"格位被占"冲突干扰测试）
const usedLoc = new Set((db0.ledger || []).map((x) => U(x.l)));
const CT = (db0.containerTypes && db0.containerTypes[0] && db0.containerTypes[0].db) || "托盘";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? "✅" : "❌"} ${n}${i !== undefined ? "  [" + i + "]" : ""}`); };
const post = async (p2, tk, body) => { const r = await fetch(BASE + p2, { method: "POST", headers: { "Content-Type": "application/json", ...(tk ? { Authorization: "Bearer " + tk } : {}) }, body: JSON.stringify(body || {}) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
const getj = async (p2, tk) => (await fetch(BASE + p2, { headers: tk ? { Authorization: "Bearer " + tk } : {} })).json();

(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, "server.js")], { env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", DATA_DIR: TDIR }, stdio: ["ignore", "pipe", "pipe"] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + "/api/health")).ok; } catch (_) {} }
  if (!up) { console.log("❌ 实例未就绪，终止"); srv.kill(); process.exit(1); }
  let srvOut = "";
  srv.stdout.on("data", (d) => { srvOut += d; });
  srv.stderr.on("data", (d) => { srvOut += d; });
  try {
    C("护栏 选到零在架且有背书的零件", !!PN, PN);
    if (!PN) throw new Error("构造不出零在架零件，闭环命题无法验证");
    const lg = async (un) => (await post("/api/login", null, { username: un, password: PW, dev: "SH-" + un, kind: "pda" })).json.token;
    const tkA = await lg("sh_a"), tkB = await lg("sh_b"), tkW = await lg("sh_wh"), tkAd = await lg("sh_ad");
    C("护栏 四个账号登录成功（物料×2/仓管/管理员）", !!(tkA && tkB && tkW && tkAd));

    // 夜间静默关到当前小时之外：否则通知进缓冲不落库，"回执"类断言会假失败
    const gp = await getj("/api/admin/params", tkAd);
    const nowH = new Date().getHours();
    await post("/api/admin/params", tkAd, { values: { nStart: (nowH + 1) % 24, nEnd: nowH }, cfgRev: gp.cfgRev });
    const gp2 = await getj("/api/admin/params", tkAd);
    // 接口返回 {items:[{k,val,...}]}（无 vals 对象）——上一版误读 gp2.vals 把"写入成功"判成失败
    const nStartNow = ((gp2.items || []).find((x) => x.k === "nStart") || {}).val;
    C("护栏 关闭夜间静默（通知当场落库）", Number(nStartNow) === (nowH + 1) % 24, "nStart " + ((gp2.items || []).find((x) => x.k === "nStart") || {}).val + " 当前小时=" + nowH);

    // ① 提交：首次=新建；第二人=归并计热度；同人重复=幂等
    const s1 = await post("/api/shortages", tkA, { partNo: PN, itemName: "测试缺料件", note: "产线等料", src: "test" });
    C("① 甲首次提交 → 新建", s1.json.ok === true && s1.json.created === true && s1.json.n === 1, "n=" + s1.json.n + " status=" + s1.json.status);
    const s2 = await post("/api/shortages", tkB, { partNo: PN, note: "我也缺" });
    C("★★ 乙提交同零件 → 归并计热度 n=2（不另开一条）", s2.json.ok === true && s2.json.created === false && s2.json.n === 2 && s2.json.id === s1.json.id, "n=" + s2.json.n + " 同一条=" + (s2.json.id === s1.json.id));
    const s3 = await post("/api/shortages", tkA, { partNo: PN, note: "再喊一次" });
    C("★★ 甲重复提交 → 幂等（n 仍=2，热度不被同人刷高）", s3.json.ok === true && s3.json.dup === true && s3.json.n === 2, "dup=" + s3.json.dup + " n=" + s3.json.n);
    const sBad = await post("/api/shortages", tkA, { partNo: "  " });
    C("①b 缺零件号被拒", sBad.status === 400);

    // ② 列表富化：热度/在架/建议补框 + mine 标记
    const L1 = await getj("/api/shortages?status=open", tkA);
    const it1 = (L1.list || []).find((x) => x.pn === PN) || {};
    C("★★ 列表含该条：n=2、零在架、mine 标记命中", it1.n === 2 && it1.boxes === 0 && (L1.mine || []).includes(PN), "n=" + it1.n + " boxes=" + it1.boxes + " 反馈人数=" + (it1.byList || []).length);
    C("②b 排序按热度（人多者前）", (L1.list || []).findIndex((x) => x.pn === PN) === 0, "首位=" + ((L1.list || [])[0] || {}).pn);
    C("②c 零在架无均值 → 不折框数（suggestBoxes=0，宁缺不假）", it1.suggestBoxes === 0, "suggestBoxes=" + it1.suggestBoxes + " gapQty=" + it1.gapQty);

    // ③ 权限：物料员不能认领/核销
    const c403 = await post("/api/shortages/claim", tkA, { id: s1.json.id, eta: "" });
    const r403 = await post("/api/shortages/resolve", tkB, { id: s1.json.id });
    C("★★ 物料员认领/核销被拒（403，服务端二次强制）", c403.status === 403 && r403.status === 403, "认领=" + c403.status + " 核销=" + r403.status);

    // ④ 认领：格式校验 + 状态 + 回执通知
    const cBad = await post("/api/shortages/claim", tkW, { id: s1.json.id, eta: "11月20号" });
    C("④ 预计到货日格式错被拒", cBad.status === 400, cBad.json.msg);
    const eta = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    const cOk = await post("/api/shortages/claim", tkW, { id: s1.json.id, eta });
    const L2 = await getj("/api/shortages?status=open", tkA);
    const it2 = (L2.list || []).find((x) => x.id === s1.json.id) || {};
    C("★★ 仓管认领成功 → status=claimed、认领人/到货日落库", cOk.json.ok === true && it2.status === "claimed" && it2.claimByName === "缺料仓管" && it2.eta === eta, "eta=" + it2.eta);
    await sleep(400);
    const hA = await getj("/api/notifications/history?limit=30", tkA);
    const hn = (hA.notifications || hA.list || hA.items || []);
    C("★★★ 反馈人甲收到认领回执（闭环第一环）", hn.some((x) => String(x.text || "").includes(PN) && /认领/.test(String(x.text || ""))), "近30条命中=" + hn.filter((x) => /认领/.test(String(x.text || ""))).length);
    C("④b 认领通知带上预计到货日（反馈人不必再问）", hn.some((x) => String(x.text || "").includes(eta)), "eta=" + eta);

    // ⑤ 到料自动核销：真推一条账本行（走 ledger/sync → stockWatchScan → shortageAutoResolve）
    let cell = "", seq = 0;
    while (usedLoc.has("NB03-A-98-" + String(++seq).padStart(2, "0")) && seq < 40) {}
    cell = "NB03-A-98-" + String(seq).padStart(2, "0");
    const code = "N26Z178001";
    const sy = await post("/api/ledger/sync", tkW, { items: [{ c: code, l: cell, f: CT, t: Date.now(), p: PN, n: "测试缺料件", q: 300, b: "2026-11-13", mv: "登记", src: "test" }] });
    C("⑤ 到货入账（账本同步成功）", sy.json.ok === true, "status=" + sy.status + " added=" + (sy.json.added ?? "?") + " msg=" + String(sy.json.msg || "").slice(0, 46));
    await sleep(700);
    const L3 = await getj("/api/shortages?status=resolved", tkA);
    const it3 = (L3.list || []).find((x) => x.id === s1.json.id) || {};
    C("★★★ 到料自动核销（无需人工，反馈人自动收回执）", it3.status === "resolved" && /到料自动核销/.test(String(it3.way || "")), "status=" + it3.status + " way=" + String(it3.way || "").slice(0, 40));
    const hA2 = await getj("/api/notifications/history?limit=30", tkA);
    const hn2 = (hA2.notifications || hA2.list || hA2.items || []);
    C("★★★ 反馈人收到到料核销回执（含在架框数）", hn2.some((x) => String(x.text || "").includes(PN) && /已到料/.test(String(x.text || ""))));
    const hB = await getj("/api/notifications/history?limit=30", tkB);
    C("★★ 乙（第二反馈人）同样收到回执（归并后全员回执，不是只通知发起人）",
      (hB.notifications || hB.list || hB.items || []).some((x) => String(x.text || "").includes(PN) && /已到料/.test(String(x.text || ""))));
    const L4 = await getj("/api/shortages?status=open", tkA);
    C("★★ 核销后从未处理列表消失（不会反复出现在仓管待办里）", !(L4.list || []).some((x) => x.id === s1.json.id), "未处理=" + (L4.list || []).length + " 条");

    // ⑥ 人工核销幂等：已 resolved 再核销不报错、不重复通知
    const before = (hn2.filter((x) => /已核销/.test(String(x.text || ""))).length);
    const rr = await post("/api/shortages/resolve", tkW, { id: s1.json.id, way: "再点一次" });
    await sleep(350);
    const hA3 = await getj("/api/notifications/history?limit=30", tkA);
    const after = ((hA3.notifications || hA3.list || hA3.items || []).filter((x) => /已核销/.test(String(x.text || ""))).length);
    C("⑥ 重复核销幂等（ok + already，不重复发通知）", rr.json.ok === true && rr.json.already === true && after === before, "already=" + rr.json.already + " 已核销通知 " + before + "→" + after);

    C("★ 进程存活（整轮改动未引入运行时错误）", (await fetch(BASE + "/api/health")).ok === true);
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
