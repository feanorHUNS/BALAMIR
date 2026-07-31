// Bu dosya, düz Cloudflare Workers deploy'unun (Pages Functions DEĞİL) TEK giriş noktasıdır.
// Görevi: gelen isteğin kimliğini doğrulamak, doğru fonksiyona yönlendirmek, eşleşen bir
// API adresi yoksa statik dosyaları (index.html vb.) olduğu gibi servis etmek.
//
// ÖNEMLİ: Bu dosya GitHub reponun KÖKÜNDE olmalı (functions/ klasörüyle aynı seviyede).

import { authenticate, hasAtLeast, checkRateLimit, checkIpRateLimit, fb } from './functions/_auth.js';
import { finalizeAnnouncementCore, syncAnnouncementCore, claimLock } from './functions/_announcementTasks.js';
import { buildPortalEmbed } from './functions/_embedHelper.js';
import { onRequestPost as discordInteractions } from './functions/api/discord-interactions.js';
import { onRequestPost as sendAnnouncement } from './functions/api/send-announcement.js';
import { onRequestPost as finalizeAnnouncement } from './functions/api/finalize-announcement.js';
import { onRequestPost as deleteAnnouncement } from './functions/api/delete-announcement.js';
import { onRequestPost as syncAnnouncements } from './functions/api/sync-announcements.js';
import { onRequestPost as sendPlanImage } from './functions/api/send-plan-image.js';
import { onRequestPost as sendPlanReminder } from './functions/api/send-plan-reminder.js';
import { onRequestPost as sendPlanDm, sendDmToUser, onRequestPostDecision as sendAppDecision } from './functions/api/send-plan-dm.js';
import { onRequestPost as linkPreview, buildLinkPreviewEmbedFromText } from './functions/api/link-preview.js';
import { onRequestPost as guildWrite } from './functions/api/guild-write.js';
import { onRequestPost as auditLog } from './functions/api/audit-log.js';

// ============================================================================
// ADRES TABLOSU  (Madde 25 + 27)
// ============================================================================
// public   : true  -> kimlik doğrulaması ARANMAZ. Yalnızca Discord'un kendi imzasıyla
//                     doğrulanan uç için geçerli (Discord bize token gönderemez).
// minRole  : bu işlemi yapabilmek için gereken en düşük rol.
// limit / windowMs : hız sınırı (kullanıcı başına, kayan pencere).
const ROUTES = {
    '/api/discord-interactions':  { handler: discordInteractions,  public: true },

    // A2 DUZELTMESI: Bu uclarin hepsi 'member' seviyesindeydi. Bir uye tek
    // istekle bota istedigi kanala, istedigi metni @everyone ile attirabilir
    // ya da tum duyurulari silebilirdi. Hepsi 'officer' seviyesine cikarildi.
    '/api/send-announcement':     { handler: sendAnnouncement,     minRole: 'officer', limit: 5,  windowMs: 600000 },
    '/api/finalize-announcement': { handler: finalizeAnnouncement, minRole: 'officer', limit: 30, windowMs: 600000 },
    '/api/delete-announcement':   { handler: deleteAnnouncement,   minRole: 'officer', limit: 30, windowMs: 600000 },
    '/api/sync-announcements':    { handler: syncAnnouncements,    minRole: 'officer', limit: 90, windowMs: 600000 },
    '/api/send-plan-image':       { handler: sendPlanImage,        minRole: 'officer', limit: 10, windowMs: 600000 },
    '/api/send-plan-reminder':    { handler: sendPlanReminder,     minRole: 'officer', limit: 25, windowMs: 600000 },
    // Raid Dominion kisiye ozel DM: her cagri onlarca DM gonderdigi icin
    // limit bilerek dusuk tutuldu.
    '/api/send-plan-dm':          { handler: sendPlanDm,          minRole: 'officer', limit: 8,  windowMs: 600000 },
    // Madde 72: Basvuru onay/red bildirimi
    '/api/send-app-decision':     { handler: sendAppDecision,     minRole: 'officer', limit: 40, windowMs: 600000 },
    // Link onizleme: bot mesajlarindaki baglantilar icin OG etiketi okur
    '/api/link-preview':          { handler: linkPreview,         minRole: 'member',  limit: 60, windowMs: 600000 },

    // MADDE 111: Istemci artik Firebase'e DOGRUDAN yazmiyor. Tum guild verisi
    // ve denetim kaydi bu uclardan, sunucu dogrulamasindan gecerek yaziliyor.
    '/api/guild-write':           { handler: guildWrite,          minRole: 'officer', limit: 300, windowMs: 600000 },
    '/api/audit-log':             { handler: auditLog,            minRole: 'officer', limit: 300, windowMs: 600000 }
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

                // --- 3) Hiz siniri: hem kullanici hem IP -----------------------
                // A7: Yalnizca kullanici basina sinir, ikinci bir hesap acilarak
                // atlatilabiliyordu. IP kotasi bunu zorlastiriyor. IP siniri
                // bilincli olarak daha genis: ayni evden baglanan iki uye
                // birbirini engellemesin.
                if (route.limit) {
                    const rl = await checkRateLimit(env, auth.uid, url.pathname, route.limit, route.windowMs);
                    if (!rl.ok) return rl.response;

                    const ipRl = await checkIpRateLimit(request, env, url.pathname, route.limit * 3, route.windowMs);
                    if (!ipRl.ok) return ipRl.response;
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

            // Gonderilen hatirlatmalarin kimlikleri bagli duyuruya yazilir;
            // temizlik gorevi 2 saat sonra bu mesajlari siler.
            const recordReminder = async (slot, sent) => {
                if (!plan.linkedAnnId || !sent.length) return;
                const patch = {};
                sent.forEach((x, i) => { patch[`${slot}_${i}`] = x.messageId; });
                await fetch(fb(env, `Announcements/${plan.linkedAnnId}/reminderMsgIds`), {
                    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(patch)
                }).catch(e => console.error('[automation] hatirlatma kimligi yazilamadi:', e));
            };

            // 30 dakika kala
            if (now >= planTime - 30 * 60000 && now < planTime - 15 * 60000 && !plan.reminded30) {
                if (await claimLock(env, `${plan.id}_30`)) {
                    const _sent30 = await sendReminder(env, channelIds,
                        `@everyone ⏳ **30 minutes** until **${plan.title || 'Event'}** starts!\n⏳ **${plan.title || 'Event'}** başlamasına **30 dakika** kaldı!`);
                    await recordReminder('r30', _sent30);
                    plan.reminded30 = true; plansChanged = true;
                }
            }

            // 15 dakika kala
            if (now >= planTime - 15 * 60000 && now < planTime && !plan.reminded15) {
                if (await claimLock(env, `${plan.id}_15`)) {
                    const _sent15 = await sendReminder(env, channelIds,
                        `@everyone ⚠️ **15 minutes** until **${plan.title || 'Event'}**! Finish your preparations.\n⚠️ **${plan.title || 'Event'}** başlamasına **15 dakika** kaldı! Hazırlıklarınızı tamamlayın.`);
                    await recordReminder('r15', _sent15);
                    plan.reminded15 = true; plansChanged = true;
                }
            }

            // Baslama ani
            if (now >= planTime && now < planTime + 60 * 60000 && !plan.reminded0) {
                if (await claimLock(env, `${plan.id}_0`)) {
                    // Motive edici cumle bilerek TEK DIL (Ingilizce) birakiliyor --
                    // guild sloganı olarak tek bir bicimde kalmasi isteniyor.
                    const _sent0 = await sendReminder(env, channelIds,
                        `@everyone 🔥 **${plan.title || 'Event'}** is STARTING!\n🔥 **${plan.title || 'Event'}** BAŞLIYOR!\n\n*${motivMsg}*`);
                    await recordReminder('r0', _sent0);
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
        // --- 3) RSVP hatirlatmalari (Madde 60) --------------------------
        await runRsvpReminders(env, announcements, guildData, now);

        // --- 4) Temizlik: etkinlikten 2 saat sonra her seyi sil ----------
        await runPostEventCleanup(env, announcements, guildData, now);
    } catch (e) {
        console.error('runTimeBasedAutomation genel hata:', e);
    }
}

// ============================================================================
// ETKINLIK SONRASI TEMIZLIK
// ============================================================================
// Etkinlik saatinin uzerinden 2 saat gectiginde:
//   - Duyuru mesaji Discord'dan silinir
//   - Bota ait 3 otomatik mesaj (30dk / 15dk / baslangic hatirlatmasi ve
//     tesekkur mesaji) silinir
//   - Bagli raid plani siteden kaldirilir
//   - Duyuru kaydi siteden kaldirilir
//
// Boylece kanal her hafta temiz kalir, eski kadrolar ortalikta durmaz.
const CLEANUP_AFTER_HOURS = 2;

async function runPostEventCleanup(env, announcements, guildData, now) {
    if (!announcements) return;

    const cutoffMs = CLEANUP_AFTER_HOURS * 3600000;
    const plans = (guildData && Array.isArray(guildData.raidPlans)) ? guildData.raidPlans : [];
    let plansChanged = false;
    let remainingPlans = plans.slice();

    for (const [annId, ann] of Object.entries(announcements)) {
        if (!ann || !ann.time) continue;
        const annTime = new Date(ann.time).getTime();
        if (isNaN(annTime) || now < annTime + cutoffMs) continue;

        if (!(await claimLock(env, `${annId}_cleanup`))) continue;
        console.log(`[cleanup] ${annId}: etkinlikten ${CLEANUP_AFTER_HOURS} saat gecti, temizleniyor.`);

        // 1) Bota ait otomatik mesajlari sil (hatirlatmalar + tesekkur).
        const botMsgIds = []
            .concat(Object.values(ann.reminderMsgIds || {}))
            .concat(ann.thanksMsgId ? [ann.thanksMsgId] : []);
        for (const msgId of botMsgIds) {
            try {
                await fetch(`https://discord.com/api/v10/channels/${ann.channelId}/messages/${msgId}`, {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}` }
                });
            } catch (e) { console.error(`[cleanup] bot mesaji ${msgId} silinemedi:`, e); }
        }

        // 2) Duyuru mesajini sil.
        if (ann.channelId && ann.messageId) {
            try {
                await fetch(`https://discord.com/api/v10/channels/${ann.channelId}/messages/${ann.messageId}`, {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}` }
                });
            } catch (e) { console.error('[cleanup] duyuru mesaji silinemedi:', e); }
        }

        // 3) Bagli raid planini siteden kaldir.
        const before = remainingPlans.length;
        remainingPlans = remainingPlans.filter(p => !(p && String(p.linkedAnnId) === String(annId)));
        if (remainingPlans.length !== before) plansChanged = true;

        // 4) Duyuru kaydini siteden kaldir.
        await fetch(fb(env, `Announcements/${annId}`), { method: 'DELETE' })
            .catch(e => console.error('[cleanup] duyuru kaydi silinemedi:', e));
    }

    if (plansChanged) {
        await fetch(fb(env, `GuildData/raidPlans`), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(remainingPlans)
        }).catch(e => console.error('[cleanup] raidPlans yazilamadi:', e));
    }
}

// ============================================================================
// RSVP HATIRLATMASI (Madde 60)
// ============================================================================
// Duyuruya henuz OY VERMEMIS kisilere, etkinlik saatine belirli sureler kala
// ozel mesaj gonderir. Yonetim sayfasindan:
//   - kac saat kala gonderilecegi (3 ayri zaman)
//   - mesaj metni
// ayarlanabilir.
//
// "Oy vermemis" = accepted / declined / tentative listelerinin hicbirinde yok.
// Kime gonderilecegi DiscordUsers'tan degil, siteyle ESLESTIRILMIS kisilerden
// belirlenir -- boylece guild disindan kimseye mesaj gitmez.

const RSVP_DEFAULT_HOURS = [24, 6, 1];

// ============================================================================
// RAID HAFTASI (Persembe -> Persembe)
// ============================================================================
// Allods'ta her karakter haftada YALNIZCA BIR KEZ raide girebiliyor ve haftalik
// sifirlama persembe gunu oluyor. Guild haftada 2-3 raid duyurusu yaptigi icin,
// bu haftaki bir raide ZATEN yazilmis birine "oy vermedin" hatirlatmasi
// gondermek anlamsiz ve rahatsiz edici olur.
//
// Bu fonksiyon, verilen ana ait raid haftasinin baslangicini dondurur; ayni
// hafta icindeki iki duyuru ayni degeri uretir.
function raidWeekStart(utcMs) {
    const tr = new Date(utcMs + TR_OFFSET_MS);
    const daysSinceThursday = (tr.getUTCDay() - 4 + 7) % 7; // 4 = Persembe
    tr.setUTCDate(tr.getUTCDate() - daysSinceThursday);
    tr.setUTCHours(0, 0, 0, 0);
    return tr.getTime() - TR_OFFSET_MS;
}

async function runRsvpReminders(env, announcements, guildData, now) {
    if (!announcements) return;

    const cfg = (guildData && guildData.rsvpReminder) || {};
    if (cfg.enabled === false) return;

    const hours = Array.isArray(cfg.hours) && cfg.hours.length ? cfg.hours : RSVP_DEFAULT_HOURS;
    const links = (guildData && guildData.discordLinks) || {};
    const linkedUids = Object.keys(links);
    if (linkedUids.length === 0) return;

    // --- Kadro plani YAYINLANMIS duyurular ------------------------------
    // Yalnizca bunlar "bu haftaki raidine yazildi" saymak icin kullanilir;
    // henuz plani olmayan bir duyuruya kabul demek kisiyi baglamaz.
    const publishedAnnIds = new Set(
        (guildData && Array.isArray(guildData.raidPlans) ? guildData.raidPlans : [])
            .filter(p => p && p.published && p.linkedAnnId)
            .map(p => String(p.linkedAnnId))
    );

    // --- Hatirlatma almak ISTEMEYENLER (Madde 79) ------------------------
    const optedOutUids = await collectOptedOutDiscordUids(env, links, cfg);

    // Yalnizca SECILI duyurular icin gonderilecekse listeyi daralt.
    const scopeSelected = cfg.scope === 'selected';
    const chosenIds = Array.isArray(cfg.annIds) ? cfg.annIds.map(String) : [];

    for (const [annId, ann] of Object.entries(announcements)) {
        if (!ann || ann.finalized || !ann.time) continue;
        if (scopeSelected && !chosenIds.includes(String(annId))) continue;
        const annTime = new Date(ann.time).getTime();
        if (isNaN(annTime) || annTime <= now) continue;

        const hoursLeft = (annTime - now) / 3600000;

        // Hangi esige denk geliyoruz?
        // Pencere 15 dakika genis tutuluyor: cron bir tur gecikirse ya da
        // Cloudflare bir calistirmayi atlarsa hatirlatma TAMAMEN kacmasin.
        // Ayni esigin tekrar tetiklenmesini asagidaki kilit engelliyor.
        // Pencere dar tutulmazsa da, 2 saat kala olusturulan bir duyuruda
        // 24 ve 6 saatlik esikler geriye donuk tetiklenip spam yapardi.
        const SLOT_WINDOW_HOURS = 0.25;
        let slotIndex = -1;
        for (let i = 0; i < hours.length; i++) {
            const h = Number(hours[i]);
            if (!h || h <= 0) continue;
            if (hoursLeft <= h && hoursLeft > h - SLOT_WINDOW_HOURS) { slotIndex = i; break; }
        }
        if (slotIndex === -1) continue;

        // Bu esik icin daha once gonderildi mi?
        if (!(await claimLock(env, `${annId}_rsvp_${slotIndex}`))) continue;

        const voted = new Set([
            ...Object.keys(ann.accepted || {}),
            ...Object.keys(ann.declined || {}),
            ...Object.keys(ann.tentative || {})
        ]);

        // --- Bu hafta BASKA bir raide zaten yazilmis olanlar --------------
        // Ayni raid haftasindaki, kadro plani yayinlanmis diger duyurularda
        // KABUL demis kisiler bu duyuru icin hatirlatma almaz.
        const thisWeek = raidWeekStart(annTime);
        const committed = new Set();
        for (const [otherId, other] of Object.entries(announcements)) {
            if (otherId === annId || !other || !other.time) continue;
            if (!publishedAnnIds.has(String(otherId))) continue;
            const otherTime = new Date(other.time).getTime();
            if (isNaN(otherTime) || raidWeekStart(otherTime) !== thisWeek) continue;
            Object.keys(other.accepted || {}).forEach(uid => committed.add(uid));
        }

        const targets = linkedUids.filter(uid =>
            !voted.has(uid) && !committed.has(uid) && !optedOutUids.has(uid));

        if (targets.length === 0) {
            console.log(`[rsvp] ${annId}: gonderilecek kimse yok (oy veren ${voted.size}, bu hafta baska raidde ${committed.size}, kapali ${optedOutUids.size}).`);
            continue;
        }

        const unix = Math.floor(annTime / 1000);
        const hLabel = Number(hours[slotIndex]);
        const customText = (cfg.message || '').trim();

        // Duyurunun kendi metnini ALINTILA: kisi neyin hatirlatildigini
        // hatirlamak icin kanala gitmek zorunda kalmasin.
        const quoted = String(ann.content || '').trim().slice(0, 700);
        const acc = Object.keys(ann.accepted || {}).length;
        const dec = Object.keys(ann.declined || {}).length;

        // Duyuru mesajina dogrudan baglanti -- tek tikla butonlara ulasilir.
        const jumpUrl = (ann.channelId && ann.messageId && env.DISCORD_GUILD_ID)
            ? `https://discord.com/channels/${env.DISCORD_GUILD_ID}/${ann.channelId}/${ann.messageId}`
            : null;

        const fields = [
            { name: 'Kalan / Remaining', value: `~${hLabel} saat / hours`, inline: true },
            { name: 'Katılım / Attendance', value: `✅ ${acc}   ❌ ${dec}`, inline: true },
            { name: 'Zaman / Time', value: `<t:${unix}:F>\n<t:${unix}:R>`, inline: false }
        ];
        if (quoted) {
            fields.push({ name: 'Duyuru / Announcement', value: '>>> ' + quoted, inline: false });
        }
        fields.push({
            name: 'Ne yapmalıyım? / What to do?',
            value: jumpUrl
                ? `[Duyuruya git ve oy ver / Go to the announcement and vote](${jumpUrl})`
                : 'Duyuru mesajındaki butonlardan birine basın.\nPress one of the buttons on the announcement message.',
            inline: false
        });

        const embed = {
            title: `⏰ ${ann.title || 'Event'}`,
            description: customText || 'You have not voted for this event yet.\nBu etkinlik için henüz oy vermediniz.',
            color: 0x3b82f6,
            fields: [
                { name: 'Remaining / Kalan', value: `~${hLabel} hours / saat`, inline: true },
                { name: 'Time / Zaman', value: `<t:${unix}:F>\n<t:${unix}:R>`, inline: false },
                { name: 'What to do? / Ne yapmalıyım?', value: 'Press one of the buttons on the announcement message.\nDuyuru mesajındaki butonlardan birine basın.', inline: false }
            ],
            footer: { text: 'HUNS Guild Portal' }
        };

        let sent = 0;
        for (const uid of targets) {
            const r = await sendDmToUser(env, uid, embed);
            if (r.ok) sent++;
            await new Promise(res => setTimeout(res, 350)); // oran limiti
        }
        console.log(`[rsvp] ${annId}: ${hLabel}s kala ${sent}/${targets.length} kisiye gonderildi (bu hafta baska raidde olan ${committed.size} kisi atlandi).`);
    }
}

/**
 * Hatirlatma almak istemeyenlerin Discord kimliklerini toplar (Madde 79).
 *
 * Uye tercihini Roles/{uid}/noRsvpDm altina yazar ve kendi karakter(ler)ini
 * Roles/{uid}/playerIds altinda tutar. Burada bu tercihi Discord kimligine
 * ceviriyoruz: playerId -> discordLinks tersine cevrilerek.
 *
 * Admin bu ozelligi kapattiysa (allowOptOut !== true) tercih YOK SAYILIR.
 */
async function collectOptedOutDiscordUids(env, links, cfg) {
    const out = new Set();
    if (!cfg || cfg.allowOptOut !== true) return out;

    try {
        const rolesRes = await fetch(fb(env, `Roles`));
        const roles = await rolesRes.json();
        if (!roles) return out;

        // playerId -> discordUid ters haritasi
        const playerToDiscord = {};
        Object.entries(links).forEach(([duid, pid]) => { playerToDiscord[String(pid)] = duid; });

        Object.values(roles).forEach(r => {
            if (!r || r.noRsvpDm !== true) return;
            const ids = Array.isArray(r.playerIds) ? r.playerIds : (r.playerId ? [r.playerId] : []);
            ids.forEach(pid => {
                const duid = playerToDiscord[String(pid)];
                if (duid) out.add(duid);
            });
        });
    } catch (e) {
        console.error('collectOptedOutDiscordUids error:', e);
    }
    return out;
}

/**
 * Hatirlatma gonderir ve gonderilen mesajlarin kimliklerini dondurur.
 * Kimlikler duyuru kaydina yazilir; etkinlikten 2 saat sonra bu mesajlar
 * runPostEventCleanup tarafindan silinir.
 */
async function sendReminder(env, channelIds, content) {
    const sentIds = [];
    let previewEmbeds = [];
    try {
        const p = await buildLinkPreviewEmbedFromText(content);
        if (p) previewEmbeds = [p];
    } catch (e) { console.error('[automation] onizleme uretilemedi:', e); }
    for (const channelId of channelIds) {
        try {
            const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
                method: 'POST',
                headers: { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ content, embeds: previewEmbeds.concat([buildPortalEmbed()]), allowed_mentions: { parse: ['everyone'] } })
            });
            if (res.ok) {
                try { const m = await res.json(); if (m && m.id) sentIds.push({ channelId, messageId: m.id }); } catch (e) { /* govde okunamadi */ }
            } else {
                console.error(`[automation] hatirlatma kanal ${channelId} hata ${res.status}: ${await res.text()}`);
            }
        } catch (e) {
            console.error(`[automation] hatirlatma kanal ${channelId} ag hatasi:`, e);
        }
    }
    return sentIds;
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

            // Onizleme bir kez uretilip tum kanallarda kullanilir.
            let previewEmbed = null;
            try { previewEmbed = await buildLinkPreviewEmbedFromText(post.content || ''); }
            catch (e) { console.error('[scheduled] onizleme uretilemedi:', e); }

            for (const channelId of channelIds) {
                try {
                    const body = { content: post.content || '', allowed_mentions: { parse: ['everyone'] } };
                    const embeds = [];
                    if (post.imageUrl) embeds.push({ image: { url: post.imageUrl } });
                    // Metinde baglanti varsa onizlemesini EKLE. Discord bot mesajlarinda
                    // otomatik onizleme uretmeyebiliyor (ozellikle "Embed Links" izni
                    // yoksa), bu yuzden onizlemeyi kendimiz olusturuyoruz.
                    if (previewEmbed) embeds.push(previewEmbed);
                    if (embeds.length) body.embeds = embeds;
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
