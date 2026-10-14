"""Target lookup: host-config first, then beside the procedure. No SSH, no services."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

HERE = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


host_targets = load('host_targets')


class Lookup(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='devpanel-host-targets-')
        self.repo = Path(self.temp.name) / 'repo'
        self.here = self.repo / 'tools' / 'releases'
        self.here.mkdir(parents=True)

    def tearDown(self):
        self.temp.cleanup()

    def put(self, directory, text):
        directory.mkdir(parents=True, exist_ok=True)
        (directory / 'site-targets.json').write_text(text)
        return directory / 'site-targets.json'

    def find(self, env):
        return host_targets.targets_file('site', env, self.here)

    def test_in_tree_only(self):
        tree = self.put(self.here, '{}')
        self.assertEqual(self.find({}), tree)

    def test_host_only(self):
        host = self.put(self.repo / 'host-config' / 'releases', '{}')
        self.assertEqual(self.find({}), host)

    def test_both_present_host_wins(self):
        self.put(self.here, '{"tree": true}')
        host = self.put(self.repo / 'host-config' / 'releases', '{"host": true}')
        self.assertEqual(self.find({}), host)

    def test_relative_setting_is_relative_to_the_config_root(self):
        self.put(self.here, '{}')
        config_root = Path(self.temp.name) / 'config'
        host = self.put(config_root / 'host-data' / 'releases', '{}')
        self.assertEqual(self.find({'DEVPANEL_CONFIG_ROOT': str(config_root), 'DEVPANEL_HOST_CONFIG_DIR': 'host-data'}), host)
        # Without a config root the checkout is the root.
        repo_host = self.put(self.repo / 'host-data' / 'releases', '{}')
        self.assertEqual(self.find({'DEVPANEL_HOST_CONFIG_DIR': 'host-data'}), repo_host)

    def test_absolute_setting(self):
        host = self.put(Path(self.temp.name) / 'elsewhere' / 'releases', '{}')
        self.assertEqual(self.find({'DEVPANEL_HOST_CONFIG_DIR': str(host.parent.parent), 'DEVPANEL_CONFIG_ROOT': '/nonexistent'}), host)

    def test_empty_values_are_unset(self):
        host = self.put(self.repo / 'host-config' / 'releases', '{}')
        self.assertEqual(self.find({'DEVPANEL_CONFIG_ROOT': '', 'DEVPANEL_HOST_CONFIG_DIR': ''}), host)

    def test_neither_present_names_both(self):
        with self.assertRaises(ValueError) as raised:
            self.find({})
        self.assertIn('host-config/releases/site-targets.json', str(raised.exception))
        self.assertIn('tools/releases/site-targets.json', str(raised.exception))


if __name__ == '__main__':
    unittest.main()
