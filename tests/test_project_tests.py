"""Regression tests for the trusted, manual project test runner."""
from pathlib import Path
from textwrap import indent
from types import SimpleNamespace

import pytest
from homeassistant.exceptions import Unauthorized

from custom_components.flode import test_source
from custom_components.flode.project_lock import project_lock
from custom_components.flode.test_api import run_project_tests


def project(tmp_path: Path, body: str) -> Path:
    tests = tmp_path / "tests"
    tests.mkdir()
    (tests / "test_smoke.py").write_text(
        "import unittest\nclass Smoke(unittest.TestCase):\n    def test_smoke(self):\n"
        + indent(body, "        ") + "\n"
    )
    return tmp_path


def test_success_output_and_no_bytecode(tmp_path):
    root = project(tmp_path, "print('hello from Python')\nself.assertTrue(True)")
    result = test_source.run_tests(str(root))
    assert result["success"]
    assert result["exit_code"] == 0
    assert "hello from Python" in result["output"]
    assert "Ran 1 test" in result["output"]
    assert not list(root.rglob("__pycache__"))


def test_failed_assertion_is_not_success(tmp_path):
    result = test_source.run_tests(str(project(tmp_path, "self.assertEqual(1, 2)")))
    assert not result["success"]
    assert result["exit_code"] == 1
    assert "AssertionError" in result["output"]


def test_import_error_is_reported(tmp_path):
    project(tmp_path, "pass")
    (tmp_path / "tests/test_smoke.py").write_text("import missing_flode_example_dependency\n")
    result = test_source.run_tests(str(tmp_path))
    assert not result["success"]
    assert "ModuleNotFoundError" in result["output"]


def test_empty_suite_is_not_success(tmp_path):
    (tmp_path / "tests").mkdir()
    result = test_source.run_tests(str(tmp_path))
    assert not result["success"]
    assert result["exit_code"] == 5
    assert "No unittest tests found" in result["output"]


def test_timeout(tmp_path, monkeypatch):
    root = project(tmp_path, "import time\ntime.sleep(60)")
    monkeypatch.setattr(test_source, "TIMEOUT", 0.3)
    result = test_source.run_tests(str(root))
    assert result["timed_out"]
    assert not result["success"]
    assert result["duration"] < 5


def test_large_output_is_bounded_but_still_drained(tmp_path):
    root = project(tmp_path, "print('x' * 200000)")
    result = test_source.run_tests(str(root))
    assert result["success"]
    assert result["truncated"]
    assert len(result["output"].encode()) <= test_source.OUTPUT_LIMIT


def test_git_and_tests_share_the_checkout_lock(tmp_path):
    root = project(tmp_path, "pass")
    lock = project_lock(str(root.resolve()))
    with lock, pytest.raises(ValueError, match="Another Git or test"):
        test_source.run_tests(str(root))


@pytest.mark.parametrize("directory", ["", "relative", "/missing-flode-project"])
def test_invalid_directory(directory):
    with pytest.raises((ValueError, OSError)):
        test_source.run_tests(directory)


def test_missing_tests_directory(tmp_path):
    with pytest.raises(ValueError, match="tests/"):
        test_source.run_tests(str(tmp_path))


def test_symlinked_tests_are_rejected(tmp_path):
    (tmp_path / "tests").symlink_to(tmp_path.parent, target_is_directory=True)
    with pytest.raises(ValueError, match="tests/"):
        test_source.run_tests(str(tmp_path))


def test_non_admin_cannot_run_python():
    with pytest.raises(Unauthorized):
        run_project_tests(None, SimpleNamespace(user=SimpleNamespace(is_admin=False)), {"id": 1})
