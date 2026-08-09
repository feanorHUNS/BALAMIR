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
    // Discord'un ucretsiz sunucu siniri 10MB; guvenli tarafta 8MB.
    if (file.size > 8 * 1024 * 1024) {
        return json({ error: `Dosya cok buyuk (${Math.round(file.size / 1024 / 1024)}MB, en fazla 8MB).` }, 413);
    }

    // DOSYA ADI KRITIK: Burada ad 'upload.png' olarak SABITLENMISTI. GIF
    // gonderilse bile Discord uzantiya bakip onu hareketsiz PNG sayiyor ve
    // CDN baglantisi .png ile bitiyordu — animasyon hic oynamiyordu.
    // Artik gercek tur korunuyor.
    const rawName = String(file.name || '').toLowerCase();
    const rawType = String(file.type || '').toLowerCase();
    let ext = 'png';
    if (rawType.includes('gif') || rawName.endsWith('.gif')) ext = 'gif';
    else if (rawType.includes('webp') || rawName.endsWith('.webp')) ext = 'webp';
    else if (rawType.includes('jpeg') || rawName.endsWith('.jpg') || rawName.endsWith('.jpeg')) ext = 'jpg';

    const out = new FormData();
    out.append('files[0]', file, `upload.${ext}`);
    out.append('payload_json', JSON.stringify({ content: 'ℹ️ Site upload' }));

    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}` },
        body: out
    });

    if (!res.ok) {
        const txt = await res.text();
        console.error('[upload-image] Discord reddetti:', res.status, txt);
        // En sik sebep: DISCORD_UPLOAD_CHANNEL_ID yanlis ya da botun o kanalda
        // yazma yetkisi yok. Kullanici tahmin etmesin, acikca yazalim.
        let hint = '';
        if (res.status === 404) hint = ' Kanal bulunamadi — DISCORD_UPLOAD_CHANNEL_ID yanlis olabilir.';
        if (res.status === 403) hint = ' Botun bu kanala yazma yetkisi yok.';
        if (res.status === 401) hint = ' Bot token gecersiz.';
        return json({ error: `Yuklenemedi (${res.status}).${hint}` }, 502);
    }

    const msg = await res.json();
    const url = msg && msg.attachments && msg.attachments[0] && msg.attachments[0].url;
    if (!url) return json({ error: 'Discord baglanti dondurmedi.' }, 502);

    return json({ ok: true, url });
}

function json(obj, status = 200) {
    return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
