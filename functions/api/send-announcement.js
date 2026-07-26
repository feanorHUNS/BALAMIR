// Site içindeki "Discord Duyurusu" sekmesinden çağrılır.
// Adres: https://SITEN.pages.dev/api/send-announcement

import { buildAnnouncementEmbed, buildRsvpComponents } from '../_embedHelper.js';

export async function onRequestPost(context) {
    const { request, env } = context;

    let payload;
    try { payload = await request.json(); } catch (e) { return new Response('Invalid JSON', { status: 400 }); }

    const { title, time, content, authorName, channelId } = payload;
    if (!title || !content) {
        return new Response('title ve content alanları zorunludur.', { status: 400 });
    }

    // Site üzerinden admin panelinde tanımlanan kanallardan biri seçilmişse onu kullan,
    // seçilmemişse (eski istekler / geriye dönük uyumluluk) ortam değişkenindeki varsayılana düş.
    const targetChannelId = channelId || env.DISCORD_CHANNEL_ID;
    if (!targetChannelId) {
        return new Response('Hedef kanal belirtilmedi ve varsayılan DISCORD_CHANNEL_ID de ayarlanmamış.', { status: 400 });
    }

    const annId = 'ann_' + Date.now();
    const ann = { title, content, time: time || null, authorName: authorName || 'Guild Portal', accepted: {}, declined: {}, tentative: {}, finalized: false };

    const embed = buildAnnouncementEmbed(ann);
    const components = buildRsvpComponents(annId, false);

    try {
        const discordRes = await fetch(`https://discord.com/api/v10/channels/${targetChannelId}/messages`, {
            method: 'POST',
            headers: { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: '@everyone',
                embeds: [embed],
                components,
                allowed_mentions: { parse: ['everyone'] }
            })
        });

        if (!discordRes.ok) {
            const errText = await discordRes.text();
            console.error('Discord API error:', errText);
            return new Response(`Discord API hatası: ${errText}`, { status: 502 });
        }

        const discordMsg = await discordRes.json();

        ann.messageId = discordMsg.id;
        ann.channelId = targetChannelId;
        ann.createdAt = Date.now();

        await fetch(`${env.FIREBASE_DB_URL}/Announcements/${annId}.json`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(ann)
        });

        return new Response(JSON.stringify({ success: true, annId, messageId: discordMsg.id }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (e) {
        console.error('send-announcement error:', e);
        return new Response('Sunucu hatası: ' + e.message, { status: 500 });
    }
}
