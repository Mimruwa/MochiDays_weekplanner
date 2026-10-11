/* Mochi Days Cloud-Ready Beta: own-account data, sign-in, per-entry cloud sync.
   Prototype code only; deployment, RLS policy checks and multi-device testing required. */
(() => {
  'use strict';
  const cfg = window.MOCHI_CLOUD_CONFIG || {};
  const BASE = (cfg.url || '').replace(/\/+$/, '');
  const KEY = cfg.publishableKey || '';
  const configured = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(BASE) && KEY.length > 10;
  const AUTHKEY = 'mochi_days_beta_auth';
  const stores = ['days', 'weeks', 'months', 'habits', 'drawings'];
  let session = null, syncRunning = false, syncTimer = 0, modal = null;
  let history = {}, stamps = {}, syncingDisabled = false, lastError = '';
  const bridge = window.mochiBridge;
  const now = () => Date.now();
  const byId = (id) => document.getElementById(id);
  const deepClone = (v) => JSON.parse(JSON.stringify(v));
  const jsonEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const status = (str, cls) => { const el = byId('cloudStatus'); if (el) {el.textContent=str; el.dataset.state=cls||'';} };
  const setHead = () => {
    const b = byId('cloudButton');
    if (b) b.textContent = !configured ? '☁ My Account' : session?.user?.email ? '☁ ' + session.user.email.split('@')[0] : '☁ My Account';
  };
  const mkMetaKey = () => 'mochi_days_modtimes_' + (session?.user?.id || 'guest');
  function readMeta(){ try{ stamps = JSON.parse(localStorage.getItem(mkMetaKey()) || '{}'); }catch(_){stamps={};} }
  function saveMeta(){ try{localStorage.setItem(mkMetaKey(), JSON.stringify(stamps));}catch(_){} }
  function allRecords(data){
    const records = {};
    for(const k of stores) for(const [id,value] of Object.entries(data[k] || {})) records[k + '::' + id] = {category:k,item_key:id,value};
    return records;
  }
  function resetHistory(){ history = allRecords(bridge.getData()); readMeta(); for (const key of Object.keys(history)) if (!stamps[key]) stamps[key] = 1; saveMeta(); }
  function detectChanges(){
    if(syncingDisabled) return;
    const current = allRecords(bridge.getData());
    let changed = false;
    for(const [key,item] of Object.entries(current)){
      if (!history[key] || !jsonEq(item.value,history[key].value)) {
        stamps[key] = now(); changed = true;
      }
    }
    history = current;
    if(changed) {saveMeta(); scheduleSync();}
  }
  window.mochiOnLocalSave = detectChanges;
  function readSession(){
    try{session=JSON.parse(localStorage.getItem(AUTHKEY)||'null')}catch(_){session=null;}
    if(!session?.refresh_token || !session?.user?.id) session=null;
  }
  function storeSession(s){
    session=s;
    if(s) localStorage.setItem(AUTHKEY,JSON.stringify(s));
    else localStorage.removeItem(AUTHKEY);
    setHead();
  }
  async function request(path, method, body, token, additional){
    if(!configured) throw Error('Cloud is not configured yet.');
    const headers = {'apikey':KEY,'content-type':'application/json', ...(additional||{})};
    if(token) headers.Authorization = 'Bearer ' + token;
    const r = await fetch(BASE + path, {method, headers, body: body == null ? undefined : JSON.stringify(body)});
    const raw=await r.text(); let data;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
    if(!r.ok) throw Error((typeof data==='object' && (data?.msg || data?.error_description || data?.message || data?.error)) || `Request failed (${r.status})`);
    return data;
  }
  async function freshAccessToken(){
    if(!session) throw Error('Please sign in first');
    if(now() < session.expiresAt - 90000) return session.access_token;
    const s=await request('/auth/v1/token?grant_type=refresh_token','POST',{refresh_token:session.refresh_token});
    if(!s?.access_token) throw Error('Please sign in again');
    storeSession({...s,expiresAt:now()+1000*(s.expires_in||3600)});
    return session.access_token;
  }
  async function startAccount(s){
    if(!s?.user?.id) throw Error('Missing account details');
    storeSession({...s,expiresAt:now()+1000*(s.expires_in||3600)});
    syncingDisabled=true; bridge.loadAccount(s.user.id); syncingDisabled=false;
    resetHistory();
    renderAuth();
    await sync({quiet:false});
  }
  function scheduleSync(){
    clearTimeout(syncTimer);
    if(session && configured) syncTimer=setTimeout(()=>sync({quiet:true}),2500);
  }
  async function sync(options={}){
    const quiet=Boolean(options.quiet);
    if(!configured || !session || syncRunning || !navigator.onLine) return;
    syncRunning=true;
    try {
      status('Syncing your planner…');
      const token=await freshAccessToken();
      const query='/rest/v1/planner_items?select=category,item_key,value,client_updated_at&limit=10000';
      const remote=await request(query,'GET',null,token);
      if(!Array.isArray(remote)) throw Error('Unexpected database response. Check database setup.');
      const remoteByKey={};
      for(const r of remote) remoteByKey[r.category+'::'+r.item_key]=r;
      const localRecords=allRecords(bridge.getData());
      const merged=deepClone(bridge.getData());
      let received=0;
      for(const [key,rr] of Object.entries(remoteByKey)){
        if(!stores.includes(rr.category) || typeof rr.item_key!=='string') continue;
        const localTime=Number(stamps[key]||0), remoteTime=Number(rr.client_updated_at||0);
        if(remoteTime > localTime || !(key in localRecords)){
          merged[rr.category][rr.item_key]=rr.value;
          stamps[key]=remoteTime; received++;
        }
      }
      if(received){
        syncingDisabled=true; bridge.applyRemote(merged); syncingDisabled=false;
      }
      const updated=allRecords(bridge.getData());
      const push=[];
      for(const [key,item] of Object.entries(updated)){
        const server=remoteByKey[key];
        const time=Number(stamps[key]||1);
        if(!server || time>Number(server.client_updated_at||0)){
          const payload=JSON.stringify(item.value);
          if(payload.length>750000){lastError='One drawing is too large to cloud-sync. Export a backup and draw smaller strokes.';continue;}
          push.push({user_id:session.user.id,category:item.category,item_key:item.item_key,value:item.value,client_updated_at:time});
        }
      }
      // Limit each request: handwritten PNG drawings can be large.
      for(let i=0;i<push.length;i+=10){
        await request('/rest/v1/planner_items?on_conflict=user_id,category,item_key','POST',push.slice(i,i+10),token,{'Prefer':'resolution=merge-duplicates,return=minimal'});
      }
      history=updated;saveMeta();
      const stamp=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
      status(lastError ? `Synced at ${stamp} · ${lastError}` : `✓ Cloud synced at ${stamp} · ${received} received / ${push.length} uploaded`,'ok');
      lastError='';
    }catch(e){
      lastError=e.message;
      status('Cloud sync paused: '+lastError,'error');
      if(!quiet) console.warn('Mochi Days sync:',e);
    }finally{syncingDisabled=false; syncRunning=false;}
  }
  async function loginOrSignup(type){
    const email=byId('cloudEmail')?.value.trim().toLowerCase(),password=byId('cloudPassword')?.value;
    if(!email || !password){status('Enter your email and password','error');return;}
    if(password.length<8){status('Use a password of at least 8 characters','error');return;}
    status(type==='signup'?'Creating account…':'Signing in…');
    try{
      const path=type==='signup'?'/auth/v1/signup':'/auth/v1/token?grant_type=password';
      const data=await request(path,'POST',{email,password});
      if(!data?.access_token){status('Account created. Check your email for confirmation, then sign in.','ok');return;}
      await startAccount(data);
    }catch(e){status(e.message,'error');}
    finally{if(byId('cloudPassword'))byId('cloudPassword').value='';}
  }
  async function logout(){
    if(!confirm('Sign out? Your cloud data remains saved in your account.'))return;
    // Revocation is best effort. We still clear the local session.
    try{await request('/auth/v1/logout','POST',null,await freshAccessToken())}catch(_){}
    storeSession(null);syncingDisabled=true;bridge.loadAccount(null);syncingDisabled=false;resetHistory();renderAuth();status('Signed out. Showing guest/device data.','ok');
  }
  function renderAuth(){
    if(!modal)return;
    const area=byId('cloudAuth'); if(!area)return;
    if(!configured){
      area.innerHTML='<div class="cloud-info"><b>🌷 Your little plans are safe here!</b><p>Cloud sync is not available in this preview yet. Your plans are saved on this device—please keep a backup in <b>My Backups</b> until syncing is ready.</p></div>';
      status('♡ Saved on this device · cloud sync coming soon');
      return;
    }
    if(session){
      area.innerHTML='<p><b>Signed in:</b> <span id="cloudWho"></span></p><div class="cloud-actions"><button id="cloudSyncNow" type="button">↻ Sync now</button><button id="cloudSignOut" type="button">Sign out</button></div><p class="cloud-small">Changes save on your device first and sync while online. This is beta: if you edit the same day on two devices simultaneously, the last edit may win. Export backups regularly.</p>';
      byId('cloudWho').textContent=session.user.email||session.user.id;
      byId('cloudSyncNow').onclick=()=>sync({quiet:false});
      byId('cloudSignOut').onclick=logout;
    }else{
      area.innerHTML='<label>Email<input id="cloudEmail" type="email" autocomplete="username" placeholder="you@example.com"></label><label>Password<input id="cloudPassword" type="password" autocomplete="current-password" placeholder="At least 8 characters"></label><div class="cloud-actions"><button id="cloudLogin" type="button">Log in</button><button id="cloudSignup" type="button">Create account</button></div><p class="cloud-small">Account data is kept separate from guest/device data. Download a guest backup before signing in if you want to preserve it. Email confirmation may be required.</p>';
      byId('cloudLogin').onclick=()=>loginOrSignup('login');
      byId('cloudSignup').onclick=()=>loginOrSignup('signup');
      status('♡ Ready to welcome you back');
    }
  }
  function buildModal(){
    const style=document.createElement('style');
    style.textContent=`.cloud-modal{position:fixed;inset:0;background:#38212a99;display:none;z-index:9999;padding:15px;align-items:center;justify-content:center}.cloud-modal.open{display:flex}.cloud-card{width:min(490px,100%);max-height:90vh;overflow-y:auto;background:#fffdf5;border:3px solid #e8bdce;border-radius:24px;box-shadow:0 20px 60px #4d213a55;padding:23px;color:#503444}.cloud-header{display:flex;align-items:center;justify-content:space-between;gap:8px}.cloud-header h2{margin:0;font-size:27px;font-family:'Fredoka','Trebuchet MS',sans-serif;font-weight:700}.cloud-header button{font-size:20px;border:0;background:transparent;padding:8px}.cloud-card label{display:block;margin-top:10px;font-size:13px;font-weight:bold}.cloud-card label input{display:block;width:100%;font-size:15px;border:1px solid #d8bbc5;border-radius:12px;background:#fff;padding:11px;margin-top:5px}.cloud-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:15px}.cloud-actions button{padding:12px 18px;border-radius:999px;background:#ffe0eb;border:2px solid #d3aebf;font-family:'Fredoka','Trebuchet MS',sans-serif;font-weight:700;font-size:15px}.cloud-small{font-size:12px;color:#8a727c;line-height:1.6}.cloud-info{background:#edf9ee;padding:12px;border-radius:12px;font-size:13px;line-height:1.6}.cloud-status{border-radius:11px;background:#f6e8f0;padding:10px;margin-top:17px;font-size:12px;overflow-wrap:anywhere}.cloud-status[data-state="error"]{background:#fff0d7;color:#944b32}.cloud-status[data-state="ok"]{background:#e8f5e8;color:#386740}`;
    document.head.append(style);
    modal=document.createElement('div');modal.className='cloud-modal';modal.id='cloudModal';modal.innerHTML='<section class="cloud-card" role="dialog" aria-modal="true" aria-labelledby="cloudTitle"><div class="cloud-header"><h2 id="cloudTitle">☁ My Cozy Account ♡</h2><button type="button" id="cloudClose" aria-label="Close">✕</button></div><p class="cloud-small">Keep your little plans together ✿</p><div id="cloudAuth"></div><div class="cloud-status" id="cloudStatus">Local save is available.</div></section>';
    document.body.append(modal);
    byId('cloudClose').onclick=()=>modal.classList.remove('open');
    modal.onclick=e=>{if(e.target===modal)modal.classList.remove('open')};
    document.addEventListener('keydown',e=>{if(e.key==='Escape')modal.classList.remove('open')});
    byId('cloudButton').onclick=()=>{modal.classList.add('open');renderAuth()};
  }
  async function boot(){
    buildModal();readSession();setHead();
    if(session){
      syncingDisabled=true;bridge.loadAccount(session.user.id);syncingDisabled=false;resetHistory();
      if(configured && navigator.onLine) await sync({quiet:true});
    }else resetHistory();
    if(configured){
      setInterval(()=>{if(session && navigator.onLine)sync({quiet:true})},60000);
      window.addEventListener('online',()=>{if(session)sync({quiet:true})});
      document.addEventListener('visibilitychange',()=>{if(!document.hidden && session)sync({quiet:true})});
    }
  }
  boot().catch(e=>console.warn('Mochi Days cloud init:',e));
})();
