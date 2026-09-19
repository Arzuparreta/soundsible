## Contributing to Soundsible

Thanks for your interest in contributing – every bug report, idea, and pull request helps.

### Prerequisites

- **Python 3.10+**, **git**, **FFmpeg**
- **Node.js 22+** and **npm** — required to build or develop the SolidJS player in `ui_web/` (the production bundle in `ui_web/dist/` is not committed)

### How to get started

1. **Fork and clone**

   ```bash
   git clone https://github.com/Arzuparreta/soundsible.git
   cd soundsible
   ```

2. **Python environment**

   Either let `run.py` bootstrap the venv on first launch, or create it manually:

   ```bash
   python3 -m venv venv
   ./venv/bin/pip install -r requirements.txt
   ```

3. **Web player deps** (one-time). The engine rebuilds `ui_web/dist` automatically when sources change.

   ```bash
   cd ui_web && npm ci && cd ..
   ```

   Or build explicitly: `python3 scripts/ensure_ui_dist.py --force`
4. **Run tests**

   ```bash
   PYTHONPATH=. ./venv/bin/python -m pytest tests/ -q
   ```

   Frontend unit tests:

   ```bash
   cd ui_web && npm test
   ```

5. **Run the app in development**

   Configure it once with `python3 run.py --setup`
   (`http://localhost:5099/setup`), then run the engine in the foreground so
   its log stays in front of you:

   ```bash
   python3 run.py --daemon    # Ctrl+C stops it
   ```

   The terminal menu (`python3 run.py`) and the browser launcher
   (`./venv/bin/python start_launcher.py`, then **Launch** on
   `http://localhost:5099`) start the same engine. Every way of running it is
   listed in [Install → Ways to run it](docs/INSTALL.md#ways-to-run-it).

   Player URLs: `http://localhost:5005/player/` (default) and `http://localhost:5005/player/desktop/` (desktop shell bootstrap).

   If your own instance already listens on port 5005, run the development
   engine on another port with separate directories: pass `--port 5006` and
   `--config-dir`, `--data-dir` and `--cache-dir` to both `--setup` and
   `--daemon`. Create those directories first: one that does not exist yet
   is filled with a copy of your own `~/.config/soundsible`,
   `~/.local/share/soundsible` or `~/.cache/soundsible`. The Vite dev server
   below always proxies to port 5005.

### Frontend development

With the Station Engine running on port 5005 (`python3 run.py --daemon`):

```bash
cd ui_web
npm install    # or npm ci
npm run dev
```

Open `http://localhost:5173/player/` — Vite proxies `/api` and `/socket.io` to the engine. See [ui_web/README.md](ui_web/README.md) for build and verification details.

### Reporting bugs & requesting features

- Use the GitHub issue tracker.
- When reporting a bug, include:
  - OS, Python version, Node.js version (if frontend-related).
  - How you installed and started Soundsible.
  - What you expected vs what happened.
  - Any relevant logs or stack traces.

### Submitting pull requests

1. Create a feature branch from **`main`**. Everything lands on `main` through a pull request — nothing is committed to it directly.
2. Make small, focused changes.
3. Add or update tests when touching non‑trivial logic:
   - Python: `PYTHONPATH=. ./venv/bin/python -m pytest tests/ -q`
   - Frontend: `cd ui_web && npm test`
4. Run the app locally to verify core flows (launch, play music, basic navigation).
5. Open a PR against **`main`**, with a clear description of what you changed and why. CI runs on the pull request, so let the checks finish before asking for a review.
6. Every pull request carries exactly one impact label, which decides the next version number: `impact:major` (upgrading needs manual action), `impact:minor` (new capability), `impact:patch` (a fix) or `impact:none` (nothing a user could observe). CI fails without one. If you cannot set labels on the repository, say in the description which one fits. See [Releasing](docs/RELEASING.md).

### Code style

- Prefer modern Python (3.10+) idioms.
- Use descriptive names and keep functions focused.
- Match the existing style of the files you touch.
