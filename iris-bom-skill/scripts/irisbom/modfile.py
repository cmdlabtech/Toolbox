"""Read Intangi wrapper files (catalog .mod files and .isf projects).

Both use the same layout: a short XML-ish header, a zlib stream, then a
closing </INTANGI_FILE_EX> tag. This module also enforces the safety rule
that the tool never opens account, deployment, price-list, or saved-project
files inside the Iris cache.
"""

from __future__ import annotations

import re
import zlib
from pathlib import Path
from typing import Iterable, Iterator

ZLIB_SECOND_BYTES = (0x01, 0x5E, 0x9C, 0xDA, 0x9D)
FOOTER = b"</INTANGI_FILE_EX>"

# Never read these, even if asked. user.mod holds the signed-in account;
# deploy/ holds account and deployment settings; plist*.mod are price lists;
# systems/ holds the user's own saved projects and autosaves.
FORBIDDEN_NAMES = re.compile(r"^(user|deploy)\.mod$|^plist.*\.mod$", re.I)
FORBIDDEN_DIRS = {"deploy", "systems"}


class ForbiddenFile(PermissionError):
    pass


def assert_allowed(path: Path) -> None:
    p = Path(path)
    if FORBIDDEN_NAMES.match(p.name):
        raise ForbiddenFile(f"refusing to read protected Iris file: {p.name}")
    if any(part.lower() in FORBIDDEN_DIRS for part in p.parts[:-1]):
        # Only applies inside an Iris cache tree; callers pass cache paths.
        if any(part.lower() == "cache" for part in p.parts):
            raise ForbiddenFile(f"refusing to read protected Iris folder: {p.parent}")


def split_wrapper(raw: bytes) -> tuple[bytes, bytes, bytes]:
    start = None
    for i in range(len(raw) - 1):
        if raw[i] == 0x78 and raw[i + 1] in ZLIB_SECOND_BYTES:
            start = i
            break
    if start is None:
        raise ValueError("no zlib payload found in Intangi wrapper")
    end = raw.rfind(FOOTER)
    if end < 0:
        raise ValueError("missing </INTANGI_FILE_EX> footer")
    return raw[:start], raw[start:end], raw[end:]


def read_mod(path: Path) -> tuple[str, str]:
    """Return (header_text, payload_text) for a catalog module."""
    assert_allowed(path)
    raw = Path(path).read_bytes()
    header, payload, _ = split_wrapper(raw)
    text = zlib.decompress(payload).decode("utf-8", "replace")
    return header.decode("utf-8", "replace"), text


def header_field(header: str, tag: str) -> str:
    m = re.search(rf"<{tag}>([^<]*)</{tag}>", header)
    return m.group(1) if m else ""


def iter_blocks(body: str, tag: str) -> Iterator[str]:
    """Yield the inner text of each <tag>...</tag> (non-nested tags only)."""
    open_t, close_t = f"<{tag}>", f"</{tag}>"
    i = 0
    while True:
        a = body.find(open_t, i)
        if a < 0:
            return
        b = body.find(close_t, a)
        if b < 0:
            return
        yield body[a + len(open_t) : b]
        i = b + len(close_t)


def field(block: str, tag: str) -> str:
    m = re.search(rf"<{tag}>([^<]*)</{tag}>", block)
    return m.group(1) if m else ""


def leaf_fields(block: str) -> dict[str, str]:
    """Top-level leaf fields of a block (first occurrence wins)."""
    out: dict[str, str] = {}
    for m in re.finditer(r"<([A-Za-z0-9_]+)>([^<\n]*)</\1>", block):
        out.setdefault(m.group(1), m.group(2))
    return out


def safe_glob(root: Path, patterns: Iterable[str]) -> list[Path]:
    out: list[Path] = []
    for pattern in patterns:
        for p in sorted(Path(root).glob(pattern)):
            try:
                assert_allowed(p)
            except ForbiddenFile:
                continue
            if p.is_file():
                out.append(p)
    return out
