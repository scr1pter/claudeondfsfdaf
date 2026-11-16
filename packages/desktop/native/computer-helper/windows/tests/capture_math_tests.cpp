#include "capture_math.h"
#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace vector::computer {
namespace {
void require(bool condition, const char* label) { if (!condition) throw std::runtime_error(label); }
template<class Body> bool refused(Body body) {
  try { body(); } catch (const Failure&) { return true; }
  return false;
}
CaptureBitmap bitmap(uint32_t width, uint32_t height, uint8_t color = 255) {
  CaptureBitmap value{width, height, std::vector<uint8_t>(static_cast<size_t>(width) * height * 4U, color)};
  for (size_t offset = 3; offset < value.bgra.size(); offset += 4) value.bgra[offset] = 255;
  return value;
}
CapturePrivacyWindow window(std::wstring id, WindowsRect bounds, bool include = false, std::wstring key = L"app") {
  CapturePrivacyWindow value; value.id = std::move(id); value.bounds = bounds; value.include = include; value.owner_key = std::move(key); return value;
}
uint64_t area(const CapturePrivacyPlan& plan) {
  uint64_t result = 0;
  for (const auto& mask : plan.masks) result += static_cast<uint64_t>(mask.bounds.width) * static_cast<uint64_t>(mask.bounds.height);
  return result;
}
}
size_t run_capture_math_tests() {
  size_t count = 0;
  const auto test = [&](auto body) { body(); ++count; };
  const CaptureBudget normal{1440, 900, 1440ULL * 900ULL};
  test([&] { require(refused([&] { (void)fit_capture({0, 0, 100, 100}, {0, 900, 100}); }), "capture.invalid-budget"); });
  test([&] { require(refused([&] { (void)fit_capture({0, 0, -1, 100}, normal); }), "capture.invalid-source"); });
  test([&] {
    const auto fit = fit_capture({-200, 100, 320, 240}, normal);
    require(fit.width == 320 && fit.height == 240 && fit.scale == 1, "capture.no-upscale-or-origin-loss");
  });
  test([&] {
    const auto fit = fit_capture({0, 0, 2048, 1080}, normal);
    require(fit.width == 1440 && fit.height == 759 && fit.scale == 0.703125, "capture.landscape-single-scale");
  });
  test([&] {
    const auto fit = fit_capture({0, 0, 1200, 2400}, normal);
    require(fit.width == 450 && fit.height == 900 && fit.scale == 0.375, "capture.portrait-height-budget");
  });
  test([&] {
    const auto fit = fit_capture({-8192, 0, 8192, 1080}, normal);
    require(fit.width == 1440 && fit.height == 189, "capture.ultrawide-negative-origin");
  });
  test([&] {
    const auto fit = fit_capture({0, 0, 2000, 2000}, {16'384, 16'384, 1'000'000});
    require(fit.width == 1000 && fit.height == 1000 && fit.scale == 0.5, "capture.megapixel-cap");
  });
  test([&] { require(refused([&] { (void)fit_capture({0, 0, 1, 32'768}, {1, 1, 1}); }), "capture.subpixel-axis-never-stretched"); });
  test([&] {
    const auto fit = fit_capture({0, 0, 1921, 1081}, {1000, 800, 500'000});
    require(fit.width <= 1000 && fit.height <= 800 && static_cast<uint64_t>(fit.width) * fit.height <= 500'000 &&
      static_cast<double>(fit.width) <= 1921 * fit.scale && 1921 * fit.scale < fit.width + 1.0 &&
      static_cast<double>(fit.height) <= 1081 * fit.scale && 1081 * fit.scale < fit.height + 1.0, "capture.rounding-preserves-one-transform");
  });
  test([&] {
    auto source = bitmap(4, 4);
    for (uint8_t index = 0; index < 16; ++index) source.bgra[static_cast<size_t>(index) * 4] = index;
    const auto image = resize_capture(source, {2, 2, 0.5});
    require(image.valid() && image.bgra[0] == 5 && image.bgra[4] == 7 && image.bgra[8] == 13 && image.bgra[12] == 15,
      "capture.centers-use-single-native-scale");
  });
  test([&] { require(refused([&] { (void)resize_capture(bitmap(4, 4), {3, 2, 0.5}); }), "capture.forged-fit-refused"); });
  test([&] {
    auto source = bitmap(4, 4); source.bgra.pop_back();
    require(!source.valid() && refused([&] { (void)resize_capture(source, {2, 2, 0.5}); }), "capture.truncated-bitmap-refused");
  });
  test([&] {
    auto source = bitmap(8, 8, 0);
    for (size_t y = 0; y < 8; ++y) for (size_t x = 0; x < 4; ++x) {
      const auto offset = (y * 8 + x) * 4; source.bgra[offset] = 255; source.bgra[offset + 1] = 255; source.bgra[offset + 2] = 255;
    }
    require(hash_capture(source) == "f0f0f0f0f0f0f0f0", "capture.spatial-perceptual-hash");
  });
  test([&] {
    const std::vector windows{window(L"1", {0, 0, 100, 100})};
    const auto plan = plan_capture_privacy(windows, {0, 0, 100, 100});
    require(area(plan) == 10'000 && plan.hidden_count == 1, "capture.unapproved-owner-masked");
  });
  test([&] {
    const std::vector windows{window(L"1", {0, 0, 100, 100}, true), window(L"2", {0, 0, 100, 100})};
    const auto plan = plan_capture_privacy(windows, {0, 0, 100, 100});
    require(plan.masks.empty() && plan.hidden_count == 0, "capture.proven-opaque-approved-occlusion");
  });
  test([&] {
    auto front = window(L"1", {0, 0, 100, 100}, true); front.opaque = false;
    const std::vector windows{front, window(L"2", {0, 0, 100, 100})};
    const auto plan = plan_capture_privacy(windows, {0, 0, 100, 100});
    require(area(plan) == 10'000 && plan.hidden_count == 1, "capture.uncertain-alpha-cannot-hide-private-owner");
  });
  test([&] {
    auto overlay = window(L"1", {0, 0, 100, 100}); overlay.overlay = true; overlay.vector = true;
    const std::vector windows{overlay, window(L"2", {0, 0, 100, 100}, true)};
    require(plan_capture_privacy(windows, {0, 0, 100, 100}).masks.empty(), "capture.exact-overlays-neither-mask-nor-occlude");
  });
  test([&] {
    auto notification = window(L"1", {0, 0, 20, 10}, true, L""); notification.notification = true;
    const auto plan = plan_capture_privacy(std::vector{notification}, {0, 0, 100, 100});
    require(area(plan) == 200 && plan.hidden_count == 0, "capture.notification-never-included-or-counted-as-app");
  });
  test([&] {
    auto vector = window(L"1", {-10, -10, 30, 30}, true); vector.vector = true;
    const auto plan = plan_capture_privacy(std::vector{vector}, {0, 0, 100, 100});
    require(area(plan) == 400 && plan.hidden_count == 1 && plan.masks[0].vector, "capture.vector-main-opaque-labelled-mask");
  });
  test([&] {
    const std::vector windows{window(L"1", {0, 0, 20, 20}), window(L"2", {30, 0, 20, 20})};
    const auto plan = plan_capture_privacy(windows, {0, 0, 100, 100});
    require(area(plan) == 800 && plan.hidden_count == 1, "capture.owner-count-is-not-mask-count");
  });
  test([&] {
    const std::vector windows{window(L"1", {25, 25, 50, 50}, true), window(L"2", {0, 0, 100, 100})};
    const auto plan = plan_capture_privacy(windows, {0, 0, 100, 100});
    require(plan.masks.size() == 4 && area(plan) == 7500 && plan.hidden_count == 1, "capture.visible-fragments-preserve-opaque-occlusion");
  });
  test([&] {
    const CapturePrivacyPlan plan{{{{-99, -49, 1, 1}, false}}, 1};
    const auto masks = capture_pixel_masks(plan, {-100, -50, 10, 10}, {5, 5, 0.5});
    require(masks.size() == 1 && masks[0] == WindowsRect{0, 0, 1, 1}, "capture.mask-rounding-is-outward-at-negative-origin");
  });
  test([&] {
    auto image = bitmap(5, 5);
    const CapturePrivacyPlan plan{{{{-99, -49, 1, 1}, false}}, 1};
    paint_capture_masks(image, plan, {-100, -50, 10, 10}, {5, 5, 0.5});
    require(image.bgra[0] == 0 && image.bgra[1] == 0 && image.bgra[2] == 0 && image.bgra[3] == 255 &&
      std::all_of(image.bgra.begin() + 4, image.bgra.end(), [](auto byte) { return byte == 255; }), "capture.masked-pixels-are-opaque-with-no-outside-write");
  });
  test([&] {
    require(refused([&] { (void)plan_capture_privacy(std::vector{window(L"1", {0, 0, 100, 100}, false, L"")}, {0, 0, 100, 100}); }),
      "capture.unknown-regular-owner-count-fails-closed");
  });
  test([&] {
    const std::vector windows{window(L"1", {0, 0, 100, 100}), window(L"1", {0, 0, 100, 100})};
    require(refused([&] { (void)plan_capture_privacy(windows, {0, 0, 100, 100}); }), "capture.duplicate-window-observation-refused");
  });
  test([&] {
    require(refused([&] { (void)plan_capture_privacy(std::vector{window(L"1", {0, 0, 0, 100})}, {0, 0, 100, 100}); }),
      "capture.invalid-visible-window-fails-closed");
  });
  test([&] {
    auto furniture = window(L"1", {0, 0, 100, 100}, false, L""); furniture.regular = false;
    const auto plan = plan_capture_privacy(std::vector{furniture}, {0, 0, 100, 100});
    require(area(plan) == 10'000 && plan.hidden_count == 0, "capture.nonapplication-surface-not-inflated-to-app-count");
  });
  test([&] {
    std::vector<CapturePrivacyWindow> windows(4097);
    require(refused([&] { (void)plan_capture_privacy(windows, {0, 0, 100, 100}); }), "capture.inventory-overflow-fails-closed");
  });
  test([&] {
    CapturePrivacyPlan plan;
    plan.masks.assign(4096, CaptureMask{{0, 0, 64, 64}, false});
    const auto masks = capture_pixel_masks(plan, {0, 0, 64, 64}, {64, 64, 1});
    require(masks.size() == 1 && masks[0] == WindowsRect{0, 0, 64, 64}, "capture.overlapping-masks-have-bounded-paint-work");
    auto image = bitmap(64, 64);
    paint_capture_masks(image, plan, {0, 0, 64, 64}, {64, 64, 1});
    for (size_t offset = 0; offset < image.bgra.size(); offset += 4)
      require(image.bgra[offset] == 0 && image.bgra[offset + 1] == 0 && image.bgra[offset + 2] == 0 && image.bgra[offset + 3] == 255,
        "capture.union-preserves-every-private-pixel");
  });
  return count;
}
}
