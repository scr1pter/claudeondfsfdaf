# Disposable GitHub diagnostic only; explicitly entered by root, never attached to bwrap or another host executable.
# File/network/signal/ptrace remain subject to the existing Unix, UID, core and Yama boundary.
# Capability rules permit only capabilities the kernel already grants; they do not grant host capabilities to tools.
abi <abi/4.0>,
profile vector-isolation-diagnostic flags=(attach_disconnected,mediate_deleted) {
  file,
  network,
  unix,
  signal,
  ptrace,
  capability setuid,
  capability setgid,
  capability dac_override,
  capability sys_admin,
  capability sys_chroot,
  mount,
  umount,
  pivot_root,
  userns,
}
