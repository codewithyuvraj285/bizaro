const { spawn } = require('child_process'); const fs=require('fs'),os=require('os'),path=require('path');
const PORT=3901, B=`http://127.0.0.1:${PORT}`, D=fs.mkdtempSync(path.join(os.tmpdir(),'ld-'));
const p=spawn(process.execPath,['server.js'],{env:{...process.env,PORT,DATA_DIR:D,DEV_OTP:'1',AUTH_RATE:'100000',SEND_RATE:'1000000'},stdio:['ignore','pipe','ignore']});
const call=async(j,m,u,b)=>{const r=await fetch(B+u,{method:m,headers:{...(b?{'content-type':'application/json'}:{}),cookie:j.c||''},body:b?JSON.stringify(b):undefined});const s=r.headers.get('set-cookie');if(s)j.c=s.split(';')[0];return r.json();};
const login=async(ph,n)=>{const j={};const a=await call(j,'POST','/api/auth/request-otp',{phone:ph});const v=await call(j,'POST','/api/auth/verify',{phone:ph,code:a.devOtp,name:n});j.u=v.user;return j;};
const pct=(a,q)=>a.sort((x,y)=>x-y)[Math.floor(a.length*q)];
p.stdout.on('data',async d=>{ if(!String(d).includes('listening'))return;
  const users=[]; for(let i=0;i<10;i++) users.push(await login('+91800000'+String(1000+i),'U'+i));
  const g=(await call(users[0],'POST','/api/conversations',{type:'group',name:'Load',phones:users.slice(1).map(u=>u.u.phone)})).id;
  const lat=[]; const N=2000, t0=Date.now(); let k=0;
  await Promise.all(Array.from({length:20},async(_,w)=>{ while(k<N){ const i=k++, u=users[i%10], s=Date.now(); await call(u,'POST',`/api/conversations/${g}/messages`,{clientId:'ld-'+i+'-'+Date.now(),text:'load '+i}); lat.push(Date.now()-s);} }));
  const el=(Date.now()-t0)/1000;
  const h=[]; for(let i=0;i<200;i++){const s=Date.now(); await call(users[i%10],'GET',`/api/conversations/${g}/messages?limit=30`); h.push(Date.now()-s);}
  const ls=[]; for(let i=0;i<100;i++){const s=Date.now(); await call(users[i%10],'GET','/api/conversations'); ls.push(Date.now()-s);}
  const all=(await call(users[0],'GET',`/api/conversations/${g}/messages?limit=1`)).messages[0].seq;
  console.log(JSON.stringify({sends:N,concurrency:20,group_members:10,seconds:el,msgs_per_sec:Math.round(N/el),send_p50_ms:pct(lat,.5),send_p95_ms:pct(lat,.95),history30_p50_ms:pct(h,.5),history30_p95_ms:pct(h,.95),convlist_p95_ms:pct(ls,.95),last_seq:all}));
  p.kill(); fs.rmSync(D,{recursive:true,force:true}); });
