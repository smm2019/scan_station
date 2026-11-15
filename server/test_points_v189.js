// ㉖v189 AGV 实时地图「点位号」叠加 · 双端源码锚点 + 网页脚本语法闸
// 用户诉求（11-15 附 RCS 官方图）：地图上加地标点位号，便于对照官方图定位。双端各加开关，默认关。
const fs = require('fs');
const pda = fs.readFileSync('D:/work_app/scan_station/lib/agv_map_page.dart', 'utf8').replace(/\r\n/g, '\n');
const html = fs.readFileSync('D:/work_app/scan_station/server/public/console.html', 'utf8').replace(/\r\n/g, '\n');
let t = 0, f = 0;
const chk = (n, c, x) => { t++; if (!c) { f++; console.log('FAIL! [' + n + '] ' + (x || '')); } else console.log('PASS [' + n + ']'); };

// ===== PDA 侧 =====
chk('P1 开关字段默认关 _pts=false', pda.includes('bool _pts = false;'), '');
chk('P2 AppBar 按钮图标随状态切换', pda.includes('Icons.tag : Icons.drive_file_rename_outline') && pda.includes('_pts = !_pts'), '');
chk('P3 painter 传入 _pts（六参调用）', pda.includes('_MapPainter(net, snap, _zoom, _ox, _oy, _pts)'), '');
chk('P4 旧五参调用已清除', !pda.includes('_oy))'), '');
chk('P5 painter 构造接收 pts 字段', /_MapPainter\(this\.net, this\.snap, this\.zoom, this\.ox, this\.oy, this\.pts\)/.test(pda), '');
chk('P6 渲染块 if(pts) 且画地标号 e.key', pda.includes('if (pts) {') && pda.includes('_txt(canvas, c + const Offset(0, -6), e.key'), '');
chk('P7 点位画在所有业务元素之前（货架/站台/车全压上层）', pda.indexOf('if (pts) {') < pda.indexOf('货架占用（橙点'), '');

// ===== 网页侧 =====
chk('W1 开关变量默认关 PTS=false', html.includes('var PTS=false;'), '');
chk('W2 工具条点位按钮存在', html.includes('id="t_pts"'), '');
chk('W3 按钮点击切换并重绘', html.includes("$('#t_pts').onclick") && html.includes('PTS=!PTS'), '');
chk('W4 drawMap 渲染 if(PTS) 画点+号', /if\(PTS\)\{g\.fillStyle='#90a4ae';g\.font='7\.5px monospace'/.test(html), '');
chk('W5 网页点位跟随二楼视图（FLOOR 过滤）', /if\(PTS\)\{[\s\S]{0,120}if\(!FLOOR\(l\)\)continue/.test(html), '');

// ===== 网页脚本语法闸（点位改动落在 drawMap/pgAgv 内，语法关必过）=====
try {
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  let bad = '';
  scripts.forEach((x, i) => { try { new Function(x[1]); } catch (e) { bad += 'script' + i + ':' + e.message + ' '; } });
  chk('W6 网页全部脚本语法通过', bad === '', bad.slice(0, 160));
} catch (e) { chk('W6 网页脚本解析', false, e.message); }

console.log('\n===== v189 地图点位号双端锚点证明 ' + (t - f) + '/' + t + ' PASS =====');
process.exit(f ? 1 : 0);
