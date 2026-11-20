// ㉖v203 整托多标签 AGV 盲盘 端到端验证
// 事故原型（11-20 现场截图实锤，工单会话 CS202611190776 / N26K080287）：
//   托 TP1795087752531 同零件双标签 N26K080287(100件)+N26K080278(100件)，账面合计 200；
//   工单只认主标签，仓管在 CK-11 扫兄弟标签 N26K080278 → 判 wrongBox「不符待处置」→ 只能取消，
//   AGV 整托白拉一趟。AGV 物理上整托叉取，工单粒度必须=托盘粒度。
// ★ 为什么必须真跑：①sibs 由 count/start 按 boxKeyOf(pid 优先) 实时算，静态看不出；
//   ②兄弟放行 / 外托拦截 / 数量按"扫到码自身账面"三条行为互斥，只有真实请求分别命中才算证明；
//   ③"同托另一标签再发起→合并为一张单"是新增控制流，必须真调两次 start；
//   ④存量旧单（无 sibs 字段）的账本回退兼容分支要真跑。
// ★ 状态构造约束：服务器每 120ms 落盘，运行中改 db.json 会被内存覆盖——所有中间态工单
//   一律在【启动前】写进夹具 db.json，scan/start 全部走真实 HTTP（不靠改文件推进状态）。
// ★ 时效依赖：夹具零件号 8894089988 与四个测试码，清理夹具需同步本文件。
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const crypto = require("crypto");

const TDIR = path.join(__dirname, "_sibs_v203");
const PORT = Number(process.env.SB_PORT || 8506);
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
const PW = "E2e#Sb!198";
db0.users.push({ id: "u_sb_wh", username: "sb_wh", name: "整托测试仓管", role: "warehouse", enabled: true, createdAt: Date.now(), mustChangePw: false, salt, passHash: hp(PW, salt) });
db0.params = Object.assign(db0.params || {}, { receivingOn: 0, reqHoursOn: 0 });

// ── 夹具账本：两托同构双标签 + 外托码 ──
//   托2 TPS198SIB：预置 4 张"已到台"工单，专供 ③④⑤⑥ 核对路径
//   托1 TPS198NEW：不预置任何工单，专供 ①② 发起/合并路径（否则 start 会撞上"已有在途单"分支）
const SIB_A = "N26QS180001A", SIB_B = "N26QS180001B", FOREIGN = "N26QS180099X";
const NEW_A = "N26QS180002A", NEW_B = "N26QS180002B";
const PN = "8894089988";
db0.ledger = (db0.ledger || []).filter((x) => U(x.p) !== PN && U(x.c) !== SIB_A && U(x.c) !== SIB_B && U(x.c) !== FOREIGN && U(x.c) !== NEW_A && U(x.c) !== NEW_B);
const L = (c, q, pid, slot) => ({ c, p: PN, n: "整托测试件", q, l: slot, f: "1800*1200_2", b: "2026-11-01", t: Date.now() - 12 * 864e5, mv: "登记", src: "TEST", pid });
db0.ledger.push(L(SIB_A, 100, "TPS198SIB", "NB02-A-11-1F"));
db0.ledger.push(L(SIB_B, 100, "TPS198SIB", "NB02-A-11-1F"));
db0.ledger.push(L(NEW_A, 120, "TPS198NEW", "NB02-A-12-1F"));
db0.ledger.push(L(NEW_B, 80, "TPS198NEW", "NB02-A-12-1F")); // 双标签件数不等（120/80），更贴近真实混托
db0.ledger.push(L(FOREIGN, 60, "TPS198OUT", "NB02-B-11-1F"));

// ── 启动前造好三张"已到台"工单（scan 端点只认 state=atStation/stuck，不依赖状态机推进）──
const now = Date.now();
const rec = (id, code, state, extra) => Object.assign({
  id, code, sid: "CSB198F", from: "NB02-A-11-1F", part: PN, nm: "整托测试件", f: "1800*1200_2",
  qty: 200, ageDays: 12, state, station: "NB02-CK-01", uid: "u_sb_wh", by: "整托测试仓管",
  at: now, updAt: now, arriveAt: now, taskNo: "", taskNo2: "", outQueued: 0, backQueued: 0, diff: null,
  sibs: [SIB_A, SIB_B],
}, extra || {});
db0.counts = [
  rec("cnt_main", SIB_A, "atStation"),      // ③ 扫主标签
  rec("cnt_sib", SIB_A, "atStation"),       // ④ 扫兄弟标签（事故复刻）
  rec("cnt_for", SIB_A, "atStation"),       // ⑤ 扫外托码（必须拦）
  rec("cnt_leg", SIB_A, "atStation", { sibs: undefined }), // ⑥ 存量旧单：无 sibs 字段
];
delete db0.counts[3].sibs;
fs.writeFileSync(path.join(TDIR, "db.json"), JSON.stringify(db0));

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
    const tk = (await post("/api/login", null, { username: "sb_wh", password: PW, dev: "SB", kind: "pda" })).json.token;
    C("护栏 仓管登录 + 夹具同托双标签（各100件/合计200）", !!tk);
    if (!tk) throw new Error("无法登录");

    // ① 发起（第二托，无预置工单）：整托带兄弟码，账面=全托合计 120+80=200
    const s1 = await post("/api/count/start", tk, { codes: [NEW_A], pickBatch: "CSB198NEW" });
    const r1 = ((s1.json.list || [])[0] || {});
    C("★★★ 发起工单带整托兄弟码 sibs=[A,B]，账面=合计 200", s1.json.ok === true && r1.code === NEW_A && (r1.sibs || []).length === 2 && r1.qty === 200, `sibs=${JSON.stringify(r1.sibs)} qty=${r1.qty}`);
    const recId = r1.id;

    // ② 同托另一标签再发起：整托一单已覆盖该标签 → 幂等成功并指向同一张单（不得报"失败"迷惑现场）
    const s2 = await post("/api/count/start", tk, { codes: [NEW_B], pickBatch: "CSB198NEW" });
    const o2 = (s2.json.out || [])[0] || {};
    C("★★★ 同托另一标签再发起=幂等成功并指向同一单（不建二单、不误报失败）", o2.ok === true && o2.id === recId && String(o2.msg || "").includes("整托一单"), JSON.stringify(o2).slice(0, 90));

    // ③ 扫主标签：数量按主标签自身账面 100 比对（旧口径拿全托 200 比 → MES 回 100 必假不符）
    const m1 = await post("/api/count/scan", tk, { id: "cnt_main", barcode: SIB_A, mesQty: 100 });
    C("★★★ 扫主标签 MES100 核对相符（按本标签账面 100，不再误比全托 200）", m1.json.ok === true && m1.json.match === true && m1.json.qtyOk === true, `match=${m1.json.match} qtyOk=${m1.json.qtyOk}`);

    // ④ 事故复刻：扫兄弟标签必须核对通过 + 留痕（工单实况走 GET list 端点读，不读被内存托管的文件）
    const m2 = await post("/api/count/scan", tk, { id: "cnt_sib", barcode: SIB_B, mesQty: 100 });
    const rl = await getj("/api/count/list?all=1", tk);
    const recSib = (((rl.json || {}).list) || []).find((x) => x.id === "cnt_sib") || {};
    C("★★★ 扫兄弟标签不再判 wrongBox（截图事故单场景已修复）", m2.json.ok === true && m2.json.match === true && recSib.state === "scanned", `state=${recSib.state} diff=${JSON.stringify(recSib.diff)}`);
    C("★★ 兄弟标签核对留痕 scannedLabel，事后可追溯", recSib.scannedLabel === SIB_B, `scannedLabel=${recSib.scannedLabel}`);
    C("④b 兄弟标签归位落点仍钉死原格（sibs 不影响 from）", recSib.from === "NB02-A-11-1F", `from=${recSib.from}`);

    // ⑤ 真外托码必须拦住（防"台上压着别的托却被判盘到"）
    const m3 = await post("/api/count/scan", tk, { id: "cnt_for", barcode: FOREIGN, mesQty: 60 });
    const rl2 = await getj("/api/count/list?all=1", tk);
    const recFor2 = (((rl2.json || {}).list) || []).find((x) => x.id === "cnt_for") || {};
    C("★★★ 兄弟集外码仍判串位 wrongBox（拦截能力不退化）", m3.json.ok === true && m3.json.match === false && (recFor2.diff || {}).kind === "wrongBox", `match=${m3.json.match} kind=${(recFor2.diff || {}).kind}`);

    // ⑥ 存量旧单（无 sibs 字段）：按账本实时回退，兄弟码同样放行（升级窗口不炸现场）
    const m4 = await post("/api/count/scan", tk, { id: "cnt_leg", barcode: SIB_B, mesQty: 100 });
    C("★★ 存量旧单（无 sibs）经账本回退仍认兄弟标签", m4.json.ok === true && m4.json.match === true, `match=${m4.json.match}`);

    C("★ 进程存活", (await fetch(BASE + "/api/health")).ok === true);
  } catch (e) {
    total++; fail++; console.log("❌ 异常：" + e.message + "\n" + String(out).split("\n").slice(-12).join("\n"));
  } finally {
    srv.kill(); await sleep(500);
    try { fs.rmSync(TDIR, { recursive: true, force: true }); } catch (_) {}
  }
  console.log("\n结果: " + (total - fail) + " 通过 / " + fail + " 失败  （隔离副本，生产库零写入）");
  process.exit(fail ? 1 : 0);
})();
