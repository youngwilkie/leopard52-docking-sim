/* ==========================================================================
   world.js — St. George's Lagoon & Port Louis Marina, Grenada (12°02'N 61°45'W)
   Terrain / bathymetry, Gerstner sea, marina structures, town, collision set.
   World axes:  +X = East,  +Z = South,  -Z = North,  Y = up (metres).
   Heading is compass: 0 = North, 90 = East.  fwd = (sin h, 0, -cos h)
   ========================================================================== */
(function () {
  const W = {};
  window.SIM = window.SIM || {};
  SIM.world = W;

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const lerp = (a, b, t) => a + (b - a) * t;
  W.clamp = clamp; W.sstep = sstep;

  /* ---------------------------------------------------------------- geometry
     Lagoon basin, buoyed entrance channel, open Caribbean to the west.      */
  const LAG = { cx: 0, cz: 0, rx: 268, rz: 214 };
  const CH = { ax: -196, az: 62, bx: -640, bz: 226, half: 46 };

  function segDist(px, pz, ax, az, bx, bz) {
    const dx = bx - ax, dz = bz - az;
    const t = clamp(((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz), 0, 1);
    return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
  }
  W.segDist = segDist;

  // west-facing coastline of the island
  function coastX(z) {
    return -572 + 74 * Math.sin(z * 0.0041) + 38 * Math.sin(z * 0.0117 + 1.3) + 22 * Math.sin(z * 0.026 - 0.4);
  }

  // >0 inside water, magnitude ≈ metres from the shoreline
  function waterField(x, z) {
    const e = Math.hypot((x - LAG.cx) / LAG.rx, (z - LAG.cz) / LAG.rz);
    let d = (1 - e) * Math.min(LAG.rx, LAG.rz);
    d = Math.max(d, CH.half - segDist(x, z, CH.ax, CH.az, CH.bx, CH.bz));
    d = Math.max(d, coastX(z) - x);
    return d;
  }
  W.waterField = waterField;

  function hash(i, j) { const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return s - Math.floor(s); }
  function vnoise(x, z) {
    const i = Math.floor(x), j = Math.floor(z), fx = x - i, fz = z - j;
    const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
    return lerp(lerp(hash(i, j), hash(i + 1, j), u), lerp(hash(i, j + 1), hash(i + 1, j + 1), u), v) * 2 - 1;
  }
  function fbm(x, z, oct) {
    let a = 1, f = 1, s = 0, n = 0;
    for (let k = 0; k < oct; k++) { s += a * vnoise(x * f, z * f); n += a; a *= 0.5; f *= 2.03; }
    return s / n;
  }
  W.fbm = fbm;

  function bump(x, z, cx, cz, r, peak, p) {
    const d = Math.hypot(x - cx, z - cz) / r;
    if (d >= 1) return 0;
    return peak * Math.pow(1 - d * d, p || 1.6);
  }

  // named hills — Fort George headland, Richmond Hill / town, Grand Anse ridge
  const HILLS = [
    [-436, -142, 205, 52, 1.1],   // Fort George promontory
    [-186, -404, 430, 104, 1.5],  // town hill above the Carenage
    [ 118, -466, 470, 122, 1.5],  // Richmond Hill
    [ 452, -196, 400, 86, 1.5],   // east ridge behind the marina
    [ 508,  232, 430, 74, 1.5],   // south-east hills
    [ -46,  520, 560, 88, 1.6],   // Grand Anse ridge
    [-560, -560, 620, 150, 1.7],  // interior mountains
    [ 320, -760, 700, 190, 1.7]
  ];

  function landHeight(x, z) {
    const d = -waterField(x, z);
    if (d <= 0) return 0;
    // Foreshore: a gentle beach/apron for the first 40 m inland...
    let h = 0.85 * Math.pow(Math.min(d, 45), 0.76);
    // ...then the hill mass fades in over ~130 m. Without this ramp the peaks
    // land straight on the waterline and the lagoon is ringed by a cliff.
    const ramp = sstep(0, 130, d);
    let hills = 0;
    for (const b of HILLS) hills += bump(x, z, b[0], b[1], b[2], b[3], b[4]);
    hills += fbm(x * 0.0055, z * 0.0055, 4) * 13 + fbm(x * 0.031, z * 0.031, 3) * 2.4;
    // flat sandy foreshore behind Grand Anse
    hills *= 1 - 0.5 * sstep(0, 1, sstep(230, 470, z) * sstep(-320, -120, -Math.abs(x + 60) + 200));
    h += hills * ramp;
    return Math.max(0.15, h);
  }
  W.landHeight = landHeight;

  // shoals & reef heads that will stop a 1.7 m draught
  const SHOALS = [
    [-452, 300, 120, 4.6], [-560, 96, 96, 4.2], [-330, -40, 84, 3.4],
    [212, -206, 62, 3.0], [-142, 178, 74, 3.2], [-676, 372, 150, 4.0]
  ];

  /* Dredged water. Without these a quay wall would have 10 cm alongside it and
     you would ground the moment the stern came in.  [ax,az,bx,bz,half,depth] */
  const DREDGE = [
    [196, -134, 196, 120, 46, 4.6],          // Port Louis basin: pier + fingers
    [176, 126, 200, 126, 30, 4.0],           // fuel dock T-head
    [-152.9, -174.4, -7, -212.8, 32, 4.2],   // town quay frontage, west chord
    [-7, -212.8, 141.3, -180.5, 32, 4.2]     // town quay frontage, east chord
  ];

  function depthExact(x, z) {
    const d = waterField(x, z);
    if (d <= 0) return -1;                       // dry land
    let dep = 6.3 * sstep(0, 21, d);
    const off = coastX(z) - x;
    if (off > 0) dep = Math.max(dep, 4.2 + Math.min(52, off * 0.17));
    for (const s of SHOALS) dep -= bump(x, z, s[0], s[1], s[2], s[3], 1.3);
    dep -= fbm(x * 0.013, z * 0.013, 3) * 0.55;
    for (const dr of DREDGE) {
      const sd = segDist(x, z, dr[0], dr[1], dr[2], dr[3]);
      if (sd < dr[4]) dep = Math.max(dep, dr[5] * sstep(dr[4], dr[4] * 0.6, sd));
    }
    return Math.max(0.12, dep);
  }
  W.depthExact = depthExact;

  /* Bathymetry is sampled once into a 5 m grid; the physics loop runs at
     200 Hz and cannot afford the analytic version (fbm + shoal bumps) on
     every hull probe. Bilinear lookup, land encoded as −1.                */
  const GS = 5;
  let GW = 0, GH = 0, GRID = null, GX0 = 0, GZ0 = 0;

  W.buildDepthGrid = function (x0, x1, z0, z1) {
    GX0 = x0; GZ0 = z0;
    GW = Math.ceil((x1 - x0) / GS) + 1; GH = Math.ceil((z1 - z0) / GS) + 1;
    GRID = new Float32Array(GW * GH);
    for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++)
      GRID[j * GW + i] = depthExact(x0 + i * GS, z0 + j * GS);
    W.grid = { GRID, GW, GH, GS, GX0, GZ0 };
  };

  W.depthAt = function (x, z) {
    if (!GRID) return depthExact(x, z);
    const fx = (x - GX0) / GS, fz = (z - GZ0) / GS;
    if (fx < 0 || fz < 0 || fx >= GW - 1 || fz >= GH - 1) return depthExact(x, z);
    const i = fx | 0, j = fz | 0, tx = fx - i, tz = fz - j;
    // Land samples interpolate as a shallow negative rather than poisoning the
    // whole cell — otherwise every quay wall carries a 5 m band of "aground"
    // and you could never back a stern up to one.
    const L = v => (v < 0 ? -0.5 : v);
    const a = L(GRID[j * GW + i]), b = L(GRID[j * GW + i + 1]);
    const c = L(GRID[(j + 1) * GW + i]), d = L(GRID[(j + 1) * GW + i + 1]);
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  };

  W.terrainY = (x, z) => { const d = waterField(x, z); return d <= 0 ? landHeight(x, z) : -depthExact(x, z); };

  // shelter from swell: 1 = open sea, ~0.08 = deep inside the lagoon
  function shelter(x, z) {
    const off = coastX(z) - x;
    let s = 0.07 + 0.93 * sstep(-40, 260, off);
    // swell rolls a little way up the entrance channel before dying out
    const alongCh = ((x - CH.ax) * (CH.bx - CH.ax) + (z - CH.az) * (CH.bz - CH.az)) /
                    ((CH.bx - CH.ax) ** 2 + (CH.bz - CH.az) ** 2);
    if (segDist(x, z, CH.ax, CH.az, CH.bx, CH.bz) < CH.half + 40)
      s = Math.max(s, 0.10 + 0.42 * sstep(0.05, 0.9, alongCh));
    const e = Math.hypot((x - LAG.cx) / LAG.rx, (z - LAG.cz) / LAG.rz);
    if (e < 1.05) s = Math.min(s, 0.09 + 0.06 * e);
    return clamp(s, 0.05, 1);
  }
  W.shelter = shelter;

  /* ------------------------------------------------------------------ waves
     Four Gerstner components; identical maths in JS (physics) and GLSL.     */
  W.waves = [];
  W.setSea = function (swellM, windDir, windKn) {
    const wd = windDir * Math.PI / 180;
    const wdx = Math.sin(wd), wdz = -Math.cos(wd);           // direction wind blows TOWARD
    const sw = 300 * Math.PI / 180;                          // NW ocean swell
    const sdx = Math.sin(sw), sdz = -Math.cos(sw);
    const ch = clamp(windKn / 26, 0, 1);
    W.waves = [
      { dx: sdx, dz: sdz, amp: swellM * 0.52, len: 78, spd: 10.2, steep: 0.55 },
      { dx: sdx * 0.94 + sdz * 0.34, dz: sdz * 0.94 - sdx * 0.34, amp: swellM * 0.3, len: 46, spd: 8.0, steep: 0.5 },
      { dx: -wdx, dz: -wdz, amp: 0.10 + 0.34 * ch, len: 13.5, spd: 4.4, steep: 0.62 },
      { dx: -(wdx * 0.88 - wdz * 0.47), dz: -(wdz * 0.88 + wdx * 0.47), amp: 0.05 + 0.20 * ch, len: 6.6, spd: 3.1, steep: 0.7 }
    ];
    if (W.mat) { W.mat.uniforms.uWaves.value = W.wavesUniform(); W.mat.uniforms.uChop.value = ch; }
  };
  W.wavesUniform = function () {
    const a = [];
    for (let i = 0; i < 4; i++) {
      const w = W.waves[i] || { dx: 1, dz: 0, amp: 0, len: 10, spd: 1, steep: 0 };
      a.push(new THREE.Vector4(w.dx, w.dz, w.amp, 2 * Math.PI / w.len));
      a.push(new THREE.Vector4(w.spd * 2 * Math.PI / w.len, w.steep, 0, 0));
    }
    return a;
  };

  // surface elevation at a point (metres). Gerstner x/z displacement ignored
  // for the physics probe — amplitude error is <5 % at these steepnesses.
  W.waveY = function (x, z, t) {
    const sh = shelter(x, z);
    let y = 0;
    for (const w of W.waves) {
      const k = 2 * Math.PI / w.len;
      y += w.amp * sh * Math.sin(k * (w.dx * x + w.dz * z) - w.spd * k * t);
    }
    return y;
  };

  // Surface gradient driving the Froude–Krylov surge/sway force. Components
  // much shorter than the hull integrate to nothing along the waterline, so
  // each is attenuated by exp(−(kL)²/8) — a 6 m chop barely moves a 15.75 m
  // catamaran, an 80 m swell lifts and surges the whole boat.
  W.waveSlope = function (x, z, t, L) {
    const sh = shelter(x, z), len = L || 15.75;
    let sx = 0, sz = 0;
    for (const w of W.waves) {
      const k = 2 * Math.PI / w.len;
      const kl = k * len;
      const att = Math.exp(-kl * kl / 8);
      if (att < 0.01) continue;
      const c = w.amp * sh * k * att * Math.cos(k * (w.dx * x + w.dz * z) - w.spd * k * t);
      sx += c * w.dx; sz += c * w.dz;
    }
    return { sx, sz };
  };

  /* Uniform grid over the collision set. The physics loop only ever tests the
     handful of faces near the boat instead of all ~175 of them.            */
  const CELL = 30;
  let SIDX = null;
  W.buildSegIndex = function () {
    SIDX = new Map();
    const key = (i, j) => i + ',' + j;
    W.segments.forEach((s, n) => {
      const i0 = Math.floor(Math.min(s.ax, s.bx) / CELL), i1 = Math.floor(Math.max(s.ax, s.bx) / CELL);
      const j0 = Math.floor(Math.min(s.az, s.bz) / CELL), j1 = Math.floor(Math.max(s.az, s.bz) / CELL);
      for (let i = i0 - 1; i <= i1 + 1; i++) for (let j = j0 - 1; j <= j1 + 1; j++) {
        const k = key(i, j);
        if (!SIDX.has(k)) SIDX.set(k, []);
        SIDX.get(k).push(s);
      }
    });
  };
  W.segmentsNear = function (x, z, rad) {
    if (!SIDX) return W.segments;
    const out = [], seen = new Set();
    const i0 = Math.floor((x - rad) / CELL), i1 = Math.floor((x + rad) / CELL);
    const j0 = Math.floor((z - rad) / CELL), j1 = Math.floor((z + rad) / CELL);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const b = SIDX.get(i + ',' + j);
      if (!b) continue;
      for (const s of b) if (!seen.has(s)) { seen.add(s); out.push(s); }
    }
    return out;
  };

  // nearest solid face within maxD — used for bank suction alongside quays
  W.nearestWall = function (x, z, maxD) {
    let best = null;
    for (const s of W.segmentsNear(x, z, maxD)) {
      if (s.kind === 'pile') continue;
      const ex = s.bx - s.ax, ez = s.bz - s.az, ll = ex * ex + ez * ez || 1e-6;
      const t = clamp(((x - s.ax) * ex + (z - s.az) * ez) / ll, 0, 1);
      const dx = x - (s.ax + ex * t), dz = z - (s.az + ez * t);
      const d = Math.hypot(dx, dz);
      if (d < maxD && (!best || d < best.d)) best = { d, nx: dx / (d || 1), nz: dz / (d || 1) };
    }
    return best;
  };

  /* -------------------------------------------------------------- textures */
  function cvs(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

  function plankTex() {
    const c = cvs(512, 512), g = c.getContext('2d');
    g.fillStyle = '#a08f76'; g.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 16; i++) {
      const y = i * 32;
      g.fillStyle = `hsl(${32 + Math.random() * 8},${18 + Math.random() * 10}%,${52 + Math.random() * 12}%)`;
      g.fillRect(0, y + 1, 512, 30);
      g.strokeStyle = 'rgba(60,45,30,.5)'; g.lineWidth = 1.4;
      g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(512, y + 0.5); g.stroke();
      for (let k = 0; k < 90; k++) {
        g.strokeStyle = `rgba(${90 + Math.random() * 60},${75 + Math.random() * 50},${55 + Math.random() * 40},.22)`;
        g.beginPath(); const yy = y + 3 + Math.random() * 26;
        g.moveTo(Math.random() * 512, yy); g.lineTo(Math.random() * 512, yy + (Math.random() - .5) * 3); g.stroke();
      }
    }
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
  }
  function concreteTex() {
    const c = cvs(256, 256), g = c.getContext('2d');
    g.fillStyle = '#b9b4aa'; g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 9000; i++) {
      g.fillStyle = `rgba(${120 + Math.random() * 90},${118 + Math.random() * 85},${110 + Math.random() * 80},.28)`;
      g.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
    }
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
  }
  W.tex = {};

  /* ------------------------------------------------------------------ sky  */
  function buildSky(scene) {
    const geo = new THREE.SphereGeometry(6000, 32, 20);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false,
      uniforms: { uSun: { value: new THREE.Vector3(0, 1, 0) }, uHaze: { value: 1 } },
      vertexShader: `varying vec3 vP; void main(){ vP=normalize(position); gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
      fragmentShader: `
        varying vec3 vP; uniform vec3 uSun; uniform float uHaze;
        void main(){
          float h = clamp(vP.y,-0.2,1.0);
          vec3 zen = vec3(0.055,0.28,0.62);
          vec3 mid = vec3(0.34,0.62,0.86);
          vec3 hor = vec3(0.80,0.88,0.94);
          float sunUp = clamp(uSun.y,0.0,1.0);
          // warm the sky as the sun drops
          zen = mix(vec3(0.06,0.12,0.30), zen, smoothstep(0.05,0.45,sunUp));
          hor = mix(vec3(0.98,0.62,0.36), hor, smoothstep(0.02,0.40,sunUp));
          vec3 c = mix(hor, mid, smoothstep(0.0,0.22,h));
          c = mix(c, zen, smoothstep(0.16,0.72,h));
          float sd = max(dot(vP,normalize(uSun)),0.0);
          c += vec3(1.0,0.92,0.72)*pow(sd,900.0)*12.0;                 // disc
          c += vec3(1.0,0.86,0.62)*pow(sd,14.0)*0.34*uHaze;            // glow
          c = mix(c, vec3(0.72,0.80,0.86), (1.0-smoothstep(-0.02,0.10,h))*0.75); // sea haze
          gl_FragColor = vec4(c,1.0);
        }`
    });
    const m = new THREE.Mesh(geo, mat); m.frustumCulled = false; scene.add(m);
    W.skyMat = mat;
  }

  function buildClouds(scene) {
    const c = cvs(256, 256), g = c.getContext('2d');
    const gr = g.createRadialGradient(128, 140, 8, 128, 140, 120);
    gr.addColorStop(0, 'rgba(255,255,255,.95)'); gr.addColorStop(.45, 'rgba(255,255,255,.55)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 256, 256);
    const t = new THREE.CanvasTexture(c);
    const grp = new THREE.Group();
    for (let i = 0; i < 46; i++) {
      const m = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, opacity: .5 + Math.random() * .35, depthWrite: false, fog: false }));
      const a = Math.random() * Math.PI * 2, r = 700 + Math.random() * 3400;
      m.position.set(Math.cos(a) * r, 320 + Math.random() * 560, Math.sin(a) * r);
      const s = 340 + Math.random() * 620; m.scale.set(s, s * (.42 + Math.random() * .22), 1);
      grp.add(m);
    }
    scene.add(grp); W.clouds = grp;
  }

  /* --------------------------------------------------------------- terrain */
  const TX0 = -1750, TX1 = 1150, TZ0 = -1300, TZ1 = 1350;
  const LOW = () => !!SIM.lowSpec;

  function buildTerrain(scene) {
    const TSTEP = LOW() ? 13 : 7.5;
    const nx = Math.round((TX1 - TX0) / TSTEP), nz = Math.round((TZ1 - TZ0) / TSTEP);
    const geo = new THREE.PlaneGeometry(TX1 - TX0, TZ1 - TZ0, nx, nz);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position, n = pos.count;
    const col = new Float32Array(n * 3);
    const cx = (TX0 + TX1) / 2, cz = (TZ0 + TZ1) / 2;
    const C = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const x = pos.getX(i) + cx, z = pos.getZ(i) + cz;
      const y = W.terrainY(x, z);
      pos.setX(i, x); pos.setZ(i, z); pos.setY(i, y);
      if (y >= 0) {
        // Sand is a shore-hugging band measured from the waterline, not an
        // elevation band — keying it to height alone sent beaches running up
        // the hillsides in fingers wherever the noise dipped.
        const dIn = -waterField(x, z);
        const beach = sstep(26, 2, dIn) * sstep(5.5, 1.2, y);
        const wet = sstep(1.6, 0.05, y);
        const slope = clamp(Math.abs(fbm(x * 0.09, z * 0.09, 2)) * 0.5
          + Math.abs(landHeight(x + 8, z) - landHeight(x - 8, z)) / 16, 0, 1);
        const gcol = new THREE.Color(
          0.13 + 0.09 * fbm(x * 0.045, z * 0.045, 2),
          0.34 + 0.15 * fbm(x * 0.062, z * 0.062, 2),
          0.11 + 0.04 * fbm(x * 0.03, z * 0.03, 2));
        gcol.lerp(new THREE.Color(0.30, 0.36, 0.20), sstep(70, 190, y) * 0.7);   // drier uplands
        C.copy(gcol);
        C.lerp(new THREE.Color(0.47, 0.44, 0.38), clamp(slope - 0.45, 0, 1) * 0.75);  // rock faces
        const sand = new THREE.Color(lerp(0.88, 0.74, wet), lerp(0.82, 0.67, wet), lerp(0.67, 0.52, wet));
        C.lerp(sand, beach);
      } else {
        const d = -y;
        C.setRGB(0.72, 0.70, 0.56);                            // pale coral sand
        C.lerp(new THREE.Color(0.16, 0.34, 0.32), sstep(0.6, 7, d));
        C.lerp(new THREE.Color(0.04, 0.10, 0.16), sstep(7, 30, d));
        const patch = fbm(x * 0.035, z * 0.035, 3);
        if (patch > 0.28 && d < 9) C.lerp(new THREE.Color(0.11, 0.26, 0.20), 0.55);   // sea grass / coral
      }
      col[i * 3] = C.r; col[i * 3 + 1] = C.g; col[i * 3 + 2] = C.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const m = new THREE.Mesh(geo, mat); m.receiveShadow = false; scene.add(m);
    W.terrain = m;
  }

  /* ----------------------------------------------------------- depth field
     256² lookup consumed by the water shader: R = depth, G = shelter.       */
  function buildDepthTex() {
    const N = 256, data = new Uint8Array(N * N * 4);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = TX0 + (i + .5) / N * (TX1 - TX0), z = TZ0 + (j + .5) / N * (TZ1 - TZ0);
      const d = W.depthAt(x, z), k = (j * N + i) * 4;
      data[k] = clamp(Math.round((d < 0 ? 0 : d) / 30 * 255), 0, 255);
      data[k + 1] = Math.round(shelter(x, z) * 255);
      data[k + 2] = d < 0 ? 255 : 0;                        // land mask
      data[k + 3] = 255;
    }
    const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
    t.minFilter = t.magFilter = THREE.LinearFilter; t.needsUpdate = true;
    W.depthTex = t;
  }

  /* ----------------------------------------------------------------- water */
  const WAVE_GLSL = `
    uniform vec4 uWaves[8];
    vec3 gerstner(vec2 p, float t, float sh, out vec3 nrm){
      vec3 disp = vec3(0.0); vec3 tx = vec3(1.,0.,0.); vec3 tz = vec3(0.,0.,1.);
      for(int i=0;i<4;i++){
        vec4 a = uWaves[i*2]; vec4 b = uWaves[i*2+1];
        vec2 d = a.xy; float A = a.z*sh; float k = a.w; float w = b.x; float Q = b.y/max(k*A*4.0,0.0001);
        Q = clamp(b.y, 0.0, 1.0)/max(k*A*4.0,0.0001); Q = min(Q, 1.0);
        float ph = k*dot(d,p) - w*t;
        float c = cos(ph), s = sin(ph);
        disp.x += Q*A*d.x*c; disp.z += Q*A*d.y*c; disp.y += A*s;
        float wa = k*A;
        tx.x += -Q*wa*d.x*d.x*s; tx.z += -Q*wa*d.x*d.y*s; tx.y += wa*d.x*c;
        tz.x += -Q*wa*d.y*d.x*s; tz.z += -Q*wa*d.y*d.y*s; tz.y += wa*d.y*c;
      }
      nrm = normalize(cross(tz,tx));
      return disp;
    }`;

  function buildWater(scene) {
    const seg = LOW() ? 220 : 420;
    const geo = new THREE.PlaneGeometry(5200, 5200, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      uniforms: {
        uTime: { value: 0 }, uWaves: { value: W.wavesUniform() },
        uSun: { value: new THREE.Vector3(0.4, 0.6, 0.3) },
        uDepth: { value: W.depthTex },
        uOrigin: { value: new THREE.Vector2(TX0, TZ0) },
        uSize: { value: new THREE.Vector2(TX1 - TX0, TZ1 - TZ0) },
        uCam: { value: new THREE.Vector3() },
        uChop: { value: 0.4 },
        uWake: { value: null },
        uWakeC: { value: new THREE.Vector2(0, 0) },
        uWakeR: { value: 260 },
        uSunCol: { value: new THREE.Color(1, .95, .85) },
        uHorizon: { value: new THREE.Color(0.80, 0.88, 0.94) }
      },
      vertexShader: WAVE_GLSL + `
        uniform sampler2D uDepth; uniform vec2 uOrigin, uSize; uniform float uTime;
        varying vec3 vW; varying vec3 vN; varying float vDep; varying float vSh;
        void main(){
          vec3 p = position;
          vec4 wp = modelMatrix*vec4(p,1.0);
          vec2 uv = (wp.xz-uOrigin)/uSize;
          vec4 dt = texture2D(uDepth, clamp(uv,0.001,0.999));
          float dep = dt.r*30.0; float sh = dt.g;
          vSh = sh; vDep = dep;
          vec3 nrm;
          vec3 disp = gerstner(wp.xz, uTime, sh*min(1.0, dep/2.2+0.15), nrm);
          wp.xyz += disp;
          vW = wp.xyz; vN = nrm;
          gl_Position = projectionMatrix*viewMatrix*wp;
        }`,
      fragmentShader: `
        uniform vec3 uSun, uCam; uniform float uTime, uChop;
        uniform vec3 uSunCol, uHorizon;
        uniform sampler2D uWake; uniform vec2 uWakeC; uniform float uWakeR;
        varying vec3 vW; varying vec3 vN; varying float vDep; varying float vSh;
        float h21(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
        float n2(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
          return mix(mix(h21(i),h21(i+vec2(1,0)),f.x),mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x),f.y);}
        void main(){
          vec3 N = normalize(vN);
          // fine ripple detail
          vec2 q = vW.xz*0.55;
          float r = n2(q+uTime*0.6)+n2(q*2.1-uTime*0.9)*0.5+n2(q*4.3+uTime*1.7)*0.25;
          vec2 g = vec2(dFdx(r),dFdy(r));
          // wind ripple exists even in a sheltered basin — don't scale it away
          N = normalize(N + vec3(-g.x,0.0,-g.y)*(0.35+1.8*uChop)*mix(0.55,1.0,vSh));
          vec3 V = normalize(uCam - vW);
          vec3 L = normalize(uSun);
          float f = pow(1.0-max(dot(N,V),0.0), 4.0);
          f = mix(0.02,1.0,f);

          vec3 sand    = vec3(0.52,0.86,0.80);
          vec3 shallow = vec3(0.20,0.78,0.76);
          vec3 mid     = vec3(0.04,0.52,0.63);
          vec3 deep    = vec3(0.012,0.13,0.30);
          vec3 body = mix(sand, shallow, smoothstep(0.2,2.2,vDep));
          body = mix(body, mid, smoothstep(2.2,8.0,vDep));
          body = mix(body, deep, smoothstep(9.0,30.0,vDep));

          vec3 sky = mix(uHorizon, vec3(0.20,0.46,0.78), clamp(reflect(-V,N).y,0.0,1.0));
          vec3 c = mix(body, sky, f*0.86);

          vec3 H = normalize(L+V);
          c += uSunCol*pow(max(dot(N,H),0.0),340.0)*1.7;
          c += uSunCol*pow(max(dot(N,H),0.0),40.0)*0.15;

          // shoreline & crest foam
          float crest = smoothstep(0.35,0.95,r*0.55+N.y*0.0);
          float shoreF = smoothstep(1.5,0.25,vDep)*(0.35+0.65*smoothstep(0.45,0.9,r*0.6));
          float wf = 0.0;
          vec2 wuv = (vW.xz-uWakeC)/uWakeR*0.5+0.5;
          if(all(greaterThan(wuv,vec2(0.0))) && all(lessThan(wuv,vec2(1.0)))) wf = texture2D(uWake,wuv).r;
          float foam = clamp(shoreF + wf*0.85, 0.0, 1.0);
          c = mix(c, vec3(0.94,0.97,0.98), foam*0.8);

          float alpha = mix(0.62, 0.985, smoothstep(0.2,5.0,vDep));
          alpha = max(alpha, foam*0.95);
          gl_FragColor = vec4(c, alpha);
        }`
    });
    const m = new THREE.Mesh(geo, mat);
    m.frustumCulled = false; m.renderOrder = 2;
    scene.add(m); W.water = m; W.mat = mat;
  }

  /* ------------------------------------------------------- wake render tgt
     A CPU-drawn foam texture that follows the boat; fed into the water frag. */
  function buildWake() {
    const N = 256;
    const c = cvs(N, N); const g = c.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, N, N);
    const t = new THREE.CanvasTexture(c);
    W.wakeCv = c; W.wakeCtx = g; W.wakeTex = t; W.wakeN = N;
    W.wakeCentre = new THREE.Vector2(0, 0); W.wakeRadius = 190;
    W.mat.uniforms.uWake.value = t;
    W.mat.uniforms.uWakeR.value = W.wakeRadius;
  }
  W.wakePoints = [];
  W.addWake = function (x, z, strength, width) {
    W.wakePoints.push({ x, z, s: strength, w: width, age: 0 });
    if (W.wakePoints.length > 420) W.wakePoints.shift();
  };
  W.updateWake = function (dt, bx, bz) {
    const g = W.wakeCtx, N = W.wakeN, R = W.wakeRadius;
    W.wakeCentre.set(bx, bz);
    W.mat.uniforms.uWakeC.value.set(bx, bz);
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = '#000'; g.fillRect(0, 0, N, N);
    for (let i = W.wakePoints.length - 1; i >= 0; i--) {
      const p = W.wakePoints[i];
      p.age += dt;
      if (p.age > 9) { W.wakePoints.splice(i, 1); continue; }
      const u = (p.x - bx) / R * 0.5 + 0.5, v = (p.z - bz) / R * 0.5 + 0.5;
      if (u < -0.1 || u > 1.1 || v < -0.1 || v > 1.1) continue;
      const life = 1 - p.age / 9;
      const rad = (p.w + p.age * 0.55) / R * 0.5 * N;
      const a = clamp(p.s * life * life, 0, 1) * 0.5;
      const gr = g.createRadialGradient(u * N, v * N, 0, u * N, v * N, Math.max(1.5, rad));
      gr.addColorStop(0, `rgba(255,255,255,${a})`);
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(u * N, v * N, Math.max(1.5, rad), 0, 6.284); g.fill();
    }
    W.wakeTex.needsUpdate = true;
  };

  /* ------------------------------------------------------- marina & docks */
  W.segments = [];   // collision walls  {ax,az,bx,bz,kind}
  W.berths = [];     // dockable slots
  W.buoys = [];

  function addSeg(ax, az, bx, bz, kind) { W.segments.push({ ax, az, bx, bz, kind: kind || 'dock' }); }

  function dockBox(scene, x, z, w, l, rotY, h) {
    // w = across (X before rotation), l = along (Z), floating pontoon
    h = h || 0.55;
    const g = new THREE.BoxGeometry(w, h, l);
    const t = W.tex.plank.clone(); t.needsUpdate = true;
    t.repeat.set(Math.max(1, w / 2.2), Math.max(1, l / 2.2));
    const mat = new THREE.MeshLambertMaterial({ map: t });
    const side = new THREE.MeshLambertMaterial({ color: 0x6f7a80 });
    const m = new THREE.Mesh(g, [side, side, mat, side, side, side]);
    m.position.set(x, 0.30, z); m.rotation.y = rotY;
    scene.add(m);
    // collision: the two long faces + two ends
    const c = Math.cos(rotY), s = Math.sin(rotY);
    const pt = (lx, lz) => [x + lx * c + lz * s, z - lx * s + lz * c];
    const p1 = pt(-w / 2, -l / 2), p2 = pt(w / 2, -l / 2), p3 = pt(w / 2, l / 2), p4 = pt(-w / 2, l / 2);
    addSeg(p1[0], p1[1], p2[0], p2[1]); addSeg(p2[0], p2[1], p3[0], p3[1]);
    addSeg(p3[0], p3[1], p4[0], p4[1]); addSeg(p4[0], p4[1], p1[0], p1[1]);
    return m;
  }

  function piling(scene, x, z, h) {
    const g = new THREE.CylinderGeometry(0.19, 0.22, h, 8);
    const m = new THREE.Mesh(g, W.tex.pileMat);
    m.position.set(x, h / 2 - 1.6, z); scene.add(m);
    // dark tide band
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.225, 0.235, 0.7, 8),
      new THREE.MeshLambertMaterial({ color: 0x2f3a2e }));
    b.position.set(x, 0.2, z); scene.add(b);
    W.segments.push({ ax: x, az: z, bx: x, bz: z, kind: 'pile' });
  }

  function cleat(scene, x, z, rot) {
    const g = new THREE.Group();
    const m = new THREE.MeshLambertMaterial({ color: 0x9aa3a8 });
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.44, 6), m);
    bar.rotation.z = Math.PI / 2; bar.position.y = 0.20; g.add(bar);
    for (const s of [-0.13, 0.13]) {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, 0.2, 6), m);
      p.position.set(s, 0.10, 0); g.add(p);
    }
    g.position.set(x, 0.58, z); g.rotation.y = rot || 0; scene.add(g);
  }

  function pedestal(scene, x, z) {
    const g = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.0, 0.34),
      new THREE.MeshLambertMaterial({ color: 0x2b3238 }));
    g.position.set(x, 1.06, z); scene.add(g);
    const l = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xffd27a }));
    l.position.set(x, 1.60, z); scene.add(l);
    W.dockLights.push(l);
  }
  W.dockLights = [];

  // Port Louis Marina: main pier parallel to the eastern shore of the lagoon,
  // fingers reaching west. Kept clear of the shoreline ellipse at both ends.
  const MARINA = { pierX: 194, z0: -126, z1: 112, fingerLen: 22, slipPitch: 15.5, nSlips: 15 };

  function buildMarina(scene) {
    const M = MARINA;
    dockBox(scene, M.pierX, (M.z0 + M.z1) / 2, 3.6, M.z1 - M.z0, 0);
    for (let z = M.z0 + 6; z < M.z1; z += 24) piling(scene, M.pierX + 2.3, z, 5.4);

    // shore access gangway to the head of the pier
    dockBox(scene, M.pierX + 26, M.z0 + 8, 50, 2.2, 0);

    for (let i = 0; i <= M.nSlips; i++) {
      const z = M.z0 + 10 + i * M.slipPitch;
      if (z > M.z1 - 8) break;
      dockBox(scene, M.pierX - 1.8 - M.fingerLen / 2, z, M.fingerLen, 1.15, 0);
      piling(scene, M.pierX - 1.8 - M.fingerLen, z, 5.0);
      cleat(scene, M.pierX - 6, z + 0.75, 0);
      cleat(scene, M.pierX - 15, z + 0.75, 0);
      if (i % 2 === 0) pedestal(scene, M.pierX - 2.6, z + 3);
      if (z + M.slipPitch <= M.z1 - 8) {
        W.berths.push({
          id: 'slip' + i, x: M.pierX - 1.8 - M.fingerLen / 2, z: z + M.slipPitch / 2,
          hdg: 90, width: M.slipPitch, kind: 'slip', bowIn: true,
          entryX: M.pierX - 1.8 - M.fingerLen - 30, entryZ: z + M.slipPitch / 2
        });
      }
    }

    // fuel dock: T-head at the southern end, approached from the open lagoon
    const fx = M.pierX - 15, fz = M.z1 + 14;
    dockBox(scene, fx, fz, 34, 4.2, 0);
    for (let i = 0; i < 4; i++) piling(scene, fx - 14 + i * 10, fz + 2.6, 5.2);
    for (let i = 0; i < 6; i++) cleat(scene, fx - 15 + i * 6.4, fz - 2.4, 0);
    for (const dx of [-8, 8]) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.5, 0.5),
        new THREE.MeshLambertMaterial({ color: 0xd8dde0 }));
      p.position.set(fx + dx, 1.3, fz + 1.4); scene.add(p);
    }
    W.berths.push({ id: 'fuel', x: fx, z: fz - 6.6, hdg: 270, width: 34, kind: 'alongside',
      side: 'stbd', entryX: fx - 120, entryZ: fz - 6.6 });

    // ---- Med-moor quay following the northern shoreline arc ---------------
    W.tex.concrete.repeat.set(12, 2);
    const qMat = new THREE.MeshLambertMaterial({ map: W.tex.concrete });
    const arcPt = (th, k) => [LAG.rx * k * Math.cos(th), LAG.rz * k * Math.sin(th)];
    const th0 = -125 * Math.PI / 180, th1 = -58 * Math.PI / 180, NQ = 10;
    const quayPts = [];
    for (let i = 0; i <= NQ; i++) quayPts.push(arcPt(th0 + (th1 - th0) * i / NQ, 0.995));
    for (let i = 0; i < NQ; i++) {
      const a = quayPts[i], b = quayPts[i + 1];
      const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const ang = Math.atan2(b[0] - a[0], b[1] - a[1]);
      const q = new THREE.Mesh(new THREE.BoxGeometry(9, 2.8, L + 1), qMat);
      // push the slab back onto the land side
      const nx = -mx / (LAG.rx * LAG.rx), nz = -mz / (LAG.rz * LAG.rz);
      const nl = Math.hypot(nx, nz);
      q.position.set(mx - nx / nl * 4.5, 0.6, mz - nz / nl * 4.5);
      q.rotation.y = ang; scene.add(q);
      addSeg(a[0], a[1], b[0], b[1], 'quay');
    }
    for (let i = 0; i < 6; i++) {
      const th = th0 + (th1 - th0) * (0.09 + i * 0.166);
      const p = arcPt(th, 0.995);
      let nx = -p[0] / (LAG.rx * LAG.rx), nz = -p[1] / (LAG.rz * LAG.rz);
      const nl = Math.hypot(nx, nz); nx /= nl; nz /= nl;          // unit normal into the lagoon
      cleat(scene, p[0] - nx * 1.6, p[1] - nz * 1.6, 0);
      const tyre = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 1.1, 10),
        new THREE.MeshLambertMaterial({ color: 0x1c1c1e }));
      tyre.rotation.x = Math.PI / 2; tyre.position.set(p[0] + nx * 0.3, 0.5, p[1] + nz * 0.3); scene.add(tyre);
      const hdg = (Math.atan2(nx, -nz) * 180 / Math.PI + 360) % 360;   // bow points into the lagoon
      // 11 m off the wall leaves the transom ~3 m clear — passerelle length,
      // and enough that the quay's straight collision chords never touch her
      W.berths.push({
        id: 'med' + i, x: p[0] + nx * 11.0, z: p[1] + nz * 11.0, hdg, width: 19, kind: 'med',
        ballX: p[0] + nx * 44, ballZ: p[1] + nz * 44,
        entryX: p[0] + nx * 105, entryZ: p[1] + nz * 105
      });
      addBuoy(scene, p[0] + nx * 44, p[1] + nz * 44, 'mooring');
    }

    // marina buildings — placed on genuine land east of the shoreline
    const bld = (x, z, w, d, h, col, roof) => {
      const y = W.terrainY(x, z); if (y < 0.5) return;
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color: col }));
      b.position.set(x, y + h / 2, z); scene.add(b);
      const r = new THREE.Mesh(new THREE.ConeGeometry(Math.hypot(w, d) * 0.56, 1.7, 4),
        new THREE.MeshLambertMaterial({ color: roof }));
      r.rotation.y = Math.PI / 4; r.position.set(x, y + h + 0.8, z); scene.add(r);
    };
    bld(284, -78, 18, 12, 6.0, 0xf2e3c8, 0xa8412c);
    bld(292, -34, 13, 10, 4.6, 0xe7d8b8, 0xa8412c);
    bld(298, 26, 22, 13, 6.8, 0xf6ecd6, 0x8f3a26);
    bld(288, 80, 15, 11, 5.2, 0xefe0c4, 0xa04430);
  }

  function addBuoy(scene, x, z, kind) {
    let m;
    if (kind === 'mooring') {
      m = new THREE.Mesh(new THREE.SphereGeometry(0.42, 12, 9),
        new THREE.MeshLambertMaterial({ color: 0xf2f2f0 }));
      const st = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.3, 6),
        new THREE.MeshLambertMaterial({ color: 0xdddddd }));
      st.position.y = 0.75; m.add(st);
    } else if (kind === 'red') {
      m = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.62, 1.7, 10),
        new THREE.MeshLambertMaterial({ color: 0xcc2222 }));
    } else {
      m = new THREE.Mesh(new THREE.ConeGeometry(0.62, 2.0, 10),
        new THREE.MeshLambertMaterial({ color: 0x1f9d4a }));
    }
    m.position.set(x, 0.3, z); scene.add(m);
    W.buoys.push({ mesh: m, x, z, kind, ph: Math.random() * 6.28 });
    return m;
  }

  function buildChannel(scene) {
    // buoyed entrance: red to starboard on entry (IALA B — red right returning)
    const dx = CH.bx - CH.ax, dz = CH.bz - CH.az;
    const L = Math.hypot(dx, dz), ux = dx / L, uz = dz / L;
    const px = -uz, pz = ux;                       // port-hand normal
    for (let i = 0; i <= 6; i++) {
      const t = 0.06 + i * 0.15;
      const cx = CH.ax + dx * t, cz = CH.az + dz * t;
      addBuoy(scene, cx + px * 34, cz + pz * 34, 'green');
      addBuoy(scene, cx - px * 34, cz - pz * 34, 'red');
    }
    // mooring field in the SW of the lagoon
    for (let i = 0; i < 10; i++) {
      const a = i * 0.628, r = 34 + (i % 3) * 26;
      W.moorBalls = W.moorBalls || [];
      const bx = -108 + Math.cos(a) * r, bz = 96 + Math.sin(a) * r * 0.7;
      addBuoy(scene, bx, bz, 'mooring');
      W.moorBalls.push({ x: bx, z: bz });
    }
    W.berths.push({ id: 'ball', x: W.moorBalls[4].x, z: W.moorBalls[4].z, hdg: 70,
      width: 12, kind: 'ball', entryX: W.moorBalls[4].x + 90, entryZ: W.moorBalls[4].z + 30 });
  }

  /* ------------------------------------------------------------- moored fleet */
  W.neighbours = [];
  function otherBoat(scene, x, z, hdg, len, beamF, cat, col) {
    const g = new THREE.Group();
    const hullMat = new THREE.MeshLambertMaterial({ color: col || 0xf3f4f2 });
    const deckMat = new THREE.MeshLambertMaterial({ color: 0xe6e2d8 });
    const bw = len * beamF;
    const mkHull = (off) => {
      const sh = new THREE.Shape();
      sh.moveTo(len * 0.5, 0); sh.quadraticCurveTo(len * 0.16, 0.9, -len * 0.5, 0.78);
      sh.lineTo(-len * 0.5, -0.75); sh.quadraticCurveTo(len * 0.1, -1.0, len * 0.5, 0);
      const geo = new THREE.ExtrudeGeometry(sh, { depth: cat ? len * 0.13 : bw, bevelEnabled: false });
      geo.rotateY(Math.PI / 2); geo.translate(off - (cat ? len * 0.065 : bw / 2), 0, 0);
      geo.rotateY(-Math.PI / 2);
      const m = new THREE.Mesh(geo, hullMat); m.rotation.y = Math.PI / 2; return m;
    };
    if (cat) { g.add(mkHull(bw / 2)); g.add(mkHull(-bw / 2));
      const br = new THREE.Mesh(new THREE.BoxGeometry(bw, 0.5, len * 0.5), deckMat);
      br.position.y = 1.1; g.add(br);
      const cab = new THREE.Mesh(new THREE.BoxGeometry(bw * 0.8, 1.5, len * 0.3), deckMat);
      cab.position.set(0, 2.0, len * 0.02); g.add(cab);
    } else {
      g.add(mkHull(0));
      const cab = new THREE.Mesh(new THREE.BoxGeometry(bw * 0.72, 1.1, len * 0.34), deckMat);
      cab.position.set(0, 1.2, -len * 0.02); g.add(cab);
    }
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.13, len * 1.28, 6),
      new THREE.MeshLambertMaterial({ color: 0xd6d9db }));
    mast.position.set(0, len * 0.64 + 1.2, cat ? len * 0.06 : 0); g.add(mast);
    const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, len * 0.4, 6),
      new THREE.MeshLambertMaterial({ color: 0x9aa0a4 }));
    boom.rotation.x = Math.PI / 2; boom.position.set(0, 3.0, -len * 0.16); g.add(boom);
    g.position.set(x, 0, z); g.rotation.y = -hdg * Math.PI / 180;
    scene.add(g);
    const hw = cat ? bw / 2 + 0.9 : bw / 2;
    W.neighbours.push({ g, x, z, hdg, len, hw, ph: Math.random() * 6.3 });
    // collision box
    const c = Math.cos(-hdg * Math.PI / 180), s = Math.sin(-hdg * Math.PI / 180);
    const P = (lx, lz) => [x + lx * c + lz * s, z - lx * s + lz * c];
    const a = P(-hw, -len / 2), b = P(hw, -len / 2), cc = P(hw, len / 2), d = P(-hw, len / 2);
    addSeg(a[0], a[1], b[0], b[1], 'boat'); addSeg(b[0], b[1], cc[0], cc[1], 'boat');
    addSeg(cc[0], cc[1], d[0], d[1], 'boat'); addSeg(d[0], d[1], a[0], a[1], 'boat');
  }

  // Fill the marina, leaving the target berth (and, for a slip, nothing in the
  // way of the approach) clear. Neighbours are what make a 8.16 m beam scary.
  function buildFleet(scene, reserved) {
    const M = MARINA;
    const R = reserved || [];
    const cols = [0xf3f4f2, 0xeef0ee, 0xdfe6e8, 0xf7f5ee, 0xe9eef0];
    const slips = W.berths.filter(b => b.kind === 'slip');
    slips.forEach((b, i) => {
      if (R.includes(b.id)) return;
      if (Math.random() < 0.18) return;
      const cat = Math.random() < 0.5;
      const len = cat ? 11 + Math.random() * 5 : 12 + Math.random() * 5;
      otherBoat(scene, M.pierX - 4.5 - len / 2, b.z, 90, len, cat ? 0.52 : 0.3, cat, cols[i % 5]);
    });
    // a couple of boats stern-to on the Med quay, leaving the target gap open
    W.berths.filter(b => b.kind === 'med').forEach((b, i) => {
      if (R.includes(b.id) || Math.random() < 0.45) return;
      const rad = b.hdg * Math.PI / 180;
      const len = 11 + Math.random() * 4;
      otherBoat(scene, b.x + Math.sin(rad) * (len / 2 - 7), b.z - Math.cos(rad) * (len / 2 - 7),
        b.hdg, len, Math.random() < .5 ? 0.5 : 0.3, Math.random() < .5, cols[i % 5]);
    });
    if (W.moorBalls) W.moorBalls.forEach((b, i) => {
      if (i === 4 || Math.random() < 0.5) return;
      otherBoat(scene, b.x - 8, b.z - 3, 70 + Math.random() * 30, 11 + Math.random() * 4,
        Math.random() < .5 ? 0.5 : 0.3, Math.random() < .5, cols[i % 5]);
    });
  }

  /* --------------------------------------------------------------- scenery */
  function buildTown(scene) {
    const wallGeo = new THREE.BoxGeometry(1, 1, 1);
    const roofGeo = new THREE.ConeGeometry(1, 1, 4);      // unit cone, scaled per instance
    const N = LOW() ? 180 : 340;
    const wallCols = [0xf6ead0, 0xf0dcbe, 0xe8e2d2, 0xf7e8c8, 0xdfe8e2, 0xf2d8c0, 0xe6dcc4];
    const roofCols = [0xa8412c, 0x9c3a26, 0xb04a30, 0x8e3524, 0xa04430];
    // per-instance colour comes from instanceColor, NOT a vertex attribute —
    // setting vertexColors here would look for one that doesn't exist and
    // render every building black
    const wm = new THREE.MeshLambertMaterial();
    const rm = new THREE.MeshLambertMaterial();
    const wi = new THREE.InstancedMesh(wallGeo, wm, N);
    const ri = new THREE.InstancedMesh(roofGeo, rm, N);
    const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), s = new THREE.Vector3();
    const C = new THREE.Color();
    let n = 0, guard = 0;
    while (n < N && guard++ < 20000) {
      // hillside amphitheatre around the Carenage, north & north-east
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random());
      let x = -140 + Math.cos(a) * r * 470, z = -430 + Math.sin(a) * r * 330;
      if (Math.random() < 0.35) { x = 260 + Math.random() * 260; z = -240 + Math.random() * 320; }
      const y = W.terrainY(x, z);
      if (y < 3 || y > 118) continue;
      const w = 5 + Math.random() * 7, d = 5 + Math.random() * 7, h = 3.4 + Math.random() * 5.5;
      v.set(x, y + h / 2 - 0.6, z); s.set(w, h, d);
      q.setFromEuler(new THREE.Euler(0, Math.random() * Math.PI, 0));
      mtx.compose(v, q, s); wi.setMatrixAt(n, mtx);
      C.setHex(wallCols[(Math.random() * wallCols.length) | 0]); wi.setColorAt(n, C);
      // seat the pyramid roof exactly on the wall top (box is sunk 0.6 m)
      const rh = 1.5 + Math.random() * 0.8;
      v.set(x, y + h - 0.6 + rh / 2, z);
      s.set(Math.hypot(w, d) / 2 * 1.04, rh, Math.hypot(w, d) / 2 * 1.04);
      mtx.compose(v, q, s); ri.setMatrixAt(n, mtx);
      C.setHex(roofCols[(Math.random() * roofCols.length) | 0]); ri.setColorAt(n, C);
      n++;
    }
    wi.count = n; ri.count = n;
    wi.instanceMatrix.needsUpdate = ri.instanceMatrix.needsUpdate = true;
    if (wi.instanceColor) wi.instanceColor.needsUpdate = true;
    if (ri.instanceColor) ri.instanceColor.needsUpdate = true;
    scene.add(wi); scene.add(ri);

    // Fort George — stone bastion on the headland
    const fm = new THREE.MeshLambertMaterial({ color: 0x9a8f7d });
    const fx = -436, fz = -142, fy = W.terrainY(fx, fz);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(30, 34, 9, 8), fm);
    base.position.set(fx, fy + 3, fz); scene.add(base);
    for (let i = 0; i < 8; i++) {
      const a = i / 8 * 6.283;
      const t = new THREE.Mesh(new THREE.BoxGeometry(6, 3.2, 3), fm);
      t.position.set(fx + Math.cos(a) * 30, fy + 8.6, fz + Math.sin(a) * 30);
      t.rotation.y = -a; scene.add(t);
    }
    const flag = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 14, 6),
      new THREE.MeshLambertMaterial({ color: 0xdddddd }));
    flag.position.set(fx, fy + 14, fz); scene.add(flag);
  }

  function buildPalms(scene) {
    const trunkGeo = new THREE.CylinderGeometry(0.13, 0.26, 7.5, 6);
    trunkGeo.translate(0, 3.75, 0);
    // lay the frond flat in the XZ plane before offsetting it out along +X,
    // otherwise every palm is a ring of vertical spikes
    const frondGeo = new THREE.PlaneGeometry(6.2, 1.1);
    frondGeo.rotateX(-Math.PI / 2);
    frondGeo.translate(3.1, 0, 0);
    const tm = new THREE.MeshLambertMaterial({ color: 0x7a6448 });
    const fm = new THREE.MeshLambertMaterial({ color: 0x2f7a34, side: THREE.DoubleSide });
    const N = LOW() ? 130 : 260;
    const ti = new THREE.InstancedMesh(trunkGeo, tm, N);
    const fi = new THREE.InstancedMesh(frondGeo, fm, N * 7);
    const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), s = new THREE.Vector3(1, 1, 1);
    let n = 0, f = 0, guard = 0;
    while (n < N && guard++ < 40000) {
      const x = TX0 + Math.random() * (TX1 - TX0), z = TZ0 + Math.random() * (TZ1 - TZ0);
      const wf = -waterField(x, z);
      if (wf < 2 || wf > 60) continue;
      const y = W.terrainY(x, z);
      if (y < 0.4 || y > 34) continue;
      const sc = 0.75 + Math.random() * 0.55, lean = (Math.random() - .5) * 0.28;
      v.set(x, y, z); q.setFromEuler(new THREE.Euler(lean, Math.random() * 6.28, lean * 0.7));
      s.set(sc, sc, sc); mtx.compose(v, q, s); ti.setMatrixAt(n, mtx);
      for (let k = 0; k < 7; k++) {
        const a = k / 7 * 6.283 + Math.random() * 0.4;
        const e = new THREE.Euler(0, a, -0.34 - Math.random() * 0.4, 'YZX');
        q.setFromEuler(e);
        v.set(x + lean * 3, y + 7.4 * sc, z + lean * 2.4);
        s.set(sc, sc, sc); mtx.compose(v, q, s); fi.setMatrixAt(f++, mtx);
      }
      n++;
    }
    ti.count = n; fi.count = f;
    ti.instanceMatrix.needsUpdate = fi.instanceMatrix.needsUpdate = true;
    scene.add(ti); scene.add(fi);
  }

  /* ------------------------------------------------------------------ init */
  W.build = function (scene, opts) {
    W.tex.plank = plankTex();
    W.tex.concrete = concreteTex();
    W.tex.pileMat = new THREE.MeshLambertMaterial({ map: W.tex.plank });
    W.segments.length = 0; W.berths.length = 0; W.buoys.length = 0;
    W.neighbours.length = 0; W.dockLights.length = 0; W.wakePoints.length = 0;

    buildSky(scene);
    buildClouds(scene);
    buildTerrain(scene);
    W.buildDepthGrid(TX0, TX1, TZ0, TZ1);
    buildDepthTex();
    buildWater(scene);
    buildWake();
    buildMarina(scene);
    buildChannel(scene);
    buildTown(scene);
    buildPalms(scene);
    buildFleet(scene, opts && opts.reserved);
    W.buildSegIndex();
    return W;
  };

  W.berth = function (id) { return W.berths.find(b => b.id === id); };

  W.update = function (t, dt, cam) {
    if (W.mat) {
      W.mat.uniforms.uTime.value = t;
      W.mat.uniforms.uCam.value.copy(cam.position);
    }
    for (const b of W.buoys) {
      b.mesh.position.y = W.waveY(b.x, b.z, t) + (b.kind === 'mooring' ? 0.1 : 0.35);
      b.mesh.rotation.z = Math.sin(t * 1.3 + b.ph) * 0.13;
      b.mesh.rotation.x = Math.cos(t * 1.1 + b.ph) * 0.11;
    }
    for (const n of W.neighbours) {
      n.g.position.y = W.waveY(n.x, n.z, t) * 0.85;
      n.g.rotation.z = Math.sin(t * 0.9 + n.ph) * 0.028;
      n.g.rotation.x = Math.sin(t * 0.72 + n.ph * 1.7) * 0.02;
    }
  };

  W.MARINA = MARINA; W.LAG = LAG; W.CH = CH;
  W.bounds = { TX0, TX1, TZ0, TZ1 };
})();
