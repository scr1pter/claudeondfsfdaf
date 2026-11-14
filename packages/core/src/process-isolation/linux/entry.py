"""ABI1 immutable Linux namespace entry asset. Not installed or activated by this source package.

Only prepare/broker/cleanup run as root. Broker authority is exactly three
secret-free namespace descriptors; it never executes a client command. Generic
commands execute behind a per-command PID1 ownership barrier, never in the
credential holder's namespace. Runtime and cancellation qualification are CI-only.
"""

import array
import ctypes
import errno
import fcntl
import hashlib
import json
import os
import pathlib
import pwd
import resource
import re
import select
import signal
import socket
import stat
import struct
import subprocess
import sys
import time

ROOT = "/usr/libexec/vector-sandbox/v1"
SELF = ROOT + "/entry.py"
SPEC = ROOT + "/run.json"
PRIVATE = ROOT + "/private/state.json"
CONTAINERS = ("/mnt/vector-agent-sandbox", "/var/lib/vector-agent-sandbox", "/home/vector-agent-sandbox")
HOST_TEMP = "/home/runner/work/_temp"
MASKS = ("/home/vector-agent", "/tmp", "/var/tmp", "/run", HOST_TEMP)
KINDS = {"user": 0x10000000, "mnt": 0x00020000, "pid": 0x20000000}
KEYS = {"v", "container", "uid", "gid", "stage", "scratch", "directory", "socket", "nonce", "namespaces",
        "devices", "keeper", "broker", "socketIdentity"}
BASE_KEYS = {"v", "container", "uid", "gid", "stage", "scratch", "directory", "socket", "nonce"}
SIGNALS = {signal.SIGTERM, signal.SIGINT, signal.SIGHUP}
NS_GET_USERNS = 0xB701
NS_GET_NSTYPE = 0xB703
NS_GET_OWNER_UID = 0xB704
LIBC = ctypes.CDLL(None, use_errno=True)
LIBC.close_range.argtypes = (ctypes.c_uint, ctypes.c_uint, ctypes.c_int)
LIBC.close_range.restype = ctypes.c_int
LIBC.prctl.argtypes = (ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong)
LIBC.prctl.restype = ctypes.c_int
LIBC.renameat2.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint)
LIBC.renameat2.restype = ctypes.c_int
LIBC.mount.argtypes = (ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_ulong, ctypes.c_void_p)
LIBC.mount.restype = ctypes.c_int
_DIAGNOSTIC_STAGE = "entry-start"


def control_failure(error):
    # Only fixed Root setup/cleanup operations expose enums. Command, broker and keeper failures retain
    # the existing generic message; never format exception args, messages, filenames, argv or state here.
    operation = "prepare" if len(sys.argv) == 5 and sys.argv[1] == "prepare" else (
        "cleanup" if sys.argv[1:] == ["cleanup"] else None)
    if operation is None:
        os.write(2, b"The fixed Linux isolation boundary refused this operation.\n")
        return
    classes = {"RuntimeError", "PermissionError", "FileNotFoundError", "ProcessLookupError", "NotADirectoryError",
               "FileExistsError", "BlockingIOError", "OSError", "ValueError", "KeyError", "IndexError",
               "TypeError", "AssertionError", "TimeoutExpired", "TimeoutError", "CalledProcessError", "JSONDecodeError",
               "UnicodeDecodeError", "BrokenPipeError", "EOFError", "OverflowError"}
    names = {"EPERM", "EACCES", "ENOENT", "ENOTDIR", "ELOOP", "EEXIST", "EBUSY", "EAGAIN", "EINVAL", "EBADF",
             "ESRCH", "EPIPE", "ETIMEDOUT", "ENOSYS", "EOPNOTSUPP", "ENOMEM", "EMFILE", "ENFILE", "EROFS",
             "EOVERFLOW", "EIO", "ENOSPC"}
    kind = type(error).__name__
    number = getattr(error, "errno", None)
    code = errno.errorcode.get(number) if type(number) is int else None
    result = getattr(error, "returncode", None)
    signals = {1:"SIGHUP", 2:"SIGINT", 3:"SIGQUIT", 4:"SIGILL", 6:"SIGABRT", 7:"SIGBUS", 8:"SIGFPE",
               9:"SIGKILL", 11:"SIGSEGV", 13:"SIGPIPE", 15:"SIGTERM", 24:"SIGXCPU", 25:"SIGXFSZ", 31:"SIGSYS"}
    record = {"v":1, "event":"native-control-failure", "origin":"entry", "operation":operation,
              "stage":_DIAGNOSTIC_STAGE, "class":kind if kind in classes else "Unknown",
              "errno":code if code in names else None,
              "exit":result if type(result) is int and 0 <= result <= 255 else None,
              "signal":signals.get(-result) if type(result) is int and result < 0 else None}
    encoded = ("VECTOR_NATIVE_CONTROL_FAILURE " + json.dumps(record, separators=(",", ":")) + "\n").encode("ascii")
    if len(encoded) <= 1024:
        os.write(2, encoded)


def require(condition, message="The fixed Linux isolation contract was refused"):
    if not condition:
        raise RuntimeError(message)


def integer(value):
    return type(value) is int and 0 < value <= 9007199254740991


def exact(value, keys):
    require(type(value) is dict and set(value) == set(keys))


def canonical(value):
    require(type(value) is str and len(value.encode("utf-8", "strict")) <= 4096 and value.startswith("/") and
            os.path.normpath(value) == value and not any(ord(char) < 32 or ord(char) == 127 for char in value))
    return value


def validate_spec(value, partial=False):
    require(type(value) is dict and BASE_KEYS <= set(value) <= KEYS)
    if not partial:
        exact(value, KEYS)
    require(type(value["v"]) is int and value["v"] == 1 and value["container"] in CONTAINERS and
            integer(value["uid"]) and integer(value["gid"]))
    for key in ("stage", "scratch", "directory", "socket"):
        canonical(value[key])
    require(value["stage"] == value["container"] + "/checkout" and
            value["scratch"] == value["container"] + "/tool-scratch" and
            value["directory"] == value["container"] + "/tool-namespaces" and
            value["socket"] == value["directory"] + "/broker.sock")
    require(type(value["nonce"]) is str and len(value["nonce"]) == 32 and
            all(char in "0123456789abcdef" for char in value["nonce"]))
    for key in ("namespaces", "devices"):
        if key in value:
            exact(value[key], KINDS)
            require(all(integer(item) for item in value[key].values()))
    for key in ("keeper", "broker"):
        if key not in value:
            continue
        exact(value[key], ("pid", "start", "uid", "gid") if key == "broker" else ("pid", "start"))
        require(integer(value[key]["pid"]) and value[key]["pid"] > 1 and type(value[key]["start"]) is str and
                1 <= len(value[key]["start"]) <= 32 and value[key]["start"].isascii() and
                value[key]["start"].isdigit() and not value[key]["start"].startswith("0"))
        if key == "broker":
            require(type(value[key]["uid"]) is int and type(value[key]["gid"]) is int and
                    value[key]["uid"] == value[key]["gid"] == 0)
    if "keeper" in value and "broker" in value:
        require(value["keeper"]["pid"] != value["broker"]["pid"])
    if "socketIdentity" in value:
        exact(value["socketIdentity"], ("device", "inode"))
        require(all(integer(item) for item in value["socketIdentity"].values()))
    return value


def secure_chain(name):
    resolved = pathlib.Path(name).resolve(strict=True)
    for part in (resolved, *resolved.parents):
        info = part.stat()
        require(info.st_uid == 0 and not info.st_mode & 0o022, "An immutable runtime path is writable")
    return str(resolved)


def read_json(name, owner=0):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == owner and
                not info.st_mode & 0o022 and info.st_size <= 65536)
        data = os.read(fd, 65537)
        require(len(data) == info.st_size and len(data) <= 65536)
        return json.loads(data.decode("utf-8", "strict"))
    finally:
        os.close(fd)


def write_json(name, value, mode, replace=False):
    temporary = name + "." + os.urandom(12).hex() + ".tmp"
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, mode)
    try:
        os.fchmod(fd, mode)
        data = json.dumps(value, separators=(",", ":")).encode("utf-8")
        require(len(data) <= 65536)
        with os.fdopen(fd, "wb", closefd=False) as opened:
            opened.write(data)
            opened.flush()
            os.fsync(fd)
        if replace:
            os.replace(temporary, name)
        else:
            # RENAME_NOREPLACE is the exclusive publication point, including between competing prepare writers.
            # No check-then-replace or link/unlink window may overwrite an existing owner or expose nlink=2.
            require(LIBC.renameat2(-100, os.fsencode(temporary), -100, os.fsencode(name), 1) == 0,
                    "An exclusive isolation record could not be published")
    finally:
        os.close(fd)
        if os.path.lexists(temporary):
            os.unlink(temporary)


def read_state():
    directory = os.lstat(ROOT + "/private")
    require(stat.S_ISDIR(directory.st_mode) and directory.st_uid == directory.st_gid == 0 and
            stat.S_IMODE(directory.st_mode) == 0o700 and os.path.realpath(ROOT + "/private") == ROOT + "/private")
    require(stat.S_IMODE(os.lstat(PRIVATE).st_mode) == 0o600)
    value = read_json(PRIVATE)
    exact(value, ("v", "public", "phase", "brokerPending", "runtimeImages", "maskSources"))
    require(type(value["v"]) is int and value["v"] == 1 and type(value["brokerPending"]) is bool and value["phase"] in
            ("recorded", "keeper-ready", "broker-pending", "adopted", "quiesced", "uid-stopped", "broker-stopped"))
    validate_spec(value["public"], partial=True)
    mask_records(value["maskSources"])
    require(type(value["runtimeImages"]) is dict and len(value["runtimeImages"]) <= 128)
    for name, digest in value["runtimeImages"].items():
        canonical(name)
        require(type(digest) is str and len(digest) == 64 and all(char in "0123456789abcdef" for char in digest))
    return value


def save_state(value):
    write_json(PRIVATE, value, 0o600, replace=True)


def identity(pid, expected=None):
    text = pathlib.Path(f"/proc/{pid}/stat").read_text()
    fields = text[text.rindex(")") + 2:].split()
    status = pathlib.Path(f"/proc/{pid}/status").read_text()
    users = next(line for line in status.splitlines() if line.startswith("Uid:")).split()[1:]
    require(len(users) == 4 and fields[19].isdigit())
    users = [int(item) for item in users]
    if expected is not None and expected not in users:
        return None
    require(len(set(users)) == 1, "A scoped process has mixed user credentials")
    return {"pid": pid, "start": fields[19], "uid": users[0], "state": fields[0]}


def arm_parent(parent):
    require(LIBC.prctl(1, signal.SIGKILL, 0, 0, 0) == 0 and os.getppid() == parent,
            "A trusted startup parent disappeared")


def parent_death_armed():
    value = ctypes.c_int()
    require(LIBC.prctl(2, ctypes.addressof(value), 0, 0, 0) == 0 and value.value == signal.SIGKILL,
            "The parent-death binding was cleared")


def check_engine_parent(parent, descriptor=None):
    require(os.getppid() == parent, "The trusted Engine parent disappeared")
    parent_death_armed()
    if descriptor is not None:
        poll = select.poll()
        poll.register(descriptor, select.POLLIN)
        require(not poll.poll(0), "The pinned Engine parent exited")


def bind_engine_parent(parent):
    # This identity is supplied by the trusted planner, not guessed from a process already reparented to an init.
    require(integer(parent) and parent > 1)
    previous = signal.pthread_sigmask(signal.SIG_BLOCK, SIGNALS)
    require(not previous.intersection(SIGNALS), "Inherited stop-signal masking is unsupported")
    descriptor = os.pidfd_open(parent, 0)
    try:
        arm_parent(parent)
        check_engine_parent(parent, descriptor)
        require(not signal.sigpending().intersection(SIGNALS), "Cancellation preceded Engine-parent binding")
        return previous, descriptor
    except BaseException:
        os.close(descriptor)
        raise


def cancellation(cancelled):
    if cancelled["signal"]:
        return cancelled["signal"]
    pending = signal.sigpending()
    return next((number for number in sorted(SIGNALS) if number in pending), 0)


def close_extra():
    require(LIBC.close_range(3, 0xFFFFFFFF, 0) == 0, "All inherited descriptors could not be closed")


def drop_capabilities():
    for capability in range(64):
        if LIBC.prctl(24, capability, 0, 0, 0) != 0:
            require(ctypes.get_errno() == errno.EINVAL)
    require(LIBC.prctl(47, 4, 0, 0, 0) == 0)

    class Header(ctypes.Structure):
        _fields_ = [("version", ctypes.c_uint32), ("pid", ctypes.c_int)]

    class Data(ctypes.Structure):
        _fields_ = [("effective", ctypes.c_uint32), ("permitted", ctypes.c_uint32), ("inheritable", ctypes.c_uint32)]

    header = Header(0x20080522, 0)
    values = (Data * 2)()
    require(LIBC.capset(ctypes.byref(header), ctypes.byref(values)) == 0 and
            LIBC.capget(ctypes.byref(header), ctypes.byref(values)) == 0 and
            all(item.effective == item.permitted == item.inheritable == 0 for item in values))
    require(all(LIBC.prctl(23, capability, 0, 0, 0) == 0 for capability in range(41)))
    require(LIBC.prctl(39, 0, 0, 0, 0) == 1)


def assert_capabilities_dropped():
    values = dict(line.split(":", 1) for line in pathlib.Path("/proc/self/status").read_text().splitlines() if ":" in line)
    require(all(int(values[name].strip(), 16) == 0 for name in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb")))
    require(values["NoNewPrivs"].strip() == "1")


def validate_descriptors(value, descriptors):
    require(set(descriptors) == set(KINDS) and len(set(descriptors.values())) == 3)
    for kind, fd in descriptors.items():
        require(fcntl.ioctl(fd, NS_GET_NSTYPE) == KINDS[kind])
        info = os.fstat(fd)
        require(info.st_dev == value["devices"][kind] and info.st_ino == value["namespaces"][kind])
    owner = array.array("I", [0])
    fcntl.ioctl(descriptors["user"], NS_GET_OWNER_UID, owner, True)
    require(owner[0] == value["uid"])
    for kind in ("mnt", "pid"):
        owner_fd = fcntl.ioctl(descriptors[kind], NS_GET_USERNS)
        try:
            require(os.fstat(owner_fd).st_ino == value["namespaces"]["user"] and
                    os.fstat(owner_fd).st_dev == value["devices"]["user"])
        finally:
            os.close(owner_fd)


def request_bytes(value):
    return b"vector.ns.v1 " + value["nonce"].encode("ascii") + b"\n"


def receive_namespaces(value):
    received = []
    try:
        before = os.lstat(value["socket"])
        require(stat.S_ISSOCK(before.st_mode) and before.st_uid == 0 and before.st_gid == value["gid"] and
                stat.S_IMODE(before.st_mode) == 0o660 and before.st_dev == value["socketIdentity"]["device"] and
                before.st_ino == value["socketIdentity"]["inode"])
        with socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET | socket.SOCK_CLOEXEC) as transport:
            transport.settimeout(1)
            transport.connect(value["socket"])
            peer = struct.unpack("3i", transport.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            require(peer == (value["broker"]["pid"], 0, 0))
            request = request_bytes(value)
            transport.sendall(request)
            message, ancillary, flags, _ = transport.recvmsg(64, socket.CMSG_SPACE(3 * array.array("i").itemsize),
                                                            socket.MSG_CMSG_CLOEXEC)
            for level, kind, data in ancillary:
                if (level, kind) == (socket.SOL_SOCKET, socket.SCM_RIGHTS):
                    numbers = array.array("i")
                    numbers.frombytes(data[:len(data) - len(data) % numbers.itemsize])
                    received.extend(numbers)
            require(not flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC) and message == request and
                    len(ancillary) == 1 and ancillary[0][0:2] == (socket.SOL_SOCKET, socket.SCM_RIGHTS) and
                    len(ancillary[0][2]) == 3 * array.array("i").itemsize and len(received) == 3 and
                    all(not os.get_inheritable(fd) for fd in received))
        descriptors = dict(zip(KINDS, received, strict=True))
        validate_descriptors(value, descriptors)
        return descriptors
    except BaseException:
        for fd in received:
            os.close(fd)
        raise


def broker(parent, listener_fd, descriptors):
    require(os.getuid() == os.geteuid() == os.getgid() == 0 and parent > 1)
    arm_parent(parent)
    state = read_state()
    value = validate_spec(state["public"], partial=True)
    current = identity(os.getpid(), 0)
    require(current and current["state"] not in ("Z", "X", "x"))
    validate_source_view(os.getpid(), current["start"], state["maskSources"])
    validate_descriptors(value, descriptors)
    require(3 <= listener_fd < 128 and all(3 <= fd < 128 for fd in descriptors.values()) and
            len({listener_fd, *descriptors.values()}) == 4)
    for fd in (listener_fd, *descriptors.values()):
        os.set_inheritable(fd, False)
    listener = socket.socket(fileno=listener_fd)
    require(listener.family == socket.AF_UNIX and listener.type == socket.SOCK_SEQPACKET and
            listener.getsockname() == value["socket"] and listener.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN) == 0)
    for name in os.listdir("/proc/self/fd"):
        fd = int(name)
        if fd < 3 or fd in {listener_fd, *descriptors.values()}:
            continue
        try:
            os.fstat(fd)
        except OSError as error:
            require(error.errno == errno.EBADF)
            continue
        raise RuntimeError("An unexpected descriptor reached the broker")
    require(set(os.environ) <= {"PATH", "LC_ALL", "LC_CTYPE"})
    stopping = {"closed": False, "stop": False}

    def quiesce(number, frame):
        stopping["closed"] = True

    def stop(number, frame):
        stopping["closed"] = stopping["stop"] = True

    signal.signal(signal.SIGUSR1, quiesce)
    for number in SIGNALS:
        signal.signal(number, stop)
    os.setgroups([])
    os.chdir("/")
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
    require(LIBC.prctl(38, 1, 0, 0, 0) == 0)
    drop_capabilities()
    assert_capabilities_dropped()
    listener.listen(16)
    listener.settimeout(0.1)
    ready = {"v": 1, "pid": os.getpid(), "nonce": value["nonce"]}
    write_json(value["directory"] + "/broker-ready.json", ready, 0o600)
    deadline = time.monotonic() + 5
    while not os.path.exists(value["directory"] + "/broker-adopt.json"):
        require(time.monotonic() < deadline)
        time.sleep(0.01)
    require(read_json(value["directory"] + "/broker-adopt.json") == {"v": 1, "nonce": value["nonce"]})
    recorded = read_state()["public"]["broker"]
    current = identity(os.getpid(), 0)
    require(recorded["pid"] == current["pid"] and recorded["start"] == current["start"])
    require(LIBC.prctl(1, 0, 0, 0, 0) == 0)
    write_json(value["directory"] + "/broker-adopted.json", ready, 0o600)
    requests = 0
    acknowledged = False
    try:
        while not stopping["stop"]:
            if stopping["closed"] and not acknowledged:
                write_json(value["directory"] + "/broker-closed.json", ready, 0o600)
                acknowledged = True
            try:
                connection, _ = listener.accept()
            except TimeoutError:
                continue
            requests += 1
            if requests > 256:
                stopping["closed"] = True
            with connection:
                connection.settimeout(0.2)
                if stopping["closed"]:
                    continue
                try:
                    peer = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                    if peer[0] <= 1 or peer[1:] != (value["uid"], value["gid"]):
                        continue
                    before = identity(peer[0], value["uid"])
                    keeper = identity(value["keeper"]["pid"], value["uid"])
                    if not before or before["state"] == "Z":
                        continue
                    if not keeper or keeper["state"] == "Z" or keeper["start"] != value["keeper"]["start"]:
                        stopping["closed"] = True
                        continue
                    message, ancillary, flags, _ = connection.recvmsg(64, 0, socket.MSG_CMSG_CLOEXEC)
                    after = identity(peer[0], value["uid"])
                    if message != request_bytes(value) or ancillary or flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC) or \
                            stopping["closed"] or not after or after["start"] != before["start"]:
                        continue
                    sent = connection.sendmsg([message], [(socket.SOL_SOCKET, socket.SCM_RIGHTS,
                                                          array.array("i", [descriptors[kind] for kind in KINDS]))])
                    require(sent == len(message))
                except (OSError, RuntimeError, ValueError, StopIteration):
                    continue
    finally:
        listener.close()
        for fd in descriptors.values():
            os.close(fd)


def payload_arguments(cwd, argv):
    canonical(cwd)
    require(not any(cwd == prefix or cwd.startswith(prefix + "/") for prefix in ("/proc", "/sys", "/dev")))
    require(1 <= len(argv) <= 513 and argv[0])
    require(all(type(item) is str and "\0" not in item and len(item.encode("utf-8", "strict")) <= 65536 for item in argv))
    require(sum(len(item.encode("utf-8")) + 1 for item in argv) <= 262144)
    size = 0
    for name, item in os.environ.items():
        require(not name.startswith(("LD_", "DYLD_")) and name not in
                ("GCONV_PATH", "GLIBC_TUNABLES", "LOCPATH", "NLSPATH", "LIBPATH", "SHLIB_PATH"))
        size += len(name.encode("utf-8", "strict")) + len(item.encode("utf-8", "strict")) + 2
    require(size <= 262144)


def command_init(control_fd, scratch, cwd, argv):
    # This immutable helper is PID1, not the model program. Exiting it kills every PID in this command namespace.
    require(os.getpid() == 1 and os.getuid() == os.getgid() == 1000 and os.getgroups() == [])
    require(pathlib.Path("/proc/self/uid_map").read_text().split() == ["1000", "0", "1"] and
            pathlib.Path("/proc/self/gid_map").read_text().split() == ["1000", "0", "1"])
    require(LIBC.prctl(38, 1, 0, 0, 0) == 0)
    assert_capabilities_dropped()
    payload_arguments(cwd, argv)
    canonical(scratch)
    require(control_fd >= 3 and os.path.isdir(scratch) and os.path.realpath(scratch) == scratch)
    require(os.path.isdir(cwd) and os.path.realpath(cwd) == cwd)
    control = socket.socket(fileno=control_fd)
    require(control.family == socket.AF_UNIX and control.type == socket.SOCK_SEQPACKET)
    os.set_inheritable(control_fd, False)
    for name in os.listdir("/proc/self/fd"):
        fd = int(name)
        if fd < 3 or fd == control_fd:
            continue
        try:
            os.fstat(fd)
        except OSError as error:
            require(error.errno == errno.EBADF)
            continue
        raise RuntimeError("An undeclared descriptor reached the command init")
    cancelled = {"signal": 0}

    def stop(number, frame):
        cancelled["signal"] = number

    for number in SIGNALS:
        signal.signal(number, stop)
    signal.pthread_sigmask(signal.SIG_SETMASK, [])
    control.settimeout(5)
    control.sendall(b"vector.init.v1 ready\n")
    require(control.recv(64) == b"vector.init.v1 exec\n", "The command init was not released by its live owner")
    # No model command exists before the owner has pinned this exact init. Preserve the barrier on fork failure.
    previous = signal.pthread_sigmask(signal.SIG_BLOCK, SIGNALS)
    try:
        # The cancellation decision/fork is one masked linearization section. Pending signals count as cancellation.
        require(not cancellation(cancelled), "Cancellation preceded the model-child fork decision")
        child = os.fork()
        if child == 0:
            arm_parent(1)
            # Never unblock with inherited handlers that merely set the parent's now-unused cancellation dictionary.
            for number in SIGNALS:
                signal.signal(number, signal.SIG_DFL)
            require(not signal.sigpending().intersection(SIGNALS) and os.getppid() == 1)
            parent_death_armed()
            environment = dict(os.environ)
            environment.update({"HOME": scratch, "TMPDIR": scratch, "TMP": scratch, "TEMP": scratch,
                                "RUNNER_TEMP": scratch})
            os.chdir(cwd)
            close_extra()
            require(not signal.sigpending().intersection(SIGNALS) and os.getppid() == 1)
            parent_death_armed()
            signal.pthread_sigmask(signal.SIG_SETMASK, previous)
            os.execvpe(argv[0], argv, environment)
        pending = cancellation(cancelled)
        if pending:
            return 128 + pending  # PID1 exit also stops a child created after the fork decision.
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, previous)
    control.setblocking(False)
    try:
        while True:
            if cancelled["signal"]:
                return 128 + cancelled["signal"]
            reaped, status = os.waitpid(child, os.WNOHANG)
            if reaped:
                return os.waitstatus_to_exitcode(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status)
            if select.select([control], [], [], 0.05)[0]:
                message = control.recv(64)
                if not message or message == b"vector.init.v1 cancel\n":
                    return 143
                raise RuntimeError("Unexpected command lifetime message")
    finally:
        control.close()
        # PID1 returns only to os._exit below: the kernel tears down setsid/daemon descendants too.


def signal_owned(fd, number):
    try:
        signal.pidfd_send_signal(fd, number)
    except ProcessLookupError:
        pass


def command_message(channel):
    message, ancillary, flags, _ = channel.recvmsg(64, 0, socket.MSG_CMSG_CLOEXEC)
    require(not ancillary and not flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC),
            "A private command lifetime message was malformed")
    return message


def command_guardian(value, cwd, argv, owner):
    require(os.getuid() == os.getgid() == 0 and os.getgroups() == [])
    scratch = value["scratch"] + "/command-" + os.urandom(16).hex()
    os.mkdir(scratch, 0o700)
    control, inside = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET | socket.SOCK_CLOEXEC)
    info_read, info_write = os.pipe2(os.O_CLOEXEC | os.O_NONBLOCK)
    cancelled = {"signal": 0}
    init_fd = None
    closing = {"value": False}

    def stop(number, frame):
        cancelled["signal"] = number
        if init_fd is not None and not closing["value"]:
            signal_owned(init_fd, number)

    for number in SIGNALS:
        signal.signal(number, stop)
    signal.pthread_sigmask(signal.SIG_SETMASK, [])
    owner.setblocking(False)
    deadline = time.monotonic() + 5
    parent = os.getpid()
    process = None
    process_fd = None
    try:
        # A fork is not an ownership handoff. The outer shim must pin this child and install cancellation
        # forwarding before it can let the guardian start a command namespace, which still cannot execute yet.
        while True:
            require(not cancelled["signal"] and time.monotonic() < deadline)
            if select.select([owner], [], [], 0.05)[0]:
                require(command_message(owner) == b"vector.owner.v1 owned\n",
                        "The guardian did not receive its live outer ownership handoff")
                break
        parent_death_armed()
        # --sync-fd is intentionally retained by --as-pid-1. Only immutable init sees this secret-free control FD.
        arguments = [
            "/usr/bin/bwrap", "--die-with-parent", "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
            "--uid", "1000", "--gid", "1000", "--as-pid-1", "--sync-fd", str(inside.fileno()),
            "--info-fd", str(info_write), "--ro-bind", "/", "/", "--bind", value["stage"], value["stage"],
            "--bind", scratch, scratch, "--dev", "/dev", "--proc", "/proc", "--cap-drop", "ALL", "--chdir", cwd,
            "--", "/usr/bin/python3", "-I", "-S", SELF, "command-init", str(inside.fileno()), scratch, cwd, "--", *argv,
        ]
        process = subprocess.Popen(arguments, close_fds=True, pass_fds=(inside.fileno(), info_write),
                                   preexec_fn=lambda: arm_parent(parent), env=dict(os.environ))
        process_fd = os.pidfd_open(process.pid, 0)
        inside.close()
        os.close(info_write)
        info_write = None
        drop_capabilities()
        information = b""
        ready = False
        control.setblocking(False)
        while init_fd is None or not ready:
            require(not cancelled["signal"] and time.monotonic() < deadline and process.poll() is None,
                    "The command init was not owned before execution")
            waiting = [control, owner] + ([info_read] if info_read is not None else [])
            reads, _, _ = select.select(waiting, [], [], 0.05)
            if owner in reads:
                # There is no legal second message until init-ready. EOF also refuses startup.
                command_message(owner)
                raise RuntimeError("The outer lifetime ended before the command init was owned")
            if info_read is not None and info_read in reads:
                block = os.read(info_read, 4097 - len(information))
                require(block and len(information) + len(block) <= 4096)
                information += block
                try:
                    details = json.loads(information.decode("utf-8", "strict"))
                except (json.JSONDecodeError, UnicodeError):
                    details = None
                if details is not None:
                    require(type(details) is dict and integer(details.get("child-pid")))
                    init = identity(details["child-pid"], 0)
                    require(init and init["state"] != "Z")
                    init_fd = os.pidfd_open(init["pid"], 0)
                    after = identity(init["pid"], 0)
                    require(after and after["start"] == init["start"])
                    os.close(info_read)
                    info_read = None
            if control in reads:
                require(control.recv(64) == b"vector.init.v1 ready\n")
                ready = True
        target = f"/proc/{init['pid']}"
        status = pathlib.Path(target + "/status").read_text()
        groups = next(line for line in status.splitlines() if line.startswith("Gid:")).split()[1:]
        nested = next(line for line in status.splitlines() if line.startswith("NSpid:")).split()[1:]
        require(len(groups) == 4 and all(item == "0" for item in groups) and nested[-1] == "1")
        require(os.stat(target + "/ns/user").st_ino != value["namespaces"]["user"] and
                os.stat(target + "/ns/pid").st_ino != value["namespaces"]["pid"] and
                pathlib.Path(target + "/uid_map").read_text().split() == ["1000", "0", "1"] and
                pathlib.Path(target + "/gid_map").read_text().split() == ["1000", "0", "1"])
        observed = identity(init["pid"], 0)
        require(observed and observed["start"] == init["start"] and observed["state"] != "Z")
        # Only the outer shim observes Engine-directed pending cancellation. It makes the composed release
        # decision AFTER this init has been pinned and verified; the guardian may never decide in its place.
        owner.settimeout(1)
        owner.sendall(b"vector.owner.v1 init-ready\n")
        owner.setblocking(False)
        while True:
            require(not cancelled["signal"] and time.monotonic() < deadline and process.poll() is None)
            if select.select([owner], [], [], 0.05)[0]:
                require(command_message(owner) == b"vector.owner.v1 exec-authorized\n",
                        "The live outer owner did not authorize command execution")
                break
        previous = signal.pthread_sigmask(signal.SIG_BLOCK, SIGNALS)
        try:
            # The received authorization records the OUTER decision, not a new independent release authority.
            # Local cancellation/outer EOF can still prevent dispatch. An arrival after authorization is
            # cancellation of an already-owned namespace and must stop/reap even if model execution races it.
            require(not cancellation(cancelled), "The guardian was cancelled before init dispatch")
            require(not select.select([owner], [], [], 0)[0], "The outer owner disappeared before init dispatch")
            parent_death_armed()
            live = select.poll()
            live.register(init_fd, select.POLLIN)
            require(not live.poll(0), "The owned init exited before dispatch")
            control.settimeout(1)
            control.sendall(b"vector.init.v1 exec\n")
            pending = cancellation(cancelled)
            if pending:
                signal_owned(init_fd, pending)
        finally:
            # Do not leave later cancellation masked if a release or pending-signal check failed.
            signal.pthread_sigmask(signal.SIG_SETMASK, previous)
        poll = select.poll()
        poll.register(init_fd, select.POLLIN)
        stopping = None
        while process.poll() is None:
            if select.select([owner], [], [], 0)[0]:
                message = command_message(owner)
                require(not message, "An unexpected outer lifetime message followed authorization")
                cancelled["signal"] = cancelled["signal"] or signal.SIGTERM
            if cancelled["signal"] and stopping is None:
                stopping = time.monotonic()
                try:
                    control.sendall(b"vector.init.v1 cancel\n")
                except (OSError, TimeoutError):
                    pass
                signal_owned(init_fd, cancelled["signal"])
            if stopping is not None and time.monotonic() - stopping >= 1:
                signal_owned(init_fd, signal.SIGKILL)
            if stopping is not None:
                require(time.monotonic() - stopping < 2, "The owned command namespace did not stop")
            time.sleep(0.01)
        require(poll.poll(1000), "The command returned without reaping its namespace init")
        return process.returncode if process.returncode >= 0 else 128 - process.returncode
    finally:
        closing["value"] = True
        owner.close()
        # EOF also tells immutable PID1 to exit when this guardian is killed before or after release.
        control.close()
        inside.close()
        cleanup_error = None
        if init_fd is not None:
            try:
                signal_owned(init_fd, signal.SIGKILL)
                stopped = select.poll()
                stopped.register(init_fd, select.POLLIN)
                require(stopped.poll(1000), "The command init survived failed-start cleanup")
            except BaseException as error:
                cleanup_error = error
            finally:
                os.close(init_fd)
        if process_fd is not None:
            try:
                signal_owned(process_fd, signal.SIGKILL)
                if process is not None:
                    process.wait(timeout=1)
            except BaseException as error:
                cleanup_error = error
            finally:
                os.close(process_fd)
        for fd in (info_read, info_write):
            if fd is not None:
                os.close(fd)
        # This directory is model-writable. Do not follow a replaced entry or recursively reclaim it in the guardian.
        try:
            os.rmdir(scratch)
        except OSError:
            pass
        if cleanup_error is not None:
            raise cleanup_error


def execute(parent, previous, parent_fd, cwd, argv):
    check_engine_parent(parent, parent_fd)
    payload_arguments(cwd, argv)
    require(os.getgroups() == [] and LIBC.prctl(39, 0, 0, 0, 0) == 1)
    require(os.path.isdir("/proc") and not os.listdir("/proc"), "The holder proc is not empty")
    require(stat.S_IMODE(os.lstat(SPEC).st_mode) == 0o444)
    value = validate_spec(read_json(SPEC))
    require(os.getuid() == value["uid"] and os.getgid() == value["gid"])
    secure_chain(value["directory"])
    check_engine_parent(parent, parent_fd)
    close_extra()
    # The pidfd is an Engine descriptor: it must not survive broker entry, even as a CLOEXEC descriptor.
    check_engine_parent(parent)
    descriptors = receive_namespaces(value)
    try:
        for kind in KINDS:
            check_engine_parent(parent)
            os.setns(descriptors[kind], KINDS[kind])
            # A credential/namespace change must not silently clear the Engine-death edge.
            check_engine_parent(parent)
    finally:
        for fd in descriptors.values():
            os.close(fd)
    require(os.getuid() == os.getgid() == 0 and os.getgroups() == [])
    os.chdir("/")
    check_engine_parent(parent)
    require(not signal.sigpending().intersection(SIGNALS), "Cancellation preceded guardian creation")
    owner, guardian = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET | socket.SOCK_CLOEXEC)
    deadline = time.monotonic() + 5
    child = os.fork()
    if child == 0:
        owner.close()
        # After setns(PID), this child's parent is outside its visible PID namespace: getppid() is zero.
        require(LIBC.prctl(1, signal.SIGKILL, 0, 0, 0) == 0)
        # A parent lost before this arm cannot be mistaken for a live one: the socket must deliver an ownership
        # token before namespace creation, and a separate final authorization before any init exec release.
        os._exit(command_guardian(value, cwd, argv, guardian))
    guardian.close()
    child_fd = None
    reaped = False
    cancelled = {"signal": 0}
    closing = {"value": False}

    def forward(number, frame):
        cancelled["signal"] = number
        if child_fd is not None and not closing["value"]:
            signal_owned(child_fd, number)

    try:
        child_fd = os.pidfd_open(child, 0)
        drop_capabilities()
        check_engine_parent(parent)
        for number in SIGNALS:
            signal.signal(number, forward)
        # Stop signals remain blocked since trusted Engine-parent binding. The child has no authority yet.
        require(not cancellation(cancelled), "Cancellation preceded guardian ownership")
        owner.settimeout(1)
        owner.sendall(b"vector.owner.v1 owned\n")
        signal.pthread_sigmask(signal.SIG_SETMASK, previous)
        owner.setblocking(False)
        live = select.poll()
        live.register(child_fd, select.POLLIN)
        while True:
            check_engine_parent(parent)
            require(not cancelled["signal"] and time.monotonic() < deadline and not live.poll(0),
                    "The guardian did not produce a live owned init before execution")
            if select.select([owner], [], [], 0.05)[0]:
                require(command_message(owner) == b"vector.owner.v1 init-ready\n",
                        "The guardian did not attest its actual owned init")
                break
        mask = signal.pthread_sigmask(signal.SIG_BLOCK, SIGNALS)
        try:
            check_engine_parent(parent)
            require(not live.poll(0), "The owned guardian exited before the release decision")
            # This final check is the ONE composed exec decision. Cancellation recorded or kernel-pending in
            # the outer shim before it cannot authorize the guardian, even if the child ran immediately at fork.
            require(not cancellation(cancelled), "Cancellation preceded the outer exec-authorization decision")
            owner.settimeout(1)
            owner.sendall(b"vector.owner.v1 exec-authorized\n")
            pending = cancellation(cancelled)
            if pending:
                signal_owned(child_fd, pending)
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, mask)
        _, result = os.waitpid(child, 0)
        reaped = True
        return os.waitstatus_to_exitcode(result) if os.WIFEXITED(result) else 128 + os.WTERMSIG(result)
    finally:
        closing["value"] = True
        # EOF closes the guardian's lifetime as well as SIGKILL/PDEATH; the channel is never passed to bwrap/init.
        owner.close()
        try:
            if not reaped:
                if child_fd is None:
                    # This is our own unreaped fork child, which has received NO ownership token. Its PID cannot
                    # have been recycled before waitpid, even when opening its first pidfd failed.
                    try:
                        os.kill(child, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                else:
                    # Give the owned guardian one bounded graceful interval to close/kill and prove init teardown.
                    # Killing it immediately on startup cancellation would skip its namespace cleanup proof.
                    signal_owned(child_fd, cancelled["signal"] or signal.SIGTERM)
                started = time.monotonic()
                while True:
                    observed, _ = os.waitpid(child, os.WNOHANG)
                    if observed:
                        break
                    elapsed = time.monotonic() - started
                    if child_fd is not None and elapsed >= 1:
                        signal_owned(child_fd, signal.SIGKILL)
                    require(elapsed < 2, "The owned command guardian was not reaped")
                    time.sleep(0.01)
        finally:
            if child_fd is not None:
                os.close(child_fd)
            signal.pthread_sigmask(signal.SIG_SETMASK, previous)


def fixed(argv, **options):
    return subprocess.run(argv, check=True, timeout=5, env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"}, **options)


def keeper(scratch):
    keeper_marker("identity")
    require(os.getuid() == os.getgid() == 0 and os.getgroups() == [])
    keeper_marker("capabilities")
    assert_capabilities_dropped()
    keeper_marker("environment")
    keeper_environment(dict(os.environ), scratch, os.getcwd())
    keeper_marker("ready-write")
    write_json(scratch + "/keeper-ready.json", {
        "v": 1, "pid": os.getpid(), "uid": os.getuid(), "gid": os.getgid(),
        "namespaces": {kind: os.stat("/proc/self/ns/" + kind).st_ino for kind in KINDS},
    }, 0o600)
    while True:
        signal.pause()


def keeper_environment(environment, scratch, cwd):
    canonical(scratch)
    require(set(environment) <= {"PATH", "HOME", "PWD", "LC_ALL", "LC_CTYPE"} and
            environment.get("PWD") == scratch and cwd == scratch)


def keeper_marker(stage):
    require(stage in ("identity", "capabilities", "environment", "ready-write"))
    marker = b"VECTOR_NATIVE_KEEPER_STAGE " + stage.encode("ascii") + b"\n"
    require(os.write(2, marker) == len(marker))


def keeper_log_stage(data):
    # The private log can contain arbitrary child stderr. Recognize only the fixed ordered marker prefix;
    # no raw line, exception text, path, argv, environment or unknown marker ever becomes a diagnostic.
    if type(data) is not bytes or len(data) > 65536:
        return None
    phases = (b"identity", b"capabilities", b"environment", b"ready-write")
    markers = []
    tag = b"VECTOR_NATIVE_KEEPER_STAGE"
    prefix = tag + b" "
    for line in data.splitlines(keepends=True):
        if not line.startswith(tag):
            continue
        if (not line.startswith(prefix) or not line.endswith(b"\n") or len(markers) == len(phases) or
                line[len(prefix):-1] != phases[len(markers)]):
            return None
        markers.append(phases[len(markers)])
    return markers[-1].decode("ascii") if markers else None


def read_keeper_stage(name):
    descriptor = None
    try:
        descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
        before = os.fstat(descriptor)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == before.st_gid == 0 and before.st_nlink == 1 and
                stat.S_IMODE(before.st_mode) == 0o600 and before.st_size <= 65536)
        data = os.read(descriptor, 65537)
        after = os.fstat(descriptor)
        require(len(data) == before.st_size and
                (before.st_dev, before.st_ino, before.st_mode, before.st_uid, before.st_gid, before.st_nlink,
                 before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
                (after.st_dev, after.st_ino, after.st_mode, after.st_uid, after.st_gid, after.st_nlink,
                 after.st_size, after.st_mtime_ns, after.st_ctime_ns))
        return keeper_log_stage(data)
    except (OSError, RuntimeError, ValueError):
        # Diagnostic uncertainty preserves the actual failure outcome and never delays owned cleanup.
        return None
    finally:
        if descriptor is not None:
            os.close(descriptor)


def wait_keeper(name, log, owner, process, seconds=5):
    global _DIAGNOSTIC_STAGE
    deadline = time.monotonic() + seconds
    while not os.path.lexists(name):
        result = process.poll()
        if result is not None:
            phase = read_keeper_stage(log)
            _DIAGNOSTIC_STAGE = "prepare-keeper-child-exit" + ("-" + phase if phase else "")
            # Only the numeric returncode reaches control_failure's existing finite exit/signal projection.
            raise subprocess.CalledProcessError(result, ("fixed-keeper",))
        if time.monotonic() >= deadline:
            phase = read_keeper_stage(log)
            _DIAGNOSTIC_STAGE = "prepare-keeper-timeout" + ("-" + phase if phase else "")
            raise subprocess.TimeoutExpired(("fixed-keeper",), seconds)
        time.sleep(0.01)
    _DIAGNOSTIC_STAGE = "prepare-keeper-ready-record"
    return read_json(name, owner)


def wait_json(name, owner, process=None, seconds=5):
    deadline = time.monotonic() + seconds
    while not os.path.lexists(name):
        require(time.monotonic() < deadline and (process is None or process.poll() is None))
        time.sleep(0.01)
    return read_json(name, owner)


def image_digest(name):
    info = os.stat(name)
    require(stat.S_ISREG(info.st_mode) and info.st_size <= 67108864)
    digest = hashlib.sha256()
    size = 0
    with open(name, "rb") as source:
        while True:
            block = source.read(1048576)
            if not block:
                break
            size += len(block)
            require(size <= 67108864)
            digest.update(block)
    require(size == info.st_size)
    return digest.hexdigest()


def runtime_images():
    secure_chain(SELF)
    secure_chain(sys.executable)
    for module in tuple(sys.modules.values()):
        source = getattr(module, "__file__", None)
        if source:
            secure_chain(source)
    images = {secure_chain(SELF): image_digest(SELF)}
    for line in pathlib.Path("/proc/self/maps").read_text().splitlines():
        fields = line.split(maxsplit=5)
        if len(fields) < 6 or not fields[5].startswith("/"):
            continue
        require(not fields[5].endswith(" (deleted)"))
        name = secure_chain(fields[5])
        images[name] = image_digest(name)
    require(len(images) <= 128 and any("ld-linux" in name for name in images) and
            any("libc.so" in name for name in images) and any("libffi.so" in name for name in images))
    return images


def object_identity(value):
    exact(value, ("device", "inode"))
    require(all(integer(item) for item in value.values()))
    return value


def construction_namespace(value):
    exact(value, ("mount", "parentMount", "user", "root"))
    for item in value.values():
        object_identity(item)
    require(value["mount"] != value["parentMount"])
    return value


def filesystem(value):
    require(type(value) is str and 3 <= len(value) <= 32 and value.count(":") == 1 and
            all(part.isascii() and part.isdigit() and str(int(part)) == part for part in value.split(":")))
    return value


def json_digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")).hexdigest()


def digest_value(value):
    require(type(value) is str and len(value) == 64 and all(char in "0123456789abcdef" for char in value))


def mask_records(records):
    # Cleanup reads this durable record before stopping owned processes. This validation is deliberately
    # structural: live topology/source drift may refuse admission, but cannot revoke teardown ownership.
    exact(records, ("v", "namespace", "topology", "roots", "origins", "digest"))
    require(type(records["v"]) is int and records["v"] == 2)
    construction_namespace(records["namespace"])
    digest_value(records["topology"])
    digest_value(records["digest"])
    require(type(records["roots"]) is list and len(records["roots"]) == len(MASKS) and
            type(records["origins"]) is list and len(records["roots"]) + len(records["origins"]) <= 64 and
            len(json.dumps(records, separators=(",", ":"), ensure_ascii=True).encode("ascii")) <= 32768)
    for record in records["roots"] + records["origins"]:
        exact(record, ("path", "device", "inode", "mountID", "filesystem", "root", "kind", "mode", "uid", "gid"))
        canonical(record["path"])
        canonical(record["root"])
        filesystem(record["filesystem"])
        require(hidden(record["path"]) and all(integer(record[key]) for key in ("device", "inode", "mountID", "mode")) and
                all(type(record[key]) is int and 0 <= record[key] <= 9007199254740991 for key in ("uid", "gid")) and
                record["mode"] <= 65535 and (stat.S_ISDIR(record["mode"]) or stat.S_ISREG(record["mode"])) and
                type(record["kind"]) is str and re.fullmatch(r"[A-Za-z0-9._+-]{1,64}", record["kind"]))
        require(record["filesystem"] == f"{os.major(record['device'])}:{os.minor(record['device'])}")
    require([record["path"] for record in records["roots"]] == list(MASKS))
    require(all(stat.S_ISDIR(record["mode"]) for record in records["roots"]))
    require(records["origins"] == sorted(records["origins"], key=lambda record: (record["path"], record["mountID"])))
    require(len({record["mountID"] for record in records["origins"]}) == len(records["origins"]) and
            all(record["path"] not in MASKS for record in records["origins"]))
    require(records["digest"] == json_digest({key: value for key, value in records.items() if key != "digest"}))
    return records


def mount_field(value):
    # Decode the kernel's escaped fields once. Replacing backslashes in multiple passes corrupts literal aliases.
    require(type(value) is str and re.fullmatch(r"(?:[^\\]|\\(?:040|011|012|134))*", value))
    def decode(match):
        require(match[1] in ("040", "011", "012", "134"))
        return chr(int(match[1], 8))
    result = re.sub(r"\\([0-7]{3})", decode, value)
    require(0 < len(result.encode("utf-8", "strict")) <= 4096 and
            not any(ord(char) < 32 or ord(char) == 127 for char in result))
    return result


def mount_path(value):
    return canonical(mount_field(value))


def parse_mount_table(data):
    require(len(data) <= 2097152)
    lines = data.decode("utf-8", "strict").splitlines()
    require(0 < len(lines) <= 4096)
    result = []
    for line in lines:
        fields = line.split()
        middle = fields.index("-")
        require(middle >= 6 and len(fields) == middle + 4 and
                all(part.isascii() and part.isdigit() and str(int(part)) == part and integer(int(part))
                    for part in fields[:2]))
        optional = fields[6:middle]
        require(len(optional) == len(set(optional)) and all(item == "unbindable" or
                (re.fullmatch(r"(?:shared|master|propagate_from):[1-9][0-9]{0,15}", item) and
                 integer(int(item.split(":")[1]))) for item in optional))
        require(len({item.split(":")[0] for item in optional}) == len(optional))
        options, super_options = fields[5].split(","), fields[middle + 3].split(",")
        require(all(options) and len(options) == len(set(options)) and all(super_options) and
                len(super_options) == len(set(super_options)) and
                (("ro" in options) != ("rw" in options)) and
                (("ro" in super_options) != ("rw" in super_options)) and
                re.fullmatch(r"[A-Za-z0-9._+-]{1,64}", fields[middle + 1]))
        result.append({"id": int(fields[0]), "parent": int(fields[1]), "filesystem": filesystem(fields[2]),
                       "root": mount_path(fields[3]), "target": mount_path(fields[4]), "options": options,
                       "propagation": optional, "kind": fields[middle + 1], "source": mount_field(fields[middle + 2]),
                       "superOptions": super_options, "readOnly": "ro" in options})
    indexed = {row["id"]: row for row in result}
    require(len(indexed) == len(result))
    roots = [row for row in result if row["parent"] not in indexed]
    require(len(roots) == 1 and roots[0]["target"] == "/")
    for row in result:
        seen = set()
        current = row
        while current["parent"] in indexed:
            require(current["id"] not in seen)
            seen.add(current["id"])
            parent = indexed[current["parent"]]
            require(beneath(current["target"], parent["target"]))
            current = parent
        require(current["id"] == roots[0]["id"])
    return sorted(result, key=lambda row: row["id"])


def mount_table(pid=None):
    name = "/proc/self/mountinfo" if pid is None else f"/proc/{pid}/mountinfo"
    with open(name, "rb") as stream:
        return parse_mount_table(stream.read(2097153))


def beneath(name, parent):
    return name == parent or name.startswith(parent.rstrip("/") + "/")


def hidden(name):
    return any(beneath(name, parent) for parent in MASKS)


def refuse_mask_aliases(records, mounts):
    for source in mask_records(records)["roots"] + records["origins"]:
        for candidate in mounts:
            if candidate["filesystem"] != source["filesystem"]:
                continue
            if beneath(source["root"], candidate["root"]):
                relative = os.path.relpath(source["root"], candidate["root"])
                alias = os.path.normpath(os.path.join(candidate["target"], relative))
                require(hidden(alias), "An alternate bind exposes a protected parent")
            if beneath(candidate["root"], source["root"]):
                require(hidden(candidate["target"]), "A protected subtree has an alternate mounted destination")


def require_private_mounts(mounts):
    require(all(not row["propagation"] or row["propagation"] == ["unbindable"] for row in mounts),
            "A construction mount can propagate outside its private namespace")


def require_known_mask_origins(records, mounts, replacements):
    known = {(record["path"], record["filesystem"], record["root"], record["kind"])
             for record in records["roots"] + records["origins"]}
    for row in mounts:
        if hidden(row["target"]) and row["id"] not in replacements:
            require((row["target"], row["filesystem"], row["root"], row["kind"]) in known,
                    "An uncaptured origin exists beneath a protected parent")


def require_capture_closure(records, mounts):
    mask_records(records)
    require(json_digest(mounts) == records["topology"])
    require([(record["path"], record["mountID"]) for record in records["origins"]] ==
            sorted((row["target"], row["id"]) for row in mounts
                   if hidden(row["target"]) and row["target"] not in MASKS))
    sources = records["roots"] + records["origins"]
    require(all(any(record["path"] == row["target"] and record["mountID"] == row["id"]
                    for record in sources) for row in mounts if hidden(row["target"])),
            "A covered or uncaptured source mount cannot be pinned")
    require_known_mask_origins(records, mounts, set())


def stat_identity(info):
    return {"device": info.st_dev, "inode": info.st_ino}


def mount_descriptor(fd):
    fields = [line.split() for line in pathlib.Path(f"/proc/self/fdinfo/{fd}").read_text().splitlines()
              if line.startswith("mnt_id:")]
    require(len(fields) == 1 and len(fields[0]) == 2 and fields[0][1].isascii() and fields[0][1].isdigit())
    value = int(fields[0][1])
    require(integer(value))
    return value


def pin_source(root_fd, name):
    # Walk every component with O_NOFOLLOW; a final-only check would follow mutable intermediate symlinks.
    canonical(name)
    fd = os.dup(root_fd)
    try:
        parts = name.lstrip("/").split("/") if name != "/" else []
        for index, part in enumerate(parts):
            opened = os.open(part, os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC |
                             (os.O_DIRECTORY if index < len(parts) - 1 else 0), dir_fd=fd)
            os.close(fd)
            fd = opened
        info = os.fstat(fd)
        require(stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode))
        return fd
    except BaseException:
        os.close(fd)
        raise


def source_record(fd, name, row):
    info = os.fstat(fd)
    require(beneath(name, row["target"]) and mount_descriptor(fd) == row["id"] and
            row["filesystem"] == f"{os.major(info.st_dev)}:{os.minor(info.st_dev)}")
    return {"path": name, "device": info.st_dev, "inode": info.st_ino, "mountID": row["id"],
            "filesystem": row["filesystem"],
            "root": os.path.normpath(os.path.join(row["root"], os.path.relpath(name, row["target"]))),
            "kind": row["kind"], "mode": info.st_mode, "uid": info.st_uid, "gid": info.st_gid}


def capture_mount_namespace():
    # This is called only in the existing Root PREPARE child. The broker retains the resulting namespace
    # through membership. No construction namespace descriptor is inherited by the broker or a client.
    before = os.open("/proc/self/ns/mnt", os.O_RDONLY | os.O_CLOEXEC)
    user = os.open("/proc/self/ns/user", os.O_RDONLY | os.O_CLOEXEC)
    after = None
    try:
        require(fcntl.ioctl(before, NS_GET_NSTYPE) == KINDS["mnt"] and
                fcntl.ioctl(user, NS_GET_NSTYPE) == KINDS["user"])
        owner = fcntl.ioctl(before, NS_GET_USERNS)
        try:
            require(stat_identity(os.fstat(owner)) == stat_identity(os.fstat(user)))
        finally:
            os.close(owner)
        os.unshare(KINDS["mnt"])
        require(LIBC.mount(None, b"/", None, 16384 | 262144, None) == 0,
                "The construction namespace could not be made recursively private")
        after = os.open("/proc/self/ns/mnt", os.O_RDONLY | os.O_CLOEXEC)
        require(fcntl.ioctl(after, NS_GET_NSTYPE) == KINDS["mnt"])
        namespace = {"mount": stat_identity(os.fstat(after)), "parentMount": stat_identity(os.fstat(before)),
                     "user": stat_identity(os.fstat(user)), "root": stat_identity(os.stat("/"))}
        construction_namespace(namespace)
        require(namespace["user"] == stat_identity(os.stat("/proc/self/ns/user")) and
                namespace["mount"] == stat_identity(os.stat("/proc/self/ns/mnt")))
        owner = fcntl.ioctl(after, NS_GET_USERNS)
        try:
            require(stat_identity(os.fstat(owner)) == namespace["user"])
        finally:
            os.close(owner)
        require_private_mounts(mount_table())
        return namespace, after
    except BaseException:
        if after is not None:
            os.close(after)
        raise
    finally:
        os.close(before)
        os.close(user)


def supported_mask_sources(uid, gid, namespace, pins):
    # OS/layout metadata only. Neither a runner UID nor Root ownership is guessed for the hosted temporary root.
    global _DIAGNOSTIC_STAGE
    _DIAGNOSTIC_STAGE = "prepare-mask-os-chain"
    release = secure_chain("/etc/os-release")
    _DIAGNOSTIC_STAGE = "prepare-mask-os-open"
    fd = os.open(release, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    try:
        _DIAGNOSTIC_STAGE = "prepare-mask-os-stat"
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == info.st_gid == 0 and not info.st_mode & 0o022 and
                info.st_size <= 4096)
        _DIAGNOSTIC_STAGE = "prepare-mask-os-read"
        data = os.read(fd, 4097)
        require(len(data) == info.st_size and len(data) <= 4096)
    finally:
        os.close(fd)
    _DIAGNOSTIC_STAGE = "prepare-mask-os-decode"
    release_fields = dict(line.split("=", 1) for line in data.decode("utf-8", "strict").splitlines()
                          if line and not line.startswith("#") and "=" in line)
    _DIAGNOSTIC_STAGE = "prepare-mask-os-version"
    require(release_fields.get("ID", "").strip('"') == "ubuntu" and
            release_fields.get("VERSION_ID", "").strip('"') == "24.04", "The native host layout is unsupported")
    _DIAGNOSTIC_STAGE = "prepare-mask-runner-lookup"
    runner = pwd.getpwnam("runner")
    _DIAGNOSTIC_STAGE = "prepare-mask-runner-identity"
    require(integer(runner.pw_uid) and runner.pw_uid != uid)
    _DIAGNOSTIC_STAGE = "prepare-mask-mount-table"
    mounts = mount_table()
    require_private_mounts(mounts)
    # These labels are fixed metadata categories, never path strings supplied by a caller.
    labels = {"/home/vector-agent":"home", "/tmp":"tmp", "/var/tmp":"var-tmp", "/run":"run", HOST_TEMP:"host-temp"}
    records = []
    for target in MASKS:
        label = labels[target]
        _DIAGNOSTIC_STAGE = f"prepare-mask-{label}-target-stat"
        info = os.lstat(target)
        _DIAGNOSTIC_STAGE = f"prepare-mask-{label}-target-type"
        require(stat.S_ISDIR(info.st_mode))
        _DIAGNOSTIC_STAGE = f"prepare-mask-{label}-target-canonical"
        require(os.path.realpath(target) == target)
        _DIAGNOSTIC_STAGE = f"prepare-mask-{label}-target-owner"
        if target == "/home/vector-agent":
            require(info.st_uid == uid and info.st_gid == gid)
            _DIAGNOSTIC_STAGE = f"prepare-mask-{label}-target-mode"
            require(not info.st_mode & 0o022)
        elif target == HOST_TEMP:
            require(info.st_uid == runner.pw_uid)
            _DIAGNOSTIC_STAGE = f"prepare-mask-{label}-target-mode"
            require(not info.st_mode & 0o022)
        else:
            require(info.st_uid == info.st_gid == 0)
        for parent in pathlib.Path(target).parents:
            _DIAGNOSTIC_STAGE = f"prepare-mask-{label}-parent-stat"
            item = parent.lstat()
            _DIAGNOSTIC_STAGE = f"prepare-mask-{label}-parent-type"
            require(stat.S_ISDIR(item.st_mode))
            _DIAGNOSTIC_STAGE = f"prepare-mask-{label}-parent-owner"
            require(item.st_uid in (0, runner.pw_uid))
            _DIAGNOSTIC_STAGE = f"prepare-mask-{label}-parent-mode"
            require(not item.st_mode & 0o022)
            _DIAGNOSTIC_STAGE = f"prepare-mask-{label}-parent-canonical"
            require(os.path.realpath(parent) == str(parent))
        _DIAGNOSTIC_STAGE = f"prepare-mask-{label}-mount-present"
        containing = [row for row in mounts if beneath(target, row["target"])]
        require(containing)
        fd = pin_source(pins["root"], target)
        pins["sources"].append(fd)
        matching = [row for row in containing if row["id"] == mount_descriptor(fd)]
        require(len(matching) == 1)
        row = matching[0]
        require(len(row["target"]) == max(len(item["target"]) for item in containing))
        _DIAGNOSTIC_STAGE = f"prepare-mask-{label}-mount-device"
        require(row["filesystem"] == f"{os.major(info.st_dev)}:{os.minor(info.st_dev)}")
        record = source_record(fd, target, row)
        require((record["device"], record["inode"], record["mode"], record["uid"], record["gid"]) ==
                (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid))
        records.append(record)
    _DIAGNOSTIC_STAGE = "prepare-mask-origins"
    nested = sorted((row for row in mounts if hidden(row["target"]) and row["target"] not in MASKS),
                    key=lambda row: (row["target"], row["id"]))
    require(len(records) + len(nested) <= 64)
    origins = []
    for row in nested:
        fd = pin_source(pins["root"], row["target"])
        pins["sources"].append(fd)
        # A covered/ambiguous source mount cannot be attested through its visible path. Refuse it here;
        # copied keeper rows may be covered later, but still receive the complete alias/origin checks.
        origins.append(source_record(fd, row["target"], row))
    result = {"v": 2, "namespace": namespace, "topology": json_digest(mounts), "roots": records, "origins": origins}
    result["digest"] = json_digest(result)
    mask_records(result)
    _DIAGNOSTIC_STAGE = "prepare-mask-aliases"
    require_capture_closure(result, mounts)
    refuse_mask_aliases(result, mounts)
    validate_source_view(os.getpid(), identity(os.getpid(), 0)["start"], result, pins["sources"])
    return result


def validate_source_view(pid, start, records, original_pins=None):
    mask_records(records)
    descriptors = []
    sources = []
    try:
        process = os.pidfd_open(pid, 0)
        descriptors.append(process)
        before = identity(pid, 0)
        require(before and before["start"] == start and before["state"] not in ("Z", "X", "x"))
        mount = os.open(f"/proc/{pid}/ns/mnt", os.O_RDONLY | os.O_CLOEXEC)
        descriptors.append(mount)
        user = os.open(f"/proc/{pid}/ns/user", os.O_RDONLY | os.O_CLOEXEC)
        descriptors.append(user)
        namespace = records["namespace"]
        require(fcntl.ioctl(mount, NS_GET_NSTYPE) == KINDS["mnt"] and
                fcntl.ioctl(user, NS_GET_NSTYPE) == KINDS["user"] and
                stat_identity(os.fstat(mount)) == namespace["mount"] and
                stat_identity(os.fstat(user)) == namespace["user"])
        owner = fcntl.ioctl(mount, NS_GET_USERNS)
        try:
            require(stat_identity(os.fstat(owner)) == namespace["user"])
        finally:
            os.close(owner)
        root = os.open(f"/proc/{pid}/root", os.O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
        descriptors.append(root)
        require(stat_identity(os.fstat(root)) == namespace["root"])
        mounts = mount_table(pid)
        require_private_mounts(mounts)
        require_capture_closure(records, mounts)
        refuse_mask_aliases(records, mounts)
        indexed = {row["id"]: row for row in mounts}
        all_records = records["roots"] + records["origins"]
        if original_pins is not None:
            require(len(original_pins) == len(all_records))
        for index, record in enumerate(all_records):
            require(record["mountID"] in indexed)
            row = indexed[record["mountID"]]
            if original_pins is not None:
                require(source_record(original_pins[index], record["path"], row) == record)
            fd = pin_source(root, record["path"])
            sources.append(fd)
            require(source_record(fd, record["path"], row) == record)
        # Reopen every route while its first descriptor remains pinned. Equality of two arbitrary mount
        # snapshots is insufficient: each identity must equal the digest-bound construction capture.
        for record, fd in zip(all_records, sources, strict=True):
            row = indexed[record["mountID"]]
            require(source_record(fd, record["path"], row) == record)
            again = pin_source(root, record["path"])
            try:
                require(source_record(again, record["path"], row) == record)
            finally:
                os.close(again)
        require(json_digest(mount_table(pid)) == records["topology"] and
                stat_identity(os.stat(f"/proc/{pid}/ns/mnt")) == namespace["mount"] and
                stat_identity(os.stat(f"/proc/{pid}/ns/user")) == namespace["user"] and
                stat_identity(os.stat(f"/proc/{pid}/root")) == namespace["root"])
        after = identity(pid, 0)
        require(after and after["start"] == start and after["state"] not in ("Z", "X", "x"))
        poll = select.poll()
        poll.register(process, select.POLLIN)
        require(not poll.poll(0))
    finally:
        for fd in sources + descriptors:
            os.close(fd)


def validate_keeper_identity(pid, start, uid, gid):
    current = identity(pid, uid)
    require(current and current["start"] == start and current["state"] not in ("Z", "X", "x"))
    status = dict(line.split(":", 1) for line in pathlib.Path(f"/proc/{pid}/status").read_text().splitlines() if ":" in line)
    require(status["Pid"].split() == [str(pid)] and
            status["Uid"].split() == [str(uid)] * 4 and status["Gid"].split() == [str(gid)] * 4 and
            status["Groups"].split() == [] and status["NSpid"].split()[-1] == "1" and
            all(int(status[name].strip(), 16) == 0 for name in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb")) and
            status["NoNewPrivs"].strip() == "1" and
            pathlib.Path(f"/proc/{pid}/uid_map").read_text().split() == ["0", str(uid), "1"] and
            pathlib.Path(f"/proc/{pid}/gid_map").read_text().split() == ["0", str(gid), "1"])


def validate_masks(pid, start, uid, gid, records):
    # Host Root observes only metadata/empty directory listings through its own proc. No handle reaches the model.
    mask_records(records)
    state = read_state()
    value = state["public"]
    require(state["maskSources"] == records and value["keeper"] == {"pid": pid, "start": start} and
            value["uid"] == uid and value["gid"] == gid)
    source = value.get("broker")
    if source is None:
        # The unpublished setup child is the only source authority before broker adoption.
        require(state["phase"] == "keeper-ready")
        source = identity(os.getpid(), 0)
        require(source and source["state"] not in ("Z", "X", "x"))
    else:
        require(state["phase"] in ("broker-pending", "adopted"))
    validate_source_view(source["pid"], source["start"], records)
    pin = os.pidfd_open(pid, 0)
    descriptors = {}
    visible_fds = []
    keeper_root = None
    try:
        validate_keeper_identity(pid, start, uid, gid)
        for kind in KINDS:
            descriptors[kind] = os.open(f"/proc/{pid}/ns/{kind}", os.O_RDONLY | os.O_CLOEXEC)
        validate_descriptors(value, descriptors)
        keeper_namespace = stat_identity(os.fstat(descriptors["mnt"]))
        require(keeper_namespace != records["namespace"]["mount"] and
                stat_identity(os.fstat(descriptors["user"])) != records["namespace"]["user"])
        mounts = mount_table(pid)
        require_private_mounts(mounts)
        keeper_root = os.open(f"/proc/{pid}/root", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NONBLOCK)
        root_mounts = [row for row in mounts if row["target"] == "/" and row["id"] == mount_descriptor(keeper_root)]
        require(len(root_mounts) == 1 and root_mounts[0]["readOnly"] and
                stat_identity(os.fstat(keeper_root)) == records["namespace"]["root"] and
                os.fstatvfs(keeper_root).f_flag & os.ST_RDONLY)
        root_record = source_record(keeper_root, "/", root_mounts[0])
        # Every row participates, including old covered rows and unrelated filesystem devices.
        refuse_mask_aliases(records, mounts)
        replacements = set()
        visible_records = []
        for record in records["roots"]:
            target = record["path"]
            fd = os.open(f"/proc/{pid}/root" + target,
                         os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
            visible_fds.append(fd)
            visible = os.fstat(fd)
            matching = [row for row in mounts if row["target"] == target and row["id"] == mount_descriptor(fd)]
            require(len(matching) == 1 and matching[0]["kind"] == "tmpfs" and matching[0]["root"] == "/" and
                    matching[0]["readOnly"] and matching[0]["filesystem"] not in
                    {source["filesystem"] for source in records["roots"] + records["origins"]})
            require(stat.S_ISDIR(visible.st_mode) and visible.st_uid == uid and visible.st_gid == gid and
                    stat.S_IMODE(visible.st_mode) == 0o755 and
                    matching[0]["filesystem"] == f"{os.major(visible.st_dev)}:{os.minor(visible.st_dev)}" and
                    os.fstatvfs(fd).f_flag & os.ST_RDONLY and not os.listdir(fd))
            replacements.add(matching[0]["id"])
            visible_records.append(source_record(fd, target, matching[0]))
        require_known_mask_origins(records, mounts, replacements)
        validate_source_view(source["pid"], source["start"], records)
        for record, fd in zip(visible_records, visible_fds, strict=True):
            matching = next(row for row in mounts if row["id"] == record["mountID"])
            require(source_record(fd, record["path"], matching) == record and
                    os.fstatvfs(fd).f_flag & os.ST_RDONLY and not os.listdir(fd))
            again = os.open(f"/proc/{pid}/root" + record["path"],
                            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
            try:
                require(source_record(again, record["path"], matching) == record and
                        os.fstatvfs(again).f_flag & os.ST_RDONLY and not os.listdir(again))
            finally:
                os.close(again)
        require(mount_table(pid) == mounts)
        require(source_record(keeper_root, "/", root_mounts[0]) == root_record and
                os.fstatvfs(keeper_root).f_flag & os.ST_RDONLY)
        root_again = os.open(f"/proc/{pid}/root", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NONBLOCK)
        try:
            require(source_record(root_again, "/", root_mounts[0]) == root_record and
                    os.fstatvfs(root_again).f_flag & os.ST_RDONLY)
        finally:
            os.close(root_again)
        validate_descriptors(value, descriptors)
        require(all(stat_identity(os.stat(f"/proc/{pid}/ns/{kind}")) == stat_identity(os.fstat(fd))
                    for kind, fd in descriptors.items()))
        validate_keeper_identity(pid, start, uid, gid)
        poll = select.poll()
        poll.register(pin, select.POLLIN)
        require(not poll.poll(0))
        protected_targets = sorted({row["target"] for row in mounts if hidden(row["target"])})
        proof = {"v": 2, "sourceDigest": records["digest"], "constructionNamespace": records["namespace"],
                 "keeperNamespace": keeper_namespace, "protectedMountTargets": protected_targets}
        require(len(protected_targets) <= 64 and len(json.dumps(proof, separators=(",", ":"), ensure_ascii=False).encode("utf-8")) <= 32768)
        return proof
    finally:
        os.close(pin)
        if keeper_root is not None:
            os.close(keeper_root)
        for fd in list(descriptors.values()) + visible_fds:
            os.close(fd)


def prepare_in_capture(uid, gid, container, namespace, pins):
    global _DIAGNOSTIC_STAGE
    _DIAGNOSTIC_STAGE = "prepare-input"
    require(os.geteuid() == 0 and sys.version_info >= (3, 12) and container in CONTAINERS)
    account = pwd.getpwnam("vector-agent")
    require(integer(uid) and integer(gid) and account.pw_uid == uid and account.pw_gid == gid)
    require(not os.path.lexists(PRIVATE) and not os.path.lexists(SPEC))
    secure_chain(ROOT)
    secure_chain(ROOT + "/private")
    private = os.lstat(ROOT + "/private")
    require(os.path.realpath(ROOT + "/private") == ROOT + "/private" and private.st_uid == private.st_gid == 0 and
            stat.S_IMODE(private.st_mode) == 0o700)
    secure_chain(container)
    for executable in ("/usr/bin/aa-exec", "/usr/bin/prlimit", "/usr/bin/setpriv", "/usr/bin/env", "/usr/bin/bwrap",
                       "/usr/bin/nsenter", "/usr/bin/mount", "/usr/bin/chmod"):
        secure_chain(executable)
    require(os.path.realpath(container) == container and stat.S_IMODE(os.stat(container).st_mode) == 0o755)
    stage = container + "/checkout"
    info = os.lstat(stage)
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == uid and info.st_gid == gid and os.path.realpath(stage) == stage)
    value = {"v": 1, "container": container, "uid": uid, "gid": gid, "stage": stage,
             "scratch": container + "/tool-scratch", "directory": container + "/tool-namespaces",
             "socket": container + "/tool-namespaces/broker.sock", "nonce": os.urandom(16).hex()}
    _DIAGNOSTIC_STAGE = "prepare-masks"
    masks = supported_mask_sources(uid, gid, namespace, pins)
    _DIAGNOSTIC_STAGE = "prepare-images"
    state = {"v": 1, "public": value, "phase": "recorded", "brokerPending": False, "runtimeImages": runtime_images(),
             "maskSources": masks}
    # The durable process-crash record precedes directory/child ownership. No power-loss claim is made.
    _DIAGNOSTIC_STAGE = "prepare-record"
    write_json(PRIVATE, state, 0o600)
    os.mkdir(value["directory"], 0o755)
    os.chmod(value["directory"], 0o755)
    os.mkdir(value["scratch"], 0o700)
    os.chown(value["scratch"], uid, gid)
    info_path = value["directory"] + "/keeper-info.json"
    info_fd = os.open(info_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    log_fd = os.open(value["directory"] + "/keeper.log", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    arguments = [
        "/usr/bin/aa-exec", "--profile=vector-sandbox-v1", "--", "/usr/bin/prlimit", "--core=0:0", "--",
        "/usr/bin/setpriv", f"--reuid={uid}", f"--regid={gid}", "--clear-groups", "--no-new-privs", "--",
        "/usr/bin/env", "-i", "PATH=/usr/bin:/bin", "/usr/bin/bwrap", "--info-fd", str(info_fd),
        "--unshare-user", "--uid", "0", "--gid", "0", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
        "--ro-bind", "/", "/",
        *(item for target in MASKS for item in ("--tmpfs", target, "--remount-ro", target)),
        "--bind", stage, stage, "--bind", value["scratch"], value["scratch"],
        "--dev", "/dev", "--proc", "/proc", "--cap-drop", "ALL", "--chdir", value["scratch"],
        "--clearenv", "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "HOME", value["scratch"],
        "--", "/usr/bin/python3", "-I", "-S", SELF, "keeper", value["scratch"],
    ]
    _DIAGNOSTIC_STAGE = "prepare-keeper-start"
    try:
        process = subprocess.Popen(arguments, stdin=subprocess.DEVNULL, stdout=log_fd, stderr=log_fd,
                                   close_fds=True, pass_fds=(info_fd,), start_new_session=True,
                                   env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"})
    finally:
        os.close(info_fd)
        os.close(log_fd)
    _DIAGNOSTIC_STAGE = "prepare-keeper-wait"
    ready = wait_keeper(value["scratch"] + "/keeper-ready.json", value["directory"] + "/keeper.log", uid, process)
    _DIAGNOSTIC_STAGE = "prepare-keeper-identity"
    details = read_json(info_path)
    require(type(details) is dict and integer(details.get("child-pid")))
    observed = identity(details["child-pid"], uid)
    require(observed and observed["state"] != "Z")
    pid = observed["pid"]
    require(pathlib.Path(f"/proc/{pid}/uid_map").read_text().split() == ["0", str(uid), "1"] and
            pathlib.Path(f"/proc/{pid}/gid_map").read_text().split() == ["0", str(gid), "1"])
    require(ready["uid"] == ready["gid"] == 0)
    value["namespaces"] = {kind: os.stat(f"/proc/{pid}/ns/{kind}").st_ino for kind in KINDS}
    value["devices"] = {kind: os.stat(f"/proc/{pid}/ns/{kind}").st_dev for kind in KINDS}
    require(value["namespaces"] == ready["namespaces"] and all(
        value["namespaces"][kind] != os.stat("/proc/self/ns/" + kind).st_ino for kind in KINDS))
    value["keeper"] = {"pid": pid, "start": observed["start"]}
    state["phase"] = "keeper-ready"
    save_state(state)
    descriptors = {kind: os.open(f"/proc/{pid}/ns/{kind}", os.O_RDONLY | os.O_CLOEXEC) for kind in KINDS}
    listener = None
    try:
        _DIAGNOSTIC_STAGE = "prepare-namespaces"
        validate_descriptors(value, descriptors)
        enter = ["/usr/bin/nsenter", f"--mount=/proc/self/fd/{descriptors['mnt']}",
                 f"--pid=/proc/self/fd/{descriptors['pid']}", "--"]
        _DIAGNOSTIC_STAGE = "prepare-mounts"
        fixed([*enter, "/usr/bin/mount", "--make-rprivate", "/"],
              pass_fds=(descriptors["mnt"], descriptors["pid"]), stdout=subprocess.DEVNULL)
        mounts = pathlib.Path(f"/proc/{pid}/mountinfo").read_text().splitlines()
        require(all(not any(field.startswith(("shared:", "master:", "propagate_from:"))
                            for field in line.split()[6:line.split().index("-")]) for line in mounts))
        _DIAGNOSTIC_STAGE = "prepare-mask-proof"
        validate_masks(pid, observed["start"], uid, gid, masks)
        _DIAGNOSTIC_STAGE = "prepare-endpoint"
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET | socket.SOCK_CLOEXEC)
        listener.bind(value["socket"])
        os.chown(value["socket"], 0, gid)
        os.chmod(value["socket"], 0o660)
        endpoint = os.lstat(value["socket"])
        value["socketIdentity"] = {"device": endpoint.st_dev, "inode": endpoint.st_ino}
        state["phase"] = "broker-pending"
        state["brokerPending"] = True
        save_state(state)
        log_fd = os.open(value["directory"] + "/broker.log", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        parent = os.getpid()
        _DIAGNOSTIC_STAGE = "prepare-broker-start"
        try:
            service = subprocess.Popen([
                "/usr/bin/python3", "-I", "-S", SELF, "broker", str(parent), str(listener.fileno()),
                *(str(descriptors[kind]) for kind in KINDS),
            ], stdin=subprocess.DEVNULL, stdout=log_fd, stderr=log_fd, close_fds=True,
                pass_fds=(listener.fileno(), *descriptors.values()), start_new_session=True,
                preexec_fn=lambda: arm_parent(parent), env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"})
        finally:
            os.close(log_fd)
        observed = identity(service.pid, 0)
        require(observed and observed["state"] != "Z")
        value["broker"] = {"pid": service.pid, "start": observed["start"], "uid": 0, "gid": 0}
        state["brokerPending"] = False
        save_state(state)
        expected = {"v": 1, "pid": service.pid, "nonce": value["nonce"]}
        _DIAGNOSTIC_STAGE = "prepare-broker-ready"
        require(wait_json(value["directory"] + "/broker-ready.json", 0, service) == expected)
        _DIAGNOSTIC_STAGE = "prepare-broker-adopt"
        write_json(value["directory"] + "/broker-adopt.json", {"v": 1, "nonce": value["nonce"]}, 0o600)
        require(wait_json(value["directory"] + "/broker-adopted.json", 0, service) == expected)
        state["phase"] = "adopted"
        save_state(state)
        _DIAGNOSTIC_STAGE = "prepare-broker-mask-proof"
        validate_masks(value["keeper"]["pid"], value["keeper"]["start"], uid, gid, masks)
        validate_source_view(os.getpid(), identity(os.getpid(), 0)["start"], masks, pins["sources"])
        _DIAGNOSTIC_STAGE = "prepare-publish"
        write_json(SPEC, validate_spec(value), 0o444)
    finally:
        if listener is not None:
            listener.close()
        for fd in descriptors.values():
            os.close(fd)


def prepare(uid, gid, container):
    global _DIAGNOSTIC_STAGE
    _DIAGNOSTIC_STAGE = "prepare-construction-input"
    require(os.geteuid() == 0 and sys.version_info >= (3, 12) and container in CONTAINERS)
    account = pwd.getpwnam("vector-agent")
    require(integer(uid) and integer(gid) and account.pw_uid == uid and account.pw_gid == gid)
    require(not os.path.lexists(PRIVATE) and not os.path.lexists(SPEC))
    secure_chain(ROOT)
    secure_chain(ROOT + "/private")
    _DIAGNOSTIC_STAGE = "prepare-construction-private"
    namespace, capture = capture_mount_namespace()
    pins = {"root": None, "sources": []}
    try:
        pins["root"] = os.open("/", os.O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
        require(stat_identity(os.fstat(pins["root"])) == namespace["root"])
        prepare_in_capture(uid, gid, container, namespace, pins)
    finally:
        for fd in pins["sources"]:
            os.close(fd)
        if pins["root"] is not None:
            os.close(pins["root"])
        os.close(capture)


def cleanup():
    global _DIAGNOSTIC_STAGE
    _DIAGNOSTIC_STAGE = "cleanup-input"
    require(os.geteuid() == 0)
    state = read_state()
    value = state["public"]
    account = pwd.getpwnam("vector-agent")
    require(account.pw_uid == value["uid"] and account.pw_gid == value["gid"])
    secure_chain(value["container"])
    fixed(["/usr/bin/chmod", "0700", "--", value["container"]], stdout=subprocess.DEVNULL)
    if os.path.isdir(value["directory"]):
        secure_chain(value["directory"])
        fixed(["/usr/bin/chmod", "0700", "--", value["directory"]], stdout=subprocess.DEVNULL)
    _DIAGNOSTIC_STAGE = "cleanup-quiesce"
    broker_fd = None
    failed = state["brokerPending"] or state["phase"] not in ("adopted", "quiesced", "uid-stopped", "broker-stopped")
    if not os.path.lexists(SPEC):
        failed = True
    else:
        require(validate_spec(read_json(SPEC)) == validate_spec(value))
    if "broker" in value:
        try:
            broker_fd = os.pidfd_open(value["broker"]["pid"], 0)
            current = identity(value["broker"]["pid"], 0)
            require(current and current["start"] == value["broker"]["start"] and current["state"] != "Z")
            signal_owned(broker_fd, signal.SIGUSR1)
            closed = wait_json(value["directory"] + "/broker-closed.json", 0, seconds=1)
            require(closed == {"v": 1, "pid": value["broker"]["pid"], "nonce": value["nonce"]})
            state["phase"] = "quiesced"
            save_state(state)
        except (OSError, RuntimeError, ValueError, StopIteration):
            failed = True
    elif state["phase"] not in ("recorded", "keeper-ready"):
        failed = True
    _DIAGNOSTIC_STAGE = "cleanup-uid-stop"
    deadline = time.monotonic() + 2
    while True:
        living = False
        for name in pathlib.Path("/proc").iterdir():
            if not name.name.isdigit():
                continue
            fd = None
            try:
                fd = os.pidfd_open(int(name.name), 0)
                current = identity(int(name.name), value["uid"])
                if current and current["state"] != "Z":
                    living = True
                    signal_owned(fd, signal.SIGKILL)
            except (FileNotFoundError, ProcessLookupError):
                pass
            finally:
                if fd is not None:
                    os.close(fd)
        if not living:
            break
        require(time.monotonic() < deadline, "Disposable UID cleanup is unproved; broker ownership is retained")
        time.sleep(0.01)
    state["phase"] = "uid-stopped"
    save_state(state)
    _DIAGNOSTIC_STAGE = "cleanup-broker-stop"
    if broker_fd is not None:
        try:
            current = identity(value["broker"]["pid"], 0)
            require(current and current["start"] == value["broker"]["start"])
            poll = select.poll()
            poll.register(broker_fd, select.POLLIN)
            signal_owned(broker_fd, signal.SIGTERM)
            if not poll.poll(1000):
                signal_owned(broker_fd, signal.SIGKILL)
                require(poll.poll(1000))
        finally:
            os.close(broker_fd)
    if os.path.lexists(value["socket"]):
        info = os.lstat(value["socket"])
        expected = value.get("socketIdentity")
        require(expected and stat.S_ISSOCK(info.st_mode) and info.st_uid == 0 and
                info.st_dev == expected["device"] and info.st_ino == expected["inode"])
        os.unlink(value["socket"])
    _DIAGNOSTIC_STAGE = "cleanup-images"
    for name, digest in state["runtimeImages"].items():
        secure_chain(name)
        require(image_digest(name) == digest)
    _DIAGNOSTIC_STAGE = "cleanup-proof"
    require(not failed, "Broker adoption/identity/admission stop was not proved; artifacts are refused")
    state["phase"] = "broker-stopped"
    save_state(state)
    # The Engine adapter owns artifacts and final removal. Keep this receipt/state until its independent gate accepts.
    if os.path.lexists(SPEC):
        require(validate_spec(read_json(SPEC)) == validate_spec(value))
        os.unlink(SPEC)
    _DIAGNOSTIC_STAGE = "cleanup-receipt"
    print(json.dumps({"v": 1, "event": "isolation-stopped", "uidStoppedBeforeBroker": True,
                      "brokerStopped": True, "nonce": value["nonce"]}, separators=(",", ":")), flush=True)


def trusted_entry():
    secure_chain(SELF)
    secure_chain(sys.executable)
    asset = os.lstat(SELF)
    require(os.path.realpath(ROOT) == ROOT and os.path.realpath(SELF) == SELF and stat.S_ISREG(asset.st_mode) and
            asset.st_uid == asset.st_gid == 0 and asset.st_nlink == 1 and stat.S_IMODE(asset.st_mode) == 0o444)


def main():
    require(sys.platform == "linux" and sys.version_info >= (3, 12))
    require(hasattr(os, "setns") and hasattr(os, "pidfd_open") and hasattr(signal, "pidfd_send_signal"))
    if len(sys.argv) >= 2 and sys.argv[1] == "command-init":
        require(len(sys.argv) >= 7 and sys.argv[5] == "--")
        # Arguments: command-init CONTROL SCRATCH CWD -- PROGRAM [ARG...]. No metadata/credential FD is accepted.
        os._exit(command_init(int(sys.argv[2]), sys.argv[3], sys.argv[4], sys.argv[6:]))
    if len(sys.argv) == 3 and sys.argv[1] == "keeper":
        # Host-root asset ownership is unmapped here; prepare attests it before constructing this secret-free base.
        keeper(canonical(sys.argv[2]))
        return
    if len(sys.argv) >= 8 and sys.argv[1:3] == ["exec", "--parent"] and sys.argv[4] == "--cwd" and sys.argv[6] == "--":
        parent = int(sys.argv[3])
        previous, parent_fd = bind_engine_parent(parent)
        trusted_entry()
        os._exit(execute(parent, previous, parent_fd, sys.argv[5], sys.argv[7:]))
    trusted_entry()
    if len(sys.argv) == 5 and sys.argv[1] == "prepare":
        prepare(int(sys.argv[2]), int(sys.argv[3]), sys.argv[4])
        return
    if len(sys.argv) == 7 and sys.argv[1] == "broker":
        broker(int(sys.argv[2]), int(sys.argv[3]), dict(zip(KINDS, map(int, sys.argv[4:]), strict=True)))
        return
    if sys.argv[1:] == ["cleanup"]:
        cleanup()
        return
    raise RuntimeError("Unsupported fixed Linux isolation operation")


if __name__ == "__main__":
    try:
        main()
    except BaseException as error:
        # Do not print model argv, environment, metadata or credential-bearing parent diagnostics.
        try:
            control_failure(error)
        except BaseException:
            pass
        os._exit(125)
