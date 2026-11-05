#pragma once
#include "windows_enum.h"
#include <span>
#include <string>
#include <vector>

namespace vector::computer {
struct CaptureBudget { uint32_t max_width = 0, max_height = 0; uint64_t max_pixels = 0; };
// Image pixels per native physical pixel, before right/bottom raster rounding.
struct CaptureFit { uint32_t width = 0, height = 0; double scale = 0; };
CaptureFit fit_capture(const WindowsRect& source, const CaptureBudget& budget);

struct CaptureBitmap {
  uint32_t width = 0, height = 0;
  std::vector<uint8_t> bgra;
  bool valid() const noexcept;
};
CaptureBitmap resize_capture(const CaptureBitmap& source, const CaptureFit& fit);

struct CapturePrivacyWindow {
  std::wstring id;
  WindowsRect bounds;
  bool visible = true, opaque = true, overlay = false, include = false, vector = false;
  bool regular = true, notification = false;
  std::wstring owner_key;
};
struct CaptureMask { WindowsRect bounds; bool vector = false; };
struct CapturePrivacyPlan { std::vector<CaptureMask> masks; size_t hidden_count = 0; };
CapturePrivacyPlan plan_capture_privacy(std::span<const CapturePrivacyWindow> front_to_back, const WindowsRect& bounds);
std::vector<WindowsRect> capture_pixel_masks(const CapturePrivacyPlan& plan, const WindowsRect& bounds, const CaptureFit& fit);
void paint_capture_masks(CaptureBitmap& bitmap, const CapturePrivacyPlan& plan, const WindowsRect& bounds, const CaptureFit& fit);
std::string hash_capture(const CaptureBitmap& bitmap);
size_t run_capture_math_tests();
}
