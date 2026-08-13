// ============================================================================
// MAC LISTESI  (/api/match-list)
// ============================================================================
// Kullanicinin gorebilecegi Dominion mac kayitlarini dondurur.
//
// GORUNURLUK KURALI:
//   - Kaydi YUKLEYEN gorur          (contributors icinde uid)
//   - Macta OYNAMIS olan gorur      (participants icinde normalize karakter adi)
//   - Admin hepsini gorur
//
// Ikinci madde icin karakter adi ile site hesabi eslestiriliyor. Eslestirme
// buyuk/kucuk harf ve Turkce karakter duyarsiz; caksima olursa sistem durmaz,
// sadece o eslesme kurulmaz.

import { fb, authenticate } from '../_auth.js';

const MAX_RESULTS = 200;

export async function onRequestGet({ request, env }) {
    const auth = await authenticate(request, env);
    if (!auth.ok) return auth.response;

    const isAdmin = auth.role === 'admin';

    // Kullanicinin bagli karakter adlari (normalize) — hangi maclarda oynadigini
    // bulmak icin. Roles/{uid}/playerIds mevcut yapida karakter kimliklerini
    // tutuyor; isim karsiliklarini GuildData/players uzerinden cozuyoruz.
    const myNames = await resolveMyCharacterNames(env, auth.uid);

    let all;
    try {
        const res = await fetch(fb(env, 'Matches'));
        all = await res.json();
    } catch (e) {
        console.error('[match-list] okuma hatasi:', e);
        return json(503, { error: 'Kayitlar okunamadi, biraz sonra tekrar deneyin.' });
    }
    if (!all || typeof all !== 'object') return json(200, { matches: [] });

    const out = [];
    for (const key of Object.keys(all)) {
        const m = all[key];
        if (!m || !m.meta) continue;

        const contributors = m.contributors || {};
        const iContributed = !!contributors[auth.uid];

        let iPlayed = false;
        if (!iContributed && myNames.length && m.participants) {
            for (const n of myNames) {
                if (Object.prototype.hasOwnProperty.call(m.participants, n)) { iPlayed = true; break; }
            }
        }

        if (!isAdmin && !iContributed && !iPlayed) continue;

        // Kayit sahibi: ilk katkida bulunan
        const contribList = Object.keys(contributors);
        const owner = contribList.length ? contributors[contribList[0]] : null;

        // Rakip isimleri. Bu uc zaten member+ istiyor, ziyaretci buraya hic gelmiyor.
        const roster = Array.isArray(m.roster) ? m.roster : [];
        const myTeam = teamOf(roster, myNames);
        const foes = roster.filter(p => p && p.team && p.team !== myTeam).map(p => p.name);

        out.push({
            key,
            serial:       m.meta.serial,
            mapSys:       m.meta.mapSys,
            mapName:      m.meta.mapName,
            startMs:      m.meta.startMs,
            durMs:        m.meta.durMs,
            state:        m.meta.state || 'pending',
            contributors: contribList.length,
            ownerName:    owner ? owner.name : null,
            foes:         foes.slice(0, 24),
            mine:         iContributed,
        });
    }

    out.sort((a, b) => (b.startMs || 0) - (a.startMs || 0));
    return json(200, { matches: out.slice(0, MAX_RESULTS), isAdmin });
}

// ----------------------------------------------------------------------------
async function resolveMyCharacterNames(env, uid) {
    try {
        const [roleRes, playersRes] = await Promise.all([
            fetch(fb(env, `Roles/${uid}`)),
            fetch(fb(env, 'GuildData/players')),
        ]);
        const role = await roleRes.json().catch(() => null);
        const players = await playersRes.json().catch(() => null);
        if (!role) return [];

        const names = [];
        if (role.name) names.push(role.name);

        const ids = role.playerIds;
        if (ids && Array.isArray(players)) {
            const idSet = new Set(Array.isArray(ids) ? ids : Object.keys(ids));
            for (const p of players) {
                if (p && p.id != null && idSet.has(String(p.id)) && p.name) names.push(p.name);
            }
        }
        return names.map(normalizeName).filter(Boolean);
    } catch (e) {
        console.error('[match-list] karakter adi cozulemedi:', e);
        return [];
    }
}

function teamOf(roster, myNames) {
    for (const p of roster) {
        if (p && p.name && myNames.includes(normalizeName(p.name))) return p.team;
    }
    return 1;
}

/**
 * Turkce harfler kucultmeden ONCE cozulmeli:
 * JavaScript'te Turkce yerel ayarda "I".toLowerCase() -> "i" degil "ı" verir.
 */
function normalizeName(s) {
    return String(s || '')
        .replace(/İ/g, 'I').replace(/ı/g, 'i')
        .replace(/Ş/g, 'S').replace(/ş/g, 's')
        .replace(/Ğ/g, 'G').replace(/ğ/g, 'g')
        .replace(/Ü/g, 'U').replace(/ü/g, 'u')
        .replace(/Ö/g, 'O').replace(/ö/g, 'o')
        .replace(/Ç/g, 'C').replace(/ç/g, 'c')
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]/g, '');
}

function json(status, obj) {
    return new Response(JSON.stringify(obj), {
        status, headers: { 'Content-Type': 'application/json' },
    });
}
