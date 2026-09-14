#!/usr/bin/env python
"""APK Hub ingestion interface.

Copies an APK into the hub, records metadata in public/apks/manifest.json and
(optionally) commits / pushes so Vercel redeploys.

  python tools/add_apk.py --apk D:/x/build/app.apk --id my-game --name "我的游戏" \
      --version 1.0.0 --desc "一句话介绍" --abi arm64-v8a --engine "Godot 4.7.2" \
      --tags puzzle,offline --extra "模拟器 x86_64=D:/x/build/app-x86.apk" \
      [--commit] [--push] [--message "commit msg"]
"""
import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APKS = ROOT / "public" / "apks"
MANIFEST = APKS / "manifest.json"


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_manifest() -> dict:
    if MANIFEST.exists():
        return json.loads(MANIFEST.read_text(encoding="utf-8"))
    return {"site": "APK Hub", "updated": "", "apps": []}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apk", required=True)
    ap.add_argument("--id", default="")
    ap.add_argument("--name", default="")
    ap.add_argument("--version", default="0.0.0")
    ap.add_argument("--desc", default="")
    ap.add_argument("--abi", default="")
    ap.add_argument("--engine", default="")
    ap.add_argument("--min-sdk", default="")
    ap.add_argument("--tags", default="")
    ap.add_argument("--extra", action="append", default=[],
                    help="label=path, repeatable")
    ap.add_argument("--commit", action="store_true")
    ap.add_argument("--push", action="store_true")
    ap.add_argument("--message", default="")
    a = ap.parse_args()

    src = Path(a.apk).expanduser().resolve()
    if not src.exists():
        print("ERROR: apk not found: %s" % src)
        return 1
    app_id = a.id or src.stem.lower().replace(" ", "-")
    dest_dir = APKS / app_id
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / src.name
    shutil.copyfile(src, dest)

    extras = []
    for item in a.extra:
        if "=" not in item:
            continue
        label, p = item.split("=", 1)
        ps = Path(p).expanduser().resolve()
        if not ps.exists():
            print("WARN: extra missing, skipped: %s" % ps)
            continue
        ed = dest_dir / ps.name
        shutil.copyfile(ps, ed)
        extras.append({"label": label, "file": "apks/%s/%s" % (app_id, ps.name),
                       "size": ps.stat().st_size})

    entry = {
        "id": app_id,
        "name": a.name or src.stem,
        "version": a.version,
        "abi": a.abi,
        "engine": a.engine,
        "min_sdk": a.min_sdk,
        "desc": a.desc,
        "tags": [t for t in a.tags.split(",") if t],
        "file": "apks/%s/%s" % (app_id, src.name),
        "size": src.stat().st_size,
        "sha256": sha256(dest),
        "added": date.today().isoformat(),
        "extra_files": extras,
    }
    m = load_manifest()
    apps = [x for x in m.get("apps", []) if x.get("id") != app_id]
    apps.append(entry)
    m["apps"] = apps
    m["updated"] = date.today().isoformat()
    MANIFEST.write_text(json.dumps(m, ensure_ascii=False, indent=2), encoding="utf-8")
    print("ADDED %s -> %s (%d bytes)" % (app_id, entry["file"], entry["size"]))
    print("  sha256 %s" % entry["sha256"])

    if a.commit or a.push:
        msg = a.message or "apk: add/update %s v%s" % (app_id, a.version)
        cmd = [sys.executable, str(ROOT / "tools" / "add_apk.py"), "--help"]
        del cmd
        sub = ROOT / "scripts" / "publish.sh"
        r = subprocess.run(["bash", str(sub), msg] if a.push else
                           ["bash", str(sub), msg, "--commit-only"], cwd=str(ROOT))
        return r.returncode
    return 0


if __name__ == "__main__":
    sys.exit(main())
