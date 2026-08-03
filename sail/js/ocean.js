/* ==========================================================================
   ocean.js  —  SAIL.ocean
   Banded Gerstner sea (Pierson–Moskowitz driven), camera-centred geometric
   radial disc.  CPU and GPU displacement are a mirrored pair.

   Shading, in the order it matters:
     * The reflection comes from SAIL.sky's own sky-view LUT (sky.glsl +
       sky.register), not a private approximation.  At the horizon reflectance
       is 1.0, so the water must return exactly the radiance field the dome is
       drawn from or the skyline grows a luminance cliff.
     * Full Schlick Fresnel, F0 = 0.0204, with no NdotV floor and no lerp toward
       a constant "average" — the grazing limit has to actually reach 1.
     * Two normals from one slope field: a damped one for the sky (a broad
       source is the AVERAGE over the pixel's slope distribution) and the full
       per-pixel one for the sun (a point source lives in the TAIL of that
       distribution).  That split is what makes the glitter break into
       thousands of discrete sparkles instead of one soft Blinn blob.
     * Five detail octaves at mutually irrational tile sizes, stored as LEAN
       slope + second moment so the variance the mip chain filters away becomes
       BRDF roughness (Toksvig) rather than shimmer.
     * Jerlov-I Beer–Lambert water column against the real sounding, volume
       reflectance bb/(a+bb), spatial noise on both, and wrapped subsurface
       transmission on thin backlit crests.
     * Foam from the Gerstner Jacobian with a lagged dissipation tail, bubble
       granularity and an ageing gradient.
     * Sky-visibility occlusion, vertex-stage horizon-map sun shadowing,
       advected wake buffer, Worley caustics.

   World axes: +X = East, +Z = South, -Z = North, Y = up, metres.
   ========================================================================== */
(function () {
  'use strict';
  window.SAIL = window.SAIL || {};
  if (typeof THREE === 'undefined') { window.SAIL.ocean = window.SAIL.ocean || { ready: false }; return; }

  var O = {};
  SAIL.ocean = O;
  O.ready = false;

  /* ------------------------------------------------------------- constants */
  var GRAV = 9.81;
  var DEEP = 60.0;                 // assumed depth where no bathymetry exists
  var DEPTH_SCALE = 40.0;          // metres encoded into the depth texture's R
  var MAXC = 32;                   // uniform slots reserved

  var clamp = function (v, a, b) { return v < a ? a : (v > b ? b : v); };
  var sstep = function (a, b, x) { var t = clamp((x - a) / (b - a || 1e-6), 0, 1); return t * t * (3 - 2 * t); };
  var tnh = function (x) { x = clamp(x, -8, 8); var e = Math.exp(2 * x); return (e - 1) / (e + 1); };

  /* =======================================================================
     1.  SPECTRUM  —  banded component set
     ======================================================================= */
  /* TWO swell trains, not one. A single narrow train is a set of parallel
     ridges by construction — the "corduroy". Two trains crossing at ~47 deg
     produce the diamond interference cell that is the single most recognisable
     signature of open ocean. */
  var SWELL_1 = [136, 98, 72];                                     // primary swell (m)
  var SWELL_2 = [95, 68];                                          // secondary, crossing
  var SWELL_1_LOW = [136, 92];
  var SWELL_2_LOW = [78];
  var SWELL_CROSS = 47 * Math.PI / 180;
  /* Wind sea as a 2-D lattice: WAVELENGTH BINS x DIRECTIONAL QUADRATURE.
     The old set walked direction monotonically with wavelength (exactly
     10 deg/step over 9 components), so at any one scale there was exactly ONE
     plane wave and its crests were perfectly parallel by construction. Here
     each bin carries a 2-node Gauss-Hermite quadrature of the Donelan-Banner
     spreading function, which reproduces the measured along/cross slope
     anisotropy (~1.4:1, vs 6.6:1 for the old fan) automatically. */
  /* The wind sea now reaches 2.1 m as DISPLACED GEOMETRY, not as a normal map.
     The review's "no wind chop riding on the swell as geometry" is exactly the
     gap between the old 3.0 m floor and the detail cascade: everything shorter
     than a 3 m wave was a texture, so the near field had no small-scale relief
     that could occlude, sharpen, fold or catch the sun as a real facet. 2.1 m
     survives the Nyquist gate out to roughly 35 m, which is precisely the band
     of the frame where scale is read. */
  var BAND_B = [34, 24, 17, 12, 8.5, 6.0, 4.2, 3.0, 2.1];          // wind sea (m)
  var BAND_B_LOW = [30, 19, 12, 7.5, 4.6];
  var BAND_C = [1.5, 1.05, 0.72, 0.50];                            // chop — normal-map only
  var SPREAD_A = 9 * Math.PI / 180, SPREAD_C = 75 * Math.PI / 180;
  // Steepness headroom is cut back from 0.85 because the group modulation below
  // swings amplitude up to ~1.5x on a set crest; 0.78*1.5 lands just under the
  // Gerstner self-intersection limit rather than over it.  The wind-sea share
  // rises with the extra short bin: crest sharpening is what makes a sea read
  // as wind-driven rather than as a field of rounded sinusoidal lumps.
  var STEEP_A = 0.26, STEEP_B = 0.45, STEEP_TOTAL = 0.78;

  // one 8-float record per component: dx dz A k w Q phase0 band
  O.comp = new Float32Array(MAXC * 8);
  var compTarget = new Float32Array(MAXC * 8);
  var NDISP = 12;                  // components actually displaced (bands A+B)
  var chopVar = 0.0;               // band-C variance; it is never displaced, so
                                   // it is spent on the detail normal instead

  /* WAVE GROUPING. Real seas arrive in sets: two long, slow modulation waves
     multiply the amplitude of every displaced component, so a train of three
     or four big crests is followed by a lull. Written as a closed analytic form
     (not noise) precisely so the CPU mirror can reproduce it bit-for-bit and
     the buoyancy probes keep agreeing with the rendered surface.
     Layout: kx kz omega depth, twice. */
  var grpF = new Float32Array(8);
  var uGrp0v = null, uGrp1v = null;   // THREE.Vector4, bound in makeMaterial

  function pmS(w, wp) {            // Pierson–Moskowitz
    if (w <= 1e-4) return 0;
    return (8.1e-3 * GRAV * GRAV / Math.pow(w, 5)) * Math.exp(-1.25 * Math.pow(wp / w, 4));
  }

  // deterministic phase per component so the field is reproducible
  function phaseOf(i) { var s = Math.sin(i * 12.9898 + 78.233) * 43758.5453; return (s - Math.floor(s)) * Math.PI * 2; }

  /* Build the target component set. Amplitudes/directions/steepness only;
     wavelengths (hence k and w) are FIXED so the field can be cross-faded
     without a phase discontinuity at large |x|. */
  /* Frequency bandwidth of bin i inside its own wavelength list. Computed per
     LIST rather than per record, because the wind sea now carries several
     records at the SAME wavelength (one per quadrature node) and taking
     neighbours in record order would hand those duplicates dw = 0. */
  function dwOf(list, i) {
    var kA = 2 * Math.PI / list[Math.min(i + 1, list.length - 1)];
    var kB = 2 * Math.PI / list[Math.max(i - 1, 0)];
    var wA = Math.sqrt(GRAV * kA), wB = Math.sqrt(GRAV * kB);
    return Math.max(1e-3, Math.abs(wA - wB) * (i === 0 || i === list.length - 1 ? 1.0 : 0.5));
  }

  function buildSpectrum(U10, swellM, windToward, swellFromDeg, low) {
    var S1 = low ? SWELL_1_LOW : SWELL_1;
    var S2 = low ? SWELL_2_LOW : SWELL_2;
    var LB = low ? BAND_B_LOW : BAND_B;
    var LC = low ? [] : BAND_C;
    var NODE = low ? 1 : 2;                                        // directional quadrature nodes
    NDISP = S1.length + S2.length + LB.length * NODE;

    var wdir = Math.atan2(windToward.x, -windToward.z);            // compass-toward, radians
    var sdir = (swellFromDeg + 180) * Math.PI / 180;               // swell travels TO here
    var sdir2 = sdir + SWELL_CROSS;

    var recs = [];
    var i, m, n, sp, jit;

    // ---- swell train 1 (primary)
    for (i = 0; i < S1.length; i++) {
      n = S1.length;
      sp = n > 1 ? ((i * 2 + 1) / n - 1) : 0;
      jit = phaseOf(i * 3 + 1) / Math.PI - 1.0;
      recs.push({ band: 0, L: S1[i], th: sdir + sp * SPREAD_A + jit * 0.055,
                  dw: dwOf(S1, i), pk: S1[0], w0: 1.0 });
    }
    // ---- swell train 2 (crossing, 47 deg off, ~47% of the energy)
    for (i = 0; i < S2.length; i++) {
      n = S2.length;
      sp = n > 1 ? ((i * 2 + 1) / n - 1) : 0;
      jit = phaseOf(i * 5 + 11) / Math.PI - 1.0;
      recs.push({ band: 0, L: S2[i], th: sdir2 + sp * SPREAD_A * 1.3 + jit * 0.075,
                  dw: dwOf(S2, i), pk: S2[0], w0: 0.47 });
    }
    /* ---- wind sea: each wavelength bin gets NODE independent directions drawn
       from the Donelan-Banner spreading function by Gauss-Hermite quadrature
       (2 nodes at +-sigma, weight 1/2 each, which reproduces the second moment
       exactly). An extra per-bin irrational jitter breaks the residual symmetry
       so consecutive bins do not stack into a lattice. */
    var kp = GRAV / Math.max(U10 * U10, 0.36) * 0.877 * 0.877;      // peak wavenumber
    for (i = 0; i < LB.length; i++) {
      var kk = 2 * Math.PI / LB[i];
      /* Directional half-width GROWS with wavenumber: the short gravity waves
         are close to isotropic while the spectral peak is narrow. Calibrated so
         the aggregate slope covariance lands on the measured Cox & Munk
         along/cross ratio of ~1.4:1 at 18 kn (the old monotone fan measured
         6.6:1 — that number IS the corduroy). */
      var sig = clamp(0.441 * Math.pow(Math.max(kk / kp, 1e-3), 0.20), 0.34, 0.84);
      for (m = 0; m < NODE; m++) {
        var node = (NODE === 1) ? ((i % 2) ? 0.85 : -0.85) : (m === 0 ? -1 : 1);
        jit = phaseOf(i * 7 + m * 29 + 3) / Math.PI - 1.0;
        recs.push({ band: 1, L: LB[i], th: wdir + node * sig + jit * 0.42 * sig,
                    dw: dwOf(LB, i), w0: 1 / Math.sqrt(NODE) });
      }
    }
    for (i = 0; i < LC.length; i++) {
      n = LC.length;
      sp = n > 1 ? ((i * 2 + 1) / n - 1) : 0;
      recs.push({ band: 2, L: LC[i], th: wdir + sp * SPREAD_C, dw: dwOf(LC, i), w0: 1.0 });
    }

    for (i = 0; i < recs.length; i++) {
      recs[i].k = 2 * Math.PI / recs[i].L;
      recs[i].w = Math.sqrt(GRAV * recs[i].k);
    }

    var wpWind = 0.877 * GRAV / Math.max(U10, 0.6);
    for (i = 0; i < recs.length; i++) {
      var r = recs[i];
      if (r.band === 0) {
        var wA0 = Math.sqrt(GRAV * 2 * Math.PI / r.pk);             // this TRAIN's own peak
        var q = (r.w - wA0) / (0.34 * wA0);
        r.raw = Math.exp(-q * q) * r.w0;                            // narrow-band swell
      } else {
        r.raw = Math.sqrt(2 * pmS(r.w, wpWind) * r.dw) * r.w0;
      }
      r.raw = Math.max(r.raw, 1e-7);
    }

    /* Group-modulation field. Two long modulation waves — one riding with the
       swell, one obliquely with the wind — so the sets are irregular rather
       than metronomic. Group speed is half the phase speed in deep water. */
    var kg1 = 2 * Math.PI / 780, kg2 = 2 * Math.PI / 430;
    var gd2 = wdir + 0.72;
    grpF[0] = Math.sin(sdir) * kg1; grpF[1] = -Math.cos(sdir) * kg1;
    grpF[2] = Math.sqrt(GRAV * kg1) * 0.5; grpF[3] = 0.30;
    grpF[4] = Math.sin(gd2) * kg2; grpF[5] = -Math.cos(gd2) * kg2;
    grpF[6] = Math.sqrt(GRAV * kg2) * 0.5; grpF[7] = 0.20;
    if (uGrp0v) { uGrp0v.set(grpF[0], grpF[1], grpF[2], grpF[3]); }
    if (uGrp1v) { uGrp1v.set(grpF[4], grpF[5], grpF[6], grpF[7]); }

    // normalise each band to its target significant height:  sum(a^2) = Hs^2/8
    var HsWind = 0.22 * U10 * U10 / GRAV;
    var target = [Math.max(0.02, swellM), 0.88 * HsWind, 0.12 * HsWind];
    var sum = [0, 0, 0];
    for (i = 0; i < recs.length; i++) sum[recs[i].band] += recs[i].raw * recs[i].raw;
    for (i = 0; i < recs.length; i++) {
      var b = recs[i].band;
      var g = Math.sqrt((target[b] * target[b] / 8) / Math.max(sum[b], 1e-12));
      recs[i].A = recs[i].raw * g;
    }

    // steepness allocation, then the global self-intersection guard
    var sAk = [0, 0, 0];
    for (i = 0; i < recs.length; i++) sAk[recs[i].band] += recs[i].A * recs[i].k;
    var qb = [
      Math.min(1, STEEP_A / Math.max(sAk[0], 1e-6)),
      Math.min(1, STEEP_B / Math.max(sAk[1], 1e-6)),
      Math.min(1, 0.10 / Math.max(sAk[2], 1e-6))
    ];
    var tot = 0;
    for (i = 0; i < recs.length; i++) if (recs[i].band < 2) tot += qb[recs[i].band] * recs[i].A * recs[i].k;
    if (tot > STEEP_TOTAL) { var f = STEEP_TOTAL / tot; qb[0] *= f; qb[1] *= f; tot = STEEP_TOTAL; }
    O.steepSum = tot;

    chopVar = 0;
    var jvar = 0, mss = 0;
    compTarget.fill(0);
    for (i = 0; i < recs.length && i < MAXC; i++) {
      var rc = recs[i], o = i * 8, Q = qb[rc.band];
      if (rc.band < 2 && i < NDISP) { var ak = rc.A * rc.k; mss += 0.5 * ak * ak; }
      compTarget[o] = Math.sin(rc.th);
      compTarget[o + 1] = -Math.cos(rc.th);
      compTarget[o + 2] = rc.A;
      compTarget[o + 3] = rc.k;
      compTarget[o + 4] = rc.w;
      compTarget[o + 5] = Q;
      compTarget[o + 6] = phaseOf(i);
      compTarget[o + 7] = rc.band;
      if (rc.band === 2) chopVar += rc.A * rc.A * 0.5;
      else { var qak = Q * rc.A * rc.k; jvar += qak * qak * 0.5; }
    }

    O.Hs = Math.sqrt(target[0] * target[0] + target[1] * target[1] + target[2] * target[2]);
    O.U10 = U10;
    O.meshMss = mss;                 // slope variance the displaced mesh carries
    O.jSigma = Math.sqrt(Math.max(jvar, 1e-8));
    // Band C is never displaced, so its RMS elevation is what the two scrolling
    // detail-normal octaves stand in for: glassy in light air, alive when it pipes up.
    O.chopRms = Math.sqrt(chopVar);

    /* Whitecap coverage. Monahan's W = 3.84e-6*U10^3.41 counts only ACTIVE
       (stage-A) breaking crests; what the eye sees is stage A plus the residual
       bubble raft drifting off them, which is several times larger. Asher's
       stage-A+B fit is used instead so 18 kn lands near 3% of active crest and
       ~6% once the decay tail is included — sparse, crest-locked and clearly
       legible, rather than Monahan's 0.7% which renders as no foam at all.
       J is a product of sums and is NOT Gaussian, so assuming a normal quantile
       mis-sets the threshold badly. Measure the real distribution instead:
       sample J over open water and integrate the coverage directly. */
    var W = clamp(3.6e-5 * Math.pow(Math.max(U10, 0.5), 3.0), 0.0, 0.16);
    O.foamW = W;
    /* COVERAGE, SOLVED AS AN AREA RATHER THAN AN INTEGRAL.
       The old solve matched the MEAN of a wide smoothstep to W. A wide ramp with
       mean W has a large low-alpha skirt, and a skirt at 0.15 alpha over a navy
       body is plainly visible — which is how a 3% whitecap model rendered as a
       17-70% crust. Two changes:
         (a) the gate is now near-binary (width 0.34 sigma instead of 0.9), so
             "mean" and "area" are the same number and the skirt is gone;
         (b) the threshold is the exact QUANTILE of the measured J distribution,
             solved for the area fraction the shader will actually paint.
       Budget. The fragment stage unions FOUR taps of the same gate — the live
       fold plus three advected, ageing rafts — and the granular bubble mask
       erodes each by ~28%. The union of the aged taps roughly doubles the live
       area (they are strongly correlated: the same crest, drifted), so solving
       the live gate for W*0.42/0.72 is the starting estimate. It is only a
       starting estimate: O.calibrateFoam then MEASURES the painted area on the
       GPU and corrects the quantile until it tracks W, and selfTest asserts the
       result. A coverage target that is never measured is a comment. */
    jacobianSamples(compTarget, NDISP);
    O.foamBudget = clamp(W * 0.42 / 0.72, 0.0, 0.12);
    solveFoamThreshold(O.foamBudget * foamCal);
    // Below ~0.2% coverage the sample count cannot resolve the tail, so fade
    // crest foam out directly rather than letting quantisation noise show.
    O.foamGain = clamp(W / 0.0030, 0, 1);
  }

  /* The exact quantile of the MEASURED J distribution. J is a product of sums
     and is emphatically not Gaussian, so a normal quantile mis-sets the
     threshold by a factor of several; the only honest way to hit a coverage
     target is to integrate the real sample set. */
  var _nj = 0;
  function solveFoamThreshold(Wgate) {
    Wgate = clamp(Wgate, 1e-5, 0.30);
    var lo = _jmin, hi = _jmax, mid = 0, it, i;
    for (it = 0; it < 26; it++) {
      mid = 0.5 * (lo + hi);
      var cnt = 0;
      for (i = 0; i < _nj; i++) if (_jbuf[i] < mid) cnt++;
      if (cnt / _nj > Wgate) hi = mid; else lo = mid;
    }
    var wid = clamp(0.34 * O.jSigma, 0.015, 0.26);
    O.foamHi = mid + wid * 0.5;
    O.foamLo = mid - wid * 0.5;
    O.foamGateFrac = Wgate;
    O.foamCal = foamCal;
  }

  /* Learned once at build: the ratio between the gate quantile asked for and the
     screen area the four-tap union with its Worley erosion actually paints.
     Solved by measurement (O.calibrateFoam) rather than guessed, then reused for
     every subsequent spectrum retarget so a gust does not cost a GPU readback. */
  var foamCal = 1.0;

  var _jbuf = new Float64Array(4096), _jmin = 0, _jmax = 2;
  function jacobianSamples(arr, nDisp) {
    /* 64x64 golden-ratio-jittered grid over 1.8 km of open water, t = 0.
       24x24 was 576 samples, so a 1.7% tail was estimated from ten of them —
       the threshold that came out of that had a quantisation error of tens of
       percent, which is most of a factor of two in painted coverage. */
    var N = 64, n = 0, GA = 0.6180339887;
    _jmin = 1e9; _jmax = -1e9;
    for (var b = 0; b < N; b++) for (var a = 0; a < N; a++) {
      var x = (a + ((b * GA) % 1)) / N * 1800 - 900;
      var z = (b + ((a * GA) % 1)) / N * 1800 - 900;
      var Jxx = 1, Jzz = 1, Jxz = 0;
      /* The group modulation has to be in here. Without it the threshold is
         solved against a distribution whose tail is ~1.5x too thin — the sets
         are exactly where the folds get steep — and the rendered coverage comes
         out several times the target, which is a sea of whitecaps. */
      var gR = grpF[3] * Math.sin(x * grpF[0] + z * grpF[1])
             + grpF[7] * Math.sin(x * grpF[4] + z * grpF[5] + 2.1);
      var gS = Math.max(1 + gR, 0.08), gW = Math.max(1 + 0.62 * gR, 0.08);
      for (var i = 0; i < nDisp; i++) {
        var o = i * 8, dx = arr[o], dz = arr[o + 1], A = arr[o + 2], k = arr[o + 3];
        var Q = arr[o + 5], p0 = arr[o + 6];
        if (A <= 1e-6) continue;
        var sn = Math.sin(k * (dx * x + dz * z) + p0);
        var qak = Q * A * k * (arr[o + 7] < 0.5 ? gS : gW);
        Jxx -= qak * dx * dx * sn; Jzz -= qak * dz * dz * sn; Jxz -= qak * dx * dz * sn;
      }
      var J = Jxx * Jzz - Jxz * Jxz;
      if (J < _jmin) _jmin = J;
      if (J > _jmax) _jmax = J;
      _jbuf[n++] = J;
    }
    _nj = n;
    return n;
  }

  /* =======================================================================
     2.  BATHYMETRY GRID  (CPU + GPU share one bilinear source of truth)
     ======================================================================= */
  var DG = null;                   // { data:Uint8Array, N, x0, z0, ix, iz, tex }

  function buildDepthGrid(low) {
    var N = low ? 256 : 512;
    var isl = SAIL.island;
    var b = (isl && isl.bounds) || { TX0: -1900, TX1: 1300, TZ0: -1500, TZ1: 1550 };
    var x0 = (b.TX0 !== undefined ? b.TX0 : b.x0) || -1900;
    var x1 = (b.TX1 !== undefined ? b.TX1 : b.x1) || 1300;
    var z0 = (b.TZ0 !== undefined ? b.TZ0 : b.z0) || -1500;
    var z1 = (b.TZ1 !== undefined ? b.TZ1 : b.z1) || 1550;

    var data = new Uint8Array(N * N * 4);
    var dfun = isl && typeof isl.depthAt === 'function' ? isl.depthAt.bind(isl) : null;
    var sfun = isl && typeof isl.shelter === 'function' ? isl.shelter.bind(isl)
             : (isl && typeof isl.shelterAt === 'function' ? isl.shelterAt.bind(isl) : null);

    for (var j = 0; j < N; j++) {
      var z = z0 + (j + 0.5) / N * (z1 - z0);
      for (var i = 0; i < N; i++) {
        var x = x0 + (i + 0.5) / N * (x1 - x0);
        var d = dfun ? dfun(x, z) : DEEP;
        if (!(d === d)) d = DEEP;
        var land = d < 0 ? 1 : 0;
        var dd = land ? 0 : Math.min(d, DEPTH_SCALE);
        var sh = sfun ? clamp(sfun(x, z), 0.05, 1) : clamp(0.10 + 0.90 * sstep(2.5, 26, d), 0.05, 1);
        var o = (j * N + i) * 4;
        data[o] = Math.round(dd / DEPTH_SCALE * 255);
        data[o + 1] = Math.round(sh * 255);
        data[o + 2] = land ? 255 : 0;
        data[o + 3] = 255;
      }
    }
    var tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.LinearSRGBColorSpace;
    tex.needsUpdate = true;
    DG = { data: data, N: N, x0: x0, z0: z0, ix: 1 / (x1 - x0), iz: 1 / (z1 - z0), tex: tex };
  }

  // bilinear read, identical arithmetic to the GPU's texture2D
  var _sb = { d: DEEP, s: 1, land: 0 };
  function seabedCPU(x, z) {
    if (!DG) {
      var isl = SAIL.island;
      var d = isl && isl.depthAt ? isl.depthAt(x, z) : DEEP;
      _sb.land = d < 0 ? 1 : 0; _sb.d = _sb.land ? -1.2 : d; _sb.s = 1;
      return _sb;
    }
    var u = (x - DG.x0) * DG.ix, v = (z - DG.z0) * DG.iz;
    if (u < 0 || u > 1 || v < 0 || v > 1) { _sb.d = DEEP; _sb.s = 1; _sb.land = 0; return _sb; }
    var N = DG.N;
    var fx = clamp(u, 0.002, 0.998) * N - 0.5, fz = clamp(v, 0.002, 0.998) * N - 0.5;
    var i0 = Math.floor(fx), j0 = Math.floor(fz), tx = fx - i0, tz = fz - j0;
    i0 = clamp(i0, 0, N - 2); j0 = clamp(j0, 0, N - 2);
    var a = (j0 * N + i0) * 4, b = a + 4, c = a + N * 4, e = c + 4, D = DG.data;
    var r = ((D[a] * (1 - tx) + D[b] * tx) * (1 - tz) + (D[c] * (1 - tx) + D[e] * tx) * tz) / 255;
    var g = ((D[a + 1] * (1 - tx) + D[b + 1] * tx) * (1 - tz) + (D[c + 1] * (1 - tx) + D[e + 1] * tx) * tz) / 255;
    var l = ((D[a + 2] * (1 - tx) + D[b + 2] * tx) * (1 - tz) + (D[c + 2] * (1 - tx) + D[e + 2] * tx) * tz) / 255;
    _sb.d = r * DEPTH_SCALE - l * 1.2; _sb.s = g; _sb.land = l;
    return _sb;
  }
  O.depthAt = function (x, z) { var s = seabedCPU(x, z); return s.d; };
  O.shelterAt = function (x, z) { return seabedCPU(x, z).s; };

  /* =======================================================================
     3.  CPU EVALUATOR  —  mirrored pair with the vertex shader below.
         Identical order of summation; float error stays at the 1e-4 m level.
     ======================================================================= */
  var _acc = { y: 0, dx: 0, dz: 0, nx: 0, ny: 1, nz: 0, J: 1 };

  function gerstnerCPU(px, pz, t, wantNormal) {
    var sb = seabedCPU(px, pz);
    var dep = sb.d, shel = sb.s;
    var C = O.comp;
    var dispX = 0, dispZ = 0, dispY = 0;
    var txx = 1, txy = 0, txz = 0, tzx = 0, tzy = 0, tzz = 1;
    var Jxx = 1, Jzz = 1, Jxz = 0;
    /* Group modulation, mirrored EXACTLY from grpMod() in GLSL_GERSTNER. Closed
       form on purpose: any noise-based grouping would drift between CPU and GPU
       and the buoyancy probes would stop agreeing with what is drawn. */
    var gRaw = grpF[3] * Math.sin(px * grpF[0] + pz * grpF[1] - grpF[2] * t)
             + grpF[7] * Math.sin(px * grpF[4] + pz * grpF[5] - grpF[6] * t + 2.1);
    var gmS = Math.max(1 + gRaw, 0.08), gmW = Math.max(1 + 0.62 * gRaw, 0.08);
    for (var i = 0; i < NDISP; i++) {
      var o = i * 8;
      var dx = C[o], dz = C[o + 1], A = C[o + 2], k = C[o + 3], w = C[o + 4], Q = C[o + 5], p0 = C[o + 6];
      var band = C[o + 7];
      if (A <= 1e-6) continue;
      var sm = band < 0.5 ? shel : (0.45 + 0.55 * shel);
      var th = tnh(k * Math.max(dep, 0.02));
      var ke = k / Math.max(Math.sqrt(th), 0.08);
      var Ae = A * sm * clamp(Math.pow(Math.max(th, 1e-4), -0.25), 0, 1.9);
      Ae *= (band < 0.5) ? gmS : gmW;
      if (dep < 0.35) Ae = 0; else if (Ae > 0.42 * dep) Ae = 0.42 * dep;
      if (Ae <= 1e-6) continue;
      var ph = ke * (dx * px + dz * pz) - w * t + p0;
      var c = Math.cos(ph), s = Math.sin(ph);
      var qa = Q * Ae;
      dispX += qa * dx * c; dispZ += qa * dz * c; dispY += Ae * s;
      if (wantNormal) {
        var wa = ke * Ae, qw = Q * wa;
        txx += -qw * dx * dx * s; txz += -qw * dx * dz * s; txy += wa * dx * c;
        tzx += -qw * dz * dx * s; tzz += -qw * dz * dz * s; tzy += wa * dz * c;
        var qak = Q * Ae * ke;
        Jxx -= qak * dx * dx * s; Jzz -= qak * dz * dz * s; Jxz -= qak * dx * dz * s;
      }
    }
    _acc.dx = dispX; _acc.dz = dispZ; _acc.y = dispY;
    if (wantNormal) {
      // n = normalize(cross(tz, tx))
      var nx = tzy * txz - tzz * txy;
      var ny = tzz * txx - tzx * txz;
      var nz = tzx * txy - tzy * txx;
      var il = 1 / (Math.hypot(nx, ny, nz) || 1);
      if (ny < 0) il = -il;
      _acc.nx = nx * il; _acc.ny = ny * il; _acc.nz = nz * il;
      _acc.J = Jxx * Jzz - Jxz * Jxz;
    }
    return _acc;
  }

  /* Height inversion: the GPU displaces horizontally, so the vertex that ends
     up at (x,z) started elsewhere. Two fixed-point iterations converge to
     <0.02 m for sum(QkA) <= 0.85. */
  function invert(x, z, t, wantNormal) {
    var px = x, pz = z;
    for (var it = 0; it < 2; it++) {
      var a = gerstnerCPU(px, pz, t, false);
      px = x - a.dx; pz = z - a.dz;
    }
    return gerstnerCPU(px, pz, t, wantNormal);
  }

  /* Memo for repeated probes at the SAME point and time - which is what the
     200 Hz substep loop does when it holds the wave field across a frame.
     Keyed on the exact coordinates: quantising position would silently return
     a neighbour's height, and 0.2 m of slop is several centimetres of error on
     a buoyancy probe. Cleared whenever the frame time advances. */
  var tHold = 0, cacheT = -1e9, CACHE_N = 96;
  var cacheX = new Float64Array(CACHE_N), cacheZ = new Float64Array(CACHE_N);
  var cacheVal = new Float32Array(CACHE_N * 5);
  var cacheUsed = 0, cacheNext = 0;

  function cachedSample(x, z, t) {
    if (t !== cacheT) { cacheT = t; cacheUsed = 0; cacheNext = 0; }
    for (var i = 0; i < cacheUsed; i++) {
      if (cacheX[i] === x && cacheZ[i] === z) return i;
    }
    var a = invert(x, z, t, true);
    var slot;
    if (cacheUsed < CACHE_N) slot = cacheUsed++;
    else { slot = cacheNext; cacheNext = (cacheNext + 1) % CACHE_N; }
    cacheX[slot] = x; cacheZ[slot] = z;
    var o = slot * 5;
    cacheVal[o] = a.y; cacheVal[o + 1] = a.nx; cacheVal[o + 2] = a.ny; cacheVal[o + 3] = a.nz; cacheVal[o + 4] = a.J;
    return slot;
  }

  O.heightAt = function (x, z, t) {
    if (!O.ready) return 0;
    return cacheVal[cachedSample(x, z, t === undefined ? tHold : t) * 5];
  };
  var _nv = new THREE.Vector3(0, 1, 0);
  O.normalAt = function (x, z, t) {
    if (!O.ready) return _nv.set(0, 1, 0);
    var o = cachedSample(x, z, t === undefined ? tHold : t) * 5;
    return _nv.set(cacheVal[o + 1], cacheVal[o + 2], cacheVal[o + 3]);
  };
  O.sample = function (x, z, t) {
    if (!O.ready) return { y: 0, n: { x: 0, y: 1, z: 0 }, J: 1, slope: { sx: 0, sz: 0 } };
    var o = cachedSample(x, z, t === undefined ? tHold : t) * 5;
    var ny = cacheVal[o + 2] || 1;
    return {
      y: cacheVal[o], n: { x: cacheVal[o + 1], y: ny, z: cacheVal[o + 3] }, J: cacheVal[o + 4],
      slope: { sx: -cacheVal[o + 1] / ny, sz: -cacheVal[o + 3] / ny }
    };
  };

  /* =======================================================================
     4.  SHARED GLSL
     ======================================================================= */
  var GLSL_COMMON = [
    'float tnh(float x){ x=clamp(x,-8.0,8.0); float e=exp(2.0*x); return (e-1.0)/(e+1.0); }',
    /* PRECISION.  Every hash in this file used to be fract(sin(dot(p,k))*43758).
       World coordinates here run to several thousand metres and the fine octaves
       multiply that by 4, so dot(p,k) reaches ~3e6.  A float32 mantissa is 24
       bits, so at 3e6 the representable step is 0.25 rad — sin() of that has no
       structure left, it is quantisation noise.  THAT is the mottled
       lichen/pack-ice crust the review saw: a hash that degenerates into a
       fixed-scale speckle pattern the further you are from the world origin,
       which is exactly why it never attenuated with distance.
       Replaced with a wrapped integer-friendly hash (Hoskins) whose argument is
       first folded into [0,1024) so the multiply never leaves the exactly
       representable range. */
    'vec2 hwrap(vec2 p){ return p - floor(p*(1.0/1024.0))*1024.0; }',
    'float h21(vec2 p){ vec3 q = fract(vec3(hwrap(p).xyx)*vec3(0.1031,0.1030,0.0973));',
    '  q += dot(q, q.yzx + 33.33); return fract((q.x+q.y)*q.z); }',
    'vec2 h22(vec2 p){ vec3 q = fract(vec3(hwrap(p).xyx)*vec3(0.1031,0.1030,0.0973));',
    '  q += dot(q, q.yzx + 33.33); return fract((q.xx+q.yz)*q.zy); }',
    'float vn2(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);',
    '  return mix(mix(h21(i),h21(i+vec2(1.0,0.0)),f.x), mix(h21(i+vec2(0.0,1.0)),h21(i+vec2(1.0,1.0)),f.x), f.y); }',
    /* island.js' hash and fbm, copied bit for bit — including its hash, which
       is NOT the one above. The cumulus shadow field has to be the identical
       field on the water and on the slopes or every band seams at the beach. */
    'float h21i(vec2 p){ p=fract(p*vec2(127.1,311.7)); p+=dot(p,p+41.73); return fract(p.x*p.y*2.713); }',
    'float vn2i(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);',
    '  return mix(mix(h21i(i),h21i(i+vec2(1.0,0.0)),f.x), mix(h21i(i+vec2(0.0,1.0)),h21i(i+vec2(1.0,1.0)),f.x), f.y); }',
    'float fbm2o(vec2 p){ float s=vn2i(p)*0.55; s+=vn2i(p*2.07)*0.27; s+=vn2i(p*4.13)*0.13; s+=vn2i(p*8.31)*0.05; return s; }'
  ].join('\n');

  // seabed lookup — depth (m, negative on land), shelter, land mask
  var GLSL_SEABED = [
    'uniform sampler2D uDepthTex;',
    'uniform vec4 uDepthRect;',    // x0, z0, 1/(x1-x0), 1/(z1-z0)
    'vec3 seabed(vec2 p){',
    '  vec2 uv = (p - uDepthRect.xy) * uDepthRect.zw;',
    '  float ins = step(0.0,uv.x)*step(uv.x,1.0)*step(0.0,uv.y)*step(uv.y,1.0);',
    '  vec4 t = texture2D(uDepthTex, clamp(uv, 0.002, 0.998));',
    '  float dep = mix(' + DEEP.toFixed(1) + ', t.r*' + DEPTH_SCALE.toFixed(1) + ' - t.b*1.2, ins);',
    '  float sh  = mix(1.0, t.g, ins);',
    '  return vec3(dep, sh, mix(0.0, t.b, ins));',
    '}'
  ].join('\n');

  // the mirrored half of gerstnerCPU
  var GLSL_GERSTNER = [
    'uniform vec4 uW[NDISP*2];',
    'uniform vec4 uGrp0, uGrp1;',
    /* Nyquist guard on the displaced components.
       The OLD gate was `smoothstep(0,1, L/(2.05*spacing) - 1)`, which needs 4.1
       samples per wavelength for full amplitude and reaches zero at 2.05. Closed
       form against the old ring law that put a 20 m wind wave at 2% by 157 m —
       57 screen pixels across, plainly resolvable, thrown away. The whole reason
       the sea collapsed to a metallic sheet past 200 m.
       New gate: full at 2.7 samples/wavelength, out at 1.1. Combined with the
       screen-referred ring law in ringRadii() the same 20 m wave now survives
       past 450 m, and everything the gate DOES discard is carried in `lost` and
       re-injected in the fragment stage as visible mid-band slope. */
    '#define NYQ 2.0',
    /* Wave grouping: sets. Closed analytic form so gerstnerCPU can mirror it
       exactly — see the note by grpF in the JS above. */
    'float grpMod(vec2 p, float t, float bs){',
    '  float g = uGrp0.w*sin(dot(p, uGrp0.xy) - uGrp0.z*t)',
    '          + uGrp1.w*sin(dot(p, uGrp1.xy) - uGrp1.z*t + 2.1);',
    '  return max(1.0 + bs*g, 0.08);',
    '}',
    'void oceanEval(vec2 p, float t, float dep, float shel, float spacing,',
    '               out vec3 disp, out vec3 nrm, out vec4 jac, out float swash, out float lost){',
    '  disp = vec3(0.0);',
    '  vec3 tx = vec3(1.0,0.0,0.0), tz = vec3(0.0,0.0,1.0);',
    '  float Jxx=1.0, Jzz=1.0, Jxz=0.0, dJdt=0.0, lap=0.0;',
    '  float tot=0.0, cut=0.0; swash=0.0;',
    '  float gmS = grpMod(p, t, 1.0), gmW = grpMod(p, t, 0.62);',
    '  for(int i=0;i<NDISP;i++){',
    '    vec4 a = uW[i*2]; vec4 b = uW[i*2+1];',
    '    vec2 d = a.xy; float A = a.z; float k = a.w;',
    '    float w = b.x; float Q = b.y; float p0 = b.z; float band = b.w;',
    '    float sm = (band < 0.5) ? shel : (0.45 + 0.55*shel);',
    '    float th = tnh(k*max(dep,0.02));',
    '    float ke = k / max(sqrt(th), 0.08);',
    '    float Ae = A*sm*clamp(pow(max(th,1e-4), -0.25), 0.0, 1.9);',
    '    Ae *= (band < 0.5) ? gmS : gmW;',
    '    Ae = min(Ae, 0.42*max(dep,0.0)) * step(0.35, dep);',
    '    float L = 6.28318530718/k;',
    '    float ny = smoothstep(0.55, 1.35, L/(NYQ*max(spacing,0.01)));',
    '    tot += A*A; cut += A*A*(1.0-ny);',
    '    Ae *= ny;',
    '    float ph = ke*dot(d,p) - w*t + p0;',
    '    float c = cos(ph), s = sin(ph);',
    '    float qa = Q*Ae;',
    '    disp.x += qa*d.x*c; disp.z += qa*d.y*c; disp.y += Ae*s;',
    '    float wa = ke*Ae, qw = Q*wa;',
    '    tx.x += -qw*d.x*d.x*s; tx.z += -qw*d.x*d.y*s; tx.y += wa*d.x*c;',
    '    tz.x += -qw*d.y*d.x*s; tz.z += -qw*d.y*d.y*s; tz.y += wa*d.y*c;',
    '    float qak = qa*ke;',
    '    Jxx -= qak*d.x*d.x*s; Jzz -= qak*d.y*d.y*s; Jxz -= qak*d.x*d.y*s;',
    '    dJdt += qak*w*c;',
    '    lap  -= qak*ke*s;',
    '    swash += (band < 0.5) ? Ae*sin(ph + 1.4*w) : 0.0;',
    '  }',
    '  nrm = normalize(cross(tz,tx));',
    '  jac = vec4(Jxx*Jzz - Jxz*Jxz, dJdt, lap, 0.0);',
    '  lost = clamp(sqrt(cut/max(tot,1e-6)), 0.0, 1.0);',
    '}',
    /* Elevation only — used by the vertex-stage horizon-map self-shadow. Same
       amplitude/LOD arithmetic as oceanEval so the shadow tests the surface the
       mesh actually renders, not an idealised one. */
    'float oceanH(vec2 p, float t, float dep, float shel, float spacing){',
    '  float y = 0.0;',
    '  float gmS = grpMod(p, t, 1.0), gmW = grpMod(p, t, 0.62);',
    '  for(int i=0;i<NDISP;i++){',
    '    vec4 a = uW[i*2]; vec4 b = uW[i*2+1];',
    '    vec2 d = a.xy; float A = a.z; float k = a.w;',
    '    float w = b.x; float p0 = b.z; float band = b.w;',
    '    float sm = (band < 0.5) ? shel : (0.45 + 0.55*shel);',
    '    float th = tnh(k*max(dep,0.02));',
    '    float ke = k / max(sqrt(th), 0.08);',
    '    float Ae = A*sm*clamp(pow(max(th,1e-4), -0.25), 0.0, 1.9);',
    '    Ae *= (band < 0.5) ? gmS : gmW;',
    '    Ae = min(Ae, 0.42*max(dep,0.0)) * step(0.35, dep);',
    '    float L = 6.28318530718/k;',
    '    Ae *= smoothstep(0.55, 1.35, L/(NYQ*max(spacing,0.01)));',
    '    y += Ae*sin(ke*dot(d,p) - w*t + p0);',
    '  }',
    '  return y;',
    '}',
    /* Jacobian determinant only, at an arbitrary (position, time). Foam is not a
       function of the CURRENT fold: it is born where the surface folded, then
       drifts and dissolves. Evaluating J at (p - drift*tau, t - tau) gives the
       real advected, ageing raft instead of the dJ/dt smear that produced
       thirty-metre unbroken ribbons. */
    'float oceanJ(vec2 p, float t, float dep, float shel, float spacing){',
    '  float Jxx=1.0, Jzz=1.0, Jxz=0.0;',
    '  float gmS = grpMod(p, t, 1.0), gmW = grpMod(p, t, 0.62);',
    '  for(int i=0;i<NDISP;i++){',
    '    vec4 a = uW[i*2]; vec4 b = uW[i*2+1];',
    '    vec2 d = a.xy; float A = a.z; float k = a.w;',
    '    float w = b.x; float Q = b.y; float p0 = b.z; float band = b.w;',
    '    float sm = (band < 0.5) ? shel : (0.45 + 0.55*shel);',
    '    float th = tnh(k*max(dep,0.02));',
    '    float ke = k / max(sqrt(th), 0.08);',
    '    float Ae = A*sm*clamp(pow(max(th,1e-4), -0.25), 0.0, 1.9);',
    '    Ae *= (band < 0.5) ? gmS : gmW;',
    '    Ae = min(Ae, 0.42*max(dep,0.0)) * step(0.35, dep);',
    '    float L = 6.28318530718/k;',
    '    Ae *= smoothstep(0.55, 1.35, L/(NYQ*max(spacing,0.01)));',
    '    float s = sin(ke*dot(d,p) - w*t + p0);',
    '    float qak = Q*Ae*ke;',
    '    Jxx -= qak*d.x*d.x*s; Jzz -= qak*d.y*d.y*s; Jxz -= qak*d.x*d.y*s;',
    '  }',
    '  return Jxx*Jzz - Jxz*Jxz;',
    '}'
  ].join('\n');

  /* Static Worley — the bubble raft itself. Foam is not a smooth alpha ramp: it
     is a packed cellular froth, and at pixel scale each cell is either white or
     it is water. Two octaves (~0.7 m rafts, ~0.2 m bubbles) give the
     granularity, and because they are world-locked and advected with the surface
     drift they foreshorten correctly instead of scrolling.
     Hoisted out of the fragment shader so O.foamAudit() can compile the EXACT
     same erosion mask when it measures painted coverage — a coverage assertion
     against a re-implementation of the mask would not be an assertion. */
  var GLSL_BUBBLE = [
    'vec2 h22b(vec2 p){ return h22(p); }',
    'float worS(vec2 p){',
    '  vec2 i = floor(p), f = fract(p);',
    '  vec2 o0 = step(vec2(0.5), f) - vec2(1.0);',
    '  float d = 4.0;',
    '  for(int y=0;y<2;y++){ for(int x=0;x<2;x++){',
    '    vec2 g = o0 + vec2(float(x), float(y));',
    '    vec2 fp = h22b(i+g);',
    '    d = min(d, length(g + fp - f));',
    '  }}',
    '  return d;',
    '}',
    'float bubbleMask(vec2 p){',
    '  float a = worS(p*1.45);',
    '  float b = worS(p*4.30 + 31.7);',
    '  return clamp(0.62*smoothstep(0.66, 0.10, a) + 0.38*smoothstep(0.56, 0.06, b), 0.0, 1.0);',
    '}'
  ].join('\n');

  /* Preetham analytic sky. Exposed so other modules can compile the identical
     function; if SAIL.sky already publishes one, we prefer theirs. */
  var GLSL_SKY = [
    'uniform float uTurb, uSkyScale;',
    'uniform vec3 uSkyFloor;',
    'float perezF(float A,float B,float C,float D,float E,float ct,float g){',
    '  return (1.0 + A*exp(B/max(ct,0.012))) * (1.0 + C*exp(D*g) + E*cos(g)*cos(g));',
    '}',
    'vec3 skyRadiance(vec3 dir, vec3 sunDir){',
    '  float T = uTurb;',
    '  float ct = max(dir.y, 0.012);',
    '  float ts = acos(clamp(sunDir.y, 0.0, 1.0));',
    '  float g  = acos(clamp(dot(normalize(dir), sunDir), -1.0, 1.0));',
    '  float AY= 0.1787*T-1.4630, BY=-0.3554*T+0.4275, CY=-0.0227*T+5.3251, DY=0.1206*T-2.5771, EY=-0.0670*T+0.3703;',
    '  float Ax=-0.0193*T-0.2592, Bx=-0.0665*T+0.0008, Cx=-0.0004*T+0.2125, Dx=-0.0641*T-0.8989, Ex=-0.0033*T+0.0452;',
    '  float Ay=-0.0167*T-0.2608, By=-0.0950*T+0.0092, Cy=-0.0079*T+0.2102, Dy=-0.0441*T-1.6537, Ey=-0.0109*T+0.0529;',
    '  float chi = (0.44444444 - T/120.0)*(3.14159265 - 2.0*ts);',
    '  float Yz = (4.0453*T - 4.9710)*tan(min(chi,1.5)) - 0.2155*T + 2.4192;',
    '  float t2=ts*ts, t3=t2*ts, T2=T*T;',
    '  float xz = ( 0.00166*t3 -0.00375*t2 +0.00209*ts)*T2 + (-0.02903*t3 +0.06377*t2 -0.03202*ts +0.00394)*T + ( 0.11693*t3 -0.21196*t2 +0.06052*ts +0.25886);',
    '  float yz = ( 0.00275*t3 -0.00610*t2 +0.00317*ts)*T2 + (-0.04214*t3 +0.08970*t2 -0.04153*ts +0.00516)*T + ( 0.15346*t3 -0.26756*t2 +0.06670*ts +0.26688);',
    '  float Y = max(Yz,0.0) * perezF(AY,BY,CY,DY,EY, ct, g) / perezF(AY,BY,CY,DY,EY, 1.0, ts);',
    '  float x = xz * perezF(Ax,Bx,Cx,Dx,Ex, ct, g) / perezF(Ax,Bx,Cx,Dx,Ex, 1.0, ts);',
    '  float y = max(yz * perezF(Ay,By,Cy,Dy,Ey, ct, g) / perezF(Ay,By,Cy,Dy,Ey, 1.0, ts), 0.02);',
    // Preetham puts the hazy horizon ~0.012 BELOW the CIE daylight locus, which
    // renders as a magenta/brown band. Pull y most of the way back onto the
    // locus: the zenith is already on it, so the blue is untouched.
    '  float xc = clamp(x, 0.24, 0.40);',
    '  float yD = 2.870*xc - 3.000*xc*xc - 0.275;',
    '  y = mix(y, yD, 0.80);',
    '  Y = max(Y, 0.0);',
    '  float X = x*Y/y, Z = (1.0-x-y)*Y/y;',
    '  vec3 rgb = vec3( 3.2406*X -1.5372*Y -0.4986*Z,',
    '                  -0.9689*X +1.8758*Y +0.0415*Z,',
    '                   0.0557*X -0.2040*Y +1.0570*Z);',
    '  rgb = max(rgb, vec3(0.0)) * uSkyScale;',
    '  return rgb + uSkyFloor*(0.35 + 0.65*ct);',
    '}'
  ].join('\n');
  O.skyRadianceGLSL = GLSL_SKY;

  /* The sky module publishes the real thing: a Bruneton sky-view LUT plus
     cloud LUT plus aerial perspective, the SAME radiance field the dome is
     drawn from. Reflecting anything else is what produces a luminance cliff at
     the horizon, because a mirror at grazing incidence must return exactly the
     sky above it. Prefer it whenever it is present; the analytic Preetham
     below is only a fail-soft fallback and is wrapped to the same interface. */
  var skyIsModule = false;
  function skyBlock() {
    var s = SAIL.sky && (SAIL.sky.glsl || SAIL.sky.skyGLSL);
    if (typeof s === 'string' && s.indexOf('skyRadianceNoSun') >= 0 &&
        s.indexOf('sailAerialTransmittance') >= 0 && typeof SAIL.sky.register === 'function') {
      skyIsModule = true;
      return s;
    }
    skyIsModule = false;
    return GLSL_SKY + '\n' + [
      'vec3 skyRadianceNoSun(vec3 d, vec3 s){ return skyRadiance(d,s); }',
      'vec3 sailAerialTransmittance(vec3 wp, vec3 cp){',
      '  return exp(-vec3(0.85,1.30,2.05)*1.05e-4*length(wp-cp)); }'
    ].join('\n');
  }

  /* ---- detail-normal octave set -----------------------------------------
     Six mutually irrational tile sizes rotated by non-commensurate angles, so
     the composite repeat period is far beyond the visible range and no corduroy
     weave can form. Columns:
     scale (1/m)   relative amplitude   rotation (rad)   drift (m/s)   bubble weight

     The amplitude ladder is deliberately FLAT rather than red. A red ladder puts
     most of the slope energy in the 24 m octave, and since the whole ladder
     drifts downwind together that octave paints long parallel filaments across
     the sky reflection - the "marbled paper" look. Equal-ish weights with a
     sixth sub-metre octave put the energy where a real capillary/short-gravity
     tail has it, which reads as granular texture and gives the near field
     something to be made of. */
  /* Two NEW octaves at the top (72 m and 42 m tiles => 9.0 m and 5.3 m features).
     The old ladder's largest feature was 3.0 m and the shortest displaced
     Gerstner was 3.6 m: one octave of overlap and then nothing between 3.6 and
     15 m except corduroy. These close that hole, and they are also the source
     of the mid-band slope that P2 re-injects where the mesh LOD has faded the
     wind sea out.  Columns:
     scale (1/m)  rel amp  rotation (rad)  drift (m/s)  bubble weight  mid-band */
  /* Two further tiers at the BOTTOM (1.05 cm and 5.1 mm features): capillary
     ripple riding on the chop. They only survive inside about four metres of the
     lens, which is exactly the band the review measured as the blurriest thing
     on screen. Without them the near field has no structure smaller than 2 cm
     and reads as matte vinyl. */
  /* THE MARBLE, root cause.  The three coarsest rows below carry features of
     9.0 / 5.3 / 3.0 m, and they used to run at weights 0.28 / 0.30 / 0.32 —
     between them a THIRD of the whole slope variance, in a band whose features
     are metres across, drifting downwind as one coherent field. That is not a
     micro-normal, it is a painted flowmap: rendering |slope| showed a marbled
     S-hook filament pattern at identical apparent scale from 5 m to the horizon
     (they are the only octaves whose Nyquist gate never closes), and running it
     through the Fresnel/sky path turned it into the white "foam" sheets the
     review counted at 40-50% of frame.
     The 3-9 m band is GEOMETRY — the mesh already displaces wind sea down to
     2.1 m — so these rows are demoted to almost nothing for direct slope and
     kept only as the mid-band carrier the LOD re-injection needs at range
     (column 6). The variance they gave up is moved to the 4 cm - 40 cm end,
     where it belongs: that is the band a real capillary/short-gravity tail
     lives in, it is what sun glitter is made of, and it foreshortens correctly
     because its own Nyquist gate closes within a few tens of metres. */
  var DET = [
    [0.013900, 0.07,  0.470, 1.20, 0.00, 1],
    [0.023600, 0.10, -0.810, 1.02, 0.00, 1],
    [0.041700, 0.15,  0.000, 0.85, 0.00, 0],
    [0.112300, 0.26,  0.630, 0.66, 0.14, 0],
    [0.297100, 0.38, -1.240, 0.50, 0.26, 0],
    [0.831700, 0.46,  0.330, 0.34, 0.30, 0],
    [2.113000, 0.46, -1.970, 0.20, 0.20, 0],
    [5.470000, 0.38,  0.910, 0.11, 0.10, 0],
    [11.90000, 0.28, -0.355, 0.07, 0.06, 0],
    [24.50000, 0.18,  1.830, 0.04, 0.03, 0]
  ];
  /* Every octave now carries an EXPLICIT Nyquist gate against the anisotropic
     pixel footprint, and the amplitude the gate removes is added to varLost so
     it comes back as BRDF roughness (Toksvig/LEAN) instead of vanishing. That
     is the whole of the distance-attenuation fix: the hardware mip chain alone
     cannot do it, because at a 2.5 m eye and 500 m the footprint is 200:1
     anisotropic and the driver picks its mip from the LONG axis.
     The LOD bias `lb` pre-blurs each octave over the last stop before it dies,
     so the fade is a defocus rather than a dissolve. */
  /* Takes an explicit INDEX LIST, not a count. Now that the ladder's energy sits
     at the fine end, taking the first five rows for the 'low' path would hand it
     the three near-silent coarse rows and a quarter of the slope variance — a
     glassy sea on the exact machines that can least afford extra terms to
     compensate. The low list is a decimation ACROSS the ladder instead: one
     mid-band carrier so the far field still gets its re-injection, then the four
     rows that carry the bulk of the variance. */
  function detailOctavesGLSL(list) {
    var out = [], bw = 0, i, k, nMid = 0;
    for (k = 0; k < list.length; k++) { bw += DET[list[k]][4]; if (DET[list[k]][5]) nMid++; }
    var kb = bw > 1e-4 ? 1 / bw : 0;
    var km = nMid > 0 ? 1 / Math.sqrt(nMid) : 0;
    for (k = 0; k < list.length; k++) {
      i = list[k];
      var d = DET[i], c = Math.cos(d[2]).toFixed(6), s = Math.sin(d[2]).toFixed(6);
      var feat = (0.125 / d[0]);                       // largest feature, metres
      out.push(
        '  { vec2 q = pw + wd*(' + d[3].toFixed(3) + '*uTime);',
        '    vec2 uv = vec2(q.x*' + c + ' - q.y*' + s + ', q.x*' + s + ' + q.y*' + c + ')*' + d[0].toFixed(6) + ';',
        /* THE DETAIL-ENERGY INVERSION.  The old gate held an octave at full
           amplitude down to 0.55 samples per feature — i.e. well past Nyquist —
           so the far field carried unfilterable high-frequency slope while the
           near field, where every octave is comfortably resolved, had nothing
           finer than 2 cm to show. Requiring 0.90 samples to start fading and
           2.30 to be fully present pushes each octave out a full stop earlier;
           everything the gate removes is accumulated in varLost and returns as
           BRDF roughness, so no energy is lost, it is only band-limited.
           The LOD bias pre-blurs over the last stop so the fade is a defocus. */
        '    float ow = smoothstep(0.90, 2.30, ' + feat.toFixed(4) + '/(2.0*fpe));',
        '    vec4 td = texture2D(uDetailTex, uv, 2.2*(1.0-ow));',
        '    vec2 sl = (td.rg*2.0-1.0)*uDetNorm;',
        '    float ss = td.b*2.0*uDetNorm*uDetNorm;',
        '    slope += ' + d[1].toFixed(3) + '*ow*sl;',
        /* THE SKY SET.  Only octaves whose features are at least ~12 cm are
           allowed to perturb the normal the SKY is reflected off. Everything
           finer — the capillary/short-gravity tail — is below a pixel almost
           everywhere in frame, and reflecting a broken cumulus deck off a
           sub-pixel normal is point-sampling a step function: each pixel comes
           back independently white or blue. That, and not the foam, is the
           granular white-on-blue crust. The fine octaves keep their full
           amplitude in the SUN normal, where a heavy tail is exactly what
           glitter is made of, and their variance is handed to the sky lobe as
           BRDF roughness instead of as geometry. */
        (feat >= 0.12 ? '    slopeLo += ' + d[1].toFixed(3) + '*ow*sl;\n' +
                        '    owLoE += ' + (d[1] * d[1]).toFixed(5) + '*ow*ow;' : ''),
        '    varLost += ' + (d[1] * d[1]).toFixed(5) + '*(ow*ow*max(ss - dot(sl,sl), 0.0)',
        '                 + (1.0 - ow*ow)*ss);',
        /* The EXPECTED moments, carrying no per-texel term at all. `ss` and
           `dot(sl,sl)` are samples of a field whose mean is 1 by construction
           (uDetNorm normalises it), so the expectation of each octave's
           contribution is just its weight against the Nyquist gate. These are
           what the sky lobe's roughness must be built from — see the note by
           alphaB. */
        '    owE  += ' + (d[1] * d[1]).toFixed(5) + '*ow*ow;',
        '    varE += ' + (d[1] * d[1]).toFixed(5) + '*(1.0 - ow*ow);',
        (d[5] ? '    midSlope += ' + (km).toFixed(4) + '*ow*sl;' : ''),
        '    bub += ' + (d[4] * kb).toFixed(4) + '*td.a; }');
    }
    return out.join('\n');
  }

  /* JS mirror of the Perez luminance, used to normalise uSkyScale so that the
     analytic sky integrates to exactly SAIL.env.skyE over the hemisphere. */
  function perezY(T, ct, g, ts) {
    var A = 0.1787 * T - 1.4630, B = -0.3554 * T + 0.4275, C = -0.0227 * T + 5.3251;
    var D = 0.1206 * T - 2.5771, E = -0.0670 * T + 0.3703;
    var f = function (c, gg) { return (1 + A * Math.exp(B / Math.max(c, 0.012))) * (1 + C * Math.exp(D * gg) + E * Math.cos(gg) * Math.cos(gg)); };
    var chi = (0.44444444 - T / 120) * (Math.PI - 2 * ts);
    var Yz = (4.0453 * T - 4.9710) * Math.tan(Math.min(chi, 1.5)) - 0.2155 * T + 2.4192;
    return Math.max(0, Yz) * f(ct, g) / f(1.0, ts);
  }
  function skyIrradiance(T, sunY) {
    var ts = Math.acos(clamp(sunY, 0, 1));
    var sx = Math.sqrt(Math.max(0, 1 - sunY * sunY));
    var E = 0, NT = 12, NP = 24;
    for (var a = 0; a < NT; a++) {
      var th = (a + 0.5) / NT * (Math.PI / 2), ct = Math.cos(th), st = Math.sin(th);
      for (var b = 0; b < NP; b++) {
        var ph = (b + 0.5) / NP * Math.PI * 2;
        var dx = st * Math.cos(ph), dy = ct, dz = st * Math.sin(ph);
        var cg = clamp(dx * sx + dy * sunY, -1, 1);
        E += perezY(T, ct, Math.acos(cg), ts) * ct * st;
      }
    }
    return E * (Math.PI / 2 / NT) * (Math.PI * 2 / NP);
  }

  /* =======================================================================
     5.  GEOMETRY  —  camera-centred geometric radial disc
     ======================================================================= */
  /* Radii are NOT a pure geometric series. A pure series reaches 70 m ring
     spacing by 2 km, which (at 2.05 samples per wavelength) fades out every
     component including the 136 m swell — so the last 6 km of sea is a dead
     flat plane and the skyline is a ruler-straight seam with nothing to break
     it. Cap the radial step at ~38 m out to 4.5 km instead: the swell then
     survives to the true horizon and crests physically interrupt the sky. Past
     4.5 km (beyond the 5.6 km horizon for a 2.5 m eye) revert to a fast
     geometric run so the disc still closes out at 20 km for cheap. */
  /* The old law was `r += clamp(0.055*r, 0.55, 38)`, i.e. the ring pitch was a
     WORLD quantity with no reference to the screen at all. Against the Nyquist
     gate that put a component of wavelength L at 50% by r = 5.9L and at 2% by
     r = 8.9L — so a 20 m wind wave, 57 px across at 300 m, was deleted at 157 m
     and the sea became a mirror. The pitch is now the MINIMUM of
       (a) a screen-referred term, ~2.5 px per ring at a 2.5 m reference eye, and
       (b) r/26, a wavelength-referred term whose coefficient is 2.1x smaller
           than the old 0.055 — which pushes the 2% cut from 8.9L out to ~24L.
     Capped at 50 m out to 9 km (past the 5.6 km horizon for a cockpit eye and
     the 12 km one for a masthead) so the swell physically interrupts the
     skyline, then a fast geometric run to close the disc at 20 km. */
  function pitchAt(r, low) {
    var d = Math.min(1.1e-3 * 2.5 * r * r / 2.5, r / (low ? 18.0 : 26.0));
    return clamp(d, low ? 0.9 : 0.55, low ? 90.0 : 50.0);
  }
  function ringRadii(low) {
    var r = low ? 3.5 : 2.5, far = low ? 7000 : 9000, R = 20000;
    var out = [r];
    while (r < far) { r += pitchAt(r, low); out.push(r); }
    while (r < R) { r *= 1.34; out.push(Math.min(r, R)); }
    return out;
  }

  function buildGeometry(low) {
    /* 288 rather than 384: the angular pitch 2*pi*r/288 = r/45.8 is still finer
       than the radial r/26 everywhere, so the Nyquist gate is set by the radial
       law and nothing is lost — while the ~50% higher ring count pays for
       itself. */
    var NA = low ? 144 : 288;
    var RAD = ringRadii(low), NR = RAD.length - 1;
    var nv = NA * (NR + 1) + 1;
    var pos = new Float32Array(nv * 3), meta = new Float32Array(nv * 2);
    pos[0] = 0; pos[1] = 0; pos[2] = 0;
    meta[0] = 2 * Math.PI * RAD[0] / NA; meta[1] = 0;
    var v = 1, j, i;
    for (j = 0; j <= NR; j++) {
      var r = RAD[j];
      /* THE LOD RING SEAM. This used to be `max(max(r-rp, rn-r), 2*pi*r/NA)` —
         a per-ring quantity with a kink at every boundary, so the Nyquist gate
         stepped ~5.5% at each ring and the displacement had a C1 break all the
         way round, on a camera-centred mesh sliding over a world-locked wave
         field. That is exactly the swimming concentric arc the review saw.
         Writing the ANALYTIC law into the attribute instead makes neighbouring
         rings differ smoothly, and the gate becomes continuous. */
      var sp = Math.max(pitchAt(r, low), 2 * Math.PI * r / NA);
      var rim = j >= NR - 2 ? clamp((j - (NR - 3)) / 3, 0, 1) : 0;
      for (i = 0; i < NA; i++) {
        var ang = i / NA * Math.PI * 2;
        pos[v * 3] = Math.cos(ang) * r; pos[v * 3 + 1] = 0; pos[v * 3 + 2] = Math.sin(ang) * r;
        meta[v * 2] = sp; meta[v * 2 + 1] = rim;
        v++;
      }
    }
    var nTri = NA * NR * 2 + NA;
    var idx = new Uint32Array(nTri * 3), k = 0;
    for (i = 0; i < NA; i++) { idx[k++] = 0; idx[k++] = 1 + ((i + 1) % NA); idx[k++] = 1 + i; }
    for (j = 0; j < NR; j++) {
      var b0 = 1 + j * NA, b1 = b0 + NA;
      for (i = 0; i < NA; i++) {
        var i2 = (i + 1) % NA;
        var a = b0 + i, b = b0 + i2, c = b1 + i2, d = b1 + i;
        idx[k++] = a; idx[k++] = b; idx[k++] = c;
        idx[k++] = a; idx[k++] = c; idx[k++] = d;
      }
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aMeta', new THREE.BufferAttribute(meta, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    var RM = RAD[NR];
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), RM * 1.4);
    geo.boundingBox = new THREE.Box3(new THREE.Vector3(-RM, -60, -RM), new THREE.Vector3(RM, 60, RM));
    return geo;
  }

  /* =======================================================================
     6.  PROCEDURAL TEXTURES  (detail normal map + gust field)
     ======================================================================= */
  var quadGeo = null, quadCam = null, quadScene = null, quadMesh = null;
  function quad(renderer, mat, target, w, h) {
    if (!quadGeo) {
      quadGeo = new THREE.BufferGeometry();
      quadGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
      quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      quadMesh = new THREE.Mesh(quadGeo, mat);
      quadMesh.frustumCulled = false;
      quadScene = new THREE.Scene();
      quadScene.add(quadMesh);
    }
    quadMesh.material = mat;
    var prev = renderer.getRenderTarget();
    renderer.setRenderTarget(target);
    renderer.render(quadScene, quadCam);
    renderer.setRenderTarget(prev);
  }

  /* LEAN slope map.  RG = mean slope, B = mean(|slope|^2), A = bubble mask.
     Storing the second moment lets the fragment shader recover the slope
     VARIANCE the mip chain filtered away and feed it to the BRDF as roughness
     (LEAN / Toksvig).  That is what turns distant chop into a wider glitter
     lobe instead of a flickering high-frequency normal, which is the only
     correct cure for the moire.  Averaging slopes under a mip is linear and
     therefore exact; averaging packed normals is neither. */
  function buildDetailTex(renderer) {
    var N = 512;
    var rt = new THREE.WebGLRenderTarget(N, N, {
      type: THREE.UnsignedByteType, format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false
    });
    rt.texture.colorSpace = THREE.LinearSRGBColorSpace;
    var mat = new THREE.ShaderMaterial({
      depthTest: false, depthWrite: false, toneMapped: false, blending: THREE.NoBlending,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = position.xy*0.5+0.5; gl_Position = vec4(position.xy,0.0,1.0); }',
      fragmentShader: [
        'precision highp float;',
        'varying vec2 vUv;',
        'vec2 h22(vec2 p){ p = vec2(dot(p,vec2(127.1,311.7)), dot(p,vec2(269.5,183.3)));',
        '  return fract(sin(p)*43758.5453)*2.0-1.0; }',
        'float gn(vec2 p, float per){',
        '  vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f);',
        '  vec2 a=mod(i,per), b=mod(i+vec2(1.0,0.0),per), c=mod(i+vec2(0.0,1.0),per), d=mod(i+vec2(1.0,1.0),per);',
        '  return mix(mix(dot(h22(a),f), dot(h22(b),f-vec2(1.0,0.0)),u.x),',
        '             mix(dot(h22(c),f-vec2(0.0,1.0)), dot(h22(d),f-vec2(1.0,1.0)),u.x), u.y);',
        '}',
        /* BAND-LIMIT THE TILE.  This used to be five octaves running per = 8
           to 128, i.e. a full decade and a half of slope energy inside ONE
           entry of the DET ladder. Two things follow and both were visible:
             (a) the Nyquist gate in the fragment stage is computed from the
                 octave's NOMINAL feature size (tile/8), so the four octaves
                 living below that size sailed straight past the gate and kept
                 injecting slope the pixel could not resolve — the crawling
                 speckle and the specular aliasing;
             (b) a deep fbm's gradient field IS marble. Ridge filaments are what
                 the derivative of an fbm looks like, and stamping ten rotated
                 copies of it over the sea is what produced the S-hook motif.
           Three octaves with a 0.28 amplitude falloff put ~60% of the slope
           variance in the base band and leave the tile genuinely narrow-band,
           so each DET row is one cascade step and the ten of them, at mutually
           irrational scales and rotations, compose the broadband field instead
           of each one being broadband on its own. */
        /* NON-HARMONIC periods, which matters more than it looks. gn() is made
           tileable by folding the lattice index with mod(i, per), so a base
           octave at per = 8 has exactly sixty-four distinct gradient vectors in
           the whole tile and repeats its motif every eighth of it. That was
           invisible while five harmonic octaves ran on top of it, because the
           fine ones carried nearly all the gradient; band-limit the tile and the
           lattice becomes the dominant signal — the "same S-hook motif
           identifiable several times per frame".
           7 / 11 / 17 / 27 are mutually non-harmonic, so the composite's own
           period is the whole tile, and the amplitude ladder keeps the slope
           spectrum inside about one and a half octaves around the base. Each
           DET row is then genuinely one cascade step, its Nyquist gate is
           honest, and the ten rows compose the broadband field between them. */
        'float H(vec2 uv){',
        '  float h = gn(uv*7.0, 7.0)',
        '          + 0.45*gn(uv*11.0, 11.0)',
        '          + 0.18*gn(uv*17.0, 17.0)',
        '          + 0.06*gn(uv*27.0, 27.0);',
        '  return h*(1.0/1.69);',
        '}',
        // bubble / breakup field: ridged noise, decorrelated from the slopes so
        // whitecap granularity does not line up with the ripple crests
        'float B(vec2 uv){',
        '  float h=0.0, a=1.0, per=16.0, nrm=0.0;',
        '  for(int o=0;o<4;o++){ h += a*abs(gn(uv*per + 3.71, per)); nrm += a; a *= 0.55; per *= 2.0; }',
        '  return h/nrm;',
        '}',
        'void main(){',
        '  float e = 1.0/512.0;',
        '  float hx = H(vUv+vec2(e,0.0)) - H(vUv-vec2(e,0.0));',
        '  float hy = H(vUv+vec2(0.0,e)) - H(vUv-vec2(0.0,e));',
        // Raw slopes at a generous fixed gain; the true RMS is measured on
        // readback and published as uDetNorm, so nothing here needs calibrating
        // by eye and the second moment stays consistent with the first.
        // gain 12 clipped sx/sz against +-1 over a few percent of the tile, which
        // truncated the tail and made the B-channel second moment dishonest —
        // the Toksvig recovery then under-reported the variance it was meant to
        // convert to roughness. 8 keeps the distribution inside the range.
        /* The band-limited H above has roughly a THIRD of the gradient RMS the
           five-octave version did (measured: it took O.detNorm from 1.6 to 5.0),
           because almost all of an fbm's gradient energy sits in its finest
           octaves — which is another way of saying the old tile's slope field
           was made almost entirely of sub-feature-size detail the Nyquist gate
           was never told about. The gain rises to match, or the 8-bit slope
           channels quantise a 0.14 RMS signal into 36 levels and terrace. */
        '  float sx = clamp(-hx*28.0, -1.0, 1.0);',
        '  float sz = clamp(-hy*28.0, -1.0, 1.0);',
        '  float bub = smoothstep(0.055, 0.40, B(vUv));',
        '  gl_FragColor = vec4(sx*0.5+0.5, sz*0.5+0.5, clamp((sx*sx+sz*sz)*0.5, 0.0, 1.0), bub);',
        '}'
      ].join('\n')
    });
    quad(renderer, mat, rt);
    var buf = new Uint8Array(N * N * 4);
    O.detNorm = 1.6;
    try {
      renderer.readRenderTargetPixels(rt, 0, 0, N, N, buf);
      var acc = 0;
      for (var p = 0; p < N * N; p++) {
        var sx = buf[p * 4] / 127.5 - 1, sz = buf[p * 4 + 1] / 127.5 - 1;
        acc += sx * sx + sz * sz;
      }
      // normalise so mean(|slope|^2) == 1 across the tile; the water shader then
      // dials in the true Cox-Munk variance with a single scalar
      O.detNorm = 1 / Math.sqrt(Math.max(acc / (N * N), 1e-4));
    } catch (e) { }
    mat.dispose(); rt.dispose();
    var tex = new THREE.DataTexture(buf, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.colorSpace = THREE.LinearSRGBColorSpace;
    var maxA = renderer.capabilities.getMaxAnisotropy ? renderer.capabilities.getMaxAnisotropy() : 1;
    // full anisotropy: at a 2.5 m eye and 500 m the footprint is 200:1, and an
    // 8x cap makes the driver over-blur the across-view axis by 25x
    tex.anisotropy = Math.max(1, maxA || 1);
    tex.needsUpdate = true;
    return tex;
  }

  // shared gust field: one CPU array (SAIL.boat reads it) + one R8 texture
  var GUSTN = 256, GUST_M = 340.0;
  var gustData = null, gustTex = null;
  var gustOfs = new THREE.Vector2(0, 0);

  function buildGust() {
    gustData = new Float32Array(GUSTN * GUSTN);
    var bytes = new Uint8Array(GUSTN * GUSTN);
    var hs = function (i, j, per) {
      i = ((i % per) + per) % per; j = ((j % per) + per) % per;
      var s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return s - Math.floor(s);
    };
    var vnp = function (x, y, per) {
      var i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
      var u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
      return (hs(i, j, per) * (1 - u) + hs(i + 1, j, per) * u) * (1 - v) +
             (hs(i, j + 1, per) * (1 - u) + hs(i + 1, j + 1, per) * u) * v;
    };
    for (var j = 0; j < GUSTN; j++) for (var i = 0; i < GUSTN; i++) {
      var u = i / GUSTN, v = j / GUSTN;
      var g = 0.62 * vnp(u * 4, v * 4, 4) + 0.38 * vnp(u * 8, v * 8, 8);
      g = clamp((g - 0.5) * 1.55 + 0.5, 0, 1);
      gustData[j * GUSTN + i] = g;
      bytes[j * GUSTN + i] = Math.round(g * 255);
    }
    gustTex = new THREE.DataTexture(bytes, GUSTN, GUSTN, THREE.RedFormat, THREE.UnsignedByteType);
    gustTex.wrapS = gustTex.wrapT = THREE.RepeatWrapping;
    gustTex.minFilter = gustTex.magFilter = THREE.LinearFilter;
    gustTex.generateMipmaps = false;
    gustTex.colorSpace = THREE.LinearSRGBColorSpace;
    gustTex.needsUpdate = true;
  }
  O.gustField = function () { return { data: gustData, n: GUSTN, metres: GUST_M, ofs: gustOfs }; };
  O.gustAt = function (x, z) {
    if (!gustData) return 1;
    var u = ((x - gustOfs.x) / GUST_M) * GUSTN, v = ((z - gustOfs.y) / GUST_M) * GUSTN;
    var i = Math.floor(u), j = Math.floor(v), tx = u - i, tz = v - j;
    var w = function (a, b) { return gustData[(((b % GUSTN) + GUSTN) % GUSTN) * GUSTN + (((a % GUSTN) + GUSTN) % GUSTN)]; };
    var g = (w(i, j) * (1 - tx) + w(i + 1, j) * tx) * (1 - tz) + (w(i, j + 1) * (1 - tx) + w(i + 1, j + 1) * tx) * tz;
    var amp = 0.22 * (SAIL.env && SAIL.env.gustFactor ? clamp(SAIL.env.gustFactor, 0, 2) : 1);
    return 1 + (g - 0.5) * 2 * amp;
  };

  /* =======================================================================
     7.  WAKE / FOAM BUFFER  —  boat-following, advected, decaying
     ======================================================================= */
  /* This used to be a pair of 2D canvases advected by re-blitting onto
     themselves with globalAlpha = exp(-dt/7.5). At 60 Hz that factor is
     0.99778, so the per-texel decrement is v*0.00222 — BELOW the 0.5 that 8-bit
     canvas rounding can represent, for every value under 225. The buffer
     therefore never decayed: the only thing still changing it was the
     fractional-offset drawImage, i.e. a bilinear box blur applied sixty times a
     second. Mass was conserved into a permanent spreading grey haze — the "oil
     slick". A float render target has no rounding floor, so exp(-dt/tau)
     actually reaches zero; and moving the whole thing onto the GPU also deletes
     a 512^2 canvas rasterise plus a 1 MB texImage2D every frame.
     R = foam density, G = age (seconds since deposit, normalised). */
  var WK = null;
  var wakeAdvMat = null, wakeDepMat = null, wakeDepGeo = null, wakeDepPts = null, wakeDepScene = null;
  var WK_MAXDEP = 512;

  function buildWake(low) {
    var N = low ? 256 : 512, R = low ? 170 : 230;
    // O.rebuild() calls this again on a quality change; do not leak the old pair
    if (WK) { if (WK.a) WK.a.dispose(); if (WK.b) WK.b.dispose(); if (WK.fallback) WK.fallback.dispose(); }
    WK = { N: N, R: R, cx: 0, cz: 0, pend: [], a: null, b: null, ok: false, fallback: null };
    // a bound-but-empty sampler is undefined behaviour; keep a 1x1 black around
    WK.fallback = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1,
                                        THREE.RGBAFormat, THREE.UnsignedByteType);
    WK.fallback.needsUpdate = true;
    if (!renderer) return;
    try {
      var opt = {
        type: THREE.HalfFloatType, format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
        depthBuffer: false, stencilBuffer: false, generateMipmaps: false
      };
      WK.a = new THREE.WebGLRenderTarget(N, N, opt);
      WK.b = new THREE.WebGLRenderTarget(N, N, opt);
      WK.a.texture.wrapS = WK.a.texture.wrapT = THREE.ClampToEdgeWrapping;
      WK.b.texture.wrapS = WK.b.texture.wrapT = THREE.ClampToEdgeWrapping;
      WK.a.texture.colorSpace = WK.b.texture.colorSpace = THREE.LinearSRGBColorSpace;

      if (!wakeAdvMat) {
        wakeAdvMat = new THREE.ShaderMaterial({
          depthTest: false, depthWrite: false, toneMapped: false, blending: THREE.NoBlending,
          uniforms: {
            uSrc: { value: null }, uOfs: { value: new THREE.Vector2() },
            uDecay: { value: 0.99 }, uSub: { value: 0.0 }, uTexel: { value: 1 / 512 }
          },
          vertexShader: 'varying vec2 vUv; void main(){ vUv = position.xy*0.5+0.5; gl_Position = vec4(position.xy,0.0,1.0); }',
          fragmentShader: [
            'precision highp float;',
            'varying vec2 vUv;',
            'uniform sampler2D uSrc; uniform vec2 uOfs;',
            'uniform float uDecay, uSub, uTexel;',
            'vec4 tap(vec2 uv){',
            '  if (uv.x<=0.0||uv.x>=1.0||uv.y<=0.0||uv.y>=1.0) return vec4(0.0);',
            '  return texture2D(uSrc, uv);',
            '}',
            'void main(){',
            '  vec2 uv = vUv + uOfs;',
            // a deliberately SMALL 5-tap spread: a foam raft does spread as it
            // ages, but the old path spread it every frame at full weight, which
            // is what turned structure into haze
            '  vec4 c = tap(uv)*0.72',
            '        + (tap(uv+vec2(uTexel,0.0)) + tap(uv-vec2(uTexel,0.0))',
            '         + tap(uv+vec2(0.0,uTexel)) + tap(uv-vec2(0.0,uTexel)))*0.07;',
            '  float f = max(c.r*uDecay - uSub, 0.0);',
            '  float age = (f > 1e-4) ? min(c.g + uSub*6.0, 1.0) : 0.0;',
            '  gl_FragColor = vec4(f, age, 0.0, 1.0);',
            '}'
          ].join('\n')
        });
      }
      if (!wakeDepGeo) {
        var pos = new Float32Array(WK_MAXDEP * 3);      // x, z, width(m)
        var str = new Float32Array(WK_MAXDEP);
        wakeDepGeo = new THREE.BufferGeometry();
        wakeDepGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        wakeDepGeo.setAttribute('aStr', new THREE.BufferAttribute(str, 1));
        wakeDepGeo.setDrawRange(0, 0);
        wakeDepMat = new THREE.ShaderMaterial({
          depthTest: false, depthWrite: false, toneMapped: false,
          blending: THREE.AdditiveBlending, transparent: true,
          uniforms: { uC: { value: new THREE.Vector2() }, uR: { value: 200 }, uN: { value: 512 } },
          vertexShader: [
            'attribute float aStr;',
            'uniform vec2 uC; uniform float uR, uN;',
            'varying float vStr;',
            'void main(){',
            '  vec2 uv = (position.xy - uC)/(2.0*uR) + 0.5;',
            '  gl_Position = vec4(uv*2.0-1.0, 0.0, 1.0);',
            '  gl_PointSize = clamp(position.z/(2.0*uR)*uN*2.0, 2.0, 60.0);',
            '  vStr = aStr;',
            '}'
          ].join('\n'),
          fragmentShader: [
            'precision highp float;',
            'varying float vStr;',
            'void main(){',
            '  float d = length(gl_PointCoord - 0.5)*2.0;',
            '  float w = smoothstep(1.0, 0.05, d); w *= w;',
            '  gl_FragColor = vec4(vStr*w, 0.0, 0.0, 1.0);',
            '}'
          ].join('\n')
        });
        wakeDepPts = new THREE.Points(wakeDepGeo, wakeDepMat);
        wakeDepPts.frustumCulled = false;
        wakeDepScene = new THREE.Scene();
        wakeDepScene.add(wakeDepPts);
      }
      wakeAdvMat.uniforms.uTexel.value = 1 / N;
      wakeDepMat.uniforms.uN.value = N;
      wakeDepMat.uniforms.uR.value = R;
      // clear both
      var prev = renderer.getRenderTarget();
      renderer.setRenderTarget(WK.a); renderer.clear(true, false, false);
      renderer.setRenderTarget(WK.b); renderer.clear(true, false, false);
      renderer.setRenderTarget(prev);
      WK.ok = true;
    } catch (e) {
      WK.ok = false;
      if (window.console) console.warn('[SAIL.ocean] wake target unavailable:', e);
    }
  }

  O.addWake = function (x, z, strength, width) {
    if (!WK) return;
    if (WK.pend.length > WK_MAXDEP * 4) return;
    /* Deposits ACCUMULATE additively into a float target with a 9 s decay, so
       the per-deposit weight has to be budgeted, not guessed. A texel on the
       track is inside a ~3 m deposit disc for roughly 2 s at cruising speed,
       i.e. ~50 hits at the 24-30 Hz feed rate; 0.022 each puts the steady-state
       raft just under 1.0. The old canvas silently did this for us by
       saturating at 8-bit 255. */
    WK.pend.push(x, z, clamp((strength || 0.4) * 0.022, 0, 0.20), Math.max(0.4, width || 1.5));
  };

  var wakeFocus = new THREE.Vector2(0, 0), wakeFocusSet = false;
  O.setFocus = function (x, z) { wakeFocus.set(x, z); wakeFocusSet = true; };

  /* Deposit the wake's OWN structure: the two Kelvin cusp lines and the transom
     churn, world-locked. The old feed put four isotropic blobs on the track,
     which at 0.78 m/texel merged into one 6 m sausage that was 6 m wide at the
     transom and still 6 m wide 150 m later. Cusp deposits give the trail the
     19.47 deg divergence it is supposed to have, for free. */
  var cuspAcc = 0;
  function feedCusp(dt) {
    var B = SAIL.boat;
    if (!WK || !B || !(B.x === B.x) || !(B.z === B.z)) return;
    var V = Math.hypot(B.u || 0, B.v || 0);
    if (V < 0.6) return;
    cuspAcc += dt;
    if (cuspAcc < 1 / 24) return;
    var rate = cuspAcc; cuspAcc = 0;
    var h = B.heading || 0, fx = Math.sin(h), fz = -Math.cos(h);
    var sx = -fz, sz = fx;                                  // starboard unit
    var sp = clamp(V / 5.0, 0, 1);
    var wash = B.thrust ? clamp((Math.abs(B.thrust[0]) + Math.abs(B.thrust[1])) / 6000, 0, 1) : 0;
    var g = rate * 24;
    var A = [6, 13, 22];
    for (var q = 0; q < A.length; q++) {
      var a = A[q], b = 0.35355 * a + 2.6;
      var dec = 1 / (1 + a * 0.05);
      for (var s = -1; s <= 1; s += 2) {
        var wx = B.x - fx * a + sx * b * s, wz = B.z - fz * a + sz * b * s;
        O.addWake(wx, wz, sp * 0.85 * dec * g, 1.5 + 0.05 * a);
      }
    }
    // transom churn, both hulls
    for (var t2 = -1; t2 <= 1; t2 += 2) {
      var tx = B.x - fx * 8.4 + sx * 3.005 * t2, tz = B.z - fz * 8.4 + sz * 3.005 * t2;
      O.addWake(tx, tz, (0.55 * sp + 0.60 * wash) * g, 2.8);
    }
  }

  function stepWake(dt, camX, camZ, windX, windZ) {
    if (!WK || !WK.ok || !renderer) { if (WK) WK.pend.length = 0; return; }
    var N = WK.N, R = WK.R;
    var fx = wakeFocusSet ? wakeFocus.x : camX, fz = wakeFocusSet ? wakeFocus.y : camZ;
    // surface drift: current + ~2.5% of the wind
    var cur = SAIL.env || {};
    var dvx = (cur.curX || 0) + windX * 0.025, dvz = (cur.curZ || 0) + windZ * 0.025;
    var ox = (WK.cx - fx + dvx * dt) / (2 * R);
    var oz = (WK.cz - fz + dvz * dt) / (2 * R);
    WK.cx = fx; WK.cz = fz;

    var prev = renderer.getRenderTarget();
    var pAC = renderer.autoClear;
    // ---- advect + decay (writes every texel, so no clear needed)
    wakeAdvMat.uniforms.uSrc.value = WK.a.texture;
    wakeAdvMat.uniforms.uOfs.value.set(-ox, -oz);
    wakeAdvMat.uniforms.uDecay.value = Math.exp(-dt / 9.0);
    wakeAdvMat.uniforms.uSub.value = dt * 0.010;
    renderer.autoClear = false;
    quad(renderer, wakeAdvMat, WK.b);

    // ---- deposits
    var P = WK.pend, nd = 0;
    if (P.length) {
      var pa = wakeDepGeo.attributes.position, sa = wakeDepGeo.attributes.aStr;
      for (var i = 0; i < P.length && nd < WK_MAXDEP; i += 4) {
        var u = (P[i] - fx) / (2 * R) + 0.5, v = (P[i + 1] - fz) / (2 * R) + 0.5;
        if (u < -0.04 || u > 1.04 || v < -0.04 || v > 1.04) continue;
        pa.array[nd * 3] = P[i]; pa.array[nd * 3 + 1] = P[i + 1]; pa.array[nd * 3 + 2] = P[i + 3];
        sa.array[nd] = P[i + 2];
        nd++;
      }
      P.length = 0;
      if (nd > 0) {
        pa.needsUpdate = true; sa.needsUpdate = true;
        wakeDepGeo.setDrawRange(0, nd);
        wakeDepMat.uniforms.uC.value.set(fx, fz);
        wakeDepMat.uniforms.uR.value = R;
        renderer.setRenderTarget(WK.b);
        renderer.render(wakeDepScene, quadCam);
      }
    }
    renderer.setRenderTarget(prev);
    renderer.autoClear = pAC;

    var tmp = WK.a; WK.a = WK.b; WK.b = tmp;
    if (O.material) {
      O.material.uniforms.uWakeTex.value = WK.a.texture;
      O.material.uniforms.uWakeC.value.set(fx, fz);
      O.material.uniforms.uWakeR.value = R;
    }
  }

  /* =======================================================================
     8.  WATER SHADERS
     ======================================================================= */
  function vertexShader() {
    return [
      'precision highp float;',
      'attribute vec2 aMeta;',
      'uniform float uTime, uShadowOn, uHs;',
      'uniform vec3 uSunDir;',
      'uniform vec2 uDrift;',
      'varying vec3 vWorld; varying vec3 vN;',
      'varying vec4 vP0;',   // J(t), J(t-1.5s), J(t-3.2s), depth
      'varying vec4 vP1;',   // shelter, spacing, rim, swash
      'varying vec4 vP2;',   // viewZ, lost, land, shadow
      'varying vec4 vP3;',   // laplacian, dJ/dt, 0, 0
      GLSL_COMMON,
      GLSL_SEABED,
      GLSL_GERSTNER,
      'void main(){',
      '  vec4 wp = modelMatrix * vec4(position, 1.0);',
      '  vec3 sb = seabed(wp.xz);',
      '  vec3 disp, nrm; vec4 jac; float swash, lost;',
      '  oceanEval(wp.xz, uTime, sb.x, sb.y, aMeta.x, disp, nrm, jac, swash, lost);',
      '  float rim = 1.0 - aMeta.y;',
      '  wp.xyz += disp * rim;',
      '  vWorld = wp.xyz;',
      '  vN = normalize(mix(vec3(0.0,1.0,0.0), nrm, rim));',
      // Horizon-map self-shadow: march three steps toward the sun and ask
      // whether any of them stands above the straight line to it. Without this
      // the swell has no form at all - every face is lit identically and the
      // sea reads as a bump-mapped plane rather than displaced geometry.
      /* Ring pitch is a proxy for distance (r/26 out to 9 km), and the two
         expensive extras below — the four-tap horizon march and the two lagged
         Jacobian taps — are only legible in the near field. Gating them on it
         is what pays for the ~50% denser ring set: a far vertex now runs ONE
         NDISP loop instead of seven. The gate is a smoothstep and the results
         are faded through it, so nothing steps at a ring boundary. */
      '  float near = smoothstep(8.0, 3.5, aMeta.x);',
      '  float shadow = 1.0;',
      '  if (uShadowOn > 0.5 && near > 0.003){',
      '    vec2 lxz = uSunDir.xz; float ll = length(lxz);',
      '    if (ll > 1e-3){',
      '      vec2 ld = lxz/ll;',
      '      float tanE = uSunDir.y/ll;',
      '      float Hh = max(uHs, 0.30);',
      // A crest of height h casts a shadow only h/tan(elevation) long, so the
      // march has to shorten as the sun climbs. Fixed step lengths sampled far
      // past the end of every shadow, which is why the high-sun case found no
      // occlusion at all and the swell read as embossed wallpaper.
      '      float sc = clamp(1.5/tanE, 0.22, 4.0);',
      '      float occ = 0.0;',
      '      for(int s=0;s<4;s++){',
      '        float d = Hh*sc*(0.45 + 1.25*float(s)*float(s));',
      '        float hs = oceanH(wp.xz + ld*d, uTime, sb.x, sb.y, aMeta.x);',
      '        occ = max(occ, (hs - (wp.y + d*tanE))/(0.42*Hh));',
      '      }',
      '      shadow = 1.0 - 0.85*clamp(occ, 0.0, 1.0)*rim*near;',
      '    }',
      '  }',
      // Foam is born at a breaking crest, then drifts with the surface and
      // dissolves. Sampling the fold BACKWARDS along the drift line at two
      // lifetimes gives a raft that is genuinely advected and ageing, instead of
      // the dJ/dt smear that painted continuous ribbons down every wave.
      /* FOAM LIFETIME. Three taps, not two, at 1.6 / 3.6 / 6.4 s. Each is the
         fold that existed at that earlier instant, sampled at the position that
         parcel of water has since drifted FROM — so the raft is genuinely
         advected downwind and genuinely ages. With four taps sharing the frame
         (live + three), any two frames half a second apart still share three of
         them, so the pattern no longer decorrelates in half a second: it drifts.
         The 6.4 s tap is what stops the field being "born and gone" — combined
         with the exponential opacity ladder in the fragment stage it gives an
         effective e-folding lifetime of about 4.5 s. */
      '  float J1 = 4.0, J2 = 4.0, J3 = 4.0;',
      '  if (sb.x > 0.35 && near > 0.003){',
      '    J1 = oceanJ(wp.xz - uDrift*1.6, uTime - 1.6, sb.x, sb.y, aMeta.x);',
      '    J2 = oceanJ(wp.xz - uDrift*3.6, uTime - 3.6, sb.x, sb.y, aMeta.x);',
      '    J3 = oceanJ(wp.xz - uDrift*6.4, uTime - 6.4, sb.x, sb.y, aMeta.x);',
      '  }',
      '  vP0 = vec4(jac.x, J1, J2, sb.x);',
      '  vP1 = vec4(sb.y, aMeta.x, aMeta.y, swash*rim);',
      '  vec4 mv = viewMatrix * wp;',
      '  vP2 = vec4(-mv.z, lost, sb.z, shadow);',
      '  vP3 = vec4(jac.z, jac.y, near, J3);',
      '  gl_Position = projectionMatrix * mv;',
      '}'
    ].join('\n');
  }

  function fragmentShader(low) {
    return [
      'precision highp float;',
      'uniform vec3 uCam, uSunDir, uSunCol, uAbsK, uScatK, uSSSCol;',
      'uniform float uTime, uSunE, uSkyE, uU10, uDetMss, uDetNorm, uMeshMss, uFoamHi, uFoamLo, uHs;',
      'uniform float uHasScene, uHasLinD, uWakeR, uGustInv, uCaustic, uFoamGain;',
      'uniform vec2 uRes, uWindDir, uWakeC, uGustOfs;',
      'uniform vec4 uHull0, uHull1;',
      'uniform vec4 uBoatP, uBoatQ, uBoatR;',
      'uniform mat4 uRigMat;',
      'uniform float uRigOn, uRigTexel, uRigBias, uRigStr, uCloudAmt;',
      'uniform sampler2D uRigMap;',
      'uniform sampler2D uDetailTex, uGustTex, uWakeTex, uSceneTex, uLinDTex;',
      'uniform vec3 uSkyTint;',
      'uniform vec2 uDrift;',
      /* Micro-normal response, published as one vector so the four numbers that
         set how much of the slope field reaches the sky lobe can be balanced
         together: x = grazing floor on the sky normal, y = added range as the
         surface turns to face the eye, z = how much of that normal the Fresnel
         weight sees (masking), w = prefilter cone gain. */
      'uniform vec4 uTune;',
      /* Term isolation, driven by O.setDebug(n). The water is a sum of eight
         lobes that all land in the same tonal range, and guessing which one owns
         a given artefact from a screenshot is how a fix pass burns an afternoon.
         0 = off (the shipping path), 1 = foam alpha, 2 = reflected sky x F,
         3 = transmitted body, 4 = specular, 5 = Fresnel, 6 = |micro slope|. */
      'uniform float uDebug;',
      'varying vec3 vWorld; varying vec3 vN;',
      'varying vec4 vP0; varying vec4 vP1; varying vec4 vP2; varying vec4 vP3;',
      GLSL_COMMON,
      skyBlock(),
      // h22b is the wrapped hash from GLSL_COMMON: see the precision note there.
      // The cell index is already an integer, so the wrap is exact and the only
      // consequence is a 1024-cell repeat period — 240 m at the finest bubble
      // octave, far beyond where that octave is still resolvable.
      GLSL_BUBBLE,
      // ---- Worley (2x2 search, jitter <= 0.45) for the caustic web
      'float wor(vec2 p){',
      '  vec2 i = floor(p), f = fract(p);',
      '  vec2 o0 = step(vec2(0.5), f) - vec2(1.0);',
      '  float d = 4.0;',
      '  for(int y=0;y<2;y++){ for(int x=0;x<2;x++){',
      '    vec2 g = o0 + vec2(float(x), float(y));',
      '    vec2 fp = h22b(i+g);',
      '    fp = 0.5 + 0.45*sin(uTime*0.85 + 6.2831853*fp);',
      '    d = min(d, length(g + fp - f));',
      '  }}',
      '  return d;',
      '}',
      'float causticF(vec2 p){',
      '  float w1 = wor(p*0.3125);',
      '  float w2 = wor(p*0.9091 + 17.3);',
      '  float w = min(w1, w2);',
      '  return pow(clamp(1.0-w, 0.0, 1.0), 8.0);',
      '}',
      /* Waterline contact only. This used to be the ONLY thing the boat did to
         the water — an axis-aligned 8.4 x 4.5 m ellipse standing in for a
         20 m rig, which is why the review read it as an oil slick. Now that
         rigShadow() projects the real silhouette, this is demoted to what an
         ellipse can honestly represent: the ambient occlusion right under the
         hulls, where the sky is blocked as well as the sun. */
      'float hullShadow(vec2 p){',
      '  if (uHull1.z <= 0.001) return 0.0;',
      '  vec2 d = p - uHull0.xy;',
      '  float f = d.x*uHull1.x + d.y*uHull1.y;',
      '  float s = d.x*uHull1.y - d.y*uHull1.x;',
      '  float e = length(vec2(f/max(uHull0.z,0.2), s/max(uHull0.w,0.2)));',
      '  return uHull1.z * (1.0 - smoothstep(0.10, 0.95, e));',
      '}',
      /* ---------------------------------------------------------------------
         THE RIG CASCADE, read by hand.
         The sea is a bare ShaderMaterial with lights:false, so three never
         emits <shadowmap_pars_fragment> here and getShadow() does not exist —
         which is why a 20 m mast threw nothing on the water in any shot. We
         do not want three's lighting scaffolding either (this file has its own
         complete sun/sky/LUT model), so we unpack the same RGBA-packed depth
         map by hand with three's own UnpackFactors, exactly as js/sails.js has
         always done. app.js stretches that map's near/far along the sun ray so
         a 5 deg sun's 245 m shadow is actually inside the frustum.
         The water is NOT a caster, so there is no self-shadow acne to fight
         and the depth bias only has to cover packing precision.            */
      /* Specular occlusion by the boat itself. The sea in front of a hull does
         not mirror the sky, it mirrors the hull: at a 2.5-7 m eye the reflected
         ray leaves the surface at only a few degrees, so it stays low for tens
         of metres and runs straight into the topsides and rig. Without this the
         water keeps full sky reflectance right up to the waterline, which is
         most of what "the hulls intersect the sea like a cutout" means.
         Analytic, against the same oriented ellipsoid setHullShadow already
         uploads, widened vertically to take in the rig.                     */
      'float hullRefl(vec3 P, vec3 Rv){',
      '  if (uHull1.z <= 0.001) return 1.0;',
      '  vec3 C = vec3(uHull0.x, 2.6, uHull0.y);',
      '  vec3 d = C - P;',
      '  float t = dot(d, Rv);',
      '  if (t <= 0.05) return 1.0;',
      '  vec3 q = P + Rv*t - C;',
      '  float f = q.x*uHull1.x + q.z*uHull1.y;',
      '  float s = q.x*uHull1.y - q.z*uHull1.x;',
      '  float e = length(vec3(f/(uHull0.z*1.30), q.y/7.0, s/(uHull0.w*1.55)));',
      '  return 1.0 - 0.80*(1.0 - smoothstep(0.50, 1.45, e));',
      '}',
      /* ---------------------------------------------------------------------
         KELVIN WAKE — the real stationary-phase solution, in closed form.
         A displacement source moving at V generates, along a ray making angle
         alpha with the track, waves travelling at angle theta where
             tan(alpha) = sin(t)cos(t) / (1 + sin^2 t)
         Writing s = sin^2(theta) and t = tan(alpha) turns that into a quadratic
             s^2(1+t^2) - s(1-2t^2) + t^2 = 0
         whose discriminant 1 - 8t^2 goes negative exactly at
             alpha = asin(1/3) = 19.4712 deg
         which IS the Kelvin half-angle — it falls out, it is not dialled in.
         The two roots are the transverse and divergent systems; the phase is
             Phi = k0 (a cos t + |b| sin t) / cos^2 t,      k0 = g/V^2
         and the local wavenumber is k0/cos^2(theta), which is what lets each
         system be Nyquist-gated against the pixel footprint independently.
         Returns: xy = surface slope, z = foam, w = aeration (churn).       */
      'vec4 kelvinWake(vec2 p, float fpe){',
      '  vec4 o = vec4(0.0);',
      '  if (uBoatQ.w < 0.5) return o;',
      '  vec2 f = uBoatP.zw;',
      '  vec2 sd = vec2(f.y, -f.x);',
      '  vec2 rel = p - uBoatP.xy;',
      '  float xf = dot(rel, f), yl = dot(rel, sd);',
      '  float k0 = uBoatQ.y, hb = uBoatQ.z, A0 = uBoatR.x;',
      '  float fade = 1.0 - smoothstep(90.0, 190.0, length(rel));',
      '  if (fade <= 0.001) return o;',
      '  for(int h=0; h<2; h++){',
      '    float yo = (h==0) ? -hb : hb;',
      '    float b = yl - yo;',
      '    float a = uBoatR.z - xf;',                    // metres astern of the source
      '    if (a < 0.35) continue;',
      '    float ab = abs(b);',
      '    float tt = ab/a;',
      '    float D = 1.0 - 8.0*tt*tt;',
      '    float sgn = (b >= 0.0) ? 1.0 : -1.0;',
      '    float dec = 1.0/sqrt(1.0 + a*0.16);',
      '    float bw  = 1.0 + 2.1*exp(-a*0.18);',        // the bow wave IS the near field of this
      '    if (D > 0.0){',
      '      float sq = sqrt(D);',
      '      float c1 = 1.0 - 2.0*tt*tt, dn = 2.0*(1.0 + tt*tt);',
      '      float sT = clamp((c1 - sq)/dn, 0.0, 0.999);',
      '      float sD = clamp((c1 + sq)/dn, 0.0, 0.999);',
      '      float cT = max(1.0 - sT, 0.05), cD = max(1.0 - sD, 0.03);',
      '      float kT = k0/cT, kD = k0/cD;',
      '      float phT = kT*(a*sqrt(cT) + ab*sqrt(sT));',
      '      float phD = kD*(a*sqrt(cD) + ab*sqrt(sD));',
      // each system gets its own Nyquist gate: the divergent arms are short and
      // must dissolve before they alias, the transverse arcs are 13 m at 8 kn
      // and survive far past them
      '      float gT = smoothstep(0.9, 2.4, (6.2831853/kT)/(2.0*fpe));',
      '      float gD = smoothstep(0.9, 2.4, (6.2831853/kD)/(2.0*fpe));',
      '      float wT = dec*bw*(0.30 + 0.70*sq)*gT*fade;',
      '      float wD = dec*bw*(0.88 - 0.52*sq)*gD*fade;',
      '      vec2 dT = -f*sqrt(cT) + sd*(sgn*sqrt(sT));',
      '      vec2 dD = -f*sqrt(cD) + sd*(sgn*sqrt(sD));',
      '      float eT = A0*sin(phT), eD = A0*0.80*cD*sin(phD);',
      '      o.xy -= dT*(eT*kT*wT) + dD*(eD*kD*wD);',
      // foam rides the steep forward faces of the divergent arms and the crown
      // of the first two transverse crests, not the whole pattern
      '      o.z += max(-cos(phD), 0.0)*wD*0.55 + max(-cos(phT), 0.0)*wT*0.30*smoothstep(26.0, 6.0, a);',
      '    }',
      // the cusp locus itself: |b| = a*tan(19.47 deg). Both systems pile up here
      // and it is the line the eye actually reads as "wake".
      '    float cl = (ab - 0.353553*a)/(0.85 + 0.085*a);',
      '    o.z += exp(-cl*cl)*dec*1.15*fade;',
      '    o.z += exp(-(b*b)/(1.35*1.35))*exp(-a*0.055)*0.55*fade;',   // hull shoulder / stem sheet
      '  }',
      // transom churn: an aerated, high-roughness, low-Fresnel patch that the
      // props and the hull separation leave directly astern
      '  float at = -(xf + uBoatR.w);',
      '  if (at > -0.8){',
      '    float lb = abs(abs(yl) - hb);',
      '    float wch = 1.9 + 0.20*max(at, 0.0);',
      '    o.w = exp(-max(at,0.0)*0.13)*exp(-(lb*lb)/(wch*wch))*uBoatR.y*fade;',
      '  }',
      /* Slope gain. The elevations above are the honest ones (a 16 m catamaran
         at 6 kn really does only make a 0.2 m quarter wave), but what reads at
         a 30 m stand-off is the SLOPE, through the sky reflection — and against
         a whitecapping sea with a cumulus deck in the mirror the honest slope
         disappears. 1.9 is the smallest gain at which the arms survive
         ocean-close and sails-upwind. */
      '  o.xy *= 1.9;',
      '  o.z = clamp(o.z + o.w*0.75, 0.0, 1.6);',
      '  return o;',
      '}',
      'float upk(vec4 v){ return dot(v, vec4(5.9371816e-8, 1.5199185e-5, 3.8909912e-3, 0.99609375)); }',
      'float rigShadow(vec3 P){',
      '  if (uRigOn < 0.5) return 1.0;',
      '  vec4 sc = uRigMat*vec4(P,1.0);',
      '  vec3 c = sc.xyz/max(sc.w,1e-4);',
      '  if (c.x<0.002||c.x>0.998||c.y<0.002||c.y>0.998||c.z>0.9995||c.z<0.0) return 1.0;',
      /* fade the last 6% of the map border to nothing, or the ortho's edge
         draws a hard rectangle across the sea when the boat drifts */
      '  vec2 ed = smoothstep(vec2(0.0), vec2(0.06), c.xy)*smoothstep(vec2(0.0), vec2(0.06), 1.0-c.xy);',
      '  float edge = ed.x*ed.y;',
      '  float e = uRigTexel;',
      '  float s = 0.0;',
      '  for(int j=-1;j<=1;j++){ for(int i=-1;i<=1;i++){',
      '    s += step(c.z-uRigBias, upk(texture2D(uRigMap, c.xy + vec2(float(i),float(j))*e)));',
      '  }}',
      '  s *= 0.111111;',
      '  return 1.0 - (1.0-s)*edge*uRigStr;',
      '}',
      /* Cumulus shadow bands. js/island.js has had these on the terrain since
         the start; the sea did not, so the two read as different weather. Same
         deck height (900 m), same hash, same downwind stretching, same
         normalisation — see the long note in island.js for why the field has to
         be normalised before it is thresholded.
         Two deliberate departures from the island's copy, both because the
         VIEWPOINT differs, not the weather:
         (1) the lattice runs 2.4x finer. island.js' cell is 1.3 x 4.7 km, right
             for a landmass seen whole from three kilometres; from a 7 m eye the
             visible sea is barely one cell across, so at full strength a single
             cell dims the entire frame and reads as dusk rather than as a cloud.
             Finer cells put two or three legible bands in the near field.
         (2) roughly half the depth. What you see on water at deck height is
             mostly mirror, and the mirror is not what the cloud is blocking. */
      'float cloudShadow(vec2 p){',
      '  if (uCloudAmt < 0.01 || uSunDir.y < 0.03) return 1.0;',
      '  vec2 q = p + uSunDir.xz*(900.0/max(uSunDir.y,0.22));',
      '  q -= uWindDir*(uTime*7.5);',
      '  vec2 wd = normalize(uWindDir + vec2(1e-4,0.0));',
      '  vec2 r = vec2(dot(q,wd)*0.34, dot(q,vec2(-wd.y,wd.x)));',
      '  float n = fbm2o(r*0.00187)*0.66 + fbm2o(r*0.00636+vec2(11.0,3.0))*0.34;',
      // measured mean 0.415, sigma 0.0994 — normalise before thresholding or
      // the band never resolves. See the note in island.js.
      '  float nn = clamp((n - 0.415)*3.02 + 0.5, 0.0, 1.0);',
      '  float lo = mix(0.82, 0.34, clamp(uCloudAmt,0.0,1.0));',
      '  return 1.0 - 0.40*smoothstep(lo, lo+0.22, nn);',
      '}',
      // fp = world metres per pixel; fades detail octaves out as they go
      // sub-pixel instead of letting them alias into speckle.
      'vec3 seabedAlbedo(vec2 p, float d, float fp){',
      '  float n1 = vn2(p*0.035), n2 = vn2(p*0.11 + 5.1);',
      '  vec3 a = vec3(0.80,0.745,0.585)*0.83;',
      '  a = mix(a, vec3(0.60,0.545,0.455)*0.62, smoothstep(0.55,0.80,n2)*(1.0-smoothstep(3.0,9.0,fp)));',
      '  a = mix(a, vec3(0.15,0.255,0.125), smoothstep(0.58,0.80,n1)*smoothstep(11.0,4.0,d));',
      '  a = mix(a, vec3(0.075,0.085,0.070), smoothstep(13.0,30.0,d));',
      '  a *= 1.0 + (0.30*vn2(p*0.55) - 0.15)*(1.0 - smoothstep(0.5,1.8,fp));',
      '  return a;',
      '}',
      'void main(){',
      '  float dep   = vP0.w;',
      '  float col   = vWorld.y + dep;',
      '  if (col < 0.0 || dep < 0.02) discard;',
      '  vec3 N0 = normalize(vN);',
      '  vec3 V  = normalize(uCam - vWorld);',
      '  vec3 L  = normalize(uSunDir);',
      '  float dist = max(vP2.x, 0.5);',
      '  float sunUp = clamp(L.y, 0.0, 1.0);',
      // the eye's own geometric horizon range, sqrt(height): every distance
      // rolloff below is written against it so a 2.5 m cockpit and a 12 m
      // masthead put their ramps in the same place relative to the skyline
      '  float hzD = 3600.0*sqrt(max(uCam.y, 0.5)/2.5);',
      // geometric depression angle of this patch of sea below the eye. Purely a
      // function of range and eye height, so it is smooth in screen space —
      // which is what makes it safe to key band-limiting decisions on.
      '  float gview = clamp((uCam.y - vWorld.y)/dist, 0.0, 1.0);',
      '  float fp = max(fwidth(vWorld.x), fwidth(vWorld.z));',   // world metres per pixel
      /* The ANISOTROPIC pixel footprint. At a 2.5 m eye and 500 m the pixel
         covers 115.7 m along the view and 0.58 m across it — 200:1. Gating the
         detail octaves on the long axis alone would delete everything past
         200 m; gating on the short axis alone would alias. With N:1 anisotropic
         filtering the effective footprint is max(short, long/N), and that is
         the number every Nyquist decision below is made against. */
      '  float fpx = length(vec2(dFdx(vWorld.x), dFdx(vWorld.z)));',
      '  float fpy = length(vec2(dFdy(vWorld.x), dFdy(vWorld.z)));',
      '  float fpe = max(max(min(fpx,fpy), max(fpx,fpy)*0.0625), 1.0e-4);',
      '  vec2 pw = vWorld.xz;',
      '  vec2 wd = uWindDir;',
      '  vec2 wq = vec2(wd.y, -wd.x);',                          // crosswind
      '  float gust = texture2D(uGustTex, (pw - uGustOfs)*uGustInv).r;',
      // Height above the mean plane in units of the significant wave height.
      // Hoisted above the foam block because whitecaps are a CREST event and
      // the gate below needs it; the sky-visibility terms further down use the
      // same number.
      '  float hRel = vWorld.y/max(0.62*uHs, 0.25);',

      // ================= detail slopes (LEAN, Nyquist-gated octaves) =======
      '  vec2 slope = vec2(0.0); vec2 midSlope = vec2(0.0); vec2 slopeLo = vec2(0.0);',
      '  float varLost = 0.0; float bub = 0.0;',
      '  float owE = 0.0; float varE = 0.0; float owLoE = 0.0;',
      detailOctavesGLSL(low ? [0, 2, 4, 5, 6] : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),

      // ================= foam ==============================================
      // Granular bubble raft, world-locked and advected with the surface drift
      // so it foreshortens with distance instead of scrolling at a fixed
      // apparent size. Two Worley octaves; the coarse one carves the raft into
      // patches, the fine one is the bubbles.
      '  vec2 fp2 = pw - uDrift*uTime;',
      /* Both Worley octaves are world-locked and UNFILTERED, so past the range
         where their cells drop below Nyquist they turn into white noise — which
         is the great majority of the "cracked pack-ice crazing at identical
         apparent scale from 5 m to the horizon" the review named. Dissolve each
         octave toward its own field MEAN (0.5) as it goes sub-pixel: the near
         field keeps its granularity, the far field goes smooth instead of
         speckling. Cell sizes: coarse mask 1.25 m / 0.42 m, fine 0.33 m /
         0.111 m. */
      '  float bwC = smoothstep(0.90, 2.30, 0.700/(2.0*fpe));',
      '  float bwF = smoothstep(0.90, 2.30, 0.185/(2.0*fpe));',
      '  float bmC = mix(0.50, bubbleMask(fp2*0.55), bwC);',
      '  float bmF = mix(0.50, bubbleMask(fp2*2.10 + 11.3), bwF);',
      '  float bm  = clamp(0.45*bmC + 0.55*bmF, 0.0, 1.0);',
      /* The detail texture's alpha is a ridged fbm, and leaning on it for the
         bubble granularity is a large part of what stamped a fixed-scale mould
         pattern over the whole surface. The Worley pair is world-locked and
         Nyquist-gated, so it foreshortens and dissolves correctly; make it the
         primary and keep only a trace of the texture channel for micro-relief. */
      '  bub = mix(bm, bub, 0.22);',
      '  float J = vP0.x, dJdt = vP3.y;',
      /* THE BREAKING GATE.  uFoamHi/uFoamLo are now the exact quantile of the
         measured J distribution for the target Monahan/Asher coverage, and the
         ramp between them is only 0.34 sigma wide, so the gate is very nearly
         binary — a whitecap IS binary at pixel scale, and it was the wide
         low-alpha skirt of the old gate that painted a continuous crust over
         everything. There is deliberately NO contrast remap after it: any
         monotone curve applied to the gate output moves the painted area away
         from the number the solve guaranteed.
         Raggedness comes from perturbing the THRESHOLD by the bubble field, and
         it is scaled to the ramp width so light air (a narrow ramp) does not get
         its gate swamped by a perturbation wider than the ramp itself. */
      '  float gw = max(uFoamHi - uFoamLo, 1e-4);',
      /* The threshold perturbation has to be SEVERAL times the gate width or it
         does nothing. With a gate this narrow a sub-width jitter leaves the
         contour exactly where the Jacobian put it, and the Jacobian dips below
         threshold along the whole length of a crest — which paints an unbroken
         thirty-metre pale ribbon down every wave, the single most artificial
         thing foam can do. Two scales: a ~6 m field that decides WHICH stretches
         of this crest are breaking at all, and the bubble raft that makes the
         edge of each one ragged. Both are zero-mean, so the coverage the solve
         guaranteed is preserved. */
      '  float fpatch = vn2(fp2*0.16 + 4.7) - 0.5;',
      '  float rag = ((bmC - 0.5)*1.60 + fpatch*2.80)*gw;',
      // a fold that is still CLOSING is the one throwing bubbles; one already
      // relaxing has stopped entraining air. Small bias, but it puts the bright
      // edge on the advancing side of the crest where it belongs.
      /* CREST LOCK. A whitecap is a crest event. The Jacobian alone dips below
         threshold wherever the fold is tightest, and on a two-train sea that
         includes the odd steep trough wall — which is how rafts ended up draped
         over faces and hollows with no relation to the wave form. Gating the
         live gate on elevation above the mean plane, and the aged rafts on a
         softer version of it (they have drifted down the face by then), is what
         puts the foam back on top of the water instead of over it. */
      '  float crestLk = smoothstep(-0.12, 0.72, hRel);',
      '  float agedLk  = 0.34 + 0.66*smoothstep(-1.05, 0.42, hRel);',
      '  float lead = smoothstep(uFoamHi, uFoamLo, J + rag - 0.10*gw*clamp(-dJdt, 0.0, 1.0));',
      '  lead *= (0.30 + 0.70*bmF)*crestLk;',
      /* The rafts this crest threw off 1.6 / 3.6 / 6.4 s ago, each sampled where
         it was BORN and carried downstream by uDrift (vertex stage). Opacity
         follows exp(-tau/4.5 s), and the bubble scale coarsens with age because
         a draining raft loses its fine structure first — old foam is a few big
         thin patches, not a fizz. */
      '  float t1 = smoothstep(uFoamHi, uFoamLo, vP0.y + rag*1.20)*(0.26 + 0.74*bmF)*0.62;',
      '  float t2 = smoothstep(uFoamHi, uFoamLo, vP0.z + rag*1.55)*(0.22 + 0.78*bmC)*0.36;',
      '  float t3 = smoothstep(uFoamHi, uFoamLo, vP3.w + rag*1.95)*(0.18 + 0.82*bmC)*0.19;',
      // the lagged Jacobian taps are only evaluated in the vertex stage near the
      // camera (vP3.z); fade their contribution through the same window so
      // nothing steps at the gate
      '  float aged = max(max(t1, t2), t3)*vP3.z*agedLk;',
      '  float crest = clamp(max(lead, aged), 0.0, 1.0)*uFoamGain;',
      /* Aerial perspective on the TEXTURE, not just on the colour. A real sea
         loses whitecap contrast smoothly with range; terminating it abruptly at
         a razor-straight skyline is what makes the horizon read as a geometric
         plane meeting a skybox. */
      '  crest *= mix(1.0, 0.40, smoothstep(0.10*hzD, 0.80*hzD, dist));',
      // how much of this pixel is old foam rather than actively breaking - drives
      // the dissipation gradient in the shading below
      '  float fAge = clamp(1.0 - lead/max(crest, 1e-3), 0.0, 1.0);',
      '  float fresh = 0.0;',   // filled in once the wake terms exist, below

      // shoreline foam + 1.4 s swash memory
      '  float swn = 0.35 + 0.65*bub;',
      '  float shoreF = smoothstep(0.55, 0.05, col)*swn;',
      '  float colSw = vP1.w + dep;',
      '  shoreF = max(shoreF, 0.62*smoothstep(0.50, 0.02, colSw)*swn);',
      '  shoreF *= step(0.02, dep);',

      // boat wake buffer — the persistent, advected, ageing raft
      '  vec2 wuv = (pw - uWakeC)/(2.0*uWakeR) + 0.5;',
      '  float wk = 0.0, wkAge = 0.0;',
      '  if (wuv.x > 0.002 && wuv.x < 0.998 && wuv.y > 0.002 && wuv.y < 0.998){',
      '    float ed = min(min(wuv.x, 1.0-wuv.x), min(wuv.y, 1.0-wuv.y));',
      '    vec2 wt = texture2D(uWakeTex, wuv).rg;',
      '    wk = clamp(wt.r, 0.0, 2.0) * smoothstep(0.0, 0.06, ed);',
      '    wkAge = clamp(wt.g, 0.0, 1.0);',
      '  }',
      // a bubble raft is granular, and the threshold has to be perturbed rather
      // than the result dimmed, or the trail is an airbrushed ellipse again
      '  wk = smoothstep(0.30 - 0.26*bmC, 0.86 - 0.26*bmC, wk*1.35)*(0.34 + 0.66*bmF);',

      // ================= boat / water interaction =========================
      '  vec4 kw = kelvinWake(pw, fpe);',
      '  float churn = clamp(kw.w, 0.0, 1.0);',
      /* WATERLINE CONTACT. uLinDTex already holds this frame\'s opaque linear
         depth and the water shader already samples it for the refraction
         rejection below, so this costs one extra tap and about eight ALU. Where
         the opaque surface behind a water pixel is at very nearly the same
         range as the water itself, that pixel is ON the hull\'s waterline: it
         gets a wobbling contact foam band, a darkening for the sky the topsides
         block, and extra roughness. Without it the hulls end in a razor line on
         flat blue, which is the whole of "the hulls intersect the sea like a
         cutout". */
      '  float wline = 0.0;',
      '  if (uHasLinD > 0.5 && uBoatQ.w > 0.5){',
      '    float sdc = texture2D(uLinDTex, clamp(gl_FragCoord.xy/uRes, 0.001, 0.999)).r;',
      '    float dz = abs(sdc - dist);',
      '    float bd = length(pw - uBoatP.xy);',
      '    wline = smoothstep(2.2, 0.0, dz)*step(sdc, dist + 26.0)*(1.0 - smoothstep(16.0, 34.0, bd));',
      // ragged, wave-modulated edge rather than a clean screen-space outline
      '    wline *= 0.55 + 0.45*bmF;',
      '  }',
      '  float wakeF = clamp(kw.z*(0.42 + 0.58*bm) + churn*(0.30 + 0.70*bmF)*0.9, 0.0, 1.0);',
      '  float foam = clamp(crest + shoreF + wk*0.95 + wakeF + wline*0.62, 0.0, 1.0);',
      // A breaking bow/quarter wave is ACTIVELY entraining air: it is the
      // brightest, most opaque foam in the frame, not a drained raft. Without
      // this the wake inherits fAge=1 (because `crest` is zero in the trough it
      // sits in) and gets rendered at 46% albedo and 62% coverage — invisible.
      // ACTIVELY entraining air: a breaking bow/quarter wave, a hull waterline,
      // and the live crest gate itself. That foam is the brightest thing in the
      // frame and it is allowed to clip; a drained raft is not.
      '  fresh = clamp(max(max(wakeF*1.25, wline*0.9), lead*0.95), 0.0, 1.0);',
      '  fAge = fAge*(1.0 - fresh);',
      '  float bubT = smoothstep(0.26, 0.80, bub);',   // bubble granularity

      // ================= normal ============================================
      // Cox-Munk says the sea carries mean-square slope 0.003 + 5.12e-3*U10.
      // The mesh resolves the long end of that; uDetMss is the remainder, and
      // it is injected here as REAL per-pixel slope so the specular breaks into
      // thousands of discrete facets instead of one smooth Blinn lobe.
      // Hydrodynamic modulation: short waves bunch up on the windward faces of
      // the long waves and are sheltered in the lee. Without it every octave has
      // the same strength everywhere and the sea reads as uniform sandpaper
      // rather than chop organised by the swell underneath it.
      '  float upw = clamp(dot(N0.xz, wd)*2.2, -1.0, 1.0);',
      // Kilometre-scale patchiness in the local wind. Cat's paws and slicks stay
      // legible all the way to the horizon on a real sea and are the only thing
      // that keeps the last few km from being a featureless sheet; the gust
      // texture tiles every 340 m so it cannot supply this scale itself.
      '  float wpatch = vn2(pw*0.00085 + 31.7);',
      '  float gs = (0.72 + 0.46*gust)*(0.82 + 0.34*wpatch)*(1.0 + 0.16*upw);',
      '  float detA = sqrt(max(uDetMss,0.0))*gs*(1.0 - 0.55*foam);',
      '  slope *= detA*1.20;',
      '  slopeLo *= detA*1.20;',
      /* RE-INJECT WHAT THE MESH DROPPED, AS SLOPE — not only as roughness.
         vP2.y is the fraction of displaced amplitude the Nyquist gate faded
         out. The old line spent ALL of it on `alpha`, which is correct only for
         the octaves that are genuinely sub-PIXEL. The octaves that are sub-MESH
         but still supra-pixel — at 500 m and a 2.5 m eye the mesh cut is 56 m
         and the pixel resolves 1.2 m, so five and a half octaves of them — have
         to come back as a visible normal or the far field is a mirror. `carry`
         is exactly that resolvable fraction, drawn with the two new mid-band
         detail octaves; the remainder still goes to roughness.
         The 1.44 is the missing 1.20^2 from the `slope *= detA*1.20` above,
         which the old variance line did not account for. */
      '  float lostVar = vP2.y*vP2.y*uMeshMss;',
      '  float oct = clamp(log2(max(2.0*vP1.y, 0.05)/max(2.0*fpe, 0.02)), 0.0, 6.0);',
      '  float carry = oct*0.1666667;',
      '  vec2 midS = midSlope*sqrt(max(lostVar,0.0)*carry)*1.75;',
      /* midS goes into the SUN normal here but NOT into slopeLo: it is added to
         the sky normal separately, further down, on its own weight. The two
         belong on different budgets. slopeLo is the fine cascade, which has to
         be heavily damped for the sky lobe or the mirror striates; midS is
         5-9 m relief standing in for wind sea the mesh LOD has dropped, it is
         several pixels across wherever it is active, and it needs to reach the
         mirror at nearly full strength or the mid-field is a dead sheet. */
      '  slope += midS;',
      '  varLost = varLost*uDetMss*gs*gs*1.44 + lostVar*(1.0 - carry);',
      // Real sea slope is not Gaussian: Cox & Munk measured a positive peakedness,
      // i.e. a heavy tail. That tail is ENTIRELY what sun glitter is made of - it
      // is the rare 25-35 degree facet that mirrors the disc - so a purely
      // Gaussian sum of octaves produces a sea that can never spark. Stretch the
      // tail without moving the variance.
      // wind ripples run crosswind, so along-wind slopes are the steeper ones.
      // Kept mild: at 1.5:1 the whole octave ladder combs into parallel filaments.
      '  vec2 sl2 = wd*(dot(slope,wd)*1.10) + wq*(dot(slope,wq)*0.92);',
      '  vec2 sl2Lo = wd*(dot(slopeLo,wd)*1.10) + wq*(dot(slopeLo,wq)*0.92);',
      // the wake goes in AFTER the anisotropy rotation — it is not wind chop and
      // must not be stretched along the wind. It belongs in both: a bow wave is
      // a resolved, metre-scale feature.
      '  sl2 += kw.xy; sl2Lo += kw.xy;',
      // Real sea slope is not Gaussian: Cox & Munk measured a positive peakedness,
      // i.e. a heavy tail, and that tail is what sun glitter is made of - the rare
      // steep facet that mirrors the disc. Applied to the SUN normal only. Feeding
      // it to the sky normal as well just raises the variance of a broad-source
      // average, which shows up as salt-and-pepper mottling, not as sparkle.
      '  float sMag = length(sl2);',
      '  vec2 slSun = sl2*(1.0 + 1.55*smoothstep(0.75, 3.20, sMag/max(detA,1e-4)));',
      // Two normals, because the two light sources have opposite statistics.
      // The sky is a BROAD source: what a pixel reflects is the average over its
      // whole slope distribution, so it takes a damped normal and the discarded
      // variance goes into roughness. The sun is a POINT source: its reflection
      // lives entirely in the tail of the distribution, so it takes the full
      // per-pixel normal - that is what makes the glitter break into thousands
      // of separate sparkles instead of one soft blob.
      // Masking: at grazing incidence the facets tilted AWAY from the eye are
      // hidden behind the wave in front, so the visible slope distribution is
      // much narrower than the full one. Without this the broad-source term
      // swings between mirror-bright and body-dark on adjacent pixels and the
      // sea turns into brushed metal.
      '  float mNoV = max(dot(N0, V), 0.0);',
      /* The sky normal takes the RESOLVED slope only — sl2Lo, the octaves whose
         features are 12 cm and up, each already faded out by its own Nyquist
         gate before it goes sub-pixel. Everything finer is real slope but it is
         not resolvable geometry at any range in frame, and reflecting a broad,
         high-contrast source off unresolvable geometry is how the crust got
         made. Masking still applies on top of that: at grazing incidence the
         facets tilted away from the eye are hidden behind the wave in front, so
         the visible distribution is narrower than the full one. */
      /* ...and one more gate, which is the one that actually holds, because it
         does not depend on any of the Nyquist bookkeeping being right.
         Ask the hardware directly whether this slope field is resolved: compare
         the magnitude of the slope against how much it changes between adjacent
         pixels. A ripple that is genuinely drawn — several pixels across — has a
         ratio of ten or more. A field that is at or past the sampling limit has
         a ratio near one, because each pixel is an independent draw. Damping kb
         by that ratio converts exactly the unresolved part into roughness, which
         is where it belongs, and it is self-correcting: it cannot be defeated by
         a mip chain that under-filters, an anisotropy cap that is too low, or an
         octave whose internal spectrum runs finer than its nominal feature size.
         It is the difference between a rippled mirror and a granite worktop. */
      '  vec2 fwLo = fwidth(sl2Lo);',
      '  float resLo = smoothstep(1.15, 4.30, length(sl2Lo)/max(length(fwLo), 1e-5));',
      '  float kb = (uTune.x + uTune.y*smoothstep(0.005, 0.32, mNoV)',
      '                      * smoothstep(0.004, 0.16, gview))*resLo;',
      /* The mid-band carrier, on its own budget and at nearly full strength.
         Its features are 5-9 m, so it is several pixels across everywhere it is
         active, and it only switches on as the mesh LOD fades the wind sea out
         (lostVar, inside midS). Without it in the SKY normal the last few
         hundred metres mirror one fixed elevation and go dead — the "abrupt
         banded transition and long horizontal aniso smears" the review measured.
         Rotated into the same along/cross-wind frame as the rest. */
      '  vec2 midR = wd*(dot(midS,wd)*1.10) + wq*(dot(midS,wq)*0.92);',
      '  vec3 N  = normalize(N0 + vec3(slSun.x, 0.0, slSun.y));',
      '  vec3 Nb = normalize(N0 + vec3(sl2Lo.x, 0.0, sl2Lo.y)*kb',
      // no resLo gate on this one: `carry` inside midS is already an explicit
      // mesh-pitch-vs-pixel-footprint resolvability measure, and resLo is now
      // derived from a slopeLo that no longer contains this term at all.
      '                         + vec3(midR.x, 0.0, midR.y)*0.85);',
      '  if (dot(N, V)  < 0.0) N  = normalize(N  - V*dot(N,V)*1.02);',
      '  if (dot(Nb, V) < 0.0) Nb = normalize(Nb - V*dot(Nb,V)*1.02);',
      /* THE CRUST, root cause.  broadVar used to be (1-kb^2)*dot(sl2,sl2) — the
         INSTANTANEOUS squared slope of this one pixel. It feeds alphaB, which
         sets both the width of the sky prefilter cone and how much of the sharp
         mirror sample is replaced by it. So a per-texel random number was
         deciding, pixel by pixel, whether that pixel showed a sharp reflection
         or a blurred one — and near the horizon the sky's radiance gradient is
         steep enough that sharp and blurred differ by a factor of two. The
         result is a high-frequency mottle stamped over the whole mid-field at a
         fixed apparent scale, i.e. exactly the lichen/wet-concrete crust, and it
         survived every attempt to fix it by touching the foam or the normals
         because it was never in either of them.
         Roughness is a VARIANCE. It must be built from the expected moments of
         the slope field (owE / varE, accumulated from the Nyquist gates alone),
         never from one sample of it. */
      '  float detE = uDetMss*gs*gs*1.44*(1.0-0.55*foam)*(1.0-0.55*foam);',
      '  float slVarE = detE*owE + lostVar*carry*2.10 + dot(kw.xy, kw.xy);',
      // everything the sky normal did NOT take: the fine octaves in full, plus
      // the masked-off part of the resolved ones
      '  float broadVar = max(slVarE - kb*kb*detE*owLoE, 0.0);',
      '  float varLostE = varE*detE + lostVar*(1.0 - carry);',

      // ================= roughness ========================================
      // alpha is built ONLY from slope variance the pixel cannot resolve: the
      // LEAN residual plus the capillary band below the finest octave. Near
      // field alpha ~ 0.03-0.06, rising smoothly toward the horizon, which is
      // exactly the Toksvig cure for the shimmer.
      /* ROUGHNESS FROM COX-MUNK, NOT FROM THE MESH.
         The mesh normal is band-limited by the ring pitch and is therefore
         always under-rough; deriving the BRDF width from it is what produced a
         microfacet lobe two to five times too tight to catch the solar disc at
         all. cmMss is the measured law, mss = 0.003 + 0.00512*U10; capMss is the
         part of it that lives below the finest detail octave (capillaries and
         the sub-millimetre tail) and can never be resolved at any distance, so
         it is a hard FLOOR on the lobe width rather than something the mip chain
         is allowed to average away. That floor is what keeps distant water
         glittering instead of averaging to a flat mean normal. */
      '  float cmMss = 0.003 + 5.12e-3*uU10;',
      '  float capMss = cmMss*0.075;',
      '  float alpha = clamp(sqrt(max(varLost,0.0) + capMss), 0.055, 0.45);',
      '  alpha = mix(alpha, 0.85, foam);',
      // aerated water directly astern scatters everything; it is not a mirror
      '  alpha = mix(alpha, 0.94, churn*0.85);',
      // the sky lobe is wider by exactly the variance Nb threw away
      // ...and the sky lobe's own width, from the expected moments only.
      '  float alphaB = clamp(sqrt(max(varLostE,0.0) + capMss + broadVar), 0.02, 0.55);',
      /* GRAZING COMPRESSION — the reason the far half of every sea photograph is
         a mirror. A slope distribution of RMS sigma subtends an angular spread
         of about sigma at NORMAL incidence, but the same distribution seen at
         89 degrees is foreshortened along the view: the visible facets are the
         ones whose normals lie in a much narrower cone, because everything
         steeper is masked behind the wave in front. The Smith masking term says
         that width goes roughly as the cosine of the incidence angle, which here
         is the geometric depression angle. Without it the mid-field carried a
         0.3-0.5 lobe all the way to the skyline, which blurs the cumulus deck
         into the featureless grey-blue wash the review measured, and takes the
         reflectance with it. Keyed on gview, which is a smooth function of range
         and eye height alone, so it cannot alias. */
      '  alphaB *= mix(0.32, 1.0, smoothstep(0.004, 0.13, gview));',

      // ================= Fresnel ==========================================
      // Full Schlick, no NdotV floor and no lerp toward a constant. At the
      // horizon NoV -> 0 and F -> 1, so the water becomes the sky it reflects
      // and the seam disappears without any fog hack.
      '  float NoV  = max(dot(N,V), 0.0);',
      '  float NoVb = max(dot(Nb,V), 0.0);',
      '  float F0 = 0.02037;',
      /* Fresnel takes a HALF-DAMPED normal, and this is the whole difference
         between water and a sheet of crumpled foil. Feeding it the full micro
         normal means every facet tilted away from the eye collapses NoV toward
         zero, F snaps to 1, and that pixel returns the sky at full strength —
         which against a trade-cumulus deck is white. Adjacent pixels then
         alternate between white cloud and dark body: the mottled crust. The
         physical answer is geometric masking (a facet steep enough to do that is
         hidden behind the wave in front), and the cheap, stable form of it is to
         let the reflection DIRECTION carry the full slope while the reflection
         WEIGHT is computed against a normal much closer to the macro surface. */
      '  vec3 Nf = normalize(mix(N0, Nb, uTune.z));',
      '  float NoVf = max(dot(Nf, V), 0.0);',
      '  float F = F0 + (1.0-F0)*pow(1.0-NoVf, 5.0);',
      '  vec3 Rv = reflect(-V, Nb);',
      /* ---- INTER-WAVE MASKING, the term that was missing entirely ----------
         From a 2.5 m eye nearly every square metre of sea beyond twenty metres
         is at grazing incidence, so Schlick returns 0.3-0.9 and the surface
         hands back the sky. That much is right and the review asked for it. But
         a reflected ray leaving a wave face one or two degrees above the mean
         plane does NOT reach the sky: it runs into the back of the wave in
         front. With no masking term at all the near and mid field returned the
         full grazing sky over 40% of frame and the sea came out as chalky white
         sheets draped over crests, faces and troughs alike — which is precisely
         what the review counted as painted foam. (Confirmed directly: forcing
         the foam gain to zero left the white sheets exactly where they were.)
         Smith's G1 against the surface's own slope RMS is the standard answer
         and it costs four instructions. What the masked fraction sees is the
         next wave's back, itself a near-mirror at grazing, so it is not black —
         it returns at roughly 40% after a second Fresnel and a second masking.
         Hence mix(0.40, 1.0, G1) rather than G1.
         It goes on the REFLECTANCE, not on the reflected radiance: masking
         removes sky from the pixel and hands the budget back to the water
         column, so the mid-field turns blue rather than merely turning down.
         And it is faded out with the geometric depression angle, which is not a
         fudge: masking is only VISIBLE while individual wave faces are resolved.
         Past a few hundred metres a pixel spans many waves, masked and unmasked
         average inside it, and the multiple-bounce recovery is complete — which
         is exactly why the last kilometre of a real sea is a clean mirror of the
         sky and has to stay one here. */
      '  float sigS = sqrt(max(uMeshMss + uDetMss, 1e-4));',
      '  float tanR = max(Rv.y, 0.0)/max(length(Rv.xz), 1e-4);',
      '  float aG   = tanR/max(sigS, 0.02);',
      '  float G1   = 2.0/(1.0 + sqrt(1.0 + 1.0/max(aG*aG, 1e-6)));',
      '  F *= mix(1.0, mix(0.40, 1.0, clamp(G1, 0.0, 1.0)),',
      '           smoothstep(0.004, 0.055, gview));',
      '  F = mix(F, 0.06, foam);',

      // ================= sky reflection ===================================
      // A ray reflected below the horizon hits the back of the next wave and is
      // reflected again, so it still carries sky - just dimmer.
      /* A ray reflected below the horizon strikes the back of the next wave.
         Folding it up with abs() is right — that second surface is itself a
         near-mirror — but the fold lands it on the HAZIEST, brightest part of
         the dome, so leaving it at 55% made every downward-tilted facet return a
         bright white sample. Two bounces off water at grazing incidence, through
         the spray and over the crest, do not keep 55%. */
      '  float below = smoothstep(0.02, -0.14, Rv.y);',
      '  vec3 refl = skyRadianceNoSun(normalize(vec3(Rv.x, abs(Rv.y)+0.004, Rv.z)), L);',
      '  refl *= mix(1.0, 0.26, below);',
      // Sky visibility. A point in a trough, or on a steeply tilted face, sees
      // only part of the hemisphere; a crest sees all of it. Without this every
      // wave back at grazing incidence returns the FULL sky radiance and the sea
      // turns into satin bands. The term is released only in the last fraction
      // of a degree before the vanishing line, where reflectance really is 1.0
      // and the water has to match the sky exactly.
      // Sky visibility, written as a DEVIATION from full openness rather than an
      // absolute factor. A flat patch of sea sees the whole hemisphere, so the
      // term has to vanish wherever the LOD has already flattened the waves
      // (vP2.y = the amplitude the mesh dropped) - otherwise the far field gets a
      // uniform dimming that reads as horizontal value banding across the frame.
      '  float have = 1.0 - vP2.y;',
      // 0.56 -> 0.70: a trough between 1.3 m crests sees a genuinely narrow slot
      // of sky, and under-selling that is most of why crest and trough came out
      // at nearly the same value and the swell read as embossed wallpaper.
      '  float aoDev = (1.0 - smoothstep(-1.3, 0.9, hRel))*0.70*have;',
      // Wave-scale ambient occlusion. A trough sees a slot of sky, a crest sees
      // the whole hemisphere; without this the displacement has no form and the
      // swell reads as a normal map on a flat plane. Applied to the TRANSMITTED
      // path as well as the reflected one further down.
      '  float waveAO = mix(0.44, 1.0, smoothstep(-1.5, 0.85, hRel)*have + (1.0-have));',
      // A reflected ray leaving within a couple of degrees of horizontal skims
      // the sea and usually strikes the back of the next wave. That wave is
      // itself a near-mirror, so most of the radiance survives - the loss is
      // real but modest, and it too must vanish over flattened water.
      '  float skim = (1.0 - smoothstep(0.012, 0.22, Rv.y))*have;',
      '  float ao = (1.0 - aoDev)*(0.82 + 0.18*N0.y)*mix(1.0, 0.72, skim);',
      // Gate on the GEOMETRIC depression angle, not on the facet normal - the
      // facet normal is the very thing being modulated, and keying off it undoes
      // the occlusion exactly where it is needed.
      '  refl *= mix(1.0, ao, smoothstep(0.0012, 0.0090, gview));',
      /* This used to be `mix(1.0, 0.76, smoothstep(0.045, 0.26, alphaB))` — a
         flat -24% applied wherever alphaB > 0.26, which past ~200 m is
         EVERYWHERE. It is not energy-conserving and it is a large part of why
         the 400-1400 m band measured brightest and least saturated in the whole
         frame while the water at the vanishing line was darker. What a rough
         surface actually loses to a broad source is the multiple-scattering
         deficit of the split-sum, which is a few percent, not a quarter. */
      '  refl *= mix(1.0, 0.94, smoothstep(0.045, 0.30, alphaB));',
      // A broad source seen through a rough surface is band-limited: soften the
      // reflected radiance toward the local sky average as the lobe widens, so
      // the mid-field stops marbling between mirror-white and body colour.
      // Gated off in the last couple of degrees, where reflectance is 1.0 and the
      // water must return the sky EXACTLY or the horizon grows a seam again.
      // A rough surface reflects a CONE, not a ray. Under-filtering it is what
      // makes the mid-field marble between mirror-white and body colour on
      // adjacent pixels, and what leaves the last few degrees before the skyline
      // as an aliased grey smear. Widen the prefilter in proportion to the real
      // lobe width so the reflection band-limits itself with distance.
      /* The offset used to be a FIXED +0.30 rad regardless of how wide the lobe
         actually was, so at grazing incidence 30% of the mid-field reflection
         was replaced by sky 17 degrees up — which in a hazy tropical sky is
         both brighter and much less blue than the sky at 2 degrees. That is the
         desaturated grey plate, and it is why the sea got LESS saturated with
         distance instead of converging on the sky it is mirroring. Tie the
         offset to the real lobe width. */
      /* And it was ONE-SIDED. Measured: turning the prefilter off drops the
         485 m water from 1.183x the horizon sky to 1.105x — i.e. 40% of the
         "bright grey plate" was the prefilter itself, because a blur that only
         ever samples UPWARD is not a blur, it is a bias. Take one tap each side
         of the mirror direction so the cone is band-limited symmetrically and
         the mean radiance is preserved. */
      /* FOUR taps, not two, and wider. A rough surface reflects a CONE, and the
         cone is two-dimensional: ripples tilt sideways as much as they tilt up
         and down, so a purely vertical pair band-limits one axis and leaves the
         other aliasing against a broken cumulus deck. That is what was left of
         the marbling once the Fresnel damping above took the worst of it out.
         The lateral pair costs two sky-LUT fetches and removes it. */
      '  vec3 rN0 = normalize(vec3(Rv.x, abs(Rv.y)+0.004, Rv.z));',
      /* Cone width, and this number has a hard ceiling that has nothing to do
         with the BRDF: four taps cannot represent a wide cone. Spread them past
         about five degrees against a broken cumulus deck and the "average" is a
         sparse sample of cloud and gap, which comes back as blotchy terraced
         patches — a different artefact with the same signature as the one the
         blur was meant to remove. Keep the cone inside what four taps can carry
         and let the rest of the width live in the BRDF. */
      '  float dySky = clamp(alphaB*0.80, 0.0, 0.085);',
      '  vec3 rTan = normalize(cross(rN0, vec3(0.0,1.0,0.0)) + vec3(1e-5,0.0,0.0));',
      '  vec3 rUp = skyRadianceNoSun(normalize(rN0 + vec3(0.0,dySky,0.0)), L);',
      '  vec3 rDn = skyRadianceNoSun(normalize(vec3(rN0.x, max(rN0.y-dySky, 0.0015), rN0.z)), L);',
      '  vec3 rLa = skyRadianceNoSun(normalize(rN0 + rTan*dySky), L);',
      '  vec3 rLb = skyRadianceNoSun(normalize(rN0 - rTan*dySky), L);',
      '  refl = mix(refl, (rUp + rDn + rLa + rLb)*0.25,',
      /* And it has to be nearly the WHOLE reflection, not a third of it. Left at
         0.72 x 2.6*alphaB the shader still returned a majority sharp, per-pixel
         mirror sample — and a sharp mirror sample of a BROKEN CUMULUS DECK is a
         step function: cloud or gap, white or blue, decided independently at
         every pixel by a slope field that is at the resolution limit. That is
         the granular white-on-blue speckle, and no amount of foam or normal
         tuning touches it, because it is the reflection being point-sampled
         against a high-contrast source. A rough surface does not point-sample a
         broad source; it integrates it. */
      '             clamp(alphaB*uTune.w, 0.0, 0.95)*smoothstep(0.0, 0.035, NoVb));',

      /* ---- what is blocking light at this point of sea -------------------
         vP2.w   wave-on-wave self shadowing (crest occludes trough)
         rigSh   the projected silhouette of the boat — hulls, rig, boom,
                 bimini and both sails — out to mastHeight/sin(elev) downsun
         cloudSh the cumulus deck, the same field island.js drags over the hills
         hullShadow is now only the contact AO right against the topsides.  */
      '  float rigSh = rigShadow(vWorld);',
      '  float cloudSh = cloudShadow(pw);',

      /* The reflection has to take a cut too, and this is worth spelling out
         because the naive answer is that it should not.
         At a 7 m eye looking 50 m across-sun the grazing Fresnel term is ~0.5
         and the water column is 37 m of blue, so the sea is ~95% sky mirror by
         radiance. Removing only the physically sun-driven lobes — in-scatter,
         glitter and subsurface — moves the final pixel by 3.2%, measured. That
         is arithmetically faithful to THIS shader's split and still wrong,
         because the split itself under-counts the sun: the Toksvig/LEAN pass
         upstream has already taken the unresolved slope variance out of the
         specular lobe and spent it on `alpha`, which widens the SKY cone
         (`refl`) rather than the sun cone. That energy is sunlight. It is
         reflected sunlight scattered by facets this pixel cannot resolve, and
         when the rig stands between those facets and the sun it does not
         arrive. Attenuating a fifth of `refl` inside the shadow puts it back
         where it came from.
         Cloud gets far LESS of this than the rig, which is the opposite of the
         obvious guess. A trade cumulus shadowing this patch of sea sits almost
         overhead; the ray this patch actually mirrors leaves at two or three
         degrees and lands on sky tens of kilometres away, nowhere near that
         cloud. So the cloud takes the sun terms in full and only nibbles the
         mirror. Running this at the rig's weight put a single 1.3 x 4.7 km
         band over the entire near field and dropped the whole sea by 60%.
         Neither is allowed near 1.0 — a shadow on water darkens TOWARD the sky
         colour, it never goes black.                                        */
      '  refl *= mix(0.80, 1.0, rigSh) * mix(0.88, 1.0, cloudSh);',
      '  refl *= hullRefl(vWorld, Rv);',

      // ================= GGX sun glitter (0.53 deg disc) ==================
      '  vec3 Hv = normalize(L + V);',
      /* Stochastic sub-pixel glint. Toksvig says: fold the slope variance you
         cannot resolve into roughness. That is right for a BROAD source and
         catastrophic for a point one — it is precisely what turns distant
         glitter into an even grey mush. Spend that same variance instead on a
         randomly drawn micro-facet, world-locked to the pixel footprint so the
         sparks stick to the water and foreshorten with it. Identical statistics,
         but the result stays thousands of DISCRETE sparks at any distance. */
      '  float gv = max(varLost, 0.0) + capMss;',
      '  vec2 gcell = mod(floor(pw/max(fp,0.008)) + floor(uTime*9.0)*vec2(37.0,17.0), 2048.0);',
      '  float g1 = max(h21(gcell), 1e-5);',
      '  float g2 = h21(gcell.yx + 91.7);',
      '  float gang = 6.28318530718*g2;',
      '  vec2 gj = vec2(cos(gang), sin(gang))*sqrt(-2.0*log(g1)*gv);',
      '  vec3 Ng = normalize(N + vec3(gj.x, 0.0, gj.y));',
      '  if (dot(Ng, V) < 0.0) Ng = normalize(Ng - V*dot(Ng,V)*1.02);',
      '  float NoL = max(dot(Ng,L), 0.0);',
      '  float NoH = max(dot(Ng,Hv), 0.0);',
      '  float shad = (1.0 - hullShadow(pw)) * clamp(vP2.w, 0.0, 1.0) * rigSh * cloudSh;',
      /* The sun-disc convolution has to be done on the ROUGHNESS, not on its
         square. The old line added the 0.53 deg disc term to alpha*alpha and
         then squared THAT, which made the effective roughness 0.006 instead of
         0.04 - a lobe six times too narrow, so every spark fell between the
         sample points - and then multiplied by an energy factor of ~0.06 on top,
         throwing away 94% of what little was left. Net result: not one
         blown-out highlight anywhere in the frame. Karis' sphere-light
         normalisation, applied to alpha, is the correct form. */
      // The unresolved variance has already been spent on Ng above, so the disc
      // lobe keeps only the 0.53 deg disc plus a small residual for stability.
      /* The 0.30 that used to sit in front of alpha here was the last and worst
         of the three squeezes on the specular lobe. Between it, the mesh-derived
         alpha and the 0.016 floor, the effective GGX width in open water came
         out near 0.009 — a lobe about half a degree across, which the pixel grid
         simply steps over, so not one pixel in either delivered frame clipped.
         The unresolved variance is still spent on Ng (the stochastic glint), so
         a fraction of alpha is the right coefficient — but it is 0.6, not 0.3,
         and alpha itself now has a Cox-Munk floor under it. */
      '  float aSun = 0.00465;',
      '  float aP  = clamp(0.60*alpha + aSun, 1e-3, 1.0);',
      '  float a2  = aP*aP;',
      '  float den = NoH*NoH*(a2-1.0)+1.0;',
      '  float D   = a2/(3.14159265*den*den);',
      '  float Vs  = 0.5/max(NoL*sqrt(NoV*NoV*(1.0-a2)+a2) + NoV*sqrt(NoL*NoL*(1.0-a2)+a2), 1e-4);',
      '  float Fs  = F0 + (1.0-F0)*pow(1.0 - max(dot(Hv,V),0.0), 5.0);',
      /* Circumsolar aureole. The sun is not a bare disc: in tropical marine air
         a few degrees of forward-scattered aerosol halo surround it, carrying a
         percent or two of its energy over a hundred times the solid angle. It is
         a real term and it is the one that puts a legible sheen on the water
         when the disc's own cone is off to the side of the frame - which, for a
         sun 60 deg up, is nearly always. Reflected off the same facets, it is
         what makes a mirror read as a mirror away from the glitter path. */
      /* The aureole is a REAL but SMALL term and it had been dialled up until it
         was doing the job of the glitter path. At 0.105 of extra width and 9.5%
         of the disc's energy it is a lobe tens of degrees across carrying more
         integrated power than the sparkles do, which is exactly the "uniform
         milky whitewash across the whole surface instead of a narrow corridor of
         individual sparkles" the review saw when the camera pointed down-sun.
         Forward-scattered aerosol in clean marine air carries a couple of
         percent of the beam over a few degrees, not a tenth of it over thirty. */
      '  float aH  = clamp(alpha + 0.055, 0.0, 1.0);',
      '  float aH2 = aH*aH;',
      '  float dH  = NoH*NoH*(aH2-1.0)+1.0;',
      '  float DH  = aH2/(3.14159265*dH*dH);',
      // Sparks are allowed to clip hundreds of times over: that is the whole
      // point of an HDR pipeline, and a highlight that cannot reach white does
      // not read as a mirror.
      '  float sunLobe = min(D*Vs, 3.0e4) + min(DH*Vs, 4.0e2)*0.030;',
      '  vec3 spec = uSunCol*(sunLobe*Fs*NoL*uSunE)*(1.0-foam)*shad;',

      // ================= refracted background =============================
      '  vec2 uvS = gl_FragCoord.xy / uRes;',
      '  vec2 uvR = uvS + N.xz*(0.030*min(col,1.8))*(1.0/dist)*vec2(1.0,-1.0);',
      '  if (uHasLinD > 0.5){',
      '    float sd = texture2D(uLinDTex, clamp(uvR,0.001,0.999)).r;',
      '    if (sd < dist - 0.05) uvR = uvS;',
      '  }',
      '  float sunNoL = max(L.y, 0.02);',
      '  vec3 bg;',
      '  if (uHasScene > 0.5) bg = texture2D(uSceneTex, clamp(uvR,0.001,0.999)).rgb;',
      '  else bg = seabedAlbedo(pw, col, fp) * (uSunCol*(uSunE*sunNoL*shad) + uSkyTint*uSkyE) * 0.3183099;',

      // caustics: surface focusing Jacobian x Worley web, chromatic dispersion
      '  if (col < 16.0 && sunUp > 0.02 && uCaustic > 0.001){',
      '    float Jc = 1.0 - col*0.24981*vP3.x;',
      '    float cf = clamp(0.42/(0.15 + Jc), 0.0, 6.0);',
      '    vec2 cp = pw + wd*uTime*0.6;',
      '    vec3 web = vec3(causticF(cp*0.996), causticF(cp), causticF(cp*1.004));',
      '    vec3 ca = web * cf * exp(-col/9.0) * sunNoL * shad * uCaustic;',
      '    bg *= (1.0 + ca*2.2);',
      '  }',

      // ================= water column =====================================
      // Beer-Lambert against the ACTUAL sounding, with Snell-corrected path
      // lengths, plus a volume reflectance bb/(a+bb). Two low-frequency noise
      // fields modulate absorption and backscatter so the open water is never
      // one flat hue: red drops out inside a metre, blue survives forty.
      '  float NoVw = sqrt(max(1.0 - (1.0-NoV*NoV)/1.769, 0.04));',
      '  float sunNoLw = sqrt(max(1.0 - (1.0-sunNoL*sunNoL)/1.769, 0.04));',
      // The sky's irradiance is BLUE, and writing it as a grey scalar is what
      // forced every lit thing on the water - foam most of all - to take the
      // sun's warmth undiluted and come out tan.
      /* The sky term takes a cut too, or the shadow is a flat multiply on one
         lobe and reads as a decal. A cumulus overhead removes a large solid
         angle of sky; the rig removes a small one. Weighted accordingly. */
      /* RIPPLE RELIEF IN THE BODY COLOUR.  At a 2.5 m eye the water three metres
         out sits at forty degrees of depression, so its Fresnel term is about
         0.03 and there is essentially no mirror there to carry ripple. Every
         previous attempt to give that band structure put it in the reflection or
         in a caustic overlay, and both read as something painted ON the water.
         What actually varies down there is how much sunlight each facet lets IN:
         the transmitted irradiance goes as the cosine of the incidence angle on
         the facet, so a ripple face turned toward the sun is a brighter patch of
         BLUE and one turned away is a darker patch of blue. That is relief in
         the medium rather than a texture on the surface, and it costs one
         normalize. Built from the resolved octaves only (sl2Lo), faded out with
         range so it can never alias, and clamped so a steep facet cannot make
         the water glow. */
      '  vec3 Nw = normalize(N0 + vec3(sl2Lo.x, 0.0, sl2Lo.y)',
      '                          *(0.55*resLo*(1.0 - smoothstep(25.0, 150.0, dist))));',
      '  float sunMicro = clamp(max(dot(Nw, L), 0.0)/max(sunNoL, 0.10), 0.42, 1.75);',
      '  vec3 Ed = (uSunCol*(uSunE*sunNoL*0.94*shad*sunMicro)',
      '           + uSkyTint*(uSkyE*0.93*mix(0.82,1.0,rigSh)*mix(0.58,1.0,cloudSh)))*waveAO;',
      '  float wm  = vn2(pw*0.0042);',
      '  float wm2 = vn2(pw*0.0131 + 11.3);',
      '  vec3 aK = uAbsK*(0.86 + 0.30*wm);',
      '  vec3 bK = uScatK*(0.68 + 0.90*wm2);',
      // Over a sand shelf the bottom and the suspended carbonate throw light
      // straight back out, which is what turns Caribbean water turquoise in
      // three metres and leaves it indigo in forty. Driven by the real sounding,
      // so the gradient is geometry, not a painted texture.
      /* THE BATHYMETRY RAMP. One hue across the whole field removes every depth
         cue the water has, which is most of why it reads as an infinite plane of
         one material rather than a liquid with volume under it. Driven off the
         real sounding (col is the actual water column at this pixel), the ramp
         runs turquoise over sand inside three metres, teal through the ten-metre
         contour, and indigo past thirty — and because green is lifted harder
         than blue on the shelf, G overtakes B exactly where a sand bottom would
         make it. There is also a small green floor everywhere: even in 60 m the
         tropics are not the North Sea. */
      '  float shelf  = 1.0 - smoothstep(1.0, 30.0, col);',
      '  float shelf2 = shelf*shelf;',
      '  bK *= 1.0 + vec3(1.10, 3.20, 2.10)*shelf + vec3(0.30, 2.60, 1.30)*shelf2;',
      /* ...and the OTHER end of the ramp, which was missing entirely. The shelf
         boost above lifts green over sand, but past the thirty-metre contour the
         old model just stopped changing: bb/(a+bb) stayed at (0.005, 0.116,
         0.176) forever, so 40 m and 600 m of water were the same bright cyan and
         the whole sea read as one flat mid-blue. Deep water is not the shallows
         with the bottom removed — the particulate load that carries the green
         backscatter is a shelf phenomenon, and offshore it is gone. Rolling
         green down twice as hard as blue over 16-55 m takes the volume
         reflectance to (0.0045, 0.068, 0.152), green at 45% of blue, which is
         the indigo the review asked for; and because the total drops as well the
         deep water darkens, which is what finally lets the sky mirror read
         BRIGHTER than the body instead of competing with it. */
      '  float deepf = smoothstep(16.0, 55.0, col);',
      '  bK *= 1.0 - vec3(0.10, 0.42, 0.14)*deepf;',
      '  vec3 ext = aK + bK;',
      '  vec3 Rw  = bK/ext;',
      '  float pathB = col*(1.0/max(NoVw,0.26) + 1.0/max(sunNoLw,0.26));',
      '  vec3 Tb = exp(-ext*min(pathB, 160.0));',
      '  vec3 body = bg*Tb + Rw*(Ed*0.3183099)*(1.0 - Tb);',
      // Sunlight focused by the surface into sheets a metre or two down. This
      // is the detail that keeps the steep near field from reading as a void.
      /* Two scales, because this is now carrying the near-field detail energy on
         its own. The sky reflection cannot: at a 2.5 m eye the water three
         metres out is at 40 degrees of depression, so its Fresnel term is 0.03
         and there is essentially no mirror to put ripple into. What a real lens
         sees down there is the light the surface has FOCUSED into the water —
         a coarse sheet structure a couple of metres across, and a fine one at a
         few tens of centimetres. Both are multiplicative on the body colour, so
         they read as blue-on-blue relief rather than as white speckle, which is
         why this is the right place to spend the foreground's detail budget. */
      /* THE FOREGROUND STIPPLE.  This used to run in any depth of water, and
         causticF is pow(1-worley, 8) — a field of hard bright dots. Over 56 m
         of open ocean there is nothing for the surface to focus light ONTO, so
         what the review counted as "a regular dot/speckle field magnified past
         its Nyquist limit" in the near water was a shallow-water term firing in
         the abyss. Caustic sheets are only visible where the column is short
         enough for the focused light to be scattered back out before it
         diverges again, so the whole term is now gated on the real sounding and
         is gone by the thirty-metre contour. The near field's detail energy
         lives in the capillary end of the slope cascade instead, where it
         belongs, and it shows up through the specular and the mirror. */
      '  float shal = 1.0 - smoothstep(7.0, 30.0, col);',
      '  if (uCaustic > 0.001 && dist < 130.0 && sunUp > 0.02 && shal > 0.01){',
      '    float shim = causticF(pw*0.62 + wd*(uTime*0.45));',
      '    float shimF = causticF(pw*2.35 + wd*(uTime*0.80) + 7.3);',
      '    float nf = exp(-dist/55.0)*sunNoL*shad*uCaustic*shal;',
      '    body *= 1.0 + (1.55*shim + 0.95*shimF*smoothstep(24.0, 5.0, dist))*nf;',
      '  }',

      // ================= subsurface transmission ==========================
      // Thin, backlit crests glow jade. Thickness comes from height above the
      // mean plane times the stretch of the fold; it is zero in troughs.
      // The old gate required the view to be within a few degrees of directly
      // down-sun AND the face to be turned away AND the crest to be high, all
      // multiplied together, so in practice it never fired and the water had no
      // "translucent volume" cue at all. Wrap lighting over the whole crest,
      // strongest when backlit, is both cheaper and closer to what a thin sheet
      // of water actually does.
      /* Backlit crests. After the glitter path this is the second most
         recognisable signature of tropical water, and the old form was gated so
         tightly (0.026, and a fourth-power forward lobe on top of a wrap term on
         top of a face term) that it never fired: every wave in both delivered
         frames was a fully opaque lit solid, which is a large part of why the
         surface read as painted vinyl rather than a liquid with volume.
         Thickness is height above the mean plane times the stretch of the fold —
         zero in troughs, largest exactly where a crest is thinning as it throws
         over. The lobe is split into a strong down-sun transmission term and a
         genuinely visible wrapped floor, so a crest glows on its up-sun face at
         any camera azimuth instead of only when the sun is dead ahead. */
      '  vec3 sss = vec3(0.0);',
      '  if (sunUp > 0.01){',
      '    float hh = clamp((vWorld.y + 0.18*uHs)/max(0.85*uHs, 0.30), 0.0, 1.5);',
      '    float stretch = clamp((1.0-J)*1.7, 0.0, 1.0);',
      '    float thin = hh*hh*(0.34 + 0.66*stretch);',
      '    float fwd = pow(clamp(dot(V,-L)*0.5 + 0.5, 0.0, 1.0), 3.0);',
      // the sun has to be BEHIND the crest relative to the eye for light to
      // transmit through it: the face is turned away from us and toward the sun
      '    float back = clamp(0.42 + 0.58*(dot(normalize(vec3(L.x,0.0,L.z) + vec3(1e-4,0.0,0.0)), -normalize(vec3(V.x,0.0,V.z) + vec3(1e-4,0.0,0.0)))*0.5 + 0.5), 0.0, 1.0);',
      '    float wrap = clamp((dot(N0,L) + 0.62)/1.62, 0.0, 1.0);',
      // steep faces are the thin ones; a flat back is opaque
      '    float face = smoothstep(0.015, 0.30, length(N0.xz));',
      /* 0.082 was the last of four multiplied gates and it kept the term at the
         noise floor: not one wave face in either delivered frame was lit through
         from behind, so every crest read as an opaque lit solid. A thin sheet of
         Caribbean water over a metre of path is genuinely translucent, and the
         green-turquoise glow at the lip is the second most recognisable
         signature the medium has after the glitter path. */
      '    sss = uSSSCol*(thin*face*(0.55 + 2.60*fwd)*back*(0.30 + 0.70*wrap)',
      '                   *uSunE*sunUp*0.230*shad*(1.0 - 0.85*foam));',
      '  }',

      // ================= composite ========================================
      '  vec3 c = body*(1.0-F) + refl*F + spec + sss;',
      /* Contact darkening at the waterline and under the aeration. A hull sits
         IN the water: it blocks sky from the few metres around it, and the
         entrained air astern kills the volume reflectance that gives open water
         its blue. Applied after the composite so it takes the reflection down
         too — that is the part that actually reads as contact. */
      '  c *= mix(1.0, 0.52, wline*0.80);',
      '  c *= mix(1.0, 0.74, churn*0.55);',

      // foam: bubble granularity, wrapped diffuse, high albedo
      '  if (foam > 0.001){',
      '    float wl = (max(dot(N0,L),0.0)*0.72 + 0.28)*waveAO;',
      /* Foam albedo must be ACHROMATIC. A bubble raft is white; it looks warm
         only because it is lit by a warm sun. The previous line took an already
         slightly warm albedo, multiplied it by a sun colour of (1, 0.91, 0.78)
         and added a GREY sky fill, which landed the raft at 1 : 0.87 : 0.77 -
         sandy khaki, reading as scum or pollen slick rather than whitecap.
         Neutral albedo, luminance-normalised sun tint at partial strength, and
         a properly blue sky fill put it back where it belongs. */
      '    vec3 sunN = uSunCol/max(dot(uSunCol, vec3(0.2126,0.7152,0.0722)), 1e-3);',
      /* Fresh whitecap foam is a dense air-water scattering medium and it is the
         brightest thing in a seascape — near 0.95 neutral, and in direct sun it
         should go straight through the top of the tonemapper. The old raft sat
         at 0.90 x (0.52..1.0) x a 55% warm mix, which after the ageing multiply
         landed grey-tan: scum, not whitecap. Neutral-to-cool albedo, only a
         quarter of the sun's warmth, and a deliberate over-drive on ACTIVELY
         breaking foam so the crest clips. */
      '    vec3 fAlb = vec3(0.95)*(0.68 + 0.32*bubT);',
      // Ageing: the raft thins, drains and starts showing the water through it,
      // so old foam is dimmer, bluer and far less opaque than a breaking crest.
      '    fAlb *= mix(1.0, 0.58, fAge);',
      '    vec3 fLit = mix(vec3(1.0), sunN, 0.28)*(uSunE*wl*shad) + uSkyTint*(uSkyE*1.30);',
      '    vec3 fc = fAlb*fLit*0.3183099;',
      // shadowed inter-bubble volume, tinted by the water it is standing in: it
      // is what gives a raft depth instead of reading as a flat white decal
      '    fc = mix(fc*0.62 + body*0.16, fc, 0.42 + 0.58*bubT);',
      '    fc = mix(fc, fc*vec3(0.84,0.96,1.10), fAge);',
      '    fc *= mix(1.0, 1.55, fresh*(1.0 - fAge));',
      '    c = mix(c, fc, foam*(0.80 + 0.20*bubT)*mix(1.0, 0.58, fAge));',
      '  }',

      // ================= aerial perspective ===============================
      // Real transmittance from the same atmosphere the sky is drawn with, so
      // the last few km lift and desaturate toward the horizon.
      //
      // The stock applyAerial() cannot be used here: for a near-horizontal view
      // ray it samples the in-scatter BELOW the horizon, where the sky-view LUT
      // is essentially black, so it darkens the distant sea by ~20% instead of
      // lifting it - which is precisely the hard dark step at the skyline. The
      // air along a horizontal ray is lit like the sky just above the horizon,
      // so that is what has to be scattered in.
      '  vec3 hz = skyRadianceNoSun(normalize(vec3(-V.x, 0.0035, -V.z)), L);',
      '  vec3 Ta = sailAerialTransmittance(vWorld, uCam);',
      '  c = c*Ta + hz*(vec3(1.0) - Ta);',
      /* Haze convergence onto the sky. The old ramp keyed on the depression
         angle over 0.00055..0.0055, which for a 2.5 m eye is 455 m to 4.5 km -
         it was fogging out the entire mid-field into flat sky colour, and the
         top of that ramp is the hard tonal seam that crossed the water at about
         a third of frame height. Key on distance scaled by the eye's own
         horizon range (which goes as sqrt(height)) so the blend lands in the
         same place relative to the skyline for a 2.5 m cockpit and a 12 m
         masthead alike, and cap it below 1 so near-horizon crests keep
         modulating the line instead of being erased into it. */
      /* The old ramp ran 0.45*hzD to 2.6*hzD — 1620 m to 9360 m at a 2.5 m eye,
         against a geometric horizon of 5.6 km. The water therefore arrived at
         the skyline only 44% converged and FOG was doing the job Fresnel should
         have been doing, which is what made the mid-field a flat grey plate.
         Now that the ring law and the mid-band re-injection put real geometry
         back out there, tighten it so the haze is the last kilometre, not the
         last six. */
      /* Converging 80% of the way onto a hazy horizon radiance is what turned the
         near-horizon band into a neutral grey plate (measured 180/188/190, mean
         saturation 0.19) and buried the sky MIRROR under fog. Fresnel already
         takes the water to the sky at the vanishing line; the haze only has to
         cover the last kilometre and it must not fully erase the colour that
         Fresnel put there. */
      '  float gz = 0.55*smoothstep(0.42*hzD, 1.30*hzD, dist);',
      '  gz = max(gz, smoothstep(0.0, 1.0, vP1.z));',
      '  c = mix(c, hz, gz);',
      /* The wind line. Just short of the horizon the mirror angle shifts onto a
         darker, more saturated part of the sky and the far chop stops catching
         the sun, so a real sea carries a slightly darker, bluer band under the
         skyline. It is also what stops the last few hundred metres reading as a
         single flat value butted against a razor edge. */
      '  float wl2 = smoothstep(0.55*hzD, 1.05*hzD, dist)*(1.0 - smoothstep(1.05*hzD, 2.10*hzD, dist));',
      '  c *= mix(vec3(1.0), vec3(0.870, 0.935, 1.020), wl2);',

      // break up 8-bit banding in the smooth far-field gradient
      '  c *= 1.0 + (h21(gl_FragCoord.xy + fract(uTime)) - 0.5)*0.0045;',

      '  if (uDebug > 0.5){',
      '    if (uDebug < 1.5) c = vec3(foam)*8.0;',
      '    else if (uDebug < 2.5) c = refl*F;',
      '    else if (uDebug < 3.5) c = body*(1.0-F);',
      '    else if (uDebug < 4.5) c = spec;',
      '    else if (uDebug < 5.5) c = vec3(F)*8.0;',
      '    else c = vec3(length(sl2))*20.0;',
      '  }',
      '  float alpha2 = (uHasScene > 0.5) ? 1.0 : clamp(mix(0.55, 1.0, smoothstep(0.05, 3.0, col)) + foam, 0.0, 1.0);',
      '  float l = dot(c, vec3(0.333));',
      '  if (!(l < 1e5)) c = vec3(0.0);',
      '  gl_FragColor = vec4(min(max(c, vec3(0.0)), vec3(12000.0)), alpha2);',
      '}'
    ].join('\n');
  }

  /* =======================================================================
     9.  BUILD
     ======================================================================= */
  var renderer = null, sceneRef = null, curLow = false;
  var uW = [];
  var sunDir = new THREE.Vector3(0.35, 0.86, -0.37);
  var skyRecalc = -1e9, lastSunY = -9;

  function makeMaterial(low) {
    var i;
    uW = [];
    for (i = 0; i < MAXC * 2; i++) uW.push(new THREE.Vector4(0, 0, 0, 1));
    var u = {
      uTime: { value: 0 },
      uCam: { value: new THREE.Vector3() },
      uSunDir: { value: sunDir.clone() },
      uSunCol: { value: new THREE.Color(1, 0.96, 0.90) },
      uSunE: { value: 100.0 },
      uSkyE: { value: 12.0 },
      // chromaticity of the sky's hemispherical irradiance, normalised to
      // luminance 1 — the counterweight that keeps sunlit foam from going tan
      uSkyTint: { value: new THREE.Vector3(0.72, 0.92, 1.42) },
      uDrift: { value: new THREE.Vector2(0, 0) },
      uSkyScale: { value: 1.0 },
      uSkyFloor: { value: new THREE.Vector3(0, 0, 0) },
      uTurb: { value: 2.6 },
      uU10: { value: 8.0 },
      uHs: { value: 1.2 },
      uShadowOn: { value: 0.0 },
      uDetMss: { value: 0.02 },
      uMeshMss: { value: 0.02 },
      uDetNorm: { value: O.detNorm || 1.6 },
      uFoamHi: { value: 0.62 },
      uFoamLo: { value: 0.06 },
      uFoamGain: { value: 1.0 },
      // Jerlov type-I/IB seawater. uAbsK is absorption + forward loss per metre
      // (red gone in ~1 m, blue survives ~40); uScatK is the backscatter that
      // sets the volume reflectance bb/(a+bb) - the colour the water itself is.
      /* GRENADA, NOT THE CHANNEL IN MARCH.
         The old pair gave a volume reflectance bb/(a+bb) of (0.005, 0.067,
         0.148): green at 45% of blue, which is cobalt-into-navy — a cold
         temperate sea. Caribbean water is Jerlov IB/II, not oceanic I: there is
         more particulate backscatter and less green absorption, so the volume
         reflectance runs (0.005, 0.116, 0.176) — green at 66% of blue — and over
         the shelf the carbonate-sand bounce pushes green PAST blue, which is
         where the turquoise comes from. Red still dies inside a metre. */
      uAbsK: { value: new THREE.Vector3(0.400, 0.0520, 0.0290) },
      uScatK: { value: new THREE.Vector3(0.0020, 0.0068, 0.0062) },
      uSSSCol: { value: new THREE.Vector3(0.050, 0.640, 0.560) },
      /* z drops from 0.42 to 0.20: the Fresnel WEIGHT is an expectation over the
         pixel's whole slope distribution, and point-sampling it with the micro
         normal is what stamped the marbled filament texture inside every bright
         grazing band. The reflection DIRECTION still carries the full resolved
         slope (Nb), so the mirror is still broken up by ripple — but how much of
         it is reflected is now decided by a normal close to the macro surface,
         which is what the geometric-masking argument actually implies. */
      /* x/y drop from 0.10/0.80 to 0.02/0.12. This is the amount of micro-slope
         the SKY lobe's normal is allowed to carry, and at 0.90 in the near field
         it was swinging the mirror direction by five to ten degrees per pixel
         across a sky whose radiance triples between two and twenty degrees of
         elevation. The result was the striated, brushed-metal "wood grain"
         inside every bright grazing sheet — measured directly by forcing kb to
         zero, which cleaned the mid-field up completely and left the water
         glassy. 0.14 keeps a legible ripple in the mirror without turning the
         reflection into a per-pixel lottery; the mid-band carrier (midR, below)
         supplies the larger-scale mirror modulation on its own budget.
         z: the Fresnel WEIGHT is an expectation over the pixel's whole slope
         distribution, and point-sampling it with the micro normal marbled the
         reflectance itself. The reflection DIRECTION still carries the full
         resolved slope; how much is reflected is now decided by a normal close
         to the macro surface, which is what the masking argument implies. */
      uTune: { value: new THREE.Vector4(0.02, 0.12, 0.20, 4.0) },
      uDebug: { value: 0 },
      uCaustic: { value: low ? 0.0 : 1.0 },
      uRes: { value: new THREE.Vector2(1280, 800) },
      uWindDir: { value: new THREE.Vector2(1, 0) },
      uGustOfs: { value: gustOfs },
      uGustInv: { value: 1.0 / GUST_M },
      uWakeC: { value: new THREE.Vector2(0, 0) },
      uWakeR: { value: WK ? WK.R : 200 },
      uHasScene: { value: 0.0 },
      uHasLinD: { value: 0.0 },
      uHull0: { value: new THREE.Vector4(0, 0, 9, 5) },
      uHull1: { value: new THREE.Vector4(0, 1, 0, 0) },
      // boat state for the analytic Kelvin wake / bow wave / transom churn
      uBoatP: { value: new THREE.Vector4(0, 0, 0, -1) },   // x, z, fwdX, fwdZ
      uBoatQ: { value: new THREE.Vector4(0, 1, 3.005, 0) },// V, k0=g/V^2, halfBeam, on
      uBoatR: { value: new THREE.Vector4(0, 0, 6.4, 8.4) },// amp, churn, srcStation, transomStation
      uGrp0: { value: (uGrp0v = new THREE.Vector4(grpF[0], grpF[1], grpF[2], grpF[3])) },
      uGrp1: { value: (uGrp1v = new THREE.Vector4(grpF[4], grpF[5], grpF[6], grpF[7])) },
      // the rig cascade, published by app.js (SAIL.rigShadow)
      uRigMap: { value: null },
      uRigMat: { value: new THREE.Matrix4() },
      uRigOn: { value: 0 },
      uRigTexel: { value: 1 / 2048 },
      uRigBias: { value: 0.0004 },
      uRigStr: { value: 1 },
      uCloudAmt: { value: 0.35 },
      uDepthTex: { value: DG ? DG.tex : null },
      uDepthRect: { value: DG ? new THREE.Vector4(DG.x0, DG.z0, DG.ix, DG.iz) : new THREE.Vector4(0, 0, 1e-4, 1e-4) },
      uDetailTex: { value: O.detailTex || null },
      uGustTex: { value: gustTex },
      uWakeTex: { value: (WK && WK.ok && WK.a) ? WK.a.texture : (WK ? WK.fallback : null) },
      uSceneTex: { value: null },
      uLinDTex: { value: null },
      uW: { value: uW }
    };
    var mat = new THREE.ShaderMaterial({
      uniforms: u,
      defines: { NDISP: NDISP },
      vertexShader: vertexShader(),
      fragmentShader: fragmentShader(low),
      transparent: true, depthWrite: true, depthTest: true,
      side: THREE.FrontSide, toneMapped: false, fog: false
    });
    mat.extensions = { derivatives: true };
    // binds uSkyLUT / uSkyTransLUT / uSkyCloudLUT — without it the sky chunk's
    // samplers are unbound and every reflection comes back black
    if (skyIsModule && SAIL.sky && SAIL.sky.register) {
      try { SAIL.sky.register(mat); } catch (e) { }
    }
    return mat;
  }

  function envRead() {
    var e = SAIL.env || {};
    var wx = e.windX, wz = e.windZ;
    if (wx === undefined || wz === undefined) {
      var kn = e.windKn !== undefined ? e.windKn : 14;
      var dd = (e.windDirDeg !== undefined ? e.windDirDeg : 75) + 180;   // FROM -> TOWARD
      var ms = kn * 0.514444;
      wx = Math.sin(dd * Math.PI / 180) * ms;
      wz = -Math.cos(dd * Math.PI / 180) * ms;
    }
    var U10 = Math.hypot(wx, wz);
    if (!(U10 > 0.05)) { wx = 1e-3; wz = 0; U10 = 0.05; }
    return { wx: wx, wz: wz, U10: U10, swell: e.swellM !== undefined ? e.swellM : 0.7 };
  }

  O.build = function (scene, rend) {
    try {
      sceneRef = scene;
      renderer = rend || SAIL.renderer || null;
      curLow = SAIL.quality === 'low';

      buildDepthGrid(curLow);
      buildGust();
      buildWake(curLow);
      if (renderer) { try { O.detailTex = buildDetailTex(renderer); } catch (e) { O.detailTex = null; } }

      var en = envRead();
      buildSpectrum(en.U10, en.swell, { x: en.wx, z: en.wz }, O.swellFromDeg || 300, curLow);
      O.comp.set(compTarget);

      O.geometry = buildGeometry(curLow);
      O.material = makeMaterial(curLow);
      pushComps();

      O.mesh = new THREE.Mesh(O.geometry, O.material);
      O.mesh.frustumCulled = false;
      O.mesh.renderOrder = 5;
      O.mesh.castShadow = false; O.mesh.receiveShadow = false;
      O.mesh.name = 'ocean';
      if (scene) scene.add(O.mesh);

      O.ready = true;
      updateSky(true);
      if (renderer) { O.calibrateFoam(); O.selfTest(); }
    } catch (err) {
      if (window.console) console.warn('[SAIL.ocean] build failed:', err);
      O.ready = false;
    }
    return O;
  };

  O.rebuild = function () {
    if (!sceneRef) return O;
    var low = SAIL.quality === 'low';
    if (low === curLow) return O;
    curLow = low;
    if (O.mesh) { sceneRef.remove(O.mesh); }
    if (O.geometry) O.geometry.dispose();
    if (O.material) O.material.dispose();
    buildWake(curLow);
    var en = envRead();
    buildSpectrum(en.U10, en.swell, { x: en.wx, z: en.wz }, O.swellFromDeg || 300, curLow);
    O.comp.set(compTarget);
    O.geometry = buildGeometry(curLow);
    O.material = makeMaterial(curLow);
    pushComps();
    O.mesh = new THREE.Mesh(O.geometry, O.material);
    O.mesh.frustumCulled = false; O.mesh.renderOrder = 5;
    O.mesh.castShadow = false; O.mesh.receiveShadow = false;
    sceneRef.add(O.mesh);
    updateSky(true);
    if (renderer) O.calibrateFoam();
    return O;
  };

  function pushComps() {
    if (!O.material) return;
    var C = O.comp;
    for (var i = 0; i < MAXC; i++) {
      var o = i * 8;
      uW[i * 2].set(C[o], C[o + 1], C[o + 2], Math.max(C[o + 3], 1e-4));
      uW[i * 2 + 1].set(C[o + 4], C[o + 5], C[o + 6], C[o + 7]);
    }
    var u = O.material.uniforms;
    u.uFoamHi.value = O.foamHi;
    u.uFoamLo.value = O.foamLo;
    u.uFoamGain.value = O.foamGain === undefined ? 1 : O.foamGain;
    u.uHs.value = O.Hs;
    u.uU10.value = O.U10;
    u.uDetNorm.value = O.detNorm || 1.6;
    /* Split the Cox-Munk mean-square slope between what the mesh already
       carries and what the detail map has to supply. Feeding the detail map the
       REMAINDER (rather than a hand-tuned strength) is what keeps the sea from
       looking like crinkled foil in light air and like glass in a gale. */
    var cm = 0.003 + 5.12e-3 * O.U10;
    /* O.chopRms is band C — 12% of the wind-sea significant height, built,
       normalised and packed every frame and then thrown away, because the
       displacement loop bound is NDISP and band C sits past it. It is the
       0.5-2.2 m chop, exactly the band the detail map stands in for, so its
       energy belongs here as a floor rather than in the bin. */
    /* The remainder is taken in FULL (it used to be scaled by 0.85, which threw
       away 15% of the Cox-Munk budget on top of everything the shading was
       already losing). mesh + detail now sums to the measured law exactly, and
       O.coxMunkMss / O.totalMss are published so selfTest can assert it. */
    var det = clamp(Math.max(cm - (O.meshMss || 0),
                             (O.chopRms || 0) * (O.chopRms || 0) * 3.2), 0.0035, 0.060);
    u.uDetMss.value = det;
    u.uMeshMss.value = clamp(O.meshMss || 0, 0, 0.09);
    O.coxMunkMss = cm;
    O.totalMss = (O.meshMss || 0) + det;
    O.material.uniformsNeedUpdate = true;
  }

  /* =======================================================================
     10.  PER-FRAME UPDATE
     ======================================================================= */
  var lastU10 = -1, lastWdir = -9, lastSwell = -1, blend = 1, retargetIn = 0, auditDue = false;

  function updateSky(force) {
    if (!O.material) return;
    var u = O.material.uniforms;
    var sd = (SAIL.sky && SAIL.sky.sunDir) || (SAIL.env && SAIL.env.sunDir) || null;
    if (sd && sd.isVector3) sunDir.copy(sd).normalize();
    u.uSunDir.value.copy(sunDir);
    var e = SAIL.env || {};
    u.uSunE.value = e.sunE !== undefined ? e.sunE : 100 * clamp(sunDir.y * 1.25, 0.0, 1.0);
    u.uSkyE.value = e.skyE !== undefined ? e.skyE : 12 * clamp(sunDir.y * 2.2 + 0.08, 0.02, 1.0);
    if (e.sunColor && e.sunColor.isColor) u.uSunCol.value.copy(e.sunColor);
    /* Sky-irradiance chromaticity, normalised to luminance 1 so it carries hue
       without touching the energy budget (uSkyE already holds that). Prefer the
       sky module's own integrated colour; fall back to a daylight-blue that
       warms through twilight. This is what balances the sun's warmth on foam. */
    var sc = (SAIL.sky && SAIL.sky.skyColor && SAIL.sky.skyColor.isColor) ? SAIL.sky.skyColor : null;
    var tr = 0.72, tg = 0.92, tb = 1.42;
    if (sc) {
      var lum = 0.2126 * sc.r + 0.7152 * sc.g + 0.0722 * sc.b;
      if (lum > 1e-4) { tr = sc.r / lum; tg = sc.g / lum; tb = sc.b / lum; }
    } else {
      var warm = clamp(1.0 - sstep(-0.05, 0.30, sunDir.y), 0, 1);
      tr = 0.72 + 0.42 * warm; tg = 0.92 + 0.06 * warm; tb = 1.42 - 0.40 * warm;
    }
    u.uSkyTint.value.set(clamp(tr, 0.3, 2.2), clamp(tg, 0.3, 2.2), clamp(tb, 0.3, 2.6));
    // wave self-shadowing only earns its vertex cost once the sun is low enough
    // for crests to actually occlude one another
    // Crests occlude one another at ANY sun altitude — the shadows are simply
    // shorter as the sun climbs (the march scales itself accordingly). Gating
    // this off above 38 degrees is why the noon presets had no crest-lit /
    // trough-dark separation at all.
    u.uShadowOn.value = (!curLow && sunDir.y > -0.10) ? 1.0 : 0.0;
    /* The rig cascade. app.js owns the depth target, its framing and its
       commit cadence; all this does is bind it. Kept here rather than in
       O.update so the settle path and the live path pick it up identically. */
    var RS = SAIL.rigShadow;
    if (RS && RS.on && RS.map) {
      u.uRigMap.value = RS.map;
      u.uRigMat.value.copy(RS.matrix);
      u.uRigTexel.value = RS.texel;
      u.uRigBias.value = RS.bias;
      u.uRigStr.value = RS.strength;
      u.uRigOn.value = 1;
    } else {
      u.uRigOn.value = 0;
    }
    u.uCloudAmt.value = clamp(e.cloudCover === undefined ? 0.35 : e.cloudCover, 0, 1);
    if (skyIsModule) return;         // the sky module owns the radiance field
    if (force || Math.abs(sunDir.y - lastSunY) > 0.006) {
      lastSunY = sunDir.y;
      var Ep = skyIrradiance(u.uTurb.value, Math.max(sunDir.y, 0.0));
      var ext = (SAIL.sky && typeof SAIL.sky.radianceScale === 'number') ? SAIL.sky.radianceScale : 0;
      var base = ext > 0 ? ext : clamp(u.uSkyE.value / Math.max(Ep, 1e-4), 1e-6, 1e4);
      /* Preetham clamps the sun to the horizon once it sets, so below the
         horizon it keeps producing a (dim) SUNSET - warm, red-biased. Cross-fade
         it out over civil twilight and hand over to a blue night sky whose own
         hemispherical integral is uSkyE, so the units stay continuous. */
      var night = clamp(1.0 - sstep(-0.16, -0.01, sunDir.y), 0, 1);
      u.uSkyScale.value = base * (1.0 - night);
      var nl = u.uSkyE.value * 0.408 * night;      // L such that pi*L*0.78 = E
      u.uSkyFloor.value.set(0.715 * nl, 0.985 * nl, 1.987 * nl);
    }
  }

  O.update = function (t, dt, camera) {
    if (!O.ready || !O.material) return;
    dt = clamp(dt || 0.016, 0, 0.1);
    tHold = t;
    cacheT = -1e9;
    if ((SAIL.quality === 'low') !== curLow) O.rebuild();

    var u = O.material.uniforms;
    var en = envRead();

    // ---- spectrum retarget (wavelengths fixed, so the cross-fade is safe)
    var wdir = Math.atan2(en.wx, -en.wz);
    // Cooldown matters: gust noise crosses any speed threshold constantly, and
    // a retarget costs ~0.3 ms. The cross-fade hides the staircase.
    retargetIn -= dt;
    if (lastU10 < 0 || (retargetIn <= 0 && (Math.abs(en.U10 - lastU10) > 0.35 ||
        Math.abs(Math.atan2(Math.sin(wdir - lastWdir), Math.cos(wdir - lastWdir))) > 0.045 ||
        Math.abs(en.swell - lastSwell) > 0.06))) {
      lastU10 = en.U10; lastWdir = wdir; lastSwell = en.swell; retargetIn = 0.75;
      buildSpectrum(en.U10, en.swell, { x: en.wx, z: en.wz }, O.swellFromDeg || 300, curLow);
      blend = 0; auditDue = true;
    }
    /* One measurement per completed retarget, not per frame: the calibration
       ratio is reused across wind speeds, and this is what proves it still
       holds. A readback costs a pipeline stall, so it happens on the frame a
       cross-fade finishes and never again until the weather changes. */
    if (blend >= 1 && auditDue && renderer) { auditDue = false; O.foamAudit(); }
    if (blend < 1) {
      blend = Math.min(1, blend + dt / 2.5);
      var a = 1 - Math.exp(-dt / 0.8);
      for (var i = 0; i < MAXC * 8; i++) {
        // direction, amplitude and Q slew; k, w and phase are identical by construction
        if ((i % 8) === 3 || (i % 8) === 4 || (i % 8) === 6 || (i % 8) === 7) O.comp[i] = compTarget[i];
        else O.comp[i] += (compTarget[i] - O.comp[i]) * a;
      }
      pushComps();
    }

    // ---- gust field scroll (world drifts with the true wind)
    gustOfs.x += en.wx * dt; gustOfs.y += en.wz * dt;
    if (Math.abs(gustOfs.x) > 1e6) gustOfs.x = 0;
    if (Math.abs(gustOfs.y) > 1e6) gustOfs.y = 0;

    var cx = camera ? camera.position.x : 0, cz = camera ? camera.position.z : 0;
    O.mesh.position.set(cx, 0, cz);
    O.mesh.updateMatrixWorld(true);

    u.uTime.value = t;
    if (camera) u.uCam.value.copy(camera.position);
    var iw = 1 / Math.max(en.U10, 1e-3);
    u.uWindDir.value.set(en.wx * iw, en.wz * iw);
    u.uU10.value = en.U10;
    // Surface drift = current + ~2.5% of the true wind. Foam rafts are born at a
    // crest and then carried by this; the vertex stage walks back along it to
    // find where each ageing tap was created.
    var ev = SAIL.env || {};
    u.uDrift.value.set((ev.curX || 0) + en.wx * 0.025, (ev.curZ || 0) + en.wz * 0.025);

    if (renderer) {
      var sz = renderer.getDrawingBufferSize ? renderer.getDrawingBufferSize(new THREE.Vector2()) : null;
      if (sz && sz.x > 0) u.uRes.value.copy(sz);
    }

    /* ---- boat state for the analytic wake -------------------------------
       Read straight from SAIL.boat rather than waiting to be pushed: the
       Kelvin field needs position, heading AND speed every frame, and the only
       hook app.js offers (setHullShadow) carries neither speed nor thrust. */
    var B = SAIL.boat;
    if (B && B.x === B.x && B.z === B.z && B.heading === B.heading) {
      var V = Math.hypot(B.u || 0, B.v || 0);
      var hh = B.heading || 0;
      var on = V > 0.55 ? 1 : 0;
      u.uBoatP.value.set(B.x, B.z, Math.sin(hh), -Math.cos(hh));
      // k0 = g/V^2 is the fundamental wavenumber of a Kelvin pattern; the
      // transverse wavelength is 2*pi*V^2/g, i.e. 13 m at 8 kn.
      u.uBoatQ.value.set(V, GRAV / Math.max(V * V, 0.6), 3.005, on);
      var wash = B.thrust ? clamp((Math.abs(B.thrust[0]) + Math.abs(B.thrust[1])) / 5200, 0, 1) : 0;
      // wave height scales with V^2; capped well below the Gerstner steepness
      // limit because this rides ON TOP of the sea state
      u.uBoatR.value.set(clamp(0.021 * V * V, 0, 0.40),
                         clamp(0.32 * clamp(V / 4.0, 0, 1) + 0.75 * wash, 0, 1), 6.4, 8.4);
      feedCusp(dt);
    } else {
      u.uBoatQ.value.w = 0;
    }

    updateSky(false);
    stepWake(dt, cx, cz, en.wx, en.wz);
  };

  /* ------------------------------------------------------------ hooks ---- */
  O.setSceneTargets = function (colorTex, linDepthTex) {
    if (!O.material) return;
    O.material.uniforms.uSceneTex.value = colorTex || null;
    O.material.uniforms.uLinDTex.value = linDepthTex || null;
    O.material.uniforms.uHasScene.value = colorTex ? 1.0 : 0.0;
    O.material.uniforms.uHasLinD.value = linDepthTex ? 1.0 : 0.0;
  };
  // Soft hull shadow on the water. Pass the SHADOW's centre (hull position
  // projected along the sun direction), the half-length/half-beam of the
  // shadow ellipse, the heading unit vector and a strength in 0..1.
  O.setHullShadow = function (x, z, halfLen, halfBeam, fwdX, fwdZ, strength) {
    if (!O.material) return;
    O.material.uniforms.uHull0.value.set(x, z, Math.max(halfLen, 0.2), Math.max(halfBeam, 0.2));
    O.material.uniforms.uHull1.value.set(fwdX, fwdZ, clamp(strength, 0, 1), 0);
  };
  // Term isolation for diagnosis; see the uDebug note in the fragment shader.
  O.setDebug = function (n) { if (O.material) O.material.uniforms.uDebug.value = n || 0; };
  O.setTurbidity = function (T) { if (O.material) { O.material.uniforms.uTurb.value = clamp(T, 1.7, 8); lastSunY = -9; } };
  O.setSize = function (w, h) { if (O.material) O.material.uniforms.uRes.value.set(w, h); };

  /* =======================================================================
     11.  BOOT SELF-TEST  —  GPU vertex displacement vs the CPU mirror
     ======================================================================= */
  O.selfTest = function () {
    if (!renderer || !O.material) return null;
    var rt = null, mat = null;
    try {
      var ox = 900.0, oz = -1400.0, sp = 23.0;    // offshore: deep water, no bathymetry mismatch
      rt = new THREE.WebGLRenderTarget(4, 4, {
        type: THREE.UnsignedByteType, format: THREE.RGBAFormat,
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
        depthBuffer: false, stencilBuffer: false, generateMipmaps: false
      });
      rt.texture.colorSpace = THREE.LinearSRGBColorSpace;
      var u = O.material.uniforms;
      mat = new THREE.ShaderMaterial({
        depthTest: false, depthWrite: false, toneMapped: false, blending: THREE.NoBlending,
        defines: { NDISP: NDISP },
        uniforms: {
          uW: { value: u.uW.value }, uTime: { value: u.uTime.value },
          uDepthTex: { value: u.uDepthTex.value }, uDepthRect: { value: u.uDepthRect.value },
          uGrp0: { value: u.uGrp0.value }, uGrp1: { value: u.uGrp1.value },
          uOrigin: { value: new THREE.Vector3(ox, oz, sp) }
        },
        vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: [
          'precision highp float;',
          'uniform vec3 uOrigin; uniform float uTime;',
          GLSL_COMMON, GLSL_SEABED, GLSL_GERSTNER,
          'void main(){',
          '  vec2 c = floor(gl_FragCoord.xy);',
          '  vec2 p = uOrigin.xy + (c - 1.5)*uOrigin.z;',
          '  vec3 sb = seabed(p);',
          '  vec3 disp, nrm; vec4 jac; float sw, lost;',
          '  oceanEval(p, uTime, sb.x, sb.y, 1.0, disp, nrm, jac, sw, lost);',
          '  float e = clamp((disp.y + 8.0)/16.0, 0.0, 1.0);',
          '  float r = floor(e*255.0)/255.0;',
          '  float g = fract(e*255.0);',
          '  gl_FragColor = vec4(r, g, 0.0, 1.0);',
          '}'
        ].join('\n')
      });
      mat.extensions = { derivatives: true };
      quad(renderer, mat, rt);
      var buf = new Uint8Array(4 * 4 * 4);
      renderer.readRenderTargetPixels(rt, 0, 0, 4, 4, buf);
      var maxErr = 0, t = O.material.uniforms.uTime.value;
      for (var j = 0; j < 4; j++) for (var i = 0; i < 4; i++) {
        var x = ox + (i - 1.5) * sp, z = oz + (j - 1.5) * sp;
        var o = (j * 4 + i) * 4;
        var gpu = ((buf[o] / 255) + (buf[o + 1] / 255) / 255) * 16.0 - 8.0;
        var cpu = gerstnerCPU(x, z, t, false).y;
        maxErr = Math.max(maxErr, Math.abs(gpu - cpu));
      }
      O.selfTestError = maxErr;
      if (window.console) {
        if (maxErr < 0.02) console.log('[SAIL.ocean] selfTest OK, max |gpu-cpu| = ' + maxErr.toFixed(4) + ' m');
        else console.warn('[SAIL.ocean] selfTest drift ' + maxErr.toFixed(4) + ' m (> 0.02 m tolerance)');
      }
      /* ---- foam coverage: painted area vs the whitecap model --------------
         Asserted, not assumed. A factor of 1.5 either way is the tolerance;
         anything looser and the shading is disagreeing with the physics again. */
      var cov = (typeof O.foamMeasured === 'number') ? O.foamMeasured : O.foamAudit();
      if (cov !== null && window.console) {
        var W = O.foamW || 0, ratio = W > 1e-5 ? cov / W : 0;
        var msg = '[SAIL.ocean] foam coverage ' + (cov * 100).toFixed(2) + '% vs model '
                + (W * 100).toFixed(2) + '% (x' + ratio.toFixed(2) + ')';
        if (W < 3e-3 || (ratio > 0.55 && ratio < 1.6)) console.log(msg);
        else console.warn(msg + '  — outside the 1.5x tolerance');
      }
      /* ---- surface slope budget vs Cox & Munk ---------------------------- */
      if (window.console && O.coxMunkMss) {
        var mr = O.totalMss / O.coxMunkMss;
        var m2 = '[SAIL.ocean] mss ' + O.totalMss.toFixed(4) + ' (mesh ' + (O.meshMss || 0).toFixed(4)
               + ') vs Cox-Munk ' + O.coxMunkMss.toFixed(4) + ' (x' + mr.toFixed(2) + ')';
        if (mr > 0.9 && mr < 1.25) console.log(m2); else console.warn(m2);
      }
      return maxErr;
    } catch (e) {
      if (window.console) console.warn('[SAIL.ocean] selfTest skipped:', e);
      return null;
    } finally {
      if (mat) mat.dispose();
      if (rt) rt.dispose();
    }
  };

  /* =======================================================================
     11b.  FOAM COVERAGE AUDIT
     The review's single loudest finding was that the painted foam covered 17%
     to 70% of frame while this module's own whitecap model computed 0.5-3%.
     A coverage target that is never measured is a comment, not a constraint, so
     this renders the EXACT fragment-stage foam expression — same gate, same
     thresholds, same Worley erosion, same four advected taps — over a 900 m
     patch of open water and counts the painted area. selfTest asserts the
     result tracks O.foamW to within a factor of 1.5.
     ======================================================================= */
  O.foamAudit = function () {
    if (!renderer || !O.material) return null;
    var rt = null, mat = null;
    try {
      var N = 96;
      rt = new THREE.WebGLRenderTarget(N, N, {
        type: THREE.UnsignedByteType, format: THREE.RGBAFormat,
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
        depthBuffer: false, stencilBuffer: false, generateMipmaps: false
      });
      rt.texture.colorSpace = THREE.LinearSRGBColorSpace;
      var u = O.material.uniforms;
      mat = new THREE.ShaderMaterial({
        depthTest: false, depthWrite: false, toneMapped: false, blending: THREE.NoBlending,
        defines: { NDISP: NDISP },
        uniforms: {
          uW: { value: u.uW.value }, uTime: { value: u.uTime.value },
          uDepthTex: { value: u.uDepthTex.value }, uDepthRect: { value: u.uDepthRect.value },
          uGrp0: { value: u.uGrp0.value }, uGrp1: { value: u.uGrp1.value },
          uFoamHi: { value: u.uFoamHi.value }, uFoamLo: { value: u.uFoamLo.value },
          uFoamGain: { value: u.uFoamGain.value }, uDrift: { value: u.uDrift.value },
          uHs: { value: u.uHs.value },
          // well outside the bathymetry rect, so every sample is open water at
          // the assumed deep-water sounding: a patch that clipped the island
          // would count land as "no foam" and flatter the result
          uOrigin: { value: new THREE.Vector3(4200.0, -4200.0, 900.0 / N) }
        },
        vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: [
          'precision highp float;',
          'uniform vec3 uOrigin; uniform float uTime, uFoamHi, uFoamLo, uFoamGain, uHs;',
          'uniform vec2 uDrift;',
          GLSL_COMMON, GLSL_BUBBLE, GLSL_SEABED, GLSL_GERSTNER,
          'void main(){',
          '  vec2 p = uOrigin.xy + (gl_FragCoord.xy - 48.0)*uOrigin.z;',
          '  vec3 sb = seabed(p);',
          '  float J  = oceanJ(p, uTime, sb.x, sb.y, 1.0);',
          '  float J1 = oceanJ(p - uDrift*1.6, uTime - 1.6, sb.x, sb.y, 1.0);',
          '  float J2 = oceanJ(p - uDrift*3.6, uTime - 3.6, sb.x, sb.y, 1.0);',
          '  float J3 = oceanJ(p - uDrift*6.4, uTime - 6.4, sb.x, sb.y, 1.0);',
          '  vec2 f2 = p - uDrift*uTime;',
          '  float bmC = bubbleMask(f2*0.55);',
          '  float bmF = bubbleMask(f2*2.10 + 11.3);',
          '  float gw = max(uFoamHi - uFoamLo, 1e-4);',
          '  float fpatch = vn2(f2*0.16 + 4.7) - 0.5;',
          '  float rag = ((bmC - 0.5)*1.60 + fpatch*2.80)*gw;',
          // the same crest lock the fragment stage applies, or this measures a
          // coverage the shader never paints and the calibration walks off
          '  float hRel = oceanH(p, uTime, sb.x, sb.y, 1.0)/max(0.62*uHs, 0.25);',
          '  float crestLk = smoothstep(-0.12, 0.72, hRel);',
          '  float agedLk  = 0.34 + 0.66*smoothstep(-1.05, 0.42, hRel);',
          '  float lead = smoothstep(uFoamHi, uFoamLo, J + rag)*(0.30 + 0.70*bmF)*crestLk;',
          '  float t1 = smoothstep(uFoamHi, uFoamLo, J1 + rag*1.20)*(0.26 + 0.74*bmF)*0.62;',
          '  float t2 = smoothstep(uFoamHi, uFoamLo, J2 + rag*1.55)*(0.22 + 0.78*bmC)*0.36;',
          '  float t3 = smoothstep(uFoamHi, uFoamLo, J3 + rag*1.95)*(0.18 + 0.82*bmC)*0.19;',
          '  float crest = clamp(max(lead, max(max(t1,t2),t3)*agedLk), 0.0, 1.0)*uFoamGain;',
          '  gl_FragColor = vec4(crest, 0.0, 0.0, 1.0);',
          '}'
        ].join('\n')
      });
      mat.extensions = { derivatives: true };
      quad(renderer, mat, rt);
      var buf = new Uint8Array(N * N * 4);
      renderer.readRenderTargetPixels(rt, 0, 0, N, N, buf);
      var area = 0, mean = 0;
      for (var p2 = 0; p2 < N * N; p2++) { var v = buf[p2 * 4] / 255; mean += v; if (v > 0.35) area++; }
      O.foamMeasured = area / (N * N);
      O.foamMeasuredMean = mean / (N * N);
      return O.foamMeasured;
    } catch (e) {
      return null;
    } finally {
      if (mat) mat.dispose();
      if (rt) rt.dispose();
    }
  };

  /* Close the loop. The analytic budget above (four correlated taps, a Worley
     erosion, a 0.35 visibility threshold) is an estimate; the only number that
     matters is the area actually painted. Measure it, push the gate quantile the
     other way, repeat. Three or four 96^2 passes at build time, and the learned
     ratio is then reused for every in-flight spectrum retarget so a gust costs
     nothing. This is what makes "coverage tracks foamW" a property of the build
     rather than a hope. */
  O.calibrateFoam = function () {
    if (!renderer || !O.material) return null;
    var W = O.foamW || 0;
    if (!(W > 3e-3) || !(O.foamBudget > 0)) { O.foamAudit(); return O.foamMeasured; }
    var cov = 0;
    for (var it = 0; it < 6; it++) {
      pushComps();
      cov = O.foamAudit();
      if (cov === null) return null;
      var r = cov / W;
      if (r > 0.88 && r < 1.14) break;
      // the tail of J is steep, so drive the correction sub-linearly or the
      // iteration rings instead of converging
      foamCal = clamp(foamCal * Math.pow(W / Math.max(cov, 1e-5), 0.62), 0.02, 60.0);
      solveFoamThreshold(O.foamBudget * foamCal);
    }
    pushComps();
    return cov;
  };

  /* ------------------------------------------------------------ misc ----- */
  O.swellFromDeg = 300;                    // NW ocean swell, travels toward 120 deg
  O.dispose = function () {
    if (O.mesh && sceneRef) sceneRef.remove(O.mesh);
    if (O.geometry) O.geometry.dispose();
    if (O.material) O.material.dispose();
    if (O.detailTex) O.detailTex.dispose();
    if (gustTex) gustTex.dispose();
    if (DG && DG.tex) DG.tex.dispose();
    if (WK && WK.a) { WK.a.dispose(); WK.b.dispose(); }
    O.ready = false;
  };
})();
