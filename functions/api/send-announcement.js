// Site içindeki "Discord Duyurusu" sekmesinden çağrılır.
// Adres: https://SITEN.pages.dev/api/send-announcement

import { buildAnnouncementEmbed, buildRsvpComponents } from '../_embedHelper.js';
import { buildLinkPreviewEmbedFromText } from './link-preview.js';
import { fb } from '../_auth.js';

export async function onRequestPost(context) {
    const { request, env, auth } = context;

    let payload;
    try { payload = await request.json(); } catch (e) { return new Response('Invalid JSON', { status: 400 }); }

    const { title, time, content, channelId } = payload;
    if (!title || !content) {
        return new Response('title ve content alanları zorunludur.', { status: 400 });
    }

    // GÜVENLİK (Madde 25): Yazar adı artık istemciden GELMİYOR. Eskiden istemci
    // "authorName" alanını istediği gibi doldurabiliyordu — yani biri başkasının
    // adına duyuru yayınlayabilirdi. Artık worker.js'in doğruladığı kimlikten alınıyor.
    const authorName = (auth && auth.name) || 'Guild Portal';

    // Site üzerinden admin panelinde tanımlanan kanallardan biri seçilmişse onu kullan,
    // seçilmemişse (eski istekler / geriye dönük uyumluluk) ortam değişkenindeki varsayılana düş.
    const targetChannelId = channelId || env.DISCORD_CHANNEL_ID;
    if (!targetChannelId) {
        return new Response('Hedef kanal belirtilmedi ve varsayılan DISCORD_CHANNEL_ID de ayarlanmamış.', { status: 400 });
    }

    const annId = 'ann_' + Date.now();
    const ann = { title, content, time: time || null, authorName: authorName || 'Guild Portal', accepted: {}, declined: {}, tentative: {}, finalized: false };

    // Metindeki ilk baglantinin onizlemesi (varsa).
    let linkPreview = null;
    try { linkPreview = await buildLinkPreviewEmbedFromText(content); }
    catch (e) { console.error('onizleme uretilemedi:', e); }

    const embed = buildAnnouncementEmbed(ann);
    const components = buildRsvpComponents(annId, false);

    try {
        const discordRes = await fetch(`https://discord.com/api/v10/channels/${targetChannelId}/messages`, {
            method: 'POST',
            headers: { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: '@everyone',
                // Duyuru metninde baglanti varsa onizlemesi de eklenir.
                embeds: [embed].concat(linkPreview ? [linkPreview] : []),
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

        // ÖNEMLİ: Discord'a mesaj gitse bile, siteye kaydetme adımı başarısız olabilir.
        // Bu durumda admin'e KARIŞTIRMADAN, net bir "kısmi başarı" mesajı dönüyoruz —
        // yoksa "hiç gönderilmedi" sanıp tekrar gönderip Discord'da mesajı ikiletebilir.
        try {
            const fbRes = await fetch(fb(env, `Announcements/${annId}`), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(ann)
            });
            if (!fbRes.ok) {
                const fbErrText = await fbRes.text();
                console.error('Firebase kaydetme hatası:', fbErrText);
                return new Response(
                    `Discord'a mesaj GÖNDERİLDİ (tekrar göndermeyin) ama site veritabanına kaydedilemedi: ${fbErrText}`,
                    { status: 502 }
                );
            }
        } catch (fbErr) {
            console.error('Firebase kaydetme hatası (network):', fbErr);
            return new Response(
                `Discord'a mesaj GÖNDERİLDİ (tekrar göndermeyin) ama site veritabanına kaydedilemedi: ${fbErr.message}`,
                { status: 502 }
            );
        }

        return new Response(JSON.stringify({ success: true, annId, messageId: discordMsg.id }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (e) {
        console.error('send-announcement error:', e);
        return new Response('Sunucu hatası: ' + e.message, { status: 500 });
    }
}
