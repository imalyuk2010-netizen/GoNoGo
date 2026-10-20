// pwa.js — registers the service worker (install-to-home-screen + offline app shell).
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* app works fine without it */ });
  });
}
