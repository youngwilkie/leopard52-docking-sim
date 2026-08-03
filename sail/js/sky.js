/* ==========================================================================
   sky.js — SAIL.sky : physically-based atmosphere for Grenada (12.05N 61.75W)
   ..........................................................................
   Rayleigh + Mie + ozone single scattering with a cheap multiple-scattering
   term, evaluated into two small look-up textures once per condition change:

     transmittance LUT   256 x 64   (Bruneton r/mu parameterisation)
     sky-view LUT        256 x 128  (azimuth-from-sun x nonlinear elevation)

   The sky-view parameterisation is EXACT for a horizontally uniform
   atmosphere, so a single bilinear fetch reproduces the full radiance field —
   sharper, cheaper and more correct at the horizon than either a Preetham
   evaluation or a PMREM cubeUV lookup.  skyRadiance(dir,sunDir) is published
   as GLSL for the ocean / terrain / cloud shaders to share.

   Clouds are an adaptive raymarch through a spherical slab (690..2620 m) with
   half-step boundary refinement, run twice: into a 2048x1024 panoramic RGBA16F
   LUT (reflections / PMREM / aerial perspective, amortised over 16 horizontal
   bands) and into a 0.68x screen-space buffer with temporal reprojection,
   which is what the visible dome shows.  The panorama resolution is a
   CORRECTNESS constraint, not a quality dial: at 768x384 one texel spans 0.469
   deg, which over a 92 deg field on an 1800 px frame is 9.2 screen pixels, and
   every cloud that path serves arrives as nearest-neighbour blocks with no
   silhouette left in it.  2048x1024 is 0.176 deg/texel and it is fetched with
   a 4-tap Catmull-Rom (sailCloudTap) because a C0 bilinear kernel at any
   magnification puts its gradient discontinuities on an axis-aligned lattice.

   Density is a Worley CELL field — discrete trade-wind cumulus with real blue
   sky between them, ~20-25% cover — times a 5-13 km cloud-street modulator,
   gated by a hard 22 m per-cell condensation level so every cloud has one
   razor-flat base, with per-cell tops spread 0.80-1.24x so no population of
   cells shares a ceiling.  The volume fetches are C1 on all three axes
   (smoothstep-warped texel coordinates), which keeps the silhouettes free of
   the axis-aligned staircases and stacked-lenticular seams that a raw bilinear
   tap produces at 20x magnification.

   Lighting is a 6-tap coned sun march to ~2.4 km PLUS an analytic column term
   (clLight): the march alone is a noisy estimator of a quantity that must be
   MONOTONE in height, and a noisy estimator is how two consecutive builds
   shipped cumulus whose undersides were measurably brighter and warmer than
   their sun-facing crowns.  The analytic term adds the geometric depth of the
   cell above the sample, gated on the march having actually found cloud in the
   first 250 m so it never fires on an exposed turret cap.  On top of that:
   three Wrenninge multiple-scatter octaves, dual-lobe HG (silver lining), a
   powder term that only ever darkens, and a TWO-LOBE sky ambient — the crown
   sees the sky hemisphere, the base sees a 6%-albedo sea and its own shadow —
   which together put a sunlit cauliflower 4.5 stops (scene-referred) over a
   grey-blue base.  S.selfTest() asserts that ratio on every build.

   Sun-ray transmittance of the deck is exported as a 1024^2 shadow plane over
   9 km (8.8 m/texel, one band of 12 per frame) for the ocean, island and
   sails: sailCloudShadow(worldPos).  Consumers should sample THIS rather than
   rolling an independent wind-advected noise field, or the dark patches on the
   water will sit under clear sky.

   World axes:  +X = East, +Z = South, -Z = North, Y = up, metres.

   USING THE SKY FROM ANOTHER SHADER — both steps are required:
       mat.fragmentShader = 'precision highp float;\n' + SAIL.sky.glsl + yourFS;
       SAIL.sky.register(mat);          // binds uSkyLUT / uSkyTransLUT / ...
   The chunk is self-guarded (#ifndef SAIL_SKY_INCLUDED), works in GLSL ES 1.00
   and GLSL3 (three aliases texture2D->texture), and declares its own uniforms.
   Injecting the GLSL WITHOUT register() leaves three sampler2Ds unbound and you
   get black or garbage reflections — there is no partial adoption.
   It gives you:
       vec3 skyRadiance(dir, sunDir)        sky + clouds + sun/moon discs
       vec3 skyRadianceNoSun(dir, sunDir)   sky + clouds only (reflections)
       vec3 skyRadianceBase(dir, sunDir)    bare atmosphere, no clouds
       vec3 aerialPerspective(col, worldPos, camPos, sunDir)
       vec3 applyAerial(col, worldPos, camPos)
       vec3 sailAerialTransmittance(worldPos, camPos)
       vec3 sailSunIrradiance()             uSkySunTint * uSkySunE
   Modules that would rather stay self-contained should instead read the CPU
   values SAIL.sky publishes into SAIL.env every frame — sunDir, sunColor,
   sunE, skyE, exposure, horizonColor — which keeps them photometrically in
   step with the dome even though they evaluate their own analytic sky.
   ========================================================================== */
(function () {
  'use strict';

  var SAIL = (window.SAIL = window.SAIL || {});
  var S = {};
  SAIL.sky = S;

  if (typeof THREE === 'undefined') {           // fail soft, never throw
    S.ready = false;
    S.build = S.init = function () { return S; };
    S.update = function () {};
    S.getUniforms = function () { return {}; };
    S.register = function () {};
    S.glsl = '';
    return;
  }

  /* ------------------------------------------------------------- constants */
  var PI = Math.PI, DEG = PI / 180;
  var LAT = 12.05 * DEG, LON = -61.75, TZMER = -60.0;   // AST = UTC-4
  var RG = 6360.0, RA = 6420.0;                          // km
  // sea-level scattering coefficients, per km, for 680 / 550 / 440 nm
  var BETA_R = [5.802e-3, 13.558e-3, 33.100e-3];
  /* Marine tropical aerosol, deliberately LOW.  Aerosol scattering is grey,
     and grey scattering at the zenith is exactly what turns a Caribbean sky
     into an English one: at 8e-3 with a 6.5x marine boost the aerosol was
     contributing more inscatter to the zenith than Rayleigh red+green
     together, pinning red/blue at 0.45.  The horizon haze band does NOT need
     aerosol to be bright — a horizon ray carries ~38 air masses, which drives
     Rayleigh blue and green to saturation and whitens the band all by itself.
     So: clean air, forward-peaked (uMieG 0.82), and the circumsolar
     brightening handled by the explicit aureole instead. */
  /* Dropped from 5.0e-3.  Aerosol scattering is GREY, and grey is exactly what
     turned the golden-hour mid-band achromatic (measured 9% chroma, R~G~B).
     A clean tropical marine airmass really is this thin above the boundary
     layer; the bright horizon band is carried by the 0.45 km marine slab in
     atmDM(), which is unaffected. */
  var BETA_M = 3.4e-3;                                   // Mie scattering
  var BETA_M_E = BETA_M / 0.9;                           // Mie extinction
  /* Ozone Chappuis absorption.  This is the band that eats yellow-green and
     leaves the upper sky blue-violet while the horizon burns orange — without
     enough of it a sunset crosses from blue to gold through a dead neutral
     grey, which is the fingerprint of an sRGB lerp and reads as broken.
     Raised ~1.5x (tropical column runs high, ~290-310 DU, and the Chappuis
     path length at low sun is enormous) AND re-weighted toward RED.  This is a
     three-band FIT, not a spectral integral: the part of the Chappuis band that
     actually turns a low sky cyan sits at 590-620 nm, which straddles the R and
     G primaries, so a naive per-primary cross-section absorbs green hardest and
     drives the mid-band toward neutral — precisely the dead grey waypoint the
     review measured at 9% chroma.  Loading the red channel instead makes the
     crossover between the blue upper sky and the warm horizon pass through
     TEAL, which is what a real tropical evening does. */
  /* Green raised 3.00 -> 4.35e-3.  The zenith measured sRGB G/B 0.68 where the
     reference wants 0.62-0.65, and the only spectrally honest lever that pulls
     GREEN down without touching blue is the Chappuis band — it is centred at
     600 nm but its shoulder runs well into the 550 nm primary.  Everything else
     that could darken green (more Rayleigh, less Mie) darkens blue harder and
     just makes the sky dimmer rather than more saturated. */
  var BETA_O = [2.250e-3, 4.350e-3, 0.140e-3];           // ozone absorption
  // vertical optical depth of the whole column, split by species so the CPU
  // radiometry can attenuate each with its own altitude profile
  var TAU_R = [0.04370, 0.10300, 0.26700];   // Rayleigh   (H = 8.0 km)
  var TAU_A = [0.01446, 0.01570, 0.01699];   // aerosol    (1.2 km + marine 0.36 km)
  var TAU_O = [0.03380, 0.06500, 0.00210];   // ozone      (tent, 10..40 km)
  var TAU_V = [TAU_R[0] + TAU_A[0] + TAU_O[0],
               TAU_R[1] + TAU_A[1] + TAU_O[1],
               TAU_R[2] + TAU_A[2] + TAU_O[2]];
  var LUM = [0.2126, 0.7152, 0.0722];
  /* Solar disc radiance relative to the sky.  A real solar disc is ~1.6e9
     cd/m2 against a 5e3 cd/m2 zenith; we cannot carry 5 decades through a
     half-float chain, but 2.2e4 against a ~2 unit zenith is four decades and
     is far past anything the tonemapper can hold, so the disc clips to solid
     255 and dumps a large amount of energy into the bloom bright-pass. */
  var SUN_DISC_L = 2.2e4;
  /* trade-wind cumulus: one flat condensation base, tops well up in the slab */
  var CL_BASE = 690.0, CL_TOP = 2620.0;

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function smoothstepf(a, b, x) { var t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
  function lum3(c) { return LUM[0] * c[0] + LUM[1] * c[1] + LUM[2] * c[2]; }
  function hgF(c, g) {
    var g2 = g * g, d = 1 + g2 - 2 * g * c;
    return (1 - g2) / (4 * PI * Math.max(d * Math.sqrt(Math.max(d, 1e-4)), 1e-4));
  }

  /* ------------------------------------------------- shared uniform objects
     One object per uniform, shared by reference with every material that
     registers, so updating .value here propagates everywhere.               */
  var U = {
    uSkyLUT:        { value: null },
    uSkyLutSize:    { value: new THREE.Vector2(256, 128) },
    uSkyTransLUT:   { value: null },
    uSkyTransSize:  { value: new THREE.Vector2(256, 64) },
    uSkyCloudLUT:   { value: null },
    uSkyCloudSize:  { value: new THREE.Vector2(2048, 1024) },
    uSkySunDir:     { value: new THREE.Vector3(0.3, 0.9, -0.3) },
    uSkyMoonDir:    { value: new THREE.Vector3(0, -1, 0) },
    uSkySunTint:    { value: new THREE.Vector3(1, 0.93, 0.82) },
    uSkySunE:       { value: 100.0 },
    uSkySkyE:       { value: 12.0 },
    uSkyMoonE:      { value: 0.0 },
    uSkyMoonFrac:   { value: 1.0 },
    uSkyNight:      { value: 0.0 },
    uSkyTime:       { value: 0.0 },
    uSkyLutScale:   { value: 1.0 },
    uSkyStarRot:    { value: new THREE.Matrix3() },
    uSkyBetaR:      { value: new THREE.Vector3(BETA_R[0] * 1e-3, BETA_R[1] * 1e-3, BETA_R[2] * 1e-3) },
    uSkyBetaMe:     { value: BETA_M_E * 1e-3 },
    uSkyAerialGain: { value: 1.0 },
    uSkyCloudMix:   { value: 1.0 },
    uSkyExposure:   { value: 0.030 },
    /* Cloud shadow projection, exported for the shadow pass.  uSkyCloudShTex
       stores the sun-ray transmittance of the cloud deck sampled on the y = 0
       plane; xy = world origin of the map, z = 1/span, w = strength.        */
    uSkyCloudShTex: { value: null },
    uSkyCloudShBox: { value: new THREE.Vector4(-6000, -6000, 1 / 12000, 0.0) }
  };
  var registered = [];

  S.uniforms = U;
  S.getUniforms = function () {
    var o = {}; for (var k in U) o[k] = U[k]; return o;
  };
  S.register = function (mat) {
    if (!mat) return mat;
    if (mat.uniforms) { for (var k in U) if (!mat.uniforms[k]) mat.uniforms[k] = U[k]; }
    if (registered.indexOf(mat) < 0) registered.push(mat);
    return mat;
  };
  function pushUniforms() {                        // survives UniformsUtils.clone()
    for (var i = 0; i < registered.length; i++) {
      var m = registered[i]; if (!m || !m.uniforms) continue;
      for (var k in U) { var u = m.uniforms[k]; if (u && u !== U[k]) u.value = U[k].value; }
    }
  }

  /* ====================================================================== */
  /*  SHARED GLSL — include this in any material that wants the sky          */
  /* ====================================================================== */
  var GLSL = [
    '#ifndef SAIL_SKY_INCLUDED',
    '#define SAIL_SKY_INCLUDED',
    '#define SAIL_PI 3.141592653589793',
    '#define SAIL_RG 6360.0',
    '#define SAIL_RA 6420.0',
    '#define SAIL_HR 8.0',
    '#define SAIL_HM 1.2',
    '#define SAIL_HB 0.45',
    '#define SAIL_SUNR 0.004675',
    'uniform sampler2D uSkyLUT;      uniform vec2 uSkyLutSize;',
    'uniform sampler2D uSkyTransLUT; uniform vec2 uSkyTransSize;',
    'uniform sampler2D uSkyCloudLUT; uniform vec2 uSkyCloudSize;',
    'uniform sampler2D uSkyCloudShTex; uniform vec4 uSkyCloudShBox;',
    'uniform vec3 uSkySunDir, uSkyMoonDir, uSkySunTint, uSkyBetaR;',
    'uniform float uSkySunE, uSkySkyE, uSkyMoonE, uSkyMoonFrac, uSkyNight, uSkyTime;',
    'uniform float uSkyLutScale, uSkyBetaMe, uSkyAerialGain, uSkyCloudMix, uSkyExposure;',
    'uniform mat3 uSkyStarRot;',
    '',
    'float sailHG(float c, float g){ float g2=g*g; float d=1.0+g2-2.0*g*c;',
    '  return (1.0-g2)/(4.0*SAIL_PI*max(d*sqrt(max(d,1e-4)),1e-4)); }',
    'float sailRayleighPhase(float c){ return (3.0/(16.0*SAIL_PI))*(1.0+c*c); }',
    'float sailDistTop(float r, float mu){',
    '  float d = r*r*(mu*mu-1.0) + SAIL_RA*SAIL_RA;',
    '  return max(-r*mu + sqrt(max(d,0.0)), 0.0); }',
    '/* transmittance from (r,mu) to the top of the atmosphere, Bruneton param */',
    'vec3 sailTrans(float r, float mu){',
    '  float H = sqrt(SAIL_RA*SAIL_RA - SAIL_RG*SAIL_RG);',
    '  float rho = sqrt(max((r-SAIL_RG)*(r+SAIL_RG), 0.0));',
    '  float d = sailDistTop(r, mu);',
    '  float dmin = SAIL_RA - r, dmax = rho + H;',
    '  vec2 uv = vec2(clamp((d-dmin)/max(dmax-dmin,1e-4),0.0,1.0), clamp(rho/H,0.0,1.0));',
    '  uv = clamp(uv, 0.5/uSkyTransSize, 1.0-0.5/uSkyTransSize);',
    '  return texture2D(uSkyTransLUT, uv).rgb; }',
    '',
    '/* ---- sky-view LUT ---------------------------------------------------- */',
    'vec2 sailSkyUV(vec3 dir, vec3 sun){',
    '  vec2 dh = dir.xz; float dl = length(dh); dh = dl>1e-6 ? dh/dl : vec2(1.0,0.0);',
    '  vec2 sh = sun.xz;  float sl = length(sh); sh = sl>1e-6 ? sh/sl : vec2(1.0,0.0);',
    '  float u = acos(clamp(dot(dh,sh),-1.0,1.0))/SAIL_PI;',
    '  float el = asin(clamp(dir.y,-1.0,1.0));',
    '  float s = (el<0.0?-1.0:1.0)*sqrt(abs(el)/(0.5*SAIL_PI));',
    '  vec2 uv = vec2(u, 0.5+0.5*s);',
    '  return clamp(uv, 0.5/uSkyLutSize, 1.0-0.5/uSkyLutSize); }',
    'vec3 sailSkyLUT(vec3 dir, vec3 sun){',
    '  return texture2D(uSkyLUT, sailSkyUV(dir,sun)).rgb * uSkyLutScale; }',
    '',
    '/* ---- circumsolar Mie aureole ----------------------------------------- */',
    '/* The sky-view LUT is 384 texels across 180 deg of azimuth: 0.47 deg per',
    '   texel.  It physically CANNOT resolve the forward-scattering lobe, which',
    '   is 3-5x sky background inside 10 deg and gone by 40 deg — the LUT smears',
    '   it into a featureless warm wash, which is precisely the "no sun, no',
    '   aureole, flat smear" failure.  So the LUT keeps only the broad Mie term',
    '   and the sharp forward lobe is evaluated ANALYTICALLY per pixel here, at',
    '   full screen resolution, with the isotropic pedestal subtracted off so we',
    '   are adding the peak and not double counting the base.',
    '   Two Henyey-Greenstein lobes: a tight g=0.925 core for the aureole proper',
    '   and a wide g=0.74 skirt for the general solar-half brightening.  The',
    '   1/(mu+k) factor is the aerosol airmass along the view ray, so the lobe',
    '   swells enormously when you look at a low sun through the marine layer. */',
    'vec3 sailAureole(vec3 dir, vec3 sun){',
    '  float up = smoothstep(-0.045, 0.050, sun.y);',
    '  if (up <= 0.0 || uSkySunE <= 0.0) return vec3(0.0);',
    '  float ca = dot(dir, sun);',
    '  if (ca < 0.02) return vec3(0.0);',
    '  float f = 0.58*sailHG(ca, 0.925) + 0.42*sailHG(ca, 0.740);',
    '  f = max(f - 0.115, 0.0);',
    '  float ax = 1.0/(max(dir.y, 0.0) + 0.115);',
    '  /* uSkySunE/uSkySunTint ALREADY carry the beam extinction for the current',
    '     solar altitude, and near the sun the view ray and the beam are the same',
    '     path — so applying sailTrans() here as well would extinguish the lobe',
    '     twice and the low-sun aureole (the one that matters most) would go out',
    '     exactly when it should be at its most spectacular. */',
    '  return uSkySunTint * (uSkySunE * 0.026 * ax * up * f); }',
    'vec3 skyRadianceBase(vec3 dir, vec3 sun){',
    '  return sailSkyLUT(dir, sun) + sailAureole(dir, sun); }',
    '',
    '/* ---- clouds ---------------------------------------------------------- */',
    '/* The panoramic LUT is the REFLECTION / ambient / aerial source.  The dome',
    '   itself prefers the screen-space march (see the dome shader).  The fade',
    '   only exists to stop the bilinear tap reaching below the first texel row —',
    '   clouds must survive all the way down to the geometric horizon.        */',
    '/* CATMULL-ROM, NOT BILINEAR.  Even at 2048x1024 the panorama is 0.176 deg',
    '   per texel against a 0.05 deg pixel, so the reconstruction filter IS the',
    '   cloud silhouette at anything past the screen march.  A bilinear tap is C0:',
    '   the gradient jumps at every texel boundary and those jumps align into the',
    '   axis-aligned square lattice the review called "pixel confetti".  A cubic',
    '   B-spline/Catmull-Rom kernel is C1 and its 4 taps are bilinear-accelerated',
    '   (Sigg-Hadwiger offsets), so this costs four fetches, not sixteen, and the',
    '   blocks dissolve into smooth lobes instead of being feathered into mush.  */',
    'vec4 sailCloudTap(vec2 uv){',
    '  vec2 ts = uSkyCloudSize;',
    '  vec2 p = uv*ts - 0.5;',
    '  vec2 i = floor(p), f = p - i;',
    '  vec2 f2 = f*f, f3 = f2*f;',
    '  vec2 w0 = -0.5*f3 + f2 - 0.5*f;',
    '  vec2 w1 =  1.5*f3 - 2.5*f2 + 1.0;',
    '  vec2 w2 = -1.5*f3 + 2.0*f2 + 0.5*f;',
    '  vec2 w3 =  0.5*f3 - 0.5*f2;',
    '  vec2 s0 = w0 + w1, s1 = w2 + w3;',
    '  vec2 o0 = (i - 1.0 + w1/max(s0, vec2(1e-5)) + 0.5)/ts;',
    '  vec2 o1 = (i + 1.0 + w3/max(s1, vec2(1e-5)) + 0.5)/ts;',
    '  float vlo = 0.5/ts.y, vhi = 1.0 - 0.5/ts.y;',
    '  o0.y = clamp(o0.y, vlo, vhi); o1.y = clamp(o1.y, vlo, vhi);',
    '  vec4 a = texture2D(uSkyCloudLUT, vec2(o0.x, o0.y))*(s0.x*s0.y)',
    '         + texture2D(uSkyCloudLUT, vec2(o1.x, o0.y))*(s1.x*s0.y)',
    '         + texture2D(uSkyCloudLUT, vec2(o0.x, o1.y))*(s0.x*s1.y)',
    '         + texture2D(uSkyCloudLUT, vec2(o1.x, o1.y))*(s1.x*s1.y);',
    '  return vec4(max(a.rgb, vec3(0.0)), clamp(a.a, 0.0, 1.0)); }',
    'vec4 sailCloudSample(vec3 dir){',
    '  float el = asin(clamp(dir.y,-1.0,1.0));',
    '  float v = sqrt(clamp(el/(0.5*SAIL_PI), 0.0, 1.0));',
    '  float u = atan(dir.x, -dir.z)/(2.0*SAIL_PI) + 0.5;',
    '  v = clamp(v, 0.5/uSkyCloudSize.y, 1.0-0.5/uSkyCloudSize.y);',
    '  vec4 c = sailCloudTap(vec2(u,v));',
    '  float f = smoothstep(-0.0090, 0.0018, dir.y) * uSkyCloudMix;',
    '  return vec4(c.rgb*uSkyLutScale*f, mix(1.0, clamp(c.a,0.0,1.0), f)); }',
    '',
    '/* ---- cloud shadow (EXPORTED) ----------------------------------------- */',
    '/* Sun-ray transmittance of the cloud deck, rendered on the y = 0 plane and',
    '   re-projected along the sun ray for elevated receivers.  Any material that',
    '   calls SAIL.sky.register() already has the uniforms; just call this.      */',
    'float sailCloudShadow(vec3 wp){',
    '  if (uSkyCloudShBox.w <= 0.001) return 1.0;',
    '  float ly = max(uSkySunDir.y, 0.07);',
    '  vec2 g = wp.xz - uSkySunDir.xz*(max(wp.y, 0.0)/ly);',
    '  vec2 uv = (g - uSkyCloudShBox.xy)*uSkyCloudShBox.z;',
    '  vec2 e = min(uv, 1.0-uv);',
    '  float edge = smoothstep(0.0, 0.035, min(e.x, e.y));',
    '  float s = texture2D(uSkyCloudShTex, clamp(uv, 0.002, 0.998)).r;',
    '  return mix(1.0, mix(1.0, s, edge), uSkyCloudShBox.w); }',
    '',
    '/* ---- hash / value noise (declared before every consumer) -------------- */',
    'vec3 sailHash33(vec3 p){',
    '  p = vec3(dot(p,vec3(127.1,311.7,74.7)), dot(p,vec3(269.5,183.3,246.1)), dot(p,vec3(113.5,271.9,124.6)));',
    '  return fract(sin(p)*43758.5453123); }',
    'float sailVN3(vec3 p){',
    '  vec3 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);',
    '  float a=sailHash33(i).x, b=sailHash33(i+vec3(1.0,0.0,0.0)).x;',
    '  float c=sailHash33(i+vec3(0.0,1.0,0.0)).x, d=sailHash33(i+vec3(1.0,1.0,0.0)).x;',
    '  float e=sailHash33(i+vec3(0.0,0.0,1.0)).x, g=sailHash33(i+vec3(1.0,0.0,1.0)).x;',
    '  float h=sailHash33(i+vec3(0.0,1.0,1.0)).x, k=sailHash33(i+vec3(1.0,1.0,1.0)).x;',
    '  return mix(mix(mix(a,b,f.x),mix(c,d,f.x),f.y), mix(mix(e,g,f.x),mix(h,k,f.x),f.y), f.z); }',
    '',
    '/* ---- sun / moon discs ------------------------------------------------ */',
    'vec3 sailSunDisc(vec3 dir, vec3 sun){',
    '  float c = dot(dir, sun);',
    '  if (c < 0.99997) return vec3(0.0);',
    '  float ang = acos(clamp(c,-1.0,1.0));',
    '  float rr = clamp(ang/SAIL_SUNR, 0.0, 1.0);',
    '  float mu = sqrt(max(1.0-rr*rr, 0.0));',
    '  vec3 limb = vec3(1.0) - vec3(0.397,0.503,0.652)*(1.0-mu);',
    '  float edge = 1.0 - smoothstep(SAIL_SUNR*0.965, SAIL_SUNR*1.02, ang);',
    '  return SAIL_SUNR_SCALE * limb * edge * sailTrans(SAIL_RG+0.002, max(dir.y,-0.02)); }',
    'vec3 sailMoonDisc(vec3 dir){',
    '  if (uSkyNight < 0.002 || uSkyMoonE <= 0.0) return vec3(0.0);',
    '  float c = dot(dir, uSkyMoonDir);',
    '  if (c < 0.99993) return vec3(0.0);',
    '  vec3 t1 = normalize(cross(uSkyMoonDir, vec3(0.0,1.0,0.0)) + vec3(1e-4,0.0,1e-4));',
    '  vec3 t2 = cross(uSkyMoonDir, t1);',
    '  vec3 off = dir - uSkyMoonDir*c;',
    '  vec2 p = vec2(dot(off,t1), dot(off,t2))/(SAIL_SUNR*1.02);',
    '  float rr = length(p); if (rr > 1.06) return vec3(0.0);',
    '  float rc = min(rr, 1.0);',
    '  vec3 n = normalize(t1*p.x + t2*p.y + uSkyMoonDir*sqrt(max(1.0-rc*rc, 0.0)));',
    '  float lit = smoothstep(-0.045, 0.055, dot(n, uSkySunDir));',
    '  float mare = 0.68 + 0.32*smoothstep(0.34, 0.60, sailVN3(n*3.1 + 5.0));',
    '  float ll = 0.62 + 0.38*sqrt(max(1.0-rc*rc, 0.0));',
    '  float edge = 1.0 - smoothstep(0.985, 1.005, rr);',
    '  return vec3(1.0,0.97,0.90) * (18.0*uSkyMoonE) * lit * mare * ll * edge; }',
    '',
    '/* ---- night sky: stars, milky way, moon glow, airglow ------------------ */',
    '/* Three lattices of decreasing cell size and increasing population.  The',
    '   magnitude curve is deliberately brutal — pow(h,7) puts the overwhelming',
    '   majority within a few percent of threshold and leaves a handful of real',
    '   luminaries, which is what a naked-eye sky actually looks like.  Cores are',
    '   ~1 px; the glow around the bright ones is post.js bloom, not a fat',
    '   Gaussian drawn here.                                                   */',
    'vec3 sailStars(vec3 d){',
    '  vec3 c = vec3(0.0);',
    '  for (int L=0; L<3; L++){',
    '    float sc  = (L==0) ? 150.0   : ((L==1) ? 420.0   : 1050.0);',
    '    float dns = (L==0) ? 0.026   : ((L==1) ? 0.038   : 0.052);',
    '    float rad = (L==0) ? 0.00070 : ((L==1) ? 0.00062 : 0.00058);',
    '    float gn  = (L==0) ? 1.00    : ((L==1) ? 0.24    : 0.065);',
    '    vec3 ip = floor(d*sc);',
    '    vec3 h = sailHash33(ip + float(L)*31.77);',
    '    if (h.x < dns){',
    '      vec3 sp = ip + 0.5 + (sailHash33(ip+7.13)-0.5)*0.80;',
    '      float ang = acos(clamp(dot(normalize(sp), d), -1.0, 1.0));',
    '      /* magnitude law.  Naked-eye counts roughly triple per magnitude, so',
    '         flux follows a steep power law: a dozen luminaries carry the sky',
    '         and everything else sits within a few percent of threshold. */',
    '      float m = pow(h.y, 9.0);',
    '      float br = gn*(0.004 + 0.996*m);',
    '      /* Core stays at ~1 screen pixel REGARDLESS of magnitude — a star is',
    '         a point source, brighter ones are brighter, not fatter.  All the',
    '         visible flare around Sirius is the bloom pass, not a fat Gaussian',
    '         drawn here (a wide soft disc reads as lens dust, not as sky). */',
    '      float sz = rad;',
    '      float core = exp(-(ang*ang)/(sz*sz));',
    '      float spike = 0.030*m*exp(-ang/(sz*2.6));',
    '      /* colour from a synthetic B-V index: hot blue-white O/B stars at one',
    '         end, cool orange K/M giants at the other, most of the population',
    '         crowded around solar white in between. */',
    '      float bv = h.z;',
    '      vec3 tint = (bv < 0.74) ? mix(vec3(0.62,0.74,1.00), vec3(1.00,0.98,0.96), bv/0.74)',
    '                              : mix(vec3(1.00,0.98,0.96), vec3(1.00,0.80,0.58), (bv-0.74)/0.26);',
    '      c += (core + spike)*br*tint*5.2; } }',
    '  return c; }',
    'vec3 sailNightSky(vec3 dir){',
    '  if (uSkyNight < 0.002) return vec3(0.0);',
    '  vec3 sd = uSkyStarRot * dir;',
    '  float ay = clamp(dir.y, 0.0, 1.0);',
    '  /* atmospheric extinction: relative airmass, reddening as it bites */',
    '  float X = 1.0/(ay + 0.028);',
    '  vec3 ext = exp(-vec3(0.19,0.28,0.44)*max(X-1.0, 0.0));',
    '  vec3 c = sailStars(sd)*ext;',
    '  /* Milky Way: a narrow band, clumped, with dark rift lanes cut into it */',
    '  /* Galactic pole chosen so the band actually crosses the sky over St',
    '     George\'s in the small hours — it is a fixed direction in star space,',
    '     so it rises and sets with everything else. */',
    '  vec3 gal = normalize(vec3(0.237, 0.955, 0.180));',
    '  float bd = dot(sd, gal);',
    '  float band = exp(-bd*bd/0.0135) + 0.36*exp(-bd*bd/0.080);',
    '  float clump = 0.24 + 0.80*sailVN3(sd*5.5) + 0.44*sailVN3(sd*14.0) + 0.22*sailVN3(sd*34.0);',
    '  float lane = smoothstep(0.36,0.76, sailVN3(sd*8.5+4.1)) * smoothstep(0.28,0.72, sailVN3(sd*19.0+1.7));',
    '  float mw = max(band*clump*(1.0 - 0.80*lane), 0.0);',
    '  c += mw*vec3(0.130,0.150,0.205)*ext;',
    '  /* THE NIGHT SKY IS NOT BROWN.  Every term below is built so that the RED',
    '     channel is the SMALLEST of the three everywhere above the horizon:',
    '       - Rayleigh-scattered moonlight and integrated starlight are blue,',
    '         because Rayleigh is blue whatever the source;',
    '       - airglow is the OI 557.7 nm green line plus weak Na, so it is a',
    '         green-cyan that only shows up in the last ~25 deg of elevation;',
    '       - the sodium glow of St George\'s is the one warm term in the sky,',
    '         and a town glow is a LOCAL phenomenon: pow(1-ay,34) confines it to',
    '         the bottom ~6 deg and the azimuth mask confines it to the eastern',
    '         quadrant where the town actually is.  Spreading a warm constant',
    '         over the whole dome is what produced sepia. */',
    '  float lowf = pow(1.0-ay, 2.6);',
    '  c += mix(vec3(0.0048,0.0076,0.0172), vec3(0.0112,0.0158,0.0246), lowf);',
    '  c += vec3(0.0011,0.0038,0.0029)*pow(1.0-ay, 3.2);',
    '  float town = smoothstep(0.02, 0.72, dir.x);',
    '  c += vec3(0.0210,0.0150,0.0072)*pow(1.0-ay, 34.0)*town;',
    '  float mg = max(dot(dir, uSkyMoonDir), 0.0);',
    '  c += vec3(0.040,0.086,0.225)*clamp(uSkyMoonE,0.0,1.0)*(0.48+0.52*mg*mg)*(0.42+0.58*lowf);',
    '  c += vec3(0.30,0.40,0.62)*uSkyMoonE*(0.26*pow(mg,220.0)+0.070*pow(mg,22.0)+0.012*pow(mg,3.0));',
    '  return c*uSkyNight; }',
    '',
    '/* ---- the two public entry points ------------------------------------- */',
    'vec3 skyRadianceNoSun(vec3 dir, vec3 sun){',
    '  vec3 c = skyRadianceBase(dir,sun) + sailNightSky(dir);',
    '  vec4 cl = sailCloudSample(dir);',
    '  return c*cl.a + cl.rgb; }',
    'vec3 skyRadiance(vec3 dir, vec3 sun){',
    '  vec3 c = skyRadianceBase(dir,sun) + sailNightSky(dir) + sailSunDisc(dir,sun) + sailMoonDisc(dir);',
    '  vec4 cl = sailCloudSample(dir);',
    '  return c*cl.a + cl.rgb; }',
    'vec3 sailSunIrradiance(){ return uSkySunTint*uSkySunE; }',
    '',
    '/* ---- aerial perspective ---------------------------------------------- */',
    '/* mean column density of an exponential atmosphere along a straight path  */',
    'float sailPathDens(float y0, float y1, float dist, float H){',
    '  float dy = y1-y0; float a = exp(-max(y0,0.0)/H);',
    '  if (abs(dy) < 0.75) return dist*a*exp(-0.5*dy/H);',
    '  float b = exp(-max(y1,0.0)/H);',
    '  return dist*H*(a-b)/dy; }',
    'vec3 sailAerialTransmittance(vec3 wp, vec3 cp){',
    '  float dist = length(wp-cp);',
    '  float odR = sailPathDens(cp.y, wp.y, dist, 8000.0);',
    '  float odM = sailPathDens(cp.y, wp.y, dist, 1200.0) + 8.2*sailPathDens(cp.y, wp.y, dist, 360.0);',
    '  return exp(-(uSkyBetaR*odR + vec3(uSkyBetaMe*odM))*uSkyAerialGain); }',
    'vec3 aerialPerspective(vec3 col, vec3 wp, vec3 cp, vec3 sun){',
    '  vec3 d = wp-cp; float dist = length(d);',
    '  if (dist < 1.0) return col;',
    '  vec3 v = d/dist;',
    '  vec3 T = sailAerialTransmittance(wp, cp);',
    '  vec3 ins = skyRadianceNoSun(vec3(v.x, max(v.y,-0.03), v.z), sun);',
    '  return col*T + ins*(vec3(1.0)-T); }',
    'vec3 applyAerial(vec3 col, vec3 wp, vec3 cp){ return aerialPerspective(col, wp, cp, uSkySunDir); }',
    '#endif'
  ].join('\n');

  /* SAIL_SUNR_SCALE is patched in so the disc radiance stays a single knob. */
  GLSL = GLSL.replace('SAIL_SUNR_SCALE', SUN_DISC_L.toFixed(1));

  S.glsl = GLSL;
  S.shaderChunk = GLSL;
  S.skyGLSL = GLSL;
  S.aerialGLSL = GLSL;
  if (THREE.ShaderChunk) THREE.ShaderChunk.sail_sky = GLSL;

  /* ====================================================================== */
  /*  private renderer plumbing                                             */
  /* ====================================================================== */
  var renderer = null, scene = null;
  var quadScene = null, quadCam = null, quadMesh = null;
  var rtTrans = null, rtSky = null, rtCloud = null, rtNoise = null;
  var rtShape = null, rtDet = null, rtShadow = null, matShadow = null;
  var matTrans = null, matSky = null, matCloud = null, matNoise = null, domeMat = null;
  var dome = null, envDome = null, envScene = null, pmrem = null, envRT = null;
  var hdrOK = true, lutType = THREE.HalfFloatType;

  function makeQuad() {
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    quadMesh = new THREE.Mesh(g, null);
    quadMesh.frustumCulled = false;
    quadScene = new THREE.Scene(); quadScene.add(quadMesh);
    quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }
  var QUAD_VS = 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }';

  function blit(mat, target, scissor) {
    if (!renderer || !mat) return;
    var oldT = renderer.getRenderTarget(), oldAC = renderer.autoClear;
    quadMesh.material = mat;
    renderer.setRenderTarget(target || null);
    renderer.autoClear = false;
    if (scissor) {
      renderer.setScissorTest(true);
      renderer.setScissor(scissor[0], scissor[1], scissor[2], scissor[3]);
    } else {
      renderer.setScissorTest(false);
      renderer.clear(true, false, false);
    }
    renderer.render(quadScene, quadCam);
    renderer.setScissorTest(false);
    renderer.autoClear = oldAC;
    renderer.setRenderTarget(oldT);
  }

  function makeRT(w, h, type) {
    var rt = new THREE.WebGLRenderTarget(w, h, {
      type: type, format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false
    });
    rt.texture.colorSpace = THREE.LinearSRGBColorSpace;
    return rt;
  }

  function post(mat) {                    // common ShaderMaterial settings
    mat.depthTest = false; mat.depthWrite = false;
    mat.toneMapped = false; mat.blending = THREE.NoBlending;
    return mat;
  }

  /* ---------------------------------------------------------- atmosphere GLSL
     Shared by the transmittance and sky-view passes.                        */
  var ATMO = [
    'precision highp float;',
    '#define ATM_RG 6360.0',
    '#define ATM_RA 6420.0',
    '#define ATM_PI 3.141592653589793',
    'const vec3 BR = vec3(' + BETA_R[0] + ',' + BETA_R[1] + ',' + BETA_R[2] + ');',
    'const vec3 BO = vec3(' + BETA_O[0] + ',' + BETA_O[1] + ',' + BETA_O[2] + ');',
    'const float BM = ' + BETA_M + ';',
    'const float BME = ' + BETA_M_E + ';',
    'uniform float uHazeK;',
    'float atmDR(float h){ return exp(-max(h,0.0)/8.0); }',
    /* Marine slab: 6.5 x exp(-h/0.45) -> 8.2 x exp(-h/0.36).  Same total column
       mass (2.925 vs 2.952 km-equivalent, so every CPU tau constant survives)
       but packed into a 360 m layer instead of a 450 m one.  Airmass through an
       exponential slab of scale height H goes as H/sin(elev), so squeezing H
       makes the horizon brightening EXPONENTIAL in elevation rather than the
       near-linear ramp the review measured: at 2 deg the ray carries 10 km of
       slab, at 10 deg only 2 km, and the glow collapses into the bottom few
       degrees where it belongs. */
    'float atmDM(float h){ h = max(h,0.0); return exp(-h/1.2) + 8.2*uHazeK*exp(-h/0.36); }',
    'float atmDO(float h){ return max(0.0, 1.0 - abs(h-25.0)/15.0); }',
    'vec3 atmExt(float h){ return BR*atmDR(h) + vec3(BME*atmDM(h)) + BO*atmDO(h); }',
    'float atmTop(float r, float mu){',
    '  float d = r*r*(mu*mu-1.0) + ATM_RA*ATM_RA;',
    '  return max(-r*mu + sqrt(max(d,0.0)), 0.0); }'
  ].join('\n');

  /* ----------------------------------------------------------- transmittance */
  var hazeK = { value: 1.0 };

  function buildTransmittance() {
    if (rtTrans) { blit(matTrans, rtTrans); return; }
    rtTrans = makeRT(256, 64, lutType);
    matTrans = post(new THREE.ShaderMaterial({
      uniforms: { uSize: { value: new THREE.Vector2(256, 64) }, uHazeK: hazeK },
      vertexShader: QUAD_VS,
      fragmentShader: ATMO + '\n' + [
        'uniform vec2 uSize;',
        'void main(){',
        '  vec2 p = gl_FragCoord.xy/uSize;',
        '  float H = sqrt(ATM_RA*ATM_RA - ATM_RG*ATM_RG);',
        '  float rho = H*p.y;',
        '  float r = sqrt(rho*rho + ATM_RG*ATM_RG);',
        '  float dmin = ATM_RA - r, dmax = rho + H;',
        '  float d = dmin + p.x*(dmax-dmin);',
        '  float mu = (d < 1e-4) ? 1.0 : clamp((H*H - rho*rho - d*d)/(2.0*r*d), -1.0, 1.0);',
        '  float tmax = atmTop(r, mu);',
        '  vec3 od = vec3(0.0);',
        '  const int N = 40;',
        '  for (int i=0;i<N;i++){',
        '    float f0 = float(i)/float(N), f1 = float(i+1)/float(N);',
        '    float t0 = tmax*f0*f0, t1 = tmax*f1*f1;',
        '    float tm = 0.5*(t0+t1);',
        '    float rr = sqrt(max(r*r + tm*tm + 2.0*r*tm*mu, 1.0));',
        '    od += atmExt(rr-ATM_RG)*(t1-t0); }',
        '  gl_FragColor = vec4(exp(-od), 1.0); }'
      ].join('\n')
    }));
    blit(matTrans, rtTrans);
    U.uSkyTransLUT.value = rtTrans.texture;
    U.uSkyTransSize.value.set(256, 64);
  }

  /* --------------------------------------------------------------- sky view */
  function buildSkyLUT(w, h, steps) {
    if (rtSky) { rtSky.dispose(); rtSky = null; }
    if (matSky) { matSky.dispose(); matSky = null; }
    rtSky = makeRT(w, h, lutType);
    matSky = post(new THREE.ShaderMaterial({
      defines: { SKY_STEPS: steps },
      uniforms: {
        uSize: { value: new THREE.Vector2(w, h) },
        uSun: { value: U.uSkySunDir.value },
        uTrans: { value: rtTrans.texture },
        uTransSize: { value: U.uSkyTransSize.value },
        uSunIrr: { value: new THREE.Vector3(178, 178, 178) },
        /* 0.92 -> 0.74.  This term is the only GREY, near-isotropic source in
           the model, so its weight IS the zenith desaturation knob and it is
           also what spreads the golden-hour warmth uniformly round the compass.
           Both review defects (zenith G/B 0.68 vs 0.62 target; azimuthally flat
           cream band) trace to the same over-weighted fill. */
        uMS: { value: 0.74 },
        uMieG: { value: 0.820 },
        uScale: { value: 1.0 },
        uHazeK: hazeK
      },
      vertexShader: QUAD_VS,
      fragmentShader: ATMO + '\n' + [
        'uniform vec2 uSize, uTransSize; uniform vec3 uSun, uSunIrr;',
        'uniform sampler2D uTrans; uniform float uMS, uMieG, uScale;',
        'vec3 trans(float r, float mu){',
        '  float H = sqrt(ATM_RA*ATM_RA - ATM_RG*ATM_RG);',
        '  float rho = sqrt(max((r-ATM_RG)*(r+ATM_RG),0.0));',
        '  float d = atmTop(r,mu), dmin = ATM_RA-r, dmax = rho+H;',
        '  vec2 uv = vec2(clamp((d-dmin)/max(dmax-dmin,1e-4),0.0,1.0), clamp(rho/H,0.0,1.0));',
        '  uv = clamp(uv, 0.5/uTransSize, 1.0-0.5/uTransSize);',
        '  return texture2D(uTrans, uv).rgb; }',
        'float hg(float c, float g){ float g2=g*g; float d=1.0+g2-2.0*g*c;',
        '  return (1.0-g2)/(4.0*ATM_PI*max(d*sqrt(max(d,1e-4)),1e-4)); }',
        'void main(){',
        '  vec2 p = gl_FragCoord.xy/uSize;',
        '  float A = p.x*ATM_PI;',
        '  float s = p.y*2.0-1.0;',
        '  float el = (s<0.0?-1.0:1.0)*s*s*(0.5*ATM_PI);',
        '  vec2 sh = uSun.xz; float sl = length(sh); sh = sl>1e-6 ? sh/sl : vec2(1.0,0.0);',
        '  vec2 pp = vec2(-sh.y, sh.x);',
        '  vec2 hh = sh*cos(A) + pp*sin(A);',
        '  float ce = cos(el);',
        '  vec3 dir = vec3(hh.x*ce, sin(el), hh.y*ce);',
        '  float r0 = ATM_RG + 0.002;',
        '  float mu = dir.y;',
        '  float tTop = atmTop(r0, mu);',
        '  float tMax = tTop;',
        '  float disc = r0*r0*(mu*mu-1.0) + ATM_RG*ATM_RG;',
        '  bool ground = false;',
        '  if (mu < 0.0 && disc > 0.0){ float tg = -r0*mu - sqrt(disc); if (tg > 0.0){ tMax = tg; ground = true; } }',
        '  tMax = min(tMax, 600.0);',
        '  float nu = dot(dir, uSun);',
        '  float pr = (3.0/(16.0*ATM_PI))*(1.0+nu*nu);',
        '  float pm = hg(nu, uMieG);',
        '  vec3 L = vec3(0.0), T = vec3(1.0);',
        '  for (int i=0;i<SKY_STEPS;i++){',
        '    float f0 = float(i)/float(SKY_STEPS), f1 = float(i+1)/float(SKY_STEPS);',
        '    float t0 = tMax*f0*f0, t1 = tMax*f1*f1;',
        '    float dt = t1-t0; if (dt < 1e-6) continue;',
        '    float tm = 0.5*(t0+t1);',
        '    vec3 q = vec3(dir.x*tm, r0 + dir.y*tm, dir.z*tm);',
        '    float r = max(length(q), ATM_RG);',
        '    float hgt = r - ATM_RG;',
        '    vec3 up = q/r;',
        '    float muS = dot(up, uSun);',
        '    float ch = -sqrt(max(1.0 - (ATM_RG*ATM_RG)/(r*r), 0.0));',
        '    float shd  = smoothstep(ch-0.0075, ch+0.0075, muS+0.0026);',
        '    float shdM = smoothstep(ch-0.075,  ch+0.075,  muS+0.0026);',
        '    vec3 Tl = trans(r, max(muS, ch+1e-4));',
        '    vec3 sR = BR*atmDR(hgt);',
        '    vec3 sM = vec3(BM*atmDM(hgt));',
        '    vec3 ext = max(atmExt(hgt), vec3(1e-9));',
        '    vec3 inS = (sR*pr + sM*pm)*(Tl*shd);',
        '    /* Multiple scattering.  This used to be a fat ISOTROPIC term with',
        '       sqrt(Tl): at low sun it painted the entire hemisphere the same',
        '       warm value (the beige golden-hour wash) and at noon it poured',
        '       grey Mie into the zenith and killed the Rayleigh saturation.',
        '       Keep it weak, keep it spectrally Rayleigh-dominated, and let it',
        '       inherit some of the single-scatter angular shape so the sky stays',
        '       directional.  The exponent matters more than the weight: photons',
        '       that reach the zenith after two or more scatterings did NOT come',
        '       down the reddened horizon path, so attenuating this term by the',
        '       full direct transmittance is what painted the zenith orange.',
        '       Tl^0.5 de-reddens it and leaves the term Rayleigh-dominated, so',
        '       it lifts the zenith as BLUE while the solar 40 deg stays gold. */',
        '    /* AND the weight matters as much as the exponent.  At uMS = 1.05',
        '       this term was ~3x the single-scatter at the zenith, and because',
        '       it carried a big grey Mie fraction it dragged the zenith red/blue',
        '       ratio from 0.23 up to 0.51 — a washed-out humid-English blue',
        '       instead of a Caribbean one, and at low sun it filled the whole',
        '       hemisphere with the beige that made the sunset cross through',
        '       neutral grey.  Real second-and-higher-order scattering in a clear',
        '       tropical sky adds ~25-40% at the zenith, not 300%, and it is',
        '       overwhelmingly Rayleigh (the aerosol is a thin low slab that most',
        '       photons never scatter off twice).  So: weight down hard, and keep',
        '       the Mie fraction token. */',
        '    /* Exponent 0.44 -> 0.28.  At golden hour Tl is deeply reddened, so a',
        '       high exponent poured RED into the multiply-scattered term and the',
        '       anti-solar upper sky came out (91,119,159) — R/B 0.57, a smoggy',
        '       lavender.  Multiply-scattered photons did not travel the reddened',
        '       horizon path, so de-redden hard and leave the term Rayleigh-blue. */',
        '    vec3 Tms = pow(max(Tl, vec3(1e-5)), vec3(0.22));',
        '    /* THE MULTIPLE-SCATTER TERM MUST STAY DIRECTIONAL.  A flat 0.72',
        '       pedestal made the fill isotropic, and at golden hour an isotropic',
        '       fill paints the same cream value at the sun bearing and 180 deg',
        '       off it — which is exactly the "warm band spans the full width at',
        '       even intensity" failure.  Second-order photons in a real airmass',
        '       still remember the forward lobe of the first scattering event, so',
        '       carry a normalised HG(0.55) through: mean 1 over the sphere,',
        '       ~7.6x at the sun bearing, ~0.19x at the antisolar point.  Net',
        '       azimuthal contrast in this term is ~2.7x, and the horizon cools to',
        '       neutral blue-grey by 90 deg off-sun.  Mie fraction 0.04 -> 0.015',
        '       because the grey part of this term is what desaturates the zenith. */',
        '    float msFwd = clamp(hg(nu, 0.55)*4.0*ATM_PI, 0.0, 24.0);',
        '    float msPh = max(0.70 + 0.16*(pr*4.0*ATM_PI/3.0) + 0.145*(msFwd - 1.0), 0.30);',
        '    vec3 iso = (sR + sM*0.015)*(0.25/ATM_PI)*(Tms*shdM)*msPh;',
        '    vec3 stepT = exp(-ext*dt);',
        '    L += T*((inS + iso*uMS)*(vec3(1.0)-stepT)/ext);',
        '    T *= stepT; }',
        '  if (ground){',
        '    float muS = dot(normalize(vec3(dir.x*tMax, r0+dir.y*tMax, dir.z*tMax)), uSun);',
        '    vec3 gT = trans(ATM_RG+0.0005, max(muS,0.0));',
        '    /* Sea bounce.  6% albedo, and BLUER than it was: a 0.55/0.75/1.0',
        '       ground tint is nearly grey and it was lifting the green channel of',
        '       every downward-looking ray, which the sky-view LUT then hands back',
        '       to the ocean shader as reflected sky. */',
        '    L += T*(0.017/ATM_PI)*max(muS,0.0)*gT*vec3(0.34,0.58,1.0); }',
        '  L *= uSunIrr;',
        '  L = max(L, vec3(0.0));',
        '  float lm = dot(L, vec3(0.3333)); if (!(lm < 1e5)) L = vec3(0.0);',
        '  gl_FragColor = vec4(min(L, vec3(12000.0))/uScale, 1.0); }'
      ].join('\n')
    }));
    U.uSkyLUT.value = rtSky.texture;
    U.uSkyLutSize.value.set(w, h);
  }

  /* ------------------------------------------------------------ cloud noise
     THREE textures, all built once on the GPU:

       rtNoise  256x256 RGBA8, RepeatWrapping — the WEATHER MAP.  Purely 2D and
                purely synoptic: r = coverage, g = cloud type (pancake..tower),
                b = condensation-level jitter, a = a second, larger coverage
                scale so clusters cluster.

       rtShape  520x520 RGBA8 — a TILEABLE 64^3 VOLUME packed as an 8x8 grid of
                65x65 z-slices.  r = Perlin-Worley, gba = inverted-Worley fbm at
                three rising frequencies.  This replaces the old 2D extrusion:
                a 2D field translated with height is still invariant along a
                fixed 3D direction, so every iso-surface was a RULED surface —
                which is exactly why the old clouds read as prismatic blades.

       rtDet    264x132 RGBA8 — a tileable 32^3 volume, 8x4 grid of 33x33
                slices.  r = fine Worley fbm (the edge erosion), gba = a
                normalised CURL vector used to warp the second erosion tap so
                the bites come out wispy and swirled instead of cellular.

     The 65th row/column of every tile DUPLICATES the 0th, so hardware bilinear
     wraps exactly across the tile seam; only the z axis needs a manual lerp
     (two taps).  That is what makes a 2D atlas behave like a wrapped 3D
     texture without a single GLSL-version change.

     NO MIPMAPS anywhere: every tap happens inside a raymarch where the screen
     derivatives that drive LOD are meaningless.  Frequency control is done
     explicitly, per octave, against the actual step length (see clDens).    */

  var NOISE3 = [
    'vec3 h33(vec3 p){',
    '  p = vec3(dot(p,vec3(127.1,311.7,74.7)), dot(p,vec3(269.5,183.3,246.1)), dot(p,vec3(113.5,271.9,124.6)));',
    '  return fract(sin(p+0.71)*43758.5453123); }',
    'float h13(vec3 p){ return fract(sin(dot(p+0.37, vec3(127.1,311.7,74.7))+1.7)*43758.5453123); }',
    'float vn3(vec3 p, float per){',
    '  vec3 i = floor(p), f = fract(p); vec3 u = f*f*(3.0-2.0*f);',
    '  float a=h13(mod(i,per)),               b=h13(mod(i+vec3(1.0,0.0,0.0),per));',
    '  float c=h13(mod(i+vec3(0.0,1.0,0.0),per)), d=h13(mod(i+vec3(1.0,1.0,0.0),per));',
    '  float e=h13(mod(i+vec3(0.0,0.0,1.0),per)), g=h13(mod(i+vec3(1.0,0.0,1.0),per));',
    '  float k=h13(mod(i+vec3(0.0,1.0,1.0),per)), m=h13(mod(i+vec3(1.0,1.0,1.0),per));',
    '  return mix(mix(mix(a,b,u.x),mix(c,d,u.x),u.y), mix(mix(e,g,u.x),mix(k,m,u.x),u.y), u.z); }',
    'float fbm3(vec3 p, float per, int oct){',
    '  float s=0.0, a=0.5, n=0.0;',
    '  for (int i=0;i<6;i++){ if (i>=oct) break;',
    '    s += a*vn3(p, per); n += a; p *= 2.0; per *= 2.0; a *= 0.5; }',
    '  return s/max(n,1e-4); }',
    'float wor3(vec3 p, float per){',
    '  vec3 i = floor(p), f = fract(p); float m = 4.0;',
    '  for (int z=-1;z<=1;z++) for (int y=-1;y<=1;y++) for (int x=-1;x<=1;x++){',
    '    vec3 g = vec3(float(x), float(y), float(z));',
    '    vec3 o = h33(mod(i+g, per));',
    '    m = min(m, dot(g+o-f, g+o-f)); }',
    '  return clamp(sqrt(m), 0.0, 1.0); }',
    'float worFbm(vec3 p, float f0){',
    '  float a = 1.0 - wor3(p*f0,       f0);',
    '  float b = 1.0 - wor3(p*f0*2.0,   f0*2.0);',
    '  float c = 1.0 - wor3(p*f0*4.0,   f0*4.0);',
    '  return clamp(a*0.571 + b*0.286 + c*0.143, 0.0, 1.0); }'
  ].join('\n');

  function buildNoise() {
    if (rtNoise) return;

    /* ---------------------------------------------------- weather map (2D) */
    rtNoise = new THREE.WebGLRenderTarget(256, 256, {
      type: THREE.UnsignedByteType, format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false
    });
    rtNoise.texture.colorSpace = THREE.LinearSRGBColorSpace;
    matNoise = post(new THREE.ShaderMaterial({
      uniforms: {}, vertexShader: QUAD_VS,
      fragmentShader: [
        'precision highp float;',
        'float h1(vec2 p){ return fract(sin(dot(p+0.71,vec2(127.1,311.7))+1.7)*43758.5453123); }',
        'float vn(vec2 p, float per){',
        '  vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);',
        '  float a=h1(mod(i,per)), b=h1(mod(i+vec2(1,0),per));',
        '  float c=h1(mod(i+vec2(0,1),per)), d=h1(mod(i+vec2(1,1),per));',
        '  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y); }',
        'float fbm(vec2 p, float per, int oct){',
        '  float s=0.0, a=0.5, n=0.0;',
        '  for (int i=0;i<6;i++){ if (i>=oct) break;',
        '    s += a*vn(p, per); n += a; p *= 2.0; per *= 2.0; a *= 0.5; }',
        '  return s/max(n,1e-4); }',
        'vec2 h22(vec2 p){',
        '  p = vec2(dot(p,vec2(127.1,311.7)), dot(p,vec2(269.5,183.3)));',
        '  return fract(sin(p+0.31)*43758.5453123); }',
        '/* WORLEY CELLS, not fBm.  fBm remapped to 0..1 plateaus: adjacent lobes',
        '   merge into a continuous 64%-coverage wall with two holes in the whole',
        '   sky.  A cellular base gives DISCRETE convective cells with genuine',
        '   blue between them, which is what trade-wind cumulus actually is.',
        '   Returns .x = distance to the nearest feature point in cell units,',
        '   .yz = that cell\'s wrapped integer id (so per-cell constants can be',
        '   hashed off it — this is how every cloud gets ONE flat base). */',
        'vec3 cellF1(vec2 p, float per){',
        '  vec2 i = floor(p), f = fract(p);',
        '  float best = 9.0; vec2 bid = i;',
        '  for (int y=-1;y<=1;y++) for (int x=-1;x<=1;x++){',
        '    vec2 g = vec2(float(x), float(y));',
        '    vec2 id = mod(i+g, per);',
        '    vec2 r = g + h22(id) - f;',
        '    float dd = dot(r,r);',
        '    if (dd < best){ best = dd; bid = id; } }',
        '  return vec3(sqrt(best), bid); }',
        'void main(){',
        '  vec2 uv = gl_FragCoord.xy/256.0;',
        '  /* 10 cells across the 26 km tile => ~2.6 km cell pitch, which is the',
        '     real spacing of Caribbean trade cumulus. */',
        '  vec3 cf = cellF1(uv*10.0, 10.0);',
        '  vec2 cid = cf.yz;',
        '  float r1 = h22(cid*1.7  + 3.1 ).x;',
        '  float r3 = h22(cid*5.3  + 27.7).x;',
        '  float r4 = h22(cid*0.61 + 41.9).y;',
        '  /* PER-CELL RADIUS, skewed so most cells are modest and a few are very',
        '     large — a real field has one huge near cloud and a crowd of little',
        '     ones, not one uniform angular size everywhere.  The floor matters:',
        '     a cumulus is about as wide as it is tall, so a cell narrower than',
        '     ~900 m turns into a vertical PILLAR once the slab is 1.6 km deep. */',
        '  float rad = mix(0.21, 0.56, r1*r1);',
        '  float cell = 1.0 - smoothstep(rad*0.40, rad, cf.x);',
        '  /* ragged the rim so cells are lobed, not discs — but multiplicative,',
        '     so it can never re-open the gaps between cells. */',
        '  float rag = fbm(uv*30.0 + r1*23.0, 30.0, 3);',
        '  cell = clamp(cell*(0.66 + 0.72*rag), 0.0, 1.0);',
        '  cell = cell*cell*(3.0 - 2.0*cell);',
        '  /* CLOUD STREETS: a 5-13 km modulator that opens long clear lanes and',
        '     packs the cells into rows.  This is what breaks the "every cloud the',
        '     same size in one band" reading. */',
        '  float st = fbm(uv*2.0 + 4.3, 2.0, 3);',
        '  st = smoothstep(0.33, 0.63, st);',
        '  float st2 = fbm(uv*5.0 + 19.7, 5.0, 3);',
        '  st = clamp(st*(0.34 + 0.95*smoothstep(0.28, 0.72, st2)), 0.0, 1.0);',
        '  /* g = per-cell vertical extent.  CORRELATED WITH THE RADIUS: a real',
        '     cumulus is roughly as tall as it is wide, so a small cell must be a',
        '     flat pancake and only the big cells become congestus towers.  Left',
        '     decorrelated, every small cell grew into a chimney.  r4 adds a',
        '     little spread around that relation so it is not a rigid formula.',
        '     b = per-cell condensation level, CONSTANT across the cell so the',
        '     base of each cloud is one razor-straight plane. */',
        '  float vext = clamp(r1*r1*1.25 + 0.46*(r4 - 0.5), 0.0, 1.0);',
        '  gl_FragColor = vec4(cell, vext, r3, st); }'
      ].join('\n')
    }));
    blit(matNoise, rtNoise);

    /* -------------------------------------------------- shape volume 64^3 */
    rtShape = new THREE.WebGLRenderTarget(520, 520, {
      type: THREE.UnsignedByteType, format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false
    });
    rtShape.texture.colorSpace = THREE.LinearSRGBColorSpace;
    var matShape = post(new THREE.ShaderMaterial({
      uniforms: {}, vertexShader: QUAD_VS,
      fragmentShader: [
        'precision highp float;', NOISE3,
        'void main(){',
        '  vec2 fc = floor(gl_FragCoord.xy);',
        '  vec2 tl = floor(fc/65.0);',
        '  float sl = tl.y*8.0 + tl.x;',
        '  vec2 it = fc - tl*65.0;',
        '  vec3 ip = vec3(mod(it.x,64.0), mod(it.y,64.0), sl);',
        '  vec3 p = ip/64.0;',
        '  float pf = fbm3(p*4.0, 4.0, 5);',
        '  pf = clamp((pf-0.26)/0.50, 0.0, 1.0);',
        '  float wLo = worFbm(p, 3.0);',
        '  /* Perlin-Worley: the fbm gives connected, wind-blown structure, the',
        '     inverted Worley gives round convective lumps.  Remapping one by',
        '     the other is what produces cauliflower rather than either a smooth',
        '     blob field or a cell network. */',
        '  float pw = clamp((pf - (1.0-wLo))/max(wLo, 1e-3), 0.0, 1.0);',
        '  float G = wLo;',
        '  float B = worFbm(p, 6.0);',
        '  float A = clamp(1.0 - wor3(p*12.0, 12.0), 0.0, 1.0);',
        '  gl_FragColor = vec4(pw, G, B, A); }'
      ].join('\n')
    }));
    blit(matShape, rtShape);
    matShape.dispose();

    /* ------------------------------------------------- detail volume 32^3 */
    rtDet = new THREE.WebGLRenderTarget(264, 132, {
      type: THREE.UnsignedByteType, format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false
    });
    rtDet.texture.colorSpace = THREE.LinearSRGBColorSpace;
    var matDet = post(new THREE.ShaderMaterial({
      uniforms: {}, vertexShader: QUAD_VS,
      fragmentShader: [
        'precision highp float;', NOISE3,
        '/* vector potential -> curl.  Integer offsets keep the lattice period',
        '   intact so the curl field tiles with the volume. */',
        'vec3 pot(vec3 p){',
        '  return vec3(fbm3(p*3.0,                        3.0, 3),',
        '              fbm3(p*3.0 + vec3(31.0,17.0, 5.0), 3.0, 3),',
        '              fbm3(p*3.0 + vec3( 7.0,41.0,23.0), 3.0, 3)); }',
        'vec3 curl3(vec3 p){',
        '  float h = 0.03;',
        '  vec3 dx = pot(p+vec3(h,0.0,0.0)) - pot(p-vec3(h,0.0,0.0));',
        '  vec3 dy = pot(p+vec3(0.0,h,0.0)) - pot(p-vec3(0.0,h,0.0));',
        '  vec3 dz = pot(p+vec3(0.0,0.0,h)) - pot(p-vec3(0.0,0.0,h));',
        '  return vec3(dy.z-dz.y, dz.x-dx.z, dx.y-dy.x); }',
        'void main(){',
        '  vec2 fc = floor(gl_FragCoord.xy);',
        '  vec2 tl = floor(fc/33.0);',
        '  float sl = tl.y*8.0 + tl.x;',
        '  vec2 it = fc - tl*33.0;',
        '  vec3 ip = vec3(mod(it.x,32.0), mod(it.y,32.0), sl);',
        '  vec3 p = ip/32.0;',
        '  float d = worFbm(p, 3.0)*0.62 + (1.0 - wor3(p*8.0, 8.0))*0.38;',
        '  vec3 c = curl3(p);',
        '  c = c/max(length(c), 1e-4);',
        '  gl_FragColor = vec4(clamp(d,0.0,1.0), c*0.5+0.5); }'
      ].join('\n')
    }));
    blit(matDet, rtDet);
    matDet.dispose();
  }

  /* ------------------------------------------------------- land mask texture
     Drives "trade cumulus builds over the island, thinner over open sea".
     Built from a coarse analytic coastline, refined from SAIL.island /
     SAIL.world depthAt() the first time one of them exists.                 */
  var landTex = null, landRefined = false;
  var LAND_ORIGIN = -6000, LAND_SPAN = 12000, LAND_N = 64;

  function analyticLand(x, z) {
    var coast = -572 + 74 * Math.sin(z * 0.0041) + 38 * Math.sin(z * 0.0117 + 1.3) + 22 * Math.sin(z * 0.026 - 0.4);
    var land = smoothstepf(coast - 60, coast + 240, x);
    var e = Math.hypot(x / 268, z / 214);                 // St George's lagoon
    land *= 1.0 - 0.85 * smoothstepf(1.25, 0.55, e);
    return clamp(land, 0, 1);
  }

  function buildLandTex(useWorld) {
    var N = LAND_N, data = new Uint8Array(N * N * 4);
    var probe = null;
    if (useWorld) {
      if (SAIL.island && typeof SAIL.island.depthAt === 'function') probe = SAIL.island.depthAt;
      else if (SAIL.world && typeof SAIL.world.depthAt === 'function') probe = SAIL.world.depthAt;
    }
    for (var j = 0; j < N; j++) {
      for (var i = 0; i < N; i++) {
        var x = LAND_ORIGIN + (i + 0.5) / N * LAND_SPAN;
        var z = LAND_ORIGIN + (j + 0.5) / N * LAND_SPAN;
        var v;
        if (probe) {
          var d = 0;
          try { d = probe(x, z); } catch (e) { d = 1; }
          v = d < 0.05 ? 1 : clamp(1 - d / 6, 0, 1) * 0.35;
        } else v = analyticLand(x, z);
        var k = (j * N + i) * 4;
        data[k] = data[k + 1] = data[k + 2] = Math.round(v * 255); data[k + 3] = 255;
      }
    }
    // one 3x3 blur pass so cumulus fields are smoothly larger than the island
    var out = new Uint8Array(data.length);
    for (var jj = 0; jj < N; jj++) for (var ii = 0; ii < N; ii++) {
      var s = 0, n = 0;
      for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) {
        var a = clamp(ii + dx, 0, N - 1), b = clamp(jj + dy, 0, N - 1);
        s += data[(b * N + a) * 4]; n++;
      }
      var kk = (jj * N + ii) * 4, vv = Math.round(s / n);
      out[kk] = out[kk + 1] = out[kk + 2] = vv; out[kk + 3] = 255;
    }
    var tex = new THREE.DataTexture(out, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.colorSpace = THREE.LinearSRGBColorSpace;
    tex.needsUpdate = true;
    if (landTex) landTex.dispose();
    landTex = tex;
    if (matCloud) matCloud.uniforms.uLand.value = landTex;
    return tex;
  }

  /* ====================================================================== */
  /*  CLOUDS                                                                */
  /*  One volumetric model, two consumers:                                  */
  /*    (a) a panoramic LUT, amortised over N bands, which feeds ocean       */
  /*        reflections, the PMREM environment and aerial perspective;       */
  /*    (b) a reduced-resolution SCREEN-SPACE march with temporal            */
  /*        reprojection, which is what the visible dome actually shows.     */
  /*  (b) exists because no spherical LUT can ever resolve a 0.032 deg/px    */
  /*  viewport: 360 deg across 1024 texels is 0.35 deg/texel, an 11x         */
  /*  magnification.  Reflections tolerate that; the sky itself does not.    */
  /*                                                                        */
  /*  The field is trade-wind cumulus: one flat condensation base at ~720 m  */
  /*  and cells whose tops climb to 2600 m.  Towers come from a coverage     */
  /*  threshold that RISES with normalised height inside the cell, so only   */
  /*  the strongest cores survive upward — a cauliflower profile — while a   */
  /*  low-frequency "cloud type" field lets flat 300 m pancakes and 1800 m   */
  /*  towers coexist in the same sky.                                       */
  /* ====================================================================== */
  var CLOUD_FIELD = [
    'uniform sampler2D uWeather, uShapeVol, uDetVol, uLand;',
    'uniform vec2 uWind, uCover, uShear, uRes;',
    'uniform vec3 uCam, uLightDir, uLightCol;',
    'uniform float uT, uSigma, uBase, uTop, uPowder, uAmb, uScale, uMaxD;',
    'uniform float uDirect, uErode, uFade, uDebug, uSunPath, uSunGate;',
    '',
    '#define SH_N 64.0',
    '#define SH_TW 65.0',
    '#define SH_TEX 520.0',
    '#define DT_N 32.0',
    '#define DT_TW 33.0',
    '',
    '/* --- tileable 3D fetch out of a 2D slice atlas ------------------------',
    '   The 65th (33rd) row and column of every tile duplicate the 0th, so the',
    '   hardware bilinear wraps EXACTLY across the tile seam.  Only z needs a',
    '   manual lerp, which is why this costs two taps and not eight.        */',
    '/* C1 INTERPOLATION ON ALL THREE AXES.',
    '   The volume is a 64^3 field sampled at 42 m per texel inside a 900 m cloud,',
    '   so the interpolant is magnified ~20x and its continuity class is visible',
    '   in the silhouette.  Hardware bilinear is C0: the gradient jumps at every',
    '   texel boundary, and because one in-slice axis IS world altitude those',
    '   jumps line up into horizontal terraces — the "stacked lenticular sheets"',
    '   and Minecraft staircases.  Pre-warping the fractional part of the texel',
    '   coordinate by smoothstep makes the SAME single bilinear tap behave like a',
    '   cubic interpolant, at zero extra cost and zero extra taps.  The z (slice)',
    '   axis gets the same treatment on its manual lerp. */',
    'vec2 sailTexC1(vec2 t){',
    '  vec2 i = floor(t), f = t - i;',
    '  f = f*f*(3.0 - 2.0*f);',
    '  return i + f + 0.5; }',
    'vec4 vol3s(vec3 p){',
    '  p = fract(p);',
    '  float zf = p.z*SH_N, z0 = floor(zf), fz = zf - z0;',
    '  fz = fz*fz*(3.0 - 2.0*fz);',
    '  vec2 uv = sailTexC1(p.xy*SH_N);',
    '  float s0 = mod(z0, SH_N), s1 = mod(z0+1.0, SH_N);',
    '  vec2 o0 = vec2(mod(s0,8.0), floor(s0/8.0))*SH_TW;',
    '  vec2 o1 = vec2(mod(s1,8.0), floor(s1/8.0))*SH_TW;',
    '  return mix(texture2D(uShapeVol, (o0+uv)/SH_TEX),',
    '             texture2D(uShapeVol, (o1+uv)/SH_TEX), fz); }',
    'vec4 vol3d(vec3 p){',
    '  p = fract(p);',
    '  float zf = p.z*DT_N, z0 = floor(zf), fz = zf - z0;',
    '  fz = fz*fz*(3.0 - 2.0*fz);',
    '  vec2 uv = sailTexC1(p.xy*DT_N);',
    '  float s0 = mod(z0, DT_N), s1 = mod(z0+1.0, DT_N);',
    '  vec2 o0 = vec2(mod(s0,8.0), floor(s0/8.0))*DT_TW;',
    '  vec2 o1 = vec2(mod(s1,8.0), floor(s1/8.0))*DT_TW;',
    '  vec2 TX = vec2(264.0, 132.0);',
    '  return mix(texture2D(uDetVol, (o0+uv)/TX),',
    '             texture2D(uDetVol, (o1+uv)/TX), fz); }',
    '',
    'float clLand(vec2 p){',
    '  vec2 uv = (p - vec2(' + LAND_ORIGIN.toFixed(1) + '))/' + LAND_SPAN.toFixed(1) + ';',
    '  return texture2D(uLand, clamp(uv, 0.004, 0.996)).r; }',
    '',
    'float rmp(float v, float a, float b){ return clamp((v-a)/max(b-a, 1e-4), 0.0, 1.0); }',
    '',
    '/* ======================================================================',
    '   clDens — density of the cumulus field at a world point.',
    '',
    '   dsm  = the length in METRES of the march step this sample stands for.',
    '          Every octave is gated against it, which is the whole reason the',
    '          old build combed: it fetched 7 m features with a 125 m step and',
    '          had no way to fade them out with distance.',
    '   lod  = 0 full (shape + curl-warped detail erosion)',
    '          1 shape only, no erosion  (sun march / occlusion taps)',
    '          2 cheapest conservative overestimate (empty-space probe)',
    '   hh   = out, height fraction WITHIN THIS CELL (not the slab), which is',
    '          what the shading wants: the top of a pancake is as sunlit as the',
    '          top of a tower.',
    '   thk  = out, the METRIC thickness of this cell.  clShade needs it to turn',
    '          hh into "how many metres of my own water is above me", which is',
    '          the term that makes the crown-over-base ratio monotone no matter',
    '          how coarse the stochastic sun march is.                        */',
    'float clDens(vec3 wp, float land, int lod, float dsm, out float hh, out float thk){',
    '  hh = 0.0; thk = 600.0;',
    '  vec2 q = wp.xz + uWind*uT;',
    '  vec4 wm = texture2D(uWeather, q/26000.0);',
    '  /* Coverage.  wm.r is now a WORLEY CELL field with real gaps, wm.a is the',
    '     5-13 km cloud-street modulator.  Multiplying them (rather than adding',
    '     a pedestal, which is what the old 0.26 + 1.58*wm.r did) is what keeps',
    '     the clear lanes genuinely clear instead of filling them with a thin',
    '     plateau that merges every cell into one wall. */',
    '  float cvr = clamp(uCover.x*1.90*wm.r*(0.28 + 1.20*wm.a) + uCover.y*land*wm.r, 0.0, 1.0);',
    '  if (cvr <= 0.006) return 0.0;',
    '  /* Cloud type: 0 = 350 m pancake, 1 = congestus tower.  Land lifts it.',
    '     Squared, so the tall ones are rare and genuinely tall (2-3x the mean)',
    '     rather than everything sitting at one middling height. */',
    '  /* Land bias 0.34 -> 0.13.  At 0.34 every cell over the island saturated',
    '     the clamp at type = 1.0, so every cell over the island topped out at',
    '     EXACTLY uTop — which is the unnaturally straight horizontal edge the',
    '     review found capping the tall cumulus.  Orographic lift should bias the',
    '     distribution, not collapse it, and the ceiling is now 0.96 so the clamp',
    '     is never the thing that sets a cloud top. */',
    '  float type = clamp(0.10 + 1.12*wm.g + 0.13*land, 0.06, 0.96);',
    '  /* PER-CELL CONDENSATION LEVEL, constant across the cell (wm.b is hashed',
    '     off the Worley cell id, not an fbm), so each cloud gets ONE razor-flat',
    '     base and neighbours differ by at most +/-55 m.  Big jitter is what made',
    '     the bases look random; no jitter is what made them look like a ruler. */',
    '  float cb = uBase + 74.0*(wm.b - 0.5) - 34.0*land;',
    '  /* Per-cell TOP spread.  wm.b is hashed off the Worley cell id so it is',
    '     constant across a cell: a 0.80-1.24x multiplier on the vertical',
    '     development means two cells of the same convective type still terminate',
    '     at different altitudes, and no population of cells shares one ceiling. */',
    '  float ct = cb + mix(300.0, uTop - uBase, type*type)*(0.80 + 0.44*wm.b);',
    '  float thick = max(ct - cb, 80.0);',
    '  thk = thick;',
    '  hh = (wp.y - cb)/thick;',
    '  if (hh > 1.05 || hh < -0.015) return 0.0;',
    '  float hc = clamp(hh, 0.0, 1.0);',
    '  /* THE LCL GATE — the defining silhouette feature of trade-wind cumulus.',
    '     A 22 m transition, evaluated in METRES so it is the same knife edge on a',
    '     300 m pancake and a 1900 m tower, and applied at every return path',
    '     INCLUDING after erosion (the dripping stalactite fringes were erosion',
    '     noise leaking through a gate applied too early).  Under 50 m of softening',
    '     is what the reference asks for, and it is what fixes the altitude cue:',
    '     with a soft base the eye has nothing to place the cloud deck against and',
    '     the whole sky loses its sense of scale. */',
    '  float gBot = smoothstep(0.0, 22.0/thick, hh);',
    '  if (gBot <= 0.0) return 0.0;',
    '',
    '  /* --- height gradient: billowing crown, anvil on the tall ------------- */',
    '  float anv  = smoothstep(0.74, 1.0, type)*smoothstep(0.60, 0.95, hc);',
    '  float tTop = mix(0.42, 0.72, type);',
    '  float gTop = smoothstep(1.10, tTop, hc);',
    '  gTop = mix(gTop, max(gTop, 0.60*smoothstep(1.06, 0.80, hc)), anv);',
    '  float grad = gBot*gTop;',
    '  if (grad <= 0.0) return 0.0;',
    '  /* THE CAULIFLOWER RULE.  The coverage threshold must RISE with height',
    '     inside the cell, so only the strongest convective cores survive upward',
    '     and the crown breaks into separate turrets of different heights.  Hold',
    '     coverage constant with height and the cell fills the whole slab to a',
    '     flat lid — a mesa, which is what the last pass produced. */',
    '  float hcv = 1.0 - 0.46*smoothstep(0.16, 1.0, hc);',
    '',
    '  /* --- base shape, 3D ------------------------------------------------- */',
    '  /* The sample position is DOMAIN-WARPED by a low-frequency curl field',
    '     before the volume fetch.  Without it the 64 z-slices of the shape atlas',
    '     are world-horizontal planes and every silhouette inherits an',
    '     axis-aligned staircase; with it no grid axis survives into the',
    '     silhouette and the terracing is gone.  y is stretched 1.55x so the 64',
    '     slices cover ~2.7 km — one slice per ~42 m of cloud instead of 66. */',
    '  vec3 wq = vec3(q.x + uShear.x*hc, wp.y*1.55, q.y + uShear.y*hc);',
    '  vec3 wr = vol3d(wq/5600.0).gba - 0.5;',
    '  vec3 P = (wq + wr*430.0)/4200.0;',
    '  vec4 sn = vol3s(P);',
    '  float fHi = 1.0 - smoothstep(0.85, 2.10, dsm/175.0);',
    '  float fMd = 1.0 - smoothstep(0.85, 2.10, dsm/350.0);',
    '  float wf = sn.g*0.545 + sn.b*0.305*fMd + sn.a*0.150*fHi;',
    '  float wn = 0.545 + 0.305*fMd + 0.150*fHi;',
    '  wf /= max(wn, 1e-3);',
    '  float shp = rmp(sn.r, wf - 1.0, 1.0);',
    '  float cov2 = clamp(cvr*hcv*(1.0 + 0.50*anv), 0.0, 1.0);',
    '  /* THE DENSITY MUST SATURATE.  The old remap spread 0 -> 1 across the whole',
    '     surviving range of the shape noise, so almost the entire volume of every',
    '     cloud sat on a ramp and the median density measured 0.15 — an extinction',
    '     of 0.009/m, roughly a tenth of real cumulus.  A ray then never',
    '     accumulated enough optical depth for anything to shadow anything, which',
    '     is the true root cause of the flat-white paper-cutout look: not the',
    '     lighting model, the density.  Remapping over the first 55% of the range',
    '     and clamping gives a genuine opaque PLATEAU with a thin rim, so cores',
    '     self-shadow and the sun march finally sees 20-40 optical depths. */',
    '  float cw = max(cov2*0.55, 0.05);',
    '  float d = clamp((shp - (1.0 - cov2))/cw, 0.0, 1.0)*mix(0.62, 1.12, cov2)*grad;',
    '  if (d <= 0.0) return 0.0;',
    '  /* denser toward the crown — the convective profile */',
    '  d *= mix(0.62, 1.38, smoothstep(0.03, 0.52, hc));',
    '  if (lod >= 1) return d;',
    '',
    '  /* --- edge erosion: curl-warped detail ------------------------------- */',
    '  /* CLAMPED so it can only ever bite the TRANSLUCENT flanks.  The old',
    '     rmp(d, dmod*ew, 1.0) was a subtract-and-renormalise that could reach',
    '     straight through an opaque core, and where a Worley cell boundary',
    '     happened to close on itself that came out as a perfect torus hole.',
    '     Scaling the bite by (1 - smoothstep(d)) makes a hole in a core',
    '     arithmetically impossible.  Three frequency bands, each gated on the',
    '     step length so they dissolve rather than beat against the lattice. */',
    '  /* Feature sizes 55 m / 24 m rather than 38 m / 16 m.  At a typical cumulus',
    '     distance of 3-8 km the march step is ~40 m, which gated the fine octave',
    '     completely off and left the interiors as smooth blobs — the "featureless',
    '     paper cutout" complaint.  Sized just above the step, both octaves',
    '     survive where the clouds actually are and still dissolve into clean',
    '     silhouette at the horizon instead of beating against the lattice. */',
    '  float f1 = 1.0 - smoothstep(0.70, 1.80, dsm/55.0);',
    '  float f2 = 1.0 - smoothstep(0.70, 1.80, dsm/24.0);',
    '  if (f1 <= 0.02) return d;',
    '  vec3 Pd = (wq + wr*150.0)/600.0 + vec3(0.0, uT*0.0022, 0.0);',
    '  vec4 dv = vol3d(Pd);',
    '  float dn = dv.r*0.60*f1, wsum = 0.60*f1;',
    '  if (f2 > 0.02){',
    '    vec3 crl = dv.gba*2.0 - 1.0;',
    '    dn += vol3d(Pd*2.35 + crl*0.30).r*0.40*f2; wsum += 0.40*f2; }',
    '  dn /= max(wsum, 1e-3);',
    '  /* wispy (inverted, filament-like) low in the cell, billowy at the top */',
    '  float dmod = mix(1.0 - dn, dn, clamp(hc*2.4, 0.0, 1.0));',
    '  float ew = uErode*(0.32 + 0.60*smoothstep(0.10, 0.95, hc));',
    '  ew *= clamp(wsum/0.60, 0.0, 1.0);',
    '  d = max(d - ew*dmod*(1.0 - smoothstep(0.13, 0.58, d)), 0.0);',
    '  /* gate AGAIN, after erosion, so nothing drips below the condensation',
    '     level; the erosion carves the flanks and the gate cuts the floor. */',
    '  return d*gBot; }',
    '',
    '/* ======================================================================',
    '   clLight — optical depth from wp to the sun, in metres of unit density.',
    '',
    '   TWO TERMS, and the second one is the whole fix for the inverted lighting.',
    '',
    '   (a) A stochastic exponential march, 6 taps from 34 m out to ~2.4 km.  The',
    '       old one stopped at 1.27 km, which at a 29 deg sun is only 610 m of',
    '       VERTICAL rise — less than half the depth of a congestus cell — so a',
    '       base point never saw the water above it and came back as lit as the',
    '       crown.  The perpendicular cone was also 0.22*t wide, i.e. +/-140 m at',
    '       the far tap, so most of the far samples fell out of the cloud',
    '       altogether and the little depth it did find got averaged away.  Reach',
    '       doubled, cone tightened to 0.075*t.',
    '',
    '   (b) An ANALYTIC column term.  Any stochastic march is a noisy estimator,',
    '       and a noisy estimator of a quantity that must be MONOTONE in height is',
    '       exactly what produced a base measurably brighter than the crown.  So',
    '       the geometric depth of the cell above the sample — (1-hh)*thickness,',
    '       divided by sin(sun elevation) — is added deterministically.  It',
    '       saturates smoothly at ~520 m of path because a real sun ray exits',
    '       sideways through the flank of a 1 km-wide cell rather than climbing',
    '       the entire column, so an unbounded term would black out everything',
    '       below the top 10%.  This is what guarantees the crown/base ordering',
    '       regardless of step count, and it costs no taps.                     */',
    'float clLight(vec3 wp, float land, float d, float hh, float thk, float seed){',
    '  float tau = 0.0, t = 0.0, ds = 34.0, h2, k2;',
    '  vec3 L = uLightDir;',
    '  vec3 e1 = normalize(cross(L, vec3(0.0,1.0,0.0)) + vec3(1e-3,0.0,1e-3));',
    '  vec3 e2 = cross(L, e1);',
    '  float near = 0.0;',
    '  for (int i=0;i<CL_LIGHT;i++){',
    '    vec3 j = sailHash33(floor(wp*0.5) + vec3(float(i)*13.7 + seed)) - 0.5;',
    '    float tm = t + ds*(0.5 + 0.40*j.x);',
    '    vec3 p = wp + L*tm + (e1*j.y + e2*j.z)*(tm*0.075);',
    '    if (p.y > uBase - 240.0 && p.y < uTop + 320.0){',
    '      float dq = clDens(p, land, 1, max(ds, 80.0), h2, k2)*ds;',
    '      tau += dq;',
    '      if (i < 3) near += dq; }',
    '    t += ds; ds *= 2.06; }',
    '  /* THE BURIED GATE.  The analytic term below extrapolates the column that',
    '     the march is too short to reach, and it is only legitimate where the',
    '     march already found cloud between this sample and the sun.  Without the',
    '     gate it fires on the sunlit cap of every turret as well — hh is the',
    '     height fraction of the CELL, and a cauliflower crown sits at hh 0.5-0.9',
    '     because ct is the cell MAXIMUM, not the local surface — which blacks out',
    '     precisely the pixels that are supposed to be at the top of the range.',
    '     near is the optical depth found inside the first ~250 m along the sun',
    '     ray, so an exposed surface reads 0 and stays fully lit while a sample',
    '     under a kilometre of its own water gets the whole remaining column. */',
    '  float buried = clamp(near/uSunGate, 0.0, 1.0);',
    '  float above = clamp(1.0 - hh, 0.0, 1.0)*thk;',
    '  float ly = max(abs(uLightDir.y), 0.26);',
    '  float pathA = above/ly;',
    '  pathA = pathA/(1.0 + pathA*0.0012);           /* soft-max at ~830 m */',
    '  /* Deliberately NOT scaled by the local density.  Using d here inverts the',
    '     term over the lower body — clDens thins the sub-cloud layer to 0.62 of',
    '     the core, so a base sample would report LESS column above it than a',
    '     mid-cell sample and come back brighter, which is the exact failure this',
    '     term exists to kill.  A fixed nominal 0.70 core density keeps it purely',
    '     geometric and therefore strictly monotone in height. */',
    '  return tau + buried*pathA*uSunPath; }',
    '',
    '/* TWO COLOURED SOURCES, NOT ONE SCALAR.  The direct term carries the SUN\'s',
    '   chromaticity, the fill carries the SKY\'s.  A cloud whose lit side and',
    '   shadow side differ only in value is the most reliable tell of CG cloud. */',
    'vec3 clShade(vec3 wp, float hh, float thk, float land, float d, float nu, vec3 aUp, vec3 aDn, float seed){',
    '  float dl = clLight(wp, land, d, hh, thk, seed)*uSigma;',
    '  /* uDebug: 1 = sun-ray optical depth, 2 = local density, 3 = height',
    '     fraction.  Left in deliberately — every regression in this subsystem so',
    '     far has been invisible in the beauty image and obvious in one of these. */',
    '  if (uDebug > 0.5){',
    '    if (uDebug < 1.5) return vec3(clamp(dl/12.0, 0.0, 1.0))*36.0;',
    '    if (uDebug < 2.5) return vec3(clamp(d, 0.0, 1.0))*36.0;',
    '    return vec3(clamp(hh, 0.0, 1.0))*36.0; }',
    '  /* WRENNINGE MULTIPLE-SCATTER OCTAVES.  Extinction, albedo and phase',
    '     eccentricity all scale by ~0.5^n, so the deep core goes MILKY GREY',
    '     rather than either clipping to white or going black, and the outer',
    '     shell keeps a sharp forward lobe for the silver lining.  Critically',
    '     this is FULL Beer-Lambert exp(-sigma_t*depth) — the previous build',
    '     saturated through a 1-exp remap, which is exactly why the whole cloud',
    '     field measured 0.5 stops end to end. */',
    '  /* The ladder has to keep BITING.  With b *= 0.42 the third octave ran at',
    '     0.176 of the true extinction, so a base sample sitting under 20 optical',
    '     depths still returned exp(-3.5) from it — a floor that no amount of',
    '     shadowing could push through, and the single largest contributor to the',
    '     0.19-stop flat column.  0.42 -> 0.34 on the extinction and 0.46 -> 0.40',
    '     on the weight puts the deep core two full stops lower while leaving the',
    '     milky (not black) look of a real cumulus interior intact.  The backward',
    '     lobe mix drops 0.26 -> 0.17 for the same reason: HG(-0.32) is almost',
    '     isotropic, and an isotropic lobe is a view-independent pedestal. */',
    '  float lum = 0.0, a = 1.0, b = 1.0, c = 1.0;',
    '  for (int o=0;o<3;o++){',
    '    float ph = mix(sailHG(nu, 0.78*c), sailHG(nu, -0.30*c), 0.17);',
    '    lum += a*exp(-dl*b)*ph;',
    '    a *= 0.40; b *= 0.34; c *= 0.58; }',
    '  /* POWDER.  Keyed to the LOCAL density and the sun-ray depth together, so',
    '     it goes to zero on a thin translucent flank and on the walls of a',
    '     crevice (both of which are then dark) and saturates a few tens of',
    '     metres inside a lit cauliflower cap.  Strongest looking down-sun, which',
    '     is where the effect physically is.  Note this only ever DARKENS: the',
    '     old term multiplied the core by 1.25 and lifted the very pixels that',
    '     were supposed to be carrying the bottom of the range. */',
    '  float pw = 1.0 - exp(-2.6*(dl + d*7.0));',
    '  lum *= mix(1.0, pw, uPowder*(0.42 + 0.58*clamp(nu, 0.0, 1.0)));',
    '  /* AMBIENT — the single largest reason the bases were blown out.  A cloud',
    '     base does NOT see the sky: it is at the bottom of a kilometre of its',
    '     own water, looking down at a 6%-albedo sea.  So the fill runs from a',
    '     weak blue-green sea bounce at hh = 0 to the full sky irradiance at the',
    '     crown, and the whole term is ~15-20% of a sunlit top instead of ~60%.',
    '     aUp carries the SKY chromaticity (blue at noon, violet-blue at golden',
    '     hour), uLightCol carries the SUN chromaticity — never the same colour,',
    '     which is what gives shaded flanks their cool cast against warm tops. */',
    '  float hu, ku; vec3 up1 = wp + vec3(0.0, 240.0, 0.0);',
    '  float du = (up1.y < uTop + 260.0) ? clDens(up1, land, 1, 240.0, hu, ku) : 0.0;',
    '  float occ = 1.0 - 0.62*clamp(du*2.4, 0.0, 1.0);',
    '  /* The sky-visibility ramp is CUBIC, not smoothstep.  A smoothstep spends',
    '     half its range in the bottom half of the cell, which handed a base',
    '     sample ~35% of the crown fill; a base under a kilometre of water sees',
    '     essentially none of the sky hemisphere.  vis^2 pins the fill to the',
    '     upper third where it physically belongs, which is what finally lets the',
    '     underside read as a cool grey-blue plane instead of a lit surface. */',
    '  float vis = clamp(hh, 0.0, 1.0);',
    '  vis = vis*vis*(3.0 - 2.0*vis); vis *= vis;',
    '  vec3 amb = mix(aDn, aUp, vis)*occ*uAmb;',
    '  return uLightCol*(lum*uDirect) + amb; }',
    ''
  ].join('\n');

  /* The march itself, shared verbatim by both passes.  CL_PANO selects the
     ray generator and the output path; CL_SHMAP builds the exported cloud
     shadow plane instead of an image.                                      */
  var CLOUD_MARCH = [
    '#ifndef CL_PANO',
    'uniform vec3 uFwd, uRight, uUp, uPFwd, uPRight, uPUp;',
    'uniform vec2 uTan, uPTan;',
    'uniform sampler2D uHist;',
    'uniform float uHistOn, uFrame;',
    '#endif',
    'void main(){',
    '#ifdef CL_PANO',
    '  vec2 pp = gl_FragCoord.xy/uRes;',
    '  float az = (pp.x-0.5)*2.0*SAIL_PI;',
    '  float el = pp.y*pp.y*(0.5*SAIL_PI);',
    '  vec3 dir = vec3(sin(az)*cos(el), sin(el), -cos(az)*cos(el));',
    '  /* R2 low-discrepancy dither.  The panorama has no temporal accumulation to',
    '     hide behind, so its offset field has to be good in ONE sample: plain IGN',
    '     lays down a regular diagonal lattice, and at 2048x1024 magnified 1.7x on',
    '     screen that lattice is directly visible as the fixed grid of dither',
    '     squares the review found with blue punching through it.  The R2 sequence',
    '     is the best known 2D low-discrepancy point set and its residual is',
    '     isotropic, so what is left dissolves under the Catmull-Rom tap instead',
    '     of aligning into blocks.  A slow uT term keeps it from being a FROZEN',
    '     lattice without introducing frame-to-frame flicker (the pano refreshes',
    '     one band at a time, so this drifts over ~seconds, not frames). */',
    '  float dith = fract(dot(gl_FragCoord.xy, vec2(0.7548776662, 0.5698402910)) + uT*0.017);',
    '#else',
    '  vec2 uv = gl_FragCoord.xy/uRes;',
    '  vec2 nd = uv*2.0 - 1.0;',
    '  vec3 dir = normalize(uFwd + uRight*(nd.x*uTan.x) + uUp*(nd.y*uTan.y));',
    '  /* Spatiotemporal offset: interleaved-gradient noise (which is close to',
    '     blue over a 3x3 neighbourhood) DECORRELATED by a per-pixel white hash,',
    '     then advanced by the golden ratio per frame.  Plain IGN alone lays down',
    '     the faint 2 px diagonal comb that survived TAA in the last build. */',
    '  float ign = fract(52.9829189*fract(dot(gl_FragCoord.xy, vec2(0.06711056,0.00583715))));',
    '  float wn  = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898,78.233)))*43758.5453);',
    '  float dith = fract(ign + 0.37*wn + uFrame*0.6180339887);',
    '#endif',
    '  vec4 res = vec4(0.0, 0.0, 0.0, 1.0);',
    '  float r0 = SAIL_RG + max(uCam.y, 0.5)*0.001;',
    '  float mu = dir.y;',
    '  float kk = r0*r0*(mu*mu - 1.0);',
    '  float dg = kk + SAIL_RG*SAIL_RG;',
    '  bool below = (mu < 0.0 && dg > 0.0 && (-r0*mu - sqrt(dg)) > 0.0);',
    '  /* The geometric slab has to contain the JITTERED bases and the anvils,',
    '     not just uBase..uTop, or the per-cell base jitter gets clipped back',
    '     into the flat plane it exists to destroy. */',
    '  float slabLo = uBase - 190.0, slabHi = uTop + 300.0;',
    '  float rb = SAIL_RG + slabLo*0.001, rt = SAIL_RG + slabHi*0.001;',
    '  float dtop = kk + rt*rt;',
    '  if (!below && dtop > 0.0){',
    '    float t1 = min(-r0*mu + sqrt(dtop), uMaxD);',
    '    float dbot = kk + rb*rb;',
    '    float t0 = (dbot > 0.0) ? max(-r0*mu + sqrt(dbot), 0.0) : 0.0;',
    '    if (t1 > t0){',
    '      float span = t1 - t0;',
    '      /* Skylight fill.  Take the CHROMATICITY from the real sky (zenith',
    '         blended with the sky at 16 deg, so the fill follows the sunset',
    '         round the compass) but take the MAGNITUDE from uSkySkyE, the',
    '         physically scheduled sky irradiance — the LUT is a radiance field',
    '         and its absolute level drifts with turbidity, whereas a Lambertian',
    '         cloud face wants E*rho/pi and nothing else. */',
    '      vec3 zen = vec3(0.0,1.0,0.0);',
    '      vec3 sMix = sailSkyLUT(zen, uSkySunDir)*0.72',
    '                + sailSkyLUT(normalize(vec3(dir.x, 0.30, dir.z)), uSkySunDir)*0.28;',
    '      float sL = max(dot(sMix, vec3(0.2126,0.7152,0.0722)), 1e-5);',
    '      vec3 sCh = sMix/sL;',
    '      float ambE = max(uSkySkyE, 0.0);',
    '      vec3 nAmb = vec3(0.011,0.016,0.036)*uSkyNight*(0.34 + 2.6*uSkyMoonE);',
    '      /* TWO LOBES, and they must not be the same size.  The old pair had',
    '         aDn (0.66) LARGER than aUp (0.62) — the underside of every cloud in',
    '         the sky was getting more fill than the crown, which is physically',
    '         backwards and is what pinned the 5th percentile at sRGB 189.  aUp',
    '         is the sky hemisphere seen by an unoccluded crown; aDn is what a',
    '         base actually sees, which is a 6%-albedo sea and its own shadow. */',
    '      /* The reference wants the underside driven by a sky-dome ambient at',
    '         0.15-0.25 of the sun term and blue-biased.  aDn is deliberately',
    '         COOLER than aUp, not merely darker: sCh is the real sky chromaticity',
    '         and the sea bounce laid over it is blue-green, so an underside can',
    '         never come back warmer than a sun-tinted crown the way it did. */',
    '      vec3 aUp = sCh*(ambE*0.82) + nAmb;',
    '      /* sea bounce: weak, blue-green, and only ever on the underside */',
    '      vec3 aSea = vec3(0.20,0.42,0.54)*(ambE*0.018 + max(uSkySunE,0.0)*0.0030);',
    '      vec3 aDn = sCh*(ambE*0.36) + aSea + nAmb*0.35;',
    '      float nu = dot(dir, uLightDir);',
    '      vec3 scat = vec3(0.0);',
    '      float T = 1.0, mdist = 0.0, mw = 0.0;',
    '      /* ---------------- ADAPTIVE MARCH -------------------------------',
    '         Two step lengths.  Empty space is probed with a cheap shape-only',
    '         density at 3.2x the fine step; the first hit steps BACK one coarse',
    '         step and drops into fine stepping, and six consecutive misses',
    '         return to coarse.  Because the coarse probe omits only erosion,',
    '         which can only REDUCE density, the probe is a conservative',
    '         overestimate and cannot skip past cloud.',
    '',
    '         The jitter advances EVERY step by the R1 low-discrepancy constant',
    '         instead of being applied once at ray entry.  A single entry offset',
    '         only randomises the PHASE of the sample lattice; the shells are',
    '         still coherent, and since the entry offset was a function of ray',
    '         elevation alone the beat ran along iso-elevation arcs — which is',
    '         precisely the rotating comb/fan the review flagged.            */',
    '      float ds0 = clamp(span/float(CL_TARGET), 0.014, 0.040);',
    '      float t = t0, jt = dith, miss = 0.0, refine = 0.0;',
    '      bool inC = false;',
    '      for (int i=0;i<CL_STEPS;i++){',
    '        if (t >= t1 || T < 0.008) break;',
    '        /* dsN is the NOMINAL step for this distance and is what drives the',
    '           octave LOD gates.  It must NOT follow the refinement halving:',
    '           when it did, the six refinement steps ran the erosion octaves at',
    '           full strength and every step after them ran with the octaves',
    '           gated off, so each cloud grew a detailed outer shell wrapped',
    '           round a smooth interior — visible as concentric horizontal',
    '           "stacked lenticular plate" seams.  Frequency content has to be a',
    '           function of distance alone, never of the marcher\'s state. */',
    '        float dsN = max(ds0, t*0.0050);',
    '        float dsF = (refine > 0.0) ? dsN*0.5 : dsN;',
    '        float dsC = dsF*3.0;',
    '        float ds = inC ? dsF : dsC;',
    '        jt = fract(jt + 0.6180339887);',
    '        float ts = t + ds*(0.5 + 0.60*(jt - 0.5));',
    '        vec3 qv = vec3(dir.x*ts, r0 + dir.y*ts, dir.z*ts);',
    '        float hgt = (length(qv) - SAIL_RG)*1000.0;',
    '        if (hgt < slabLo || hgt > slabHi){ t += ds; continue; }',
    '        vec3 wp = vec3(uCam.x + dir.x*ts*1000.0, hgt, uCam.z + dir.z*ts*1000.0);',
    '        float land = clLand(wp.xz);',
    '        float dsm = dsN*1000.0;',
    '        float hh, thk;',
    '        if (!inC){',
    '          if (clDens(wp, land, 2, dsm, hh, thk) > 0.0){',
    '            inC = true; miss = 0.0; refine = 6.0; t = max(t - dsC*0.96, t0); }',
    '          else t += ds;',
    '        } else {',
    '          float d = clDens(wp, land, 0, dsm, hh, thk);',
    '          if (d > 0.0030){',
    '            vec3 src = clShade(wp, hh, thk, land, d, nu, aUp, aDn, dith*11.0);',
    '            float stepT = exp(-d*uSigma*ds*1000.0);',
    '            float wgt = T*(1.0 - stepT);',
    '            scat += src*wgt; mdist += ts*wgt; mw += wgt; T *= stepT;',
    '            miss = 0.0;',
    '          } else { miss += 1.0; if (miss > 6.0){ inC = false; refine = 0.0; } }',
    '          refine = max(refine - 1.0, 0.0);',
    '          t += ds; } }',
    '      float cov = 1.0 - T;',
    '      if (cov > 1e-4){',
    '        /* Distant cloud must DESATURATE INTO THE HAZE BAND, never fade',
    '           out: same transmittance the terrain uses, so the cumulus field',
    '           converges into a cluttered hazy line at the horizon. */',
    '        float dm = (mw > 1e-5 ? mdist/mw : 0.5*(t0+t1))*1000.0;',
    '        /* uFade > 1 deepens the optical depth for the cloud deck only, so',
    '           the farthest cumulus dissolve into the haze band over ~30 km',
    '           instead of staying as crisp dark lumps stacked on the horizon.',
    '           This is the term that makes aerial perspective run FORWARDS:',
    '           distant cloud converges on the (bright) horizon radiance rather',
    '           than ending up darker and higher-contrast than the near ones. */',
    '        vec3 Ta = pow(max(sailAerialTransmittance(uCam + dir*dm, uCam), vec3(1e-5)), vec3(uFade));',
    '        vec3 ins = skyRadianceBase(dir, uSkySunDir) + sailNightSky(dir);',
    '        scat = scat*Ta + ins*(vec3(1.0)-Ta)*cov;',
    '        /* Anything the march could not finish (the near-horizon chord is',
    '           tens of km long) is handed to the haze rather than left as a',
    '           truncated scummy band of half-integrated cloud. */',
    '        float unf = smoothstep(0.0, 1.0, (t1 - t)/max(span, 1e-4));',
    '        float hzf = 1.0 - unf*smoothstep(0.030, 0.0, dir.y + 0.004);',
    '        T = mix(1.0, T, hzf); scat *= hzf; }',
    '      scat = max(scat, vec3(0.0));',
    '      float lm = dot(scat, vec3(0.3333));',
    '      if (!(lm < 1e5)) { scat = vec3(0.0); T = 1.0; }',
    '      res = vec4(min(scat, vec3(12000.0))/uScale, clamp(T, 0.0, 1.0)); } }',
    '#ifdef CL_PANO',
    '  gl_FragColor = res;',
    '#else',
    '  /* Temporal reprojection.  The cloud deck is effectively at infinity for',
    '     rotation, so reprojecting the VIEW DIRECTION through the previous',
    '     frame basis is exact for a pure pan/tilt and near-exact for the slow',
    '     translation of a boat.',
    '',
    '     The rejection window used to open at dd = 0.030, which sat INSIDE the',
    '     frame-to-frame swing of the ray jitter — so the TAA threw away history',
    '     at exactly the pixels the jitter needed averaged, and the banding it',
    '     was supposed to dissolve survived to be bilinearly feathered on',
    '     upsample.  The knee is now above the jitter amplitude and only real',
    '     silhouette motion rejects. */',
    '  if (uHistOn > 0.5){',
    '    float f = dot(dir, uPFwd);',
    '    if (f > 0.06){',
    '      vec2 ps = vec2(dot(dir, uPRight)/(f*uPTan.x), dot(dir, uPUp)/(f*uPTan.y));',
    '      vec2 pu = ps*0.5 + 0.5;',
    '      if (pu.x > 0.002 && pu.x < 0.998 && pu.y > 0.002 && pu.y < 0.998){',
    '        vec4 h = texture2D(uHist, pu);',
    '        float dd = abs(h.a - res.a) + 0.30*length(h.rgb - res.rgb)/(1.0 + length(res.rgb));',
    '        float w = 0.93*(1.0 - smoothstep(0.230, 0.62, dd));',
    '        res = mix(res, h, w); } } }',
    '  gl_FragColor = res;',
    '#endif',
    '}'
  ].join('\n');

  /* ------------------------------------------------- exported cloud shadow
     Sun-ray transmittance of the deck, evaluated on the y = 0 plane over a
     square box snapped to the texel grid and centred on the camera.  This is
     the ONLY thing the rest of the project needs in order to drag real cloud
     shadows across the sea and the island: sailCloudShadow(worldPos).      */
  var CLOUD_SHMAP = [
    'uniform vec2 uShOrigin; uniform float uShSpan;',
    'void main(){',
    '  vec2 uv = gl_FragCoord.xy/uRes;',
    '  vec2 g = uShOrigin + uv*uShSpan;',
    '  vec3 L = uLightDir;',
    '  float ly = max(L.y, 0.10);',
    '  vec3 p0 = vec3(g.x, 0.0, g.y);',
    '  float tA = (uBase - 190.0)/ly, tB = (uTop + 300.0)/ly;',
    '  float ds = (tB - tA)/float(CL_SHSTEPS);',
    '  float dith = fract(52.9829189*fract(dot(gl_FragCoord.xy, vec2(0.06711056,0.00583715))));',
    '  float tau = 0.0, hh, thk;',
    '  for (int i=0;i<CL_SHSTEPS;i++){',
    '    vec3 p = p0 + L*(tA + ds*(float(i) + dith));',
    '    tau += clDens(p, clLand(p.xz), 1, 300.0, hh, thk)*ds; }',
    '  float tr = exp(-tau*uSigma);',
    '  gl_FragColor = vec4(tr, tr, tr, 1.0); }'
  ].join('\n');

  function cloudUniforms(w, h) {
    return {
      uRes:      { value: new THREE.Vector2(w, h) },
      uWeather:  { value: rtNoise.texture },
      uShapeVol: { value: rtShape.texture },
      uDetVol:   { value: rtDet.texture },
      uLand:     { value: landTex },
      uCam:      { value: new THREE.Vector3(0, 2, 0) },
      uWind:     { value: new THREE.Vector2(0, 0) },
      uShear:    { value: new THREE.Vector2(0, 0) },
      uT:        { value: 0 },
      uLightDir: { value: new THREE.Vector3(0, 1, 0) },
      uLightCol: { value: new THREE.Vector3(100, 93, 82) },
      uCover:    { value: new THREE.Vector2(0.34, 0.14) },
      /* Extinction per metre at unit density.  A trade cumulus core is
         genuinely opaque — you cannot see stars, blue sky or another cloud
         through the middle of one — so this has to be high enough that a
         300 m chord already gives several optical depths. */
      /* 0.052 -> 0.090 /m at unit density.  Real cumulus runs 0.06-0.10 /m in a
         dense core; below that a 300 m chord never reaches the several optical
         depths that make a cloud read as an opaque lit SOLID rather than as
         fog with an albedo clamp. */
      uSigma:    { value: 0.090 },
      uBase:     { value: CL_BASE },
      uTop:      { value: CL_TOP },
      uPowder:   { value: 0.62 },
      uAmb:      { value: 1.0 },
      uScale:    { value: 1.0 },
      uMaxD:     { value: 130.0 },
      /* Gain that turns the 4-octave phase sum into scene-referred radiance.
         Calibrated against the sky it sits in: a sunlit cumulus top is about
         7x the zenith radiance and ~1.8x the horizon haze band, which is what
         a photometer reads on a trade-wind day.  Push it past that and the
         auto-exposure crushes the blue out of the sky to compensate; leave it
         short and the tops never reach white. */
      /* Retuned again for the 3-octave Wrenninge ladder (a *= 0.46, sum 1.67)
         and the much smaller ambient pedestal.  The target, verified by pixel
         probe against the ACES curve baked into post.js, is a sunlit crown at
         ~60 scene-referred units (sRGB 244) over a shaded base at ~8 (sRGB
         ~135) — 2.9 stops, which is what the reference demands. */
      /* 15.5 -> 56.  Measured, not guessed: the visible surface of a dense
         cumulus is already 4-6 optical depths from the sun (sigma*d = 0.072/m,
         so the VIEW ray also terminates ~30 m in and every shaded sample is a
         near-surface sample), and at 15.5 that put a fully sunlit crown at 11
         scene units — sRGB 194, nowhere near the top of the range, with the
         whole cloud population compressed into 0.5 stops.  56 puts a sunlit
         crown at ~2.0 on the ACES curve (sRGB 238-245) and leaves the shaded
         base, which is exp(-dl) suppressed and therefore does NOT scale with
         this, sitting 2.2-2.6 stops below it. */
      uDirect:   { value: 56.0 },
      /* Erosion is CLAMPED against the local density now (it can only bite the
         translucent flanks), so it can be pushed harder without hollowing the
         cores or punching the torus holes the review found. */
      uErode:    { value: 1.22 },
      /* Analytic sun-column extrapolation (see clLight): uSunPath is the
         nominal core density it assumes, uSunGate the optical depth of nearby
         cloud needed before it fires at full strength. */
      uSunPath:  { value: 0.42 },
      uSunGate:  { value: 120.0 },
      uFade:     { value: 1.70 },
      uDebug:    { value: 0.0 }
    };
  }

  /* ---------------------------------------------- cloud shadow plane pass */
  /* 256^2 over 9000 m is 35 m per texel — four texels across a whole cumulus
     shadow, which is why nothing downstream could make a recognisable patch out
     of it and reached for its own noise field instead.  1024^2 is 8.8 m/texel;
     with the linear filter that is a soft-edged patch of the right SHAPE, and
     it is the same field the dome is drawing, so a cloud and its shadow finally
     agree.  Rendered one 1024x86 band per frame (88 k px, cheaper than the old
     full 256^2 every third frame was per-frame-equivalent x2) with the box
     origin re-snapped only at band 0 so the bands stay mutually consistent. */
  var SH_RES = 1024, SH_SPAN = 9000, SH_BANDS = 12, shBand = 0;
  var _shOrigin = new THREE.Vector2(0, 0);
  var _shPend = new THREE.Vector2(0, 0);

  function buildCloudShadow() {
    if (rtShadow) { rtShadow.dispose(); rtShadow = null; }
    if (matShadow) { matShadow.dispose(); matShadow = null; }
    rtShadow = new THREE.WebGLRenderTarget(SH_RES, SH_RES, {
      type: THREE.UnsignedByteType, format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false
    });
    rtShadow.texture.colorSpace = THREE.LinearSRGBColorSpace;
    var u = cloudUniforms(SH_RES, SH_RES);
    u.uShOrigin = { value: new THREE.Vector2(0, 0) };
    u.uShSpan = { value: SH_SPAN };
    matShadow = post(new THREE.ShaderMaterial({
      defines: { CL_SHSTEPS: 16, CL_LIGHT: 1, CL_STEPS: 1, CL_TARGET: 1 },
      uniforms: u,
      vertexShader: QUAD_VS,
      fragmentShader: 'precision highp float;\n' + GLSL + '\n' + CLOUD_FIELD + '\n' + CLOUD_SHMAP
    }));
    S.register(matShadow);
    U.uSkyCloudShTex.value = rtShadow.texture;
  }

  function renderCloudShadow(all) {
    if (!matShadow || !rtShadow || !matCloud) return;
    if (all) {
      shBand = 0;
      for (var n = 0; n < SH_BANDS; n++) renderCloudShadow(false);
      shBand = 0; return;
    }
    var a = matCloud.uniforms, b = matShadow.uniforms;
    b.uWeather.value = a.uWeather.value;
    b.uShapeVol.value = a.uShapeVol.value;
    b.uDetVol.value = a.uDetVol.value;
    b.uLand.value = a.uLand.value;
    b.uT.value = a.uT.value;
    b.uSigma.value = a.uSigma.value;
    b.uBase.value = a.uBase.value;
    b.uTop.value = a.uTop.value;
    b.uErode.value = a.uErode.value;
    b.uWind.value.copy(a.uWind.value);
    b.uShear.value.copy(a.uShear.value);
    b.uCover.value.copy(a.uCover.value);
    b.uLightDir.value.copy(a.uLightDir.value);
    /* snap the box to the texel grid so the shadow field does not crawl as
       the boat moves — the same discipline the sun cascade needs.  The origin
       is only allowed to move at band 0, so every band of one sweep shares one
       projection and the map never tears along a band boundary. */
    if (shBand === 0) {
      var cam = SAIL.camera ? SAIL.camera.position : null;
      var cx = cam ? cam.x : 0, cz = cam ? cam.z : 0;
      var tx = SH_SPAN / SH_RES;
      _shPend.set(Math.floor((cx - SH_SPAN * 0.5) / tx) * tx,
                  Math.floor((cz - SH_SPAN * 0.5) / tx) * tx);
    }
    b.uShOrigin.value.copy(_shPend);
    _shOrigin.copy(_shPend);
    var bh = Math.ceil(SH_RES / SH_BANDS);
    var y0 = shBand * bh, hh = Math.min(bh, SH_RES - y0);
    if (hh > 0) blit(matShadow, rtShadow, [0, y0, SH_RES, hh]);
    shBand = (shBand + 1) % SH_BANDS;
    U.uSkyCloudShTex.value = rtShadow.texture;
    U.uSkyCloudShBox.value.set(_shOrigin.x, _shOrigin.y, 1 / SH_SPAN, S.cloudShadowStrength);
  }

  /* Public handle for the shadow pass / any consumer. */
  S.cloudShadowStrength = 0.85;
  S.cloudShadow = function () {
    return { map: rtShadow ? rtShadow.texture : null,
             originX: _shOrigin.x, originZ: _shOrigin.y,
             span: SH_SPAN, strength: S.cloudShadowStrength,
             glsl: 'sailCloudShadow(vec3 worldPos)' };
  };

  /* -------------------------------------------------------- panoramic LUT */
  var cloudBand = 0, CLOUD_BANDS = 5;

  function buildCloudLUT(w, h, steps, target, lightSteps) {
    if (rtCloud) { rtCloud.dispose(); rtCloud = null; }
    if (matCloud) { matCloud.dispose(); matCloud = null; }
    rtCloud = new THREE.WebGLRenderTarget(w, h, {
      type: lutType, format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping, wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false
    });
    rtCloud.texture.colorSpace = THREE.LinearSRGBColorSpace;
    matCloud = post(new THREE.ShaderMaterial({
      defines: { CL_PANO: 1, CL_STEPS: steps, CL_TARGET: target, CL_LIGHT: lightSteps || 5 },
      uniforms: cloudUniforms(w, h),
      vertexShader: QUAD_VS,
      fragmentShader: 'precision highp float;\n' + GLSL + '\n' + CLOUD_FIELD + '\n' + CLOUD_MARCH
    }));
    S.register(matCloud);
    U.uSkyCloudLUT.value = rtCloud.texture;
    U.uSkyCloudSize.value.set(w, h);
    cloudBand = 0;
  }

  function renderCloudBand(all) {
    if (!rtCloud || !matCloud) return;
    var h = rtCloud.height, w = rtCloud.width;
    if (all) {
      for (var i = 0; i < CLOUD_BANDS; i++) { cloudBand = i; renderCloudBand(false); }
      cloudBand = 0; return;
    }
    var bh = Math.ceil(h / CLOUD_BANDS);
    var y0 = cloudBand * bh, hh = Math.min(bh, h - y0);
    if (hh > 0) blit(matCloud, rtCloud, [0, y0, w, hh]);
    cloudBand = (cloudBand + 1) % CLOUD_BANDS;
  }

  /* --------------------------------------------------- screen-space march */
  S.cloudScale = 0.68;                 // screen-space march resolution factor
  var rtScr = [null, null], scrFlip = 0, matScr = null;
  var scrW = 0, scrH = 0, scrFrame = 0, scrValid = false;
  var scrBasis = { r: new THREE.Vector3(1, 0, 0), u: new THREE.Vector3(0, 1, 0),
                   f: new THREE.Vector3(0, 0, -1), tan: new THREE.Vector2(1, 1),
                   pos: new THREE.Vector3() };
  var prevBasis = { r: new THREE.Vector3(1, 0, 0), u: new THREE.Vector3(0, 1, 0),
                    f: new THREE.Vector3(0, 0, -1), tan: new THREE.Vector2(1, 1) };
  var _bm = new THREE.Matrix4(), _dbs = new THREE.Vector2();

  function buildScreenCloud(steps, target, lightSteps) {
    if (matScr) { matScr.dispose(); matScr = null; }
    var u = cloudUniforms(2, 2);
    u.uFwd = { value: new THREE.Vector3(0, 0, -1) };
    u.uRight = { value: new THREE.Vector3(1, 0, 0) };
    u.uUp = { value: new THREE.Vector3(0, 1, 0) };
    u.uTan = { value: new THREE.Vector2(1, 1) };
    u.uPFwd = { value: new THREE.Vector3(0, 0, -1) };
    u.uPRight = { value: new THREE.Vector3(1, 0, 0) };
    u.uPUp = { value: new THREE.Vector3(0, 1, 0) };
    u.uPTan = { value: new THREE.Vector2(1, 1) };
    u.uHist = { value: null };
    u.uHistOn = { value: 0 };
    u.uFrame = { value: 0 };
    matScr = post(new THREE.ShaderMaterial({
      defines: { CL_STEPS: steps, CL_TARGET: target, CL_LIGHT: lightSteps || 5 },
      uniforms: u,
      vertexShader: QUAD_VS,
      fragmentShader: 'precision highp float;\n' + GLSL + '\n' + CLOUD_FIELD + '\n' + CLOUD_MARCH
    }));
    S.register(matScr);
    scrValid = false;
    S.materials = { cloudLUT: matCloud, cloudScreen: matScr };
  }

  function screenTargetSize() {
    var w = 0, h = 0;
    var pr = SAIL.post && SAIL.post.resolution;
    if (pr && pr.x > 4 && pr.y > 4) { w = pr.x; h = pr.y; }
    else if (renderer) { renderer.getDrawingBufferSize(_dbs); w = _dbs.x; h = _dbs.y; }
    if (!(w > 4) || !(h > 4)) { w = 1280; h = 800; }
    var s = S.cloudScale;
    return [Math.max(160, Math.round(w * s)), Math.max(100, Math.round(h * s))];
  }

  function ensureScreenRT() {
    var d = screenTargetSize();
    if (rtScr[0] && d[0] === scrW && d[1] === scrH) return;
    scrW = d[0]; scrH = d[1];
    for (var i = 0; i < 2; i++) {
      if (rtScr[i]) rtScr[i].dispose();
      rtScr[i] = makeRT(scrW, scrH, lutType);
    }
    scrValid = false;
    if (matScr) matScr.uniforms.uRes.value.set(scrW, scrH);
  }

  /* Copies the per-condition cloud settings from the LUT material so both
     passes always describe the SAME sky. */
  function syncScreenUniforms() {
    if (!matScr || !matCloud) return;
    var a = matCloud.uniforms, b = matScr.uniforms;
    b.uWeather.value = a.uWeather.value;
    b.uShapeVol.value = a.uShapeVol.value;
    b.uDetVol.value = a.uDetVol.value;
    b.uLand.value = a.uLand.value;
    b.uT.value = a.uT.value;
    b.uScale.value = a.uScale.value;
    b.uSigma.value = a.uSigma.value;
    b.uPowder.value = a.uPowder.value;
    b.uAmb.value = a.uAmb.value;
    b.uMaxD.value = a.uMaxD.value;
    b.uDirect.value = a.uDirect.value;
    b.uErode.value = a.uErode.value;
    b.uSunPath.value = a.uSunPath.value;
    b.uSunGate.value = a.uSunGate.value;
    b.uFade.value = a.uFade.value;
    b.uDebug.value = a.uDebug.value;
    b.uBase.value = a.uBase.value;
    b.uTop.value = a.uTop.value;
    b.uWind.value.copy(a.uWind.value);
    b.uShear.value.copy(a.uShear.value);
    b.uCover.value.copy(a.uCover.value);
    b.uCam.value.copy(a.uCam.value);
    b.uLightDir.value.copy(a.uLightDir.value);
    b.uLightCol.value.copy(a.uLightCol.value);
  }

  function renderScreenCloud() {
    var cam = SAIL.camera;
    if (!matScr || !cam || !cam.isPerspectiveCamera) { S.screenOK = false; return; }
    ensureScreenRT();
    if (!rtScr[0]) { S.screenOK = false; return; }
    syncScreenUniforms();

    cam.updateMatrixWorld();
    _bm.copy(cam.matrixWorld);
    var m = _bm.elements;
    prevBasis.r.copy(scrBasis.r); prevBasis.u.copy(scrBasis.u);
    prevBasis.f.copy(scrBasis.f); prevBasis.tan.copy(scrBasis.tan);
    scrBasis.r.set(m[0], m[1], m[2]).normalize();
    scrBasis.u.set(m[4], m[5], m[6]).normalize();
    scrBasis.f.set(-m[8], -m[9], -m[10]).normalize();
    var th = Math.tan(cam.fov * 0.5 * DEG);
    var asp = (cam.aspect > 0.01 && cam.aspect < 100) ? cam.aspect : (scrW / Math.max(scrH, 1));
    scrBasis.tan.set(th * asp, th);
    scrBasis.pos.copy(cam.position);

    var u = matScr.uniforms;
    u.uRes.value.set(scrW, scrH);
    u.uFwd.value.copy(scrBasis.f); u.uRight.value.copy(scrBasis.r); u.uUp.value.copy(scrBasis.u);
    u.uTan.value.copy(scrBasis.tan);
    u.uPFwd.value.copy(prevBasis.f); u.uPRight.value.copy(prevBasis.r); u.uPUp.value.copy(prevBasis.u);
    u.uPTan.value.copy(prevBasis.tan);
    u.uCam.value.set(cam.position.x, Math.max(cam.position.y, 1.5), cam.position.z);
    scrFrame = (scrFrame + 1) % 64;
    u.uFrame.value = scrFrame;

    var src = rtScr[scrFlip], dst = rtScr[1 - scrFlip];
    u.uHist.value = scrValid ? src.texture : null;
    u.uHistOn.value = scrValid ? 1 : 0;
    blit(matScr, dst);
    scrFlip = 1 - scrFlip;
    scrValid = true;
    S.screenOK = true;

    if (domeMat) {
      var du = domeMat.uniforms;
      du.uScrCloud.value = dst.texture;
      du.uScrOn.value = 1;
      du.uScrSize.value.set(scrW, scrH);
      du.uSFwd.value.copy(scrBasis.f); du.uSRight.value.copy(scrBasis.r);
      du.uSUp.value.copy(scrBasis.u); du.uSTan.value.copy(scrBasis.tan);
    }
  }

  /* ------------------------------------------------------------- the dome */
  function buildDome() {
    var du = S.getUniforms();
    du.uScrCloud = { value: null };
    du.uScrOn = { value: 0 };
    du.uScrSize = { value: new THREE.Vector2(768, 480) };
    du.uSFwd = { value: new THREE.Vector3(0, 0, -1) };
    du.uSRight = { value: new THREE.Vector3(1, 0, 0) };
    du.uSUp = { value: new THREE.Vector3(0, 1, 0) };
    du.uSTan = { value: new THREE.Vector2(1, 1) };
    domeMat = new THREE.ShaderMaterial({
      uniforms: du,
      vertexShader: [
        'varying vec3 vDir; varying vec4 vClip;',
        'void main(){',
        '  vec4 wp = modelMatrix*vec4(position,1.0);',
        '  vDir = wp.xyz - cameraPosition;',
        '  vClip = projectionMatrix*viewMatrix*wp;',
        '  gl_Position = vClip; }'
      ].join('\n'),
      fragmentShader: 'precision highp float;\n' + GLSL + '\n' + [
        'uniform sampler2D uScrCloud; uniform float uScrOn; uniform vec2 uScrSize;',
        'uniform vec3 uSFwd, uSRight, uSUp; uniform vec2 uSTan;',
        'varying vec3 vDir; varying vec4 vClip;',
        '/* Alpha-aware upsample.  The cloud buffer is half resolution and now',
        '   carries a deliberate per-step ray jitter; a plain bilinear tap',
        '   smears that jitter into the feathered comb the review flagged, and',
        '   a plain blur would feather the silhouette instead.  So: five taps,',
        '   each weighted by how close its coverage and radiance are to the',
        '   centre tap.  Inside a cloud and inside clear sky this averages the',
        '   jitter away; across a silhouette the weights collapse to the centre',
        '   tap and the edge stays exactly as sharp as the march made it.    */',
        'vec4 clUpsample(vec2 uv){',
        '  vec2 ts = 1.0/uScrSize;',
        '  vec4 c = texture2D(uScrCloud, uv);',
        '  float lc = dot(c.rgb, vec3(0.3333));',
        '  vec4 acc = c*1.4; float wsum = 1.4;',
        '  for (int i=0;i<8;i++){',
        '    vec2 o;',
        '    if (i==0)      o = vec2( ts.x, 0.0);',
        '    else if (i==1) o = vec2(-ts.x, 0.0);',
        '    else if (i==2) o = vec2( 0.0,  ts.y);',
        '    else if (i==3) o = vec2( 0.0, -ts.y);',
        '    else if (i==4) o = vec2( ts.x,  ts.y)*0.87;',
        '    else if (i==5) o = vec2(-ts.x,  ts.y)*0.87;',
        '    else if (i==6) o = vec2( ts.x, -ts.y)*0.87;',
        '    else           o = vec2(-ts.x, -ts.y)*0.87;',
        '    vec4 s = texture2D(uScrCloud, uv+o);',
        '    float w = exp(-2.4*abs(s.a-c.a) - 1.6*abs(dot(s.rgb,vec3(0.3333))-lc)/(1.0+lc));',
        '    w *= (i<4) ? 1.0 : 0.62;',
        '    acc += s*w; wsum += w; }',
        '  return acc/wsum; }',
        'void main(){',
        '  vec3 d = normalize(vDir);',
        '  vec3 c = skyRadianceBase(d, uSkySunDir) + sailNightSky(d)',
        '         + sailSunDisc(d, uSkySunDir) + sailMoonDisc(d);',
        '  /* Prefer the screen-space cloud march.  The direction check is what',
        '     makes that safe: a PMREM cube face or any other camera projects to',
        '     a uv whose reconstructed ray does NOT match this fragment, and it',
        '     silently falls back to the panoramic LUT. */',
        '  vec4 cl = vec4(0.0, 0.0, 0.0, 1.0);',
        '  bool ok = false;',
        '  if (uScrOn > 0.5 && vClip.w > 0.0){',
        '    vec2 uv = vClip.xy/vClip.w*0.5 + 0.5;',
        '    if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0){',
        '      vec2 nd = uv*2.0 - 1.0;',
        '      vec3 rd = normalize(uSFwd + uSRight*(nd.x*uSTan.x) + uSUp*(nd.y*uSTan.y));',
        '      if (dot(rd, d) > 0.9997){',
        '        vec4 s = clUpsample(uv);',
        '        float f = uSkyCloudMix;',
        '        cl = vec4(s.rgb*uSkyLutScale*f, mix(1.0, clamp(s.a, 0.0, 1.0), f));',
        '        ok = true; } } }',
        '  if (!ok) cl = sailCloudSample(d);',
        '  c = c*cl.a + cl.rgb;',
        '  float lm = dot(c, vec3(0.3333)); if (!(lm < 1e5)) c = vec3(0.0);',
        '  gl_FragColor = vec4(min(c, vec3(12000.0)), 1.0); }'
      ].join('\n'),
      side: THREE.BackSide, depthWrite: false, depthTest: false,
      toneMapped: false, fog: false
    });
    S.register(domeMat);
    var geo = new THREE.SphereGeometry(1, 48, 24);
    dome = new THREE.Mesh(geo, domeMat);
    dome.frustumCulled = false;
    dome.renderOrder = -1000;
    dome.scale.setScalar(4000);
    dome.name = 'SAIL.sky.dome';

    envDome = new THREE.Mesh(geo, domeMat);
    envDome.frustumCulled = false;
    envDome.scale.setScalar(20);
    envScene = new THREE.Scene();
    envScene.add(envDome);
  }

  /* ====================================================================== */
  /*  CPU side: astronomy + radiometry                                      */
  /* ====================================================================== */
  var sunDir = new THREE.Vector3(0.3, 0.9, -0.3);
  var moonDir = new THREE.Vector3(0, -1, 0);
  var sunColor = new THREE.Color(1, 0.93, 0.82);
  var skyColor = new THREE.Color(0.35, 0.5, 0.85);
  var horizonColor = new THREE.Color(0.6, 0.72, 0.9);
  var zenithColor = new THREE.Color(0.15, 0.32, 0.75);
  var horizonHue = new THREE.Color(0.72, 0.83, 1.0);
  var zenithHue = new THREE.Color(0.28, 0.48, 1.0);
  var starRot = new THREE.Matrix3();
  var sunAltDeg = 45, moonAltDeg = -30, moonFrac = 1;

  /* Early February.  Day 36 rather than 45 purely for the moon: it puts a 40%
     waxing moon 22 deg up at 22:00 instead of a full moon at 40 deg, which is
     the difference between a night sky you can see the galaxy in and one
     washed flat by moonlight.  The solar declination differs by 2.7 deg. */
  function dayOfYear() {
    var e = SAIL.env;
    var d = (e && typeof e.dayOfYear === 'number') ? e.dayOfYear : 36;
    return ((d % 365) + 365) % 365;
  }

  /* local clock -> true solar time.  LON/TZMER are EAST-positive, so a site
     west of its standard meridian sees the sun late: correction = 4*(LON-TZMER)
     minutes.  Grenada at 61.75W on the 60W meridian => -7 min. */
  function solarVector(hour, N, out) {
    var B = 2 * PI * (N - 81) / 364;
    var EoT = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);   // minutes
    var solar = hour + (4 * (LON - TZMER) + EoT) / 60;
    var dec = 23.45 * DEG * Math.sin(2 * PI * (284 + N) / 365);
    var w = 15 * DEG * (solar - 12);
    var sd = Math.sin(dec), cd = Math.cos(dec), sp = Math.sin(LAT), cp = Math.cos(LAT);
    var up = sd * sp + cd * cp * Math.cos(w);
    var no = sd * cp - cd * sp * Math.cos(w);
    var ea = -cd * Math.sin(w);
    out.set(ea, up, -no).normalize();
    return out;
  }

  function lunarVector(hour, N, out) {
    // synodic phase: new moon transits with the sun, full moon opposes it
    var phase = 2 * PI * ((N % 29.53) / 29.53);
    var B = 2 * PI * (N - 81) / 364;
    var EoT = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);
    var solar = hour + (4 * (LON - TZMER) + EoT) / 60;
    var w = 15 * DEG * (solar - 12) - phase;
    var dec = 23.45 * DEG * Math.sin(2 * PI * (284 + N) / 365) * 0.55 + 5.14 * DEG * Math.sin(phase * 1.13 + 0.7);
    var sd = Math.sin(dec), cd = Math.cos(dec), sp = Math.sin(LAT), cp = Math.cos(LAT);
    out.set(-cd * Math.sin(w), sd * sp + cd * cp * Math.cos(w), -(sd * cp - cd * sp * Math.cos(w))).normalize();
    moonFrac = 0.5 * (1 - Math.cos(phase));
    return out;
  }

  function airmass(altDeg) {
    if (altDeg < -1.5) return 80;
    var a = Math.max(altDeg, -1.5);
    return 1 / (Math.sin(a * DEG) + 0.50572 * Math.pow(a + 6.07995, -1.6364));
  }

  /* fraction of the ozone tent (peak 25 km, half-width 15 km) lying above h */
  function ozoneAbove(h) {
    if (h <= 10) return 1;
    if (h >= 40) return 0;
    if (h <= 25) return (7.5 + (225 - (h - 10) * (h - 10)) / 30) / 15;
    return ((40 - h) * (40 - h) / 30) / 15;
  }

  /* Spectral transmittance of the beam reaching a point at altitude h (km)
     from a sun that stands altDeg above that point's LOCAL horizontal.  The
     horizon dip lets grazing twilight rays out of the atmosphere instead of
     drowning them in a sea-level airmass — this is what keeps the belt of
     Venus alive on the CPU side. */
  function beamTransmittanceAt(h, altDeg, out) {
    h = Math.max(h, 0);
    var dip = Math.acos(Math.min(RG / (RG + h), 1)) / DEG;
    var m = Math.min(airmass(altDeg + dip), 80);
    var fR = Math.exp(-h / 8.0);
    var fA = (1.2 * Math.exp(-h / 1.2) + 2.952 * Math.exp(-h / 0.36)) / 4.152;
    var fO = ozoneAbove(h);
    for (var i = 0; i < 3; i++) out[i] = Math.exp(-m * (TAU_R[i] * fR + TAU_A[i] * fA + TAU_O[i] * fO));
    return out;
  }

  function beamTransmittance(altDeg, out) { return beamTransmittanceAt(0, altDeg, out); }

  /* compact CPU mirror of the sky raymarch — 4 directions/frame, hue only */
  var _tmpT = [0, 0, 0];
  function cpuSky(dx, dy, dz, out) {
    var r0 = RG + 0.002, mu = dy;
    var tmax = Math.max(-r0 * mu + Math.sqrt(Math.max(r0 * r0 * (mu * mu - 1) + RA * RA, 0)), 0);
    var disc = r0 * r0 * (mu * mu - 1) + RG * RG;
    if (mu < 0 && disc > 0) tmax = Math.max(-r0 * mu - Math.sqrt(disc), 0);
    tmax = Math.min(tmax, 320);
    var nu = dx * sunDir.x + dy * sunDir.y + dz * sunDir.z;
    var pr = (3 / (16 * PI)) * (1 + nu * nu);
    var g = 0.820, g2 = g * g, dd = 1 + g2 - 2 * g * nu;
    var pm = (1 - g2) / (4 * PI * Math.max(dd * Math.sqrt(Math.max(dd, 1e-4)), 1e-4));
    var L = [0, 0, 0], T = [1, 1, 1], N = 14;
    for (var i = 0; i < N; i++) {
      var f0 = i / N, f1 = (i + 1) / N;
      var a0 = tmax * f0 * f0, a1 = tmax * f1 * f1, dt = a1 - a0;
      if (dt < 1e-6) continue;
      var tm = 0.5 * (a0 + a1);
      var qx = dx * tm, qy = r0 + dy * tm, qz = dz * tm;
      var r = Math.max(Math.sqrt(qx * qx + qy * qy + qz * qz), RG);
      var h = r - RG;
      var muS = (qx * sunDir.x + qy * sunDir.y + qz * sunDir.z) / r;
      var ch = -Math.sqrt(Math.max(1 - (RG * RG) / (r * r), 0));
      var shd = smoothstepf(ch - 0.0075, ch + 0.0075, muS + 0.0026);
      var shdM = smoothstepf(ch - 0.075, ch + 0.075, muS + 0.0026);
      var altS = Math.asin(clamp(muS, -1, 1)) / DEG;
      beamTransmittanceAt(h, altS, _tmpT);
      var dR = Math.exp(-h / 8), dM = Math.exp(-h / 1.2) + 8.2 * Math.exp(-h / 0.36);
      var dO = Math.max(0, 1 - Math.abs(h - 25) / 15);
      for (var c = 0; c < 3; c++) {
        var sR = BETA_R[c] * dR, sM = BETA_M * dM;
        var ext = Math.max(BETA_R[c] * dR + BETA_M_E * dM + BETA_O[c] * dO, 1e-9);
        var tl = _tmpT[c];
        var inS = (sR * pr + sM * pm) * tl * shd;
        // must mirror the GPU LUT's multiple-scattering term exactly
        var msFwd = clamp(hgF(nu, 0.55) * 4 * PI, 0, 24);
        var msPh = Math.max(0.70 + 0.16 * (pr * 4 * PI / 3) + 0.145 * (msFwd - 1), 0.30);
        var iso = (sR + sM * 0.015) * (0.25 / PI) * Math.pow(Math.max(tl, 1e-5), 0.22) * shdM * msPh;
        var st = Math.exp(-ext * dt);
        L[c] += T[c] * ((inS + iso * 0.74) * (1 - st) / ext);
        T[c] *= st;
      }
    }
    out[0] = L[0] * 178; out[1] = L[1] * 178; out[2] = L[2] * 178;
    return out;
  }

  function normCol(c, col) {
    var m = Math.max(c[0], c[1], c[2], 1e-6);
    col.setRGB(c[0] / m, c[1] / m, c[2] / m);
    return col;
  }

  /* ====================================================================== */
  /*  environment map                                                        */
  /* ====================================================================== */
  var envAcc = 1e9, envSunY = -9, envDirty = true;
  S.envInterval = 5.0;
  S.manageEnvironment = true;

  function updateEnv(dt) {
    if (!pmrem || !envScene) return;
    envAcc += dt;
    var moved = Math.abs(sunDir.y - envSunY) > 0.0087;                // ~0.5 deg
    if (!envDirty && !moved && envAcc < S.envInterval) return;
    envAcc = 0; envSunY = sunDir.y; envDirty = false;
    var oldRT = envRT;
    try {
      envRT = pmrem.fromScene(envScene, 0, 0.5, 200);
    } catch (e) { envRT = oldRT; return; }
    S.envMap = envRT ? envRT.texture : null;
    if (oldRT && oldRT !== envRT) oldRT.dispose();
    if (S.manageEnvironment && scene && S.envMap) scene.environment = S.envMap;
  }

  /* ====================================================================== */
  /*  lights                                                                 */
  /* ====================================================================== */
  var sunLight = null, fillLight = null, ownLight = false;

  function buildLights(sc) {
    var existing = false;
    sc.traverse(function (o) { if (o.isDirectionalLight) existing = true; });
    sunLight = new THREE.DirectionalLight(0xffffff, 100);
    sunLight.name = 'SAIL.sky.sun';
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.set(2048, 2048);
    var c = sunLight.shadow.camera;
    c.left = -30; c.right = 30; c.top = 30; c.bottom = -30;
    c.near = 1; c.far = 260; c.updateProjectionMatrix();
    sunLight.shadow.bias = -0.0006;
    sunLight.shadow.normalBias = 0.045;
    sunLight.target.position.set(0, 0, 0);
    S.sunLight = sunLight;
    S.shadowTexel = 60 / 2048;
    if (!existing) {
      sc.add(sunLight); sc.add(sunLight.target); ownLight = true;
      fillLight = new THREE.HemisphereLight(0x9ec4ff, 0x1d3a4a, 0.0);
      fillLight.name = 'SAIL.sky.fill';
      sc.add(fillLight);
      S.fillLight = fillLight;
    }
  }

  var _lp = new THREE.Vector3(), _lt = new THREE.Vector3();
  function updateLights() {
    if (!sunLight) return;
    var night = sunDir.y < 0.005 && moonDir.y > 0.02;
    var dir = night ? moonDir : sunDir;
    var E = night ? U.uSkyMoonE.value * 1.0 : U.uSkySunE.value;
    if (night) sunLight.color.setRGB(0.62, 0.74, 1.0);
    else sunLight.color.copy(sunColor);
    sunLight.intensity = Math.max(E, 0.0);
    sunLight.castShadow = E > 0.6;

    // follow the boat / camera, snapped to the shadow texel grid
    var e = SAIL.env, tx = 0, tz = 0, ty = 0;
    if (SAIL.boat && typeof SAIL.boat.x === 'number') { tx = SAIL.boat.x; tz = SAIL.boat.z; }
    else if (e && e.camPos) { tx = e.camPos.x; tz = e.camPos.z; }
    else if (SAIL.camera) { tx = SAIL.camera.position.x; tz = SAIL.camera.position.z; }
    var tex = S.shadowTexel;
    tx = Math.round(tx / tex) * tex; tz = Math.round(tz / tex) * tex;
    _lt.set(tx, ty, tz);
    _lp.copy(dir).multiplyScalar(180).add(_lt);
    sunLight.position.copy(_lp);
    sunLight.target.position.copy(_lt);
    sunLight.target.updateMatrixWorld();

    if (fillLight) {
      fillLight.intensity = U.uSkySkyE.value * 0.55;
      fillLight.color.copy(skyColor);
      fillLight.groundColor.setRGB(0.10, 0.20, 0.26);
    }
  }

  /* ====================================================================== */
  /*  build                                                                  */
  /* ====================================================================== */
  var built = false, quality = 'high';

  S.build = S.init = function (a, b) {
    var sc = (a && a.isScene) ? a : ((b && b.isScene) ? b : SAIL.scene);
    var rn = (a && a.isWebGLRenderer) ? a : ((b && b.isWebGLRenderer) ? b : SAIL.renderer);
    if (!rn) { S.ready = false; return S; }
    scene = sc || scene; renderer = rn;
    if (built) { S.rebuild(); if (scene && dome && dome.parent !== scene) scene.add(dome); return S; }

    var gl = renderer.getContext();
    hdrOK = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
    lutType = hdrOK ? THREE.HalfFloatType : THREE.UnsignedByteType;
    U.uSkyLutScale.value = hdrOK ? 1.0 : 60.0;

    makeQuad();
    buildTransmittance();
    buildNoise();
    buildLandTex(false);
    allocForQuality();
    buildDome();
    if (scene) { scene.add(dome); buildLights(scene); }

    try { pmrem = new THREE.PMREMGenerator(renderer); pmrem.compileCubemapShader(); } catch (e) { pmrem = null; }

    built = true; S.ready = true;
    S.update(0, 0.016);
    renderCloudBand(true);
    renderCloudShadow(true);      // all bands, or the world starts in shadow
    updateEnv(1e9);
    try { S.selfTest(); } catch (e) {}
    return S;
  };

  function allocForQuality() {
    quality = (SAIL.quality === 'low') ? 'low' : 'high';
    /* CL_TARGET is now a FINE-step budget, not a total-step budget: the march
       probes empty space at 3.2x this and only spends steps where there is
       cloud, so a much denser nominal sampling costs about what the old fixed
       march did.  CL_STEPS is the hard iteration cap. */
    /* PANORAMA RESOLUTION IS NOT A QUALITY DIAL, IT IS A CORRECTNESS ONE.
       768x384 is 0.469 deg per texel.  At the scene's ~92 deg horizontal field
       across 1800 px (19.5 px/deg) one texel covers 9.2 screen pixels, so every
       cloud the panorama serves — reflections, PMREM, aerial perspective, and
       any dome fragment the screen march declines — arrives as 8-16 px blocks
       with no silhouette left in it.  2048x1024 is 0.176 deg/texel = 3.4 screen
       px, which the Catmull-Rom tap in sailCloudSample then reconstructs into
       something continuous.  The cost is paid back by banding harder: 16 bands
       renders 2048x64 per frame (131 k px, about a quarter of the screen
       march) and refreshes the whole dome every 16 frames, which is 0.27 s for
       a field that moves 2 m in that time. */
    if (quality === 'low') {
      CLOUD_BANDS = 12;
      S.cloudScale = 0.50;
      buildSkyLUT(192, 96, 24);
      buildCloudLUT(1024, 512, 56, 80, 4);
      buildScreenCloud(70, 92, 4);
    } else {
      CLOUD_BANDS = 16;
      /* 0.56 -> 0.68.  0.56 backs a 1600 px frame with an 896 px buffer: 1.8
         screen px per marched sample, which the bilateral upsample can only
         feather, and the residual is the 2 px lattice that survived TAA. */
      S.cloudScale = 0.68;
      buildSkyLUT(384, 192, 34);
      buildCloudLUT(2048, 1024, 72, 96, 6);
      buildScreenCloud(88, 116, 6);
    }
    buildCloudShadow();
    if (domeMat) { for (var k in U) domeMat.uniforms[k] = U[k]; domeMat.needsUpdate = true; }
    skyDirty = true; envDirty = true;
  }

  S.rebuild = function () {
    if (!built) return;
    var want = (SAIL.quality === 'low') ? 'low' : 'high';
    if (want === quality) { skyDirty = true; envDirty = true; return; }
    allocForQuality();
    renderCloudBand(true);
    renderCloudShadow(true);
  };

  /* ====================================================================== */
  /*  update                                                                 */
  /* ====================================================================== */
  var skyDirty = true, lastSunY = -99, lastSunX = -99, cloudT = 0;
  var _c1 = [0, 0, 0], _c2 = [0, 0, 0], _c3 = [0, 0, 0], _tb = [0, 0, 0];

  S.update = function (t, dt) {
    if (!S.ready || !renderer) return;
    if (typeof t === 'object' && t) { dt = t.dt; t = t.t; }
    t = (typeof t === 'number') ? t : 0;
    dt = (typeof dt === 'number' && dt > 0 && dt < 0.5) ? dt : 0.016;

    var e = SAIL.env = SAIL.env || {};
    var hour = (typeof e.hourOfDay === 'number') ? e.hourOfDay : 13.0;
    hour = ((hour % 24) + 24) % 24;
    var N = dayOfYear();

    /* ---- astronomy ---- */
    solarVector(hour, N, sunDir);
    lunarVector(hour, N, moonDir);
    sunAltDeg = Math.asin(clamp(sunDir.y, -1, 1)) / DEG;
    moonAltDeg = Math.asin(clamp(moonDir.y, -1, 1)) / DEG;

    /* ---- direct beam ---- */
    beamTransmittance(sunAltDeg, _tb);
    var setFade = smoothstepf(-0.85, 0.45, sunAltDeg);
    var cloud = (typeof e.cloudCover === 'number') ? clamp(e.cloudCover, 0, 1)
              : (typeof e.cloudiness === 'number') ? clamp(e.cloudiness, 0, 1) : 0.35;
    var sunE = 100 * (lum3(_tb) / 0.8525) * setFade;
    sunE *= 1 - 0.55 * cloud * cloud;
    sunE = Math.max(sunE, 0);
    normCol(_tb, sunColor);

    /* ---- sky irradiance schedule ---- */
    var skyE;
    if (sunAltDeg > 0) skyE = 12.0 * (0.055 + 0.945 * Math.pow(Math.sin(sunAltDeg * DEG), 0.55));
    else skyE = 12.0 * 0.055 * Math.exp(sunAltDeg / 3.2);
    skyE *= 1 + 0.42 * cloud;

    /* ---- moon ---- */
    var moonUp = smoothstepf(-0.02, 0.10, moonDir.y);
    var moonE = 0.42 * moonFrac * moonUp * Math.pow(Math.max(moonDir.y, 0), 0.35);
    moonE *= 1 - 0.7 * cloud;
    /* stars/airglow fade in through nautical twilight: 0 at -1.7 deg, 1 at -12 */
    var night = smoothstepf(-0.030, -0.21, sunDir.y);
    skyE = Math.max(skyE, night * (0.055 + 0.34 * moonE));

    U.uSkySunDir.value.copy(sunDir);
    U.uSkyMoonDir.value.copy(moonDir);
    U.uSkySunTint.value.set(sunColor.r, sunColor.g, sunColor.b);
    U.uSkySunE.value = sunE;
    U.uSkySkyE.value = skyE;
    U.uSkyMoonE.value = moonE;
    U.uSkyMoonFrac.value = moonFrac;
    U.uSkyNight.value = night;
    U.uSkyTime.value = t;

    /* ---- exposure schedule ---- */
    var key = 0.28 * sunE + 0.55 * skyE;
    var exposure = clamp(0.030 * Math.pow(34.6 / Math.max(key, 1e-3), 0.78), 0.004, 1.2);
    /* Golden hour is a colossal aureole over a dark world.  Exposing for the
       mean pushes the whole solar half of the sky onto a flat cream plateau —
       exactly the "uniform beige fill" failure.  Stop down through the last
       15 deg of altitude and let the sun's immediate surround clip, the way a
       camera metering for the sky would. */
    var trim = 0.78 + 0.22 * smoothstepf(0.5, 15.0, sunAltDeg);
    exposure *= 1.0 + (trim - 1.0) * smoothstepf(-6.0, -0.5, sunAltDeg);
    U.uSkyExposure.value = exposure;

    /* ---- sidereal star rotation about the celestial pole ---- */
    var ang = -(hour / 24) * 2 * PI - N * 0.0172;
    var ax = 0, ay = Math.sin(LAT), az = -Math.cos(LAT);
    var ca = Math.cos(ang), sa = Math.sin(ang), ic = 1 - ca;
    starRot.set(
      ca + ax * ax * ic, ax * ay * ic - az * sa, ax * az * ic + ay * sa,
      ay * ax * ic + az * sa, ca + ay * ay * ic, ay * az * ic - ax * sa,
      az * ax * ic - ay * sa, az * ay * ic + ax * sa, ca + az * az * ic
    );
    U.uSkyStarRot.value.copy(starRot);

    /* ---- colours for the rest of the engine ---- */
    cpuSky(sunDir.x * 0.9994, 0.0105, sunDir.z * 0.9994, _c1);      // horizon toward sun
    cpuSky(-sunDir.x * 0.9994, 0.0105, -sunDir.z * 0.9994, _c2);    // horizon away
    cpuSky(0, 1, 0, _c3);                                           // zenith
    var hz = [0.5 * (_c1[0] + _c2[0]), 0.5 * (_c1[1] + _c2[1]), 0.5 * (_c1[2] + _c2[2])];
    if (night > 0.01) {
      /* must mirror sailNightSky() in the shared chunk */
      var nb = [0.040 * moonE + 0.0048, 0.086 * moonE + 0.0076, 0.225 * moonE + 0.0172];
      var hb = [0.0064, 0.0082, 0.0074];                       // horizon airglow
      for (var i = 0; i < 3; i++) {
        hz[i] += (nb[i] + hb[i] * 0.93) * night;
        _c3[i] += nb[i] * night;
      }
    }
    horizonColor.setRGB(hz[0], hz[1], hz[2]);          // linear RADIANCE, not normalised
    zenithColor.setRGB(_c3[0], _c3[1], _c3[2]);
    normCol(hz, horizonHue);
    normCol(_c3, zenithHue);
    var sk = [0.42 * hz[0] + 0.58 * _c3[0], 0.42 * hz[1] + 0.58 * _c3[1], 0.42 * hz[2] + 0.58 * _c3[2]];
    normCol(sk, skyColor);
    S.horizonE = lum3(hz); S.zenithE = lum3(_c3);

    S.sunDir = sunDir; S.moonDir = moonDir;
    S.sunColor = sunColor; S.skyColor = skyColor;
    S.horizonColor = horizonColor; S.zenithColor = zenithColor;
    S.horizonHue = horizonHue; S.zenithHue = zenithHue;
    S.sunE = sunE; S.skyE = skyE; S.moonE = moonE; S.exposure = exposure;
    S.sunAltitudeDeg = sunAltDeg; S.moonAltitudeDeg = moonAltDeg; S.moonPhase = moonFrac;
    S.night = night; S.cloudCover = cloud;

    e.sunDir = sunDir; e.sunColor = sunColor; e.sunE = sunE; e.skyE = skyE;
    e.exposure = exposure; e.horizonColor = horizonColor; e.moonDir = moonDir;
    e.skyColor = skyColor;

    /* ---- sky LUT: rebuild only when the sun actually moved ---- */
    if (skyDirty || Math.abs(sunDir.y - lastSunY) > 1.2e-3 || Math.abs(sunDir.x - lastSunX) > 1.2e-3) {
      lastSunY = sunDir.y; lastSunX = sunDir.x; skyDirty = false;
      matSky.uniforms.uSun.value = sunDir;
      matSky.uniforms.uTrans.value = rtTrans.texture;
      matSky.uniforms.uScale.value = U.uSkyLutScale.value;
      blit(matSky, rtSky);
      envDirty = true;
    }

    /* ---- clouds ---- */
    if (!landRefined && ((SAIL.island && SAIL.island.depthAt) || (SAIL.world && SAIL.world.depthAt))) {
      landRefined = true; buildLandTex(true);
    }
    var wx = 0, wz = 0;
    if (typeof e.windX === 'number' && typeof e.windZ === 'number') { wx = e.windX; wz = e.windZ; }
    else {
      var wd = (typeof e.windDirDeg === 'number' ? e.windDirDeg : 75) * DEG;
      var ws = (typeof e.windKn === 'number' ? e.windKn : 14) * 0.5144;
      wx = -Math.sin(wd) * ws; wz = Math.cos(wd) * ws;
    }
    cloudT += dt;
    if (cloudT > 21600) cloudT -= 21600;      // keep shader float precision sane
    var cu = matCloud.uniforms;
    cu.uT.value = cloudT;
    cu.uWind.value.set(-wx * 1.35, -wz * 1.35);          // texture scrolls upwind
    /* Downwind lean of the cells: ~330 m of shear across the whole slab, in
       the direction the air is going, independent of wind strength so light
       airs do not give perfectly vertical towers. */
    var wl = Math.hypot(wx, wz) || 1;
    cu.uShear.value.set(-wx / wl * 210, -wz / wl * 210);
    cu.uScale.value = U.uSkyLutScale.value;
    var cam = SAIL.camera ? SAIL.camera.position : (e.camPos || null);
    if (cam) cu.uCam.value.set(cam.x, Math.max(cam.y, 1.5), cam.z);
    var useMoon = sunDir.y < 0.01 && moonDir.y > 0.02;
    cu.uLightDir.value.copy(useMoon ? moonDir : sunDir);
    /* Moonlit cloud.  uDirect is calibrated for a sunlit cumulus top, so the
       lunar beam has to be scaled down here or a 10% moon lights the deck like
       an overcast noon once the auto-exposure has had its way with the frame. */
    if (useMoon) cu.uLightCol.value.set(moonE * 0.26, moonE * 0.31, moonE * 0.42);
    else cu.uLightCol.value.set(sunE * sunColor.r, sunE * sunColor.g, sunE * sunColor.b);
    var cs = clamp(cloud, 0, 1);
    /* Coverage.  The review measured 63.9% of the sky band filled — a wall.
       Trade-wind cumulus is 15-30% plan cover, and because the weather map is
       now a Worley CELL field rather than an fbm plateau, this number maps
       almost directly onto apparent cover instead of being amplified by lobe
       merging.  Default env cloudCover 0.35 -> 0.335 here. */
    cu.uCover.value.set(0.10 + 0.67 * cs, 0.085);     // x = coverage, y = orographic bias
    cu.uAmb.value = 1.0;
    renderCloudBand(false);
    renderScreenCloud();

    /* Cloud shadow plane: amortised over 3 frames, and only worth anything
       while the sun is actually up.  The strength ramps with elevation so it
       does not pop on at dawn. */
    /* Trade-wind cumulus shadows on open water take 45-60% off the direct
       component, not 40.  0.90 -> 0.96 on the ceiling; consumers see the full
       range through sailCloudShadow(). */
    S.cloudShadowStrength = 0.96 * smoothstepf(0.02, 0.20, sunDir.y) * (0.35 + 0.65 * cs);
    renderCloudShadow(false);

    /* ---- dome follows the camera, sized inside the frustum ---- */
    if (dome) {
      var c3 = SAIL.camera;
      if (c3) {
        dome.position.copy(c3.position);
        var R = Math.min(9000, Math.max(c3.near * 50 + 1, c3.far * 0.4));
        if (Math.abs(dome.scale.x - R) > 1) dome.scale.setScalar(R);
      } else if (cam) dome.position.set(cam.x, cam.y, cam.z);
    }

    pushUniforms();
    updateLights();
    updateEnv(dt);
  };

  /* ====================================================================== */
  /*  small public helpers                                                   */
  /* ====================================================================== */
  S.setTime = function (h) { (SAIL.env = SAIL.env || {}).hourOfDay = h; skyDirty = true; envDirty = true; };
  S.setCloudCover = function (v) { (SAIL.env = SAIL.env || {}).cloudCover = clamp(v, 0, 1); envDirty = true; };
  /* haze multiplier on the marine boundary layer: 1 = ~50 km visibility */
  S.setHaze = function (v) {
    var k = clamp(v, 0.15, 6.0);
    hazeK.value = k;
    U.uSkyBetaMe.value = BETA_M_E * 1e-3 * (1.0 + (k - 1.0) * 0.87);
    if (built) { buildTransmittance(); skyDirty = true; envDirty = true; }
  };
  S.haze = function () { return hazeK.value; };
  S.markDirty = function () { skyDirty = true; envDirty = true; };

  /* Aerial perspective on the CPU (HUD range rings, fog-matched clear colour) */
  S.aerialTransmittance = function (dist, y0, y1) {
    y0 = y0 || 0; y1 = (typeof y1 === 'number') ? y1 : 0;
    function pd(H) {
      var dy = y1 - y0, a = Math.exp(-Math.max(y0, 0) / H);
      if (Math.abs(dy) < 0.75) return dist * a * Math.exp(-0.5 * dy / H);
      return dist * H * (a - Math.exp(-Math.max(y1, 0) / H)) / dy;
    }
    var odR = pd(8000), odM = pd(1200) + 8.2 * pd(360);
    var bm = U.uSkyBetaMe.value;
    return [Math.exp(-(BETA_R[0] * 1e-3 * odR + bm * odM)),
            Math.exp(-(BETA_R[1] * 1e-3 * odR + bm * odM)),
            Math.exp(-(BETA_R[2] * 1e-3 * odR + bm * odM))];
  };
  S.skyRadianceAt = function (dx, dy, dz) {
    var o = [0, 0, 0]; var l = Math.hypot(dx, dy, dz) || 1;
    return cpuSky(dx / l, dy / l, dz / l, o);
  };

  /* ====================================================================== */
  /*  SELF TEST — cumulus crown-over-base ratio                              */
  /*  This subsystem has silently INVERTED twice: a build shipped with the   */
  /*  underside measurably brighter and warmer than the sun-facing crown,    */
  /*  which is not a near miss but a sign error, and it is invisible in a    */
  /*  thumbnail — a flat white cutout and a properly lit cell look identical */
  /*  until you put a probe on them.  So the shading ladder is mirrored here */
  /*  for a nominal 1400 m trade cumulus and the ratio is asserted on build. */
  /*  Anything that touches uDirect, uSigma, uSunPath, the Wrenninge octave  */
  /*  constants or the aUp/aDn split has to keep this above CROWN_BASE_MIN.  */
  /* ====================================================================== */
  var CROWN_BASE_MIN = 1.8;          // stops, scene-referred

  function cloudLadder(dl, nu) {     // must mirror clShade() exactly
    var lum = 0, a = 1, b = 1, c = 1;
    for (var o = 0; o < 3; o++) {
      var ph = 0.83 * hgF(nu, 0.78 * c) + 0.17 * hgF(nu, -0.30 * c);
      lum += a * Math.exp(-dl * b) * ph;
      a *= 0.40; b *= 0.34; c *= 0.58;
    }
    return lum;
  }

  /* Radiance of a cumulus sample at height fraction hh inside a cell of the
     given thickness.  exposed = the sample sits on the lit outer shell (the
     view ray only penetrates ~1/(sigma*d) metres, so every shaded sample the
     camera can see is a near-surface sample); buried = it is under the column. */
  function cloudProbe(hh, thick, exposed) {
    var cu = matCloud ? matCloud.uniforms : cloudUniformDefaults();
    var sigma = cu.uSigma.value, d = 0.85;
    var sunY = Math.max(Math.abs(sunDir.y), 1e-3);
    /* stochastic march contribution: a lit shell clears the cloud in tens of
       metres, a buried sample stays inside it for most of the 2.4 km reach */
    var tau = exposed ? d * 70 : d * 900;
    var near = exposed ? d * 24 : d * 247;
    var buried = clamp(near / cu.uSunGate.value, 0, 1);
    var above = clamp(1 - hh, 0, 1) * thick;
    var ly = Math.max(Math.abs(sunY), 0.26);
    var pathA = above / ly; pathA = pathA / (1 + pathA * 0.0012);
    var dl = (tau + buried * pathA * cu.uSunPath.value) * sigma;
    var direct = U.uSkySunE.value * cu.uDirect.value * cloudLadder(dl, 0.0);
    var vis = clamp(hh, 0, 1); vis = vis * vis * (3 - 2 * vis); vis *= vis;
    var ambE = Math.max(U.uSkySkyE.value, 0);
    var aUp = ambE * 0.82, aDn = ambE * 0.36 + ambE * 0.018 + U.uSkySunE.value * 0.0030;
    var occ = exposed ? 0.92 : 0.45;
    return direct + (aDn + (aUp - aDn) * vis) * occ * cu.uAmb.value;
  }
  function cloudUniformDefaults() {
    return { uSigma: { value: 0.090 }, uDirect: { value: 56.0 }, uAmb: { value: 1.0 },
             uSunPath: { value: 0.42 }, uSunGate: { value: 120.0 } };
  }

  S.selfTest = function (quiet) {
    var thick = 1400;
    var crown = cloudProbe(0.97, thick, true);
    var base  = cloudProbe(0.04, thick, false);
    var stops = Math.log(crown / Math.max(base, 1e-6)) / Math.LN2;
    var ok = stops >= CROWN_BASE_MIN && crown > base;
    var msg = '[SAIL.sky] cumulus crown ' + crown.toFixed(1) + ' vs base ' + base.toFixed(1) +
              ' = ' + stops.toFixed(2) + ' stops (min ' + CROWN_BASE_MIN.toFixed(1) + ')';
    if (window.console && !quiet) {
      if (ok) console.log(msg + ' OK');
      else console.error(msg + ' FAIL — cumulus lighting is flat or inverted');
    }
    return { ok: ok, stops: stops, crown: crown, base: base };
  };

  S.dispose = function () {
    [rtTrans, rtSky, rtCloud, rtNoise, rtShape, rtDet, rtShadow, envRT, rtScr[0], rtScr[1]].forEach(function (r) { if (r) r.dispose(); });
    [matTrans, matSky, matCloud, matNoise, matScr, matShadow, domeMat].forEach(function (m) { if (m) m.dispose(); });
    rtScr[0] = rtScr[1] = null; scrValid = false;
    if (landTex) landTex.dispose();
    if (pmrem) pmrem.dispose();
    if (dome && dome.parent) dome.parent.remove(dome);
    if (ownLight && sunLight && sunLight.parent) {
      var p = sunLight.parent; p.remove(sunLight); p.remove(sunLight.target);
      if (fillLight && fillLight.parent) fillLight.parent.remove(fillLight);
    }
    built = false; S.ready = false;
  };

  S.sunDir = sunDir; S.moonDir = moonDir;
  S.sunColor = sunColor; S.skyColor = skyColor;
  S.horizonColor = horizonColor; S.zenithColor = zenithColor;
  S.envMap = null; S.ready = false;
})();
