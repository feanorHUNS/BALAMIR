// Site (manuel "Finalize Now") tarafindan cagrilir.
// Adres: https://SITEN.workers.dev/api/finalize-announcement
//
// Asil mantik functions/_announcementTasks.js icinde — ayni is her dakika
// calisan cron gorevi tarafindan da yapiliyor (Madde 31). Tek kaynak, iki cagiran.

import { finalizeAnnouncementCore } from '../_announcementTasks.js';

export async function onRequestPost(context) {
    const { request, env } = context;

    let payload;
    try { payload = await request.json(); } catch (e) { return new Response('Invalid JSON', { status: 400 }); }

    const { annId } = payload;
    if (!annId) return new Response('annId zorunludur.', { status: 400 });

    const result = await finalizeAnnouncementCore(env, annId, 'manual');

    if (result.notFound) return new Response('Duyuru bulunamadi.', { status: 404 });
    if (!result.ok) return new Response('Sunucu hatasi: ' + (result.error || 'bilinmeyen'), { status: 500 });

    return new Response(JSON.stringify({ success: true, alreadyFinalized: !!result.alreadyFinalized }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
    });
}
