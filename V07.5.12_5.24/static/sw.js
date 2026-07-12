var CACHE_NAME = 'zhixing-kb-v1';
var URLS_TO_CACHE = [
    '/',
    '/static/style.css',
    '/static/app.js',
    '/upload/logo.png',
    '/upload/backgr.png'
];

self.addEventListener('install', function(e){
    e.waitUntil(
        caches.open(CACHE_NAME).then(function(cache){
            return cache.addAll(URLS_TO_CACHE);
        })
    );
    self.skipWaiting();
});

self.addEventListener('activate', function(e){
    e.waitUntil(
        caches.keys().then(function(names){
            return Promise.all(
                names.filter(function(n){ return n !== CACHE_NAME; })
                    .map(function(n){ return caches.delete(n); })
            );
        })
    );
    self.clients.claim();
});

self.addEventListener('fetch', function(e){
    // 只缓存同源 GET 请求
    if(e.request.method !== 'GET') return;
    // API 请求走网络优先
    if(e.request.url.indexOf('/api/') !== -1) return;
    e.respondWith(
        caches.match(e.request).then(function(resp){
            return resp || fetch(e.request).then(function(response){
                // 缓存新资源
                if(response.status === 200){
                    var clone = response.clone();
                    caches.open(CACHE_NAME).then(function(cache){
                        cache.put(e.request, clone);
                    });
                }
                return response;
            });
        }).catch(function(){
            // 离线时返回缓存首页
            if(e.request.mode === 'navigate'){
                return caches.match('/');
            }
        })
    );
});
