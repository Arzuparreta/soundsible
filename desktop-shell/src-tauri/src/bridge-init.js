(() => {
  if (window.top !== window || location.origin !== __ORIGIN__) return;
  const generation = __GENERATION__;
  const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, { generation, ...args });
  Object.defineProperty(window, '__SOUNDSIBLE_DESKTOP__', {
    value: Object.freeze({
      handshake: () => invoke('desktop_handshake', {}),
      appearance: (theme, colors) => invoke('desktop_appearance', { theme, colors }),
      // Native media state and actions served only the Linux app's MPRIS
      // service. Players of older stations still publish and register (one
      // publishes on dispose without asking first), so both stay as no-ops.
      publish: () => Promise.resolve(),
      onAction: () => () => {},
    }),
  });
})();
