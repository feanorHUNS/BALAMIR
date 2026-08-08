// ============================================================================
// HAFTALIK OBS ROTASYONU  (/api/obs-rotation)
// ============================================================================
//   POST { action: 'test' }  -> bu haftanin rotasyonunu HEMEN paylasir (admin)
//
// Haftalik otomatik paylasim worker.js icindeki cron tarafindan yapilir;
// bu uc yalnizca "simdi gonder" testi icindir.

import { fb } from '../_auth.js';
import { postObsRotation, obsRotationAt } from '../_obsTasks.js';

export async function onRequestPost(context) {
    const { request, env, auth } = context;
    if (auth.role !== 'admin') return json({ error: 'Yalnizca admin.' }, 403);

    let payload;
    try { payload = await request.json(); } catch (e) { return json({ error: 'Invalid JSON' }, 400); }
    if (String(payload.action) !== 'test') return json({ error: 'Bilinmeyen islem.' }, 400);

    const res = await fetch(fb(env, 'GuildData/obsRotation'));
    const cfg = (await res.json()) || {};
    const rot = obsRotationAt(Date.now());

    const out = await postObsRotation(env, cfg, rot, Date.now(), true);
    if (!out.ok) return json({ error: out.error || 'Gonderilemedi.' }, 502);
    return json({ ok: true, rotation: rot });
}

function json(obj, status = 200) {
    return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
