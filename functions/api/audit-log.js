// ============================================================================
// DENETIM KAYDI YAZMA  (/api/audit-log)   — Madde 111
// ============================================================================
// Istemci artik AuditLogs yoluna dogrudan yazmiyor. Boylece:
//   - Kaydin `user` alani SAHTELENEMEZ; sunucu, dogrulanmis kimlikten yaziyor.
//     (Onceden istemci istedigi ismi yazabiliyordu -- yani biri baskasinin
//      adina islem kaydi olusturabilirdi.)
//   - Kayit boyutu ve alan tipleri dogrulaniyor.

import { fb } from '../_auth.js';

const MAX_ACTION_LEN = 300;
const MAX_FIELD_LEN = 200;

function clip(v, n) {
    if (v === null || v === undefined) return null;
    return String(v).slice(0, n);
}

export async function onRequestPost(context) {
    const { request, env, auth } = context;

    let payload;
    try { payload = await request.json(); } catch (e) { return json({ error: 'Invalid JSON' }, 400); }

    const action = clip(payload && payload.action, MAX_ACTION_LEN);
    if (!action) return json({ error: 'action zorunludur.' }, 400);

    const entry = {
        at: Date.now(),
        time: new Date().toLocaleString('tr-TR'),
        // KRITIK: kullanici adi istemciden DEGIL, dogrulanmis kimlikten geliyor.
        user: auth.name || auth.uid,
        userRole: auth.role,
        action: action
    };

    const meta = payload && payload.meta;
    if (meta && typeof meta === 'object') {
        if (meta.playerId !== undefined)   entry.playerId = clip(meta.playerId, 40);
        if (meta.playerName !== undefined) entry.playerName = clip(meta.playerName, 60);
        if (meta.field !== undefined)      entry.field = clip(meta.field, 40);
        if (meta.before !== undefined)     entry.before = clip(meta.before, MAX_FIELD_LEN);
        if (meta.after !== undefined)      entry.after = clip(meta.after, MAX_FIELD_LEN);
        if (meta.reason !== undefined)     entry.reason = clip(meta.reason, MAX_FIELD_LEN);
        if (meta.delta !== undefined && typeof meta.delta === 'number' && isFinite(meta.delta)) {
            entry.delta = meta.delta;
        }
    }

    try {
        const res = await fetch(fb(env, `AuditLogs`), {
            method: 'POST',                       // Firebase REST'te POST = push
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(entry)
        });
        if (!res.ok) {
            const txt = await res.text();
            console.error('[audit-log] Firebase hatasi:', res.status, txt);
            return json({ error: 'Kayit yazilamadi.' }, 502);
        }
        return json({ success: true });
    } catch (e) {
        console.error('[audit-log] hata:', e);
        return json({ error: 'Sunucu hatasi: ' + e.message }, 500);
    }
}

function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status, headers: { 'Content-Type': 'application/json' }
    });
}
