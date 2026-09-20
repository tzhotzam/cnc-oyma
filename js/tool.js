// TAKIM GEOMETRİSİ ve TAKIM TELAFİSİ (drop-cutter)
//
// Neden gerekli: yüzeyin Z haritası, yüzeyin kendisidir — takımın MERKEZİNİN
// gideceği yol değil. 6 mm'lik bir bilya freze, 2 mm genişliğindeki bir oluğun
// dibine zaten giremez; oraya kadar indirirsen kenarları yer (gouge). Doğrusu:
// takımı her noktada yüzeye DEĞENE KADAR indirip, tam değdiği yüksekliği yola
// yazmaktır. Matematiksel olarak:
//
//     zt(x,y) = max over (dx,dy)  [ z(x+dx, y+dy) − dz(√(dx²+dy²)) ]
//
// dz(r): takımın ucundan r kadar yanda, takım alt yüzeyinin ne kadar yukarıda
// olduğu. Bilyada dz = R − √(R²−r²), düz frezede 0, V uçta r/tan(θ/2).
// Bu işlem gri-seviye "genleşme" (dilation) ile aynı şeydir.

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export const TOOL_DEFAULTS = {
  type: 'ball',   // ball | flat | bull | vbit
  dia: 6,
  cornerR: 1,     // bull için
  angle: 90,      // vbit için (tam açı, derece)
};

/** Takımın yarıçapı — telafi yarıçapı olarak kullanılır. */
export function toolRadius(tool) {
  return Math.max(0.05, tool.dia / 2);
}

/**
 * Uç profili: merkezden r mm yanda takım alt yüzeyi kaç mm yukarıda?
 * r > yarıçap için Infinity (takım oraya değmez).
 */
export function tipRise(tool, r) {
  const R = toolRadius(tool);
  if (r > R) return Infinity;
  switch (tool.type) {
    case 'flat':
      return 0;
    case 'bull': {
      const cr = clamp(tool.cornerR, 0, R);
      const flat = R - cr;
      if (r <= flat || cr <= 0) return 0;
      const d = r - flat;
      return cr - Math.sqrt(Math.max(0, cr * cr - d * d));
    }
    case 'vbit': {
      const half = (clamp(tool.angle, 5, 179) / 2) * (Math.PI / 180);
      return r / Math.tan(half);
    }
    case 'ball':
    default:
      return R - Math.sqrt(Math.max(0, R * R - r * r));
  }
}

/**
 * Yan yana iki paso arasında kalan iz yüksekliği, mm.
 *
 * Bilya ve köşe radüslü uçta bu bir TIRTIK'tır (scallop): iki dairenin
 * arasında kalan sırt, R − √(R²−(a/2)²). Uç yarıçapı işi belirler, yüzeyin
 * eğimi değil.
 *
 * DÜZ FREZEDE bambaşka bir şey olur. Düz uç yüzeye ucuyla değil kenarıyla
 * değer; yamaçta altındaki en yüksek noktaya oturur ve o bölgeyi düzleştirir.
 * Geriye tırtık değil KADEME kalır ve kademenin boyu yüzeyin eğimine bağlıdır:
 *
 *     kademe ≈ yanal adım × tan(eğim)
 *
 * Yani düz frezede iz, ucun çapıyla değil desenin dikliğiyle belirlenir —
 * dümdüz bir yüzeyde sıfır, dik yamaçta adımın kendisi kadar.
 *
 * @param {number} [slopeTan] yüzeyin eğim tanjantı (düz freze için gerekli)
 */
export function scallopHeight(tool, stepover, slopeTan = 0) {
  const s = Math.abs(stepover);
  if (tool.type === 'flat') return s * Math.max(0, slopeTan);
  const R = tool.type === 'bull' ? clamp(tool.cornerR, 0.01, toolRadius(tool)) : toolRadius(tool);
  if (s >= 2 * R) return R;
  return R - Math.sqrt(Math.max(0, R * R - (s / 2) * (s / 2)));
}

/** İstenen iz yüksekliği için gereken yanal adım (mm). */
export function stepoverForScallop(tool, scallop, slopeTan = 0) {
  if (tool.type === 'flat') {
    const t = Math.max(0.02, slopeTan);
    return clamp(scallop / t, 0.02, toolRadius(tool) * 1.8);
  }
  const R = tool.type === 'bull' ? clamp(tool.cornerR, 0.01, toolRadius(tool)) : toolRadius(tool);
  const c = clamp(scallop, 0.001, R * 0.98);
  return 2 * Math.sqrt(Math.max(0, R * R - (R - c) * (R - c)));
}

/**
 * Yüzeyin eğim tanjantı — varsayılan olarak MEDYAN, yani tipik eğim.
 *
 * Neden en dik nokta değil: kademeli bir tasarımda basamak duvarları neredeyse
 * diktir ama duvar pasolar arası iz bırakmaz, takım onu yanıyla keser. Yüksek
 * yüzdelik alırsak böyle bir yüzeyde "korkunç kademe kalacak" deriz, oysa
 * yüzeyin çoğu kusursuz çıkar. Medyan, yüzeyin ağırlıklı kısmını temsil eder.
 *
 * Bu yalnızca pasolar arası iz TAHMİNİdir. Takımın geometrik olarak
 * giremediği yerler ayrı bir iştir; onu machinedSurface() birebir hesaplar.
 */
export function slopeTangent(surf, q = 0.5) {
  const { w, h, z, mmPerPx, mmPerPy, inside } = surf;
  const vals = [];
  for (let r = 1; r < h - 1; r += 2) {
    for (let c = 1; c < w - 1; c += 2) {
      if (inside && !inside[r * w + c]) continue;
      const gx = (z[r * w + c + 1] - z[r * w + c - 1]) / (2 * mmPerPx);
      const gy = (z[(r + 1) * w + c] - z[(r - 1) * w + c]) / (2 * mmPerPy);
      vals.push(Math.hypot(gx, gy));
    }
  }
  if (!vals.length) return 0;
  vals.sort((a, b) => a - b);
  return vals[Math.min(vals.length - 1, Math.floor(q * vals.length))];
}

/**
 * Takım telafisi. Yüzey haritasından takım MERKEZ YÜKSEKLİĞİ haritası üretir.
 * @param {{w,h,mmPerPx,mmPerPy,z:Float32Array}} surf
 * @param {object} tool
 * @param {number} [maxKernel] çekirdekteki en fazla örnek sayısı (hız sınırı)
 * @returns {{z:Float32Array, maxLift:number, kernelPts:number}}
 *   maxLift: takım çapı yüzünden yüzeye inilemeyen en büyük fark (mm).
 */
export function compensate(surf, tool, maxKernel = 9000) {
  const { w, h, z, mmPerPx, mmPerPy } = surf;
  const R = toolRadius(tool);
  const rx = Math.floor(R / mmPerPx);
  const ry = Math.floor(R / mmPerPy);
  const out = new Float32Array(z.length);

  if (rx < 1 && ry < 1) {
    out.set(z);
    return { z: out, maxLift: 0, kernelPts: 1 };
  }

  // Çekirdek: (dx,dy) → yükselme. Çok büyük takımlarda seyreltilir.
  const full = (2 * rx + 1) * (2 * ry + 1);
  const stride = Math.max(1, Math.ceil(Math.sqrt(full / maxKernel)));
  const ox = [];
  const oy = [];
  const orise = [];
  for (let dy = -ry; dy <= ry; dy += stride) {
    for (let dx = -rx; dx <= rx; dx += stride) {
      const r = Math.hypot(dx * mmPerPx, dy * mmPerPy);
      const rise = tipRise(tool, r);
      if (!Number.isFinite(rise)) continue;
      ox.push(dx);
      oy.push(dy);
      orise.push(rise);
    }
  }
  // Merkez her hâlükârda olmalı (seyreltme onu atlayabilir).
  if (!ox.includes(0) || !oy.includes(0)) {
    ox.push(0); oy.push(0); orise.push(0);
  }

  const n = ox.length;
  let maxLift = 0;
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      let best = -Infinity;
      for (let k = 0; k < n; k++) {
        const cx = col + ox[k];
        if (cx < 0 || cx >= w) continue;
        const cy = row + oy[k];
        if (cy < 0 || cy >= h) continue;
        const v = z[cy * w + cx] - orise[k];
        if (v > best) best = v;
      }
      const i = row * w + col;
      const val = best === -Infinity ? z[i] : best;
      out[i] = val;
      const lift = val - z[i];
      if (lift > maxLift) maxLift = lift;
    }
  }
  return { z: out, maxLift, kernelPts: n };
}

/** Telafili haritayı yüzey nesnesi gibi kullanabilmek için sarmalar. */
export function withZ(surf, z) {
  return { ...surf, z };
}

/**
 * GERÇEKTE ÇIKACAK YÜZEY.
 * Takım merkez yüksekliği haritasından, takımın malzemede bıraktığı yüzeyi
 * geri hesaplar — telafinin tersi (aşındırma / erosion):
 *
 *     zg(x,y) = min over (dx,dy) [ zt(x+dx,y+dy) + dz(√(dx²+dy²)) ]
 *
 * Önizleme bunu gösterir; böylece "6 mm uçla bu oluk ne kadar yuvarlanır"
 * sorusunun cevabı makineye gitmeden ekranda görünür.
 */
export function machinedSurface(surf, ztMap, tool, maxKernel = 9000) {
  const { w, h, mmPerPx, mmPerPy } = surf;
  const z = ztMap;
  const R = toolRadius(tool);
  const rx = Math.floor(R / mmPerPx);
  const ry = Math.floor(R / mmPerPy);
  const out = new Float32Array(z.length);
  if (rx < 1 && ry < 1) { out.set(z); return out; }

  const full = (2 * rx + 1) * (2 * ry + 1);
  const stride = Math.max(1, Math.ceil(Math.sqrt(full / maxKernel)));
  const ox = []; const oy = []; const orise = [];
  for (let dy = -ry; dy <= ry; dy += stride) {
    for (let dx = -rx; dx <= rx; dx += stride) {
      const rise = tipRise(tool, Math.hypot(dx * mmPerPx, dy * mmPerPy));
      if (!Number.isFinite(rise)) continue;
      ox.push(dx); oy.push(dy); orise.push(rise);
    }
  }
  const n = ox.length;
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      let best = Infinity;
      for (let k = 0; k < n; k++) {
        const cx = col + ox[k];
        if (cx < 0 || cx >= w) continue;
        const cy = row + oy[k];
        if (cy < 0 || cy >= h) continue;
        const v = z[cy * w + cx] + orise[k];
        if (v < best) best = v;
      }
      out[row * w + col] = best === Infinity ? z[row * w + col] : Math.min(0, best);
    }
  }
  return out;
}
