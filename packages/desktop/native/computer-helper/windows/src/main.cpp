#include "core.h"
#include <shellapi.h>
#include <winrt/base.h>

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
  using namespace vector::computer;
  try {
    int count = 0;
    auto argv = CommandLineToArgvW(GetCommandLineW(), &count);
    if (!argv) return 2;
    std::vector<std::wstring> arguments;
    for (int index = 1; index < count; ++index) arguments.emplace_back(argv[index]);
    LocalFree(argv);
    const auto command = parse_command(arguments);
    if (!command) { write_utf8(GetStdHandle(STD_ERROR_HANDLE), "Invalid computer helper arguments.\n"); return 2; }
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    return run_command(*command, GetStdHandle(STD_OUTPUT_HANDLE), GetStdHandle(STD_ERROR_HANDLE));
  } catch (...) {
    write_utf8(GetStdHandle(STD_ERROR_HANDLE), "The computer helper could not start safely.\n");
    return 1;
  }
}
