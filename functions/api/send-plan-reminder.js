// Etkinlik Planı'nın 30dk/15dk/başlıyor hatırlatmalarını, artık webhook DEĞİL, BOT üzerinden
// admin'in seçtiği istediği kadar kanala gönderir.
// Adres: https://SITEN.workers.dev/api/send-plan-reminder
// İstek (JSON): { content: string, channelIds: string[] }

import { buildPortalEmbed } from '../_embedHelper.js';

export async function onRequestPost(context) {
    const { request, env } = context;

    let payload;
    try { payload = await request.json(); } catch (e) { return new Response('Invalid JSON', { status: 400 }); }

    const { content, channelIds, mentionUsers } = payload;
    if (!content) return new Response('content zorunludur.', { status: 400 });
    if (!Array.isArray(channelIds) || channelIds.length === 0) {
        return new Response('En az bir kanal seçilmelidir (channelIds).', { status: 400 });
    }

    const results = {};
    for (const channelId of channelIds) {
        try {
            const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
                method: 'POST',
                headers: { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
                // mentionUsers verilmisse SADECE o kullanicilar pinglenir (loot sonucu gibi).
                // Verilmemisse eski davranis: @everyone.
                body: JSON.stringify({
                    content,
                    embeds: [buildPortalEmbed()],
                    allowed_mentions: Array.isArray(mentionUsers) && mentionUsers.length
                        ? { parse: [], users: mentionUsers }
                        : { parse: ['everyone'] }
                })
            });
            results[channelId] = res.ok;
            if (!res.ok) console.error(`send-plan-reminder kanal ${channelId} hatası:`, await res.text());
        } catch (e) {
            results[channelId] = false;
            console.error(`send-plan-reminder kanal ${channelId} hatası:`, e);
        }
    }

    return new Response(JSON.stringify({ success: true, results }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
    });
}
