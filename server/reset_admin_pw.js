// 本地开发辅助：离线直建测试账号（不动 admin 密码；服务停止时执行，避免写覆盖）
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const dbFile = path.join(__dirname, 'data', 'db.json');
const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
function hashPw(pw, salt) { return crypto.scryptSync(String(pw), salt, 32).toString('hex'); }
function mk(username, name, role) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { id: 'u_' + username, username, name, role, enabled: true, salt, passHash: hashPw('test123', salt), createdAt: new Date().toISOString(), mustChangePw: false };
}
for (const [un, nm, role] of [['mat01', '测试物料员', 'material'], ['wh01', '测试仓管员', 'warehouse']]) {
  if (!db.users.some(u => u.username === un)) db.users.push(mk(un, nm, role));
}
if (!Array.isArray(db.requisitions)) db.requisitions = [];
if (!Array.isArray(db.notifications)) db.notifications = [];
const tmp = dbFile + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
fs.renameSync(tmp, dbFile);
console.log('test users ready (admin untouched)');
