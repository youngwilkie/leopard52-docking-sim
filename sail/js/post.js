/* ==========================================================================
   post.js — SAIL.post : HDR post-processing chain, three.js r160 CORE ONLY.
   --------------------------------------------------------------------------
   No EffectComposer, no examples/ addons. Own render targets, own fullscreen
   triangle, own passes.

     F2   opaque scene           -> rtHDR             (RGBA16F + DepthTexture)
     F2b  SSAO + depth blur      -> rtAO1   (half res, opaque depth only)
          .r = occlusion (a 12 cm contact kernel * a 55 cm wide kernel)
          .gba = packed view normal, consumed by the composite's
          directional ambient. Sky and anything past ssaoRange write 0.
     F3   MRT copy + linearise   -> rtMRT[0]=rtScene, rtMRT[1]=rtLinD
     F4   water / transparent    -> rtHDR   (autoClear off)
     F4b  SSR + depth blur       -> rtSSR1  (half res, post-water depth)
     F5   auto-exposure chain    rtHDR->L64->L16->L4->L1 -> adapt (1x1 ping-pong)
     F6   bright pass, 13-tap Karis downsample + soft knee + lens-veil -> mip0
     F7   mip chain downsample   mip0 -> mip1 .. mipN-1  (13-tap COD kernel)
     F8   mip chain upsample     mipN-1 -> .. -> mip0    (3x3 tent, ADDITIVE)
     F9   god rays               rtHDR(+depth) -> rtGR0 -> rtGR1 -> rtGR0
     F10  composite (CA, far-field DoF, SSR add, exposure, LOCAL tone map,
          AO, DIRECTIONAL AMBIENT, wide bloom + lens dirt, veiling glare,
          god rays, analytic sun glare, scotopic shift, highlight bleach,
          AgX-space filmic sigmoid, vignette, sRGB OETF, luma into alpha)
          -> rtLDR
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

     2. Shadowed things are not a constant, and they are not one COLOUR
        either. Ambient without an occlusion term is a flat added value, and
        a flat added value is why an unlit cockpit reads as painted. F2b is
        Alchemy obscurance off the opaque depth at two radii — a 12 cm
        contact kernel that draws the dark line under a rope or a bucket
        foot, and a weak 55 cm kernel for room-scale obscurance.

        The same pass packs its view normal into the buffer's gba, and the
        composite spends it on the other half of the problem: DIRECTION.
        Golden hour is defined by a warm key against a cold fill, and a
        moonlit anchorage is defined by having a key at all. So the ambient
        gets a cool sky-dome term weighted by normal-up, a warm sea/ground
        bounce weighted by normal-down, and — once the sun is below civil
        twilight — a real lunar key applied as a value split about its own
        mean, so a hull acquires a top, a side and a terminator instead of
        one constant grey. All three are gated on how dim the pixel already
        is, so nothing direct-lit is re-shaded.

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

     * a FINITE white point — tmMaxEV is ~3.6 stops over middle grey, which
       is about the headroom an sRGB display image has. Anything brighter
       clips to 255. Sun disks, glitter cores and sunlit cumulus crowns are
       SUPPOSED to clip; if a daylight frame has 0% clipped pixels the
       exposure is wrong. Equally, the curve must ARRIVE at white with
       almost no slope left (see curveReport().slopeAtWhite): a curve that is
       still climbing 0.18/stop when it hits 1.0 is not rolling off, it is
       being truncated, and truncation is per-channel — which is how a
       saturated over-range source ends up with one primary pinned flat and
       every trace of its shading gone.
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
  P.gradeVersion = 'grade-4';
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
    /* ---- NIGHT METERING KEY --------------------------------------------
       An auto-exposure meter with ONE key value renders every scene to the
       same mean, which is day-for-night that forgot the night: the previous
       build printed a byte-identical curveReport for cockpit-golden and for
       night, and the 22:00 sky measured (43,48,56) — a milky grey. A real
       photographer does not meter a night scene to 18% grey; the eye does
       not either. The key ramps DOWN on the same civil-twilight gate the
       scotopic term uses, so the anchorage lands roughly a stop and a
       quarter under the daylight key and darkness reads as darkness. */
    keyValueNight: 0.135,
    /* Incomplete adaptation. 0.55 rather than 0.60 because a 22:00 anchorage
       metered any harder simply comes back as a grey day: the local operator
       below is what recovers the shadow detail now, not the meter. */
    adaptExponent: 0.55,
    adaptRef: 8.0,
    /* Night metering trim, blended in on the same civil-twilight gate the
       scotopic term uses. The incomplete-adaptation exponent leaves a 22:00
       anchorage 4-6 stops under middle grey — which is the far, FLAT end of
       the tone curve's toe, where two surfaces a stop apart print 7 codes
       apart. That is a large part of why the night frame measured 1.4 M of
       2.25 M pixels inside one 16-code bin. Metering it a third of a stop
       closer moves the whole scene onto steeper glass. Measured: luminance
       sd 30.0 -> 34, histogram entropy 3.45 -> 3.57 bits, with the darkest
       pixel still on code 3. Any more and the shore windows stop being
       windows and become one white mass. */
    /* Held at 1.0 now that keyValueNight does the metering. The old 1.30
       trim was compensating for a key that never moved; stacking both put
       the night frame back on a daytime mean. */
    nightMeter: 1.00,
    exposureMin: 0.0015,
    exposureMax: 3.0,
    adaptTauUp: 1.2,        // brightening time constant, seconds
    adaptTauDown: 3.0,      // darkening

    /* ---- bloom : mip chain ---------------------------------------------
       CALIBRATION. A threshold is only meaningful RELATIVE to the exposure
       the scene actually produces. This chain used to sit at 1.00 exposed
       while the curve's white point was 1.93 and auto-exposure put the
       brightest large object in the golden-hour frame — the backlit
       mainsail — at about 0.45 exposed. The hero subject of the whole build
       therefore emitted exactly zero halation, and a 200-code edge against
       the mast silhouette resolved in two pixels. That is a rasteriser, not
       a lens.

       The threshold now sits just UNDER the autoexposed key (0.45), so the
       sail, the sunlit crown, the glitter and every deck light are sources
       that bleed. The knee is wide so the transition into the bloom is a
       gradient rather than a step.

       KERNEL. The previous chain used an axis-aligned 3x3 tent at a 1.3
       source-texel radius. At the coarse end one source texel magnifies to
       ~30 screen pixels, so those nine taps land on a 3x3 LATTICE 40 px
       apart and the "halo" around a small emitter resolves as a hard-edged
       axis-aligned SQUARE — which is what the port nav light was. Nothing in
       optics produces a square, and no amount of radius tuning fixes a
       kernel whose support is a box. The upsample is now a rotated
       hexagonal dual-ring (13 taps, two radii, 30 degrees apart) with a
       golden-angle rotation applied PER LEVEL, so successive levels never
       share a sampling axis and the accumulated point-spread function is
       radially symmetric by construction. */
    bloomHigh: 0.220,       // intensity of the accumulated mip0
    bloomLow: 0.170,
    /* Eight levels, floored at 10 px rather than 24: the widest lobe has to
       be genuinely wide for a point source to read as an inverse-square glow
       rather than as a lit quad. The composite's flat-glare tap picks the
       deepest mip that is still >= 22 px wide (see render()), so the coarse
       levels can go small without the wide veil turning blocky. */
    bloomLevelsHigh: 8,
    bloomLevelsLow: 6,
    /* app.js's quality profile pins bloomLevelsHigh/Low to its own perf
       budget, and that budget was written against the old kernel. These are
       ADDED to whatever it asks for. Two extra levels cost one 27x16 and one
       13x8 down/up pair — a rounding error — and they are the difference
       between a halo that dies at 80 px and one that carries a measurable
       skirt to 300, which is what an inverse-square glow around a point
       source actually looks like. */
    bloomExtraHigh: 2,
    bloomExtraLow: 1,
    /* Soft knee, applied as a quadratic ramp rather than a clamp, so a small
       bright emitter produces a gradient into the halo instead of a plate. */
    bloomThreshold: 0.40,
    bloomKnee: 0.55,
    /* LIGHT WRAP. Dilating the bloom mask a pixel or two before it is added
       lets a bright background bleed OVER thin dark foreground geometry —
       which is what stops a shroud or a backstay crossing a near-sun sky
       from reading as a 2 px aliased wire. */
    bloomWrap: 0.50,
    /* Cascade is the per-level upsample gain, i.e. how much of each WIDE mip
       survives into the final halo. At 0.84 the deep levels dominated and
       every point source at night was averaged into one low-frequency milk
       veil with visible bilinear mip structure. With eight levels and a
       radially symmetric kernel the tail no longer accumulates as structure,
       so 0.72 buys a genuinely wide skirt while the tight core is carried by
       the (reduced) bloomHigh rather than by the cascade. */
    bloomCascade: 0.72,     // per-level upsample gain (tail decay rate)
    bloomRadius: 1.05,      // ring-filter radius in source texels

    /* The veil is the wide, low-amplitude term that makes a bright edge
       bleed 30-60 px instead of 4. At 0.045 it was still inaudible: disabling
       every glare term in the build changed the frame by almost nothing,
       which for a shot INTO a low sun is the wrong answer. Real glass throws
       a veiling flare that washes the shadows and eats thin dark objects. */
    veil: 0.145,            // fraction of ALL light entering the bloom chain
    glare: 0.075,           // wide low-frequency glare from the deepest mip
    /* Both the veil and the wide glare are partly GATED on the sun being in
       frame — barrel scatter is dominated by the brightest source actually
       hitting the front element. These are the floor fractions that survive
       with the sun out of frame; the rest ramps in with sunScreen().vis. */
    veilFloor: 0.40,
    glareFloor: 0.45,
    /* flatGlare sets the black floor. It is a FLAT add, so every code it
       contributes is a code of black point destroyed; with the toe now open
       (see tmToe) the curve carries the shadows and this term no longer has
       to. 0.28 measurably lifted the night sky away from the town by 9 codes
       and washed the building facades to a uniform grey.
       Measured at cockpit-golden: 0.28 put the darkest pixel in the whole
       frame on code 41, 0.115 on code 19. At 0.022 the floor lands on 3.8 —
       off zero, which is what the term is for, and no further. */
    flatGlare: 0.008,
    glareSat: 0.50,         // veil chroma: 0 = neutral, 1 = full key colour
    lensDirt: 0.30,         // extra veiling on the bloom where the glass is dirty

    /* ---- direct sun veiling glare ---------------------------------------
       A bloom filter blurs whatever is bright. A LENS does something else:
       light from the sun scatters off every air-glass surface and off the
       dust on the front element, and lands as a broad radially-symmetric
       veil centred on the SOURCE, not on the bright pixels. It is present
       even where the sun itself is only a few pixels, it lies over the
       foreground (the scatter happens in front of the sensor), and it dies
       the instant something occludes the sun. The composite samples the
       scene's own radiance at the sun's screen position, sky-masked, so the
       term is driven by the real sun and is occluded by the real rig. */
    sunGlare: 0.90,
    sunGlareCap: 6.0,       // exposed-linear cap on the sampled sun radiance
    sunGlareBlades: 0.20,   // aperture diffraction streaks
    /* The widest lobe is a near-1/r^2 skirt that covers most of the frame at
       low amplitude. It is what LIFTS the shadows on the near side of a
       backlit subject — the thing whose absence made the sun read as painted
       onto the sky rather than sitting in front of the lens. */
    sunGlareSkirt: 0.11,

    /* ---- scotopic / mesopic response ------------------------------------
       Below roughly 0.03 cd/m2 the cones stop contributing: vision goes
       rod-only, which is desaturated and BLUE-shifted (Purkinje). That is
       why night photography reads cool even under a warm-white moon, and it
       is the single grade term that makes a night frame read as night rather
       than as an underexposed day.

       Two gates, and both are needed. The GLOBAL gate is sun elevation: rods
       take over below civil twilight and not before, and no amount of local
       dimness in a noon frame should turn a shadow blue. The LOCAL gate is
       the EXPOSED luminance, not the raw scene radiance — this engine
       compresses its whole day-to-night range into about 5 stops rather than
       the ~20 of the real world, so an absolute cd/m2-style threshold against
       the HDR contract simply never fires. Measured: the first attempt, gated
       on c/exposure at 0.012-0.32, moved the night frame's mean shadow B-R by
       0.02 code, i.e. nothing. Against the EXPOSED value the discrimination is
       the one that actually matters — the moonlit sea and sky sit at 0.02-0.05
       and go cool, the sodium windows and deck floods sit one to two decades
       higher and keep their colour. */
    scotopic: 0.55,
    scotopicLow: 0.03,      // exposed luminance where rods fully dominate
    scotopicHigh: 0.22,     // exposed luminance where cones fully take over
    scotopicSunHi: 0.02,    // sun elevation (sin) at which the term is off
    scotopicSunLo: -0.10,   // ... and at which it is fully engaged

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
    /* The curve was mistuned at BOTH ends simultaneously: a toe hardness of
       1.08 put -6 EV on code 12 and -10 EV on code 1.2 (an accelerating
       crush, 55% of the golden-hour frame under code 48, the teak sole at
       mean luma 7), while 0.220 raw slope and 3.42 stops of shoulder meant
       nothing in the frame ever bit — 0.005% of pixels clipped. Mushy mids,
       dead shadows, no highlight: a log curve pretending to be a print.

       Solved numerically, then the white point was swept live against the
       cockpit-golden frame until the measured clip rate landed inside the
       0.05-0.15% band a photograph actually has. What prints now:

         grey 0.18 -> code 107      contrast 0.390 code/stop through the mid
         -6 EV     -> code 23.6     -10 EV -> 2.74
         1.0 exposed -> 0.945       2.0 exposed -> 0.995
         white point 2.17 exposed   slopeAtWhite 0.042 (a real rolloff)
         measured at cockpit-golden: 0.056% of pixels clipped (was 0.005%),
         27% of the frame below code 48 (was 55%)

       HEADROOM. 3.59 stops over grey is not enough, and the frame proved it:
       42.8% of the mainsail measured R >= 253 with G ranging 177-245 and B
       ranging 50-245 while only 0.15% was actually white. That is a
       single-channel clip PLATEAU — the exact failure the bleach exists to
       prevent — and it happened because the curve put 1.0 exposed at 0.945
       and 2.0 exposed at 0.995, i.e. the entire 1.0-2.17 range was crushed
       into the top 5.5% of code space where the red channel simply ran out
       of room first.

       Re-solved (scratchpad/post_curve_tune.py) for 4.80 stops of headroom
       with the mid unchanged. What prints now:

         grey 0.18 -> code 105.8     contrast 0.307 code/stop through the mid
         -3 EV -> 47.8   -6 EV -> 24.7   -10 EV -> 2.9  (toe still open)
         0.5 exposed -> 0.778   1.0 -> 0.866   2.0 -> 0.932   3.0 -> 0.964
         white point 5.0 exposed    slopeAtWhite 0.047 (a real rolloff)

       So a 2-stop-over sail now has 90 code values of modulation left above
       it instead of 13, and the bleach below has an actual shoulder to
       complete across. */
    tmMinEV: -13.105,       // black point, absolute log2 of exposed radiance
    tmMaxEV: 2.3219,        // white point => 4.80 stops over middle grey
    tmPivot: -2.4739,       // log2(0.18)
    tmSlope: 0.3650,        // contrast through the pivot, per stop (raw)
    tmToe: 0.12,            // toe hardness (higher = shorter toe)
    tmShoulder: 0.18,
    tmGrey: 0.8900,         // encoded output at the pivot (pre-renormalise)
    tmSat: 1.12,            // AgX desaturates; put the tropics back
    /* ---- the NIGHT curve ------------------------------------------------
       A single curve cannot serve both ends of the day. The daylight curve's
       shadow domain runs 10.6 stops below the pivot and approaches black
       hyperbolically, which is right for a sunlit frame — a -6 EV shadow
       lands on code 25 and keeps its detail. Point the same curve at a
       metered-down anchorage and every one of those stops is spent on
       material that is already dark: 68% of the night frame ended up inside
       one 16-code bin because the whole scene was sitting on the flattest
       part of the toe, and the darkest pixel in the frame printed at 21 —
       a grey card, not a night.

       The night variant keeps the pivot, the white point and the shoulder
       identical (so the two blend across twilight with no jump in the
       highlights or in where middle grey prints) and changes only the shadow
       domain: 7.1 stops instead of 10.6, with the raw slope and grey
       re-solved to hold greyCode and contrast. What that buys is a real
       black point — -8 EV lands near zero instead of on 13 — and about 15%
       more contrast through the shadows, which is where a night frame's
       entire tonal range lives. Solved in scratchpad/post_curve_night.py.

       Blended by nightMix, so twilight interpolates rather than switching. */
    tmMinEVNight: -10.20,
    tmSlopeNight: 0.5250,
    tmGreyNight: 0.9050,
    tmToeNight: 0.12,
    /* Night wants MORE chroma, not less: the point of a night grade is that
       darkness reads as saturated blue-black rather than as desaturated
       grey. Blended in on the civil-twilight gate. */
    tmSatNight: 1.34,
    /* Shoulder chroma compression, applied in the encoded domain AFTER the
       curve. The linear bleach converges the channels; this finishes the job
       across the top third of the range so nothing arrives at white still
       carrying a hue. */
    shoulderDesat: 0.42,
    shoulderDesatLo: 0.68,

    /* ---- highlight bleach ----------------------------------------------
       Per-channel curves clip per-channel: a saturated over-range source pins
       its strongest primary and keeps modulating the other two, which skews
       the hue hard toward that primary and freezes all shading (the "plastic
       orange sail"). Film and a Bayer sensor do the opposite — as exposure
       climbs the channels CONVERGE, so an overexposed sunset sail bleaches
       toward pale yellow-white. This term drags chroma toward the per-pixel
       max as a function of that max, in linear HDR, before the curve.

       CALIBRATION NOTE: this term is only worth anything if it completes
       across the SHOULDER. It previously started at 0.80 with a range of
       2.40 while the white point sat at 0.847 — so by the time a channel
       clipped the convergence factor was 0.02 and the bleach did nothing at
       all. Start now sits just under half the white point and the range
       carries it to ~92% converged one stop past white.

       RE-ANCHORED, AND MOVED TO THE LOG DOMAIN. A linear start/range meant
       the convergence factor was a function of absolute radiance, so it did
       almost nothing over the first two stops of the shoulder and then
       slammed shut. Chroma has to attenuate GRADUALLY across the entire
       shoulder — that is what "hue-preserving desaturation" means. It now
       ramps over bleachStops stops of log2 radiance starting at bleachStart,
       which in normalised tone-map space puts the onset at about 0.58 of
       display range (the reviewer's 0.55-0.65) and completes ~0.8 stop past
       the 5.0 white point. */
    bleachStart: 0.20,      // exposed linear where convergence begins
    bleachStops: 4.90,      // stops of log2 radiance over which it completes
    bleachAmount: 0.96,

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
    localHighlight: 0.22,   // fraction of the local overexposure pulled back
    localClamp: 1.15,       // hard limit, natural log units (~1.66 stops)

    /* ---- SSAO -----------------------------------------------------------
       Ambient with no occlusion term is a flat added constant, and a flat
       added constant is why an unlit cockpit reads as painted rather than
       enclosed. Alchemy-style obscurance off the depth buffer, evaluated on
       the OPAQUE pass only (before the water is drawn) so waves never feed
       it, applied weighted toward the shadowed end of the frame.

       TWO RADII, not one. A single 1.55 m kernel capped at 0.055 uv is a
       huge, low-frequency term: on a bulkhead it painted a shapeless dark
       cloud with no identifiable occluder (which the eye reads as grime, not
       as shading) while the actual CONTACTS — the coiled rope on the teak,
       the base of the bucket — got nothing at all, so the props read as
       decals painted on the deck rather than objects resting on it.

       So: a tight 12 cm pass that draws the dark line where two surfaces
       meet, and a much weaker 55 cm pass for the room-scale obscurance. The
       screen-space caps are separate too — the wide one is clamped hard so
       it can never smear across the frame.

       THREE kernels now. The third is not an occlusion term at all, it is a
       SKY VISIBILITY term, and it exists because the cockpit's whole ambient
       comes from a single HemisphereLight with no occlusion of any kind: the
       deck under a solid canvas bimini measured the same value as open deck,
       which is the definition of flat lighting and the reason everything
       under the hardtop read as neutral plastic. A 0.55 m obscurance kernel
       cannot possibly see a roof 2 m overhead.

       So the third kernel runs at 3.2 m with a much larger screen-space cap,
       and — this is what makes ten taps enough — it weights each sample by
       how far ABOVE the receiver the occluder is (uUpV, world up in view
       space). Only overhead geometry blocks sky, so the estimator spends all
       of its samples on the question actually being asked. The result goes
       in the buffer's .g and the composite spends it on the INDIRECT term
       only, never on anything direct-lit. */
    ssao: true,
    ssaoRadius: 0.55,       // metres — WIDE pass
    ssaoIntensity: 0.62,
    ssaoMaxUV: 0.020,       // screen-space radius cap, wide pass
    ssaoContactRadius: 0.12,   // metres — CONTACT pass
    ssaoContactIntensity: 1.70,
    ssaoContactMaxUV: 0.038,
    ssaoPower: 1.30,
    ssaoBias: 0.40,
    ssaoAmount: 0.95,       // composite strength
    ssaoRange: 700.0,       // metres; also gates the packed normal buffer
    /* ---- sky visibility (room-scale, indirect only) --------------------- */
    ssaoSkyRadius: 3.60,    // metres: reaches a bimini, not the whole yacht
    ssaoSkyIntensity: 1.00,
    ssaoSkyMaxUV: 0.75,     // the roof is most of a screen away under a wide lens
    skyOcclusion: 1.00,     // composite strength on the indirect term
    skyOcclusionFloor: 0.08,   // darkest the indirect term may be driven
    skyOcclusionPower: 3.00,   // visibility -> irradiance ratio

    /* ---- screen-space directional ambient -------------------------------
       Golden hour is DEFINED by the split between a warm key and a cold
       fill. Every shadowed patch in this build resolved to the same
       warm-neutral ratio — bimini underside 33/23/18, cockpit side
       34.5/26.8/23.1, teak 10.9/6.0/4.2 — because the ambient was one
       constant with no direction in it. Night was worse: white gelcoat, open
       water, sky and an aluminium spar all landed within 3 codes of each
       other, 1.4 M of 2.25 M pixels inside a single 16-code bin, because
       there was no directional term at night AT ALL.

       The depth buffer already carries a surface normal (the AO pass derives
       one and now packs it into gba). That is enough to give the ambient a
       direction without touching a single material:

         skyAmt     cool sky-dome irradiance, weighted by normal-UP
         bounceAmt  warm water/ground bounce, weighted by normal-DOWN and by
                    the key azimuth (the sea is only a warm bounce source
                    where the sun is actually on it)
         keyAmt     a real directional key at night — moon elevation and
                    azimuth — applied as a value SPLIT about its own mean so
                    it darkens the away-facing side as much as it lifts the
                    lit one. That is what puts a terminator on a hull.

       All three are gated on how dim the pixel already is, so a sunlit
       topside or a lit window is not re-shaded. */
    dirAmbient: true,
    ambSky: 0.55,           // max cool tint fraction on up-facing shadow
    ambBounce: 0.42,        // max warm tint fraction on down-facing shadow
    ambNightKey: 1.25,      // night directional split, fraction about mean
    ambNightPivot: 0.32,    // NdotL at which the night key is neutral
    /* The gate is in EXPOSED linear, and this engine's shadows are DEEP in
       those units — the measured cockpit shadows sit around 0.003 exposed
       while 18% grey sits at 0.18 and a sunlit topside at 0.3+. A gate at
       1.15 therefore let the term run at 90% strength on direct-lit surfaces,
       which is re-lighting, not filling. */
    ambDimLo: 0.020,        // exposed luma where the terms are full strength
    ambDimHi: 0.280,        // ... and where they are off

    /* ---- night grade ----------------------------------------------------
       A cool multiply on the shadow end, blended in on the civil-twilight
       gate. Distinct from the scotopic term, which moves chroma toward a rod
       response at a fixed luminance: this one is the colourist's decision
       that night is blue-black, and it is what stops a metered-down night
       frame from reading as a grey card. Unit luminance, so it tints without
       changing exposure. */
    nightTint: 0.55,
    nightTintLo: 0.020,     // exposed luma where the tint is full strength
    nightTintHi: 0.450,     // ... and where it is off

    /* ---- SSR ------------------------------------------------------------
       An environment probe cannot reflect the boat's own deck lights, the
       shore windows, or a floodlit hull, so at night the water under a
       brilliantly lit vessel comes out statistically identical to open sea
       400 px away. Screen-space marching supplies exactly the term the probe
       is missing — LOCAL geometry — and it is added, never substituted, so
       the existing probe reflection stays intact. Fresnel-weighted, so it
       only really fires at the grazing angles where water is a mirror.

       RESOLVE. The half-res buffer was being consumed with a single bilinear
       tap and an isotropic 3x3 blur, which left the reflected harbour as a
       mosaic of ~10 px axis-aligned tiles at two or three discrete
       brightness levels — reading as JPEG corruption rather than as light on
       water. Two things fix that, and both are about matching the FILTER to
       the phenomenon:

         * a reflection on ripple is ANISOTROPIC. It elongates along the
           view-to-surface azimuth (screen-vertical for a level camera) and
           stays narrow across it, which is why a harbour light on water is a
           long broken column and not a disc. The buffer therefore gets a
           long depth-aware blur along that axis and a short one across it,
           instead of one square kernel.
         * the upsample to full res is BILATERAL, weighted by the full-res
           depth, so the reflection follows the wave surface instead of
           carrying the half-res grid with it. */
    ssr: true,
    ssrStrength: 0.75,
    ssrJitter: 0.075,       // wave-driven horizontal break-up of the column
    ssrThickness: 1.20,
    ssrMaxDist: 260.0,
    ssrBlur: 1.15,          // ACROSS the stretch axis (short)
    ssrStretch: 4.20,       // ALONG the stretch axis (long)
    ssrEmitGate: 1.30,      // keep only hits brighter than surface * this
    /* The march is a stochastic single-sample estimator with no temporal
       accumulation, so every pixel it touches carries its own noise. On open
       sea past ~100 m it has nothing local left to reflect and was
       contributing pure per-pixel jitter — measured at 92% of the far-field
       1-px energy at 2-12 km. Fade the whole term out over this range and
       the far field goes quiet without losing the near-boat mirror column,
       which is the only thing the pass exists for. */
    ssrFadeStart: 90.0,
    ssrFadeEnd: 240.0,

    chroma: 0.0016,
    vignette: 0.26,
    grain: 0.013,
    dither: 1.0,

    godrays: true,
    godrayStrength: 0.30,
    godrayDecay: 0.974,     // longer shafts
    godrayDensity: 0.95,
    godrayFall: 2.6,        // sun-proximity falloff of the shaft SOURCE; the
                            // old 5.5 confined crepuscular rays to a 0.4 uv
                            // disc, which reads as a blob rather than as light

    /* ---- depth of field -------------------------------------------------
       This was pointed the wrong way. dofStart 110 / dofRange 500 blurs
       EVERYTHING past 110 m — the island, the horizon, the cloud deck and,
       at night, the stars, all of which sit at or beyond the far plane. No
       marine photograph looks like that: a wide lens focused for a cockpit
       shot is hyperfocal well inside 110 m and infinity is sharp. What is
       left here is an honest long-distance term (atmospheric turbulence at
       multiple kilometres) at sub-pixel strength, and the sky is excluded
       outright so stars and cloud edges stay crisp. */
    dof: true,
    dofStart: 1500.0,       // metres — nothing nearer is ever blurred
    dofRange: 12000.0,
    dofMaxRadius: 0.95,     // pixels at the internal resolution

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
  let mFill, mMRT, mBright, mDown13, mUpRing, mAvg36, mLumFirst, mLumDown, mAdapt;
  let mGRPre, mGRBlur, mComposite, mFxaaHigh, mFxaaLow, mNoAA;
  let mSSAO, mSSR, mBlurD, mBlurA;
  let dirtTexture = null;
  let blackTex = null, whiteTex = null;

  let renderScale = 1.25;
  let bloomLevels = 6;
  let lastNightMix = 0;
  let lastQuality = null;
  let frameSeed = 0;
  let elapsed = 0;

  const _sunWorld = T ? new T.Vector3() : null;
  const _sunNDC = T ? new T.Vector3() : null;
  const _camDir = T ? new T.Vector3() : null;
  const _camPos = T ? new T.Vector3() : null;
  const _sunColor = T ? new T.Color(1, 1, 1) : null;
  const _upView = T ? new T.Vector3() : null;
  const _keyDirW = T ? new T.Vector3(0, 1, 0) : null;
  const _keyDirV = T ? new T.Vector3(0, 1, 0) : null;

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  /* Normalise a colour to unit LUMINANCE after an optional saturation push,
     so using it as a tint changes chroma without changing exposure. Falls
     back to the supplied neutral whenever the source is missing or black. */
  function unitTint(out, src, sat, fr, fg, fb) {
    let r = (src && isNum(src.r)) ? src.r : fr;
    let g = (src && isNum(src.g)) ? src.g : fg;
    let b = (src && isNum(src.b)) ? src.b : fb;
    let l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (!(l > 1e-6)) { r = fr; g = fg; b = fb; l = 0.2126 * r + 0.7152 * g + 0.0722 * b; }
    r = l + (r - l) * sat; g = l + (g - l) * sat; b = l + (b - l) * sat;
    l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (!(l > 1e-6)) { out.set(1, 1, 1); return out; }
    out.set(clamp(r / l, 0.05, 4.0), clamp(g / l, 0.05, 4.0), clamp(b / l, 0.05, 4.0));
    return out;
  }

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

  /* ---- F2b : SSAO. Alchemy obscurance, radius in METRES projected to
     screen so the falloff is world-correct.

     TWO kernels evaluated in the same pass off the same normal:

       CONTACT  ~12 cm, 10 taps. This is the term that grounds an object.
                A rope lying on the teak, the foot of a bucket, the join
                where a coaming meets the sole — all of them need a tight
                dark LINE two to four pixels wide, and a metre-scale kernel
                cannot draw one at any intensity.
       WIDE     ~55 cm, 10 taps, weak. Room-scale obscurance only, capped
                hard in screen space (uMaxUV.y) so it can never smear into
                the shapeless dark cloud that reads as grime.

     The pass also PACKS the view normal it already computed into gba. The
     composite needs it for the directional ambient term — deriving it twice
     would be two more dependent depth fetches per pixel at full res, and
     this buffer is already blurred depth-aware, which is exactly the
     filtering a normal wants. Sky pixels write 0.5 (i.e. a zero vector),
     which is the composite's validity test. ------------------------------ */
  /* Octahedral normal packing. Two 8-bit channels instead of three, which
     frees .g for the sky-visibility term. Angular error at 8 bits per
     component is well under a degree — far below what a low-frequency
     ambient term can resolve — and unlike a raw xyz packing it stays
     well-conditioned when the depth-aware blur averages neighbours. */
  const OCTAHEDRAL = [
    'vec2 octEnc(vec3 n){',
    '  float l = abs(n.x) + abs(n.y) + abs(n.z);',
    '  if(l < 1.0e-6) return vec2(0.5);',
    '  n /= l;',
    '  vec2 e = n.xy;',
    '  if(n.z < 0.0){',
    '    e = (1.0 - abs(n.yx)) * vec2(n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0);',
    '  }',
    '  return e * 0.5 + 0.5;',
    '}',
    'vec3 octDec(vec2 f){',
    '  vec2 e = f * 2.0 - 1.0;',
    '  vec3 n = vec3(e.x, e.y, 1.0 - abs(e.x) - abs(e.y));',
    '  float t = max(-n.z, 0.0);',
    '  n.x += (n.x >= 0.0) ? -t : t;',
    '  n.y += (n.y >= 0.0) ? -t : t;',
    '  float ln = length(n);',
    '  return (ln > 1.0e-9) ? (n / ln) : vec3(0.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  const FS_SSAO = [
    'precision highp float;',
    'varying vec2 vUv;',
    'uniform sampler2D uDepth;',
    'uniform vec2 uTexel;',
    'uniform vec4 uAOCfg;',      // wideRadius, wideIntensity, power, bias
    'uniform vec2 uAOContact;',  // contactRadius, contactIntensity
    'uniform vec3 uMaxUV;',      // contactMaxUV, wideMaxUV, skyMaxUV
    'uniform vec2 uAOSky;',      // skyRadius, skyIntensity
    'uniform vec3 uUpV;',        // world up, VIEW space
    'uniform float uSeed;',
    /* Range gate, in metres. The sky DOME is opaque geometry a few thousand
       metres out, so "is this pixel the far plane" is not a sky test at all —
       without this the dome supplies a normal for every sea pixel drawn over
       it later, and the composite then re-tints the whole ocean with the
       cockpit's ambient. Nothing past a few hundred metres has any use for a
       contact term or a bounce term anyway; aerial perspective owns that
       range. */
    'uniform float uRange;',
    LINDEPTH,
    VIEWREC,
    HASH,
    OCTAHEDRAL,
    'float dz(vec2 uv){ return linZ(texture2D(uDepth, uv).r); }',
    DEPTHNORMAL,
    'void main(){',
    '  float ao = 1.0;',
    '  float skyVis = 1.0;',
    '  vec2 nPack = vec2(0.5);',
    '  float conf = 0.0;',
    '  float z0 = dz(vUv);',
    '  float skyZ = min(uCamNF.y * 0.80, uRange);',
    '  if(z0 > 0.0 && z0 < skyZ){',
    '    vec3 p0 = viewPosAt(vUv, z0);',
    '    vec3 n = depthNormal(vUv, z0, p0, uTexel);',
    // fade the term out over the last 20% of the range so the ambient does
    // not switch off along a hard depth contour
    '    conf = 1.0 - smoothstep(skyZ * 0.80, skyZ, z0);',
    '    nPack = octEnc(n);',
    '    vec2 invP = 1.0 / (uProjScale * max(z0, 0.05));',
    '    vec2 radC = min(vec2(0.5 * uAOContact.x) * invP, vec2(uMaxUV.x));',
    '    vec2 radW = min(vec2(0.5 * uAOCfg.x) * invP, vec2(uMaxUV.y));',
    '    float ang = hash12(gl_FragCoord.xy + uSeed) * 6.2831853;',
    '    float bias = uAOCfg.w * z0 * 0.004;',
    '    float occC = 0.0, occW = 0.0;',
    '    for(int i = 0; i < 10; i++){',
    '      float fi = (float(i) + 0.5) / 10.0;',
    '      float sq = sqrt(fi);',
    '      float a = ang + float(i) * 2.39996323;',
    '      vec2 dir = vec2(cos(a), sin(a)) * sq;',
    // contact kernel
    '      vec2 uc = clamp(vUv + dir * radC, vec2(0.0), vec2(1.0));',
    '      float zc = dz(uc);',
    '      if(zc < skyZ){',
    '        vec3 v = viewPosAt(uc, zc) - p0;',
    '        float vv = dot(v, v);',
    '        occC += max(dot(v, n) - bias, 0.0) / (vv + 0.0035);',
    '      }',
    // wide kernel, rotated half a step so the two do not share directions
    '      vec2 uw = clamp(vUv + vec2(cos(a + 1.2), sin(a + 1.2)) * sq * radW,',
    '                      vec2(0.0), vec2(1.0));',
    '      float zw = dz(uw);',
    '      if(zw < skyZ){',
    '        vec3 v = viewPosAt(uw, zw) - p0;',
    '        float vv = dot(v, v);',
    '        occW += max(dot(v, n) - bias, 0.0) / (vv + 0.045);',
    '      }',
    '    }',
    '    occC *= (2.0 * uAOContact.y * uAOContact.x) / 10.0;',
    '    occW *= (2.0 * uAOCfg.y * uAOCfg.x) / 10.0;',
    '    float aoC = clamp(1.0 - occC, 0.0, 1.0);',
    '    float aoW = clamp(1.0 - occW, 0.0, 1.0);',
    '    ao = pow(aoC, uAOCfg.z) * pow(aoW, uAOCfg.z * 0.75);',
    /* ---- SKY VISIBILITY --------------------------------------------------
       Not a disc kernel. A disc kernel cannot answer this question: from a
       cockpit sole under a 60-degree lens the bimini two metres overhead
       sits most of a SCREEN away, so any obscurance radius small enough to
       be well-conditioned never reaches it — measured, a 3.2 m disc kernel
       moved the sole by 1 code out of 51.

       So this is a horizon search along ONE direction: world up, projected
       into screen space at this pixel (exactly, via the same viewToUV the
       SSR march uses, so perspective and camera roll are handled). Three
       rays in a narrow fan, five steps each, and what is measured is the
       highest ELEVATION any occluder within uAOSky.x metres subtends above
       the receiver. A canvas roof directly overhead subtends ~90 degrees and
       takes essentially the whole sky; a stanchion subtends ten degrees and
       takes almost none. Fifteen directed taps beat forty undirected ones
       because every one of them is spent on the question being asked. */
    '    vec3 pUp = p0 + uUpV * uAOSky.x;',
    '    if(-pUp.z > uCamNF.x * 2.0){',
    '      vec2 dUp = viewToUV(pUp) - vUv;',
    '      float lUp = length(dUp);',
    '      if(lUp > 1.0e-5){',
    '        vec2 dirS = dUp / lUp;',
    '        float march = min(lUp, uMaxUV.z);',
    '        float jit = 0.55 + 0.45 * hash12(gl_FragCoord.yx * 1.7 + uSeed);',
    '        float horiz = 0.0;',
    '        for(int rIdx = 0; rIdx < 3; rIdx++){',
    '          float fa = (float(rIdx) - 1.0) * 0.38;',
    '          float cf = cos(fa), sf = sin(fa);',
    '          vec2 rd = vec2(dirS.x * cf - dirS.y * sf, dirS.x * sf + dirS.y * cf);',
    '          float hbest = 0.0;',
    '          for(int k = 1; k <= 5; k++){',
    '            float t = pow(float(k) / 5.0, 1.35) * jit;',
    '            vec2 su = vUv + rd * (t * march);',
    '            if(su.x < 0.0 || su.x > 1.0 || su.y < 0.0 || su.y > 1.0) break;',
    '            float zs2 = dz(su);',
    '            if(zs2 >= skyZ) continue;',
    '            vec3 v = viewPosAt(su, zs2) - p0;',
    '            float lv = length(v);',
    '            if(lv < 0.04 || lv > uAOSky.x) continue;',
    '            float sinE = dot(v, uUpV) / lv;',
    // an occluder only counts if it is above the receiver's own tangent plane
    '            if(dot(v, n) <= bias) continue;',
    '            hbest = max(hbest, max(sinE, 0.0) * (1.0 - lv / uAOSky.x));',
    '          }',
    '          horiz += hbest;',
    '        }',
    '        skyVis = clamp(1.0 - uAOSky.y * (horiz / 3.0), 0.0, 1.0);',
    '        skyVis = mix(1.0, skyVis, conf);',
    '      }',
    '    }',
    '  }',
    /* .r occlusion  .g sky visibility  .ba octahedral view normal. The
       composite recovers "is there geometry here at all" from the full-res
       depth buffer it already samples, so no channel is spent on validity. */
    '  gl_FragColor = vec4(ao, skyVis, nPack);',
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

  /* ---- directional depth-aware blur ------------------------------------
     Nine taps along an arbitrary screen-space axis with a Gaussian profile
     and a depth-similarity weight. Run twice with perpendicular axes and
     different spreads it is an ANISOTROPIC filter, which is what a
     reflection on rippled water actually needs: long along the view-to-
     surface azimuth, short across it. One square kernel cannot express that,
     and a square kernel over a half-res stochastic buffer is precisely how
     the reflected harbour ended up as a mosaic of axis-aligned tiles. */
  const FS_BLURA = [
    'precision highp float;',
    'varying vec2 vUv;',
    'uniform sampler2D uTex;',
    'uniform sampler2D uDepth;',
    'uniform vec2 uTexel;',
    'uniform vec2 uDir;',
    'uniform float uSpread;',
    LINDEPTH,
    'void main(){',
    '  float z0 = linZ(texture2D(uDepth, vUv).r);',
    '  vec2 step1 = uDir * uTexel * uSpread;',
    '  vec4 sum = texture2D(uTex, vUv) * 0.20;',
    '  float wsum = 0.20;',
    '  for(int i = 1; i <= 4; i++){',
    '    float fi = float(i);',
    '    float g = exp(-fi * fi * 0.16);',
    '    vec2 o = step1 * fi;',
    '    vec2 ua = vUv + o;',
    '    vec2 ub = vUv - o;',
    '    float za = linZ(texture2D(uDepth, ua).r);',
    '    float zb = linZ(texture2D(uDepth, ub).r);',
    '    float wa = g * exp(-abs(za - z0) / max(0.06 * z0, 0.06));',
    '    float wb = g * exp(-abs(zb - z0) / max(0.06 * z0, 0.06));',
    '    sum += texture2D(uTex, ua) * wa + texture2D(uTex, ub) * wb;',
    '    wsum += wa + wb;',
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
    'uniform vec2 uZFade;',      // start, end distance of the whole-term fade
    LINDEPTH,
    VIEWREC,
    HASH,
    SANITIZE,
    'float dz(vec2 uv){ return linZ(texture2D(uDepth, uv).r); }',
    DEPTHNORMAL,
    /* Screen-boundary confidence. A screen-space march has no data outside
       the framebuffer, so a reflection column that reaches the edge of frame
       terminates on a dead straight line — which is unambiguous evidence to
       the viewer that the reflection is being read from the framebuffer and
       not from the world. Fade the term's CONFIDENCE over the outer 12% of
       uv in both axes (and asymmetrically in y, because a reflection ray on
       water travels downward in screen space and therefore runs out of data
       at the bottom edge long before the top). Where confidence drops the
       surface simply keeps the probe/analytic term it already had, so the
       transition is invisible rather than a line. */
    'float borderFade(vec2 uv){',
    '  vec2 e = smoothstep(vec2(0.0), vec2(0.12), uv)',
    '         * smoothstep(vec2(0.0), vec2(0.12), vec2(1.0) - uv);',
    '  return e.x * e.y;',
    '}',
    'void main(){',
    '  vec3 outc = vec3(0.0);',
    '  float skyZ = uCamNF.y * 0.65;',
    '  float z0 = dz(vUv);',
    '  float edgeConf = borderFade(vUv);',
    /* Distance gate. Beyond a couple of hundred metres there is no local
       emitter left to reflect, only the noise of a one-sample march. */
    '  float zFade = 1.0 - smoothstep(uZFade.x, uZFade.y, z0);',
    '  if(z0 > 0.0 && z0 < skyZ && zFade > 0.004){',
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
    '            hitW = borderFade(fuv);',
    '            hitW *= 1.0 - smoothstep(uSSRCfg.w * 0.5, uSSRCfg.w, travelled);',
    '            break;',
    '          }',
    '          st *= 1.235;',
    '        }',
    '        outc = hitCol * hitW * F * uSSRCfg.x * zFade * edgeConf',
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

  /* ---- F8 : rotated dual-ring upsample, ADDITIVE into the finer mip -----
     THE square-halo fix. A 3x3 tent samples on a Cartesian lattice; at the
     coarse end of the chain one source texel magnifies to tens of screen
     pixels, so those nine taps ARE the halo and the halo is a box. Thirteen
     taps on two concentric hexagonal rings 30 degrees apart approximate a
     disc, and rotating the whole kernel by a golden angle per level means no
     two levels of the chain share a sampling axis — so the accumulated
     point-spread function converges on something radially symmetric instead
     of on an axis-aligned square with a bright dot in it. */
  const FS_UPRING = [
    'precision highp float;',
    'varying vec2 vUv;',
    'uniform sampler2D uTex;',
    'uniform vec2 uSrcTexel;',
    'uniform float uRadius;',
    'uniform float uScale;',
    'uniform float uRot;',
    'vec3 tap(vec2 uv){ return texture2D(uTex, uv).rgb; }',
    'void main(){',
    '  float cs = cos(uRot), sn = sin(uRot);',
    '  mat2 R = mat2(cs, sn, -sn, cs);',
    '  vec2 o = uSrcTexel * uRadius;',
    // inner ring, radius 0.62
    '  vec3 s = tap(vUv) * 0.24;',
    '  const float H = 0.8660254;',
    '  vec2 r0 = R * vec2( 1.0,  0.0);',
    '  vec2 r1 = R * vec2( 0.5,  H);',
    '  vec2 r2 = R * vec2(-0.5,  H);',
    '  vec2 r3 = R * vec2(-1.0,  0.0);',
    '  vec2 r4 = R * vec2(-0.5, -H);',
    '  vec2 r5 = R * vec2( 0.5, -H);',
    '  float wa = 0.076;',
    '  s += tap(vUv + r0 * o * 0.62) * wa;',
    '  s += tap(vUv + r1 * o * 0.62) * wa;',
    '  s += tap(vUv + r2 * o * 0.62) * wa;',
    '  s += tap(vUv + r3 * o * 0.62) * wa;',
    '  s += tap(vUv + r4 * o * 0.62) * wa;',
    '  s += tap(vUv + r5 * o * 0.62) * wa;',
    // outer ring, radius 1.30, offset 30 degrees
    '  vec2 q0 = R * vec2( H,  0.5);',
    '  vec2 q1 = R * vec2( 0.0,  1.0);',
    '  vec2 q2 = R * vec2(-H,  0.5);',
    '  vec2 q3 = R * vec2(-H, -0.5);',
    '  vec2 q4 = R * vec2( 0.0, -1.0);',
    '  vec2 q5 = R * vec2( H, -0.5);',
    '  float wb = 0.0507;',
    '  s += tap(vUv + q0 * o * 1.30) * wb;',
    '  s += tap(vUv + q1 * o * 1.30) * wb;',
    '  s += tap(vUv + q2 * o * 1.30) * wb;',
    '  s += tap(vUv + q3 * o * 1.30) * wb;',
    '  s += tap(vUv + q4 * o * 1.30) * wb;',
    '  s += tap(vUv + q5 * o * 1.30) * wb;',
    '  s *= uScale;',
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
    'uniform float uFall;',
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
    '  float fall = exp(-dot(q, q) * uFall);',
    '  vec3 hue = c / max(l, 1.0e-4);',
    '  gl_FragColor = vec4(hue * b * sky * fall * uMask, 1.0);',
    '}'
  ].join('\n');

  /* Radial march. The start offset is dithered per pixel with an interleaved
     gradient sequence: twelve equal steps toward a point source otherwise
     lay down twelve concentric ghost rings of whatever occluder they cross,
     and rings are the tell that this is a filter rather than light. */
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
    '  float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));',
    '  vec2 uv = vUv - delta * ign;',
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
    'uniform vec4 uBleach;',   // log2(start), 1/stops, amount, unused
    'vec3 bleachHighlights(vec3 c){',
    '  if(uBleach.z <= 0.0) return c;',
    '  float m = max(c.r, max(c.g, c.b));',
    '  if(m <= 1.0e-6) return c;',
    /* LOG domain. Chroma has to attenuate as a smooth function of EXPOSURE,
       not of absolute radiance — a linear ramp does nothing over the first
       two stops of a five-stop shoulder and then slams shut, which is how a
       sail ends up with R pinned flat while G and B keep modulating under
       it. Over ~4.9 stops the convergence is monotone and gentle, so the
       three channels reach the shoulder together and an over-range saturated
       source bleaches toward paper white with its shading intact. */
    '  float t = clamp((log2(m) - uBleach.x) * uBleach.y, 0.0, 1.0);',
    '  t = t * t * (3.0 - 2.0 * t);',
    '  return mix(c, vec3(m), t * uBleach.z);',
    '}',
    /* Shoulder chroma compression, in the ENCODED domain. The linear bleach
       above converges the radiance; this finishes the job on whatever chroma
       survives the curve, so nothing arrives at 1.0 still carrying a hue.
       Gated on the per-pixel MAX rather than on luma, because it is the
       channel that is about to clip that has to be caught. */
    'uniform vec2 uShoulderDesat;',   // amount, onset
    'vec3 shoulderDesat(vec3 v){',
    '  if(uShoulderDesat.x <= 0.0) return v;',
    '  float m = max(v.r, max(v.g, v.b));',
    '  float t = smoothstep(uShoulderDesat.y, 1.0, m);',
    '  float lu = dot(v, vec3(0.2126, 0.7152, 0.0722));',
    '  return mix(v, vec3(lu) + (v - vec3(lu)) * (1.0 - uShoulderDesat.x), t);',
    '}',
    'vec3 filmic(vec3 c){',
    '  c = AGX_IN * max(bleachHighlights(max(c, vec3(0.0))), vec3(0.0));',
    '  vec3 lg = log2(max(c, vec3(1.0e-10)));',
    '  vec3 v = toneCurve(lg);',
    '  float lu = dot(v, vec3(0.2126, 0.7152, 0.0722));',
    '  v = clamp(vec3(lu) + (v - vec3(lu)) * uTmB.w, 0.0, 1.0);',
    '  v = shoulderDesat(v);',
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
    'uniform vec2 uGlareTexel;',
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
    'uniform vec2 uSSRTexel;',
    'uniform float uAOAmt;',
    'uniform float uSSRAmt;',
    'uniform float uBloomWrap;',
    'uniform vec2 uBloomTexel;',
    'uniform vec4 uSkyOcc;',     // amount, floor, ambient range (m), power
    /* The AO/normal/sky-visibility buffer is built from the OPAQUE depth,
       before the sea is drawn. Validating it against the post-water depth
       would hand every wave pixel the normal of whatever opaque geometry
       happens to be behind it, so the composite keeps a handle on the opaque
       depth specifically. uOpaqueLin marks whether that texture already
       carries metres (the F3 MRT copy) or raw hardware depth. */
    'uniform sampler2D uOpaqueDepth;',
    'uniform float uOpaqueLin;',
    'uniform vec4 uNightGrade;', // amount, loLuma, hiLuma, unused
    'uniform vec3 uNightTint;',  // cool shadow chroma, unit luminance
    'uniform float uSunSkirt;',
    'uniform vec4 uLocalCfg;',   // shadowAmt, highlightAmt, clamp, enable
    'uniform vec2 uSunUV;',
    'uniform vec4 uSunGlare;',   // amount*visibility, radiance cap, blades, unused
    'uniform vec3 uScotopic;',   // amount, lowRadiance, highRadiance
    'uniform vec4 uAmbCfg;',     // skyAmt, bounceAmt, nightKeyAmt, enable
    'uniform vec2 uAmbDim;',     // dim gate: full-strength luma, off luma
    'uniform vec3 uAmbSkyTint;', // cool sky-dome chroma, unit luminance
    'uniform vec3 uAmbBncTint;', // warm water/ground bounce, unit luminance
    'uniform vec3 uKeyDirV;',    // night key (moon) direction, VIEW space
    'uniform float uKeyPivot;',  // NdotL at which the night key is neutral
    'uniform mat3 uNrmToWorld;', // view -> world rotation for the up term
    SANITIZE,
    LINDEPTH,
    HASH,
    OCTAHEDRAL,
    EXPOSURE,
    TONECURVE,
    'vec3 fetch(vec2 uv){ return sane(texture2D(uHDR, uv).rgb); }',
    'float depthAt(vec2 uv){ return linZ(texture2D(uDepthTex, uv).r); }',
    'float opaqueDepthAt(vec2 uv){',
    '  float r = texture2D(uOpaqueDepth, uv).r;',
    '  return (uOpaqueLin > 0.5) ? r : linZ(r);',
    '}',
    /* BILATERAL upsample of the half-res reflection buffer. A single bilinear
       tap carries the half-res grid straight into the final image, which is
       why the reflected town read as ~10 px axis-aligned tiles that did not
       follow the water at all. Four taps weighted by the FULL-res depth make
       the reflection track the wave surface it is sitting on. */
    'vec3 ssrUp(vec2 uv, float z0){',
    '  vec2 t = uSSRTexel;',
    '  vec3 acc = vec3(0.0);',
    '  float wsum = 0.0;',
    '  for(int y = 0; y < 2; y++){',
    '    for(int x = 0; x < 2; x++){',
    '      vec2 su = uv + (vec2(float(x), float(y)) - 0.5) * t;',
    '      float zs = depthAt(su);',
    '      float w = exp(-abs(zs - z0) / max(0.05 * z0, 0.05));',
    '      acc += sane(texture2D(uSSR, su).rgb) * w;',
    '      wsum += w;',
    '    }',
    '  }',
    '  return acc / max(wsum, 1.0e-4);',
    '}',
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
    /* Sun-radiance probe. Five taps on a small disc at the sun's screen
       position, each accepted only if it is SKY — so a spreader, the boom or
       the mainsail passing across the sun kills the glare the way it kills
       the real thing, and the term needs no separate occlusion query. */
    '#define SUNTAP(ox, oy) { vec2 su = clamp(uSunUV + vec2((ox) / uAspect, oy), vec2(0.002), vec2(0.998)); float m = step(uCamNF.y * 0.90, depthAt(su)); sunRad += fetch(su) * m; sunVis += m; }',
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
    // sky sits ON the far plane: an infinity-focused lens renders it sharp,
    // and blurring it is what erased the star field in the night preset
    '    float coc = clamp((z - uDofStart) / max(uDofRange, 1.0), 0.0, 1.0)',
    '              * (1.0 - step(uCamNF.y * 0.85, z));',
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
    '  float zHere = depthAt(uv);',
    '  if(uSSRAmt > 0.0) c += ssrUp(uv, zHere) * uSSRAmt;',
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
    '  vec4 aoSample = texture2D(uAO, uv);',
    '  if(uAOAmt > 0.0){',
    '    float ao = clamp(aoSample.r, 0.0, 1.0);',
    '    float lc = dot(c, vec3(0.2126, 0.7152, 0.0722));',
    '    float shadow = 1.0 - smoothstep(0.20, 1.40, lc);',
    /* The wide term still belongs mostly in the dim end of the frame, but
       the CONTACT term is baked into the same channel and a contact line is
       real occlusion regardless of how bright the surface is — a rope on a
       sunlit deck still has a dark line under it. Hence a much higher floor
       than the 0.28 this used to carry. */
    '    c *= mix(1.0, ao, uAOAmt * (0.52 + 0.48 * shadow));',
    '  }',
    /* (b4) directional ambient. The AO pass packed its view normal into gba;
       a zero vector there means "no geometry" (sky) and the term is skipped.
       Three components, all gated on how dim the pixel already is so nothing
       direct-lit is re-shaded:
         - a cool sky-dome irradiance weighted by normal-UP,
         - a warm bounce weighted by normal-DOWN (the sea and the deck), and
         - at night, a real directional key from the moon, applied as a
           multiplicative SPLIT about uKeyPivot so the away-facing side goes
           down as far as the lit side comes up. A hull with a top, a side
           and a terminator is the whole difference between a silhouette and
           a grey blob. */
    '  if(uAmbCfg.w > 0.5){',
    '    vec3 nv = octDec(aoSample.ba);',
    // validity comes from the depth buffer the composite already samples:
    // sky and anything past the AO pass's range simply has no ambient term
    '    float zOpq = opaqueDepthAt(uv);',
    '    float conf = 1.0 - smoothstep(uSkyOcc.z * 0.80, uSkyOcc.z, zOpq);',
    '    conf *= step(0.0001, zOpq);',
    '    if(conf > 0.01){',
    '      vec3 nw = uNrmToWorld * nv;',
    '      float lc = dot(c, vec3(0.2126, 0.7152, 0.0722));',
    '      float dim = conf * (1.0 - smoothstep(uAmbDim.x, uAmbDim.y, lc));',
    '      if(dim > 0.004){',
    '        float wu = clamp(nw.y, 0.0, 1.0);',
    '        float wd = clamp(-nw.y, 0.0, 1.0);',
    // a vertical face still sees half the dome; a horizontal one sees all of
    // it. sqrt keeps the split from collapsing on the bulkheads.
    '        wu = sqrt(wu) * 0.72 + 0.28 * (1.0 - abs(nw.y));',
    /* SKY OCCLUSION on the INDIRECT term. This is the whole answer to "the
       deck under a solid canvas bimini measures the same as open deck". The
       hemisphere light in the scene has no occlusion of any kind, so an
       enclosed cockpit is lit exactly as brightly as open sky and everything
       under the hardtop reads as flat neutral plastic. skyV comes from the
       3.2 m up-weighted kernel in the AO pass; it multiplies the ambient and
       it also scales the sky-dome CHROMA, because a surface that cannot see
       the sky has no business taking the sky's colour. Floored so it darkens
       rather than blackens, and gated on the same dim term as everything
       else here so nothing direct-lit is touched. */
    /* The estimator returns a linear visibility fraction, but the value it
       has to move sits five stops under middle grey where the tone curve's
       toe prints barely a code per third of a stop — so a physically honest
       0.69 visibility moved a covered sole by ONE code out of 48, which is
       exactly the "reads the same as open deck" failure it was meant to fix.
       The power turns visibility into the irradiance ratio a covered cockpit
       actually has (a surface seeing two thirds of the dome under a canvas
       roof also loses most of its sky BOUNCE, which the estimator cannot
       see), and lands the difference at about a stop — a real interior /
       exterior split rather than a rounding error. */
    '        float skyV = pow(clamp(aoSample.g, 0.0, 1.0), max(uSkyOcc.w, 0.05));',
    // weighted by the SAME up-facing term the dome tint uses: a surface that
    // faces the deck was never taking sky irradiance, so occluding its sky is
    // not a second darkening it has any claim to
    '        float sOcc = mix(1.0, uSkyOcc.y + (1.0 - uSkyOcc.y) * skyV,',
    '                         uSkyOcc.x * dim * clamp(wu / 0.72, 0.0, 1.0));',
    '        c *= sOcc;',
    '        vec3 tint = mix(vec3(1.0), uAmbSkyTint,',
    '                        clamp(wu, 0.0, 1.0) * uAmbCfg.x * dim * skyV);',
    '        tint *= mix(vec3(1.0), uAmbBncTint, wd * uAmbCfg.y * dim);',
    '        c *= tint;',
    '        if(uAmbCfg.z > 0.0){',
    '          float ndl = max(dot(nv, uKeyDirV), 0.0);',
    '          float split = 1.0 + uAmbCfg.z * dim * (ndl - uKeyPivot);',
    '          c *= max(split, 0.10);',
    '        }',
    '      }',
    '    }',
    '  }',
    // (c) wide mip-chain bloom (already exposure-scaled) + dirty-glass veiling
    '  vec3 bl = texture2D(uBloom, uv).rgb;',
    '  float lz = dot(bl, vec3(0.3333333));',
    '  if(!(lz < 1.0e5)) bl = vec3(0.0);',
    /* LIGHT WRAP. Dilate the bloom mask by a couple of pixels before adding
       it, so a bright background bleeds OVER thin dark foreground geometry.
       That is the term that stops a shroud, a backstay or a lifeline
       crossing a near-sun sky from resolving as a 2 px aliased dark wire —
       real glass scatters light around a thin occluder, it does not stencil
       it. Max rather than blur, because the point is to grow the bright
       region, not to soften it. */
    '  if(uBloomWrap > 0.0){',
    // in BLOOM texels, not screen texels: mip0 is half resolution and already
    // smooth at the screen-pixel scale, so a one-screen-pixel dilation of it
    // is a no-op. Measured: at 2.2 screen texels the wrap changed the frame by
    // 0.2 code. It has to be several bloom texels wide to reach past a shroud.
    '    vec2 wt = uBloomTexel * 2.6;',
    '    vec3 mx = bl;',
    '    mx = max(mx, texture2D(uBloom, uv + vec2( wt.x, 0.0)).rgb);',
    '    mx = max(mx, texture2D(uBloom, uv + vec2(-wt.x, 0.0)).rgb);',
    '    mx = max(mx, texture2D(uBloom, uv + vec2(0.0,  wt.y)).rgb);',
    '    mx = max(mx, texture2D(uBloom, uv + vec2(0.0, -wt.y)).rgb);',
    '    mx = max(mx, texture2D(uBloom, uv + wt * 0.72).rgb);',
    '    mx = max(mx, texture2D(uBloom, uv - wt * 0.72).rgb);',
    '    mx = max(mx, texture2D(uBloom, uv + vec2(wt.x, -wt.y) * 0.72).rgb);',
    '    mx = max(mx, texture2D(uBloom, uv + vec2(-wt.x, wt.y) * 0.72).rgb);',
    '    float lw = dot(mx, vec3(0.3333333));',
    '    if(!(lw < 1.0e5)) mx = bl;',
    '    mx = max(mx, bl);',
    '    bl = mix(bl, mx, uBloomWrap);',
    /* The dilation alone is nearly a no-op, because the bloom is already
       smooth at this scale — a 2 px shroud does not dent a low-pass of the
       frame, so max() finds nothing. What actually eats a thin dark object
       is that the scatter happens in FRONT of the sensor: it adds a fixed
       radiance to a pixel that has almost none, so relative to itself a
       shroud against a 3-stop-over sky receives far more veiling than the
       sky beside it does.

       The discriminator has to be LOCAL, though. Keying it on "this pixel is
       dark and the bloom here is bright" fires across every dark area near a
       bright one — at night that turned the whole harbour into blown white
       blobs. So the surround is measured from the scene itself, four taps at
       about five pixels: a thin dark feature has a bright surround, a large
       dark area does not, and only the first one gets wrapped. */
    '    vec2 ws = uTexel * 5.0;',
    '    vec3 sur = fetch(uv + vec2(ws.x, 0.0)) + fetch(uv - vec2(ws.x, 0.0))',
    '             + fetch(uv + vec2(0.0, ws.y)) + fetch(uv - vec2(0.0, ws.y));',
    '    float lsur = dot(sur, vec3(0.2126, 0.7152, 0.0722)) * 0.25 * ex;',
    '    float lcW = dot(c, vec3(0.2126, 0.7152, 0.0722));',
    '    float wrapDark = clamp((lsur - lcW) / max(lsur, 1.0e-4), 0.0, 1.0);',
    '    c += mx * (uBloomAmt * uBloomWrap * wrapDark * wrapDark * 2.6);',
    '  }',
    '  float dirt = texture2D(uDirt, uv).r;',
    '  c += bl * (uBloomAmt * (1.0 + uDirtAmt * dirt * 2.4));',
    // (d) veiling glare. Two components: a wide low-frequency halo from the
    //     coarsest mip (gives shadows a directional warm-to-cool gradient)
    //     and a genuinely flat whole-frame term (sets the black floor). Both
    //     inherit the frame's own chromaticity, so nothing lands neutral.
    /* The wide glare comes off the coarsest mip, which is magnified ~30x.
       One bilinear tap of that is a lattice of interpolation squares — the
       block structure the review saw in the halo around the town. A 5-tap
       cross at 0.75 of a source texel costs almost nothing and turns it back
       into the smooth field it is supposed to be. */
    '  vec2 gt = uGlareTexel * 0.75;',
    '  vec3 gv = texture2D(uGlare, uv).rgb * 0.4;',
    '  gv += texture2D(uGlare, uv + vec2(gt.x, 0.0)).rgb * 0.15;',
    '  gv += texture2D(uGlare, uv - vec2(gt.x, 0.0)).rgb * 0.15;',
    '  gv += texture2D(uGlare, uv + vec2(0.0, gt.y)).rgb * 0.15;',
    '  gv += texture2D(uGlare, uv - vec2(0.0, gt.y)).rgb * 0.15;',
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
    /* (e2) direct sun veiling glare. Radially symmetric about the SOURCE,
       laid over everything including the foreground (the scatter happens in
       front of the sensor), driven by the sun's own sampled radiance so it
       is automatically occluded by the rig and automatically correct at any
       exposure. Three lobes — a tight aperture core, a mid veil and a very
       broad 1/r^2 skirt — plus faint blade diffraction. Nothing here is a
       blur of the framebuffer, which is what separates it from bloom. */
    '  if(uSunGlare.x > 0.0){',
    '    vec3 sunRad = vec3(0.0);',
    '    float sunVis = 0.0;',
    '    SUNTAP( 0.000,  0.000)',
    '    SUNTAP( 0.0055, 0.000)',
    '    SUNTAP(-0.0055, 0.000)',
    '    SUNTAP( 0.000,  0.0055)',
    '    SUNTAP( 0.000, -0.0055)',
    '    if(sunVis > 0.5){',
    '      vec3 sg = min(sunRad * (ex / sunVis), vec3(uSunGlare.y));',
    '      vec2 sq = (uv - uSunUV) * vec2(uAspect, 1.0);',
    '      float rr = length(sq);',
    /* Four lobes. The first two are the aperture core and the mid veil; the
       third is a broad 1/r^2 skirt and the fourth is a VERY broad one that
       covers most of the frame at low amplitude. That last term is the whole
       point — it is what lifts the shadows on the near side of a backlit
       subject, and its absence is why the sun read as painted onto the sky
       rather than as something sitting in front of a piece of glass. */
    '      float halo = 0.82 * exp(-rr * 17.0)',
    '                 + 0.30 * exp(-rr * 4.6)',
    '                 + 0.110 / (1.0 + rr * rr * 42.0)',
    '                 + uSunSkirt / (1.0 + rr * rr * 3.2);',
    '      float ang = atan(sq.y, sq.x + 1.0e-6);',
    '      float blades = pow(max(cos(ang * 6.0 + 0.55), 0.0), 22.0)',
    '                   * exp(-rr * 4.2) * uSunGlare.z;',
    '      c += sg * ((halo + blades) * uSunGlare.x * (sunVis * 0.2));',
    '    }',
    '  }',
    /* (e3) scotopic shift. Rod-dominated vision is desaturated and blue; it
       is why a moonlit sea photographs cool while the sodium lamp in the
       same frame stays orange. Keyed on the UNEXPOSED scene radiance, so the
       operator is a property of the scene and not of the metering. */
    '  if(uScotopic.x > 0.0){',
    '    float expL = dot(c, vec3(0.2126, 0.7152, 0.0722));',
    '    float rod = uScotopic.x * (1.0 - smoothstep(uScotopic.y, uScotopic.z, expL));',
    '    if(rod > 0.002){',
    /* Photopic luma for the magnitude so the operator moves CHROMA only and
       cannot lift the shadows it is meant to characterise; the tint is
       normalised to unit luminance for the same reason. */
    '      c = mix(c, vec3(expL) * vec3(0.747, 1.017, 1.577), rod);',
    '    }',
    '  }',
    /* (e4) night grade. A cool multiply weighted onto the shadow end, blended
       in on the civil-twilight gate. The scotopic term above is a model of
       the rod response; this is the colourist's decision on top of it, and it
       is what makes darkness read as saturated blue-black rather than as the
       desaturated grey fog a metered-down night frame otherwise becomes. Unit
       luminance, so it moves chroma without moving exposure. */
    '  if(uNightGrade.x > 0.0){',
    '    float nlum = dot(c, vec3(0.2126, 0.7152, 0.0722));',
    '    float ng = 1.0 - smoothstep(uNightGrade.y, uNightGrade.z, nlum);',
    '    if(ng > 0.002) c *= mix(vec3(1.0), uNightTint, uNightGrade.x * ng);',
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

  /* The curve actually in force this frame: the daylight solve blended
     toward the night solve on the civil-twilight gate. Everything that reads
     the curve — the composite's uniforms, responseCurve(), curveReport() —
     goes through here, so the numbers a caller measures are the numbers the
     frame was rendered with. */
  const _tone = {
    tmMinEV: 0, tmMaxEV: 0, tmPivot: 0, tmSlope: 0,
    tmToe: 0, tmShoulder: 0, tmGrey: 0, tmSat: 0
  };
  function blendN(a, b, nm) { return a + ((isNum(b) ? b : a) - a) * nm; }
  function toneParams() {
    const s = P.settings;
    const nm = clamp(lastNightMix, 0, 1);
    _tone.tmMinEV = blendN(s.tmMinEV, s.tmMinEVNight, nm);
    _tone.tmMaxEV = s.tmMaxEV;
    _tone.tmPivot = s.tmPivot;
    _tone.tmSlope = blendN(s.tmSlope, s.tmSlopeNight, nm);
    _tone.tmToe = blendN(s.tmToe, s.tmToeNight, nm);
    _tone.tmShoulder = s.tmShoulder;
    _tone.tmGrey = blendN(s.tmGrey, s.tmGreyNight, nm);
    _tone.tmSat = blendN(s.tmSat, s.tmSatNight, nm);
    return _tone;
  }

  function pushToneUniforms(m) {
    if (!m || !m.uniforms || !m.uniforms.uTmA) return;
    const s = P.settings;
    const t = toneParams();
    const f0 = curveRaw(t.tmMinEV, t);
    const f1 = curveRaw(t.tmMaxEV, t);
    const inv = 1.0 / Math.max(f1 - f0, 1e-4);
    m.uniforms.uTmA.value.set(t.tmMinEV, t.tmMaxEV, t.tmPivot, t.tmSlope);
    m.uniforms.uTmB.value.set(t.tmToe, t.tmShoulder, t.tmGrey, t.tmSat);
    m.uniforms.uTmC.value.set(f0, inv);
    if (m.uniforms.uShoulderDesat) {
      m.uniforms.uShoulderDesat.value.set(
        clamp(s.shoulderDesat, 0, 1), clamp(s.shoulderDesatLo, 0.05, 0.99));
    }
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
      uAOContact: { value: V2(s.ssaoContactRadius, s.ssaoContactIntensity) },
      uMaxUV: { value: new T.Vector3(s.ssaoContactMaxUV, s.ssaoMaxUV, s.ssaoSkyMaxUV) },
      uAOSky: { value: V2(s.ssaoSkyRadius, s.ssaoSkyIntensity) },
      uUpV: { value: new T.Vector3(0, 1, 0) },
      uRange: { value: s.ssaoRange },
      uSeed: { value: 0 }
    });

    mBlurD = makeMat(FS_BLURD, {
      uTex: { value: null },
      uDepth: { value: null },
      uTexel: { value: V2(0, 0) },
      uCamNF: { value: V2(0.1, 1000) },
      uSpread: { value: 1.4 }
    });

    mBlurA = makeMat(FS_BLURA, {
      uTex: { value: null },
      uDepth: { value: null },
      uTexel: { value: V2(0, 0) },
      uCamNF: { value: V2(0.1, 1000) },
      uDir: { value: V2(0, 1) },
      uSpread: { value: 1.0 }
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
      uZFade: { value: V2(s.ssrFadeStart, s.ssrFadeEnd) },
      uSeed: { value: 0 }
    });

    mDown13 = makeMat(FS_DOWN13, {
      uTex: { value: null },
      uSrcTexel: { value: V2(0, 0) }
    });

    mUpRing = makeMat(FS_UPRING, {
      uTex: { value: null },
      uSrcTexel: { value: V2(0, 0) },
      uRadius: { value: s.bloomRadius },
      uScale: { value: s.bloomCascade },
      uRot: { value: 0.0 }
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
      uFall: { value: s.godrayFall },
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
      uGlareTexel: { value: V2(1 / 50, 1 / 31) },
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
      uBleach: {
        value: new T.Vector4(Math.log2(Math.max(s.bleachStart, 1e-4)),
          1.0 / Math.max(s.bleachStops, 0.05), s.bleachAmount, 0)
      },
      uShoulderDesat: { value: V2(s.shoulderDesat, s.shoulderDesatLo) },
      uAO: { value: whiteTex },
      uSSR: { value: blackTex },
      uLocal: { value: null },
      uSSRTexel: { value: V2(1 / 800, 1 / 500) },
      uAOAmt: { value: s.ssaoAmount },
      uSSRAmt: { value: 0.0 },
      uBloomWrap: { value: s.bloomWrap },
      uBloomTexel: { value: V2(1 / 800, 1 / 500) },
      uSkyOcc: {
        value: new T.Vector4(s.skyOcclusion, s.skyOcclusionFloor,
          s.ssaoRange, s.skyOcclusionPower)
      },
      uOpaqueDepth: { value: null },
      uOpaqueLin: { value: 0.0 },
      uNightGrade: { value: new T.Vector4(0, s.nightTintLo, s.nightTintHi, 0) },
      uNightTint: { value: new T.Vector3(0.861, 1.001, 1.399) },
      uSunSkirt: { value: s.sunGlareSkirt },
      uLocalCfg: { value: new T.Vector4(s.localShadow, s.localHighlight, s.localClamp, 0) },
      uSunUV: { value: V2(0.5, 0.5) },
      uSunGlare: { value: new T.Vector4(0, s.sunGlareCap, s.sunGlareBlades, 0) },
      uScotopic: { value: new T.Vector3(s.scotopic, s.scotopicLow, s.scotopicHigh) },
      uAmbCfg: { value: new T.Vector4(s.ambSky, s.ambBounce, 0, 0) },
      uAmbDim: { value: V2(s.ambDimLo, s.ambDimHi) },
      uAmbSkyTint: { value: new T.Vector3(0.754, 1.005, 1.675) },
      uAmbBncTint: { value: new T.Vector3(1.34, 0.96, 0.56) },
      uKeyDirV: { value: new T.Vector3(0, 1, 0) },
      uKeyPivot: { value: s.ambNightPivot },
      uNrmToWorld: { value: new T.Matrix3() }
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

  /* Chain length. The host's quality profile owns the BASE count; this module
     owns the two extra octaves the wide lobe needs (see bloomExtraHigh). */
  function wantedBloomLevels(q) {
    const s = P.settings;
    const base = (q === 'low') ? s.bloomLevelsLow : s.bloomLevelsHigh;
    const extra = (q === 'low') ? s.bloomExtraLow : s.bloomExtraHigh;
    return Math.max(2, Math.min(10, (base | 0) + (isNum(extra) ? (extra | 0) : 0)));
  }

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
    const want = wantedBloomLevels(lastQuality);
    let mw = iw, mh = ih;
    /* MIP FLOOR. The chain used to stop at 24 px because the composite read
       its COARSEST level directly as the wide glare term, and magnifying a
       25x15 buffer across the frame showed square bilinear blocks in the
       halo. That was the wrong lever: the glare tap now selects the deepest
       mip still at least 22 px wide (see render()), which frees the chain to
       keep halving. Levels below that floor exist only to be tent-upsampled
       back up, where their contribution is a genuinely wide, genuinely smooth
       skirt — the thing that makes a point source read as an inverse-square
       glow rather than as a lit quad. */
    const floorPx = 6;
    for (let i = 0; i < Math.max(2, want | 0); i++) {
      const nw = Math.max(1, mw >> 1), nh = Math.max(1, mh >> 1);
      if (bloomMips.length >= 2 && (nw < floorPx || nh < floorPx)) break;
      mw = nw; mh = nh;
      bloomMips.push(mkRT(mw, mh));
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
    mComposite.uniforms.uSSRTexel.value.set(
      1 / Math.max(rtSSR1.width, 1), 1 / Math.max(rtSSR1.height, 1));
  }

  /* -------------------------------------------------------------- quality */

  function applyQuality(force) {
    const q = (SAIL.quality === 'low') ? 'low' : 'high';
    if (!force && q === lastQuality) return false;
    const prevQ = lastQuality;
    lastQuality = q;
    const s = P.settings;
    const newScale = (q === 'low') ? s.renderScaleLow : s.renderScaleHigh;
    const wantLevels = wantedBloomLevels(q);
    const changed = (newScale !== renderScale) ||
                    (prevQ !== null && bloomMips.length > 0 && bloomMips.length !== wantLevels);
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

  /* sin(sun elevation), +1 when nothing publishes a direction (fail bright,
     never fail into a blue night grade on a daylight scene). */
  function sunElevation() {
    let dir = null;
    if (SAIL.sky && SAIL.sky.sunDir && isNum(SAIL.sky.sunDir.y)) dir = SAIL.sky.sunDir;
    else if (SAIL.env && SAIL.env.sunDir && isNum(SAIL.env.sunDir.y)) dir = SAIL.env.sunDir;
    if (!dir) return 1.0;
    const l = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
    return (l > 1e-6) ? (dir.y / l) : 1.0;
  }

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
    /* Auto-exposure runs at EVERY quality level now. It used to be gated to
       'high', which left the low path metering off SAIL.env.exposure — a
       schedule that runs about 0.4 stop hotter than the meter does. Under
       the old 3.4-stop shoulder that difference was invisible; against a
       finite white point at 2.17 it clipped 5.3% of the low-quality frame
       against 0.005% of the high-quality one, i.e. the two paths were not
       the same photograph. The whole chain is four blits into 64/16/4/1
       targets plus a 1x1 ping-pong; it is not what makes a slow machine
       slow. */
    const auto = !!s.autoExposure;

    /* Civil-twilight gate, computed once. It drives three things that all
       have to agree: the scotopic (rod) shift, the night metering trim and
       whether the directional ambient runs off the moon or off the sun. */
    let nightMix = 0;
    {
      const hi = s.scotopicSunHi, lo = s.scotopicSunLo;
      let nf = clamp((hi - sunElevation()) / Math.max(hi - lo, 1e-4), 0, 1);
      nightMix = nf * nf * (3 - 2 * nf);
      lastNightMix = nightMix;
    }
    const nightTrim = 1.0 + (Math.max(s.nightMeter, 0.2) - 1.0) * nightMix;

    /* The sun's screen position and visibility drive the veiling glare, the
       wide flare skirt and the god-ray source, and the FIRST of those is
       consumed by the bright pass — which runs long before F9 did. Resolve
       it up front. */
    updateSun();

    /* ---- METERING KEY. A single key value renders every scene to the same
       mean; that is day-for-night that forgot the night, and it is why the
       previous build printed a byte-identical curveReport for golden hour
       and for a 22:00 anchorage. Ramp the key down on the civil-twilight
       gate so the night frame is metered as a night frame. */
    const keyNow = s.keyValue +
      (Math.max(isNum(s.keyValueNight) ? s.keyValueNight : s.keyValue, 0.004) - s.keyValue) * nightMix;

    const expoMats = [mBright, mComposite];
    for (let i = 0; i < 2; i++) {
      const u = expoMats[i].uniforms;
      u.uExposure.value = manualExposure * nightTrim;
      u.uAutoMix.value = auto ? 1.0 : 0.0;
      u.uEVBias.value = s.evBias * nightTrim;
      u.uAdaptCfg.value.set(keyNow, s.adaptExponent, s.adaptRef, 0);
      u.uExpClamp.value.set(s.exposureMin, s.exposureMax);
    }
    mBright.uniforms.uThreshold.value = s.bloomThreshold;
    mBright.uniforms.uKnee.value = s.bloomKnee;
    /* Veiling glare is barrel scatter, and barrel scatter is dominated by
       whatever bright source is actually hitting the front element. Both the
       uniform veil and the wide low-frequency glare therefore ramp with the
       sun's on-screen visibility above a floor — a shot INTO a low sun gets
       the full term, a shot with the sun behind the camera keeps only the
       residual. */
    const sunGate = clamp(sunOnScreen, 0, 1);
    const veilMul = clamp(s.veilFloor, 0, 1) + (1 - clamp(s.veilFloor, 0, 1)) * sunGate;
    const glareMul = clamp(s.glareFloor, 0, 1) + (1 - clamp(s.glareFloor, 0, 1)) * sunGate;
    mBright.uniforms.uVeil.value = s.veil * veilMul;
    mUpRing.uniforms.uRadius.value = s.bloomRadius;
    mComposite.uniforms.uCamNF.value.set(near, far);
    mComposite.uniforms.uVignette.value = s.vignette;
    mComposite.uniforms.uGlareAmt.value = s.glare * glareMul;
    mComposite.uniforms.uFlatAmt.value = s.flatGlare;
    mComposite.uniforms.uGlareSat.value = s.glareSat;
    mComposite.uniforms.uBloomAmt.value = (q === 'low') ? s.bloomLow : s.bloomHigh;
    mComposite.uniforms.uBloomWrap.value = clamp(s.bloomWrap, 0, 1);
    mComposite.uniforms.uSunSkirt.value = Math.max(s.sunGlareSkirt, 0);
    /* Scotopic term, on the same gate. Nothing about a daylight frame —
       however deep its shadows — should engage rod vision. */
    const scotAmt = (s.scotopic > 0) ? s.scotopic * nightMix : 0;
    mComposite.uniforms.uScotopic.value.set(scotAmt, s.scotopicLow, s.scotopicHigh);
    /* Night grade: a cool shadow multiply on the same gate. */
    mComposite.uniforms.uNightGrade.value.set(
      Math.max(s.nightTint, 0) * nightMix, s.nightTintLo,
      Math.max(s.nightTintHi, s.nightTintLo + 0.02), 0);
    pushToneUniforms(mComposite);
    mGRPre.uniforms.uCamNF.value.set(near, far);
    mGRPre.uniforms.uFall.value = s.godrayFall;
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
    _upView.set(0, 1, 0).transformDirection(camera.matrixWorldInverse);
    if (aoOn && rtAO0) {
      mSSAO.uniforms.uDepth.value = rtHDR.depthTexture;
      mSSAO.uniforms.uCamNF.value.set(near, far);
      mSSAO.uniforms.uProjScale.value.set(psx, psy);
      mSSAO.uniforms.uAOCfg.value.set(s.ssaoRadius, s.ssaoIntensity, s.ssaoPower, s.ssaoBias);
      mSSAO.uniforms.uAOContact.value.set(s.ssaoContactRadius, s.ssaoContactIntensity);
      mSSAO.uniforms.uMaxUV.value.set(s.ssaoContactMaxUV, s.ssaoMaxUV, s.ssaoSkyMaxUV);
      mSSAO.uniforms.uAOSky.value.set(s.ssaoSkyRadius, s.ssaoSkyIntensity);
      mSSAO.uniforms.uUpV.value.set(_upView.x, _upView.y, _upView.z);
      mSSAO.uniforms.uRange.value = Math.max(s.ssaoRange, 5.0);
      mSSAO.uniforms.uSeed.value = frameSeed * 3.719;
      blit(mSSAO, rtAO0);

      mBlurD.uniforms.uTex.value = rtAO0.texture;
      mBlurD.uniforms.uDepth.value = rtHDR.depthTexture;
      mBlurD.uniforms.uCamNF.value.set(near, far);
      mBlurD.uniforms.uTexel.value.set(1 / rtAO0.width, 1 / rtAO0.height);
      /* Tighter than the 1.4 this used to carry: the buffer now holds a
         12 cm contact term whose whole job is a 2-4 px line, and a wide
         blur is exactly what erased it before. */
      mBlurD.uniforms.uSpread.value = 0.95;
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
      mSSR.uniforms.uColor.value = rtHDR.texture;
      mSSR.uniforms.uDepth.value = rtHDR.depthTexture;
      mSSR.uniforms.uCamNF.value.set(near, far);
      mSSR.uniforms.uProjScale.value.set(psx, psy);
      mSSR.uniforms.uUpView.value.set(_upView.x, _upView.y, _upView.z);
      mSSR.uniforms.uSSRCfg.value.set(s.ssrStrength, s.ssrJitter, s.ssrThickness, s.ssrMaxDist);
      mSSR.uniforms.uEmit.value = s.ssrEmitGate;
      mSSR.uniforms.uZFade.value.set(s.ssrFadeStart, Math.max(s.ssrFadeEnd, s.ssrFadeStart + 1));
      mSSR.uniforms.uSeed.value = frameSeed * 5.113;
      blit(mSSR, rtSSR0);

      /* ANISOTROPIC resolve. A reflection on ripple is a long broken column
         along the view-to-surface azimuth, not a disc: for a level camera
         that axis is screen-vertical, and it tilts with the horizon exactly
         as world up does. Long blur along it, short blur across it. A single
         square kernel over a half-res stochastic buffer is what left the
         reflected harbour as ~10 px axis-aligned tiles. */
      let ax = _upView.x, ay = _upView.y;
      let al = Math.sqrt(ax * ax + ay * ay);
      if (!(al > 1e-4)) { ax = 0; ay = 1; al = 1; }
      ax /= al; ay /= al;

      mBlurA.uniforms.uDepth.value = rtHDR.depthTexture;
      mBlurA.uniforms.uCamNF.value.set(near, far);
      mBlurA.uniforms.uTexel.value.set(1 / rtSSR0.width, 1 / rtSSR0.height);

      mBlurA.uniforms.uTex.value = rtSSR0.texture;
      mBlurA.uniforms.uDir.value.set(ax, ay);
      mBlurA.uniforms.uSpread.value = Math.max(s.ssrStretch, 0.1);
      blit(mBlurA, rtSSR1);

      mBlurA.uniforms.uTex.value = rtSSR1.texture;
      mBlurA.uniforms.uDir.value.set(-ay, ax);
      mBlurA.uniforms.uSpread.value = Math.max(s.ssrBlur, 0.1);
      blit(mBlurA, rtSSR0);

      ssrTex = rtSSR0.texture;
      ssrAmt = 1.0;
      mComposite.uniforms.uSSRTexel.value.set(1 / rtSSR0.width, 1 / rtSSR0.height);
    }
    mBright.uniforms.uSSR.value = ssrTex;
    mBright.uniforms.uSSRAmt.value = ssrAmt;
    mComposite.uniforms.uSSR.value = ssrTex;
    mComposite.uniforms.uSSRAmt.value = ssrAmt;
    mComposite.uniforms.uAO.value = aoTex;
    mComposite.uniforms.uAOAmt.value = aoOn ? s.ssaoAmount : 0.0;
    mComposite.uniforms.uBleach.value.set(
      Math.log(Math.max(s.bleachStart, 1e-4)) / Math.LN2,
      1.0 / Math.max(s.bleachStops, 0.05), s.bleachAmount, 0);
    /* Sky occlusion is an INDIRECT-only term, so it is only meaningful when
       the AO pass ran (that is where the visibility estimate lives). */
    mComposite.uniforms.uSkyOcc.value.set(
      aoOn ? clamp(s.skyOcclusion, 0, 1) : 0.0,
      clamp(s.skyOcclusionFloor, 0, 1),
      Math.max(s.ssaoRange, 5.0),
      clamp(s.skyOcclusionPower, 0.05, 8.0));

    /* ---- directional ambient -------------------------------------------
       Rides entirely on the normal the AO pass packed, so it is only
       available when that pass ran. Everything it needs beyond that comes
       from the sky module's published state: the key direction (sun by day,
       moon once the sun is down), the sky chroma for the dome term and the
       sun/horizon chroma for the bounce term. ---------------------------- */
    const ambOn = aoOn && !!s.dirAmbient;
    if (ambOn) {
      const S = SAIL.sky || {};
      const E = SAIL.env || {};
      const md = S.moonDir || E.moonDir;
      const sd = S.sunDir || E.sunDir;
      let kd = sd;
      if (nightMix > 0.5 && md && isNum(md.y) && md.y > 0.02) kd = md;
      if (kd && isNum(kd.x)) _keyDirW.set(kd.x, kd.y, kd.z);
      else _keyDirW.set(0.25, 0.94, 0.22);
      if (_keyDirW.lengthSq() < 1e-8) _keyDirW.set(0, 1, 0);
      _keyDirW.normalize();
      _keyDirV.copy(_keyDirW).transformDirection(camera.matrixWorldInverse);
      mComposite.uniforms.uKeyDirV.value.set(_keyDirV.x, _keyDirV.y, _keyDirV.z);
      mComposite.uniforms.uNrmToWorld.value.setFromMatrix4(camera.matrixWorld);

      /* The dome term is the sky's own chroma pushed well past its measured
         saturation. That is not a cheat: a shadowed surface integrates the
         WHOLE dome minus the sun, which is markedly bluer than the average
         the sky LUT reports, and the reviewer's complaint was precisely that
         every shadowed patch printed the same warm-neutral ratio. */
      unitTint(mComposite.uniforms.uAmbSkyTint.value,
        S.zenithHue || S.skyColor || E.skyColor, 1.55, 0.45, 0.60, 1.00);
      /* The bounce is whatever is actually lit below the horizon line: the
         sunlit sea at golden hour, the shore/horizon glow at night. */
      unitTint(mComposite.uniforms.uAmbBncTint.value,
        (nightMix > 0.5 ? (S.horizonHue || S.horizonColor) : (S.sunColor || E.sunColor)),
        1.30, 1.00, 0.62, 0.30);

      mComposite.uniforms.uAmbCfg.value.set(
        s.ambSky, s.ambBounce, s.ambNightKey * nightMix, 1.0);
      mComposite.uniforms.uAmbDim.value.set(s.ambDimLo, Math.max(s.ambDimHi, s.ambDimLo + 0.02));
      mComposite.uniforms.uKeyPivot.value = s.ambNightPivot;
    } else {
      mComposite.uniforms.uAmbCfg.value.set(0, 0, 0, 0);
    }

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

    /* ---- F8 : progressive additive upsample ---------------------------
       Each level's kernel is rotated by a golden angle relative to the last,
       so no two levels of the chain share a sampling axis. That is what
       stops the accumulated point-spread function from being an axis-aligned
       box — which is literally what the port nav light's "glow" was. */
    mUpRing.uniforms.uScale.value = s.bloomCascade;
    for (let i = bloomMips.length - 2; i >= 0; i--) {
      const src = bloomMips[i + 1];
      mUpRing.uniforms.uTex.value = src.texture;
      mUpRing.uniforms.uSrcTexel.value.set(1 / src.width, 1 / src.height);
      mUpRing.uniforms.uRot.value = i * 2.39996323;
      blit(mUpRing, bloomMips[i], true);     // additive, do not clear
    }

    // ---- F9 : god rays -------------------------------------------------
    // (updateSun() already ran at the top of the frame: its result feeds the
    // bright pass's veil gate, which happens long before this point.)
    let godAmt = 0;
    if (q === 'high' && s.godrays) {
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

    // ---- F9b : sun veiling glare (analytic, composite-side) -------------
    mComposite.uniforms.uSunUV.value.set(sunUV.x, sunUV.y);
    mComposite.uniforms.uSunGlare.value.set(
      (s.sunGlare > 0 ? s.sunGlare * sunOnScreen : 0.0),
      Math.max(s.sunGlareCap, 0.01),
      Math.max(s.sunGlareBlades, 0.0), 0.0);

    // ---- F10 : composite ----------------------------------------------
    mComposite.uniforms.uHDR.value = rtHDR.texture;
    mComposite.uniforms.uBloom.value = bloomMips[0].texture;
    mComposite.uniforms.uBloomTexel.value.set(1 / bloomMips[0].width, 1 / bloomMips[0].height);
    /* The wide glare term magnifies its source across the WHOLE frame, so it
       needs a mip with enough texels to interpolate smoothly — a 12x8 buffer
       stretched to 1600x1000 is a lattice of bilinear squares, which is the
       block structure the review saw in the halo around the town. Pick the
       deepest level that is still at least 22 px on its short side and leave
       the finer levels to the upsample chain. */
    let glareIdx = bloomMips.length - 1;
    while (glareIdx > 0 &&
           Math.min(bloomMips[glareIdx].width, bloomMips[glareIdx].height) < 22) glareIdx--;
    const glareMip = bloomMips[glareIdx];
    mComposite.uniforms.uGlare.value = glareMip.texture;
    mComposite.uniforms.uGlareTexel.value.set(1 / glareMip.width, 1 / glareMip.height);
    mComposite.uniforms.uFlat.value = rtFlat.texture;
    mComposite.uniforms.uDepthTex.value = rtHDR.depthTexture;
    if (doRefraction && rtMRT) {
      mComposite.uniforms.uOpaqueDepth.value = rtMRT.texture[1];
      mComposite.uniforms.uOpaqueLin.value = 1.0;
    } else {
      mComposite.uniforms.uOpaqueDepth.value = rtHDR.depthTexture;
      mComposite.uniforms.uOpaqueLin.value = 0.0;
    }
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

  /* Read back one texel of the blurred AO buffer. The sky-visibility term is
     invisible in the final frame by design — it only ever scales the indirect
     contribution — so without a way to query it directly there is no way to
     tell "the bimini is being detected and the grade is subtle" from "the
     bimini is not being detected at all". uv is in 0..1, origin bottom-left
     (GL convention). Returns null when the pass did not run. */
  P.aoProbe = function (u, v) {
    if (!P.ready || !renderer || !rtAO1 || !P.enabled) return null;
    const w = rtAO1.width, h = rtAO1.height;
    const x = clamp(Math.floor((isNum(u) ? u : 0.5) * w), 0, w - 1);
    const y = clamp(Math.floor((isNum(v) ? v : 0.5) * h), 0, h - 1);
    const buf = new Uint8Array(4);
    try {
      renderer.readRenderTargetPixels(rtAO1, x, y, 1, 1, buf);
    } catch (e) { return null; }
    return {
      ao: +(buf[0] / 255).toFixed(4),
      skyVis: +(buf[1] / 255).toFixed(4),
      oct: [+(buf[2] / 255).toFixed(3), +(buf[3] / 255).toFixed(3)]
    };
  };

  /* Evaluate the display response of a linear radiance value. Handy for
     other modules (and for calibration) — returns the 0..1 sRGB-encoded
     grey level a neutral surface of that exposed radiance would print at. */
  P.responseCurve = function (exposedLinear) {
    const t = toneParams();
    const x = Math.log(Math.max(exposedLinear, 1e-10)) / Math.LN2;
    const f0 = curveRaw(t.tmMinEV, t);
    const f1 = curveRaw(t.tmMaxEV, t);
    const v = (curveRaw(x, t) - f0) / Math.max(f1 - f0, 1e-4);
    return clamp(v, 0, 1);
  };

  /* Numeric read-out of the curve currently loaded: the code value 18% grey
     prints at, the midtone contrast in code value per stop, where the white
     point lands, and — the number that actually decides whether highlights
     look filmic — the slope the curve still carries WHEN it reaches white.
     Calibration this module is tuned against: grey ~0.42 (code 107),
     contrast ~0.39, -6 EV on code 23-27, white finite at ~3.6 stops over
     grey, slopeAtWhite <= 0.07. A large
     slopeAtWhite means the curve is being amputated rather than rolled off,
     which is what makes an over-range saturated source pin one primary and
     freeze all its shading. */
  P.curveReport = function () {
    const s = P.settings;
    const g = P.responseCurve(0.18);
    const w = Math.pow(2, s.tmMaxEV);
    const kn = isNum(s.keyValueNight) ? s.keyValueNight : s.keyValue;
    const metKey = s.keyValue + (Math.max(kn, 0.004) - s.keyValue) * lastNightMix;
    return {
      greyCode: +(g * 255).toFixed(1),
      grey: +g.toFixed(4),
      contrastPerStop: +(P.responseCurve(0.36) - g).toFixed(4),
      shoulderPerStop: +(P.responseCurve(0.72) - P.responseCurve(0.36)).toFixed(4),
      whiteAt: +w.toFixed(4),
      headroomStops: +(s.tmMaxEV - s.tmPivot).toFixed(3),
      slopeAtWhite: +((P.responseCurve(w) - P.responseCurve(w * 0.8409)) / 0.25).toFixed(4),
      clipsAt1: P.responseCurve(1.0) >= 0.999,
      atOne: +P.responseCurve(1.0).toFixed(4),
      atHalf: +P.responseCurve(0.5).toFixed(4),
      atTwo: +P.responseCurve(2.0).toFixed(4),
      minus6EV: +(P.responseCurve(0.18 / 64) * 255).toFixed(2),
      minus10EV: +(P.responseCurve(0.18 / 1024) * 255).toFixed(2),
      minus8EV: +(P.responseCurve(0.18 / 256) * 255).toFixed(2),
      minus3EV: +(P.responseCurve(0.18 / 8) * 255).toFixed(2),
      shadowStops: +(s.tmPivot - toneParams().tmMinEV).toFixed(2),
      atSixteenth: +P.responseCurve(0.01125).toFixed(4),
      /* The two numbers that separate this build's grade from the last one's:
         where the meter is pointed right now (a night frame MUST report a
         lower key than a daylight one) and how many stops of chroma
         convergence the bleach carries across the shoulder. */
      keyNow: +metKey.toFixed(4),
      bleachOnsetCode: +(P.responseCurve(s.bleachStart) * 255).toFixed(1),
      bleachStops: +s.bleachStops.toFixed(2),
      nightMix: +lastNightMix.toFixed(3)
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
    const mats = [mFill, mMRT, mBright, mDown13, mUpRing, mAvg36, mLumFirst, mLumDown,
                  mAdapt, mGRPre, mGRBlur, mComposite, mFxaaHigh, mFxaaLow, mNoAA,
                  mSSAO, mSSR, mBlurD, mBlurA];
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
