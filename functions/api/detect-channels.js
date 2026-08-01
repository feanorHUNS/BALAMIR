// ============================================================================
// KANAL SUNUCU TESPITI  (/api/detect-channels)
// ============================================================================
// Bot birden fazla Discord sunucusunda olabiliyor. RSVP hatirlatmasinin
// yalnizca DUYURUNUN PAYLASILDIGI sunucunun uyelerine gitmesi icin, her
// kanalin hangi sunucuya ait oldugunu bilmemiz gerekiyor.
//
// Bu uc, verilen kanal kimliklerini Discord'a sorup her biri icin
// { id, guildId, guildName } dondurur. Site bunu kanal kaydina yazar ve
// Yonetim ekraninda kanallari sunucu basligi altinda gruplar.
//
// NOT: Kanal bilgisi Discord'da nadiren degistigi icin bu islem elle
// tetikleniyor ("Sunuculari tespit et" butonu) -- her sayfa acilisinda
// otomatik sorgu yapmak gereksiz istek olurdu.

const MAX_CHANNELS = 60;

export async function onRequestPost(context) {
    const { request, env } = context;

    let payload;
    try { payload = await request.json(); } catch (e) { return json({ error: 'Invalid JSON' }, 400); }

    const ids = Array.isArray(payload && payload.channelIds) ? payload.channelIds : null;
    if (!ids || ids.length === 0) return json({ error: 'channelIds zorunludur.' }, 400);
    if (ids.length > MAX_CHANNELS) return json({ error: 'Cok fazla kanal.' }, 400);

    const guildNameCache = new Map();
    const results = [];

    for (const raw of ids) {
        const channelId = String(raw || '').trim();
        if (!channelId) continue;

        try {
            const chRes = await fetch(`https://discord.com/api/v10/channels/${channelId}`, {
                headers: { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}` }
            });

            if (!chRes.ok) {
                // 404 = kanal yok ya da bot erisemiyor; 403 = izin yok.
                results.push({ id: channelId, ok: false, reason: chRes.status === 404 ? 'not_found' : 'no_access' });
                continue;
            }

            const ch = await chRes.json();
            const guildId = ch && ch.guild_id ? String(ch.guild_id) : null;

            if (!guildId) {
                // DM kanali gibi sunucuya ait olmayan kanallar.
                results.push({ id: channelId, ok: true, guildId: null, guildName: null, channelName: ch.name || null });
                continue;
            }

            // Sunucu adini bir kez sor, sonra onbellekten kullan.
            let guildName = guildNameCache.get(guildId);
            if (guildName === undefined) {
                guildName = null;
                try {
                    const gRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}`, {
                        headers: { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}` }
                    });
                    if (gRes.ok) {
                        const g = await gRes.json();
                        guildName = (g && g.name) || null;
                    }
                } catch (e) { console.error('guild adi alinamadi:', e); }
                guildNameCache.set(guildId, guildName);
            }

            results.push({
                id: channelId, ok: true,
                guildId, guildName: guildName || guildId,
                channelName: ch.name || null
            });
        } catch (e) {
            console.error(`[detect-channels] ${channelId} hatasi:`, e);
            results.push({ id: channelId, ok: false, reason: 'error' });
        }

        // Discord oran limitine takilmamak icin kisa bekleme.
        await new Promise(r => setTimeout(r, 150));
    }

    const found = results.filter(r => r.ok && r.guildId).length;
    console.log(`[detect-channels] ${found}/${results.length} kanal icin sunucu bulundu.`);
    return json({ success: true, results });
}

function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status, headers: { 'Content-Type': 'application/json' }
    });
}
