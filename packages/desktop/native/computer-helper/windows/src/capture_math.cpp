#include "capture_math.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <optional>
#include <set>

namespace vector::computer {
namespace {
constexpr uint64_t maximum_pixels = 64ULL * 1024ULL * 1024ULL;
constexpr size_t maximum_fragments = 8192, maximum_masks = 4096, maximum_work = 1'000'000;
[[noreturn]] void unavailable() { throw Failure{L"capture_unavailable", L"The capture geometry or privacy plan is unavailable."}; }
bool dimensions(uint32_t width, uint32_t height) noexcept {
  return width > 0 && height > 0 && width <= 32'768 && height <= 32'768 && static_cast<uint64_t>(width) * height <= maximum_pixels;
}
std::optional<WindowsRect> intersection(const WindowsRect& a, const WindowsRect& b) {
  const auto x = std::max(a.x, b.x), y = std::max(a.y, b.y);
  const auto right = std::min(a.x + a.width, b.x + b.width), bottom = std::min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) return {};
  return WindowsRect{x, y, right - x, bottom - y};
}
void subtract(const WindowsRect& value, const WindowsRect& cover, std::vector<WindowsRect>& result) {
  const auto overlap = intersection(value, cover);
  if (!overlap) { result.push_back(value); return; }
  if (value.y < overlap->y) result.push_back({value.x, value.y, value.width, overlap->y - value.y});
  const auto bottom = value.y + value.height, cut_bottom = overlap->y + overlap->height;
  if (cut_bottom < bottom) result.push_back({value.x, cut_bottom, value.width, bottom - cut_bottom});
  if (value.x < overlap->x) result.push_back({value.x, overlap->y, overlap->x - value.x, overlap->height});
  const auto right = value.x + value.width, cut_right = overlap->x + overlap->width;
  if (cut_right < right) result.push_back({cut_right, overlap->y, right - cut_right, overlap->height});
}
void require_fit(const WindowsRect& bounds, const CaptureFit& fit) {
  if (!bounds.valid() || bounds.width > 32'768 || bounds.height > 32'768 ||
      !dimensions(static_cast<uint32_t>(bounds.width), static_cast<uint32_t>(bounds.height)) ||
      !dimensions(fit.width, fit.height) || fit.width > 16'384 || fit.height > 16'384 ||
      !std::isfinite(fit.scale) || fit.scale <= 0 || fit.scale > 1 ||
      std::floor(static_cast<double>(bounds.width) * fit.scale) != static_cast<double>(fit.width) ||
      std::floor(static_cast<double>(bounds.height) * fit.scale) != static_cast<double>(fit.height)) unavailable();
}
}

CaptureFit fit_capture(const WindowsRect& source, const CaptureBudget& budget) {
  if (budget.max_width == 0 || budget.max_height == 0 || budget.max_width > 16'384 || budget.max_height > 16'384 ||
      budget.max_pixels == 0 || budget.max_pixels > 16'384ULL * 16'384ULL)
    throw Failure{L"failed", L"The capture budget is invalid."};
  if (!source.valid() || source.width > 32'768 || source.height > 32'768 ||
      !dimensions(static_cast<uint32_t>(source.width), static_cast<uint32_t>(source.height))) unavailable();
  const auto width = static_cast<double>(source.width), height = static_cast<double>(source.height);
  auto scale = std::min({1.0, static_cast<double>(budget.max_width) / width, static_cast<double>(budget.max_height) / height,
                         std::sqrt(static_cast<double>(budget.max_pixels) / (width * height))});
  if (!std::isfinite(scale) || scale <= 0) unavailable();
  auto fitted_width = static_cast<uint32_t>(std::floor(width * scale));
  auto fitted_height = static_cast<uint32_t>(std::floor(height * scale));
  if (fitted_width > budget.max_width || fitted_height > budget.max_height || static_cast<uint64_t>(fitted_width) * fitted_height > budget.max_pixels) {
    scale = std::nextafter(scale, 0.0);
    fitted_width = static_cast<uint32_t>(std::floor(width * scale)); fitted_height = static_cast<uint32_t>(std::floor(height * scale));
  }
  CaptureFit result{fitted_width, fitted_height, scale}; require_fit(source, result);
  if (result.width > budget.max_width || result.height > budget.max_height || static_cast<uint64_t>(result.width) * result.height > budget.max_pixels) unavailable();
  return result;
}
bool CaptureBitmap::valid() const noexcept {
  return dimensions(width, height) && bgra.size() == static_cast<uint64_t>(width) * height * 4ULL;
}
CaptureBitmap resize_capture(const CaptureBitmap& source, const CaptureFit& fit) {
  if (!source.valid()) unavailable();
  require_fit({0, 0, source.width, source.height}, fit);
  CaptureBitmap result{fit.width, fit.height, std::vector<uint8_t>(static_cast<size_t>(fit.width) * fit.height * 4U)};
  for (uint32_t y = 0; y < fit.height; ++y) {
    const auto source_y = static_cast<uint32_t>(std::floor((static_cast<double>(y) + 0.5) / fit.scale));
    if (source_y >= source.height) unavailable();
    for (uint32_t x = 0; x < fit.width; ++x) {
      const auto source_x = static_cast<uint32_t>(std::floor((static_cast<double>(x) + 0.5) / fit.scale));
      if (source_x >= source.width) unavailable();
      const auto from = (static_cast<size_t>(source_y) * source.width + source_x) * 4U;
      const auto to = (static_cast<size_t>(y) * fit.width + x) * 4U;
      std::copy_n(source.bgra.data() + from, 4, result.bgra.data() + to);
    }
  }
  return result;
}
CapturePrivacyPlan plan_capture_privacy(std::span<const CapturePrivacyWindow> windows, const WindowsRect& bounds) {
  if (!bounds.valid() || windows.size() > 4096) unavailable();
  CapturePrivacyPlan plan;
  std::vector<WindowsRect> covered;
  std::set<std::wstring> hidden, ids;
  size_t work = 0;
  for (const auto& window : windows) {
    if (window.id.empty() || window.id.size() > 256 || !ids.insert(window.id).second) unavailable();
    if (!window.visible || window.overlay) continue;
    if (!window.bounds.valid()) unavailable();
    const auto clipped = intersection(window.bounds, bounds); if (!clipped) continue;
    std::vector<WindowsRect> visible{*clipped};
    for (const auto& cover : covered) {
      std::vector<WindowsRect> next;
      for (const auto& rect : visible) {
        if (++work > maximum_work) unavailable();
        subtract(rect, cover, next);
        if (next.size() > maximum_fragments) unavailable();
      }
      visible = std::move(next); if (visible.empty()) break;
    }
    if ((!window.include || window.vector || window.notification) && !visible.empty()) {
      if (visible.size() > maximum_masks - std::min(maximum_masks, plan.masks.size())) unavailable();
      for (const auto& rect : visible) plan.masks.push_back({rect, window.vector});
      if (window.regular && !window.notification) {
        if (window.owner_key.empty() || window.owner_key.size() > 4096) unavailable();
        hidden.insert(window.owner_key);
      }
    }
    // Translucent and unknown-opacity surfaces cannot prove the lower app's pixels are absent.
    if (window.opaque) covered.push_back(*clipped);
  }
  plan.hidden_count = hidden.size(); return plan;
}
std::vector<WindowsRect> capture_pixel_masks(const CapturePrivacyPlan& plan, const WindowsRect& bounds, const CaptureFit& fit) {
  require_fit(bounds, fit);
  if (plan.masks.size() > maximum_masks) unavailable();
  std::vector<WindowsRect> result;
  size_t work = 0;
  for (const auto& mask : plan.masks) {
    if (!mask.bounds.valid()) unavailable();
    const auto clipped = intersection(bounds, mask.bounds); if (!clipped) continue;
    const auto x = std::clamp(std::floor(static_cast<double>(clipped->x - bounds.x) * fit.scale), 0.0, static_cast<double>(fit.width));
    const auto y = std::clamp(std::floor(static_cast<double>(clipped->y - bounds.y) * fit.scale), 0.0, static_cast<double>(fit.height));
    const auto right = std::clamp(std::ceil(static_cast<double>(clipped->x + clipped->width - bounds.x) * fit.scale), 0.0, static_cast<double>(fit.width));
    const auto bottom = std::clamp(std::ceil(static_cast<double>(clipped->y + clipped->height - bounds.y) * fit.scale), 0.0, static_cast<double>(fit.height));
    if (right <= x || bottom <= y) continue;
    std::vector<WindowsRect> uncovered{{static_cast<int64_t>(x), static_cast<int64_t>(y), static_cast<int64_t>(right - x), static_cast<int64_t>(bottom - y)}};
    // Pixel rounding can introduce overlaps even when native fragments are disjoint. Keep a
    // bounded disjoint union so painting touches each output pixel at most once.
    for (const auto& cover : result) {
      std::vector<WindowsRect> next;
      for (const auto& rect : uncovered) {
        if (++work > maximum_work) unavailable();
        subtract(rect, cover, next);
        if (next.size() > maximum_fragments) unavailable();
      }
      uncovered = std::move(next); if (uncovered.empty()) break;
    }
    if (uncovered.size() > maximum_fragments - std::min(maximum_fragments, result.size())) unavailable();
    result.insert(result.end(), uncovered.begin(), uncovered.end());
  }
  return result;
}
void paint_capture_masks(CaptureBitmap& bitmap, const CapturePrivacyPlan& plan, const WindowsRect& bounds, const CaptureFit& fit) {
  if (!bitmap.valid() || bitmap.width != fit.width || bitmap.height != fit.height) unavailable();
  for (const auto& rect : capture_pixel_masks(plan, bounds, fit)) {
    for (int64_t y = rect.y; y < rect.y + rect.height; ++y) for (int64_t x = rect.x; x < rect.x + rect.width; ++x) {
      const auto offset = (static_cast<size_t>(y) * bitmap.width + static_cast<size_t>(x)) * 4U;
      bitmap.bgra[offset] = 0; bitmap.bgra[offset + 1] = 0; bitmap.bgra[offset + 2] = 0; bitmap.bgra[offset + 3] = 255;
    }
  }
}
std::string hash_capture(const CaptureBitmap& bitmap) {
  if (!bitmap.valid()) unavailable();
  std::array<uint64_t, 64> cells{};
  uint64_t total = 0;
  for (uint32_t y = 0; y < 8; ++y) for (uint32_t x = 0; x < 8; ++x) {
    const auto x0 = x * bitmap.width / 8, y0 = y * bitmap.height / 8;
    const auto x1 = std::max(x0 + 1, (x + 1) * bitmap.width / 8), y1 = std::max(y0 + 1, (y + 1) * bitmap.height / 8);
    uint64_t luminance = 0;
    for (auto row = y0; row < y1; ++row) for (auto col = x0; col < x1; ++col) {
      const auto offset = (static_cast<size_t>(row) * bitmap.width + col) * 4U;
      luminance += (29U * bitmap.bgra[offset] + 150U * bitmap.bgra[offset + 1] + 77U * bitmap.bgra[offset + 2]) / 256U;
    }
    cells[y * 8 + x] = luminance / (static_cast<uint64_t>(x1 - x0) * (y1 - y0)); total += cells[y * 8 + x];
  }
  uint64_t hash = 0;
  for (const auto cell : cells) hash = (hash << 1) | (cell * 64 >= total ? 1ULL : 0ULL);
  constexpr char hex[] = "0123456789abcdef";
  std::string result(16, '0');
  for (size_t index = 0; index < 16; ++index) result[index] = hex[(hash >> ((15U - index) * 4U)) & 15ULL];
  return result;
}
}
