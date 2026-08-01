// ============================================================================
// PAYLAŞILAN GÜVENLİK MODÜLÜ  (Madde 25: API kimlik doğrulama, Madde 27: hız sınırı)
// ============================================================================
// SORUN (önceki hâli): /api/send-announcement, /api/delete-announcement gibi
// uçlar HERKESE AÇIKTI. Site adresini bilen biri, tarayıcı bile açmadan tek bir
// komutla Discord sunucusuna sınırsız @everyone spam'i atabilir ya da tüm
// duyuruları silebilirdi.
//
// ÇÖZÜM: Her istek, kullanıcının Google ile giriş yaptığında Firebase'in verdiği
// "ID token"ı taşımak zorunda. Bu token taklit edilemez (Google imzalıyor).
// Sunucu tarafında iki aşamada doğruluyoruz:
//   1) Token gerçekten Google tarafından mı verilmiş?  -> Firebase'e sorularak
//   2) Bu kullanıcının sitede yetkisi var mı?          -> Roles/{uid} kaydı var mı
//
// NOT: Bu dosya "_" ile başladığı için bir API adresi DEĞİL, sadece
// diğer fonksiyonların içe aktardığı yardımcı bir modül.

// Rol sıralaması: sayı büyüdükçe yetki artar.
const ROLE_RANK = { visitor: 0, member: 1, officer: 2, admin: 3 };

/**
 * Firebase REST adresi üretir (Madde 3).
 *
 * NEDEN GEREKLİ: Firebase güvenlik kurallarını sıkılaştırabilmemiz için, sunucu
 * tarafındaki bu Worker'ın Firebase'e "ben yetkiliyim" diyebilmesi lazım. Aksi
 * halde kuralları kapattığımız anda bot duyuru yazamaz, cron zamanlanmış
 * paylaşımları güncelleyemez hale gelir.
 *
 * FIREBASE_DB_SECRET tanımlıysa istek yetkili olarak gider ve kurallar sıkı
 * tutulabilir. Tanımlı değilse eski davranış aynen sürer (hiçbir şey bozulmaz),
 * ama o zaman kurallar gevşek kalmak zorundadır.
 */
export function fb(env, path) {
    const base = `${env.FIREBASE_DB_URL}/${path}.json`;
    return env.FIREBASE_DB_SECRET ? `${base}?auth=${env.FIREBASE_DB_SECRET}` : base;
}

/**
 * İsteği gönderen kişinin kim olduğunu doğrular.
 * Başarılıysa { ok: true, uid, role, name } döner.
 * Başarısızsa  { ok: false, response } döner — response doğrudan istemciye verilmeli.
 */
export async function authenticate(request, env) {
    const header = request.headers.get('authorization') || '';
    const idToken = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

    if (!idToken) {
        return fail(401, 'Giriş yapmanız gerekiyor (kimlik bilgisi gönderilmedi).');
    }
    if (!env.FIREBASE_API_KEY) {
        // Yapılandırma eksikse "herkese açık" duruma DÜŞMÜYORUZ — kapalı kalıyoruz.
        console.error('[auth] FIREBASE_API_KEY tanımlı değil — istek reddedildi.');
        return fail(500, 'Sunucu kimlik doğrulama yapılandırması eksik.');
    }

    // 1) Token'ı Google'a doğrulat. Token sahte, süresi dolmuş ya da iptal
    //    edilmişse buradan hata döner.
    let uid, name;
    try {
        const res = await fetch(
            `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.FIREBASE_API_KEY}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ idToken })
            }
        );
        if (!res.ok) {
            return fail(401, 'Oturumunuz geçersiz veya süresi dolmuş. Sayfayı yenileyip tekrar giriş yapın.');
        }
        const data = await res.json();
        const user = data && data.users && data.users[0];
        if (!user || !user.localId) {
            return fail(401, 'Kimlik doğrulanamadı.');
        }
        uid = user.localId;
        name = user.displayName || user.email || uid;
    } catch (e) {
        console.error('[auth] token doğrulama hatası:', e);
        return fail(503, 'Kimlik doğrulama servisine ulaşılamadı, biraz sonra tekrar deneyin.');
    }

    // 2) Bu kullanıcıya sitede rol verilmiş mi? Google hesabı olması yetmez —
    //    admin'in onaylayıp Roles altına eklemiş olması gerekir.
    let role;
    try {
        const roleRes = await fetch(fb(env, `Roles/${uid}`));
        const roleData = await roleRes.json();
        if (!roleData || !roleData.role) {
            return fail(403, 'Bu işlem için yetkiniz yok (hesabınız henüz onaylanmamış).');
        }
        role = roleData.role;
        if (roleData.name) name = roleData.name;
    } catch (e) {
        console.error('[auth] rol okuma hatası:', e);
        return fail(503, 'Yetki bilgisi okunamadı, biraz sonra tekrar deneyin.');
    }

    return { ok: true, uid, role, name };
}

/** Kullanıcının rolü, istenen en düşük seviyeye eşit ya da üstünde mi? */
export function hasAtLeast(role, minRole) {
    return (ROLE_RANK[role] || 0) >= (ROLE_RANK[minRole] || 0);
}

/**
 * Basit hız sınırı (Madde 27). Kullanıcı + uç adı başına, kayan pencere içinde
 * en fazla `limit` istek. Sayaç Firebase'de tutuluyor (ek altyapı gerekmiyor).
 *
 * Amaç: bir hesap ele geçirilse ya da bir döngü kazara çalışsa bile Discord bot
 * token'ının oran limitine takılmasını ve Cloudflare kotasının yanmasını önlemek.
 */
export async function checkRateLimit(env, uid, bucket, limit, windowMs) {
    return checkLimitKey(env, `${uid}_${bucket}`, limit, windowMs);
}

/**
 * A7 / Madde 114 — IP BAZLI HIZ SINIRI
 * ============================================================================
 * Kullanici basina sinir, ikinci bir Google hesabi acan kisi tarafindan
 * kolayca atlatilabiliyordu. Artik AYNI ISTEK hem kullanici hem de IP
 * kotasindan dusuluyor; ikisinden biri dolduysa istek reddediliyor.
 *
 * Cloudflare'in `cf-connecting-ip` basligi kenar sunucuda ayarlanir ve
 * istemci tarafindan sahtelenemez.
 *
 * IP sinirinin kullanici sinirindan daha genis olmasi bilincli: ayni evden
 * baglanan iki guild uyesi birbirini engellemesin.
 */
export async function checkIpRateLimit(request, env, bucket, limit, windowMs) {
    const ip = request.headers.get('cf-connecting-ip') ||
               request.headers.get('x-real-ip') || 'unknown';
    if (ip === 'unknown') return { ok: true }; // IP okunamadiysa engelleme
    // Anahtarda ham IP tutmuyoruz; kisa bir ozet yeterli (gizlilik).
    const key = 'ip_' + (await shortHash(ip)) + '_' + bucket;
    return checkLimitKey(env, key, limit, windowMs);
}

/** Kisa, geri donusturulemez ozet — IP'yi duz metin saklamamak icin. */
async function shortHash(value) {
    const data = new TextEncoder().encode(value);
    const buf = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buf)).slice(0, 8)
        .map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Ortak sayac mantigi: hem kullanici hem IP sinirlari bunu kullanir. */
async function checkLimitKey(env, key, limit, windowMs) {
    const now = Date.now();
    try {
        const res = await fetch(fb(env, `RateLimits/${key}`));
        const cur = await res.json();

        let count = 1;
        let windowStart = now;

        if (cur && cur.windowStart && (now - cur.windowStart) < windowMs) {
            // Pencere hâlâ açık — sayacı artır.
            count = (cur.count || 0) + 1;
            windowStart = cur.windowStart;
            if (count > limit) {
                const kalanSn = Math.ceil((windowStart + windowMs - now) / 1000);
                return {
                    ok: false,
                    response: jsonError(429, `Çok fazla istek gönderdiniz. ${kalanSn} saniye sonra tekrar deneyin.`)
                };
            }
        }

        await fetch(fb(env, `RateLimits/${key}`), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ count, windowStart, lastAt: now })
        });
        return { ok: true };
    } catch (e) {
        // Sayaç yazılamadıysa isteği ENGELLEMİYORUZ — hız sınırı bir kolaylık
        // önlemi, asıl güvenlik katmanı yukarıdaki kimlik doğrulama.
        console.error('[rateLimit] hata (yoksayıldı):', e);
        return { ok: true };
    }
}

function fail(status, message) {
    return { ok: false, response: jsonError(status, message) };
}

function jsonError(status, message) {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

/**
 * A2 DUZELTMESI — KANAL DOGRULAMA
 * ============================================================================
 * Uclar istemciden gelen `channelIds` degerini oldugu gibi kullaniyordu.
 * Yetkili bile olsa, botun sunucudaki HERHANGI bir kanala yazmasi saglanabilirdi
 * (orn. yonetim kanali, baska bir ekibin kanali).
 *
 * Artik yalnizca Yonetim sayfasinda TANIMLI kanallara gonderim yapilabiliyor.
 * Tanimsiz kanal kimlikleri sessizce ELENIR.
 *
 * @returns {Promise<string[]>} izin verilen kanal kimlikleri
 */
export async function filterAllowedChannels(env, requested) {
    if (!Array.isArray(requested) || requested.length === 0) return [];
    try {
        const res = await fetch(fb(env, `GuildData/discordChannels`));
        const channels = await res.json();
        const allowed = new Set(
            (Array.isArray(channels) ? channels : Object.values(channels || {}))
                .filter(Boolean).map(ch => String(ch.id))
        );
        // Varsayilan kanal her zaman gecerli sayilir.
        if (env.DISCORD_CHANNEL_ID) allowed.add(String(env.DISCORD_CHANNEL_ID));

        const ok = requested.map(String).filter(id => allowed.has(id));
        const rejected = requested.map(String).filter(id => !allowed.has(id));
        if (rejected.length) {
            console.error('[guvenlik] tanimsiz kanala gonderim engellendi:', rejected.join(', '));
        }
        return ok;
    } catch (e) {
        console.error('filterAllowedChannels error:', e);
        return []; // Supheye dusersek HICBIR SEY gondermiyoruz.
    }
}
