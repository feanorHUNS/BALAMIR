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
        // Banka verisini TEK istekle oku: istekler + limitler birlikte.
        const res = await fetch(fb(env, `GuildData/guildBank`));
        const bank = (await res.json()) || {};
        const rawReq = bank.requests || [];
        const list = Array.isArray(rawReq) ? rawReq : Object.values(rawReq);

        // Ayni kisi ayni esya icin BEKLEYEN bir istek birakmissa tekrar acmasin.
        const dup = list.find(r => r && r.status === 'pending' &&
            r.itemName === itemName && String(r.byUid || r.by) === String(auth.uid));
        if (dup) return json({ error: 'already_pending' }, 409);

        // HAFTALIK ONAYLI ISTEK LIMITI (yetkililer ayarlar, 0 = sinirsiz).
        // Kisiye OZEL limit varsa o gecerli, yoksa genel limit. Limit dolan uye,
        // limit yukseltilene dek yeni istek ACAMAZ.
        try {
            // KIMLIK UID ILE: Onceden goruntulenen ISIM kullaniliyordu. Kullanici kendi
            // adini degistirebildigi icin baskasinin adini alip limit sayimini
            // karistirabiliyordu. UID degistirilemez.
            const me = String(auth.uid);
            const globalLimit = parseInt(bank.requestLimit, 10) || 0;
            const rawLims = bank.requestLimits || [];
            const limList = Array.isArray(rawLims) ? rawLims : Object.values(rawLims);
            const ov = limList.find(x => x && String(x.name) === me);
            const limit = ov ? (Math.max(0, parseInt(ov.limit, 10) || 0)) : globalLimit;
            // Donem: 7 = hafta, 14 = iki hafta, 30 = ay (admin secer).
            const days = [7, 14, 30].includes(parseInt(bank.requestLimitDays, 10))
                ? parseInt(bank.requestLimitDays, 10) : 7;
            if (limit > 0) {
                const since = Date.now() - days * 24 * 3600 * 1000;
                const approvedInPeriod = list.filter(r => r && r.status === 'approved' &&
                    String(r.byUid || r.by) === me && (r.decidedAt || r.at || 0) >= since).length;
                if (approvedInPeriod >= limit) {
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
            byUid: auth.uid,        // kimlik: degistirilemez UID (isim yalnizca gosterim)
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
