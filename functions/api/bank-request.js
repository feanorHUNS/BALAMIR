// ============================================================================
// BANKA ISTEGI  (/api/bank-request)
// ============================================================================
// SORUN: /api/guild-write 'officer' yetkisi istiyor (guild verisinin tamamini
// yazabildigi icin dogru bir kisit). Ama UYELERIN de banka istegi gonderebilmesi
// gerekiyor. Uyelere guild-write acmak, tum verinin yazilmasina izin vermek olurdu.
//
// COZUM: Bu uc yalnizca `guildBank/requests` listesine EKLEME yapar.
// Baska hicbir alana dokunmaz. Boylece uye istek gonderebilir ama depoyu,
// altini ya da baska bir bolumu degistiremez.

import { fb } from '../_auth.js';

const MAX_REQUESTS = 300;

export async function onRequestPost(context) {
    const { request, env, auth } = context;

    let payload;
    try { payload = await request.json(); } catch (e) { return json({ error: 'Invalid JSON' }, 400); }

    const itemName = String((payload && payload.itemName) || '').trim().slice(0, 80);
    // Oyun ici karakter adi -- ZORUNLU. Site adi istemciden ALINMAZ,
    // asagida dogrulanmis kimlikten yazilir (degistirilemez).
    const gameNick = String((payload && payload.gameNick) || '').trim().slice(0, 40);
    const reason   = String((payload && payload.reason) || '').trim().slice(0, 500);
    const qty      = parseInt(payload && payload.qty, 10);
    const slotId   = parseInt(payload && payload.slotId, 10);

    if (!itemName) return json({ error: 'itemName zorunludur.' }, 400);
    if (!gameNick) return json({ error: 'gameNick zorunludur.' }, 400);
    if (gameNick.length < 2) return json({ error: 'gameNick cok kisa.' }, 400);
    if (!qty || qty < 1 || qty > 100000) return json({ error: 'qty gecersiz.' }, 400);

    try {
        // Mevcut istekleri oku (yalnizca bu alt yol).
        const res = await fetch(fb(env, `GuildData/guildBank/requests`));
        const current = (await res.json()) || [];
        const list = Array.isArray(current) ? current : Object.values(current);

        // Ayni kisi ayni esya icin BEKLEYEN bir istek birakmissa tekrar acmasin.
        const dup = list.find(r => r && r.status === 'pending' &&
            r.itemName === itemName && String(r.by) === String(auth.name || auth.uid));
        if (dup) return json({ error: 'already_pending' }, 409);

        // HAFTALIK ONAYLI ISTEK LIMITI (admin ayarlar, 0 = sinirsiz).
        // Son 7 gunde bu kisinin ONAYLANMIS istek sayisi limite ulastiysa
        // yeni istek ACILMASINA da izin verilmez — kuyruk bosuna sismesin.
        try {
            const limRes = await fetch(fb(env, `GuildData/guildBank/requestLimit`));
            const limit = parseInt(await limRes.json(), 10) || 0;
            if (limit > 0) {
                const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
                const me = String(auth.name || auth.uid);
                const approvedThisWeek = list.filter(r => r && r.status === 'approved' &&
                    String(r.by) === me && (r.decidedAt || r.at || 0) >= weekAgo).length;
                if (approvedThisWeek >= limit) {
                    return json({ error: 'weekly_limit', limit }, 429);
                }
            }
        } catch (e) { console.error('[bank-request] limit kontrolu yapilamadi:', e); }

        const entry = {
            id: 'req_' + Date.now(),
            slotId: isNaN(slotId) ? null : slotId,
            itemName, qty, gameNick, reason,
            // KRITIK: SITE ADI istemciden DEGIL, dogrulanmis kimlikten yaziliyor.
            // Boylece kimse baskasinin adina istek acamaz ve kullanici bu alani
            // degistiremez.
            siteName: auth.name || auth.uid,
            by: auth.name || auth.uid,
            byRole: auth.role,
            at: Date.now(),
            status: 'pending'
        };

        const updated = [entry].concat(list).slice(0, MAX_REQUESTS);

        const put = await fetch(fb(env, `GuildData/guildBank/requests`), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updated)
        });
        if (!put.ok) {
            const txt = await put.text();
            console.error('[bank-request] yazilamadi:', put.status, txt);
            return json({ error: 'Istek kaydedilemedi.' }, 502);
        }

        console.log(`[bank-request] ${auth.role} ${auth.name}: ${itemName} x${qty}`);
        return json({ success: true, request: entry });
    } catch (e) {
        console.error('[bank-request] hata:', e);
        return json({ error: 'Sunucu hatasi: ' + e.message }, 500);
    }
}

function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status, headers: { 'Content-Type': 'application/json' }
    });
}
