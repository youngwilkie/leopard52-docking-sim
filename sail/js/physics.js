/* =============================================================================
   physics.js — SAIL.physics
   Leopard 52 (Robertson & Caine, 2025) 4-DOF sailing catamaran dynamics.

   DOF: surge (u), sway (v), yaw (r) and ROLL (p / heelRad) integrated at 200 Hz
   with semi-implicit Euler.  Heave and pitch are solved quasi-statically once
   per FRAME from twelve buoyancy probes against the ocean surface.

   Inherited verbatim in structure from the validated 3-DOF motoring model:
     · strip theory over 16 stations per hull (cross-flow drag + skin friction),
       so yaw damping and pivot-point migration fall out of the geometry;
     · open-water propeller Kt/Kq vs advance ratio, wake fraction, thrust
       deduction, 4-quadrant signs, prop walk astern;
     · Yanmar torque curve + mechanical governor + rotational inertia + gearbox
       neutral/clunk delay;
     · rudder lift with finite-AR stall and only the ~35 % of span inside the
       contracted propeller race seeing slipstream;
     · angle-dependent windage, shallow-water correction, squat, bank suction,
       grounding, fender spring-damper contact.

   SIGN CONTRACTS (do not "fix" these — every other module depends on them):
     world  +X = East, +Z = South, -Z = North, +Y = up, metres.
     heading is compass radians, 0 = North.  fwd = (sin h, 0, -cos h).
     body   +x = forward (bow), +y = starboard, +z = up.
     yaw    positive N / r  =>  bow swings to STARBOARD.
     A longitudinal force at lateral offset yh contributes  N = -yh*Fx.
       (port engine ahead, yh<0, Fx>0  =>  N>0  =>  bow to starboard.)
     heelRad positive = STARBOARD SIDE UP (heeled to port).  Apply it directly
       as mesh.rotation.z on a model whose +X is starboard and +Y is up.
       Wind from starboard (awa > 0, starboard tack) therefore gives heelRad > 0
       and it is the STARBOARD (windward) hull that flies.
     awa    positive = apparent wind from STARBOARD = starboard tack.
     pitchRad positive = BOW UP.

   Dependencies, all optional and all fail-soft:
     SAIL.ocean.heightAt(x,z,t)   surface elevation, metres      (else 0)
     SAIL.ocean.sample(x,z)       {y,...}                        (fallback)
     SAIL.island.depthAt(x,z)     water depth, -1 = land         (else 25 m)
     SAIL.world.depthAt / segmentsNear / nearestWall             (fallback)
     SAIL.sails.getAero(trim)     see readAero() below           (else internal)
   ========================================================================== */
(function () {
  'use strict';
  window.SAIL = window.SAIL || {};
  var SAIL = window.SAIL;

  /* ------------------------------------------------------------- constants */
  var KN = 1.94384;          // m/s -> knots
  var RHO = 1025;            // seawater
  var RHO_A = 1.18;          // air at 28 C, tropical
  var G = 9.81;
  var PI = Math.PI;
  var D2R = PI / 180, R2D = 180 / PI;

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function sstep(a, b, x) { var t = clamp((x - a) / (b - a || 1e-9), 0, 1); return t * t * (3 - 2 * t); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function nowMs() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
  function fin(v) { return typeof v === 'number' && isFinite(v); }

  /* ------------------------------------------------------------- hull spec */
  var SPEC = {
    loa: 15.75, lwl: 15.31, beam: 8.16, draft: 1.70,
    hullBeam: 2.15, hullSep: 3.005,          // hull centres 6.01 m apart
    displLight: 20517, payload: 7000,
    canoeDraft: 1.02, bwl: 1.90, cwp: 0.78,
    mastHeight: 23.4, sailArea: 168.3,
    propX: -6.15, propD: 0.48, propY: -1.50, gearRatio: 2.61,
    rudX: -6.95, rudArea: 0.55, rudSpan: 1.15, rudAR: 2.4, rudMax: 35,
    areaFront: 30, areaSide: 105,            // hull + superstructure windage
    wakeFrac: 0.08, thrustDed: 0.05,
    bowRef: 7.8                              // bow fairlead, for the mooring tether
  };

  /* -------------------------------------------------------------- rig spec */
  var RIG = {
    mainArea: 99.3, jibArea: 69.0,           // 168.3 m2 total
    P: 20.0, E: 7.0, I: 19.6, LP: 7.0,
    arMain: 4.6, arJib: 5.0,
    ceMain: 9.9, ceJib: 7.6,                 // CE height above WL
    clrDepth: 0.90,                          // CLR below WL -> heeling lever
    xceMain: -1.40, xceJib: 6.60,            // longitudinal CE, +forward of CG
    xclr: 0.35,                              // centre of lateral resistance
    windA: 9.5, windCd: 0.85,                // mast + boom + rigging + arch
    deltaMainMax: 80 * D2R,                  // wide cat traveller, no backstay
    deltaJibMax: 35 * D2R,                   // genoa track
    alpha0L: -10 * D2R,                      // soft sail, ~10 % camber
    alphaStall: 16 * D2R,
    cd0: 0.020, eMain: 0.85, eJib: 0.90,
    reefFactor: [1.0, 0.78, 0.58]            // reef 0 / 1 / 2 on the main
  };

  /* ------------------------------------------------- calibration constants
     Tuned by running the identical steady force balance that SAIL.physics.polar()
     exposes, against the acceptance polars.  Achieved: RMS 1.0 kn over the ten
     acceptance points, 5.4-6.6 deg leeway close hauled, 1-3 deg heel, tacking
     angle 90-105 deg, best upwind VMG at TWA 45-52, best downwind VMG at TWA
     155-160 (she does NOT want to sail dead downwind), ~2.5 kn under bare poles
     in 25 kn, 9.7 kn motoring flat out.  Every one of those is emergent from the
     force balance; there is no polar lookup table anywhere in this file.

     The two acceptance points the model will not reach are TWA 120 (about 1.8 kn
     slow at 20 kn TWS) and TWA 60 at 20 kn (about 1.7 kn fast).  Those two are
     mutually inconsistent for any single quasi-static hull: 20 kn / 60 deg and
     12 kn / 90 deg sit at the same Froude number but demand very different drag.
     The compromise favours the shape of the polar — slow upwind, fastest on a
     beam reach, no desire to run square — over any individual number.        */
  var CAL = {
    Cf: 0.00334,             // lumped friction + form over the strip girth
    Cdc: 0.88,               // hull cross-flow drag coefficient
    kRes: 112.0,             // residuary (wave-making) coefficient
    resBase: 0.10,           // slender demihull: almost no wave drag at low Fn
    resF0: 0.292, resF0w: 0.12,
    resF1: 0.386, resF1w: 0.116, resB: 1.785,
    kSurgeLin: 190.0,        // low-speed surge damping, tapered out with speed
    kSwayLin: 1500.0,
    kYawLin: 5.2e4,
    CYbeta: 0.560,           // lateral lift slope per rad about the zero
    betaStall: 0.32,         // hull cross-flow stall, rad (18 deg)
    aLat: 30.8,              // hull profile 2x11.2 + mini keels 2x4.2
    bEff: 1.75, nEff: 2,     // induced-drag effective span, per hull x 2 hulls
    noPole: 0.45,            // deep-running penalty with no pole / no kite

    /* WHERE THE HULL'S LATERAL LIFT ACTUALLY ACTS.  RIG.xclr (+0.35 m) is the
       GEOMETRIC centroid of the lateral plane — the number a designer measures
       off the sail plan to set the lead, and the number quoted in the spec.  It
       is not where the force appears.  A hull at leeway is a very low aspect
       lifting surface and its centre of pressure sits near quarter chord from
       the leading edge, i.e. 3.6 m forward of the CG (24 % of LWL abaft the
       bow).  Applying the lift at the geometric centroid instead gives the boat
       pure lee helm: with the combined sail CE at +1.88 m and the rudders' own
       drift-alignment moment both pushing the bow away from the wind, she bears
       off from every heading and cannot be made to sail upwind at all.  This is
       the standard reason designers must build in 10-18 % of lead in the first
       place.  Helm balance stays fully emergent: reef the main and x_ce moves
       forward and she bears away; furl the jib and x_ce runs back to -1.4 m and
       she rounds up hard.  Nothing here is a helm bias. */
    xLift: 3.60,

    /* SMITH EFFECT — Froude-Krylov pressure decays as exp(-k z) with depth, so
       a short wave excites a deep body far less than its surface slope implies.
       Without it the roll response runs away: the natural roll period is 1.98 s,
       a 14 m beam sea forces at 3.0 s, and the undamped-looking shoulder of the
       resonance turns an 8 deg wave slope into 18 deg of roll — three times what
       a Leopard 52 does.  Roll is weighted by the outboard, deeper volume so it
       sees the larger depth; heave and pitch are waterplane-dominated and see a
       smaller one.  The effective wavenumber is estimated live from the ratio of
       the RMS surface rate to the RMS surface elevation under the boat, so this
       needs nothing from the ocean module beyond heightAt(). */
    smithRoll: 1.50, smithVert: 0.60
  };

  /* ---------------------------------------------- mass, inertia, stability */
  var MASS = (function () {
    var m = SPEC.displLight + SPEC.payload * 0.42;      // 23,457 kg
    var W = m * G;                                      // 230,113 N
    return {
      m: m, W: W,
      vol: m / RHO,                                     // 22.9 m3
      Izz: m * 22.3,                                    // yaw, kzz 4.72 m
      IxxDry: m * Math.pow(0.34 * SPEC.beam, 2),        // 1.80e5
      Ixx: m * Math.pow(0.34 * SPEC.beam, 2) + 0.9 * m * Math.pow(SPEC.hullSep, 2),
      GMt: 16.2,                                        // BM 18.5 - BG 2.32
      BMt: 18.5,
      halfB: SPEC.hullSep,                              // one-hull-flying arm
      B44: 5.17e5,                                      // 2*zeta*sqrt(Ixx*W*GM), zeta 0.22
      B44q: 1.2e5,
      heaveAdded: 0.9                                   // roll of a cat is heave of two hulls
    };
  })();

  /* ================================ geometry ==============================
     16 strips per hull for the force loop, 6 stations per hull for buoyancy. */
  function hullBeamAt(t) {
    return t >= 0
      ? SPEC.hullBeam * Math.pow(Math.max(0, 1 - Math.pow(t, 2.35)), 0.46)
      : SPEC.hullBeam * (1 - 0.26 * Math.pow(-t, 3.2));
  }
  function hullDraftAt(t) {
    var T = SPEC.canoeDraft * (1 - Math.pow(Math.max(0, t), 2.0) * 0.9);
    if (t < -0.9) T *= 0.85;
    return T;
  }

  var STRIPS = (function () {
    var n = 16, out = [], L = SPEC.lwl;
    for (var i = 0; i < n; i++) {
      var t = -1 + 2 * (i + 0.5) / n;                   // -1 stern .. +1 bow
      var x = t * L / 2, dx = L / n;
      var T = hullDraftAt(t), B = hullBeamAt(t);
      var keel = (x > -2.2 && x < 4.0) ? 0.74 : 0;      // low-aspect mini keel
      out.push({ x: x, dx: dx, T: T, B: B,
                 lat: (T + keel) * dx, wet: (1.85 * T + 0.9 * B) * dx });
    }
    return out;
  })();

  /* Buoyancy probes: 6 stations x 2 hulls.  Their waterplane areas sum to
     45.7 m2 (2 x LWL x BWL x Cwp = 45.4) and their second moments give
     I_T = 413 m4 and I_L = 775 m4, i.e. BM_T 18.0 m and BM_L 33.8 m — a
     catamaran is astonishingly stiff in both. */
  var PROBES = (function () {
    var out = [], L = SPEC.lwl, dx = L / 6;
    for (var s = -1; s <= 1; s += 2) {
      for (var i = 0; i < 6; i++) {
        var t = -1 + 2 * (i + 0.5) / 6;
        var x = t * L / 2;
        out.push({ x: x, y: s * SPEC.hullSep, A: hullBeamAt(t) * dx * SPEC.cwp });
      }
    }
    return out;
  })();

  var HYDRO = (function () {
    var Awp = 0, Il = 0, It = 0;
    for (var i = 0; i < PROBES.length; i++) {
      var p = PROBES[i];
      Awp += p.A; Il += p.A * p.x * p.x; It += p.A * p.y * p.y;
    }
    var kHeave = RHO * G * Awp;                         // 4.57e5 N/m
    var mHeave = MASS.m * (1 + MASS.heaveAdded);        // T_heave = 1.96 s
    var kPitch = RHO * G * Il;                          // 7.79e6 N m/rad
    var Iyy = kPitch * Math.pow(2.2 / (2 * PI), 2);     // T_pitch = 2.20 s
    return {
      Awp: Awp, Il: Il, It: It,
      kHeave: kHeave, mHeave: mHeave,
      cHeave: 0.55 * 2 * Math.sqrt(kHeave * mHeave),
      kPitch: kPitch, Iyy: Iyy,
      cPitch: 0.55 * 2 * Math.sqrt(kPitch * Iyy),
      kRollWave: MASS.W * MASS.GMt                      // she follows the slope
    };
  })();

  var SWET = (function () { var s = 0; for (var i = 0; i < STRIPS.length; i++) s += STRIPS[i].wet; return 2 * s; })();
  var SLAT = (function () { var s = 0; for (var i = 0; i < STRIPS.length; i++) s += STRIPS[i].lat; return 2 * s; })();

  /* ============================ world hooks =============================== */
  function depthAt(x, z) {
    var I = SAIL.island, W = SAIL.world;
    var d;
    if (I && typeof I.depthAt === 'function') { d = I.depthAt(x, z); if (fin(d)) return d; }
    if (W && typeof W.depthAt === 'function') { d = W.depthAt(x, z); if (fin(d)) return d; }
    return 25;
  }
  function waveY(x, z, t) {
    var O = SAIL.ocean;
    if (!O) return 0;
    if (typeof O.heightAt === 'function') { var y = O.heightAt(x, z, t); if (fin(y)) return y; }
    if (typeof O.sample === 'function') { var s = O.sample(x, z); if (s && fin(s.y)) return s.y; }
    return 0;
  }
  function segsNear(x, z, rad) {
    var W = SAIL.world, I = SAIL.island;
    if (W && typeof W.segmentsNear === 'function') return W.segmentsNear(x, z, rad) || [];
    if (I && typeof I.segmentsNear === 'function') return I.segmentsNear(x, z, rad) || [];
    if (W && W.segments) return W.segments;
    if (I && I.segments) return I.segments;
    return [];
  }
  function nearestWall(x, z, maxD) {
    var W = SAIL.world, I = SAIL.island;
    if (W && typeof W.nearestWall === 'function') return W.nearestWall(x, z, maxD) || null;
    if (I && typeof I.nearestWall === 'function') return I.nearestWall(x, z, maxD) || null;
    return null;
  }
  function gustFieldAt(x, z) {
    var O = SAIL.ocean;
    if (O && typeof O.gustAt === 'function') { var g = O.gustAt(x, z); if (fin(g)) return g; }
    return 1;
  }

  /* ============================ propeller ================================= */
  var PROP = { Kt0: 0.40, Kq0: 0.0480, J0: 1.00, asternT: 0.72, asternQ: 0.80 };

  function propForces(np, ua, D, scale) {
    var n = Math.abs(np);
    if (n < 0.05) return { T: 0, Q: 0 };
    var rn2d4 = RHO * n * n * Math.pow(D, 4);
    var rn2d5 = RHO * n * n * Math.pow(D, 5);
    var J = ua / (Math.max(n, 0.05) * D) * (np < 0 ? -1 : 1);
    var Jc = clamp(J, -0.6, 1.6);
    var kt = PROP.Kt0 * (1 - Jc / PROP.J0);
    var kq = PROP.Kq0 * (1 - 0.6 * Jc / PROP.J0);
    var dir = np < 0 ? -1 : 1;
    var eT = dir > 0 ? 1 : PROP.asternT;
    var eQ = dir > 0 ? 1 : PROP.asternQ;
    return { T: dir * rn2d4 * Math.max(kt, -0.12) * eT * scale,
             Q: rn2d5 * Math.max(kq, 0.004) * eQ * scale };
  }

  function engineTorque(rpm, ratedKW, ratedRPM) {
    var x = clamp(rpm / ratedRPM, 0.15, 1.12);
    var qRated = ratedKW * 1000 / (ratedRPM * PI / 30);
    var shape = 1.06 - 0.42 * Math.pow(x - 0.72, 2) / 0.36;
    return qRated * clamp(shape, 0.35, 1.12);
  }

  /* =========================== rig aerodynamics ===========================
     MODE 1 — whole-rig optimal-trim table (Hazen family, modern main + genoa).
     Used for auto-trim, for the AI boats and for the velocity prediction.   */
  var PA = [0, 20, 27, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 135, 150, 165, 180];
  var PCL = [0, 0.50, 1.05, 1.28, 1.49, 1.55, 1.50, 1.38, 1.22, 1.02, 0.82, 0.64, 0.48, 0.28, 0.14, 0.05, 0];
  var PCD = [0.050, 0.045, 0.075, 0.095, 0.155, 0.240, 0.345, 0.460, 0.580, 0.700,
             0.820, 0.930, 1.030, 1.140, 1.210, 1.235, 1.240];

  function rigTable(awaDeg) {
    var a = Math.abs(awaDeg);
    if (a >= 180) return { CL: 0, CD: 1.240 };
    if (a <= 0) return { CL: 0, CD: 0.050 };
    for (var i = 0; i < PA.length - 1; i++) {
      if (a >= PA[i] && a <= PA[i + 1]) {
        var f = (a - PA[i]) / (PA[i + 1] - PA[i]);
        return { CL: lerp(PCL[i], PCL[i + 1], f), CD: lerp(PCD[i], PCD[i + 1], f) };
      }
    }
    return { CL: 0, CD: 1.240 };
  }

  /* MODE 2 — per-sail angle of attack, for manual trim.  alpha is measured
     from the ZERO-LIFT line; a soft sail at 10 % camber has alpha_0L = -10 deg.
     Post-stall uses Viterna-Corrigan, which is what makes reaching and running
     work at all: without it a sheeted-out sail produces nothing.            */
  function sailAoA(alpha, AR, e) {
    var CDmax = 1.11 + 0.018 * AR;
    var CLa = 2 * PI / (1 + 2 / AR);
    var as = RIG.alphaStall;
    var sgn = alpha < 0 ? -1 : 1;
    var a = Math.abs(alpha);
    var CLatt = CLa * a;
    var CDatt = RIG.cd0 + CLatt * CLatt / (PI * AR * e);
    if (a <= as) return { CL: sgn * CLatt, CD: CDatt };
    // symmetric reflection past 90 deg so the formulae stay well conditioned
    var ar = a > PI / 2 ? PI - a : a;
    var refl = a > PI / 2 ? -1 : 1;
    ar = Math.max(ar, as);
    var CLs = CLa * as;
    var CDs = RIG.cd0 + CLs * CLs / (PI * AR * e);
    var sa = Math.sin(as), ca = Math.cos(as);
    var A2 = (CLs - CDmax * sa * ca) * sa / (ca * ca);
    var B2 = (CDs - CDmax * sa * sa) / ca;
    var sr = Math.sin(ar), cr = Math.cos(ar);
    var CLp = (CDmax / 2) * Math.sin(2 * ar) + A2 * cr * cr / Math.max(sr, 0.02);
    var CDp = CDmax * sr * sr + B2 * cr;
    var w = sstep(as, as + 6 * D2R, a);
    return { CL: sgn * refl * lerp(CLatt, CLp, w), CD: lerp(CDatt, Math.max(CDp, 0.02), w) };
  }

  /* Whole-rig coefficients, both modes, plus the geometry the renderer wants.
     Returns coefficients only; the force assembly lives in aeroForces().    */
  function rigCoeffs(awaRad, reef, furl, autoTrim, mainSheet, jibSheet, poled) {
    var aDeg = Math.abs(awaRad) * R2D;
    var rf = RIG.reefFactor[clamp(reef | 0, 0, 2)];
    var aMain = RIG.mainArea * rf;
    var aJib = RIG.jibArea * (1 - clamp(furl, 0, 1));
    if (aDeg > 130 && !poled) aJib *= 1 - 0.55 * sstep(130, 175, aDeg);

    var dMain, dJib;
    if (autoTrim) {
      dMain = clamp(0.55 * (aDeg - 12.0), 0, RIG.deltaMainMax * R2D) * D2R;
      dJib = clamp(0.55 * (aDeg - 12.0), 0, RIG.deltaJibMax * R2D) * D2R;
    } else {
      dMain = clamp(mainSheet, 0, 1) * RIG.deltaMainMax;
      dJib = clamp(jibSheet, 0, 1) * RIG.deltaJibMax;
    }

    var A = aMain + aJib;
    var out = { CL: 0, CD: 0.05, area: A, areaMain: aMain, areaJib: aJib,
                deltaMain: dMain, deltaJib: dJib,
                luffMain: false, luffJib: false, luffing: false,
                alphaMain: 0, alphaJib: 0, mode: autoTrim ? 'auto' : 'manual',
                hce: RIG.ceMain, xce: 0, yce: 0, lever: RIG.ceMain + RIG.clrDepth };
    if (A < 0.5) { out.CL = 0; out.CD = 0; return out; }

    // geometric angle of attack, always computed — the renderer and the sound
    // want the luff flags even when the coefficients come from the table
    var aMainAoA = (aDeg * D2R - dMain) - RIG.alpha0L;
    var aJibAoA = (aDeg * D2R - dJib) - RIG.alpha0L;
    out.alphaMain = aMainAoA; out.alphaJib = aJibAoA;
    out.luffMain = aMainAoA < 4 * D2R;
    out.luffJib = aJibAoA < 4 * D2R;

    if (autoTrim) {
      var tb = rigTable(aDeg);
      out.CL = tb.CL; out.CD = tb.CD;
      // pinching still kills the whole rig even on autopilot
      if (aDeg < 22) { var k = clamp(aDeg / 22, 0, 1); out.CL *= k; out.CD += 0.06 * (1 - k); out.luffing = aDeg < 18; }
    } else {
      var m = sailAoA(aMainAoA, RIG.arMain, RIG.eMain);
      var j = sailAoA(aJibAoA, RIG.arJib, RIG.eJib);
      if (out.luffMain) { var km = clamp(aMainAoA / (4 * D2R), -1, 1); m.CL *= km; m.CD += 0.06; }
      if (out.luffJib) { var kj = clamp(aJibAoA / (4 * D2R), -1, 1); j.CL *= kj; j.CD += 0.06; }
      out.CL = (m.CL * aMain + j.CL * aJib) / A;
      out.CD = (m.CD * aMain + j.CD * aJib) / A;
      out.luffing = out.luffMain || out.luffJib;
    }
    // no pole and no kite: the rig simply cannot be squared off dead downwind
    if (!poled) { var pl = 1 - CAL.noPole * sstep(135, 180, aDeg); out.CL *= pl; out.CD *= pl; }

    // centre of effort — this is what makes helm balance emergent
    var ceH = (aMain * RIG.ceMain + aJib * RIG.ceJib) / A;
    var ceX = (aMain * RIG.xceMain + aJib * RIG.xceJib) / A;
    var boomOut = 0.45 * RIG.E * Math.sin(dMain);
    out.hce = ceH;
    out.xce = ceX;
    out.yce = boomOut * (aMain / A) * (awaRad >= 0 ? -1 : 1);   // boom to leeward
    out.lever = ceH + RIG.clrDepth;                              // 9.85 m nominal
    return out;
  }

  /* Assemble body-frame forces from coefficients and the apparent wind.
       ex,ey = unit vector along the apparent-wind VELOCITY
       lift  = s*(-ey, ex),  drag = (ex, ey),   s = sign(awa)
     Starboard tack close hauled: au<0, av<0 => lift points forward and to port.
     Correct: the boat is driven forward and pushed to leeward.               */
  function aeroForces(co, au, av, Vaw, heelRad) {
    var q = 0.5 * RHO_A * Vaw * Vaw;
    if (Vaw < 0.05 || co.area < 0.5) return { Fx: 0, Fy: 0, q: 0 };
    var ex = au / Vaw, ey = av / Vaw;
    var awa = Math.atan2(-av, -au);
    var s = awa >= 0 ? 1 : -1;
    var qa = q * co.area;
    var ch = Math.cos(clamp(heelRad, -1.2, 1.2));
    return {
      Fx: qa * (co.CL * s * (-ey) + co.CD * ex),
      Fy: qa * (co.CL * s * (ex) + co.CD * ey) * ch,
      q: q
    };
  }

  /* Consume SAIL.sails.getAero().  The sail module owns the shape of the sails,
     so when it is loaded its forces win and this module becomes the fallback.
     Its published contract (js/sails.js) uses the same body axes and the same
     moment conventions as this file:
       fx, fy        body-frame Newtons, +fx forward, +fy starboard
       ceHeight      centre of effort above the waterline
       ceLong        centre of effort forward of the origin (+ve = forward)
       ceX           centre of effort to starboard (the boom-out offset)
       area          sail area actually set, m2
       luffing       0..1
     The older { Fx, Fy } / { CL, CD, area } spellings are accepted too, so a
     sail module written to the integration contract rather than to sails.js
     still works.  Every field is validated: anything non-finite, and the whole
     return is discarded, because a broken sail module must never be able to
     destabilise the physics.  A zero-area return also falls back — that is what
     getAero() hands out on frame zero, before sails.update() has ever run. */
  function readAero(base, ext, au, av, Vaw, heelRad) {
    if (!ext) return null;
    var fx = fin(ext.fx) ? ext.fx : ext.Fx;
    var fy = fin(ext.fy) ? ext.fy : ext.Fy;
    var area = fin(ext.area) ? ext.area : base.area;
    var cl = fin(ext.CL) ? ext.CL : ext.cl;
    var cd = fin(ext.CD) ? ext.CD : ext.cd;
    var out = null;

    if (fin(fx) && fin(fy) && area > 0.5) {
      out = { Fx: fx, Fy: fy, q: 0.5 * RHO_A * Vaw * Vaw };
    } else if (fin(cl) && fin(cd) && area > 0.5) {
      out = aeroForces({ CL: cl, CD: cd, area: area }, au, av, Vaw, heelRad);
      base.CL = cl; base.CD = cd;
    } else return null;
    if (!fin(out.Fx) || !fin(out.Fy)) return null;
    base.area = area;

    var hce = fin(ext.hce) ? ext.hce : ext.ceHeight;
    var xce = fin(ext.xce) ? ext.xce : (fin(ext.ceLong) ? ext.ceLong
              : (fin(ext.ceZ) ? -ext.ceZ : undefined));
    var yce = fin(ext.yce) ? ext.yce : ext.ceX;
    if (fin(hce)) { base.hce = hce; base.lever = hce + RIG.clrDepth; }
    if (fin(ext.lever)) base.lever = ext.lever;
    if (fin(xce)) base.xce = xce;
    if (fin(yce)) base.yce = yce;
    if (fin(ext.areaMain)) base.areaMain = ext.areaMain;
    if (fin(ext.areaJib)) base.areaJib = ext.areaJib;
    if (fin(ext.deltaMain)) base.deltaMain = ext.deltaMain;
    if (fin(ext.deltaJib)) base.deltaJib = ext.deltaJib;
    // luffing arrives either as a flag or as a 0..1 fraction of the rig
    if (typeof ext.luffing === 'boolean') { base.luffing = ext.luffing; base.luffFrac = ext.luffing ? 1 : 0; }
    else if (fin(ext.luffing)) { base.luffFrac = clamp(ext.luffing, 0, 1); base.luffing = ext.luffing > 0.25; }
    if (typeof ext.luffMain === 'boolean') base.luffMain = ext.luffMain;
    if (typeof ext.luffJib === 'boolean') base.luffJib = ext.luffJib;
    if (ext.main && fin(ext.main.luff)) base.luffMain = ext.main.luff > 0.25;
    if (ext.jib && fin(ext.jib.luff)) base.luffJib = ext.jib.luff > 0.25;
    return out;
  }

  /* ======================= transverse stability ===========================
     GZ is the soft-min of the initial-stability branch (GM_T sin phi, and
     GM_T is 16.2 m — a monohull this size has 1.2 m) and the one-hull-flying
     branch (B/2 cos phi).  RM_max = m g B/2 = 691 kN m and the windward hull
     lifts clear at phi = asin(0.55/3.005) = 10.5 deg, because the hull has to
     rise by its own waterline draft before it is out.                       */
  function gz(phi) {
    var p = 6;
    var a = MASS.GMt * Math.sin(phi);
    var b = MASS.halfB * Math.cos(clamp(phi, -1.4, 1.4));
    var den = Math.pow(Math.pow(Math.abs(a), p) + Math.pow(Math.abs(b), p), 1 / p);
    return den > 1e-6 ? a * b / den : 0;
  }
  function rm(phi) { return MASS.W * gz(phi); }

  // invert RM -> heel, for the steady velocity prediction
  function heelFor(moment) {
    var s = moment < 0 ? -1 : 1, M = Math.abs(moment);
    var lo = 0, hi = 0.62;                       // 35 deg is well past gone
    if (M >= rm(hi)) return s * hi;
    for (var i = 0; i < 18; i++) {
      var mid = 0.5 * (lo + hi);
      if (rm(mid) < M) lo = mid; else hi = mid;
    }
    return s * 0.5 * (lo + hi);
  }

  /* ====================== shared steady force balance =====================
     Used by the 200 Hz substep (via the same primitives) and, in closed form,
     by SAIL.physics.polar().  Keeping one implementation is the only way the
     HUD target speed can be honest.                                         */
  function residuaryFactor(Fn) {
    return CAL.resBase
      + (1 - CAL.resBase) * sstep(CAL.resF0, CAL.resF0 + CAL.resF0w, Fn)
      + CAL.resB * sstep(CAL.resF1, CAL.resF1 + CAL.resF1w, Fn);
  }

  function lateralLift(u, v, V) {
    if (u <= 0.15 || V < 0.05) return 0;
    var beta = Math.atan2(-v, u);
    var stall = 1 + Math.pow(Math.abs(beta) / CAL.betaStall, 4);
    return 0.5 * RHO * CAL.aLat * V * V * CAL.CYbeta * 0.5 * Math.sin(2 * beta) / stall;
  }
  function inducedDrag(Ylift, V) {
    if (V < 0.5) return 0;
    var den = 0.5 * RHO * V * V * PI * CAL.bEff * CAL.bEff * CAL.nEff;
    return Math.min(Ylift * Ylift / den, 25000);
  }

  /* Wind shear over water, power law 1/7.  At the sail CE (8.95 m) 0.99*V10,
     at deck level (2 m) 0.79*V10 — which is exactly why the cockpit feels calm
     while the rig is loaded, and why the masthead instruments read high.     */
  function shear(h) { return Math.pow(Math.max(h, 0.5) / 10, 1 / 7); }

  /* Narrow-band encounter wavenumber tracker.  st = { p, ms, md }; returns k in
     rad/m.  Four-second exponential windows: steady enough not to chatter, fast
     enough to follow a change of course through a crossing sea. */
  function kOf(st, val, dt) {
    var d = (val - st.p) / Math.max(dt, 1e-4);
    st.p = val;
    var a = 1 - Math.exp(-dt / 4.0);
    st.ms = lerp(st.ms, val * val, a);
    st.md = lerp(st.md, d * d, a);
    if (st.ms < 1e-9) return 0;
    var w = clamp(Math.sqrt(st.md / st.ms), 0.15, 6.0);
    return w * w / G;
  }

  var SHEAR_HULL = shear(2.6);       // hulls, bridgedeck, coachroof, flybridge
  var SHEAR_RIG = shear(11.0);       // mast, boom, standing rigging, arch
  var SHEAR_CE = shear(8.95);        // combined sail centre of effort
  var SHEAR_DECK = shear(2.0);       // what the cockpit anemometer feels
  var SHEAR_MAST = shear(SPEC.mastHeight);

  /* -------- windage, shared by the substep and the prediction -------------
     Two bodies at two heights: the hull/superstructure block with OCIMF-style
     angle-dependent coefficients and a centre of effort that migrates with
     wind angle, and the bare rig, which is a plain bluff body.  (hu,hv) and
     (ru,rv) are the apparent-wind vectors at each height, body axes.        */
  function windage(hu, hv, ru, rv) {
    var out = { X: 0, Y: 0, xce: 0 };
    var Vh = Math.hypot(hu, hv);
    if (Vh > 0.05) {
      var q = 0.5 * RHO_A * Vh * Vh;
      var beta = Math.atan2(hv, hu);             // 0 = wind from astern
      var cb = Math.cos(beta), sb = Math.sin(beta), c2 = Math.cos(2 * beta);
      out.X = q * SPEC.areaFront * 0.72 * cb * (1 + 0.18 * c2);
      out.Y = q * SPEC.areaSide * 1.08 * sb * (1 + 0.12 * c2);
      out.xce = 2.35 * Math.abs(sb) + 0.55 * cb;
    }
    var Vr = Math.hypot(ru, rv);
    if (Vr > 0.05) {
      var qr = 0.5 * RHO_A * Vr * Vr * RIG.windA * RIG.windCd;
      out.X += qr * (ru / Vr);
      out.Y += qr * (rv / Vr);
    }
    return out;
  }

  /* Auto reef / furl schedule.  Furling moves the CE forward or aft, which
     moves helm balance — that is emergent, never hard-coded.                */
  function autoReefFor(twsKn) { return twsKn < 20.5 ? 0 : (twsKn < 25.5 ? 1 : 2); }
  function autoFurlFor(twsKn) { return twsKn < 24 ? 0 : (twsKn < 29 ? 0.25 : (twsKn < 34 ? 0.5 : 0.75)); }

  /* ============================== the boat ================================ */
  function Boat(opts) {
    opts = opts || {};
    this.spec = SPEC; this.rigSpec = RIG; this.cal = CAL; this.massInfo = MASS;
    this.loadFrac = opts.load != null ? opts.load : 0.42;
    this.mass = SPEC.displLight + SPEC.payload * this.loadFrac;
    this.Izz = this.mass * 22.3;
    this.Ixx = this.mass * Math.pow(0.34 * SPEC.beam, 2) + 0.9 * this.mass * Math.pow(SPEC.hullSep, 2);
    this.setEngines(opts.hp || 57);
    // live surface elevation under each buoyancy probe, in PROBES order — the
    // spray and foam emitters want it and it is already paid for
    this.probeEta = [];
    for (var i = 0; i < PROBES.length; i++) this.probeEta.push(0);
    this.reset(opts.x || 0, opts.z || 0, opts.headingDeg || 0);
  }

  Boat.prototype.setEngines = function (hp) {
    this.hp = hp;
    this.ratedKW = hp * 0.7457;
    this.ratedRPM = 3000;
    this.idleRPM = 720;
    this.propScale = hp >= 80 ? 1.22 : 1.0;
    this.Ieng = 0.9;
  };

  Boat.prototype.reset = function (x, z, hdgDeg) {
    this.x = x; this.z = z;
    this.heading = (hdgDeg || 0) * D2R;
    this.h = this.heading;
    this.u = 0; this.v = 0; this.r = 0;
    this.heelRad = 0; this.rollRate = 0;
    this.pitchRad = 0; this.pitchRate = 0;
    this.heaveY = 0; this.heaveRate = 0;
    this.lever = [0, 0]; this.gear = [0, 0]; this.gearWait = [0, 0];
    this.rpm = [this.idleRPM, this.idleRPM];
    this.thrust = [0, 0]; this.propQ = [0, 0]; this.load = [0, 0];
    this.rud = 0; this.rudCmd = 0;
    this.aground = false; this.groundBite = 0; this.underKeel = 9; this.squat = 0;
    this.impacts = []; this.maxImpact = 0; this.contacts = 0; this.contactNow = 0;
    this.hitFlag = null; this.clunk = 0; this.lastHitT = 0;
    this.tether = null; this.tetherLoad = 0;
    this.nearSegs = []; this.bank = null;
    // controls
    this.sailsUp = true; this.autoTrim = true; this.poled = false;
    this.mainSheet = 0.35; this.jibSheet = 0.35;
    this.reef = 0; this.jibFurl = 0; this.autoReef = true;
    // derived readouts, valid before the first step()
    this.hdg = ((hdgDeg || 0) % 360 + 360) % 360;
    this.headingDeg = this.hdg;
    this.speedKn = 0; this.sog = 0; this.cog = this.hdg; this.rot = 0;
    this.acc = 0; this.lastU = 0;
    this.heelDeg = 0; this.pitchDeg = 0;
    this.leewayDeg = 0; this.vmg = 0;
    this.aw = { spd: 0, ang: 0 }; this.awDeck = { spd: 0, ang: 0 }; this.awMast = { spd: 0, ang: 0 };
    this.awaDeg = 0; this.awsKn = 0; this.twaDeg = 0; this.twsKn = 0; this.twsAvgKn = 0;
    this.rig = rigCoeffs(0, 0, 0, true, 0.35, 0.35, false);
    this.rig.Fx = 0; this.rig.Fy = 0; this.rig.heelMoment = 0;
    this.hullFly = 0; this.capsizeRisk = 0; this.capsized = false; this.capTimer = 0;
    this.bowIndex = 0; this.burying = 0;
    this.gustSpd = 0; this.gustDir = 0; this.gustMul = 1;
    this.polarTarget = 0; this.targetPct = 0;
    this.waveA = 0; this.waveB = 0; this.waveC = 0; this.waveK = 0;
    this._fA = { p: 0, ms: 0, md: 0 };
    this._fB = { p: 0, ms: 0, md: 0 };
    this._fC = { p: 0, ms: 0, md: 0 };
    this.luffing = false; this.inducedDrag = 0; this.heelMoment = 0;
    this.rudAlpha = 0; this.rudStall = false;
    this.trimState = { awaDeg: 0, awsMs: 0, mainSheet: this.mainSheet, jibSheet: this.jibSheet,
                       reef: 0, heelRad: 0 };
    this._aero = { Fx: 0, Fy: 0, q: 0 };
    this._windage = { X: 0, Y: 0, xce: 0 };
    this._t = 0;
    return this;
  };

  /* ------------------------------------------------------------- controls */
  Boat.prototype.setRudder = function (deg) { this.rudCmd = clamp(deg, -SPEC.rudMax, SPEC.rudMax); };
  Boat.prototype.setThrottle = function (i, v) { this.lever[i] = clamp(v, -1, 1); };
  Boat.prototype.setThrottles = function (v) { this.lever[0] = this.lever[1] = clamp(v, -1, 1); };
  Boat.prototype.setSails = function (up) { this.sailsUp = !!up; };
  Boat.prototype.setReef = function (n) { this.reef = clamp(n | 0, 0, 2); this.autoReef = false; };
  Boat.prototype.setSheets = function (main, jib) {
    this.autoTrim = false;
    if (fin(main)) this.mainSheet = clamp(main, 0, 1);
    if (fin(jib)) this.jibSheet = clamp(jib, 0, 1);
  };

  /* ------------------------------------------------------------- gearbox */
  Boat.prototype.stepDrive = function (dt) {
    for (var i = 0; i < 2; i++) {
      var want = Math.abs(this.lever[i]) < 0.07 ? 0 : (this.lever[i] < 0 ? -1 : 1);
      if (want !== this.gear[i]) {
        if (this.gear[i] !== 0) { this.gear[i] = 0; this.gearWait[i] = 0.5; this.clunk = 1; }
        else if (this.gearWait[i] <= 0) { this.gear[i] = want; if (want) this.clunk = 1; }
      }
      this.gearWait[i] = Math.max(0, this.gearWait[i] - dt);
    }
  };

  /* ================= per-frame environment preparation ====================
     The wave field is sampled ONCE per frame and held across the five 200 Hz
     substeps: the surface moves under 3 cm in 5 ms, you cannot tell, and it
     cuts the wave cost by 3.3x.  Twelve probe heights per frame is the entire
     wave budget for the physics.                                            */
  Boat.prototype.prepEnv = function (dt, env) {
    var E = this._env || (this._env = {});
    var e = env || SAIL.env || {};
    E.t = fin(e.t) ? e.t : this._t;
    this._t = E.t;

    // ---- true wind, world axes (air velocity: the way the wind BLOWS) -----
    var wx, wz;
    if (fin(e.windX) && fin(e.windZ)) { wx = e.windX; wz = e.windZ; }
    else {
      var spd = (fin(e.windKn) ? e.windKn : 14) / KN;
      var dir = (fin(e.windDirDeg) ? e.windDirDeg : 75) * D2R;   // direction it comes FROM
      wx = -spd * Math.sin(dir); wz = spd * Math.cos(dir);
    }
    // Ornstein-Uhlenbeck gust on speed (tau 12 s) and direction (tau 40 s),
    // multiplied by the shared world gust field so the cat's-paws you can SEE
    // on the water are the ones that hit you.
    var base = Math.hypot(wx, wz);
    var sg = 0.14 * Math.max(base, 0.5);
    this.gustSpd += (-this.gustSpd / 12 * dt) + sg * Math.sqrt(2 * dt / 12) * (Math.random() * 2 - 1) * 1.732;
    this.gustDir += (-this.gustDir / 40 * dt) + (6 * D2R) * Math.sqrt(2 * dt / 40) * (Math.random() * 2 - 1) * 1.732;
    this.gustSpd = clamp(this.gustSpd, -0.55 * base, 0.75 * base);
    this.gustDir = clamp(this.gustDir, -0.35, 0.35);
    var fieldG = clamp(gustFieldAt(this.x, this.z), 0.55, 1.55);
    var gf = fin(e.gustFactor) ? clamp(e.gustFactor, 0.2, 3) : 1;
    var mag = (base + this.gustSpd) * fieldG * (1 + 0.35 * (gf - 1));
    this.gustMul = base > 0.05 ? mag / base : 1;
    var cd = Math.cos(this.gustDir), sd = Math.sin(this.gustDir);
    var ux = base > 1e-4 ? wx / base : 0, uz = base > 1e-4 ? wz / base : 0;
    E.windX = mag * (ux * cd - uz * sd);
    E.windZ = mag * (ux * sd + uz * cd);
    E.twsMs = mag;
    this.twsKn = mag * KN;
    // Crews reef on the sustained wind, not on gusts.  A 60 s window, seeded on
    // the first frame so a boat created in a gale starts already reefed.
    this.twsAvgKn = this.twsAvgKn > 0
      ? lerp(this.twsAvgKn, base * KN, 1 - Math.exp(-dt / 60))
      : base * KN;

    E.curX = fin(e.curX) ? e.curX : 0;
    E.curZ = fin(e.curZ) ? e.curZ : 0;

    // ---- bathymetry, collision short list (both change slowly) -----------
    this.nearSegs = segsNear(this.x, this.z, 26);
    this.bank = nearestWall(this.x, this.z, 14);
    var dpt = depthAt(this.x, this.z);
    E.depth = dpt;
    var hT = clamp((dpt > 0 ? dpt : 0.2) / SPEC.draft, 1.02, 12);
    E.kShallow = clamp(1 + 0.55 / Math.pow(hT - 0.92, 1.15), 1, 3.2);

    // ---- wave field: twelve buoyancy probes ------------------------------
    var sh = Math.sin(this.heading), ch = Math.cos(this.heading);
    var sumA = 0, sA = 0, sB = 0, sC = 0;
    for (var i = 0; i < PROBES.length; i++) {
      var p = PROBES[i];
      var px = this.x + p.x * sh + p.y * ch;
      var pz = this.z - p.x * ch + p.y * sh;
      var eta = waveY(px, pz, E.t);
      this.probeEta[i] = eta;
      sumA += p.A;
      sA += p.A * eta;
      sB += p.A * eta * p.x;
      sC += p.A * eta * p.y;
    }
    // Weighted least-squares plane through the probes, in BODY axes.  a is the
    // mean surface under the boat, b the fore-and-aft slope (+ = bow up the
    // face), c the athwartships slope (+ = water higher to starboard).  Short
    // chop cancels itself out over a 15.3 m x 6.0 m footprint, which is exactly
    // the low-pass a hull applies for real.
    E.waveA = sumA > 1e-6 ? sA / sumA : 0;
    E.waveB = HYDRO.Il > 1e-6 ? sB / HYDRO.Il : 0;
    E.waveC = HYDRO.It > 1e-6 ? sC / HYDRO.It : 0;

    /* Effective encounter wavenumber, EVALUATED SEPARATELY FOR EACH MODE.  For
       a narrow-band signal the ratio of RMS rate to RMS amplitude is exactly
       the encounter frequency, and k = w^2/g in deep water.  It has to be done
       per mode: in a typical Grenada sea a 1.2 m NW swell owns nearly all the
       variance of the mean surface (and so of heave) while the roll excitation,
       which is the elevation DIFFERENCE across 6.01 m of hull spacing, is owned
       almost entirely by the 14 m wind chop.  One shared wavenumber lets the
       swell mask the chop and the boat then rolls to the full chop slope. */
    var kA = kOf(this._fA, E.waveA, dt);
    var kB = kOf(this._fB, E.waveB, dt);
    var kC = kOf(this._fC, E.waveC, dt);
    E.smithHeave = Math.exp(-kA * CAL.smithVert);
    E.smithPitch = Math.exp(-kB * CAL.smithVert);
    E.smithRoll = Math.exp(-kC * CAL.smithRoll);
    E.kWave = kC;

    this.waveA = E.waveA; this.waveB = E.waveB; this.waveC = E.waveC;
    this.waveK = kC;
    return E;
  };

  /* =================== per-frame aerodynamic solve ========================
     Coefficients and the assembled body-frame force are computed once per
     frame and held across the substeps, exactly like the wave field.        */
  Boat.prototype.prepAero = function (E) {
    var sh = Math.sin(this.heading), ch = Math.cos(this.heading);
    // true wind in body axes at the 10 m reference height
    var tu10 = E.windX * sh - E.windZ * ch;
    var tv10 = E.windX * ch + E.windZ * sh;

    // apparent wind at the sail centre of effort
    var au = tu10 * SHEAR_CE - this.u, av = tv10 * SHEAR_CE - this.v;
    var Vaw = Math.hypot(au, av);
    var awa = Vaw > 1e-4 ? Math.atan2(-av, -au) : 0;

    this.awaDeg = awa * R2D;
    this.awsKn = Vaw * KN;
    this.aw = { spd: Vaw * KN, ang: ((awa * R2D) + 360) % 360 };

    // deck-level and masthead triangles, for the HUD, the sound and the vane
    var du = tu10 * SHEAR_DECK - this.u;
    var dv = tv10 * SHEAR_DECK - this.v;
    this.awDeck = { spd: Math.hypot(du, dv) * KN, ang: ((Math.atan2(-dv, -du) * R2D) + 360) % 360 };
    var mu = tu10 * SHEAR_MAST - this.u;
    var mv = tv10 * SHEAR_MAST - (this.v + this.r * 1.2);
    this.awMast = { spd: Math.hypot(mu, mv) * KN, ang: ((Math.atan2(-mv, -mu) * R2D) + 360) % 360 };

    // true wind angle, for the HUD and the reef schedule
    this.twaDeg = Math.atan2(-tv10, -tu10) * R2D;

    if (this.autoReef) {
      this.reef = autoReefFor(this.twsAvgKn);
      this.jibFurl = autoFurlFor(this.twsAvgKn);
    }

    var co;
    if (this.sailsUp) {
      co = rigCoeffs(awa, this.reef, this.jibFurl, this.autoTrim,
                     this.mainSheet, this.jibSheet, this.poled);
      if (this.autoTrim) {
        // If the sail module publishes its own optimum, defer to it so the
        // sheets the physics reports are the ones the rig is actually drawn at.
        var opt = null, SM = SAIL.sails;
        if (SM && typeof SM.autoSheet === 'function') {
          try { opt = SM.autoSheet(this.awaDeg); } catch (e2) { opt = null; }
        }
        if (opt && fin(opt.mainSheet) && fin(opt.jibSheet)) {
          this.mainSheet = clamp(opt.mainSheet, 0, 1);
          this.jibSheet = clamp(opt.jibSheet, 0, 1);
        } else {
          this.mainSheet = clamp(co.deltaMain / RIG.deltaMainMax, 0, 1);
          this.jibSheet = clamp(co.deltaJib / RIG.deltaJibMax, 0, 1);
        }
      }
    } else {
      co = rigCoeffs(awa, 2, 1, true, 0, 0, false);
      co.CL = 0; co.CD = 0; co.area = 0; co.areaMain = 0; co.areaJib = 0;
      co.luffing = false; co.luffMain = false; co.luffJib = false;
    }

    // hand the trim state to the sail module, then take back whatever it says
    var ts = this.trimState;
    ts.awaDeg = this.awaDeg; ts.awsMs = Vaw; ts.awsKn = this.awsKn;
    ts.mainSheet = this.mainSheet; ts.jibSheet = this.jibSheet;
    ts.reef = this.reef; ts.jibFurl = this.jibFurl; ts.heelRad = this.heelRad;
    ts.speedMs = Math.hypot(this.u, this.v); ts.sailsUp = this.sailsUp;
    ts.poled = this.poled; ts.autoTrim = this.autoTrim;
    ts.deltaMain = co.deltaMain; ts.deltaJib = co.deltaJib;
    ts.CL = co.CL; ts.CD = co.CD; ts.area = co.area;
    ts.luffing = co.luffing; ts.luffMain = co.luffMain; ts.luffJib = co.luffJib;

    var F = null;
    var S = SAIL.sails;
    if (this.sailsUp && S && typeof S.getAero === 'function') {
      var ext = null;
      try { ext = S.getAero(ts); } catch (err) { ext = null; }
      F = readAero(co, ext, au, av, Vaw, this.heelRad);
    }
    if (!F) F = aeroForces(co, au, av, Vaw, this.heelRad);
    if (!fin(F.Fx) || !fin(F.Fy)) F = { Fx: 0, Fy: 0, q: 0 };

    // sanity envelope: 168 m2 at 60 m/s apparent is already absurd
    F.Fx = clamp(F.Fx, -4e5, 4e5);
    F.Fy = clamp(F.Fy, -4e5, 4e5);

    co.Fx = F.Fx; co.Fy = F.Fy;
    co.awaDeg = this.awaDeg; co.awsKn = this.awsKn; co.q = F.q;
    co.heelMoment = -F.Fy * (fin(co.lever) ? co.lever : 9.85) * Math.cos(clamp(this.heelRad, -1.2, 1.2));
    this.rig = co;
    this._aero = F;

    // Windage is separate from the rig and applies with the sails down too —
    // it is why she still makes 2-3 kn under bare poles in 25 kn.
    this._windage = windage(tu10 * SHEAR_HULL - this.u, tv10 * SHEAR_HULL - this.v,
                            tu10 * SHEAR_RIG - this.u, tv10 * SHEAR_RIG - this.v);
    return F;
  };

  /* ================== heave / pitch, solved per frame =====================
     Two decoupled damped oscillators driven by the probe plane.  Heave period
     1.96 s, pitch 2.20 s — this is the motion that sells the sailing feel, far
     more than heel does.                                                    */
  Boat.prototype.stepVertical = function (dt, E) {
    var aeroFx = this._aero.Fx;

    /* PITCHPOLE BUDGET, evaluated first because it feeds the pitch moment.
       966 kN m is the bows' reserve buoyancy moment (m g x 4.2 m).  Close
       hauled in 20 kn apparent this index sits at 0.05; dead run, 30 kn
       apparent, full sail, on a 12 deg wave face it reaches 0.37 — the warning
       zone, and it should feel like one. */
    var idx = (Math.max(0, aeroFx) * 8.95
             + this.mass * Math.abs(this.acc) * 1.9
             + this.mass * G * 1.9 * Math.max(0, -E.waveB * E.smithPitch)) / 966e3;
    this.bowIndex = idx;
    this.burying = clamp((idx - 0.55) / 0.45, 0, 1);

    var pitchExt = -aeroFx * (fin(this.rig.hce) ? this.rig.hce : 8.95)
                 + (this.thrust[0] + this.thrust[1]) * (-SPEC.propY)
                 - 9.0e5 * this.burying;                 // the bows go down
    var steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    var h = dt / steps;
    var etaH = E.waveA * E.smithHeave, etaP = E.waveB * E.smithPitch;
    for (var i = 0; i < steps; i++) {
      var accH = (HYDRO.kHeave * (etaH - this.heaveY) - HYDRO.cHeave * this.heaveRate) / HYDRO.mHeave;
      this.heaveRate += accH * h;
      this.heaveY += this.heaveRate * h;
      var accP = (HYDRO.kPitch * (etaP - this.pitchRad) - HYDRO.cPitch * this.pitchRate + pitchExt) / HYDRO.Iyy;
      this.pitchRate += accP * h;
      this.pitchRad += this.pitchRate * h;
    }
    this.heaveY = clamp(this.heaveY, -6, 6);
    this.heaveRate = clamp(this.heaveRate, -8, 8);
    // the bows stop at 7 deg down: past that the forward sections are simply
    // out of reserve buoyancy and she is decelerating, not rotating further
    if (this.pitchRad < -7 * D2R) { this.pitchRad = -7 * D2R; this.pitchRate = Math.max(this.pitchRate, 0); }
    if (this.pitchRad > 12 * D2R) { this.pitchRad = 12 * D2R; this.pitchRate = Math.min(this.pitchRate, 0); }
    this.pitchDeg = this.pitchRad * R2D;
    if (idx > 1.0) { this.poleTimer = (this.poleTimer || 0) + dt; }
    else this.poleTimer = Math.max(0, (this.poleTimer || 0) - dt * 2);
    this.pitchpole = this.poleTimer > 0.6;
  };

  /* ========================= one 200 Hz substep =========================== */
  Boat.prototype.substep = function (dt, E) {
    var S = SPEC, m = this.mass;
    var sh = Math.sin(this.heading), ch = Math.cos(this.heading);

    // water-relative velocities (current is a bodily translation of the water)
    var cu = E.curX * sh - E.curZ * ch;
    var cv = E.curX * ch + E.curZ * sh;
    var ur = this.u - cu, vr = this.v - cv;
    var kShallow = E.kShallow;
    this.squat = clamp(0.42 * ur * ur / (G * Math.max(E.depth, 1.2)) * kShallow, 0, 0.6);

    var X = 0, Y = 0, N = 0;

    /* -------- hull: strip theory over both hulls ------------------------- */
    var Cdc = CAL.Cdc * kShallow, Cf = CAL.Cf;
    for (var si = -1; si <= 1; si += 2) {
      var yh = si * S.hullSep;
      var uh = ur - this.r * yh;
      for (var k = 0; k < STRIPS.length; k++) {
        var st = STRIPS[k];
        var vLoc = vr + this.r * st.x;
        var fy = -0.5 * RHO * Cdc * st.lat * Math.abs(vLoc) * vLoc;
        var fx = -0.5 * RHO * Cf * st.wet * Math.abs(uh) * uh;
        X += fx; Y += fy;
        N += st.x * fy - yh * fx;
      }
    }
    // residuary resistance: a slender demihull has almost no wave drag below
    // Fn 0.25 and a firm wall above 0.5, which is what caps her at 13-14 kn
    var Fn = Math.abs(ur) / Math.sqrt(G * S.lwl);
    var sgnU = ur < 0 ? -1 : 1;
    X -= sgnU * CAL.kRes * ur * ur * residuaryFactor(Fn);
    if (ur < 0) X -= sgnU * 540 * ur * ur;            // transom first separates badly
    X -= CAL.kSurgeLin * ur / (1 + Math.pow(ur / 1.2, 2));
    Y -= CAL.kSwayLin * vr;
    N -= CAL.kYawLin * this.r;

    /* -------- leeway: linear lifting term + induced drag -----------------
       The pure cross-flow strips alone yield about 4.4 kN of side force at
       6.6 deg drift and 8 kn, against the 12 kN the rig demands; uncorrected
       the boat sags to 12-14 deg of leeway and cannot sail upwind at all.
       The induced drag of that side force over a 1.75 m effective span is
       about a third of total resistance close hauled, which is exactly why a
       daggerboard-less cat is slow upwind and why cracking off 10 deg pays.  */
    var V = Math.hypot(ur, vr);
    var Ylift = lateralLift(ur, vr, V);
    Y += Ylift;
    N += Ylift * CAL.xLift;
    var Dind = inducedDrag(Ylift, V);
    X -= sgnU * Dind;
    this.inducedDrag = Dind;

    /* -------- propulsion ------------------------------------------------- */
    var wf = 1 - S.wakeFrac, td = 1 - S.thrustDed;
    for (var i = 0; i < 2; i++) {
      var side = i === 0 ? -1 : 1;
      var yh2 = side * S.hullSep;
      var uAxial = (ur - this.r * yh2) * wf;
      var nEng = this.rpm[i], nProp = nEng / S.gearRatio / 60 * this.gear[i];
      var pf = propForces(nProp, uAxial, S.propD, this.propScale);
      this.thrust[i] = pf.T * td;
      this.propQ[i] = pf.Q;
      X += this.thrust[i];
      // A longitudinal force at lateral offset yh gives N = -yh*Fx, so the PORT
      // engine ahead swings the bow to STARBOARD, the way a tank turns.
      N -= this.thrust[i] * yh2;
      if (this.gear[i] < 0) {
        var walk = 0.045 * this.thrust[i] * side;
        Y += walk; N += walk * S.propX;
      }
      var lv = Math.abs(this.lever[i]);
      var tgt = this.gear[i] === 0 ? this.idleRPM + lv * 600
                                   : this.idleRPM + lv * (this.ratedRPM - this.idleRPM);
      var qAvail = engineTorque(nEng, this.ratedKW, this.ratedRPM);
      var qDem = clamp((tgt - nEng) * 1.6, -qAvail * 0.9, qAvail);
      var qLoad = this.gear[i] === 0 ? 3.5 + nEng * 0.0022 : pf.Q / S.gearRatio + 3.0;
      var dOmega = (qDem - qLoad) / this.Ieng;
      this.rpm[i] = clamp(nEng + dOmega * 30 / PI * dt, 520, this.ratedRPM * 1.06);
      this.load[i] = clamp(qLoad / Math.max(qAvail, 1), 0, 1.2);
    }

    /* -------- rudders ---------------------------------------------------- */
    var dRad = this.rud * D2R;
    var Adisc = PI * S.propD * S.propD / 4;
    var raceFrac = 0.35;
    var maxAlpha = 0;
    for (var j = 0; j < 2; j++) {
      var sd = j === 0 ? -1 : 1, yh3 = sd * S.hullSep;
      var uLoc = ur - this.r * yh3;
      var vRud = vr + this.r * S.rudX;
      var uFree = uLoc * wf;
      var T = this.thrust[j];
      var vRace = uFree;
      if (T > 0) vRace = Math.sqrt(Math.max(0, uFree * uFree + 2 * T / (RHO * Adisc))) * 0.88;
      else if (T < 0) vRace = uFree * 0.5;
      var parts = [{ A: S.rudArea * (1 - raceFrac), vx: uFree },
                   { A: S.rudArea * raceFrac, vx: vRace }];
      for (var pi = 0; pi < 2; pi++) {
        var pp = parts[pi];
        var Vt = Math.hypot(pp.vx, vRud);
        if (Vt < 0.02) continue;
        var ahead = pp.vx >= 0;
        var betaR = ahead ? Math.atan2(vRud, Math.max(pp.vx, 0.02))
                          : Math.atan2(vRud, Math.max(-pp.vx, 0.02));
        var alpha = (ahead ? dRad : -dRad) + betaR;
        while (alpha > PI) alpha -= 2 * PI;
        while (alpha < -PI) alpha += 2 * PI;
        if (Math.abs(alpha) > maxAlpha) maxAlpha = Math.abs(alpha);
        var aStall = 0.38;
        var Cl = 3.43 * Math.sin(alpha);
        if (Math.abs(alpha) > aStall)
          Cl = (alpha < 0 ? -1 : 1) * (1.29 - 0.55 * clamp((Math.abs(alpha) - aStall) / 0.5, 0, 1));
        var Cd = 0.012 + Cl * Cl / (PI * S.rudAR * 0.85);
        var qr = 0.5 * RHO * pp.A * Vt * Vt;
        var F = qr * Cl * (ahead ? 1 : 0.55);
        Y -= F; N -= F * S.rudX;
        X -= qr * Cd * (pp.vx < 0 ? -1 : 1);
      }
    }
    this.rudAlpha = maxAlpha;
    this.rudStall = maxAlpha > 0.38;

    /* -------- sails and windage (held from the frame solve) --------------- */
    var A = this._aero, WG = this._windage;
    var lever = fin(this.rig.lever) ? this.rig.lever : 9.85;
    X += A.Fx; Y += A.Fy;
    N += A.Fy * (fin(this.rig.xce) ? this.rig.xce : 0)
       - (fin(this.rig.yce) ? this.rig.yce : 0) * A.Fx;   // downwind broaching couple
    X += WG.X; Y += WG.Y; N += WG.Y * WG.xce;

    /* -------- heel to yaw coupling ---------------------------------------
       Mild for a cat but real when pressed: the leeward bow digs in and she
       tries to round up into the wind.  heelRad > 0 means the wind is on the
       starboard side, so rounding up is a swing to starboard, i.e. +N.      */
    N += 2.6e5 * Math.sin(this.heelRad) * clamp(ur / 6.0, 0, 1);

    /* -------- bank suction alongside quays -------------------------------- */
    var bank = this.bank;
    if (bank && Math.abs(ur) > 0.3) {
      var bd = Math.max(bank.d, 2.5);
      var bf = clamp(2600 * ur * ur / (bd * bd), 0, 5200);
      var nb = bank.nx * ch + bank.nz * sh;
      Y += nb * -bf;
      N += bf * 1.8 * (nb < 0 ? -1 : 1);
    }

    /* -------- bow mooring line -------------------------------------------- */
    if (this.tether) {
      var bxw = this.x + S.bowRef * sh, bzw = this.z - S.bowRef * ch;
      var tdx = this.tether.x - bxw, tdz = this.tether.z - bzw;
      var td2 = Math.hypot(tdx, tdz);
      if (td2 > this.tether.len && td2 > 0.01) {
        var uxx = tdx / td2, uzz = tdz / td2;
        var bu = this.u, bv = this.v + this.r * S.bowRef;
        var vwx = bu * sh + bv * ch, vwz = -bu * ch + bv * sh;
        var rate = -(vwx * uxx + vwz * uzz);
        var Ft = clamp(38000 * (td2 - this.tether.len) + 9000 * rate, 0, 62000);
        var fa = Ft * (uxx * sh - uzz * ch);
        var fb = Ft * (uxx * ch + uzz * sh);
        X += fa; Y += fb; N += S.bowRef * fb;
        this.tetherLoad = Ft;
      } else this.tetherLoad = 0;
    }

    /* -------- Froude-Krylov wave forcing ---------------------------------- */
    X += -m * G * E.waveB * E.smithPitch * 0.30;
    Y += -m * G * E.waveC * E.smithRoll * 0.22;

    /* -------- bow burying -------------------------------------------------- */
    if (this.burying > 0) X -= 4.5e4 * this.burying * this.burying * ur * ur * (ur > 0 ? 1 : 0);

    /* -------- grounding ---------------------------------------------------- */
    var L2 = S.loa / 2, hs = S.hullSep + S.hullBeam / 2;
    var minD = E.depth;
    var corners = [[L2, 0], [-L2, 0], [L2 * 0.5, hs], [L2 * 0.5, -hs], [-L2, hs], [-L2, -hs]];
    for (var ci = 0; ci < corners.length; ci++) {
      var cx = corners[ci][0], cz = corners[ci][1];
      var px2 = this.x + cx * sh + cz * ch, pz2 = this.z - cx * ch + cz * sh;
      var dd = depthAt(px2, pz2);
      if (dd < minD) minD = dd;
    }
    this.underKeel = minD - S.draft - this.squat + this.heaveY;
    if (this.underKeel < 0) {
      var bite = clamp(-this.underKeel / 0.55, 0, 1);
      this.groundBite = bite;
      X -= (ur < 0 ? -1 : 1) * bite * (11000 + 4200 * Math.abs(ur));
      Y -= (vr < 0 ? -1 : 1) * bite * (17000 + 5200 * Math.abs(vr));
      N -= bite * 3.1e5 * this.r;
      if (!this.aground) this.hitFlag = { kind: 'ground', v: Math.abs(ur) };
      this.aground = true;
    } else { this.aground = false; this.groundBite = 0; }

    /* -------- ROLL --------------------------------------------------------
       Ixx dp/dt = -Fy_sail*lever - Fy_windage*2.6 - m g GZ(phi)
                   - B44 p - B44q |p| p + waveRollMoment
       The righting moment is the buoyancy of the leeward hull, not ballast:
       GM_T is 16.2 m and RM_max is 691 kN m, so at 20 kn apparent on the wind
       she sits at 1.8 deg and hull-fly needs about 48 kn apparent under full
       main and genoa — you are reefed long before, which is exactly why a
       cruising cat feels bolted to the water.  T_phi is 1.98 s: short and
       snappy, the signature catamaran motion.  Do not damp it into stillness. */
    var Mheel = -A.Fy * lever - WG.Y * 2.6 + HYDRO.kRollWave * E.waveC * E.smithRoll;
    var p = this.rollRate;
    var dp = (Mheel - rm(this.heelRad) - MASS.B44 * p - MASS.B44q * Math.abs(p) * p) / this.Ixx;
    this.rollRate = clamp(p + dp * dt, -3.2, 3.2);
    // 60 deg is the end of the road: GZ is still positive out to 90 deg on the
    // soft-min curve, but a cruising cat at 60 deg is going over and the sim
    // reports it through .capsized rather than pretending to integrate an
    // inversion it has no hull geometry for.
    this.heelRad = clamp(this.heelRad + this.rollRate * dt, -1.05, 1.05);
    if (Math.abs(this.heelRad) >= 1.05) this.rollRate *= 0.2;
    this.heelMoment = Mheel;

    /* -------- integrate surge / sway / yaw --------------------------------- */
    var mx = m * 1.06;
    var my = m * (1.75 * kShallow);
    var Iz = this.Izz * 1.6 * (1 + 0.25 * (kShallow - 1));
    var du = (X + my * this.v * this.r) / mx;
    var dv = (Y - mx * this.u * this.r) / my;
    var dr = N / Iz;
    this.u = clamp(this.u + du * dt, -6, 9);
    this.v = clamp(this.v + dv * dt, -4.5, 4.5);
    this.r = clamp(this.r + dr * dt, -0.9, 0.9);

    this.x += (this.u * sh + this.v * ch) * dt;
    this.z += (-this.u * ch + this.v * sh) * dt;
    this.heading += this.r * dt;
    if (this.heading < 0) this.heading += 2 * PI;
    if (this.heading > 2 * PI) this.heading -= 2 * PI;
    this.h = this.heading;

    this.contact(dt);
  };

  /* ============================== step ==================================== */
  Boat.prototype.step = function (dt, env) {
    if (!fin(dt) || dt <= 0) return this;
    dt = Math.min(dt, 0.1);
    this.stepDrive(dt);
    var E = this.prepEnv(dt, env);
    this.prepAero(E);

    var SUB = 1 / 200;
    var left = dt, guard = 0;
    while (left > 1e-6 && guard++ < 64) {
      var s = Math.min(SUB, left);
      this.substep(s, E);
      left -= s;
    }
    this.stepVertical(dt, E);

    // ---- derived readouts ------------------------------------------------
    var sh = Math.sin(this.heading), ch = Math.cos(this.heading);
    var Vx = this.u * sh + this.v * ch, Vz = -this.u * ch + this.v * sh;
    this.sog = Math.hypot(Vx, Vz) * KN;
    this.speedKn = this.sog;
    this.cog = ((Math.atan2(Vx, -Vz) * R2D) + 360) % 360;
    this.hdg = this.heading * R2D;
    this.headingDeg = this.hdg;
    this.rot = this.r * R2D * 60;
    this.acc = (this.u - this.lastU) / Math.max(dt, 1e-3);
    this.lastU = this.u;
    this.heelDeg = this.heelRad * R2D;
    this.leewayDeg = this.u > 0.2 ? Math.atan2(-this.v, this.u) * R2D : 0;
    this.vmg = this.sog * Math.cos(this.twaDeg * D2R);

    // wheel servo, hydraulic steering, ~3.5 turns lock to lock
    this.rud += clamp(this.rudCmd - this.rud, -30 * dt, 30 * dt);

    /* ---- capsize risk ----------------------------------------------------
       hullFly ramps in as the windward hull lifts (phi = 10.5 deg is the
       geometric point at which it clears its own waterline draft).          */
    this.hullFly = clamp((Math.abs(this.heelRad) - 0.183) / 0.10, 0, 1);
    var RMmax = MASS.W * MASS.halfB;                   // 691 kN m
    this.capsizeRisk = clamp(Math.abs(this.heelMoment || 0) / RMmax, 0, 1.5);
    // Past the maximum righting moment (about 43 deg on this GZ curve) and
    // still going after 0.8 s, she is not coming back on her own.
    if (Math.abs(this.heelRad) > 0.75) {
      this.capTimer += dt;
      if (this.capTimer > 0.8) this.capsized = true;
    } else {
      this.capTimer = Math.max(0, this.capTimer - dt * 2);
      if (Math.abs(this.heelRad) < 0.20) this.capsized = false;
    }

    /* HUD target speed, from the same force balance rather than a lookup table.
       Driven by the SUSTAINED wind: the gusted value would flicker the readout
       and, worse, would land in a different cached polar bucket every frame. */
    if (this.sailsUp && this.twsAvgKn > 0.5) {
      this.polarTarget = SAIL.physics.polar(this.twaDeg, this.twsAvgKn);
      this.targetPct = this.polarTarget > 0.2 ? clamp(this.sog / this.polarTarget, 0, 2) : 0;
    } else { this.polarTarget = 0; this.targetPct = 0; }

    this.luffing = !!this.rig.luffing;
    return this;
  };

  /* --------------------------------------------------- hull outline probes */
  Boat.prototype.hullProbes = function (inset) {
    var k = inset == null ? 1 : inset;
    var sh = Math.sin(this.heading), ch = Math.cos(this.heading);
    var L = SPEC.loa / 2, hb = SPEC.hullBeam / 2 * k, sep = SPEC.hullSep;
    var loc = [], out = [];
    for (var s = -1; s <= 1; s += 2) {
      loc.push([L * 0.99, s * sep]);
      loc.push([L * 0.82, s * (sep + hb * 0.55)]);
      loc.push([L * 0.45, s * (sep + hb)]);
      loc.push([0, s * (sep + hb)]);
      loc.push([-L * 0.55, s * (sep + hb)]);
      loc.push([-L, s * (sep + hb * 0.85)]);
      loc.push([-L, s * (sep - hb * 0.85)]);
      loc.push([-L * 0.55, s * (sep - hb)]);
      loc.push([L * 0.45, s * (sep - hb)]);
    }
    for (var i = 0; i < loc.length; i++) {
      var a = loc[i][0], b = loc[i][1];
      out.push([this.x + a * sh + b * ch, this.z - a * ch + b * sh, a, b]);
    }
    return out;
  };

  /* --------------------------------- contact: fender spring-damper -------- */
  Boat.prototype.contact = function (dt) {
    var segs = this.nearSegs;
    this.contactNow = 0;
    if (!segs || !segs.length) return;
    var pts = this.hullProbes(1);
    var sh = Math.sin(this.heading), ch = Math.cos(this.heading);
    var m = this.mass, mx = m * 1.06, my = m * 1.75, Iz = this.Izz * 1.6;
    var R = 0.45;
    for (var pi = 0; pi < pts.length; pi++) {
      var p = pts[pi], a = p[2], b = p[3];
      for (var si = 0; si < segs.length; si++) {
        var s = segs[si], nx, nz, pen, d, dx, dz;
        if (s.kind === 'pile') {
          dx = p[0] - s.ax; dz = p[1] - s.az; d = Math.hypot(dx, dz) || 1e-6;
          pen = R + 0.24 - d; if (pen <= 0) continue;
          nx = dx / d; nz = dz / d;
        } else {
          var ex = s.bx - s.ax, ez = s.bz - s.az, ll = ex * ex + ez * ez || 1e-6;
          var t = clamp(((p[0] - s.ax) * ex + (p[1] - s.az) * ez) / ll, 0, 1);
          dx = p[0] - (s.ax + ex * t); dz = p[1] - (s.az + ez * t);
          d = Math.hypot(dx, dz) || 1e-6;
          pen = R - d; if (pen <= 0) continue;
          nx = dx / d; nz = dz / d;
        }
        var nb_a = nx * sh - nz * ch;
        var nb_b = nx * ch + nz * sh;
        var vpa = this.u - this.r * b, vpb = this.v + this.r * a;
        var vn = vpa * nb_a + vpb * nb_b;
        var soft = (s.kind === 'boat' || s.kind === 'dock') ? 1 : 1.6;
        var kk = 9.0e5 * soft, cc = 1.1e5;
        var Fmag = kk * pen - cc * vn;
        if (Fmag <= 0) continue;
        var fa = Fmag * nb_a, fb = Fmag * nb_b;
        this.u += fa / mx * dt;
        this.v += fb / my * dt;
        this.r += (a * fb - b * fa) / Iz * dt;
        var ta = -nb_b, tb = nb_a;
        var vt = vpa * ta + vpb * tb;
        var ff = -clamp(vt * 2.2e4, -0.4 * Fmag, 0.4 * Fmag);
        this.u += ff * ta / mx * dt; this.v += ff * tb / my * dt;
        this.r += (a * ff * tb - b * ff * ta) / Iz * dt;
        this.contactNow = Math.max(this.contactNow, pen);
        if (vn < -0.07 && (nowMs() - this.lastHitT > 400)) {
          this.lastHitT = nowMs();
          this.impacts.push({ v: -vn, kind: s.kind });
          if (this.impacts.length > 24) this.impacts.shift();
          this.maxImpact = Math.max(this.maxImpact, -vn);
          this.contacts++;
          this.hitFlag = { kind: s.kind, v: -vn };
        }
      }
    }
  };

  /* Convenience for the renderer: world position and attitude of the hull at
     the current instant, already including heave, pitch and heel. */
  Boat.prototype.transform = function (out) {
    out = out || {};
    out.x = this.x; out.y = this.heaveY - this.squat; out.z = this.z;
    out.heading = this.heading;
    out.rotY = -this.heading;
    out.rotX = this.pitchRad;
    out.rotZ = this.heelRad;
    return out;
  };

  Boat.prototype.bollardPct = function () {
    return (Math.abs(this.thrust[0]) + Math.abs(this.thrust[1])) / (2 * 5400);
  };

  /* ==================== velocity prediction (the polar) ===================
     Runs the identical steady force balance — same strip sums, same residuary
     curve, same lateral lift, same induced drag, same windage, same rig table
     — to convergence with the yaw locked and no waves.  There is no lookup
     table anywhere in this function; that is the whole point.               */
  var polarCache = {};

  function steadyForces(u, v, twaRad, twsMs, reef, furl, sails, poled) {
    var X = -0.5 * RHO * CAL.Cf * SWET * Math.abs(u) * u;
    var Y = -0.5 * RHO * CAL.Cdc * SLAT * Math.abs(v) * v;
    var Fn = Math.abs(u) / Math.sqrt(G * SPEC.lwl);
    var sgnU = u < 0 ? -1 : 1;
    X -= sgnU * CAL.kRes * u * u * residuaryFactor(Fn);
    X -= CAL.kSurgeLin * u / (1 + Math.pow(u / 1.2, 2));
    Y -= CAL.kSwayLin * v;

    var V = Math.hypot(u, v);
    var Ylift = lateralLift(u, v, V);
    Y += Ylift;
    X -= sgnU * inducedDrag(Ylift, V);

    var tu = -twsMs * Math.cos(twaRad), tv = -twsMs * Math.sin(twaRad);
    var au = tu * SHEAR_CE - u, av = tv * SHEAR_CE - v;
    var Vaw = Math.hypot(au, av);
    var awa = Vaw > 1e-4 ? Math.atan2(-av, -au) : 0;
    var heel = 0;
    if (Vaw > 0.05 && sails) {
      var co = rigCoeffs(awa, reef, furl, true, 0, 0, poled);
      var F0 = aeroForces(co, au, av, Vaw, 0);
      heel = heelFor(-F0.Fy * co.lever);
      var F = aeroForces(co, au, av, Vaw, heel);
      X += F.Fx; Y += F.Fy;
    }
    var wg = windage(tu * SHEAR_HULL - u, tv * SHEAR_HULL - v,
                     tu * SHEAR_RIG - u, tv * SHEAR_RIG - v);
    X += wg.X; Y += wg.Y;
    return { X: X, Y: Y, heel: heel, awa: awa };
  }

  function solvePolar(twaDeg, twsKn) {
    var twa = twaDeg * D2R, tws = twsKn / KN;
    var reef = autoReefFor(twsKn), furl = autoFurlFor(twsKn);
    var m = MASS.m;
    var u = Math.max(0.4, tws * 0.35), v = -0.05, heel = 0, awa = 0;
    for (var it = 0; it < 420; it++) {
      var f = steadyForces(u, v, twa, tws, reef, furl, true, false);
      heel = f.heel; awa = f.awa;
      u = clamp(u + clamp(f.X / (m * 1.06) * 0.35, -1.2, 1.2), 0.02, 9.8);
      v = clamp(v + clamp(f.Y / (m * 1.90) * 0.35, -0.6, 0.6), -3, 3);
    }
    return { spd: Math.hypot(u, v) * KN, u: u, v: v,
             leeway: u > 0.05 ? Math.atan2(-v, u) * R2D : 0,
             heelDeg: heel * R2D, awaDeg: awa * R2D, reef: reef, furl: furl };
  }

  function polarFull(twaDeg, twsKn) {
    var a = Math.abs(((twaDeg % 360) + 360) % 360);
    if (a > 180) a = 360 - a;
    var w = clamp(twsKn, 0, 60);
    var key = (Math.round(a / 2.5) * 2.5) + '|' + (Math.round(w * 2) / 2);
    var hit = polarCache[key];
    if (hit) return hit;
    var res = solvePolar(Math.round(a / 2.5) * 2.5, Math.round(w * 2) / 2);
    polarCache[key] = res;
    return res;
  }

  /* ================================ API =================================== */
  SAIL.physics = {
    SPEC: SPEC, RIG: RIG, CAL: CAL, MASS: MASS, HYDRO: HYDRO, PROP: PROP,
    STRIPS: STRIPS, PROBES: PROBES,
    KN: KN, RHO: RHO, RHO_A: RHO_A,

    create: function (opts) { return new Boat(opts); },
    Boat: Boat,

    /* target boat speed in knots for a true wind angle and speed, from the
       same force balance the simulation itself runs */
    polar: function (twaDeg, twsKn) {
      if (!fin(twaDeg) || !fin(twsKn)) return 0;
      return polarFull(twaDeg, twsKn).spd;
    },
    polarDetail: function (twaDeg, twsKn) {
      if (!fin(twaDeg) || !fin(twsKn)) return { spd: 0, leeway: 0, heelDeg: 0 };
      return polarFull(twaDeg, twsKn);
    },
    /* best VMG angles, cached; the HUD draws the laylines from these */
    bestVMG: function (twsKn) {
      var key = 'v' + (Math.round(twsKn * 2) / 2);
      if (polarCache[key]) return polarCache[key];
      var up = { twa: 45, vmg: -1e9, spd: 0 }, dn = { twa: 150, vmg: -1e9, spd: 0 };
      for (var a = 30; a <= 180; a += 2.5) {
        var s = polarFull(a, twsKn).spd;
        var vm = s * Math.cos(a * D2R);
        if (vm > up.vmg) { up.vmg = vm; up.twa = a; up.spd = s; }
        if (-vm > dn.vmg) { dn.vmg = -vm; dn.twa = a; dn.spd = s; }
      }
      var out = { up: up, down: dn, tackAngle: up.twa * 2, gybeAngle: (180 - dn.twa) * 2 };
      polarCache[key] = out;
      return out;
    },
    clearPolarCache: function () { polarCache = {}; },

    /* shared with the sail renderer so both sides use one aerodynamic model */
    aeroCoeffs: function (awaDeg, reef, furl, autoTrim, mainSheet, jibSheet, poled) {
      return rigCoeffs((fin(awaDeg) ? awaDeg : 0) * D2R, reef || 0, furl || 0,
                       autoTrim !== false, fin(mainSheet) ? mainSheet : 0.35,
                       fin(jibSheet) ? jibSheet : 0.35, !!poled);
    },
    sailTable: function (awaDeg) { return rigTable(awaDeg); },
    sailAoA: sailAoA,
    gz: gz, rm: rm, heelFor: heelFor,
    windShear: shear,
    autoReefFor: autoReefFor, autoFurlFor: autoFurlFor
  };
})();
