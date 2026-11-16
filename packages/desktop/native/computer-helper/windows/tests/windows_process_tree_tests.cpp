#include "windows_process_tree.h"
#include <map>
#include <set>
#include <stdexcept>

namespace vector::computer {
namespace {
void require(bool value, const char* name) { if (!value) throw std::runtime_error(name); }
WindowsOwner owner(DWORD pid, uint64_t creation, std::wstring binary = L"ordinary.exe") {
  WindowsOwner result;
  result.identity.kind = WindowsAppKind::exe; result.identity.binary = std::move(binary);
  result.identity.publisher = L"Synthetic signed publisher"; result.identity.verified = true; result.identity.pid = pid;
  result.identity.exe = L"C:\\Fixture\\actual-image.exe";
  result.process.pid = pid; result.process.creation_time = creation;
  result.process.image.path = result.identity.exe; result.process.image.signature = SignatureState::valid;
  return result;
}
struct Tree {
  WindowsOwner root = owner(10, 100);
  std::vector<WindowsProcessEdge> first{{10, 1}}, second;
  std::map<DWORD, WindowsOwner> owners;
  std::set<DWORD> stale;
  size_t snapshots = 0, observations = 0;
  uint64_t now = 100, increment = 0;
  bool throw_snapshot = false, rollback = false;
  std::function<void(DWORD)> observed;
  WindowsProcessTreeBackend backend() {
    WindowsProcessTreeBackend result;
    result.snapshot = [this] {
      if (throw_snapshot) throw std::runtime_error("synthetic.snapshot-failed");
      ++snapshots; return snapshots > 1 && !second.empty() ? second : first;
    };
    result.observe = [this](DWORD pid) {
      ++observations;
      if (observed) observed(pid);
      return owners.at(pid);
    };
    result.current = [this](const WindowsOwner& value) { return !stale.contains(value.process.pid); };
    result.now = [this] {
      const auto value = now;
      if (rollback) { now = 0; rollback = false; }
      else now += increment;
      return value;
    };
    return result;
  }
  void child(DWORD pid, DWORD parent, uint64_t creation, std::wstring binary = L"ordinary.exe") {
    first.push_back({pid, parent}); owners.emplace(pid, owner(pid, creation, std::move(binary)));
  }
  std::optional<bool> inspect() { return windows_child_shell_with(root, backend()); }
};
}

size_t run_windows_process_tree_tests() {
  size_t groups = 0;
  const auto test = [&](const std::function<void()>& body) { body(); ++groups; };
  test([] {
    Tree tree;
    require(tree.inspect() == false && tree.observations == 0 && tree.snapshots == 2, "tree.no-child-stable-negative");
  });
  test([] {
    Tree tree; tree.child(11, 10, 101, L"node.exe");
    require(tree.inspect() == true, "tree.verified-node-original-filename");
    tree.owners.at(11).identity.exe = L"C:\\Renamed\\ordinary-app.exe";
    tree.owners.at(11).process.image.path = tree.owners.at(11).identity.exe; tree.snapshots = 0;
    require(tree.inspect() == true, "tree.renamed-interpreter-keeps-signed-identity");
  });
  test([] {
    for (const auto binary : {L"cmd.exe", L"pwsh.exe", L"python.exe", L"python3.exe", L"python3.12.exe", L"pythonw.exe", L"pypy3.10.exe", L"py.exe", L"jshell.exe"}) {
      Tree tree; tree.child(11, 10, 101, binary);
      require(tree.inspect() == true, "tree.shell-and-repl-identities");
    }
    Tree tree; tree.child(11, 10, 101, L"python-provider.exe");
    require(tree.inspect() == false, "tree.python-prefix-is-not-an-identity");
  });
  test([] {
    Tree tree; tree.child(11, 10, 101); tree.child(12, 11, 102);
    require(tree.inspect() == false, "tree.verified-nonshell-subtree");
  });
  test([] {
    Tree tree; tree.child(11, 10, 101); tree.owners.at(11).identity.verified = false;
    tree.owners.at(11).identity.binary = L"unverified-content-marker";
    require(!tree.inspect(), "tree.unsigned-child-remains-unknown");
    tree.owners.at(11).identity.verified = true; tree.owners.at(11).identity.kind = WindowsAppKind::aumid;
    tree.owners.at(11).identity.aumid = L"Fixture.UnknownPackage!App"; tree.snapshots = 0;
    require(!tree.inspect(), "tree.unknown-package-execution-mode-remains-unknown");
  });
  test([] {
    Tree tree; tree.child(11, 10, 101); tree.owners.at(11).identity.verified = false;
    tree.child(12, 11, 102, L"node.exe");
    require(tree.inspect() == true, "tree.actual-shell-still-refused-through-unsigned-parent");
  });
  test([] {
    Tree tree; tree.stale.insert(10);
    require(!tree.inspect() && tree.observations == 0, "tree.held-root-gone");
    tree.stale.clear(); tree.root.process.creation_time = 0;
    require(!tree.inspect(), "tree.unknown-root-start");
  });
  test([] {
    Tree tree; tree.child(11, 10, 99, L"node.exe");
    require(!tree.inspect(), "tree.child-older-than-held-parent");
  });
  test([] {
    Tree tree; tree.child(11, 10, 101, L"node.exe"); tree.stale.insert(11);
    require(!tree.inspect(), "tree.stale-child-handle");
  });
  test([] {
    Tree tree; tree.child(11, 10, 101, L"node.exe"); tree.owners.at(11).process.pid = 12;
    require(!tree.inspect(), "tree.pid-replacement-is-not-the-snapshot-child");
  });
  test([] {
    Tree tree; tree.second = tree.first; tree.second.push_back({11, 10});
    require(!tree.inspect(), "tree.new-child-invalidates-negative");
    Tree disappearing; disappearing.child(11, 10, 101); disappearing.second = {{10, 1}};
    require(!disappearing.inspect(), "tree.disappearing-child-invalidates-negative");
  });
  test([] {
    Tree tree; tree.child(11, 10, 101); tree.first[0].parent = 11;
    require(!tree.inspect(), "tree.cyclic-parent-proof-refused");
    Tree duplicate; duplicate.first.push_back({10, 1});
    require(!duplicate.inspect(), "tree.duplicate-snapshot-id-refused");
  });
  test([] {
    Tree tree;
    for (DWORD index = 1; index <= 9; ++index) tree.child(10 + index, 9 + index, 100 + index);
    require(!tree.inspect(), "tree.depth-bound");
  });
  test([] {
    Tree tree;
    for (DWORD index = 0; index < 256; ++index) tree.child(11 + index, 10, 101 + index);
    require(!tree.inspect() && tree.observations == 0, "tree.count-bound-before-native-observation");
  });
  test([] {
    Tree tree; tree.throw_snapshot = true;
    require(!tree.inspect(), "tree.snapshot-failure-not-negative");
    Tree missing; missing.first.push_back({11, 10});
    require(!missing.inspect(), "tree.native-owner-failure-not-negative");
  });
  test([] {
    Tree tree; tree.increment = 1000;
    require(!tree.inspect(), "tree.nonrenewable-deadline");
    Tree rollback; rollback.rollback = true;
    require(!rollback.inspect(), "tree.monotonic-underflow-refused");
  });
  test([] {
    Tree tree; tree.child(11, 10, 101, L"node.exe");
    tree.observed = [&](DWORD) { tree.stale.insert(10); };
    require(!tree.inspect(), "tree.parent-replaced-during-observation");
  });
  return groups;
}
}
