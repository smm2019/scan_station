// ㉖v170 请求路径归一化验证（旧版 App 点「检查更新」报「接口不存在」）
// 现场现象：旧版 APK 设置页点检查更新 → 提示「接口不存在」。
// 根因（两层，只治一层没用——我第一次只改了 pathname，实测仍 404）：
//   ① PDA 绝大多数接口走 app_auth._req，那里有 base.replace(/\/+$/,'') 剥地址末尾斜杠；
//      唯独升级检查 update_page 是裸拼 "$server/api/app/version" 的 http.get，不过那道保护。
//      服务器地址被存成带末尾斜杠（http://10.96.7.1:8099/）时，请求行变成 //api/app/version。
//   ② new URL("//api/app/version","http://x") 把它当【协议相对 URL】：
//      host 被吃掉变成 "api"、pathname 只剩 "/app/version" —— 接口名在 URL 解析阶段就丢了，
//      所以事后对 pathname 做归一化根本救不回来，必须先折叠原始请求行再交给 URL。
//   本文件全部路由是 p === '/api/xxx' 精确匹配，一个都不中 → 落到兜底 404{msg:'接口不存在'}。
// 修复位置：handleReq 入口对原始 req.url 折叠重复斜杠（旧版 APK 无需升级即自愈）。
// 本测试同时锁住两件事：修复真生效 + 归一化没有误伤（query / 尾斜杠 / 静态页 / 无路径穿越）。
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const crypto = require("crypto");

const TDIR = path.join(__dirname, "_urlnorm_v170");
const PORT = 8391;
const BASE = "http://127.0.0.1:" + PORT;
if (fs.existsSync(TDIR)) fs.rmSync(TDIR, { recursive: true, force: true });
fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(__dirname, "data", "db.json"), path.join(TDIR, "db.json")); // 服务端读 DATA_DIR 根
const sk = path.join(__dirname, "data", "secret.key");
if (fs.existsSync(sk)) fs.copyFileSync(sk, path.join(TDIR, "secret.key"));

const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, "db.json"), "utf8"));
const salt = crypto.randomBytes(16).toString("hex");
const hp = (p, s) => crypto.scryptSync(String(p), s, 32).toString("hex");
db0.users.push({ id: "u_un", username: "urlnorm", name: "归一验证", role: "warehouse", enabled: true, createdAt: Date.now(), mustChangePw: false, salt, passHash: hp("E2e#Un!170", salt) });
db0.rcsConfig = null; db0.wmasConfig = null; db0.agvQueue = [];
fs.writeFileSync(path.join(TDIR, "db.json"), JSON.stringify(db0));
// 造已发布 APK 清单：必须让 has=true 且带 build，否则"接口通了"和"读到业务数据"分不清
const appDir = path.join(TDIR, "app");
fs.mkdirSync(appDir, { recursive: true });
fs.writeFileSync(path.join(appDir, "v170.apk"), "x".repeat(4096));
fs.writeFileSync(path.join(appDir, "version.json"), JSON.stringify({ version: "1.0.0", build: 170, file: "v170.apk", at: new Date().toISOString() }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? "✅" : "❌"} ${n}${i !== undefined ? "  [" + i + "]" : ""}`); };

(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, "server.js")], { env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", DATA_DIR: TDIR }, stdio: ["ignore", "pipe", "pipe"] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + "/api/health")).ok; } catch (_) {} }
  if (!up) { console.log("❌ 实例未就绪"); srv.kill(); process.exit(1); }
  try {
    const lg = await (await fetch(BASE + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "urlnorm", password: "E2e#Un!170", dev: "UN-1", kind: "pda" }) })).json();
    const tk = lg.token;
    // ★防假绿护栏1：登录不成立则后面全是空过（本项目踩过 401 继续跑的坑）
    if (!tk) { console.log("❌ 登录失败，终止不产出结论 " + JSON.stringify(lg).slice(0, 140)); srv.kill(); process.exit(1); }
    console.log("✅ 登录成功（护栏1）");
    const H = { Authorization: "Bearer " + tk };
    const g = async (pp) => { const r = await fetch(BASE + pp, { headers: H }); let t = ""; try { t = JSON.stringify(await r.json()); } catch (_) { t = "<non-json>"; } return { s: r.status, t }; };

    // 护栏2：先证明"正常路径"读到业务数据（否则下面"双斜杠也一致"会因两边都空而恒真）
    const a = await g("/api/app/version");
    C("护栏2 正常路径 200 且读到 build=170（业务真的走通了）", a.s === 200 && /"build":170/.test(a.t) && /"has":true/.test(a.t), a.s + " " + a.t.slice(0, 50));

    console.log("\n--- 【核心】旧版裸拼产生的双斜杠 ---");
    const b = await g("//api/app/version");
    const c = await g("///api/app/version");
    console.log("   双斜杠 " + b.s + " " + b.t.slice(0, 56));
    console.log("   三斜杠 " + c.s + " " + c.t.slice(0, 56));
    C("★★ 双斜杠不再报「接口不存在」", b.s === 200 && !/接口不存在/.test(b.t), b.s);
    C("★★ 双斜杠业务数据与正常完全一致（证明走的是同一个处理分支）", b.t === a.t);
    C("★★★ 三斜杠同样修复", c.s === 200 && !/接口不存在/.test(c.t), c.s);
    const d = await g("//api/counts");
    C("★ 其它接口同样受益（双斜杠 /api/counts 可用）", d.s === 200 && !/接口不存在/.test(d.t), d.s);
    const e = await fetch(BASE + "//api/app/download", { headers: H });
    C("★ 下载接口同样修复（旧版下载也会 404）", e.status === 200, e.status);

    console.log("\n--- 【不能误伤 1】query 必须原样保留 ---");
    const oneLed = (db0.ledger || [])[0] || {};
    const q1 = await g("/api/ledger?c=" + encodeURIComponent(oneLed.c || ""));
    const q2 = await g("//api/ledger?c=" + encodeURIComponent(oneLed.c || ""));
    C("★ 双斜杠 + query 过滤结果与正常一致（query 没被吃掉）", q1.s === 200 && q2.s === 200 && q1.t === q2.t && /"count":1/.test(q2.t), "正常count=" + (q1.t.match(/"count":(\d+)/) || [])[1] + " 双斜杠count=" + (q2.t.match(/"count":(\d+)/) || [])[1]);
    const lim = await g("//api/scanlog?limit=3");
    C("★★ 双斜杠下 limit 仍生效（返回 3 条而非全量数千条）", (() => { try { return JSON.parse(lim.t).items.length === 3; } catch (_) { return false; } })(), ((JSON.parse(lim.t).items || []).length) + " 条");

    console.log("\n--- 【不能误伤 2】尾斜杠形态的路由与静态页 ---");
    for (const pp of ["/console", "/console/", "/agvmap"]) {
      const r = await fetch(BASE + pp);
      const tx = await r.text();
      C("  " + pp + " 静态页仍正常", r.status === 200 && tx.includes("<"), r.status);
    }
    const dblConsole = await fetch(BASE + "//console//");
    C("  //console// 归一后可访问", dblConsole.status === 200, dblConsole.status);
    // 服务端【本来就没有 "/" 根路由】（已用 HEAD 版本实测对照：/ 同样 404，/console 才 200）。
    // 这里只确认归一化没把它变成 500 或意外 200，不假设首页存在。
    const home = await fetch(BASE + "/");
    C("  首页 / 行为与归一化前一致（本就 404，未变 500/200）", home.status === 404, home.status);

    console.log("\n--- 【安全】归一化不得制造路径穿越可达面 ---");
    for (const evil of ["/..%2f..%2fserver.js", "//..%2f..%2fserver.js", "/%2e%2e/%2e%2e/server.js", "//api/../app/version.json"]) {
      const r = await fetch(BASE + evil);
      const tx = await r.text();
      C("  " + evil.slice(0, 30) + " 未泄露源码", !/createServer|require\(|scryptSync/.test(tx), r.status);
    }
    // 注：未知路径由管理员闸门先返回 403「需要管理员权限」，与斜杠无关（无双斜杠的同形路径也是 403），
    //     故这里不断言 404，只确认归一化没把未知路径变成 200。
    const unk1 = await g("/api/definitely-not-here-xyz");
    const unk2 = await g("//api/definitely-not-here-xyz");
    C("★★ 未知路径未被归一化误放行成 200（斜杠前后行为一致）", unk1.s !== 200 && unk2.s !== 200 && unk1.s === unk2.s, "无斜杠 " + unk1.s + " / 双斜杠 " + unk2.s);

    console.log("\n--- 【回归】正常接口未被破坏 ---");
    for (const pp of ["/api/counts", "/api/me", "/api/sysstatus"]) {
      const r = await g(pp);
      C("  " + pp + " 仍 200", r.s === 200, r.s);
    }
    const led = await g("/api/ledger?l=");
    C("  账本查询仍正常（>500 行）", led.s === 200 && (JSON.parse(led.t).total || 0) > 500, JSON.parse(led.t).total);
  } catch (e) {
    total++; fail++; console.log("❌ 异常：" + e.message + "\n" + (e.stack || "").split("\n").slice(0, 3).join("\n"));
  } finally {
    srv.kill(); await sleep(400);
    if (process.env.KEEP_TDIR !== "1") { try { fs.rmSync(TDIR, { recursive: true, force: true }); } catch (_) {} }
  }
  console.log("\n结果: " + (total - fail) + " 通过 / " + fail + " 失败  （隔离副本，生产库零写入）");
  process.exit(fail ? 1 : 0);
})();
