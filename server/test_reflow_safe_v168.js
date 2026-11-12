// ㉖v168 清理结果安全性验证：PDA 旧缓存回灌能否复活已作废流水
// 背景：清理脚本只标服务器 cx，不碰每台 PDA 本机 Isar——那 9 条在本机仍是"正常"，
//       下次全量推送必然回灌。靠 v122「新者胜」仲裁（服务器 cxA 晚于该扫码 t → 压回）压住。
// ★ 本文件重写过一次。上一版有严重缺陷：数据文件写到 TDIR/data/db.json，而服务端读
//   DATA_DIR/db.json（=TDIR/db.json），实例实际空库启动、登录 401，脚本却继续跑完，
//   且断言读的是【我自己写的文件】——服务没动它，8 条 ✅ 全是自证假绿。
//   本版三道护栏：①登录失败立即退出 ②状态一律读服务端 API 不读文件 ③先证明 API 能查到
//   预期状态（排除"查不到所以恒真"）。
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const crypto = require("crypto");

const CLEAN_SRC = path.join(__dirname, "data", "db.json"); // 生产库（只读源，绝不被写）
const TDIR = path.join(__dirname, "_reflow");
const PORT = 8373;
const BASE = "http://127.0.0.1:" + PORT;
if (fs.existsSync(TDIR)) fs.rmSync(TDIR, { recursive: true, force: true });
fs.mkdirSync(TDIR, { recursive: true });
// 服务端 DB_FILE = DATA_DIR/db.json —— 必须放 TDIR 根，不能放 TDIR/data（上一版就错在这）
fs.copyFileSync(CLEAN_SRC, path.join(TDIR, "db.json"));
const sk = path.join(__dirname, "data", "secret.key");
if (fs.existsSync(sk)) fs.copyFileSync(sk, path.join(TDIR, "secret.key"));

// ★自包含：本测试需要"已清理"的库态。不在外部预置，而是在副本里跑【真实清理脚本 --apply】生成，
//   既不用手工步骤，也不复制清理逻辑（复制就会漂移）。生产库全程只读，写入只发生在 TDIR。
// 路径口径要对齐两个消费者：清理脚本读写 <其目录>/data/db.json，服务端读 DATA_DIR/db.json。
//   故先把副本放 TDIR/data/，跑完清理再把结果同步到 TDIR/db.json 供服务端加载。
const sh = (cmd, args, cwd) => { const r = cp.spawnSync(cmd, args, { cwd, encoding: "utf8" }); return { code: r.status, out: (r.stdout || "") + (r.stderr || "") }; };
fs.mkdirSync(path.join(TDIR, "data"), { recursive: true });
fs.copyFileSync(CLEAN_SRC, path.join(TDIR, "data", "db.json"));
fs.copyFileSync(path.join(__dirname, "cleanup_dup_flow_v167.js"), path.join(TDIR, "cleanup_dup_flow_v167.js"));
const mk = sh(process.execPath, ["cleanup_dup_flow_v167.js", "--apply"], TDIR);
if (mk.code !== 0) { console.log("❌ 构造已清理副本失败，终止（不产出结论）\n" + String(mk.out).split("\n").slice(-6).join("\n")); process.exit(1); }
fs.copyFileSync(path.join(TDIR, "data", "db.json"), path.join(TDIR, "db.json")); // 同步给服务端
console.log("副本准备：" + String(mk.out).split("\n").filter((l) => l.includes("已作废") || l.includes("复核")).join(" / "));

const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, "db.json"), "utf8"));
const salt = crypto.randomBytes(16).toString("hex");
const hp = (p, s) => crypto.scryptSync(String(p), s, 32).toString("hex");
db0.users.push({ id: "u_rf", username: "reflow", name: "回灌测试", role: "warehouse", enabled: true, createdAt: Date.now(), mustChangePw: false, salt, passHash: hp("E2e#Rf!168", salt) });
db0.rcsConfig = null; db0.wmasConfig = null; db0.rcsStations = {}; db0.agvQueue = [];
db0.params = Object.assign(db0.params || {}, { receivingOn: 0 });
fs.writeFileSync(path.join(TDIR, "db.json"), JSON.stringify(db0));

const ledKey = (rows) => (rows || []).map((x) => [x.c, x.l, x.q, x.by].join(":")).sort().join("|");
const FP = {
  ledRows: (db0.ledger || []).length,
  ledKey: ledKey(db0.ledger),
  live: Object.values(db0.scanlog).filter((x) => !x.cx).length,
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, info) => { total++; if (!c) fail++; console.log(`${c ? "✅" : "❌"} ${n}${info !== undefined ? "  [" + info + "]" : ""}`); };
async function post(p2, tk, body) { const r = await fetch(BASE + p2, { method: "POST", headers: { "Content-Type": "application/json", ...(tk ? { Authorization: "Bearer " + tk } : {}) }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; }
const U = (s) => String(s == null ? "" : s).trim().toUpperCase();

(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, "server.js")], { env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", DATA_DIR: TDIR }, stdio: ["ignore", "pipe", "pipe"] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + "/api/health")).ok; } catch (_) {} }
  if (!up) { console.log("❌ 实例未就绪"); srv.kill(); process.exit(1); }
  console.log("=== ⑩ PDA 旧缓存回灌验证（清理后真实副本 · 全部断言走服务端 API）===");
  try {
    const lg = await post("/api/login", null, { username: "reflow", password: "E2e#Rf!168", dev: "RF-1", kind: "pda" });
    const tk = lg.json.token;
    // ★护栏1：登录不成立则后续全是空过（上一版正是 401 继续跑，8 条 ✅ 全自证）
    if (!tk) { console.log("❌ 登录失败，终止且不产出结论 status=" + lg.status + " " + JSON.stringify(lg.json).slice(0, 200)); srv.kill(); process.exit(1); }
    console.log("✅ 登录成功（护栏1 通过，后续断言真实生效）");

    const api = async (p2) => { const r = await fetch(BASE + p2, { headers: { Authorization: "Bearer " + tk } }); return await r.json(); };

    // 清理脚本作废的 9 条（从副本取键）
    const cancelled = Object.entries(db0.scanlog).filter(([, v]) => v.cx && String(v.cxB || "") === "v168清理");
    const codes = [...new Set(cancelled.map(([, v]) => U(v.code)))];
    C("清理标记的作废记录 9 条 / 涉及 9 个标签", cancelled.length === 9 && codes.length === 9, cancelled.length + " 条 " + codes.length + " 码");

    // ★护栏3（先决条件）：API 必须能查到这 9 条且为作废态；否则"未被复活"会因『查不到』恒真
    let pool = [];
    for (const c of codes) { const j = await api("/api/scanlog?c=" + c + "&limit=500"); pool.push(...(j.items || [])); }
    const foundCancelled = cancelled.filter(([k]) => pool.some((x) => x.k === k && x.cx === true));
    C("★护栏3a API 能查到这 9 条的作废态（排除查不到恒真）", foundCancelled.length === 9, foundCancelled.length + "/9");
    C("★护栏3b 已作废条目 reg=-1（网页据此显示作废，非未上账）", foundCancelled.every(([k]) => (pool.find((x) => x.k === k) || {}).reg === -1));
    const led0 = ((await api("/api/ledger?l=")).items) || [];
    C("★护栏3c API 查到账本 >500 行（排除空库启动导致恒真）", led0.length > 500, led0.length + " 行");

    // === 模拟 PDA 全量推送：本机这些行仍是"正常"（cx=false, cxAt=0），带原键原时刻 ===
    const items = cancelled.map(([k, v]) => ({
      k, code: v.code, wt: Number(v.wt) || 0, st: v.st || "", gl: v.gl || "", ct: v.ct || "", rm: String(v.rm || ""),
      batch: v.batch || "", cx: false, cxAt: 0, t: Number(v.t) || 0, pn: v.pn || "", q: Number(v.q) || 0,
      mk: v.mk || "", op: v.op || "", nm: v.nm || "", lot: v.lot || "", pid: v.pid || "",
    }));
    const push = await post("/api/scanlog/sync", tk, { items });
    C("回灌推送被受理（不是靠报错拦，是靠 v122 仲裁压回）", push.json.ok === true, "pushed=" + push.json.pushed + " status=" + push.status);
    C("★服务端回传 cxKept=9 供 PDA 回写本机作废态", Array.isArray(push.json.cxKept) && push.json.cxKept.length === 9, "cxKept=" + (push.json.cxKept || []).length);
    C("cxKept 每条都标注 true（本机不会写回正常）", (push.json.cxKept || []).every((e) => Array.isArray(e) && e[1] === true));

    // === 回灌后服务器现态（走 API）===
    let pool2 = [];
    for (const c of codes) { const j = await api("/api/scanlog?c=" + c + "&limit=500"); pool2.push(...(j.items || [])); }
    const revived = cancelled.filter(([k]) => { const x = pool2.find((y) => y.k === k); return x && x.cx === false; });
    C("★★ 9 条全部未被复活（服务器仍为作废态）", revived.length === 0, "复活 " + revived.length + " 条");

    const all1 = ((await api("/api/scanlog?limit=20000")).items) || [];
    const liveNow = all1.filter((x) => !x.cx).length;
    C("有效流水未因回灌增加（本机旧缓存没能加回来）", liveNow === FP.live, liveNow + " vs " + FP.live);

    const g = {};
    for (const v of all1) { if (v.cx) continue; const c = U(v.code), l = U(Number(v.wt || 0) === 0 ? v.st : v.gl); if (!c || !l) continue; (g[c + "|" + l] = g[c + "|" + l] || []).push(v); }
    const dup = Object.values(g).filter((a) => a.length >= 2).length;
    C("★★ 重复组仍为 0（回灌未使重复复现）", dup === 0, dup);

    const led1 = ((await api("/api/ledger?l=")).items) || [];
    C("账本行数未变（回灌不碰账本）", led1.length === FP.ledRows, led1.length + " vs " + FP.ledRows);
    C("账本内容逐行未变（货位/件数/登记人）", ledKey(led1) === FP.ledKey,
      ledKey(led1) === FP.ledKey ? "" : "差异样例 " + ledKey(led1).split("|").filter((s, i) => s !== FP.ledKey.split("|")[i]).slice(0, 2).join(" ; "));

    const keptAlive = codes.filter((c) => pool2.some((x) => !x.cx && U(x.code) === c));
    C("每组保留的那条仍有效（未被连坐作废）", keptAlive.length === codes.length, keptAlive.length + "/" + codes.length);

    // 二次回灌（PDA 反复全量推是常态）
    await post("/api/scanlog/sync", tk, { items });
    const all2 = ((await api("/api/scanlog?limit=20000")).items) || [];
    C("反复回灌仍压得住（幂等，不越推越活）", all2.filter((x) => !x.cx).length === FP.live, all2.filter((x) => !x.cx).length + " vs " + FP.live);
  } catch (e) {
    total++; fail++; console.log("❌ 异常：" + e.message + "\n" + (e.stack || "").split("\n").slice(0, 3).join("\n"));
  } finally {
    srv.kill(); await sleep(400);
    // 自清理：本目录含整库副本（约 50MB），不清就每跑一次留一份。
    // 排查失败时可用 KEEP_TDIR=1 保留现场。
    if (process.env.KEEP_TDIR !== "1") { try { fs.rmSync(TDIR, { recursive: true, force: true }); } catch (_) {} }
  }
  console.log("\n结果: " + (total - fail) + " 通过 / " + fail + " 失败  （全程隔离副本，生产库零接触）");
  process.exit(fail ? 1 : 0);
})();
