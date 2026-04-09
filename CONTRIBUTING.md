## Contributing to Soundsible

Thanks for your interest in contributing – every bug report, idea, and pull request helps.

### How to get started

1. **Fork and clone**

   ```bash
   git clone https://github.com/Arzuparreta/Arzuparreta.git
   cd Arzuparreta/projects/repos/soundsible
   ```

2. **Create a virtual environment and install dependencies**

   ```bash
   python3 -m venv venv
   ./venv/bin/pip install -r requirements.txt
   ```

3. **Run the app in development**

   The easiest way is to use the launcher:

   ```bash
   ./venv/bin/python start_launcher.py
   ```

   Then open `http://localhost:5099` and click **Launch Ecosystem**.

### Reporting bugs & requesting features

- Use the GitHub issue tracker.
- When reporting a bug, include:
  - OS, Python version.
  - How you installed and started Soundsible.
  - What you expected vs what happened.
  - Any relevant logs or stack traces.

### Submitting pull requests

1. Create a feature branch from `main`.
2. Make small, focused changes.
3. Add or update tests when touching non‑trivial logic.
4. Run the app locally to verify core flows (launch, play music, basic navigation).
5. Open a PR against `main` with a clear description of what you changed and why.

### Code style

- Prefer modern Python (3.10+) idioms.
- Use descriptive names and keep functions focused.
- Match the existing style of the files you touch.

