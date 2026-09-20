// DIŞA AKTARMA: STL (doğrulama için), gri ton yükseklik haritası (PNG için
// piksel verisi) ve düz metin derinlik tablosu.

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Izgarayı hedef örnek sayısına indirger (STL dosyası şişmesin). */
function decimate(surf, z, maxLong) {
  const long = Math.max(surf.w, surf.h);
  const k = Math.max(1, Math.ceil(long / maxLong));
  if (k === 1) return { w: surf.w, h: surf.h, z, k };
  const w = Math.floor((surf.w - 1) / k) + 1;
  const h = Math.floor((surf.h - 1) / k) + 1;
  const out = new Float32Array(w * h);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) out[r * w + c] = z[Math.min(surf.h - 1, r * k) * surf.w + Math.min(surf.w - 1, c * k)];
  }
  return { w, h, z: out, k };
}

/**
 * İkili STL. Üst yüzey + (istenirse) yanlar ve taban — kapalı katı.
 * @returns {ArrayBuffer}
 */
export function surfaceToStl(surf, z, { thickness = 25, solid = true, maxLong = 400 } = {}) {
  const g = decimate(surf, z, maxLong);
  const dx = surf.panelW / (g.w - 1);
  const dy = surf.panelH / (g.h - 1);
  const zBottom = -Math.max(thickness, Math.abs(surf.minZ) + 1);
  const tris = [];

  const P = (c, r) => [c * dx, r * dy, g.z[r * g.w + c]];
  const B = (c, r) => [c * dx, r * dy, zBottom];

  for (let r = 0; r < g.h - 1; r++) {
    for (let c = 0; c < g.w - 1; c++) {
      const a = P(c, r), b = P(c + 1, r), cc = P(c + 1, r + 1), d = P(c, r + 1);
      tris.push([a, b, cc], [a, cc, d]);
    }
  }
  if (solid) {
    for (let c = 0; c < g.w - 1; c++) {
      const a = P(c, 0), b = P(c + 1, 0);
      tris.push([a, B(c, 0), B(c + 1, 0)], [a, B(c + 1, 0), b]);
      const e = P(c, g.h - 1), f = P(c + 1, g.h - 1);
      tris.push([e, f, B(c + 1, g.h - 1)], [e, B(c + 1, g.h - 1), B(c, g.h - 1)]);
    }
    for (let r = 0; r < g.h - 1; r++) {
      const a = P(0, r), b = P(0, r + 1);
      tris.push([a, b, B(0, r + 1)], [a, B(0, r + 1), B(0, r)]);
      const e = P(g.w - 1, r), f = P(g.w - 1, r + 1);
      tris.push([e, B(g.w - 1, r + 1), f], [e, B(g.w - 1, r), B(g.w - 1, r + 1)]);
    }
    const b00 = B(0, 0), b10 = B(g.w - 1, 0), b11 = B(g.w - 1, g.h - 1), b01 = B(0, g.h - 1);
    tris.push([b00, b11, b10], [b00, b01, b11]);
  }

  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  const header = 'CNC rolyef - parametrik panel';
  for (let i = 0; i < 80; i++) dv.setUint8(i, i < header.length ? header.charCodeAt(i) : 32);
  dv.setUint32(80, tris.length, true);
  let o = 84;
  for (const t of tris) {
    const ux = t[1][0] - t[0][0], uy = t[1][1] - t[0][1], uz = t[1][2] - t[0][2];
    const vx = t[2][0] - t[0][0], vy = t[2][1] - t[0][1], vz = t[2][2] - t[0][2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const m = Math.hypot(nx, ny, nz) || 1;
    dv.setFloat32(o, nx / m, true); dv.setFloat32(o + 4, ny / m, true); dv.setFloat32(o + 8, nz / m, true);
    o += 12;
    for (const p of t) {
      dv.setFloat32(o, p[0], true); dv.setFloat32(o + 4, p[1], true); dv.setFloat32(o + 8, p[2], true);
      o += 12;
    }
    dv.setUint16(o, 0, true);
    o += 2;
  }
  return buf;
}

/**
 * Gri ton yükseklik haritası pikselleri. 255 = üst yüzey, 0 = en derin nokta.
 * Aspire / ArtCAM / Carveco gibi programlara "bitmap to relief" diye girer.
 */
export function heightmapPixels(surf, z) {
  const { w, h } = surf;
  const data = new Uint8ClampedArray(w * h * 4);
  let min = 0;
  for (const v of z) if (v < min) min = v;
  const range = Math.abs(min) || 1;
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      // PNG'de satır 0 üstte; ızgarada satır 0 altta.
      const src = (h - 1 - r) * w + c;
      const g = Math.round(clamp(1 + z[src] / range, 0, 1) * 255);
      const i = (r * w + c) * 4;
      data[i] = data[i + 1] = data[i + 2] = g;
      data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data, minZ: min };
}

/**
 * Derinlik tablosu (CSV). İstenen mm adımında Z değerleri — hepsi eksi.
 * Elle kontrol etmek, Excel'de kesit almak veya başka programa taşımak için.
 */
export function depthCsv(surf, z, stepMm = 10, origin = 'center') {
  const offX = origin === 'center' ? -surf.panelW / 2 : 0;
  const offY = origin === 'center' ? -surf.panelH / 2 : 0;
  const cols = Math.floor(surf.panelW / stepMm) + 1;
  const rows = Math.floor(surf.panelH / stepMm) + 1;
  const lines = [];
  const head = ['Y\\X'];
  for (let c = 0; c < cols; c++) head.push((c * stepMm + offX).toFixed(1));
  lines.push(head.join(';'));
  for (let r = rows - 1; r >= 0; r--) {
    const y = r * stepMm;
    const row = [(y + offY).toFixed(1)];
    for (let c = 0; c < cols; c++) {
      const x = c * stepMm;
      const fx = clamp(Math.round(x / surf.mmPerPx), 0, surf.w - 1);
      const fy = clamp(Math.round(y / surf.mmPerPy), 0, surf.h - 1);
      row.push(z[fy * surf.w + fx].toFixed(2));
    }
    lines.push(row.join(';'));
  }
  return lines.join('\n') + '\n';
}
