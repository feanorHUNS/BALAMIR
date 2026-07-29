// Bu fonksiyon Discord Developer Portal'daki "Interactions Endpoint URL" olarak
// tanımlanmalıdır. Discord, biri bir butona her bastığında BU adrese istek atar.
// Adres: https://SITEN.pages.dev/api/discord-interactions
//
// Cloudflare Pages otomatik routing: functions/api/discord-interactions.js -> /api/discord-interactions

import { verifyKey, InteractionType, InteractionResponseType } from 'discord-interactions';
import { buildAnnouncementEmbed, buildRsvpComponents } from '../_embedHelper.js';
import { fb } from '../_auth.js';

export async function onRequestPost(context) {
    const { request, env } = context;

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

    // 2) Discord'un ilk bağlantı testi (handshake). Bu olmadan Discord,
    // "Interactions Endpoint URL" alanını kaydetmeye izin vermez.
    if (interaction.type === InteractionType.PING) {
        return jsonResponse({ type: InteractionResponseType.PONG });
    }

    // 3) Bir butona tıklandığında Discord bu tipte istek gönderir.
    if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
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

            const [annRes, , linkedPlayerIdRes, playersRes] = await Promise.all([
                fetch(fb(env, `Announcements/${annId}`)),
                // Kullanıcı adı + sunucu nicki her etkileşimde güncellenir (nick değişse bile userId sabit kalır).
                fetch(fb(env, `DiscordUsers/${userId}`), {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: discordUsername, nickname: serverNickname || discordUsername, lastSeen: Date.now() })
                }),
                // Bu Discord kullanıcısı site üzerinden bir karakterle eşleştirilmiş mi? (Discord Linking sekmesi)
                fetch(fb(env, `GuildData/discordLinks/${userId}`)),
                fetch(fb(env, `GuildData/players`))
            ]);
            const ann = await annRes.json();

            // Duyuru artık aktif değilse (süresi dolmuş/silinmiş), sessizce onayla, hiçbir şey değiştirme.
            if (!ann || ann.finalized) {
                return jsonResponse({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });
            }

            // Eşleştirme varsa (örn. Discord'da "kolirtu" -> sitede "Restital" olarak linklenmiş),
            // Discord embed'inde de site karakterinin adı görünsün diye displayName'i buna göre belirle.
            let displayName = fallbackName;
            try {
                const linkedPlayerId = await linkedPlayerIdRes.json();
                if (linkedPlayerId !== null && linkedPlayerId !== undefined) {
                    const playersRaw = await playersRes.json();
                    const playersArr = Array.isArray(playersRaw) ? playersRaw : Object.values(playersRaw || {});
                    const linkedPlayer = playersArr.find(p => p && String(p.id) === String(linkedPlayerId));
                    if (linkedPlayer && linkedPlayer.name) displayName = linkedPlayer.name;
                }
            } catch (e) { console.error('discordLinks çözümleme hatası (yoksayıldı, fallback isim kullanılacak):', e); }

            // ÖNEMLİ: Tüm accepted/declined/tentative objesini okuyup GERİ YAZMAK yerine (bu, aynı anda
            // birden fazla kişi tıkladığında YARIŞ DURUMU yaratıp başkalarının cevabını SİLEBİLİRDİ),
            // sadece bu kullanıcının 3 haritadaki KENDİ anahtarına, Firebase'in atomik çoklu-yol (multi-path)
            // update özelliğiyle hedefli yazıyoruz. Böylece kaç kişi aynı anda tıklarsa tıklasın birbirlerinin
            // cevabını asla ezemezler.
            const multiPathUpdate = {};
            multiPathUpdate[`Announcements/${annId}/accepted/${userId}`] = choice === 'accept' ? displayName : null;
            multiPathUpdate[`Announcements/${annId}/declined/${userId}`] = choice === 'decline' ? displayName : null;
            multiPathUpdate[`Announcements/${annId}/tentative/${userId}`] = choice === 'tentative' ? displayName : null;

            await fetch(fb(env, ``), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(multiPathUpdate)
            });

            // Embed'i güncel göstermek için duyuruyu bu atomik yazımdan SONRA tazeden okuyoruz
            // (böylece o an başka biri tıklamış olsa bile en güncel tam listeyi gösteririz).
            const freshAnnRes = await fetch(fb(env, `Announcements/${annId}`));
            const freshAnn = await freshAnnRes.json();

            const embed = buildAnnouncementEmbed(freshAnn);
            const components = buildRsvpComponents(annId, false);

            // type 7 (UPDATE_MESSAGE): orijinal mesajı TEK istekte güncelliyoruz,
            // ekstra bir Discord API çağrısına gerek yok.
            return jsonResponse({
                type: InteractionResponseType.UPDATE_MESSAGE,
                data: { embeds: [embed], components }
            });
        } catch (e) {
            console.error('discord-interactions error:', e);
            return jsonResponse({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });
        }
    }

    return new Response('Unhandled interaction type', { status: 400 });
}

function jsonResponse(body) {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
