// ㉖v171 第0层①：代码身份可观测验证
// 要证明的不是"字段存在"，而是一条真实能力：改了代码但没重启 → 必须报警。
// 全程在隔离副本目录起真实实例（独立端口 + 独立 DATA_DIR），绝不触碰生产库与生产进程。
// ★ 真机模拟手法：把 server.js 连同 data 副本放进 TDIR 后启动，之后【改动 TDIR 里那份
//   server.js】再打 /api/health ——服务进程不变、磁盘文件变新，正是"改完码忘了重启"的
//   真实形态（这也是本层要消灭的那个事故形态：11-12 health 启动 20:01、文件改于 21:46，
//   但旧接口上完全看不出来）。
const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const TDIR = path.join(__dirname, "_hvid_v171");
const PORT = 8395;
const BASE = "http://127.0.0.1:" + PORT;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? "✅" : "❌"} ${n}${i !== undefined ? "  [" + i + "]" : ""}`); };
const gh = async () => { try { return await (await fetch(BASE + "/api/health")).json(); } catch (e) { return {}; } };

(async () => {
  if (fs.existsSync(TDIR)) fs.rmSync(TDIR, { recursive: true, force: true });
  fs.mkdirSync(TDIR, { recursive: true });
  fs.copyFileSync(path.join(__dirname, "server.js"), path.join(TDIR, "server.js")); // 副本自身=被测对象
  fs.mkdirSync(path.join(TDIR, "data"), { recursive: true });
  fs.copyFileSync(path.join(__dirname, "data", "db.json"), path.join(TDIR, "data", "db.json"));
  const sk = path.join(__dirname, "data", "secret.key");
  if (fs.existsSync(sk)) fs.copyFileSync(sk, path.join(TDIR, "data", "secret.key"));
  const localFile = path.join(TDIR, "server.js");

  const srv = cp.spawn(process.execPath, [localFile], { env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", DATA_DIR: path.join(TDIR, "data") }, stdio: ["ignore", "pipe", "pipe"] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + "/api/health")).ok; } catch (_) {} }
  try {
    if (!up) throw new Error("实例未就绪，后续断言无意义");
    console.log("--- 【护栏】原有字段必须一个都没动（PDA 失联检测/网页健康分在读）---");
    const h0 = await gh();
    C("ok/uptime/serverTime/memMB 仍存在", h0.ok === true && typeof h0.uptime === "number" && !!h0.serverTime && typeof h0.memMB === "number");
    C("netmap 结构未变（lands/edges/ready/builtAgo）", h0.netmap && typeof h0.netmap.lands === "number" && "ready" in h0.netmap && "builtAgo" in h0.netmap);
    C("counts 结构未变（reqs/scanlog/outbound/queue/sessions）", h0.counts && typeof h0.counts.reqs === "number" && typeof h0.counts.scanlog === "number" && typeof h0.counts.sessions === "number");
    C("memMB 仍是正常 MB 量级（我编辑时一度写复杂，还原后复核）", h0.memMB >= 1 && h0.memMB < 100000, h0.memMB);
    C("★未新增鉴权：health 依旧无 token 可访问（第0层要的就是随手可查）", h0.ok === true);

    console.log("\n--- 【核心能力】改了代码没重启，必须报警 ---");
    const a = await gh();
    C("① 刚启动（磁盘=内存）→ codeMismatch=false，不误报", a.code && a.code.codeMismatch === false, "sha=" + (a.code || {}).codeSha);
    C("② 身份字段齐全（sha/bytes/startedAt/diskMtime）", a.code && /^[0-9a-f]{12}$/.test(a.code.codeSha) && a.code.codeBytes > 100000 && !!a.code.startedAt && !!a.code.diskMtime, JSON.stringify(a.code && { sha: a.code.codeSha, bytes: a.code.codeBytes }));
    C("③ 启动时刻与现在相差 < 5 分钟（startedAt 真实）", a.code && Math.abs(Date.now() - Date.parse(a.code.startedAt)) < 300000, Math.round((Date.now() - Date.parse(a.code.startedAt)) / 1000) + "s");

    // 真机模拟"改完代码忘了重启"：改动磁盘副本，进程不动
    await sleep(1100); // mtime 秒级精度，隔开避免与启动时刻同秒导致漏判
    fs.appendFileSync(localFile, "\n// 模拟一次未重启的代码改动\n");
    const b = await gh();
    C("★★ ④ 磁盘已变新 → codeMismatch=true（这条就是第0层的全部价值）", b.code && b.code.codeMismatch === true, "mismatch=" + (b.code || {}).codeMismatch);
    C("⑤ 未重启时仍能读出磁盘新大小与旧内存大小可对比", b.code && b.code.diskBytes > b.code.codeBytes, "内存" + (b.code || {}).codeBytes + " → 磁盘" + (b.code || {}).diskBytes);
    C("⑥ 报警不影响服务正常工作（health 仍 200 且 ok）", b.ok === true && typeof b.uptime === "number");

    console.log("\n--- 【稳定性】重复启动身份一致、判据不抖动 ---");
    const shaA = (await gh()).code.codeSha;
    srv.kill(); await sleep(600);
    // 还原副本后重启：应回到 false（证明不是单向棘轮、不会一旦报警就永久红）
    fs.copyFileSync(path.join(__dirname, "server.js"), localFile);
    const srv2 = cp.spawn(process.execPath, [localFile], { env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", DATA_DIR: path.join(TDIR, "data") }, stdio: ["ignore", "pipe", "pipe"] });
    let up2 = false; for (let i = 0; i < 40 && !up2; i++) { await sleep(250); try { up2 = (await fetch(BASE + "/api/health")).ok; } catch (_) {} }
    if (!up2) throw new Error("重启未就绪");
    const c1 = await gh();
    C("★★ ⑦ 重启后 codeMismatch 恢复 false（不会误报成长期红灯）", c1.code && c1.code.codeMismatch === false);
    C("★ ⑧ 同一份代码哈希稳定（sha 可当版本身份用）", c1.code.codeSha === shaA, shaA + " vs " + c1.code.codeSha);
    srv.kill(); await sleep(400);
  } catch (e) {
    total++; fail++; console.log("❌ 异常：" + e.message + "\n" + (e.stack || "").split("\n").slice(0, 3).join("\n"));
    try { srv.kill(); } catch (_) {}
  } finally {
    try { fs.rmSync(TDIR, { recursive: true, force: true }); } catch (_) {}
  }
  console.log("\n结果: " + (total - fail) + " 通过 / " + fail + " 失败  （隔离副本，生产库与生产进程零接触）");
  process.exit(fail ? 1 : 0);
})();
