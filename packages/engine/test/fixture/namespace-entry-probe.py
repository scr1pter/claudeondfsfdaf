"""Disposable CI experiment, not the production process floor.

Only prepare/cleanup run as root. The engine invokes the fixed launch mode after
loading its real private channel. No channel value is passed to this module.
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
import signal
import stat
import subprocess
import sys
import time


SELF = "/opt/vector-namespace-entry.py"
SPEC = "/opt/vector-namespace-entry.json"
PRIVATE = "/opt/vector-namespace-entry-private.json"
CONTAINERS = ("/mnt/vector-agent-sandbox", "/var/lib/vector-agent-sandbox", "/home/vector-agent-sandbox")
KINDS = {"user": 0x10000000, "mnt": 0x00020000, "pid": 0x20000000}
NS_GET_USERNS = 0xB701
NS_GET_NSTYPE = 0xB703
NS_GET_OWNER_UID = 0xB704
LIBC = ctypes.CDLL(None, use_errno=True)
LIBC.close_range.argtypes = (ctypes.c_uint, ctypes.c_uint, ctypes.c_int)
LIBC.close_range.restype = ctypes.c_int
LIBC.prctl.argtypes = (ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong)
LIBC.prctl.restype = ctypes.c_int
LIBC.mount.argtypes = (ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_ulong, ctypes.c_void_p)
LIBC.mount.restype = ctypes.c_int


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def output(value):
    print(json.dumps(value, separators=(",", ":")), flush=True)


def fixed(command, **options):
    return subprocess.run(command, check=True, timeout=5, env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"}, **options)


def read_json(path, owner=None, digest=None):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_size <= 65536 and info.st_nlink == 1, "Invalid bounded metadata")
        require(owner is None or info.st_uid == owner, "Metadata owner changed")
        require(not info.st_mode & 0o022, "Metadata is writable by another identity")
        data = os.read(fd, 65537)
        require(len(data) <= 65536, "Metadata grew past its bound")
        require(digest is None or hashlib.sha256(data).hexdigest() == digest, "The captured prototype metadata changed")
        return json.loads(data)
    finally:
        os.close(fd)


def write_json(path, value, mode):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, "w") as file:
        json.dump(value, file, separators=(",", ":"))


def process_identity(pid):
    text = pathlib.Path(f"/proc/{pid}/stat").read_text()
    fields = text[text.rindex(")") + 2:].split()
    status = pathlib.Path(f"/proc/{pid}/status").read_text()
    uid = int(next(line for line in status.splitlines() if line.startswith("Uid:")).split()[1])
    return {"pid": pid, "start": fields[19], "uid": uid, "state": fields[0]}


def secure_chain(path):
    resolved = pathlib.Path(path).resolve(strict=True)
    for part in (resolved, *resolved.parents):
        info = part.stat()
        require(info.st_uid == 0 and not info.st_mode & 0o022, "A trusted Python/launcher path is mutable")
    return str(resolved)


def validate_spec(value):
    require(value["v"] == 1 and value["container"] in CONTAINERS, "Invalid prototype scope")
    require(type(value["uid"]) is int and value["uid"] > 0 and type(value["gid"]) is int and value["gid"] > 0,
            "Invalid disposable identity")
    require(value["stage"] == value["container"] + "/checkout", "Invalid prototype worktree")
    require(value["scratch"] == value["container"] + "/namespace-entry-scratch", "Invalid prototype scratch")
    require(value["directory"] == value["container"] + "/tool-namespaces", "Invalid prototype handles")
    require(value["observer"] == value["container"] + "/namespace-observer", "Invalid prototype observer")
    for kind in KINDS:
        require(value["pins"][kind] == value["directory"] + "/" + kind, "Unexpected namespace path")
    return value


def status_values():
    return dict(line.split(":", 1) for line in pathlib.Path("/proc/self/status").read_text().splitlines() if ":" in line)


def assert_caps():
    values = status_values()
    require(all(int(values[name].strip(), 16) == 0 for name in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb")),
            "Capabilities survived the fixed launcher")
    require(values["NoNewPrivs"].strip() == "1", "No-new-privileges was lost")


def keeper(scratch):
    require(os.getuid() == 0 and os.getgid() == 0 and os.getgroups() == [], "Unexpected keeper identity")
    assert_caps()
    require(not any(name.startswith(("GITHUB_", "ACTIONS_", "VECTOR_", "LD_")) for name in os.environ),
            "The keeper inherited a credential environment")
    write_json(scratch + "/keeper-ready.pending", {
        "v": 1, "pid": os.getpid(), "uid": os.getuid(), "gid": os.getgid(), "groups": os.getgroups(),
        "namespaces": {kind: os.stat("/proc/self/ns/" + kind).st_ino for kind in KINDS},
    }, 0o600)
    os.rename(scratch + "/keeper-ready.pending", scratch + "/keeper-ready.json")
    while True:
        signal.pause()


def prepare(state_path):
    require(os.geteuid() == 0 and sys.version_info >= (3, 12), "Root and Python 3.12 are required for this CI experiment")
    state = read_json(state_path, int(os.environ["SUDO_UID"]))
    account = pwd.getpwnam("vector-agent")
    require(state["prepared"] and state["created"] and not state["sudo"] and state["mode"] == "codium",
            "The real sandbox was not prepared")
    require(state["uid"] == account.pw_uid and state["gid"] == account.pw_gid, "Disposable identity changed")
    require(state["container"] in CONTAINERS, "Unexpected staging container")
    require(not os.path.lexists(SPEC) and not os.path.lexists(PRIVATE), "A prototype is already present")
    secure_chain(SELF)
    secure_chain(sys.executable)
    # -I -S imports only the system runtime. Verify every loaded standard-library/extension path before capture.
    for module in tuple(sys.modules.values()):
        source = getattr(module, "__file__", None)
        if source and source != __file__:
            secure_chain(source)
    images = {}
    for line in pathlib.Path("/proc/self/maps").read_text().splitlines():
        fields = line.split(maxsplit=5)
        if len(fields) < 6 or not fields[5].startswith("/"):
            continue
        require(not fields[5].endswith(" (deleted)"), "A trusted runtime image was replaced")
        path = secure_chain(fields[5])
        images[path] = hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()
    require(any("ld-linux" in path for path in images) and any("libc.so" in path for path in images) and
            any("libffi.so" in path for path in images), "The trusted loader/libc/libffi image inventory is incomplete")
    container = state["container"]
    directory = container + "/tool-namespaces"
    scratch = container + "/namespace-entry-scratch"
    canary_directory = container + "/trusted-namespace-canary"
    canary = canary_directory + "/module.py"
    pins = {kind: directory + "/" + kind for kind in KINDS}
    value = {"v": 1, "container": container, "uid": account.pw_uid, "gid": account.pw_gid,
             "stage": container + "/checkout", "scratch": scratch, "directory": directory, "pins": pins,
             "observer": container + "/namespace-observer"}
    # Record cleanup ownership before starting any long-lived child or creating a mount.
    write_json(PRIVATE, value, 0o600)
    os.mkdir(directory, 0o755)
    os.mkdir(value["observer"], 0o755)
    os.mkdir(scratch, 0o700)
    os.chown(scratch, account.pw_uid, account.pw_gid)
    os.mkdir(canary_directory, 0o777)
    os.chown(canary_directory, account.pw_uid, account.pw_gid)
    os.chmod(canary_directory, 0o777)
    pathlib.Path(canary).write_text("print('trusted-namespace-canary')\n")
    os.chown(canary, account.pw_uid, account.pw_gid)
    os.chmod(canary, 0o666)
    for pin in pins.values():
        fd = os.open(pin, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o444)
        os.close(fd)
    # Valid ancestor handles are installed by trusted root after readiness, not guessed from PID numbers in a tool.
    for kind in ("user", "pid"):
        fd = os.open(directory + "/ancestor-" + kind, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o444)
        os.close(fd)
    info = os.open(directory + "/info.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    log = os.open(directory + "/keeper.log", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    command = [
        "/usr/bin/aa-exec", "--profile=vector-isolation-diagnostic", "--", "/usr/bin/prlimit", "--core=0:0", "--",
        "/usr/bin/setpriv", f"--reuid={account.pw_uid}", f"--regid={account.pw_gid}", "--clear-groups", "--no-new-privs",
        "--", "/usr/bin/env", "-i", "PATH=/usr/bin:/bin", "/usr/bin/bwrap", "--info-fd", str(info),
        "--unshare-user", "--uid", "0", "--gid", "0", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
        "--ro-bind", "/", "/", "--bind", value["stage"], value["stage"], "--bind", scratch, scratch,
        "--dev", "/dev", "--proc", "/proc", "--cap-drop", "ALL", "--chdir", scratch,
        "--clearenv", "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "HOME", scratch,
        "--", "/usr/bin/python3", "-I", "-S", SELF, "keeper", scratch,
    ]
    child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=log, stderr=log, pass_fds=(info,),
                             start_new_session=True, env={"PATH": "/usr/bin:/bin"})
    os.close(info)
    os.close(log)
    deadline = time.monotonic() + 5
    while not os.path.exists(scratch + "/keeper-ready.json"):
        if child.poll() is not None:
            # This fixed keeper has no credentials or repository command; preserve only bounded setup diagnostics.
            detail = pathlib.Path(directory + "/keeper.log").read_bytes()[:800].decode("utf8", "replace")
            detail = " ".join(detail.split())
            raise RuntimeError(f"The secret-free keeper refused setup (exit {child.returncode}): {detail}")
        require(time.monotonic() < deadline, "The namespace keeper did not acknowledge readiness")
        time.sleep(0.01)
    ready = read_json(scratch + "/keeper-ready.json", account.pw_uid)
    details = read_json(directory + "/info.json", 0)
    pid = details["child-pid"]
    require(type(pid) is int and pid > 1, "No host keeper PID was reported")
    identity = process_identity(pid)
    require(identity["uid"] == account.pw_uid and identity["state"] != "Z", "Invalid host keeper identity")
    require(pathlib.Path(f"/proc/{pid}/uid_map").read_text().split() == ["0", str(account.pw_uid), "1"],
            "The keeper user mapping is broader than one disposable UID")
    require(pathlib.Path(f"/proc/{pid}/gid_map").read_text().split() == ["0", str(account.pw_gid), "1"],
            "The keeper group mapping is broader than one disposable GID")
    require(ready["groups"] == [] and ready["uid"] == 0 and ready["gid"] == 0, "Keeper group clearing failed")
    namespaces = {kind: os.stat(f"/proc/{pid}/ns/{kind}").st_ino for kind in KINDS}
    devices = {kind: os.stat(f"/proc/{pid}/ns/{kind}").st_dev for kind in KINDS}
    require(namespaces == ready["namespaces"], "Host and keeper namespace observations disagree")
    require(all(namespaces[kind] != os.stat("/proc/self/ns/" + kind).st_ino for kind in KINDS),
            "The keeper shares a host namespace")
    for kind, pin in pins.items():
        fixed(["/usr/bin/mount", "--bind", f"/proc/{pid}/ns/{kind}", pin], stdout=subprocess.DEVNULL)
    value.update({"namespaces": namespaces, "devices": devices, "runtimeImages": images,
                  "keeper": {"pid": pid, "start": identity["start"]},
                  "canary": {"path": canary, "sha256": hashlib.sha256(pathlib.Path(canary).read_bytes()).hexdigest()}})
    for descriptor in validate_pins(value).values():
        os.close(descriptor)
    # bwrap's ordinary slave propagation still receives future parent mounts. Make this base fully private before capture.
    fixed(["/usr/bin/nsenter", "--mount=" + pins["mnt"], "--pid=" + pins["pid"], "--",
           "/usr/bin/mount", "--make-rprivate", "/"], stdout=subprocess.DEVNULL)
    # The root helper exits before credential capture. It mounts only the base keeper's own ancestor user/PID handles.
    # No engine, host user/PID namespace or host proc tree is made available to a tool.
    for kind in ("user", "pid"):
        fixed(["/usr/bin/nsenter", "--mount=" + pins["mnt"], "--pid=" + pins["pid"], "--",
               "/usr/bin/mount", "--bind", "/proc/1/ns/" + kind, directory + "/ancestor-" + kind],
              stdout=subprocess.DEVNULL)
    mounts = pathlib.Path(f"/proc/{pid}/mountinfo").read_text().splitlines()
    require(all(not any(field.startswith(("shared:", "master:", "propagate_from:"))
                        for field in line.split()[6:line.split().index("-")]) for line in mounts),
            "The secret-free base has shared or slave propagation")
    require("ro" in next(line.split()[5] for line in mounts if line.split()[4] == "/").split(","),
            "The base trusted root is not read-only")
    write_json(SPEC, value, 0o444)
    output({"event": "namespace-prepared", "v": 1, "separateNamespaces": True, "exactMapping": True,
            "emptyGroups": True, "readOnlyBase": True, "engineReadOnlyQualified": False})


def validate_pins(value):
    descriptors = {}
    try:
        for kind, path in value["pins"].items():
            descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
            descriptors[kind] = descriptor
            require(fcntl.ioctl(descriptor, NS_GET_NSTYPE) == KINDS[kind], "A namespace handle has the wrong type")
            info = os.fstat(descriptor)
            require(info.st_ino == value["namespaces"][kind] and info.st_dev == value["devices"][kind],
                    "A namespace handle was replaced")
        owner = array.array("I", [0])
        fcntl.ioctl(descriptors["user"], NS_GET_OWNER_UID, owner, True)
        require(owner[0] == value["uid"], "The tool user namespace has the wrong owning UID")
        for kind in ("mnt", "pid"):
            owner_fd = fcntl.ioctl(descriptors[kind], NS_GET_USERNS)
            try:
                require(os.fstat(owner_fd).st_ino == value["namespaces"]["user"], "A namespace has a different owner")
            finally:
                os.close(owner_fd)
        return descriptors.copy()
    except BaseException:
        for descriptor in descriptors.values():
            os.close(descriptor)
        raise


def drop_capabilities():
    # Do this while setns-granted capabilities still permit bounding-set reduction.
    for capability in range(64):
        if LIBC.prctl(24, capability, 0, 0, 0) != 0:
            require(ctypes.get_errno() == errno.EINVAL, "Could not close the capability bounding set")
    require(LIBC.prctl(47, 4, 0, 0, 0) == 0, "Could not clear ambient capabilities")

    class Header(ctypes.Structure):
        _fields_ = [("version", ctypes.c_uint32), ("pid", ctypes.c_int)]

    class Data(ctypes.Structure):
        _fields_ = [("effective", ctypes.c_uint32), ("permitted", ctypes.c_uint32), ("inheritable", ctypes.c_uint32)]

    header = Header(0x20080522, 0)
    values = (Data * 2)()
    require(LIBC.capset(ctypes.byref(header), ctypes.byref(values)) == 0, "Could not drop process capabilities")
    require(LIBC.capget(ctypes.byref(header), ctypes.byref(values)) == 0 and
            all(item.effective == item.permitted == item.inheritable == 0 for item in values),
            "Process capabilities survived namespace entry")
    require(all(LIBC.prctl(23, capability, 0, 0, 0) == 0 for capability in range(41)),
            "The capability bounding set is not empty")
    require(LIBC.prctl(39, 0, 0, 0, 0) == 1, "No-new-privileges was lost during namespace entry")
    # The parent is still in the host PID namespace. Its new proc mount intentionally has no /proc/self until fork.


def launch(engine, mode):
    require(type(engine) is int and engine > 1 and mode in ("normal", "wait", "delay"), "Invalid fixed launch mode")
    require(os.getgroups() == [], "The engine retained supplementary groups")
    require(LIBC.prctl(39, 0, 0, 0, 0) == 1, "The engine omitted no-new-privileges")
    require(pathlib.Path("/proc").is_dir() and list(pathlib.Path("/proc").iterdir()) == [], "The engine proc is not empty")
    value = validate_spec(read_json(SPEC, 0))
    spec_digest = hashlib.sha256(pathlib.Path(SPEC).read_bytes()).hexdigest()
    require(os.getuid() == value["uid"] and os.getgid() == value["gid"], "The launch identity is not the disposable agent")
    proof = os.fstat(3)
    require(stat.S_ISREG(proof.st_mode), "The fixture did not receive the real private proof descriptor")
    require(resource.getrlimit(resource.RLIMIT_NOFILE)[0] > 2003, "The high-FD counterfactual is not available")
    os.dup2(3, 2003, inheritable=True)
    require(os.fstat(2003).st_ino == proof.st_ino and os.get_inheritable(2003), "The high inherited FD control failed")
    limit = resource.getrlimit(resource.RLIMIT_NOFILE)
    resource.setrlimit(resource.RLIMIT_NOFILE, (128, limit[1]))
    # This syscall ignores the now-lowered soft limit. CLOEXEC alone would leave the descriptor in the base namespace.
    require(LIBC.close_range(3, 0xFFFFFFFF, 0) == 0, "The fixed launcher could not close every inherited descriptor")
    for descriptor in (3, 2003):
        try:
            os.fstat(descriptor)
        except OSError as error:
            require(error.errno == errno.EBADF, "Unexpected inherited-descriptor closure failure")
        else:
            raise RuntimeError("An engine descriptor survived close_range")
    descriptors = validate_pins(value)
    # The engine is in the owning parent user namespace, never a sibling of this secret-free tool namespace.
    os.setns(descriptors["user"], KINDS["user"])
    os.setns(descriptors["mnt"], KINDS["mnt"])
    os.setns(descriptors["pid"], KINDS["pid"])
    for descriptor in descriptors.values():
        os.close(descriptor)
    require(os.getuid() == 0 and os.getgid() == 0 and os.getgroups() == [], "Exact kernel UID mapping was not preserved")
    os.chdir("/")
    if mode == "delay":
        # A bounded pre-fork point exercises cancellation before any payload readiness signal.
        time.sleep(0.2)
    # Keep setup capabilities only in the immutable child through bwrap's UID-map/mount setup.
    # Dropping before its 0 -> base0 map would fail Linux >=5.12's CAP_SETFCAP creator check.
    blocked = {signal.SIGTERM, signal.SIGINT, signal.SIGHUP}
    previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, blocked)
    life_read, life_write = os.pipe2(os.O_CLOEXEC | os.O_NONBLOCK)
    child = os.fork()
    if child == 0:
        os.close(life_write)
        require(LIBC.prctl(1, signal.SIGKILL, 0, 0, 0) == 0, "The trusted fork could not bind its first parent-death slot")
        try:
            require(os.read(life_read, 1) != b"", "The trusted launcher died before parent-death protection was armed")
        except BlockingIOError:
            pass  # The parent still owns the only writer; no byte is ever written.
        os.close(life_read)
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
        arguments = [
            "/usr/bin/bwrap", "--die-with-parent", "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
            "--uid", "1000", "--gid", "1000",
            "--ro-bind", "/", "/", "--bind", value["stage"], value["stage"], "--bind", value["scratch"], value["scratch"],
            "--dev", "/dev", "--proc", "/proc", "--cap-drop", "ALL", "--chdir", value["stage"],
            "--", "/usr/bin/python3", "-I", "-S", SELF, "payload", str(engine), mode,
            str(proof.st_dev), str(proof.st_ino), spec_digest,
        ]
        os.execve(arguments[0], arguments, {"PATH": "/usr/bin:/bin", "HOME": value["scratch"]})
    os.close(life_read)
    drop_capabilities()
    # This is not the cleanup authority: the host supervisor verifies every detached group before the final UID sweep.
    def forward(received, frame):
        try:
            os.kill(child, received)
        except ProcessLookupError:
            pass

    for number in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(number, forward)
    signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
    _, result = os.waitpid(child, 0)
    os.close(life_write)
    os._exit(os.waitstatus_to_exitcode(result) if os.WIFEXITED(result) else 128 + os.WTERMSIG(result))


def refused_namespace(path, kind, expected):
    descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        require(fcntl.ioctl(descriptor, NS_GET_NSTYPE) == KINDS[kind] and os.fstat(descriptor).st_ino == expected,
                "The failed-ascent test did not receive a valid ancestor handle")
        try:
            os.setns(descriptor, KINDS[kind])
        except OSError as error:
            require(error.errno == errno.EPERM, "Unexpected namespace-ascent failure")
            return True
        raise RuntimeError("A model child ascended into its ancestor namespace")
    finally:
        os.close(descriptor)


def payload(engine, mode, device, inode, digest):
    # Host root is intentionally unmapped here. Bind the public data to the exact root-verified bytes captured before entry.
    value = validate_spec(read_json(SPEC, digest=digest))
    assert_caps()
    require(os.getgroups() == [] and os.getuid() == 1000 and os.getgid() == 1000, "Tool identities or groups are broader than expected")
    require(pathlib.Path("/proc/self/uid_map").read_text().split() == ["1000", "0", "1"] and
            pathlib.Path("/proc/self/gid_map").read_text().split() == ["1000", "0", "1"], "The nested UID/GID mapping is broader than expected")
    require(os.stat("/proc/self/ns/user").st_ino != value["namespaces"]["user"] and
            os.stat("/proc/self/ns/pid").st_ino != value["namespaces"]["pid"], "The nested bwrap boundary was omitted")
    require(not os.path.exists(f"/proc/{engine}"), "The engine-shaped host PID is visible")
    try:
        os.kill(engine, signal.SIGUSR1)
    except ProcessLookupError:
        pass
    else:
        raise RuntimeError("The tool can signal the engine-shaped target")
    for name in os.listdir("/proc/self/fd"):
        try:
            info = os.stat("/proc/self/fd/" + name)
        except FileNotFoundError:
            continue
        require((info.st_dev, info.st_ino) != (device, inode), "A private engine descriptor entered the model namespace")
        require(int(name) < 3, "A trusted setup descriptor entered the model payload")
    require(sys.stdin.readline(128) == "namespace-entry-stdio\n", "Tool stdin did not survive namespace entry")
    null = os.stat("/dev/null")
    require(stat.S_ISCHR(null.st_mode) and (os.major(null.st_rdev), os.minor(null.st_rdev)) == (1, 3), "Private /dev/null is invalid")
    for flags in (os.O_RDONLY, os.O_WRONLY):
        descriptor = os.open("/dev/null", flags)
        os.close(descriptor)
    ancestor_user = refused_namespace(value["directory"] + "/ancestor-user", "user", value["namespaces"]["user"])
    ancestor_pid = refused_namespace(value["directory"] + "/ancestor-pid", "pid", value["namespaces"]["pid"])
    canary = value["canary"]["path"]
    for action in (lambda: os.open(canary, os.O_WRONLY), lambda: os.rename(canary, canary + ".poison"),
                   lambda: os.chmod(canary, 0o777), lambda: os.symlink("/dev/null", canary + ".link")):
        try:
            action()
        except OSError as error:
            require(error.errno == errno.EROFS, "The writable canary was not protected by the read-only mount")
        else:
            raise RuntimeError("A child mutated a trusted next-step dependency")
    require(hashlib.sha256(pathlib.Path(canary).read_bytes()).hexdigest() == value["canary"]["sha256"], "Trusted canary bytes changed")
    for writable in (value["stage"], value["scratch"]):
        path = writable + "/namespace-entry-write-" + str(os.getpid())
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.write(descriptor, b"isolated worktree/scratch write\n")
        os.close(descriptor)
        os.unlink(path)
    mounts = pathlib.Path("/proc/self/mountinfo").read_text().splitlines()
    require(all(not any(field.startswith(("shared:", "master:", "propagate_from:"))
                        for field in line.split()[6:line.split().index("-")]) for line in mounts),
            "A child inherited shared or slave mount propagation")
    root_options = next(line.split()[5].split(",") for line in mounts if line.split()[4] == "/")
    require("ro" in root_options, "The nested root is writable")
    option_flags = {"nosuid": 2, "nodev": 4, "noexec": 8, "sync": 16, "dirsync": 128,
                    "mand": 64, "noatime": 1024, "nodiratime": 2048, "relatime": 1 << 21, "lazytime": 1 << 25}
    require(all(option == "ro" or option in option_flags for option in root_options), "Unknown root mount flags")
    remount_flags = 32 | 4096
    for option in root_options:
        remount_flags |= option_flags.get(option, 0)
    # Even a new child user namespace with fresh namespace-local mount capabilities must inherit locked RO mounts.
    child = os.fork()
    if child == 0:
        phase = "unshare-user"
        try:
            os.unshare(KINDS["user"])
            phase = "uid-map"
            pathlib.Path("/proc/self/uid_map").write_text("0 1000 1\n")
            phase = "gid-map"
            if pathlib.Path("/proc/self/setgroups").read_text().strip() == "allow":
                pathlib.Path("/proc/self/setgroups").write_text("deny\n")
            require(pathlib.Path("/proc/self/setgroups").read_text().strip() == "deny", "Counterfactual groups were not denied")
            pathlib.Path("/proc/self/gid_map").write_text("0 1000 1\n")
            require(pathlib.Path("/proc/self/uid_map").read_text().split() == ["0", "1000", "1"] and
                    pathlib.Path("/proc/self/gid_map").read_text().split() == ["0", "1000", "1"] and
                    os.getuid() == 0 and os.getgid() == 0, "The remount counterfactual did not complete its UID/GID maps")
            phase = "unshare-mount"
            os.unshare(KINDS["mnt"])
            # Preserve every original mount option. The only attempted relaxation is removing MS_RDONLY.
            result = LIBC.mount(None, b"/", None, remount_flags, None)
            phase = "readonly-remount"
            require(result == -1 and ctypes.get_errno() == errno.EPERM, "A child remounted the trusted root writable")
            os._exit(0)
        except BaseException as error:
            # Fixed category/code only; do not print payload environment, argv or arbitrary exception values.
            os.write(2, (json.dumps({"event": "namespace-remount-control-failed", "phase": phase,
                                     "code": getattr(error, "errno", None), "type": type(error).__name__}) + "\n").encode())
            os._exit(1)
    _, result = os.waitpid(child, 0)
    require(os.WIFEXITED(result) and os.WEXITSTATUS(result) == 0, "The locked-read-only remount control failed")
    identity = {"uid": os.getuid(), "gid": os.getgid(), "uidMap": [int(item) for item in pathlib.Path("/proc/self/uid_map").read_text().split()],
                "gidMap": [int(item) for item in pathlib.Path("/proc/self/gid_map").read_text().split()],
                "userNamespace": os.stat("/proc/self/ns/user").st_ino,
                "pidNamespace": os.stat("/proc/self/ns/pid").st_ino, "privatePid": os.getpid()}
    output({"event": "namespace-ready", "v": 1, "identity": identity})
    if mode == "wait":
        while True:
            signal.pause()
    output({"event": "namespace-result", "v": 1, "identity": identity, "entry": True, "fdClosed": True, "highFdControl": True,
            "stdio": True, "privateProc": True, "signalBlocked": True, "groupsEmpty": True,
            "capabilitiesDropped": True, "noNewPrivileges": True, "readOnly": True, "worktreeWritable": True,
            "scratchWritable": True,
            "ancestorUserDenied": ancestor_user, "ancestorPidDenied": ancestor_pid})


def cleanup():
    require(os.geteuid() == 0, "Only trusted root may unpin namespaces")
    value = validate_spec(read_json(PRIVATE, 0))
    # First seal every model-writable root, then stop the whole disposable UID, not just a leader PID or namespace.
    fixed(["/usr/bin/chmod", "0700", value["container"]], stdout=subprocess.DEVNULL)
    deadline = time.monotonic() + 2
    while True:
        living = []
        for pid in pathlib.Path("/proc").iterdir():
            if not pid.name.isdigit():
                continue
            descriptor = None
            try:
                descriptor = os.pidfd_open(int(pid.name), 0)
                identity = process_identity(int(pid.name))
                if identity["uid"] == value["uid"] and identity["state"] != "Z":
                    living.append(identity["pid"])
                    signal.pidfd_send_signal(descriptor, signal.SIGKILL)
            except (ProcessLookupError, FileNotFoundError):
                pass
            finally:
                if descriptor is not None:
                    os.close(descriptor)
        if not living:
            break
        require(time.monotonic() < deadline, "Disposable UID cleanup was not proven; namespace pins remain")
        time.sleep(0.01)
    # Lost/partial prepare is still an owned operation; only exact fixed pin paths can be unmounted.
    for kind in reversed(tuple(KINDS)):
        pin = value["pins"][kind]
        result = subprocess.run(["/usr/bin/umount", "--", pin], capture_output=True, timeout=5,
                                env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"})
        require(result.returncode == 0 or not os.path.ismount(pin), "Owned namespace pin could not be removed")
    if os.path.exists(SPEC):
        public = validate_spec(read_json(SPEC, 0))
        require(public["uid"] == value["uid"] and public["container"] == value["container"], "Prototype scope changed")
        for path, digest in public["runtimeImages"].items():
            secure_chain(path)
            require(hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest() == digest, "A trusted runtime image changed")
        require(hashlib.sha256(pathlib.Path(public["canary"]["path"]).read_bytes()).hexdigest() == public["canary"]["sha256"],
                "The trusted next-step canary was poisoned")
        require(fixed(["/usr/bin/python3", "-I", "-S", public["canary"]["path"]], capture_output=True).stdout ==
                b"trusted-namespace-canary\n", "Trusted next-step behavior changed")
        os.unlink(SPEC)
    os.unlink(PRIVATE)
    output({"event": "namespace-cleaned", "v": 1, "uidStoppedBeforeUnpin": True, "trustedCanaryUnchanged": True})


def observe(pid, start):
    """A fixed root-only metadata reader; cross-UID nsfs metadata is otherwise correctly denied by Yama."""
    require(os.geteuid() == 0 and 1 < pid < (1 << 31) and start.isdigit() and len(start) <= 32,
            "Invalid host metadata request")
    value = validate_spec(read_json(SPEC, 0))
    descriptor = os.pidfd_open(pid, 0)
    try:
        before = process_identity(pid)
        require(before["start"] == start and before["uid"] == value["uid"] and before["state"] != "Z",
                "The observed process is not the captured disposable identity")
        status = dict(line.split(":", 1) for line in pathlib.Path(f"/proc/{pid}/status").read_text().splitlines() if ":" in line)
        text = pathlib.Path(f"/proc/{pid}/stat").read_text()
        fields = text[text.rindex(")") + 2:].split()
        receipt = {"pid": pid, "start": start, "uid": before["uid"], "gid": int(status["Gid"].split()[0]),
                   "pgrp": int(fields[2]), "state": fields[0], "nspid": [int(item) for item in status["NSpid"].split()],
                   "userNamespace": os.stat(f"/proc/{pid}/ns/user").st_ino,
                   "pidNamespace": os.stat(f"/proc/{pid}/ns/pid").st_ino,
                   "uidMap": [int(item) for item in pathlib.Path(f"/proc/{pid}/uid_map").read_text().split()],
                   "gidMap": [int(item) for item in pathlib.Path(f"/proc/{pid}/gid_map").read_text().split()]}
        after = process_identity(pid)
        require(after["start"] == start and after["uid"] == before["uid"] and after["state"] != "Z" and fields[19] == start,
                "The captured host process changed during observation")
        output(receipt)
    finally:
        os.close(descriptor)


if __name__ == "__main__":
    # This packaging mode imports the complete trusted runtime, but enters no namespace and reads no private state.
    if sys.argv[1:] == ["--module-load-check"]:
        print("Namespace-entry prototype modules loaded")
    elif len(sys.argv) == 3 and sys.argv[1] == "prepare":
        prepare(sys.argv[2])
    elif len(sys.argv) == 3 and sys.argv[1] == "keeper":
        keeper(sys.argv[2])
    elif len(sys.argv) == 4 and sys.argv[1] == "launch":
        launch(int(sys.argv[2]), sys.argv[3])
    elif len(sys.argv) == 7 and sys.argv[1] == "payload":
        payload(int(sys.argv[2]), sys.argv[3], int(sys.argv[4]), int(sys.argv[5]), sys.argv[6])
    elif sys.argv[1:] == ["cleanup"]:
        cleanup()
    elif len(sys.argv) == 4 and sys.argv[1] == "observe":
        observe(int(sys.argv[2]), sys.argv[3])
    else:
        raise RuntimeError("Unexpected namespace-entry prototype invocation")
