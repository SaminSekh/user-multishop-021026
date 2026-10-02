// Global variable to catch the install prompt early
let shopDeferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    shopDeferredPrompt = e;
});

// Set shop logo as favicon (works on public pages that don't load main.js)
function setFavicon(logoUrl) {
    if (!logoUrl) return;

    // If it's a base64 data URL (potentially large), resize it for favicon use
    if (logoUrl.startsWith('data:image')) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = function () {
            const canvas = document.createElement('canvas');
            canvas.width = 32;
            canvas.height = 32;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, 32, 32);
            const smallIcon = canvas.toDataURL('image/png');
            applyFavicon(smallIcon, 'image/png');
        };
        img.onerror = function () {
            // Fallback: use original URL directly
            applyFavicon(logoUrl, 'image/png');
        };
        img.src = logoUrl;
    } else {
        // External URL - use directly
        applyFavicon(logoUrl, 'image/png');
    }
}

function applyFavicon(href, mimeType) {
    document.querySelectorAll('link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]').forEach(el => el.remove());

    const favicon = document.createElement('link');
    favicon.rel = 'icon';
    favicon.type = mimeType;
    favicon.href = href;
    document.head.appendChild(favicon);

    const shortcutIcon = document.createElement('link');
    shortcutIcon.rel = 'shortcut icon';
    shortcutIcon.type = mimeType;
    shortcutIcon.href = href;
    document.head.appendChild(shortcutIcon);

    const appleFavicon = document.createElement('link');
    appleFavicon.rel = 'apple-touch-icon';
    appleFavicon.href = href;
    document.head.appendChild(appleFavicon);
}

// Image compression cache to avoid re-compressing same images
const _imgCompressCache = {};

/**
 * Compress an image URL client-side via canvas.
 * Returns a promise that resolves to a compressed data URL.
 * @param {string} url - Original image URL
 * @param {number} maxWidth - Max width in pixels (height scales proportionally)
 * @param {number} quality - JPEG quality 0-1
 * @returns {Promise<string>} Compressed data URL
 */
function compressImageUrl(url, maxWidth, quality) {
    // Disabled client-side base64 conversion to improve performance.
    // Serving direct image URLs is much faster.
    return Promise.resolve(url);
}

/**
 * Apply lazy compressed images to all elements with data-compress-src attribute.
 * Replaces placeholder with compressed version once loaded.
 */
function applyCompressedImages() {
    const elements = document.querySelectorAll('[data-compress-src]');
    elements.forEach(el => {
        const originalUrl = el.getAttribute('data-compress-src');
        const maxW = parseInt(el.getAttribute('data-compress-width')) || 400;
        const qual = parseFloat(el.getAttribute('data-compress-quality')) || 0.6;

        // Set original URL immediately so image is visible right away
        el.setAttribute('data-original-url', originalUrl);
        el.src = originalUrl;
        // Remove attribute now so the CSS opacity:0.3 rule no longer applies
        el.removeAttribute('data-compress-src');

        // Then swap to compressed version in the background when ready
        compressImageUrl(originalUrl, maxW, qual).then(compressed => {
            // Only replace if the element still shows the original (not already changed)
            if (el.getAttribute('data-original-url') === originalUrl) {
                el.src = compressed;
            }
        });
    });
}

// Public Shop Products Logic with Carousel, Theme Support and Cart
class ShopProductsViewer {
    constructor() {
        this.shopId = null;
        this.shopData = null;
        this.shopSettings = null;
        this.products = [];
        this.filteredProducts = [];
        this.types = new Set();
        this.cart = [];
        this.appliedDiscount = null;
        this.selectedType = 'all';
        this.selectedOrderMethod = 'whatsapp';
        this.currentSlide = 0;
        this.deferredPrompt = shopDeferredPrompt;
        this.systemDomains = { mgmt: '', public: '' };
        this.assetBase = '';
        this.apkPopupTimer = null;
        this.apkPopupInitialized = false;

        // Virtual try-on state (customer photo is never persisted)
        this.tryOn = {
            product: null,
            garmentUrl: '',
            garmentDataUrl: '',
            faceFile: null,
            faceDataUrl: '',
            faceUrl: '',
            busy: false
        };

        // Infinite Scroll with Pagination settings (10 items per batch)
        this.productsPerPage = 10;
        this.currentProductPage = 1;
        this.isLoadingNextBatch = false;
        this.infiniteScrollObserver = null;

        // Start 10s visit timer for app install popup
        this.initApkInstallPopup();

        this.init();
    }

    getAssetUrl(path) {
        if (!path) return '';
        if (path.startsWith('http') || path.startsWith('data:') || path.startsWith('blob:')) return path;
        if (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost' || !this.assetBase) {
            return path;
        }
        return `${this.assetBase}${path}`;
    }

    async init() {
        const urlParams = new URLSearchParams(window.location.search);
        let thisShopId = urlParams.get('id');
        let shopSlug = urlParams.get('u');

        // Check for "Short Style" URL (e.g. ?free)
        if (!thisShopId && !shopSlug && window.location.search.length > 1) {
            // Take the first parameter name as the slug
            shopSlug = window.location.search.substring(1).split('&')[0].split('=')[0];
        }

        if (!thisShopId && !shopSlug) {
            console.error('URL Search Params:', window.location.search);
            this.renderError('Could not identify the shop. The link appears to be incomplete (missing Shop ID or Unique Address).');
            return;
        }

        this.shopId = thisShopId;

        try {
            // Fetch Shop Data
            let shopQuery = supabaseClient.from('shops').select('*');

            if (shopSlug) {
                shopQuery = shopQuery.eq('slug', shopSlug);
            } else {
                shopQuery = shopQuery.eq('id', this.shopId);
            }

            const { data: shop, error: shopError } = await shopQuery.maybeSingle();

            if (shopError) {
                throw new Error(`Database Error: ${shopError.message}`);
            }

            if (!shop) {
                this.renderError('We couldn\'t find the shop you\'re looking for.');
                return;
            }

            // Check for restricted status (frozen or suspended)
            const status = shop.status || 'active';
            if (status.includes('frozen') || status.includes('suspended')) {
                const adminPhone = shop.admin_phone || '+91 00000 00000';
                const adminWA = shop.admin_whatsapp || adminPhone;
                const adminTG = shop.admin_telegram || '';

                const errorMsg = `
                    <div style="max-width: 600px; margin: 50px auto; background: white; padding: 40px; border-radius: 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.1); border-top: 6px solid #e74c3c;">
                        <i class="fas fa-exclamation-triangle" style="font-size: 60px; color: #e74c3c; margin-bottom: 20px;"></i>
                        <h2 style="font-size: 24px; color: #333; margin-bottom: 15px;">Shop Temporarily Unavailable</h2>
                        <p style="color: #666; line-height: 1.6; margin-bottom: 30px;">
                            This shop has been suspended by the system administrator. 
                            Please contact the administrator directly using the options below:
                        </p>
                        <div style="display: grid; gap: 10px;">
                            <a href="tel:${adminPhone}" style="display: block; padding: 15px; background: #f8f9fa; color: #333; text-decoration: none; border-radius: 10px; font-weight: 700;">
                                <i class="fas fa-phone"></i> Call Admin: ${adminPhone}
                            </a>
                            <a href="https://wa.me/${adminWA.replace(/\D/g, '')}" target="_blank" style="display: block; padding: 15px; background: #e8f5e9; color: #2e7d32; text-decoration: none; border-radius: 10px; font-weight: 700;">
                                <i class="fab fa-whatsapp"></i> WhatsApp Admin
                            </a>
                            ${adminTG ? `
                                <a href="https://t.me/${adminTG.replace('@', '')}" target="_blank" style="display: block; padding: 15px; background: #e3f2fd; color: #1565c0; text-decoration: none; border-radius: 10px; font-weight: 700;">
                                    <i class="fab fa-telegram"></i> Telegram Admin
                                </a>
                            ` : ''}
                        </div>
                    </div>
                `;
                this.renderError(errorMsg);
                return;
            }
            this.shopData = shop;
            this.shopId = shop.id;

            // Load settings, system domains, and products in PARALLEL
            const [settingsResult, domainsResult, productsResult] = await Promise.all([
                supabaseClient.from('shop_settings').select('*').eq('shop_id', this.shopId).maybeSingle(),
                supabaseClient.from('system_configs').select('key, value').or('key.eq.mgmt_domain,key.eq.public_shop_domain'),
                this.fetchProducts()
            ]);

            // Process settings
            if (settingsResult.error) {
                console.warn('Settings load error (Non-critical):', settingsResult.error);
            }
            this.shopSettings = settingsResult.data || {};
            if (this.shopSettings && this.shopSettings.google_sheet_url) {
                window._sheetUrl = String(this.shopSettings.google_sheet_url).trim();
                if (typeof window.recordVisitorVisit === 'function') {
                    setTimeout(() => { window.recordVisitorVisit(); }, 300);
                }
            }
            if (domainsResult.data) {
                domainsResult.data.forEach(cfg => {
                    const cleanValue = cfg.value ? cfg.value.replace(/^https?:\/\//, '').split('/')[0].trim() : '';
                    if (cfg.key === 'mgmt_domain') this.systemDomains.mgmt = cleanValue;
                    if (cfg.key === 'public_shop_domain') this.systemDomains.public = cleanValue;
                });

                if (this.systemDomains.mgmt && window.location.hostname !== '127.0.0.1' && window.location.hostname !== 'localhost') {
                    this.assetBase = `https://${this.systemDomains.mgmt}/`;
                }

                // Domain Enforcement
                if (this.systemDomains.mgmt && this.systemDomains.public && window.location.hostname === this.systemDomains.mgmt) {
                    const publicUrl = window.location.href.replace(this.systemDomains.mgmt, this.systemDomains.public);
                    window.location.replace(publicUrl);
                    return;
                }
            }

            // Process products
            this.products = productsResult || [];
            this.filteredProducts = [...this.products];
            this.products.forEach(p => {
                const t = (p.type || '').trim();
                if (t) {
                    this.types.add(t);
                } else if (p.category && p.category.trim() && p.category.trim() !== 'Other') {
                    this.types.add(p.category.trim());
                }
            });

            // Apply theme and update UI
            this.applyTheme();
            this.updateUI();

            // Render products immediately
            this.renderTypes();
            this.renderMetadataKeys();
            this.renderProducts();

            // Non-blocking: load cart, setup events, init carousel, apk install popup
            this.loadCartFromStorage();
            this.setupEventListeners();
            this.initCarousel();
            this.initApkInstallPopup();

            const yearEl = document.getElementById('year');
            if (yearEl) yearEl.textContent = new Date().getFullYear();

        } catch (error) {
            console.error('Initialization error details:', error);
            this.renderError(`Something went wrong while loading the shop: ${error.message}`);
        }
    }

    async fetchProducts() {
        const { data, error } = await supabaseClient
            .from('products')
            .select('*')
            .eq('shop_id', this.shopId)
            .neq('show_in_store', false)
            .gt('stock', 0)
            .order('priority', { ascending: true })
            .order('product_name', { ascending: true });

        if (error) throw error;
        const products = data || [];

        // Preload active variants so lowest price across DB variants is always known
        if (products.length > 0) {
            const productIds = products.map(p => p.id);
            try {
                const { data: variants } = await supabaseClient
                    .from('product_variants')
                    .select('id, product_id, price, attributes, stock, is_active')
                    .in('product_id', productIds)
                    .eq('is_active', true);

                if (variants && variants.length > 0) {
                    const variantMap = {};
                    variants.forEach(v => {
                        if (!variantMap[v.product_id]) variantMap[v.product_id] = [];
                        variantMap[v.product_id].push(v);
                    });
                    products.forEach(p => {
                        p._variants = variantMap[p.id] || [];
                    });
                }
            } catch (vErr) {
                console.warn('Could not preload variants for store:', vErr);
            }
        }

        return products;
    }

    applyTheme() {
        const primary = this.shopSettings.theme_color || '#0f6425';
        const layout = this.shopSettings.theme_layout || 'default';

        document.documentElement.style.setProperty('--public-primary', primary);
        const secondary = this.adjustColor(primary, -20);
        document.documentElement.style.setProperty('--public-secondary', secondary);

        // Reset defaults
        document.documentElement.style.setProperty('--public-radius', '12px');
        document.documentElement.style.setProperty('--public-font', "'Inter', sans-serif");
        document.body.style.background = '#f9f9f9';
        document.body.style.color = '#333';

        // Apply Layout Specific Styles
        switch (layout) {
            case 'ocean':
                document.documentElement.style.setProperty('--public-radius', '30px');
                break;
            case 'sunset':
                document.documentElement.style.setProperty('--public-radius', '15px');
                break;
            case 'neon':
                document.body.style.background = '#0a0a0a';
                document.body.style.color = '#fff';
                document.documentElement.style.setProperty('--public-radius', '4px');
                break;
            case 'minimal':
                document.documentElement.style.setProperty('--public-radius', '0px');
                document.body.style.background = '#ffffff';
                break;
            case 'luxe':
                document.documentElement.style.setProperty('--public-font', "'Playfair Display', serif");
                document.documentElement.style.setProperty('--public-radius', '0px');
                break;
            case 'berry':
                document.documentElement.style.setProperty('--public-radius', '20px');
                break;
            case 'eco':
                document.documentElement.style.setProperty('--public-radius', '8px');
                document.body.style.background = '#f0f4f0';
                break;
            case 'royal':
                document.documentElement.style.setProperty('--public-radius', '12px');
                break;
            case 'retro':
                document.documentElement.style.setProperty('--public-radius', '0px');
                document.documentElement.style.setProperty('--public-font', "'Space Mono', monospace");
                break;
        }

        // Add theme-specific class to body for CSS targeting
        document.body.className = `public-shop-body theme-${layout}`;
    }

    adjustColor(hex, amt) {
        let usePound = false;
        if (hex[0] == "#") {
            hex = hex.slice(1);
            usePound = true;
        }

        // Handle 3-digit hex
        if (hex.length === 3) {
            hex = hex.split('').map(char => char + char).join('');
        }

        let num = parseInt(hex, 16);
        let r = (num >> 16) + amt;
        if (r > 255) r = 255; else if (r < 0) r = 0;
        let g = ((num >> 8) & 0x00FF) + amt;
        if (g > 255) g = 255; else if (g < 0) g = 0;
        let b = (num & 0x0000FF) + amt;
        if (b > 255) b = 255; else if (b < 0) b = 0;

        const rr = r.toString(16).padStart(2, '0');
        const gg = g.toString(16).padStart(2, '0');
        const bb = b.toString(16).padStart(2, '0');

        return (usePound ? "#" : "") + rr + gg + bb;
    }

    updateUI() {
        const currentTitle = this.shopSettings.seo_title || `${this.shopData.shop_name} - Online Menu`;
        document.title = currentTitle;
        document.getElementById('publicHeaderName').textContent = this.shopData.shop_name;
        document.getElementById('footerShopName').textContent = this.shopData.shop_name;
        document.getElementById('publicHeroName').textContent = this.shopData.shop_name;
        document.getElementById('publicHeroAddress').textContent = this.shopData.address || 'Address not listed';

        // Update Canonical URL
        let canonical = document.querySelector('link[rel="canonical"]');
        if (canonical) {
            const slug = this.shopData.slug || this.shopData.id;
            let origin = window.location.origin;

            // Domain Mapping: Dynamic from Super Admin panel
            if (this.systemDomains.mgmt && this.systemDomains.public && window.location.hostname === this.systemDomains.mgmt) {
                origin = origin.replace(this.systemDomains.mgmt, this.systemDomains.public);
            }
            canonical.href = `${origin}/${slug}`;
        }

        // Update Meta Description
        let metaDesc = document.querySelector('meta[name="description"]');
        if (!metaDesc) {
            metaDesc = document.createElement('meta');
            metaDesc.name = "description";
            document.head.appendChild(metaDesc);
        }
        metaDesc.content = this.shopSettings.seo_description || this.shopSettings.about_us || `Welcome to ${this.shopData.shop_name}. Buy the best products online.`;

        // Update Open Graph & Twitter Tags
        let publicOrigin = window.location.origin;
        if (this.systemDomains.mgmt && this.systemDomains.public && window.location.hostname === this.systemDomains.mgmt) {
            publicOrigin = publicOrigin.replace(this.systemDomains.mgmt, this.systemDomains.public);
        }
        const shopUrl = `${publicOrigin}/${this.shopData.slug || this.shopData.id}`;
        const shopTitle = currentTitle;
        const shopDesc = metaDesc.content;
        const shopImage = this.shopData.shop_logo || '';

        const metaUpdates = {
            'og:title': shopTitle,
            'og:description': shopDesc,
            'og:url': shopUrl,
            'og:site_name': this.shopData.shop_name,
            'og:image': shopImage,
            'twitter:title': shopTitle,
            'twitter:description': shopDesc,
            'twitter:image': shopImage,
            'twitter:url': shopUrl
        };

        for (const [key, value] of Object.entries(metaUpdates)) {
            let el = document.querySelector(`meta[property="${key}"]`) || document.querySelector(`meta[name="${key}"]`);
            if (el) {
                el.content = value;
            } else if (value) {
                const newMeta = document.createElement('meta');
                if (key.startsWith('og:')) newMeta.setAttribute('property', key);
                else newMeta.setAttribute('name', key);
                newMeta.content = value;
                document.head.appendChild(newMeta);
            }
        }

        // Update APK Logo in Menu
        const apkLogo = document.getElementById('navApkLogo');
        if (apkLogo && this.shopData.shop_logo) {
            apkLogo.src = this.shopData.shop_logo;
        }

        // Generate Dynamic PWA Manifest
        this.updateDynamicManifest();

        // Footer & Links
        const addr = this.shopData.address || 'Address not listed';
        const phone = this.shopData.phone || 'N/A';
        const whatsapp = this.shopSettings.whatsapp_number || this.shopData.phone || '';

        document.getElementById('footerAbout').textContent = this.shopSettings.about_us || 'Experience the best shopping with us. High quality products and fast delivery.';
        document.getElementById('footerAddress').textContent = addr;
        document.getElementById('footerAddressLink').href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr)}`;

        document.getElementById('footerPhone').textContent = phone;
        document.getElementById('footerPhoneLink').href = `tel:${phone}`;

        document.getElementById('footerWA').textContent = whatsapp || 'N/A';
        if (whatsapp) {
            const cleanWA = whatsapp.replace(/\+/g, '').replace(/\s/g, '');
            document.getElementById('footerWALink').href = `https://wa.me/${cleanWA}`;
        }

        if (this.shopData.shop_logo) {
            document.getElementById('publicHeaderLogo').src = this.shopData.shop_logo;

            // Set shop logo as favicon
            setFavicon(this.shopData.shop_logo);
        }

        // Apply loaded shop logo and business name to PWA icons and manifest dynamically
        if (typeof window.applyShopLogoToAppIcons === 'function') {
            window.applyShopLogoToAppIcons(this.shopData.shop_logo, this.shopData.shop_name);
        }

        if (this.shopSettings.banner_text) {
            document.getElementById('popupText').textContent = this.shopSettings.banner_text;
            setTimeout(() => {
                const banner = document.getElementById('bannerPopup');
                if (banner) {
                    banner.style.display = 'flex';
                    document.body.style.overflow = 'hidden'; document.documentElement.style.overflow = 'hidden';
                }
            }, 1500); // Small delay for better UX
        }

        if (this.shopSettings.opening_hours) {
            document.getElementById('footerHours').textContent = this.shopSettings.opening_hours;
        }

        const mapsUrl = this.shopSettings.google_maps_url || this.shopSettings.maps_url;
        if (mapsUrl) {
            const container = document.getElementById('mapContainer');
            const iframe = document.getElementById('googleMap');
            if (container && iframe) {
                container.style.display = 'block';
                iframe.src = mapsUrl;
            }
        }

        if (this.shopSettings.facebook_url) document.getElementById('fbLink').href = this.shopSettings.facebook_url;
        else document.getElementById('fbLink').style.display = 'none';

        if (this.shopSettings.instagram_url) document.getElementById('igLink').href = this.shopSettings.instagram_url;
        else document.getElementById('igLink').style.display = 'none';

        // Nav Drawer Population
        document.getElementById('navShopName').textContent = this.shopData.shop_name;
        document.getElementById('navYear').textContent = new Date().getFullYear();
        if (this.shopSettings.facebook_url) document.getElementById('navFb').href = this.shopSettings.facebook_url;
        if (this.shopSettings.instagram_url) document.getElementById('navIg').href = this.shopSettings.instagram_url;

        // SEO Keywords
        if (this.shopSettings.seo_keywords) {
            let meta = document.querySelector('meta[name="keywords"]');
            if (!meta) {
                meta = document.createElement('meta');
                meta.name = "keywords";
                document.head.appendChild(meta);
            }
            meta.content = this.shopSettings.seo_keywords;
        }

        // Custom Scripts Injection (only allow scripts from trusted sources, not inline)
        if (this.shopSettings.custom_scripts) {
            // Sanitize: Only allow external script src, block inline scripts
            const div = document.createElement('div');
            div.innerHTML = this.shopSettings.custom_scripts;

            // Extract and execute only external scripts (with src attribute)
            Array.from(div.querySelectorAll('script')).forEach(oldScript => {
                if (oldScript.src) {
                    const newScript = document.createElement('script');
                    newScript.src = oldScript.src;
                    if (oldScript.async) newScript.async = true;
                    if (oldScript.defer) newScript.defer = true;
                    document.body.appendChild(newScript);
                }
                // Inline scripts are intentionally skipped for security
            });

            // Append non-script elements (like style or meta)
            Array.from(div.childNodes).forEach(node => {
                if (node.nodeName !== 'SCRIPT' && node.nodeType === 1) {
                    document.head.appendChild(node.cloneNode(true));
                }
            });
        }
    }

    updateDynamicManifest() {
        if (!this.shopData) return;
        const logo = this.shopData.shop_logo || (document.getElementById('publicHeaderLogo') ? document.getElementById('publicHeaderLogo').src : '');
        const name = this.shopData.shop_name || (document.getElementById('publicHeaderName') ? document.getElementById('publicHeaderName').textContent.trim() : '');
        if (typeof window.applyShopLogoToAppIcons === 'function') {
            window.applyShopLogoToAppIcons(logo, name);
        }
    }

    isAppAlreadyInstalled() {
        // 1. Check if running inside installed standalone PWA
        const isStandalone = window.matchMedia('(display-mode: standalone)').matches ||
                             window.matchMedia('(display-mode: fullscreen)').matches ||
                             window.matchMedia('(display-mode: minimal-ui)').matches ||
                             window.matchMedia('(display-mode: window-controls-overlay)').matches ||
                             window.navigator.standalone === true ||
                             document.referrer.includes('android-app://');
        if (isStandalone) {
            try { localStorage.setItem('pwa_app_installed', 'true'); } catch (e) {}
            return true;
        }

        // 2. Check persistent localStorage flag (set when user installed)
        try {
            if (localStorage.getItem('pwa_app_installed') === 'true') {
                return true;
            }
        } catch (e) {}

        return false;
    }

    async checkInstalledRelatedApps() {
        if (typeof navigator !== 'undefined' && 'getInstalledRelatedApps' in navigator) {
            try {
                const apps = await navigator.getInstalledRelatedApps();
                if (apps && apps.length > 0) {
                    try { localStorage.setItem('pwa_app_installed', 'true'); } catch (e) {}
                    const installContainer = document.getElementById('installAppContainer');
                    if (installContainer) installContainer.style.display = 'none';
                    return true;
                }
            } catch (e) {}
        }
        return false;
    }

    initApkInstallPopup() {
        if (this.apkPopupInitialized) return;
        this.apkPopupInitialized = true;

        // Register Service Worker for PWA / APK install capability
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('./sw.js?v=15', { scope: './' }).catch(e => {
                navigator.serviceWorker.register('sw.js').catch(err => console.log('SW registration note:', err));
            });
        }

        // 1. If user already installed the app, DO NOT show the popup!
        if (this.isAppAlreadyInstalled()) {
            console.log('User already installed app; install popup suppressed.');
            const installContainer = document.getElementById('installAppContainer');
            if (installContainer) installContainer.style.display = 'none';
            return;
        }

        // Check modern browser installed apps API
        this.checkInstalledRelatedApps().then(installed => {
            if (installed) {
                console.log('Installed app detected; install popup suppressed.');
                const installContainer = document.getElementById('installAppContainer');
                if (installContainer) installContainer.style.display = 'none';
                if (this.apkPopupTimer) clearTimeout(this.apkPopupTimer);
            }
        });

        // 2. Manage "every new visit" tracking:
        // A visit is a browsing session; if returning after 30+ minutes of inactivity, reset session flag
        const now = Date.now();
        try {
            const lastActivity = parseInt(sessionStorage.getItem('pwa_visit_last_activity') || '0', 10);
            if (!lastActivity || (now - lastActivity > 30 * 60 * 1000)) {
                sessionStorage.removeItem('pwa_popup_shown_in_visit');
            }
            sessionStorage.setItem('pwa_visit_last_activity', now.toString());

            // Do not popup again within the exact same active visit session
            if (sessionStorage.getItem('pwa_popup_shown_in_visit')) {
                return;
            }
        } catch (e) {}

        // ⏱️ Auto-show APK / App Install Popup after exactly 10 seconds of user visit
        if (this.apkPopupTimer) clearTimeout(this.apkPopupTimer);
        this.apkPopupTimer = setTimeout(async () => {
            // Re-verify user has not installed in the meantime
            if (this.isAppAlreadyInstalled()) return;
            const hasInstalled = await this.checkInstalledRelatedApps();
            if (hasInstalled) return;

            // Mark as shown for this visit
            try {
                sessionStorage.setItem('pwa_popup_shown_in_visit', 'true');
            } catch (e) {}
            this.showApkInstallPopup();
        }, 10000);
    }

    showApkInstallPopup() {
        if (this.isAppAlreadyInstalled()) return;

        const modal = document.getElementById('apkInstallModal');
        if (!modal) return;

        // Populate shop branding into modal with safe fallbacks
        const logo = document.getElementById('apkModalLogo');
        const shopLogo = this.shopData?.shop_logo ? this.getAssetUrl(this.shopData.shop_logo) : (document.getElementById('shopLogo')?.src || '../assets/logo.jpg');
        if (logo && shopLogo) {
            logo.src = shopLogo;
        }

        const title = document.getElementById('apkModalTitle');
        const shopName = this.shopData?.shop_name || document.getElementById('shopName')?.textContent || document.title || 'Shop App';
        if (title && shopName) {
            title.textContent = shopName;
        }

        modal.style.display = 'flex';
        document.body.style.overflow = 'hidden';
        document.documentElement.style.overflow = 'hidden';
    }

    hideApkInstallPopup() {
        const modal = document.getElementById('apkInstallModal');
        if (modal) modal.style.display = 'none';
        document.body.style.overflow = '';
        document.documentElement.style.overflow = '';
    }
    initCarousel() {
        const carousel = document.getElementById('heroCarousel');
        const dotsContainer = document.getElementById('carouselDots');
        if (!carousel || !dotsContainer) return;

        let images = this.shopSettings.carousel_images || [];

        // Handle potential stringified JSON
        if (typeof images === 'string') {
            try { images = JSON.parse(images); } catch (e) { images = []; }
        }

        // Ensure images is actually an array
        if (!Array.isArray(images)) images = [];

        // If no custom images, the default one from HTML will stay (it has the IDs)
        if (images.length === 0) return;

        // Populate carousel
        carousel.innerHTML = images.map((src, index) => `
            <div class="public-carousel-item" style="background-image: url('${src}');">
                <div class="public-hero-overlay">
                    <h2 ${index === 0 ? 'id="publicHeroName"' : ''}>${this.shopData.shop_name}</h2>
                    <p ${index === 0 ? 'id="publicHeroAddress"' : ''}>${this.shopData.address || ''}</p>
                </div>
            </div>
        `).join('');

        // Populate dots
        dotsContainer.innerHTML = images.map((_, i) => `
            <div class="carousel-dot ${i === 0 ? 'active' : ''}" data-index="${i}"></div>
        `).join('');

        // Reset slide
        this.currentSlide = 0;
        this.updateCarousel();

        // Clear existing interval
        if (this.carouselInterval) clearInterval(this.carouselInterval);

        if (images.length > 1) {
            this.carouselInterval = setInterval(() => {
                this.currentSlide = (this.currentSlide + 1) % images.length;
                this.updateCarousel();
            }, 5000);
        }

        dotsContainer.querySelectorAll('.carousel-dot').forEach(dot => {
            dot.onclick = () => {
                this.currentSlide = parseInt(dot.dataset.index);
                this.updateCarousel();
            };
        });
    }

    updateCarousel() {
        const carousel = document.getElementById('heroCarousel');
        const dots = document.querySelectorAll('.carousel-dot');
        carousel.style.transform = `translateX(-${this.currentSlide * 100}%)`;
        dots.forEach((dot, i) => dot.classList.toggle('active', i === this.currentSlide));
    }

    renderTypes() {
        const container = document.getElementById('typesContainer');
        if (!container) return;

        // Clear only generated buttons, keep the 'All' button (first child)
        // Actually easier to just rebuild or append. 
        // Let's clear everything but the first element if we want to preserve valid event listeners on "All", 
        // OR just rebuild "All" button too.
        // The safest way given the 'All' button is static in HTML is to find it or append after it.
        // But the previous code just appended. Let's stick to appending but robustly.

        // Clear strictly the dynamic ones if possible, but simplest is:
        const allBtn = container.querySelector('[data-type="all"]');

        // Remove all siblings of allBtn
        while (allBtn && allBtn.nextSibling) {
            allBtn.nextSibling.remove();
        }

        // If no types exist in the products, hide the container
        if (this.types.size === 0) {
            container.style.display = 'none';
            return;
        } else {
            container.style.display = '';
        }

        // Sort types based on category_order if defined
        let sortedTypes = Array.from(this.types);
        if (this.shopSettings.category_order) {
            const order = this.shopSettings.category_order.split(',').map(s => s.trim().toLowerCase());
            sortedTypes.sort((a, b) => {
                const indexA = order.indexOf(a.toLowerCase());
                const indexB = order.indexOf(b.toLowerCase());
                if (indexA === -1 && indexB === -1) return a.localeCompare(b);
                if (indexA === -1) return 1;
                if (indexB === -1) return -1;
                return indexA - indexB;
            });
        } else {
            sortedTypes.sort();
        }

        sortedTypes.forEach(type => {
            const btn = document.createElement('button');
            btn.className = 'public-cat-btn'; // Keep class for styling
            btn.textContent = type;
            btn.addEventListener('click', () => {
                document.querySelectorAll('.public-cat-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.selectedType = type;

                // Clear metadata filters
                const k = document.getElementById('metaKeySelect');
                const v = document.getElementById('metaValueSelect');
                if (k) k.value = "";
                if (v) { v.innerHTML = '<option value="">Value</option>'; v.disabled = true; }

                this.handleFilter();
            });
            container.appendChild(btn);
        });

        if (allBtn) {
            allBtn.onclick = (e) => {
                document.querySelectorAll('.public-cat-btn').forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');
                this.selectedType = 'all';

                // Clear metadata filters
                const k = document.getElementById('metaKeySelect');
                const v = document.getElementById('metaValueSelect');
                if (k) k.value = "";
                if (v) { v.innerHTML = '<option value="">Value</option>'; v.disabled = true; }

                this.handleFilter();
            };
        }
    }

    setupTryOnListeners() {
        const byId = (id) => document.getElementById(id);

        // Card button (works for every renderer: main grid + spread grid)
        document.addEventListener('click', (e) => {
            const btn = e.target.closest && e.target.closest('[data-try-id]');
            if (!btn) return;
            e.preventDefault();
            e.stopPropagation();
            this.openTryOn(btn.getAttribute('data-try-id'), btn.getAttribute('data-try-img'));
        }, true);

        ['tryOnCameraInput', 'tryOnGalleryInput'].forEach(id => {
            const el = byId(id);
            if (el) el.addEventListener('change', (e) => this.handleTryOnPhoto(e));
        });

        const closeBtn = byId('tryOnCloseBtn');
        if (closeBtn) closeBtn.addEventListener('click', () => this.closeTryOn());

        const modal = byId('tryOnModal');
        if (modal) {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) this.closeTryOn();
            });
        }

        const genBtn = byId('tryOnGenerateBtn');
        if (genBtn) genBtn.addEventListener('click', () => this.submitTryOn());

        const pickBtn = byId('tryOnPickBtn');
        if (pickBtn) pickBtn.addEventListener('click', () => {
            const input = byId('tryOnGalleryInput');
            if (input) input.click();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modal && modal.classList.contains('active')) {
                this.closeTryOn();
            }
        });
    }

    setupEventListeners() {
        this.setupTryOnListeners();

        // Search, Sort and Price Filters
        const searchInput = document.getElementById('publicSearch');
        const sortSelect = document.getElementById('sortProducts');
        const minPriceInput = document.getElementById('minPrice');
        const maxPriceInput = document.getElementById('maxPrice');
        const applyPriceBtn = document.getElementById('applyPriceFilter');

        if (searchInput) searchInput.addEventListener('input', () => this.handleFilter());
        if (sortSelect) sortSelect.addEventListener('change', () => this.handleFilter());
        if (applyPriceBtn) applyPriceBtn.addEventListener('click', () => this.handleFilter());

        // Filter Toggle Button
        const filterToggle = document.getElementById('filterToggle');
        const filterBar = document.getElementById('filterBar');
        if (filterToggle && filterBar) {
            filterToggle.addEventListener('click', () => {
                const isActive = filterToggle.classList.contains('active');

                if (isActive) {
                    // Close the filter
                    filterBar.classList.remove('show');
                    filterToggle.classList.remove('active');
                    setTimeout(() => {
                        filterBar.style.display = 'none';
                    }, 300);
                } else {
                    // Open the filter
                    filterBar.style.display = 'flex';
                    filterToggle.classList.add('active');
                    setTimeout(() => {
                        filterBar.classList.add('show');
                    }, 10);
                }
            });
        }

        // Metadata Filters
        const metaKeySelect = document.getElementById('metaKeySelect');
        const metaValueSelect = document.getElementById('metaValueSelect');
        if (metaKeySelect) metaKeySelect.addEventListener('change', () => this.updateMetadataValues());
        if (metaValueSelect) metaValueSelect.addEventListener('change', () => this.handleFilter());

        // Navigation and Cart
        document.getElementById('cartToggle')?.addEventListener('click', () => this.toggleCart(true));
        document.getElementById('closeCart')?.addEventListener('click', () => this.toggleCart(false));
        document.getElementById('overlay')?.addEventListener('click', () => {
            this.toggleCart(false);
            this.toggleNav(false);
        });

        // Discount and Checkout
        document.getElementById('applyDiscountBtn')?.addEventListener('click', () => this.applyDiscount());
        document.getElementById('checkoutBtn')?.addEventListener('click', () => {
            if (this.cart.length === 0) return alert('Your basket is empty!');
            this.toggleOrderModal(true);
        });

        // Order Method selection
        document.querySelectorAll('.public-order-opt').forEach(opt => {
            opt.addEventListener('click', () => {
                document.querySelectorAll('.public-order-opt').forEach(o => o.classList.remove('active'));
                opt.classList.add('active');
                this.selectedOrderMethod = opt.dataset.method;
            });
        });

        document.getElementById('cancelOrder')?.addEventListener('click', () => this.toggleOrderModal(false));
        document.getElementById('confirmOrder')?.addEventListener('click', () => this.sendOrder());

        // Nav Drawer
        document.getElementById('navToggle')?.addEventListener('click', () => this.toggleNav(true));
        document.getElementById('closeNav')?.addEventListener('click', () => this.toggleNav(false));
        document.querySelectorAll('.nav-menu a').forEach(link => {
            link.addEventListener('click', () => this.toggleNav(false));
        });

        // Window scroll listener for load-on-scroll (batches of 10 items at page bottom)
        let isScrollThrottled = false;
        window.addEventListener('scroll', () => {
            if (isScrollThrottled || this.isLoadingNextBatch) return;
            isScrollThrottled = true;
            requestAnimationFrame(() => {
                const total = this.filteredProducts ? this.filteredProducts.length : 0;
                if (this.currentProductPage * this.productsPerPage < total) {
                    const scrollY = window.scrollY || window.pageYOffset || document.documentElement.scrollTop;
                    const windowHeight = window.innerHeight;
                    const docHeight = document.documentElement.scrollHeight;
                    // Trigger when reaching near bottom (within 350px)
                    if (scrollY + windowHeight >= docHeight - 350) {
                        this.loadNextProductBatch();
                    }
                }
                isScrollThrottled = false;
            });
        }, { passive: true });

        // PWA Install logic
        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

        // If user already installed the app, hide menu install button
        if (this.isAppAlreadyInstalled()) {
            const installContainer = document.getElementById('installAppContainer');
            if (installContainer) installContainer.style.display = 'none';
        }

        // Check again if prompt was captured globally while we were loading
        if (shopDeferredPrompt) this.deferredPrompt = shopDeferredPrompt;

        window.addEventListener('beforeinstallprompt', (e) => {
            e.preventDefault();
            this.deferredPrompt = e;
            shopDeferredPrompt = e;
        });

        // App Installed Event - fired when user installs app via prompt or browser menu
        window.addEventListener('appinstalled', (e) => {
            console.log('PWA app was successfully installed by user');
            try { localStorage.setItem('pwa_app_installed', 'true'); } catch (err) {}
            const installContainer = document.getElementById('installAppContainer');
            if (installContainer) installContainer.style.display = 'none';
            this.hideApkInstallPopup();
            this.deferredPrompt = null;
            shopDeferredPrompt = null;
        });

        // Menu "Download APP" button opens the APK install popup
        const installBtn = document.getElementById('installAppBtn');
        if (installBtn) {
            installBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.showApkInstallPopup();
            });
        }

        // APK Modal Install Button
        const apkInstallBtn = document.getElementById('apkModalInstallBtn');
        if (apkInstallBtn) {
            apkInstallBtn.addEventListener('click', async (e) => {
                e.preventDefault();

                if (isIOS) {
                    const iosGuide = document.getElementById('apkIosGuide');
                    if (iosGuide) {
                        iosGuide.style.display = iosGuide.style.display === 'none' ? 'block' : 'none';
                    }
                    return;
                }

                const promptEvent = this.deferredPrompt || shopDeferredPrompt;
                if (promptEvent) {
                    try {
                        promptEvent.prompt();
                        const { outcome } = await promptEvent.userChoice;
                        console.log(`User response to install prompt: ${outcome}`);
                        if (outcome === 'accepted') {
                            try { localStorage.setItem('pwa_app_installed', 'true'); } catch (err) {}
                            const installContainer = document.getElementById('installAppContainer');
                            if (installContainer) installContainer.style.display = 'none';
                        }
                        this.deferredPrompt = null;
                        shopDeferredPrompt = null;
                        this.hideApkInstallPopup();
                    } catch (err) {
                        console.error('Installation error:', err);
                        this.hideApkInstallPopup();
                    }
                } else {
                    // Browser did not fire automated prompt yet or on non-PWA browser
                    alert('To install this app on your phone:\n1. Open your browser menu (⋮ or Share icon).\n2. Tap "Install app" or "Add to Home screen".');
                    this.hideApkInstallPopup();
                }
            });
        }

        // APK Modal Dismiss Handlers
        const apkCloseBtn = document.getElementById('apkModalCloseBtn');
        const apkLaterBtn = document.getElementById('apkModalLaterBtn');
        const apkModal = document.getElementById('apkInstallModal');

        if (apkCloseBtn) apkCloseBtn.addEventListener('click', () => this.hideApkInstallPopup());
        if (apkLaterBtn) apkLaterBtn.addEventListener('click', () => this.hideApkInstallPopup());
        if (apkModal) {
            apkModal.addEventListener('click', (e) => {
                if (e.target === apkModal) this.hideApkInstallPopup();
            });
        }

        // Popup Handlers
        const closePopup = document.getElementById('closePopup');
        const popupAction = document.getElementById('popupAction');
        const bannerPopup = document.getElementById('bannerPopup');

        const hidePopup = () => {
            if (bannerPopup) bannerPopup.style.display = 'none';
            document.body.style.overflow = ''; document.documentElement.style.overflow = '';
        };

        if (closePopup) closePopup.onclick = hidePopup;
        if (popupAction) popupAction.onclick = hidePopup;
        if (bannerPopup) {
            bannerPopup.onclick = (e) => {
                if (e.target === bannerPopup) hidePopup();
            };
        }

        // Product Detail Handlers
        // Product Detail Handlers
        const detailModal = document.getElementById('productDetailModal');
        const closeDetail = document.getElementById('closeProductDetail');
        if (closeDetail && detailModal) {
            closeDetail.onclick = () => {
                detailModal.classList.remove('active');
                setTimeout(() => detailModal.style.display = 'none', 300); // Wait for potential animation
                document.body.style.overflow = ''; document.documentElement.style.overflow = '';
            };
            detailModal.onclick = (e) => {
                if (e.target === detailModal) {
                    detailModal.classList.remove('active');
                    setTimeout(() => detailModal.style.display = 'none', 300);
                    document.body.style.overflow = ''; document.documentElement.style.overflow = '';
                }
            };
        }

        // Full Screen Image Overlay Handlers
        const fsOverlay = document.getElementById('fullScreenImageOverlay');
        const detailImageWrapper = document.getElementById('detailImageWrapper');
        if (fsOverlay && detailImageWrapper) {
            let isFsSwipe = false;
            let isWrapperSwipe = false;

            // Make images undraggable to allow mouse swipe
            const detailImg = document.getElementById('detailImage');
            if (detailImg) detailImg.draggable = false;
            const fsImgEl = fsOverlay.querySelector('img');
            if (fsImgEl) fsImgEl.draggable = false;

            const handleSwipe = (diffX, isFullScreen) => {
                const thumbs = document.getElementById('detailThumbnails');
                const thumbList = thumbs ? Array.from(thumbs.querySelectorAll('.detail-thumb')) : [];
                if (thumbList.length <= 1) return;
                
                const currentIndex = thumbList.findIndex(t => t.classList.contains('active'));
                if (currentIndex === -1) return;
                
                if (diffX < 0) { // Swipe Left
                    thumbList[(currentIndex + 1) % thumbList.length].click();
                } else if (diffX > 0) { // Swipe Right
                    thumbList[(currentIndex - 1 + thumbList.length) % thumbList.length].click();
                }
                
                if (isFullScreen) {
                    setTimeout(() => {
                        const img = document.getElementById('detailImage');
                        const fsImg = fsOverlay.querySelector('img');
                        if (img && fsImg) {
                            fsImg.src = img.getAttribute('data-original-src') || img.src;
                        }
                    }, 50);
                }
            };

            const attachSwipeEvents = (element, isFullScreen) => {
                const startDrag = (x) => {
                    element.dataset.startX = x;
                    if (isFullScreen) isFsSwipe = false;
                    else isWrapperSwipe = false;
                };
                
                const endDrag = (x) => {
                    const startX = parseFloat(element.dataset.startX);
                    if (isNaN(startX)) return;
                    const diffX = x - startX;
                    if (Math.abs(diffX) > 50) {
                        if (isFullScreen) isFsSwipe = true;
                        else isWrapperSwipe = true;
                        handleSwipe(diffX, isFullScreen);
                    }
                    delete element.dataset.startX;
                };

                element.addEventListener('touchstart', (e) => startDrag(e.changedTouches[0].screenX), { passive: true });
                element.addEventListener('touchend', (e) => endDrag(e.changedTouches[0].screenX), { passive: true });
                
                element.addEventListener('mousedown', (e) => startDrag(e.clientX));
                element.addEventListener('mouseup', (e) => endDrag(e.clientX));
                element.addEventListener('mouseleave', (e) => {
                    if (element.dataset.startX) endDrag(e.clientX);
                });
            };

            attachSwipeEvents(detailImageWrapper, false);
            attachSwipeEvents(fsOverlay, true);

            detailImageWrapper.onclick = () => {
                if (isWrapperSwipe) {
                    isWrapperSwipe = false;
                    return;
                }
                const img = document.getElementById('detailImage');
                if (img) {
                    // Show ORIGINAL uncompressed image in lightbox
                    const originalSrc = img.getAttribute('data-original-src') || img.src;
                    const fsImg = fsOverlay.querySelector('img');
                    if (fsImg) fsImg.src = originalSrc;
                    fsOverlay.classList.add('active');
                    const modal = document.getElementById('productDetailModal');
                    if (modal) modal.style.overflow = 'hidden';
                }
            };

            // Prevent background scrolling (scroll bleed) when interacting with the overlay
            fsOverlay.addEventListener('touchmove', (e) => { e.preventDefault(); }, { passive: false });
            fsOverlay.addEventListener('wheel', (e) => { e.preventDefault(); }, { passive: false });

            fsOverlay.onclick = (e) => {
                if (isFsSwipe) {
                    isFsSwipe = false;
                    return;
                }
                fsOverlay.classList.remove('active');
                const modal = document.getElementById('productDetailModal');
                if (modal) modal.style.overflow = '';
            };
        }

        // Initialize Drag Scroll for horizontal containers
        this.initDragScroll(document.getElementById('typesContainer'));
        this.initDragScroll(document.getElementById('detailThumbnails'));
    }

    initDragScroll(slider) {
        if (!slider) return;

        let isDown = false;
        let startX;
        let scrollLeft;

        slider.addEventListener('mousedown', (e) => {
            isDown = true;
            slider.classList.add('dragging');
            startX = e.pageX - slider.offsetLeft;
            scrollLeft = slider.scrollLeft;
            slider.style.cursor = 'grabbing';
            slider.style.userSelect = 'none';
        });

        slider.addEventListener('mouseleave', () => {
            isDown = false;
            slider.classList.remove('dragging');
            slider.style.cursor = '';
        });

        slider.addEventListener('mouseup', () => {
            isDown = false;
            slider.classList.remove('dragging');
            slider.style.cursor = '';
            slider.style.userSelect = '';
        });

        slider.addEventListener('mousemove', (e) => {
            if (!isDown) return;
            e.preventDefault();
            const x = e.pageX - slider.offsetLeft;
            const walk = (x - startX) * 2; // Scroll speed
            slider.scrollLeft = scrollLeft - walk;
        });
    }

    toggleNav(show) {
        document.getElementById('navDrawer').classList.toggle('active', show);
        document.getElementById('overlay').style.display = show ? 'block' : 'none';

        // Prevent body scroll
        document.body.style.overflow = show ? 'hidden' : ''; document.documentElement.style.overflow = show ? 'hidden' : '';
    }

    renderMetadataKeys(products = this.products) {
        const keySelect = document.getElementById('metaKeySelect');
        const valueSelect = document.getElementById('metaValueSelect');
        if (!keySelect) return;

        // Keep current selection if valid
        const currentKey = keySelect.value;

        // Reset
        keySelect.innerHTML = '<option value="">Filter</option>';

        // Collect keys
        const keys = new Set();
        products.forEach(p => {
            if (p.metadata && typeof p.metadata === 'object') {
                Object.keys(p.metadata).forEach(k => {
                    if (k !== 'product_images' && k !== 'product_image') keys.add(k);
                });
            } else if (typeof p.metadata === 'string') {
                try {
                    const meta = JSON.parse(p.metadata);
                    Object.keys(meta).forEach(k => {
                        if (k !== 'product_images' && k !== 'product_image') keys.add(k);
                    });
                } catch (e) { }
            }
        });

        Array.from(keys).sort().forEach(k => {
            const label = k.charAt(0).toUpperCase() + k.slice(1).replace(/([A-Z])/g, ' $1');
            const opt = document.createElement('option');
            opt.value = k;
            opt.textContent = label;
            keySelect.appendChild(opt);
        });

        // Restore if possible
        if (currentKey && keys.has(currentKey)) {
            keySelect.value = currentKey;
        } else {
            keySelect.value = "";
            valueSelect.innerHTML = '<option value="">Value</option>';
            valueSelect.disabled = true;
        }
    }

    updateMetadataValues() {
        const keySelect = document.getElementById('metaKeySelect');
        const valueSelect = document.getElementById('metaValueSelect');
        if (!keySelect || !valueSelect) return;

        const key = keySelect.value;
        if (!key) {
            valueSelect.innerHTML = '<option value="">Value</option>';
            valueSelect.disabled = true;
            this.handleFilter();
            return;
        }

        // Collect values for this key from ALL products (or currently filtered by type)
        // Better to use products filtered by type so we don't show irrelevant values
        const typeFiltered = this.selectedType === 'all'
            ? this.products
            : this.products.filter(p => p.type === this.selectedType || (!p.type && p.category === this.selectedType));

        const values = new Set();
        typeFiltered.forEach(p => {
            let meta = p.metadata;
            if (typeof meta === 'string') {
                try { meta = JSON.parse(meta); } catch (e) { meta = null; }
            }
            if (meta && meta[key]) {
                values.add(meta[key]);
            }
        });

        valueSelect.innerHTML = '<option value="">Value</option>';
        Array.from(values).sort().forEach(v => {
            const opt = document.createElement('option');
            opt.value = v;
            opt.textContent = v;
            valueSelect.appendChild(opt);
        });
        valueSelect.disabled = false;

        // Trigger filter to clear previous metadata value selection
        this.handleFilter();
    }

    handleFilter() {
        const searchTerm = document.getElementById('publicSearch').value.toLowerCase();
        const sortValue = document.getElementById('sortProducts').value;
        const minPrice = parseFloat(document.getElementById('minPrice').value) || 0;
        const maxPrice = parseFloat(document.getElementById('maxPrice').value) || Infinity;

        const metaKey = document.getElementById('metaKeySelect') ? document.getElementById('metaKeySelect').value : '';
        const metaValue = document.getElementById('metaValueSelect') ? document.getElementById('metaValueSelect').value : '';

        // 1. Filter
        this.filteredProducts = this.products.filter(p => {
            const name = (p.product_name || '').toLowerCase();
            const matchesSearch = name.includes(searchTerm);
            const matchesType = this.selectedType === 'all' || p.type === this.selectedType || (!p.type && p.category === this.selectedType);

            const price = parseFloat(p.selling_price) || 0;
            const matchesPrice = price >= minPrice && price <= maxPrice;

            // Metadata Filter
            let matchesMeta = true;
            if (metaKey && metaValue) {
                let meta = p.metadata;
                if (typeof meta === 'string') {
                    try { meta = JSON.parse(meta); } catch (e) { meta = {}; }
                }
                matchesMeta = meta && meta[metaKey] == metaValue;
            }

            return matchesSearch && matchesType && matchesPrice && matchesMeta;
        });

        // 2. Sort
        this.filteredProducts.sort((a, b) => {
            const priceA = this.getProductLowestPrice(a);
            const priceB = this.getProductLowestPrice(b);
            const dateA = new Date(a.created_at || 0).getTime();
            const dateB = new Date(b.created_at || 0).getTime();

            switch (sortValue) {
                case 'price-low': return priceA - priceB;
                case 'price-high': return priceB - priceA;
                case 'oldest': return dateA - dateB;
                case 'newest':
                default:
                    return dateB - dateA;
            }
        });

        // Reset to page 1 when filter changes
        this.currentProductPage = 1;
        this.isLoadingNextBatch = false;
        this._paginationTriggered = false;

        this.renderProducts();
    }

    createProductCardHtml(product) {
        const currency = this.shopSettings.currency || 'INR';
        const imgUrl = this.getAssetUrl(product.product_image || 'assets/default-product.png');

        // Clean description snippet
        let descSnippet = '';
        if (product.description) {
            descSnippet = product.description.split('--SPECIFICATIONS--')[0].split('--VARIANT_DATA--')[0].trim();
            if (descSnippet.length > 80) descSnippet = descSnippet.substring(0, 80) + '...';
        }

        // Lowest price across base product, sizes, and variants
        const lowestPrice = this.getProductLowestPrice(product);
        let originalPrice = 0;
        if (lowestPrice > 0) {
            const calculatedOriginal = lowestPrice / 0.83;
            const lastTwoDigits = calculatedOriginal % 100;
            originalPrice = lastTwoDigits >= 70
                ? Math.ceil(calculatedOriginal / 100) * 100
                : Math.floor(calculatedOriginal / 50) * 50;
            while (originalPrice <= lowestPrice) originalPrice += 50;
        }
        const cardPriceHtml = lowestPrice > 0
            ? `<span class="price-strike">${this.formatCurrency(originalPrice, currency)}</span>${this.formatCurrency(lowestPrice, currency)}`
            : this.formatCurrency(lowestPrice, currency);
        const likeCount = typeof window.getProductLikeCount === 'function' && typeof window.formatProductLikeCount === 'function'
            ? window.formatProductLikeCount(window.getProductLikeCount(product.id))
            : '';

        // Metadata specifications chips
        let meta = product.metadata || {};
        if (typeof meta === 'string') {
            try { meta = JSON.parse(meta); } catch (e) { meta = {}; }
        }
        const skip = ['name', 'product_images', 'product_image', 'variant_images', 'variant_group', 'has_variants', 'base_stock'];
        const specs = Object.entries(meta).filter(entry => {
            const k = entry[0], v = entry[1];
            const vs = String(v);
            return v && !skip.includes(k) && !k.toLowerCase().includes('image') && !Array.isArray(v) && typeof v !== 'object' && !vs.includes('://') && !vs.startsWith('[') && !vs.startsWith('data:');
        });

        let specsHtml = '';
        if (specs.length > 0) {
            specsHtml = `
                <div class="public-card-specs">
                    ${specs.map(e => `<span class="public-card-spec-tag">${e[0].replace(/_/g, ' ')}: ${e[1]}</span>`).join('')}
                </div>
            `;
        }

        return `
            <div class="public-product-card" onclick="app.openProductDetail('${product.id}')" data-product-id="${product.id}" style="cursor:pointer;">
                <div class="public-product-img">
                    <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Crect fill='%23f0f0f0' width='300' height='300'/%3E%3C/svg%3E" 
                         data-compress-src="${imgUrl}" 
                         data-compress-width="400" 
                         data-compress-quality="0.6" 
                         alt="${product.product_name}" 
                         loading="lazy"
                         style="transition:opacity 0.3s;">
                </div>
                ${specsHtml}
                <div class="public-product-details">
                    <div class="public-cat-row">
                        <span class="public-product-cat">${product.type || 'General'}</span>
                        <button type="button" class="public-like-btn" data-like-id="${product.id}" aria-label="Like ${product.product_name}">
                            <i class="fas fa-heart"></i>
                            <span class="public-like-count">${likeCount}</span>
                        </button>
                    </div>
                    <h3 class="public-product-name">${product.product_name}</h3>
                    ${descSnippet ? `<p class="public-product-desc">${descSnippet}</p>` : ''}
                    <div class="public-product-price">${cardPriceHtml}</div>
                    ${this.isTryOnEnabled() ? `
                    <div class="public-try-row">
                        <button type="button" class="public-try-btn" data-try-id="${product.id}" aria-label="Try this on with your photo">
                            <i class="fas fa-wand-magic-sparkles"></i>
                            <span>Try It On</span>
                        </button>
                    </div>` : ''}
                </div>
            </div>
        `;
    }

    // ============================================================
    //  VIRTUAL TRY-ON
    //  The customer captures or picks a photo, then it is sent together
    //  with the garment image to the Gemini image API and the finished
    //  photo is rendered back in the app.
    //  Only available when the shop saved a Gemini API key.
    // ============================================================

    showToast(message, type = 'info') {
        let el = document.getElementById('pubToast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'pubToast';
            el.className = 'pub-toast';
            document.body.appendChild(el);
        }
        el.className = 'pub-toast pub-toast-' + type;
        el.textContent = message;
        el.classList.add('show');
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
    }

    isTryOnEnabled() {
        if (!this.shopSettings) return false;
        if (this.shopSettings.enable_tryon === false) return false;
        // Without a key there is nothing to call, so the button stays hidden
        return !!this.getGeminiApiKey();
    }

    getGeminiApiKey() {
        return String((this.shopSettings && this.shopSettings.gemini_api_key) || '').trim();
    }

    getGeminiImageModel() {
        const m = String((this.shopSettings && this.shopSettings.gemini_image_model) || '').trim();
        return m || 'gemini-2.5-flash-image';
    }

    getTryOnProductImageUrl(product, overrideUrl) {
        const raw = String(overrideUrl || (product && (product.product_image || '')) || '').trim();
        if (!raw) return '';
        if (/^https?:\/\//i.test(raw) || raw.startsWith('data:')) return raw;
        return this.getAssetUrl(raw);
    }

    buildTryOnPrompt(product, faceImageRef) {
        const name = (product && product.product_name) || 'this garment';
        const cat = (product && (product.type || product.category)) || 'clothes';
        return [
            `Virtual try-on task: dress the person in the PHOTO wearing the exact GARMENT from the IMAGE.`,
            ``,
            `GARMENT IMAGE (image 1): ${this.tryOn.garmentUrl}`,
            `PERSON PHOTO (image 2): ${faceImageRef}`,
            ``,
            `Instructions:`,
            `1. Keep the person's face, identity, skin tone, hair, hairstyle and body proportions exactly as in image 2.`,
            `2. Keep the garment's exact design - same colour, pattern, print, fabric, texture, logo, neckline, sleeves and length. Do not redesign it.`,
            `3. Fit the garment naturally on the person's body with realistic folds, shadows and lighting.`,
            `4. Output one photorealistic full-body photo of the person wearing the ${cat} "${name}".`,
            `5. No text, no watermark, no collage, no side-by-side comparison.`
        ].join('\n');
    }

    setTryOnStatus(msg, type = 'info') {
        const el = document.getElementById('tryOnStatus');
        if (!el) return;
        if (!msg) {
            el.textContent = '';
            el.className = 'try-on-status';
            el.style.display = 'none';
            return;
        }
        el.textContent = msg;
        el.className = 'try-on-status try-on-status-' + type;
        el.style.display = 'block';
    }

    setTryOnBusy(busy) {
        this.tryOn.busy = !!busy;
        const btn = document.getElementById('tryOnGenerateBtn');
        if (btn) {
            btn.disabled = !!busy;
            btn.innerHTML = busy
                ? '<i class="fas fa-spinner fa-spin"></i> Working...'
                : '<i class="fas fa-wand-magic-sparkles"></i> Show Me How It Looks';
        }
    }

    resetTryOn() {
        this.tryOn = {
            product: null,
            garmentUrl: '',
            faceFile: null,
            faceDataUrl: '',
            garmentDataUrl: '',
            busy: false
        };

        const preview = document.getElementById('tryOnPreview');
        const faceImg = document.getElementById('tryOnFaceImg');
        const placeholder = document.getElementById('tryOnPlaceholder');
        const result = document.getElementById('tryOnResult');
        const inputs = ['tryOnCameraInput', 'tryOnGalleryInput'];

        inputs.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        if (preview) preview.style.display = 'none';
        if (faceImg) {
            faceImg.removeAttribute('src');
            faceImg.style.display = 'none';
        }
        if (placeholder) placeholder.style.display = 'flex';
        if (result) {
            result.style.display = 'none';
            const img = document.getElementById('tryOnResultImg');
            if (img) img.removeAttribute('src');
        }

        this.setTryOnStatus('');
        this.setTryOnBusy(false);

        const title = document.getElementById('tryOnProductName');
        if (title) title.textContent = '';
    }

    openTryOn(productId, imageUrlOverride) {
        const product = this.products.find(p => String(p.id) === String(productId));
        if (!product) return;

        const garmentUrl = this.getTryOnProductImageUrl(product, imageUrlOverride);
        if (!garmentUrl || garmentUrl.startsWith('data:')) {
            this.showToast('This product has no photo yet, so it cannot be tried on.', 'error');
            return;
        }

        this.resetTryOn();
        this.tryOn.product = product;
        this.tryOn.garmentUrl = garmentUrl;

        const modal = document.getElementById('tryOnModal');
        const nameEl = document.getElementById('tryOnProductName');
        const garmentImg = document.getElementById('tryOnGarmentImg');
        if (nameEl) nameEl.textContent = product.product_name || 'this product';
        if (garmentImg) garmentImg.src = garmentUrl;
        if (modal) modal.classList.add('active');

        document.body.classList.add('try-on-open');
    }

    closeTryOn() {
        const modal = document.getElementById('tryOnModal');
        if (modal) modal.classList.remove('active');
        document.body.classList.remove('try-on-open');
        // Drop the customer's photo from memory as soon as it is closed
        this.tryOn.faceFile = null;
        this.tryOn.faceDataUrl = '';
    }

    readFileAsDataUrl(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('Could not read that image'));
            reader.readAsDataURL(file);
        });
    }

    loadImage(src) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('Could not load that image'));
            img.src = src;
        });
    }

    // Downscale before sending: face shots from phones are 3-8 MB, the Gemini
    // API only needs a modest image and big uploads fail or take forever on 4G
    async shrinkTryOnImage(file, maxSize = 1024, quality = 0.85) {
        const dataUrl = await this.readFileAsDataUrl(file);
        if (!/^data:image\/(jpeg|jpg|png|webp)/i.test(dataUrl)) {
            throw new Error('Unsupported image format. Please use a JPG, PNG or WebP photo.');
        }

        const img = await this.loadImage(dataUrl);
        const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);

        const out = canvas.toDataURL('image/jpeg', quality);
        return { dataUrl: out, width: w, height: h };
    }

    async handleTryOnPhoto(e) {
        const file = e.target.files && e.target.files[0];
        if (!file) return;

        if (!/^image\//i.test(file.type)) {
            this.setTryOnStatus('That file is not an image. Please pick a photo.', 'error');
            e.target.value = '';
            return;
        }
        if (file.size > 25 * 1024 * 1024) {
            this.setTryOnStatus('That photo is too large (max 25 MB). Please pick a smaller one.', 'error');
            e.target.value = '';
            return;
        }

        this.setTryOnStatus('Reading photo...', 'info');

        try {
            const { dataUrl } = await this.shrinkTryOnImage(file);

            this.tryOn.faceFile = file;
            this.tryOn.faceDataUrl = dataUrl;

            const preview = document.getElementById('tryOnPreview');
            const faceImg = document.getElementById('tryOnFaceImg');
            const placeholder = document.getElementById('tryOnPlaceholder');
            if (faceImg) {
                faceImg.src = dataUrl;
                faceImg.style.display = 'block';
            }
            if (preview) preview.style.display = 'block';
            if (placeholder) placeholder.style.display = 'none';

            this.setTryOnStatus('Photo ready. Tap "Show Me How It Looks".', 'success');
        } catch (err) {
            this.setTryOnStatus(err.message || 'Could not read that photo.', 'error');
        }
    }

    // Downloads the garment so Gemini gets a clean, captioned image and so the
    // API mode never has to fetch a remote URL that may block cross-origin reads
    async fetchGarmentAsDataUrl(url) {
        try {
            const res = await fetch(url, { mode: 'cors' });
            if (!res.ok) throw new Error('bad status');
            const blob = await res.blob();
            if (!/^image\//i.test(blob.type)) throw new Error('not an image');
            return await this.readFileAsDataUrl(new File([blob], 'garment', { type: blob.type }));
        } catch (e) {
            return '';
        }
    }

    async submitTryOn() {
        if (this.tryOn.busy) return;
        if (!this.tryOn.product || !this.tryOn.garmentUrl) {
            this.setTryOnStatus('This product cannot be tried on right now.', 'error');
            return;
        }
        if (!this.getGeminiApiKey()) {
            this.setTryOnStatus('Virtual try-on is not available right now. Please check back later.', 'error');
            return;
        }
        if (!this.tryOn.faceDataUrl) {
            this.setTryOnStatus('Please add your photo first.', 'error');
            return;
        }

        this.setTryOnBusy(true);

        try {
            await this.generateTryOnImage();
        } catch (err) {
            console.error('[tryOn]', err);
            this.setTryOnStatus(err.message || 'Something went wrong. Please try again.', 'error');
        } finally {
            this.setTryOnBusy(false);
        }
    }

    async generateTryOnImage() {
        const apiKey = this.getGeminiApiKey();
        if (!apiKey) throw new Error('Virtual try-on is not available right now.');

        this.setTryOnStatus('Preparing both photos...', 'info');

        let garmentDataUrl = await this.fetchGarmentAsDataUrl(this.tryOn.garmentUrl);
        if (!garmentDataUrl) {
            throw new Error('Could not load the garment photo. Please refresh and try again.');
        }
        this.tryOn.garmentDataUrl = garmentDataUrl;

        const model = this.getGeminiImageModel();
        const prompt = this.buildTryOnPrompt(this.tryOn.product, 'the second attached image');
        const stripDataUrl = (d) => String(d).replace(/^data:[^;]+;base64,/, '');
        const mimeOf = (d) => (String(d).match(/^data:([^;]+);/) || [, 'image/jpeg'])[1];

        const body = {
            contents: [{
                parts: [
                    { text: prompt },
                    { inline_data: { mime_type: mimeOf(garmentDataUrl), data: stripDataUrl(garmentDataUrl) } },
                    { inline_data: { mime_type: mimeOf(this.tryOn.faceDataUrl), data: stripDataUrl(this.tryOn.faceDataUrl) } }
                ]
            }]
        };

        this.setTryOnStatus('Generating your look... this takes up to a minute', 'info');

        const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            }
        );

        const json = await res.json().catch(() => null);
        if (!res.ok) {
            throw new Error(this.describeTryOnError(res.status, json));
        }

        const parts = (((json || {}).candidates || [])[0] || {}).content?.parts || [];
        const imgPart = parts.find(p => p.inline_data && p.inline_data.data);
        if (!imgPart) {
            const blocked = ((((json || {}).candidates || [])[0] || {}).finishReason) || 'no image returned';
            throw new Error(`Gemini could not create the image (${blocked}). Try a clearer front-facing photo.`);
        }

        const resultUrl = `data:${imgPart.inline_data.mime_type || 'image/png'};base64,${imgPart.inline_data.data}`;
        this.showTryOnResult(resultUrl);
    }

    // Turns a raw Gemini HTTP failure into something a shop owner can act on.
    // The customer always sees a short apology; the technical detail goes to
    // the console so it is not lost.
    describeTryOnError(status, json) {
        const raw = (json && json.error && json.error.message) || '';
        const lower = raw.toLowerCase();
        let hint;

        if (status === 403) {
            if (lower.includes('denied access') || lower.includes('permission_denied')) {
                hint = 'Virtual try-on is temporarily unavailable. This shop has not finished setting up its ' +
                    'Google AI access yet. Please check back later.';
            } else if (lower.includes('api key not valid') || lower.includes('api_key_invalid')) {
                hint = 'Virtual try-on is unavailable because the shop\'s Google AI key is not valid.';
            } else {
                hint = 'Virtual try-on is temporarily unavailable. Please check back later.';
            }
        } else if (status === 429) {
            hint = 'Virtual try-on is very busy right now. Please wait a minute and try again.';
        } else if (status === 400 && lower.includes('api key')) {
            hint = 'Virtual try-on is unavailable because the shop\'s Google AI key was rejected.';
        } else if (status === 404) {
            hint = 'Virtual try-on is unavailable because the image model this shop selected is not enabled ' +
                'for its Google AI key.';
        } else if (status === 0 || lower.includes('failed to fetch')) {
            hint = 'Could not reach the try-on service. Please check your internet connection and try again.';
        } else {
            hint = 'Virtual try-on could not finish just now. Please try again.';
        }

        console.warn('[tryOn] Gemini API error', { status, message: raw || '(no message)' });
        return hint;
    }

    showTryOnResult(resultUrl) {
        const wrap = document.getElementById('tryOnResult');
        const img = document.getElementById('tryOnResultImg');
        if (!wrap || !img) return;

        img.src = resultUrl;
        wrap.style.display = 'block';

        const dl = document.getElementById('tryOnDownloadBtn');
        if (dl) {
            dl.onclick = () => {
                const a = document.createElement('a');
                a.href = resultUrl;
                a.download = `try-on-${(this.tryOn.product?.product_name || 'look').replace(/[^\w]+/g, '-').toLowerCase()}.png`;
                a.click();
            };
        }

        this.setTryOnStatus('Here is how it looks on you!', 'success');
    }

    renderProducts() {
        const grid = document.getElementById('productsGrid');
        if (!grid) return;

        // Reset pagination state
        this.currentProductPage = 1;
        this.isLoadingNextBatch = false;

        const totalProducts = this.filteredProducts.length;

        if (totalProducts === 0) {
            grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 50px; color: #64748b;">No products found</div>';
            if (this.infiniteScrollObserver) {
                this.infiniteScrollObserver.disconnect();
                this.infiniteScrollObserver = null;
            }
            return;
        }

        // Batch 1: First 10 items
        const initialBatch = this.filteredProducts.slice(0, this.productsPerPage);
        const cardsHtml = initialBatch.map(p => this.createProductCardHtml(p)).join('');

        const totalPages = Math.ceil(totalProducts / this.productsPerPage);
        const loadedCount = Math.min(this.productsPerPage, totalProducts);
        const progressPct = Math.min(100, Math.round((loadedCount / totalProducts) * 100));
        const allLoaded = loadedCount >= totalProducts;

        grid.innerHTML = `
            ${cardsHtml}
            <div id="infiniteScrollSentinel" class="infinite-scroll-sentinel"></div>
            <div id="infiniteScrollLoader" class="infinite-scroll-loader" style="display: none; grid-column: 1 / -1; justify-content: center; padding: 20px 0;">
                <div class="infinite-scroll-spinner"></div>
            </div>
        `;

        // Apply lazy compressed images for Batch 1
        applyCompressedImages();

        // Setup IntersectionObserver for load-on-scroll
        this.setupInfiniteScrollObserver();

        this._paginationTriggered = true;
    }

    loadNextProductBatch() {
        if (this.isLoadingNextBatch) return;

        const total = this.filteredProducts.length;
        const currentLoaded = this.currentProductPage * this.productsPerPage;
        if (currentLoaded >= total) return;

        this.isLoadingNextBatch = true;

        const loader = document.getElementById('infiniteScrollLoader');
        if (loader) loader.style.display = 'flex';

        // Brief delay to allow smooth scrolling and UI feedback
        setTimeout(() => {
            const nextBatch = this.filteredProducts.slice(currentLoaded, currentLoaded + this.productsPerPage);
            if (nextBatch.length === 0) {
                this.isLoadingNextBatch = false;
                if (loader) loader.style.display = 'none';
                return;
            }

            this.currentProductPage++;

            const sentinel = document.getElementById('infiniteScrollSentinel');
            const newCardsHtml = nextBatch.map(p => this.createProductCardHtml(p)).join('');

            if (sentinel) {
                sentinel.insertAdjacentHTML('beforebegin', newCardsHtml);
            } else {
                const grid = document.getElementById('productsGrid');
                if (grid) grid.insertAdjacentHTML('beforeend', newCardsHtml);
            }

            // Lazy load images on newly appended cards
            applyCompressedImages();

            const isFinished = (this.currentProductPage * this.productsPerPage) >= total;
            if (loader) loader.style.display = 'none';

            if (isFinished && this.infiniteScrollObserver) {
                this.infiniteScrollObserver.disconnect();
                this.infiniteScrollObserver = null;
            }

            this.isLoadingNextBatch = false;
        }, 150);
    }

    setupInfiniteScrollObserver() {
        if (this.infiniteScrollObserver) {
            this.infiniteScrollObserver.disconnect();
            this.infiniteScrollObserver = null;
        }

        const sentinel = document.getElementById('infiniteScrollSentinel');
        if (!sentinel) return;

        const total = this.filteredProducts.length;
        if (this.currentProductPage * this.productsPerPage >= total) {
            return;
        }

        if ('IntersectionObserver' in window) {
            this.infiniteScrollObserver = new IntersectionObserver((entries) => {
                const entry = entries[0];
                if (entry && entry.isIntersecting && !this.isLoadingNextBatch) {
                    this.loadNextProductBatch();
                }
            }, {
                root: null,
                rootMargin: '0px 0px 300px 0px',
                threshold: 0.01
            });

            this.infiniteScrollObserver.observe(sentinel);
        }
    }

    addToCart(productId, event) {
        const product = this.products.find(p => p.id === productId);
        if (!product) return;

        // --- Animation Logic ---
        const btn = event ? (event.currentTarget || event.target) : null;
        const cartIcon = document.getElementById('cartToggle');
        let productImg;

        const productCard = btn ? btn.closest('.public-product-card') : null;
        if (productCard) {
            productImg = productCard.querySelector('img');
        } else {
            // Fallback for Modal
            productImg = document.getElementById('detailImage');
        }

        if (productImg && cartIcon && productImg.getBoundingClientRect) {
            const flyingImg = document.createElement('img');
            flyingImg.src = productImg.src;
            flyingImg.className = 'flying-img';

            // Initial position
            const rect = productImg.getBoundingClientRect();
            flyingImg.style.top = `${rect.top}px`;
            flyingImg.style.left = `${rect.left}px`;
            flyingImg.style.width = `${rect.width}px`;
            flyingImg.style.height = `${rect.height}px`;

            document.body.appendChild(flyingImg);

            // Target position (cart icon)
            const cartRect = cartIcon.getBoundingClientRect ? cartIcon.getBoundingClientRect() : { top: 0, left: 0 };

            setTimeout(() => {
                flyingImg.style.top = `${cartRect.top + 10}px`;
                flyingImg.style.left = `${cartRect.left + 10}px`;
                flyingImg.style.width = '20px';
                flyingImg.style.height = '20px';
                flyingImg.style.opacity = '0.5';
            }, 10);

            // Clean up and bounce cart
            setTimeout(() => {
                flyingImg.remove();
                cartIcon.classList.add('cart-bounce');
                setTimeout(() => cartIcon.classList.remove('cart-bounce'), 400);
            }, 1200);
        }

        // Button feedback
        if (btn) {
            const originalContent = btn.innerHTML;
            btn.innerHTML = '<i class="fas fa-check"></i> Added!';
            btn.classList.add('added');
            setTimeout(() => {
                btn.innerHTML = originalContent;
                btn.classList.remove('added');
            }, 1500);
        }
        // -------------------------

        const defColor = this.getProductDefaultColor(product);
        const defSize = this.getProductDefaultSize(product);
        const fullName = this.formatProductTitle(product.product_name, defColor, defSize);

        const existing = this.cart.find(item => item.id === productId || item.id === product.id);
        if (existing) {
            existing.name = fullName;
            existing.quantity++;
        } else {
            this.cart.push({ id: product.id, name: fullName, price: product.selling_price, image: product.product_image, quantity: 1 });
        }

        this.saveCartToStorage();
        this.updateCartUI();
    }

    updateCartUI() {
        this.sanitizeCartItems();
        const list = document.getElementById('cartItemsList');
        const count = document.getElementById('cartCount');
        const currency = (this.shopSettings && this.shopSettings.currency) || 'INR';

        const totalQty = this.cart.reduce((sum, item) => sum + item.quantity, 0);
        if (count) count.textContent = totalQty;
        const pdpBadge = document.getElementById('pdpCartBadge');
        if (pdpBadge) {
            pdpBadge.textContent = totalQty;
            pdpBadge.style.display = totalQty > 0 ? 'inline-flex' : 'none';
        }

        if (this.cart.length === 0) {
            list.innerHTML = '<div style="text-align: center; padding: 20px;">Empty</div>';
            this.updateTotals();
            return;
        }

        list.innerHTML = this.cart.map(item => `
            <div class="public-cart-item">
                <img src="${this.getAssetUrl(item.image || 'assets/default-product.png')}" alt="${item.name}">
                <div class="public-cart-item-info">
                    <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                        <h5 style="margin: 0;">${item.name}</h5>
                        <button class="delete-item-btn" onclick="app.removeFromCart('${item.id}')" style="background: none; border: none; color: #ff4757; cursor: pointer; padding: 0 5px;">
                            <i class="fas fa-trash-alt"></i>
                        </button>
                    </div>
                    <div class="public-cart-item-price">${this.formatCurrency(item.price, currency)}</div>
                    <div class="public-cart-controls">
                        <button class="public-qty-btn" onclick="app.updateQty('${item.id}', -1)">-</button>
                        <span>${item.quantity}</span>
                        <button class="public-qty-btn" onclick="app.updateQty('${item.id}', 1)">+</button>
                    </div>
                </div>
            </div>
        `).join('');

        this.updateTotals();
    }

    removeFromCart(productId) {
        if (confirm('Remove this item from basket?')) {
            this.cart = this.cart.filter(i => i.id !== productId);
            this.saveCartToStorage();
            this.updateCartUI();
        }
    }

    updateQty(productId, delta) {
        const item = this.cart.find(i => i.id === productId);
        if (item) {
            item.quantity += delta;
            if (item.quantity <= 0) this.cart = this.cart.filter(i => i.id !== productId);
            this.saveCartToStorage();
            this.updateCartUI();
        }
    }

    updateTotals() {
        const subtotal = this.cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
        let discount = 0;
        const currency = (this.shopSettings && this.shopSettings.currency) || 'INR';

        if (this.appliedDiscount) {
            const d = this.appliedDiscount;
            if (subtotal >= d.minOrder) {
                discount = d.type === 'percentage' ? (subtotal * d.value / 100) : d.value;
                document.getElementById('discountRow').style.display = 'flex';
                document.getElementById('discountVal').textContent = `- ${this.formatCurrency(discount, currency)}`;
                document.getElementById('discountMsg').textContent = `Applied: ${d.name}`;
                document.getElementById('discountMsg').style.color = '#14aa14';
            } else {
                this.appliedDiscount = null;
                document.getElementById('discountRow').style.display = 'none';
                document.getElementById('discountMsg').textContent = `Min order ${this.formatCurrency(d.minOrder, currency)} required.`;
                document.getElementById('discountMsg').style.color = 'red';
            }
        }

        document.getElementById('subtotalVal').textContent = this.formatCurrency(subtotal, currency);
        document.getElementById('totalVal').textContent = this.formatCurrency(subtotal - discount, currency);
    }

    applyDiscount() {
        const input = document.getElementById('discountCode');
        const code = input.value.trim().toUpperCase();

        if (!code) return;

        let discounts = this.shopSettings.discount_codes || [];

        // Handle potential stringified JSON from database
        if (typeof discounts === 'string') {
            try {
                discounts = JSON.parse(discounts);
            } catch (e) {
                console.error('Error parsing discount codes:', e);
                discounts = [];
            }
        }

        if (!Array.isArray(discounts)) discounts = [];

        const found = discounts.find(d =>
            d.name && d.name.toUpperCase() === code && d.status === 'active'
        );

        if (found) {
            this.appliedDiscount = found;
            this.updateTotals();
            input.value = ''; // Clear input
            console.log('Discount applied:', found);
        } else {
            document.getElementById('discountMsg').textContent = 'Invalid or expired code';
            document.getElementById('discountMsg').style.color = 'red';
        }
    }

    sendOrder() {
        const subtotal = this.cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
        const currency = this.shopSettings.currency || 'INR';
        let discount = 0;
        let discountNote = "";

        if (this.appliedDiscount) {
            const d = this.appliedDiscount;
            if (subtotal >= d.minOrder) {
                discount = d.type === 'percentage' ? (subtotal * d.value / 100) : d.value;
                discountNote = `\n*Discount (${d.name}): -${this.formatCurrency(discount, currency)}*`;
            }
        }

        const total = subtotal - discount;
        const shopName = this.shopData?.shop_name || 'Shop';

        let message = `🛒 *NEW ORDER — ${shopName}*\n`;
        message += `📅 ${new Date().toLocaleDateString('en-GB', {day:'2-digit', month:'short', year:'numeric'})} ${new Date().toLocaleTimeString('en-US', {hour:'2-digit', minute:'2-digit', hour12:true})}\n`;
        message += `━━━━━━━━━━━━━━━━━━\n\n`;

        message += `📦 *ITEMS:*\n`;
        this.cart.forEach((item, idx) => {
            message += `${idx + 1}. *${item.name}*\n`;
            message += `   Qty: ${item.quantity} × ${this.formatCurrency(item.price, currency)} = ${this.formatCurrency(item.price * item.quantity, currency)}\n`;

            // Add specs for this item
            const productId = item.id.includes('_') ? item.id.split('_')[0] : item.id;
            const product = this.products.find(p => p.id === productId);
            if (product) {
                let meta = product.metadata;
                if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch(e) { meta = null; } }
                if (meta && typeof meta === 'object') {
                    const skip = ['product_images','product_image','variant_images','variant_group','variant_size','variant_color','variant_label','has_variants','base_stock'];
                    const specs = Object.entries(meta).filter(([k, v]) => v && !skip.includes(k) && !k.toLowerCase().includes('image') && !Array.isArray(v) && typeof v !== 'object' && !String(v).includes('://') && !String(v).startsWith('[') && !String(v).startsWith('data:'));
                    if (specs.length > 0) {
                        message += `   📋 ${specs.map(([k, v]) => `${k.replace(/_/g,' ')}: ${v}`).join(' | ')}\n`;
                    }
                }
            }
        });

        message += `\n━━━━━━━━━━━━━━━━━━\n`;
        message += `💰 Subtotal: ${this.formatCurrency(subtotal, currency)}\n`;
        if (discount > 0) message += `ðŸ·ï¸ Discount: -${this.formatCurrency(discount, currency)}\n`;
        message += `✅ *TOTAL: ${this.formatCurrency(total, currency)}*\n`;
        message += `━━━━━━━━━━━━━━━━━━\n\n`;
        message += `ðŸ“ _Sent from ${shopName} online store_`;

        if (this.selectedOrderMethod === 'whatsapp') {
            const num = (this.shopSettings.whatsapp_number || this.shopData.phone || '').replace(/\D/g, '');
            window.open(`https://wa.me/${num}?text=${encodeURIComponent(message)}`, '_blank');
        } else {
            const user = (this.shopSettings.telegram_id || '').replace('@', '');
            window.open(`https://t.me/${user}?text=${encodeURIComponent(message)}`, '_blank');
        }
    }

    toggleCart(show) { document.getElementById('cartSidebar').classList.toggle('active', show); document.getElementById('overlay').style.display = show ? 'block' : 'none'; }
    toggleOrderModal(show) {
        const modal = document.getElementById('orderModal');
        const googleSheetUrl = this.shopSettings?.google_sheet_url;

        if (show && googleSheetUrl) {
            // Show Google Sheet order form instead of WhatsApp/Telegram
            modal.querySelector('.public-modal-content').innerHTML = `
                <h3 style="text-align:center;margin-bottom:20px;font-size:1.1rem;">Complete Your Order</h3>
                <div style="display:flex;flex-direction:column;gap:12px;">
                    <div>
                        <label style="font-size:0.8rem;font-weight:600;color:#555;margin-bottom:4px;display:block;">Your Name *</label>
                        <input type="text" id="gsOrderName" placeholder="Enter your full name" style="width:100%;padding:12px;border:1px solid #ddd;border-radius:8px;font-size:0.9rem;outline:none;" required>
                    </div>
                    <div>
                        <label style="font-size:0.8rem;font-weight:600;color:#555;margin-bottom:4px;display:block;">WhatsApp Number *</label>
                        <input type="tel" id="gsOrderPhone" placeholder="+880 1XXXXXXXXX" style="width:100%;padding:12px;border:1px solid #ddd;border-radius:8px;font-size:0.9rem;outline:none;" required>
                    </div>
                    <div>
                        <label style="font-size:0.8rem;font-weight:600;color:#555;margin-bottom:4px;display:block;">Delivery Location *</label>
                        <textarea id="gsOrderLocation" placeholder="Enter your full address" rows="2" style="width:100%;padding:12px;border:1px solid #ddd;border-radius:8px;font-size:0.9rem;outline:none;resize:vertical;"></textarea>
                        <button type="button" id="gsPickLocation" style="margin-top:6px;padding:6px 12px;background:#f0f0f0;border:1px solid #ddd;border-radius:6px;font-size:0.75rem;cursor:pointer;color:#555;">
                            <i class="fas fa-map-marker-alt"></i> Pick from Map
                        </button>
                    </div>
                    <div>
                        <label style="font-size:0.8rem;font-weight:600;color:#555;margin-bottom:4px;display:block;">Note (Optional)</label>
                        <input type="text" id="gsOrderNote" placeholder="Any special instructions" style="width:100%;padding:12px;border:1px solid #ddd;border-radius:8px;font-size:0.9rem;outline:none;">
                    </div>
                </div>
                <div id="gsOrderStatus" style="margin-top:10px;font-size:0.8rem;text-align:center;"></div>
                <div style="display:flex;gap:10px;margin-top:20px;">
                    <button class="btn btn-secondary" style="flex:1;padding:12px;border-radius:8px;border:1px solid #ddd;background:white;cursor:pointer;" id="cancelOrder">Cancel</button>
                    <button style="flex:2;padding:12px;border-radius:8px;border:none;background:var(--public-primary,#f85606);color:white;font-weight:700;cursor:pointer;font-size:0.9rem;" id="confirmOrder">
                        <i class="fas fa-check-circle"></i> Confirm Order
                    </button>
                </div>
            `;

            // Pick from map
            modal.querySelector('#gsPickLocation').addEventListener('click', () => {
                if (navigator.geolocation) {
                    navigator.geolocation.getCurrentPosition((pos) => {
                        const loc = `${pos.coords.latitude}, ${pos.coords.longitude}`;
                        document.getElementById('gsOrderLocation').value = loc;
                        window.open(`https://www.google.com/maps?q=${loc}`, '_blank');
                    }, () => { alert('Location access denied. Please enter manually.'); });
                } else {
                    alert('Geolocation not supported. Please enter manually.');
                }
            });

            // Cancel
            modal.querySelector('#cancelOrder').addEventListener('click', () => this.toggleOrderModal(false));

            // Confirm - send to Google Sheet
            modal.querySelector('#confirmOrder').addEventListener('click', () => this.sendGoogleSheetOrder(googleSheetUrl));

            modal.classList.add('active');
        } else if (show) {
            modal.classList.add('active');
        } else {
            modal.classList.remove('active');
        }
    }

    async sendGoogleSheetOrder(sheetUrl) {
        const name = document.getElementById('gsOrderName')?.value.trim();
        const phone = document.getElementById('gsOrderPhone')?.value.trim();
        const location = document.getElementById('gsOrderLocation')?.value.trim();
        const note = document.getElementById('gsOrderNote')?.value.trim();
        const statusEl = document.getElementById('gsOrderStatus');

        if (!name || !phone || !location) {
            if (statusEl) { statusEl.textContent = 'Please fill all required fields'; statusEl.style.color = '#dc2626'; }
            return;
        }

        const currency = this.shopSettings?.currency || 'INR';
        const subtotal = this.cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
        let discount = 0;
        if (this.appliedDiscount) {
            const d = this.appliedDiscount;
            if (subtotal >= d.minOrder) {
                discount = d.type === 'percentage' ? (subtotal * d.value / 100) : d.value;
            }
        }
        const total = subtotal - discount;

        // Build items string
        const items = this.cart.map((item, idx) => `${idx+1}. ${item.name} x${item.quantity} = ${this.formatCurrency(item.price * item.quantity, currency)}`).join('\n');

        const orderData = {
            shop_name: this.shopData?.shop_name || '',
            shop_id: this.shopId,
            customer_name: name,
            customer_phone: phone,
            customer_location: location,
            customer_note: note,
            items: items,
            item_count: this.cart.length,
            subtotal: subtotal,
            discount: discount,
            total: total,
            currency: currency,
            order_date: new Date().toLocaleString(),
            timestamp: new Date().toISOString()
        };

        if (statusEl) { statusEl.textContent = 'Sending order...'; statusEl.style.color = '#666'; }

        try {
            const response = await fetch(sheetUrl, {
                method: 'POST',
                mode: 'no-cors',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(orderData)
            });

            // no-cors means we can't read response, but if no error thrown, assume success
            if (statusEl) { statusEl.textContent = '✅ Order placed successfully!'; statusEl.style.color = '#16a34a'; }

            // Clear cart
            this.cart = [];
            this.saveCartToStorage();
            this.updateCartUI();

            setTimeout(() => {
                this.toggleOrderModal(false);
                alert('Your order has been placed! We will contact you on WhatsApp.');
            }, 1500);

        } catch (error) {
            console.error('Google Sheet order error:', error);
            if (statusEl) { statusEl.textContent = '❌ Failed to send order. Please try again.'; statusEl.style.color = '#dc2626'; }
        }
    }
    getProductLowestPrice(product) {
        if (!product) return 0;
        const prices = [];

        // 1. Base selling price
        const baseSp = parseFloat(product.selling_price);
        if (!isNaN(baseSp) && baseSp > 0) {
            prices.push(baseSp);
        }

        // 2. Parse metadata attributes and custom tag/size prices
        let meta = product.metadata || {};
        if (typeof meta === 'string') {
            try { meta = JSON.parse(meta); } catch(e) { meta = {}; }
        }
        let attrs = meta.attributes || {};
        if (typeof attrs === 'string') {
            try { attrs = JSON.parse(attrs); } catch(e) { attrs = {}; }
        }

        const priceKeys = ['size', 'storage', 'pack', 'portion', 'volume', 'color', 'shade', 'model', 'edition', 'variant'];
        priceKeys.forEach(k => {
            [
                meta[k + '_price'], meta[k + '_prices'],
                attrs[k + '_price'], attrs[k + '_prices']
            ].forEach(map => {
                if (!map) return;
                let parsedMap = map;
                if (typeof parsedMap === 'string') {
                    try { parsedMap = JSON.parse(parsedMap); } catch(e) { parsedMap = null; }
                }
                if (parsedMap && typeof parsedMap === 'object') {
                    Object.values(parsedMap).forEach(v => {
                        const num = parseFloat(v);
                        if (!isNaN(num) && num > 0) prices.push(num);
                    });
                }
            });
        });

        // 3. Database variants (and nested size prices within variants)
        const variants = product._variants || product.variants || [];
        if (Array.isArray(variants)) {
            variants.forEach(v => {
                const vp = parseFloat(v.price);
                if (!isNaN(vp) && vp > 0) prices.push(vp);

                let vAttrs = v.attributes || {};
                if (typeof vAttrs === 'string') {
                    try { vAttrs = JSON.parse(vAttrs); } catch(e) { vAttrs = {}; }
                }
                priceKeys.forEach(k => {
                    [vAttrs[k + '_price'], vAttrs[k + '_prices']].forEach(map => {
                        if (!map) return;
                        let parsedMap = map;
                        if (typeof parsedMap === 'string') {
                            try { parsedMap = JSON.parse(parsedMap); } catch(e) { parsedMap = null; }
                        }
                        if (parsedMap && typeof parsedMap === 'object') {
                            Object.values(parsedMap).forEach(val => {
                                const num = parseFloat(val);
                                if (!isNaN(num) && num > 0) prices.push(num);
                            });
                        }
                    });
                });
            });
        }

        if (prices.length === 0) {
            return parseFloat(product.selling_price) || 0;
        }

        return Math.min(...prices);
    }

    formatProductTitle(baseName, selectedColor, selectedSize) {
        let name = (baseName || 'Product').trim();
        const activeColor = (selectedColor || '').trim();
        const activeSize = (selectedSize || '').trim();

        // If name already contains a parenthesized size, e.g. "Full slaves (M)"
        if (activeSize) {
            const sizeRegex = /\s*\(([A-Za-z0-9\s]+)\)/;
            const match = name.match(sizeRegex);
            if (match) {
                name = name.replace(sizeRegex, ` (${activeSize})`);
            } else if (!name.toLowerCase().includes(`(${activeSize.toLowerCase()})`)) {
                name += ` (${activeSize})`;
            }
        }

        if (activeColor && !name.toLowerCase().includes(activeColor.toLowerCase())) {
            const cFormatted = activeColor.charAt(0).toUpperCase() + activeColor.slice(1);
            name += ` - ${cFormatted}`;
        }

        return name;
    }

    getProductDefaultColor(product) {
        if (!product) return '';
        let meta = product.metadata || {};
        if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch(e) { meta = {}; } }
        let attrs = meta.attributes || {};
        if (typeof attrs === 'string') { try { attrs = JSON.parse(attrs); } catch(e) { attrs = {}; } }

        if (product.description && product.description.includes('--SPECIFICATIONS--')) {
            try {
                const specParts = product.description.split('--SPECIFICATIONS--');
                for (let i = 1; i < specParts.length; i++) {
                    const part = specParts[i].split('--VARIANT_DATA--')[0].trim();
                    if (part) {
                        try {
                            const parsed = JSON.parse(part);
                            if (parsed && typeof parsed === 'object') {
                                meta = Object.assign({}, meta, parsed);
                                if (parsed.attributes && typeof parsed.attributes === 'object') {
                                    attrs = Object.assign({}, attrs, parsed.attributes);
                                }
                            }
                        } catch(err) {}
                    }
                }
            } catch(e) {}
        }

        const rawColor = meta.color || meta.Color || meta.available_colors || meta.Available_Colors || meta.colour || meta.shade ||
                         attrs.color || attrs.Color || attrs.available_colors || attrs.Available_Colors || attrs.colour || attrs.shade ||
                         product.color || product.colour || product.shade;

        if (rawColor) {
            const first = Array.isArray(rawColor) ? rawColor[0] : String(rawColor).split(',')[0];
            if (first && String(first).trim()) return String(first).trim();
        }

        const nameLower = (product.product_name || '').toLowerCase();
        const multiWordColors = ['navy blue', 'sky blue', 'light blue', 'dark blue', 'denim blue', 'olive green', 'army green', 'forest green', 'mint green', 'lime green', 'emerald green', 'sea green', 'baby pink', 'hot pink', 'rose pink', 'chocolate brown', 'coffee brown', 'off white', 'ash grey', 'smoke grey', 'slate grey'];
        for (const mc of multiWordColors) {
            if (nameLower.includes(mc)) {
                return mc.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
            }
        }
        const singleWordColors = ['white', 'black', 'grey', 'gray', 'charcoal', 'silver', 'navy', 'blue', 'indigo', 'teal', 'turquoise', 'aqua', 'green', 'yellow', 'mustard', 'gold', 'orange', 'rust', 'coral', 'peach', 'red', 'maroon', 'burgundy', 'wine', 'pink', 'purple', 'lavender', 'violet', 'lilac', 'brown', 'camel', 'khaki', 'beige', 'cream', 'tan', 'sand', 'ivory'];
        const words = nameLower.split(/[^a-z0-9]+/);
        for (const c of singleWordColors) {
            if (words.includes(c)) {
                return c.charAt(0).toUpperCase() + c.slice(1);
            }
        }

        return '';
    }

    getProductDefaultSize(product) {
        if (!product) return '';
        let meta = product.metadata || {};
        if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch(e) { meta = {}; } }
        let attrs = meta.attributes || {};
        if (typeof attrs === 'string') { try { attrs = JSON.parse(attrs); } catch(e) { attrs = {}; } }

        if (product.description && product.description.includes('--SPECIFICATIONS--')) {
            try {
                const specParts = product.description.split('--SPECIFICATIONS--');
                for (let i = 1; i < specParts.length; i++) {
                    const part = specParts[i].split('--VARIANT_DATA--')[0].trim();
                    if (part) {
                        try {
                            const parsed = JSON.parse(part);
                            if (parsed && typeof parsed === 'object') {
                                meta = Object.assign({}, meta, parsed);
                                if (parsed.attributes && typeof parsed.attributes === 'object') {
                                    attrs = Object.assign({}, attrs, parsed.attributes);
                                }
                            }
                        } catch(err) {}
                    }
                }
            } catch(e) {}
        }

        const rawSize = meta.size || meta.Size || meta.available_sizes || meta.Available_Sizes || meta.storage || meta.Storage ||
                        attrs.size || attrs.Size || attrs.available_sizes || attrs.Available_Sizes || attrs.storage || attrs.Storage;

        if (rawSize) {
            const first = Array.isArray(rawSize) ? rawSize[0] : String(rawSize).split(',')[0];
            if (first && String(first).trim()) return String(first).trim();
        }

        if (meta.size_stock && typeof meta.size_stock === 'object') {
            const keys = Object.keys(meta.size_stock);
            if (keys.length > 0) return keys[0];
        }

        if (product.product_name) {
            const m = product.product_name.match(/\(([A-Za-z0-9\s]+)\)/);
            if (m && m[1] && m[1].trim()) return m[1].trim();
        }

        return '';
    }

    sanitizeCartItems() {
        if (!Array.isArray(this.cart) || !Array.isArray(this.products) || this.products.length === 0) return;
        let changed = false;
        this.cart.forEach(item => {
            const prod = this.products.find(p => p.id === item.id || (typeof item.id === 'string' && item.id.startsWith(p.id + '_')));
            if (prod) {
                const defaultColor = this.getProductDefaultColor(prod);
                const defaultSize = this.getProductDefaultSize(prod);
                if (defaultColor) {
                    const expectedName = this.formatProductTitle(prod.product_name, defaultColor, defaultSize);
                    if (item.name !== expectedName && (!item.name.toLowerCase().includes(defaultColor.toLowerCase()) || item.name.includes('(' + defaultColor + ')'))) {
                        item.name = expectedName;
                        changed = true;
                    }
                }
            }
        });
        if (changed) {
            this.saveCartToStorage();
        }
    }

    getBaseOptionName(product) {
        return this.getProductDefaultColor(product) || 'Original';
    }

    formatCurrency(amount, currencyCode) { try { return new Intl.NumberFormat('en-IN', { style: 'currency', currency: currencyCode }).format(amount || 0); } catch (e) { return (amount || 0).toFixed(2) + ' ' + currencyCode; } }
    setProductDetailPrice(price, currency) {
        const priceEl = document.getElementById('detailPrice');
        if (!priceEl) return;
        if (typeof window.setPdpPrice === 'function') {
            window.setPdpPrice(price, currency);
            return;
        }
        priceEl.textContent = this.formatCurrency(price, currency);
    }
    saveCartToStorage() { localStorage.setItem(`cart_${this.shopId}`, JSON.stringify(this.cart)); }
    loadCartFromStorage() {
        const saved = localStorage.getItem(`cart_${this.shopId}`);
        if (saved) {
            try {
                this.cart = JSON.parse(saved);
                this.sanitizeCartItems();
                this.updateCartUI();
            } catch(e) {
                this.cart = [];
            }
        }
    }
    renderError(msg) { document.body.innerHTML = `<div style="text-align:center;padding:100px;">${msg}</div>`; }
    
    updatePdpImageCounter(currentIdx = null, totalCount = null) {
        const counter = document.getElementById('pdpImgCounter');
        if (!counter) return;
        const thumbs = document.getElementById('detailThumbnails');
        const allThumbs = thumbs ? Array.from(thumbs.querySelectorAll('.detail-thumb')) : [];
        const total = totalCount || (allThumbs.length > 0 ? allThumbs.length : 1);
        let idx = currentIdx;
        if (idx === null || idx === undefined || idx < 1) {
            const activeIdx = allThumbs.findIndex(t => t.classList.contains('active'));
            if (activeIdx !== -1) {
                idx = activeIdx + 1;
            } else {
                const detailImg = document.getElementById('detailImage');
                const curSrc = detailImg ? (detailImg.getAttribute('data-original-src') || detailImg.src || '') : '';
                const matchIdx = allThumbs.findIndex(t => {
                    const u = t.getAttribute('data-original-url') || t.src || '';
                    return u && curSrc && (u === curSrc || curSrc.includes(u));
                });
                idx = matchIdx !== -1 ? matchIdx + 1 : 1;
            }
        }
        counter.textContent = `${idx}/${total}`;
    }

    async openProductDetail(productId) {
        const product = this.products.find(p => p.id === productId);
        if (!product) return;

        const modal = document.getElementById('productDetailModal');
        const img = document.getElementById('detailImage');
        const thumbs = document.getElementById('detailThumbnails');
        const nameEl = document.getElementById('detailName');
        const priceEl = document.getElementById('detailPrice');
        const cat = document.getElementById('detailCat');
        const desc = document.getElementById('detailDesc');
        const specsContainer = document.getElementById('detailSpecs');
        const addBtn = document.getElementById('detailAddToCart');
        if (!modal || !img) return;

        const currency = this.shopSettings.currency || 'INR';
        const self = this;
        // Set base product info - use compressed image for detail view
        const originalImgUrl = this.getAssetUrl(product.product_image || 'assets/default-product.png');
        img.src = originalImgUrl; // Show original immediately, compress in background
        img.setAttribute('data-original-src', originalImgUrl); // Store original for lightbox
        compressImageUrl(originalImgUrl, 600, 0.7).then(compressed => { if (img.getAttribute('data-original-src') === originalImgUrl) img.src = compressed; });

        // Add Swipe Left/Right to change variant image
        const imgWrapper = document.getElementById('detailImageWrapper');
        if (imgWrapper) {
            let isImgSwipe = false;
            imgWrapper.ontouchstart = (e) => { 
                imgWrapper.dataset.startX = e.changedTouches[0].screenX; 
                isImgSwipe = false;
            };
            imgWrapper.ontouchmove = (e) => {
                const startX = parseFloat(imgWrapper.dataset.startX);
                if (!isNaN(startX)) {
                    const diffX = e.changedTouches[0].screenX - startX;
                    if (Math.abs(diffX) > 10) e.preventDefault(); // Lock scroll vertically if swiping horizontally
                }
            };
            imgWrapper.ontouchend = (e) => {
                const startX = parseFloat(imgWrapper.dataset.startX);
                const endX = e.changedTouches[0].screenX;
                if (isNaN(startX)) return;
                const diffX = endX - startX;
                if (Math.abs(diffX) > 50) {
                    isImgSwipe = true;
                    const thumbList = thumbs ? Array.from(thumbs.querySelectorAll('.detail-thumb')) : [];
                    if (thumbList.length <= 1) return;
                    const currentIndex = thumbList.findIndex(t => t.classList.contains('active'));
                    if (currentIndex === -1) return;
                    
                    if (diffX < 0) { // Swipe Left -> Next Image
                        const nextIndex = (currentIndex + 1) % thumbList.length;
                        thumbList[nextIndex].click();
                    } else if (diffX > 0) { // Swipe Right -> Prev Image
                        const prevIndex = (currentIndex - 1 + thumbList.length) % thumbList.length;
                        thumbList[prevIndex].click();
                    }
                }
            };
            
            // Prevent opening fullscreen if it was a swipe
            const oldClick = imgWrapper.onclick;
            imgWrapper.onclick = (e) => {
                if (isImgSwipe) {
                    isImgSwipe = false;
                    return;
                }
                if (oldClick) oldClick(e);
            };
        }

        nameEl.textContent = product.product_name;
        this.setProductDetailPrice(this.getProductLowestPrice(product), currency);
        cat.textContent = product.type || product.category || 'General';
        const pureDesc = product.description ? product.description.split('--SPECIFICATIONS--')[0].split('--VARIANT_DATA--')[0].trim() : 'No description provided.';
        desc.textContent = pureDesc;
        addBtn.setAttribute('data-id', product.id);
        addBtn.onclick = (e) => { self.addToCart(product.id, e); };

        const buyBtn = document.getElementById('detailBuyNow');
        if (buyBtn) {
            buyBtn.setAttribute('data-id', product.id);
            buyBtn.disabled = addBtn.disabled;
            buyBtn.style.opacity = addBtn.style.opacity || '1';
            buyBtn.onclick = (e) => {
                if (buyBtn.disabled) return;
                self.addToCart(product.id, e);
                setTimeout(() => {
                    const cartSidebar = document.getElementById('cartSidebar');
                    if (cartSidebar) cartSidebar.classList.add('active');
                }, 300);
            };
        }

        const handleShareAction = (e) => {
            if (e) e.stopPropagation();
            const name = nameEl?.textContent || product.product_name;
            const price = priceEl?.textContent || '';
            const shareUrl = window.location.href;
            if (navigator.share) {
                navigator.share({ title: name, text: `Check out ${name} for ${price}!`, url: shareUrl }).catch(() => {});
            } else if (navigator.clipboard) {
                navigator.clipboard.writeText(shareUrl).then(() => {
                    self.showToast ? self.showToast('Product link copied to clipboard!') : alert('Link copied to clipboard!');
                }).catch(() => {});
            }
        };
        const headerShareBtn = document.getElementById('pdpHeaderShare');
        if (headerShareBtn) headerShareBtn.onclick = handleShareAction;
        const oldShareBtn = document.getElementById('detailShareProduct');
        if (oldShareBtn) oldShareBtn.onclick = handleShareAction;

        // Clear specs and thumbs
        specsContainer.innerHTML = '';
        if (thumbs) { thumbs.innerHTML = ''; thumbs.style.display = 'none'; }
        
        const leftBtn = document.getElementById('thumbScrollLeft');
        const rightBtn = document.getElementById('thumbScrollRight');
        if (leftBtn) leftBtn.style.display = 'none';
        if (rightBtn) rightBtn.style.display = 'none';

        // Clear any previously injected selector blocks that were moved outside specsContainer
        document.querySelectorAll('.variant-selector-container-injected').forEach(el => el.remove());

        // Load variants from product_variants table
        let variants = [];
        try {
            const { data, error } = await supabaseClient
                .from('product_variants')
                .select('*')
                .eq('product_id', productId)
                .eq('is_active', true)
                .order('created_at');

            if (!error && data && data.length > 0) {
                variants = data;
            }
        } catch (e) { console.warn('Variants load failed:', e); }

        // Build complete list of variant options including base product when base product represents a variant
        let allOptions = [];
        const baseName = this.getBaseOptionName(product);
        const alreadyHasBase = variants.some(v => (v.variant_name || '').toLowerCase().trim() === baseName.toLowerCase().trim());

        if (variants.length > 0) {
            if (!alreadyHasBase && (Number(product.stock) > 0 || product.product_image)) {
                allOptions.push({
                    id: 'base',
                    variant_name: baseName,
                    stock: product.stock,
                    price: product.selling_price,
                    image_url: product.product_image,
                    attributes: product.metadata,
                    isBase: true
                });
            }
            allOptions = allOptions.concat(variants);
        } else {
            allOptions = variants;
        }

        // If product has variants OR available options in metadata, show option pickers
        let meta = product.metadata;
        if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch(e) { meta = {}; } }
        meta = meta || {};

        // Parse description specifications fallback if present
        if (product.description && product.description.includes('--SPECIFICATIONS--')) {
            try {
                const specParts = product.description.split('--SPECIFICATIONS--');
                for (let i = 1; i < specParts.length; i++) {
                    const part = specParts[i].split('--VARIANT_DATA--')[0].trim();
                    if (part) {
                        try {
                            const parsed = JSON.parse(part);
                            if (parsed && typeof parsed === 'object') {
                                meta = Object.assign({}, meta, parsed);
                                if (parsed.attributes && typeof parsed.attributes === 'object') {
                                    meta.attributes = Object.assign({}, meta.attributes || {}, parsed.attributes);
                                }
                            }
                        } catch(err) {}
                    }
                }
            } catch(e) { console.warn('Failed to parse specifications from description', e); }
        }

        let metaAttrs = meta.attributes || {};
        if (typeof metaAttrs === 'string') { try { metaAttrs = JSON.parse(metaAttrs); } catch(e) { metaAttrs = {}; } }

        const extractColors = (source) => {
            if (!source || typeof source !== 'object') return [];
            const result = [];
            const colorKeys = ['available_colors', 'color', 'shade', 'colour', 'colors', 'shades', 'available_color'];
            for (const key of Object.keys(source)) {
                if (colorKeys.includes(key.toLowerCase())) {
                    const val = source[key];
                    if (Array.isArray(val)) {
                        val.forEach(v => {
                            const t = String(v || '').trim();
                            if (t && !result.some(x => x.toLowerCase() === t.toLowerCase())) result.push(t);
                        });
                    } else if (val && typeof val === 'string') {
                        val.split(',').forEach(v => {
                            const t = v.trim();
                            if (t && !result.some(x => x.toLowerCase() === t.toLowerCase())) result.push(t);
                        });
                    }
                }
            }
            return result;
        };

        let metaColors = extractColors(meta);
        extractColors(metaAttrs).forEach(c => {
            if (!metaColors.some(x => x.toLowerCase() === c.toLowerCase())) metaColors.push(c);
        });
        ['color', 'colour', 'shade'].forEach(f => {
            if (product[f]) {
                const c = String(product[f]).trim();
                if (c && !metaColors.some(x => x.toLowerCase() === c.toLowerCase())) metaColors.push(c);
            }
        });
        ['specifications', 'attributes', 'options', 'custom_fields'].forEach(col => {
            if (product[col]) {
                let parsed = product[col];
                if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch(e) { parsed = null; } }
                if (parsed && typeof parsed === 'object') {
                    extractColors(parsed).forEach(c => {
                        if (!metaColors.some(x => x.toLowerCase() === c.toLowerCase())) metaColors.push(c);
                    });
                }
            }
        });

        const extractSizes = (source) => {
            if (!source || typeof source !== 'object') return [];
            const result = [];
            const sizeKeys = ['available_sizes', 'size', 'storage', 'sizes', 'storages', 'available_size'];
            for (const key of Object.keys(source)) {
                if (sizeKeys.includes(key.toLowerCase())) {
                    const val = source[key];
                    if (Array.isArray(val)) {
                        val.forEach(v => {
                            const t = String(v || '').trim();
                            if (t && !result.some(x => x.toLowerCase() === t.toLowerCase())) result.push(t);
                        });
                    } else if (val && typeof val === 'string') {
                        val.split(',').forEach(v => {
                            const t = v.trim();
                            if (t && !result.some(x => x.toLowerCase() === t.toLowerCase())) result.push(t);
                        });
                    }
                }
            }
            return result;
        };

        let metaSizes = extractSizes(meta);
        extractSizes(metaAttrs).forEach(s => {
            if (!metaSizes.some(x => x.toLowerCase() === s.toLowerCase())) metaSizes.push(s);
        });
        const sizeStockMap = meta.size_stock || metaAttrs.size_stock;
        if (sizeStockMap && typeof sizeStockMap === 'object') {
            Object.keys(sizeStockMap).forEach(s => {
                const trimmed = String(s).trim();
                if (trimmed && !metaSizes.some(x => x.toLowerCase() === trimmed.toLowerCase())) {
                    metaSizes.push(trimmed);
                }
            });
        }
        ['specifications', 'attributes', 'options', 'custom_fields'].forEach(col => {
            if (product[col]) {
                let parsed = product[col];
                if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch(e) { parsed = null; } }
                if (parsed && typeof parsed === 'object') {
                    extractSizes(parsed).forEach(s => {
                        if (!metaSizes.some(x => x.toLowerCase() === s.toLowerCase())) metaSizes.push(s);
                    });
                }
            }
        });
        // Fallback: if metaSizes is empty, check if product_name contains size in parentheses e.g. "Full slaves (M)"
        if (metaSizes.length === 0 && product.product_name) {
            const m = product.product_name.match(/\(([A-Za-z0-9\s]+)\)/);
            if (m && m[1] && m[1].trim()) {
                metaSizes.push(m[1].trim());
            }
        }

        if (variants.length > 0 || metaColors.length > 0 || metaSizes.length > 0) {
            // Show product images as gallery thumbnails FIRST
            if (thumbs) {
                // Collect and deduplicate all images using normalized URLs
                let imageList = [];
                const addUniqueImg = (url) => {
                    if (!url) return;
                    const fullUrl = this.getAssetUrl(url);
                    if (!imageList.includes(fullUrl) && !fullUrl.includes('assets/default-product.png')) {
                        imageList.push(fullUrl);
                    }
                };

                addUniqueImg(product.product_image);
                
                let extraImages = product.product_images || [];
                if (typeof extraImages === 'string') { try { extraImages = JSON.parse(extraImages); } catch(e) { extraImages = []; } }
                if (Array.isArray(extraImages)) extraImages.forEach(addUniqueImg);
                
                const metaImages = meta.product_images || [];
                if (Array.isArray(metaImages)) metaImages.forEach(addUniqueImg);

                const imageToVariantMap = {};
                variants.forEach(v => {
                    const mapUrl = (url) => {
                        if (!url) return;
                        const fullUrl = this.getAssetUrl(url);
                        imageToVariantMap[fullUrl] = v;
                        addUniqueImg(url);
                    };
                    
                    mapUrl(v.image_url);
                    let vAttrs = v.attributes;
                    if (typeof vAttrs === 'string') { try { vAttrs = JSON.parse(vAttrs); } catch(e) { vAttrs = {}; } }
                    const variantImgs = vAttrs?.variant_images || [];
                    variantImgs.forEach(mapUrl);
                });

                if (imageList.length > 1) {
                    imageList.forEach((url, idx) => {
                        const t = document.createElement('img');
                        t.className = 'detail-thumb' + (idx === 0 ? ' active' : '');
                        t.style.border = idx === 0 ? '3px solid var(--public-primary)' : '2px solid #ddd';
                        t.setAttribute('data-original-url', url);
                        // Improved compression for clear thumbnails
                        compressImageUrl(url, 150, 0.6).then(c => { t.src = c; });
                        t.onclick = (e) => {
                            e.stopPropagation();
                            img.setAttribute('data-original-src', url);
                            compressImageUrl(url, 600, 0.7).then(c => { img.src = c; });
                            thumbs.querySelectorAll('.detail-thumb').forEach(el => { el.classList.remove('active'); el.style.border = '2px solid #ddd'; });
                            t.classList.add('active');
                            t.style.border = '3px solid var(--public-primary)';
                            // Auto-scroll clicked thumbnail to center
                            t.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
                            self.updatePdpImageCounter(idx + 1, imageList.length);

                            const matchedVariant = imageToVariantMap[url];
                            if (matchedVariant) {
                                self.activeVariant = matchedVariant;
                                Object.keys(selectedAttributes).forEach(k => delete selectedAttributes[k]);
                                self.setProductDetailPrice(matchedVariant.price || product.selling_price, currency);
                                nameEl.textContent = self.formatProductTitle(product.product_name, matchedVariant.variant_name, selectedAttributes['size']);
                                renderPickers();
                            } else {
                                self.activeVariant = 'base';
                                Object.keys(selectedAttributes).forEach(k => delete selectedAttributes[k]);
                                self.setProductDetailPrice(product.selling_price, currency);
                                nameEl.textContent = self.formatProductTitle(product.product_name, selectedAttributes['color'], selectedAttributes['size']);
                                renderPickers();
                            }
                        };
                        thumbs.appendChild(t);
                    });
                    thumbs.style.display = 'flex';
                    thumbs.scrollLeft = 0;
                    this.updatePdpImageCounter(1, imageList.length);
                    // Hide scroll buttons - clicking thumbnails auto-centers them
                    const leftBtn = document.getElementById('thumbScrollLeft');
                    const rightBtn = document.getElementById('thumbScrollRight');
                    if (leftBtn) leftBtn.style.display = 'none';
                    if (rightBtn) rightBtn.style.display = 'none';
                }
            }

            // Build interactive Option Pickers (Colors & Sizes)
            const selectorDiv = document.createElement('div');
            selectorDiv.className = 'variant-selector-container-injected';
            selectorDiv.style.cssText = 'margin-bottom:24px;padding:24px;background:#ffffff;border-radius:16px;box-shadow:0 4px 20px rgba(0,0,0,0.04);border:1px solid #f1f5f9;';

            const getColorHex = (name) => {
                if (!name || typeof name !== 'string') return null;
                const raw = name.toLowerCase().trim();
                if (!raw) return null;

                const map = {
                    // Whites & Off-Whites
                    'white': '#ffffff', 'pure white': '#ffffff', 'snow white': '#fffafa', 'off white': '#faf9f6',
                    'off-white': '#faf9f6', 'ivory': '#fffff0', 'cream': '#fffdd0', 'white cream': '#faf6eb',
                    'cream white': '#faf6eb', 'milk white': '#fefcf6', 'milky white': '#fefcf6', 'milk': '#fefcf6',
                    'pearl white': '#eae0c8', 'pearl': '#eae0c8', 'vanilla': '#f3e5ab', 'eggshell': '#f0ead6',
                    'bone': '#e3dac9', 'ecru': '#c2b280', 'linen': '#faf0e6', 'cotton': '#fafbf8', 'chalk': '#f5f5f0',
                    'alabaster': '#edeae0', 'parchment': '#f1e9d2',

                    // Greys & Blacks
                    'black': '#000000', 'jet black': '#0a0a0a', 'pitch black': '#050505', 'matte black': '#1c1c1c',
                    'washed black': '#2b2b2b', 'ink black': '#1b1b22', 'ink': '#1b1b22', 'onyx': '#353839',
                    'ebony': '#282c34', 'midnight': '#12172a', 'grey': '#808080', 'gray': '#808080',
                    'light grey': '#d3d3d3', 'light gray': '#d3d3d3', 'white grey': '#e5e7eb', 'white gray': '#e5e7eb',
                    'dark grey': '#505050', 'dark gray': '#505050', 'charcoal': '#36454f', 'charcoal grey': '#36454f',
                    'charcoal gray': '#36454f', 'ash grey': '#b2beb5', 'ash gray': '#b2beb5', 'ash': '#b2beb5',
                    'smoke grey': '#708090', 'smoke gray': '#708090', 'smoke': '#708090', 'slate grey': '#708090',
                    'slate gray': '#708090', 'slate': '#708090', 'silver': '#c0c0c0', 'light silver': '#e5e7eb',
                    'heather grey': '#b0b4b8', 'heather gray': '#b0b4b8', 'heather': '#b0b4b8',
                    'melange grey': '#9ca3af', 'melange gray': '#9ca3af', 'melange': '#9ca3af',
                    'dove grey': '#b3b1a9', 'dove gray': '#b3b1a9', 'dove': '#b3b1a9',
                    'steel grey': '#71797e', 'steel gray': '#71797e', 'steel': '#71797e',
                    'gunmetal': '#2c3539', 'graphite': '#41424c', 'fog': '#d6d6d6', 'pebble': '#aca79f',
                    'cement': '#a5a5a5', 'anthracite': '#383e42',

                    // Blues & Denims
                    'blue': '#2563eb', 'navy blue': '#000080', 'navy': '#000080', 'dark navy': '#00004d',
                    'royal blue': '#4169e1', 'sky blue': '#87ceeb', 'light blue': '#add8e6', 'dark blue': '#00008b',
                    'baby blue': '#89cff0', 'powder blue': '#b0e0e6', 'ice blue': '#afeeee',
                    'cornflower blue': '#6495ed', 'cornflower': '#6495ed', 'steel blue': '#4682b4',
                    'denim blue': '#1560bd', 'denim': '#1560bd', 'light denim': '#8fb1d4', 'dark denim': '#1d2951',
                    'indigo': '#4b0082', 'cobalt blue': '#0047ab', 'cobalt': '#0047ab', 'cerulean': '#007ba7',
                    'teal blue': '#008080', 'teal': '#008080', 'turquoise': '#40e0d0', 'aqua': '#00ffff',
                    'aquamarine': '#7fffd4', 'cyan': '#00ffff', 'ocean blue': '#0077be', 'ocean': '#0077be',
                    'petrol blue': '#1f6a7d', 'petrol': '#1f6a7d', 'dusty blue': '#8ca3b8', 'faded blue': '#6b8e99',
                    'midnight blue': '#191970', 'sapphire': '#0f52ba', 'azure': '#007fff', 'electric blue': '#7df9ff',
                    'light wash blue': '#89cff0', 'medium wash blue': '#3b82f6', 'dark wash blue': '#00008b',
                    'vintage blue': '#799dbf', 'stone wash blue': '#829db3', 'acid wash blue': '#9ebfcc',
                    'rinse wash': '#18294a', 'raw denim': '#1c2841', 'black wash': '#1c1c1c', 'grey wash': '#7a7a7a',
                    'charcoal wash': '#424242', 'white denim': '#f4f4f4', 'ecru denim': '#c2b280', 'indigo denim': '#2b3e5a',

                    // Earth, Sand, Khaki, Brown
                    'beach': '#e8d8b8', 'sand': '#c2b280', 'sandy': '#c2b280', 'desert sand': '#edc9af', 'desert': '#edc9af',
                    'cashmere': '#d1bfa7', 'khaki': '#c3b091', 'light khaki': '#f0e68c', 'dark khaki': '#bdb76b',
                    'beige': '#f5f5dc', 'light beige': '#faf0e6', 'dark beige': '#d0c5a8', 'tan': '#d2b48c',
                    'light tan': '#e6d5b8', 'dark tan': '#91815b', 'camel': '#c19a6b', 'fawn': '#e5aa70',
                    'taupe': '#8b8589', 'warm taupe': '#b38b6d', 'brown': '#8b4513', 'light brown': '#a0522d',
                    'dark brown': '#5c4033', 'chocolate': '#7b3f00', 'chocolate brown': '#7b3f00', 'coffee': '#4a2c2a',
                    'coffee brown': '#4a2c2a', 'mocha': '#492a17', 'espresso': '#361b0d', 'walnut': '#773f1a',
                    'chestnut': '#954535', 'cinnamon': '#d2691e', 'copper': '#b87333', 'bronze': '#cd7f32',
                    'terracotta': '#e2725b', 'clay': '#b66a50', 'biscuit': '#ffe4c4', 'champagne': '#f7e7ce',
                    'oatmeal': '#e3dac9', 'nude': '#f2d3bc', 'stone': '#877f6c', 'almond': '#efdecd',
                    'caramel': '#c68642', 'toffee': '#75482f', 'hazelnut': '#bda55d', 'rust': '#b7410e',
                    'sienna': '#a0522d', 'burnt orange': '#cc5500',

                    // Pinks & Roses
                    'pink': '#ec4899', 'creamy pink': '#f8c8dc', 'cream pink': '#f8c8dc', 'blush pink': '#ffb6c1',
                    'blush': '#ffb6c1', 'baby pink': '#f4c2c2', 'light pink': '#ffb6c1', 'pastel pink': '#ffd1dc',
                    'dusty pink': '#dcae96', 'dusty rose': '#dcae96', 'rose': '#ff66cc', 'rose pink': '#ff66cc',
                    'powder pink': '#ffd8de', 'soft pink': '#ffd1df', 'hot pink': '#ff69b4', 'neon pink': '#ff10f0',
                    'deep pink': '#ff1493', 'flamingo': '#fc8eac', 'salmon': '#fa8072', 'salmon pink': '#fa8072',
                    'coral': '#ff7f50', 'coral pink': '#ff7f50', 'peach': '#ffe5b4', 'peach pink': '#ffe5b4',
                    'apricot': '#fbceb1', 'magenta': '#ff00ff', 'fuchsia': '#ff00ff', 'bubblegum': '#ffc1cc',
                    'carnation': '#ffa6c9', 'mauve': '#e0b0ff',

                    // Reds & Maroons
                    'red': '#ef4444', 'light red': '#ff7f7f', 'dark red': '#8b0000', 'crimson': '#dc143c',
                    'scarlet': '#ff2400', 'ruby': '#e0115f', 'ruby red': '#e0115f', 'cherry': '#d2042d',
                    'cherry red': '#d2042d', 'brick red': '#cb4154', 'brick': '#cb4154', 'cardinal': '#c41e3a',
                    'garnet': '#733635', 'blood red': '#7e191b', 'maroon': '#800000', 'burgundy': '#800020',
                    'wine': '#722f37', 'wine red': '#722f37', 'bordeaux': '#5c0120', 'oxblood': '#4a0000',
                    'berry': '#990f4b', 'plum': '#8e4585', 'cranberry': '#9e003a',

                    // Purples & Lavenders
                    'purple': '#a855f7', 'light purple': '#cbc3e3', 'dark purple': '#301934', 'violet': '#8f00ff',
                    'lavender': '#e6e6fa', 'lilac': '#c8a2c8', 'periwinkle': '#ccccff', 'orchid': '#da70d6',
                    'thistle': '#d8bfd8', 'iris': '#5d3fd3', 'amethyst': '#9966cc', 'grape': '#6f2da8',
                    'eggplant': '#3b0910', 'aubergine': '#3b0910', 'mulberry': '#c54b8c',

                    // Greens & Olives
                    'green': '#008000', 'light green': '#90ee90', 'dark green': '#006400', 'olive': '#556b2f',
                    'olive green': '#556b2f', 'light olive': '#808000', 'dark olive': '#3b3c36',
                    'army green': '#4b5320', 'military green': '#4c583e', 'forest green': '#228b22',
                    'pine green': '#01796f', 'hunter green': '#355e3b', 'emerald': '#50c878',
                    'emerald green': '#50c878', 'mint': '#98ff98', 'mint green': '#98ff98', 'sea green': '#2e8b57',
                    'sage': '#8a9a5b', 'sage green': '#8a9a5b', 'moss': '#8a9a5b', 'moss green': '#8a9a5b',
                    'lime': '#32cd32', 'lime green': '#32cd32', 'pistachio': '#93c572', 'bottle green': '#006a4e',
                    'chartreuse': '#7fff00', 'jade': '#00a86b', 'basil': '#577a3a', 'cypress': '#545a3e',
                    'neon green': '#39ff14', 'seafoam': '#9fe2bf', 'seafoam green': '#9fe2bf',
                    'eucalyptus': '#5f8575', 'khaki green': '#727c59',

                    // Yellows & Oranges
                    'yellow': '#eab308', 'light yellow': '#ffffe0', 'pale yellow': '#fffacd', 'lemon': '#fff44f',
                    'lemon yellow': '#fff44f', 'mustard': '#ffdb58', 'mustard yellow': '#ffdb58', 'ochre': '#cc7722',
                    'gold': '#ffd700', 'golden': '#ffd700', 'goldenrod': '#daa520', 'honey': '#eb9605',
                    'canary': '#ffef00', 'buttercup': '#f3e5ab', 'neon yellow': '#ccff00', 'orange': '#f97316',
                    'light orange': '#ffd180', 'dark orange': '#ff8c00', 'tangerine': '#f28500',
                    'marigold': '#eaa221', 'sunset': '#fd5e53', 'neon orange': '#ff5f1f', 'pumpkin': '#ff7518',

                    // Multi / Patterns
                    'multicolor': 'linear-gradient(135deg, #ef4444, #eab308, #22c55e, #3b82f6, #a855f7)',
                    'multi color': 'linear-gradient(135deg, #ef4444, #eab308, #22c55e, #3b82f6, #a855f7)',
                    'multi-color': 'linear-gradient(135deg, #ef4444, #eab308, #22c55e, #3b82f6, #a855f7)',
                    'multi': 'linear-gradient(135deg, #ef4444, #eab308, #22c55e, #3b82f6, #a855f7)',
                    'rainbow': 'linear-gradient(135deg, red, orange, yellow, green, blue, indigo, violet)',
                    'checkered': 'repeating-conic-gradient(#808080 0% 25%, transparent 0% 50%) 50% / 10px 10px',
                    'plaid': 'repeating-linear-gradient(45deg, #d11f26, #d11f26 10px, #8b0000 10px, #8b0000 20px)',
                    'striped': 'repeating-linear-gradient(45deg, #000, #000 5px, #fff 5px, #fff 10px)',
                    'tie-dye': 'radial-gradient(circle, #ff00ff, #00ffff, #ffff00, #ff0000)',
                    'tie dye': 'radial-gradient(circle, #ff00ff, #00ffff, #ffff00, #ff0000)',
                    'tiedye': 'radial-gradient(circle, #ff00ff, #00ffff, #ffff00, #ff0000)',
                    'ombre': 'linear-gradient(to bottom, #ef4444, #ffffff)',
                    'camouflage': 'linear-gradient(45deg, #4b5320 25%, #556b2f 25%, #556b2f 50%, #4b5320 50%, #4b5320 75%, #556b2f 75%, #556b2f 100%)',
                    'camo': 'linear-gradient(45deg, #4b5320 25%, #556b2f 25%, #556b2f 50%, #4b5320 50%, #4b5320 75%, #556b2f 75%, #556b2f 100%)',
                    'floral': 'radial-gradient(circle at 30% 30%, #ec4899, #a855f7, #3b82f6)',
                    'printed': 'radial-gradient(circle at center, #f59e0b, #ec4899, #8b5cf6)',
                    'graphic print': '#e5e7eb',
                    'color block': 'linear-gradient(to right, #ef4444 33%, #eab308 33%, #eab308 66%, #3b82f6 66%)'
                };

                // 1. Exact raw or hyphen-replaced match
                if (map[raw]) return map[raw];
                const normalized = raw.replace(/[-_/]/g, ' ').replace(/\s+/g, ' ').trim();
                if (map[normalized]) return map[normalized];

                // 2. Direct hex or rgb format check
                if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw)) return raw;
                if (/^(rgb|hsl)a?\(.+?\)$/i.test(raw)) return raw;

                // 3. Composite variant names like "Creamy Pink / XL" or "Blue - 38" or "Beach (M)"
                const parts = raw.split(/[\/\-\,\(\)]/);
                if (parts.length > 1) {
                    const firstPart = parts[0].trim();
                    const firstNorm = firstPart.replace(/[-_/]/g, ' ').replace(/\s+/g, ' ').trim();
                    if (map[firstPart]) return map[firstPart];
                    if (map[firstNorm]) return map[firstNorm];
                }

                // 4. Modifier + base color decomposition (e.g. "creamy lavender", "pale pink", "dusty green", "soft blue")
                const words = normalized.split(' ');
                if (words.length > 1) {
                    const lastWord = words[words.length - 1];
                    const lastTwo = words.slice(-2).join(' ');
                    const baseColor = map[lastTwo] || map[lastWord];
                    if (baseColor && !baseColor.includes('gradient')) {
                        return baseColor;
                    }
                }

                // 5. Native CSS color validation fallback in browser (Option element)
                if (typeof window !== 'undefined' && window.Option) {
                    try {
                        const s = new window.Option().style;
                        s.color = normalized;
                        if (s.color) return normalized;
                    } catch (e) {}
                }

                return null;
            };
            if (typeof window !== 'undefined') {
                window.getColorHex = getColorHex;
            }

            const selectedAttributes = this.selectedAttributes = {};
            this.activeVariant = 'base'; // 'base' or a variant object

            // Auto-select lowest priced in-stock option initially if options exist
            if (allOptions.length > 0) {
                let lowestOpt = allOptions[0];
                let lowestPrice = Infinity;
                allOptions.forEach(opt => {
                    const optPrice = opt.isBase ? parseFloat(product.selling_price) : parseFloat(opt.price || product.selling_price);
                    const stock = Number(opt.stock);
                    if (stock > 0 && !isNaN(optPrice) && optPrice < lowestPrice) {
                        lowestPrice = optPrice;
                        lowestOpt = opt;
                    } else if (lowestPrice === Infinity && !isNaN(optPrice) && optPrice > 0) {
                        lowestOpt = opt;
                    }
                });
                this.activeVariant = lowestOpt.isBase ? 'base' : lowestOpt;
            }

            // Parse variant images for swatch previews
            const variantImageMap = {};
            variants.forEach(v => {
                let attrs = v.attributes;
                if (typeof attrs === 'string') { try { attrs = JSON.parse(attrs); } catch(e) { attrs = {}; } }
                let c = attrs?.color || attrs?.Color || attrs?.shade || attrs?.Shade;
                if (c) {
                    // c can be a string like "red,green" OR an array ["red","green"]
                    const colors = Array.isArray(c) ? c : String(c).split(',');
                    colors.map(x => String(x).trim()).filter(Boolean).forEach(x => {
                        if (x && v.image_url) variantImageMap[x.toLowerCase()] = v.image_url;
                    });
                }
            });

            // Function to render the Flipkart-style option pickers for the active selection ONLY
            function renderPickers() {
                selectorDiv.innerHTML = '';

                let colorsList = [];
                let sizesList = [];
                const otherGroups = {};

                if (self.activeVariant === 'base') {
                    // Extract base product options from metadata
                    colorsList = [...metaColors];
                    sizesList = [...metaSizes];

                    let prodAttrs = Object.assign({}, meta, metaAttrs);
                    Object.keys(prodAttrs).forEach(k => {
                        const kLower = k.toLowerCase().trim();
                        if (kLower.includes('image') || kLower === 'available_colors' || kLower === 'available_sizes' || kLower === 'attributes' || kLower === 'color' || kLower === 'size' || kLower === 'shade' || kLower === 'storage' || kLower === 'product_name' || kLower === 'sku') return;
                        const val = prodAttrs[k];
                        let list = [];
                        if (Array.isArray(val)) {
                            list = val.map(String).filter(Boolean);
                        } else if (val && typeof val === 'string') {
                            list = val.split(',').map(x => x.trim()).filter(Boolean);
                        }
                        if (list.length > 0 && !['brand', 'fabric_type', 'age', 'material', 'description'].includes(kLower)) {
                            otherGroups[k] = list;
                        }
                    });
                } else {
                    // Extract this specific variant's attributes
                    let attrs = self.activeVariant.attributes;
                    if (typeof attrs === 'string') { try { attrs = JSON.parse(attrs); } catch(e) { attrs = {}; } }
                    Object.keys(attrs).forEach(k => {
                        if (k.toLowerCase().includes('image') || k === 'name') return;
                        const val = attrs[k];
                        let list = [];
                        if (Array.isArray(val)) {
                            list = val.map(String).filter(Boolean);
                        } else if (val && typeof val === 'string') {
                            list = val.split(',').map(x => x.trim()).filter(Boolean);
                        }
                        if (list.length > 0) {
                            if (k === 'color' || k === 'shade') colorsList = list;
                            else if (k === 'size' || k === 'storage') sizesList = list;
                            else otherGroups[k] = list;
                        }
                    });

                    // Fall back to product metadata sizes if variant doesn't have custom sizes
                    if (sizesList.length === 0) {
                        sizesList = [...metaSizes];
                    }
                }

                // Deduplicate colorsList and sizesList case-insensitively
                const uniqueColors = [];
                colorsList.forEach(c => {
                    const trimmed = String(c || '').trim();
                    if (trimmed && !uniqueColors.some(x => x.toLowerCase() === trimmed.toLowerCase())) {
                        uniqueColors.push(trimmed);
                    }
                });
                colorsList = uniqueColors;

                const uniqueSizes = [];
                sizesList.forEach(s => {
                    const trimmed = String(s || '').trim();
                    if (trimmed && !uniqueSizes.some(x => x.toLowerCase() === trimmed.toLowerCase())) {
                        uniqueSizes.push(trimmed);
                    }
                });
                sizesList = uniqueSizes;

                let html = '<style>.hide-scrollbar::-webkit-scrollbar { display: none; } .hide-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }</style>';

                // 1. Variant chips list (e.g. White, Black) - styled similar to size
                if (allOptions.length > 0) {
                    const isColorVariants = allOptions.some(v => {
                        const n = (v.variant_name || '').toLowerCase().trim();
                        return getColorHex(n) !== null || (v.attributes && (v.attributes.color || v.attributes.shade));
                    });
                    const variantLabelText = isColorVariants ? 'Color' : 'Variant';
                    const activeName = (self.activeVariant === 'base')
                        ? baseName
                        : (self.activeVariant && self.activeVariant.variant_name ? self.activeVariant.variant_name : (allOptions[0].variant_name || 'Option'));
                    const activeDisplayName = activeName.charAt(0).toUpperCase() + activeName.slice(1);

                    html += `<div style="margin-bottom:14px;">`;
                    html += `<div style="font-weight:700;font-size:0.85rem;color:#212121;margin-bottom:10px;display:flex;align-items:center;gap:6px;">
                        Select ${variantLabelText}: <span id="selectedVariantLabel" style="font-weight:400;color:#555;">${activeDisplayName}</span>
                    </div>`;
                    html += `<div style="display:flex;flex-wrap:nowrap;gap:8px;overflow-x:auto;padding-bottom:8px;" id="variantChipList" class="hide-scrollbar">`;

                    allOptions.forEach((v, idx) => {
                        const vName = (v.variant_name || ('Option ' + (idx + 1))).trim();
                        const vDisplayName = vName.charAt(0).toUpperCase() + vName.slice(1);
                        const isActive = (v.isBase && self.activeVariant === 'base') || (!v.isBase && self.activeVariant && self.activeVariant.id === v.id);
                        const isOOS = v.stock !== undefined && v.stock !== null && Number(v.stock) <= 0;

                        // Color swatch dot if option is a color
                        let dotHtml = '';
                        const hex = getColorHex(vName) || (v.attributes?.color ? getColorHex(v.attributes.color) : null) || (v.attributes?.shade ? getColorHex(v.attributes.shade) : null);
                        if (hex) {
                            const isLight = ['#ffffff', '#faf9f6', '#fffffe', '#f8fafc', '#fafafa', '#fdfbf7', '#fffdd0', '#faf6eb', '#faf0e6'].includes(hex.toLowerCase());
                            dotHtml = `<span class="variant-color-dot" style="width:18px;height:18px;border-radius:50%;background:${hex};border:${isActive ? '2px solid #ffffff' : (isLight ? '1.5px solid #cbd5e1' : '1.5px solid rgba(0,0,0,0.15)')};box-shadow:0 1px 3px rgba(0,0,0,0.18);display:inline-block;flex-shrink:0;"></span>`;
                        }

                        if (isOOS) {
                            html += `
                                <button type="button" class="flipkart-attr-chip variant-select-btn" data-idx="${idx}" data-variant-id="${v.id || 'base'}" disabled
                                    title="Out of Stock"
                                    style="min-width:40px;height:38px;padding:0 14px;flex:0 0 auto;border:1px solid #e0e0e0;background:#f5f5f5;color:#9e9e9e;border-radius:4px;font-size:0.85rem;font-weight:400;cursor:not-allowed;transition:all 0.15s;text-align:center;display:inline-flex;align-items:center;justify-content:center;gap:8px;position:relative;text-decoration:line-through;opacity:0.6;">
                                    ${dotHtml}<span class="variant-name-label">${vDisplayName}</span>
                                </button>
                            `;
                        } else {
                            html += `
                                <button type="button" class="flipkart-attr-chip variant-select-btn" data-idx="${idx}" data-variant-id="${v.id || 'base'}"
                                    style="min-width:40px;height:38px;padding:0 14px;flex:0 0 auto;border:${isActive ? '2px solid #212121' : '1px solid #e0e0e0'};background:${isActive ? '#212121' : 'white'};color:${isActive ? 'white' : '#212121'};border-radius:4px;font-size:0.85rem;font-weight:${isActive ? '600' : '400'};cursor:pointer;transition:all 0.15s;text-align:center;display:inline-flex;align-items:center;justify-content:center;gap:8px;">
                                    ${dotHtml}<span class="variant-name-label">${vDisplayName}</span>
                                </button>
                            `;
                        }
                    });

                    html += '</div></div>';
                }

                // 2. Color chips list (when metadata color options exist without DB variants) - styled similar to size
                const colorKey = 'color';
                if (allOptions.length === 0 && colorsList.length > 0) {
                    if (!selectedAttributes[colorKey] || !colorsList.map(x => x.toLowerCase()).includes(selectedAttributes[colorKey].toLowerCase())) {
                        selectedAttributes[colorKey] = colorsList[0];
                    }
                    const activeColor = selectedAttributes[colorKey];
                    const activeColorDisplay = activeColor.charAt(0).toUpperCase() + activeColor.slice(1);

                    html += '<div style="margin-bottom:14px;">';
                    html += `<div style="font-weight:700;font-size:0.85rem;color:#212121;margin-bottom:10px;display:flex;align-items:center;gap:6px;">
                        Select Color: <span id="selectedColorLabel" style="font-weight:400;color:#555;">${activeColorDisplay}</span>
                    </div>`;
                    html += '<div style="display:flex;flex-wrap:nowrap;gap:8px;overflow-x:auto;padding-bottom:8px;" id="colorCardList" class="hide-scrollbar">';
                    colorsList.forEach((c) => {
                        const swatch = getColorHex(c);
                        const isActive = String(selectedAttributes[colorKey]).toLowerCase().trim() === String(c).toLowerCase().trim();
                        const cDisplay = c.charAt(0).toUpperCase() + c.slice(1);
                        
                        let dotHtml = '';
                        if (swatch) {
                            const isLight = ['#ffffff', '#faf9f6', '#fffffe', '#f8fafc', '#fafafa', '#fdfbf7', '#fffdd0', '#faf6eb', '#faf0e6'].includes(swatch.toLowerCase());
                            dotHtml = `<span class="variant-color-dot" style="width:18px;height:18px;border-radius:50%;background:${swatch};border:${isActive ? '2px solid #ffffff' : (isLight ? '1.5px solid #cbd5e1' : '1.5px solid rgba(0,0,0,0.15)')};box-shadow:0 1px 3px rgba(0,0,0,0.18);display:inline-block;flex-shrink:0;"></span>`;
                        }

                        html += `
                            <button type="button" class="flipkart-attr-chip flipkart-color-chip" data-attr-key="${colorKey}" data-attr-val="${c}"
                                style="min-width:40px;height:38px;padding:0 14px;flex:0 0 auto;border:${isActive ? '2px solid #212121' : '1px solid #e0e0e0'};background:${isActive ? '#212121' : 'white'};color:${isActive ? 'white' : '#212121'};border-radius:4px;font-size:0.85rem;font-weight:${isActive ? '600' : '400'};cursor:pointer;transition:all 0.15s;text-align:center;display:inline-flex;align-items:center;justify-content:center;gap:8px;">
                                ${dotHtml}<span class="variant-name-label">${cDisplay}</span>
                            </button>
                        `;
                    });
                    html += '</div></div>';
                }

                // 3. Sizes chips list
                const sizeKey = 'size';
                if (sizesList.length > 0) {
                    // Get per-size stock and price map from metadata or variant attributes
                    let sizeStockMap = {};
                    let sizePriceMap = {};
                    if (self.activeVariant === 'base') {
                        sizeStockMap = meta.size_stock || meta.attributes?.size_stock || {};
                        if (typeof sizeStockMap === 'string') { try { sizeStockMap = JSON.parse(sizeStockMap); } catch(e) { sizeStockMap = {}; } }
                        sizePriceMap = meta.size_price || meta.attributes?.size_price || meta.size_prices || meta.attributes?.size_prices || {};
                        if (typeof sizePriceMap === 'string') { try { sizePriceMap = JSON.parse(sizePriceMap); } catch(e) { sizePriceMap = {}; } }
                    } else {
                        let attrs = self.activeVariant.attributes;
                        if (typeof attrs === 'string') { try { attrs = JSON.parse(attrs); } catch(e) { attrs = {}; } }
                        sizeStockMap = attrs.size_stock || {};
                        if (typeof sizeStockMap === 'string') { try { sizeStockMap = JSON.parse(sizeStockMap); } catch(e) { sizeStockMap = {}; } }
                        sizePriceMap = attrs.size_price || attrs.size_prices || {};
                        if (typeof sizePriceMap === 'string') { try { sizePriceMap = JSON.parse(sizePriceMap); } catch(e) { sizePriceMap = {}; } }

                        // Fallback to product metadata if variant doesn't define custom size stocks/prices
                        if (Object.keys(sizeStockMap).length === 0) {
                            sizeStockMap = meta.size_stock || meta.attributes?.size_stock || {};
                            if (typeof sizeStockMap === 'string') { try { sizeStockMap = JSON.parse(sizeStockMap); } catch(e) { sizeStockMap = {}; } }
                        }
                        if (Object.keys(sizePriceMap).length === 0) {
                            sizePriceMap = meta.size_price || meta.attributes?.size_price || meta.size_prices || meta.attributes?.size_prices || {};
                            if (typeof sizePriceMap === 'string') { try { sizePriceMap = JSON.parse(sizePriceMap); } catch(e) { sizePriceMap = {}; } }
                        }
                    }

                    // Skip OOS sizes and auto-select the size with the lowest price
                    const availableSizes = sizesList.filter(s => {
                        const stock = sizeStockMap[s];
                        return stock === undefined || stock === null || Number(stock) > 0;
                    });
                    const candidateSizes = availableSizes.length > 0 ? availableSizes : sizesList;
                    let defaultSize = candidateSizes[0];
                    if (candidateSizes.length > 1) {
                        defaultSize = candidateSizes.reduce((minS, curS) => {
                            const pCur = (sizePriceMap && sizePriceMap[curS] !== undefined && sizePriceMap[curS] !== null && sizePriceMap[curS] !== '') ? parseFloat(sizePriceMap[curS]) : (parseFloat(product.selling_price) || 0);
                            const pMin = (sizePriceMap && sizePriceMap[minS] !== undefined && sizePriceMap[minS] !== null && sizePriceMap[minS] !== '') ? parseFloat(sizePriceMap[minS]) : (parseFloat(product.selling_price) || 0);
                            return (!isNaN(pCur) && pCur > 0 && (isNaN(pMin) || pCur < pMin)) ? curS : minS;
                        }, candidateSizes[0]);
                    }

                    if (!selectedAttributes[sizeKey] || !sizesList.map(x => x.toLowerCase()).includes(selectedAttributes[sizeKey].toLowerCase())) {
                        selectedAttributes[sizeKey] = defaultSize;
                    }
                    html += `<div style="margin-bottom:14px;">`;
                    html += `<div style="font-weight:700;font-size:0.85rem;color:#212121;margin-bottom:10px;display:flex;align-items:center;gap:6px;">
                        Select Size: <span id="selectedSizeLabel" style="font-weight:400;color:#555;">${selectedAttributes[sizeKey]}</span>
                    </div>`;
                    html += `<div style="display:flex;flex-wrap:nowrap;gap:8px;overflow-x:auto;padding-bottom:8px;" id="attrChipList_${sizeKey}" class="hide-scrollbar">`;
                    sizesList.forEach((v) => {
                        const isActive = String(selectedAttributes[sizeKey]).toLowerCase().trim() === String(v).toLowerCase().trim();
                        const sizeStock = sizeStockMap[v];
                        const isOOS = sizeStock !== undefined && sizeStock !== null && Number(sizeStock) === 0;

                        if (isOOS) {
                            // Show disabled chip with strikethrough for out-of-stock size
                            html += `
                                <button type="button" class="flipkart-attr-chip" data-attr-key="${sizeKey}" data-attr-val="${v}" disabled
                                    title="Out of Stock"
                                    style="min-width:40px;height:36px;padding:0 12px;flex:0 0 auto;border:1px solid #e0e0e0;background:#f5f5f5;color:#9e9e9e;border-radius:4px;font-size:0.85rem;font-weight:400;cursor:not-allowed;transition:all 0.15s;text-align:center;display:inline-flex;align-items:center;justify-content:center;position:relative;text-decoration:line-through;opacity:0.6;">
                                    ${v}
                                </button>
                            `;
                        } else {
                            html += `
                                <button type="button" class="flipkart-attr-chip" data-attr-key="${sizeKey}" data-attr-val="${v}" style="min-width:40px;height:36px;padding:0 12px;flex:0 0 auto;border:${isActive ? '2px solid #212121' : '1px solid #e0e0e0'};background:${isActive ? '#212121' : 'white'};color:${isActive ? 'white' : '#212121'};border-radius:4px;font-size:0.85rem;font-weight:${isActive ? '600' : '400'};cursor:pointer;transition:all 0.15s;text-align:center;display:inline-flex;align-items:center;justify-content:center;">
                                    ${v}
                                </button>
                            `;
                        }
                    });
                    html += '</div></div>';
                }

                // 3. Other attributes chips list
                Object.keys(otherGroups).forEach(k => {
                    const vals = otherGroups[k];
                    if (vals.length === 0) return;
                    if (!selectedAttributes[k] || !vals.map(x => x.toLowerCase()).includes(selectedAttributes[k].toLowerCase())) {
                        selectedAttributes[k] = vals[0];
                    }
                    const label = k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, ' ');
                    html += `<div style="margin-bottom:14px;">`;
                    html += `<div style="font-weight:700;font-size:0.85rem;color:#212121;margin-bottom:10px;display:flex;align-items:center;gap:6px;">
                        Select ${label}: <span id="selected_${k}_Label" style="font-weight:400;color:#555;">${selectedAttributes[k]}</span>
                    </div>`;
                    html += `<div style="display:flex;flex-wrap:nowrap;gap:8px;overflow-x:auto;padding-bottom:8px;" id="attrChipList_${k}" class="hide-scrollbar">`;
                    vals.forEach((v) => {
                        const isActive = String(selectedAttributes[k]).toLowerCase().trim() === String(v).toLowerCase().trim();
                        html += `
                            <button type="button" class="flipkart-attr-chip" data-attr-key="${k}" data-attr-val="${v}" style="min-width:40px;height:36px;padding:0 10px;flex:0 0 auto;border:${isActive ? '2px solid #212121' : '1px solid #e0e0e0'};background:white;color:#212121;border-radius:4px;font-size:0.85rem;font-weight:${isActive ? '600' : '400'};cursor:pointer;transition:all 0.15s;text-align:center;display:inline-flex;align-items:center;justify-content:center;">
                                ${v}
                            </button>
                        `;
                    });
                    html += '</div></div>';
                });

                // "All Variant Options" list and stock count removed as requested
                
                // End of pickers HTML
                selectorDiv.innerHTML = html;

                bindClickListeners();
                applyCompressedImages();
                updateStockAndCartDetails();
            }

            function bindClickListeners() {
                // Click handlers for Color Chips / Cards
                selectorDiv.querySelectorAll('.flipkart-color-chip, .flipkart-color-card').forEach(card => {
                    card.addEventListener('click', () => {
                        if (card.disabled) return;
                        const key = card.dataset.attrKey;
                        selectedAttributes[key] = card.dataset.attrVal;
                        
                        const colorVal = card.dataset.attrVal;
                        const vImg = variantImageMap[colorVal.toLowerCase()];
                        if (vImg) {
                            img.setAttribute('data-original-src', vImg);
                            compressImageUrl(vImg, 600, 0.7).then(c => { img.src = c; });
                        }
                        
                        renderPickers();
                    });
                });

                // Click handlers for Attribute Chips
                selectorDiv.querySelectorAll('.flipkart-attr-chip').forEach(chip => {
                    chip.addEventListener('click', () => {
                        if (chip.disabled) return; // Skip disabled (Out of Stock) chips
                        if (chip.classList.contains('variant-select-btn') || chip.classList.contains('flipkart-color-chip')) return;
                        const key = chip.dataset.attrKey;
                        selectedAttributes[key] = chip.dataset.attrVal;
                        
                        renderPickers();
                    });
                });

                // Click handlers for Variant Select Buttons (allOptions: White, Black, etc.)
                selectorDiv.querySelectorAll('.variant-select-btn').forEach(btn => {
                    btn.addEventListener('click', () => {
                        if (btn.disabled) return;
                        const idx = parseInt(btn.dataset.idx);
                        const targetOption = allOptions[idx];
                        if (!targetOption) return;

                        if (targetOption.isBase) {
                            self.activeVariant = 'base';
                            
                            // Reset selectedAttributes
                            Object.keys(selectedAttributes).forEach(k => delete selectedAttributes[k]);
                            
                            const baseUrl = self.getAssetUrl(product.product_image || 'assets/default-product.png');
                            img.setAttribute('data-original-src', baseUrl);
                            compressImageUrl(baseUrl, 600, 0.7).then(c => { img.src = c; });

                            // Sync thumbnail highlight to primary image
                            if (thumbs) {
                                thumbs.querySelectorAll('.detail-thumb').forEach((el, i) => {
                                    const thumbUrl = el.getAttribute('data-original-url') || '';
                                    const isPrimary = i === 0 || thumbUrl === baseUrl || thumbUrl === product.product_image;
                                    el.classList.toggle('active', isPrimary);
                                    el.style.border = isPrimary ? '3px solid var(--public-primary)' : '2px solid #ddd';
                                });
                                self.updatePdpImageCounter();
                            }
                            
                            self.setProductDetailPrice(product.selling_price, currency);
                            nameEl.textContent = self.formatProductTitle(product.product_name, selectedAttributes['color'], selectedAttributes['size']);
                            
                            renderPickers();
                        } else {
                            self.activeVariant = targetOption;
                            
                            // Reset selectedAttributes for this variant
                            Object.keys(selectedAttributes).forEach(k => delete selectedAttributes[k]);
                            
                            const variantUrl = targetOption.image_url;
                            if (variantUrl) {
                                img.setAttribute('data-original-src', variantUrl);
                                compressImageUrl(variantUrl, 600, 0.7).then(c => { img.src = c; });

                                // Sync thumbnail highlight to this variant's image
                                if (thumbs) {
                                    thumbs.querySelectorAll('.detail-thumb').forEach(el => {
                                        const thumbUrl = el.getAttribute('data-original-url') || '';
                                        const isMatch = thumbUrl === variantUrl;
                                        el.classList.toggle('active', isMatch);
                                        el.style.border = isMatch ? '3px solid var(--public-primary)' : '2px solid #ddd';
                                    });
                                    self.updatePdpImageCounter();
                                }
                            }
                            self.setProductDetailPrice(targetOption.price || product.selling_price, currency);
                            nameEl.textContent = self.formatProductTitle(product.product_name, targetOption.variant_name, selectedAttributes['size']);
                            
                            renderPickers();
                        }
                    });
                });
            }

            function updateStockAndCartDetails() {
                const stockEl = document.getElementById('variantStockInfo');
                const specsBox = document.getElementById('variantSpecsBox');
                
                // Update specsBox content
                if (specsBox) {
                    specsBox.innerHTML = '';
                    
                    let attrs = {};
                    if (self.activeVariant === 'base') {
                        attrs = meta.attributes || meta || {};
                        if (typeof attrs === 'string') { try { attrs = JSON.parse(attrs); } catch(e) { attrs = {}; } }
                    } else {
                        attrs = self.activeVariant.attributes;
                        if (typeof attrs === 'string') { try { attrs = JSON.parse(attrs); } catch(e) { attrs = {}; } }
                    }
                    
                    // Also skip color/shade/size/storage since they are shown as interactive pickers above
                    const skip = ['name', 'product_images', 'product_image', 'variant_images', 'variant_group', 'variant_size', 'variant_color', 'variant_label', 'has_variants', 'base_stock', 'color', 'shade', 'size', 'storage', 'available_colors', 'available_sizes'];
                    
                    // Merge activeVariant attributes and base meta attributes
                    let baseMeta = meta || {};
                    const orderedKeys = Object.keys(baseMeta).filter(k => !skip.includes(k) && !k.toLowerCase().includes('image') && k !== 'attributes' && k !== 'color' && k !== 'shade' && k !== 'size' && k !== 'storage');
                    
                    if (attrs) {
                        Object.keys(attrs).forEach(k => {
                            if (!orderedKeys.includes(k) && !skip.includes(k) && !k.toLowerCase().includes('image') && k !== 'color' && k !== 'shade' && k !== 'size' && k !== 'storage') {
                                orderedKeys.push(k);
                            }
                        });
                    }
                    
                    let specStrings = [];
                    orderedKeys.forEach((k) => {
                        const val = (attrs && attrs[k] !== undefined) ? attrs[k] : baseMeta[k];
                        if (val !== undefined && val !== null && val !== '') {
                            const valStr = String(val);
                            if (!Array.isArray(val) && typeof val !== 'object' && !k.toLowerCase().includes('image') && !valStr.includes('://') && !valStr.startsWith('[') && !valStr.startsWith('data:')) {
                                const lbl = k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, ' ');
                                specStrings.push(`<div style="display:flex;flex-direction:column;background:#ffffff;border:1px solid #e2e8f0;padding:10px 14px;border-radius:8px;flex:1 1 45%;max-width:calc(50% - 5px);box-sizing:border-box;"><span style="font-size:0.8rem;color:#64748b;margin-bottom:4px;font-weight:500;">${lbl}</span><span style="font-size:0.95rem;color:#0f172a;font-weight:600;word-break:break-word;">${val}</span></div>`);
                            }
                        }
                    });
                    if (specStrings.length > 0) {
                        specsBox.innerHTML = '<div style="margin-top:16px;width:100%;display:block;"><div style="font-weight:700;color:#212121;margin-bottom:12px;font-size:1rem;display:block;">Specifications</div><div style="display:flex;flex-wrap:wrap;gap:10px;width:100%;box-sizing:border-box;">' + specStrings.join('') + '</div></div>';
                    }
                    if (typeof window.renderProductSpecs2Col === 'function') {
                        window.renderProductSpecs2Col(specsBox, self.activeVariant === 'base' ? null : attrs, meta);
                    }
                }
                
                // Now update stock & cart buttons
                if (self.activeVariant === 'base') {
                    const selectedSize = selectedAttributes['size'] || selectedAttributes['storage'];
                    let sizePriceMap = meta.size_price || meta.attributes?.size_price || meta.size_prices || meta.attributes?.size_prices || {};
                    if (typeof sizePriceMap === 'string') { try { sizePriceMap = JSON.parse(sizePriceMap); } catch(e) { sizePriceMap = {}; } }
                    
                    let activePrice = parseFloat(product.selling_price) || 0;
                    if (selectedSize && sizePriceMap && sizePriceMap[selectedSize] !== undefined && sizePriceMap[selectedSize] !== null && sizePriceMap[selectedSize] !== '') {
                        const parsedP = parseFloat(sizePriceMap[selectedSize]);
                        if (!isNaN(parsedP) && parsedP > 0) activePrice = parsedP;
                    }

                    addBtn.setAttribute('data-id', product.id);
                    addBtn.removeAttribute('data-variant-id');
                    addBtn.removeAttribute('data-variant-name');
                    addBtn.setAttribute('data-price', activePrice);
                    addBtn.disabled = false;
                    addBtn.style.opacity = '1';
                    
                    addBtn.onclick = (e) => {
                        const selColor = selectedAttributes['color'] || selectedAttributes['shade'] || self.getProductDefaultColor(product);
                        const selSize = selectedAttributes['size'] || selectedAttributes['storage'] || self.getProductDefaultSize(product);
                        self.addToCartWithOptions(product, selColor, selSize, e, activePrice);
                    };

                    const buyBtn = document.getElementById('detailBuyNow');
                    if (buyBtn) {
                        buyBtn.disabled = false;
                        buyBtn.style.opacity = '1';
                        buyBtn.onclick = (e) => {
                            if (buyBtn.disabled) return;
                            addBtn.click();
                            setTimeout(() => {
                                const cartSidebar = document.getElementById('cartSidebar');
                                if (cartSidebar) cartSidebar.classList.add('active');
                            }, 300);
                        };
                    }
                    
                    const baseStock = meta?.base_stock || product.stock;
                    const numStock = Number(baseStock) || 0;
                    if (stockEl) {
                        stockEl.textContent = baseStock + ' in stock';
                        stockEl.style.color = '#16a34a';
                        stockEl.style.display = 'block';
                    }
                    const stockBadge = document.getElementById('detailStockBadge');
                    if (stockBadge) {
                        if (numStock <= 0) {
                            stockBadge.textContent = 'Out of Stock';
                            stockBadge.style.background = '#fee2e2';
                            stockBadge.style.color = '#991b1b';
                            stockBadge.style.display = 'inline-block';
                        } else if (numStock <= 3) {
                            stockBadge.textContent = `Only ${numStock} left!`;
                            stockBadge.style.background = '#fef3c7';
                            stockBadge.style.color = '#92400e';
                            stockBadge.style.display = 'inline-block';
                        } else {
                            stockBadge.textContent = `In Stock (${numStock})`;
                            stockBadge.style.background = '#dcfce7';
                            stockBadge.style.color = '#166534';
                            stockBadge.style.display = 'inline-block';
                        }
                    }

                    // Update product name with selected options
                    const activeColor = selectedAttributes['color'] || selectedAttributes['shade'] || (metaColors && metaColors.length > 0 ? metaColors[0] : '');
                    const activeSize = selectedAttributes['size'] || selectedAttributes['storage'] || (metaSizes && metaSizes.length > 0 ? metaSizes[0] : '');
                    const nameString = self.formatProductTitle(product.product_name, activeColor, activeSize);
                    
                    self.setProductDetailPrice(activePrice, currency);
                    nameEl.textContent = nameString;
                    nameEl.style.display = 'block';
                    
                    const catEl = document.getElementById('detailCat');
                    if(catEl && product.category) {
                        catEl.textContent = product.category;
                        catEl.style.display = 'inline-block';
                    } else if (catEl) {
                        catEl.style.display = 'none';
                    }
                } else {
                    const v = self.activeVariant;
                    let vAttrs = v.attributes || {};
                    if (typeof vAttrs === 'string') { try { vAttrs = JSON.parse(vAttrs); } catch(e) { vAttrs = {}; } }
                    let vSizePriceMap = vAttrs.size_price || vAttrs.size_prices || {};
                    if (typeof vSizePriceMap === 'string') { try { vSizePriceMap = JSON.parse(vSizePriceMap); } catch(e) { vSizePriceMap = {}; } }

                    const selectedSize = selectedAttributes['size'] || selectedAttributes['storage'];
                    let activePrice = parseFloat(v.price || product.selling_price) || 0;
                    if (selectedSize && vSizePriceMap && vSizePriceMap[selectedSize] !== undefined && vSizePriceMap[selectedSize] !== null && vSizePriceMap[selectedSize] !== '') {
                        const parsedP = parseFloat(vSizePriceMap[selectedSize]);
                        if (!isNaN(parsedP) && parsedP > 0) activePrice = parsedP;
                    }

                    const vStock = Number(v.stock) || 0;
                    if (stockEl) {
                        if (vStock > 0) {
                            stockEl.textContent = vStock + ' in stock';
                            stockEl.style.color = '#16a34a';
                            stockEl.style.display = 'block';
                        } else {
                            stockEl.textContent = 'Out of stock';
                            stockEl.style.color = '#dc2626';
                            stockEl.style.display = 'block';
                        }
                    }
                    const stockBadge = document.getElementById('detailStockBadge');
                    if (stockBadge) {
                        if (vStock <= 0) {
                            stockBadge.textContent = 'Out of Stock';
                            stockBadge.style.background = '#fee2e2';
                            stockBadge.style.color = '#991b1b';
                            stockBadge.style.display = 'inline-block';
                        } else if (vStock <= 3) {
                            stockBadge.textContent = `Only ${vStock} left!`;
                            stockBadge.style.background = '#fef3c7';
                            stockBadge.style.color = '#92400e';
                            stockBadge.style.display = 'inline-block';
                        } else {
                            stockBadge.textContent = `In Stock (${vStock})`;
                            stockBadge.style.background = '#dcfce7';
                            stockBadge.style.color = '#166534';
                            stockBadge.style.display = 'inline-block';
                        }
                    }
                    addBtn.disabled = vStock <= 0;
                    addBtn.style.opacity = vStock <= 0 ? '0.5' : '1';
                    addBtn.setAttribute('data-id', product.id);
                    addBtn.setAttribute('data-variant-id', v.id);
                    addBtn.setAttribute('data-variant-name', v.variant_name);
                    addBtn.setAttribute('data-variant-price', activePrice);
                    
                    addBtn.onclick = (e) => {
                        if (vStock <= 0) { return; }
                        self.addToCartWithVariant(product, v, e, selectedAttributes, activePrice);
                    };

                    const buyBtn = document.getElementById('detailBuyNow');
                    if (buyBtn) {
                        buyBtn.disabled = vStock <= 0;
                        buyBtn.style.opacity = vStock <= 0 ? '0.5' : '1';
                        buyBtn.onclick = (e) => {
                            if (vStock <= 0) return;
                            addBtn.click();
                            setTimeout(() => {
                                const cartSidebar = document.getElementById('cartSidebar');
                                if (cartSidebar) cartSidebar.classList.add('active');
                            }, 300);
                        };
                    }

                    // Update product name with variant + selected options
                    const activeSize = selectedAttributes['size'] || selectedAttributes['storage'] || '';
                    const nameString = self.formatProductTitle(product.product_name, v.variant_name, activeSize);
                    
                    self.setProductDetailPrice(activePrice, currency);
                    nameEl.textContent = nameString;
                    nameEl.style.display = 'block';
                    
                    const catEl = document.getElementById('detailCat');
                    if(catEl && product.category) {
                        catEl.textContent = product.category;
                        catEl.style.display = 'inline-block';
                    } else if (catEl) {
                        catEl.style.display = 'none';
                    }
                }
            }

            // Append specsBox FIRST so updateStockAndCartDetails() can find it by ID
            const specsBox = document.createElement('div');
            specsBox.id = 'variantSpecsBox';
            specsBox.style.cssText = 'margin-top:4px;';
            specsContainer.appendChild(specsBox);

            // Move the selectorDiv (variant pickers) to be above the price block, matching Flipkart layout
            const priceBlock = document.querySelector('.pdp-price-block');
            if (priceBlock && priceBlock.parentNode) {
                priceBlock.parentNode.insertBefore(selectorDiv, priceBlock);
            } else {
                specsContainer.appendChild(selectorDiv);
            }
            
            renderPickers(); // call INSIDE this block — renderPickers is in scope here
        } else {
            // No variants - show regular product thumbnails
            if (thumbs) {
                let extraImages = product.product_images || [];
                if (typeof extraImages === 'string') { try { extraImages = JSON.parse(extraImages); } catch(e) { extraImages = []; } }
                
                let imageList = [];
                if (product.product_image && !product.product_image.includes('default-product')) {
                    imageList.push(this.getAssetUrl(product.product_image));
                }
                extraImages.forEach(url => {
                    const fullUrl = this.getAssetUrl(url);
                    if (!imageList.includes(fullUrl)) imageList.push(fullUrl);
                });

                if (imageList.length > 1) {
                    imageList.forEach((url, idx) => {
                        const t = document.createElement('img');
                        t.className = 'detail-thumb' + (idx === 0 ? ' active' : '');
                        t.setAttribute('data-original-url', url);
                        // Extreme compression for thumbnails
                        // Improved compression for clear thumbnails
                        compressImageUrl(url, 150, 0.6).then(c => { t.src = c; });
                        t.onclick = (e) => {
                            e.stopPropagation();
                            img.setAttribute('data-original-src', url);
                            compressImageUrl(url, 600, 0.7).then(c => { img.src = c; });
                            thumbs.querySelectorAll('.detail-thumb').forEach(el => { el.classList.remove('active'); el.style.border = '2px solid #e2e8f0'; });
                            t.classList.add('active');
                            t.style.border = '3px solid var(--public-primary)';
                            // Auto-scroll clicked thumbnail to center
                            t.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
                            self.updatePdpImageCounter(idx + 1, imageList.length);
                        };
                        thumbs.appendChild(t);
                    });
                    thumbs.style.display = 'flex';
                    thumbs.scrollLeft = 0;
                    this.updatePdpImageCounter(1, imageList.length);
                    // Hide scroll buttons - clicking thumbnails auto-centers them
                    const leftBtn = document.getElementById('thumbScrollLeft');
                    const rightBtn = document.getElementById('thumbScrollRight');
                    if (leftBtn) leftBtn.style.display = 'none';
                    if (rightBtn) rightBtn.style.display = 'none';
                }
            }
        }

        // For products WITHOUT variants, show static specs from metadata
        if (!(variants.length > 0 || metaColors.length > 0 || metaSizes.length > 0)) {
            const specsBox2 = document.createElement('div');
            specsBox2.id = 'variantSpecsBox';
            specsBox2.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;';
            if (meta && typeof meta === 'object') {
                const skip = ['product_images','product_image','variant_images','variant_group','variant_size','variant_color','variant_label','has_variants','base_stock'];
                for (const [k, v] of Object.entries(meta)) {
                    const vs = String(v);
                    if (v && !skip.includes(k) && !k.toLowerCase().includes('image') && !Array.isArray(v) && typeof v !== 'object' && !vs.includes('://') && !vs.startsWith('[') && !vs.startsWith('data:')) {
                        const lbl = k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, ' ');
                        specsBox2.innerHTML += '<div class="spec-chip"><i class="fas fa-check-circle"></i><span><strong>' + lbl + ':</strong> ' + v + '</span></div>';
                    }
                }
            }
            specsContainer.appendChild(specsBox2);
        }

        // Show modal
        modal.style.display = 'flex';
        requestAnimationFrame(() => { modal.classList.add('active'); });
        document.body.style.overflow = 'hidden'; document.documentElement.style.overflow = 'hidden';
    }

    addToCartWithVariant(product, variant, event, selectedOpts = null, customPrice = null) {
        let optionText = '';
        if (selectedOpts) {
            const list = Object.values(selectedOpts).filter(Boolean);
            if (list.length > 0) optionText = ' - ' + list.join(', ');
        }
        const effectivePrice = (customPrice !== null && !isNaN(customPrice) && customPrice > 0) ? customPrice : (parseFloat(variant.price || product.selling_price) || 0);
        const cartId = product.id + '_' + variant.id + (optionText ? '_' + optionText.replace(/\s+/g, '_') : '') + '_' + effectivePrice;
        const existing = this.cart.find(item => item.id === cartId);

        const activeSize = selectedOpts ? (selectedOpts['size'] || selectedOpts['storage'] || '') : '';
        const fullName = this.formatProductTitle(product.product_name, variant.variant_name, activeSize);

        if (existing) {
            if (existing.quantity >= variant.stock) {
                showNotification('Maximum stock reached for this variant', 'warning');
                return;
            }
            existing.name = fullName;
            existing.quantity++;
        } else {
            this.cart.push({
                id: cartId,
                name: fullName,
                price: effectivePrice,
                image: variant.image_url || product.product_image,
                quantity: 1
            });
        }

        this.saveCartToStorage();
        this.updateCartUI();

        // Animation (same as addToCart)
        if (event) {
            const btn = event.currentTarget || event.target;
            const cartIcon = document.getElementById('cartToggle');
            const productImg = document.getElementById('detailImage');

            if (productImg && cartIcon) {
                const flyingImg = document.createElement('img');
                flyingImg.src = productImg.src;
                flyingImg.className = 'flying-img';
                const rect = productImg.getBoundingClientRect();
                flyingImg.style.top = rect.top + 'px';
                flyingImg.style.left = rect.left + 'px';
                flyingImg.style.width = rect.width + 'px';
                flyingImg.style.height = rect.height + 'px';
                document.body.appendChild(flyingImg);
                const cartRect = cartIcon.getBoundingClientRect();
                setTimeout(() => {
                    flyingImg.style.top = (cartRect.top + 10) + 'px';
                    flyingImg.style.left = (cartRect.left + 10) + 'px';
                    flyingImg.style.width = '20px';
                    flyingImg.style.height = '20px';
                    flyingImg.style.opacity = '0.5';
                }, 10);
                setTimeout(() => {
                    flyingImg.remove();
                    cartIcon.classList.add('cart-bounce');
                    setTimeout(() => cartIcon.classList.remove('cart-bounce'), 400);
                }, 1200);
            }

            if (btn) {
                const original = btn.innerHTML;
                btn.innerHTML = '<i class="fas fa-check"></i> Added!';
                btn.classList.add('added');
                setTimeout(() => { btn.innerHTML = original; btn.classList.remove('added'); }, 1500);
            }
        }
    }

    addToCartWithOptions(product, selectedColor, selectedSize, event, customPrice = null) {
        const finalColor = selectedColor || this.getProductDefaultColor(product);
        const finalSize = selectedSize || this.getProductDefaultSize(product);
        const effectivePrice = (customPrice !== null && !isNaN(customPrice) && customPrice > 0) ? customPrice : (parseFloat(product.selling_price) || 0);
        const opts = [finalColor, finalSize].filter(Boolean).join(' / ');
        const cartId = product.id + (opts ? '_' + opts.replace(/\s+/g, '_') : '') + '_' + effectivePrice;
        const fullName = this.formatProductTitle(product.product_name, finalColor, finalSize);

        const existing = this.cart.find(item => item.id === cartId || (item.id === product.id && !String(item.id).includes('_')));
        if (existing) {
            existing.id = cartId;
            existing.name = fullName;
            existing.quantity++;
        } else {
            this.cart.push({
                id: cartId,
                name: fullName,
                price: effectivePrice,
                image: product.product_image,
                quantity: 1
            });
        }

        this.saveCartToStorage();
        this.updateCartUI();

        if (event) {
            const btn = event.currentTarget || event.target;
            const cartIcon = document.getElementById('cartToggle');
            const productImg = document.getElementById('detailImage');

            if (productImg && cartIcon) {
                const flyingImg = document.createElement('img');
                flyingImg.src = productImg.src;
                flyingImg.className = 'flying-img';
                const rect = productImg.getBoundingClientRect();
                flyingImg.style.top = rect.top + 'px';
                flyingImg.style.left = rect.left + 'px';
                flyingImg.style.width = rect.width + 'px';
                flyingImg.style.height = rect.height + 'px';
                document.body.appendChild(flyingImg);
                const cartRect = cartIcon.getBoundingClientRect();
                setTimeout(() => {
                    flyingImg.style.top = (cartRect.top + 10) + 'px';
                    flyingImg.style.left = (cartRect.left + 10) + 'px';
                    flyingImg.style.width = '20px';
                    flyingImg.style.height = '20px';
                    flyingImg.style.opacity = '0.5';
                }, 10);
                setTimeout(() => {
                    flyingImg.remove();
                    cartIcon.classList.add('cart-bounce');
                    setTimeout(() => cartIcon.classList.remove('cart-bounce'), 400);
                }, 1200);
            }

            if (btn) {
                const original = btn.innerHTML;
                btn.innerHTML = '<i class="fas fa-check"></i> Added!';
                btn.classList.add('added');
                setTimeout(() => { btn.innerHTML = original; btn.classList.remove('added'); }, 1500);
            }
        }
    }
}


let app;
document.addEventListener('DOMContentLoaded', () => { app = new ShopProductsViewer(); window.app = app; });





function formatDescs() {
    document.querySelectorAll('#detailDesc, [class*="desc"]').forEach(el => {
        if (!el.classList.contains('formatted')) {
            el.style.whiteSpace = 'pre-line';
            el.style.lineHeight = '1.6';
            el.classList.add('formatted');
        }
    });
}

if (document.readyState === 'complete') formatDescs();
else document.addEventListener('DOMContentLoaded', formatDescs);



