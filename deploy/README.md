# WMAS 部署包使用说明

## 这是什么
仓库管理系统（WMAS）的一键部署包。包含后端代码、网页控制台和 NSSM 服务注册器。
**不含任何数据**——数据库、备份、APK 等都在服务器本地 data 目录，部署脚本绝不触碰。

## 包内结构
```
deploy\
├── 一键安装.cmd        【服务器·双击】首次安装（自动 UAC 提权跑 install.ps1）
├── 一键更新.cmd        【服务器·双击】日常更新（自动 UAC 提权跑 update.ps1）
├── 打更新包.cmd        【开发机·双击】把最新代码打成 update.zip
├── 迁移数据.cmd        【开发机·双击】停旧服务+打包整个 data 目录成 zip
├── install.ps1        首次安装脚本（装服务+防火墙+健康检查）
├── update.ps1         日常更新脚本（备份数据→停服务→覆盖代码→起服务→健康检查）
├── nssm.exe           服务注册器（把 node 程序注册成 Windows 服务）
└── code\
    ├── server.js      后端主程序（零依赖，只需 Node 18+）
    └── public\        网页控制台（console.html 等静态文件）
```

## 首次安装（新服务器）
1. 把整个 `deploy` 文件夹拷到服务器任意位置（U盘/向日葵文件传输均可）
2. **双击 `一键安装.cmd`**（自动弹 UAC 授权；也可右键 install.ps1 → 以管理员身份运行）
3. 脚本自动：检测/安装 Node.js → 代码铺到 `D:\wmas` → 注册服务 `HSAuthServer`（开机自启、崩溃 2 秒自愈、日志轮转）→ 放行防火墙 8099 → 健康检查
4. 完成后浏览器访问 `http://服务器IP:8099/console`
5. 首次启动自动初始化默认数据：管理员账号 **admin / admin123**（登录后立即改密码）
6. 到「设置」页重新配置 RCS / WMAS 对接地址与凭据（密码加密存储，与机器绑定，换机需重录）

可选参数：`.\install.ps1 -InstallDir D:\wmas -Port 8099`（默认即此值）

## 日常更新（本地改代码 → 覆盖服务器）
1. **开发机**：双击 `打更新包.cmd` → 自动把最新 server.js + console.html 打成 `out\wmas-update-时间戳.zip`，并弹出所在文件夹
2. 用向日葵把该 zip 拖到服务器，解压到任意目录
3. **服务器**：双击解压目录里的 `一键更新.cmd`（自动 UAC 提权）
4. 脚本自动：备份 db.json+secret.key 到 `data\backups\pre-update-时间戳\` → 停服务 → 只覆盖代码 → 起服务 → 健康检查
5. 全程约 10 秒，期间网页/PDA 短暂断连会自动恢复；**数据、备份、APK、日志一概不动**
6. 重复运行 install.ps1 也可以（等效重装服务注册，同样不动数据）

## 数据迁移（旧服务器 → 新服务器）
**推荐用 `迁移数据.cmd`（在旧机器上双击）**：它会打开服务管理器让你确认停掉旧服务，然后把整个 data 目录打包成 `out\wmas-data-时间戳.zip`，并打印出下一步操作清单。拿到 zip 后在服务器上：
1. 先跑一次 install.ps1（装好服务和目录）
2. 停服务：`D:\wmas\nssm.exe stop HSAuthServer`
3. 把 zip 解压覆盖到新机 `D:\wmas\data\`
   **必须同时包含 `db.json` 和 `secret.key`**——RCS/WMAS 密码用 secret.key 加密，两文件不同源会导致对接密码失效需在设置页重录
4. 起服务：`D:\wmas\nssm.exe start HSAuthServer`
5. 验证：所有 PDA 设置里服务器地址改为新机 IP；⚠️ 最后务必停用旧机服务防双跑账本分叉
断电防御机制（启动自检+安全副本+自动回滚）会校验拷来的数据完整性，损坏时自动回滚到最近备份

## 故障排查
| 现象 | 处理 |
|---|---|
| 脚本红字「不是管理员」 | 必须右键→以管理员身份运行 |
| 健康检查失败 | 看 `D:\wmas\data\logs\service-error.log` 尾部；常见=端口被占（改 `-Port`）或 Node 版本过低 |
| 服务没起来 | `services.msc` 找 HSAuthServer 手动启动；或命令行 `D:\wmas\nssm.exe restart HSAuthServer` |
| 局域网打不开页面 | 确认防火墙规则 HS-Auth-8099 存在；确认服务器 IP 与同事在同一网段 |
| 更新后要回退 | 代码回退：用上一版 update.zip 重跑 update.ps1；数据回退：停服务→把 `backups\pre-update-*\` 里文件拷回 data\→起服务 |

## 卸载
`D:\wmas\nssm.exe stop HSAuthServer` 然后 `D:\wmas\nssm.exe remove HSAuthServer confirm`
（data 目录不会被删除，确认不要了再手动删）
