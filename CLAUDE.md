# Soundsible — Agent Notes

## Design System

Always read `DESIGN.md` before making any visual or UI decisions.

All font choices, colors, spacing, and aesthetic direction for the **Tauri consumer shell** (first-run, engine status, tray) are defined there. The existing webview player has its own tokens in `ui_web/css/` — shell must hand off cleanly (same `#0d0d0f` bg, `#f97a12` accent).

Do not deviate from `DESIGN.md` without explicit user approval.

In QA mode, flag any shell code that doesn't match `DESIGN.md`.

## Consumer Shell Scope

Per approved plan D-UX-4: `DESIGN.md` covers the consumer shell chapter only. Full player reskin is out of scope. Implementation tasks: DT2 (first-run UI), DT3 (tray), DT4 (beta banner), DT5 (accessibility).

## Desktop beta program

**Current initiative:** Consumer democratization (install → folder → play). Status and VM gates: `docs/DESKTOP_BETA.md`. Planning source of truth: `docs/appliance-rework-plan.md` + approved gstack design `arsu-main-design-20260519-012217.md`.

**Do not** expand scope into premium discovery, player reskin, or macOS until Gate A1 (clean VM ≤10 min) is green unless the user explicitly redirects.

## Shell JS: plain `<script>` rules

Shell UI loads as vanilla `<script src="...">` (no bundler, no `type="module"`).
- `return` at the top level of a non-module script is a **SyntaxError** — V8/WebView2 refuses to parse the file. No code runs, no event listeners attach. Use block-scoped guards (`if (!x) { ... }`) or IIFEs instead.
- `window.__TAURI__` is injected by the Tauri runtime when `withGlobalTauri: true` (set in tauri.conf.json). Always verify it exists before destructuring.

## Windows + Tauri dialog threading (COM STA)

On Windows the native folder/file dialog is `IFileOpenDialog`, a COM component. **COM UI components require the calling thread to be a COM STA thread.**
- Tauri v2 `async fn` commands run on the **tokio thread pool** — NOT COM STA.
- Tauri v2 `fn` (sync) commands run on the **blocking thread pool** — also NOT COM STA.
- Only the **main event-loop thread** is COM STA.
- `blocking_pick_folder()` calls `rfd` directly on the invoking thread. If that thread is not COM STA → COM call silently fails → `None` returned, no dialog shown.
- `pick_folder(callback)` internally uses `run_on_main_thread` to dispatch to the main (COM STA) thread. **Always use `pick_folder(callback)` on Windows**, bridged via `std::sync::mpsc` + `tauri::async_runtime::spawn_blocking` if calling from an async command.
- Calling `plugin:dialog|open` from JS (the official plugin IPC) also works — but args must be wrapped: `invoke('plugin:dialog|open', { options: { directory: true, ... } })` matching the Rust signature `async fn open(options: OpenDialogOptions)`.
