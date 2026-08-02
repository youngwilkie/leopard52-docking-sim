/* ============================================================================
   yacht.js — SAIL.yacht
   Leopard 52 (Robertson & Caine) cruising catamaran, built for FIRST-PERSON
   viewing from the cockpit and the flybridge helm.

   LOA 15.75  BEAM 8.16  DRAFT 1.70  hull c/c 6.01  mast spar 23.4 m
   Model space (identical to boat_reference.js):  -Z = bow, +X = starboard,
   +Y = up, y = 0 at the designed waterline.  mesh.rotation.y = -heading.

   The four things that make this read as a photographed boat rather than a
   grey-box blockout, and which every section below is organised around:

     1. BAKED AMBIENT OCCLUSION.  The whole boat is voxelised at 12 cm and
        every vertex ray-marches that grid, so stanchion bases, winch feet,
        coaming radii and the bimini underside all carry real contact
        darkening.  Nothing else fakes "bolted through the deck" as cheaply.
     2. A BOUNCE TERM.  Downward-facing surfaces get an irradiance term
        derived from the sun/sky energy and tinted by the sun's own colour,
        because the sea and the white deck are enormous uplights.  Without
        it the bimini underside is a black quad and gelcoat stays neutral
        grey at golden hour while the sky burns amber.
     3. A LOCAL CUBE PROBE.  The sky module's PMREM is sky-only: everything
        below the horizon is black, so chrome reflects a gradient and
        nothing else.  We render our own cube probe above the cockpit at low
        frequency and PMREM it, so winches reflect deck, water and coaming.
     4. ANALYTIC WIRES.  Standing rigging and lifelines are camera-facing
        ribbons with a screen-space minimum width and alpha coverage, so
        they anti-alias analytically instead of crawling as 1-px staircases,
        and carry a Kajiya-Kay glint instead of reading as black debug lines.

   Everything is merged by material into a small number of draw calls and
   every texture is generated procedurally into a canvas at build time — no
   network, no external assets.

   Public API
     SAIL.yacht.build(scene) -> { group, parts, update }
     .update(t, dt, state)
     parts: mastTop boomEnd gooseneck forestayTack forestayHead helmEye
            cockpitEye boom wheel winches rudders props anchor lights ensign
   ========================================================================== */
(function () {
  'use strict';
  var SAIL = (window.SAIL = window.SAIL || {});
  var T = window.THREE;
  if (!T) {                                   // fail soft: never throw at load
    SAIL.yacht = { build: function () { return { group: null, parts: {}, update: function () {} }; } };
    return;
  }

  var PI = Math.PI, TAU = PI * 2;
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function LOW() { return SAIL.quality === 'low'; }

  /* Principal dimensions and the vertical layout the whole boat hangs off.
     The cockpit numbers are dimensioned off the real boat: coaming top
     0.65 m above the sole, hardtop 2.10 m clear of it, flybridge hardtop
     2.27 m clear of the flybridge sole, wheel 1.00 m diameter. */
  var S = {
    loa: 15.75, lwl: 15.31, hullBeam: 2.15, hullSep: 3.005, canoe: 1.02,
    yDeck: 1.68,        // side deck
    yCock: 1.52,        // cockpit sole (one step down)
    yNac: 0.97,         // bridgedeck underside -> 0.95 m clearance
    yRoof: 3.62,        // coachroof / cockpit hardtop
    yFly: 3.78,         // flybridge sole
    yBimini: 6.05,      // flybridge hardtop underside
    coam: 0.65,         // cockpit coaming top above the sole
    mastZ: -2.90, mastBase: 3.62, mastTop: 26.95,   // 23.33 m of spar
    goose: 6.95, boomE: 7.00,
    forestayZ: -8.15, forestayY: 2.25, forestayHeadY: 21.85,
    propZ: 6.15, rudZ: 6.95,
    /* Longitudinal stations that several sections must agree on. Getting these
       out of step is what buries the forward lounge inside the saloon. */
    zSalF: -4.30, zSalA: 2.60,        // saloon front bulkhead / aft bulkhead
    zRoofF: -4.42, zRoofA: 6.60,      // coachroof + cockpit hardtop
    zNacNose: -5.30, zNacAft: 7.00,   // bridgedeck nacelle
    zBeam: -6.95                      // forward structural crossbeam
  };
  S.hbOut = S.hullSep + S.hullBeam / 2;         // 4.08 = half beam

  /* ==========================================================================
     1.  PROCEDURAL TEXTURE FOUNDRY
     ====================================================================== */
  var ANISO = 8;
  function cvs(w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h || w; return c; }

  function hash2(x, y, p) {
    if (p) { x = ((x % p) + p) % p; y = ((y % p) + p) % p; }
    var s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return s - Math.floor(s);
  }
  function hash1(x) { var s = Math.sin(x * 91.7) * 27183.1234; return s - Math.floor(s); }
  function vn(x, y, p) {
    var ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    var u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    var a = hash2(ix, iy, p), b = hash2(ix + 1, iy, p);
    var c = hash2(ix, iy + 1, p), d = hash2(ix + 1, iy + 1, p);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  function fbm(x, y, o, p) {
    var s = 0, a = 0.5, f = 1;
    for (var i = 0; i < o; i++) { s += a * vn(x * f, y * f, p ? p * f : 0); f *= 2; a *= 0.5; }
    return s;
  }

  function mkTex(canvas, srgb, rx, ry) {
    var t = new T.CanvasTexture(canvas);
    t.wrapS = t.wrapT = T.RepeatWrapping;
    if (rx) t.repeat.set(rx, ry === undefined ? rx : ry);
    t.colorSpace = srgb ? T.SRGBColorSpace : T.LinearSRGBColorSpace;
    t.anisotropy = ANISO;
    t.needsUpdate = true;
    return t;
  }

  /* Height field -> tangent-space normal map (OpenGL convention, +G up).
     CanvasTexture has flipY = true, so canvas +y is texture -v: negating the
     canvas y-derivative gives the correct green channel. */
  function normalCanvas(size, hf, strength, sizeY) {
    var H = sizeY || size;
    var h = new Float32Array(size * H), x, y;
    for (y = 0; y < H; y++) for (x = 0; x < size; x++) h[y * size + x] = hf(x, y);
    function hAt(px, py) {
      return h[(((py % H) + H) % H) * size + (((px % size) + size) % size)];
    }
    var c = cvs(size, H), g = c.getContext('2d'), im = g.createImageData(size, H), d = im.data;
    for (y = 0; y < H; y++) for (x = 0; x < size; x++) {
      var dx = (hAt(x + 1, y) - hAt(x - 1, y)) * strength;
      var dy = (hAt(x, y + 1) - hAt(x, y - 1)) * strength;
      var nx = -dx, ny = dy, l = Math.sqrt(nx * nx + ny * ny + 1);
      var i = (y * size + x) * 4;
      d[i] = (nx / l * 0.5 + 0.5) * 255;
      d[i + 1] = (ny / l * 0.5 + 0.5) * 255;
      d[i + 2] = (1 / l * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
    g.putImageData(im, 0, 0);
    return c;
  }
  /* Single-channel canvas from a scalar field (used for roughness maps). */
  function grayCanvas(size, f, sizeY) {
    var H = sizeY || size;
    var c = cvs(size, H), g = c.getContext('2d'), im = g.createImageData(size, H), d = im.data;
    for (var y = 0; y < H; y++) for (var x = 0; x < size; x++) {
      var v = clamp(f(x, y), 0, 1) * 255, i = (y * size + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
    }
    g.putImageData(im, 0, 0);
    return c;
  }

  /* ---- laid teak ----------------------------------------------------------
     Not a stripe field.  The tile is a PLANK LAYOUT: 8 planks across a 0.5 m
     tile, each with its own grain phase, its own tone, its own roughness and
     its own butt-joint stagger, plus UV-silvering that bleaches random planks
     and a caulk line whose width breathes along its length.  A tiling stripe
     pattern reads as wallpaper the moment the eye tracks along it; the
     per-plank jitter plus the object-space wear mask in the material patch
     (see patchMat) is what breaks that up. */
  function teakFields(S2) {
    var NP = 8, pw = S2 / NP, x, y;
    var G = new Float32Array(S2 * S2);
    var ph = [], tone = [], rgh = [], slv = [], off = [], i;
    for (i = 0; i < NP; i++) {
      ph.push(hash1(i * 3.7 + 1.3) * 400);            // grain phase
      off.push(hash1(i * 9.1 + 5.7));                 // butt-joint stagger
      tone.push(0.84 + 0.20 * hash1(i * 13.3 + 2.1)); // plank-to-plank colour
      rgh.push(-0.06 + 0.16 * hash1(i * 5.9 + 8.8));  // plank-to-plank finish
      slv.push(hash1(i * 21.7 + 4.4));                // how silvered this plank is
    }
    for (y = 0; y < S2; y++) for (x = 0; x < S2; x++) {
      var pi = Math.floor(x / pw);
      G[y * S2 + x] = fbm(x * 0.42 + ph[pi], y * 0.055 + ph[pi] * 0.3, 3, 0) * 0.75 +
                      vn(x * 1.9 + ph[pi], y * 0.11, 0) * 0.25;
    }
    function seam(px, py) {                      // 0 = wood, 1 = caulk
      var fx = (px % pw) / pw;
      // the caulk swells and shrinks by a couple of mm along its length
      var w = 0.052 + 0.016 * vn(px * 0.02, py * 0.09, 0);
      return (fx < w || fx > 1 - w) ? 1 : 0;
    }
    function butt(px, py) {                      // staggered plank ends
      var pi = Math.floor(px / pw);
      var jt = ((py / S2) + off[pi]) % 1;
      return (jt < 0.006 || jt > 0.994 || Math.abs(jt - 0.5) < 0.006) ? 1 : 0;
    }
    function grain(px, py) {
      return G[(((py % S2) + S2) % S2) * S2 + (((px % S2) + S2) % S2)];
    }
    function plank(px) { return Math.floor(px / pw); }
    return { NP: NP, pw: pw, seam: seam, butt: butt, grain: grain, plank: plank,
             tone: tone, rgh: rgh, slv: slv };
  }
  function texTeak() {
    var S2 = LOW() ? 256 : 512, F = teakFields(S2);
    var c = cvs(S2), g = c.getContext('2d'), im = g.createImageData(S2, S2), d = im.data;
    for (var y = 0; y < S2; y++) for (var x = 0; x < S2; x++) {
      var pi = F.plank(x);
      var sm = F.seam(x, y), bt = F.butt(x, y), gr = F.grain(x, y);
      /* Albedo calibrated against a photograph of a laid deck in open shade:
         oiled teak sits around sRGB 165/138/100 and holystoned teak silvers
         to a warm grey near 185/180/166.  Anything below ~120 crushes to
         black the moment the deck is under a hardtop, which is exactly the
         "solid dark ribbon" failure. */
      var l = (0.66 + 0.40 * gr) * F.tone[pi];
      var r = l * 232, gg = l * 196, b = l * 148;
      // UV silvering: sun-bleached planks lose the red and gain grey
      var sv = F.slv[pi] * clamp(gr * 1.3, 0, 1) * 0.62;
      r = lerp(r, 196, sv); gg = lerp(gg, 191, sv); b = lerp(b, 176, sv);
      // traffic lanes: the centre of the tile walks greyer than the edges
      var lane = Math.exp(-Math.pow((x / S2 - 0.5) / 0.34, 2)) * 0.32;
      r = lerp(r, 190, lane); gg = lerp(gg, 186, lane); b = lerp(b, 172, lane);
      if (bt) { r *= 0.46; gg *= 0.46; b *= 0.48; }
      if (sm) { r = 26; gg = 24; b = 22; }
      var i = (y * S2 + x) * 4;
      d[i] = r; d[i + 1] = gg; d[i + 2] = b; d[i + 3] = 255;
    }
    g.putImageData(im, 0, 0);
    var alb = mkTex(c, true);
    var rgh = mkTex(grayCanvas(S2, function (x, y) {
      if (F.seam(x, y)) return 0.92;
      return clamp(0.40 + 0.14 * F.grain(x, y) + F.rgh[F.plank(x)], 0.15, 1);
    }), false);
    var nrm = mkTex(normalCanvas(S2, function (x, y) {
      return -F.seam(x, y) * 1.0 - F.butt(x, y) * 0.45 + F.grain(x, y) * 0.14;
    }, 2.4), false);
    return { map: alb, rough: rgh, normal: nrm };
  }

  /* ---- moulded diamond non-skid ------------------------------------------ */
  function texNonskid() {
    var S2 = 256;
    function pat(x, y) {                      // raised diamond lozenges
      var u = x / S2 * 12, v = y / S2 * 12;
      var a = Math.abs(((u + v) % 1) - 0.5), b = Math.abs(((u - v) % 1) - 0.5);
      var m = clamp((0.34 - Math.max(a, b)) * 7.5, 0, 1);
      return m * (0.85 + 0.15 * vn(x * 0.6, y * 0.6, 0));
    }
    // dirt collects in the VALLEYS between the diamonds, not on their tops
    var alb = mkTex(grayCanvas(S2, function (x, y) {
      var p = pat(x, y);
      return 0.62 + 0.16 * p + 0.05 * vn(x * 0.9, y * 0.9, 0) - 0.10 * (1 - p) * vn(x * 0.25, y * 0.25, 0);
    }), true);
    var rgh = mkTex(grayCanvas(S2, function (x, y) { return 0.78 - 0.18 * pat(x, y); }), false);
    var nrm = mkTex(normalCanvas(S2, pat, 3.2), false);
    return { map: alb, rough: rgh, normal: nrm };
  }

  /* ---- Sunbrella-style canvas weave (stackpack, bimini liner, sprayhood) -- */
  function texWeave(r, g0, b0) {
    var S2 = 256;
    function weave(x, y) {
      var u = x / S2 * 48, v = y / S2 * 48;
      var over = (Math.floor(u) + Math.floor(v)) % 2;
      var wu = Math.sin((u % 1) * PI), wv = Math.sin((v % 1) * PI);
      return over ? wu * 0.9 : wv * 0.9;
    }
    var c = cvs(S2), gx = c.getContext('2d'), im = gx.createImageData(S2, S2), d = im.data;
    for (var y = 0; y < S2; y++) for (var x = 0; x < S2; x++) {
      var w = 0.72 + 0.28 * weave(x, y);
      // UV chalking: the canvas fades unevenly in big soft patches
      var sl = 0.92 + 0.13 * vn(x * 0.7, y * 0.7, 0) + 0.10 * fbm(x * 0.035, y * 0.035, 2, 0);
      var i = (y * S2 + x) * 4;
      d[i] = r * w * sl; d[i + 1] = g0 * w * sl; d[i + 2] = b0 * w * sl; d[i + 3] = 255;
    }
    gx.putImageData(im, 0, 0);
    return {
      map: mkTex(c, true),
      rough: mkTex(grayCanvas(S2, function (x, y) {
        return 0.80 - 0.08 * weave(x, y) + 0.10 * fbm(x * 0.04, y * 0.04, 2, 0);
      }), false),
      normal: mkTex(normalCanvas(S2, weave, 1.5), false)
    };
  }

  /* ---- Sunbrella cushion: two panels per 0.9 m tile, welted seams, stitch
     rows and a real woven micro-structure.  The tile is sized in metres by
     boxUV() at build time, so a 2.6 m sunbed and a 1.2 m helm seat both come
     out with 0.45 m panels instead of the cushion pattern stretching. ------ */
  function texCushion() {
    var S2 = 256, NPAN = 2;
    function seamD(x, y) {                   // signed distance to the nearest welt
      var u = (x / S2 * NPAN) % 1, v = (y / S2 * NPAN) % 1;
      return Math.max(Math.abs(u - 0.5), Math.abs(v - 0.5));
    }
    function panel(x, y) {                   // 1 inside a panel, 0 on the seam
      var seam = clamp((0.452 - seamD(x, y)) * 24, 0, 1);
      return seam * seam * (3 - 2 * seam);
    }
    function welt(x, y) {                    // the piping cord itself: a raised bead
      var t = Math.abs(seamD(x, y) - 0.478);
      return t < 0.014 ? Math.cos(t / 0.014 * PI * 0.5) : 0;
    }
    function stitch(x, y) {
      var u = (x / S2 * NPAN) % 1, v = (y / S2 * NPAN) % 1;
      var onU = Math.abs(Math.abs(u - 0.5) - 0.432) < 0.008;
      var onV = Math.abs(Math.abs(v - 0.5) - 0.432) < 0.008;
      var dash = (Math.floor((onU ? y : x) / 4) % 2) === 0;
      return (onU || onV) && dash ? 1 : 0;
    }
    // acrylic canvas: a 2-over-2 basket weave, ~1 mm per thread at tile scale
    function weave(x, y) {
      var u = x / S2 * 86, v = y / S2 * 86;
      var over = ((Math.floor(u * 0.5) + Math.floor(v * 0.5)) % 2) === 0;
      var t = over ? Math.sin((u % 1) * PI) : Math.sin((v % 1) * PI);
      return 0.55 + 0.45 * t;
    }
    var c = cvs(S2), g = c.getContext('2d'), im = g.createImageData(S2, S2), d = im.data;
    for (var y = 0; y < S2; y++) for (var x = 0; x < S2; x++) {
      var p = panel(x, y), st = stitch(x, y), wl = welt(x, y), wv = weave(x, y);
      // heather: two yarn colours plied together, which is what stops
      // Sunbrella reading as flat vinyl
      var hz = vn(x * 1.7, y * 1.7, 0);
      var l = (0.74 + 0.13 * p) * (0.88 + 0.16 * wv) * (0.95 + 0.09 * hz);
      l += wl * 0.06;
      var r = l * 226, gg = l * 219, b = l * 199;
      if (st) { r *= 0.78; gg *= 0.76; b *= 0.72; }
      var i = (y * S2 + x) * 4;
      d[i] = r; d[i + 1] = gg; d[i + 2] = b; d[i + 3] = 255;
    }
    g.putImageData(im, 0, 0);
    return {
      map: mkTex(c, true),
      rough: mkTex(grayCanvas(S2, function (x, y) {
        return 0.78 - 0.09 * panel(x, y) - 0.10 * welt(x, y) + 0.06 * weave(x, y);
      }), false),
      normal: mkTex(normalCanvas(S2, function (x, y) {
        return panel(x, y) * 0.85 + welt(x, y) * 0.55 - stitch(x, y) * 0.35
             + weave(x, y) * 0.10;
      }, 2.2), false)
    };
  }

  /* ---- winch drum ---------------------------------------------------------
     U runs around the drum, V up it.  Vertical ribbing, circumferential
     brushing in the roughness, and a POLISHED BAND two thirds of the way up
     where the rope rides — the single most recognisable piece of wear on a
     winch, and the thing that stops it reading as a chrome ball. */
  function texWinch() {
    var W = 256, H = 64;
    function rib(x) { var u = x / W * 40; return Math.abs((u % 1) - 0.5) < 0.22 ? 1 : 0; }
    var c = cvs(W, H), g = c.getContext('2d'), im = g.createImageData(W, H), dd = im.data;
    for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
      var dx = (rib((x + 1) % W) - rib((x - 1 + W) % W)) * 3.0;
      var nx = -dx, l = Math.sqrt(nx * nx + 1), i = (y * W + x) * 4;
      dd[i] = (nx / l * 0.5 + 0.5) * 255; dd[i + 1] = 128; dd[i + 2] = (1 / l * 0.5 + 0.5) * 255; dd[i + 3] = 255;
    }
    g.putImageData(im, 0, 0);
    var rgh = grayCanvas(W, function (x, y) {
      var v = y / H;
      var polish = Math.exp(-Math.pow((v - 0.62) / 0.16, 2)) * 0.16;
      return 0.24 + 0.18 * vn(x * 0.06, y * 3.4, 0) + 0.05 * vn(x * 0.4, y * 9.0, 0) - polish;
    }, H);
    var alb = grayCanvas(W, function (x, y) {
      var v = y / H;
      var polish = Math.exp(-Math.pow((v - 0.62) / 0.16, 2)) * 0.10;
      return 0.74 + polish + 0.04 * vn(x * 0.06, y * 3.4, 0);
    }, H);
    return { normal: mkTex(c, false), rough: mkTex(rgh, false), map: mkTex(alb, true) };
  }

  /* ---- trampoline netting (alpha-tested lattice) --------------------------
     The cords must stay BOLD relative to the tile: a physically thin lattice
     averages away in the mip chain and then the alpha test erases the whole
     tramp at any distance. */
  function texNet() {
    var S2 = 128, c = cvs(S2), g = c.getContext('2d');
    g.clearRect(0, 0, S2, S2);
    g.lineCap = 'round';
    for (var k = 0; k < 2; k++) {
      g.lineWidth = k ? 11 : 15;
      g.strokeStyle = k ? '#8d99a1' : '#4b565d';
      for (var i = -1; i <= 3; i++) {
        var p = i * (S2 / 2) + (k ? 2.0 : 0);
        g.beginPath(); g.moveTo(p, -10); g.lineTo(p + S2 / 2, S2 + 10); g.stroke();
        g.beginPath(); g.moveTo(p, S2 + 10); g.lineTo(p + S2 / 2, -10); g.stroke();
      }
    }
    return { map: mkTex(c, true) };
  }

  /* ---- three-strand rope (helical lay) ------------------------------------ */
  function texRope(r, g0, b0) {
    var S2 = 64;
    function lay(x, y) { return Math.sin((x / S2 * 3 + y / S2 * 6) * TAU) * 0.5 + 0.5; }
    var c = cvs(S2), g = c.getContext('2d'), im = g.createImageData(S2, S2), d = im.data;
    for (var y = 0; y < S2; y++) for (var x = 0; x < S2; x++) {
      var l = 0.62 + 0.38 * lay(x, y), i = (y * S2 + x) * 4;
      d[i] = r * l; d[i + 1] = g0 * l; d[i + 2] = b0 * l; d[i + 3] = 255;
    }
    g.putImageData(im, 0, 0);
    return { map: mkTex(c, true), normal: mkTex(normalCanvas(S2, lay, 1.6), false) };
  }

  /* ---- wheel-rim leather: pebble grain + a spine of hand stitching -------- */
  function texLeather() {
    var S2 = 256, PB = new Float32Array(S2 * S2), x, y;
    for (y = 0; y < S2; y++) for (x = 0; x < S2; x++) PB[y * S2 + x] = fbm(x * 0.11, y * 0.11, 3, 0);
    function pebble(px, py) { return PB[(((py % S2) + S2) % S2) * S2 + (((px % S2) + S2) % S2)]; }
    function stitchLine(x, y) {
      var v = (y / S2 * 8) % 1;
      var on = Math.abs(v - 0.5) < 0.06 && (Math.floor(x / 7) % 2) === 0;
      return on ? 1 : 0;
    }
    var c = cvs(S2), g = c.getContext('2d'), im = g.createImageData(S2, S2), d = im.data;
    for (y = 0; y < S2; y++) for (x = 0; x < S2; x++) {
      var p = pebble(x, y), st = stitchLine(x, y);
      var l = 0.60 + 0.36 * p, i = (y * S2 + x) * 4;
      var r = l * 148, gg = l * 112, b = l * 84;
      if (st) { r = 214; gg = 196; b = 158; }
      d[i] = r; d[i + 1] = gg; d[i + 2] = b; d[i + 3] = 255;
    }
    g.putImageData(im, 0, 0);
    return {
      map: mkTex(c, true),
      rough: mkTex(grayCanvas(S2, function (x, y) { return 0.62 - 0.14 * pebble(x, y); }), false),
      normal: mkTex(normalCanvas(S2, function (x, y) {
        return pebble(x, y) * 0.8 - stitchLine(x, y) * 0.9;
      }, 2.6), false)
    };
  }

  /* ---- anodised spar ------------------------------------------------------
     U runs around the section, V up it.  An extruded mast is not a smooth
     tube: it has hard specular corners, a matte face between them, rivet
     lines down the sail track and the halyard exits, and the anodising
     brushes vertically.  The section itself is real geometry (see sparGeom);
     this supplies the fine detail that sells it as metal. */
  function texMast() {
    var W = 256, H = 512;
    function brush(x, y) { return vn(x * 3.1, y * 0.05, 0); }
    function rivet(x, y) {
      // two rivet columns either side of the track, one every 90 mm
      var col = Math.abs(((x / W) % 1) - 0.5);
      var near = Math.abs(col - 0.055) < 0.012 || Math.abs(col - 0.115) < 0.012;
      if (!near) return 0;
      var v = (y / H * 40) % 1;
      var dv = Math.abs(v - 0.5);
      return dv < 0.16 ? Math.cos(dv / 0.16 * PI * 0.5) : 0;
    }
    function scuff(x, y) { return fbm(x * 0.09, y * 0.02, 3, 0); }
    return {
      rough: mkTex(grayCanvas(W, function (x, y) {
        return clamp(0.24 + 0.12 * brush(x, y) + 0.14 * scuff(x, y) - 0.05 * rivet(x, y), 0.06, 1);
      }, H), false),
      map: mkTex(grayCanvas(W, function (x, y) {
        return clamp(0.70 + 0.06 * brush(x, y) - 0.10 * scuff(x, y) + 0.10 * rivet(x, y), 0, 1);
      }, H), true),
      normal: mkTex(normalCanvas(W, function (x, y) {
        return brush(x, y) * 0.10 + rivet(x, y) * 0.55;
      }, 2.6, H), false)
    };
  }

  /* ---- gelcoat orange-peel (very subtle, but it kills the CG plastic look) */
  function texGel() {
    var S2 = 128;
    return mkTex(normalCanvas(S2, function (x, y) {
      return fbm(x * 0.18, y * 0.18, 3, 0) * 0.6 + vn(x * 1.1, y * 1.1, 0) * 0.4;
    }, 0.55), false);
  }

  /* ---- chartplotter screen -------------------------------------------------
     Rendered at 512x320 for a 0.60 x 0.38 m screen, so the type comes out at
     real signage size (~15 mm caps).  The old 256-wide version put 40 mm
     characters on a chartplotter and single-handedly destroyed the sense of
     scale in the helm view. */
  function texScreen() {
    var W = 512, H = 320, c = cvs(W, H), g = c.getContext('2d');
    g.fillStyle = '#0d2f4a'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#1d6f9c';
    g.beginPath(); g.moveTo(0, H); g.lineTo(0, 192); g.quadraticCurveTo(140, 156, 256, 208);
    g.quadraticCurveTo(380, 256, W, 200); g.lineTo(W, H); g.closePath(); g.fill();
    g.fillStyle = '#d9c98a';
    g.beginPath(); g.moveTo(0, H); g.lineTo(0, 252); g.quadraticCurveTo(192, 232, W, 268);
    g.lineTo(W, H); g.closePath(); g.fill();
    g.strokeStyle = 'rgba(150,200,230,.30)'; g.lineWidth = 1;
    for (var i = 1; i < 12; i++) {
      g.beginPath(); g.moveTo(i * W / 12, 0); g.lineTo(i * W / 12, H); g.stroke();
      g.beginPath(); g.moveTo(0, i * H / 12); g.lineTo(W, i * H / 12); g.stroke();
    }
    // depth soundings scattered over the shoal
    g.font = '9px monospace'; g.fillStyle = 'rgba(200,232,248,.75)';
    for (i = 0; i < 22; i++) {
      var sx = 20 + hash1(i * 2.7) * (W - 40), sy = 150 + hash1(i * 5.1 + 9) * 120;
      g.fillText((2 + Math.floor(hash1(i * 7.3) * 26)).toString(), sx, sy);
    }
    g.strokeStyle = '#ff4d4d'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(256, 300); g.lineTo(256, 60); g.stroke();
    g.fillStyle = '#ffffff';
    g.beginPath(); g.moveTo(256, 124); g.lineTo(244, 168); g.lineTo(268, 168); g.closePath(); g.fill();
    g.font = 'bold 13px monospace'; g.fillStyle = '#c8f0ff';
    g.fillText('SOG  8.4 kn', 10, 20); g.fillText('DPT  11.6 m', 10, 38);
    g.fillText('COG 284', 400, 20); g.fillText('1.5 nm', 400, 38);
    return mkTex(c, true);
  }

  /* ---- instrument dial (wind / speed pod) ---------------------------------
     Its own face, at its own scale.  Mapping the chartplotter texture onto a
     104 mm dial was what put 40 mm lettering next to 20 mm fittings. */
  function texDial() {
    var W = 128, c = cvs(W), g = c.getContext('2d'), i;
    g.fillStyle = '#0a1620'; g.fillRect(0, 0, W, W);
    g.strokeStyle = '#8fb7cc'; g.lineWidth = 1.6;
    for (i = 0; i < 36; i++) {
      var a = i / 36 * TAU, ln = (i % 3 === 0) ? 11 : 6;
      g.beginPath();
      g.moveTo(64 + Math.sin(a) * 56, 64 - Math.cos(a) * 56);
      g.lineTo(64 + Math.sin(a) * (56 - ln), 64 - Math.cos(a) * (56 - ln));
      g.stroke();
    }
    g.strokeStyle = '#1e6f4a'; g.lineWidth = 5;
    g.beginPath(); g.arc(64, 64, 47, -1.15, 0.35); g.stroke();
    g.fillStyle = '#d8ecf6'; g.font = 'bold 20px monospace';
    g.textAlign = 'center'; g.fillText('7.9', 64, 60);
    g.font = '8px monospace'; g.fillStyle = '#7fa4b8';
    g.fillText('AWS kn', 64, 76); g.fillText('APP', 64, 96);
    g.strokeStyle = '#ff5a3c'; g.lineWidth = 2.6;
    g.beginPath(); g.moveTo(64, 64); g.lineTo(64 + Math.sin(-0.9) * 50, 64 - Math.cos(-0.9) * 50); g.stroke();
    g.fillStyle = '#c9d6dc'; g.beginPath(); g.arc(64, 64, 4, 0, TAU); g.fill();
    return mkTex(c, true);
  }

  /* ---- Grenadian ensign --------------------------------------------------- */
  function texFlag() {
    var W = 128, H = 78, c = cvs(W, H), g = c.getContext('2d'), i;
    g.fillStyle = '#ce1126'; g.fillRect(0, 0, W, H);
    var b = 11;
    g.fillStyle = '#fcd116';
    g.beginPath(); g.moveTo(b, b); g.lineTo(W - b, b); g.lineTo(W / 2, H / 2); g.closePath(); g.fill();
    g.beginPath(); g.moveTo(b, H - b); g.lineTo(W - b, H - b); g.lineTo(W / 2, H / 2); g.closePath(); g.fill();
    g.fillStyle = '#007a5e';
    g.beginPath(); g.moveTo(b, b); g.lineTo(b, H - b); g.lineTo(W / 2, H / 2); g.closePath(); g.fill();
    g.beginPath(); g.moveTo(W - b, b); g.lineTo(W - b, H - b); g.lineTo(W / 2, H / 2); g.closePath(); g.fill();
    function star(cx, cy, r, col) {
      g.fillStyle = col; g.beginPath();
      for (var k = 0; k < 10; k++) {
        var a = -PI / 2 + k * PI / 5, rr = k % 2 ? r * 0.42 : r;
        g[k ? 'lineTo' : 'moveTo'](cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
      }
      g.closePath(); g.fill();
    }
    g.fillStyle = '#ce1126'; g.beginPath(); g.arc(W / 2, H / 2, 11, 0, TAU); g.fill();
    star(W / 2, H / 2, 8, '#fcd116');
    for (i = 0; i < 3; i++) star(W * (0.28 + i * 0.22), b / 2 + 1, 5, '#fcd116');
    for (i = 0; i < 3; i++) star(W * (0.28 + i * 0.22), H - b / 2 - 1, 5, '#fcd116');
    g.fillStyle = '#007a5e'; g.beginPath(); g.ellipse(24, H / 2, 8, 10, 0, 0, TAU); g.fill();
    g.fillStyle = '#ce1126'; g.beginPath(); g.ellipse(24, H / 2 + 2, 5, 6, 0, 0, TAU); g.fill();
    return mkTex(c, true);
  }
  /* ==========================================================================
     2.  MATERIAL PATCH — baked AO, bounce irradiance, grime
     --------------------------------------------------------------------------
     Every yacht material runs through patchMat().  Three things get injected:

       aAO       a per-vertex baked occlusion factor (see the AO baker) that
                 multiplies INDIRECT light only — never the direct sun, which
                 would darken lit faces and look like dirt.
       bounce    an irradiance term for downward-facing normals.  The sea and
                 the white deck are enormous uplights; without this the bimini
                 underside is a black quad and gelcoat holds the same neutral
                 grey at 17:45 that it held at noon.  Driven from the sun/sky
                 energies and tinted by the sun's own colour, so golden hour
                 actually reaches the boat.
       grime     object-space (boat-fixed, so it never swims) low-frequency
                 dirt, salt bloom and roughness variance.  Uniform colour and
                 uniform roughness across a large panel is the single most
                 reliable synthetic-asset tell.
     ====================================================================== */
  var UNI = {
    uBounceDn: { value: new T.Vector3(0.2, 0.24, 0.26) },
    uBounceUp: { value: new T.Vector3(0.0, 0.0, 0.0) },
    /* The single most important term for a covered cockpit.  A hardtop stops
       the sky but not the sea: three metres of open side on each hand look
       straight out at a horizon whose radiance is the brightest thing in the
       hemisphere.  Without a lateral irradiance term every surface under the
       hardtop collapses to the same near-black value, which is precisely the
       "flat primitives in shade" failure. */
    uBounceSide: { value: new T.Vector3(0.0, 0.0, 0.0) },
    uGrime: { value: 1.0 }
  };

  var GLSL_NOISE = [
    'float yhash(vec3 p){ p=fract(p*0.3183099+vec3(0.71,0.113,0.419)); p*=17.0;',
    '  return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }',
    'float ynoise(vec3 x){ vec3 i=floor(x), f=fract(x); f=f*f*(3.0-2.0*f);',
    '  return mix(mix(mix(yhash(i),yhash(i+vec3(1,0,0)),f.x),',
    '                 mix(yhash(i+vec3(0,1,0)),yhash(i+vec3(1,1,0)),f.x),f.y),',
    '             mix(mix(yhash(i+vec3(0,0,1)),yhash(i+vec3(1,0,1)),f.x),',
    '                 mix(yhash(i+vec3(0,1,1)),yhash(i+vec3(1,1,1)),f.x),f.y),f.z); }',
    'float yfbm(vec3 p){ return ynoise(p)*0.57+ynoise(p*2.17)*0.29+ynoise(p*5.31)*0.14; }'
  ].join('\n');

  /* patchMat(mat, opts)
       opts.grime  0..1  how much dirt/salt this surface accumulates
       opts.salt   0..1  salt bloom weight (topsides want it, teak does not)
       opts.rvar   roughness variance amplitude                           */
  function patchMat(mat, opts) {
    if (!mat || mat.__yPatched) return mat;
    mat.__yPatched = true;
    var o = opts || {};
    var kG = o.grime === undefined ? 1.0 : o.grime;
    var kS = o.salt === undefined ? 0.55 : o.salt;
    var kR = o.rvar === undefined ? 0.13 : o.rvar;
    // if a mesh has no aAO attribute the GL default would be 0 (= fully
    // occluded = black).  This makes the default 1 instead: fail bright.
    mat.defaultAttributeValues = mat.defaultAttributeValues || {};
    mat.defaultAttributeValues.aAO = new Float32Array([1]);
    var prevOBC = mat.onBeforeCompile;
    mat.onBeforeCompile = function (sh) {
      if (prevOBC) { try { prevOBC.call(mat, sh); } catch (e) { } }
      sh.uniforms.uBounceDn = UNI.uBounceDn;
      sh.uniforms.uBounceUp = UNI.uBounceUp;
      sh.uniforms.uBounceSide = UNI.uBounceSide;
      sh.uniforms.uGrime = UNI.uGrime;

      sh.vertexShader = sh.vertexShader
        .replace('void main() {',
          'attribute float aAO;\nvarying float vAO;\nvarying vec3 vMP;\nvarying vec3 vON;\nvoid main() {')
        .replace('#include <begin_vertex>',
          '#include <begin_vertex>\n  vAO = aAO; vMP = transformed; vON = normalize(objectNormal);');

      sh.fragmentShader = sh.fragmentShader
        .replace('void main() {',
          'uniform vec3 uBounceDn;\nuniform vec3 uBounceUp;\nuniform vec3 uBounceSide;\n' +
          'uniform float uGrime;\n' +
          'varying float vAO;\nvarying vec3 vMP;\nvarying vec3 vON;\n' + GLSL_NOISE +
          '\nfloat yDirt, yWear;\nvoid main() {')
        /* --- grime, salt and large-scale value break-up ------------------ */
        .replace('#include <map_fragment>', [
          '#include <map_fragment>',
          '  {',
          '    float gUp  = clamp(vON.y, 0.0, 1.0);',
          '    float cav  = 1.0 - clamp(vAO, 0.0, 1.0);',
          '    float n1   = yfbm(vMP * 1.45);',
          '    float n2   = yfbm(vMP * 0.33 + 4.0);',
          '    yWear      = n2;',
          '    yDirt      = clamp((n1 * 0.62 + n2 * 0.58 - 0.30) * (0.30 + 1.0 * gUp)',
          '                        + cav * 0.50, 0.0, 1.0) * uGrime * ' + kG.toFixed(3) + ';',
          '    diffuseColor.rgb *= mix(vec3(1.0), vec3(0.66, 0.645, 0.585), yDirt * 0.40);',
          '    diffuseColor.rgb *= (0.925 + 0.155 * n2);',
          '    float salt = clamp((yfbm(vMP * 0.85 + 19.0) - 0.36) * 2.6, 0.0, 1.0)',
          '               * smoothstep(0.25, 0.85, vMP.y) * (1.0 - gUp * 0.55)',
          '               * uGrime * ' + kS.toFixed(3) + ';',
          '    diffuseColor.rgb = mix(diffuseColor.rgb,',
          '                           diffuseColor.rgb * 0.88 + vec3(0.115, 0.120, 0.118), salt);',
          '    yDirt = max(yDirt, salt * 0.5);',
          '  }'
        ].join('\n'))
        .replace('#include <roughnessmap_fragment>', [
          '#include <roughnessmap_fragment>',
          '  roughnessFactor = clamp(roughnessFactor + (yWear - 0.5) * ' + kR.toFixed(3),
          '                          + yDirt * 0.26, 0.015, 1.0);'
        ].join('\n'))
        /* --- baked AO on indirect only, then the bounce ------------------- */
        .replace('#include <aomap_fragment>', [
          '#include <aomap_fragment>',
          '  {',
          '    float bAO = clamp(vAO, 0.0, 1.0);',
          /* The baked term is a closed-hemisphere estimate, so it over-darkens
             anything that is roofed but open at the sides. Keep it at full
             strength as a CONTACT term by squaring the crevice component, but
             blend the broad component back toward 1 so the cockpit does not
             go to ink. */
          '    float contact = bAO * bAO * (3.0 - 2.0 * bAO);',
          '    reflectedLight.indirectDiffuse  *= mix(0.42, 1.0, contact);',
          '    reflectedLight.indirectSpecular *= mix(0.52, 1.0, contact);',
          '    float dn = clamp(-vON.y, 0.0, 1.0);',
          '    float up = clamp( vON.y, 0.0, 1.0);',
          '    float sd = 1.0 - abs(vON.y);',
          /* An overhead panel is uplit by the sea, and the sea it can see grows
             as you move outboard from the centreline toward the open edge —
             the gradient that keeps a hardtop underside from reading as one
             dead value across two metres. */
          '    float outb = 0.62 + 0.68 * smoothstep(0.0, 3.05, abs(vMP.x));',
          '    vec3 bounce = uBounceDn * (dn * outb) + uBounceUp * up',
          '                + uBounceSide * sd;',
          '    reflectedLight.indirectDiffuse += material.diffuseColor * bounce',
          '                                    * RECIPROCAL_PI * mix(0.66, 1.0, contact);',
          '  }'
        ].join('\n'));
    };
    mat.customProgramCacheKey = function () { return 'ypatch' + kG + '_' + kS + '_' + kR; };
    return mat;
  }

  /* ==========================================================================
     3.  MATERIALS
     ====================================================================== */
  var TX = null, M = null, HS = null;

  function buildTextures() {
    if (TX) return TX;
    TX = {
      teak: texTeak(), nonskid: texNonskid(), navy: texWeave(34, 46, 62),
      cream: texWeave(196, 190, 172), liner: texWeave(158, 163, 164),
      cushion: texCushion(), winch: texWinch(),
      net: texNet(), rope: texRope(226, 226, 222), sheet: texRope(58, 74, 96),
      leather: texLeather(), mast: texMast(), gel: texGel(),
      screen: texScreen(), dial: texDial(), flag: texFlag()
    };
    return TX;
  }

  function pbr(o, patch) { return patchMat(new T.MeshPhysicalMaterial(o), patch); }

  /* A metalness-1.0 surface with no environment to reflect renders BLACK —
     so if SAIL.sky has not published its PMREM yet, every winch, stanchion
     and shroud on the boat would be a silhouette. This equirect stand-in
     costs 8 kB and is swapped out by syncEnv() the moment a real probe
     appears. Never let the rig depend on another module's timing. */
  var _fallbackEnv = null;
  function fallbackEnv() {
    if (_fallbackEnv) return _fallbackEnv;
    var c = cvs(256, 128), g = c.getContext('2d');
    var grd = g.createLinearGradient(0, 0, 0, 128);
    grd.addColorStop(0.00, '#5f9fdc');
    grd.addColorStop(0.42, '#a8cbe6');
    grd.addColorStop(0.495, '#dbe8ee');
    grd.addColorStop(0.505, '#2b6982');
    grd.addColorStop(1.00, '#0d3547');
    g.fillStyle = grd; g.fillRect(0, 0, 256, 128);
    var sg = g.createRadialGradient(78, 34, 0, 78, 34, 26);
    sg.addColorStop(0, 'rgba(255,252,238,1)');
    sg.addColorStop(1, 'rgba(255,252,238,0)');
    g.fillStyle = sg; g.fillRect(52, 8, 52, 52);
    _fallbackEnv = new T.CanvasTexture(c);
    _fallbackEnv.mapping = T.EquirectangularReflectionMapping;
    _fallbackEnv.colorSpace = T.SRGBColorSpace;
    _fallbackEnv.needsUpdate = true;
    return _fallbackEnv;
  }

  function buildMaterials() {
    if (M) return M;
    var X = buildTextures();
    var env = (SAIL.sky && SAIL.sky.envMap) || fallbackEnv();
    /* Orange peel is a 1-3 mm phenomenon.  At six tiles across a box face it
       lands at ~0.3 m and reads as dents in the moulding rather than as the
       flake in the gelcoat, so the sky reflection stays mirror-smooth and the
       surface reads as painted foam board.  Twenty-eight puts it at the right
       physical scale on every panel from a locker lid to the coachroof. */
    var gelN = X.gel.clone(); gelN.repeat.set(28, 28); gelN.needsUpdate = true;
    var nsc = 0.22;

    M = {};
    /* Gelcoat is a mirror-gloss clearcoat surface: every convex radius must
       carry a blown specular streak and every horizontal face must pick up
       the sun's colour.  envMapIntensity is deliberately above 1 — the probe
       is the only thing carrying the horizon line and the bright water. */
    M.gel = pbr({
      color: 0xeef1ee, roughness: 0.18, metalness: 0.0,
      clearcoat: 1.0, clearcoatRoughness: 0.045, envMapIntensity: 1.45,
      normalMap: gelN, normalScale: new T.Vector2(nsc, nsc), envMap: env
    }, { grime: 0.85, salt: 0.75, rvar: 0.10 });
    M.gelGrey = pbr({
      color: 0xc3cad0, roughness: 0.24, metalness: 0.0,
      clearcoat: 0.95, clearcoatRoughness: 0.075, envMapIntensity: 1.35,
      normalMap: gelN, normalScale: new T.Vector2(nsc, nsc), envMap: env
    }, { grime: 1.0, salt: 0.55, rvar: 0.12 });
    /* Helm dash panel.  Every production cat moulds this in a dark low-gloss
       grey so the sun does not bounce off it into the helmsman's eyes, and
       that dark field is what makes the instruments and the white console
       around it separate instead of collapsing into one white mass. */
    M.dash = pbr({
      color: 0x2f3438, roughness: 0.52, metalness: 0.0,
      clearcoat: 0.35, clearcoatRoughness: 0.30, envMapIntensity: 1.1,
      normalMap: gelN, normalScale: new T.Vector2(nsc * 1.4, nsc * 1.4), envMap: env
    }, { grime: 0.9, salt: 0.6, rvar: 0.14 });
    M.hullBand = pbr({
      color: 0x1c2b36, roughness: 0.14, metalness: 0.0,
      clearcoat: 1.0, clearcoatRoughness: 0.035, envMapIntensity: 1.5, envMap: env
    }, { grime: 0.7, salt: 1.0, rvar: 0.08 });
    M.boot = pbr({ color: 0x0b2438, roughness: 0.30, metalness: 0.0, clearcoat: 0.8, envMap: env },
                 { grime: 1.2, salt: 0.9 });
    // hull windows are smoked and opaque — there is a cabin behind them, not sky
    M.hullWin = pbr({
      color: 0x070c11, roughness: 0.035, metalness: 0.0, envMap: env,
      envMapIntensity: 2.1, clearcoat: 1.0, clearcoatRoughness: 0.02
    }, { grime: 0.35, salt: 0.8, rvar: 0.05 });
    M.antifoul = pbr({ color: 0x14242c, roughness: 0.72, metalness: 0.0, envMap: env },
                     { grime: 0.5, salt: 0.0 });
    M.glass = pbr({
      color: 0x0c1a22, roughness: 0.045, metalness: 0.0, envMap: env,
      envMapIntensity: 1.8, transparent: true, opacity: 0.55,
      clearcoat: 1.0, clearcoatRoughness: 0.02, side: T.DoubleSide
    }, { grime: 0.25, salt: 0.7, rvar: 0.04 });
    /* Instrument glass.  The most reflective thing in any cockpit: at golden
       hour a dial face is a mirror carrying the sun and the horizon line, and
       rendering it as an unreflective printed circle is what makes a console
       read as a sticker sheet.  Nearly clear, mirror-smooth, double sided so
       the inside of the bezel shows through it. */
    M.instGlass = pbr({
      color: 0xdfe8ec, roughness: 0.035, metalness: 0.0, envMap: env,
      envMapIntensity: 2.4, transparent: true, opacity: 0.16,
      clearcoat: 1.0, clearcoatRoughness: 0.015, side: T.DoubleSide,
      depthWrite: false
    }, { grime: 0.15, salt: 0.45, rvar: 0.02 });
    M.steel = pbr({
      color: 0xcfd6da, roughness: 0.17, metalness: 1.0, envMap: env, envMapIntensity: 1.2
    }, { grime: 0.55, salt: 0.4, rvar: 0.10 });
    M.steelSat = pbr({
      color: 0xb9c1c6, roughness: 0.38, metalness: 1.0, envMap: env, envMapIntensity: 1.15
    }, { grime: 0.8, salt: 0.4, rvar: 0.14 });
    /* Brushed stainless is defined by what surrounds it: the drum reflects
       deck, coaming and water through the local probe, and the brushing runs
       circumferentially, so the highlight is a band and not a blob. */
    M.winch = pbr({
      color: 0xc6ced3, roughness: 0.26, metalness: 1.0, envMap: env, envMapIntensity: 1.2,
      map: X.winch.map, roughnessMap: X.winch.rough, normalMap: X.winch.normal,
      normalScale: new T.Vector2(0.9, 0.9),
      anisotropy: 0.65, anisotropyRotation: 0.0
    }, { grime: 0.7, salt: 0.3, rvar: 0.09 });
    /* Anodised spar: anisotropy rotated to the mast axis so the sun draws a
       vertical streak down the section instead of a clipped white blob. */
    M.mast = pbr({
      color: 0xb6bcc0, roughness: 0.28, metalness: 1.0, envMap: env, envMapIntensity: 1.1,
      map: X.mast.map, roughnessMap: X.mast.rough, normalMap: X.mast.normal,
      normalScale: new T.Vector2(0.65, 0.65),
      anisotropy: 0.8, anisotropyRotation: PI / 2
    }, { grime: 0.75, salt: 0.5, rvar: 0.10 });
    M.teak = pbr({
      map: X.teak.map, roughnessMap: X.teak.rough, normalMap: X.teak.normal,
      normalScale: new T.Vector2(1.15, 1.15), roughness: 1.0, metalness: 0.0,
      clearcoat: 0.30, clearcoatRoughness: 0.40, envMap: env
    }, { grime: 1.1, salt: 0.12, rvar: 0.16 });
    M.nonskid = pbr({
      map: X.nonskid.map, roughnessMap: X.nonskid.rough, normalMap: X.nonskid.normal,
      normalScale: new T.Vector2(1.0, 1.0), color: 0xe9ece7,
      roughness: 1.0, metalness: 0.0, envMap: env
    }, { grime: 1.35, salt: 0.5, rvar: 0.15 });
    M.canvasNavy = pbr({
      map: X.navy.map, roughnessMap: X.navy.rough, normalMap: X.navy.normal,
      normalScale: new T.Vector2(0.9, 0.9), roughness: 1.0, metalness: 0.0,
      sheen: 0.35, sheenRoughness: 0.8, side: T.DoubleSide, envMap: env
    }, { grime: 1.1, salt: 0.7, rvar: 0.12 });
    M.canvasCream = pbr({
      map: X.cream.map, roughnessMap: X.cream.rough, normalMap: X.cream.normal,
      normalScale: new T.Vector2(0.8, 0.8), roughness: 1.0, metalness: 0.0,
      side: T.DoubleSide, envMap: env
    }, { grime: 1.0, salt: 0.6 });
    /* Bimini / hardtop headliner.  Light enough that the bounce term lands
       it at mid grey-blue rather than crushing to black. */
    M.liner = pbr({
      map: X.liner.map, roughnessMap: X.liner.rough, normalMap: X.liner.normal,
      normalScale: new T.Vector2(0.85, 0.85), roughness: 1.0, metalness: 0.0,
      sheen: 0.5, sheenRoughness: 0.75, sheenColor: new T.Color(0x9fb4b8),
      side: T.DoubleSide, envMap: env, envMapIntensity: 1.2
    }, { grime: 0.85, salt: 0.35, rvar: 0.10 });
    M.cushion = pbr({
      map: X.cushion.map, roughnessMap: X.cushion.rough, normalMap: X.cushion.normal,
      normalScale: new T.Vector2(1.0, 1.0), roughness: 1.0, metalness: 0.0,
      clearcoat: 0.5, clearcoatRoughness: 0.4, envMap: env
    }, { grime: 1.0, salt: 0.5 });
    M.net = patchMat(new T.MeshStandardMaterial({
      map: X.net.map, transparent: true, alphaTest: 0.16, roughness: 0.85,
      metalness: 0.0, side: T.DoubleSide, envMap: env, depthWrite: true
    }), { grime: 1.2, salt: 0.4 });
    M.rope = pbr({
      map: X.rope.map, normalMap: X.rope.normal, normalScale: new T.Vector2(1.2, 1.2),
      roughness: 0.82, metalness: 0.0, envMap: env
    }, { grime: 1.2, salt: 0.5 });
    M.sheet = pbr({
      map: X.sheet.map, normalMap: X.sheet.normal, normalScale: new T.Vector2(1.2, 1.2),
      roughness: 0.80, metalness: 0.0, envMap: env
    }, { grime: 1.0, salt: 0.4 });
    M.leather = pbr({
      map: X.leather.map, roughnessMap: X.leather.rough, normalMap: X.leather.normal,
      normalScale: new T.Vector2(1.1, 1.1), roughness: 1.0, metalness: 0.0, envMap: env
    }, { grime: 0.9, salt: 0.15, rvar: 0.14 });
    M.rubber = pbr({ color: 0x1b1e20, roughness: 0.82, metalness: 0.0, envMap: env },
                   { grime: 1.3, salt: 0.2 });
    M.gasket = pbr({ color: 0x14181b, roughness: 0.70, metalness: 0.0, envMap: env },
                   { grime: 1.6, salt: 0.2 });
    M.plastic = pbr({ color: 0x2a3136, roughness: 0.45, metalness: 0.0, clearcoat: 0.4, envMap: env },
                    { grime: 0.9, salt: 0.4 });
    M.fender = pbr({ color: 0xf3f5f2, roughness: 0.55, metalness: 0.0, clearcoat: 0.5, envMap: env },
                   { grime: 1.4, salt: 0.8 });
    M.solar = pbr({ color: 0x0a1424, roughness: 0.12, metalness: 0.35, clearcoat: 1.0,
                    envMap: env, envMapIntensity: 1.4 }, { grime: 0.5, salt: 0.6, rvar: 0.05 });
    M.screen = patchMat(new T.MeshStandardMaterial({
      map: X.screen, emissive: 0xffffff, emissiveMap: X.screen,
      emissiveIntensity: 5.0, roughness: 0.25, metalness: 0.0
    }), { grime: 0.3, salt: 0.2, rvar: 0.03 });
    M.dial = patchMat(new T.MeshStandardMaterial({
      map: X.dial, emissive: 0xffffff, emissiveMap: X.dial,
      emissiveIntensity: 3.2, roughness: 0.22, metalness: 0.0
    }), { grime: 0.3, salt: 0.2, rvar: 0.03 });
    M.flag = patchMat(new T.MeshStandardMaterial({
      map: X.flag, roughness: 0.85, metalness: 0.0, side: T.DoubleSide, envMap: env
    }), { grime: 0.6, salt: 0.5 });
    M.lamp = {};
    [['red', 0xff2a20], ['green', 0x18e05a], ['white', 0xfff3d8], ['blue', 0x4488ff]].forEach(function (p) {
      M.lamp[p[0]] = new T.MeshStandardMaterial({
        color: 0x101010, emissive: p[1], emissiveIntensity: 0.0,
        roughness: 0.15, metalness: 0.0
      });
      patchMat(M.lamp[p[0]], { grime: 0.4, salt: 0.3 });
    });
    return M;
  }

  /* ==========================================================================
     4.  LOCAL REFLECTION PROBE
     --------------------------------------------------------------------------
     SAIL.sky publishes a PMREM built from the sky dome alone, so everything
     below the horizon in it is black: chrome reflects a gradient, topsides
     have nothing to reflect under the horizon line, and a winch reads as a
     material-preview sphere.  We render our own cube from a point just above
     the cockpit hardtop — open sky above, deck and water below — PMREM it,
     and hand it to every yacht material.  Refreshed at ~2 Hz, which is free
     at this size and is far more information than a sky-only probe.
     ====================================================================== */
  var PB = {
    cubeRT: null, cam: null, pmrem: null, out: null,
    acc: 99, ok: false, failed: false, interval: 0.5
  };

  function probeInit(root) {
    if (PB.cubeRT || PB.failed) return;
    var r = SAIL.renderer;
    if (!r || !r.getContext) return;
    try {
      var sz = LOW() ? 64 : 128;
      PB.interval = LOW() ? 1.2 : 0.5;
      PB.cubeRT = new T.WebGLCubeRenderTarget(sz, {
        type: T.HalfFloatType, format: T.RGBAFormat,
        minFilter: T.LinearFilter, magFilter: T.LinearFilter, generateMipmaps: false
      });
      PB.cam = new T.CubeCamera(0.30, 3000, PB.cubeRT);
      PB.cam.position.set(0, 5.20, 5.10);      // above the cockpit hardtop
      PB.cam.name = 'yacht.probe';
      if (root) root.add(PB.cam);
      PB.pmrem = new T.PMREMGenerator(r);
      PB.pmrem.compileCubemapShader();
    } catch (e) {
      PB.failed = true; PB.cubeRT = null; PB.cam = null; PB.pmrem = null;
    }
  }

  function probeUpdate(dt) {
    if (!PB.cubeRT || PB.failed) return;
    PB.acc += isNum(dt) ? dt : 0.016;
    if (PB.acc < PB.interval) return;
    var r = SAIL.renderer, sc = SAIL.scene;
    if (!r || !sc) return;
    PB.acc = 0;
    var tmOld = r.toneMapping, sOld = r.shadowMap.autoUpdate, rtOld = r.getRenderTarget();
    try {
      // six extra shadow-map rebuilds would cost more than the probe itself
      r.shadowMap.autoUpdate = false;
      r.toneMapping = T.NoToneMapping;
      PB.cam.update(r, sc);
      PB.out = PB.pmrem.fromCubemap(PB.cubeRT.texture, PB.out || null);
      PB.ok = !!(PB.out && PB.out.texture);
    } catch (e) {
      PB.failed = true; PB.ok = false;
    }
    r.shadowMap.autoUpdate = sOld;
    r.toneMapping = tmOld;
    r.setRenderTarget(rtOld);
  }

  /* Re-bind the environment once a better one exists.  The local probe wins;
     the sky PMREM is the fallback; the canvas gradient is the last resort. */
  var _envSeen = null;
  function syncEnv() {
    var env = (PB.ok && PB.out && PB.out.texture) ? PB.out.texture
            : ((SAIL.sky && SAIL.sky.envMap) || null);
    if (!env || env === _envSeen || !M) return;
    _envSeen = env;
    for (var k in M) {
      var m = M[k];
      if (m && m.isMaterial && 'envMap' in m) { m.envMap = env; m.needsUpdate = true; }
    }
  }
  /* ==========================================================================
     5.  AMBIENT OCCLUSION BAKER
     --------------------------------------------------------------------------
     Missing contact darkening is the most reliable giveaway of real-time CG:
     hardware reads as decals pasted onto a plane rather than parts bolted
     through a deck.  The sun shadow map cannot help — a 60 m frustum at 2048
     is ~29 mm per texel, which resolves nothing at cockpit scale and yields
     nothing at all in shade.

     So: voxelise the entire boat at 12 cm into a bit grid, then ray-march
     that grid from every vertex over a cosine-weighted hemisphere.  Costs
     ~120 ms once at build time and produces real occlusion at every
     stanchion base, winch foot, coaming radius, hatch reveal and under the
     whole bimini.  Stored per-vertex in `aAO`, applied to indirect only.
     ====================================================================== */
  var AOG = {
    cs: 0.12, inv: 1 / 0.12,
    ox: -5.10, oy: -2.60, oz: -9.90,
    nx: 0, ny: 0, nz: 0, g: null, on: true
  };
  function aoInit() {
    AOG.nx = Math.ceil(10.2 / AOG.cs);      // 85
    AOG.ny = Math.ceil(31.0 / AOG.cs);      // 259
    AOG.nz = Math.ceil(20.2 / AOG.cs);      // 169
    AOG.g = new Uint8Array(AOG.nx * AOG.ny * AOG.nz);
  }
  function aoMark(x, y, z) {
    var i = ((x - AOG.ox) * AOG.inv) | 0;
    if (i < 0 || i >= AOG.nx) return;
    var j = ((y - AOG.oy) * AOG.inv) | 0;
    if (j < 0 || j >= AOG.ny) return;
    var k = ((z - AOG.oz) * AOG.inv) | 0;
    if (k < 0 || k >= AOG.nz) return;
    AOG.g[(k * AOG.ny + j) * AOG.nx + i] = 1;
  }
  function aoSolid(x, y, z) {
    var i = ((x - AOG.ox) * AOG.inv) | 0;
    if (i < 0 || i >= AOG.nx) return 0;
    var j = ((y - AOG.oy) * AOG.inv) | 0;
    if (j < 0 || j >= AOG.ny) return 0;
    var k = ((z - AOG.oz) * AOG.inv) | 0;
    if (k < 0 || k >= AOG.nz) return 0;
    return AOG.g[(k * AOG.ny + j) * AOG.nx + i];
  }
  /* Splat a geometry's triangles into the grid, oversampled 1.3x per axis so
     a thin shell cannot leak rays through the gaps between cells. */
  function aoVoxelize(geo, mtx) {
    if (!AOG.g || !geo || !geo.attributes || !geo.attributes.position) return;
    var p = geo.attributes.position.array;
    var idx = geo.index ? geo.index.array : null;
    var n = idx ? idx.length : geo.attributes.position.count;
    var e = mtx ? mtx.elements : null;
    var ax, ay, az, bx, by, bz, cx, cy, cz, i;
    function tx(o, out) {
      var x = p[o], y = p[o + 1], z = p[o + 2];
      if (!e) { out[0] = x; out[1] = y; out[2] = z; return; }
      out[0] = e[0] * x + e[4] * y + e[8] * z + e[12];
      out[1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      out[2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    }
    var A = [0, 0, 0], B = [0, 0, 0], C = [0, 0, 0];
    for (i = 0; i + 2 < n; i += 3) {
      tx((idx ? idx[i] : i) * 3, A); tx((idx ? idx[i + 1] : i + 1) * 3, B); tx((idx ? idx[i + 2] : i + 2) * 3, C);
      ax = A[0]; ay = A[1]; az = A[2]; bx = B[0]; by = B[1]; bz = B[2]; cx = C[0]; cy = C[1]; cz = C[2];
      var e0 = Math.abs(bx - ax) + Math.abs(by - ay) + Math.abs(bz - az);
      var e1 = Math.abs(cx - ax) + Math.abs(cy - ay) + Math.abs(cz - az);
      var e2 = Math.abs(cx - bx) + Math.abs(cy - by) + Math.abs(cz - bz);
      var mx = Math.max(e0, e1, e2);
      var st = Math.ceil(mx * AOG.inv * 1.3);
      if (st < 1) st = 1; else if (st > 64) st = 64;
      for (var u = 0; u <= st; u++) {
        for (var v = 0; v + u <= st; v++) {
          var w1 = u / st, w2 = v / st, w0 = 1 - w1 - w2;
          aoMark(ax * w0 + bx * w1 + cx * w2,
                 ay * w0 + by * w1 + cy * w2,
                 az * w0 + bz * w1 + cz * w2);
        }
      }
    }
  }
  /* Fibonacci sphere: an even direction set, no clumping at the poles. */
  function aoDirs(n) {
    var d = [], ga = PI * (3 - Math.sqrt(5));
    for (var i = 0; i < n; i++) {
      var y = 1 - (i + 0.5) / n * 2, r = Math.sqrt(Math.max(0, 1 - y * y)), a = i * ga;
      d.push(Math.cos(a) * r, y, Math.sin(a) * r);
    }
    return d;
  }
  var AODIR = null;
  function aoBake(geo, mtx) {
    if (!AOG.g || !geo || !geo.attributes || !geo.attributes.position) return;
    if (!geo.attributes.normal) geo.computeVertexNormals();
    var p = geo.attributes.position.array, nr = geo.attributes.normal.array;
    var N = geo.attributes.position.count, out = new Float32Array(N);
    if (!AODIR) AODIR = aoDirs(LOW() ? 14 : 26);
    var D = AODIR, ND = D.length / 3;
    var e = mtx ? mtx.elements : null;
    // growing step sizes: 1.7 m of reach in 9 taps instead of 15
    var STEP = [0.14, 0.13, 0.15, 0.18, 0.22, 0.26, 0.31, 0.36, 0.42];
    var MAXT = 2.17, i, k;
    for (i = 0; i < N; i++) {
      var o = i * 3, px = p[o], py = p[o + 1], pz = p[o + 2];
      var nx = nr[o], ny = nr[o + 1], nz = nr[o + 2];
      if (e) {
        var qx = e[0] * px + e[4] * py + e[8] * pz + e[12];
        var qy = e[1] * px + e[5] * py + e[9] * pz + e[13];
        var qz = e[2] * px + e[6] * py + e[10] * pz + e[14];
        var mx2 = e[0] * nx + e[4] * ny + e[8] * nz;
        var my2 = e[1] * nx + e[5] * ny + e[9] * nz;
        var mz2 = e[2] * nx + e[6] * ny + e[10] * nz;
        var ml = Math.sqrt(mx2 * mx2 + my2 * my2 + mz2 * mz2) || 1;
        px = qx; py = qy; pz = qz; nx = mx2 / ml; ny = my2 / ml; nz = mz2 / ml;
      }
      // start clear of our own surface voxel (half a cell plus a margin)
      var sx = px + nx * 0.105, sy = py + ny * 0.105, sz = pz + nz * 0.105;
      var occ = 0, wsum = 0;
      for (k = 0; k < ND; k++) {
        var dx = D[k * 3], dy = D[k * 3 + 1], dz = D[k * 3 + 2];
        var nd = dx * nx + dy * ny + dz * nz;
        if (nd <= 0.06) continue;
        wsum += nd;
        var t = 0.06;
        for (var s = 0; s < STEP.length; s++) {
          t += STEP[s];
          if (aoSolid(sx + dx * t, sy + dy * t, sz + dz * t)) {
            occ += nd * (1 - t / MAXT);
            break;
          }
        }
      }
      /* Floor at 0.13 rather than 0.055.  A closed-hemisphere estimate says a
         cockpit corner sees almost nothing, but the real one is open to a sea
         that is the brightest surface in the scene; taking the estimate
         literally is what turns every interior corner into a hole punched in
         the frame instead of a shaded surface you can still read. */
      var a = wsum > 1e-4 ? 1 - (occ / wsum) * 0.88 : 1;
      out[i] = clamp(a, 0.13, 1);
    }
    geo.setAttribute('aAO', new T.BufferAttribute(out, 1));
  }
  /* Every geometry we hand to a patched material must carry aAO even if the
     baker is skipped, so nothing can render at the GL default. */
  function aoFill(geo, v) {
    if (!geo || !geo.attributes || !geo.attributes.position) return;
    if (geo.attributes.aAO) return;
    var n = geo.attributes.position.count, a = new Float32Array(n);
    a.fill(v === undefined ? 1 : v);
    geo.setAttribute('aAO', new T.BufferAttribute(a, 1));
  }

  /* ==========================================================================
     6.  GEOMETRY HELPERS  (transform + merge; everything is welded by material)
     ====================================================================== */
  var _v = new T.Vector3(), _v2 = new T.Vector3(), _q = new T.Quaternion();
  var _e = new T.Euler(), _s = new T.Vector3(), _m = new T.Matrix4();
  var UP = new T.Vector3(0, 1, 0), ONE = new T.Vector3(1, 1, 1);

  function at(g, x, y, z, rx, ry, rz, sx, sy, sz) {
    _s.set(sx === undefined ? 1 : sx,
           sy === undefined ? (sx === undefined ? 1 : sx) : sy,
           sz === undefined ? (sx === undefined ? 1 : sx) : sz);
    _e.set(rx || 0, ry || 0, rz || 0);
    _q.setFromEuler(_e);
    _v.set(x || 0, y || 0, z || 0);
    _m.compose(_v, _q, _s);
    g.applyMatrix4(_m);
    return g;
  }

  /* A cylinder stretched between two points — handrails, tubes, spreaders.
     Real geometry, so it shades, occludes and casts shadow. */
  function rod(a, b, r, seg) {
    var dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    var L = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (L < 1e-5) L = 1e-5;
    var g = new T.CylinderGeometry(r, r, L, seg || (LOW() ? 5 : 8), segCount(L), false);
    _v2.set(dx / L, dy / L, dz / L);
    _q.setFromUnitVectors(UP, _v2);
    _v.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
    _m.compose(_v, _q, ONE);
    g.applyMatrix4(_m);
    return g;
  }

  /* Baked AO lives on the vertices, so a 6 m panel built as a single quad can
     only carry occlusion at its four corners — the interior interpolates
     linearly and the quad's own diagonal shows up as a crease.  Subdividing
     on a ~0.55 m grid gives the baker somewhere to put the darkening under a
     seat, along a coaming and in the corners of the sole.  Small parts are
     left alone, so the triangle cost lands only where it buys something. */
  function segCount(m) {
    var n = Math.round(Math.abs(m) / 0.55);
    return n < 1 ? 1 : (n > (LOW() ? 2 : 5) ? (LOW() ? 2 : 5) : n);
  }
  /* Flat decks and headliners are the surfaces whose AO gradient the eye
     actually reads — the darkening that creeps out from a coaming base or
     from under a console — and they cost two triangles per cell, so they get
     a much finer grid than a solid box does. */
  function segFlat(m) {
    var n = Math.round(Math.abs(m) / 0.34);
    return n < 1 ? 1 : (n > (LOW() ? 4 : 16) ? (LOW() ? 4 : 16) : n);
  }
  function box(w, h, d) {
    return new T.BoxGeometry(w, h, d, segCount(w), segCount(h), segCount(d));
  }
  /* A box whose UVs are metres / tile instead of 0..1 per face.  Derived from
     the vertex normal rather than the vertex order, so it survives however
     BoxGeometry chooses to subdivide.  Without it a 2.6 m sunbed and a 1.2 m
     helm seat wear the same two cushion panels at wildly different physical
     sizes — the classic stretched-upholstery tell. */
  function boxUV(w, h, d, tile) {
    var g = box(w, h, d);
    var p = g.attributes.position.array, nr = g.attributes.normal.array;
    var a = g.attributes.uv.array, t = tile || 1, i;
    for (i = 0; i < g.attributes.position.count; i++) {
      var o = i * 3, ax = Math.abs(nr[o]), ay = Math.abs(nr[o + 1]), az = Math.abs(nr[o + 2]);
      var u, v;
      if (ax >= ay && ax >= az) { u = p[o + 2]; v = p[o + 1]; }
      else if (ay >= az) { u = p[o]; v = p[o + 2]; }
      else { u = p[o]; v = p[o + 1]; }
      a[i * 2] = u / t; a[i * 2 + 1] = v / t;
    }
    g.attributes.uv.needsUpdate = true;
    return g;
  }
  /* Upholstery: a cushion of real thickness with a slight crown and a welted
     edge, UV'd in metres so the panel pitch is 0.45 m everywhere. */
  function cush(w, h, d) { return boxUV(w, h, d, 0.90); }
  function cyl(rt, rb, h, rs, hs, open) {
    return new T.CylinderGeometry(rt, rb, h, rs || (LOW() ? 8 : 14), hs || segCount(h), !!open);
  }
  function sph(r, a, b) { return new T.SphereGeometry(r, a || (LOW() ? 8 : 14), b || (LOW() ? 6 : 10)); }
  function tor(r, tr, a, b) { return new T.TorusGeometry(r, tr, a || 8, b || (LOW() ? 18 : 32)); }

  /* Horizontal plate whose UVs are metres / tile size — used for teak decks
     and non-skid so the pattern scale is exact regardless of panel size. */
  function plate(w, d, tu, tv) {
    var g = new T.PlaneGeometry(w, d, segFlat(w), segFlat(d));
    g.rotateX(-PI / 2);
    var a = g.attributes.uv.array;
    for (var i = 0; i < a.length; i += 2) { a[i] *= w / tu; a[i + 1] *= d / tv; }
    return g;
  }
  /* The same plate with the pattern turned 90 deg: margin boards and the
     athwartships ends of a laid deck run across, not along. */
  function plateT(w, d, tu, tv) {
    var g = new T.PlaneGeometry(w, d, segFlat(w), segFlat(d));
    g.rotateX(-PI / 2);
    var a = g.attributes.uv.array, i, u, v;
    for (i = 0; i < a.length; i += 2) {
      u = a[i]; v = a[i + 1];
      a[i] = v * d / tu; a[i + 1] = u * w / tv;
    }
    return g;
  }
  /* A laid-teak surface of real thickness. BoxGeometry gives every face a
     0..1 UV, which would make the plank width depend on the panel size — so
     the visible top is a plate() with UVs in metres and the body is a plain
     substrate underneath. Planks always come out 6.25 cm wide. */
  function teakCap(A, w, d, x, y, z, th, sub) {
    th = th || 0.05;
    A.add(at(plate(w, d, 0.5, 2.0), x, y, z), M.teak);
    A.add(at(box(w, th, d), x, y - th / 2 - 0.004, z), sub || M.gel);
  }
  /* A properly LAID teak deck rather than a tiling stripe field: a margin
     board follows the perimeter with its planks running along the edge, the
     ends are mitred by the corner overlap, and a king plank runs down the
     centreline.  The field planks run fore and aft. */
  function teakDeck(A, w, d, x, y, z, th, sub) {
    var mw = 0.15, kw = 0.16;                      // margin board / king plank
    th = th || 0.05;
    var fw = w - mw * 2, fd = d - mw * 2;
    if (fw < 0.4 || fd < 0.4) { teakCap(A, w, d, x, y, z, th, sub); return; }
    // field, split either side of the king plank
    var hw = (fw - kw) / 2;
    A.add(at(plate(hw, fd, 0.5, 2.0), x - (kw / 2 + hw / 2), y, z), M.teak);
    A.add(at(plate(hw, fd, 0.5, 2.0), x + (kw / 2 + hw / 2), y, z), M.teak);
    A.add(at(plate(kw, fd, 0.5, 2.6), x, y + 0.0012, z), M.teak);            // king plank
    // margin boards: fore and aft run athwartships, sides run fore and aft
    A.add(at(plateT(w, mw, 0.5, 2.0), x, y + 0.0006, z - d / 2 + mw / 2), M.teak);
    A.add(at(plateT(w, mw, 0.5, 2.0), x, y + 0.0006, z + d / 2 - mw / 2), M.teak);
    A.add(at(plate(mw, fd, 0.5, 2.0), x - w / 2 + mw / 2, y + 0.0006, z), M.teak);
    A.add(at(plate(mw, fd, 0.5, 2.0), x + w / 2 - mw / 2, y + 0.0006, z), M.teak);
    A.add(at(box(w, th, d), x, y - th / 2 - 0.004, z), sub || M.gel);
  }

  /* Vertical panel in the XY plane, UVs in metres / tile. */
  function panelXY(w, h, tu, tv) {
    var g = new T.PlaneGeometry(w, h, segFlat(w), segFlat(h));
    var a = g.attributes.uv.array;
    for (var i = 0; i < a.length; i += 2) { a[i] *= w / tu; a[i + 1] *= h / tv; }
    return g;
  }

  /* A dark gasket ring under every deck-penetrating fitting.  Two millimetres
     of bedding compound is the difference between "bolted through" and
     "pasted on", and it survives at any quality level. */
  function gasket(A, x, y, z, r, h) {
    A.add(at(cyl(r, r * 1.10, h || 0.012, LOW() ? 8 : 14), x, y, z), M.gasket);
  }

  /* NACA-ish symmetric foil, chord along Z, thickness along X, span down -Y. */
  function foil(chordR, chordT, thick, span, sweep, ns) {
    var N = LOW() ? 7 : 11, pos = [], idx = [], uv = [], j, i;
    ns = ns || 2;
    for (i = 0; i <= ns; i++) {
      var s = i / ns, ch = lerp(chordR, chordT, s), y = -span * s, zoff = sweep * s;
      for (j = 0; j <= N * 2; j++) {
        var k = j <= N ? j / N : (2 * N - j) / N;
        var sgn = j <= N ? 1 : -1;
        var yt = 5 * thick * ch * (0.2969 * Math.sqrt(k) - 0.1260 * k - 0.3516 * k * k +
                 0.2843 * k * k * k - 0.1015 * k * k * k * k);
        pos.push(sgn * yt, y, -ch / 2 + k * ch + zoff);
        uv.push(j / (2 * N), s);
      }
    }
    var M2 = N * 2 + 1;
    for (i = 0; i < ns; i++) for (j = 0; j < M2 - 1; j++) {
      var a = i * M2 + j, b = a + 1, c = a + M2, d = c + 1;
      idx.push(a, c, d, a, d, b);
    }
    var base = ns * M2;
    for (j = 1; j < M2 - 2; j++) idx.push(base, base + j, base + j + 1);
    var g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  /* --------------------------------------------------------------------------
     Extruded spar section.  A real anodised mast is not a tube: it is an
     extrusion with a rounded leading edge, near-flat slab sides that hold two
     hard specular corners the full length of the spar, and an aft sail track
     sunk into a raised boss.  A cylinder with an isotropic highlight reads as
     painted plastic pipe, which is exactly what the review said.
     Profile points are (z, x) in unit half-widths; +z is aft.
     ------------------------------------------------------------------------ */
  var SPAR_PROF = [
    [0.94, 0.000], [0.94, 0.052], [1.06, 0.066], [1.06, 0.112], [1.00, 0.170],
    [0.94, 0.290], [0.82, 0.430], [0.62, 0.545], [0.34, 0.618], [0.02, 0.645],
    [-0.34, 0.628], [-0.66, 0.560], [-0.90, 0.430], [-1.05, 0.250], [-1.10, 0.000]
  ];
  function sparGeom(len, rBase, rTip, nL) {
    var P = SPAR_PROF, NP2 = P.length, i, j;
    var ring = NP2 * 2 - 2;                       // mirrored, both centre points shared
    nL = nL || (LOW() ? 4 : 10);
    var pos = [], uv = [], idx = [];
    for (i = 0; i <= nL; i++) {
      var s = i / nL;
      // spars taper only above the upper spreader, not linearly from the heel
      var r = lerp(rBase, rTip, Math.pow(s, 1.45));
      var y = len * s;
      for (j = 0; j < ring; j++) {
        var k = j < NP2 ? j : ring - j;
        var sgn = j < NP2 ? 1 : -1;
        pos.push(sgn * P[k][1] * r, y, P[k][0] * r);
        uv.push(j / ring, y / 1.2);
      }
    }
    for (i = 0; i < nL; i++) for (j = 0; j < ring; j++) {
      var a = i * ring + j, b = i * ring + ((j + 1) % ring);
      var c = a + ring, d = b + ring;
      idx.push(a, c, d, a, d, b);
    }
    // cap the top
    var base = nL * ring, cIdx = pos.length / 3;
    pos.push(0, len, 0); uv.push(0.5, len / 1.2);
    for (j = 0; j < ring; j++) idx.push(base + j, cIdx, base + ((j + 1) % ring));
    var g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  function mergeAll(list) {
    var vc = 0, ic = 0, i, g;
    for (i = 0; i < list.length; i++) {
      g = list[i];
      if (!g.attributes.normal) g.computeVertexNormals();
      if (!g.attributes.uv) {
        g.setAttribute('uv', new T.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
      }
      if (!g.index) {
        var n = g.attributes.position.count, ar = new Uint32Array(n);
        for (var q = 0; q < n; q++) ar[q] = q;
        g.setIndex(new T.BufferAttribute(ar, 1));
      }
      vc += g.attributes.position.count; ic += g.index.count;
    }
    var P = new Float32Array(vc * 3), NR = new Float32Array(vc * 3);
    var U = new Float32Array(vc * 2), I = new Uint32Array(ic);
    var vo = 0, io = 0;
    for (i = 0; i < list.length; i++) {
      g = list[i];
      P.set(g.attributes.position.array, vo * 3);
      NR.set(g.attributes.normal.array, vo * 3);
      U.set(g.attributes.uv.array, vo * 2);
      var ix = g.index.array;
      for (var k = 0; k < ix.length; k++) I[io + k] = ix[k] + vo;
      vo += g.attributes.position.count; io += ix.length;
    }
    var out = new T.BufferGeometry();
    out.setAttribute('position', new T.BufferAttribute(P, 3));
    out.setAttribute('normal', new T.BufferAttribute(NR, 3));
    out.setAttribute('uv', new T.BufferAttribute(U, 2));
    out.setIndex(new T.BufferAttribute(I, 1));
    out.computeBoundingSphere();
    return out;
  }

  function Acc() { this.b = []; this.m = []; }
  Acc.prototype.add = function (geo, mat) {
    var i = this.m.indexOf(mat);
    if (i < 0) { i = this.m.length; this.m.push(mat); this.b.push([]); }
    this.b[i].push(geo);
    return geo;
  };
  Acc.prototype.flush = function (parent, name, noShadow) {
    for (var i = 0; i < this.m.length; i++) {
      if (!this.b[i].length) continue;
      var mesh = new T.Mesh(mergeAll(this.b[i]), this.m[i]);
      mesh.castShadow = !noShadow; mesh.receiveShadow = true;
      mesh.name = (name || 'yacht') + '.' + i;
      parent.add(mesh);
    }
    this.b = []; this.m = [];
  };

  /* ==========================================================================
     7.  ANALYTIC WIRE RIBBONS
     --------------------------------------------------------------------------
     1x19 stainless in tropical sun is a bright specular filament, not a black
     line, and at 8 mm it is sub-pixel over most of its length — where a
     triangle mesh either disappears or crawls as a 1-px staircase.  Each
     segment is instead a camera-facing ribbon expanded to a MINIMUM SCREEN
     WIDTH, with the lost coverage paid back in alpha.  That anti-aliases
     analytically at any distance, and a Kajiya-Kay lobe along the tangent
     makes the wire flip bright-to-dark along its length the way real wire
     does instead of holding one flat value.
     ====================================================================== */
  var WIRE_VS = [
    'attribute vec3 aDir;',
    'attribute float aSide;',
    'attribute float aRad;',
    'attribute float aS;',
    'attribute float aShade;',
    'uniform float uPxScale;',
    'uniform float uMinPx;',
    'varying float vCov; varying float vU; varying float vS; varying float vSh;',
    'varying vec3 vT; varying vec3 vV;',
    'void main(){',
    '  vSh = aShade;',
    '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
    '  vec3 dv = (modelViewMatrix * vec4(aDir, 0.0)).xyz;',
    '  float dl = length(dv); dv = dl > 1e-5 ? dv/dl : vec3(0.0,1.0,0.0);',
    '  vec3 vd = -mv.xyz; float vl = length(vd); vd = vl > 1e-5 ? vd/vl : vec3(0.0,0.0,1.0);',
    '  vec3 sd = cross(dv, vd); float sl = length(sd);',
    '  sd = sl > 1e-4 ? sd/sl : vec3(1.0,0.0,0.0);',
    '  float depth = max(-mv.z, 0.05);',
    '  float wMin = depth * uPxScale * uMinPx;',
    '  float w = max(aRad, wMin);',
    '  vCov = clamp(aRad / w, 0.09, 1.0);',
    '  vU = aSide; vS = aS; vT = dv; vV = vd;',
    '  mv.xyz += sd * (aSide * w);',
    '  gl_Position = projectionMatrix * mv;',
    '}'
  ].join('\n');

  var WIRE_FS = [
    'uniform vec3 uSunV; uniform vec3 uSunCol; uniform vec3 uAmbCol; uniform vec3 uUpV;',
    'uniform vec3 uAlbedo; uniform float uShine; uniform float uSpecK; uniform float uOpacity;',
    'uniform float uLay;',
    'varying float vCov; varying float vU; varying float vS; varying float vSh;',
    'varying vec3 vT; varying vec3 vV;',
    'void main(){',
    '  float r = clamp(abs(vU), 0.0, 1.0);',
    '  float cov = vCov * smoothstep(1.0, 0.38, r);',
    '  if (cov < 0.003) discard;',
    '  vec3 Tv = normalize(vT), V = normalize(vV);',
    '  vec3 B = cross(Tv, V); float bl = length(B);',
    '  B = bl > 1e-4 ? B/bl : vec3(0.0,1.0,0.0);',
    '  vec3 Nv = cross(B, Tv);',
    '  float rr = clamp(vU, -1.0, 1.0);',
    '  vec3 N = normalize(Nv * sqrt(max(1.0 - rr*rr, 0.03)) + B * rr);',
    '  vec3 L = normalize(uSunV);',
    '  float tl = dot(Tv, L), tv = dot(Tv, V);',
    '  float stl = sqrt(max(0.0, 1.0 - tl*tl)), stv = sqrt(max(0.0, 1.0 - tv*tv));',
    '  float kk = max(0.0, stl*stv - tl*tv);',
    '  float spec = pow(kk, uShine);',
    /* a slow drift along the wire so the glint is not a perfect uniform band */
    '  spec *= 0.72 + 0.42 * sin(vS * 11.0);',
    '  float dl = max(dot(N, L), 0.0);',
    '  float sky = 0.5 + 0.5 * dot(N, uUpV);',
    '  float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);',
    /* Sky openness, baked from the same voxel grid the vertex AO uses.  The
       analytic wires do not sample the shadow map, so without this a sheet
       tail lying on a cockpit sole under a solid hardtop is lit as if it were
       in full sun — a blown-white stroke drawn over a shaded deck, which is
       exactly what makes running rigging read as a UI overlay. */
    '  float sh = clamp(vSh, 0.0, 1.0);',
    '  float sunK = sh * sh;',
    '  vec3 col = uAlbedo * (uAmbCol * (0.30 + 0.80*sky) * mix(0.34, 1.0, sh)',
    '                        + uSunCol * dl * sunK) * 0.31831;',
    '  col += uSunCol * spec * uSpecK * 0.31831 * 9.0 * sunK;',
    '  col += uAmbCol * uAlbedo * fres * 0.55 * 0.31831 * mix(0.4, 1.0, sh);',
    /* Braided line is three strands laid in a helix: the highlight is not a
       clean filament but a repeating diagonal chevron running along it, and
       the fibre scatters so the shadow side never goes fully dark. */
    '  if (uLay > 0.0) {',
    '    float lay = sin((vS * uLay + rr * 1.9) * 6.2831853);',
    '    col *= 0.80 + 0.26 * lay * lay;',
    '    col *= 0.90 + 0.16 * sin(vS * uLay * 0.31 + 1.7);',
    '  }',
    '  gl_FragColor = vec4(col, cov * uOpacity);',
    '}'
  ].join('\n');

  function wireMaterial(albedo, shine, specK, opacity, lay) {
    var m = new T.ShaderMaterial({
      uniforms: {
        uLay: { value: lay || 0 },
        uPxScale: { value: 0.0016 }, uMinPx: { value: 1.45 },
        uSunV: { value: new T.Vector3(0, 0, 1) },
        uUpV: { value: new T.Vector3(0, 1, 0) },
        uSunCol: { value: new T.Vector3(60, 56, 50) },
        uAmbCol: { value: new T.Vector3(12, 15, 22) },
        uAlbedo: { value: new T.Color(albedo) },
        uShine: { value: shine }, uSpecK: { value: specK },
        uOpacity: { value: opacity === undefined ? 1 : opacity }
      },
      vertexShader: WIRE_VS, fragmentShader: WIRE_FS,
      transparent: true, depthWrite: false, depthTest: true,
      side: T.DoubleSide, toneMapped: false
    });
    // a wire mesh always carries aShade; anything else defaults to open sky
    m.defaultAttributeValues = m.defaultAttributeValues || {};
    m.defaultAttributeValues.aShade = new Float32Array([1]);
    return m;
  }

  function WireAcc() {
    this.p = []; this.d = []; this.s = []; this.r = []; this.t = []; this.i = []; this.n = 0;
  }
  /* a, b: endpoints.  r: real radius.  sag: metres of catenary droop.       */
  WireAcc.prototype.add = function (a, b, r, sag, segs) {
    segs = segs || (sag ? (LOW() ? 4 : 7) : 1);
    var i, k, prev = null;
    var pts = [];
    for (i = 0; i <= segs; i++) {
      var f = i / segs;
      var droop = sag ? sag * Math.sin(f * PI) : 0;
      pts.push([lerp(a[0], b[0], f), lerp(a[1], b[1], f) - droop, lerp(a[2], b[2], f)]);
    }
    for (i = 0; i < segs; i++) {
      var p0 = pts[i], p1 = pts[i + 1];
      var dx = p1[0] - p0[0], dy = p1[1] - p0[1], dz = p1[2] - p0[2];
      var L = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-5;
      dx /= L; dy /= L; dz /= L;
      var base = this.n;
      for (k = 0; k < 4; k++) {
        var pt = (k === 0 || k === 3) ? p0 : p1;
        this.p.push(pt[0], pt[1], pt[2]);
        this.d.push(dx, dy, dz);
        this.s.push(k < 2 ? -1 : 1);
        this.r.push(r);
        this.t.push((i + ((k === 0 || k === 3) ? 0 : 1)) / segs);
        this.n++;
      }
      this.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
      prev = p1;
    }
    return this;
  };
  WireAcc.prototype.mesh = function (mat, name) {
    if (!this.n) return null;
    var g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(this.p, 3));
    g.setAttribute('aDir', new T.Float32BufferAttribute(this.d, 3));
    g.setAttribute('aSide', new T.Float32BufferAttribute(this.s, 1));
    g.setAttribute('aRad', new T.Float32BufferAttribute(this.r, 1));
    g.setAttribute('aS', new T.Float32BufferAttribute(this.t, 1));
    var sh = new Float32Array(this.n); sh.fill(1);
    g.setAttribute('aShade', new T.BufferAttribute(sh, 1));
    g.setIndex(this.i);
    g.computeBoundingSphere();
    if (g.boundingSphere) g.boundingSphere.radius *= 1.35;
    var m = new T.Mesh(g, mat);
    m.name = name || 'wires';
    m.castShadow = false; m.receiveShadow = false;
    m.renderOrder = 4;
    return m;
  };
  /* Wire accumulators, filled by the sections and flushed in build(). */
  var WS = null, WR = null, MWS = null, MWR = null;

  /* ==========================================================================
     8.  HULL LOFT   (station maths taken from boat_reference.js loftHull)
     ====================================================================== */
  function hullStations() {
    var L = S.loa, hb = S.hullBeam / 2, canoe = S.canoe;
    var NS = LOW() ? 24 : 36, NP = LOW() ? 8 : 12, st = [];
    for (var i = 0; i <= NS; i++) {
      var t = -Math.cos(i / NS * PI);                     // -1 transom .. +1 stem
      var fore = t * L / 2;
      var halfB = t >= 0
        ? hb * Math.pow(Math.max(0, 1 - Math.pow(t, 2.35)), 0.46)
        : hb * (1 - 0.26 * Math.pow(-t, 3.2));
      halfB = Math.max(halfB, 0.035);
      var keel = -canoe * (1 - Math.pow(Math.max(0, t), 2.0) * 0.94);
      if (t < -0.86) keel *= 1 - ((-t) - 0.86) / 0.14 * 0.22;
      var sheer = 1.62 + 0.68 * Math.pow(Math.max(0, t), 2.2) + 0.06 * t;
      var pts = [];
      for (var j = 0; j <= NP; j++) {
        var s = j / NP;
        // a soft chine near s = 0.62 keeps the topsides slab-sided like the real hull
        var kn = 1 + 0.10 * Math.exp(-Math.pow((s - 0.62) / 0.13, 2));
        pts.push([halfB * Math.pow(Math.sin(s * PI / 2), 0.62) * kn,
                  keel + (sheer - keel) * Math.pow(s, 1.45)]);
      }
      st.push({ fore: fore, pts: pts, keel: keel, sheer: sheer, halfB: halfB });
    }
    var H = { st: st, NS: NS, NP: NP };
    H.tOf = function (z) { return clamp(-z / (S.loa / 2), -1, 1); };
    H.sheerAt = function (z) {
      var t = H.tOf(z);
      return 1.62 + 0.68 * Math.pow(Math.max(0, t), 2.2) + 0.06 * t;
    };
    H.halfAt = function (z) {
      var t = H.tOf(z), hb2 = S.hullBeam / 2;
      return Math.max(0.04, t >= 0
        ? hb2 * Math.pow(Math.max(0, 1 - Math.pow(t, 2.35)), 0.46)
        : hb2 * (1 - 0.26 * Math.pow(-t, 3.2)));
    };
    return H;
  }

  /* One vertex set, several index sets: the boot top, the dark topside band
     and the hull windows are REGIONS OF THE HULL SURFACE, not boxes floating
     near it, so they hug the loft exactly and can never z-fight or poke out. */
  function loftHullParts(H, outSign) {
    var st = H.st, NS = H.NS, NP = H.NP;
    var pos = [], uv = [], ring = [], i, j;
    function push(fore, stbd, up, u, v) {
      pos.push(stbd, up, -fore); uv.push(u, v);
      return pos.length / 3 - 1;
    }
    var M2 = NP * 2 + 1;
    for (i = 0; i <= NS; i++) {
      var s0 = st[i], row = [], vv = (s0.fore + S.loa / 2) / 4.0, k = 0;
      for (j = NP; j >= 0; j--) row.push(push(s0.fore, s0.pts[j][0], s0.pts[j][1], (k++) / (M2 - 1), vv));
      for (j = 1; j <= NP; j++) row.push(push(s0.fore, -s0.pts[j][0], s0.pts[j][1], (k++) / (M2 - 1), vv));
      ring.push(row);
    }
    var B = { gel: [], anti: [], boot: [], band: [], glass: [] };
    var WIN = [[0.30, 3.70], [-3.60, -1.30]];       // window runs, in fore metres
    for (i = 0; i < NS; i++) {
      var fm = (st[i].fore + st[i + 1].fore) / 2;
      for (j = 0; j < M2 - 1; j++) {
        var a = ring[i][j], b = ring[i][j + 1], c = ring[i + 1][j + 1], d = ring[i + 1][j];
        var ym = (pos[a * 3 + 1] + pos[b * 3 + 1] + pos[c * 3 + 1] + pos[d * 3 + 1]) / 4;
        var jm = j + 0.5, sv = Math.abs(jm - NP) / NP;
        var outb = ((jm < NP) ? 1 : -1) === outSign;
        var key;
        if (ym < 0.02) key = 'anti';
        else if (ym < 0.25) key = 'boot';
        else if (outb && sv > 0.78 && sv < 0.945 && fm > -5.6 && fm < 5.4) {
          key = 'band';
          for (var w = 0; w < WIN.length; w++) {
            if (sv > 0.805 && sv < 0.915 && fm > WIN[w][0] && fm < WIN[w][1]) key = 'glass';
          }
        } else key = 'gel';
        B[key].push(a, b, c, a, c, d);
      }
    }
    var tr = st[0], cc = push(tr.fore, 0, (tr.keel + tr.sheer) / 2, 0.5, 0);
    for (j = 0; j < M2 - 1; j++) {
      var yt = (pos[ring[0][j] * 3 + 1] + pos[ring[0][j + 1] * 3 + 1]) / 2;
      B[yt < 0.02 ? 'anti' : yt < 0.25 ? 'boot' : 'gel'].push(ring[0][j + 1], ring[0][j], cc);
    }
    var bw = st[NS], c2 = push(bw.fore + 0.06, 0, (bw.keel + bw.sheer) / 2, 0.5, 4);
    for (j = 0; j < M2 - 1; j++) B.gel.push(ring[NS][j], ring[NS][j + 1], c2);

    var out = {};
    for (var key2 in B) {
      if (!B[key2].length) continue;
      var g = new T.BufferGeometry();
      g.setAttribute('position', new T.Float32BufferAttribute(pos.slice(0), 3));
      g.setAttribute('uv', new T.Float32BufferAttribute(uv.slice(0), 2));
      g.setIndex(B[key2]);
      g.computeVertexNormals();
      out[key2] = g;
    }
    return out;
  }

  /* Crowned side deck lofted off the sheer line: non-skid field, gelcoat
     margin at the edge and a toe rail, all following the real sheer. */
  function deckLoft(H) {
    var st = H.st, NS = H.NS, N = LOW() ? 6 : 10;
    var pos = [], uv = [], ring = [], i, j;
    for (i = 0; i <= NS; i++) {
      var s0 = st[i], hb = s0.halfB * 0.99, row = [];
      for (j = 0; j <= N; j++) {
        var f = j / N, x = (-1 + 2 * f) * hb;
        var crown = 0.05 * (1 - (2 * f - 1) * (2 * f - 1));
        pos.push(x, s0.sheer + 0.014 + crown, -s0.fore);
        uv.push((x + S.hullBeam / 2) / 0.55, (s0.fore + S.loa / 2) / 0.55);
        row.push(pos.length / 3 - 1);
      }
      ring.push(row);
    }
    var B = { skid: [], margin: [] };
    for (i = 0; i < NS; i++) for (j = 0; j < N; j++) {
      var e = Math.abs(2 * (j + 0.5) / N - 1);
      B[e > 0.80 ? 'margin' : 'skid'].push(
        ring[i][j], ring[i][j + 1], ring[i + 1][j + 1],
        ring[i][j], ring[i + 1][j + 1], ring[i + 1][j]);
    }
    var out = {};
    for (var k in B) {
      var g = new T.BufferGeometry();
      g.setAttribute('position', new T.Float32BufferAttribute(pos.slice(0), 3));
      g.setAttribute('uv', new T.Float32BufferAttribute(uv.slice(0), 2));
      g.setIndex(B[k]);
      g.computeVertexNormals();
      out[k] = g;
    }
    // toe rail: a low ribbon closing the deck edge onto the hull sheer
    for (var side = 0; side < 2; side++) {
      var rp = [], ru = [], ri = [], sgn = side ? 1 : -1;
      for (i = 0; i <= NS; i++) {
        var s1 = st[i], hx = s1.halfB * 0.99 * sgn;
        rp.push(hx, s1.sheer + 0.014, -s1.fore, hx + sgn * 0.035, s1.sheer + 0.075, -s1.fore);
        ru.push(0, (s1.fore + S.loa / 2) / 0.4, 1, (s1.fore + S.loa / 2) / 0.4);
      }
      for (i = 0; i < NS; i++) {
        var q = i * 2;
        if (sgn > 0) ri.push(q, q + 1, q + 3, q, q + 3, q + 2);
        else ri.push(q, q + 3, q + 1, q, q + 2, q + 3);
      }
      var rg = new T.BufferGeometry();
      rg.setAttribute('position', new T.Float32BufferAttribute(rp, 3));
      rg.setAttribute('uv', new T.Float32BufferAttribute(ru, 2));
      rg.setIndex(ri);
      rg.computeVertexNormals();
      out[side ? 'railS' : 'railP'] = rg;
    }
    return out;
  }

  /* ==========================================================================
     9.  SECTIONS
     ====================================================================== */
  function buildHulls(A, root, P) {
    var H = HS, sep = S.hullSep, s, i;
    for (s = -1; s <= 1; s += 2) {
      var hp = loftHullParts(H, s);
      A.add(at(hp.gel, s * sep, 0, 0), M.gel);
      A.add(at(hp.anti, s * sep, 0, 0), M.antifoul);
      A.add(at(hp.boot, s * sep, 0, 0), M.boot);
      if (hp.band) A.add(at(hp.band, s * sep, 0, 0), M.hullBand);
      if (hp.glass) A.add(at(hp.glass, s * sep, 0, 0), M.hullWin);
      // mini keel: low-aspect stub that takes the draft to 1.70 m
      A.add(at(foil(6.0, 4.4, 0.13, 0.72, 0.5, 2), s * sep, -0.98, 1.0), M.antifoul);
      // saildrive leg + folding prop hub
      A.add(at(foil(0.62, 0.5, 0.34, 0.98, 0.05, 2), s * sep, -0.9, S.propZ + 0.1), M.antifoul);
      A.add(at(cyl(0.09, 0.11, 0.42, 10), s * sep, -1.72, S.propZ - 0.34, PI / 2), M.antifoul);
      A.add(at(box(0.16, 0.30, 0.5), s * sep, -0.92, S.rudZ), M.antifoul);
      // sugar-scoop steps cantilevered off the transom down to a swim platform
      A.add(at(box(1.24, 0.30, 0.62), s * sep, 1.30, 8.14), M.gel);
      teakCap(A, 1.20, 0.56, s * sep, 1.475, 8.14, 0.04);
      A.add(at(box(1.30, 0.26, 0.90), s * sep, 0.86, 8.55), M.gel);
      teakCap(A, 1.26, 0.86, s * sep, 1.015, 8.55, 0.04);
      A.add(at(box(1.34, 0.70, 0.10), s * sep, 0.68, 8.05), M.gel);
      if (s < 0) {
        for (i = 0; i < 3; i++) {
          A.add(at(cyl(0.014, 0.014, 0.44, 6), s * sep, 0.62 - i * 0.24, 8.98, 0, 0, PI / 2), M.steel);
        }
        A.add(at(rod([s * sep - 0.22, 0.10, 9.00], [s * sep - 0.22, 1.36, 9.00], 0.017), 0, 0, 0), M.steel);
        A.add(at(rod([s * sep + 0.22, 0.10, 9.00], [s * sep + 0.22, 1.36, 9.00], 0.017), 0, 0, 0), M.steel);
      }
      // engine hatch let into the aft deck, on the real sheer, with its gasket
      var ehy = H.sheerAt(7.10);
      A.add(at(plate(0.86, 0.86, 0.6, 0.6), s * sep, ehy + 0.078, 7.10), M.nonskid);
      A.add(at(box(0.96, 0.06, 0.96), s * sep, ehy + 0.048, 7.10), M.gel);
      A.add(at(box(1.02, 0.022, 1.02), s * sep, ehy + 0.016, 7.10), M.gasket);
      // rubbing strake, stepped along the hull so it follows the flare
      for (i = 0; i < 14; i++) {
        var z0 = -6.6 + i * 1.02, z1 = z0 + 1.02;
        A.add(at(rod([s * (sep + H.halfAt(z0) * 0.985), H.sheerAt(z0) - 0.20, z0],
                     [s * (sep + H.halfAt(z1) * 0.985), H.sheerAt(z1) - 0.20, z1], 0.040, 8), 0, 0, 0), M.steelSat);
      }
    }
    // rudders and propellers spin / swing, so they live outside the merge
    P.rudders = []; P.props = [];
    for (s = -1; s <= 1; s += 2) {
      var rg = new T.Group();
      rg.position.set(s * sep, -0.95, S.rudZ);
      var rb = new T.Mesh(foil(0.60, 0.44, 0.16, 1.15, 0.10, 2), M.antifoul);
      rb.castShadow = true; rb.receiveShadow = true;
      rg.add(rb);
      root.add(rg); P.rudders.push(rg);

      var pg = new T.Group();
      pg.position.set(s * sep, -1.72, S.propZ - 0.34);
      var pa = [];
      for (i = 0; i < 3; i++) {
        var a = i * TAU / 3;
        pa.push(at(box(0.055, 0.20, 0.012), Math.cos(a) * 0.13, Math.sin(a) * 0.13, 0,
                  0, 0, a - PI / 2, 1, 1, 1));
      }
      pa.push(at(sph(0.05), 0, 0, 0));
      var pm = new T.Mesh(mergeAll(pa), M.steelSat);
      pm.castShadow = true;
      pg.add(pm);
      root.add(pg); P.props.push(pg);
    }
  }

  function buildBridgedeck(A, P) {
    /* Nacelle: the tunnel roof between the hulls, 0.95 m above the waterline.
       ExtrudeGeometry builds in XY and extrudes along +Z; after rotateX(-PI/2)
       a shape point (x, y) lands at model (x, *, -y) and the extrusion runs
       UP. So shapeY = -modelZ — the rounded wave-piercing nose belongs at
       POSITIVE shape Y, or the nacelle ends up pointing astern. */
    var nz = -S.zNacNose, az = -S.zNacAft;      // 5.30 (nose), -7.00 (transom)
    var sh = new T.Shape();
    sh.moveTo(-3.10, az);
    sh.lineTo(3.10, az);
    sh.lineTo(3.10, nz - 1.80);
    sh.quadraticCurveTo(1.90, nz, 0, nz);
    sh.quadraticCurveTo(-1.90, nz, -3.10, nz - 1.80);
    sh.closePath();
    var eg = new T.ExtrudeGeometry(sh, { depth: 0.58, bevelEnabled: false, curveSegments: 10 });
    eg.rotateX(-PI / 2);
    A.add(at(eg, 0, S.yNac, 0), M.gel);
    A.add(at(box(0.55, 0.34, 9.6), 0, S.yNac - 0.10, 1.0), M.gel);
    // structural forward crossbeam and its dolphin striker
    A.add(at(cyl(0.19, 0.22, 6.10, 12), 0, 1.66, S.zBeam, 0, 0, PI / 2), M.gel);
    A.add(at(rod([0, 1.54, S.zBeam], [0, 0.86, S.zBeam + 0.85], 0.045), 0, 0, 0), M.steel);
    if (WS) {
      WS.add([0, 0.86, S.zBeam + 0.85], [0, 1.44, S.zNacNose + 0.20], 0.011, 0, 1);
      WS.add([0, 0.86, S.zBeam + 0.85], [-2.85, 1.48, S.zBeam + 0.05], 0.010, 0, 1);
      WS.add([0, 0.86, S.zBeam + 0.85], [2.85, 1.48, S.zBeam + 0.05], 0.010, 0, 1);
    }
    A.add(at(box(6.20, 0.26, 0.30), 0, 1.50, 7.40), M.gel);
  }

  function buildDeck(A, P) {
    var H = HS, sep = S.hullSep, s, i;
    for (s = -1; s <= 1; s += 2) {
      var dk = deckLoft(H);
      A.add(at(dk.skid, s * sep, 0, 0), M.nonskid);
      A.add(at(dk.margin, s * sep, 0, 0), M.gel);
      A.add(at(dk.railP, s * sep, 0, 0), M.gel);
      A.add(at(dk.railS, s * sep, 0, 0), M.gel);
    }
    /* Trampolines: netting panels between the hulls, spanning the gap between
       the nacelle nose and the forward crossbeam. */
    var tzC = (S.zNacNose + S.zBeam) / 2, tzL = (S.zNacNose - S.zBeam) - 0.14;
    for (s = -1; s <= 1; s += 2) {
      var tg = new T.PlaneGeometry(1.95, tzL, 1, 1);
      tg.rotateX(-PI / 2);
      var a = tg.attributes.uv.array;
      for (i = 0; i < a.length; i += 2) { a[i] *= 9; a[i + 1] *= 9 * tzL / 1.95; }
      A.add(at(tg, s * 1.52, 1.70, tzC, 0.06), M.net);
      A.add(at(cyl(0.032, 0.032, tzL, 8), s * 0.54, 1.66, tzC, PI / 2, 0, 0.06), M.steelSat);
      A.add(at(cyl(0.032, 0.032, tzL, 8), s * 2.50, 1.74, tzC, PI / 2, 0, 0.06), M.steelSat);
    }
    /* Forward lounge (the Leopard signature): a sunken settee let into the
       coachroof front, reached through the door in the windscreen. */
    var fz = S.zSalF - 0.72;
    teakDeck(A, 2.56, 1.30, 0, 2.02, fz - 0.02, 0.05);
    A.add(at(cush(2.56, 0.40, 0.46), 0, 2.24, fz + 0.42), M.cushion);
    A.add(at(cush(2.56, 0.50, 0.13), 0, 2.50, fz + 0.68), M.cushion);
    A.add(at(box(2.70, 0.64, 0.10), 0, 2.30, fz - 0.68), M.gel);
    for (s = -1; s <= 1; s += 2) A.add(at(box(0.10, 0.64, 1.40), s * 1.33, 2.30, fz), M.gel);
    A.add(at(box(2.70, 0.30, 1.50), 0, 1.85, fz), M.gel);      // lounge footwell box
    /* Stanchions on the real sheer, each on a bolted base plate with a
       bedding gasket; the lifelines themselves are analytic wires. */
    var zs = [-6.9, -5.3, -3.7, -2.0, -0.3, 1.4, 3.1, 4.8, 6.4];
    for (s = -1; s <= 1; s += 2) {
      for (i = 0; i < zs.length; i++) {
        var xr = s * (sep + H.halfAt(zs[i]) * 0.90), yb = H.sheerAt(zs[i]) + 0.06;
        gasket(A, xr, yb - 0.008, zs[i], 0.048, 0.016);
        A.add(at(cyl(0.042, 0.046, 0.030, 12), xr, yb + 0.012, zs[i]), M.steelSat);
        A.add(at(cyl(0.019, 0.024, 0.68, 8), xr, yb + 0.34, zs[i]), M.steel);
        A.add(at(sph(0.026, 10, 8), xr, yb + 0.68, zs[i]), M.steel);
        if (i && WS) {
          var xp = s * (sep + H.halfAt(zs[i - 1]) * 0.90), y0 = H.sheerAt(zs[i - 1]) + 0.06;
          WS.add([xp, y0 + 0.66, zs[i - 1]], [xr, yb + 0.66, zs[i]], 0.0055, 0.018, 3);
          WS.add([xp, y0 + 0.38, zs[i - 1]], [xr, yb + 0.38, zs[i]], 0.0055, 0.022, 3);
        }
      }
      // coachroof handrails
      for (i = 0; i < 4; i++) {
        A.add(at(cyl(0.017, 0.017, 0.14, 8), s * 2.55, S.yRoof + 0.07, -3.6 + i * 1.5), M.steel);
        gasket(A, s * 2.55, S.yRoof + 0.012, -3.6 + i * 1.5, 0.030, 0.010);
      }
      A.add(at(rod([s * 2.55, S.yRoof + 0.14, -3.7], [s * 2.55, S.yRoof + 0.14, 0.9], 0.017, 8), 0, 0, 0), M.steel);
    }
  }
  /* --------------------------------------------------------------------------
     A hardtop that is not one flat value.
     The single largest object in the helm view is the underside of the top,
     and a bare slab gives the eye an untextured polygon before it reads
     anything else in the frame.  A real one is a headliner panel set inside
     a perimeter valance, carried on fore-and-aft tubes with athwartships
     battens behind it, and its leading edge is a rounded radius that catches
     a hot line of light.  All of that is linear shading structure the AO
     bake and the bounce term then have something to work with.
     ------------------------------------------------------------------------ */
  function hardtopUnder(A, x, y, z, w, d, tubeX, nBat) {
    var i, s;
    /* The headliner is split into four bays by the carry tubes and battens,
       each with its own UV origin, so the weave never marches across the
       whole panel as one continuous tile.  The tile is 0.30 m, which puts a
       thread at about 3.5 mm — fabric, not basketwork. */
    var bw = (w - 0.22) / 2, bd = (d - 0.22) / 2;
    for (s = 0; s < 4; s++) {
      var ox = (s & 1) ? bw / 2 : -bw / 2, oz = (s & 2) ? bd / 2 : -bd / 2;
      var pg = plate(bw, bd, 0.30, 0.30);
      // decorrelate the bays: a whole number of tiles plus a half, so the
      // seams of one bay never line up with the seams of the next
      var ua = pg.attributes.uv.array;
      for (i = 0; i < ua.length; i += 2) { ua[i] += s * 1.53; ua[i + 1] += s * 0.71; }
      A.add(at(pg, x + ox, y - 0.028, z + oz, PI, 0, 0), M.liner);
    }
    // recessed LED pucks in the headliner, on the fore-and-aft centre lines
    for (s = -1; s <= 1; s += 2) for (i = 0; i < 3; i++) {
      var lz = z - d * 0.28 + i * (d * 0.28);
      A.add(at(cyl(0.038, 0.042, 0.014, LOW() ? 8 : 20), x + s * (w * 0.24), y - 0.030, lz), M.steelSat);
      A.add(at(cyl(0.030, 0.030, 0.006, LOW() ? 8 : 18), x + s * (w * 0.24), y - 0.038, lz), M.canvasCream);
    }
    // bolt rows where the liner is screwed up into the moulding
    for (s = -1; s <= 1; s += 2) for (i = 0; i < 6; i++) {
      A.add(at(cyl(0.007, 0.007, 0.006, 6), x + s * (w / 2 - 0.10),
               y - 0.024, z - d / 2 + 0.16 + i * ((d - 0.32) / 5)), M.steel);
    }
    // perimeter valance, rounded so the leading edge carries a specular line
    A.add(at(cyl(0.055, 0.055, w, LOW() ? 6 : 10), x, y + 0.012, z - d / 2 + 0.045, 0, 0, PI / 2), M.gelGrey);
    A.add(at(cyl(0.055, 0.055, w, LOW() ? 6 : 10), x, y + 0.012, z + d / 2 - 0.045, 0, 0, PI / 2), M.gelGrey);
    A.add(at(cyl(0.050, 0.050, d, LOW() ? 6 : 10), x - w / 2 + 0.045, y + 0.012, z, PI / 2, 0, 0), M.gelGrey);
    A.add(at(cyl(0.050, 0.050, d, LOW() ? 6 : 10), x + w / 2 - 0.045, y + 0.012, z, PI / 2, 0, 0), M.gelGrey);
    // fore-and-aft carry tubes
    for (s = -1; s <= 1; s += 2) {
      A.add(at(cyl(0.042, 0.042, d - 0.14, LOW() ? 6 : 10), x + s * tubeX, y - 0.052, z, PI / 2, 0, 0), M.steelSat);
    }
    // batten pockets behind the panel: the dark bands that give it depth
    for (i = 0; i < nBat; i++) {
      var bz = z - d / 2 + (d / nBat) * (i + 0.5);
      A.add(at(cyl(0.028, 0.028, w - 0.20, LOW() ? 5 : 8), x, y - 0.048, bz, 0, 0, PI / 2), M.steelSat);
    }
    /* Overhead grab rails on the outboard edge, standing 60 mm proud on
       machined feet.  They are the one thing everybody reaches for coming up
       the steps, and their shadow is what breaks the panel up. */
    for (s = -1; s <= 1; s += 2) {
      var gx = x + s * (w / 2 - 0.30), z0 = z - d / 2 + 0.35, z1 = z + d / 2 - 0.35;
      A.add(at(rod([gx, y - 0.095, z0], [gx, y - 0.095, z1], 0.016, LOW() ? 6 : 10), 0, 0, 0), M.steel);
      for (i = 0; i < 3; i++) {
        var fz2 = z0 + (z1 - z0) * (i / 2);
        A.add(at(cyl(0.014, 0.019, 0.062, LOW() ? 6 : 12), gx, y - 0.060, fz2), M.steel);
      }
    }
  }

  function buildSuperstructure(A, P) {
    var s, i;
    var zSC = (S.zSalF + S.zSalA) / 2, zSL = S.zSalA - S.zSalF;      // saloon box
    var zRC = (S.zRoofF + S.zRoofA) / 2, zRL = S.zRoofA - S.zRoofF;  // roof
    A.add(at(box(6.30, 1.94, zSL), 0, 2.62, zSC), M.gel);
    // coachroof over the saloon, running aft as the cockpit hardtop
    A.add(at(box(6.46, 0.16, zRL), 0, S.yRoof, zRC), M.gelGrey);
    A.add(at(box(6.10, 0.10, 0.34), 0, S.yRoof - 0.10, S.zRoofF + 0.06, -0.22), M.gelGrey);
    // cockpit hardtop underside: liner, valance, tubes and battens
    hardtopUnder(A, 0, S.yRoof - 0.085, 4.75, 6.10, 3.60, 2.30, LOW() ? 3 : 5);
    // windscreen (forward raked) with the door through to the forward lounge
    A.add(at(panelXY(5.20, 1.14, 1, 1), 0, 3.02, S.zSalF - 0.06, -0.22), M.glass);
    A.add(at(box(0.60, 1.16, 0.05), 0, 2.98, S.zSalF - 0.11, -0.22), M.plastic);
    A.add(at(box(5.32, 0.13, 0.12), 0, 2.40, S.zSalF - 0.16), M.gel);
    for (s = -1; s <= 1; s += 2) {
      A.add(at(box(0.06, 0.86, zSL - 1.0), s * 3.13, 2.86, zSC), M.glass);
      A.add(at(box(0.09, 0.16, zSL - 0.9), s * 3.15, 3.36, zSC), M.gelGrey);
      A.add(at(box(0.09, 0.16, zSL - 0.9), s * 3.15, 2.38, zSC), M.gelGrey);
    }
    // aft saloon bulkhead: big sliding door onto the cockpit
    A.add(at(box(5.10, 1.60, 0.06), 0, 2.72, S.zSalA - 0.04), M.glass);
    A.add(at(box(5.30, 0.12, 0.10), 0, 3.54, S.zSalA - 0.04), M.gelGrey);
    A.add(at(box(0.10, 1.80, 0.10), 1.10, 2.66, S.zSalA - 0.07), M.steelSat);
    for (i = 0; i < 2; i++) {
      var z = -2.4 + i * 1.7;
      A.add(at(box(0.74, 0.08, 0.74), 0, S.yRoof + 0.11, z), M.glass);
      A.add(at(box(0.86, 0.09, 0.86), 0, S.yRoof + 0.07, z), M.steelSat);
      A.add(at(box(0.94, 0.02, 0.94), 0, S.yRoof + 0.085, z), M.gasket);
    }
    // flybridge hardtop: skin, solar array on top, structured underside
    A.add(at(box(6.20, 0.11, 5.20), 0, S.yBimini + 0.085, 0.60), M.gelGrey);
    A.add(at(box(5.60, 0.05, 4.10), 0, S.yBimini + 0.20, 0.60), M.solar);
    for (i = 0; i < 4; i++) {
      A.add(at(box(5.64, 0.03, 0.035), 0, S.yBimini + 0.226, -1.05 + i * 1.10), M.steelSat);
    }
    hardtopUnder(A, 0, S.yBimini + 0.02, 0.60, 6.20, 5.20, 2.62, LOW() ? 4 : 7);
    for (s = -1; s <= 1; s += 2) for (i = 0; i < 2; i++) {
      A.add(at(cyl(0.045, 0.052, S.yBimini - S.yFly, 10),
               s * 2.72, (S.yBimini + S.yFly) / 2, i ? 2.90 : -1.70), M.steelSat);
      gasket(A, s * 2.72, S.yFly + 0.02, i ? 2.90 : -1.70, 0.068, 0.020);
    }
    // davit arch aft
    for (s = -1; s <= 1; s += 2) {
      A.add(at(cyl(0.075, 0.085, 1.55, 10), s * 2.90, 2.30, 7.35), M.steelSat);
      gasket(A, s * 2.90, 1.55, 7.35, 0.105, 0.024);
    }
    A.add(at(cyl(0.075, 0.075, 5.80, 10), 0, 3.06, 7.35, 0, 0, PI / 2), M.steelSat);
    for (s = -1; s <= 1; s += 2) {
      A.add(at(box(0.10, 0.10, 1.20), s * 1.60, 3.00, 7.90), M.steelSat);
      if (WR) WR.add([s * 1.60, 2.96, 8.42], [s * 1.60, 2.30, 8.42], 0.010, 0, 1);
    }
    buildDinghy(A, 0, 2.05, 8.42);
  }

  /* Tender on the davits: two tapered tubes converging on a pointed bow,
     ply floor, console and outboard. It hangs in the middle of the view
     from the cockpit, so a bare cylinder will not do. */
  function buildDinghy(A, ox, oy, oz) {
    var s, i;
    var NT = 5;
    function tubePt(f, sd) {                   // along the tube, bow at f = 1
      return [ox - 1.42 + f * 2.84,
              oy + 0.02 + 0.10 * f * f,
              oz + sd * 0.60 * (1 - f * f * 0.96)];
    }
    for (s = -1; s <= 1; s += 2) {
      for (i = 0; i < NT; i++) {
        var f0 = i / NT, f1 = (i + 1) / NT;
        A.add(at(rod(tubePt(f0, s), tubePt(f1, s), 0.165 - 0.075 * f1, 8), 0, 0, 0), M.gelGrey);
      }
    }
    A.add(at(box(2.30, 0.05, 1.12), ox - 0.05, oy - 0.02, oz), M.gelGrey);
    A.add(at(box(0.07, 0.34, 1.24), ox - 1.44, oy + 0.12, oz), M.gelGrey);   // transom
    A.add(at(box(0.34, 0.30, 0.40), ox + 0.10, oy + 0.20, oz), M.plastic);   // console
    A.add(at(box(0.30, 0.05, 0.55), ox - 0.55, oy + 0.05, oz), M.plastic);   // thwart
    A.add(at(box(0.22, 0.34, 0.26), ox - 1.62, oy + 0.22, oz), M.plastic);   // outboard
    A.add(at(box(0.09, 0.40, 0.11), ox - 1.62, oy - 0.10, oz), M.plastic);
    A.add(at(cyl(0.11, 0.11, 0.03, 10), ox - 1.62, oy - 0.30, oz, 0, 0, PI / 2), M.steelSat);
    A.add(at(tor(0.10, 0.010, 6, 14), ox + 1.20, oy + 0.16, oz, PI / 2), M.rope);
  }

  /* A self-tailing winch: ribbed drum, waisted middle, jaws, stripper arm,
     bolted base pad on a bedding gasket, and three turns of sheet on the
     drum so it reads as a working part rather than a chrome ornament. */
  function winchGeom(r) {
    var wa = [], NS = LOW() ? 20 : 40, i;
    /* Waisted drum: the rope rides in the throat, so the profile has to
       narrow through the middle and flare at both ends.  Four short frusta
       give a readable curve without a lathe. */
    wa.push(at(cyl(r * 0.93, r * 1.00, 0.045, NS, 1, true), 0, 0.0225, 0));
    wa.push(at(cyl(r * 0.885, r * 0.93, 0.055, NS, 1, true), 0, 0.0725, 0));
    wa.push(at(cyl(r * 0.895, r * 0.885, 0.055, NS, 1, true), 0, 0.1275, 0));
    wa.push(at(cyl(r * 0.965, r * 0.895, 0.050, NS, 1, true), 0, 0.180, 0));
    wa.push(at(cyl(r * 1.005, r * 0.965, 0.026, NS, 1, true), 0, 0.218, 0));
    // knurl: vertical gripping ribs standing 1.5 mm proud of the drum
    var NK = LOW() ? 0 : 22;
    for (i = 0; i < NK; i++) {
      var a = i / NK * TAU;
      wa.push(at(box(0.0075, 0.155, 0.0075),
                 Math.cos(a) * r * 0.918, 0.108, Math.sin(a) * r * 0.918, 0, -a, 0));
    }
    // self-tailing jaws: two sprung rings with a rope-sized gap between them
    wa.push(at(tor(r * 1.02, 0.018, LOW() ? 6 : 12, NS), 0, 0.243, 0, PI / 2));
    wa.push(at(tor(r * 0.80, 0.016, LOW() ? 6 : 12, NS), 0, 0.265, 0, PI / 2));
    wa.push(at(cyl(r * 0.90, r * 0.90, 0.008, NS), 0, 0.254, 0));
    // handle socket, square drive, sunk into the crown
    wa.push(at(cyl(r * 0.56, r * 0.58, 0.030, LOW() ? 10 : 24), 0, 0.283, 0));
    wa.push(at(box(0.030, 0.014, 0.030), 0, 0.292, 0));
    // stripper arm: the hook that peels the tail out of the jaws
    wa.push(at(box(0.030, 0.040, r * 0.95), r * 0.72, 0.250, 0));
    wa.push(at(box(0.030, 0.055, 0.035), r * 0.72, 0.235, -r * 0.46));
    return mergeAll(wa);
  }

  function buildCockpit(A, root, P) {
    var s, i;
    var yC = S.yCock, cT = yC + S.coam;          // coaming top: 0.65 above sole
    /* A properly laid sole: margin board round the perimeter, king plank on
       the centreline, field planks fore and aft. */
    teakDeck(A, 5.90, 4.30, 0, yC, 4.85, 0.06);
    A.add(at(box(6.10, 0.14, 4.40), 0, yC - 0.13, 4.85), M.gel);
    // coamings, dimensioned off the real boat
    for (s = -1; s <= 1; s += 2) {
      A.add(at(box(0.16, S.coam - 0.05, 4.40), s * 3.03, yC + (S.coam - 0.05) / 2, 4.85), M.gel);
      teakCap(A, 0.26, 4.40, s * 3.03, cT, 4.85, 0.06);
    }
    A.add(at(box(6.10, 0.60, 0.16), 0, yC + 0.30, 7.05), M.gel);
    // L-shaped bench seating with stitched cushions
    A.add(at(box(5.60, 0.42, 0.62), 0, yC + 0.21, 6.60), M.gel);
    A.add(at(cush(5.50, 0.13, 0.60), 0, yC + 0.48, 6.60), M.cushion);
    A.add(at(cush(5.50, 0.30, 0.13), 0, yC + 0.62, 6.92), M.cushion);
    for (s = -1; s <= 1; s += 2) {
      A.add(at(box(0.60, 0.42, 2.20), s * 2.60, yC + 0.21, 5.20), M.gel);
      A.add(at(cush(0.58, 0.13, 2.10), s * 2.60, yC + 0.48, 5.20), M.cushion);
    }
    // folding cockpit table on a stainless pedestal
    A.add(at(cyl(0.05, 0.07, 0.56, 12), 0, yC + 0.28, 5.30), M.steel);
    gasket(A, 0, yC + 0.012, 5.30, 0.10, 0.016);
    teakCap(A, 1.90, 1.05, 0, yC + 0.585, 5.30, 0.05, M.steelSat);
    A.add(at(box(1.92, 0.03, 1.07), 0, yC + 0.54, 5.30), M.steelSat);
    // grab rail under the hardtop, right where your hand goes
    for (s = -1; s <= 1; s += 2) {
      A.add(at(rod([s * 2.80, S.yRoof - 0.24, 3.10], [s * 2.80, S.yRoof - 0.24, 6.60], 0.018, 8), 0, 0, 0), M.steel);
      for (i = 0; i < 3; i++) {
        A.add(at(cyl(0.016, 0.016, 0.14, 8), s * 2.80, S.yRoof - 0.16, 3.2 + i * 1.7), M.steel);
      }
    }
    // clutch banks + a cleat pair on each coaming
    for (s = -1; s <= 1; s += 2) {
      for (i = 0; i < 4; i++) {
        A.add(at(box(0.055, 0.10, 0.16), s * 2.62 + i * 0.062 * s, cT + 0.05, 4.05), M.plastic);
        A.add(at(box(0.045, 0.13, 0.05), s * 2.62 + i * 0.062 * s, cT + 0.15, 4.10, -0.5), M.steelSat);
      }
      A.add(at(box(0.062, 0.062, 0.34), s * 2.95, cT + 0.07, 6.30), M.steel);
      A.add(at(box(0.045, 0.10, 0.10), s * 2.95, cT + 0.12, 6.30), M.steel);
      gasket(A, s * 2.95, cT + 0.008, 6.30, 0.055, 0.012);
      A.add(at(tor(0.05, 0.016, 8, 16), s * 2.80, cT + 0.08, 3.55, 0, PI / 2, 0), M.steelSat);
    }
    // sheet and halyard tails coiled on the coaming
    for (s = -1; s <= 1; s += 2) {
      A.add(at(tor(0.16, 0.011, 6, 18), s * 2.72, cT + 0.06, 4.55, PI / 2, 0, 0.2), M.sheet);
      A.add(at(tor(0.14, 0.011, 6, 18), s * 2.72, cT + 0.08, 4.55, PI / 2, 0, -0.1), M.rope);
      if (WR) WR.add([s * 2.80, cT + 0.05, 3.55], [s * 2.66, cT + 0.06, 4.05], 0.010, 0.01, 2);
    }
    // helm/companionway steps up to the flybridge, starboard side
    for (i = 0; i < 4; i++) {
      teakCap(A, 0.70, 0.28, 2.30, yC + 0.305 + i * 0.56, 3.30 - i * 0.16, 0.05);
      A.add(at(box(0.74, 0.30, 0.05), 2.30, yC + 0.16 + i * 0.56, 3.42 - i * 0.16), M.gel);
    }
    A.add(at(rod([2.68, yC + 0.60, 3.40], [2.68, S.yFly + 0.30, 2.70], 0.019, 8), 0, 0, 0), M.steel);

    // winches: two primaries on the coamings, two on the flybridge, two aft
    P.winches = [];
    var spots = [
      [2.72, cT + 0.02, 3.95, 0.105], [-2.72, cT + 0.02, 3.95, 0.105],
      [2.45, S.yFly + 0.04, 1.70, 0.095], [-2.45, S.yFly + 0.04, 1.70, 0.095],
      [1.35, S.yFly + 0.04, -1.15, 0.085], [-1.35, S.yFly + 0.04, -1.15, 0.085]
    ];
    for (i = 0; i < spots.length; i++) {
      var sp = spots[i];
      gasket(A, sp[0], sp[1] + 0.006, sp[2], sp[3] * 1.50, 0.014);
      A.add(at(cyl(sp[3] * 1.32, sp[3] * 1.42, 0.055, 18), sp[0], sp[1] + 0.038, sp[2]), M.steelSat);
      var wg = new T.Group();
      wg.position.set(sp[0], sp[1] + 0.063, sp[2]);
      var wm = new T.Mesh(winchGeom(sp[3]), M.winch);
      wm.castShadow = true; wm.receiveShadow = true;
      wg.add(wm);
      // three turns of sheet on the drum
      var rw = new T.Mesh(mergeAll([
        at(tor(sp[3] * 1.05, 0.012, 6, 20), 0, 0.055, 0, PI / 2),
        at(tor(sp[3] * 1.05, 0.012, 6, 20), 0, 0.081, 0, PI / 2),
        at(tor(sp[3] * 1.02, 0.012, 6, 20), 0, 0.107, 0, PI / 2)
      ]), M.sheet);
      rw.castShadow = true; rw.receiveShadow = true;
      wg.add(rw);
      root.add(wg);
      P.winches.push(wg);
      if (i < 2) {
        A.add(at(box(0.035, 0.035, 0.26), sp[0] + (sp[0] > 0 ? 0.26 : -0.26), sp[1] + 0.06, sp[2] + 0.22), M.plastic);
        A.add(at(cyl(0.022, 0.022, 0.10, 8), sp[0] + (sp[0] > 0 ? 0.26 : -0.26), sp[1] + 0.06, sp[2] + 0.36, PI / 2), M.rubber);
      }
    }
  }

  function buildFlybridge(A, root, P) {
    var s, i;
    teakDeck(A, 6.00, 4.80, 0, S.yFly, 0.55, 0.06);
    A.add(at(box(6.20, 0.16, 5.00), 0, S.yFly - 0.13, 0.55), M.gel);
    for (s = -1; s <= 1; s += 2) {
      A.add(at(box(0.14, 0.76, 5.00), s * 3.03, S.yFly + 0.38, 0.55), M.gel);
      teakCap(A, 0.24, 5.00, s * 3.03, S.yFly + 0.80, 0.55, 0.06);
    }
    A.add(at(box(6.20, 0.76, 0.14), 0, S.yFly + 0.38, 3.05), M.gel);
    /* The inboard face of each coaming is 5 m of blank moulding that fills a
       third of the helm frame.  A real one carries a run of locker lids with
       6 mm parting lines, flush pulls, and a moulded reveal at half height —
       details that are worth more than any amount of shader work because
       they give the eye a rhythm to read the surface by. */
    for (s = -1; s <= 1; s += 2) {
      A.add(at(box(0.012, 0.030, 4.60), s * 2.945, S.yFly + 0.30, 0.55), M.gasket);
      for (i = 0; i < 4; i++) {
        var lz = -1.40 + i * 1.15;
        A.add(at(box(0.026, 0.44, 1.02), s * 2.945, S.yFly + 0.54, lz), M.gel);
        A.add(at(box(0.010, 0.48, 0.010), s * 2.930, S.yFly + 0.54, lz - 0.53), M.gasket);
        A.add(at(box(0.010, 0.48, 0.010), s * 2.930, S.yFly + 0.54, lz + 0.53), M.gasket);
        A.add(at(cyl(0.028, 0.028, 0.014, LOW() ? 8 : 22),
                 s * 2.925, S.yFly + 0.54, lz + 0.36, 0, 0, PI / 2), M.steelSat);
      }
      // teak handrail along the coaming, and a drain at each after corner
      A.add(at(rod([s * 2.90, S.yFly + 0.86, -1.95], [s * 2.90, S.yFly + 0.86, 2.90],
                   0.021, LOW() ? 6 : 12), 0, 0, 0), M.teak);
      for (i = 0; i < 3; i++) {
        A.add(at(cyl(0.017, 0.023, 0.055, LOW() ? 6 : 12),
                 s * 2.90, S.yFly + 0.815, -1.6 + i * 2.2), M.steel);
      }
      A.add(at(cyl(0.036, 0.036, 0.016, LOW() ? 8 : 20), s * 2.72, S.yFly + 0.004, 2.72), M.steelSat);
      A.add(at(cyl(0.026, 0.026, 0.020, LOW() ? 8 : 16), s * 2.72, S.yFly - 0.006, 2.72), M.gasket);
    }
    /* Two flush deck hatches in the sole with recessed lift rings: the sole is
       the largest single surface in the cockpit and it needs hardware on it. */
    for (i = 0; i < 2; i++) {
      var hzz = -0.70 + i * 1.60;
      A.add(at(box(0.62, 0.014, 0.62), -1.30, S.yFly + 0.007, hzz), M.teak);
      A.add(at(box(0.66, 0.008, 0.66), -1.30, S.yFly + 0.002, hzz), M.gasket);
      A.add(at(tor(0.035, 0.008, LOW() ? 6 : 10, LOW() ? 10 : 26),
               -1.30, S.yFly + 0.016, hzz + 0.22, PI / 2), M.steelSat);
    }
    A.add(at(panelXY(5.90, 0.62, 1, 1), 0, S.yFly + 0.42, -1.90, -0.16), M.glass);
    A.add(at(box(6.00, 0.62, 0.10), 0, S.yFly + 0.30, -1.96, -0.16), M.gel);
    // sunbed / L-settee to port
    A.add(at(box(2.60, 0.44, 1.80), -1.55, S.yFly + 0.22, 1.90), M.gel);
    A.add(at(cush(2.50, 0.14, 1.72), -1.55, S.yFly + 0.51, 1.90), M.cushion);
    A.add(at(cush(2.50, 0.42, 0.14), -1.55, S.yFly + 0.70, 2.80), M.cushion);
    // helm seat to starboard
    A.add(at(box(1.30, 0.42, 0.58), 1.90, S.yFly + 0.21, -0.10), M.gel);
    A.add(at(cush(1.24, 0.14, 0.54), 1.90, S.yFly + 0.49, -0.10), M.cushion);
    A.add(at(cush(1.24, 0.52, 0.14), 1.90, S.yFly + 0.72, 0.16), M.cushion);
    A.add(at(cyl(0.06, 0.06, 0.30, 10), 1.90, S.yFly + 0.15, -0.10), M.steel);

    /* ---- helm console ----------------------------------------------------
       The helmsman stands AFT of the console (larger z), so the dash panel
       is raked +0.55 rad to face up and aft, toward him — and everything
       mounted on it is offset along that panel's normal, not the world Y. */
    var hx = 2.05, hy = S.yFly, hz = -1.05;
    var DT = 0.55, dn = [0, Math.cos(DT), Math.sin(DT)];      // dash normal
    var dcy = hy + 0.94, dcz = hz - 0.46;                     // dash panel centre
    function onDash(dx, dv, out) {                            // dash-local -> model
      return [hx + dx,
              dcy + dn[1] * out - dv * Math.sin(DT),
              dcz + dn[2] * out + dv * Math.cos(DT)];
    }
    /* The console body is glossy white gelcoat, not grey card: three mouldings
       with 6 mm parting lines between them, a shadow gap under the dash brow
       and a stainless fiddle across the front.  The reveals are what let the
       sun separate the top from the face — a single box cannot. */
    A.add(at(box(1.70, 0.30, 0.52), hx, hy + 0.16, hz - 0.44), M.gelGrey);   // plinth
    A.add(at(box(1.74, 0.015, 0.55), hx, hy + 0.315, hz - 0.44), M.gasket);  // shadow gap
    A.add(at(box(1.70, 0.40, 0.52), hx, hy + 0.545, hz - 0.44), M.gel);      // locker face
    for (i = 0; i < 2; i++) {                                   // locker lid parting lines
      A.add(at(box(0.008, 0.36, 0.53), hx - 0.28 + i * 0.56, hy + 0.545, hz - 0.44), M.gasket);
    }
    for (i = 0; i < 3; i++) {                                   // flush ring pulls
      A.add(at(cyl(0.026, 0.026, 0.010, LOW() ? 10 : 24),
               hx - 0.56 + i * 0.56, hy + 0.545, hz - 0.185, PI / 2), M.steelSat);
    }
    A.add(at(box(1.76, 0.055, 0.56), hx, hy + 0.772, hz - 0.44), M.gel);     // capping
    /* Radiused edges.  A moulded gelcoat box has a 20 mm corner radius on
       every arris, and that radius is what carries the long blown specular
       line that tells you the surface is glossy.  Square-cut boxes cannot
       produce it at any roughness, which is why an untreated console reads
       as flat card no matter how good the material is. */
    var NE = LOW() ? 6 : 14;
    for (i = -1; i <= 1; i += 2) {                       // vertical corners
      for (s = -1; s <= 1; s += 2) {
        A.add(at(cyl(0.020, 0.020, 0.70, NE), hx + i * 0.85, hy + 0.545, hz - 0.44 + s * 0.26), M.gel);
      }
    }
    A.add(at(cyl(0.022, 0.022, 1.70, NE), hx, hy + 0.772, hz - 0.72, 0, 0, PI / 2), M.gel);
    A.add(at(cyl(0.022, 0.022, 1.70, NE), hx, hy + 0.772, hz - 0.16, 0, 0, PI / 2), M.gel);
    A.add(at(rod([hx - 0.74, hy + 0.83, hz - 0.185], [hx + 0.74, hy + 0.83, hz - 0.185],
                 0.014, LOW() ? 6 : 12), 0, 0, 0), M.steel);                 // fiddle rail
    for (i = 0; i < 2; i++) {
      A.add(at(cyl(0.012, 0.016, 0.052, LOW() ? 6 : 12),
               hx - 0.60 + i * 1.20, hy + 0.805, hz - 0.185), M.steel);
    }
    // dark low-glare dash field, set into a white surround
    A.add(at(box(1.76, 0.05, 0.50), hx, dcy - 0.008, dcz, DT), M.gel);
    A.add(at(box(1.62, 0.05, 0.40), hx, dcy + 0.004, dcz, DT), M.dash);
    // moulded brow over the dash: keeps the sun off the screens and, more to
    // the point, throws a hard shadow line across the instruments
    var bw = onDash(0, 0.245, 0.085);
    A.add(at(box(1.76, 0.030, 0.13), bw[0], bw[1], bw[2], DT - 0.30), M.gelGrey);
    A.add(at(box(1.76, 0.014, 0.030), bw[0], bw[1] - 0.028, bw[2] + 0.045, DT - 0.30), M.gasket);
    // chartplotter, sunk into the panel behind a bezel with a glass front
    var pp = onDash(0.30, -0.02, 0.030);
    A.add(at(box(0.60, 0.012, 0.38), pp[0], pp[1], pp[2], DT), M.screen);
    pp = onDash(0.30, -0.02, 0.012);
    A.add(at(box(0.70, 0.048, 0.45), pp[0], pp[1], pp[2], DT), M.plastic);
    pp = onDash(0.30, -0.02, 0.041);
    A.add(at(box(0.615, 0.004, 0.395), pp[0], pp[1], pp[2], DT), M.instGlass);
    /* Instrument pods.  Bezel depth, the dial face inset 9 mm below the glass
       so the needle parallaxes against it as the head moves, a chromed rim
       that catches the sun, and a clearcoat glass plane over the top. */
    var NB = LOW() ? 16 : 48;
    for (i = 0; i < 3; i++) {
      var cxd = -0.34 + i * 0.17;
      pp = onDash(cxd, 0.02, 0.006);                        // housing, sunk in
      A.add(at(cyl(0.062, 0.064, 0.052, NB), pp[0], pp[1], pp[2], DT), M.plastic);
      pp = onDash(cxd, 0.02, 0.030);                        // dial face
      A.add(at(cyl(0.052, 0.052, 0.008, NB), pp[0], pp[1], pp[2], DT), M.dial);
      pp = onDash(cxd, 0.02, 0.0345);                       // needle, proud of the face
      A.add(at(box(0.006, 0.004, 0.070), pp[0], pp[1], pp[2], DT, 0.6 - i * 0.5, 0), M.plastic);
      pp = onDash(cxd, 0.02, 0.0365);
      A.add(at(cyl(0.008, 0.008, 0.006, LOW() ? 8 : 16), pp[0], pp[1], pp[2], DT), M.steel);
      pp = onDash(cxd, 0.02, 0.039);                        // chromed bezel rim
      A.add(at(tor(0.0575, 0.0055, LOW() ? 6 : 12, NB), pp[0], pp[1], pp[2], DT + PI / 2), M.steel);
      pp = onDash(cxd, 0.02, 0.0385);                       // glass
      A.add(at(cyl(0.055, 0.055, 0.003, NB), pp[0], pp[1], pp[2], DT), M.instGlass);
    }
    // twin throttle / gear levers on a side console to port
    A.add(at(box(0.26, 0.06, 0.26), hx - 0.74, hy + 0.96, hz - 0.24), M.steelSat);
    for (i = 0; i < 2; i++) {
      A.add(at(cyl(0.011, 0.016, 0.26, 8), hx - 0.79 + i * 0.10, hy + 1.09, hz - 0.22, -0.28), M.steel);
      A.add(at(sph(0.022, 10, 8), hx - 0.79 + i * 0.10, hy + 1.21, hz - 0.18), M.rubber);
    }
    /* Binnacle compass.  A 200 mm dome standing on a machined ring — the ring
       is what gives it an occlusion collar where it meets the dash instead of
       looking like a marble dropped on a table. */
    var NC = LOW() ? 12 : 32;
    pp = onDash(0.72, 0.00, 0.055);
    A.add(at(sph(0.072, NC, LOW() ? 8 : 22), pp[0], pp[1], pp[2]), M.glass);
    A.add(at(cyl(0.070, 0.070, 0.012, NC), pp[0], pp[1] - 0.012, pp[2]), M.canvasCream);
    pp = onDash(0.72, 0.00, 0.030);
    A.add(at(tor(0.0755, 0.006, LOW() ? 6 : 12, NC), pp[0], pp[1], pp[2], DT + PI / 2), M.steel);
    pp = onDash(0.72, 0.00, 0.012);
    A.add(at(cyl(0.082, 0.086, 0.07, NC), pp[0], pp[1], pp[2], DT), M.plastic);
    pp = onDash(0.72, 0.00, -0.004);
    A.add(at(cyl(0.094, 0.098, 0.014, NC), pp[0], pp[1], pp[2], DT), M.gasket);
    // pedestal, with a boot and a bedding gasket so it is seated on the sole
    A.add(at(cyl(0.075, 0.115, 0.82, LOW() ? 12 : 28), hx, hy + 0.41, hz), M.steel);
    A.add(at(cyl(0.13, 0.15, 0.05, LOW() ? 12 : 28), hx, hy + 0.03, hz), M.steelSat);
    A.add(at(cyl(0.155, 0.17, 0.028, LOW() ? 12 : 28), hx, hy + 0.012, hz), M.rubber);
    gasket(A, hx, hy + 0.004, hz, 0.185, 0.014);

    /* ---- destroyer wheel -------------------------------------------------
       1.00 m over the rim, which is what a 52 ft catamaran carries and what
       makes the helm view read at the right size: the wheel dominates the
       lower frame with the coaming at mid-chest. */
    var tilt = new T.Group();
    tilt.position.set(hx, hy + 0.94, hz);
    tilt.rotation.x = -0.28;
    root.add(tilt);
    var wheel = new T.Group();
    tilt.add(wheel);
    /* The rim occupies the lower third of the helm frame, so it gets the
       triangles: 88 segments round and 20 across the tube puts the facet
       error under a tenth of a pixel at arm's length.  A visibly polygonal
       circle in the foreground is an instant CG tell that no shading fixes. */
    var R = 0.50, NR = LOW() ? 36 : 88, NT2 = LOW() ? 10 : 20;
    var wa = [], la = [];
    la.push(at(tor(R, 0.028, NT2, NR), 0, 0, 0));
    wa.push(at(cyl(0.065, 0.065, 0.09, LOW() ? 14 : 36), 0, 0, 0, PI / 2));
    wa.push(at(cyl(0.030, 0.030, 0.14, LOW() ? 10 : 24), 0, 0, 0, PI / 2));
    // hub boss detail: six countersunk bolts round the spoke root
    for (i = 0; i < 6; i++) {
      var ha = i * PI / 3;
      wa.push(at(cyl(0.007, 0.007, 0.006, 8),
                 Math.cos(ha) * 0.046, Math.sin(ha) * 0.046, 0.047, PI / 2));
    }
    for (i = 0; i < 6; i++) {
      var a = i * PI / 3 + PI / 2;
      wa.push(at(cyl(0.011, 0.016, R - 0.050, LOW() ? 8 : 16),
                 Math.cos(a) * (R - 0.02) / 2, Math.sin(a) * (R - 0.02) / 2, 0,
                 0, 0, a - PI / 2));
      wa.push(at(sph(0.028, LOW() ? 10 : 24, LOW() ? 8 : 16),
                 Math.cos(a) * (R - 0.02), Math.sin(a) * (R - 0.02), 0.028));
    }
    // king-spoke marker: how you read the helm angle at a glance
    wa.push(at(box(0.05, 0.09, 0.05), 0, R, 0));
    var wm1 = new T.Mesh(mergeAll(wa), M.steel);
    var wm2 = new T.Mesh(mergeAll(la), M.leather);
    wm1.castShadow = wm2.castShadow = true;
    wm1.receiveShadow = wm2.receiveShadow = true;
    wheel.add(wm1); wheel.add(wm2);
    P.wheel = wheel;

    /* First-person eye points, rigidly attached to the boat.  1.62 m above
       the sole is a standing adult's eye height; anything less and the whole
       set reads as a game level rather than a photographed boat. */
    anchor(root, 'helmEye', hx - 0.02, S.yFly + 1.62, hz + 0.66, P);
    anchor(root, 'cockpitEye', -1.10, S.yCock + 1.62, 5.35, P);
  }
  /* A rigging terminal: swage, bottlescrew body with its two lock nuts, and
     a clevis pin through the toggle.  Perfectly uniform wire that simply
     stops at the deck is one of the loudest debug-primitive tells. */
  function terminal(A, x, y, z, dirY, len, r) {
    var d = dirY >= 0 ? 1 : -1;
    A.add(at(cyl(r * 0.55, r, len * 0.28, 10), x, y + d * len * 0.86, z), M.steel);   // swage
    A.add(at(cyl(r, r, len * 0.52, 8), x, y + d * len * 0.50, z), M.steelSat);        // body
    A.add(at(cyl(r * 1.22, r * 1.22, len * 0.09, 6), x, y + d * len * 0.70, z), M.steel);
    A.add(at(cyl(r * 1.22, r * 1.22, len * 0.09, 6), x, y + d * len * 0.30, z), M.steel);
    A.add(at(box(r * 2.2, len * 0.22, r * 0.9), x, y + d * len * 0.12, z), M.steel);  // toggle
    A.add(at(cyl(r * 0.42, r * 0.42, r * 3.0, 8), x, y + d * len * 0.12, z, 0, 0, PI / 2), M.steel);
  }

  function buildRig(A, root, P) {
    var mz = S.mastZ, mb = S.mastBase, mt = S.mastTop, s, i;
    var L = mt - mb;
    /* The spar is a real extruded section, not a capsule: rounded leading
       edge, slab sides with two hard specular corners running its full
       length, and the sail track sunk into a raised aft boss. */
    A.add(at(sparGeom(L, 0.175, 0.108, LOW() ? 5 : 12), 0, mb, mz), M.mast);
    A.add(at(cyl(0.21, 0.23, 0.16, 16), 0, mb + 0.06, mz), M.steelSat);      // mast step
    gasket(A, 0, mb - 0.012, mz, 0.26, 0.026);
    A.add(at(cyl(0.10, 0.125, 0.30, 14), 0, mt + 0.14, mz), M.mast);         // masthead
    A.add(at(box(0.10, 0.09, 0.60), 0, mt + 0.20, mz - 0.24), M.steelSat);   // masthead crane
    A.add(at(cyl(0.05, 0.05, 0.06, 12), 0, mt + 0.20, mz - 0.50, PI / 2), M.steelSat);
    // halyard exit plates and a winch pad low on the spar
    for (s = -1; s <= 1; s += 2) {
      A.add(at(box(0.012, 0.30, 0.09), s * 0.112, mb + 2.30, mz + 0.02), M.steelSat);
      A.add(at(box(0.012, 0.24, 0.08), s * 0.108, mb + 3.55, mz - 0.02), M.steelSat);
    }
    // wind instrument
    A.add(at(cyl(0.012, 0.012, 0.42, 6), 0, mt + 0.52, mz), M.plastic);
    A.add(at(box(0.30, 0.02, 0.09), 0, mt + 0.74, mz), M.plastic);

    // two sets of aft-swept spreaders, with chafe boots at the tips
    var spr = [[11.60, 2.30, 1.00], [18.20, 1.85, 0.80]];
    for (i = 0; i < spr.length; i++) {
      for (s = -1; s <= 1; s += 2) {
        var tip = [s * spr[i][1], spr[i][0] - 0.10, mz + spr[i][2]];
        A.add(at(rod([s * 0.12, spr[i][0], mz], tip, 0.036, 8), 0, 0, 0), M.mast);
        A.add(at(sph(0.045, 10, 8), tip[0], tip[1], tip[2]), M.steelSat);
        A.add(at(cyl(0.055, 0.048, 0.20, 10), tip[0] * 1.02, tip[1] + 0.06, tip[2] * 1.0), M.rubber);
      }
      A.add(at(box(0.26, 0.10, 0.22), 0, spr[i][0], mz + 0.02), M.mast);
    }

    /* Standing rigging as analytic wires.  Sag varies by tension: the cap
       shroud is set up hard and is almost straight, the D1 carries less and
       droops perceptibly.  A single sag constant applied to everything is
       what made the old rig read as generated. */
    var chp = [3.85, 1.72, 0.60], chi = [2.90, 1.70, 0.42];
    var head = [0, S.forestayHeadY, mz], top = [0, mt - 0.25, mz];
    for (s = -1; s <= 1; s += 2) {
      var t1 = [s * spr[0][1], spr[0][0] - 0.10, mz + spr[0][2]];
      var t2 = [s * spr[1][1], spr[1][0] - 0.10, mz + spr[1][2]];
      if (WS) {
        WS.add(top, t2, 0.0060, 0.030, 4);
        WS.add(t2, t1, 0.0060, 0.035, 4);
        WS.add(t1, [s * chp[0], chp[1] + 0.34, chp[2]], 0.0062, 0.028, 5);
        WS.add([s * 0.14, spr[1][0], mz], t1, 0.0048, 0.060, 4);          // D2
        WS.add([s * 0.15, spr[0][0], mz], [s * chi[0], chi[1] + 0.28, chi[2]], 0.0052, 0.075, 5);
      }
      // chainplates, bottlescrews and clevis pins
      terminal(A, s * chp[0], chp[1] - 0.02, chp[2], 1, 0.36, 0.019);
      terminal(A, s * chi[0], chi[1] - 0.02, chi[2], 1, 0.30, 0.016);
      A.add(at(box(0.05, 0.30, 0.05), s * chp[0], chp[1] - 0.20, chp[2]), M.steel);
      gasket(A, s * chp[0], chp[1] - 0.34, chp[2], 0.055, 0.014);
      gasket(A, s * chi[0], chi[1] - 0.30, chi[2], 0.048, 0.014);
    }
    var tack = [0, S.forestayY, S.forestayZ];
    if (WS) WS.add(head, [tack[0], tack[1] + 0.55, tack[2]], 0.0068, 0.020, 5);
    // furling foil over the forestay + the furling drum on the tack fitting
    A.add(at(rod([head[0], head[1] - 0.4, head[2] + 0.12],
                 [tack[0], tack[1] + 0.55, tack[2] - 0.02], 0.030, 8), 0, 0, 0), M.mast);
    A.add(at(cyl(0.13, 0.13, 0.22, 16), tack[0], tack[1] + 0.30, tack[2] - 0.01), M.plastic);
    terminal(A, tack[0], tack[1] + 0.02, tack[2], 1, 0.26, 0.017);

    /* ---- boom, vang, stackpack, lazy jacks (all on a pivot group) ------- */
    var boom = new T.Group();
    boom.position.set(0, S.goose, mz + 0.20);
    root.add(boom);
    P.boom = boom;
    var E = S.boomE, ba = new Acc();
    // the boom is the same extruded family as the mast, laid on its side
    var bg = sparGeom(E, 0.135, 0.112, LOW() ? 4 : 8);
    bg.rotateX(PI / 2); bg.rotateZ(PI);      // axis -> +Z aft, sail track up
    ba.add(at(bg, 0, 0.16, 0), M.mast);
    ba.add(at(box(0.28, 0.16, 0.22), 0, 0.06, 0.10), M.steelSat);           // gooseneck fitting
    ba.add(at(box(0.14, 0.24, 0.26), 0, 0.16, E - 0.05), M.steelSat);       // outhaul car
    ba.add(at(cyl(0.05, 0.05, 0.06, 12), 0, 0.16, E + 0.06, PI / 2), M.steelSat);
    ba.add(at(box(0.10, 0.20, 0.34), 0, 0.02, E * 0.70), M.steelSat);
    ba.add(at(box(0.10, 0.16, 0.14), 0, 0.04, 0.85), M.steelSat);
    var pk = packGeom(E - 0.5, 0.40, 0.30);
    ba.add(at(pk, 0, 0.20, (E - 0.5) / 2 + 0.25), M.canvasNavy);
    for (s = -1; s <= 1; s += 2) {
      ba.add(at(rod([s * 0.36, 0.56, 0.30], [s * 0.27, 0.48, E - 0.30], 0.012, 6), 0, 0, 0), M.steelSat);
    }
    var bw = new WireAcc();
    for (s = -1; s <= 1; s += 2) for (i = 0; i < 3; i++) {
      var zz = 1.2 + i * 2.1;
      bw.add([s * 0.34, 0.52, zz], [s * 0.62, 2.60, zz * 0.55 + 0.6], 0.0045, 0.02, 3);
    }
    ba.flush(boom, 'boom');
    var bwm = bw.mesh(MWR, 'boom.jacks');
    if (bwm) { boom.add(bwm); P.boomJacks = bwm; }
    anchor(boom, 'boomEnd', 0, 0.16, E, P);
    anchor(boom, 'gooseneck', 0, 0, 0, P);

    // static lazy-jack legs from the spreaders (the boom-side half moves)
    if (WR) for (s = -1; s <= 1; s += 2) {
      WR.add([s * 0.62, S.goose + 2.60, mz + 1.4],
             [s * spr[0][1] * 0.85, spr[0][0] - 0.25, mz + spr[0][2] * 0.9], 0.0045, 0.03, 3);
    }
    // running rigging led aft along the coachroof to the clutches
    if (WR) for (s = -1; s <= 1; s += 2) for (i = 0; i < 3; i++) {
      var xo = s * (0.10 + i * 0.07);
      WR.add([xo, mb + 0.30, mz + 0.16], [s * (0.55 + i * 0.12), S.yRoof + 0.05, mz + 0.55], 0.0055, 0.01, 2);
      WR.add([s * (0.55 + i * 0.12), S.yRoof + 0.05, mz + 0.55],
             [s * (1.10 + i * 0.10), S.yFly + 0.06, -1.35], 0.0055, 0.02, 3);
    }
    for (s = -1; s <= 1; s += 2) {
      A.add(at(box(0.24, 0.09, 0.14), s * 0.22, mb + 0.24, mz + 0.10), M.plastic);
      if (WR) WR.add([s * 0.05, mt - 0.4, mz + 0.14], [s * 0.22, mb + 0.30, mz + 0.10], 0.0050, 0.02, 3);
    }
    anchor(root, 'mastTop', 0, mt, mz, P);
    anchor(root, 'forestayTack', tack[0], tack[1], tack[2], P);
    anchor(root, 'forestayHead', head[0], head[1], head[2], P);

    /* ---- dynamic mainsheet tackle and rigid vang ----------------------- */
    P.tackle = [];
    for (i = 0; i < 3; i++) {
      var mline = new T.Mesh(cyl(0.011, 0.011, 1, 6, 1, true), M.sheet);
      mline.castShadow = false; mline.receiveShadow = false;
      root.add(mline); P.tackle.push(mline);
    }
    var vang = new T.Mesh(cyl(0.045, 0.055, 1, 10, 1, true), M.steelSat);
    vang.castShadow = true; root.add(vang); P.vang = vang;
    A.add(at(box(2.60, 0.07, 0.10), 0, S.yBimini + 0.18, 2.95), M.steelSat);
    P.travellerY = S.yBimini + 0.24; P.travellerZ = 2.95;
  }

  /* U-section canvas trough for the stackpack. */
  function packGeom(len, rA, rB) {
    var nL = LOW() ? 5 : 9, nA = LOW() ? 5 : 9;
    var pos = [], uv = [], idx = [], i, j;
    for (i = 0; i <= nL; i++) {
      var s = i / nL, r = lerp(rA, rB, s), z = -len / 2 + len * s;
      var sag = 0.05 * Math.sin(s * PI);
      for (j = 0; j <= nA; j++) {
        var th = -PI * (0.07 + 0.86 * (j / nA));
        pos.push(Math.cos(th) * r, Math.sin(th) * r * 0.85 - sag + 0.10, z);
        uv.push(j / nA * 1.4, s * len / 1.2);
      }
    }
    var M2 = nA + 1;
    for (i = 0; i < nL; i++) for (j = 0; j < nA; j++) {
      var a = i * M2 + j, b = a + 1, c = a + M2, d = c + 1;
      idx.push(a, c, d, a, d, b);
    }
    var g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  function buildForedeck(A, root, P) {
    var s, i;
    // bow pulpit
    var pul = [[-1.05, 2.30, -7.35], [-0.95, 2.34, -8.05], [0, 2.36, -8.45],
               [0.95, 2.34, -8.05], [1.05, 2.30, -7.35]];
    for (i = 0; i < pul.length - 1; i++) {
      A.add(at(rod(pul[i], pul[i + 1], 0.017, 8), 0, 0, 0), M.steel);
      if (WS) WS.add([pul[i][0], pul[i][1] - 0.30, pul[i][2]],
                     [pul[i + 1][0], pul[i + 1][1] - 0.30, pul[i + 1][2]], 0.0055, 0.008, 2);
      A.add(at(cyl(0.020, 0.024, 0.62, 8), pul[i][0], pul[i][1] - 0.31, pul[i][2]), M.steel);
      gasket(A, pul[i][0], pul[i][1] - 0.615, pul[i][2], 0.042, 0.014);
    }
    A.add(at(cyl(0.020, 0.024, 0.62, 8), pul[4][0], pul[4][1] - 0.31, pul[4][2]), M.steel);
    // anchor roller assembly on the stem head
    A.add(at(box(0.30, 0.14, 1.10), 0, 1.86, -8.05), M.steelSat);
    A.add(at(cyl(0.075, 0.075, 0.16, 14), 0, 1.90, -8.48, 0, 0, PI / 2), M.steelSat);
    A.add(at(cyl(0.055, 0.055, 0.16, 14), 0, 1.86, -7.75, 0, 0, PI / 2), M.steelSat);
    // windlass with a gypsy and a warping drum
    A.add(at(box(0.40, 0.20, 0.50), 0, 1.86, -7.10), M.gelGrey);
    gasket(A, 0, 1.765, -7.10, 0.24, 0.022);
    A.add(at(cyl(0.11, 0.11, 0.13, 16), 0, 1.99, -7.10), M.steelSat);
    A.add(at(cyl(0.085, 0.10, 0.17, 16), 0.27, 1.98, -7.10), M.winch);
    A.add(at(box(0.16, 0.06, 0.16), -0.26, 1.94, -7.10), M.plastic);
    A.add(at(rod([0, 1.94, -7.20], [0, 1.92, -8.42], 0.018, 6), 0, 0, 0), M.steelSat);
    // anchor hanging on the roller (a Delta-style plough)
    var ag = new T.Group();
    ag.position.set(0, 1.90, -8.52);
    var aa = [];
    aa.push(at(cyl(0.028, 0.032, 0.86, 8), 0, -0.30, 0.14, 0.36));
    aa.push(at(box(0.30, 0.05, 0.40), 0, -0.66, 0.40, 0.5, 0, 0));
    aa.push(at(box(0.05, 0.32, 0.42), 0, -0.62, 0.42, 0.5, 0, 0));
    aa.push(at(box(0.09, 0.09, 0.16), 0, 0.08, 0.06));
    var am = new T.Mesh(mergeAll(aa), M.steelSat);
    am.castShadow = true; am.receiveShadow = true;
    ag.add(am); root.add(ag); P.anchor = ag;
    // foredeck cleats and the mooring bridle fairleads
    for (s = -1; s <= 1; s += 2) {
      A.add(at(box(0.075, 0.075, 0.36), s * 2.55, 1.94, -6.60), M.steel);
      A.add(at(box(0.055, 0.10, 0.10), s * 2.55, 2.00, -6.60), M.steel);
      gasket(A, s * 2.55, 1.885, -6.60, 0.062, 0.014);
      A.add(at(box(0.16, 0.10, 0.22), s * (S.hullSep + 0.85), 1.96, -6.95), M.steelSat);
    }
    // hatches: escape and cabin hatches let into the deck with real frames
    var hp = [[S.hullSep, -4.30], [-S.hullSep, -4.30], [S.hullSep, -1.20], [-S.hullSep, -1.20],
              [S.hullSep, 2.90], [-S.hullSep, 2.90]];
    for (i = 0; i < hp.length; i++) {
      var hy = HS.sheerAt(hp[i][1]) + 0.06;
      A.add(at(box(0.66, 0.055, 0.66), hp[i][0], hy + 0.075, hp[i][1]), M.glass);
      A.add(at(box(0.78, 0.075, 0.78), hp[i][0], hy + 0.045, hp[i][1]), M.steelSat);
      A.add(at(box(0.86, 0.045, 0.86), hp[i][0], hy + 0.02, hp[i][1]), M.rubber);
      A.add(at(box(0.94, 0.020, 0.94), hp[i][0], hy - 0.004, hp[i][1]), M.gasket);
    }
    // deck organisers, jib track and cars along the side decks
    for (s = -1; s <= 1; s += 2) {
      var ty = HS.sheerAt(-1.60) + 0.07;
      A.add(at(box(0.07, 0.05, 3.20), s * (S.hullSep - 0.62), ty, -1.60), M.steelSat);
      A.add(at(box(0.088, 0.016, 3.30), s * (S.hullSep - 0.62), ty - 0.030, -1.60), M.gasket);
      A.add(at(box(0.11, 0.10, 0.26), s * (S.hullSep - 0.62), ty + 0.06, -1.20), M.steelSat);
      A.add(at(tor(0.045, 0.014, 8, 14), s * (S.hullSep - 0.62), ty + 0.15, -1.20, 0, PI / 2, 0), M.steelSat);
    }
    // fenders stowed on the guardrails
    for (s = -1; s <= 1; s += 2) for (i = 0; i < 2; i++) {
      var fz = 2.4 + i * 2.6, fx = s * (S.hullSep + HS.halfAt(fz) + 0.17);
      A.add(at(new T.CapsuleGeometry(0.20, 0.48, 4, LOW() ? 8 : 12), fx, 1.02, fz), M.fender);
      if (WR) WR.add([fx, 1.30, fz],
                     [s * (S.hullSep + HS.halfAt(fz) * 0.90), HS.sheerAt(fz) + 0.72, fz], 0.0055, 0.01, 2);
    }
  }

  function buildLights(A, root, P) {
    var lights = {};
    function lamp(name, col, x, y, z, sz) {
      // one material PER LAMP: steaming, stern, anchor and deck lights are all
      // white and are switched independently, so a shared instance would let
      // whichever ran last decide the brightness of all four
      var mat = M.lamp[col].clone();
      mat.__yPatched = false; patchMat(mat, { grime: 0.4, salt: 0.3 });
      var g = new T.Group();
      g.position.set(x, y, z);
      var lg = sph(0.055, 10, 8); aoFill(lg, 0.85);
      var lens = new T.Mesh(lg, mat);
      g.add(lens);
      var bg = box(0.10, 0.11, 0.09); aoFill(bg, 0.7);
      var body = new T.Mesh(bg, M.plastic);
      body.position.y = -0.06; body.castShadow = true;
      g.add(body);
      var spr = new T.Sprite(new T.SpriteMaterial({
        color: mat.emissive.getHex(), transparent: true, opacity: 0.0,
        blending: T.AdditiveBlending, depthWrite: false
      }));
      spr.scale.setScalar(sz || 0.75);
      g.add(spr);
      root.add(g);
      lights[name] = { group: g, mat: mat, sprite: spr };
      return g;
    }
    lamp('port', 'red', -(S.hbOut - 0.10), 1.98, -7.05, 0.85);
    lamp('stbd', 'green', S.hbOut - 0.10, 1.98, -7.05, 0.85);
    lamp('stern', 'white', 0, 2.24, 7.55, 0.80);
    lamp('steaming', 'white', 0, 13.60, S.mastZ + 0.20, 0.65);
    lamp('anchor', 'white', 0, S.mastTop + 0.34, S.mastZ, 0.70);
    lamp('deck', 'white', 0, 11.40, S.mastZ + 0.22, 0.55);
    P.lights = lights;
  }

  function buildEnsign(root, P) {
    var g = new T.PlaneGeometry(0.86, 0.52, 10, 4);
    aoFill(g, 1);
    var mesh = new T.Mesh(g, M.flag);
    mesh.position.set(3.52, 2.28, 8.42);
    mesh.castShadow = false;
    root.add(mesh);
    var sg = cyl(0.013, 0.017, 1.15, 8); aoFill(sg, 0.9);
    var staff = new T.Mesh(sg, M.steelSat);
    staff.position.set(3.06, 1.98, 8.32);
    staff.rotation.x = 0.26;
    root.add(staff);
    P.ensign = mesh;
    P.ensignBase = g.attributes.position.array.slice(0);
  }
  /* ==========================================================================
     10.  BUILD / UPDATE
     ====================================================================== */
  /* Named Object3D anchor, discoverable either through parts[] or by name. */
  function anchor(parent, name, x, y, z, P) {
    var o = new T.Object3D();
    o.name = name;
    o.position.set(x, y, z);
    parent.add(o);
    P[name] = o;
    return o;
  }

  /* Voxelise the finished boat and bake per-vertex occlusion into it.  Runs
     once, costs ~120 ms, and is the single biggest step from "primitives in
     front of a nice sky" toward "photograph of a boat". */
  /* Sky openness for the analytic wires.  Same grid, but only the upper
     hemisphere matters: what we want to know is whether this millimetre of
     rope is under the hardtop or out in the open, so that the sun term can be
     switched off for the tails coiled below deck level. */
  var SKYDIR = null;
  function shadeWires(mesh) {
    if (!mesh || !AOG.g || !mesh.geometry) return;
    var g = mesh.geometry, pa = g.attributes.position, sa = g.attributes.aShade;
    if (!pa || !sa) return;
    if (!SKYDIR) {
      SKYDIR = [];
      var raw = aoDirs(LOW() ? 16 : 30);
      for (var q = 0; q < raw.length; q += 3) {
        if (raw[q + 1] > 0.10) SKYDIR.push(raw[q], raw[q + 1], raw[q + 2]);
      }
    }
    var D = SKYDIR, ND = D.length / 3, p = pa.array, out = sa.array;
    var STEP = [0.16, 0.18, 0.22, 0.27, 0.33, 0.40, 0.48, 0.58];
    for (var i = 0; i < pa.count; i++) {
      var o = i * 3, open = 0, wsum = 0;
      for (var k = 0; k < ND; k++) {
        var dx = D[k * 3], dy = D[k * 3 + 1], dz = D[k * 3 + 2];
        wsum += dy;
        var t = 0.10, hit = 0;
        for (var s = 0; s < STEP.length; s++) {
          t += STEP[s];
          if (aoSolid(p[o] + dx * t, p[o + 1] + dy * t, p[o + 2] + dz * t)) { hit = 1; break; }
        }
        if (!hit) open += dy;
      }
      out[i] = wsum > 1e-4 ? clamp(0.10 + 0.90 * (open / wsum), 0, 1) : 1;
    }
    sa.needsUpdate = true;
  }

  function bakeOcclusion(root, wires) {
    var list = [], i;
    root.updateMatrixWorld(true);
    root.traverse(function (o) {
      if (o.isMesh && !o.__noAO && o.geometry && o.geometry.attributes &&
          o.geometry.attributes.position) list.push(o);
    });
    try {
      aoInit();
      for (i = 0; i < list.length; i++) aoVoxelize(list[i].geometry, list[i].matrixWorld);
      for (i = 0; i < list.length; i++) aoBake(list[i].geometry, list[i].matrixWorld);
      if (wires) for (i = 0; i < wires.length; i++) shadeWires(wires[i]);
    } catch (e) {
      if (window.console) console.warn('[SAIL.yacht] AO bake skipped:', e && e.message);
    }
    AOG.g = null;                                  // 3.5 MB back
    for (i = 0; i < list.length; i++) aoFill(list[i].geometry, 1);
  }

  /* ------------------------------------------------------------------------
     Per-frame lighting hand-off.  The sun and sky energies live in sky.js;
     everything here converts them into (a) the bounce irradiance the PBR
     materials need and (b) the light terms the analytic wires need, so that
     both respond to time of day instead of holding a fixed ambient.
     ---------------------------------------------------------------------- */
  var _sv = new T.Vector3(), _uv = new T.Vector3(), _dsz = new T.Vector2();
  function updateLighting() {
    var sky = SAIL.sky || {}, e = SAIL.env || {};
    var sd = sky.sunDir || e.sunDir;
    var sunY = (sd && isNum(sd.y)) ? sd.y : 0.7;
    var sunE = isNum(e.sunE) ? e.sunE : (isNum(sky.sunE) ? sky.sunE : 60);
    var skyE = isNum(e.skyE) ? e.skyE : (isNum(sky.skyE) ? sky.skyE : 14);
    var sc = sky.sunColor || e.sunColor, kc = sky.skyColor || e.skyColor;
    var sr = sc ? sc.r : 1.00, sg = sc ? sc.g : 0.93, sb = sc ? sc.b : 0.82;
    var kr = kc ? kc.r : 0.42, kg = kc ? kc.g : 0.56, kb = kc ? kc.b : 0.88;
    var up = clamp(sunY, 0, 1);

    /* The uplight has two quite different parts, and using only the first is
       what made the boat ignore golden hour entirely:

       DIFFUSE   the downwelling sun+sky landing on white gelcoat (albedo
                 ~0.75) and on the water, coming straight back up.  Dominant
                 with the sun high — at noon this is essentially all of it.
       GRAZING   the sea acting as a mirror.  A downward-facing surface two
                 metres up sees the water at grazing incidence over part of
                 its hemisphere, where Fresnel is high, so it sees a reflected
                 image of the low sky.  Cosine weighting keeps this modest —
                 near nadir the sea reflects only a couple of percent — but at
                 17:45 the horizon radiance is ~45 against a zenith of ~1.3,
                 so it still doubles the uplight and it is the only path by
                 which the amber ever reaches the underside of the boat. */
    /* NB: sky.horizonColor is a RADIANCE triple, not a unit chromaticity —
       its components run into the hundreds.  Normalise, or the grazing term
       arrives two orders of magnitude hot and floods the whole boat. */
    var hE = isNum(sky.horizonE) ? sky.horizonE : skyE * 1.6;
    var hc = sky.horizonHue || sky.horizonColor;
    var hm = hc ? Math.max(hc.r, hc.g, hc.b, 1e-6) : 1;
    var hr = hc ? hc.r / hm : 1.00, hg = hc ? hc.g / hm : 0.72, hb = hc ? hc.b / hm : 0.55;
    var diff = (sunE * up + skyE * 0.85) * 0.26;
    /* 0.155, not 0.05.  The old weight was calibrated for a flat sea acting
       as a dim mirror; the sea under a low sun is a glitter path whose mean
       radiance over the lower hemisphere is a large fraction of the horizon
       radiance itself.  At noon this term is a fifth of the diffuse one and
       barely shows; at 17:45 it is the whole reason a hardtop underside glows
       amber instead of reading as a black lid over the cockpit. */
    var graz = hE * 0.155;
    UNI.uBounceDn.value.set(
      diff * (0.62 + 0.38 * sr) + graz * hr,
      diff * (0.70 + 0.30 * sg) + graz * hg,
      diff * (0.76 + 0.24 * sb) + graz * hb);
    /* UPWARD-facing irradiance that the hemisphere light cannot supply.  A
       cockpit sole under a hardtop still sees a 40-degree band of sky and sea
       out through the open sides, and it sees the whole underside of the
       hardtop, which is itself brightly uplit by the water.  Both paths are
       invisible to a single hemisphere light once baked occlusion has scaled
       it down, and leaving them out is what buries a laid teak deck in ink. */
    var u = skyE * 0.34 + sunE * up * 0.045 + hE * 0.048;
    var uhr = lerp(kr, hr, 0.45), uhg = lerp(kg, hg, 0.45), uhb = lerp(kb, hb, 0.45);
    UNI.uBounceUp.value.set(
      u * (0.60 + 0.40 * uhr) * (0.72 + 0.28 * sr),
      u * (0.68 + 0.32 * uhg) * (0.78 + 0.22 * sg),
      u * (0.76 + 0.24 * uhb) * (0.84 + 0.16 * sb));

    /* LATERAL irradiance.  What a vertical surface inside the cockpit sees is
       roughly half sky-near-the-horizon and half sunlit sea, and the sea half
       carries the sun's own colour because most of what comes back off it is
       diffusely scattered sunlight plus glitter.  Weighted so that at noon the
       cockpit lands about two and a half stops under the open water, which is
       what a photograph of a hardtop cockpit actually measures. */
    var side = hE * 0.078 + (sunE * up * 0.055 + skyE * 0.20) * 0.5;
    UNI.uBounceSide.value.set(
      side * (0.72 + 0.28 * lerp(hr, sr, 0.5)),
      side * (0.80 + 0.22 * lerp(hg, sg, 0.5)),
      side * (0.86 + 0.20 * lerp(hb, sb, 0.5)));

    // ---- analytic wires ---------------------------------------------------
    if (!MWS) return;
    var cam = SAIL.camera;
    var px = 0.0016;
    if (cam && cam.isPerspectiveCamera) {
      var h = 800;
      if (SAIL.renderer && SAIL.renderer.getDrawingBufferSize) {
        SAIL.renderer.getDrawingBufferSize(_dsz);
        if (_dsz.y > 1) h = _dsz.y;
      }
      px = 2 * Math.tan(cam.fov * PI / 360) / h;
      _uv.set(0, 1, 0).transformDirection(cam.matrixWorldInverse);
      if (sd) _sv.set(sd.x, sd.y, sd.z).transformDirection(cam.matrixWorldInverse);
      else _sv.set(0.3, 0.9, -0.3);
    } else { _uv.set(0, 1, 0); _sv.set(0.3, 0.9, -0.3); }
    var mats = [MWS, MWR];
    for (var i = 0; i < mats.length; i++) {
      var U2 = mats[i].uniforms;
      U2.uPxScale.value = px;
      U2.uSunV.value.copy(_sv);
      U2.uUpV.value.copy(_uv);
      U2.uSunCol.value.set(sr * sunE, sg * sunE, sb * sunE);
      U2.uAmbCol.value.set(kr * skyE, kg * skyE, kb * skyE);
    }
  }

  var API = {
    ready: false, group: null, parts: null,
    /* SAIL.sails reads this: true means the boom angle is OURS, and the
       mainsail must follow gooseneck -> boomEnd rather than its own trim. */
    boomDriven: true,

    build: function (scene) {
      try {
        buildMaterials();
        HS = hullStations();
      } catch (e) { }
      if (!M) { try { buildMaterials(); } catch (e2) { } }
      if (!HS) HS = hullStations();
      var root = new T.Group();
      root.name = 'leopard52';
      var P = {};
      var A = new Acc();
      WS = new WireAcc(); WR = new WireAcc();
      // 1x19 stainless: tight lobe, strong glint.  Rope: broad and matte.
      MWS = wireMaterial(0xd9dfe2, 46.0, 2.1, 1.0, 0);
      MWR = wireMaterial(0xc9c6bc, 11.0, 0.26, 1.0, 26.0);
      try {
        buildHulls(A, root, P);
        buildBridgedeck(A, P);
        buildDeck(A, P);
        buildSuperstructure(A, P);
        buildCockpit(A, root, P);
        buildFlybridge(A, root, P);
        buildRig(A, root, P);
        buildForedeck(A, root, P);
        A.flush(root, 'hull');
        buildLights(A, root, P);
        buildEnsign(root, P);
        A.flush(root, 'extra');
      } catch (e) {
        if (window.console) console.warn('[SAIL.yacht] partial build:', e && e.message);
        try { A.flush(root, 'hull'); } catch (e2) { }
      }
      var wireList = [];
      try {
        var mw = WS.mesh(MWS, 'rigging.wire');
        if (mw) { mw.__noAO = true; root.add(mw); P.rigWire = mw; wireList.push(mw); }
        var mr = WR.mesh(MWR, 'rigging.rope');
        if (mr) { mr.__noAO = true; root.add(mr); P.rigRope = mr; wireList.push(mr); }
        if (P.boomJacks) P.boomJacks.__noAO = true;
      } catch (e) { }
      try { bakeOcclusion(root, wireList); } catch (e) { }
      try { probeInit(root); } catch (e) { }
      try { updateLighting(); } catch (e) { }
      _envSeen = null; syncEnv();
      if (scene && scene.add) scene.add(root);
      var inst = { group: root, parts: P };
      API.group = root;
      API.parts = P;
      API._inst = inst;
      API.ready = true;
      this.group = root; this.parts = P;
      // the returned handle is bound to THIS instance, so a second build()
      // can never silently redirect an earlier caller's update()
      return {
        group: root, parts: P,
        update: function (t, dt, state) { return applyUpdate(inst, t, dt, state); }
      };
    },

    /* ---------------------------------------------------------------------
       state (all optional, every field guarded):
         x, z, heading (rad), heelRad, pitchRad, heaveY,
         rud (deg, +stbd), rpm[2], gear[2], mainSheet 0..1, jibSheet 0..1,
         awaDeg, boomRad, navLights (bool), anchorDown (bool)
       ------------------------------------------------------------------- */
    update: function (t, dt, state) {
      return applyUpdate(API._inst, t, dt, state);
    },

    /* Rebuild materials against a new env map / quality setting. */
    refresh: function () { _envSeen = null; syncEnv(); },

    /* Exposed for tuning and for other modules that want to know how much
       uplight the boat is receiving (the sails want the same term). */
    uniforms: UNI, materials: function () { return M; }
  };

  function applyUpdate(inst, t, dt, state) {
      if (!inst) return;
      var P = inst.parts, root = inst.group;
      if (!P || !root) return;
      var st = state || {};
      dt = isNum(dt) ? Math.min(dt, 0.1) : 0.016;
      t = isNum(t) ? t : 0;

      /* Lighting is cheap and must not lag: the bounce term is what keeps
         gelcoat responding to the sun's colour, so it runs every frame. */
      try { updateLighting(); } catch (e) { }
      try { probeUpdate(dt); } catch (e) { }
      if (!inst._envT || t - inst._envT > 0.45) { inst._envT = t; syncEnv(); }

      /* -- rigid-body placement (idempotent if app.js also sets it) ------- */
      if (isNum(st.x) && isNum(st.z)) {
        var h = isNum(st.heading) ? st.heading : (isNum(st.h) ? st.h : 0);
        var heel = isNum(st.heelRad) ? st.heelRad : (isNum(st.heel) ? st.heel : 0);
        var pit = isNum(st.pitchRad) ? st.pitchRad : (isNum(st.pitch) ? st.pitch : 0);
        var hv = isNum(st.heaveY) ? st.heaveY : (isNum(st.heave) ? st.heave : 0);
        root.position.set(st.x, hv, st.z);
        root.rotation.set(0, 0, 0);
        root.rotateY(-h); root.rotateX(pit); root.rotateZ(heel);
      }

      /* -- helm: ~1.1 turns each way for 35 deg of rudder ----------------- */
      var rud = isNum(st.rud) ? st.rud : (isNum(st.rudder) ? st.rudder : 0);
      if (P.wheel) P.wheel.rotation.z = -rud * 0.20;
      if (P.rudders) for (var i = 0; i < P.rudders.length; i++) {
        // +rud = helm to starboard: the trailing edge (+Z) swings to +X
        P.rudders[i].rotation.y = rud * PI / 180;
      }
      /* -- propellers ----------------------------------------------------- */
      if (P.props) for (i = 0; i < P.props.length; i++) {
        var rpm = (st.rpm && isNum(st.rpm[i])) ? st.rpm[i] : 0;
        var gear = (st.gear && isNum(st.gear[i])) ? st.gear[i] : 0;
        P.props[i].rotation.z += rpm / 2.61 / 60 * gear * dt * 6.2;
      }

      /* -- boom angle: sails.js may drive parts.boom directly ------------- */
      var boomRad = null;
      if (isNum(st.boomRad)) boomRad = st.boomRad;
      else if (isNum(st.mainSheet)) {
        var awa = isNum(st.awaDeg) ? st.awaDeg : 45;
        var sgn = awa >= 0 ? 1 : -1;
        var maxA = 80 * PI / 180 * (1 - 0.30 * clamp((st.reef || 0) / 2, 0, 1));
        boomRad = -sgn * maxA * clamp(st.mainSheet, 0, 1);
      }
      if (P.boom && boomRad !== null) {
        var cur = P.boom.rotation.y;
        P.boom.rotation.y = cur + (boomRad - cur) * clamp(dt * 3.5, 0, 1);
      }

      /* -- mainsheet tackle and vang, restrung every frame ---------------- */
      if (P.boom && P.tackle && P.boomEnd) {
        var ba = P.boom.rotation.y, cy = Math.cos(ba), sy = Math.sin(ba);
        var zA = S.boomE * 0.70;
        var ax = sy * zA, az = S.mastZ + 0.20 + cy * zA, ay = S.goose - 0.02;
        for (i = 0; i < P.tackle.length; i++) {
          var off = (i - 1) * 0.10;
          stretch(P.tackle[i], ax + off * cy, ay, az - off * sy,
                  off * 0.6, P.travellerY, P.travellerZ + off * 0.35);
        }
        var vz = 0.85;
        stretch(P.vang, sy * vz, S.goose + 0.02, S.mastZ + 0.20 + cy * vz,
                0, S.mastBase + 0.42, S.mastZ + 0.16);
      }

      /* -- winches: spin while the sheet they tend is being trimmed ------- */
      if (P.winches) {
        var ms = isNum(st.mainSheet) ? st.mainSheet : 0;
        var js = isNum(st.jibSheet) ? st.jibSheet : 0;
        if (inst._ms === undefined) { inst._ms = ms; inst._js = js; }
        var dms = (ms - inst._ms), djs = (js - inst._js);
        inst._ms = ms; inst._js = js;
        var spin = [djs, djs, djs * 0.7, djs * 0.7, dms, dms];
        for (i = 0; i < P.winches.length; i++) {
          P.winches[i].rotation.y -= (spin[i] || 0) * 26;
        }
      }

      /* -- anchor: stowed on the roller, or swung down when let go -------- */
      if (P.anchor) {
        var want = st.anchorDown ? -0.55 : 0.0;
        P.anchor.rotation.x += (want - P.anchor.rotation.x) * clamp(dt * 1.5, 0, 1);
      }

      /* -- navigation lights ---------------------------------------------- */
      var env = SAIL.env || {};
      var hod = isNum(env.hourOfDay) ? env.hourOfDay : 12;
      var on = (st.navLights !== undefined) ? !!st.navLights : (hod < 6.1 || hod > 18.3);
      if (P.lights) {
        var anchored = !!st.anchorDown;
        var set = {
          port: on && !anchored, stbd: on && !anchored, stern: on && !anchored,
          steaming: on && !anchored && !!st.engineOn, anchor: on && anchored,
          deck: !!st.deckLight
        };
        for (var kk in P.lights) {
          var Lp = P.lights[kk], want2 = set[kk] ? 1 : 0;
          var cur2 = Lp.mat.emissiveIntensity;
          var nv = cur2 + (want2 * 26 - cur2) * clamp(dt * 8, 0, 1);
          Lp.mat.emissiveIntensity = nv;
          Lp.sprite.material.opacity = clamp(nv / 26 * 0.85, 0, 1);
          Lp.sprite.visible = nv > 0.4;
        }
      }

      /* -- ensign: cheap 2-harmonic flutter scaled by apparent wind ------- */
      if (P.ensign && P.ensignBase) {
        var pa = P.ensign.geometry.attributes.position, arr = pa.array, base = P.ensignBase;
        var aws = isNum(st.awsMs) ? st.awsMs : (isNum(env.windKn) ? env.windKn * 0.5144 : 6);
        var amp = clamp(aws * 0.012, 0.01, 0.16);
        for (i = 0; i < arr.length; i += 3) {
          var uu = (base[i] + 0.43) / 0.86;
          var ph = t * 6.0 - uu * 7.0;
          arr[i + 2] = base[i + 2] + Math.sin(ph) * amp * uu * uu
                     + Math.sin(ph * 1.7 + base[i + 1] * 5.0) * amp * 0.35 * uu;
          arr[i + 1] = base[i + 1] - 0.05 * uu * uu * (1 - clamp(aws / 8, 0, 1));
        }
        pa.needsUpdate = true;
        P.ensign.geometry.computeVertexNormals();
      }
  }

  /* Stretch a unit +Y cylinder mesh between two model-space points. */
  function stretch(mesh, ax, ay, az, bx, by, bz) {
    if (!mesh) return;
    var dx = bx - ax, dy = by - ay, dz = bz - az;
    var L = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (L < 1e-4) { mesh.visible = false; return; }
    mesh.visible = true;
    mesh.position.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
    _v2.set(dx / L, dy / L, dz / L);
    mesh.quaternion.setFromUnitVectors(UP, _v2);
    mesh.scale.set(1, L, 1);
  }

  SAIL.yacht = API;
})();
