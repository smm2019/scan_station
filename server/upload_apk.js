// ⑬ APK 发布助手：把 CI 下载的 app-release.apk 放到服务器并写版本清单
// 用法：node server/upload_apk.js <APK路径> <版本号> <build号>
//   例：node server/upload_apk.js C:\dl\app-release.apk 1.1.0 2
// 之后 PDA 登录即会检测到新版本（无需重启服务器：版本/下载路由每次实时读文件）。
const fs = require('fs');
const path = require('path');
const [apkPath, version, build] = process.argv.slice(2);
if (!apkPath || !version || !build) { console.error('用法：node server/upload_apk.js <APK路径> <版本号> <build号>'); process.exit(1); }
if (!fs.existsSync(apkPath)) { console.error('APK 文件不存在：' + apkPath); process.exit(1); }
const b = parseInt(build, 10);
if (!Number.isFinite(b) || b < 1) { console.error('build 必须是正整数'); process.exit(1); }
const dir = path.join(__dirname, 'data', 'app');
fs.mkdirSync(dir, { recursive: true });
fs.copyFileSync(apkPath, path.join(dir, 'app-release.apk'));
const size = fs.statSync(path.join(dir, 'app-release.apk')).size;
fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ version, build: b, size, at: new Date().toISOString() }, null, 2));
console.log(`✅ 已发布 v${version}+${b}（${(size / 1048576).toFixed(1)} MB）→ ${dir}`);
console.log('   PDA 端记得把 pubspec 与 update_page.dart 的 localVersion/localBuild 同步到该版本，避免重复提示。');
