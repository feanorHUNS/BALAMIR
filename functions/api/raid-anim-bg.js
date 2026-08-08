// ============================================================================
// HAREKETLI RAID GORSELI — ARKA PLAN  (/api/raid-anim-bg)
// ============================================================================
//   POST { action: 'get' }            -> mevcut gorseli dondurur (uye ve ustu)
//   POST { action: 'set', img }       -> gorseli DEGISTIRIR (yalnizca admin)
//   POST { action: 'clear' }          -> gorseli siler (yalnizca admin)
//
// SAKLAMA MANTIGI: Gorsel TEK bir Firebase dugumunde (RaidAnimBg) tutulur ve
// PUT ile yazilir. PUT dugumun tamamini degistirdigi icin eski gorselden geriye
// HICBIR SEY kalmaz — birikip yer kaplamaz. Silme de dugumu tamamen kaldirir.

import { fb } from '../_auth.js';

export async function onRequestPost(context) {
    const { request, env, auth } = context;

    let payload;
    try { payload = await request.json(); } catch (e) { return json({ error: 'Invalid JSON' }, 400); }
    const action = String(payload.action || 'get');

    if (action === 'get') {
        try {
            const res = await fetch(fb(env, 'RaidAnimBg/img'));
            const img = res.ok ? await res.json() : null;
            return json({ img: img || '' });
        } catch (e) {
            console.error('[raid-anim-bg] okuma hatasi:', e);
            return json({ error: 'Okunamadi.' }, 500);
        }
    }

    if (auth.role !== 'admin') return json({ error: 'Yalnizca admin degistirebilir.' }, 403);

    if (action === 'clear') {
        const res = await fetch(fb(env, 'RaidAnimBg'), { method: 'DELETE' });
        if (!res.ok) return json({ error: 'Silinemedi.' }, 502);
        return json({ ok: true, img: '' });
    }

    if (action === 'set') {
        const img = String(payload.img || '');
        if (!/^data:image\/(webp|png|jpeg);base64,/.test(img)) {
            return json({ error: 'Gecersiz gorsel bicimi.' }, 400);
        }
        if (img.length > 1400000) return json({ error: 'Gorsel cok buyuk.' }, 413);

        // PUT: dugumu TAMAMEN degistirir -> eski gorsel silinir.
        const res = await fetch(fb(env, 'RaidAnimBg'), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ img, at: Date.now() })
        });
        if (!res.ok) {
            console.error('[raid-anim-bg] yazma hatasi:', res.status);
            return json({ error: 'Kaydedilemedi.' }, 502);
        }
        return json({ ok: true });
    }

    return json({ error: 'Bilinmeyen islem.' }, 400);
}

function json(obj, status = 200) {
    return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
