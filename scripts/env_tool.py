#!/usr/bin/env python3
"""ParcelPilot env helper.

Encode `.env` → `.env.b64` (so the file can live in git), or decode `.env.b64`
→ `.env` so a cloned repo has a working environment.

Usage
-----
  python scripts/env_tool.py decode          # reads .env.b64 → writes .env
  python scripts/env_tool.py encode          # reads .env     → writes .env.b64
  python scripts/env_tool.py decode --stdout # print the decoded env to stdout
  python scripts/env_tool.py --help

WARNING: base64 is encoding, not encryption. Anyone with access to this repo
can decode the resulting `.env`. Rotate every key committed this way before
sharing the repo publicly.
"""

from __future__ import annotations

import argparse
import base64
import pathlib
import sys


def repo_root() -> pathlib.Path:
    return pathlib.Path(__file__).resolve().parent.parent


def encode(args: argparse.Namespace) -> int:
    root = repo_root()
    src = root / args.input
    dst = root / args.output
    if not src.exists():
        print(f"error: {src} not found", file=sys.stderr)
        return 1
    data = src.read_bytes()
    encoded = base64.b64encode(data)
    dst.write_bytes(encoded + b"\n")
    print(f"wrote {dst} ({len(encoded)} bytes)")
    return 0


def decode(args: argparse.Namespace) -> int:
    root = repo_root()
    src = root / args.input
    if not src.exists():
        print(f"error: {src} not found", file=sys.stderr)
        return 1
    raw = src.read_text().strip().encode("ascii")
    try:
        decoded = base64.b64decode(raw, validate=True)
    except base64.binascii.Error as exc:  # type: ignore[attr-defined]
        print(f"error: {src} is not valid base64: {exc}", file=sys.stderr)
        return 1

    if args.stdout:
        sys.stdout.buffer.write(decoded)
        return 0

    dst = root / args.output
    if dst.exists() and not args.force:
        print(
            f"refusing to overwrite existing {dst} (pass --force to replace)",
            file=sys.stderr,
        )
        return 1
    dst.write_bytes(decoded)
    try:
        dst.chmod(0o600)
    except OSError:
        pass
    print(f"wrote {dst} ({len(decoded)} bytes). Keep it out of version control.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)

    e = sub.add_parser("encode", help="read .env, write .env.b64")
    e.add_argument("--input", default=".env")
    e.add_argument("--output", default=".env.b64")
    e.set_defaults(func=encode)

    d = sub.add_parser("decode", help="read .env.b64, write .env")
    d.add_argument("--input", default=".env.b64")
    d.add_argument("--output", default=".env")
    d.add_argument("--stdout", action="store_true", help="print decoded env to stdout")
    d.add_argument("--force", action="store_true", help="overwrite existing .env")
    d.set_defaults(func=decode)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
