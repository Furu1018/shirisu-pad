// ============================================================================
// しりすこPAD Service Worker (Phase 6a)
// ----------------------------------------------------------------------------
// - Web Push 通知の受信ハンドラ
// - 通知タップで PAD を開く
// - キャッシュは「実質不変の画像のみ」(キャラ/属性アイコン)。
//   HTML/JS/データは main push 即反映の方針を守るためキャッシュしない
// ============================================================================

const IMG_CACHE = 'shirisu-img-v1';

self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        // 旧バージョンの画像キャッシュを掃除
        const keys = await caches.keys();
        await Promise.all(keys
            .filter(k => k.startsWith('shirisu-img-') && k !== IMG_CACHE)
            .map(k => caches.delete(k)));
        await self.clients.claim();
    })());
});

// ---- 画像キャッシュ (cache-first) ----
// 対象: character-images/ と 属性アイコン/ と icon.png のみ。
// ファイル名がハッシュ or 内容固定のため stale の心配がなく、
// 再訪問時の大量アイコン読み込みをネットワークゼロにできる。
self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;
    let url;
    try { url = new URL(req.url); } catch { return; }
    if (url.origin !== self.location.origin) return;
    const path = decodeURIComponent(url.pathname);
    const isImg = path.includes('/character-images/')
        || path.includes('/属性アイコン/')
        || path.endsWith('/icon.png');
    if (!isImg) return;
    event.respondWith(
        caches.open(IMG_CACHE).then(async (cache) => {
            const hit = await cache.match(req);
            if (hit) return hit;
            const resp = await fetch(req);
            if (resp && resp.ok) cache.put(req, resp.clone());
            return resp;
        })
    );
});

// Push受信
self.addEventListener('push', (event) => {
    let payload = { title: 'しりすこPAD', body: '' };
    try {
        if (event.data) {
            const text = event.data.text();
            try {
                payload = JSON.parse(text);
            } catch {
                payload = { title: 'しりすこPAD', body: text };
            }
        }
    } catch (e) {
        console.warn('[sw] push parse error', e);
    }

    const title = payload.title || 'しりすこPAD';
    const options = {
        body: payload.body || '',
        icon: payload.icon || './icon.png',
        badge: payload.badge || './icon.png',
        tag: payload.tag,
        renotify: !!payload.renotify,
        requireInteraction: !!payload.requireInteraction,
        data: {
            url: payload.url || './',
            ...payload.data,
        },
    };

    event.waitUntil(self.registration.showNotification(title, options));
});

// 通知タップ
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = (event.notification.data && event.notification.data.url) || './';

    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            // 既に開いていればフォーカスし、アプリ側に遷移先を伝える
            // (focus だけでは通知の url に移動しないため postMessage で誘導)
            for (const client of clientList) {
                if (client.url.endsWith(url) || client.url.includes('shirisu-pad')) {
                    client.postMessage({ type: 'navigate', url });
                    return client.focus();
                }
            }
            // なければ新規タブで開く
            if (self.clients.openWindow) {
                return self.clients.openWindow(url);
            }
        })
    );
});

// rebuild: 1783900000
