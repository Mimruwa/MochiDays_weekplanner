const CACHE='mochi-days-cute-v3';
const ASSETS=['./','./index.html','./cloud.js','./cloud-config.js','./theme.css','./assets/mochi-heart.svg','./assets/mochi-pencil.svg','./assets/mochi-flower.svg','./assets/mochi-peek.svg','./manifest.webmanifest','./icon.svg','./icon-192.png','./icon-512.png'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('mochi-days-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET' || new URL(event.request.url).origin!==self.location.origin) return;
  event.respondWith(fetch(event.request).then(response=>{
    if(response.ok){ const copy=response.clone(); caches.open(CACHE).then(cache=>cache.put(event.request,copy)); }
    return response;
  }).catch(()=>caches.match(event.request)));
});
