(() => {
  if (window.top !== window || location.origin !== __ORIGIN__) return;
  const generation = __GENERATION__;
  let listener = null;
  const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, { generation, ...args });
  Object.defineProperty(window, '__SOUNDSIBLE_DESKTOP__', {
    value: Object.freeze({
      handshake: () => invoke('desktop_handshake', {}),
      publish: state => invoke('desktop_snapshot', { stateValue: state }),
      appearance: (theme, colors) => invoke('desktop_appearance', { theme, colors }),
      onAction: handler => { listener = handler; return () => { if (listener === handler) listener = null; }; },
      receive: (id, action) => { if (id === generation) listener?.(action); },
    }),
  });
})();
