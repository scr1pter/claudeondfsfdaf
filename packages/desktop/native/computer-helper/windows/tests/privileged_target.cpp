#include "privileged_target.h"
#include "core.h"
#include <shellapi.h>

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
  try {
    int count = 0;
    auto raw = CommandLineToArgvW(GetCommandLineW(), &count);
    if (!raw) return 2;
    std::vector<std::wstring> arguments;
    for (int index = 1; index < count; ++index) arguments.emplace_back(raw[index]);
    LocalFree(raw);
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    if (arguments == std::vector<std::wstring>{L"--self-test=control"}) {
      const auto report = vector::computer::windows_target_control_report();
      const bool passed = report.GetNamedArray(L"checks").GetObjectAt(0).GetNamedBoolean(L"ok");
      return vector::computer::write_utf8(GetStdHandle(STD_OUTPUT_HANDLE), winrt::to_string(report.Stringify()) + "\n") && passed ? 0 : 1;
    }
    const auto options = vector::computer::parse_windows_target_options(arguments);
    if (!options) return 2;
    return vector::computer::run_windows_target(*options, GetStdHandle(STD_INPUT_HANDLE), GetStdHandle(STD_OUTPUT_HANDLE));
  } catch (...) { return 1; }
}
