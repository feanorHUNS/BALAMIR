// Bu dosya bağımsız bir endpoint DEĞİLDİR — /functions altında "_" ile başladığı için
// Cloudflare Pages tarafından route olarak algılanmaz, sadece diğer fonksiyonların
// import ettiği paylaşılan bir yardımcı modüldür (Discord embed'ini oluşturur).

export function buildAnnouncementEmbed(ann) {
    const acceptedNames = Object.values(ann.accepted || {});
    const declinedNames = Object.values(ann.declined || {});
    const tentativeNames = Object.values(ann.tentative || {});
    const unixTime = ann.time ? Math.floor(new Date(ann.time).getTime() / 1000) : null;

    return {
        title: ann.title || 'Etkinlik',
        description: ann.content || '',
        color: 3447003,
        fields: [
            ...(unixTime ? [{ name: '🗓️ Time', value: `<t:${unixTime}:F>\n<t:${unixTime}:R>`, inline: false }] : []),
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
