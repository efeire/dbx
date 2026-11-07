import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('personal_package', Path(__file__).with_name('package-personal-windows.py'))
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


class PortablePackageTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.commit = 'a' * 40
        pe = bytearray(64)
        pe[:2] = b'MZ'
        struct.pack_into('<I', pe, 60, 64)
        for path in ['target/x86_64-pc-windows-msvc/release/dbx.exe', 'target/personal-drivers/oracle/agent.exe']:
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(pe + b'PE\0\0\x64\x86')
        (self.root / 'src-tauri').mkdir()
        (self.root / 'src-tauri/tauri.conf.json').write_text('{"version":"0.6.67"}', encoding='utf-8')
        (self.root / 'LICENSE').write_text('license', encoding='utf-8')
        self.jar = self.root / 'agents/drivers/oceanbase-oracle/build/libs/dbx-agent-oceanbase-oracle.jar'
        self.jar.parent.mkdir(parents=True)
        with zipfile.ZipFile(self.jar, 'w') as jar:
            jar.writestr('META-INF/MANIFEST.MF', 'Main-Class: com.dbx.agent.oceanbaseoracle.OceanBaseOracleAgent\n')

    def test_overlay_contains_only_selected_payloads_and_matching_hashes(self):
        (self.root / 'user-secret.txt').write_text('not packaged')
        archive = package.assemble(self.root, self.commit)
        with zipfile.ZipFile(archive) as z:
            self.assertEqual(set(z.namelist()), {
                'DBX.exe', 'portable.dbx', 'LICENSE', '覆盖说明.txt', 'package.json',
                'driver-overrides/oracle/agent.exe', 'driver-overrides/oceanbase-oracle/agent.jar',
            })
            metadata = json.loads(z.read('package.json'))
            self.assertEqual(metadata['commit'], self.commit)
            self.assertEqual(metadata['files']['DBX.exe'], package.sha256(self.root / 'target/x86_64-pc-windows-msvc/release/dbx.exe'))
            self.assertIn('官方', z.read('覆盖说明.txt').decode())
        self.assertEqual(archive.with_suffix('.zip.sha256').read_text().split()[0], package.sha256(archive))

    def test_missing_driver_does_not_produce_archive(self):
        self.jar.unlink()
        with self.assertRaises(ValueError):
            package.assemble(self.root, self.commit)
        self.assertFalse((self.root / 'target/personal-dist').exists())

    def test_wrong_architecture_is_rejected(self):
        path = self.root / 'target/personal-drivers/oracle/agent.exe'
        path.write_bytes(path.read_bytes()[:-2] + b'\x64\xaa')
        with self.assertRaises(ValueError):
            package.assemble(self.root, self.commit)


if __name__ == '__main__':
    unittest.main()
