// ㉖v168 历史重复有效流水清理（默认演练+出清单，加 --apply 才写库）
// 为什么不用网页「作废流水」：/api/scanlog/cancel 的作废分支会连带【整框消账】（cur.delete + 打墓碑），
//   对仍在架的框等于把实物从账上抹掉。本次 9 组里 3 组框还在账，走那条路会直接消架。
// 也不用 /api/scanlog/delete：它按【批次整批删】，同批次其他框会被一起删。
// 本脚本只把清单指定的流水键标 cx=true + cxB/cxA，不碰账本/seenIn/墓碑——与 v167 同一安全边界。
// 写 cxA 是为压住 PDA 回灌：本机 Isar 里这些行仍是"正常"，v122「新者胜」按 cxA>t 压回。
// 键一律从库里现算，不手写（上一版手写毫秒值有 8 组与库不符，靠校验闸才没出事）。
const fs = require("fs");
const path = require("path");

const APPLY = process.argv.includes("--apply");
const DB = path.join(__dirname, "data", "db.json");
const MD = path.join(__dirname, "重复流水清理清单_v167.md");
const BY = "v168清理";

const db = JSON.parse(fs.readFileSync(DB, "utf8"));
const U = (s) => String(s == null ? "" : s).trim().toUpperCase();
const fmt = (t) => new Date(Number(t)).toLocaleString("zh-CN", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const isStation = (l) => /^NB02-CK-\d+$/.test(l);
const locOf = (v) => U(Number(v.wt || 0) === 0 ? v.st : v.gl);

// —— 分组：同码 + 同位置 的未作废流水 ——
const groups = new Map();
for (const [k, v] of Object.entries(db.scanlog || {})) {
  if (v.cx) continue;
  const c = U(v.code); if (!c) continue;
  const l = locOf(v); if (!l) continue;
  const key = c + "|" + l;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push({ k, v });
}
const dupKeys = [...groups.entries()].filter(([, a]) => a.length >= 2);

// —— 取留/作废规则（每条都记录依据，写进清单）——
const allFlowsOf = (c) => Object.entries(db.scanlog || {}).filter(([, v]) => U(v.code) === c);
const outOrdersOf = (c) => Object.values(db.outbound || {}).filter((o) => (o.items || []).some((i) => U(i.barcode || i.code) === c)).map((o) => o.orderNo);

const plan = [];
for (const [key, arr] of dupKeys) {
  const [code, loc] = key.split("|");
  arr.sort((a, b) => (Number(a.v.t) || 0) - (Number(b.v.t) || 0));
  const L = (db.ledger || []).find((x) => U(x.c) === code);
  let keepIdx = arr.length - 1, rule = "", kind = "";
  const glOf = (v) => U(v.gl);
  const qs = arr.map((e) => Number(e.v.q) || 0);
  const qSame = new Set(qs).size === 1;
  const gSet = new Set(arr.map((e) => glOf(e.v) || "(空)"));
  const oneFilled = arr.map((e, i) => ({ i, g: glOf(e.v) })).filter((x) => x.g);
  /* 判据按【会不会改变数字】排序，而不是按"猜哪条更真"：
     件数相同 → 保留哪条对件数、库存、报表合计都完全无影响，纯粹消除重复行；
     件数不同 → 保留哪条会改变按流水汇总的件数，属实质改数，一律交人工、脚本不自作主张。 */
  if (!qSame) {
    kind = "NEEDS-HUMAN";
    rule = `⚠ 组内件数不一致（${qs.join(" / ")}）——保留哪条会改变按流水汇总的件数，属实质改数，脚本不自动处理，请人工指定保留哪条`;
  } else if (oneFilled.length === 1 && gSet.size > 1) {
    // 一条回填过上架格位、一条空：有值那条真实走完上架（信息也更完整），两条件数相同故选它零风险
    keepIdx = oneFilled[0].i; kind = "prefer-gl";
    rule = `件数相同（均 ${qs[0]} 件，保留任一条都不改任何数字）；其中 1 条回填了上架格位 ${oneFilled[0].g}（说明它真实走完上架、信息更完整），另一条 gl 为空 → 保留有格位的那条`;
  } else if (L && new Set(arr.map((e) => (glOf(e.v) === U(L.l) ? "same" : "diff"))).has("same")) {
    keepIdx = arr.length - 1; kind = "book-same-slot";
    rule = `件数相同（均 ${qs[0]} 件，保留任一条都不改任何数字）；各条上架格位与账本 ${L.l} 一致${isStation(loc) ? `，且同为台站 ${loc} 那次入库（同一框重复扫码，非跨台站挪位）` : ""} → 保留最新一条，仅为消除流水页重复行`;
  } else if (L) {
    keepIdx = arr.length - 1; kind = "book-latest";
    rule = `件数相同（均 ${qs[0]} 件）；框在账 ${L.l}，但各条 gl 与该格位不一致或未回填（旧流水上架后没回填），无格位证据可依 → 按「以最新有效扫码为准」（与 v103 同口径）保留最新，不影响库存`;
  } else if (gSet.size > 1 && oneFilled.length > 1) {
    keepIdx = arr.length - 1; kind = "off-moved";
    rule = `件数相同（均 ${qs[0]} 件）；框已出库，两条回填的上架格位不同（${[...gSet].join(" / ")}，中间挪过一次位），账本行已消无从判断哪条对应最终实物 → 按最新保留，只影响流水页显示哪行`;
  } else {
    keepIdx = arr.length - 1; kind = "cosmetic";
    rule = `件数相同（均 ${qs[0]} 件）；框已出库、各条上架格位${oneFilled.length ? `相同（${oneFilled[0].g}，同一次入库被重复扫码）` : "全为空（旧流水未回填格位）"}→ 数据上无法区分哪条更"真"，但【保留任一条都不改变库存、件数与任何报表合计】，仅为消除重复行，按最新保留`;
  }
  const others = allFlowsOf(code);
  const moved = others.filter(([k2, v2]) => !v2.cx && locOf(v2) !== loc);
  plan.push({
    code, loc, arr, keepIdx, rule, kind,
    onBook: !!L, bookLoc: L ? L.l : "", bookQ: L ? L.q : 0, bookT: L ? L.t : 0,
    outs: outOrdersOf(code),
    otherLive: others.filter(([, v2]) => !v2.cx).length,
    moved: moved.length,
    dupQty: arr.filter((_, i) => i !== keepIdx).reduce((s, e) => s + (Number(e.v.q) || 0), 0),
  });
}
plan.sort((a, b) => (b.onBook ? 1 : 0) - (a.onBook ? 1 : 0) || b.dupQty - a.dupQty);

// —— 件数不一致 = 保留任一条都会改变件数，属实质改数 → 全程不自动处理，只单独列出 ——
const auto = plan.filter((p) => p.kind !== "NEEDS-HUMAN");
const human = plan.filter((p) => p.kind === "NEEDS-HUMAN");

// —— 安全基线（执行前后必须完全一致）——
const ledFp = (db.ledger || []).map((x) => [x.c, x.l, x.q, x.t].join(":")).sort().join("|");
const seenN = Object.keys(db.seenIn || {}).length;
const tombN = (db.ledgerTomb || []).length;
const liveBefore = Object.values(db.scanlog).filter((x) => !x.cx).length;

// —— 生成清单 ——（"待作废/虚高"只统计件数一致的可自动组，与执行动作严格同口径）
const autoDupRows = auto.reduce((s, p) => s + p.arr.length - 1, 0);
const totalDupQty = auto.reduce((s, p) => s + p.dupQty, 0);
const L2 = [];
L2.push("# 历史重复有效流水清理清单（v167 修复前的存量遗留）");
L2.push("");
L2.push("| 项 | 值 |");
L2.push("|---|---|");
L2.push(`| 数据快照时刻 | ${fmt(Date.now())} |`);
L2.push(`| 重复组数 | ${plan.length} 组（同码+同位置存在 ≥2 条未作废流水） |`);
L2.push(`| 可自动作废 | ${auto.length} 组 / ${autoDupRows} 条（组内件数完全相同，保留任一条都不改任何数字） |`);
L2.push(`| 需人工裁决 | ${human.length} 组${human.length ? `（组内件数不一致，保留哪条会改变件数）：${human.map((p) => p.code).join("、")}` : "（无——本批 9 组件数两两相同，没有一组需要人为定数）"} |`);
L2.push(`| 若按流水汇总的件数虚高 | ${totalDupQty} 件（仅统计件数一致的可自动组） |`);
L2.push(`| 账本影响 | **无**（账本每码只一行，在库件数/库存看板本就是对的） |`);
L2.push(`| 影响范围 | 网页「入库流水」页、按流水汇总的日报/月报、库存页「今日入库」按流水去重口径 |`);
L2.push("");
L2.push("## 先说三个必须知道的坑");
L2.push("");
L2.push("1. **不要用网页「作废流水」按钮清理**。那个接口（/api/scanlog/cancel）作废时会**连带整框消账**——");
L2.push(`   在架实物会被从账上抹掉。本清单 ${plan.length} 组里有 ${plan.filter((p) => p.onBook).length} 组框**还在架上**，走按钮会直接消架。`);
L2.push("2. **也不要用「删除批次」**（/api/scanlog/delete）：它按批次整批删，同一批次里别的框会被一起删掉。");
L2.push("3. 本清单**只标记重复的那条为作废**，不碰账本、不碰防重登记、不打墓碑；");
L2.push("   已用备份+执行后三项不变量核验（账本指纹/seenIn数/墓碑数必须一字不变）保护。");
L2.push("");
L2.push("## 逐条明细");
L2.push("");
L2.push("> 位置类型：**AGV台站**=中转点，同一框先后经过台站属正常，这类重复按 v166 口径**只留痕不告警**；");
L2.push("> **存储格**=一个框不可能同时占两个格位，这类会升必达告警，**优先处理**。");
L2.push("");
L2.push("| # | 标签 | 扫入位置 | 类型 | 上架格位(gl) | 账本现态 | 处理 | 时间 | 件数 | 操作人 | 采集批次 | 流水键 |");
L2.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
let n = 0, grpNo = 0;
const why = [];
for (const p of plan) {
  grpNo++;
  const tp = isStation(p.loc) ? "AGV台站" : "存储格";
  const bookState = p.onBook ? `在架 ${p.bookLoc}｜${p.bookQ}件` : "已出库/已消账";
  const kept = p.arr[p.keepIdx];
  p.arr.forEach((e, i) => {
    n++;
    const keep = p.kind === "NEEDS-HUMAN" ? null : (i === p.keepIdx);
    const act = keep === null ? "⚠ 人工定" : (keep ? "**保留**" : "作废");
    L2.push(`| ${n} | ${p.code} | ${p.loc} | ${tp} | ${U(e.v.gl) || "（未回填）"} | ${i === 0 ? bookState : "〃"} | ${act} | ${fmt(e.v.t)} | ${e.v.q} | ${e.v.op || "-"} | ${e.v.batch || "-"} | \`${e.k}\` |`);
  });
  why.push(`**第 ${grpNo} 组 ${p.code}**（${p.kind === "NEEDS-HUMAN" ? "待人工指定保留项" : `保留 ${fmt(p.arr[p.keepIdx].v.t)} 那条`}）：${p.rule}` +
    `${p.moved ? `\n  - 该码另有 ${p.moved} 条不同位置流水（属挪位，**本次不动**）` : ""}` +
    `${p.outs.length ? `\n  - 已出现在 ${p.outs.length} 张出库单：${p.outs.join("、")}` : "\n  - 未出库"}`);
}
L2.push("");
L2.push("### 每组保留依据");
L2.push("");
for (const w of why) L2.push("- " + w);
L2.push("");
L2.push("## 保留判据说明");
L2.push("");
const kc = {}; for (const p of plan) kc[p.kind] = (kc[p.kind] || 0) + 1;
L2.push('**第一判据是「组内件数是否相同」——它决定"保留哪条会不会改变数字"，而不是猜哪条更真。**');
L2.push("");
const kd = { "NEEDS-HUMAN": "组内件数不同：保留哪条会改变件数，属实质改数 → **脚本不动，交人工指定**", "prefer-gl": "件数相同 + 只有一条回填过上架格位：取有格位那条（信息更完整、零风险）", "book-same-slot": "件数相同 + 框在架且格位与账本一致：取最新，纯消除重复行", "book-latest": "件数相同 + 框在架但格位证据缺失：取最新（同 v103 口径）", "off-moved": "件数相同 + 已出库且两条格位不同（挪过位）：取最新", "cosmetic": "件数相同 + 已出库且格位相同/全空：数据上无法区分，取最新" };
let ki = 0;
for (const [k, txt] of Object.entries(kd)) { if (!kc[k]) continue; ki++; L2.push(`${ki}. ${txt} —— **${kc[k]} 组**`); }
L2.push("");
L2.push(`> 结论：本批 ${plan.length} 组**组内件数全部两两相同**，所以「保留哪条」不影响库存、件数和任何报表合计，`);
L2.push("> 纯粹是消除流水页的重复行。哪条被保留都不需要现场担心里数不对——如某个框有实物记忆想指定留哪条，告诉我标签号即可。");
L2.push("");
L2.push("## 执行方式");
L2.push("");
L2.push("```");
L2.push("node cleanup_dup_flow_v167.js          # 演练：只核对+刷新本清单，不写任何数据");
L2.push("node cleanup_dup_flow_v167.js --apply   # 执行：先整库备份 data/db.before-v168clean.json 再写");
L2.push("```");
L2.push("");
L2.push("执行后需**重启 server.js**（或在下次账本同步时自然生效），PDA 侧旧缓存里这几行会经");
L2.push("「新者胜」仲裁自动回写作废态，无需手动处理、也不会被回灌复活。");
fs.writeFileSync(MD, L2.join("\n"));

console.log(APPLY ? "★★ --apply：将真实写入 data/db.json ★★" : "（演练模式，不写库；加 --apply 才执行）");
console.log(`清单已生成：${MD}`);
console.log(`${plan.length} 组 / 可自动作废 ${autoDupRows} 条（件数一致组 ${auto.length}）/ 虚高 ${totalDupQty} 件 / 需人工 ${human.length} 组 / 在架 ${plan.filter((p) => p.onBook).length} 组`);

if (!APPLY) { console.log("\n[演练] 未写入。确认清单后再执行 --apply。"); process.exit(0); }

// —— 执行：只标 cx + 作废人/时刻 ——
// 只处理【件数一致】的组：件数不同的组保留哪条都会改变件数，属实质改数，必须由人指定，脚本绝不自作主张。
const now = Date.now();
let done = 0;
for (const p of auto) p.arr.forEach((e, i) => {
  if (i === p.keepIdx) return;
  const r = db.scanlog[e.k];
  r.cx = true; r.cxB = BY; r.cxA = now; r.rm = "v168清理历史重复有效流水（同码同位置重扫，保留另一条）";
  if (!(r.cxA > (Number(r.t) || 0))) r.cxA = (Number(r.t) || 0) + 1000; // 设备时钟超前兜底，保证压得住回灌
  done++;
});
db.scanlogAt = new Date().toISOString(); db.scanlogCount = Object.keys(db.scanlog).length;

const ledAfter = (db.ledger || []).map((x) => [x.c, x.l, x.q, x.t].join(":")).sort().join("|");
const liveAfter = Object.values(db.scanlog).filter((x) => !x.cx).length;
if (ledAfter !== ledFp) { console.log("✗ 账本被改动，异常，不落盘！"); process.exit(1); }
if (Object.keys(db.seenIn || {}).length !== seenN) { console.log("✗ seenIn 变化，异常，不落盘！"); process.exit(1); }
if ((db.ledgerTomb || []).length !== tombN) { console.log("✗ 墓碑变化，异常，不落盘！"); process.exit(1); }
if (liveAfter !== liveBefore - done) { console.log(`✗ 有效流水数不符（${liveBefore}→${liveAfter}，应减 ${done}），不落盘！`); process.exit(1); }

fs.copyFileSync(DB, path.join(__dirname, "data", "db.before-v168clean.json"));
fs.writeFileSync(DB, JSON.stringify(db));
console.log(`\n✓ 已作废 ${done} 条；有效流水 ${liveBefore} → ${liveAfter}；账本 ${db.ledger.length} 行未变（备份 data/db.before-v168clean.json）`);
const g2 = {};
for (const v of Object.values(db.scanlog)) { if (v.cx) continue; const c = U(v.code), l = locOf(v); if (!c || !l) continue; (g2[c + "|" + l] = g2[c + "|" + l] || []).push(v); }
const rem = Object.entries(g2).filter(([, a]) => a.length >= 2);
console.log(`✓ 复核：清理后同码同位置重复 ${rem.length} 组${rem.length ? "：" + rem.map(([k]) => k).join(" ; ") : " ✅ 无残留"}`);
