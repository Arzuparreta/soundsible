/*
 * Applied before first paint, so a stored theme never flashes the default one.
 * Inlined by the boot plugin with the palette table substituted in; it cannot
 * import, and must not throw on a browser that refuses localStorage.
 */
(function () {
  try {
    var themes = __THEMES__;
    var colors = __THEME_COLORS__;
    var stored = localStorage.getItem('theme');
    var preference = themes.indexOf(stored) === -1 ? 'system' : stored;
    var resolved =
      preference === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : preference;
    document.documentElement.dataset.theme = resolved;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', colors[resolved]);
  } catch (e) {}
})();
