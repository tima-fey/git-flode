"""Smoke test for the example automation file, without executing HA actions."""
import unittest
from pathlib import Path

import yaml


class AutomationSmokeTest(unittest.TestCase):
    def test_example_automations_can_be_read(self):
        root = Path(__file__).resolve().parents[1]
        content = (root / "automations" / "examples" / "simple.yaml").read_text()
        automations = yaml.safe_load(content)
        self.assertEqual(len(automations), 2)
        for automation in automations:
            self.assertTrue(automation["id"])
            self.assertTrue(automation["alias"])
