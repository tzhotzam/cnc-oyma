// Uygulama kabuğu: desen → yüzey → takım telafisi → yollar → G-code.

import { buildSurface, sampleZ, PATTERN_DEFAULTS } from './pattern.js';
import { compensate, machinedSurface, scallopHeight, stepoverForScallop, TOOL_DEFAULTS } from './tool.js';
import { buildToolpaths, CAM_DEFAULTS, toolLabel, strategyLabel } from './toolpath.js';
import { toGcode, POST_DEFAULTS } from './gcode.js';
import { surfaceToStl, heightmapPixels, depthCsv } from './export.js';
import { drawRelief, drawToolpaths, drawSection, sizeCanvas } from './preview.js';
import { createView3d } from './view3d.js';

const els = {};
for (const el of document.querySelectorAll('[id]')) els[el.id] = el;

const STORE_KEY = 'cnc-oyma-v1';

const state = {
  view: 'relief',
  surf: null,        // ideal yüzey
  toolZ: null,       // takım merkez yüksekliği (telafi edilmiş)
  realZ: null,       // takımın gerçekte bırakacağı yüzey
  result: null,      // takım yolları
  gcode: null,
  pathFilter: 'all',
  secAxis: 'x',
  view3d: null,
  busyTimer: null,
};

const num = (id, f = 0) => {
  const v = parseFloat(els[id]?.value);
  return Number.isFinite(v) ? v : f;
};
const str = (id, f = '') => els[id]?.value ?? f;
const bool = (id) => !!els[id]?.checked;

// ------------------------------------------------------------ parametreler

function readPattern() {
  return {
    ...PATTERN_DEFAULTS,
    pattern: str('c-pattern', 'twist'),
    shape: str('c-shape', 'disc'),
    panelW: num('c-panelW', 600),
    panelH: str('c-shape') === 'disc' ? num('c-panelW', 600) : num('c-panelH', 600),
    cornerR: num('c-cornerR', 40),
    samples: num('c-samples', 520),
    bands: num('c-bands', 7),
    arms: num('c-arms', 2),
    swirl: num('c-swirl', 2.6),
    swirlMode: str('c-swirlMode', 'merkez'),
    falloffPow: num('c-falloffPow', 1.6),
    angle: num('c-angle', 20),
    logSpiral: bool('c-logSpiral'),
    wave: num('c-wave', 0.25),
    waveFreq: num('c-waveFreq', 2),
    petal: num('c-petal', 0.25),
    profileKind: str('c-profileKind', 'dome'),
    skew: num('c-skew', 0.25),
    sharpness: num('c-sharpness', 1),
    plateau: num('c-plateau', 0.25),
    levels: num('c-levels', 0),
    depth: num('c-depth', 12),
    depthCenter: num('c-depthCenter', 1),
    depthRim: num('c-depthRim', 0.7),
    domeShape: str('c-domeShape', 'kubbe'),
    domeRise: num('c-domeRise', 3),
    rimWidth: num('c-rimWidth', 18),
    centerFlat: num('c-centerFlat', 0),
  };
}

function finishTool() {
  return {
    ...TOOL_DEFAULTS,
    type: str('c-finishType', 'ball'),
    dia: num('c-finishDia', 6),
    cornerR: num('c-finishCornerR', 1),
    angle: num('c-finishAngle', 90),
  };
}
function roughTool() {
  return {
    ...TOOL_DEFAULTS,
    type: str('c-roughType', 'flat'),
    dia: num('c-roughDia', 6),
    cornerR: num('c-finishCornerR', 1),
  };
}

function readCam() {
  return {
    ...CAM_DEFAULTS,
    roughTool: roughTool(),
    finishTool: finishTool(),
    doRough: bool('c-doRough'),
    stockToLeave: num('c-stockToLeave', 0.4),
    stepdown: num('c-stepdown', 3),
    roughStepover: num('c-roughStepover', 45),
    ramp: bool('c-ramp'),
    strategy: str('c-strategy', 'raster'),
    finishStepover: num('c-finishStepover', 0.8),
    finishAngle: num('c-finishAngleRaster', 0),
    zigzag: bool('c-zigzag'),
    sampleStep: Math.max(0.25, Math.min(1, num('c-finishStepover', 0.8))),
    thickness: num('c-thickness', 25),
    cutout: bool('c-cutout'),
    tabCount: num('c-tabCount', 6),
    tabWidth: num('c-tabWidth', 12),
    tabHeight: num('c-tabHeight', 4),
  };
}

function readPost() {
  return {
    ...POST_DEFAULTS,
    flavor: str('c-flavor', 'grbl'),
    origin: str('c-origin', 'center'),
    safeZ: num('c-safeZ', 6),
    clearZ: num('c-clearZ', 1.5),
    feedXY: num('c-feedXY', 2200),
    feedRough: num('c-feedRough', 2800),
    feedPlunge: num('c-feedPlunge', 500),
    spindle: num('c-spindle', 18000),
  };
}

// ----------------------------------------------------------------- hesap

function busy(on) {
  els.busy.hidden = !on;
}

function rebuild() {
  const p = readPattern();
  const surf = buildSurface(p);
  const tool = finishTool();
  const comp = compensate(surf, tool);
  state.surf = surf;
  state.toolZ = comp.z;
  state.realZ = machinedSurface(surf, comp.z, tool);
  state.maxLift = comp.maxLift;
  // Desen değişti: eldeki yollar artık geçersiz.
  state.result = null;
  state.gcode = null;
  els['dl-gcode'].disabled = true;
  draw();
  report();
  save();
}

function calc() {
  busy(true);
  setTimeout(() => {
    try {
      const cam = readCam();
      const res = buildToolpaths(state.surf, cam);
      state.result = res;
      const post = readPost();
      state.gcode = toGcode(res, state.surf, post, (x, y) => sampleZ(res.finishMap, x, y));
      els['dl-gcode'].disabled = false;
      setView('path');
      report();
    } catch (err) {
      alert('Hesap sırasında hata: ' + err.message);
      console.error(err);
    } finally {
      busy(false);
    }
  }, 30);
}

// --------------------------------------------------------------- çizimler

function draw() {
  if (!state.surf) return;
  const material = str('c-material', 'tas');
  if (state.view === 'relief') {
    drawRelief(els['view-relief'], state.surf, state.realZ, { material });
  } else if (state.view === 'path') {
    if (state.result) {
      drawToolpaths(els['view-path'], state.surf, state.result, {
        only: state.pathFilter,
        showLinks: bool('c-showLinks'),
      });
    } else {
      const c = els['view-path'];
      const { w, h } = sizeCanvas(c);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#0b0e12';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#9aa5b1';
      ctx.font = '14px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Önce "Takım yollarını hesapla"ya basın.', w / 2, h / 2);
    }
  } else if (state.view === 'section') {
    drawSection(els['view-section'], state.surf, state.surf.z, state.realZ, {
      axis: state.secAxis,
      pos: num('c-secPos', 0.5),
      thickness: num('c-thickness', 25),
    });
  } else if (state.view === '3d' && state.view3d) {
    state.view3d.update(state.surf, state.realZ, { material });
  }
}

function fmt(v, d = 1) {
  return Number(v).toFixed(d);
}

function chip(label, value) {
  return `<span class="chip">${label}<b>${value}</b></span>`;
}

function report() {
  if (!state.surf) return;
  const s = state.surf;
  const tool = finishTool();
  const step = num('c-finishStepover', 0.8);
  const scal = scallopHeight(tool, step);
  let deepReal = 0;
  for (const v of state.realZ) if (v < deepReal) deepReal = v;

  const chips = [
    chip('Panel ', `${fmt(s.panelW, 0)}×${fmt(s.panelH, 0)} mm`),
    chip('İdeal en derin ', `${fmt(s.minZ, 2)} mm`),
    chip('Uçla ulaşılan ', `${fmt(deepReal, 2)} mm`),
    chip('Tırtık ', `${fmt(scal, 3)} mm`),
    chip('Çözünürlük ', `${fmt(s.mmPerPx, 2)} mm/örnek`),
  ];
  if (state.result) {
    const st = state.result.stats;
    chips.push(chip('Toplam yol ', `${fmt(st.cutLength / 1000, 1)} m`));
    chips.push(chip('Nokta ', `${st.points.toLocaleString('tr-TR')}`));
  }
  if (state.gcode) {
    const g = state.gcode.stats;
    const h = Math.floor(g.timeMin / 60);
    const m = Math.round(g.timeMin % 60);
    chips.push(chip('Tahmini süre ', h ? `${h} sa ${m} dk` : `${m} dk`));
    chips.push(chip('G-code ', `${g.lines.toLocaleString('tr-TR')} satır`));
  }
  els.summary.innerHTML = chips.join('');

  const warns = [];
  if (Math.abs(s.minZ) > num('c-thickness', 25) - 1) {
    warns.push(`Derinlik (${fmt(Math.abs(s.minZ), 1)} mm) malzeme kalınlığına çok yakın.`);
  }
  if (state.maxLift > 0.3) {
    warns.push(
      `${tool.dia} mm ${toolLabel(tool)} oluk diplerine tam giremiyor: en dar yerde ` +
      `${fmt(state.maxLift, 2)} mm sığ kalıyor. Önizleme zaten gerçekte çıkacak ` +
      `yüzeyi gösteriyor; daha derin dip için ince uç veya az bant.`
    );
  }
  if (state.result) for (const w of state.result.warnings) if (!warns.includes(w)) warns.push(w);
  els.warnings.hidden = warns.length === 0;
  els.warnings.innerHTML = warns.length ? `<ul>${warns.map((w) => `<li>${w}</li>`).join('')}</ul>` : '';

  reportTable();
}

function reportTable() {
  if (!state.result) {
    els.report.innerHTML =
      '<p class="hint">Yolları hesaplayınca burada paso listesi, süre ve dosya ' +
      'bilgisi çıkar.</p>';
    return;
  }
  const rows = state.result.passes.map((p) => {
    let len = 0;
    for (const path of p.paths) {
      for (let i = 3; i < path.length; i += 3) {
        len += Math.hypot(path[i] - path[i - 3], path[i + 1] - path[i - 2], path[i + 2] - path[i - 1]);
      }
    }
    return `<tr><td>${p.name}</td><td>${p.paths.length}</td><td>${fmt(len / 1000, 1)} m</td></tr>`;
  });
  const g = state.gcode?.stats;
  els.report.innerHTML =
    `<table><tr><th>Paso</th><th>Yol</th><th>Uzunluk</th></tr>${rows.join('')}</table>` +
    (g
      ? `<p class="hint">Dosya: ${(state.gcode.text.length / 1024 / 1024).toFixed(2)} MB · ` +
        `en derin Z: ${fmt(g.minZ, 2)} mm · ` +
        `X ${fmt(g.bbox.x0, 1)}…${fmt(g.bbox.x1, 1)} · Y ${fmt(g.bbox.y0, 1)}…${fmt(g.bbox.y1, 1)} mm</p>`
      : '');
}

// ------------------------------------------------------------------ hazır

const PRESETS = {
  foto: { pattern: 'twist', bands: 7, swirl: 2.6, swirlMode: 'merkez', falloffPow: 1.6, angle: 20,
    profileKind: 'dome', skew: 0.25, sharpness: 1, depth: 12, depthCenter: 1, depthRim: 0.7,
    domeShape: 'kubbe', domeRise: 3, rimWidth: 18, levels: 0, shape: 'disc' },
  spiral: { pattern: 'spiral', bands: 9, arms: 2, logSpiral: true, profileKind: 'dome', skew: 0.3,
    depth: 10, domeShape: 'kubbe', domeRise: 4, rimWidth: 15, levels: 0 },
  halka: { pattern: 'ripple', bands: 14, profileKind: 'sine', skew: 0, depth: 7,
    depthCenter: 1.4, depthRim: 0.5, domeShape: 'kubbe', domeRise: 6, rimWidth: 12, levels: 0 },
  kum: { pattern: 'dune', bands: 9, wave: 0.45, waveFreq: 1.6, angle: 12, profileKind: 'dome',
    skew: 0.55, sharpness: 1.2, depth: 9, domeShape: 'yok', domeRise: 0, rimWidth: 20, levels: 0 },
  yelpaze: { pattern: 'fan', arms: 22, profileKind: 'sine', skew: 0, depth: 8,
    depthCenter: 0.15, depthRim: 1.1, domeShape: 'canak', domeRise: 5, rimWidth: 14,
    centerFlat: 60, levels: 0 },
  orgu: { pattern: 'weave', bands: 8, angle: 45, profileKind: 'dome', skew: 0, depth: 10,
    domeShape: 'yok', domeRise: 0, rimWidth: 16, levels: 0 },
  cicek: { pattern: 'flower', bands: 8, arms: 6, petal: 0.35, profileKind: 'sine', depth: 9,
    depthCenter: 1.2, depthRim: 0.6, domeShape: 'kubbe', domeRise: 5, rimWidth: 14, levels: 0 },
  kademe: { pattern: 'ripple', bands: 6, swirl: 0, profileKind: 'sine', skew: 0, depth: 16,
    levels: 5, depthCenter: 1, depthRim: 1, domeShape: 'kubbe', domeRise: 6, rimWidth: 20,
    shape: 'disc' },
};

function applyPreset(name) {
  const p = PRESETS[name];
  if (!p) return;
  const map = {
    pattern: 'c-pattern', shape: 'c-shape', bands: 'c-bands', arms: 'c-arms', swirl: 'c-swirl',
    swirlMode: 'c-swirlMode', falloffPow: 'c-falloffPow', angle: 'c-angle', wave: 'c-wave',
    waveFreq: 'c-waveFreq', petal: 'c-petal', profileKind: 'c-profileKind', skew: 'c-skew',
    sharpness: 'c-sharpness', plateau: 'c-plateau', levels: 'c-levels', depth: 'c-depth',
    depthCenter: 'c-depthCenter', depthRim: 'c-depthRim', domeShape: 'c-domeShape',
    domeRise: 'c-domeRise', rimWidth: 'c-rimWidth', centerFlat: 'c-centerFlat',
  };
  for (const [k, v] of Object.entries(p)) {
    const id = map[k];
    if (!id || !els[id]) continue;
    if (els[id].type === 'checkbox') els[id].checked = !!v;
    else els[id].value = v;
  }
  if (p.logSpiral !== undefined && els['c-logSpiral']) els['c-logSpiral'].checked = !!p.logSpiral;
  syncOutputs();
  rebuild();
}

function randomDesign() {
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const rnd = (a, b, s = 1) => Math.round((a + Math.random() * (b - a)) / s) * s;
  els['c-pattern'].value = pick(['twist', 'spiral', 'ripple', 'dune', 'chevron', 'weave', 'flower', 'fan']);
  els['c-bands'].value = rnd(4, 18);
  els['c-arms'].value = rnd(1, 8);
  els['c-swirl'].value = rnd(0, 5, 0.1);
  els['c-swirlMode'].value = pick(['merkez', 'kenar', 'vorteks']);
  els['c-angle'].value = rnd(-90, 90, 5);
  els['c-profileKind'].value = pick(['dome', 'sine', 'oluk', 'vee', 'saw', 'plato']);
  els['c-skew'].value = rnd(-0.8, 0.8, 0.05);
  els['c-depth'].value = rnd(5, 18, 0.5);
  els['c-domeShape'].value = pick(['kubbe', 'canak', 'yok']);
  els['c-levels'].value = Math.random() < 0.25 ? rnd(4, 12) : 0;
  syncOutputs();
  rebuild();
}

// ------------------------------------------------------------- indirmeler

function download(filename, data, mime) {
  const blob = data instanceof ArrayBuffer
    ? new Blob([data], { type: mime })
    : new Blob([data], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function baseName() {
  const p = readPattern();
  return `rolyef-${p.pattern}-${Math.round(p.panelW)}x${Math.round(p.panelH)}`;
}

function downloadPng() {
  const px = heightmapPixels(state.surf, state.realZ);
  const c = document.createElement('canvas');
  c.width = px.width;
  c.height = px.height;
  c.getContext('2d').putImageData(new ImageData(px.data, px.width, px.height), 0, 0);
  c.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${baseName()}-yukseklik.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }, 'image/png');
}

// --------------------------------------------------------------- kayıt

function collectSettings() {
  const out = {};
  for (const el of document.querySelectorAll('[id^="c-"]')) {
    out[el.id] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return out;
}

function applySettings(data) {
  if (!data) return;
  for (const [id, v] of Object.entries(data)) {
    const el = els[id];
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v;
  }
  syncOutputs();
}

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(collectSettings())); } catch { /* yoksay */ }
}

function load() {
  try { applySettings(JSON.parse(localStorage.getItem(STORE_KEY) || 'null')); } catch { /* yoksay */ }
}

// ----------------------------------------------------------------- olaylar

function syncOutputs() {
  for (const o of document.querySelectorAll('output[for]')) {
    const el = els[o.getAttribute('for')];
    if (el) o.textContent = el.value;
  }
  // Duruma göre alakasız alanları gizle
  const shape = str('c-shape', 'disc');
  toggleRow('c-panelH', shape !== 'disc');
  toggleRow('c-cornerR', shape === 'rounded');
  const ft = str('c-finishType', 'ball');
  toggleRow('c-finishCornerR', ft === 'bull');
  toggleRow('c-finishAngle', ft === 'vbit');
  const pat = str('c-pattern', 'twist');
  toggleRow('c-swirl', pat === 'twist');
  toggleRow('c-swirlMode', pat === 'twist');
  toggleRow('c-falloffPow', pat === 'twist');
  toggleRow('c-arms', ['spiral', 'fan', 'flower'].includes(pat));
  toggleRow('c-logSpiral', pat === 'spiral');
  toggleRow('c-wave', ['dune', 'chevron'].includes(pat));
  toggleRow('c-waveFreq', pat === 'dune');
  toggleRow('c-petal', pat === 'flower');
  toggleRow('c-plateau', str('c-profileKind') === 'plato');
  toggleRow('c-finishAngleRaster', str('c-strategy') === 'raster');
}

function toggleRow(id, show) {
  const el = els[id];
  if (!el) return;
  const label = el.closest('label');
  if (label) label.style.display = show ? '' : 'none';
}

let timer = null;
function scheduleRebuild() {
  clearTimeout(timer);
  busy(true);
  timer = setTimeout(() => {
    try { rebuild(); } finally { busy(false); }
  }, 160);
}

function setView(v) {
  state.view = v;
  for (const t of document.querySelectorAll('.tab')) {
    const on = t.dataset.view === v;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
  }
  for (const el of document.querySelectorAll('.view')) {
    el.classList.toggle('active', el.id === `view-${v}`);
  }
  els['section-tools'].hidden = v !== 'section';
  els['path-tools'].hidden = v !== 'path';
  if (v === '3d' && !state.view3d) {
    createView3d(els['view-3d']).then((vw) => {
      state.view3d = vw;
      draw();
    });
  }
  draw();
}

function init() {
  load();
  syncOutputs();

  document.addEventListener('input', (e) => {
    const id = e.target.id || '';
    if (!id.startsWith('c-')) return;
    syncOutputs();
    if (id === 'c-secPos' || id === 'c-showLinks') { draw(); save(); return; }
    if (id === 'c-material') { draw(); save(); return; }
    // Takım/kesme ayarları yüzeyi değil yolları etkiler; yüzey telafisi için
    // yine de finiş ucu gerekiyor, o yüzden uç değişimi yeniden hesaplatır.
    scheduleRebuild();
  });
  document.addEventListener('change', (e) => {
    if ((e.target.id || '').startsWith('c-')) save();
  });

  for (const t of document.querySelectorAll('.tab')) {
    t.addEventListener('click', () => setView(t.dataset.view));
  }
  for (const b of document.querySelectorAll('#presets [data-preset]')) {
    b.addEventListener('click', () => applyPreset(b.dataset.preset));
  }
  els['btn-random'].addEventListener('click', randomDesign);
  els['btn-calc'].addEventListener('click', calc);

  els['sec-x'].addEventListener('click', () => { state.secAxis = 'x'; els['sec-x'].classList.add('active'); els['sec-y'].classList.remove('active'); draw(); });
  els['sec-y'].addEventListener('click', () => { state.secAxis = 'y'; els['sec-y'].classList.add('active'); els['sec-x'].classList.remove('active'); draw(); });
  for (const [id, f] of [['pv-all', 'all'], ['pv-rough', 'rough'], ['pv-finish', 'finish']]) {
    els[id].addEventListener('click', () => {
      state.pathFilter = f;
      for (const b of ['pv-all', 'pv-rough', 'pv-finish']) els[b].classList.toggle('active', b === id);
      draw();
    });
  }

  els['btn-scallop'].addEventListener('click', () => {
    const t = finishTool();
    const target = num('c-scallopTarget', 0.03);
    const step = stepoverForScallop(t, target);
    els['c-finishStepover'].value = step.toFixed(2);
    els['scallop-hint'].textContent =
      `${t.dia} mm ${toolLabel(t)} ile ${target} mm tırtık için yanal adım ${step.toFixed(2)} mm. ` +
      `Daha küçük adım = daha pürüzsüz ama daha uzun süre.`;
    syncOutputs();
    scheduleRebuild();
  });

  els['dl-gcode'].addEventListener('click', () => {
    if (!state.gcode) return;
    const ext = str('c-flavor') === 'fanuc' ? 'nc' : 'nc';
    download(`${baseName()}.${ext}`, state.gcode.text, 'text/plain');
  });
  els['dl-png'].addEventListener('click', downloadPng);
  els['dl-stl'].addEventListener('click', () => {
    const buf = surfaceToStl(state.surf, state.realZ, { thickness: num('c-thickness', 25) });
    download(`${baseName()}.stl`, buf, 'model/stl');
  });
  els['dl-csv'].addEventListener('click', () => {
    download(`${baseName()}-derinlik.csv`, depthCsv(state.surf, state.realZ, 10, str('c-origin', 'center')), 'text/csv');
  });
  els['dl-json'].addEventListener('click', () => {
    download(`${baseName()}-ayarlar.json`, JSON.stringify(collectSettings(), null, 2), 'application/json');
  });
  els['load-json'].addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      applySettings(JSON.parse(await f.text()));
      rebuild();
    } catch {
      alert('Ayar dosyası okunamadı.');
    }
    e.target.value = '';
  });
  els['btn-reset'].addEventListener('click', () => {
    try { localStorage.removeItem(STORE_KEY); } catch { /* yoksay */ }
    location.reload();
  });

  window.addEventListener('resize', () => {
    state.view3d?.resize();
    draw();
  });

  rebuild();
  setView('relief');
}

init();

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
