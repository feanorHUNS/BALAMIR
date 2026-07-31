// ============================================================================
// LINK ONIZLEME  (/api/link-preview)
// ============================================================================
// Bot bir mesaja kendi embed'ini eklediginde Discord, metindeki baglantilar icin
// OTOMATIK onizleme URETMEZ. Bu yuzden onizlemeyi kendimiz olusturuyoruz:
// hedef sayfanin Open Graph etiketlerini okuyup Discord embed'ine ceviriyoruz.
//
// Istek (JSON): { url: "https://..." }
// Yanit: { ok, preview: { title, description, image, siteName, url } }

/** HTML icinden bir meta etiketinin icerigini cikarir (og:, twitter: veya name=). */
function metaContent(html, keys) {
    for (const key of keys) {
        // property="og:title" content="..."  ya da  content="..." property="og:title"
        const patterns = [
            new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']`, 'i'),
            new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${key}["']`, 'i')
        ];
        for (const re of patterns) {
            const m = html.match(re);
            if (m && m[1] && m[1].trim()) return decodeEntities(m[1].trim());
        }
    }
    return null;
}

function decodeEntities(str) {
    return String(str)
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
        .replace(/&nbsp;/g, ' ');
}

/**
 * Metindeki ILK baglantinin onizlemesini Discord embed'i olarak dondurur.
 * Bot kendi embed'ini ekledigi anda Discord otomatik onizleme URETMEZ; ayrica
 * bazi kanallarda botun "Embed Links" izni olmayabilir. Bu yuzden onizlemeyi
 * her durumda kendimiz uretiyoruz.
 *
 * worker.js hem zamanlanmis paylasimlarda hem hatirlatmalarda bunu kullanir.
 * @returns {object|null} Discord embed nesnesi ya da null
 */
export async function buildLinkPreviewEmbedFromText(text) {
    const m = String(text || '').match(/https?:\/\/[^\s<>"']+/);
    if (!m) return null;
    const p = await fetchLinkPreview(m[0]);
    if (!p || (!p.title && !p.description)) return null;

    const embed = { url: p.url, color: 0x5865f2 };
    if (p.title) embed.title = p.title;
    if (p.description) embed.description = p.description;
    if (p.image) embed.image = { url: p.image };
    if (p.siteName) embed.footer = { text: p.siteName };
    return embed;
}

/** Bir adresin Open Graph bilgilerini okur. Basarisizsa null doner. */
export async function fetchLinkPreview(raw) {
    let url;
    try {
        url = new URL(raw);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
        const host = url.hostname.toLowerCase();
        if (host === 'localhost' || host.startsWith('127.') || host.startsWith('10.') ||
            host.startsWith('192.168.') || host.endsWith('.internal')) return null;
    } catch (e) { return null; }

    try {
        const res = await fetch(url.toString(), {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; HUNSGuildPortal/1.0; +https://balamir.huns.workers.dev)',
                'Accept': 'text/html,application/xhtml+xml'
            },
            redirect: 'follow'
        });
        if (!res.ok) return null;
        const ctype = res.headers.get('content-type') || '';
        if (!ctype.includes('text/html')) return null;

        const html = (await res.text()).slice(0, 120000);
        const title = metaContent(html, ['og:title', 'twitter:title']) ||
            (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || null;
        const description = metaContent(html, ['og:description', 'twitter:description', 'description']);
        let image = metaContent(html, ['og:image', 'og:image:url', 'twitter:image']);
        const siteName = metaContent(html, ['og:site_name']);

        if (image && !/^https?:\/\//i.test(image)) {
            try { image = new URL(image, url.origin).toString(); } catch (e) { image = null; }
        }

        return {
            url: url.toString(),
            title: title ? decodeEntities(title).slice(0, 250) : null,
            description: description ? description.slice(0, 400) : null,
            image: image || null,
            siteName: siteName || url.hostname
        };
    } catch (e) {
        console.error('fetchLinkPreview error:', e);
        return null;
    }
}

export async function onRequestPost(context) {
    const { request } = context;

    let payload;
    try { payload = await request.json(); } catch (e) { return new Response('Invalid JSON', { status: 400 }); }

    const raw = (payload && payload.url) || '';
    const preview = await fetchLinkPreview(raw);
    if (!preview) return json({ ok: false, error: 'no_preview' }, 200);
    return json({ ok: true, preview });
}

function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status, headers: { 'Content-Type': 'application/json' }
    });
}
