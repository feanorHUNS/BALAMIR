// ============================================================================
// TAKTIK HARITALARI  (/api/tactics-map)
// ============================================================================
// NEDEN BU UC VAR: Haritalar 'TacticsMaps' Firebase yolunda tutulur. Istemcinin
// dogrudan Firebase yazmasi, kurallarin yayinlanmis ve istemci oturumunun
// dogru olmasina bagliydi — "sadece kendi tarayicimda gorunuyor" sorununun
// sebebi buydu: yazma sessizce reddediliyor, Firebase SDK'si ise iyimser
// onbellekle haritayi O TARAYICIDA gosteriyordu. Artik yazma VE okuma bu uc
// uzerinden, sunucunun veritabani anahtariyla yapilir; kurallardan bagimsiz
// her zaman calisir.
//   POST { action: 'list' }                                  (uye ve ustu)
//   POST { action: 'save', id?, name, desc, mode, img }      (yalnizca admin)
//   POST { action: 'delete', id }                            (yalnizca admin)

import { fb } from '../_auth.js';

export async function onRequestPost(context) {
    const { request, env, auth } = context;

    let payload;
    try { payload = await request.json(); } catch (e) { return json({ error: 'Invalid JSON' }, 400); }

    const action = String(payload.action || 'save');

    // --- listele: uye ve ustu herkes ---
    if (action === 'list') {
        try {
            const res = await fetch(fb(env, 'TacticsMaps'));
            const data = res.ok ? await res.json() : null;
            return json({ maps: data || {} });
        } catch (e) {
            console.error('[tactics-map] okuma hatasi:', e);
            return json({ error: 'Haritalar okunamadi.' }, 500);
        }
    }

    // Yazma islemleri YALNIZCA ADMIN. (Rota minRole 'member' — liste icin;
    // yazma yetkisi burada ayrica zorlanir.)
    if (auth.role !== 'admin') {
        return json({ error: 'Haritalari yalnizca admin yonetebilir.' }, 403);
    }

    if (action === 'delete') {
        const id = String(payload.id || '');
        if (!/^map_\d+$/.test(id)) return json({ error: 'Gecersiz harita kimligi.' }, 400);
        // DELETE gorsel dahil TUM kaydi kaldirir — geride hicbir sey kalmaz.
        const res = await fetch(fb(env, `TacticsMaps/${id}`), { method: 'DELETE' });
        if (!res.ok) return json({ error: 'Silinemedi.' }, 502);
        return json({ ok: true });
    }

    // --- kaydet / guncelle ---
    const name = String(payload.name || '').trim().slice(0, 60);
    const desc = String(payload.desc || '').trim().slice(0, 500);
    const mode = parseInt(payload.mode, 10) === 12 ? 12 : 6;
    const img  = String(payload.img || '');
    const id   = /^map_\d+$/.test(String(payload.id || '')) ? String(payload.id) : ('map_' + Date.now());

    if (!name) return json({ error: 'Harita adi zorunlu.' }, 400);
    // Gomulu gorsel (data URI) ya da http linki kabul edilir; ~1.2MB tavan.
    if (!/^(data:image\/(webp|png|jpeg);base64,|https?:\/\/)/i.test(img)) {
        return json({ error: 'Gecersiz gorsel.' }, 400);
    }
    if (img.length > 1400000) return json({ error: 'Gorsel cok buyuk.' }, 413);

    const createdAt = parseInt(payload.createdAt, 10) || Date.now();
    const rec = { name, desc, mode, img, createdAt };

    // PUT dugumu TAMAMEN degistirir — eski gorselden geriye bir sey kalmaz.
    const res = await fetch(fb(env, `TacticsMaps/${id}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rec)
    });
    if (!res.ok) {
        console.error('[tactics-map] yazma hatasi:', res.status);
        return json({ error: 'Kaydedilemedi.' }, 502);
    }
    return json({ ok: true, id, map: rec });
}

function json(obj, status = 200) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}
