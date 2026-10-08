"""Publisher safety tests; all Git/GitHub calls are mocked, never pushed."""

import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import publish


class PublisherTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.manifest = {
            "manifest_version": 3, "name": "Test bridge", "description": "Test extension",
            "version": "0.1.0", "background": {"service_worker": "service_worker.js"},
            "action": {"default_popup": "popup.html"}, "icons": {"16": "icons/icon16.png"},
            "permissions": ["nativeMessaging"], "host_permissions": ["https://*/*"],
        }
        (self.root / "icons").mkdir()
        for path in ("service_worker.js", "popup.html", "test_service_worker.cjs", "icons/icon16.png"):
            (self.root / path).write_text("fixture", encoding="utf-8")
        self.write_manifest()
        self.commands = []
        self.status = "?? README.md\0"
        (self.root / "README.md").write_text("Changed docs", encoding="utf-8")
        self.remote = ""
        self.counts = "1\t0\n"
        self.url = "https://github.com/" + publish.REPOSITORY + ".git\n"
        self.login = publish.ACCOUNT + "\n"
        self.metadata = {
            "full_name": publish.REPOSITORY, "private": True,
            "default_branch": "main", "permissions": {"push": True},
        }
        self.branch = "main\n"
        self.fail_push = False
        self.tracked = "manifest.json\0service_worker.js\0popup.html\0test_service_worker.cjs\0icons/icon16.png\0"
        self.stdout = io.StringIO()
        self.addCleanup(patch.stopall)
        patch("publish.run", side_effect=self.fake_run).start()
        self.redirect = contextlib.redirect_stdout(self.stdout)
        self.redirect.__enter__()
        self.addCleanup(self.redirect.__exit__, None, None, None)

    def write_manifest(self):
        (self.root / "manifest.json").write_text(json.dumps(self.manifest), encoding="utf-8")

    def fake_run(self, root, *args, **kwargs):
        self.commands.append(args)
        if args[:3] == ("git", "rev-parse", "--show-toplevel"):
            return str(self.root) + "\n"
        if args[:2] == ("git", "symbolic-ref"):
            return self.branch
        if args[:2] == ("git", "remote"):
            return self.url
        if args[:2] == ("git", "status"):
            return self.status
        if args[:2] == ("git", "ls-files"):
            return self.tracked
        if args[0] == "node":
            return "ok\n"
        if args[:2] == ("gh", "api"):
            return self.login if "user" in args else json.dumps(self.metadata)
        if args[:2] == ("git", "ls-remote"):
            return self.remote
        if args[:2] == ("git", "rev-list"):
            return self.counts
        if args[:2] in (("git", "fetch"), ("git", "add"), ("git", "commit")):
            return ""
        if args[:2] == ("git", "push"):
            if self.fail_push:
                raise publish.PublishError("git failed (exit 1).")
            return ""
        self.fail("Unexpected command: " + repr(args))

    def assert_no_mutations(self):
        self.assertFalse(any(command[:2] in {
            ("git", "fetch"), ("git", "add"), ("git", "commit"), ("git", "push")
        } for command in self.commands))

    def test_default_checks_without_mutation(self):
        publish.publish(self.root)
        self.assert_no_mutations()
        self.assertIn(("node", "test_service_worker.cjs"), self.commands)
        self.assertIn(("node", "--check", "service_worker.js"), self.commands)
        self.assertIn("Check only", self.stdout.getvalue())

    def test_initial_empty_remote_can_be_published(self):
        publish.publish(self.root, True, "Initial automation")
        self.assertIn(("git", "add", "--", "README.md"), self.commands)
        self.assertIn(("git", "commit", "-m", "Initial automation"), self.commands)
        self.assertIn(("git", "push", "--set-upstream", "origin", "HEAD:refs/heads/main"), self.commands)
        self.assertFalse(any(command[:2] == ("git", "fetch") for command in self.commands))
        self.assertFalse(any("--force" in command or "-f" in command for command in self.commands))

    def test_pending_commits_push_without_new_files_or_message(self):
        self.status = ""
        self.remote = "a" * 40 + "\trefs/heads/main\n"
        publish.publish(self.root, True)
        self.assertTrue(any(command[:2] == ("git", "fetch") for command in self.commands))
        self.assertTrue(any(command[:2] == ("git", "push") for command in self.commands))
        self.assertFalse(any(command[:2] in {("git", "add"), ("git", "commit")} for command in self.commands))

    def test_behind_and_divergence_stop_before_staging(self):
        self.remote = "a" * 40 + "\trefs/heads/main\n"
        for counts in ("0\t2\n", "3\t2\n"):
            with self.subTest(counts=counts):
                self.commands.clear()
                self.counts = counts
                with self.assertRaisesRegex(publish.PublishError, "behind or diverged"):
                    publish.publish(self.root, True, "Changed docs")
                self.assertFalse(any(command[:2] in {("git", "add"), ("git", "commit"), ("git", "push")} for command in self.commands))

    def test_existing_index_is_preserved(self):
        self.status = "MM README.md\0"
        with self.assertRaisesRegex(publish.PublishError, "index already"):
            publish.publish(self.root, True, "Changed docs")
        self.assert_no_mutations()

    def test_unexpected_untracked_file_is_not_silently_ignored(self):
        self.status += "?? private-settings.json\0"
        with self.assertRaisesRegex(publish.PublishError, "private-settings.json"):
            publish.publish(self.root, True, "Changed docs")
        self.assert_no_mutations()

    def test_unexpected_already_tracked_file_is_rejected(self):
        self.tracked += "secret.pem\0"
        with self.assertRaisesRegex(publish.PublishError, "secret.pem"):
            publish.publish(self.root, True, "Changed docs")
        self.assert_no_mutations()

    def test_wrong_remote_and_embedded_credentials_are_rejected(self):
        for url in ("https://github.com/another/project.git\n", "https://secret@github.com/" + publish.REPOSITORY + ".git\n"):
            with self.subTest(url=url):
                self.url = url
                with self.assertRaisesRegex(publish.PublishError, "origin must") as caught:
                    publish.publish(self.root, True, "Changed docs")
                self.assertNotIn("secret", str(caught.exception))
                self.assert_no_mutations()

    def test_wrong_account_public_repo_and_no_write_permission_stop(self):
        cases = (("other-user", True, True), (publish.ACCOUNT, False, True), (publish.ACCOUNT, True, False))
        for account, private, can_push in cases:
            with self.subTest(account=account, private=private, can_push=can_push):
                self.login = account
                self.metadata["private"] = private
                self.metadata["permissions"]["push"] = can_push
                with self.assertRaises(publish.PublishError):
                    publish.publish(self.root, True, "Changed docs")
                self.assert_no_mutations()

    def test_wrong_git_root_and_branch_stop(self):
        with self.assertRaisesRegex(publish.PublishError, "Git root"):
            publish.check_repository(self.root / "nested")
        self.branch = "feature\n"
        with self.assertRaisesRegex(publish.PublishError, "main branch"):
            publish.publish(self.root, True, "Changed docs")
        self.assert_no_mutations()

    def test_missing_and_escaping_manifest_references_stop(self):
        for path in ("missing.js", "../outside.js", "/tmp/outside.js"):
            with self.subTest(path=path):
                self.manifest["background"]["service_worker"] = path
                self.write_manifest()
                with self.assertRaises(publish.PublishError):
                    publish.publish(self.root, True, "Changed docs")
                self.assert_no_mutations()

    def test_missing_html_asset_stops_publication(self):
        (self.root / "popup.html").write_text('<script src="popup.js"></script>', encoding="utf-8")
        with self.assertRaisesRegex(publish.PublishError, "popup.js"):
            publish.publish(self.root, True, "Changed docs")
        self.assert_no_mutations()

    def test_ignored_reference_is_not_silently_omitted(self):
        self.tracked = self.tracked.replace("icons/icon16.png\0", "")
        with self.assertRaisesRegex(publish.PublishError, "ignored by Git"):
            publish.publish(self.root, True, "Changed docs")
        self.assert_no_mutations()

    def test_malformed_manifest_structures_fail_cleanly(self):
        for value in (None, {}, "scripts"):
            with self.subTest(value=value):
                self.manifest["content_scripts"] = value
                self.write_manifest()
                with self.assertRaisesRegex(publish.PublishError, "content_scripts must"):
                    publish.publish(self.root, True, "Changed docs")
                self.assert_no_mutations()

    def test_symlink_is_never_staged(self):
        (self.root / "README.md").unlink()
        (self.root / "README.md").symlink_to(self.root / "popup.html")
        with self.assertRaisesRegex(publish.PublishError, "Symlinks"):
            publish.publish(self.root, True, "Changed docs")
        self.assert_no_mutations()

    def test_files_changing_during_validation_are_rejected(self):
        original = self.fake_run
        def changing_run(root, *args, **kwargs):
            result = original(root, *args, **kwargs)
            if args[:2] == ("git", "ls-remote"):
                (self.root / "service_worker.js").write_text("changed while validating", encoding="utf-8")
            return result
        with patch("publish.run", side_effect=changing_run):
            with self.assertRaisesRegex(publish.PublishError, "changed during validation"):
                publish.publish(self.root, True, "Changed docs")
        self.assert_no_mutations()

    def test_no_message_leaves_everything_untouched(self):
        with self.assertRaisesRegex(publish.PublishError, "commit message"):
            publish.publish(self.root, True)
        self.assert_no_mutations()

    def test_push_failure_preserves_commit_and_explains_retry(self):
        self.fail_push = True
        with self.assertRaisesRegex(publish.PublishError, "Local commits were preserved"):
            publish.publish(self.root, True, "Changed docs")
        self.assertTrue(any(command[:2] == ("git", "commit") for command in self.commands))
        self.assertFalse(any(command[:2] in {("git", "reset"), ("git", "rebase"), ("git", "checkout")} for command in self.commands))


class CommandTests(unittest.TestCase):
    def test_external_error_hides_output_and_uses_no_shell(self):
        result = type("Result", (), {"returncode": 1, "stdout": "TOKEN_secret", "stderr": "TOKEN_secret"})()
        with patch("publish.subprocess.run", return_value=result) as call:
            with self.assertRaises(publish.PublishError) as caught:
                publish.run(Path.cwd(), "gh", "api", "user")
            self.assertNotIn("TOKEN_secret", str(caught.exception))
            self.assertIn("gh api failed", str(caught.exception))
            self.assertFalse(call.call_args.kwargs["shell"])
            self.assertEqual(call.call_args.args[0], ["gh", "api", "user"])

    def test_git_network_uses_cli_credentials_without_global_changes(self):
        result = type("Result", (), {"returncode": 0, "stdout": "", "stderr": ""})()
        with patch("publish.subprocess.run", return_value=result) as call:
            publish.run(Path.cwd(), "git", "push", "--set-upstream", "origin", "HEAD:refs/heads/main")
            command = call.call_args.args[0]
            self.assertEqual(command[:5], ["git", "-c", "credential.helper=", "-c", "credential.https://github.com.helper=!gh auth git-credential"])
            self.assertNotIn("--global", command)
            self.assertEqual(call.call_args.kwargs["env"]["GIT_LITERAL_PATHSPECS"], "1")


if __name__ == "__main__":
    unittest.main()
