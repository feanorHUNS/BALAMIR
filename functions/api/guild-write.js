// ============================================================================
// SUNUCU DOGRULAMALI YAZMA  (/api/guild-write)   — Madde 111
// ============================================================================
// ONCEDEN: Istemci Firebase'e DOGRUDAN yaziyordu. Bu iki sorun yaratiyordu:
//   1) Veri sekli hic dogrulanmiyordu -- bozuk/eksik bir kayit gonderilebilirdi
//      (orn. dkp: "abc", players: null, 5000 elemanlik bir dizi).
//   2) Yazma yetkisi Firebase kurallarina birakilmisti; kurallar ifade gucu
//      sinirli oldugu icin "DKP en fazla su kadar degisebilir" gibi is
//      kurallari yazilamiyordu.
//
// ARTIK: Tum GuildData yazmalari bu uctan geciyor. Uc, her bolumun seklini
// dogruluyor, sinirlari uyguluyor ve ancak ondan sonra Firebase'e yaziyor.
// Firebase kurallarinda GuildData yazma tamamen KAPALI; yalnizca sunucu
// (veritabani sirri ile) yazabiliyor.

import { fb } from '../_auth.js';

// Yazilabilir bolumler ve her birinin dogrulama kurali.
// Listede OLMAYAN bir bolum adi gonderilirse istek reddedilir.
const SECTIONS = {
    players:                { type: 'array',  max: 2000, validate: validatePlayers },
    raidPlans:              { type: 'array',  max: 200,  validate: validateRaidPlans },
    history:                { type: 'array',  max: 500 },
    penaltyHistory:         { type: 'array',  max: 500 },
    rolls:                  { type: 'array',  max: 500 },
    auditLogs:              { type: 'array',  max: 200 },
    discordChannels:        { type: 'array',  max: 50 },
    discordLinks:           { type: 'object', max: 2000 },
    siteTitles:             { type: 'object', max: 200 },
    discordNotify:          { type: 'object', max: 50 },
    rsvpReminder:           { type: 'object', max: 50 },
    applicationQuestions:   { type: 'array',  max: 40 },
    announcementHtml:       { type: 'string', max: 200000 },
    planQuote:              { type: 'string', max: 500 },
    discordMotivationalMsg: { type: 'string', max: 500 },
    discordWebhookUrl:      { type: 'string', max: 500 },
    exportBgUrl:            { type: 'string', max: 1000 },
    exportBgOpacity:        { type: 'number', min: 0, max: 100 },
    activeTheme:            { type: 'number', min: 0, max: 200 },
    adminMessages:          { type: 'array',  max: 200 },
    guildBank:              { type: 'object', max: 10, validate: validateBank }
};

// Tek bir istekte yazilabilecek en fazla bolum sayisi.
const MAX_SECTIONS_PER_REQUEST = 25;

function validateBank(_unused, value) {
    // Bu bolum nesne oldugu icin dogrulama checkSection tarafindan ayrica cagriliyor.
    return null;
}

function validatePlayers(arr) {
    for (const p of arr) {
        if (!p || typeof p !== 'object') return 'players: gecersiz kayit';
        if (typeof p.name !== 'string' || p.name.length < 1 || p.name.length > 40) {
            return 'players: isim 1-40 karakter olmali';
        }
        if (p.dkp !== undefined && (typeof p.dkp !== 'number' || !isFinite(p.dkp))) {
            return 'players: dkp sayi olmali';
        }
        if (p.items !== undefined && (!Array.isArray(p.items) || p.items.length > 500)) {
            return 'players: esya listesi gecersiz';
        }
    }
    return null;
}

function validateRaidPlans(arr) {
    for (const pl of arr) {
        if (!pl || typeof pl !== 'object') return 'raidPlans: gecersiz kayit';
        if (pl.characters !== undefined) {
            if (!Array.isArray(pl.characters) || pl.characters.length > 48) {
                return 'raidPlans: kadro gecersiz';
            }
        }
        if (pl.title !== undefined && typeof pl.title === 'string' && pl.title.length > 120) {
            return 'raidPlans: baslik cok uzun';
        }
    }
    return null;
}

/** Bir bolumun seklini ve sinirlarini dogrular. Sorun varsa hata metni doner. */
function checkSection(name, value) {
    const spec = SECTIONS[name];
    if (!spec) return `bilinmeyen bolum: ${name}`;

    // null = "bu bolumu sil" anlamina gelir, izinli.
    if (value === null) return null;

    if (spec.type === 'array') {
        if (!Array.isArray(value)) return `${name}: dizi olmali`;
        if (value.length > spec.max) return `${name}: en fazla ${spec.max} kayit`;
    } else if (spec.type === 'object') {
        if (typeof value !== 'object' || Array.isArray(value)) return `${name}: nesne olmali`;
        if (Object.keys(value).length > spec.max) return `${name}: en fazla ${spec.max} anahtar`;
    } else if (spec.type === 'string') {
        if (typeof value !== 'string') return `${name}: metin olmali`;
        if (value.length > spec.max) return `${name}: en fazla ${spec.max} karakter`;
    } else if (spec.type === 'number') {
        if (typeof value !== 'number' || !isFinite(value)) return `${name}: sayi olmali`;
        if (value < spec.min || value > spec.max) return `${name}: ${spec.min}-${spec.max} arasinda olmali`;
    }

    if (spec.validate) {
        const err = spec.validate(Array.isArray(value) ? value : [], value);
        if (err) return err;
    }

    // Guild bankasi: altin sayi olmali, esya/kayit listeleri sinirli.
    if (name === 'guildBank' && value) {
        if (value.gold !== undefined && (typeof value.gold !== 'number' || !isFinite(value.gold))) {
            return 'guildBank: altin sayi olmali';
        }
        // Canta slotlari: sabit sayida, bos slotlar null.
        // Firebase seyrek dizileri NESNEYE cevirebildigi icin her iki bicim de kabul edilir.
        if (value.slots !== undefined && value.slots !== null) {
            const slotArr = Array.isArray(value.slots)
                ? value.slots
                : (typeof value.slots === 'object' ? Object.values(value.slots) : null);
            if (!slotArr || slotArr.length > 100) return 'guildBank: slot listesi gecersiz';
            for (const it of slotArr) {
                if (it === null || it === undefined) continue;
                if (typeof it !== 'object') return 'guildBank: slot gecersiz';
                if (typeof it.name !== 'string' || !it.name.length || it.name.length > 80) return 'guildBank: esya adi gecersiz';
                if (typeof it.qty !== 'number' || it.qty < 0 || it.qty > 1000000) return 'guildBank: adet gecersiz';
                if (it.img && (typeof it.img !== 'string' || !/^https?:\/\//i.test(it.img) || it.img.length > 600)) {
                    return 'guildBank: gorsel adresi gecersiz';
                }
                if (it.desc && String(it.desc).length > 400) return 'guildBank: aciklama cok uzun';
                if (it.note && String(it.note).length > 400) return 'guildBank: not cok uzun';
            }
        }
        // Istekler
        if (value.requests !== undefined && value.requests !== null) {
            const reqArr = Array.isArray(value.requests)
                ? value.requests
                : (typeof value.requests === 'object' ? Object.values(value.requests) : null);
            if (!reqArr || reqArr.length > 300) return 'guildBank: istek listesi gecersiz';
            for (const r of reqArr) {
                if (!r || typeof r !== 'object') return 'guildBank: istek gecersiz';
                if (typeof r.qty !== 'number' || r.qty < 1) return 'guildBank: istek adedi gecersiz';
                if (r.status && ['pending','approved','rejected'].indexOf(r.status) === -1) {
                    return 'guildBank: istek durumu gecersiz';
                }
                if (r.reason && String(r.reason).length > 500) return 'guildBank: istek gerekcesi cok uzun';
            }
        }
        if (value.log !== undefined && value.log !== null) {
            const logArr = Array.isArray(value.log)
                ? value.log
                : (typeof value.log === 'object' ? Object.values(value.log) : null);
            if (!logArr || logArr.length > 200) return 'guildBank: kayit listesi gecersiz';
        }
    }
    return null;
}

export async function onRequestPost(context) {
    const { request, env, auth } = context;

    let payload;
    try { payload = await request.json(); } catch (e) { return json({ error: 'Invalid JSON' }, 400); }

    const sections = payload && payload.sections;
    if (!sections || typeof sections !== 'object' || Array.isArray(sections)) {
        return json({ error: 'sections nesnesi zorunludur.' }, 400);
    }

    const names = Object.keys(sections);
    if (names.length === 0) return json({ error: 'Yazilacak bolum yok.' }, 400);
    if (names.length > MAX_SECTIONS_PER_REQUEST) {
        return json({ error: `Tek istekte en fazla ${MAX_SECTIONS_PER_REQUEST} bolum.` }, 400);
    }

    // --- Dogrulama: BIRI bile gecersizse HICBIRI yazilmaz -----------------
    for (const name of names) {
        const err = checkSection(name, sections[name]);
        if (err) {
            console.error(`[guild-write] ${auth.uid} reddedildi: ${err}`);
            return json({ error: 'Veri dogrulamasi basarisiz: ' + err }, 400);
        }
    }

    // --- Yazma: coklu-yol guncelleme (atomik) -----------------------------
    try {
        const res = await fetch(fb(env, `GuildData`), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(sections)
        });

        if (!res.ok) {
            const txt = await res.text();
            console.error('[guild-write] Firebase hatasi:', res.status, txt);
            return json({ error: 'Kaydedilemedi: ' + txt }, 502);
        }

        console.log(`[guild-write] ${auth.role} ${auth.name}: ${names.join(', ')}`);
        return json({ success: true, written: names });
    } catch (e) {
        console.error('[guild-write] hata:', e);
        return json({ error: 'Sunucu hatasi: ' + e.message }, 500);
    }
}

function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status, headers: { 'Content-Type': 'application/json' }
    });
}
