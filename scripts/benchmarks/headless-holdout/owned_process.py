"""Start and clean up only processes owned by this evaluator.

Windows children start suspended, enter a non-inheritable kill-on-close Job
Object, and resume only after assignment succeeds. No breakaway job limits are
enabled. Closing an Owned instance kills the job even if its initial process has
already exited. No PID discovery, taskkill, or unrelated-process cleanup is used.

POSIX children start in a new session and cleanup signals that process group.
This is weaker containment: descendants that deliberately call setsid/setpgid
can escape it. Call close promptly; callers must not reuse the stored group ID.

Owned.process is the ordinary Popen object. Callers that read its output on their
own threads should let those readers reach EOF and join them after close().
"""

import os
import signal
import subprocess
import threading
import time


if os.name == "nt":
    import ctypes
    from ctypes import wintypes

    class _BasicLimit(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_longlong),
            ("PerJobUserTimeLimit", ctypes.c_longlong),
            ("LimitFlags", wintypes.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD),
        ]

    class _IoCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_ulonglong) for name in (
            "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
            "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

    class _ExtendedLimit(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", _BasicLimit),
            ("IoInfo", _IoCounters),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    class _Accounting(ctypes.Structure):
        _fields_ = [
            ("TotalUserTime", ctypes.c_longlong),
            ("TotalKernelTime", ctypes.c_longlong),
            ("ThisPeriodTotalUserTime", ctypes.c_longlong),
            ("ThisPeriodTotalKernelTime", ctypes.c_longlong),
            ("TotalPageFaultCount", wintypes.DWORD),
            ("TotalProcesses", wintypes.DWORD),
            ("ActiveProcesses", wintypes.DWORD),
            ("TotalTerminatedProcesses", wintypes.DWORD),
        ]

    _kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    _native = ctypes.WinDLL("ntdll")
    _kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    _kernel.CreateJobObjectW.restype = wintypes.HANDLE
    _kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    _kernel.SetInformationJobObject.restype = wintypes.BOOL
    _kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    _kernel.AssignProcessToJobObject.restype = wintypes.BOOL
    _kernel.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
    _kernel.TerminateJobObject.restype = wintypes.BOOL
    _kernel.QueryInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p,
                                                wintypes.DWORD, ctypes.c_void_p]
    _kernel.QueryInformationJobObject.restype = wintypes.BOOL
    _kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    _kernel.CloseHandle.restype = wintypes.BOOL
    _native.NtResumeProcess.argtypes = [wintypes.HANDLE]
    _native.NtResumeProcess.restype = ctypes.c_long


class Owned:
    """Ownership handle; always close it, including after process.wait()."""

    def __init__(self, process, job=None):
        self.process = process
        self._job = job
        self._group = process.pid if os.name != "nt" else None
        self._lock = threading.RLock()
        self._closed = False
        self._stopped = False

    def _stop_tree(self):
        with self._lock:
            if self._stopped:
                return
            if os.name == "nt":
                job, self._job = self._job, None
                try:
                    if not _kernel.TerminateJobObject(job, 1):
                        raise ctypes.WinError(ctypes.get_last_error())
                    deadline = time.monotonic() + 5
                    while True:
                        accounting = _Accounting()
                        if not _kernel.QueryInformationJobObject(job, 1, ctypes.byref(accounting),
                                                                 ctypes.sizeof(accounting), None):
                            raise ctypes.WinError(ctypes.get_last_error())
                        if accounting.ActiveProcesses == 0:
                            break
                        if time.monotonic() >= deadline:
                            raise TimeoutError("owned job did not terminate within five seconds")
                        time.sleep(.01)
                finally:
                    # KILL_ON_JOB_CLOSE remains a fail-closed fallback if query or
                    # explicit termination fails. The job handle is never inherited.
                    if not _kernel.CloseHandle(job):
                        raise ctypes.WinError(ctypes.get_last_error())
            else:
                try:
                    os.killpg(self._group, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            self.process.wait(timeout=5)
            self._stopped = True

    def close(self):
        """Terminate/wait the owned tree and close Popen pipes; safe to repeat."""
        with self._lock:
            if self._closed:
                return
            try:
                self._stop_tree()
            finally:
                for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
                    if stream is not None:
                        try:
                            stream.close()
                        except (OSError, ValueError):
                            pass
                if os.name == "nt" and self.process.returncode is not None:
                    self.process._handle.Close()
                self._closed = True

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def spawn(command, **kwargs):
    """Return Owned with its normal Popen in .process; setup fails closed."""
    if os.name != "nt":
        if kwargs.get("start_new_session") is False:
            raise ValueError("owned processes require a new session")
        if kwargs.get("process_group") not in (None, -1):
            raise ValueError("owned processes require their own process group")
        kwargs["start_new_session"] = True
        return Owned(subprocess.Popen(command, **kwargs))

    # SECURITY_ATTRIBUTES=NULL makes this unnamed handle non-inheritable.
    job = _kernel.CreateJobObjectW(None, None)
    if not job:
        raise ctypes.WinError(ctypes.get_last_error())
    process = None
    try:
        limits = _ExtendedLimit()
        limits.BasicLimitInformation.LimitFlags = 0x00002000  # KILL_ON_JOB_CLOSE
        if not _kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            raise ctypes.WinError(ctypes.get_last_error())
        kwargs["creationflags"] = kwargs.get("creationflags", 0) | 0x00000004  # CREATE_SUSPENDED
        process = subprocess.Popen(command, **kwargs)
        # CPython retains the CreateProcess handle but closes the primary-thread
        # handle. NtResumeProcess therefore resumes without reopening any PID.
        handle = wintypes.HANDLE(int(process._handle))
        if not _kernel.AssignProcessToJobObject(job, handle):
            raise ctypes.WinError(ctypes.get_last_error())
        status = _native.NtResumeProcess(handle)
        if status < 0:
            raise OSError("NtResumeProcess failed (NTSTATUS 0x%08x)" % (status & 0xffffffff))
        return Owned(process, job)
    except BaseException:
        # Before resume this cannot execute authored code; after assignment the
        # job additionally contains every descendant if a later step fails.
        _kernel.CloseHandle(job)
        if process is not None:
            try:
                process.kill()
            except OSError:
                pass
            process.wait(timeout=5)
            for stream in (process.stdin, process.stdout, process.stderr):
                if stream is not None:
                    try:
                        stream.close()
                    except (OSError, ValueError):
                        pass
            process._handle.Close()
        raise


def run(command, *, timeout=None, input=None, check=False, capture_output=False, **kwargs):
    """subprocess.run equivalent whose normal/error/timeout paths close ownership."""
    if input is not None:
        if kwargs.get("stdin") is not None:
            raise ValueError("stdin and input arguments may not both be used")
        kwargs["stdin"] = subprocess.PIPE
    if capture_output:
        if kwargs.get("stdout") is not None or kwargs.get("stderr") is not None:
            raise ValueError("stdout/stderr may not be used with capture_output")
        kwargs["stdout"] = kwargs["stderr"] = subprocess.PIPE
    owned = spawn(command, **kwargs)
    try:
        try:
            stdout, stderr = owned.process.communicate(input, timeout=timeout)
        except subprocess.TimeoutExpired:
            owned._stop_tree()
            stdout, stderr = owned.process.communicate()
            raise subprocess.TimeoutExpired(command, timeout, output=stdout, stderr=stderr) from None
        result = subprocess.CompletedProcess(owned.process.args, owned.process.returncode, stdout, stderr)
        if check:
            result.check_returncode()
        return result
    finally:
        owned.close()
