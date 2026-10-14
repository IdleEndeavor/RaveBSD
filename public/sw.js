// Only here so notifications work on phones (Android Chrome only shows them through a service worker).
// It caches nothing and never touches requests.
self.addEventListener('notificationclick', e => {
    e.notification.close();
    e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
        const c = list.find(w => new URL(w.url).origin === self.location.origin);
        if (c) return c.focus().then(w => w && w.navigate && w.navigate('/shelf'));
        return self.clients.openWindow('/shelf');
    }));
});
