/*
 * Immersive layer on top of the 3D viewer:
 *  - a living site: roof and lights (seen from inside), trucks at the docks, forklifts at work
 *  - Walk inside: eye-level walking with collisions and a "you are here" readout
 *  - Follow my pallet: a cinematic truck-to-shelf journey with captions from the data
 *  - Guided tour: camera stops with captions, read aloud when sound is on
 *  - Sound: synthesized warehouse ambience and reversing beepers (no audio files)
 * Every caption is built from model data, so the experience stays as traceable as the chat.
 */
(function (root) {
  'use strict';
  const W = root.WarehouseCore;
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || '#888888';
  const reduceMotion = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const smooth = k => k * k * (3 - 2 * k);
  const fmt = n => Number(n).toLocaleString('en-IN');

  // ---------- Models ----------
  const lam = (c, extra) => new THREE.MeshLambertMaterial(Object.assign({ color: c }, extra));
  let M = null;
  function mats() {
    if (M) return M;
    M = {
      body: lam(0xf0b400), dark: lam(0x2b2f36), steel: lam(0x8a9099), tyre: lam(0x1c1c1c),
      vest: lam(0xd8f000, { emissive: 0x303800 }), skin: lam(0xc68e63), beacon: lam(0xff8a00, { emissive: 0xff6a00 }),
      trailer: lam(0xe9ebee), stripe: lam(0x2f5b8c), cab: lam(0x34506e), glass: lam(0x1d2733),
      roof: lam(0x59616c, { side: THREE.DoubleSide }), light: new THREE.MeshBasicMaterial({ color: 0xfff6e0 }),
    };
    return M;
  }
  function box(w, h, d, mat, x, y, z, shadow = true) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.castShadow = shadow; m.receiveShadow = shadow;
    return m;
  }

  /** Counterbalance forklift with driver; faces -z. userData.carriage moves the forks up. */
  function makeForklift() {
    const m = mats();
    const g = new THREE.Group();
    g.add(box(1.15, 0.85, 1.5, m.body, 0, 0.72, 0.1));
    g.add(box(1.15, 0.75, 0.45, m.dark, 0, 0.72, 0.95));
    for (const [x, z] of [[-0.52, -0.45], [0.52, -0.45], [-0.52, 0.72], [0.52, 0.72]]) g.add(box(0.07, 1.25, 0.07, m.dark, x, 1.75, z));
    g.add(box(1.15, 0.06, 1.3, m.dark, 0, 2.4, 0.14));
    g.add(box(0.46, 0.55, 0.32, m.vest, 0, 1.45, 0.38));
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 10), m.skin);
    head.position.set(0, 1.88, 0.38); head.castShadow = true; g.add(head);
    g.add(box(0.09, 2.5, 0.12, m.steel, -0.34, 1.3, -0.72)); g.add(box(0.09, 2.5, 0.12, m.steel, 0.34, 1.3, -0.72));
    // Telescopic inner mast: rises at half the carriage height so a high lift still looks connected
    const inner = new THREE.Group();
    inner.add(box(0.07, 2.5, 0.1, m.steel, -0.27, 1.3, -0.76)); inner.add(box(0.07, 2.5, 0.1, m.steel, 0.27, 1.3, -0.76));
    g.add(inner);
    g.userData.inner = inner;
    const car = new THREE.Group();
    car.position.y = 0.08;
    car.add(box(0.82, 0.5, 0.06, m.dark, 0, 0.3, -0.8));
    car.add(box(0.12, 0.05, 1.1, m.steel, -0.24, 0.03, -1.36)); car.add(box(0.12, 0.05, 1.1, m.steel, 0.24, 0.03, -1.36));
    g.add(car);
    const wg = new THREE.CylinderGeometry(0.28, 0.28, 0.24, 16);
    for (const [x, z] of [[-0.56, -0.45], [0.56, -0.45], [-0.56, 0.75], [0.56, 0.75]]) { const w = new THREE.Mesh(wg, m.tyre); w.rotation.z = Math.PI / 2; w.position.set(x, 0.28, z); g.add(w); }
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.1, 0.14), m.beacon); b.position.set(0, 2.5, 0.62); g.add(b);
    g.userData.carriage = car;
    return g;
  }
  function loadPallet(fork, mat) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(1.0, W.GEOM.palletHeight, 1.15), mat);
    p.position.set(0, 0.06 + W.GEOM.palletHeight / 2, -1.36);
    p.castShadow = true;
    fork.userData.carriage.add(p);
    fork.userData.load = p;
    return p;
  }

  /** Articulated truck; the trailer's rear doors are at local z = 0, the cab points to +z. */
  function makeTruck(accent) {
    const m = mats();
    const g = new THREE.Group();
    g.add(box(2.55, 3.2, 13.6, m.trailer, 0, 2.75, 6.8));
    g.add(box(2.57, 0.35, 13.0, accent ? lam(accent) : m.stripe, 0, 1.6, 6.9));
    g.add(box(1.2, 0.4, 17.0, m.dark, 0, 0.85, 8.6));
    const wg = new THREE.CylinderGeometry(0.5, 0.5, 0.35, 16);
    for (const z of [1.6, 2.8, 14.2, 16.4]) for (const x of [-1.05, 1.05]) { const w = new THREE.Mesh(wg, m.tyre); w.rotation.z = Math.PI / 2; w.position.set(x, 0.5, z); g.add(w); }
    g.add(box(2.5, 2.9, 2.5, m.cab, 0, 2.1, 15.6));
    g.add(box(2.3, 1.0, 0.06, m.glass, 0, 2.9, 16.86, false));
    return g;
  }

  /** Roof trusses, light lines and columns: only visible when the camera is inside (below the roof). */
  function makeRoof() {
    const m = mats();
    const g = new THREE.Group();
    const H = 12.5;
    for (let z = -50; z <= 50; z += 10) g.add(box(160, 0.7, 0.25, m.steel, 0, H, z, false));
    for (let x = -80; x <= 80; x += 16) g.add(box(0.25, 0.35, 100, m.steel, x, H + 0.5, 0, false));
    const roof = new THREE.Mesh(new THREE.PlaneGeometry(160, 100), m.roof);
    roof.rotation.x = Math.PI / 2; roof.position.y = H + 0.9;
    g.add(roof);
    const pos = [];
    for (let x = -74; x <= 74; x += 7.4) for (let z = -44; z <= 44; z += 11) pos.push([x, z]);
    const lights = new THREE.InstancedMesh(new THREE.BoxGeometry(0.5, 0.08, 2.4), m.light, pos.length);
    const m4 = new THREE.Matrix4();
    pos.forEach(([x, z], i) => lights.setMatrixAt(i, m4.makeTranslation(x, H - 0.6, z)));
    g.add(lights);
    for (let x = -80; x <= 80; x += 10) { g.add(box(0.4, H, 0.4, m.steel, x, H / 2, -49.8, false)); g.add(box(0.4, H, 0.4, m.steel, x, H / 2, 49.8, false)); }
    for (let z = -40; z <= 40; z += 10) { g.add(box(0.4, H, 0.4, m.steel, -79.8, H / 2, z, false)); g.add(box(0.4, H, 0.4, m.steel, 79.8, H / 2, z, false)); }
    g.visible = false;
    return g;
  }

  // ---------- Paths ----------
  function polyline(points) {
    const segs = []; let total = 0;
    for (let i = 1; i < points.length; i++) {
      const [x0, z0] = points[i - 1], [x1, z1] = points[i];
      const len = Math.hypot(x1 - x0, z1 - z0);
      if (len < 0.01) continue;
      segs.push({ x0, z0, x1, z1, len, start: total });
      total += len;
    }
    return { segs, total };
  }
  function along(pl, d) {
    d = clamp(d, 0, pl.total);
    const s = pl.segs.find(x => d <= x.start + x.len) || pl.segs[pl.segs.length - 1];
    const k = (d - s.start) / s.len;
    return { x: s.x0 + (s.x1 - s.x0) * k, z: s.z0 + (s.z1 - s.z0) * k, dx: (s.x1 - s.x0) / s.len, dz: (s.z1 - s.z0) / s.len };
  }
  const headingOf = (dx, dz) => Math.atan2(-dx, -dz);
  function turn(cur, target, max) {
    let d = ((target - cur + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    return cur + clamp(d, -max, max);
  }

  // ---------- Sound ----------
  class Ambience {
    constructor() { this.on = false; this.ctx = null; }
    async toggle() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return false;
        try { this.ctx = new AC(); this.build(); } catch { this.ctx = null; return false; }
      }
      this.on = !this.on;
      try {
        if (this.on) { await this.ctx.resume(); this.master.gain.setTargetAtTime(1, this.ctx.currentTime, 0.4); }
        else { this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.15); if (window.speechSynthesis) speechSynthesis.cancel(); }
      } catch { /* audio blocked: stay silent */ }
      return this.on;
    }
    build() {
      const c = this.ctx;
      this.master = c.createGain(); this.master.gain.value = 0; this.master.connect(c.destination);
      // HVAC rumble: looped brown noise through a low-pass filter
      const len = c.sampleRate * 4, buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
      let last = 0;
      for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3.5; }
      const src = c.createBufferSource(); src.buffer = buf; src.loop = true;
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420;
      const g = c.createGain(); g.gain.value = 0.25;
      src.connect(lp); lp.connect(g); g.connect(this.master); src.start();
      const o = c.createOscillator(); o.frequency.value = 100;
      const og = c.createGain(); og.gain.value = 0.01;
      o.connect(og); og.connect(this.master); o.start();
    }
    /** Reversing alarm: three short beeps, louder when the forklift is close to the camera. */
    beep(vol) {
      if (!this.on || !this.ctx || vol < 0.05) return;
      const c = this.ctx, t0 = c.currentTime;
      for (let i = 0; i < 3; i++) {
        const o = c.createOscillator(); o.type = 'square'; o.frequency.value = 1150;
        const g = c.createGain(), t = t0 + i * 0.5, v = 0.045 * vol;
        g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(v, t + 0.01); g.gain.setValueAtTime(v, t + 0.22); g.gain.linearRampToValueAtTime(0, t + 0.24);
        o.connect(g); g.connect(this.master); o.start(t); o.stop(t + 0.3);
      }
    }
    speak(text) {
      return new Promise(res => {
        if (!this.on || !window.speechSynthesis) return res();
        try {
          speechSynthesis.cancel();
          const u = new SpeechSynthesisUtterance(String(text).replace(/–/g, ' to ').replace(/°C/g, ' degrees').replace(/\bm\b/g, 'metres'));
          const vs = speechSynthesis.getVoices();
          u.voice = vs.find(v => /en[-_]IN/i.test(v.lang)) || vs.find(v => /en[-_]GB/i.test(v.lang)) || vs.find(v => /^en/i.test(v.lang)) || null;
          u.rate = 1.03;
          u.onend = u.onerror = () => res();
          speechSynthesis.speak(u);
          setTimeout(res, 25000);
        } catch { res(); }
      });
    }
  }

  // ---------- The immersive controller ----------
  class Immersive {
    /** ui: { onMode(mode), caption(obj|null), location(text) } */
    constructor(viewer, model, ui) {
      this.v = viewer; this.model = model; this.ui = ui;
      this.mode = 'orbit';
      this.sound = new Ambience();
      this.roof = makeRoof();
      viewer.scene.add(this.roof);
      viewer.scene.fog = new THREE.Fog(new THREE.Color(css('--scene-bg')), 600, 1200);
      this.life = new THREE.Group();
      viewer.scene.add(this.life);
      this.buildLife();
      viewer.hooks.push((dt, t) => this.update(dt, t));
      viewer.beforeFocus = () => {
        if (this.internal) return;
        if (this.mode === 'walk') this.exitWalk(true);
        else if (this.mode === 'journey') this.finishJourney(true);
        else if (this.mode === 'tour') this.stopTour();
      };
      this.bindInput();
    }

    // ----- A living site -----
    buildLife() {
      this.life.clear();
      this.ambient = [];
      const m = mats();
      const accents = [0x2f5b8c, 0xc8362d, 0x2f7d4f, 0x6b4c9a];
      ['D2', 'D6', 'D9', 'D11'].forEach((id, i) => {
        const d = W.dockById(id), t = makeTruck(accents[i]);
        t.position.set(d.x, 0, W.GEOM.dockZ + 0.6);
        this.life.add(t);
      });
      // Aisles from the data, so the traffic follows whatever site is loaded
      const aisles = zone => [...new Set(this.model.slots.filter(s => s.zone === zone).map(s => s.aisleX))].sort((a, b) => a - b);
      const aA = aisles('A'), aC = aisles('C');
      const pick = (arr, f) => arr.length ? arr[Math.floor((arr.length - 1) * f)] : 0;
      const loops = [
        { pts: [[-70, 32], [64, 32]], speed: 2.8, load: true },
        { pts: [[pick(aA, 0.25), 32.5], [pick(aA, 0.25), -40]], speed: 2.1, load: true },
        { pts: [[pick(aA, 0.7), 32.5], [pick(aA, 0.7), -28]], speed: 2.0, load: false },
        { pts: [[52, 33], [52, 2], [pick(aC, 0.5), 2], [pick(aC, 0.5), -36]], speed: 2.2, load: true },
        { pts: [[-58, 44], [46, 44]], speed: 2.5, load: true },
      ];
      const loadMat = new THREE.MeshLambertMaterial({ color: 0xffffff, map: this.v.mats.pallet.map });
      this.ambientLoadMat = loadMat;
      loops.forEach((L, i) => {
        const f = makeForklift();
        const pl = polyline(L.pts);
        if (L.load) loadPallet(f, loadMat);
        const d = (i * 0.37 % 1) * pl.total;
        const p = along(pl, d);
        f.position.set(p.x, 0, p.z);
        f.rotation.y = headingOf(p.dx, p.dz);
        this.life.add(f);
        this.ambient.push({ f, pl, d, dir: 1, speed: L.speed, pause: 0, hasLoad: L.load });
      });
    }

    rebuild() { this.stopAll(); this.buildLife(); }

    updateAmbient(dt) {
      if (reduceMotion()) return;
      for (const a of this.ambient) {
        if (a.pause > 0) { a.pause -= dt; continue; }
        a.d += a.dir * a.speed * dt;
        if (a.d >= a.pl.total || a.d <= 0) {
          a.d = clamp(a.d, 0, a.pl.total); a.dir *= -1; a.pause = 1.6;
          if (a.f.userData.load && a.hasLoad) a.f.userData.load.visible = !a.f.userData.load.visible;
          const dist = this.v.camera.position.distanceTo(a.f.position);
          this.sound.beep(clamp(1 - dist / 70, 0, 1));
        }
        const p = along(a.pl, a.d);
        a.f.position.set(p.x, 0, p.z);
        a.f.rotation.y = turn(a.f.rotation.y, headingOf(p.dx * a.dir, p.dz * a.dir), 3 * dt);
      }
    }

    // ----- Shared -----
    takeCamera() { this.v.manualCamera = true; this.v.controls.enabled = false; this.v.flight = null; }
    releaseCamera(target) {
      this.v.manualCamera = false; this.v.controls.enabled = true;
      if (target) this.v.controls.target.copy(target);
    }
    stopAll() {
      if (this.mode === 'walk') this.exitWalk(true);
      if (this.mode === 'journey') this.finishJourney(true);
      if (this.mode === 'tour') this.stopTour();
    }
    setMode(m) { this.mode = m; this.ui.onMode(m); }

    update(dt, t) {
      this.updateAmbient(dt);
      const inside = this.v.camera.position.y < 13.2;
      this.roof.visible = inside;
      const fog = this.v.scene.fog;
      fog.near = inside ? 28 : 600; fog.far = inside ? 170 : 1200;
      if (inside) {
        // Walking into the chilled chamber feels cold: a blue haze
        const cold = this.mode === 'walk' && /^Zone C/.test(this.walk.lastLoc || '');
        fog.color.set(cold ? '#cfe2f4' : css('--scene-bg'));
        if (cold) { fog.near = 8; fog.far = 75; }
      }
      if (this.mode === 'walk') this.walkStep(dt, t);
      else if (this.mode === 'journey') this.journeyStep(dt);
      else if (this.mode === 'tour') this.tourStep(dt);
    }

    // ----- Walk inside -----
    defaultWalkStart() {
      const p = this.model.plans[0];
      if (p) { const s = this.model.byId.get(p._slots[0]); return s.zone === 'C' ? { x: s.aisleX, z: 0.5, yaw: 0 } : { x: s.aisleX, z: 31.5, yaw: 0 }; }
      return { x: -14, z: 40, yaw: 0 };
    }

    enterWalk(at) {
      this.stopAll();
      this.takeCamera();
      const p = at || this.defaultWalkStart();
      this.walk = { x: p.x, z: p.z, yaw: p.yaw, pitch: -0.04, keys: new Set(), pad: { f: 0, r: 0, turn: 0 }, moving: 0, lastLoc: '' };
      this.v.camera.rotation.order = 'YXZ';
      this.setMode('walk');
      this.walkStep(0, 0);
    }

    exitWalk(silent) {
      if (this.mode !== 'walk') return;
      this.setMode('orbit');
      this.v.camera.rotation.order = 'XYZ';
      const c = this.v.camera.position;
      this.releaseCamera(new THREE.Vector3(c.x - Math.sin(this.walk.yaw) * 10, 0, c.z - Math.cos(this.walk.yaw) * 10));
      this.ui.location('');
      if (!silent) { this.internal = true; this.v.focus('overview'); this.internal = false; }
    }

    teleport(target) {
      const t = String(target).toUpperCase();
      const aisleMid = zone => { const xs = [...new Set(this.model.slots.filter(s => s.zone === zone).map(s => s.aisleX))].sort((a, b) => a - b); return xs[Math.floor(xs.length / 2)] ?? 0; };
      const spots = {
        OVERVIEW: { x: -14, z: 40, yaw: 0 }, DOCKS: { x: 0, z: 42, yaw: Math.PI },
        A: { x: aisleMid('A'), z: 31.5, yaw: 0 }, C: { x: aisleMid('C'), z: 0.5, yaw: 0 },
        H: { x: aisleMid('H'), z: 31.5, yaw: 0 }, S: { x: aisleMid('S'), z: 31.5, yaw: 0 },
      };
      const s = spots[t];
      if (!s || this.mode !== 'walk') return false;
      Object.assign(this.walk, { x: s.x, z: s.z, yaw: s.yaw, pitch: -0.04 });
      return true;
    }

    blocked(x, z) {
      const R = 0.38;
      if (x < -79.3 || x > 79.3 || z < -49.3 || z > 49.3) return true;
      for (const b of this.v.rackBoxes) if (x > b.x0 - R && x < b.x1 + R && z > b.z0 - R && z < b.z1 + R) return true;
      return false;
    }

    walkStep(dt, t) {
      const w = this.walk, k = w.keys;
      const f = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0) + w.pad.f;
      const r = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0) + w.pad.r;
      const rot = (k.has('ArrowLeft') || k.has('KeyQ') ? 1 : 0) - (k.has('ArrowRight') || k.has('KeyE') ? 1 : 0) + w.pad.turn;
      w.yaw += rot * 1.8 * dt;
      const speed = (k.has('ShiftLeft') || k.has('ShiftRight') ? 7 : 3.2) * dt;
      const fx = -Math.sin(w.yaw), fz = -Math.cos(w.yaw), rx = Math.cos(w.yaw), rz = -Math.sin(w.yaw);
      let dx = (fx * f + rx * r) * speed, dz = (fz * f + rz * r) * speed;
      const len = Math.hypot(f, r);
      if (len > 1) { dx /= len; dz /= len; }
      if (dx && !this.blocked(w.x + dx, w.z)) w.x += dx;
      if (dz && !this.blocked(w.x, w.z + dz)) w.z += dz;
      w.moving = clamp(w.moving + (len ? dt * 4 : -dt * 4), 0, 1);
      const bob = reduceMotion() ? 0 : Math.sin(t * 9) * 0.03 * w.moving;
      this.v.camera.position.set(w.x, 1.7 + bob, w.z);
      this.v.camera.rotation.set(w.pitch, w.yaw, 0, 'YXZ');
      const loc = this.locationText(w.x, w.z);
      if (loc !== w.lastLoc) { w.lastLoc = loc; this.ui.location(loc); }
    }

    locationText(x, z) {
      const zone = W.ZONES.find(q => x >= q.bounds.x0 && x <= q.bounds.x1 && z >= q.bounds.z0 && z <= q.bounds.z1 + 1);
      if (zone) {
        const rows = new Map();
        for (const s of this.model.slots) if (s.zone === zone.id && !rows.has(s.row)) rows.set(s.row, s.x);
        let best = null, bd = Infinity;
        for (const [row, rx] of rows) { const d = Math.abs(rx - x); if (d < bd) { bd = d; best = row; } }
        return `Zone ${zone.id} · ${zone.name} · ${zone.temp.min}–${zone.temp.max} °C · beside row ${zone.id}-${String(best).padStart(2, '0')}`;
      }
      if (z > W.GEOM.crossAisleZ + 2) {
        let nd = W.DOCKS[0], dd = Infinity;
        for (const d of W.DOCKS) { const q = Math.abs(d.x - x); if (q < dd) { dd = q; nd = d; } }
        return `Dock area · nearest dock ${nd.id} (${nd.type})`;
      }
      if (Math.abs(x - W.GEOM.chilledCorridorX) < 3) return 'Corridor to the chilled chamber';
      return 'Main cross aisle';
    }

    bindInput() {
      const typing = () => /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '');
      window.addEventListener('keydown', e => {
        if (this.mode === 'walk' && !typing()) {
          if (e.code === 'Escape') { this.exitWalk(); return; }
          if (/^(Key[WASDQE]|Arrow|Shift)/.test(e.code)) { this.walk.keys.add(e.code); e.preventDefault(); }
        } else if (e.code === 'Escape' && (this.mode === 'journey' || this.mode === 'tour')) this.skip();
      });
      window.addEventListener('keyup', e => { if (this.walk) this.walk.keys.delete(e.code); });
      window.addEventListener('blur', () => { if (this.walk) this.walk.keys.clear(); });
      const el = this.v.renderer.domElement;
      let drag = null;
      el.addEventListener('pointerdown', e => { if (this.mode === 'walk') { drag = { x: e.clientX, y: e.clientY }; } });
      window.addEventListener('pointermove', e => {
        if (!drag || this.mode !== 'walk') return;
        this.walk.yaw -= (e.clientX - drag.x) * 0.0045;
        this.walk.pitch = clamp(this.walk.pitch - (e.clientY - drag.y) * 0.0045, -1.1, 0.9);
        drag = { x: e.clientX, y: e.clientY };
      });
      window.addEventListener('pointerup', () => { drag = null; });
    }

    setPad(f, r, t) { if (this.walk) Object.assign(this.walk.pad, { f, r, turn: t }); }

    // ----- Follow my pallet -----
    followPallet(planId) {
      const j = this.model.journey(planId);
      this.stopAll();
      this.takeCamera();
      const v = this.v;
      const pm = v.planMeshes.get(j.plan_id);
      const colorVar = pm ? pm.colorVar : '--plan-1';
      if (!this.hero) {
        this.hero = makeForklift();
        this.heroLoadMat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissiveIntensity: 0.35, map: v.planTex });
        loadPallet(this.hero, this.heroLoadMat);
        this.truck = makeTruck(0xe8a800);
        v.scene.add(this.hero, this.truck);
      }
      this.heroLoadMat.color.set(css(colorVar)); this.heroLoadMat.emissive.set(css(colorVar));
      const dock = W.dockById(j.dock);
      this.truck.position.set(dock.x, 0, 95); this.truck.visible = true;
      this.hero.visible = true; this.hero.userData.load.visible = true;
      this.hero.userData.carriage.position.y = 0.08; this.hero.userData.inner.position.y = 0;
      this.hero.position.set(dock.x, 0, 53); this.hero.rotation.y = 0;
      // Hide this slot's reserved box until the forklift puts the pallet there
      this.hidden = null;
      if (pm) {
        const i = j.slot_index || 0, m4 = new THREE.Matrix4(); pm.mesh.getMatrixAt(i, m4);
        this.hidden = { mesh: pm.mesh, m4: m4.clone(), i };
        pm.mesh.setMatrixAt(i, new THREE.Matrix4().makeScale(0, 0, 0)); pm.mesh.instanceMatrix.needsUpdate = true;
      }
      const slot = j.slot;
      const side = Math.sign(slot.x - slot.aisleX) || 1;
      const pts = j.points.slice();
      pts[0] = [dock.x, 48];
      const pl = polyline(pts);
      const travelT = clamp(pl.total / 9, 4, 16);
      const liftY = 0.18 + (slot.level - 1) * W.GEOM.levelHeight - 0.06;
      const cap = (text) => ({ title: `Pallet journey · ${j.plan_id} · ${j.goods}`, text });
      this.J = {
        j, pl, side, liftY, slot, t: 0, start: performance.now(), phase: -1, dock,
        phases: [
          { d: 4.2, cap: cap(`A truck backs onto dock ${j.dock}, a ${j.dock_type.toLowerCase()}.`) },
          { d: 2.4, cap: cap(`The pallet is scanned and assigned to location ${j.location} in zone ${j.zone} (${j.zone_name}, ${j.temperature}).`) },
          { d: travelT, cap: cap(`The forklift drives ${j.distance_m} m to the aisle: about ${j.one_way_minutes} min at real speed (shown faster).`) },
          { d: 1.0, cap: cap(`Turning into the rack at row ${slot.zone}-${String(slot.row).padStart(2, '0')}.`) },
          { d: 2.4, cap: cap(`Lifting to level ${j.level}: ${j.lift_height_m} m above the floor.`) },
          { d: 1.4, cap: cap(`Stored at ${j.location}.`) },
          { d: 3.6, cap: cap(`One round trip takes about ${j.cycle_seconds} s. All ${fmt(j.pallets_in_plan)} pallets of ${j.plan_id}: about ${j.putaway_forklift_hours} forklift-hours.`) },
        ],
      };
      this.setMode('journey');
      return j;
    }

    journeyStep(dt) {
      const J = this.J; if (!J) return;
      J.t = (performance.now() - J.start) / 1000; // wall-clock: same length on slow and fast machines
      let acc = 0, idx = 0;
      for (; idx < J.phases.length; idx++) { if (J.t < acc + J.phases[idx].d) break; acc += J.phases[idx].d; }
      if (idx >= J.phases.length) { this.finishJourney(false); return; }
      const ph = J.phases[idx], k = clamp((J.t - acc) / ph.d, 0, 1), e = smooth(k);
      if (idx !== J.phase) {
        J.phase = idx;
        this.ui.caption(Object.assign({ step: idx + 1, steps: J.phases.length, onSkip: () => this.skip() }, ph.cap));
        this.sound.speak(ph.cap.text);
        if (idx === 5) this.placePallet();
        if (idx === 6) this.sound.beep(0.8);
      }
      const h = this.hero, cam = this.v.camera, d = J.dock, s = J.slot;
      const lerpCam = (px, py, pz, lx, ly, lz, rate = 3) => {
        const a = 1 - Math.exp(-dt * rate);
        cam.position.lerp(new THREE.Vector3(px, py, pz), a);
        J.look = (J.look || new THREE.Vector3(lx, ly, lz)).lerp(new THREE.Vector3(lx, ly, lz), a);
        cam.lookAt(J.look);
      };
      if (idx === 0) {
        this.truck.position.z = 95 - (95 - (W.GEOM.dockZ + 0.6)) * e;
        if (!J.look) { cam.position.set(d.x + 18, 8, 70); }
        lerpCam(d.x + 16, 7, 66, d.x, 2, 56, 2);
      } else if (idx === 1) {
        h.position.set(d.x, 0, 53 - 5 * e);
        lerpCam(d.x + 6, 4.5, 41, d.x, 1.2, 49, 2.5);
      } else if (idx === 2) {
        const p = along(J.pl, J.pl.total * e);
        h.position.set(p.x, 0, p.z);
        h.rotation.y = turn(h.rotation.y, headingOf(p.dx, p.dz), 6 * dt);
        const fx = -Math.sin(h.rotation.y), fz = -Math.cos(h.rotation.y);
        lerpCam(p.x - fx * 7.5, 3.6, p.z - fz * 7.5, p.x + fx * 4, 1.2, p.z + fz * 4, 4);
      } else if (idx === 3) {
        h.rotation.y = turn(h.rotation.y, headingOf(J.side, 0), 4 * dt);
        lerpCam(s.aisleX - J.side * 0.5, J.liftY + 2.4, s.z + 7, s.x, J.liftY + 1, s.z, 2.5);
      } else if (idx === 4) {
        h.userData.carriage.position.y = 0.08 + (J.liftY - 0.08) * e;
        h.userData.inner.position.y = h.userData.carriage.position.y * 0.5;
        lerpCam(s.aisleX - J.side * 0.5, J.liftY + 2.4, s.z + 7, s.x, J.liftY + 1, s.z, 2.5);
      } else if (idx === 5) {
        // pallet centre sits 1.36 m ahead of the forklift centre: drive until it is over the slot
        h.position.x = s.aisleX + J.side * Math.max(0, Math.abs(s.x - s.aisleX) - 1.36) * e;
        lerpCam(s.aisleX - J.side * 0.5, J.liftY + 2.4, s.z + 7, s.x, J.liftY + 1, s.z, 2.5);
      } else {
        h.position.x = s.aisleX + J.side * Math.max(0, Math.abs(s.x - s.aisleX) - 1.36) * (1 - e);
        h.userData.carriage.position.y = 0.08 + (J.liftY - 0.08) * (1 - e);
        h.userData.inner.position.y = h.userData.carriage.position.y * 0.5;
        const a = 0.4 * e;
        lerpCam(s.x + Math.sin(a) * 9 - J.side * 4, J.liftY + 3, s.z + Math.cos(a) * 9, s.x, J.liftY + 0.6, s.z, 2);
      }
    }

    placePallet() {
      if (this.hero) this.hero.userData.load.visible = false;
      if (this.hidden) { this.hidden.mesh.setMatrixAt(this.hidden.i, this.hidden.m4); this.hidden.mesh.instanceMatrix.needsUpdate = true; this.hidden = null; }
    }

    finishJourney(silent) {
      const J = this.J;
      this.placePallet();
      if (this.hero) { this.hero.visible = false; }
      if (this.truck) this.truck.visible = false;
      this.J = null;
      this.ui.caption(null);
      if (window.speechSynthesis && this.sound.on) speechSynthesis.cancel();
      this.setMode('orbit');
      const tgt = J ? new THREE.Vector3(J.slot.x, 2, J.slot.z) : null;
      this.releaseCamera(tgt);
      if (!silent && J) { this.internal = true; this.v.focus(J.j.plan_id); this.internal = false; }
    }

    // ----- Guided tour -----
    defaultTour() {
      const sum = this.model.siteSummary();
      const z = id => sum.zones.find(q => q.zone === id);
      const A = z('A'), C = z('C'), H = z('H'), S = z('S');
      return [
        { target: 'overview', caption: `Welcome to ${sum.site}: ${fmt(sum.pallet_positions)} pallet positions in four zones, ${fmt(sum.free_now)} free today.` },
        { target: 'docks', caption: `${sum.docks} docks on the south side. D8, D9 and D10 are sealed reefer docks for chilled goods.` },
        { target: 'A', caption: `Zone A, ambient ${A.temperature}: ${fmt(A.total_positions)} positions on ${A.rack_levels} levels, ${fmt(A.free_now)} free.` },
        { target: 'C', caption: `Zone C, chilled ${C.temperature}, temperature-mapped with 24/7 logging: ${fmt(C.free_now)} of ${fmt(C.total_positions)} positions free.` },
        { target: 'H', caption: `Zone H stores dangerous goods of classes 3, 8 and 9 behind fire-rated walls: ${fmt(H.free_now)} positions free.` },
        { target: 'S', caption: `Zone S is a caged, CCTV-monitored area for high-value goods: ${fmt(S.free_now)} positions free.` },
        { target: 'overview', caption: 'That is the site. Tell the agent what you want to store and it will plan it live.' },
      ];
    }

    startTour(stops, title = 'Guided tour') {
      this.stopAll();
      this.tour = { stops, title, i: -1, until: 0, spoken: true, now: 0 };
      this.setMode('tour');
      this.nextStop();
    }

    nextStop() {
      const T = this.tour;
      T.i++;
      if (T.i >= T.stops.length) { this.stopTour(); return; }
      const s = T.stops[T.i];
      this.internal = true;
      try { this.v.focus(s.target); } catch { /* unknown target: stay */ }
      this.internal = false;
      if (this.v.flight) this.v.flight.dur = reduceMotion() ? 1 : 2400;
      const words = s.caption.split(/\s+/).length;
      T.start = performance.now(); T.now = 0; T.until = clamp(words / 2.6 + 2.4, 4.5, 13);
      T.spoken = false;
      this.ui.caption({ title: T.title, text: s.caption, step: T.i + 1, steps: T.stops.length, onSkip: () => this.skip(), skipLabel: 'Next' });
      this.sound.speak(s.caption).then(() => { if (this.tour === T) T.spoken = true; });
      if (!this.sound.on) T.spoken = true;
    }

    tourStep(dt) {
      const T = this.tour; if (!T) return;
      T.now = (performance.now() - T.start) / 1000;
      if (!this.v.flight && !reduceMotion()) {
        // slow drift around the stop
        const c = this.v.camera.position, tg = this.v.controls.target, a = 0.05 * dt;
        const x = c.x - tg.x, z = c.z - tg.z;
        c.x = tg.x + x * Math.cos(a) - z * Math.sin(a);
        c.z = tg.z + x * Math.sin(a) + z * Math.cos(a);
      }
      if (T.now >= T.until && T.spoken) this.nextStop();
    }

    stopTour() {
      this.tour = null;
      this.ui.caption(null);
      if (window.speechSynthesis && this.sound.on) speechSynthesis.cancel();
      this.setMode('orbit');
    }

    skip() {
      if (this.mode === 'journey') this.finishJourney(false);
      else if (this.mode === 'tour') { if (window.speechSynthesis) speechSynthesis.cancel(); this.nextStop(); }
    }
  }

  root.WarehouseImmersive = Immersive;
})(typeof self !== 'undefined' ? self : this);
