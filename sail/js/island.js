/* ==========================================================================
   island.js — SAIL.island : Grenada, St George's Lagoon & Port Louis Marina
   +X = East, +Z = South, -Z = North, Y = up (metres). Compass heading.
   Owns: bathymetry / land mask, terrain render, vegetation, town, Fort George,
   marina structures, moored fleet, channel buoyage.
   All shaders emit LINEAR RADIANCE (E_sun = 100, E_sky = 12) and clamp to 12000.
   ========================================================================== */
(function () {
  'use strict';
  const SAIL = (window.SAIL = window.SAIL || {});
  const I = {};
  SAIL.island = I;
  I.ready = false;
  if (typeof THREE === 'undefined') {
    I.build = function () { return I; }; I.update = function () {};
    I.depthAt = function () { return 10; }; I.heightAt = function () { return -10; };
    I.landAt = function () { return false; }; I.shelter = function () { return 1; };
    return;
  }

  /* ---------------------------------------------------------------- maths */
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const lerp = (a, b, t) => a + (b - a) * t;
  const PI = Math.PI;
  /* Integer bit-mix, not sin(). The terrain bake evaluates this tens of millions
     of times; Math.sin() made the load take seconds. */
  function hash(i, j) {
    let h = (i | 0) * 374761393 + (j | 0) * 668265263;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
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
  /* Ridged multifractal. abs-of-noise inverted and squared gives sharp crests;
     weighting each octave by the previous one concentrates detail on the ridges
     and leaves the basins smooth, which is what a volcanic island actually does.
     Plain fBm cannot produce a serrated skyline — it always reads as a dune.   */
  function rmf(x, z, oct, gain) {
    let s = 0, f = 1, a = 1, n = 0, prev = 1;
    const g = gain || 0.52;
    for (let k = 0; k < oct; k++) {
      let v = 1 - Math.abs(vnoise(x * f, z * f));
      v *= v;
      s += v * a * (0.32 + 0.68 * prev);
      prev = v;
      n += a; f *= 2.07; a *= g;
    }
    return s / n;
  }
  function segDist(px, pz, ax, az, bx, bz) {
    const dx = bx - ax, dz = bz - az;
    const t = clamp(((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz), 0, 1);
    return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
  }
  // sRGB hex -> linear rgb triple
  function lin(hex) {
    const f = c => Math.pow(c, 2.2);
    return [f(((hex >> 16) & 255) / 255), f(((hex >> 8) & 255) / 255), f((hex & 255) / 255)];
  }
  function rnd(seedObj) { seedObj.s = (seedObj.s * 1664525 + 1013904223) >>> 0; return seedObj.s / 4294967296; }

  /* ------------------------------------------------- world layout (exact) */
  const LAG = { cx: 0, cz: 0, rx: 268, rz: 214 };
  const CH = { ax: -196, az: 62, bx: -640, bz: 226, half: 46 };
  const TX0 = -1750, TX1 = 1150, TZ0 = -1300, TZ1 = 1350;
  const MARINA = { pierX: 194, z0: -126, z1: 112, fingerLen: 22, slipPitch: 15.5, nSlips: 15 };

  /* West coast. Base arc (unchanged where the channel meets it) plus two big
     headland lobes and a domain-warped crenellation, so the shoreline reads as
     points and bays instead of an extruded line. A guaranteed bay is forced at
     the channel entrance latitude so the fairway always reaches open water.   */
  let _cxz = NaN, _cxv = 0;              // the bake walks whole rows at fixed z
  function coastX(z) {
    if (z === _cxz) return _cxv;
    let c = -572 + 74 * Math.sin(z * 0.0041) + 38 * Math.sin(z * 0.0117 + 1.3) + 22 * Math.sin(z * 0.026 - 0.4);
    const w = fbm(z * 0.00042, 11.3, 2) * 300;
    c += 138 * Math.sin((z + w) * 0.00086 + 0.6) + 78 * Math.sin((z - w) * 0.00191 - 1.7);
    c += fbm(z * 0.0017 + 4.1, -2.7, 4) * 104;
    const bay = sstep(400, 150, Math.abs(z - 185));
    _cxz = z; _cxv = lerp(c, Math.max(c, -536), bay);
    return _cxv;
  }
  /* Large-scale island envelope: >0 means water. Ends the landmass to the N, S
     and E with a ragged coast so the far shore recedes in overlapping capes
     instead of running off the edge of the baked field as a flat band.        */
  function islandEnv(x, z) {
    // conservative early-out: inside this box no envelope term can ever reach 0,
    // which keeps the whole sailing-area bake off this function entirely
    if (z > -6100 && z < 4900 && x < 5500) return -2000;
    const north = -8400 + 920 * Math.sin(x * 0.00031 + 0.4) + 540 * Math.sin(x * 0.00082 - 1.9)
      + fbm(x * 0.00115, 7.7, 3) * 720;
    const south = 7100 + 1010 * Math.sin(x * 0.00027 - 1.2) + 470 * Math.sin(x * 0.00097 + 2.4)
      + fbm(x * 0.0013 + 3.3, -5.1, 3) * 660;
    const east = 8500 + 1380 * Math.sin(z * 0.00029 + 2.1) + 690 * Math.sin(z * 0.00071 - 0.8)
      + fbm(z * 0.0009 - 2.2, 9.4, 3) * 880;
    return Math.max(north - z, Math.max(z - south, x - east));
  }
  function waterField(x, z) {
    const e = Math.hypot((x - LAG.cx) / LAG.rx, (z - LAG.cz) / LAG.rz);
    let d = (1 - e) * Math.min(LAG.rx, LAG.rz);
    d = Math.max(d, CH.half - segDist(x, z, CH.ax, CH.az, CH.bx, CH.bz));
    d = Math.max(d, coastX(z) - x);
    d = Math.max(d, islandEnv(x, z));
    return d;
  }
  function bump(x, z, cx, cz, r, peak, p) {
    const d = Math.hypot(x - cx, z - cz) / r;
    if (d >= 1) return 0;
    return peak * Math.pow(1 - d * d, p || 1.6);
  }
  /* Overlapping volcanic cones at four depth layers: coastal bluffs, the ridge
     behind the town, the interior massif, and the far north-east cordillera.
     [cx, cz, radius, peak, falloff]                                           */
  const CONES = [
    [-470, -190, 300, 86, 1.30], [-352, -640, 560, 224, 1.32], [-268, 792, 520, 176, 1.34],
    [124, -318, 660, 292, 1.28], [432, 402, 760, 258, 1.34], [-96, 1520, 820, 262, 1.40],
    [-520, -2380, 940, 322, 1.40], [318, -3620, 1360, 446, 1.44], [910, -1300, 980, 392, 1.40],
    [1780, 366, 1300, 470, 1.44], [640, 2680, 1180, 316, 1.44], [2520, -1960, 1560, 578, 1.48],
    [3240, 3450, 2050, 452, 1.48], [4260, 940, 2250, 664, 1.50], [5680, -2680, 2650, 806, 1.54],
    [6900, 2600, 2400, 592, 1.52], [1150, 4600, 1500, 348, 1.46]
  ];
  /* Analytic land elevation. The grid bake then runs a flow-accumulation pass
     over this, which is what cuts the dendritic V-drainages; the terms here
     supply the ridge/spur skeleton those valleys are cut into.                */
  function landHeight(x, z) {
    const d = -waterField(x, z);
    if (d <= 0) return 0;
    let h = 0.92 * Math.pow(Math.min(d, 60), 0.72);
    const ramp = sstep(0, 165, d);
    let e = 0;
    for (let i = 0; i < CONES.length; i++) {
      const c = CONES[i];
      const dd = Math.hypot(x - c[0], z - c[1]) / c[2];
      if (dd < 1) e += c[3] * Math.pow(1 - dd * dd, c[4]);
    }
    if (e <= 0) return Math.max(0.15, h);
    const wx = x + fbm(x * 0.00042, z * 0.00042, 3) * 560;
    const wz = z + fbm(x * 0.00042 + 13.7, z * 0.00042 - 7.1, 3) * 560;
    const r1 = rmf(wx * 0.00072, wz * 0.00072, 5);
    const r2 = rmf(wx * 0.0031, wz * 0.0031, 4);
    const r3 = rmf(x * 0.0125, z * 0.0125, 3);
    let hh = e * (0.30 + 1.06 * r1);
    hh += e * 0.28 * (r2 - 0.42);
    hh += Math.min(e, 280) * 0.11 * (r3 - 0.45);
    hh -= Math.min(hh, 420) * 0.17 * Math.pow(1 - r2, 2.2);
    if (hh > 0) h += hh * ramp;
    return Math.max(0.15, h);
  }
  const SHOALS = [
    [-452, 300, 120, 4.6], [-560, 96, 96, 4.2], [-330, -40, 84, 3.4],
    [212, -206, 62, 3.0], [-142, 178, 74, 3.2], [-676, 372, 150, 4.0]
  ];
  const DREDGE = [
    [196, -134, 196, 120, 46, 4.6], [176, 126, 200, 126, 30, 4.0],
    [-152.9, -174.4, -7, -212.8, 32, 4.2], [-7, -212.8, 141.3, -180.5, 32, 4.2]
  ];
  function depthExact(x, z) {
    const d = waterField(x, z);
    if (d <= 0) return -1;
    const cx = coastX(z), off = cx - x;
    /* Two independent profiles, maxed. The dredged lagoon and its buoyed channel
       keep the old 6.3 m shelf so the fairway stays navigable; the OPEN coast
       gets a real beach profile instead. The old code ramped to 4 m within a
       metre of the sand, so there was no shoal for surf to break on and the
       coast met the sea as a pixel-sharp line.                                */
    const e = Math.hypot((x - LAG.cx) / LAG.rx, (z - LAG.cz) / LAG.rz);
    const dLag = Math.max((1 - e) * Math.min(LAG.rx, LAG.rz),
      CH.half - segDist(x, z, CH.ax, CH.az, CH.bx, CH.bz));
    let dep = dLag > 0 ? 6.3 * sstep(0, 21, dLag) : 0.12;
    if (off > 0 && islandEnv(cx + 60, z) < 0) {
      const shelf = 14 * Math.pow(Math.min(off, 220) / 220, 1.15) + Math.max(0, off - 220) * 0.16;
      dep = Math.max(dep, Math.min(56, shelf));
    } else if (off > 0) {
      dep = Math.max(dep, Math.min(56, 4.2 + off * 0.17));
    }
    // shoals and seabed roughness fade out over the foreshore, or the beach
    // profile would dry out at random and strand the shore break inland
    const nf = off > 0 ? sstep(0, 120, off) : 1;
    for (const s of SHOALS) dep -= bump(x, z, s[0], s[1], s[2], s[3], 1.3) * nf;
    dep -= fbm(x * 0.013, z * 0.013, 3) * 0.55 * nf;
    for (const dr of DREDGE) {
      const sd = segDist(x, z, dr[0], dr[1], dr[2], dr[3]);
      if (sd < dr[4]) dep = Math.max(dep, dr[5] * sstep(dr[4], dr[4] * 0.6, sd));
    }
    return Math.max(0.12, dep);
  }
  function shelter(x, z) {
    const off = coastX(z) - x;
    let s = 0.07 + 0.93 * sstep(-40, 260, off);
    const alongCh = ((x - CH.ax) * (CH.bx - CH.ax) + (z - CH.az) * (CH.bz - CH.az)) /
      ((CH.bx - CH.ax) ** 2 + (CH.bz - CH.az) ** 2);
    if (segDist(x, z, CH.ax, CH.az, CH.bx, CH.bz) < CH.half + 40)
      s = Math.max(s, 0.10 + 0.42 * sstep(0.05, 0.9, alongCh));
    const e = Math.hypot((x - LAG.cx) / LAG.rx, (z - LAG.cz) / LAG.rz);
    if (e < 1.05) s = Math.min(s, 0.09 + 0.06 * e);
    return clamp(s, 0.05, 1);
  }

  /* ---------------------------------------- baked 5 m field (depth/height) */
  const GS = 5;
  let GW = 0, GH = 0, DEP = null, HGT = null, FLD = null, heightTex = null, depthTex = null;
  /* Coarse silhouette field. The fine field only spans the sailing area; every
     headland beyond it used to be extrapolated from the clamped edge texel,
     which is exactly the flat welded hedge the review called out. This second
     level carries real terrain out to the visible horizon.                    */
  const CS = 64, CX0 = -12000, CZ0 = -12000, CX1 = 12000, CZ1 = 12000;
  let CW = 0, CGH = 0, CHGT = null, CFLD = null, coarseTex = null;
  /* Land cover: R = road, G = settlement density. Sampled by the terrain shader
     and by the placement code so ground tint, buildings and roads agree.      */
  const LCN = 512, VX0 = -2400, VX1 = 1800, VZ0 = -2000, VZ1 = 2000;
  let COVER = null, coverTex = null;

  // counting sort, descending. Array.sort on 300k cells costs more than the erosion.
  function orderDesc(H, list, n) {
    let hmax = 1e-3;
    for (let i = 0; i < n; i++) { const v = H[list[i]]; if (v > hmax) hmax = v; }
    const NB = 4096, inv = (NB - 1) / hmax;
    const cnt = new Int32Array(NB + 1);
    for (let i = 0; i < n; i++) cnt[NB - 1 - ((H[list[i]] * inv) | 0)]++;
    let run = 0;
    for (let b = 0; b < NB; b++) { const c = cnt[b]; cnt[b] = run; run += c; }
    const out = new Int32Array(n);
    for (let i = 0; i < n; i++) { const k = list[i]; out[cnt[NB - 1 - ((H[k] * inv) | 0)]++] = k; }
    return out;
  }
  /* Flow-accumulation erosion. Route every land cell's water to its steepest
     descending neighbour in height order, then cut the bed proportional to the
     0.42 power of the drainage AREA (resolution independent, so the fine and
     coarse fields carve the same valleys). This is what turns a lumpy fBm into
     dendritic V-shaped gullies with talus fans at the mouths.                 */
  const NB8 = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.4142], [1, -1, 1.4142], [-1, 1, 1.4142], [-1, -1, 1.4142]];
  function flowErode(H, W, Hh, cell, K) {
    const n = W * Hh;
    const list = new Int32Array(n);
    let m = 0;
    for (let k = 0; k < n; k++) if (H[k] > 0.2) list[m++] = k;
    if (!m) return;
    const order = orderDesc(H, list, m);
    const acc = new Float32Array(n);
    for (let i = 0; i < m; i++) acc[order[i]] = 1;
    for (let s = 0; s < m; s++) {
      const k = order[s], i = k % W, j = (k / W) | 0, h = H[k];
      let best = -1, bs = 0;
      for (let d = 0; d < 8; d++) {
        const ii = i + NB8[d][0], jj = j + NB8[d][1];
        if (ii < 0 || jj < 0 || ii >= W || jj >= Hh) continue;
        const kk = jj * W + ii, dh = h - H[kk];
        if (dh <= 0) continue;
        const sl = dh / NB8[d][2];
        if (sl > bs) { bs = sl; best = kk; }
      }
      if (best >= 0) acc[best] += acc[k];
    }
    const area = cell * cell / 1e6;                    // km² per cell
    for (let s = 0; s < m; s++) {
      const k = order[s];
      let carve = K * Math.pow(acc[k] * area, 0.42);
      const cap = Math.min(H[k] * 0.62, 74);
      if (carve > cap) carve = cap;
      H[k] = Math.max(0.15, H[k] - carve);
    }
    // one land-only smoothing pass: softens the single-cell staircase the carve
    // leaves on ridge lines without rounding the valleys back out
    const tmp = new Float32Array(n);
    tmp.set(H);
    for (let s = 0; s < m; s++) {
      const k = order[s], i = k % W, j = (k / W) | 0;
      let sum = tmp[k] * 2, w = 2;
      for (let d = 0; d < 8; d++) {
        const ii = i + NB8[d][0], jj = j + NB8[d][1];
        if (ii < 0 || jj < 0 || ii >= W || jj >= Hh) continue;
        const v = tmp[jj * W + ii];
        if (v <= 0) continue;
        const q = 1 / NB8[d][2];
        sum += v * q; w += q;
      }
      H[k] = sum / w;
    }
  }
  // horizon-scan sky visibility + central-difference normals into an RGBA float field
  function bakeAO(H, W, Hh, cell, radii, strength) {
    const F = new Float32Array(W * Hh * 4);
    const DIRS = [[1, 0], [0.5, 0.866], [-0.5, 0.866], [-1, 0], [-0.5, -0.866], [0.5, -0.866]];
    const ND = DIRS.length, NR = radii.length;
    const OFF = new Int32Array(ND * NR * 2), INVL = new Float32Array(ND * NR);
    for (let d = 0; d < ND; d++) for (let r = 0; r < NR; r++) {
      const q = d * NR + r;
      OFF[q * 2] = Math.round(DIRS[d][0] * radii[r]);
      OFF[q * 2 + 1] = Math.round(DIRS[d][1] * radii[r]);
      INVL[q] = 1 / (radii[r] * cell);
    }
    for (let j = 0; j < Hh; j++) for (let i = 0; i < W; i++) {
      const k = j * W + i, h = H[k];
      let occ = 0;
      for (let d = 0; d < ND; d++) {
        let mx = 0;
        for (let r = 0; r < NR; r++) {
          const q = d * NR + r;
          let ii = i + OFF[q * 2]; ii = ii < 0 ? 0 : (ii >= W ? W - 1 : ii);
          let jj = j + OFF[q * 2 + 1]; jj = jj < 0 ? 0 : (jj >= Hh ? Hh - 1 : jj);
          const s = (H[jj * W + ii] - h) * INVL[q];
          if (s > mx) mx = s;
        }
        occ += mx * 1.35 > 1 ? 1 : mx * 1.35;
      }
      const ao = clamp(1 - occ / ND * strength, 0.10, 1);
      const im = i > 0 ? i - 1 : 0, ip = i < W - 1 ? i + 1 : W - 1;
      const jm = j > 0 ? j - 1 : 0, jp = j < Hh - 1 ? j + 1 : Hh - 1;
      const nx = -(H[j * W + ip] - H[j * W + im]) / ((ip - im) * cell);
      const nz = -(H[jp * W + i] - H[jm * W + i]) / ((jp - jm) * cell);
      const inv = 1 / Math.sqrt(nx * nx + nz * nz + 1);
      F[k * 4] = h; F[k * 4 + 1] = ao; F[k * 4 + 2] = nx * inv; F[k * 4 + 3] = nz * inv;
    }
    return F;
  }
  function fieldTex(F, W, Hh) {
    const t = new THREE.DataTexture(F, W, Hh, THREE.RGBAFormat, THREE.FloatType);
    t.minFilter = t.magFilter = THREE.NearestFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.generateMipmaps = false; t.needsUpdate = true;
    return t;
  }

  function bakeField() {
    GW = Math.ceil((TX1 - TX0) / GS) + 1; GH = Math.ceil((TZ1 - TZ0) / GS) + 1;
    DEP = new Float32Array(GW * GH); HGT = new Float32Array(GW * GH);
    for (let j = 0; j < GH; j++) {
      const z = TZ0 + j * GS;
      for (let i = 0; i < GW; i++) {
        const x = TX0 + i * GS, k = j * GW + i;
        const d = depthExact(x, z);
        DEP[k] = d;
        HGT[k] = d < 0 ? landHeight(x, z) : -d;
      }
    }
    flowErode(HGT, GW, GH, GS, 26);
    FLD = bakeAO(HGT, GW, GH, GS, [3, 9, 22, 52], 0.90);
    heightTex = fieldTex(FLD, GW, GH);

    CW = Math.round((CX1 - CX0) / CS) + 1; CGH = Math.round((CZ1 - CZ0) / CS) + 1;
    CHGT = new Float32Array(CW * CGH);
    for (let j = 0; j < CGH; j++) {
      const z = CZ0 + j * CS;
      for (let i = 0; i < CW; i++) {
        const x = CX0 + i * CS;
        CHGT[j * CW + i] = waterField(x, z) > 0 ? -Math.min(depthExact(x, z), 60) : landHeight(x, z);
      }
    }
    flowErode(CHGT, CW, CGH, CS, 26);
    CFLD = bakeAO(CHGT, CW, CGH, CS, [1, 3, 8, 20], 0.85);
    coarseTex = fieldTex(CFLD, CW, CGH);

    // 256² field for the water shader: R = depth/30, G = shelter, B = land mask
    const N = 256, data = new Uint8Array(N * N * 4);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = TX0 + (i + 0.5) / N * (TX1 - TX0), z = TZ0 + (j + 0.5) / N * (TZ1 - TZ0);
      const d = I.depthAt(x, z), k = (j * N + i) * 4;
      data[k] = clamp(Math.round((d < 0 ? 0 : d) / 30 * 255), 0, 255);
      data[k + 1] = Math.round(shelter(x, z) * 255);
      data[k + 2] = d < 0 ? 255 : 0;
      data[k + 3] = 255;
    }
    depthTex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
    depthTex.minFilter = depthTex.magFilter = THREE.LinearFilter;
    depthTex.wrapS = depthTex.wrapT = THREE.ClampToEdgeWrapping;
    depthTex.needsUpdate = true;
    I.heightTex = heightTex; I.depthTex = depthTex;
    I.depthTexOrigin = new THREE.Vector2(TX0, TZ0);
    I.depthTexSize = new THREE.Vector2(TX1 - TX0, TZ1 - TZ0);
  }

  /* ------------------------------------------------ roads & settlement mask */
  const ROADS = [
    // Carenage waterfront, round the harbour and out to the Fort George bluff
    { w: 9, pts: [[190, -230], [96, -214], [-14, -232], [-118, -214], [-206, -196], [-300, -180], [-386, -166], [-452, -168]] },
    // Lagoon Road: town -> Port Louis marina -> the eastern shore
    { w: 8, pts: [[190, -230], [244, -206], [286, -150], [300, -60], [304, 44], [292, 128], [246, 196]] },
    // the switchback climbing the amphitheatre behind the town (5 hairpins)
    {
      w: 7, pts: [[-96, -238], [-176, -280], [-206, -330], [-150, -374], [-60, -396], [30, -420],
      [96, -458], [78, -510], [-10, -536], [-102, -556], [-150, -604], [-84, -650], [30, -672],
      [148, -690], [236, -724], [286, -782], [246, -844], [140, -872]]
    },
    // ridge road running north along the crest
    { w: 6, pts: [[236, -724], [330, -742], [430, -800], [520, -900], [566, -1030], [592, -1180]] },
    // the road south along the coast toward Grand Anse
    { w: 8, pts: [[-206, -196], [-234, -110], [-236, -10], [-208, 96], [-176, 208], [-186, 330], [-232, 452], [-286, 570], [-306, 700]] }
  ];
  function nearRoad(x, z) {
    let best = 1e9;
    for (let r = 0; r < ROADS.length; r++) {
      const P = ROADS[r].pts;
      for (let i = 0; i < P.length - 1; i++) {
        const d = segDist(x, z, P[i][0], P[i][1], P[i + 1][0], P[i + 1][1]) - ROADS[r].w * 0.5;
        if (d < best) best = d;
      }
    }
    return best;
  }
  /* Settlement density. Weighted by low altitude, low slope and proximity to the
     two harbours, so the town packs into the amphitheatre above the Carenage and
     dies out completely on the steep upper third.                             */
  function settleAt(x, z) {
    const d = -waterField(x, z);
    if (d <= 2) return 0;
    const y = I.heightAt(x, z);
    if (y < 1.2 || y > 190) return 0;
    const gx = (I.heightAt(x + 9, z) - I.heightAt(x - 9, z)) / 18;
    const gz = (I.heightAt(x, z + 9) - I.heightAt(x, z - 9)) / 18;
    const slope = Math.hypot(gx, gz);
    let s = Math.exp(-Math.hypot(x + 30, (z + 250) * 0.92) / 400) +
      0.72 * Math.exp(-Math.hypot((x - 296) * 1.15, z - 20) / 260) +
      0.34 * Math.exp(-Math.hypot(x + 230, (z - 210) * 0.8) / 300);
    s *= sstep(175, 14, y);
    s *= sstep(0.52, 0.13, slope);
    s *= sstep(2, 26, d);
    const rd = nearRoad(x, z);
    s *= 0.62 + 0.85 * sstep(90, 4, rd);
    s *= 0.52 + 0.48 * (0.5 + 0.5 * fbm(x * 0.0075, z * 0.0075, 3));
    return clamp(s, 0, 1);
  }
  function bakeCover() {
    COVER = new Uint8Array(LCN * LCN * 4);
    const sx = (VX1 - VX0) / LCN, sz = (VZ1 - VZ0) / LCN;
    for (let j = 0; j < LCN; j++) {
      const z = VZ0 + (j + 0.5) * sz;
      for (let i = 0; i < LCN; i++) {
        const x = VX0 + (i + 0.5) * sx, k = (j * LCN + i) * 4;
        const edge = Math.min(i, j, LCN - 1 - i, LCN - 1 - j);
        const fade = edge < 3 ? 0 : 1;
        const rd = nearRoad(x, z);
        const onLand = waterField(x, z) < -1;
        COVER[k] = onLand && fade ? Math.round(255 * sstep(9, 1.5, rd)) : 0;
        COVER[k + 1] = fade ? Math.round(255 * settleAt(x, z)) : 0;
        COVER[k + 2] = 0;
        COVER[k + 3] = 255;
      }
    }
    coverTex = new THREE.DataTexture(COVER, LCN, LCN, THREE.RGBAFormat);
    coverTex.minFilter = coverTex.magFilter = THREE.LinearFilter;
    coverTex.wrapS = coverTex.wrapT = THREE.ClampToEdgeWrapping;
    coverTex.generateMipmaps = false; coverTex.needsUpdate = true;
  }
  function coverAt(x, z) {
    if (!COVER) return 0;
    const u = (x - VX0) / (VX1 - VX0), v = (z - VZ0) / (VZ1 - VZ0);
    if (u < 0 || v < 0 || u >= 1 || v >= 1) return 0;
    const k = (((v * LCN) | 0) * LCN + ((u * LCN) | 0)) * 4;
    return COVER[k + 1] / 255;
  }

  // Bilinear depth, land encoded as −1. Identical to world_reference.depthAt.
  I.depthAt = function (x, z) {
    if (!DEP) return depthExact(x, z);
    const fx = (x - TX0) / GS, fz = (z - TZ0) / GS;
    if (fx < 0 || fz < 0 || fx >= GW - 1 || fz >= GH - 1) return depthExact(x, z);
    const i = fx | 0, j = fz | 0, tx = fx - i, tz = fz - j;
    const L = v => (v < 0 ? -0.5 : v);
    const a = L(DEP[j * GW + i]), b = L(DEP[j * GW + i + 1]);
    const c = L(DEP[(j + 1) * GW + i]), d = L(DEP[(j + 1) * GW + i + 1]);
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  };
  I.depthExact = depthExact;
  function bilin(A, W, x0, z0, cell, W2, x, z) {
    const fx = clamp((x - x0) / cell, 0, W - 1.001), fz = clamp((z - z0) / cell, 0, W2 - 1.001);
    const i = fx | 0, j = fz | 0, tx = fx - i, tz = fz - j;
    const a = A[j * W + i], b = A[j * W + i + 1], c = A[(j + 1) * W + i], d = A[(j + 1) * W + i + 1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  }
  /* MUST reproduce the terrain shader's terr() blend exactly. The renderer
     cross-fades the 5 m field into the 64 m field over a 420 m band inside the
     fine field's edge; returning the raw fine sample there puts every tree,
     wall and building placed in that band tens of metres off the surface the
     camera actually sees — which is what the detached canopy blobs floating
     above the ridgeline were. Placement and render must read one function.  */
  const BX0 = TX0 + 70, BZ0 = TZ0 + 70;
  function blendW(x, z) {
    if (!HGT) return 0;
    const bx1 = TX0 + GS * (GW - 1) - 70, bz1 = TZ0 + GS * (GH - 1) - 70;
    return sstep(0, 420, Math.min(x - BX0, bx1 - x, z - BZ0, bz1 - z));
  }
  I.heightAt = function (x, z) {
    if (!CHGT) {
      if (HGT && x > TX0 && z > TZ0 && x < TX1 && z < TZ1) return bilin(HGT, GW, TX0, TZ0, GS, GH, x, z);
      return terrainY(x, z);
    }
    const C = bilin(CHGT, CW, CX0, CZ0, CS, CGH, x, z);
    const w = blendW(x, z);
    if (w <= 0.002) return C;
    return lerp(C, bilin(HGT, GW, TX0, TZ0, GS, GH, x, z), w);
  };
  function terrainY(x, z) { const d = waterField(x, z); return d <= 0 ? landHeight(x, z) : -depthExact(x, z); }
  I.terrainY = terrainY;
  I.landAt = function (x, z) { return I.depthAt(x, z) < 0; };
  I.waterField = waterField;
  I.shelter = shelter;
  I.coastX = coastX;
  I.segDist = segDist;
  I.bounds = { TX0, TX1, TZ0, TZ1 };
  I.LAG = LAG; I.CH = CH; I.MARINA = MARINA;

  /* --------------------------------------------- collision segment index  */
  I.segments = []; I.berths = []; I.buoys = [];
  const CELL = 30;
  let SIDX = null;
  function addSeg(ax, az, bx, bz, kind) { I.segments.push({ ax, az, bx, bz, kind: kind || 'dock' }); }
  I.buildSegIndex = function () {
    SIDX = new Map();
    for (const s of I.segments) {
      const i0 = Math.floor(Math.min(s.ax, s.bx) / CELL), i1 = Math.floor(Math.max(s.ax, s.bx) / CELL);
      const j0 = Math.floor(Math.min(s.az, s.bz) / CELL), j1 = Math.floor(Math.max(s.az, s.bz) / CELL);
      for (let i = i0 - 1; i <= i1 + 1; i++) for (let j = j0 - 1; j <= j1 + 1; j++) {
        const k = i + ',' + j;
        if (!SIDX.has(k)) SIDX.set(k, []);
        SIDX.get(k).push(s);
      }
    }
  };
  I.segmentsNear = function (x, z, rad) {
    if (!SIDX) return I.segments;
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
  I.nearestWall = function (x, z, maxD) {
    let best = null;
    for (const s of I.segmentsNear(x, z, maxD)) {
      if (s.kind === 'pile') continue;
      const ex = s.bx - s.ax, ez = s.bz - s.az, ll = ex * ex + ez * ez || 1e-6;
      const t = clamp(((x - s.ax) * ex + (z - s.az) * ez) / ll, 0, 1);
      const dx = x - (s.ax + ex * t), dz = z - (s.az + ez * t);
      const d = Math.hypot(dx, dz);
      if (d < maxD && (!best || d < best.d)) best = { d, nx: dx / (d || 1), nz: dz / (d || 1) };
    }
    return best;
  };
  I.berth = function (id) { return I.berths.find(b => b.id === id); };

  /* ------------------------------------------------ procedural textures   */
  function cvs(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function ctex(c, rep) {
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    if (rep) t.repeat.set(rep, rep);
    t.anisotropy = 8; t.needsUpdate = true;
    return t;
  }
  // tiling value noise (period P) so every texture wraps seamlessly
  function tvn(x, z, P) {
    const i = Math.floor(x), j = Math.floor(z), fx = x - i, fz = z - j;
    const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
    const w = (a, b) => hash(((a % P) + P) % P, ((b % P) + P) % P);
    return lerp(lerp(w(i, j), w(i + 1, j), u), lerp(w(i, j + 1), w(i + 1, j + 1), u), v);
  }
  function tfbm(x, z, oct, P) {
    let a = 1, f = 1, s = 0, n = 0;
    for (let k = 0; k < oct; k++) { s += a * tvn(x * f, z * f, P * f); n += a; a *= 0.5; f *= 2; }
    return s / n;
  }
  // RG = tangent normal xy, B = cavity/variation, A = height
  function detailTexture() {
    const N = 256, P = 8, c = cvs(N, N), g = c.getContext('2d');
    const h = new Float32Array(N * N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const u = i / N * P, v = j / N * P;
      h[j * N + i] = tfbm(u, v, 5, P) * 0.72 + tfbm(u * 4, v * 4, 3, P * 4) * 0.28;
    }
    const img = g.createImageData(N, N), d = img.data;
    const gh = (i, j) => h[(((j % N) + N) % N) * N + (((i % N) + N) % N)];
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const dx = (gh(i + 1, j) - gh(i - 1, j)) * 5.5;
      const dz = (gh(i, j + 1) - gh(i, j - 1)) * 5.5;
      const k = (j * N + i) * 4;
      d[k] = clamp(Math.round((-dx * 0.5 + 0.5) * 255), 0, 255);
      d[k + 1] = clamp(Math.round((-dz * 0.5 + 0.5) * 255), 0, 255);
      d[k + 2] = clamp(Math.round((0.45 + 0.55 * h[j * N + i]) * 255), 0, 255);
      d[k + 3] = 255;   // canvas premultiplies: never author a<255 unless the RGB is disposable
    }
    g.putImageData(img, 0, 0);
    const t = ctex(c); t.anisotropy = 8; return t;
  }
  function plankTexture() {
    const c = cvs(512, 512), g = c.getContext('2d');
    g.fillStyle = '#a08f76'; g.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 16; i++) {
      const y = i * 32;
      g.fillStyle = 'hsl(' + (30 + Math.random() * 12) + ',' + (16 + Math.random() * 12) + '%,' + (50 + Math.random() * 14) + '%)';
      g.fillRect(0, y + 1, 512, 30);
      g.strokeStyle = 'rgba(55,42,28,.55)'; g.lineWidth = 1.6;
      g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(512, y + 0.5); g.stroke();
      for (let k = 0; k < 110; k++) {
        g.strokeStyle = 'rgba(' + (95 + Math.random() * 60 | 0) + ',' + (80 + Math.random() * 50 | 0) + ',' + (58 + Math.random() * 40 | 0) + ',.20)';
        const yy = y + 3 + Math.random() * 26;
        g.beginPath(); g.moveTo(Math.random() * 512, yy); g.lineTo(Math.random() * 512, yy + (Math.random() - 0.5) * 3); g.stroke();
      }
      for (let k = 0; k < 3; k++) {
        g.fillStyle = 'rgba(70,54,36,.35)';
        g.beginPath(); g.ellipse(Math.random() * 512, y + 8 + Math.random() * 16, 3 + Math.random() * 3, 2 + Math.random() * 2, 0, 0, 6.283); g.fill();
      }
    }
    return ctex(c);
  }
  function stoneTexture() {
    const c = cvs(512, 512), g = c.getContext('2d');
    g.fillStyle = '#8e8474'; g.fillRect(0, 0, 512, 512);
    for (let row = 0; row < 12; row++) {
      const y = row * 42.6, off = (row % 2) * 40;
      for (let col = -1; col < 8; col++) {
        const x = off + col * 70 + Math.random() * 5;
        const w = 62 + Math.random() * 8, hh = 36 + Math.random() * 5;
        const l = 108 + Math.random() * 54;
        g.fillStyle = 'rgb(' + (l | 0) + ',' + ((l - 6 + Math.random() * 12) | 0) + ',' + ((l - 20 + Math.random() * 10) | 0) + ')';
        g.fillRect(x, y + 3, w, hh);
        g.strokeStyle = 'rgba(60,55,48,.55)'; g.lineWidth = 2; g.strokeRect(x, y + 3, w, hh);
      }
    }
    for (let i = 0; i < 14000; i++) {
      g.fillStyle = 'rgba(' + (60 + Math.random() * 130 | 0) + ',' + (58 + Math.random() * 120 | 0) + ',' + (50 + Math.random() * 110 | 0) + ',.18)';
      g.fillRect(Math.random() * 512, Math.random() * 512, 2, 2);
    }
    return ctex(c);
  }
  /* Plaster facade, fully opaque. The night-window mask is recovered in the shader
     from the colour signature (dark AND blue-biased) — encoding it in alpha would be
     destroyed by the canvas' premultiplied storage wherever a = 0.               */
  function facadeTexture() {
    const c = cvs(256, 256), g = c.getContext('2d');
    const img0 = g.getImageData(0, 0, 256, 256), dd = img0.data;
    for (let i = 0; i < 256 * 256; i++) {
      const n = tfbm((i % 256) / 256 * 6, ((i / 256) | 0) / 256 * 6, 4, 6);
      const v = 226 + (n - 0.5) * 30;
      dd[i * 4] = v; dd[i * 4 + 1] = v - 3; dd[i * 4 + 2] = v - 12; dd[i * 4 + 3] = 255;
    }
    g.putImageData(img0, 0, 0);
    // one storey per tile: two shuttered windows + trim
    for (const wx of [40, 152]) {
      g.fillStyle = '#f7f3e8'; g.fillRect(wx - 8, 46, 80, 128);            // surround
      g.fillStyle = '#2a3138'; g.fillRect(wx, 54, 64, 112);                // opening
      g.fillStyle = '#3c4b58'; g.fillRect(wx + 3, 57, 26, 106);            // shutter L
      g.fillStyle = '#33414d'; g.fillRect(wx + 35, 57, 26, 106);           // shutter R
      g.strokeStyle = '#f2ede0'; g.lineWidth = 3;
      g.beginPath(); g.moveTo(wx + 32, 54); g.lineTo(wx + 32, 166); g.stroke();
      g.beginPath(); g.moveTo(wx, 108); g.lineTo(wx + 64, 108); g.stroke();
      g.fillStyle = '#6d5a44'; g.fillRect(wx - 12, 172, 88, 8);            // sill
    }
    g.fillStyle = 'rgba(126,116,100,.30)'; g.fillRect(0, 236, 256, 20);    // string course
    g.fillStyle = 'rgba(96,90,78,.22)'; g.fillRect(0, 0, 256, 8);
    const t = ctex(c); t.anisotropy = 8; return t;
  }
  function barkTexture() {
    const c = cvs(128, 256), g = c.getContext('2d');
    g.fillStyle = '#8b7355'; g.fillRect(0, 0, 128, 256);
    for (let j = 0; j < 26; j++) {                                          // palm leaf-scar rings
      const y = j * 10 + Math.random() * 3;
      g.fillStyle = 'rgba(96,78,56,' + (0.30 + Math.random() * 0.35) + ')';
      g.fillRect(0, y, 128, 4 + Math.random() * 2);
      g.fillStyle = 'rgba(196,178,148,.28)';
      g.fillRect(0, y + 5, 128, 2);
    }
    for (let i = 0; i < 5000; i++) {
      g.fillStyle = 'rgba(' + (105 + Math.random() * 80 | 0) + ',' + (88 + Math.random() * 66 | 0) + ',' + (64 + Math.random() * 52 | 0) + ',.22)';
      g.fillRect(Math.random() * 128, Math.random() * 256, 2, 3);
    }
    return ctex(c);
  }
  function tileTexture() {
    const c = cvs(128, 128), g = c.getContext('2d');
    g.fillStyle = '#ab4426'; g.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 8; i++) {
      const x = i * 16;
      const gr = g.createLinearGradient(x, 0, x + 16, 0);
      const t0 = 140 + Math.random() * 52;
      gr.addColorStop(0, 'rgb(' + (t0 * 0.55 | 0) + ',' + (t0 * 0.26 | 0) + ',' + (t0 * 0.19 | 0) + ')');
      gr.addColorStop(0.45, 'rgb(' + (t0 + 42 | 0) + ',' + (t0 * 0.52 | 0) + ',' + (t0 * 0.36 | 0) + ')');
      gr.addColorStop(1, 'rgb(' + (t0 * 0.5 | 0) + ',' + (t0 * 0.24 | 0) + ',' + (t0 * 0.18 | 0) + ')');
      g.fillStyle = gr; g.fillRect(x, 0, 16, 128);
    }
    for (let i = 0; i < 4; i++) { g.fillStyle = 'rgba(70,40,28,.32)'; g.fillRect(0, i * 32 + 29, 128, 3); }
    for (let i = 0; i < 3500; i++) {
      g.fillStyle = 'rgba(' + (60 + Math.random() * 110 | 0) + ',' + (40 + Math.random() * 60 | 0) + ',' + (30 + Math.random() * 50 | 0) + ',.20)';
      g.fillRect(Math.random() * 128, Math.random() * 128, 2, 2);
    }
    return ctex(c);
  }
  /* Pinnate frond. The leaflets MUST be filled wedges that overlap their
     neighbours, not hairlines: an alpha-tested crown drawn as 2.6 px strokes
     averages to a < 0.1 by the fourth mip, every fragment fails the cutoff and
     the palms render as bare poles from ~120 m out. Overlapping fills keep the
     interior alpha at 1 through every mip, so only the serrated edge softens. */
  function frondTexture() {
    const W = 256, H = 64, c = cvs(W, H), g = c.getContext('2d');
    g.clearRect(0, 0, W, H);
    const mid = H / 2;
    for (const s of [-1, 1]) {
      for (let i = 0; i < 42; i++) {
        const t = i / 42;
        const x = 3 + t * (W - 10);
        const half = (mid - 1.5) * (0.34 + 0.70 * Math.sin(Math.min(1, t * 2.3) * 1.5)) * (1 - t * 0.44);
        const lean = 10 + 8 * t, wdt = 8.0;
        const l = 24 + Math.random() * 30;
        g.fillStyle = 'hsl(' + (76 + Math.random() * 32) + ',' + (44 + Math.random() * 24) + '%,' + (l * 0.56 + 13) + '%)';
        g.beginPath();
        g.moveTo(x - wdt * 0.5, mid);
        g.lineTo(x + wdt * 0.5, mid);
        g.quadraticCurveTo(x + lean * 0.8, mid + s * half * 0.60, x + lean, mid + s * half);
        g.quadraticCurveTo(x + lean * 0.35, mid + s * half * 0.52, x - wdt * 0.5, mid);
        g.closePath(); g.fill();
      }
    }
    // opaque rachis: keeps the blade from breaking in half at low mip levels
    const gr = g.createLinearGradient(0, 0, W, 0);
    gr.addColorStop(0, '#57652a'); gr.addColorStop(0.55, '#77883a'); gr.addColorStop(1, '#95a552');
    g.fillStyle = gr;
    g.beginPath();
    g.moveTo(0, mid - 5.0); g.lineTo(W - 8, mid - 1.4); g.lineTo(W - 2, mid);
    g.lineTo(W - 8, mid + 1.4); g.lineTo(0, mid + 5.0); g.closePath(); g.fill();
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.anisotropy = 8; t.needsUpdate = true;
    return t;
  }
  function canopyTexture() {
    const c = cvs(128, 128), g = c.getContext('2d');
    g.clearRect(0, 0, 128, 128);
    for (let i = 0; i < 130; i++) {
      const a = Math.random() * 6.283, r = Math.pow(Math.random(), 0.6) * 52;
      const x = 64 + Math.cos(a) * r, y = 72 + Math.sin(a) * r * 0.82;
      const rad = 8 + Math.random() * 15;
      if (Math.hypot(x - 64, (y - 72) / 0.82) + rad > 62) continue;
      const l = 20 + (1 - (y / 128)) * 34 + Math.random() * 14;
      g.fillStyle = 'hsl(' + (96 + Math.random() * 26) + ',' + (40 + Math.random() * 24) + '%,' + l + '%)';
      g.beginPath(); g.arc(x, y, rad, 0, 6.283); g.fill();
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.anisotropy = 4; t.needsUpdate = true;
    return t;
  }
  function leafTexture() {
    const c = cvs(128, 128), g = c.getContext('2d');
    g.clearRect(0, 0, 128, 128);
    for (let i = 0; i < 54; i++) {
      const x = 12 + Math.random() * 104, y = 116 - Math.pow(Math.random(), 0.8) * 100;
      const r = 8 + Math.random() * 12, ang = Math.random() * 6.283;
      g.save(); g.translate(x, y); g.rotate(ang);
      g.fillStyle = 'hsl(' + (98 + Math.random() * 22) + ',' + (36 + Math.random() * 26) + '%,' + (20 + Math.random() * 24) + '%)';
      g.beginPath(); g.ellipse(0, 0, r, r * 0.78, 0, 0, 6.283); g.fill();
      g.restore();
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.anisotropy = 4; t.needsUpdate = true;
    return t;
  }

  /* ------------------------------------------------------ shared uniforms */
  const U = {
    uSunDir: { value: new THREE.Vector3(0.35, 0.82, 0.45) },
    uSunCol: { value: new THREE.Color(1.0, 0.96, 0.90) },
    uSkyCol: { value: new THREE.Color(0.36, 0.55, 0.95) },
    uHazeCol: { value: new THREE.Color(0.74, 0.83, 0.96) },
    uSunE: { value: 100.0 }, uSkyE: { value: 12.0 },
    uRayCol: { value: new THREE.Color(0.42, 0.56, 0.92) },
    uHaze: { value: 1.0 / 2460.0 }, uHazeR: { value: 1.0 / 20000.0 }, uFogH: { value: 110.0 },
    uTime: { value: 0.0 }, uNight: { value: 0.0 }, uCloudAmt: { value: 0.45 },
    uWind: { value: new THREE.Vector3(0.7, 0.7, 1.0) },
    uDet: { value: null },
    uSwell: { value: new THREE.Vector4(0.71, -0.71, 0.081, 0.35) }
  };
  const G_COMMON = [
    'float h21(vec2 p){ p=fract(p*vec2(127.1,311.7)); p+=dot(p,p+41.73); return fract(p.x*p.y*2.713); }',
    'float vn2(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);',
    '  return mix(mix(h21(i),h21(i+vec2(1.0,0.0)),f.x), mix(h21(i+vec2(0.0,1.0)),h21(i+vec2(1.0,1.0)),f.x), f.y); }',
    'float fbm2(vec2 p){ float s=vn2(p)*0.55; s+=vn2(p*2.07)*0.27; s+=vn2(p*4.13)*0.13; s+=vn2(p*8.31)*0.05; return s; }',
    'vec3 s2l(vec3 c){ return c*(c*(c*0.305+0.682)+0.013); }'
  ].join('\n');
  const G_LIGHT = [
    'uniform vec3 uSunDir, uSunCol, uSkyCol, uHazeCol, uRayCol;',
    'uniform float uSunE, uSkyE, uHaze, uHazeR, uFogH, uTime, uNight;',
    'uniform vec3 uWind; uniform sampler2D uDet; uniform float uCloudAmt;',
    /* Cloud shadow. The trade-wind cumulus deck sits at ~900 m, so the shadow a
       cloud throws lands where the sun ray through it meets the ground — the
       xz offset below. Without this the island is a single evenly lit mass and
       nothing conveys the scale of the slopes it is dragging across.        */
    'float cloudShadow(vec3 p){',
    '  if (uCloudAmt < 0.01 || uSunDir.y < 0.03) return 1.0;',
    '  vec2 q = p.xz + uSunDir.xz*((900.0-p.y)/max(uSunDir.y,0.22));',
    '  q -= uWind.xy*uTime*7.5;',
    // trade cumulus organise into streets running downwind: stretch the field 3:1
    '  vec2 wd = normalize(uWind.xy + vec2(1e-4,0.0));',
    '  vec2 r = vec2(dot(q,wd)*0.34, dot(q,vec2(-wd.y,wd.x)));',
    '  float n = fbm2(r*0.00078)*0.66 + fbm2(r*0.00265+vec2(11.0,3.0))*0.34;',
    /* fbm2 clusters hard around 0.5, so a wide threshold band yields an even
       mottle rather than discrete shadows. The edge has to sit inside the bulk
       of the distribution and be narrow, or nothing reads as a cloud at all. */
    '  float lo = mix(0.575, 0.405, clamp(uCloudAmt,0.0,1.0));',
    '  return 1.0 - 0.72*smoothstep(lo, lo+0.105, n);',
    '}',
    'vec3 lamb(vec3 alb, vec3 N, float ao, vec3 wp){',
    '  float ndl = max(dot(N,uSunDir),0.0);',
    '  return alb*0.3183099*(uSunCol*uSunE*ndl*cloudShadow(wp) + uSkyCol*uSkyE*(0.40+0.60*max(N.y,0.0))*ao);',
    '}',
    'float ggx(vec3 N, vec3 V, float rough){',
    '  vec3 H = normalize(V+uSunDir);',
    '  float a = max(rough*rough, 0.0025); float a2=a*a;',
    '  float nh=max(dot(N,H),0.0), nv=max(dot(N,V),1e-3), nl=max(dot(N,uSunDir),0.0);',
    '  float dn = nh*nh*(a2-1.0)+1.0;',
    '  float D = a2/(3.14159265*dn*dn);',
    '  float k = a*0.5;',
    '  float G = (nl/(nl*(1.0-k)+k))*(nv/(nv*(1.0-k)+k));',
    '  return min(D*G*0.25/max(nv,1e-3), 300.0);',
    '}',
    /* Aerial perspective, Rayleigh/Mie split. The optical depth integrates the
       exponential air density along the SLANT path from the eye to the surface
       (not just the surface height), so a shoreline hazes far harder than the
       summit above it while both stay consistent as the camera climbs. Both
       terms IN-SCATTER: they add light and lift the shadows toward the sky,
       which is what actually sells distance — desaturating alone reads dead. */
    'float airAvg(float ya, float yb, float H){',
    '  float d = yb-ya;',
    '  float a = exp(-max(ya,0.0)/H), b = exp(-max(yb,0.0)/H);',
    '  return abs(d) < 1.0 ? a : (a-b)*H/d;',
    '}',
    'vec3 fogApply(vec3 c, float dist, vec3 dir, float wy){',
    '  float cy = cameraPosition.y;',
    '  float fM = 1.0-exp(-dist*uHaze *airAvg(cy,wy,uFogH));',
    '  float fR = 1.0-exp(-dist*uHazeR*airAvg(cy,wy,2600.0));',
    '  float mu = clamp(dot(dir,uSunDir),0.0,1.0);',
    '  float g=0.72, gg=g*g;',
    '  float pM = (1.0-gg)/(12.566*pow(max(1.0+gg-2.0*g*mu,1e-3),1.5));',
    /* The Mie term has to converge on the HORIZON SKY, and be brighter than the
       terrain it is veiling. Run it dark or neutral and the far end of the
       island turns into a muddy grey-brown band that reads as dirt on the lens
       rather than kilometres of luminous humid air.                          */
    '  vec3 mie = uHazeCol*uSkyE*1.10 + uSunCol*uSunE*(0.0035+0.010*pM);',
    '  vec3 ray = uRayCol*uSkyE*0.85*(0.72+0.28*mu*mu);',
    /* Desaturate BEFORE the in-scatter mix. Humid tropical air does not merely
       add a grey veil — it destroys the chroma of what is behind it, which is
       why a far headland is a flat blue-grey card while the near hill is still
       green. Blending toward the haze colour alone keeps the far ridge as
       saturated as the near one and the island collapses into a single plane. */
    '  float des = clamp(fM*1.05+fR*0.50, 0.0, 0.95);',
    '  float lum = dot(c, vec3(0.2126,0.7152,0.0722));',
    '  c = mix(c, vec3(lum), des*0.72);',
    '  c = mix(c, mie, clamp(fM,0.0,0.97));',
    '  c = mix(c, ray, clamp(fR,0.0,0.80));',
    '  return c;',
    '}',
    'vec3 pertN(vec3 n, vec2 d, float amp){',
    '  vec3 up = abs(n.y)<0.985 ? vec3(0.0,1.0,0.0) : vec3(1.0,0.0,0.0);',
    '  vec3 t = normalize(cross(up,n)); vec3 b = cross(n,t);',
    '  return normalize(n + (t*d.x + b*d.y)*amp);',
    '}',
    'vec4 triDet(vec3 p, vec3 n, float s){',
    '  vec3 w = abs(n); w = w*w*w; w /= (w.x+w.y+w.z+1e-5);',
    '  return texture2D(uDet,p.zy*s)*w.x + texture2D(uDet,p.xz*s)*w.y + texture2D(uDet,p.xy*s)*w.z;',
    '}'
  ].join('\n');
  const G_TAIL = '  float lm=dot(c,vec3(0.3333)); if(!(lm<1e5)) c=vec3(0.0);\n  gl_FragColor=vec4(min(c,vec3(12000.0)),1.0);';

  const MATS = [];
  function mkMat(vs, fs, extra, opts) {
    const u = {};
    for (const k in U) u[k] = U[k];
    if (extra) for (const k in extra) u[k] = extra[k];
    const m = new THREE.ShaderMaterial(Object.assign({
      uniforms: u,
      vertexShader: vs,
      fragmentShader: fs,
      side: THREE.FrontSide
    }, opts || {}));
    MATS.push(m);
    return m;
  }

  /* ------------------------------------------------------------- terrain  */
  let terrainMesh = null;
  function discGeometry(nA, nR, r0, R) {
    const nv = (nR + 1) * nA + 1;
    const pos = new Float32Array(nv * 3);
    for (let j = 0; j <= nR; j++) {
      const r = r0 * Math.pow(R / r0, j / nR);
      for (let i = 0; i < nA; i++) {
        const a = i / nA * 2 * PI, k = (j * nA + i) * 3;
        pos[k] = Math.cos(a) * r; pos[k + 1] = 0; pos[k + 2] = Math.sin(a) * r;
      }
    }
    const cIdx = (nR + 1) * nA;                              // centre vertex
    const idx = new Uint32Array(nR * nA * 6 + nA * 3);
    let p = 0;
    for (let i = 0; i < nA; i++) { idx[p++] = cIdx; idx[p++] = (i + 1) % nA; idx[p++] = i; }
    for (let j = 0; j < nR; j++) for (let i = 0; i < nA; i++) {
      const i2 = (i + 1) % nA;
      const a = j * nA + i, b = j * nA + i2, c = (j + 1) * nA + i, d = (j + 1) * nA + i2;
      idx[p++] = a; idx[p++] = b; idx[p++] = c;
      idx[p++] = b; idx[p++] = d; idx[p++] = c;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), R * 1.05);
    return g;
  }
  function buildTerrain(scene, hi) {
    const geo = discGeometry(hi ? 384 : 176, hi ? 360 : 168, 2.5, 11000);
    const SAMP = [
      // highp is MANDATORY: GLSL ES 1.00 defaults sampler2D to lowp (range ±2), which
      // would truncate a 200 m hilltop to 2 m on any driver that honours the spec.
      'uniform highp sampler2D uH, uHC;',
      'uniform vec2 uH0, uHN, uC0, uCN; uniform float uHS, uCS;',
      'vec4 tap(sampler2D t, vec2 p, vec2 o, vec2 n, float s){',
      '  vec2 g=(p-o)/s; vec2 i=floor(g); vec2 f=g-i; f=f*f*(3.0-2.0*f);',
      '  vec2 c=(i+0.5)/n; vec2 du=vec2(1.0/n.x,0.0), dv=vec2(0.0,1.0/n.y);',
      '  return mix(mix(texture2D(t,c),texture2D(t,c+du),f.x), mix(texture2D(t,c+dv),texture2D(t,c+du+dv),f.x), f.y);',
      '}',
      /* Two-level field: the 5 m sailing-area bake inside, the 64 m island-wide
         bake outside, cross-faded over 420 m. The old shader extrapolated the
         clamped edge texel outward, which is what produced the flat welded
         "hedge" running off the side of frame.                               */
      'vec4 terr(vec2 p){',
      '  vec4 C = tap(uHC,p,uC0,uCN,uCS);',
      '  vec2 lo=uH0+vec2(70.0), hi=uH0+uHS*(uHN-vec2(1.0))-vec2(70.0);',
      '  vec2 e=min(p-lo, hi-p);',
      '  float w=smoothstep(0.0,420.0,min(e.x,e.y));',
      '  if (w<=0.002) return C;',
      '  return mix(C, tap(uH,p,uH0,uHN,uHS), w);',
      '}'
    ].join('\n');
    const vs = [
      'precision highp float;', G_COMMON, SAMP,
      'varying vec3 vW; varying vec4 vH; varying float vD;',
      'void main(){',
      '  vec4 wp = modelMatrix*vec4(position,1.0);',
      '  vec4 H = terr(wp.xz);',
      '  wp.y = H.x;',
      '  vW = wp.xyz; vH = H; vD = length(wp.xyz-cameraPosition);',
      '  gl_Position = projectionMatrix*viewMatrix*wp;',
      '}'
    ].join('\n');
    const fs = [
      'precision highp float;', G_COMMON, G_LIGHT,
      'uniform highp sampler2D uHC; uniform vec2 uC0, uCN; uniform float uCS;',
      'uniform sampler2D uCov; uniform vec4 uCovR;',
      'varying vec3 vW; varying vec4 vH; varying float vD;',
      // one bilinear tap of the coarse height, for the sun-visibility march
      'float chAt(vec2 p){',
      '  vec2 g=(p-uC0)/uCS; vec2 i=floor(g); vec2 f=g-i;',
      '  vec2 c=(i+0.5)/uCN; vec2 du=vec2(1.0/uCN.x,0.0), dv=vec2(0.0,1.0/uCN.y);',
      '  return mix(mix(texture2D(uHC,c).x,texture2D(uHC,c+du).x,f.x),',
      '             mix(texture2D(uHC,c+dv).x,texture2D(uHC,c+du+dv).x,f.x), f.y);',
      '}',
      /* Ridge shadows. Marching the coarse height field toward the sun with a
         geometric step gives real cast shadow across kilometres for the cost of
         a handful of taps, and it tracks the sun instead of being baked.      */
      'float sunShadow(vec3 p){',
      '  if (uSunDir.y < 0.045) return 1.0;',
      /* Start from the COARSE surface, not the shaded point. The fragment's own
         height comes from the fine field, which the erosion pass cut below the
         64 m cell average; marching from there makes every eroded gully shadow
         itself and drops a flat grey veil over the whole hillside.           */
      '  p.y = max(p.y, chAt(p.xz)) + 1.5;',
      '  float sh = 1.0, t = 70.0;',
      '  for (int i=0;i<' + (hi ? 16 : 8) + ';i++){',
      '    vec3 q = p + uSunDir*t;',
      '    float d = chAt(q.xz) - (q.y + 2.5 + t*0.02);',
      '    sh = min(sh, 1.0 - smoothstep(0.0, 30.0+t*0.02, d));',
      '    t *= ' + (hi ? '1.34' : '1.85') + ';',
      '  }',
      '  return clamp(sh,0.0,1.0);',
      '}',
      'void main(){',
      '  vec3 n0 = normalize(vec3(vH.z, sqrt(max(1.0-vH.z*vH.z-vH.w*vH.w,0.02)), vH.w));',
      '  float near = clamp(1.0-vD/420.0,0.0,1.0);',
      '  vec4 D  = triDet(vW, n0, 0.55);',
      '  vec4 D2 = triDet(vW, n0, 0.055);',
      '  vec4 D3 = triDet(vW, n0, 0.0086);',
      '  float sl = 1.0-n0.y;',
      '  float ao = clamp(vH.y,0.0,1.0);',
      '  vec2 cuv = (vW.xz-uCovR.xy)*uCovR.zw;',
      '  vec4 CV = texture2D(uCov, clamp(cuv,vec2(0.0),vec2(1.0)));',
      '  float inCov = step(abs(cuv.x-0.5),0.5)*step(abs(cuv.y-0.5),0.5);',
      '  float road = CV.r*inCov, town = CV.g*inCov, contact = CV.b*inCov;',
      '  float m1 = fbm2(vW.xz*0.0013);',
      '  float m2 = fbm2(vW.xz*0.0068);',
      '  vec3 alb; float rough; float f0; float dAmp; float foam = 0.0; float shd = 1.0;',
      '  float vegT = 0.0; float bounce = 0.0;',
      '  if (vH.x >= 0.0) {',
      '    float h = vH.x;',
      '    shd = sunShadow(vW);',
      /* Land cover by altitude x slope x aspect, with noise-perturbed edges:
         rainforest in the gullies and up high, dry scrub on the sun-baked west
         faces, red volcanic soil where the scrub thins, rock above ~35 deg.  */
      '    float west  = clamp(-n0.x*0.85+0.20, 0.0, 1.0);',
      /* Fall-line frame. Every dry patch, scree run and landslip on a real hill
         is elongated DOWNHILL, because that is the direction water and debris
         move. Noise sampled in world xz is isotropic and lands as unmotivated
         round smears that follow neither slope nor drainage — the "flat brown
         texture blob" tell. Sampling in a frame stretched along the gradient
         turns the same noise into fall lines for free.                       */
      '    vec2 fall = normalize(vec2(-n0.x, -n0.z) + vec2(1e-4, 1e-4));',
      '    vec2 acr  = vec2(-fall.y, fall.x);',
      '    float fa = dot(vW.xz, fall), ac = dot(vW.xz, acr);',
      '    float streak = fbm2(vec2(ac*0.0330, fa*0.0021) + vec2(5.0,1.0));',
      '    float streak2= fbm2(vec2(ac*0.0105, fa*0.0009) + vec2(2.0,8.0));',
      '    float wRock = smoothstep(0.50,0.80, sl + (m2-0.5)*0.22 + (1.0-ao)*0.10);',
      '    float wDry  = smoothstep(0.12,0.46, sl)*smoothstep(170.0,25.0,h)',
      '                 *(0.15+0.85*west)*smoothstep(0.46,0.80, streak2*0.62+streak*0.38);',
      // scree / landslip: steep ground only, and always a downhill run
      '    float wRed  = smoothstep(0.56,0.88, streak*0.56+sl*0.70)*smoothstep(0.30,0.62,sl);',
      '    float wFor  = smoothstep(0.26,0.60, (1.0-sl)*0.30 + (1.0-ao)*0.55',
      '                 + smoothstep(4.0,95.0,h)*0.55 + (m1-0.5)*0.38);',
      // beach width varies along the coast and rocky heads cut it entirely, so
      // the sand stops reading as a constant-width ribbon ruled along the shore
      '    float shoreN = fbm2(vec2(vW.z, vW.x*0.35)*0.0042);',
      '    float rocky = smoothstep(0.46,0.74, shoreN + (m2-0.5)*0.38);',
      '    float bw = 2.5 + 15.0*shoreN;',
      '    float wBeach= smoothstep(bw,0.30,h)*smoothstep(0.32,0.06,sl)*(1.0-rocky);',
      '    float wShore= smoothstep(bw*1.5+3.0,0.30,h)*rocky;',
      /* Albedos live in the same hue family as the instanced foliage that sits
         on top of them (a cool blue-green base, a warm yellow-green crown) and
         are roughly 2x the old values: tropical vegetation is not a 4% reflector,
         and a landmass painted that dark cannot show a lit-to-shaded value ramp
         no matter how good the lighting is.                                  */
      '    vec3 cCanopy= mix(vec3(0.030,0.070,0.026), vec3(0.090,0.158,0.048), m2*0.65+0.35*D2.b);',
      '    vec3 cScrub = mix(vec3(0.066,0.118,0.040), vec3(0.162,0.216,0.076), m2*0.6+0.4*D3.b);',
      '    vec3 cGrass = mix(vec3(0.152,0.176,0.068), vec3(0.276,0.278,0.122), D3.b);',
      '    vec3 cRed   = mix(vec3(0.132,0.058,0.032), vec3(0.238,0.114,0.064), D.b);',
      '    vec3 cRock  = mix(vec3(0.072,0.068,0.062), vec3(0.212,0.202,0.184), D.b*0.7+0.3*D2.b);',
      '    vec3 cSand  = mix(vec3(0.395,0.348,0.256), vec3(0.615,0.560,0.436), D.b*0.65+0.35);',
      '    vec3 cCor   = mix(vec3(0.400,0.320,0.290), vec3(0.640,0.520,0.470), D.b);',
      '    cSand = mix(cSand, cCor, smoothstep(0.56,0.82,fbm2(vW.xz*0.05))*0.5);',
      '    alb = mix(cScrub, cCanopy, wFor);',
      '    alb = mix(alb, cGrass, wDry*0.70);',
      '    alb = mix(alb, cRed,   wRed*0.55);',
      '    alb = mix(alb, cRock,  wRock);',
      '    alb = mix(alb, cSand,  wBeach);',
      '    alb = mix(alb, cRock*0.82, wShore);',
      '    alb = mix(alb, vec3(0.215,0.176,0.132), town*0.50);',
      '    alb = mix(alb, vec3(0.150,0.144,0.134), road*0.88);',
      /* MACRO variation. Detail noise alone gives a uniform grain over the whole
         mass, and a uniform grain reads as woven fabric, not landscape. These
         are the kilometre- and hundred-metre-scale breaks: cleared and cultivated
         ground on the gentle low shoulders, drier yellowed pasture where the
         canopy thins, and a slow hue drift across the whole massif.          */
      '    float M1 = fbm2(vW.xz*0.00082 + vec2(31.0,17.0));',
      '    float M2 = fbm2(vW.xz*0.00340 + vec2(9.0,4.0));',
      '    float M3 = fbm2(vW.xz*0.01150 + vec2(23.0,41.0));',
      '    float field = smoothstep(0.60,0.84, M2*0.7+M3*0.3)*smoothstep(0.34,0.06,sl)',
      '                 *smoothstep(300.0,30.0,h)*(1.0-wRock)*(1.0-wBeach);',
      '    alb = mix(alb, cGrass*vec3(1.02,1.00,0.84), field*0.46*(1.0-town));',
      '    alb = mix(alb, cScrub*vec3(1.10,1.04,0.80), smoothstep(0.42,0.72,M1)*0.26*(1.0-wRock));',
      '    alb *= 0.70 + 0.30*M1 + 0.20*M2 + 0.12*M3;',
      '    alb.r *= 1.0 + 0.20*(M1-0.5) + 0.10*(M3-0.5);',
      '    alb.b *= 1.0 - 0.17*(M1-0.5);',
      '    alb *= 0.86+0.28*D2.b;',
      '    alb *= mix(1.0, 0.80+0.42*D.b, near*0.85);',
      /* canopy clump shadowing: the same low-frequency density the instanced
         foliage is scattered from, so trees sit ON the ground instead of
         floating as decals over an evenly lit slope.                        */
      /* Canopy shading, at BOTH scales. The low-frequency term uses the exact
         same field the instanced canopy is scattered from (fbm at 0.0030), so
         the ground genuinely darkens where the forest is dense instead of the
         two disagreeing. The high-frequency term is the dappled shade of the
         individual crowns: the 512-texel cover mask is 8 m per texel and can
         never resolve a 4 m contact shadow, so without this the trees have no
         contact with the ground at all and read as decals pasted on a lawn. */
      '    float vegLo = smoothstep(0.30,0.78, fbm2(vW.xz*0.0030))*(1.0-wRock)*(1.0-wBeach);',
      '    float vegHi = smoothstep(0.34,0.80, fbm2(vW.xz*0.075+vec2(17.0,5.0)));',
      '    float veg = vegLo*(0.45+0.55*vegHi);',
      '    ao *= (1.0 - 0.52*veg*(1.0-town))*(1.0 - 0.62*contact);',
      '    alb *= 1.0 - 0.30*contact;',
      '    alb *= 1.0 - 0.18*vegLo*vegHi*(1.0-town);',
      '    rough = mix(0.94, 0.70, wRock);',
      '    float swash = 0.55+0.45*sin(uTime*0.66);',
      '    float wet = smoothstep(4.2+swash*1.6, 0.02, h)*clamp(wBeach+wShore*0.8,0.0,1.0);',
      '    alb *= mix(1.0, 0.40, wet);',
      '    rough = mix(rough, 0.12, wet);',
      '    f0 = mix(0.020, 0.038, wet);',
      '    dAmp = mix(0.18,1.05,near)*(1.0-0.75*road)*(0.5+0.8*wRock);',
      '    vegT = clamp((wFor*0.85 + (1.0-wRock)*(1.0-wBeach)*0.30)*(1.0-town), 0.0, 1.0);',
      // the sea is a huge bright reflector: low coastal ground picks up a cool
      // bounce off it that no purely hemispheric ambient term will produce
      '    bounce = smoothstep(150.0, 0.0, h)*clamp(0.35+0.65*west, 0.0, 1.0);',
      '  } else {',
      '    float d = -vH.x;',
      '    float pat = fbm2(vW.xz*0.030);',
      '    alb = mix(vec3(0.600,0.560,0.440), vec3(0.720,0.672,0.528), D.b);',
      '    alb = mix(alb, vec3(0.400,0.330,0.290), smoothstep(0.42,0.74,pat)*smoothstep(12.0,3.0,d));',
      '    alb = mix(alb, vec3(0.052,0.100,0.046), smoothstep(0.56,0.86,fbm2(vW.xz*0.021+vec2(3.0,7.0)))*smoothstep(10.0,2.0,d));',
      '    alb = mix(alb, vec3(0.052,0.048,0.043), smoothstep(12.0,27.0,d));',
      /* Shore break. Bands keyed to depth so they follow every bay and rock,
         scrolling shoreward and dissolving into a foam mat in the swash.     */
      '    float shoal = smoothstep(3.4,0.10,d);',
      '    float w1 = sin((d*2.3 - uTime*0.80 + fbm2(vW.xz*0.016)*4.5)*3.14159);',
      '    float w2 = sin((d*3.9 - uTime*1.23 + fbm2(vW.xz*0.031+vec2(4.0))*5.0)*3.14159);',
      '    foam = (smoothstep(0.35,0.98,w1)*0.75 + smoothstep(0.55,1.0,w2)*0.45)*shoal*shoal;',
      '    foam += smoothstep(0.9,0.05,d)*0.55;',
      '    foam *= 0.45+0.55*fbm2(vW.xz*0.42+vec2(uTime*0.6,uTime*0.25));',
      '    foam = clamp(foam,0.0,1.0);',
      '    alb = mix(alb, vec3(0.780,0.830,0.860), foam*0.92);',
      '    rough = mix(0.95,0.42,foam); f0 = 0.020;',
      '    dAmp = mix(0.15,0.75,near)*(1.0-foam);',
      '    float rp = sin((vW.x*0.92+vW.z*0.39)*2.9 + fbm2(vW.xz*0.05)*7.0);',
      '    n0 = normalize(n0 + vec3(0.92,0.0,0.39)*rp*0.11*smoothstep(8.0,1.0,d));',
      '  }',
      '  vec3 N = pertN(n0, (D.rg*2.0-1.0)*1.0 + (D2.rg*2.0-1.0)*0.55, dAmp);',
      '  vec3 V = normalize(cameraPosition-vW);',
      '  float aoT = ao*mix(0.72,1.0,D.b);',
      '  float ndl = max(dot(N,uSunDir),0.0);',
      // drifting cumulus shadow bands: the cheapest way to give a landmass scale
      '  float cs = cloudShadow(vW);',
      '  float sun = ndl*shd*cs;',
      '  vec3 c = alb*0.3183099*(uSunCol*uSunE*sun',
      '         + uSkyCol*uSkyE*(0.32+0.68*max(N.y,0.0))*aoT);',
      // bounced light off the sunlit ground keeps the shadowed gullies from going flat black
      '  c += alb*0.3183099*uSunCol*uSunE*0.045*max(uSunDir.y,0.0)*aoT*(1.0-shd*0.35);',
      // sea bounce onto the coastal slopes: cool, and only where the water is seen
      '  c += alb*vec3(0.46,0.74,1.00)*uSkyE*0.075*bounce*aoT;',
      /* Canopy translucency. A backlit or hard-lit leaf transmits, so a sunlit
         forest flank goes pale yellow-green well above what its albedo alone
         would give — this is the top half of the 2.5-stop ramp the reviewer
         wanted, and it only lands on ground that is actually vegetated.      */
      '  c += vegT*vec3(0.070,0.104,0.024)*uSunCol*uSunE*0.3183099*pow(sun,1.35);',
      '  c += uSunCol*uSunE*ggx(N,V,rough)*f0*ndl*shd*cs;',
      '  c += vec3(0.9,0.95,1.0)*foam*uSkyE*0.020;',
      '  c = fogApply(c, vD, -V, vW.y);',
      G_TAIL,
      '}'
    ].join('\n');
    const mat = mkMat(vs, fs, {
      uH: { value: heightTex },
      uH0: { value: new THREE.Vector2(TX0, TZ0) },
      uHN: { value: new THREE.Vector2(GW, GH) },
      uHS: { value: GS },
      uHC: { value: coarseTex },
      uC0: { value: new THREE.Vector2(CX0, CZ0) },
      uCN: { value: new THREE.Vector2(CW, CGH) },
      uCS: { value: CS },
      uCov: { value: coverTex },
      uCovR: { value: new THREE.Vector4(VX0, VZ0, 1 / (VX1 - VX0), 1 / (VZ1 - VZ0)) }
    });
    terrainMesh = new THREE.Mesh(geo, mat);
    terrainMesh.frustumCulled = false;
    terrainMesh.renderOrder = -100;
    terrainMesh.matrixAutoUpdate = true;
    scene.add(terrainMesh);
  }

  /* ------------------------------------------------------- merge helper   */
  function merge(items) {
    let vc = 0;
    const gs = [];
    for (const it of items) {
      let g = it.geo.index ? it.geo.toNonIndexed() : it.geo.clone();
      if (it.m) g.applyMatrix4(it.m);
      gs.push({ g, c: it.c || [1, 1, 1], e: it.e || [0, 0, 0, 0], us: it.us || null, cy: it.cy || null });
      vc += g.attributes.position.count;
    }
    const P = new Float32Array(vc * 3), N = new Float32Array(vc * 3);
    const Uv = new Float32Array(vc * 2), C = new Float32Array(vc * 3), E = new Float32Array(vc * 4);
    let o = 0;
    for (const it of gs) {
      const g = it.g, n = g.attributes.position.count;
      P.set(g.attributes.position.array, o * 3);
      if (g.attributes.normal) N.set(g.attributes.normal.array, o * 3);
      if (g.attributes.uv) Uv.set(g.attributes.uv.array, o * 2);
      for (let i = 0; i < n; i++) {
        const k = o + i;
        let col = it.c;
        if (it.cy) col = it.cy(P[k * 3 + 1], P[k * 3], P[k * 3 + 2]);
        C[k * 3] = col[0]; C[k * 3 + 1] = col[1]; C[k * 3 + 2] = col[2];
        E[k * 4] = it.e[0]; E[k * 4 + 1] = it.e[1]; E[k * 4 + 2] = it.e[2]; E[k * 4 + 3] = it.e[3];
        if (it.us) { Uv[k * 2] *= it.us[0]; Uv[k * 2 + 1] *= it.us[1]; }
      }
      o += n;
      g.dispose();
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(P, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(N, 3));
    out.setAttribute('aUv', new THREE.BufferAttribute(Uv, 2));
    out.setAttribute('aCol', new THREE.BufferAttribute(C, 3));
    out.setAttribute('aExtra', new THREE.BufferAttribute(E, 4));
    out.computeBoundingSphere();
    return out;
  }
  const ADDED = [];
  function add(scene, mesh) { scene.add(mesh); ADDED.push(mesh); return mesh; }
  const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1);
  function TRS(x, y, z, ry, sx, sy, sz, rx, rz) {
    _e.set(rx || 0, ry || 0, rz || 0, 'YXZ');
    _q.setFromEuler(_e); _v.set(x, y, z); _s.set(sx === undefined ? 1 : sx, sy === undefined ? 1 : sy, sz === undefined ? 1 : sz);
    return _m4.compose(_v, _q, _s).clone();
  }

  /* ---------------------------------------------------- solid material    */
  // BOB 0 = static, 1 = swell-driven (fleet), 2 = indexed uniform (buoys)
  function solidMat(map, bob, opts) {
    const o = opts || {};
    const vs = [
      'precision highp float;', G_COMMON,
      'uniform vec3 uWind; uniform float uTime; uniform vec4 uSwell;',
      (bob === 2 ? 'uniform vec4 uBuoy[40];' : ''),
      'attribute vec2 aUv; attribute vec3 aCol; attribute vec4 aExtra;',
      'varying vec3 vW, vN, vC; varying vec2 vUv; varying float vD;',
      'void main(){',
      '  vec3 p = position; vec3 n = normal;',
      bob === 1 ? [
        '  float ph = uSwell.z*(uSwell.x*aExtra.x+uSwell.y*aExtra.y) - uTime*uSwell.z*9.9 + aExtra.z;',
        '  float dy = sin(ph)*uSwell.w*aExtra.w;',
        '  float rl = cos(ph)*uSwell.w*aExtra.w*0.10;',
        '  p.y += dy; p.xz += p.y*vec2(rl, rl*0.42);'
      ].join('\n') : '',
      bob === 2 ? [
        '  float en = aExtra.z;',                      // 0 = static dock hardware, 1 = floating
        '  int bi = int(aExtra.w);',
        '  vec4 B = uBuoy[bi];',
        '  p.y += B.x*en; p.xz += p.y*B.yz*en;'
      ].join('\n') : '',
      '  vec4 wp = modelMatrix*vec4(p,1.0);',
      '  vW = wp.xyz; vN = normalize(mat3(modelMatrix)*n); vC = aCol; vUv = aUv;',
      '  vD = length(wp.xyz-cameraPosition);',
      '  gl_Position = projectionMatrix*viewMatrix*wp;',
      '}'
    ].join('\n');
    const fs = [
      'precision highp float;', G_COMMON, G_LIGHT,
      map ? 'uniform sampler2D uMap;' : '',
      'uniform float uRough, uF0, uDetS, uDetA, uEmis, uWin;',
      'varying vec3 vW, vN, vC; varying vec2 vUv; varying float vD;',
      'void main(){',
      '  vec3 alb = vC;',
      '  float win = 0.0;',
      map ? ['  vec4 t = texture2D(uMap, vUv); alb *= s2l(t.rgb);',
        '  win = uWin*step(dot(t.rgb,vec3(0.3333)),0.30)*step(t.r+0.02,t.b);'].join('\n') : '',
      '  vec3 n0 = normalize(vN);',
      '  float near = clamp(1.0-vD/160.0,0.0,1.0);',
      '  vec4 D = triDet(vW, n0, uDetS);',
      '  vec3 N = pertN(n0, D.rg*2.0-1.0, uDetA*near);',
      '  vec3 V = normalize(cameraPosition-vW);',
      '  float ao = mix(0.75,1.0,D.b);',
      '  vec3 c = lamb(alb, N, ao, vW);',
      '  c += uSunCol*uSunE*ggx(N,V,uRough)*uF0*max(dot(N,uSunDir),0.0);',
      '  c += vec3(1.0,0.70,0.34)*win*uNight*26.0;',
      '  c += alb*uEmis;',
      '  c = fogApply(c, vD, -V, vW.y);',
      G_TAIL,
      '}'
    ].join('\n');
    const ex = {
      uRough: { value: o.rough === undefined ? 0.72 : o.rough },
      uF0: { value: o.f0 === undefined ? 0.035 : o.f0 },
      uDetS: { value: o.detS === undefined ? 1.4 : o.detS },
      uDetA: { value: o.detA === undefined ? 0.5 : o.detA },
      uEmis: { value: o.emis === undefined ? 0.0 : o.emis },
      uWin: { value: o.win === undefined ? 0.0 : o.win },
      uSwell: U.uSwell
    };
    if (map) ex.uMap = { value: map };
    if (bob === 2) ex.uBuoy = { value: BUOY_U };
    return mkMat(vs, fs, ex, { side: o.side || THREE.FrontSide });
  }
  const BUOY_U = [];
  for (let i = 0; i < 40; i++) BUOY_U.push(new THREE.Vector4(0, 0, 0, 0));

  /* ---------------------------------------------------- foliage materials */
  // kind: 'inst' (instanced geometry, alpha), 'solid' (instanced, opaque), 'bb' (billboard)
  function foliageMat(map, kind, opts) {
    const o = opts || {};
    const bb = kind === 'bb', alpha = kind !== 'solid';
    const vs = [
      'precision highp float;', G_COMMON,
      'uniform vec3 uWind; uniform float uTime, uSwayH, uSwayA;',
      'attribute vec4 aIns0, aIns1;',
      'varying vec3 vW, vN; varying vec2 vUv; varying float vD, vT, vB;',
      'void main(){',
      '  float ph = aIns1.y;',
      '  float sw = (sin(uTime*1.62+ph)+0.55*sin(uTime*2.87+ph*1.7)+0.3*sin(uTime*4.3+ph*2.4))*uWind.z;',
      bb ? [
        '  vec3 tc = cameraPosition - aIns0.xyz;',
        '  vec3 rgt = normalize(vec3(-tc.z,0.0,tc.x)+vec3(1e-4,0.0,0.0));',
        '  vec3 fwd = normalize(vec3(tc.x,0.0,tc.z)+vec3(0.0,0.0,1e-4));',
      // billboards reuse aIns1.x (the instance rotation, meaningless for a
      // camera-facing card) as a vertical squash, so the canopy stops reading
      // as a field of identical round dots
        '  float sq = aIns1.x > 0.02 ? aIns1.x : 1.0;',
        '  float hf = position.y+0.5;',
        '  vec3 lp = rgt*position.x*aIns0.w + vec3(0.0,1.0,0.0)*hf*aIns0.w*sq;',
        '  lp.xz += uWind.xy*sw*uSwayA*hf*aIns0.w*0.12;',
        '  vec3 wp = aIns0.xyz + lp;',
        '  vN = normalize(rgt*position.x*1.7 + vec3(0.0,1.0,0.0)*(position.y*0.9+0.25) + fwd*0.80);'
      ].join('\n') : [
        '  float ca=cos(aIns1.x), sa=sin(aIns1.x);',
        '  vec3 p = position*aIns0.w;',
        '  vec3 rp = vec3(p.x*ca+p.z*sa, p.y, -p.x*sa+p.z*ca);',
        '  vec3 rn = vec3(normal.x*ca+normal.z*sa, normal.y, -normal.x*sa+normal.z*ca);',
        '  float hf = clamp(rp.y/(uSwayH*aIns0.w),0.0,1.0); hf=hf*hf;',
        '  rp.xz += uWind.xy*sw*uSwayA*hf*aIns0.w;',
        '  rp.y -= abs(sw)*uSwayA*hf*aIns0.w*0.28;',
        '  vec3 wp = aIns0.xyz + rp;',
        '  vN = normalize(rn);'
      ].join('\n'),
      '  vW = wp; vUv = uv; vT = aIns1.z; vB = aIns1.w;',
      '  vD = length(wp-cameraPosition);',
      '  gl_Position = projectionMatrix*viewMatrix*vec4(wp,1.0);',
      '}'
    ].join('\n');
    const fs = [
      'precision highp float;', G_COMMON, G_LIGHT,
      'uniform sampler2D uMap; uniform vec3 uTintA, uTintB; uniform float uRough;',
      'varying vec3 vW, vN; varying vec2 vUv; varying float vD, vT, vB;',
      'void main(){',
      '  vec4 t = texture2D(uMap, vUv);',
      /* Alpha-test coverage is not mip-stable: every mip halves the average
         alpha of a cut-out, so a fixed cutoff erodes the silhouette away with
         distance until the instance disappears entirely. Slide the cutoff down
         with distance to hold roughly constant coverage.                     */
      alpha ? '  if (t.a < mix(0.40, 0.13, smoothstep(60.0, 700.0, vD))) discard;' : '',
      // per-instance value AND hue jitter: one flat green over a whole hillside
      // is the single loudest "placeholder texture" tell
      '  vec3 alb = s2l(t.rgb)*mix(uTintA,uTintB,vT);',
      '  float jb = fract(vB); float jh = floor(vB)*0.01;',
      '  alb *= 0.72+0.62*jb;',
      '  alb.r *= 1.0+0.22*(jh-0.5); alb.b *= 1.0-0.20*(jh-0.5);',
      '  vec3 N = normalize(vN);',
      '  vec3 V = normalize(cameraPosition-vW);',
      '  if (dot(N,V) < 0.0) N = -N;',
      '  float ndl = dot(N,uSunDir);',
      '  float wrapd = max((ndl+0.42)/1.42, 0.0);',
      '  float trans = 0.52*max(-ndl,0.0)*pow(max(dot(V,-uSunDir),0.0),1.6);',
      '  float cs = cloudShadow(vW);',
      /* Sunlit canopy is a translucent yellow-green, not the same green in a
         brighter key: the leaf transmits, so the lit side gains chroma toward
         yellow while the shaded side falls toward blue-green. Matching that
         shift is what stops the foliage reading as flat green decals.       */
      '  vec3 warm = alb*vec3(1.30,1.14,0.60);',
      '  vec3 cool = alb*vec3(0.72,0.94,1.10);',
      '  vec3 albL = mix(cool, warm, smoothstep(-0.15,0.75,ndl));',
      '  vec3 c = albL*0.3183099*uSunCol*uSunE*(wrapd*cs+trans*cs);',
      '  c += alb*0.3183099*uSkyCol*uSkyE*(0.42+0.40*max(N.y,0.0));',
      '  c += uSunCol*uSunE*ggx(N,V,uRough)*0.028*max(ndl,0.0)*cs;',
      '  c = fogApply(c, vD, -V, vW.y);',
      G_TAIL,
      '}'
    ].join('\n');
    return mkMat(vs, fs, {
      uMap: { value: map },
      uTintA: { value: new THREE.Color(o.tintA || 0xffffff) },
      uTintB: { value: new THREE.Color(o.tintB || 0xffffff) },
      uRough: { value: o.rough === undefined ? 0.55 : o.rough },
      uSwayH: { value: o.swayH === undefined ? 8.0 : o.swayH },
      uSwayA: { value: o.swayA === undefined ? 0.10 : o.swayA }
    }, { side: THREE.DoubleSide });
  }

  /* ------------------------------------------------ instanced bucketing   */
  const vegBuckets = [];
  function instBucket(baseGeo, items, mat, itemRad, lodMax, scene) {
    const n = items.length;
    if (!n) return null;
    const g = new THREE.InstancedBufferGeometry();
    g.copy(baseGeo);
    const a0 = new Float32Array(n * 4), a1 = new Float32Array(n * 4);
    let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9, y0 = 1e9, y1 = -1e9, sm = 0;
    for (let i = 0; i < n; i++) {
      const it = items[i];
      a0[i * 4] = it.x; a0[i * 4 + 1] = it.y; a0[i * 4 + 2] = it.z; a0[i * 4 + 3] = it.s;
      a1[i * 4] = it.r; a1[i * 4 + 1] = it.p; a1[i * 4 + 2] = it.t;
      a1[i * 4 + 3] = it.b === undefined ? 50.5 : it.b;
      if (it.x < x0) x0 = it.x; if (it.x > x1) x1 = it.x;
      if (it.z < z0) z0 = it.z; if (it.z > z1) z1 = it.z;
      if (it.y < y0) y0 = it.y; if (it.y > y1) y1 = it.y;
      if (it.s > sm) sm = it.s;
    }
    g.setAttribute('aIns0', new THREE.InstancedBufferAttribute(a0, 4));
    g.setAttribute('aIns1', new THREE.InstancedBufferAttribute(a1, 4));
    g.instanceCount = n;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
    const rad = 0.5 * Math.hypot(x1 - x0, y1 - y0, z1 - z0) + itemRad * sm + 2;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, cy, cz), rad);
    const m = new THREE.Mesh(g, mat);
    m.frustumCulled = true;
    m.userData.lod = lodMax; m.userData.cx = cx; m.userData.cz = cz; m.userData.rad = rad;
    scene.add(m);
    vegBuckets.push(m);
    return m;
  }
  function bucketise(list, cell) {
    const map = new Map();
    for (const it of list) {
      const k = Math.floor(it.x / cell) + ',' + Math.floor(it.z / cell);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(it);
    }
    return map;
  }

  /* ----------------------------------------------------------- vegetation */
  function palmGeos() {
    // trunk: curved, tapering, 8 sections
    const SEG = 7, SIDES = 6, H = 7.6;
    const pos = [], nor = [], uv = [], idx = [];
    for (let j = 0; j <= SEG; j++) {
      const t = j / SEG, y = t * H;
      const bend = t * t * 0.9;
      const r = lerp(0.30, 0.135, Math.pow(t, 0.8));
      for (let i = 0; i <= SIDES; i++) {
        const a = i / SIDES * 2 * PI;
        pos.push(Math.cos(a) * r + bend, y, Math.sin(a) * r);
        nor.push(Math.cos(a), 0.16, Math.sin(a));
        uv.push(i / SIDES * 2, t * 4.2);
      }
    }
    for (let j = 0; j < SEG; j++) for (let i = 0; i < SIDES; i++) {
      const a = j * (SIDES + 1) + i, b = a + 1, c = a + SIDES + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const trunk = new THREE.BufferGeometry();
    trunk.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    trunk.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    trunk.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    trunk.setIndex(idx);

    // one drooping frond ribbon, 9 segments, built along +X from the crown
    /* Three-vertex V section rather than a flat ribbon. A real frond folds
       along the rachis; the fold is what stops the crown reading as a set of
       flat paddles the instant the camera moves off the frond's own plane.  */
    function frond(len, wid, droop) {
      const S = 8, p = [], n = [], u = [], ix = [];
      for (let j = 0; j <= S; j++) {
        const t = j / S;
        const x = t * len;
        const y = -droop * t * t * len * 0.62;
        const w = wid * (0.30 + 0.95 * Math.sin(Math.min(1, t * 2.1) * 1.35)) * (1 - t * 0.50);
        const ny = 1 - droop * t * 0.7;
        p.push(x, y + w * 0.32, 0); n.push(0, ny, 0); u.push(t, 0.5);
        for (const s of [-1, 1]) {
          p.push(x, y, s * w);
          n.push(0, ny * 0.78, s * 0.58);
          u.push(t, s > 0 ? 1 : 0);
        }
      }
      for (let j = 0; j < S; j++) {
        const a = j * 3, b = a + 3;
        ix.push(a, b, a + 1, a + 1, b, b + 1);
        ix.push(a, a + 2, b, a + 2, b + 2, b);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(n, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(u, 2));
      g.setIndex(ix);
      return g;
    }
    const items = [];
    const NF = 12;
    for (let k = 0; k < NF; k++) {
      const a = k / NF * 2 * PI + (k % 2) * 0.26;
      // two tiers: an upright inner whorl and a lower ring of older, flatter
      // fronds, so the crown has a profile instead of a single flat disc
      const tier = k % 3 === 2;
      const up = tier ? 0.02 + (k % 2) * 0.10 : 0.40 + (k % 4) * 0.13;
      const len = (tier ? 3.3 : 2.9) + (k % 4) * 0.34, wid = 0.52;
      items.push({ geo: frond(len, wid, (tier ? 0.72 : 0.50) + (k % 3) * 0.13), m: TRS(0.9, H - (tier ? 0.42 : 0.10), 0, -a, 1, 1, 1, 0, up) });
    }
    // coconut cluster
    const nut = new THREE.SphereGeometry(0.16, 5, 3);
    for (let k = 0; k < 3; k++) {
      const a = k / 3 * 6.283;
      items.push({ geo: nut, m: TRS(0.9 + Math.cos(a) * 0.24, H - 0.55, Math.sin(a) * 0.24, 0) });
    }
    const crown = merge(items);
    nut.dispose();
    return { trunk, crown };
  }
  // merged geometry -> foliage-shader geometry (the foliage VS reads `uv`)
  function toFoliage(g) {
    g.setAttribute('uv', g.getAttribute('aUv'));
    g.deleteAttribute('aCol'); g.deleteAttribute('aExtra'); g.deleteAttribute('aUv');
    return g;
  }
  function scrubGeo() {
    const items = [];
    for (let k = 0; k < 3; k++) {
      const q = new THREE.PlaneGeometry(1.85, 1.5);
      q.translate(0, 0.75, 0);
      items.push({ geo: q, m: TRS(0, 0, 0, k / 3 * PI) });
    }
    return toFoliage(merge(items));
  }
  function slopeAt(x, z) {
    const gx = (I.heightAt(x + 7, z) - I.heightAt(x - 7, z)) / 14;
    const gz = (I.heightAt(x, z + 7) - I.heightAt(x, z - 7)) / 14;
    return { s: Math.hypot(gx, gz), gx, gz };
  }
  // soft dark disc stamped into the cover mask: contact shading for anything placed
  function stampCover(x, z, r, amt) {
    if (!COVER) return;
    const sx = LCN / (VX1 - VX0), sz = LCN / (VZ1 - VZ0);
    const cx = (x - VX0) * sx, cz = (z - VZ0) * sz;
    const rx = Math.max(1, r * sx), rz = Math.max(1, r * sz);
    const i0 = Math.max(0, Math.floor(cx - rx)), i1 = Math.min(LCN - 1, Math.ceil(cx + rx));
    const j0 = Math.max(0, Math.floor(cz - rz)), j1 = Math.min(LCN - 1, Math.ceil(cz + rz));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const d = Math.hypot((i + 0.5 - cx) / rx, (j + 0.5 - cz) / rz);
      if (d >= 1) continue;
      const k = (j * LCN + i) * 4 + 2;
      const v = COVER[k] + amt * 255 * (1 - d * d);
      COVER[k] = v > 255 ? 255 : v;
    }
  }
  function buildVegetation(scene, hi) {
    const P = palmGeos();
    toFoliage(P.crown);
    const trunkMat = foliageMat(TEX.bark, 'solid', { tintA: 0xb8a184, tintB: 0x8d7758, swayH: 7.6, swayA: 0.055, rough: 0.86 });
    const crownMat = foliageMat(TEX.frond, 'inst', { tintA: 0x9ad86f, tintB: 0x6fae50, swayH: 7.6, swayA: 0.13, rough: 0.62 });
    const scrubMat = foliageMat(TEX.leaf, 'inst', { tintA: 0xb2dc84, tintB: 0x6f9752, swayH: 1.5, swayA: 0.06, rough: 0.6 });
    /* The canopy sheet is the biggest single area of the island at range, so its
       tint IS the island's colour from the water. The old dark end (0x466c39)
       sat well below the terrain albedo under it, which turned every wooded
       flank into a dark stain and flattened the whole mass to one value.    */
    const canopyMat = foliageMat(TEX.canopy, 'bb', { tintA: 0x93c66c, tintB: 0x4e7a3d, swayA: 0.9, rough: 0.7 });

    const S = { s: 0x51a7c3 };
    const palms = [], scrub = [], canopy = [];
    /* Canopy count. 15k instances over the 4.2 km scatter box is one tree every
       34 m — visibly a confetti of separated dots, never a forest. Rainforest
       has to be a CONTINUOUS sheet with the ground only showing through where
       it genuinely thins, so the count goes up roughly 3x and the crowns
       overlap. They are 4-vertex instanced billboards; the cost is trivial. */
    const NS = hi ? 11000 : 3000, NC = hi ? 44000 : 11000;
    // per-instance hue index (0..99) and value fraction, packed into one float
    const jit = (hue, val) => Math.floor(clamp(hue, 0, 0.999) * 100) + clamp(val, 0, 0.999);

    /* 1. the beach palm line. Thin verticals at the sand/vegetation terminator
       are the strongest read in the whole frame per vertex spent, so they are
       placed deliberately along the shoreline rather than left to the scatter. */
    for (let z = VZ0 + 30; z < VZ1 - 30; z += 11 + rnd(S) * 26) {
      const cx = coastX(z);
      if (islandEnv(cx + 30, z) > -40) continue;
      for (let k = 0; k < 2 + (rnd(S) * 3 | 0); k++) {
        const x = cx + 3 + rnd(S) * 30, zz = z + (rnd(S) - 0.5) * 16;
        if (waterField(x, zz) > -1.5) continue;
        const y = I.heightAt(x, zz);
        if (y < 0.4 || y > 26) continue;
        if (slopeAt(x, zz).s > 0.55) continue;
        palms.push({
          x, y: y - 0.15, z: zz, s: 0.80 + rnd(S) * 0.75, r: rnd(S) * 6.283,
          p: rnd(S) * 6.283, t: rnd(S), b: jit(rnd(S), 0.30 + rnd(S) * 0.62)
        });
        stampCover(x, zz, 3.2, 0.30);
      }
    }
    // and a fringe round the lagoon and the marina basin
    for (let a = 0; a < 6.283; a += 0.035 + rnd(S) * 0.05) {
      const r = 1.02 + rnd(S) * 0.10;
      const x = LAG.rx * r * Math.cos(a), z = LAG.rz * r * Math.sin(a);
      if (waterField(x, z) > -1.0) continue;
      const y = I.heightAt(x, z);
      if (y < 0.4 || y > 22) continue;
      if (coverAt(x, z) > 0.30 && rnd(S) < 0.75) continue;
      palms.push({
        x, y: y - 0.15, z, s: 0.78 + rnd(S) * 0.7, r: rnd(S) * 6.283,
        p: rnd(S) * 6.283, t: rnd(S), b: jit(rnd(S), 0.30 + rnd(S) * 0.6)
      });
      stampCover(x, z, 3.2, 0.28);
    }

    /* 2. scrub — dry, sun-baked west-facing slopes below the forest line */
    let guard = 0;
    while (scrub.length < NS && guard++ < 200000) {
      const x = VX0 + rnd(S) * (VX1 - VX0), z = VZ0 + rnd(S) * (VZ1 - VZ0);
      if (waterField(x, z) > -2) continue;
      const y = I.heightAt(x, z);
      if (y < 0.4 || y > 190) continue;
      const sp = slopeAt(x, z);
      const west = clamp(sp.gx * 1.6 + 0.35, 0, 1);      // rises east => faces west, leeward
      // the leeward slopes are the ones the closed canopy skips, so they must
      // carry a continuous low bush cover or they render as mown lawn
      const dens = (0.45 + 0.55 * west) * sstep(240, 25, y) * (0.45 + 0.55 * sstep(0.05, 0.4, sp.s));
      if (rnd(S) > dens) continue;
      if (rnd(S) < coverAt(x, z) * 0.9) continue;
      scrub.push({
        x, y: y - 0.1, z, s: 1.0 + rnd(S) * 2.4, r: rnd(S) * 6.283, p: rnd(S) * 6.283,
        t: rnd(S), b: jit(rnd(S), 0.22 + rnd(S) * 0.72)
      });
    }
    /* 3. rainforest canopy — dense in the gullies and up the ridges, thinning
       out on the dry faces and stopping dead where the town starts           */
    guard = 0;
    const CR = 2100;
    while (canopy.length < NC && guard++ < 700000) {
      const x = -280 + (rnd(S) - 0.5) * 2 * CR, z = -420 + (rnd(S) - 0.5) * 2 * CR;
      if (waterField(x, z) > -3) continue;
      const y = I.heightAt(x, z);
      if (y < 4) continue;
      const sp = slopeAt(x, z);
      const east = clamp(-sp.gx * 1.6 + 0.45, 0, 1);      // windward, wetter
      let dens = 0.52 + 0.48 * fbm(x * 0.0030, z * 0.0030, 3);
      dens *= 0.55 + 0.45 * east;
      dens *= sstep(4, 34, y);
      // thin out on the exposed crests: wind-clipped ridge scrub, not closed canopy
      dens *= 1 - 0.55 * sstep(210, 340, y);
      dens *= 1 - 0.80 * sstep(0.55, 1.05, sp.s);          // bare rock on the cliffs
      if (rnd(S) > dens) continue;
      if (rnd(S) < coverAt(x, z) * 0.95) continue;
      const far = Math.hypot(x + 280, z + 420) > 1200;
      const s = far ? 11 + rnd(S) * 13 : 7.0 + rnd(S) * 9.0;
      // gully canopy is darker and bluer, ridge canopy lighter and yellower
      const v = clamp(0.20 + 0.75 * sstep(0.9, 0.1, sp.s) * (0.4 + 0.6 * rnd(S)), 0, 0.98);
      canopy.push({
        x, y: y - s * 0.10, z, s, r: 0.52 + rnd(S) * 0.62, p: rnd(S) * 6.283, t: rnd(S),
        b: jit(rnd(S), v)
      });
      if (!far) stampCover(x, z, s * 0.45, 0.22);
    }
    const CELLV = 520;   // bucket size trades frustum-cull granularity against draw calls
    for (const [, arr] of bucketise(palms, CELLV)) {
      instBucket(P.trunk, arr, trunkMat, 9, 1900, scene);
      instBucket(P.crown, arr, crownMat, 9, 1900, scene);
    }
    const SG = scrubGeo();
    for (const [, arr] of bucketise(scrub, CELLV)) instBucket(SG, arr, scrubMat, 2.5, 1500, scene);
    const BB = new THREE.PlaneGeometry(1, 1);
    for (const [, arr] of bucketise(canopy, CELLV)) instBucket(BB, arr, canopyMat, 20, 5200, scene);
  }

  /* ------------------------------------------------------------ the town  */
  function buildTown(scene, hi) {
    const S = { s: 0x2f61bb };
    const wallItems = [], roofItems = [];
    const wallCols = [0xf6ead0, 0xf0dcbe, 0xe8e2d2, 0xf7e8c8, 0xdfe8e2, 0xf2d8c0, 0xe6dcc4,
      0xf2c9a8, 0xcfe0e4, 0xf6dcae, 0xe4cdb4];
    /* Terracotta, and it has to be BRIGHT. The roof albedo is the product of
       this vertex colour and the tile texture, so a "correct looking" mid
       terracotta in both lands the roofs darker than the hillside behind them
       and the town reads as a stain rather than the landmark of the frame. */
    const roofCols = [0xd2624a, 0xc75c40, 0xde7153, 0xbb5338, 0xcd6344, 0xac5340];
    const N = hi ? 940 : 380;
    let n = 0, guard = 0;
    const boxCache = new Map();
    function box(w, h, d) {
      const k = w.toFixed(2) + '_' + h.toFixed(2) + '_' + d.toFixed(2);
      if (!boxCache.has(k)) boxCache.set(k, new THREE.BoxGeometry(w, h, d));
      return boxCache.get(k);
    }
    const roofGeo = new THREE.ConeGeometry(1, 1, 4, 1);
    // 6 m occupancy grid: a tiered town has to pack, but not interpenetrate
    const occ = new Set();
    function free(x, z, r) {
      const i0 = Math.floor((x - r) / 6), i1 = Math.floor((x + r) / 6);
      const j0 = Math.floor((z - r) / 6), j1 = Math.floor((z + r) / 6);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) if (occ.has(i + ',' + j)) return false;
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) occ.add(i + ',' + j);
      return true;
    }
    function place(x, z, w, d, h, rot, sty) {
      const y = I.heightAt(x, z);
      // Sink the walls to the LOWEST footprint corner. Keying the base to the centre
      // height alone leaves the downhill corners floating on any real hillside.
      let ymin = y, ymax = y;
      const c = Math.cos(rot), s = Math.sin(rot);
      for (const ddx of [-w / 2, w / 2]) for (const ddz of [-d / 2, d / 2]) {
        const hh = I.heightAt(x + ddx * c + ddz * s, z - ddx * s + ddz * c);
        if (hh < ymin) ymin = hh;
        if (hh > ymax) ymax = hh;
      }
      // terrace the floor into the hill: cut level with the uphill corner, then
      // carry the wall down to the downhill one so the plinth reads as a retaining wall
      const fl = lerp(ymin, ymax, 0.68);
      const foot = Math.min(fl - ymin, 9.0) + 0.7;
      const wc = lin(wallCols[(rnd(S) * wallCols.length) | 0]);
      wallItems.push({ geo: box(w, h + foot, d), m: TRS(x, fl + (h - foot) / 2, z, rot), c: wc });
      if (foot > 1.8) {   // exposed terrace plinth, in stone not plaster
        wallItems.push({
          geo: box(w * 1.06, foot * 0.9, d * 1.06),
          m: TRS(x, fl - foot * 0.55, z, rot), c: lin(0x7d7263)
        });
      }
      const rr = Math.hypot(w, d) * 0.5 * 1.14;
      const rh = 1.25 + rnd(S) * 1.15 + (sty ? 0.7 : 0);
      const slant = Math.hypot(rr, rh);
      const rc = lin(roofCols[(rnd(S) * roofCols.length) | 0]);
      const jr = 0.82 + rnd(S) * 0.42;                     // per-instance terracotta jitter
      roofItems.push({
        geo: roofGeo, m: TRS(x, fl + h + rh / 2, z, rot + PI / 4, rr, rh, rr),
        c: [rc[0] * jr, rc[1] * jr * (0.9 + rnd(S) * 0.22), rc[2] * jr * (0.88 + rnd(S) * 0.25)],
        us: [2 * PI * rr / 0.34, slant / 0.9]
      });
      // balcony / veranda on the bigger ones
      if (sty && rnd(S) < 0.55) {
        const by = fl + h * 0.52;
        wallItems.push({ geo: box(w * 1.16, 0.14, d * 0.36), m: TRS(x, by, z + d * 0.5, rot), c: lin(0x6b533a) });
        for (let k = -2; k <= 2; k++)
          wallItems.push({ geo: box(0.09, 1.0, 0.09), m: TRS(x + k * w * 0.24, by + 0.5, z + d * 0.62, rot), c: lin(0xe8e4d6) });
      }
      stampCover(x, z, Math.max(w, d) * 0.62, 0.34);
      n++;
    }
    /* Placement is driven by the settlement mask, not a uniform scatter: the
       density already folds in altitude, slope, harbour proximity and road
       access, so the town packs solid round the Carenage, thins going uphill
       and stops dead on the steep upper third.                               */
    while (n < N && guard++ < 260000) {
      const x = -820 + rnd(S) * 1500, z = -1060 + rnd(S) * 1560;
      const dens = coverAt(x, z);
      if (dens < 0.05 || rnd(S) > dens * dens * 1.35) continue;
      const sp = slopeAt(x, z);
      // long axis along the contour, terraced across the fall line
      const rot = Math.atan2(sp.gx, sp.gz) + (rnd(S) - 0.5) * 0.34;
      const st = rnd(S) < 0.22 + 0.34 * dens;
      const w = (st ? 7 : 5) + rnd(S) * (st ? 9 : 6.5);
      const d = 4.4 + rnd(S) * 5.0;
      if (!free(x, z, Math.max(w, d) * 0.5)) continue;
      const h = st ? 7.0 + rnd(S) * 5.4 : 3.4 + rnd(S) * 4.0;
      place(x, z, w, d, h, rot, st);
    }
    /* ---- the Carenage waterfront: two dense tiers behind the town quay, the
       postcard read — a warm red-roofed mass stacked straight out of the water */
    const th0 = -125 * PI / 180, th1 = -58 * PI / 180;
    for (let row = 0; row < 2; row++) {
      const nb = row ? 22 : 30;
      for (let i = 0; i <= nb; i++) {
        const th = th0 + (th1 - th0) * (i / nb) + (row ? 0.012 : 0);
        const px = LAG.rx * Math.cos(th), pz = LAG.rz * Math.sin(th);
        let nx = -px / (LAG.rx * LAG.rx), nz = -pz / (LAG.rz * LAG.rz);
        const nl = Math.hypot(nx, nz); nx /= nl; nz /= nl;
        const back = row ? 27 + rnd(S) * 7 : 12 + rnd(S) * 4;
        const bx = px - nx * back, bz = pz - nz * back;
        if (I.heightAt(bx, bz) < 0.6) continue;
        const rot = Math.atan2(-nx, -nz);
        const w = 7 + rnd(S) * 5, d = 8 + rnd(S) * 4;
        if (!free(bx, bz, Math.max(w, d) * 0.5)) continue;
        place(bx, bz, w, d, (row ? 9.0 : 7.5) + rnd(S) * 5.5, rot, true);
      }
    }
    const wallMat = solidMat(TEX.facade, 0, { rough: 0.80, f0: 0.03, detS: 2.2, detA: 0.25, win: 1.0 });
    const roofMat = solidMat(TEX.tile, 0, { rough: 0.62, f0: 0.05, detS: 3.0, detA: 0.35 });
    // walls use triplanar-free uv: rebuild uv from world coordinates in-shader is
    // unnecessary — the box uv is remapped here to a constant 3.2 x 3.0 m storey.
    for (const it of wallItems) {
      const p = it.geo.parameters;
      if (p) it.us = [Math.max(p.width, p.depth) / 3.2, p.height / 3.0];
    }
    const wm = add(scene, new THREE.Mesh(merge(wallItems), wallMat));
    const rm = add(scene, new THREE.Mesh(merge(roofItems), roofMat));
    wm.frustumCulled = rm.frustumCulled = true;
    for (const g of boxCache.values()) g.dispose();
    roofGeo.dispose();

    /* ---- Fort George: stone bastion on the headland bluff --------------- */
    const fx = -436, fz = -142, fy = I.heightAt(fx, fz);
    const st = [], sc = lin(0x9a8f7d), sc2 = lin(0x877c68);
    st.push({ geo: new THREE.CylinderGeometry(30, 35.5, 11, 8, 1, true), m: TRS(fx, fy + 4.0, fz, PI / 8), c: sc, us: [22, 4] });
    st.push({ geo: new THREE.CylinderGeometry(30.6, 30.6, 1.5, 8), m: TRS(fx, fy + 10.2, fz, PI / 8), c: sc2, us: [22, 1] });
    for (let i = 0; i < 40; i++) {
      const a = i / 40 * 6.283 + 0.08;
      st.push({
        geo: new THREE.BoxGeometry(2.6, 2.2, 1.5),
        m: TRS(fx + Math.cos(a) * 30.0, fy + 12.0, fz + Math.sin(a) * 30.0, -a + PI / 2), c: i % 2 ? sc : sc2, us: [1.6, 1.4]
      });
    }
    // inner keep + magazine
    st.push({ geo: new THREE.BoxGeometry(17, 7.5, 12), m: TRS(fx + 2, fy + 8.0, fz - 3, 0.22), c: sc, us: [5, 2.5] });
    st.push({ geo: new THREE.BoxGeometry(9, 4.6, 7), m: TRS(fx - 13, fy + 6.6, fz + 9, -0.4), c: sc2, us: [3, 1.6] });
    // cannon on the seaward embrasures
    for (let i = 0; i < 5; i++) {
      const a = PI * (0.62 + i * 0.11);
      const cxp = fx + Math.cos(a) * 26, czp = fz + Math.sin(a) * 26;
      st.push({ geo: new THREE.CylinderGeometry(0.17, 0.23, 2.6, 8), m: TRS(cxp, fy + 11.6, czp, -a + PI / 2, 1, 1, 1, PI / 2 - 0.12), c: lin(0x33302c) });
      st.push({ geo: new THREE.BoxGeometry(1.3, 0.5, 2.0), m: TRS(cxp, fy + 11.0, czp, -a + PI / 2), c: lin(0x5b4630) });
    }
    // flagstaff
    st.push({ geo: new THREE.CylinderGeometry(0.11, 0.14, 15, 6), m: TRS(fx + 2, fy + 19, fz - 3, 0), c: lin(0xdad6cc) });
    st.push({ geo: new THREE.PlaneGeometry(2.6, 1.6), m: TRS(fx + 3.4, fy + 25.2, fz - 3, 0), c: lin(0xc8332a) });
    const fortMat = solidMat(TEX.stone, 0, { rough: 0.86, f0: 0.03, detS: 1.1, detA: 0.6, side: THREE.DoubleSide });
    add(scene, new THREE.Mesh(merge(st), fortMat));

    /* ---- unambiguous scale references -----------------------------------
       Nothing on a bare hillside tells you whether it is 60 m or 600 m high.
       A lattice mast of known height on the ridge, and a stone jetty at the
       waterline, calibrate the whole massif at a cost of a few hundred verts. */
    const mx = 238, mz = -722, my = I.heightAt(mx, mz);
    const mc = lin(0xb9bcbe), mr = lin(0xc4402f);
    for (let s = 0; s < 4; s++) {
      const a = s / 4 * 6.283 + 0.78, r0 = 1.9, r1 = 0.55;
      METAL.push({
        geo: new THREE.CylinderGeometry(0.13, 0.19, 56, 5),
        m: TRS(mx + Math.cos(a) * (r0 + r1) * 0.5, my + 28, mz + Math.sin(a) * (r0 + r1) * 0.5, 0, 1, 1, 1, 0.020 * Math.sin(a), -0.020 * Math.cos(a)), c: mc
      });
    }
    for (let k = 0; k < 11; k++) {
      METAL.push({
        geo: new THREE.TorusGeometry(1.55 - k * 0.10, 0.055, 4, 8),
        m: TRS(mx, my + 2 + k * 5.2, mz, 0, 1, 1, 1, PI / 2), c: mc
      });
    }
    METAL.push({ geo: new THREE.CylinderGeometry(0.06, 0.06, 7, 5), m: TRS(mx, my + 59, mz, 0), c: mc });
    LAMP.push({ geo: new THREE.SphereGeometry(0.5, 7, 5), m: TRS(mx, my + 62.5, mz, 0), c: mr });
    for (let k = 0; k < 3; k++) {
      const a = k / 3 * 6.283;
      METAL.push({
        geo: new THREE.BoxGeometry(0.9, 2.6, 0.14),
        m: TRS(mx + Math.cos(a) * 1.7, my + 46, mz + Math.sin(a) * 1.7, -a), c: mc
      });
    }
    // stone jetty and slipway on the beach below the town
    const jz = 132, jx = coastX(jz) + 6;
    for (let i = 0; i < 9; i++) {
      STONE.push({
        geo: bx(7.5, 2.4, 7), m: TRS(jx - i * 6.8, 0.55 - i * 0.03, jz + i * 1.4, 0.20),
        c: lin(i % 2 ? 0xa9a08d : 0x9d947f), us: [2.4, 0.9]
      });
    }
    for (let i = 0; i < 5; i++) {
      METAL.push({ geo: bx(0.34, 1.1, 0.34), m: TRS(jx - 4 - i * 12, 2.2, jz + 1 + i * 2.4, 0), c: lin(0x2c3238) });
    }
  }

  /* ------------------------------------------------ land reflection ribbon */
  /* The sea reflects the sky from the ocean module's own LUT, but nothing of
     the land — a shoreline with sky under it and no dark island in the water
     reads as a rendering bug. This ribbon hugs the coast, sits just above the
     mean surface so it survives the depth test against the wave crests, and
     lays a broken dark reflection into the water at grazing view angles.     */
  function buildShoreReflection(scene) {
    const pos = [], att = [], idx = [];
    let row = 0, prev = -1, cols = 0;
    for (let z = -6400; z <= 6400; z += 22) {
      const cx = coastX(z);
      if (islandEnv(cx + 40, z) > -80) { prev = -1; continue; }
      let hmax = 0;
      for (let s = 20; s < 900; s += 45) {
        const h = I.heightAt(cx + s, z);
        if (h > hmax) hmax = h;
      }
      if (hmax < 6) { prev = -1; continue; }
      // never let the outermost column fall inside the fixed surf columns, or the
      // last quad folds back on itself and the band creases along the whole coast
      const L = Math.max(clamp(hmax * 3.8, 190, 900), 330);
      /* Dense columns through the surf zone. The old 4-column spacing put the
         entire break between o=16 and o=96, so the foam had no shape across
         the band and the shoreline still read as one ruled line.            */
      const OFF = [-13, -4, 5, 15, 30, 54, 92, 155, 250, L];
      cols = OFF.length;
      const base = row;
      for (let k = 0; k < cols; k++) {
        const o = OFF[k];
        /* The band MUST stand above still water or the ocean surface — which is
           opaque and writes depth — buries it, and the coast reverts to a hard
           seam with no surf at all. That is also physically right: a breaking
           bore and its foam stand up to a metre proud of the mean surface. On
           the landward columns it lies down on the sand instead.            */
        let y;
        if (o <= 0) y = Math.max(I.heightAt(cx - o, z) + 0.06, 0.34);
        else y = 0.58 + 0.80 * sstep(0, 140, o) + 0.34 * sstep(140, 420, o);
        pos.push(cx - o, y, z);
        att.push((o + 13) / (L + 13), hmax, o);
      }
      if (prev >= 0) for (let k = 0; k < cols - 1; k++) {
        const a = prev + k, b = base + k;
        idx.push(a, a + 1, b, a + 1, b + 1, b);
      }
      prev = base; row += cols;
    }
    if (row < 2 * cols) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aR', new THREE.Float32BufferAttribute(att, 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    const vs = [
      'precision highp float;',
      'attribute vec3 aR; varying vec3 vR; varying vec3 vW; varying float vD;',
      'void main(){',
      '  vec4 wp = modelMatrix*vec4(position,1.0);',
      '  vW = wp.xyz; vR = aR; vD = length(wp.xyz-cameraPosition);',
      '  gl_Position = projectionMatrix*viewMatrix*wp;',
      '}'
    ].join('\n');
    const fs = [
      'precision highp float;', G_COMMON, G_LIGHT,
      'varying vec3 vR; varying vec3 vW; varying float vD;',
      'void main(){',
      '  vec3 V = normalize(cameraPosition-vW);',
      '  float graz = 1.0 - smoothstep(0.010, 0.20, V.y);',
      '  float n1 = fbm2(vW.xz*0.075 + vec2(uTime*0.16, uTime*0.07));',
      '  float n2 = fbm2(vW.xz*0.010 + vec2(uTime*0.03, 0.0));',
      '  float a = pow(1.0-vR.x, 1.35)*clamp(vR.y/40.0,0.0,1.0)*graz;',
      /* Hold the dark land reflection OFF the waterline. A reflection needs open
         water in front of it; painting it right up to the sand laid an almost
         black stripe along the entire coast, which is precisely the hard seam
         that was reading as clipped geometry. Inside the surf zone the water is
         white and turquoise, and that is what has to show there.             */
      '  a *= smoothstep(6.0, 78.0, vR.z);',
      '  a *= (0.50+0.80*n2)*(0.34+0.92*n1);',
      '  a = clamp(a, 0.0, 0.80);',
      '  vec3 c = mix(vec3(0.016,0.036,0.024), vec3(0.078,0.112,0.068), n2)*uSkyE*1.15;',
      '  c += uSunCol*uSunE*0.0035*max(uSunDir.y,0.0);',
      // a reflection travels the eye->surface path only, not eye->land->surface,
      // so it carries roughly half the in-scatter of the headland above it —
      // which is exactly what keeps the band readably darker than hazy water
      '  c = fogApply(c, vD*0.55, -V, 0.0);',
      /* Shore break, on the SAME ribbon. Depth is reconstructed analytically
         from the offshore distance (it mirrors the CPU beach profile exactly),
         so the surf tracks every bay and point without another height lookup.
         It has to live above the water, not on the seabed: the ocean surface
         is opaque enough at 1 m that foam painted on the bottom never shows. */
      /* Beach cusps. Displacing the offshore coordinate by an ALONGSHORE noise
         before any of the surf maths runs is what makes the whole band scallop
         in and out; without it every term is a pure function of distance from
         the coast line and the swash edge comes out as a ruled stripe parallel
         to it, which is the single loudest "clipped geometry" tell there is. */
      '  float cusp = (fbm2(vec2(vW.z*0.0165, 3.1))-0.5)*44.0',
      '             + (fbm2(vec2(vW.z*0.052, 8.4))-0.5)*15.0;',
      '  float o = vR.z + cusp;',
      '  float shoal = smoothstep(170.0, 2.0, o);',
      /* The turquoise shelf. Sand under two metres of clear water is one of the
         brightest things in a Caribbean coastal frame; the ocean shader knows
         the depth but at 1 km its shallow term is buried under the haze that is
         applied on top of it, so the shelf is re-asserted here at the one place
         it matters — the contact between the two subsystems.                 */
      '  float shal = smoothstep(78.0, 2.0, o)*(0.55+0.45*n1)*smoothstep(-10.0,4.0,vR.z);',
      '  vec3 sc = (uSunCol*uSunE*max(uSunDir.y,0.0)*0.13 + uSkyCol*uSkyE*0.60)*vec3(0.34,0.92,0.78);',
      '  sc = fogApply(sc, vD, -V, 0.0);',
      '  c = mix(c, sc, clamp(shal,0.0,1.0)*0.80);',
      '  a = max(a, clamp(shal,0.0,1.0)*0.55);',
      '  float sw = fbm2(vW.xz*0.013+vec2(3.0,7.0));',
      '  float b1 = sin((o*0.026 - uTime*0.55 + sw*5.0)*3.14159);',   // ~38 m sets
      '  float b2 = sin((o*0.043 - uTime*0.92 + fbm2(vW.xz*0.028)*6.0)*3.14159);',
      '  float foam = (smoothstep(0.42,0.95,b1)*1.00 + smoothstep(0.60,1.0,b2)*0.62)*shoal*shoal;',
      // the breaking crest itself: a hard bright lip on the seaward face of b1
      '  foam += smoothstep(0.88,0.995,b1)*0.95*shoal;',
      '  foam += smoothstep(34.0,-6.0,o)*1.15;',                     // the swash mat
      '  foam *= 0.44+0.80*fbm2(vW.xz*0.30+vec2(uTime*0.7,uTime*0.3));',
      '  foam *= 0.60+0.62*fbm2(vW.xz*0.085+vec2(uTime*0.22,0.0));',
      '  foam = clamp(foam*2.3,0.0,1.0)*smoothstep(-16.0,-2.0,vR.z);',
      // foam is white water: it scatters the FULL sky hemisphere plus direct sun
      '  vec3 fc = (uSunCol*uSunE*max(uSunDir.y,0.0)*0.60 + uSkyCol*uSkyE*1.10)*vec3(0.84,0.88,0.92);',
      '  fc = fogApply(fc, vD, -V, 0.0);',
      '  c = mix(c, fc, foam);',
      '  a = max(a, foam*0.97);',
      '  if (a < 0.004) discard;',
      '  float lm=dot(c,vec3(0.3333)); if(!(lm<1e5)) c=vec3(0.0);',
      '  gl_FragColor = vec4(min(c,vec3(12000.0)), a);',
      '}'
    ].join('\n');
    const mat = mkMat(vs, fs, {}, {
      transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide
    });
    const m = add(scene, new THREE.Mesh(g, mat));
    m.renderOrder = 6;                    // after the ocean surface (renderOrder 5)
    m.frustumCulled = false;
  }

  /* --------------------------------------------------------- the marina   */
  const WOOD = [], STONE = [], METAL = [], LAMP = [];
  const boxC = new Map();
  function bx(w, h, d) {
    const k = w.toFixed(3) + '_' + h.toFixed(3) + '_' + d.toFixed(3);
    if (!boxC.has(k)) boxC.set(k, new THREE.BoxGeometry(w, h, d));
    return boxC.get(k);
  }
  function plankShade(i) {
    const s = Math.sin(i * 12.9898) * 43758.5453;
    const f = s - Math.floor(s);                       // deterministic per-plank fract
    const v = 0.74 + 0.34 * f;
    return [v, v * 0.975, v * 0.93];
  }
  function pontoon(x, z, w, l, rot) {
    const across = l >= w;
    const span = across ? l : w;
    const pitch = 0.34, nP = Math.max(1, Math.floor(span / pitch));
    const c = Math.cos(rot), s = Math.sin(rot);
    const put = (lx, ly, lz, geo, col) => {
      WOOD.push({ geo, m: TRS(x + lx * c + lz * s, ly, z - lx * s + lz * c, rot), c: col });
    };
    for (let i = 0; i < nP; i++) {
      const t = -span / 2 + pitch * (i + 0.5);
      const g = across ? bx(w - 0.10, 0.105, pitch * 0.84) : bx(pitch * 0.84, 0.105, l - 0.10);
      put(across ? 0 : t, 0.575, across ? t : 0, g, plankShade(i + x * 3 + z));
    }
    // float / substructure and rubbing strake
    WOOD.push({ geo: bx(w, 0.46, l), m: TRS(x, 0.30, z, rot), c: lin(0x59646a) });
    WOOD.push({ geo: bx(w + 0.14, 0.16, l + 0.14), m: TRS(x, 0.50, z, rot), c: lin(0x2f3b40) });
    const pt = (lx, lz) => [x + lx * c + lz * s, z - lx * s + lz * c];
    const p1 = pt(-w / 2, -l / 2), p2 = pt(w / 2, -l / 2), p3 = pt(w / 2, l / 2), p4 = pt(-w / 2, l / 2);
    addSeg(p1[0], p1[1], p2[0], p2[1]); addSeg(p2[0], p2[1], p3[0], p3[1]);
    addSeg(p3[0], p3[1], p4[0], p4[1]); addSeg(p4[0], p4[1], p1[0], p1[1]);
  }
  const pileCol = y => {
    if (y < -0.30) return [0.020, 0.030, 0.020];                 // submerged growth
    if (y < 0.30) return [0.045, 0.060, 0.032];                  // weed / tide band
    if (y < 0.85) return [0.28, 0.26, 0.20];                     // bleached splash zone
    const t = clamp((y - 0.85) / 4.0, 0, 1);
    return [lerp(0.30, 0.20, t), lerp(0.25, 0.165, t), lerp(0.175, 0.115, t)];
  };
  function piling(x, z, h) {
    WOOD.push({ geo: new THREE.CylinderGeometry(0.19, 0.24, h, 9), m: TRS(x, h / 2 - 1.7, z, 0), cy: pileCol, us: [2, 3] });
    WOOD.push({ geo: new THREE.CylinderGeometry(0.235, 0.235, 0.10, 9), m: TRS(x, h - 1.78, z, 0), c: lin(0x30363a) });
    I.segments.push({ ax: x, az: z, bx: x, bz: z, kind: 'pile' });
  }
  function cleat(x, z, rot) {
    const c = lin(0x9aa3a8);
    METAL.push({ geo: new THREE.CylinderGeometry(0.05, 0.05, 0.46, 7), m: TRS(x, 0.80, z, rot, 1, 1, 1, 0, PI / 2), c });
    for (const s of [-0.14, 0.14]) {
      const dx = Math.cos(rot) * s, dz = -Math.sin(rot) * s;
      METAL.push({ geo: new THREE.CylinderGeometry(0.045, 0.058, 0.24, 7), m: TRS(x + dx, 0.70, z + dz, 0), c });
    }
  }
  function pedestal(x, z) {
    METAL.push({ geo: bx(0.32, 1.05, 0.36), m: TRS(x, 1.15, z, 0), c: lin(0x2b3238) });
    METAL.push({ geo: bx(0.36, 0.10, 0.40), m: TRS(x, 1.70, z, 0), c: lin(0x1b2126) });
    LAMP.push({ geo: new THREE.SphereGeometry(0.085, 8, 6), m: TRS(x, 1.62, z, 0), c: lin(0xffd27a) });
    I.dockLights.push({ x, z });
  }
  I.dockLights = [];
  function buildMarina(scene) {
    const M = MARINA;
    pontoon(M.pierX, (M.z0 + M.z1) / 2, 3.6, M.z1 - M.z0, 0);
    for (let z = M.z0 + 6; z < M.z1; z += 24) piling(M.pierX + 2.35, z, 5.4);
    pontoon(M.pierX + 26, M.z0 + 8, 50, 2.2, 0);
    for (let i = 0; i <= M.nSlips; i++) {
      const z = M.z0 + 10 + i * M.slipPitch;
      if (z > M.z1 - 8) break;
      pontoon(M.pierX - 1.8 - M.fingerLen / 2, z, M.fingerLen, 1.15, 0);
      piling(M.pierX - 1.8 - M.fingerLen, z, 5.0);
      cleat(M.pierX - 6, z + 0.75, 0);
      cleat(M.pierX - 15, z + 0.75, 0);
      if (i % 2 === 0) pedestal(M.pierX - 2.6, z + 3);
      if (z + M.slipPitch <= M.z1 - 8) {
        I.berths.push({
          id: 'slip' + i, x: M.pierX - 1.8 - M.fingerLen / 2, z: z + M.slipPitch / 2,
          hdg: 90, width: M.slipPitch, kind: 'slip', bowIn: true,
          entryX: M.pierX - 1.8 - M.fingerLen - 30, entryZ: z + M.slipPitch / 2
        });
      }
    }
    // fuel dock T-head
    const fx = M.pierX - 15, fz = M.z1 + 14;
    pontoon(fx, fz, 34, 4.2, 0);
    for (let i = 0; i < 4; i++) piling(fx - 14 + i * 10, fz + 2.6, 5.2);
    for (let i = 0; i < 6; i++) cleat(fx - 15 + i * 6.4, fz - 2.4, 0);
    for (const dxo of [-8, 8]) {
      METAL.push({ geo: bx(0.5, 1.5, 0.5), m: TRS(fx + dxo, 1.35, fz + 1.4, 0), c: lin(0xd8dde0) });
      METAL.push({ geo: new THREE.CylinderGeometry(0.04, 0.04, 1.1, 6), m: TRS(fx + dxo + 0.3, 1.6, fz + 1.0, 0, 1, 1, 1, 0.4), c: lin(0x22282c) });
    }
    I.berths.push({
      id: 'fuel', x: fx, z: fz - 6.6, hdg: 270, width: 34, kind: 'alongside',
      side: 'stbd', entryX: fx - 120, entryZ: fz - 6.6
    });

    // ---- Med-moor quay on the northern shoreline arc (the Carenage) -------
    const arcPt = (th, k) => [LAG.rx * k * Math.cos(th), LAG.rz * k * Math.sin(th)];
    const th0 = -125 * PI / 180, th1 = -58 * PI / 180, NQ = 10;
    const quayPts = [];
    for (let i = 0; i <= NQ; i++) quayPts.push(arcPt(th0 + (th1 - th0) * i / NQ, 0.995));
    for (let i = 0; i < NQ; i++) {
      const a = quayPts[i], b = quayPts[i + 1];
      const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const ang = Math.atan2(b[0] - a[0], b[1] - a[1]);
      let nx = -mx / (LAG.rx * LAG.rx), nz = -mz / (LAG.rz * LAG.rz);
      const nl = Math.hypot(nx, nz); nx /= nl; nz /= nl;
      STONE.push({ geo: bx(9, 3.0, L + 1), m: TRS(mx - nx * 4.5, 0.55, mz - nz * 4.5, ang), c: lin(0xb2a894), us: [3, 1.2] });
      STONE.push({ geo: bx(9.3, 0.34, L + 1.1), m: TRS(mx - nx * 4.5, 2.10, mz - nz * 4.5, ang), c: lin(0x9e9482), us: [3, 0.3] });
      addSeg(a[0], a[1], b[0], b[1], 'quay');
    }
    for (let i = 0; i < 6; i++) {
      const th = th0 + (th1 - th0) * (0.09 + i * 0.166);
      const p = arcPt(th, 0.995);
      let nx = -p[0] / (LAG.rx * LAG.rx), nz = -p[1] / (LAG.rz * LAG.rz);
      const nl = Math.hypot(nx, nz); nx /= nl; nz /= nl;
      cleat(p[0] - nx * 1.6, p[1] - nz * 1.6, 0);
      METAL.push({
        geo: new THREE.CylinderGeometry(0.42, 0.42, 1.15, 12),
        m: TRS(p[0] + nx * 0.3, 0.55, p[1] + nz * 0.3, 0, 1, 1, 1, PI / 2), c: lin(0x1c1c1e)
      });
      const hdg = (Math.atan2(nx, -nz) * 180 / PI + 360) % 360;
      I.berths.push({
        id: 'med' + i, x: p[0] + nx * 11.0, z: p[1] + nz * 11.0, hdg, width: 19, kind: 'med',
        ballX: p[0] + nx * 44, ballZ: p[1] + nz * 44,
        entryX: p[0] + nx * 105, entryZ: p[1] + nz * 105
      });
      addBuoy(p[0] + nx * 44, p[1] + nz * 44, 'mooring');
    }
    // marina shore buildings
    const mb = [[284, -78, 18, 12, 6.0, 0xf2e3c8], [292, -34, 13, 10, 4.6, 0xe7d8b8],
    [298, 26, 22, 13, 6.8, 0xf6ecd6], [288, 80, 15, 11, 5.2, 0xefe0c4]];
    for (const b of mb) {
      const y = I.heightAt(b[0], b[1]);
      if (y < 0.5) continue;
      STONE.push({ geo: bx(b[2], b[4], b[3]), m: TRS(b[0], y + b[4] / 2, b[1], 0), c: lin(b[5]), us: [b[2] / 3.2, b[4] / 3.0] });
      STONE.push({
        geo: new THREE.ConeGeometry(Math.hypot(b[2], b[3]) * 0.58, 1.9, 4),
        m: TRS(b[0], y + b[4] + 0.95, b[1], PI / 4), c: lin(0xa8412c), us: [12, 2]
      });
    }
  }

  /* --------------------------------------------------------- buoyage      */
  const BUOYS = [];
  function addBuoy(x, z, kind) {
    if (BUOYS.length >= 40) return;
    const idx = BUOYS.length;
    const e = [x, z, 1, idx];        // .z = float flag, .w = uBuoy slot
    if (kind === 'mooring') {
      METAL.push({ geo: new THREE.SphereGeometry(0.44, 12, 9), m: TRS(x, 0.32, z, 0), c: lin(0xf2f2f0), e });
      METAL.push({ geo: new THREE.CylinderGeometry(0.045, 0.045, 1.3, 6), m: TRS(x, 1.05, z, 0), c: lin(0xdcdcdc), e });
    } else if (kind === 'red') {
      METAL.push({ geo: new THREE.CylinderGeometry(0.56, 0.64, 1.8, 12), m: TRS(x, 0.55, z, 0), c: lin(0xcc2222), e });
      METAL.push({ geo: new THREE.CylinderGeometry(0.10, 0.10, 0.9, 6), m: TRS(x, 1.75, z, 0), c: lin(0x8c1616), e });
      LAMP.push({ geo: new THREE.SphereGeometry(0.11, 8, 6), m: TRS(x, 2.25, z, 0), c: lin(0xff4b3a), e });
    } else {
      METAL.push({ geo: new THREE.ConeGeometry(0.64, 2.1, 12), m: TRS(x, 0.75, z, 0), c: lin(0x1f9d4a), e });
      METAL.push({ geo: new THREE.CylinderGeometry(0.09, 0.09, 0.8, 6), m: TRS(x, 2.0, z, 0), c: lin(0x14743a), e });
      LAMP.push({ geo: new THREE.SphereGeometry(0.11, 8, 6), m: TRS(x, 2.45, z, 0), c: lin(0x36ff7a), e });
    }
    BUOYS.push({ x, z, kind, idx, ph: BUOYS.length * 1.37 });
    I.buoys.push({ x, z, kind });
  }
  function buildChannel() {
    const dx = CH.bx - CH.ax, dz = CH.bz - CH.az;
    const L = Math.hypot(dx, dz), ux = dx / L, uz = dz / L;
    const px = -uz, pz = ux;
    for (let i = 0; i <= 6; i++) {
      const t = 0.06 + i * 0.15;
      const cx = CH.ax + dx * t, cz = CH.az + dz * t;
      addBuoy(cx + px * 34, cz + pz * 34, 'green');
      addBuoy(cx - px * 34, cz - pz * 34, 'red');
    }
    I.moorBalls = [];
    for (let i = 0; i < 10; i++) {
      const a = i * 0.628, r = 34 + (i % 3) * 26;
      const bxp = -108 + Math.cos(a) * r, bzp = 96 + Math.sin(a) * r * 0.7;
      addBuoy(bxp, bzp, 'mooring');
      I.moorBalls.push({ x: bxp, z: bzp });
    }
    I.berths.push({
      id: 'ball', x: I.moorBalls[4].x, z: I.moorBalls[4].z, hdg: 70,
      width: 12, kind: 'ball', entryX: I.moorBalls[4].x + 90, entryZ: I.moorBalls[4].z + 30
    });
  }

  /* --------------------------------------------------------- moored fleet */
  const FLEET = [];
  function hullShape(len, beam) {
    const s = new THREE.Shape();
    s.moveTo(0, -len * 0.5);
    s.bezierCurveTo(beam * 0.30, -len * 0.36, beam * 0.50, -len * 0.02, beam * 0.48, len * 0.22);
    s.bezierCurveTo(beam * 0.47, len * 0.40, beam * 0.44, len * 0.48, beam * 0.40, len * 0.5);
    s.lineTo(-beam * 0.40, len * 0.5);
    s.bezierCurveTo(-beam * 0.44, len * 0.48, -beam * 0.47, len * 0.40, -beam * 0.48, len * 0.22);
    s.bezierCurveTo(-beam * 0.50, -len * 0.02, -beam * 0.30, -len * 0.36, 0, -len * 0.5);
    return s;
  }
  // Extrudes along +Z; rotateX(+90°) sends the shape's y to world z (bow at -Z, per
  // the project convention) and the extrusion straight DOWN, so the hull occupies
  // y in [-depth, 0] and the caller positions its sheerline.
  function hullGeo(len, beam, depth) {
    const g = new THREE.ExtrudeGeometry(hullShape(len, beam), {
      depth: depth, bevelEnabled: true, bevelSize: Math.min(0.30, beam * 0.13),
      bevelThickness: 0.34, bevelSegments: 3, curveSegments: 9
    });
    g.rotateX(PI / 2);
    return g;
  }
  function addBoat(x, z, hdg, len, type, colHull, seed) {
    const items = [];
    const rad = -hdg * PI / 180;
    const white = lin(colHull), deck = lin(0xe2ddd0), grey = lin(0xc6cbcd), dark = lin(0x1e2a33), teak = lin(0x8a6237);
    const phase = (seed % 6.283);
    let halfBeam;
    let deckY;
    if (type === 'cat') {
      const bw = len * 0.52, hd = len * 0.11;
      halfBeam = bw / 2 + hd / 2; deckY = 1.35;
      for (const s of [-1, 1]) {
        items.push({ geo: hullGeo(len, hd, 2.0), m: TRS(s * bw / 2, 1.35, 0, 0), c: white });
        items.push({ geo: hullGeo(len * 0.985, hd * 0.94, 0.14), m: TRS(s * bw / 2, 0.05, 0, 0), c: dark }); // boot top
      }
      items.push({ geo: bx(bw, 0.45, len * 0.56), m: TRS(0, 1.30, len * 0.02, 0), c: deck });
      items.push({ geo: bx(bw * 0.80, 1.60, len * 0.32), m: TRS(0, 2.32, len * 0.04, 0), c: deck });
      items.push({ geo: bx(bw * 0.84, 0.10, len * 0.36), m: TRS(0, 3.16, len * 0.03, 0), c: white });
      items.push({ geo: bx(bw * 0.66, 0.05, len * 0.22), m: TRS(0, 1.36, -len * 0.30, 0), c: grey });     // trampoline
      items.push({ geo: new THREE.CylinderGeometry(0.10, 0.15, len * 1.30, 7), m: TRS(0, len * 0.65 + 3.2, len * 0.05, 0), c: grey });
      items.push({ geo: new THREE.CylinderGeometry(0.12, 0.12, len * 0.40, 6), m: TRS(0, 4.6, len * 0.17, 0, 1, 1, 1, PI / 2), c: grey });
    } else if (type === 'motor') {
      const bw = len * 0.31;
      halfBeam = bw / 2; deckY = 1.20;
      items.push({ geo: hullGeo(len, bw, 2.45), m: TRS(0, 1.20, 0, 0), c: white });
      items.push({ geo: hullGeo(len * 0.99, bw * 0.985, 0.15), m: TRS(0, 0.02, 0, 0), c: dark });
      items.push({ geo: bx(bw * 0.86, 1.60, len * 0.46), m: TRS(0, 1.98, len * 0.05, 0), c: white });
      items.push({ geo: bx(bw * 0.70, 1.30, len * 0.26), m: TRS(0, 3.40, len * 0.01, 0), c: white });
      items.push({ geo: bx(bw * 0.66, 0.10, len * 0.30), m: TRS(0, 4.10, len * 0.04, 0), c: grey });
      for (const s of [-1, 1])
        items.push({ geo: new THREE.CylinderGeometry(0.05, 0.05, 1.6, 6), m: TRS(s * bw * 0.28, 4.9, len * 0.12, 0, 1, 1, 1, s * 0.22), c: grey });
      items.push({ geo: new THREE.TorusGeometry(0.55, 0.06, 5, 14), m: TRS(0, 5.1, len * 0.12, 0, 1, 1, 1, PI / 2), c: grey });
    } else {
      const bw = len * 0.30;
      halfBeam = bw / 2; deckY = 0.98;
      items.push({ geo: hullGeo(len, bw, 2.30), m: TRS(0, 0.98, 0, 0), c: white });
      items.push({ geo: hullGeo(len * 0.99, bw * 0.985, 0.15), m: TRS(0, -0.02, 0, 0), c: dark });
      items.push({ geo: bx(bw * 0.94, 0.10, len * 0.88), m: TRS(0, 1.00, 0, 0), c: teak });
      items.push({ geo: bx(bw * 0.68, 1.05, len * 0.32), m: TRS(0, 1.56, len * 0.02, 0), c: white });
      items.push({ geo: bx(bw * 0.58, 0.10, len * 0.30), m: TRS(0, 2.12, len * 0.02, 0), c: grey });
      items.push({ geo: new THREE.CylinderGeometry(0.085, 0.13, len * 1.24, 7), m: TRS(0, len * 0.62 + 1.0, -len * 0.02, 0), c: grey });
      items.push({ geo: new THREE.CylinderGeometry(0.11, 0.11, len * 0.42, 6), m: TRS(0, 2.62, len * 0.14, 0, 1, 1, 1, PI / 2), c: grey });
      items.push({ geo: bx(0.42, 0.85, len * 0.40), m: TRS(0, 3.05, len * 0.14, 0), c: lin(0xdfe3e0) });  // main flaked on the boom
    }
    // stanchions + lifelines
    const nS = 6;
    for (let i = 0; i < nS; i++) {
      const t = -0.42 + i * (0.84 / (nS - 1));
      for (const s of [-1, 1])
        items.push({ geo: new THREE.CylinderGeometry(0.026, 0.026, 0.62, 5), m: TRS(s * halfBeam * 0.92, deckY + 0.31, t * len, 0), c: grey });
    }
    for (const s of [-1, 1])
      items.push({ geo: bx(0.02, 0.02, len * 0.86), m: TRS(s * halfBeam * 0.92, deckY + 0.60, len * 0.02, 0), c: grey });

    const wm = TRS(x, 0, z, rad);
    for (const it of items) {
      it.m = wm.clone().multiply(it.m);
      it.e = [x, z, phase, type === 'cat' ? 0.55 : 0.85];
    }
    FLEET.push.apply(FLEET, items);
    // collision box (matches world_reference's rectangle)
    const c = Math.cos(rad), s = Math.sin(rad);
    const P = (lx, lz) => [x + lx * c + lz * s, z - lx * s + lz * c];
    const hw = halfBeam;
    const a = P(-hw, -len / 2), b = P(hw, -len / 2), cc = P(hw, len / 2), d = P(-hw, len / 2);
    addSeg(a[0], a[1], b[0], b[1], 'boat'); addSeg(b[0], b[1], cc[0], cc[1], 'boat');
    addSeg(cc[0], cc[1], d[0], d[1], 'boat'); addSeg(d[0], d[1], a[0], a[1], 'boat');
  }
  function buildFleet(scene, reserved) {
    const S = { s: 0x77e1a3 };
    const R = reserved || [];
    const cols = [0xf3f4f2, 0xeef0ee, 0xdfe6e8, 0xf7f5ee, 0xe9eef0, 0x2b3a4a, 0xe8e2d2];
    const M = MARINA;
    const slips = I.berths.filter(b => b.kind === 'slip');
    slips.forEach((b, i) => {
      if (R.indexOf(b.id) >= 0 || rnd(S) < 0.16) return;
      const r = rnd(S);
      const type = r < 0.42 ? 'cat' : (r < 0.82 ? 'mono' : 'motor');
      const len = type === 'cat' ? 11 + rnd(S) * 5 : 12 + rnd(S) * 5;
      addBoat(M.pierX - 4.5 - len / 2, b.z, 90, len, type, cols[i % cols.length], rnd(S) * 6.283);
    });
    I.berths.filter(b => b.kind === 'med').forEach((b, i) => {
      if (R.indexOf(b.id) >= 0 || rnd(S) < 0.42) return;
      const rad = b.hdg * PI / 180;
      const len = 11 + rnd(S) * 4.5;
      const type = rnd(S) < 0.45 ? 'cat' : 'mono';
      addBoat(b.x + Math.sin(rad) * (len / 2 - 7), b.z - Math.cos(rad) * (len / 2 - 7),
        b.hdg, len, type, cols[(i + 2) % cols.length], rnd(S) * 6.283);
    });
    (I.moorBalls || []).forEach((b, i) => {
      if (i === 4 || rnd(S) < 0.45) return;
      addBoat(b.x - 8, b.z - 3, 70 + rnd(S) * 30, 11 + rnd(S) * 4.5,
        rnd(S) < 0.45 ? 'cat' : 'mono', cols[(i + 4) % cols.length], rnd(S) * 6.283);
    });
    if (FLEET.length) {
      const mat = solidMat(null, 1, { rough: 0.24, f0: 0.055, detS: 3.5, detA: 0.16, side: THREE.DoubleSide });
      add(scene, new THREE.Mesh(merge(FLEET), mat));
    }
  }

  /* ------------------------------------------------------------- assembly */
  const TEX = {};
  let _scene = null, nightLightMat = null;
  I.build = function (scene) {
    _scene = scene;
    const hi = SAIL.quality !== 'low';
    I.segments.length = 0; I.berths.length = 0; I.buoys.length = 0;
    I.dockLights.length = 0; BUOYS.length = 0;
    WOOD.length = 0; STONE.length = 0; METAL.length = 0; LAMP.length = 0; FLEET.length = 0;
    MATS.length = 0; vegBuckets.length = 0; ADDED.length = 0;

    TEX.detail = detailTexture();
    TEX.bark = barkTexture();
    TEX.plank = plankTexture();
    TEX.stone = stoneTexture();
    TEX.facade = facadeTexture();
    TEX.tile = tileTexture();
    TEX.frond = frondTexture();
    TEX.canopy = canopyTexture();
    TEX.leaf = leafTexture();
    U.uDet.value = TEX.detail;

    bakeField();
    bakeCover();
    buildTerrain(scene, hi);
    buildMarina(scene);
    buildChannel();
    buildTown(scene, hi);
    buildVegetation(scene, hi);
    buildFleet(scene, (SAIL.opts && SAIL.opts.reserved) || []);
    buildShoreReflection(scene);
    // the contact-shading channel is stamped while placing, so re-upload once
    if (coverTex) coverTex.needsUpdate = true;

    if (WOOD.length) add(scene, new THREE.Mesh(merge(WOOD), solidMat(TEX.plank, 0, { rough: 0.80, f0: 0.035, detS: 3.0, detA: 0.55 })));
    if (STONE.length) add(scene, new THREE.Mesh(merge(STONE), solidMat(TEX.stone, 0, { rough: 0.88, f0: 0.03, detS: 1.2, detA: 0.55, side: THREE.DoubleSide })));
    if (METAL.length) add(scene, new THREE.Mesh(merge(METAL), solidMat(null, 2, { rough: 0.30, f0: 0.07, detS: 4.0, detA: 0.20, side: THREE.DoubleSide })));
    if (LAMP.length) {
      nightLightMat = solidMat(null, 2, { rough: 0.5, f0: 0.02, detS: 4.0, detA: 0.0, emis: 0.0, side: THREE.DoubleSide });
      add(scene, new THREE.Mesh(merge(LAMP), nightLightMat));
    }
    for (const g of boxC.values()) g.dispose();
    boxC.clear();

    I.buildSegIndex();
    I.bounds = { TX0, TX1, TZ0, TZ1 };
    I.LAG = LAG; I.CH = CH; I.MARINA = MARINA;
    I.ready = true;
    I.uniforms = U;                       // sky/post modules may retune haze & irradiance
    if (!SAIL.world) SAIL.world = I;      // the tech spec names SAIL.world; alias if unclaimed
    return I;
  };

  /* --------------------------------------------------------------- update */
  const _sd = new THREE.Vector3(), _cp = new THREE.Vector3();
  function syncEnv(t) {
    const E = SAIL.env || {};
    let sd = (SAIL.sky && SAIL.sky.sunDir) || E.sunDir;
    if (sd && sd.isVector3 && sd.lengthSq() > 1e-6) _sd.copy(sd);
    else {
      // fallback ephemeris: sun rises in the EAST (+X) and sets in the WEST (-X)
      const hr = (E.hourOfDay === undefined ? 13 : E.hourOfDay);
      const a = (hr - 12) / 12 * PI;
      _sd.set(-Math.sin(a) * 0.86, Math.cos(a) * 0.98, -0.30);
    }
    _sd.normalize();
    const el = clamp(_sd.y, -1, 1);
    U.uNight.value = 1.0 - sstep(-0.06, 0.09, el);         // derived BEFORE any moon swap
    // air mass attenuation + warming at low sun; the sky module wins if it supplies sunE
    const am = 1.0 / Math.max(el + 0.055, 0.055);
    const atten = el > 0 ? Math.exp(-0.16 * (am - 1)) : 0;
    let sunE = (E.sunE !== undefined ? E.sunE : 100.0 * atten);
    let skyE = (E.skyE !== undefined ? E.skyE : lerp(0.55, 12.0, sstep(-0.12, 0.28, el)));
    if (E.sunColor && E.sunColor.isColor) U.uSunCol.value.copy(E.sunColor);
    else U.uSunCol.value.setRGB(1.0, lerp(0.63, 0.965, sstep(0.0, 0.34, el)), lerp(0.30, 0.905, sstep(0.02, 0.42, el)));
    // Below the horizon a sun vector lights nothing but the undersides. Swap in a
    // moon so the night preset reads as moonlight rather than a black island.
    if (el < 0.02 && sunE < 1.0) {
      _sd.set(0.42, 0.76, -0.50).normalize();
      sunE = 0.34; skyE = Math.max(skyE, 0.42);
      U.uSunCol.value.setRGB(0.62, 0.72, 1.0);
    }
    U.uSunDir.value.copy(_sd);
    U.uSunE.value = sunE; U.uSkyE.value = skyE;
    const up = clamp(el, 0, 1);
    U.uSkyCol.value.setRGB(lerp(0.30, 0.36, up), lerp(0.36, 0.55, up), lerp(0.62, 0.95, up));
    U.uHazeCol.value.setRGB(lerp(0.68, 0.560, up), lerp(0.58, 0.745, up), lerp(0.58, 1.000, up));
    // the Rayleigh veil goes warm-mauve as the sun drops, blue when it is high
    U.uRayCol.value.setRGB(lerp(0.74, 0.42, up), lerp(0.50, 0.56, up), lerp(0.48, 0.92, up));
    U.uTime.value = t;
    // wind (world-space, m/s) -> sway direction and strength
    const wx = (E.windX !== undefined ? E.windX : 0.7), wz = (E.windZ !== undefined ? E.windZ : 0.7);
    const ws = Math.hypot(wx, wz) || 1;
    const gust = 1 + 0.25 * Math.sin(t * 0.31) + 0.14 * Math.sin(t * 0.77 + 1.3);
    U.uWind.value.set(wx / ws, wz / ws, clamp(0.22 + ws * 0.075, 0.18, 1.5) * gust);
    // swell used by the moored-fleet bob
    const sw = (E.swellM !== undefined ? E.swellM : 0.6);
    U.uSwell.value.set(0.71, -0.71, 2 * PI / 78, clamp(sw * 0.16, 0.02, 0.30));
    /* Aerial perspective density. Meteorological visibility is a HORIZONTAL
       near-surface figure and using it directly as an extinction coefficient
       (the old 1/(V*900)) left a 3 km island at 3% haze — i.e. none, which is
       what made the land read as flat as the boat. The Mie term here is the
       marine boundary layer, which is dense and shallow whatever the reported
       range; visibility only shifts it within a plausible band.              */
    const vis = clamp(E.visibilityKm === undefined ? 30 : E.visibilityKm, 4, 60);
    /* Marine-layer Mie extinction, tuned against the actual geometry rather
       than a visibility figure: the near hill's waterline (1.3 km) lands near
       40% blended to sky, its crest near 20%, and the far headlands at 4 km
       near 80%. That spread is what separates the ridgelines into readable
       overlapping planes. The old constant was not far off — what killed the
       aerial perspective was the DARK, NEUTRAL inscatter colour and the total
       absence of chroma loss, both fixed in fogApply.                        */
    U.uHaze.value = 1.0 / (1250 + vis * 33);
    U.uHazeR.value = 1.0 / (7000 + vis * 190);
    U.uCloudAmt.value = clamp(E.cloudCover === undefined ? 0.42 : E.cloudCover, 0, 1);
    if (nightLightMat) nightLightMat.uniforms.uEmis.value = U.uNight.value * 160.0;
  }
  I.update = function (t, dt) {
    if (!I.ready) return;
    syncEnv(t || 0);
    const cam = SAIL.camera;
    if (cam && cam.position) {
      _cp.copy(cam.position);
      if (terrainMesh) { terrainMesh.position.set(_cp.x, 0, _cp.z); terrainMesh.updateMatrixWorld(); }
      for (let i = 0; i < vegBuckets.length; i++) {
        const m = vegBuckets[i];
        const d = Math.hypot(_cp.x - m.userData.cx, _cp.z - m.userData.cz) - m.userData.rad;
        m.visible = d < m.userData.lod;
      }
    }
    // buoy motion from the live wave field
    const O = SAIL.ocean;
    for (let i = 0; i < BUOYS.length; i++) {
      const b = BUOYS[i], u = BUOY_U[b.idx];
      let y = 0, sx = 0, sz = 0;
      if (O && O.sample) {
        const s = O.sample(b.x, b.z);
        if (s) { y = s.y || 0; if (s.slope) { sx = s.slope.sx || 0; sz = s.slope.sz || 0; } else if (s.n) { sx = -s.n.x; sz = -s.n.z; } }
      } else if (O && O.heightAt) {
        y = O.heightAt(b.x, b.z, t) || 0;
      }
      const damp = b.kind === 'mooring' ? 0.9 : 0.75;
      u.set(y * damp, clamp(sx * 0.9, -0.5, 0.5), clamp(sz * 0.9, -0.5, 0.5), 0);
    }
  };

  I.rebuild = function () {
    if (!_scene) return I;
    dispose();
    return I.build(_scene);
  };
  function dispose() {
    if (!_scene) return;
    for (const o of ADDED) { _scene.remove(o); if (o.geometry) o.geometry.dispose(); }
    ADDED.length = 0;
    for (const m of vegBuckets) { _scene.remove(m); m.geometry.dispose(); }
    vegBuckets.length = 0;
    if (terrainMesh) { _scene.remove(terrainMesh); terrainMesh.geometry.dispose(); terrainMesh = null; }
    for (const m of MATS) m.dispose();
    MATS.length = 0;
    for (const k in TEX) if (TEX[k] && TEX[k].dispose) TEX[k].dispose();
    if (heightTex) heightTex.dispose();
    if (depthTex) depthTex.dispose();
    if (coarseTex) { coarseTex.dispose(); coarseTex = null; }
    if (coverTex) { coverTex.dispose(); coverTex = null; }
    I.ready = false;
  }
  I.dispose = dispose;
})();
