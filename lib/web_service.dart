// ===== WiFi 网页门户：历史批次列表 / 任意批次CSV下载 / 盘点基准CSV上传 =====
// 本文件是 main.dart 的 part，共享同一库：可直接使用 BatchInfo、ScanRecord、
// _globalIsar，以及主库已导入的 dart:io / dart:convert / package:shelf /
// package:mime / path_provider。
//
// 路由设计（未用 shelf.Router：它与 Flutter widgets 的 Router 同名会产生歧义）：
//   GET  /                 管理页（批次列表 + 下载 + 基准上传）
//   GET  /api/status       当前批次号
//   GET  /api/batches      全部批次（含记录数、归档标记），新批次在前
//   GET  /api/export       ?batch=id1,id2 下载CSV；不传=当前批次；多个=合并导出
//   GET  /api/baseline     已上传基准文件列表
//   POST /api/baseline     multipart 上传基准CSV，同名替换
//
// 基准文件保存位置：应用文档目录下 baseline/ 子目录，供盘点复核模式读取。

part of 'main.dart';

const int _kBaselineMaxBytes = 20 * 1024 * 1024; // 基准文件上限 20MB

/// 创建局域网网页服务的请求处理器（替换旧的"任何请求都返回当前批次CSV"）
Handler createCollectWebService({
  required Future<String> Function(List<String> batchIds) csvForBatches,
  required String? Function() currentBatchId,
}) {
  Future<Response> handle(Request req) async {
    final path = '/${req.url.path}';
    final seg = (path.length > 1 && path.endsWith('/')) ? path.substring(0, path.length - 1) : path;
    try {
      if (req.method == 'GET') {
        switch (seg) {
          case '/':
          case '/index.html':
            return Response.ok(_kWebPortalHtml, headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
            });
          case '/favicon.ico':
            return Response.notFound('');
          case '/api/status':
            return _jsonResponse({'currentBatchId': currentBatchId() ?? ''});
          case '/api/batches':
            return await _apiListBatches();
          case '/api/baseline':
            return await _apiListBaselines();
          case '/api/export':
            return await _apiExportCsv(req, csvForBatches, currentBatchId);
        }
      } else if (req.method == 'POST' && seg == '/api/baseline') {
        return await _apiUploadBaseline(req);
      }
      return Response.notFound('接口不存在');
    } catch (e) {
      return Response.internalServerError(body: '服务异常：$e');
    }
  }
  return handle;
}

Response _jsonResponse(Object data) {
  return Response.ok(jsonEncode(data), headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
}

Response _textResponse(String msg, {int status = 200}) {
  return Response(status, body: msg, headers: {
    'Content-Type': 'text/plain; charset=utf-8',
  });
}

// ---------- 批次列表 ----------
Future<Response> _apiListBatches() async {
  final batches = await _globalIsar.batchInfos.where().findAll();
  batches.sort((a, b) => b.createTime.compareTo(a.createTime));
  final out = <Map<String, dynamic>>[];
  for (final b in batches) {
    final cnt = await _globalIsar.scanRecords.filter().batchIdEqualTo(b.batchId).count();
    out.add({
      'batchId': b.batchId,
      'createTime': b.createTime,
      'remark': b.batchRemark,
      'archived': b.isArchived,
      'count': cnt,
    });
  }
  return _jsonResponse(out);
}

// ---------- 按批次下载 / 多选合并下载 ----------
Future<Response> _apiExportCsv(
  Request req,
  Future<String> Function(List<String>) csvForBatches,
  String? Function() currentBatchId,
) async {
  final raw = req.url.queryParameters['batch'] ?? '';
  final ids = raw.split(',').map((e) => e.trim()).where((e) => e.isNotEmpty).toList();
  final csv = await csvForBatches(ids);
  final String fname;
  if (ids.isEmpty) {
    fname = 'agv_data_${currentBatchId() ?? 'current'}.csv';
  } else if (ids.length == 1) {
    fname = 'agv_data_${ids.first}.csv';
  } else {
    fname = 'agv_data_merged_${ids.length}b_${DateTime.now().millisecondsSinceEpoch}.csv';
  }
  return Response.ok(csv, headers: {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="$fname"',
  });
}

// ---------- 基准CSV：存储目录 ----------
Future<Directory> _baselineDir() async {
  final docs = await getApplicationDocumentsDirectory();
  final dir = Directory('${docs.path}/baseline');
  if (!await dir.exists()) await dir.create(recursive: true);
  return dir;
}

// ---------- 基准CSV：上传（multipart/form-data，同名替换） ----------
/// 从 part 的 Content-Disposition 头解析 filename="..."，并做路径清洗
String? _filenameFromDisposition(String? disposition) {
  if (disposition == null) return null;
  final m = RegExp('filename\\s*=\\s*"([^"]*)"').firstMatch(disposition) ??
      RegExp(r"filename\s*=\s*([^;]+)").firstMatch(disposition);
  if (m == null) return null;
  var name = m.group(1)!.trim().replaceAll('"', '');
  name = name.replaceAll('\\', '/');
  name = name.substring(name.lastIndexOf('/') + 1).trim(); // 防路径穿越，只取文件名
  return name.isEmpty ? null : name;
}

Future<Response> _apiUploadBaseline(Request req) async {
  final ct = req.headers['content-type'] ?? '';
  final m = RegExp(r'boundary=([^;]+)', caseSensitive: false).firstMatch(ct);
  if (!ct.toLowerCase().startsWith('multipart/form-data') || m == null) {
    return _textResponse('请以 multipart/form-data 表单上传文件', status: 400);
  }
  final boundary = m.group(1)!.trim().replaceAll('"', '');
  final parts = await MimeMultipartTransformer(boundary).bind(req.read()).toList();
  String? savedName;
  int savedBytes = 0;
  String? savedPath;
  for (final MimeMultipart part in parts) {
    final name = _filenameFromDisposition(part.headers['content-disposition']);
    if (name == null) continue; // 跳过普通字段，只收文件
    final ext = name.contains('.') ? name.substring(name.lastIndexOf('.') + 1).toLowerCase() : '';
    if (ext != 'csv' && ext != 'txt') {
      return _textResponse('仅支持 CSV / TXT 基准文件', status: 400);
    }
    final dir = await _baselineDir();
    final file = File('${dir.path}/$name');
    final sink = file.openWrite();
    int total = 0;
    try {
      await for (final List<int> chunk in part) {
        total += chunk.length;
        if (total > _kBaselineMaxBytes) {
          await sink.close();
          if (await file.exists()) await file.delete();
          return _textResponse('文件超过 20MB 上限', status: 413);
        }
        sink.add(chunk);
      }
    } catch (e) {
      await sink.close();
      if (await file.exists()) await file.delete();
      rethrow;
    }
    await sink.close();
    savedName = name;
    savedBytes = total;
    savedPath = file.path;
  }
  if (savedName == null) return _textResponse('未接收到文件', status: 400);
  return _jsonResponse({'name': savedName, 'size': savedBytes, 'path': savedPath});
}

// ---------- 基准CSV：已上传文件列表 ----------
Future<Response> _apiListBaselines() async {
  final dir = await _baselineDir();
  final files = dir.listSync().whereType<File>().where((f) {
    final n = f.path.toLowerCase();
    return n.endsWith('.csv') || n.endsWith('.txt');
  }).toList()
    ..sort((a, b) => b.statSync().modified.compareTo(a.statSync().modified));
  final out = files.map((f) {
    final st = f.statSync();
    return {
      'name': f.uri.pathSegments.last,
      'size': st.size,
      'mtime': st.modified.toIso8601String(),
    };
  }).toList();
  return _jsonResponse(out);
}

// ==================== 门户页面（HTML+CSS+JS，raw字符串，不做插值） ====================
const String _kWebPortalHtml = r'''
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>仓库采集数据门户</title>
<style>
  :root{--blue:#515BD4;--blue-l:#E8EAF6;--ink:#1F2430;--muted:#7A8194;--ok:#1E9E6A;--warn:#D97706;--line:#E3E6F0;}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:"Microsoft YaHei","PingFang SC",sans-serif;background:#F4F6FB;color:var(--ink);padding:18px}
  .wrap{max-width:980px;margin:0 auto}
  header{background:linear-gradient(120deg,var(--blue),#6A74E8);color:#fff;border-radius:14px;padding:18px 22px;margin-bottom:16px}
  header h1{font-size:20px;margin-bottom:6px}
  header .sub{font-size:13px;opacity:.9}
  .card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin-bottom:16px}
  .card h2{font-size:16px;margin-bottom:4px}
  .card .tip{font-size:12px;color:var(--muted);margin-bottom:12px}
  .btn{display:inline-block;border:none;border-radius:8px;padding:9px 16px;font-size:14px;cursor:pointer;background:var(--blue);color:#fff}
  .btn:disabled{opacity:.45;cursor:not-allowed}
  .btn.ghost{background:var(--blue-l);color:var(--blue)}
  .btn.sm{padding:5px 12px;font-size:13px}
  .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  .msg{font-size:13px;margin-top:10px;padding:8px 12px;border-radius:8px;display:none;word-break:break-all}
  .msg.ok{display:block;background:#E9F7F0;color:var(--ok)}
  .msg.err{display:block;background:#FDECEC;color:#C0392B}
  table{width:100%;border-collapse:collapse;font-size:14px}
  .tbl-wrap{overflow-x:auto}
  th,td{padding:9px 10px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap}
  th{background:#F7F8FD;color:var(--muted);font-weight:normal;font-size:13px}
  tr:hover td{background:#FAFBFF}
  .tag{display:inline-block;font-size:12px;border-radius:20px;padding:2px 10px}
  .tag.cur{background:var(--blue);color:#fff}
  .tag.arch{background:#F1F2F6;color:var(--muted)}
  .tag.act{background:#E9F7F0;color:var(--ok)}
  .bar{position:sticky;bottom:0;background:#fff;border-top:1px solid var(--line);padding:12px 0;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  .cnt{font-size:13px;color:var(--muted)}
  ul.files{list-style:none;font-size:13px;margin-top:10px}
  ul.files li{padding:6px 0;border-bottom:1px dashed var(--line);display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
  ul.files .meta{color:var(--muted)}
  input[type=file]{font-size:14px}
  @media (max-width:640px){header h1{font-size:17px}.card{padding:12px}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>仓库采集数据门户</h1>
    <div class="sub" id="statusLine">正在连接手机服务…</div>
  </header>

  <div class="card">
    <h2>上传盘点基准 CSV</h2>
    <div class="tip">供盘点复核模式使用：上传后保存到手机应用目录，同名文件会被替换。</div>
    <div class="row">
      <input type="file" id="baseFile" accept=".csv,.txt">
      <button class="btn" id="btnUpload" onclick="uploadBaseline()">上传</button>
      <button class="btn ghost" onclick="loadBaselines()">刷新列表</button>
    </div>
    <div class="msg" id="upMsg"></div>
    <ul class="files" id="baseList"></ul>
  </div>

  <div class="card">
    <h2>历史批次</h2>
    <div class="tip">勾选多个批次可合并下载为一张 CSV（与 App 内合并导出口径一致，含整托汇总段）。</div>
    <div class="tbl-wrap">
      <table>
        <thead>
          <tr>
            <th><input type="checkbox" id="ckAll" onclick="toggleAll(this)"></th>
            <th>批次号</th><th>创建时间</th><th>记录数</th><th>备注/货位</th><th>状态</th><th>操作</th>
          </tr>
        </thead>
        <tbody id="tbody"><tr><td colspan="7" class="cnt">加载中…</td></tr></tbody>
      </table>
    </div>
    <div class="bar">
      <button class="btn" id="btnMerge" onclick="downloadChosen()" disabled>下载选中批次（合并CSV）</button>
      <button class="btn ghost" onclick="downloadCurrent()">下载当前批次</button>
      <button class="btn ghost" onclick="loadAll()">刷新</button>
      <span class="cnt" id="selCnt">已选 0 个批次</span>
    </div>
  </div>
</div>

<script>
let currentBatch = '';
let batches = [];

function esc(s){return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}

async function jget(u){const r=await fetch(u);if(!r.ok)throw new Error(await r.text()||('HTTP '+r.status));return r.json();}

async function loadStatus(){
  try{
    const s=await jget('/api/status');
    currentBatch=s.currentBatchId||'';
    document.getElementById('statusLine').textContent=currentBatch?('当前采集批次：'+currentBatch):('服务已连接，暂无进行中批次');
  }catch(e){document.getElementById('statusLine').textContent='连接失败：'+e.message;}
}

async function loadBatches(){
  batches=await jget('/api/batches');
  const tb=document.getElementById('tbody');
  if(!batches.length){tb.innerHTML='<tr><td colspan="7" class="cnt">暂无批次，请先在手机App内新建采集批次</td></tr>';updateSel();return;}
  tb.innerHTML=batches.map(b=>{
    const cur=b.batchId===currentBatch;
    const tag=cur?'<span class="tag cur">当前</span>':(b.archived?'<span class="tag arch">已归档</span>':'<span class="tag act">采集中</span>');
    return '<tr>'
      +'<td><input type="checkbox" class="ck" value="'+esc(b.batchId)+'" onclick="updateSel()"></td>'
      +'<td><b>'+esc(b.batchId)+'</b></td>'
      +'<td>'+esc(b.createTime)+'</td>'
      +'<td>'+b.count+'</td>'
      +'<td>'+esc(b.remark||'—')+'</td>'
      +'<td>'+tag+'</td>'
      +'<td><button class="btn sm ghost" onclick="download([\''+esc(b.batchId)+'\'])">下载</button></td>'
      +'</tr>';
  }).join('');
  updateSel();
}

function toggleAll(box){document.querySelectorAll('.ck').forEach(c=>c.checked=box.checked);updateSel();}
function chosen(){return [...document.querySelectorAll('.ck:checked')].map(c=>c.value);}
function updateSel(){
  const n=chosen().length;
  document.getElementById('selCnt').textContent='已选 '+n+' 个批次';
  document.getElementById('btnMerge').disabled=(n===0);
  document.getElementById('ckAll').checked=(n>0&&n===batches.length);
}

function download(ids){
  location.href='/api/export?batch='+encodeURIComponent(ids.join(','));
}
function downloadChosen(){const ids=chosen();if(ids.length)download(ids);}
function downloadCurrent(){download([]);}

function showMsg(id,text,ok){
  const el=document.getElementById(id);
  el.textContent=text;el.className='msg '+(ok?'ok':'err');
}

async function loadBaselines(){
  try{
    const list=await jget('/api/baseline');
    const ul=document.getElementById('baseList');
    ul.innerHTML=list.length?list.map(f=>{
      const t=new Date(f.mtime);
      const size=f.size>1024*1024?(f.size/1048576).toFixed(1)+' MB':Math.round(f.size/1024)+' KB';
      return '<li><span>'+esc(f.name)+'</span><span class="meta">'+size+' · '+t.toLocaleString()+'</span></li>';
    }).join(''):'<li><span class="meta">尚未上传过基准文件</span></li>';
  }catch(e){/* 列表失败不打扰 */}
}

async function uploadBaseline(){
  const inp=document.getElementById('baseFile');
  if(!inp.files.length){showMsg('upMsg','请先选择基准CSV文件',false);return;}
  const fd=new FormData();
  fd.append('file',inp.files[0]);
  const btn=document.getElementById('btnUpload');btn.disabled=true;btn.textContent='上传中…';
  try{
    const r=await fetch('/api/baseline',{method:'POST',body:fd});
    const txt=await r.text();
    if(!r.ok)throw new Error(txt||('HTTP '+r.status));
    const j=JSON.parse(txt);
    showMsg('upMsg','已上传：'+j.name+'（'+Math.round(j.size/1024)+' KB），保存在 '+j.path,true);
    inp.value='';loadBaselines();
  }catch(e){
    showMsg('upMsg','上传失败：'+e.message,false);
  }finally{
    btn.disabled=false;btn.textContent='上传';
  }
}

async function loadAll(){
  try{await loadStatus();await loadBatches();}
  catch(e){showMsg('upMsg','加载批次失败：'+e.message,false);}
}
loadAll();loadBaselines();
</script>
</body>
</html>
''';
