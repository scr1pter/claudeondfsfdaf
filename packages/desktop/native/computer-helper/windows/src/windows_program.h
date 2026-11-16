#pragma once
#include "program_registry.h"
#include "windows_enum.h"
#include <memory>

namespace vector::computer {
struct WindowsProgramAssociation {
  std::wstring executable;
  std::vector<std::wstring> arguments;
};
std::optional<WindowsProgramAssociation> program_association_plan(const std::wstring& executable,
                                                                const std::vector<std::wstring>& command);
std::wstring program_command_line(const std::wstring& executable, const std::vector<std::wstring>& arguments);
bool program_extension_allowed(std::wstring_view path);

enum class WindowsLaunchKind { app, program, protected_route };
struct WindowsLaunchResolution {
  WindowsLaunchKind kind = WindowsLaunchKind::protected_route;
  std::optional<WindowsStaticIdentity> application;
  std::optional<NativeProgramArtifact> artifact;
  std::wstring reason = L"security";
};
struct WindowsProgramPolicy {
  std::function<bool(const std::wstring&)> protected_path;
  std::function<std::optional<std::wstring>(const WindowsAppIdentity&)> refusal;
  // Current native app approval; does not apply to a one-use program's separately consented handler.
  std::function<void(const WindowsAppIdentity&, const ServerSession&)> require_app;
  std::function<void(const WindowsWindow&, const ServerSession&)> require_window;
};
struct WindowsProgramBackend {
  std::function<WindowsLaunchResolution(const std::wstring&, const std::function<bool()>&)> resolve;
  std::function<WindowsStaticIdentity(const JsonObject&)> observe_identity;
  std::function<bool(const NativeProgramArtifact&, const OperationContext&)> launch;
  std::function<bool(const WindowsStaticIdentity&, const OperationContext&, const std::function<void()>&)> launch_app;
  std::function<void(const std::wstring&)> retire;
  std::function<void()> close;
  static WindowsProgramBackend system(WindowsProgramPolicy policy);
};

class WindowsProgramService final {
 public:
  explicit WindowsProgramService(WindowsProgramPolicy policy, WindowsProgramBackend backend = {},
                                 WindowsBackend windows = WindowsBackend::system());
  ~WindowsProgramService();
  JsonObject features() const;
  void resolve(const JsonObject& args, const OperationContext& context, Dispatcher::Completion done);
  void launch(const JsonObject& args, const OperationContext& context, Dispatcher::Completion done);
  void launch_program(const JsonObject& args, const OperationContext& context, Dispatcher::Completion done);
  void invalidate_observations();
  void close();
 private:
  WindowsProgramPolicy policy_;
  WindowsProgramBackend backend_;
  WindowsBackend windows_;
  ProgramLaunchRegistry registry_;
  std::atomic<bool> closed_{false};
  std::recursive_mutex authority_;
  OperationContext scoped(const OperationContext& context);
};
size_t run_windows_program_tests();
}
