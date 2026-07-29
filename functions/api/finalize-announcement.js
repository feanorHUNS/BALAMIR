// Site (checkAnnouncementExpiry / manuel "Finalize Now") tarafından çağrılır.
// Adres: https://SITEN.pages.dev/api/finalize-announcement
//
// ÖNEMLİ: Discord tarafındaki adımlardan biri (mesaj zaten silinmiş, kanal artık yok vb.)
// başarısız olsa bile, sitedeki "finalized" durumu HER ZAMAN kaydedilir — yani biri mesajı
// Discord'dan elle silmiş olsa da, "Finalize Now"a bastığında site senkron kalır.

import { fb } from '../_auth.js';

export async function onRequestPost(context) {
    const { request, env } = context;

    let payload;
    try { payload = await request.json(); } catch (e) { return new Response('Invalid JSON', { status: 400 }); }

    const { annId, webhookUrl } = payload;
    if (!annId) return new Response('annId zorunludur.', { status: 400 });

    try {
        const annRes = await fetch(fb(env, `Announcements/${annId}`));
        const ann = await annRes.json();
        if (!ann) return new Response('Duyuru bulunamadı.', { status: 404 });
        if (ann.finalized) {
            return new Response(JSON.stringify({ success: true, alreadyFinalized: true }), {
                status: 200, headers: { 'Content-Type': 'application/json' }
            });
        }

        // 1) Katılımı onaylayanları etiketleyip TR+EN teşekkür mesajı gönder.
        //    (Discord tarafı başarısız olsa bile aşağıdaki finalize adımını engellemesin diye try/catch içinde.)
        try {
            const acceptedIds = Object.keys(ann.accepted || {});
            if (acceptedIds.length > 0) {
                const mentions = acceptedIds.map(id => `<@${id}>`).join(' ');
                await fetch(`https://discord.com/api/v10/channels/${ann.channelId}/messages`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        content: `🎉 Katılımınızı onayladığınız için teşekkürler! / Thank you for confirming your attendance!\n\n${mentions}`,
                        allowed_mentions: { parse: [], users: acceptedIds }
                    })
                });
            }
        } catch (e) { console.error('Teşekkür mesajı gönderilemedi (yoksayıldı):', e); }

        // 2) Orijinal duyuru mesajını Discord'dan sil. Mesaj zaten (elle) silinmişse Discord 404
        //    döner — bu normal bir durum, hata sayılmaz, işleme devam edilir.
        try {
            await fetch(`https://discord.com/api/v10/channels/${ann.channelId}/messages/${ann.messageId}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}` }
            });
        } catch (e) { console.error('Mesaj silinemedi (muhtemelen zaten silinmiş, yoksayıldı):', e); }

        // 3) Bu etkinlik için daha önce gönderilmiş hatırlatma mesajlarını sil (varsa).
        try {
            if (webhookUrl && ann.reminderMsgIds) {
                const deletePromises = Object.values(ann.reminderMsgIds).map(msgId =>
                    fetch(`${webhookUrl}/messages/${msgId}`, { method: 'DELETE' }).catch(() => null)
                );
                await Promise.all(deletePromises);
            }
        } catch (e) { console.error('Hatırlatma mesajları silinemedi (yoksayıldı):', e); }

        // 4) Tekrar tetiklenmesin diye işaretle — Discord tarafında yukarıda ne olursa olsun BU HER ZAMAN ÇALIŞIR.
        await fetch(fb(env, `Announcements/${annId}`), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ finalized: true })
        });

        return new Response(JSON.stringify({ success: true }), {
            status: 200, headers: { 'Content-Type': 'application/json' }
        });
    } catch (e) {
        console.error('finalize-announcement error:', e);
        return new Response('Sunucu hatası: ' + e.message, { status: 500 });
    }
}
