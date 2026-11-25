/* Applied before first paint. The palette generator is shared with the app. */
(function () {
  __CUSTOM_COLORS__
  var themes = __THEMES__;
  var colors = __THEME_COLORS__;
  var stored;
  try { stored = localStorage.getItem('theme'); } catch (e) {}
  var preference = themes.indexOf(stored) === -1 ? 'system' : stored;
  var palette = preference === 'custom' ? deriveCustomColors(readCustomColors()) : null;
  var resolved = palette ? palette.scheme : preference === 'system'
    ? (typeof window.matchMedia !== 'function' || window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : preference;
  stampCustomColors(palette);
  document.documentElement.dataset.theme = resolved;
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', palette ? palette.tokens['bg-base'] : colors[resolved]);
})();
