#pragma once
#include <windows.h>
#include <cstdint>

namespace vector::computer {
// Finite release-only identity. No caller-supplied flags, point, process handle or down operation.
enum class InputReleaseKind : uint8_t { scan_key, unicode_key, mouse_button };
struct InputRelease {
  InputReleaseKind kind = InputReleaseKind::scan_key;
  WORD virtual_key = 0;
  WORD scan = 0;
  bool extended = false;
  uint8_t button = 0;
  bool operator==(const InputRelease&) const = default;
};
bool valid_input_release(const InputRelease&) noexcept;
enum class InputEventKind { move, button_down, button_up, key_down, key_up, unicode_down, unicode_up, scroll };
struct InputPostedEvent {
  InputEventKind kind = InputEventKind::move;
  POINT point{};
  InputRelease release;
  int32_t dx = 0, dy = 0;
  uint64_t tag = 0;
};
enum class InputPostResult { accepted, not_posted, uncertain };
}
