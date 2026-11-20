// ㉖v204 不符单归位出口 端到端验证
// 事故（11-19 N26K080287 时间线截图）：到台判不符→旧版 mismatch 单无归位出口只能取消→
// 框物理压台无处去，被迫作废采集流水消位再"新入库"叫车回家（mv 被洗成假入库）。
// 修复：/api/count/return 放行 mismatch（有站台记录者）回原格，取消回归"人工已搬走"。
// ★ 必须真跑：return 端点状态放行+并发闸是控制流，只有真实 HTTP 分别命中 mismatch/scanned/
//   pending 三种状态才证得"不符能归位、已核对仍可、待发车仍拒"。夹具启动前造好，读回走 GET。
const fs=require('fs'),path=require('path'),cp=require('child_process'),crypto=require('crypto');
const TDIR=path.join(__dirname,'_misret_v204'),PORT=Number(process.env.MR_PORT||8533);
const BASE='http://127.0.0.1:'+PORT;
if(fs.existsSync(TDIR))fs.rmSync(TDIR,{recursive:true,force:true});fs.mkdirSync(TDIR,{recursive:true});
fs.copyFileSync(path.join(__dirname,'data','db.json'),path.join(TDIR,'db.json'));
const sk=path.join(__dirname,'data','secret.key');if(fs.existsSync(sk))fs.copyFileSync(sk,path.join(TDIR,'secret.key'));
const db0=JSON.parse(fs.readFileSync(path.join(TDIR,'db.json'),'utf8'));
const salt=crypto.randomBytes(16).toString('hex'),hp=(p,s)=>crypto.scryptSync(String(p),s,32).toString('hex'),PW='E2e#Mr!204';
db0.users.push({id:'u_mr_wh',username:'mr_wh',name:'不符归位仓管',role:'warehouse',enabled:true,createdAt:Date.now(),mustChangePw:false,salt,passHash:hp(PW,salt)});
db0.params=Object.assign(db0.params||{},{receivingOn:0,reqHoursOn:0});
const C1='N26QM2040001',C2='N26QM2040002',C3='N26QM2040003',PN='8894080204';
const L=(c,q)=>({c,p:PN,n:'不符归位件',q,l:'NB02-A-15-1F',f:'1800*1200_2',b:'2026-11-01',t:Date.now()-12*864e5,mv:'登记',src:'TEST',pid:'TPM204'+c});
db0.ledger=(db0.ledger||[]).filter(x=>String(x.p||'').toUpperCase()!==PN);
[C1,C2,C3].forEach(c=>db0.ledger.push(L(c,100)));
const now=Date.now();
const rec=(id,code,state,extra)=>Object.assign({id,code,sid:'MR204',from:'NB02-A-15-1F',part:PN,nm:'不符归位件',f:'1800*1200_2',qty:100,ageDays:12,state,station:'',uid:'u_mr_wh',by:'不符归位仓管',at:now,updAt:now,arriveAt:now,taskNo:'',taskNo2:'',outQueued:0,backQueued:0,diff:null,sibs:[code]},extra||{});
db0.counts=[
 rec('t_mis',C1,'mismatch',{station:'NB02-CK-11',diff:{kind:'wrongBox',scanned:C2,expect:C1,at:now}}), // 不符+有站台→应放行归位
 rec('t_scan',C2,'scanned',{station:'NB02-CK-12'}),                                                      // 已核对→仍可归位(回归)
 rec('t_pend',C3,'pending'),                                                                             // 待发车→仍拒
 rec('t_mis_ns',C3,'mismatch',{diff:{kind:'qty',expect:100,actual:60,at:now}}),                          // 不符但无站台记录→拒并提示人工
];
fs.writeFileSync(path.join(TDIR,'db.json'),JSON.stringify(db0));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let fail=0,total=0;
const C=(n,c,i)=>{total++;if(!c)fail++;console.log(`${c?'✅':'❌'} ${n}${i!==undefined?'  ['+i+']':''}`);};
const post=async(p,t,b)=>{const r=await fetch(BASE+p,{method:'POST',headers:{'Content-Type':'application/json',...(t?{Authorization:'Bearer '+t}:{})},body:JSON.stringify(b||{})});return{status:r.status,json:await r.json().catch(()=>({}))};};
const getj=async(p,t)=>{const r=await fetch(BASE+p,{headers:t?{Authorization:'Bearer '+t}:{}});return{status:r.status,json:await r.json().catch(()=>({}))};};
(async()=>{
  const srv=cp.spawn(process.execPath,['server.js'],{cwd:__dirname,env:{SELFTEST_NO_LIVE:'1',...process.env,PORT:String(PORT),HOST:'127.0.0.1',DATA_DIR:TDIR},stdio:['ignore','pipe','pipe']});
  let up=false;for(let i=0;i<40&&!up;i++){await sleep(250);try{up=(await fetch(BASE+'/api/health')).ok;}catch(_){}}
  if(!up){console.log('❌ 实例未就绪');srv.kill();process.exit(1);}
  let out='';srv.stdout.on('data',d=>out+=d);srv.stderr.on('data',d=>out+=d);
  const one=async id=>(((await getj('/api/count/list?all=1',tk)).json.list||[]).find(x=>x.id===id)||{});
  let tk;
  try{
    tk=(await post('/api/login',null,{username:'mr_wh',password:PW,dev:'MR',kind:'pda'})).json.token;
    C('护栏 仓管登录+4张夹具工单',!!tk);if(!tk)throw new Error('登录失败');
    const a=await post('/api/count/return',tk,{id:'t_mis'});
    C('★★★ 不符单(有站台)放行归位（事故场景修复：不再只能取消）',a.json.ok===true,a.status+' msg='+String(a.json.msg||'').slice(0,30));
    const rm=await one('t_mis');
    C('★★★ 不符单归位进入回架态（returning 或排队 backQueued=1）',(rm.state==='returning'||(rm.state==='mismatch'&&rm.backQueued===1)),'state='+rm.state+' backQueued='+rm.backQueued);
    C('② 归位落点钉死原格 NB02-A-15-1F',rm.from==='NB02-A-15-1F','from='+rm.from);
    const b=await post('/api/count/return',tk,{id:'t_scan'});
    C('③ 已核对单仍可归位（回归不破）',b.json.ok===true,'msg='+String(b.json.msg||'').slice(0,26));
    const c=await post('/api/count/return',tk,{id:'t_pend'});
    C('★★★ 待发车单仍被拒（不放水）',c.status===400&&/不可归位/.test(String(c.json.msg||'')),c.status+' msg='+String(c.json.msg||'').slice(0,30));
    const d=await post('/api/count/return',tk,{id:'t_mis_ns'});
    C('⑤ 不符单无站台记录→拒并指引人工归位（不误导下发AGV）',d.status===400&&/人工/.test(String(d.json.msg||'')),d.status+' msg='+String(d.json.msg||'').slice(0,40));
    C('★ 进程存活',(await fetch(BASE+'/api/health')).ok===true);
  }catch(e){total++;fail++;console.log('❌ 异常：'+e.message+'\n'+String(out).split('\n').slice(-10).join('\n'));}
  finally{srv.kill();await sleep(500);try{fs.rmSync(TDIR,{recursive:true,force:true});}catch(_){}}
  console.log('\n结果: '+(total-fail)+' 通过 / '+fail+' 失败  （隔离副本，生产库零写入）');
  process.exit(fail?1:0);
})();
