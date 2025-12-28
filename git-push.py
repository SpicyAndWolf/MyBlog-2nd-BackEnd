#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import subprocess
import sys


def run(cmd: list[str], *, dry_run: bool) -> None:
    if dry_run:
        print("+", " ".join(cmd))
        return
    subprocess.run(cmd, check=True)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="git add . -> git commit -m <msg> -> git push (-u) <remote> <branch>"
    )
    parser.add_argument("-m", "--message", help="commit message; if omitted, prompts")
    parser.add_argument("-r", "--remote", default="Remote", help="remote name (default: Remote)")
    parser.add_argument("-b", "--branch", default="master", help="branch name (default: master)")
    parser.add_argument(
        "--no-upstream",
        action="store_true",
        help="push without -u/--set-upstream",
    )
    parser.add_argument("--dry-run", action="store_true", help="print commands only")
    args = parser.parse_args()

    repo_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(repo_dir)

    message = args.message
    if not message:
        message = input("Commit message: ").strip()
    if not message:
        print("Commit message is empty.", file=sys.stderr)
        return 2

    run(["git", "add", "."], dry_run=args.dry_run)

    committed = True
    try:
        run(["git", "commit", "-m", message], dry_run=args.dry_run)
    except subprocess.CalledProcessError:
        committed = False
        if not args.dry_run:
            status = subprocess.run(
                ["git", "status", "--porcelain"],
                check=True,
                stdout=subprocess.PIPE,
                text=True,
            ).stdout.strip()
            if status:
                raise
            print("Nothing to commit; pushing anyway...")

    push_cmd = ["git", "push"]
    if not args.no_upstream:
        push_cmd.append("-u")
    push_cmd.extend([args.remote, args.branch])
    run(push_cmd, dry_run=args.dry_run)

    if committed:
        print(f"Done: committed and pushed to {args.remote}/{args.branch}")
    else:
        print(f"Done: pushed to {args.remote}/{args.branch}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

