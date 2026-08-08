// ============================================================================
// OBS ROTASYON YARDIMCILARI  (cron + test ucu ortak kullanir)
// ============================================================================
// Rotasyon 5'li bir dongu: her PERSEMBE 05:00 (TR) sonrakine gecer.
// BASLANGIC: 13 Agustos 2026 Persembe 05:00 TR = 02:00 UTC -> 1. rotasyon.
//
// HIZ: GIF'ler sitede BIR KEZ hazirlanip Discord'a yuklenir; burada yalnizca
// hazir baglanti + o haftanin TARIHI gonderilir. Bu yuzden haftalik paylasim
// aninda tamamlanir, kodlama beklemesi yoktur.

export const OBS_ANCHOR_UTC = Date.UTC(2026, 7, 13, 2, 0, 0);
export const OBS_WEEK_MS = 7 * 24 * 3600 * 1000;
export const OBS_COUNT = 5;

/** Verilen ana denk gelen rotasyon numarasi (1..5). */
export function obsRotationAt(tms) {
    const weeks = Math.floor((tms - OBS_ANCHOR_UTC) / OBS_WEEK_MS);
    return ((weeks % OBS_COUNT) + OBS_COUNT) % OBS_COUNT + 1;
}

/** O haftanin persembe 05:00 TR anini dondurur (verilen andan onceki/esit). */
export function obsCurrentSlot(tms) {
    const weeks = Math.floor((tms - OBS_ANCHOR_UTC) / OBS_WEEK_MS);
    return OBS_ANCHOR_UTC + weeks * OBS_WEEK_MS;
}

/** Tarihi TR ve AVRUPA olarak bicimlendirir (saat yok, istek uzerine). */
function formatDates(tms) {
    const d = new Date(tms);
    const f = (tz) => new Intl.DateTimeFormat('tr-TR', {
        timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric'
    }).format(d);
    try {
        return { tr: f('Europe/Istanbul'), eu: f('Europe/Berlin') };
    } catch (e) {
        const p = (n) => String(n).padStart(2, '0');
        const s = new Date(tms + 3 * 3600000);
        const t = `${p(s.getUTCDate())}.${p(s.getUTCMonth() + 1)}.${s.getUTCFullYear()}`;
        return { tr: t, eu: t };
    }
}

/**
 * Rotasyonu kanala gonderir.
 * cfg: { enabled, channelId, gifs:{1..5}, cryEn, cryTr }
 */
export async function postObsRotation(env, cfg, rot, tms, isTest) {
    if (!cfg || !cfg.channelId) return { ok: false, error: 'Kanal secilmemis.' };
    // Anahtar "r1".."r5"; eski kayitlar icin sayisal anahtar ve dizi bicimi de
    // destekleniyor.
    const g = cfg.gifs || {};
    const url = g['r' + rot] || g[rot] || (Array.isArray(g) ? g[rot] : null);
    if (!url) return { ok: false, error: `Rotasyon ${rot} icin gorsel hazirlanmamis.` };

    const dates = formatDates(tms);
    const body = {
        embeds: [{
            title: `🗡️ Weekly OBS Rotation · Haftanın OBS Rotasyonu`,
            description:
                `**Rotation ${rot} / ${OBS_COUNT}**\n` +
                `🇹🇷 ${dates.tr}   ·   🇪🇺 ${dates.eu}\n\n` +
                `${cfg.cryEn || 'TO ARMS, HUNS!'}\n${cfg.cryTr || 'SİLAH BAŞINA HUNS!'}`,
            color: 0xf59e0b,
            image: { url: String(url) },
            footer: { text: isTest ? 'HUNS · test' : 'HUNS' }
        }]
    };

    const res = await fetch(`https://discord.com/api/v10/channels/${cfg.channelId}/messages`, {
        method: 'POST',
        headers: { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    if (!res.ok) {
        const txt = await res.text();
        console.error('[obs] gonderilemedi:', res.status, txt);
        return { ok: false, error: `Discord reddetti (${res.status}).` };
    }
    return { ok: true };
}
