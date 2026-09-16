"""Shared deployment file contract, without requiring live Ollama services."""
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


class OllamaConfigurationTests(unittest.TestCase):
    def loaders(self):
        for service in ("agent", "indexing", "search"):
            path = ROOT / "services" / f"{service}-runtime" / "src"
            path = path / f"{service}_runtime" / "ollama_config.py"
            spec = importlib.util.spec_from_file_location(f"{service}_config", path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            yield module.load_ollama_endpoint

    def test_all_runtimes_read_same_remote_server(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ollama.json"
            path.write_text(json.dumps({"endpoint": "https://ollama.internal:11434/"}))
            with patch.dict(os.environ, {"AIHUB_OLLAMA_CONFIG": str(path)}):
                for load in self.loaders():
                    self.assertEqual(load(), "https://ollama.internal:11434")

    def test_default_file_does_not_depend_on_working_directory(self):
        with patch.dict(os.environ):
            os.environ.pop("AIHUB_OLLAMA_CONFIG", None)
            expected = json.loads((ROOT / "config/ollama.json").read_text())["endpoint"]
            original = Path.cwd()
            try:
                os.chdir(ROOT / "services")
                for load in self.loaders():
                    self.assertEqual(load(), expected.rstrip("/"))
            finally:
                os.chdir(original)

    def test_invalid_configuration_never_falls_back_to_localhost(self):
        invalid = [
            "{", "{}", "[]", '{"endpoint": null}',
            *[json.dumps({"endpoint": value}) for value in (
                "", "ftp://server", "http://", "http://server:invalid",
                "http://user:pass@server", "http://server/api", "http://server?q=x",
                "http://server/#fragment", "http://bad host",
            )],
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ollama.json"
            with patch.dict(os.environ, {"AIHUB_OLLAMA_CONFIG": str(path)}):
                for load in self.loaders():
                    with self.assertRaisesRegex(ValueError, "Invalid Ollama configuration"):
                        load()
                    for content in invalid:
                        path.write_text(content)
                        with self.subTest(content=content, loader=load):
                            with self.assertRaisesRegex(ValueError, "Invalid Ollama configuration"):
                                load()
                    path.unlink()


if __name__ == "__main__":
    unittest.main()
