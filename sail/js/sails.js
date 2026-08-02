/* ==========================================================================
   sails.js — SAIL.sails
   Full-batten square-top mainsail + tri-radial furling genoa, Leopard 52.

   Both sails are parametric surfaces rebuilt on the CPU every frame (mast
   bend, camber depth + draft position, twist, forestay sag, leech hook,
   scalloped roach, leech-line flutter, luff bubble, flogging waves) and shaded
   with a layered laminate: anisotropic mylar film over an aramid scrim, thin
   forward-scattering transmission, a manual sun-cascade shadow lookup and
   metric-scale sewn detail (lap seams + stitching, batten pockets, corner
   patches, radial load wrinkles, applied vinyl insignia, UV sunstrip).
   HDR unit contract: E_sun = 100, E_sky = 12, clamp 12000, no tone mapping.

   Model space (from the yacht group): -Z bow, +X starboard, +Y up.  awa is
   body-referenced, positive = wind from STARBOARD (boom to port).

   API: build(yachtGroup) / update(t, dt, trimState) / getAero() / getState()
        autoSheet(awa) / optimalDelta(awa) / rig{boomAngleRad, boomDrop,
        mainHoist, jibFurl, reef, tackSign}
   ========================================================================== */
(function () {
  'use strict';

  var SAIL = (window.SAIL = window.SAIL || {});
  var M = {};
  SAIL.sails = M;

  var DEG = Math.PI / 180;
  var TAU = Math.PI * 2;
  var RHO_AIR = 1.18;

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function sstep(a, b, x) { var d = b - a; var t = clamp((x - a) / (d === 0 ? 1e-9 : d), 0, 1); return t * t * (3 - 2 * t); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  function blankAero() {
    return {
      liftN: 0, dragN: 0, area: 0, areaGeom: 0, luffing: 0, stall: 0,
      fx: 0, fy: 0, ceX: 0, ceY: 9, ceZ: 0, ceHeight: 9, ceLong: 0,
      heelMomentNm: 0, yawMomentNm: 0, awaDeg: 0, awsMs: 0,
      main: { area: 0, cl: 0, cd: 0, deltaDeg: 0, luff: 0, stall: 0 },
      jib: { area: 0, cl: 0, cd: 0, deltaDeg: 0, luff: 0, stall: 0 }
    };
  }

  if (typeof THREE === 'undefined' || !THREE.BufferGeometry) {
    M.ready = false;
    M.build = function () { return M; };
    M.update = function () {};
    M.getAero = blankAero;
    M.getState = function () { return { area: 0, luffing: 0, stall: 0 }; };
    M.autoSheet = function () { return { mainSheet: 0.35, jibSheet: 0.35 }; };
    M.optimalDelta = function () { return { main: 18, mainMax: 80, jib: 18, jibMax: 35 }; };
    return;
  }

  /* ---- 1.  RIG GEOMETRY ---------------------------------------- */

  var RIG = {
    mastTop:      new THREE.Vector3(0, 26.95, -2.90),
    gooseneck:    new THREE.Vector3(0,  6.95, -2.70),
    boomEnd:      new THREE.Vector3(0,  7.11,  4.30),
    forestayTack: new THREE.Vector3(0,  2.25, -8.15),
    forestayHead: new THREE.Vector3(0, 21.85, -2.90)
  };

  var SPEC = {
    mainArea: 99.3, jibArea: 69.0,
    mainARe: 4.6, jibARe: 5.0,
    reefArea:  [1.00, 0.78, 0.58],
    reefHoist: [0.00, 0.175, 0.355],
    reefFoot:  [1.00, 0.95, 0.90],
    deltaMaxMain: 80, deltaMaxJib: 35,
    footE: 7.00, jibLP: 7.00
  };

  /* Full-length battens, as hoist fraction of the unreefed luff. */
  var BATT = [0.072, 0.249, 0.426, 0.603, 0.780, 0.945];
  var NBATT = BATT.length;
  var STRIPE_V = [0.26, 0.51, 0.76];

  /* ---- 2.  PROCEDURAL TEXTURES ---------------------------------------- */

  function ihash(x, y) {
    var n = (x | 0) * 374761393 + (y | 0) * 668265263;
    n = (n ^ (n >> 13)) * 1274126177;
    return ((n ^ (n >> 16)) >>> 0) / 4294967295;
  }
  function wrapi(i, p) { return ((i % p) + p) % p; }
  function vnoise(x, y, per) {
    var xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    var u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    var a = ihash(wrapi(xi, per), wrapi(yi, per));
    var b = ihash(wrapi(xi + 1, per), wrapi(yi, per));
    var c = ihash(wrapi(xi, per), wrapi(yi + 1, per));
    var d = ihash(wrapi(xi + 1, per), wrapi(yi + 1, per));
    return lerp(lerp(a, b, u), lerp(c, d, u), v);
  }

  /* Pack a tiling height field into RGB = tangent normal, A = value. */
  function packHeight(h, N, slope, aBias, aGain) {
    var data = new Uint8Array(N * N * 4), x, y, i;
    for (y = 0; y < N; y++) {
      for (x = 0; x < N; x++) {
        var xm = wrapi(x - 1, N), xp = wrapi(x + 1, N);
        var ym = wrapi(y - 1, N), yp = wrapi(y + 1, N);
        var dx = (h[y * N + xp] - h[y * N + xm]) * slope;
        var dy = (h[yp * N + x] - h[ym * N + x]) * slope;
        var nx = -dx, ny = -dy;
        var il = 1.0 / Math.sqrt(nx * nx + ny * ny + 1.0);
        i = (y * N + x) * 4;
        data[i]     = (nx * il * 0.5 + 0.5) * 255;
        data[i + 1] = (ny * il * 0.5 + 0.5) * 255;
        data[i + 2] = (il * 0.5 + 0.5) * 255;
        data[i + 3] = clamp(aBias + aGain * h[y * N + x], 0, 1) * 255;
      }
    }
    var tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    if (THREE.NoColorSpace) tex.colorSpace = THREE.NoColorSpace;
    var r = SAIL.renderer;
    if (r && r.capabilities && r.capabilities.getMaxAnisotropy) {
      tex.anisotropy = Math.min(16, r.capabilities.getMaxAnisotropy());
    }
    tex.needsUpdate = true;
    return tex;
  }

  /* Laminate scrim.  One page = SCRIM_M (0.32 m) of cloth, so the warp/weft
     yarns land on a 20 mm pitch and the +/- X-ply scrim on 18 mm — real
     laminate numbers.  The shader fades this whole layer out past ~30 m so it
     can never alias into a wallpaper grid; it survives close up and in
     transmission, which is where a scrim is actually visible. */
  var SCRIM_M = 0.32, RUMP_M = 3.4;

  function makeClothTexture(N) {
    var h = new Float32Array(N * N), x, y;
    var sc = N / 512;
    for (y = 0; y < N; y++) {
      for (x = 0; x < N; x++) {
        var px = x / sc, py = y / sc, v = 0;
        v += 0.46 * Math.pow(Math.abs(Math.sin(Math.PI * px / 16.0)), 8.0);
        v += 0.40 * Math.pow(Math.abs(Math.sin(Math.PI * py / 16.0)), 8.0);
        v += 0.78 * Math.pow(Math.abs(Math.sin(Math.PI * (2 * px + py) / 64.0)), 26.0);
        v += 0.78 * Math.pow(Math.abs(Math.sin(Math.PI * (2 * px - py) / 64.0)), 26.0);
        v += 0.30 * vnoise(px * 0.125, py * 0.125, 64);
        v += 0.14 * vnoise(px * 0.25, py * 0.25, 128);
        v += 0.06 * vnoise(px * 0.5, py * 0.5, 256);
        h[y * N + x] = v;
      }
    }
    return packHeight(h, N, 0.78 * sc, 0.46, 0.17);
  }

  /* The soft rumple field: pure low-frequency fractal noise with no periodic
     structure at all, one page = RUMP_M (3.4 m).  This is what carries the
     cloth read at 20-60 m where the scrim has faded — real sailcloth under
     load is never dead flat, but it is also never a grid. */
  function makeRumpleTexture(N) {
    var h = new Float32Array(N * N), x, y;
    var sc = N / 256;
    for (y = 0; y < N; y++) {
      for (x = 0; x < N; x++) {
        var px = x / sc, py = y / sc, v = 0;
        v += 1.00 * vnoise(px * 0.0234375, py * 0.0234375, 6);
        v += 0.52 * vnoise(px * 0.046875, py * 0.046875, 12);
        v += 0.27 * vnoise(px * 0.09375, py * 0.09375, 24);
        v += 0.13 * vnoise(px * 0.1875, py * 0.1875, 48);
        v += 0.06 * vnoise(px * 0.375, py * 0.375, 96);
        h[y * N + x] = v;
      }
    }
    return packHeight(h, N, 0.62 * sc, 0.10, 0.44);
  }

  /* Applied-vinyl insignia + sail numbers.  Drawn with soft edges so the
     cloth can print through and the normal lip has something to bite on. */
  function makeMarkTexture(N) {
    var cv = document.createElement('canvas');
    if (!cv || !cv.getContext) return fallbackTex();
    cv.width = cv.height = N;
    var g = cv.getContext('2d');
    if (!g) return fallbackTex();
    g.clearRect(0, 0, N, N);
    var s = N / 512;

    g.save(); g.translate(256 * s, 158 * s); g.scale(s, s);
    g.fillStyle = '#123f52';
    g.beginPath();
    g.moveTo(-136, 36); g.quadraticCurveTo(-60, -50, 0, -7);
    g.quadraticCurveTo(60, -50, 136, 36);
    g.quadraticCurveTo(58, -7, 0, 31);
    g.quadraticCurveTo(-58, -7, -136, 36);
    g.closePath(); g.fill();
    g.fillStyle = '#b6142c';
    g.beginPath();
    g.moveTo(-100, 78); g.quadraticCurveTo(-43, 41, 0, 68);
    g.quadraticCurveTo(43, 41, 100, 78);
    g.quadraticCurveTo(43, 62, 0, 88);
    g.quadraticCurveTo(-43, 62, -100, 78);
    g.closePath(); g.fill();
    g.fillStyle = '#123f52';
    g.beginPath(); g.arc(0, 13, 13, 0, TAU); g.fill();
    g.restore();

    g.fillStyle = '#16323f';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = 'bold ' + Math.round(78 * s) + 'px Helvetica, Arial, sans-serif';
    g.fillText('GRD', 256 * s, 282 * s);
    g.font = 'bold ' + Math.round(158 * s) + 'px Helvetica, Arial, sans-serif';
    g.fillText('5252', 256 * s, 402 * s);

    var tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    if (THREE.NoColorSpace) tex.colorSpace = THREE.NoColorSpace;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.needsUpdate = true;
    return tex;
  }

  function fallbackTex() {
    var d = new Uint8Array([0, 0, 0, 0]);
    var t = new THREE.DataTexture(d, 1, 1, THREE.RGBAFormat);
    if (THREE.NoColorSpace) t.colorSpace = THREE.NoColorSpace;
    t.needsUpdate = true;
    return t;
  }

  /* ---- 3.  SAILCLOTH SHADER ---------------------------------------- */

  var VS_SAIL = [
    'attribute vec3 aTan; attribute vec4 aMeta; varying vec3 vWorld; varying vec3 vN; varying vec3 vT;',
    'varying vec2 vUv2; varying vec4 vMeta; void main(){ vec4 wp = modelMatrix * vec4(position, 1.0);',
    'vWorld = wp.xyz; vN = normalize(mat3(modelMatrix) * normal); vT = normalize(mat3(modelMatrix) * aTan);',
    'vUv2 = uv; vMeta = aMeta; gl_Position = projectionMatrix * viewMatrix * wp;',
    '}'
  ].join('\n');

  var FS_SAIL = [
    /* ---------------------------------------------------------------------
       Thin two-sided sailcloth BSDF.

       reflection : wrap-lit Lambert  (NdotL + w)/(1 + w),  w = 0.45
       transmission: Henyey-Greenstein forward lobe through a cloth of
                     optical thickness `thk` — seam tape, batten pockets,
                     corner patches, insignia and the sunstrip all raise
                     `thk` and therefore read as DARK structure inside the
                     backlit glow, exactly as they do in a photograph.
       specular   : anisotropic GGX film, tangent along the panel warp.
       ambient    : analytic sky/sea radiance with a circumsolar lobe, so the
                    cloth still has an azimuthal gradient on a vertical
                    surface where a plain hemisphere term would be constant.
       shadowing  : min(sun cascade, analytic rig capsules, other-sail quad).
       --------------------------------------------------------------------- */
    'uniform vec3 uSunDir,uSunCol,uSkyCol,uHorizCol,uSeaCol,uBase,uTint,uTransCol;',
    'uniform float uSunE,uSkyE,uLuff,uStall,uLoad,uIsMain,uIsTape,uSigma,uConvex,uAmbK,uSlot;',
    'uniform float uPanel,uSeamSlope,uStripe,uSunStrip,uClothM,uRumpM,uHoistM;',
    'uniform vec2 uReefV,uVMap,uCH,uCT,uCC; uniform vec4 uMarkRect; uniform float uBattV[6]; uniform float uStripV[3];',
    'uniform sampler2D uCloth,uRump,uMark,uShadowMap; uniform mat4 uShadowMat; uniform float uShadowOn,uShTexel;',
    'uniform vec4 uSegA[12]; uniform vec4 uSegB[12]; uniform vec3 uQ0,uQ1,uQ2,uQ3; uniform float uQOn;',
    'varying vec3 vWorld; varying vec3 vN; varying vec3 vT; varying vec2 vUv2; varying vec4 vMeta;',
    'const float PI = 3.141592653589793;',
    'float ss(float a,float b,float x){float t=clamp((x-a)/(b-a),0.0,1.0);return t*t*(3.0-2.0*t);}',
    'float gs(float x,float w){float e=x/w;return exp(-e*e);}',
    'float upk(vec4 v){return dot(v,vec4(5.9371816e-8,1.5199185e-5,3.8909912e-3,0.99609375));}',

    /* Manual lookup into the sun cascade three.js already renders — it carries
       the hull, bimini and island onto the cloth.  Thin doubly-curved sheet, so
       no normal offset: just a slope-scaled depth bias in ortho depth units. */
    'float shadowAt(vec3 P,float sl){ if(uShadowOn<0.5) return 1.0; vec4 sc=uShadowMat*vec4(P,1.0); vec3 c=sc.xyz/max(sc.w,1e-4);',
    'if(c.x<0.003||c.x>0.997||c.y<0.003||c.y>0.997||c.z>0.9995||c.z<0.0) return 1.0; float b=0.00075+0.00160*sl;',
    '#ifdef HQ',
    'float s=0.0; float e=uShTexel; for(int j=-1;j<=1;j++){for(int i=-1;i<=1;i++){',
    's+=step(c.z-b,upk(texture2D(uShadowMap,c.xy+vec2(float(i),float(j))*e))); }} return s*0.11111111;',
    '#else',
    'return step(c.z-b,upk(texture2D(uShadowMap,c.xy)));',
    '#endif',
    '}',

    /* Analytic capsule shadow: closest approach of the sun ray to a spar or a
       wire.  A dedicated rig cascade in all but name — the mast bar is crisp
       because the mast is 0.3 m off the cloth, the shroud lines soften with
       distance through the sun's 0.53 deg disc. */
    'float segOcc(vec3 P,vec3 L,vec4 A,vec4 B){ vec3 ba=B.xyz-A.xyz; float bb=dot(ba,ba); if(bb<1e-6) return 0.0;',
    'vec3 w0=P-A.xyz; float a=dot(w0,L), b=dot(ba,L), c=dot(w0,ba); float den=b*b-bb;',
    'float s=(abs(den)<1e-5)?0.5:clamp((a*b-c)/den,0.0,1.0); float t=s*b-a; if(t<0.05) return 0.0;',
    'vec3 d=w0+L*t-ba*s; float bw=max(0.0062*t,0.010)+B.w;',
    /* an occluder thinner than the sun's disc at that range can only ever
       block part of it: a 10 mm wire 6 m off the cloth is a 30 % grey line,
       the 370 mm mast 0.3 m off the luff is a hard black bar */
    'float cov=clamp(2.0*A.w/max(0.0093*t,1e-4), 0.0, 1.0); cov=cov*(2.0-cov);',
    'return (1.0-ss(A.w-bw,A.w+bw,length(d)))*ss(0.05,0.28,t)*cov; }',

    /* The other sail, as a planar quad.  Cheap, and at 2-5 m separation the
       penumbra is wide enough that the planar approximation never shows. */
    'float quadOcc(vec3 P,vec3 L){ if(uQOn<0.5) return 0.0; vec3 n=cross(uQ1-uQ0,uQ3-uQ0); float nl=length(n);',
    'if(nl<1e-4) return 0.0; n/=nl; float dn=dot(n,L); if(abs(dn)<0.04) return 0.0;',
    'float t=dot(n,uQ0-P)/dn; if(t<0.35||t>120.0) return 0.0; vec3 H=P+L*t;',
    'float e0=dot(cross(normalize(uQ1-uQ0),H-uQ0),n); float e1=dot(cross(normalize(uQ2-uQ1),H-uQ1),n);',
    'float e2=dot(cross(normalize(uQ3-uQ2),H-uQ2),n); float e3=dot(cross(normalize(uQ0-uQ3),H-uQ3),n);',
    'float k=min(min(e0,e1),min(e2,e3)); float k2=min(min(-e0,-e1),min(-e2,-e3));',
    'float pen=0.10+0.014*t; return ss(-pen,pen,max(k,k2)); }',

    /* Analytic sky+sea radiance.  The circumsolar term is what stops a
       vertical sail from having a constant ambient value. */
    'vec3 skyRad(vec3 N,vec3 L){ vec3 d=mix(uHorizCol,uSkyCol,ss(0.02,0.70,N.y)); d=mix(uSeaCol*0.85,d,ss(-0.40,0.05,N.y));',
    'float cs=max(dot(N,L),0.0); return d+uSkyCol*(0.13*cs+0.42*cs*cs*cs); }',

    /* Corner reinforcement: three stacked patch layers, a lip at every layer
       edge and the radial wrinkle fan the load path drags out of the cloth.
       Returns (layers, dHeight/ds, dHeight/dh). */
    'vec3 cornerFx(vec2 P,vec2 C,float R,float wa,float K){ vec2 r=P-C; float d=max(length(r),0.07);',
    'float p=ss(R+0.011,R-0.011,d)+ss(R*0.66+0.009,R*0.66-0.009,d)+ss(R*0.38+0.007,R*0.38-0.007,d);',
    'float lip=(gs(d-R,0.0065)+gs(d-R*0.66,0.0055)+gs(d-R*0.38,0.0045))*0.42; float th=atan(r.y,r.x);',
    'float a=wa*exp(-d*0.30)*ss(0.10,0.75,d); vec2 pv=vec2(-r.y,r.x)/d; vec2 rv=r/d;',
    'return vec3(p, pv*(a*K*cos(th*K)/d)-rv*lip); }',

    'void main(){ vec3 gN=normalize(vN); vec3 V=normalize(cameraPosition-vWorld);',
    'float sideS=(dot(gN,V)<0.0)?-1.0:1.0; vec3 L=uSunDir; float dist=length(cameraPosition-vWorld);',

    /* ---- one shadow value shared by every lobe -------------------------- */
    'float slopeF=1.0-abs(dot(gN,L)); float rig=1.0;',
    'for(int i=0;i<12;i++){ rig*=1.0-segOcc(vWorld,L,uSegA[i],uSegB[i]); }',
    'float shd=min(shadowAt(vWorld,slopeF), rig*(1.0-0.94*quadOcc(vWorld,L)));',

    /* ---- rolled leech tape: its own tiny material path ------------------ */
    'if (uIsTape > 0.5) { vec3 Nt=gN*sideS; float df=max(0.0,(dot(Nt,L)+0.30)/1.30);',
    'vec3 ab=skyRad(Nt,L)*uSkyE; vec3 cc=uBase*0.72*(df*uSunE*uSunCol*shd+ab*0.55)/PI;',
    'float rim=pow(1.0-max(dot(Nt,V),0.0),3.0); cc+=(uSkyCol*uSkyE+uSunCol*uSunE*df*shd*0.30)*rim*0.13;',
    'cc+=uBase*uTint*0.55*max(0.0,-dot(Nt,L))*uSunE*mix(0.16,1.0,shd)/PI;',
    'gl_FragColor=vec4(min(cc,vec3(12000.0)),1.0); return; }',

    'vec3 T0=normalize(vT-gN*dot(vT,gN)); vec3 Bh=cross(T0,gN);',
    'float chordM=max(vMeta.x,0.05); float hM=vMeta.y; float camF=vMeta.w;',
    'float uu=clamp(vUv2.x,0.0,1.0); float sM=uu*chordM;',
    'float hA=hM+uVMap.x*uHoistM;',              /* metres above the ORIGINAL tack */
    'vec2 P2=vec2(sM,hM);',
    'float close=1.0-ss(6.0,17.0,dist);',        /* stitch pitch mip fade */
    'float fine=1.0-ss(9.0,34.0,dist);',         /* scrim fade — kills the grid */

    /* ---- panel layout: cross-cut main / tri-radial genoa ---------------- */
    'vec2 wd,sp,KC; float seamF,alongC,girth=0.0,mitre=0.0;',
    'if (uIsMain > 0.5) { seamF=hM+sM*uSeamSlope; sp=normalize(vec2(uSeamSlope,1.0)); wd=vec2(sp.y,-sp.x);',
    'alongC=dot(P2,wd); KC=uCC; } else { vec2 A=uCT, Bc=uCC, C=uCH;',
    'vec2 e0=Bc-A, e1=C-A, e2=P2-A; float d00=dot(e0,e0), d01=dot(e0,e1), d11=dot(e1,e1); float dn=d00*d11-d01*d01;',
    'dn=(abs(dn)<1e-4)?1e-4:dn; vec2 gb=(d11*e0-d01*e1)/dn; vec2 gc=(d00*e1-d01*e0)/dn; vec2 ga=-gb-gc;',
    'float lb=dot(e2,gb), lc=dot(e2,gc), la=1.0-lb-lc; float mm;',
    'if (la>=lb && la>=lc) { KC=A; mm=min(la-lb,la-lc); } else if (lb>=lc) { KC=Bc; mm=min(lb-la,lb-lc); }',
    'else { KC=C; mm=min(lc-la,lc-lb); } float gsc=(length(ga-gb)+length(gb-gc)+length(gc-ga))*0.33333;',
    /* the mitre is a SEWN JOIN, not a knife cut: 8 cm of soft taper, no
       albedo step, so it can never read as a hard diagonal crease */
    'mitre=ss(0.090,0.026, mm/max(gsc,1e-3))*0.50; vec2 rl=P2-KC; float rr=max(length(rl),0.12);',
    'float th=atan(rl.y,rl.x); seamF=th*2.7; wd=rl/rr; sp=vec2(-wd.y,wd.x);',
    'alongC=rr; girth=gs((fract(rr/2.6)-0.5)*2.6, 0.016); }',

    /* ---- lap seam: 19 mm overlapped strip, height step both edges, a
           one-sided contact shadow under the lap and a double row of
           7 mm stitching that fades out with distance ------------------- */
    'float pw=max(uPanel,0.20); float sd=(fract(seamF/pw)-0.5)*pw; float lw=0.019;',
    'float lap=ss(lw*1.06, lw*0.84, abs(sd)); float lapG=(gs(sd+lw,0.0024)-gs(sd-lw,0.0024))*0.40;',
    'float lapSh=ss(0.030,0.001, sd-lw)*step(0.0, sd-lw);',
    'float stRow=max(gs(abs(sd)-lw*0.52,0.0014),0.0);',
    'float stitch=stRow*gs((fract(alongC/0.007)-0.5)*0.007,0.0016)*close;',

    /* ---- full-length batten pockets: raised sewn sleeve, a contact shadow
           along its lower edge, and the short radial wrinkles the batten end
           drags out of the leech --------------------------------------- */
    'float pk=0.0, pkG=0.0, pkStitch=0.0, pkSh=0.0, bEnd=0.0, bEndG=0.0;',
    'if (uIsMain > 0.5) { for (int k=0;k<6;k++) { float bh=uBattV[k]*uHoistM-uVMap.x*uHoistM; float d=hM-bh;',
    'if (abs(d) < 0.34) { float g=gs(d,0.056); pk=max(pk,g); pkG+=(-2.0*d/0.003136)*g*0.0165;',
    'pkSh=max(pkSh, ss(0.20,0.075,-d)*step(0.0,-d)*0.55);',
    'pkStitch=max(pkStitch, gs(abs(d)-0.070,0.0014)*gs((fract(sM/0.007)-0.5)*0.007,0.0016)*close);',
    'float dl=chordM-sM; float w=0.030*uLoad*exp(-dl*0.55)*ss(0.03,0.55,dl);',
    'bEndG+=w*22.0*cos(d*22.0); } } }',

    /* ---- printed draft stripes: soft pigment, no height ----------------- */
    'float stripe=0.0; for (int k=0;k<3;k++) { stripe=max(stripe, ss(0.072,0.030, abs(hA-uStripV[k]*uHoistM))); }',
    'stripe*=ss(0.05,0.24,sM)*ss(0.02,0.18,chordM-sM)*uStripe;',

    /* ---- slab reef rows: webbing tape + cringle grommets ---------------- */
    'float rp=0.0; for (int k=0;k<2;k++) { float bv=(k==0)?uReefV.x:uReefV.y;',
    'if (bv > 0.0) { float dm=abs(hA-bv*uHoistM); rp=max(rp, max(ss(0.070,0.042,dm)*0.65,',
    'ss(0.036,0.019,dm)*step(0.62, sin(sM*8.2)*0.5+0.5))); } }',

    /* ---- corner patches + radial load wrinkles -------------------------- */
    'vec3 f1=cornerFx(P2, uCC, (uIsMain>0.5)?1.10:1.30, 0.0165*uLoad, 17.0);',
    'vec3 f2=cornerFx(P2, uCT, 0.74, 0.0115*uLoad, 15.0);',
    'vec3 f3=cornerFx(P2, uCH, 0.58, 0.0095*uLoad, 13.0);',
    'float pchL=clamp(f1.x+f2.x+f3.x, 0.0, 3.0); vec2 patG=(f1.yz+f2.yz+f3.yz)*(1.0-0.55*pk);',

    /* ---- applied vinyl insignia, projected into the sail UV ------------- */
    'vec2 mk=vec2((sM-uMarkRect.x)/max(uMarkRect.z-uMarkRect.x,0.01), (hA-uMarkRect.y)/max(uMarkRect.w-uMarkRect.y,0.01));',
    'float inMk=step(0.0,mk.x)*step(mk.x,1.0)*step(0.0,mk.y)*step(mk.y,1.0);',
    'vec2 mkq=vec2(gl_FrontFacing?(1.0-mk.x):mk.x, mk.y); vec4 mkc=texture2D(uMark, clamp(mkq,0.001,0.999)); mkc.a*=inMk;',
    'vec2 mkG=vec2(0.0);',
    '#ifdef HQ',
    'if (inMk > 0.5) { float mo=0.005; float a1=texture2D(uMark, clamp(mkq+vec2(mo,0.0),0.001,0.999)).a;',
    'float a2=texture2D(uMark, clamp(mkq-vec2(mo,0.0),0.001,0.999)).a;',
    'float a3=texture2D(uMark, clamp(mkq+vec2(0.0,mo),0.001,0.999)).a;',
    'float a4=texture2D(uMark, clamp(mkq-vec2(0.0,mo),0.001,0.999)).a;',
    'mkG=vec2(gl_FrontFacing?(a2-a1):(a1-a2), a3-a4)*0.80; }',
    '#endif',

    /* ---- UV sunstrip along the genoa leech + foot ----------------------- */
    'float strip=0.0, stripG=0.0, stripGh=0.0; if (uSunStrip > 0.5) { float dl=chordM-sM;',
    'float a=ss(0.46,0.34,dl), b=ss(0.40,0.30,hM); strip=max(a,b); stripG=gs(dl-0.40,0.010)*0.42;',
    'stripGh=-gs(hM-0.35,0.010)*0.42; }',

    /* ---- luff hardware: bolt-rope tape and cloth gathering between the
           mast-track slides ------------------------------------------- */
    'float luffZ=ss(0.20,0.02,sM); float ltape=ss(0.056,0.032,sM); float bunG=0.0;',
    /* the cloth sags between the mast-track slides — but only over the first
       200 mm of chord, and gently: any wider and the 0.55 m slide pitch reads
       as banding across the whole luff panel */
    'if (uIsMain > 0.5) { float w=6.2831853/0.55; float sag=cos(hM*w); sag=sag*abs(sag);',
    'bunG=0.0032*w*sag*luffZ*(1.0-ltape)*0.42; }',

    /* ---- laminate: scrim aligned to the panel warp, plus a non-repeating
           rumple field that carries the cloth read at distance --------- */
    'vec2 tc=vec2(dot(P2,wd), dot(P2,vec2(-wd.y,wd.x)))/uClothM;',
    'vec4 cl=texture2D(uCloth, tc); vec4 rm=texture2D(uRump, P2/uRumpM+vec2(0.137,0.409));',
    'vec2 nt=cl.xy*2.0-1.0; float nzz=max(cl.z*2.0-1.0,0.30);',
    'vec2 g0=(-nt/nzz)*(0.26+0.60*uLuff)*fine*(1.0-0.55*strip);',
    'g0=vec2(g0.x*wd.x-g0.y*wd.y, g0.x*wd.y+g0.y*wd.x);',
    'vec2 g1=-(rm.xy*2.0-1.0)*(0.13+0.30*uLuff+0.20*uLoad);',
    'float weave=mix(0.5,cl.w,fine); float mottle=rm.w;',
    /* the yarn coverage of the scrim.  This is fed to the OPTICAL THICKNESS,
       not to the diffuse albedo: in a photograph of a laminate the X-ply and
       the warp yarns are opaque threads read as a dark grid inside the
       transmitted glow, and they are nearly invisible in reflected light. */
    'float scrim=clamp((cl.w-0.52)*3.0, 0.0, 1.0)*fine;',

    /* ---- height gradient -> a detail normal for specular and a smoother
           one for the diffuse / transmission lobes --------------------- */
    'vec2 grad=g0+g1+patG; grad+=sp*lapG; grad+=sp*stitch*0.55;',
    'grad.y+=pkG+pkStitch*0.55+stripGh+bunG+bEndG*0.35; grad.x+=stripG-ltape*0.55*float(uIsMain>0.5);',
    'grad+=mkG*0.65;',
    'vec2 gradD=g1*0.80+patG*0.55; gradD.y+=pkG*0.30;',
    'vec3 Np=normalize(gN-(T0*grad.x+Bh*grad.y))*sideS;',
    'vec3 Nd=normalize(gN-(T0*gradD.x+Bh*gradD.y))*sideS;',

    /* ---- albedo / roughness / optical thickness -------------------------
           thk is the cloth-thickness map the transmission lobe reads: every
           sewn layer goes DARK against the backlit glow. ----------------- */
    'vec3 alb=uBase*(0.955+0.09*weave)*(0.94+0.12*mottle); float rough=0.25+0.16*weave; float anis=0.82;',
    'float thk=1.0+1.95*scrim+0.55*(mottle-0.5); alb*=1.0-0.055*scrim;',
    'alb*=1.0-0.075*lap-0.16*lapSh-0.34*stitch-0.30*pkStitch; thk+=1.5*lap+2.2*stitch+1.1*girth+1.3*mitre;',
    'alb*=1.0-0.075*pk-0.10*pkSh; rough+=0.13*pk; thk+=2.8*pk;',
    'alb*=1.0-0.055*pchL; rough+=0.06*pchL; thk+=2.0*pchL;',
    'alb=mix(alb, vec3(0.052,0.070,0.100)*(0.85+0.30*weave), 0.80*stripe); rough=mix(rough,0.63,stripe);',
    'anis*=1.0-0.55*stripe; thk+=2.6*stripe; alb*=1.0-0.20*rp; thk+=2.5*rp;',
    'alb=mix(alb, mkc.rgb*(0.90+0.20*weave), mkc.a*0.93); rough=mix(rough,0.17,mkc.a); anis=mix(anis,0.18,mkc.a);',
    'thk+=3.4*mkc.a;',
    'alb=mix(alb, vec3(0.028,0.045,0.092)*(0.80+0.40*weave), strip); rough=mix(rough,0.82,strip);',
    'anis*=1.0-strip; thk+=4.0*strip; alb=mix(alb, alb*0.90, ltape*float(uIsMain>0.5));',
    'rough=clamp(rough,0.10,0.92);',

    /* ---- sail-system ambient occlusion ---------------------------------
           the deep-draft pocket is a bowl, the foot sits on the boom, and the
           slot between jib leech and main luff is a closed corner. -------- */
    'float concave=(sideS*uConvex<0.0)?1.0:0.0;',
    'float bowl=1.0-0.42*concave*clamp(camF/0.13,0.0,1.5)*sin(PI*uu);',
    'float footAO=1.0-0.44*exp(-max(hM,0.0)/((uIsMain>0.5)?0.34:0.55));',
    'float slotSide=(uIsMain>0.5)?concave:(1.0-concave);',
    'float slotU=(uIsMain>0.5)?ss(0.55,0.02,uu):ss(0.60,0.05,1.0-uu);',
    'float slotAO=1.0-uSlot*0.34*slotU*slotSide;',
    'float occ=clamp(bowl*footAO*slotAO*(1.0-0.26*lapSh-0.15*pk-0.10*pchL), 0.18, 1.0);',

    /* ---- reflection lobe ------------------------------------------------ */
    'float NoL=dot(Nd,L); const float WR=0.45; float dif=max(0.0,(NoL+WR)/(1.0+WR));',
    'vec3 col=alb*dif*uSunE*uSunCol*shd/PI;',
    'vec3 ambC=skyRad(Nd,L); col+=alb*ambC*uSkyE*occ*uAmbK;',

    /* ---- diffuse-transmission lobe: this is the sail ---------------------
           Henyey-Greenstein forward scatter through thickness `thk`. Under
           direct sun a backlit panel runs 2-3 stops over the shaded side. */
    'float back=max(0.0,-NoL); float path=1.0/max(abs(NoL),0.28);',
    'float tau=exp(-uSigma*(thk-1.0)*path)*exp(-0.42*(path-1.0));',
    'float gg=clamp(0.62-0.085*(thk-1.0), 0.18, 0.68); float cT=clamp(dot(-L,V),-1.0,1.0);',
    'float dn2=1.0+gg*gg-2.0*gg*cT; float ph=clamp((1.0-gg*gg)/max(dn2*sqrt(dn2),1e-3), 0.12, 4.3);',
    'vec3 tcol=uTransCol*alb*uTint;',
    'col+=tcol*back*tau*ph*uSunE*uSunCol*mix(0.16,1.0,shd)/PI;',
    'col+=tcol*tau*0.46*skyRad(-Nd,L)*uSkyE*occ;',

    /* ---- bounce: warm off the deck, green-blue off the water ------------ */
    'float lowB=exp(-max(hM,0.0)/5.5);',
    'col+=alb*uSeaCol*uSkyE*(0.10+0.26*max(-Nd.y,0.0))*lowB*occ;',
    'col+=alb*vec3(0.55,0.52,0.46)*uSkyE*0.06*lowB*max(0.0,-Nd.y)*occ;',

    /* ---- anisotropic mylar film + sky sheen ------------------------------ */
    'vec3 W=normalize(T0*wd.x+Bh*wd.y); W=normalize(W-Np*dot(W,Np)); vec3 Y=cross(Np,W);',
    'vec3 H=normalize(L+V); float NoH=max(dot(Np,H),0.0); float NoV=max(dot(Np,V),1e-3);',
    'float NoLc=max(dot(Np,L),0.0); float ar=rough*rough; float ax=max(ar*(1.0+anis*2.60),0.010);',
    'float ay=max(ar*(1.0-anis*0.55),0.006); float XoH=dot(W,H), YoH=dot(Y,H);',
    'float dd=XoH*XoH/(ax*ax)+YoH*YoH/(ay*ay)+NoH*NoH; float D=1.0/(PI*ax*ay*max(dd*dd,1e-6));',
    'float kk=ar*0.5; float G=(NoV/(NoV*(1.0-kk)+kk))*(NoLc/(NoLc*(1.0-kk)+kk));',
    'float Fr=0.042+0.958*pow(1.0-max(dot(H,V),0.0),5.0);',
    'vec3 spec=uSunCol*min(D*G*Fr,900.0)*NoLc*uSunE*shd; float fres=pow(1.0-NoV,4.0);',
    'spec+=ambC*uSkyE*occ*(0.065+0.42*fres)*(1.0-0.65*strip)*(1.0-0.45*stripe); col+=spec;',

    'float l=dot(col, vec3(0.333)); if (!(l < 1e5)) col=vec3(0.0);',
    'gl_FragColor=vec4(min(col, vec3(12000.0)), 1.0);',
    '}'
  ].join('\n');

  /* Shadow caster for the cloth.  The sail is a zero-thickness sheet, so if
     it writes its own surface depth it shadow-acnes itself into a moire.
     Displacing the caster 0.40 m AWAY from the sun along the light axis costs
     nothing for a directional light (the shadow does not move laterally) but
     lifts the whole sail clear of its own occluder, while the jib two metres
     behind the main is still properly in the main's shadow. */
  var VS_DEPTH = [
    'uniform vec3 uLdir; uniform float uOff; void main(){ vec4 wp = modelMatrix * vec4(position, 1.0);',
    'wp.xyz -= uLdir*uOff; gl_Position = projectionMatrix * viewMatrix * wp;',
    '}'
  ].join('\n');

  var FS_DEPTH = [
    'void main(){ float v = gl_FragCoord.z; vec4 r = vec4(fract(v*vec3(16777216.0,65536.0,256.0)), v);',
    'r.yzw -= r.xyz*0.00390625; gl_FragColor = r*1.00392157;',
    '}'
  ].join('\n');

  /* Rolled / flaked cloth: furled genoa, reef bunt, stowed mainsail. */
  var VS_BUNDLE = [
    'varying vec3 vW; varying vec3 vN; varying vec2 vU; void main(){ vec4 wp = modelMatrix * vec4(position, 1.0);',
    'vW = wp.xyz; vN = normalize(mat3(modelMatrix)*normal); vU = uv; gl_Position = projectionMatrix * viewMatrix * wp;',
    '}'
  ].join('\n');

  var FS_BUNDLE = [
    'uniform vec3 uSunDir,uSunCol,uSkyCol,uHorizCol,uBase,uStripCol; uniform float uSunE,uSkyE,uTwist,uFold,uStripAmt; varying vec3 vW; varying vec3 vN; varying vec2 vU;',
    'const float PI = 3.141592653589793; float ss(float a,float b,float x){float t=clamp((x-a)/(b-a),0.0,1.0);return t*t*(3.0-2.0*t);} void main(){',
    'vec3 N = normalize(vN); vec3 V = normalize(cameraPosition - vW); if (dot(N,V) < 0.0) N = -N;',
    'float hel = fract(vU.x + vU.y*uTwist); float wrap = ss(0.44,0.50,hel)*ss(0.58,0.50,hel); float fold = 0.5 + 0.5*sin(vU.y*uFold + vU.x*7.0);',
    'vec3 alb = mix(uBase, uStripCol, uStripAmt); alb *= (0.86 + 0.22*fold)*(1.0 - 0.30*wrap); vec3 axis = normalize(cross(N, vec3(0.0,1.0,0.0)) + vec3(1e-5,0.0,1e-5));',
    'N = normalize(N + axis*(fold-0.5)*0.45); float dif = max(0.0,(dot(N,uSunDir)+0.25)/1.25); vec3 amb = mix(uHorizCol,uSkyCol,clamp(N.y*0.5+0.5,0.0,1.0))*uSkyE;',
    'vec3 col = alb*(dif*uSunE*uSunCol + amb)/PI; col += uSkyCol*uSkyE*pow(1.0-max(dot(N,V),1e-3),5.0)*0.05; float l = dot(col, vec3(0.333));',
    'if (!(l < 1e5)) col = vec3(0.0); gl_FragColor = vec4(min(col, vec3(12000.0)), 1.0);',
    '}'
  ].join('\n');

  var VS_TELL = [
    'attribute vec3 aCol; varying vec3 vN; varying vec3 vW; varying vec3 vC; void main(){',
    'vec4 wp = modelMatrix * vec4(position, 1.0); vW = wp.xyz; vN = normalize(mat3(modelMatrix)*normal); vC = aCol; gl_Position = projectionMatrix * viewMatrix * wp;',
    '}'
  ].join('\n');

  var FS_TELL = [
    'uniform vec3 uSunDir,uSunCol,uSkyCol; uniform float uSunE,uSkyE; varying vec3 vN; varying vec3 vW; varying vec3 vC;',
    'const float PI = 3.141592653589793; void main(){ vec3 N = normalize(vN);',
    'vec3 V = normalize(cameraPosition - vW); if (dot(N,V) < 0.0) N = -N; float d = max(0.0,(dot(N,uSunDir)+0.45)/1.45);',
    'float bk = max(0.0,-dot(N,uSunDir)); vec3 col = vC*(d*uSunE*uSunCol + uSkyCol*uSkyE*1.3)/PI; col += vC*vec3(1.0,0.94,0.82)*bk*0.55*uSunE/PI;',
    'float l = dot(col, vec3(0.333)); if (!(l < 1e5)) col = vec3(0.0); gl_FragColor = vec4(min(col, vec3(12000.0)), 1.0);',
    '}'
  ].join('\n');

  /* ---- 4.  AERODYNAMICS ---------------------------------------- */

  var TA  = [0, 20, 27, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 135, 150, 165, 180];
  var TCL = [0, 0.50, 1.05, 1.28, 1.49, 1.55, 1.50, 1.38, 1.22, 1.02, 0.82,
             0.64, 0.48, 0.28, 0.14, 0.05, 0];
  var TCD = [0.050, 0.045, 0.075, 0.095, 0.155, 0.240, 0.345, 0.460, 0.580, 0.700,
             0.820, 0.930, 1.030, 1.140, 1.210, 1.235, 1.240];

  function rigTable(aDeg) {
    var a = Math.abs(aDeg);
    if (a > 180) a = 360 - a;
    a = clamp(a, 0, 180);
    var i = 0;
    while (i < TA.length - 2 && TA[i + 1] < a) i++;
    var t = clamp((a - TA[i]) / (TA[i + 1] - TA[i]), 0, 1);
    return { cl: lerp(TCL[i], TCL[i + 1], t), cd: lerp(TCD[i], TCD[i + 1], t) };
  }

  function foilCoeffs(alphaDeg, ARe, eff) {
    var as = 16 * DEG;
    var a = alphaDeg * DEG;
    var sgn = a < 0 ? -1 : 1;
    var aa = Math.min(Math.abs(a), Math.PI * 0.5);
    var CLa = 2 * Math.PI / (1 + 2 / ARe);
    var CLs = CLa * as;
    var CD0 = 0.020;
    var clA = CLa * aa;
    var cdA = CD0 + clA * clA / (Math.PI * ARe * eff);
    var CDmax = 1.11 + 0.018 * ARe;
    var CDs = CD0 + CLs * CLs / (Math.PI * ARe * eff);
    var sa = Math.sin(as), ca = Math.cos(as);
    var A2 = (CLs - CDmax * sa * ca) * sa / (ca * ca);
    var B2 = (CDs - CDmax * sa * sa) / ca;
    var sA = Math.max(Math.sin(aa), 0.02), cA = Math.cos(aa);
    var clP = (CDmax * 0.5) * Math.sin(2 * aa) + A2 * cA * cA / sA;
    var cdP = CDmax * sA * sA + B2 * cA;
    var bl = sstep(as, as + 6 * DEG, aa);
    return { cl: sgn * (clA * (1 - bl) + clP * bl), cd: cdA * (1 - bl) + cdP * bl };
  }
  M.foilCoeffs = foilCoeffs;
  M.rigTable = rigTable;

  function optimalDelta(aAbs, dMax) { return clamp(0.55 * (aAbs - 12.0), 0, dMax); }
  function jibDeltaMax(aAbs) { return SPEC.deltaMaxJib + 30 * sstep(105, 150, aAbs); }

  /* sheet 0 = block to block, sheet 1 = fully eased, delta = sheet*dMax. */
  M.optimalDelta = function (awaDeg) {
    var a = Math.abs(awaDeg || 0), djm = jibDeltaMax(a);
    return {
      main: optimalDelta(a, SPEC.deltaMaxMain), mainMax: SPEC.deltaMaxMain,
      jib: optimalDelta(a, djm), jibMax: djm
    };
  };

  M.autoSheet = function (awaDeg) {
    var a = Math.abs(awaDeg || 0);
    var djm = jibDeltaMax(a);
    return {
      mainSheet: clamp(optimalDelta(a, SPEC.deltaMaxMain) / SPEC.deltaMaxMain, 0, 1),
      jibSheet: clamp(optimalDelta(a, djm) / djm, 0, 1)
    };
  };

  /* ---- 5.  PARAMETRIC SAIL SURFACE ---------------------------------------- */

  /* NACA-family mean line, normalised to 1 at the draft position p. */
  function meanLine(s, p) {
    if (s <= 0 || s >= 1) return 0;
    if (s < p) return (2 * p * s - s * s) / (p * p);
    var q = 1 - p;
    return ((1 - 2 * p) + 2 * p * s - s * s) / (q * q);
  }

  function Sail(opts) {
    this.isMain = !!opts.isMain;
    this.nu = opts.nu; this.nv = opts.nv;
    this.phase = opts.isMain ? 0.0 : 2.1;
    this.area = 0;
    this.ce = new THREE.Vector3(0, 10, 0);
    this.tack = new THREE.Vector3();
    this.head = new THREE.Vector3();
    this.clew = new THREE.Vector3();
    this.tsign = 1;
    this.convexSign = 1;
    this.c0 = 7; this.spanM = 20; this.headW = 1.3;
    this.battH = [];

    var nu = this.nu, nv = this.nv, cnt = (nu + 1) * (nv + 1), i, j;
    var geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(cnt * 3);
    this.nor = new Float32Array(cnt * 3);
    this.nsm = new Float32Array(cnt * 3);
    this.tan = new Float32Array(cnt * 3);
    this.meta = new Float32Array(cnt * 4);
    var uvs = new Float32Array(cnt * 2);
    var idx = new Uint16Array(nu * nv * 6), o = 0;
    for (j = 0; j < nv; j++) {
      for (i = 0; i < nu; i++) {
        var a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
        idx[o++] = a; idx[o++] = c; idx[o++] = b;
        idx[o++] = b; idx[o++] = c; idx[o++] = d;
      }
    }
    for (j = 0; j <= nv; j++) {
      for (i = 0; i <= nu; i++) {
        var k = j * (nu + 1) + i;
        uvs[k * 2] = i / nu;
        uvs[k * 2 + 1] = j / nv;
      }
    }
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(this.nor, 3));
    geo.setAttribute('aTan', new THREE.BufferAttribute(this.tan, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setAttribute('aMeta', new THREE.BufferAttribute(this.meta, 4));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 13, -2), 30);
    this.geo = geo;

    /* rolled leech tape: a 3-vertex ring swept up the leech, so the trailing
       edge has real thickness and a rim against the sky */
    var tg = new THREE.BufferGeometry();
    this.tpos = new Float32Array((nv + 1) * 3 * 3);
    this.tnor = new Float32Array((nv + 1) * 3 * 3);
    var tidx = new Uint16Array(nv * 2 * 6), q = 0;
    for (j = 0; j < nv; j++) {
      var r0 = j * 3, r1 = (j + 1) * 3;
      for (i = 0; i < 2; i++) {
        tidx[q++] = r0 + i; tidx[q++] = r1 + i; tidx[q++] = r0 + i + 1;
        tidx[q++] = r0 + i + 1; tidx[q++] = r1 + i; tidx[q++] = r1 + i + 1;
      }
    }
    tg.setAttribute('position', new THREE.BufferAttribute(this.tpos, 3));
    tg.setAttribute('normal', new THREE.BufferAttribute(this.tnor, 3));
    tg.setAttribute('aTan', new THREE.BufferAttribute(this.tnor, 3));
    tg.setAttribute('uv', new THREE.BufferAttribute(new Float32Array((nv + 1) * 3 * 2), 2));
    tg.setAttribute('aMeta', new THREE.BufferAttribute(new Float32Array((nv + 1) * 3 * 4), 4));
    tg.setIndex(new THREE.BufferAttribute(tidx, 1));
    tg.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 13, -2), 30);
    this.tgeo = tg;
  }

  /* Scratch — nothing is allocated per frame. */
  var _yv = new THREE.Vector3(), _xv = new THREE.Vector3(), _fv = new THREE.Vector3();
  var _dp = new THREE.Vector3(), _pe = new THREE.Vector3(), _d3 = new THREE.Vector3();
  var _cd = new THREE.Vector3(), _p0 = new THREE.Vector3(), _tmp = new THREE.Vector3();
  var _bd = new THREE.Vector3(), _sc = new THREE.Vector3(), _cdMid = new THREE.Vector3();

  Sail.prototype.generate = function (cfg) {
    var nu = this.nu, nv = this.nv;
    var pos = this.pos, nor = this.nor, tan = this.tan, meta = this.meta;
    var i, j, k, midJ = nv >> 1;

    _yv.copy(this.head).sub(this.tack);
    var luffLen = _yv.length();
    if (!(luffLen > 0.2)) return;
    _yv.multiplyScalar(1 / luffLen);

    _fv.copy(this.clew).sub(this.tack);
    var footLen = _fv.length();
    if (!(footLen > 0.2)) return;
    _xv.copy(_fv).addScaledVector(_yv, -_fv.dot(_yv));
    if (_xv.lengthSq() < 1e-6) _xv.set(0, 0, 1).addScaledVector(_yv, -_yv.z);
    _xv.normalize();

    var clewX = _fv.dot(_xv), clewY = _fv.dot(_yv);
    var headX = cfg.headWidth, headY = luffLen;
    var lx = headX - clewX, ly = headY - clewY;
    var ll = Math.hypot(lx, ly) || 1;
    lx /= ll; ly /= ll;
    var mx = ly, my = -lx;
    if (mx < 0) { mx = -mx; my = -my; }

    _pe.crossVectors(_yv, _xv);
    this.tsign = _pe.dot(cfg.leeDir) < 0 ? -1 : 1;
    var tsign = this.tsign;

    _bd.set(0, 0, -1).addScaledVector(_yv, _yv.z);
    if (_bd.lengthSq() < 1e-6) _bd.copy(_xv).negate(); else _bd.normalize();

    /* batten heights in metres up the CURRENT luff (also drives the scallop) */
    var hoistM = cfg.hoistM || luffLen;
    var vx = cfg.vmapX, vy = cfg.vmapY || 1;
    var nb = 0, bh = this.battH;
    if (this.isMain) {
      for (k = 0; k < NBATT; k++) {
        var hh = (BATT[k] - vx) * hoistM;
        if (hh > 0.05 && hh < luffLen - 0.02) bh[nb++] = hh;
      }
    }
    bh.length = nb;
    var halfSp = nb > 1 ? (bh[1] - bh[0]) * 0.5 : 1.6;

    var areaSum = 0, ceX = 0, ceY = 0, ceZ = 0;
    var W = nu + 1;

    for (j = 0; j <= nv; j++) {
      var v = j / nv;
      var luffY = luffLen * v;

      /* roach, scalloped inboard between the batten ends and bulged a little
         where a batten actually pushes the leech out */
      var ro = cfg.roach * Math.pow(Math.sin(Math.PI * Math.pow(v, 0.86)), 0.92);
      if (nb > 0) {
        var dn = 1e9;
        for (k = 0; k < nb; k++) { var dd = Math.abs(luffY - bh[k]); if (dd < dn) dn = dd; }
        ro -= 0.048 * Math.sin(1.5707963 * clamp(dn / halfSp, 0, 1));
        /* the batten pushes the leech out over ~0.22 m of cloth: any tighter
           and the bulge aliases into the row pitch and terraces the leech */
        ro += 0.020 * Math.exp(-(dn / 0.22) * (dn / 0.22));
      } else {
        ro -= 0.030 * Math.sin(Math.PI * v);      /* genoa leech hollow */
      }

      var lex = clewX + lx * ll * v + mx * ro;
      var ley = clewY + ly * ll * v + my * ro;
      var chx = lex, chy = ley - luffY;
      var c = Math.hypot(chx, chy);
      if (c < 0.05) c = 0.05;

      var bow = Math.sin(Math.PI * v);
      _p0.copy(this.tack).addScaledVector(_yv, luffY).addScaledVector(_bd, cfg.bend * bow);

      _d3.set(_xv.x * chx + _yv.x * chy, _xv.y * chx + _yv.y * chy,
              _xv.z * chx + _yv.z * chy).multiplyScalar(1 / c);
      var dy = _d3.dot(_yv);
      _dp.copy(_d3).addScaledVector(_yv, -dy);
      var lp = _dp.length();
      if (lp < 1e-5) { _dp.copy(_xv); lp = 1; }
      _dp.multiplyScalar(1 / lp);
      _pe.crossVectors(_yv, _dp);

      var tw = (cfg.twist0 + cfg.twistRange) * Math.pow(v, 1.22) * DEG * tsign;
      var ct = Math.cos(tw), st = Math.sin(tw);
      _sc.copy(_dp).multiplyScalar(ct).addScaledVector(_pe, st);
      _d3.set(_yv.x * dy, _yv.y * dy, _yv.z * dy).addScaledVector(_sc, lp).normalize();
      _cd.crossVectors(_yv, _sc).multiplyScalar(tsign).normalize();

      _p0.addScaledVector(_cd, cfg.sag * bow);

      var camf = (cfg.camber0 + (cfg.camberTop - cfg.camber0) * Math.pow(v, 1.15)) * cfg.camberScale;
      var pdr = clamp(cfg.draft0 + 0.055 * cfg.load - 0.10 * cfg.sheet - 0.05 * v, 0.26, 0.58);
      var cp = c / (1 + 2.667 * camf * camf);
      var hook = cfg.stall * 0.055 * (1 - 0.6 * v);
      var bubExt = 0.14 + 0.46 * cfg.backwind;
      var flAmp = cfg.luff * (0.055 + 0.085 * cfg.headToWind);
      var fk = this.isMain ? 3.4 : 5.2;
      var fw = this.isMain ? 7.4 : 10.8;
      var tt = cfg.time;

      /* the leech line never lets the trailing edge be a perfect straight
         cut: a low-amplitude travelling curl, growing when she luffs */
      var curlA = (0.016 + 0.060 * cfg.luff + 0.016 * cfg.headToWind) *
                  (0.40 + 0.60 * Math.pow(v, 0.7));
      /* wavelengths of 5.7 m and 2.4 m: long enough that the row pitch always
         resolves them, so the leech breathes instead of shimmering */
      var curlP = Math.sin(luffY * 1.10 - tt * 3.1 + this.phase) +
                  0.5 * Math.sin(luffY * 2.60 - tt * 5.3);

      var useHook = hook > 1e-4, useBub = cfg.backwind > 1e-4, useFl = flAmp > 1e-4;
      var f1a = -fw * tt + 2.4 * v + this.phase, f2a = -fw * 1.41 * tt + 3.9 * v;
      var f3 = 0.85 * Math.sin(fw * 0.71 * tt + 4.2 * v + 1.1);
      var fk1 = fk * Math.PI, fk2 = fk * 1.73 * Math.PI;

      for (i = 0; i <= nu; i++) {
        var u = i / nu;
        var cam = meanLine(u, pdr) * camf;
        if (useHook) cam += hook * sstep(0.60, 1.0, u) * sstep(0.03, 0.12, u);
        if (useBub) cam *= (1 - 2 * cfg.backwind * sstep(bubExt, bubExt * 0.12, u));
        var fl = 0;
        if (useFl) {
          var grow = 0.10 + 1.35 * u * u;
          fl = (Math.sin(fk1 * u + f1a) + 0.42 * Math.sin(fk2 * u + f2a)) * grow;
          fl += sstep(0.70, 1.0, u) * f3;
          fl *= flAmp;
        }
        var le = sstep(0.82, 1.0, u);
        var curl = curlA * le * le * curlP;
        k = (j * W + i) * 3;
        var off = (cam + fl) * cp + curl;
        pos[k]     = _p0.x + _d3.x * cp * u + _cd.x * off;
        pos[k + 1] = _p0.y + _d3.y * cp * u + _cd.y * off;
        pos[k + 2] = _p0.z + _d3.z * cp * u + _cd.z * off;
        tan[k] = _d3.x; tan[k + 1] = _d3.y; tan[k + 2] = _d3.z;
        var m4 = (j * W + i) * 4;
        meta[m4] = c; meta[m4 + 1] = luffY; meta[m4 + 2] = luffLen;
        /* w carries the local camber depth as a fraction of chord — a smooth
           analytic quantity.  The discrete Laplacian that used to live here
           was a per-row noise source and it terraced the whole sail. */
        meta[m4 + 3] = camf;
      }
      if (j === 0) this.c0 = c;
      if (j === midJ) _cdMid.copy(_cd);
    }
    this.spanM = luffLen;
    this.headW = cfg.headWidth;

    /* Smooth surface normals from the parametric tangents.  These are NOT
       face normals — every normal is the cross product of two central
       differences of the flying shape, and because the flying shape is C1
       across battens and panels there is no crease anywhere.  A single 1-2-1
       pass in v afterwards guarantees no row-scale ripple survives even when
       the leech curl runs near the Nyquist of the row pitch. */
    var nsm = this.nsm;
    for (j = 0; j <= nv; j++) {
      for (i = 0; i <= nu; i++) {
        var ia = (j * W + (i > 0 ? i - 1 : i)) * 3;
        var ib = (j * W + (i < nu ? i + 1 : i)) * 3;
        var ja = ((j > 0 ? j - 1 : j) * W + i) * 3;
        var jb = ((j < nv ? j + 1 : j) * W + i) * 3;
        k = (j * W + i) * 3;
        var ux = pos[ib] - pos[ia], uy = pos[ib + 1] - pos[ia + 1], uz = pos[ib + 2] - pos[ia + 2];
        var wx = pos[jb] - pos[ja], wy = pos[jb + 1] - pos[ja + 1], wz = pos[jb + 2] - pos[ja + 2];
        var nx = wy * uz - wz * uy, ny = wz * ux - wx * uz, nz = wx * uy - wy * ux;
        var il = 1 / (Math.sqrt(nx * nx + ny * ny + nz * nz) || 1);
        nsm[k] = nx * il; nsm[k + 1] = ny * il; nsm[k + 2] = nz * il;
      }
    }
    for (j = 0; j <= nv; j++) {
      var jm = (j > 0 ? j - 1 : j) * W * 3, jp = (j < nv ? j + 1 : j) * W * 3, jc = j * W * 3;
      for (i = 0; i <= nu; i++) {
        var o3 = i * 3;
        var sx = nsm[jm + o3] + 2 * nsm[jc + o3] + nsm[jp + o3];
        var sy = nsm[jm + o3 + 1] + 2 * nsm[jc + o3 + 1] + nsm[jp + o3 + 1];
        var sz = nsm[jm + o3 + 2] + 2 * nsm[jc + o3 + 2] + nsm[jp + o3 + 2];
        var sl2 = 1 / (Math.sqrt(sx * sx + sy * sy + sz * sz) || 1);
        k = jc + o3;
        nor[k] = sx * sl2; nor[k + 1] = sy * sl2; nor[k + 2] = sz * sl2;
      }
    }

    /* which face of the aerofoil is the concave, sky-starved bowl: one sign
       for the whole sail, taken at mid hoist */
    var kMid = (midJ * W + (nu >> 1)) * 3;
    var cvs = nor[kMid] * _cdMid.x + nor[kMid + 1] * _cdMid.y + nor[kMid + 2] * _cdMid.z;
    this.convexSign = cvs < 0 ? -1 : 1;

    /* geometric area and area-weighted centre of effort */
    for (j = 0; j < nv; j++) {
      for (i = 0; i < nu; i++) {
        var k00 = (j * W + i) * 3, k10 = k00 + 3, k01 = ((j + 1) * W + i) * 3, k11 = k01 + 3;
        var ax = pos[k10] - pos[k00], ay = pos[k10 + 1] - pos[k00 + 1], az = pos[k10 + 2] - pos[k00 + 2];
        var bx = pos[k01] - pos[k00], by = pos[k01 + 1] - pos[k00 + 1], bz = pos[k01 + 2] - pos[k00 + 2];
        var qx = ay * bz - az * by, qy = az * bx - ax * bz, qz = ax * by - ay * bx;
        var a1 = 0.5 * Math.sqrt(qx * qx + qy * qy + qz * qz);
        ax = pos[k10] - pos[k11]; ay = pos[k10 + 1] - pos[k11 + 1]; az = pos[k10 + 2] - pos[k11 + 2];
        bx = pos[k01] - pos[k11]; by = pos[k01 + 1] - pos[k11 + 1]; bz = pos[k01 + 2] - pos[k11 + 2];
        qx = ay * bz - az * by; qy = az * bx - ax * bz; qz = ax * by - ay * bx;
        var a2 = 0.5 * Math.sqrt(qx * qx + qy * qy + qz * qz);
        areaSum += a1 + a2;
        ceX += a1 * (pos[k00] + pos[k10] + pos[k01]) / 3 + a2 * (pos[k11] + pos[k10] + pos[k01]) / 3;
        ceY += a1 * (pos[k00 + 1] + pos[k10 + 1] + pos[k01 + 1]) / 3 +
               a2 * (pos[k11 + 1] + pos[k10 + 1] + pos[k01 + 1]) / 3;
        ceZ += a1 * (pos[k00 + 2] + pos[k10 + 2] + pos[k01 + 2]) / 3 +
               a2 * (pos[k11 + 2] + pos[k10 + 2] + pos[k01 + 2]) / 3;
      }
    }
    this.area = areaSum;
    if (areaSum > 1e-3) this.ce.set(ceX / areaSum, ceY / areaSum, ceZ / areaSum);

    this.fillTape();

    var at = this.geo.attributes;
    at.position.needsUpdate = true;
    at.normal.needsUpdate = true;
    at.aTan.needsUpdate = true;
    at.aMeta.needsUpdate = true;
  };

  /* Sweep the rolled tape ring up the leech from the finished cloth. */
  Sail.prototype.fillTape = function () {
    var nu = this.nu, nv = this.nv, W = nu + 1;
    var pos = this.pos, nor = this.nor;
    var tp = this.tpos, tn = this.tnor;
    var TH = 0.0042, IN = 0.024, OUT = 0.005;
    for (var j = 0; j <= nv; j++) {
      var ke = (j * W + nu) * 3, ki = (j * W + nu - 1) * 3;
      var dx = pos[ke] - pos[ki], dy = pos[ke + 1] - pos[ki + 1], dz = pos[ke + 2] - pos[ki + 2];
      var dl = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      dx /= dl; dy /= dl; dz /= dl;
      var nx = nor[ke], ny = nor[ke + 1], nz = nor[ke + 2];
      var ix = pos[ke] - dx * IN, iy = pos[ke + 1] - dy * IN, iz = pos[ke + 2] - dz * IN;
      var ox = pos[ke] + dx * OUT, oy = pos[ke + 1] + dy * OUT, oz = pos[ke + 2] + dz * OUT;
      var b = j * 9;
      tp[b] = ix + nx * TH; tp[b + 1] = iy + ny * TH; tp[b + 2] = iz + nz * TH;
      tp[b + 3] = ox;       tp[b + 4] = oy;           tp[b + 5] = oz;
      tp[b + 6] = ix - nx * TH; tp[b + 7] = iy - ny * TH; tp[b + 8] = iz - nz * TH;
      tn[b] = nx; tn[b + 1] = ny; tn[b + 2] = nz;
      tn[b + 3] = dx; tn[b + 4] = dy; tn[b + 5] = dz;
      tn[b + 6] = -nx; tn[b + 7] = -ny; tn[b + 8] = -nz;
    }
    this.tgeo.attributes.position.needsUpdate = true;
    this.tgeo.attributes.normal.needsUpdate = true;
    this.tgeo.attributes.aTan.needsUpdate = true;
  };

  /* ---- 6.  MODULE STATE ---------------------------------------- */

  M.ready = false;
  M.rig = { boomAngleRad: 0, boomDrop: 0, mainHoist: 1, jibFurl: 0, reef: 0, tackSign: 1 };

  var group = null, parent = null;
  var main = null, jib = null;
  var matMain = null, matJib = null, matTapeM = null, matTapeJ = null;
  var matBundle = null, matTell = null, matHW = null, matHWdk = null, matDepth = null;
  var bunt = null, roll = null, tellMesh = null, tellPos = null, tellCol = null;
  var clothTex = null, rumpTex = null, markTex = null;
  var headboard = null, slides = null, caps = null, cringles = [];
  var aero = blankAero();
  var quality = 'high';
  var tackSign = 1;

  var pMastTop = new THREE.Vector3(), pGoose = new THREE.Vector3();
  var pBoomEnd = new THREE.Vector3(), pStayTack = new THREE.Vector3();
  var pJibHead = new THREE.Vector3();
  var _lee = new THREE.Vector3(-1, 0, 0), _q = new THREE.Quaternion();
  var _UP = new THREE.Vector3(0, 1, 0);
  var _mA = new THREE.Matrix4(), _vA = new THREE.Vector3(), _vB = new THREE.Vector3();
  var _vC = new THREE.Vector3();

  var envC = {
    sunDir: new THREE.Vector3(0.34, 0.78, -0.52).normalize(),
    sunCol: new THREE.Color(1.0, 0.955, 0.90),
    skyCol: new THREE.Color(0.34, 0.52, 0.86),
    horCol: new THREE.Color(0.62, 0.70, 0.82),
    seaCol: new THREE.Color(0.09, 0.30, 0.36),
    sunE: 100, skyE: 12
  };

  function readEnv() {
    var e = SAIL.env || {};
    var sky = SAIL.sky || {};
    var sd = e.sunDir || sky.sunDir;
    if (sd && isFinite(sd.x) && isFinite(sd.y) && isFinite(sd.z) &&
        (sd.x * sd.x + sd.y * sd.y + sd.z * sd.z) > 1e-6) {
      envC.sunDir.set(sd.x, sd.y, sd.z).normalize();
    }
    var el = clamp(envC.sunDir.y, -0.4, 1);
    var warm = sstep(0.34, 0.02, el);
    var night = sstep(0.03, -0.10, el);

    envC.skyCol.setRGB(lerp(0.30, 0.42, warm), lerp(0.50, 0.40, warm), lerp(0.88, 0.62, warm));
    envC.horCol.setRGB(lerp(0.60, 0.96, warm), lerp(0.70, 0.56, warm), lerp(0.84, 0.42, warm));
    if (night > 0) {
      envC.skyCol.multiplyScalar(lerp(1, 0.30, night)).addScalar(0.02 * night);
      envC.horCol.multiplyScalar(lerp(1, 0.22, night));
    }
    if (e.sunColor && e.sunColor.isColor) envC.sunCol.copy(e.sunColor);
    else envC.sunCol.setRGB(1.0, lerp(0.955, 0.62, warm), lerp(0.90, 0.32, warm));

    envC.sunE = (typeof e.sunE === 'number' && isFinite(e.sunE)) ? e.sunE : 100 * (1 - night);
    envC.skyE = (typeof e.skyE === 'number' && isFinite(e.skyE)) ? e.skyE : lerp(12, 0.35, night);
  }

  function pushEnv(u) {
    if (!u) return;
    u.uSunDir.value.copy(envC.sunDir);
    u.uSunCol.value.set(envC.sunCol.r, envC.sunCol.g, envC.sunCol.b);
    u.uSkyCol.value.set(envC.skyCol.r, envC.skyCol.g, envC.skyCol.b);
    if (u.uHorizCol) u.uHorizCol.value.set(envC.horCol.r, envC.horCol.g, envC.horCol.b);
    if (u.uSeaCol) u.uSeaCol.value.set(envC.seaCol.r, envC.seaCol.g, envC.seaCol.b);
    u.uSunE.value = envC.sunE;
    u.uSkyE.value = envC.skyE;
  }

  /* Feed the sun cascade three already renders into our own shader so the
     main can shade the jib, the mast can shade the main, and a shadowed sail
     still glows on its transmission term instead of going black. */
  function pushShadow(u) {
    if (!u || !u.uShadowOn) return;
    var lt = SAIL.sky && SAIL.sky.sunLight;
    if (lt && lt.castShadow && lt.shadow && lt.shadow.map && lt.shadow.map.texture) {
      u.uShadowMap.value = lt.shadow.map.texture;
      u.uShadowMat.value.copy(lt.shadow.matrix);
      u.uShTexel.value = 1 / Math.max(lt.shadow.mapSize.x, 1);
      u.uShadowOn.value = 1;
    } else {
      u.uShadowOn.value = 0;
    }
  }

  /* 12 shadow-casting capsules: mast, boom, two spreader pairs, cap shrouds,
     diagonals, forestay foil, topping lift.  One shared world-space array for
     every sail material — pushRig() refills it once per frame. */
  var SEGA = null, SEGB = null;
  function initSegs() {
    if (SEGA) return;
    SEGA = []; SEGB = [];
    for (var i = 0; i < 12; i++) {
      SEGA.push(new THREE.Vector4(0, -1000, 0, 0));
      SEGB.push(new THREE.Vector4(0, -1000, 0, 0));
    }
  }

  function sailMaterial(isMain, isTape) {
    var m = new THREE.ShaderMaterial({
      uniforms: {
        uSunDir: { value: envC.sunDir.clone() },
        uSunCol: { value: new THREE.Vector3(1, 0.955, 0.9) },
        uSkyCol: { value: new THREE.Vector3(0.34, 0.52, 0.86) },
        uHorizCol: { value: new THREE.Vector3(0.62, 0.70, 0.82) },
        uSeaCol: { value: new THREE.Vector3(0.09, 0.30, 0.36) },
        uBase: { value: isMain ? new THREE.Vector3(0.862, 0.856, 0.822)
                               : new THREE.Vector3(0.852, 0.846, 0.812) },
        uTint: { value: new THREE.Vector3(1.00, 0.955, 0.865) },
        /* diffuse-transmission albedo: warm white, a shade under 0.6, and a
           little more open on the lighter genoa cloth */
        uTransCol: { value: isMain ? new THREE.Vector3(0.60, 0.56, 0.475)
                                   : new THREE.Vector3(0.65, 0.61, 0.515) },
        uSigma: { value: 0.62 },
        uAmbK: { value: 0.60 },
        uConvex: { value: 1 },
        uSlot: { value: 0 },
        uSunE: { value: 100 }, uSkyE: { value: 12 },
        uLuff: { value: 0 }, uStall: { value: 0 }, uLoad: { value: 0.4 },
        uIsMain: { value: isMain ? 1 : 0 },
        uIsTape: { value: isTape ? 1 : 0 },
        uPanel: { value: isMain ? 0.88 : 0.80 },
        uSeamSlope: { value: isMain ? 0.155 : 0.0 },
        uStripe: { value: isMain ? 1 : 0 },
        uSunStrip: { value: isMain ? 0 : 1 },
        uClothM: { value: SCRIM_M },
        uRumpM: { value: RUMP_M },
        uHoistM: { value: isMain ? 20.0 : 20.3 },
        uReefV: { value: new THREE.Vector2(-1, -1) },
        uVMap: { value: new THREE.Vector2(0, 1) },
        uCH: { value: new THREE.Vector2(0.6, 19) },
        uCT: { value: new THREE.Vector2(0, 0) },
        uCC: { value: new THREE.Vector2(7, 0) },
        uMarkRect: { value: isMain ? new THREE.Vector4(0.95, 8.7, 5.35, 14.0)
                                   : new THREE.Vector4(-9, -9, -8, -8) },
        uBattV: { value: BATT.slice() },
        uStripV: { value: STRIPE_V.slice() },
        uCloth: { value: clothTex },
        uRump: { value: rumpTex },
        uMark: { value: markTex },
        uShadowMap: { value: null },
        uShadowMat: { value: new THREE.Matrix4() },
        uShadowOn: { value: 0 },
        uShTexel: { value: 1 / 2048 },
        uSegA: { value: SEGA },
        uSegB: { value: SEGB },
        uQ0: { value: new THREE.Vector3() },
        uQ1: { value: new THREE.Vector3() },
        uQ2: { value: new THREE.Vector3() },
        uQ3: { value: new THREE.Vector3() },
        uQOn: { value: 0 }
      },
      vertexShader: VS_SAIL,
      fragmentShader: FS_SAIL,
      side: THREE.DoubleSide,
      transparent: false,
      toneMapped: false
    });
    if (quality !== 'low') m.defines = { HQ: '' };
    return m;
  }

  function bundleMaterial() {
    return new THREE.ShaderMaterial({
      uniforms: {
        uSunDir: { value: envC.sunDir.clone() },
        uSunCol: { value: new THREE.Vector3(1, 0.955, 0.9) },
        uSkyCol: { value: new THREE.Vector3(0.34, 0.52, 0.86) },
        uHorizCol: { value: new THREE.Vector3(0.62, 0.70, 0.82) },
        uBase: { value: new THREE.Vector3(0.74, 0.735, 0.71) },
        uStripCol: { value: new THREE.Vector3(0.035, 0.055, 0.115) },
        uSunE: { value: 100 }, uSkyE: { value: 12 },
        uTwist: { value: 6.0 }, uFold: { value: 70.0 }, uStripAmt: { value: 0.0 }
      },
      vertexShader: VS_BUNDLE,
      fragmentShader: FS_BUNDLE,
      side: THREE.DoubleSide,
      toneMapped: false
    });
  }

  /* ---- 7.  BUILD ---------------------------------------- */

  var TELL_SEG = 5, TELL_JIB = 3, TELL_MLUFF = 3;
  var NTELL = TELL_JIB * 2 + TELL_MLUFF * 2 + NBATT;

  function buildTelltales() {
    var verts = NTELL * TELL_SEG * 6;
    tellPos = new Float32Array(verts * 3);
    tellCol = new Float32Array(verts * 3);
    var nrm = new Float32Array(verts * 3);
    for (var i = 0; i < verts; i++) { nrm[i * 3] = 1; }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(tellPos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('aCol', new THREE.BufferAttribute(tellCol, 3));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 13, -2), 30);
    matTell = new THREE.ShaderMaterial({
      uniforms: {
        uSunDir: { value: envC.sunDir.clone() },
        uSunCol: { value: new THREE.Vector3(1, 0.955, 0.9) },
        uSkyCol: { value: new THREE.Vector3(0.34, 0.52, 0.86) },
        uSunE: { value: 100 }, uSkyE: { value: 12 }
      },
      vertexShader: VS_TELL, fragmentShader: FS_TELL,
      side: THREE.DoubleSide, toneMapped: false
    });
    tellMesh = new THREE.Mesh(g, matTell);
    tellMesh.name = 'sailTelltales';
    tellMesh.castShadow = false;
    tellMesh.receiveShadow = false;
    tellMesh.renderOrder = 2;
    return tellMesh;
  }

  /* Headboard, luff slides, batten end caps and corner cringles: real
     geometry so the sail visibly attaches to the spar. */
  function buildHardware() {
    var env = (SAIL.sky && SAIL.sky.envMap) || null;
    matHW = new THREE.MeshPhysicalMaterial({
      color: 0xb7bec4, roughness: 0.36, metalness: 1.0, envMap: env
    });
    matHWdk = new THREE.MeshPhysicalMaterial({
      color: 0x28313a, roughness: 0.52, metalness: 0.15, envMap: env
    });

    headboard = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.30, 0.115), matHW);
    headboard.name = 'headboard';
    headboard.castShadow = true;
    group.add(headboard);

    var nSl = 26;
    slides = new THREE.InstancedMesh(new THREE.BoxGeometry(0.052, 0.062, 0.046), matHWdk, nSl);
    slides.name = 'luffSlides';
    slides.castShadow = true;
    slides.frustumCulled = false;
    slides.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    group.add(slides);

    caps = new THREE.InstancedMesh(new THREE.BoxGeometry(0.030, 0.086, 0.052), matHWdk, NBATT);
    caps.name = 'battenCaps';
    caps.castShadow = true;
    caps.frustumCulled = false;
    caps.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    group.add(caps);

    var ring = new THREE.TorusGeometry(0.040, 0.011, 6, 14);
    for (var i = 0; i < 4; i++) {
      var c = new THREE.Mesh(ring, matHW);
      c.castShadow = true;
      c.name = 'cringle' + i;
      cringles.push(c);
      group.add(c);
    }
  }

  /* Orient an object so +Y runs along `up` and +Z along `fwd`. */
  function placeOriented(obj, px, py, pz, ux, uy, uz, fx, fy, fz) {
    _vA.set(ux, uy, uz);
    if (_vA.lengthSq() < 1e-8) _vA.set(0, 1, 0);
    _vA.normalize();
    _vC.set(fx, fy, fz);
    if (_vC.lengthSq() < 1e-8) _vC.set(0, 0, 1);
    _vB.crossVectors(_vA, _vC);
    if (_vB.lengthSq() < 1e-8) _vB.set(1, 0, 0);
    _vB.normalize();
    _vC.crossVectors(_vB, _vA).normalize();
    _mA.makeBasis(_vB, _vA, _vC);
    obj.quaternion.setFromRotationMatrix(_mA);
    obj.position.set(px, py, pz);
  }

  M.build = function (yachtGroup) {
    try {
      quality = (SAIL.quality === 'low') ? 'low' : 'high';
      initSegs();
      parent = yachtGroup || (SAIL.yacht && SAIL.yacht.group) || SAIL.scene || null;

      group = new THREE.Group();
      group.name = 'sails';

      clothTex = makeClothTexture(quality === 'low' ? 256 : 512);
      rumpTex = makeRumpleTexture(quality === 'low' ? 128 : 256);
      markTex = makeMarkTexture(quality === 'low' ? 256 : 512);

      /* 40 x 64 and 36 x 56 quads: chordwise density is what carries the
         aerofoil, vertical density is what killed the stair-step ribs. */
      var hi = quality !== 'low';
      main = new Sail({ isMain: true, nu: hi ? 40 : 26, nv: hi ? 64 : 34 });
      jib = new Sail({ isMain: false, nu: hi ? 36 : 24, nv: hi ? 56 : 30 });

      matMain = sailMaterial(true, false);
      matJib = sailMaterial(false, false);
      matTapeM = sailMaterial(true, true);
      matTapeJ = sailMaterial(false, true);
      matBundle = bundleMaterial();
      matDepth = new THREE.ShaderMaterial({
        uniforms: { uLdir: { value: envC.sunDir.clone() }, uOff: { value: 0.40 } },
        vertexShader: VS_DEPTH, fragmentShader: FS_DEPTH, side: THREE.DoubleSide
      });

      main.mesh = new THREE.Mesh(main.geo, matMain);
      jib.mesh = new THREE.Mesh(jib.geo, matJib);
      main.tape = new THREE.Mesh(main.tgeo, matTapeM);
      jib.tape = new THREE.Mesh(jib.tgeo, matTapeJ);
      main.mesh.name = 'mainsail'; jib.mesh.name = 'genoa';
      main.tape.name = 'mainLeechTape'; jib.tape.name = 'genoaLeechTape';
      main.mesh.castShadow = jib.mesh.castShadow = true;
      main.tape.castShadow = jib.tape.castShadow = true;
      main.mesh.customDepthMaterial = matDepth;
      jib.mesh.customDepthMaterial = matDepth;
      main.tape.customDepthMaterial = matDepth;
      jib.tape.customDepthMaterial = matDepth;
      main.mesh.receiveShadow = jib.mesh.receiveShadow = false;
      group.add(main.mesh); group.add(jib.mesh);
      group.add(main.tape); group.add(jib.tape);

      var cyl = new THREE.CylinderGeometry(1, 1, 1, 14, 1, true);
      bunt = new THREE.Mesh(cyl, matBundle);
      roll = new THREE.Mesh(cyl, matBundle.clone());
      roll.material.uniforms.uTwist.value = 9.0;
      roll.material.uniforms.uFold.value = 44.0;
      bunt.name = 'reefBunt'; roll.name = 'furledGenoa';
      bunt.visible = false; roll.visible = false;
      bunt.castShadow = roll.castShadow = true;
      group.add(bunt); group.add(roll);
      group.add(buildTelltales());
      buildHardware();

      if (parent) parent.add(group);
      M.group = group;
      M.parts = {
        main: main.mesh, jib: jib.mesh, mainTape: main.tape, jibTape: jib.tape,
        bunt: bunt, roll: roll, telltales: tellMesh, headboard: headboard,
        slides: slides, battenCaps: caps
      };
      M.ready = true;

      M.update(0, 0, { awaDeg: 42, awsMs: 8, reef: 0 });
    } catch (e) {
      M.ready = false;
      if (window.console) console.warn('[SAIL.sails] build failed:', e);
    }
    return M;
  };

  function disposeAll() {
    if (!group) return;
    if (parent) parent.remove(group);
    group.traverse(function (o) { if (o.geometry) o.geometry.dispose(); });
    var mats = [matMain, matJib, matTapeM, matTapeJ, matBundle, matTell, matHW, matHWdk, matDepth];
    for (var i = 0; i < mats.length; i++) if (mats[i]) mats[i].dispose();
    if (roll && roll.material) roll.material.dispose();
    if (clothTex) clothTex.dispose();
    if (rumpTex) rumpTex.dispose();
    if (markTex) markTex.dispose();
    cringles.length = 0;
    group = null;
    M.ready = false;
  }

  M.rebuild = function () {
    var p = parent;
    disposeAll();
    return M.build(p);
  };
  M.dispose = disposeAll;

  /* ---- 8.  RIG ATTACHMENT ---------------------------------------- */

  function findPart(name) {
    var p = null;
    if (SAIL.yacht) {
      if (SAIL.yacht.parts && SAIL.yacht.parts[name]) p = SAIL.yacht.parts[name];
      else if (SAIL.yacht[name] && SAIL.yacht[name].isObject3D) p = SAIL.yacht[name];
    }
    if (!p && parent) {
      if (parent.userData && parent.userData.parts && parent.userData.parts[name]) {
        p = parent.userData.parts[name];
      } else if (parent.getObjectByName) {
        p = parent.getObjectByName(name);
      }
    }
    return (p && p.isObject3D) ? p : null;
  }

  function resolve(name, out, fallback) {
    var p = findPart(name);
    if (p && group) {
      p.getWorldPosition(out);
      group.worldToLocal(out);
      if (isFinite(out.x) && isFinite(out.y) && isFinite(out.z)) return true;
    }
    out.copy(fallback);
    return false;
  }

  /* ---- 9.  UPDATE ---------------------------------------- */

  var cfgM = { headWidth: 1.35, roach: 1.05, camber0: 0.132, camberTop: 0.090, draft0: 0.45,
               twist0: 5, twistRange: 0, camberScale: 1, sheet: 1, luff: 0, stall: 0,
               backwind: 0, headToWind: 0, load: 0.4, sag: 0, bend: 0, time: 0,
               hoistM: 20, vmapX: 0, vmapY: 1,
               leeDir: new THREE.Vector3(-1, 0, 0) };
  /* draft: main 13 % at 45 % aft, genoa 15 % at 36 % aft — the flying shapes a
     sailmaker would actually cut for these two sails */
  var cfgJ = { headWidth: 0.10, roach: 0.30, camber0: 0.152, camberTop: 0.100, draft0: 0.36,
               twist0: 6, twistRange: 0, camberScale: 1, sheet: 1, luff: 0, stall: 0,
               backwind: 0, headToWind: 0, load: 0.4, sag: 0, bend: 0, time: 0,
               hoistM: 20.3, vmapX: 0, vmapY: 1,
               leeDir: new THREE.Vector3(-1, 0, 0) };

  function setCorners(u, s) {
    u.uCT.value.set(0, 0);
    u.uCC.value.set(s.c0, 0);
    u.uCH.value.set(s.headW * 0.5, s.spanM);
  }

  /* Slides up the mast track, batten end caps at the leech, headboard at the
     head and cringles in the loaded corners. */
  function placeHardware(showMain, showJib, hoistF) {
    var i, k, W, ke;
    if (headboard) {
      headboard.visible = showMain;
      if (showMain) {
        W = main.nu + 1;
        var jt = main.nv, k0 = (jt * W) * 3, k1 = (jt * W + 1) * 3;
        placeOriented(headboard,
          main.head.x, main.head.y, main.head.z,
          main.head.x - main.tack.x, main.head.y - main.tack.y, main.head.z - main.tack.z,
          main.pos[k1] - main.pos[k0], main.pos[k1 + 1] - main.pos[k0 + 1],
          main.pos[k1 + 2] - main.pos[k0 + 2]);
        headboard.position.addScaledVector(_vC, 0.055);
      }
    }
    if (slides) {
      slides.visible = showMain;
      if (showMain) {
        W = main.nu + 1;
        var span = main.spanM, pitch = 0.55;
        var n = Math.min(slides.count, Math.max(2, Math.floor(span / pitch)));
        for (i = 0; i < slides.count; i++) {
          if (i < n) {
            var v = (i + 0.35) / n;
            var j = clamp(Math.round(v * main.nv), 0, main.nv);
            ke = (j * W) * 3;
            var kb = (j * W + 1) * 3;
            placeOriented(slides,
              main.pos[ke], main.pos[ke + 1], main.pos[ke + 2],
              main.head.x - main.tack.x, main.head.y - main.tack.y, main.head.z - main.tack.z,
              main.pos[ke] - main.pos[kb], main.pos[ke + 1] - main.pos[kb + 1],
              main.pos[ke + 2] - main.pos[kb + 2]);
            slides.position.addScaledVector(_vC, 0.030);
            slides.updateMatrix();
            slides.setMatrixAt(i, slides.matrix);
          } else {
            _mA.makeScale(0, 0, 0);
            slides.setMatrixAt(i, _mA);
          }
        }
        slides.position.set(0, 0, 0);
        slides.quaternion.identity();
        slides.updateMatrix();
        slides.instanceMatrix.needsUpdate = true;
      }
    }
    if (caps) {
      caps.visible = showMain;
      if (showMain) {
        W = main.nu + 1;
        var bhA = main.battH, nb = bhA.length;
        for (k = 0; k < caps.count; k++) {
          if (k < nb && main.spanM > 0.5) {
            var jj = clamp(Math.round((bhA[k] / main.spanM) * main.nv), 0, main.nv);
            ke = (jj * W + main.nu) * 3;
            var ki = (jj * W + main.nu - 1) * 3;
            placeOriented(caps,
              main.pos[ke], main.pos[ke + 1], main.pos[ke + 2],
              main.head.x - main.tack.x, main.head.y - main.tack.y, main.head.z - main.tack.z,
              main.pos[ke] - main.pos[ki], main.pos[ke + 1] - main.pos[ki + 1],
              main.pos[ke + 2] - main.pos[ki + 2]);
            caps.position.addScaledVector(_vC, -0.020);
            caps.updateMatrix();
            caps.setMatrixAt(k, caps.matrix);
          } else {
            _mA.makeScale(0, 0, 0);
            caps.setMatrixAt(k, _mA);
          }
        }
        caps.position.set(0, 0, 0);
        caps.quaternion.identity();
        caps.updateMatrix();
        caps.instanceMatrix.needsUpdate = true;
      }
    }
    var src = [
      { on: showMain, p: main.tack, a: main.clew },
      { on: showMain, p: main.clew, a: main.tack },
      { on: showJib, p: jib.tack, a: jib.clew },
      { on: showJib, p: jib.clew, a: jib.tack }
    ];
    for (i = 0; i < cringles.length; i++) {
      var c = cringles[i], d = src[i];
      c.visible = !!d.on;
      if (!d.on) continue;
      placeOriented(c, d.p.x, d.p.y, d.p.z, 0, 1, 0,
                    d.a.x - d.p.x, d.a.y - d.p.y, d.a.z - d.p.z);
      c.position.addScaledVector(_vC, 0.075);
      c.rotateX(Math.PI * 0.5);
    }
  }

  /* ---- rig shadow casters -------------------------------------------------
     Every spar and wire that can drop a bar across the cloth, as world-space
     capsules.  This is a rig-sized cascade in all but name: the mast bar is
     crisp because the mast is 0.3 m off the luff, the shroud lines wash out
     with distance through the sun's angular diameter, and none of it depends
     on the world shadow map having any resolution left at this scale. */
  var _sA = new THREE.Vector3(), _sB = new THREE.Vector3();
  var SPRD = [[11.60, 2.30, 1.00, 0.050], [18.20, 1.85, 0.80, 0.045]];

  function seg(i, ax, ay, az, bx, by, bz, r, soft) {
    if (i >= 12) return i;
    _sA.set(ax, ay, az); group.localToWorld(_sA);
    _sB.set(bx, by, bz); group.localToWorld(_sB);
    SEGA[i].set(_sA.x, _sA.y, _sA.z, r);
    SEGB[i].set(_sB.x, _sB.y, _sB.z, soft || 0);
    return i + 1;
  }

  function pushRig() {
    var n = 0, s, k;
    var mz = pMastTop.z, mx = pMastTop.x;
    n = seg(n, mx, 3.55, mz, pMastTop.x, pMastTop.y, pMastTop.z, 0.185, 0.004);
    n = seg(n, pGoose.x, pGoose.y, pGoose.z, pBoomEnd.x, pBoomEnd.y, pBoomEnd.z, 0.205, 0.010);
    for (k = 0; k < 2; k++) {
      for (s = -1; s <= 1; s += 2) {
        n = seg(n, mx + s * 0.12, SPRD[k][0], mz,
                   mx + s * SPRD[k][1], SPRD[k][0] - 0.10, mz + SPRD[k][2],
                   SPRD[k][3], 0.006);
      }
    }
    for (s = -1; s <= 1; s += 2) {
      n = seg(n, mx, pMastTop.y - 0.25, mz, s * 3.85, 1.72, 0.60, 0.014, 0.012);
    }
    for (s = -1; s <= 1; s += 2) {
      n = seg(n, mx + s * 0.15, SPRD[0][0], mz, s * 2.90, 1.70, 0.42, 0.011, 0.012);
    }
    n = seg(n, pStayTack.x, pStayTack.y + 0.55, pStayTack.z,
               pJibHead.x, pJibHead.y - 0.40, pJibHead.z + 0.12, 0.033, 0.006);
    n = seg(n, mx, pMastTop.y - 0.30, mz, pBoomEnd.x, pBoomEnd.y + 0.22, pBoomEnd.z, 0.010, 0.014);
    for (; n < 12; n++) { SEGA[n].set(0, -1000, 0, 0); SEGB[n].set(0, -1000, 0, 0); }
  }

  /* The other sail as a world-space quad (tack, clew, leech head, head),
     lifted to the mid-camber surface so the cast silhouette lands where the
     cloth actually is. */
  var _qa = new THREE.Vector3(), _qb = new THREE.Vector3(), _qn = new THREE.Vector3();
  var _qe = new THREE.Vector3();
  function fillQuad(u, s, on) {
    if (!on || !s || s.spanM < 0.5) { u.uQOn.value = 0; return; }
    var W = s.nu + 1, nv = s.nv, nu = s.nu, p = s.pos, i, k;
    var idx = [0, nu, nv * W + nu, nv * W];
    var dst = [u.uQ0.value, u.uQ1.value, u.uQ2.value, u.uQ3.value];
    for (i = 0; i < 4; i++) {
      k = idx[i] * 3;
      _qa.set(p[k], p[k + 1], p[k + 2]);
      group.localToWorld(_qa);
      dst[i].copy(_qa);
    }
    /* slide the plane onto the mid-camber surface, or the cast silhouette
       lands half a metre off where the cloth really is */
    _qn.copy(dst[1]).sub(dst[0]).cross(_qe.copy(dst[3]).sub(dst[0]));
    if (_qn.lengthSq() < 1e-6) { u.uQOn.value = 0; return; }
    _qn.normalize();
    k = ((nv >> 1) * W + (nu >> 1)) * 3;
    _qb.set(p[k], p[k + 1], p[k + 2]);
    group.localToWorld(_qb);
    var d = _qb.sub(dst[0]).dot(_qn) * 0.80;
    for (i = 0; i < 4; i++) dst[i].addScaledVector(_qn, d);
    u.uQOn.value = 1;
  }

  M.update = function (t, dt, trim) {
    if (!M.ready || !group) return;
    try {
      if ((SAIL.quality === 'low') !== (quality === 'low')) { M.rebuild(); return; }
      trim = trim || {};
      t = (typeof t === 'number' && isFinite(t)) ? t : 0;
      readEnv();

      var awa = (typeof trim.awaDeg === 'number' && isFinite(trim.awaDeg)) ? trim.awaDeg : 45;
      while (awa > 180) awa -= 360;
      while (awa < -180) awa += 360;
      var aAbs = Math.abs(awa);
      var aws = clamp((typeof trim.awsMs === 'number' && isFinite(trim.awsMs)) ? trim.awsMs : 7, 0, 60);
      var reefN = Number(trim.reef);
      var reef = clamp(Math.round(isFinite(reefN) ? reefN : 0), 0, 3);
      var furlN = Number(typeof trim.jibFurl !== 'undefined' ? trim.jibFurl : trim.furl);
      var furl = clamp(isFinite(furlN) ? furlN : 0, 0, 1);

      if (Math.abs(Math.sin(awa * DEG)) > 0.03) tackSign = awa >= 0 ? 1 : -1;
      var lsign = -tackSign;
      _lee.set(-Math.sin(awa * DEG) + lsign * 0.35, 0, Math.cos(awa * DEG)).normalize();

      group.updateWorldMatrix(true, false);
      resolve('mastTop', pMastTop, RIG.mastTop);
      resolve('gooseneck', pGoose, RIG.gooseneck);
      resolve('boomEnd', pBoomEnd, RIG.boomEnd);
      resolve('forestayTack', pStayTack, RIG.forestayTack);
      if (!resolve('forestayHead', pJibHead, RIG.forestayHead)) {
        _tmp.copy(pMastTop).sub(pStayTack);
        pJibHead.copy(pStayTack).addScaledVector(_tmp, 0.955);
      }
      var footLen = pGoose.distanceTo(pBoomEnd);
      if (!(footLen > 1)) footLen = SPEC.footE;
      var boomDroop = (pBoomEnd.y - pGoose.y) / footLen;

      var djMax = jibDeltaMax(aAbs);
      var dmOpt = optimalDelta(aAbs, SPEC.deltaMaxMain);
      var djOpt = optimalDelta(aAbs, djMax);
      var msN = Number(trim.mainSheet), jsN = Number(trim.jibSheet);
      var haveM = isFinite(msN), haveJ = isFinite(jsN);
      var auto = trim.autoTrim === true || (!haveM && !haveJ);
      var sheetM = (auto || !haveM) ? clamp(1 - dmOpt / SPEC.deltaMaxMain, 0, 1) : clamp(1 - msN, 0, 1);
      var sheetJ = (auto || !haveJ) ? clamp(1 - djOpt / djMax, 0, 1) : clamp(1 - jsN, 0, 1);
      var dM = (1 - sheetM) * SPEC.deltaMaxMain;
      var dJ = (1 - sheetJ) * djMax;

      var boomAng = dM * DEG * lsign;
      var boomLift = 0.10 * (1 - sheetM) * (1 - sstep(90, 150, aAbs));
      M.rig.boomAngleRad = boomAng;

      if (SAIL.yacht && SAIL.yacht.boomDriven === true) {
        _tmp.copy(pBoomEnd).sub(pGoose);
        if (_tmp.lengthSq() > 1) {
          boomAng = Math.atan2(_tmp.x, _tmp.z);
          dM = clamp(Math.abs(boomAng) / DEG, 0, SPEC.deltaMaxMain);
          sheetM = clamp(1 - dM / SPEC.deltaMaxMain, 0, 1);
          boomLift = 0;
        }
      }
      var boomSign = boomAng < 0 ? -1 : 1;

      var hw = sstep(24, 9, aAbs);
      var errM = dM - dmOpt, errJ = dJ - djOpt;
      var luffM = clamp(Math.max(sstep(1.5, 11, errM), hw), 0, 1);
      var luffJ = clamp(Math.max(sstep(1.5, 11, errJ), hw), 0, 1);
      var stallM = sstep(2, 22, -errM) * (1 - hw);
      var stallJ = sstep(2, 22, -errJ) * (1 - hw);
      var bwM = Math.max(sstep(0, -9, aAbs - dM), 0.32 * sstep(34, 22, aAbs) * (1 - luffM));
      var bwJ = sstep(0, -9, aAbs - dJ);

      var q = 0.5 * RHO_AIR * aws * aws;
      var mainA = reef >= 3 ? 0 : SPEC.mainArea * SPEC.reefArea[Math.min(reef, 2)];
      var jibA = SPEC.jibArea * (1 - furl) * (1 - 0.55 * sstep(130, 175, aAbs));
      var tab = rigTable(aAbs);

      var cdxM = clamp(foilCoeffs(aAbs - dM + 10, SPEC.mainARe, 0.85).cd -
                       foilCoeffs(aAbs - dmOpt + 10, SPEC.mainARe, 0.85).cd, 0, 0.9);
      var cdxJ = clamp(foilCoeffs(aAbs - dJ + 10, SPEC.jibARe, 0.90).cd -
                       foilCoeffs(aAbs - djOpt + 10, SPEC.jibARe, 0.90).cd, 0, 0.9);

      var clM = tab.cl * (1 - 0.93 * luffM) * (1 - 0.40 * stallM);
      var cdM = tab.cd + 0.10 * luffM + 0.30 * stallM + cdxM;
      var clJ = tab.cl * (1 - 0.93 * luffJ) * (1 - 0.40 * stallJ);
      var cdJ = tab.cd + 0.10 * luffJ + 0.30 * stallJ + cdxJ;

      var s = awa >= 0 ? 1 : -1;
      var sa = Math.sin(awa * DEG), ca = Math.cos(awa * DEG);
      var fxM = q * mainA * (clM * s * sa - cdM * ca);
      var fyM = q * mainA * (-clM * s * ca - cdM * sa);
      var fxJ = q * jibA * (clJ * s * sa - cdJ * ca);
      var fyJ = q * jibA * (-clJ * s * ca - cdJ * sa);
      var magM = q * mainA * Math.sqrt(clM * clM + cdM * cdM);
      var magJ = q * jibA * Math.sqrt(clJ * clJ + cdJ * cdJ);
      var loadM = clamp(magM / 9000, 0, 1.4);
      var loadJ = clamp(magJ / 7000, 0, 1.4);

      M.rig.boomDrop = boomDroop;
      M.rig.tackSign = tackSign;
      M.rig.reef = reef;
      M.rig.jibFurl = furl;

      var hoistFull = Math.max(pGoose.distanceTo(pMastTop), 1);
      var stayLen = Math.max(pStayTack.distanceTo(pJibHead), 1);

      /* ---- MAINSAIL --------------------------------------------------- */
      var rh = SPEC.reefHoist[Math.min(reef, 2)];
      var hoistF = reef >= 3 ? 0 : (1 - rh);
      var footF = SPEC.reefFoot[Math.min(reef, 2)];
      var showMain = reef < 3 && hoistF > 0.05;
      M.rig.mainHoist = hoistF;
      main.mesh.visible = showMain;
      main.tape.visible = showMain;
      if (showMain) {
        main.tack.copy(pGoose);
        _tmp.copy(pMastTop).sub(pGoose);
        main.head.copy(pGoose).addScaledVector(_tmp, hoistF);
        var fl2 = footLen * footF;
        main.clew.set(pGoose.x + Math.sin(boomAng) * fl2,
                      pGoose.y + (boomDroop + boomLift) * fl2,
                      pGoose.z + Math.cos(boomAng) * fl2);

        cfgM.leeDir.copy(_lee);
        cfgM.sheet = sheetM; cfgM.luff = luffM; cfgM.stall = stallM;
        cfgM.backwind = bwM; cfgM.headToWind = hw; cfgM.load = loadM; cfgM.time = t;
        cfgM.hoistM = hoistFull; cfgM.vmapX = rh; cfgM.vmapY = hoistF;
        /* real trade-wind twist: the head is 18-24 deg more open than the foot */
        cfgM.twistRange = (9 + 30 * (1 - sheetM) + 9 * luffM +
                           14 * sstep(110, 175, aAbs)) * (1 - 0.20 * loadM);
        cfgM.camberScale = clamp((1 - 0.22 * sheetM) * (1 - 0.42 * stallM) *
                                 (1 - 0.80 * luffM) * (1 - 0.14 * loadM), 0.08, 1.30);
        cfgM.bend = (0.10 + 0.42 * sheetM * loadM) * hoistF;
        cfgM.headWidth = 1.35;
        cfgM.roach = 1.05 * (0.58 + 0.42 * hoistF);
        main.generate(cfgM);
      }

      /* ---- GENOA ------------------------------------------------------ */
      var rollR = Math.sqrt(0.0032 + SPEC.jibLP * furl * 0.0062 / Math.PI);
      var showJib = furl < 0.97;
      jib.mesh.visible = showJib;
      jib.tape.visible = showJib;
      if (showJib) {
        var LP = SPEC.jibLP * (1 - furl);
        jib.tack.copy(pStayTack).addScaledVector(_lee, rollR * 0.9);
        jib.head.copy(pJibHead).addScaledVector(_lee, rollR * 0.9);
        jib.clew.set(jib.tack.x + lsign * LP * Math.sin(dJ * DEG),
                     jib.tack.y + 1.45 + 1.35 * furl,
                     jib.tack.z + LP * Math.cos(dJ * DEG));

        cfgJ.leeDir.copy(_lee);
        cfgJ.sheet = sheetJ; cfgJ.luff = luffJ; cfgJ.stall = stallJ;
        cfgJ.backwind = bwJ; cfgJ.headToWind = hw; cfgJ.load = loadJ; cfgJ.time = t;
        cfgJ.hoistM = stayLen; cfgJ.vmapX = 0; cfgJ.vmapY = 1;
        cfgJ.twistRange = (10 + 26 * (1 - sheetJ) + 8 * luffJ +
                           12 * sstep(110, 175, aAbs)) * (1 - 0.20 * loadJ);
        cfgJ.camberScale = clamp((1 - 0.20 * sheetJ) * (1 - 0.42 * stallJ) *
                                 (1 - 0.80 * luffJ) * (1 - 0.14 * loadJ) *
                                 (1 + 0.22 * furl), 0.08, 1.32);
        cfgJ.sag = (0.16 + 0.42 * loadJ) * (1 - furl);
        cfgJ.roach = 0.30 * (1 - 0.6 * furl);
        jib.generate(cfgJ);
      }

      /* ---- furled genoa on the forestay -------------------------------- */
      roll.visible = furl > 0.02;
      if (roll.visible) {
        _tmp.copy(pJibHead).sub(pStayTack);
        var sl = _tmp.length() || 1;
        _tmp.multiplyScalar(1 / sl);
        _q.setFromUnitVectors(_UP, _tmp);
        roll.quaternion.copy(_q);
        roll.position.copy(pStayTack).addScaledVector(_tmp, sl * 0.5);
        roll.scale.set(rollR, sl, rollR);
        roll.material.uniforms.uStripAmt.value = sstep(0.25, 0.75, furl);
        pushEnv(roll.material.uniforms);
      }

      /* ---- reef bunt / stowed main flaked into the stackpack ----------- */
      bunt.visible = reef > 0;
      if (bunt.visible) {
        var bl = footLen * (reef >= 3 ? 0.96 : footF * 0.94);
        var br = reef >= 3 ? 0.27 : (0.12 + 0.10 * reef);
        _tmp.set(Math.sin(boomAng), boomDroop, Math.cos(boomAng)).normalize();
        _q.setFromUnitVectors(_UP, _tmp);
        bunt.quaternion.copy(_q);
        bunt.position.copy(pGoose).addScaledVector(_tmp, bl * 0.5 + 0.20);
        bunt.position.y += 0.22 + br * 0.45;
        bunt.scale.set(br, bl, br);
        matBundle.uniforms.uStripAmt.value = 0.0;
      }

      /* ---- uniforms ---------------------------------------------------- */
      var um = matMain.uniforms, uj = matJib.uniforms;
      var utm = matTapeM.uniforms, utj = matTapeJ.uniforms;
      pushEnv(um); pushEnv(uj); pushEnv(utm); pushEnv(utj);
      pushEnv(matBundle.uniforms); pushEnv(matTell.uniforms);
      pushShadow(um); pushShadow(uj); pushShadow(utm); pushShadow(utj);
      if (matDepth) matDepth.uniforms.uLdir.value.copy(envC.sunDir);
      um.uLuff.value = luffM; uj.uLuff.value = luffJ;
      um.uStall.value = stallM; uj.uStall.value = stallJ;
      um.uLoad.value = clamp(loadM, 0, 1); uj.uLoad.value = clamp(loadJ, 0, 1);
      um.uVMap.value.set(rh, hoistF);
      um.uHoistM.value = hoistFull;
      uj.uHoistM.value = stayLen;
      um.uReefV.value.set(reef === 0 ? SPEC.reefHoist[1] : -1,
                          reef <= 1 ? SPEC.reefHoist[2] : -1);
      setCorners(um, main); setCorners(uj, jib);
      var mkH = clamp(main.spanM * 0.44, 3, 40) + rh * hoistFull;
      um.uMarkRect.value.set(0.95, mkH, 0.95 + clamp(main.c0 * 0.66, 1.5, 6.0),
                             mkH + clamp(main.spanM * 0.27, 1.5, 7.0));

      /* ---- shadow casters + sail-system AO ------------------------------ */
      pushRig();
      fillQuad(um, jib, showJib);          /* genoa shadow onto the mainsail */
      fillQuad(uj, main, showMain);        /* main shadow onto the genoa     */
      utm.uQOn.value = 0; utj.uQOn.value = 0;
      um.uConvex.value = main.convexSign;
      uj.uConvex.value = jib.convexSign;
      utm.uConvex.value = main.convexSign;
      utj.uConvex.value = jib.convexSign;
      /* the slot only closes when both sails are actually setting */
      var slot = (showMain && showJib) ? clamp(1 - furl * 1.4, 0, 1) : 0;
      um.uSlot.value = slot; uj.uSlot.value = slot * 0.55;

      placeHardware(showMain, showJib, hoistF);
      updateTelltales(t, luffM, stallM, luffJ, stallJ, showMain, showJib);

      /* ---- publish aero ------------------------------------------------ */
      var fx = fxM + fxJ, fy = fyM + fyJ;
      var wM = magM + 1e-6, wJ = magJ + 1e-6, wT = wM + wJ;
      var cx, cy, cz;
      if (showMain && showJib) {
        cx = (main.ce.x * wM + jib.ce.x * wJ) / wT;
        cy = (main.ce.y * wM + jib.ce.y * wJ) / wT;
        cz = (main.ce.z * wM + jib.ce.z * wJ) / wT;
      } else if (showMain) {
        cx = main.ce.x; cy = main.ce.y; cz = main.ce.z;
      } else if (showJib) {
        cx = jib.ce.x; cy = jib.ce.y; cz = jib.ce.z;
      } else {
        cx = 0; cy = 8.95; cz = 0;
      }

      var aTot = Math.max(mainA + jibA, 1e-3);
      aero.liftN = q * (mainA * clM + jibA * clJ);
      aero.dragN = q * (mainA * cdM + jibA * cdJ);
      aero.area = mainA + jibA;
      aero.areaGeom = (showMain ? main.area : 0) + (showJib ? jib.area : 0);
      aero.luffing = clamp((luffM * mainA + luffJ * jibA) / aTot, 0, 1);
      aero.stall = clamp((stallM * mainA + stallJ * jibA) / aTot, 0, 1);
      aero.fx = fx; aero.fy = fy;
      aero.ceX = cx; aero.ceY = cy; aero.ceZ = cz;
      aero.ceHeight = cy;
      aero.ceLong = -cz;
      aero.heelMomentNm = -fy * (cy + 0.90);
      aero.yawMomentNm = fy * (-cz) - fx * cx;
      aero.awaDeg = awa; aero.awsMs = aws;
      aero.main.area = mainA; aero.main.cl = clM; aero.main.cd = cdM;
      aero.main.deltaDeg = dM * boomSign; aero.main.luff = luffM; aero.main.stall = stallM;
      aero.jib.area = jibA; aero.jib.cl = clJ; aero.jib.cd = cdJ;
      aero.jib.deltaDeg = dJ * lsign; aero.jib.luff = luffJ; aero.jib.stall = stallJ;
    } catch (e) {
      if (window.console && !M._warned) { M._warned = true; console.warn('[SAIL.sails] update:', e); }
    }
  };

  /* ---- 10.  TELLTALES ---------------------------------------- */

  var _ta = new THREE.Vector3(), _tb = new THREE.Vector3(), _tc = new THREE.Vector3();
  var TELL_H = [0.26, 0.50, 0.74];

  function tellQuad(o, ax, ay, az, bx, by, bz, wx, wy, wz, r, gr, bc) {
    var p = tellPos, c = tellCol, n;
    var vx = [ax - wx, ax + wx, bx - wx, bx - wx, ax + wx, bx + wx];
    var vy = [ay - wy, ay + wy, by - wy, by - wy, ay + wy, by + wy];
    var vz = [az - wz, az + wz, bz - wz, bz - wz, az + wz, bz + wz];
    for (n = 0; n < 6; n++) {
      p[o + n * 3] = vx[n]; p[o + n * 3 + 1] = vy[n]; p[o + n * 3 + 2] = vz[n];
      c[o + n * 3] = r; c[o + n * 3 + 1] = gr; c[o + n * 3 + 2] = bc;
    }
  }

  function blankRibbon(o) {
    for (var n = 0; n < TELL_SEG * 18; n++) tellPos[o + n] = 0;
  }

  /* One ribbon: base P, streaming along S, breadth across A, lifting toward
     U when the flow separates. */
  function ribbon(o, P, S, A, U, len, wid, lift, flap, t, seed, cr, cg, cb) {
    var wx = A.x * wid, wy = A.y * wid, wz = A.z * wid;
    for (var sg = 0; sg < TELL_SEG; sg++) {
      var f0 = sg / TELL_SEG, f1 = (sg + 1) / TELL_SEG;
      var u0 = lift * f0 * f0, u1 = lift * f1 * f1;
      var d0 = Math.sin(t * 8.5 + seed + f0 * 5.2) * flap * f0;
      var d1 = Math.sin(t * 8.5 + seed + f1 * 5.2) * flap * f1;
      var g0 = -0.055 * f0 * f0 * len, g1 = -0.055 * f1 * f1 * len;
      var ax = P.x + S.x * len * f0 + A.x * d0 + U.x * u0 * len;
      var ay = P.y + S.y * len * f0 + A.y * d0 + U.y * u0 * len + g0;
      var az = P.z + S.z * len * f0 + A.z * d0 + U.z * u0 * len;
      var bx = P.x + S.x * len * f1 + A.x * d1 + U.x * u1 * len;
      var by = P.y + S.y * len * f1 + A.y * d1 + U.y * u1 * len + g1;
      var bz = P.z + S.z * len * f1 + A.z * d1 + U.z * u1 * len;
      tellQuad(o, ax, ay, az, bx, by, bz, wx, wy, wz, cr, cg, cb);
      o += 18;
    }
  }

  var _tU = new THREE.Vector3(0, 1, 0);

  function updateTelltales(t, luffM, stallM, luffJ, stallJ, showMain, showJib) {
    if (!tellMesh || !tellPos) return;
    tellMesh.visible = showMain || showJib;
    if (!tellMesh.visible) return;
    var RIB = TELL_SEG * 18, o = 0, h, side, k, W;

    /* --- genoa luff: three heights, both sides ------------------------- */
    W = jib.nu + 1;
    for (h = 0; h < TELL_JIB; h++) {
      for (side = 0; side < 2; side++, o += RIB) {
        if (!showJib) { blankRibbon(o); continue; }
        var jrow = clamp(Math.round(TELL_H[h] * jib.nv), 0, jib.nv);
        var icol = Math.max(1, Math.round(0.085 * jib.nu));
        k = (jrow * W + icol) * 3;
        _ta.set(jib.pos[k], jib.pos[k + 1], jib.pos[k + 2]);
        _tb.set(jib.tan[k], jib.tan[k + 1], jib.tan[k + 2]);
        _tc.set(jib.nor[k], jib.nor[k + 1], jib.nor[k + 2]);
        if (_tc.lengthSq() < 0.5) _tc.set(1, 0, 0);
        if (_tc.dot(_lee) < 0) _tc.negate();
        var leeSide = side === 1, sgn = leeSide ? 1 : -1;
        var lift = clamp(leeSide ? stallJ * 1.25 : luffJ * 1.45, 0, 1.1);
        var flap = (0.28 + 0.72 * Math.max(luffJ, stallJ)) * 0.10;
        _ta.addScaledVector(_tc, 0.028 * sgn);
        var isPort = (_tc.x * sgn) < 0;
        ribbon(o, _ta, _tb, _tc, _tU, 0.28, 0.013, lift, flap, t, h * 2.7 + side * 1.3,
               isPort ? 0.62 : 0.05, isPort ? 0.05 : 0.46, 0.05);
      }
    }

    /* --- mainsail luff: three heights, both sides ----------------------- */
    W = main.nu + 1;
    for (h = 0; h < TELL_MLUFF; h++) {
      for (side = 0; side < 2; side++, o += RIB) {
        if (!showMain) { blankRibbon(o); continue; }
        var mrow = clamp(Math.round((0.22 + 0.26 * h) * main.nv), 0, main.nv);
        var mcol = Math.max(1, Math.round(0.14 * main.nu));
        k = (mrow * W + mcol) * 3;
        _ta.set(main.pos[k], main.pos[k + 1], main.pos[k + 2]);
        _tb.set(main.tan[k], main.tan[k + 1], main.tan[k + 2]);
        _tc.set(main.nor[k], main.nor[k + 1], main.nor[k + 2]);
        if (_tc.lengthSq() < 0.5) _tc.set(1, 0, 0);
        if (_tc.dot(_lee) < 0) _tc.negate();
        var mlee = side === 1, msg = mlee ? 1 : -1;
        var mlift = clamp(mlee ? stallM * 1.15 : luffM * 1.50, 0, 1.1);
        var mflap = (0.24 + 0.76 * Math.max(luffM, stallM)) * 0.09;
        _ta.addScaledVector(_tc, 0.026 * msg);
        var mPort = (_tc.x * msg) < 0;
        ribbon(o, _ta, _tb, _tc, _tU, 0.24, 0.012, mlift, mflap, t, h * 3.1 + side * 1.7 + 0.6,
               mPort ? 0.60 : 0.05, mPort ? 0.05 : 0.44, 0.05);
      }
    }

    /* --- mainsail leech: one per batten -------------------------------- */
    W = main.nu + 1;
    for (k = 0; k < NBATT; k++, o += RIB) {
      if (!showMain || k >= main.battH.length || main.spanM < 0.5) { blankRibbon(o); continue; }
      var jj = clamp(Math.round((main.battH[k] / main.spanM) * main.nv), 0, main.nv);
      var kk = (jj * W + main.nu) * 3;
      _ta.set(main.pos[kk], main.pos[kk + 1], main.pos[kk + 2]);
      _tb.set(main.tan[kk], main.tan[kk + 1], main.tan[kk + 2]);
      _tc.set(main.nor[kk], main.nor[kk + 1], main.nor[kk + 2]);
      if (_tc.lengthSq() < 0.5) _tc.set(1, 0, 0);
      if (_tc.dot(_lee) < 0) _tc.negate();
      _ta.addScaledVector(_tb, 0.02);
      var lf = clamp(stallM * 1.35 + luffM * 0.5, 0, 1.2);
      var fp = (0.26 + 0.74 * Math.max(luffM, stallM)) * 0.13;
      ribbon(o, _ta, _tb, _tc, _tU, 0.34, 0.011, lf, fp, t, k * 1.9 + 0.4,
             0.055, 0.062, 0.075);
    }

    tellMesh.geometry.attributes.position.needsUpdate = true;
    tellMesh.geometry.attributes.aCol.needsUpdate = true;
  }

  /* ---- 11.  ACCESSORS ---------------------------------------- */

  M.getAero = function () { return aero; };

  M.getState = function () {
    return {
      area: aero.area, areaGeom: aero.areaGeom,
      luffing: aero.luffing, stall: aero.stall,
      mainDeltaDeg: aero.main.deltaDeg, jibDeltaDeg: aero.jib.deltaDeg,
      boomAngleRad: M.rig.boomAngleRad, reef: M.rig.reef, furl: M.rig.jibFurl,
      ce: { x: aero.ceX, y: aero.ceY, z: aero.ceZ }
    };
  };

})();
