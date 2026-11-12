// ㉖v167 重复入库源头防重 · 真实 HTTP 端到端（复刻 11-12 现场 N26K120114 事故链）
// 与 test_dup_source_v167.js（静态抽函数）互补：本套件起隔离 server 实例（独立 DATA_DIR + 合成 V167 标签
// + 断开 RCS/WMAS 外部连接），走真实 /api/label/check → /api/label/force → /api/scanlog/sync → /api/ledger/sync，
// 验证三件事：①原因门槛真在服务端生效 ②取代只在账本落账后兑现 ③作废能经 cxKept 回写 PDA 本机（不留双记录）。
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const crypto = require("crypto");

const SRC = path.join(__dirname, "data");
const TDIR = path.join(__dirname, "data_e2e_dup_v167");
const PORT = 8371;
const BASE = "http://127.0.0.1:" + PORT;
if (!fs.existsSync(TDIR)) fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(SRC, "db.json"), path.join(TDIR, "db.json"));
fs.copyFileSync(path.join(SRC, "secret.key"), path.join(TDIR, "secret.key"));

const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, "db.json"), "utf8"));
const salt = crypto.randomBytes(16).toString("hex");
const hashPw = (pw, s) => crypto.scryptSync(String(pw), s, 32).toString("hex");
const now = Date.now();
db0.users.push({ id: "u_v167_w", username: "v167_wh", name: "V167仓管", role: "warehouse", enabled: true, createdAt: now, mustChangePw: false, salt, passHash: hashPw("E2e#V167!w", salt) });
// 事故复现条件：来料区按生产现值关闭（receivingOn=0），避免首扫被一楼登记闸拦住干扰本测试主线
db0.params = Object.assign(db0.params || {}, { receivingOn: 0 });
// 隔离：断开外部系统——副本带着生产的 RCS/WMAS 地址，实例一起步就会向真实调度系统发请求（会挤对方会话）
db0.rcsConfig = null; db0.wmasConfig = null; db0.rcsStations = {}; db0.agvQueue = [];
// 腾出测试格位：副本带着生产真实账本，NB03-H-09-05/06 实际已被 N26K120114 等真实框占用，
// 合成标签推这两格会被货位冲突闸正确拒收（闸拒得对），账本不写入 → 取代凭证无从兑现
// （上一版端到端 7 组连锁假失败正是这个原因，不是防重逻辑缺陷）。
// 只在【副本】里清掉本测试要用的 H-09 排；真实库分毫不动，被测逻辑也不受影响。
const TEST_PREFIX = "NB03-H-09-";
db0.ledger = (db0.ledger || []).filter((x) => !String(x.l || "").toUpperCase().startsWith(TEST_PREFIX));
for (const k of Object.keys(db0.scanlog || {})) { if (String((db0.scanlog[k] || {}).gl || "").toUpperCase().startsWith(TEST_PREFIX)) delete db0.scanlog[k]; }
fs.writeFileSync(path.join(TDIR, "db.json"), JSON.stringify(db0));

const CODE = "V167BOX0001";
const CODE2 = "V167BOX0002";
const K_OLD = CODE + "|B261112-1441|" + (now - 600000);
const K_NEW = CODE + "|B261112-1449|" + now;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const chk = (n, g, w) => { total++; const okv = JSON.stringify(g) === JSON.stringify(w); if (!okv) fail++; console.log(`${okv ? "PASS" : "FAIL!"} [${n}] got=${JSON.stringify(g)} want=${JSON.stringify(w)}`); };
const chkT = (n, c, info) => { total++; if (!c) fail++; console.log(`${c ? "PASS" : "FAIL!"} [${n}]${info !== undefined ? " " + JSON.stringify(info) : ""}`); };
async function post(p2, tk, body) { const r = await fetch(BASE + p2, { method: "POST", headers: { "Content-Type": "application/json", ...(tk ? { Authorization: "Bearer " + tk } : {}) }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; }
async function get(p2, tk) { const r = await fetch(BASE + p2, { headers: tk ? { Authorization: "Bearer " + tk } : {} }); return { status: r.status, json: await r.json().catch(() => ({})) }; }
// 流水推送（与 PDA scanPushNow 同构：k=标签|批次|扫码毫秒）
const pushFlow = (tk, list) => post("/api/scanlog/sync", tk, {
  items: list.map((e) => ({ k: e.k, code: e.k.split("|")[0], wt: 1, gl: e.gl, batch: e.k.split("|")[1], t: Number(e.k.split("|")[2]), pn: e.pn || "66V167PX01", q: 30, nm: e.nm || "V167测试框", op: "V167仓管", cx: !!e.cx, cxAt: e.cxAt || 0, lot: "2026-11-12" })),
});
// 账本推送（与 PDA ledgerPushNow 同构）
const pushLedger = (tk, it) => post("/api/ledger/sync", tk, { items: [{ c: it.code || CODE, l: it.l, q: it.q || 30, t: it.t, p: it.pn || "66V167PX01", n: it.nm || "V167测试框", b: "2026-11-12", f: "托盘", mv: "人工", src: "H9", by: "V167仓管" }] });
const flowOf = async (tk, k) => ((await get("/api/scanlog?limit=30000", tk)).json.items || []).find((x) => (String(x.code).toUpperCase() + "|" + x.batch + "|" + x.t) === k);
const ledgerOf = async (tk, code) => ((await get("/api/ledger?c=" + code, tk)).json.items || []).filter((x) => String(x.c).toUpperCase() === code);
// 生产库基线（本测试不该改变它）：有效流水条数。
// 不用 mtime 当判据——生产服务本身在跑就会周期性存盘，时间戳会变，那是与本测试无关的假失败。
const prodLive0 = Object.values((JSON.parse(fs.readFileSync(path.join(SRC, "db.json"), "utf8")).scanlog) || {}).filter((x) => !x.cx).length;

(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, "server.js")], { env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", DATA_DIR: TDIR }, stdio: ["ignore", "pipe", "pipe"] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { const r = await fetch(BASE + "/api/health"); up = r.ok; } catch (_) {} }
  if (!up) { console.log("FAIL! 隔离实例未就绪"); srv.kill(); process.exit(1); }
  console.log("隔离实例就绪 (PORT " + PORT + ") —— v167 重复入库源头防重端到端");
  try {
    const wh = (await post("/api/login", null, { username: "v167_wh", password: "E2e#V167!w" })).json.token;

    // ===== 1. 首次录入正常（不该有任何拦截） =====
    const chk0 = await get("/api/label/check?c=" + CODE, wh);
    chkT("1a 全新标签不拦", chk0.json.blockIn !== true, { blockIn: chk0.json.blockIn });
    const pf1 = await pushFlow(wh, [{ k: K_OLD, gl: "NB03-H-09-04" }]);
    chkT("1b 首扫流水入库", pf1.json.ok === true);
    const pl1 = await pushLedger(wh, { l: "NB03-H-09-04", t: now - 590000 });
    chkT("1c 首扫账本入账", pl1.json.ok === true && (pl1.json.added || 0) === 1, { added: pl1.json.added });

    // ===== 2. 重扫必被拦（与旧版一致，未削弱） =====
    const chk1 = await get("/api/label/check?c=" + CODE, wh);
    chkT("2a 重扫 blockIn=true", chk1.json.blockIn === true);
    chkT("2b 提示含货位与登记人", /NB03-H-09-04/.test(chk1.json.reason || "") && /V167仓管/.test(chk1.json.reason || ""), { reason: (chk1.json.reason || "").slice(0, 60) });

    // ===== 3. 原因门槛（现场那次就是填「1」过的） =====
    const f1 = await post("/api/label/force", wh, { code: CODE, why: "1" });
    chkT("3a 现场原文「1」被服务端 400 拒绝", f1.status === 400 && f1.json.ok === false, { status: f1.status, msg: (f1.json.msg || "").slice(0, 26) });
    const f2 = await post("/api/label/force", wh, { code: CODE, why: "。。。。。。" });
    chkT("3b 长串纯符号被拒（绕长度无效）", f2.status === 400 && /不能只填数字/.test(f2.json.msg || ""), (f2.json.msg || "").slice(0, 22));
    const f3 = await post("/api/label/force", wh, { code: CODE, why: "测试" });
    chkT("3c 历史真实原因「测试」被拒", f3.status === 400);

    // ===== 4. 门槛拒绝期间，旧流水绝不被动摇 =====
    const old4 = await flowOf(wh, K_OLD);
    chkT("4a 被拒后旧流水仍有效（唯一事实未受损）", !!old4 && old4.cx === false);

    // ===== 5. 写清真原因 → 放行并登记取代凭证 =====
    const f5 = await post("/api/label/force", wh, { code: CODE, why: "位置录错，实物实际在H-09-05格位" });
    chkT("5a 真原因放行", f5.status === 200 && f5.json.ok === true);
    chk("5b 返回待作废旧流水数", f5.json.supersedePending, 1);

    // ===== 6. 只重扫流水、账本还没落账 → 不得提前作废（否则中途放弃就新旧都没了） =====
    const pf2 = await pushFlow(wh, [{ k: K_NEW, gl: "NB03-H-09-05" }]);
    chkT("6a 新扫流水入库", pf2.json.ok === true);
    const old6 = await flowOf(wh, K_OLD);
    chkT("6b 账本未落账时旧流水仍有效（不提前作废）", !!old6 && old6.cx === false);

    // ===== 7. 账本真正落账 → 兑现取代 =====
    const pl2 = await pushLedger(wh, { l: "NB03-H-09-05", t: now });
    chkT("7a 新货位账本落账", pl2.json.ok === true && ((pl2.json.updated || 0) + (pl2.json.added || 0)) >= 1, { updated: pl2.json.updated, added: pl2.json.added });
    const old7 = await flowOf(wh, K_OLD);
    const new7 = await flowOf(wh, K_NEW);
    chkT("7b 旧流水已自动作废", !!old7 && old7.cx === true);
    chkT("7c 本次新流水保持有效", !!new7 && new7.cx === false);
    const led7 = await ledgerOf(wh, CODE);
    chk("7d 账本仍只一行（未重复计框）", led7.length, 1);
    chk("7e 账本件数仍 30（未翻倍）", led7.length ? led7[0].q : null, 30);
    chk("7f 账本货位以本次为准", led7.length ? String(led7[0].l) : null, "NB03-H-09-05");

    // ===== 8. PDA 旧缓存回灌 → 必须被压回，并经 cxKept 回写本机（否则 app 列表仍显示两条正常） =====
    const pf3 = await pushFlow(wh, [{ k: K_OLD, gl: "NB03-H-09-04", cx: false, cxAt: 0 }]);
    chk("8a 旧流水键经 cxKept 回传供本机回写作废态", pf3.json.cxKept, [[K_OLD, true]]);
    const old8 = await flowOf(wh, K_OLD);
    chkT("8b 旧缓存回灌未能复活作废态", !!old8 && old8.cx === true);
    const live9 = ((await get("/api/scanlog?limit=30000", wh)).json.items || []).filter((x) => String(x.code).toUpperCase() === CODE && !x.cx);
    chk("8c 该框有效流水全库只剩 1 条（事故目标达成）", live9.length, 1);

    // ===== 9. 留痕齐全（可追溯）——服务端没有 /api/ops HTTP 接口，留痕按天写 DATA_DIR/ops/*.jsonl =====
    const opsDir = path.join(TDIR, "ops");
    let acts = [];
    if (fs.existsSync(opsDir)) {
      const lines = [];
      for (const f of fs.readdirSync(opsDir)) if (/\.jsonl$/.test(f)) lines.push(...fs.readFileSync(path.join(opsDir, f), "utf8").trim().split("\n").filter(Boolean));
      acts = lines.map((l) => { try { const o = JSON.parse(l); return (o.act || "") + "|" + (o.obj || ""); } catch (_) { return ""; } });
    }
    chkT("9a 强过被拒也留痕（拒绝不是无痕）", acts.some((a) => /^重复标签强过被拒\|/.test(a)), acts.filter((a) => /强过被拒/.test(a)).slice(0, 1));
    chkT("9b 强过放行留痕", acts.some((a) => /^重复标签强过\|/.test(a)));
    chkT("9c 取代兑现留痕", acts.some((a) => /^重复入库取代\|/.test(a)), acts.filter((a) => /^重复入库取代/.test(a)).slice(0, 1));

    // ===== 10. 强过后放弃：不推账本，旧流水必须原样保留（可继续正常作业） =====
    const K2_OLD = CODE2 + "|B261112-1441|" + (now - 300000);
    await pushFlow(wh, [{ k: K2_OLD, gl: "NB03-H-09-06", pn: "66V167PX02", nm: "V167测试框2" }]);
    await pushLedger(wh, { code: CODE2, l: "NB03-H-09-06", t: now - 290000, pn: "66V167PX02", nm: "V167测试框2" });
    const f10 = await post("/api/label/force", wh, { code: CODE2, why: "临时改主意，稍后再处理" });
    chkT("10a 第二框真原因放行", f10.json.ok === true);
    await pushFlow(wh, [{ k: CODE2 + "|B261112-1500|" + (now + 1000), gl: "NB03-H-09-07", pn: "66V167PX02", nm: "V167测试框2" }]); // 故意不再推账本
    const old10 = await flowOf(wh, K2_OLD);
    chkT("10b 未落账则旧流水不被作废（放弃不毁数据）", !!old10 && old10.cx === false);

    // ===== 11. 写入确实落在隔离副本（生产库零污染） =====
    // 不用"生产库 mtime 没变"当判据：生产服务本身在跑就会周期性存盘，那会造成与本测试无关的假失败。
    // 改用正向证明——本次全部写入都进了 DATA_DIR 副本，且生产库不含任何 V167 痕迹。
    // 副本落盘是异步的（save 防抖），轮询等待最多 8 秒，避免"还没写完"被误判成"没写到副本"
    let copyTxt = "";
    for (let i = 0; i < 32; i++) {
      copyTxt = fs.existsSync(path.join(TDIR, "db.json")) ? fs.readFileSync(path.join(TDIR, "db.json"), "utf8") : "";
      if (copyTxt.includes(CODE) && copyTxt.includes(CODE2)) break;
      await sleep(250);
    }
    chkT("11a 隔离副本确实被写入（含 V167 合成标签）", copyTxt.includes(CODE) && copyTxt.includes(CODE2));
    const prodTxt = fs.readFileSync(path.join(SRC, "db.json"), "utf8");
    chkT("11b 生产库无 V167 合成标签", !prodTxt.includes(CODE) && !prodTxt.includes(CODE2));
    chkT("11c 生产库无 V167 取代凭证", !(JSON.parse(prodTxt).supersede || {})[CODE]);
    chkT("11d 生产库有效流水条数未因本测试变化", JSON.parse(prodTxt).scanlog ? Object.values(JSON.parse(prodTxt).scanlog).filter((x) => !x.cx).length : 0, prodLive0);
  } catch (e) {
    total++; fail++; console.log("FAIL! 异常：" + e.message + "\n" + (e.stack || "").split("\n").slice(0, 4).join("\n"));
  } finally {
    srv.kill();
    await sleep(300);
    try { fs.rmSync(TDIR, { recursive: true, force: true }); } catch (_) {}
  }
  console.log("\n结果: " + (total - fail) + " PASS / " + fail + " FAIL  （隔离副本，生产库零写入）");
  process.exit(fail ? 1 : 0);
})();
