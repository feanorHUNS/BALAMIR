// Bu dosya, düz Cloudflare Workers deploy'unun (Pages Functions DEĞİL) TEK giriş noktasıdır.
// Görevi: gelen isteğin kimliğini doğrulamak, doğru fonksiyona yönlendirmek, eşleşen bir
// API adresi yoksa statik dosyaları (index.html vb.) olduğu gibi servis etmek.
//
// ÖNEMLİ: Bu dosya GitHub reponun KÖKÜNDE olmalı (functions/ klasörüyle aynı seviyede).

import { authenticate, hasAtLeast, checkRateLimit, fb } from './functions/_auth.js';
import { finalizeAnnouncementCore, syncAnnouncementCore, claimLock } from './functions/_announcementTasks.js';
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
        ctx.waitUntil(runDailyBackup(env));
        ctx.waitUntil(runTimeBasedAutomation(env));
    }
};

// ============================================================================
// ZAMAN TABANLI OTOMASYON (Madde 31 + 32)
// ============================================================================
// ESKI SORUN: Duyuru sonlandirma ve raid hatirlatmalari SADECE tarayicida
// calisiyordu. Yani:
//   - Raid saatinde admin siteyi acmamissa 30/15/0 dk hatirlatmalari HIC gitmiyordu.
//   - Kimse siteyi acmazsa duyurular sonlanmiyor, Discord'da asili kaliyordu.
//
// Artik bunlar sunucuda, her dakika calisan cron icinde yapiliyor. Kimsenin
// tarayici acmasina gerek yok.
//
// Cift gonderim korumasi: tarayici tarafiyla AYNI ReminderLocks yollari
// kullaniliyor, bu yuzden gecis doneminde ikisi ayni anda calissa bile mesaj
// iki kez gitmez.

async function runTimeBasedAutomation(env) {
    try {
        const now = Date.now();

        // --- 1) Suresi gelen duyurulari sonlandir ------------------------
        const annRes = await fetch(fb(env, `Announcements`));
        const announcements = await annRes.json();

        if (announcements) {
            for (const [annId, ann] of Object.entries(announcements)) {
                if (!ann || ann.finalized) continue;

                // a) Etkinlik saati geldi mi?
                if (ann.time) {
                    const annTime = new Date(ann.time).getTime();
                    if (!isNaN(annTime) && now >= annTime) {
                        if (await claimLock(env, `${annId}_finalize`)) {
                            console.log(`[automation] ${annId} suresi doldu, sonlandiriliyor.`);
                            await finalizeAnnouncementCore(env, annId, null, 'auto_expired');
                        }
                        continue; // sonlandirildi, senkron kontrolune gerek yok
                    }
                }

                // b) Discord mesaji elle silinmis mi?
                // Her dakika kontrol etmek Discord API'sini gereksiz yorar —
                // 10 dakikada bir yeterli.
                const minute = Math.floor(now / 60000) % 10;
                if (minute === 0 && ann.channelId && ann.messageId) {
                    const wasDeleted = await syncAnnouncementCore(env, annId, ann.channelId, ann.messageId);
                    if (wasDeleted) console.log(`[automation] ${annId} mesaji Discord'dan silinmis, site senkronlandi.`);
                }
            }
        }

        // --- 2) Raid plani hatirlatmalari --------------------------------
        const gdRes = await fetch(fb(env, `GuildData`));
        const guildData = await gdRes.json();
        if (!guildData || !Array.isArray(guildData.raidPlans)) return;

        const siteUrl = env.GUILD_SITE_URL || 'https://balamir.huns.workers.dev';
        const motivMsg = guildData.discordMotivationalMsg || 'WE RISE FROM ASHES TO CONQUER THE CHAOS!';
        let plansChanged = false;

        for (const plan of guildData.raidPlans) {
            if (!plan || !plan.active || !plan.time) continue;
            const planTime = new Date(plan.time).getTime();
            if (isNaN(planTime)) continue;

            const channelIds = plan.discordChannelIds || [];
            if (!plan.published || channelIds.length === 0) continue;

            // 30 dakika kala
            if (now >= planTime - 30 * 60000 && now < planTime - 15 * 60000 && !plan.reminded30) {
                if (await claimLock(env, `${plan.id}_30`)) {
                    await sendReminder(env, channelIds,
                        `@everyone ⏳ **${plan.title || 'Event'}** başlamasına 30 dakika kaldı!`);
                    plan.reminded30 = true; plansChanged = true;
                }
            }

            // 15 dakika kala
            if (now >= planTime - 15 * 60000 && now < planTime && !plan.reminded15) {
                if (await claimLock(env, `${plan.id}_15`)) {
                    await sendReminder(env, channelIds,
                        `@everyone ⚠️ **${plan.title || 'Event'}** başlamasına 15 dakika kaldı! Hazırlıklarınızı tamamlayın.`);
                    plan.reminded15 = true; plansChanged = true;
                }
            }

            // Baslama ani
            if (now >= planTime && now < planTime + 60 * 60000 && !plan.reminded0) {
                if (await claimLock(env, `${plan.id}_0`)) {
                    await sendReminder(env, channelIds,
                        `@everyone 🔥 **${plan.title || 'Event'}** BAŞLIYOR!\n\n*${motivMsg}*`);
                    plan.reminded0 = true; plansChanged = true;
                }
            }
        }

        // Hatirlatma bayraklarini kaydet. SADECE raidPlans yolu yaziliyor —
        // ayni anda site uzerinden calisan birinin degisiklikleri ezilmesin (Madde 2).
        if (plansChanged) {
            await fetch(fb(env, `GuildData/raidPlans`), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(guildData.raidPlans)
            }).catch(e => console.error('[automation] raidPlans yazilamadi:', e));
        }
    } catch (e) {
        console.error('runTimeBasedAutomation genel hata:', e);
    }
}

async function sendReminder(env, channelIds, content) {
    for (const channelId of channelIds) {
        try {
            const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
                method: 'POST',
                headers: { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ content, allowed_mentions: { parse: ['everyone'] } })
            });
            if (!res.ok) console.error(`[automation] hatirlatma kanal ${channelId} hata ${res.status}: ${await res.text()}`);
        } catch (e) {
            console.error(`[automation] hatirlatma kanal ${channelId} ag hatasi:`, e);
        }
    }
}

// ============================================================================
// GUNLUK OTOMATIK YEDEK (Madde 4)
// ============================================================================
// Tek bir hatali islem (yanlis toplu silme, bozuk bir kayit, kotu bir migrasyon)
// tum guild verisini ucurabilir. Bu gorev her gun bir kez GuildData'nin tam
// kopyasini Backups/YYYY-MM-DD altina yazar ve 30 gunden eski olanlari siler.
//
// Her dakika cagriliyor ama gunde yalnizca BIR kez is yapiyor: o gunun yedegi
// zaten varsa hemen cikiyor (tek kucuk bir kontrol istegi).
const BACKUP_RETENTION_DAYS = 30;

async function runDailyBackup(env) {
    try {
        // Gun siniri Turkiye saatine gore belirleniyor.
        const trNow = new Date(Date.now() + TR_OFFSET_MS);
        const today = trNow.toISOString().slice(0, 10); // YYYY-MM-DD

        // Bugunun yedegi var mi? shallow=true sadece varligi kontrol eder,
        // tum veriyi indirmez.
        const checkUrl = fb(env, `Backups/${today}/savedAt`);
        const checkRes = await fetch(checkUrl);
        const existing = await checkRes.json();
        if (existing) return; // bugun zaten yedeklenmis

        const dataRes = await fetch(fb(env, `GuildData`));
        if (!dataRes.ok) {
            console.error('[backup] GuildData okunamadi:', dataRes.status);
            return;
        }
        const guildData = await dataRes.json();
        if (!guildData) {
            console.log('[backup] GuildData bos, yedek alinmadi.');
            return;
        }

        const putRes = await fetch(fb(env, `Backups/${today}`), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ savedAt: Date.now(), data: guildData })
        });

        if (!putRes.ok) {
            console.error('[backup] Yedek yazilamadi:', putRes.status, await putRes.text());
            return;
        }
        console.log(`[backup] ${today} yedegi alindi.`);

        // --- Eski yedekleri temizle --------------------------------------
        // shallow=true: sadece tarih anahtarlarini getirir, iceriklerini degil.
        const listUrl = fb(env, `Backups`) + (fb(env, `Backups`).includes('?') ? '&' : '?') + 'shallow=true';
        const listRes = await fetch(listUrl);
        const keys = await listRes.json();
        if (!keys) return;

        const cutoff = new Date(trNow.getTime() - BACKUP_RETENTION_DAYS * 86400000)
            .toISOString().slice(0, 10);

        for (const key of Object.keys(keys)) {
            if (key < cutoff) {
                await fetch(fb(env, `Backups/${key}`), { method: 'DELETE' })
                    .catch(e => console.error(`[backup] ${key} silinemedi:`, e));
            }
        }
    } catch (e) {
        console.error('runDailyBackup genel hata:', e);
    }
}

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
