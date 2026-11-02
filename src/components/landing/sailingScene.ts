import * as THREE from "three";


import { createSailingWake } from "./sailingWake";
import { coastRadius, islandsInSector, randomSource, sail, SECTOR_SIZE, type Island, type Vessel } from "./sailingWorld";
import { onReducedMotionChange, reducedMotion } from "@/lib/reducedMotion";

const SKY = 0x100b15;
const ROSE = 0xfb4d96;

function material(color: THREE.ColorRepresentation) {
  return new THREE.MeshStandardMaterial({ color, roughness: 1, flatShading: true });
}

function mesh(geometry: THREE.BufferGeometry, surface: THREE.Material, parent: THREE.Object3D,
  x = 0, y = 0, z = 0) {
  const object = new THREE.Mesh(geometry, surface);
  object.position.set(x, y, z);
  parent.add(object);
  return object;
}

function buildShip() {
  const ship = new THREE.Group();
  const wood = material(0x392336);
  const rail = material(0xad6774);
  const brass = material(0xe9bd94);
  const rose = material(ROSE);
  const cream = material(0xffd9c2);
  rose.side = cream.side = THREE.DoubleSide;

  const outline = [[0, -6.5], [-1.9, -3.3], [-2.1, 2.8], [-1.3, 4.6], [1.3, 4.6], [2.1, 2.8], [1.9, -3.3]];
  const positions: number[] = [];
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i], b = outline[(i + 1) % outline.length];
    positions.push(a[0], 1.8, a[1], b[0], 1.8, b[1], b[0] * 0.48, -0.3, b[1] * 0.85,
      a[0], 1.8, a[1], b[0] * 0.48, -0.3, b[1] * 0.85, a[0] * 0.48, -0.3, a[1] * 0.85,
      0, 1.8, 0, b[0], 1.8, b[1], a[0], 1.8, a[1]);
    const from = new THREE.Vector3(a[0], 1.95, a[1]);
    const to = new THREE.Vector3(b[0], 1.95, b[1]);
    const beam = mesh(new THREE.CylinderGeometry(0.12, 0.12, from.distanceTo(to), 5), rail, ship);
    beam.position.copy(from).add(to).multiplyScalar(0.5);
    beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.sub(from).normalize());
  }
  const hull = new THREE.BufferGeometry();
  hull.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  hull.computeVertexNormals();
  wood.side = THREE.DoubleSide;
  mesh(hull, wood, ship);
  mesh(new THREE.BoxGeometry(2.6, 0.45, 2.6), rail, ship, 0, 1.85, 2.5);
  mesh(new THREE.CylinderGeometry(0.1, 0.18, 10.8, 7), brass, ship, 0, 6.5, 0);
  const boom = mesh(new THREE.CylinderGeometry(0.08, 0.08, 7.8, 5), brass, ship, 0, 3.3, 0);
  boom.rotation.z = Math.PI / 2;

  const sailGeometry = new THREE.PlaneGeometry(1, 1, 12, 12);
  const p = sailGeometry.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const u = p.getX(i) + 0.5, v = p.getY(i) + 0.5;
    p.setXYZ(i, (u - 0.5) * 8 * (1 - v), 3.4 + v * 8,
      0.2 + Math.sin(u * Math.PI) * Math.sin(v * Math.PI) * 1.3);
  }
  sailGeometry.computeVertexNormals();
  const mainsail = mesh(sailGeometry, rose, ship);
  const jibGeometry = new THREE.BufferGeometry();
  jibGeometry.setAttribute("position", new THREE.Float32BufferAttribute([
    0, 9.5, -0.4, 0, 2.4, -5.6, -2.6, 3.2, -1.7,
  ], 3));
  jibGeometry.computeVertexNormals();
  mesh(jibGeometry, cream, ship);

  const flagGeometry = new THREE.PlaneGeometry(1.9, 0.7, 10, 2);
  flagGeometry.translate(0.95, 0, 0);
  (flagGeometry.attributes.position as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
  const flag = mesh(flagGeometry, rose, ship, 0, 11.7, 0);
  return { ship, mainsail, flag };
}

function buildIsland(island: Island) {
  const group = new THREE.Group();
  group.position.set(island.x, 0, island.z);
  const random = randomSource(island.seed * 10000);
  const segments = 48;
  const radii = [1.025, 0.97, 0.84, 0.62, 0.32, 0];
  const heights = [-1.2, 1.2, 4, island.height * 0.38, island.height, island.height * 0.8];
  const palette = [0x9d899a, 0x637e76, 0x315d60, 0x354958, 0x535062];
  const points: number[] = [], colors: number[] = [];
  const point = (ring: number, segment: number) => {
    const angle = segment / segments * Math.PI * 2;
    const radius = coastRadius(island, angle) * radii[ring];
    return [Math.cos(angle) * radius, heights[ring] * (1 + 0.15 * Math.sin(angle * 4 + island.seed)),
      Math.sin(angle) * radius * island.stretch];
  };
  for (let ring = 0; ring < radii.length - 1; ring++) {
    for (let s = 0; s < segments; s++) {
      const a = point(ring, s), b = point(ring, s + 1), c = point(ring + 1, s), d = point(ring + 1, s + 1);
      for (const triangle of [[a, c, b], [b, c, d]]) {
        const color = new THREE.Color(palette[ring]).multiplyScalar(0.82 + random() * 0.32);
        for (const vertex of triangle) {
          points.push(...vertex);
          colors.push(color.r, color.g, color.b);
        }
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  mesh(geometry, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true }), group);

  const shore: number[] = [];
  for (let s = 0; s < segments; s++) {
    const vertices = [s, s + 1].flatMap((i) => {
      const angle = i / segments * Math.PI * 2;
      return [1.04, 1.1].map((scale) => [Math.cos(angle) * coastRadius(island, angle) * scale,
        0.05, Math.sin(angle) * coastRadius(island, angle) * scale * island.stretch]);
    });
    for (const i of [0, 1, 2, 2, 1, 3]) shore.push(...vertices[i]);
  }
  const shoreGeometry = new THREE.BufferGeometry();
  shoreGeometry.setAttribute("position", new THREE.Float32BufferAttribute(shore, 3));
  mesh(shoreGeometry, new THREE.MeshBasicMaterial({ color: 0x53b8b6, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }), group);

  const count = island.radius > 200 ? 50 : 14;
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.6, 0.9, 7, 5), material(0x6d5261), count);
  const crowns = new THREE.InstancedMesh(new THREE.ConeGeometry(4, 15, 5), material(0x284c50), count);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < count; i++) {
    const angle = random() * Math.PI * 2;
    const r = 0.72 + random() * 0.1;
    const radius = coastRadius(island, angle) * r;
    const y = THREE.MathUtils.lerp(heights[3], heights[2], (r - 0.62) / 0.22)
      * (1 + 0.15 * Math.sin(angle * 4 + island.seed));
    dummy.position.set(Math.cos(angle) * radius, y + 2, Math.sin(angle) * radius * island.stretch);
    dummy.scale.setScalar(0.7 + random() * 0.7);
    dummy.updateMatrix();
    trunks.setMatrixAt(i, dummy.matrix);
    dummy.position.y += 7 * dummy.scale.y;
    dummy.updateMatrix();
    crowns.setMatrixAt(i, dummy.matrix);
  }
  group.add(trunks, crowns);
  return group;
}

function disposeObjects(object: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  object.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.Points) {
      geometries.add(child.geometry);
      for (const surface of Array.isArray(child.material) ? child.material : [child.material]) materials.add(surface);
      if (child instanceof THREE.InstancedMesh) child.dispose();
    }
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((surface) => surface.dispose());
}

/** Mounts the scene into `host` and returns its teardown, or null when WebGL can't start. */
export function mountSailingScene(host: HTMLDivElement, label: string): (() => void) | null {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: "low-power" });
  } catch {
    return null;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setClearColor(SKY, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const canvas = renderer.domElement;
  canvas.tabIndex = 0;
  canvas.setAttribute("role", "application");
  canvas.setAttribute("aria-label", label);
  canvas.style.cssText = "display:block;width:100%;height:100%;touch-action:pan-y;outline:none;mask-image:linear-gradient(to bottom,transparent,transparent 6%,black 30%,black 94%,transparent);";
  host.appendChild(canvas);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(SKY, 0.00145);
  scene.add(new THREE.HemisphereLight(0xb8c1df, 0x242536, 2.5));
  const sun = new THREE.DirectionalLight(0xffc2b6, 3);
  sun.position.set(-300, 450, -600);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xd2b1d9, 1.8);
  fill.position.set(100, 140, 250);
  scene.add(fill);
  const camera = new THREE.PerspectiveCamera(48, 1, 0.5, 4000);
  const { ship, mainsail, flag } = buildShip();
  scene.add(ship);

  const water = new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 }, fogColor: { value: new THREE.Color(SKY) } },
    vertexShader: `
      uniform float time;
      varying vec3 world;
      void main() {
        vec4 p = modelMatrix * vec4(position, 1.0);
        p.y += sin(p.x * 0.014 + time * 0.65) * cos(p.z * 0.012 + time * 0.4) * 0.4;
        world = p.xyz;
        gl_Position = projectionMatrix * viewMatrix * p;
      }`,
    fragmentShader: `
      uniform float time;
      uniform vec3 fogColor;
      varying vec3 world;
      void main() {
        float swell = sin(world.x * 0.065 + time * 0.65) * cos(world.z * 0.048 + time * 0.4);
        float wave = sin(world.x * 0.11 + sin(world.z * 0.09 + time * 0.6) * 2.5 + time);
        float broken = sin(world.z * 0.3 - time * 0.4) * sin(world.x * 0.045 + world.z * 0.08);
        float crest = smoothstep(0.94, 0.99, wave) * smoothstep(0.35, 0.65, broken);
        vec3 color = mix(vec3(0.007, 0.027, 0.04), vec3(0.011, 0.08, 0.10), step(0.12, swell) * 0.6 + 0.2);
        color += crest * vec3(0.08, 0.32, 0.33);
        float distanceToCamera = length(world.xz - cameraPosition.xz);
        float fog = 1.0 - exp(-pow(distanceToCamera * 0.00145, 2.0));
        gl_FragColor = vec4(mix(color, fogColor, fog), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const oceanGeometry = new THREE.PlaneGeometry(7000, 7000, 140, 140);
  oceanGeometry.rotateX(-Math.PI / 2);
  const ocean = mesh(oceanGeometry, water, scene);

  const moon = mesh(new THREE.CircleGeometry(66, 32), new THREE.MeshBasicMaterial({ color: 0xc66d91, fog: false }), scene);
  const halo = mesh(new THREE.RingGeometry(74, 74.8, 64), new THREE.MeshBasicMaterial({ color: 0x573044, fog: false, side: THREE.DoubleSide }), scene);
  const random = randomSource(481);
  const starPositions: number[] = [];
  for (let i = 0; i < 180; i++) {
    const angle = random() * Math.PI * 2, height = 0.1 + random() * 1.1;
    starPositions.push(Math.cos(angle) * 1900, height * 1500, Math.sin(angle) * 1900);
  }
  const starGeometry = new THREE.BufferGeometry();
  starGeometry.setAttribute("position", new THREE.Float32BufferAttribute(starPositions, 3));
  const stars = new THREE.Points(starGeometry, new THREE.PointsMaterial({ color: 0x977b99, size: 1.7, sizeAttenuation: false, fog: false }));
  scene.add(stars);

  const wake = createSailingWake();
  scene.add(wake.surface);

  const sectors = new Map<string, { group: THREE.Group; islands: Island[] }>();
  let islands: Island[] = [], sectorKey = "";
  const vessel: Vessel = { x: 0, z: 0, heading: -0.18, speed: 0 };
  const updateLand = () => {
    const sx = Math.round(vessel.x / SECTOR_SIZE), sz = Math.round(vessel.z / SECTOR_SIZE);
    const key = `${sx}:${sz}`;
    if (key === sectorKey) return;
    sectorKey = key;
    const needed = new Set<string>();
    for (let x = sx - 1; x <= sx + 1; x++) for (let z = sz - 1; z <= sz + 1; z++) {
      const id = `${x}:${z}`;
      needed.add(id);
      if (sectors.has(id)) continue;
      const land = islandsInSector(x, z);
      const group = new THREE.Group();
      land.forEach((island) => group.add(buildIsland(island)));
      sectors.set(id, { group, islands: land });
      scene.add(group);
    }
    for (const [id, sector] of sectors) if (!needed.has(id)) {
      scene.remove(sector.group);
      disposeObjects(sector.group);
      sectors.delete(id);
    }
    islands = [...sectors.values()].flatMap((sector) => sector.islands);
  };
  updateLand();

  const keys = new Set<string>();
  const controlKeys = new Set(["arrowup", "arrowdown", "arrowleft", "arrowright", "w", "a", "s", "d"]);
  let engaged = false, visible = false, lost = false;
  let pointer: { id: number; x: number; y: number; rudder: number; throttle: number } | undefined;
  // Only horizontal drags steer; vertical gestures stay native scrolling.
  const pointerDown = (event: PointerEvent) => {
    if (!event.isPrimary || event.button !== 0) return;
    canvas.focus({ preventScroll: true });
    engaged = true;
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, rudder: 0, throttle: 0.65 };
    canvas.setPointerCapture(event.pointerId);
    syncAnimation();
  };
  const pointerMove = (event: PointerEvent) => {
    if (pointer?.id !== event.pointerId) return;
    pointer.rudder = THREE.MathUtils.clamp((event.clientX - pointer.x) / 90, -1, 1);
    pointer.throttle = THREE.MathUtils.clamp(0.65 + (pointer.y - event.clientY) / 140, -0.6, 1);
  };
  const pointerUp = (event: PointerEvent) => {
    if (pointer?.id !== event.pointerId) return;
    pointer = undefined;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  };
  const keyDown = (event: KeyboardEvent) => {
    const key = event.key.toLowerCase();
    if (!controlKeys.has(key) || event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    engaged = true;
    keys.add(key);
    syncAnimation();
  };
  const keyUp = (event: KeyboardEvent) => { keys.delete(event.key.toLowerCase()); };
  const resetInput = () => { keys.clear(); pointer = undefined; };
  canvas.addEventListener("pointerdown", pointerDown);
  canvas.addEventListener("pointermove", pointerMove);
  canvas.addEventListener("pointerup", pointerUp);
  canvas.addEventListener("pointercancel", pointerUp);
  canvas.addEventListener("lostpointercapture", pointerUp);
  canvas.addEventListener("keydown", keyDown);
  canvas.addEventListener("keyup", keyUp);
  canvas.addEventListener("blur", resetInput);
  window.addEventListener("blur", resetInput);

  const cameraTarget = new THREE.Vector3();
  const cameraPosition = new THREE.Vector3();
  const lookPosition = new THREE.Vector3();
  let time = 0, lastTime = 0, frame = 0, flagPhase = 0;
  const render = (dt: number) => {
    time += dt;
    const throttle = (keys.has("w") || keys.has("arrowup") ? 1 : 0)
      - (keys.has("s") || keys.has("arrowdown") ? 0.65 : 0);
    const rudder = (keys.has("d") || keys.has("arrowright") ? 1 : 0)
      - (keys.has("a") || keys.has("arrowleft") ? 1 : 0);
    sail(vessel, pointer?.throttle ?? throttle, pointer?.rudder ?? rudder, dt, islands);
    updateLand();
    const h = vessel.heading;
    ship.position.set(vessel.x, Math.sin(time * 1.3) * 0.22, vessel.z);
    ship.rotation.set(Math.sin(time * 0.9) * 0.025, h, Math.sin(time * 1.2) * 0.035 + rudder * vessel.speed * 0.002, "YXZ");
    mainsail.scale.z = 1 + Math.sin(time * 2) * 0.06;
    // Integrate phase so speed changes stay continuous.
    const wind = Math.min(1, Math.abs(vessel.speed) / 12);
    flagPhase += dt * (5 + wind * 25);
    const flagPositions = flag.geometry.attributes.position;
    const flagUvs = flag.geometry.attributes.uv;
    for (let i = 0; i < flagPositions.count; i++) {
      const u = flagUvs.getX(i), v = flagUvs.getY(i);
      const ripple = flagPhase - u * 8;
      flagPositions.setY(i, (v - 0.5) * 0.7 + u * (0.015 + wind * 0.16) * Math.sin(ripple));
      flagPositions.setZ(i, u * (0.04 + wind * 0.5)
        * (Math.sin(ripple) + 0.25 * Math.sin(ripple * 1.7 + v * 2)));
    }
    flagPositions.needsUpdate = true;
    flag.geometry.computeVertexNormals();
    flag.rotation.y = Math.sin(flagPhase * 0.6) * (0.06 + wind * 0.72);
    flag.rotation.z = Math.sin(flagPhase * 0.5 + 0.6) * (0.02 + wind * 0.2);
    const distance = camera.aspect < 1 ? 42 : 34;
    cameraPosition.set(vessel.x + Math.sin(h + 0.22) * distance, 19, vessel.z + Math.cos(h + 0.22) * distance);
    const follow = dt === 0 ? 1 : 1 - Math.exp(-dt * 2);
    camera.position.lerp(cameraPosition, follow);
    lookPosition.set(vessel.x - Math.sin(h + 0.22) * 25, 4, vessel.z - Math.cos(h + 0.22) * 25);
    cameraTarget.lerp(lookPosition, follow);
    camera.lookAt(cameraTarget);
    ocean.position.set(Math.round(vessel.x / 50) * 50, 0, Math.round(vessel.z / 50) * 50);
    water.uniforms.time.value = time;
    stars.position.set(vessel.x, 0, vessel.z);
    moon.position.set(vessel.x - 300, 220, vessel.z - 2100);
    halo.position.copy(moon.position);
    moon.lookAt(camera.position);
    halo.lookAt(camera.position);
    wake.update(vessel, time);
    renderer.render(scene, camera);
  };
  const tick = (now: number) => {
    frame = 0;
    render(lastTime ? Math.min((now - lastTime) / 1000, 0.05) : 0);
    lastTime = now;
    frame = requestAnimationFrame(tick);
  };
  function syncAnimation() {
    const running = visible && !document.hidden && !lost && (!reducedMotion() || engaged);
    if (running && !frame) { lastTime = 0; frame = requestAnimationFrame(tick); }
    else if (!running) { cancelAnimationFrame(frame); frame = 0; lastTime = 0; resetInput(); }
  }
  const visibility = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    syncAnimation();
  });
  visibility.observe(host);
  document.addEventListener("visibilitychange", syncAnimation);
  const offReducedMotion = onReducedMotionChange(syncAnimation);
  const resize = new ResizeObserver(() => {
    const width = host.clientWidth, height = host.clientHeight;
    if (!width || !height || lost) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    render(0);
  });
  resize.observe(host);
  const contextLost = (event: Event) => { event.preventDefault(); lost = true; syncAnimation(); };
  const contextRestored = () => { lost = false; render(0); syncAnimation(); };
  canvas.addEventListener("webglcontextlost", contextLost);
  canvas.addEventListener("webglcontextrestored", contextRestored);

  return () => {
    cancelAnimationFrame(frame);
    visibility.disconnect();
    resize.disconnect();
    document.removeEventListener("visibilitychange", syncAnimation);
    offReducedMotion();
    window.removeEventListener("blur", resetInput);
    canvas.removeEventListener("pointerdown", pointerDown);
    canvas.removeEventListener("pointermove", pointerMove);
    canvas.removeEventListener("pointerup", pointerUp);
    canvas.removeEventListener("pointercancel", pointerUp);
    canvas.removeEventListener("lostpointercapture", pointerUp);
    canvas.removeEventListener("keydown", keyDown);
    canvas.removeEventListener("keyup", keyUp);
    canvas.removeEventListener("blur", resetInput);
    canvas.removeEventListener("webglcontextlost", contextLost);
    canvas.removeEventListener("webglcontextrestored", contextRestored);
    disposeObjects(scene);
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.remove();
  };
}
