// G-CODE ÜRETİCİ
//
// Yolları makinenin anlayacağı satırlara çevirir. Z değerleri malzeme üst
// yüzeyine göre EKSİ yazılır (G54 sıfırını malzemenin üstüne alacaksınız),
// güvenli yükseklik artıdır. Birim mm (G21), mutlak konum (G90).
//
// Bağlantı (link) hareketleri: iki yol arası mesafe kısaysa takım tepeye kadar
// çıkmaz; aradaki yüzeyin EN YÜKSEK noktası örneklenip onun `clearZ` kadar
// üstünden geçilir. Satır başlarında tepeye çıkıp inmek, uzun bir finişte
// saatlere mal olur.
//
// Bu alçak bağlantılar G0 ile DEĞİL, kesme hızında (G1) yazılır: kaba pasodan
// artakalan bir kabartmaya denk gelirse normal bir talaş olur, çarpma olmaz.
// Böylece programdaki HER hızlı hareket ham yüzeyin üstünde kalır.

import { sampleZ } from './pattern.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export const POST_DEFAULTS = {
  flavor: 'grbl',        // grbl | mach3 | fanuc
  origin: 'center',      // center | corner  — X0Y0 nerede
  safeZ: 6,              // tam geri çekilme (mm, artı)
  clearZ: 1.5,           // kısa bağlantılarda yüzeyden yükseklik (mm)
  linkDist: 4,           // bu mesafeden kısa atlamalarda tepeye çıkma (mm)
  feedXY: 2200,          // mm/dk
  feedPlunge: 500,       // mm/dk (Z dalış)
  feedRough: 2800,
  rapidRate: 5000,       // süre tahmini için
  spindle: 18000,
  toolNumber: 1,
  programNumber: 1001,
  decimals: 3,
  coolant: false,
  pauseOnToolChange: true,
  endWithM30: true,
};

function fmt(v, d) {
  if (!Number.isFinite(v)) v = 0;
  let s = v.toFixed(d);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  if (s === '-0') s = '0';
  return s;
}

/**
 * @param {object} result buildToolpaths() çıktısı
 * @param {object} surf   buildSurface() çıktısı
 * @param {object} postIn post ayarları
 * @param {(x:number,y:number)=>number} [probe] bağlantı için yüzey Z okuyucu
 */
export function toGcode(result, surf, postIn, probe) {
  const post = { ...POST_DEFAULTS, ...postIn };
  const d = clamp(Math.round(post.decimals), 1, 4);
  const offX = post.origin === 'center' ? -surf.panelW / 2 : 0;
  const offY = post.origin === 'center' ? -surf.panelH / 2 : 0;
  const safeZ = Math.abs(post.safeZ);

  const L = [];
  let cur = { x: null, y: null, z: null, f: null };
  let cutLen = 0;
  let rapidLen = 0;
  let plungeLen = 0;
  let minZ = 0;
  const bbox = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };

  // Eski kontrolcüler (NCStudio, bazı Fanuc türevleri) ASCII dışı karakterde
  // takılır; yorumlar bu yüzden sadeleştirilir.
  const ascii = (t) =>
    String(t)
      .replace(/[çÇ]/g, 'c').replace(/[ğĞ]/g, 'g').replace(/[ıİ]/g, 'i')
      .replace(/[öÖ]/g, 'o').replace(/[şŞ]/g, 's').replace(/[üÜ]/g, 'u')
      .replace(/[—–]/g, '-').replace(/[·•]/g, '-')
      .replace(/[^\x20-\x7E]/g, '')
      .replace(/[()]/g, '');
  const cm = (t) => (post.flavor === 'fanuc' ? `(${ascii(t)})` : `; ${ascii(t)}`);

  function moveG0(x, y, z) {
    const parts = ['G0'];
    if (x !== undefined && (cur.x === null || Math.abs(x - cur.x) > 1e-4)) parts.push('X' + fmt(x, d));
    if (y !== undefined && (cur.y === null || Math.abs(y - cur.y) > 1e-4)) parts.push('Y' + fmt(y, d));
    if (z !== undefined && (cur.z === null || Math.abs(z - cur.z) > 1e-4)) parts.push('Z' + fmt(z, d));
    if (parts.length === 1) return;
    rapidLen += dist(x, y, z);
    if (x !== undefined) cur.x = x;
    if (y !== undefined) cur.y = y;
    if (z !== undefined) cur.z = z;
    L.push(parts.join(' '));
  }

  function moveG1(x, y, z, feed, kind) {
    const parts = ['G1'];
    let moved = false;
    if (x !== undefined && (cur.x === null || Math.abs(x - cur.x) > 1e-4)) { parts.push('X' + fmt(x, d)); moved = true; }
    if (y !== undefined && (cur.y === null || Math.abs(y - cur.y) > 1e-4)) { parts.push('Y' + fmt(y, d)); moved = true; }
    if (z !== undefined && (cur.z === null || Math.abs(z - cur.z) > 1e-4)) { parts.push('Z' + fmt(z, d)); moved = true; }
    if (!moved) return;
    if (cur.f === null || Math.abs(feed - cur.f) > 0.5) { parts.push('F' + Math.round(feed)); cur.f = feed; }
    const dl = dist(x, y, z);
    if (kind === 'plunge') plungeLen += dl; else cutLen += dl;
    if (x !== undefined) { cur.x = x; if (x < bbox.x0) bbox.x0 = x; if (x > bbox.x1) bbox.x1 = x; }
    if (y !== undefined) { cur.y = y; if (y < bbox.y0) bbox.y0 = y; if (y > bbox.y1) bbox.y1 = y; }
    if (z !== undefined) { cur.z = z; if (z < minZ) minZ = z; }
    L.push(parts.join(' '));
  }

  function dist(x, y, z) {
    const dx = x === undefined || cur.x === null ? 0 : x - cur.x;
    const dy = y === undefined || cur.y === null ? 0 : y - cur.y;
    const dz = z === undefined || cur.z === null ? 0 : z - cur.z;
    return Math.hypot(dx, dy, dz);
  }

  // Her pasonun bağlantıları kendi takımının haritasına göre yükseltilir.
  let activeProbe = probe;

  /** İki nokta arasındaki yüzeyin en yükseği (panel koordinatında). */
  function ridgeZ(ax, ay, bx, by) {
    const probe = activeProbe;
    if (!probe) return null;
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.max(4, Math.ceil(len / 0.5));
    let m = -Infinity;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const v = probe(ax + (bx - ax) * t, ay + (by - ay) * t);
      if (v > m) m = v;
    }
    return m;
  }

  // ------------------------------------------------------------- başlık
  if (post.flavor === 'fanuc') {
    L.push('%');
    L.push(`O${String(post.programNumber).padStart(4, '0')}`);
  }
  L.push(cm('3 eksen rolyef — Parametrik CNC Duvar Paneli'));
  L.push(cm(`Panel: ${fmt(surf.panelW, 1)} x ${fmt(surf.panelH, 1)} mm, sekil: ${surf.params.shape}`));
  L.push(cm(`Sifir: ${post.origin === 'center' ? 'PANEL MERKEZI' : 'SOL ALT KOSE'}, Z0 = MALZEME UST YUZEYI`));
  L.push(cm(`En derin nokta: ${fmt(result.stats.minZ, 2)} mm`));
  L.push(cm(`Guvenli yukseklik: +${fmt(safeZ, 1)} mm`));
  for (const pass of result.passes) L.push(cm(`Paso: ${pass.name}`));
  L.push(cm('DIKKAT: ilk calistirmadan once havada (Z+50) prova edin.'));
  L.push('G21 G90 G94 G17');
  if (post.flavor === 'fanuc') L.push('G40 G49 G80');
  L.push('G54');
  L.push(`G0 Z${fmt(safeZ, d)}`);
  cur.z = safeZ;

  // -------------------------------------------------------------- pasolar
  let started = false;
  let lastToolKey = null;
  for (const pass of result.passes) {
    const toolKey = `${pass.tool.type}-${pass.tool.dia}-${pass.tool.angle || ''}-${pass.tool.cornerR || ''}`;
    L.push(cm('-'.repeat(48)));
    L.push(cm(pass.name));

    if (!started) {
      if (post.flavor === 'fanuc') L.push(`T${post.toolNumber} M6`);
      L.push(`M3 S${Math.round(post.spindle)}`);
      if (post.coolant) L.push('M8');
      started = true;
    } else if (toolKey !== lastToolKey) {
      L.push('M5');
      L.push(`G0 Z${fmt(safeZ, d)}`); cur.z = safeZ;
      L.push(cm(`TAKIM DEGISTIR -> ${pass.name}`));
      L.push(cm('Yeni takimi taktiktan sonra Z SIFIRINI TEKRAR ALIN.'));
      if (post.pauseOnToolChange) L.push('M0');
      L.push(`M3 S${Math.round(post.spindle)}`);
    }
    lastToolKey = toolKey;

    const feed = pass.id === 'rough' ? post.feedRough : post.feedXY;
    activeProbe = pass.linkMap ? (x, y) => sampleZ(pass.linkMap, x, y) : probe;
    let prevEnd = null;

    for (const path of pass.paths) {
      if (path.length < 6) continue;
      const sx = path[0] + offX;
      const sy = path[1] + offY;
      const sz = path[2];

      // Bağlantı: kısa mesafede alçak geç, uzunsa tepeye çık.
      const gap = prevEnd ? Math.hypot(path[0] - prevEnd[0], path[1] - prevEnd[1]) : Infinity;
      let linkZ = safeZ;
      if (prevEnd && gap <= post.linkDist && !pass.cutout) {
        const top = ridgeZ(prevEnd[0], prevEnd[1], path[0], path[1]);
        if (top !== null) linkZ = Math.min(safeZ, top + Math.abs(post.clearZ));
      }
      if (linkZ >= safeZ - 1e-6) {
        moveG0(undefined, undefined, safeZ);
        moveG0(sx, sy, undefined);
      } else {
        // Kısa bağlantı: alçaktan geçiliyor, bu yüzden HIZLI değil KESME
        // hızında. Kaba pasodan artakalan bir kabartmaya denk gelse bile
        // normal bir talaş olur, çarpma olmaz. Birkaç milimetre için kaybedilen
        // süre, her satır başında tepeye çıkmanın yanında hiçtir.
        moveG1(undefined, undefined, linkZ, feed, 'cut');
        moveG1(sx, sy, undefined, feed, 'cut');
      }
      // Havadaki iniş hızlı olsun: malzemenin üstünde `clearZ` kadar boşluk
      // bırakacak yere kadar G0 ile inilir, kalan kısım dalış hızıyla. Sınır
      // olarak 0 (ham yüzey) değil, onun `clearZ` kadar üstü alınır; tahta
      // hafif kamburlaysa bile hızlı hareket malzemeye değmez.
      const guard = Math.abs(post.clearZ);
      const preZ = Math.max(guard, Math.min(cur.z, sz + guard));
      if (preZ < cur.z - 1e-4) moveG0(undefined, undefined, preZ);
      moveG1(undefined, undefined, sz, post.feedPlunge, 'plunge');

      for (let i = 3; i < path.length; i += 3) {
        moveG1(path[i] + offX, path[i + 1] + offY, path[i + 2], feed, 'cut');
      }
      prevEnd = [path[path.length - 3], path[path.length - 2]];
    }
    L.push(`G0 Z${fmt(safeZ, d)}`); cur.z = safeZ;
  }

  // --------------------------------------------------------------- bitiş
  L.push('M5');
  if (post.coolant) L.push('M9');
  L.push(`G0 Z${fmt(safeZ, d)}`);
  if (post.flavor === 'mach3' || post.flavor === 'fanuc') L.push('G0 X0 Y0');
  if (post.endWithM30) L.push('M30');
  if (post.flavor === 'fanuc') L.push('%');

  const timeMin =
    cutLen / Math.max(1, post.feedXY) +
    plungeLen / Math.max(1, post.feedPlunge) +
    rapidLen / Math.max(1, post.rapidRate);

  return {
    text: L.join('\n') + '\n',
    stats: {
      lines: L.length,
      cutLength: cutLen,
      rapidLength: rapidLen,
      timeMin,
      minZ,
      bbox: Number.isFinite(bbox.x0) ? bbox : { x0: 0, y0: 0, x1: 0, y1: 0 },
    },
  };
}

export function flavorLabel(f) {
  return { grbl: 'GRBL / Candle / UGS', mach3: 'Mach3 / Mach4', fanuc: 'Fanuc / NCStudio' }[f] || f;
}
