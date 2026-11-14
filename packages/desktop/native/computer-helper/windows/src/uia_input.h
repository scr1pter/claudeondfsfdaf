#pragma once
#include "input.h"
#include "uia_native.h"

namespace vector::computer {
struct UiaInputWitness final : InputElementWitness {
  UiaObservation observation;
  uint64_t run_epoch = 0, observation_epoch = 0;
  std::wstring session_id;
  std::optional<uint64_t> revision;
  UiaInputWitness(UiaObservation value, const ServerSession& session) : observation(std::move(value)),
    run_epoch(session.run_epoch), observation_epoch(session.observation_epoch), session_id(session.id), revision(session.revision) {}
};
using UiaInputBinding = std::function<void(const UiaObservation&, const InputExpectedTarget&, const ServerSession&)>;
// No input text/name/value is read. Optional ref binding is supplied only by the shared W5 registry.
InputObservationProvider uia_input_provider(WindowsUiaBackend backend = WindowsUiaBackend::system(),
                                           UiaInputBinding binding = {}, std::function<uint64_t()> now = {}, InputKeyTextRules rules = {});
std::optional<std::vector<InputMenuShortcut>> parse_uia_menu_shortcuts(const std::vector<UiaMenuShortcut>&,
                                                                    const InputKeyTextRules& rules = {});
size_t run_uia_input_tests();
}
