// Site (checkAnnouncementExpiry) tarafından, etkinlik saati geldiğinde otomatik çağrılır.
// Adres: https://SITEN.pages.dev/api/finalize-announcement

export async function onRequestPost(context) {
    const { request, env } = context;

    let payload;
    try { payload = await request.json(); } catch (e) { return new Response('Invalid JSON', { status: 400 }); }

    const { annId, webhookUrl } = payload;
    if (!annId) return new Response('annId zorunludur.', { status: 400 });

    try {
        const annRes = await fetch(`${env.FIREBASE_DB_URL}/Announcements/${annId}.json`);
        const ann = await annRes.json();
        if (!ann) return new Response('Duyuru bulunamadı.', { status: 404 });
        if (ann.finalized) {
            return new Response(JSON.stringify({ success: true, alreadyFinalized: true }), {
                status: 200, headers: { 'Content-Type': 'application/json' }
            });
        }

        // 1) Butonları kaldır (mesajı düzenle, components: [])
        await fetch(`https://discord.com/api/v10/channels/${ann.channelId}/messages/${ann.messageId}`, {
            method: 'PATCH',
            headers: { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ components: [] })
        });

        // 2) Katılımı onaylayanları etiketleyip TR+EN teşekkür mesajı gönder.
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

        // 3) Bu etkinlik için daha önce gönderilmiş "30dk kaldı / 15dk kaldı / başlıyor" hatırlatma
        //    mesajlarını, artık işe yaramadıkları için Discord kanalından otomatik siler.
        if (webhookUrl && ann.reminderMsgIds) {
            const deletePromises = Object.values(ann.reminderMsgIds).map(msgId =>
                fetch(`${webhookUrl}/messages/${msgId}`, { method: 'DELETE' }).catch(() => null)
            );
            await Promise.all(deletePromises);
        }

        // 4) Tekrar tetiklenmesin diye işaretle.
        await fetch(`${env.FIREBASE_DB_URL}/Announcements/${annId}.json`, {
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
