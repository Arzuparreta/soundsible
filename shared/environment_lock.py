"""Shared environment leases using the platform's native file locks."""
from __future__ import annotations

import os
from contextlib import contextmanager


def backend():
    if os.name != "nt":
        import fcntl

        return fcntl
    return _WindowsLocks()


class _WindowsLocks:
    LOCK_SH, LOCK_EX, LOCK_NB, LOCK_UN = 1, 2, 4, 8

    def __init__(self):
        import ctypes
        from ctypes import wintypes

        class Overlapped(ctypes.Structure):
            _fields_ = [("Internal", ctypes.c_size_t), ("InternalHigh", ctypes.c_size_t),
                        ("Offset", wintypes.DWORD), ("OffsetHigh", wintypes.DWORD),
                        ("hEvent", wintypes.HANDLE)]

        self._ctypes = ctypes
        self._overlapped = Overlapped
        self._kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        args = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD,
                wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(Overlapped)]
        self._kernel.LockFileEx.argtypes = args
        self._kernel.LockFileEx.restype = wintypes.BOOL
        self._kernel.UnlockFileEx.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD,
                                             wintypes.DWORD, ctypes.POINTER(Overlapped)]
        self._kernel.UnlockFileEx.restype = wintypes.BOOL
        self._locked = {}

    def flock(self, file, flags):
        import errno
        import msvcrt

        handle = msvcrt.get_osfhandle(file.fileno())
        mode = self.LOCK_UN if flags == self.LOCK_UN else (self.LOCK_EX if flags & self.LOCK_EX else self.LOCK_SH)
        if self._locked.get(handle) == mode:
            return
        overlapped = self._overlapped()
        if handle in self._locked:
            if not self._kernel.UnlockFileEx(handle, 0, 1, 0, self._ctypes.byref(overlapped)):
                raise self._ctypes.WinError(self._ctypes.get_last_error())
            self._locked.pop(handle)
        if flags == self.LOCK_UN:
            return
        native = (2 if flags & self.LOCK_EX else 0) | (1 if flags & self.LOCK_NB else 0)
        if not self._kernel.LockFileEx(handle, native, 0, 1, 0, self._ctypes.byref(overlapped)):
            error = self._ctypes.get_last_error()
            if error == 33:  # ERROR_LOCK_VIOLATION
                raise BlockingIOError(errno.EAGAIN, "Environment lease is held by another process")
            raise self._ctypes.WinError(error)
        self._locked[handle] = mode


@contextmanager
def child_options(fd):
    """Pass the lease to a child, including a Windows handle-list spawn."""
    if os.name != "nt":
        yield {"pass_fds": (fd,)}
        return
    import msvcrt
    import subprocess

    handle = msvcrt.get_osfhandle(fd)
    inherited = os.get_handle_inheritable(handle)
    os.set_handle_inheritable(handle, True)
    try:
        startup = subprocess.STARTUPINFO()
        startup.lpAttributeList = {"handle_list": [handle]}
        yield {"startupinfo": startup}
    finally:
        os.set_handle_inheritable(handle, inherited)
