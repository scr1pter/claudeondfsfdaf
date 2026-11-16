#include "accessibility_registry.h"
#include <stdexcept>

namespace vector::computer {
namespace {
void require(bool condition, const char* label) { if (!condition) throw std::runtime_error(label); }
ServerSession session(uint64_t observation = 2, uint64_t run = 1, std::wstring id = L"synthetic") {
  ServerSession value; value.id = std::move(id); value.run_epoch = run; value.observation_epoch = observation; value.revision = 1; return value;
}
WindowsWindow window() {
  WindowsWindow value; value.hwnd = reinterpret_cast<HWND>(uintptr_t(100)); value.surface = value.hwnd;
  value.thread_id = 10; value.surface_thread_id = 10;
  value.owner.process.pid = 101; value.owner.process.creation_time = 20;
  value.owner.process.image.path = L"C:\\Fixture\\app.exe"; value.owner.process.image.size = 100; value.owner.process.image.id[0] = 1;
  value.owner.identity.kind = WindowsAppKind::exe; value.owner.identity.name = L"Fixture"; value.owner.identity.exe = value.owner.process.image.path;
  value.owner.identity.publisher = L"Fixture Signer"; value.owner.identity.product = L""; value.owner.identity.binary = L"app.exe";
  value.owner.identity.verified = true; value.owner.identity.pid = 101;
  value.physical_owner = value.owner; value.bounds = {-10, -20, 800, 600}; value.surface_bounds = value.bounds;
  value.visible = true; value.on_screen = true; value.cloaked = false; value.current_desktop = true; value.elevated = false; value.child_shell = false;
  value.window_class = L"FixtureWindow"; return value;
}
AccessibilityFacts facts(const WindowsWindow& window) {
  AccessibilityFacts value; value.owner = window.owner.identity;
  value.security.pid = window.owner.process.pid; value.security.control_type = 50004; value.security.role = L"Edit";
  value.security.bounds = WindowsRect{5, 10, 100, 30}; value.security.password = false; value.security.enabled = true; value.security.focused = true;
  value.security.keyboard_focusable = true; value.security.value_pattern = true; value.security.read_only = false;
  value.name = UiaName{L"Known label", true}; return value;
}
auto rng(wchar_t value = L'a') { return [value] { return std::wstring(32, value); }; }
template<class Body> void refused(Body body, std::wstring_view code = L"stale_ref") {
  try { body(); } catch (const Failure& failure) { require(failure.code == code, "accessibility-registry.wrong-refusal"); return; }
  throw std::runtime_error("accessibility-registry.missing-refusal");
}
struct Fixture {
  AccessibilityRegistry registry;
  ServerSession authority = session();
  WindowsWindow target = window();
  UiaElement root = std::make_shared<WindowsUiaElement>(1), element = std::make_shared<WindowsUiaElement>(2);
  explicit Fixture(size_t limit = 4096, size_t stable = 8192, size_t retired = 32768) : registry(limit, stable, retired, rng()) {}
  AccessibilityReference mint(bool complete = true) {
    auto content = facts(target); content.name.complete = complete;
    return registry.register_element(element, root, target, content, registry.current_snapshot(authority));
  }
};
}

size_t run_accessibility_registry_tests() {
  size_t groups = 0; const auto test = [&](const std::function<void()>& body) { body(); ++groups; };
  test([] {
    Fixture fixture; const auto first = fixture.mint(); const auto resolved = fixture.registry.resolve(first.ref, fixture.authority);
    require(resolved.ref == first.ref && resolved.element_id == first.element_id && resolved.element == fixture.element && resolved.root == fixture.root,
        "accessibility-registry.exact-native-handle-ref");
    const auto repeated = fixture.mint(); require(repeated.ref == first.ref && repeated.element_id == first.element_id, "accessibility-registry.same-snapshot-no-ref-churn");
  });
  test([] {
    Fixture fixture; const auto original = fixture.mint(); const auto next = fixture.registry.begin_snapshot(fixture.authority);
    refused([&] { static_cast<void>(fixture.registry.resolve(original.ref, fixture.authority)); });
    const auto record = fixture.registry.register_element(fixture.element, fixture.root, fixture.target, facts(fixture.target), next);
    require(record.ref != original.ref && record.element_id == original.element_id && record.generation > original.generation, "accessibility-registry.new-tree-new-ref-same-native-id");
    refused([&] { static_cast<void>(fixture.registry.receipt(original.ref, fixture.authority)); });
  });
  test([] {
    Fixture fixture; const auto snapshot = fixture.registry.current_snapshot(fixture.authority); auto forged = snapshot; forged.observation_epoch += 1;
    refused([&] { static_cast<void>(fixture.registry.register_element(fixture.element, fixture.root, fixture.target, facts(fixture.target), forged)); });
    auto successor = fixture.authority; successor.observation_epoch += 1; fixture.registry.current_snapshot(successor);
    refused([&] { static_cast<void>(fixture.registry.register_element(fixture.element, fixture.root, fixture.target, facts(fixture.target), snapshot)); });
  });
  test([] {
    Fixture fixture; const auto original = fixture.mint(); auto updated = fixture.authority; updated.observation_epoch += 1;
    refused([&] { static_cast<void>(fixture.registry.resolve(original.ref, updated)); });
    const auto receipt = fixture.registry.receipt(original.ref, updated);
    require(receipt.ref == original.ref && receipt.element == original.element, "accessibility-registry.phase-only-retains-native-receipt");
    refused([&] { static_cast<void>(fixture.registry.resolve_element(original.element_id, updated)); });
  });
  test([] {
    Fixture fixture; const auto original = fixture.mint(); fixture.registry.suspend(); auto updated = fixture.authority; updated.observation_epoch += 1; updated.revision = 2;
    const auto old = fixture.registry.receipt(original.ref, updated);
    const auto fresh = fixture.registry.refresh_receipt(old, fixture.element, fixture.root, fixture.target, facts(fixture.target), updated);
    require(fresh.ref == original.ref && fresh.element_id == original.element_id && fresh.element == original.element && fresh.generation > original.generation,
        "accessibility-registry.explicit-phase-refresh-keeps-exact-ref");
    require(fixture.registry.resolve(original.ref, updated).ref == original.ref && fixture.registry.resolve_element(original.element_id, updated).ref == original.ref,
        "accessibility-registry.refresh-reauthorizes-only-current-epoch");
    refused([&] { static_cast<void>(fixture.registry.receipt(original.ref, updated)); });
  });
  test([] {
    for (const auto change : {0, 1, 2, 3}) {
      Fixture fixture; const auto original = fixture.mint(); fixture.registry.suspend(); auto updated = fixture.authority; updated.observation_epoch += 1;
      const auto old = fixture.registry.receipt(original.ref, updated); auto content = facts(fixture.target);
      if (change == 0) content.name.text = L"Changed label";
      if (change == 1) content.security.password = true;
      if (change == 2) content.security.read_only = true;
      if (change == 3) content.security.bounds->x += 1;
      refused([&] { static_cast<void>(fixture.registry.refresh_receipt(old, fixture.element, fixture.root, fixture.target, content, updated)); });
      refused([&] { static_cast<void>(fixture.registry.resolve(original.ref, updated)); });
    }
  });
  test([] {
    Fixture fixture; const auto original = fixture.mint(); fixture.registry.suspend(); auto updated = fixture.authority; updated.observation_epoch += 1;
    const auto old = fixture.registry.receipt(original.ref, updated);
    const auto replacement = std::make_shared<WindowsUiaElement>(3);
    refused([&] { static_cast<void>(fixture.registry.refresh_receipt(old, replacement, fixture.root, fixture.target, facts(fixture.target), updated)); });
    refused([&] { static_cast<void>(fixture.registry.refresh_receipt(old, fixture.element, replacement, fixture.target, facts(fixture.target), updated)); });
  });
  test([] {
    for (const auto change : {0, 1, 2, 3, 4}) {
      Fixture fixture; const auto original = fixture.mint(); fixture.registry.suspend(); auto updated = fixture.authority; updated.observation_epoch += 1;
      const auto old = fixture.registry.receipt(original.ref, updated); auto target = fixture.target;
      if (change == 0) target.owner.process.creation_time += 1;
      if (change == 1) target.physical_owner.process.creation_time += 1;
      if (change == 2) target.bounds.x += 1;
      if (change == 3) target.on_screen = false;
      if (change == 4) target.surface = reinterpret_cast<HWND>(uintptr_t(101));
      refused([&] { static_cast<void>(fixture.registry.refresh_receipt(old, fixture.element, fixture.root, target, facts(target), updated)); });
    }
  });
  test([] {
    Fixture fixture; const auto original = fixture.mint(); auto next = fixture.authority; next.run_epoch += 1;
    refused([&] { static_cast<void>(fixture.registry.receipt(original.ref, next)); });
    fixture.registry.note_session(next);
    refused([&] { static_cast<void>(fixture.registry.resolve(original.ref, fixture.authority)); });
    const auto record = fixture.registry.register_element(fixture.element, fixture.root, fixture.target, facts(fixture.target), fixture.registry.current_snapshot(next));
    require(record.element_id != original.element_id, "accessibility-registry.reused-wire-id-new-private-run");
  });
  test([] {
    Fixture fixture; const auto original = fixture.mint(); auto changed = fixture.authority; changed.id = L"another";
    refused([&] { static_cast<void>(fixture.registry.resolve(original.ref, changed)); }); refused([&] { static_cast<void>(fixture.registry.receipt(original.ref, changed)); });
    changed = fixture.authority; changed.revision = 2; refused([&] { static_cast<void>(fixture.registry.resolve(original.ref, changed)); });
  });
  test([] {
    Fixture fixture; auto original = fixture.mint(false); fixture.registry.suspend(); auto updated = fixture.authority; updated.observation_epoch += 1;
    refused([&] { static_cast<void>(fixture.registry.receipt(original.ref, updated)); });
    auto content = facts(fixture.target); content.name.text = L"a\u202eb"; require(!content.complete(), "accessibility-registry.unsafe-name-incomplete");
    content = facts(fixture.target); content.name.text.assign(501, L'x'); require(!content.complete(), "accessibility-registry.overlength-name-incomplete");
  });
  test([] {
    Fixture fixture; auto content = facts(fixture.target); content.name.text = L"\u00e9";
    const auto original = fixture.registry.register_element(fixture.element, fixture.root, fixture.target, content, fixture.registry.current_snapshot(fixture.authority));
    fixture.registry.suspend(); auto updated = fixture.authority; updated.observation_epoch += 1; auto different = content; different.name.text = L"e\u0301";
    refused([&] { static_cast<void>(fixture.registry.refresh_receipt(fixture.registry.receipt(original.ref, updated), fixture.element, fixture.root, fixture.target, different, updated)); });
  });
  test([] {
    Fixture fixture; const auto original = fixture.mint(); fixture.registry.suspend(); auto updated = fixture.authority; updated.observation_epoch += 1;
    auto content = facts(fixture.target); content.security.focused = false;
    const auto refreshed = fixture.registry.refresh_receipt(fixture.registry.receipt(original.ref, updated), fixture.element, fixture.root, fixture.target, content, updated);
    require(refreshed.ref == original.ref, "accessibility-registry.permission-overlay-focus-is-not-value-or-owner-retarget");
  });
  test([] {
    Fixture fixture; auto content = facts(fixture.target); content.document_status = L"known"; content.document = L"C:\\Fixture\\document.txt";
    require(content.complete(), "accessibility-registry.actual-document-shape");
    const auto original = fixture.registry.register_element(fixture.element, fixture.root, fixture.target, content, fixture.registry.current_snapshot(fixture.authority));
    fixture.registry.suspend(); auto updated = fixture.authority; updated.observation_epoch += 1; auto changed = content; changed.document = L"C:\\Fixture\\another.txt";
    refused([&] { static_cast<void>(fixture.registry.refresh_receipt(fixture.registry.receipt(original.ref, updated), fixture.element, fixture.root, fixture.target, changed, updated)); });
    changed = content; changed.document_status = L"none"; require(!changed.complete(), "accessibility-registry.no-guessed-document-absence");
  });
  test([] {
    Fixture fixture; auto content = facts(fixture.target); content.menu_path = std::vector<std::wstring>{L"File", L"Export"}; content.menu_shortcut = std::vector<std::wstring>{L"Control", L"e"};
    require(content.complete(), "accessibility-registry.complete-observed-menu-facts");
    const auto original = fixture.registry.register_element(fixture.element, fixture.root, fixture.target, content, fixture.registry.current_snapshot(fixture.authority));
    fixture.registry.suspend(); auto updated = fixture.authority; updated.observation_epoch += 1; auto changed = content; changed.menu_shortcut = std::vector<std::wstring>{L"Control", L"r"};
    refused([&] { static_cast<void>(fixture.registry.refresh_receipt(fixture.registry.receipt(original.ref, updated), fixture.element, fixture.root, fixture.target, changed, updated)); });
    changed = content; changed.menu_complete = false; require(!changed.complete(), "accessibility-registry.unknown-shortcut-incomplete");
  });
  test([] {
    Fixture fixture; const auto original = fixture.mint(); auto content = facts(fixture.target); content.name.text = L"new label";
    const auto updated = fixture.registry.record_facts(original.ref, content, fixture.authority);
    require(updated.ref == original.ref && updated.facts && updated.facts->name.text == L"new label", "accessibility-registry-record-complete-facts");
    fixture.registry.suspend(); auto next = fixture.authority; next.observation_epoch += 1;
    refused([&] { static_cast<void>(fixture.registry.refresh_receipt(fixture.registry.receipt(original.ref, next), fixture.element, fixture.root, fixture.target, facts(fixture.target), next)); });
  });
  test([] {
    Fixture fixture(1, 2); const auto first = fixture.mint(); auto another = std::make_shared<WindowsUiaElement>(3);
    refused([&] { static_cast<void>(fixture.registry.register_element(another, fixture.root, fixture.target, facts(fixture.target), fixture.registry.current_snapshot(fixture.authority))); }, L"unavailable");
    fixture.registry.suspend(); auto next = fixture.authority; next.observation_epoch += 1;
    refused([&] { static_cast<void>(fixture.registry.register_element(another, fixture.root, fixture.target, facts(fixture.target), fixture.registry.current_snapshot(next))); }, L"unavailable");
    require(fixture.registry.receipt(first.ref, next).ref == first.ref, "accessibility-registry.receipts-count-against-total-limit");
  });
  test([] {
    Fixture fixture(1, 1); const auto original = fixture.mint(); fixture.registry.suspend(); auto next = fixture.authority; next.observation_epoch += 1;
    const auto tree = fixture.registry.begin_snapshot(next); auto other = std::make_shared<WindowsUiaElement>(3);
    const auto current = fixture.registry.register_element(other, fixture.root, fixture.target, facts(fixture.target), tree);
    require(current.element_id != original.element_id, "accessibility-registry.new-native-element-has-new-stable-id");
    refused([&] { static_cast<void>(fixture.registry.receipt(original.ref, next)); }); refused([&] { static_cast<void>(fixture.registry.resolve_element(original.element_id, next)); });
  });
  test([] {
    Fixture fixture; const auto original = fixture.mint(); fixture.registry.clear(); refused([&] { static_cast<void>(fixture.registry.resolve(original.ref, fixture.authority)); });
    refused([&] { static_cast<void>(fixture.registry.receipt(original.ref, fixture.authority)); });
    const auto replacement = fixture.mint(); require(replacement.ref != original.ref && replacement.element_id != original.element_id, "accessibility-registry.hard-clear-no-resurrection");
    fixture.registry.close(); fixture.registry.note_session(fixture.authority); refused([&] { static_cast<void>(fixture.registry.current_snapshot(fixture.authority)); });
  });
  test([] {
    Fixture fixture; size_t destroyed = 0;
    UiaElement value(new WindowsUiaElement(200), [&](auto* item) { ++destroyed; delete item; });
    auto record = fixture.registry.register_element(value, fixture.root, fixture.target, facts(fixture.target), fixture.registry.current_snapshot(fixture.authority));
    value.reset(); record.element.reset(); fixture.registry.clear(); require(destroyed == 0, "accessibility-registry.metadata-clear-defers-native-destruction");
    auto retired = fixture.registry.drain_retired(); require(destroyed == 0 && !retired.empty(), "accessibility-registry.retirement-drain-transfers-ownership");
    retired.clear(); require(destroyed == 1, "accessibility-registry.caller-releases-retired-native-handle-outside-authority");
  });
  test([] {
    Fixture fixture(2, 2, 2); const auto original = fixture.mint(); fixture.registry.clear();
    refused([&] { static_cast<void>(fixture.mint()); }, L"unavailable");
    auto retired = fixture.registry.drain_retired(); retired.clear(); const auto renewed = fixture.mint();
    require(renewed.ref != original.ref && renewed.element_id != original.element_id, "accessibility-registry.retirement-debt-caps-new-handles");
  });
  test([] {
    Fixture left; AccessibilityRegistry right(4096, 8192, 32768, rng(L'b'));
    const auto original = left.mint();
    refused([&] { static_cast<void>(right.resolve(original.ref, left.authority)); });
    auto snapshot = left.registry.current_snapshot(left.authority);
    refused([&] { static_cast<void>(right.register_element(left.element, left.root, left.target, facts(left.target), snapshot)); });
  });
  test([] {
    Fixture fixture; const auto original = fixture.mint(); fixture.registry.note_session(std::nullopt);
    refused([&] { static_cast<void>(fixture.registry.receipt(original.ref, fixture.authority)); });
    auto malformed = fixture.authority; malformed.run_epoch = 0;
    refused([&] { static_cast<void>(fixture.registry.current_snapshot(malformed)); });
  });
  test([] {
    Fixture fixture; auto malformed = fixture.target; malformed.owner.process.image.path.clear(); malformed.owner.identity.exe.clear();
    refused([&] { static_cast<void>(fixture.registry.register_element(fixture.element, fixture.root, malformed, facts(malformed), fixture.registry.current_snapshot(fixture.authority))); });
    malformed = fixture.target; malformed.physical_owner.process.creation_time = 0;
    refused([&] { static_cast<void>(fixture.registry.register_element(fixture.element, fixture.root, malformed, facts(malformed), fixture.registry.current_snapshot(fixture.authority))); });
  });
  test([] {
    Fixture fixture; auto content = facts(fixture.target);
    require(content.complete() && content.security.editable(), "accessibility-registry.known-value-editability");
    content.security.value_pattern = false; content.security.read_only.reset();
    require(content.complete() && !content.security.editable(), "accessibility-registry.no-text-pattern-is-not-editable");
    content.security.text_pattern = true;
    require(!content.complete() && !content.security.editable(), "accessibility-registry.unknown-text-readonly-is-not-editable");
    content.security.text_read_only = false;
    require(content.complete() && content.security.editable(), "accessibility-registry.text-only-known-editability");
    content.security.text_read_only = true;
    require(content.complete() && !content.security.editable(), "accessibility-registry.known-readonly-text-is-complete");
  });
  test([] {
    Fixture fixture; auto content = facts(fixture.target); content.security.text_pattern = true; content.security.text_read_only = false;
    require(content.complete() && content.security.editable(), "accessibility-registry.both-patterns-explicitly-editable");
    content.security.read_only = true;
    require(content.complete() && !content.security.editable(), "accessibility-registry.value-readonly-dominates-text-editable");
    content.security.read_only = false; content.security.text_read_only = true;
    require(content.complete() && !content.security.editable(), "accessibility-registry.text-readonly-dominates-value-editable");
    content.security.text_read_only.reset();
    require(!content.complete() && !content.security.editable(), "accessibility-registry.mixed-unknown-pattern-is-not-editable");
    content = facts(fixture.target); content.security.text_read_only = false;
    require(!content.complete(), "accessibility-registry.absent-text-pattern-rejects-stray-proof");
    content = facts(fixture.target); content.security.value_pattern = false;
    require(!content.complete(), "accessibility-registry.absent-value-pattern-rejects-stray-proof");
  });
  test([] {
    for (const auto change : {0, 1, 2}) {
      Fixture fixture; auto content = facts(fixture.target); content.security.text_pattern = true; content.security.text_read_only = false;
      const auto original = fixture.registry.register_element(fixture.element, fixture.root, fixture.target, content, fixture.registry.current_snapshot(fixture.authority));
      fixture.registry.suspend(); auto updated = fixture.authority; updated.observation_epoch += 1;
      auto changed = content;
      if (change == 0) { changed.security.text_pattern = false; changed.security.text_read_only.reset(); }
      if (change == 1) changed.security.text_read_only = true;
      if (change == 2) changed.security.text_read_only.reset();
      require(!same_accessibility_facts(content, changed), "accessibility-registry.text-pattern-facts-are-exact");
      refused([&] { static_cast<void>(fixture.registry.refresh_receipt(fixture.registry.receipt(original.ref, updated), fixture.element, fixture.root, fixture.target, changed, updated)); });
    }
  });
  test([] {
    Fixture fixture; auto content = facts(fixture.target); content.security.value_pattern = false; content.security.read_only.reset();
    content.security.text_pattern = true; content.security.text_read_only = false;
    const auto original = fixture.registry.register_element(fixture.element, fixture.root, fixture.target, content, fixture.registry.current_snapshot(fixture.authority));
    fixture.registry.suspend(); auto updated = fixture.authority; updated.observation_epoch += 1;
    const auto refreshed = fixture.registry.refresh_receipt(fixture.registry.receipt(original.ref, updated), fixture.element, fixture.root, fixture.target, content, updated);
    require(refreshed.ref == original.ref && refreshed.element_id == original.element_id && refreshed.facts && refreshed.facts->security.editable(),
        "accessibility-registry.text-only-receipt-preserves-exact-native-authority");
  });
  return groups;
}
}
