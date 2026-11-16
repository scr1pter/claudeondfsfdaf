#pragma once
#include "windows_identity.h"
#include <optional>
#include <span>

namespace vector::computer {
struct WindowsApplication;
// Grant-free fixed bitmap encoder. Input is 32x32 top-down straight-alpha BGRA; output is <=8KiB PNG.
std::optional<std::string> windows_png_icon(std::span<const uint8_t> bgra);
std::optional<std::string> windows_application_icon(const WindowsApplication& application);
size_t run_windows_icon_tests();
}
