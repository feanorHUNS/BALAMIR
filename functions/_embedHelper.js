// Bu dosya bağımsız bir endpoint DEĞİLDİR — /functions altında "_" ile başladığı için
// Cloudflare Pages tarafından route olarak algılanmaz, sadece diğer fonksiyonların
// import ettiği paylaşılan bir yardımcı modüldür (Discord embed'ini oluşturur).

export function buildAnnouncementEmbed(ann) {
    const acceptedNames = Object.values(ann.accepted || {});
    const declinedNames = Object.values(ann.declined || {});
    const tentativeNames = Object.values(ann.tentative || {});
    const unixTime = ann.time ? Math.floor(new Date(ann.time).getTime() / 1000) : null;

    // Türkiye saati sabit UTC+3 (yaz saati yok); Avrupa (CET/CEST) saati Intl ile otomatik
    // yaz/kış saatine göre hesaplanıyor. İkisi de dinamik Discord zaman etiketinin yanında metin olarak gösteriliyor.
    let timeFieldValue = null;
    if (unixTime) {
        const trTimeStr = new Date(ann.time).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
        const euTimeStr = new Date(ann.time).toLocaleString('en-GB', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
        timeFieldValue = `<t:${unixTime}:F>\n<t:${unixTime}:R>\n🇹🇷 ${trTimeStr} (TRT)\n🇪🇺 ${euTimeStr} (CET/CEST)`;
    }

    return {
        title: ann.title || 'Etkinlik',
        description: ann.content || '',
        color: 3447003,
        fields: [
            ...(timeFieldValue ? [{ name: '🗓️ Time', value: timeFieldValue, inline: false }] : []),
            { name: `✅ Accepted (${acceptedNames.length})`, value: acceptedNames.length ? acceptedNames.join('\n') : '—', inline: true },
            { name: `❌ Declined (${declinedNames.length})`, value: declinedNames.length ? declinedNames.join('\n') : '—', inline: true },
            { name: `❓ Tentative (${tentativeNames.length})`, value: tentativeNames.length ? tentativeNames.join('\n') : '—', inline: true }
        ],
        footer: { text: `Created by ${ann.authorName || 'Guild Portal'}` },
        timestamp: new Date().toISOString()
    };
}

export function buildRsvpComponents(annId, disabled = false) {
    return [{
        type: 1, // Action Row
        components: [
            { type: 2, style: 3, label: 'Accept', custom_id: `rsvp_accept_${annId}`, emoji: { name: '✅' }, disabled },
            { type: 2, style: 4, label: 'Decline', custom_id: `rsvp_decline_${annId}`, emoji: { name: '❌' }, disabled },
            { type: 2, style: 1, label: 'Tentative', custom_id: `rsvp_tentative_${annId}`, emoji: { name: '❓' }, disabled }
        ]
    }];
}

/**
 * Bot mesajlarinin altina eklenen "HUNS Guild Portal" karti.
 * Ciplak link yerine bu kullaniliyor -- Discord'da baslikli, aciklamali,
 * renkli bir kart olarak gorunuyor. Metin INGILIZCE.
 */
export const PORTAL_URL = 'https://balamir.huns.workers.dev';

export function buildPortalEmbed() {
    return {
        title: 'HUNS Guild Portal',
        url: PORTAL_URL,
        description: 'DKP tracking, raid roster planning and Discord event management. Allods Online EU.',
        color: 0xf59e0b
    };
}
