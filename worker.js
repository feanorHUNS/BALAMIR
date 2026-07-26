// Bu dosya, düz Cloudflare Workers deploy'unun (Pages Functions DEĞİL) tek giriş noktasıdır.
// Görevi basit: hangi adrese istek geldiğine bakıp doğru fonksiyona yönlendirmek,
// eşleşen bir API adresi yoksa statik dosyaları (index.html vb.) olduğu gibi servis etmek.
//
// ÖNEMLİ: netlify/functions veya pages functions'daki 3 dosyanın (discord-interactions,
// send-announcement, finalize-announcement) İÇERİĞİNE DOKUNMADIK — onlar zaten
// { request, env } alıp bir Response döndürüyorlar, bu yüzden burada olduğu gibi
// import edip çağırmak yeterli.

import { onRequestPost as discordInteractions } from './functions/api/discord-interactions.js';
import { onRequestPost as sendAnnouncement } from './functions/api/send-announcement.js';
import { onRequestPost as finalizeAnnouncement } from './functions/api/finalize-announcement.js';

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        try {
            if (request.method === 'POST' && url.pathname === '/api/discord-interactions') {
                return await discordInteractions({ request, env });
            }
            if (request.method === 'POST' && url.pathname === '/api/send-announcement') {
                return await sendAnnouncement({ request, env });
            }
            if (request.method === 'POST' && url.pathname === '/api/finalize-announcement') {
                return await finalizeAnnouncement({ request, env });
            }
        } catch (e) {
            console.error('worker.js routing error:', e);
            return new Response('Sunucu hatası: ' + e.message, { status: 500 });
        }

        // Eşleşen bir API adresi yoksa: index.html ve diğer statik dosyaları servis et.
        return env.ASSETS.fetch(request);
    }
};
