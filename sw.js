// ============================================================================
// しりすこPAD Service Worker (Phase 6a)
// ----------------------------------------------------------------------------
// - Web Push 通知の受信ハンドラ
// - 通知タップで PAD を開く
// - キャッシュは現状なし（純粋に通知用）
// ============================================================================

self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
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
            // 既に開いていれば fokus
            for (const client of clientList) {
                if (client.url.endsWith(url) || client.url.includes('shirisu-pad')) {
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
