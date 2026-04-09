(function () {
  'use strict';

  var STORAGE_KEY = 'launcher_lang';
  var HTML_KEYS = ['setup.success.text'];

  function getLang() {
    return localStorage.getItem(STORAGE_KEY) || 'en';
  }

  function setLang(code) {
    localStorage.setItem(STORAGE_KEY, code);
  }

  function t(key, params) {
    var T = window.TRANSLATIONS;
    if (!T) return key;
    var lang = getLang();
    var str = (T[lang] && T[lang][key]) || (T.en && T.en[key]) || key;
    if (params && typeof str === 'string') {
      Object.keys(params).forEach(function (k) {
        str = str.replace(new RegExp('{{' + k + '}}', 'g'), String(params[k]));
      });
    }
    return str;
  }

  function applyTranslations() {
    var lang = getLang();
    document.documentElement.lang = lang === 'zh' ? 'zh-Hans' : lang;

    var isSetup = window.location.pathname === '/setup' || window.location.pathname.indexOf('/setup') === 0;
    document.title = t(isSetup ? 'setup.pageTitle' : 'index.pageTitle');

    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      var key = el.getAttribute('data-i18n');
      if (!key) return;
      var value = t(key);
      if (HTML_KEYS.indexOf(key) !== -1) {
        el.innerHTML = value;
      } else {
        el.textContent = value;
      }
    });

    document.querySelectorAll('[data-i18n-ph]').forEach(function (el) {
      var key = el.getAttribute('data-i18n-ph');
      if (key) el.placeholder = t(key);
    });

    updateSelectorLabel();
    window.dispatchEvent(new CustomEvent('launcher-lang-changed'));
  }

  function createSelector() {
    var container = document.createElement('div');
    container.id = 'launcher-lang-picker';
    container.setAttribute('aria-label', 'Language');
    container.style.cssText = 'position:fixed;top:12px;right:12px;z-index:9999;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px;';

    var button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-haspopup', 'true');
    button.setAttribute('aria-expanded', 'false');
    button.style.cssText = 'display:flex;align-items:center;gap:6px;padding:8px 12px;min-height:36px;background:rgba(0,0,0,0.25);border:1px solid rgba(255,255,255,0.08);border-radius:12px;color:#f5f5f7;cursor:pointer;';
    button.innerHTML = '<span aria-hidden="true" style="font-size:1.1em;">🌐</span><span id="launcher-lang-label">EN</span><span aria-hidden="true">▾</span>';

    var dropdown = document.createElement('div');
    dropdown.id = 'launcher-lang-dropdown';
    dropdown.style.cssText = 'display:none;position:absolute;top:100%;right:0;margin-top:6px;min-width:140px;background:rgba(28,28,30,0.98);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,0.12);border-radius:12px;padding:6px;box-shadow:0 8px 24px rgba(0,0,0,0.5);color:#f5f5f7;';

    ['en', 'es', 'fr', 'zh'].forEach(function (code) {
      var opt = document.createElement('button');
      opt.type = 'button';
      opt.dataset.lang = code;
      opt.style.cssText = 'display:block;width:100%;text-align:left;padding:10px 12px;border:none;border-radius:8px;background:transparent;color:#f5f5f7;cursor:pointer;font-size:14px;';
      opt.addEventListener('mouseenter', function () { this.style.background = 'rgba(255,255,255,0.1)'; });
      opt.addEventListener('mouseleave', function () { this.style.background = 'transparent'; });
      opt.textContent = t('lang.' + code);
      opt.addEventListener('click', function () {
        setLang(code);
        applyTranslations();
        dropdown.style.display = 'none';
        button.setAttribute('aria-expanded', 'false');
      });
      dropdown.appendChild(opt);
    });

    function updateLabel() {
      var code = getLang();
      var labels = { en: 'EN', es: 'ES', fr: 'FR', zh: '中文' };
      var labelEl = document.getElementById('launcher-lang-label');
      if (labelEl) labelEl.textContent = labels[code] || code;
    }

    function updateDropdownLabels() {
      dropdown.querySelectorAll('[data-lang]').forEach(function (opt) {
        opt.textContent = t('lang.' + opt.dataset.lang);
      });
    }

    window.updateSelectorLabel = function () {
      updateLabel();
      updateDropdownLabels();
    };

    button.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = dropdown.style.display === 'block';
      dropdown.style.display = open ? 'none' : 'block';
      button.setAttribute('aria-expanded', open ? 'false' : 'true');
    });

    dropdown.addEventListener('click', function (e) { e.stopPropagation(); });

    document.addEventListener('click', function () {
      dropdown.style.display = 'none';
      button.setAttribute('aria-expanded', 'false');
    });

    container.appendChild(button);
    container.appendChild(dropdown);
    document.body.appendChild(container);
    updateLabel();
  }

  window.I18n = {
    t: t,
    getLang: getLang,
    setLang: setLang,
    applyTranslations: applyTranslations
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      createSelector();
      applyTranslations();
    });
  } else {
    createSelector();
    applyTranslations();
  }
})();
