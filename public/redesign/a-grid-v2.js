(async () => {
  // ============================================================
  // 0node concept A v2 — geo-mapped leader rotation
  //
  // Visual pipeline:
  //   1. Decode TopoJSON of world landmass to polygon arcs.
  //   2. Sample land outline as a dot-grid for the "abstract globe" look.
  //   3. Project validator lat/lng to canvas coordinates (Mercator).
  //   4. Drive a synthetic leader schedule — 1 leader per 4-slot window
  //      (~1.6 s) — and animate camera + comet handoff between them.
  //
  // Real-data hookup is left as a follow-up: plug rpc.getLeaderSchedule
  // + Stakewiz validator geo + (optional) slotSubscribe to replace the
  // synthetic loop. The visual layer is intentionally agnostic to the
  // data source.
  // ============================================================

  const c = document.getElementById('globe');
  const ctx = c.getContext('2d');
  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  const loaderEl = document.getElementById('loader');

  let w, h;
  function resize() {
    w = window.innerWidth; h = window.innerHeight;
    c.width = w * DPR; c.height = h * DPR;
    c.style.width = w + 'px'; c.style.height = h + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  resize();
  window.addEventListener('resize', resize);

  // ----- Validator dataset (sample) --------------------------------------
  // Hand-picked datacenter cities where mainnet validators actually cluster.
  // Real data swap: replace this with Stakewiz fetch in a follow-up.
  const VALIDATOR_CITIES = [
    // North America
    { name: 'Seattle',        lat: 47.61, lng: -122.33, count: 8 },
    { name: 'San Jose',       lat: 37.34, lng: -121.89, count: 6 },
    { name: 'Los Angeles',    lat: 34.05, lng: -118.24, count: 5 },
    { name: 'Salt Lake City', lat: 40.76, lng: -111.89, count: 4 },
    { name: 'Dallas',         lat: 32.78, lng:  -96.80, count: 5 },
    { name: 'Chicago',        lat: 41.88, lng:  -87.63, count: 6 },
    { name: 'New York',       lat: 40.71, lng:  -74.01, count: 8 },
    { name: 'Washington DC',  lat: 38.91, lng:  -77.04, count: 5 },
    { name: 'Miami',          lat: 25.76, lng:  -80.19, count: 4 },
    { name: 'Toronto',        lat: 43.65, lng:  -79.38, count: 5 },
    { name: 'Montreal',       lat: 45.50, lng:  -73.57, count: 4 },
    // Europe
    { name: 'London',         lat: 51.51, lng:   -0.13, count: 9 },
    { name: 'Amsterdam',      lat: 52.37, lng:    4.90, count: 8 },
    { name: 'Frankfurt',      lat: 50.11, lng:    8.68, count: 12 },
    { name: 'Paris',          lat: 48.86, lng:    2.35, count: 6 },
    { name: 'Helsinki',       lat: 60.17, lng:   24.94, count: 5 },
    { name: 'Stockholm',      lat: 59.33, lng:   18.07, count: 4 },
    { name: 'Warsaw',         lat: 52.23, lng:   21.01, count: 4 },
    { name: 'Madrid',         lat: 40.42, lng:   -3.70, count: 3 },
    { name: 'Milan',          lat: 45.46, lng:    9.19, count: 3 },
    { name: 'Vienna',         lat: 48.21, lng:   16.37, count: 3 },
    { name: 'Bucharest',      lat: 44.43, lng:   26.10, count: 3 },
    { name: 'Zurich',         lat: 47.38, lng:    8.54, count: 3 },
    // Asia / Pacific
    { name: 'Tokyo',          lat: 35.68, lng:  139.69, count: 7 },
    { name: 'Osaka',          lat: 34.69, lng:  135.50, count: 3 },
    { name: 'Singapore',      lat:  1.35, lng:  103.82, count: 8 },
    { name: 'Hong Kong',      lat: 22.32, lng:  114.17, count: 5 },
    { name: 'Seoul',          lat: 37.57, lng:  126.98, count: 4 },
    { name: 'Mumbai',         lat: 19.08, lng:   72.88, count: 3 },
    { name: 'Dubai',          lat: 25.20, lng:   55.27, count: 3 },
    { name: 'Sydney',         lat: -33.87, lng: 151.21, count: 5 },
    // Other
    { name: 'São Paulo',      lat: -23.55, lng: -46.63, count: 3 },
    { name: 'Johannesburg',   lat: -26.20, lng:  28.04, count: 2 },
  ];

  // The "0node" home location (Hong Kong per Stakewiz)
  const OUR_LOCATION = { lat: 22.32, lng: 114.17 };

  // Expand cities into individual validators with small jitter
  const validators = [];
  for (const city of VALIDATOR_CITIES) {
    for (let i = 0; i < city.count; i++) {
      const jitterLat = (Math.random() - 0.5) * 2.2;
      const jitterLng = (Math.random() - 0.5) * 4.0;
      validators.push({
        lat: city.lat + jitterLat,
        lng: city.lng + jitterLng,
        city: city.name,
        // remembered visual energy — peaks when this validator is leader,
        // and slowly decays
        energy: 0,
        // sibling glow — if a city had its slot recently, all peers nearby
        // get a "warm" boost
        cityGlow: 0,
      });
    }
  }
  // Mark our validator (the one in our location)
  let ourIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < validators.length; i++) {
    const d = Math.hypot(validators[i].lat - OUR_LOCATION.lat, validators[i].lng - OUR_LOCATION.lng);
    if (d < bestDist) { bestDist = d; ourIdx = i; }
  }
  validators[ourIdx].ours = true;

  document.getElementById('t-count').textContent = validators.length.toString();

  // ----- Camera (world → screen with smooth pan) -------------------------
  const camera = {
    // World coordinates we're centering on (lat/lng).
    lat: 20, lng: 0,
    // Target lat/lng we're easing toward.
    tLat: 20, tLng: 0,
    // Mercator scale: how many CSS pixels for one full equator wraparound.
    // Default fits roughly one whole world width in the viewport so the
    // big picture is visible before the camera starts chasing leaders.
    scale: Math.max(w, h) * 0.9,
  };
  const SCALE_MIN = 400;
  const SCALE_MAX = 8000;
  // Timestamp of last user interaction (wheel or drag). While the user is
  // actively exploring we suspend leader-tracking; auto-track resumes 10s
  // after the last interaction.
  let lastInteract = 0;
  const AUTOTRACK_RESUME_MS = 10000;

  function projectMercator(lat, lng) {
    const x = (lng / 360) * camera.scale;
    const latRad = lat * Math.PI / 180;
    const mercY = Math.log(Math.tan(Math.PI / 4 + latRad / 2));
    const y = -(mercY / (2 * Math.PI)) * camera.scale;
    return { x, y };
  }

  function worldToScreen(lat, lng) {
    const p = projectMercator(lat, lng);
    const center = projectMercator(camera.lat, camera.lng);
    return { x: p.x - center.x + w / 2, y: p.y - center.y + h / 2 };
  }

  // Inverse of worldToScreen — needed for zoom-around-cursor and panning.
  function screenToWorld(sx, sy) {
    const center = projectMercator(camera.lat, camera.lng);
    const px = sx - w / 2 + center.x;
    const py = sy - h / 2 + center.y;
    const lng = (px / camera.scale) * 360;
    const mercY = -(py / camera.scale) * 2 * Math.PI;
    const latRad = 2 * (Math.atan(Math.exp(mercY)) - Math.PI / 4);
    const lat = latRad * 180 / Math.PI;
    return { lat, lng };
  }

  // ----- Interactive pan/zoom -----
  let dragging = false;
  let dragStart = null;
  c.addEventListener('mousedown', e => {
    dragging = true;
    dragStart = { x: e.clientX, y: e.clientY, lat: camera.lat, lng: camera.lng };
    c.style.cursor = 'grabbing';
  });
  window.addEventListener('mouseup', () => {
    dragging = false;
    c.style.cursor = 'crosshair';
  });
  window.addEventListener('mousemove', e => {
    if (!dragging || !dragStart) return;
    lastInteract = performance.now();
    // Compute the cursor's world position at drag start and at current
    // position; pan the camera so the world point under cursor doesn't move.
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    // Δlng in degrees per pixel = 360 / scale
    const dLng = (dx / camera.scale) * 360;
    // Δlat is non-linear in Mercator; approximate using cos(currentLat)
    // for small drags, good enough for interactive feel.
    const dLat = (dy / camera.scale) * 360 * Math.cos(camera.lat * Math.PI / 180) * 0.55;
    camera.lat = Math.max(-78, Math.min(78, dragStart.lat + dLat));
    camera.lng = dragStart.lng - dLng;
    camera.tLat = camera.lat;
    camera.tLng = camera.lng;
  });
  c.addEventListener('wheel', e => {
    e.preventDefault();
    lastInteract = performance.now();
    const before = screenToWorld(e.clientX, e.clientY);
    const factor = e.deltaY > 0 ? 0.85 : 1.18;
    camera.scale = Math.max(SCALE_MIN, Math.min(SCALE_MAX, camera.scale * factor));
    // After scale change, shift the camera so the same world point stays
    // under the cursor — natural "zoom toward cursor" UX.
    const after = screenToWorld(e.clientX, e.clientY);
    camera.lat += before.lat - after.lat;
    camera.lng += before.lng - after.lng;
    camera.lat = Math.max(-78, Math.min(78, camera.lat));
    camera.tLat = camera.lat;
    camera.tLng = camera.lng;
  }, { passive: false });

  // Straight-line "lightning" interpolation. No ballistic arc, no fading
  // tail — just a fast point flying from source to destination with a
  // short hard streak behind the head.
  function boltPoint(fromIdx, toIdx, progress) {
    const f = worldToScreen(validators[fromIdx].lat, validators[fromIdx].lng);
    const t = worldToScreen(validators[toIdx].lat, validators[toIdx].lng);
    return {
      x: f.x + (t.x - f.x) * progress,
      y: f.y + (t.y - f.y) * progress,
      from: f, to: t,
    };
  }

  // ----- Topojson land decoder -------------------------------------------
  // Decode the world-atlas land-110m topojson into ring arrays of [lng, lat].
  // We render these as FILLED polygons (validblocks/d3-geo aesthetic) instead
  // of sampled dots — gives us recognisable continent silhouettes on a dark
  // background, with a dashed lat/lng graticule on top.
  let landRings = [];

  async function loadLand() {
    try {
      const data = await (await fetch('./world-land-110m.json')).json();
      const obj = data.objects.land;
      const arcs = data.arcs;
      const trans = data.transform;
      const decodedArcs = arcs.map(arc => {
        let x = 0, y = 0;
        const result = [];
        for (const [dx, dy] of arc) {
          x += dx; y += dy;
          const lng = x * trans.scale[0] + trans.translate[0];
          const lat = y * trans.scale[1] + trans.translate[1];
          result.push([lng, lat]);
        }
        return result;
      });
      function ringPoints(arcIdxs) {
        const ring = [];
        for (const idx of arcIdxs) {
          const reversed = idx < 0;
          const real = reversed ? ~idx : idx;
          const arc = decodedArcs[real];
          const seq = reversed ? [...arc].reverse() : arc;
          for (const pt of seq) ring.push(pt);
        }
        return ring;
      }
      function collect(geom) {
        if (!geom) return;
        if (geom.type === 'Polygon') {
          for (const r of geom.arcs) landRings.push(ringPoints(r));
        } else if (geom.type === 'MultiPolygon') {
          for (const poly of geom.arcs) for (const r of poly) landRings.push(ringPoints(r));
        } else if (geom.type === 'GeometryCollection') {
          for (const g of geom.geometries) collect(g);
        }
      }
      collect(obj);
    } catch (err) {
      console.warn('land map failed to load:', err);
    }
  }

  await loadLand();
  loaderEl.classList.add('hidden');
  setTimeout(() => loaderEl.remove(), 600);

  // ----- Synthetic leader schedule ---------------------------------------
  // Real plug-in point: replace `pickNextLeader` with rpc.getLeaderSchedule
  // lookup using the live slot from slotSubscribe.
  const SLOT_MS = 400;
  const SLOTS_PER_LEADER = 4;
  const LEADER_WINDOW_MS = SLOT_MS * SLOTS_PER_LEADER;

  let currentLeader = Math.floor(Math.random() * validators.length);
  let prevLeader = currentLeader;
  let leaderStartTime = performance.now();
  let slotIndex = 0;
  let baseSlot = 414000000 + Math.floor(Math.random() * 1000); // synthetic, looks plausible

  function pickNextLeader() {
    // Weighted random: occasionally pick our validator, otherwise random.
    if (Math.random() < 0.08) return ourIdx;
    let next = currentLeader;
    while (next === currentLeader) {
      next = Math.floor(Math.random() * validators.length);
    }
    return next;
  }

  function advanceLeader(now) {
    const elapsed = now - leaderStartTime;
    if (elapsed >= LEADER_WINDOW_MS) {
      prevLeader = currentLeader;
      currentLeader = pickNextLeader();
      leaderStartTime = now;
      slotIndex = 0;
      baseSlot += SLOTS_PER_LEADER;
      // Boost city glow for siblings of the new leader
      const newCity = validators[currentLeader].city;
      for (const v of validators) {
        if (v.city === newCity) v.cityGlow = Math.min(1, v.cityGlow + 0.6);
      }
      // Aim camera at the new leader — unless the user is currently driving
      // the camera with mouse drag / wheel. Auto-track resumes
      // AUTOTRACK_RESUME_MS after the last interaction.
      if (now - lastInteract > AUTOTRACK_RESUME_MS) {
        camera.tLat = validators[currentLeader].lat;
        camera.tLng = validators[currentLeader].lng;
      }
      // Telemetry text
      document.getElementById('t-region').textContent = newCity;
    }
    const newSlotIndex = Math.min(SLOTS_PER_LEADER - 1, Math.floor(elapsed / SLOT_MS));
    if (newSlotIndex !== slotIndex) {
      slotIndex = newSlotIndex;
      validators[currentLeader].energy = 1;
    }
    document.getElementById('t-slot').textContent = (baseSlot + slotIndex).toString();
    document.getElementById('t-lead').textContent = validators[currentLeader].city;
  }

  // ----- Render loop -----------------------------------------------------
  let pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(loop);
  }

  let lastTime = performance.now();
  function loop(t) {
    pending = false;
    try {
      const dt = Math.min(60, t - lastTime);
      lastTime = t;

      // Ease camera toward target
      const ease = 1 - Math.pow(0.001, dt / 1000);
      camera.lat += (camera.tLat - camera.lat) * ease;
      camera.lng += (camera.tLng - camera.lng) * ease;

      advanceLeader(t);

      // Solid background each frame. We deliberately don't use the
      // "fade-trail" trick (drawing translucent black to leave echoes)
      // because the camera pans every frame — translucent overdraw
      // would smear the whole map. The comet's tail is drawn
      // programmatically further down instead.
      ctx.fillStyle = '#03040a';
      ctx.fillRect(0, 0, w, h);

      // ---- Graticule (lat/lng grid, dashed) — drawn first, behind land ----
      // Bounded to the non-polar belt — the projection breaks down past
      // ±60°ish and lines down there create visible thin bands at the
      // edges of the canvas.
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.045)';
      ctx.lineWidth = 0.6;
      ctx.setLineDash([3, 6]);
      for (let lng = -180; lng <= 180; lng += 15) {
        ctx.beginPath();
        for (let lat = -60; lat <= 75; lat += 4) {
          const s = worldToScreen(lat, lng);
          if (lat === -60) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
        }
        ctx.stroke();
      }
      for (let lat = -60; lat <= 60; lat += 15) {
        ctx.beginPath();
        for (let lng = -180; lng <= 180; lng += 6) {
          const s = worldToScreen(lat, lng);
          if (lng === -180) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
        }
        ctx.stroke();
      }
      ctx.restore();

      // ---- Continents (filled, validblocks-style) ----
      // Two classes of ring cause horizontal-band artifacts:
      //   1. Polar rings (Antarctica) — Mercator y blows up near the
      //      south pole, fill spills across the map.
      //   2. Dateline-crossing rings — consecutive points on opposite
      //      sides of ±180° lng produce a segment that jumps the full
      //      width of the canvas; fill becomes a giant horizontal strip.
      // We pre-flag those and skip them. Small loss (Antarctica + a few
      // tiny Russian/Pacific islands), big win for visual cleanliness.
      ctx.fillStyle = 'rgba(203, 213, 225, 0.16)';
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
      ctx.lineWidth = 0.8;
      for (const ring of landRings) {
        if (ring.length < 3) continue;
        if (ring._badRing === undefined) {
          // "Any point south of X" was wrong — it cut off Patagonia and
          // Tierra del Fuego, which dip to -55° but belong to a ring whose
          // northern edge is well into the northern hemisphere (South
          // America runs lat ≈ +13° → -55°).
          //
          // Antarctica is the actual problem: it's a ring that is *entirely*
          // in the deep south. So flag based on the ring's northernmost
          // point — if even max(lat) is below -50°, it's Antarctica or one
          // of its offshore islands. Patagonia's max(lat) is +13° and it
          // survives.
          //
          // Dateline-crossing rings still get flagged separately.
          let bad = false;
          let maxLat = -Infinity;
          for (let i = 0; i < ring.length; i++) {
            if (ring[i][1] > maxLat) maxLat = ring[i][1];
            if (i > 0 && Math.abs(ring[i][0] - ring[i - 1][0]) > 180) { bad = true; break; }
          }
          if (!bad && maxLat < -50) bad = true;
          ring._badRing = bad;
        }
        if (ring._badRing) continue;
        ctx.beginPath();
        let inView = false;
        for (let i = 0; i < ring.length; i++) {
          const s = worldToScreen(ring[i][1], ring[i][0]);
          if (s.x > -50 && s.x < w + 50 && s.y > -50 && s.y < h + 50) inView = true;
          if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
        }
        ctx.closePath();
        if (inView) { ctx.fill(); ctx.stroke(); }
      }

      // ---- City labels (only for cities currently visible) ----
      ctx.font = "11px -apple-system, 'Segoe UI', sans-serif";
      ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
      ctx.textBaseline = 'middle';
      const labeled = new Set();
      for (const city of VALIDATOR_CITIES) {
        if (labeled.has(city.name)) continue;
        const s = worldToScreen(city.lat, city.lng);
        if (s.x < 20 || s.x > w - 100 || s.y < 60 || s.y > h - 80) continue;
        labeled.add(city.name);
        ctx.fillText(city.name, s.x + 12, s.y - 1);
      }

      // Validators
      for (let i = 0; i < validators.length; i++) {
        const v = validators[i];
        const s = worldToScreen(v.lat, v.lng);
        if (s.x < -40 || s.x > w + 40 || s.y < -40 || s.y > h + 40) {
          // off-screen — still decay energy to avoid flash on re-entry
          v.energy *= 0.94;
          v.cityGlow *= 0.97;
          continue;
        }
        const isLeader = i === currentLeader;

        // Per-slot blink: 4 pulses during the leader's window
        let slotBlink = 0;
        if (isLeader) {
          const elapsed = t - leaderStartTime;
          const phase = (elapsed % SLOT_MS) / SLOT_MS;
          slotBlink = Math.sin(phase * Math.PI); // 0→1→0 over 400 ms
        }

        v.energy *= 0.94;
        v.cityGlow *= 0.985;

        // Soft halo for city-mates of the active leader
        if (v.cityGlow > 0.02 && !isLeader) {
          ctx.fillStyle = `rgba(74, 222, 128, ${0.08 * v.cityGlow})`;
          ctx.beginPath();
          ctx.arc(s.x, s.y, 14, 0, Math.PI * 2);
          ctx.fill();
        }

        if (isLeader) {
          // Big outer halo — neon green, matches the bolt
          const haloR = 22 + slotBlink * 14;
          const haloA = 0.18 + slotBlink * 0.35;
          ctx.fillStyle = `rgba(74, 222, 128, ${haloA * 0.5})`;
          ctx.beginPath();
          ctx.arc(s.x, s.y, haloR, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = `rgba(134, 239, 172, ${haloA + 0.1})`;
          ctx.beginPath();
          ctx.arc(s.x, s.y, haloR * 0.55, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#fff';
          ctx.beginPath();
          ctx.arc(s.x, s.y, 3.8 + slotBlink * 1.4, 0, Math.PI * 2);
          ctx.fill();
        } else if (v.ours) {
          // Ours always visible — green halo
          ctx.fillStyle = 'rgba(74, 222, 128, 0.25)';
          ctx.beginPath();
          ctx.arc(s.x, s.y, 12, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = 'rgba(74, 222, 128, 0.7)';
          ctx.beginPath();
          ctx.arc(s.x, s.y, 5, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#fff';
          ctx.beginPath();
          ctx.arc(s.x, s.y, 2.2, 0, Math.PI * 2);
          ctx.fill();
        } else {
          const baseA = 0.35 + v.cityGlow * 0.45;
          ctx.fillStyle = `rgba(74, 222, 128, ${baseA})`;
          ctx.beginPath();
          ctx.arc(s.x, s.y, 2.4, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Lightning bolt from previous leader to current leader. Straight
      // line, no fading tail — just a short hard streak following the
      // bright head as it travels. Bolt completes in the first 40% of
      // the leader window so the eye registers each handoff cleanly.
      if (prevLeader !== currentLeader) {
        const elapsed = t - leaderStartTime;
        const flightMs = LEADER_WINDOW_MS * 0.4;
        const progress = Math.min(1, elapsed / flightMs);
        if (progress < 1) {
          const head = boltPoint(prevLeader, currentLeader, progress);
          // Short trailing segment — the "streak" portion of the bolt.
          // Hard-ended, ~7% of the path behind the head; not a faded tail.
          const trailLen = 0.07;
          const tailP = Math.max(0, progress - trailLen);
          const tail = boltPoint(prevLeader, currentLeader, tailP);

          // Outer neon-green glow line
          ctx.strokeStyle = 'rgba(74, 222, 128, 0.5)';
          ctx.lineWidth = 6;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(tail.x, tail.y);
          ctx.lineTo(head.x, head.y);
          ctx.stroke();

          // Bright mint core line
          ctx.strokeStyle = 'rgba(220, 252, 231, 0.95)';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(tail.x, tail.y);
          ctx.lineTo(head.x, head.y);
          ctx.stroke();

          // Head dot — three-layer neon glow
          ctx.fillStyle = 'rgba(74, 222, 128, 0.35)';
          ctx.beginPath();
          ctx.arc(head.x, head.y, 10, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = 'rgba(134, 239, 172, 0.7)';
          ctx.beginPath();
          ctx.arc(head.x, head.y, 5, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = 'rgba(240, 255, 244, 1)';
          ctx.beginPath();
          ctx.arc(head.x, head.y, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    } catch (err) {
      if (!loop._loggedErr) { console.warn('geo loop:', err); loop._loggedErr = true; }
    }
    schedule();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') schedule();
  });

  schedule();
})();
