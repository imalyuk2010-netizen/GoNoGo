// Smooth scrolling (Lenis) + scroll-driven effects: progress bar, hero parallax, reveals.
// Everything degrades to normal native scrolling if Lenis fails to load or the user
// prefers reduced motion.

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
// Touch screens keep native momentum scrolling and use CSS scroll-snap (see style.css);
// Lenis smoothing and the wheel/idle snapping below are for mouse and trackpad.
const touch = window.matchMedia('(pointer: coarse)').matches;
document.documentElement.classList.toggle('is-touch', touch);
const root = document.documentElement;
const parallax = [...document.querySelectorAll('[data-speed]')];
const hero = document.getElementById('top');
const reveals = [...document.querySelectorAll('.reveal, .hero-title')];

// ---------- scroll story ("What you get"): a pinned stage whose picture changes with scroll ----------
const story = document.getElementById('story');
const storyItems = story ? [...story.querySelectorAll('.story-item')] : [];
const storyFigs = story ? [...story.querySelectorAll('.story-fig')] : [];
const storyStage = document.getElementById('storyStage');
let storyIdx = 0;
function storyMetrics() {
  const bar = document.querySelector('.topbar');
  const offset = bar ? bar.offsetHeight : 71;
  const total = story.offsetHeight - story.firstElementChild.offsetHeight;
  return { total, top: story.getBoundingClientRect().top + window.scrollY - offset };
}
function updateStory() {
  if (!story || !storyItems.length) return;
  const { total, top } = storyMetrics();
  const p = Math.min(1, Math.max(0, (window.scrollY - top) / Math.max(1, total)));
  const n = storyItems.length;
  const seg = Math.min(n - 0.0001, p * n);
  const idx = Math.floor(seg);
  if (idx !== storyIdx) {
    storyIdx = idx;
    storyItems.forEach((e, i) => e.classList.toggle('on', i === idx));
    storyFigs.forEach((e, i) => e.classList.toggle('on', i === idx));
  }
}
storyItems.forEach((it, i) => it.addEventListener('click', () => {
  const { total, top } = storyMetrics();
  const y = top + total * ((i + 0.5) / storyItems.length);
  if (window.lenis) window.lenis.scrollTo(y, { duration: 1 });
  else window.scrollTo({ top: y, behavior: reduced ? 'auto' : 'smooth' });
}));
window.addEventListener('resize', updateStory);

// ---------- reveals ----------
if (reduced || !('IntersectionObserver' in window)) {
  reveals.forEach((n) => n.classList.add('in'));
} else {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }
  }, { rootMargin: '0px 0px -12% 0px', threshold: 0.12 });
  reveals.forEach((n) => io.observe(n));
}

// ---------- scroll-linked effects ----------
function onScroll(y) {
  updateStory();
  if (reduced || !hero) return;
  const h = hero.offsetHeight;
  if (y > h * 1.2) return;
  for (const n of parallax) n.style.transform = `translate3d(0, ${y * parseFloat(n.dataset.speed)}px, 0)`;
  hero.style.setProperty('--fade', String(Math.max(0, 1 - y / (h * 0.75))));
}

// ---------- Lenis ----------
if (typeof window.Lenis === 'function' && !reduced && !touch) {
  const lenis = new window.Lenis({ lerp: 0.085, wheelMultiplier: 1, smoothWheel: true });
  window.lenis = lenis;
  lenis.on('scroll', ({ scroll }) => onScroll(scroll));
  const raf = (t) => { lenis.raf(t); requestAnimationFrame(raf); };
  requestAnimationFrame(raf);
} else {
  window.addEventListener('scroll', () => onScroll(window.scrollY), { passive: true });
}
onScroll(window.scrollY);

// ---------- one page per input ----------
const topbar = document.querySelector('.topbar');
const topH = () => (topbar ? topbar.offsetHeight : 64);
const setTopVar = () => document.documentElement.style.setProperty('--top', `${topH()}px`);
setTopVar();
window.addEventListener('resize', setTopVar);
const steps = [...document.querySelectorAll('.step')];
const dotsEl = document.getElementById('stepDots');
const stepTop = (el) => el.getBoundingClientRect().top + window.scrollY - topH();
// One timing for every page change: a gentle start and a soft landing.
const PAGE_SECONDS = 1.1;
const easeOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const goTo = (el, duration = PAGE_SECONDS) => {
  if (!el) return;
  if (window.lenis) window.lenis.scrollTo(el, { offset: -topH(), duration, easing: easeOut });
  else el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
};

steps.forEach((st, i) => {
  const input = st.querySelector('input:not([type=radio]), select');
  if (input && input.id) input.dataset.step = String(i);
  const d = document.createElement('button');
  d.type = 'button'; d.className = 'step-dot'; d.setAttribute('aria-label', `${st.dataset.label} (step ${i + 1})`);
  d.innerHTML = `<span>${st.dataset.label}</span>`;
  d.addEventListener('click', () => goTo(st));
  dotsEl?.appendChild(d);
});
const dots = dotsEl ? [...dotsEl.children] : [];

let current = 0;
let lastY = window.scrollY;
let dir = 1;
function updateActive(y) {
  if (y !== lastY) { dir = y > lastY ? 1 : -1; lastY = y; }
  if (!steps.length) return;
  const mid = y + topH() + window.innerHeight * 0.5;
  let idx = -1;
  steps.forEach((st, i) => { if (st.offsetTop <= mid) idx = i; });
  const inForm = idx >= 0 && mid < steps[steps.length - 1].offsetTop + steps[steps.length - 1].offsetHeight;
  dotsEl?.classList.toggle('show', inForm);
  if (idx !== current || !dots.some((d) => d.classList.contains('on'))) {
    current = Math.max(idx, 0);
    dots.forEach((d, i) => d.classList.toggle('on', i === current));
  }
}

// Every "page" in the scroll order, as scroll positions: intro, headline, each story picture, each question.
function pageStops() {
  const H = topH();
  const abs = (el) => el.getBoundingClientRect().top + window.scrollY - H;
  const stops = [];
  if (hero) stops.push(0);
  const head = document.querySelector('.how-head');
  if (head) stops.push(Math.max(0, abs(head)));
  if (story && storyItems.length) {
    const { total, top } = storyMetrics();
    storyItems.forEach((_, i) => stops.push(top + (total * (i + 0.5)) / storyItems.length));
  }
  steps.forEach((st) => stops.push(abs(st)));
  return stops.sort((x, y) => x - y);
}
const goY = (y, duration = PAGE_SECONDS) => {
  if (window.lenis) window.lenis.scrollTo(y, { duration, easing: easeOut });
  else window.scrollTo({ top: y, behavior: reduced ? 'auto' : 'smooth' });
};

// Snap to the nearest page when scrolling settles (keyboard, scrollbar drags).
let snapTimer = null;
function scheduleSnap() {
  if (reduced || touch || !steps.length) return;
  clearTimeout(snapTimer);
  snapTimer = setTimeout(() => {
    const y = window.scrollY;
    const tops = pageStops();
    const last = tops.length - 1;
    if (y > tops[last] + 4) return;                     // results and footer scroll freely
    let i = 0;
    while (i < last && tops[i + 1] <= y + 1) i++;
    if (i === last) return;
    const frac = (y - tops[i]) / (tops[i + 1] - tops[i]);
    const target = dir > 0 ? (frac > 0.1 ? i + 1 : i) : (frac < 0.9 ? i : i + 1);
    if (Math.abs(y - tops[target]) > 2) goY(tops[target], 0.8);
  }, 60);
}

// Wheel intent: one flick = one page, immediately (no waiting for the scroll to settle).
let wheelLock = 0;
let lastWheel = 0;
let lastDelta = 0;
if (!reduced && !touch && steps.length) {
  document.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.target.closest?.('[data-lenis-prevent]') || Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
    const now = performance.now();
    const gap = now - lastWheel;
    const delta = Math.abs(e.deltaY);
    const newGesture = gap > 90 || delta > lastDelta * 1.6;
    lastWheel = now; lastDelta = delta;
    const y = window.scrollY;
    const tops = pageStops();
    const last = tops.length - 1;
    if (y > tops[last] + 4) return;                     // below the last question: normal scrolling
    const down = e.deltaY > 0;
    let i = 0;
    while (i < last && tops[i + 1] <= y + 8) i++;
    const settled = Math.abs(y - tops[i]) < 8;
    if (!settled && now < wheelLock) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (down && i >= last && settled) return;           // leave the last question: normal scrolling
    if (!down && i <= 0 && settled) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (delta < 4 || now < wheelLock || !newGesture) return;
    const target = down ? i + 1 : (settled ? i - 1 : i);
    wheelLock = now + PAGE_SECONDS * 1000 + 150;
    goY(tops[Math.max(0, Math.min(last, target))]);
  }, { passive: false, capture: true });
}

window.addEventListener('scroll', () => { updateActive(window.scrollY); scheduleSnap(); }, { passive: true });
updateActive(window.scrollY);

// Enter moves to the next page (Autocomplete's Enter-to-select has already called preventDefault).
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.defaultPrevented) return;
  const t = e.target;
  const idx = t?.dataset?.step;
  if (idx === undefined || t.tagName === 'BUTTON') return;
  e.preventDefault();
  goTo(steps[Number(idx) + 1]);
});
// Picking an airport from the list moves on automatically.
document.addEventListener('chosen', (e) => {
  if (e.target?.dataset?.noAdvance) return;
  const idx = e.target?.dataset?.step;
  if (idx !== undefined) setTimeout(() => goTo(steps[Number(idx) + 1]), 350);
});
// Segmented choices (day/night, rules, wind source) are one click — move on after a beat.
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.type !== 'radio' || t.name === 'windSource' && t.value === 'manual') return;
  const st = t.closest('.step');
  if (st) setTimeout(() => goTo(steps[steps.indexOf(st) + 1]), 450);
});

// ---------- in-page anchors ----------
document.addEventListener('click', (ev) => {
  const a = ev.target.closest('[data-scroll-to]');
  if (!a) return;
  const target = document.querySelector(a.dataset.scrollTo);
  if (!target) return;
  ev.preventDefault();
  if (window.lenis) window.lenis.scrollTo(target, { offset: a.dataset.scrollTo === '#top' ? 0 : -64, duration: 1.6 });
  else target.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
});
