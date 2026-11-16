#include "overlay_driver.h"
#include "input_guardian.h"
#include "capture_worker.h"
#include <shellapi.h>

// Never shipped. The normal helper's serving/command parser is deliberately absent from this entry.
int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
  try {
    int count = 0; auto raw = CommandLineToArgvW(GetCommandLineW(), &count); if (!raw) return 2;
    std::vector<std::wstring> arguments;
    for (int index = 1; index < count; ++index) arguments.emplace_back(raw[index]);
    LocalFree(raw);
    if (const auto capture = vector::computer::parse_capture_worker(arguments))
      return vector::computer::run_capture_worker(*capture);
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    if (const auto guardian = vector::computer::parse_input_guardian(arguments))
      return vector::computer::run_input_guardian(*guardian, GetStdHandle(STD_INPUT_HANDLE), GetStdHandle(STD_OUTPUT_HANDLE));
    const auto options = vector::computer::parse_overlay_driver_options(arguments); if (!options) return 2;
    return vector::computer::run_overlay_driver(*options, GetStdHandle(STD_INPUT_HANDLE), GetStdHandle(STD_OUTPUT_HANDLE));
  } catch (...) { return 1; }
}
