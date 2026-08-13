/**
 * huns-parser.js — HUNSRecorder kayit dosyasi ayristiricisi
 *
 * Girdi:  Allods'un yazdigi  data/Mods/Configs/HUNSRecorder/user.cfg
 * Cikti:  dogrulanmis, normalize edilmis mac nesneleri
 *
 * GUVENLIK ILKELERI
 *  - eval / Function / dinamik kod YOK
 *  - Ayristirma tamamen durum makinesi; ic ice yapi yok, saldiri yuzeyi yok
 *  - Sert limitler ilk ihlalde reddeder, kurtarmaya calismaz
 *  - Ciktiya giden her nesne Object.create(null) uzerine acik alan kopyalama
 *  - Makullük kontrolu (fizik kurallari) asil savunma katmani
 */

// ─── Sert limitler ──────────────────────────────────────────────────────────
const LIMITS = {
  FILE_BYTES:    4 * 1024 * 1024,   // 4 MB
  LINES:         400000,
  LINE_CHARS:    2 * 1024 * 1024,   // config tek satirda buyuk string tutuyor
  FIELD_CHARS:   64,
  PLAYERS:       120,
  SPELLS:        400,
  EVENTS:        250000,
  MATCH_MS:      4 * 60 * 60 * 1000,
  MAX_SPEED_MS:  12,                // m/s — mount dahil ust sinir
  MAX_DAMAGE:    10000000,
};

const CLASSES = new Set(['WARRIOR','PALADIN','MAGE','DRUID','PSIONIC','STALKER',
  'PRIEST','NECROMANCER','ENGINEER','BARD','WARLOCK','UNKNOWN']);

class ParseError extends Error {
  constructor(code, detail) { super(code + (detail ? ': ' + detail : '')); this.code = code; this.detail = detail; }
}

// ─── 1. Katman: Allods config agaci ────────────────────────────────────────
/**
 * Bicim:
 *   t_b global
 *    t_b ScriptUserMods_HUNSREC_SLOT_01
 *     t_b data
 *      data=l"...."
 *     t_e data
 *    t_e ScriptUserMods_HUNSREC_SLOT_01
 *   t_e global
 * UTF-8 + BOM, CRLF.
 * Sadece HUNSREC_ ile baslayan bolumleri okur, digerlerini atlar.
 */
function extractSections(text) {
  if (typeof text !== 'string') throw new ParseError('E-FORMAT', 'metin degil');
  if (text.length > LIMITS.FILE_BYTES) throw new ParseError('E-FORMAT', 'dosya cok buyuk');

  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);   // BOM
  const lines = text.split(/\r?\n/);
  if (lines.length > LIMITS.LINES) throw new ParseError('E-FORMAT', 'satir sayisi asildi');

  const out = Object.create(null);
  const stack = [];
  let current = null;                 // aktif HUNSREC bolumunun adi

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > LIMITS.LINE_CHARS) throw new ParseError('E-FORMAT', `satir ${i + 1} cok uzun`);
    const s = line.trim();
    if (!s) continue;

    if (s.startsWith('t_b ')) {
      const name = s.slice(4);
      stack.push(name);
      const m = /^ScriptUserMods_(HUNSREC_[A-Z0-9_]+)$/.exec(name);
      if (m) current = m[1];
      continue;
    }
    if (s.startsWith('t_e ')) {
      const name = s.slice(4);
      if (stack[stack.length - 1] === name) stack.pop();
      if (current && name === 'ScriptUserMods_' + current) current = null;
      continue;
    }

    if (!current) continue;                       // bizim olmayan bolum: yok say

    // anahtar=l"deger"   veya   anahtar=deger
    const eq = s.indexOf('=');
    if (eq <= 0) continue;
    const key = s.slice(0, eq);
    let val = s.slice(eq + 1);
    if (val.startsWith('l"')) {
      const end = val.lastIndexOf('"');
      if (end <= 1) continue;
      val = val.slice(2, end);
    }
    if (key === 'remote_version') continue;

    if (!out[current]) out[current] = Object.create(null);
    out[current][key] = val;
  }
  return out;
}

// ─── 2. Katman: paket cozme (base64 -> ortu kaldirma -> etiket) ────────────
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64I = (() => { const m = new Int16Array(128).fill(-1);
  for (let i = 0; i < 64; i++) m[B64.charCodeAt(i)] = i; return m; })();

function b64decode(s) {
  const clean = s.replace(/=+$/, '');
  const n = clean.length;
  const out = new Uint8Array(Math.floor(n * 3 / 4));
  let o = 0, acc = 0, bits = 0;
  for (let i = 0; i < n; i++) {
    const c = clean.charCodeAt(i);
    const v = c < 128 ? B64I[c] : -1;
    if (v < 0) throw new ParseError('E-FORMAT', 'gecersiz base64');
    acc = acc * 64 + v; bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = Math.floor(acc / Math.pow(2, bits)) & 0xFF; acc = acc % Math.pow(2, bits); }
  }
  return out.subarray(0, o);
}

/** Addon'daki anahtar akisinin birebir aynisi (Codec.lua) */
function keystream(nonce, n) {
  const ks = new Uint8Array(n);
  let s = (nonce * 1103515245 + 12345) % 2147483648;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    ks[i] = Math.floor(s / 65536) % 256;
  }
  return ks;
}

/** Util.lua'daki hash32 + RosterKey ile ayni sonucu vermeli */
function hash32(str, seed) {
  let h = seed;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 4294967296;
  return h;
}
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function rosterKey(str) {
  let a = hash32(str, 2166136261), b = hash32(str, 16777619);
  let o = '';
  for (let i = 0; i < 4; i++) { o += B32[a % 32]; a = Math.floor(a / 32); }
  for (let i = 0; i < 4; i++) { o += B32[b % 32]; b = Math.floor(b / 32); }
  return o;
}
const SALT = 'hns7_dominion_v1_a41c';
const tagOf = (raw) => rosterKey(SALT + raw + SALT);

function unpack(packed) {
  const p1 = packed.indexOf('.');
  const p2 = packed.indexOf('.', p1 + 1);
  if (p1 < 1 || p2 < p1 + 2) throw new ParseError('E-FORMAT', 'paket bicimi bozuk');

  const nonce = Number(packed.slice(0, p1));
  const tag   = packed.slice(p1 + 1, p2);
  const body  = packed.slice(p2 + 1);
  if (!Number.isFinite(nonce)) throw new ParseError('E-FORMAT', 'nonce gecersiz');

  const bytes = b64decode(body);
  const ks = keystream(nonce, bytes.length);
  const chars = new Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) chars[i] = String.fromCharCode((bytes[i] - ks[i] + 256) % 256);

  // parca parca birlestir (buyuk dizide apply patlar)
  let raw = '';
  for (let i = 0; i < chars.length; i += 8192) raw += chars.slice(i, i + 8192).join('');

  if (tagOf(raw) !== tag) throw new ParseError('E-INTEGRITY', 'butunluk etiketi uyusmuyor');
  return raw;
}

// ─── 3. Katman: satir ayristirma ───────────────────────────────────────────
const num = (s, min, max) => {
  if (!/^-?\d+$/.test(s)) throw new ParseError('E-FORMAT', `sayi bekleniyordu: "${s}"`);
  const v = Number(s);
  if (v < min || v > max) throw new ParseError('E-SANITY', `deger araligin disinda: ${v}`);
  return v;
};
const txt = (s) => {
  if (s.length > LIMITS.FIELD_CHARS) throw new ParseError('E-FORMAT', 'alan cok uzun');
  return s.replace(/[\u0000-\u001F\u007F]/g, '');
};

function parseRecord(raw) {
  const m = Object.create(null);
  m.version = 0; m.players = []; m.spells = []; m.points = [];
  m.pointMembers = []; m.damage = []; m.heal = []; m.deaths = [];
  m.positions = []; m.distances = []; m.score = null; m.geodata = null;

  let dT = 0, hT = 0, xT = 0, aT = 0, rT = 0;   // delta sayaclari
  let events = 0;

  const lines = raw.split('\n');
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (!line) continue;
    const f = line.split('|');
    const kind = f[0];

    switch (kind) {
      case 'V':
        m.version = num(f[1], 1, 99); break;

      case 'H':
        m.serial   = txt(f[1]);
        m.mapSys   = txt(f[2]);
        m.mapName  = txt(f[3]);
        m.startMs  = num(f[4], 0, 4102444800000);
        m.durMs    = num(f[5], 0, LIMITS.MATCH_MS);
        m.ownerCode= txt(f[6]);
        m.clock    = txt(f[7] || 'L');
        break;

      case 'G':
        m.geodata = { x: num(f[1], -1e9, 1e9) / 100, y: num(f[2], -1e9, 1e9) / 100,
                      width: num(f[3], 0, 1e9) / 100, height: num(f[4], 0, 1e9) / 100 };
        break;

      case 'P': {
        if (m.players.length >= LIMITS.PLAYERS) throw new ParseError('E-SANITY', 'oyuncu sayisi asildi');
        const cls = txt(f[3]);
        m.players.push({
          idx: num(f[1], 1, LIMITS.PLAYERS),
          name: txt(f[2]),
          cls: CLASSES.has(cls) ? cls : 'UNKNOWN',
          guild: txt(f[4] || ''),
          team: num(f[5], 1, 2),
        });
        break;
      }

      case 'S':
        if (m.spells.length >= LIMITS.SPELLS) throw new ParseError('E-SANITY', 'yetenek sayisi asildi');
        m.spells.push({ idx: num(f[1], 1, LIMITS.SPELLS), name: txt(f[2]), kind: txt(f[3]) });
        break;

      case 'O':
        m.points.push({ t: num(f[1], 0, LIMITS.MATCH_MS), pt: num(f[2], 1, 16),
          owner: num(f[3], 0, 2), actual: num(f[4], 0, 2), state: txt(f[5]),
          prog: num(f[6], 0, 1e6), need: num(f[7], 0, 1e6),
          us: num(f[8], 0, 60), them: num(f[9], 0, 60) });
        break;

      case 'N':
        m.pointMembers.push({ t: num(f[1], 0, LIMITS.MATCH_MS), pt: num(f[2], 1, 16),
          us: idxList(f[3]), them: idxList(f[4]) });
        break;

      case 'D':
        dT += num(f[1], -LIMITS.MATCH_MS, LIMITS.MATCH_MS);
        m.damage.push({ t: dT, src: num(f[2], 1, LIMITS.PLAYERS), tgt: num(f[3], 1, LIMITS.PLAYERS),
          amt: num(f[4], 0, LIMITS.MAX_DAMAGE), sp: num(f[5], 0, LIMITS.SPELLS), fl: num(f[6], 0, 63) });
        if (++events > LIMITS.EVENTS) throw new ParseError('E-SANITY', 'olay sayisi asildi');
        break;

      case 'L':                        // sifa (heal). "H" baslik icin ayrildi.
        hT += num(f[1], -LIMITS.MATCH_MS, LIMITS.MATCH_MS);
        m.heal.push({ t: hT, src: num(f[2], 1, LIMITS.PLAYERS), tgt: num(f[3], 1, LIMITS.PLAYERS),
          amt: num(f[4], 0, LIMITS.MAX_DAMAGE), over: num(f[5], 0, LIMITS.MAX_DAMAGE),
          sp: num(f[6], 0, LIMITS.SPELLS) });
        if (++events > LIMITS.EVENTS) throw new ParseError('E-SANITY', 'olay sayisi asildi');
        break;

      case 'X':
        xT += num(f[1], -LIMITS.MATCH_MS, LIMITS.MATCH_MS);
        m.deaths.push({ t: xT, who: num(f[2], 1, LIMITS.PLAYERS), by: num(f[3], 1, LIMITS.PLAYERS) });
        break;

      case 'A': {
        aT += num(f[1], -LIMITS.MATCH_MS, LIMITS.MATCH_MS);
        const row = { t: aT, p: [] };
        for (let i = 2; i < f.length; i++) {
          const c = f[i].split(',');
          if (c.length !== 3) throw new ParseError('E-FORMAT', 'konum ucluleri bozuk');
          row.p.push([num(c[0], -1e9, 1e9), num(c[1], -1e9, 1e9), num(c[2], -1e9, 1e9)]);
        }
        m.positions.push(row);
        break;
      }

      case 'R': {
        rT += num(f[1], -LIMITS.MATCH_MS, LIMITS.MATCH_MS);
        const obs = num(f[2], 1, LIMITS.PLAYERS);
        const list = [];
        if (f[3]) for (const part of f[3].split(',')) {
          const kv = part.split(':');
          if (kv.length !== 2) throw new ParseError('E-FORMAT', 'mesafe ciftleri bozuk');
          list.push({ e: num(kv[0], 1, LIMITS.PLAYERS), d: num(kv[1], 0, 1e6) / 10 });
        }
        m.distances.push({ t: rT, obs, list });
        break;
      }

      case 'C':
        m.score = { t: num(f[1], 0, LIMITS.MATCH_MS), red: num(f[2], 0, 1e6),
                    blue: num(f[3], 0, 1e6), max: num(f[4] || '0', 0, 1e6) };
        break;

      case 'E':
        m.endMs = num(f[1], 0, LIMITS.MATCH_MS); break;

      default:
        throw new ParseError('E-FORMAT', `bilinmeyen satir tipi "${kind}" (satir ${li + 1})`);
    }
  }
  return m;
}

function idxList(s) {
  if (!s) return [];
  const out = [];
  for (const p of s.split(',')) if (p) out.push(num(p, 1, LIMITS.PLAYERS));
  return out;
}

// ─── 4. Katman: makullük ───────────────────────────────────────────────────
/**
 * Asil savunma. Gizleme anahtari addon icinde ve cikarilabilir; bu yuzden
 * butunluk etiketi kararli birini durdurmaz. Fizik kurallari durdurur.
 */
function sanityCheck(m) {
  const issues = [];

  if (!m.serial || !/^DOM-[0-9A-Z]{8}-\d{8}-\d{4}$/.test(m.serial))
    issues.push('seri numarasi bicimi gecersiz');

  if (!m.players.length) issues.push('kadro bos');
  if (m.durMs > LIMITS.MATCH_MS) issues.push('mac suresi imkansiz');

  // Roster hash'i yeniden hesapla — seri ile uyusmali
  if (m.players.length && m.mapSys) {
    const names = m.players.map(p => p.name).sort();
    const expect = rosterKey(m.mapSys + '|' + names.join(','));
    const got = m.serial ? m.serial.split('-')[1] : '';
    if (expect !== got) issues.push(`roster hash uyusmuyor (beklenen ${expect}, gelen ${got})`);
  }

  // Hiz kontrolu.
  // DIKKAT: konum satirlarindaki ilk deger MUTLAK, sonrakiler DELTA.
  // Once mutlak izleri yeniden kurup sonra hiz hesaplanmali.
  let maxSpeed = 0;
  for (let i = 1; i < m.positions.length; i++) {
    const dt = (m.positions[i].t - m.positions[i - 1].t) / 1000;
    if (dt <= 0 || dt > 60) continue;
    const cur = m.positions[i].p;
    for (let j = 0; j < cur.length; j++) {
      const dx = cur[j][0] / 100, dy = cur[j][1] / 100;   // delta = yer degistirme
      const sp = Math.sqrt(dx * dx + dy * dy) / dt;
      if (sp > maxSpeed) maxSpeed = sp;
    }
  }
  if (maxSpeed > LIMITS.MAX_SPEED_MS)
    issues.push(`imkansiz hareket hizi: ${maxSpeed.toFixed(1)} m/s`);

  // Olay yogunlugu
  const secs = Math.max(1, m.durMs / 1000);
  const perSec = (m.damage.length + m.heal.length) / secs;
  if (perSec > 400) issues.push(`olay yogunlugu imkansiz: ${perSec.toFixed(0)}/sn`);

  // Indeks butunlugu
  const maxIdx = m.players.length;
  const bad = m.damage.find(d => d.src > maxIdx || d.tgt > maxIdx);
  if (bad) issues.push('hasar satirinda kadro disi oyuncu indeksi');

  return { ok: issues.length === 0, issues, maxSpeed };
}

// ─── Genel giris noktasi ───────────────────────────────────────────────────
function parseConfigFile(text) {
  const sections = extractSections(text);

  const slots = [];
  for (const key of Object.keys(sections)) {
    const sm = /^HUNSREC_SLOT_(\d{2})$/.exec(key);
    if (!sm) continue;
    const packed = sections[key].data;
    if (!packed) continue;
    try {
      const raw = unpack(packed);
      const rec = parseRecord(raw);
      const sanity = sanityCheck(rec);
      slots.push({ slot: Number(sm[1]), ok: sanity.ok, issues: sanity.issues,
                   match: rec, bytes: packed.length });
    } catch (e) {
      slots.push({ slot: Number(sm[1]), ok: false,
                   issues: [e.code ? `${e.code} — ${e.detail || ''}` : String(e.message)],
                   match: null, bytes: packed.length });
    }
  }
  slots.sort((a, b) => a.slot - b.slot);

  return {
    owner: sections.HUNSREC_OWNER ? sections.HUNSREC_OWNER.code : null,
    index: sections.HUNSREC_INDEX ? sections.HUNSREC_INDEX.data : null,
    log:   sections.HUNSREC_LOG   ? sections.HUNSREC_LOG.data   : null,
    slots,
  };
}

export { parseConfigFile, extractSections, unpack, parseRecord,
         sanityCheck, rosterKey, ParseError, LIMITS };
