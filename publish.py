#!/usr/bin/env python3
"""Validate this extension, then optionally commit and push its private GitHub repo.

    python3 publish.py
    python3 publish.py --push -m "Describe the extension changes"

Requires Python 3.9+, Git, Node.js, and an already authenticated GitHub CLI.
This script never creates repositories, changes accounts, or force-pushes.
"""

import argparse
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
from urllib.parse import unquote, urlsplit


REPOSITORY = "desklemur-dev/DeskLemurOS_Chrome_Extension"
ACCOUNT = "desklemur-dev"
BRANCH = "main"


class PublishError(Exception):
    """A validation or publishing failure safe to display to the user."""


def run(root, *args, allowed=(0,)):
    """Do not echo subprocess output: it can contain credentials or remote URLs."""
    label = " ".join(args[:2])
    env = os.environ.copy()
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["GH_PROMPT_DISABLED"] = "1"
    env["GIT_OPTIONAL_LOCKS"] = "0"
    env["GIT_LITERAL_PATHSPECS"] = "1"
    command = list(args)
    if args[:2] in {("git", "ls-remote"), ("git", "fetch"), ("git", "push")}:
        command = [
            "git", "-c", "credential.helper=", "-c",
            "credential.https://github.com.helper=!gh auth git-credential",
        ] + list(args[1:])
    try:
        result = subprocess.run(
            command, cwd=str(root), env=env, shell=False,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            encoding="utf-8", errors="replace", timeout=120,
        )
    except FileNotFoundError:
        raise PublishError("Required command is unavailable: " + args[0]) from None
    except subprocess.TimeoutExpired:
        raise PublishError(label + " timed out. Check connectivity and retry.") from None
    if result.returncode not in allowed:
        raise PublishError(
            "{} failed (exit {}). Its output was withheld to avoid exposing credentials."
            .format(label, result.returncode)
        )
    return result.stdout


def permitted(path):
    """Only the small standalone extension's source, docs, and publisher belong here."""
    item = PurePosixPath(path)
    if item.is_absolute() or ".." in item.parts or "\\" in path:
        return False
    if len(item.parts) == 1:
        return (
            path in {"manifest.json", ".gitignore", "publish.py", "test_publish.py"}
            or (not item.name.startswith(".") and item.suffix in {".md", ".js", ".cjs", ".html", ".css"})
        )
    return len(item.parts) == 2 and item.parts[0] == "icons" and item.suffix == ".png"


def reject_paths(paths):
    invalid = sorted(path for path in paths if not permitted(path))
    if invalid:
        raise PublishError(
            "Unexpected repository files; review them before publishing: "
            + ", ".join(repr(path) for path in invalid)
            + ". Extend permitted() deliberately if these belong to the extension."
        )


def changes(root):
    output = run(root, "git", "status", "--porcelain=v1", "-z", "--untracked-files=all")
    paths = []
    for record in output.split("\0"):
        if not record:
            continue
        if len(record) < 4 or record[2] != " ":
            raise PublishError("Git status was not understood; no files were staged.")
        code, path = record[:2], record[3:]
        if code != "??" and code[0] != " ":
            raise PublishError(
                "The index already contains staged changes or a conflict. "
                "Commit or unstage them yourself, then retry; the index was left untouched."
            )
        if code not in {"??", " M", " D", " T"}:
            raise PublishError("Unsupported working-tree state for " + repr(path))
        paths.append(path)
    reject_paths(paths)
    return sorted(paths)


def check_repository(root):
    actual = Path(run(root, "git", "rev-parse", "--show-toplevel").strip()).resolve()
    if actual != root.resolve():
        raise PublishError("publish.py must be directly inside the standalone extension Git root.")
    branch = run(root, "git", "symbolic-ref", "--quiet", "--short", "HEAD").strip()
    if branch != BRANCH:
        raise PublishError("Switch to the existing main branch before publishing.")
    for args in [("get-url", "--all", "origin"), ("get-url", "--push", "--all", "origin")]:
        urls = run(root, "git", "remote", *args).splitlines()
        accepted = {
            "https://github.com/" + REPOSITORY,
        }
        accepted |= {url + ".git" for url in accepted}
        if len(urls) != 1 or urls[0] not in accepted:
            raise PublishError("origin must fetch and push only the expected GitHub repository over HTTPS.")
    tracked = run(root, "git", "ls-files", "-z").split("\0")
    reject_paths(path for path in tracked if path)
    return changes(root)


def reference(root, path, repository_paths=None):
    if not isinstance(path, str) or not path or not permitted(path):
        raise PublishError("Invalid or unsupported manifest file reference: " + repr(path))
    target = root / path
    if target.is_symlink() or root.resolve() not in target.resolve().parents:
        raise PublishError("Manifest references must stay inside the repository: " + repr(path))
    if not target.is_file():
        raise PublishError("Missing manifest file: " + repr(path))
    if repository_paths is not None and path not in repository_paths:
        raise PublishError("Required extension file is ignored by Git and would not be published: " + repr(path))


def icon_references(value):
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict) and value and all(isinstance(key, str) and key.isdigit() for key in value):
        return list(value.values())
    raise PublishError("Manifest icons must be a path or a nonempty size-to-path object.")


class HTMLReferences(HTMLParser):
    def __init__(self):
        super().__init__()
        self.paths = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        value = attributes.get("href") if tag == "link" else attributes.get("src")
        if value:
            parsed = urlsplit(value)
            if not parsed.scheme and not parsed.netloc and parsed.path:
                self.paths.append(unquote(parsed.path))


def validate_extension(root, repository_paths=None):
    reference(root, "manifest.json", repository_paths)
    try:
        manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError):
        raise PublishError("manifest.json must exist and contain valid UTF-8 JSON.") from None
    if not isinstance(manifest, dict) or manifest.get("manifest_version") != 3:
        raise PublishError("manifest.json must be a Manifest V3 object.")
    for key in ("name", "description"):
        if not isinstance(manifest.get(key), str) or not manifest[key].strip():
            raise PublishError("Manifest requires a nonempty " + key + ".")
    version = manifest.get("version", "")
    if not isinstance(version, str) or not re.fullmatch(r"(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*)){0,3}", version):
        raise PublishError("Manifest version must contain one to four integer components.")
    numbers = [int(part) for part in version.split(".")]
    if not any(numbers) or any(number > 65535 for number in numbers):
        raise PublishError("Manifest version components must be 0–65535 and not all zero.")
    background, action = manifest.get("background"), manifest.get("action")
    if not isinstance(background, dict) or not isinstance(action, dict):
        raise PublishError("Manifest requires background and action objects.")
    refs = [background.get("service_worker"), action.get("default_popup")]
    refs.extend(icon_references(manifest.get("icons")))
    if "default_icon" in action:
        refs.extend(icon_references(action["default_icon"]))
    for key in ("permissions", "host_permissions"):
        value = manifest.get(key, [])
        if not isinstance(value, list) or any(not isinstance(entry, str) for entry in value):
            raise PublishError("Manifest " + key + " must be an array of strings.")
    content_scripts = manifest.get("content_scripts", [])
    if not isinstance(content_scripts, list):
        raise PublishError("Manifest content_scripts must be an array of objects.")
    for content in content_scripts:
        if not isinstance(content, dict):
            raise PublishError("Manifest content_scripts entries must be objects.")
        for key in ("js", "css"):
            values = content.get(key, [])
            if not isinstance(values, list):
                raise PublishError("Manifest content script files must be arrays.")
            refs.extend(values)
    for path in refs:
        reference(root, path, repository_paths)
    for path in sorted(root.glob("*.html")):
        parser = HTMLReferences()
        try:
            parser.feed(path.read_text(encoding="utf-8"))
        except (UnicodeError, ValueError):
            raise PublishError("Invalid HTML file: " + repr(path.name)) from None
        for resource in parser.paths:
            reference(root, resource, repository_paths)
    for path in sorted(root.glob("*.js")):
        run(root, "node", "--check", path.name)
    reference(root, "test_service_worker.cjs", repository_paths)
    run(root, "node", "test_service_worker.cjs")
    return version


def check_github(root):
    account = run(root, "gh", "api", "--hostname", "github.com", "user", "--jq", ".login").strip()
    if account != ACCOUNT:
        raise PublishError("The active GitHub CLI identity must be desklemur-dev; no account was changed.")
    response = run(root, "gh", "api", "--hostname", "github.com", "repos/" + REPOSITORY)
    try:
        repo = json.loads(response)
    except ValueError:
        raise PublishError("GitHub repository metadata was not valid JSON.") from None
    if not isinstance(repo, dict) or repo.get("full_name") != REPOSITORY:
        raise PublishError("GitHub returned unexpected repository metadata.")
    if repo.get("private") is not True:
        raise PublishError("This publisher requires the repository to remain private.")
    if repo.get("default_branch") != BRANCH:
        raise PublishError("The repository default branch must be main.")
    if not isinstance(repo.get("permissions"), dict) or repo["permissions"].get("push") is not True:
        raise PublishError("The active account does not have push permission for this repository.")


def remote_main(root):
    heads = run(root, "git", "ls-remote", "--heads", "origin")
    found = None
    for line in heads.splitlines():
        fields = line.split()
        if len(fields) != 2 or not re.fullmatch(r"[0-9a-f]{40,64}", fields[0]) or not fields[1].startswith("refs/heads/"):
            raise PublishError("GitHub returned an unexpected remote branch listing.")
        if fields[1] == "refs/heads/main":
            found = fields[0]
    if heads.strip() and found is None:
        raise PublishError("The remote contains other branches but no main; review its setup manually.")
    return found


def fetch_and_check(root, remote_exists):
    if not remote_exists:
        return
    run(root, "git", "fetch", "--no-tags", "origin", "refs/heads/main:refs/remotes/origin/main")
    counts = run(root, "git", "rev-list", "--left-right", "--count", "HEAD...refs/remotes/origin/main").split()
    if len(counts) != 2 or any(not count.isdigit() for count in counts):
        raise PublishError("Could not determine whether main is ahead or behind the remote.")
    if int(counts[1]):
        raise PublishError(
            "Remote main contains commits missing locally (behind or diverged). "
            "Integrate those changes manually and retry; no files were staged."
        )


def snapshot(root, paths):
    result = {}
    for path in paths:
        target = root / path
        if target.is_symlink() or root.resolve() not in target.resolve().parents:
            raise PublishError("Symlinks or paths outside the repository cannot be published: " + repr(path))
        if target.exists() and not target.is_file():
            raise PublishError("Only regular files can be published: " + repr(path))
        result[path] = (
            hashlib.sha256(target.read_bytes()).hexdigest(), target.stat().st_mode
        ) if target.exists() else None
    return result


def publish(root, push=False, message=None):
    paths = check_repository(root)
    tracked = [path for path in run(root, "git", "ls-files", "-z").split("\0") if path]
    checked_paths = sorted(set(tracked + paths))
    before = snapshot(root, checked_paths)
    version = validate_extension(root, checked_paths)
    check_github(root)
    remote_exists = remote_main(root) is not None
    print("Validated extension {} for {} (private, main).".format(version, REPOSITORY))
    if paths:
        print("Files to commit:")
        for path in paths:
            print("  " + repr(path))
    else:
        print("No working-tree changes; existing local commits can still be pushed.")
    print("Remote main exists." if remote_exists else "The remote is empty; this will create main.")
    if not push:
        print("Check only: no fetch, staging, commit, or push was performed.")
        print("To publish: python3 publish.py --push -m 'Describe the extension changes'")
        return
    if paths and (not message or not message.strip()):
        raise PublishError("Changed files require a commit message: --push -m 'Describe the changes'.")
    fetch_and_check(root, remote_exists)
    if changes(root) != paths or snapshot(root, checked_paths) != before:
        raise PublishError("Files changed during validation. Retry to validate the current contents.")
    if paths:
        run(root, "git", "add", "--", *paths)
        try:
            run(root, "git", "commit", "-m", message)
        except PublishError as exc:
            raise PublishError(str(exc) + " The staged changes were preserved; inspect the index before retrying.") from None
    try:
        run(root, "git", "push", "--set-upstream", "origin", "HEAD:refs/heads/main")
    except PublishError as exc:
        raise PublishError(
            str(exc) + " Local commits were preserved. Check authentication/connectivity or integrate "
            "remote changes, then retry --push. Nothing was force-pushed."
        ) from None
    print("Published successfully: https://github.com/" + REPOSITORY + " (main).")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--push", action="store_true", help="After validation, commit allowed changes and push main")
    parser.add_argument("-m", "--message", help="Commit message, required when --push includes changed files")
    args = parser.parse_args(argv)
    try:
        publish(Path(__file__).resolve().parent, args.push, args.message)
    except (PublishError, OSError) as exc:
        print("Stopped: " + str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
