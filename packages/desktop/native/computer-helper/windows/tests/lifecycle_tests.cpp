#include "lifecycle.h"
#include <limits>
#include <stdexcept>

namespace vector::computer {
void lifecycle_tests() {
  const auto require = [](bool condition, const char* label) { if (!condition) throw std::runtime_error(label); };
  require(lifecycle_exit_budget_ms < 1000, "lifecycle.cleanup-fuse-inside-one-second");
  require(!lifecycle_exit_due(100, 100, false), "lifecycle.no-immediate-hard-kill");
  require(!lifecycle_exit_due(100, 849, false), "lifecycle.cleanup-grace-retained");
  require(lifecycle_exit_due(100, 850, false) && lifecycle_exit_due(100, 851, false), "lifecycle.hard-exit-deadline");
  require(!lifecycle_exit_due(100, 1000, true), "lifecycle.only-actual-process-exit-retires-fuse");
  require(!lifecycle_exit_due(100, 99, false), "lifecycle.clock-underflow-refused");
  constexpr auto end = std::numeric_limits<std::uint64_t>::max();
  require(lifecycle_exit_due(end - 750, end, false), "lifecycle.deadline-no-addition-overflow");
  require(lifecycle_exit_code(StopReason::eof) == 0 && lifecycle_exit_code(StopReason::parent_died) == 0 &&
          lifecycle_exit_code(StopReason::shutdown) == 0, "lifecycle.clean-lifetime-exits");
  require(lifecycle_exit_code(StopReason::parent_changed) == 1 && lifecycle_exit_code(StopReason::transport_error) == 1,
          "lifecycle.identity-and-transport-failures");
}
}
