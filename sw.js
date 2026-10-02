// Multi-Tenant Service Worker for Dolphin User Site (userd.jini24.in)
// Supports dynamic per-shop app names and custom logos configured in admind.jini24.in
const CACHE_NAME = 'shop-pwa-v15';

// In-memory store for active shop manifest, icons and logos
const shopManifests = {};
const shopLogos = {};
const shopNames = {};

// Strip social/tracking params (fbclid, gclid, utm_*, etc.) from a query string so
// the manifest "id"/"start_url" stay stable regardless of where the visitor came from.
function cleanQuery(q) {
    try {
        const p = new URLSearchParams(q || '');
        const parts = [];
        p.forEach((val, key) => {
            if (/^(fbclid|fbclick|fb_active_token|fb_comment_id|__cft__|gclid|msclkid|ttclid|igshid|yclid|mc_cid|mc_eid|_hsenc|_hsmi|utm_source|utm_medium|utm_campaign|utm_term|utm_content|utm_id|utm_reader)$/i.test(key)) return;
            parts.push(key + (val ? '=' + val : ''));
        });
        if (!parts.length) return '';
        return '?' + parts.join('&');
    } catch (e) {
        return q || '';
    }
}

// Extract shop identifier from request URL or Referrer
function getShopKeyFromRequest(request, url) {
    let key = url.searchParams.get('u') || url.searchParams.get('id');
    if (!key) {
        const cleanSearch = cleanQuery(url.search);
        if (cleanSearch.length > 1) {
            key = cleanSearch.substring(1).split('&')[0].split('=')[0];
        }
    }
    if (!key && request.referrer) {
        try {
            const refUrl = new URL(request.referrer);
            key = refUrl.searchParams.get('u') || refUrl.searchParams.get('id');
            if (!key && refUrl.search.length > 1) {
                key = cleanQuery(refUrl.search).substring(1).split('&')[0].split('=')[0];
            }
        } catch (e) { }
    }
    return (key && key !== 'active') ? key : null;
}

// Convert Base64 Data URI to a clean Response object
function dataUriToResponse(dataUri) {
    try {
        if (!dataUri || typeof dataUri !== 'string') return null;
        const commaIdx = dataUri.indexOf(',');
        if (commaIdx === -1) return null;
        const header = dataUri.substring(0, commaIdx);
        const base64Data = dataUri.substring(commaIdx + 1);
        const mimeMatch = header.match(/:(.*?);/);
        const mimeType = mimeMatch ? mimeMatch[1] : 'image/png';
        const binaryString = atob(base64Data);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        return new Response(bytes.buffer, {
            headers: {
                'Content-Type': mimeType,
                'Cache-Control': 'public, max-age=31536000'
            }
        });
    } catch (e) {
        return null;
    }
}

// Assets to pre-cache on install (only core shell - dynamic manifest is never precached statically)
const PRECACHE_ASSETS = [
    './',
    './index.html',
    './css/style.css',
    './js/supabase-config.js',
    './js/shop-products.js',
    './victory.wav'
];

self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then(async (cache) => {
            await Promise.all(
                PRECACHE_ASSETS.map((asset) =>
                    cache.add(asset).catch((err) => {
                        console.warn('Pre-cache skip:', asset, err && err.message);
                    })
                )
            );
        })
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.map((key) => {
                    if (key !== CACHE_NAME) {
                        return caches.delete(key);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});

// Helper to store image response into shop-scoped and generic icon paths
function putIconInCache(cache, res, shopKey) {
    const urls = [];
    if (shopKey && shopKey !== 'active') {
        urls.push(
            'pwa-icon-512.png?u=' + encodeURIComponent(shopKey),
            './pwa-icon-512.png?u=' + encodeURIComponent(shopKey),
            '/pwa-icon-512.png?u=' + encodeURIComponent(shopKey),
            'pwa-icon-192.png?u=' + encodeURIComponent(shopKey),
            './pwa-icon-192.png?u=' + encodeURIComponent(shopKey),
            '/pwa-icon-192.png?u=' + encodeURIComponent(shopKey),
            'pwa-icon-512.png?' + encodeURIComponent(shopKey),
            './pwa-icon-512.png?' + encodeURIComponent(shopKey),
            'pwa-icon-192.png?' + encodeURIComponent(shopKey),
            './pwa-icon-192.png?' + encodeURIComponent(shopKey)
        );
    }
    return Promise.all(urls.map((u) => cache.put(u, res.clone()).catch(() => { })));
}

// Listen for dynamic shop configuration messages from index.html
self.addEventListener('message', (event) => {
    if (!event.data) return;

    if (event.data.type === 'SET_SHOP_MANIFEST') {
        const manifest = event.data.manifest;
        const shopKey = event.data.shopKey || 'active';
        const logoUrl = event.data.logoUrl || (manifest && manifest.icons && manifest.icons[0] && manifest.icons[0].src) || null;
        const shopName = event.data.shopName || (manifest && manifest.name) || '';

        if (shopKey && shopKey !== 'active') {
            shopManifests[shopKey] = manifest;
            if (shopName) shopNames[shopKey] = shopName;
            if (logoUrl) shopLogos[shopKey] = logoUrl;
        }

        if (logoUrl) {
            if (logoUrl.startsWith('data:')) {
                const imgRes = dataUriToResponse(logoUrl);
                if (imgRes) {
                    caches.open(CACHE_NAME).then((cache) => putIconInCache(cache, imgRes, shopKey));
                }
            } else if (logoUrl.startsWith('http://') || logoUrl.startsWith('https://')) {
                fetch(logoUrl, { mode: 'cors' }).then((res) => {
                    if (!res.ok && res.type !== 'opaque' && !res.type.includes('basic')) return;
                    caches.open(CACHE_NAME).then((cache) => putIconInCache(cache, res, shopKey));
                }).catch(() => { });
            }
        }

        // Persist dynamic manifest to CacheStorage for this shop
        caches.open(CACHE_NAME).then((cache) => {
            const makeRes = () => new Response(JSON.stringify(manifest), {
                headers: {
                    'Content-Type': 'application/manifest+json',
                    'Cache-Control': 'no-cache'
                }
            });
            if (shopKey && shopKey !== 'active') {
                cache.put('./manifest.json?' + encodeURIComponent(shopKey), makeRes()).catch(() => { });
                cache.put('/manifest.json?' + encodeURIComponent(shopKey), makeRes()).catch(() => { });
                cache.put('manifest.json?' + encodeURIComponent(shopKey), makeRes()).catch(() => { });
                cache.put('./manifest.json?u=' + encodeURIComponent(shopKey), makeRes()).catch(() => { });
                cache.put('/manifest.json?u=' + encodeURIComponent(shopKey), makeRes()).catch(() => { });
                cache.put('manifest.json?u=' + encodeURIComponent(shopKey), makeRes()).catch(() => { });
            }
        });
    }

    if (event.data.type === 'CACHE_SHOP_ICON') {
        const { url, base64, shopKey } = event.data;
        if (base64) {
            if (shopKey && shopKey !== 'active') {
                shopLogos[shopKey] = base64;
            }
            const res = dataUriToResponse(base64);
            if (res) {
                caches.open(CACHE_NAME).then((cache) => {
                    putIconInCache(cache, res, shopKey);
                    if (url) cache.put(url, res.clone()).catch(() => { });
                });
            }
        }
    }
});

// Fetch event listener
self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;
    if (!event.request.url.startsWith('http')) return;

    const url = new URL(event.request.url);

    // Dynamic Shop Manifest interception for Multi-Tenant / Multi-Business
    if (url.pathname.endsWith('/manifest.json') || url.pathname.includes('manifest.json')) {
        const shopKey = getShopKeyFromRequest(event.request, url);

        if (shopKey) {
            // 1. Check in-memory manifest for this specific shop
            if (shopManifests[shopKey]) {
                const finalManifest = Object.assign({}, shopManifests[shopKey]);
                event.respondWith(
                    new Response(JSON.stringify(finalManifest), {
                        headers: {
                            'Content-Type': 'application/manifest+json',
                            'Cache-Control': 'no-cache'
                        }
                    })
                );
                return;
            }

            // 2. Check CacheStorage for this shop's specific cached manifest
            event.respondWith(
                caches.open(CACHE_NAME).then((cache) => {
                    return cache.match('./manifest.json?u=' + encodeURIComponent(shopKey))
                        .then((cRes) => {
                            if (cRes) return cRes;
                            return cache.match('./manifest.json?' + encodeURIComponent(shopKey));
                        })
                        .then((cRes) => {
                            if (cRes) return cRes;
                            return cache.match('manifest.json?u=' + encodeURIComponent(shopKey));
                        })
                        .then((cached) => {
                            if (cached) return cached;

                            // 3. Fallback: generate a dynamic shop manifest on the fly
                            const displayName = (shopNames[shopKey] || shopKey.toUpperCase()) + ' Store';
                            const dynamicManifest = {
                                id: './?' + encodeURIComponent(shopKey),
                                name: displayName,
                                short_name: shopNames[shopKey] || shopKey,
                                description: 'Order from ' + displayName + ' online with fast delivery.',
                                start_url: './?' + encodeURIComponent(shopKey),
                                scope: './',
                                display: 'standalone',
                                orientation: 'portrait',
                                background_color: '#ffffff',
                                theme_color: '#0f6425',
                                icons: [
                                    { src: 'pwa-icon-192.png?u=' + encodeURIComponent(shopKey), sizes: '192x192', type: 'image/png', purpose: 'any' },
                                    { src: 'pwa-icon-192.png?u=' + encodeURIComponent(shopKey), sizes: '192x192', type: 'image/png', purpose: 'maskable' },
                                    { src: 'pwa-icon-512.png?u=' + encodeURIComponent(shopKey), sizes: '512x512', type: 'image/png', purpose: 'any' },
                                    { src: 'pwa-icon-512.png?u=' + encodeURIComponent(shopKey), sizes: '512x512', type: 'image/png', purpose: 'maskable' }
                                ]
                            };
                            return new Response(JSON.stringify(dynamicManifest), {
                                headers: {
                                    'Content-Type': 'application/manifest+json',
                                    'Cache-Control': 'no-cache'
                                }
                            });
                        });
                })
            );
            return;
        }

        // Generic manifest fallback (no shop parameter detected)
        event.respondWith(
            fetch(event.request).catch(() => caches.match(event.request))
        );
        return;
    }

    // Dynamic square shop icon interception
    if (url.pathname.includes('icon-192') || url.pathname.includes('icon-512') || url.pathname.includes('pwa-icon')) {
        const shopKey = getShopKeyFromRequest(event.request, url);

        if (shopKey) {
            // 1. First priority: Check in-memory shopLogos for this shop
            const targetLogo = shopLogos[shopKey];
            if (targetLogo) {
                if (targetLogo.startsWith('data:')) {
                    const decodedRes = dataUriToResponse(targetLogo);
                    if (decodedRes) {
                        event.respondWith(decodedRes);
                        return;
                    }
                } else if (targetLogo.startsWith('http://') || targetLogo.startsWith('https://')) {
                    event.respondWith(
                        fetch(targetLogo, { mode: 'cors' }).catch(() => caches.match(event.request))
                    );
                    return;
                }
            }

            // 2. Second priority: Check CacheStorage for shop-scoped icon
            event.respondWith(
                caches.open(CACHE_NAME).then((cache) => {
                    return cache.match('pwa-icon-512.png?u=' + encodeURIComponent(shopKey))
                        .then((sCached) => {
                            if (sCached) return sCached;
                            return cache.match('pwa-icon-192.png?u=' + encodeURIComponent(shopKey));
                        })
                        .then((sCached) => {
                            if (sCached) return sCached;
                            return cache.match('./pwa-icon-512.png?u=' + encodeURIComponent(shopKey));
                        })
                        .then((sCached) => {
                            if (sCached) return sCached;
                            return cache.match(event.request);
                        })
                        .then((cached) => {
                            if (cached) return cached;
                            return fetch(event.request);
                        });
                })
            );
            return;
        }

        // Standard icon fetch
        event.respondWith(
            caches.match(event.request).then((cached) => {
                if (cached) return cached;
                return fetch(event.request);
            })
        );
        return;
    }

    // Standard static and navigation requests
    event.respondWith(
        fetch(event.request)
            .then((response) => response)
            .catch(() => {
                return caches.match(event.request).then((cachedResponse) => {
                    if (cachedResponse) return cachedResponse;
                    if (event.request.mode === 'navigate') {
                        return caches.match('./index.html');
                    }
                });
            })
    );
});
