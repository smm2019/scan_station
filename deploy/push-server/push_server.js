// =====================================================================
// ㉖v291 WMAS 消息推送中心（局域网独立服务 · 零依赖单文件）
// 部署：把本文件复制到局域网内任一台 Windows 服务器（如 WIN-0HFU28FN5NH / Server 2022），
//   装 Node.js ≥16（winget install OpenJS.NodeJS.LTS），然后：node push_server.js
//   或注册成服务常驻：nssm install WmasPushHub "C:\path\node.exe" "C:\path\push_server.js"
// 端口：默认 8100（环境变量 PUSH_PORT 可改）；防火墙放行该端口 TCP 入站。
// 鉴权：环境变量 PUSH_KEY 设置后，/ingest 与 /sse 都必须带 ?key= 或头 x-push-key（局域网内部工具，防误连）。
//
// 职责（只做转发扇出，不存业务数据——数据权威仍在 scan_station 的 db.notifications）：
//   POST /ingest          scan_station 产生通知时转发过来（单条 {msg:{...}} 或批量 {msgs:[...]}）
//   GET  /sse?user=<id>   终端（网页/PDA）长连接订阅；连上先补发 ring 里 since 之后的消息（对齐补漏）
//   GET  /health          探活（watchdog/运维用）
//   GET  /stats           在线客户端数/累计转发数（排查用）
// 消息对象结构与 scan_station db.notifications 行一致：{id,to,type,text,time,read,reqId}
//   to = 目标用户id 或 'all'；终端按自己的 userId 过滤（与 App 系统通知同源同口径=对齐）。
// =====================================================================
const http = require('http');
const PORT = Number(process.env.PUSH_PORT || 8100);
const KEY = String(process.env.PUSH_KEY || '').trim();
const RING_MAX = 500; // 环形缓冲：晚连终端补漏用（对齐"App 收到过但网页刚打开"的窗口）
const HB_MS = 25000; // SSE 心跳：防中间设备/代理掐空闲连接

const ring = []; // 最近 RING_MAX 条 {seq, msg}
let seq = 0, ingested = 0, fanned = 0;
const clients = new Set(); // {res, user, sinceSeq, at}

const now = () => new Date().toISOString();
const log = (...a) => console.log('[' + now() + ']', ...a);

function authed(req, url) {
  if (!KEY) return true;
  return url.searchParams.get('key') === KEY || req.headers['x-push-key'] === KEY;
}
function send(res, code, obj, extra) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }, extra || {}));
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let s = ''; req.on('data', (d) => { s += d; if (s.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch (_) { resolve(null); } });
  });
}
function sseWrite(c, obj) {
  try { c.res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (_) { clients.delete(c); }
}
function fanout(msg) {
  seq++;
  const item = { seq, msg };
  ring.push(item); if (ring.length > RING_MAX) ring.shift();
  let n = 0;
  for (const c of clients) { sseWrite(c, { t: 'msg', seq, msg }); n++; }
  fanned += n;
  return n;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://x');
  const p = url.pathname;
  if (req.method === 'OPTIONS') return send(res, 204, {});

  if (p === '/health') return send(res, 200, { ok: true, svc: 'wmas-push-hub', at: now(), clients: clients.size, ingested, fanned, ring: ring.length, keyOn: !!KEY });

  if (!authed(req, url)) return send(res, 403, { ok: false, msg: 'key 不匹配（服务设置了 PUSH_KEY）' });

  if (p === '/stats') return send(res, 200, { ok: true, at: now(), clients: [...clients].map((c) => ({ user: c.user, since: c.at })), ingested, fanned, ringLen: ring.length, seq });

  // ---- 接收 scan_station 转发 ----
  if (p === '/ingest' && req.method === 'POST') {
    const b = await readBody(req);
    if (!b) return send(res, 400, { ok: false, msg: 'body 需为 JSON' });
    const list = Array.isArray(b.msgs) ? b.msgs : (b.msg ? [b.msg] : []);
    let pushed = 0;
    for (const m of list) {
      if (!m || typeof m !== 'object' || !m.text) continue;
      m.id = String(m.id || ('p' + Date.now() + '_' + (ingested++)));
      m.time = m.time || now();
      pushed += fanout(m) > 0 ? 1 : 1; ingested++;
    }
    return send(res, 200, { ok: true, accepted: list.length, pushed, clients: clients.size });
  }

  // ---- 终端订阅（SSE）----
  if (p === '/sse' && req.method === 'GET') {
    const user = String(url.searchParams.get('user') || '').slice(0, 60);
    const since = Number(url.searchParams.get('since') || 0); // 客户端已见最大 seq（首次连=0 → 补发 ring 全量近期）
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
    res.write('retry: 5000\n\n');
    const c = { res, user, at: Date.now() };
    clients.add(c);
    res.write('data: ' + JSON.stringify({ t: 'hello', at: now(), seq, user }) + '\n\n');
    // 补漏：ring 里 seq>since 的都补发（终端重连/晚开不丢消息=与 App 对齐的关键）
    for (const it of ring) if (it.seq > since) sseWrite(c, { t: 'msg', seq: it.seq, msg: it.msg });
    const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch (_) { clearInterval(hb); clients.delete(c); } }, HB_MS);
    req.on('close', () => { clearInterval(hb); clients.delete(c); });
    return;
  }

  return send(res, 404, { ok: false, msg: '接口不存在' });
});

server.listen(PORT, '0.0.0.0', () => log('WMAS 消息推送中心已启动 http://0.0.0.0:' + PORT + '（key=' + (KEY ? '已启用' : '未设置') + '）'));
process.on('SIGINT', () => { log('收到 SIGINT，退出'); process.exit(0); });
process.on('SIGTERM', () => { log('收到 SIGTERM，退出'); process.exit(0); });
process.on('uncaughtException', (e) => { log('[FATAL] 未捕获异常（不退出，保持推送在线）：', e && e.message); });
process.on('unhandledRejection', (e) => { log('[REJECT] 未处理拒绝：', e && e.message); });
