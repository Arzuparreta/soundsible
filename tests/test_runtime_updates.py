import os
import subprocess
import sys
from pathlib import Path

import pytest

from shared.runtime_updates import enabled_runtime_packages, pip_upgrade_command, runtime_tool_session


@pytest.fixture(autouse=True)
def disposable_lease(monkeypatch, tmp_path):
    monkeypatch.setattr("shared.runtime_updates._tool_lease_path", lambda prefix=None: tmp_path / "tools.lock")


def apply_runtime_updates(settings):
    with runtime_tool_session(update_tools=True, file_env=settings) as updated:
        return updated


def test_enabled_runtime_packages_resolves_independent_settings():
    packages, flags = enabled_runtime_packages(
        {"YTDLP_AUTO_UPDATE": "true"},
        {"CURL_CFFI_AUTO_UPDATE": "1"},
    )

    assert packages == ["yt-dlp", "curl-cffi"]
    assert flags == {
        "YTDLP_AUTO_UPDATE": True,
        "CURL_CFFI_AUTO_UPDATE": True,
    }


def test_file_setting_takes_precedence_over_process_environment():
    packages, _ = enabled_runtime_packages(
        {"CURL_CFFI_AUTO_UPDATE": "false"},
        {"CURL_CFFI_AUTO_UPDATE": "true"},
    )

    assert "curl-cffi" not in packages


def test_pip_upgrade_command_updates_packages_in_one_transaction(tmp_path: Path):
    # A repository venv beside the engine is not necessarily its environment.
    (tmp_path / ".venv" / "bin").mkdir(parents=True)
    (tmp_path / ".venv" / "bin" / "pip").touch()

    command = pip_upgrade_command(["yt-dlp", "curl-cffi"])

    assert command == [sys.executable, "-m", "pip", "install", "--upgrade", "yt-dlp", "curl-cffi"]


def test_pip_upgrade_command_rejects_empty_package_list():
    with pytest.raises(ValueError):
        pip_upgrade_command([])


def _pip_ok(calls):
    def run(command, **kwargs):
        calls.append(command)
        return subprocess.CompletedProcess(command, 0, "", "")
    return run


def test_the_update_runs_to_completion_before_the_tools_are_imported(monkeypatch):
    calls = []
    monkeypatch.setattr(subprocess, "run", _pip_ok(calls))
    monkeypatch.delitem(sys.modules, "yt_dlp", raising=False)

    assert apply_runtime_updates({"YTDLP_AUTO_UPDATE": "true"}) is True
    assert len(calls) == 2
    assert calls[0][3] == "download"
    assert "--no-index" in calls[1]


def test_an_already_imported_tool_is_never_replaced_under_itself(monkeypatch):
    calls = []
    monkeypatch.setattr(subprocess, "run", _pip_ok(calls))
    monkeypatch.setitem(sys.modules, "yt_dlp", object())

    assert apply_runtime_updates({"YTDLP_AUTO_UPDATE": "true"}) is False
    assert calls == []


def test_a_packaged_build_has_no_pip_to_run(monkeypatch):
    calls = []
    monkeypatch.setattr(subprocess, "run", _pip_ok(calls))
    monkeypatch.setattr(sys, "frozen", True, raising=False)

    assert apply_runtime_updates({"YTDLP_AUTO_UPDATE": "true"}) is False
    assert calls == []


def test_nothing_runs_when_no_update_is_enabled(monkeypatch):
    calls = []
    monkeypatch.setattr(subprocess, "run", _pip_ok(calls))
    monkeypatch.delenv("YTDLP_AUTO_UPDATE", raising=False)
    monkeypatch.delenv("CURL_CFFI_AUTO_UPDATE", raising=False)

    assert apply_runtime_updates({}) is False
    assert calls == []


def test_a_failed_or_hung_pip_does_not_stop_the_start(monkeypatch):
    def hung(command, **kwargs):
        raise subprocess.TimeoutExpired(command, kwargs.get("timeout"))

    monkeypatch.setattr(subprocess, "run", hung)
    monkeypatch.delitem(sys.modules, "yt_dlp", raising=False)
    assert apply_runtime_updates({"YTDLP_AUTO_UPDATE": "true"}) is False


ROOT = Path(__file__).resolve().parents[1]


def _fresh(code: str, tmp_path: Path) -> str:
    import os

    # Isolate legacy migration sources before importing any runtime module.
    disposable_home = tmp_path / "home"
    disposable_home.mkdir(exist_ok=True)
    env = {**os.environ, "HOME": str(disposable_home),
           "USERPROFILE": str(disposable_home),
           "APPDATA": str(disposable_home / "appdata"),
           "LOCALAPPDATA": str(disposable_home / "localappdata"),
           "XDG_CONFIG_HOME": str(disposable_home / "config"),
           "XDG_DATA_HOME": str(disposable_home / "data"),
           "XDG_CACHE_HOME": str(disposable_home / "cache"),
           "SOUNDSIBLE_CONFIG_DIR": str(tmp_path / "config"),
           "SOUNDSIBLE_DATA_DIR": str(tmp_path / "data"),
           "SOUNDSIBLE_CACHE_DIR": str(tmp_path / "cache"),
           "SOUNDSIBLE_LOG_DIR": str(tmp_path / "logs"),
           "SOUNDSIBLE_MUSIC_DIR": str(tmp_path / "music"),
           "PYTHONPATH": __import__("os").pathsep.join([str(ROOT), *filter(None, sys.path)])}
    for name in ("config", "data", "cache", "logs", "music"):
        (tmp_path / name).mkdir(exist_ok=True)
    lease = tmp_path / "tools.lock"
    code = ("import shared.runtime_updates as updates\n"
            f"from pathlib import Path\nupdates._tool_lease_path = lambda prefix=None: Path({str(lease)!r})\n" + code)
    result = subprocess.run([sys.executable, "-c", code], cwd=ROOT, env=env,
                            capture_output=True, text=True, timeout=120, start_new_session=True)
    assert result.returncode == 0, result.stderr[-2000:]
    return result.stdout.strip().splitlines()[-1]


@pytest.mark.parametrize("module", ["shared.engine_start", "shared.container_entrypoint", "shared.desktop_engine_entry"])
def test_importing_an_entry_point_loads_neither_tool(module, tmp_path):
    """Module-level and transitive imports count: they all happen before pip."""
    loaded = _fresh(
        f"import sys, {module}; print(sorted(m for m in ('yt_dlp', 'curl_cffi', 'shared.api') if m in sys.modules))",
        tmp_path,
    )
    assert loaded == "[]"


def test_the_daemon_runs_pip_before_it_imports_the_api(tmp_path):
    """Stub pip and the API; pip runs first, with neither tool loaded."""
    order = _fresh(
        """
import subprocess, sys, types
events = []
def fake_pip(command, **kwargs):
    events.append(("pip", "yt_dlp" in sys.modules, "curl_cffi" in sys.modules))
    return subprocess.CompletedProcess(command, 0, "", "")
subprocess.run = fake_pip
api = types.ModuleType("shared.api")
api.start_api = lambda **kwargs: events.append(("start_api",))
sys.modules["shared.api"] = api
import shared.downloader.settings as settings
settings.read_settings = lambda: {"YTDLP_AUTO_UPDATE": "true"}
from shared.engine_start import start_engine
start_engine(types.SimpleNamespace(host="127.0.0.1", port=0))
print(events)
""",
        tmp_path,
    )
    assert order == "[('pip', False, False), ('pip', False, False), ('start_api',)]"


def test_the_desktop_engine_never_runs_pip(tmp_path):
    order = _fresh(
        """
import subprocess, sys, types
events = []
subprocess.run = lambda command, **kwargs: events.append("pip")
api = types.ModuleType("shared.api")
api.start_api = lambda **kwargs: events.append("start_api")
sys.modules["shared.api"] = api
import shared.downloader.settings as settings
settings.read_settings = lambda: {"YTDLP_AUTO_UPDATE": "true"}
from shared.engine_start import start_engine
start_engine(types.SimpleNamespace(host="127.0.0.1", port=0), update_tools=False)
print(events)
""",
        tmp_path,
    )
    assert order == "['start_api']"


def test_the_container_only_warns(caplog):
    import logging

    from shared.runtime_updates import warn_updates_need_a_new_image

    with caplog.at_level(logging.WARNING):
        warn_updates_need_a_new_image({"YTDLP_AUTO_UPDATE": "true"})
    assert "pull a newer image" in caplog.text


def test_run_py_imports_nothing_heavy_before_it_starts_the_engine():
    """run.py re-executes itself into the venv when imported, so it is read,
    not imported: nothing at its module level may pull in the API or a tool."""
    import ast

    tree = ast.parse((ROOT / "run.py").read_text(encoding="utf-8"))
    top = [n for n in tree.body if isinstance(n, (ast.Import, ast.ImportFrom))]
    names = {alias.name for n in top if isinstance(n, ast.Import) for alias in n.names}
    names |= {n.module for n in top if isinstance(n, ast.ImportFrom) and n.module}
    assert not {m for m in names if m.split(".")[0] in {"yt_dlp", "curl_cffi"} or m.startswith("shared.api")
                or m.startswith("shared.downloader")}


def test_only_the_download_has_a_kill_deadline(monkeypatch):
    calls = []

    def pip(command, **kwargs):
        calls.append((command, kwargs))
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(subprocess, "run", pip)
    monkeypatch.delitem(sys.modules, "yt_dlp", raising=False)
    assert apply_runtime_updates({"YTDLP_AUTO_UPDATE": "true"})
    assert calls[0][1]["timeout"] == 120
    assert calls[1][1]["timeout"] is None
    if os.name == "nt":
        assert (calls[0][1]["startupinfo"].lpAttributeList["handle_list"]
                == calls[1][1]["startupinfo"].lpAttributeList["handle_list"])
    else:
        assert calls[0][1]["pass_fds"] == calls[1][1]["pass_fds"]
        assert calls[1][1]["pass_fds"]
    assert "--only-binary=:all:" in calls[0][0]


def test_a_download_failure_never_starts_installation(monkeypatch):
    calls = []

    def fail(command, **kwargs):
        calls.append(command)
        return subprocess.CompletedProcess(command, 1, "", "offline")

    monkeypatch.setattr(subprocess, "run", fail)
    monkeypatch.delitem(sys.modules, "yt_dlp", raising=False)
    assert not apply_runtime_updates({"YTDLP_AUTO_UPDATE": "true"})
    assert len(calls) == 1
    assert calls[0][3] == "download"


def test_an_engine_holding_a_shared_lease_prevents_another_update(tmp_path):
    result = _fresh(
        """
import subprocess, sys
from shared.runtime_updates import runtime_tool_session
lease_path = str(updates._tool_lease_path())
code = ("from pathlib import Path; import shared.runtime_updates as u; "
        f"u._tool_lease_path = lambda prefix=None: Path({lease_path!r}); "
        "lease = u.runtime_tool_session(); lease.__enter__(); "
        "print('ready', flush=True); input()")
reader = subprocess.Popen([sys.executable, '-c', code], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
try:
    assert reader.stdout.readline().strip() == 'ready'
    def forbidden(*args, **kwargs):
        raise AssertionError('pip must not run while another engine holds a lease')
    real_run = subprocess.run
    subprocess.run = forbidden
    with runtime_tool_session(update_tools=True, file_env={'YTDLP_AUTO_UPDATE': 'true'}) as updated:
        assert updated is False
    subprocess.run = real_run
finally:
    reader.communicate('stop' + chr(10), timeout=10)
print('protected')
""",
        tmp_path,
    )
    assert result == "protected"


@pytest.mark.skipif(os.name == "nt", reason="POSIX raw-lock contention probe")
def test_a_reader_waits_until_an_installing_process_releases_its_lease(tmp_path):
    result = _fresh(
        """
import fcntl, select, subprocess, sys
from shared.runtime_updates import runtime_tool_session
lease_path = updates._tool_lease_path()
with lease_path.open('w') as writer:
    fcntl.flock(writer, fcntl.LOCK_EX)
    code = ("from pathlib import Path; import shared.runtime_updates as u; "
            f"u._tool_lease_path = lambda prefix=None: Path({str(lease_path)!r}); "
            "print('waiting', flush=True); "
            "lease = u.runtime_tool_session(); lease.__enter__(); print('reading', flush=True)")
    reader = subprocess.Popen([sys.executable, '-c', code], stdout=subprocess.PIPE, text=True)
    try:
        assert reader.stdout.readline().strip() == 'waiting'
        assert select.select([reader.stdout], [], [], 0.2)[0] == []
        fcntl.flock(writer, fcntl.LOCK_UN)
        output, _ = reader.communicate(timeout=10)
        assert output.strip() == 'reading'
        assert reader.returncode == 0
    finally:
        if reader.poll() is None:
            reader.kill()
            reader.wait()
print('ordered')
""",
        tmp_path,
    )
    assert result == "ordered"


def test_the_real_run_py_daemon_branch_preserves_update_import_order(tmp_path):
    result = _fresh(
        """
import ast, importlib.abc, importlib.util, json, os, subprocess, sys
from pathlib import Path
from shared.cooperative import patch_process
patch_process()
events = []
def pip(command, **kwargs):
    if command[2:4] == ['pip', 'install'] or command[2:4] == ['pip', 'download']:
        events.append((command[3], 'yt_dlp' in sys.modules, 'curl_cffi' in sys.modules))
    return subprocess.CompletedProcess(command, 0, '', '')
subprocess.run = pip
class Api(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    def find_spec(self, fullname, path, target=None):
        if fullname == 'shared.api':
            return importlib.util.spec_from_loader(fullname, self, is_package=True)
    def create_module(self, spec):
        return None
    def exec_module(self, module):
        events.append(('api_import',))
        module.start_api = lambda **kwargs: events.append(('start_api',))
sys.meta_path.insert(0, Api())
import shared.downloader.settings as settings
settings.read_settings = lambda: {'YTDLP_AUTO_UPDATE': 'true'}
config = Path(os.environ['SOUNDSIBLE_CONFIG_DIR'])
config.mkdir(parents=True, exist_ok=True)
(config / 'config.json').write_text('{}')
sys.argv = ['run.py', '--daemon', '--host', '127.0.0.1', '--port', '0']
source = Path('run.py')
launcher_root = config.parent / 'launcher'
venv = launcher_root / 'venv'
binary = venv / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
binary.parent.mkdir(parents=True)
binary.touch()
(launcher_root / 'requirements.txt').write_text('yt-dlp' + chr(10))
sys.prefix = str(venv)
# Only external subprocess and API effects are replaced. Bootstrap and the
# real --daemon dispatch run, with every path under the disposable home.
try:
    exec(compile(source.read_text(), str(source), 'exec'),
         {'__name__': '__main__', '__file__': str(launcher_root / 'run.py')})
except SystemExit as error:
    assert error.code == 0
print(json.dumps(events))
""",
        tmp_path,
    )
    import json

    assert json.loads(result) == [["install", False, False], ["install", False, False],
                                  ["download", False, False], ["install", False, False],
                                  ["api_import"], ["start_api"]]


@pytest.mark.parametrize("updates", [False, True])
def test_an_unsupported_lock_backend_skips_updates_without_stopping_startup(monkeypatch, updates):
    import errno
    from shared.environment_lock import backend

    locker = backend()

    def unsupported(*args):
        raise OSError(errno.ENOTSUP, "locking unsupported")

    monkeypatch.setattr(locker, "flock", unsupported)
    monkeypatch.setattr("shared.environment_lock.backend", lambda: locker)
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: pytest.fail("unguarded pip"))
    with runtime_tool_session(update_tools=updates, file_env={"YTDLP_AUTO_UPDATE": "true"}) as updated:
        assert updated is False


def test_full_temporary_storage_skips_the_update_without_stopping_startup(monkeypatch):
    import errno
    import tempfile

    def full(*args, **kwargs):
        raise OSError(errno.ENOSPC, "temporary storage full")

    monkeypatch.setattr(tempfile, "TemporaryDirectory", full)
    monkeypatch.delitem(sys.modules, "yt_dlp", raising=False)
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: pytest.fail("unguarded pip"))
    assert not apply_runtime_updates({"YTDLP_AUTO_UPDATE": "true"})


@pytest.mark.skipif(os.name == "nt", reason="POSIX terminal process-group signals")
@pytest.mark.parametrize("signum", [2, 15])
def test_normal_shutdown_waits_for_the_installer_to_finish(tmp_path, signum):
    result = _fresh(
        f"""
import os, signal, subprocess, sys
from pathlib import Path
from shared.cooperative import patch_process
patch_process()
from shared.runtime_updates import run_install_transaction
finished = Path(os.environ['SOUNDSIBLE_DATA_DIR']) / 'finished'
child = ("import os, signal, sys, time; from pathlib import Path; "
         "os.killpg(int(sys.argv[1]), int(sys.argv[2])); "
         "time.sleep(0.2); Path(sys.argv[3]).write_text('whole')")
with updates._tool_lease_path().open('w') as lease:
    try:
        run_install_transaction([sys.executable, '-c', child, str(os.getpid()), '{signum}', str(finished)],
                                lease_fd=lease.fileno(), capture_output=True, text=True)
        raise AssertionError('shutdown was not honored')
    except (KeyboardInterrupt, SystemExit):
        assert finished.read_text() == 'whole'
print('finished-before-shutdown')
""",
        tmp_path,
    )
    assert result == 'finished-before-shutdown'


def test_bootstrap_cannot_install_while_an_engine_uses_the_environment(tmp_path):
    result = _fresh(
        """
import argparse, ast, hashlib, os, platform, shutil, subprocess, sys
from pathlib import Path
from shared.runtime_updates import runtime_tool_session
root = Path(os.environ['SOUNDSIBLE_DATA_DIR']) / 'launcher'
venv = root / 'venv'
binary = venv / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
binary.parent.mkdir(parents=True)
binary.touch()
(root / 'requirements.txt').write_text('yt-dlp' + chr(10))
sys.prefix = str(venv)
commands = []
def fake_run(command, **kwargs):
    commands.append(command)
    return subprocess.CompletedProcess(command, 0, '', '')
subprocess.run = fake_run
source = ast.parse(Path('run.py').read_text())
names = {'_venv_python_path', '_venv_has_pip', '_venv_can_import', '_running_in_project_venv',
         '_recreate_venv', '_ensure_venv_with_pip', '_ensure_bootstrap_before_gevent', '_ensure_bootstrap_locked'}
tree = ast.Module(body=[node for node in source.body if isinstance(node, ast.FunctionDef) and node.name in names], type_ignores=[])
namespace = dict(globals(), __file__=str(root / 'run.py'))
exec(compile(tree, 'run.py', 'exec'), namespace)
with runtime_tool_session():
    try:
        namespace['_ensure_bootstrap_before_gevent']()
        raise AssertionError('bootstrap was allowed to modify a running environment')
    except RuntimeError as error:
        assert 'another engine' in str(error)
assert not any('install' in command for command in commands)
assert not (venv / '.installed_requirements_hash').exists()
print('bootstrap-protected')
""",
        tmp_path,
    )
    assert result == 'bootstrap-protected'


def test_launcher_retains_its_lease_across_dependency_imports(tmp_path):
    result = _fresh(
        """
import subprocess, sys
from pathlib import Path
from shared.runtime_updates import prepare_launcher_environment
prepare_launcher_environment(Path(sys.prefix), lambda lease: None)
# This dependency remains loaded between bootstrap and engine startup.
import gevent
code = ("from pathlib import Path; import shared.runtime_updates as u; "
        f"u._tool_lease_path = lambda prefix=None: Path({str(updates._tool_lease_path())!r}); "
        "session = u.bootstrap_tool_session(Path(__import__('sys').prefix)); "
        "lease = session.__enter__(); lease.require_write()")
probe = subprocess.run([sys.executable, '-c', code], capture_output=True, text=True)
assert probe.returncode != 0
assert 'another engine' in probe.stderr
assert 'gevent' in sys.modules
# The same descriptor, not a second reader, is used for the engine session.
assert updates._launcher_lease is not None
with updates._runtime_lease() as lease:
    assert lease is updates._launcher_lease
print('continuously-protected')
""",
        tmp_path,
    )
    assert result == 'continuously-protected'


def test_a_failed_wait_notification_never_bypasses_the_installer(tmp_path):
    result = _fresh(
        """
import os, subprocess, sys, threading
from pathlib import Path
from shared.runtime_updates import runtime_tool_session
ready = threading.Event()
marker = Path(os.environ['SOUNDSIBLE_DATA_DIR']) / 'finished'
code = ("from pathlib import Path; import shared.runtime_updates as u; "
        f"u._tool_lease_path = lambda prefix=None: Path({str(updates._tool_lease_path())!r}); "
        "session = u.bootstrap_tool_session(Path(__import__('sys').prefix)); "
        "lease = session.__enter__(); lease.require_write(); "
        "print('ready', flush=True); input(); "
        f"Path({str(marker)!r}).write_text('whole')")
writer = subprocess.Popen([sys.executable, '-c', code], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
assert writer.stdout.readline().strip() == 'ready'
def release():
    assert ready.wait(5)
    writer.communicate('release' + chr(10), timeout=10)
worker = threading.Thread(target=release)
worker.start()
def broken_marker(waiting):
    ready.set()
    raise IsADirectoryError('marker destination is a directory')
try:
    with runtime_tool_session(on_wait=broken_marker):
        assert marker.read_text() == 'whole'
finally:
    ready.set()
    worker.join(10)
    if writer.poll() is None:
        writer.kill()
        writer.wait()
assert not worker.is_alive()
print('waited-despite-marker-error')
""",
        tmp_path,
    )
    assert result == 'waited-despite-marker-error'


def test_desktop_entry_waits_before_dependency_imports_and_reports_on_its_pipe(tmp_path):
    result = _fresh(
        """
import json, os, subprocess, sys
from pathlib import Path
entry = Path('soundsible_engine.py').resolve()
music = Path(os.environ['SOUNDSIBLE_MUSIC_DIR'])
config = Path(os.environ['SOUNDSIBLE_CONFIG_DIR']) / 'config.json'
code = ("from pathlib import Path; import sys; import shared.runtime_updates as u; "
        f"u._tool_lease_path = lambda prefix=None: Path({str(updates._tool_lease_path())!r}); "
        f"sys.argv = [{str(entry)!r}, '--bootstrap', {str(music)!r}]; "
        f"exec(compile(Path({str(entry)!r}).read_text(), {str(entry)!r}, 'exec'), "
        f"{{'__name__': '__main__', '__file__': {str(entry)!r}}})")
with updates.bootstrap_tool_session(Path(sys.prefix)) as writer:
    writer.require_write()
    reader = subprocess.Popen([sys.executable, '-c', code], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        assert json.loads(reader.stdout.readline()) == {'event': 'waiting_for_tools', 'waiting': True}
        assert not config.exists()
    except BaseException:
        reader.kill()
        reader.communicate()
        raise
output, error = reader.communicate(timeout=20)
assert reader.returncode == 0, error
assert json.loads(output.splitlines()[0]) == {'event': 'waiting_for_tools', 'waiting': False}
assert config.exists()
print('desktop-entry-protected')
""",
        tmp_path,
    )
    assert result == 'desktop-entry-protected'


def test_windows_repeated_shared_reads_never_unlock_the_loaded_environment(monkeypatch):
    # Exercise the real adapter on every platform. The kernel double counts
    # native calls; actual Windows process contention also runs in Desktop Build.
    import ctypes
    import types

    from shared.environment_lock import _WindowsLocks

    events = []

    class Kernel:
        def LockFileEx(self, *args):
            events.append("lock")
            return True

        def UnlockFileEx(self, *args):
            events.append("unlock")
            return True

    adapter = _WindowsLocks.__new__(_WindowsLocks)
    adapter._ctypes = ctypes
    adapter._overlapped = ctypes.c_int
    adapter._kernel = Kernel()
    adapter._locked = {}
    monkeypatch.setitem(sys.modules, "msvcrt", types.SimpleNamespace(get_osfhandle=lambda fd: fd))
    file = types.SimpleNamespace(fileno=lambda: 42)
    adapter.flock(file, adapter.LOCK_SH)
    adapter.flock(file, adapter.LOCK_SH | adapter.LOCK_NB)
    adapter.flock(file, adapter.LOCK_SH)
    assert events == ["lock"]  # No interval in which a writer can enter.
    adapter.flock(file, adapter.LOCK_EX | adapter.LOCK_NB)
    assert events == ["lock", "unlock", "lock"]
    assert adapter._locked[42] == adapter.LOCK_EX
