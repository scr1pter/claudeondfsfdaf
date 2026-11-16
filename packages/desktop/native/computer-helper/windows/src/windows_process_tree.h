#pragma once
#include "windows_identity.h"

namespace vector::computer {
struct WindowsProcessEdge { DWORD pid = 0, parent = 0; };
struct WindowsProcessTreeBackend {
  std::function<std::vector<WindowsProcessEdge>()> snapshot;
  std::function<WindowsOwner(DWORD)> observe;
  std::function<bool(const WindowsOwner&)> current;
  std::function<uint64_t()> now;
  static WindowsProcessTreeBackend system();
};
// Unknown or over-budget observations never become a negative shell observation. Native callers
// must perform this outside Dispatcher authority and recheck the held root before publication.
std::optional<bool> windows_child_shell(const WindowsOwner&) noexcept;
std::optional<bool> windows_child_shell_with(const WindowsOwner&, const WindowsProcessTreeBackend&) noexcept;
size_t run_windows_process_tree_tests();
}
