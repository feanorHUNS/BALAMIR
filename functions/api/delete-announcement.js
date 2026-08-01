// YENİ: "Sil" butonu için. "Şimdi Sonlandır"dan farkı: teşekkür mesajı GÖNDERMEZ,
// duyuruyu sitedeki listeden de TAMAMEN kaldırır (sadece finalized=true işaretlemez, Firebase'den siler).
// Adres: https://SITEN.workers.dev/api/delete-announcement

import { fb } from '../_auth.js';

export async function onRequestPost(context) {
    const { request, env } = context;

    let payload;
    try { payload = await request.json(); } catch (e) { return new Response('Invalid JSON', { status: 400 }); }

    const { annId } = payload;
    if (!annId) return new Response('annId zorunludur.', { status: 400 });

    try {
        const annRes = await fetch(fb(env, `Announcements/${annId}`));
        const ann = await annRes.json();
        if (!ann) return new Response('Duyuru bulunamadı (zaten silinmiş olabilir).', { status: 404 });

        // 1) Discord mesajını sil (zaten silinmişse 404 gelir, sorun değil, yoksayıyoruz).
        try {
            await fetch(`https://discord.com/api/v10/channels/${ann.channelId}/messages/${ann.messageId}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}` }
            });
        } catch (e) { console.error('Mesaj silinemedi (yoksayıldı):', e); }

        // NOT: Eski webhook tabanli hatirlatma silme blogu kaldirildi.
        // Hatirlatma mesajlari artik bot uzerinden gonderiliyor ve etkinlikten
        // 2 saat sonra cron gorevi (runPostEventCleanup) tarafindan siliniyor.

        // 3) Siteden TAMAMEN kaldır (sadece finalized işaretlemek değil, tam silme).
        await fetch(fb(env, `Announcements/${annId}`), { method: 'DELETE' });

        return new Response(JSON.stringify({ success: true }), {
            status: 200, headers: { 'Content-Type': 'application/json' }
        });
    } catch (e) {
        console.error('delete-announcement error:', e);
        return new Response('Sunucu hatası: ' + e.message, { status: 500 });
    }
}
