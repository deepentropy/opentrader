#!/usr/bin/env python3
"""Build the plugin packages (zips) into dist/.

  python build.py dev       dist/<id>-dev.zip: the development manifest only. Install it once, then run plugin.py.
  python build.py release   dist/<id>-<version>.zip: plugin.py built into one executable (PyInstaller) with the
                            manifest. Publish this zip in your repository's releases.

PyInstaller is needed for `release` only: `python -m pip install pyinstaller`. It builds for the system it runs on,
so build the Windows package on Windows, the macOS one on macOS, and so on.
"""
import hashlib
import json
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
DIST = HERE / "dist"


def manifest(name):
    return json.loads((HERE / name).read_text(encoding="utf-8"))


def write_zip(path, files):
    """`files`: (name in the zip, bytes or a file path)."""
    DIST.mkdir(exist_ok=True)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in files:
            if isinstance(data, Path):
                z.write(data, name)
            else:
                z.writestr(name, data)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    print(f"{path.relative_to(HERE)}  sha256 {digest}")


def dev():
    m = manifest("opentrader-plugin.dev.json")
    write_zip(DIST / f"{m['id']}-dev.zip", [("opentrader-plugin.json", json.dumps(m, indent=2))])


def release():
    m = manifest("opentrader-plugin.json")
    entry = m["runtime"]["entry"]  # e.g. bin/template-plugin.exe
    name = Path(entry).stem
    work = HERE / "build"
    subprocess.run(
        [sys.executable, "-m", "PyInstaller", "--onefile", "--clean", "--name", name,
         "--distpath", str(work / "bin"), "--workpath", str(work / "tmp"), "--specpath", str(work), str(HERE / "plugin.py")],
        check=True,
    )
    exe = work / "bin" / Path(entry).name
    if not exe.exists():
        sys.exit(f"{exe} was not built: does the manifest's entry match this system ({sys.platform})?")
    write_zip(DIST / f"{m['id']}-{m['version']}.zip", [("opentrader-plugin.json", json.dumps(m, indent=2)), (entry, exe)])
    shutil.rmtree(work / "tmp", ignore_errors=True)


if __name__ == "__main__":
    {"dev": dev, "release": release}.get(sys.argv[1] if len(sys.argv) > 1 else "", lambda: sys.exit(__doc__))()
