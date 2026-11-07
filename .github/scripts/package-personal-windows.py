"""组装Windows 10 x64自用覆盖包，不读取用户配置或修改官方更新来源。"""

import argparse
import hashlib
import json
from pathlib import Path
import re
import struct
import zipfile


def verify_x64(path):
    with path.open('rb') as stream:
        header = stream.read(64)
        if len(header) != 64 or header[:2] != b'MZ':
            raise ValueError(f'不是Windows可执行文件：{path}')
        stream.seek(struct.unpack_from('<I', header, 60)[0])
        pe = stream.read(6)
        if pe != b'PE\0\0\x64\x86':
            raise ValueError(f'不是Windows x64可执行文件：{path}')


def sha256(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def assemble(root, commit):
    if not re.fullmatch(r'[0-9a-f]{40}', commit):
        raise ValueError('需要完整的Git提交SHA')
    version = json.loads((root / 'src-tauri/tauri.conf.json').read_text(encoding='utf-8'))['version']
    if not re.fullmatch(r'[0-9A-Za-z.+-]+', version):
        raise ValueError('版本号格式无效')
    jars = list((root / 'agents/drivers/oceanbase-oracle/build/libs').glob('dbx-agent-oceanbase-oracle*.jar'))
    if len(jars) != 1:
        raise ValueError('需要唯一的OceanBase shadowJar产物')
    files = {
        'DBX.exe': root / 'target/x86_64-pc-windows-msvc/release/dbx.exe',
        'driver-overrides/oracle/agent.exe': root / 'target/personal-drivers/oracle/agent.exe',
        'driver-overrides/oceanbase-oracle/agent.jar': jars[0],
        'LICENSE': root / 'LICENSE',
    }
    for path in files.values():
        if not path.is_file() or path.stat().st_size == 0:
            raise ValueError(f'缺少有效产物：{path}')
    verify_x64(files['DBX.exe'])
    verify_x64(files['driver-overrides/oracle/agent.exe'])
    with zipfile.ZipFile(jars[0]) as jar:
        manifest = jar.read('META-INF/MANIFEST.MF').decode('utf-8')
        if 'com.dbx.agent.oceanbaseoracle.OceanBaseOracleAgent' not in manifest:
            raise ValueError('OceanBase JAR入口不匹配')
        if jar.testzip() is not None:
            raise ValueError('OceanBase JAR校验失败')
    hashes = {name: sha256(path) for name, path in files.items()}
    readme = f'''DBX Windows 10 x64 自用增量覆盖包

版本：{version}；源码：{commit}

本包用于覆盖现有绿色版，不是首次安装的完整离线包。主程序为完整EXE，驱动只含
自用分支修改的Oracle原生和OB Oracle两个；不包含其他驱动、插件或用户配置。

1. 覆盖前在现有DBX设置中关闭主程序及驱动自动更新，再退出DBX及其驱动进程，
   备份原DBX.exe和准备替换的两个驱动文件。驱动自动更新是全局开关，会影响全部驱动；
   其他驱动仍可手动从官方更新，插件各自的自动更新设置保持不变。
2. 将DBX.exe覆盖到现有绿色版目录；portable.dbx是绿色模式标记。
   保留现有data目录、数据库、连接配置、插件、JRE和其他驱动，不删除整目录。
3. 在DBX设置或驱动管理中确认实际的“驱动存储目录”。默认绿色模式通常为
   <绿色版目录>/data/agents；自定义路径以界面显示为准。
4. 退出DBX后，只替换以下文件：
   driver-overrides/oracle/agent.exe → <驱动存储目录>/drivers/oracle/agent.exe
   driver-overrides/oceanbase-oracle/agent.jar → <驱动存储目录>/drivers/oceanbase-oracle/agent.jar
   driver-overrides是取件目录，不是自动加载目录。不要覆盖驱动登记信息。
   首次使用须先通过官方驱动管理安装对应驱动及OB所需Java 21运行时，再覆盖。
5. 启动后重新连接，核对导航及驱动功能。若使用Oracle OCI，本包未替换OCI驱动。

更新：主程序与上述两个驱动由fork手动覆盖；其他驱动、JDBC插件、MCP和其他
插件仍使用官方来源。不要对自用覆盖的驱动
执行官方更新，除非准备恢复官方版本。本包没有修改任何更新服务器或配置。

运行需要已有Microsoft WebView2 Runtime。本包未附离线运行时，也未做官方签名。
package.json记录文件SHA-256及源码；相邻.sha256文件校验整个ZIP。
'''
    out = root / 'target/personal-dist'
    out.mkdir(parents=True, exist_ok=True)
    archive = out / f'DBX_{version}_personal_{commit[:10]}_win10-x64-overlay.zip'
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as package:
        for name, path in files.items():
            package.write(path, name)
        package.writestr('portable.dbx', '')
        package.writestr('覆盖说明.txt', readme)
        package.writestr('package.json', json.dumps({
            'version': version, 'commit': commit, 'platform': 'windows-x64',
            'files': hashes, 'driver_overrides': ['oracle', 'oceanbase-oracle'],
        }, ensure_ascii=False, indent=2))
    archive.with_suffix('.zip.sha256').write_text(f'{sha256(archive)}  {archive.name}\n', encoding='ascii')
    return archive


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--commit', required=True)
    args = parser.parse_args()
    print(assemble(Path(__file__).resolve().parents[2], args.commit))
