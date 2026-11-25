"""Preflight: refuse to run unless Intangi Iris is installed on this computer.

The tool has no catalog of its own. It needs the Iris desktop app and the
catalog cache that Iris downloads for the signed-in user. If either is
missing, nothing else runs.
"""

from __future__ import annotations

import os
import platform
import plistlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

EXPECTED_BUNDLE_ID = "com.intangi.iris"

MISSING_MESSAGE = (
    "Intangi Iris is not installed on this computer (or its local catalog has "
    "not been downloaded yet). This tool only works with a local Iris install: "
    "install Iris, sign in once so it downloads your catalogs, then run again."
)


@dataclass
class Preflight:
    ok: bool
    system: str
    app_path: Optional[Path] = None
    cache_path: Optional[Path] = None
    bundle_id: str = ""
    problems: list[str] = field(default_factory=list)
    details: list[str] = field(default_factory=list)

    def report(self) -> str:
        lines = [f"Iris preflight: {'OK' if self.ok else 'FAILED'} ({self.system})"]
        if self.app_path:
            lines.append(f"  app:   {self.app_path}" + (f" [{self.bundle_id}]" if self.bundle_id else ""))
        if self.cache_path:
            lines.append(f"  cache: {self.cache_path}")
        lines += [f"  - {d}" for d in self.details]
        lines += [f"  ! {p}" for p in self.problems]
        if not self.ok:
            lines.append(MISSING_MESSAGE)
        return "\n".join(lines)


def _home() -> Path:
    return Path(os.path.expanduser("~"))


def mac_app_candidates() -> list[Path]:
    return [Path("/Applications/Iris.app"), _home() / "Applications" / "Iris.app"]


def mac_cache_candidates() -> list[Path]:
    return [_home() / "Library" / "Application Support" / "Intangi" / "cache"]


def windows_app_candidates() -> list[Path]:
    roots = []
    for var in ("ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"):
        if os.environ.get(var):
            roots.append(Path(os.environ[var]) / "Intangi")
    if os.environ.get("LOCALAPPDATA"):
        roots.append(Path(os.environ["LOCALAPPDATA"]) / "Programs" / "Intangi")
        roots.append(Path(os.environ["LOCALAPPDATA"]) / "Intangi")
    if os.environ.get("APPDATA"):
        roots.append(Path(os.environ["APPDATA"]) / "Intangi")
    return roots


def windows_cache_candidates() -> list[Path]:
    out = []
    for var in ("APPDATA", "LOCALAPPDATA", "ProgramData"):
        if os.environ.get(var):
            out.append(Path(os.environ[var]) / "Intangi" / "cache")
    return out


def check_mac_app(app: Path, result: Preflight) -> bool:
    plist = app / "Contents" / "Info.plist"
    if not plist.is_file():
        result.problems.append(f"{app} has no Contents/Info.plist")
        return False
    try:
        with plist.open("rb") as fh:
            info = plistlib.load(fh)
    except Exception as exc:  # noqa: BLE001 - report any plist error
        result.problems.append(f"could not read {plist}: {exc}")
        return False
    bundle = str(info.get("CFBundleIdentifier") or "")
    result.bundle_id = bundle
    if bundle.lower() != EXPECTED_BUNDLE_ID:
        result.problems.append(
            f"{app} has bundle id {bundle!r}, expected {EXPECTED_BUNDLE_ID!r}"
        )
        return False
    version = info.get("CFBundleShortVersionString") or info.get("CFBundleVersion")
    if version:
        result.details.append(f"Iris version {version}")
    return True


def check_windows_app(root: Path, result: Preflight) -> Optional[Path]:
    if root.is_file() and root.suffix.lower() == ".exe" and "iris" in root.name.lower():
        return root
    if not root.is_dir():
        return None
    for exe in root.rglob("*.exe"):
        if "iris" in exe.name.lower():
            return exe
    return None


def check_cache(cache: Path, result: Preflight) -> bool:
    if not cache.is_dir():
        result.problems.append(f"catalog cache not found at {cache}")
        return False
    prodlists = sorted((cache / "misc").glob("prodlist_*.mod"))
    parts = sorted((cache / "part").glob("part_*.mod"))
    models = (cache / "prod").is_dir()
    ok = True
    if not prodlists:
        result.problems.append(f"no misc/prodlist_*.mod in {cache} (open Iris once to download catalogs)")
        ok = False
    if not parts:
        result.problems.append(f"no part/part_*.mod in {cache} (open Iris once to download catalogs)")
        ok = False
    if ok:
        result.details.append(
            f"{len(prodlists)} product list file(s), {len(parts)} part file(s), "
            f"product models {'present' if models else 'missing (needed only for --isf)'}"
        )
    return ok


def run(
    *,
    app_override: Optional[str] = None,
    cache_override: Optional[str] = None,
    system: Optional[str] = None,
) -> Preflight:
    """Detect Iris. Overrides are for non-default install locations and are
    validated exactly like the default locations."""
    system = system or platform.system()
    result = Preflight(ok=False, system=system)

    app_ok = False
    if system == "Darwin":
        candidates = [Path(app_override).expanduser()] if app_override else mac_app_candidates()
        for app in candidates:
            if app.exists():
                result.app_path = app
                app_ok = check_mac_app(app, result)
                if app_ok:
                    break
        caches = [Path(cache_override).expanduser()] if cache_override else mac_cache_candidates()
    elif system == "Windows":
        candidates = [Path(app_override).expanduser()] if app_override else windows_app_candidates()
        for root in candidates:
            exe = check_windows_app(root, result)
            if exe:
                result.app_path = exe
                app_ok = True
                break
        caches = [Path(cache_override).expanduser()] if cache_override else windows_cache_candidates()
    else:
        result.problems.append(
            f"Iris is a macOS/Windows desktop app; no supported install can exist on {system}"
        )
        return result

    if not app_ok:
        if result.app_path is None:
            result.problems.append("Iris application not found in the standard install locations")
        return result

    cache_ok = False
    for cache in caches:
        if cache.exists():
            result.cache_path = cache
            cache_ok = check_cache(cache, result)
            if cache_ok:
                break
    if result.cache_path is None:
        result.problems.append("Iris catalog cache folder not found")
    result.ok = app_ok and cache_ok
    return result
