// TAKIM YOLLARI
//
// Üç tür paso üretilir:
//   1. Kaba (Z seviyeli)  — malzemeyi kademe kademe boşaltır, yüzeyde pay bırakır.
//   2. Finiş              — telafi edilmiş yüzeyi birebir takip eder.
//   3. Kontur/kesme       — paneli levhadan keser (köprülerle).
//
// Bütün koordinatlar panel düzlemindedir: x ∈ [0,panelW], y ∈ [0,panelH],
// z ≤ 0 (0 = malzeme üst yüzeyi). Sıfır noktası kaydırması G-code aşamasında.

import { sampleZ, edgeDistance } from './pattern.js';
import { compensate, toolRadius, TOOL_DEFAULTS, scallopHeight } from './tool.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const TAU = Math.PI * 2;

export const CAM_DEFAULTS = {
  roughTool: { ...TOOL_DEFAULTS, type: 'flat', dia: 6 },
  finishTool: { ...TOOL_DEFAULTS, type: 'ball', dia: 6 },
  doRough: true,
  stockToLeave: 0.4,      // finiş için bırakılan pay (mm)
  stepdown: 3,            // kaba pasoda bir seferde inilecek derinlik (mm)
  roughStepover: 45,      // takım çapının yüzdesi
  roughAngle: 0,          // kaba paso tarama açısı (derece)
  ramp: true,             // dalarken rampa yap
  rampLen: 12,            // rampa uzunluğu (mm)

  strategy: 'raster',     // raster | spiral | radial | pattern
  finishStepover: 0.8,    // yanal adım (mm)
  finishAngle: 0,         // raster açısı (derece)
  zigzag: true,
  sampleStep: 0.6,        // yol üzerindeki örnekleme adımı (mm)
  tol: 0.01,              // yol sadeleştirme toleransı (mm)

  thickness: 25,
  cutout: false,
  tabCount: 6,
  tabWidth: 12,
  tabHeight: 4,
  cutoutStepdown: 4,
};

// ------------------------------------------------------------ sadeleştirme

/** 3B Douglas–Peucker. Düz giden yüzlerce noktayı tek satıra indirir. */
export function simplify3d(pts, tol) {
  const n = pts.length / 3;
  if (n < 3) return pts;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const ax = pts[a * 3], ay = pts[a * 3 + 1], az = pts[a * 3 + 2];
    const bx = pts[b * 3], by = pts[b * 3 + 1], bz = pts[b * 3 + 2];
    let dx = bx - ax, dy = by - ay, dz = bz - az;
    const len2 = dx * dx + dy * dy + dz * dz;
    let worst = -1;
    let wi = -1;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i * 3] - ax, py = pts[i * 3 + 1] - ay, pz = pts[i * 3 + 2] - az;
      let d2;
      if (len2 < 1e-12) {
        d2 = px * px + py * py + pz * pz;
      } else {
        const t = clamp((px * dx + py * dy + pz * dz) / len2, 0, 1);
        const ex = px - dx * t, ey = py - dy * t, ez = pz - dz * t;
        d2 = ex * ex + ey * ey + ez * ez;
      }
      if (d2 > worst) { worst = d2; wi = i; }
    }
    if (worst > tol * tol) {
      keep[wi] = 1;
      stack.push([a, wi], [wi, b]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    if (keep[i]) out.push(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
  }
  return Float32Array.from(out);
}

function pathLength(pts) {
  let L = 0;
  for (let i = 3; i < pts.length; i += 3) {
    L += Math.hypot(pts[i] - pts[i - 3], pts[i + 1] - pts[i - 2], pts[i + 2] - pts[i - 1]);
  }
  return L;
}

// ------------------------------------------------------------------ yüzey

/** Telafi edilmiş haritadan mm koordinatıyla Z okur. */
function zAt(map, x, y) {
  return sampleZ(map, x, y);
}

function insideAt(surf, x, y, inset = 0) {
  return edgeDistance(x, y, surf.params) >= inset;
}

// ------------------------------------------------------------- finiş yolu

/**
 * Bir doğru parçasını örnekleyip panel içinde kalan bölümleri yol hâline getirir.
 */
function sampleSegment(surf, map, x0, y0, x1, y1, step, inset, out) {
  const L = Math.hypot(x1 - x0, y1 - y0);
  if (L < 1e-6) return;
  const n = Math.max(1, Math.ceil(L / step));
  let run = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = x0 + (x1 - x0) * t;
    const y = y0 + (y1 - y0) * t;
    if (insideAt(surf, x, y, inset)) {
      run.push(x, y, zAt(map, x, y));
    } else if (run.length >= 6) {
      out.push(Float32Array.from(run));
      run = [];
    } else {
      run = [];
    }
  }
  if (run.length >= 6) out.push(Float32Array.from(run));
}

/** Açılı raster: paneli kapsayan doğrular. */
function rasterPaths(surf, map, cam, stepover, angleDeg, inset) {
  const a = (angleDeg * Math.PI) / 180;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const W = surf.panelW;
  const H = surf.panelH;
  const cx = W / 2;
  const cy = H / 2;
  // Panelin döndürülmüş kutusu
  const ext = (Math.abs(W * ca) + Math.abs(H * sa)) / 2;
  const extP = (Math.abs(W * sa) + Math.abs(H * ca)) / 2;
  const lines = [];
  const count = Math.max(1, Math.ceil((2 * extP) / stepover));
  for (let i = 0; i <= count; i++) {
    const v = -extP + (i * 2 * extP) / count;
    const x0 = cx + (-ext) * ca - v * sa;
    const y0 = cy + (-ext) * sa + v * ca;
    const x1 = cx + ext * ca - v * sa;
    const y1 = cy + ext * sa + v * ca;
    const segs = [];
    sampleSegment(surf, map, x0, y0, x1, y1, cam.sampleStep, inset, segs);
    if (cam.zigzag && i % 2 === 1) {
      for (const s of segs) reverse3(s);
      segs.reverse();
    }
    for (const s of segs) lines.push(s);
  }
  return lines;
}

function reverse3(pts) {
  const n = pts.length / 3;
  for (let i = 0; i < Math.floor(n / 2); i++) {
    const j = n - 1 - i;
    for (let k = 0; k < 3; k++) {
      const t = pts[i * 3 + k];
      pts[i * 3 + k] = pts[j * 3 + k];
      pts[j * 3 + k] = t;
    }
  }
}

/** Arşimet spirali — yuvarlak panelde tek parça, yön değiştirmeyen finiş. */
function spiralPaths(surf, map, cam, stepover, inset) {
  const cx = surf.panelW / 2;
  const cy = surf.panelH / 2;
  const rMax = Math.hypot(cx, cy);
  const pts = [];
  let r = 0;
  let th = 0;
  while (r <= rMax) {
    const x = cx + r * Math.cos(th);
    const y = cy + r * Math.sin(th);
    if (insideAt(surf, x, y, inset)) pts.push(x, y, zAt(map, x, y));
    const dth = Math.max(cam.sampleStep / Math.max(r, 0.5), 0.01);
    th += dth;
    r += (stepover * dth) / TAU;
  }
  // Panel dışına taşan kısımlar bölündüğü için tek tek ayrılır.
  return splitJumps(pts, stepover * 3);
}

/** Merkezden kenara ışınlar. */
function radialPaths(surf, map, cam, stepover, inset) {
  const cx = surf.panelW / 2;
  const cy = surf.panelH / 2;
  const rMax = Math.hypot(cx, cy);
  const count = Math.max(8, Math.ceil((TAU * rMax) / stepover));
  const out = [];
  for (let i = 0; i < count; i++) {
    const th = (i / count) * TAU;
    const x1 = cx + rMax * Math.cos(th);
    const y1 = cy + rMax * Math.sin(th);
    const segs = [];
    sampleSegment(surf, map, cx, cy, x1, y1, cam.sampleStep, inset, segs);
    if (cam.zigzag && i % 2 === 1) for (const s of segs) reverse3(s);
    for (const s of segs) out.push(s);
  }
  return out;
}

/** Ardışık noktalar arası sıçrama varsa yolu böler. */
function splitJumps(flat, maxGap) {
  const out = [];
  let run = [];
  for (let i = 0; i < flat.length; i += 3) {
    if (run.length >= 3) {
      const d = Math.hypot(flat[i] - run[run.length - 3], flat[i + 1] - run[run.length - 2]);
      if (d > maxGap) {
        if (run.length >= 6) out.push(Float32Array.from(run));
        run = [];
      }
    }
    run.push(flat[i], flat[i + 1], flat[i + 2]);
  }
  if (run.length >= 6) out.push(Float32Array.from(run));
  return out;
}

// ------------------------------------------- desen boyunca (akış çizgileri)

/**
 * Faz alanının gradyanını sürekli biçimde hesaplar.
 * φ'nin kendisi θ dikişinde tam sayı atlar; exp(2πiφ) ise süreklidir, bu yüzden
 * gradyan karmaşık gösterimden çıkarılır — dikiş izi kalmaz.
 */
export function phaseGradient(surf) {
  const { w, h, phase, mmPerPx, mmPerPy } = surf;
  const cr = new Float32Array(w * h);
  const ci = new Float32Array(w * h);
  for (let i = 0; i < phase.length; i++) {
    cr[i] = Math.cos(TAU * phase[i]);
    ci[i] = Math.sin(TAU * phase[i]);
  }
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const i = row * w + col;
      const xp = row * w + Math.min(w - 1, col + 1);
      const xm = row * w + Math.max(0, col - 1);
      const yp = Math.min(h - 1, row + 1) * w + col;
      const ym = Math.max(0, row - 1) * w + col;
      const dxr = (cr[xp] - cr[xm]) / (2 * mmPerPx);
      const dxi = (ci[xp] - ci[xm]) / (2 * mmPerPx);
      const dyr = (cr[yp] - cr[ym]) / (2 * mmPerPy);
      const dyi = (ci[yp] - ci[ym]) / (2 * mmPerPy);
      gx[i] = (cr[i] * dxi - ci[i] * dxr) / TAU;
      gy[i] = (cr[i] * dyi - ci[i] * dyr) / TAU;
    }
  }
  return { gx, gy };
}

function sampleField(surf, f, x, y) {
  const fx = clamp(x / surf.mmPerPx, 0, surf.w - 1);
  const fy = clamp(y / surf.mmPerPy, 0, surf.h - 1);
  const x0 = Math.floor(fx); const y0 = Math.floor(fy);
  const x1 = Math.min(surf.w - 1, x0 + 1); const y1 = Math.min(surf.h - 1, y0 + 1);
  const tx = fx - x0; const ty = fy - y0;
  const a = f[y0 * surf.w + x0]; const b = f[y0 * surf.w + x1];
  const c = f[y1 * surf.w + x0]; const d = f[y1 * surf.w + x1];
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}

/**
 * Desenin oluklarını TAKİP EDEN finiş yolu. Freze izi desenle aynı yöne
 * düştüğü için zımparadan önce bile temiz görünür; ayrıca takım sırtı enine
 * kesmediğinden tırtık daha az belli olur.
 */
export function flowPaths(surf, map, cam, spacing, inset) {
  const { gx, gy } = phaseGradient(surf);
  const W = surf.panelW;
  const H = surf.panelH;
  const cell = Math.max(spacing, 0.3);
  const gw = Math.ceil(W / cell) + 1;
  const gh = Math.ceil(H / cell) + 1;
  const buckets = new Map();
  const key = (cxi, cyi) => cyi * gw + cxi;

  const near = (x, y, dist) => {
    const cxi = Math.floor(x / cell);
    const cyi = Math.floor(y / cell);
    for (let j = cyi - 1; j <= cyi + 1; j++) {
      for (let i = cxi - 1; i <= cxi + 1; i++) {
        if (i < 0 || j < 0 || i >= gw || j >= gh) continue;
        const arr = buckets.get(key(i, j));
        if (!arr) continue;
        for (let k = 0; k < arr.length; k += 2) {
          if (Math.hypot(arr[k] - x, arr[k + 1] - y) < dist) return true;
        }
      }
    }
    return false;
  };
  const mark = (x, y) => {
    const k = key(Math.floor(x / cell), Math.floor(y / cell));
    let arr = buckets.get(k);
    if (!arr) { arr = []; buckets.set(k, arr); }
    arr.push(x, y);
  };

  const step = Math.max(0.2, Math.min(cam.sampleStep, spacing));
  const maxSteps = Math.ceil((2.5 * (W + H)) / step);

  function trace(sx, sy, dir) {
    const pts = [];
    let x = sx;
    let y = sy;
    let px = 0;
    let py = 0;
    for (let s = 0; s < maxSteps; s++) {
      if (!insideAt(surf, x, y, inset)) break;
      if (s > 0 && near(x, y, spacing * 0.86)) break;
      pts.push(x, y, zAt(map, x, y));
      // Akış yönü: gradyana dik.
      let vx = -sampleField(surf, gy, x, y);
      let vy = sampleField(surf, gx, x, y);
      const m = Math.hypot(vx, vy);
      if (m < 1e-7) {
        if (s === 0) break;
        vx = px; vy = py;           // durgun nokta: son yönle devam
      } else {
        vx /= m; vy /= m;
      }
      if (s > 0 && vx * px + vy * py < 0) { vx = -vx; vy = -vy; }
      px = vx; py = vy;
      x += vx * step * dir;
      y += vy * step * dir;
    }
    return pts;
  }

  const paths = [];
  const seedStep = Math.max(spacing / 2, 0.4);
  const cols = Math.ceil(W / seedStep);
  const rows = Math.ceil(H / seedStep);
  // Merkezden dışa doğru tohumlamak, burgulu desenlerde çizgileri düzgün dizer.
  const seeds = [];
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const x = c * seedStep;
      const y = r * seedStep;
      seeds.push([x, y, Math.hypot(x - W / 2, y - H / 2)]);
    }
  }
  seeds.sort((a, b) => a[2] - b[2]);

  for (const [sx, sy] of seeds) {
    if (!insideAt(surf, sx, sy, inset)) continue;
    if (near(sx, sy, spacing * 0.95)) continue;
    const fwd = trace(sx, sy, +1);
    const bwd = trace(sx, sy, -1);
    const pts = [];
    for (let i = bwd.length - 3; i >= 3; i -= 3) pts.push(bwd[i], bwd[i + 1], bwd[i + 2]);
    for (let i = 0; i < fwd.length; i += 3) pts.push(fwd[i], fwd[i + 1], fwd[i + 2]);
    if (pts.length < 12) continue;
    for (let i = 0; i < pts.length; i += 3) mark(pts[i], pts[i + 1]);
    paths.push(Float32Array.from(pts));
  }
  if (cam.zigzag) {
    for (let i = 1; i < paths.length; i += 2) reverse3(paths[i]);
  }
  return paths;
}

// --------------------------------------------------------------- kaba paso

function roughPaths(surf, roughMap, cam, level, stepover, inset) {
  const a = (cam.roughAngle * Math.PI) / 180;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const W = surf.panelW;
  const H = surf.panelH;
  const cx = W / 2;
  const cy = H / 2;
  const ext = (Math.abs(W * ca) + Math.abs(H * sa)) / 2;
  const extP = (Math.abs(W * sa) + Math.abs(H * ca)) / 2;
  const step = Math.max(0.5, Math.min(2, stepover / 3));
  const out = [];
  const count = Math.max(1, Math.ceil((2 * extP) / stepover));

  for (let i = 0; i <= count; i++) {
    const v = -extP + (i * 2 * extP) / count;
    const x0 = cx - ext * ca - v * sa;
    const y0 = cy - ext * sa + v * ca;
    const x1 = cx + ext * ca - v * sa;
    const y1 = cy + ext * sa + v * ca;
    const L = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.ceil(L / step));
    const segs = [];
    let run = null;
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t;
      // Bu seviyede kesecek malzeme var mı? Hedef yüzey seviyenin ALTINDAysa var.
      const cut = insideAt(surf, x, y, inset) && zAt(roughMap, x, y) < level - 0.002;
      if (cut) {
        if (!run) run = [];
        run.push(x, y, level);
      } else if (run) {
        if (run.length >= 6) segs.push(Float32Array.from(run));
        run = null;
      }
    }
    if (run && run.length >= 6) segs.push(Float32Array.from(run));
    // Zikzak: tek numaralı satırlar ters yönde işlenir, boşa gidiş azalır.
    if (cam.zigzag && i % 2 === 1) {
      for (const sgm of segs) reverse3(sgm);
      segs.reverse();
    }
    for (const sgm of segs) out.push(sgm);
  }
  return out;
}

/** Kaba pasoda dalış yerine rampa: uzun yollarda ilk `rampLen` mm'de iner. */
function addRamp(pts, fromZ, rampLen) {
  if (pts.length < 6) return pts;
  const z = pts[2];
  if (fromZ <= z + 0.01) return pts;
  const out = [];
  let acc = 0;
  out.push(pts[0], pts[1], fromZ);
  for (let i = 3; i < pts.length; i += 3) {
    const d = Math.hypot(pts[i] - pts[i - 3], pts[i + 1] - pts[i - 2]);
    acc += d;
    const t = Math.min(1, acc / rampLen);
    out.push(pts[i], pts[i + 1], fromZ + (z - fromZ) * t);
    if (t >= 1) {
      for (let k = i + 3; k < pts.length; k += 3) out.push(pts[k], pts[k + 1], pts[k + 2]);
      break;
    }
  }
  return Float32Array.from(out);
}

// ------------------------------------------------------------ kontur kesme

function outlinePolyline(surf, offset, steps = 720) {
  const p = surf.params;
  const cx = p.panelW / 2;
  const cy = p.panelH / 2;
  const pts = [];
  if (p.shape === 'disc') {
    const rx = cx + offset;
    const ry = cy + offset;
    for (let i = 0; i <= steps; i++) {
      const th = (i / steps) * TAU;
      pts.push(cx + rx * Math.cos(th), cy + ry * Math.sin(th));
    }
    return pts;
  }
  const r = p.shape === 'rounded' ? clamp(p.cornerR, 0, Math.min(cx, cy)) : 0;
  const R = r + offset;
  const x0 = -offset;
  const y0 = -offset;
  const x1 = p.panelW + offset;
  const y1 = p.panelH + offset;
  const corners = [
    [x1 - R, y1 - R, 0],
    [x0 + R, y1 - R, 1],
    [x0 + R, y0 + R, 2],
    [x1 - R, y0 + R, 3],
  ];
  if (R <= 0.001) {
    pts.push(x1, y1, x0, y1, x0, y0, x1, y0, x1, y1);
    return pts;
  }
  for (const [ccx, ccy, q] of corners) {
    for (let i = 0; i <= 12; i++) {
      const th = (q * Math.PI) / 2 + (i / 12) * (Math.PI / 2);
      pts.push(ccx + R * Math.cos(th), ccy + R * Math.sin(th));
    }
  }
  pts.push(pts[0], pts[1]);
  return pts;
}

function cutoutPaths(surf, cam) {
  const tool = cam.finishTool;
  const off = toolRadius(tool) + 0.1;
  const poly = outlinePolyline(surf, off);
  // Toplam çevre ve köprü konumları
  let per = 0;
  const cum = [0];
  for (let i = 2; i < poly.length; i += 2) {
    per += Math.hypot(poly[i] - poly[i - 2], poly[i + 1] - poly[i - 1]);
    cum.push(per);
  }
  const tabs = [];
  const nT = Math.max(0, Math.round(cam.tabCount));
  for (let i = 0; i < nT; i++) tabs.push((i / nT) * per + per / (2 * nT));
  const inTab = (s) => tabs.some((t) => Math.abs(((s - t + per * 1.5) % per) - per / 2) > per / 2 - cam.tabWidth / 2);

  const depth = cam.thickness + 0.6;
  const passes = Math.max(1, Math.ceil(depth / Math.max(0.5, cam.cutoutStepdown)));
  const out = [];
  for (let k = 1; k <= passes; k++) {
    const z = -Math.min(depth, (k * depth) / passes);
    const tabZ = -(cam.thickness - cam.tabHeight);
    const pts = [];
    for (let i = 0; i < poly.length; i += 2) {
      const s = cum[i / 2];
      const useTab = cam.tabHeight > 0 && inTab(s) && z < tabZ;
      pts.push(poly[i], poly[i + 1], useTab ? tabZ : z);
    }
    out.push(Float32Array.from(pts));
  }
  return out;
}

// ------------------------------------------------------------------- ana

/**
 * Bütün pasoları üretir.
 * @returns {{passes:Array, stats:object, warnings:string[]}}
 */
export function buildToolpaths(surf, camIn) {
  const cam = { ...CAM_DEFAULTS, ...camIn };
  const warnings = [];

  const finishTool = { ...TOOL_DEFAULTS, ...cam.finishTool };
  const roughTool = { ...TOOL_DEFAULTS, ...cam.roughTool };

  // 1) Takım telafisi
  const finComp = compensate(surf, finishTool);
  const finishMap = { ...surf, z: finComp.z };

  const passes = [];
  const inset = 0;                       // takım merkezi panel sınırına kadar gider
  let minZ = 0;

  // 2) Kaba pasolar
  if (cam.doRough) {
    const rComp = compensate(surf, roughTool);
    const rz = new Float32Array(rComp.z.length);
    for (let i = 0; i < rz.length; i++) rz[i] = Math.min(0, rComp.z[i] + cam.stockToLeave);
    const roughMap = { ...surf, z: rz };
    let deepest = 0;
    for (const v of rz) if (v < deepest) deepest = v;

    const stepover = Math.max(0.5, (cam.roughStepover / 100) * roughTool.dia);
    const stepdown = Math.max(0.3, cam.stepdown);
    const levels = Math.max(1, Math.ceil(Math.abs(deepest) / stepdown));
    const paths = [];
    for (let li = 1; li <= levels; li++) {
      const level = Math.max(deepest, -li * stepdown);
      const prev = Math.min(0, level + stepdown);
      const lvlPaths = roughPaths(surf, roughMap, cam, level, stepover, inset);
      for (let i = 0; i < lvlPaths.length; i++) {
        const p = cam.ramp ? addRamp(lvlPaths[i], prev, Math.max(2, cam.rampLen)) : lvlPaths[i];
        paths.push(simplify3d(p, cam.tol));
      }
      if (level <= deepest) break;
    }
    if (paths.length) {
      passes.push({
        id: 'rough',
        name: `Kaba paso — ${roughTool.dia} mm ${toolLabel(roughTool)}`,
        tool: roughTool,
        paths,
        levels,
        stepover,
        // Bağlantı hareketleri bu pasonun KENDİ haritasına göre yükseltilir:
        // kaba uç daha kalınsa merkez yüksekliği de daha yukarıdadır.
        linkMap: roughMap,
      });
    }
  }

  // 3) Finiş pasosu
  const fstep = Math.max(0.05, cam.finishStepover);
  let fPathsRaw;
  if (cam.strategy === 'spiral') fPathsRaw = spiralPaths(surf, finishMap, cam, fstep, inset);
  else if (cam.strategy === 'radial') fPathsRaw = radialPaths(surf, finishMap, cam, fstep, inset);
  else if (cam.strategy === 'pattern') fPathsRaw = flowPaths(surf, finishMap, cam, fstep, inset);
  else fPathsRaw = rasterPaths(surf, finishMap, cam, fstep, cam.finishAngle, inset);

  if (cam.strategy === 'pattern' && fPathsRaw.length < 3) {
    warnings.push('Desen boyunca yol çıkarılamadı (desen fazla düz), raster kullanıldı.');
    fPathsRaw = rasterPaths(surf, finishMap, cam, fstep, cam.finishAngle, inset);
  }

  const fPaths = fPathsRaw.map((p) => simplify3d(p, cam.tol));
  passes.push({
    id: 'finish',
    name: `Finiş — ${finishTool.dia} mm ${toolLabel(finishTool)} · ${strategyLabel(cam.strategy)}`,
    tool: finishTool,
    paths: fPaths,
    stepover: fstep,
    linkMap: finishMap,
  });

  // 4) Kontur kesme
  if (cam.cutout) {
    passes.push({
      id: 'cutout',
      name: `Kontur kesme — ${finishTool.dia} mm`,
      tool: finishTool,
      paths: cutoutPaths(surf, cam),
      cutout: true,
    });
  }

  // 5) İstatistik ve uyarılar
  let cutLen = 0;
  let points = 0;
  for (const pass of passes) {
    for (const p of pass.paths) {
      cutLen += pathLength(p);
      points += p.length / 3;
      for (let i = 2; i < p.length; i += 3) if (p[i] < minZ) minZ = p[i];
    }
  }

  const scal = scallopHeight(finishTool, fstep);
  if (finComp.maxLift > 0.3) {
    warnings.push(
      `Takım oluk diplerine tam giremiyor: en dar yerde ${finComp.maxLift.toFixed(2)} mm ` +
      `daha sığ kalıyor, dipler takım yarıçapı kadar yuvarlanır. (Önizleme zaten ` +
      `gerçekte çıkacak yüzeyi gösteriyor.) İstemiyorsanız: daha ince uç, daha az ` +
      `bant ya da "yuvarlak dip (oluk)" kesiti.`
    );
  }
  if (surf.mmPerPx > toolRadius(finishTool) / 1.5) {
    warnings.push(
      `Harita çözünürlüğü (${surf.mmPerPx.toFixed(2)} mm/örnek) takım yarıçapına göre kaba — ` +
      `"Çözünürlük"ü artırın, telafi daha doğru hesaplansın.`
    );
  }
  if (Math.abs(minZ) > cam.thickness - 1) {
    warnings.push(`Toplam derinlik (${Math.abs(minZ).toFixed(1)} mm) malzeme kalınlığına çok yakın.`);
  }
  if (finishTool.type === 'flat') {
    warnings.push('Finişte düz freze eğri yüzeyde kademe bırakır; bilya (küre) uç önerilir.');
  }

  return {
    passes,
    finishMap,
    machinedZ: null,        // önizleme isterse main.js doldurur
    stats: {
      minZ,
      maxLift: finComp.maxLift,
      scallop: scal,
      cutLength: cutLen,
      points,
      pathCount: passes.reduce((a, p) => a + p.paths.length, 0),
    },
    warnings,
  };
}

export function toolLabel(t) {
  return { ball: 'bilya (küre) uç', flat: 'düz freze', bull: 'köşe radüslü', vbit: 'V uç' }[t.type] || t.type;
}
export function strategyLabel(s) {
  return { raster: 'satır tarama', spiral: 'spiral', radial: 'ışınsal', pattern: 'desen boyunca' }[s] || s;
}
