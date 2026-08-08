// ============================================================================
// SLASH KOMUTLARI  —  /hi   /dkp   /match
// ============================================================================
// Bu modul, discord-interactions.js tarafindan cagrilir. Discord'un 3 saniye
// kurali geregi cagiran taraf ONCE "dusunuyorum" (DEFERRED) yaniti doner,
// asil is burada arka planda yapilip yanit sonradan duzenlenir.
//
// TASARIM NOTLARI
// - Tum yanitlar EPHEMERAL (yalnizca komutu yazan gorur) — kanal DKP
//   sorgulariyla dolmasin. Tek istisna /hi: eglenceli oldugu icin herkes
//   gorur ve kisiyi etiketler.
// - Komutlar YALNIZCA sitede secilen kanalda calisir (bot ayarlari).
// - /match dogrudan degisiklik YAPMAZ; yetkili onayina dusen bir istek acar.
//   Boylece trol istekler siteye islenemez.

import { fb } from './_auth.js';

// ---------------------------------------------------------------------------
// 50 adet iki dilli selamlama. Once Ingilizce, sonra Turkce.
// {u} yerine kullanicinin etiketi gelir.
// ---------------------------------------------------------------------------
export const GREETINGS = [
    "Hey {u}! Hello there!  ·  Selam {u}! Merhaba!",
    "Hello {u}, the astral called — it wants you back.  ·  Merhaba {u}, astral seni sordu.",
    "Hi {u}! Ready to wipe on the first boss?  ·  Selam {u}! İlk boss'ta yatmaya hazır mısın?",
    "Greetings {u}, mighty warrior of HUNS!  ·  Selam {u}, HUNS'un yiğit savaşçısı!",
    "Hey {u}! Your gear is showing.  ·  Hey {u}! Ekipmanın görünüyor.",
    "Hello {u}! Did you repair before logging in?  ·  Merhaba {u}! Girmeden önce tamir yaptırdın mı?",
    "Hi {u}, may your rubies never respec themselves.  ·  Selam {u}, rubylerin kendi kendine dağılmasın.",
    "Yo {u}! The guild bank misses you.  ·  Yo {u}! Guild bankası seni özledi.",
    "Hello {u}! Someone said your name in /say.  ·  Merhaba {u}! Biri /say'de adını andı.",
    "Hey {u}, still holding that Tentative vote?  ·  Hey {u}, hâlâ Tentative'de misin?",
    "Greetings {u}! Buff food is on you today.  ·  Selam {u}! Bugün buff yemeği senden.",
    "Hi {u}! Your DKP called, it's lonely.  ·  Selam {u}! DKP'n aradı, yalnız kalmış.",
    "Hello {u}, the Dominion tower needs a hero.  ·  Merhaba {u}, Dominion kulesi kahraman arıyor.",
    "Hey {u}! Don't forget your daily.  ·  Hey {u}! Günlüğünü unutma.",
    "Welcome back {u}, legend has it you never AFK.  ·  Tekrar hoş geldin {u}, hiç AFK olmazmışsın diyorlar.",
    "Hi {u}! Rumor says you rolled a 1 again.  ·  Selam {u}! Yine 1 attığın söyleniyor.",
    "Hello {u}! Healer is watching you.  ·  Merhaba {u}! Healer seni izliyor.",
    "Hey {u}, tank aggro is not a personality trait.  ·  Hey {u}, tank aggrosu kişilik özelliği değil.",
    "Greetings {u}! Your reinc is proud of you.  ·  Selam {u}! Reinc'in seninle gurur duyuyor.",
    "Hi {u}! Someone left loot on the floor.  ·  Selam {u}! Biri yerde loot bırakmış.",
    "Hello {u}! Astral sector cleared? No? Same.  ·  Merhaba {u}! Astral sektör bitti mi? Yok mu? Bende de.",
    "Hey {u}, your mana bar says hi too.  ·  Hey {u}, mana barın da selam söylüyor.",
    "Yo {u}! Raid starts in a moment — probably.  ·  Yo {u}! Raid birazdan başlıyor — muhtemelen.",
    "Hi {u}! Don't stand in the fire, please.  ·  Selam {u}! Ateşin içinde durma lütfen.",
    "Hello {u}, the guild leader is watching.  ·  Merhaba {u}, guild lideri izliyor.",
    "Hey {u}! Nice title. Did you earn it?  ·  Hey {u}! Güzel ünvan. Hak ettin mi?",
    "Greetings {u}! Your CC saved the run once.  ·  Selam {u}! CC'n bir keresinde raidi kurtarmıştı.",
    "Hi {u}! Ready for another 3-hour 'quick run'?  ·  Selam {u}! Yine 3 saatlik 'kısa run'a var mısın?",
    "Hello {u}! Your bags are probably full.  ·  Merhaba {u}! Çantan doludur muhtemelen.",
    "Hey {u}, the mount you want dropped for someone else.  ·  Hey {u}, istediğin mount başkasına düştü.",
    "Yo {u}! Officer material right there.  ·  Yo {u}! Officer olacak adam.",
    "Hi {u}! Ping is low, mood is high.  ·  Selam {u}! Ping düşük, moral yüksek.",
    "Hello {u}, remember to hit Accept on the announcement.  ·  Merhaba {u}, duyuruda Accept'e basmayı unutma.",
    "Hey {u}! Your stats are showing, and they're good.  ·  Hey {u}! Statların görünüyor ve fena değil.",
    "Greetings {u}! Someone has to carry, might as well be you.  ·  Selam {u}! Biri taşımalı, o sen olabilirsin.",
    "Hi {u}! The bot approves of your presence.  ·  Selam {u}! Bot varlığını onaylıyor.",
    "Hello {u}, another day another Dominion loss? Not today.  ·  Merhaba {u}, yine Dominion yenilgisi mi? Bugün değil.",
    "Hey {u}! Your reputation grind salutes you.  ·  Hey {u}! Rep grindin seni selamlıyor.",
    "Yo {u}! Don't ninja the loot this time.  ·  Yo {u}! Bu sefer loot'u ninja'lama.",
    "Hi {u}! Guild chat is quieter without you.  ·  Selam {u}! Sensiz guild chat sessiz.",
    "Hello {u}! You logged in, that's already progress.  ·  Merhaba {u}! Giriş yaptın, bu bile ilerleme.",
    "Hey {u}, the raid leader knows what you did.  ·  Hey {u}, raid lideri ne yaptığını biliyor.",
    "Greetings {u}! May your crits be many and your deaths few.  ·  Selam {u}! Critin bol, ölümün az olsun.",
    "Hi {u}! Someone needs a healer. It's always someone.  ·  Selam {u}! Birine healer lazım. Hep birine lazım.",
    "Hello {u}, your gear score whispered your name.  ·  Merhaba {u}, gear scoren adını fısıldadı.",
    "Hey {u}! Free advice: bring more potions.  ·  Hey {u}! Bedava tavsiye: daha çok potion getir.",
    "Yo {u}! The bank has gold. Not for you, but it has.  ·  Yo {u}! Bankada altın var. Sana değil ama var.",
    "Hi {u}! Buff up, we move in five.  ·  Selam {u}! Buff'lan, beş dakikaya çıkıyoruz.",
    "Hello {u}, you were missed at the last raid.  ·  Merhaba {u}, son raidde seni aradık.",
    "Hey {u}! Welcome, the astral awaits.  ·  Hey {u}! Hoş geldin, astral bekliyor."
];

// ---------------------------------------------------------------------------
// Yardimcilar
// ---------------------------------------------------------------------------

/** Firebase'den oyuncu listesini dizi olarak getirir. */
async function loadPlayers(env) {
    const res = await fetch(fb(env, 'GuildData/players'));
    const raw = await res.json();
    return Array.isArray(raw) ? raw.filter(Boolean) : Object.values(raw || {}).filter(Boolean);
}

/** Bot ayarlarini getirir (komut kanali, hosgeldin ayarlari). */
export async function loadBotSettings(env) {
    try {
        const res = await fetch(fb(env, 'GuildData/botSettings'));
        return (await res.json()) || {};
    } catch (e) {
        console.error('[bot] ayarlar okunamadi:', e);
        return {};
    }
}

/**
 * Komut, izin verilen kanalda mi?
 * commandChannels bos ise HER kanalda calisir (kurulum kolayligi icin).
 */
function channelAllowed(settings, channelId) {
    const list = Array.isArray(settings.commandChannels) ? settings.commandChannels.map(String) : [];
    if (list.length === 0) return true;
    return list.includes(String(channelId));
}

/** Ertelenmis yaniti tamamlar (orijinal yaniti duzenler). */
async function editReply(interaction, payload) {
    const url = `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;
    const res = await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    if (!res.ok) console.error('[bot] yanit duzenleme hatasi:', res.status, await res.text());
}

function optionValue(interaction, name) {
    const opts = (interaction.data && interaction.data.options) || [];
    const found = opts.find(o => o.name === name);
    return found ? String(found.value) : '';
}

// ---------------------------------------------------------------------------
// Ana dagitici
// ---------------------------------------------------------------------------
export async function handleSlashCommand(interaction, env) {
    const name = interaction.data && interaction.data.name;
    const user = (interaction.member && interaction.member.user) || interaction.user;
    const settings = await loadBotSettings(env);

    if (!channelAllowed(settings, interaction.channel_id)) {
        const allowed = (settings.commandChannels || []).map(id => `<#${id}>`).join(' ');
        return editReply(interaction, {
            content: `⛔ Commands only work in: ${allowed}\n⛔ Komutlar yalnızca şu kanalda çalışır: ${allowed}`
        });
    }

    // Her etkilesimde Discord kullanici bilgisini tazele — site tarafindaki
    // eslestirme listesi guncel isimleri gostersin.
    const serverNick = (interaction.member && interaction.member.nick) || null;
    await fetch(fb(env, `DiscordUsers/${user.id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            username: user.username,
            nickname: serverNick || user.global_name || user.username,
            lastSeen: Date.now()
        })
    }).catch(() => {});

    try {
        if (name === 'hi')    return await cmdHi(interaction, env, user);
        if (name === 'dkp')   return await cmdDkp(interaction, env, user);
        if (name === 'match') return await cmdMatch(interaction, env, user, serverNick);
        return editReply(interaction, { content: 'Unknown command. · Bilinmeyen komut.' });
    } catch (e) {
        console.error('[bot] komut hatasi:', e);
        return editReply(interaction, { content: '⚠️ Something went wrong. · Bir şeyler ters gitti.' });
    }
}

// ---------------------------------------------------------------------------
// /hi  —  rastgele iki dilli selam, kisiyi etiketler
// ---------------------------------------------------------------------------
async function cmdHi(interaction, env, user) {
    const line = GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
    return editReply(interaction, {
        content: line.replace(/\{u\}/g, `<@${user.id}>`),
        allowed_mentions: { users: [user.id] }
    });
}

// ---------------------------------------------------------------------------
// /dkp  —  Discord hesabina bagli karakterin DKP'si
// ---------------------------------------------------------------------------
async function cmdDkp(interaction, env, user) {
    const linkRes = await fetch(fb(env, `GuildData/discordLinks/${user.id}`));
    const playerId = await linkRes.json();

    if (playerId === null || playerId === undefined) {
        return editReply(interaction, {
            content: '❔ Your Discord account is not linked to a character yet. Use `/match <in-game nickname>`.\n'
                   + '❔ Discord hesabın henüz bir karaktere bağlı değil. `/match <oyun içi nick>` yazabilirsin.'
        });
    }

    const players = await loadPlayers(env);
    const me = players.find(p => String(p.id) === String(playerId) && !p.isDeleted);
    if (!me) {
        return editReply(interaction, {
            content: '❔ The linked character was not found on the site.\n❔ Bağlı karakter sitede bulunamadı.'
        });
    }

    // Siralama: silinmemis karakterler arasinda DKP'ye gore.
    const ranked = players.filter(p => !p.isDeleted)
        .sort((a, b) => (parseInt(b.dkp) || 0) - (parseInt(a.dkp) || 0));
    const rank = ranked.findIndex(p => String(p.id) === String(me.id)) + 1;

    // Ayni oyuncunun reinc karakterleri (varsa) da gosterilsin.
    const family = players.filter(p => !p.isDeleted &&
        (String(p.reincOf) === String(me.id) || (me.reincOf && String(p.id) === String(me.reincOf))));

    const embed = {
        title: `💰 ${me.name}`,
        color: 0x06b6d4,
        fields: [
            { name: 'DKP', value: `**${parseInt(me.dkp) || 0}**`, inline: true },
            { name: 'Rank / Sıra', value: `#${rank} / ${ranked.length}`, inline: true },
            { name: 'Role / Rol', value: `${me.role || '—'}${me.className ? ' · ' + me.className : ''}`, inline: true },
            { name: 'Dragon / Arti', value: `🐉 ${me.totalDragon || 0}   ✨ ${me.totalArti || 0}`, inline: false }
        ],
        footer: { text: 'HUNS Guild' }
    };
    if (family.length) {
        embed.fields.push({
            name: 'Linked characters / Bağlı karakterler',
            value: family.map(f => `${f.name} — ${parseInt(f.dkp) || 0} DKP`).join('\n').slice(0, 900),
            inline: false
        });
    }

    return editReply(interaction, { embeds: [embed] });
}

// ---------------------------------------------------------------------------
// /match <nick>  —  yetkili onayina dusen eslestirme istegi
// ---------------------------------------------------------------------------
async function cmdMatch(interaction, env, user, serverNick) {
    const nick = optionValue(interaction, 'nick').trim().slice(0, 24);
    if (nick.length < 2) {
        return editReply(interaction, {
            content: '⚠️ Please write your in-game character name: `/match Feanor`\n'
                   + '⚠️ Oyun içi karakter adını yaz: `/match Feanor`'
        });
    }

    const [playersArr, linkRes] = await Promise.all([
        loadPlayers(env),
        fetch(fb(env, `GuildData/discordLinks/${user.id}`))
    ]);
    const currentPlayerId = await linkRes.json();

    // Ayni isimde kayitli karakter var mi? (buyuk/kucuk harf duyarsiz)
    const existing = playersArr.find(p => p && !p.isDeleted &&
        String(p.name).toLowerCase() === nick.toLowerCase());
    const currentPlayer = (currentPlayerId !== null && currentPlayerId !== undefined)
        ? playersArr.find(p => p && String(p.id) === String(currentPlayerId))
        : null;

    // --- Yapilacak islemi SIMDIDEN belirle; yetkili ne onayladigini gorsun.
    let action, summaryEn, summaryTr;

    if (currentPlayer && existing && String(currentPlayer.id) === String(existing.id)) {
        return editReply(interaction, {
            content: `✅ You are already linked to **${existing.name}**.\n✅ Zaten **${existing.name}** karakterine bağlısın.`
        });
    }

    if (currentPlayer && !existing) {
        // Hesap zaten bagli ama FARKLI bir nick yazdi -> mevcut karakterin adi degissin.
        action = 'rename';
        summaryEn = `Rename character **${currentPlayer.name}** → **${nick}** (keeps the existing link).`;
        summaryTr = `**${currentPlayer.name}** karakterinin adı **${nick}** olarak değiştirilsin (bağlantı korunur).`;
    } else if (existing) {
        // Nick zaten sitede kayitli -> YENI KARAKTER ACMA, sadece bagla.
        action = 'link';
        summaryEn = `Link this Discord account to the existing character **${existing.name}**.`;
        summaryTr = `Bu Discord hesabı mevcut **${existing.name}** karakterine bağlansın.`;
    } else {
        // Ne bagli hesap ne de kayitli nick var -> yeni karakter olustur ve bagla.
        action = 'create';
        summaryEn = `Create a new character **${nick}** and link this Discord account to it.`;
        summaryTr = `Yeni **${nick}** karakteri oluşturulup bu Discord hesabına bağlansın.`;
    }

    const reqId = `mr_${user.id}_${Date.now()}`;
    await fetch(fb(env, `MatchRequests/${reqId}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            discordId: String(user.id),
            discordName: serverNick || user.global_name || user.username,
            nick,
            action,                                   // create | link | rename
            targetPlayerId: existing ? String(existing.id) : (currentPlayer ? String(currentPlayer.id) : null),
            currentName: currentPlayer ? currentPlayer.name : null,
            summaryEn, summaryTr,
            status: 'pending',
            at: Date.now()
        })
    });

    return editReply(interaction, {
        content: `📨 Your request was sent to the officers for approval.\n> ${summaryEn}\n\n`
               + `📨 İsteğin yetkili onayına gönderildi.\n> ${summaryTr}`
    });
}
