// ÖNİZLEMELER (2B tuval)
//   · Rölyef  — tepe gölgelemesi (hillshade); ışık sol üstten. Gösterilen yüzey
//               idealin değil, seçtiğiniz uçla GERÇEKTE çıkacak olanın kendisi.
//   · Takım yolu
//   · Kesit    — panelin ortasından dikey kesit, Z değerleri mm cinsinden eksi.

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export const MATERIALS = {
  tas:   { name: 'Taş / beton', base: [214, 203, 184] },
  mese:  { name: 'Ahşap (meşe)', base: [201, 164, 108] },
  ceviz: { name: 'Ahşap (ceviz)', base: [140, 100, 66] },
  mdf:   { name: 'MDF', base: [190, 168, 140] },
  beyaz: { name: 'Beyaz boyalı', base: [236, 236, 233] },
};

function fitRect(cw, ch, aw, ah) {
  const s = Math.min(cw / aw, ch / ah) * 0.94;
  return { s, ox: (cw - aw * s) / 2, oy: (ch - ah * s) / 2 };
}

/** Tuvali cihaz pikseline göre ölçekler. */
export function sizeCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(64, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(64, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return { w, h, dpr };
}

/** Yükseklik haritasını gölgelendirip tuvale basar. */
export function drawRelief(canvas, surf, z, opts = {}) {
  const { w: cw, h: ch } = sizeCanvas(canvas);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0b0e12';
  ctx.fillRect(0, 0, cw, ch);

  const { w, h, mmPerPx, mmPerPy } = surf;
  const base = (MATERIALS[opts.material] || MATERIALS.tas).base;
  const exag = opts.exaggerate || 1;
  const img = new ImageData(w, h);
  const d = img.data;

  // Işık: sol üst, hafif yukarıdan.
  const lx = -0.55, ly = 0.55, lz = 0.63;
  let minZ = 0;
  for (const v of z) if (v < minZ) minZ = v;
  const range = Math.abs(minZ) || 1;

  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const i = r * w + c;
      const xm = z[r * w + Math.max(0, c - 1)];
      const xp = z[r * w + Math.min(w - 1, c + 1)];
      const ym = z[Math.max(0, r - 1) * w + c];
      const yp = z[Math.min(h - 1, r + 1) * w + c];
      const gx = ((xp - xm) * exag) / (2 * mmPerPx);
      const gy = ((yp - ym) * exag) / (2 * mmPerPy);
      const m = Math.hypot(gx, gy, 1);
      const nx = -gx / m, ny = -gy / m, nz = 1 / m;
      let lam = nx * lx + ny * ly + nz * lz;
      lam = clamp(lam, 0, 1);
      // Derinlik gölgesi: dibe inen yerler doğal olarak koyulaşır.
      const ao = 0.45 + 0.55 * clamp(1 + z[i] / range, 0, 1);
      const spec = Math.pow(lam, 18) * 0.25;
      const k = 0.26 + 0.86 * lam;
      const px = ((h - 1 - r) * w + c) * 4;   // satır 0 altta → görüntüde ters
      d[px] = clamp(base[0] * k * ao + spec * 255, 0, 255);
      d[px + 1] = clamp(base[1] * k * ao + spec * 255, 0, 255);
      d[px + 2] = clamp(base[2] * k * ao + spec * 255, 0, 255);
      d[px + 3] = surf.inside[i] ? 255 : 0;
    }
  }

  const off = document.createElement('canvas');
  off.width = w;
  off.height = h;
  off.getContext('2d').putImageData(img, 0, 0);

  const f = fitRect(cw, ch, surf.panelW, surf.panelH);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 18 * (cw / 800);
  ctx.shadowOffsetY = 8 * (cw / 800);
  ctx.drawImage(off, f.ox, f.oy, surf.panelW * f.s, surf.panelH * f.s);
  ctx.restore();
  return f;
}

const PASS_COLOR = {
  rough: '#f0a33c',
  finish: '#5fd0ff',
  cutout: '#ff6b6b',
};

/** Takım yollarını çizer. */
export function drawToolpaths(canvas, surf, result, opts = {}) {
  const { w: cw, h: ch } = sizeCanvas(canvas);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0b0e12';
  ctx.fillRect(0, 0, cw, ch);
  const f = fitRect(cw, ch, surf.panelW, surf.panelH);
  const X = (x) => f.ox + x * f.s;
  const Y = (y) => f.oy + (surf.panelH - y) * f.s;

  // Panel sınırı
  ctx.strokeStyle = '#2a3340';
  ctx.lineWidth = 1;
  ctx.strokeRect(f.ox, f.oy, surf.panelW * f.s, surf.panelH * f.s);

  for (const pass of result.passes) {
    if (opts.only && opts.only !== 'all' && opts.only !== pass.id) continue;
    ctx.strokeStyle = PASS_COLOR[pass.id] || '#9aa5b1';
    ctx.lineWidth = pass.id === 'finish' ? 0.7 : 1.1;
    ctx.globalAlpha = pass.id === 'finish' ? 0.75 : 0.9;
    ctx.beginPath();
    for (const p of pass.paths) {
      ctx.moveTo(X(p[0]), Y(p[1]));
      for (let i = 3; i < p.length; i += 3) ctx.lineTo(X(p[i]), Y(p[i + 1]));
    }
    ctx.stroke();

    if (opts.showLinks) {
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth = 0.6;
      ctx.globalAlpha = 1;
      ctx.beginPath();
      let prev = null;
      for (const p of pass.paths) {
        if (prev) {
          ctx.moveTo(X(prev[0]), Y(prev[1]));
          ctx.lineTo(X(p[0]), Y(p[1]));
        }
        prev = [p[p.length - 3], p[p.length - 2]];
      }
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

/**
 * Kesit. İdeal yüzey (kesikli) ile takımın gerçekte bırakacağı yüzey (dolu)
 * üst üste çizilir; aradaki fark takım çapının bedelidir.
 */
export function drawSection(canvas, surf, zIdeal, zReal, opts = {}) {
  const { w: cw, h: ch } = sizeCanvas(canvas);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0b0e12';
  ctx.fillRect(0, 0, cw, ch);

  const axis = opts.axis === 'y' ? 'y' : 'x';
  const pos = opts.pos ?? 0.5;
  const thickness = opts.thickness || 25;
  const n = axis === 'x' ? surf.w : surf.h;
  const span = axis === 'x' ? surf.panelW : surf.panelH;
  const fixed = axis === 'x'
    ? Math.round(clamp(pos, 0, 1) * (surf.h - 1))
    : Math.round(clamp(pos, 0, 1) * (surf.w - 1));

  const pad = 44;
  const zMin = -Math.max(thickness, 1);
  const sx = (cw - 2 * pad) / span;
  const sy = (ch - 2 * pad) / (Math.abs(zMin) + 2);
  const X = (i) => pad + (i / (n - 1)) * span * sx;
  const Y = (z) => pad + (1 - z) * sy;

  // Malzeme gövdesi
  ctx.fillStyle = '#171c23';
  ctx.fillRect(pad, Y(0), span * sx, Y(zMin) - Y(0));

  // Izgara ve Z etiketleri — hepsi eksi, ekranda da öyle yazar.
  ctx.font = `${12}px ui-monospace, monospace`;
  ctx.textBaseline = 'middle';
  const stepZ = Math.abs(zMin) > 40 ? 10 : Math.abs(zMin) > 16 ? 5 : 2;
  for (let z = 0; z >= zMin; z -= stepZ) {
    ctx.strokeStyle = z === 0 ? '#4a5768' : '#232a34';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad, Y(z));
    ctx.lineTo(cw - pad, Y(z));
    ctx.stroke();
    ctx.fillStyle = z === 0 ? '#9aa5b1' : '#5b6675';
    ctx.textAlign = 'right';
    ctx.fillText(z === 0 ? '0' : z.toFixed(0), pad - 6, Y(z));
  }

  const at = (i, z) => (axis === 'x' ? z[fixed * surf.w + i] : z[i * surf.w + fixed]);

  if (zIdeal) {
    ctx.strokeStyle = '#6b7889';
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const p = at(i, zIdeal);
      if (i === 0) ctx.moveTo(X(i), Y(p)); else ctx.lineTo(X(i), Y(p));
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.strokeStyle = '#5fd0ff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  let deepest = 0;
  let deepI = 0;
  for (let i = 0; i < n; i++) {
    const p = at(i, zReal);
    if (p < deepest) { deepest = p; deepI = i; }
    if (i === 0) ctx.moveTo(X(i), Y(p)); else ctx.lineTo(X(i), Y(p));
  }
  ctx.stroke();

  // En derin nokta işareti
  ctx.fillStyle = '#ff9f43';
  ctx.beginPath();
  ctx.arc(X(deepI), Y(deepest), 3.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.textAlign = 'left';
  ctx.fillText(`${deepest.toFixed(2)} mm`, X(deepI) + 8, Y(deepest));

  ctx.fillStyle = '#9aa5b1';
  ctx.textAlign = 'left';
  ctx.fillText(
    `${axis === 'x' ? 'X' : 'Y'} ekseni boyunca kesit — kesikli: ideal, dolu: takımın bıraktığı`,
    pad, ch - pad / 2
  );
  return { deepest };
}
