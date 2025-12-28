#!/usr/bin/env python3
import os
import subprocess
import sys


def main() -> int:
    os.chdir(os.path.dirname(os.path.abspath(__file__)))

    message = input("Commit message: ").strip()
    if not message:
        print("Empty commit message, aborted.", file=sys.stderr)
        return 1

    subprocess.run(["git", "add", "."], check=True)

    subprocess.run(["git", "commit", "-m", message], check=False)

    subprocess.run(["git", "push", "-u", "Remote", "master"], check=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
