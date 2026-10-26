/*
 * 3D viewer — draws the warehouse FROM the data in WarehouseCore.
 * Nothing here is hand-placed: racks, pallets, docks and zones all come
 * from the model, so a different site file draws a different warehouse.
 *
 * Needs THREE (r128) and THREE.OrbitControls loaded first.
 */
(function (root) {
  'use strict';
  const W = root.WarehouseCore;

  const css = (name, el) => getComputedStyle(el || document.documentElement).getPropertyValue(name).trim() || '#888';
  const reduceMotion = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const lowPower = () => window.innerWidth < 760 || (navigator.hardwareConcurrency || 8) <= 4;

  // ---------- Procedural textures (no image files needed) ----------
  function lcg(seed) { let x = seed; return () => (x = (x * 1664525 + 1013904223) % 4294967296) / 4294967296; }
  function canvasTex(w, h, draw) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c);
    t.encoding = THREE.sRGBEncoding; t.anisotropy = 4;
    return t;
  }
  // Polished concrete: speckle, a few stains, saw-cut joints at the tile edge (tinted by the floor colour)
  function floorTexture() {
    const rnd = lcg(11);
    const t = canvasTex(512, 512, (g, w, h) => {
      g.fillStyle = '#e4e4e4'; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 7; i++) {
        const x = rnd() * w, y = rnd() * h, r = 40 + rnd() * 120;
        const gr = g.createRadialGradient(x, y, 0, x, y, r);
        gr.addColorStop(0, 'rgba(120,120,120,0.10)'); gr.addColorStop(1, 'rgba(120,120,120,0)');
        g.fillStyle = gr; g.fillRect(0, 0, w, h);
      }
      for (let i = 0; i < 9000; i++) { const v = (170 + rnd() * 70) | 0; g.fillStyle = `rgba(${v},${v},${v},0.35)`; g.fillRect(rnd() * w, rnd() * h, 1 + rnd() * 1.5, 1 + rnd() * 1.5); }
      g.strokeStyle = 'rgba(80,80,80,0.55)'; g.lineWidth = 2; g.strokeRect(1, 1, w - 2, h - 2);
    });
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(W.GEOM.width / 7.5, W.GEOM.depth / 7.5);
    return t;
  }
  // A shrink-wrapped carton on a wooden pallet: tape, a shipping label with a barcode, slats below
  function palletTexture(hex) {
    return canvasTex(256, 256, (g, w, h) => {
      const base = h * 0.86;
      g.fillStyle = hex; g.fillRect(0, 0, w, base);
      const sh = g.createLinearGradient(0, 0, w, 0);
      sh.addColorStop(0, 'rgba(0,0,0,0.16)'); sh.addColorStop(0.08, 'rgba(0,0,0,0)'); sh.addColorStop(0.92, 'rgba(0,0,0,0)'); sh.addColorStop(1, 'rgba(0,0,0,0.16)');
      g.fillStyle = sh; g.fillRect(0, 0, w, base);
      g.fillStyle = 'rgba(0,0,0,0.10)'; g.fillRect(0, base * 0.5 - 1, w, 2);          // carton seam
      g.fillStyle = 'rgba(255,255,255,0.22)'; g.fillRect(w * 0.44, 0, w * 0.12, base); // tape
      g.fillStyle = '#f6f6f2'; g.fillRect(w * 0.12, base * 0.6, w * 0.3, base * 0.24); // label
      g.fillStyle = '#222';
      for (let i = 0; i < 18; i++) g.fillRect(w * 0.14 + i * 3.6, base * 0.66, i % 3 ? 1.4 : 2.4, base * 0.12);
      g.fillStyle = '#6e4f33'; g.fillRect(0, base, w, h - base);                      // pallet
      g.fillStyle = '#3a2a1c';
      for (const x of [0.18, 0.5, 0.82]) g.fillRect(w * x - 18, base + 8, 36, h - base - 8);
    });
  }
  class WarehouseViewer {
    constructor(container, model, opts = {}) {
      this.el = container;
      this.model = model;
      this.opts = opts;
      this.planMeshes = new Map(); // planId -> {mesh, color}
      this.routes = new Map();     // planId -> route
      this.labels = [];
      this.flight = null;
      this.clock = new THREE.Clock();
      this.hooks = [];            // per-frame callbacks (dt, t) from the immersive layer
      this.manualCamera = false;  // true while walking or in a cinematic
      this.hq = !lowPower();

      const r = this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
      r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      r.outputEncoding = THREE.sRGBEncoding;
      r.toneMapping = THREE.ACESFilmicToneMapping;
      r.toneMappingExposure = 1.05;
      if (this.hq) { r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap; }
      container.appendChild(r.domElement);
      r.domElement.setAttribute('aria-label', '3D view of the warehouse. Drag to rotate, scroll to zoom, right-drag to pan.');
      r.domElement.setAttribute('role', 'img');

      this.labelLayer = document.createElement('div');
      this.labelLayer.className = 'scene-labels';
      container.appendChild(this.labelLayer);

      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(42, 1, 0.5, 900);
      this.camera.position.set(30, 105, 150);
      this.controls = new THREE.OrbitControls(this.camera, r.domElement);
      this.controls.target.set(0, 0, -4);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.08;
      this.controls.maxPolarAngle = 1.42;
      this.controls.minDistance = 12;
      this.controls.maxDistance = 300;
      this.controls.addEventListener('start', () => { this.flight = null; });

      this.hemi = new THREE.HemisphereLight(0xffffff, 0x8a8f99, 0.9);
      this.scene.add(this.hemi);
      const sun = this.sun = new THREE.DirectionalLight(0xfff4e0, 0.75);
      sun.position.set(-50, 110, 70);
      if (this.hq) {
        sun.castShadow = true;
        sun.shadow.mapSize.set(2048, 2048);
        Object.assign(sun.shadow.camera, { left: -95, right: 95, top: 75, bottom: -75, near: 10, far: 300 });
        sun.shadow.bias = -0.0008;
        sun.shadow.normalBias = 0.04;
      }
      this.scene.add(sun);

      this.build();
      this.applyTheme();
      this.bindPicking();

      const ro = new ResizeObserver(() => this.resize());
      ro.observe(container);
      this.resize();
      this.flight = null; this.focus('overview'); if (this.flight) { const f = this.flight; this.controls.target.copy(f.toT); this.camera.position.copy(f.toP); this.flight = null; }
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      mq.addEventListener && mq.addEventListener('change', () => this.applyTheme());
      new MutationObserver(() => this.applyTheme()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

      const loop = () => { this.frame(); this.raf = requestAnimationFrame(loop); };
      loop();
    }

    // ---------- Build the static site ----------
    build() {
      if (this.site) { this.scene.remove(this.site); this.disposeTree(this.site); }
      this.labels.forEach(l => l.el.remove());
      this.labels = [];
      const g = this.site = new THREE.Group();
      this.scene.add(g);
      const G = W.GEOM;
      this.mats = {};
      const mat = (key, extra) => (this.mats[key] = new THREE.MeshLambertMaterial(Object.assign({ color: 0x888888 }, extra)));

      // Floor and yard
      this.floorTex = this.floorTex || floorTexture();
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(G.width, G.depth), mat('floor', { map: this.floorTex }));
      floor.receiveShadow = true;
      floor.rotation.x = -Math.PI / 2;
      g.add(floor);
      const yard = new THREE.Mesh(new THREE.PlaneGeometry(G.width + 60, 40), mat('yard'));
      yard.rotation.x = -Math.PI / 2; yard.position.set(0, -0.02, G.depth / 2 + 20);
      g.add(yard);

      // Zone floor tints + outlines
      for (const z of W.ZONES) {
        const b = z.bounds, w = b.x1 - b.x0, d = b.z1 - b.z0;
        const tint = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat('zone' + z.id, { transparent: true, opacity: 0.22 }));
        tint.rotation.x = -Math.PI / 2; tint.position.set(b.x0 + w / 2, 0.02, b.z0 + d / 2);
        g.add(tint);
        const h = z.id === 'A' ? 0.05 : 7.5; // chilled chamber, DG store and cage have walls
        const box = new THREE.BoxGeometry(w, h, d);
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(box), new THREE.LineBasicMaterial({ transparent: true, opacity: 0.85 }));
        edges.position.set(b.x0 + w / 2, h / 2, b.z0 + d / 2);
        edges.userData.zone = z.id;
        g.add(edges);
        (this.zoneEdges || (this.zoneEdges = {}))[z.id] = edges;
        if (z.id !== 'A') {
          const wall = new THREE.Mesh(box, mat('wall' + z.id, { transparent: true, opacity: z.id === 'S' ? 0.05 : 0.09, depthWrite: false, side: THREE.DoubleSide }));
          wall.position.copy(edges.position);
          g.add(wall);
        }
        this.addLabel(`<b>${z.id}</b> ${z.name}<span>${z.temp.min}–${z.temp.max} °C</span>`, new THREE.Vector3(b.x0 + w / 2, z.id === 'A' ? 9 : 10, b.z0 + d / 2), 'zone zone-' + z.id);
      }

      // Safety-yellow walkway lines along the cross aisle and the chilled corridor
      const lineMat = mat('marking');
      const stripe = (x, z, w, d) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), lineMat); m.rotation.x = -Math.PI / 2; m.position.set(x, 0.04, z); g.add(m); };
      stripe(0, G.crossAisleZ - 1.6, 156, 0.18); stripe(0, G.crossAisleZ + 1.6, 156, 0.18);
      stripe(G.chilledCorridorX - 1.2, 17, 0.18, 30); stripe(G.chilledCorridorX + 1.2, 17, 0.18, 30);

      // Perimeter walls (low, see-through) with dock doors on the south wall
      const wallMat = mat('perimeter', { transparent: true, opacity: 0.18, depthWrite: false });
      const wallH = 3;
      const addWall = (x, z, w, d) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, wallH, d), wallMat); m.position.set(x, wallH / 2, z); g.add(m); };
      addWall(0, -G.depth / 2, G.width, 0.3); addWall(-G.width / 2, 0, 0.3, G.depth); addWall(G.width / 2, 0, 0.3, G.depth);
      const doorW = 3.6;
      let x = -G.width / 2;
      for (const d of W.DOCKS) {
        const left = d.x - doorW / 2;
        addWall((x + left) / 2, G.depth / 2, left - x, 0.3);
        x = d.x + doorW / 2;
        const door = new THREE.Mesh(new THREE.BoxGeometry(doorW, 3.4, 0.2), mat(d.zone === 'C' ? 'doorReefer' : 'door'));
        door.position.set(d.x, 1.7, G.depth / 2 + 0.1);
        g.add(door);
        const lev = new THREE.Mesh(new THREE.BoxGeometry(doorW, 0.25, 3), this.mats.door);
        lev.position.set(d.x, 0.12, G.depth / 2 + 1.6);
        g.add(lev);
        this.addLabel(d.id, new THREE.Vector3(d.x, 4.6, G.depth / 2 + 1), 'dock' + (d.zone === 'C' ? ' reefer' : ''));
      }
      addWall((x + G.width / 2) / 2, G.depth / 2, G.width / 2 - x, 0.3);

      this.buildRacks(g);
      this.buildPallets();
    }

    buildRacks(g) {
      const G = W.GEOM;
      const rows = new Map();
      for (const s of this.model.slots) {
        const k = s.zone + s.row;
        const r = rows.get(k) || { x: s.x, z0: Infinity, z1: -Infinity, levels: 0 };
        r.z0 = Math.min(r.z0, s.z); r.z1 = Math.max(r.z1, s.z); r.levels = Math.max(r.levels, s.level);
        rows.set(k, r);
      }
      const up = [], beams = [];
      this.rackBoxes = [];
      for (const r of rows.values()) {
        const zStart = r.z0 - G.slotLength / 2, zEnd = r.z1 + G.slotLength / 2;
        this.rackBoxes.push({ x0: r.x - G.rackDepth / 2, x1: r.x + G.rackDepth / 2, z0: zStart, z1: zEnd });
        const height = r.levels * G.levelHeight + 0.4;
        const n = Math.round((zEnd - zStart) / (G.slotLength * 3));
        for (let i = 0; i <= n; i++) {
          const z = zStart + (i * (zEnd - zStart)) / n;
          up.push([r.x - G.rackDepth / 2 + 0.05, height / 2, z, height]);
          up.push([r.x + G.rackDepth / 2 - 0.05, height / 2, z, height]);
        }
        for (let l = 0; l < r.levels; l++) {
          const y = 0.1 + l * G.levelHeight + (l ? 0 : -0.05);
          if (l === 0) continue; // floor level sits on the floor
          beams.push([r.x - G.rackDepth / 2 + 0.05, y, (zStart + zEnd) / 2, zEnd - zStart]);
          beams.push([r.x + G.rackDepth / 2 - 0.05, y, (zStart + zEnd) / 2, zEnd - zStart]);
        }
        // top beam
        const yTop = 0.1 + r.levels * G.levelHeight;
        beams.push([r.x - G.rackDepth / 2 + 0.05, yTop, (zStart + zEnd) / 2, zEnd - zStart]);
        beams.push([r.x + G.rackDepth / 2 - 0.05, yTop, (zStart + zEnd) / 2, zEnd - zStart]);
      }
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
      const upMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.09, 1, 0.09), this.mats.upright || (this.mats.upright = new THREE.MeshLambertMaterial()), up.length);
      up.forEach((u, i) => { p.set(u[0], u[1], u[2]); s.set(1, u[3], 1); upMesh.setMatrixAt(i, m4.compose(p, q, s)); });
      const beamMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.08, 0.14, 1), this.mats.beam || (this.mats.beam = new THREE.MeshLambertMaterial()), beams.length);
      beams.forEach((b, i) => { p.set(b[0], b[1], b[2]); s.set(1, 1, b[3]); beamMesh.setMatrixAt(i, m4.compose(p, q, s)); });
      for (const m of [upMesh, beamMesh]) { m.castShadow = true; m.receiveShadow = true; }
      g.add(upMesh, beamMesh);
    }

    palletMatrix(slot, m4) {
      const G = W.GEOM;
      const p = new THREE.Vector3(slot.x, 0.18 + (slot.level - 1) * G.levelHeight + G.palletHeight / 2, slot.z);
      return m4.compose(p, new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
    }

    buildPallets() {
      ['occMesh', 'blockMesh'].forEach(k => { if (this[k]) { this.site.remove(this[k]); this[k].geometry.dispose(); } });
      const geo = new THREE.BoxGeometry(1.0, W.GEOM.palletHeight, 1.15);
      const occ = this.model.slots.filter(s => s.status === 'occupied');
      const blk = this.model.slots.filter(s => s.status === 'blocked');
      this.mats.pallet = this.mats.pallet || new THREE.MeshLambertMaterial({ color: 0xffffff });
      this.mats.blocked = this.mats.blocked || new THREE.MeshLambertMaterial();
      const m4 = new THREE.Matrix4();
      const occMesh = this.occMesh = new THREE.InstancedMesh(geo, this.mats.pallet, occ.length);
      const c = new THREE.Color();
      let seed = 7;
      occ.forEach((s, i) => {
        occMesh.setMatrixAt(i, this.palletMatrix(s, m4));
        seed = (seed * 9301 + 49297) % 233280;
        const v = 0.86 + (seed / 233280) * 0.2; // cardboard tone variation
        occMesh.setColorAt(i, c.setScalar(v));
      });
      occMesh.userData.slots = occ;
      const blockMesh = this.blockMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1.0, 0.25, 1.15), this.mats.blocked, Math.max(1, blk.length));
      blk.forEach((s, i) => { const mm = this.palletMatrix(s, m4); mm.elements[13] -= W.GEOM.palletHeight / 2 - 0.15; blockMesh.setMatrixAt(i, mm); });
      blockMesh.count = blk.length;
      blockMesh.userData.slots = blk;
      occMesh.castShadow = true; occMesh.receiveShadow = true;
      this.site.add(occMesh, blockMesh);
    }

    rebuild() {
      this.clearPlans();
      this.build();
      this.applyTheme();
    }

    // ---------- Theme ----------
    applyTheme() {
      const set = (k, v) => this.mats[k] && this.mats[k].color.set(v);
      this.renderer.setClearColor(new THREE.Color(css('--scene-bg')), 1);
      set('floor', css('--scene-floor')); set('yard', css('--scene-yard'));
      set('marking', css('--safety')); set('perimeter', css('--scene-wall'));
      set('door', css('--scene-door')); set('doorReefer', css('--zone-C'));
      set('upright', css('--rack-upright')); set('beam', css('--rack-beam'));
      set('blocked', css('--critical'));
      const pc = css('--pallet');
      if (this.palletHex !== pc) {
        this.palletHex = pc;
        if (this.mats.pallet.map) this.mats.pallet.map.dispose();
        this.mats.pallet.map = palletTexture(pc);
        this.mats.pallet.color.set(0xffffff);
        this.mats.pallet.needsUpdate = true;
      }
      this.planTex = this.planTex || palletTexture('#f2f2f2');
      for (const z of W.ZONES) {
        set('zone' + z.id, css('--zone-' + z.id)); set('wall' + z.id, css('--zone-' + z.id));
        if (this.zoneEdges && this.zoneEdges[z.id]) this.zoneEdges[z.id].material.color.set(css('--zone-' + z.id));
      }
      for (const [, pm] of this.planMeshes) pm.mesh.material.color.set(css(pm.colorVar)), pm.mesh.material.emissive.set(css(pm.colorVar));
      for (const [, r] of this.routes) r.mat.color.set(css(r.colorVar)), r.marker.material.color.set(css(r.colorVar));
    }

    // ---------- Plans (reserved slots) ----------
    showPlan(planId, slots, colorVar) {
      this.removePlan(planId);
      const mat = new THREE.MeshLambertMaterial({ color: css(colorVar), emissive: css(colorVar), emissiveIntensity: 0.35, map: this.planTex || null });
      const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1.04, W.GEOM.palletHeight + 0.04, 1.19), mat, slots.length);
      const m4 = new THREE.Matrix4();
      slots.forEach((s, i) => mesh.setMatrixAt(i, this.palletMatrix(s, m4)));
      mesh.userData.slots = slots; mesh.userData.planId = planId;
      mesh.castShadow = true;
      this.scene.add(mesh);
      this.planMeshes.set(planId, { mesh, colorVar, born: this.clock.getElapsedTime() });
    }

    removePlan(planId) {
      const pm = this.planMeshes.get(planId);
      if (pm) { this.scene.remove(pm.mesh); pm.mesh.geometry.dispose(); pm.mesh.material.dispose(); this.planMeshes.delete(planId); }
      const r = this.routes.get(planId);
      if (r) { this.scene.remove(r.group); this.disposeTree(r.group); this.routes.delete(planId); }
    }

    clearPlans() { [...this.planMeshes.keys(), ...this.routes.keys()].forEach(id => this.removePlan(id)); }

    drawRoute(planId, points, colorVar) {
      const old = this.routes.get(planId);
      if (old) { this.scene.remove(old.group); this.disposeTree(old.group); }
      const group = new THREE.Group();
      const mat = new THREE.MeshBasicMaterial({ color: css(colorVar) });
      const segs = [];
      let total = 0;
      for (let i = 1; i < points.length; i++) {
        const [x0, z0] = points[i - 1], [x1, z1] = points[i];
        const len = Math.abs(x1 - x0) + Math.abs(z1 - z0);
        if (len < 0.01) continue;
        const horiz = Math.abs(x1 - x0) > Math.abs(z1 - z0);
        const m = new THREE.Mesh(new THREE.BoxGeometry(horiz ? len + 0.7 : 0.7, 0.06, horiz ? 0.7 : len + 0.7), mat);
        m.position.set((x0 + x1) / 2, 0.08, (z0 + z1) / 2);
        group.add(m);
        segs.push({ x0, z0, x1, z1, len, start: total });
        total += len;
      }
      const end = points[points.length - 1];
      const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 0.12, 24), mat);
      pin.position.set(end[0], 0.1, end[1]);
      group.add(pin);
      // A small forklift marker that drives the route, so the flow is visible
      const marker = new THREE.Mesh(new THREE.BoxGeometry(1.3, 1.1, 2.0), new THREE.MeshLambertMaterial({ color: css(colorVar) }));
      marker.position.set(points[0][0], 0.6, points[0][1]);
      group.add(marker);
      this.scene.add(group);
      this.routes.set(planId, { group, mat, marker, segs, total, colorVar, t0: this.clock.getElapsedTime() });
    }

    // ---------- Camera ----------
    flyTo(target, position) {
      if (reduceMotion()) { this.controls.target.copy(target); this.camera.position.copy(position); return; }
      this.flight = { t0: performance.now(), dur: 1200, fromT: this.controls.target.clone(), fromP: this.camera.position.clone(), toT: target, toP: position };
    }

    focusBox(x0, x1, z0, z1, h = 6) {
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      // Fit the box to the camera's field of view, whatever the screen shape.
      const vfov = (this.camera.fov * Math.PI) / 180;
      const hfov = 2 * Math.atan(Math.tan(vfov / 2) * (this.camera.aspect || 1.5));
      const distW = (x1 - x0) / 2 / Math.tan(hfov / 2);
      const distD = ((z1 - z0) / 2 / Math.tan(vfov / 2)) * 1.25;
      const dist = Math.max(distW, distD, 22) * 1.06;
      const dir = new THREE.Vector3(0.18, 0.74, 0.65).normalize();
      this.flyTo(new THREE.Vector3(cx, h / 2, cz), new THREE.Vector3(cx + dir.x * dist, dir.y * dist, cz + dir.z * dist));
    }

    focus(target) {
      if (this.beforeFocus) this.beforeFocus();
      const t = String(target || 'overview').toUpperCase();
      if (t === 'OVERVIEW' || t === 'SITE') return this.focusBox(-82, 82, -52, 56, 0), 'overview';
      if (t === 'DOCKS') return this.focusBox(-70, 70, 34, 56, 2), 'docks';
      const z = W.zoneById(t);
      if (z) { const b = z.bounds; this.focusBox(b.x0, b.x1, b.z0, b.z1); return 'zone ' + z.id; }
      const d = W.dockById(t);
      if (d) { this.flyTo(new THREE.Vector3(d.x, 2, d.z - 12), new THREE.Vector3(d.x + 8, 16, d.z + 22)); return 'dock ' + d.id; }
      const pm = this.planMeshes.get(t);
      if (pm) { this.focusSlots(pm.mesh.userData.slots); return 'plan ' + t; }
      throw new Error(`Unknown camera target "${target}". Use overview, docks, a zone (A, C, H, S), a dock (D1–D12) or a plan id.`);
    }

    /** True if focus(target) would work — lets the agent's tour tool validate targets first. */
    canFocus(target) {
      const t = String(target || '').toUpperCase();
      return ['OVERVIEW', 'SITE', 'DOCKS'].includes(t) || !!W.zoneById(t) || !!W.dockById(t) || this.planMeshes.has(t);
    }

    focusSlots(slots) {
      if (!slots.length) return;
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const s of slots) { x0 = Math.min(x0, s.x); x1 = Math.max(x1, s.x); z0 = Math.min(z0, s.z); z1 = Math.max(z1, s.z); }
      this.focusBox(x0 - 4, x1 + 4, z0 - 4, z1 + 4);
    }

    // ---------- Labels ----------
    addLabel(html, pos, cls) {
      const el = document.createElement('div');
      el.className = 'scene-label ' + cls;
      el.innerHTML = html;
      this.labelLayer.appendChild(el);
      this.labels.push({ el, pos });
    }

    placeLabels() {
      const w = this.el.clientWidth, h = this.el.clientHeight;
      const v = new THREE.Vector3();
      const camDist = this.camera.position.distanceTo(this.controls.target);
      for (const l of this.labels) {
        v.copy(l.pos).project(this.camera);
        const hide = v.z > 1 || v.x < -1.1 || v.x > 1.1 || v.y < -1.1 || v.y > 1.1 || (l.el.classList.contains('dock') && camDist > 230);
        l.el.style.display = hide ? 'none' : '';
        if (!hide) l.el.style.transform = `translate(-50%,-50%) translate(${((v.x + 1) / 2) * w}px,${((1 - v.y) / 2) * h}px)`;
      }
    }

    // ---------- Picking ----------
    bindPicking() {
      const ray = new THREE.Raycaster();
      const ptr = new THREE.Vector2();
      let down = null;
      this.renderer.domElement.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
      this.renderer.domElement.addEventListener('pointerup', e => {
        if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
        const rect = this.renderer.domElement.getBoundingClientRect();
        ptr.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
        ray.setFromCamera(ptr, this.camera);
        const targets = [this.occMesh, this.blockMesh, ...[...this.planMeshes.values()].map(p => p.mesh)];
        const hit = ray.intersectObjects(targets, false)[0];
        const slot = hit && hit.instanceId != null ? hit.object.userData.slots[hit.instanceId] : null;
        this.opts.onSelect && this.opts.onSelect(slot, hit ? hit.object.userData.planId : null, e);
      });
    }

    // ---------- Loop ----------
    resize() {
      const w = this.el.clientWidth || 1, h = this.el.clientHeight || 1;
      this.renderer.setSize(w, h, false);
      this.renderer.domElement.style.width = '100%';
      this.renderer.domElement.style.height = '100%';
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }

    frame() {
      if (document.hidden) return;
      const t = this.clock.getElapsedTime();
      if (this.flight && !this.manualCamera) {
        const f = this.flight, k = Math.min(1, (performance.now() - f.t0) / f.dur), e = ease(k);
        this.controls.target.lerpVectors(f.fromT, f.toT, e);
        this.camera.position.lerpVectors(f.fromP, f.toP, e);
        if (k >= 1) this.flight = null;
      }
      const dt = Math.min(0.25, t - (this.lastT || t)); this.lastT = t;
      // Adaptive quality: if frames are slow for a while, drop shadows and pixel density
      this.ft = (this.ft || 0) * 0.97 + dt * 0.03;
      if (this.hq && t > 4 && this.ft > 0.045) {
        this.hq = false;
        this.renderer.shadowMap.enabled = false; this.sun.castShadow = false;
        this.renderer.setPixelRatio(1); this.resize();
        this.scene.traverse(o => { if (o.material) [].concat(o.material).forEach(m => (m.needsUpdate = true)); });
      }
      for (const h of this.hooks) h(dt, t);
      const still = reduceMotion();
      for (const [, pm] of this.planMeshes) pm.mesh.material.emissiveIntensity = still ? 0.35 : 0.3 + 0.22 * Math.sin((t - pm.born) * 3);
      for (const [, r] of this.routes) {
        if (!r.total) continue;
        const d = still ? r.total : ((t - r.t0) * 14) % (r.total + 10);
        const dist = Math.min(d, r.total);
        const seg = r.segs.find(s => dist <= s.start + s.len) || r.segs[r.segs.length - 1];
        const k = (dist - seg.start) / seg.len;
        r.marker.position.set(seg.x0 + (seg.x1 - seg.x0) * k, 0.6, seg.z0 + (seg.z1 - seg.z0) * k);
        r.marker.rotation.y = Math.abs(seg.x1 - seg.x0) > Math.abs(seg.z1 - seg.z0) ? Math.PI / 2 : 0;
      }
      if (!this.manualCamera) this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.placeLabels();
    }

    disposeTree(obj) {
      obj.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    }
  }

  root.WarehouseViewer = WarehouseViewer;
})(typeof self !== 'undefined' ? self : this);
