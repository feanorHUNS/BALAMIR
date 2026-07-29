// YENİ: Biri bir duyuru mesajını Discord'dan ELLE silerse, site bunu otomatik anlayıp
// o duyuruyu "sonlandırılmış" olarak işaretlesin diye periyodik olarak (site açıkken,
// checkAnnouncementExpiry ile birlikte) çağrılır.
//
// Discord bize "birisi mesajı sildi" diye bir bildirim GÖNDERMEZ (bizim bot sürekli açık bir
// bağlantı - Gateway - tutmuyor, sadece HTTP istekleriyle çalışıyor). Bu yüzden tek yol:
// hâlâ "aktif" (finalized=false) görünen duyuruların mesajının Discord'da GERÇEKTEN var olup
// olmadığını arada bir kontrol etmek.
//
// Adres: https://SITEN.workers.dev/api/sync-announcements

import { fb } from '../_auth.js';

export async function onRequestPost(context) {
    const { request, env } = context;

    let payload;
    try { payload = await request.json(); } catch (e) { return new Response('Invalid JSON', { status: 400 }); }

    const { annId, channelId, messageId } = payload;
    if (!annId || !channelId || !messageId) {
        return new Response('annId, channelId ve messageId zorunludur.', { status: 400 });
    }

    try {
        const msgRes = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, {
            headers: { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}` }
        });

        // Mesaj Discord'da artık yoksa (404) -> demek ki biri elle silmiş. Sitede de kapatıyoruz.
        if (msgRes.status === 404) {
            await fetch(fb(env, `Announcements/${annId}`), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ finalized: true, autoClosedReason: 'discord_message_deleted' })
            });
            return new Response(JSON.stringify({ success: true, wasDeleted: true }), {
                status: 200, headers: { 'Content-Type': 'application/json' }
            });
        }

        return new Response(JSON.stringify({ success: true, wasDeleted: false }), {
            status: 200, headers: { 'Content-Type': 'application/json' }
        });
    } catch (e) {
        console.error('sync-announcements error:', e);
        return new Response('Sunucu hatası: ' + e.message, { status: 500 });
    }
}
