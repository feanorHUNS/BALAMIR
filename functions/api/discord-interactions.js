// Bu fonksiyon Discord Developer Portal'daki "Interactions Endpoint URL" olarak
// tanımlanmalıdır. Discord, biri bir butona her bastığında BU adrese istek atar.
// Adres: https://SITEN.pages.dev/api/discord-interactions
//
// Cloudflare Pages otomatik routing: functions/api/discord-interactions.js -> /api/discord-interactions

import { verifyKey, InteractionType, InteractionResponseType } from 'discord-interactions';
import { buildAnnouncementEmbed, buildRsvpComponents } from '../_embedHelper.js';

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
            const displayName = serverNickname || user.global_name || user.username;

            const [annRes] = await Promise.all([
                fetch(`${env.FIREBASE_DB_URL}/Announcements/${annId}.json`),
                // Kullanıcı adı + sunucu nicki her etkileşimde güncellenir (nick değişse bile userId sabit kalır).
                fetch(`${env.FIREBASE_DB_URL}/DiscordUsers/${userId}.json`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: discordUsername, nickname: serverNickname || discordUsername, lastSeen: Date.now() })
                })
            ]);
            const ann = await annRes.json();

            // Duyuru artık aktif değilse (süresi dolmuş/silinmiş), sessizce onayla, hiçbir şey değiştirme.
            if (!ann || ann.finalized) {
                return jsonResponse({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });
            }

            ann.accepted = ann.accepted || {};
            ann.declined = ann.declined || {};
            ann.tentative = ann.tentative || {};

            // Kullanıcı oyunu değiştirebilsin diye önce her 3 listeden de temizle.
            delete ann.accepted[userId];
            delete ann.declined[userId];
            delete ann.tentative[userId];

            if (choice === 'accept') ann.accepted[userId] = displayName;
            else if (choice === 'decline') ann.declined[userId] = displayName;
            else if (choice === 'tentative') ann.tentative[userId] = displayName;

            await fetch(`${env.FIREBASE_DB_URL}/Announcements/${annId}.json`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ accepted: ann.accepted, declined: ann.declined, tentative: ann.tentative })
            });

            const embed = buildAnnouncementEmbed(ann);
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
