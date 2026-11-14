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
  # The CI-only namespace-entry launcher drops every bounding-set bit before executing any tool.
  capability setpcap,
  # Needed only by immutable setup's parent-UID0 map; every model payload asserts all capability sets are empty.
  capability setfcap,
  capability dac_override,
  capability sys_admin,
  capability sys_chroot,
  mount,
  umount,
  pivot_root,
  userns,
}
