#include "overlay_driver.h"
#include <algorithm>
#include <limits>
#include <stdexcept>

namespace vector::computer {
namespace {
void require(bool value, const char* label) { if (!value) throw std::runtime_error(label); }
std::vector<std::wstring> stop_options() { return {L"--overlay-stop", L"--parent-pid", L"42", L"--nonce", std::wstring(64, L'a')}; }
OverlayStopRequest request() { return {42, 123, std::wstring(64, L'a'), std::wstring(64, L'b'), L"Vector computer smoke " + std::wstring(64, L'a'), reinterpret_cast<HWND>(uintptr_t{100}), {-200, 20, 600, 90}, {250, 40, 80, 40}}; }
JsonObject wire_request() {
  const auto fixture = request(); JsonObject result;
  result.Insert(L"protocol", JsonValue::CreateNumberValue(1)); result.Insert(L"nonce", JsonValue::CreateStringValue(fixture.nonce)); result.Insert(L"parentPID", JsonValue::CreateNumberValue(fixture.parent)); result.Insert(L"parentCreationTime", JsonValue::CreateStringValue(L"123")); result.Insert(L"sourceDigest", JsonValue::CreateStringValue(fixture.source_digest)); result.Insert(L"bannerWindowId", JsonValue::CreateStringValue(L"100")); result.Insert(L"bannerBounds", fixture.banner_bounds.wire()); result.Insert(L"stopBounds", fixture.stop_bounds.wire()); result.Insert(L"bannerTitle", JsonValue::CreateStringValue(fixture.title)); return result;
}
}

// Pure wire/decision fixtures. They start no process, query no HWND/token/file, and post no input.
size_t run_overlay_driver_tests() {
  size_t count = 0; const auto test = [&](const auto& body) { body(); ++count; };
  test([] {
    const auto parsed = parse_overlay_driver_options(stop_options());
    require(parsed && parsed->mode == OverlayDriverMode::stop && parsed->parent == 42 && parsed->nonce == std::wstring(64, L'a'), "overlay-driver.finite-stop-cli");
    const auto bootstrap = parse_overlay_driver_options(std::vector<std::wstring>{L"--launch-electron", L"--nonce", std::wstring(64, L'b')});
    require(bootstrap && bootstrap->mode == OverlayDriverMode::launch_electron && bootstrap->parent == 0, "overlay-driver.finite-bootstrap-cli");
  });
  test([] {
    for (const auto value : {L"0", L"042", L"-42", L"+42", L"42 ", L"4294967296", L"18446744073709551615", L""}) {
      auto arguments = stop_options(); arguments[2] = value; require(!parse_overlay_driver_options(arguments), "overlay-driver.parent-is-canonical-dword");
    }
    auto arguments = stop_options(); arguments[2] = L"4294967295"; require(parse_overlay_driver_options(arguments).has_value(), "overlay-driver.full-dword-parent-does-not-overflow");
  });
  test([] {
    for (const auto& nonce : {std::wstring(63, L'a'), std::wstring(65, L'a'), std::wstring(64, L'A'), std::wstring(64, L'g'), std::wstring(64, L'\0'), std::wstring{}}) {
      auto arguments = stop_options(); arguments[4] = nonce; require(!parse_overlay_driver_options(arguments), "overlay-driver.nonce-is-exact-lowercase-hex");
    }
  });
  test([] {
    for (const auto extra : {L"--stdio", L"--target=C:\\other.exe", L"--script=other.js", L"--no-sandbox", L"--report=private.txt"}) {
      auto arguments = stop_options(); arguments.push_back(extra); require(!parse_overlay_driver_options(arguments), "overlay-driver.no-arbitrary-stop-command-argument");
      const std::vector<std::wstring> bootstrap{L"--launch-electron", L"--nonce", std::wstring(64, L'a'), extra}; require(!parse_overlay_driver_options(bootstrap), "overlay-driver.no-arbitrary-electron-argument");
    }
  });
  test([] {
    auto arguments = stop_options(); arguments[0] = L"--click"; require(!parse_overlay_driver_options(arguments), "overlay-driver.no-generic-input-mode");
    arguments = stop_options(); arguments[1] = L"--target-pid"; require(!parse_overlay_driver_options(arguments), "overlay-driver.no-retargeting-pid-option");
    arguments = stop_options(); std::swap(arguments[1], arguments[3]); require(!parse_overlay_driver_options(arguments), "overlay-driver.canonical-option-order");
  });
  test([] {
    require(valid_overlay_stop_request(request()), "overlay-driver.bounded-private-stop-request"); const auto parsed = parse_overlay_stop_request(wire_request());
    require(parsed && parsed->parent == 42 && parsed->parent_created == 123 && parsed->banner == request().banner && parsed->stop_bounds == request().stop_bounds, "overlay-driver.private-wire-preserves-exact-native-scope");
  });
  test([] {
    for (const auto key : {L"x", L"pid", L"command", L"keys", L"path", L"text"}) {
      const auto value = wire_request(); value.Insert(key, JsonValue::CreateStringValue(L"not a stop target")); require(!parse_overlay_stop_request(value), "overlay-driver.private-wire-has-no-unclassified-input-authority");
    }
    const auto missing = wire_request(); missing.Remove(L"nonce"); require(!parse_overlay_stop_request(missing), "overlay-driver.private-wire-requires-nonce");
  });
  test([] {
    const auto value = wire_request(); value.Insert(L"parentCreationTime", JsonValue::CreateStringValue(L"18446744073709551615"));
    const auto parsed = parse_overlay_stop_request(value); require(parsed && parsed->parent_created == std::numeric_limits<uint64_t>::max(), "overlay-driver-native-filetime-is-a-lossless-string");
    for (const auto wrong : {L"0", L"0123", L"-1", L"18446744073709551616", L"123.0", L""}) {
      value.Insert(L"parentCreationTime", JsonValue::CreateStringValue(wrong)); require(!parse_overlay_stop_request(value), "overlay-driver-native-filetime-is-never-coerced");
    }
    value.Insert(L"parentCreationTime", JsonValue::CreateNumberValue(123)); require(!parse_overlay_stop_request(value), "overlay-driver-filetime-never-rounds-through-json-double");
  });
  test([] {
    const auto value = wire_request(); value.Insert(L"protocol", JsonValue::CreateNumberValue(2)); require(!parse_overlay_stop_request(value), "overlay-driver.only-private-protocol-one");
    value.Insert(L"protocol", JsonValue::CreateStringValue(L"1")); require(!parse_overlay_stop_request(value), "overlay-driver.protocol-is-not-coerced");
    value.Insert(L"protocol", JsonValue::CreateNumberValue(1)); value.Insert(L"bannerWindowId", JsonValue::CreateStringValue(L"0100")); require(!parse_overlay_stop_request(value), "overlay-driver.window-id-is-canonical");
    value.Insert(L"bannerWindowId", JsonValue::CreateNumberValue(100)); require(!parse_overlay_stop_request(value), "overlay-driver.window-id-is-lossless-string");
  });
  test([] {
    for (int change = 0; change < 5; ++change) {
      auto value = request(); if (change == 0) value.parent = 0; if (change == 1) value.parent_created = 0; if (change == 2) value.banner = nullptr; if (change == 3) value.nonce[0] = L'g'; if (change == 4) value.source_digest[0] = L'B';
      require(!valid_overlay_stop_request(value), "overlay-driver.private-scope-has-no-unknown-owner-or-source");
    }
  });
  test([] {
    for (const auto title : {L"Stop", L"Vector computer smoke", L"Vector computer smoke other", L"Vector computer smoke \u202e"}) {
      auto value = request(); value.title = title; require(!valid_overlay_stop_request(value), "overlay-driver.title-binds-the-same-private-banner-nonce");
    }
    const auto value = wire_request(); value.Insert(L"bannerTitle", JsonValue::CreateStringValue(request().title + L" ")); require(!parse_overlay_stop_request(value), "overlay-driver.banner-title-is-not-trimmed-or-normalized");
  });
  test([] {
    for (int change = 0; change < 6; ++change) {
      auto value = request(); if (change == 0) value.stop_bounds.width = 0; if (change == 1) value.stop_bounds.height = -1; if (change == 2) value.stop_bounds.x = value.banner_bounds.x - 1;
      if (change == 3) value.stop_bounds.y = value.banner_bounds.y + value.banner_bounds.height; if (change == 4) value.banner_bounds.width = 4097; if (change == 5) value.stop_bounds.width = 513;
      require(!valid_overlay_stop_request(value), "overlay-driver.stop-hint-is-bounded-inside-the-owned-banner");
    }
  });
  test([] {
    const WindowsRect native{-200, 30, 80, 40}; require(overlay_stop_bounds_match(native, native), "overlay-driver.native-stop-bounds-match-their-own-hint");
    for (const auto delta : {-1LL, 1LL}) { auto hint = native; hint.x += delta; hint.y += delta; require(overlay_stop_bounds_match(hint, native), "overlay-driver-dom-hint-allows-one-physical-pixel-rounding"); }
    auto hint = native; hint.x += 2; require(!overlay_stop_bounds_match(hint, native), "overlay-driver-hint-cannot-widen-or-retarget-native-stop"); hint = native; hint.width += 2; require(!overlay_stop_bounds_match(hint, native), "overlay-driver-both-native-edges-must-match");
  });
  test([] {
    const OverlayDriverResult passed{true, false, {}}; require(passed.exit_code() == 0, "overlay-driver-owned-down-and-up-success-code"); const auto wire = passed.wire();
    require(wire.Size() == 4 && wire.GetNamedNumber(L"id") == 1 && wire.GetNamedNumber(L"protocol") == 1 && wire.GetNamedString(L"check") == L"native-os-stop" && wire.GetNamedBoolean(L"ok"), "overlay-driver-success-report-has-no-observed-content");
    const OverlayDriverResult skip{false, true, L"noninteractive_desktop"}; require(skip.exit_code() == 77 && skip.wire().GetNamedBoolean(L"skipped"), "overlay-driver-observed-missing-prerequisite-is-explicit-skip");
    const OverlayDriverResult failed{false, false, L"cleanup_failed"}; require(failed.exit_code() == 1 && !failed.wire().GetNamedBoolean(L"ok"), "overlay-driver-unknown-release-is-a-real-failure");
  });
  test([] {
    for (const auto& result : {OverlayDriverResult{true, true, L"noninteractive_desktop"}, OverlayDriverResult{false, true, L"input_post_failed"}, OverlayDriverResult{false, true, {}}, OverlayDriverResult{false, false, L"private window/path or payload"}}) {
      require(result.exit_code() == 1, "overlay-driver-assertions-or-unknown-details-never-become-skips"); const auto wire = result.wire();
      require(!wire.GetNamedBoolean(L"ok") && !wire.HasKey(L"skipped") && wire.GetNamedString(L"reason") == L"native_failure", "overlay-driver-invalid-report-is-sanitized");
    }
  });
  return count;
}
}
