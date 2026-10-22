(() => {
  const c = document.getElementById('net');
  const ctx = c.getContext('2d');
  const DPR = Math.min(window.devicePixelRatio || 1, 2);

  let w, h, nodes = [], edges = [], pulses = [];
  let pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(loop);
  }

  function resize() {
    w = window.innerWidth; h = window.innerHeight;
    c.width = w * DPR; c.height = h * DPR;
    c.style.width = w + 'px'; c.style.height = h + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    // pulses store indices into the OLD nodes/edges arrays; after rebuild
    // they'd point at the wrong node or out-of-range. Drop them.
    pulses = [];
    buildNetwork();
  }
  window.addEventListener('resize', resize);

  function buildNetwork() {
    nodes = [];
    edges = [];
    const cols = Math.ceil(w / 90) + 2;
    const rows = Math.ceil(h / 90) + 2;
    const spacingX = w / (cols - 2);
    const spacingY = h / (rows - 2);

    for (let r = 0; r < rows; r++) {
      for (let cc = 0; cc < cols; cc++) {
        const jitterX = (Math.random() - 0.5) * spacingX * 0.5;
        const jitterY = (Math.random() - 0.5) * spacingY * 0.5;
        const z = Math.random();
        nodes.push({
          x: cc * spacingX - spacingX + jitterX,
          y: r * spacingY - spacingY + jitterY,
          z,
          ours: false,
          phase: Math.random() * Math.PI * 2,
          speed: 0.5 + Math.random(),
        });
      }
    }

    let bestIdx = 0, bestDist = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      const dx = nodes[i].x - w / 2;
      const dy = nodes[i].y - h / 2;
      const d = dx * dx + dy * dy;
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    nodes[bestIdx].ours = true;
    nodes[bestIdx].z = 0.85;

    for (let i = 0; i < nodes.length; i++) {
      const dists = [];
      for (let j = 0; j < nodes.length; j++) {
        if (i === j) continue;
        const dx = nodes[i].x - nodes[j].x;
        const dy = nodes[i].y - nodes[j].y;
        dists.push({ j, d: dx * dx + dy * dy });
      }
      dists.sort((a, b) => a.d - b.d);
      for (let k = 0; k < 3; k++) {
        if (dists[k] && dists[k].d < 38000) {
          edges.push({ a: i, b: dists[k].j });
        }
      }
    }
  }

  function spawnPulse(originIdx) {
    pulses.push({
      from: originIdx,
      progress: 0,
      speed: 0.012 + Math.random() * 0.012,
      targets: edges.filter(e => e.a === originIdx || e.b === originIdx).map(e => e.a === originIdx ? e.b : e.a),
    });
  }

  let lastSpawn = 0;
  function loop(t) {
    pending = false;
    try {
      ctx.fillStyle = 'rgba(3, 4, 10, 0.15)';
      ctx.fillRect(0, 0, w, h);

      for (const e of edges) {
        const A = nodes[e.a], B = nodes[e.b];
        if (!A || !B) continue;
        const alpha = 0.04 + Math.min(A.z, B.z) * 0.12;
        ctx.strokeStyle = `rgba(34, 211, 238, ${alpha})`;
        ctx.lineWidth = 0.4;
        ctx.beginPath();
        ctx.moveTo(A.x, A.y);
        ctx.lineTo(B.x, B.y);
        ctx.stroke();
      }

      for (let i = pulses.length - 1; i >= 0; i--) {
        const p = pulses[i];
        const origin = nodes[p.from];
        if (!origin) { pulses.splice(i, 1); continue; }
        for (const targetIdx of p.targets) {
          const target = nodes[targetIdx];
          if (!target) continue;
          const x = origin.x + (target.x - origin.x) * p.progress;
          const y = origin.y + (target.y - origin.y) * p.progress;
          ctx.fillStyle = `rgba(34, 211, 238, ${(1 - p.progress) * 0.9})`;
          ctx.beginPath();
          ctx.arc(x, y, 2.2, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = `rgba(34, 211, 238, ${(1 - p.progress) * 0.2})`;
          ctx.beginPath();
          ctx.arc(x, y, 6, 0, Math.PI * 2);
          ctx.fill();
        }
        p.progress += p.speed;
        if (p.progress >= 1) pulses.splice(i, 1);
      }

    for (const n of nodes) {
      const breath = 0.6 + 0.4 * Math.sin(t * 0.001 * n.speed + n.phase);
      if (n.ours) {
        ctx.fillStyle = 'rgba(168, 85, 247, 0.18)';
        ctx.beginPath();
        ctx.arc(n.x, n.y, 28 + breath * 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(168, 85, 247, 0.4)';
        ctx.beginPath();
        ctx.arc(n.x, n.y, 14 + breath * 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(n.x, n.y, 4.5, 0, Math.PI * 2);
        ctx.fill();
      } else {
        const r = 1 + n.z * 1.4 * breath;
        ctx.fillStyle = `rgba(255, 255, 255, ${0.08 + n.z * 0.18 * breath})`;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

      if (t - lastSpawn > 220) {
        lastSpawn = t;
        const ourIdx = nodes.findIndex(n => n.ours);
        if (Math.random() < 0.55 && ourIdx >= 0) spawnPulse(ourIdx);
        else if (nodes.length > 0) spawnPulse(Math.floor(Math.random() * nodes.length));
      }
    } catch (err) {
      // Swallow per-frame errors so the loop never dies. Log once.
      if (!loop._loggedErr) { console.warn('a-grid loop:', err); loop._loggedErr = true; }
    }
    schedule();
  }

  // Re-arm if the tab was backgrounded and the browser dropped the RAF
  // chain on us. Dedup via `pending` so we never end up with two parallel
  // chains that would compound into N-per-frame.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') schedule();
  });

  resize();
  schedule();
})();
