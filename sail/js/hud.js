/* ============================================================================
   hud.js — SAIL.hud (canvas instruments) and SAIL.audio (WebAudio synthesis)

   HUD
     A restrained B&G/Raymarine-style instrument set drawn to a 2D canvas that
     floats over the WebGL canvas at devicePixelRatio.  Heading tape, wind rose
     with laylines and target angles, speed / SOG / COG / VMG, depth under keel,
     heel, rudder, and a two-sail trim coach (luffing / drawing / stalled and by
     how much).  Everything lives in the outer band of the frame so the view
     down the deck stays clear.

   AUDIO
     Fully synthesized, no samples: rigging wind, hull rush and bow slaps, sail
     luffing (filtered noise-burst train), winch pawls and block creak, two
     Yanmar diesels driven off the rpm array, hull slam, gust rumble and distant
     surf, through a stereo image and a master limiter.

   Both halves share one state normaliser and one trim analyser, so the coach on
   screen and the flutter in your ears always agree.
   ========================================================================== */
(function () {
  'use strict';

  var SAIL = window.SAIL = window.SAIL || {};

  /* ------------------------------------------------------------------ maths */
  var PI = Math.PI, DEG = PI / 180, RAD = 180 / PI, KN = 1.94384;

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
  function wrap180(d) { d = (d + 180) % 360; if (d < 0) d += 360; return d - 180; }
  function wrap360(d) { d = d % 360; return d < 0 ? d + 360 : d; }
  function smooth(a, b, k) { return a + (b - a) * clamp(k, 0, 1); }
  function fmt(v, p) { return (isFinite(v) ? v : 0).toFixed(p == null ? 1 : p); }
  function brg3(b) { b = Math.round(wrap360(b)) % 360; return (b < 10 ? '00' : b < 100 ? '0' : '') + b; }
  function wrapRad(a) { a = (a + PI) % (PI * 2); if (a < 0) a += PI * 2; return a - PI; }
  function rgba(r, g, b, a) { return 'rgba(' + r + ',' + g + ',' + b + ',' + clamp(a, 0, 1).toFixed(3) + ')'; }

  /* --------------------------------------------------------- polar targets */
  /* Leopard 52, calibrated against the tech-director acceptance polars.      */
  var POL_TWS = [6, 12, 20, 30];
  var POL_TWA = [45, 60, 90, 120, 150];
  var POL = [
    [3.4, 4.2, 5.2, 4.6, 3.2],
    [5.9, 6.9, 8.4, 8.0, 5.8],
    [7.4, 8.6, 10.9, 11.4, 9.2],
    [7.6, 9.0, 12.0, 13.5, 11.5]
  ];
  var TGT_UP = [55, 50, 47, 46];
  var TGT_DN = [140, 148, 152, 155];

  function axisIdx(arr, v) {
    var i = 0;
    while (i < arr.length - 2 && v > arr[i + 1]) i++;
    var t = (v - arr[i]) / (arr[i + 1] - arr[i]);
    return { i: i, t: clamp(t, 0, 1) };
  }
  function tableLerp(arr, tws) {
    var a = axisIdx(POL_TWS, tws);
    return lerp(arr[a.i], arr[a.i + 1], a.t);
  }
  function polarSpeed(tws, twa) {
    twa = Math.abs(twa);
    var a = axisIdx(POL_TWS, clamp(tws, 0, 34));
    var row = [], k;
    for (k = 0; k < POL_TWA.length; k++) row[k] = lerp(POL[a.i][k], POL[a.i + 1][k], a.t);
    if (twa <= POL_TWA[0]) return row[0] * clamp((twa - 20) / 25, 0, 1);
    if (twa >= 150) return lerp(row[4], row[4] * 0.82, clamp((twa - 150) / 30, 0, 1));
    var b = axisIdx(POL_TWA, twa);
    return lerp(row[b.i], row[b.i + 1], b.t);
  }

  /* ================================================================= STATE ==
     One normaliser so the HUD and the audio engine never disagree, and so a
     missing field in another module degrades to something sane instead of NaN.
     ======================================================================== */
  var snapCache = { key: null, state: null, S: null, last: 0, wall: 0 };

  function snapshot(state, env, dt) {
    state = state || {};
    env = env || SAIL.env || {};
    var S = { dt: dt, raw: state, env: env };

    /* attitude ---------------------------------------------------------- */
    var hRad = num(state.heading, num(state.h, num(state.hdg, 0) * DEG));
    S.hdgRad = hRad;
    S.hdg = wrap360(hRad * RAD);
    var sh = Math.sin(hRad), chh = Math.cos(hRad);
    S.x = num(state.x, 0); S.z = num(state.z, 0);
    S.u = num(state.u, 0); S.v = num(state.v, 0); S.r = num(state.r, 0);
    S.heelRad = num(state.heelRad, num(state.heel, 0));
    S.heelDeg = S.heelRad * RAD;
    S.pitchDeg = num(state.pitchRad, num(state.pitch, 0)) * RAD;
    if (Math.abs(S.pitchDeg) > 90) S.pitchDeg = num(state.pitch, 0);   // already degrees
    S.pitchRad = S.pitchDeg * DEG;
    S.rudDeg = num(state.rudDeg, num(state.rud, 0));
    S.rudCmd = num(state.rudCmd, S.rudDeg);
    S.rot = num(state.rot, S.r * RAD * 60);

    /* wind vector (world air velocity, m/s, blowing TOWARD +vector) ------ */
    var wx = num(env.windX, NaN), wz = num(env.windZ, NaN);
    if (!isFinite(wx) || !isFinite(wz)) {
      var wd = num(env.windDirDeg, 90) * DEG;
      var wms = num(env.windKn, 12) / KN;
      wx = Math.sin(wd) * wms; wz = -Math.cos(wd) * wms;
    }
    S.tws = Math.hypot(wx, wz) * KN;
    S.twd = wrap360(Math.atan2(-wx, wz) * RAD);            // bearing wind comes FROM
    S.twa = wrap180(S.twd - S.hdg);                         // + = wind from starboard

    /* apparent wind ------------------------------------------------------ */
    var wu = wx * sh - wz * chh, wv = wx * chh + wz * sh;
    var au = wu - S.u, av = wv - S.v;
    var vaw = Math.hypot(au, av);
    var awa = num(state.awaDeg, NaN);
    if (!isFinite(awa)) {
      if (state.aw && isFinite(state.aw.ang)) awa = wrap180(state.aw.ang + 180);
      else awa = Math.atan2(-av, -au) * RAD;
    }
    S.awa = wrap180(awa);
    S.aws = num(state.awsKn, num(state.awsMs, NaN) * KN);
    if (!isFinite(S.aws)) S.aws = (state.aw && isFinite(state.aw.spd)) ? state.aw.spd : vaw * KN;
    S.awsMs = S.aws / KN;
    S.tack = S.awa >= 0 ? 1 : -1;                           // +1 = starboard tack

    /* speeds ------------------------------------------------------------- */
    S.stw = num(state.speedKn, Math.hypot(S.u, S.v) * KN);
    var vx = S.u * sh + S.v * chh + num(env.curX, 0);
    var vz = -S.u * chh + S.v * sh + num(env.curZ, 0);
    S.sog = num(state.sog, Math.hypot(vx, vz) * KN);
    S.cog = num(state.cog, S.sog > 0.05 ? wrap360(Math.atan2(vx, -vz) * RAD) : S.hdg);
    S.leeway = num(state.leewayDeg, Math.atan2(-S.v, Math.max(Math.abs(S.u), 0.05)) * RAD);
    S.set = wrap180(S.cog - S.hdg);

    /* performance -------------------------------------------------------- */
    /* hoisted above the rig block: the polar and no-go tests below need it */
    S.sailsUp = state.sailsUp !== false && state.sailsDown !== true;
    S.vmgWind = S.sog * Math.cos(S.twa * DEG);              // + = gaining upwind
    S.upwind = Math.abs(S.twa) < 90;
    S.vmg = S.upwind ? S.vmgWind : -S.vmgWind;
    S.tgtUp = tableLerp(TGT_UP, clamp(S.tws, 6, 30));
    S.tgtDn = tableLerp(TGT_DN, clamp(S.tws, 6, 30));
    S.tgtAngle = S.upwind ? S.tgtUp : S.tgtDn;
    S.tgtSpeed = polarSpeed(S.tws, S.twa);
    S.perf = S.tgtSpeed > 0.2 ? clamp(S.stw / S.tgtSpeed, 0, 1.6) : 0;
    /* Inside the no-go the polar is meaningless — say so instead of lying.
       The edge sits well inside the target angle: at TWS 12 the target is 50
       deg and 45 is merely pinching, but 38 is genuinely unsailable.       */
    /* meaningless with the sails down — motoring straight into the wind is a
       perfectly good way to get up the channel */
    S.noGo = S.sailsUp && S.tws > 3 && Math.abs(S.twa) < S.tgtUp - 12;
    S.offTarget = Math.abs(S.twa) - S.tgtAngle;
    /* On a reach neither target angle is meaningful; stop nagging the helm. */
    S.reaching = !S.noGo && Math.abs(S.twa) > S.tgtUp + 15 && Math.abs(S.twa) < S.tgtDn - 15;

    /* depth -------------------------------------------------------------- */
    var draft = num(state.draft, 1.70);
    var wd2 = num(state.depth, NaN);
    if (!isFinite(wd2)) {
      var isl = SAIL.island;
      if (isl && typeof isl.depthAt === 'function') {
        var d = isl.depthAt(S.x, S.z);
        if (isFinite(d)) wd2 = d;
      }
    }
    S.depth = isFinite(wd2) ? wd2 : NaN;
    S.underKeel = num(state.underKeel, isFinite(S.depth) ? S.depth - draft : NaN);

    /* rig / engines ------------------------------------------------------ */
    S.reef = Math.round(clamp(num(state.reef, 0), 0, 2));
    S.mainSheet = clamp(num(state.mainSheet, num(state.sheetMain, 0.35)), 0, 1);
    S.jibSheet = clamp(num(state.jibSheet, num(state.sheetJib, 0.35)), 0, 1);
    S.jibFurl = clamp(num(state.jibFurl, num(state.furl, 0)), 0, 1);
    var rpm = state.rpm;
    S.rpm = (rpm && rpm.length >= 2) ? [num(rpm[0], 0), num(rpm[1], 0)] : [0, 0];
    S.gear = (state.gear && state.gear.length >= 2) ? [num(state.gear[0], 0), num(state.gear[1], 0)] : [0, 0];
    S.lever = (state.lever && state.lever.length >= 2) ? [num(state.lever[0], 0), num(state.lever[1], 0)] : [0, 0];
    /* "engines on" has to mean the helm is USING them.  The physics idles both
       diesels at 720 rpm for ever — there is no ignition switch — so an rpm
       test reports ENGINES while you are sailing quietly under canvas, hides
       the rig line behind it and leaves the diesel bed audible all day.     */
    S.engRunning = S.rpm[0] > 400 || S.rpm[1] > 400;
    S.engCmd = Math.abs(S.gear[0]) > 0.01 || Math.abs(S.gear[1]) > 0.01 ||
      Math.abs(S.lever[0]) > 0.02 || Math.abs(S.lever[1]) > 0.02;
    S.enginesOn = state.enginesOn === true || state.engineOn === true || S.engCmd;

    /* hazards ------------------------------------------------------------ */
    S.aground = state.aground === true;
    S.bowIndex = num(state.bowIndex, 0);
    S.rudStall = state.rudStall === true || Math.abs(num(state.rudAlphaDeg, 0)) > 22;
    S.heave = num(state.heaveY, num(state.heave, num(state.y, 0)));

    /* environment -------------------------------------------------------- */
    S.hour = num(env.hourOfDay, 13);
    S.swell = num(env.swellM, 0.8);
    S.gust = num(env.gustScale, num(env.gustFactor, 1));
    S.t = num(env.t, snapCache.wall);
    /* Scene brightness, 0 = night, 1 = tropical noon.  sky.js publishes the
       sky irradiance on the env block; fall back to the solar elevation.   */
    var skyE = num(env.skyE, NaN);
    S.bright = isFinite(skyE) ? clamp(skyE / 5, 0, 1)
      : clamp((num(env.sunDir && env.sunDir.y, 0.7) + 0.09) * 3.4, 0, 1);

    S.trim = analyseTrim(S);
    return S;
  }

  function getSnap(state, env) {
    var wall = (typeof performance !== 'undefined' ? performance.now() : Date.now()) * 0.001;
    snapCache.wall = wall;
    var key = (env && isFinite(env.t)) ? env.t : wall;
    if (snapCache.S && snapCache.key === key && snapCache.state === state) return snapCache.S;
    var dt = num(env && env.dt, clamp(wall - snapCache.last, 1 / 240, 0.25));
    snapCache.last = wall;
    var S = snapshot(state, env, clamp(dt, 1 / 240, 0.25));
    snapCache.key = key; snapCache.state = state; snapCache.S = S;
    return S;
  }

  /* ============================================================ TRIM COACH ==
     Angle of attack is measured from the ZERO-LIFT line; a ~10% camber soft
     sail has alpha_0L = -10 deg, attached flow to alpha_s = 16 deg, optimum at
     ~13 deg.  If the physics module publishes its own per-sail numbers we use
     those instead; otherwise we reconstruct them from the sheet positions with
     exactly the same constants the sail model uses.
     ======================================================================== */
  var DMAX = { main: 80, jib: 35 };
  var A0L = 10, A_OPT = 13, A_STALL = 16;

  function sailInfo(S, key, label, sheet, dmax, area) {
    var src = null;
    if (S.raw.sails) src = S.raw.sails[key];
    if (!src && S.raw[key]) src = S.raw[key];
    /* Trim geometry works off the APPARENT wind — that is what the sail sees.
       Point-of-sail classification works off the TRUE wind, because close
       hauled the apparent angle is ~20 deg and on a dead run it is still ~85,
       so an apparent-angle test would call every beat "in irons".          */
    var awa = Math.abs(S.awa), twa = Math.abs(S.twa);
    var delta = src && isFinite(src.deltaDeg) ? src.deltaDeg : sheet * dmax;
    delta = clamp(delta, 0, dmax);
    var alpha = src && isFinite(src.alphaDeg) ? src.alphaDeg : (awa - delta + A0L);
    /* If the rig model publishes the sheet angle it is trimming to, defer to
       it: two different optima on screen at once is worse than either.      */
    var optDelta = (src && isFinite(src.optDeltaDeg))
      ? clamp(src.optDeltaDeg, 0, dmax)
      : clamp(awa + A0L - A_OPT, 0, dmax);
    var rigNote = key === 'main'
      ? (S.reef > 0 ? 'REEF ' + S.reef : '')
      : (S.jibFurl > 0.02 ? Math.round(S.jibFurl * 100) + '% FURL' : '');
    var o = {
      key: key, label: label, area: area, delta: delta, alpha: alpha,
      optDelta: optDelta, dDelta: delta - optDelta, sheet: sheet,   // dDelta > 0 => too eased
      luff: 0, stall: 0, drive: 0, status: 'DRAW', action: 'HOLD', note: rigNote
    };

    if (!S.sailsUp || area <= 0.01) {
      o.status = 'STOWED'; o.action = ''; o.drive = 0; o.note = ''; return o;
    }
    if (S.aws < 0.6) { o.status = 'CALM'; o.action = ''; return o; }

    if (twa < 24 && S.tws > 2.5) {
      o.status = 'LUFF'; o.luff = 1; o.drive = 0;
      o.action = 'BEAR AWAY'; o.dDelta = 0; o.note = 'IN IRONS';
      return o;
    }
    if (twa > 130) {
      /* Running: the sail is a drag device and alpha is meaningless.       */
      var room = dmax - delta;
      o.status = 'RUN';
      o.drive = clamp(delta / dmax, 0, 1);
      o.luff = clamp((0.55 - delta / dmax) * 1.4, 0, 1) * 0.5;
      o.action = room > 4 ? 'EASE' : 'HOLD';
      o.dDelta = -room;
      if (key === 'jib' && twa > 150) o.note = 'BLANKETED';
      else if (room <= 4) o.note = 'SQUARED OFF';
      return o;
    }

    o.luff = src && isFinite(src.luff) ? clamp(src.luff, 0, 1) : clamp((4 - alpha) / 9, 0, 1);
    o.stall = src && isFinite(src.stall) ? clamp(src.stall, 0, 1) : clamp((alpha - A_STALL) / 9, 0, 1);
    /* When the rig model supplies luff/stall, the drive index has to come off
       THOSE numbers — the internal alpha model is calibrated to a different
       optimum and would read 0 % on a perfectly trimmed sail. */
    o.drive = (src && (isFinite(src.luff) || isFinite(src.stall)))
      ? clamp(1 - o.luff - 0.7 * o.stall, 0, 1)
      : clamp(1 - Math.abs(alpha - A_OPT) / 15, 0, 1) * (1 - 0.7 * o.stall);
    if (o.luff > 0.12) { o.status = 'LUFF'; o.action = 'TRIM'; }
    else if (o.stall > 0.12) { o.status = 'STALL'; o.action = 'EASE'; }
    else { o.status = 'DRAW'; o.action = Math.abs(o.dDelta) > 3 ? (o.dDelta > 0 ? 'TRIM' : 'EASE') : 'HOLD'; }
    /* nothing left on the track — stop telling the helm to do the impossible */
    if (o.action === 'EASE' && delta >= dmax - 0.6) { o.action = 'HOLD'; o.note = 'MAX EASE'; }
    if (o.action === 'TRIM' && delta <= 0.6) { o.action = 'HOLD'; o.note = 'BLOCK TO BLOCK'; }
    return o;
  }

  function analyseTrim(S) {
    var aMain = 99.3 * (S.reef === 1 ? 0.78 : S.reef === 2 ? 0.58 : 1);
    var aJib = 69.0 * (1 - S.jibFurl);
    if (Math.abs(S.twa) > 130) aJib *= 1 - 0.55 * clamp((Math.abs(S.twa) - 130) / 45, 0, 1);
    var main = sailInfo(S, 'main', 'MAIN', S.mainSheet, DMAX.main, S.sailsUp ? aMain : 0);
    var jib = sailInfo(S, 'jib', 'JIB', S.jibSheet, DMAX.jib, S.sailsUp ? aJib : 0);
    return {
      main: main, jib: jib,
      luff: Math.max(main.luff, jib.luff),
      drive: (main.drive * aMain + jib.drive * aJib) / Math.max(aMain + aJib, 1)
    };
  }

  /* ================================================================== HUD ==*/
  /* Tuned against a blown-out tropical sky: the panels have to carry real
     density or the whole instrument set disappears at noon.                */
  var C = {
    ink: '#f2f8fb', dim: '#a9c0cd', faint: 'rgba(200,220,232,0.50)',
    panel: 'rgba(6,12,17,0.62)', panelHi: 'rgba(6,12,17,0.78)',
    edge: 'rgba(190,216,232,0.28)', edgeHi: 'rgba(190,216,232,0.50)',
    data: '#c9ecfb', good: '#63e895', stbd: '#3ddd80', port: '#ff6b6b',
    warn: '#ffbb45', bad: '#ff5555', tape: 'rgba(242,248,251,0.9)'
  };
  var FS = '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif';
  var FM = 'ui-monospace,"SF Mono",Menlo,Consolas,"DejaVu Sans Mono",monospace';
  var CARD = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };

  /* Live palette.  A fixed instrument palette cannot serve both a blown-out
     tropical noon — where the panels need real density or they vanish — and a
     22:00 anchorage, where the same panels read as glowing holes and the ink
     is bright enough to cost you your night vision.  Everything the panels
     and the type use is resolved once a frame from the scene brightness.   */
  var TH = {
    panel: C.panel, panelHi: C.panelHi, edge: C.edge, edgeHi: C.edgeHi,
    halo: 0.55, alpha: 1, band: 0.62
  };
  function theme(S) {
    var b = clamp(num(S.bright, 1), 0, 1);
    TH.panel = rgba(6, 12, 17, lerp(0.76, 0.60, b));
    TH.panelHi = rgba(6, 12, 17, lerp(0.88, 0.78, b));
    TH.edge = rgba(190, 216, 232, lerp(0.38, 0.28, b));
    TH.edgeHi = rgba(190, 216, 232, lerp(0.62, 0.50, b));
    TH.halo = lerp(0.38, 0.70, b);
    TH.alpha = lerp(0.88, 1.0, b);
    TH.band = lerp(0.74, 0.56, b);
  }

  var H = {
    ready: false, visible: true, debug: false,
    cv: null, g: null, dpr: 1, w: 1280, h: 800, s: 1,
    snap: null, lastError: null,
    view: { az: 0, half: 40, halfTan: 0.85, off: 0, ok: false },
    head: { r: 0, p: 0, y: 0, sway: 0, up: 0 },
    notes: [], fps: 60, frames: 0, facc: 0, lastWall: 0,
    /* depth starts NaN so the first frame snaps to the real sounding instead
       of ramping up from 0 and flashing a false shallow alarm on load.     */
    sm: { stw: 0, sog: 0, aws: 0, tws: 0, awa: 0, twa: 0, depth: NaN, heel: 0, rud: 0, vmg: 0, perf: 0, hdg: null },
    _bound: false
  };

  function rr(g, x, y, w, h, r) {
    r = Math.min(r, w * 0.5, h * 0.5);
    g.beginPath();
    g.moveTo(x + r, y);
    g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
    g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
    g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
    g.closePath();
  }
  function panel(g, x, y, w, h, hi) {
    rr(g, x, y, w, h, 6 * H.s);
    g.fillStyle = hi ? TH.panelHi : TH.panel; g.fill();
    g.strokeStyle = hi ? TH.edgeHi : TH.edge; g.lineWidth = 1; g.stroke();
  }
  /* A single 1 px drop shadow disappears the moment type lands on a sunlit
     sail or a white cloud, so type that sits on the scene rather than on a
     panel asks for {strong:true} and gets a four-way dark halo whose weight
     follows the sky.  That is five fillText calls per string, so panel type —
     which already has 60 % black behind it — does not pay for it.         */
  /* Deliberately NOT memoised: ctx.save()/restore() rolls the font back with
     the rest of the state, so a cache of "the font I last asked for" goes
     stale every time a clipped section ends and the next string comes out in
     the wrong family. */
  function setFont(g, f) { g.font = f; }
  function txt(g, s, x, y, size, opt) {
    opt = opt || {};
    setFont(g, (opt.weight || 500) + ' ' + Math.round(size) + 'px ' + (opt.mono ? FM : FS));
    g.textAlign = opt.align || 'left';
    g.textBaseline = opt.base || 'alphabetic';
    if (opt.shadow !== false) {
      var a = opt.halo == null ? TH.halo : opt.halo;
      if (a > 0.02) {
        g.fillStyle = rgba(0, 0, 0, a);
        g.fillText(s, x + 1, y + 1);
        if (opt.strong && a > 0.30) {
          g.fillStyle = rgba(0, 0, 0, a * 0.70);
          g.fillText(s, x - 1, y - 1);
          g.fillText(s, x + 1, y - 1);
        }
      }
    }
    g.fillStyle = opt.color || C.ink;
    g.fillText(s, x, y);
  }
  function label(g, s, x, y) {
    txt(g, s, x, y, 10 * H.s, { color: C.dim, weight: 600, align: 'left' });
  }

  /* ============================================== VIEW-LOCKED SCREEN SPACE ==
     Everything above this line is boat-relative.  The strip along the top of
     the frame is not: its graduations sit over the world they describe, so
     the mark reading 090 really is due east on the horizon behind it, and the
     wind flag really points at the patch of sea the wind is coming from.
     That only works if the mapping is the camera's own, tangent and all.
     ======================================================================== */
  function viewMap(S) {
    var V = H.view, cam = SAIL.camera;
    V.az = S.hdg; V.halfTan = 0.85; V.ok = false;
    if (cam && cam.matrixWorld && cam.matrixWorld.elements) {
      var e = cam.matrixWorld.elements;
      var fx = -e[8], fz = -e[10];               // camera looks down its -Z
      if (Math.hypot(fx, fz) > 1e-4) { V.az = wrap360(Math.atan2(fx, -fz) * RAD); V.ok = true; }
      var fov = clamp(num(cam.fov, 56), 5, 150) * DEG;
      var asp = num(cam.aspect, H.w / Math.max(H.h, 1));
      if (!(asp > 0.05)) asp = 1.6;
      V.halfTan = clamp(Math.tan(fov * 0.5) * asp, 0.05, 20);
    }
    V.half = Math.atan(V.halfTan) * RAD;
    V.off = wrap180(V.az - S.hdg);               // + = looking to starboard
  }
  /* screen x for a world bearing; NaN once it leaves the frame.  The tangent
     stays finite well past the edge of the picture, so the frame test has to
     be on the pixel, not on the angle, or a bearing 50 deg off the shoulder
     lands its label on the wrong side of the screen. */
  function azX(brg) {
    var V = H.view, d = wrap180(brg - V.az);
    if (Math.abs(d) > 86) return NaN;
    var x = H.w * 0.5 * (1 + Math.tan(d * DEG) / V.halfTan);
    return (x < 2 || x > H.w - 2) ? NaN : x;
  }

  /* --------------------------------------------- compass / wind flag strip */
  var TICKS = [[], [], [], [], [], []], TLBL = [];
  function drawStrip(g, y, h, S) {
    var w = H.w, s = H.s, V = H.view, x, b, i;

    var grd = g.createLinearGradient(0, 0, w, 0);
    var a = TH.band;
    grd.addColorStop(0, 'rgba(6,12,17,0)');
    grd.addColorStop(0.09, rgba(6, 12, 17, a));
    grd.addColorStop(0.91, rgba(6, 12, 17, a));
    grd.addColorStop(1, 'rgba(6,12,17,0)');
    g.fillStyle = grd; g.fillRect(0, y, w, h);
    g.fillStyle = TH.edge; g.fillRect(w * 0.07, y + h - 1, w * 0.86, 1);

    /* Ticks are batched into six paths — three distance buckets for the fade,
       major and minor — rather than one stroke each.  Forty-odd separate
       stroke calls a frame is real money on a 2D canvas.                  */
    g.save();
    g.beginPath(); g.rect(0, y - 1, w, h + 2); g.clip();
    var span = Math.min(V.half + 7, 86), bucket = TICKS, labels = TLBL;
    for (i = 0; i < 6; i++) bucket[i].length = 0;
    labels.length = 0;
    for (b = Math.round((V.az - span) / 5) * 5; b <= V.az + span; b += 5) {
      x = azX(b);
      if (!isFinite(x)) continue;
      var bb = wrap360(b), major = (Math.round(bb) % 10) === 0;
      var fade = clamp(1 - Math.abs(wrap180(b - V.az)) / (V.half + 9), 0, 1);
      bucket[(major ? 3 : 0) + Math.min(2, Math.floor(fade * 3))].push(x);
      if (major && (Math.round(bb) % 30) === 0) labels.push(x, bb, fade);
    }
    for (i = 0; i < 6; i++) {
      var list = bucket[i];
      if (!list.length) continue;
      var maj = i >= 3, f3 = (i % 3 + 0.5) / 3;
      g.strokeStyle = rgba(242, 248, 251, (0.30 + 0.62 * f3) * (maj ? 1 : 0.55));
      g.lineWidth = maj ? 1.2 : 1;
      g.beginPath();
      for (var j = 0; j < list.length; j++) {
        var px = Math.round(list[j]) + 0.5;
        g.moveTo(px, y + h - 3 * s);
        g.lineTo(px, y + h - (maj ? 11 : 6) * s);
      }
      g.stroke();
    }
    for (i = 0; i < labels.length; i += 3) {
      var card = CARD[Math.round(labels[i + 1])];
      txt(g, card || brg3(labels[i + 1]), labels[i], y + h - 14 * s, (card ? 12 : 10) * s,
        { align: 'center', weight: card ? 700 : 600, mono: !card, strong: true,
          color: rgba(242, 248, 251, 0.52 + 0.46 * labels[i + 2]) });
    }
    g.restore();

    /* ---- markers hanging below the band -------------------------------- */
    var yTri = y + h + 1, tri = 6.5 * s;
    function caret(px, col, sc) {
      g.fillStyle = col;
      g.beginPath();
      g.moveTo(px, yTri - 1);
      g.lineTo(px - tri * sc, yTri + tri * 1.35 * sc);
      g.lineTo(px + tri * sc, yTri + tri * 1.35 * sc);
      g.closePath(); g.fill();
    }
    function tag(px, text, col) {
      setFont(g, '700 ' + Math.round(12 * s) + 'px ' + FM);
      var tw = g.measureText(text).width + 15 * s;
      var bx = clamp(px - tw / 2, 3 * s, w - tw - 3 * s);
      var by = yTri + 10 * s;
      panel(g, bx, by, tw, 18 * s, true);
      txt(g, text, bx + tw / 2, by + 13 * s, 12 * s,
        { align: 'center', mono: true, weight: 700, color: col });
      return [bx, bx + tw];
    }

    var wcol = S.twa >= 0 ? C.stbd : C.port;
    var xc = azX(S.cog), xb = azX(S.hdg), xw = azX(S.twd);
    if (isFinite(xc) && Math.abs(wrap180(S.cog - S.hdg)) > 1.5) caret(xc, C.good, 0.62);
    if (isFinite(xb)) caret(xb, C.warn, 1.0);
    if (isFinite(xw)) caret(xw, wcol, 1.15);

    /* the wind flag always wins the label row; the bow's heading is repeated
       on the env panel, so dropping it in a collision costs nothing */
    var box = isFinite(xw) ? tag(xw, 'WIND ' + fmt(H.sm.tws, 0) + ' kn', wcol) : null;
    if (isFinite(xb) && (!box || xb < box[0] - 12 * s || xb > box[1] + 12 * s)) {
      txt(g, brg3(S.hdg) + '°', clamp(xb, 22 * s, w - 22 * s), yTri + 23 * s, 12 * s,
        { align: 'center', mono: true, weight: 700, color: C.warn, strong: true });
    }

    /* ---- off the strip: light the edge you have to turn your head toward.
       Both the wind and the bow get one, because in a first-person view with
       a free look those are the only two references that matter and either
       can be behind your shoulder.                                        */
    function edge(brg, col, name, sz, pulse) {
      var d = wrap180(brg - H.view.az), side = d > 0 ? 1 : -1;
      var ex = side > 0 ? w - 30 * s : 30 * s, ey = y + h * 0.55;
      g.save();
      g.globalAlpha = TH.alpha * (pulse ? 0.72 + 0.28 * Math.sin(S.t * 3.4) : 0.80);
      g.fillStyle = col;
      g.beginPath();
      g.moveTo(ex + side * 12 * s * sz, ey);
      g.lineTo(ex - side * 6 * s * sz, ey - 9 * s * sz);
      g.lineTo(ex - side * 6 * s * sz, ey + 9 * s * sz);
      g.closePath(); g.fill();
      g.restore();
      txt(g, name + ' ' + Math.round(Math.abs(d)) + '°', ex - side * 15 * s, ey + 4.5 * s,
        11 * s, { align: side > 0 ? 'right' : 'left', mono: true, weight: 700, color: col, strong: true });
    }
    var sw = wrap180(S.twd - H.view.az) > 0 ? 1 : -1;
    var sb = wrap180(S.hdg - H.view.az) > 0 ? 1 : -1;
    if (!isFinite(xw)) edge(S.twd, wcol, 'WIND', 1, true);
    if (!isFinite(xb) && (isFinite(xw) || sb !== sw)) edge(S.hdg, C.warn, 'BOW', 0.8, false);
  }

  /* The windward screen edge glows faintly whenever the wind has gone out of
     shot: peripheral vision alone then tells you which way it is blowing. */
  function drawWindEdge(g, S) {
    var V = H.view, d = wrap180(S.twd - V.az);
    if (Math.abs(d) <= V.half + 2) return;
    var k = clamp((Math.abs(d) - V.half - 2) / 30, 0, 1) * clamp(S.tws / 7, 0, 1);
    if (k < 0.03) return;
    var side = d > 0 ? 1 : -1, wgt = 48 * H.s;
    var col = S.twa >= 0 ? '61,221,128' : '255,107,107';
    var gr = side > 0 ? g.createLinearGradient(H.w - wgt, 0, H.w, 0)
      : g.createLinearGradient(wgt, 0, 0, 0);
    gr.addColorStop(0, 'rgba(' + col + ',0)');
    gr.addColorStop(1, 'rgba(' + col + ',' + (0.20 * k).toFixed(3) + ')');
    g.fillStyle = gr;
    g.fillRect(side > 0 ? H.w - wgt : 0, 0, wgt, H.h);
  }

  /* ------------------------------------------------------------ wind rose */
  function drawRose(g, cx, cy, R, S) {
    /* backdrop */
    g.beginPath(); g.arc(cx, cy, R, 0, PI * 2);
    g.fillStyle = TH.panel; g.fill();
    g.strokeStyle = TH.edgeHi; g.lineWidth = 1; g.stroke();

    var i, a;
    /* no-go zone and downwind dead zone, centred on the true wind bearing */
    function wedge(centre, half, fill) {
      g.beginPath();
      g.moveTo(cx, cy);
      g.arc(cx, cy, R - 2, (centre - half - 90) * DEG, (centre + half - 90) * DEG);
      g.closePath();
      g.fillStyle = fill; g.fill();
    }
    wedge(H.sm.twa, S.tgtUp, 'rgba(255,80,80,0.10)');
    wedge(H.sm.twa + 180, 180 - S.tgtDn, 'rgba(255,176,46,0.075)');

    /* laylines */
    g.setLineDash([3 * H.s, 3 * H.s]);
    g.lineWidth = 1;
    var lay = [H.sm.twa - S.tgtUp, H.sm.twa + S.tgtUp, H.sm.twa + 180 - S.tgtDn, H.sm.twa - 180 + S.tgtDn];
    for (i = 0; i < 4; i++) {
      a = (lay[i] - 90) * DEG;
      g.strokeStyle = i < 2 ? 'rgba(255,120,120,0.5)' : 'rgba(255,176,46,0.45)';
      g.beginPath(); g.moveTo(cx, cy);
      g.lineTo(cx + Math.cos(a) * (R - 3), cy + Math.sin(a) * (R - 3));
      g.stroke();
    }
    g.setLineDash([]);

    /* graduations, boat-relative, bow up */
    for (i = 0; i < 36; i++) {
      var deg = i * 10;
      a = (deg - 90) * DEG;
      var major = (deg % 30) === 0;
      var r0 = R - (major ? 9 * H.s : 5 * H.s);
      g.strokeStyle = major ? 'rgba(242,248,251,0.80)' : 'rgba(242,248,251,0.42)';
      g.lineWidth = major ? 1.3 : 1;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      g.lineTo(cx + Math.cos(a) * (R - 2), cy + Math.sin(a) * (R - 2));
      g.stroke();
    }
    var rk = clamp(R / (86 * H.s), 0.62, 1) * H.s;
    var lbl = [30, 60, 90, 120, 150];
    for (i = 0; i < lbl.length; i++) {
      for (var sgn = -1; sgn <= 1; sgn += 2) {
        a = (lbl[i] * sgn - 90) * DEG;
        var rl = R - 17 * rk;
        txt(g, String(lbl[i]), cx + Math.cos(a) * rl, cy + Math.sin(a) * rl + 3 * rk,
          9 * rk, { align: 'center', color: C.dim, weight: 600, mono: true });
      }
    }

    /* bow reference */
    g.strokeStyle = 'rgba(233,243,248,0.5)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(cx, cy - R + 2); g.lineTo(cx, cy - R + 11 * H.s); g.stroke();
    g.beginPath(); g.moveTo(cx - 4 * H.s, cy + R * 0.55); g.lineTo(cx, cy + R * 0.42);
    g.lineTo(cx + 4 * H.s, cy + R * 0.55); g.stroke();

    /* true wind needle — hollow */
    function needle(ang, col, filled, len) {
      g.save();
      g.translate(cx, cy); g.rotate(ang * DEG);
      g.beginPath();
      g.moveTo(0, -R + 3);
      g.lineTo(-5.5 * H.s, -R + 15 * H.s);
      g.lineTo(0, -R + 11 * H.s);
      g.lineTo(5.5 * H.s, -R + 15 * H.s);
      g.closePath();
      if (filled) { g.fillStyle = col; g.fill(); }
      else { g.strokeStyle = col; g.lineWidth = 1.4; g.stroke(); }
      g.strokeStyle = col; g.lineWidth = filled ? 2 : 1;
      g.globalAlpha = filled ? 0.9 : 0.5;
      g.beginPath(); g.moveTo(0, -R + 13 * H.s); g.lineTo(0, -R + len); g.stroke();
      g.globalAlpha = 1;
      g.restore();
    }
    needle(H.sm.twa, C.data, false, R * 0.72);
    needle(H.sm.awa, H.sm.awa >= 0 ? C.stbd : C.port, true, R * 0.86);

    /* Centre readout.  Both needles are labelled in words: on a beat the
       apparent angle is 22 deg and the true one 45, and a beginner reading
       the wrong needle sails the boat into irons trying to obey it.       */
    var k = rk;
    txt(g, 'APP ' + (H.sm.awa >= 0 ? 'S' : 'P') + ' ' + Math.round(Math.abs(H.sm.awa)) + '\u00b0',
      cx, cy - 22 * k, 12 * k,
      { align: 'center', mono: true, weight: 700, color: H.sm.awa >= 0 ? C.stbd : C.port });
    txt(g, fmt(H.sm.aws, 1), cx, cy + 2 * k, 26 * k,
      { align: 'center', mono: true, weight: 600, color: C.ink });
    txt(g, 'AWS kn', cx, cy + 13 * k, 9 * k, { align: 'center', color: C.dim, weight: 600 });
    txt(g, 'TRUE ' + (H.sm.twa >= 0 ? 'S' : 'P') + ' ' + Math.round(Math.abs(H.sm.twa)) + '\u00b0',
      cx, cy + 30 * k, 12 * k,
      { align: 'center', mono: true, weight: 700, color: C.data });
  }

  /* Plain-language point of sail \u2014 the single most useful line on the panel
     for someone who has never sailed.  Named off the TRUE angle. */
  function pointOfSail(S) {
    var a = Math.abs(S.twa);
    if (!S.sailsUp) return 'UNDER POWER';
    if (S.tws < 1.5) return 'BECALMED';
    if (S.noGo) return 'IN THE NO-GO';
    if (a <= S.tgtUp + 6) return 'CLOSE HAULED';
    if (a < 80) return 'CLOSE REACH';
    if (a < 105) return 'BEAM REACH';
    if (a < 155) return 'BROAD REACH';
    return 'RUNNING';
  }

  /* True wind angle, target angle and layline advice, tucked under the rose. */
  function drawRoseFoot(g, cx, cy, R, S) {
    /* the foot carries whole words, so it gets a floor on its width and hangs
       off the rose's right edge rather than shrinking with the dial */
    var w = Math.max(R * 2, 158 * H.s), x = cx + R - w;
    var y = cy + R + 5 * H.s, h = 60 * H.s;
    panel(g, x, y, w, h);
    var px = x + 10 * H.s, pw = w - 20 * H.s, g1 = 13.5 * H.s;
    row(g, px, y + 14 * H.s, pw, 'WIND FROM',
      Math.round(Math.abs(H.sm.twa)) + '\u00b0 ' + (H.sm.twa >= 0 ? 'STBD' : 'PORT'),
      H.sm.twa >= 0 ? C.stbd : C.port);
    /* the point of sail gets a centred line of its own — "BROAD REACH" and a
       key label will not both fit across a 170 px panel */
    txt(g, pointOfSail(S), x + w * 0.5, y + 14 * H.s + g1, 12.5 * H.s,
      { align: 'center', weight: 700, color: S.noGo ? C.bad : C.ink });
    if (S.reaching || !S.sailsUp) {
      row(g, px, y + 14 * H.s + g1 * 2, pw, 'POLAR', Math.round(H.sm.perf * 100) + '%',
        H.sm.perf > 0.95 ? C.good : C.data);
      row(g, px, y + 14 * H.s + g1 * 3, pw, 'DRIVE',
        Math.round(S.trim.drive * 100) + '%', S.trim.drive > 0.8 ? C.good : C.data);
      return;
    }
    row(g, px, y + 14 * H.s + g1 * 2, pw,
      'TARGET ' + (S.upwind ? 'UPWIND' : 'DOWNWIND'), Math.round(S.tgtAngle) + '\u00b0');
    var off = S.offTarget;
    var oc = Math.abs(off) < 5 ? C.good : (Math.abs(off) < 12 ? C.data : C.warn);
    if (S.noGo) row(g, px, y + 14 * H.s + g1 * 3, pw, 'STEER', 'BEAR AWAY', C.bad);
    else row(g, px, y + 14 * H.s + g1 * 3, pw, off > 0 ? 'HEAD UP' : 'BEAR AWAY',
      Math.round(Math.abs(off)) + '\u00b0', oc);
  }

  /* ---------------------------------------------------------- data blocks */
  function bigVal(g, x, y, w, v, unit, lab, col, dec) {
    txt(g, lab, x, y, 10 * H.s, { color: C.dim, weight: 700 });
    txt(g, fmt(v, dec == null ? 1 : dec), x, y + 30 * H.s, 34 * H.s,
      { mono: true, weight: 600, color: col || C.ink });
    if (unit) txt(g, unit, x + w - 2, y + 30 * H.s, 11 * H.s,
      { align: 'right', color: C.dim, weight: 600 });
  }
  function row(g, x, y, w, k, v, col) {
    txt(g, k, x, y, 10 * H.s, { color: C.dim, weight: 600 });
    txt(g, v, x + w, y, 13 * H.s, { align: 'right', mono: true, weight: 600, color: col || C.data });
  }

  function drawSpeed(g, x, y, w, h, S) {
    panel(g, x, y, w, h);
    var px = x + 12 * H.s, pw = w - 24 * H.s;
    bigVal(g, px, y + 16 * H.s, pw, H.sm.stw, 'kn', 'BOAT SPEED', C.ink, 2);
    var yy = y + 62 * H.s, gap = 17 * H.s;
    row(g, px, yy, pw, 'SOG', fmt(H.sm.sog, 1) + ' kn');
    row(g, px, yy + gap, pw, 'COG', brg3(S.cog) + '\u00b0');
    var vcol = H.sm.vmg > 0.15 ? C.good : (H.sm.vmg < -0.1 ? C.bad : C.data);
    row(g, px, yy + gap * 2, pw, 'VMG ' + (S.upwind ? 'UP' : 'DN'), fmt(H.sm.vmg, 2) + ' kn', vcol);
    var pc = Math.round(H.sm.perf * 100);
    var pcol = S.noGo ? C.bad : pc >= 96 ? C.good : pc >= 85 ? C.data : C.warn;
    if (!S.sailsUp) row(g, px, yy + gap * 3, pw, 'RIG', 'STOWED', C.dim);
    else if (S.noGo) row(g, px, yy + gap * 3, pw, 'POLAR', 'NO-GO', C.bad);
    else row(g, px, yy + gap * 3, pw, 'TGT ' + fmt(S.tgtSpeed, 1), pc + '%', pcol);

    /* target-speed bar */
    var by = y + h - 10 * H.s, bw = pw;
    g.fillStyle = 'rgba(255,255,255,0.10)';
    g.fillRect(px, by, bw, 3 * H.s);
    if (!S.noGo && S.sailsUp) {
      g.fillStyle = pcol;
      g.fillRect(px, by, bw * clamp(H.sm.perf / 1.1, 0, 1), 3 * H.s);
    }
    g.fillStyle = C.faint;
    g.fillRect(px + bw / 1.1 - 1, by - 2 * H.s, 1.5, 7 * H.s);
  }

  function drawNav(g, x, y, w, h, S) {
    panel(g, x, y, w, h);
    var px = x + 12 * H.s, pw = w - 24 * H.s;
    var uk = H.sm.depth;
    var dcol = !isFinite(uk) ? C.dim : uk < 0.8 ? C.bad : uk < 2.5 ? C.warn : C.ink;
    if (isFinite(uk) && uk < 0.8 && (Math.floor(S.t * 2.5) % 2) === 0) dcol = C.ink;
    bigVal(g, px, y + 16 * H.s, pw, isFinite(uk) ? uk : 0, 'm', 'UNDER KEEL', dcol, 1);
    if (!isFinite(uk)) txt(g, '--', px, y + 46 * H.s, 34 * H.s, { mono: true, color: C.dim });

    var yy = y + 62 * H.s, gap = 17 * H.s;
    var heelSide = (S.aws > 1.5 && Math.abs(S.awa) < 170) ? (S.awa > 0 ? 'P' : 'S')
      : (S.heelRad >= 0 ? 'P' : 'S');
    row(g, px, yy, pw, 'HEEL', fmt(Math.abs(H.sm.heel), 1) + '\u00b0 ' + heelSide,
      Math.abs(H.sm.heel) > 8 ? C.warn : C.data);
    row(g, px, yy + gap, pw, 'LEEWAY', fmt(Math.abs(S.leeway), 1) + '\u00b0');
    row(g, px, yy + gap * 2, pw, 'DEPTH', isFinite(S.depth) ? fmt(S.depth, 1) + ' m' : '--');

    /* rudder bar */
    var by = y + h - 14 * H.s, bw = pw, bx = px, mid = bx + bw / 2;
    txt(g, 'RUD', bx, by - 3 * H.s, 10 * H.s, { color: C.dim, weight: 600 });
    txt(g, Math.round(Math.abs(H.sm.rud)) + '\u00b0 ' + (H.sm.rud >= 0 ? 'S' : 'P'),
      bx + bw, by - 3 * H.s, 10 * H.s,
      { align: 'right', mono: true, weight: 600, color: H.sm.rud >= 0 ? C.stbd : C.port });
    g.fillStyle = 'rgba(255,255,255,0.10)';
    g.fillRect(bx, by, bw, 5 * H.s);
    var frac = clamp(H.sm.rud / 35, -1, 1);
    g.fillStyle = frac >= 0 ? C.stbd : C.port;
    if (frac >= 0) g.fillRect(mid, by, (bw / 2) * frac, 5 * H.s);
    else g.fillRect(mid + (bw / 2) * frac, by, -(bw / 2) * frac, 5 * H.s);
    /* commanded helm as a ghost tick: the blades swing at 30 deg/s, so on a
       hard turn the order and the answer are visibly different things. */
    var fc = clamp(S.rudCmd / 35, -1, 1);
    if (Math.abs(fc - frac) > 0.02) {
      g.fillStyle = 'rgba(255,255,255,0.55)';
      g.fillRect(Math.round(mid + (bw / 2) * fc) - 1, by - 1 * H.s, 2, 7 * H.s);
    }
    g.fillStyle = C.faint;
    g.fillRect(Math.round(mid) - 0.5, by - 2 * H.s, 1, 9 * H.s);
  }

  /* ------------------------------------------------------------ env panel */
  function drawEnv(g, x, y, w, h, S) {
    panel(g, x, y, w, h);
    var px = x + 11 * H.s, pw = w - 22 * H.s, yy = y + 17 * H.s, gap = 16 * H.s;
    var hh = Math.floor(S.hour) % 24, mm = Math.floor((S.hour - Math.floor(S.hour)) * 60);
    /* Heading lives here, not on the strip: the strip's bow caret can be
       squeezed out by the wind flag and the helm must never lose it. */
    row(g, px, yy, pw, 'HEADING', brg3(H.sm.hdg) + '\u00b0', C.ink);
    row(g, px, yy + gap, pw, 'TIME', (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm);
    /* short label: "TRUE WIND" plus the value overran the panel at s < 1 */
    row(g, px, yy + gap * 2, pw, 'WIND', brg3(S.twd) + '\u00b0 ' + fmt(H.sm.tws, 1) + 'kn');
    row(g, px, yy + gap * 3, pw, 'SWELL', fmt(S.swell, 1) + ' m');
    /* rig and engines get a line each: hiding the rig behind an idling
       diesel is how you lose track of being double reefed. */
    var rig = !S.sailsUp ? 'STOWED'
      : (S.reef ? 'REEF ' + S.reef : 'FULL SAIL') +
        (S.jibFurl > 0.03 ? ' ' + Math.round(S.jibFurl * 100) + '%F' : '');
    row(g, px, yy + gap * 4, pw, 'RIG', rig, S.sailsUp ? C.data : C.dim);
    row(g, px, yy + gap * 5, pw, 'ENGINES',
      S.enginesOn ? (Math.round(S.rpm[0]) + '/' + Math.round(S.rpm[1]) + ' rpm') : 'IDLE',
      S.enginesOn ? C.warn : C.dim);
  }

  /* ------------------------------------------------------------ trim coach */
  function drawTrimRow(g, x, y, w, info, S) {
    /* the zone track has to leave room for the widest status and the widest
       order side by side — "LUFF" under "BEAR AWAY" was overprinting */
    var tw = w * 0.40, tx = x + 42 * H.s;
    txt(g, info.label, x, y + 4 * H.s, 11 * H.s, { color: C.dim, weight: 700 });

    /* zone track: alpha -4 .. 26 deg from the zero-lift line */
    var A0 = -4, A1 = 26, span = A1 - A0;
    function ax(a) { return tx + tw * clamp((a - A0) / span, 0, 1); }
    g.fillStyle = 'rgba(255,91,91,0.30)'; g.fillRect(tx, y - 4 * H.s, ax(4) - tx, 8 * H.s);
    g.fillStyle = 'rgba(55,214,122,0.30)'; g.fillRect(ax(4), y - 4 * H.s, ax(A_STALL) - ax(4), 8 * H.s);
    g.fillStyle = 'rgba(255,176,46,0.30)'; g.fillRect(ax(A_STALL), y - 4 * H.s, tx + tw - ax(A_STALL), 8 * H.s);
    g.strokeStyle = C.edge; g.lineWidth = 1;
    g.strokeRect(Math.round(tx) + 0.5, Math.round(y - 4 * H.s) + 0.5, Math.round(tw), Math.round(8 * H.s));
    g.fillStyle = 'rgba(255,255,255,0.55)';
    g.fillRect(Math.round(ax(A_OPT)) - 0.5, y - 6 * H.s, 1, 12 * H.s);

    if (info.status === 'STOWED' || info.status === 'CALM') {
      txt(g, info.status, tx + tw + 10 * H.s, y + 4 * H.s, 11 * H.s,
        { mono: true, weight: 600, color: C.dim });
      return;
    }

    var mx = info.status === 'RUN' ? ax(A_OPT) : ax(info.alpha);
    var mcol = info.status === 'LUFF' ? C.port : info.status === 'STALL' ? C.warn : C.good;
    g.fillStyle = mcol;
    g.beginPath();
    g.moveTo(mx, y - 8 * H.s); g.lineTo(mx - 4 * H.s, y - 14 * H.s); g.lineTo(mx + 4 * H.s, y - 14 * H.s);
    g.closePath(); g.fill();

    var st = info.status;
    txt(g, st, tx + tw + 9 * H.s, y + 4 * H.s, 11 * H.s, { mono: true, weight: 700, color: mcol });
    var act = info.action;
    var dd = Math.round(Math.abs(info.dDelta));
    if (act && act !== 'HOLD' && dd >= 1) act += ' ' + dd + '\u00b0';
    txt(g, act || '', x + w, y + 4 * H.s, 11 * H.s,
      { align: 'right', mono: true, weight: 600, color: act === 'HOLD' ? C.dim : C.ink });
    if (info.note) txt(g, info.note, tx + tw + 9 * H.s, y + 15 * H.s, 9 * H.s,
      { color: C.dim, weight: 600 });
  }

  function drawTrim(g, x, y, w, h, S) {
    panel(g, x, y, w, h);
    var px = x + 12 * H.s, pw = w - 24 * H.s;
    txt(g, 'TRIM', px, y + 14 * H.s, 10 * H.s, { color: C.dim, weight: 700 });
    txt(g, 'DRIVE ' + Math.round(S.trim.drive * 100) + '%', x + w - 12 * H.s, y + 14 * H.s,
      10 * H.s, { align: 'right', color: C.dim, weight: 600, mono: true });
    drawTrimRow(g, px, y + 38 * H.s, pw, S.trim.main, S);
    drawTrimRow(g, px, y + 66 * H.s, pw, S.trim.jib, S);
  }

  /* ------------------------------------------------------------- warnings */
  function warnings(S) {
    var out = [];
    if (S.aground) out.push(['AGROUND', C.bad]);
    else if (isFinite(S.underKeel) && S.underKeel < 0.8) out.push(['SHALLOW WATER', C.bad]);
    else if (isFinite(S.underKeel) && S.underKeel < 2.5) out.push(['DEPTH', C.warn]);
    if (S.bowIndex > 0.55) out.push(['BOWS DOWN - EASE SHEETS', S.bowIndex > 0.85 ? C.bad : C.warn]);
    if (Math.abs(S.heelDeg) > 9) out.push(['HULL FLYING', C.warn]);
    if (S.rudStall) out.push(['RUDDER STALL', C.warn]);
    if (S.sailsUp && S.tws > 19 && S.reef === 0) out.push(['REEF RECOMMENDED', C.warn]);
    if (S.sailsUp && Math.abs(S.twa) < 30 && S.stw < 2.5) out.push(['IN IRONS', C.warn]);
    return out;
  }

  function drawWarnings(g, cx, y, S) {
    var list = warnings(S), i;
    var pulse = 0.62 + 0.38 * Math.sin(S.t * 6);
    for (i = 0; i < list.length && i < 4; i++) {
      var col = list[i][1];
      g.save();
      g.globalAlpha = col === C.bad ? pulse : 0.92;
      var s = list[i][0];
      setFont(g, '700 ' + Math.round(13 * H.s) + 'px ' + FS);
      var wdt = g.measureText(s).width + 22 * H.s;
      panel(g, cx - wdt / 2, y + i * 24 * H.s, wdt, 20 * H.s, true);
      txt(g, s, cx, y + i * 24 * H.s + 14 * H.s, 13 * H.s,
        { align: 'center', weight: 700, color: col });
      g.restore();
    }
    return list.length;
  }

  function drawNotes(g, cx, y, S) {
    var i, n;
    /* resolve the expiry on first sight — notify() can be called before the
       first frame, when the simulation clock is not yet known.             */
    for (i = 0; i < H.notes.length; i++)
      if (H.notes[i].until == null) H.notes[i].until = S.t + H.notes[i].dur;
    for (i = H.notes.length - 1; i >= 0; i--) if (H.notes[i].until < S.t) H.notes.splice(i, 1);
    for (i = 0; i < H.notes.length && i < 4; i++) {
      n = H.notes[i];
      var a = clamp((n.until - S.t) / 0.5, 0, 1);
      g.save(); g.globalAlpha = a;
      setFont(g, '600 ' + Math.round(14 * H.s) + 'px ' + FS);
      var wdt = g.measureText(n.text).width + 26 * H.s;
      panel(g, cx - wdt / 2, y + i * 26 * H.s, wdt, 22 * H.s, true);
      txt(g, n.text, cx, y + i * 26 * H.s + 15 * H.s, 14 * H.s,
        { align: 'center', weight: 600, color: n.color || C.ink });
      g.restore();
    }
  }

  /* ============================================ FIRST-PERSON HEAD MOTION ==
     app.js bolts the eye rigidly to the boat.  A real head does not do that:
     it lags the hull by a fraction of a second and it gets thrown about by
     the accelerations, and without that the cockpit view reads as a camera on
     a stick.  The whole rig is expressed as the DIFFERENCE between the hull's
     attitude now and a first-order lagged copy of it, so it is exactly zero
     in steady sailing — the deterministic SAIL.shot() framings are untouched
     — and only appears when the boat is actually moving under you.

     Runs after app.js has placed the camera and before post.render, which is
     where SAIL.hud.update() sits in the frame order.  Rotation only plus a
     few centimetres of sway: ocean.js consumes the camera position (for the
     disc centre) and nothing else, so neither is enough to disturb it.
     ======================================================================== */
  var HEAD = {
    on: true, init: false, heel: 0, pitch: 0, hdg: 0,
    u: 0, v: 0, ax: 0, ay: 0, hv: 0, hr: 0, az: 0
  };
  var QQ = null;
  var LOOK = { on: false, yaw: 0, pitch: 0 };

  function qAlloc() {
    var T = window.THREE;
    if (QQ) return true;
    if (!T || !T.Quaternion || !T.Euler) return false;
    QQ = { e: new T.Euler(0, 0, 0, 'YXZ'), a: new T.Quaternion(), b: new T.Quaternion(), c: new T.Quaternion() };
    return true;
  }

  /* eased look-snaps (bow / windward).  Cancelled the instant the helm
     grabs the mouse, so it can never fight a manual look. */
  function lookTo(yaw, pitch, what) {
    var rig = SAIL.app && SAIL.app.cam;
    if (!rig || rig.external || rig.free) return false;
    LOOK.yaw = rig.yaw + wrapRad(yaw - rig.yaw);
    LOOK.pitch = clamp(pitch, -1.1, 1.0);
    LOOK.on = true;
    if (what) hudApi.notify(what, 1.1);
    return true;
  }
  function stepLook(rig, dt) {
    if (!LOOK.on) return;
    if (rig.external || rig.free) { LOOK.on = false; return; }
    var k = clamp(dt * 8, 0, 1);
    rig.yaw += (LOOK.yaw - rig.yaw) * k;
    rig.pitch += (LOOK.pitch - rig.pitch) * k;
    if (Math.abs(LOOK.yaw - rig.yaw) < 0.003 && Math.abs(LOOK.pitch - rig.pitch) < 0.003) {
      rig.yaw = LOOK.yaw; rig.pitch = LOOK.pitch; LOOK.on = false;
    }
  }

  function headRig(S, dt) {
    var app = SAIL.app, cam = SAIL.camera;
    if (!app || !cam || !app.cam || !cam.quaternion) return;
    var rig = app.cam;
    stepLook(rig, dt);
    if (!HEAD.on || rig.free || rig.external) { HEAD.init = false; return; }
    if (SAIL.headRig && SAIL.headRig !== 'hud') return;   // another module owns it
    SAIL.headRig = 'hud';
    if (!qAlloc()) return;

    /* The hull attitude is the input; the head is a low-passed copy of it and
       what you see is the DIFFERENCE, which is a high-pass — it is zero the
       moment the boat stops changing attitude.  A 20 t catamaran in 0.8 m of
       swell rolls through less than a degree, so the raw difference is a
       tenth of that and invisible; the gains here exaggerate it back to the
       couple of degrees a body actually feels, and the clamps stop a broach
       or a gybe from throwing the view off the boat.                      */
    var k = clamp(dt / 0.40, 0, 1);
    if (!HEAD.init) {
      HEAD.heel = S.heelRad; HEAD.pitch = S.pitchRad; HEAD.hdg = S.hdgRad;
      HEAD.u = S.u; HEAD.v = S.v; HEAD.ax = 0; HEAD.ay = 0;
      HEAD.hv = S.heave; HEAD.hr = 0; HEAD.az = 0; HEAD.init = true;
    }
    HEAD.heel += (S.heelRad - HEAD.heel) * k;
    HEAD.pitch += (S.pitchRad - HEAD.pitch) * k;
    HEAD.hdg += wrapRad(S.hdgRad - HEAD.hdg) * k;

    var mode = rig.mode === 'masthead' ? 1.25 : 1.0;
    var dR = clamp((S.heelRad - HEAD.heel) * 2.00 * mode, -0.070, 0.070);
    var dP = clamp((S.pitchRad - HEAD.pitch) * 1.80 * mode, -0.055, 0.055);
    var dY = clamp(wrapRad(S.hdgRad - HEAD.hdg) * 0.90, -0.035, 0.035);

    var inv = 1 / Math.max(dt, 1e-3), ka = clamp(dt / 0.10, 0, 1);
    var ax = (S.u - HEAD.u) * inv - S.v * S.r;      // body-frame surge / sway
    var ay = (S.v - HEAD.v) * inv + S.u * S.r;
    HEAD.u = S.u; HEAD.v = S.v;
    if (isFinite(ax)) HEAD.ax += (clamp(ax, -6, 6) - HEAD.ax) * ka;
    if (isFinite(ay)) HEAD.ay += (clamp(ay, -6, 6) - HEAD.ay) * ka;
    var oFwd = clamp(-HEAD.ax * 0.050, -0.14, 0.14);
    var oStb = clamp(-HEAD.ay * 0.050, -0.14, 0.14);

    /* knees take the heave: the eye rises a little less than the deck does */
    var hr = (S.heave - HEAD.hv) * inv;
    HEAD.hv = S.heave;
    if (isFinite(hr)) {
      var ha = (hr - HEAD.hr) * inv;
      HEAD.hr = hr;
      if (isFinite(ha)) HEAD.az += (clamp(ha, -9, 9) - HEAD.az) * ka;
    }
    var oUp = clamp(-HEAD.az * 0.014, -0.075, 0.075);

    /* the camera is qBoat * qLook, so the lag correction has to be inserted
       between them: q' = q * qLook^-1 * dq * qLook.  Applied in the camera's
       own frame it would turn hull pitch into view roll whenever you looked
       abeam, which is the one thing guaranteed to make people ill.        */
    QQ.e.set(rig.pitch, rig.yaw, 0, 'YXZ');
    QQ.a.setFromEuler(QQ.e);
    QQ.b.copy(QQ.a).invert();
    QQ.e.set(-dP, dY, -dR, 'YXZ');
    QQ.c.setFromEuler(QQ.e);
    cam.quaternion.multiply(QQ.b).multiply(QQ.c).multiply(QQ.a);

    var sh = Math.sin(S.hdgRad), ch = Math.cos(S.hdgRad);
    cam.position.x += oFwd * sh + oStb * ch;
    cam.position.z += -oFwd * ch + oStb * sh;
    cam.position.y += oUp;
    H.head.r = dR * RAD; H.head.p = dP * RAD; H.head.y = dY * RAD;
    H.head.sway = oStb; H.head.up = oUp;
    cam.updateMatrixWorld(true);
    if (cam.matrixWorldInverse && cam.matrixWorldInverse.copy)
      cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
  }

  /* ------------------------------------------------------------ HUD frame */
  function smoothAll(S, dt) {
    var k = clamp(dt * 9, 0, 1), kf = clamp(dt * 16, 0, 1), m = H.sm;
    m.stw = smooth(m.stw, S.stw, k);
    m.sog = smooth(m.sog, S.sog, k);
    m.aws = smooth(m.aws, S.aws, k);
    m.tws = smooth(m.tws, S.tws, k * 0.5);
    m.depth = smooth(isFinite(m.depth) ? m.depth : S.underKeel, S.underKeel, k);
    m.heel = smooth(m.heel, S.heelDeg, kf);
    m.rud = smooth(m.rud, S.rudDeg, kf);
    m.vmg = smooth(m.vmg, S.vmg, k);
    m.perf = smooth(m.perf, S.perf, k * 0.6);
    if (m.hdg == null) m.hdg = S.hdg;
    m.hdg = wrap360(m.hdg + wrap180(S.hdg - m.hdg) * clamp(dt * 14, 0, 1));
    m.awa = m.awa + wrap180(S.awa - m.awa) * clamp(dt * 7, 0, 1);
    m.twa = m.twa + wrap180(S.twa - m.twa) * clamp(dt * 4, 0, 1);
    m.awa = wrap180(m.awa); m.twa = wrap180(m.twa);
  }

  function render(S) {
    var g = H.g, w = H.w, h = H.h, s = H.s;
    g.setTransform(H.dpr, 0, 0, H.dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    if (!H.visible) return;
    theme(S);
    viewMap(S);
    g.globalAlpha = TH.alpha;
    g.lineJoin = 'round';

    var M = Math.round(16 * s);
    var TOP = Math.round(66 * s);

    /* view-locked compass and wind flag along the very top of the frame */
    drawWindEdge(g, S);
    drawStrip(g, Math.round(6 * s), Math.round(26 * s), S);

    /* wind rose, top right */
    /* the rose must not shrink below the point where its own centre readout
       stops fitting — on a phone in portrait it is the wind display that has
       to survive, not the margin */
    var R = Math.round(clamp(Math.min(86 * s, w * 0.145), 44, 96));
    var rcx = w - M - R - 4 * s, rcy = TOP + R + 6 * s;
    drawRose(g, rcx, rcy, R, S);
    drawRoseFoot(g, rcx, rcy, R, S);

    /* env, top left */
    drawEnv(g, M, TOP, Math.round(186 * s), Math.round(116 * s), S);

    /* speed, bottom left */
    var bh = Math.round(140 * s), bw = Math.round(196 * s);
    drawSpeed(g, M, h - M - bh, bw, bh, S);

    /* nav, bottom right */
    drawNav(g, w - M - bw, h - M - bh, bw, bh, S);

    /* trim coach, bottom centre */
    var cw = Math.min(Math.round(340 * s), w - 2 * (bw + M * 2));
    if (cw > 200 * s) drawTrim(g, Math.round(w / 2 - cw / 2), h - M - Math.round(88 * s), cw, Math.round(88 * s), S);

    /* alerts */
    var nWarn = drawWarnings(g, w / 2, Math.round(h * 0.30), S);
    drawNotes(g, w / 2, Math.round(h * 0.30) + nWarn * 24 * s + (nWarn ? 8 * s : 0), S);

    /* audio hint / debug */
    if (A.ctx && A.ctx.state === 'suspended') {
      txt(g, 'CLICK TO ENABLE SOUND', w / 2, h - M - Math.round(96 * s), 10 * s,
        { align: 'center', color: C.dim, weight: 600, strong: true });
    } else if (A.muted) {
      txt(g, 'AUDIO MUTED  (M)', w / 2, h - M - Math.round(96 * s), 10 * s,
        { align: 'center', color: C.dim, weight: 600, strong: true });
    }
    if (H.debug) {
      var calls = 0, tris = 0;
      if (SAIL.renderer && SAIL.renderer.info) {
        calls = SAIL.renderer.info.render.calls;
        tris = SAIL.renderer.info.render.triangles;
      }
      txt(g, Math.round(H.fps) + ' fps  ' + calls + ' calls  ' + (tris / 1000).toFixed(0) + 'k tri  ' +
        (SAIL.quality || '?') + '  lee ' + fmt(S.leeway, 1) + '\u00b0  bow ' + fmt(S.bowIndex, 2) +
        '  head ' + fmt(H.head.r, 1) + '/' + fmt(H.head.p, 1) + '/' + fmt(H.head.y, 1) + '\u00b0' +
        '  view ' + fmt(H.view.off, 0) + '\u00b0  sky ' + fmt(S.bright, 2),
        M, h - M - Math.round(150 * s), 10 * s, { mono: true, color: C.dim, weight: 500 });
    }
  }

  /* --------------------------------------------------------------- public */
  function hudSetSize(w, h) {
    if (!H.cv) return;
    H.w = w || window.innerWidth || 1280;
    H.h = h || window.innerHeight || 800;
    H.dpr = clamp(window.devicePixelRatio || 1, 1, 2.5);
    if (SAIL.quality === 'low') H.dpr = Math.min(H.dpr, 1.5);
    H.cv.width = Math.round(H.w * H.dpr);
    H.cv.height = Math.round(H.h * H.dpr);
    H.cv.style.width = H.w + 'px';
    H.cv.style.height = H.h + 'px';
    H.s = clamp(Math.min(H.w / 1280, H.h / 800), 0.72, 1.5);
    H.g = H.cv.getContext('2d');
    if (H.g) { H.g.textBaseline = 'alphabetic'; H.g.miterLimit = 2; }
  }

  var hudApi = {
    build: function () {
      if (H.ready) return hudApi;
      if (typeof document === 'undefined' || !document.body) return hudApi;
      var cv = document.createElement('canvas');
      cv.id = 'sail-hud';
      cv.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;' +
        'pointer-events:none;z-index:40;display:block;';
      document.body.appendChild(cv);
      H.cv = cv;
      hudSetSize(window.innerWidth, window.innerHeight);
      if (!H._bound) {
        H._bound = true;
        window.addEventListener('resize', function () {
          hudSetSize(window.innerWidth, window.innerHeight);
          /* reallocating the backing store clears it — repaint the last frame
             immediately so the instruments never blink out on a resize.    */
          if (H.snap) { try { render(H.snap); } catch (e) { H.lastError = e; } }
        });
        window.addEventListener('keydown', function (e) {
          if (e.altKey || e.ctrlKey || e.metaKey || e.repeat) return;
          var k = (e.key || '').toLowerCase();
          if (k === 'h') { H.visible = !H.visible; }
          else if (k === 'm') { audioApi.toggleMute(); }
          else if (k === 'f' && e.shiftKey) { H.debug = !H.debug; }
          else if (k === 'q') { lookTo(0, -0.03, 'LOOK AHEAD'); }
          else if (k === 'e') {
            var S = H.snap;
            if (S) lookTo(-S.twa * DEG, 0.02, 'LOOK TO WINDWARD');
          }
        });
        /* any manual look cancels an eased snap immediately */
        window.addEventListener('pointerdown', function () { LOOK.on = false; }, true);
      }
      H.ready = true;
      hudApi.notify('LEOPARD 52  \u2022  ST GEORGE\'S, GRENADA', 4.5);
      hudApi.notify('Q LOOK AHEAD   E LOOK TO WINDWARD', 6.0, C.dim);
      return hudApi;
    },
    update: function (state, env) {
      if (!H.ready || !H.g) return;
      var S = getSnap(state, env);
      H.snap = S;
      /* fps must come off the wall clock: env.dt is the simulation step and
         would read a constant 60 for any fixed-step caller.                */
      var wall = snapCache.wall;
      if (H.lastWall) H.facc += clamp(wall - H.lastWall, 0, 0.5);
      H.lastWall = wall;
      H.frames++;
      if (H.facc > 0.4) { H.fps = H.frames / H.facc; H.facc = 0; H.frames = 0; }
      smoothAll(S, S.dt);
      /* the head rig moves the camera, so it has to run whether or not the
         instruments are drawn — and never take the frame down either */
      try { headRig(S, S.dt); } catch (err) { H.lastError = err; }
      try { render(S); } catch (err) { H.lastError = err; }
    },
    /* let other modules point the view without reaching into app.js */
    lookAhead: function () { return lookTo(0, -0.03); },
    lookWindward: function () { return H.snap ? lookTo(-H.snap.twa * DEG, 0.02) : false; },
    setHeadMotion: function (v) { HEAD.on = v !== false; },
    setSize: function (w, h) { hudSetSize(w, h); },
    notify: function (text, dur, color) {
      text = String(text);
      /* repeating a live message re-arms it instead of stacking a second
         copy: SAIL.shot() calls setCam() twice and printed CAM HELM twice */
      for (var i = 0; i < H.notes.length; i++) {
        if (H.notes[i].text === text) {
          H.notes[i].dur = num(dur, 3); H.notes[i].until = null;
          H.notes[i].color = color; return;
        }
      }
      H.notes.push({ text: text, dur: num(dur, 3), until: null, color: color });
      if (H.notes.length > 6) H.notes.shift();
    },
    setVisible: function (v) { H.visible = !!v; },
    toggle: function () { H.visible = !H.visible; },
    get visible() { return H.visible; },
    state: H
  };
  SAIL.hud = hudApi;

  /* ================================================================ AUDIO ==
     Everything below is synthesized: no buffers are loaded, only generated.
     ======================================================================== */
  var A = {
    ctx: null, ready: false, muted: false, vol: 0.85, lastError: null,
    master: null, limiter: null, bus: {}, white: null, pink: null,
    wind: [], water: [], surf: null, rumble: null, eng: [],
    clock: 0, luffT: 0, slapT: 0, halyT: 0, creakT: 0, alarmT: 0,
    prev: { mainSheet: 0, jibSheet: 0, heaveRate: 0, heave: 0, slamCd: 0, shoreT: 0 },
    shore: { gain: 0, pan: 0 }, winchAcc: 0, started: false
  };

  function ac() { return A.ctx; }
  function now() { return A.ctx.currentTime; }

  function makeNoise(sec, pink) {
    var n = Math.floor(A.ctx.sampleRate * sec);
    var b = A.ctx.createBuffer(1, n, A.ctx.sampleRate), d = b.getChannelData(0), i;
    if (pink) {
      var b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (i = 0; i < n; i++) {
        var w = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.96900 * b2 + w * 0.1538520;
        b3 = 0.86650 * b3 + w * 0.3104856;
        b4 = 0.55000 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.0168980;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      }
    } else {
      for (i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    }
    /* taper the loop seam so the join is inaudible even on tonal filtering */
    var fade = Math.min(600, Math.floor(n * 0.01));
    for (i = 0; i < fade; i++) {
      var t = i / fade;
      d[i] = d[i] * t + d[n - fade + i] * (1 - t);
    }
    return b;
  }

  function panner(p) {
    if (A.ctx.createStereoPanner) {
      var sp = A.ctx.createStereoPanner();
      sp.pan.value = clamp(p, -1, 1);
      return sp;
    }
    var g = A.ctx.createGain();
    g.pan = { value: p, setTargetAtTime: function () { } };
    return g;
  }
  function setPan(node, p) {
    if (node && node.pan && typeof node.pan.setTargetAtTime === 'function' && node.pan.cancelScheduledValues)
      node.pan.setTargetAtTime(clamp(p, -1, 1), now(), 0.15);
    else if (node && node.pan) node.pan.value = clamp(p, -1, 1);
  }
  function gain(v, dest) {
    var g = A.ctx.createGain();
    g.gain.value = v || 0;
    if (dest) g.connect(dest);
    return g;
  }
  function filt(type, f, q, dest) {
    var b = A.ctx.createBiquadFilter();
    b.type = type; b.frequency.value = f;
    if (q != null) b.Q.value = q;
    if (dest) b.connect(dest);
    return b;
  }
  function loopSrc(buf, dest) {
    var s = A.ctx.createBufferSource();
    s.buffer = buf; s.loop = true;
    if (dest) s.connect(dest);
    try { s.start(0, Math.random() * buf.duration); } catch (e) { s.start(0); }
    return s;
  }
  function ramp(param, v, tau) {
    if (!param) return;
    if (!isFinite(v)) return;
    if (param.setTargetAtTime) param.setTargetAtTime(v, now(), Math.max(0.005, tau || 0.12));
    else param.value = v;
  }

  /* one-shot noise burst -------------------------------------------------- */
  function burst(o) {
    if (!A.ready || A.muted) return;
    var t = now() + 0.005;
    var dur = o.dur || 0.12, g0 = (o.gain || 0.1) * A.vol;
    if (g0 < 0.0006) return;
    var src = A.ctx.createBufferSource();
    src.buffer = o.pinkSrc ? A.pink : A.white;
    src.loop = true;
    var node = src;
    if (o.type) {
      var f = filt(o.type, o.f || 800, o.q == null ? 1 : o.q);
      node.connect(f); node = f;
      if (o.fEnd && f.frequency.exponentialRampToValueAtTime) {
        f.frequency.setValueAtTime(Math.max(20, o.f), t);
        f.frequency.exponentialRampToValueAtTime(Math.max(20, o.fEnd), t + dur);
      }
    }
    var g = gain(0);
    node.connect(g);
    var p = panner(o.pan || 0);
    g.connect(p); p.connect(A.bus.sfx);
    var atk = o.attack || 0.004;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(g0, t + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    try { src.start(t, Math.random() * 3); } catch (e) { src.start(t); }
    src.stop(t + dur + 0.05);
  }

  /* one-shot tonal ping (metal, pawl, creak) ------------------------------ */
  function ping(o) {
    if (!A.ready || A.muted) return;
    var t = now() + 0.005;
    var dur = o.dur || 0.12, g0 = (o.gain || 0.05) * A.vol;
    if (g0 < 0.0006) return;
    var osc = A.ctx.createOscillator();
    osc.type = o.wave || 'sine';
    osc.frequency.setValueAtTime(o.f, t);
    if (o.fEnd && osc.frequency.exponentialRampToValueAtTime)
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.fEnd), t + dur);
    var g = gain(0);
    osc.connect(g);
    var p = panner(o.pan || 0);
    g.connect(p); p.connect(A.bus.sfx);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(g0, t + (o.attack || 0.002));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  /* diesel voice ---------------------------------------------------------- */
  function dieselWave() {
    var n = 18, re = new Float32Array(n), im = new Float32Array(n), i;
    for (i = 1; i < n; i++) {
      var amp = 1 / Math.pow(i, 0.92);
      if (i === 2) amp *= 1.5;
      if (i === 4) amp *= 1.25;
      if (i === 3) amp *= 0.7;
      im[i] = amp * (0.65 + 0.35 * Math.sin(i * 2.4));
      re[i] = amp * 0.25 * Math.cos(i * 1.7);
    }
    return A.ctx.createPeriodicWave(re, im, { disableNormalization: false });
  }

  function makeDiesel(pan, wave) {
    var out = gain(0);
    var p = panner(pan);
    out.connect(p); p.connect(A.bus.eng);

    var lp = filt('lowpass', 380, 0.9, out);
    var osc = A.ctx.createOscillator();
    osc.setPeriodicWave(wave);
    osc.frequency.value = 24;
    var og = gain(0.75, lp);
    osc.connect(og);
    osc.start();

    var sub = A.ctx.createOscillator();
    sub.type = 'sine'; sub.frequency.value = 12;
    var sg = gain(0.4, out);
    sub.connect(sg);
    sub.start();

    var nz = filt('bandpass', 900, 0.7, null);
    var ng = gain(0, out);
    nz.connect(ng);
    var nsrc = loopSrc(A.white, nz);

    return {
      out: out, pan: p, osc: osc, sub: sub, lp: lp, ng: ng, sg: sg, nsrc: nsrc, og: og,
      set: function (rpm, load, on) {
        var f = Math.max(6, rpm / 60 * 2);      // 4-cyl 4-stroke firing frequency
        ramp(osc.frequency, f, 0.10);
        ramp(sub.frequency, f * 0.5, 0.10);
        ramp(lp.frequency, 240 + load * 900 + rpm * 0.22, 0.15);
        var lvl = on ? clamp(0.05 + 0.20 * load + rpm / 3000 * 0.16, 0, 0.42) : 0;
        ramp(out.gain, lvl, on ? 0.18 : 0.35);
        ramp(ng.gain, on ? 0.05 + 0.16 * load : 0, 0.2);
        ramp(nz.frequency, 700 + rpm * 0.35, 0.2);
        ramp(sg.gain, on ? 0.30 + 0.25 * load : 0, 0.2);
      }
    };
  }

  /* wind / water continuous layers ---------------------------------------- */
  function makeWindSide(pan, src) {
    var p = panner(pan);
    p.connect(A.bus.wind);
    var low = filt('lowpass', 220, 0.7), gl = gain(0, p);
    var mid = filt('bandpass', 620, 1.0), gm = gain(0, p);
    var whi = filt('bandpass', 1500, 7.5), gw = gain(0, p);
    var hum = filt('bandpass', 330, 15), gh = gain(0, p);
    low.connect(gl); mid.connect(gm); whi.connect(gw); hum.connect(gh);
    src.connect(low); src.connect(mid); src.connect(whi); src.connect(hum);
    return { p: p, low: low, gl: gl, mid: mid, gm: gm, whi: whi, gw: gw, hum: hum, gh: gh };
  }
  function makeWaterSide(pan, src) {
    var p = panner(pan);
    p.connect(A.bus.water);
    var rush = filt('bandpass', 300, 0.55), gr = gain(0, p);
    var hiss = filt('highpass', 2000, 0.7), gh = gain(0, p);
    var gurg = filt('lowpass', 260, 1.1), gg = gain(0, p);
    rush.connect(gr); hiss.connect(gh); gurg.connect(gg);
    src.connect(rush); src.connect(hiss); src.connect(gurg);
    return { p: p, rush: rush, gr: gr, hiss: hiss, gh: gh, gurg: gurg, gg: gg };
  }

  function buildGraph() {
    var ctx = A.ctx;
    A.white = makeNoise(6.0, false);
    A.pink = makeNoise(6.0, true);

    A.limiter = ctx.createDynamicsCompressor();
    A.limiter.threshold.value = -8;
    A.limiter.knee.value = 3;
    A.limiter.ratio.value = 18;
    A.limiter.attack.value = 0.002;
    A.limiter.release.value = 0.18;
    A.master = gain(A.vol, A.limiter);
    A.limiter.connect(ctx.destination);

    A.bus.wind = gain(0.9, A.master);
    A.bus.water = gain(0.9, A.master);
    A.bus.sfx = gain(0.9, A.master);
    A.bus.eng = gain(0.9, A.master);
    A.bus.amb = gain(0.9, A.master);

    var nA = loopSrc(A.white), nB = loopSrc(A.white);
    var pA = loopSrc(A.pink), pB = loopSrc(A.pink);
    A.wind = [makeWindSide(-0.65, nA), makeWindSide(0.65, nB)];
    A.wind[0].lowSrc = pA; pA.connect(A.wind[0].low);
    A.wind[1].lowSrc = pB; pB.connect(A.wind[1].low);
    A.windSrc = [nA, nB, pA, pB];

    var wA = loopSrc(A.pink), wB = loopSrc(A.pink);
    A.water = [makeWaterSide(-0.5, wA), makeWaterSide(0.5, wB)];
    A.waterSrc = [wA, wB];

    /* distant surf: band-limited noise with a slow set modulation */
    var sp = panner(0);
    sp.connect(A.bus.amb);
    var sf = filt('bandpass', 480, 0.5);
    var sg2 = gain(0, sp);
    sf.connect(sg2);
    loopSrc(A.pink, sf);
    var lfo = ctx.createOscillator();
    lfo.type = 'sine'; lfo.frequency.value = 0.085;
    var lfoG = gain(0.5);
    lfo.connect(lfoG); lfoG.connect(sg2.gain);
    lfo.start();
    A.surf = { g: sg2, f: sf, p: sp, lfoG: lfoG };

    /* gust rumble */
    var rp = panner(0); rp.connect(A.bus.amb);
    var rf = filt('lowpass', 95, 0.9);
    var rg = gain(0, rp);
    rf.connect(rg);
    loopSrc(A.pink, rf);
    A.rumble = { g: rg, f: rf };

    /* block creak bed — driven only while sheets are loaded and moving */
    var cp = panner(0.2); cp.connect(A.bus.sfx);
    var cf = filt('bandpass', 340, 6);
    var cg = gain(0, cp);
    cf.connect(cg);
    loopSrc(A.pink, cf);
    A.creak = { g: cg, f: cf };

    var wave = dieselWave();
    A.eng = [makeDiesel(-0.45, wave), makeDiesel(0.45, wave)];
  }

  /* ------------------------------------------------------------ scheduling */
  function updateWind(S, dt) {
    var aws = S.awsMs;
    var gust = clamp(S.gust, 0.6, 1.8);
    var q = SAIL.quality === 'low';
    var w2 = aws * aws;
    var gLow = clamp(0.0022 * w2, 0, 0.34) * gust;
    var gMid = clamp(0.00085 * w2 * Math.min(aws, 16) / 8, 0, 0.24) * gust;
    var gWhi = q ? 0 : clamp(0.000075 * w2 * clamp((aws - 4) / 8, 0, 1.4), 0, 0.10) * gust;
    var gHum = clamp(0.00035 * w2 * clamp((aws - 3) / 10, 0, 1), 0, 0.09) * gust;
    /* apparent-wind side: the leeward ear hears less */
    var side = clamp(S.awa / 90, -1, 1);
    for (var i = 0; i < 2; i++) {
      var W = A.wind[i];
      var bias = 1 + 0.25 * ((i === 0 ? -1 : 1) * side);
      ramp(W.gl.gain, gLow * bias, 0.25);
      ramp(W.gm.gain, gMid * bias, 0.22);
      ramp(W.gw.gain, gWhi * bias, 0.30);
      ramp(W.gh.gain, gHum * bias, 0.30);
      ramp(W.low.frequency, 150 + aws * 9, 0.4);
      ramp(W.mid.frequency, 480 + aws * 46, 0.35);
      ramp(W.whi.frequency, 880 + aws * 98, 0.35);
      ramp(W.hum.frequency, 255 + aws * 21, 0.4);
    }
    ramp(A.rumble.g.gain, clamp((gust - 0.95) * 0.22 * clamp(aws / 8, 0, 1.6), 0, 0.14), 0.6);

    /* halyard slap: a loose halyard taps the mast, more when luffing */
    A.halyT -= dt;
    var rate = 0.10 + 0.55 * S.trim.luff + 0.035 * aws;
    if (A.halyT <= 0) {
      A.halyT = (0.5 + Math.random() * 2.2) / Math.max(rate, 0.05);
      var g0 = clamp(0.006 + 0.010 * aws / 8, 0, 0.03) * (0.5 + Math.random());
      ping({ f: 300 + Math.random() * 220, fEnd: 190, dur: 0.13, gain: g0, wave: 'triangle', pan: (Math.random() - 0.5) * 0.3 });
      ping({ f: 900 + Math.random() * 500, dur: 0.06, gain: g0 * 0.5, wave: 'sine', pan: (Math.random() - 0.5) * 0.3 });
      burst({ type: 'bandpass', f: 1800, q: 2, dur: 0.05, gain: g0 * 0.6, pan: 0 });
    }
  }

  function updateWater(S, dt) {
    var ms = Math.abs(S.stw) / KN;
    var v2 = ms * ms;
    var gRush = clamp(0.010 * v2, 0, 0.30);
    var gHiss = clamp(0.0016 * v2 * clamp(ms / 3, 0, 1.6), 0, 0.13);
    var gGur = clamp(0.006 * ms, 0, 0.10);
    for (var i = 0; i < 2; i++) {
      var W = A.water[i];
      ramp(W.gr.gain, gRush, 0.18);
      ramp(W.gh.gain, gHiss, 0.20);
      ramp(W.gg.gain, gGur, 0.25);
      ramp(W.rush.frequency, 210 + ms * 52, 0.25);
      ramp(W.gurg.frequency, 200 + ms * 26, 0.3);
    }

    /* bow-wave slaps: encounter frequency of the wind sea against the bows */
    A.slapT -= dt;
    if (A.slapT <= 0) {
      var enc = clamp(0.32 + ms * 0.34 + S.swell * 0.15, 0.25, 3.2);
      A.slapT = (0.7 + Math.random() * 0.7) / enc;
      var amp = clamp(0.010 + 0.016 * v2 / 12, 0, 0.075) * (0.55 + Math.random() * 0.75);
      if (ms > 0.4) {
        burst({ type: 'lowpass', f: 420 + Math.random() * 260, q: 0.8, dur: 0.18 + Math.random() * 0.12, gain: amp, attack: 0.006, pan: (Math.random() < 0.5 ? -1 : 1) * 0.55 });
        burst({ type: 'bandpass', f: 1700 + Math.random() * 900, q: 1.1, dur: 0.09, gain: amp * 0.45, pan: (Math.random() - 0.5) * 0.9 });
      }
    }
  }

  function updateLuff(S, dt) {
    var L = S.trim.luff;
    var aws = S.awsMs;
    if (!S.sailsUp) L = 0;
    var inten = clamp(L * clamp((aws - 1.2) / 5, 0, 1.5), 0, 1.4);
    A.luffT -= dt;
    if (inten > 0.05 && A.luffT <= 0) {
      var hz = 8 + 6 * clamp(inten, 0, 1) + (Math.random() - 0.5) * 2.2;
      A.luffT = 1 / hz;
      var side = S.awa >= 0 ? -0.35 : 0.35;      /* sail is to leeward */
      var g0 = clamp(0.020 * inten * clamp(aws / 6, 0.3, 1.8), 0, 0.11);
      burst({
        type: 'bandpass', f: 520 + Math.random() * 1100, q: 1.1 + Math.random(),
        dur: 0.040 + Math.random() * 0.055, gain: g0 * (0.6 + Math.random() * 0.8),
        attack: 0.003, pan: side + (Math.random() - 0.5) * 0.3
      });
      if (Math.random() < 0.28) {
        burst({
          type: 'lowpass', f: 260, q: 0.7, dur: 0.14, gain: g0 * 0.9,
          attack: 0.005, pan: side, pinkSrc: true
        });
      }
    } else if (inten <= 0.05 && A.luffT < 0) {
      A.luffT = 0.05;
    }
  }

  function updateWinch(S, dt) {
    var dm = S.mainSheet - A.prev.mainSheet;
    var dj = S.jibSheet - A.prev.jibSheet;
    A.prev.mainSheet = S.mainSheet;
    A.prev.jibSheet = S.jibSheet;
    var moved = Math.abs(dm) + Math.abs(dj);
    var load = clamp(S.awsMs * S.awsMs / 260, 0, 1.2);

    /* pawl ratchet: ~30 clicks over the full sheet travel, only when hauling */
    A.winchAcc += moved;
    var per = 1 / 30;
    var guard = 0;
    while (A.winchAcc > per && guard++ < 8) {
      A.winchAcc -= per;
      var pan = Math.abs(dj) > Math.abs(dm) ? (S.awa >= 0 ? 0.4 : -0.4) : 0.15;
      burst({ type: 'highpass', f: 2600, q: 0.8, dur: 0.016, gain: 0.030 + 0.02 * load, attack: 0.001, pan: pan });
      ping({ f: 1650 + Math.random() * 500, dur: 0.022, gain: 0.020 + 0.014 * load, wave: 'square', pan: pan });
    }

    /* block creak under load while the sheet is running */
    var creakLvl = clamp(moved / Math.max(dt, 1e-3) * 0.22, 0, 1) * load;
    ramp(A.creak.g.gain, creakLvl * 0.05, 0.08);
    ramp(A.creak.f.frequency, 300 + 260 * load + 140 * Math.sin(S.t * 1.7), 0.15);
    A.creakT -= dt;
    if (A.creakT <= 0 && load > 0.25 && moved > 1e-4) {
      A.creakT = 0.35 + Math.random() * 0.9;
      ping({
        f: 210 + Math.random() * 130, fEnd: 300 + Math.random() * 180,
        dur: 0.28 + Math.random() * 0.25, gain: 0.016 * load, wave: 'sawtooth',
        attack: 0.05, pan: (Math.random() - 0.5) * 0.5
      });
    }
  }

  /* The physics idles both diesels for ever, so gating the engine bed on rpm
     alone would leave a Yanmar running under every quiet beat.  Gate it on
     the helm actually asking for drive; the ramp inside makeDiesel gives the
     shutdown its own 0.35 s decay, which reads as the engine being killed. */
  function updateEngines(S) {
    for (var i = 0; i < 2; i++) {
      var rpm = S.rpm[i];
      var on = S.enginesOn && S.engRunning && rpm > 200;
      var load = clamp(Math.abs(S.lever[i]), 0, 1) * 0.6 + clamp(Math.abs(S.gear[i]) * Math.abs(S.stw) / 9, 0, 0.4);
      A.eng[i].set(rpm * (i === 0 ? 1.0 : 1.007), clamp(load, 0, 1), on);
    }
  }

  function updateAmbient(S, dt) {
    /* distant surf on the reef: probe the bathymetry occasionally */
    A.prev.shoreT -= dt;
    if (A.prev.shoreT <= 0) {
      A.prev.shoreT = 0.45;
      var isl = SAIL.island;
      var best = 1e9, bestB = 0;
      if (isl && typeof isl.depthAt === 'function') {
        for (var b = 0; b < 12; b++) {
          var brg = b / 12 * PI * 2;
          var sx = Math.sin(brg), sz = -Math.cos(brg);
          for (var ri = 0; ri < 4; ri++) {
            var rr2 = [70, 170, 340, 640][ri];
            var d = isl.depthAt(S.x + sx * rr2, S.z + sz * rr2);
            if (isFinite(d) && d < 2.2 && rr2 < best) { best = rr2; bestB = brg * RAD; }
          }
        }
      }
      A.shore.gain = best < 1e8 ? clamp(1 - best / 750, 0, 1) : 0;
      A.shore.pan = best < 1e8 ? clamp(Math.sin((bestB - S.hdg) * DEG), -1, 1) : 0;
    }
    var swellF = clamp(0.4 + S.swell * 0.6, 0.3, 1.6);
    ramp(A.surf.g.gain, A.shore.gain * 0.085 * swellF, 0.8);
    ramp(A.surf.lfoG.gain, A.shore.gain * 0.045 * swellF, 0.8);
    ramp(A.surf.f.frequency, 380 + 260 * A.shore.gain, 0.8);
    setPan(A.surf.p, A.shore.pan * 0.8);

    /* hull slam from vertical acceleration */
    var hv = S.heave;
    var rate = (hv - A.prev.heave) / Math.max(dt, 1e-3);
    A.prev.heave = hv;
    var acc = (rate - A.prev.heaveRate) / Math.max(dt, 1e-3);
    A.prev.heaveRate = rate;
    A.prev.slamCd -= dt;
    if (acc < -7 && A.prev.slamCd <= 0 && isFinite(acc)) {
      A.prev.slamCd = 0.42;
      var amp = clamp(Math.abs(acc) / 26, 0, 1);
      burst({ type: 'lowpass', f: 210, fEnd: 90, q: 1.0, dur: 0.34, gain: 0.055 * amp, attack: 0.004, pan: (Math.random() - 0.5) * 0.5, pinkSrc: true });
      burst({ type: 'bandpass', f: 900, q: 1.4, dur: 0.10, gain: 0.030 * amp, attack: 0.002, pan: (Math.random() - 0.5) * 0.7 });
    }

    /* shallow-water alarm */
    A.alarmT -= dt;
    if (isFinite(S.underKeel) && S.underKeel < 1.0 && !S.aground && A.alarmT <= 0) {
      A.alarmT = 3.0;
      ping({ f: 1180, dur: 0.09, gain: 0.045, wave: 'square', pan: 0 });
      window.setTimeout(function () { ping({ f: 1180, dur: 0.09, gain: 0.045, wave: 'square', pan: 0 }); }, 150);
    }
    if (S.aground && A.alarmT <= 0) {
      A.alarmT = 1.6;
      burst({ type: 'lowpass', f: 160, q: 0.8, dur: 0.5, gain: 0.09, attack: 0.005, pan: 0, pinkSrc: true });
    }
  }

  var audioApi = {
    init: function () {
      if (A.ctx) return audioApi;
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return audioApi;
      try { A.ctx = new AC(); } catch (e) { A.ctx = null; return audioApi; }
      try { buildGraph(); } catch (e2) { A.ctx = null; return audioApi; }
      A.ready = true;
      var resume = function () {
        if (A.ctx && A.ctx.state === 'suspended') { try { A.ctx.resume(); } catch (e) { } }
      };
      ['pointerdown', 'mousedown', 'keydown', 'touchstart'].forEach(function (ev) {
        window.addEventListener(ev, resume, { passive: true });
      });
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', function () {
          if (!A.ctx) return;
          try { document.hidden ? A.ctx.suspend() : A.ctx.resume(); } catch (e) { }
        });
      }
      return audioApi;
    },
    update: function (state, env) {
      if (!A.ready || !A.ctx) return;
      var S = getSnap(state, env);
      var dt = clamp(S.dt, 1 / 240, 0.25);
      if (A.ctx.state !== 'running') {
        A.prev.mainSheet = S.mainSheet;
        A.prev.jibSheet = S.jibSheet;
        return;
      }
      ramp(A.master.gain, A.muted ? 0 : A.vol, 0.15);
      if (A.muted) return;
      try {
        updateWind(S, dt);
        updateWater(S, dt);
        updateLuff(S, dt);
        updateWinch(S, dt);
        updateEngines(S);
        updateAmbient(S, dt);
      } catch (e) { A.lastError = e; }
    },
    setVolume: function (v) { A.vol = clamp(num(v, 0.85), 0, 1); if (A.master) ramp(A.master.gain, A.muted ? 0 : A.vol, 0.1); },
    mute: function () { A.muted = true; },
    unmute: function () { A.muted = false; },
    toggleMute: function () {
      A.muted = !A.muted;
      if (!A.muted && A.ctx && A.ctx.state === 'suspended') { try { A.ctx.resume(); } catch (e) { } }
      hudApi.notify(A.muted ? 'AUDIO MUTED' : 'AUDIO ON', 1.4);
    },
    get muted() { return A.muted; },
    get ready() { return A.ready; },
    state: A
  };
  SAIL.audio = audioApi;

})();
