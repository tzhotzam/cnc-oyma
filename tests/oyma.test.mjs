// 3 eksen oyma zincirini tarayıcısız doğrular:  node tests/carve.test.mjs
import assert from 'node:assert/strict';

import { buildSurface, phaseAt, profile, sampleZ, PATTERN_DEFAULTS } from '../js/pattern.js';
import {
  tipRise, toolRadius, scallopHeight, stepoverForScallop, compensate, machinedSurface,
} from '../js/tool.js';
import { buildToolpaths, simplify3d, phaseGradient, CAM_DEFAULTS } from '../js/toolpath.js';
import { toGcode } from '../js/gcode.js';
import { surfaceToStl, heightmapPixels, depthCsv } from '../js/export.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
}

const BALL6 = { type: 'ball', dia: 6 };

// ------------------------------------------------------------------ desen
console.log('desen');

test('yüzeyin tamamı 0 veya eksi, sonlu', () => {
  for (const pattern of ['twist', 'spiral', 'ripple', 'fan', 'dune', 'chevron', 'weave', 'flower']) {
    const s = buildSurface({ pattern, samples: 120 });
    for (const v of s.z) {
      assert.ok(Number.isFinite(v), `${pattern}: sonsuz/NaN değer`);
      assert.ok(v <= 1e-6, `${pattern}: artı Z (${v})`);
    }
  }
});

test('derinlik bant derinliği + kubbe yüksekliğini aşmaz', () => {
  const s = buildSurface({ samples: 160, depth: 10, domeRise: 4, depthCenter: 1, depthRim: 1 });
  assert.ok(s.minZ >= -(10 + 4) - 0.01, `minZ ${s.minZ}`);
  assert.ok(s.minZ < -5, 'hiç derinlik çıkmamış');
});

test('bant derinliği doğrudan ölçeklenir', () => {
  const a = buildSurface({ samples: 120, depth: 6, domeRise: 0, depthCenter: 1, depthRim: 1 });
  const b = buildSurface({ samples: 120, depth: 12, domeRise: 0, depthCenter: 1, depthRim: 1 });
  assert.ok(Math.abs(b.minZ / a.minZ - 2) < 0.05, `${a.minZ} → ${b.minZ}`);
});

test('kenarda düz şerit üst yüzeyde kalır', () => {
  const s = buildSurface({ samples: 200, shape: 'disc', panelW: 400, panelH: 400, rimWidth: 30 });
  // Merkezden 197 mm (kenardan 3 mm içeride) — düz şeridin içinde.
  const z = sampleZ(s, 200 + 197, 200);
  assert.ok(Math.abs(z) < 0.2, `kenar z=${z}`);
  assert.ok(sampleZ(s, 200, 200 + 100) < -0.5, 'iç bölge düz kalmış');
});

test('daire maskesi köşeleri dışarıda bırakır', () => {
  const s = buildSurface({ samples: 100, shape: 'disc' });
  assert.equal(s.inside[0], 0);
  assert.equal(s.inside[Math.floor(s.h / 2) * s.w + Math.floor(s.w / 2)], 1);
});

test('profil 0..1 arasında ve periyodik', () => {
  for (const kind of ['dome', 'sine', 'oluk', 'vee', 'saw', 'plato']) {
    const p = { ...PATTERN_DEFAULTS, profileKind: kind, skew: 0 };
    for (let i = 0; i <= 50; i++) {
      const t = i / 50;
      const v = profile(t, p);
      assert.ok(v >= -1e-9 && v <= 1 + 1e-9, `${kind} @${t} = ${v}`);
      assert.ok(Math.abs(profile(t + 3, p) - v) < 1e-6, `${kind} periyodik değil`);
    }
  }
});

test('asimetri tepeyi kaydırır', () => {
  const base = { ...PATTERN_DEFAULTS, profileKind: 'dome' };
  const peak = (skew) => {
    let best = -1; let at = 0;
    for (let i = 0; i <= 200; i++) {
      const v = profile(i / 200, { ...base, skew });
      if (v > best) { best = v; at = i / 200; }
    }
    return at;
  };
  assert.ok(peak(0.7) > peak(0) + 0.1, 'artı asimetri tepeyi sağa itmeli');
  assert.ok(peak(-0.7) < peak(0) - 0.1, 'eksi asimetri tepeyi sola itmeli');
});

test('kademe sayısı basamak üretir', () => {
  const s = buildSurface({ samples: 150, levels: 4, rimWidth: 0, domeRise: 0, depthCenter: 1, depthRim: 1 });
  const set = new Set();
  for (const v of s.z) set.add(Math.round(v * 100) / 100);
  assert.ok(set.size <= 8, `basamak yerine ${set.size} farklı yükseklik`);
});

test('sampleZ ızgara düğümünde birebir okur', () => {
  const s = buildSurface({ samples: 100 });
  const col = 30; const row = 40;
  const v = sampleZ(s, col * s.mmPerPx, row * s.mmPerPy);
  assert.ok(Math.abs(v - s.z[row * s.w + col]) < 1e-4);
});

test('faz dikişte sıçramaz (spiral/yelpaze)', () => {
  for (const pattern of ['spiral', 'fan', 'flower']) {
    const s = buildSurface({ pattern, samples: 160, arms: 3 });
    const { gx, gy } = phaseGradient(s);
    let max = 0;
    for (let i = 0; i < gx.length; i++) max = Math.max(max, Math.hypot(gx[i], gy[i]));
    // Merkez tekilliği hariç gradyan mm başına birkaç bandı geçmemeli.
    assert.ok(max < 5, `${pattern}: gradyan patlaması ${max}`);
  }
});

// ------------------------------------------------------------------ takım
console.log('takım');

test('uç profilleri', () => {
  assert.equal(tipRise(BALL6, 0), 0);
  assert.ok(Math.abs(tipRise(BALL6, 3) - 3) < 1e-9);          // yarıçapta tam R
  assert.ok(Math.abs(tipRise(BALL6, 1) - (3 - Math.sqrt(8))) < 1e-9);
  assert.equal(tipRise({ type: 'flat', dia: 6 }, 2), 0);
  assert.equal(tipRise({ type: 'flat', dia: 6 }, 4), Infinity);
  assert.ok(Math.abs(tipRise({ type: 'vbit', dia: 12, angle: 90 }, 2) - 2) < 1e-9);
  assert.equal(tipRise({ type: 'bull', dia: 6, cornerR: 1 }, 1.5), 0);  // düz göbek
  assert.ok(tipRise({ type: 'bull', dia: 6, cornerR: 1 }, 2.5) > 0);
  assert.equal(toolRadius(BALL6), 3);
});

test('tırtık ve yanal adım birbirinin tersi', () => {
  const s = scallopHeight(BALL6, 1.2);
  assert.ok(Math.abs(stepoverForScallop(BALL6, s) - 1.2) < 1e-6);
  assert.ok(scallopHeight(BALL6, 0.5) < scallopHeight(BALL6, 2), 'dar adım daha az tırtık');
});

test('telafi: düz yüzeyde hiçbir şey değişmez', () => {
  const s = buildSurface({ samples: 120, depth: 0, domeRise: 0 });
  const c = compensate(s, BALL6);
  for (let i = 0; i < s.z.length; i++) assert.ok(Math.abs(c.z[i] - s.z[i]) < 1e-6);
  assert.ok(c.maxLift < 1e-6);
});

test('telafi: takım merkezi asla yüzeyin altına inmez', () => {
  const s = buildSurface({ samples: 300, bands: 16, depth: 14 });
  const c = compensate(s, BALL6);
  for (let i = 0; i < s.z.length; i++) {
    assert.ok(c.z[i] >= s.z[i] - 1e-5, `telafi gouge yapıyor: ${c.z[i]} < ${s.z[i]}`);
  }
  assert.ok(c.maxLift > 0, 'dar oluklarda fark çıkmalıydı');
});

test('kalın uç dar oluğun dibine giremez', () => {
  // Elle kurulmuş V oluk: 0.5 mm/örnek, ±10 mm yamaç
  const w = 81; const h = 5;
  const z = new Float32Array(w * h);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) z[r * w + c] = -Math.max(0, 10 - Math.abs(c - 40) * 2);
  }
  const surf = { w, h, mmPerPx: 0.5, mmPerPy: 0.5, z };
  const ince = compensate(surf, { type: 'ball', dia: 1 });
  const kalin = compensate(surf, { type: 'ball', dia: 12 });
  assert.ok(kalin.maxLift > ince.maxLift, 'kalın uç daha sığ kalmalı');
  assert.ok(kalin.z[2 * w + 40] > z[2 * w + 40] + 1, 'kalın uç dibe inmiş görünüyor');
});

test('işlenmiş yüzey ideali kesmez (gouge yok)', () => {
  const s = buildSurface({ samples: 260, bands: 12, depth: 12 });
  const c = compensate(s, BALL6);
  const m = machinedSurface(s, c.z, BALL6);
  for (let i = 0; i < s.z.length; i++) {
    assert.ok(m[i] >= s.z[i] - 0.05, `gouge: ${m[i]} < ${s.z[i]}`);
    assert.ok(m[i] <= 1e-6, 'işlenmiş yüzey üst yüzeyi geçmiş');
  }
});

// ------------------------------------------------------------- takım yolu
console.log('takım yolu');

test('simplify3d uç noktaları korur ve düz çizgiyi ikiye indirir', () => {
  const pts = [];
  for (let i = 0; i <= 100; i++) pts.push(i, 0, -1);
  const out = simplify3d(Float32Array.from(pts), 0.01);
  assert.equal(out.length, 6);
  assert.equal(out[0], 0);
  assert.equal(out[3], 100);
});

test('simplify3d toleransın üstündeki sapmayı atmaz', () => {
  const pts = Float32Array.from([0, 0, 0, 5, 0, -2, 10, 0, 0]);
  assert.equal(simplify3d(pts, 0.5).length, 9);
  assert.equal(simplify3d(pts, 5).length, 6);
});

test('tüm stratejiler yol üretir ve Z sınırlar içinde kalır', () => {
  const surf = buildSurface({ samples: 260, panelW: 400, panelH: 400, depth: 10 });
  for (const strategy of ['raster', 'spiral', 'radial', 'pattern']) {
    const r = buildToolpaths(surf, { strategy, finishStepover: 2, doRough: false, thickness: 25 });
    const finish = r.passes.find((p) => p.id === 'finish');
    assert.ok(finish.paths.length > 0, `${strategy}: yol yok`);
    for (const p of finish.paths) {
      for (let i = 2; i < p.length; i += 3) {
        assert.ok(p[i] <= 1e-6, `${strategy}: artı Z`);
        assert.ok(p[i] >= surf.minZ - 0.01, `${strategy}: ideal tabanın altına inmiş`);
      }
    }
  }
});

test('finiş yolları panel sınırının dışına taşmaz', () => {
  const surf = buildSurface({ samples: 220, panelW: 300, panelH: 300, shape: 'disc' });
  const r = buildToolpaths(surf, { strategy: 'raster', finishStepover: 3, doRough: false });
  const R = 150;
  for (const p of r.passes.find((x) => x.id === 'finish').paths) {
    for (let i = 0; i < p.length; i += 3) {
      const d = Math.hypot(p[i] - 150, p[i + 1] - 150);
      assert.ok(d <= R + 1, `daire dışında nokta: ${d.toFixed(2)} mm`);
    }
  }
});

test('kaba paso seviyeleri paso derinliğini aşmaz', () => {
  const surf = buildSurface({ samples: 220, depth: 12, domeRise: 0 });
  const r = buildToolpaths(surf, { doRough: true, stepdown: 3, stockToLeave: 0.5, strategy: 'raster', finishStepover: 3 });
  const rough = r.passes.find((p) => p.id === 'rough');
  const zs = new Set();
  for (const p of rough.paths) for (let i = 2; i < p.length; i += 3) zs.add(Math.round(p[i] * 100) / 100);
  const sorted = [...zs].sort((a, b) => b - a);
  for (const z of sorted) assert.ok(z <= 0 && z >= surf.minZ, `kaba seviye ${z}`);
  // En derin kaba seviye, finiş payı kadar yukarıda kalmalı.
  assert.ok(Math.min(...sorted) >= surf.minZ + 0.3, 'kaba paso finiş payını yemiş');
});

test('kontur kesme kalınlığı geçer, köprüler yüzeyde kalır', () => {
  const surf = buildSurface({ samples: 160, panelW: 300, panelH: 300 });
  const r = buildToolpaths(surf, {
    doRough: false, cutout: true, thickness: 18, tabCount: 4, tabHeight: 4, tabWidth: 12,
    strategy: 'raster', finishStepover: 4,
  });
  const cut = r.passes.find((p) => p.id === 'cutout');
  assert.ok(cut, 'kontur pasosu yok');
  let deepest = 0; let tabSeen = false;
  for (const p of cut.paths) {
    for (let i = 2; i < p.length; i += 3) {
      deepest = Math.min(deepest, p[i]);
      if (Math.abs(p[i] + 14) < 0.01) tabSeen = true;   // -(18-4)
    }
  }
  assert.ok(deepest <= -18, `kontur kalınlığı geçmemiş: ${deepest}`);
  assert.ok(tabSeen, 'köprü yüksekliği görülmedi');
});

test('kontur takım yarıçapı kadar dışarıdan geçer', () => {
  const surf = buildSurface({ samples: 140, panelW: 200, panelH: 200, shape: 'disc' });
  const r = buildToolpaths(surf, { doRough: false, cutout: true, thickness: 10, finishTool: { type: 'ball', dia: 6 }, strategy: 'raster', finishStepover: 5 });
  const p = r.passes.find((x) => x.id === 'cutout').paths[0];
  const d = Math.hypot(p[0] - 100, p[1] - 100);
  assert.ok(Math.abs(d - 103.1) < 0.5, `kontur yarıçapı ${d}`);
});

// ------------------------------------------------------------------ g-code
console.log('g-code');

function sample(extra = {}, post = {}) {
  const surf = buildSurface({ samples: 200, panelW: 300, panelH: 300, depth: 8 });
  const res = buildToolpaths(surf, { doRough: false, strategy: 'raster', finishStepover: 4, thickness: 20, ...extra });
  const g = toGcode(res, surf, post, (x, y) => sampleZ(res.finishMap, x, y));
  return { surf, res, g };
}

test('başlık ve kapanış doğru', () => {
  const { g } = sample();
  const lines = g.text.split('\n');
  assert.ok(lines.some((l) => l.startsWith('G21 G90')), 'mm/mutlak kipi yok');
  assert.ok(lines.some((l) => /^M3 S\d+/.test(l)), 'M3 yok');
  assert.ok(lines.some((l) => l === 'M5'), 'M5 yok');
  assert.equal(lines.filter(Boolean).pop(), 'M30');
});

test('ASCII dışı karakter yok (eski kontrolcüler takılmasın)', () => {
  const { g } = sample();
  assert.ok(!/[^\x20-\x7E\n]/.test(g.text), 'ASCII dışı karakter var');
});

test('fanuc kipi % ve O numarası ile başlar', () => {
  const { g } = sample({}, { flavor: 'fanuc', programNumber: 42 });
  const lines = g.text.split('\n');
  assert.equal(lines[0], '%');
  assert.equal(lines[1], 'O0042');
  assert.ok(lines[2].startsWith('(') && lines[2].endsWith(')'), 'fanuc yorumu parantezli değil');
});

test('kesme Z değerleri malzeme sınırları içinde', () => {
  const { g, surf } = sample({ thickness: 20 }, { safeZ: 7 });
  let deepest = 0;
  let sawSafe = false;
  for (const line of g.text.split('\n')) {
    const m = line.match(/^G([01]).*Z(-?[\d.]+)/);
    if (!m) continue;
    const z = parseFloat(m[2]);
    assert.ok(z <= 7 + 1e-6, `Z güvenli yüksekliği aşıyor: ${z}`);
    if (m[1] === '0' && Math.abs(z - 7) < 1e-6) sawSafe = true;
    deepest = Math.min(deepest, z);
  }
  assert.ok(sawSafe, 'güvenli yükseklik hiç kullanılmamış');
  assert.ok(deepest < 0, 'hiç malzemeye girilmemiş');
  assert.ok(deepest >= surf.minZ - 0.01, `ideal tabanın altına inilmiş: ${deepest}`);
});

test('her dalıştan önce XY konumlanması var', () => {
  const { g } = sample();
  const lines = g.text.split('\n').filter((l) => /^G[01]/.test(l));
  let checked = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!/^G1 Z-/.test(lines[i])) continue;       // sadece Z dalışı
    const prev = lines.slice(Math.max(0, i - 3), i).join(' ');
    assert.ok(/G[01].*[XY]-?[\d.]/.test(prev), `dalış öncesi konumlanma yok: ${lines[i]}`);
    checked++;
  }
  assert.ok(checked > 0);
});

test('hiçbir hızlı hareket (G0) malzemeye girmiyor', () => {
  // Tek ciddi kaza biçimi budur: takım, kesmediği hâlde dolu malzemeden geçmek.
  // Alçak bağlantılar bilerek G1 yazıldığı için bütün G0'lar ham yüzeyin
  // (Z=0) üstünde kalmalı — takım çapları ne olursa olsun.
  const surf = buildSurface({ samples: 240, panelW: 300, panelH: 300, depth: 9 });
  const res = buildToolpaths(surf, {
    roughTool: { type: 'flat', dia: 16 },          // kaba uç finişten çok kalın
    finishTool: { type: 'ball', dia: 3 },
    doRough: true, stepdown: 3, strategy: 'raster', finishStepover: 2, thickness: 20,
  });
  const g = toGcode(res, surf, { origin: 'corner', clearZ: 1.5, safeZ: 6 },
    (x, y) => sampleZ(res.finishMap, x, y));

  let x = 0; let y = 0; let z = 6;
  let rapids = 0;
  for (const line of g.text.split('\n')) {
    const m = line.match(/^G([01])/);
    if (!m) continue;
    const hasX = /X-?[\d.]/.test(line);
    const hasY = /Y-?[\d.]/.test(line);
    const nx = parseFloat(line.match(/X(-?[\d.]+)/)?.[1] ?? x);
    const ny = parseFloat(line.match(/Y(-?[\d.]+)/)?.[1] ?? y);
    const nz = parseFloat(line.match(/Z(-?[\d.]+)/)?.[1] ?? z);
    if (m[1] === '0') {
      // Yatay hareket varsa hareket boyunca en alçak Z; yoksa sadece varış.
      const low = hasX || hasY ? Math.min(z, nz) : nz;
      const climbing = !hasX && !hasY && nz > z;
      if (!climbing) {
        assert.ok(low >= 0, `G0 ham yüzeyin altında: Z=${low} (${line})`);
        rapids++;
      }
    }
    x = nx; y = ny; z = nz;
  }
  assert.ok(rapids > 20, `yeterince hızlı hareket denetlenmedi (${rapids})`);
});

test('süre ve satır sayısı makul', () => {
  const { g } = sample();
  assert.ok(g.stats.lines > 50);
  assert.ok(g.stats.timeMin > 0 && g.stats.timeMin < 10000);
  assert.ok(g.stats.cutLength > 0);
});

// --------------------------------------------------------------- dışa aktar
console.log('dışa aktarma');

test('STL başlık ve üçgen sayısı tutarlı', () => {
  const s = buildSurface({ samples: 100 });
  const buf = surfaceToStl(s, s.z, { thickness: 20, maxLong: 60 });
  const dv = new DataView(buf);
  const n = dv.getUint32(80, true);
  assert.ok(n > 0);
  assert.equal(buf.byteLength, 84 + n * 50);
  // İlk üçgenin normali birim uzunlukta
  const nx = dv.getFloat32(84, true); const ny = dv.getFloat32(88, true); const nz = dv.getFloat32(92, true);
  assert.ok(Math.abs(Math.hypot(nx, ny, nz) - 1) < 1e-5);
});

test('yükseklik haritası 255 = üst yüzey, 0 = en derin', () => {
  const s = buildSurface({ samples: 120, rimWidth: 20 });
  const px = heightmapPixels(s, s.z);
  assert.equal(px.width, s.w);
  let min = 255; let max = 0;
  for (let i = 0; i < px.data.length; i += 4) { min = Math.min(min, px.data[i]); max = Math.max(max, px.data[i]); }
  assert.equal(max, 255);
  assert.equal(min, 0);
});

test('derinlik tablosunda bütün değerler 0 veya eksi', () => {
  const s = buildSurface({ samples: 120, panelW: 200, panelH: 200 });
  const csv = depthCsv(s, s.z, 20, 'center');
  const rows = csv.trim().split('\n');
  assert.equal(rows.length, 12);                       // 1 başlık + 11 satır
  for (const row of rows.slice(1)) {
    for (const cell of row.split(';').slice(1)) {
      assert.ok(parseFloat(cell) <= 0, `artı derinlik: ${cell}`);
    }
  }
  assert.ok(rows[0].includes('-100.0'), 'merkez sıfırına göre eksen yok');
});

console.log(`\n${passed} test geçti.`);
