"""Parse and serialize Iris's almost-XML payloads.

Iris writes a newline-separated tag soup that is not always well-formed XML
(unescaped '&' in text is common). This parser preserves element order,
duplicate sibling tags, empty leaves, and raw text so a decoded payload can
round-trip byte-for-byte.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterator, Optional


@dataclass
class Node:
    tag: str
    text: Optional[str] = None  # leaf; "" means <TAG></TAG>
    children: Optional[list["Node"]] = None  # non-leaf; [] means <TAG>\n</TAG>

    def is_leaf(self) -> bool:
        return self.children is None

    def find(self, tag: str) -> Optional["Node"]:
        if not self.children:
            return None
        for child in self.children:
            if child.tag == tag:
                return child
        return None

    def findall(self, tag: str) -> list["Node"]:
        return [c for c in (self.children or []) if c.tag == tag]

    def text_of(self, tag: str, default: Optional[str] = None) -> Optional[str]:
        child = self.find(tag)
        if child is None:
            return default
        return child.text if child.text is not None else default

    def iter_descendants(self) -> Iterator["Node"]:
        yield self
        for child in self.children or []:
            yield from child.iter_descendants()

    def set_text(self, tag: str, value: str) -> None:
        child = self.find(tag)
        if child is None:
            if self.children is None:
                self.children = []
            self.children.append(Node(tag, text=value))
        else:
            child.text = value
            child.children = None


def parse(payload: str) -> Node:
    parser = _Parser(payload)
    node = parser.parse_element()
    parser.skip_whitespace()
    if parser.i < len(payload):
        trailing = payload[parser.i :]
        if trailing.strip():
            raise ValueError(f"trailing payload at {parser.i}: {trailing[:80]!r}")
    return node


def serialize(node: Node) -> str:
    return _serialize_node(node)


def _serialize_node(node: Node) -> str:
    if node.children is not None:
        inner = "".join(_serialize_node(c) for c in node.children)
        return f"<{node.tag}>\n{inner}</{node.tag}>\n"
    value = "" if node.text is None else node.text
    return f"<{node.tag}>{value}</{node.tag}>\n"


class _Parser:
    def __init__(self, src: str):
        self.s = src
        self.i = 0
        self.n = len(src)

    def skip_whitespace(self) -> None:
        s, i, n = self.s, self.i, self.n
        while i < n and s[i] in " \t\r\n":
            i += 1
        self.i = i

    def parse_element(self) -> Node:
        s, i, n = self.s, self.i, self.n
        if i >= n or s[i] != "<" or (i + 1 < n and s[i + 1] == "/"):
            raise ValueError(f"expected start tag at {i}: {s[i : i + 40]!r}")
        j = s.find(">", i)
        if j < 0:
            raise ValueError(f"unterminated start tag at {i}")
        tag = s[i + 1 : j]
        if not tag or tag[-1] == "/" or " " in tag:
            raise ValueError(f"unsupported tag at {i}: {tag!r}")
        i = j + 1
        close = f"</{tag}>"
        # Empty leaf: <TAG></TAG>
        if s.startswith(close, i):
            self.i = i + len(close)
            if self.i < n and s[self.i] == "\n":
                self.i += 1
            return Node(tag, text="")
        # Non-leaf: <TAG>\n ... </TAG>
        if i < n and s[i] == "\n" and i + 1 < n and s[i + 1] == "<":
            self.i = i + 1
            children: list[Node] = []
            while True:
                if self.s.startswith(close, self.i):
                    self.i += len(close)
                    if self.i < self.n and self.s[self.i] == "\n":
                        self.i += 1
                    return Node(tag, children=children)
                if self.i >= self.n:
                    raise ValueError(f"unterminated <{tag}>")
                children.append(self.parse_element())
        # Leaf with text (may include unescaped '&')
        k = s.find(close, i)
        if k < 0:
            raise ValueError(f"unterminated leaf <{tag}> at {i}")
        text = s[i:k]
        self.i = k + len(close)
        if self.i < n and s[self.i] == "\n":
            self.i += 1
        return Node(tag, text=text)
