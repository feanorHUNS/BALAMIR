// Bu dosya, düz Cloudflare Workers deploy'unun (Pages Functions DEĞİL) TEK giriş noktasıdır.
// Görevi: gelen isteğin kimliğini doğrulamak, doğru fonksiyona yönlendirmek, eşleşen bir
// API adresi yoksa statik dosyaları (index.html vb.) olduğu gibi servis etmek.
//
// ÖNEMLİ: Bu dosya GitHub reponun KÖKÜNDE olmalı (functions/ klasörüyle aynı seviyede).

import { authenticate, hasAtLeast, checkRateLimit, fb } from './functions/_auth.js';
import { onRequestPost as discordInteractions } from './functions/api/discord-interactions.js';
import { onRequestPost as sendAnnouncement } from './functions/api/send-announcement.js';
import { onRequestPost as finalizeAnnouncement } from './functions/api/finalize-announcement.js';
import { onRequestPost as deleteAnnouncement } from './functions/api/delete-announcement.js';
import { onRequestPost as syncAnnouncements } from './functions/api/sync-announcements.js';
import { onRequestPost as sendPlanImage } from './functions/api/send-plan-image.js';
import { onRequestPost as sendPlanReminder } from './functions/api/send-plan-reminder.js';

// ============================================================================
// ADRES TABLOSU  (Madde 25 + 27)
// ============================================================================
// public   : true  -> kimlik doğrulaması ARANMAZ. Yalnızca Discord'un kendi imzasıyla
//                     doğrulanan uç için geçerli (Discord bize token gönderemez).
// minRole  : bu işlemi yapabilmek için gereken en düşük rol.
// limit / windowMs : hız sınırı (kullanıcı başına, kayan pencere).
const ROUTES = {
    '/api/discord-interactions':  { handler: discordInteractions,  public: true },

    '/api/send-announcement':     { handler: sendAnnouncement,     minRole: 'member', limit: 5,  windowMs: 600000 },
    '/api/finalize-announcement': { handler: finalizeAnnouncement, minRole: 'member', limit: 30, windowMs: 600000 },
    '/api/delete-announcement':   { handler: deleteAnnouncement,   minRole: 'member', limit: 30, windowMs: 600000 },
    '/api/sync-announcements':    { handler: syncAnnouncements,    minRole: 'member', limit: 90, windowMs: 600000 },
    '/api/send-plan-image':       { handler: sendPlanImage,        minRole: 'member', limit: 10, windowMs: 600000 },
    '/api/send-plan-reminder':    { handler: sendPlanReminder,     minRole: 'member', limit: 25, windowMs: 600000 }
};

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const route = request.method === 'POST' ? ROUTES[url.pathname] : null;

        if (route) {
            try {
                // --- Herkese açık uç (yalnızca Discord etkileşimleri) ----------
                if (route.public) {
                    // ctx da geciriliyor: discord-interactions, Discord'un 3 saniye
                    // sinirina takilmamak icin isi ctx.waitUntil ile arka plana aliyor.
                    return await route.handler({ request, env, ctx });
                }

                // --- 1) Kimlik doğrulama --------------------------------------
                const auth = await authenticate(request, env);
                if (!auth.ok) return auth.response;

                // --- 2) Yetki seviyesi ----------------------------------------
                if (route.minRole && !hasAtLeast(auth.role, route.minRole)) {
                    return jsonError(403, 'Bu islem icin yetkiniz yok.');
                }

                // --- 3) Hiz siniri --------------------------------------------
                if (route.limit) {
                    const rl = await checkRateLimit(env, auth.uid, url.pathname, route.limit, route.windowMs);
                    if (!rl.ok) return rl.response;
                }

                // Dogrulanmis kimlik fonksiyona geciriliyor; fonksiyonlar artik
                // istemciden gelen "authorName" gibi alanlara guvenmek zorunda degil.
                return await route.handler({ request, env, ctx, auth });
            } catch (e) {
                console.error(`worker.js routing error @ ${url.pathname}:`, e);
                return jsonError(500, 'Sunucu hatasi: ' + e.message);
            }
        }

        // Eslesen bir API adresi yoksa: index.html ve diger statik dosyalari servis et.
        return env.ASSETS.fetch(request);
    },

    // Cloudflare Cron Trigger tarafindan HER DAKIKA otomatik cagrilir.
    async scheduled(event, env, ctx) {
        ctx.waitUntil(runScheduledPosts(env));
    }
};

function jsonError(status, message) {
    return new Response(JSON.stringify({ error: message }), {
        status, headers: { 'Content-Type': 'application/json' }
    });
}

// Turkiye 2016'dan beri kalici olarak UTC+3'te (yaz saati uygulamasi yok).
const TR_OFFSET_MS = 3 * 60 * 60 * 1000;

// Bir zamanlanmis paylasim kac kez ust uste basarisiz olursa pes edilir (Madde 28).
const MAX_SCHEDULED_ATTEMPTS = 5;

function computeNextWeeklyFireUTC(dayOfWeek, hh, mm, fromUTCms) {
    const trShifted = new Date(fromUTCms + TR_OFFSET_MS);
    const curDay = trShifted.getUTCDay();

    let daysUntil = (dayOfWeek - curDay + 7) % 7;
    const candidate = new Date(trShifted);
    candidate.setUTCDate(candidate.getUTCDate() + daysUntil);
    candidate.setUTCHours(hh, mm, 0, 0);

    let candidateUTCms = candidate.getTime() - TR_OFFSET_MS;
    if (candidateUTCms <= fromUTCms) candidateUTCms += 7 * 24 * 60 * 60 * 1000;
    return candidateUTCms;
}

async function runScheduledPosts(env) {
    try {
        const res = await fetch(fb(env, `ScheduledPosts`));
        const all = await res.json();

        if (!all) return;

        const now = Date.now();

        for (const [postId, post] of Object.entries(all)) {
            if (!post || !post.active) continue;
            if (!post.nextFireAt || post.nextFireAt > now) continue;

            // ================================================================
            // Madde 28: Gonderim BASARISIZ olursa durumu ilerletme.
            // Eskiden Discord'a mesaj gitmese bile firedCount artip nextFireAt
            // ileri aliniyordu -- yani bot bir dakikaligina erisilemezse o
            // paylasim KALICI OLARAK kayboluyordu. Artik en az bir kanala
            // basariyla gitmedikce paylasim "gonderildi" sayilmiyor.
            // ================================================================
            let anySuccess = false;
            const channelIds = post.channelIds || [];

            for (const channelId of channelIds) {
                try {
                    const body = { content: post.content || '', allowed_mentions: { parse: ['everyone'] } };
                    if (post.imageUrl) body.embeds = [{ image: { url: post.imageUrl } }];
                    const dRes = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
                        method: 'POST',
                        headers: { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify(body)
                    });
                    if (dRes.ok) {
                        anySuccess = true;
                    } else {
                        console.error(`[scheduled] ${postId} -> kanal ${channelId} hata ${dRes.status}: ${await dRes.text()}`);
                    }
                } catch (e) {
                    console.error(`[scheduled] ${postId} -> kanal ${channelId} ag hatasi:`, e);
                }
            }

            // --- Hicbir kanala gidemediyse: durumu ilerletme, tekrar dene ----
            if (!anySuccess) {
                const attempts = (post.failedAttempts || 0) + 1;
                const updates = { failedAttempts: attempts, lastErrorAt: now };

                if (attempts >= MAX_SCHEDULED_ATTEMPTS) {
                    // Surekli basarisiz oluyorsa sonsuz donguye girmesin; durdur ve
                    // sitede gorunur bir hata birak.
                    updates.active = false;
                    updates.lastError = `${MAX_SCHEDULED_ATTEMPTS} denemede gonderilemedi, durduruldu.`;
                    console.error(`[scheduled] ${postId} ${MAX_SCHEDULED_ATTEMPTS} denemede gonderilemedi -- durduruldu.`);
                } else {
                    console.log(`[scheduled] ${postId} gonderilemedi (deneme ${attempts}/${MAX_SCHEDULED_ATTEMPTS}), sonraki dakikada tekrar denenecek.`);
                }

                await fetch(fb(env, `ScheduledPosts/${postId}`), {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(updates)
                }).catch(e => console.error(`[scheduled] ${postId} hata kaydi yazilamadi:`, e));

                continue; // nextFireAt'e DOKUNMUYORUZ -> bir sonraki cron'da tekrar denenecek
            }

            // --- Basarili: siradaki gonderim zamanini hesapla ----------------
            const updates = {
                lastFiredAt: now,
                firedCount: (post.firedCount || 0) + 1,
                failedAttempts: 0,
                lastError: null
            };

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

            await fetch(fb(env, `ScheduledPosts/${postId}`), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updates)
            }).catch(e => console.error(`[scheduled] ${postId} durum guncelleme hatasi:`, e));
        }
    } catch (e) {
        console.error('runScheduledPosts genel hata:', e);
    }
}
