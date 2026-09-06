/* Runs before any module. Keep the four short launch messages here so opening
 * the app never depends on loading a translation dictionary. Uses the same
 * stored `lang` preference and English fallback as lib/i18n. */
(function () {
  var messages = {
    en: ['Loading Soundsible…', 'This is taking longer than usual.', 'Soundsible could not load.', 'Reload'],
    es: ['Cargando Soundsible…', 'Está tardando más de lo habitual.', 'No se ha podido cargar Soundsible.', 'Recargar'],
    fr: ['Chargement de Soundsible…', 'Cela prend plus de temps que prévu.', 'Impossible de charger Soundsible.', 'Recharger'],
    zh: ['正在加载 Soundsible…', '加载时间比平时更长。', '无法加载 Soundsible。', '重新加载'],
  };
  var lang = 'en';
  try {
    var stored = localStorage.getItem('lang');
    if (Object.prototype.hasOwnProperty.call(messages, stored)) lang = stored;
  } catch (_) {}
  document.documentElement.lang = lang;
  var copy = messages[lang];
  var pendingStyles = __BOOT_STYLE_COUNT__;
  var resolveStyles;
  var stylesReady = new Promise(function (resolve) { resolveStyles = resolve; });
  if (!pendingStyles) resolveStyles();
  var phase = 'loading';
  var slowTimer;
  var screen;
  var reload;

  function update() {
    if (!screen) return;
    screen.dataset.state = phase;
    document.getElementById('startup-message').textContent = copy[phase === 'error' ? 2 : phase === 'slow' ? 1 : 0];
    reload.textContent = copy[3];
    reload.hidden = phase === 'loading';
  }

  function fail() {
    if (phase === 'done') return;
    phase = 'error';
    clearTimeout(slowTimer);
    update();
  }

  function startupError(event) {
    // Failed module graphs and uncaught startup exceptions are fatal. An icon,
    // font, or cover failing to load does not prevent the application opening.
    if (event.target instanceof HTMLScriptElement || event.error) fail();
  }
  window.addEventListener('error', startupError, true);

  window.__SOUNDSIBLE_BOOT__ = {
    stylesReady: stylesReady,
    styleLoaded: function (link) {
      if (link.dataset.bootLoaded) return;
      link.dataset.bootLoaded = 'true';
      link.media = 'all';
      if (--pendingStyles === 0) resolveStyles();
    },
    fail: fail,
    start: function () {
      screen = document.getElementById('startup-screen');
      reload = document.getElementById('startup-reload');
      reload.addEventListener('click', function () { window.location.reload(); });
      update();
      if (phase === 'loading') slowTimer = setTimeout(function () {
        phase = 'slow';
        update();
      }, 15000);
    },
    complete: function () {
      if (phase === 'done' || phase === 'error' || pendingStyles) return;
      phase = 'done';
      clearTimeout(slowTimer);
      window.removeEventListener('error', startupError, true);
      // The Solid subtree has mounted. Reveal its first styled frame before
      // retiring the independent HTML surface; never impose a minimum wait.
      requestAnimationFrame(function () {
        document.documentElement.removeAttribute('data-booting');
        document.getElementById('app').removeAttribute('inert');
        screen.setAttribute('aria-hidden', 'true');
        screen.setAttribute('inert', '');
        screen.classList.add('startup-leaving');
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) screen.remove();
        else setTimeout(function () { screen.remove(); }, 180);
      });
    },
  };
})();
