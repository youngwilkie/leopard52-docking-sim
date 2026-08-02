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
  var MAXC = 24;                   // uniform slots reserved

  var clamp = function (v, a, b) { return v < a ? a : (v > b ? b : v); };
  var sstep = function (a, b, x) { var t = clamp((x - a) / (b - a || 1e-6), 0, 1); return t * t * (3 - 2 * t); };
  var tnh = function (x) { x = clamp(x, -8, 8); var e = Math.exp(2 * x); return (e - 1) / (e + 1); };

  /* =======================================================================
     1.  SPECTRUM  —  banded component set
     ======================================================================= */
  var BAND_A = [136, 98, 72, 54];                                  // swell    (m)
  var BAND_A_LOW = [136, 84];
  // Displaced wind sea now reaches 3.6 m. The gap between the shortest displaced
  // wave and the largest detail-map octave is what reads as "only one scale":
  // broad swell, fine texture, nothing between. 3.6 m closes it.
  var BAND_B = [34, 26, 20, 15, 11.5, 8.6, 6.4, 4.8, 3.6];         // wind sea (m)
  var BAND_B_LOW = [34, 26, 20, 15, 11.5, 8.6];
  var BAND_C = [2.7, 2.0, 1.5, 1.15, 0.85, 0.62, 0.46];            // chop — normal-map only
  var SPREAD_A = 12 * Math.PI / 180, SPREAD_B = 45 * Math.PI / 180, SPREAD_C = 75 * Math.PI / 180;
  var STEEP_A = 0.30, STEEP_B = 0.45, STEEP_TOTAL = 0.85;

  // one 8-float record per component: dx dz A k w Q phase0 band
  O.comp = new Float32Array(MAXC * 8);
  var compTarget = new Float32Array(MAXC * 8);
  var NDISP = 12;                  // components actually displaced (bands A+B)
  var chopVar = 0.0;               // band-C variance; it is never displaced, so
                                   // it is spent on the detail normal instead

  function pmS(w, wp) {            // Pierson–Moskowitz
    if (w <= 1e-4) return 0;
    return (8.1e-3 * GRAV * GRAV / Math.pow(w, 5)) * Math.exp(-1.25 * Math.pow(wp / w, 4));
  }

  // deterministic phase per component so the field is reproducible
  function phaseOf(i) { var s = Math.sin(i * 12.9898 + 78.233) * 43758.5453; return (s - Math.floor(s)) * Math.PI * 2; }

  /* Build the target component set. Amplitudes/directions/steepness only;
     wavelengths (hence k and w) are FIXED so the field can be cross-faded
     without a phase discontinuity at large |x|. */
  function buildSpectrum(U10, swellM, windToward, swellFromDeg, low) {
    var LA = low ? BAND_A_LOW : BAND_A, LB = low ? BAND_B_LOW : BAND_B, LC = low ? [] : BAND_C;
    NDISP = LA.length + LB.length;

    var wdir = Math.atan2(windToward.x, -windToward.z);            // compass-toward, radians
    var sdir = (swellFromDeg + 180) * Math.PI / 180;               // swell travels TO here

    var recs = [];
    var i, n, sp;

    for (i = 0; i < LA.length; i++) {
      n = LA.length;
      sp = n > 1 ? ((i * 2 + 1) / n - 1) : 0;                      // -1..1 across the band
      recs.push({ band: 0, L: LA[i], th: sdir + sp * SPREAD_A * ((i % 2) ? 1 : -0.62), dth: sp * SPREAD_A });
    }
    for (i = 0; i < LB.length; i++) {
      n = LB.length;
      sp = n > 1 ? ((i * 2 + 1) / n - 1) : 0;
      recs.push({ band: 1, L: LB[i], th: wdir + sp * SPREAD_B, dth: sp * SPREAD_B });
    }
    for (i = 0; i < LC.length; i++) {
      n = LC.length;
      sp = n > 1 ? ((i * 2 + 1) / n - 1) : 0;
      recs.push({ band: 2, L: LC[i], th: wdir + sp * SPREAD_C, dth: sp * SPREAD_C });
    }

    for (i = 0; i < recs.length; i++) {
      recs[i].k = 2 * Math.PI / recs[i].L;
      recs[i].w = Math.sqrt(GRAV * recs[i].k);
    }
    // dw from sorted-by-frequency neighbours (records are already L-descending)
    for (i = 0; i < recs.length; i++) {
      var wp1 = recs[Math.min(i + 1, recs.length - 1)].w;
      var wm1 = recs[Math.max(i - 1, 0)].w;
      recs[i].dw = Math.max(1e-3, Math.abs(wp1 - wm1) * (i === 0 || i === recs.length - 1 ? 1.0 : 0.5));
    }

    var wpWind = 0.877 * GRAV / Math.max(U10, 0.6);
    var wA0 = recs[0].w;                                            // swell peak
    for (i = 0; i < recs.length; i++) {
      var r = recs[i];
      var dirW = Math.cos(r.dth); dirW = Math.max(0, dirW * dirW);
      if (r.band === 0) {
        var q = (r.w - wA0) / (0.34 * wA0);
        r.raw = Math.exp(-q * q) * dirW;                            // narrow-band swell
      } else {
        r.raw = Math.sqrt(2 * pmS(r.w, wpWind) * r.dw) * dirW;
      }
      r.raw = Math.max(r.raw, 1e-7);
    }

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
    // the granular bubble mask multiplies the gate down to ~0.7 of its area, so
    // solve the threshold for the pre-mask coverage
    W = Math.min(W * 1.10, 0.18);
    var wid = Math.max(0.035, 0.9 * O.jSigma);
    var n = jacobianSamples(compTarget, NDISP);
    // Solve for the smoothstep midpoint whose INTEGRATED coverage equals W.
    // Taking the raw quantile overshoots badly in light air, where the ramp is
    // wide compared with how sparsely the tail of J is populated.
    var lo = _jmin - wid, hi = _jmax + wid, mid = 0;
    for (var it = 0; it < 14; it++) {
      mid = 0.5 * (lo + hi);
      var acc = 0, a = mid + wid * 0.5, b = mid - wid * 0.5, ib = 1 / (a - b);
      for (var i = 0; i < n; i++) {
        var t = clamp((a - _jbuf[i]) * ib, 0, 1);
        acc += t * t * (3 - 2 * t);
      }
      if (acc / n > W) hi = mid; else lo = mid;
    }
    O.foamW = W;
    O.foamHi = mid + wid * 0.5;
    O.foamLo = mid - wid * 0.5;
    // Below ~0.2% coverage the sample count cannot resolve the tail, so fade
    // crest foam out directly rather than letting quantisation noise show.
    O.foamGain = clamp(W / 0.0035, 0, 1);
  }

  var _jbuf = new Float64Array(576), _jmin = 0, _jmax = 2;
  function jacobianSamples(arr, nDisp) {
    // 24x24 golden-ratio-jittered grid over 620 m of open water, t = 0.
    // No sort: only the coverage integral and the bracket are needed.
    var N = 24, n = 0, GA = 0.6180339887;
    _jmin = 1e9; _jmax = -1e9;
    for (var b = 0; b < N; b++) for (var a = 0; a < N; a++) {
      var x = (a + ((b * GA) % 1)) / N * 620 - 310;
      var z = (b + ((a * GA) % 1)) / N * 620 - 310;
      var Jxx = 1, Jzz = 1, Jxz = 0;
      for (var i = 0; i < nDisp; i++) {
        var o = i * 8, dx = arr[o], dz = arr[o + 1], A = arr[o + 2], k = arr[o + 3];
        var Q = arr[o + 5], p0 = arr[o + 6];
        if (A <= 1e-6) continue;
        var sn = Math.sin(k * (dx * x + dz * z) + p0), qak = Q * A * k;
        Jxx -= qak * dx * dx * sn; Jzz -= qak * dz * dz * sn; Jxz -= qak * dx * dz * sn;
      }
      var J = Jxx * Jzz - Jxz * Jxz;
      if (J < _jmin) _jmin = J;
      if (J > _jmax) _jmax = J;
      _jbuf[n++] = J;
    }
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
    for (var i = 0; i < NDISP; i++) {
      var o = i * 8;
      var dx = C[o], dz = C[o + 1], A = C[o + 2], k = C[o + 3], w = C[o + 4], Q = C[o + 5], p0 = C[o + 6];
      var band = C[o + 7];
      if (A <= 1e-6) continue;
      var sm = band < 0.5 ? shel : (0.45 + 0.55 * shel);
      var th = tnh(k * Math.max(dep, 0.02));
      var ke = k / Math.max(Math.sqrt(th), 0.08);
      var Ae = A * sm * clamp(Math.pow(Math.max(th, 1e-4), -0.25), 0, 1.9);
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
    'float h21(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453123); }',
    'float vn2(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);',
    '  return mix(mix(h21(i),h21(i+vec2(1.0,0.0)),f.x), mix(h21(i+vec2(0.0,1.0)),h21(i+vec2(1.0,1.0)),f.x), f.y); }'
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
    /* Nyquist guard on the displaced components. 2.6 samples per wavelength was
       so conservative that by 1.5 km EVERY component had been faded out, which
       is exactly why the skyline was a ruler-straight 1 px seam: there was no
       geometry left out there to break it. 2.05 is just above Nyquist and the
       variance the fade does discard is still accounted for in `lost`, so it
       reappears as BRDF roughness instead of aliasing. */
    '#define NYQ 2.05',
    'void oceanEval(vec2 p, float t, float dep, float shel, float spacing,',
    '               out vec3 disp, out vec3 nrm, out vec4 jac, out float swash, out float lost){',
    '  disp = vec3(0.0);',
    '  vec3 tx = vec3(1.0,0.0,0.0), tz = vec3(0.0,0.0,1.0);',
    '  float Jxx=1.0, Jzz=1.0, Jxz=0.0, dJdt=0.0, lap=0.0;',
    '  float tot=0.0, cut=0.0; swash=0.0;',
    '  for(int i=0;i<NDISP;i++){',
    '    vec4 a = uW[i*2]; vec4 b = uW[i*2+1];',
    '    vec2 d = a.xy; float A = a.z; float k = a.w;',
    '    float w = b.x; float Q = b.y; float p0 = b.z; float band = b.w;',
    '    float sm = (band < 0.5) ? shel : (0.45 + 0.55*shel);',
    '    float th = tnh(k*max(dep,0.02));',
    '    float ke = k / max(sqrt(th), 0.08);',
    '    float Ae = A*sm*clamp(pow(max(th,1e-4), -0.25), 0.0, 1.9);',
    '    Ae = min(Ae, 0.42*max(dep,0.0)) * step(0.35, dep);',
    '    float L = 6.28318530718/k;',
    '    float ny = smoothstep(0.0, 1.0, L/(NYQ*max(spacing,0.01)) - 1.0);',
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
    '  for(int i=0;i<NDISP;i++){',
    '    vec4 a = uW[i*2]; vec4 b = uW[i*2+1];',
    '    vec2 d = a.xy; float A = a.z; float k = a.w;',
    '    float w = b.x; float p0 = b.z; float band = b.w;',
    '    float sm = (band < 0.5) ? shel : (0.45 + 0.55*shel);',
    '    float th = tnh(k*max(dep,0.02));',
    '    float ke = k / max(sqrt(th), 0.08);',
    '    float Ae = A*sm*clamp(pow(max(th,1e-4), -0.25), 0.0, 1.9);',
    '    Ae = min(Ae, 0.42*max(dep,0.0)) * step(0.35, dep);',
    '    float L = 6.28318530718/k;',
    '    Ae *= smoothstep(0.0, 1.0, L/(NYQ*max(spacing,0.01)) - 1.0);',
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
    '  for(int i=0;i<NDISP;i++){',
    '    vec4 a = uW[i*2]; vec4 b = uW[i*2+1];',
    '    vec2 d = a.xy; float A = a.z; float k = a.w;',
    '    float w = b.x; float Q = b.y; float p0 = b.z; float band = b.w;',
    '    float sm = (band < 0.5) ? shel : (0.45 + 0.55*shel);',
    '    float th = tnh(k*max(dep,0.02));',
    '    float ke = k / max(sqrt(th), 0.08);',
    '    float Ae = A*sm*clamp(pow(max(th,1e-4), -0.25), 0.0, 1.9);',
    '    Ae = min(Ae, 0.42*max(dep,0.0)) * step(0.35, dep);',
    '    float L = 6.28318530718/k;',
    '    Ae *= smoothstep(0.0, 1.0, L/(NYQ*max(spacing,0.01)) - 1.0);',
    '    float s = sin(ke*dot(d,p) - w*t + p0);',
    '    float qak = Q*Ae*ke;',
    '    Jxx -= qak*d.x*d.x*s; Jzz -= qak*d.y*d.y*s; Jxz -= qak*d.x*d.y*s;',
    '  }',
    '  return Jxx*Jzz - Jxz*Jxz;',
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
  var DET = [
    [0.041700, 0.34,  0.000, 0.85, 0.00],
    [0.112300, 0.42,  0.630, 0.66, 0.14],
    [0.297100, 0.46, -1.240, 0.50, 0.26],
    [0.831700, 0.44,  0.330, 0.34, 0.30],
    [2.113000, 0.32, -1.970, 0.20, 0.20],
    [5.470000, 0.20,  0.910, 0.11, 0.10]
  ];
  function detailOctavesGLSL(n) {
    var out = [], bw = 0, i;
    for (i = 0; i < n && i < DET.length; i++) bw += DET[i][4];
    var kb = bw > 1e-4 ? 1 / bw : 0;
    for (i = 0; i < n && i < DET.length; i++) {
      var d = DET[i], c = Math.cos(d[2]).toFixed(6), s = Math.sin(d[2]).toFixed(6);
      out.push(
        '  { vec2 q = pw + wd*(' + d[3].toFixed(3) + '*uTime);',
        '    vec2 uv = vec2(q.x*' + c + ' - q.y*' + s + ', q.x*' + s + ' + q.y*' + c + ')*' + d[0].toFixed(6) + ';',
        '    vec4 td = texture2D(uDetailTex, uv);',
        '    vec2 sl = (td.rg*2.0-1.0)*uDetNorm;',
        '    float ss = td.b*2.0*uDetNorm*uDetNorm;',
        '    slope += ' + d[1].toFixed(3) + '*sl;',
        '    varLost += ' + (d[1] * d[1]).toFixed(5) + '*max(ss - dot(sl,sl), 0.0);',
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
  function ringRadii(low) {
    var r = low ? 3.5 : 2.5, cap = low ? 70 : 38, far = 4500, R = 20000;
    var out = [r];
    while (r < far) { r += Math.min(Math.max(r * 0.055, 0.55), cap); out.push(r); }
    while (r < R) { r *= 1.42; out.push(Math.min(r, R)); }
    return out;
  }

  function buildGeometry(low) {
    var NA = low ? 160 : 384;
    var RAD = ringRadii(low), NR = RAD.length - 1;
    var nv = NA * (NR + 1) + 1;
    var pos = new Float32Array(nv * 3), meta = new Float32Array(nv * 2);
    pos[0] = 0; pos[1] = 0; pos[2] = 0;
    meta[0] = 2 * Math.PI * RAD[0] / NA; meta[1] = 0;
    var v = 1, j, i;
    for (j = 0; j <= NR; j++) {
      var r = RAD[j];
      var rp = j > 0 ? RAD[j - 1] : 0;
      var rn = j < NR ? RAD[j + 1] : r;
      var sp = Math.max(Math.max(r - rp, rn - r), 2 * Math.PI * r / NA);
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
        'float H(vec2 uv){',
        '  float h=0.0, a=1.0, per=8.0, nrm=0.0;',
        '  for(int o=0;o<5;o++){ h += a*gn(uv*per, per); nrm += a; a *= 0.52; per *= 2.0; }',
        '  return h/nrm;',
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
        '  float sx = clamp(-hx*12.0, -1.0, 1.0);',
        '  float sz = clamp(-hy*12.0, -1.0, 1.0);',
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
    tex.anisotropy = Math.min(8, maxA || 1);
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
  var WK = null;
  function buildWake(low) {
    var N = low ? 256 : 512, R = low ? 160 : 200;
    var mk = function () {
      var c = document.createElement('canvas'); c.width = c.height = N;
      var g = c.getContext('2d');
      g.fillStyle = '#000'; g.fillRect(0, 0, N, N);
      var t = new THREE.CanvasTexture(c);
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.minFilter = t.magFilter = THREE.LinearFilter;
      t.generateMipmaps = false;
      t.colorSpace = THREE.LinearSRGBColorSpace;
      return { c: c, g: g, t: t };
    };
    WK = { N: N, R: R, a: mk(), b: mk(), cx: 0, cz: 0, pend: [], drift: new THREE.Vector2(0, 0) };
  }

  O.addWake = function (x, z, strength, width) {
    if (!WK) return;
    if (WK.pend.length > 700) return;
    WK.pend.push(x, z, clamp(strength || 0.4, 0, 1), Math.max(0.4, width || 1.5));
  };

  var wakeFocus = new THREE.Vector2(0, 0), wakeFocusSet = false;
  O.setFocus = function (x, z) { wakeFocus.set(x, z); wakeFocusSet = true; };

  function stepWake(dt, camX, camZ, windX, windZ) {
    if (!WK) return;
    var N = WK.N, R = WK.R;
    var fx = wakeFocusSet ? wakeFocus.x : camX, fz = wakeFocusSet ? wakeFocus.y : camZ;
    var px = (WK.cx - fx) / (2 * R) * N;
    var pz = (WK.cz - fz) / (2 * R) * N;
    // surface drift: current + ~2.5% of the wind, in texels
    var cur = SAIL.env || {};
    var dvx = (cur.curX || 0) + windX * 0.025, dvz = (cur.curZ || 0) + windZ * 0.025;
    px += dvx * dt / (2 * R) * N;
    pz += dvz * dt / (2 * R) * N;
    WK.cx = fx; WK.cz = fz;

    var src = WK.a, dst = WK.b;
    var g = dst.g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.fillStyle = '#000'; g.fillRect(0, 0, N, N);
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha = Math.exp(-dt / 7.5);
    g.drawImage(src.c, px, pz);
    g.globalAlpha = 1;

    var P = WK.pend;
    for (var i = 0; i < P.length; i += 4) {
      var u = (P[i] - fx) / (2 * R) + 0.5, v = (P[i + 1] - fz) / (2 * R) + 0.5;
      if (u < -0.05 || u > 1.05 || v < -0.05 || v > 1.05) continue;
      var rad = Math.max(1.6, P[i + 3] / (2 * R) * N);
      var a = P[i + 2];
      var gr = g.createRadialGradient(u * N, v * N, 0, u * N, v * N, rad);
      gr.addColorStop(0, 'rgba(255,255,255,' + a.toFixed(3) + ')');
      gr.addColorStop(0.55, 'rgba(255,255,255,' + (a * 0.45).toFixed(3) + ')');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.beginPath(); g.arc(u * N, v * N, rad, 0, 6.2832); g.fill();
    }
    P.length = 0;
    g.globalCompositeOperation = 'source-over';
    dst.t.needsUpdate = true;
    WK.a = dst; WK.b = src;
    if (O.material) {
      O.material.uniforms.uWakeTex.value = dst.t;
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
      '  float shadow = 1.0;',
      '  if (uShadowOn > 0.5){',
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
      '      shadow = 1.0 - 0.85*clamp(occ, 0.0, 1.0)*rim;',
      '    }',
      '  }',
      // Foam is born at a breaking crest, then drifts with the surface and
      // dissolves. Sampling the fold BACKWARDS along the drift line at two
      // lifetimes gives a raft that is genuinely advected and ageing, instead of
      // the dJ/dt smear that painted continuous ribbons down every wave.
      '  float J1 = jac.x, J2 = jac.x;',
      '  if (sb.x > 0.35){',
      '    J1 = oceanJ(wp.xz - uDrift*1.5, uTime - 1.5, sb.x, sb.y, aMeta.x);',
      '    J2 = oceanJ(wp.xz - uDrift*3.2, uTime - 3.2, sb.x, sb.y, aMeta.x);',
      '  }',
      '  vP0 = vec4(jac.x, J1, J2, sb.x);',
      '  vP1 = vec4(sb.y, aMeta.x, aMeta.y, swash*rim);',
      '  vec4 mv = viewMatrix * wp;',
      '  vP2 = vec4(-mv.z, lost, sb.z, shadow);',
      '  vP3 = vec4(jac.z, jac.y, 0.0, 0.0);',
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
      'uniform sampler2D uDetailTex, uGustTex, uWakeTex, uSceneTex, uLinDTex;',
      'uniform vec3 uSkyTint;',
      'uniform vec2 uDrift;',
      'varying vec3 vWorld; varying vec3 vN;',
      'varying vec4 vP0; varying vec4 vP1; varying vec4 vP2; varying vec4 vP3;',
      GLSL_COMMON,
      skyBlock(),
      // ---- Worley (2x2 search, jitter <= 0.45) for the caustic web
      'vec2 h22b(vec2 p){ p = vec2(dot(p,vec2(127.1,311.7)), dot(p,vec2(269.5,183.3)));',
      '  return fract(sin(p)*43758.5453); }',
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
      /* Static Worley — the bubble raft itself. Foam is not a smooth alpha
         ramp: it is a packed cellular froth, and at pixel scale each cell is
         either white or it is water. Two octaves (~0.7 m rafts, ~0.2 m bubbles)
         give the granularity, and because they are world-locked and advected
         with the surface drift they foreshorten correctly instead of scrolling. */
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
      '}',
      'float hullShadow(vec2 p){',
      '  if (uHull1.z <= 0.001) return 0.0;',
      '  vec2 d = p - uHull0.xy;',
      '  float f = d.x*uHull1.x + d.y*uHull1.y;',
      '  float s = d.x*uHull1.y - d.y*uHull1.x;',
      '  float e = length(vec2(f/max(uHull0.z,0.2), s/max(uHull0.w,0.2)));',
      '  return uHull1.z * (1.0 - smoothstep(0.55, 1.35, e));',
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
      '  float fp = max(fwidth(vWorld.x), fwidth(vWorld.z));',   // world metres per pixel
      '  vec2 pw = vWorld.xz;',
      '  vec2 wd = uWindDir;',
      '  vec2 wq = vec2(wd.y, -wd.x);',                          // crosswind
      '  float gust = texture2D(uGustTex, (pw - uGustOfs)*uGustInv).r;',

      // ================= detail slopes (LEAN, five irrational octaves) =====
      '  vec2 slope = vec2(0.0); float varLost = 0.0; float bub = 0.0;',
      detailOctavesGLSL(low ? 3 : 6),

      // ================= foam ==============================================
      // Granular bubble raft, world-locked and advected with the surface drift
      // so it foreshortens with distance instead of scrolling at a fixed
      // apparent size. Two Worley octaves; the coarse one carves the raft into
      // patches, the fine one is the bubbles.
      '  vec2 fp2 = pw - uDrift*uTime;',
      '  float bmC = bubbleMask(fp2*0.55);',
      '  float bmF = bubbleMask(fp2*2.10 + 11.3);',
      '  float bm  = clamp(0.45*bmC + 0.55*bmF, 0.0, 1.0);',
      '  bub = mix(bub, bm, 0.55);',
      '  float J = vP0.x, dJdt = vP3.y;',
      // The Jacobian says where the surface is actually folding. Perturbing the
      // THRESHOLD by the bubble field (rather than dimming the result) is what
      // makes the silhouette ragged instead of an airbrushed ellipse.
      '  float rag = (bmC - 0.42);',
      // Actively breaking: hard threshold on the fold, then a contrast curve
      // against the bubble field. A whitecap is very nearly binary at pixel
      // scale, and it is that hard, ragged leading edge - not a soft alpha - that
      // stops the foam reading as an airbrushed decal.
      // a fold that is still CLOSING is the one throwing bubbles; one already
      // relaxing has stopped entraining air. Small bias, but it puts the bright
      // edge on the advancing side of the crest where it belongs.
      '  float lead = smoothstep(uFoamHi, uFoamLo, J + rag*0.085 - 0.055*clamp(-dJdt, 0.0, 1.0));',
      '  lead = smoothstep(0.05, 0.55, lead)*(0.30 + 0.70*bm);',
      // The raft this crest threw off 1.5 s and 3.2 s ago, sampled where it was
      // BORN and carried downstream by uDrift (done in the vertex stage). An
      // exponential lifetime of ~2 s makes it dissipate; nothing persists, and
      // nothing is a thirty-metre ribbon, because each tap is an independent
      // fold event rather than a derivative of the current one.
      '  float t1 = smoothstep(uFoamHi, uFoamLo, vP0.y + rag*0.105);',
      '  t1 = smoothstep(0.05, 0.60, t1)*(0.24 + 0.76*bmF)*0.47;',
      '  float t2 = smoothstep(uFoamHi, uFoamLo, vP0.z + rag*0.130);',
      '  t2 = smoothstep(0.05, 0.65, t2)*(0.18 + 0.82*bmF)*0.20;',
      '  float aged = max(t1, t2);',
      '  float crest = clamp(max(lead, aged), 0.0, 1.0)*uFoamGain;',
      // how much of this pixel is old foam rather than actively breaking - drives
      // the dissipation gradient in the shading below
      '  float fAge = clamp(1.0 - lead/max(crest, 1e-3), 0.0, 1.0);',

      // shoreline foam + 1.4 s swash memory
      '  float swn = 0.35 + 0.65*bub;',
      '  float shoreF = smoothstep(0.55, 0.05, col)*swn;',
      '  float colSw = vP1.w + dep;',
      '  shoreF = max(shoreF, 0.62*smoothstep(0.50, 0.02, colSw)*swn);',
      '  shoreF *= step(0.02, dep);',

      // boat wake buffer
      '  vec2 wuv = (pw - uWakeC)/(2.0*uWakeR) + 0.5;',
      '  float wk = 0.0;',
      '  if (wuv.x > 0.002 && wuv.x < 0.998 && wuv.y > 0.002 && wuv.y < 0.998){',
      '    float ed = min(min(wuv.x, 1.0-wuv.x), min(wuv.y, 1.0-wuv.y));',
      '    wk = texture2D(uWakeTex, wuv).r * smoothstep(0.0, 0.06, ed);',
      '  }',
      '  wk *= (0.40 + 0.60*bub);',
      '  float foam = clamp(crest + shoreF + wk*1.15, 0.0, 1.0);',
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
      '  varLost = varLost*uDetMss*gs*gs + vP2.y*vP2.y*uMeshMss;',
      // Real sea slope is not Gaussian: Cox & Munk measured a positive peakedness,
      // i.e. a heavy tail. That tail is ENTIRELY what sun glitter is made of - it
      // is the rare 25-35 degree facet that mirrors the disc - so a purely
      // Gaussian sum of octaves produces a sea that can never spark. Stretch the
      // tail without moving the variance.
      // wind ripples run crosswind, so along-wind slopes are the steeper ones.
      // Kept mild: at 1.5:1 the whole octave ladder combs into parallel filaments.
      '  vec2 sl2 = wd*(dot(slope,wd)*1.10) + wq*(dot(slope,wq)*0.92);',
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
      '  float kb = 0.12 + 0.24*smoothstep(0.0, 0.32, mNoV);',
      '  vec3 N  = normalize(N0 + vec3(slSun.x, 0.0, slSun.y));',
      '  vec3 Nb = normalize(N0 + vec3(sl2.x, 0.0, sl2.y)*kb);',
      '  if (dot(N, V)  < 0.0) N  = normalize(N  - V*dot(N,V)*1.02);',
      '  if (dot(Nb, V) < 0.0) Nb = normalize(Nb - V*dot(Nb,V)*1.02);',
      '  float broadVar = (1.0 - kb*kb)*dot(sl2,sl2);',

      // ================= roughness ========================================
      // alpha is built ONLY from slope variance the pixel cannot resolve: the
      // LEAN residual plus the capillary band below the finest octave. Near
      // field alpha ~ 0.03-0.06, rising smoothly toward the horizon, which is
      // exactly the Toksvig cure for the shimmer.
      '  float capMss = (0.003 + 5.12e-3*uU10)*0.030;',
      '  float alpha = clamp(sqrt(max(varLost,0.0) + capMss), 0.016, 0.42);',
      '  alpha = mix(alpha, 0.85, foam);',
      // the sky lobe is wider by exactly the variance Nb threw away
      '  float alphaB = clamp(sqrt(max(varLost,0.0) + capMss + broadVar), 0.02, 0.55);',

      // ================= Fresnel ==========================================
      // Full Schlick, no NdotV floor and no lerp toward a constant. At the
      // horizon NoV -> 0 and F -> 1, so the water becomes the sky it reflects
      // and the seam disappears without any fog hack.
      '  float NoV  = max(dot(N,V), 0.0);',
      '  float NoVb = max(dot(Nb,V), 0.0);',
      '  float F0 = 0.02037;',
      '  float F = F0 + (1.0-F0)*pow(1.0-NoVb, 5.0);',
      '  F = mix(F, 0.06, foam);',

      // ================= sky reflection ===================================
      '  vec3 Rv = reflect(-V, Nb);',
      // A ray reflected below the horizon hits the back of the next wave and is
      // reflected again, so it still carries sky - just dimmer.
      '  float below = smoothstep(0.02, -0.12, Rv.y);',
      '  vec3 refl = skyRadianceNoSun(normalize(vec3(Rv.x, abs(Rv.y)+0.004, Rv.z)), L);',
      '  refl *= mix(1.0, 0.55, below);',
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
      '  float hRel = vWorld.y/max(0.62*uHs, 0.25);',
      '  float have = 1.0 - vP2.y;',
      '  float aoDev = (1.0 - smoothstep(-1.3, 0.9, hRel))*0.56*have;',
      // Wave-scale ambient occlusion. A trough sees a slot of sky, a crest sees
      // the whole hemisphere; without this the displacement has no form and the
      // swell reads as a normal map on a flat plane. Applied to the TRANSMITTED
      // path as well as the reflected one further down.
      '  float waveAO = mix(0.55, 1.0, smoothstep(-1.5, 0.85, hRel)*have + (1.0-have));',
      // A reflected ray leaving within a couple of degrees of horizontal skims
      // the sea and usually strikes the back of the next wave. That wave is
      // itself a near-mirror, so most of the radiance survives - the loss is
      // real but modest, and it too must vanish over flattened water.
      '  float skim = (1.0 - smoothstep(0.012, 0.22, Rv.y))*have;',
      '  float ao = (1.0 - aoDev)*(0.82 + 0.18*N0.y)*mix(1.0, 0.72, skim);',
      // Gate on the GEOMETRIC depression angle, not on the facet normal - the
      // facet normal is the very thing being modulated, and keying off it undoes
      // the occlusion exactly where it is needed.
      '  float gview = clamp((uCam.y - vWorld.y)/dist, 0.0, 1.0);',
      '  refl *= mix(1.0, ao, smoothstep(0.0012, 0.0090, gview));',
      // Rippled patches scatter the reflected cone and read visibly darker and
      // duller than the slicks beside them, at every distance.
      '  refl *= mix(1.0, 0.76, smoothstep(0.045, 0.26, alphaB));',
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
      '  refl = mix(refl, skyRadianceNoSun(normalize(vec3(Rv.x, abs(Rv.y)+0.30, Rv.z)), L),',
      '             clamp(alphaB*2.8, 0.0, 0.78)*smoothstep(0.0, 0.035, NoVb));',

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
      '  float shad = (1.0 - hullShadow(pw)) * clamp(vP2.w, 0.0, 1.0);',
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
      '  float aSun = 0.00465;',
      '  float aP  = clamp(0.30*alpha + aSun, 1e-3, 1.0);',
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
      '  float aH  = clamp(alpha + 0.105, 0.0, 1.0);',
      '  float aH2 = aH*aH;',
      '  float dH  = NoH*NoH*(aH2-1.0)+1.0;',
      '  float DH  = aH2/(3.14159265*dH*dH);',
      // Sparks are allowed to clip hundreds of times over: that is the whole
      // point of an HDR pipeline, and a highlight that cannot reach white does
      // not read as a mirror.
      '  float sunLobe = min(D*Vs, 3.0e4) + min(DH*Vs, 4.0e2)*0.055;',
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
      '  vec3 Ed = (uSunCol*(uSunE*sunNoL*0.94*shad) + uSkyTint*(uSkyE*0.93))*waveAO;',
      '  float wm  = vn2(pw*0.0042);',
      '  float wm2 = vn2(pw*0.0131 + 11.3);',
      '  vec3 aK = uAbsK*(0.86 + 0.30*wm);',
      '  vec3 bK = uScatK*(0.68 + 0.90*wm2);',
      // Over a sand shelf the bottom and the suspended carbonate throw light
      // straight back out, which is what turns Caribbean water turquoise in
      // three metres and leaves it indigo in forty. Driven by the real sounding,
      // so the gradient is geometry, not a painted texture.
      '  float shelf = 1.0 - smoothstep(1.2, 15.0, col);',
      '  bK *= 1.0 + vec3(1.20, 3.10, 2.35)*shelf;',
      '  vec3 ext = aK + bK;',
      '  vec3 Rw  = bK/ext;',
      '  float pathB = col*(1.0/max(NoVw,0.26) + 1.0/max(sunNoLw,0.26));',
      '  vec3 Tb = exp(-ext*min(pathB, 160.0));',
      '  vec3 body = bg*Tb + Rw*(Ed*0.3183099)*(1.0 - Tb);',
      // Sunlight focused by the surface into sheets a metre or two down. This
      // is the detail that keeps the steep near field from reading as a void.
      '  if (uCaustic > 0.001 && dist < 130.0 && sunUp > 0.02){',
      '    float shim = causticF(pw*0.62 + wd*(uTime*0.45));',
      '    body *= 1.0 + 1.25*shim*exp(-dist/55.0)*sunNoL*shad*uCaustic;',
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
      '  vec3 sss = vec3(0.0);',
      '  if (sunUp > 0.01){',
      '    float hh = clamp((vWorld.y + 0.18*uHs)/max(0.85*uHs, 0.30), 0.0, 1.5);',
      '    float stretch = clamp((1.0-J)*1.7, 0.0, 1.0);',
      '    float thin = hh*hh*(0.32 + 0.68*stretch);',
      // forward scattering through the crest: peaks looking down-sun, but a
      // wrapped floor keeps a jade rim on every steep face
      '    float fwd = pow(clamp(dot(V,-L)*0.5 + 0.5, 0.0, 1.0), 4.0);',
      '    float wrap = clamp((dot(N0,L) + 0.55)/1.55, 0.0, 1.0);',
      // steep faces are the thin ones; a flat back is opaque
      '    float face = smoothstep(0.02, 0.45, length(N0.xz));',
      '    sss = uSSSCol*(thin*face*(0.30 + 2.30*fwd)*(0.35 + 0.65*wrap)',
      '                   *uSunE*sunUp*0.026*shad);',
      '  }',

      // ================= composite ========================================
      '  vec3 c = body*(1.0-F) + refl*F + spec + sss;',

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
      '    vec3 fAlb = vec3(0.90)*(0.52 + 0.48*bubT);',
      // Ageing: the raft thins, drains and starts showing the water through it,
      // so old foam is dimmer, bluer and far less opaque than a breaking crest.
      '    fAlb *= mix(1.0, 0.46, fAge);',
      '    vec3 fLit = mix(vec3(1.0), sunN, 0.55)*(uSunE*wl*shad) + uSkyTint*(uSkyE*1.15);',
      '    vec3 fc = fAlb*fLit*0.3183099;',
      '    fc = mix(fc, fc*vec3(0.82,0.95,1.10), fAge);',
      '    c = mix(c, fc, foam*(0.72 + 0.28*bubT)*mix(1.0, 0.62, fAge));',
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
      '  float hzD = 3600.0*sqrt(max(uCam.y, 0.5)/2.5);',
      '  float gz = 0.88*smoothstep(0.45*hzD, 2.6*hzD, dist);',
      '  gz = max(gz, smoothstep(0.0, 1.0, vP1.z));',
      '  c = mix(c, hz, gz);',

      // break up 8-bit banding in the smooth far-field gradient
      '  c *= 1.0 + (h21(gl_FragCoord.xy + fract(uTime)) - 0.5)*0.0045;',

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
      uAbsK: { value: new THREE.Vector3(0.420, 0.0640, 0.0300) },
      uScatK: { value: new THREE.Vector3(0.0021, 0.0046, 0.0052) },
      uSSSCol: { value: new THREE.Vector3(0.055, 0.560, 0.485) },
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
      uDepthTex: { value: DG ? DG.tex : null },
      uDepthRect: { value: DG ? new THREE.Vector4(DG.x0, DG.z0, DG.ix, DG.iz) : new THREE.Vector4(0, 0, 1e-4, 1e-4) },
      uDetailTex: { value: O.detailTex || null },
      uGustTex: { value: gustTex },
      uWakeTex: { value: WK ? WK.a.t : null },
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
      if (renderer) O.selfTest();
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
    var det = clamp((cm - (O.meshMss || 0)) * 0.85, 0.0035, 0.048);
    u.uDetMss.value = det;
    u.uMeshMss.value = clamp(O.meshMss || 0, 0, 0.09);
    O.material.uniformsNeedUpdate = true;
  }

  /* =======================================================================
     10.  PER-FRAME UPDATE
     ======================================================================= */
  var lastU10 = -1, lastWdir = -9, lastSwell = -1, blend = 1, retargetIn = 0;

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
      blend = 0;
    }
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
      return maxErr;
    } catch (e) {
      if (window.console) console.warn('[SAIL.ocean] selfTest skipped:', e);
      return null;
    } finally {
      if (mat) mat.dispose();
      if (rt) rt.dispose();
    }
  };

  /* ------------------------------------------------------------ misc ----- */
  O.swellFromDeg = 300;                       // NW ocean swell, travels toward 120 deg
  O.dispose = function () {
    if (O.mesh && sceneRef) sceneRef.remove(O.mesh);
    if (O.geometry) O.geometry.dispose();
    if (O.material) O.material.dispose();
    if (O.detailTex) O.detailTex.dispose();
    if (gustTex) gustTex.dispose();
    if (DG && DG.tex) DG.tex.dispose();
    if (WK) { WK.a.t.dispose(); WK.b.t.dispose(); }
    O.ready = false;
  };
})();
