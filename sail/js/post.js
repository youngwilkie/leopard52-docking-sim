/* ==========================================================================
   post.js — SAIL.post : HDR post-processing chain, three.js r160 CORE ONLY.
   --------------------------------------------------------------------------
   No EffectComposer, no examples/ addons. Own render targets, own fullscreen
   triangle, own passes.

     F2   opaque scene           -> rtHDR             (RGBA16F + DepthTexture)
     F2b  SSAO + depth blur      -> rtAO1   (half res, opaque depth only)
     F3   MRT copy + linearise   -> rtMRT[0]=rtScene, rtMRT[1]=rtLinD
     F4   water / transparent    -> rtHDR   (autoClear off)
     F4b  SSR + depth blur       -> rtSSR1  (half res, post-water depth)
     F5   auto-exposure chain    rtHDR->L64->L16->L4->L1 -> adapt (1x1 ping-pong)
     F6   bright pass, 13-tap Karis downsample + soft knee + lens-veil -> mip0
     F7   mip chain downsample   mip0 -> mip1 .. mipN-1  (13-tap COD kernel)
     F8   mip chain upsample     mipN-1 -> .. -> mip0    (3x3 tent, ADDITIVE)
     F9   god rays               rtHDR(+depth) -> rtGR0 -> rtGR1 -> rtGR0
     F10  composite (CA, far-field DoF, SSR add, exposure, LOCAL tone map,
          AO, wide bloom + lens dirt, veiling glare, god rays, highlight
          bleach, AgX-space filmic sigmoid, vignette, sRGB OETF, luma into
          alpha) -> rtLDR
     F11  FXAA (luma from alpha) + film grain + triangular dither -> canvas

   ------------------------------------------- what a light has to actually do
   Two things separate a render from a photograph more reliably than anything
   else, and both are about light INTERACTING with its surroundings:

     1. Bright things reflect. A lit hull on a calm anchorage lays a mirror
        column on the water — Fresnel reflectance runs to ~100% at grazing —
        and an environment probe structurally cannot supply it, because the
        hull is local geometry that no probe contains. F4b marches the depth
        buffer for exactly that term and ADDS it to whatever the probe already
        gave the surface, Fresnel-weighted and broken up by the wave normals
        the depth buffer already carries.

     2. Shadowed things are not a constant. Ambient without an occlusion term
        is a flat added value, and a flat added value is why an unlit cockpit
        reads as painted. F2b is Alchemy obscurance off the opaque depth, and
        it is weighted toward the dim end of the frame so it darkens the
        inboard corners a bounce term would never reach without touching the
        sunlit topsides.

   ---------------------------------------------------------------- tone map
   The old ACES "fitted" curve was the wrong tool here: it asymptotes toward
   1.0 and therefore NEVER clips, and its toe collapses ~2.5 stops below
   middle grey straight into 0,0,0. Result: a mid-grey box with dead blacks.

   The AgX inset alone is ALSO not enough. A per-channel curve clips per
   channel: feed it a 3-stop-over sunset sail and R pins flat at 255 while G
   and B keep modulating, which locks the hue to a saturated orange and
   destroys every trace of shading — the "plastic decal" failure. Film does
   the opposite: as exposure climbs the channels converge, so the sail
   bleaches toward pale yellow-white. bleachHighlights() below is that
   convergence, applied in linear HDR before the inset.

   The other half of the same problem is midtone contrast. This module used to
   print 0.32 code value per stop through middle grey — nearly twice a
   straight sRGB gamma. At that gain a scene can only have crushed shadows and
   clipped highlights with nothing in between, which is precisely how a night
   frame ends up 66% black with the boat at 254. It now prints ~0.22/stop and
   carries a local operator (see localTM) for the cases a global curve cannot
   serve at all.

   This build uses a parametric filmic sigmoid evaluated in the AgX inset
   space (per-channel, so bright saturated sources desaturate toward paper
   white the way film and a Bayer sensor do), with:

     * a FINITE white point — tmMaxEV is ~3.8 stops over middle grey, which
       is exactly the headroom an sRGB display image has. Anything brighter
       clips to 255. Sun disks, glitter cores and sunlit cumulus crowns are
       SUPPOSED to clip; if a daylight frame has 0% clipped pixels the
       exposure is wrong.
     * a long asymptotic toe — the shadow domain runs 7.5 stops under middle
       grey and approaches black hyperbolically instead of hitting it, so a
       -6 EV shadow still lands on luminance 3-6 rather than on zero.

   ------------------------------------------------------------ veiling glare
   Real glass scatters ~1-2% of ALL incident light over the whole frame. That
   is what keeps photographic shadows off the floor, and it is CHROMATIC — it
   carries the colour of whatever is bright in frame, so shadows go warm at
   golden hour and blue at night for free. The bright pass therefore lets a
   small fraction of every pixel into the bloom chain (uVeil), and the
   composite adds the deepest, widest mip back as a flat glare term.

   HDR unit contract: shaders emit linear radiance with E_sun = 100. Every tap
   this module makes of a scene buffer is sanitised (NaN/Inf -> 0, clamp 12000)
   so one bad pixel cannot poison the bloom chain.

   Everything degrades when SAIL.quality === 'low': renderScale 0.85, fewer
   bloom mips, no god rays, no DoF, console-variant FXAA.
   ========================================================================== */
(function () {
  'use strict';

  const SAIL = (window.SAIL = window.SAIL || {});
  const P = {};
  SAIL.post = P;

  const T = window.THREE;

  /* ------------------------------------------------------------ public API */

  P.ready = false;          // build() succeeded
  P.enabled = true;         // false => plain forward render (no float buffers)
  P.rtVersion = 0;          // bumped on every reallocation; watch it to rebind
  P.layers = { opaque: 0, water: 1 };   // put the ocean mesh on layer 1
  P.resolution = T ? new T.Vector2(1280, 800) : { x: 1280, y: 800 };
  P.texel = T ? new T.Vector2(1 / 1280, 1 / 800) : { x: 0, y: 0 };
  P.displaySize = T ? new T.Vector2(1280, 800) : { x: 1280, y: 800 };

  P.sceneTexture = null;        // colour copy of the opaque pass (linear HDR)
  P.linearDepthTexture = null;  // view-space depth in METRES, .r channel
  P.depthTexture = null;        // raw hardware depth of rtHDR
  P.onResize = [];              // array of callbacks fn(width, height)

  P.settings = {
    renderScaleHigh: 1.25,
    renderScaleLow: 0.85,

    /* ---- exposure ------------------------------------------------------
       exposure = evBias * key / (Lavg^p * Lref^(1-p))
       p < 1 is INCOMPLETE adaptation: a night scene is metered, but not all
       the way back to middle grey, so night still reads as night. */
    exposure: 0.030,        // manual fallback (overridden by SAIL.env.exposure)
    evBias: 1.0,
    autoExposure: true,
    keyValue: 0.18,
    /* Incomplete adaptation. 0.55 rather than 0.60 because a 22:00 anchorage
       metered any harder simply comes back as a grey day: the local operator
       below is what recovers the shadow detail now, not the meter. */
    adaptExponent: 0.55,
    adaptRef: 8.0,
    exposureMin: 0.0015,
    exposureMax: 3.0,
    adaptTauUp: 1.2,        // brightening time constant, seconds
    adaptTauDown: 3.0,      // darkening

    /* ---- bloom : mip chain --------------------------------------------- */
    bloomHigh: 0.115,       // intensity of the accumulated mip0
    bloomLow: 0.085,
    bloomLevelsHigh: 6,     // 6 levels @ 1600px wide => ~80 px halation tail
    bloomLevelsLow: 5,
    bloomThreshold: 0.95,   // EXPOSED linear, i.e. just under display white
    bloomKnee: 0.60,
    bloomCascade: 0.84,     // per-level upsample gain (tail decay rate)
    bloomRadius: 1.15,      // tent-filter radius in source texels

    veil: 0.016,            // fraction of ALL light entering the bloom chain
    glare: 0.055,           // wide low-frequency glare from the deepest mip
    flatGlare: 0.40,        // uniform whole-frame scatter — sets the black floor
    glareSat: 0.55,         // veil chroma: 0 = neutral, 1 = full key colour
    lensDirt: 0.42,         // extra veiling on the bloom where the glass is dirty

    /* ---- tone curve (log2 domain, AgX inset space) ----------------------
       tmSlope is the RAW slope; the curve is renormalised to [0,1] across
       [tmMinEV, tmMaxEV] afterwards, so the contrast that actually prints is
       tmSlope * uTmC.y. P.curveReport() prints it. Target ~0.21 code-value
       per stop through middle grey: that is a touch punchier than a straight
       sRGB gamma (0.18/stop) which is what a film print does, and it is
       roughly 0.10 FLATTER than this module used to be. The old 0.32/stop was
       the direct cause of the two-tone night frame — with that much midtone
       gain a scene only ever has crushed shadows and clipped highlights and
       nothing at all in between. */
    tmMinEV: -12.60,        // black point, absolute log2 of exposed radiance
    tmMaxEV: -0.24,         // white point => 2.23 stops over middle grey, the
                            // classic highlight headroom of a slide film or a
                            // JPEG. Anything past it is paper white, on
                            // purpose: at 0.93 exposed the specular facets on
                            // the sun path and the sunlit crowns of the
                            // cumulus DO clip, and the bloom chain then has
                            // something to bleed off. A frame with 0.000%
                            // clipped pixels has no light source in it.
    tmPivot: -2.4739,       // log2(0.18)
    tmSlope: 0.1090,        // contrast through the pivot, per stop (raw)
    tmToe: 1.22,            // toe hardness (higher = shorter toe)
    tmShoulder: 1.42,
    tmGrey: 0.2600,         // encoded output at the pivot
    tmSat: 1.10,            // AgX desaturates; put the tropics back

    /* ---- highlight bleach ----------------------------------------------
       Per-channel curves clip per-channel: a saturated over-range source pins
       its strongest primary and keeps modulating the other two, which skews
       the hue hard toward that primary and freezes all shading (the "plastic
       orange sail"). Film and a Bayer sensor do the opposite — as exposure
       climbs the channels CONVERGE, so an overexposed sunset sail bleaches
       toward pale yellow-white. This term drags chroma toward the per-pixel
       max as a function of that max, in linear HDR, before the curve. */
    bleachStart: 0.80,      // exposed linear where convergence begins
    bleachRange: 2.40,      // stops-ish of range over which it completes
    bleachAmount: 0.88,

    /* ---- local tone mapping --------------------------------------------
       Global curves cannot serve a 22:00 anchorage: a lit hull 8 stops over
       the water forces you to choose between clipping the hull and crushing
       everything else. Every camera made since 2015 solves this with a
       local operator; so does this one. The 64x64 log-luminance field the
       auto-exposure chain already builds is the low-pass, and the exposure is
       nudged per region toward the frame mean. Asymmetric: shadows get most
       of the lift, highlights only a gentle pull-down, so the frame keeps a
       real clipping point. */
    localTM: true,
    localShadow: 0.24,      // fraction of the local underexposure recovered
    localHighlight: 0.18,   // fraction of the local overexposure pulled back
    localClamp: 1.15,       // hard limit, natural log units (~1.66 stops)

    /* ---- SSAO -----------------------------------------------------------
       Ambient with no occlusion term is a flat added constant, and a flat
       added constant is why an unlit cockpit reads as painted rather than
       enclosed. Alchemy-style obscurance off the depth buffer, evaluated on
       the OPAQUE pass only (before the water is drawn) so waves never feed
       it, applied weighted toward the shadowed end of the frame. */
    ssao: true,
    ssaoRadius: 1.55,       // metres
    ssaoIntensity: 1.85,
    ssaoPower: 1.45,
    ssaoBias: 0.40,
    ssaoAmount: 0.95,       // composite strength
    ssaoMaxUV: 0.055,       // screen-space radius cap

    /* ---- SSR ------------------------------------------------------------
       An environment probe cannot reflect the boat's own deck lights, the
       shore windows, or a floodlit hull, so at night the water under a
       brilliantly lit vessel comes out statistically identical to open sea
       400 px away. Screen-space marching supplies exactly the term the probe
       is missing — LOCAL geometry — and it is added, never substituted, so
       the existing probe reflection stays intact. Fresnel-weighted, so it
       only really fires at the grazing angles where water is a mirror. */
    ssr: true,
    ssrStrength: 0.75,
    ssrJitter: 0.070,       // wave-driven horizontal break-up of the column
    ssrThickness: 1.20,
    ssrMaxDist: 420.0,
    ssrBlur: 1.9,           // depth-aware blur spread on the reflection buffer
    ssrEmitGate: 1.30,      // keep only hits brighter than surface * this

    chroma: 0.0016,
    vignette: 0.30,
    grain: 0.018,
    dither: 1.0,

    godrays: true,
    godrayStrength: 0.34,
    godrayDecay: 0.962,
    godrayDensity: 0.85,

    dof: true,
    dofStart: 110.0,        // metres — nothing nearer is ever blurred
    dofRange: 500.0,
    dofMaxRadius: 2.6,      // pixels at the internal resolution

    fxaa: true,
    refractionPass: true,   // F3 MRT copy (the ocean needs it)
    manageCanvasStyle: true
  };

  P.stats = { passes: 0, internalW: 0, internalH: 0, scale: 1, bloomLevels: 0 };

  /* ------------------------------------------------------------- internals */

  let renderer = null, scene = null, camera = null;
  let gl = null, isWebGL2 = false, hdrOK = false;
  let built = false;

  let rtHDR = null, rtMRT = null, rtLDR = null;
  let bloomMips = [];
  let rtFlat = null;
  let rtL64 = null, rtL16 = null, rtL4 = null, rtL1 = null;
  let rtAdaptA = null, rtAdaptB = null, adaptFlip = false;
  let rtGR0 = null, rtGR1 = null;
  let rtAO0 = null, rtAO1 = null, rtSSR0 = null, rtSSR1 = null;

  let quadScene = null, quadMesh = null, quadCam = null;
  let mFill, mMRT, mBright, mDown13, mUpTent, mAvg36, mLumFirst, mLumDown, mAdapt;
  let mGRPre, mGRBlur, mComposite, mFxaaHigh, mFxaaLow, mNoAA;
  let mSSAO, mSSR, mBlurD;
  let dirtTexture = null;
  let blackTex = null, whiteTex = null;

  let renderScale = 1.25;
  let bloomLevels = 6;
  let lastQuality = null;
  let frameSeed = 0;
  let elapsed = 0;

  const _sunWorld = T ? new T.Vector3() : null;
  const _sunNDC = T ? new T.Vector3() : null;
  const _camDir = T ? new T.Vector3() : null;
  const _camPos = T ? new T.Vector3() : null;
  const _sunColor = T ? new T.Color(1, 1, 1) : null;
  const _upView = T ? new T.Vector3() : null;

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  /* ============================================================== SHADERS */

  const VS = [
    'varying vec2 vUv;',
    'void main(){',
    '  vUv = position.xy * 0.5 + 0.5;',
    '  gl_Position = vec4(position.xy, 0.0, 1.0);',
    '}'
  ].join('\n');

  const SANITIZE = [
    'vec3 sane(vec3 c){',
    '  float l = dot(c, vec3(0.3333333));',
    '  if(!(l < 1.0e5)) c = vec3(0.0);',
    '  return min(max(c, vec3(0.0)), vec3(12000.0));',
    '}'
  ].join('\n');

  const LINDEPTH = [
    'uniform vec2 uCamNF;',
    'float linZ(float d){',
    '  float n = uCamNF.x, f = uCamNF.y;',
    '  float zn = d * 2.0 - 1.0;',
    '  return (2.0 * n * f) / max(f + n - zn * (f - n), 1.0e-6);',
    '}'
  ].join('\n');

  const HASH = [
    'float hash12(vec2 p){',
    '  vec3 p3 = fract(vec3(p.xyx) * 0.1031);',
    '  p3 += dot(p3, p3.yzx + 33.33);',
    '  return fract((p3.x + p3.y) * p3.z);',
    '}'
  ].join('\n');

  /* ---- view-space reconstruction from the hardware depth buffer.
     uProjScale = (tanHalfFov * aspect, tanHalfFov), lifted straight off the
     projection matrix so an off-centre or modified projection still works.
     View space is x right, y up, -z forward. ------------------------------ */
  const VIEWREC = [
    'uniform vec2 uProjScale;',
    'vec3 viewPosAt(vec2 uv, float z){',
    '  return vec3((uv * 2.0 - 1.0) * uProjScale * z, -z);',
    '}',
    'vec2 viewToUV(vec3 p){',
    '  vec2 q = (p.xy / max(-p.z, 1.0e-4)) / uProjScale;',
    '  return q * 0.5 + 0.5;',
    '}'
  ].join('\n');

  /* Depth-derived view normal. Picks the CLOSER neighbour on each axis so a
     silhouette edge does not tilt the plane into the background. */
  const DEPTHNORMAL = [
    'vec3 depthNormal(vec2 uv, float z0, vec3 p0, vec2 t){',
    '  float zl = dz(uv - vec2(t.x, 0.0));',
    '  float zr = dz(uv + vec2(t.x, 0.0));',
    '  float zd = dz(uv - vec2(0.0, t.y));',
    '  float zu = dz(uv + vec2(0.0, t.y));',
    '  vec3 dx = (abs(zr - z0) < abs(z0 - zl))',
    '    ? (viewPosAt(uv + vec2(t.x, 0.0), zr) - p0)',
    '    : (p0 - viewPosAt(uv - vec2(t.x, 0.0), zl));',
    '  vec3 dy = (abs(zu - z0) < abs(z0 - zd))',
    '    ? (viewPosAt(uv + vec2(0.0, t.y), zu) - p0)',
    '    : (p0 - viewPosAt(uv - vec2(0.0, t.y), zd));',
    '  vec3 n = cross(dx, dy);',
    '  float nl = length(n);',
    '  return (nl > 1.0e-9) ? (n / nl) : vec3(0.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  /* ---- F2b : SSAO. Alchemy obscurance, 14 golden-angle taps, radius in
     METRES projected to screen so the falloff is world-correct. ---------- */
  const FS_SSAO = [
    'precision highp float;',
    'varying vec2 vUv;',
    'uniform sampler2D uDepth;',
    'uniform vec2 uTexel;',
    'uniform vec4 uAOCfg;',      // radius, intensity, power, bias
    'uniform float uMaxUV;',
    'uniform float uSeed;',
    LINDEPTH,
    VIEWREC,
    HASH,
    'float dz(vec2 uv){ return linZ(texture2D(uDepth, uv).r); }',
    DEPTHNORMAL,
    'void main(){',
    '  float ao = 1.0;',
    '  float z0 = dz(vUv);',
    '  float skyZ = uCamNF.y * 0.80;',
    '  if(z0 > 0.0 && z0 < skyZ){',
    '    vec3 p0 = viewPosAt(vUv, z0);',
    '    vec3 n = depthNormal(vUv, z0, p0, uTexel);',
    '    vec2 rad = vec2(0.5 * uAOCfg.x) / (uProjScale * max(z0, 0.05));',
    '    rad = min(rad, vec2(uMaxUV));',
    '    float ang = hash12(gl_FragCoord.xy + uSeed) * 6.2831853;',
    '    float occ = 0.0;',
    '    for(int i = 0; i < 14; i++){',
    '      float fi = (float(i) + 0.5) / 14.0;',
    '      float a = ang + float(i) * 2.39996323;',
    '      vec2 uvs = vUv + vec2(cos(a), sin(a)) * sqrt(fi) * rad;',
    '      float zs = dz(clamp(uvs, vec2(0.0), vec2(1.0)));',
    '      if(zs < skyZ){',
    '        vec3 v = viewPosAt(uvs, zs) - p0;',
    '        float vv = dot(v, v);',
    '        float vn = dot(v, n) - uAOCfg.w * z0 * 0.004;',
    '        occ += max(vn, 0.0) / (vv + 0.035);',
    '      }',
    '    }',
    '    occ *= (2.0 * uAOCfg.y * uAOCfg.x) / 14.0;',
    '    ao = pow(clamp(1.0 - occ, 0.0, 1.0), uAOCfg.z);',
    '  }',
    '  gl_FragColor = vec4(ao, ao, ao, 1.0);',
    '}'
  ].join('\n');

  /* ---- depth-aware 3x3 blur, shared by the AO and SSR buffers ---------- */
  const FS_BLURD = [
    'precision highp float;',
    'varying vec2 vUv;',
    'uniform sampler2D uTex;',
    'uniform sampler2D uDepth;',
    'uniform vec2 uTexel;',
    'uniform float uSpread;',
    LINDEPTH,
    'void main(){',
    '  float z0 = linZ(texture2D(uDepth, vUv).r);',
    '  vec4 sum = vec4(0.0);',
    '  float wsum = 0.0;',
    '  for(int y = -1; y <= 1; y++){',
    '    for(int x = -1; x <= 1; x++){',
    '      vec2 uv = vUv + vec2(float(x), float(y)) * uTexel * uSpread;',
    '      float zs = linZ(texture2D(uDepth, uv).r);',
    '      float w = exp(-abs(zs - z0) / max(0.05 * z0, 0.05));',
    '      sum += texture2D(uTex, uv) * w;',
    '      wsum += w;',
    '    }',
    '  }',
    '  gl_FragColor = sum / max(wsum, 1.0e-4);',
    '}'
  ].join('\n');

  /* ---- F4b : screen-space reflections of LOCAL emitters ----------------
     Additive only. The scene's own probe/env reflection is untouched; this
     supplies the term a probe structurally cannot — the lit hull, the deck
     lights, the shore windows — as a Fresnel-weighted mirror column with
     per-pixel normal jitter so it breaks up the way a real one does. */
  const FS_SSR = [
    'precision highp float;',
    'varying vec2 vUv;',
    'uniform sampler2D uColor;',
    'uniform sampler2D uDepth;',
    'uniform vec2 uTexel;',
    'uniform vec3 uUpView;',
    'uniform vec4 uSSRCfg;',     // strength, jitter, thickness, maxDist
    'uniform float uSeed;',
    'uniform float uEmit;',      // emitter contrast gate
    LINDEPTH,
    VIEWREC,
    HASH,
    SANITIZE,
    'float dz(vec2 uv){ return linZ(texture2D(uDepth, uv).r); }',
    DEPTHNORMAL,
    'void main(){',
    '  vec3 outc = vec3(0.0);',
    '  float skyZ = uCamNF.y * 0.65;',
    '  float z0 = dz(vUv);',
    '  if(z0 > 0.0 && z0 < skyZ){',
    '    vec3 p0 = viewPosAt(vUv, z0);',
    '    vec3 n = depthNormal(vUv, z0, p0, uTexel);',
    '    float upness = dot(n, uUpView);',
    '    if(upness > 0.30){',
    '      vec3 V = normalize(p0);',
    '      float ndv = max(-dot(V, n), 0.0);',
    '      float F = 0.028 + 0.972 * pow(1.0 - ndv, 5.0);',
    '      float h1 = hash12(gl_FragCoord.xy + uSeed) - 0.5;',
    '      float h2 = hash12(gl_FragCoord.yx * 1.371 + uSeed + 11.7) - 0.5;',
    '      vec3 tg = normalize(cross(n, vec3(0.0, 0.0, 1.0)) + vec3(1.0e-5, 0.0, 0.0));',
    '      vec3 bt = cross(n, tg);',
    // anisotropic: a ruffled surface tilts mostly across the line of sight,
    // so the column breaks up horizontally and smears vertically
    '      vec3 nn = normalize(n + (tg * h1 + bt * (h2 * 0.55)) * uSSRCfg.y);',
    '      vec3 rd = reflect(V, nn);',
    '      if(F > 0.012 && rd.z < 0.30){',
    '        vec3 pos = p0 + nn * max(0.04, z0 * 0.004);',
    '        float st = max(0.30, z0 * 0.018);',
    '        float travelled = 0.0;',
    '        vec3 hitCol = vec3(0.0);',
    '        float hitW = 0.0;',
    '        for(int i = 0; i < 26; i++){',
    '          vec3 prev = pos;',
    '          pos += rd * st;',
    '          travelled += st;',
    '          if(travelled > uSSRCfg.w) break;',
    '          if(-pos.z <= uCamNF.x) break;',
    '          vec2 uvh = viewToUV(pos);',
    '          if(uvh.x < 0.0 || uvh.x > 1.0 || uvh.y < 0.0 || uvh.y > 1.0) break;',
    '          float zs = dz(uvh);',
    '          float diff = (-pos.z) - zs;',
    '          if(diff > 0.0 && diff < uSSRCfg.z + st * 1.35 && zs < skyZ){',
    '            vec3 a = prev, b = pos;',
    '            for(int k = 0; k < 5; k++){',
    '              vec3 m = (a + b) * 0.5;',
    '              if((-m.z) > dz(viewToUV(m))) b = m; else a = m;',
    '            }',
    '            vec2 fuv = clamp(viewToUV((a + b) * 0.5), vec2(0.0), vec2(1.0));',
    '            hitCol = sane(texture2D(uColor, fuv).rgb);',
    /* Emitter gate. The term a probe is missing is a LOCAL SOURCE — a lit
       hull, a deck light, a window — not the next wave crest along, which
       the probe and the water shader already account for and which would
       double-count into a milky haze on open sea. Keep only the part of the
       hit that is genuinely brighter than the surface receiving it. */
    '            float lh = dot(hitCol, vec3(0.2126, 0.7152, 0.0722));',
    '            float ls = dot(sane(texture2D(uColor, vUv).rgb), vec3(0.2126, 0.7152, 0.0722));',
    '            hitCol *= clamp((lh - ls * uEmit) / max(lh, 1.0e-4), 0.0, 1.0);',
    '            vec2 e = abs(fuv - 0.5) * 2.0;',
    '            hitW = 1.0 - smoothstep(0.78, 1.0, max(e.x, e.y));',
    '            hitW *= 1.0 - smoothstep(uSSRCfg.w * 0.5, uSSRCfg.w, travelled);',
    '            break;',
    '          }',
    '          st *= 1.235;',
    '        }',
    '        outc = hitCol * hitW * F * uSSRCfg.x',
    '             * smoothstep(0.30, 0.55, upness)',
    '             * (1.0 - smoothstep(0.0, 0.30, rd.z));',
    '      }',
    '    }',
    '  }',
    '  gl_FragColor = vec4(min(max(outc, vec3(0.0)), vec3(4000.0)), 1.0);',
    '}'
  ].join('\n');

  // ---- F3 : MRT copy + depth linearisation (GLSL3, two colour outputs) ----
  const FS_MRT = [
    'precision highp float;',
    'varying vec2 vUv;',
    'uniform sampler2D uColor;',
    'uniform sampler2D uDepth;',
    LINDEPTH,
    SANITIZE,
    'layout(location = 0) out vec4 oColor;',
    'layout(location = 1) out vec4 oDepth;',
    'void main(){',
    '  vec3 c = sane(texture2D(uColor, vUv).rgb);',
    '  float zv = linZ(texture2D(uDepth, vUv).r);',
    '  oColor = vec4(c, 1.0);',
    '  oDepth = vec4(zv, zv, zv, 1.0);',
    '}'
  ].join('\n');

  const FS_FILL = [
    'precision highp float;',
    'varying vec2 vUv;',
    'uniform vec4 uFill;',
    'void main(){ gl_FragColor = uFill; }'
  ].join('\n');

  /* ---- exposure resolution, shared by bright pass and composite ----------
     Incomplete adaptation: dividing by Lavg^p * Lref^(1-p) rather than by
     Lavg means a dark scene is only partly compensated, so the night frame
     stays a stop or two below the day frame instead of being lifted into a
     flat grey. */
  const EXPOSURE = [
    'uniform sampler2D uAdapt;',
    'uniform float uExposure;',
    'uniform float uAutoMix;',
    'uniform float uEVBias;',
    'uniform vec4 uAdaptCfg;',   // key, exponent, ref, unused
    'uniform vec2 uExpClamp;',
    'float resolveAdapt(){',
    '  float ad = texture2D(uAdapt, vec2(0.5)).r;',
    '  if(!(ad < 1.0e5)) ad = 0.18;',
    '  return clamp(ad, 1.0e-5, 5.0e3);',
    '}',
    'float resolveExposure(){',
    '  if(uAutoMix < 0.5) return uExposure;',
    '  float ad = resolveAdapt();',
    '  float p = uAdaptCfg.y;',
    '  float den = pow(ad, p) * pow(max(uAdaptCfg.z, 1.0e-3), 1.0 - p);',
    '  return clamp(uEVBias * uAdaptCfg.x / max(den, 1.0e-6), uExpClamp.x, uExpClamp.y);',
    '}'
  ].join('\n');

  /* ---- F6 : bright pass. 13-tap COD downsample with per-box Karis
     averaging (kills fireflies), then a soft-knee threshold in EXPOSED
     linear units, plus the uniform lens veil. ----------------------------- */
  const FS_BRIGHT = [
    'precision highp float;',
    'varying vec2 vUv;',
    'uniform sampler2D uHDR;',
    'uniform vec2 uSrcTexel;',
    'uniform float uThreshold;',
    'uniform float uKnee;',
    'uniform float uVeil;',
    'uniform sampler2D uSSR;',
    'uniform float uSSRAmt;',
    SANITIZE,
    EXPOSURE,
    'vec3 tap(vec2 uv){ return sane(texture2D(uHDR, uv).rgb); }',
    'float lum(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }',
    'vec3 karis(vec3 a, vec3 b, vec3 c, vec3 d){',
    '  vec3 s = (a + b + c + d) * 0.25;',
    '  float wa = 1.0 / (1.0 + lum(a));',
    '  float wb = 1.0 / (1.0 + lum(b));',
    '  float wc = 1.0 / (1.0 + lum(c));',
    '  float wd = 1.0 / (1.0 + lum(d));',
    '  vec3 k = (a * wa + b * wb + c * wc + d * wd) / max(wa + wb + wc + wd, 1.0e-5);',
    '  return mix(s, k, 0.85);',
    '}',
    'void main(){',
    '  vec2 t = uSrcTexel;',
    '  vec3 a = tap(vUv + t * vec2(-2.0,  2.0));',
    '  vec3 b = tap(vUv + t * vec2( 0.0,  2.0));',
    '  vec3 c = tap(vUv + t * vec2( 2.0,  2.0));',
    '  vec3 d = tap(vUv + t * vec2(-2.0,  0.0));',
    '  vec3 e = tap(vUv);',
    '  vec3 f = tap(vUv + t * vec2( 2.0,  0.0));',
    '  vec3 g = tap(vUv + t * vec2(-2.0, -2.0));',
    '  vec3 h = tap(vUv + t * vec2( 0.0, -2.0));',
    '  vec3 i = tap(vUv + t * vec2( 2.0, -2.0));',
    '  vec3 j = tap(vUv + t * vec2(-1.0,  1.0));',
    '  vec3 k = tap(vUv + t * vec2( 1.0,  1.0));',
    '  vec3 l = tap(vUv + t * vec2(-1.0, -1.0));',
    '  vec3 m = tap(vUv + t * vec2( 1.0, -1.0));',
    '  vec3 col = karis(j, k, l, m) * 0.5;',
    '  col += karis(a, b, d, e) * 0.125;',
    '  col += karis(b, c, e, f) * 0.125;',
    '  col += karis(d, e, g, h) * 0.125;',
    '  col += karis(e, f, h, i) * 0.125;',
    '  if(uSSRAmt > 0.0) col += sane(texture2D(uSSR, vUv).rgb) * uSSRAmt;',
    '  col *= resolveExposure();',
    '  float br = max(col.r, max(col.g, col.b));',
    '  float K = max(uKnee, 1.0e-4);',
    '  vec3 curve = vec3(uThreshold - K, 2.0 * K, 0.25 / K);',
    '  float rq = clamp(br - curve.x, 0.0, curve.y);',
    '  rq = curve.z * rq * rq;',
    '  float w = max(rq, br - uThreshold) / max(br, 1.0e-4);',
    // the veil: every photon that reaches the glass scatters a little
    '  gl_FragColor = vec4(min(col * (w + uVeil), vec3(12000.0)), 1.0);',
    '}'
  ].join('\n');

  // ---- F7 : 13-tap COD downsample (no threshold, no Karis) ----------------
  const FS_DOWN13 = [
    'precision highp float;',
    'varying vec2 vUv;',
    'uniform sampler2D uTex;',
    'uniform vec2 uSrcTexel;',
    'vec3 tap(vec2 uv){ return texture2D(uTex, uv).rgb; }',
    'void main(){',
    '  vec2 t = uSrcTexel;',
    '  vec3 a = tap(vUv + t * vec2(-2.0,  2.0));',
    '  vec3 b = tap(vUv + t * vec2( 0.0,  2.0));',
    '  vec3 c = tap(vUv + t * vec2( 2.0,  2.0));',
    '  vec3 d = tap(vUv + t * vec2(-2.0,  0.0));',
    '  vec3 e = tap(vUv);',
    '  vec3 f = tap(vUv + t * vec2( 2.0,  0.0));',
    '  vec3 g = tap(vUv + t * vec2(-2.0, -2.0));',
    '  vec3 h = tap(vUv + t * vec2( 0.0, -2.0));',
    '  vec3 i = tap(vUv + t * vec2( 2.0, -2.0));',
    '  vec3 j = tap(vUv + t * vec2(-1.0,  1.0));',
    '  vec3 k = tap(vUv + t * vec2( 1.0,  1.0));',
    '  vec3 l = tap(vUv + t * vec2(-1.0, -1.0));',
    '  vec3 m = tap(vUv + t * vec2( 1.0, -1.0));',
    '  vec3 col = e * 0.125;',
    '  col += (a + c + g + i) * 0.03125;',
    '  col += (b + d + f + h) * 0.0625;',
    '  col += (j + k + l + m) * 0.125;',
    '  float lz = dot(col, vec3(0.3333333));',
    '  if(!(lz < 1.0e5)) col = vec3(0.0);',
    '  gl_FragColor = vec4(min(max(col, vec3(0.0)), vec3(12000.0)), 1.0);',
    '}'
  ].join('\n');

  // ---- F8 : 3x3 tent upsample, ADDITIVE into the finer mip ---------------
  const FS_UPTENT = [
    'precision highp float;',
    'varying vec2 vUv;',
    'uniform sampler2D uTex;',
    'uniform vec2 uSrcTexel;',
    'uniform float uRadius;',
    'uniform float uScale;',
    'vec3 tap(vec2 uv){ return texture2D(uTex, uv).rgb; }',
    'void main(){',
    '  vec2 o = uSrcTexel * uRadius;',
    '  vec3 s = tap(vUv + vec2(-o.x,  o.y));',
    '  s += tap(vUv + vec2( 0.0,  o.y)) * 2.0;',
    '  s += tap(vUv + vec2( o.x,  o.y));',
    '  s += tap(vUv + vec2(-o.x,  0.0)) * 2.0;',
    '  s += tap(vUv) * 4.0;',
    '  s += tap(vUv + vec2( o.x,  0.0)) * 2.0;',
    '  s += tap(vUv + vec2(-o.x, -o.y));',
    '  s += tap(vUv + vec2( 0.0, -o.y)) * 2.0;',
    '  s += tap(vUv + vec2( o.x, -o.y));',
    '  s *= 0.0625 * uScale;',
    '  float lz = dot(s, vec3(0.3333333));',
    '  if(!(lz < 1.0e5)) s = vec3(0.0);',
    '  gl_FragColor = vec4(min(max(s, vec3(0.0)), vec3(12000.0)), 1.0);',
    '}'
  ].join('\n');

  /* ---- whole-frame average of the bright pass, 36 taps into a 1x1 target.
     Lens flare is not just a halo: some fraction of every photon that enters
     the barrel ends up scattered UNIFORMLY across the frame. That flat term
     is what stops a real photograph's shadows from ever reaching 0,0,0, and
     because it is the average of the frame's own bright content it arrives
     already tinted — warm at golden hour, blue-cyan at night. ------------ */
  const FS_AVG36 = [
    'precision highp float;',
    'varying vec2 vUv;',
    'uniform sampler2D uTex;',
    'void main(){',
    '  vec3 s = vec3(0.0);',
    '  for(int y = 0; y < 6; y++){',
    '    for(int x = 0; x < 6; x++){',
    '      vec2 uv = (vec2(float(x), float(y)) + 0.5) / 6.0;',
    '      s += texture2D(uTex, uv).rgb;',
    '    }',
    '  }',
    '  s *= 1.0 / 36.0;',
    '  float lz = dot(s, vec3(0.3333333));',
    '  if(!(lz < 1.0e5)) s = vec3(0.0);',
    '  gl_FragColor = vec4(min(max(s, vec3(0.0)), vec3(4000.0)), 1.0);',
    '}'
  ].join('\n');

  // ---- F5 : luminance chain ----------------------------------------------
  const FS_LUM_FIRST = [
    'precision highp float;',
    'varying vec2 vUv;',
    'uniform sampler2D uTex;',
    'uniform vec2 uSrcTexel;',
    SANITIZE,
    'float lg(vec2 uv){',
    '  vec3 c = sane(texture2D(uTex, uv).rgb);',
    '  return log(dot(c, vec3(0.2126, 0.7152, 0.0722)) + 1.0e-4);',
    '}',
    'void main(){',
    '  vec2 o = uSrcTexel;',
    '  float s = lg(vUv);',
    '  s += lg(vUv + vec2( o.x, 0.0));',
    '  s += lg(vUv + vec2(-o.x, 0.0));',
    '  s += lg(vUv + vec2(0.0,  o.y));',
    '  s += lg(vUv + vec2(0.0, -o.y));',
    '  s += lg(vUv + o);',
    '  s += lg(vUv - o);',
    '  s += lg(vUv + vec2( o.x, -o.y));',
    '  s += lg(vUv + vec2(-o.x,  o.y));',
    '  s *= 0.111111;',
    // centre weighting: sky fills the top of a marine frame and would
    // otherwise meter the deck into silhouette. Carry (sum*w, w) through the
    // chain and divide once at the end — a true weighted mean.
    '  vec2 q = vUv - 0.5;',
    '  float w = 0.55 + 0.45 * exp(-dot(q, q) * 3.2);',
    // .b keeps the UNWEIGHTED local log-luminance. The chain only ever
    // reduces .rg, so this 64x64 field survives as a low-pass of the frame
    // and is what the composite's local tone operator reads.
    '  gl_FragColor = vec4(s * w, w, s, 1.0);',
    '}'
  ].join('\n');

  const FS_LUM_DOWN = [
    'precision highp float;',
    'varying vec2 vUv;',
    'uniform sampler2D uTex;',
    'uniform vec2 uSrcTexel;',
    'void main(){',
    '  vec2 o = uSrcTexel * 0.5;',
    '  vec2 s = texture2D(uTex, vUv + vec2(-o.x, -o.y)).rg;',
    '  s += texture2D(uTex, vUv + vec2( o.x, -o.y)).rg;',
    '  s += texture2D(uTex, vUv + vec2(-o.x,  o.y)).rg;',
    '  s += texture2D(uTex, vUv + vec2( o.x,  o.y)).rg;',
    '  s *= 0.25;',
    '  gl_FragColor = vec4(s.x, s.y, 0.0, 1.0);',
    '}'
  ].join('\n');

  const FS_ADAPT = [
    'precision highp float;',
    'varying vec2 vUv;',
    'uniform sampler2D uLum;',
    'uniform sampler2D uPrev;',
    'uniform float uDt;',
    'uniform float uTauUp;',
    'uniform float uTauDown;',
    'void main(){',
    '  vec2 lw = texture2D(uLum, vec2(0.5)).rg;',
    '  float target = exp(lw.x / max(lw.y, 1.0e-4));',
    '  if(!(target < 1.0e5)) target = 0.18;',
    '  target = clamp(target, 1.0e-5, 5.0e3);',
    '  float prev = texture2D(uPrev, vec2(0.5)).r;',
    '  if(!(prev < 1.0e5) || prev <= 0.0) prev = target;',
    '  float tau = (target > prev) ? uTauUp : uTauDown;',
    /* A small swing (cloud over the sun) drifts on the full time constant.
       A huge one — walking below decks, or a preset jumping straight from
       noon to 22:00 — collapses it: the iris and the neural gain both move
       far faster over several stops than they do over a fraction of one.
       Without this a deterministic night preset renders a black frame. */
    '  float dist = abs(log2(max(target, 1.0e-5) / max(prev, 1.0e-5)));',
    '  tau /= (1.0 + 0.85 * dist * dist);',
    '  float k = 1.0 - exp(-max(uDt, 0.0) / max(tau, 0.02));',
    '  float a = mix(prev, target, clamp(k, 0.0, 1.0));',
    '  gl_FragColor = vec4(a, a, a, 1.0);',
    '}'
  ].join('\n');

  // ---- god rays : sky-masked bright prepass, then two radial blurs -------
  const FS_GR_PRE = [
    'precision highp float;',
    'varying vec2 vUv;',
    'uniform sampler2D uHDR;',
    'uniform sampler2D uDepth;',
    'uniform vec2 uSunUV;',
    'uniform float uAspect;',
    'uniform float uMask;',
    LINDEPTH,
    SANITIZE,
    'void main(){',
    '  float zv = linZ(texture2D(uDepth, vUv).r);',
    '  float sky = step(uCamNF.y * 0.90, zv);',
    '  vec3 c = sane(texture2D(uHDR, vUv).rgb);',
    '  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));',
    '  float b = max(l - 2.5, 0.0);',
    '  b = b / (1.0 + b * 0.03);',
    '  vec2 q = (vUv - uSunUV) * vec2(uAspect, 1.0);',
    '  float fall = exp(-dot(q, q) * 5.5);',
    '  vec3 hue = c / max(l, 1.0e-4);',
    '  gl_FragColor = vec4(hue * b * sky * fall * uMask, 1.0);',
    '}'
  ].join('\n');

  const FS_GR_BLUR = [
    'precision highp float;',
    'varying vec2 vUv;',
    'uniform sampler2D uTex;',
    'uniform vec2 uSunUV;',
    'uniform float uDensity;',
    'uniform float uStep;',
    'uniform float uDecay;',
    'void main(){',
    '  vec2 delta = (vUv - uSunUV) * uDensity * uStep;',
    '  vec2 uv = vUv;',
    '  vec3 acc = vec3(0.0);',
    '  float w = 1.0, tot = 0.0;',
    '  for(int i = 0; i < 12; i++){',
    '    float edge = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);',
    '    acc += texture2D(uTex, clamp(uv, vec2(0.0), vec2(1.0))).rgb * w * edge;',
    '    tot += w;',
    '    uv -= delta;',
    '    w *= uDecay;',
    '  }',
    '  gl_FragColor = vec4(acc / max(tot, 1.0e-4), 1.0);',
    '}'
  ].join('\n');

  /* ---- the tone curve ---------------------------------------------------
     A generalised-hyperbola sigmoid in the log2 radiance domain. Two
     branches meet at the pivot with matched slope; each approaches its
     asymptote (0 below, 1 above) as |x - pivot| grows, and the pair is then
     renormalised across [minEV, maxEV] so that maxEV lands EXACTLY on 1.0.
     That last step is what gives the image a real clipping point. */
  const TONECURVE = [
    'uniform vec4 uTmA;',   // minEV, maxEV, pivot, slope
    'uniform vec4 uTmB;',   // toePow, shoulderPow, greyOut, saturation
    'uniform vec2 uTmC;',   // f(minEV), 1/(f(maxEV)-f(minEV))
    'vec3 hyper(vec3 u, float p){',
    '  return u / pow(pow(u, vec3(p)) + 1.0, vec3(1.0 / p));',
    '}',
    'vec3 toneCurve(vec3 lg){',
    '  float yp = uTmB.z;',
    '  float ys = 1.0 - yp;',
    '  vec3 d = clamp(lg, vec3(uTmA.x), vec3(uTmA.y)) - vec3(uTmA.z);',
    '  vec3 us = max(d, vec3(0.0)) * (uTmA.w / ys);',
    '  vec3 ut = max(-d, vec3(0.0)) * (uTmA.w / yp);',
    '  vec3 v = vec3(yp) + ys * hyper(us, uTmB.y) - yp * hyper(ut, uTmB.x);',
    '  return clamp((v - uTmC.x) * uTmC.y, 0.0, 1.0);',
    '}',
    /* AgX inset / outset. Working per-channel INSIDE this space is what
       makes an over-range saturated source (a sun through cloud, a sodium
       lamp) bleach toward white instead of hard-clipping to a primary. */
    'const mat3 AGX_IN = mat3(',
    '  0.842479062253094, 0.0423282422610123, 0.0423756549057051,',
    '  0.0784335999999992, 0.878468636469772, 0.0784336000000000,',
    '  0.0792237451477643, 0.0791661274605434, 0.879142973793104);',
    'const mat3 AGX_OUT = mat3(',
    '   1.19687900512017, -0.0528968517574562, -0.0529716355144438,',
    '  -0.0980208811401368, 1.15190312990417, -0.0980434501171241,',
    '  -0.0990297440797205, -0.0989611768448433, 1.15107367264116);',
    /* Highlight bleach. Applied in linear HDR, BEFORE the inset, so it is the
       radiance that converges and not the encoded value: the three channels
       then reach the shoulder together and a 3-stop-over sunset sail prints
       as pale yellow-white with its shading intact instead of pinning R at
       255 while G and B keep modulating. */
    'uniform vec4 uBleach;',   // start, range, amount, unused
    'vec3 bleachHighlights(vec3 c){',
    '  if(uBleach.z <= 0.0) return c;',
    '  float m = max(c.r, max(c.g, c.b));',
    '  if(m <= uBleach.x) return c;',
    '  float t = clamp((m - uBleach.x) / max(uBleach.y, 1.0e-3), 0.0, 1.0);',
    '  t = t * t * (3.0 - 2.0 * t);',
    '  return mix(c, vec3(m), t * uBleach.z);',
    '}',
    'vec3 filmic(vec3 c){',
    '  c = AGX_IN * max(bleachHighlights(max(c, vec3(0.0))), vec3(0.0));',
    '  vec3 lg = log2(max(c, vec3(1.0e-10)));',
    '  vec3 v = toneCurve(lg);',
    '  float lu = dot(v, vec3(0.2126, 0.7152, 0.0722));',
    '  v = clamp(vec3(lu) + (v - vec3(lu)) * uTmB.w, 0.0, 1.0);',
    '  v = AGX_OUT * v;',
    '  return pow(max(v, vec3(0.0)), vec3(2.2));',   // display-linear
    '}'
  ].join('\n');

  // ---- F10 : composite ---------------------------------------------------
  const FS_COMPOSITE = [
    'precision highp float;',
    'varying vec2 vUv;',
    'uniform sampler2D uHDR;',
    'uniform sampler2D uBloom;',
    'uniform sampler2D uGlare;',
    'uniform sampler2D uFlat;',
    'uniform sampler2D uDirt;',
    'uniform sampler2D uGodray;',
    'uniform sampler2D uDepthTex;',
    'uniform vec2 uTexel;',
    'uniform float uAspect;',
    'uniform float uBloomAmt;',
    'uniform float uGlareAmt;',
    'uniform float uFlatAmt;',
    'uniform float uGlareSat;',
    'uniform float uChroma;',
    'uniform float uVignette;',
    'uniform float uDirtAmt;',
    'uniform float uGodrayAmt;',
    'uniform vec3 uGodrayTint;',
    'uniform float uDofMax;',
    'uniform float uDofStart;',
    'uniform float uDofRange;',
    'uniform sampler2D uAO;',
    'uniform sampler2D uSSR;',
    'uniform sampler2D uLocal;',
    'uniform float uAOAmt;',
    'uniform float uSSRAmt;',
    'uniform vec4 uLocalCfg;',   // shadowAmt, highlightAmt, clamp, enable
    SANITIZE,
    LINDEPTH,
    HASH,
    EXPOSURE,
    TONECURVE,
    'vec3 fetch(vec2 uv){ return sane(texture2D(uHDR, uv).rgb); }',
    'float depthAt(vec2 uv){ return linZ(texture2D(uDepthTex, uv).r); }',
    /* 5-tap widening of the 64x64 log-luminance field: bilinear alone on a
       25 px/texel grid facets visibly, this reads as a smooth gradient. */
    'float localLogLuma(vec2 uv){',
    '  vec2 o = vec2(0.0140625);',
    '  float s = texture2D(uLocal, uv).b * 4.0;',
    '  s += texture2D(uLocal, uv + vec2( o.x, 0.0)).b;',
    '  s += texture2D(uLocal, uv + vec2(-o.x, 0.0)).b;',
    '  s += texture2D(uLocal, uv + vec2(0.0,  o.y)).b;',
    '  s += texture2D(uLocal, uv + vec2(0.0, -o.y)).b;',
    '  return s * 0.125;',
    '}',
    '#define DOFTAP(ox, oy) { vec2 so = vec2((ox) * cr - (oy) * sr, (ox) * sr + (oy) * cr) * rad; vec2 su = uv + so; float zs = depthAt(su); float wt = step(z * 0.80, zs); acc += fetch(su) * wt; wsum += wt; }',
    'void main(){',
    '  vec2 uv = vUv;',
    '  vec2 d = uv - 0.5;',
    '  float r2 = dot(d, d) * 4.0;',
    '  float k = uChroma * pow(max(r2, 0.0), 1.1);',
    // (a) chromatic aberration : 3 taps
    '  vec3 cCentre = fetch(uv);',
    '  vec3 c = cCentre;',
    '  if(uChroma > 0.0){',
    // Two taps per fringed channel, then fall back toward the un-fringed pixel
    // wherever the fringe would diverge wildly. A single radial tap over the
    // sun-glitter field samples a *different* spark in R than in B, which paints
    // magenta/green confetti across the sea instead of a lens fringe.
    '    float rA = fetch(uv + d * k).r;',
    '    float rB = fetch(uv + d * (k * 0.5)).r;',
    '    float bA = fetch(uv - d * k).b;',
    '    float bB = fetch(uv - d * (k * 0.5)).b;',
    '    vec3 ca = vec3((rA + rB) * 0.5, cCentre.g, (bA + bB) * 0.5);',
    '    float dv = length(ca - cCentre) / (length(cCentre) + 1e-3);',
    '    c = mix(ca, cCentre, clamp(dv * 2.5, 0.0, 1.0));',
    '  }',
    // far-field depth of field : 6-tap rotated hexagon, background only
    '  if(uDofMax > 0.0){',
    '    float z = depthAt(uv);',
    '    float coc = clamp((z - uDofStart) / max(uDofRange, 1.0), 0.0, 1.0);',
    '    coc = coc * coc * (3.0 - 2.0 * coc);',
    '    if(coc > 0.02){',
    '      float ang = hash12(gl_FragCoord.xy) * 6.2831853;',
    '      float cr = cos(ang), sr = sin(ang);',
    '      vec2 rad = vec2(coc * uDofMax) * uTexel;',
    '      vec3 acc = cCentre; float wsum = 1.0;',
    '      DOFTAP( 1.0,      0.0)',
    '      DOFTAP( 0.5,      0.8660254)',
    '      DOFTAP(-0.5,      0.8660254)',
    '      DOFTAP(-1.0,      0.0)',
    '      DOFTAP(-0.5,     -0.8660254)',
    '      DOFTAP( 0.5,     -0.8660254)',
    '      c = mix(c, acc / max(wsum, 1.0), coc);',
    '    }',
    '  }',
    // (a2) screen-space reflection of local emitters, added to the probe term
    '  if(uSSRAmt > 0.0) c += sane(texture2D(uSSR, uv).rgb) * uSSRAmt;',
    // (b) exposure
    '  float ex = resolveExposure();',
    '  c *= ex;',
    /* (b2) local tone mapping. exp() of a clamped, asymmetric nudge toward
       the frame mean: a dark anchorage keeps its shadow detail and the lit
       hull stops shearing to flat white, so the histogram grows the midtones
       that connect the two. */
    '  if(uLocalCfg.w > 0.5){',
    '    float lgl = localLogLuma(uv);',
    '    float lgg = log(resolveAdapt());',
    '    float dlt = lgl - lgg;',
    '    float amt = (dlt < 0.0) ? uLocalCfg.x : uLocalCfg.y;',
    '    float lift = clamp(-amt * dlt, -uLocalCfg.z, uLocalCfg.z);',
    '    if(lift == lift) c *= exp(lift);',
    '  }',
    /* (b3) ambient occlusion. Weighted toward the dim end of the frame: a
       sunlit topside is direct-lit and barely occluded, an inboard corner
       under the bimini is lit by bounce alone and is where the term belongs. */
    '  if(uAOAmt > 0.0){',
    '    float ao = clamp(texture2D(uAO, uv).r, 0.0, 1.0);',
    '    float lc = dot(c, vec3(0.2126, 0.7152, 0.0722));',
    '    float shadow = 1.0 - smoothstep(0.20, 1.40, lc);',
    '    c *= mix(1.0, ao, uAOAmt * (0.28 + 0.72 * shadow));',
    '  }',
    // (c) wide mip-chain bloom (already exposure-scaled) + dirty-glass veiling
    '  vec3 bl = texture2D(uBloom, uv).rgb;',
    '  float lz = dot(bl, vec3(0.3333333));',
    '  if(!(lz < 1.0e5)) bl = vec3(0.0);',
    '  float dirt = texture2D(uDirt, uv).r;',
    '  c += bl * (uBloomAmt * (1.0 + uDirtAmt * dirt * 2.4));',
    // (d) veiling glare. Two components: a wide low-frequency halo from the
    //     coarsest mip (gives shadows a directional warm-to-cool gradient)
    //     and a genuinely flat whole-frame term (sets the black floor). Both
    //     inherit the frame's own chromaticity, so nothing lands neutral.
    '  vec3 gv = texture2D(uGlare, uv).rgb;',
    '  float lg2 = dot(gv, vec3(0.3333333));',
    '  if(!(lg2 < 1.0e5)) gv = vec3(0.0);',
    '  vec3 fv = texture2D(uFlat, vec2(0.5)).rgb;',
    '  float lf2 = dot(fv, vec3(0.3333333));',
    '  if(!(lf2 < 1.0e5)) fv = vec3(0.0);',
    '  vec3 veilC = gv * uGlareAmt + fv * uFlatAmt;',
    // Scatter inside the barrel is broadband and integrates the whole
    // hemisphere, so the veil is a desaturated relative of the frame's own
    // key colour — warm, but not a pure sodium wash.
    '  float vl = dot(veilC, vec3(0.2126, 0.7152, 0.0722));',
    '  c += mix(vec3(vl), veilC, uGlareSat);',
    // (e) god rays
    '  if(uGodrayAmt > 0.0){',
    '    vec3 gr = texture2D(uGodray, uv).rgb;',
    '    float gl2 = dot(gr, vec3(0.3333333));',
    '    if(!(gl2 < 1.0e5)) gr = vec3(0.0);',
    '    c += min(gr, vec3(4000.0)) * uGodrayTint * (uGodrayAmt * ex);',
    '  }',
    // (f) filmic -> display linear
    '  c = filmic(max(c, vec3(0.0)));',
    // (g) vignette, aspect-corrected
    '  vec2 q = d; q.x *= uAspect;',
    '  float rn = dot(q, q) / (0.25 * (uAspect * uAspect + 1.0));',
    '  c *= 1.0 - uVignette * pow(clamp(rn, 0.0, 1.0), 1.35);',
    // (h) sRGB OETF
    '  c = clamp(c, 0.0, 1.0);',
    '  c = mix(c * 12.92, 1.055 * pow(max(c, vec3(1.0e-6)), vec3(0.4166667)) - 0.055, step(vec3(0.0031308), c));',
    // (i) luma into alpha for FXAA
    '  gl_FragColor = vec4(c, dot(c, vec3(0.299, 0.587, 0.114)));',
    '}'
  ].join('\n');

  // ---- F11 : FXAA 3.11 (quality) + grain + dither ------------------------
  const GRAIN_TAIL = [
    '  float lum = dot(c, vec3(0.299, 0.587, 0.114));',
    '  if(uGrain > 0.0){',
    '    float g = hash12(gl_FragCoord.xy + uFrameSeed) - 0.5;',
    '    c += g * uGrain * (1.0 - 0.7 * lum);',
    '  }',
    '  if(uDither > 0.0){',
    '    float d1 = hash12(gl_FragCoord.xy + uFrameSeed + 7.11);',
    '    float d2 = hash12(gl_FragCoord.xy + uFrameSeed + 19.37);',
    '    c += (d1 - d2) * (uDither / 255.0);',
    '  }',
    '  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);'
  ].join('\n');

  const FS_FXAA_HIGH = [
    'precision highp float;',
    'varying vec2 vUv;',
    'uniform sampler2D tDiffuse;',
    'uniform vec2 uTexel;',
    'uniform float uGrain;',
    'uniform float uDither;',
    'uniform float uFrameSeed;',
    HASH,
    'float lu(vec2 uv){ return texture2D(tDiffuse, uv).a; }',
    'float qstep(int i){',
    '  if(i == 1) return 1.5;',
    '  if(i == 6) return 4.0;',
    '  if(i == 7) return 8.0;',
    '  return 2.0;',
    '}',
    'void main(){',
    '  vec2 rcp = uTexel;',
    '  vec4 cM = texture2D(tDiffuse, vUv);',
    '  float lumaM = cM.a;',
    '  float lumaS = lu(vUv + vec2(0.0, -rcp.y));',
    '  float lumaE = lu(vUv + vec2( rcp.x, 0.0));',
    '  float lumaN = lu(vUv + vec2(0.0,  rcp.y));',
    '  float lumaW = lu(vUv + vec2(-rcp.x, 0.0));',
    '  float mx = max(lumaM, max(max(lumaN, lumaS), max(lumaE, lumaW)));',
    '  float mn = min(lumaM, min(min(lumaN, lumaS), min(lumaE, lumaW)));',
    '  float range = mx - mn;',
    '  vec3 c = cM.rgb;',
    '  if(range >= max(0.0833, mx * 0.166)){',
    '    float lumaNW = lu(vUv + vec2(-rcp.x,  rcp.y));',
    '    float lumaNE = lu(vUv + vec2( rcp.x,  rcp.y));',
    '    float lumaSW = lu(vUv + vec2(-rcp.x, -rcp.y));',
    '    float lumaSE = lu(vUv + vec2( rcp.x, -rcp.y));',
    '    float lumaNS = lumaN + lumaS;',
    '    float lumaWE = lumaW + lumaE;',
    '    float subpixRcpRange = 1.0 / range;',
    '    float subpixNSWE = lumaNS + lumaWE;',
    '    float edgeHorz1 = (-2.0 * lumaM) + lumaNS;',
    '    float edgeVert1 = (-2.0 * lumaM) + lumaWE;',
    '    float lumaNESE = lumaNE + lumaSE;',
    '    float lumaNWNE = lumaNW + lumaNE;',
    '    float edgeHorz2 = (-2.0 * lumaE) + lumaNESE;',
    '    float edgeVert2 = (-2.0 * lumaN) + lumaNWNE;',
    '    float lumaNWSW = lumaNW + lumaSW;',
    '    float lumaSWSE = lumaSW + lumaSE;',
    '    float edgeHorz4 = (abs(edgeHorz1) * 2.0) + abs(edgeHorz2);',
    '    float edgeVert4 = (abs(edgeVert1) * 2.0) + abs(edgeVert2);',
    '    float edgeHorz3 = (-2.0 * lumaW) + lumaNWSW;',
    '    float edgeVert3 = (-2.0 * lumaS) + lumaSWSE;',
    '    float edgeHorz = abs(edgeHorz3) + edgeHorz4;',
    '    float edgeVert = abs(edgeVert3) + edgeVert4;',
    '    float subpixNWSWNESE = lumaNWSW + lumaNESE;',
    '    float lengthSign = rcp.x;',
    '    bool horzSpan = edgeHorz >= edgeVert;',
    '    float subpixA = subpixNSWE * 2.0 + subpixNWSWNESE;',
    '    if(!horzSpan) lumaN = lumaW;',
    '    if(!horzSpan) lumaS = lumaE;',
    '    if(horzSpan) lengthSign = rcp.y;',
    '    float subpixB = (subpixA * (1.0 / 12.0)) - lumaM;',
    '    float gradientN = lumaN - lumaM;',
    '    float gradientS = lumaS - lumaM;',
    '    float lumaNN = lumaN + lumaM;',
    '    float lumaSS = lumaS + lumaM;',
    '    bool pairN = abs(gradientN) >= abs(gradientS);',
    '    float gradient = max(abs(gradientN), abs(gradientS));',
    '    if(pairN) lengthSign = -lengthSign;',
    '    float subpixC = clamp(abs(subpixB) * subpixRcpRange, 0.0, 1.0);',
    '    vec2 posB = vUv;',
    '    vec2 offNP = vec2(horzSpan ? rcp.x : 0.0, horzSpan ? 0.0 : rcp.y);',
    '    if(!horzSpan) posB.x += lengthSign * 0.5;',
    '    if( horzSpan) posB.y += lengthSign * 0.5;',
    '    vec2 posN = posB - offNP;',
    '    vec2 posP = posB + offNP;',
    '    if(!pairN) lumaNN = lumaSS;',
    '    float gradientScaled = gradient * 0.25;',
    '    float lumaMM = lumaM - lumaNN * 0.5;',
    '    bool lumaMLTZero = lumaMM < 0.0;',
    '    float lumaEndN = lu(posN) - lumaNN * 0.5;',
    '    float lumaEndP = lu(posP) - lumaNN * 0.5;',
    '    bool doneN = abs(lumaEndN) >= gradientScaled;',
    '    bool doneP = abs(lumaEndP) >= gradientScaled;',
    '    for(int i = 1; i < 8; i++){',
    '      if(doneN && doneP) break;',
    '      float q = qstep(i);',
    '      if(!doneN){',
    '        posN -= offNP * q;',
    '        lumaEndN = lu(posN) - lumaNN * 0.5;',
    '        doneN = abs(lumaEndN) >= gradientScaled;',
    '      }',
    '      if(!doneP){',
    '        posP += offNP * q;',
    '        lumaEndP = lu(posP) - lumaNN * 0.5;',
    '        doneP = abs(lumaEndP) >= gradientScaled;',
    '      }',
    '    }',
    '    float dstN = horzSpan ? (vUv.x - posN.x) : (vUv.y - posN.y);',
    '    float dstP = horzSpan ? (posP.x - vUv.x) : (posP.y - vUv.y);',
    '    bool goodSpanN = (lumaEndN < 0.0) != lumaMLTZero;',
    '    bool goodSpanP = (lumaEndP < 0.0) != lumaMLTZero;',
    '    float spanLength = dstP + dstN;',
    '    float dst = min(dstN, dstP);',
    '    bool goodSpan = (dstN < dstP) ? goodSpanN : goodSpanP;',
    '    float pixelOffset = (-dst / max(spanLength, 1.0e-6)) + 0.5;',
    '    float pixelOffsetGood = goodSpan ? pixelOffset : 0.0;',
    '    float subpixD = (-2.0 * subpixC) + 3.0;',
    '    float subpixE = subpixC * subpixC;',
    '    float subpixF = subpixD * subpixE;',
    '    float subpixG = subpixF * subpixF;',
    '    float subpixH = subpixG * 0.75;',
    '    float pixelOffsetSubpix = max(pixelOffsetGood, subpixH);',
    '    vec2 posM = vUv;',
    '    if(!horzSpan) posM.x += pixelOffsetSubpix * lengthSign;',
    '    if( horzSpan) posM.y += pixelOffsetSubpix * lengthSign;',
    '    c = texture2D(tDiffuse, posM).rgb;',
    '  }',
    GRAIN_TAIL,
    '}'
  ].join('\n');

  const FS_NOAA = [
    'precision highp float;',
    'varying vec2 vUv;',
    'uniform sampler2D tDiffuse;',
    'uniform float uGrain;',
    'uniform float uDither;',
    'uniform float uFrameSeed;',
    HASH,
    'void main(){',
    '  vec3 c = texture2D(tDiffuse, vUv).rgb;',
    GRAIN_TAIL,
    '}'
  ].join('\n');

  const FS_FXAA_LOW = [
    'precision highp float;',
    'varying vec2 vUv;',
    'uniform sampler2D tDiffuse;',
    'uniform vec2 uTexel;',
    'uniform float uGrain;',
    'uniform float uDither;',
    'uniform float uFrameSeed;',
    HASH,
    'void main(){',
    '  vec2 rcp = uTexel;',
    '  vec4 cM  = texture2D(tDiffuse, vUv);',
    '  vec4 cNW = texture2D(tDiffuse, vUv + vec2(-rcp.x,  rcp.y));',
    '  vec4 cNE = texture2D(tDiffuse, vUv + vec2( rcp.x,  rcp.y));',
    '  vec4 cSW = texture2D(tDiffuse, vUv + vec2(-rcp.x, -rcp.y));',
    '  vec4 cSE = texture2D(tDiffuse, vUv + vec2( rcp.x, -rcp.y));',
    '  float lM = cM.a, lNW = cNW.a, lNE = cNE.a, lSW = cSW.a, lSE = cSE.a;',
    '  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));',
    '  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));',
    '  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));',
    '  float reduce = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);',
    '  float rcpMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);',
    '  dir = clamp(dir * rcpMin, vec2(-8.0), vec2(8.0)) * rcp;',
    '  vec3 rgbA = 0.5 * (texture2D(tDiffuse, vUv + dir * (1.0 / 3.0 - 0.5)).rgb',
    '                   + texture2D(tDiffuse, vUv + dir * (2.0 / 3.0 - 0.5)).rgb);',
    '  vec4 t1 = texture2D(tDiffuse, vUv - dir * 0.5);',
    '  vec4 t2 = texture2D(tDiffuse, vUv + dir * 0.5);',
    '  vec3 rgbB = rgbA * 0.5 + 0.25 * (t1.rgb + t2.rgb);',
    '  float lB = (t1.a + t2.a) * 0.25 + dot(rgbA, vec3(0.299, 0.587, 0.114)) * 0.5;',
    '  vec3 c = (lB < lMin || lB > lMax) ? rgbA : rgbB;',
    GRAIN_TAIL,
    '}'
  ].join('\n');

  /* ========================================================= construction */

  function makeMat(fs, uniforms, glsl3, blending) {
    const m = new T.ShaderMaterial({
      uniforms: uniforms || {},
      vertexShader: VS,
      fragmentShader: fs,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      blending: blending || T.NoBlending,
      side: T.FrontSide
    });
    if (glsl3) m.glslVersion = T.GLSL3;
    return m;
  }

  function mkRT(w, h, opts) {
    const o = Object.assign({
      minFilter: T.LinearFilter,
      magFilter: T.LinearFilter,
      wrapS: T.ClampToEdgeWrapping,
      wrapT: T.ClampToEdgeWrapping,
      format: T.RGBAFormat,
      type: T.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      samples: 0
    }, opts || {});
    const rt = new T.WebGLRenderTarget(Math.max(1, w | 0), Math.max(1, h | 0), o);
    rt.texture.generateMipmaps = false;
    rt.texture.colorSpace = T.LinearSRGBColorSpace;
    return rt;
  }

  function mkFlatTex(r, g, b) {
    const tx = new T.DataTexture(new Uint8Array([r, g, b, 255]), 1, 1,
      T.RGBAFormat, T.UnsignedByteType);
    tx.minFilter = T.NearestFilter;
    tx.magFilter = T.NearestFilter;
    tx.generateMipmaps = false;
    tx.colorSpace = T.LinearSRGBColorSpace;
    tx.needsUpdate = true;
    return tx;
  }

  function disposeRT(rt) {
    if (!rt) return;
    if (rt.depthTexture && rt.depthTexture.dispose) rt.depthTexture.dispose();
    if (Array.isArray(rt.texture)) {
      for (let i = 0; i < rt.texture.length; i++) rt.texture[i].dispose();
    }
    rt.dispose();
  }

  /* ------------------------------------------------- procedural lens dirt */

  function makeLensDirt(size) {
    if (typeof document === 'undefined' || !document.createElement) {
      const data = new Uint8Array(4);
      data[0] = data[1] = data[2] = 0; data[3] = 255;
      const tx = new T.DataTexture(data, 1, 1, T.RGBAFormat, T.UnsignedByteType);
      tx.needsUpdate = true;
      return tx;
    }
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const g = cv.getContext('2d');
    if (!g) {
      const tx = new T.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, T.RGBAFormat, T.UnsignedByteType);
      tx.needsUpdate = true;
      return tx;
    }
    let seed = 20240517;
    const rnd = function () {
      seed = (seed * 1664525 + 1013904223) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    g.fillStyle = '#000000';
    g.fillRect(0, 0, size, size);
    g.globalCompositeOperation = 'lighter';

    // broad greasy smudges — these carry the veiling glare
    for (let i = 0; i < 28; i++) {
      const x = rnd() * size, y = rnd() * size, r = size * (0.035 + rnd() * 0.17);
      const a = 0.05 + rnd() * 0.14;
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0.0, 'rgba(255,255,255,' + a.toFixed(4) + ')');
      grd.addColorStop(0.45, 'rgba(255,255,255,' + (a * 0.4).toFixed(4) + ')');
      grd.addColorStop(1.0, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.beginPath(); g.arc(x, y, r, 0, 6.2831853); g.fill();
    }
    // salt spray specks
    for (let i = 0; i < 520; i++) {
      const x = rnd() * size, y = rnd() * size;
      const r = size * (0.0015 + rnd() * rnd() * 0.012);
      const a = 0.06 + rnd() * 0.30;
      const grd = g.createRadialGradient(x, y, 0, x, y, Math.max(r, 0.6));
      grd.addColorStop(0.0, 'rgba(255,255,255,' + a.toFixed(4) + ')');
      grd.addColorStop(1.0, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.beginPath(); g.arc(x, y, Math.max(r, 0.6), 0, 6.2831853); g.fill();
    }
    // wiper scratches
    g.lineCap = 'round';
    for (let i = 0; i < 16; i++) {
      const x = rnd() * size, y = rnd() * size;
      const ang = rnd() * 6.2831853, len = size * (0.06 + rnd() * 0.34);
      g.strokeStyle = 'rgba(255,255,255,' + (0.035 + rnd() * 0.075).toFixed(4) + ')';
      g.lineWidth = 0.8 + rnd() * 2.4;
      g.beginPath();
      g.moveTo(x, y);
      g.quadraticCurveTo(
        x + Math.cos(ang) * len * 0.5 + (rnd() - 0.5) * size * 0.08,
        y + Math.sin(ang) * len * 0.5 + (rnd() - 0.5) * size * 0.08,
        x + Math.cos(ang) * len,
        y + Math.sin(ang) * len);
      g.stroke();
    }
    // gentle corner weighting: real dirt reads strongest off-axis
    g.globalCompositeOperation = 'multiply';
    const vg = g.createRadialGradient(size * 0.5, size * 0.5, size * 0.06,
      size * 0.5, size * 0.5, size * 0.72);
    vg.addColorStop(0.0, 'rgba(90,90,90,1)');
    vg.addColorStop(0.6, 'rgba(190,190,190,1)');
    vg.addColorStop(1.0, 'rgba(255,255,255,1)');
    g.fillStyle = vg;
    g.fillRect(0, 0, size, size);
    g.globalCompositeOperation = 'source-over';

    const tex = new T.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = T.ClampToEdgeWrapping;
    tex.minFilter = T.LinearFilter;
    tex.magFilter = T.LinearFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = T.LinearSRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  }

  /* --------------------------------------------------------- tone-curve JS */

  // Mirror of toneCurve() above, used to derive the [0,1] renormalisation.
  function curveRaw(x, s) {
    const yp = s.tmGrey, ys = 1.0 - yp;
    const d = clamp(x, s.tmMinEV, s.tmMaxEV) - s.tmPivot;
    if (d >= 0.0) {
      const u = d * s.tmSlope / Math.max(ys, 1e-4);
      const gg = u / Math.pow(Math.pow(u, s.tmShoulder) + 1.0, 1.0 / s.tmShoulder);
      return yp + ys * gg;
    }
    const u = -d * s.tmSlope / Math.max(yp, 1e-4);
    const gg = u / Math.pow(Math.pow(u, s.tmToe) + 1.0, 1.0 / s.tmToe);
    return yp - yp * gg;
  }

  function pushToneUniforms(m) {
    if (!m || !m.uniforms || !m.uniforms.uTmA) return;
    const s = P.settings;
    const f0 = curveRaw(s.tmMinEV, s);
    const f1 = curveRaw(s.tmMaxEV, s);
    const inv = 1.0 / Math.max(f1 - f0, 1e-4);
    m.uniforms.uTmA.value.set(s.tmMinEV, s.tmMaxEV, s.tmPivot, s.tmSlope);
    m.uniforms.uTmB.value.set(s.tmToe, s.tmShoulder, s.tmGrey, s.tmSat);
    m.uniforms.uTmC.value.set(f0, inv);
  }

  /* --------------------------------------------------------------- build */

  P.build = function (rendererIn, sceneIn, cameraIn) {
    if (!T || !rendererIn) {
      P.ready = false;
      P.enabled = false;
      return P;
    }
    renderer = rendererIn;
    scene = sceneIn || SAIL.scene || null;
    camera = cameraIn || SAIL.camera || null;

    try {
      gl = renderer.getContext();
    } catch (e) { gl = null; }

    isWebGL2 = !!(renderer.capabilities && renderer.capabilities.isWebGL2);
    hdrOK = false;
    if (gl) {
      try {
        hdrOK = !!gl.getExtension('EXT_color_buffer_float') ||
                !!gl.getExtension('EXT_color_buffer_half_float');
      } catch (e) { hdrOK = false; }
    }

    // ---- degraded path: no float render targets available ----------------
    if (!hdrOK) {
      P.enabled = false;
      P.ready = true;
      try {
        renderer.toneMapping = T.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 0.9;
        renderer.outputColorSpace = T.SRGBColorSpace;
      } catch (e) { /* older renderer, ignore */ }
      P.stats.scale = 1;
      applySizeFallback();
      return P;
    }

    // renderer configuration per spec (post owns tonemap + encode)
    try {
      renderer.toneMapping = T.NoToneMapping;
      renderer.outputColorSpace = T.LinearSRGBColorSpace;
      renderer.setPixelRatio(1);
      renderer.autoClear = true;
    } catch (e) { /* ignore */ }

    // fullscreen triangle
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    geo.setAttribute('uv', new T.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    quadCam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    quadMesh = new T.Mesh(geo, new T.MeshBasicMaterial());
    quadMesh.frustumCulled = false;
    quadMesh.matrixAutoUpdate = false;
    quadMesh.updateMatrix();
    quadScene = new T.Scene();
    quadScene.matrixWorldAutoUpdate = false;
    quadScene.add(quadMesh);

    dirtTexture = makeLensDirt(256);
    blackTex = mkFlatTex(0, 0, 0);
    whiteTex = mkFlatTex(255, 255, 255);

    buildMaterials();
    applyQuality(true);

    if (camera && camera.layers) camera.layers.enable(P.layers.water);

    built = true;
    const dw = (P.displaySize.x | 0) || 1280;
    const dh = (P.displaySize.y | 0) || 800;
    P.resolution.set(-1, -1);
    P.setSize(dw, dh);

    P.ready = true;
    return P;
  };

  function applySizeFallback() {
    const dw = (P.displaySize.x | 0) || 1280;
    const dh = (P.displaySize.y | 0) || 800;
    P.resolution.set(dw, dh);
    P.texel.set(1 / dw, 1 / dh);
    try { renderer.setSize(dw, dh, false); } catch (e) { /* ignore */ }
  }

  function buildMaterials() {
    const V2 = function (x, y) { return new T.Vector2(x, y); };
    const s = P.settings;

    const expoUniforms = function () {
      return {
        uAdapt: { value: null },
        uExposure: { value: s.exposure },
        uAutoMix: { value: 1.0 },
        uEVBias: { value: s.evBias },
        uAdaptCfg: { value: new T.Vector4(s.keyValue, s.adaptExponent, s.adaptRef, 0) },
        uExpClamp: { value: V2(s.exposureMin, s.exposureMax) }
      };
    };

    mFill = makeMat(FS_FILL, { uFill: { value: new T.Vector4(0.18, 0.18, 0.18, 1.0) } });

    if (isWebGL2) {
      mMRT = makeMat(FS_MRT, {
        uColor: { value: null },
        uDepth: { value: null },
        uCamNF: { value: V2(0.1, 1000) }
      }, true);
    } else {
      mMRT = null;
    }

    mBright = makeMat(FS_BRIGHT, Object.assign({
      uHDR: { value: null },
      uSrcTexel: { value: V2(1 / 1600, 1 / 1000) },
      uThreshold: { value: s.bloomThreshold },
      uKnee: { value: s.bloomKnee },
      uVeil: { value: s.veil },
      uSSR: { value: blackTex },
      uSSRAmt: { value: 0.0 }
    }, expoUniforms()));

    mSSAO = makeMat(FS_SSAO, {
      uDepth: { value: null },
      uTexel: { value: V2(1 / 1600, 1 / 1000) },
      uCamNF: { value: V2(0.1, 1000) },
      uProjScale: { value: V2(1.0, 0.6) },
      uAOCfg: { value: new T.Vector4(s.ssaoRadius, s.ssaoIntensity, s.ssaoPower, s.ssaoBias) },
      uMaxUV: { value: s.ssaoMaxUV },
      uSeed: { value: 0 }
    });

    mBlurD = makeMat(FS_BLURD, {
      uTex: { value: null },
      uDepth: { value: null },
      uTexel: { value: V2(0, 0) },
      uCamNF: { value: V2(0.1, 1000) },
      uSpread: { value: 1.4 }
    });

    mSSR = makeMat(FS_SSR, {
      uColor: { value: null },
      uDepth: { value: null },
      uTexel: { value: V2(1 / 1600, 1 / 1000) },
      uCamNF: { value: V2(0.1, 1000) },
      uProjScale: { value: V2(1.0, 0.6) },
      uUpView: { value: new T.Vector3(0, 1, 0) },
      uSSRCfg: { value: new T.Vector4(s.ssrStrength, s.ssrJitter, s.ssrThickness, s.ssrMaxDist) },
      uEmit: { value: s.ssrEmitGate },
      uSeed: { value: 0 }
    });

    mDown13 = makeMat(FS_DOWN13, {
      uTex: { value: null },
      uSrcTexel: { value: V2(0, 0) }
    });

    mUpTent = makeMat(FS_UPTENT, {
      uTex: { value: null },
      uSrcTexel: { value: V2(0, 0) },
      uRadius: { value: s.bloomRadius },
      uScale: { value: s.bloomCascade }
    }, false, T.AdditiveBlending);

    mAvg36 = makeMat(FS_AVG36, { uTex: { value: null } });

    mLumFirst = makeMat(FS_LUM_FIRST, {
      uTex: { value: null },
      uSrcTexel: { value: V2(0, 0) }
    });

    mLumDown = makeMat(FS_LUM_DOWN, {
      uTex: { value: null },
      uSrcTexel: { value: V2(0, 0) }
    });

    mAdapt = makeMat(FS_ADAPT, {
      uLum: { value: null },
      uPrev: { value: null },
      uDt: { value: 0.016 },
      uTauUp: { value: s.adaptTauUp },
      uTauDown: { value: s.adaptTauDown }
    });

    mGRPre = makeMat(FS_GR_PRE, {
      uHDR: { value: null },
      uDepth: { value: null },
      uSunUV: { value: V2(0.5, 0.5) },
      uAspect: { value: 1.6 },
      uMask: { value: 0.0 },
      uCamNF: { value: V2(0.1, 1000) }
    });

    mGRBlur = makeMat(FS_GR_BLUR, {
      uTex: { value: null },
      uSunUV: { value: V2(0.5, 0.5) },
      uDensity: { value: s.godrayDensity },
      uStep: { value: 1 / 144 },
      uDecay: { value: s.godrayDecay }
    });

    mComposite = makeMat(FS_COMPOSITE, Object.assign({
      uHDR: { value: null },
      uBloom: { value: null },
      uGlare: { value: null },
      uFlat: { value: null },
      uDirt: { value: dirtTexture },
      uGodray: { value: null },
      uDepthTex: { value: null },
      uTexel: { value: V2(1 / 1600, 1 / 1000) },
      uCamNF: { value: V2(0.1, 1000) },
      uAspect: { value: 1.6 },
      uBloomAmt: { value: s.bloomHigh },
      uGlareAmt: { value: s.glare },
      uFlatAmt: { value: s.flatGlare },
      uGlareSat: { value: s.glareSat },
      uChroma: { value: s.chroma },
      uVignette: { value: s.vignette },
      uDirtAmt: { value: s.lensDirt },
      uGodrayAmt: { value: 0.0 },
      uGodrayTint: { value: new T.Vector3(1.0, 0.92, 0.78) },
      uDofMax: { value: s.dofMaxRadius },
      uDofStart: { value: s.dofStart },
      uDofRange: { value: s.dofRange },
      uTmA: { value: new T.Vector4(-10, 0.5, -2.4739, 0.26) },
      uTmB: { value: new T.Vector4(1.35, 1.5, 0.44, 1.08) },
      uTmC: { value: V2(0, 1) },
      uBleach: { value: new T.Vector4(s.bleachStart, s.bleachRange, s.bleachAmount, 0) },
      uAO: { value: whiteTex },
      uSSR: { value: blackTex },
      uLocal: { value: null },
      uAOAmt: { value: s.ssaoAmount },
      uSSRAmt: { value: 0.0 },
      uLocalCfg: { value: new T.Vector4(s.localShadow, s.localHighlight, s.localClamp, 0) }
    }, expoUniforms()));
    pushToneUniforms(mComposite);

    const fxaaUniforms = function () {
      return {
        tDiffuse: { value: null },
        uTexel: { value: V2(1 / 1600, 1 / 1000) },
        uGrain: { value: s.grain },
        uDither: { value: s.dither },
        uFrameSeed: { value: 0 }
      };
    };
    mFxaaHigh = makeMat(FS_FXAA_HIGH, fxaaUniforms());
    mFxaaLow = makeMat(FS_FXAA_LOW, fxaaUniforms());
    mNoAA = makeMat(FS_NOAA, fxaaUniforms());
  }

  /* ---------------------------------------------------------------- sizing */

  function up4(v) { return Math.max(4, Math.ceil(v / 4) * 4); }

  P.setSize = function (w, h) {
    const dw = Math.max(16, Math.floor(w || 1280));
    const dh = Math.max(16, Math.floor(h || 800));
    P.displaySize.set(dw, dh);

    if (!P.enabled || !built) {
      if (renderer) {
        try {
          renderer.setSize(dw, dh, false);
          if (P.settings.manageCanvasStyle && renderer.domElement && renderer.domElement.style) {
            renderer.domElement.style.width = dw + 'px';
            renderer.domElement.style.height = dh + 'px';
          }
        } catch (e) { /* ignore */ }
      }
      P.resolution.set(dw, dh);
      P.texel.set(1 / dw, 1 / dh);
      return;
    }

    const iw = up4(dw * renderScale);
    const ih = up4(dh * renderScale);
    if (P.resolution.x === iw && P.resolution.y === ih && rtHDR) return;

    P.resolution.set(iw, ih);
    P.texel.set(1 / iw, 1 / ih);
    P.stats.internalW = iw;
    P.stats.internalH = ih;
    P.stats.scale = renderScale;

    // canvas backing store = internal size; CSS box = display size (SSAA resolve)
    try {
      renderer.setSize(iw, ih, false);
      if (P.settings.manageCanvasStyle && renderer.domElement && renderer.domElement.style) {
        renderer.domElement.style.width = dw + 'px';
        renderer.domElement.style.height = dh + 'px';
      }
    } catch (e) { /* ignore */ }

    allocate(iw, ih);

    P.rtVersion++;
    for (let i = 0; i < P.onResize.length; i++) {
      try { P.onResize[i](iw, ih); } catch (e) { /* fail soft */ }
    }
  };

  function disposeBloomMips() {
    for (let i = 0; i < bloomMips.length; i++) disposeRT(bloomMips[i]);
    bloomMips.length = 0;
  }

  function allocate(iw, ih) {
    disposeRT(rtHDR); disposeRT(rtMRT); disposeRT(rtLDR);
    disposeBloomMips();
    disposeRT(rtL64); disposeRT(rtL16); disposeRT(rtL4); disposeRT(rtL1);
    disposeRT(rtGR0); disposeRT(rtGR1); disposeRT(rtFlat);
    disposeRT(rtAO0); disposeRT(rtAO1); disposeRT(rtSSR0); disposeRT(rtSSR1);
    // adapt targets survive resize so the eye does not re-adapt on a window drag
    let seedAdapt = false;
    if (!rtAdaptA) {
      rtAdaptA = mkRT(1, 1, { minFilter: T.NearestFilter, magFilter: T.NearestFilter });
      rtAdaptB = mkRT(1, 1, { minFilter: T.NearestFilter, magFilter: T.NearestFilter });
      seedAdapt = true;
    }

    rtHDR = mkRT(iw, ih, { depthBuffer: true });
    const dtex = new T.DepthTexture(iw, ih, T.UnsignedIntType);
    dtex.format = T.DepthFormat;
    dtex.minFilter = T.NearestFilter;
    dtex.magFilter = T.NearestFilter;
    dtex.generateMipmaps = false;
    rtHDR.depthTexture = dtex;

    if (isWebGL2 && P.settings.refractionPass) {
      rtMRT = new T.WebGLMultipleRenderTargets(iw, ih, 2, {
        type: T.HalfFloatType,
        format: T.RGBAFormat,
        minFilter: T.LinearFilter,
        magFilter: T.LinearFilter,
        wrapS: T.ClampToEdgeWrapping,
        wrapT: T.ClampToEdgeWrapping,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false,
        samples: 0
      });
      for (let i = 0; i < rtMRT.texture.length; i++) {
        rtMRT.texture[i].colorSpace = T.LinearSRGBColorSpace;
        rtMRT.texture[i].generateMipmaps = false;
      }
      P.sceneTexture = rtMRT.texture[0];
      P.linearDepthTexture = rtMRT.texture[1];
    } else {
      rtMRT = null;
      P.sceneTexture = null;
      P.linearDepthTexture = null;
    }
    P.depthTexture = dtex;

    rtLDR = mkRT(iw, ih, { type: T.UnsignedByteType });
    rtLDR.texture.colorSpace = T.LinearSRGBColorSpace;   // raw bytes, no decode

    /* ---- bloom mip chain -------------------------------------------------
       Six levels at a 1600 px internal width bottom out around 25x15, so the
       upsampled tail from the deepest level spans ~80 px on screen. THAT is
       what makes a bright lamp read as luminous rather than as a lit quad. */
    const want = (lastQuality === 'low') ? P.settings.bloomLevelsLow : P.settings.bloomLevelsHigh;
    let mw = iw, mh = ih;
    for (let i = 0; i < Math.max(2, want | 0); i++) {
      mw = Math.max(1, mw >> 1);
      mh = Math.max(1, mh >> 1);
      bloomMips.push(mkRT(mw, mh));
      if (mw <= 8 || mh <= 8) break;
    }
    bloomLevels = bloomMips.length;
    P.stats.bloomLevels = bloomLevels;

    rtFlat = mkRT(1, 1, { minFilter: T.NearestFilter, magFilter: T.NearestFilter });

    const qw = Math.max(1, iw >> 2), qh = Math.max(1, ih >> 2);
    rtGR0 = mkRT(qw, qh);
    rtGR1 = mkRT(qw, qh);

    // AO and SSR live at half resolution — both are low-frequency by nature
    // and both get a depth-aware blur before they are consumed.
    const hw = Math.max(1, iw >> 1), hh = Math.max(1, ih >> 1);
    rtAO0 = mkRT(hw, hh, { type: T.UnsignedByteType });
    rtAO1 = mkRT(hw, hh, { type: T.UnsignedByteType });
    rtSSR0 = mkRT(hw, hh);
    rtSSR1 = mkRT(hw, hh);

    rtL64 = mkRT(64, 64);
    rtL16 = mkRT(16, 16);
    rtL4 = mkRT(4, 4);
    rtL1 = mkRT(1, 1, { minFilter: T.NearestFilter, magFilter: T.NearestFilter });

    // seed the eye-adaptation state (first allocation only)
    mFill.uniforms.uFill.value.set(0.18, 0.18, 0.18, 1.0);
    if (seedAdapt) { blit(mFill, rtAdaptA); blit(mFill, rtAdaptB); }
    mFill.uniforms.uFill.value.set(-1.7148, 1.0, 0.0, 1.0);  // log(0.18), weight 1
    blit(mFill, rtL1);

    // static uniforms that follow the resolution
    mBright.uniforms.uSrcTexel.value.set(1 / iw, 1 / ih);
    mComposite.uniforms.uTexel.value.set(1 / iw, 1 / ih);
    mComposite.uniforms.uAspect.value = iw / ih;
    mGRPre.uniforms.uAspect.value = iw / ih;
    mFxaaHigh.uniforms.uTexel.value.set(1 / iw, 1 / ih);
    mFxaaLow.uniforms.uTexel.value.set(1 / iw, 1 / ih);
    mSSAO.uniforms.uTexel.value.set(1 / iw, 1 / ih);
    mSSR.uniforms.uTexel.value.set(1 / iw, 1 / ih);
  }

  /* -------------------------------------------------------------- quality */

  function applyQuality(force) {
    const q = (SAIL.quality === 'low') ? 'low' : 'high';
    if (!force && q === lastQuality) return false;
    const prevQ = lastQuality;
    lastQuality = q;
    const s = P.settings;
    const newScale = (q === 'low') ? s.renderScaleLow : s.renderScaleHigh;
    const wantLevels = (q === 'low') ? s.bloomLevelsLow : s.bloomLevelsHigh;
    const changed = (newScale !== renderScale) ||
                    (prevQ !== null && bloomMips.length > 0 && bloomMips.length !== Math.max(2, wantLevels | 0));
    renderScale = newScale;
    if (mComposite) {
      mComposite.uniforms.uBloomAmt.value = (q === 'low') ? s.bloomLow : s.bloomHigh;
      mComposite.uniforms.uDofMax.value = (q === 'low' || !s.dof) ? 0.0 : s.dofMaxRadius;
      mComposite.uniforms.uChroma.value = (q === 'low') ? s.chroma * 0.6 : s.chroma;
      mComposite.uniforms.uDirtAmt.value = (q === 'low') ? s.lensDirt * 0.5 : s.lensDirt;
    }
    return changed;
  }

  P.applyQuality = function (force) {
    if (applyQuality(force === true) && built && P.enabled) {
      const dw = P.displaySize.x, dh = P.displaySize.y;
      P.resolution.set(-1, -1);   // force reallocation
      P.setSize(dw, dh);
    }
  };

  /* ------------------------------------------------------------ blit core */

  function blit(mat, target, keep) {
    quadMesh.material = mat;
    const prev = renderer.autoClear;
    renderer.autoClear = !keep;          // additive upsample must not clear
    renderer.setRenderTarget(target || null);
    renderer.render(quadScene, quadCam);
    renderer.autoClear = prev;
    P.stats.passes++;
  }

  /* ---------------------------------------------------------- sun on screen */

  let sunOnScreen = 0;
  const sunUV = { x: 0.5, y: 0.5 };

  function updateSun() {
    sunOnScreen = 0;
    if (!camera) return;
    let dir = null;
    if (SAIL.sky && SAIL.sky.sunDir && isNum(SAIL.sky.sunDir.x)) dir = SAIL.sky.sunDir;
    else if (SAIL.env && SAIL.env.sunDir && isNum(SAIL.env.sunDir.x)) dir = SAIL.env.sunDir;
    if (!dir) return;

    _sunWorld.set(dir.x, dir.y, dir.z);
    if (_sunWorld.lengthSq() < 1e-8) return;
    _sunWorld.normalize();
    if (_sunWorld.y < -0.03) return;                    // below the horizon

    camera.getWorldDirection(_camDir);
    const facing = _camDir.dot(_sunWorld);
    if (facing <= 0.02) return;                         // behind the camera

    camera.getWorldPosition(_camPos);
    _sunNDC.copy(_camPos).addScaledVector(_sunWorld, 1.0e5);
    _sunNDC.project(camera);
    if (!isNum(_sunNDC.x) || !isNum(_sunNDC.y)) return;

    sunUV.x = _sunNDC.x * 0.5 + 0.5;
    sunUV.y = _sunNDC.y * 0.5 + 0.5;

    const ox = Math.max(0, Math.max(-0.35 - sunUV.x, sunUV.x - 1.35));
    const oy = Math.max(0, Math.max(-0.35 - sunUV.y, sunUV.y - 1.35));
    if (ox > 0 || oy > 0) return;

    const edgeX = 1.0 - Math.min(1.0, Math.max(0.0, (Math.abs(sunUV.x - 0.5) - 0.5) / 0.85));
    const edgeY = 1.0 - Math.min(1.0, Math.max(0.0, (Math.abs(sunUV.y - 0.5) - 0.5) / 0.85));
    const alt = clamp((_sunWorld.y + 0.03) / 0.09, 0, 1);
    const face = clamp((facing - 0.02) / 0.25, 0, 1);
    sunOnScreen = edgeX * edgeY * alt * face;

    if (_sunColor) {
      const ec = (SAIL.env && SAIL.env.sunColor) || (SAIL.sky && SAIL.sky.sunColor);
      if (ec && isNum(ec.r)) _sunColor.setRGB(ec.r, ec.g, ec.b);
      else _sunColor.setRGB(1.0, 0.92, 0.78);
    }
  }

  /* ---------------------------------------------------------------- render */

  P.render = function (dt) {
    if (!P.ready || !renderer) return;
    if (!scene) scene = SAIL.scene || null;
    if (!camera) camera = SAIL.camera || null;
    if (!scene || !camera) return;

    const d = isNum(dt) ? clamp(dt, 0, 0.25) : 0.016;
    elapsed += d;
    frameSeed = (frameSeed + 1) % 4096;
    P.stats.passes = 0;
    P.stats.time = elapsed;

    // ---- degraded path -----------------------------------------------
    if (!P.enabled || !built) {
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
      return;
    }

    if (applyQuality(false)) {
      const dw = P.displaySize.x, dh = P.displaySize.y;
      P.resolution.set(-1, -1);
      P.setSize(dw, dh);
    }
    if (!rtHDR || bloomMips.length === 0) return;

    const q = lastQuality;
    const s = P.settings;
    const iw = P.resolution.x, ih = P.resolution.y;
    const near = camera.near || 0.1, far = camera.far || 1000;

    // manual exposure: prefer the sky module's schedule when it publishes one
    let manualExposure = s.exposure;
    if (SAIL.env && isNum(SAIL.env.exposure) && SAIL.env.exposure > 0) manualExposure = SAIL.env.exposure;
    const auto = (q === 'high') && !!s.autoExposure;

    const expoMats = [mBright, mComposite];
    for (let i = 0; i < 2; i++) {
      const u = expoMats[i].uniforms;
      u.uExposure.value = manualExposure;
      u.uAutoMix.value = auto ? 1.0 : 0.0;
      u.uEVBias.value = s.evBias;
      u.uAdaptCfg.value.set(s.keyValue, s.adaptExponent, s.adaptRef, 0);
      u.uExpClamp.value.set(s.exposureMin, s.exposureMax);
    }
    mBright.uniforms.uThreshold.value = s.bloomThreshold;
    mBright.uniforms.uKnee.value = s.bloomKnee;
    mBright.uniforms.uVeil.value = s.veil;
    mUpTent.uniforms.uRadius.value = s.bloomRadius;
    mComposite.uniforms.uCamNF.value.set(near, far);
    mComposite.uniforms.uVignette.value = s.vignette;
    mComposite.uniforms.uGlareAmt.value = s.glare;
    mComposite.uniforms.uFlatAmt.value = s.flatGlare;
    mComposite.uniforms.uGlareSat.value = s.glareSat;
    mComposite.uniforms.uBloomAmt.value = (q === 'low') ? s.bloomLow : s.bloomHigh;
    pushToneUniforms(mComposite);
    mGRPre.uniforms.uCamNF.value.set(near, far);
    if (mMRT) mMRT.uniforms.uCamNF.value.set(near, far);

    const seed = frameSeed * 1.7137;
    const aaMats = [mFxaaHigh, mFxaaLow, mNoAA];
    for (let i = 0; i < 3; i++) {
      aaMats[i].uniforms.uGrain.value = s.grain;
      aaMats[i].uniforms.uDither.value = s.dither;
      aaMats[i].uniforms.uFrameSeed.value = seed;
    }

    const savedMask = camera.layers.mask;
    const waterBit = 1 << P.layers.water;
    const waterMask = savedMask & waterBit;
    const opaqueMask = savedMask & ~waterBit;
    const savedAutoClear = renderer.autoClear;
    const doRefraction = !!(rtMRT && mMRT && s.refractionPass);

    // ---- F2 : opaque scene -> rtHDR ----------------------------------
    renderer.autoClear = true;
    camera.layers.mask = doRefraction ? opaqueMask : savedMask;
    renderer.setRenderTarget(rtHDR);
    renderer.render(scene, camera);
    P.stats.passes++;

    /* Projection basis for every depth-space pass. Taken off the matrix
       rather than fov/aspect so a shot preset that pokes the projection
       directly still reconstructs correctly. */
    const pe = camera.projectionMatrix.elements;
    const psx = (isNum(pe[0]) && Math.abs(pe[0]) > 1e-6) ? (1.0 / Math.abs(pe[0])) : 1.0;
    const psy = (isNum(pe[5]) && Math.abs(pe[5]) > 1e-6) ? (1.0 / Math.abs(pe[5])) : 0.6;
    const aoOn = (q === 'high') && !!s.ssao;
    const ssrOn = (q === 'high') && !!s.ssr && s.ssrStrength > 0;

    // ---- F2b : SSAO from the OPAQUE depth only ------------------------
    let aoTex = whiteTex;
    if (aoOn && rtAO0) {
      mSSAO.uniforms.uDepth.value = rtHDR.depthTexture;
      mSSAO.uniforms.uCamNF.value.set(near, far);
      mSSAO.uniforms.uProjScale.value.set(psx, psy);
      mSSAO.uniforms.uAOCfg.value.set(s.ssaoRadius, s.ssaoIntensity, s.ssaoPower, s.ssaoBias);
      mSSAO.uniforms.uMaxUV.value = s.ssaoMaxUV;
      mSSAO.uniforms.uSeed.value = frameSeed * 3.719;
      blit(mSSAO, rtAO0);

      mBlurD.uniforms.uTex.value = rtAO0.texture;
      mBlurD.uniforms.uDepth.value = rtHDR.depthTexture;
      mBlurD.uniforms.uCamNF.value.set(near, far);
      mBlurD.uniforms.uTexel.value.set(1 / rtAO0.width, 1 / rtAO0.height);
      mBlurD.uniforms.uSpread.value = 1.4;
      blit(mBlurD, rtAO1);
      aoTex = rtAO1.texture;
    }

    // ---- F3 : MRT copy + depth linearise -----------------------------
    if (doRefraction) {
      mMRT.uniforms.uColor.value = rtHDR.texture;
      mMRT.uniforms.uDepth.value = rtHDR.depthTexture;
      blit(mMRT, rtMRT);

      // ---- F4 : water / transparent -> rtHDR (keep colour + depth) ----
      if (waterMask !== 0) {
        renderer.autoClear = false;
        camera.layers.mask = waterMask;
        renderer.setRenderTarget(rtHDR);
        renderer.render(scene, camera);
        P.stats.passes++;
        renderer.autoClear = true;
      }
    }
    camera.layers.mask = savedMask;
    renderer.autoClear = true;

    /* ---- F4b : SSR. Runs AFTER the water so the sea surface itself is in
       the depth buffer and its wave normals drive the march — that is what
       gives the reflected column its horizontal break-up for free. -------- */
    let ssrTex = blackTex, ssrAmt = 0;
    if (ssrOn && rtSSR0) {
      _upView.set(0, 1, 0).transformDirection(camera.matrixWorldInverse);
      mSSR.uniforms.uColor.value = rtHDR.texture;
      mSSR.uniforms.uDepth.value = rtHDR.depthTexture;
      mSSR.uniforms.uCamNF.value.set(near, far);
      mSSR.uniforms.uProjScale.value.set(psx, psy);
      mSSR.uniforms.uUpView.value.set(_upView.x, _upView.y, _upView.z);
      mSSR.uniforms.uSSRCfg.value.set(s.ssrStrength, s.ssrJitter, s.ssrThickness, s.ssrMaxDist);
      mSSR.uniforms.uEmit.value = s.ssrEmitGate;
      mSSR.uniforms.uSeed.value = frameSeed * 5.113;
      blit(mSSR, rtSSR0);

      mBlurD.uniforms.uTex.value = rtSSR0.texture;
      mBlurD.uniforms.uDepth.value = rtHDR.depthTexture;
      mBlurD.uniforms.uCamNF.value.set(near, far);
      mBlurD.uniforms.uTexel.value.set(1 / rtSSR0.width, 1 / rtSSR0.height);
      mBlurD.uniforms.uSpread.value = s.ssrBlur;
      blit(mBlurD, rtSSR1);
      ssrTex = rtSSR1.texture;
      ssrAmt = 1.0;
    }
    mBright.uniforms.uSSR.value = ssrTex;
    mBright.uniforms.uSSRAmt.value = ssrAmt;
    mComposite.uniforms.uSSR.value = ssrTex;
    mComposite.uniforms.uSSRAmt.value = ssrAmt;
    mComposite.uniforms.uAO.value = aoTex;
    mComposite.uniforms.uAOAmt.value = aoOn ? s.ssaoAmount : 0.0;
    mComposite.uniforms.uBleach.value.set(s.bleachStart, s.bleachRange, s.bleachAmount, 0);

    // ---- F5 : auto-exposure (before anything reads uAdapt) ------------
    const adaptSrc = adaptFlip ? rtAdaptB : rtAdaptA;
    const adaptDst = adaptFlip ? rtAdaptA : rtAdaptB;
    if (auto) {
      mLumFirst.uniforms.uTex.value = rtHDR.texture;
      mLumFirst.uniforms.uSrcTexel.value.set(1 / 192, 1 / 192);
      blit(mLumFirst, rtL64);

      mLumDown.uniforms.uTex.value = rtL64.texture;
      mLumDown.uniforms.uSrcTexel.value.set(1 / 64, 1 / 64);
      blit(mLumDown, rtL16);

      mLumDown.uniforms.uTex.value = rtL16.texture;
      mLumDown.uniforms.uSrcTexel.value.set(1 / 16, 1 / 16);
      blit(mLumDown, rtL4);

      mLumDown.uniforms.uTex.value = rtL4.texture;
      mLumDown.uniforms.uSrcTexel.value.set(1 / 4, 1 / 4);
      blit(mLumDown, rtL1);

      mAdapt.uniforms.uLum.value = rtL1.texture;
      mAdapt.uniforms.uPrev.value = adaptSrc.texture;
      mAdapt.uniforms.uDt.value = d;
      mAdapt.uniforms.uTauUp.value = s.adaptTauUp;
      mAdapt.uniforms.uTauDown.value = s.adaptTauDown;
      blit(mAdapt, adaptDst);
      adaptFlip = !adaptFlip;
    }
    const adaptTex = (auto ? adaptDst : adaptSrc).texture;
    mBright.uniforms.uAdapt.value = adaptTex;
    mComposite.uniforms.uAdapt.value = adaptTex;

    // the local operator rides on the same 64x64 field the metering builds
    const localOn = auto && !!s.localTM && rtL64;
    mComposite.uniforms.uLocal.value = localOn ? rtL64.texture : blackTex;
    mComposite.uniforms.uLocalCfg.value.set(
      s.localShadow, s.localHighlight, s.localClamp, localOn ? 1.0 : 0.0);

    // ---- F6 : bright pass + veil -> mip0 ------------------------------
    mBright.uniforms.uHDR.value = rtHDR.texture;
    mBright.uniforms.uSrcTexel.value.set(1 / iw, 1 / ih);
    blit(mBright, bloomMips[0]);

    // ---- F7 : downsample the chain ------------------------------------
    for (let i = 1; i < bloomMips.length; i++) {
      const src = bloomMips[i - 1];
      mDown13.uniforms.uTex.value = src.texture;
      mDown13.uniforms.uSrcTexel.value.set(1 / src.width, 1 / src.height);
      blit(mDown13, bloomMips[i]);
    }

    // ---- F7b : whole-frame average of the coarsest mip -> 1x1 ----------
    mAvg36.uniforms.uTex.value = bloomMips[bloomMips.length - 1].texture;
    blit(mAvg36, rtFlat);

    // ---- F8 : progressive additive upsample ---------------------------
    mUpTent.uniforms.uScale.value = s.bloomCascade;
    for (let i = bloomMips.length - 2; i >= 0; i--) {
      const src = bloomMips[i + 1];
      mUpTent.uniforms.uTex.value = src.texture;
      mUpTent.uniforms.uSrcTexel.value.set(1 / src.width, 1 / src.height);
      blit(mUpTent, bloomMips[i], true);     // additive, do not clear
    }

    // ---- F9 : god rays -------------------------------------------------
    let godAmt = 0;
    if (q === 'high' && s.godrays) {
      updateSun();
      if (sunOnScreen > 0.002) {
        mGRPre.uniforms.uHDR.value = rtHDR.texture;
        mGRPre.uniforms.uDepth.value = rtHDR.depthTexture;
        mGRPre.uniforms.uSunUV.value.set(sunUV.x, sunUV.y);
        mGRPre.uniforms.uMask.value = sunOnScreen;
        blit(mGRPre, rtGR0);

        mGRBlur.uniforms.uSunUV.value.set(sunUV.x, sunUV.y);
        mGRBlur.uniforms.uDensity.value = s.godrayDensity;
        mGRBlur.uniforms.uDecay.value = s.godrayDecay;

        mGRBlur.uniforms.uTex.value = rtGR0.texture;
        mGRBlur.uniforms.uStep.value = 1 / 144;
        blit(mGRBlur, rtGR1);

        mGRBlur.uniforms.uTex.value = rtGR1.texture;
        mGRBlur.uniforms.uStep.value = 1 / 12;
        blit(mGRBlur, rtGR0);

        godAmt = s.godrayStrength * sunOnScreen;
        if (_sunColor) {
          const mxc = Math.max(_sunColor.r, Math.max(_sunColor.g, _sunColor.b)) || 1;
          mComposite.uniforms.uGodrayTint.value.set(
            _sunColor.r / mxc, _sunColor.g / mxc, _sunColor.b / mxc);
        }
      }
    }
    mComposite.uniforms.uGodrayAmt.value = godAmt;
    mComposite.uniforms.uGodray.value = rtGR0 ? rtGR0.texture : null;

    // ---- F10 : composite ----------------------------------------------
    mComposite.uniforms.uHDR.value = rtHDR.texture;
    mComposite.uniforms.uBloom.value = bloomMips[0].texture;
    mComposite.uniforms.uGlare.value = bloomMips[bloomMips.length - 1].texture;
    mComposite.uniforms.uFlat.value = rtFlat.texture;
    mComposite.uniforms.uDepthTex.value = rtHDR.depthTexture;
    mComposite.uniforms.uDirt.value = dirtTexture;
    mComposite.uniforms.uDofStart.value = s.dofStart;
    mComposite.uniforms.uDofRange.value = s.dofRange;
    blit(mComposite, rtLDR);

    // ---- F11 : FXAA + grain + dither -> canvas -------------------------
    const fx = !s.fxaa ? mNoAA : ((q === 'low') ? mFxaaLow : mFxaaHigh);
    fx.uniforms.tDiffuse.value = rtLDR.texture;
    blit(fx, null);

    renderer.setRenderTarget(null);
    renderer.autoClear = savedAutoClear;

    // publish the refraction sources for the ocean module
    if (rtMRT) {
      P.sceneTexture = rtMRT.texture[0];
      P.linearDepthTexture = rtMRT.texture[1];
    }
    P.depthTexture = rtHDR.depthTexture;
  };

  /* --------------------------------------------------------- misc helpers */

  P.setScene = function (s) { scene = s || scene; };
  P.setCamera = function (c) {
    if (!c) return;
    camera = c;
    if (camera.layers) camera.layers.enable(P.layers.water);
  };

  P.sunScreen = function () {
    updateSun();
    return { x: sunUV.x, y: sunUV.y, vis: sunOnScreen };
  };

  /* Evaluate the display response of a linear radiance value. Handy for
     other modules (and for calibration) — returns the 0..1 sRGB-encoded
     grey level a neutral surface of that exposed radiance would print at. */
  P.responseCurve = function (exposedLinear) {
    const s = P.settings;
    const x = Math.log(Math.max(exposedLinear, 1e-10)) / Math.LN2;
    const f0 = curveRaw(s.tmMinEV, s);
    const f1 = curveRaw(s.tmMaxEV, s);
    const v = (curveRaw(x, s) - f0) / Math.max(f1 - f0, 1e-4);
    return clamp(v, 0, 1);
  };

  /* Numeric read-out of the curve currently loaded: the code value 18% grey
     prints at, the midtone contrast in code value per stop, and where the
     white point actually lands. This is the calibration the module is tuned
     against — grey near 0.46-0.50, contrast near 0.21, white finite. */
  P.curveReport = function () {
    const s = P.settings;
    const g = P.responseCurve(0.18);
    return {
      greyCode: +(g * 255).toFixed(1),
      grey: +g.toFixed(4),
      contrastPerStop: +(P.responseCurve(0.36) - g).toFixed(4),
      shoulderPerStop: +(P.responseCurve(0.72) - P.responseCurve(0.36)).toFixed(4),
      whiteAt: +Math.pow(2, s.tmMaxEV).toFixed(4),
      headroomStops: +(s.tmMaxEV - s.tmPivot).toFixed(3),
      clipsAt1: P.responseCurve(1.0) >= 0.999,
      atOne: +P.responseCurve(1.0).toFixed(4),
      atHalf: +P.responseCurve(0.5).toFixed(4),
      atSixteenth: +P.responseCurve(0.01125).toFixed(4)
    };
  };

  P.dispose = function () {
    disposeRT(rtHDR); disposeRT(rtMRT); disposeRT(rtLDR);
    disposeBloomMips();
    disposeRT(rtL64); disposeRT(rtL16); disposeRT(rtL4); disposeRT(rtL1);
    disposeRT(rtGR0); disposeRT(rtGR1); disposeRT(rtFlat);
    disposeRT(rtAO0); disposeRT(rtAO1); disposeRT(rtSSR0); disposeRT(rtSSR1);
    disposeRT(rtAdaptA); disposeRT(rtAdaptB);
    rtHDR = rtMRT = rtLDR = null;
    rtL64 = rtL16 = rtL4 = rtL1 = rtFlat = null;
    rtGR0 = rtGR1 = rtAdaptA = rtAdaptB = null;
    rtAO0 = rtAO1 = rtSSR0 = rtSSR1 = null;
    const mats = [mFill, mMRT, mBright, mDown13, mUpTent, mAvg36, mLumFirst, mLumDown,
                  mAdapt, mGRPre, mGRBlur, mComposite, mFxaaHigh, mFxaaLow, mNoAA,
                  mSSAO, mSSR, mBlurD];
    for (let i = 0; i < mats.length; i++) if (mats[i]) mats[i].dispose();
    if (dirtTexture) dirtTexture.dispose();
    if (blackTex) blackTex.dispose();
    if (whiteTex) whiteTex.dispose();
    if (quadMesh && quadMesh.geometry) quadMesh.geometry.dispose();
    P.sceneTexture = null;
    P.linearDepthTexture = null;
    P.depthTexture = null;
    P.ready = false;
    built = false;
  };

})();
