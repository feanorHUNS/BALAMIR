// Etkinlik Planı yayınlanınca (PNG görseli) BOT üzerinden, admin'in seçtiği
// istediği kadar kanala gönderir. Eski webhook sistemi artık burada kullanılmıyor.
// Adres: https://SITEN.workers.dev/api/send-plan-image
// İstek: multipart/form-data { image: <PNG dosyası>, content: <metin>, channelIds: <JSON dizi>, planId: <string> }

import { fb } from '../_auth.js';

import { buildPortalEmbed } from '../_embedHelper.js';

export async function onRequestPost(context) {
    const { request, env } = context;

    let formData;
    try { formData = await request.formData(); } catch (e) { return new Response('Invalid form data', { status: 400 }); }

    const imageFile = formData.get('image');
    const content = formData.get('content') || '';
    let channelIds = [];
    try { channelIds = JSON.parse(formData.get('channelIds') || '[]'); } catch (e) { /* boş kalsın */ }
    const planId = formData.get('planId') || '';

    if (!imageFile) return new Response('Görsel (image) alanı zorunludur.', { status: 400 });
    if (!Array.isArray(channelIds) || channelIds.length === 0) {
        return new Response('En az bir kanal seçilmelidir (channelIds).', { status: 400 });
    }

    try {
        const imageBuffer = await imageFile.arrayBuffer();
        const results = {};

        for (const channelId of channelIds) {
            try {
                const discordForm = new FormData();
                discordForm.append('payload_json', JSON.stringify({ content, embeds: [buildPortalEmbed()], allowed_mentions: { parse: ['everyone'] } }));
                discordForm.append('files[0]', new Blob([imageBuffer], { type: 'image/png' }), 'plan.png');

                const discordRes = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}` },
                    body: discordForm
                });

                if (discordRes.ok) {
                    const msg = await discordRes.json();
                    results[channelId] = { success: true, messageId: msg.id };
                } else {
                    results[channelId] = { success: false, error: await discordRes.text() };
                }
            } catch (e) {
                results[channelId] = { success: false, error: e.message };
            }
        }

        // İleride takip/temizlik için, hangi plana hangi kanallarda hangi mesajın gittiğini kaydet.
        if (planId) {
            await fetch(fb(env, `PlanDiscordPosts/${planId}`), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(results)
            }).catch(() => null);
        }

        return new Response(JSON.stringify({ success: true, results }), {
            status: 200, headers: { 'Content-Type': 'application/json' }
        });
    } catch (e) {
        console.error('send-plan-image error:', e);
        return new Response('Sunucu hatası: ' + e.message, { status: 500 });
    }
}
