/* ==========================================================================
   boat.js — Leopard 52 (2025, Robertson & Caine) manoeuvring model
   --------------------------------------------------------------------------
   Builder's figures (leopardcatamarans.com):
     LOA 15.75 m (51'8")    BEAM 8.16 m (26'9")     DRAFT 1.70 m (5'7")
     LWL 15.31 m            DISPL 20,517 kg light   PAYLOAD 7,000 kg
     Sail area 168.3 m²     Fuel 900 L  Water 700 L
     Engines 2 × Yanmar 57 hp saildrive (80 hp optional)

   Physics: 3-DOF (surge/sway/yaw) rigid body, integrated at 200 Hz.
     · Hull forces by STRIP THEORY — each hull cut into 16 stations, every
       station sees its own local flow (u - r·y_hull, v + r·x_station), so
       yaw damping, pivot-point migration and the catamaran's differential-
       hull drag all fall out of the geometry instead of being hand-tuned.
     · Propellers: open-water Kt/Kq vs advance ratio J, wake fraction,
       thrust deduction, 4-quadrant sign handling, prop walk astern.
     · Engines: Yanmar torque curve + governor + rotational inertia, so revs
       build at a real rate and bog under load. Gearbox needs neutral + a
       clunk delay to change direction.
     · Rudders: finite-aspect-ratio lift with stall; only the ~35 % of span
       inside the contracted propeller race gets slipstream velocity.
     · Windage: 105 m² lateral / 30 m² frontal with angle-dependent
       coefficients and a centre of effort that migrates with wind angle.
     · Shallow-water correction on added mass and cross-flow drag, squat,
       bank suction alongside quays, Froude-Krylov wave forcing.
   Model space: -Z = bow, +X = starboard, +Y = up.
   ========================================================================== */
(function () {
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const KN = 1.94384;
  const RHO = 1025;          // seawater kg/m³
  const RHO_A = 1.225;       // air
  const G = 9.81;

  const SPEC = {
    loa: 15.75, lwl: 15.31, beam: 8.16, draft: 1.70,
    hullBeam: 2.15, hullSep: 3.005,          // hull centre-to-centre 6.01 m
    displLight: 20517, payload: 7000,
    sailArea: 168.3, fuelL: 900, waterL: 700,
    mastHeight: 23.4,
    canoeDraft: 1.02,                        // hull body; keel takes it to 1.70
    propX: -6.15, propD: 0.48, propPitchRatio: 0.85, gearRatio: 2.61,
    rudX: -6.95, rudArea: 0.55, rudSpan: 1.15, rudAR: 2.4, rudMax: 35,
    areaFront: 30, areaSide: 105,
    wakeFrac: 0.08, thrustDed: 0.05
  };

  /* ============================ hull mesh =================================
     Lofted from 30 stations per hull so the waterline, forefoot and transom
     read correctly from the flybridge.                                     */
  const P = (fore, stbd, up) => new THREE.Vector3(stbd, up, -fore);

  function loftHull() {
    const L = SPEC.loa, hb = SPEC.hullBeam / 2, canoe = SPEC.canoeDraft;
    const NS = 30, NP = 9, stations = [];
    for (let i = 0; i <= NS; i++) {
      const t = -Math.cos(i / NS * Math.PI);
      const fore = t * L / 2;
      let halfB = t >= 0
        ? hb * Math.pow(Math.max(0, 1 - Math.pow(t, 2.35)), 0.46)
        : hb * (1 - 0.26 * Math.pow(-t, 3.2));
      halfB = Math.max(halfB, 0.02);
      let keel = -canoe * (1 - Math.pow(Math.max(0, t), 2.0) * 0.94);
      if (t < -0.86) keel *= 1 - ((-t) - 0.86) / 0.14 * 0.22;
      const sheer = 1.62 + 0.68 * Math.pow(Math.max(0, t), 2.2) + 0.06 * t;
      const pts = [];
      for (let j = 0; j <= NP; j++) {
        const s = j / NP;
        pts.push([halfB * Math.pow(Math.sin(s * Math.PI / 2), 0.62),
                  keel + (sheer - keel) * Math.pow(s, 1.45)]);
      }
      stations.push({ fore, pts, keel, sheer });
    }
    const pos = [], idx = [], ring = [];
    const push = v => { pos.push(v.x, v.y, v.z); return pos.length / 3 - 1; };
    for (let i = 0; i <= NS; i++) {
      const st = stations[i], row = [];
      for (let j = NP; j >= 0; j--) row.push(push(P(st.fore, st.pts[j][0], st.pts[j][1])));
      for (let j = 1; j <= NP; j++) row.push(push(P(st.fore, -st.pts[j][0], st.pts[j][1])));
      ring.push(row);
    }
    const M = ring[0].length;
    for (let i = 0; i < NS; i++) for (let j = 0; j < M - 1; j++)
      idx.push(ring[i][j], ring[i][j + 1], ring[i + 1][j + 1],
               ring[i][j], ring[i + 1][j + 1], ring[i + 1][j]);
    const tr = stations[0], c = push(P(tr.fore, 0, (tr.keel + tr.sheer) / 2));
    for (let j = 0; j < M - 1; j++) idx.push(ring[0][j + 1], ring[0][j], c);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx); g.computeVertexNormals();
    return g;
  }

  function buildMesh() {
    const g = new THREE.Group();
    const white = new THREE.MeshPhongMaterial({ color: 0xf4f6f5, shininess: 60, specular: 0x3a3a3a });
    const grey = new THREE.MeshLambertMaterial({ color: 0xb9c0c4 });
    const teak = new THREE.MeshLambertMaterial({ color: 0xc9a875 });
    const dark = new THREE.MeshLambertMaterial({ color: 0x2c3439 });
    const boot = new THREE.MeshLambertMaterial({ color: 0x123a52 });
    const glass = c => new THREE.MeshPhongMaterial({ color: 0x18262e, shininess: 110, specular: 0x88aabb });
    const win = (w, h, d) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), glass());
    const sep = SPEC.hullSep;
    const props = [];

    for (const s of [-1, 1]) {
      const h = new THREE.Mesh(loftHull(), white); h.position.x = s * sep; g.add(h);
      const bs = new THREE.Mesh(new THREE.BoxGeometry(SPEC.hullBeam * 1.02, 0.11, SPEC.loa * 0.9), boot);
      bs.position.set(s * sep, 0.08, 0.3); g.add(bs);
      const k = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.74, 6.2), white);
      k.position.set(s * sep, -1.33, 0.9); g.add(k);                      // low-aspect keel → 1.70 m
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.9, 0.5), dark);
      leg.position.set(s * sep, -1.22, -SPEC.propX); g.add(leg);
      const pr = new THREE.Mesh(new THREE.CylinderGeometry(SPEC.propD / 2, SPEC.propD / 2, 0.06, 12), grey);
      pr.rotation.x = Math.PI / 2; pr.position.set(s * sep, -1.5, -SPEC.propX + 0.34);
      g.add(pr); props.push(pr);
      const rud = new THREE.Mesh(new THREE.BoxGeometry(0.09, SPEC.rudSpan, SPEC.rudArea / SPEC.rudSpan), dark);
      rud.position.set(s * sep, -1.0, -SPEC.rudX); g.add(rud);
      const st = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.12, 1.5), teak);
      st.position.set(s * sep, 0.62, SPEC.loa / 2 - 0.75); g.add(st);
      const hw = win(0.06, 0.34, 4.6); hw.position.set(s * (sep + SPEC.hullBeam / 2 - 0.03), 1.05, -0.4); g.add(hw);
      const sa = new THREE.Mesh(new THREE.BoxGeometry(SPEC.hullBeam * 1.01, 0.07, SPEC.loa * 0.72), grey);
      sa.position.set(s * sep, 1.42, -0.2); g.add(sa);
    }

    const brS = new THREE.Shape();
    brS.moveTo(-3.4, -6.3); brS.lineTo(3.4, -6.3); brS.lineTo(3.4, 5.6);
    brS.quadraticCurveTo(0, 7.4, -3.4, 5.6);
    const brG = new THREE.ExtrudeGeometry(brS, { depth: 0.55, bevelEnabled: false });
    brG.rotateX(Math.PI / 2);
    const br = new THREE.Mesh(brG, white); br.position.set(0, 1.02, 0.2); g.add(br);   // 0.95 m clearance

    const sal = new THREE.Mesh(new THREE.BoxGeometry(6.5, 2.05, 6.4), white);
    sal.position.set(0, 2.55, -0.6); g.add(sal);
    const salF = new THREE.Mesh(new THREE.BoxGeometry(5.6, 2.05, 1.6), white);
    salF.position.set(0, 2.55, -4.0); g.add(salF);
    const wF = win(5.5, 0.95, 0.08); wF.position.set(0, 2.95, -3.86); wF.rotation.x = -0.12; g.add(wF);
    for (const s of [-1, 1]) { const w = win(0.08, 0.85, 5.6); w.position.set(s * 3.27, 2.85, -0.7); g.add(w); }
    const wA = win(5.2, 1.5, 0.08); wA.position.set(0, 2.65, 2.58); g.add(wA);

    const ck = new THREE.Mesh(new THREE.BoxGeometry(6.4, 0.12, 4.4), teak);
    ck.position.set(0, 1.35, 4.3); g.add(ck);
    const bench = new THREE.Mesh(new THREE.BoxGeometry(6.0, 0.5, 0.8), white);
    bench.position.set(0, 1.7, 6.0); g.add(bench);
    const tbl = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.08, 1.1), teak);
    tbl.position.set(0, 2.0, 4.9); g.add(tbl);

    const fb = new THREE.Mesh(new THREE.BoxGeometry(6.2, 0.16, 5.4), white);
    fb.position.set(0, 3.62, 0.5); g.add(fb);
    const rail = new THREE.Mesh(new THREE.BoxGeometry(6.2, 0.62, 0.1), white);
    rail.position.set(0, 3.95, 3.2); g.add(rail);
    for (const s of [-1, 1]) {
      const sr = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.62, 5.4), white);
      sr.position.set(s * 3.05, 3.95, 0.5); g.add(sr);
    }
    /* ---- helm station: destroyer wheel on a pedestal, starboard side -----
       Geometry is chosen so the helm camera (eye at 2.05, 5.15, -0.90) frames
       the top ~40 % of the wheel across the bottom of the view: the wheel sits
       0.83 m forward of and 0.58 m below the eye, so its top rim lands about
       70 % down the frame and the screen edge cuts it just below that.     */
    const steel = new THREE.MeshPhongMaterial({ color: 0xc2cace, shininess: 120, specular: 0x8899a0 });
    const leather = new THREE.MeshPhongMaterial({ color: 0x2a2724, shininess: 22 });
    const kingMat = new THREE.MeshPhongMaterial({ color: 0xc4452f, shininess: 60 });

    const con = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.66, 0.46), grey);
    con.position.set(2.05, 4.02, -2.15); g.add(con);
    const mfd = win(1.25, 0.40, 0.05); mfd.position.set(2.05, 4.37, -2.12);
    mfd.rotation.x = 0.42; g.add(mfd);
    const throt = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.06, 0.3), dark);
    throt.position.set(1.15, 4.37, -2.0); g.add(throt);
    for (const dx of [-0.05, 0.05]) {
      const lv = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.018, 0.24, 6), steel);
      lv.position.set(1.15 + dx, 4.47, -2.0); lv.rotation.x = -0.25; g.add(lv);
    }

    const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.115, 0.95, 12), steel);
    ped.position.set(2.05, 4.10, -1.73); g.add(ped);

    const wheelTilt = new THREE.Group();
    wheelTilt.position.set(2.05, 4.57, -1.73);
    wheelTilt.rotation.x = -0.28;                 // top raked forward, as fitted
    g.add(wheelTilt);
    const wheel = new THREE.Group();              // this is what actually spins
    wheelTilt.add(wheel);

    const R = 0.38;
    wheel.add(new THREE.Mesh(new THREE.TorusGeometry(R, 0.021, 10, 44), leather));
    const hubO = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.058, 0.08, 16), steel);
    hubO.rotation.x = Math.PI / 2; wheel.add(hubO);
    const hubC = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.10, 12), kingMat);
    hubC.rotation.x = Math.PI / 2; wheel.add(hubC);
    for (let i = 0; i < 6; i++) {
      const a = i * Math.PI / 3 + Math.PI / 2;     // spoke 0 points straight up amidships
      const king = i === 0;
      const sp = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.014, R - 0.05, 8),
        king ? kingMat : steel);
      sp.position.set(Math.cos(a) * (R + 0.05) / 2, Math.sin(a) * (R + 0.05) / 2, 0);
      sp.rotation.z = a - Math.PI / 2;
      wheel.add(sp);
      const knob = new THREE.Mesh(new THREE.SphereGeometry(0.03, 12, 9), king ? kingMat : steel);
      knob.position.set(Math.cos(a) * (R - 0.015), Math.sin(a) * (R - 0.015), 0.028);
      wheel.add(knob);
    }
    // king-spoke marker on the rim — tells you instantly how much helm is on
    const mark = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.075, 0.05), kingMat);
    mark.position.set(0, R, 0); wheel.add(mark);

    // eye point for the first-person helm camera, rigidly on the boat
    const helmEye = new THREE.Object3D();
    helmEye.position.set(2.05, 5.15, -0.90); g.add(helmEye);

    // spray shield across the front of the flybridge
    const shield = new THREE.Mesh(new THREE.BoxGeometry(6.0, 0.52, 0.06),
      new THREE.MeshPhongMaterial({ color: 0x9fb4bf, transparent: true, opacity: 0.30,
        shininess: 140, side: THREE.DoubleSide }));
    shield.position.set(0, 3.95, -2.6); shield.rotation.x = -0.16; g.add(shield);
    const seat = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.42, 0.6), white);
    seat.position.set(1.6, 4.05, -0.35); g.add(seat);
    const seatB = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.6, 0.14), white);
    seatB.position.set(1.6, 4.4, -0.05); g.add(seatB);

    for (let i = 0; i < 4; i++) {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.9, 6), grey);
      p.position.set(i < 2 ? -2.7 : 2.7, 4.9, i % 2 ? 2.7 : -1.9); g.add(p);
    }
    const ht = new THREE.Mesh(new THREE.BoxGeometry(6.3, 0.14, 5.0), white);
    ht.position.set(0, 5.9, 0.5); g.add(ht);
    const sol = new THREE.Mesh(new THREE.BoxGeometry(5.6, 0.05, 4.2),
      new THREE.MeshPhongMaterial({ color: 0x101a2c, shininess: 120 }));
    sol.position.set(0, 6.0, 0.5); g.add(sol);                            // 4 × 400 W

    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.17, SPEC.mastHeight - 4, 8), grey);
    mast.position.set(0, 4 + (SPEC.mastHeight - 4) / 2, -1.2); g.add(mast);
    const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 5.6, 8), grey);
    boom.rotation.x = Math.PI / 2; boom.position.set(0, 6.9, 1.5); g.add(boom);
    const bag = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 5.4, 10),
      new THREE.MeshLambertMaterial({ color: 0x2b3a44 }));
    bag.rotation.x = Math.PI / 2; bag.position.set(0, 7.25, 1.5); g.add(bag);
    const gen = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.3, 17.5, 8),
      new THREE.MeshLambertMaterial({ color: 0x243038 }));
    gen.position.set(0, 11, -6.6); gen.rotation.x = -0.055; g.add(gen);

    const wire = new THREE.LineBasicMaterial({ color: 0xc8ced2 });
    const ln = (a, b) => g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), wire));
    const top = new THREE.Vector3(0, SPEC.mastHeight, -1.2);
    ln(top, new THREE.Vector3(0, 2.1, -7.6));
    for (const s of [-1, 1]) {
      ln(top, new THREE.Vector3(s * 3.1, 1.55, 0.4));
      ln(new THREE.Vector3(0, 12, -1.2), new THREE.Vector3(s * 3.1, 1.55, 0.4));
    }

    /* ---- foredeck: this is the whole forward view from the helm, so it is
       worth the geometry — netting, windlass, anchor and pulpit give you
       something to judge distance and heading against. ------------------- */
    const netCv = document.createElement('canvas'); netCv.width = netCv.height = 64;
    const ng = netCv.getContext('2d');
    ng.clearRect(0, 0, 64, 64);
    ng.strokeStyle = '#39434a'; ng.lineWidth = 5;
    for (let i = 0; i <= 4; i++) {
      const p = i * 16;
      ng.beginPath(); ng.moveTo(p, 0); ng.lineTo(p, 64); ng.stroke();
      ng.beginPath(); ng.moveTo(0, p); ng.lineTo(64, p); ng.stroke();
    }
    const netTex = new THREE.CanvasTexture(netCv);
    netTex.wrapS = netTex.wrapT = THREE.RepeatWrapping; netTex.repeat.set(9, 7);
    const netMat = new THREE.MeshLambertMaterial({ map: netTex, transparent: true,
      alphaTest: 0.35, side: THREE.DoubleSide });
    for (const s of [-1, 1]) {
      const tr = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 4.2), netMat);
      tr.rotation.x = -Math.PI / 2;
      tr.position.set(s * 1.55, 1.60, -5.3); g.add(tr);
    }
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 6.2, 10), white);
    beam.rotation.z = Math.PI / 2; beam.position.set(0, 1.6, -7.1); g.add(beam);
    const spr = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.22, 1.9), white);
    spr.position.set(0, 1.72, -8.15); g.add(spr);
    // anchor on the bow roller
    const anch = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.1, 0.62),
      new THREE.MeshPhongMaterial({ color: 0x9aa2a8, shininess: 80 }));
    anch.position.set(0, 1.70, -8.85); g.add(anch);
    // windlass
    const wl = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.18, 0.52), grey);
    wl.position.set(0, 1.76, -7.5); g.add(wl);
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.16, 12), steel);
    drum.rotation.z = Math.PI / 2; drum.position.set(0.26, 1.82, -7.5); g.add(drum);
    // bow pulpit
    for (const s of [-1, 1]) {
      const pu = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.7, 6), steel);
      pu.position.set(s * (sep - 0.35), 2.0, -7.55); g.add(pu);
    }
    // coachroof hatches
    for (const dz of [-3.2, -4.6]) {
      const ht2 = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.09, 0.7),
        new THREE.MeshPhongMaterial({ color: 0x24323b, shininess: 110 }));
      ht2.position.set(0, 1.68, dz); g.add(ht2);
    }
    // mast spreaders — give the rig some depth from the helm
    for (const h of [9.2, 14.6]) {
      const sw = h < 12 ? 2.3 : 1.8;
      for (const s of [-1, 1]) {
        const sprd = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, sw, 6), grey);
        sprd.rotation.z = Math.PI / 2; sprd.rotation.y = 0.22 * s;
        sprd.position.set(s * sw / 2, h, -1.2); g.add(sprd);
      }
    }
    for (const s of [-1, 1]) for (let i = 0; i < 7; i++) {
      const st = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.62, 5), grey);
      st.position.set(s * (sep + 0.95), 1.95, -7 + i * 2); g.add(st);
    }
    const dv = new THREE.Mesh(new THREE.BoxGeometry(6.2, 0.14, 0.16), grey);
    dv.position.set(0, 2.1, 7.5); g.add(dv);
    const rib = new THREE.Mesh(new THREE.CapsuleGeometry(0.36, 2.6, 4, 8),
      new THREE.MeshLambertMaterial({ color: 0x59636a }));
    rib.rotation.z = Math.PI / 2; rib.position.set(0, 1.55, 7.6); g.add(rib);

    /* Navigation lights, drawn as glows. Red to port and green to starboard on
       the bows with a white light aft is the actual way you tell which end of
       a boat you are looking at, so make them legible. */
    const glowTex = (() => {
      const c = document.createElement('canvas'); c.width = c.height = 64;
      const q = c.getContext('2d');
      const gr = q.createRadialGradient(32, 32, 0, 32, 32, 32);
      gr.addColorStop(0, 'rgba(255,255,255,1)');
      gr.addColorStop(0.18, 'rgba(255,255,255,.9)');
      gr.addColorStop(0.45, 'rgba(255,255,255,.28)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      q.fillStyle = gr; q.fillRect(0, 0, 64, 64);
      return new THREE.CanvasTexture(c);
    })();
    const mk = (c, x, y, z, size) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8),
        new THREE.MeshBasicMaterial({ color: c }));
      m.position.set(x, y, z); g.add(m);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: c,
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.9 }));
      sp.scale.setScalar(size || 0.9); sp.position.set(x, y, z); g.add(sp);
      return m;
    };
    const lights = {
      port: mk(0xff2b2b, -(sep + 0.95), 1.9, -7.2, 1.0),
      stbd: mk(0x27d15a, sep + 0.95, 1.9, -7.2, 1.0),
      stern: mk(0xfff0d0, 0, 2.0, 7.7, 0.9),
      steam: mk(0xfff4dc, 0, 13.5, -1.2, 0.7)
    };
    const fenders = [];
    for (const s of [-1, 1]) for (let i = 0; i < 3; i++) {
      const f = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.5, 4, 8),
        new THREE.MeshLambertMaterial({ color: 0xf0f2f0 }));
      f.position.set(s * (sep + SPEC.hullBeam / 2 + 0.16), 0.95, -3 + i * 3.2);
      g.add(f); fenders.push(f);
    }
    g.userData = { lights, wheel, props, fenders, helmEye };
    return g;
  }

  /* ======================= propeller (open water) ==========================
     Kt(J) = Kt0(1 − J/J0),  Kq(J) = Kq0(1 − 0.6 J/J0)
     Kt0 / Kq0 fitted so that: bollard pull ≈ 552 kgf per 57 hp engine, and
     the engine reaches rated rpm at WOT without overloading (P/D ≈ 0.85).  */
  // Propped so the engine just reaches rated revs at WOT underway (the mark of
  // a correctly matched wheel) while still pulling ≈5,900 N per engine static.
  const PROP = { Kt0: 0.40, Kq0: 0.0480, J0: 1.00, asternT: 0.72, asternQ: 0.80 };

  function propForces(np, ua, D, scale) {
    // np: prop rev/s (signed). ua: axial inflow (m/s, +fwd). Returns {T, Q}
    const n = Math.abs(np);
    const rn2d4 = RHO * n * n * Math.pow(D, 4);
    const rn2d5 = RHO * n * n * Math.pow(D, 5);
    if (n < 0.05) return { T: 0, Q: 0 };
    const J = ua / (Math.max(n, 0.05) * D) * Math.sign(np || 1);
    const kt = PROP.Kt0 * (1 - clamp(J, -0.6, 1.6) / PROP.J0);
    const kq = PROP.Kq0 * (1 - 0.6 * clamp(J, -0.6, 1.6) / PROP.J0);
    const dir = Math.sign(np);
    const eT = dir > 0 ? 1 : PROP.asternT;
    const eQ = dir > 0 ? 1 : PROP.asternQ;
    return { T: dir * rn2d4 * Math.max(kt, -0.12) * eT * scale, Q: rn2d5 * Math.max(kq, 0.004) * eQ * scale };
  }

  /* ============================ engine ==================================== */
  // Yanmar 4JH57 / 4JH80 shape: torque flat-ish, peaking a little below rated.
  function engineTorque(rpm, ratedKW, ratedRPM) {
    const x = clamp(rpm / ratedRPM, 0.15, 1.12);
    const qRated = ratedKW * 1000 / (ratedRPM * Math.PI / 30);
    const shape = 1.06 - 0.42 * Math.pow(x - 0.72, 2) / 0.36;   // ≈1.06 at 0.72 n_r, 1.0 at rated
    return qRated * clamp(shape, 0.35, 1.12);
  }

  /* ========================== strip geometry ==============================
     16 stations per hull; each carries local draft and wetted girth so the
     cross-flow drag and skin friction distribute correctly along the length. */
  const STRIPS = (() => {
    const n = 16, out = [], L = SPEC.lwl;
    for (let i = 0; i < n; i++) {
      const t = -1 + 2 * (i + 0.5) / n;                 // -1 stern .. +1 bow
      const x = t * L / 2, dx = L / n;
      let T = SPEC.canoeDraft * (1 - Math.pow(Math.max(0, t), 2.0) * 0.9);
      if (t < -0.9) T *= 0.85;
      let B = t >= 0 ? SPEC.hullBeam * Math.pow(Math.max(0, 1 - Math.pow(t, 2.35)), 0.46)
                     : SPEC.hullBeam * (1 - 0.26 * Math.pow(-t, 3.2));
      // low-aspect keel between x = −2.2 and +4.0 adds lateral area
      const keel = (x > -2.2 && x < 4.0) ? 0.74 : 0;
      out.push({ x, dx, T, B, lat: (T + keel) * dx, wet: (1.85 * T + 0.9 * B) * dx });
    }
    return out;
  })();

  class Boat {
    constructor(scene, opts) {
      opts = opts || {};
      this.spec = SPEC;
      this.mesh = buildMesh();
      scene.add(this.mesh);
      this.setEngines(opts.hp || 57);
      this.loadFrac = opts.load != null ? opts.load : 0.42;
      this.mass = SPEC.displLight + SPEC.payload * this.loadFrac;   // ≈ 23,457 kg
      this.Izz = this.mass * 22.3;                                  // kzz ≈ 4.72 m
      this.reset(0, 0, 0);
    }

    setEngines(hp) {
      this.hp = hp;
      this.ratedKW = hp * 0.7457;
      this.ratedRPM = 3000;
      this.idleRPM = 720;
      this.propScale = hp >= 80 ? 1.22 : 1.0;    // larger wheel with the 80s
      // flywheel + gearbox + prop (and its entrained water) referred to the
      // crankshaft — this is what makes revs take about a second to answer
      this.Ieng = 0.9;
    }

    reset(x, z, hdg) {
      this.x = x; this.z = z; this.h = hdg * Math.PI / 180;
      this.u = 0; this.v = 0; this.r = 0;
      this.lever = [0, 0]; this.gear = [0, 0]; this.gearWait = [0, 0];
      this.rpm = [this.idleRPM, this.idleRPM];
      this.thrust = [0, 0]; this.propQ = [0, 0]; this.load = [0, 0];
      this.rud = 0; this.rudCmd = 0;
      this.aground = false; this.groundBite = 0;
      this.impacts = []; this.maxImpact = 0; this.contacts = 0; this.contactNow = 0;
      this.heel = 0; this.pitch = 0; this.heave = 0; this.heelT = 0;
      this.wakeAcc = 0; this.squat = 0; this.underKeel = 9;
      this.aw = { spd: 0, ang: 0 }; this.sog = 0; this.cog = 0; this.rot = 0;
      // derived readouts must be valid before the first step() — anything that
      // samples them on frame zero would otherwise see undefined
      this.hdg = (hdg + 360) % 360;
      this.acc = 0; this.lastU = 0;
      this.nearSegs = []; this.bank = null;
      this.clunk = 0; this.hitFlag = null;
      this.tether = null; this.tetherLoad = 0;
    }

    /* ---------------------------------------------------------- gearbox */
    stepDrive(dt) {
      for (let i = 0; i < 2; i++) {
        const want = Math.abs(this.lever[i]) < 0.07 ? 0 : Math.sign(this.lever[i]);
        if (want !== this.gear[i]) {
          if (this.gear[i] !== 0) {
            this.gear[i] = 0; this.gearWait[i] = 0.5; this.clunk = 1;
          } else if (this.gearWait[i] <= 0) {
            this.gear[i] = want; if (want) this.clunk = 1;
          }
        }
        this.gearWait[i] = Math.max(0, this.gearWait[i] - dt);
      }
    }

    /* ------------------------------------------- one 200 Hz physics step */
    substep(dt, env) {
      const S = SPEC, m = this.mass;
      const sh = Math.sin(this.h), ch = Math.cos(this.h);

      // water-relative velocities (current is a bodily translation of the water)
      const cu = env.curX * sh - env.curZ * ch;
      const cv = env.curX * ch + env.curZ * sh;
      const ur = this.u - cu, vr = this.v - cv;

      // ---- depth & shallow-water factors --------------------------------
      const dpt = SIM.world.depthAt(this.x, this.z);
      const hT = clamp((dpt > 0 ? dpt : 0.2) / S.draft, 1.02, 12);
      const kShallow = clamp(1 + 0.55 / Math.pow(hT - 0.92, 1.15), 1, 3.2);
      this.squat = clamp(0.42 * ur * ur / (G * Math.max(dpt, 1.2)) * kShallow, 0, 0.6);

      let X = 0, Y = 0, N = 0;

      /* ---------------- hull: strip theory over both hulls --------------- */
      const Cdc = 0.88 * kShallow;          // cross-flow drag coefficient
      const Cf = 0.0042;                    // friction + form
      for (const side of [-1, 1]) {
        const yh = side * S.hullSep;
        const uh = ur - this.r * yh;        // this hull's axial speed
        for (const st of STRIPS) {
          const vLoc = vr + this.r * st.x;
          const fy = -0.5 * RHO * Cdc * st.lat * Math.abs(vLoc) * vLoc;
          const fx = -0.5 * RHO * Cf * st.wet * Math.abs(uh) * uh;
          X += fx; Y += fy;
          N += st.x * fy - yh * fx;
        }
      }
      // residuary (wave-making) resistance, surge only
      const Fn = Math.abs(ur) / Math.sqrt(G * S.lwl);
      const hump = 1 + 1.15 * clamp((Fn - 0.26) / 0.22, 0, 1);
      // transom-first flow separates badly, so she is far draggier going astern
      X -= Math.sign(ur) * (118 * ur * ur * hump + (ur < 0 ? 540 * ur * ur : 0));
      // low-speed linear damping keeps things settled at walking pace
      X -= 190 * ur; Y -= 1500 * vr; N -= 5.2e4 * this.r;

      /* ---------------- propulsion --------------------------------------- */
      const wf = 1 - S.wakeFrac, td = 1 - S.thrustDed;
      for (let i = 0; i < 2; i++) {
        const side = i === 0 ? -1 : 1;
        const yh = side * S.hullSep;
        const uAxial = (ur - this.r * yh) * wf;
        const nEng = this.rpm[i], nProp = nEng / S.gearRatio / 60 * this.gear[i];
        const pf = propForces(nProp, uAxial, S.propD, this.propScale);
        this.thrust[i] = pf.T * td;
        this.propQ[i] = pf.Q;
        X += this.thrust[i];
        // Differential-thrust couple. A longitudinal force at lateral offset
        // yh gives N = −yh·Fx (same convention as the strip loop above), so
        // the PORT engine ahead (yh<0) swings the bow to STARBOARD — the way
        // a tank turns on its tracks. Getting this backwards inverts the
        // single most important control on a twin-screw boat.
        N -= this.thrust[i] * yh;
        if (this.gear[i] < 0) {                         // prop walk (counter-rotating pair)
          const walk = 0.045 * this.thrust[i] * side;
          Y += walk; N += walk * S.propX;
        }
        // ---- engine: governor + inertia
        const lv = Math.abs(this.lever[i]);
        const tgt = this.gear[i] === 0 ? this.idleRPM + lv * 600
                                       : this.idleRPM + lv * (this.ratedRPM - this.idleRPM);
        const qAvail = engineTorque(nEng, this.ratedKW, this.ratedRPM);
        // Mechanical governor: stiff (≈3 % droop), so revs are held against load
        // until the torque curve runs out — then she bogs, exactly like the real one.
        let qDem = clamp((tgt - nEng) * 1.6, -qAvail * 0.9, qAvail);
        const qLoad = this.gear[i] === 0 ? 3.5 + nEng * 0.0022 : pf.Q / S.gearRatio + 3.0;
        const dOmega = (qDem - qLoad) / this.Ieng;
        this.rpm[i] = clamp(nEng + dOmega * 30 / Math.PI * dt, 520, this.ratedRPM * 1.06);
        this.load[i] = clamp(qLoad / Math.max(qAvail, 1), 0, 1.2);
      }

      /* ---------------- rudders ------------------------------------------ */
      const dRad = this.rud * Math.PI / 180;
      const Adisc = Math.PI * S.propD * S.propD / 4;
      const raceFrac = 0.35;                            // contracted slipstream / rudder span
      for (let i = 0; i < 2; i++) {
        const side = i === 0 ? -1 : 1, yh = side * S.hullSep;
        const uLoc = ur - this.r * yh;
        const vRud = vr + this.r * S.rudX;
        // free-stream part
        const parts = [];
        const uFree = uLoc * wf;
        parts.push({ A: S.rudArea * (1 - raceFrac), vx: uFree });
        // race part: slipstream velocity from momentum theory
        const T = this.thrust[i];
        let vRace = uFree;
        if (T > 0) vRace = Math.sqrt(Math.max(0, uFree * uFree + 2 * T / (RHO * Adisc))) * 0.88;
        else if (T < 0) vRace = uFree * 0.5;            // race blown forward, rudder unloaded
        parts.push({ A: S.rudArea * raceFrac, vx: vRace });

        for (const p of parts) {
          const Vt = Math.hypot(p.vx, vRud);
          if (Vt < 0.02) continue;
          // Angle of attack = helm angle + the drift angle the blade actually
          // sees. Both a deflected rudder and a sideslipping hull push the
          // stern the same way, which is what makes the boat weathervane.
          const ahead = p.vx >= 0;
          const beta = ahead ? Math.atan2(vRud, Math.max(p.vx, 0.02))
                             : Math.atan2(vRud, Math.max(-p.vx, 0.02));
          let alpha = (ahead ? dRad : -dRad) + beta;
          while (alpha > Math.PI) alpha -= 2 * Math.PI;
          while (alpha < -Math.PI) alpha += 2 * Math.PI;
          const aStall = 0.38;                            // ≈22° for AR 2.4
          let Cl = 3.43 * Math.sin(alpha);
          if (Math.abs(alpha) > aStall)
            Cl = Math.sign(alpha) * (1.29 - 0.55 * clamp((Math.abs(alpha) - aStall) / 0.5, 0, 1));
          const Cd = 0.012 + Cl * Cl / (Math.PI * S.rudAR * 0.85);
          const q = 0.5 * RHO * p.A * Vt * Vt;
          const F = q * Cl * (ahead ? 1 : 0.55);          // blunt edge leading astern
          Y -= F; N -= F * S.rudX;
          X -= q * Cd * Math.sign(p.vx || 1);
        }
      }

      /* ---------------- windage ------------------------------------------ */
      const wu = env.windX * sh - env.windZ * ch;
      const wv = env.windX * ch + env.windZ * sh;
      const au = wu - this.u, av = wv - this.v;
      const Vaw = Math.hypot(au, av);
      const beta = Math.atan2(av, au);                  // 0 = wind from astern pushing fwd
      const qa = 0.5 * RHO_A * Vaw * Vaw;
      // angle-dependent coefficients (OCIMF-style shape for a high-windage cat)
      const Cx = 0.72 * Math.cos(beta) * (1 + 0.18 * Math.cos(2 * beta));
      const Cy = 1.08 * Math.sin(beta) * (1 + 0.12 * Math.cos(2 * beta));
      const Fxw = qa * S.areaFront * Cx;
      const Fyw = qa * S.areaSide * Cy;
      // centre of effort sits ~2.4 m forward of the CG on the beam (mast, coachroof,
      // flybridge and furled genoa are all forward) and migrates aft near head/stern
      const xce = 2.35 * Math.abs(Math.sin(beta)) + 0.55 * Math.cos(beta);
      X += Fxw; Y += Fyw; N += Fyw * xce;
      this.aw = { spd: Vaw * KN, ang: ((beta * 180 / Math.PI) + 360) % 360 };
      this.heelT = clamp(-Fyw / 620000, -0.045, 0.045);

      /* ---------------- bank suction near quays -------------------------- */
      const bank = this.bank;
      if (bank && Math.abs(ur) > 0.3) {
        const d = Math.max(bank.d, 2.5);
        const f = clamp(2600 * ur * ur / (d * d), 0, 5200);
        Y += (bank.nx * ch + bank.nz * sh) * -f;        // suction toward the wall
        N += f * 1.8 * Math.sign((bank.nx * ch + bank.nz * sh));
      }

      /* ---------------- bow mooring line --------------------------------- */
      // Once the ball is on, the bow is tethered: the line takes load only in
      // tension, so she swings freely until it comes taut and then snubs.
      if (this.tether) {
        const bxw = this.x + 7.8 * sh, bzw = this.z - 7.8 * ch;
        const dx = this.tether.x - bxw, dz = this.tether.z - bzw;
        const d = Math.hypot(dx, dz);
        if (d > this.tether.len && d > 0.01) {
          const ux = dx / d, uz = dz / d;
          // velocity of the bow, in world axes
          const bu = this.u, bv = this.v + this.r * 7.8;
          const vwx = bu * sh + bv * ch, vwz = -bu * ch + bv * sh;
          const rate = -(vwx * ux + vwz * uz);          // +ve = stretching
          const F = clamp(38000 * (d - this.tether.len) + 9000 * rate, 0, 62000);
          const fa = F * (ux * sh - uz * ch);           // into body axes
          const fb = F * (ux * ch + uz * sh);
          X += fa; Y += fb; N += 7.8 * fb;
          this.tetherLoad = F;
        } else this.tetherLoad = 0;
      }

      /* ---------------- Froude–Krylov wave forcing ----------------------- */
      const wv2 = SIM.world.waveSlope(this.x, this.z, env.t);
      X += -m * G * (wv2.sx * sh - wv2.sz * ch) * 0.30;
      Y += -m * G * (wv2.sx * ch + wv2.sz * sh) * 0.22;

      /* ---------------- grounding ---------------------------------------- */
      // four corners + centre is enough at 200 Hz; the full outline would cost
      // 3,600 bathymetry lookups a second for no extra fidelity
      const L2 = S.loa / 2, hs = S.hullSep + S.hullBeam / 2;
      let minD = SIM.world.depthAt(this.x, this.z);
      for (const c of [[L2, 0], [-L2, 0], [L2 * 0.5, hs], [L2 * 0.5, -hs], [-L2, hs], [-L2, -hs]]) {
        const px = this.x + c[0] * sh + c[1] * ch, pz = this.z - c[0] * ch + c[1] * sh;
        const d = SIM.world.depthAt(px, pz);
        if (d < minD) minD = d;
      }
      this.underKeel = minD - S.draft - this.squat;
      if (this.underKeel < 0) {
        const bite = clamp(-this.underKeel / 0.55, 0, 1);
        this.groundBite = bite;
        X -= Math.sign(ur || 1) * bite * (11000 + 4200 * Math.abs(ur));
        Y -= Math.sign(vr || 1) * bite * (17000 + 5200 * Math.abs(vr));
        N -= bite * 3.1e5 * this.r;
        if (!this.aground) this.hitFlag = { kind: 'ground', v: Math.abs(ur) };
        this.aground = true;
      } else { this.aground = false; this.groundBite = 0; }

      /* ---------------- integrate ---------------------------------------- */
      const mx = m * 1.06;
      const my = m * (1.75 * kShallow);
      const Iz = this.Izz * 1.6 * (1 + 0.25 * (kShallow - 1));
      const du = (X + my * this.v * this.r) / mx;
      const dv = (Y - mx * this.u * this.r) / my;
      const dr = N / Iz;
      this.u = clamp(this.u + du * dt, -6, 9);
      this.v = clamp(this.v + dv * dt, -4.5, 4.5);
      this.r = clamp(this.r + dr * dt, -0.9, 0.9);

      this.x += (this.u * sh + this.v * ch) * dt;
      this.z += (-this.u * ch + this.v * sh) * dt;
      this.h += this.r * dt;
      if (this.h < 0) this.h += Math.PI * 2;
      if (this.h > Math.PI * 2) this.h -= Math.PI * 2;

      this.contact(dt);
    }

    step(dt, env) {
      this.stepDrive(dt);
      // Bathymetry and the collision short-list change slowly compared with the
      // 200 Hz inner loop, so they are refreshed once per frame.
      this.nearSegs = SIM.world.segmentsNear(this.x, this.z, 26);
      this.bank = SIM.world.nearestWall(this.x, this.z, 14);
      const SUB = 1 / 200;
      let left = Math.min(dt, 0.1);
      while (left > 1e-6) { const s = Math.min(SUB, left); this.substep(s, env); left -= s; }
      const sh = Math.sin(this.h), ch = Math.cos(this.h);
      const Vx = this.u * sh + this.v * ch, Vz = -this.u * ch + this.v * sh;
      this.sog = Math.hypot(Vx, Vz) * KN;
      this.cog = ((Math.atan2(Vx, -Vz) * 180 / Math.PI) + 360) % 360;
      this.hdg = this.h * 180 / Math.PI;
      this.rot = this.r * 180 / Math.PI * 60;
      this.acc = (this.u - this.lastU) / Math.max(dt, 1e-3); this.lastU = this.u;
      // wheel servo (hydraulic steering ≈ 3.5 turns lock to lock)
      this.rud += clamp(this.rudCmd - this.rud, -30 * dt, 30 * dt);
    }

    /* --------------------------------------------------- hull outline pts */
    hullProbes(inset) {
      const k = inset == null ? 1 : inset;
      const sh = Math.sin(this.h), ch = Math.cos(this.h);
      const L = SPEC.loa / 2, hb = SPEC.hullBeam / 2 * k, sep = SPEC.hullSep;
      const loc = [];
      for (const s of [-1, 1]) {
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
      return loc.map(p => [this.x + p[0] * sh + p[1] * ch, this.z - p[0] * ch + p[1] * sh, p[0], p[1]]);
    }

    /* ------------------------------- contact: fender spring-damper ------- */
    contact(dt) {
      const segs = this.nearSegs || SIM.world.segments;
      this.contactNow = 0;
      if (!segs.length) return;
      const pts = this.hullProbes(1);
      const sh = Math.sin(this.h), ch = Math.cos(this.h);
      const m = this.mass, mx = m * 1.06, my = m * 1.75, Iz = this.Izz * 1.6;
      const R = 0.45;
      for (const p of pts) {
        const a = p[2], b = p[3];                       // body-frame offsets
        for (const s of segs) {
          let nx, nz, pen;
          if (s.kind === 'pile') {
            const dx = p[0] - s.ax, dz = p[1] - s.az, d = Math.hypot(dx, dz) || 1e-6;
            pen = R + 0.24 - d; if (pen <= 0) continue;
            nx = dx / d; nz = dz / d;
          } else {
            const ex = s.bx - s.ax, ez = s.bz - s.az, ll = ex * ex + ez * ez || 1e-6;
            const t = clamp(((p[0] - s.ax) * ex + (p[1] - s.az) * ez) / ll, 0, 1);
            const dx = p[0] - (s.ax + ex * t), dz = p[1] - (s.az + ez * t);
            const d = Math.hypot(dx, dz) || 1e-6;
            pen = R - d; if (pen <= 0) continue;
            nx = dx / d; nz = dz / d;
          }
          // contact-point velocity, body frame → normal in body frame
          const nb_a = nx * sh - nz * ch;               // normal, forward component
          const nb_b = nx * ch + nz * sh;               // normal, starboard component
          const vpa = this.u - this.r * b, vpb = this.v + this.r * a;
          const vn = vpa * nb_a + vpb * nb_b;
          const soft = (s.kind === 'boat' || s.kind === 'dock') ? 1 : 1.6;
          const k = 9.0e5 * soft, c = 1.1e5;
          const Fn = Math.max(0, k * pen - c * Math.min(0, vn) * -1);
          const Fmag = k * pen - c * vn;
          if (Fmag <= 0) continue;
          const fa = Fmag * nb_a, fb = Fmag * nb_b;
          this.u += fa / mx * dt;
          this.v += fb / my * dt;
          this.r += (a * fb - b * fa) / Iz * dt;
          // tangential friction
          const ta = -nb_b, tb = nb_a;
          const vt = vpa * ta + vpb * tb;
          const ff = -clamp(vt * 2.2e4, -0.4 * Fmag, 0.4 * Fmag);
          this.u += ff * ta / mx * dt; this.v += ff * tb / my * dt;
          this.r += (a * ff * tb - b * ff * ta) / Iz * dt;
          this.contactNow = Math.max(this.contactNow, pen);
          if (vn < -0.07 && (!this.lastHitT || performance.now() - this.lastHitT > 400)) {
            this.lastHitT = performance.now();
            this.impacts.push({ v: -vn, kind: s.kind });
            this.maxImpact = Math.max(this.maxImpact, -vn);
            this.contacts++;
            this.hitFlag = { kind: s.kind, v: -vn };
          }
        }
      }
    }

    /* ------------------------------------------------------------ render */
    render(t, dt) {
      const S = SPEC, W = SIM.world;
      const sh = Math.sin(this.h), ch = Math.cos(this.h);
      const pt = (f, s) => [this.x + f * sh + s * ch, this.z - f * ch + s * sh];
      const a = pt(6.6, -S.hullSep), b = pt(6.6, S.hullSep);
      const c = pt(-6.6, -S.hullSep), d = pt(-6.6, S.hullSep);
      const ya = W.waveY(a[0], a[1], t), yb = W.waveY(b[0], b[1], t);
      const yc = W.waveY(c[0], c[1], t), yd = W.waveY(d[0], d[1], t);
      const hv = (ya + yb + yc + yd) / 4 - this.squat;
      const pitch = Math.atan2(((ya + yb) - (yc + yd)) / 2, 13.2);
      const roll = Math.atan2(((yb + yd) - (ya + yc)) / 2, S.hullSep * 2);
      const k = Math.min(1, dt * 6);
      this.heave += (hv - this.heave) * k;
      this.pitch += (pitch * 0.6 - 0.012 * this.acc - this.pitch) * k * 0.9;
      this.heel += ((roll * 0.55 + this.heelT) - this.heel) * k * 0.7;

      const g = this.mesh;
      g.position.set(this.x, this.heave, this.z);
      g.rotation.set(0, 0, 0);
      g.rotateY(-this.h); g.rotateX(this.pitch); g.rotateZ(this.heel);
      // ~1.1 turns of wheel each way for 35° of rudder, so the spokes visibly
      // sweep as you steer instead of nudging a few degrees
      if (g.userData.wheel) g.userData.wheel.rotation.z = -this.rud * 0.20;
      for (let i = 0; i < g.userData.props.length; i++)
        g.userData.props[i].rotation.z += this.rpm[i] / S.gearRatio / 60 * this.gear[i] * dt * 6.2;

      this.wakeAcc += dt;
      if (this.wakeAcc > 0.05) {
        const step = this.wakeAcc; this.wakeAcc = 0;
        for (let i = 0; i < 2; i++) {
          const T = Math.abs(this.thrust[i]);
          if (T > 100) {
            const s = i === 0 ? -1 : 1;
            const p = pt(S.propX - 1.3 * Math.sign(this.thrust[i]), s * S.hullSep);
            W.addWake(p[0], p[1], clamp(T / 3800, 0.08, 0.9), 1.7);
          }
        }
        const spd = Math.hypot(this.u, this.v);
        if (spd > 0.45) for (const s of [-1, 1]) {
          const p = pt(5.6, s * (S.hullSep + 0.55));
          W.addWake(p[0], p[1], clamp(spd / 4.5, 0.05, 0.65), 1.2);
        }
      }
    }

    get speedKn() { return Math.hypot(this.u, this.v) * KN; }
    get bollardPct() { return (Math.abs(this.thrust[0]) + Math.abs(this.thrust[1])) / (2 * 5400); }
  }

  SIM.Boat = Boat;
  SIM.SPEC = SPEC;
  SIM.PROP = PROP;
})();
