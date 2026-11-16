#pragma once
#include "windows_enum.h"
#include <array>
#include <functional>
#include <memory>

namespace vector::computer {
inline constexpr size_t windows_target_frame_limit = 16 * 1024;
inline constexpr uint32_t windows_target_lifetime_ms = 120'000;
inline constexpr std::wstring_view windows_target_name = L"computer-test-target.exe";
inline constexpr std::wstring_view windows_target_class = L"VectorComputerIsolatedTarget";

enum class WindowsTargetAction { state, focus_plain, focus_secure, focus_button, show_excluded, hide_excluded, move_window, quit };
struct WindowsTargetOptions { DWORD parent = 0; std::wstring nonce; bool operator==(const WindowsTargetOptions&) const = default; };
struct WindowsTargetControl { uint64_t id = 0; WindowsTargetAction action = WindowsTargetAction::state; };
struct WindowsTargetSummary { uint64_t length = 0; std::wstring sha256; bool operator==(const WindowsTargetSummary&) const = default; };
struct WindowsTargetState {
  DWORD pid = 0, parent = 0;
  HWND window = nullptr, excluded = nullptr;
  WindowsRect bounds, patch, button, plain, secure, excluded_bounds;
  bool visible = false, minimized = true, foreground = false, affinity = false, excluded_visible = false;
  uint64_t counter = 0, key_downs = 0, key_ups = 0, button_downs = 0, button_ups = 0, held_keys = 0, held_buttons = 0;
  WindowsTargetSummary text, secret;
};

bool windows_target_hex(std::wstring_view value, size_t length) noexcept;
std::optional<WindowsTargetOptions> parse_windows_target_options(std::span<const std::wstring>);
std::optional<WindowsTargetControl> parse_windows_target_control(const JsonObject&);
std::wstring_view windows_target_action(WindowsTargetAction) noexcept;
bool valid_windows_target_state(const WindowsTargetState&) noexcept;
std::optional<WindowsTargetState> decode_windows_target_state(const JsonObject&);
WindowsTargetSummary summarize_windows_target_text(std::wstring_view);
JsonObject windows_target_control_report();
void verify_windows_target_artifacts(const std::wstring& target);
int run_windows_target(const WindowsTargetOptions&, HANDLE input, HANDLE output) noexcept;

// Held executable leases and matching source manifests are checked before CreateProcess. The target
// repeats the checks against its actual immediate parent before creating any window.
class WindowsTargetClient final {
 public:
  static std::unique_ptr<WindowsTargetClient> launch(const std::wstring& target, std::function<bool()> current);
  ~WindowsTargetClient();
  WindowsTargetState request(WindowsTargetAction = WindowsTargetAction::state);
  bool current() const noexcept;
  bool close() noexcept;
  DWORD pid() const noexcept;
 private:
  struct State;
  explicit WindowsTargetClient(std::unique_ptr<State>);
  std::unique_ptr<State> state_;
};
size_t run_privileged_self_test_tests();
}
