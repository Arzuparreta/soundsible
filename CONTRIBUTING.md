## Contributing to Soundsible

Thanks for your interest in contributing – every bug report, idea, and pull request helps.

### Prerequisites

- **Python 3.10+**, **git**, **FFmpeg**
- **Node.js 20+** and **npm** — required to build or develop the SolidJS player in `ui_web/` (the production bundle in `ui_web/dist/` is not committed)

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

   **Launcher (browser control panel):**

   ```bash
   ./venv/bin/python start_launcher.py
   ```

   Open `http://localhost:5099` and click **Launch**. First-time setup only: `python3 run.py --setup`.

   **Terminal menu:**

   ```bash
   python3 run.py          # choose "Start Station Engine & Open Station"
   ```

   Player URLs: `http://localhost:5005/player/` (default) and `http://localhost:5005/player/desktop/` (desktop shell bootstrap).

### Frontend development

With the Station Engine running on port 5005:

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

1. Create a feature branch from **`dev`** (integration branch for ongoing work). Use **`main`** only if you are explicitly targeting a release/stable line.
2. Make small, focused changes.
3. Add or update tests when touching non‑trivial logic:
   - Python: `PYTHONPATH=. ./venv/bin/python -m pytest tests/ -q`
   - Frontend: `cd ui_web && npm test`
4. Run the app locally to verify core flows (launch, play music, basic navigation).
5. Open a PR against **`dev`** by default, with a clear description of what you changed and why. Open against **`main`** when that matches maintainer guidance (e.g. hotfixes or release process).

### Code style

- Prefer modern Python (3.10+) idioms.
- Use descriptive names and keep functions focused.
- Match the existing style of the files you touch.
