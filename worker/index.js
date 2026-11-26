const ALLOWED_ORIGIN = "https://kumailabbas007.github.io";
const PRICE_URL = "https://xaus.com/api/v1/spot?compact=1";
const FIREBASE_API_KEY = "AIzaSyByGI6THlwazGGLIKmi_vxEMFbuE1rlSqE";
const MAX_PRICE_AGE_SECONDS = 180;
const MAX_ALERTS_PER_DEVICE = 20;
const ALLOWED_EXPIRY = new Set(["Until deleted", "24 hours", "7 days"]);
const LEGACY_PREFIX = "device-alerts:";
const USER_PREFIX = "user-alerts:";

function corsHeaders(){return {"Access-Control-Allow-Origin":ALLOWED_ORIGIN,"Access-Control-Allow-Headers":"Content-Type, Authorization","Access-Control-Allow-Methods":"GET, POST, DELETE, OPTIONS","Access-Control-Max-Age":"86400","Vary":"Origin"};}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8",...corsHeaders()}});}
function expiryTime(expiry,now){if(expiry==="24 hours")return now+86400000;if(expiry==="7 days")return now+604800000;return null;}
function validTopic(t){return typeof t==="string"&&/^[a-zA-Z0-9_-]{8,64}$/.test(t);}
function clean(alerts){const now=Date.now();return Array.isArray(alerts)?alerts.filter(a=>a&&typeof a.id==="string"&&(!a.expiresAt||now<a.expiresAt)):[];}
async function read(env,key){return clean(await env.ALERTS_KV.get(key,"json"));}
async function write(env,key,alerts){if(alerts.length)await env.ALERTS_KV.put(key,JSON.stringify(alerts));else await env.ALERTS_KV.delete(key);}

// Verify every Firebase ID token with Firebase Identity Toolkit before using its UID.
async function verifyUser(request){
  const raw=request.headers.get("Authorization")||"";
  const match=raw.trim().match(/^Bearer\s+(.+)$/i);
  if(!match)return null;
  const idToken=match[1].trim();
  if(idToken.length<100||idToken.length>8192)return null;
  try{
    const response=await fetch("https://identitytoolkit.googleapis.com/v1/accounts:lookup?key="+FIREBASE_API_KEY,{
      method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({idToken})
    });
    if(!response.ok)return null;
    const data=await response.json(),user=data?.users?.[0];
    if(!user||typeof user.localId!=="string"||!user.localId||user.emailVerified!==true)return null;
    return {uid:user.localId,email:user.email||""};
  }catch(e){console.log("Firebase token verification failed:",e?.message||e);return null;}
}

async function getFreshPrice(){
  const r=await fetch(PRICE_URL,{headers:{Accept:"application/json"},signal:AbortSignal.timeout(10000)});
  if(!r.ok)throw Error("Price feed HTTP "+r.status);
  const d=await r.json(),p=Number(d?.spot_usd_oz),s=d?.data_state,a=Number(s?.age_seconds),ts=Date.parse(d?.updated_at||""),age=(Date.now()-ts)/1000;
  if(!Number.isFinite(p)||p<=0||s?.status!=="fresh"||!Number.isFinite(a)||a<0||a>MAX_PRICE_AGE_SECONDS||!Number.isFinite(ts)||age< -30||age>MAX_PRICE_AGE_SECONDS)throw Error("Price quote is stale or invalid");
  return {price:p,updatedAt:d.updated_at};
}
async function sendNtfy(topic,title,message){
  const r=await fetch("https://ntfy.sh/"+encodeURIComponent(topic),{method:"POST",headers:{"Title":title,"Priority":"high","Tags":"chart_with_upwards_trend"},body:message,signal:AbortSignal.timeout(12000)});
  if(!r.ok){const retry=Number(r.headers.get("Retry-After"));const detail=await r.text().catch(()=>"");const e=Error("ntfy HTTP "+r.status+(Number.isFinite(retry)&&retry>0?"; retry after "+retry+" seconds":"")+(detail?"; "+detail.slice(0,180):""));e.status=r.status;e.retryAfterSeconds=Number.isFinite(retry)&&retry>0?retry:null;throw e;}
  return true;
}

export default {async fetch(request,env){
  const url=new URL(request.url),origin=request.headers.get("Origin")||"";
  if(request.method==="OPTIONS")return origin===ALLOWED_ORIGIN?new Response(null,{status:204,headers:corsHeaders()}):new Response(null,{status:403});
  if(url.pathname==="/health"&&request.method==="GET")return json({status:"online",service:"NGR Gold Alerts",kvConfigured:Boolean(env.ALERTS_KV),auth:"firebase-id-token",monitorIntervalSeconds:60,storageMode:"firebase-uid-array-v1",build:"firebase-auth-2026-11-27"});
  if(origin!==ALLOWED_ORIGIN)return json({error:"Origin not allowed"},403);
  if(!env.ALERTS_KV)return json({error:"Storage unavailable"},503);

  const user=await verifyUser(request);
  if(!user)return json({error:"Authentication required. Sign in with a verified Firebase account."},401);
  const key=USER_PREFIX+user.uid;

  // Move existing device-only alerts into the signed-in Firebase account once.
  if(url.pathname==="/claim-device"&&request.method==="POST"){
    try{
      const body=await request.json(),device=body?.deviceToken;
      if(typeof device!=="string"||!/^[a-f0-9]{64}$/i.test(device))return json({error:"Invalid legacy device token"},400);
      const legacyKey=LEGACY_PREFIX+device.toLowerCase();
      const legacy=await read(env,legacyKey),current=await read(env,key);
      const known=new Set(current.map(a=>a.id));
      const merged=[...current,...legacy.filter(a=>!known.has(a.id))].slice(0,MAX_ALERTS_PER_DEVICE);
      await write(env,key,merged);
      if(legacy.length)await env.ALERTS_KV.delete(legacyKey);
      return json({success:true,migrated:Math.min(legacy.length,Math.max(0,MAX_ALERTS_PER_DEVICE-current.length)),activeAlerts:merged.length});
    }catch(e){return json({error:"Could not migrate existing alerts",detail:String(e?.message||e)},503);}
  }

  if(url.pathname==="/test-notification"&&request.method==="POST"){
    try{const b=await request.json(),topic=b?.topic;if(!validTopic(topic))return json({error:"Invalid ntfy topic"},400);await sendNtfy(topic,"NGR TRADES PRO · Test notification","Success! Your NGR TRADES PRO notification route reached ntfy. Check that this message appears on your phone. This test does not verify future market alerts.");return json({success:true,acceptedByNtfy:true,message:"ntfy accepted the test notification"});}
    catch(e){const status=e?.status===429?429:502;return json({error:"Test notification failed",detail:String(e?.message||e),retryAfterSeconds:e?.retryAfterSeconds||null},status);}
  }
  if(url.pathname==="/price"&&request.method==="GET"){try{return json(await getFreshPrice());}catch(e){return json({error:"Price feed unavailable",detail:String(e?.message||e)},503);}}
  if(url.pathname==="/alerts"&&request.method==="GET"){try{return json({alerts:await read(env,key)});}catch(e){return json({error:"Alert storage failed",detail:String(e?.message||e)},503);}}
  if(url.pathname==="/alerts"&&request.method==="POST"){
    try{
      if(!(request.headers.get("Content-Type")||"").toLowerCase().includes("application/json"))return json({error:"JSON required"},415);
      const raw=await request.text();if(raw.length>4096)return json({error:"Too large"},413);let b;try{b=JSON.parse(raw);}catch{return json({error:"Invalid JSON"},400);}
      const level=Number(b.level),condition=b.condition,expiry=ALLOWED_EXPIRY.has(b.expiry)?b.expiry:"Until deleted",topic=b.topic;
      if(!Number.isFinite(level)||level<=0||level>1000000||!["above","below"].includes(condition)||!validTopic(topic))return json({error:"Invalid target, condition or topic"},400);
      const alerts=await read(env,key);if(alerts.length>=MAX_ALERTS_PER_DEVICE)return json({error:"Limit of 20 alerts per account"},429);
      const now=Date.now(),alert={id:crypto.randomUUID(),symbol:"XAUUSD",condition,level,topic,createdAt:now,expiry,expiresAt:expiryTime(expiry,now)};
      alerts.push(alert);await env.ALERTS_KV.put(key,JSON.stringify(alerts));return json({success:true,alert},201);
    }catch(e){console.log("Alert create error:",e?.message||e);return json({error:"Alert storage failed",detail:String(e?.message||e)},503);}
  }
  if(url.pathname==="/alerts"&&request.method==="DELETE"){
    try{const id=url.searchParams.get("id");if(!id||!/^[a-f0-9-]{36}$/i.test(id))return json({error:"Invalid ID"},400);const alerts=await read(env,key);await write(env,key,alerts.filter(a=>a.id!==id));return json({success:true});}
    catch(e){return json({error:"Alert storage failed",detail:String(e?.message||e)},503);}
  }
  return json({error:"Not found"},404);
},async scheduled(controller,env,ctx){ctx.waitUntil(checkAlerts(env));}};

async function checkAlerts(env){
  if(!env.ALERTS_KV)return;
  try{
    for(const prefix of [USER_PREFIX,LEGACY_PREFIX]){
      let page=await env.ALERTS_KV.list({prefix,limit:100}),cursor=page.list_complete?undefined:page.cursor,market=null;
      while(true){
        for(const k of page.keys){
          let alerts=await read(env,k.name);
          if(!alerts.length){await env.ALERTS_KV.delete(k.name);continue;}
          if(!market)market=await getFreshPrice();
          const keep=[];let changed=false;
          for(const a of alerts){
            if(a.retryAfterAt&&Date.now()<a.retryAfterAt){keep.push(a);continue;}
            const hit=a.condition==="above"?market.price>=a.level:market.price<=a.level;
            if(!hit){keep.push(a);continue;}
            const msg=["NGR TRADES PRO | XAU/USD","Target "+a.condition+": $"+Number(a.level).toFixed(2),"Observed spot price: $"+market.price.toFixed(2),"Price timestamp: "+market.updatedAt,"Indicative spot price; broker prices may differ. Verify before acting."].join("\\n");
            try{await sendNtfy(a.topic,"NGR Gold Price Alert",msg);changed=true;console.log("ntfy accepted alert:",a.id);}
            catch(e){if(e?.status===429){const delay=(e.retryAfterSeconds||900)*1000;a.retryAfterAt=Date.now()+delay;changed=true;console.log("ntfy rate limited; alert paused until retry:",a.id,delay);}keep.push(a);console.log("Alert delivery failed; will retry:",a.id,e?.message||e);}
          }
          if(changed||keep.length!==alerts.length)await write(env,k.name,keep);
        }
        if(!cursor)break;
        page=await env.ALERTS_KV.list({prefix,cursor,limit:100});cursor=page.list_complete?undefined:page.cursor;
      }
    }
  }catch(e){console.log("Scheduled alert check failed:",e?.message||e);}
}