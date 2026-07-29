// Biri bir duyuru mesajini Discord'dan ELLE silerse, site bunu anlayip duyuruyu
// "sonlandirilmis" olarak isaretler.
// Adres: https://SITEN.workers.dev/api/sync-announcements
//
// Asil mantik functions/_announcementTasks.js icinde — ayni kontrol cron
// tarafindan da periyodik yapiliyor (Madde 31).

import { syncAnnouncementCore } from '../_announcementTasks.js';

export async function onRequestPost(context) {
    const { request, env } = context;

    let payload;
    try { payload = await request.json(); } catch (e) { return new Response('Invalid JSON', { status: 400 }); }

    const { annId, channelId, messageId } = payload;
    if (!annId || !channelId || !messageId) {
        return new Response('annId, channelId ve messageId zorunludur.', { status: 400 });
    }

    const wasDeleted = await syncAnnouncementCore(env, annId, channelId, messageId);

    return new Response(JSON.stringify({ success: true, wasDeleted }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
    });
}
