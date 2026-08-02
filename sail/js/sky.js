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

   Clouds are a true 40-step raymarch through a spherical slab (900..2400 m)
   rendered into a panoramic 384x192 RGBA16F LUT, amortised over 3 frames in
   horizontal bands.  Density comes from one procedurally generated 512^2
   noise atlas sampled with height-dependent shear, which gives cumulus towers
   for the cost of 2D fetches.  Lighting: 5-step light march, 3-octave
   multiple-scattering approximation, dual-lobe HG (silver lining), Beer's-law
   powder term, sky ambient and full aerial perspective.

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
  var BETA_M = 5.0e-3;                                   // Mie scattering
  var BETA_M_E = BETA_M / 0.9;                           // Mie extinction
  /* Ozone Chappuis absorption.  This is the band that eats yellow-green and
     leaves the upper sky blue-violet while the horizon burns orange — without
     enough of it a sunset crosses from blue to gold through a dead neutral
     grey, which is the fingerprint of an sRGB lerp and reads as broken. */
  var BETA_O = [0.900e-3, 2.450e-3, 0.095e-3];           // ozone absorption
  // vertical optical depth of the whole column, split by species so the CPU
  // radiometry can attenuate each with its own altitude profile
  var TAU_R = [0.04370, 0.10300, 0.26700];   // Rayleigh   (H = 8.0 km)
  var TAU_A = [0.02125, 0.02292, 0.02498];   // aerosol    (1.2 km + marine 0.45 km)
  var TAU_O = [0.01350, 0.03675, 0.00143];   // ozone      (tent, 10..40 km)
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
  var CL_BASE = 700.0, CL_TOP = 2300.0;

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function smoothstepf(a, b, x) { var t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
  function lum3(c) { return LUM[0] * c[0] + LUM[1] * c[1] + LUM[2] * c[2]; }

  /* ------------------------------------------------- shared uniform objects
     One object per uniform, shared by reference with every material that
     registers, so updating .value here propagates everywhere.               */
  var U = {
    uSkyLUT:        { value: null },
    uSkyLutSize:    { value: new THREE.Vector2(256, 128) },
    uSkyTransLUT:   { value: null },
    uSkyTransSize:  { value: new THREE.Vector2(256, 64) },
    uSkyCloudLUT:   { value: null },
    uSkyCloudSize:  { value: new THREE.Vector2(384, 192) },
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
    uSkyExposure:   { value: 0.030 }
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
    'vec4 sailCloudSample(vec3 dir){',
    '  float el = asin(clamp(dir.y,-1.0,1.0));',
    '  float v = sqrt(clamp(el/(0.5*SAIL_PI), 0.0, 1.0));',
    '  float u = atan(dir.x, -dir.z)/(2.0*SAIL_PI) + 0.5;',
    '  v = clamp(v, 0.5/uSkyCloudSize.y, 1.0-0.5/uSkyCloudSize.y);',
    '  vec4 c = texture2D(uSkyCloudLUT, vec2(u,v));',
    '  float f = smoothstep(-0.0090, 0.0018, dir.y) * uSkyCloudMix;',
    '  return vec4(c.rgb*uSkyLutScale*f, mix(1.0, clamp(c.a,0.0,1.0), f)); }',
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
    '  float odM = sailPathDens(cp.y, wp.y, dist, 1200.0) + 6.5*sailPathDens(cp.y, wp.y, dist, 450.0);',
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
    'float atmDM(float h){ h = max(h,0.0); return exp(-h/1.2) + 6.5*uHazeK*exp(-h/0.45); }',
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
        uMS: { value: 0.92 },
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
        '    vec3 Tms = pow(max(Tl, vec3(1e-5)), vec3(0.44));',
        '    float msPh = 0.72 + 0.28*(pr*4.0*ATM_PI/3.0);',
        '    vec3 iso = (sR + sM*0.04)*(0.25/ATM_PI)*(Tms*shdM)*msPh;',
        '    vec3 stepT = exp(-ext*dt);',
        '    L += T*((inS + iso*uMS)*(vec3(1.0)-stepT)/ext);',
        '    T *= stepT; }',
        '  if (ground){',
        '    float muS = dot(normalize(vec3(dir.x*tMax, r0+dir.y*tMax, dir.z*tMax)), uSun);',
        '    vec3 gT = trans(ATM_RG+0.0005, max(muS,0.0));',
        '    L += T*(0.035/ATM_PI)*max(muS,0.0)*gT*vec3(0.55,0.75,1.0); }',
        '  L *= uSunIrr;',
        '  L = max(L, vec3(0.0));',
        '  float lm = dot(L, vec3(0.3333)); if (!(lm < 1e5)) L = vec3(0.0);',
        '  gl_FragColor = vec4(min(L, vec3(12000.0))/uScale, 1.0); }'
      ].join('\n')
    }));
    U.uSkyLUT.value = rtSky.texture;
    U.uSkyLutSize.value.set(w, h);
  }

  /* ------------------------------------------------------------ cloud noise */
  function buildNoise() {
    if (rtNoise) return;
    /* NO MIPMAPS.  Every tap happens inside a raymarch loop, where the screen
       derivatives that drive LOD selection are undefined — a mipped atlas
       silently blurs to a random level per pixel and stipples the cloud.  The
       feature scales below are instead chosen coarse enough (>= ~60 m) that
       the march resolves them without aliasing in the first place.          */
    rtNoise = new THREE.WebGLRenderTarget(512, 512, {
      type: THREE.UnsignedByteType, format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false
    });
    rtNoise.texture.colorSpace = THREE.LinearSRGBColorSpace;
    matNoise = post(new THREE.ShaderMaterial({
      uniforms: {},
      vertexShader: QUAD_VS,
      fragmentShader: [
        'precision highp float;',
        '/* the +offset and +phase matter: sin(dot(0,k))=0 makes lattice (0,0)',
        '   exactly black, which visibly biases a low-period fbm. */',
        'float h1(vec2 p){ return fract(sin(dot(p+0.71,vec2(127.1,311.7))+1.7)*43758.5453123); }',
        'float h2(vec2 p){ return fract(sin(dot(p+1.37,vec2(269.5,183.3))+4.3)*24634.6345); }',
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
        'float wor(vec2 p, float per){',
        '  vec2 i = floor(p), f = fract(p); float m = 8.0;',
        '  for (int y=-1;y<=1;y++) for (int x=-1;x<=1;x++){',
        '    vec2 g = vec2(float(x), float(y));',
        '    vec2 mi = mod(i+g, per);',
        '    vec2 o = vec2(h1(mi), h2(mi));',
        '    m = min(m, length(g+o-f)); }',
        '  return clamp(m, 0.0, 1.0); }',
        'void main(){',
        '  vec2 uv = gl_FragCoord.xy/512.0;',
        '  float base = fbm(uv*8.0, 8.0, 5);',
        '  base = clamp((base-0.30)/0.55, 0.0, 1.0);',
        '  float bl = 1.0 - wor(uv*6.0, 6.0);',
        '  float bl2 = 1.0 - wor(uv*13.0, 13.0);',
        '  float bill = clamp(bl*0.62 + bl2*0.38, 0.0, 1.0);',
        '  /* A pure inverted-Worley field is bright at the feature points and',
        '     DARK ALONG EVERY CELL BOUNDARY, i.e. it is a net.  Erode a cloud',
        '     with that and you get a chain-link screen-door across the whole',
        '     sky.  Cross-fade both cellular channels with plain fbm so the cell',
        '     network dissolves and only the billow survives. */',
        '  bill = clamp(mix(pow(bill,1.25), fbm(uv*11.0, 11.0, 4), 0.34), 0.0, 1.0);',
        '  float det = fbm(uv*21.0, 21.0, 4);',
        '  det = mix(det, 1.0-wor(uv*24.0,24.0), 0.20);',
        '  float weather = fbm(uv*4.0 + 11.3, 4.0, 3);',
        '  weather = clamp((weather-0.24)/0.52, 0.0, 1.0);',
        '  gl_FragColor = vec4(base, bill, clamp(det,0.0,1.0), weather); }'
      ].join('\n')
    }));
    blit(matNoise, rtNoise);
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
    'uniform sampler2D uNoise, uLand;',
    'uniform vec2 uWind, uCover, uShear, uRes;',
    'uniform vec3 uCam, uLightDir, uLightCol;',
    'uniform float uT, uSigma, uBase, uTop, uPowder, uAmb, uScale, uMaxD;',
    'uniform float uDirect, uErode, uFade;',
    'float clLand(vec2 p){',
    '  vec2 uv = (p - vec2(' + LAND_ORIGIN.toFixed(1) + '))/' + LAND_SPAN.toFixed(1) + ';',
    '  return texture2D(uLand, clamp(uv, 0.004, 0.996)).r; }',
    '',
    '/* hn = height fraction of the whole slab.  hh (out) = height fraction of',
    '   THIS cell, which is what the shading needs: the top of a flat cell is',
    '   just as sunlit as the top of a tower.                                */',
    'float clDens(vec3 wp, float hn, float land, int lod, out float hh){',
    '  hh = 0.0;',
    '  vec2 q = wp.xz + uWind*uT;',
    '  float w = texture2D(uNoise, q/34000.0).a;',
    '  /* baked weather channel: mean 0.268, sd 0.089 -> (0.45+2.05w) is',
    '     unity-mean and swings x0.45..x2.5 across the synoptic patches. */',
    '  float cover = clamp(uCover.x*(0.45 + 2.05*w) + uCover.y*land, 0.0, 1.5);',
    '  float ty = texture2D(uNoise, q/19000.0 + vec2(0.37,0.61)).r;',
    '  float type = clamp(0.16 + 1.50*ty*ty + 0.30*land, 0.10, 1.0);',
    '  float top = mix(0.24, 1.0, type);',
    '  if (hn >= top) return 0.0;',
    '  hh = hn/top;',
    '  /* trade cumulus lean downwind as they build */',
    '  /* Scale matters more than anything else here.  A trade cumulus is about',
    '     as wide as it is tall (~1 km), so the dominant horizontal feature has',
    '     to be ~1.5 km.  With 300 m features and a 1.6 km slab the rising',
    '     threshold carves ice needles instead of cauliflower, no matter what',
    '     the profile curve does. */',
    '  vec2 qs = q + uShear*hn;',
    '  float b  = texture2D(uNoise, qs/10500.0).r;',
    '  float bi = texture2D(uNoise, (qs*1.20 + vec2(311.0,-197.0))/10500.0).g;',
    '  /* Low in the cell the broad fbm decides the footprint; high in the cell',
    '     the BILLOW takes over, which is what turns a smooth cone into a lumpy',
    '     cauliflower crown. */',
    '  /* A field extruded from 2D noise has a CONSTANT cross-section, so every',
    '     cloud ends up with vertical planar walls — stone monoliths, not',
    '     cumulus.  Translating a second slice by 2.4 km across the depth of the',
    '     slab decorrelates base from top and buys real 3D billowing out of one',
    '     more 2D fetch. */',
    '  float v3 = texture2D(uNoise, (qs*1.90 + vec2(2400.0,-3100.0)*hn)/10500.0).g;',
    '  float shape = mix(b*0.76 + bi*0.24, b*0.34 + bi*0.66, smoothstep(0.10, 0.85, hh));',
    '  shape = shape*0.72 + v3*0.28;',
    '  /* THE tower term.  The survival threshold climbs through the cell so',
    '     only the strongest cores reach the top — but pow(hh,2.1) keeps the',
    '     shoulders broad and puts all the narrowing in the last third, and the',
    '     smoothstep WIDTH opens up with height so the crown is a soft dome.',
    '     A linear rise with a fixed narrow width gives ice needles instead. */',
    '  float thr = 0.660 - 0.445*cover + 0.185*pow(hh, 2.10);',
    '  /* The transition WIDTH is the silhouette hardness.  A convecting top is',
    '     a crisp cauliflower edge against the blue; only the dissipating flanks',
    '     are soft.  So the width now NARROWS with height instead of opening up,',
    '     and the erosion below sharpens it further. */',
    '  float d = smoothstep(thr, thr + 0.185 - 0.045*smoothstep(0.25, 0.95, hh), shape);',
    '  if (d <= 0.0) return 0.0;',
    '  d *= smoothstep(0.0, 0.028 + 0.055*bi, hh);',
    '  d *= 1.0 - smoothstep(0.62, 1.0, hh*hh);',
    '  d *= mix(0.62, 1.42, smoothstep(0.02, 0.44, hh));',
    '  if (lod == 0){',
    '    /* Three octaves of billow erosion, weighted hard toward the top of the',
    '       cell: upper edges get bitten into cauliflower while the lower flanks',
    '       stay soft and wispy.  Without this the cloud is a handful of smooth',
    '       spheres — the cotton-wool signature. */',
    '    float e1 = texture2D(uNoise, (qs*2.10 + vec2(-83.0, 57.0))/10500.0).b;',
    '    float e2 = texture2D(uNoise, (qs*5.30 + vec2( 29.0,-41.0) + vec2(-1800.0,1500.0)*hn)/10500.0).b;',
    /* e3 must stay COARSER than the march step (~125 m) or it aliases into
       the stair-stepping that a raymarch shows on every silhouette: 10500/
       (8.6*8) is a ~150 m feature, which the march resolves. */
    '    float e3 = texture2D(uNoise, (qs*8.60 + vec2(517.0,-233.0) + vec2(900.0,-1400.0)*hn)/10500.0).b;',
    '    float ew = uErode*(0.13 + 0.42*smoothstep(0.20, 0.98, hh));',
    '    d = clamp(d - (1.0-d)*(e1*0.44 + e2*0.34 + e3*0.22)*ew, 0.0, 1.0); }',
    '  return d; }',
    '',
    'float clLight(vec3 wp, float land){',
    '  float tau = 0.0, t = 0.0, ds = 46.0, hh;',
    '  for (int i=0;i<CL_LIGHT;i++){',
    '    t += ds*0.5;',
    '    vec3 p = wp + uLightDir*t;',
    '    float hn = (p.y - uBase)/(uTop - uBase);',
    '    if (hn > 0.0 && hn < 1.0) tau += clDens(p, hn, land, 1, hh)*ds;',
    '    t += ds*0.5; ds *= 1.82; }',
    '  return tau; }',
    '',
    '/* Sunlit cauliflower top vs soft grey-blue base.  Three things make that',
    '   separation: the sun-ray march (self-shadowing), an upward occlusion tap',
    '   that darkens anything with cloud over it, and an ambient term that is a',
    '   real gradient from bright zenith sky down to dark sea-bounce.        */',
    /* TWO COLOURED SOURCES, NOT ONE SCALAR.
       A cloud is white water droplets lit by (a) direct sun, which is warm and
       gets warmer as it sets, and (b) the sky hemisphere, which is blue.  If
       both terms carry the same chromaticity the cloud reads as grey felt: lit
       side and shadow side differing only in value is the single most reliable
       tell of CG cloud.  So the direct term is multiplied by the SUN's
       chromaticity (uLightCol) and the fill by the SKY's (aUp/aDn, which the
       march derives from the actual sky radiance in the upward hemisphere).

       Getting the split right also means the direct multiple-scattering
       octaves have to DIE with depth.  The old a*=0.66 / b*=0.32 ladder left
       ~20% of full sunlight leaking through unattenuated at any optical depth,
       which poured white light into the shadow side and washed the blue fill
       straight back out.  The ladder below drops to ~12% of the top by the
       time the ray has 8 optical depths of cloud over it, which is what lets
       the skylight own the base.                                            */
    'vec3 clShade(vec3 wp, float hh, float land, float d, float nu, vec3 aUp, vec3 aDn){',
    '  float dl = clLight(wp, land)*uSigma;',
    '  float lum = 0.0;',
    '  float a = 1.0, b = 1.0, c = 1.0;',
    '  for (int o=0;o<4;o++){',
    '    float ph = mix(sailHG(nu, 0.84*c), sailHG(nu, -0.38*c), 0.24);',
    '    lum += a*exp(-dl*b)*ph;',
    '    a *= 0.10; b *= 0.45; c *= 0.85; }',
    '  /* powder / dark-edge, keyed to LOCAL density over a fixed reference',
    '     length so it never swings with the step size or view elevation */',
    '  float pw = 1.0 - exp(-d*uSigma*300.0);',
    '  lum *= mix(1.0, clamp(pw*1.60, 0.0, 1.35), uPowder);',
    '  float hu; vec3 up1 = wp + vec3(0.0, 260.0, 0.0);',
    '  float h1 = (up1.y - uBase)/(uTop - uBase);',
    '  float du = (h1 > 0.0 && h1 < 1.0) ? clDens(up1, h1, land, 1, hu) : 0.0;',
    '  float occ = mix(1.0, 0.66, clamp(du*1.9, 0.0, 1.0));',
    '  vec3 amb = mix(aDn, aUp, clamp(hh*1.25, 0.0, 1.0))*occ*uAmb;',
    '  return uLightCol*(lum*uDirect) + amb; }',
    ''
  ].join('\n');

  /* The march itself, shared verbatim by both passes.  CL_PANO selects the
     ray generator and the output path.                                     */
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
    '  float dith = fract(52.9829189*fract(dot(gl_FragCoord.xy, vec2(0.06711056,0.00583715))));',
    '#else',
    '  vec2 uv = gl_FragCoord.xy/uRes;',
    '  vec2 nd = uv*2.0 - 1.0;',
    '  vec3 dir = normalize(uFwd + uRight*(nd.x*uTan.x) + uUp*(nd.y*uTan.y));',
    '  float dith = fract(52.9829189*fract(dot(gl_FragCoord.xy, vec2(0.06711056,0.00583715))) + uFrame*0.6180339887);',
    '#endif',
    '  vec4 res = vec4(0.0, 0.0, 0.0, 1.0);',
    '  float r0 = SAIL_RG + max(uCam.y, 0.5)*0.001;',
    '  float mu = dir.y;',
    '  float kk = r0*r0*(mu*mu - 1.0);',
    '  float dg = kk + SAIL_RG*SAIL_RG;',
    '  bool below = (mu < 0.0 && dg > 0.0 && (-r0*mu - sqrt(dg)) > 0.0);',
    '  float rb = SAIL_RG + uBase*0.001, rt = SAIL_RG + uTop*0.001;',
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
    '      /* The two taps under-report the hemispheric fill (a real cloud face',
    '         integrates the whole sky, including the luminous horizon band and',
    '         the forward-scattered light around the sun), so the coefficient is',
    '         above the naive rho*E/pi.  This term is what carries the base: get',
    '         it wrong and the shadow side falls back to grey sunlight leak. */',
    '      vec3 aUp = sCh*(ambE*0.62) + nAmb;',
    '      /* sea bounce: weak, blue-green, and only ever on the underside */',
    '      vec3 aSea = vec3(0.24,0.46,0.52)*(ambE*0.018 + max(uSkySunE,0.0)*0.0045);',
    '      vec3 aDn = sCh*(ambE*0.66) + aSea + nAmb*0.55;',
    '      float nu = dot(dir, uLightDir);',
    '      vec3 scat = vec3(0.0);',
    '      float T = 1.0, mdist = 0.0, mw = 0.0;',
    '      /* Step length is the max of "cover the span in CL_TARGET samples"',
    '         and "1% of the distance", so the sample spacing stays roughly',
    '         constant in SCREEN space.  That is what lets the march reach the',
    '         130 km needed to put cloud on the horizon line without spending',
    '         a thousand steps to get there. */',
    '      float ds = max(min(span/float(CL_TARGET), 0.125), t0*0.0085);',
    '      float t = t0 + ds*dith;',
    '      for (int i=0;i<CL_STEPS;i++){',
    '        if (t >= t1 || T < 0.012) break;',
    '        vec3 q = vec3(dir.x*t, r0 + dir.y*t, dir.z*t);',
    '        float hgt = (length(q) - SAIL_RG)*1000.0;',
    '        float hn = (hgt - uBase)/(uTop - uBase);',
    '        if (hn > 0.0 && hn < 1.0){',
    '          vec3 wp = vec3(uCam.x + dir.x*t*1000.0, hgt, uCam.z + dir.z*t*1000.0);',
    '          float land = clLand(wp.xz);',
    '          float hh; float d = clDens(wp, hn, land, 0, hh);',
    '          if (d > 0.004){',
    '            vec3 src = clShade(wp, hh, land, d, nu, aUp, aDn);',
    '            float stepT = exp(-d*uSigma*ds*1000.0);',
    '            float wgt = T*(1.0 - stepT);',
    '            scat += src*wgt; mdist += t*wgt; mw += wgt; T *= stepT; } }',
    '        t += ds; ds = max(ds, t*0.0085); }',
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
    '        scat = scat*Ta + ins*(vec3(1.0)-Ta)*cov; }',
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
    '     translation of a boat.  History is rejected outright off-screen and',
    '     weighted down wherever the silhouette actually changed, which is the',
    '     only place ghosting is visible. */',
    '  if (uHistOn > 0.5){',
    '    float f = dot(dir, uPFwd);',
    '    if (f > 0.06){',
    '      vec2 ps = vec2(dot(dir, uPRight)/(f*uPTan.x), dot(dir, uPUp)/(f*uPTan.y));',
    '      vec2 pu = ps*0.5 + 0.5;',
    '      if (pu.x > 0.002 && pu.x < 0.998 && pu.y > 0.002 && pu.y < 0.998){',
    '        vec4 h = texture2D(uHist, pu);',
    '        float dd = abs(h.a - res.a) + 0.30*length(h.rgb - res.rgb)/(1.0 + length(res.rgb));',
    '        float w = 0.82*(1.0 - smoothstep(0.030, 0.24, dd));',
    '        res = mix(res, h, w); } } }',
    '  gl_FragColor = res;',
    '#endif',
    '}'
  ].join('\n');

  function cloudUniforms(w, h) {
    return {
      uRes:      { value: new THREE.Vector2(w, h) },
      uNoise:    { value: rtNoise.texture },
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
      uSigma:    { value: 0.052 },
      uBase:     { value: CL_BASE },
      uTop:      { value: CL_TOP },
      uPowder:   { value: 0.85 },
      uAmb:      { value: 1.0 },
      uScale:    { value: 1.0 },
      uMaxD:     { value: 130.0 },
      /* Gain that turns the 4-octave phase sum into scene-referred radiance.
         Calibrated against the sky it sits in: a sunlit cumulus top is about
         7x the zenith radiance and ~1.8x the horizon haze band, which is what
         a photometer reads on a trade-wind day.  Push it past that and the
         auto-exposure crushes the blue out of the sky to compensate; leave it
         short and the tops never reach white. */
      uDirect:   { value: 18.0 },
      uErode:    { value: 0.82 },
      uFade:     { value: 1.55 }
    };
  }

  /* -------------------------------------------------------- panoramic LUT */
  var cloudBand = 0, CLOUD_BANDS = 5;

  function buildCloudLUT(w, h, steps, target) {
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
      defines: { CL_PANO: 1, CL_STEPS: steps, CL_TARGET: target, CL_LIGHT: 5 },
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
  S.cloudScale = 0.48;                 // screen-space march resolution factor
  var rtScr = [null, null], scrFlip = 0, matScr = null;
  var scrW = 0, scrH = 0, scrFrame = 0, scrValid = false;
  var scrBasis = { r: new THREE.Vector3(1, 0, 0), u: new THREE.Vector3(0, 1, 0),
                   f: new THREE.Vector3(0, 0, -1), tan: new THREE.Vector2(1, 1),
                   pos: new THREE.Vector3() };
  var prevBasis = { r: new THREE.Vector3(1, 0, 0), u: new THREE.Vector3(0, 1, 0),
                    f: new THREE.Vector3(0, 0, -1), tan: new THREE.Vector2(1, 1) };
  var _bm = new THREE.Matrix4(), _dbs = new THREE.Vector2();

  function buildScreenCloud(steps, target) {
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
      defines: { CL_STEPS: steps, CL_TARGET: target, CL_LIGHT: 5 },
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
    b.uNoise.value = a.uNoise.value;
    b.uLand.value = a.uLand.value;
    b.uT.value = a.uT.value;
    b.uScale.value = a.uScale.value;
    b.uSigma.value = a.uSigma.value;
    b.uPowder.value = a.uPowder.value;
    b.uAmb.value = a.uAmb.value;
    b.uMaxD.value = a.uMaxD.value;
    b.uDirect.value = a.uDirect.value;
    b.uErode.value = a.uErode.value;
    b.uFade.value = a.uFade.value;
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
      du.uSFwd.value.copy(scrBasis.f); du.uSRight.value.copy(scrBasis.r);
      du.uSUp.value.copy(scrBasis.u); du.uSTan.value.copy(scrBasis.tan);
    }
  }

  /* ------------------------------------------------------------- the dome */
  function buildDome() {
    var du = S.getUniforms();
    du.uScrCloud = { value: null };
    du.uScrOn = { value: 0 };
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
        'uniform sampler2D uScrCloud; uniform float uScrOn;',
        'uniform vec3 uSFwd, uSRight, uSUp; uniform vec2 uSTan;',
        'varying vec3 vDir; varying vec4 vClip;',
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
        '        vec4 s = texture2D(uScrCloud, uv);',
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
    var fA = (1.2 * Math.exp(-h / 1.2) + 2.925 * Math.exp(-h / 0.45)) / 4.125;
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
      var dR = Math.exp(-h / 8), dM = Math.exp(-h / 1.2) + 6.5 * Math.exp(-h / 0.45);
      var dO = Math.max(0, 1 - Math.abs(h - 25) / 15);
      for (var c = 0; c < 3; c++) {
        var sR = BETA_R[c] * dR, sM = BETA_M * dM;
        var ext = Math.max(BETA_R[c] * dR + BETA_M_E * dM + BETA_O[c] * dO, 1e-9);
        var tl = _tmpT[c];
        var inS = (sR * pr + sM * pm) * tl * shd;
        // must mirror the GPU LUT's multiple-scattering term exactly
        var msPh = 0.72 + 0.28 * (pr * 4 * PI / 3);
        var iso = (sR + sM * 0.04) * (0.25 / PI) * Math.pow(Math.max(tl, 1e-5), 0.44) * shdM * msPh;
        var st = Math.exp(-ext * dt);
        L[c] += T[c] * ((inS + iso * 0.92) * (1 - st) / ext);
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
    updateEnv(1e9);
    return S;
  };

  function allocForQuality() {
    quality = (SAIL.quality === 'low') ? 'low' : 'high';
    if (quality === 'low') {
      CLOUD_BANDS = 6;
      S.cloudScale = 0.36;
      buildSkyLUT(192, 96, 24);
      buildCloudLUT(384, 192, 48, 30);
      buildScreenCloud(64, 44);
    } else {
      CLOUD_BANDS = 8;
      S.cloudScale = 0.48;
      buildSkyLUT(384, 192, 34);
      buildCloudLUT(768, 384, 88, 46);
      buildScreenCloud(116, 70);
    }
    if (domeMat) { for (var k in U) domeMat.uniforms[k] = U[k]; domeMat.needsUpdate = true; }
    skyDirty = true; envDirty = true;
  }

  S.rebuild = function () {
    if (!built) return;
    var want = (SAIL.quality === 'low') ? 'low' : 'high';
    if (want === quality) { skyDirty = true; envDirty = true; return; }
    allocForQuality();
    renderCloudBand(true);
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
    cu.uCover.value.set(0.05 + 0.85 * cs, 0.07);      // x = coverage, y = land bias
    cu.uAmb.value = 1.0;
    renderCloudBand(false);
    renderScreenCloud();

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
    var odR = pd(8000), odM = pd(1200) + 6.5 * pd(450);
    var bm = U.uSkyBetaMe.value;
    return [Math.exp(-(BETA_R[0] * 1e-3 * odR + bm * odM)),
            Math.exp(-(BETA_R[1] * 1e-3 * odR + bm * odM)),
            Math.exp(-(BETA_R[2] * 1e-3 * odR + bm * odM))];
  };
  S.skyRadianceAt = function (dx, dy, dz) {
    var o = [0, 0, 0]; var l = Math.hypot(dx, dy, dz) || 1;
    return cpuSky(dx / l, dy / l, dz / l, o);
  };

  S.dispose = function () {
    [rtTrans, rtSky, rtCloud, rtNoise, envRT, rtScr[0], rtScr[1]].forEach(function (r) { if (r) r.dispose(); });
    [matTrans, matSky, matCloud, matNoise, matScr, domeMat].forEach(function (m) { if (m) m.dispose(); });
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
