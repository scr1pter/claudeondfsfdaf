#include "privileged_self_test.h"
#include "privileged_target.h"
#include "protocol.h"
#include "capture.h"
#include <algorithm>
#include <limits>
#include <set>
#include <stdexcept>
#include <thread>

namespace vector::computer {
namespace {
void require(bool condition, const char* label) { if (!condition) throw std::runtime_error(label); }
WindowsPrivilegedReport passed_report() {
  WindowsPrivilegedReport report;
  for (const auto name : windows_privileged_checks) report.checks.push_back({std::wstring(name), true, false, {}});
  return report;
}
std::vector<std::wstring> target_options() {
  return {L"--control", L"--parent-pid", L"42", L"--nonce", std::wstring(64, L'a'), L"--isolated"};
}
JsonObject control(uint64_t id, std::wstring_view action) {
  JsonObject value;
  value.Insert(L"id", JsonValue::CreateNumberValue(static_cast<double>(id)));
  value.Insert(L"op", JsonValue::CreateStringValue(action));
  return value;
}
WindowsTargetState target_state() {
  WindowsTargetState value;
  value.pid = 43; value.parent = 42;
  value.window = reinterpret_cast<HWND>(uintptr_t{100});
  value.excluded = reinterpret_cast<HWND>(uintptr_t{101});
  value.bounds = {-200, 80, 640, 480};
  value.patch = {-180, 110, 160, 100};
  value.button = {50, 110, 240, 36};
  value.plain = {-180, 250, 500, 28};
  value.secure = {-180, 320, 500, 28};
  value.excluded_bounds = {-160, 130, 40, 40};
  value.visible = true; value.minimized = false; value.foreground = true;
  value.counter = 3;
  value.key_downs = 8; value.key_ups = 8;
  value.button_downs = 4; value.button_ups = 4;
  value.text = {23, std::wstring(64, L'a')};
  value.secret = {16, std::wstring(64, L'b')};
  return value;
}
JsonObject private_state() {
  const auto value = JsonObject::Parse(LR"({"pid":43,"parentPID":42,"windowId":"100","excludedWindowId":"101","bounds":{"x":-200,"y":80,"w":640,"h":480},"excludedBounds":{"x":-160,"y":130,"w":40,"h":40},"views":{"patch":{"x":-180,"y":110,"w":160,"h":100},"button":{"x":50,"y":110,"w":240,"h":36},"plain":{"x":-180,"y":250,"w":500,"h":28},"secure":{"x":-180,"y":320,"w":500,"h":28}},"visible":true,"minimized":false,"foreground":true,"affinity":false,"excludedVisible":false,"counter":3,"text":{"length":23,"sha256":""},"secure":{"length":16,"sha256":""},"events":{"keyDowns":8,"keyUps":8,"buttonDowns":4,"buttonUps":4,"heldKeys":0,"heldButtons":0}})");
  value.GetNamedObject(L"text").Insert(L"sha256", JsonValue::CreateStringValue(std::wstring(64, L'a')));
  value.GetNamedObject(L"secure").Insert(L"sha256", JsonValue::CreateStringValue(std::wstring(64, L'b')));
  return value;
}
}

// Pure report, CLI, control and already-observed state fixtures. No process, HWND query,
// crypto operation, pipe, capture, accessibility, input, permission or OS configuration is used.
size_t run_privileged_self_test_tests() {
  size_t count = 0;
  const auto test = [&](const auto& body) { body(); ++count; };
  test([] {
    constexpr std::array<std::wstring_view, 15> expected{
      L"privileged-isolated-target", L"apps-running-target", L"apps-installed-target",
      L"capture-color-patch", L"capture-affinity-exclusion", L"uia-counter-increment",
      L"uia-value-set-and-readback", L"secure-field-refusal", L"tagged-click-increments",
      L"unicode-type-readback", L"stale-capture-refusal", L"owned-input-release",
      L"input-detection-probe", L"hardware-user-input-pauses", L"isolated-target-cleanup"};
    require(windows_privileged_checks == expected &&
      std::set<std::wstring_view>(expected.begin(), expected.end()).size() == expected.size(),
      "privileged.fixed-complete-unique-catalog");
  });
  test([] {
    const auto report = passed_report();
    require(report.valid() && report.exit_code() == 0, "privileged.all-success-exit-zero");
    const auto wire = report.wire();
    require(wire.Size() == 1 && wire.HasKey(L"checks"), "privileged.fixed-report-envelope");
    const auto checks = wire.GetNamedArray(L"checks");
    require(checks.Size() == windows_privileged_checks.size(), "privileged.wire-complete-catalog");
    for (uint32_t index = 0; index < checks.Size(); ++index) {
      const auto entry = checks.GetObjectAt(index);
      require(entry.Size() == 2 && entry.GetNamedString(L"name") == windows_privileged_checks[index] &&
        entry.GetNamedBoolean(L"ok"), "privileged.wire-success-is-name-and-boolean-only");
    }
  });
  test([] {
    const auto report = WindowsPrivilegedReport::skipped(L"noninteractive_desktop");
    require(report.valid() && report.exit_code() == 77 && report.checks.size() == windows_privileged_checks.size(),
      "privileged.observed-unavailable-prerequisite-is-explicit-skip");
    for (const auto& entry : report.checks)
      require(!entry.ok && entry.skipped && entry.detail == L"noninteractive_desktop", "privileged.skip-preserves-fixed-reason");
  });
  test([] {
    // Use the production protocol constructor: error is text, while code is a top-level field.
    const auto reply = response_failure(42, L"secure_field", L"PRIVATE native explanation");
    require(reply.GetNamedString(L"error") == L"PRIVATE native explanation" &&
      windows_privileged_response_failure(reply, L"secure_field") &&
      !windows_privileged_response_failure(reply, L"changed"), "privileged.refusal-reads-production-top-level-code");
    require(!windows_privileged_response_failure(response_success(42), L"secure_field"),
      "privileged.success-is-not-a-refusal");
    const auto legacy = JsonObject::Parse(LR"({"ok":false,"error":{"code":"secure_field"}})");
    require(!windows_privileged_response_failure(legacy, L"secure_field"), "privileged.nested-error-cannot-substitute-code");
    auto malformed = reply; malformed.Insert(L"code", JsonValue::CreateNumberValue(7));
    require(!windows_privileged_response_failure(malformed, L"secure_field"), "privileged.malformed-code-is-not-a-match");
  });
  test([] {
    require(std::set<std::wstring_view>(windows_privileged_stages.begin(), windows_privileged_stages.end()).size() == windows_privileged_stages.size() &&
      std::set<std::wstring_view>(windows_privileged_native_codes.begin(), windows_privileged_native_codes.end()).size() == windows_privileged_native_codes.size(),
      "privileged.diagnostic-enums-are-unique");
    for (const auto stage : windows_privileged_stages) for (const auto code : windows_privileged_native_codes) {
      auto report = passed_report(); report.checks[3] = {std::wstring(windows_privileged_checks[3]), false, false,
        L"native_operation_failed", std::wstring(stage), std::wstring(code)};
      require(report.valid() && report.exit_code() == 1, "privileged.closed-diagnostics-preserve-failure-exit");
      const auto row = report.wire().GetNamedArray(L"checks").GetObjectAt(3);
      require(row.GetNamedString(L"detail") == L"native_operation_failed" && row.GetNamedString(L"stage") == stage &&
        row.GetNamedString(L"nativeCode") == code && !row.GetNamedBoolean(L"ok"), "privileged.closed-diagnostics-preserve-reason-and-fields");
    }
    require(windows_privileged_native_code(L"capture_unavailable") == L"capture_unavailable" &&
      windows_privileged_native_code(L"PRIVATE native explanation") == L"unknown" && windows_privileged_native_code(L"") == L"unknown",
      "privileged.unknown-native-codes-do-not-disclose-text");
  });
  test([] {
    const WindowsPrivilegedCheck failed{std::wstring(windows_privileged_checks[3]), false, false,
      L"native_operation_failed", L"window-capture-reply", L"capture_unavailable"};
    for (size_t variation = 0; variation < 7; ++variation) {
      auto report = passed_report(); auto row = failed;
      if (variation == 0) row.stage.clear();
      if (variation == 1) row.native_code.clear();
      if (variation == 2) row.stage = L"PRIVATE native explanation";
      if (variation == 3) row.native_code = L"PRIVATE native explanation";
      if (variation == 4) row.ok = true;
      if (variation == 5) { row.skipped = true; row.detail = L"capture_blocked"; }
      if (variation == 6) row.detail.clear();
      report.checks[3] = row;
      require(!report.valid() && report.exit_code() == 1, "privileged.diagnostics-require-closed-paired-failure-only-fields");
      const std::wstring wire(report.wire().Stringify());
      require(wire.find(L"PRIVATE") == std::wstring::npos && wire.find(L"nativeCode") == std::wstring::npos,
        "privileged.invalid-diagnostic-never-reaches-wire");
    }
  });
  test([] {
    constexpr std::array<std::pair<std::wstring_view, std::wstring_view>, 4> origins{{
      {L"The computer session changed during the operation.", L"authority-completion"},
      {L"The native observation changed before delivery.", L"authority-delivery"},
      {L"The native capture changed. Take a new screenshot.", L"capture-service"},
      {L"The native capture is unavailable. Check Windows Privacy & security settings.", L"capture-native"}}};
    for (const auto& [message, stage] : origins) {
      const auto reply = response_failure(42, L"changed", std::wstring(message));
      require(windows_privileged_origin_stage(reply.GetNamedString(L"error")) == stage,
        "privileged.fixed-response-error-maps-only-to-closed-origin");
      for (const auto& altered : {std::wstring(message) + L" PRIVATE", std::wstring(L"PRIVATE ") + std::wstring(message)})
        require(windows_privileged_origin_stage(altered).empty(), "privileged.origin-mapping-never-matches-substrings");
    }
    require(windows_privileged_origin_stage(L"PRIVATE explanation", L"window-capture-reply") == L"window-capture-reply" &&
      windows_privileged_origin_stage(L"PRIVATE explanation", L"PRIVATE fallback", L"PRIVATE trace").empty(),
      "privileged.unknown-errors-preserve-only-closed-fallback");
    require(windows_privileged_origin_stage(origins[0].first, L"window-capture-reply", L"capture-native-read") == L"authority-completion" &&
      windows_privileged_origin_stage(origins[1].first, L"window-capture-reply", L"capture-native-read") == L"authority-delivery" &&
      windows_privileged_origin_stage(origins[2].first, L"window-capture-reply", L"capture-commit-current") == L"capture-commit-current",
      "privileged.authority-rejection-takes-precedence-over-provider-trace");
  });
  test([] {
    CaptureBackend backend;
    backend.inventory = [](const auto&, const auto&) -> CaptureInventory { throw Failure{L"changed", L"PRIVATE provider explanation"}; };
    const auto initial = windows_privileged_capture_diagnostic(backend, [](auto& observed) {
      try { observed.inventory(ServerSession{}, [] { return true; }); }
      catch (const Failure& failure) {
        require(failure.code == L"changed" && failure.message == L"PRIVATE provider explanation",
          "privileged.inventory-observer-preserves-original-failure"); return;
      }
      require(false, "privileged.inventory-observer-does-not-invent-success");
    });
    require(initial == L"capture-inventory-initial", "privileged.initial-inventory-failure-is-distinguished");
    unsigned inventories = 0;
    backend.inventory = [&](const auto&, const auto&) -> CaptureInventory {
      if (++inventories == 2) throw Failure{L"changed", L"PRIVATE refresh explanation"};
      CaptureInventory result; result.displays.resize(2); return result;
    };
    const auto refresh = windows_privileged_capture_diagnostic(backend, [](auto& observed) {
      require(observed.inventory(ServerSession{}, [] { return true; }).displays.size() == 2,
        "privileged.inventory-observer-preserves-result");
      try { observed.inventory(ServerSession{}, [] { return true; }); }
      catch (const Failure& failure) { require(failure.code == L"changed", "privileged.refresh-failure-is-not-replaced"); return; }
      require(false, "privileged.refresh-observer-does-not-invent-success");
    });
    require(refresh == L"capture-inventory-refresh", "privileged.refresh-inventory-failure-is-distinguished");
  });
  test([] {
    CaptureBackend backend;
    backend.read = [](const auto&, const auto&) -> CaptureBitmap { throw std::runtime_error("PRIVATE native explanation"); };
    backend.current = [](const auto&, const auto&) { return false; };
    const auto read = windows_privileged_capture_diagnostic(backend, [](auto& observed) {
      try { observed.read(CaptureReadRequest{}, [] { return true; }); }
      catch (const std::runtime_error& failure) {
        require(std::string_view(failure.what()) == "PRIVATE native explanation", "privileged.native-read-observer-preserves-exception");
      }
      require(!observed.current(CaptureInventory{}, ServerSession{}), "privileged.commit-observer-preserves-false");
    });
    require(read == L"capture-native-read", "privileged.first-provider-failure-wins");
    require(windows_privileged_capture_diagnostic(backend, [](auto& observed) {
      require(!observed.current(CaptureInventory{}, ServerSession{}), "privileged.commit-observer-cannot-authorize-publication");
    }) == L"capture-commit-current", "privileged.commit-current-false-is-distinguished");
    backend.current = [](const auto&, const auto&) { return true; };
    require(windows_privileged_capture_diagnostic(backend, [](auto& observed) {
      require(observed.current(CaptureInventory{}, ServerSession{}), "privileged.commit-observer-preserves-true");
    }).empty(), "privileged.successful-provider-has-no-failure-trace");
  });
  test([] {
    CaptureBackend backend;
    backend.current = [](const auto&, const auto&) { return false; };
    require(windows_privileged_capture_diagnostic(backend, [](auto& observed) {
      bool refused = false;
      std::thread worker([&] { try { refused = !observed.current(CaptureInventory{}, ServerSession{}); } catch (...) {} });
      worker.join();
      require(refused, "privileged.unscoped-thread-preserves-currentness");
    }).empty(), "privileged.provider-trace-does-not-cross-handler-threads");
    const auto outer = windows_privileged_capture_diagnostic(backend, [&](auto& observed) {
      require(windows_privileged_capture_diagnostic(backend, [](auto& nested) {
        require(!nested.current(CaptureInventory{}, ServerSession{}), "privileged.nested-provider-preserves-false");
      }) == L"capture-commit-current", "privileged.nested-scope-has-independent-trace");
      try { windows_privileged_capture_diagnostic(backend, [](auto&) { throw std::runtime_error("PRIVATE operation"); }); }
      catch (const std::runtime_error&) {}
      require(!observed.current(CaptureInventory{}, ServerSession{}), "privileged.outer-scope-restored-after-unwind");
    });
    require(outer == L"capture-commit-current", "privileged.nesting-and-exceptions-restore-handler-scope");
  });
  test([] {
    for (unsigned index = 1; index < static_cast<unsigned>(WindowsInventoryDiagnostic::count); ++index) {
      const auto diagnostic = static_cast<WindowsInventoryDiagnostic>(index);
      const auto expected = windows_inventory_diagnostic_stage(diagnostic);
      require(!expected.empty() && std::find(windows_privileged_stages.begin(), windows_privileged_stages.end(), expected) != windows_privileged_stages.end(),
        "privileged.native-inventory-origins-have-closed-report-stages");
      const auto observed = windows_privileged_capture_diagnostic(CaptureBackend{}, [&](auto&) {
        observe_windows_inventory_failure(windows_privileged_inventory_failure, diagnostic);
      });
      require(observed == expected, "privileged.actual-native-observer-reaches-request-local-trace");
      require(windows_privileged_origin_stage(L"The native capture is unavailable. Check Windows Privacy & security settings.", L"window-capture-reply", observed) == observed,
        "privileged.exact-native-fence-takes-precedence-over-generic-provider-origin");
      require(windows_privileged_origin_stage(L"The native observation changed before delivery.", L"window-capture-reply", observed) == L"authority-delivery",
        "privileged.native-fence-does-not-override-authority-loss");
    }
    const auto unknown = static_cast<WindowsInventoryDiagnostic>(-1);
    require(windows_inventory_diagnostic_stage(unknown).empty() && windows_privileged_capture_diagnostic(CaptureBackend{}, [&](auto&) {
      observe_windows_inventory_failure(windows_privileged_inventory_failure, unknown);
    }).empty(), "privileged.unknown-inventory-enum-cannot-produce-metadata");
    observe_windows_inventory_failure(nullptr, WindowsInventoryDiagnostic::capture_bounds);
    observe_windows_inventory_failure(+[](WindowsInventoryDiagnostic) { throw std::runtime_error("PRIVATE observer explanation"); }, WindowsInventoryDiagnostic::capture_bounds);
  });
  test([] {
    for (const bool shape : {false, true}) for (unsigned observer = 0; observer < 3; ++observer) {
      WindowsBackend backend;
      backend.list = [shape](bool, const auto&) {
        std::vector<WindowsApplication> apps(shape ? 1U : 1001U);
        if (shape) apps[0].windows.resize(1); return apps;
      };
      const WindowsInventoryObserver diagnostic = observer == 0 ? nullptr : observer == 1
        ? +[](WindowsInventoryDiagnostic) { throw std::runtime_error("PRIVATE observer explanation"); }
        : windows_privileged_inventory_failure;
      WindowService service({}, backend, diagnostic);
      OperationContext context; context.is_current = [] { return true; };
      unsigned completions = 0;
      const auto stage = windows_privileged_capture_diagnostic(CaptureBackend{}, [&](auto&) {
        service.list(JsonObject{}, context, [&](Dispatcher::Result result) {
          ++completions;
          require(std::holds_alternative<Failure>(result) && std::get<Failure>(result).code == L"unavailable" &&
            std::get<Failure>(result).message == L"The app or window operation is unavailable.",
            "privileged.inventory-observer-preserves-service-failure-and-message");
        });
      });
      require(completions == 1 && stage == (observer == 2 ? shape ? L"installed-apps-shape" : L"installed-apps-count" : L""),
        "privileged.null-or-throwing-observer-does-not-change-service-result");
    }
  });
  test([] {
    for (const auto reason : {L"isolation_required", L"elevated_helper", L"noninteractive_desktop", L"capture_blocked", L"input_detection_unavailable", L"foreground_unavailable", L"affinity_unavailable", L"target_not_installed", L"hardware_input_required", L"physical_takeover"})
      require(windows_privileged_skip_reason(reason) && WindowsPrivilegedReport::skipped(reason).valid() && WindowsPrivilegedReport::skipped(reason).exit_code() == 77,
        "privileged.only-actual-unavailable-prerequisites-or-takeover-can-skip");
    for (const auto reason : {L"", L"target_unavailable", L"target_validation_failed", L"target_spawn_failed", L"target_control_invalid", L"target_token_invalid", L"target_manifest_invalid", L"target_window_failed", L"target_report_failed", L"target_control_failed", L"target_exited", L"target_not_ready", L"target_state_invalid", L"assertion_failed", L"native_operation_failed", L"deadline_exceeded", L"cleanup_failed", L"dependency_failed"}) {
      const auto report = WindowsPrivilegedReport::skipped(reason);
      require(!windows_privileged_skip_reason(reason) && !report.valid() && report.exit_code() == 1,
        "privileged.admission-native-assertion-and-cleanup-failures-never-validate-as77");
      for (const auto& item : report.wire().GetNamedArray(L"checks"))
        require(!item.GetObject().GetNamedBoolean(L"ok") && !item.GetObject().GetNamedBoolean(L"skipped", false),
          "privileged.invalid-skip-reports-full-failure-catalog");
    }
  });
  test([] {
    for (size_t index = 0; index < windows_privileged_checks.size(); ++index) {
      auto report = passed_report();
      report.checks[index].ok = false; report.checks[index].skipped = true;
      report.checks[index].detail = L"noninteractive_desktop";
      require(report.valid() && report.exit_code() == 77, "privileged.one-skip-prevents-all-green-exit");
      const auto failure = (index + 1) % report.checks.size();
      report.checks[failure].ok = false; report.checks[failure].detail = L"assertion_failed";
      require(report.valid() && report.exit_code() == 1, "privileged.assertion-failure-takes-precedence-over-skip");
    }
  });
  test([] {
    auto report = passed_report();
    report.checks[1] = {std::wstring(windows_privileged_checks[1]), false, false, L"assertion_failed"};
    report.checks[2] = {std::wstring(windows_privileged_checks[2]), false, true, L"target_not_installed"};
    for (size_t index = 3; index < report.checks.size(); ++index)
      report.checks[index] = {std::wstring(windows_privileged_checks[index]), false, false, L"dependency_failed"};
    report.skip_unrun(L"physical_takeover");
    require(report.valid() && report.exit_code() == 1 && report.checks[0].ok && !report.checks[0].skipped &&
      !report.checks[1].ok && !report.checks[1].skipped && report.checks[1].detail == L"assertion_failed" &&
      report.checks[2].skipped && report.checks[2].detail == L"target_not_installed",
      "privileged.later-takeover-never-erases-completed-pass-failure-or-prerequisite-skip");
    for (size_t index = 3; index < report.checks.size(); ++index)
      require(!report.checks[index].ok && report.checks[index].skipped && report.checks[index].detail == L"physical_takeover",
        "privileged.later-takeover-skips-only-unrun-dependencies");
    report.skip_unrun(L"input_detection_unavailable");
    require(report.exit_code() == 1 && report.checks[3].detail == L"physical_takeover",
      "privileged.repeated-continuation-preserves-the-original-observed-result");
  });
  test([] {
    auto report = passed_report();
    report.checks[3] = {std::wstring(windows_privileged_checks[3]), false, false, L"dependency_failed"};
    report.skip_unrun(L"physical_takeover");
    require(report.valid() && report.exit_code() == 77 && report.checks[0].ok && report.checks[3].skipped,
      "privileged.unrun-prerequisite-skip-without-real-failure-exits77");
    report = passed_report();
    report.checks[3] = {std::wstring(windows_privileged_checks[3]), false, false, L"dependency_failed"};
    report.skip_unrun(L"private-screen-text");
    require(report.valid() && report.exit_code() == 1 && !report.checks[3].skipped && report.checks[3].detail == L"dependency_failed",
      "privileged.unknown-continuation-cannot-convert-unrun-failure-to-skip");
  });
  test([] {
    const auto report = run_windows_privileged_self_test(Command{});
    require(report.valid() && report.exit_code() == 1 && !report.checks[0].ok && !report.checks[0].skipped &&
      report.checks[0].detail == L"target_validation_failed",
      "privileged.invoked-missing-target-fails-before-artifact-or-native-work");
    Command selected{}; selected.mode = Mode::self_test; selected.self_test = L"privileged"; selected.target = L"C:\\unobserved-fixture\\tests\\computer-test-target.exe";
    const auto missing_lease = run_windows_privileged_self_test(selected);
    require(missing_lease.valid() && missing_lease.exit_code() == 1 && missing_lease.checks[0].detail == L"target_validation_failed",
      "privileged.real-invocation-cannot-forget-report-lifetime-lease");
  });
  test([] {
    bool parent_alive = true; size_t reads = 0;
    WindowsPrivilegedRunAuthority authority([&] { ++reads; return parent_alive; });
    require(!authority.current() && reads == 0 && authority.admit() && authority.current(),
      "privileged.no-mutation-authority-before-actual-parent-admission");
    parent_alive = false;
    require(!authority.current(), "privileged.final-fence-observes-parent-death-before-watcher-callback");
    parent_alive = true;
    require(!authority.current() && !authority.admit(), "privileged.lost-parent-witness-can-never-resume-or-readmit");
  });
  test([] {
    WindowsPrivilegedRunAuthority missing({});
    WindowsPrivilegedRunAuthority unknown([]() -> bool { throw std::runtime_error("private-parent-observation"); });
    require(!missing.admit() && !missing.current() && !unknown.admit() && !unknown.current(),
      "privileged.missing-or-unknown-held-parent-facts-fail-closed");
    WindowsPrivilegedRunAuthority ready([] { return true; });
    require(ready.admit(), "privileged.synthetic-observed-parent-can-be-admitted"); ready.revoke();
    require(!ready.current() && !ready.admit(), "privileged.cleanup-revokes-before-any-later-mutation-or-admission");
  });
  test([] {
    bool parent_alive = true; size_t mutations = 0;
    WindowsPrivilegedRunAuthority authority([&] { return parent_alive; }); require(authority.admit(), "privileged.synthetic-parent-admitted");
    require(authority.current(), "privileged.provider-preparation-begins-with-parent");
    parent_alive = false; // Provider preparation completes after actual parent death, before its event callback.
    if (authority.current()) ++mutations;
    require(mutations == 0, "privileged.parent-death-during-provider-preparation-prevents-native-effect");
  });
  test([] {
    auto report = passed_report(); report.checks[0].skipped = true;
    require(!report.valid() && report.exit_code() == 1, "privileged.passed-and-skipped-is-contradictory");
  });
  test([] {
    for (int change = 0; change < 6; ++change) {
      auto report = passed_report();
      if (change == 0) report.checks.clear();
      if (change == 1) report.checks.pop_back();
      if (change == 2) report.checks.push_back(report.checks.front());
      if (change == 3) std::swap(report.checks[0], report.checks[1]);
      if (change == 4) report.checks[1] = report.checks[0];
      if (change == 5) report.checks[0].name = L"private-screen-text";
      require(!report.valid() && report.exit_code() == 1, "privileged.invalid-catalog-fails-closed");
      const auto wire = report.wire().GetNamedArray(L"checks");
      require(wire.Size() == windows_privileged_checks.size(), "privileged.invalid-catalog-emits-full-failed-catalog");
      for (uint32_t index = 0; index < wire.Size(); ++index) {
        const auto entry = wire.GetObjectAt(index);
        require(entry.GetNamedString(L"name") == windows_privileged_checks[index] && !entry.GetNamedBoolean(L"ok") &&
          !entry.GetNamedBoolean(L"skipped", false), "privileged.invalid-report-never-reports-partial-success");
      }
    }
  });
  test([] {
    auto report = passed_report();
    report.checks[0].ok = false; report.checks[0].detail = L"private-screen-text";
    require(!report.valid() && report.exit_code() == 1 && !windows_privileged_reason(L"private-screen-text"),
      "privileged.private-arbitrary-details-are-not-reasons");
    const std::wstring serialized(report.wire().Stringify());
    require(serialized.find(L"private-screen-text") == std::wstring::npos, "privileged.invalid-detail-never-leaks-to-wire");
    require(!windows_privileged_reason(L"") && !windows_privileged_reason(std::wstring(129, L'a')) &&
      !windows_privileged_reason(L"assertion_failed\nprivate"), "privileged.reason-vocabulary-is-finite");
  });
  test([] {
    const auto parsed = parse_windows_target_options(target_options());
    require(parsed && parsed->parent == 42 && parsed->nonce == std::wstring(64, L'a'),
      "privileged.target-cli-binds-positive-parent-and-private-nonce");
  });
  test([] {
    for (const auto& parent : {L"0", L"042", L"-1", L"+42", L"42 ", L" 42", L"4294967296", L"18446744073709551616", L"42x", L""}) {
      auto arguments = target_options(); arguments[2] = parent;
      require(!parse_windows_target_options(arguments), "privileged.target-cli-parent-is-canonical-dword");
    }
    auto arguments = target_options(); arguments[2] = L"4294967295";
    require(parse_windows_target_options(arguments).has_value(), "privileged.target-cli-accepts-full-dword-without-overflow");
  });
  test([] {
    for (const auto& nonce : {std::wstring(63, L'a'), std::wstring(65, L'a'), std::wstring(64, L'A'),
        std::wstring(64, L'g'), std::wstring(64, L'\0'), std::wstring{}}) {
      auto arguments = target_options(); arguments[4] = nonce;
      require(!parse_windows_target_options(arguments), "privileged.target-cli-nonce-is-exact-lowercase-hex");
    }
  });
  test([] {
    for (int change = 0; change < 8; ++change) {
      auto arguments = target_options();
      if (change == 0) arguments[0] = L"--stdio";
      if (change == 1) arguments[1] = L"--target-pid";
      if (change == 2) arguments[3] = L"--command";
      if (change == 3) arguments[5] = L"--permission-prompt";
      if (change == 4) arguments.pop_back();
      if (change == 5) arguments.push_back(L"--target=C:\\unrelated.exe");
      if (change == 6) arguments.push_back(L"--isolated");
      if (change == 7) std::swap(arguments[1], arguments[3]);
      require(!parse_windows_target_options(arguments), "privileged.target-cli-cannot-select-arbitrary-commands-or-targets");
    }
  });
  test([] {
    constexpr std::array<WindowsTargetAction, 8> actions{
      WindowsTargetAction::state, WindowsTargetAction::focus_plain, WindowsTargetAction::focus_secure,
      WindowsTargetAction::focus_button, WindowsTargetAction::show_excluded, WindowsTargetAction::hide_excluded,
      WindowsTargetAction::move_window, WindowsTargetAction::quit};
    std::set<std::wstring_view> names;
    uint64_t id = 1;
    for (const auto action : actions) {
      const auto name = windows_target_action(action); names.insert(name);
      const auto parsed = parse_windows_target_control(control(id, name));
      require(!name.empty() && parsed && parsed->id == id && parsed->action == action,
        "privileged.target-control-round-trips-finite-own-view-actions");
      ++id;
    }
    require(names.size() == actions.size(), "privileged.target-control-actions-have-distinct-names");
  });
  test([] {
    for (const auto invalid : {JsonValue::CreateNumberValue(0), JsonValue::CreateNumberValue(-1),
        JsonValue::CreateNumberValue(1.5), JsonValue::CreateNumberValue(9'007'199'254'740'992.0),
        JsonValue::CreateBooleanValue(true), JsonValue::CreateStringValue(L"1"), JsonValue::Parse(L"null")}) {
      auto value = control(1, L"state"); value.Insert(L"id", invalid);
      require(!parse_windows_target_control(value), "privileged.target-control-rejects-invalid-request-ids");
    }
    require(parse_windows_target_control(control(kMaximumSafeInteger, L"state")).has_value(),
      "privileged.target-control-largest-exact-json-id");
  });
  test([] {
    for (const auto name : {L"", L"focus", L"type", L"capture", L"launch", L"permissions.request", L"C:\\unrelated.exe", L"state\n"})
      require(!parse_windows_target_control(control(1, name)), "privileged.target-control-unknown-command-refused");
    auto value = control(1, L"state"); value.Insert(L"op", JsonValue::CreateBooleanValue(true));
    require(!parse_windows_target_control(value), "privileged.target-control-command-is-string");
  });
  test([] {
    auto value = control(1, L"state"); value.Insert(L"text", JsonValue::CreateStringValue(L"private-screen-text"));
    require(!parse_windows_target_control(value), "privileged.target-control-has-no-text-payload-route");
    value = control(1, L"state"); value.Insert(L"pid", JsonValue::CreateNumberValue(999));
    require(!parse_windows_target_control(value), "privileged.target-control-cannot-retarget-another-process");
    value = control(1, L"state"); value.Remove(L"id");
    require(!parse_windows_target_control(value), "privileged.target-control-requires-id");
    value = control(1, L"state"); value.Remove(L"op");
    require(!parse_windows_target_control(value), "privileged.target-control-requires-finite-action");
  });
  test([] {
    require(valid_windows_target_state(target_state()), "privileged.private-state-accepts-bounded-observed-fixture-facts");
  });
  test([] {
    for (int change = 0; change < 5; ++change) {
      auto value = target_state();
      if (change == 0) value.pid = 0;
      if (change == 1) value.parent = 0;
      if (change == 2) value.window = nullptr;
      if (change == 3) value.excluded = nullptr;
      if (change == 4) value.excluded = value.window;
      require(!valid_windows_target_state(value), "privileged.private-state-needs-distinct-positive-process-window-facts");
    }
  });
  test([] {
    for (auto member : {&WindowsTargetState::bounds, &WindowsTargetState::patch, &WindowsTargetState::button,
        &WindowsTargetState::plain, &WindowsTargetState::secure, &WindowsTargetState::excluded_bounds}) {
      auto value = target_state(); (value.*member).width = 0;
      require(!valid_windows_target_state(value), "privileged.private-state-every-geometry-has-positive-extent");
      value = target_state(); (value.*member).height = -1;
      require(!valid_windows_target_state(value), "privileged.private-state-negative-extent-is-not-standardized");
    }
  });
  test([] {
    for (auto member : {&WindowsTargetState::patch, &WindowsTargetState::button, &WindowsTargetState::plain,
        &WindowsTargetState::secure, &WindowsTargetState::excluded_bounds}) {
      auto value = target_state(); (value.*member).x = value.bounds.x - 1;
      require(!valid_windows_target_state(value), "privileged.private-state-child-geometry-cannot-escape-main-window");
      value = target_state(); (value.*member).y = value.bounds.y + value.bounds.height;
      require(!valid_windows_target_state(value), "privileged.private-state-child-geometry-is-observed-within-window");
    }
  });
  test([] {
    for (auto member : {&WindowsTargetState::counter, &WindowsTargetState::key_downs, &WindowsTargetState::key_ups,
        &WindowsTargetState::button_downs, &WindowsTargetState::button_ups, &WindowsTargetState::held_keys,
        &WindowsTargetState::held_buttons}) {
      auto value = target_state(); value.*member = 1'000'001;
      require(!valid_windows_target_state(value), "privileged.private-state-event-counters-are-finite");
      value.*member = std::numeric_limits<uint64_t>::max();
      require(!valid_windows_target_state(value), "privileged.private-state-counter-overflow-is-not-evidence");
    }
  });
  test([] {
    for (auto member : {&WindowsTargetState::text, &WindowsTargetState::secret}) {
      auto value = target_state(); (value.*member).length = 4001;
      require(!valid_windows_target_state(value), "privileged.private-state-text-summary-length-is-bounded");
      for (const auto& invalid : {std::wstring(63, L'a'), std::wstring(65, L'a'), std::wstring(64, L'A'),
          std::wstring(64, L'g'), std::wstring(64, L'\0'), std::wstring{}}) {
        value = target_state(); (value.*member).sha256 = invalid;
        require(!valid_windows_target_state(value), "privileged.private-state-both-text-summaries-need-exact-hashes");
      }
    }
  });
  test([] {
    require(windows_target_hex(std::wstring(64, L'0'), 64) && windows_target_hex(std::wstring(64, L'f'), 64),
      "privileged.private-hex-all-lowercase-digits-are-representable");
    require(!windows_target_hex(std::wstring(63, L'0'), 64) && !windows_target_hex(std::wstring(64, L'F'), 64) &&
      !windows_target_hex(std::wstring(64, L'\0'), 64), "privileged.private-hex-never-normalizes-unknown-input");
  });
  test([] {
    const auto decoded = decode_windows_target_state(private_state());
    require(decoded && decoded->pid == 43 && decoded->parent == 42 && decoded->text == target_state().text && decoded->secret == target_state().secret,
      "privileged.private-wire-decodes-only-bounded-hash-summaries");
    for (const auto key : {L"text", L"secure"}) {
      const auto value = private_state(); value.GetNamedObject(key).Insert(L"value", JsonValue::CreateStringValue(L"unexportable private fixture"));
      require(!decode_windows_target_state(value), "privileged.private-wire-rejects-raw-field-content");
    }
    const auto extra = private_state(); extra.Insert(L"unclassified", JsonValue::CreateStringValue(L"private payload"));
    require(!decode_windows_target_state(extra), "privileged.private-wire-rejects-unknown-root-fields");
  });
  test([] {
    for (const auto key : {L"visible", L"minimized", L"foreground", L"affinity", L"excludedVisible"}) {
      const auto value = private_state(); value.Insert(key, JsonValue::CreateStringValue(L"false"));
      require(!decode_windows_target_state(value), "privileged.private-wire-does-not-coerce-desktop-booleans");
    }
    for (const auto key : {L"pid", L"parentPID"}) {
      const auto value = private_state(); value.Insert(key, JsonValue::CreateNumberValue(-1));
      require(!decode_windows_target_state(value), "privileged.private-wire-rejects-negative-process-identities");
    }
    const auto window = private_state(); window.Insert(L"windowId", JsonValue::CreateStringValue(L"0100"));
    require(!decode_windows_target_state(window), "privileged.private-wire-window-identities-are-canonical");
  });
  test([] {
    const auto geometry = private_state(); geometry.GetNamedObject(L"views").GetNamedObject(L"plain").Insert(L"x", JsonValue::CreateNumberValue(-201));
    require(!decode_windows_target_state(geometry), "privileged.private-wire-keeps-observed-controls-within-own-window");
    const auto counts = private_state(); counts.GetNamedObject(L"events").Insert(L"heldKeys", JsonValue::CreateNumberValue(257));
    require(!decode_windows_target_state(counts), "privileged.private-wire-held-counts-cannot-expand-authority");
    const auto missing = private_state(); missing.GetNamedObject(L"events").Remove(L"buttonUps");
    require(!decode_windows_target_state(missing), "privileged.private-wire-requires-complete-event-evidence");
  });
  return count;
}
}
