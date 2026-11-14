/* خدمة الإشعارات: تستقبل الرسائل من السيرفر وتعرضها حتى لو الصفحة مقفلة */
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('push',e=>{
  let d={};try{d=e.data?e.data.json():{}}catch(_){d={t:'تقسيمة بوبيبي',b:e.data?e.data.text():''}}
  e.waitUntil(self.registration.showNotification(d.t||'تقسيمة بوبيبي',{body:d.b||'',icon:'/icon-192.png',badge:'/icon-192.png',dir:'rtl',lang:'ar',data:{u:d.u||'/'}}));
});
self.addEventListener('notificationclick',e=>{
  e.notification.close();
  const u=(e.notification.data&&e.notification.data.u)||'/';
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(cs=>{
    for(const c of cs){if('focus' in c)return c.focus()}
    return self.clients.openWindow(u);
  }));
});
