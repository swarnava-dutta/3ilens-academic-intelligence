"""Checks backend\\.venv against backend\\requirements.txt for scripts\\ensure-deps.ps1.

Usage: <venv python> -I check-requirements.py <requirements.txt>

Exit 0 when every requirement is installed at an allowed version, together with the
packages it needs (extras such as uvicorn[standard] included), and none of the files pip
installed for them (listed in their RECORD) is missing. Otherwise it exits 1 and prints
one line per problem (at most five), plus one "REINSTALL name==version" line for every
damaged package: "pip install -r" leaves those alone because their metadata says they
are installed, so the caller reinstalls them by name. Reads metadata only - nothing is
imported or changed, which keeps the check to a second or two.
"""
import csv
import os
import re
import sys
from importlib import metadata


def missing_file(dist):
    # Dist.files is no use here: it silently drops files that no longer exist.
    record = dist.read_text("RECORD")
    if not record:
        return None
    for row in csv.reader(record.splitlines()):
        if not row or not row[0]:
            continue
        rel = row[0]
        if rel.endswith(".pyc") or "__pycache__" in rel:
            continue
        if not os.path.exists(str(dist.locate_file(rel))):
            return rel
    return None


def main(req_file):
    try:
        from pip._vendor.packaging.requirements import InvalidRequirement, Requirement
        from pip._vendor.packaging.utils import canonicalize_name
        from pip._vendor.packaging.version import InvalidVersion
    except Exception as exc:  # pip itself is missing or broken
        print("pip is missing or broken in backend\\.venv (%s)" % exc.__class__.__name__)
        return 1

    def wanted(req, extras):
        # A dependency counts when its marker matches this PC for the base package
        # or for one of the extras that were asked for.
        if req.marker is None:
            return True
        for extra in [""] + sorted(extras):
            try:
                if req.marker.evaluate({"extra": extra}):
                    return True
            except Exception:
                return True
        return False

    todo = []
    with open(req_file, encoding="utf-8-sig") as fh:
        for raw in fh:
            line = re.sub(r"(^|\s)#.*$", "", raw).strip()
            if not line or line.startswith("-"):
                continue  # comments and pip options (-r, --index-url, ...) are left to pip
            try:
                todo.append((Requirement(line), frozenset()))
            except InvalidRequirement:
                continue  # pip reports these itself when it runs

    problems = []
    reinstall = []
    seen = set()
    files_checked = set()
    while todo:
        req, parent_extras = todo.pop()
        if not wanted(req, parent_extras):
            continue
        name = canonicalize_name(req.name)
        key = (name, frozenset(req.extras), str(req.specifier))
        if key in seen:
            continue
        seen.add(key)
        try:
            dist = metadata.distribution(req.name)
        except metadata.PackageNotFoundError:
            problems.append("%s is not installed" % req.name)
            continue
        if req.specifier:
            try:
                ok = req.specifier.contains(dist.version, prereleases=True)
            except InvalidVersion:
                ok = True
            if not ok:
                problems.append("%s %s is installed, %s is needed" % (req.name, dist.version, req.specifier))
                continue
        if name not in files_checked:
            files_checked.add(name)
            gone = missing_file(dist)
            if gone:
                problems.append("%s is damaged (%s is missing)" % (req.name, gone))
                reinstall.append("%s==%s" % (req.name, dist.version))
        for dep in dist.requires or []:
            try:
                todo.append((Requirement(dep), frozenset(req.extras)))
            except InvalidRequirement:
                continue

    for p in problems[:5]:
        print(p)
    for r in reinstall:
        print("REINSTALL " + r)
    return 1 if problems else 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: check-requirements.py <requirements.txt>")
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
