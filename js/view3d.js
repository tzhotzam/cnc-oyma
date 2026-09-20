// 3B önizleme (three.js). CDN'den yüklenir; internet yoksa sessizce kapanır,
// uygulamanın geri kalanı ve G-code üretimi çevrimdışı çalışmaya devam eder.

import { MATERIALS } from './preview.js';

let THREE = null;
let OrbitControls = null;

async function loadThree() {
  if (THREE) return true;
  try {
    THREE = await import('three');
    ({ OrbitControls } = await import('three/addons/controls/OrbitControls.js'));
    return true;
  } catch {
    return false;
  }
}

export async function createView3d(container) {
  const ok = await loadThree();
  if (!ok) {
    container.innerHTML =
      '<p style="padding:20px;color:#9aa5b1;font-size:13px;text-align:center">' +
      '3B önizleme için internet gerekiyor (three.js CDN). Rölyef, kesit ve ' +
      'G-code çevrimdışı çalışır.</p>';
    return { update() {}, resize() {}, dispose() {} };
  }

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(container.clientWidth || 640, container.clientHeight || 480, false);
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.domElement.style.display = 'block';
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0e12);
  const camera = new THREE.PerspectiveCamera(38, 4 / 3, 1, 20000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  scene.add(new THREE.HemisphereLight(0xdfe7f2, 0x20242b, 1.2));
  const key = new THREE.DirectionalLight(0xfff3e2, 2.4);
  key.position.set(-1, 1.2, 0.8);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x9fc5ff, 0.5);
  rim.position.set(1, -0.4, -0.6);
  scene.add(rim);

  let mesh = null;
  let raf = 0;

  function loop() {
    controls.update();
    renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  }
  loop();

  function resize() {
    const w = container.clientWidth || 640;
    const h = container.clientHeight || 480;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  }

  function update(surf, z, opts = {}) {
    if (mesh) {
      scene.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
      mesh = null;
    }
    if (!surf) return;

    // Ekran için seyreltme: 300x300 üçgen ağı yeterince akıcı.
    const k = Math.max(1, Math.ceil(Math.max(surf.w, surf.h) / 300));
    const w = Math.floor((surf.w - 1) / k) + 1;
    const h = Math.floor((surf.h - 1) / k) + 1;
    const pos = new Float32Array(w * h * 3);
    const cx = surf.panelW / 2;
    const cy = surf.panelH / 2;
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const sc = Math.min(surf.w - 1, c * k);
        const sr = Math.min(surf.h - 1, r * k);
        const i = (r * w + c) * 3;
        pos[i] = sc * surf.mmPerPx - cx;
        pos[i + 1] = z[sr * surf.w + sc];
        pos[i + 2] = -(sr * surf.mmPerPy - cy);
      }
    }
    const idx = [];
    for (let r = 0; r < h - 1; r++) {
      for (let c = 0; c < w - 1; c++) {
        const a = r * w + c, b = r * w + c + 1, d = (r + 1) * w + c, e = (r + 1) * w + c + 1;
        const sc = Math.min(surf.w - 1, c * k);
        const sr = Math.min(surf.h - 1, r * k);
        // Panel dışındaki hücreler çizilmez (yuvarlak panel kenarı).
        if (!surf.inside[sr * surf.w + sc]) continue;
        idx.push(a, d, b, b, d, e);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();

    const base = (MATERIALS[opts.material] || MATERIALS.tas).base;
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(base[0] / 255, base[1] / 255, base[2] / 255),
      roughness: 0.82,
      metalness: 0.02,
      side: THREE.DoubleSide,
      flatShading: false,
    });
    mesh = new THREE.Mesh(geo, mat);
    scene.add(mesh);

    if (!update.framed) {
      const d = Math.max(surf.panelW, surf.panelH);
      camera.position.set(-d * 0.55, d * 0.75, d * 0.95);
      controls.target.set(0, 0, 0);
      camera.updateProjectionMatrix();
      update.framed = true;
    }
    resize();
  }

  return {
    update,
    resize,
    dispose() {
      cancelAnimationFrame(raf);
      controls.dispose();
      renderer.dispose();
    },
  };
}
