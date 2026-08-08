// ============================================================================
// BOT KOMUT YONETIMI  (/api/bot-commands)
// ============================================================================
//   POST { action: 'register' }                    -> komutlari Discord'a kaydet (admin)
//   POST { action: 'decide', id, decision }        -> /match istegini onayla/reddet (yetkili)
//
// NEDEN SUNUCU TARAFI: Komut kaydi bot token'i ister (istemciye asla verilmez).
// /match kararlari ise oyuncu listesini ve eslestirmeleri degistirdigi icin
// dogrulanmis bir yetkili tarafindan, sunucu anahtariyla yazilmalidir.

import { fb } from '../_auth.js';

const COMMANDS = [
    {
        name: 'hi',
        description: 'Say hello to the bot · Bota selam ver',
        type: 1
    },
    {
        name: 'dkp',
        description: 'Show the DKP of your linked character · Bağlı karakterinin DKP\'sini gösterir',
        type: 1
    },
    {
        name: 'match',
        description: 'Link your Discord account to a character · Discord hesabını bir karaktere bağla',
        type: 1,
        options: [{
            name: 'nick',
            description: 'Your in-game character name · Oyun içi karakter adın',
            type: 3,          // STRING
            required: true
        }]
    }
];

export async function onRequestPost(context) {
    const { request, env, auth } = context;

    let payload;
    try { payload = await request.json(); } catch (e) { return json({ error: 'Invalid JSON' }, 400); }
    const action = String(payload.action || '');

    // ------------------------------------------------------------- teshis
    // Komutlar Discord'da gorunmuyorsa sorunun NEREDE oldugunu soyler:
    // degisken eksik mi, bot sunucuda mi, komutlar kayitli mi.
    if (action === 'diagnose') {
        if (auth.role !== 'admin') return json({ error: 'Yalnizca admin.' }, 403);
        const appId = env.DISCORD_APPLICATION_ID || env.DISCORD_APP_ID || '';
        const gid = env.DISCORD_GUILD_ID || '';
        const out = {
            applicationIdSet: !!appId && !/BURAYA/i.test(appId),
            applicationIdLooksValid: /^[0-9]{15,25}$/.test(appId),
            guildIdSet: !!gid,
            uploadChannelSet: !!(env.DISCORD_UPLOAD_CHANNEL_ID && !/BURAYA/i.test(env.DISCORD_UPLOAD_CHANNEL_ID)),
            botTokenSet: !!env.DISCORD_BOT_TOKEN,
            publicKeySet: !!env.DISCORD_PUBLIC_KEY,
            registered: null,
            error: null
        };
        if (out.applicationIdLooksValid && gid) {
            try {
                const r = await fetch(`https://discord.com/api/v10/applications/${appId}/guilds/${gid}/commands`,
                    { headers: { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}` } });
                const body = await r.text();
                if (r.ok) {
                    const arr = JSON.parse(body);
                    out.registered = Array.isArray(arr) ? arr.map(c => c.name) : [];
                } else {
                    out.error = `${r.status}: ${body.slice(0, 200)}`;
                    if (body.includes('50001')) out.error += ' | Bot "applications.commands" izniyle davet edilmemis.';
                    if (r.status === 401) out.error += ' | Bot token yanlis ya da Application ID bota ait degil.';
                }
            } catch (e) {
                out.error = String(e && e.message ? e.message : e);
            }
        }
        return json(out);
    }

    // ---------------------------------------------------------------- kaydet
    if (action === 'register') {
        if (auth.role !== 'admin') return json({ error: 'Yalnizca admin.' }, 403);
        const appId = env.DISCORD_APPLICATION_ID || env.DISCORD_APP_ID;
        if (!appId || /BURAYA/i.test(appId)) {
            return json({ error: 'DISCORD_APPLICATION_ID tanimli degil. wrangler.jsonc icindeki "BURAYA_APPLICATION_ID_YAZ" yerine Developer Portal > General Information > Application ID degerini yazip yeniden deploy et.' }, 400);
        }
        if (!/^[0-9]{15,25}$/.test(String(appId))) {
            return json({ error: `DISCORD_APPLICATION_ID gecersiz gorunuyor ("${String(appId).slice(0, 30)}"). Yalnizca rakamlardan olusmali.` }, 400);
        }

        // Sunucuya ozel kayit ANINDA aktif olur; global kayit ~1 saat surer.
        const gid = env.DISCORD_GUILD_ID;
        const url = gid
            ? `https://discord.com/api/v10/applications/${appId}/guilds/${gid}/commands`
            : `https://discord.com/api/v10/applications/${appId}/commands`;

        const res = await fetch(url, {
            method: 'PUT',
            headers: {
                'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(COMMANDS)
        });
        const body = await res.text();
        if (!res.ok) {
            console.error('[bot-commands] kayit hatasi:', res.status, body);
            // 50001 Missing Access: bot sunucuya "applications.commands" izni
            // OLMADAN davet edilmis demektir; komutlar bu izin verilmeden
            // hicbir sekilde gorunmez.
            const hint = body.includes('50001')
                ? ' — Bot sunucuya "applications.commands" izniyle davet edilmemis. Developer Portal > OAuth2 > URL Generator ile bot + applications.commands secip botu YENIDEN davet et.'
                : '';
            return json({ error: `Discord reddetti (${res.status}): ${body.slice(0, 250)}${hint}` }, 502);
        }
        let count = COMMANDS.length;
        try { const arr = JSON.parse(body); if (Array.isArray(arr)) count = arr.length; } catch (e) {}
        console.log(`[bot-commands] ${count} komut kaydedildi (${gid ? 'guild' : 'global'}).`);
        return json({ ok: true, scope: gid ? 'guild' : 'global', count });
    }

    // ------------------------------------------------------- /match karari
    if (action === 'decide') {
        // Yetkili (officer+) karar verebilir — rota minRole zaten officer.
        const id = String(payload.id || '');
        const decision = payload.decision === 'approve' ? 'approve' : 'reject';
        if (!/^mr_[0-9]+_[0-9]+$/.test(id)) return json({ error: 'Gecersiz istek kimligi.' }, 400);

        const reqRes = await fetch(fb(env, `MatchRequests/${id}`));
        const req = await reqRes.json();
        if (!req || req.status !== 'pending') return json({ error: 'Istek bulunamadi ya da zaten karara baglanmis.' }, 404);

        if (decision === 'reject') {
            await fetch(fb(env, `MatchRequests/${id}`), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'rejected', decidedBy: auth.name || auth.uid, decidedAt: Date.now() })
            });
            await notifyUser(env, req.discordId,
                `❌ Your character link request (**${req.nick}**) was rejected by an officer.\n` +
                `❌ Karakter eşleştirme isteğin (**${req.nick}**) yetkili tarafından reddedildi.`);
            return json({ ok: true, decision });
        }

        // --- ONAY: oyuncu listesini oku, isleme gore degistir ---------------
        const playersRes = await fetch(fb(env, 'GuildData/players'));
        const raw = await playersRes.json();
        const players = Array.isArray(raw) ? raw.filter(Boolean) : Object.values(raw || {}).filter(Boolean);

        let linkedPlayerId = null;

        if (req.action === 'rename') {
            const p = players.find(x => String(x.id) === String(req.targetPlayerId));
            if (!p) return json({ error: 'Hedef karakter bulunamadi.' }, 404);
            p.name = req.nick;
            linkedPlayerId = String(p.id);
        } else if (req.action === 'link') {
            const p = players.find(x => String(x.id) === String(req.targetPlayerId));
            if (!p) return json({ error: 'Hedef karakter bulunamadi.' }, 404);
            linkedPlayerId = String(p.id);
        } else {
            // create — YENI karakter. Ayni isim bu arada olusmus olabilir; tekrar bak.
            const dup = players.find(x => String(x.name).toLowerCase() === String(req.nick).toLowerCase() && !x.isDeleted);
            if (dup) {
                linkedPlayerId = String(dup.id);
            } else {
                const newId = Date.now();
                players.push({
                    id: newId, name: req.nick, role: 'DPS', dkp: 0,
                    inRaid: false, rollTicket: false, arti: 0, dragon: 0,
                    totalArti: 0, totalDragon: 0, hasPenaltyMark: false,
                    sessionAddCount: 0, sessionSubCount: 0, isDeleted: false, customTitle: ''
                });
                linkedPlayerId = String(newId);
            }
        }

        // Oyuncu listesi ve eslestirme TEK atomik yazmada guncellenir.
        const update = {
            'GuildData/players': players,
            [`GuildData/discordLinks/${req.discordId}`]: linkedPlayerId,
            [`MatchRequests/${id}/status`]: 'approved',
            [`MatchRequests/${id}/decidedBy`]: auth.name || auth.uid,
            [`MatchRequests/${id}/decidedAt`]: Date.now()
        };
        const wr = await fetch(fb(env, ''), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(update)
        });
        if (!wr.ok) {
            console.error('[bot-commands] yazma hatasi:', wr.status);
            return json({ error: 'Kaydedilemedi.' }, 502);
        }

        await notifyUser(env, req.discordId,
            `✅ Your character link request was approved. You are now linked to **${req.nick}**.\n` +
            `✅ Karakter eşleştirme isteğin onaylandı. Artık **${req.nick}** karakterine bağlısın.`);

        return json({ ok: true, decision, playerId: linkedPlayerId });
    }

    return json({ error: 'Bilinmeyen islem.' }, 400);
}

/** Karar sonucunu kisiye DM ile bildirir (basarisiz olsa da akisi bozmaz). */
async function notifyUser(env, discordId, content) {
    try {
        const dmRes = await fetch('https://discord.com/api/v10/users/@me/channels', {
            method: 'POST',
            headers: { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ recipient_id: String(discordId) })
        });
        if (!dmRes.ok) return;
        const ch = await dmRes.json();
        await fetch(`https://discord.com/api/v10/channels/${ch.id}/messages`, {
            method: 'POST',
            headers: { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ content })
        });
    } catch (e) {
        console.error('[bot-commands] DM bildirimi gonderilemedi:', e);
    }
}

function json(obj, status = 200) {
    return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
