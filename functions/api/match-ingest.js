// ============================================================================
// DOMINION MAC KAYDI ALIMI  (/api/match-ingest)
// ============================================================================
// Kullanici, oyunun yazdigi  data/Mods/Configs/HUNSRecorder/user.cfg  dosyasini
// siteye surukler. Bu uc dosyayi OKUYARAK alir -- oldugu gibi ice aktarmaz.
//
// GUVENLIK KATMANLARI (guclu -> zayif):
//   1. Makullük  — fizik kurallari. Oyuncu 12 m/s'den hizli hareket edemez,
//                  10 dakikada 500.000 hasar olayi olamaz. ASIL SAVUNMA.
//   2. Capraz dogrulama — ayni maci 2+ kisi yuklediginde matchMaking'den gelen
//                  otoriter alanlar (kadro, seri) birebir ayni olmak zorunda.
//   3. Butunluk etiketi — dosya elle degistirilmis mi.
//   4. Bicim  — satir tipi, alan sayisi, aralik.
//
// DURUST NOT: gizleme anahtari addon icinde ve bytecode'dan cikarilabilir.
// Yani 3. katman siradan kurcalamayi engeller, kararli birini engellemez.
// Bu yuzden 1 ve 2 asil koruma olarak tasarlandi.
//
// Istemci tarafi ayristirma SADECE onizleme icindir; burada dosya sifirdan
// yeniden ayristirilir ve yalnizca bu sonuc veritabanina yazilir.

import { fb, authenticate, checkRateLimit } from '../_auth.js';
import { parseConfigFile } from '../_hunsParser.js';

// Ayni maci ayni sayan zaman penceresi. Roster anahtari zaten zamansiz;
// tarih yalnizca ayni takimlarin farkli zamanlardaki maclarini ayirir.
const MATCH_WINDOW_MS = 15 * 60 * 1000;

const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

export async function onRequestPost({ request, env }) {
    // ---- kimlik ----------------------------------------------------------
    const auth = await authenticate(request, env);
    if (!auth.ok) return auth.response;

    // ---- hiz siniri ------------------------------------------------------
    const rl = await checkRateLimit(env, auth.uid, 'match-ingest', 20, 60 * 60 * 1000);
    if (rl && rl.ok === false) return rl.response;

    // ---- govde -----------------------------------------------------------
    let text;
    try {
        const body = await request.json();
        text = body && body.file;
    } catch (e) {
        return json(400, { error: 'Istek govdesi okunamadi.' });
    }
    if (typeof text !== 'string' || !text.length) {
        return json(400, { error: 'Dosya icerigi bos.' });
    }
    if (text.length > MAX_UPLOAD_BYTES) {
        return json(413, { error: 'Dosya cok buyuk (en fazla 4 MB).' });
    }

    // ---- ayristir --------------------------------------------------------
    let parsed;
    try {
        parsed = parseConfigFile(text);
    } catch (e) {
        return json(400, {
            error: 'Dosya okunamadi.',
            code: e.code || 'E-FORMAT',
            detail: e.detail || String(e.message || e),
        });
    }

    if (!parsed.slots.length) {
        return json(400, {
            error: 'Dosyada mac kaydi bulunamadi.',
            hint: 'Once oyunda bir Dominion maci oynayin ya da /huns simulate 15 calistirin.',
        });
    }

    // ---- sahip kodu ------------------------------------------------------
    // Kod, indirme izni verilirken kisiye atanir ve pakete gomulu gelir.
    // Kod ile oturum sahibi uyusmuyorsa yukleme reddedilir.
    if (parsed.owner) {
        const codeRes = await fetch(fb(env, `AddonCodes/${encodeURIComponent(parsed.owner)}`));
        const codeRec = await codeRes.json().catch(() => null);
        if (!codeRec || !codeRec.uid) {
            return json(403, { error: 'Addon kodu taninmiyor.', code: 'E-CODE' });
        }
        if (codeRec.revoked) {
            return json(403, { error: 'Bu addon kodu iptal edilmis.', code: 'E-CODE' });
        }
        if (codeRec.uid !== auth.uid) {
            return json(403, {
                error: 'Bu kayit baska bir hesaba ait bir addon kodu tasiyor.',
                code: 'E-CODE',
            });
        }
    }

    // ---- her slotu isle --------------------------------------------------
    const results = [];
    for (const slot of parsed.slots) {
        try {
            results.push(await ingestOne(env, auth, slot, parsed.owner));
        } catch (e) {
            console.error('[match-ingest] slot', slot.slot, e);
            results.push({
                slot: slot.slot,
                status: 'error',
                issues: [String((e && e.message) || e)],
            });
        }
    }

    return json(200, { ok: true, results });
}

// ----------------------------------------------------------------------------
async function ingestOne(env, auth, slot, ownerCode) {
    if (!slot.ok || !slot.match) {
        return {
            slot: slot.slot,
            status: 'rejected',
            code: slot.issues[0] || 'E-SANITY',
            issues: slot.issues,
        };
    }

    const m = slot.match;
    const rosterKey = m.serial.split('-')[1];

    // ---- ayni mac zaten var mi -------------------------------------------
    // Roster anahtari + 15 dakikalik pencere.
    const idxRes = await fetch(fb(env, `MatchIndex/${rosterKey}`));
    const idx = (await idxRes.json().catch(() => null)) || {};

    let matchKey = null;
    for (const key of Object.keys(idx)) {
        const entry = idx[key];
        if (!entry || typeof entry.startMs !== 'number') continue;
        if (Math.abs(entry.startMs - m.startMs) <= MATCH_WINDOW_MS) { matchKey = key; break; }
    }

    const isNew = !matchKey;
    if (isNew) matchKey = m.serial;

    // ---- capraz dogrulama -------------------------------------------------
    // Kadro ve harita sunucudan (matchMaking) geliyor: her istemcide birebir
    // ayni olmali. Uyusmuyorsa biri veriyi degistirmis demektir.
    if (!isNew) {
        const metaRes = await fetch(fb(env, `Matches/${matchKey}/meta`));
        const meta = await metaRes.json().catch(() => null);
        if (meta) {
            const mine = m.players.map(p => p.name).sort().join(',');
            if (meta.rosterNames && meta.rosterNames !== mine) {
                return {
                    slot: slot.slot,
                    status: 'quarantined',
                    code: 'E-CONFLICT',
                    issues: ['Ayni macin baska kaydiyla kadro uyusmuyor.'],
                };
            }
            if (meta.mapSys && meta.mapSys !== m.mapSys) {
                return {
                    slot: slot.slot,
                    status: 'quarantined',
                    code: 'E-CONFLICT',
                    issues: ['Ayni macin baska kaydiyla harita uyusmuyor.'],
                };
            }
        }
    }

    // ---- ayni kisi ayni maci tekrar yukluyor mu ---------------------------
    const existRes = await fetch(fb(env, `Matches/${matchKey}/contributors/${auth.uid}`));
    const exist = await existRes.json().catch(() => null);
    const isReupload = !!exist;

    // ---- yaz --------------------------------------------------------------
    const now = Date.now();

    if (isNew) {
        await put(env, `Matches/${matchKey}/meta`, {
            serial: m.serial,
            rosterKey,
            mapSys: m.mapSys,
            mapName: m.mapName,
            startMs: m.startMs,
            durMs: m.durMs,
            rosterNames: m.players.map(p => p.name).sort().join(','),
            createdAt: now,
            state: 'pending',
        });
        await put(env, `Matches/${matchKey}/roster`, m.players);
        await put(env, `MatchIndex/${rosterKey}/${matchKey}`, {
            startMs: m.startMs, mapSys: m.mapSys,
        });
    }

    // Ham kayit katkida bulunan basina ayri tutuluyor.
    //
    // ONEMLI: acilmis nesne agacini DEGIL, paketli stringi sakliyoruz.
    // 177 KB'lik paket acildiginda 2723 hasar + 599 sifa + 451 konum satiri
    // birkac MB'lik JSON'a donusuyor; Firebase REST'e o boyutta PUT hem yavas
    // hem de Worker CPU butcesini zorluyor. Birlestirme asamasi paketi zaten
    // sunucuda yeniden acacak.
    await put(env, `Matches/${matchKey}/raw/${auth.uid}`, {
        uploadedAt: now,
        ownerCode: ownerCode || null,
        clock: m.clock,
        packed: slot.packed,
        counts: {
            damage: m.damage.length,
            heal: m.heal.length,
            deaths: m.deaths.length,
            points: m.points.length,
            positions: m.positions.length,
            distances: m.distances.length,
        },
    });

    await put(env, `Matches/${matchKey}/contributors/${auth.uid}`, {
        name: auth.name,
        character: null,       // isim eslesmesi birlestirme asamasinda kurulur
        uploadedAt: now,
        slot: slot.slot,
    });

    // Katilimcilarin site hesabi var mi: normalize isimle eslestir.
    const participants = {};
    for (const p of m.players) participants[normalizeName(p.name)] = p.team;
    await put(env, `Matches/${matchKey}/participants`, participants);

    return {
        slot: slot.slot,
        status: isReupload ? 'updated' : (isNew ? 'created' : 'merged'),
        matchKey,
        serial: m.serial,
        mapName: m.mapName,
        players: m.players.length,
        events: m.damage.length + m.heal.length,
        distanceSamples: m.distances.length,
    };
}

// ----------------------------------------------------------------------------
/**
 * Isim normalizasyonu.
 * Turkce harfler kucultmeden ONCE cozulmeli: JavaScript'te Turkce yerel
 * ayarda "I".toLowerCase() -> "i" degil "ı" verir.
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

async function put(env, path, value) {
    const res = await fetch(fb(env, path), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Firebase yazma hatasi ${res.status} @ ${path} ${body.slice(0, 200)}`);
    }
}

function json(status, obj) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}
