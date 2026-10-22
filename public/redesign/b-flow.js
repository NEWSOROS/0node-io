(() => {
  const c = document.getElementById('flow');
  const ctx = c.getContext('2d');
  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  let w, h;
  const particles = [];
  const COUNT = 1500;
  const COLORS = ['#f472b6', '#818cf8', '#34d399', '#a78bfa', '#22d3ee'];

  function hash(x, y) {
    let n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
    return n - Math.floor(n);
  }
  function smooth(t) { return t * t * (3 - 2 * t); }
  function noise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = smooth(xf), v = smooth(yf);
    const a = hash(xi, yi), b = hash(xi + 1, yi);
    const c2 = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    return a * (1 - u) * (1 - v) + b * u * (1 - v) + c2 * (1 - u) * v + d * u * v;
  }

  function resize() {
    w = window.innerWidth; h = window.innerHeight;
    c.width = w * DPR; c.height = h * DPR;
    c.style.width = w + 'px'; c.style.height = h + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  window.addEventListener('resize', resize);
  resize();

  function spawn(p, fresh) {
    if (fresh && Math.random() < 0.7) {
      p.x = -20;
      p.y = Math.random() * h;
    } else {
      p.x = Math.random() * w;
      p.y = Math.random() * h;
    }
    p.life = 200 + Math.random() * 300;
    p.age = 0;
    p.color = COLORS[Math.floor(Math.random() * COLORS.length)];
    p.size = 0.7 + Math.random() * 1.3;
    p.prevX = p.x; p.prevY = p.y;
  }

  for (let i = 0; i < COUNT; i++) {
    const p = { x: 0, y: 0, prevX: 0, prevY: 0, life: 0, age: 0, color: '#fff', size: 1 };
    spawn(p, false);
    p.age = Math.random() * p.life;
    particles.push(p);
  }

  let pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(loop);
  }

  function loop(t) {
    pending = false;
    try {
      ctx.fillStyle = 'rgba(5, 3, 20, 0.06)';
      ctx.fillRect(0, 0, w, h);

      ctx.globalCompositeOperation = 'lighter';

      const time = t * 0.00008;
      for (const p of particles) {
        const nx = p.x * 0.003;
        const ny = p.y * 0.003;
        const n1 = noise(nx + time, ny);
        const n2 = noise(nx, ny + time + 100);
        const angle = n1 * Math.PI * 4 - Math.PI;
        const speed = 1.2 + n2 * 1.8;
        p.prevX = p.x; p.prevY = p.y;
        p.x += Math.cos(angle) * speed;
        p.y += Math.sin(angle) * speed * 0.6 + 0.05;

        const alpha = Math.sin((p.age / p.life) * Math.PI);
        ctx.strokeStyle = p.color;
        ctx.globalAlpha = alpha * 0.7;
        ctx.lineWidth = p.size;
        ctx.beginPath();
        ctx.moveTo(p.prevX, p.prevY);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();

        p.age++;
        if (p.age > p.life || p.x > w + 30 || p.y > h + 30 || p.y < -30 || p.x < -30) {
          spawn(p, true);
        }
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    } catch (err) {
      if (!loop._loggedErr) { console.warn('b-flow loop:', err); loop._loggedErr = true; }
      // Restore state in case we threw mid-frame with a comp op set.
      try { ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1; } catch (_) {}
    }
    schedule();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') schedule();
  });

  schedule();
})();
