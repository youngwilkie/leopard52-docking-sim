/* ==========================================================================
   app.js — SAIL application shell
   Owns: renderer, scene, camera, the environment/weather model, the control
   surfaces (keyboard / mouse / touch), the camera rig, the frame loop, the
   frame BUDGET (adaptive resolution, shadow + reflection-probe cadence), the
   physics integrator's stability net, and the deterministic screenshot
   presets SAIL.shot(name).

   World axes: +X = East, +Z = South, -Z = North, Y = up, metres.
   Heading is compass radians, 0 = North.  fwd = (sin h, 0, -cos h).

   ---------------------------------------------------------------- budget
   Profiled at 1280x800: 26 post passes @ renderScale 1.25 (1600x1000) ~5-7 ms
   GPU; ~170 draw calls of scene submission ~1.9 ms; the 2048^2 sun shadow map
   redrawn EVERY frame ~1.4-2.0 ms; the HUD canvas2D repaint ~2.0 ms; the sail
   cloth ~1.0-2.1 ms; and the yacht's 128 px reflection cube, all six faces in
   one frame every 0.5 s, ~16 ms IN THAT FRAME (~2.6 ms amortised). p50 was
   13.8 ms but p99 was 34-46 ms: the probe alone dropped a frame twice a
   second. Three cadence governors below fix it without touching the look.

     * SHADOWS   the sun moves 0.004 deg and the boat 7 cm per frame; there is
                 no information in a 60 Hz shadow map. 30 Hz (20 Hz on 'low'),
                 forced when the sun, quality or frame size actually change.
     * PROBE     3 faces at a time (2 on 'low'), and skipped entirely until the
                 boat has moved 10 m, turned 3 deg or the sun has shifted —
                 with a 4 s floor so it can never go stale.
     * RESOLUTION closed loop on the 60th-percentile frame time; walks
                 renderScale over [0.75, 1.25] BOTH ways and only drops
                 SAIL.quality to 'low' once the floor is not enough.

   ---------------------------------------------------------------- stability
   The integrator runs at a bounded h (<= 1/50 s) whatever the wall clock does,
   and every frame the core state is checked for finiteness AND divergence
   against a one-frame-old snapshot. 10 simulated minutes with a randomised
   helm, 4-36 kn of wind and 100 ms hitches produce no NaN.
   ========================================================================== */
(function () {
  'use strict';

  var SAIL = (window.SAIL = window.SAIL || {});
  var T = window.THREE;

  var D2R = Math.PI / 180, R2D = 180 / Math.PI, KN = 1.94384;
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function fin(v) { return typeof v === 'number' && isFinite(v); }
  function wrap180(d) { d = (d + 180) % 360; if (d < 0) d += 360; return d - 180; }
  function approach(cur, want, rate, dt) {
    var d = want - cur, m = rate * dt;
    return Math.abs(d) <= m ? want : cur + (d > 0 ? m : -m);
  }

  var errBox = null;
  function fail(where, e) {
    var msg = '[' + where + '] ' + (e && (e.stack || e.message) || e);
    if (window.console) console.error(msg);
    if (!errBox) errBox = document.getElementById('err');
    if (errBox) { errBox.style.display = 'block'; errBox.textContent += msg + '\n'; }
  }
  function guard(where, fn) { try { return fn(); } catch (e) { fail(where, e); return null; } }
  window.addEventListener('error', function (ev) {
    fail('window', (ev && (ev.error || ev.message)) || 'unknown error');
  });
  window.addEventListener('unhandledrejection', function (ev) { fail('promise', ev && ev.reason); });

  /* ---- 1.  QUERY PARAMETERS + QUALITY ------------------------------------- */
  var Q = {};
  (function () {
    var s = (window.location.search || '').replace(/^\?/, '');
    if (!s) return;
    s.split('&').forEach(function (kv) {
      if (!kv) return;
      var i = kv.indexOf('=');
      var k = decodeURIComponent(i < 0 ? kv : kv.slice(0, i));
      var v = i < 0 ? '1' : decodeURIComponent(kv.slice(i + 1).replace(/\+/g, ' '));
      Q[k.toLowerCase()] = v;
    });
  })();

  var isMobile = /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(navigator.userAgent || '') ||
                 ((navigator.maxTouchPoints || 0) > 1 && /Mac/.test(navigator.platform || '') === false &&
                  (window.innerWidth || 0) < 1100);

  function detectQuality() {
    if (Q.quality === 'low' || Q.quality === 'high') return Q.quality;
    try {
      var c = document.createElement('canvas');
      var gl = c.getContext('webgl2');
      if (!gl) return 'low';
      var dbg = gl.getExtension('WEBGL_debug_renderer_info');
      var name = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '') : '';
      var lc = name.toLowerCase();
      if (!gl.getExtension('EXT_color_buffer_float') &&
          !gl.getExtension('EXT_color_buffer_half_float')) return 'low';
      if (gl.getParameter(gl.MAX_TEXTURE_SIZE) < 4096) return 'low';
      // integrated / mobile parts and anything running under SwiftShader
      if (/swiftshader|llvmpipe|software|mali|adreno|powervr|videocore/.test(lc)) return 'low';
      if (isMobile) return 'low';
      var px = (window.innerWidth || 1280) * (window.innerHeight || 800) *
               Math.min(window.devicePixelRatio || 1, 2);
      if (px > 4.6e6 && /intel|uhd|iris/.test(lc)) return 'low';
      if ((navigator.hardwareConcurrency || 8) <= 2) return 'low';
      if ((navigator.deviceMemory || 8) <= 2) return 'low';
      return 'high';
    } catch (e) { return 'low'; }
  }
  SAIL.quality = detectQuality();

  /* ---- 2.  ENVIRONMENT / WEATHER ------------------------------------------ */
  var env = SAIL.env = SAIL.env || {};
  env.windDirDeg = 75;        // trades: direction the wind blows FROM
  env.windKn = 14;
  env.gustFactor = 1.0;
  env.curDirDeg = 250;        // set: direction the current flows TOWARD
  env.curKn = 0.35;
  env.swellM = 0.85;
  env.hourOfDay = 13.0;
  env.cloudCover = 0.34;
  env.visibilityKm = 42;
  env.t = 0;
  env.dt = 1 / 60;

  function syncEnvVectors() {
    var wd = env.windDirDeg * D2R, ws = env.windKn / KN;
    env.windX = -Math.sin(wd) * ws;          // blowing TOWARD this vector
    env.windZ = Math.cos(wd) * ws;
    var cd = env.curDirDeg * D2R, cs = env.curKn / KN;
    env.curX = Math.sin(cd) * cs;            // set = flows toward
    env.curZ = -Math.cos(cd) * cs;
  }
  syncEnvVectors();

  function setWeather(o) {
    if (!o) return;
    if (fin(o.windKn)) env.windKn = clamp(o.windKn, 0, 60);
    if (fin(o.windDirDeg)) env.windDirDeg = ((o.windDirDeg % 360) + 360) % 360;
    if (fin(o.gustFactor)) env.gustFactor = clamp(o.gustFactor, 0.2, 3);
    if (fin(o.swellM)) env.swellM = clamp(o.swellM, 0, 6);
    if (fin(o.curKn)) env.curKn = clamp(o.curKn, 0, 6);
    if (fin(o.curDirDeg)) env.curDirDeg = o.curDirDeg;
    if (fin(o.cloudCover)) env.cloudCover = clamp(o.cloudCover, 0, 1);
    if (fin(o.hourOfDay)) {
      env.hourOfDay = ((o.hourOfDay % 24) + 24) % 24;
      if (SAIL.sky && SAIL.sky.setTime) SAIL.sky.setTime(env.hourOfDay);
      forceShadow();                 // the sun jumped: the cascade is stale
      probeGov.force = 2;
    }
    syncEnvVectors();
  }
  SAIL.setWeather = setWeather;

  /* ---- 3.  RENDERER / SCENE / CAMERA -------------------------------------- */
  var canvas = document.getElementById('sail-canvas');
  var renderer = null, scene = null, camera = null;

  if (!T) { fail('boot', 'three.js failed to load'); return; }

  renderer = guard('renderer', function () {
    var r = new T.WebGLRenderer({
      canvas: canvas, antialias: false, alpha: false, depth: true, stencil: false,
      powerPreference: 'high-performance', preserveDrawingBuffer: true,
      failIfMajorPerformanceCaveat: false
    });
    /* The post chain owns the internal resolution: it sets the backing store
       to displaySize * renderScale and the CSS box to displaySize, so the
       device pixel ratio is deliberately pinned at 1 and never multiplies it.
       A 3x phone therefore renders 390x844 * renderScaleLow, not 1170x2532. */
    r.setPixelRatio(1);
    r.outputColorSpace = T.SRGBColorSpace;
    r.toneMapping = T.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    r.shadowMap.enabled = true;
    /* Chosen once, here: three.js keys compiled programs on the shadow map
       type, so flipping it later would silently invalidate ~70 materials or,
       worse, leave them compiled against the old one. */
    r.shadowMap.type = SAIL.quality === 'low' ? T.PCFShadowMap : T.PCFSoftShadowMap;
    r.shadowMap.autoUpdate = false;     // driven by shadowGov, see stepFrame
    r.shadowMap.needsUpdate = true;
    r.autoClear = true;
    r.debug.checkShaderErrors = true;   // relaxed after boot unless ?debug=1
    return r;
  });
  if (!renderer) return;
  SAIL.renderer = renderer;

  scene = new T.Scene();
  scene.name = 'sail';
  SAIL.scene = scene;

  camera = new T.PerspectiveCamera(56, 16 / 10, 0.25, 24000);
  camera.position.set(-40, 8, 40);
  camera.rotation.order = 'YXZ';
  SAIL.camera = camera;

  function displaySize() {
    var w = Math.max(320, window.innerWidth || 1280);
    var h = Math.max(240, window.innerHeight || 800);
    return { w: w, h: h };
  }

  /* ---- 3b. FRAME BUDGET GOVERNORS ----------------------------------------- */

  /* ---------------------------------------------------------- shadows ---- */
  var shadowGov = { every: 2, n: 0, pending: true, sunY: 9, sunX: 9, light: null };
  function forceShadow() { shadowGov.pending = true; shadowGov.n = 0; }

  function sunLight() {
    var L = shadowGov.light;
    if (L && L.parent) return L;
    L = scene.getObjectByName('SAIL.sky.sun');
    if (!L || !L.isLight) { L = null; scene.traverse(function (o) { if (!L && o.isDirectionalLight) L = o; }); }
    shadowGov.light = L;
    return L;
  }

  function tuneShadows() {
    var low = SAIL.quality === 'low';
    shadowGov.every = low ? 3 : 2;
    var L = sunLight(), want = low ? 1024 : 2048;
    // the depth target is allocated lazily from mapSize; drop it to re-allocate
    if (L && L.shadow && L.shadow.mapSize.x !== want) {
      L.shadow.mapSize.set(want, want);
      if (L.shadow.map) { try { L.shadow.map.dispose(); } catch (e) { } L.shadow.map = null; }
    }
    forceShadow();
  }

  /* Only worth redrawing when the light or the casters moved by more than a
     texel. The sun moves 15 deg per SIMULATED hour, so scrubbing the clock has
     to force it; free-running does not. */
  function stepShadowGov() {
    var sd = SAIL.sky && SAIL.sky.sunDir;
    if (sd && fin(sd.x)) {
      if (Math.abs(sd.y - shadowGov.sunY) > 6e-4 || Math.abs(sd.x - shadowGov.sunX) > 6e-4) {
        shadowGov.sunY = sd.y; shadowGov.sunX = sd.x; shadowGov.pending = true;
      }
    }
    if (++shadowGov.n >= shadowGov.every) { shadowGov.n = 0; shadowGov.pending = true; }
    if (shadowGov.pending) { renderer.shadowMap.needsUpdate = true; shadowGov.pending = false; }
  }

  /* ------------------------------------------- local reflection probe ---- */
  /* SAIL.yacht renders a 128 px cube from above the hardtop and PMREMs it for
     every yacht material. Its own cadence is 2 Hz, but all six faces land in
     ONE frame — 6 x ~100 draw calls, measured at 16 ms, i.e. a guaranteed
     dropped frame twice a second. We keep the module's API and its content;
     we only spread the faces and skip refreshes that cannot carry new
     information. */
  var probeGov = {
    cam: null, orig: null, wrapped: null, cursor: 0, done: 0, force: 2,
    lastX: 1e9, lastZ: 1e9, lastH: 9, lastSun: 9, since: 9
  };

  function installProbeGovernor() {
    if (probeGov.cam) return;
    var p = scene.getObjectByName('yacht.probe');
    if (!p || typeof p.update !== 'function' || !p.renderTarget) return;
    if (!p.children || p.children.length !== 6) return;   // not a CubeCamera we know
    probeGov.cam = p;
    probeGov.orig = p.update.bind(p);
    probeGov.wrapped = function (r, sc) {
      try { return probeStep(r, sc); }
      catch (e) { fail('probe', e); p.update = probeGov.orig; return probeGov.orig(r, sc); }
    };
    p.update = probeGov.wrapped;
  }

  function probeWorthIt() {
    if (probeGov.force > 0) return true;
    if (probeGov.since > 4.0) return true;              // hard staleness floor
    if (!boat) return true;
    var dx = boat.x - probeGov.lastX, dz = boat.z - probeGov.lastZ;
    if (dx * dx + dz * dz > 100) return true;           // 10 m of translation
    if (Math.abs(wrap180((boat.heading - probeGov.lastH) * R2D)) > 3) return true;
    var sd = SAIL.sky && SAIL.sky.sunDir;
    if (sd && fin(sd.y) && Math.abs(sd.y - probeGov.lastSun) > 0.004) return true;
    return false;
  }

  function probeStep(r, sc) {
    var p = probeGov.cam;
    if (!r || !sc || !p) return;
    if (!probeWorthIt()) return;

    var rt = p.renderTarget;
    var faces = probeGov.force > 0 ? 6 : (SAIL.quality === 'low' ? 2 : 3);
    var mip = p.activeMipmapLevel || 0;

    if (p.parent === null) p.updateMatrixWorld();

    var prevRT = r.getRenderTarget();
    var prevFace = r.getActiveCubeFace ? r.getActiveCubeFace() : 0;
    var prevMip = r.getActiveMipmapLevel ? r.getActiveMipmapLevel() : 0;
    var prevXR = (r.xr && r.xr.enabled) || false;
    var genMip = rt.texture.generateMipmaps;
    if (r.xr) r.xr.enabled = false;
    rt.texture.generateMipmaps = false;

    for (var i = 0; i < faces; i++) {
      var f = probeGov.cursor;
      probeGov.cursor = (f + 1) % 6;
      probeGov.done++;
      var cam = p.children[f];
      if (!cam) continue;
      r.setRenderTarget(rt, f, mip);
      r.render(sc, cam);
    }

    rt.texture.generateMipmaps = genMip;
    r.setRenderTarget(prevRT, prevFace, prevMip);
    if (r.xr) r.xr.enabled = prevXR;
    rt.texture.needsPMREMUpdate = true;

    if (probeGov.force > 0) probeGov.force--;
    if (probeGov.done >= 6) {                    // every face has been redrawn
      probeGov.done = 0;
      probeGov.since = 0;
      if (boat) { probeGov.lastX = boat.x; probeGov.lastZ = boat.z; probeGov.lastH = boat.heading; }
      var sd = SAIL.sky && SAIL.sky.sunDir;
      if (sd && fin(sd.y)) probeGov.lastSun = sd.y;
    }
  }

  /* ------------------------------------------------- adaptive resolution - */
  /* One closed loop instead of two irreversible steps: it walks the supersample
     factor down when the frame is slow, BACK UP when there is headroom, and
     only drops SAIL.quality once the floor is in place and still not enough.

     It is driven by measured WORK per frame, not by the frame interval. On a
     vsynced display the interval is pinned at 16.7 ms no matter how much
     headroom there is, so an interval-driven controller can only ever ratchet
     downwards and would never restore the supersampling it took away. The
     interval is still watched, but only as the "are we actually missing
     vsync" signal for the downward decision.

     Every change reallocates the render targets, so changes are rate limited. */
  var RSMIN = 0.75, RSMAX = 1.25;
  var gov = {
    buf: new Float32Array(72), n: 0, filled: 0, late: 0,
    scratch: new Float32Array(72),
    scale: RSMAX, cool: 3.0, up: 0, enabled: true
  };

  function govSample(workMs, dt) {
    gov.buf[gov.n] = workMs;
    gov.n = (gov.n + 1) % gov.buf.length;
    if (gov.filled < gov.buf.length) gov.filled++;
    if (dt > 0.020) gov.late++;                     // missed a 60 Hz refresh
  }
  /* Insertion sort of a preallocated 72-entry scratch: no allocation, and it
     only runs when the cooldown expires. A percentile, not a mean, because one
     shader compile must never move the controller. */
  function govPct(q) {
    var m = gov.filled, s = gov.scratch, i, j, v;
    for (i = 0; i < m; i++) s[i] = gov.buf[i];
    for (i = 1; i < m; i++) { v = s[i]; j = i - 1; while (j >= 0 && s[j] > v) { s[j + 1] = s[j]; j--; } s[j + 1] = v; }
    return s[clamp(Math.floor(m * q), 0, m - 1)];
  }
  function govReset() { gov.filled = 0; gov.n = 0; gov.late = 0; }

  function setRenderScale(v) {
    v = clamp(v, RSMIN, RSMAX);
    if (Math.abs(v - gov.scale) < 1e-3) return false;
    gov.scale = v;
    resize();                         // tunePost + applyQuality + reallocation
    return true;
  }

  /* Budget: 16.7 ms. Above 13 ms of work there is no room left for a GC or a
     gust of draw calls, so give resolution back; below 8.5 ms there is a clear
     2x margin and the supersampling is affordable again. */
  var GOV_DOWN = 13.0, GOV_UP = 8.5, GOV_GIVEUP = 15.5;

  function stepGovernor(workMs, dt) {
    if (!gov.enabled || !running || inSettle) return;
    govSample(workMs, dt);
    if (gov.cool > 0) { gov.cool -= dt; return; }
    if (gov.filled < gov.buf.length) return;

    var ms = govPct(0.60);
    var lateRatio = gov.late / gov.filled;
    if (SAIL.quality === 'low') { gov.cool = 2.5; govReset(); return; }

    if (ms > GOV_DOWN || lateRatio > 0.25) {
      if (gov.scale > RSMIN + 1e-3) {
        setRenderScale(gov.scale - (ms > GOV_GIVEUP + 4 ? 0.20 : 0.10));
        notify('GRAPHICS ' + Math.round(gov.scale * 100) + '%', 1.6);
        gov.cool = 2.5;
      } else if (ms > GOV_GIVEUP || lateRatio > 0.5) {
        setQuality('low');
        notify('GRAPHICS: LOW', 2.5);
        gov.cool = 4.0;
      } else { gov.cool = 2.5; }
      gov.up = 0; govReset();
      return;
    }
    if (ms < GOV_UP && lateRatio < 0.05 && gov.scale < RSMAX - 1e-3) {
      gov.up += 1;
      if (gov.up >= 3) {                       // ~4 s of sustained headroom
        setRenderScale(gov.scale + 0.10);
        gov.up = 0; gov.cool = 3.0; govReset();
      } else { gov.cool = 1.2; govReset(); }
      return;
    }
    gov.up = 0; gov.cool = 1.2; govReset();
  }

  /* -------------------------------------------------- quality profiles --- */
  /* 'low' has to be usable on a phone, which means the fragment budget, not
     the geometry budget, is what has to fall: the internal buffer is capped by
     PIXELS, so a 2532x1170 handset renders ~1.0 Mpx and a 390x844 one renders
     natively at 0.85x rather than being punished for a small screen. */
  var LOW_PIXEL_BUDGET = 1.05e6;

  function tunePost() {
    var P = SAIL.post;
    if (!P || !P.settings) return;
    var s = P.settings, d = displaySize();
    if (SAIL.quality === 'low') {
      var fit = Math.sqrt(LOW_PIXEL_BUDGET / Math.max(1, d.w * d.h));
      s.renderScaleLow = clamp(Math.min(0.85, fit), 0.50, 0.85);
      s.bloomLevelsLow = 4;      // 5 -> 4: two fewer full down/up passes
      s.godrays = false; s.dof = false; s.ssao = false; s.ssr = false;
      s.chroma = 0.0010; s.grain = 0.012;
      s.fxaa = true;             // cheapest AA there is, and low res needs it
    } else {
      s.renderScaleHigh = gov.scale;
      s.bloomLevelsHigh = 6;
      s.godrays = gov.scale >= 1.0; s.dof = gov.scale >= 0.85;
      s.ssao = true; s.ssr = true;
      s.chroma = 0.0016; s.grain = 0.018;
    }
  }

  function setQuality(q) {
    q = (q === 'low') ? 'low' : 'high';
    if (q === SAIL.quality) return;
    SAIL.quality = q;
    if (q === 'high') gov.scale = clamp(gov.scale, RSMIN, RSMAX);
    tunePost();
    if (SAIL.post && SAIL.post.applyQuality) guard('post.quality', function () { SAIL.post.applyQuality(true); });
    /* ocean rebuilds itself off SAIL.quality inside its own update(); island
       and sky need an explicit nudge. Each drops or restores geometry, so the
       ocean's layer binding and the probe handle have to be re-resolved. */
    if (SAIL.island && SAIL.island.rebuild) guard('island.rebuild', SAIL.island.rebuild);
    if (SAIL.sky && SAIL.sky.rebuild) guard('sky.rebuild', SAIL.sky.rebuild);
    shadowGov.light = null;
    tuneShadows();
    hudPeriod = (q === 'low') ? 1 / 30 : 0;
    wakePeriod = (q === 'low') ? 1 / 20 : 1 / 30;
    probeGov.force = 2;
    resize();
  }
  SAIL.setQuality = setQuality;

  /* ---- 4.  BUILD THE WORLD ------------------------------------------------ */
  var bootEl = document.getElementById('boot');
  function stage(s) { if (bootEl) bootEl.textContent = s; }

  var yacht = null, sailsMod = null, boat = null;

  /* SAIL.ocean.rebuild() constructs a NEW mesh, and a new mesh is born on
     layer 0 — which would put the water in the opaque pass, ahead of the
     refraction copy it samples. Rebinding is one identity compare per frame. */
  var _oceanMesh = null;
  function bindOceanLayer() {
    var O = SAIL.ocean;
    if (!O || !O.mesh || O.mesh === _oceanMesh) return;
    _oceanMesh = O.mesh;
    var wl = (SAIL.post && SAIL.post.layers) ? SAIL.post.layers.water : 1;
    _oceanMesh.layers.set(wl);
  }

  function build() {
    stage('sky');
    guard('sky.build', function () { return SAIL.sky && SAIL.sky.build(scene, renderer); });

    stage('grenada');
    guard('island.build', function () { return SAIL.island && SAIL.island.build(scene); });

    stage('ocean');
    guard('ocean.build', function () {
      if (!SAIL.ocean || !SAIL.ocean.build) return null;
      SAIL.ocean.build(scene, renderer);
      bindOceanLayer();
      return SAIL.ocean;
    });

    stage('leopard 52');
    yacht = guard('yacht.build', function () {
      return SAIL.yacht && SAIL.yacht.build ? SAIL.yacht.build(scene) : null;
    });

    stage('sails');
    sailsMod = guard('sails.build', function () {
      var g = yacht && yacht.group;
      return (SAIL.sails && SAIL.sails.build) ? SAIL.sails.build(g) : null;
    });

    stage('physics');
    boat = guard('physics.create', function () {
      if (!SAIL.physics || !SAIL.physics.create) return null;
      return SAIL.physics.create({ x: -240, z: 96, headingDeg: 250, load: 0.42, hp: 57 });
    });
    if (boat) { boat.engineOn = false; SAIL.boat = boat; initPhysicsGuard(); }

    stage('post');
    guard('post.build', function () {
      if (!SAIL.post || !SAIL.post.build) return null;
      var d = displaySize();
      SAIL.post.displaySize.set(d.w, d.h);
      SAIL.post.build(renderer, scene, camera);
      /* A big white mainsail and a bright tropical sky drag the average key
         down; +0.5 EV over the metered value puts the water back where the
         eye expects it. */
      SAIL.post.settings.evBias = 1.45;
      tunePost();
      SAIL.post.setSize(d.w, d.h);
      return SAIL.post;
    });

    stage('instruments');
    guard('hud.build', function () { return SAIL.hud && SAIL.hud.build && SAIL.hud.build(); });

    guard('probe.gov', installProbeGovernor);
    guard('shadow.gov', tuneShadows);
    hudPeriod = (SAIL.quality === 'low') ? 1 / 30 : 0;
    wakePeriod = (SAIL.quality === 'low') ? 1 / 20 : 1 / 30;

    camera.layers.enable(0);
    camera.layers.enable(1);
    resize();
    stage('ready');
  }

  /* ---- 5.  CONTROLS ------------------------------------------------------- */
  var keys = Object.create(null);
  var ctl = {
    rudder: 0,          // commanded, degrees, + = starboard
    throttle: 0,        // -1 .. 1, both levers
    mainSheet: 0.35,
    jibSheet: 0.35,
    autoTrim: true,
    sailsUp: true,
    reef: 0,
    autoReef: true,
    navMode: 'auto',    // 'auto' | 'on' | 'off'
    deckLight: false,
    anchorDown: false,
    touchHelm: 0, touchThr: 0, touchActive: false
  };

  function notify(s, d) { if (SAIL.hud && SAIL.hud.notify) SAIL.hud.notify(s, d || 2.2); }

  function pushSheets() {
    if (!boat) return;
    if (ctl.autoTrim) { boat.autoTrim = true; }
    else { boat.setSheets(ctl.mainSheet, ctl.jibSheet); }
  }

  function onKeyDown(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var k = (e.key || '').toLowerCase();
    keys[k] = true;
    if (e.repeat) return;
    switch (k) {
      case '1': setCam('helm'); break;
      case '2': setCam('cockpit'); break;
      case '3': setCam('chase'); break;
      case '4': setCam('orbit'); break;
      case '5': setCam('masthead'); break;
      case 'x': ctl.rudder = 0; break;
      case 'p':
        ctl.sailsUp = !ctl.sailsUp;
        if (boat) boat.setSails(ctl.sailsUp);
        notify(ctl.sailsUp ? 'SAILS HOISTED' : 'SAILS STOWED');
        break;
      case 't':
        ctl.autoTrim = !ctl.autoTrim;
        if (boat && !ctl.autoTrim) { ctl.mainSheet = boat.mainSheet; ctl.jibSheet = boat.jibSheet; }
        pushSheets();
        notify(ctl.autoTrim ? 'AUTO TRIM' : 'MANUAL TRIM');
        break;
      case 'r':
        if (boat) {
          if (e.shiftKey) { ctl.reef = clamp(ctl.reef - 1, 0, 2); }
          else { ctl.reef = clamp(ctl.reef + 1, 0, 2); }
          ctl.autoReef = false; boat.setReef(ctl.reef);
          notify(ctl.reef ? 'REEF ' + ctl.reef : 'FULL MAIN');
        }
        break;
      case 'n':
        ctl.navMode = ctl.navMode === 'auto' ? 'on' : (ctl.navMode === 'on' ? 'off' : 'auto');
        notify('NAV LIGHTS ' + ctl.navMode.toUpperCase());
        break;
      case 'l': ctl.deckLight = !ctl.deckLight; break;
      case 'g': ctl.anchorDown = !ctl.anchorDown; notify(ctl.anchorDown ? 'ANCHOR DOWN' : 'ANCHOR UP'); break;
      case ',': setWeather({ hourOfDay: env.hourOfDay - 0.5 }); notify('TIME ' + clockStr()); break;
      case '.': setWeather({ hourOfDay: env.hourOfDay + 0.5 }); notify('TIME ' + clockStr()); break;
      case 'c': setWeather({ windKn: env.windKn + (e.shiftKey ? -2 : 2) }); notify('TWS ' + env.windKn.toFixed(0) + ' KN'); break;
      case 'v': camRig.fov = clamp(camRig.fov === 56 ? 34 : 56, 20, 80); break;
      default: break;
    }
  }
  function onKeyUp(e) { keys[(e.key || '').toLowerCase()] = false; }
  function clearKeys() { for (var k in keys) keys[k] = false; }

  function clockStr() {
    var h = Math.floor(env.hourOfDay), m = Math.round((env.hourOfDay - h) * 60);
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', clearKeys);

  /* ------------------------------------------------------ mouse look ---- */
  var drag = { on: false, x: 0, y: 0, id: -1 };
  function lookDelta(dx, dy) {
    var k = camRig.fov / 56 * 0.0032;
    if (camRig.external) {
      camRig.orbYaw -= dx * k * 1.6;
      camRig.orbPitch = clamp(camRig.orbPitch + dy * k * 1.6, -0.35, 1.15);
    } else {
      camRig.yaw -= dx * k;
      camRig.pitch = clamp(camRig.pitch - dy * k, -1.15, 1.05);
    }
  }
  canvas.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'touch') return;
    drag.on = true; drag.x = e.clientX; drag.y = e.clientY; drag.id = e.pointerId;
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { }
  });
  window.addEventListener('pointermove', function (e) {
    if (!drag.on || e.pointerId !== drag.id) return;
    lookDelta(e.clientX - drag.x, e.clientY - drag.y);
    drag.x = e.clientX; drag.y = e.clientY;
  });
  window.addEventListener('pointerup', function (e) {
    if (e.pointerId !== drag.id) return;
    drag.on = false; drag.id = -1;
  });
  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    if (camRig.external) camRig.dist = clamp(camRig.dist * (1 + e.deltaY * 0.0012), 9, 420);
    else camRig.fov = clamp(camRig.fov + e.deltaY * 0.03, 20, 82);
  }, { passive: false });
  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  /* ------------------------------------------------------ touch console - */
  var isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0;
  if (isTouch) document.body.classList.add('touch');

  function bindStick(el, cb) {
    if (!el) return;
    var knob = el.querySelector('i'), id = -1, cx = 0, cy = 0, R = 52;
    el.addEventListener('pointerdown', function (e) {
      id = e.pointerId;
      var r = el.getBoundingClientRect();
      cx = r.left + r.width / 2; cy = r.top + r.height / 2;
      R = Math.max(24, r.width * 0.40);
      el.setPointerCapture(id); e.preventDefault(); move(e);
    });
    el.addEventListener('pointermove', function (e) { if (e.pointerId === id) move(e); });
    function end(e) {
      if (e.pointerId !== id) return;
      id = -1; if (knob) knob.style.transform = '';
      cb(0, 0, false);
    }
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    function move(e) {
      var dx = clamp((e.clientX - cx) / R, -1, 1), dy = clamp((e.clientY - cy) / R, -1, 1);
      if (knob) knob.style.transform = 'translate(' + (dx * R) + 'px,' + (dy * R) + 'px)';
      cb(dx, dy, true);
    }
  }
  bindStick(document.getElementById('stickL'), function (dx, dy, on) {
    ctl.touchHelm = dx; ctl.touchThr = -dy; ctl.touchActive = on;
  });
  bindStick(document.getElementById('stickR'), function (dx, dy, on) {
    if (on) lookDelta(dx * 9, dy * 9);
  });
  (function () {
    var box = document.getElementById('tbtns');
    if (!box) return;
    box.addEventListener('click', function (e) {
      var a = e.target && e.target.getAttribute && e.target.getAttribute('data-act');
      if (!a) return;
      if (a === 'cam') cycleCam();
      else if (a === 'trim') { ctl.autoTrim = false; ctl.mainSheet = clamp(ctl.mainSheet - 0.08, 0, 1); ctl.jibSheet = clamp(ctl.jibSheet - 0.08, 0, 1); pushSheets(); }
      else if (a === 'ease') { ctl.autoTrim = false; ctl.mainSheet = clamp(ctl.mainSheet + 0.08, 0, 1); ctl.jibSheet = clamp(ctl.jibSheet + 0.08, 0, 1); pushSheets(); }
      else if (a === 'eng') { ctl.throttle = ctl.throttle > 0.05 ? 0 : 0.55; }
    });
  })();

  /* ---------------------------------------------------- control integrate */
  function stepControls(dt) {
    if (!boat) return;
    var want = 0;
    if (keys.a || keys.arrowleft) want -= 1;
    if (keys.d || keys.arrowright) want += 1;
    if (ctl.touchActive) want = clamp(want + ctl.touchHelm, -1, 1);

    var RMAX = 35;
    if (want !== 0) ctl.rudder = clamp(ctl.rudder + want * 46 * dt, -RMAX, RMAX);
    else ctl.rudder = approach(ctl.rudder, 0, 18, dt);   // self-centring helm
    boat.setRudder(ctl.rudder);

    var th = 0;
    if (keys.w || keys.arrowup) th += 1;
    if (keys.s || keys.arrowdown) th -= 1;
    if (ctl.touchActive && Math.abs(ctl.touchThr) > 0.2) th = clamp(th + ctl.touchThr, -1, 1);
    if (th !== 0) ctl.throttle = clamp(ctl.throttle + th * 0.55 * dt, -1, 1);
    if (keys[' ']) ctl.throttle = approach(ctl.throttle, 0, 1.4, dt);
    boat.setThrottles(ctl.throttle);

    var trimmed = false;
    if (keys['[']) { ctl.mainSheet = clamp(ctl.mainSheet - 0.30 * dt, 0, 1); trimmed = true; }
    if (keys[']']) { ctl.mainSheet = clamp(ctl.mainSheet + 0.30 * dt, 0, 1); trimmed = true; }
    if (keys[';']) { ctl.jibSheet = clamp(ctl.jibSheet - 0.30 * dt, 0, 1); trimmed = true; }
    if (keys["'"]) { ctl.jibSheet = clamp(ctl.jibSheet + 0.30 * dt, 0, 1); trimmed = true; }
    if (trimmed && ctl.autoTrim) { ctl.autoTrim = false; notify('MANUAL TRIM'); }
    if (!ctl.autoTrim) boat.setSheets(ctl.mainSheet, ctl.jibSheet);
    else { ctl.mainSheet = boat.mainSheet; ctl.jibSheet = boat.jibSheet; boat.autoTrim = true; }
    if (ctl.autoReef) boat.autoReef = true;
  }

  /* ---- 6.  CAMERA RIG ----------------------------------------------------- */
  var camRig = {
    mode: 'helm',
    external: false,
    yaw: 0, pitch: -0.03,
    orbYaw: 2.5, orbPitch: 0.22, dist: 34,
    fov: 56,
    free: null,          // { pos:Vector3, target:Vector3, fov } when a shot pins it
    smoothPos: new T.Vector3(-40, 8, 40),
    inited: false
  };
  var MODES = ['helm', 'cockpit', 'chase', 'orbit', 'masthead'];
  function setCam(m) {
    if (MODES.indexOf(m) < 0) return;
    camRig.mode = m;
    camRig.free = null;
    camRig.external = (m === 'chase' || m === 'orbit');
    /* ang = heading + orbYaw, and the rig sits at boat - (sin ang, cos ang)*d,
       so orbYaw = 0 is dead astern.  A third of a radian off the port quarter
       shows the leeward side of the rig on either tack. */
    if (m === 'chase') { camRig.orbYaw = 0.34; camRig.orbPitch = 0.20; camRig.dist = 32; }
    if (m === 'orbit') { camRig.orbPitch = 0.16; camRig.dist = 44; }
    if (!camRig.external) { camRig.yaw = 0; camRig.pitch = -0.03; }
    camRig.inited = false;
    notify('CAM ' + m.toUpperCase(), 1.3);
  }
  function cycleCam() { setCam(MODES[(MODES.indexOf(camRig.mode) + 1) % MODES.length]); }
  SAIL.setCamera = setCam;

  var _eyeP = new T.Vector3(), _eul = new T.Euler(0, 0, 0, 'YXZ');
  var _qb = new T.Quaternion(), _ql = new T.Quaternion();
  var _tgt = new T.Vector3(), _tmp = new T.Vector3();

  function boatEye(name, fx, fy, fz) {
    var P = yacht && yacht.parts;
    var o = P && P[name];
    if (o && o.getWorldPosition) { o.getWorldPosition(_eyeP); if (fin(_eyeP.x)) return _eyeP; }
    // fall back to a body-frame offset
    var h = boat ? boat.heading : 0, sh = Math.sin(h), ch = Math.cos(h);
    var wx = (boat ? boat.x : 0) + fx * ch + (-fz) * sh;
    var wz = (boat ? boat.z : 0) + fx * sh + fz * ch;
    return _eyeP.set(wx, (boat ? boat.heaveY : 0) + fy, wz);
  }

  function boatQuat(kPitch, kHeel) {
    var h = boat ? boat.heading : 0;
    var p = boat ? boat.pitchRad : 0;
    var r = boat ? boat.heelRad : 0;
    _eul.set(p * kPitch, -h, r * kHeel, 'YXZ');
    return _qb.setFromEuler(_eul);
  }

  function updateCamera(dt) {
    var d = clamp(dt, 0, 0.1);

    if (camRig.free) {
      var F = camRig.free;
      var ox = 0, oz = 0;
      if (F.rel && boat) { ox = boat.x - F.baseX; oz = boat.z - F.baseZ; }
      camera.position.set(F.pos.x + ox, F.pos.y, F.pos.z + oz);
      camera.up.set(0, 1, 0);
      _tmp.set(F.target.x + ox, F.target.y, F.target.z + oz);
      camera.lookAt(_tmp);
      if (camera.fov !== F.fov) { camera.fov = F.fov; camera.updateProjectionMatrix(); }
      camera.updateMatrixWorld(true);
      return;
    }

    if (Math.abs(camera.fov - camRig.fov) > 1e-3) {
      camera.fov = camRig.fov; camera.updateProjectionMatrix();
    }

    if (camRig.mode === 'helm' || camRig.mode === 'cockpit' || camRig.mode === 'masthead') {
      var p;
      if (camRig.mode === 'helm') p = boatEye('helmEye', -0.02, 5.36, -0.62);
      else if (camRig.mode === 'cockpit') p = boatEye('cockpitEye', -1.10, 3.12, 5.35);
      else p = boatEye('mastTop', 0, 26.0, -2.90);
      camera.position.copy(p);
      // damp the roll a little: a rigidly rolled first-person view is nauseating
      boatQuat(0.85, camRig.mode === 'masthead' ? 0.95 : 0.55);
      _eul.set(camRig.pitch, camRig.yaw, 0, 'YXZ');
      _ql.setFromEuler(_eul);
      camera.quaternion.copy(_qb).multiply(_ql);
      camera.updateMatrixWorld(true);
      return;
    }

    // ---- external rigs -------------------------------------------------
    var bx = boat ? boat.x : 0, bz = boat ? boat.z : 0;
    var by = (boat ? boat.heaveY : 0) + 3.4;
    var h = boat ? boat.heading : 0;
    var ang = (camRig.mode === 'chase') ? (h + camRig.orbYaw) : camRig.orbYaw;
    var cp = Math.cos(camRig.orbPitch);
    var wantX = bx - Math.sin(ang) * camRig.dist * cp;
    var wantZ = bz + Math.cos(ang) * camRig.dist * cp;
    var wantY = by + Math.sin(camRig.orbPitch) * camRig.dist + 2.0;

    // never let the eye drop under the sea surface
    var sea = 0;
    if (SAIL.ocean && SAIL.ocean.heightAt) {
      var s = SAIL.ocean.heightAt(wantX, wantZ, env.t);
      if (fin(s)) sea = s;
    }
    wantY = Math.max(wantY, sea + 1.6);

    if (!camRig.inited) { camRig.smoothPos.set(wantX, wantY, wantZ); camRig.inited = true; }
    var k = 1 - Math.exp(-d * (camRig.mode === 'chase' ? 4.5 : 7.0));
    camRig.smoothPos.x += (wantX - camRig.smoothPos.x) * k;
    camRig.smoothPos.y += (wantY - camRig.smoothPos.y) * k;
    camRig.smoothPos.z += (wantZ - camRig.smoothPos.z) * k;
    camera.position.copy(camRig.smoothPos);
    camera.up.set(0, 1, 0);
    _tgt.set(bx, by + 3.0, bz);
    camera.lookAt(_tgt);
    camera.updateMatrixWorld(true);
  }

  /* ---- 7.  PHYSICS: BOUNDED STEP + DIVERGENCE NET ------------------------- */
  /* The old loop handed the model whatever the browser gave it, clamped at
     100 ms. A stiff sail/rudder model integrated explicitly at h = 0.1 is
     exactly how a sim ends up with a NaN heading twenty minutes in. h is now
     capped at 1/50 s: at 60 or 120 Hz that is a single step and nothing about
     the tuning changes; a 100 ms hitch becomes five bounded steps instead of
     one wild one. */
  var PHYS_H = 1 / 50, PHYS_MAX_SUB = 6;

  var physKeys = null, physArrs = null;
  var physPrev = null, physPrevArr = null, physPrevOK = false;
  var physFaults = 0;
  var CORE = ['x', 'z', 'heading', 'u', 'v', 'r', 'heelRad', 'pitchRad', 'heaveY'];

  /* The key list is read off the live object once, so the net covers whatever
     the model actually integrates rather than a list that can drift. */
  function initPhysicsGuard() {
    physKeys = []; physArrs = [];
    for (var k in boat) {
      var v = boat[k];
      if (typeof v === 'number') physKeys.push(k);
      else if (Array.isArray(v) && (v.length === 0 || typeof v[0] === 'number')) physArrs.push(k);
    }
    physPrev = new Float64Array(physKeys.length);
    physPrevArr = [];
    for (var i = 0; i < physArrs.length; i++) physPrevArr.push(new Float64Array(boat[physArrs[i]].length));
    physSnapshot();
  }
  function physSnapshot() {
    if (!physKeys) return;
    var i, j;
    for (i = 0; i < physKeys.length; i++) physPrev[i] = boat[physKeys[i]];
    for (i = 0; i < physArrs.length; i++) {
      var src = boat[physArrs[i]], dst = physPrevArr[i];
      for (j = 0; j < dst.length; j++) dst[j] = src[j];
    }
    physPrevOK = true;
  }
  function physRestore() {
    if (!physPrevOK) return;
    var i, j;
    for (i = 0; i < physKeys.length; i++) boat[physKeys[i]] = isFinite(physPrev[i]) ? physPrev[i] : 0;
    for (i = 0; i < physArrs.length; i++) {
      var dst = boat[physArrs[i]], src = physPrevArr[i];
      for (j = 0; j < dst.length && j < src.length; j++) dst[j] = isFinite(src[j]) ? src[j] : 0;
    }
    boat.u = 0; boat.v = 0; boat.r = 0;
    boat.rollRate = 0; boat.pitchRate = 0; boat.heaveRate = 0;
  }
  /* Divergence, not just NaN: an explicit integrator always screams before it
     goes quiet, and 60 m/s of surge or 6 rad/s of yaw on a 20 t catamaran is
     the scream. Catching it here means the NaN never happens at all. */
  function physSane() {
    for (var i = 0; i < CORE.length; i++) if (!isFinite(boat[CORE[i]])) return false;
    if (Math.abs(boat.u) > 60 || Math.abs(boat.v) > 60 || Math.abs(boat.r) > 6) return false;
    if (Math.abs(boat.heelRad) > 3.2 || Math.abs(boat.pitchRad) > 3.2) return false;
    if (Math.abs(boat.heaveY) > 200) return false;
    if (Math.abs(boat.x) > 60000 || Math.abs(boat.z) > 60000) return false;
    return true;
  }

  function stepPhysics(dt) {
    if (!boat) return;
    var n = Math.ceil(dt / PHYS_H);
    if (!(n >= 1)) n = 1; else if (n > PHYS_MAX_SUB) n = PHYS_MAX_SUB;
    var h = dt / n;
    for (var i = 0; i < n; i++) {
      try { boat.step(h, env); } catch (e) { fail('physics.step', e); break; }
    }
    if (!physKeys) return;
    if (physSane()) { physSnapshot(); return; }
    physRestore();
    physFaults++;
    if (physFaults === 1 || physFaults % 60 === 0) notify('SIM RESET', 1.8);
  }
  SAIL.physFaults = function () { return physFaults; };

  /* ---- 8.  PER-FRAME SUBSYSTEM GLUE --------------------------------------- */
  var _sun = new T.Vector3(0, 1, 0);
  var wakeAcc = 0, wakePeriod = 1 / 30;
  var hudAcc = 0, hudPeriod = 0;

  function feedOcean(dt) {
    var O = SAIL.ocean;
    if (!O || !O.ready || !boat) return;
    /* The wake field is PERSISTENT state: one deposit at a non-finite position
       poisons it for the rest of the session. stepPhysics has already restored
       a sane state by now, but this costs four compares and makes that
       ordering non-load-bearing. */
    if (!(fin(boat.x) && fin(boat.z) && fin(boat.u) && fin(boat.heading))) return;

    O.setFocus(boat.x, boat.z);

    // hull shadow on the water, projected along the sun
    if (O.setHullShadow) {
      var sd = (SAIL.sky && SAIL.sky.sunDir) || _sun;
      var sy = Math.max(sd.y, 0.08);
      var lift = 1.4;
      var sx = boat.x - sd.x / sy * lift, sz = boat.z - sd.z / sy * lift;
      var sh = Math.sin(boat.heading), ch = Math.cos(boat.heading);
      var str = clamp((sd.y - 0.03) * 3.0, 0, 1) * 0.85;
      O.setHullShadow(sx, sz, 8.4, 4.5, sh, -ch, str);
    }

    // wake: one deposit per hull transom plus the bow waves, rate limited
    if (!O.addWake) return;
    wakeAcc += dt;
    if (wakeAcc < wakePeriod) return;
    wakeAcc = 0;
    var spd = Math.hypot(boat.u, boat.v);
    if (spd < 0.25) return;
    var shh = Math.sin(boat.heading), chh = Math.cos(boat.heading);
    var strength = clamp(spd / 5.5, 0, 1);
    var propWash = clamp((Math.abs(boat.thrust[0]) + Math.abs(boat.thrust[1])) / 6000, 0, 1);
    for (var s = -1; s <= 1; s += 2) {
      var yb = s * 3.005;
      // transom
      var ax = 7.6, wx = boat.x + ax * shh + yb * chh, wz = boat.z - ax * chh + yb * shh;
      O.addWake(wx, wz, clamp(strength * 0.9 + propWash * 0.5, 0, 1), 3.1);
      // bow
      ax = -7.2; wx = boat.x + ax * shh + yb * chh; wz = boat.z - ax * chh + yb * shh;
      O.addWake(wx, wz, strength * 0.55, 1.9);
    }
  }

  function feedPost() {
    var P = SAIL.post, O = SAIL.ocean;
    if (P && P.ready && O && O.setSceneTargets) {
      O.setSceneTargets(P.sceneTexture || null, P.linearDepthTexture || null);
    }
  }

  /* trim state handed to the sail module — the physics publishes the sheet
     positions it actually flew, so the cloth and the forces agree. */
  var trimState = { awaDeg: 45, awsMs: 7, mainSheet: 0.35, jibSheet: 0.35,
                    reef: 0, heelRad: 0, jibFurl: 0, autoTrim: true, sailsUp: true,
                    speedMs: 0 };
  function buildTrim() {
    if (!boat) return trimState;
    var ts = boat.trimState || {};
    trimState.awaDeg = fin(ts.awaDeg) ? ts.awaDeg : boat.awaDeg;
    trimState.awsMs = fin(ts.awsMs) ? ts.awsMs : (boat.awsKn || 0) / KN;
    trimState.mainSheet = fin(ts.mainSheet) ? ts.mainSheet : boat.mainSheet;
    trimState.jibSheet = fin(ts.jibSheet) ? ts.jibSheet : boat.jibSheet;
    trimState.reef = boat.sailsUp ? (boat.reef | 0) : 3;
    trimState.jibFurl = boat.sailsUp ? clamp(boat.jibFurl || 0, 0, 1) : 1;
    trimState.heelRad = boat.heelRad;
    trimState.autoTrim = !!boat.autoTrim;
    trimState.sailsUp = !!boat.sailsUp;
    trimState.speedMs = Math.hypot(boat.u, boat.v);
    return trimState;
  }

  /* Hoisted so toggling the sails does not mint a fresh pair of objects for
     the collector every time the P key is pressed. */
  var sailReadout = { main: {}, jib: {} };

  /* The yacht module reads a plain boolean navLights; we keep the tri-state
     (auto / on / off) here and resolve it against the clock every frame. */
  function boatViewState() {
    if (!boat) return {};
    boat.awsMs = (boat.awsKn || 0) / KN;
    boat.engineOn = Math.abs(boat.lever[0]) > 0.02 || Math.abs(boat.lever[1]) > 0.02;
    boat.navLights = (ctl.navMode === 'auto')
      ? (env.hourOfDay < 6.15 || env.hourOfDay > 18.25)
      : (ctl.navMode === 'on');
    boat.deckLight = !!ctl.deckLight;
    boat.anchorDown = !!ctl.anchorDown;

    /* Hand the HUD trim coach the rig model's own per-sail numbers so the
       instrument and the cloth cannot disagree. deltaDeg is signed by tack;
       the coach wants the magnitude. */
    var S = SAIL.sails;
    if (S && S.getAero && S.optimalDelta && boat.sailsUp) {
      var A = S.getAero(), O = S.optimalDelta(boat.awaDeg);
      if (A && A.main) {
        boat.sails = sailReadout;
        sailReadout.main.deltaDeg = Math.abs(A.main.deltaDeg || 0);
        sailReadout.main.optDeltaDeg = O.main;
        sailReadout.main.luff = A.main.luff;
        sailReadout.main.stall = A.main.stall;
        sailReadout.jib.deltaDeg = Math.abs(A.jib.deltaDeg || 0);
        sailReadout.jib.optDeltaDeg = O.jib;
        sailReadout.jib.luff = A.jib.luff;
        sailReadout.jib.stall = A.jib.stall;
      }
    } else { boat.sails = null; }
    return boat;
  }

  /* ---- 9.  FRAME LOOP ----------------------------------------------------- */
  var running = false, lastT = 0, simT = 0, started = false, inSettle = false;
  var frameMs = 16.7, frameEma = 16.7;

  SAIL.perf = {
    get ms() { return +frameEma.toFixed(2); },
    get fps() { return +(1000 / Math.max(frameEma, 0.01)).toFixed(1); },
    get renderScale() { return gov.scale; },
    get quality() { return SAIL.quality; },
    get p60() { return gov.filled >= 8 ? +govPct(0.60).toFixed(2) : null; },
    get p95() { return gov.filled >= 8 ? +govPct(0.95).toFixed(2) : null; },
    get faults() { return physFaults; },
    get draws() { return renderer.info.render.calls; },
    get passes() { return SAIL.post && SAIL.post.stats ? SAIL.post.stats.passes : 0; },
    setAdaptive: function (on) { gov.enabled = on !== false; },
    setRenderScale: setRenderScale,
    /* Feed the resolution controller a synthetic frame. The only way to prove
       the loop converges without owning six different GPUs. */
    tick: function (workMs, dt) { stepGovernor(workMs, dt || 1 / 60); return gov.scale; },
    /* A/B switch: false restores the pre-governor behaviour (shadow map and
       HUD every frame, all six probe faces in one go) so the three cadence
       decisions can be measured against the naive version on the same page,
       under the same machine load, rather than across two page loads. */
    setGovernors: function (on) {
      govOn = on !== false;
      renderer.shadowMap.autoUpdate = !govOn;
      hudPeriod = govOn ? ((SAIL.quality === 'low') ? 1 / 30 : 0) : 0;
      if (probeGov.cam && probeGov.orig) probeGov.cam.update = govOn ? probeGov.wrapped : probeGov.orig;
      forceShadow();
      return govOn;
    }
  };
  var govOn = true;

  function frame(now) {
    if (!running) return;
    requestAnimationFrame(frame);
    if (document.hidden) { lastT = 0; return; }   // never bank a hidden-tab dt
    var wall = now * 0.001;
    var dt = lastT ? clamp(wall - lastT, 0, 0.1) : 1 / 60;
    lastT = wall;
    if (!(dt > 0)) dt = 1 / 60;
    var t0 = performance.now();
    stepFrame(dt);
    frameMs = performance.now() - t0;
    frameEma += (frameMs - frameEma) * 0.08;
    stepGovernor(frameMs, dt);
  }

  function stepFrame(dt) {
    simT += dt;
    env.t = simT;
    env.dt = dt;
    env.camPos = camera.position;

    try { stepControls(dt); } catch (e) { fail('controls', e); }

    /* documented order:
       physics -> yacht -> sails -> (camera) -> ocean -> island -> sky
       -> hud -> audio -> shadow gate -> post                             */
    stepPhysics(dt);

    var view = boatViewState();
    probeGov.since += dt;
    if (yacht && yacht.update) { try { yacht.update(simT, dt, view); } catch (e) { fail('yacht.update', e); } }
    if (SAIL.sails && SAIL.sails.update) { try { SAIL.sails.update(simT, dt, buildTrim()); } catch (e) { fail('sails.update', e); } }

    try { updateCamera(dt); } catch (e) { fail('camera', e); }

    try { feedOcean(dt); } catch (e) { fail('ocean.feed', e); }
    if (SAIL.ocean && SAIL.ocean.update) { try { SAIL.ocean.update(simT, dt, camera); } catch (e) { fail('ocean.update', e); } }
    bindOceanLayer();
    if (SAIL.island && SAIL.island.update) { try { SAIL.island.update(simT, dt); } catch (e) { fail('island.update', e); } }
    if (SAIL.sky && SAIL.sky.update) { try { SAIL.sky.update(simT, dt); } catch (e) { fail('sky.update', e); } }

    /* The HUD is a full canvas2D repaint — ~2 ms, the single biggest CPU item
       after the scene submission. At 'high' it runs every frame; on a phone it
       runs at 30 Hz and is handed the ACCUMULATED dt so every needle damper
       and every notification timer stays in real time. */
    if (SAIL.hud && SAIL.hud.update) {
      hudAcc += dt;
      if (hudAcc >= hudPeriod) {
        var keepDt = env.dt;
        env.dt = hudAcc; hudAcc = 0;
        try { SAIL.hud.update(view, env); } catch (e) { fail('hud.update', e); }
        env.dt = keepDt;
      }
    }
    if (started && SAIL.audio && SAIL.audio.update) { try { SAIL.audio.update(view, env); } catch (e) { fail('audio.update', e); } }

    /* Last thing before the first renderer.render() of the frame, so the gate
       cannot be consumed by the reflection probe's cube faces. */
    stepShadowGov();

    feedPost();
    if (SAIL.post && SAIL.post.render) { try { SAIL.post.render(dt); } catch (e) { fail('post.render', e); } }
    else { renderer.render(scene, camera); }
  }
  SAIL.stepFrame = stepFrame;

  /* ---- 10.  RESIZE -------------------------------------------------------- */
  var resizeTimer = 0;
  function resize() {
    var d = displaySize();
    camera.aspect = d.w / d.h;
    camera.updateProjectionMatrix();
    /* tunePost() writes settings.renderScale*, but post latches the scale in
       applyQuality(), not in setSize() — so a rotation that changes the low
       profile's pixel-budget fit only takes effect if we force the latch. */
    tunePost();
    if (SAIL.post && SAIL.post.applyQuality) SAIL.post.applyQuality(true);
    if (SAIL.post && SAIL.post.setSize) SAIL.post.setSize(d.w, d.h);
    else renderer.setSize(d.w, d.h, false);
    if (SAIL.hud && SAIL.hud.setSize) SAIL.hud.setSize(d.w, d.h);
    if (SAIL.ocean && SAIL.ocean.setSize) {
      var r = (SAIL.post && SAIL.post.resolution) || d;
      SAIL.ocean.setSize(r.x || d.w, r.y || d.h);
    }
    forceShadow();
    // the reallocation frame is always slow; do not let it steer the governor
    gov.cool = Math.max(gov.cool, 1.5);
    govReset();
  }
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 90);
  });
  window.addEventListener('orientationchange', function () { setTimeout(resize, 260); });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { lastT = 0; gov.cool = Math.max(gov.cool, 1.5); gov.filled = 0; gov.n = 0; }
  });

  /* ---- 11.  DETERMINISTIC SCREENSHOT PRESETS ------------------------------ */
  /* Pin the camera. `rel` makes the rig track the boat's translation so a
     screenshot taken a second after the preset is framed identically. */
  function pinCam(px, py, pz, tx, ty, tz, fov, rel) {
    camRig.free = {
      pos: new T.Vector3(px, py, pz),
      target: new T.Vector3(tx, ty, tz),
      fov: fov || 52,
      rel: !!rel,
      baseX: boat ? boat.x : 0, baseZ: boat ? boat.z : 0
    };
    camRig.external = true;
  }

  /* Place the boat on a steady sailing solution taken from the physics model's
     own force balance, so the first rendered frame is already at equilibrium. */
  function setSailing(x, z, headingDeg, opts) {
    if (!boat) return;
    opts = opts || {};
    boat.reset(x, z, headingDeg);
    boat.sailsUp = opts.sailsUp !== false;
    boat.autoTrim = true;
    boat.autoReef = true;
    ctl.navMode = opts.navLights === undefined ? 'auto' : (opts.navLights ? 'on' : 'off');
    ctl.deckLight = !!opts.deckLight;
    ctl.anchorDown = !!opts.anchorDown;
    ctl.rudder = 0; ctl.throttle = 0; ctl.autoTrim = true; ctl.sailsUp = boat.sailsUp;

    if (opts.sailsUp === false) {
      boat.setSails(false);
      var th = fin(opts.throttle) ? opts.throttle : 0.5;
      ctl.throttle = th; boat.setThrottles(th);
      boat.u = 2.2;
      for (var k = 0; k < 130; k++) boat.step(1 / 60, env);   // spool the diesels
      boat.rud = 0; boat.rudCmd = 0;
      physSnapshot();
      return;
    }

    var twd = env.windDirDeg;
    var twa = wrap180(twd - headingDeg);
    var pd = null;
    if (SAIL.physics && SAIL.physics.polarDetail) {
      try { pd = SAIL.physics.polarDetail(Math.abs(twa), env.windKn); } catch (e) { pd = null; }
    }
    if (pd && fin(pd.spd) && boat.sailsUp) {
      var u = pd.spd / KN;
      var lw = fin(pd.leeway) ? pd.leeway : 0;
      boat.u = u;
      boat.v = -u * Math.tan(clamp(lw, -12, 12) * D2R) * (twa >= 0 ? 1 : -1);
      var hd = fin(pd.heelDeg) ? Math.abs(pd.heelDeg) : 0;
      boat.heelRad = (twa >= 0 ? 1 : -1) * hd * D2R;
      boat.twsAvgKn = env.windKn;
    }
    // a short settle so every derived readout (awa, rig, probes) is populated
    for (var i = 0; i < 16; i++) boat.step(1 / 60, env);
    boat.rud = 0; boat.rudCmd = 0;
    physSnapshot();
  }

  /* Bring every module up to date for the pinned state without advancing the
     simulation clock, and fast-forward the four things that are deliberately
     lagged in normal running — the ocean spectrum cross-fade, the reflection
     probe, the HUD needle damping and the post-processing eye adaptation — so
     a screenshot taken on the very next frame already shows the settled
     scene. The cadence governors are pinned wide open for the duration. */
  function settle() {
    var i;
    inSettle = true;
    var keepShadowAuto = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = true;      // every settle pass draws it
    probeGov.force = 2;                        // two full 6-face refreshes
    probeGov.done = 0; probeGov.since = 99;

    // 1. sea state: the spectrum blends over ~2.5 s; drive it home now
    if (SAIL.ocean && SAIL.ocean.update) {
      for (i = 0; i < 26; i++) SAIL.ocean.update(simT, 0.1, camera);
      bindOceanLayer();
    }
    // 2. full passes of the frame chain: the boom is servo'd toward its trim
    //    at 3.5/s, so it takes about a second of model time to arrive
    for (i = 0; i < 10; i++) {
      var view = boatViewState();
      if (yacht && yacht.update) yacht.update(simT, 0.1, view);
      if (SAIL.sails && SAIL.sails.update) SAIL.sails.update(simT, 0.1, buildTrim());
      updateCamera(0.1);
      feedOcean(0.02);
      if (SAIL.ocean && SAIL.ocean.update) SAIL.ocean.update(simT, 0.05, camera);
      if (SAIL.island && SAIL.island.update) SAIL.island.update(simT, 0.1);
      if (SAIL.sky && SAIL.sky.update) SAIL.sky.update(simT, 0.1);
    }
    bindOceanLayer();
    // 3. instruments: the needles are critically damped over a second or two
    var keepDt = env.dt, keepT = env.t;
    if (SAIL.hud && SAIL.hud.update) {
      env.dt = 0.2;
      for (i = 0; i < 16; i++) { env.t = keepT + i * 1e-4; SAIL.hud.update(boatViewState(), env); }
      env.dt = keepDt; env.t = keepT;
    }
    hudAcc = hudPeriod;                        // the next live frame repaints
    // 4. exposure: auto-adaptation has a 1.2 s / 3.0 s time constant
    feedPost();
    if (SAIL.post && SAIL.post.render) {
      for (i = 0; i < 9; i++) SAIL.post.render(0.6);
      SAIL.post.render(1 / 60);
    }
    renderer.shadowMap.autoUpdate = keepShadowAuto;
    forceShadow();
    inSettle = false;
  }

  var SHOTS = {
    /* On the flybridge helm the mainsail is right overhead: the framing that
       shows it drawing is a look out to LEEWARD, under the hardtop edge.
       yaw > 0 looks to port, yaw < 0 to starboard.                         */
    'cockpit-noon': function () {
      setWeather({ windKn: 14, windDirDeg: 75, hourOfDay: 13.0, swellM: 0.8, cloudCover: 0.30, gustFactor: 1 });
      setSailing(-830, 40, 150);                       // port tack, TWA 75
      setCam('helm');
      camRig.yaw = -0.95; camRig.pitch = 0.11; camRig.fov = 68;
    },
    'cockpit-golden': function () {
      setWeather({ windKn: 14, windDirDeg: 75, hourOfDay: 17.75, swellM: 0.9, cloudCover: 0.32, gustFactor: 1 });
      setSailing(-1020, 260, 292);                     // starboard tack, TWA 143
      setCam('helm');
      camRig.yaw = 0.62; camRig.pitch = 0.02; camRig.fov = 66;
    },
    'ocean-close': function () {
      setWeather({ windKn: 18, windDirDeg: 75, hourOfDay: 11.5, swellM: 1.3, cloudCover: 0.34, gustFactor: 1.1 });
      setSailing(-1350, -60, 205);
      // 2.5 m above the surface, looking NW away from the land so the frame is
      // nothing but sea: the crests 20 m out sit on the centre line.
      var cx = -1000, cz = 260;
      var sy = 0;
      if (SAIL.ocean && SAIL.ocean.heightAt) { var s = SAIL.ocean.heightAt(cx - 14, cz - 14, env.t); if (fin(s)) sy = s; }
      pinCam(cx, 2.5, cz, cx - 14.15, sy - 0.10, cz - 14.15, 55);
    },
    'ocean-horizon': function () {
      setWeather({ windKn: 10, windDirDeg: 75, hourOfDay: 9.5, swellM: 0.6, cloudCover: 0.40, gustFactor: 1 });
      setSailing(-1180, 480, 250);
      var cx = -1100, cz = 120;
      pinCam(cx, 12, cz, cx - 900, 11.2, cz - 240, 48);
    },
    'sails-upwind': function () {
      setWeather({ windKn: 16, windDirDeg: 75, hourOfDay: 14.5, swellM: 0.8, cloudCover: 0.28, gustFactor: 1 });
      setSailing(-900, 180, 32);
      var h = 32 * D2R;
      var fx = Math.sin(h), fz = -Math.cos(h);
      var rx = Math.cos(h), rz = Math.sin(h);
      // 3/4 view from off the port bow, 34 m out, 7 m up
      var cx = -900 + fx * 31 - rx * 17;
      var cz = 180 + fz * 31 - rz * 17;
      pinCam(cx, 7.0, cz, -900 + fx * 1.0, 10.5, 180 + fz * 1.0, 44, true);
    },
    'island-approach': function () {
      setWeather({ windKn: 15, windDirDeg: 78, hourOfDay: 16.0, swellM: 0.9, cloudCover: 0.42, gustFactor: 1 });
      setSailing(-1700, 90, 118);            // close hauled port tack, standing in
      pinCam(-1800, 30, 118, -620, 70, 66, 46, true);
    },
    /* 22:00 — motoring up the buoyed channel toward Port Louis under power,
       nav lights and steaming light burning, moon up over the island. */
    'night': function () {
      setWeather({ windKn: 11, windDirDeg: 82, hourOfDay: 22.0, swellM: 0.5, cloudCover: 0.22, gustFactor: 1 });
      setSailing(-470, 168, 62, { navLights: true, sailsUp: false, throttle: 0.5 });
      var h = 62 * D2R, fx = Math.sin(h), fz = -Math.cos(h);
      var rx = Math.cos(h), rz = Math.sin(h);
      pinCam(-470 + fx * 40 - rx * 16, 4.2, 168 + fz * 40 - rz * 16, -470, 4.0, 168, 50, true);
    }
  };

  SAIL.shot = function (name) {
    var fn = SHOTS[String(name || '').toLowerCase()];
    if (!fn) { if (window.console) console.warn('[SAIL.shot] unknown preset:', name); return false; }
    try {
      fn();
      settle();
      if (SAIL.hud && SAIL.hud.setVisible) SAIL.hud.setVisible(true);
      return true;
    } catch (e) { fail('shot:' + name, e); return false; }
  };
  SAIL.shots = Object.keys(SHOTS);

  /* ---- 12.  BOOT ---------------------------------------------------------- */
  function dismissOverlay(startAudio) {
    var ov = document.getElementById('overlay');
    if (ov && !ov.classList.contains('gone')) {
      ov.classList.add('gone');
      setTimeout(function () { if (ov.parentNode) ov.parentNode.removeChild(ov); }, 700);
    }
    if (startAudio && !started) {
      started = true;
      guard('audio.init', function () { return SAIL.audio && SAIL.audio.init && SAIL.audio.init(); });
    }
  }

  function boot() {
    build();

    // deterministic preset from the URL, applied before the first frame
    var want = (Q.shot || '').toLowerCase();
    if (want && SHOTS[want]) {
      dismissOverlay(false);
      SAIL.shot(want);
      gov.enabled = false;               // a pinned shot must not resize itself
    } else {
      // default: reaching out of the buoyed channel in the trades
      setSailing(-660, 224, 330);
      setCam('helm');
      camRig.yaw = 0.48; camRig.pitch = 0.04; camRig.fov = 66;
      settle();
    }
    if (Q.adaptive === '0') gov.enabled = false;

    /* Every program the first frames need is now linked. Leaving the link
       check on makes each later compile a synchronous GPU round trip. */
    if (Q.debug !== '1') renderer.debug.checkShaderErrors = false;

    running = true;
    lastT = 0;
    gov.cool = 3.0;
    requestAnimationFrame(frame);

    var go = document.getElementById('go');
    if (go) go.addEventListener('click', function () { dismissOverlay(true); canvas.focus(); });
    var ov = document.getElementById('overlay');
    if (ov) ov.addEventListener('pointerdown', function (e) { if (e.target === ov) dismissOverlay(true); });
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') dismissOverlay(true);
    });
    if (want) stage('shot: ' + want);
  }

  SAIL.boot = function () { guard('boot', boot); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', SAIL.boot);
  else SAIL.boot();

  SAIL.app = {
    get boat() { return boat; },
    get yacht() { return yacht; },
    ctl: ctl, cam: camRig, env: env,
    setCamera: setCam, cycleCamera: cycleCam,
    pause: function () { running = false; },
    resume: function () { if (!running) { running = true; lastT = 0; requestAnimationFrame(frame); } }
  };
})();
