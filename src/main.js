import { Buffer } from 'buffer';
window.Buffer = Buffer;

import './style.css';
import { initNavigation } from './modules/navigation.js';
import { initCursorGlow, initScrollAnimations, initCounters } from './modules/effects.js';
import { initStaking } from './modules/staking.js';
import { initParticles } from './modules/particles.js';
import { initValidatorStats } from './modules/validator.js';

// Initialize all core modules
initNavigation();
initParticles();
initCursorGlow();
initStaking();
initValidatorStats();

// Reveal the app — CSS is loaded, core modules are ready
requestAnimationFrame(() => {
  const wrapper = document.getElementById('app-wrapper');
  const loader = document.getElementById('loader');
  if (wrapper) wrapper.classList.add('ready');
  if (loader) {
    loader.classList.add('hidden');
    loader.addEventListener('transitionend', () => loader.remove(), { once: true });
  }

  initScrollAnimations();
  initCounters();
});

// Lazy-load GSAP (heavy)
initGSAPAsync();
registerServiceWorker();

async function initGSAPAsync() {
  try {
    const { initGSAP } = await import('./modules/animations.js');
    await initGSAP();
  } catch (err) {
    console.warn('GSAP failed to load:', err);
  }
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(err => {
        console.warn('SW registration failed:', err);
      });
    });
  }
}
