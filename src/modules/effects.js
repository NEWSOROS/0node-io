export function initCursorGlow() {
  const glow = document.getElementById('hero-glow');
  const hero = document.querySelector('.hero');
  if (!glow || !hero) return;

  hero.addEventListener('mousemove', (e) => {
    const rect = hero.getBoundingClientRect();
    const x = e.clientX - rect.left - 200;
    const y = e.clientY - rect.top - 200;
    glow.style.transform = `translate(${x}px, ${y}px)`;
  });

  hero.addEventListener('mouseleave', () => {
    glow.style.opacity = '0';
    glow.style.transition = 'opacity 0.5s ease';
  });

  hero.addEventListener('mouseenter', () => {
    glow.style.opacity = '1';
    glow.style.transition = 'opacity 0.3s ease';
  });
}

export function initScrollAnimations() {
  const elements = document.querySelectorAll('[data-animate]');

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const delay = parseInt(entry.target.dataset.delay || '0', 10);
        setTimeout(() => {
          entry.target.classList.add('animated');
        }, delay);
        observer.unobserve(entry.target);
      }
    });
  }, {
    threshold: 0.1,
    rootMargin: '0px 0px -50px 0px',
  });

  elements.forEach(el => observer.observe(el));
}

export function initCounters() {
  const counters = document.querySelectorAll('[data-count]');

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        animateCounter(entry.target);
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.5 });

  counters.forEach(el => observer.observe(el));
}

function animateCounter(el) {
  const target = parseFloat(el.dataset.count);
  const duration = 2000;
  const startTime = performance.now();
  const isDecimal = target % 1 !== 0;
  const isLarge = target >= 1000;

  function update(currentTime) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3); // easeOutCubic
    const current = target * eased;

    if (isLarge) {
      el.textContent = Math.floor(current).toLocaleString();
    } else if (isDecimal) {
      el.textContent = current.toFixed(1);
    } else {
      el.textContent = Math.floor(current);
    }

    if (progress < 1) {
      requestAnimationFrame(update);
    }
  }

  requestAnimationFrame(update);
}
