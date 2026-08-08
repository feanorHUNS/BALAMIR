// Discord Developer Portal'daki "Interactions Endpoint URL" bu adresi göstermelidir.
// Discord, biri bir butona her bastığında BU adrese istek atar.
// Adres: https://SITEN.workers.dev/api/discord-interactions

import { verifyKey, InteractionType, InteractionResponseType } from 'discord-interactions';
import { buildAnnouncementEmbed, buildRsvpComponents } from '../_embedHelper.js';
import { fb } from '../_auth.js';
import { handleSlashCommand } from '../_botCommands.js';

// ============================================================================
// ÖNEMLİ MİMARİ NOTU — DISCORD'UN 3 SANİYE KURALI
// ============================================================================
// Discord, bir butona basıldığında BİZDEN 3 SANİYE İÇİNDE yanıt bekler. Yanıt
// gecikirse kullanıcıya "Uygulama zamanında yanıt vermedi" hatası gösterir —
// işlem arka planda başarılı olsa bile.
//
// Bu uç, oy kaydetmek için Firebase'e birden fazla istek yapıyor (duyuru,
// kullanıcı eşleştirmesi, oyuncu listesi, yazma). Bunların toplamı 3 saniyeyi
// rahatlıkla aşabiliyor.
//
// ÇÖZÜM: İki aşamalı yanıt.
//   1) Discord'a ANINDA "aldım, güncelliyorum" (DEFERRED_UPDATE_MESSAGE) dön.
//      Bu, kullanıcıya hiçbir hata göstermez ve mesajı olduğu gibi bırakır.
//   2) Asıl işi ctx.waitUntil() ile ARKA PLANDA yap, bitince mesajı Discord'un
//      "orijinal yanıtı düzenle" ucuyla güncelle.
//
// Böylece kullanıcı butona bastığında yanıt ~50 ms'de dönüyor, embed ise
// hemen ardından güncelleniyor.
// ============================================================================

export async function onRequestPost(context) {
    const { request, env, ctx } = context;

    const signature = request.headers.get('x-signature-ed25519');
    const timestamp = request.headers.get('x-signature-timestamp');
    const bodyBuffer = await request.clone().arrayBuffer();

    // 1) Güvenlik: Bu isteğin gerçekten Discord'dan geldiğini doğrula.
    if (!signature || !timestamp) {
        return new Response('Missing signature headers', { status: 401 });
    }
    const isValid = await verifyKey(bodyBuffer, signature, timestamp, env.DISCORD_PUBLIC_KEY);
    if (!isValid) {
        return new Response('Invalid request signature', { status: 401 });
    }

    const interaction = JSON.parse(new TextDecoder().decode(bodyBuffer));

    // 2) Discord'un ilk bağlantı testi (handshake).
    if (interaction.type === InteractionType.PING) {
        return jsonResponse({ type: InteractionResponseType.PONG });
    }

    // 3) Butona tıklama.
    if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
        // Asıl işi arka plana al. ctx varsa waitUntil ile (Worker isteği
        // kapatsa bile iş sürer); yoksa güvenli tarafta kalıp bekleyerek yap.
        if (ctx && typeof ctx.waitUntil === 'function') {
            ctx.waitUntil(processRsvp(interaction, env));
        } else {
            await processRsvp(interaction, env);
        }

        // Discord'a anında yanıt: "aldım". Mesaj birazdan arka planda güncellenecek.
        return jsonResponse({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });
    }

    // 4) Slash komutu (/hi, /dkp, /match).
    //    Buton akisiyla AYNI mantik: once "dusunuyorum" de, isi arka planda yap.
    //    Yanit EPHEMERAL (flags: 64) — yalnizca komutu yazan gorur; /hi ise
    //    herkesin gormesi icin asagida flags'siz gonderilir.
    if (interaction.type === InteractionType.APPLICATION_COMMAND) {
        const isPublic = interaction.data && interaction.data.name === 'hi';
        if (ctx && typeof ctx.waitUntil === 'function') {
            ctx.waitUntil(handleSlashCommand(interaction, env));
        } else {
            await handleSlashCommand(interaction, env);
        }
        return jsonResponse({
            type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
            data: isPublic ? {} : { flags: 64 }
        });
    }

    return new Response('Unhandled interaction type', { status: 400 });
}

/**
 * RSVP oyunu kaydeder ve Discord mesajını günceller. Arka planda çalışır,
 * bu yüzden burada süre kısıtı yok — istediği kadar Firebase isteği yapabilir.
 */
async function processRsvp(interaction, env) {
    try {
        const customId = interaction.data.custom_id; // rsvp_accept_ann_123 gibi
        const underscoreParts = customId.split('_');
        const choice = underscoreParts[1]; // accept | decline | tentative
        const annId = underscoreParts.slice(2).join('_');

        const user = (interaction.member && interaction.member.user) || interaction.user;
        const userId = user.id;
        const discordUsername = user.username;
        const serverNickname = (interaction.member && interaction.member.nick) || null;
        const fallbackName = serverNickname || user.global_name || user.username;

        const [annRes, , linkedIdRes] = await Promise.all([
            fetch(fb(env, `Announcements/${annId}`)),
            // Kullanıcı adı + sunucu nicki her etkileşimde güncellenir.
            fetch(fb(env, `DiscordUsers/${userId}`), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: discordUsername,
                    nickname: serverNickname || discordUsername,
                    lastSeen: Date.now()
                })
            }),
            // Bu Discord kullanıcısı sitede bir karaktere bağlanmış mı?
            fetch(fb(env, `GuildData/discordLinks/${userId}`))
        ]);

        const ann = await annRes.json();

        // Duyuru artık aktif değilse sessizce çık.
        if (!ann || ann.finalized) return;

        // Eşleştirme varsa site karakterinin adını kullan (örn. Discord'da
        // "kolirtu" -> sitede "Restital"). Oyuncu listesi yalnızca gerçekten
        // bir eşleşme varsa indiriliyor — gereksiz yere büyük veri çekilmesin.
        let displayName = fallbackName;
        try {
            const linkedPlayerId = await linkedIdRes.json();
            if (linkedPlayerId !== null && linkedPlayerId !== undefined) {
                const playersRes = await fetch(fb(env, `GuildData/players`));
                const playersRaw = await playersRes.json();
                const playersArr = Array.isArray(playersRaw) ? playersRaw : Object.values(playersRaw || {});
                const linked = playersArr.find(p => p && String(p.id) === String(linkedPlayerId));
                if (linked && linked.name) displayName = linked.name;
            }
        } catch (e) {
            console.error('discordLinks çözümleme hatası (fallback isim kullanılacak):', e);
        }

        // Atomik çoklu-yol yazma: yalnızca bu kullanıcının kendi anahtarlarına
        // dokunuyoruz, böylece aynı anda tıklayanlar birbirini ezemez.
        const multiPathUpdate = {};
        multiPathUpdate[`Announcements/${annId}/accepted/${userId}`]  = choice === 'accept'    ? displayName : null;
        multiPathUpdate[`Announcements/${annId}/declined/${userId}`]  = choice === 'decline'   ? displayName : null;
        multiPathUpdate[`Announcements/${annId}/tentative/${userId}`] = choice === 'tentative' ? displayName : null;

        await fetch(fb(env, ``), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(multiPathUpdate)
        });

        // En güncel tam listeyi almak için yazmadan SONRA tazeden oku.
        const freshRes = await fetch(fb(env, `Announcements/${annId}`));
        const freshAnn = await freshRes.json();
        if (!freshAnn) return;

        const embed = buildAnnouncementEmbed(freshAnn);
        const components = buildRsvpComponents(annId, false);

        // Ertelenmiş yanıtı tamamla: orijinal mesajı düzenle.
        // Bu uç bot token'ı İSTEMEZ; interaction token'ı yeterlidir.
        const editUrl = `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;
        const editRes = await fetch(editUrl, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ embeds: [embed], components })
        });

        if (!editRes.ok) {
            console.error('RSVP mesaj güncelleme hatası:', editRes.status, await editRes.text());
        }
    } catch (e) {
        console.error('processRsvp error:', e);
    }
}

function jsonResponse(body) {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
    });
}
