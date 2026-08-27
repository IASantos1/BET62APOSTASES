// =============================================================================
//  MOTOR 3D DO MINI CAMPO (Three.js) — estádio completo (bancadas, túneis,
//  holofotes, painéis publicitários), construído a partir do modelo HTML que
//  o utilizador enviou ("BET62 3D Match Tracker"). Substitui o motor 2D
//  (tracker2d.js) — pedido explícito do utilizador.
//
//  Carregado por index.html <script src="tracker3d.js"> ANTES de app.js.
//  Funções globais: pauseTracker3D, ensureTracker3DCanvas, mountTracker3D,
//  updateTracker3DFromPoints — app.js chama-as com a MESMA assinatura que já
//  usava para tracker2d.js (troca direta, ver renderPitchInto em app.js).
//
//  DADOS REAIS, NUNCA INVENTADOS — a cena (bancadas, túneis, holofotes,
//  painéis "BET62", relva, marcações, balizas, bandeiras de canto) é
//  decoração fixa, sem nenhum dado do jogo. Só o que se MOVE é real:
//    - Posição da bola: trackerBallState.points (Sportmonks ballCoordinates)
//    - Zona de perigo: ballDangerZone(x) — mesma função pura de sempre
//    - Indicador de canto: isInCornerZone/nearestCorner — idem
//    - Flash de golo: detectNewGoal(e) — só dispara com um golo confirmado
//      na linha do tempo real, nunca antecipado
//  O script original enviado pelo utilizador tinha uma bola a andar num
//  percurso pré-programado ("SAÍDA DE BOLA" → "PASSE" → ...) e um relógio a
//  contar sozinho — removido por completo; substituído pelos dados reais
//  acima, exatamente como o motor 2D anterior já fazia.
//
//  BIBLIOTECA: Three.js + OrbitControls (só os módulos usados, ~480kb
//  minificado, gerado com esbuild a partir de node_modules/three — sem CDN
//  nenhum) em vendor/three.bundle.min.js, carregado por este ficheiro só
//  quando um jogo de futebol ao vivo com cobertura de posição da bola
//  precisa dele (ensureTracker3DReady) — nunca no arranque da app.
//
//  SINGLETON REANCORÁVEL: UM ÚNICO <canvas> WebGL partilhado entre o
//  cabeçalho compacto (#mt-pulse) e o modal cheio (#tracker-pitch-wrap) —
//  nunca dois contextos abertos ao mesmo tempo (browsers limitam a poucos
//  por separador). mountTracker3D() só reancora o canvas já existente.

(function () {
  "use strict";

  // ============ helpers de lookup (pegam funções do app.js via window) ============
  const g = (name) => window[name];
  const call = (name, ...a) => { const f = g(name); return typeof f === "function" ? f(...a) : undefined; };

  // ============ dimensões reais do campo (metros, FIFA) ============
  const FIELD_LEN = 105;
  const FIELD_WID = 68;
  // Casa à esquerda (x real 0 → X negativo), fora à direita (x real 1 → X positivo) — MESMA
  // convenção já usada em todo o resto da app (2D e na primeira versão 3D).
  function worldX(xReal) { return (xReal - 0.5) * FIELD_LEN; }
  function worldZ(yReal) { return (yReal - 0.5) * FIELD_WID; }

  // ============ carregamento preguiçoso da biblioteca ============
  let libLoadPromise = null;
  function loadThreeLib() {
    if (window.THREE) return Promise.resolve(window.THREE);
    if (libLoadPromise) return libLoadPromise;
    libLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "vendor/three.bundle.min.js";
      script.onload = () => (window.THREE ? resolve(window.THREE) : reject(new Error("Three.js não carregou")));
      script.onerror = () => reject(new Error("Falha ao carregar Three.js"));
      document.head.appendChild(script);
    });
    return libLoadPromise;
  }

  // =============================================================================
  //  CONSTRUÇÃO DO ESTÁDIO (adaptado do modelo enviado pelo utilizador) — tudo
  //  aqui é geometria/decoração fixa, sem nenhum dado do jogo. Só corre UMA VEZ
  //  (ensureTracker3DScene é um singleton), reaproveitado entre navegações.
  // =============================================================================
  function buildStadium(THREE) {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x18382a);

    const camera = new THREE.PerspectiveCamera(43, 1, 0.1, 1000);
    camera.position.set(0, 46, 122);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.18;

    const controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.enablePan = false;
    controls.minDistance = 60;
    controls.maxDistance = 220;
    controls.maxPolarAngle = Math.PI / 2.15;
    controls.target.set(0, 0, 0);
    controls.enabled = false; // só ligado quando montado no modal cheio (ver mountTracker3D)
    controls.update();

    const fieldGroup = new THREE.Group();
    scene.add(fieldGroup);

    // ---- base + relva ----
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(132, 2.5, 88),
      new THREE.MeshStandardMaterial({ color: 0x020b05, roughness: 1, metalness: 0 })
    );
    base.position.y = -1.4;
    base.receiveShadow = true;
    fieldGroup.add(base);

    const grass = new THREE.Mesh(
      new THREE.PlaneGeometry(FIELD_LEN, FIELD_WID),
      new THREE.MeshStandardMaterial({ color: 0x07521f, roughness: 1, metalness: 0, envMapIntensity: 0.005 })
    );
    grass.rotation.x = -Math.PI / 2;
    grass.position.y = 0.02;
    grass.receiveShadow = true;
    fieldGroup.add(grass);

    // ---- textura de grama (lâminas desenhadas num canvas 2D, nunca uma imagem externa) ----
    const grassCanvas = document.createElement("canvas");
    grassCanvas.width = 2048;
    grassCanvas.height = 2048;
    const gctx = grassCanvas.getContext("2d");
    let seed = 7262;
    function rand() {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    }
    for (let i = 0; i < 42000; i++) {
      const x = rand() * 2048, y = rand() * 2048;
      const h = 3.2 + rand() * 8, lean = (rand() - 0.5) * 5, alpha = 0.2 + rand() * 0.3;
      const green = 65 + Math.floor(rand() * 55), red = 8 + Math.floor(rand() * 15), blue = 18 + Math.floor(rand() * 22);
      gctx.strokeStyle = `rgba(${red},${green},${blue},${alpha})`;
      gctx.lineWidth = 0.65 + rand() * 0.85;
      gctx.beginPath();
      gctx.moveTo(x, y);
      gctx.quadraticCurveTo(x + lean * 0.5, y - h * 0.5, x + lean, y - h);
      gctx.stroke();
    }
    for (let i = 0; i < 22000; i++) {
      const x = rand() * 2048, y = rand() * 2048, h = 2 + rand() * 6;
      gctx.strokeStyle = `rgba(2,25,9,${0.18 + rand() * 0.22})`;
      gctx.lineWidth = 0.5 + rand() * 0.7;
      gctx.beginPath();
      gctx.moveTo(x, y);
      gctx.lineTo(x + (rand() - 0.5) * 4, y - h);
      gctx.stroke();
    }
    for (let i = 0; i < 9000; i++) {
      const x = rand() * 2048, y = rand() * 2048, h = 3 + rand() * 7;
      for (let j = 0; j < 4; j++) {
        const ox = (rand() - 0.5) * 5, bend = (rand() - 0.5) * 5;
        gctx.strokeStyle = `rgba(30,105,42,${0.18 + rand() * 0.22})`;
        gctx.lineWidth = 0.45 + rand() * 0.65;
        gctx.beginPath();
        gctx.moveTo(x + ox, y);
        gctx.quadraticCurveTo(x + ox + bend, y - h * 0.45, x + ox + bend * 1.3, y - h);
        gctx.stroke();
      }
    }
    const grassTexture = new THREE.CanvasTexture(grassCanvas);
    grassTexture.wrapS = THREE.ClampToEdgeWrapping;
    grassTexture.wrapT = THREE.ClampToEdgeWrapping;
    grassTexture.minFilter = THREE.LinearMipMapLinearFilter;
    grassTexture.magFilter = THREE.LinearFilter;

    const grassDetail = new THREE.Mesh(
      new THREE.PlaneGeometry(FIELD_LEN, FIELD_WID),
      new THREE.MeshBasicMaterial({ map: grassTexture, transparent: true, opacity: 1, depthWrite: false })
    );
    grassDetail.rotation.x = -Math.PI / 2;
    grassDetail.position.y = 0.058;
    fieldGroup.add(grassDetail);

    function grassStripe(x, color, opacity) {
      const stripe = new THREE.Mesh(
        new THREE.PlaneGeometry(10.5, 68),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false })
      );
      stripe.rotation.x = -Math.PI / 2;
      stripe.position.set(x, 0.043, 0);
      fieldGroup.add(stripe);
    }
    for (let i = 0; i < 11; i++) {
      const x = -50 + i * 10;
      grassStripe(x, i % 2 === 0 ? 0x0c5427 : 0x031f0d, i % 2 === 0 ? 0.16 : 0.13);
    }
    for (let i = 0; i < 10; i++) {
      const x = -45 + i * 10;
      const t = new THREE.Mesh(
        new THREE.PlaneGeometry(1.8, 68),
        new THREE.MeshBasicMaterial({ color: 0x0a451f, transparent: true, opacity: 0.045, depthWrite: false })
      );
      t.rotation.x = -Math.PI / 2;
      t.position.set(x, 0.046, 0);
      fieldGroup.add(t);
    }

    // ---- marcações ----
    const lineMaterial = new THREE.LineBasicMaterial({ color: 0xf4f7f2, transparent: true, opacity: 0.96 });
    function line(points) {
      fieldGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), lineMaterial));
    }
    line([
      new THREE.Vector3(-52.5, 0.09, -34), new THREE.Vector3(52.5, 0.09, -34),
      new THREE.Vector3(52.5, 0.09, 34), new THREE.Vector3(-52.5, 0.09, 34), new THREE.Vector3(-52.5, 0.09, -34),
    ]);
    line([new THREE.Vector3(0, 0.09, -34), new THREE.Vector3(0, 0.09, 34)]);
    const cp = [];
    for (let i = 0; i <= 96; i++) {
      const a = (i / 96) * Math.PI * 2;
      cp.push(new THREE.Vector3(Math.cos(a) * 9.15, 0.09, Math.sin(a) * 9.15));
    }
    line(cp);
    const dot = new THREE.Mesh(new THREE.CircleGeometry(0.55, 16), new THREE.MeshBasicMaterial({ color: 0xf4f7f2 }));
    dot.rotation.x = -Math.PI / 2;
    dot.position.y = 0.1;
    fieldGroup.add(dot);

    function penaltyArea(side) {
      const x = side * 52.5, d = side > 0 ? -1 : 1;
      line([
        new THREE.Vector3(x, 0.09, -20), new THREE.Vector3(x + d * 16.5, 0.09, -20),
        new THREE.Vector3(x + d * 16.5, 0.09, 20), new THREE.Vector3(x, 0.09, 20),
      ]);
      line([
        new THREE.Vector3(x, 0.09, -9), new THREE.Vector3(x + d * 5.5, 0.09, -9),
        new THREE.Vector3(x + d * 5.5, 0.09, 9), new THREE.Vector3(x, 0.09, 9),
      ]);
      const p = new THREE.Mesh(new THREE.CircleGeometry(0.55, 16), new THREE.MeshBasicMaterial({ color: 0xf4f7f2 }));
      p.rotation.x = -Math.PI / 2;
      p.position.set(x + d * 11, 0.1, 0);
      fieldGroup.add(p);
    }
    penaltyArea(-1);
    penaltyArea(1);

    function penaltyArc(side) {
      const x = side * 52.5, d = side > 0 ? -1 : 1;
      const cx = x + d * 11, radius = 9.15, dxFront = 16.5 - 11;
      const zEnd = Math.sqrt(radius * radius - dxFront * dxFront);
      const pts = [];
      for (let i = 0; i <= 80; i++) {
        const z = -zEnd + (2 * zEnd * i) / 80;
        const dx = Math.sqrt(Math.max(0, radius * radius - z * z));
        pts.push(new THREE.Vector3(cx + d * dx, 0.1, z));
      }
      line(pts);
    }
    penaltyArc(-1);
    penaltyArc(1);

    // ---- cantos + bandeiras ----
    const cornerFlagRefs = {};
    function corner(sx, sz) {
      const cx = sx * 52.5, cz = sz * 34, r = 1.05, pts = [];
      let st;
      if (sx < 0) st = sz < 0 ? 0 : -Math.PI / 2;
      else st = sz < 0 ? Math.PI / 2 : Math.PI;
      for (let i = 0; i <= 18; i++) {
        const a = st + ((Math.PI / 2) * i) / 18;
        pts.push(new THREE.Vector3(cx + Math.cos(a) * r, 0.1, cz + Math.sin(a) * r));
      }
      line(pts);
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.045, 0.055, 2.7, 8),
        new THREE.MeshStandardMaterial({ color: 0xd8d8d8, roughness: 0.7, metalness: 0.1 })
      );
      pole.position.set(cx, 1.35, cz);
      scene.add(pole);
      const flag = new THREE.Mesh(
        new THREE.PlaneGeometry(0.9, 0.55),
        new THREE.MeshBasicMaterial({ color: 0xe5232f, side: THREE.DoubleSide })
      );
      flag.position.set(cx + (sx < 0 ? 0.45 : -0.45), 2.25, cz);
      flag.rotation.y = sx < 0 ? 0 : Math.PI;
      scene.add(flag);
      cornerFlagRefs[`${sx < 0 ? 0 : 1},${sz < 0 ? 0 : 1}`] = { x: cx, z: cz };
    }
    corner(-1, -1);
    corner(-1, 1);
    corner(1, -1);
    corner(1, 1);

    // ---- balizas ----
    function goal(side) {
      const x = side * 52.5, d = side > 0 ? 1 : -1;
      const width = 7.32, height = 2.44, depth = 2.8, half = width / 2;
      const gGroup = new THREE.Group();
      const postMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.32, metalness: 0.08 });
      const netMaterial = new THREE.LineBasicMaterial({ color: 0xdce4e0, transparent: true, opacity: 0.34 });
      function tube(a, b, r) {
        r = r || 0.14;
        const v = new THREE.Vector3().subVectors(b, a);
        const len = v.length();
        const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 12), postMaterial);
        mesh.position.copy(a.clone().add(b).multiplyScalar(0.5));
        mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), v.normalize());
        mesh.castShadow = true;
        gGroup.add(mesh);
      }
      tube(new THREE.Vector3(x, 0, -half), new THREE.Vector3(x, height, -half));
      tube(new THREE.Vector3(x, 0, half), new THREE.Vector3(x, height, half));
      tube(new THREE.Vector3(x, height, -half), new THREE.Vector3(x, height, half));
      const backX = x + d * depth;
      tube(new THREE.Vector3(backX, 0, -half), new THREE.Vector3(backX, height, -half), 0.11);
      tube(new THREE.Vector3(backX, 0, half), new THREE.Vector3(backX, height, half), 0.11);
      tube(new THREE.Vector3(backX, height, -half), new THREE.Vector3(backX, height, half), 0.11);
      tube(new THREE.Vector3(x, 0, -half), new THREE.Vector3(backX, 0, -half), 0.1);
      tube(new THREE.Vector3(x, 0, half), new THREE.Vector3(backX, 0, half), 0.1);

      const net = new THREE.Group();
      const rows = 9, cols = 13;
      for (let i = 0; i <= rows; i++) {
        const z = -half + (width * i) / rows;
        net.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(x, 0.04, z), new THREE.Vector3(backX, height, z)]), netMaterial));
      }
      for (let i = 0; i <= cols; i++) {
        const xx = x + d * ((depth * i) / cols);
        net.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(xx, height, -half), new THREE.Vector3(xx, height, half)]), netMaterial));
      }
      for (let i = 0; i <= cols; i++) {
        const z = -half + (width * i) / cols;
        net.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(backX, 0.02, z), new THREE.Vector3(backX, height, z)]), netMaterial));
      }
      for (let i = 0; i <= rows; i++) {
        const y = (height * i) / rows;
        net.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(backX, y, -half), new THREE.Vector3(backX, y, half)]), netMaterial));
      }
      for (const z of [-half, half]) {
        for (let i = 0; i <= cols; i++) {
          const xx = x + d * ((depth * i) / cols);
          net.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(xx, 0.02, z), new THREE.Vector3(xx, height, z)]), netMaterial));
        }
      }
      gGroup.add(net);
      scene.add(gGroup);
    }
    goal(-1);
    goal(1);

    // ---- bancadas ----
    const standsGroup = new THREE.Group();
    scene.add(standsGroup);
    const standMaterial = new THREE.MeshStandardMaterial({ color: 0x111820, roughness: 0.86 });
    const seatMaterial = new THREE.MeshStandardMaterial({ color: 0x26313a, roughness: 0.7 });
    const aisleMaterial = new THREE.MeshStandardMaterial({ color: 0x080c10, roughness: 0.95 });
    const doorMat = new THREE.MeshStandardMaterial({ color: 0x1a222a, roughness: 0.7 });
    const doorFrameMat = new THREE.MeshStandardMaterial({ color: 0x3a4550, roughness: 0.55, metalness: 0.15 });
    const doorSignMat = new THREE.MeshBasicMaterial({ color: 0xe5232f });

    function exitDoor(x, y, z, rotY) {
      const dGroup = new THREE.Group();
      const frame = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.2, 0.7), doorFrameMat);
      frame.position.y = 1.1;
      dGroup.add(frame);
      const hole = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.8, 0.9), doorMat);
      hole.position.y = 1.0;
      dGroup.add(hole);
      const floor = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.1, 2.5), doorMat);
      floor.position.set(0, 0.05, -0.8);
      dGroup.add(floor);
      const sign = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.22, 0.05), doorSignMat);
      sign.position.set(0, 2.0, 0.38);
      dGroup.add(sign);
      dGroup.position.set(x, y, z);
      dGroup.rotation.y = rotY || 0;
      standsGroup.add(dGroup);
    }

    function standBox(w, h, d, x, y, z, mat) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      m.receiveShadow = true;
      standsGroup.add(m);
    }

    function buildLongStand(side) {
      const tiers = 5, stepsPerTier = 3, stepDepth = 3.2, stepHeight = 0.72, tierGap = 1.1;
      let currentY = 0.5, currentZ = 43;
      for (let t = 0; t < tiers; t++) {
        for (let i = 0; i < stepsPerTier; i++) {
          const y = currentY + i * stepHeight;
          const z = side * (currentZ + i * stepDepth);
          standBox(112, stepHeight, stepDepth, 0, y, z, standMaterial);
          for (let s = 0; s < 32; s++) {
            const x = -52 + s * (104 / 31);
            standBox(2.4, 0.22, 0.55, x, y + 0.52, z - side * 0.22, seatMaterial);
          }
        }
        const doorY = currentY + 0.15;
        const doorZ = side * (currentZ + stepsPerTier * stepDepth * 0.5);
        exitDoor(-28, doorY, doorZ, side > 0 ? Math.PI : 0);
        exitDoor(28, doorY, doorZ, side > 0 ? Math.PI : 0);
        currentY += stepsPerTier * stepHeight + tierGap;
        currentZ += stepsPerTier * stepDepth + 2.2;
        if (t < tiers - 1) {
          const platY = currentY - tierGap * 0.55;
          const platZ = side * (currentZ - 1.1);
          standBox(112, 0.3, 2.4, 0, platY, platZ, aisleMaterial);
        }
      }
    }

    function buildEndStand(side) {
      const tiers = 5, stepsPerTier = 3, stepDepth = 3.2, stepHeight = 0.72, tierGap = 1.1;
      let currentY = 0.5, currentX = 62;
      for (let t = 0; t < tiers; t++) {
        for (let i = 0; i < stepsPerTier; i++) {
          const y = currentY + i * stepHeight;
          const x = side * (currentX + i * stepDepth);
          standBox(stepDepth, stepHeight, 78, x, y, 0, standMaterial);
          for (let s = 0; s < 22; s++) {
            const z = -36 + s * (72 / 21);
            standBox(0.55, 0.22, 2.4, x - side * 0.22, y + 0.52, z, seatMaterial);
          }
        }
        const doorY = currentY + 0.15;
        const doorX = side * (currentX + stepsPerTier * stepDepth * 0.5);
        exitDoor(doorX, doorY, -18, side > 0 ? -Math.PI / 2 : Math.PI / 2);
        exitDoor(doorX, doorY, 18, side > 0 ? -Math.PI / 2 : Math.PI / 2);
        currentY += stepsPerTier * stepHeight + tierGap;
        currentX += stepsPerTier * stepDepth + 2.2;
        if (t < tiers - 1) {
          const platY = currentY - tierGap * 0.55;
          const platX = side * (currentX - 1.1);
          standBox(2.4, 0.3, 78, platX, platY, 0, aisleMaterial);
        }
      }
    }

    function curvedSeat(x, y, z, angle) {
      const seat = new THREE.Mesh(new THREE.BoxGeometry(2.45, 0.24, 0.62), seatMaterial);
      seat.position.set(x, y, z);
      seat.rotation.y = angle;
      seat.castShadow = true;
      seat.receiveShadow = true;
      standsGroup.add(seat);
    }

    function buildCornerStand(sx, sz) {
      const cx = sx * 52.5, cz = sz * 34, levelHeight = 0.72, baseRadius = 9.0, stepRadius = 3.2;
      const seats = 15, segments = 24, tiers = 5, stepsPerTier = 3, tierGap = 1.1;
      function angleAt(t) {
        if (sx > 0 && sz < 0) return -Math.PI / 2 + t * (Math.PI / 2);
        if (sx > 0 && sz > 0) return t * (Math.PI / 2);
        if (sx < 0 && sz > 0) return Math.PI / 2 + t * (Math.PI / 2);
        return Math.PI + t * (Math.PI / 2);
      }
      let currentY = 0.5, radiusOffset = 0;
      for (let t = 0; t < tiers; t++) {
        for (let level = 0; level < stepsPerTier; level++) {
          const radius = baseRadius + radiusOffset + level * stepRadius;
          const y = currentY + level * levelHeight;
          for (let i = 0; i < seats; i++) {
            const ang = angleAt(i / (seats - 1));
            const x = cx + Math.cos(ang) * radius, z = cz + Math.sin(ang) * radius;
            curvedSeat(x, y + 0.52, z, ang + Math.PI / 2);
          }
          for (let i = 0; i < segments; i++) {
            const ang = angleAt((i + 0.5) / segments);
            const x = cx + Math.cos(ang) * (radius + 1.0), z = cz + Math.sin(ang) * (radius + 1.0);
            const step = new THREE.Mesh(new THREE.BoxGeometry(4.5, levelHeight, 3.6), standMaterial);
            step.position.set(x, y, z);
            step.rotation.y = ang + Math.PI / 2;
            step.castShadow = true;
            step.receiveShadow = true;
            standsGroup.add(step);
          }
        }
        currentY += stepsPerTier * levelHeight + tierGap;
        radiusOffset += stepsPerTier * stepRadius + 2.0;
        if (t < tiers - 1) {
          const platRadius = baseRadius + radiusOffset - 1.0;
          const platY = currentY - tierGap * 0.55;
          for (let i = 0; i < segments; i++) {
            const ang = angleAt((i + 0.5) / segments);
            const x = cx + Math.cos(ang) * platRadius, z = cz + Math.sin(ang) * platRadius;
            const plat = new THREE.Mesh(new THREE.BoxGeometry(3.8, 0.28, 3.0), aisleMaterial);
            plat.position.set(x, platY, z);
            plat.rotation.y = ang + Math.PI / 2;
            standsGroup.add(plat);
          }
        }
      }
    }

    // Estádio em U — lado da câmara (+Z) aberto, igual ao modelo original.
    buildCornerStand(-1, -1);
    buildCornerStand(1, -1);
    buildLongStand(-1);
    buildEndStand(-1);
    buildEndStand(1);

    // ---- túneis de entrada dos jogadores (decoração, com o logótipo BET62) ----
    const tunnelMat = new THREE.MeshStandardMaterial({ color: 0x0d1218, roughness: 0.85 });
    const tunnelFrameMat = new THREE.MeshStandardMaterial({ color: 0xc8d0d6, roughness: 0.4, metalness: 0.25 });
    const tunnelInnerMat = new THREE.MeshStandardMaterial({ color: 0x1a2030, roughness: 0.9 });

    function playerEntrance(sx, sz) {
      const eGroup = new THREE.Group();
      const frame = new THREE.Mesh(new THREE.BoxGeometry(5.2, 3.4, 1.2), tunnelFrameMat);
      frame.position.y = 1.7;
      eGroup.add(frame);
      const hole = new THREE.Mesh(new THREE.BoxGeometry(4.2, 2.8, 1.4), tunnelInnerMat);
      hole.position.y = 1.5;
      eGroup.add(hole);
      const floor = new THREE.Mesh(new THREE.BoxGeometry(4.0, 0.15, 6.0), tunnelMat);
      floor.position.set(0, 0.08, -2.5);
      eGroup.add(floor);
      const wallL = new THREE.Mesh(new THREE.BoxGeometry(0.25, 2.8, 5.5), tunnelMat);
      wallL.position.set(-2.1, 1.4, -2.2);
      eGroup.add(wallL);
      const wallR = new THREE.Mesh(new THREE.BoxGeometry(0.25, 2.8, 5.5), tunnelMat);
      wallR.position.set(2.1, 1.4, -2.2);
      eGroup.add(wallR);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(4.5, 0.2, 5.5), tunnelMat);
      roof.position.set(0, 2.9, -2.2);
      eGroup.add(roof);

      const signCanvas = document.createElement("canvas");
      signCanvas.width = 256;
      signCanvas.height = 64;
      const sctx = signCanvas.getContext("2d");
      sctx.fillStyle = "#111111";
      sctx.fillRect(0, 0, 256, 64);
      sctx.font = "bold 36px Arial";
      sctx.textAlign = "center";
      sctx.textBaseline = "middle";
      sctx.fillStyle = "#ffffff";
      sctx.fillText("BET", 100, 32);
      sctx.fillStyle = "#e5232f";
      sctx.fillText("62", 165, 32);
      const signTex = new THREE.CanvasTexture(signCanvas);
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 0.8), new THREE.MeshBasicMaterial({ map: signTex }));
      sign.position.set(0, 3.6, 0.65);
      eGroup.add(sign);

      const cx = sx * 56.5, cz = sz * 40.5;
      eGroup.position.set(cx, 0, cz);
      eGroup.rotation.y = Math.atan2(-cx, -cz);
      scene.add(eGroup);
    }
    playerEntrance(-1, -1);
    playerEntrance(1, -1);

    const railMaterial = new THREE.MeshStandardMaterial({ color: 0x3a454d, roughness: 0.5, metalness: 0.25 });
    standBox(140, 0.16, 0.16, 0, 17.5, -112, railMaterial);
    standBox(140, 0.16, 0.16, 0, 17.5, 112, railMaterial);
    standBox(0.16, 0.16, 112, -112, 17.5, 0, railMaterial);
    standBox(0.16, 0.16, 112, 112, 17.5, 0, railMaterial);

    function standLight(x, z) {
      const l = new THREE.PointLight(0xcfe9ff, 0.22, 48);
      l.position.set(x, 14, z);
      standsGroup.add(l);
    }
    [-45, 0, 45].forEach((x) => {
      standLight(x, -76);
      standLight(x, 76);
    });
    [-28, 28].forEach((z) => {
      standLight(-76, z);
      standLight(76, z);
    });

    // ---- painéis publicitários (BET62) ----
    const adGroup = new THREE.Group();
    scene.add(adGroup);
    function makeAdTexture(count, scale) {
      const c = document.createElement("canvas");
      c.width = 1024;
      c.height = 128;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#4a5560";
      ctx.fillRect(0, 0, 1024, 128);
      ctx.fillStyle = "rgba(255,255,255,.07)";
      ctx.fillRect(0, 0, 1024, 4);
      ctx.fillRect(0, 124, 1024, 4);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const fontSize = Math.round(56 * (scale || 1));
      const step = 1024 / count;
      for (let i = 0; i < count; i++) {
        const cx = step * (i + 0.5);
        ctx.font = "bold " + fontSize + "px Arial, Helvetica, sans-serif";
        ctx.fillStyle = "#111111";
        ctx.fillText("BET", cx - 36 * (scale || 1), 64);
        ctx.fillStyle = "#e5232f";
        ctx.fillText("62", cx + 46 * (scale || 1), 64);
      }
      const tex = new THREE.CanvasTexture(c);
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      return tex;
    }
    const adTexSide = makeAdTexture(2, 1.0);
    const adTexEnd = makeAdTexture(2, 0.72);
    const adBaseMat = new THREE.MeshStandardMaterial({ color: 0x2a3238, roughness: 0.9 });
    function adStrip(w, h, x, y, z, rotY, tex) {
      const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
      mesh.position.set(x, y, z);
      mesh.rotation.y = rotY;
      adGroup.add(mesh);
      const base = new THREE.Mesh(new THREE.BoxGeometry(w + 0.2, 0.16, 0.32), adBaseMat);
      base.position.set(x, y - h / 2 - 0.08, z);
      base.rotation.y = rotY;
      adGroup.add(base);
    }
    adStrip(105, 1.45, 0, 0.9, -36.0, 0, adTexSide);
    adStrip(68, 1.45 * 0.85, -54.8, 0.85, 0, Math.PI / 2, adTexEnd);
    adStrip(68, 1.45 * 0.85, 54.8, 0.85, 0, -Math.PI / 2, adTexEnd);

    // ---- postes de luz ----
    const lightsGroup = new THREE.Group();
    scene.add(lightsGroup);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x8a9299, roughness: 0.45, metalness: 0.35 });
    const headMat = new THREE.MeshStandardMaterial({ color: 0x2a3036, roughness: 0.5, metalness: 0.2 });
    const reflectorMat = new THREE.MeshStandardMaterial({ color: 0xe8eef2, roughness: 0.2, metalness: 0.45, emissive: 0xfff0c8, emissiveIntensity: 1.2 });
    const glowMat = new THREE.MeshBasicMaterial({ color: 0xfff4b0, transparent: true, opacity: 0.72, depthWrite: false });
    const glowCoreMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, depthWrite: false });
    const glowOuterMat = new THREE.MeshBasicMaterial({ color: 0xffe080, transparent: true, opacity: 0.28, depthWrite: false });
    function lightTower(x, z) {
      const tGroup = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.72, 28, 12), poleMat);
      pole.position.y = 14;
      pole.castShadow = true;
      tGroup.add(pole);
      const frame = new THREE.Mesh(new THREE.BoxGeometry(5.5, 9.5, 0.4), poleMat);
      frame.position.set(0, 28.5, 1.5);
      tGroup.add(frame);
      const cols = [-1.6, 1.6], rows = [0, 2.1, 4.2, 6.3];
      cols.forEach((cx) => {
        rows.forEach((ry) => {
          const head = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.1, 1.0), headMat);
          head.position.set(cx, 25.2 + ry, 2.6);
          head.rotation.x = 0.5;
          tGroup.add(head);
          const reflector = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.62, 0.22, 14), reflectorMat);
          reflector.position.set(cx, 24.9 + ry, 3.25);
          reflector.rotation.x = Math.PI / 2 + 0.5;
          tGroup.add(reflector);
          const core = new THREE.Mesh(new THREE.SphereGeometry(0.32, 14, 14), glowCoreMat);
          core.position.set(cx, 24.75 + ry, 3.55);
          tGroup.add(core);
          const halo = new THREE.Mesh(new THREE.SphereGeometry(0.85, 16, 16), glowMat);
          halo.position.set(cx, 24.75 + ry, 3.55);
          tGroup.add(halo);
          const outer = new THREE.Mesh(new THREE.SphereGeometry(1.4, 16, 16), glowOuterMat);
          outer.position.set(cx, 24.75 + ry, 3.55);
          tGroup.add(outer);
          const spot = new THREE.SpotLight(0xfff2dc, 0.7, 190, Math.PI / 5.5, 0.42, 1);
          spot.position.set(cx, 24.7 + ry, 3.6);
          spot.target.position.set(-x * 0.1, 0, -z * 0.25);
          tGroup.add(spot);
          tGroup.add(spot.target);
        });
      });
      tGroup.position.set(x, 0, z);
      lightsGroup.add(tGroup);
    }
    lightTower(-52, -98);
    lightTower(52, -98);

    function flood(x, z) {
      const l = new THREE.PointLight(0xffffff, 0.78, 110);
      l.position.set(x, 32, z);
      scene.add(l);
    }
    flood(-55, -38);
    flood(55, -38);
    flood(-55, 38);
    flood(55, 38);

    // ---- iluminação geral ----
    scene.add(new THREE.HemisphereLight(0xf3fbff, 0x0d2417, 0.9));
    const main = new THREE.DirectionalLight(0xffffff, 1.65);
    main.position.set(20, 85, 30);
    main.castShadow = true;
    main.shadow.mapSize.width = 2048;
    main.shadow.mapSize.height = 2048;
    main.shadow.camera.left = -80;
    main.shadow.camera.right = 80;
    main.shadow.camera.top = 80;
    main.shadow.camera.bottom = -80;
    scene.add(main);
    const fill = new THREE.DirectionalLight(0xb9d7ea, 0.42);
    fill.position.set(-60, 45, -50);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0xdff5e7, 0.24);
    rim.position.set(0, 28, 90);
    scene.add(rim);

    // =========================================================================
    //  BOLA + INDICADORES REAIS — nada aqui é decoração; tudo é movido pelos
    //  dados reais em updateTracker3DFromPoints() abaixo.
    // =========================================================================
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(0.55 * 1.04, 32, 32),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0 })
    );
    ball.castShadow = true;
    ball.position.set(0, 1.1, 0);
    scene.add(ball);

    const ballGlow = new THREE.Mesh(
      new THREE.SphereGeometry(0.55 * 1.55, 24, 24),
      new THREE.MeshBasicMaterial({ color: 0x9fffd0, transparent: true, opacity: 0.055, depthWrite: false })
    );
    ballGlow.position.copy(ball.position);
    scene.add(ballGlow);

    const ballShadow = new THREE.Mesh(
      new THREE.CircleGeometry(1.4, 24),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.24, depthWrite: false })
    );
    ballShadow.rotation.x = -Math.PI / 2;
    ballShadow.position.y = 0.1;
    scene.add(ballShadow);

    // Rasto: pool fixa de esferas reaproveitadas a cada atualização (nunca cria/destrói objetos a
    // cada posição nova) — mesma ideia já usada no motor 2D e na primeira versão 3D.
    const TRAIL_LEN = 10;
    const trailPool = [];
    for (let i = 0; i < TRAIL_LEN; i++) {
      const tDot = new THREE.Mesh(
        new THREE.SphereGeometry(0.32, 8, 8),
        new THREE.MeshBasicMaterial({ color: 0xf5c842, transparent: true })
      );
      tDot.visible = false;
      scene.add(tDot);
      trailPool.push(tDot);
    }

    // Zona de perigo real — disco colorido no relvado sob a bola, cor conforme a distância real
    // (x) à baliza mais próxima (ver ballDangerZone em app.js). Nunca rotulado como posse de bola.
    const dangerGlow = new THREE.Mesh(
      new THREE.CircleGeometry(3.0, 32),
      new THREE.MeshBasicMaterial({ color: 0xf5c842, transparent: true, opacity: 0.28, side: THREE.DoubleSide })
    );
    dangerGlow.rotation.x = -Math.PI / 2;
    dangerGlow.position.y = 0.04;
    dangerGlow.visible = false;
    scene.add(dangerGlow);

    // Indicador de canto real — linha tracejada da bola até à bandeira mais próxima, só quando a
    // bola real está mesmo na zona do canto (nunca finge que um canto foi marcado).
    const cornerLineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    const cornerLine = new THREE.Line(cornerLineGeo, new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.9, gapSize: 0.6, transparent: true, opacity: 0.85 }));
    cornerLine.visible = false;
    scene.add(cornerLine);

    return { scene, camera, renderer, controls, ball, ballGlow, ballShadow, trailPool, dangerGlow, cornerLine, cornerFlagRefs, running: false, rafId: null };
  }

  // =============================================================================
  //  CICLO DE VIDA (mesma disciplina da primeira versão 3D): singleton, canvas
  //  partilhado e reancorado, loop de animação que pára quando não está visível.
  // =============================================================================
  let tp3 = null;
  function ensureTracker3DScene() {
    if (tp3) return tp3;
    const THREE = window.THREE;
    if (!THREE) return null;
    tp3 = buildStadium(THREE);
    return tp3;
  }

  function tp3AnimateStep() {
    if (!tp3 || !tp3.running) return;
    tp3.controls.update();
    tp3.renderer.render(tp3.scene, tp3.camera);
    tp3.rafId = requestAnimationFrame(tp3AnimateStep);
  }

  // Liga (ou reancora) o <canvas> partilhado ao contentor indicado. interactive=true (só o modal
  // cheio) liga o OrbitControls a sério (arrastar/zoom); no cabeçalho compacto a câmara fica fixa.
  function mountTracker3D(container, interactive) {
    const state = ensureTracker3DScene();
    if (!state || !container) return null;
    const canvas = state.renderer.domElement;
    if (canvas.parentElement !== container) container.appendChild(canvas);
    state.controls.enabled = !!interactive;
    resizeTracker3D(container);
    if (!state.running) {
      state.running = true;
      tp3AnimateStep();
    }
    return state;
  }
  function resizeTracker3D(container) {
    if (!tp3 || !container) return;
    const w = container.clientWidth || 1, h = container.clientHeight || 1;
    tp3.renderer.setSize(w, h, false);
    tp3.camera.aspect = w / h;
    tp3.camera.updateProjectionMatrix();
  }
  window.addEventListener("resize", () => {
    if (tp3 && tp3.renderer.domElement.parentElement) resizeTracker3D(tp3.renderer.domElement.parentElement);
  });

  // Pára o loop de animação (poupa CPU/bateria) sem destruir a cena — chamado ao sair da página
  // de mercado, para o motor não continuar a renderizar um campo que já não está visível.
  function pauseTracker3D() {
    if (!tp3) return;
    tp3.running = false;
    if (tp3.rafId) cancelAnimationFrame(tp3.rafId);
    tp3.rafId = null;
  }

  // Equivalente a ensureTracker2DCanvas() do motor 2D — usado por showGoalFlashOverlay (app.js)
  // para encontrar o contentor onde anexar o flash de golo por cima do <canvas> 3D.
  function ensureTracker3DCanvas() {
    const state = ensureTracker3DScene();
    if (!state) return null;
    return { canvas: state.renderer.domElement, mountedIn: state.renderer.domElement.parentElement };
  }

  // Ponto de entrada assíncrono usado por renderPitchInto (app.js): garante a biblioteca
  // carregada e a cena construída antes de o chamador montar/atualizar.
  function ensureTracker3DReady() {
    return loadThreeLib().then(() => ensureTracker3DScene());
  }

  // =========================================================================
  //  ATUALIZAÇÃO COM DADOS REAIS — chamada em cada refresh de posição da bola
  //  (Sportmonks ballCoordinates via app.js). Nunca recria a cena, só move
  //  objetos já existentes.
  // =========================================================================
  function updateTracker3DFromPoints(e, points, compact) {
    const state = ensureTracker3DScene();
    if (!state || !points || !points.length) return;
    const latest = points[0];
    const bx = worldX(latest.x), bz = worldZ(latest.y);
    state.ball.position.set(bx, 1.1, bz);
    state.ballGlow.position.copy(state.ball.position);
    state.ballShadow.position.set(bx, 0.1, bz);

    for (let i = 0; i < state.trailPool.length; i++) {
      const tDot = state.trailPool[i];
      const p = points[i + 1];
      if (!p) {
        tDot.visible = false;
        continue;
      }
      tDot.visible = true;
      tDot.position.set(worldX(p.x), 0.5, worldZ(p.y));
      tDot.material.opacity = Math.max(0.05, 0.5 - i * 0.05);
      tDot.scale.setScalar(Math.max(0.35, 1 - i * 0.07));
    }

    const zone = call("ballDangerZone", latest.x);
    state.dangerGlow.visible = true;
    state.dangerGlow.position.set(bx, 0.04, bz);
    state.dangerGlow.material.color.setHex(zone === "danger" ? 0xe63027 : zone === "mid" ? 0xf5b428 : 0xf5c842);
    state.dangerGlow.material.opacity = zone === "danger" ? 0.5 : zone === "mid" ? 0.36 : 0.24;

    const inCorner = call("isInCornerZone", latest.x, latest.y);
    if (inCorner) {
      const nc = call("nearestCorner", latest.x, latest.y);
      const flag = state.cornerFlagRefs[`${nc.cx},${nc.cy}`];
      if (flag) {
        const positions = state.cornerLine.geometry.attributes.position;
        positions.setXYZ(0, bx, 0.05, bz);
        positions.setXYZ(1, flag.x, 0.05, flag.z);
        positions.needsUpdate = true;
        state.cornerLine.computeLineDistances();
        state.cornerLine.visible = true;
      }
    } else {
      state.cornerLine.visible = false;
    }

    if (!compact) {
      const goalEvent = call("detectNewGoal", e);
      if (goalEvent) call("showGoalFlashOverlay", goalEvent);
    }
  }

  window.pauseTracker3D = pauseTracker3D;
  window.ensureTracker3DCanvas = ensureTracker3DCanvas;
  window.ensureTracker3DReady = ensureTracker3DReady;
  window.mountTracker3D = mountTracker3D;
  window.updateTracker3DFromPoints = updateTracker3DFromPoints;
})();
