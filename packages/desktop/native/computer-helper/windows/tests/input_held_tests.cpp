#include "input_held.h"
#include <stdexcept>

namespace vector::computer {
namespace {
void check(bool value, const char* label) { if (!value) throw std::runtime_error(label); }
template<class Body> void refuses(const wchar_t* code, Body body) {
  try { body(); } catch (const Failure& failure) {
    check(failure.code == code, "held.refusal-category"); return;
  }
  throw std::runtime_error("held.refusal-missing");
}
InputRelease key(WORD value = 'A', WORD scan = 0x1e) { return {InputReleaseKind::scan_key, value, scan, false, 0}; }
InputRelease unicode(WORD unit = 0x03c0) { return {InputReleaseKind::unicode_key, VK_PACKET, unit, false, 0}; }
InputRelease button(uint8_t value = 0) { return {InputReleaseKind::mouse_button, 0, 0, false, value}; }
InputPostResult accepted() { return InputPostResult::accepted; }
}

// Only synthetic posts, release callbacks and clocks run. No native input or guardian is constructed.
size_t run_input_held_tests() {
  size_t groups = 0;
  const auto test = [&](const auto& body) { body(); ++groups; };
  test([] {
    InputHeldJournal journal([](const auto&) { return true; }); const auto lease = journal.begin();
    check(journal.current(lease) && !journal.pending(lease) && journal.owned().empty(), "held.begin-has-no-up-authority");
    for (int field = 0; field < 3; ++field) {
      auto other = lease;
      if (field == 0) ++other.worker;
      if (field == 1) ++other.generation;
      if (field == 2) ++other.sequence;
      check(!journal.current(other), "held.all-private-lease-fields-are-bound");
      refuses(L"changed", [&] { journal.post(other, accepted); });
    }
    check(journal.current(lease), "held.forged-lease-does-not-revoke-owner");
  });
  test([] {
    InputHeldJournal journal([](const auto&) { return true; }); const auto old = journal.begin(), next = journal.begin();
    check(old != next && !journal.current(old) && journal.current(next), "held.empty-new-operation-retires-old-lease");
    refuses(L"changed", [&] { journal.press(old, L"old", key(), accepted); });
    check(journal.release(old) == 0 && journal.current(next), "held.stale-empty-release-does-not-revoke-successor");
  });
  test([] {
    std::vector<InputRelease> ups; InputHeldJournal journal([&](const auto& up) { ups.push_back(up); return true; });
    const auto lease = journal.begin();
    check(journal.press(lease, L"actual-ticket", key(), accepted) == InputPostResult::accepted &&
          journal.owned() == std::vector{key()} && journal.pending(lease) && ups.empty(), "held.accepted-down-retains-only-matching-up");
    check(journal.release(lease) == 1 && ups == std::vector{key()} && !journal.pending(lease) &&
          !journal.current(lease) && journal.release(lease) == 0, "held.cleanup-is-owned-and-once");
  });
  test([] {
    std::vector<InputRelease> ups; InputHeldJournal journal([&](const auto& up) { ups.push_back(up); return true; });
    const auto lease = journal.begin();
    journal.press(lease, L"modifier", key(VK_CONTROL, 0x1d), accepted);
    journal.press(lease, L"button", button(), accepted); journal.press(lease, L"unicode", unicode(), accepted);
    check(journal.release_all() == 3 && ups == std::vector{unicode(), button(), key(VK_CONTROL, 0x1d)},
          "held.cleanup-reverses-only-owned-down-order");
  });
  test([] {
    size_t ups = 0; InputHeldJournal journal([&](const auto&) { ++ups; return true; }); const auto lease = journal.begin();
    check(journal.press(lease, L"uncertain", key(), [] { return InputPostResult::uncertain; }) == InputPostResult::uncertain,
          "held.uncertain-outcome-is-retained");
    check(journal.owned().empty() && journal.pending(lease) && !journal.lift(lease, L"uncertain") &&
          journal.release_all() == 0 && ups == 0, "held.reservation-never-authorizes-parent-up");
    refuses(L"unavailable", [&] { journal.begin(); });
    check(journal.observed_release(lease, L"uncertain", key()) && !journal.pending(lease) && ups == 0,
          "held.only-independent-actual-up-can-retire-uncertainty");
    check(journal.current(journal.begin()), "held.observed-cleanup-unblocks-successor");
  });
  test([] {
    size_t ups = 0; InputHeldJournal journal([&](const auto&) { ++ups; return true; }); const auto lease = journal.begin();
    const auto result = journal.press(lease, L"thrown-native-outcome", key(), []() -> InputPostResult {
      throw std::runtime_error("synthetic-native-uncertainty");
    });
    check(result == InputPostResult::uncertain && journal.release(lease) == 0 && journal.pending(lease) && ups == 0,
          "held.throwing-down-never-fabricates-up-authority");
    refuses(L"unavailable", [&] { journal.begin(); });
    check(journal.observed_release(lease, L"thrown-native-outcome", key()), "held.throwing-down-keeps-exact-cleanup-receipt");
  });
  test([] {
    size_t ups = 0; InputHeldJournal journal([&](const auto&) { ++ups; return true; }); const auto lease = journal.begin();
    check(journal.press(lease, L"not-posted", key(), [] { return InputPostResult::not_posted; }) == InputPostResult::not_posted &&
          !journal.pending(lease) && journal.owned().empty() && ups == 0, "held.definitive-no-post-removes-reservation");
    journal.press(lease, L"not-posted", key(), accepted);
    check(journal.lift(lease, L"not-posted") && ups == 1 && journal.current(lease), "held.no-post-does-not-poison-later-real-down");
  });
  test([] {
    size_t posts = 0; InputHeldJournal journal([](const auto&) { return true; }); const auto lease = journal.begin();
    const auto post = [&] { ++posts; return InputPostResult::accepted; };
    journal.press(lease, L"ticket-one", key(), post);
    refuses(L"failed", [&] { journal.press(lease, L"ticket-one", unicode(), post); });
    refuses(L"failed", [&] { journal.press(lease, L"other-ticket", key(), post); });
    check(posts == 1 && journal.owned() == std::vector{key()}, "held.duplicate-ticket-or-release-cannot-post-again");
  });
  test([] {
    InputHeldJournal journal([](const auto&) { return true; }); const auto lease = journal.begin(); size_t posts = 0;
    const auto post = [&] { ++posts; return InputPostResult::accepted; };
    refuses(L"failed", [&] { journal.press(lease, L"", key(), post); });
    refuses(L"failed", [&] { journal.press(lease, std::wstring(257, L'a'), key(), post); });
    refuses(L"failed", [&] { journal.press(lease, L"invalid-descriptor", InputRelease{}, post); });
    refuses(L"failed", [&] { journal.press(lease, L"absent-post", key(), {}); });
    check(posts == 0 && !journal.pending(lease), "held.invalid-reservations-never-reach-post");
    journal.press(lease, std::wstring(256, L'a'), key(), accepted);
    check(journal.release(lease) == 1, "held.exact-private-id-limit-is-accepted");
  });
  test([] {
    size_t posts = 0; InputHeldJournal journal([](const auto&) { return true; }); const auto lease = journal.begin();
    for (WORD unit = 1; unit <= 128; ++unit) journal.press(lease, L"key-" + std::to_wstring(unit), unicode(unit), [&] {
      ++posts; return InputPostResult::accepted;
    });
    refuses(L"unavailable", [&] { journal.press(lease, L"over-key-cap", unicode(129), accepted); });
    for (uint8_t value = 0; value < 3; ++value) journal.press(lease, L"button-" + std::to_wstring(value), button(value), accepted);
    check(posts == 128 && journal.owned().size() == 131 && journal.release_all() == 131,
          "held.key-cap-is-independent-of-explicit-supported-buttons");
  });
  test([] {
    bool allow = false; size_t attempts = 0;
    InputHeldJournal journal([&](const auto&) { ++attempts; return allow; }); const auto lease = journal.begin();
    journal.press(lease, L"failed-up", key(), accepted);
    check(!journal.lift(lease, L"failed-up") && journal.pending(lease) && journal.owned() == std::vector{key()},
          "held.failed-up-keeps-actual-owned-down");
    check(journal.release(lease) == 0 && !journal.current(lease), "held.failed-release-revokes-normal-posting");
    refuses(L"unavailable", [&] { journal.begin(); });
    allow = true;
    check(journal.release_all() == 1 && attempts == 3 && !journal.pending(lease), "held.cleanup-can-retry-only-owned-up");
    check(journal.current(journal.begin()), "held.successful-cleanup-unblocks-new-input");
  });
  test([] {
    bool throwing = true; InputHeldJournal journal([&](const auto&) {
      if (throwing) throw std::runtime_error("synthetic-release-failure"); return true;
    }); const auto lease = journal.begin(); journal.press(lease, L"owned", key(), accepted);
    check(journal.release_all() == 0 && journal.pending(lease), "held.throwing-up-retains-cleanup-obligation");
    refuses(L"unavailable", [&] { journal.begin(); });
    throwing = false; check(journal.release_all() == 1, "held.throwing-up-does-not-strand-journal-state");
  });
  test([] {
    size_t ups = 0; InputHeldJournal journal([&](const auto&) { ++ups; return true; }); const auto lease = journal.begin();
    journal.press(lease, L"guardian-ticket", key(), [] { return InputPostResult::uncertain; });
    for (int field = 0; field < 6; ++field) {
      auto wrong_lease = lease; auto wrong_up = key(); std::wstring id = L"guardian-ticket";
      if (field == 0) ++wrong_lease.worker;
      if (field == 1) ++wrong_lease.generation;
      if (field == 2) ++wrong_lease.sequence;
      if (field == 3) ++wrong_up.virtual_key;
      if (field == 4) ++wrong_up.scan;
      if (field == 5) wrong_up.extended = true;
      check(!journal.observed_release(wrong_lease, id, wrong_up) && journal.pending(lease),
            "held.actual-up-receipt-requires-exact-ticket-lease-and-descriptor");
    }
    check(journal.observed_release(lease, L"guardian-ticket", key()) && !journal.pending(lease) && ups == 0,
          "held.exact-observed-up-retires-without-parent-injection");
  });
  test([] {
    size_t ups = 0; InputHeldJournal journal([&](const auto&) { ++ups; return true; }); const auto old = journal.begin();
    journal.press(old, L"same-private-id", key(), accepted); check(journal.release(old) == 1, "held.first-operation-cleaned");
    const auto next = journal.begin(); journal.press(next, L"same-private-id", key(), accepted);
    check(!journal.observed_release(old, L"same-private-id", key()) && journal.pending(next),
          "held.old-observed-up-cannot-retire-successor");
    check(journal.lift(old, L"same-private-id") && journal.release(old) == 0 && journal.current(next) && ups == 1,
          "held.stale-cleanup-cannot-post-successor-up");
    check(journal.release(next) == 1 && ups == 2, "held.successor-retains-own-release");
  });
  test([] {
    InputHeldJournal first([](const auto&) { return true; }), second([](const auto&) { return true; });
    const auto left = first.begin(), right = second.begin(); second.press(right, L"ticket", key(), accepted);
    check(left.worker != right.worker && !second.current(left) && !second.observed_release(left, L"ticket", key()) &&
          second.release(left) == 0 && second.pending(right), "held.worker-lineage-prevents-cross-journal-cleanup");
    refuses(L"changed", [&] { second.post(left, accepted); });
    check(second.release(right) == 1, "held.cross-worker-refusal-preserves-actual-owner");
  });
  test([] {
    size_t ups = 0; InputHeldJournal journal([&](const auto&) { ++ups; return true; }); const auto lease = journal.begin();
    for (size_t repeat = 0; repeat < 4; ++repeat) {
      const auto id = L"distinct-actual-ticket-" + std::to_wstring(repeat);
      journal.press(lease, id, key(), accepted);
      check(journal.lift(lease, id) && journal.current(lease) && !journal.pending(lease), "held.repeat-lifts-preserve-whole-operation-lease");
    }
    check(ups == 4 && journal.release(lease) == 0 && !journal.current(lease), "held.repeat-cleanup-never-duplicates-completed-up");
  });
  test([] {
    std::vector<InputRelease> ups; InputHeldJournal journal([&](const auto& up) { ups.push_back(up); return true; });
    const auto lease = journal.begin(); journal.press(lease, L"modifier", key(VK_CONTROL, 0x1d), accepted);
    journal.press(lease, L"letter", key(), accepted);
    check(journal.lift(lease, L"letter") && journal.current(lease) && journal.pending(lease) &&
          journal.owned() == std::vector{key(VK_CONTROL, 0x1d)}, "held.lift-only-releases-one-owned-member");
    check(journal.release(lease) == 1 && ups == std::vector{key(), key(VK_CONTROL, 0x1d)}, "held.final-release-retains-modifier-order");
  });
  test([] {
    size_t posts = 0; InputHeldJournal journal([](const auto&) { return true; }); const auto lease = journal.begin();
    journal.press(lease, L"held", key(), accepted);
    journal.post(lease, [&] { ++posts; return InputPostResult::accepted; });
    for (const auto outcome : {InputPostResult::not_posted, InputPostResult::uncertain})
      refuses(L"failed", [&] { journal.post(lease, [&] { ++posts; return outcome; }); });
    refuses(L"failed", [&] { journal.post(lease, {}); });
    check(posts == 3 && journal.current(lease) && journal.owned() == std::vector{key()},
          "held.non-held-event-failure-cannot-create-or-retire-an-up");
    check(journal.release(lease) == 1, "held.non-held-event-failure-preserves-owned-cleanup");
  });
  test([] {
    size_t ups = 0; InputHeldJournal journal([&](const auto&) { ++ups; return true; }); const auto lease = journal.begin();
    refuses(L"changed", [&] { journal.press(lease, L"in-flight", key(), [&] {
      check(journal.release_all() == 0, "held.stop-before-return-cannot-up-unconfirmed-down"); return InputPostResult::accepted;
    }); });
    check(ups == 1 && !journal.pending(lease) && !journal.current(lease), "held.late-accepted-down-is-immediately-cleaned-after-stop");
    check(journal.current(journal.begin()), "held.reentrant-stop-leaves-no-late-owned-input");
  });
  test([] {
    size_t ups = 0; InputHeldJournal journal([&](const auto&) { ++ups; return true; }); const auto lease = journal.begin();
    const auto result = journal.press(lease, L"in-flight", key(), [&] {
      journal.release_all(); return InputPostResult::not_posted;
    });
    check(result == InputPostResult::not_posted && ups == 0 && !journal.pending(lease) && !journal.current(lease),
          "held.reentrant-stop-plus-no-post-never-injects-up");
  });
  test([] {
    size_t ups = 0; InputHeldJournal journal([&](const auto&) { ++ups; return true; }); const auto lease = journal.begin();
    const auto result = journal.press(lease, L"in-flight", key(), [&] {
      journal.release_all(); return InputPostResult::uncertain;
    });
    check(result == InputPostResult::uncertain && ups == 0 && journal.pending(lease) && !journal.current(lease),
          "held.reentrant-stop-plus-uncertainty-remains-guardian-only");
    refuses(L"unavailable", [&] { journal.begin(); });
    check(journal.observed_release(lease, L"in-flight", key()), "held.late-actual-up-can-complete-reentrant-uncertainty");
  });
  test([] {
    size_t ups = 0; InputHeldJournal journal([&](const auto&) { ++ups; return true; }); const auto lease = journal.begin();
    refuses(L"changed", [&] { journal.press(lease, L"closing", key(), [&] {
      check(journal.close() == 0, "held.close-cannot-up-not-yet-confirmed-down"); return InputPostResult::accepted;
    }); });
    check(ups == 1 && !journal.pending(lease) && journal.close() == 0, "held.close-cleans-late-accepted-down-once");
    refuses(L"unavailable", [&] { journal.begin(); });
  });
  test([] {
    InputHeldJournal journal([](const auto&) { return true; }); const auto lease = journal.begin(); size_t posts = 0;
    refuses(L"changed", [&] { journal.post(lease, [&] {
      ++posts; journal.release_all(); return InputPostResult::accepted;
    }); });
    refuses(L"changed", [&] { journal.post(lease, [&] { ++posts; return InputPostResult::accepted; }); });
    check(posts == 1 && journal.owned().empty(), "held.reentrant-stop-fences-following-move-or-scroll");
  });
  test([] {
    size_t ups = 0; InputHeldJournal* journal_pointer = nullptr; bool reenter = true;
    InputHeldJournal journal([&](const auto&) {
      ++ups;
      if (reenter) {
        reenter = false; check(journal_pointer->release_all() == 0, "held.reentrant-release-does-not-double-drain");
        refuses(L"unavailable", [&] { journal_pointer->begin(); });
      }
      return true;
    }); journal_pointer = &journal; const auto lease = journal.begin();
    journal.press(lease, L"one", key(), accepted); journal.press(lease, L"two", unicode(), accepted);
    check(journal.lift(lease, L"two") && ups == 1 && journal.pending(lease) && !journal.current(lease),
          "held.reentrant-up-stop-revokes-posting-without-losing-sibling");
    check(journal.release_all() == 1 && ups == 2, "held.reentrant-up-cleanup-can-finish-retained-sibling");
  });
  test([] {
    size_t ups = 0; InputHeldJournal journal([&](const auto&) { ++ups; return true; }, [] { return 100ULL; });
    const auto lease = journal.begin(); journal.press(lease, L"owned", key(), accepted);
    check(journal.release(lease, 0) == 0 && ups == 0 && journal.pending(lease) && !journal.current(lease),
          "held.zero-budget-revokes-without-unbounded-cleanup");
    check(journal.release_all() == 1 && ups == 1, "held.zero-budget-keeps-owned-up-for-later-cleanup");
  });
  test([] {
    uint64_t now = 100; std::vector<InputRelease> ups;
    InputHeldJournal journal([&](const auto& up) { ups.push_back(up); now += 100; return true; }, [&] { return now; });
    const auto lease = journal.begin(); journal.press(lease, L"one", key(), accepted);
    journal.press(lease, L"two", unicode(), accepted); journal.press(lease, L"three", button(), accepted);
    check(journal.release(lease, 100) == 1 && ups == std::vector{button()} && journal.pending(lease),
          "held.deadline-stops-between-owned-ups");
    refuses(L"unavailable", [&] { journal.begin(); });
    check(journal.release_all() == 2 && ups == std::vector{button(), unicode(), key()}, "held.deadline-retains-remaining-cleanup-order");
  });
  test([] {
    uint64_t now = 100; size_t ups = 0;
    InputHeldJournal journal([&](const auto&) { ++ups; now += 150; return true; }, [&] { return now; });
    const auto lease = journal.begin(); journal.press(lease, L"one", key(), accepted);
    journal.press(lease, L"two", unicode(), accepted); journal.press(lease, L"three", button(), accepted);
    check(journal.release_all(10000) == 2 && ups == 2 && journal.pending(lease), "held.cleanup-budget-is-capped-at-300ms");
    check(journal.release_all() == 1 && ups == 3, "held.capped-cleanup-retains-final-owned-up");
  });
  test([] {
    size_t ticks = 0, ups = 0; bool rewind = true;
    InputHeldJournal journal([&](const auto&) { ++ups; return true; }, [&] {
      if (!rewind) return uint64_t{100}; return ++ticks == 1 ? uint64_t{100} : uint64_t{99};
    }); const auto lease = journal.begin(); journal.press(lease, L"owned", key(), accepted);
    check(journal.release_all() == 0 && ups == 0 && journal.pending(lease), "held.nonmonotonic-clock-stops-cleanup");
    rewind = false; check(journal.release_all() == 1, "held.clock-refusal-does-not-forget-owned-down");
  });
  test([] {
    bool broken_clock = true; size_t ups = 0;
    InputHeldJournal journal([&](const auto&) { ++ups; return true; }, [&]() -> uint64_t {
      if (broken_clock) throw std::runtime_error("synthetic-clock-failure"); return 100;
    }); const auto lease = journal.begin(); journal.press(lease, L"owned", key(), accepted);
    check(journal.release_all() == 0 && ups == 0 && journal.pending(lease), "held.clock-failure-preserves-cleanup-obligation");
    broken_clock = false; check(journal.release_all() == 1, "held.cleanup-lock-resets-after-clock-failure");
  });
  test([] {
    bool allow = false; size_t ups = 0; InputHeldJournal journal([&](const auto&) { ++ups; return allow; });
    const auto lease = journal.begin(); journal.press(lease, L"owned", key(), accepted);
    check(journal.close() == 0 && journal.pending(lease) && !journal.current(lease), "held.closed-journal-keeps-failed-owned-cleanup");
    refuses(L"unavailable", [&] { journal.begin(); });
    allow = true; check(journal.close() == 1 && journal.close() == 0 && ups == 2 && !journal.pending(lease),
                        "held.repeated-close-retries-only-retained-up-and-is-otherwise-idempotent");
  });
  test([] {
    size_t ups = 0; InputHeldJournal* journal_pointer = nullptr; InputHeldLease lease;
    InputHeldJournal journal([&](const auto&) {
      ++ups;
      refuses(L"changed", [&] { journal_pointer->press(lease, L"illegal-reentry", unicode(), accepted); });
      return true;
    }); journal_pointer = &journal; lease = journal.begin(); journal.press(lease, L"owned", key(), accepted);
    check(journal.release(lease) == 1 && ups == 1 && journal.owned().empty(), "held.release-callback-cannot-authorize-new-down");
  });
  test([] {
    refuses(L"unavailable", [] { InputHeldJournal absent({}); });
    InputHeldJournal journal([](const auto&) { return true; }); const auto lease = journal.begin();
    check(journal.observed_release(lease, L"already-absent", key()) && journal.lift(lease, L"already-absent") &&
          !journal.pending(lease), "held.absent-owned-cleanup-is-idempotent-without-posting");
  });
  return groups;
}
}
