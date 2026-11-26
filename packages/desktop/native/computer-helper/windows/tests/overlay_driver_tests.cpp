#include "overlay_driver.h"
#include "uia_native.h"
#include "input_guardian.h"
#include "privileged_self_test.h"
#include <propidl.h>
#include <uiautomation.h>
#include <algorithm>
#include <limits>
#include <new>
#include <set>
#include <stdexcept>

namespace vector::computer {
namespace {
void require(bool value, const char* label) { if (!value) throw std::runtime_error(label); }
std::wstring named(const JsonObject& value, const wchar_t* key) { return std::wstring(value.GetNamedString(key)); }
std::set<std::wstring> wire_keys(const JsonObject& value) { std::set<std::wstring> result; for (const auto& entry : value) result.insert(std::wstring(entry.Key())); return result; }
std::vector<std::wstring> driver_causes() {
  std::vector<std::wstring> result{L"driver_failure", L"std_exception", L"unknown"};
  for (const auto code : windows_privileged_native_codes) result.push_back(L"core_failure:" + std::wstring(code));
  for (const auto bucket : overlay_driver_hresult_classes) result.push_back(L"hresult:" + std::wstring(bucket));
  return result;
}
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
    const WindowsRect bounds{-200, 40, 80, 40};
    const auto center = overlay_driver_move_probe_point(bounds, POINT{0, 0});
    require(center && center->x == -160 && center->y == 60 && bounds.contains(WindowsRect{center->x, center->y, 1, 1}),
      "overlay-driver.move-probe-prefers-actual-stop-center-when-cursor-differs");
    const auto next = overlay_driver_move_probe_point(bounds, POINT{-160, 60});
    require(next && (next->x != -160 || next->y != 60) && bounds.contains(WindowsRect{next->x, next->y, 1, 1}),
      "overlay-driver.move-probe-selects-another-inside-pixel-if-center-is-current");
    for (const auto tiny : {WindowsRect{10, 20, 2, 1}, WindowsRect{10, 20, 1, 2}, WindowsRect{-2, -2, 3, 3}}) {
      const POINT cursor{static_cast<LONG>(tiny.x + tiny.width / 2), static_cast<LONG>(tiny.y + tiny.height / 2)};
      const auto selected = overlay_driver_move_probe_point(tiny, cursor);
      require(selected && (selected->x != cursor.x || selected->y != cursor.y) && tiny.contains(WindowsRect{selected->x, selected->y, 1, 1}),
        "overlay-driver.move-probe-alternate-pixel-does-not-escape-thin-or-negative-stop-bounds");
    }
  });
  test([] {
    const auto low = static_cast<int64_t>(std::numeric_limits<LONG>::min());
    const auto high = static_cast<int64_t>(std::numeric_limits<LONG>::max());
    for (const auto invalid : {WindowsRect{0, 0, 1, 1}, WindowsRect{0, 0, 0, 4}, WindowsRect{0, 0, 4, 0},
        WindowsRect{0, 0, -1, 4}, WindowsRect{0, 0, 4, -1}, WindowsRect{high + 1, 0, 2, 2},
        WindowsRect{0, low - 1, 2, 2}, WindowsRect{high, 0, 2, 2}, WindowsRect{0, high, 2, 2},
        WindowsRect{std::numeric_limits<int64_t>::max(), 0, 2, 2}, WindowsRect{0, 0, std::numeric_limits<int64_t>::max(), 2}})
      require(!overlay_driver_move_probe_point(invalid, POINT{0, 0}), "overlay-driver.move-probe-tiny-invalid-or-long-overflow-region-fails-closed");
  });
  test([] {
    require(overlay_driver_move_probe_mode(std::nullopt) == std::optional<bool>{false} &&
      overlay_driver_move_probe_mode(std::wstring_view(L"0")) == std::optional<bool>{false},
      "overlay-driver.move-probe-absent-or-exact-zero-preserves-baseline");
    require(overlay_driver_move_probe_mode(std::wstring_view(L"1")) == std::optional<bool>{true},
      "overlay-driver.move-probe-only-exact-one-opts-in");
    for (const auto& value : {std::wstring{}, std::wstring(L"00"), std::wstring(L"01"), std::wstring(L"10"),
        std::wstring(L"true"), std::wstring(L"false"), std::wstring(L" 1"), std::wstring(L"1 "), std::wstring(L"1\n"),
        std::wstring(L"+1"), std::wstring(L"-1"), std::wstring(L"2"), std::wstring(L"\uff11"), std::wstring(L"1\0", 2), std::wstring(100, L'1')})
      require(!overlay_driver_move_probe_mode(std::wstring_view(value)), "overlay-driver.move-probe-invalid-mode-is-never-coerced-or-trimmed");
  });
  test([] {
    require(static_cast<size_t>(OverlayDriverStage::probe_mode) == 169 && static_cast<size_t>(OverlayDriverStage::probe_move) == 170 &&
      overlay_driver_stage_name(OverlayDriverStage::probe_mode) == L"probe-mode" && overlay_driver_stage_name(OverlayDriverStage::probe_move) == L"probe-move",
      "overlay-driver.probe-stages-append-without-changing-existing-169-values");
    require(static_cast<size_t>(OverlayDriverStage::guardian_observe_reply_negative_low32_tag_candidate) == 171 &&
      static_cast<size_t>(OverlayDriverStage::guardian_observe_reply_negative_up_not_released) == 172 &&
      static_cast<size_t>(OverlayDriverStage::guardian_observe_reply_negative_up_no_callback) == 180 &&
      overlay_driver_stage_name(OverlayDriverStage::guardian_observe_reply_negative_up_no_callback) == L"guardian-observe-reply-negative-up-no-callback",
      "overlay-driver.up-release-stages-append-without-changing-existing-172-values");
  });
  test([] {
    for (const auto phase : {InputGuardianPhase::none, InputGuardianPhase::confirmed, static_cast<InputGuardianPhase>(255)})
      require(!overlay_driver_guardian_stage(phase), "overlay-driver.guardian-success-or-unknown-cannot-diagnose-failed-down");
    std::set<OverlayDriverStage> stages;
    for (const auto phase : {InputGuardianPhase::request_invalid, InputGuardianPhase::lock_expired, InputGuardianPhase::budget_expired,
        InputGuardianPhase::inactive, InputGuardianPhase::write_refused, InputGuardianPhase::read_refused,
        InputGuardianPhase::reply_invalid, InputGuardianPhase::setup_failed, InputGuardianPhase::reply_negative,
        InputGuardianPhase::reply_negative_zero_budget, InputGuardianPhase::reply_negative_short_budget,
        InputGuardianPhase::reply_negative_full_budget, InputGuardianPhase::reply_negative_no_callback_pump_stalled,
        InputGuardianPhase::reply_negative_no_callback_pump_progressed, InputGuardianPhase::reply_negative_own_move_only,
        InputGuardianPhase::reply_negative_own_down_refused, InputGuardianPhase::reply_negative_own_up_only,
        InputGuardianPhase::reply_negative_own_tag_unflagged, InputGuardianPhase::reply_negative_low32_tag_candidate,
        InputGuardianPhase::reply_negative_up_not_released,
        InputGuardianPhase::reply_negative_up_release_blocked,
        InputGuardianPhase::reply_negative_up_release_blocked_callbacks,
        InputGuardianPhase::reply_negative_up_release_refused,
        InputGuardianPhase::reply_negative_up_release_slow,
        InputGuardianPhase::reply_negative_up_release_slow_callbacks,
        InputGuardianPhase::reply_negative_up_pump_stalled,
        InputGuardianPhase::reply_negative_up_callbacks_without_up,
        InputGuardianPhase::reply_negative_up_no_callback}) {
      const auto stage = overlay_driver_guardian_stage(phase);
      require(stage && stages.insert(*stage).second && overlay_driver_stage(overlay_driver_stage_name(*stage)),
        "overlay-driver.guardian-failure-buckets-are-unique-closed-stages");
    }
  });
  test([] {
    // A failed UP confirmation reports its guardian phase with the unchanged cleanup_failed reason and exit.
    for (const auto phase : {InputGuardianPhase::lock_expired, InputGuardianPhase::budget_expired, InputGuardianPhase::inactive,
        InputGuardianPhase::write_refused, InputGuardianPhase::read_refused, InputGuardianPhase::reply_invalid,
        InputGuardianPhase::setup_failed, InputGuardianPhase::reply_negative_zero_budget,
        InputGuardianPhase::reply_negative_short_budget, InputGuardianPhase::reply_negative_full_budget,
        InputGuardianPhase::reply_negative_up_not_released,
        InputGuardianPhase::reply_negative_up_release_blocked,
        InputGuardianPhase::reply_negative_up_release_blocked_callbacks,
        InputGuardianPhase::reply_negative_up_release_refused,
        InputGuardianPhase::reply_negative_up_release_slow,
        InputGuardianPhase::reply_negative_up_release_slow_callbacks,
        InputGuardianPhase::reply_negative_up_pump_stalled,
        InputGuardianPhase::reply_negative_up_callbacks_without_up,
        InputGuardianPhase::reply_negative_up_no_callback}) {
      const auto stage = overlay_driver_guardian_stage(phase); require(stage.has_value(), "overlay-driver.failed-up-phase-has-a-closed-stage");
      const auto result = overlay_driver_caught(OverlayDriverMode::stop, *stage, std::make_exception_ptr(DriverFailure{L"cleanup_failed"}));
      const auto wire = result.wire();
      require(!result.ok && !result.skipped && result.exit_code() == 1 && named(wire, L"reason") == L"cleanup_failed" &&
        named(wire, L"stage") == overlay_driver_stage_name(*stage) && named(wire, L"cause") == L"driver_failure" &&
        wire_keys(wire) == std::set<std::wstring>{L"id", L"protocol", L"check", L"ok", L"reason", L"stage", L"cause"},
        "overlay-driver.failed-up-phase-keeps-cleanup-failed-and-exit");
    }
  });
  test([] {
    for (int flags = 0; flags < 16; ++flags) {
      const LONG_PTR extended = ((flags & 1) ? static_cast<LONG_PTR>(WS_EX_NOACTIVATE) : LONG_PTR{0}) |
        ((flags & 2) ? static_cast<LONG_PTR>(WS_EX_TRANSPARENT) : LONG_PTR{0}) |
        ((flags & 4) ? static_cast<LONG_PTR>(WS_EX_LAYERED) : LONG_PTR{0});
      const LONG_PTR style = (flags & 8) ? static_cast<LONG_PTR>(WS_CAPTION) : LONG_PTR{0};
      require(valid_overlay_stop_styles(extended, style) == ((flags & 1) != 0 && (flags & 2) == 0 && (flags & 8) == 0),
        "overlay-driver.clickable-stop-style-authority-is-independent-of-layering");
    }
    for (const LONG_PTR layered : {LONG_PTR{0}, static_cast<LONG_PTR>(WS_EX_LAYERED)}) {
      const auto extended = static_cast<LONG_PTR>(WS_EX_NOACTIVATE) | layered;
      require(valid_overlay_stop_styles(extended | WS_EX_TOOLWINDOW, static_cast<LONG_PTR>(WS_POPUP) | WS_VISIBLE),
        "overlay-driver.clickable-frameless-banner-allows-either-compositor-style");
      for (const LONG_PTR caption : {static_cast<LONG_PTR>(WS_CAPTION), static_cast<LONG_PTR>(WS_BORDER), static_cast<LONG_PTR>(WS_DLGFRAME)})
        require(!valid_overlay_stop_styles(extended, caption), "overlay-driver.any-caption-bit-still-refuses-stop");
    }
  });
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
    for (const auto extra : {L"--stdio", L"--target=C:\\other.exe", L"--script=other.js", L"--no-sandbox", L"--report=private.txt", L"--force-renderer-accessibility", L"--disable-renderer-accessibility"}) {
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
  test([] {
    const auto causes = driver_causes(); require(causes.size() == 40 && std::set<std::wstring>(causes.begin(), causes.end()).size() == 40, "overlay-driver.failure-cause-grammar-is-closed");
    for (const auto stage : overlay_driver_stages) for (const auto& cause : causes) for (const auto reason : {L"native_failure", L"parent_invalid"}) {
      const OverlayDriverResult value{false, false, reason, std::wstring(stage), cause}; const auto wire = value.wire();
      require(value.exit_code() == 1 && !wire.GetNamedBoolean(L"ok") && !wire.HasKey(L"skipped") && named(wire, L"reason") == reason, "overlay-driver.failure-diagnostics-keep-the-failure");
      // A non-driver cause always reported native_failure; any other pairing is dropped, never reported.
      if (cause == L"driver_failure" || std::wstring_view(reason) == L"native_failure") require(wire.Size() == 7 && named(wire, L"stage") == std::wstring(stage) && named(wire, L"cause") == cause, "overlay-driver.failure-stage-and-cause-round-trip");
      else require(wire.Size() == 5 && !wire.HasKey(L"stage") && !wire.HasKey(L"cause"), "overlay-driver.non-driver-cause-requires-native-failure");
    }
    for (size_t index = 0; index < overlay_driver_stages.size(); ++index) require(overlay_driver_stage_name(static_cast<OverlayDriverStage>(index)) == overlay_driver_stages[index], "overlay-driver.stage-names-follow-the-closed-order");
    require(overlay_driver_stage_name(static_cast<OverlayDriverStage>(overlay_driver_stages.size())).empty(), "overlay-driver.out-of-range-stage-has-no-name");
  });
  test([] {
    for (const auto phase : {WindowsUiaPhase::actor_queued, WindowsUiaPhase::prepare_create, WindowsUiaPhase::root_element}) {
      const auto diagnostic = std::make_shared<WindowsUiaDiagnostic>();
      diagnostic->phase.store(phase);
      require(diagnostic->failure_phase(false) == WindowsUiaPhase::none, "overlay-driver.retired-actor-without-timeout-snapshot-does-not-publish-live-phase");
      diagnostic->note_timeout(WindowsUiaExpiry::caller_wait);
      diagnostic->phase.store(WindowsUiaPhase::actor_expired);
      diagnostic->phase.store(WindowsUiaPhase::actor_complete);
      diagnostic->note_timeout(WindowsUiaExpiry::worker_current);
      require(diagnostic->failure_phase(false) == phase, "overlay-driver.first-timeout-phase-survives-late-work-and-later-timeouts");
      require(diagnostic->failure_phase(true) == WindowsUiaPhase::actor_complete, "overlay-driver.healthy-actor-keeps-existing-live-phase-observation");
      const auto stage = overlay_driver_uia_stage(diagnostic->failure_phase(false));
      require(stage.has_value(), "overlay-driver.immutable-timeout-phase-remains-a-closed-stage");
      try { throw Failure{L"no_ui_tree", L"PRIVATE NATIVE CONTENT"}; }
      catch (...) {
        const auto result = overlay_driver_caught(OverlayDriverMode::stop, *stage, std::current_exception());
        require(!result.ok && !result.skipped && result.exit_code() == 1 && result.cause == L"core_failure:no_ui_tree", "overlay-driver.timeout-snapshot-cannot-change-failure-or-create-a-skip");
      }
    }
  });
  test([] {
    for (const auto first : {WindowsUiaPhase::none, static_cast<WindowsUiaPhase>(255)}) {
      const auto diagnostic = std::make_shared<WindowsUiaDiagnostic>();
      diagnostic->phase.store(first);
      diagnostic->note_timeout(WindowsUiaExpiry::caller_wait);
      const auto recorded = diagnostic->timeout_observation.load();
      require(recorded != 0, "overlay-driver.unknown-first-timeout-is-distinct-from-an-unobserved-snapshot");
      diagnostic->phase.store(WindowsUiaPhase::root_element);
      diagnostic->note_timeout(WindowsUiaExpiry::worker_current);
      require(diagnostic->timeout_observation.load() == recorded && diagnostic->failure_phase(false) == WindowsUiaPhase::none,
        "overlay-driver.none-or-invalid-first-timeout-cannot-be-overwritten-by-late-provider-progress");
      require(!overlay_driver_uia_stage(diagnostic->failure_phase(false)), "overlay-driver.unknown-snapshot-never-fabricates-a-closed-stage");
    }
  });
  test([] {
    // HF-7 (1): the first timeout snapshot names its side once, beside the phase, and later observers cannot change it.
    for (const auto side : {WindowsUiaExpiry::worker_current, WindowsUiaExpiry::worker_budget, WindowsUiaExpiry::caller_wait}) {
      const auto diagnostic = std::make_shared<WindowsUiaDiagnostic>();
      require(diagnostic->failure_expiry(false) == WindowsUiaExpiry::none && !diagnostic->failure_status(false), "overlay-driver.unobserved-snapshot-has-no-side-or-status");
      diagnostic->phase.store(WindowsUiaPhase::root_element);
      diagnostic->note_timeout(side);
      for (const auto later : {WindowsUiaExpiry::worker_current, WindowsUiaExpiry::worker_budget, WindowsUiaExpiry::caller_wait}) { diagnostic->phase.store(WindowsUiaPhase::root_handle); diagnostic->note_timeout(later); }
      require(diagnostic->failure_expiry(false) == side && diagnostic->failure_phase(false) == WindowsUiaPhase::root_element, "overlay-driver.first-expiry-side-survives-later-observers");
      require(diagnostic->failure_expiry(true) == WindowsUiaExpiry::none, "overlay-driver.healthy-actor-never-reports-an-expiry-side");
    }
    // A worker-side expiry before the provider call leaves no status; a status the late call writes after
    // the snapshot (for example a CoCancelCall cancellation) is never reported for the retired actor.
    {
      const auto diagnostic = std::make_shared<WindowsUiaDiagnostic>();
      diagnostic->phase.store(WindowsUiaPhase::root_element);
      diagnostic->note_timeout(WindowsUiaExpiry::caller_wait);
      diagnostic->note_root_element_status(static_cast<int32_t>(RPC_E_CALL_CANCELED));
      require(!diagnostic->failure_status(false), "overlay-driver.late-root-status-after-retirement-is-not-reported");
      require(diagnostic->failure_status(true) == static_cast<int32_t>(RPC_E_CALL_CANCELED), "overlay-driver.live-root-status-is-kept-for-a-healthy-actor-only");
    }
    // A status written before the first observer sampled is part of that snapshot; the first status wins.
    {
      const auto diagnostic = std::make_shared<WindowsUiaDiagnostic>();
      diagnostic->phase.store(WindowsUiaPhase::root_element);
      diagnostic->note_root_element_status(static_cast<int32_t>(UIA_E_TIMEOUT));
      diagnostic->note_root_element_status(static_cast<int32_t>(E_FAIL));
      diagnostic->note_root_element_status(0);
      require(diagnostic->failure_status(true) == static_cast<int32_t>(UIA_E_TIMEOUT), "overlay-driver.first-root-status-wins");
      diagnostic->note_timeout(WindowsUiaExpiry::caller_wait);
      diagnostic->root_element_status.store(static_cast<int32_t>(E_ACCESSDENIED));
      require(diagnostic->failure_status(false) == static_cast<int32_t>(UIA_E_TIMEOUT) && diagnostic->failure_expiry(false) == WindowsUiaExpiry::caller_wait && diagnostic->failure_phase(false) == WindowsUiaPhase::root_element, "overlay-driver.status-sampled-before-retirement-is-in-the-snapshot");
    }
    // Out-of-range side encodings never fabricate a side.
    {
      const auto diagnostic = std::make_shared<WindowsUiaDiagnostic>();
      diagnostic->phase.store(WindowsUiaPhase::root_element);
      diagnostic->note_timeout(static_cast<WindowsUiaExpiry>(windows_uia_expiries.size()));
      require(diagnostic->failure_expiry(false) == WindowsUiaExpiry::none && diagnostic->failure_phase(false) == WindowsUiaPhase::root_element, "overlay-driver.unknown-expiry-side-is-none");
    }
  });
  test([] {
    struct Case { WindowsUiaPhase phase; WindowsUiaRootProgress progress; };
    const Case cases[] = {
      {WindowsUiaPhase::root_element, WindowsUiaRootProgress::before_dispatch},
      {WindowsUiaPhase::root_dispatch_started, WindowsUiaRootProgress::dispatch_started},
      {WindowsUiaPhase::root_dispatch_returned, WindowsUiaRootProgress::dispatch_returned},
    };
    for (const auto& item : cases) {
      for (const auto wait : {WindowsUiaCallerWait::pending, WindowsUiaCallerWait::ready}) {
        WindowsUiaDiagnostic diagnostic;
        diagnostic.phase.store(item.phase);
        diagnostic.note_timeout(WindowsUiaExpiry::caller_wait, wait);
        const auto first = diagnostic.timeout_observation.load();
        diagnostic.phase.store(WindowsUiaPhase::root_dispatch_returned);
        diagnostic.note_root_element_status(-1);
        diagnostic.note_timeout(WindowsUiaExpiry::caller_wait, WindowsUiaCallerWait::ready);
        const auto root_wait = diagnostic.failure_root_wait();
        require(root_wait && root_wait->progress == item.progress && root_wait->caller == wait,
          "overlay-driver.first-root-dispatch-and-wait-survive-late-work");
        require(diagnostic.timeout_observation.load() == first && !diagnostic.failure_status(false) &&
          diagnostic.failure_phase(false) == WindowsUiaPhase::root_element &&
          diagnostic.failure_expiry(false) == WindowsUiaExpiry::caller_wait,
          "overlay-driver.root-wait-detail-preserves-original-failure-facts");
      }
    }
    for (const auto side : {WindowsUiaExpiry::worker_current, WindowsUiaExpiry::worker_budget}) {
      WindowsUiaDiagnostic diagnostic;
      diagnostic.phase.store(WindowsUiaPhase::root_dispatch_started);
      diagnostic.note_timeout(side);
      require(!diagnostic.failure_root_wait(), "overlay-driver.worker-expiry-cannot-report-caller-wait");
    }
    WindowsUiaDiagnostic unrelated;
    unrelated.phase.store(WindowsUiaPhase::root_handle);
    unrelated.note_timeout(WindowsUiaExpiry::caller_wait, WindowsUiaCallerWait::pending);
    require(!unrelated.failure_root_wait(), "overlay-driver.non-root-phase-cannot-report-root-dispatch");
  });
  test([] {
    // The closed uia object rides beside stage and cause only, and never changes ok, skip, reason or exit.
    const auto stage = overlay_driver_uia_stage(WindowsUiaPhase::root_element);
    require(stage.has_value(), "overlay-driver.root-element-has-a-stage");
    struct Case { OverlayDriverUiaFailure failure; const wchar_t* lookup; const wchar_t* call; const wchar_t* actor; const wchar_t* expiry; const wchar_t* hresult; const wchar_t* root_attempt = nullptr; };
    const std::vector<Case> cases{
      {{OverlayDriverLookup::first, OverlayDriverUiaCall::root, false, WindowsUiaExpiry::worker_current, {}, OverlayDriverUiaRootAttempt::initial}, L"first", L"root", L"retired", L"worker-current", L"unobserved", L"initial"},
      {{OverlayDriverLookup::first, OverlayDriverUiaCall::root, false, WindowsUiaExpiry::caller_wait, {}, OverlayDriverUiaRootAttempt::replacement}, L"first", L"root", L"retired", L"caller-wait", L"unobserved", L"replacement"},
      {{OverlayDriverLookup::refresh, OverlayDriverUiaCall::root, false, WindowsUiaExpiry::caller_wait, static_cast<int32_t>(UIA_E_TIMEOUT)}, L"refresh", L"root", L"retired", L"caller-wait", L"timeout"},
      {{OverlayDriverLookup::refresh, OverlayDriverUiaCall::root, false, WindowsUiaExpiry::worker_budget, {}}, L"refresh", L"root", L"retired", L"worker-budget", L"unobserved"},
      {{OverlayDriverLookup::first, OverlayDriverUiaCall::root, true, WindowsUiaExpiry::none, static_cast<int32_t>(E_ACCESSDENIED)}, L"first", L"root", L"healthy", L"none", L"access_denied"},
      {{OverlayDriverLookup::refresh, OverlayDriverUiaCall::root, true, WindowsUiaExpiry::none, static_cast<int32_t>(RPC_E_DISCONNECTED)}, L"refresh", L"root", L"healthy", L"none", L"rpc"},
      {{OverlayDriverLookup::first, OverlayDriverUiaCall::root, true, WindowsUiaExpiry::none, static_cast<int32_t>(UIA_E_ELEMENTNOTAVAILABLE)}, L"first", L"root", L"healthy", L"none", L"not_found"},
      {{OverlayDriverLookup::first, OverlayDriverUiaCall::hit, true, WindowsUiaExpiry::none, static_cast<int32_t>(E_FAIL)}, L"first", L"hit", L"healthy", L"none", L"other"},
      {{OverlayDriverLookup::refresh, OverlayDriverUiaCall::hit, false, WindowsUiaExpiry::none, {}}, L"refresh", L"hit", L"retired", L"none", L"unobserved"}};
    for (const auto& item : cases) {
      try { throw Failure{L"no_ui_tree", L"PRIVATE NATIVE CONTENT"}; }
      catch (...) {
        const auto result = overlay_driver_caught(OverlayDriverMode::stop, *stage, std::current_exception(), item.failure);
        require(!result.ok && !result.skipped && result.exit_code() == 1 && result.reason == L"native_failure" && result.cause == L"core_failure:no_ui_tree" && result.stage == L"uia-root-element", "overlay-driver.uia-detail-keeps-the-original-failure");
        const auto wire = result.wire(); const auto document = winrt::to_string(wire.Stringify());
        require(wire.Size() == 8 && wire.HasKey(L"uia"), "overlay-driver.uia-detail-reaches-the-result-frame");
        const auto detail = wire.GetNamedObject(L"uia");
        std::set<std::wstring> fields{L"lookup", L"call", L"actor", L"expiry", L"hresult"};
        if (item.root_attempt) {
          fields.insert(L"rootAttempt");
          require(named(detail, L"rootAttempt") == item.root_attempt, "overlay-driver.uia-detail-names-the-first-root-attempt");
        }
        require(wire_keys(detail) == fields && named(detail, L"lookup") == item.lookup && named(detail, L"call") == item.call && named(detail, L"actor") == item.actor && named(detail, L"expiry") == item.expiry && named(detail, L"hresult") == item.hresult, "overlay-driver.uia-detail-is-closed");
        for (const auto banned : {"PRIVATE", "0x", "8007", "-2147"}) require(document.find(banned) == std::string::npos, "overlay-driver.uia-detail-carries-no-hresult-value");
      }
    }
    const OverlayDriverUiaFailure traced{OverlayDriverLookup::first, OverlayDriverUiaCall::root, false,
      WindowsUiaExpiry::caller_wait, {}, OverlayDriverUiaRootAttempt::replacement,
      WindowsUiaRootWait{WindowsUiaRootProgress::dispatch_started, WindowsUiaCallerWait::pending}};
    const OverlayDriverResult failure{false, false, L"native_failure", L"uia-root-element", L"core_failure:no_ui_tree", traced};
    const auto detail = failure.wire().GetNamedObject(L"uia");
    require(detail.Size() == 8 && named(detail, L"rootProgress") == L"dispatch-started" && named(detail, L"callerWait") == L"pending" &&
      failure.exit_code() == 1, "overlay-driver.root-wait-detail-reaches-the-failure-frame");
    const OverlayDriverResult wrong_stage{false, false, L"native_failure", L"uia-root-wrap", L"core_failure:no_ui_tree", traced};
    require(!wrong_stage.wire().HasKey(L"uia") && wrong_stage.exit_code() == 1,
      "overlay-driver.root-wait-detail-cannot-change-another-phase");
    // Incoherent or out-of-range facts drop the whole object; stage and cause are unchanged.
    for (const auto& failure : {OverlayDriverUiaFailure{OverlayDriverLookup::first, OverlayDriverUiaCall::root, true, WindowsUiaExpiry::caller_wait, {}},
           OverlayDriverUiaFailure{static_cast<OverlayDriverLookup>(2), OverlayDriverUiaCall::root, false, WindowsUiaExpiry::caller_wait, {}},
           OverlayDriverUiaFailure{OverlayDriverLookup::first, static_cast<OverlayDriverUiaCall>(2), false, WindowsUiaExpiry::caller_wait, {}},
           OverlayDriverUiaFailure{OverlayDriverLookup::first, OverlayDriverUiaCall::root, false, static_cast<WindowsUiaExpiry>(windows_uia_expiries.size()), {}},
           OverlayDriverUiaFailure{OverlayDriverLookup::first, OverlayDriverUiaCall::root, false, WindowsUiaExpiry::caller_wait, {}, static_cast<OverlayDriverUiaRootAttempt>(2)},
           OverlayDriverUiaFailure{OverlayDriverLookup::refresh, OverlayDriverUiaCall::root, false, WindowsUiaExpiry::caller_wait, {}, OverlayDriverUiaRootAttempt::initial},
           OverlayDriverUiaFailure{OverlayDriverLookup::first, OverlayDriverUiaCall::hit, false, WindowsUiaExpiry::caller_wait, {}, OverlayDriverUiaRootAttempt::replacement}}) {
      const OverlayDriverResult value{false, false, L"native_failure", L"uia-root-element", L"core_failure:no_ui_tree", failure}; const auto wire = value.wire();
      require(value.exit_code() == 1 && wire.Size() == 7 && !wire.HasKey(L"uia") && named(wire, L"stage") == L"uia-root-element", "overlay-driver.incoherent-uia-detail-is-dropped");
    }
    // Without a stage and cause, or on success, skip or a sanitized report, the object never appears.
    const OverlayDriverUiaFailure valid{OverlayDriverLookup::first, OverlayDriverUiaCall::root, false, WindowsUiaExpiry::caller_wait, {}};
    for (const auto& value : {OverlayDriverResult{true, false, {}, {}, {}, valid}, OverlayDriverResult{false, true, L"noninteractive_desktop", L"desktop", L"std_exception", valid},
           OverlayDriverResult{false, false, L"native_failure", {}, {}, valid}, OverlayDriverResult{false, true, L"input_post_failed", L"post", L"unknown", valid}, OverlayDriverResult{false, false, L"parent_invalid", L"files", L"std_exception", valid}})
      require(!value.wire().HasKey(L"uia"), "overlay-driver.uia-detail-needs-a-reported-stage-and-cause");
    const auto launched = overlay_driver_caught(OverlayDriverMode::launch_electron, OverlayDriverStage::files, std::make_exception_ptr(Failure{L"no_ui_tree", L"private"}), valid);
    require(!launched.uia && !launched.wire().HasKey(L"uia"), "overlay-driver.bootstrap-record-never-carries-uia-detail");
    const auto skipped = overlay_driver_caught(OverlayDriverMode::stop, OverlayDriverStage::uia_available, std::make_exception_ptr(DriverSkip{L"uia_unavailable"}), valid);
    require(skipped.skipped && !skipped.uia && !skipped.wire().HasKey(L"uia"), "overlay-driver.skip-never-carries-uia-detail");
  });
  test([] {
    require(!overlay_driver_uia_stage(WindowsUiaPhase::none) && !overlay_driver_uia_stage(static_cast<WindowsUiaPhase>(windows_uia_phases.size())), "overlay-driver.uia-unknown-phases-have-no-stage");
    for (size_t index = 1; index < windows_uia_phases.size(); ++index) {
      const auto stage = overlay_driver_uia_stage(static_cast<WindowsUiaPhase>(index));
      require(stage && overlay_driver_stage_name(*stage) == L"uia-" + std::wstring(windows_uia_phases[index]), "overlay-driver.uia-phase-maps-to-its-closed-stage");
      try { throw Failure{L"no_ui_tree", L"PRIVATE NATIVE CONTENT"}; }
      catch (...) {
        const auto result = overlay_driver_caught(OverlayDriverMode::stop, *stage, std::current_exception());
        require(!result.ok && !result.skipped && result.exit_code() == 1 && result.cause == L"core_failure:no_ui_tree" && result.stage == overlay_driver_stage_name(*stage), "overlay-driver.uia-stage-keeps-original-failure-and-exit");
      }
    }
  });
  test([] {
    for (const auto stage : {L"", L"bogus", L"Files", L"files ", L"observe_parent", L"C:\\Windows", L"0x80070005"}) {
      const OverlayDriverResult value{false, false, L"native_failure", stage, L"unknown"}; const auto wire = value.wire();
      require(value.exit_code() == 1 && wire.Size() == 5 && !wire.HasKey(L"stage") && !wire.HasKey(L"cause") && named(wire, L"reason") == L"native_failure", "overlay-driver.unknown-stage-is-dropped");
    }
    for (const auto cause : {L"", L"driver_skip", L"core_failure:", L"core_failure:PRIVATE", L"core_failure:native_operation_failed", L"hresult:", L"hresult:0x80070005", L"hresult:-2147024891", L"Unknown", L"std_exception ", L"hresult:access_denied "}) {
      const OverlayDriverResult value{false, false, L"native_failure", L"files", cause}; const auto wire = value.wire();
      require(value.exit_code() == 1 && wire.Size() == 5 && !wire.HasKey(L"stage") && !wire.HasKey(L"cause") && named(wire, L"reason") == L"native_failure", "overlay-driver.unknown-cause-is-dropped");
    }
  });
  test([] {
    const OverlayDriverResult passed{true, false, {}, L"post", L"unknown"}; const auto success = passed.wire();
    require(passed.exit_code() == 0 && success.Size() == 4 && success.GetNamedBoolean(L"ok") && !success.HasKey(L"stage") && !success.HasKey(L"cause"), "overlay-driver.success-never-carries-diagnostics");
    const OverlayDriverResult skip{false, true, L"noninteractive_desktop", L"desktop", L"std_exception"}; const auto skipped = skip.wire();
    require(skip.exit_code() == 77 && skipped.Size() == 6 && skipped.GetNamedBoolean(L"skipped") && !skipped.HasKey(L"stage") && !skipped.HasKey(L"cause"), "overlay-driver.skip-never-carries-diagnostics");
    const OverlayDriverResult incoherent{false, true, L"input_post_failed", L"post", L"unknown"}; const auto sanitized = incoherent.wire();
    require(incoherent.exit_code() == 1 && sanitized.Size() == 5 && named(sanitized, L"reason") == L"native_failure" && !sanitized.HasKey(L"stage") && !sanitized.HasKey(L"cause"), "overlay-driver.sanitized-report-never-carries-diagnostics");
  });
  test([] {
    for (const auto& base : {OverlayDriverResult{true, false, {}}, OverlayDriverResult{false, true, L"noninteractive_desktop"}, OverlayDriverResult{false, false, L"cleanup_failed"}, OverlayDriverResult{false, false, L"native_failure"},
           OverlayDriverResult{true, true, L"noninteractive_desktop"}, OverlayDriverResult{false, true, L"input_post_failed"}, OverlayDriverResult{false, true, {}}, OverlayDriverResult{false, false, L"private window/path or payload"}, OverlayDriverResult{false, false, {}}})
      for (const auto stage : {L"", L"files", L"post", L"bogus"}) for (const auto cause : {L"", L"unknown", L"driver_failure", L"hresult:rpc", L"PRIVATE"}) {
        auto value = base; value.stage = stage; value.cause = cause; const auto wire = value.wire(), plain = base.wire(); const auto document = winrt::to_string(wire.Stringify());
        require(value.exit_code() == base.exit_code() && wire.GetNamedBoolean(L"ok") == plain.GetNamedBoolean(L"ok") && wire.HasKey(L"skipped") == plain.HasKey(L"skipped") && wire.HasKey(L"reason") == plain.HasKey(L"reason") && (!plain.HasKey(L"reason") || named(wire, L"reason") == named(plain, L"reason")), "overlay-driver.diagnostics-never-change-exit-codes");
        require(wire.Size() == plain.Size() + (wire.HasKey(L"stage") ? 2u : 0u) && wire.HasKey(L"stage") == wire.HasKey(L"cause") && document.find("PRIVATE") == std::string::npos && document.find("bogus") == std::string::npos, "overlay-driver.diagnostics-are-both-or-neither");
      }
  });
  test([] {
    const auto launch = [](std::exception_ptr error) { return overlay_driver_caught(OverlayDriverMode::launch_electron, OverlayDriverStage::files, error); };
    const auto unavailable = launch(std::make_exception_ptr(DriverFailure{L"medium_token_unavailable"}));
    require(unavailable.skipped && unavailable.exit_code() == 77 && unavailable.stage.empty() && unavailable.cause.empty() && wire_keys(unavailable.wire()) == std::set<std::wstring>{L"id", L"protocol", L"check", L"ok", L"skipped", L"reason"}, "overlay-driver.bootstrap-unavailable-record-is-unchanged");
    for (const auto& error : {std::make_exception_ptr(DriverFailure{L"bootstrap_failed"}), std::make_exception_ptr(std::runtime_error("C:\\private")), std::make_exception_ptr(Failure{L"unavailable", L"private"}), std::make_exception_ptr(ProtocolError(0, L"timeout", L"private")), std::make_exception_ptr(winrt::hresult_error(E_ACCESSDENIED)), std::make_exception_ptr(7), std::exception_ptr{}}) {
      const auto value = launch(error);
      require(!value.ok && !value.skipped && value.stage.empty() && value.cause.empty() && value.exit_code() == 1 && wire_keys(value.wire()) == std::set<std::wstring>{L"id", L"protocol", L"check", L"ok", L"reason"}, "overlay-driver.bootstrap-record-is-unchanged");
    }
    require(launch(std::make_exception_ptr(DriverFailure{L"bootstrap_failed"})).reason == L"bootstrap_failed" && launch(std::make_exception_ptr(std::runtime_error("C:\\private"))).reason == L"native_failure", "overlay-driver.bootstrap-reasons-are-unchanged");
    const auto skip = launch(std::make_exception_ptr(DriverSkip{L"noninteractive_desktop"}));
    require(skip.skipped && skip.exit_code() == 77 && skip.stage.empty() && skip.cause.empty(), "overlay-driver.bootstrap-skip-is-unchanged");
    const auto stopped = overlay_driver_caught(OverlayDriverMode::stop, OverlayDriverStage::envelope_read, std::make_exception_ptr(DriverFailure{L"medium_token_unavailable"}));
    require(!stopped.skipped && stopped.exit_code() == 1 && stopped.stage == L"envelope-read" && stopped.cause == L"driver_failure", "overlay-driver.stop-mode-medium-token-is-never-a-skip");
  });
  test([] {
    struct Case { std::exception_ptr error; const wchar_t* reason; const wchar_t* cause; };
    const std::vector<Case> cases{
      {std::make_exception_ptr(Failure{L"unavailable", L"private"}), L"native_failure", L"core_failure:unavailable"},
      {std::make_exception_ptr(Failure{L"target_validation_failed", L"private"}), L"native_failure", L"core_failure:unknown"},
      {std::make_exception_ptr(Failure{L"C:\\private", L"private"}), L"native_failure", L"core_failure:unknown"},
      // A ProtocolError is a std::exception, but its closed code is kept rather than reported as std_exception.
      {std::make_exception_ptr(ProtocolError(0, L"frame_too_large", L"private")), L"native_failure", L"core_failure:frame_too_large"},
      {std::make_exception_ptr(ProtocolError(0, L"C:\\private", L"private")), L"native_failure", L"core_failure:unknown"},
      {std::make_exception_ptr(winrt::hresult_error(E_ACCESSDENIED, L"private message")), L"native_failure", L"hresult:access_denied"},
      {std::make_exception_ptr(winrt::hresult_error(RPC_E_DISCONNECTED)), L"native_failure", L"hresult:rpc"},
      {std::make_exception_ptr(winrt::hresult_error(HRESULT_FROM_WIN32(RPC_S_SERVER_UNAVAILABLE))), L"native_failure", L"hresult:rpc"},
      {std::make_exception_ptr(winrt::hresult_error(static_cast<HRESULT>(UIA_E_ELEMENTNOTAVAILABLE))), L"native_failure", L"hresult:not_found"},
      {std::make_exception_ptr(winrt::hresult_error(static_cast<HRESULT>(UIA_E_TIMEOUT))), L"native_failure", L"hresult:timeout"},
      {std::make_exception_ptr(winrt::hresult_error(RPC_E_TIMEOUT)), L"native_failure", L"hresult:timeout"},
      {std::make_exception_ptr(winrt::hresult_error(E_FAIL)), L"native_failure", L"hresult:other"},
      {std::make_exception_ptr(std::runtime_error("C:\\private")), L"native_failure", L"std_exception"},
      {std::make_exception_ptr(std::bad_alloc()), L"native_failure", L"std_exception"},
      {std::make_exception_ptr(7), L"native_failure", L"unknown"},
      {std::exception_ptr{}, L"native_failure", L"unknown"},
      {std::make_exception_ptr(DriverFailure{L"parent_invalid"}), L"parent_invalid", L"driver_failure"}};
    for (size_t index = 0; index < overlay_driver_stages.size(); ++index) for (const auto& item : cases) {
      const auto value = overlay_driver_caught(OverlayDriverMode::stop, static_cast<OverlayDriverStage>(index), item.error); const auto wire = value.wire(); const auto document = winrt::to_string(wire.Stringify());
      require(!value.ok && !value.skipped && value.reason == item.reason && value.cause == item.cause && value.stage == std::wstring(overlay_driver_stages[index]) && value.exit_code() == 1, "overlay-driver.caught-exceptions-map-to-closed-causes");
      require(wire.Size() == 7 && named(wire, L"stage") == std::wstring(overlay_driver_stages[index]) && named(wire, L"cause") == item.cause && named(wire, L"reason") == item.reason, "overlay-driver.caught-diagnostics-reach-the-result-frame");
      for (const auto banned : {"private", "0x", "8007", "-2147", "C:"}) require(document.find(banned) == std::string::npos, "overlay-driver.caught-diagnostics-carry-no-native-detail");
    }
    const auto skip = overlay_driver_caught(OverlayDriverMode::stop, OverlayDriverStage::desktop, std::make_exception_ptr(DriverSkip{L"noninteractive_desktop"}));
    require(skip.skipped && skip.exit_code() == 77 && skip.stage.empty() && skip.cause.empty() && !skip.wire().HasKey(L"stage"), "overlay-driver.caught-skips-carry-no-diagnostics");
  });
  test([] {
    for (unsigned facility = 0; facility < 0x2000; facility += 7) for (const unsigned code : {0u, 5u, 0x6bau, 0x490u, 0xffffu}) {
      const auto bucket = overlay_driver_hresult_class(static_cast<HRESULT>(0x80000000u | (facility << 16) | code));
      require(std::find(overlay_driver_hresult_classes.begin(), overlay_driver_hresult_classes.end(), bucket) != overlay_driver_hresult_classes.end(), "overlay-driver.hresult-classes-are-buckets");
    }
    for (const auto code : {static_cast<HRESULT>(UIA_E_TIMEOUT), RPC_E_TIMEOUT, HRESULT_FROM_WIN32(ERROR_TIMEOUT)}) require(overlay_driver_hresult_class(code) == L"timeout", "overlay-driver.hresult-timeouts-precede-rpc");
    for (const auto code : {RPC_E_DISCONNECTED, RPC_E_CALL_REJECTED, HRESULT_FROM_WIN32(RPC_S_SERVER_UNAVAILABLE), HRESULT_FROM_WIN32(RPC_S_CALL_FAILED), HRESULT_FROM_WIN32(RPC_S_CALL_FAILED_DNE)}) require(overlay_driver_hresult_class(code) == L"rpc", "overlay-driver.hresult-rpc-bucket");
    for (const auto code : {static_cast<HRESULT>(UIA_E_ELEMENTNOTAVAILABLE), HRESULT_FROM_WIN32(ERROR_NOT_FOUND), HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND), HRESULT_FROM_WIN32(ERROR_PATH_NOT_FOUND), HRESULT_FROM_WIN32(ERROR_INVALID_WINDOW_HANDLE)}) require(overlay_driver_hresult_class(code) == L"not_found", "overlay-driver.hresult-not-found-bucket");
    for (const auto code : {E_FAIL, E_INVALIDARG, E_OUTOFMEMORY, S_OK, S_FALSE}) require(overlay_driver_hresult_class(code) == L"other", "overlay-driver.hresult-other-bucket");
    require(overlay_driver_hresult_class(E_ACCESSDENIED) == L"access_denied", "overlay-driver.hresult-access-denied-bucket");
  });
  return count;
}
}
