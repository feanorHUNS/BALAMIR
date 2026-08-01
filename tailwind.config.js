/** Tailwind statik derleme ayarı.
 *
 * NEDEN: cdn.tailwindcss.com her sayfa açılışında 650KB'lık HTML'i tarayıp
 * CSS'i TARAYICIDA üretiyordu — sitenin yavaş açılmasının ana sebebi buydu.
 * Artık CSS bir kere burada derlenip /tailwind.css olarak sunuluyor.
 *
 * safelist: JS içinde şablonla üretilen (dosyada düz metin olarak GEÇMEYEN)
 * sınıflar. Yeni bir `text-${renk}-400` benzeri dinamik sınıf eklersen
 * buraya da eklemeyi unutma, yoksa stili çıkmaz.
 */
module.exports = {
  content: ['./index.html'],
  safelist: [
    // renderRequestColumn(color) — color: amber | emerald | red
    'text-amber-400', 'text-emerald-400', 'text-red-400',
    'text-amber-300/80', 'text-emerald-300/80', 'text-red-300/80',
    'border-amber-900/50', 'border-emerald-900/50', 'border-red-900/50',
    'border-amber-800', 'border-emerald-800', 'border-red-800',
    'bg-amber-900/20', 'bg-emerald-900/20', 'bg-red-900/20',
    'bg-amber-950/40', 'bg-emerald-950/40', 'bg-red-950/40',
  ],
  theme: { extend: {} },
  corePlugins: { preflight: true },
};
