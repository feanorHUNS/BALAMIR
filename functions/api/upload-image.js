// ============================================================================
// GORSEL YUKLEME  (/api/upload-image)
// ============================================================================
// Tarayicidan gelen gorseli Discord'a yukler ve KALICI CDN baglantisini doner.
//
// NEDEN BOYLE: Bot mesajlarindaki embed gorselleri URL ile gosterilir; base64
// gomulu veri Discord'da CALISMAZ. Kendi dosya barindirmamiz da yok. Cozum:
// gorseli yukleme kanalina bir kez gonderip Discord'un kendi CDN linkini
// saklamak. Link kalicidir — kaynak mesaj silinmedigi surece erisilebilir.

export async function onRequestPost(context) {
    const { request, env, auth } = context;

    if (auth.role !== 'admin') return json({ error: 'Yalnizca admin gorsel yukleyebilir.' }, 403);

    const channelId = env.DISCORD_UPLOAD_CHANNEL_ID || env.DISCORD_LOG_CHANNEL_ID;
    if (!channelId) {
        return json({ error: 'DISCORD_UPLOAD_CHANNEL_ID tanimli degil (Cloudflare Dashboard > Variables).' }, 400);
    }

    let form;
    try { form = await request.formData(); } catch (e) { return json({ error: 'Gecersiz form verisi.' }, 400); }

    const file = form.get('file');
    if (!file || typeof file === 'string') return json({ error: 'Dosya yok.' }, 400);
    // 8MB Discord siniri; biz daha da dusuk tutuyoruz.
    if (file.size > 4 * 1024 * 1024) return json({ error: 'Gorsel cok buyuk (max 4MB).' }, 413);

    const out = new FormData();
    out.append('files[0]', file, 'upload.png');
    out.append('payload_json', JSON.stringify({ content: 'ℹ️ Site upload' }));

    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}` },
        body: out
    });

    if (!res.ok) {
        const txt = await res.text();
        console.error('[upload-image] Discord reddetti:', res.status, txt);
        return json({ error: `Yuklenemedi (${res.status}).` }, 502);
    }

    const msg = await res.json();
    const url = msg && msg.attachments && msg.attachments[0] && msg.attachments[0].url;
    if (!url) return json({ error: 'Discord baglanti dondurmedi.' }, 502);

    return json({ ok: true, url });
}

function json(obj, status = 200) {
    return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
