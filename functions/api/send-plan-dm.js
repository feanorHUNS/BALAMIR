// ============================================================================
// RAID DOMINION — KISIYE OZEL DM  (/api/send-plan-dm)
// ============================================================================
// Raid Dominion kadrosu HICBIR KANALA gonderilmez. Bunun yerine kadrodaki her
// eslestirilmis kisiye bot ozel mesaj atar; herkes yalnizca KENDI rolunu,
// sinifini ve grubunu gorur. Boylece kadro Discord'da sizdirilamaz.
//
// Istek (JSON):
// {
//   planTitle, planTime, note,
//   recipients: [{ discordUid, characterName, role, className, group }]
// }
//
// Yanit: her alici icin { ok, reason } listesi -- site bunu kadro altinda
// "ulasti / ulasmadi" olarak gosterir.

import { buildPortalEmbed, PORTAL_URL } from '../_embedHelper.js';

// Discord hata kodlarini kullanicinin anlayacagi sebeplere cevirir.
function reasonFor(status, code) {
    if (code === 50007) return 'dm_closed';        // "Cannot send messages to this user"
    if (status === 403)  return 'forbidden';       // ortak sunucu yok / engellenmis
    if (status === 404)  return 'unknown_user';    // kullanici bulunamadi
    if (status === 429)  return 'rate_limited';
    return 'error';
}

export async function onRequestPost(context) {
    const { request, env } = context;

    let payload;
    try { payload = await request.json(); } catch (e) { return new Response('Invalid JSON', { status: 400 }); }

    const { planTitle, planTime, note, recipients } = payload;
    if (!Array.isArray(recipients) || recipients.length === 0) {
        return new Response('En az bir alici gereklidir (recipients).', { status: 400 });
    }
    if (recipients.length > 60) {
        return new Response('Cok fazla alici.', { status: 400 });
    }

    const results = [];

    for (const r of recipients) {
        const uid = r && r.discordUid;
        if (!uid) {
            results.push({ characterName: (r && r.characterName) || '?', ok: false, reason: 'not_linked' });
            continue;
        }

        try {
            // 1) Kullaniciyla DM kanali ac. Bot ile ortak sunucuda olmasi yeterli,
            //    ayri bir izin gerekmiyor.
            const chRes = await fetch('https://discord.com/api/v10/users/@me/channels', {
                method: 'POST',
                headers: { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ recipient_id: String(uid) })
            });

            if (!chRes.ok) {
                let code = null;
                try { code = (await chRes.json()).code; } catch (e) { /* govde okunamadi */ }
                results.push({ characterName: r.characterName, discordUid: uid, ok: false, reason: reasonFor(chRes.status, code) });
                continue;
            }

            const dmChannel = await chRes.json();

            // 2) Kisiye ozel bilgilendirme.
            const fields = [];
            if (r.characterName) fields.push({ name: 'Character', value: String(r.characterName), inline: true });
            if (r.role)         fields.push({ name: 'Role',      value: String(r.role),      inline: true });
            if (r.className)    fields.push({ name: 'Class',     value: String(r.className), inline: true });
            if (r.group)        fields.push({ name: 'Group',     value: String(r.group),     inline: true });

            const unixTime = planTime ? Math.floor(new Date(planTime).getTime() / 1000) : null;
            if (unixTime && !isNaN(unixTime)) {
                fields.push({ name: 'Time', value: `<t:${unixTime}:F>\n<t:${unixTime}:R>`, inline: false });
            }
            if (note) {
                fields.push({ name: 'Raid Leader Note', value: String(note).slice(0, 1024), inline: false });
            }

            const embed = {
                title: `⚔️ ${planTitle || 'Raid Dominion'}`,
                description: 'This is your personal assignment. Do not share it — the full roster is intentionally private.',
                color: 0xf59e0b,
                fields,
                url: PORTAL_URL,
                footer: { text: 'HUNS Guild Portal' },
                timestamp: new Date().toISOString()
            };

            const msgRes = await fetch(`https://discord.com/api/v10/channels/${dmChannel.id}/messages`, {
                method: 'POST',
                headers: { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ embeds: [embed, buildPortalEmbed()] })
            });

            if (msgRes.ok) {
                results.push({ characterName: r.characterName, discordUid: uid, ok: true });
            } else {
                let code = null;
                try { code = (await msgRes.json()).code; } catch (e) { /* govde okunamadi */ }
                results.push({ characterName: r.characterName, discordUid: uid, ok: false, reason: reasonFor(msgRes.status, code) });
            }
        } catch (e) {
            console.error(`[plan-dm] ${r.characterName} icin hata:`, e);
            results.push({ characterName: r.characterName, discordUid: uid, ok: false, reason: 'error' });
        }

        // Discord oran limitine takilmamak icin araya kisa bir bekleme.
        await new Promise(res => setTimeout(res, 350));
    }

    const sent = results.filter(x => x.ok).length;
    return new Response(JSON.stringify({ success: true, sent, total: results.length, results }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
    });
}

// ============================================================================
// RSVP HATIRLATMASI  (Madde 60)
// ============================================================================
// Duyuruya henuz oy vermemis kisilere ozel mesaj gonderir. worker.js icindeki
// cron gorevi tarafindan cagrilir.
export async function sendDmToUser(env, discordUid, embed) {
    try {
        const chRes = await fetch('https://discord.com/api/v10/users/@me/channels', {
            method: 'POST',
            headers: { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ recipient_id: String(discordUid) })
        });
        if (!chRes.ok) {
            let code = null;
            try { code = (await chRes.json()).code; } catch (e) { /* govde okunamadi */ }
            return { ok: false, reason: reasonFor(chRes.status, code) };
        }
        const ch = await chRes.json();
        const msgRes = await fetch(`https://discord.com/api/v10/channels/${ch.id}/messages`, {
            method: 'POST',
            headers: { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ embeds: [embed, buildPortalEmbed()] })
        });
        if (!msgRes.ok) {
            let code = null;
            try { code = (await msgRes.json()).code; } catch (e) { /* govde okunamadi */ }
            return { ok: false, reason: reasonFor(msgRes.status, code) };
        }
        return { ok: true };
    } catch (e) {
        console.error('sendDmToUser error:', e);
        return { ok: false, reason: 'error' };
    }
}

// ============================================================================
// BASVURU SONUC BILDIRIMI  (Madde 72)
// ============================================================================
// Yetkili onay/red kararini verirken YAZDIGI mesaji adaya DM ile gonderir.
// Ayri bir uc yerine bu dosyada duruyor cunku ayni DM altyapisini kullaniyor.
export async function onRequestPostDecision(context) {
    const { request, env } = context;

    let payload;
    try { payload = await request.json(); } catch (e) { return new Response('Invalid JSON', { status: 400 }); }

    const { discordUid, approved, message, guildName } = payload;
    if (!discordUid) return new Response('discordUid zorunludur.', { status: 400 });

    const embed = {
        title: approved ? '✅ Application Approved' : '❌ Application Rejected',
        description: (message && String(message).slice(0, 2000)) ||
            (approved
                ? 'Your guild application has been approved. Welcome!'
                : 'Your guild application was not approved this time.'),
        color: approved ? 0x10b981 : 0xef4444,
        footer: { text: guildName || 'HUNS Guild Portal' },
        timestamp: new Date().toISOString()
    };

    const r = await sendDmToUser(env, discordUid, embed);
    return new Response(JSON.stringify({ success: r.ok, reason: r.reason || null }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
    });
}
