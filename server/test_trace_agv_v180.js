// ㉖v180 全链路 AGV 任务错配修复验证（11-14 现场报告）
// 现象：N26K120106/03/05/02 零件档案货位正确，但"标签全链路"AGV 节点显示 11-13 的
//   AGV-20261113-0110~0113——那是邻框 N26K130198/01/97/00 的任务；真实搬运单是 11-12 的 0083~0086。
// 根因：框实际走 AGV 上架，但台账 mv 被后续人工登记覆盖成"人工" → agvTaskForCode 的
//   终点校验(epWant)失效，窗口塌成 [今天-2天,∞) 取 fin 最近一条 → 昨天的邻框任务顶掉自己的。
// 修复：epWant 未知但有物理锚点(流水/账本 t)时改走物理时序判据——接令∈[扫入-1min, 扫入+30min]
//   且完成≥扫入，多候选取完成最早；配不到=缺节点。mv=AGV 主路径与队列项盖章路径零改动。
// ★ 为什么必须真跑：错配逻辑在 server 进程内跑全库任务，静态 diff 只证了匹配函数；
//   /api/trace 的 AGV 节点装配（时间线文案、落位展示）要真实请求才验证得到。
// ★ 时效依赖：断言引用生产副本 11-12 任务 0083~0086，若任务沉淀清理策略改动使其消失，
//   预期从"错任务"变"缺节点"，届时本测试断言需同步（失败信息会提示）。
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const crypto = require("crypto");

const TDIR = path.join(__dirname, "_trace_v180");
const PORT = Number(process.env.TR_PORT || 8469);
const BASE = "http://127.0.0.1:" + PORT;
if (fs.existsSync(TDIR)) fs.rmSync(TDIR, { recursive: true, force: true });
fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(__dirname, "data", "db.json"), path.join(TDIR, "db.json"));
const sk = path.join(__dirname, "data", "secret.key");
if (fs.existsSync(sk)) fs.copyFileSync(sk, path.join(TDIR, "secret.key"));
// /api/trace 需登录（首轮实测 401"缺少登录凭证"→事件全空假失败）；生产 admin 密码现场已改不可借用，种独立测试账号
{
  const p = path.join(TDIR, "db.json");
  const d = JSON.parse(fs.readFileSync(p, "utf8"));
  const salt = crypto.randomBytes(16).toString("hex");
  d.users = (d.users || []).filter((u) => u.username !== "tr180");
  d.users.push({ id: "u_tr180", username: "tr180", name: "追踪测试", role: "admin", enabled: true, createdAt: Date.now(), mustChangePw: false, salt, passHash: crypto.scryptSync("Tr#Pass180", salt, 32).toString("hex") });
  fs.writeFileSync(p, JSON.stringify(d));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? "✅" : "❌"} ${n}${i !== undefined ? "  [" + i + "]" : ""}`); };

(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, "server.js")], { env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", DATA_DIR: TDIR }, stdio: ["ignore", "pipe", "pipe"] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + "/api/health")).ok; } catch (_) {} }
  if (!up) { console.log("❌ 实例未就绪"); srv.kill(); process.exit(1); }
  let out = ""; srv.stdout.on("data", (d) => { out += d; }); srv.stderr.on("data", (d) => { out += d; });
  try {
    const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, "db.json"), "utf8"));
    const tk = (db0.ledger || []).find((x) => String(x.c || "").toUpperCase() === "N26K120106") || {};
    C("护栏 副本含目标框且 mv=人工（错配前置条件成立）", String(tk.mv || "") === "人工", "mv=" + tk.mv + " l=" + tk.l);
    const lg = await fetch(BASE + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "tr180", password: "Tr#Pass180", dev: "TR", kind: "pda" }) });
    const lj = await lg.json().catch(() => ({}));
    const TOK = lj.token || "";
    C("护栏 测试账号登录成功（trace 需登录，首轮实测漏此全假失败）", !!TOK, "status=" + lg.status);
    if (!TOK) throw new Error("无法登录，后续 trace 全部无意义");

    const tr = async (code) => {
      const r = await fetch(BASE + "/api/trace?q=" + code, { headers: { Authorization: "Bearer " + TOK } });
      const j = await r.json().catch(() => ({}));
      const evs = (j.events || []).map((e) => JSON.stringify(e));
      return { status: r.status, j, evs };
    };

    // ① 四个错配框：AGV 节点必须等于各自真实任务，且不再是 11-13 邻框任务
    const CASES = [["N26K120106", "AGV-20261112-0083", "NB02-A-01-3F"], ["N26K120103", "AGV-20261112-0084", "NB02-B-09-1F"], ["N26K120105", "AGV-20261112-0085", "NB02-F-01-1F"], ["N26K120102", "AGV-20261112-0086", "NB02-F-02-1F"]];
    for (const [code, wantNo, wantEp] of CASES) {
      const { status, evs } = await tr(code);
      const hit = evs.find((e) => /AGV-2026/.test(e));
      C(`★★★ ${code} 全链路 AGV 节点=真实任务 ${wantNo}`, status === 200 && !!hit && hit.includes(wantNo), hit ? (hit.match(/AGV-2026\d+-\d+/) || ["?"])[0] : "无AGV节点");
      C(`  ${code} 落位=${wantEp}（与账本一致）`, !!hit && hit.includes(wantEp), "");
      const wrong = ["0110", "0111", "0112", "0113"].filter((n) => new RegExp("AGV-20261113-" + n).test(hit || ""));
      C(`  ${code} 不再显示 11-13 邻框任务`, wrong.length === 0, wrong.join(","));
    }

    // ② 主路径回归：mv=AGV 的框（终点校验在场）行为不变——任务号+落位与账本一致
    for (const [code, wantEp] of [["N26K130197", "NB02-C-07-3F"], ["N26K130198", "NB02-C-04-2F"]]) {
      const { evs } = await tr(code);
      const hit = evs.find((e) => /AGV-2026/.test(e));
      C(`★★ 主路径框 ${code} 不受影响（AGV 节点落位=${wantEp}）`, !!hit && hit.toUpperCase().includes(wantEp.toUpperCase()), hit ? (hit.match(/AGV-2026\d+-\d+/) || ["?"])[0] : "无AGV节点");
    }

    // ③ 防过度自信：无物理锚点站台且无队列项的框，宁缺毋滥不许抓任务
    const dbLed = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "db.json"), "utf8"));
    const noAnchor = (dbLed.ledger || []).map((x) => String(x.c || "").toUpperCase()).find((c) => {
      const sl = Object.values(dbLed.scanlog || {}).find((s) => String(s.code || "").toUpperCase() === c && !s.cx && Number(s.wt) === 0);
      const q = (dbLed.agvQueue || []).some((x) => String(x.code).toUpperCase() === c);
      return !q && !(sl && sl.st) && !((dbLed.ledger || []).find((x) => String(x.c || "").toUpperCase() === c) || {}).src;
    });
    if (noAnchor) {
      const { evs } = await tr(noAnchor);
      const hit = evs.find((e) => /"kind":"agv"/.test(e) && /AGV-2026\d+-\d+/.test(e));
      C(`③ 无锚点框 ${noAnchor} 宁缺毋滥（不配 AGV 节点）`, !hit, "AGV节点=" + (hit ? (hit.match(/AGV-2026\d+-\d+/) || ["?"])[0] : "无✓"));
    } else {
      C("③ 无锚点框样本", true, "副本中无此形态，跳过（非失败）");
    }
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
