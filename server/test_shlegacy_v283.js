// ㉖v283 修正验证：旧版服务器（200 应答但无 boot 字段）不得触发"等待服务恢复"全屏锁
// 背景（11-27 现场实锤）：console.html 每次请求从磁盘现读 → 网页先更新、服务进程后重启的
//   版本错位窗口里，旧逻辑把"200 无 boot"当连不上，5 次探活后误锁全屏（"网页被锁、App 正常"根因）。
// 方法：从 console.html 真实内联脚本里【原样抽取】自愈遮罩代码段，在 vm 里注入假 fetch 跑真实逻辑，
//   不测试副本、测试的就是交付代码文本。三种场景：旧服务器(无boot)=不锁；新服务器ready=不锁；真失联=锁。
const fs = require('fs'), path = require('path'), vm = require('vm');
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + String(i).slice(0, 120) + ']' : ''}`); };

const html = fs.readFileSync(path.join(__dirname, 'public', 'console.html'), 'utf8');
const a = html.indexOf('let _shMode=');
const b = html.indexOf('\nfunction th(');
if (a < 0 || b < 0 || b < a) { console.log('❌ 无法从 console.html 抽取自愈代码段'); process.exit(1); }
const region = html.slice(a, b);
C('护栏 从 console.html 抽到自愈遮罩代码段', region.length > 500, region.length + ' 字符');

function makeEnv(healthResp) {
  const env = { maskAdded: false, reloaded: false, agvBarAdded: false };
  const el = () => ({ style: {}, innerHTML: '', textContent: '', appendChild() {}, remove() {} });
  env.fetch = async () => {
    if (healthResp === 'throw') throw new Error('ECONNREFUSED');
    return { ok: true, status: 200, json: async () => healthResp };
  };
  env.document = {
    getElementById: () => null,
    createElement: () => el(),
    body: { appendChild: (e) => { if (e && e.id === 'selfheal-mask') env.maskAdded = true; if (e && e.id === 'selfheal-agvbar') env.agvBarAdded = true; } },
    head: { appendChild: () => {} },
  };
  env.location = { reload: () => { env.reloaded = true; } };
  env.window = env;
  env.setInterval = () => 0; env.setTimeout = () => 0; env.clearInterval = () => {}; env.clearTimeout = () => {};
  return env;
}
async function run(healthResp, probes) {
  const env = makeEnv(healthResp);
  const ctx = vm.createContext(env);
  vm.runInContext(region + '\n;globalThis.__get=()=>({mode:_shMode,fail:_shFailStreak,everOk:_shEverOk});', ctx);
  for (let i = 0; i < probes; i++) await vm.runInContext('_shProbe()', ctx);
  return Object.assign(env, vm.runInContext('__get()', ctx));
}

(async () => {
  // 场景1：旧版服务器（200、ok=true、无 boot 字段）→ 不得锁、不得弹遮罩
  const legacy = await run({ ok: true, uptime: 9999, serverTime: new Date().toISOString() }, 6);
  C('旧服务器(200无boot)：6次探活后 mode=ok 不锁', legacy.mode === 'ok', 'mode=' + legacy.mode);
  C('旧服务器：未弹全屏遮罩', legacy.maskAdded === false, 'maskAdded=' + legacy.maskAdded);

  // 场景2：新服务器 ready → 不锁
  const ready = await run({ ok: true, boot: { ready: true, pending: [], total: 7, phase: 'ready', ageSec: 40, rcs: { required: true, ageSec: 1, down: false }, recovered: null, rescue: { lastAct: '', at: 0, limited: false } } }, 3);
  C('新服务器 ready：mode=ok 不锁', ready.mode === 'ok', 'mode=' + ready.mode);

  // 场景3：新服务器 自愈中(ready=false) → 锁 healing
  const healing = await run({ ok: true, boot: { ready: false, pending: ['账实不变量自检'], total: 7, phase: 'sweep', ageSec: 5, rcs: { required: true, ageSec: -1, down: false }, recovered: null, rescue: { lastAct: '', at: 0, limited: false } } }, 2);
  C('新服务器自愈中：锁 healing 并弹遮罩', healing.mode === 'healing' && healing.maskAdded === true, 'mode=' + healing.mode + ' mask=' + healing.maskAdded);

  // 场景4：真失联（fetch 抛错）→ 冷启动首次即锁 waiting（fail-safe）
  const down = await run('throw', 1);
  C('真失联：冷启动首次探活即锁 waiting', down.mode === 'waiting' && down.maskAdded === true, 'mode=' + down.mode + ' mask=' + down.maskAdded);

  // 场景5：已探活成功后的一次瞬时抖动（1次失败）→ 不锁（防 Wi-Fi 漫游误锁）
  const env = makeEnv({ ok: true, boot: { ready: true, pending: [], total: 7, phase: 'ready', ageSec: 40, rcs: { required: true, ageSec: 1, down: false }, recovered: null, rescue: { lastAct: '', at: 0, limited: false } } });
  const ctx = vm.createContext(env);
  vm.runInContext(region + '\n;globalThis.__get=()=>({mode:_shMode});globalThis.__setFetch=f=>{fetch=f}', ctx);
  await vm.runInContext('_shProbe()', ctx); // 先成功一次
  await vm.runInContext('__setFetch(async()=>{throw new Error("transient")})', ctx);
  await vm.runInContext('_shProbe()', ctx); // 瞬时失败 1 次
  const jitter = vm.runInContext('__get()', ctx);
  C('探活成功后的单次瞬时抖动：不锁', jitter.mode === 'ok', 'mode=' + jitter.mode);

  console.log(`\n==== v283 旧服务器兼容修正：${total - fail}/${total} 通过${fail ? '（' + fail + ' 失败）' : ' ✅ 全绿'} ====`);
  process.exit(fail ? 1 : 0);
})();
