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
  /* REWRITTEN.  The previous layout was eight planks of identical width on a
     perfectly regular pitch, with a caulk line that was a zero-width strip of
     near-black paint.  Two consequences, both of which the review named:

       - a constant pitch is a RULER.  The moment more than a metre of deck is
         in frame the eye locks onto the repeat and reads the whole sole as one
         tiled bitmap, however good the grain inside each plank is.
       - a painted caulk line has no specular.  Real caulk is a rubber bead
         squeezed proud of a chamfered plank edge: it sits in a 2 mm trough,
         it crowns in the middle, and because polysulphide is far smoother
         than holystoned teak it catches a thin bright sliver down its whole
         length.  That sliver is most of what makes a laid deck look laid.

     So: plank widths jitter +-8% and are laid out cumulatively (no two seams
     land on the same pitch anywhere in the tile), the caulk carries a real
     height profile with its own roughness, every plank gets a cross-grain ray
     figure and open pores, and butt joints are finished with a pair of bungs
     the way a screwed deck actually is. */
  function teakFields(S2) {
    var NP = 8, x, y, i;
    /* ---- plank layout: cumulative, jittered, normalised back onto the tile */
    var wj = [], sum = 0;
    for (i = 0; i < NP; i++) { wj.push(1 + 0.16 * (hash1(i * 4.13 + 0.9) - 0.5)); sum += wj[i]; }
    var edge = [0];
    for (i = 0; i < NP; i++) edge.push(edge[i] + wj[i] / sum * S2);
    edge[NP] = S2;
    // per-pixel plank index, fractional position and signed distance to the
    // nearest seam centre, precomputed so the three passes below agree exactly
    var pIdx = new Uint8Array(S2), pFrc = new Float32Array(S2), pDst = new Float32Array(S2);
    var k = 0;
    for (x = 0; x < S2; x++) {
      while (k < NP - 1 && x >= edge[k + 1]) k++;
      pIdx[x] = k;
      var w = edge[k + 1] - edge[k];
      pFrc[x] = (x - edge[k]) / w;
      var dL = x - edge[k], dR = edge[k + 1] - x;
      pDst[x] = Math.min(dL, dR);                     // pixels to the nearest seam
    }
    var pw = S2 / NP;                                  // nominal, for callers
    var G = new Float32Array(S2 * S2), CG = new Float32Array(S2 * S2);
    var ph = [], tone = [], rgh = [], slv = [], off = [];
    for (i = 0; i < NP; i++) {
      ph.push(hash1(i * 3.7 + 1.3) * 400);            // grain phase
      off.push(hash1(i * 9.1 + 5.7));                 // butt-joint stagger
      tone.push(0.84 + 0.20 * hash1(i * 13.3 + 2.1)); // plank-to-plank colour
      rgh.push(-0.06 + 0.16 * hash1(i * 5.9 + 8.8));  // plank-to-plank finish
      slv.push(hash1(i * 21.7 + 4.4));                // how silvered this plank is
    }
    for (y = 0; y < S2; y++) for (x = 0; x < S2; x++) {
      var pi = pIdx[x];
      var o = y * S2 + x;
      G[o] = fbm(x * 0.42 + ph[pi], y * 0.055 + ph[pi] * 0.3, 3, 0) * 0.75 +
             vn(x * 1.9 + ph[pi], y * 0.11, 0) * 0.25;
      /* CROSS-GRAIN.  Quarter-sawn teak carries medullary rays and a ribbon
         figure that runs ACROSS the plank at a shallow angle, plus open pores
         a fraction of a millimetre wide.  Grain drawn as a pure 1D vertical
         streak is the single most synthetic thing a wood shader can do — it
         is the one axis real timber never has. */
      var ray = vn((x + y * 0.22) * 0.85 + ph[pi], y * 0.020, 0);
      var pore = vn(x * 3.30 + ph[pi] * 2.0, y * 0.42, 0);
      CG[o] = (ray - 0.5) * 0.62 + clamp(pore - 0.62, 0, 1) * 1.9;
    }
    /* Caulk cross-section, in pixels from the seam centre.  0 = plank face,
       1 = full caulk.  The bead itself is ~5 mm at this texel density. */
    var CW = S2 / 190;                                 // caulk half-width, px
    function seam(px, py) {
      var d = pDst[((px % S2) + S2) % S2];
      // the bead swells and shrinks by a millimetre along its length
      var w = CW * (1.0 + 0.22 * (vn(px * 0.02, py * 0.09, 0) - 0.5));
      return clamp((w - d) / 1.1 + 0.5, 0, 1);
    }
    /* HEIGHT of the joint: the plank edge is chamfered down into a trough and
       the rubber crowns back up in the middle of it, so the section is a W.
       This is what produces the thin bright line down the caulk instead of a
       flat black stripe. */
    function seamH(px, py) {
      var d = pDst[((px % S2) + S2) % S2];
      var w = CW * (1.0 + 0.22 * (vn(px * 0.02, py * 0.09, 0) - 0.5));
      if (d > w * 2.1) return 0;
      if (d > w) return -0.62 * (1 - clamp((d - w) / (w * 1.1), 0, 1));   // chamfer
      var t = d / w;                                                       // 0 centre
      return -0.62 + 0.40 * (1 - t * t);                                   // rubber crown
    }
    /* BUTT JOINTS.  One joint per plank per tile — 2.0 m apart, which is what
       a laid deck actually uses — at a stochastic offset per plank row, so no
       two rows line up and there is no lattice for the eye to find.  Returns
       a COVERAGE in 0..1 so the joint blends into the wood instead of stamping
       a hard-edged rectangle. */
    function butt(px, py) {
      var pi = pIdx[((px % S2) + S2) % S2];
      var t = (py / S2) - off[pi];
      t -= Math.floor(t);
      var dv = Math.min(t, 1 - t) * S2;                    // pixels from the joint
      var w = 1.55 + 0.60 * hash1(pi * 7.73 + 3.1);        // it is a sawn end, not a line
      return clamp((w - dv) / 1.45, 0, 1);
    }
    /* BUNGS.  A screwed deck is plugged: two 10 mm teak bungs sit just inboard
       of every butt, their end grain a shade darker than the plank and their
       tops sanded flush.  Tiny, and completely diagnostic of laid teak. */
    function bung(px, py) {
      var xi = ((px % S2) + S2) % S2;
      var pi = pIdx[xi];
      var t = (py / S2) - off[pi];
      t -= Math.floor(t);
      var pw2 = edge[pi + 1] - edge[pi];
      var cx = edge[pi] + pw2 * 0.5;
      var r = pw2 * 0.155, best = 9;
      for (var q = 0; q < 2; q++) {
        var dv = (t - (q ? 0.020 : -0.020)) * S2;
        var dx = xi - cx;
        var dd = Math.sqrt(dx * dx + dv * dv);
        if (dd < best) best = dd;
      }
      return clamp((r - best) / 1.4, 0, 1);
    }
    function grain(px, py) {
      return G[(((py % S2) + S2) % S2) * S2 + (((px % S2) + S2) % S2)];
    }
    function cross(px, py) {
      return CG[(((py % S2) + S2) % S2) * S2 + (((px % S2) + S2) % S2)];
    }
    function plank(px) { return pIdx[((px % S2) + S2) % S2]; }
    function frac(px) { return pFrc[((px % S2) + S2) % S2]; }
    return { NP: NP, pw: pw, seam: seam, seamH: seamH, butt: butt, bung: bung,
             grain: grain, cross: cross, plank: plank, frac: frac,
             tone: tone, rgh: rgh, slv: slv };
  }
  function texTeak() {
    var S2 = LOW() ? 256 : 512, F = teakFields(S2);
    var c = cvs(S2), g = c.getContext('2d'), im = g.createImageData(S2, S2), d = im.data;
    for (var y = 0; y < S2; y++) for (var x = 0; x < S2; x++) {
      var pi = F.plank(x);
      var sm = F.seam(x, y), bt = F.butt(x, y), gr = F.grain(x, y), cr = F.cross(x, y);
      /* Albedo calibrated against a photograph of a laid deck in open shade:
         oiled teak sits around sRGB 165/138/100 and holystoned teak silvers
         to a warm grey near 185/180/166.  Anything below ~120 crushes to
         black the moment the deck is under a hardtop, which is exactly the
         "solid dark ribbon" failure. */
      var l = (0.66 + 0.40 * gr) * F.tone[pi] * (1 - 0.16 * clamp(cr, 0, 1));
      var r = l * 232, gg = l * 196, b = l * 148;
      // UV silvering: sun-bleached planks lose the red and gain grey
      var sv = F.slv[pi] * clamp(gr * 1.3, 0, 1) * 0.62;
      r = lerp(r, 196, sv); gg = lerp(gg, 191, sv); b = lerp(b, 176, sv);
      // traffic lanes: the centre of the tile walks greyer than the edges
      var lane = Math.exp(-Math.pow((x / S2 - 0.5) / 0.34, 2)) * 0.32;
      r = lerp(r, 190, lane); gg = lerp(gg, 186, lane); b = lerp(b, 172, lane);
      // a bung is the same timber cut across the grain: darker, and flatter
      var bg = F.bung(x, y);
      if (bg > 0.004) { r = lerp(r, r * 0.80, bg); gg = lerp(gg, gg * 0.79, bg); b = lerp(b, b * 0.76, bg); }
      // the butt is bedded in the same caulk as the seams, so it darkens
      // toward the seam colour instead of simply multiplying to grey
      if (bt > 0.004) { r = lerp(r, 34, bt * 0.86); gg = lerp(gg, 31, bt * 0.86); b = lerp(b, 28, bt * 0.88); }
      /* Caulk is a warm dark GREY-BROWN rubber, not black paint, and its
         crown catches enough light to sit a stop above its own shoulders. */
      if (sm > 0.004) {
        var cc = 40 + 16 * (1 - sm);
        r = lerp(r, cc * 1.02, sm); gg = lerp(gg, cc * 0.95, sm); b = lerp(b, cc * 0.86, sm);
      }
      var i = (y * S2 + x) * 4;
      d[i] = r; d[i + 1] = gg; d[i + 2] = b; d[i + 3] = 255;
    }
    g.putImageData(im, 0, 0);
    var alb = mkTex(c, true);
    var rgh = mkTex(grayCanvas(S2, function (x, y) {
      /* THE SPECULAR SLIVER.  Cured polysulphide is a smooth rubber: it is
         markedly GLOSSIER than the holystoned teak either side of it, not
         rougher.  Setting the seam to 0.92 (as the previous version did) is
         what made the caulk read as a painted line — it killed the only
         highlight the joint could ever produce. */
      var s = F.seam(x, y);
      var wood = clamp(0.40 + 0.14 * F.grain(x, y) + F.rgh[F.plank(x)]
                     + 0.10 * clamp(F.cross(x, y), 0, 1), 0.15, 1);
      var caulk = 0.42;
      return lerp(wood, caulk, s) + F.bung(x, y) * 0.06;
    }), false);
    var nrm = mkTex(normalCanvas(S2, function (x, y) {
      return F.seamH(x, y) - F.butt(x, y) * 0.40 + F.grain(x, y) * 0.14
           + F.cross(x, y) * 0.10 - F.bung(x, y) * 0.05;
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

  /* ---- wheel-rim leather ---------------------------------------------------
     The wheel is the closest hero prop to camera and its stitching is the
     detail a viewer uses to date an asset, so this is authored as a REAL
     wrap, not as a painted spine:

       - the tile is exactly one tube-circumference square (0.176 m), so it is
         isotropic and lands 20 stitches per tile at an 8.7 mm pitch — 360
         stitches around a 1.00 m wheel, which is what a wrapped rim carries;
       - v runs around the tube, and the SEAM CHANNEL sits at v = 0.5, i.e. on
         the inboard face where a real wrap is closed.  It is a recessed
         valley with the two leather edges rolling up to it, not a painted
         line: the thing that reads as stitching at a glance is the shadow in
         that channel, and a flat decal has none;
       - the thread is a proper cross-stitch — two crossing diagonals per cell
         drawn as capsules with round ends — standing PROUD of the leather and
         crossing the channel, so it catches light on its upper flank and
         casts into the valley;
       - pebble grain everywhere at ~1 mm, which is what stops the tube
         reading as moulded plastic once the stitching is fixed.
     -------------------------------------------------------------------- */
  function texLeather() {
    var S2 = 256, NST = 26, W = S2 / NST;
    var PBg = new Float32Array(S2 * S2), x, y;
    for (y = 0; y < S2; y++) for (x = 0; x < S2; x++) {
      // two grain scales: the coarse cell structure and the fine tooth
      PBg[y * S2 + x] = fbm(x * 0.26, y * 0.26, 3, 0) * 0.72 + vn(x * 0.95, y * 0.95, 0) * 0.28;
    }
    function pebble(px, py) { return PBg[(((py % S2) + S2) % S2) * S2 + (((px % S2) + S2) % S2)]; }
    /* Signed distance from a point to a segment, wrapped in x so the pattern
       tiles: the thread that leaves the right-hand edge arrives on the left. */
    function segD(px, py, ax, ay, bx, by) {
      var dx = px - ax, dy = py - ay, ex = bx - ax, ey = by - ay;
      var t = clamp((dx * ex + dy * ey) / (ex * ex + ey * ey + 1e-9), 0, 1);
      var qx = dx - ex * t, qy = dy - ey * t;
      return Math.sqrt(qx * qx + qy * qy);
    }
    var HALF = 0.084 * S2;                   // stitch reach either side of the seam
    /* Where the seam sits around the tube matters more than anything else in
       this texture.  TorusGeometry puts v = 0 on the outer equator, v = 0.25
       on the face toward the helmsman and v = 0.5 on the inner equator; the
       canvas is flipped, so canvas y = 0.60*S2 lands the seam at torus
       v = 0.40 — on the inner-front quadrant, raking away from the eye the
       way a real wrap does, visible without sitting flat-on in the middle of
       the largest smooth surface of the prop. */
    var CY = S2 * 0.60;
    /* Thread coverage: 1 on the axis of a strand, falling to 0 at its edge.
       Radius 0.030 of the tile = 5.3 mm of 2 mm waxed thread rendered with a
       soft shoulder, which is what a photograph of one actually measures once
       the highlight either side is counted. */
    function thread(px, py) {
      var best = 1e9, k, cx0;
      for (k = -1; k <= 1; k++) {
        cx0 = (Math.floor(px / W) + k) * W;
        best = Math.min(best, segD(px, py, cx0, CY - HALF, cx0 + W, CY + HALF));
        best = Math.min(best, segD(px, py, cx0, CY + HALF, cx0 + W, CY - HALF));
      }
      /* 2.3 mm of waxed thread with a soft shoulder.  Thinner than it wants
         to be, deliberately: the gaps BETWEEN the strands are where the dark
         seam channel shows through, and it is that alternating dark/light
         rhythm — not the strands themselves — that the eye reads as stitching
         rather than as a moulded bead. */
      var r = 0.0230 * S2;
      return best > r ? 0 : Math.cos(best / r * PI * 0.5);
    }
    // the closed seam itself: a valley with the leather rolling into it
    function channel(py) {
      var dv = Math.abs(py - CY) / S2;
      return dv < 0.021 ? Math.cos(dv / 0.021 * PI * 0.5) : 0;
    }
    function roll(py) {
      var dv = Math.abs(py - CY) / S2;
      var t = clamp((dv - 0.022) / 0.050, 0, 1);
      return t * t * (3 - 2 * t) * (1 - clamp((dv - 0.086) / 0.05, 0, 1));
    }
    function height(px, py) {
      return pebble(px, py) * 0.22 - channel(py) * 1.00 + roll(py) * 0.34 + thread(px, py) * 0.86;
    }
    var c = cvs(S2), g = c.getContext('2d'), im = g.createImageData(S2, S2), d = im.data;
    for (y = 0; y < S2; y++) for (x = 0; x < S2; x++) {
      var p = pebble(x, y), th = thread(x, y), ch = channel(y);
      var l = 0.72 + 0.34 * (p - 0.5), i = (y * S2 + x) * 4;
      var r = l * 126, gg = l * 88, b = l * 64;
      // the valley is in permanent shade and holds the dressing that darkens it
      var cs = clamp(ch * 1.25, 0, 1);
      r = lerp(r, r * 0.34, cs); gg = lerp(gg, gg * 0.32, cs); b = lerp(b, b * 0.32, cs);
      if (th > 0.02) {
        /* Waxed linen, and only about a stop and a half above the leather.
           The first pass ran it at 182 against a leather at 90, which drew a
           row of bright teeth and read as a zipper: real stitching separates
           from the hide by its SHAPE and by the shadow in the channel, not by
           value, and pushing the value is exactly what makes it look printed. */
        var tv = 0.88 + 0.24 * hash1(Math.floor(x / W) * 3.1 + Math.floor(y * 0.05));
        var tk = clamp(th * 1.5, 0, 1);
        r = lerp(r, 146 * tv, tk); gg = lerp(gg, 122 * tv, tk); b = lerp(b, 92 * tv, tk);
      }
      d[i] = r; d[i + 1] = gg; d[i + 2] = b; d[i + 3] = 255;
    }
    g.putImageData(im, 0, 0);
    return {
      map: mkTex(c, true),
      rough: mkTex(grayCanvas(S2, function (px, py) {
        var th = thread(px, py);
        return clamp(0.66 - 0.17 * pebble(px, py) + 0.16 * channel(py) - 0.06 * th, 0.1, 1);
      }), false),
      normal: mkTex(normalCanvas(S2, height, 2.9), false)
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

  /* ---- gelcoat orange-peel -------------------------------------------------
     Two maps, not one.  The normal alone bends the reflection but leaves the
     surface at ONE roughness value across a whole topside, and a mirror of
     uniform roughness is exactly what reads as painted foam board: real
     gelcoat has flake, polish swirls from the buffing wheel and a faint
     stipple, so the sky arrives as a long soft gradient with structure in it
     rather than as a clean gradient ramp. */
  function texGel() {
    var S2 = 128;
    function peel(x, y) {
      return fbm(x * 0.18, y * 0.18, 3, 0) * 0.6 + vn(x * 1.1, y * 1.1, 0) * 0.4;
    }
    /* Rotary buffing leaves overlapping arcs.  Four passes of concentric
       rings at different centres, each only a couple of percent of gloss —
       invisible as a pattern, but it is what stops the highlight terminator
       from being a mathematically clean curve. */
    function swirl(x, y) {
      var s = 0;
      for (var k = 0; k < 4; k++) {
        var cx = hash1(k * 3.1 + 0.7) * S2, cy = hash1(k * 7.9 + 2.3) * S2;
        var dx = x - cx, dy = y - cy, r = Math.sqrt(dx * dx + dy * dy);
        s += Math.sin(r * (0.55 + 0.25 * hash1(k * 5.5))) * 0.25;
      }
      return s * 0.25 + 0.5;
    }
    return {
      normal: mkTex(normalCanvas(S2, function (x, y) {
        return peel(x, y) * 0.86 + vn(x * 3.7, y * 3.7, 0) * 0.14;
      }, 0.55), false),
      /* Mean sits just under 1 so it barely lifts the base roughness; the
         swing is +-9%, which at 0.18 base is 0.164..0.196 — a difference you
         only ever see in the length of a specular streak, which is precisely
         where the eye looks for "is this a photograph". */
      rough: mkTex(grayCanvas(S2, function (x, y) {
        return clamp(0.945 + 0.075 * (peel(x, y) - 0.5) + 0.055 * (swirl(x, y) - 0.5)
                   + 0.030 * (vn(x * 2.9, y * 2.9, 0) - 0.5), 0.55, 1);
      }), false)
    };
  }

  /* ---- brushed / drawn stainless ------------------------------------------
     Rails, stanchions and pulpit tube are DRAWN tube: the grain runs along
     the axis, so the sun makes a long streak down the length rather than a
     round blob.  A CylinderGeometry runs u around the section and v along it,
     so the streaks must vary in u and hold in v. */
  function texSteel() {
    var W = 128, H = 32;
    /* Built from integer-cycle sinusoids so it tiles EXACTLY in both axes —
       a rail is 4 m of one texture repeated, and a wrap seam on it is a
       brighter tell than the missing grain was. */
    var SF = [], k;
    for (k = 0; k < 9; k++) {
      SF.push([Math.round(2 + hash1(k * 2.7 + 1.1) * 44),   // cycles around u
               hash1(k * 5.3 + 0.4) * TAU,                  // phase
               1 / (1 + k * 0.85)]);                        // weight
    }
    function streak(x, y) {
      var u = x / W, v = y / H, s = 0, w = 0;
      for (var q = 0; q < SF.length; q++) {
        s += Math.sin(u * TAU * SF[q][0] + SF[q][1] + Math.sin(v * TAU + SF[q][1]) * 0.42) * SF[q][2];
        w += SF[q][2];
      }
      return 0.5 + 0.5 * (s / w);
    }
    return {
      rough: mkTex(grayCanvas(W, function (x, y) {
        return clamp(0.86 + 0.30 * (streak(x, y) - 0.5), 0.40, 1);
      }, H), false),
      map: mkTex(grayCanvas(W, function (x, y) {
        return clamp(0.94 + 0.11 * (streak(x, y) - 0.5), 0, 1);
      }, H), true),
      normal: mkTex(normalCanvas(W, streak, 0.9, H), false)
    };
  }

  /* ---- powder-coated aluminium --------------------------------------------
     The bimini frame and the arch are coated, not polished: a fine even
     orange-peel stipple at ~0.4 mm, semi-matte, with the coating thinning on
     the outside of every bend.  Getting this wrong (leaving it as chrome) is
     half of why an arch reads as a bent chrome pipe. */
  function texPowder() {
    var S2 = 128;
    // equal scales with an explicit period so the tile wraps cleanly
    function stip(x, y) {
      return vn(x * 2.0, y * 2.0, S2 * 2.0) * 0.55
           + vn(x * 8.0, y * 8.0, S2 * 8.0) * 0.30
           + vn(x * 20.0, y * 20.0, S2 * 20.0) * 0.15;
    }
    return {
      rough: mkTex(grayCanvas(S2, function (x, y) {
        return clamp(0.56 + 0.26 * (stip(x, y) - 0.5)
                   + 0.10 * (vn(x * 0.25, y * 0.25, S2 * 0.25) - 0.5), 0.2, 1);
      }), false),
      map: mkTex(grayCanvas(S2, function (x, y) {
        return clamp(0.86 + 0.10 * (stip(x, y) - 0.5), 0, 1);
      }), true),
      normal: mkTex(normalCanvas(S2, stip, 1.5), false)
    };
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
    uGrime: { value: 1.0 },
    /* Global scale on the object-space micro-bump, so the whole boat's
       surface break-up can be calibrated against a measured high-pass
       contrast without recompiling seventeen materials. */
    uMicro: { value: 1.0 },
    /* ---- analytic sun lobe -------------------------------------------------
       The environment probe is a PMREM: even at 256 its sharpest mip carries
       the sun as a soft blob a few degrees across, so a roughness-0.15
       stainless tube reflecting it peaks around 60% grey and NOTHING on the
       boat ever clips.  A photograph of the same tube in noon sun has a
       blown-white streak down it that bleeds into the lens.  So the sun gets
       its own tight punctual lobe on top of the IBL, in VIEW space, gated by
       the shadow term and by gloss, which is what finally lets stainless,
       clearcoat and instrument glass hit 1.0 and feed the bloom. */
    uSunV: { value: new T.Vector3(0.30, 0.90, -0.30) },
    uSunRad: { value: new T.Vector3(1.0, 0.95, 0.85) },
    uGlint: { value: 1.0 },
    /* WORLD-space sun direction.  The lateral bounce term above was isotropic,
       which is exactly why a two-light rig looks composited: at golden hour the
       half of the sky the sun is in is two stops brighter and three thousand
       kelvin warmer than the half behind you, and a cockpit surface facing that
       way has to know it.  vWN . uSunW gives every fragment its own azimuth
       against the key, which is the cheap stand-in for an SH-L2 probe set. */
    uSunW: { value: new T.Vector3(0.30, 0.90, -0.30) },
    /* The warm side-fill delta that rides on top of the neutral lateral bounce,
       weighted toward the sun's azimuth.  Near zero at noon, large and amber at
       17:45 — this is the term that puts orange under the hardtop. */
    uBounceWarm: { value: new T.Vector3(0.0, 0.0, 0.0) },
    uRim: { value: 1.0 },
    /* ---- local cube probes -------------------------------------------------
       Two probes, both WORLD-axis aligned (see probeUpdate).  Probe 1 (the
       helm/cockpit volume) is box-projected, so uProbeP / uBoxMin / uBoxMax
       carry its world position and the world AABB of the cockpit box. */
    uProbeP: { value: new T.Vector3(0, 5, 0) },
    uBoxMin: { value: new T.Vector3(-3.2, 3.6, -2.2) },
    uBoxMax: { value: new T.Vector3(3.2, 6.1, 3.3) }
  };

  var GLSL_NOISE = [
    'float yhash(vec3 p){ p=fract(p*0.3183099+vec3(0.71,0.113,0.419)); p*=17.0;',
    '  return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }',
    'float ynoise(vec3 x){ vec3 i=floor(x), f=fract(x); f=f*f*(3.0-2.0*f);',
    '  return mix(mix(mix(yhash(i),yhash(i+vec3(1,0,0)),f.x),',
    '                 mix(yhash(i+vec3(0,1,0)),yhash(i+vec3(1,1,0)),f.x),f.y),',
    '             mix(mix(yhash(i+vec3(0,0,1)),yhash(i+vec3(1,0,1)),f.x),',
    '                 mix(yhash(i+vec3(0,1,1)),yhash(i+vec3(1,1,1)),f.x),f.y),f.z); }',
    'float yfbm(vec3 p){ return ynoise(p)*0.57+ynoise(p*2.17)*0.29+ynoise(p*5.31)*0.14; }',
    'float yfbm2(vec3 p){ return ynoise(p)*0.66+ynoise(p*2.31)*0.34; }'
  ].join('\n');

  /* patchMat(mat, opts)
       opts.grime  0..1  how much dirt/salt this surface accumulates
       opts.salt   0..1  salt bloom weight (topsides want it, teak does not)
       opts.rvar   roughness variance amplitude
       opts.micro  RMS SURFACE SLOPE of the object-space micro-bump, i.e.
                   tan(tilt).  0.04 is gelcoat orange peel (~2 deg), 0.20 is
                   moulded non-skid.  Stated as a slope, not as a shader
                   constant, because the shader constant depends on the
                   frequency and getting that coupling wrong once produced a
                   cast-concrete hull.
       opts.mscale micro-bump base frequency, cycles/metre
       opts.up     roughness climb on UP-facing surfaces.  Real gelcoat is not
                   one number across a moulding: a horizontal face is handled,
                   walked on, rained on and wiped, and comes up measurably
                   duller than the vertical topside 200 mm away.
       opts.haze   wax/salt haze weight — a drying film that streaks the gloss
                   without changing the colour.
       opts.envv   per-panel envMapIntensity break, 0..1 of full amplitude.
                   Adjacent mouldings that share one identical specular
                   response are read as one moulded plastic object.
       opts.glint  weight of the analytic sun lobe (0 kills it).
       opts.grip   1 = this material is the wheel rim; adds hand-wear at
                   10-and-2 in wheel-local coordinates.                     */
  function patchMat(mat, opts) {
    if (!mat || mat.__yPatched) return mat;
    mat.__yPatched = true;
    var o = opts || {};
    var kG = o.grime === undefined ? 1.0 : o.grime;
    var kS = o.salt === undefined ? 0.55 : o.salt;
    var kR = o.rvar === undefined ? 0.13 : o.rvar;
    var kSlope = o.micro === undefined ? 0.0 : o.micro;
    var kF = o.mscale === undefined ? 140.0 : o.mscale;
    var kUp = o.up === undefined ? 0.0 : o.up;
    var kHz = o.haze === undefined ? 0.0 : o.haze;
    var kEV = o.envv === undefined ? 0.10 : o.envv;
    var kGl = o.glint === undefined ? 1.0 : o.glint;
    var kGrip = o.grip ? 1 : 0;
    var kRim = o.rim === undefined ? 0.55 : o.rim;
    /* probe 1 = the parallax-corrected cockpit probe; anything else takes the
       open probe above the hardtop and samples it as an infinite environment. */
    var kBox = o.probe === 1 ? 1 : 0;
    mat.__yProbe = kBox;
    /* The three-octave stack below contributes a slope of roughly
       kF * (1 + 0.17*1.90 + 2.60*0.42) = kF * 2.41 per unit of the shader
       constant; in quadrature that is about kF * 1.55.  Invert it so the
       author states the slope and the shader gets the constant. */
    var kM = kSlope / (1.55 * kF);
    // if a mesh has no aAO attribute the GL default would be 0 (= fully
    // occluded = black).  This makes the default 1 instead: fail bright.
    mat.defaultAttributeValues = mat.defaultAttributeValues || {};
    mat.defaultAttributeValues.aAO = new Float32Array([1]);
    mat.defaultAttributeValues.aCav = new Float32Array([1]);
    var prevOBC = mat.onBeforeCompile;
    mat.onBeforeCompile = function (sh) {
      if (prevOBC) { try { prevOBC.call(mat, sh); } catch (e) { } }
      sh.uniforms.uBounceDn = UNI.uBounceDn;
      sh.uniforms.uBounceUp = UNI.uBounceUp;
      sh.uniforms.uBounceSide = UNI.uBounceSide;
      sh.uniforms.uGrime = UNI.uGrime;
      sh.uniforms.uMicro = UNI.uMicro;
      sh.uniforms.uSunV = UNI.uSunV;
      sh.uniforms.uSunRad = UNI.uSunRad;
      sh.uniforms.uGlint = UNI.uGlint;
      sh.uniforms.uSunW = UNI.uSunW;
      sh.uniforms.uBounceWarm = UNI.uBounceWarm;
      sh.uniforms.uRim = UNI.uRim;
      if (kBox) {
        sh.uniforms.uProbeP = UNI.uProbeP;
        sh.uniforms.uBoxMin = UNI.uBoxMin;
        sh.uniforms.uBoxMax = UNI.uBoxMax;
      }

      sh.vertexShader = sh.vertexShader
        .replace('void main() {',
          'attribute float aAO;\nattribute float aCav;\nvarying float vAO;\nvarying float vCav;\n' +
          'varying vec3 vMP;\nvarying vec3 vON;\nvarying vec3 vWN;\n' +
          (kBox ? 'varying vec3 vWPos;\n' : '') + 'void main() {')
        .replace('#include <begin_vertex>',
          '#include <begin_vertex>\n  vAO = aAO; vCav = aCav; vMP = transformed; vON = normalize(objectNormal);\n' +
          '  vWN = normalize(mat3(modelMatrix) * objectNormal);\n' +
          (kBox ? '  vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\n' : ''));

      sh.fragmentShader = sh.fragmentShader
        /* The box-projection helpers are FUNCTIONS, so their varyings and
           uniforms have to be declared above the pars includes rather than in
           the usual pre-main block — GLSL has no forward declarations. */
        .replace(/^/, kBox ? [
          'varying vec3 vWPos;',
          'uniform vec3 uProbeP;',
          'uniform vec3 uBoxMin;',
          'uniform vec3 uBoxMax;',
          ''
        ].join('\n') : '')
        /* ---- PARALLAX-CORRECTED LOCAL PROBE ------------------------------
           three samples every environment map as if it were infinitely far
           away.  That is correct for a sky dome and completely wrong for a
           probe rendered from inside a 6 x 5 x 2.5 m box: the reflection of
           the coaming, the hardtop lip and the open side then behaves like a
           painted-on gradient that slides with the CAMERA instead of with the
           geometry, which is precisely the "flat grey card with clearcoat
           written on it" read.  Intersecting the reflection ray with the
           cockpit's own bounding box and re-referencing it to the probe
           origin makes the horizon line and the hardtop edge crawl across the
           gelcoat the way they do in a photograph. */
        .replace('#include <envmap_physical_pars_fragment>', kBox ? [
          '#include <envmap_physical_pars_fragment>',
          '#if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )',
          'vec3 yBoxDir( const in vec3 dw ) {',
          '  vec3 nd = normalize(dw);',
          // never divide by a zero component: an axis-aligned ray would return
          // an infinity that poisons the min() below
          '  vec3 na = max(abs(nd), vec3(1e-5));',
          '  nd = vec3(nd.x < 0.0 ? -na.x : na.x, nd.y < 0.0 ? -na.y : na.y, nd.z < 0.0 ? -na.z : na.z);',
          '  vec3 rmax = (uBoxMax - vWPos) / nd;',
          '  vec3 rmin = (uBoxMin - vWPos) / nd;',
          '  vec3 rb = vec3(nd.x > 0.0 ? rmax.x : rmin.x,',
          '                 nd.y > 0.0 ? rmax.y : rmin.y,',
          '                 nd.z > 0.0 ? rmax.z : rmin.z);',
          '  float fa = min(min(rb.x, rb.y), rb.z);',
          // a fragment outside the box (a rope tail, a flapping sheet) gets the
          // plain infinite lookup rather than a wildly mirrored one
          '  if (!(fa > 0.0) || fa > 60.0) return dw;',
          '  return (vWPos + nd * fa) - uProbeP;',
          '}',
          'vec3 yIBL( const in vec3 viewDir, const in vec3 nrm, const in float rough ) {',
          '  vec3 rv = reflect(-viewDir, nrm);',
          '  rv = normalize(mix(rv, nrm, rough * rough));',
          '  rv = inverseTransformDirection(rv, viewMatrix);',
          '  return textureCubeUV(envMap, yBoxDir(rv), rough).rgb * envMapIntensity;',
          '}',
          '#ifdef USE_ANISOTROPY',
          'vec3 yIBLA( const in vec3 viewDir, const in vec3 nrm, const in float rough,',
          '            const in vec3 bt, const in float an ) {',
          '  vec3 bn = cross(bt, viewDir);',
          '  bn = normalize(cross(bn, bt));',
          '  bn = normalize(mix(bn, nrm, pow2(pow2(1.0 - an * (1.0 - rough)))));',
          '  return yIBL(viewDir, bn, rough);',
          '}',
          '#endif',
          '#endif'
        ].join('\n') : '#include <envmap_physical_pars_fragment>')
        .replace('#include <lights_fragment_maps>', kBox ? [
          '#if defined( RE_IndirectDiffuse )',
          '  #ifdef USE_LIGHTMAP',
          '    vec4 lightMapTexel = texture2D( lightMap, vLightMapUv );',
          '    irradiance += lightMapTexel.rgb * lightMapIntensity;',
          '  #endif',
          '  #if defined( USE_ENVMAP ) && defined( STANDARD ) && defined( ENVMAP_TYPE_CUBE_UV )',
          '    iblIrradiance += getIBLIrradiance( geometryNormal );',
          '  #endif',
          '#endif',
          '#if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )',
          '  #if defined( ENVMAP_TYPE_CUBE_UV )',
          '    #ifdef USE_ANISOTROPY',
          '      radiance += yIBLA( geometryViewDir, geometryNormal, material.roughness, material.anisotropyB, material.anisotropy );',
          '    #else',
          '      radiance += yIBL( geometryViewDir, geometryNormal, material.roughness );',
          '    #endif',
          '    #ifdef USE_CLEARCOAT',
          '      clearcoatRadiance += yIBL( geometryViewDir, geometryClearcoatNormal, material.clearcoatRoughness );',
          '    #endif',
          '  #else',
          '    #ifdef USE_ANISOTROPY',
          '      radiance += getIBLAnisotropyRadiance( geometryViewDir, geometryNormal, material.roughness, material.anisotropyB, material.anisotropy );',
          '    #else',
          '      radiance += getIBLRadiance( geometryViewDir, geometryNormal, material.roughness );',
          '    #endif',
          '    #ifdef USE_CLEARCOAT',
          '      clearcoatRadiance += getIBLRadiance( geometryViewDir, geometryClearcoatNormal, material.clearcoatRoughness );',
          '    #endif',
          '  #endif',
          '#endif'
        ].join('\n') : '#include <lights_fragment_maps>')
        .replace('void main() {',
          'uniform vec3 uBounceDn;\nuniform vec3 uBounceUp;\nuniform vec3 uBounceSide;\n' +
          'uniform vec3 uBounceWarm;\nuniform vec3 uSunW;\nuniform float uRim;\n' +
          'uniform float uGrime;\nuniform float uMicro;\n' +
          'uniform vec3 uSunV;\nuniform vec3 uSunRad;\nuniform float uGlint;\n' +
          'varying float vAO;\nvarying float vCav;\nvarying vec3 vMP;\nvarying vec3 vON;\n' +
          'varying vec3 vWN;\n' + GLSL_NOISE +
          '\nfloat yDirt, yWear, ySalt, yFine;\nfloat yCav = 1.0, yUp = 0.0, yHaze = 0.0, yPanel = 1.0;\n' +
          'float ySh = 1.0;\nvec3 yBump = vec3(0.0);\nvoid main() {')
        /* Capture the sun's own shadow term. three computes it inside the
           light loop and then throws it away; we need it 30 lines later, in
           <aomap_fragment>, because the hand-rolled bounce below is added
           straight into indirectDiffuse and — until this line existed — a
           fully shadowed cockpit surface still collected 100% of it, which
           flattened out whatever contrast the (correctly computed) shadow
           had produced. Same call three makes, one light, r160 signature. */
        .replace('#include <lights_fragment_begin>', [
          '#include <lights_fragment_begin>',
          '#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0',
          '  {',
          '    DirectionalLightShadow ySd = directionalLightShadows[ 0 ];',
          '    ySh = getShadow( directionalShadowMap[ 0 ], ySd.shadowMapSize, ySd.shadowBias,',
          '                     ySd.shadowRadius, vDirectionalShadowCoord[ 0 ] );',
          '  }',
          '#endif'
        ].join('\n'))
        /* --- grime, salt and value break-up ------------------------------
           REWRITTEN.  The previous version put a 3 m-wavelength fbm straight
           into albedo at +-15.5% and added a raw (1 - AO) term on top; on a
           white topside that draws big soft charcoal clouds, which is a far
           louder "this is CG" flag than the flat white it was trying to
           cure — it reads as soot, not as weather.  Weathering on a boat is
           DIRECTIONAL and SMALL: rain and spray run DOWN, dirt collects in
           crevices and on up-facing surfaces, salt dries white and climbs
           from the waterline.  So: broad tonal drift drops to +-3%, and the
           energy goes into a vertically-stretched run-down stain, a crevice
           term gated through a smoothstep, and centimetre-scale flake that
           lives mostly in the roughness where it belongs. */
        .replace('#include <map_fragment>', [
          '#include <map_fragment>',
          '  {',
          '    float gUp  = clamp(vON.y, 0.0, 1.0);',
          '    float side = 1.0 - abs(vON.y);',
          '    yUp = gUp;',
          /* SHORT-RANGE CAVITY.  vAO is a 2.6 m hemisphere estimate — a
             room-scale term.  vCav is the same march stopped at 34 cm, so it
             only fires where two parts actually MEET: the winch foot against
             the teak, the spoke root in the rim, the stanchion into the
             coaming, the tube into the bimini beam.  That tight dark band,
             plus the grime and sealant that collect in it, is what makes
             hardware read as bolted through rather than resting on top. */
          '    float crv  = 1.0 - clamp(vCav, 0.0, 1.0);',
          '    yCav = crv;',
          '    float cav  = smoothstep(0.16, 0.74, 1.0 - clamp(vAO, 0.0, 1.0));',
          '    cav = max(cav, crv * 0.85);',
          '    float nBrd = ynoise(vMP * 0.30 + 4.0);',
          '    float nMid = yfbm2(vMP * 2.60 + 11.0);',
          '    float nDec = ynoise(vMP * 7.80 + 23.0);',
          '    yFine      = ynoise(vMP * 31.0 + 31.0);',
          '    yWear      = nMid;',
          /* RUN-DOWN.  The sample point is compressed 15x in Y, so the same
             noise that draws blobs on a horizontal surface draws vertical
             runs on a vertical one.  Gated on side-facing normals and grown
             out of the crevices, because that is where water actually
             leaves a boat: out of a scupper, off a hatch lip, under a
             stanchion base. */
          '    float run  = ynoise(vec3(vMP.x * 5.4, vMP.y * 0.36, vMP.z * 5.4) + 7.0);',
          '    run = smoothstep(0.47, 0.88, run) * side * (0.20 + 1.00 * cav);',
          '    float grit = clamp(nMid * 0.80 + nBrd * 0.40 - 0.44, 0.0, 1.0);',
          '    yDirt = clamp(grit * (0.18 + 0.90 * gUp) + cav * 0.52 + run * 0.62,',
          '                  0.0, 1.0) * uGrime * ' + kG.toFixed(3) + ';',
          '    diffuseColor.rgb *= mix(vec3(1.0), vec3(0.705, 0.688, 0.632), yDirt * 0.38);',
          /* Value break-up across four decades of scale, all of it NEUTRAL —
             a pure luminance multiplier with no hue shift, which is what
             stops it reading as dirt.  The broad term is deliberately the
             smallest of the four: it is the one the old shader over-drove,
             and a 3 m blotch is always read as a stain, never as a surface.
             The 13 cm and 3 cm terms are the ones the eye actually uses to
             decide whether it is looking at a photograph, because they are
             the scales still resolvable at cockpit and mid-deck distance. */
          '    diffuseColor.rgb *= (1.0 + 0.030 * (nBrd - 0.5)',
          '                             + 0.048 * (nMid - 0.5)',
          '                             + 0.062 * (nDec - 0.5)',
          '                             + 0.070 * (yFine - 0.5));',
          /* SALT.  Climbs from the waterline, dries white (not grey), and is
             gone by the time you reach the coachroof. */
          '    float saltH = smoothstep(-0.10, 0.75, vMP.y) * (1.0 - smoothstep(2.3, 5.6, vMP.y));',
          '    ySalt = clamp((yfbm2(vMP * 1.75 + 19.0) - 0.42) * 3.1, 0.0, 1.0)',
          '          * saltH * (0.30 + 0.70 * side) * uGrime * ' + kS.toFixed(3) + ';',
          /* A dried salt film is a thin scattering layer, so it LIFTS a dark
             surface toward its own albedo rather than replacing it.  Keep the
             lift small: at 0.115 the near-black hull band and the smoked
             windows came back as pale beige rectangles that read as decals. */
          '    diffuseColor.rgb = mix(diffuseColor.rgb,',
          '                           diffuseColor.rgb * 0.90 + vec3(0.062, 0.064, 0.066), ySalt);',
          '    yDirt = max(yDirt, ySalt * 0.30);',
          /* CREVICE LINE.  A hard, narrow darkening exactly where the cavity
             term fires, carrying a touch of the warm-grey sealant/salt colour
             that actually lives in a bedded joint.  Kept separate from yDirt
             so it cannot be washed out by the broad weathering. */
          '    diffuseColor.rgb *= mix(1.0, 0.52, crv * 0.92);',
          '    diffuseColor.rgb = mix(diffuseColor.rgb,',
          '                           diffuseColor.rgb * vec3(1.06, 1.00, 0.92),',
          '                           smoothstep(0.35, 0.95, crv));',
          /* PER-PANEL RESPONSE.  One low-frequency object-space field at about
             1.4 m, quantised softly, so adjacent mouldings do not share an
             identical specular gain. */
          '    yPanel = 1.0 + ' + (kEV * 1.35).toFixed(4) + ' * (yfbm2(vMP * 0.72 + 51.0) - 0.5) * 2.0;',
          /* WAX / SALT HAZE.  A drying film streaks DOWN and pools on the
             horizontal, and it changes gloss, not colour: a hazed panel keeps
             its albedo but the reflected horizon goes soft in patches.  This
             is the last thing missing from a moulding that already has peel
             and swirl, and it is the one a viewer names as "not polished
             recently" rather than as "dirty". */
          kHz > 0 ? [
            '    float hz = yfbm2(vec3(vMP.x * 2.10, vMP.y * 0.55, vMP.z * 2.10) + 63.0);',
            '    yHaze = clamp((hz - 0.40) * 2.05, 0.0, 1.0)',
            '         * (0.30 + 0.70 * gUp) * ' + kHz.toFixed(3) + ';'
          ].join('\n') : '',
          kGrip ? [
            /* Hand wear on the wheel rim: the leather at 10-and-2 is
               compressed, darkened and polished by ten thousand hours of
               palms, and the grain there is half gone. */
            '    float ga = atan(vMP.y, vMP.x);',
            '    float g1 = exp(-pow((ga - 0.524) / 0.40, 2.0));',
            '    float g2 = exp(-pow((ga - 2.618) / 0.40, 2.0));',
            '    float g3 = exp(-pow((ga + 1.571) / 0.55, 2.0)) * 0.45;',
            '    yWear = clamp(g1 + g2 + g3, 0.0, 1.0);',
            '    diffuseColor.rgb *= mix(1.0, 0.74, yWear * 0.85);',
            '    diffuseColor.rgb = mix(diffuseColor.rgb,',
            '                           diffuseColor.rgb * vec3(1.10, 1.02, 0.94), yWear * 0.6);',
            /* DE-TILING.  The wrap texture goes round the rim exactly 18 times,
               and 18 identical stitch panels marching round a 1 m circle is the
               single most legible repeat anywhere on the boat.  Three
               incommensurate harmonics of the rim angle break the value, the
               hue and the gloss between one wrap section and the next, so no
               two adjacent panels read as the same leather even though they
               share a texel for texel identical map. */
            '    float gw = 0.052 * sin(ga * 5.0 + 0.7)',
            '             + 0.038 * sin(ga * 11.0 + 2.3)',
            '             + 0.030 * sin(ga * 23.0 + 5.1);',
            '    diffuseColor.rgb *= (1.0 + gw);',
            '    diffuseColor.rgb = mix(diffuseColor.rgb,',
            '                           diffuseColor.rgb * vec3(1.05, 0.99, 0.93),',
            '                           clamp(0.5 + 2.4 * gw, 0.0, 1.0) * 0.35);',
            /* The tail of the wrap where it turns away from the light: leather
               that has never been gripped keeps its nap and goes matte, and the
               falloff has to be a smooth function of the rim angle rather than
               a texture event, or the whole rim shares one gloss. */
            '    yHaze = max(yHaze, clamp(0.42 - gw * 3.0, 0.0, 1.0) * 0.55);'
          ].join('\n') : '',
          '  }'
        ].join('\n'))
        /* Micro-contrast lives HERE, not in albedo.  A gloss surface whose
           roughness is one constant returns a specular whose terminator is a
           mathematically clean curve, and that single fact is most of what
           separates a render from a photograph.  Three scales: the material's
           own wear band, the dirt/salt matting, and a centimetre flake. */
        .replace('#include <roughnessmap_fragment>', [
          '#include <roughnessmap_fragment>',
          '  roughnessFactor = clamp(roughnessFactor',
          '                        + (yWear - 0.5) * ' + kR.toFixed(3),
          '                        + yDirt * 0.30 + ySalt * 0.34',
          /* Up-facing climb.  A horizontal moulding is handled and walked on;
             a crevice holds compound and dust.  Both are ROUGHNESS events,
             not colour events, and stating them here is what breaks the one
             constant-roughness plane that the whole hull family shared. */
          '                        + yUp * yUp * ' + kUp.toFixed(3),
          '                        + yCav * ' + (0.22 + kUp * 0.6).toFixed(3),
          '                        + yHaze * 0.30',
          '                        + (yFine - 0.5) * 0.115, 0.015, 1.0);',
          kGrip ? '  roughnessFactor = clamp(roughnessFactor - yWear * 0.34, 0.06, 1.0);' : ''
        ].join('\n'))
        /* OBJECT-SPACE MICRO-BUMP.  Measured on the shipped build, a flat
           gelcoat coaming face returns 0.91% local (9 px high-pass) contrast;
           a photograph of the same panel returns 2.5-4%.  That gap IS the
           "untextured white plastic" verdict, and it cannot be closed with a
           texture: the gel meshes are BoxGeometry, whose UVs run 0..1 per
           face regardless of the face being 4.4 m or 40 mm, so one tiling
           rate lands orange peel at 16 cm on a coaming and 1.4 mm on a
           locker lid. Object space has no such problem — the frequency is in
           cycles per METRE and is therefore correct on every panel of the
           boat. Perturbation is built by forward differences of the noise
           against the screen-space derivatives of the view position (three's
           own perturbNormalArb algebra), so the amplitude is independent of
           distance and the bump self-anti-aliases: once a cycle is smaller
           than a pixel, dFdx of the noise stops growing and the perturbation
           fades instead of boiling. */
        .replace('#include <normal_fragment_maps>', [
          '#include <normal_fragment_maps>',
          kM > 0 ? [
            '  {',
            /* 1/f stack: the fine octave is the flake, the coarse one the
               panel unevenness that survives to 20 m.  Amplitudes rise as
               the frequency falls so each octave contributes a comparable
               SLOPE rather than a comparable height. */
            '    float yh = ynoise(vMP * ' + kF.toFixed(2) + ')',
            '             + 1.90 * ynoise(vMP * ' + (kF * 0.17).toFixed(3) + ' + 9.0)',
            '             + 0.42 * ynoise(vMP * ' + (kF * 2.60).toFixed(2) + ' + 3.0);',
            '    vec2 yd = vec2(dFdx(yh), dFdy(yh)) * (' + kM.toPrecision(5) + ' * uMicro);',
            '    vec3 sx = dFdx(-vViewPosition), sy = dFdy(-vViewPosition);',
            '    vec3 r1 = cross(sy, normal), r2 = cross(normal, sx);',
            '    float dt = dot(sx, r1);',
            '    if (abs(dt) > 1e-12) {',
            '      yBump = sign(dt) * (yd.x * r1 + yd.y * r2);',
            '      normal = normalize(abs(dt) * normal - yBump);',
            '      yBump /= max(abs(dt), 1e-12);',
            '    }',
            '  }'
          ].join('\n') : ''
        ].join('\n'))
        /* The peel lives in the CLEARCOAT as much as in the base coat — that
           is what makes a gelcoat highlight ripple instead of being a clean
           ellipse — so the same perturbation goes on the coat normal. */
        .replace('#include <clearcoat_normal_fragment_maps>', [
          '#include <clearcoat_normal_fragment_maps>',
          '#ifdef USE_CLEARCOAT',
          '  clearcoatNormal = normalize(clearcoatNormal - yBump * 0.80);',
          '#endif'
        ].join('\n'))
        /* Clearcoat is a SECOND lobe and it was being left perfectly uniform,
           so gelcoat mirrored the sky through a flawless varnish while the
           base coat underneath carried all the wear. Break it by the same
           flake, and let dirt kill the coat locally. */
        .replace('#include <lights_physical_fragment>', [
          '#include <lights_physical_fragment>',
          '#ifdef USE_CLEARCOAT',
          '  material.clearcoatRoughness = clamp(material.clearcoatRoughness',
          '        + (yFine - 0.5) * 0.075 + yDirt * 0.22',
          '        + yHaze * 0.26 + yUp * yUp * ' + (kUp * 0.55).toFixed(4),
          '        + yCav * 0.18, 0.006, 1.0);',
          '  material.clearcoat = clamp(material.clearcoat * (1.0 - yDirt * 0.35)',
          '        * (1.0 - yHaze * 0.30) * (1.0 - yCav * 0.45), 0.0, 1.0);',
          '#endif'
        ].join('\n'))
        /* --- ANALYTIC SUN LOBE -------------------------------------------
           The IBL cannot produce a clipping highlight: a PMREM's sharpest mip
           spreads the solar disk over several degrees, so the brightest thing
           a polished tube ever returned was a soft grey oval.  This is a
           punctual GGX lobe for the sun alone, in view space, weighted by
           gloss so matte surfaces get nothing and by the sun's own shadow so
           a tube in shade stays in shade.  It is what puts a hard white dot
           on the wheel knobs, a blown streak down the stainless and a
           specular clip on the clearcoat that the bloom can pick up. */
        .replace('#include <lights_fragment_end>', [
          '#include <lights_fragment_end>',
          kGl > 0 ? [
            '  {',
            '    vec3 yL = normalize(uSunV);',
            '    float yNL = dot(normal, yL);',
            '    if (yNL > 0.0) {',
            '      vec3 yV = normalize(vViewPosition);',
            '      vec3 yH = normalize(yL + yV);',
            '      float yNH = max(dot(normal, yH), 0.0);',
            /* Floor alpha at the solar disk's own angular radius (0.0047 rad)
               so the lobe cannot become a delta function on a mirror and
               produce a one-pixel firefly. */
            '      float ya = max(material.roughness * material.roughness, 0.0060);',
            '      float yd = yNH * yNH * (ya * ya - 1.0) + 1.0;',
            '      float yD = (ya * ya) / (3.141592654 * yd * yd);',
            '      float yVo = max(dot(normal, yV), 1e-3);',
            '      float yG = 0.5 / max(yNL + yVo, 1e-3);',
            '      float yF = exp2((-5.55473 * max(dot(yV, yH), 0.0) - 6.98316) * max(dot(yV, yH), 0.0));',
            '      vec3 yFc = material.specularColor + (vec3(1.0) - material.specularColor) * yF;',
            '      float ySharp = smoothstep(0.62, 0.10, material.roughness);',
            '      vec3 yAdd = uSunRad * (yD * yG * yNL * ySh * ySharp',
            '                * uGlint * ' + kGl.toFixed(3) + ') * yFc;',
            /* Hard ceiling.  An unclamped punctual GGX against a near-mirror
               is a delta function: it produces a single blown texel that the
               bloom then smears into a lens-flare disc across half the frame.
               The ceiling is set so the brightest surfaces clip to white and
               bleed a little, which is the photograph, and no further. */
            '      reflectedLight.directSpecular += min(yAdd, uSunRad * 150.0);',
            '    }',
            '  }'
          ].join('\n') : '',
          /* ---- SUN RIM ------------------------------------------------------
             A backlit black boom, a stainless post against a low sun and the
             leech of a sail all carry a bright edge where the surface turns
             through grazing incidence into the key.  A two-light rig cannot
             produce it — the GGX lobe above needs N.H near 1 and dies at the
             silhouette, and the IBL is far too broad — so the limb of every
             spar in the golden frame terminated in the same value as its
             middle.  This is a Fresnel-weighted grazing term gated by the
             sun's own shadow, which is what separates a backlit object from
             the water behind it. */
          kRim > 0 ? [
            '  {',
            '    vec3 yVn = normalize(vViewPosition);',
            '    float yFr = 1.0 - clamp(dot(normal, yVn), 0.0, 1.0);',
            '    yFr = yFr * yFr * yFr * (0.30 + 0.70 * yFr);',
            '    float ySl = smoothstep(-0.30, 0.72, dot(normal, normalize(uSunV)));',
            '    reflectedLight.directSpecular += uSunRad * (yFr * ySl * ySh * uRim',
            '                                  * ' + (kRim * 3.4).toFixed(3) + ');',
            '  }'
          ].join('\n') : ''
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
          /* 0.52, not 0.42.  The cockpit was measuring 6.6% of its pixels at
             near-black with no detail in them, and an open cockpit at golden
             hour is lit by a sky dome plus a fully lit orange sea — it is a
             bright environment, not a cave.  The contrast that used to come
             from crushing the broad term now comes from the SHORT-RANGE
             cavity below, which is where it belongs. */
          '    reflectedLight.indirectDiffuse  *= mix(0.63, 1.0, contact);',
          '    reflectedLight.indirectSpecular *= mix(0.68, 1.0, contact);',
          /* Crevice-scale occlusion, applied hard.  This is the term that has
             to be tight — it must hug the winch foot and the spoke root and
             stop dead at the geometric boundary, which a screen-space AO at a
             1.5 m radius cannot do and a soft blob decal actively fights. */
          '    float ctK = 1.0 - yCav * 0.80;',
          '    reflectedLight.indirectDiffuse  *= ctK;',
          '    reflectedLight.indirectSpecular *= 1.0 - yCav * 0.66;',
          '    reflectedLight.directSpecular   *= 1.0 - yCav * 0.35;',
          /* Per-panel specular gain: two mouldings that meet at a joint no
             longer return the identical environment response. */
          '    reflectedLight.indirectSpecular *= yPanel;',
          '    float dn = clamp(-vON.y, 0.0, 1.0);',
          '    float up = clamp( vON.y, 0.0, 1.0);',
          '    float sd = 1.0 - abs(vON.y);',
          /* An overhead panel is uplit by the sea, and the sea it can see grows
             as you move outboard from the centreline toward the open edge —
             the gradient that keeps a hardtop underside from reading as one
             dead value across two metres. */
          '    float outb = 0.62 + 0.68 * smoothstep(0.0, 3.05, abs(vMP.x));',
          /* KEY / FILL SEPARATION.  Everything above is azimuthally flat, so a
             bulkhead facing into a burning western sky and the one facing the
             cold eastern half received identical fill — the single reason the
             boat reads as composited onto the sky rather than standing in it.
             uSunW is the world sun direction; projecting both it and the world
             normal onto the horizontal plane gives each fragment its own angle
             against the key, and uBounceWarm carries the amber that only the
             sunward half of the horizon actually has. */
          '    vec2 ySw = uSunW.xz;',
          '    vec2 yNw = vWN.xz;',
          '    float ySwL = length(ySw), yNwL = length(yNw);',
          '    float yAz = (ySwL > 1e-4 && yNwL > 1e-4) ? dot(ySw / ySwL, yNw / yNwL) : 0.0;',
          '    vec3 ySide = uBounceSide * (1.0 + 0.44 * yAz)',
          '               + uBounceWarm * clamp(yAz, 0.0, 1.0);',
          /* The underside of a hardtop is uplit by the sea, and the sea on the
             sun's side of the boat is a glitter path an order of magnitude
             brighter than the sea behind it.  Feed a little of the same
             azimuth in, so the bimini has a gradient across its width instead
             of one dead value. */
          '    vec3 yDn = uBounceDn + uBounceWarm * (0.42 * clamp(yAz, 0.0, 1.0));',
          '    vec3 bounce = yDn * (dn * outb) + uBounceUp * up',
          '                + ySide * sd;',
          /* Whatever is between this fragment and the sun is also between it
             and most of the sunlit deck and water that produced the bounce.
             Not zero — the sea beyond the shadow still throws light in — but
             not the full term either. */
          /* 0.60, not 0.42.  What is between this fragment and the sun is a
             hardtop or a coaming — it is NOT between the fragment and the
             three metres of open side through which a fully lit orange sea
             fills the cockpit.  Attenuating the whole bounce by the sun's own
             shadow term treated the uplight as if it came from the sun
             directly, and that single factor is most of what crushed the
             shaded cockpit to black. */
          '    bounce *= mix(0.60, 1.0, ySh);',
          '    reflectedLight.indirectDiffuse += material.diffuseColor * bounce',
          '                                    * RECIPROCAL_PI * mix(0.70, 1.0, contact) * ctK;',
          /* A METAL HAS NO DIFFUSE PATH.  Every bit of the sea/deck uplight
             above was landing on indirectDiffuse, which for metalness 1 is
             identically zero — so a polished tube under the hardtop was lit
             by the probe alone, and the probe sees mostly dark deck when it
             looks down.  That is precisely why the bimini post's specular
             contrast collapsed in its lower half and terminated in a black
             stub at the sole.  The same irradiance, routed onto the specular
             lobe through the material's own F0, carries the falloff all the
             way to the deck. */
          '    reflectedLight.indirectSpecular += material.specularColor * bounce',
          '                                    * RECIPROCAL_PI * mix(0.62, 1.0, contact) * ctK * 0.90;',
          '  }'
        ].join('\n'));
    };
    mat.customProgramCacheKey = function () {
      return 'ypatch' + kG + '_' + kS + '_' + kR + '_' + kM + '_' + kF +
             '_' + kUp + '_' + kHz + '_' + kEV + '_' + kGl + '_' + kGrip +
             '_' + kRim + '_' + kBox;
    };
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
      screen: texScreen(), dial: texDial(), flag: texFlag(),
      steel: texSteel(), powder: texPowder()
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
    var gelN = X.gel.normal.clone(); gelN.repeat.set(28, 28); gelN.needsUpdate = true;
    /* The roughness tile is deliberately NOT the same rate as the normal.
       Orange peel is a 1-3 mm phenomenon; buffing swirls and flake density
       vary over a hand's width.  Running both at 28 would beat against each
       other and produce a visible moire on any large panel. */
    var gelR = X.gel.rough.clone(); gelR.repeat.set(6.5, 6.5); gelR.needsUpdate = true;
    var nsc = 0.22;

    M = {};
    /* Gelcoat is a mirror-gloss clearcoat surface: every convex radius must
       carry a blown specular streak and every horizontal face must pick up
       the sun's colour.  envMapIntensity is deliberately above 1 — the probe
       is the only thing carrying the horizon line and the bright water. */
    /* The gelcoat family is the largest thing in frame and was the single
       loudest "untextured clay" tell, so it carries the full surfacing set:
       orange peel at 2-4 mm (gelN at 28 tiles), buffing swirl and flake in the
       roughness (gelR at 6.5), an object-space micro-bump in cycles per METRE
       so the peel is the right physical size on a locker lid and on the
       coachroof alike, a roughness that CLIMBS on up-facing surfaces and into
       every crevice, a wax/salt haze that streaks the gloss without touching
       the colour, and a per-panel envMapIntensity break so two mouldings that
       meet at a joint never return the identical reflection. */
    M.gel = pbr({
      color: 0xeef1ee, roughness: 0.155, metalness: 0.0,
      clearcoat: 1.0, clearcoatRoughness: 0.040, envMapIntensity: 1.45,
      normalMap: gelN, normalScale: new T.Vector2(nsc, nsc),
      roughnessMap: gelR, envMap: env
    }, { grime: 0.85, salt: 0.75, rvar: 0.10, micro: 0.042, mscale: 150.0,
         up: 0.135, haze: 0.85, envv: 0.14 });
    M.gelGrey = pbr({
      color: 0xc3cad0, roughness: 0.22, metalness: 0.0,
      clearcoat: 0.95, clearcoatRoughness: 0.070, envMapIntensity: 1.35,
      normalMap: gelN, normalScale: new T.Vector2(nsc, nsc),
      roughnessMap: gelR, envMap: env
    }, { grime: 1.0, salt: 0.55, rvar: 0.12, micro: 0.050, mscale: 150.0,
         up: 0.150, haze: 0.95, envv: 0.15 });
    /* Helm dash panel.  Every production cat moulds this in a dark low-gloss
       grey so the sun does not bounce off it into the helmsman's eyes, and
       that dark field is what makes the instruments and the white console
       around it separate instead of collapsing into one white mass. */
    M.dash = pbr({
      color: 0x2f3438, roughness: 0.52, metalness: 0.0,
      clearcoat: 0.35, clearcoatRoughness: 0.30, envMapIntensity: 1.5,
      normalMap: gelN, normalScale: new T.Vector2(nsc * 1.4, nsc * 1.4), envMap: env
    }, { grime: 0.9, salt: 0.6, rvar: 0.14, micro: 0.085, mscale: 95.0, probe: 1 });
    /* INTERIOR GELCOAT.  Materially identical to M.gel, but bound to the
       box-projected cockpit probe instead of the open one.  The flybridge
       coamings, the helm console and the hardtop valance are the surfaces the
       review called "a Lambertian grey card with clearcoat written on it":
       they are two metres from the eye and they need reflections with
       PARALLAX — the hardtop lip, the wheel and the horizon through the open
       side sliding across them as the boat heels.  An infinitely-distant sky
       probe cannot produce that at any resolution, which is why the previous
       pass bought nothing by raising clearcoat to 1.0.  Costs one draw call. */
    /* envMapIntensity 1.85, against 1.45 for the same gelcoat on the open
       probe.  A cube rendered from inside a room is a ONE-BOUNCE estimate of a
       space whose walls light each other, so it under-reports by roughly the
       square of the surface albedo; the multiplier is the standard correction
       for it and is why interior probes are always authored hot. */
    M.gelIn = pbr({
      color: 0xeef1ee, roughness: 0.150, metalness: 0.0,
      clearcoat: 1.0, clearcoatRoughness: 0.038, envMapIntensity: 1.85,
      normalMap: gelN, normalScale: new T.Vector2(nsc, nsc),
      roughnessMap: gelR, envMap: env
    }, { grime: 0.85, salt: 0.70, rvar: 0.10, micro: 0.042, mscale: 150.0,
         up: 0.135, haze: 0.80, envv: 0.14, probe: 1 });
    M.hullBand = pbr({
      color: 0x1c2b36, roughness: 0.14, metalness: 0.0,
      clearcoat: 1.0, clearcoatRoughness: 0.035, envMapIntensity: 1.5, envMap: env,
      normalMap: gelN, normalScale: new T.Vector2(nsc * 0.8, nsc * 0.8),
      roughnessMap: gelR
    }, { grime: 0.7, salt: 0.55, rvar: 0.08, micro: 0.038, mscale: 150.0,
         up: 0.10, haze: 0.70, envv: 0.12 });
    M.boot = pbr({ color: 0x0b2438, roughness: 0.30, metalness: 0.0, clearcoat: 0.8, envMap: env },
                 { grime: 1.2, salt: 0.9, micro: 0.055, mscale: 120.0 });
    // hull windows are smoked and opaque — there is a cabin behind them, not sky
    M.hullWin = pbr({
      color: 0x070c11, roughness: 0.035, metalness: 0.0, envMap: env,
      envMapIntensity: 2.1, clearcoat: 1.0, clearcoatRoughness: 0.02
    }, { grime: 0.35, salt: 0.8, rvar: 0.05, micro: 0.018, mscale: 210.0 });
    M.antifoul = pbr({ color: 0x14242c, roughness: 0.72, metalness: 0.0, envMap: env },
                     { grime: 0.5, salt: 0.0, micro: 0.190, mscale: 42.0 });
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
    }, { grime: 0.15, salt: 0.45, rvar: 0.02, probe: 1 });
    /* Drawn stainless tube: rails, stanchions, pulpit, grab rails.  Polished
       316 is NOT a uniform mirror — it carries the draw lines from the die,
       so the sun lands as a long streak down the length instead of a round
       blob, and every one of those tubes reads as a tube rather than as a
       chrome primitive. */
    /* 1 x 7, not 1 x 3.  A draw line is a scratch a few tens of microns wide:
       at three repeats up a 2.3 m post the "grain" lands at 30 cm, which is
       not grain, it is FLUTING — and a fluted column is what the bimini
       support was reading as.  Seven repeats plus a lighter normal puts the
       streaks back below the scale at which the eye resolves them
       individually and leaves only the long specular they are there for. */
    var stlN = X.steel.normal.clone(); stlN.repeat.set(1, 7.0); stlN.needsUpdate = true;
    var stlR = X.steel.rough.clone(); stlR.repeat.set(1, 7.0); stlR.needsUpdate = true;
    var stlM = X.steel.map.clone(); stlM.repeat.set(1, 7.0); stlM.needsUpdate = true;
    M.steel = pbr({
      color: 0xd9dcdc, roughness: 0.185, metalness: 1.0, envMap: env, envMapIntensity: 1.22,
      map: stlM, roughnessMap: stlR, normalMap: stlN,
      normalScale: new T.Vector2(0.16, 0.16)
    }, { grime: 0.55, salt: 0.4, rvar: 0.10, micro: 0.045, mscale: 320.0 });
    M.steelSat = pbr({
      color: 0xc3c9cc, roughness: 0.38, metalness: 1.0, envMap: env, envMapIntensity: 1.15,
      map: stlM, roughnessMap: stlR, normalMap: stlN,
      normalScale: new T.Vector2(0.24, 0.24)
    }, { grime: 0.8, salt: 0.4, rvar: 0.14, micro: 0.085, mscale: 260.0 });
    /* POLISHED SOLID stainless — spoke knobs, ball ends, anything turned from
       bar rather than drawn from tube.  Deliberately MAPLESS.  Wrapping a
       drawn-tube streak texture round a sphere is what turned the wheel knobs
       into mottled lava marbles: the u-varying streak plus a strong normal map
       on a spherical UV produces high-frequency noise with no coherent
       reflection anywhere on it.  A turned knob is a little mirror: it should
       show a compressed image of the horizon and a hard sun dot, and nothing
       else.  All the break-up it gets is a fingerprint-scale roughness
       modulation from the object-space micro term. */
    /* Bound to the COCKPIT probe: a polished spoke ball is a fisheye mirror of
       the helm, and what sells it is the hard bright/dark split at the horizon
       plus the dark shapes of the coaming and the wheel wrapped round it.  An
       infinite sky probe gives a smooth grey gradient and nothing else, which
       is exactly what the review named as the classic ambient-probe metal.
       Roughness comes down to 0.16 as well — the probe is now sharp enough to
       carry an edge, and 0.25 was blurring the horizon line away. */
    M.chrome = pbr({
      color: 0xe3e7e9, roughness: 0.160, metalness: 1.0, envMap: env,
      envMapIntensity: 1.20
    }, { grime: 0.35, salt: 0.20, rvar: 0.045, micro: 0.020, mscale: 620.0,
         envv: 0.06, probe: 1 });
    /* Powder-coated aluminium: bimini frame, arch, hardtop supports.  A
       coating, not a polish — semi-matte with a fine even stipple, so it
       separates from the stainless standing next to it instead of every
       tube on the boat sharing one chrome look. */
    M.powder = pbr({
      color: 0xdfe3e2, roughness: 1.0, metalness: 0.08, envMap: env, envMapIntensity: 1.0,
      map: X.powder.map, roughnessMap: X.powder.rough, normalMap: X.powder.normal,
      normalScale: new T.Vector2(0.55, 0.55), clearcoat: 0.22, clearcoatRoughness: 0.55
    }, { grime: 1.0, salt: 0.55, rvar: 0.10, micro: 0.130, mscale: 300.0 });
    /* Brushed stainless is defined by what surrounds it: the drum reflects
       deck, coaming and water through the local probe, and the brushing runs
       circumferentially, so the highlight is a band and not a blob. */
    /* NEUTRAL, not cool.  A metal has no diffuse: everything you see on it is
       the environment multiplied by its own tint, so a 0xc6ced3 drum sitting
       on teak that the golden sun has just turned amber came back grey and
       read as a part cut out of a different photograph.  316 stainless is very
       close to neutral in reflectance; give it that, and it picks up the key
       light's colour the way the teak beside it does. */
    M.winch = pbr({
      color: 0xd8dad8, roughness: 0.24, metalness: 1.0, envMap: env, envMapIntensity: 1.25,
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
    }, { grime: 1.35, salt: 0.5, rvar: 0.15, micro: 0.170, mscale: 110.0 });
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
      side: T.DoubleSide, envMap: env, envMapIntensity: 1.75
    }, { grime: 0.85, salt: 0.35, rvar: 0.10, probe: 1 });
    /* Both of these live entirely INSIDE the covered volume and both face
       down or inward, so their irradiance has to come from the cockpit probe:
       given the open probe they sample its nadir, which is the top of the
       hardtop — grey gelcoat and a black solar array — and the headliner goes
       to ink under a Caribbean noon.  The cockpit probe's nadir is the lit
       teak sole two metres below them, which is the actual source. */
    M.cushion = pbr({
      map: X.cushion.map, roughnessMap: X.cushion.rough, normalMap: X.cushion.normal,
      normalScale: new T.Vector2(1.0, 1.0), roughness: 1.0, metalness: 0.0,
      clearcoat: 0.5, clearcoatRoughness: 0.4, envMap: env, envMapIntensity: 1.5
    }, { grime: 1.0, salt: 0.5, probe: 1 });
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
    /* The wrap tile is one tube-circumference square, and the rim is a 1.00 m
       torus, so it goes round exactly 2*pi*0.50 / 0.176 = 17.85 times.  18 is
       the nearest whole number — a fractional repeat would put a visible
       half-stitch seam at top dead centre of the wheel, which on the closest
       prop in the frame is worse than the wrong pitch by a factor of ten. */
    var lthM = X.leather.map.clone(), lthR = X.leather.rough.clone(), lthN = X.leather.normal.clone();
    lthM.repeat.set(18, 1); lthR.repeat.set(18, 1); lthN.repeat.set(18, 1);
    lthM.needsUpdate = lthR.needsUpdate = lthN.needsUpdate = true;
    M.leather = pbr({
      map: lthM, roughnessMap: lthR, normalMap: lthN,
      normalScale: new T.Vector2(1.25, 1.25), roughness: 1.0, metalness: 0.0,
      envMap: env, envMapIntensity: 1.40, clearcoat: 0.22, clearcoatRoughness: 0.55
    }, { grime: 0.9, salt: 0.10, rvar: 0.0, micro: 0.055, mscale: 480.0, grip: 1,
         probe: 1 });
    M.rubber = pbr({ color: 0x1b1e20, roughness: 0.82, metalness: 0.0, envMap: env },
                   { grime: 1.3, salt: 0.2, micro: 0.140, mscale: 210.0 });
    M.gasket = pbr({ color: 0x14181b, roughness: 0.70, metalness: 0.0, envMap: env },
                   { grime: 1.6, salt: 0.2 });
    M.plastic = pbr({ color: 0x2a3136, roughness: 0.45, metalness: 0.0, clearcoat: 0.4, envMap: env },
                    { grime: 0.9, salt: 0.4, micro: 0.075, mscale: 190.0 });
    M.fender = pbr({ color: 0xf3f5f2, roughness: 0.55, metalness: 0.0, clearcoat: 0.5, envMap: env },
                   { grime: 1.4, salt: 0.8, micro: 0.090, mscale: 130.0 });
    /* SOLAR GLASS.  Photovoltaic laminate is a sheet of low-iron glass over a
       near-black cell field: under a Caribbean midday sun the panel is a
       MIRROR — the rig, the sail and the whole sky sit in it — and rendering
       it as a dead-black quad is physically impossible in a way the eye
       notices instantly.  metalness goes to zero (glass is a dielectric; 0.35
       was tinting the reflection with the base colour and killing it) and the
       specular is carried entirely by a mirror clearcoat over a black base. */
    M.solar = pbr({ color: 0x05070d, roughness: 0.30, metalness: 0.0,
                    clearcoat: 1.0, clearcoatRoughness: 0.028,
                    envMap: env, envMapIntensity: 2.0 },
                  { grime: 0.5, salt: 0.6, rvar: 0.05, micro: 0.010, mscale: 260.0 });
    /* Anodised black aluminium: winch base castings, pedestal collars, clutch
       bodies.  A hard-anodised casting is not painted plastic and not polished
       steel — it is a dark, slightly warm, medium-rough metal, and having it
       under every stainless drum is most of what makes the drum read as a
       Lewmar rather than as a small metal bin. */
    M.anod = pbr({
      color: 0x24262a, roughness: 0.44, metalness: 1.0, envMap: env,
      envMapIntensity: 1.0
    }, { grime: 1.1, salt: 0.35, rvar: 0.16, micro: 0.075, mscale: 340.0 });
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
     4.  LOCAL REFLECTION PROBES
     --------------------------------------------------------------------------
     SAIL.sky publishes a PMREM built from the sky dome alone, so everything
     below the horizon in it is black: chrome reflects a gradient, topsides
     have nothing to reflect under the horizon line, and a winch reads as a
     material-preview sphere.  So we render our own.

     THREE THINGS WERE WRONG WITH THE SINGLE PROBE THIS REPLACES, and together
     they are the whole "expensive gelcoat reflecting nothing" verdict:

       1. IT WAS PARKED UNDER THE ROOF.  The camera sat at y = 5.20, which is
          between the flybridge sole (3.78) and the flybridge hardtop (6.05):
          its entire upper hemisphere was headliner.  Every clearcoat and every
          metal on the boat was therefore mirroring a large, flat, pale-grey
          lid — which is exactly what a Lambertian grey card looks like.  Drop
          a mirror sphere in the frame and you can see it: no sky, no sun, and
          a horizon squeezed into a band a few degrees high.
       2. IT WAS PARENTED TO THE HULL.  A CubeCamera bakes its faces along its
          own WORLD axes, and three then samples every environment map along
          world axes too.  Hanging the probe off a group whose rotation.y is
          -heading rotated the entire captured world by the heading, so the
          sun's reflection sat in the wrong quadrant on every polished surface
          and swung round as the boat tacked.
       3. IT WAS SAMPLED AS IF INFINITELY FAR AWAY.  Correct for a sky dome;
          meaningless for a probe rendered from the middle of a 6 x 5 x 2.5 m
          box.  Without parallax correction the reflection slides with the
          CAMERA rather than with the geometry, which reads as a painted-on
          gradient no matter how sharp the probe is.

     The replacement is two world-axis-aligned probes, both re-positioned from
     the hull's world matrix every update:

       [0] OPEN   ~0.9 m above the flybridge hardtop.  Full sky, an unbroken
                  horizon ring, the sea, the rig and the decks.  Sampled as an
                  infinite environment — correct, because everything in it
                  except the boat itself is far away.
       [1] HELM   inside the flybridge volume, beside the wheel.  Contains the
                  hardtop underside, the coamings, the console, the wheel and
                  the sea through the open sides.  Sampled BOX-PROJECTED
                  against the flybridge bounding box, so the horizon line and
                  the hardtop lip crawl across the coaming as the boat heels.

     Cost is kept flat by refreshing ONE CUBE FACE per tick at 24 Hz and
     PMREM-ing only on the sixth: a complete pair of probes every half second
     for the same face rate the single 2 Hz probe used to cost.
     ====================================================================== */
  var PBS = [
    /* 9.2 m, not 6.9.  Sitting just clear of the hardtop the probe's whole
       lower hemisphere is the roof itself — 4 m of grey gelcoat and a
       near-black solar array — so every down-facing surface on the boat drew
       its irradiance from the darkest object in the scene and the headliner
       went to ink.  Three metres higher the roof subtends a quarter of the
       lower hemisphere and the rest is lit water, which is what a deck fitting
       at this height actually sees. */
    { name: 'open', pos: [0, 9.20, 2.20], box: null,
      cubeRT: null, cam: null, out: null, ok: false },
    { name: 'helm', pos: [1.35, 5.05, -0.15],
      // the flybridge volume: sole to hardtop, coaming to coaming
      box: [[-3.12, 3.66, -2.05], [3.12, 6.06, 3.15]],
      cubeRT: null, cam: null, out: null, ok: false }
  ];
  var PB = {
    pmrem: null, failed: false, root: null,
    acc: 99, idx: 0, face: 0, interval: 1 / 24
  };

  function probeInit(root) {
    if (PB.pmrem || PB.failed) return;
    var r = SAIL.renderer;
    if (!r || !r.getContext) return;
    PB.root = root || null;
    try {
      /* 256, not 128.  Reflection sharpness is capped by the probe: every
         metal and every clearcoat on this boat was reflecting a 128-pixel
         world, which is why stainless read as painted pipe and no surface
         anywhere resolved a hard horizon line.  The remaining gap — a sun
         that CLIPS — is closed analytically by the punctual lobe in
         patchMat, because no PMREM ever will. */
      var sz = LOW() ? 96 : 256;
      PB.interval = LOW() ? 1 / 8 : 1 / 24;
      for (var i = 0; i < PBS.length; i++) {
        var p = PBS[i];
        p.cubeRT = new T.WebGLCubeRenderTarget(sz, {
          type: T.HalfFloatType, format: T.RGBAFormat,
          minFilter: T.LinearFilter, magFilter: T.LinearFilter, generateMipmaps: false
        });
        p.cam = new T.CubeCamera(0.25, 3000, p.cubeRT);
        p.cam.name = 'yacht.probe.' + p.name;
        /* NOT added to the hull group, and never rotated.  The cube has to be
           captured along world axes or three's world-space lookup samples the
           wrong face (see note 2 above). */
      }
      PB.pmrem = new T.PMREMGenerator(r);
      PB.pmrem.compileCubemapShader();
    } catch (e) {
      PB.failed = true; PB.pmrem = null;
      for (var k = 0; k < PBS.length; k++) { PBS[k].cubeRT = null; PBS[k].cam = null; }
    }
  }

  /* World position of a model-space point on the hull, and the world AABB of a
     model-space box.  The hull yaws with the heading, so the box is rebuilt
     from its eight corners rather than rotated as a box. */
  var _pw = new T.Vector3(), _pc = new T.Vector3();
  function probePlace(p) {
    var root = PB.root || API.group;
    _pw.set(p.pos[0], p.pos[1], p.pos[2]);
    if (root) { root.updateMatrixWorld(); _pw.applyMatrix4(root.matrixWorld); }
    p.cam.position.copy(_pw);
    p.cam.rotation.set(0, 0, 0);
    p.cam.updateMatrixWorld(true);
    if (!p.box) return;
    var mn = UNI.uBoxMin.value, mx = UNI.uBoxMax.value;
    mn.set(1e9, 1e9, 1e9); mx.set(-1e9, -1e9, -1e9);
    for (var i = 0; i < 8; i++) {
      _pc.set(p.box[(i & 1) ? 1 : 0][0], p.box[(i & 2) ? 1 : 0][1], p.box[(i & 4) ? 1 : 0][2]);
      if (root) _pc.applyMatrix4(root.matrixWorld);
      mn.min(_pc); mx.max(_pc);
    }
    UNI.uProbeP.value.copy(_pw);
  }

  function probeUpdate(dt, force) {
    // build() may run before app.js has published SAIL.renderer; retry here
    // rather than leaving every metal on the boat reflecting the fallback
    if (!PB.pmrem && !PB.failed) probeInit(PB.root || API.group);
    if (!PB.pmrem || PB.failed) return;
    var r = SAIL.renderer, sc = SAIL.scene;
    if (!r || !sc) return;
    PB.acc += isNum(dt) ? dt : 0.016;
    /* A settle() step hands us dt = 0.1, and a shot preset has to come up with
       both probes already correct — so any large step completes the current
       probe outright instead of dribbling one face into it. */
    var whole = force || (isNum(dt) && dt >= 0.05);
    if (!whole && PB.acc < PB.interval) return;
    PB.acc = 0;
    var tmOld = r.toneMapping, sOld = r.shadowMap.autoUpdate, rtOld = r.getRenderTarget();
    try {
      // six extra shadow-map rebuilds would cost more than the probe itself
      r.shadowMap.autoUpdate = false;
      r.toneMapping = T.NoToneMapping;
      var p = PBS[PB.idx];
      probePlace(p);
      var n = whole ? 6 - PB.face : 1;
      for (var k = 0; k < n; k++) {
        r.setRenderTarget(p.cubeRT, PB.face);
        r.render(sc, p.cam.children[PB.face]);
        PB.face++;
      }
      if (PB.face >= 6) {
        PB.face = 0;
        p.out = PB.pmrem.fromCubemap(p.cubeRT.texture, p.out || null);
        p.ok = !!(p.out && p.out.texture);
        PB.idx = (PB.idx + 1) % PBS.length;
      }
    } catch (e) {
      PB.failed = true;
      for (var q = 0; q < PBS.length; q++) PBS[q].ok = false;
    }
    r.shadowMap.autoUpdate = sOld;
    r.toneMapping = tmOld;
    r.setRenderTarget(rtOld);
  }

  /* Re-bind the environments once better ones exist.  Each material declared a
     probe index in patchMat; a probe that has not produced a PMREM yet falls
     back to the sky map, and then to the canvas gradient, so a metal is never
     left with nothing to reflect. */
  var _envSeen = [null, null];
  function envFor(i) {
    var p = PBS[i];
    if (p && p.ok && p.out && p.out.texture) return p.out.texture;
    return (SAIL.sky && SAIL.sky.envMap) || fallbackEnv();
  }
  function syncEnv() {
    if (!M) return;
    var e0 = envFor(0), e1 = envFor(1);
    if (e0 === _envSeen[0] && e1 === _envSeen[1]) return;
    _envSeen[0] = e0; _envSeen[1] = e1;
    for (var k in M) {
      var m = M[k];
      if (m && m.isMaterial && 'envMap' in m) {
        var want = (m.__yProbe === 1) ? e1 : e0;
        if (m.envMap !== want) { m.envMap = want; m.needsUpdate = true; }
      }
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
  /* Cosine-distributed hemisphere, expressed in a LOCAL frame (+Z = normal).
     ------------------------------------------------------------------------
     This is the fix for the single loudest artefact on the boat.  The baker
     used to take ONE world-space Fibonacci sphere and reject whichever half
     fell below the vertex normal.  On a curved surface — a topside, a
     coaming radius, a hull bow — the surviving subset changes DISCRETELY as
     the normal turns, so occ/wsum jumps by several percent from one vertex
     to the next with no corresponding change in geometry.  Measured on the
     shipped build that gave the merged hull meshes a per-vertex AO standard
     deviation of 0.25-0.28, which the indirect term then drew as soft
     charcoal clouds all over the white gelcoat.  The art director read those
     clouds as "untextured, dirty, CG"; they were Monte-Carlo noise.

     A fixed set in the LOCAL frame removes it by construction: neighbouring
     vertices with neighbouring normals sample neighbouring directions, so
     the estimate is a smooth function of the geometry.  Cosine-weighted, so
     the estimator is a plain mean and there is no wsum to divide by. */
  var AOHEMI = null;
  function aoHemi(n) {
    var d = [], ga = PI * (3 - Math.sqrt(5));
    for (var i = 0; i < n; i++) {
      var u = (i + 0.5) / n;
      var z = Math.sqrt(1 - u), r = Math.sqrt(u), a = i * ga;
      d.push(Math.cos(a) * r, Math.sin(a) * r, z);
    }
    return d;
  }
  /* Weld coincident vertices, then relax over the triangle-edge graph.
     Two separate jobs:
       WELD    a merged mesh carries the same corner several times (one per
               source primitive); if those disagree the merge seam shows as a
               hard value step down an otherwise continuous panel.
       RELAX   even a 30-tap estimate keeps a few percent of variance, and a
               few percent spread over a 6 m topside is exactly the scale the
               eye reads as a stain.  Three low-weight Laplacian passes remove
               it without touching the contact gradient, which is a genuine
               ~15 cm feature and therefore many edges wide. */
  function aoRelax(geo, out, iters) {
    var idx = geo.index ? geo.index.array : null;
    if (!idx || !idx.length) return;
    var pos = geo.attributes.position.array, N = out.length, i, k;
    var map = new Map(), rep = new Int32Array(N);
    for (i = 0; i < N; i++) {
      var o = i * 3;
      var key = ((Math.round(pos[o] * 200) + 8192) * 16384 +
                 (Math.round(pos[o + 1] * 200) + 8192)) * 16384 +
                 (Math.round(pos[o + 2] * 200) + 8192);
      var r = map.get(key);
      if (r === undefined) { map.set(key, i); rep[i] = i; } else rep[i] = r;
    }
    var sum = new Float32Array(N), cnt = new Float32Array(N);
    for (i = 0; i < N; i++) { sum[rep[i]] += out[i]; cnt[rep[i]] += 1; }
    for (i = 0; i < N; i++) out[i] = sum[rep[i]] / cnt[rep[i]];
    var acc = new Float32Array(N), deg = new Float32Array(N);
    for (var it = 0; it < (iters || 3); it++) {
      acc.fill(0); deg.fill(0);
      for (k = 0; k + 2 < idx.length; k += 3) {
        var a = rep[idx[k]], b = rep[idx[k + 1]], c = rep[idx[k + 2]];
        acc[a] += out[b] + out[c]; deg[a] += 2;
        acc[b] += out[a] + out[c]; deg[b] += 2;
        acc[c] += out[a] + out[b]; deg[c] += 2;
      }
      for (i = 0; i < N; i++) {
        var q = rep[i];
        if (deg[q] > 0.5) out[i] = out[i] * 0.40 + (acc[q] / deg[q]) * 0.60;
      }
      // duplicates must stay in lockstep or the weld undoes itself
      for (i = 0; i < N; i++) if (rep[i] !== i) out[i] = out[rep[i]];
    }
  }
  function aoBake(geo, mtx) {
    if (!AOG.g || !geo || !geo.attributes || !geo.attributes.position) return;
    if (!geo.attributes.normal) geo.computeVertexNormals();
    var p = geo.attributes.position.array, nr = geo.attributes.normal.array;
    var N = geo.attributes.position.count, out = new Float32Array(N);
    var cav = new Float32Array(N);
    if (!AOHEMI) AOHEMI = aoHemi(LOW() ? 14 : 30);
    var D = AOHEMI, ND = D.length / 3;
    var e = mtx ? mtx.elements : null;
    /* Growing step sizes: 2.6 m of reach in 10 taps.  Left exactly as it was —
       the ray start offset (0.105 along the normal) is tuned against the 12 cm
       voxel so that a grazing ray clears its own surface cell at the FIRST
       sample, and shortening the first step would self-occlude the whole boat.
       What is new is that the first three samples are also accumulated
       SEPARATELY, weighted to zero by 52 cm, into a contact term.  That band
       is what resolves the winch foot on the teak, the spoke root in the rim
       and the stanchion through the coaming; a single 2.6 m estimate cannot
       carry both the room-scale occlusion and the contact line, and asking it
       to is what left every junction on this boat perfectly clean. */
    var STEP = [0.13, 0.13, 0.15, 0.17, 0.20, 0.24, 0.29, 0.35, 0.42, 0.50];
    var MAXT = 2.64, CAVT = 0.52, i, k;
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
      var nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (nl < 1e-6) { out[i] = 1; cav[i] = 1; continue; }
      nx /= nl; ny /= nl; nz /= nl;
      // orthonormal tangent frame around the normal (Duff et al., branchless)
      var sg = nz >= 0 ? 1 : -1, ta = -1 / (sg + nz), tb = nx * ny * ta;
      var tx = 1 + sg * nx * nx * ta, ty = sg * tb, tz = -sg * nx;
      var bx = tb, by = sg + ny * ny * ta, bz = -ny;
      // start clear of our own surface voxel (half a cell plus a margin)
      var sx = px + nx * 0.105, sy = py + ny * 0.105, sz = pz + nz * 0.105;
      var occ = 0, nearOcc = 0;
      for (k = 0; k < ND; k++) {
        var du = D[k * 3], dv = D[k * 3 + 1], dw = D[k * 3 + 2];
        var dx = tx * du + bx * dv + nx * dw;
        var dy = ty * du + by * dv + ny * dw;
        var dz = tz * du + bz * dv + nz * dw;
        var t = 0.06;
        for (var s = 0; s < STEP.length; s++) {
          t += STEP[s];
          if (aoSolid(sx + dx * t, sy + dy * t, sz + dz * t)) {
            occ += (1 - t / MAXT);
            if (t < CAVT) nearOcc += (1 - t / CAVT);
            break;
          }
        }
      }
      /* Floor at 0.13 rather than 0.055.  A closed-hemisphere estimate says a
         cockpit corner sees almost nothing, but the real one is open to a sea
         that is the brightest surface in the scene; taking the estimate
         literally is what turns every interior corner into a hole punched in
         the frame instead of a shaded surface you can still read. */
      out[i] = clamp(1 - (occ / ND) * 0.90, 0.13, 1);
      /* Contact term.  No floor and a hard gain: this one is ALLOWED to go to
         zero, because a real bedded joint is genuinely black at its root and
         the whole point of separating it from the broad estimate is that it
         can be driven hard without turning the cockpit into a cave. */
      cav[i] = clamp(1 - (nearOcc / ND) * 2.35, 0, 1);
    }
    try { aoRelax(geo, out, LOW() ? 2 : 3); } catch (e2) { }
    /* ONE relax pass on the contact term, never three: the whole value of it
       is that it stays tight against the geometry.  A single pass removes the
       Monte-Carlo speckle and welds the merge seams; more would smear the
       band out into exactly the airbrushed blob it replaces. */
    try { aoRelax(geo, cav, 1); } catch (e3) { }
    geo.setAttribute('aAO', new T.BufferAttribute(out, 1));
    geo.setAttribute('aCav', new T.BufferAttribute(cav, 1));
  }
  /* Every geometry we hand to a patched material must carry aAO even if the
     baker is skipped, so nothing can render at the GL default. */
  function aoFill(geo, v) {
    if (!geo || !geo.attributes || !geo.attributes.position) return;
    var n = geo.attributes.position.count, a;
    if (!geo.attributes.aAO) {
      a = new Float32Array(n); a.fill(v === undefined ? 1 : v);
      geo.setAttribute('aAO', new T.BufferAttribute(a, 1));
    }
    if (!geo.attributes.aCav) {
      a = new Float32Array(n); a.fill(1);
      geo.setAttribute('aCav', new T.BufferAttribute(a, 1));
    }
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
  /* Upholstery.  A cushion is not a box: the foam crowns in the middle of
     each panel, rolls over hard at the welted edge, and carries a shallow
     dish wherever somebody sits.  Rendered as a plain box it is the loudest
     piece of furniture-catalogue CG in the cockpit — perfectly flat, perfect
     right-angled corners, no compression anywhere.  Subdivided on a 0.20 m
     grid so the crown is smooth, then UV'd in metres so the panel pitch is
     0.45 m on a helm seat and on a 2.6 m sunbed alike. */
  function cush(w, h, d) {
    var nx = LOW() ? 3 : clamp(Math.round(w / 0.20), 3, 20);
    var nz = LOW() ? 3 : clamp(Math.round(d / 0.20), 3, 20);
    var g = new T.BoxGeometry(w, h, d, nx, Math.max(1, Math.round(h / 0.12)), nz);
    var p = g.attributes.position.array, n = g.attributes.position.count, i;
    var hw = w * 0.5, hd = d * 0.5, hh = h * 0.5;
    for (i = 0; i < n; i++) {
      var o = i * 3;
      var fx = p[o] / hw, fy = p[o + 1] / hh, fz = p[o + 2] / hd;
      // 1 mid-panel, 0 at the welt: the foam is unconstrained in the middle
      var roll = Math.min(1 - Math.pow(Math.abs(fx), 7), 1 - Math.pow(Math.abs(fz), 7));
      // seat compression: a broad dish across the middle of the span
      var dish = Math.exp(-Math.pow(fx * 1.9, 2)) * Math.exp(-Math.pow(fz * 1.5, 2));
      var lift = (0.20 * roll - 0.13 * dish) * h;
      if (fy > 0.5) p[o + 1] += lift;
      else if (fy < -0.5) p[o + 1] += lift * 0.18;      // the base follows a little
      // pinch the sides in toward the welt so the edge reads as rolled piping
      var pin = 1 - 0.085 * (1 - Math.abs(fy));
      p[o] *= pin; p[o + 2] *= pin;
    }
    g.computeVertexNormals();
    var a = g.attributes.uv.array, nr = g.attributes.normal.array;
    for (i = 0; i < n; i++) {
      var o2 = i * 3, ax = Math.abs(nr[o2]), ay = Math.abs(nr[o2 + 1]), az = Math.abs(nr[o2 + 2]);
      var u, v;
      if (ax >= ay && ax >= az) { u = p[o2 + 2]; v = p[o2 + 1]; }
      else if (ay >= az) { u = p[o2]; v = p[o2 + 2]; }
      else { u = p[o2]; v = p[o2 + 1]; }
      a[i * 2] = u / 0.90; a[i * 2 + 1] = v / 0.90;
    }
    g.attributes.uv.needsUpdate = true;
    /* THE WELT.  Piping is a cord sewn into the seam, and it is the one edge
       on a cushion that is genuinely round: it catches a continuous highlight
       all the way round the panel and it throws a hairline shadow onto the
       face below it.  Painted into the albedo — which is what the previous
       version did — it is a blurry smear with no thickness, and a magnified
       texel is exactly how a cushion ends up the least convincing object in a
       cockpit.  Ten millimetres of actual swept geometry costs a few hundred
       triangles and fixes it outright. */
    if (!LOW()) {
      var hwp = hw * 0.915, hdp = hd * 0.915;      // the pinched perimeter
      var cr = Math.min(hwp, hdp) * 0.28;          // corner radius of the seam
      var pts = [], seg = 5, kq, j2;
      function corner(cx2, cz2, a0) {
        for (j2 = 0; j2 <= seg; j2++) {
          var aa = a0 + (j2 / seg) * (PI / 2);
          pts.push([cx2 + Math.cos(aa) * cr, 0, cz2 + Math.sin(aa) * cr]);
        }
      }
      // four straights linked by four quarter-round corners
      corner(hwp - cr, hdp - cr, 0);
      pts.push([-(hwp - cr), 0, hdp]);
      corner(-(hwp - cr), hdp - cr, PI / 2);
      pts.push([-hwp, 0, -(hdp - cr)]);
      corner(-(hwp - cr), -(hdp - cr), PI);
      pts.push([hwp - cr, 0, -hdp]);
      corner(hwp - cr, -(hdp - cr), -PI / 2);
      pts.push([hwp, 0, hdp - cr]);
      var wl = [g];
      for (kq = 0; kq < pts.length; kq++) {
        var pA = pts[kq], pB = pts[(kq + 1) % pts.length];
        if (Math.abs(pA[0] - pB[0]) + Math.abs(pA[2] - pB[2]) < 1e-4) continue;
        var rg = rod(pA, pB, 0.0105, 7);
        /* Park the cord's UVs inside one quiet patch of the fabric tile: a
           10 mm tube whose u runs the full 0..1 would wrap an entire cushion
           panel — welt, stitch rows and all — round its own circumference. */
        var ru = rg.attributes.uv.array;
        for (j2 = 0; j2 < ru.length; j2++) ru[j2] = 0.22 + ru[j2] * 0.05;
        wl.push(rg);
      }
      return mergeAll(wl);
    }
    return g;
  }
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
    /* THE STAIRCASE, AND WHY MORE POLYGONS DO NOT FIX IT.
       ----------------------------------------------------------------------
       loftHullParts classifies each QUAD into antifoul / boot / band / gel by
       the mean height of its four corners, so the waterline and the boot top
       are quantised to whatever girth row happens to be nearest.  Solving
       y(s) = keel + (sheer - keel) * s^1.45 for y = 0.02 and y = 0.25 shows
       why raising NP alone cannot help: at midship those two land at
       s = 0.539 and 0.615, but at the stem — where keel has risen to -0.06
       and sheer to 2.36 — they land at s = 0.104 and 0.259.  The boot band
       SWEEPS ACROSS THE GIRTH PARAMETER from one end of the boat to the
       other, so no fixed sampling of s can hold it, and a uniform grid
       leaves a 15 m black-to-white boundary carried by one row of quads.
       That is the "polygon stair-stepping at the bows".

       Fix: make two of the girth rows BE the waterline and the boot top.
       Row index is canonical (row 8 is the waterline at every station, row
       11 the boot top), and each station solves for the s that puts that row
       at the right height, with the remaining rows distributed linearly in
       between.  The rows then trace the real contours, the classification
       tests an INTEGER row index instead of an interpolated height, and the
       boundary is exact everywhere.  Two further rows are pinned for the
       topside band so that stripe is exact too. */
    var NS = LOW() ? 26 : 44, NP = LOW() ? 12 : 26, st = [];
    var K = {
      iWL: Math.max(2, Math.round(NP * 0.31)),      // waterline row
      iBT: Math.max(3, Math.round(NP * 0.43)),      // boot-top row
      iB0: Math.round(NP * 0.77),                   // topside band, lower
      iB1: Math.round(NP * 0.925),                  // topside band, upper
      iG0: Math.round(NP * 0.805),                  // hull window, lower
      iG1: Math.round(NP * 0.895)                   // hull window, upper
    };
    if (K.iBT <= K.iWL) K.iBT = K.iWL + 1;
    if (K.iB1 <= K.iB0) K.iB1 = K.iB0 + 1;
    if (K.iG1 <= K.iG0) K.iG1 = K.iG0 + 1;
    /* Girth parameter of row j on a station with this keel and sheer, with
       rows iWL and iBT pinned to y = 0.02 and y = 0.25 exactly. */
    function sRow(j, keel, sheer) {
      var d = Math.max(sheer - keel, 0.05);
      var fw = clamp((0.02 - keel) / d, 0.010, 0.880);
      var fb = clamp((0.25 - keel) / d, fw + 0.020, 0.945);
      var sw = Math.pow(fw, 1 / 1.45), sb = Math.pow(fb, 1 / 1.45);
      if (j <= K.iWL) return sw * (j / K.iWL);
      if (j <= K.iBT) return sw + (sb - sw) * (j - K.iWL) / (K.iBT - K.iWL);
      return sb + (1 - sb) * (j - K.iBT) / (NP - K.iBT);
    }
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
        var s = sRow(j, keel, sheer);
        // a soft chine near s = 0.62 keeps the topsides slab-sided like the real hull
        var kn = 1 + 0.10 * Math.exp(-Math.pow((s - 0.62) / 0.13, 2));
        pts.push([halfB * Math.pow(Math.sin(s * PI / 2), 0.62) * kn,
                  keel + (sheer - keel) * Math.pow(s, 1.45)]);
      }
      st.push({ fore: fore, pts: pts, keel: keel, sheer: sheer, halfB: halfB });
    }
    var H = { st: st, NS: NS, NP: NP, knots: K };
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
    var K = H.knots || { iWL: Math.round(NP * 0.31), iBT: Math.round(NP * 0.43),
                         iB0: Math.round(NP * 0.77), iB1: Math.round(NP * 0.925),
                         iG0: Math.round(NP * 0.805), iG1: Math.round(NP * 0.895) };
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
        // integer row band, not an interpolated height: rows iWL and iBT ARE
        // the waterline and the boot top, so the boundary cannot stair-step
        var jm = j + 0.5, jd = Math.abs(jm - NP);
        var outb = ((jm < NP) ? 1 : -1) === outSign;
        var key;
        if (jd < K.iWL) key = 'anti';
        else if (jd < K.iBT) key = 'boot';
        else if (outb && jd > K.iB0 && jd < K.iB1 && fm > -5.6 && fm < 5.4) {
          key = 'band';
          for (var w = 0; w < WIN.length; w++) {
            if (jd > K.iG0 && jd < K.iG1 && fm > WIN[w][0] && fm < WIN[w][1]) key = 'glass';
          }
        } else key = 'gel';
        B[key].push(a, b, c, a, c, d);
      }
    }
    var tr = st[0], cc = push(tr.fore, 0, (tr.keel + tr.sheer) / 2, 0.5, 0);
    for (j = 0; j < M2 - 1; j++) {
      var jt = Math.abs(j + 0.5 - NP);
      B[jt < K.iWL ? 'anti' : jt < K.iBT ? 'boot' : 'gel'].push(ring[0][j + 1], ring[0][j], cc);
    }
    var bw = st[NS], c2 = push(bw.fore + 0.06, 0, (bw.keel + bw.sheer) / 2, 0.5, 4);
    for (j = 0; j < M2 - 1; j++) B.gel.push(ring[NS][j], ring[NS][j + 1], c2);

    /* NORMALS ARE COMPUTED ONCE, ON THE WHOLE SHELL.
       Each region used to run its own computeVertexNormals(), which averages
       only the triangles that region happens to own — so every vertex on the
       boot-top line, the topside band and the window surrounds got a normal
       built from HALF its true neighbourhood.  That is a shading crease down
       four continuous seams of a continuous surface, and at the bows, where
       the seams cross the hardest curvature, it reads as faceting on the
       chine.  One pass over the union of every region's triangles gives every
       vertex its real normal, and the regions then just borrow it. */
    var allIdx = [], key2;
    for (key2 in B) if (B[key2].length) allIdx = allIdx.concat(B[key2]);
    var whole = new T.BufferGeometry();
    whole.setAttribute('position', new T.Float32BufferAttribute(pos.slice(0), 3));
    whole.setIndex(allIdx);
    whole.computeVertexNormals();
    var NRM = whole.attributes.normal.array;
    whole.dispose();

    /* Emit only the vertices each region actually references.  The shared
       pool is ~2400 vertices; the boot top touches maybe 250 of them, and
       copying all 2400 into all five regions is what made the denser
       stations expensive — both in buffer size and, far more, in AO bake
       time, which is per-vertex whether the vertex is drawn or not. */
    var out = {}, nv = pos.length / 3;
    var remap = new Int32Array(nv), stamp = new Int32Array(nv), tag = 0;
    for (key2 in B) {
      var src = B[key2];
      if (!src.length) continue;
      tag++;
      var P2 = [], U2 = [], N2 = [], I2 = [];
      for (var q2 = 0; q2 < src.length; q2++) {
        var vi = src[q2];
        if (stamp[vi] !== tag) {
          stamp[vi] = tag; remap[vi] = P2.length / 3;
          P2.push(pos[vi * 3], pos[vi * 3 + 1], pos[vi * 3 + 2]);
          U2.push(uv[vi * 2], uv[vi * 2 + 1]);
          N2.push(NRM[vi * 3], NRM[vi * 3 + 1], NRM[vi * 3 + 2]);
        }
        I2.push(remap[vi]);
      }
      var g = new T.BufferGeometry();
      g.setAttribute('position', new T.Float32BufferAttribute(P2, 3));
      g.setAttribute('uv', new T.Float32BufferAttribute(U2, 2));
      g.setAttribute('normal', new T.Float32BufferAttribute(N2, 3));
      g.setIndex(I2);
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
  function hardtopUnder(A, x, y, z, w, d, tubeX, nBat, matV) {
    var i, s;
    matV = matV || M.gelGrey;
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
      /* CATENARY SAG.  Fabric stretched between battens is not a plane — it
         hangs.  Twelve millimetres over a 2.5 m bay is barely a measurement,
         but it is the difference between a surface whose shading gradient
         turns continuously across the panel and a flat quad that returns one
         value across the whole top third of the frame.  It also gives the
         batten lines something to pinch against, which is what makes them
         read as pockets rather than as painted stripes. */
      var pp = pg.attributes.position.array;
      for (i = 0; i < pp.length; i += 3) {
        var fu = pp[i] / (bw * 0.5), fv = pp[i + 2] / (bd * 0.5);
        var sagU = 1 - fu * fu, sagV = 1 - fv * fv;
        // the battens run athwartships, so the sag is deeper along z.  The
        // plate is flipped through PI about X when it is placed, so LOCAL +y
        // is model -y: the fabric hangs by ADDING here.
        pp[i + 1] += 0.0135 * sagU * sagU * sagV + 0.008 * sagV * sagV;
      }
      pg.computeVertexNormals();
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
    A.add(at(cyl(0.055, 0.055, w, LOW() ? 6 : 14), x, y + 0.012, z - d / 2 + 0.045, 0, 0, PI / 2), matV);
    A.add(at(cyl(0.055, 0.055, w, LOW() ? 6 : 14), x, y + 0.012, z + d / 2 - 0.045, 0, 0, PI / 2), matV);
    A.add(at(cyl(0.050, 0.050, d, LOW() ? 6 : 14), x - w / 2 + 0.045, y + 0.012, z, PI / 2, 0, 0), matV);
    A.add(at(cyl(0.050, 0.050, d, LOW() ? 6 : 14), x + w / 2 - 0.045, y + 0.012, z, PI / 2, 0, 0), matV);
    /* Carry tubes and battens are POWDER-COATED aluminium, not stainless.
       Every tube on a production cat sharing one polished-chrome material is
       half of why the structure reads as a CAD assembly: the coated members
       are semi-matte and slightly warm, and that contrast against the
       stainless grab rail 200 mm away is what gives the underside of a
       hardtop its material hierarchy. */
    for (s = -1; s <= 1; s += 2) {
      A.add(at(cyl(0.042, 0.042, d - 0.14, LOW() ? 6 : 10), x + s * tubeX, y - 0.052, z, PI / 2, 0, 0), M.powder);
    }
    /* Batten pockets behind the panel: the dark bands that give it depth, and
       the DOUBLE ROW OF STITCHING that closes each pocket.  A sewn pocket is
       two 3 mm seams 40 mm apart running the full width, and they are the only
       high-frequency line work anywhere on two square metres of canvas — the
       thing that stops the whole top third of the noon frame reading as one
       untextured grey slab.  Sewn in the fabric colour, not black: a contrast
       stitch here would read as a decal. */
    for (i = 0; i < nBat; i++) {
      var bz = z - d / 2 + (d / nBat) * (i + 0.5);
      A.add(at(cyl(0.028, 0.028, w - 0.20, LOW() ? 5 : 10), x, y - 0.048, bz, 0, 0, PI / 2), M.powder);
      if (!LOW()) for (s = -1; s <= 1; s += 2) {
        A.add(at(box(w - 0.30, 0.004, 0.0055), x, y - 0.0335, bz + s * 0.042), M.canvasCream);
        A.add(at(box(w - 0.30, 0.003, 0.0030), x, y - 0.0315, bz + s * 0.042), M.gasket);
      }
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
    hardtopUnder(A, 0, S.yBimini + 0.02, 0.60, 6.20, 5.20, 2.62, LOW() ? 4 : 7, M.gelIn);
    /* HARDTOP POSTS.  These are the only piece of the yacht that the noon
       preset shows in full length, and they were failing at both ends: 10
       radial segments cannot carry a smooth specular gradient across a 90 mm
       tube at two metres, and the tube simply stopped at the sole with a
       bedding washer, so the highlight ran out into a black stub instead of
       terminating on a real fitting.  A production cat lands each post on a
       machined base flange, through a sealant bead, with four countersunk
       bolts, and there is a swaged collar where the tube enters the flange.
       That is four turned parts and it is what makes the bottom of the post
       read as bolted through a deck rather than as a pipe pushed into it. */
    for (s = -1; s <= 1; s += 2) for (i = 0; i < 2; i++) {
      var pz2 = i ? 2.90 : -1.70, px2 = s * 2.72;
      A.add(at(cyl(0.045, 0.052, S.yBimini - S.yFly, LOW() ? 12 : 26),
               px2, (S.yBimini + S.yFly) / 2, pz2), M.steel);
      // swaged collar, base flange, sealant bead, bolt heads
      A.add(at(cyl(0.058, 0.072, 0.075, LOW() ? 12 : 26), px2, S.yFly + 0.098, pz2), M.steel);
      A.add(at(cyl(0.088, 0.094, 0.028, LOW() ? 12 : 26), px2, S.yFly + 0.046, pz2), M.steelSat);
      A.add(at(cyl(0.098, 0.104, 0.014, LOW() ? 12 : 26), px2, S.yFly + 0.024, pz2), M.steel);
      A.add(at(tor(0.101, 0.007, LOW() ? 5 : 8, LOW() ? 12 : 26),
               px2, S.yFly + 0.014, pz2, PI / 2), M.gasket);
      for (var kb = 0; kb < 4; kb++) {
        var ab = kb * PI / 2 + PI / 4;
        A.add(at(cyl(0.010, 0.010, 0.008, LOW() ? 6 : 12),
                 px2 + Math.cos(ab) * 0.076, S.yFly + 0.064, pz2 + Math.sin(ab) * 0.076), M.steelSat);
      }
      gasket(A, px2, S.yFly + 0.008, pz2, 0.108, 0.016);
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
    /* KNURL.  A Lewmar rib is MACHINED, not extruded: the flanks are radial
       and the top is a flat land about 2 mm wide with a chamfer either side,
       so the sun draws a fine broken line of hard highlights round the drum
       rather than clipping a solid white band across every rib top.  A square
       box section has neither, which is exactly why the drum was reading as a
       ribbed bin.  Two stacked boxes approximate the land-and-chamfer
       section for the cost of one extra quad per rib. */
    var NK = LOW() ? 0 : 22;
    for (i = 0; i < NK; i++) {
      var a = i / NK * TAU;
      var cx = Math.cos(a), cz = Math.sin(a);
      wa.push(at(box(0.0082, 0.155, 0.0060),
                 cx * r * 0.914, 0.108, cz * r * 0.914, 0, -a, 0));
      wa.push(at(box(0.0044, 0.150, 0.0038),
                 cx * r * 0.922, 0.108, cz * r * 0.922, 0, -a, 0));
    }
    // self-tailing jaws: two sprung rings with a rope-sized gap between them
    wa.push(at(tor(r * 1.02, 0.018, LOW() ? 6 : 12, NS), 0, 0.243, 0, PI / 2));
    wa.push(at(tor(r * 0.80, 0.016, LOW() ? 6 : 12, NS), 0, 0.265, 0, PI / 2));
    wa.push(at(cyl(r * 0.90, r * 0.90, 0.008, NS), 0, 0.254, 0));
    // handle socket, square drive, sunk into the crown
    wa.push(at(cyl(r * 0.56, r * 0.58, 0.030, LOW() ? 10 : 24), 0, 0.283, 0));
    wa.push(at(box(0.030, 0.014, 0.030), 0, 0.292, 0));
    return mergeAll(wa);
  }
  /* The parts of the winch that are ANODISED BLACK on the real thing: the
     stripper arm and its boss, the gear-case parting line round the base of
     the drum, and the pawl-inspection slot.  Splitting them out of the
     stainless is most of what turns "a small metal bin with a blue gasket"
     into a recognisable self-tailing winch — a Lewmar is two materials, and
     the dark ring under the bright drum is the read. */
  function winchDark(r) {
    var wa = [], NS = LOW() ? 16 : 32;
    // stripper arm: the hook that peels the tail out of the jaws
    wa.push(at(box(0.030, 0.040, r * 0.95), r * 0.72, 0.250, 0));
    wa.push(at(box(0.030, 0.055, 0.035), r * 0.72, 0.235, -r * 0.46));
    wa.push(at(cyl(0.020, 0.024, 0.030, LOW() ? 8 : 16), r * 0.72, 0.232, 0));
    // gear-case parting line: a 3 mm proud collar right at the drum foot
    wa.push(at(cyl(r * 1.045, r * 1.045, 0.010, NS), 0, 0.004, 0));
    wa.push(at(cyl(r * 1.015, r * 1.030, 0.014, NS), 0, 0.016, 0));
    // pawl slot, and the two case screws either side of it
    wa.push(at(box(0.007, 0.020, r * 0.7), -r * 0.75, 0.012, 0, 0, 0.5, 0));
    return mergeAll(wa);
  }
  /* Three turns of sheet on a drum are not three smooth tori.  A working wrap
     climbs the throat, changes radius as it rides up the taper, and the braid
     itself is a helix — so each turn is swept as its own tube with a per-turn
     radius and a slight pitch, and the rope material's own braid normal then
     lands on a surface whose tangent actually follows the lay. */
  function ropeWrap(r) {
    var list = [], NSEG = LOW() ? 14 : 34, k, i;
    var turns = [
      { y: 0.049, rad: r * 1.055, tr: 0.0122 },
      { y: 0.076, rad: r * 1.020, tr: 0.0120 },
      { y: 0.103, rad: r * 1.030, tr: 0.0118 }
    ];
    for (k = 0; k < turns.length; k++) {
      var t = turns[k], pts = [];
      for (i = 0; i <= NSEG; i++) {
        var a = i / NSEG * TAU;
        // the turn is not a perfect circle: it is pulled toward the lead
        var rr = t.rad * (1 + 0.014 * Math.cos(a * 1.0 + k * 1.7));
        pts.push([Math.cos(a) * rr, t.y + 0.0075 * (i / NSEG), Math.sin(a) * rr]);
      }
      for (i = 0; i < NSEG; i++) list.push(at(rod(pts[i], pts[i + 1], t.tr, LOW() ? 4 : 6), 0, 0, 0));
    }
    return mergeAll(list);
  }

  /* ------------------------------------------------------------------------
     CLUTTER.  A boat that is being sailed is not a showroom: there are rope
     tails flaked on the coaming, a winch handle in its holster, a towel over
     the rail, a soft bag wedged under the table.  None of it is expensive —
     everything below merges into the existing accumulators, so it costs
     triangles and no draw calls — but it is what puts a crew on board.
     ---------------------------------------------------------------------- */
  function ropeCoil(A, x, y, z, r0, turns, mat, tilt) {
    var segs = LOW() ? 12 : 24, list = [], k;
    for (k = 0; k < turns; k++) {
      // radius falls and the coil stacks as the tail runs out
      list.push(at(tor(r0 * (1 - 0.115 * k), 0.0118, LOW() ? 5 : 7, segs),
                   0.006 * k, 0.0135 * k, -0.004 * k, PI / 2, 0, 0.55 * k));
    }
    A.add(at(mergeAll(list), x, y, z, tilt || 0, 0, 0), mat);
  }
  /* A winch handle: square drive, forged arm, floating grip.  Left in its
     holster because that is where it lives between tacks. */
  function winchHandle(A, x, y, z, ry, tilt) {
    var g = [
      at(box(0.040, 0.040, 0.056), 0, 0, 0),                     // drive head
      at(box(0.026, 0.030, 0.215), 0, 0.008, 0.140)              // forged arm
    ];
    var grip = at(cyl(0.020, 0.020, 0.115, LOW() ? 6 : 12), 0, 0.070, 0.243);
    A.add(at(mergeAll(g), x, y, z, tilt || 0, ry || 0, 0), M.steelSat);
    A.add(at(grip, x, y, z, tilt || 0, ry || 0, 0), M.rubber);
  }
  /* A folded towel over a coaming: three tapering slabs with a soft break at
     the fold, so it drapes instead of reading as a plastic card. */
  function towel(A, x, y, z, w, drop, mat) {
    var g = [];
    g.push(at(box(w, 0.022, 0.30), 0, 0, 0));                        // over the top
    g.push(at(box(w * 0.98, drop, 0.020), 0, -drop / 2, -0.148, 0.10));
    g.push(at(box(w * 0.94, drop * 0.72, 0.020), 0, -drop * 0.36, 0.150, -0.13));
    A.add(at(mergeAll(g), x, y, z), mat);
  }
  function softBag(A, x, y, z, w, h, d, mat) {
    var g = [];
    g.push(at(sph(0.5, LOW() ? 8 : 14, LOW() ? 6 : 10), 0, 0, 0, 0, 0, 0, w, h, d));
    g.push(at(cyl(0.012, 0.012, w * 0.62, LOW() ? 5 : 8), 0, h * 0.52, 0, 0, 0, PI / 2));
    A.add(at(mergeAll(g), x, y, z), mat);
  }

  function buildClutter(A, root, P) {
    var yC = S.yCock, cT = yC + S.coam, s;
    // winch handle in its holster, port coaming, drive end down
    winchHandle(A, -2.92, cT - 0.10, 4.32, 0.22, -0.34);
    // a second handle stowed flat in the flybridge pocket
    winchHandle(A, 1.92, S.yFly + 0.10, -1.05, PI * 0.5, 0.0);
    // dock lines flaked down in the aft corners of the cockpit sole
    ropeCoil(A, 2.34, yC + 0.035, 6.05, 0.215, LOW() ? 3 : 6, M.rope, 0.05);
    ropeCoil(A, -2.34, yC + 0.035, 6.05, 0.205, LOW() ? 3 : 6, M.rope, -0.04);
    // spare sheet coiled at the mast base on the coachroof
    ropeCoil(A, 0.62, S.mastBase + 0.05, S.mastZ + 0.55, 0.185, LOW() ? 3 : 5, M.sheet, 0.0);
    // towel over the port coaming, and one over the transom rail
    towel(A, -3.03, cT + 0.075, 5.55, 0.44, 0.30, M.canvasCream);
    towel(A, 1.42, cT + 0.075, 7.05, 0.38, 0.26, M.canvasNavy);
    // soft bag wedged under the cockpit table, and a cooler on the sole
    softBag(A, 0.72, yC + 0.19, 5.98, 0.46, 0.34, 0.32, M.canvasNavy);
    A.add(at(box(0.46, 0.34, 0.32), -1.30, yC + 0.17, 6.05, 0, 0.22, 0), M.plastic);
    A.add(at(box(0.48, 0.035, 0.34), -1.30, yC + 0.352, 6.05, 0, 0.22, 0), M.gelGrey);
    // throw cushions tossed on the aft bench, at angles nobody arranged
    A.add(at(cush(0.42, 0.11, 0.40), -1.95, yC + 0.60, 6.62, 0.06, 0.34, 0.03), M.cushion);
    A.add(at(cush(0.40, 0.10, 0.38), -1.55, yC + 0.60, 6.55, -0.04, -0.22, 0.05), M.cushion);
    A.add(at(cush(0.44, 0.11, 0.40), 1.70, yC + 0.60, 6.60, 0.03, -0.41, -0.04), M.cushion);
    // boathook clipped along the coachroof side, in two nylon clips
    for (s = -1; s <= 1; s += 2) {
      if (s < 0) continue;
      A.add(at(cyl(0.017, 0.019, 2.30, LOW() ? 6 : 10), s * 2.66, S.yRoof + 0.115, -1.05, PI / 2), M.powder);
      A.add(at(cyl(0.016, 0.016, 0.14, LOW() ? 6 : 10), s * 2.66, S.yRoof + 0.115, -2.26, PI / 2), M.steelSat);
      A.add(at(tor(0.048, 0.013, 6, LOW() ? 8 : 14), s * 2.66, S.yRoof + 0.155, -2.34, 0, 0, PI / 2), M.steelSat);
      A.add(at(box(0.05, 0.055, 0.05), s * 2.66, S.yRoof + 0.075, -0.20), M.plastic);
      A.add(at(box(0.05, 0.055, 0.05), s * 2.66, S.yRoof + 0.075, -1.90), M.plastic);
    }
    // a bucket upturned by the transom step, and a deck brush beside it
    A.add(at(cyl(0.135, 0.108, 0.28, LOW() ? 8 : 16), 2.62, yC + 0.14, 7.35), M.plastic);
    A.add(at(tor(0.136, 0.008, 5, LOW() ? 8 : 16), 2.62, yC + 0.275, 7.35, PI / 2), M.plastic);
    A.add(at(cyl(0.015, 0.015, 0.95, LOW() ? 5 : 8), 2.92, yC + 0.50, 6.95, 0.30, 0, 0.08), M.powder);
    A.add(at(box(0.08, 0.045, 0.22), 2.79, yC + 0.075, 7.10), M.plastic);
    A.add(at(box(0.075, 0.045, 0.20), 2.79, yC + 0.038, 7.10), M.rubber);
    // sunglasses and a mug on the cockpit table, because somebody sat here
    A.add(at(cyl(0.038, 0.034, 0.095, LOW() ? 8 : 14), -0.42, yC + 0.665, 5.16), M.gelGrey);
    A.add(at(tor(0.030, 0.007, 5, LOW() ? 6 : 12), -0.35, yC + 0.660, 5.16, 0, 0, PI / 2), M.gelGrey);
    A.add(at(box(0.135, 0.012, 0.045), 0.36, yC + 0.618, 5.44, 0, 0.5, 0), M.plastic);
    A.add(at(box(0.048, 0.010, 0.115), 0.30, yC + 0.618, 5.51, 0, 0.5, 0.2), M.plastic);
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
    // sheet and halyard tails, properly flaked down on the coaming
    for (s = -1; s <= 1; s += 2) {
      ropeCoil(A, s * 2.72, cT + 0.035, 4.55, 0.165, LOW() ? 3 : 5, M.sheet, 0.16 * s);
      ropeCoil(A, s * 2.66, cT + 0.035, 6.05, 0.140, LOW() ? 3 : 4, M.rope, -0.11 * s);
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
      /* The base pad is ANODISED BLACK, not satin stainless.  A bright drum
         standing on a bright pad on a bright deck is one continuous value and
         reads as a single turned lump; the dark casting is what separates the
         moving part from the boat. */
      A.add(at(cyl(sp[3] * 1.32, sp[3] * 1.42, 0.055, LOW() ? 12 : 26),
               sp[0], sp[1] + 0.038, sp[2]), M.anod);
      var wg = new T.Group();
      wg.position.set(sp[0], sp[1] + 0.063, sp[2]);
      var wm = new T.Mesh(winchGeom(sp[3]), M.winch);
      wm.castShadow = true; wm.receiveShadow = true;
      wg.add(wm);
      var wd = new T.Mesh(winchDark(sp[3]), M.anod);
      wd.castShadow = true; wd.receiveShadow = true;
      wg.add(wd);
      // three swept turns of sheet, climbing the throat
      var rw = new T.Mesh(ropeWrap(sp[3]), M.sheet);
      rw.castShadow = true; rw.receiveShadow = true;
      wg.add(rw);
      root.add(wg);
      P.winches.push(wg);
      if (i < 2) {
        A.add(at(box(0.035, 0.035, 0.26), sp[0] + (sp[0] > 0 ? 0.26 : -0.26), sp[1] + 0.06, sp[2] + 0.22), M.plastic);
        A.add(at(cyl(0.022, 0.022, 0.10, 8), sp[0] + (sp[0] > 0 ? 0.26 : -0.26), sp[1] + 0.06, sp[2] + 0.36, PI / 2), M.rubber);
      }
      /* THE TAIL.  A self-tailing winch with nothing in its jaws is a chrome
         ornament: the rope leaving the crown, sagging across the coaming and
         landing in its own flaked coil is what identifies the object as a
         winch at a glance, and it is the only part of it with fibre in it. */
      var sgn = sp[0] > 0 ? 1 : -1;
      var jy = sp[1] + 0.063 + 0.262, jr = sp[3] * 0.92;
      var tz = (i < 2) ? 4.55 : sp[2] + 0.62;
      var ty = (i < 2) ? cT + 0.075 : sp[1] + 0.055;
      var tx = (i < 2) ? sgn * 2.72 : sp[0] + sgn * 0.16;
      var NTail = LOW() ? 4 : 8, kq;
      for (kq = 0; kq < NTail; kq++) {
        var u0 = kq / NTail, u1 = (kq + 1) / NTail;
        var pA = [lerp(sp[0] + sgn * jr, tx, u0), lerp(jy, ty, u0) - 0.11 * Math.sin(u0 * PI),
                  lerp(sp[2] + jr * 0.35, tz, u0)];
        var pB = [lerp(sp[0] + sgn * jr, tx, u1), lerp(jy, ty, u1) - 0.11 * Math.sin(u1 * PI),
                  lerp(sp[2] + jr * 0.35, tz, u1)];
        A.add(at(rod(pA, pB, 0.0115, LOW() ? 4 : 7), 0, 0, 0), M.sheet);
      }
    }
  }

  function buildFlybridge(A, root, P) {
    var s, i;
    /* Everything from here to the end of the console is on M.gelIn — the same
       gelcoat, bound to the box-projected cockpit probe.  These are the
       surfaces the eye spends the whole shot on and the only ones close enough
       to the probe for parallax to matter. */
    teakDeck(A, 6.00, 4.80, 0, S.yFly, 0.55, 0.06);
    A.add(at(box(6.20, 0.16, 5.00), 0, S.yFly - 0.13, 0.55), M.gelIn);
    for (s = -1; s <= 1; s += 2) {
      A.add(at(box(0.14, 0.76, 5.00), s * 3.03, S.yFly + 0.38, 0.55), M.gelIn);
      teakCap(A, 0.24, 5.00, s * 3.03, S.yFly + 0.80, 0.55, 0.06, M.gelIn);
    }
    A.add(at(box(6.20, 0.76, 0.14), 0, S.yFly + 0.38, 3.05), M.gelIn);
    /* The inboard face of each coaming is 5 m of blank moulding that fills a
       third of the helm frame.  A real one carries a run of locker lids with
       6 mm parting lines, flush pulls, and a moulded reveal at half height —
       details that are worth more than any amount of shader work because
       they give the eye a rhythm to read the surface by. */
    /* CONTACT FILLETS.  A moulded coaming does not meet the sole at a knife
       edge — there is a 12 mm cove of laminate and a bead of sealant in it,
       and that dark line is the cheapest possible statement that the two
       surfaces are one moulding rather than two boxes pushed together.  The
       winch bases already had this and were the best-looking detail on the
       boat; the coaming-to-sole join, which is four metres long and runs
       straight through the middle of the helm frame, had nothing. */
    for (s = -1; s <= 1; s += 2) {
      A.add(at(cyl(0.016, 0.016, 4.94, LOW() ? 4 : 8),
               s * 2.955, S.yFly + 0.013, 0.55, PI / 2), M.gasket);
      A.add(at(cyl(0.026, 0.026, 4.94, LOW() ? 4 : 8),
               s * 2.984, S.yFly + 0.030, 0.55, PI / 2), M.gelIn);
    }
    A.add(at(cyl(0.016, 0.016, 5.90, LOW() ? 4 : 8),
             0, S.yFly + 0.013, 2.965, 0, 0, PI / 2), M.gasket);
    for (s = -1; s <= 1; s += 2) {
      A.add(at(box(0.012, 0.030, 4.60), s * 2.945, S.yFly + 0.30, 0.55), M.gasket);
      for (i = 0; i < 4; i++) {
        var lz = -1.40 + i * 1.15;
        A.add(at(box(0.026, 0.44, 1.02), s * 2.945, S.yFly + 0.54, lz), M.gelIn);
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
    A.add(at(box(6.00, 0.62, 0.10), 0, S.yFly + 0.30, -1.96, -0.16), M.gelIn);
    // sunbed / L-settee to port
    A.add(at(box(2.60, 0.44, 1.80), -1.55, S.yFly + 0.22, 1.90), M.gelIn);
    A.add(at(cush(2.50, 0.14, 1.72), -1.55, S.yFly + 0.51, 1.90), M.cushion);
    A.add(at(cush(2.50, 0.42, 0.14), -1.55, S.yFly + 0.70, 2.80), M.cushion);
    // helm seat to starboard
    A.add(at(box(1.30, 0.42, 0.58), 1.90, S.yFly + 0.21, -0.10), M.gelIn);
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
    A.add(at(box(1.70, 0.40, 0.52), hx, hy + 0.545, hz - 0.44), M.gelIn);    // locker face
    for (i = 0; i < 2; i++) {                                   // locker lid parting lines
      A.add(at(box(0.008, 0.36, 0.53), hx - 0.28 + i * 0.56, hy + 0.545, hz - 0.44), M.gasket);
    }
    for (i = 0; i < 3; i++) {                                   // flush ring pulls
      A.add(at(cyl(0.026, 0.026, 0.010, LOW() ? 10 : 24),
               hx - 0.56 + i * 0.56, hy + 0.545, hz - 0.185, PI / 2), M.steelSat);
    }
    A.add(at(box(1.76, 0.055, 0.56), hx, hy + 0.772, hz - 0.44), M.gelIn);   // capping
    /* Radiused edges.  A moulded gelcoat box has a 20 mm corner radius on
       every arris, and that radius is what carries the long blown specular
       line that tells you the surface is glossy.  Square-cut boxes cannot
       produce it at any roughness, which is why an untreated console reads
       as flat card no matter how good the material is. */
    var NE = LOW() ? 6 : 14;
    for (i = -1; i <= 1; i += 2) {                       // vertical corners
      for (s = -1; s <= 1; s += 2) {
        A.add(at(cyl(0.020, 0.020, 0.70, NE), hx + i * 0.85, hy + 0.545, hz - 0.44 + s * 0.26), M.gelIn);
      }
    }
    A.add(at(cyl(0.022, 0.022, 1.70, NE), hx, hy + 0.772, hz - 0.72, 0, 0, PI / 2), M.gelIn);
    A.add(at(cyl(0.022, 0.022, 1.70, NE), hx, hy + 0.772, hz - 0.16, 0, 0, PI / 2), M.gelIn);
    A.add(at(rod([hx - 0.74, hy + 0.83, hz - 0.185], [hx + 0.74, hy + 0.83, hz - 0.185],
                 0.014, LOW() ? 6 : 12), 0, 0, 0), M.steel);                 // fiddle rail
    for (i = 0; i < 2; i++) {
      A.add(at(cyl(0.012, 0.016, 0.052, LOW() ? 6 : 12),
               hx - 0.60 + i * 1.20, hy + 0.805, hz - 0.185), M.steel);
    }
    // dark low-glare dash field, set into a white surround
    A.add(at(box(1.76, 0.05, 0.50), hx, dcy - 0.008, dcz, DT), M.gelIn);
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
    var wa = [], la = [], ka = [];
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
      var ca = Math.cos(a), sa2 = Math.sin(a);
      wa.push(at(cyl(0.011, 0.016, R - 0.050, LOW() ? 8 : 16),
                 ca * (R - 0.02) / 2, sa2 * (R - 0.02) / 2, 0,
                 0, 0, a - PI / 2));
      /* JUNCTION.  The spoke used to disappear into the rim with nothing
         marking where one part ends and the other begins, which is exactly
         what makes an assembly read as a single moulding.  A real destroyer
         wheel carries a machined ferrule swaged over the spoke end and a
         clamp band round the rim at each root, and the leather wrap is cut
         and finished against that band.  Two turned parts, and the whole
         wheel starts reading as fabricated rather than extruded. */
      wa.push(at(cyl(0.0205, 0.0165, 0.055, LOW() ? 8 : 20),
                 ca * (R - 0.062), sa2 * (R - 0.062), 0, 0, 0, a - PI / 2));
      /* Both junction parts are turned rings, and both are placed with a
         cylinder rather than a torus: a cylinder's axis is +Y, so a single
         rz rotation aims it, which is the same convention the spokes use and
         cannot be got wrong.  The ferrule is coaxial with the SPOKE; the
         clamp band encircles the rim tube, which runs tangentially, so its
         axis is one quarter turn on from the spoke. */
      wa.push(at(cyl(0.0225, 0.0225, 0.012, LOW() ? 8 : 20),
                 ca * (R - 0.040), sa2 * (R - 0.040), 0, 0, 0, a - PI / 2));
      /* Clamp band over the wrap.  Only 1.8 mm proud and 30 mm wide: the band
         is viewed almost along its own axis from the helm, so anything that
         stands further out shows its flat end cap and reads as a grey plate
         pasted on the rim rather than as a collar round it. */
      wa.push(at(cyl(0.0298, 0.0298, 0.030, LOW() ? 8 : 22),
                 ca * R, sa2 * R, 0, 0, 0, a));
      /* The knob is a POLISHED TURNED BALL, so it goes on the mapless chrome
         material, not on the drawn-tube stainless: a streak map wrapped round
         a sphere is what produced the mottled lava-marble the review picked
         out as the single most conspicuously wrong material in the frame. */
      ka.push(at(sph(0.028, LOW() ? 12 : 32, LOW() ? 10 : 24),
                 ca * (R - 0.02), sa2 * (R - 0.02), 0.030));
      // the knob is spigoted into the rim, not floating against it
      ka.push(at(cyl(0.013, 0.017, 0.020, LOW() ? 8 : 16),
                 ca * (R - 0.02), sa2 * (R - 0.02), 0.012, PI / 2));
    }
    /* King-spoke marker: how you read the helm angle at a glance.  It was a
       raw 50 x 90 x 50 box standing proud of the rim at top dead centre — a
       flat grey slab sitting directly behind the nearest knob in the golden
       frame, and the most debug-primitive-looking object left on the wheel.
       A real one is a turned collar clamped round the rim with a short raised
       finger on it, which is both correct and reads as a machined part from
       any angle instead of only from dead ahead. */
    wa.push(at(cyl(0.0345, 0.0345, 0.052, LOW() ? 8 : 24), 0, R, 0, 0, 0, PI / 2));
    wa.push(at(cyl(0.0392, 0.0392, 0.010, LOW() ? 8 : 24), 0, R, 0, 0, 0, PI / 2));
    wa.push(at(cyl(0.0075, 0.0090, 0.030, LOW() ? 6 : 14), 0, R + 0.040, 0));
    wa.push(at(sph(0.0105, LOW() ? 8 : 16, LOW() ? 6 : 12), 0, R + 0.055, 0));
    var wm1 = new T.Mesh(mergeAll(wa), M.steel);
    var wm2 = new T.Mesh(mergeAll(la), M.leather);
    var wm3 = new T.Mesh(mergeAll(ka), M.chrome);
    wm1.castShadow = wm2.castShadow = wm3.castShadow = true;
    wm1.receiveShadow = wm2.receiveShadow = wm3.receiveShadow = true;
    wheel.add(wm1); wheel.add(wm2); wheel.add(wm3);
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
    /* Raised ~45% together with the lateral term below.  An INTERIOR cube
       probe is a one-bounce estimate of a space whose walls are lit mostly by
       each other, so it systematically loses energy — the probe sees a dark
       cockpit, the cockpit therefore receives less indirect, and the next
       probe is darker still.  Measured on the first build with the new probes
       the shaded flybridge fell to RGB 36/25/21 with 38% of its pixels
       crushed.  The analytic bounce is the term that has to break that loop,
       because unlike the probe it is computed from the sky and sun energies
       directly and cannot feed back. */
    var u = skyE * 0.72 + sunE * up * 0.086 + hE * 0.125;
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
    /* Raised ~35%.  Measured on the shipped build the shadowed cockpit around
       the pedestal averaged RGB 37/28/24 with 6.6% of its pixels at near-black
       and no detail in them.  An open cockpit at golden hour is filled by a
       whole sky dome plus a fully lit orange sea; clipping it to zero is a
       bounce-light failure, and it destroyed the geometry read across the
       lower third of the frame. */
    var side = hE * 0.225 + (sunE * up * 0.150 + skyE * 0.58) * 0.5;
    UNI.uBounceSide.value.set(
      side * (0.72 + 0.28 * lerp(hr, sr, 0.5)),
      side * (0.80 + 0.22 * lerp(hg, sg, 0.5)),
      side * (0.86 + 0.20 * lerp(hb, sb, 0.5)));

    /* ---- the warm half of the hemisphere -----------------------------------
       Everything above is azimuthally flat: it gives a surface facing into a
       burning western sky exactly the same fill as the one facing the cold
       eastern half, which is why a two-light rig always reads as composited.
       This is the DELTA that only the sunward half receives — the low-sun
       horizon glow plus the glitter path off the sea — and it is weighted so
       it is nearly nothing at noon (where the sky really is close to
       azimuthally uniform in a hemisphere sense) and large and amber at 17:45.
       It is what finally puts orange on the underside of the hardtop and on
       the inboard face of the coaming instead of neutral grey. */
    var lowSun = 1.0 - clamp((sunY - 0.03) / 0.55, 0, 1);   // 0 at noon, 1 at sunset
    var warm = (hE * 0.30 + sunE * up * 0.10) * (0.16 + 0.84 * lowSun * lowSun);
    UNI.uBounceWarm.value.set(
      warm * (0.55 + 0.65 * lerp(hr, sr, 0.55)),
      warm * (0.34 + 0.52 * lerp(hg, sg, 0.55)),
      warm * (0.16 + 0.34 * lerp(hb, sb, 0.55)));
    // world-space sun for the azimuth split and for the rim term
    if (sd && isNum(sd.x)) UNI.uSunW.value.set(sd.x, sd.y, sd.z).normalize();
    else UNI.uSunW.value.set(0.3, 0.9, -0.3).normalize();

    /* ---- analytic sun lobe -------------------------------------------------
       View-space sun direction and radiance for the punctual specular term in
       patchMat.  The radiance is deliberately NOT sunE: sunE is the full
       irradiance the diffuse path wants, whereas this lobe is a narrow
       specular one whose job is to CLIP on gloss and fall off fast, so it is
       driven from the sun colour at a fraction that lands a polished tube at
       1.0 in direct noon sun and leaves a roughness-0.5 moulding untouched. */
    var camS = SAIL.camera;
    if (camS && camS.isPerspectiveCamera && sd) {
      _sv.set(sd.x, sd.y, sd.z).transformDirection(camS.matrixWorldInverse);
      UNI.uSunV.value.copy(_sv);
    } else {
      UNI.uSunV.value.set(0.30, 0.90, -0.30);
    }
    /* Fade out as the sun sets — below the horizon there is no disk to glint
       off, and holding it would light the boat from under the sea. */
    var gk = clamp((sunY - 0.005) / 0.06, 0, 1);
    var gE = sunE * 0.030 * gk;
    UNI.uSunRad.value.set(gE * sr, gE * sg, gE * sb);

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
        buildClutter(A, root, P);
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
      /* Every solid surface on the boat receives. 37 of the 85 meshes were
         being missed — the hand-built ones (lamp bodies, ensign, staff, the
         merged 'extra' pass) — and a deck fitting that does not receive
         cannot be sat in the shadow of the thing standing next to it, which
         is most of what "no contact shadows in the cockpit" was. Casting is
         left exactly as each builder set it: the wire ribbons are camera-
         facing analytic ribbons and would cast a false slab, and the ensign
         is a two-sided plane that self-shadows into stripes. */
      try {
        root.traverse(function (o) {
          if (!o.isMesh || o.isSprite) return;
          var mm = o.material;
          if (mm && mm.isShaderMaterial && !mm.isRawShaderMaterial && !mm.lights) {
            // bare ShaderMaterial: three emits no shadow chunks, the flag is
            // inert, and leaving it set only wastes a per-object uniform test
            o.receiveShadow = false; return;
          }
          o.receiveShadow = true;
        });
      } catch (e) { }
      try { probeInit(root); } catch (e) { }
      try { updateLighting(); } catch (e) { }
      _envSeen[0] = _envSeen[1] = null; syncEnv();
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
    refresh: function () { _envSeen[0] = _envSeen[1] = null; syncEnv(); },

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
      /* syncEnv is two reference comparisons in the common case, so there is
         nothing to throttle: throttling it only delayed the moment a finished
         probe reached the materials. */
      try { syncEnv(); } catch (e) { }

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
