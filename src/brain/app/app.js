// me.md — the quantum neural net. A WebGL view of your world: every node is a
// .md file, every thread is semantic kinship or an explicit link. Drag to
// navigate, scroll to zoom, MORPH to reshape the brain (sphere <-> the true
// semantic structure) with a bloom that surges as it changes.

const $ = (id) => document.getElementById(id);
const curtain = $("curtain");
const curtainSub = $("curtainSub");

function fail(msg) {
  curtain.style.display = "flex";
  curtain.querySelector(".big").textContent = "the net stayed dark";
  curtainSub.innerHTML = msg;
}

// ---- palettes (warm gold is the default; violet is the alt crystal) --------
const PALETTES = {
  warm: [
    [0.18, [0.18, 0.62, 0.32]], // deep green (low)
    [0.5, [0.95, 0.78, 0.26]], // yellow
    [0.8, [1.0, 0.62, 0.18]], // amber
    [1.0, [1.0, 0.84, 0.42]], // gold (high)
  ],
  violet: [
    [0.18, [0.28, 0.2, 0.7]], // indigo
    [0.5, [0.55, 0.3, 0.95]], // violet
    [0.8, [0.85, 0.32, 0.92]], // magenta
    [1.0, [0.95, 0.6, 1.0]], // lilac (high)
  ],
};

function sampleGradient(stops, t) {
  t = Math.max(0, Math.min(1, t));
  let lo = stops[0];
  let hi = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i][0] && t <= stops[i + 1][0]) {
      lo = stops[i];
      hi = stops[i + 1];
      break;
    }
  }
  const span = hi[0] - lo[0] || 1;
  const k = (t - lo[0]) / span;
  return [
    lo[1][0] + (hi[1][0] - lo[1][0]) * k,
    lo[1][1] + (hi[1][1] - lo[1][1]) * k,
    lo[1][2] + (hi[1][2] - lo[1][2]) * k,
  ];
}

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

async function main() {
  let THREE, OrbitControls, EffectComposer, RenderPass, UnrealBloomPass;
  try {
    THREE = await import("three");
    ({ OrbitControls } = await import("three/addons/controls/OrbitControls.js"));
    ({ EffectComposer } = await import("three/addons/postprocessing/EffectComposer.js"));
    ({ RenderPass } = await import("three/addons/postprocessing/RenderPass.js"));
    ({ UnrealBloomPass } = await import("three/addons/postprocessing/UnrealBloomPass.js"));
  } catch (e) {
    fail(
      "couldn't load the 3D engine (three.js) from the CDN.<br/>this view needs a network connection the first time.<br/><br/><code>" +
        String(e) +
        "</code>",
    );
    return;
  }

  let data;
  try {
    const res = await fetch("./graph.json", { cache: "no-store" });
    data = await res.json();
  } catch (e) {
    fail("couldn't read your graph. is the server still running?<br/><code>" + String(e) + "</code>");
    return;
  }

  const graph = data.graph;
  const version = data.version || {};
  const nodes = graph.nodes || [];
  const edges = (graph.edges || []).slice().sort((a, b) => b.weight - a.weight);
  const n = nodes.length;

  // ---- header --------------------------------------------------------------
  const self = version.selfState ? " · " + version.selfState.replace("self/", "self ") : " · genesis";
  $("version").innerHTML =
    "v<span>" + (version.pkg || "0.0.0") + "</span> · " + (version.tier || "me") + self;
  $("counts").innerHTML =
    "<span>" + n + "</span> nodes · <span>" + edges.length + "</span> threads · #" + (graph.meta?.digest || "");
  if (n === 0) {
    fail(
      "your world is empty.<br/>point <code>~/.me.md/corpus.config.json</code> at your notes, then run <code>me index</code>.",
    );
    return;
  }
  if (!graph.meta?.embedded) {
    curtainSub.textContent = "no embeddings yet — showing structure from links. run `me index` for the semantic map.";
  }

  const R = 100;
  const REST_CAM = 260;

  // ---- scene ---------------------------------------------------------------
  const canvas = $("stage");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x050505, 1);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x050505, 0.0016);
  const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 4000);
  camera.position.set(0, 30, REST_CAM);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.6;
  controls.zoomSpeed = 0.9;
  controls.minDistance = 30;
  controls.maxDistance = 1200;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.5;

  // ---- layouts (sphere, semantic) ------------------------------------------
  const layouts = {
    sphere: new Float32Array(n * 3),
    galaxy: new Float32Array(n * 3),
    semantic: new Float32Array(n * 3),
  };
  const fill = (arr, key) =>
    nodes.forEach((nd, i) => {
      const v = nd[key] || [0, 0, 0];
      arr[i * 3] = v[0];
      arr[i * 3 + 1] = v[1];
      arr[i * 3 + 2] = v[2];
    });
  fill(layouts.sphere, "sphere");
  fill(layouts.galaxy, "galaxy");
  fill(layouts.semantic, "semantic");

  // MORPH always reshapes (sphere <-> galaxy); the semantic map joins the cycle
  // once embeddings exist (after `me index`).
  const ORDER = graph.meta?.embedded ? ["sphere", "semantic", "galaxy"] : ["sphere", "galaxy"];
  let fromKey = "sphere";
  let toKey = "sphere";

  // ---- per-node color + size -----------------------------------------------
  let palette = "warm";
  const colors = new Float32Array(n * 3);
  const sizes = new Float32Array(n);
  let maxDeg = 1;
  for (const nd of nodes) maxDeg = Math.max(maxDeg, nd.degree || 0);

  function recolor() {
    const stops = PALETTES[palette];
    for (let i = 0; i < n; i++) {
      const nd = nodes[i];
      const h = (layouts.sphere[i * 3 + 1] / R + 1) / 2; // 0 bottom .. 1 top
      const c = sampleGradient(stops, h);
      const boost = 0.6 + 0.55 * Math.min(1, (nd.degree || 0) / 8);
      colors[i * 3] = Math.min(1.4, c[0] * boost);
      colors[i * 3 + 1] = Math.min(1.4, c[1] * boost);
      colors[i * 3 + 2] = Math.min(1.4, c[2] * boost);
    }
    if (points) points.geometry.attributes.color.needsUpdate = true;
    rebuildEdgeColors();
  }
  for (let i = 0; i < n; i++) {
    const nd = nodes[i];
    const w = Math.sqrt(Math.max(1, nd.weight || 1)) / 42;
    sizes[i] = Math.max(5, Math.min(34, 5 + w + (nd.degree || 0) * 0.9));
  }

  // ---- glow sprite ---------------------------------------------------------
  function sprite() {
    const s = 64;
    const cv = document.createElement("canvas");
    cv.width = cv.height = s;
    const g = cv.getContext("2d");
    const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0, "rgba(255,255,255,1)");
    grd.addColorStop(0.25, "rgba(255,255,255,0.85)");
    grd.addColorStop(0.55, "rgba(255,255,255,0.25)");
    grd.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
    const tex = new THREE.CanvasTexture(cv);
    tex.needsUpdate = true;
    return tex;
  }

  // ---- points (nodes) ------------------------------------------------------
  const pos = new Float32Array(layouts.sphere); // current, interpolated
  const pgeo = new THREE.BufferGeometry();
  pgeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  pgeo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  pgeo.setAttribute("size", new THREE.BufferAttribute(sizes, 1));

  const pmat = new THREE.ShaderMaterial({
    uniforms: { map: { value: sprite() } },
    vertexShader: `
      attribute float size;
      attribute vec3 color;
      varying vec3 vColor;
      void main() {
        vColor = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * (320.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform sampler2D map;
      varying vec3 vColor;
      void main() {
        float a = texture2D(map, gl_PointCoord).a;
        if (a < 0.02) discard;
        gl_FragColor = vec4(vColor * a, a);
      }`,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
  });
  let points = new THREE.Points(pgeo, pmat);
  scene.add(points);
  // node colors are set by recolor() below, once the edge buffers exist
  // (recolor() also derives edge colors, so it must run after `pairs`/`egeo`).

  // ---- edges ---------------------------------------------------------------
  const pairs = new Int32Array(edges.length * 2);
  edges.forEach((e, i) => {
    pairs[i * 2] = e.a;
    pairs[i * 2 + 1] = e.b;
  });
  const epos = new Float32Array(edges.length * 6);
  const ecol = new Float32Array(edges.length * 6);
  const egeo = new THREE.BufferGeometry();
  egeo.setAttribute("position", new THREE.BufferAttribute(epos, 3));
  egeo.setAttribute("color", new THREE.BufferAttribute(ecol, 3));
  const emat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.34,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const lines = new THREE.LineSegments(egeo, emat);
  scene.add(lines);

  function rebuildEdgeColors() {
    for (let i = 0; i < edges.length; i++) {
      const a = pairs[i * 2];
      const b = pairs[i * 2 + 1];
      const f = edges[i].kind === "link" ? 0.85 : 0.4;
      for (let k = 0; k < 3; k++) {
        ecol[i * 6 + k] = colors[a * 3 + k] * f;
        ecol[i * 6 + 3 + k] = colors[b * 3 + k] * f;
      }
    }
    egeo.attributes.color.needsUpdate = true;
  }
  function rebuildEdgePositions() {
    for (let i = 0; i < edges.length; i++) {
      const a = pairs[i * 2];
      const b = pairs[i * 2 + 1];
      for (let k = 0; k < 3; k++) {
        epos[i * 6 + k] = pos[a * 3 + k];
        epos[i * 6 + 3 + k] = pos[b * 3 + k];
      }
    }
    egeo.attributes.position.needsUpdate = true;
  }
  // first paint: colorize nodes, then derive edge colors from them.
  recolor();

  // density slider: edges are sorted strong->weak, so trimming drops kinship first
  function applyDensity(pct) {
    const count = Math.round((edges.length * pct) / 100);
    egeo.setDrawRange(0, count * 2);
  }
  applyDensity(100);

  // ---- morph state ---------------------------------------------------------
  function writePositions(t) {
    const A = layouts[fromKey];
    const B = layouts[toKey];
    const e = easeInOut(t);
    for (let i = 0; i < n * 3; i++) pos[i] = A[i] + (B[i] - A[i]) * e;
    pgeo.attributes.position.needsUpdate = true;
    rebuildEdgePositions();
  }
  writePositions(1);

  let tweening = false;
  let tweenStart = 0;
  let bloomBoost = 0;
  const TWEEN_MS = 1700;
  let orderIdx = 0;

  function morph() {
    if (tweening || ORDER.length < 2) {
      // single layout: still pulse the bloom for feedback
      if (ORDER.length < 2) pulse();
      return;
    }
    orderIdx = (orderIdx + 1) % ORDER.length;
    fromKey = toKey;
    toKey = ORDER[orderIdx];
    tweening = true;
    tweenStart = performance.now();
  }
  let pulseStart = -1;
  function pulse() {
    pulseStart = performance.now();
  }

  // ---- bloom ---------------------------------------------------------------
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 1.2, 0.62, 0.0);
  let glowBase = 1.2;
  bloom.strength = glowBase;
  composer.addPass(bloom);

  // ---- interaction: hover tooltip ------------------------------------------
  const ray = new THREE.Raycaster();
  const mouse = new THREE.Vector2(-2, -2);
  const tip = $("tip");
  let hoverIdx = -1;
  addEventListener("pointermove", (ev) => {
    mouse.x = (ev.clientX / innerWidth) * 2 - 1;
    mouse.y = -(ev.clientY / innerHeight) * 2 + 1;
    tip.style.left = ev.clientX + "px";
    tip.style.top = ev.clientY + "px";
  });
  function pickHover() {
    ray.setFromCamera(mouse, camera);
    ray.params.Points.threshold = (controls.getDistance() / REST_CAM) * 6 + 2;
    const hit = ray.intersectObject(points);
    const idx = hit.length ? hit[0].index : -1;
    if (idx === hoverIdx) return;
    hoverIdx = idx;
    if (idx < 0) {
      tip.style.opacity = "0";
      return;
    }
    const nd = nodes[idx];
    tip.querySelector(".t").textContent = nd.label;
    tip.querySelector(".g").textContent = nd.group + " · " + (nd.degree || 0) + " links";
    tip.querySelector(".p").textContent = nd.path;
    tip.style.opacity = "1";
  }

  // ---- controls wiring -----------------------------------------------------
  $("morph").onclick = morph;
  const freezeBtn = $("freeze");
  freezeBtn.onclick = () => {
    controls.autoRotate = !controls.autoRotate;
    freezeBtn.classList.toggle("on", !controls.autoRotate);
    freezeBtn.textContent = controls.autoRotate ? "FREEZE" : "FROZEN";
  };
  $("reset").onclick = () => {
    controls.autoRotate = true;
    freezeBtn.classList.remove("on");
    freezeBtn.textContent = "FREEZE";
    fromKey = toKey = "sphere";
    orderIdx = 0;
    tweening = false;
    writePositions(1);
    controls.target.set(0, 0, 0);
    camera.position.set(0, 30, REST_CAM);
  };
  const density = $("density");
  density.oninput = () => {
    $("densityVal").textContent = density.value + "%";
    applyDensity(+density.value);
  };
  const glow = $("glow");
  glow.oninput = () => {
    $("glowVal").textContent = glow.value + "%";
    glowBase = (+glow.value / 100) * 1.0;
  };
  $("themeDot").onclick = () => {
    palette = palette === "warm" ? "violet" : "warm";
    $("themeDot").style.background =
      palette === "warm"
        ? "radial-gradient(circle at 35% 30%, #ffe6a3, #ff9d3c 55%, #6f3d12)"
        : "radial-gradient(circle at 35% 30%, #e9c5ff, #9d3cff 55%, #2c1257)";
    recolor();
  };
  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    composer.setSize(innerWidth, innerHeight);
  });
  // double-click a node to fly to it
  addEventListener("dblclick", () => {
    if (hoverIdx < 0) return;
    const i = hoverIdx;
    controls.target.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
  });

  // ---- boot ----------------------------------------------------------------
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  curtain.style.transition = "opacity 0.6s";
  curtain.style.opacity = "0";
  setTimeout(() => (curtain.style.display = "none"), 650);

  function loop(now) {
    requestAnimationFrame(loop);
    controls.update();

    if (tweening) {
      const p = Math.min(1, (now - tweenStart) / TWEEN_MS);
      writePositions(p);
      bloomBoost = Math.sin(Math.PI * p);
      if (p >= 1) {
        tweening = false;
        fromKey = toKey;
      }
    } else if (pulseStart >= 0) {
      const p = Math.min(1, (now - pulseStart) / 700);
      bloomBoost = Math.sin(Math.PI * p);
      if (p >= 1) pulseStart = -1;
    } else {
      bloomBoost *= 0.92;
    }

    bloom.strength = glowBase * (1 + 1.6 * bloomBoost);
    pickHover();
    composer.render();
  }
  requestAnimationFrame(loop);
}

main().catch((e) => {
  fail(
    "the net hit a snag while starting up.<br/><br/><code>" +
      String((e && e.stack) || e) +
      "</code>",
  );
});
