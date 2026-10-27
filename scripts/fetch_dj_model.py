"""Download and verify the DJ beat model into `models/`, for images, desktop builds and CI.

The URL, size and SHA-256 are read from `shared/dj/weights.py` without
importing the engine, so a Docker build stage or a bare CI step can run it.
An existing file that already matches is kept.

    python scripts/fetch_dj_model.py [--output PATH]
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def constants() -> dict[str, object]:
    tree = ast.parse((ROOT / "shared" / "dj" / "weights.py").read_text(encoding="utf-8"))
    values: dict[str, object] = {}
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            name = node.targets[0].id
            if name in {"MODEL_FILE", "MODEL_SHA256", "MODEL_BYTES", "MODEL_TAG", "MODEL_RELEASES"}:
                values[name] = ast.literal_eval(node.value)
    values["MODEL_URL"] = f"{values['MODEL_RELEASES']}/{values['MODEL_TAG']}/{values['MODEL_FILE']}"
    return values


def matches(path: Path, sha256: str, size: int) -> bool:
    if not path.is_file() or path.stat().st_size != size:
        return False
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest() == sha256


def main() -> int:
    values = constants()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "models" / str(values["MODEL_FILE"]))
    args = parser.parse_args()
    sha256, size, url = str(values["MODEL_SHA256"]), int(values["MODEL_BYTES"]), str(values["MODEL_URL"])
    if matches(args.output, sha256, size):
        print(f"DJ beat model already present: {args.output}")
        return 0
    args.output.parent.mkdir(parents=True, exist_ok=True)
    partial = args.output.with_suffix(".part")
    for attempt in range(1, 6):
        try:
            with urllib.request.urlopen(url, timeout=60) as response, partial.open("wb") as stream:
                while block := response.read(1 << 20):
                    stream.write(block)
            break
        except OSError as exc:
            print(f"Download attempt {attempt} failed: {exc}", file=sys.stderr)
            if attempt == 5:
                partial.unlink(missing_ok=True)
                return 1
            time.sleep(5 * attempt)
    if not matches(partial, sha256, size):
        partial.unlink(missing_ok=True)
        print(f"{url} does not match SHA-256 {sha256}", file=sys.stderr)
        return 1
    partial.replace(args.output)
    print(f"DJ beat model verified: {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
