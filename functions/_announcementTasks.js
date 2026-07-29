// ============================================================================
// PAYLASILAN DUYURU GOREVLERI  (Madde 31)
// ============================================================================
// Bu mantik daha once SADECE tarayicida (index.html icinde) calisiyordu. Yani
// duyurular ancak birileri siteyi ACIK TUTTUGUNDA sonlaniyordu; kimse acmazsa
// etkinlik saati gecse bile duyuru Discord'da asili kaliyordu.
//
// Artik ayni mantik hem elle cagrilan /api/finalize-announcement ucundan hem de
// her dakika calisan cron gorevinden kullaniliyor. Tek kaynak, iki cagiran.

import { fb } from './_auth.js';

/**
 * Bir duyuruyu sonlandirir:
 *   1) Katilimi onaylayanlara tesekkur mesaji atar
 *   2) Orijinal duyuru mesajini Discord'dan siler
 *   3) Varsa hatirlatma mesajlarini siler
 *   4) Firebase'de finalized=true isaretler
 *
 * Discord tarafindaki adimlar basarisiz olsa bile 4. adim HER ZAMAN calisir —
 * boylece mesaj elle silinmis olsa da site senkron kalir.
 *
 * @returns {{ok: boolean, alreadyFinalized?: boolean, notFound?: boolean, error?: string}}
 */
export async function finalizeAnnouncementCore(env, annId, webhookUrl, reason) {
    try {
        const annRes = await fetch(fb(env, `Announcements/${annId}`));
        const ann = await annRes.json();
        if (!ann) return { ok: false, notFound: true };
        if (ann.finalized) return { ok: true, alreadyFinalized: true };

        // 1) Tesekkur mesaji
        try {
            const acceptedIds = Object.keys(ann.accepted || {});
            if (acceptedIds.length > 0 && ann.channelId) {
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
        } catch (e) { console.error('[finalize] tesekkur mesaji gonderilemedi (yoksayildi):', e); }

        // 2) Orijinal mesaji sil (zaten silinmisse Discord 404 doner, normal)
        try {
            if (ann.channelId && ann.messageId) {
                await fetch(`https://discord.com/api/v10/channels/${ann.channelId}/messages/${ann.messageId}`, {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}` }
                });
            }
        } catch (e) { console.error('[finalize] mesaj silinemedi (yoksayildi):', e); }

        // 3) Hatirlatma mesajlari
        try {
            if (webhookUrl && ann.reminderMsgIds) {
                await Promise.all(Object.values(ann.reminderMsgIds).map(msgId =>
                    fetch(`${webhookUrl}/messages/${msgId}`, { method: 'DELETE' }).catch(() => null)
                ));
            }
        } catch (e) { console.error('[finalize] hatirlatmalar silinemedi (yoksayildi):', e); }

        // 4) Isaretle — yukarida ne olursa olsun BU CALISIR.
        const patch = { finalized: true, finalizedAt: Date.now() };
        if (reason) patch.finalizedReason = reason;
        await fetch(fb(env, `Announcements/${annId}`), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch)
        });

        return { ok: true };
    } catch (e) {
        console.error('finalizeAnnouncementCore error:', e);
        return { ok: false, error: e.message };
    }
}

/**
 * Bir duyurunun Discord mesaji hala duruyor mu? Biri elle sildiyse siteyi de
 * senkronlar (Madde 31). Discord bize silme bildirimi GONDERMEZ, tek yol budur.
 * @returns {boolean} mesaj silinmis ve site senkronlanmissa true
 */
export async function syncAnnouncementCore(env, annId, channelId, messageId) {
    try {
        const msgRes = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, {
            headers: { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}` }
        });
        if (msgRes.status === 404) {
            await fetch(fb(env, `Announcements/${annId}`), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ finalized: true, autoClosedReason: 'discord_message_deleted' })
            });
            return true;
        }
        return false;
    } catch (e) {
        console.error('syncAnnouncementCore error:', e);
        return false;
    }
}

/**
 * Ayni isin iki kez yapilmasini onleyen kilit (Madde 31/32).
 * Kilidi ilk alan calisir; digerleri atlar. Tarayici tarafindaki
 * tryClaimReminder ile AYNI yolu kullanir, boylece gecis doneminde
 * istemci ve sunucu birbirini tekrarlamaz.
 *
 * Firebase REST'te transaction yok; bunun yerine kosullu yazma icin
 * once okuyup sonra yaziyoruz. Cron tek bir yerden calistigi icin
 * bu pratikte yeterli.
 */
export async function claimLock(env, lockKey) {
    try {
        const url = fb(env, `ReminderLocks/${lockKey}`);
        const cur = await (await fetch(url)).json();
        if (cur === true) return false;
        await fetch(url, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(true)
        });
        return true;
    } catch (e) {
        console.error('claimLock error:', e);
        return false;
    }
}
