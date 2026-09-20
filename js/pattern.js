// DESEN → YÜKSEKLİK HARİTASI
//
// Burada üretilen her şey milimetredir ve Z sıfırı MALZEMENİN ÜST YÜZEYİDİR.
// Yani haritadaki bütün değerler 0 veya EKSİdir: 0 = hiç dokunulmamış üst yüzey,
// -12 = o noktada 12 mm aşağı inilmiş. CNC'ye giden G-code da birebir böyle çıkar.
//
// Yöntem: önce bir "faz alanı" hesaplanır — φ(x,y). Fazın tam sayı kısmı hangi
// bantta olduğumuzu, ondalık kısmı o bandın neresinde olduğumuzu söyler. Bandın
// kesiti (profil) ondalık kısmı yüksekliğe çevirir. Desenin karakteri tamamen
// φ'nin biçiminden gelir; profil ise oluğun ağız şeklini belirler.

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (t) => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};
const frac = (v) => v - Math.floor(v);

export const PATTERN_DEFAULTS = {
  pattern: 'twist',      // twist | spiral | ripple | fan | dune | chevron | weave | flower
  shape: 'disc',         // disc | rect | rounded
  panelW: 600,
  panelH: 600,
  cornerR: 40,
  samples: 480,          // uzun kenardaki örnek sayısı

  bands: 7,              // panel boyunca kaç bant
  arms: 2,               // spiral/fan kolu
  swirl: 2.6,            // burgu miktarı (radyan)
  swirlMode: 'merkez',   // merkez | kenar | vorteks
  falloffPow: 1.6,
  angle: 20,             // desenin genel dönüşü (derece)
  logSpiral: true,
  wave: 0.25,
  waveFreq: 2,
  petal: 0.25,

  profileKind: 'dome',   // dome | sine | oluk | vee | saw | plato
  skew: 0.25,            // -1..1 — tepe noktasını kaydırır (asimetrik sırt)
  sharpness: 1,
  plateau: 0.25,
  levels: 0,             // 0 = kapalı, >1 = kademeli (topografik) rölyef

  depth: 12,             // bant derinliği (mm)
  depthCenter: 1,        // merkezde derinlik çarpanı
  depthRim: 0.7,         // kenarda derinlik çarpanı
  domeRise: 3,           // genel kubbe/çanak yüksekliği (mm)
  domeShape: 'kubbe',    // kubbe | canak | yok
  rimWidth: 18,          // kenarda bırakılacak düz şerit (mm)
  centerFlat: 0,         // merkezdeki düz ada çapı (mm)
};

// --------------------------------------------------------------- faz alanı

function swirlAmount(r, p) {
  const rr = clamp(r, 0, 1);
  if (p.swirlMode === 'kenar') return p.swirl * Math.pow(rr, p.falloffPow);
  if (p.swirlMode === 'vorteks') return p.swirl / (rr * rr * 4 + 0.35);
  return p.swirl * Math.pow(1 - rr, p.falloffPow); // merkez
}

/**
 * Normalize edilmiş koordinatta faz. nx,ny ∈ ~[-1,1]; 1 = panelin yarı uzun kenarı.
 * Dönüş: bant cinsinden faz (tam sayı farkı = bir bant).
 */
export function phaseAt(nx, ny, p) {
  const a = (p.angle * Math.PI) / 180;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  let u = nx * ca - ny * sa;
  let v = nx * sa + ny * ca;
  const r = Math.hypot(nx, ny);
  const th = Math.atan2(ny, nx);
  const bands = Math.max(0.5, p.bands);

  switch (p.pattern) {
    case 'twist': {
      // Kenarda düze yakın paralel bantlar, merkeze doğru S kıvrımı: fotoğraftaki iş.
      const t = swirlAmount(r, p);
      const c = Math.cos(t);
      const s = Math.sin(t);
      const ur = u * c - v * s;
      return (bands * (ur + 1)) / 2;
    }
    case 'spiral': {
      const rr = Math.max(r, 0.015);
      const radial = p.logSpiral
        ? Math.log(rr / 0.015) / Math.log(1 / 0.015)
        : rr;
      return bands * radial - (p.arms * th) / TAU;
    }
    case 'ripple':
      return bands * r;
    case 'fan':
      return (Math.max(1, Math.round(p.arms)) * th) / TAU;
    case 'dune':
      return (bands * (u + 1)) / 2 + p.wave * Math.sin(Math.PI * v * p.waveFreq);
    case 'chevron':
      return (bands * (u + 1 + p.wave * 2 * Math.abs(v))) / 2;
    case 'weave':
      // İki dik bant ailesi; yükseklik aşamasında büyüğü alınır (örgü etkisi).
      return (bands * (u + 1)) / 2;
    case 'flower':
      return bands * r * (1 + p.petal * Math.cos(Math.max(1, Math.round(p.arms)) * th));
    default:
      return (bands * (u + 1)) / 2;
  }
}

/** Örgü deseninin ikinci (dik) bant ailesi. */
function phaseAt2(nx, ny, p) {
  const a = (p.angle * Math.PI) / 180 + Math.PI / 2;
  const u = nx * Math.cos(a) - ny * Math.sin(a);
  return (Math.max(0.5, p.bands) * (u + 1)) / 2;
}

// ------------------------------------------------------------------ profil

/** Tepe noktasını kaydırır: skew>0 ise sırtın bir yanı dikleşir. */
function skewT(t, skew) {
  const s = clamp(0.5 + skew * 0.45, 0.06, 0.94);
  return t < s ? (0.5 * t) / s : 0.5 + (0.5 * (t - s)) / (1 - s);
}

/**
 * Bandın kesiti. t ∈ [0,1) → 0..1 yükseklik (1 = üst yüzey, 0 = bandın dibi).
 */
export function profile(t, p) {
  const x = skewT(frac(t), p.skew);
  let h;
  switch (p.profileKind) {
    case 'sine':
      h = (1 - Math.cos(TAU * x)) / 2;
      break;
    case 'oluk': {
      // Yuvarlak dipli oluk, keskin sırt — bilya freze dibi tam oturur.
      const d = 2 * x - 1;
      h = 1 - Math.sqrt(Math.max(0, 1 - d * d));
      break;
    }
    case 'vee':
      h = 1 - Math.abs(2 * x - 1);
      break;
    case 'saw':
      h = x;
      break;
    case 'plato': {
      const pl = clamp(p.plateau, 0, 0.9);
      const edge = (1 - pl) / 2;
      if (x < edge) h = x / edge;
      else if (x > 1 - edge) h = (1 - x) / edge;
      else h = 1;
      break;
    }
    case 'dome':
    default: {
      // Yarım daire sırt: dolu, etli görünüm — fotoğraftaki kabartma bu.
      const d = 2 * x - 1;
      h = Math.sqrt(Math.max(0, 1 - d * d));
      break;
    }
  }
  h = clamp(h, 0, 1);
  if (p.sharpness !== 1) h = Math.pow(h, Math.max(0.15, p.sharpness));
  return h;
}

// ------------------------------------------------------------------ kalıp

/** Panel kenarına uzaklık (mm). Dışarıda negatif. */
function edgeDistance(x, y, p) {
  const cx = p.panelW / 2;
  const cy = p.panelH / 2;
  if (p.shape === 'disc') {
    const rx = (x - cx) / cx;
    const ry = (y - cy) / cy;
    const rr = Math.hypot(rx, ry);
    return (1 - rr) * Math.min(cx, cy);
  }
  if (p.shape === 'rounded') {
    const r = clamp(p.cornerR, 0, Math.min(cx, cy));
    const qx = Math.abs(x - cx) - (cx - r);
    const qy = Math.abs(y - cy) - (cy - r);
    if (qx > 0 && qy > 0) return r - Math.hypot(qx, qy);
    return r - Math.max(qx, qy);
  }
  return Math.min(x, p.panelW - x, y, p.panelH - y);
}

function baseZ(r, p) {
  const rr = clamp(r, 0, 1);
  if (p.domeShape === 'kubbe') return -p.domeRise * (1 - Math.sqrt(Math.max(0, 1 - rr * rr)));
  if (p.domeShape === 'canak') return -p.domeRise * (1 - rr * rr);
  return 0;
}

// ------------------------------------------------------------------ yüzey

/**
 * Tüm yüzeyi örnekler.
 * @returns {{w,h,mmPerPx,mmPerPy,panelW,panelH,z:Float32Array,phase:Float32Array,
 *            inside:Uint8Array,minZ:number,params:object}}
 *   z[row*w+col] — mm, ≤ 0. row 0 = y=0 (aşağı), y yukarı artar (makine düzeni).
 */
export function buildSurface(params) {
  const p = { ...PATTERN_DEFAULTS, ...params };
  const long = Math.max(p.panelW, p.panelH);
  const n = clamp(Math.round(p.samples), 64, 1400);
  const w = Math.max(16, Math.round((n * p.panelW) / long));
  const h = Math.max(16, Math.round((n * p.panelH) / long));
  const mmPerPx = p.panelW / (w - 1);
  const mmPerPy = p.panelH / (h - 1);
  const cx = p.panelW / 2;
  const cy = p.panelH / 2;
  const R = long / 2;

  const z = new Float32Array(w * h);
  const phase = new Float32Array(w * h);
  const inside = new Uint8Array(w * h);
  const levels = Math.round(p.levels);
  let minZ = 0;

  for (let row = 0; row < h; row++) {
    const y = row * mmPerPy;
    for (let col = 0; col < w; col++) {
      const x = col * mmPerPx;
      const i = row * w + col;
      const nx = (x - cx) / R;
      const ny = (y - cy) / R;
      const r = Math.hypot(nx, ny);

      const ph = phaseAt(nx, ny, p);
      phase[i] = ph;

      let hgt = profile(ph, p);
      if (p.pattern === 'weave') hgt = Math.max(hgt, profile(phaseAt2(nx, ny, p), p));
      if (levels > 1) hgt = Math.round(hgt * levels) / levels;

      const amp = lerp(p.depthCenter, p.depthRim, clamp(r, 0, 1));
      let zz = -(1 - hgt) * p.depth * Math.max(0, amp) + baseZ(r, p);

      // Merkezde düz ada.
      if (p.centerFlat > 0) {
        const dc = Math.hypot(x - cx, y - cy);
        const k = smoothstep((dc - p.centerFlat / 2) / Math.max(1, p.centerFlat / 2));
        zz *= k;
      }

      // Kenarda düz şerit: rölyef sıfıra (üst yüzeye) doğru söner.
      const de = edgeDistance(x, y, p);
      inside[i] = de >= 0 ? 1 : 0;
      if (p.rimWidth > 0) {
        const k = smoothstep(de / p.rimWidth);
        zz *= k;
      }
      if (de < 0) zz = 0;

      z[i] = zz > 0 ? 0 : zz;
      if (z[i] < minZ) minZ = z[i];
    }
  }

  return {
    w, h, mmPerPx, mmPerPy,
    panelW: p.panelW, panelH: p.panelH,
    z, phase, inside, minZ, params: p,
  };
}

/** mm koordinatından çift doğrusal (bilinear) Z okuma. Dışarısı için en yakın kenar. */
export function sampleZ(surf, x, y) {
  const fx = clamp(x / surf.mmPerPx, 0, surf.w - 1);
  const fy = clamp(y / surf.mmPerPy, 0, surf.h - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(surf.w - 1, x0 + 1);
  const y1 = Math.min(surf.h - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const a = surf.z[y0 * surf.w + x0];
  const b = surf.z[y0 * surf.w + x1];
  const c = surf.z[y1 * surf.w + x0];
  const d = surf.z[y1 * surf.w + x1];
  return lerp(lerp(a, b, tx), lerp(c, d, tx), ty);
}

/** Nokta panelin içinde mi (kenardan `inset` mm içeride mi)? */
export function isInside(surf, x, y, inset = 0) {
  return edgeDistance(x, y, surf.params) >= inset;
}

export { edgeDistance, smoothstep, clamp };
