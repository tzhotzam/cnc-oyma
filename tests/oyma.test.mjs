// 3 eksen oyma zincirini tarayıcısız doğrular:  node tests/carve.test.mjs
import assert from 'node:assert/strict';

import {
  buildSurface, surfaceFromHeights, phaseAt, profile, sampleZ, PATTERN_DEFAULTS,
} from '../js/pattern.js';
import { parseStl, stlBounds, scanStl, stlToHeights, smoothHeights } from '../js/stl.js';
import {
  tipRise, toolRadius, scallopHeight, stepoverForScallop, compensate, machinedSurface,
  slopeTangent,
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

// -------------------------------------------------------------- STL girişi
console.log('STL girişi');

/** Bilinen ölçülerde, tepesi tek noktada olan bir piramit. */
function pyramidStl(size = 100, height = 30) {
  const h = size / 2;
  const apex = [0, 0, height];
  const c = [[-h, -h, 0], [h, -h, 0], [h, h, 0], [-h, h, 0]];
  const tris = [
    [c[0], c[1], apex], [c[1], c[2], apex], [c[2], c[3], apex], [c[3], c[0], apex],
    [c[0], c[2], c[1]], [c[0], c[3], c[2]],
  ];
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  let o = 84;
  for (const t of tris) {
    o += 12;
    for (const v of t) {
      dv.setFloat32(o, v[0], true);
      dv.setFloat32(o + 4, v[1], true);
      dv.setFloat32(o + 8, v[2], true);
      o += 12;
    }
    o += 2;
  }
  return buf;
}

test('ikili STL okunur, sınırları doğru', () => {
  const tris = parseStl(pyramidStl(100, 30));
  assert.equal(tris.length, 6);
  const b = stlBounds(tris);
  assert.ok(Math.abs(b.w - 100) < 1e-4);
  assert.ok(Math.abs(b.h - 100) < 1e-4);
  assert.ok(Math.abs(b.d - 30) < 1e-4);
});

test('ASCII STL de okunur ve aynı sonucu verir', () => {
  const ascii = `solid test
facet normal 0 0 1
 outer loop
  vertex 0 0 0
  vertex 10 0 0
  vertex 0 10 5
 endloop
endfacet
endsolid test`;
  const tris = parseStl(new TextEncoder().encode(ascii).buffer);
  assert.equal(tris.length, 1);
  assert.deepEqual(tris[0][2], [0, 10, 5]);
});

test('tarama piramidin tepesini ortada bulur', () => {
  const tris = parseStl(pyramidStl(100, 30));
  const hm = stlToHeights(tris, { cols: 81, rows: 81 });
  const at = (c, r) => hm.data[r * hm.w + c];
  assert.ok(at(40, 40) > 0.95, `tepe ${at(40, 40)}`);
  assert.ok(at(0, 0) < 0.05, `köşe ${at(0, 0)}`);
  // Yükseklik merkeze doğru tek yönlü artmalı
  for (let c = 1; c <= 40; c++) {
    assert.ok(at(c, 40) >= at(c - 1, 40) - 1e-6, `yamaç ${c} bozuk`);
  }
  assert.ok(hm.coverage > 0.95, `kapsama ${hm.coverage}`);
});

test('satır 0 aşağıdır (makine düzeni)', () => {
  // Alt yarısı yüksek, üst yarısı alçak bir çatı: y küçükken z büyük.
  const tris = [
    [[0, 0, 10], [100, 0, 10], [100, 100, 0]],
    [[0, 0, 10], [100, 100, 0], [0, 100, 0]],
  ];
  const hm = stlToHeights(tris, { cols: 41, rows: 41 });
  const alt = hm.data[2 * hm.w + 20];
  const ust = hm.data[38 * hm.w + 20];
  assert.ok(alt > ust + 0.5, `alt ${alt} üst ${ust}`);
});

test('bakış ekseni değişince tarama değişir', () => {
  const tris = parseStl(pyramidStl(100, 30));
  const z = stlToHeights(tris, { cols: 41, rows: 41, axis: 'z' });
  const y = stlToHeights(tris, { cols: 41, rows: 41, axis: 'y' });
  let fark = 0;
  for (let i = 0; i < z.data.length; i++) fark += Math.abs(z.data[i] - y.data[i]);
  assert.ok(fark / z.data.length > 0.05, 'eksen değişimi etkisiz kalmış');
});

test('görünen yüzeye göre ölçekleme tam kontrast verir', () => {
  // Katı bir model: üstte 20→30 mm arasında eğimli bir yüzey, altta aynı
  // ayak izinde z=0 tabanı. Taban yukarıdan GÖRÜNMEZ. Modelin tamamına göre
  // ölçeklersek kabartma aralığın ancak üçte birini kullanır ve sönük çıkar.
  const ust = [
    [[-50, -50, 20], [50, -50, 20], [50, 50, 30]],
    [[-50, -50, 20], [50, 50, 30], [-50, 50, 30]],
  ];
  const taban = [
    [[-50, -50, 0], [50, -50, 0], [50, 50, 0]],
    [[-50, -50, 0], [50, 50, 0], [-50, 50, 0]],
  ];
  const kati = ust.concat(taban);
  const yay = (d) => Math.max(...d) - Math.min(...d);

  const gorunen = stlToHeights(kati, { cols: 41, rows: 41, normalize: 'gorunen' });
  const model = stlToHeights(kati, { cols: 41, rows: 41, normalize: 'model' });

  assert.ok(yay(gorunen.data) > 0.98, `görünen yayılım ${yay(gorunen.data)}`);
  assert.ok(yay(model.data) < 0.4, `modele göre yayılım ${yay(model.data)}`);
  // Görünen yüzey hep tabanın üstünde: taban haritaya hiç girmemeli.
  assert.ok(Math.min(...model.data) > 0.6, 'gizli taban taramaya karışmış');
});

test('ters çevirme tümseği çukura döndürür', () => {
  const tris = parseStl(pyramidStl(100, 30));
  const d = stlToHeights(tris, { cols: 41, rows: 41 });
  const t = stlToHeights(tris, { cols: 41, rows: 41, invert: true });
  const i = 20 * 41 + 20;
  assert.ok(Math.abs(d.data[i] + t.data[i] - 1) < 1e-5);
});

test('yumuşatma yüksekliği 0..1 dışına taşırmaz', () => {
  const tris = parseStl(pyramidStl(100, 30));
  const hm = smoothHeights(stlToHeights(tris, { cols: 61, rows: 61 }), 3);
  for (const v of hm.data) assert.ok(v >= -1e-6 && v <= 1 + 1e-6, `taşma ${v}`);
});

test('STL yüzeyi oyma hattına girer ve derinlik sınırında kalır', () => {
  const tris = parseStl(pyramidStl(100, 30));
  const hm = stlToHeights(tris, { cols: 121, rows: 121 });
  const surf = surfaceFromHeights(hm, {
    panelW: 300, panelH: 300, shape: 'rect', depth: 14,
    domeShape: 'yok', domeRise: 0, rimWidth: 0, depthCenter: 1, depthRim: 1,
  });
  assert.equal(surf.source, 'heightmap');
  assert.ok(surf.minZ >= -14.01 && surf.minZ < -13.9, `minZ ${surf.minZ}`);
  for (const v of surf.z) assert.ok(v <= 1e-6 && Number.isFinite(v));

  const res = buildToolpaths(surf, { doRough: false, strategy: 'pattern', finishStepover: 3 });
  const fin = res.passes.find((p) => p.id === 'finish');
  assert.ok(fin.paths.length > 2, 'eş-yükselti yolu çıkmadı');
  const g = toGcode(res, surf, {}, (x, y) => sampleZ(res.finishMap, x, y));
  assert.ok(g.stats.minZ < -1, 'G-code hiç malzemeye girmemiş');
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

test('desen boyunca strateji düz bölgeleri de tarar', () => {
  // Yarısı desenli, yarısı dümdüz bir yüzeyde akış çizgileri düz tarafı da
  // kapsamalı; yoksa orası finişsiz kalır.
  const w = 200; const h = 200;
  const data = new Float32Array(w * h);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      data[r * w + c] = c < w / 2 ? 0.5 + 0.5 * Math.sin(c / 6) : 1;
    }
  }
  const surf = surfaceFromHeights({ w, h, data }, {
    panelW: 300, panelH: 300, shape: 'rect', depth: 8,
    domeShape: 'yok', domeRise: 0, rimWidth: 0, depthCenter: 1, depthRim: 1,
  });
  const res = buildToolpaths(surf, { doRough: false, strategy: 'pattern', finishStepover: 6 });
  const paths = res.passes.find((p) => p.id === 'finish').paths;

  // Panelin sağ (düz) yarısını 20 mm'lik kutulara bölüp her birine yol
  // düşüp düşmediğine bakıyoruz. Yollar sadeleştirildiği için köşe noktaları
  // yetmez — parçaların ÜZERİNDE yürümek gerekir (düz bir hat 2 noktadır).
  const cell = 20;
  const dolu = new Set();
  for (const p of paths) {
    for (let i = 3; i < p.length; i += 3) {
      const ax = p[i - 3]; const ay = p[i - 2];
      const bx = p[i]; const by = p[i + 1];
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 5));
      for (let k = 0; k <= n; k++) {
        const x = ax + (bx - ax) * (k / n);
        const y = ay + (by - ay) * (k / n);
        if (x < 150) continue;
        dolu.add(`${Math.floor(x / cell)},${Math.floor(y / cell)}`);
      }
    }
  }
  const hedef = Math.ceil(150 / cell) * Math.ceil(300 / cell);
  assert.ok(dolu.size > hedef * 0.85, `düz yarıda ${dolu.size}/${hedef} kutu taranmış`);
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

test('düz frezede iz, ucun çapıyla değil desenin eğimiyle belirlenir', () => {
  const duz = { type: 'flat', dia: 6 };
  const bilya = { type: 'ball', dia: 6 };
  const s = buildSurface({ samples: 300, profileKind: 'sine', depth: 12 });
  const egim = slopeTangent(s);
  assert.ok(egim > 0.05, `eğim ölçülemedi: ${egim}`);
  assert.ok(Math.abs(scallopHeight(duz, 1, egim) - egim) < 1e-9, 'kademe = adım × tan(eğim)');
  // Düz frezede çap fark etmez, eğim belirler; bilyada tam tersi.
  assert.equal(scallopHeight(duz, 1, egim), scallopHeight({ ...duz, dia: 12 }, 1, egim));
  assert.ok(scallopHeight(bilya, 1) !== scallopHeight({ ...bilya, dia: 12 }, 1));
  // Hedef ize göre adım: ters çevirim tutarlı olmalı.
  const adim = stepoverForScallop(duz, 0.1, egim);
  assert.ok(Math.abs(scallopHeight(duz, adim, egim) - 0.1) < 1e-6);
});

/** Bir tasarımın verilen uçla gerçekte ne kadarının çıktığını ölçer. */
function isleme(surfParams, tool) {
  const s = buildSurface({ samples: 360, ...surfParams });
  const c = compensate(s, tool);
  const m = machinedSurface(s, c.z, tool);
  let ulasti = 0; let enKotu = 0; let toplam = 0; let n = 0;
  for (let i = 0; i < s.z.length; i++) {
    if (!s.inside[i]) continue;
    if (m[i] < ulasti) ulasti = m[i];
    const d = m[i] - s.z[i];
    if (d > enKotu) enKotu = d;
    toplam += d; n++;
  }
  return { ideal: s.minZ, ulasti, enKotu, ortalama: toplam / n };
}

test('sivri dipli kesit düz frezeyle çıkmaz, yumuşak dalga çıkar', () => {
  const duz = { type: 'flat', dia: 6 };
  const sivri = isleme({ profileKind: 'dome', bands: 6, depth: 12 }, duz);
  const yumusak = isleme({ profileKind: 'sine', bands: 6, depth: 12 }, duz);

  // Yarım daire sırtın vadi dibi sivridir; 6 mm uç oraya giremez.
  assert.ok(sivri.enKotu > 2, `sivri kesitte kalan ${sivri.enKotu}`);
  assert.ok(sivri.ulasti > sivri.ideal + 2, 'sivri kesitte dibe inilebilmiş (beklenmedik)');

  // Yumuşak dalgada uç her yere girer.
  assert.ok(yumusak.ulasti < yumusak.ideal + 0.3,
    `yumuşak kesitte dibe inilemedi: ${yumusak.ulasti} / ${yumusak.ideal}`);
  assert.ok(yumusak.ortalama < 0.05, `ortalama sapma ${yumusak.ortalama}`);
  assert.ok(yumusak.enKotu < sivri.enKotu / 3, 'yumuşak kesit belirgin biçimde iyi olmalı');
});

test('bant sayısı arttıkça düz frezenin işi bozulur', () => {
  const duz = { type: 'flat', dia: 6 };
  const az = isleme({ profileKind: 'sine', bands: 4, depth: 12 }, duz);
  const cok = isleme({ profileKind: 'sine', bands: 12, depth: 12 }, duz);
  assert.ok(cok.ortalama > az.ortalama, 'dar bantta sapma artmalı');
});

test('kalan malzeme takım merkezinin yükselmesiyle karıştırılmıyor', () => {
  // Dik basamaklı yüzeyde takım MERKEZİ basamak kenarında yükselir (maxLift
  // büyük) ama düz tabanlar pekâlâ işlenir — kalan malzeme küçüktür.
  const surf = buildSurface({ samples: 360, profileKind: 'sine', levels: 6, depth: 15, rimWidth: 0 });
  const res = buildToolpaths(surf, {
    finishTool: { type: 'flat', dia: 6 }, doRough: false,
    strategy: 'raster', finishStepover: 2,
  });
  assert.ok(res.stats.maxLift > 1, `maxLift ${res.stats.maxLift}`);
  assert.ok(res.stats.residual < res.stats.maxLift / 2,
    `kalan malzeme (${res.stats.residual}) merkez yükselmesiyle (${res.stats.maxLift}) karışmış`);
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
