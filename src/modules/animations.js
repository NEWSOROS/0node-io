export async function initGSAP() {
  const gsapModule = await import('gsap');
  const gsap = gsapModule.default || gsapModule.gsap;
  const { ScrollTrigger } = await import('gsap/ScrollTrigger');

  gsap.registerPlugin(ScrollTrigger);

  // Hero entrance — use timeline for reliable sequencing
  const heroTL = gsap.timeline({ defaults: { ease: 'power3.out' } });

  heroTL
    .fromTo('.hero-logo',
      { y: 40, opacity: 0 },
      { y: 0, opacity: 1, duration: 1.2, clearProps: 'all' }
    )
    .fromTo('.hero-subtitle',
      { y: 30, opacity: 0 },
      { y: 0, opacity: 1, duration: 1, clearProps: 'all' },
      '-=0.6'
    )
    .fromTo('.hero-badges .badge',
      { y: 20, opacity: 0 },
      { y: 0, opacity: 1, duration: 0.6, stagger: 0.15, clearProps: 'all' },
      '-=0.4'
    )
    .fromTo('.hero-content .btn',
      { y: 20, opacity: 0 },
      { y: 0, opacity: 1, duration: 0.8, clearProps: 'all' },
      '-=0.3'
    );

  // Timeline line animation
  const timelineLine = document.getElementById('timeline-line');
  if (timelineLine) {
    gsap.fromTo(timelineLine,
      { scaleX: 0, transformOrigin: 'left center' },
      {
        scaleX: 1,
        duration: 1.5,
        ease: 'power2.out',
        scrollTrigger: {
          trigger: '#how-it-works',
          start: 'top 70%',
        },
      }
    );
  }

  // Staking panel glow pulse
  const stakingPanel = document.getElementById('staking-panel');
  if (stakingPanel) {
    gsap.to(stakingPanel, {
      boxShadow: '0 0 40px rgba(59, 130, 246, 0.15), 0 0 80px rgba(139, 92, 246, 0.08)',
      duration: 2,
      repeat: -1,
      yoyo: true,
      ease: 'sine.inOut',
    });
  }
}
