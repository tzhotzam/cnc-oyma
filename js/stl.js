// STL (3B model) girişi → yükseklik haritası.
//
// Model tepeden ortografik olarak "z-buffer" ile taranır: her ızgara
// hücresinde en yüksek Z tutulur. Rölyef zaten tek yönden bakılan bir
// yüzeydir; modelin altında kalan, arkaya bakan yüzeyler oyulamaz — bu
// tarama tam olarak freze ucunun yukarıdan görebildiğini verir.

/**
 * ASCII veya ikili STL ayrıştırır.
 * @param {ArrayBuffer} buffer
 * @returns {Array<Array<[number,number,number]>>} üçgenler
 */
export function parseStl(buffer) {
  const bytes = new Uint8Array(buffer);
  if (isBinaryStl(bytes)) return parseBinaryStl(buffer);
  return parseAsciiStl(new TextDecoder().decode(bytes));
}

function isBinaryStl(bytes) {
  if (bytes.length < 84) return false;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = dv.getUint32(80, true);
  if (84 + count * 50 === bytes.length) return true;
  // Boyut uymuyorsa "solid" başlığına bak.
  let head = '';
  for (let i = 0; i < 5; i++) head += String.fromCharCode(bytes[i]);
  return head.toLowerCase() !== 'solid';
}

function parseBinaryStl(buffer) {
  const dv = new DataView(buffer);
  const count = dv.getUint32(80, true);
  const tris = [];
  for (let i = 0; i < count; i++) {
    const o = 84 + i * 50 + 12; // normal atlanır
    const v = [];
    for (let k = 0; k < 3; k++) {
      v.push([
        dv.getFloat32(o + k * 12, true),
        dv.getFloat32(o + k * 12 + 4, true),
        dv.getFloat32(o + k * 12 + 8, true),
      ]);
    }
    tris.push(v);
  }
  return tris;
}

function parseAsciiStl(text) {
  const tris = [];
  const re = /vertex\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)/g;
  let m;
  let cur = [];
  while ((m = re.exec(text)) !== null) {
    cur.push([parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])]);
    if (cur.length === 3) {
      tris.push(cur);
      cur = [];
    }
  }
  return tris;
}

export function stlBounds(tris) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const t of tris) {
    for (const [x, y, z] of t) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
  }
  return { minX, minY, minZ, maxX, maxY, maxZ, w: maxX - minX, h: maxY - minY, d: maxZ - minZ };
}

/** Bakış eksenine göre üçgenleri döndürür (varsayılan Z = tepeden). */
function orient(tris, axis) {
  if (axis === 'y') return tris.map((t) => t.map(([x, y, z]) => [x, z, y]));
  if (axis === 'x') return tris.map((t) => t.map(([x, y, z]) => [y, z, x]));
  return tris;
}

/**
 * Tepeden tarama. Izgarada SATIR 0 = y=0, yani aşağısı (makine düzeni).
 * @returns {{w,h,data:Float32Array,hit:Uint8Array,bounds:object,coverage:number}}
 *   data: 0..1 yükseklik; hit: o hücreye model değdi mi
 */
export function scanStl(tris, cols, rows, opts = {}) {
  const t3 = orient(tris, opts.axis || 'z');
  const b = stlBounds(t3);
  const data = new Float32Array(cols * rows);
  const hit = new Uint8Array(cols * rows);
  if (!Number.isFinite(b.w) || b.w <= 0 || b.h <= 0) {
    return { w: cols, h: rows, data, hit, bounds: b, coverage: 0 };
  }

  const zbuf = new Float32Array(cols * rows).fill(-Infinity);
  const sx = (cols - 1) / b.w;
  const sy = (rows - 1) / b.h;

  for (const t of t3) {
    // gy = 0 modelin ALT kenarı olsun; ızgaramız yukarı doğru artıyor.
    const p = [
      [(t[0][0] - b.minX) * sx, (t[0][1] - b.minY) * sy, t[0][2]],
      [(t[1][0] - b.minX) * sx, (t[1][1] - b.minY) * sy, t[1][2]],
      [(t[2][0] - b.minX) * sx, (t[2][1] - b.minY) * sy, t[2][2]],
    ];
    const minX = Math.max(0, Math.floor(Math.min(p[0][0], p[1][0], p[2][0])));
    const maxX = Math.min(cols - 1, Math.ceil(Math.max(p[0][0], p[1][0], p[2][0])));
    const minY = Math.max(0, Math.floor(Math.min(p[0][1], p[1][1], p[2][1])));
    const maxY = Math.min(rows - 1, Math.ceil(Math.max(p[0][1], p[1][1], p[2][1])));

    const d = (p[1][1] - p[2][1]) * (p[0][0] - p[2][0]) + (p[2][0] - p[1][0]) * (p[0][1] - p[2][1]);
    if (Math.abs(d) < 1e-12) continue;

    for (let gy = minY; gy <= maxY; gy++) {
      for (let gx = minX; gx <= maxX; gx++) {
        const l0 = ((p[1][1] - p[2][1]) * (gx - p[2][0]) + (p[2][0] - p[1][0]) * (gy - p[2][1])) / d;
        const l1 = ((p[2][1] - p[0][1]) * (gx - p[2][0]) + (p[0][0] - p[2][0]) * (gy - p[2][1])) / d;
        const l2 = 1 - l0 - l1;
        const E = -1e-6;
        if (l0 < E || l1 < E || l2 < E) continue;
        const z = l0 * p[0][2] + l1 * p[1][2] + l2 * p[2][2];
        const i = gy * cols + gx;
        if (z > zbuf[i]) zbuf[i] = z;
      }
    }
  }

  const range = b.maxZ - b.minZ || 1;
  let covered = 0;
  let visMin = Infinity;
  let visMax = -Infinity;
  for (let i = 0; i < zbuf.length; i++) {
    if (zbuf[i] === -Infinity) continue;
    hit[i] = 1;
    covered++;
    const v = (zbuf[i] - b.minZ) / range;
    data[i] = v;
    if (v < visMin) visMin = v;
    if (v > visMax) visMax = v;
  }
  if (!covered) { visMin = 0; visMax = 1; }
  return {
    w: cols, h: rows, data, hit, bounds: b,
    coverage: covered / (cols * rows), visMin, visMax,
  };
}

/** Kutu bulanıklaştırma — tarama basamaklarını ve ağ gürültüsünü siler. */
export function smoothHeights(hm, radiusPx) {
  const r = Math.round(radiusPx);
  if (r < 1) return hm;
  const { w, h } = hm;
  const src = hm.data;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0; let n = 0;
      for (let k = -r; k <= r; k++) {
        const xx = x + k;
        if (xx < 0 || xx >= w) continue;
        sum += src[y * w + xx]; n++;
      }
      tmp[y * w + x] = sum / n;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0; let n = 0;
      for (let k = -r; k <= r; k++) {
        const yy = y + k;
        if (yy < 0 || yy >= h) continue;
        sum += tmp[yy * w + x]; n++;
      }
      out[y * w + x] = sum / n;
    }
  }
  return { ...hm, data: out };
}

/**
 * STL → oyma hattına girecek yükseklik haritası.
 * @param {Array} tris
 * @param {{cols,rows,axis,background,invert,smoothPx}} opts
 *   background: 'dip' (model dışı en derin) | 'ust' (model dışı dokunulmaz)
 */
export function stlToHeights(tris, opts = {}) {
  const cols = Math.max(16, Math.round(opts.cols || 400));
  const rows = Math.max(16, Math.round(opts.rows || 400));
  const scan = scanStl(tris, cols, rows, { axis: opts.axis });
  const bg = opts.background === 'ust' ? 1 : 0;

  // Ölçekleme: varsayılan olarak YUKARIDAN GÖRÜNEN yüzeyin aralığı kullanılır.
  // Katı bir modelde kutu yüksekliğinin çoğu gövdedir; modele göre ölçeklersek
  // 20 mm'lik bir bloğun üstündeki 3 mm'lik kabartma haritanın ancak %15'ini
  // kullanır ve rölyef sönük çıkar. Görünen aralık tam kontrast verir.
  const useVis = opts.normalize !== 'model' && scan.visMax > scan.visMin + 1e-6;
  const lo = useVis ? scan.visMin : 0;
  const span = useVis ? scan.visMax - scan.visMin : 1;

  for (let i = 0; i < scan.data.length; i++) {
    if (!scan.hit[i]) { scan.data[i] = bg; continue; }
    let v = (scan.data[i] - lo) / span;
    if (v < 0) v = 0; else if (v > 1) v = 1;
    scan.data[i] = opts.invert ? 1 - v : v;
  }
  const sm = opts.smoothPx > 0 ? smoothHeights(scan, opts.smoothPx) : scan;
  return { ...sm, bounds: scan.bounds, coverage: scan.coverage };
}
