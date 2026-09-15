/**
 * The Tauri bridge the shell UI talks to, faked in the page.
 *
 * Shared by the browser specs because both need the same four commands to get
 * the first-run view on screen at all; `overrides` is for the one command a
 * given test actually cares about.
 */
export async function mockTauri(page, overrides = {}) {
  await page.addInitScript((responses) => {
    let callbackId = 0;
    const callbacks = new Map();
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: (_event, id) => callbacks.delete(id),
    };
    window.__TAURI_INTERNALS__ = {
      transformCallback(callback) {
        callbackId += 1;
        callbacks.set(callbackId, callback);
        return callbackId;
      },
      unregisterCallback(id) {
        callbacks.delete(id);
      },
      runCallback(id, payload) {
        callbacks.get(id)?.(payload);
      },
      async invoke(command) {
        if (command in responses) return responses[command];
        if (command === 'plugin:event|listen') return callbackId;
        if (command === 'get_engine_status') {
          return { phase: 'idle', log_lines: [] };
        }
        if (command === 'get_autostart') return false;
        if (command === 'get_shell_theme') return 'dark';
        if (command === 'get_startup_profile') {
          return {
            returning_user: false,
            music_dir: null,
            auto_start: false,
            configured_but_missing: false,
          };
        }
        if (command === 'plugin:dialog|open') return window.__dialogResult ?? null;
        if (command === 'preview_music_folder') {
          return {
            path: window.__dialogResult,
            track_count: 12,
            size_bytes: 1_572_864,
            scan_ms: 150,
            inaccessible_entries: 0,
            writable: true,
          };
        }
        if (command === 'start_engine_with_path') return null;
        if (command === 'set_autostart') return null;
        if (command === 'log_shell_event') return null;
        return null;
      },
    };
  }, overrides);
}
