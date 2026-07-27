// Bu dosya, düz Cloudflare Workers deploy'unun (Pages Functions DEĞİL) TEK giriş noktasıdır.
// Görevi: hangi adrese istek geldiğine bakıp doğru fonksiyona yönlendirmek, eşleşen bir
// API adresi yoksa statik dosyaları (index.html vb.) olduğu gibi servis etmek.
//
// ÖNEMLİ: Bu dosyayı GitHub reponun KÖKÜNE yükle (functions/ klasörüyle aynı seviyeye).
// wrangler.jsonc ile birlikte, ikisi de repo kökünde olmalı.

import { onRequestPost as discordInteractions } from './functions/api/discord-interactions.js';
import { onRequestPost as sendAnnouncement } from './functions/api/send-announcement.js';
import { onRequestPost as finalizeAnnouncement } from './functions/api/finalize-announcement.js';
import { onRequestPost as deleteAnnouncement } from './functions/api/delete-announcement.js';
import { onRequestPost as syncAnnouncements } from './functions/api/sync-announcements.js';
import { onRequestPost as sendPlanImage } from './functions/api/send-plan-image.js';
import { onRequestPost as sendPlanReminder } from './functions/api/send-plan-reminder.js';

const ROUTES = {
    '/api/discord-interactions': discordInteractions,
    '/api/send-announcement': sendAnnouncement,
    '/api/finalize-announcement': finalizeAnnouncement,
    '/api/delete-announcement': deleteAnnouncement,
    '/api/sync-announcements': syncAnnouncements,
    '/api/send-plan-image': sendPlanImage,
    '/api/send-plan-reminder': sendPlanReminder
};

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const handler = request.method === 'POST' ? ROUTES[url.pathname] : null;

        if (handler) {
            try {
                return await handler({ request, env });
            } catch (e) {
                console.error(`worker.js routing error @ ${url.pathname}:`, e);
                return new Response('Sunucu hatası: ' + e.message, { status: 500 });
            }
        }

        // Eşleşen bir API adresi yoksa: index.html ve diğer statik dosyaları servis et.
        return env.ASSETS.fetch(request);
    }
};
