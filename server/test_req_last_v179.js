// ㉖v179 末次领料端点 /api/req/last 端到端验证
// 为什么必须真跑 + 为什么必须服务端算（不是端上算）：
//   ①领料列表对 material 角色只返回本人单（server 里 role 过滤）。端上自算"末次领料/在途需求"
//     会把【同事领过、同事在等】看成"无记录"→ 缺料分享与预约页据此判断补货量必然偏少。
//     只有真用第二个物料员发请求才能证明"跨人可见"。
//   ②口径缺陷只有真数据能抓：pending（刚下单还没发一件）若不设门槛会被算成"上次领用"，
//     文案就成了"3 分钟前领过 500 件"这种谎话。本轮已限定只认 ready/done 或有实发的行，
//     本测试用"纯 pending 单不进 map 但进 demand"同时钉住两半（发料不算 / 需求要算）。
//   ③拒单（rejected）不算领用——拒了等于没领。
// 全程隔离副本 + 独立端口，生产库零写入。
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const crypto = require("crypto");

const TDIR = path.join(__dirname, "_last_v179");
const PORT = Number(process.env.LST_PORT || 8466);
const BASE = "http://127.0.0.1:" + PORT;
if (fs.existsSync(TDIR)) fs.rmSync(TDIR, { recursive: true, force: true });
fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(__dirname, "data", "db.json"), path.join(TDIR, "db.json"));
const sk = path.join(__dirname, "data", "secret.key");
if (sk && fs.existsSync(sk)) fs.copyFileSync(sk, path.join(TDIR, "secret.key"));

const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, "db.json"), "utf8"));
const U = (s) => String(s == null ? "" : s).trim().toUpperCase();
const salt = crypto.randomBytes(16).toString("hex");
const hp = (p, s) => crypto.scryptSync(String(p), s, 32).toString("hex");
const PW = "E2e#Ls!179";
const mk = (id, un, nm, role) => db0.users.push({ id, username: un, name: nm, role, enabled: true, createdAt: Date.now(), mustChangePw: false, salt, passHash: hp(PW, salt) });
mk("u_ls_a", "ls_a", "甲物料员", "material");
mk("u_ls_b", "ls_b", "乙物料员", "material");
mk("u_ls_wh", "ls_wh", "发料仓管", "warehouse");
mk("u_ls_ad", "ls_ad", "末次管理员", "admin");
db0.rcsConfig = null; db0.wmasConfig = null; db0.rcsStations = {}; db0.agvQueue = [];
db0.params = Object.assign(db0.params || {}, { receivingOn: 0, reqHoursOn: 0 });
fs.writeFileSync(path.join(TDIR, "db.json"), JSON.stringify(db0));

// 选件：PN=账本有在架框且【历史无 ready/done 领料记录】（基线必须干净，否则测不出"新增"）
const outC = new Set();
for (const o of Object.values(db0.outbound || {})) for (const i of o.items || []) outC.add(U(i.barcode || ""));
const pickedPns = new Set((db0.requisitions || []).filter((r) => ['ready', 'done'].includes(r.status)).flatMap((r) => (r.items || []).map((i) => U(i.partNo))));
const PN = (() => {
  const g = {};
  for (const x of db0.ledger || []) { const p = U(x.p); if (!p) continue; (g[p] = g[p] || []).push(x); }
  const cand = Object.entries(g)
    .map(([p, rows]) => ({ p, n: rows.filter((x) => !outC.has(U(x.c)) && !(db0.seenOut || {})[U(x.c)]).length }))
    .filter((x) => x.n >= 2 && !pickedPns.has(x.p)).sort((a, b) => b.n - a.n);
  return cand[0] ? cand[0].p : "";
})();
const PNB = (() => {
  const inLed = new Set((db0.ledger || []).map((x) => U(x.p)));
  const known = new Set([...Object.keys(db0.itemDict || {}).map((k) => U(k)), ...(db0.requisitions || []).flatMap((r) => (r.items || []).map((i) => U(i.partNo)))]);
  const c = [...known].filter((p) => p && !inLed.has(p) && p !== PN).sort();
  return c[0] || "";
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? "✅" : "❌"} ${n}${i !== undefined ? "  [" + i + "]" : ""}`); };
const post = async (p2, tk, body) => { const r = await fetch(BASE + p2, { method: "POST", headers: { "Content-Type": "application/json", ...(tk ? { Authorization: "Bearer " + tk } : {}) }, body: JSON.stringify(body || {}) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
const getj = async (p2, tk) => { const r = await fetch(BASE + p2, { headers: tk ? { Authorization: "Bearer " + tk } : {} }); return { status: r.status, json: await r.json().catch(() => ({})) }; };

(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, "server.js")], { env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", DATA_DIR: TDIR }, stdio: ["ignore", "pipe", "pipe"] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + "/api/health")).ok; } catch (_) {} }
  if (!up) { console.log("❌ 实例未就绪，终止"); srv.kill(); process.exit(1); }
  let srvOut = "";
  srv.stdout.on("data", (d) => { srvOut += d; });
  srv.stderr.on("data", (d) => { srvOut += d; });
  try {
    C("护栏 选到有货零件与零在架零件", !!PN && !!PNB, "PN=" + PN + " PNB=" + PNB);
    if (!PN || !PNB) throw new Error("选件失败，命题无法验证");
    const lg = async (un) => (await post("/api/login", null, { username: un, password: PW, dev: "LS-" + un, kind: "pda" })).json.token;
    const tkA = await lg("ls_a"), tkB = await lg("ls_b"), tkW = await lg("ls_wh"), tkAd = await lg("ls_ad");
    C("护栏 四账号登录（物料×2/仓管/管理员）", !!(tkA && tkB && tkW && tkAd));

    // ① 基线：PN 选件时已排除历史 ready/done 记录 → 此刻不该有领用记录（不谎报）
    //   PNB 不断言 map 为空：生产副本里它可能本就有历史领用记录（首轮实测=金先发 领过 2000 件），
    //   ④⑤ 改用"我们这张新单有没有被算进去"来判定，才是环境无关的正确命题。
    const b0 = await getj(`/api/req/last?items=${PN},${PNB}`, tkA);
    C("① 基线：PN 无领用史（map 不含，不谎报）", b0.json.ok === true && !b0.json.map[PN] && (b0.json.demand || {})[PN] === undefined, "map含PN=" + !!b0.json.map[PN]);
    C("①b 回传真实归档窗口（端上文案用它，不硬编天数）", Number(b0.json.windowDays) >= 90, "windowDays=" + b0.json.windowDays);

    // ② 甲建单 + 接单 + 真实扫码发料
    const mk1 = await post("/api/requisitions", tkA, { items: [{ partNo: PN, qty: 1 }], remark: "v179末次验证" });
    const rid = (mk1.json.req && (mk1.json.req.id || mk1.json.req.no)) || mk1.json.id;
    C("② 甲建单成功", mk1.json.ok === true && !!rid, "status=" + mk1.status);
    if (!rid) throw new Error("建单失败");
    const ac = await post(`/api/requisitions/${rid}/accept`, tkW, {});
    const it0 = ((ac.json.req || ac.json.r || {}).items || []).find((i) => U(i.partNo) === U(PN)) || {};
    const sug = (it0.sugCodes || []).map((c) => U(c));
    C("②b 接单并锁定建议框", ac.json.ok === true && sug.length > 0, "sug=" + sug.length);
    const one = await getj(`/api/requisitions/${rid}`, tkW);
    const bx = ((((one.json.req || {}).items || []).find((i) => U(i.partNo) === U(PN)) || {}).suggest || {}).flatBoxes || [];
    const code0 = (bx[0] || {}).c || sug[0];
    const q0 = Number((bx[0] || {}).q) || 1;
    const sc = await post(`/api/requisitions/${rid}/scan`, tkW, { barcode: code0, partNo: PN, qty: q0 });
    C("②c 真实扫码发料成功", sc.json.ok === true, "code=" + code0 + " qty=" + q0 + " msg=" + String(sc.json.msg || "").slice(0, 40));

    // ③ ★核心：甲发的料，乙（另一物料员）也看得见 = 全厂口径
    const j3 = await getj(`/api/req/last?items=${PN}`, tkB);
    const m3 = (j3.json.map || {})[PN] || {};
    C("★★★ 甲领的记录乙看得见（全厂口径，端上自算必偏少）", j3.json.ok === true && m3.t > 0 && m3.qty > 0, "qty=" + m3.qty + " by=" + m3.by + " no=" + String(m3.no || "").slice(0, 20));
    C("★★ 记录带单号与领用人（现场能核对是哪一单）", String(m3.no || "").length > 5 && m3.by === "甲物料员", "by=" + m3.by);

    // ④ ★pending 不算领用，但算在途需求（两半分开钉）
    // 基线：PNB 在生产副本里可能本就有历史领用记录，也可能已有别人的待接需求
    const baseMap = JSON.stringify((b0.json.map || {})[PNB] || null);
    const baseDem = ((b0.json.demand || {})[PNB] || {}).qty || 0;
    const baseDocs = ((b0.json.demand || {})[PNB] || {}).docs || 0;
    const mk2 = await post("/api/requisitions", tkB, { items: [{ partNo: PNB, qty: 500 }], remark: "纯待接单" });
    const rid2 = (mk2.json.req && (mk2.json.req.id || mk2.json.req.no)) || mk2.json.id;
    const no2 = String((mk2.json.req || {}).no || "");
    C("④ 乙对零在架零件建单（停在待接单）", mk2.json.ok === true && !!rid2, "status=" + mk2.status);
    const j4 = await getj(`/api/req/last?items=${PNB}`, tkA);
    const m4 = (j4.json.map || {})[PNB] || null, d4 = (j4.json.demand || {})[PNB] || {};
    C("★★★ 纯待接单不产生'上次领用'（map 与基线逐字一致，否则显示'刚领过500件'=谎话）",
      JSON.stringify(m4) === baseMap, "基线=" + baseMap.slice(0, 52) + " 现在=" + JSON.stringify(m4 || null).slice(0, 52));
    C("★★★ 乙的需求甲看得见，且恰好多我们这一单 500 件（全厂需求口径）",
      (d4.qty || 0) === baseDem + 500 && (d4.docs || 0) === baseDocs + 1, `需求 ${baseDem}→${d4.qty} 单数 ${baseDocs}→${d4.docs}`);

    // ⑤ 拒单不算领用，且需求随之下账
    const rj = await post(`/api/requisitions/${rid2}/reject`, tkW, { reason: "无货可发" });
    C("⑤ 仓管拒单", rj.json.ok === true, "status=" + rj.status);
    const j5 = await getj(`/api/req/last?items=${PNB}`, tkA);
    const m5 = (j5.json.map || {})[PNB] || null, d5 = (j5.json.demand || {})[PNB] || {};
    C("★★ 拒单不产生领用记录（map 仍与基线一致）", JSON.stringify(m5) === baseMap, "现在=" + JSON.stringify(m5 || null).slice(0, 52));
    C("★★ 拒单后该单需求下账（回到基线，不留在途虚高）",
      (d5.qty || 0) === baseDem && (d5.docs || 0) === baseDocs && !(m5 && String(m5.no || "") === no2), `需求 ${d5.qty} 单数 ${d5.docs}`);

    // ⑥ 健壮性
    const j6 = await getj("/api/req/last", tkA);
    C("⑥ 无 items 参数安全返回空（不 500）", j6.status === 200 && j6.json.ok === true && Object.keys(j6.json.map || {}).length === 0);
    const j7 = await getj(`/api/req/last?items=${encodeURIComponent(",,;  ,")}`, tkA);
    C("⑥b 垃圾入参安全返回", j7.status === 200 && j7.json.ok === true);
    const j8 = await getj(`/api/req/last?items=${PN}`, null);
    C("⑥c 未登录被拒（不发业务数据）", j8.status === 401 || j8.status === 403, "status=" + j8.status);
    C("★ 进程存活（端点未引入运行时错误）", (await fetch(BASE + "/api/health")).ok === true);
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
