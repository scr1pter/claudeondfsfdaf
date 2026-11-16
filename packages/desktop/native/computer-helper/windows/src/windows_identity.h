#pragma once
#include "parent_identity.h"
#include "protocol.h"
#include <optional>
#include <string>

namespace vector::computer {
enum class WindowsAppKind { aumid, exe };
enum class WindowsSignatureSource { none, embedded, catalog };
enum class WindowsPackageTrust { unknown, none, developer, enterprise, store, system };

struct WindowsAppIdentity {
  WindowsAppKind kind = WindowsAppKind::exe;
  std::wstring aumid;
  std::wstring publisher;
  // ProductName is deliberately never an authority source. Desktop identity uses its signed original filename.
  std::wstring product;
  std::wstring binary;
  std::wstring name;
  std::wstring exe;
  bool system = false;
  bool verified = false;
  std::optional<DWORD> pid;
  JsonObject wire() const;
};

struct WindowsPackageEvidence {
  std::wstring aumid;
  std::wstring family;
  std::wstring full_name;
  std::wstring path;
  WindowsPackageTrust trust = WindowsPackageTrust::unknown;
  bool development_mode = true;
  bool operator==(const WindowsPackageEvidence&) const = default;
};

// Observations already obtained from held native handles. No model/window property is an authority source.
struct WindowsIdentityFacts {
  FileIdentity image;
  WindowsSignatureSource signature_source = WindowsSignatureSource::none;
  std::wstring publisher;
  std::wstring original_filename;
  bool microsoft_root = false;
  std::wstring system_root;
  std::optional<WindowsPackageEvidence> package;
  std::optional<DWORD> pid;
};
WindowsAppIdentity windows_identity_from_facts(const WindowsIdentityFacts& facts);
bool same_windows_identity(const WindowsAppIdentity& left, const WindowsAppIdentity& right) noexcept;

struct WindowsProcessWitness {
  DWORD pid = 0;
  uint64_t creation_time = 0;
  FileIdentity image;
  TokenIdentity token;
  std::optional<WindowsPackageEvidence> package;
};
bool same_windows_process(const WindowsProcessWitness& left, const WindowsProcessWitness& right) noexcept;
bool windows_package_identity_matches(const WindowsAppIdentity&, const WindowsProcessWitness&) noexcept;

struct WindowsStaticIdentity;
struct WindowsOwner;
class WindowsFileLease final {
 public:
  ~WindowsFileLease();
  HANDLE file_handle() const noexcept;
 private:
  struct State;
  explicit WindowsFileLease(std::unique_ptr<State> state);
  std::unique_ptr<State> state_;
  friend struct WindowsStaticIdentity;
  friend struct WindowsOwner;
  friend WindowsStaticIdentity observe_windows_file(const std::wstring& path);
  friend WindowsStaticIdentity observe_windows_file(HANDLE file);
  friend WindowsStaticIdentity observe_windows_aumid(const std::wstring& aumid);
  friend bool windows_file_current(const WindowsStaticIdentity&) noexcept;
  friend WindowsOwner observe_windows_process(DWORD pid);
  friend bool windows_owner_current(const WindowsOwner&) noexcept;
};
struct WindowsStaticIdentity {
  WindowsAppIdentity identity;
  FileIdentity image;
  std::shared_ptr<WindowsFileLease> lease;
};

class WindowsProcessLease final {
 public:
  ~WindowsProcessLease();
  HANDLE process_handle() const noexcept;
 private:
  struct State;
  explicit WindowsProcessLease(std::unique_ptr<State> state);
  std::unique_ptr<State> state_;
  friend WindowsOwner observe_windows_process(DWORD pid);
  friend bool windows_owner_current(const WindowsOwner&) noexcept;
};
struct WindowsOwner {
  WindowsAppIdentity identity;
  WindowsProcessWitness process;
  std::shared_ptr<WindowsProcessLease> lease;
};

// Borrowed handles are duplicated/reopened read-only into an independent no-write/delete-sharing lease.
WindowsStaticIdentity observe_windows_file(const std::wstring& path);
WindowsStaticIdentity observe_windows_file(HANDLE file);
WindowsOwner observe_windows_process(DWORD pid);
bool windows_file_current(const WindowsStaticIdentity& identity) noexcept;
bool windows_owner_current(const WindowsOwner& owner) noexcept;

// A static packaged identity is issued only after actual current-user registration and manifest agreement.
WindowsStaticIdentity observe_windows_aumid(const std::wstring& aumid);
}
