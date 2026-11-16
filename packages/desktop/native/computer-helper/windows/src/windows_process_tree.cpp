#include "windows_process_tree.h"
#include "windows_policy.h"
#include <tlhelp32.h>
#include <algorithm>
#include <set>
#include <stdexcept>
#include <utility>
#include <winrt/base.h>

namespace vector::computer {
namespace {
constexpr size_t tree_limit = 256;
constexpr size_t depth_limit = 8;
constexpr uint64_t tree_budget_ms = 1000;
std::optional<bool> shell(const WindowsAppIdentity& identity, const WindowsBlocklist& rules) {
  if (!identity.verified) return {};
  const auto category = rules.category(identity);
  if (category == L"terminal" || category == L"scripting") return true;
  // Package identity alone does not prove which execution mode a child hosts. Without a
  // verified original executable identity it cannot justify a negative REPL observation.
  if (identity.kind != WindowsAppKind::exe) return {};
  for (const auto value : {L"sh.exe", L"bash.exe", L"zsh.exe", L"dash.exe", L"ksh.exe", L"fish.exe", L"csh.exe", L"tcsh.exe",
       L"node.exe", L"bun.exe", L"deno.exe", L"ruby.exe", L"irb.exe", L"lua.exe", L"swift.exe", L"repl.exe", L"r.exe", L"rterm.exe", L"jshell.exe", L"py.exe", L"pyw.exe"}) {
    if (WindowsBlocklist::matches(value, identity.binary)) return true;
  }
  for (const auto prefix : {L"python", L"pythonw", L"pypy"}) {
    const auto length = std::wstring_view(prefix).size();
    if (identity.binary.size() < length + 4 || !WindowsBlocklist::matches(std::wstring(prefix) + L"*", identity.binary) ||
        !WindowsBlocklist::matches(L".exe", std::wstring_view(identity.binary).substr(identity.binary.size() - 4))) continue;
    const auto suffix = std::wstring_view(identity.binary).substr(length, identity.binary.size() - length - 4);
    if (suffix.empty()) return true;
    bool digit = false;
    for (const auto unit : suffix) {
      if (unit >= L'0' && unit <= L'9') { digit = true; continue; }
      if (unit != L'.' || !digit) { digit = false; break; }
      digit = false;
    }
    if (digit) return true;
  }
  return false;
}
using TreeEdges = std::set<std::pair<DWORD, DWORD>>;
TreeEdges subtree(const std::vector<WindowsProcessEdge>& edges, DWORD root) {
  if (edges.size() > 65'536) throw std::runtime_error("tree.too-many-processes");
  std::set<DWORD> ids;
  for (const auto& edge : edges) if (edge.pid == 0 || !ids.insert(edge.pid).second) throw std::runtime_error("tree.invalid-snapshot");
  std::vector<std::pair<DWORD, size_t>> pending{{root, 0}};
  std::set<DWORD> visited;
  TreeEdges result;
  while (!pending.empty()) {
    const auto [parent, depth] = pending.back(); pending.pop_back();
    if (!visited.insert(parent).second || visited.size() > tree_limit || depth > depth_limit) throw std::runtime_error("tree.exhausted");
    for (const auto& edge : edges) if (edge.parent == parent) {
      if (edge.pid == root || result.size() >= tree_limit - 1) throw std::runtime_error("tree.invalid-child");
      result.emplace(edge.pid, edge.parent); pending.emplace_back(edge.pid, depth + 1);
    }
  }
  return result;
}
}

WindowsProcessTreeBackend WindowsProcessTreeBackend::system() {
  WindowsProcessTreeBackend result;
  result.snapshot = [] {
    winrt::handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
    if (!snapshot || snapshot.get() == INVALID_HANDLE_VALUE) throw std::runtime_error("tree.snapshot-failed");
    PROCESSENTRY32W entry{}; entry.dwSize = static_cast<DWORD>(sizeof(entry));
    if (!Process32FirstW(snapshot.get(), &entry)) throw std::runtime_error("tree.snapshot-failed");
    std::vector<WindowsProcessEdge> edges;
    do {
      if (entry.th32ProcessID != 0) edges.push_back({entry.th32ProcessID, entry.th32ParentProcessID});
      if (edges.size() > 65'536) throw std::runtime_error("tree.too-many-processes");
    } while (Process32NextW(snapshot.get(), &entry));
    if (GetLastError() != ERROR_NO_MORE_FILES) throw std::runtime_error("tree.snapshot-incomplete");
    return edges;
  };
  result.observe = [](DWORD pid) { return observe_windows_process(pid); };
  result.current = [](const WindowsOwner& owner) { return windows_owner_current(owner); };
  result.now = [] { return GetTickCount64(); };
  return result;
}
std::optional<bool> windows_child_shell(const WindowsOwner& owner) noexcept {
  try { return windows_child_shell_with(owner, WindowsProcessTreeBackend::system()); }
  catch (...) { return {}; }
}
std::optional<bool> windows_child_shell_with(const WindowsOwner& root, const WindowsProcessTreeBackend& backend) noexcept {
  try {
    if (!backend.snapshot || !backend.observe || !backend.current || !backend.now || root.process.pid == 0 || root.process.creation_time == 0 ||
        root.identity.pid != root.process.pid || !backend.current(root)) return {};
    const auto started = backend.now();
    const auto in_budget = [&] {
      const auto now = backend.now();
      return now >= started && now - started < tree_budget_ms;
    };
    const auto initial = subtree(backend.snapshot(), root.process.pid);
    if (!in_budget()) return {};
    const auto rules = WindowsBlocklist::generated();
    std::vector<WindowsOwner> held{root};
    TreeEdges pending = initial;
    bool found_shell = false, unknown = false;
    while (!pending.empty()) {
      bool progressed = false;
      for (auto edge = pending.begin(); edge != pending.end();) {
        const auto parent = std::find_if(held.begin(), held.end(), [&](const auto& candidate) { return candidate.process.pid == edge->second; });
        if (parent == held.end()) { ++edge; continue; }
        if (!in_budget() || !backend.current(*parent)) return {};
        auto child = backend.observe(edge->first);
        if (child.process.pid != edge->first || child.identity.pid != child.process.pid ||
            child.process.creation_time < parent->process.creation_time || !backend.current(child) || !backend.current(*parent) || !in_budget()) return {};
        const auto classified = shell(child.identity, rules);
        unknown = unknown || !classified.has_value();
        found_shell = found_shell || classified == true;
        held.push_back(std::move(child)); edge = pending.erase(edge); progressed = true;
      }
      if (!progressed) return {};
    }
    if (!in_budget() || subtree(backend.snapshot(), root.process.pid) != initial || !in_budget()) return {};
    for (const auto& owner : held) if (!backend.current(owner) || !in_budget()) return {};
    return found_shell ? std::optional<bool>(true) : unknown ? std::nullopt : std::optional<bool>(false);
  } catch (...) { return {}; }
}
}
