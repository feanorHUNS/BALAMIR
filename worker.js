// Bu dosya, düz Cloudflare Workers deploy'unun (Pages Functions DEĞİL) TEK giriş noktasıdır.
// Görevi: hangi adrese istek geldiğine bakıp doğru fonksiyona yönlendirmek, eşleşen bir
// API adresi yoksa statik dosyaları (index.html vb.) olduğu gibi servis etmek.
//
// ÖNEMLİ: Bu dosyayı GitHub reponun KÖKÜNE yükle (functions/ klasörüyle aynı seviyeye).
// wrangler.jsonc ile birlikte, ikisi de repo kökünde olmalı.

import { onRequestPost as discordInteractions } from './functions/api/discord-interactions.js';
import { onRequestPost as sendAnnouncement } from './functions/api/send-announcement.js';
import { onRequestPost as finalizeAnnouncement } from './functions/api/finalize-announcement.js';
import { onRequestPost as deleteAnnouncement } from './functions/api/delete-announcement.js';
import { onRequestPost as syncAnnouncements } from './functions/api/sync-announcements.js';
import { onRequestPost as sendPlanImage } from './functions/api/send-plan-image.js';
import { onRequestPost as sendPlanReminder } from './functions/api/send-plan-reminder.js';

const ROUTES = {
    '/api/discord-interactions': discordInteractions,
    '/api/send-announcement': sendAnnouncement,
    '/api/finalize-announcement': finalizeAnnouncement,
    '/api/delete-announcement': deleteAnnouncement,
    '/api/sync-announcements': syncAnnouncements,
    '/api/send-plan-image': sendPlanImage,
    '/api/send-plan-reminder': sendPlanReminder
};

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const handler = request.method === 'POST' ? ROUTES[url.pathname] : null;

        if (handler) {
            try {
                return await handler({ request, env });
            } catch (e) {
                console.error(`worker.js routing error @ ${url.pathname}:`, e);
                return new Response('Sunucu hatası: ' + e.message, { status: 500 });
            }
        }

        // Eşleşen bir API adresi yoksa: index.html ve diğer statik dosyaları servis et.
        return env.ASSETS.fetch(request);
    },

    // Cloudflare Cron Trigger tarafından HER DAKİKA otomatik çağrılır (wrangler.jsonc → triggers.crons).
    // Kimse siteyi açık tutmasa bile, "sırası gelmiş" zamanlanmış paylaşımları bulup Discord'a gönderir.
    async scheduled(event, env, ctx) {
        ctx.waitUntil(runScheduledPosts(env));
    }
};

// Türkiye 2016'dan beri kalıcı olarak UTC+3'te (yaz saati uygulaması yok) — bu yüzden
// hesaplama basit, sabit bir ofsetle yapılabiliyor.
const TR_OFFSET_MS = 3 * 60 * 60 * 1000;

// Belirtilen haftanın günü + saat:dakika (TR saatiyle) için, "fromUTCms"den SONRAKİ
// ilk gerçekleşme anını UTC epoch (ms) olarak hesaplar. Haftalık tekrar için kullanılır.
function computeNextWeeklyFireUTC(dayOfWeek, hh, mm, fromUTCms) {
    const trShifted = new Date(fromUTCms + TR_OFFSET_MS); // TR duvar saatini UTC getter'larla okumak için kaydırılmış zaman
    const curDay = trShifted.getUTCDay();

    let daysUntil = (dayOfWeek - curDay + 7) % 7;
    const candidate = new Date(trShifted);
    candidate.setUTCDate(candidate.getUTCDate() + daysUntil);
    candidate.setUTCHours(hh, mm, 0, 0);

    let candidateUTCms = candidate.getTime() - TR_OFFSET_MS;
    if (candidateUTCms <= fromUTCms) candidateUTCms += 7 * 24 * 60 * 60 * 1000; // bu hafta geçtiyse bir sonraki haftaya kaydır
    return candidateUTCms;
}

async function runScheduledPosts(env) {
    try {
        const res = await fetch(`${env.FIREBASE_DB_URL}/ScheduledPosts.json`);
        const all = await res.json();
        if (!all) return;

        const now = Date.now();

        for (const [postId, post] of Object.entries(all)) {
            if (!post || !post.active) continue;
            if (!post.nextFireAt || post.nextFireAt > now) continue;

            // 1) Her seçili kanala gönder (metin + varsa görsel linki bir embed olarak).
            for (const channelId of (post.channelIds || [])) {
                try {
                    const body = { content: post.content || '', allowed_mentions: { parse: ['everyone'] } };
                    if (post.imageUrl) body.embeds = [{ image: { url: post.imageUrl } }];
                    await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
                        method: 'POST',
                        headers: { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify(body)
                    });
                } catch (e) { console.error(`ScheduledPost ${postId} -> kanal ${channelId} gönderim hatası:`, e); }
            }

            // 2) Zamanlama tipine göre bir sonraki durumu hesapla.
            const updates = { lastFiredAt: now, firedCount: (post.firedCount || 0) + 1 };
            if (post.scheduleType === 'once') {
                updates.active = false;
            } else if (post.scheduleType === 'interval_count') {
                if (updates.firedCount >= (post.repeatCount || 1)) {
                    updates.active = false;
                } else {
                    updates.nextFireAt = now + (post.intervalHours || 24) * 3600000;
                }
            } else if (post.scheduleType === 'interval_forever') {
                updates.nextFireAt = now + (post.intervalHours || 24) * 3600000;
            } else if (post.scheduleType === 'weekly') {
                updates.nextFireAt = computeNextWeeklyFireUTC(post.dayOfWeek, post.hour, post.minute, now);
            }

            await fetch(`${env.FIREBASE_DB_URL}/ScheduledPosts/${postId}.json`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updates)
            }).catch(e => console.error(`ScheduledPost ${postId} durum güncelleme hatası:`, e));
        }
    } catch (e) {
        console.error('runScheduledPosts genel hata:', e);
    }
}
