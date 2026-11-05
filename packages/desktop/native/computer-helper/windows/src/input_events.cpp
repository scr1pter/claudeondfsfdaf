#include "input_events.h"

namespace vector::computer {
bool valid_input_release(const InputRelease& value) noexcept {
  switch (value.kind) {
    case InputReleaseKind::scan_key:
      return value.virtual_key > 0 && value.virtual_key < 0xff && value.virtual_key != VK_PACKET &&
        value.scan > 0 && value.scan <= 0xff && value.button == 0;
    case InputReleaseKind::unicode_key:
      return value.virtual_key == VK_PACKET && value.scan != 0 && !value.extended && value.button == 0;
    case InputReleaseKind::mouse_button:
      return value.button <= 2 && value.virtual_key == 0 && value.scan == 0 && !value.extended;
  }
  return false;
}
}
