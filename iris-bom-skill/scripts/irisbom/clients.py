"""Optional client-folder matching against folders that already exist on the
user's own disk (--client-root). Nothing about any client is built in."""

from __future__ import annotations

import re
from difflib import SequenceMatcher
from pathlib import Path
from typing import Iterable

# Generic words ignored when comparing names, so "Springfield Public Schools"
# can match an existing "Springfield" folder.
_STOP = frozenset(
    {"a", "and", "comm", "community", "district", "local", "of", "ps", "public",
     "school", "schools", "the", "township", "inc", "llc", "corp", "company", "co"}
)


def existing_folders(client_root: Path) -> list[str]:
    root = Path(client_root).expanduser()
    if not root.is_dir():
        return []
    return sorted(p.name for p in root.iterdir() if p.is_dir() and not p.name.startswith("."))


def resolve(requested: str, names: Iterable[str]) -> str:
    wanted = (requested or "").strip()
    names = [n for n in names if n]
    if not wanted or not names:
        return wanted
    for name in names:
        if name.casefold() == wanted.casefold():
            return name
    want_norm = _normalize(wanted)
    for name in names:
        if _normalize(name) == want_norm:
            return name
    want = _tokens(wanted)
    scored = []
    for name in names:
        have = _tokens(name)
        if want and have and (want <= have or have <= want):
            scored.append((len(want ^ have), len(name), name))
    if scored:
        return sorted(scored)[0][2]
    core = " ".join(t for t in want_norm.split() if t not in _STOP)
    if len(core) >= 8:
        hits = []
        for name in names:
            have = " ".join(t for t in _normalize(name).split() if t not in _STOP)
            if len(have) >= 8 and SequenceMatcher(a=core, b=have).ratio() >= 0.88:
                hits.append(name)
        if len(hits) == 1:
            return hits[0]
    return wanted


def safe_folder_name(name: str) -> str:
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', " ", name).strip().rstrip(".")
    return re.sub(r"\s+", " ", cleaned) or "Untitled"


def _normalize(name: str) -> str:
    text = name.strip().casefold().replace("&", " and ")
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _tokens(name: str) -> set[str]:
    return {t for t in _normalize(name).split() if t not in _STOP}
