"""Own a suspended child's descendants before letting its primary thread run.

KILL_ON_JOB_CLOSE also covers a parent that exits while FFmpeg keeps stdout
open. taskkill /T alone cannot discover that tree once its parent has exited.
"""
import ctypes
from ctypes import wintypes as w


class _Limits(ctypes.Structure):
    _fields_ = [('process_time', ctypes.c_longlong), ('job_time', ctypes.c_longlong),
                ('flags', w.DWORD), ('min_working_set', ctypes.c_size_t),
                ('max_working_set', ctypes.c_size_t), ('processes', w.DWORD),
                ('affinity', ctypes.c_size_t), ('priority', w.DWORD), ('scheduling', w.DWORD)]


class _IO(ctypes.Structure):
    _fields_ = [(name, ctypes.c_ulonglong) for name in
                ('read_ops', 'write_ops', 'other_ops', 'read_bytes', 'write_bytes', 'other_bytes')]


class _Extended(ctypes.Structure):
    _fields_ = [('basic', _Limits), ('io', _IO), ('process_memory', ctypes.c_size_t),
                ('job_memory', ctypes.c_size_t), ('peak_process_memory', ctypes.c_size_t),
                ('peak_job_memory', ctypes.c_size_t)]


class _Thread(ctypes.Structure):
    _fields_ = [('size', w.DWORD), ('usage', w.DWORD), ('id', w.DWORD), ('owner', w.DWORD),
                ('base_priority', w.LONG), ('delta_priority', w.LONG), ('flags', w.DWORD)]


class ProcessJob:
    def __init__(self, process):
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        self.kernel, self.handle = kernel, None
        for name, restype, argtypes in (
            ('CreateJobObjectW', w.HANDLE, [ctypes.c_void_p, w.LPCWSTR]),
            ('SetInformationJobObject', w.BOOL, [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD]),
            ('AssignProcessToJobObject', w.BOOL, [w.HANDLE, w.HANDLE]),
            ('CreateToolhelp32Snapshot', w.HANDLE, [w.DWORD, w.DWORD]),
            ('Thread32First', w.BOOL, [w.HANDLE, ctypes.POINTER(_Thread)]),
            ('Thread32Next', w.BOOL, [w.HANDLE, ctypes.POINTER(_Thread)]),
            ('OpenThread', w.HANDLE, [w.DWORD, w.BOOL, w.DWORD]),
            ('ResumeThread', w.DWORD, [w.HANDLE]),
            ('CloseHandle', w.BOOL, [w.HANDLE]),
        ):
            fn = getattr(kernel, name)
            fn.restype, fn.argtypes = restype, argtypes
        self.handle = kernel.CreateJobObjectW(None, None)
        snapshot = None
        try:
            if not self.handle:
                raise ctypes.WinError(ctypes.get_last_error())
            limits = _Extended()
            limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if not kernel.SetInformationJobObject(self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
                raise ctypes.WinError(ctypes.get_last_error())
            if not kernel.AssignProcessToJobObject(self.handle, int(process._handle)):
                raise ctypes.WinError(ctypes.get_last_error())
            snapshot = kernel.CreateToolhelp32Snapshot(4, 0)  # TH32CS_SNAPTHREAD
            if snapshot == ctypes.c_void_p(-1).value:
                snapshot = None
                raise ctypes.WinError(ctypes.get_last_error())
            entry = _Thread()
            entry.size = ctypes.sizeof(entry)
            more = kernel.Thread32First(snapshot, ctypes.byref(entry))
            while more:
                if entry.owner == process.pid:
                    thread = kernel.OpenThread(2, False, entry.id)  # THREAD_SUSPEND_RESUME
                    if not thread:
                        raise ctypes.WinError(ctypes.get_last_error())
                    try:
                        if kernel.ResumeThread(thread) == 0xffffffff:
                            raise ctypes.WinError(ctypes.get_last_error())
                    finally:
                        kernel.CloseHandle(thread)
                    return
                more = kernel.Thread32Next(snapshot, ctypes.byref(entry))
            raise OSError('Suspended child primary thread was not found')
        except BaseException:
            self.close()
            raise
        finally:
            if snapshot:
                kernel.CloseHandle(snapshot)

    def close(self):
        if self.handle:
            self.kernel.CloseHandle(self.handle)
            self.handle = None
