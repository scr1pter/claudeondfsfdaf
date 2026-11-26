#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#ifndef PROC_THREAD_ATTRIBUTE_JOB_LIST
#error A Windows SDK with atomic job assignment is required.
#endif

namespace {
constexpr DWORD kConfigBytes = 524288;
constexpr DWORD kStartupMs = 15000;
constexpr DWORD kAcknowledgmentMs = 10000;
constexpr DWORD kCleanupMs = 3000;
constexpr DWORD kPollMs = 10;
constexpr DWORD kCommandLineUnits = 32766;
constexpr size_t kEnvironmentUnits = 65536;
constexpr size_t kControlBytes = 128;
constexpr std::string_view kResume = R"({"type":"resume"})";
constexpr std::string_view kStop = R"({"type":"stop"})";

static_assert(sizeof(wchar_t) == 2);

struct Failure {
  const char* message;
  DWORD code = ERROR_SUCCESS;
};

[[noreturn]] void fail(const char* message) {
  throw Failure{message, GetLastError()};
}

void require(BOOL result, const char* message) {
  if (!result) fail(message);
}

bool valid(HANDLE handle) {
  return handle != nullptr && handle != INVALID_HANDLE_VALUE;
}

class Handle {
 public:
  explicit Handle(HANDLE value = nullptr) noexcept : value_(value) {}
  ~Handle() {
    if (valid(value_)) CloseHandle(value_);
  }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;

  HANDLE get() const noexcept { return value_; }
  void capture(HANDLE value) noexcept { value_ = value; }

 private:
  HANDLE value_;
};

class Attributes {
 public:
  Attributes() {
    SIZE_T bytes = 0;
    if (InitializeProcThreadAttributeList(nullptr, 2, 0, &bytes) ||
        GetLastError() != ERROR_INSUFFICIENT_BUFFER || bytes == 0) {
      fail("Size process attributes");
    }
    value_ = static_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(HeapAlloc(GetProcessHeap(), 0, bytes));
    if (!value_) throw Failure{"Allocate process attributes"};
    if (!InitializeProcThreadAttributeList(value_, 2, 0, &bytes)) {
      const DWORD error = GetLastError();
      HeapFree(GetProcessHeap(), 0, value_);
      throw Failure{"Initialize process attributes", error};
    }
  }
  ~Attributes() {
    DeleteProcThreadAttributeList(value_);
    HeapFree(GetProcessHeap(), 0, value_);
  }
  Attributes(const Attributes&) = delete;
  Attributes& operator=(const Attributes&) = delete;

  LPPROC_THREAD_ATTRIBUTE_LIST get() const noexcept { return value_; }

 private:
  LPPROC_THREAD_ATTRIBUTE_LIST value_ = nullptr;
};

struct PipeRead {
  DWORD count;
  bool eof;
};

bool closedPipe(DWORD error) {
  return error == ERROR_BROKEN_PIPE || error == ERROR_PIPE_NOT_CONNECTED || error == ERROR_HANDLE_EOF ||
         error == ERROR_NO_DATA;
}

// The helper has a single pipe reader and no concurrent synchronous I/O. Reading
// at most the available byte count avoids waiting for absent bytes on stdin.
PipeRead available(HANDLE input) {
  DWORD count = 0;
  DWORD messageBytes = 0;
  if (PeekNamedPipe(input, nullptr, 0, nullptr, &count, &messageBytes)) {
    if (messageBytes) throw Failure{"Private control pipe must be a byte stream"};
    return {count, false};
  }
  const DWORD error = GetLastError();
  if (closedPipe(error)) return {0, true};
  throw Failure{"Inspect private control pipe", error};
}

PipeRead read(HANDLE input, void* destination, DWORD requested) {
  DWORD count = 0;
  if (ReadFile(input, destination, requested, &count, nullptr)) return {count, count == 0};
  const DWORD error = GetLastError();
  if (closedPipe(error)) return {0, true};
  throw Failure{"Read private control pipe", error};
}

DWORD remaining(ULONGLONG deadline) {
  const ULONGLONG now = GetTickCount64();
  if (now >= deadline) return 0;
  return static_cast<DWORD>(std::min<ULONGLONG>(deadline - now, kPollMs));
}

void readExact(HANDLE input, uint8_t* destination, DWORD length, ULONGLONG deadline) {
  DWORD offset = 0;
  while (offset < length) {
    const DWORD wait = remaining(deadline);
    if (!wait) throw Failure{"Configuration timeout or EOF"};
    const auto peek = available(input);
    if (peek.eof) throw Failure{"Configuration timeout or EOF"};
    if (!peek.count) {
      Sleep(wait);
      continue;
    }
    const auto got = read(input, destination + offset, std::min(peek.count, length - offset));
    if (got.eof) throw Failure{"Configuration timeout or EOF"};
    offset += got.count;
  }
}

uint32_t littleEndian(const uint8_t* bytes) {
  return static_cast<uint32_t>(bytes[0]) | (static_cast<uint32_t>(bytes[1]) << 8) |
         (static_cast<uint32_t>(bytes[2]) << 16) | (static_cast<uint32_t>(bytes[3]) << 24);
}

class ConfigReader {
 public:
  explicit ConfigReader(const std::vector<uint8_t>& bytes) : bytes_(bytes) {}

  size_t remainingBytes() const { return bytes_.size() - offset_; }

  uint32_t length() {
    if (remainingBytes() < 4) throw Failure{"Invalid configuration length"};
    const auto count = littleEndian(bytes_.data() + offset_);
    offset_ += 4;
    return count;
  }

  std::wstring string() {
    const auto units = length();
    if (units > remainingBytes() / 2) throw Failure{"Invalid configuration string length"};
    std::wstring value;
    value.reserve(units);
    // Windows uses UTF-16 code units. Keep isolated surrogates that can appear in paths or arguments.
    for (uint32_t index = 0; index < units; ++index) {
      const auto unit = static_cast<uint32_t>(bytes_[offset_]) |
                        (static_cast<uint32_t>(bytes_[offset_ + 1]) << 8);
      offset_ += 2;
      if (unit == 0) throw Failure{"Invalid UTF-16 configuration string"};
      value.push_back(static_cast<wchar_t>(unit));
    }
    return value;
  }

 private:
  const std::vector<uint8_t>& bytes_;
  size_t offset_ = 0;
};

bool separator(wchar_t character) {
  return character == L'\\' || character == L'/';
}

bool absolute(std::wstring_view value) {
  if (value.size() < 3) return false;
  const auto letter = value[0];
  if (((letter >= L'A' && letter <= L'Z') || (letter >= L'a' && letter <= L'z')) && value[1] == L':' &&
      separator(value[2])) {
    return true;
  }
  if (!separator(value[0]) || !separator(value[1]) || separator(value[2]) || value[2] == L'.') return false;
  const auto split = value.find_first_of(L"\\/", 2);
  return split != std::wstring_view::npos && split + 1 < value.size() && !separator(value[split + 1]);
}

struct Config {
  std::wstring file;
  std::wstring command;
  std::wstring cwd;
  std::wstring environment;
};

int compareNames(const std::wstring& lhs, const std::wstring& rhs) {
  const int comparison = CompareStringOrdinal(lhs.data(), static_cast<int>(lhs.size()), rhs.data(),
                                               static_cast<int>(rhs.size()), TRUE);
  if (!comparison) fail("Compare environment names");
  return comparison;
}

Config decode(HANDLE input, ULONGLONG deadline) {
  std::array<uint8_t, 8> header{};
  readExact(input, header.data(), static_cast<DWORD>(header.size()), deadline);
  if (header[0] != 'V' || header[1] != 'S' || header[2] != 'H' || header[3] != '1') {
    throw Failure{"Invalid configuration signature"};
  }
  const auto bytes = littleEndian(header.data() + 4);
  if (bytes < 16 || bytes > kConfigBytes || bytes % 2) throw Failure{"Invalid configuration size"};
  std::vector<uint8_t> buffer(bytes);
  readExact(input, buffer.data(), bytes, deadline);
  ConfigReader reader(buffer);
  Config config{reader.string(), reader.string(), reader.string(), {}};
  if (!absolute(config.file) || config.command.empty() || config.command.size() > kCommandLineUnits ||
      !absolute(config.cwd)) {
    throw Failure{"Invalid Windows launch configuration"};
  }

  const auto pairs = reader.length();
  if (pairs > reader.remainingBytes() / 10) throw Failure{"Invalid environment count"};
  std::vector<std::pair<std::wstring, std::wstring>> entries;
  entries.reserve(pairs);
  size_t environmentUnits = pairs == 0 ? 2 : 1;
  for (uint32_t index = 0; index < pairs; ++index) {
    auto name = reader.string();
    auto value = reader.string();
    if (name.empty() || name.find(L'=') != std::wstring::npos) throw Failure{"Invalid environment name"};
    environmentUnits += name.size() + value.size() + 2;
    if (environmentUnits > kEnvironmentUnits) throw Failure{"Environment too large"};
    entries.emplace_back(std::move(name), std::move(value));
  }
  if (reader.remainingBytes()) throw Failure{"Unexpected configuration bytes"};

  std::sort(entries.begin(), entries.end(), [](const auto& lhs, const auto& rhs) {
    return compareNames(lhs.first, rhs.first) == CSTR_LESS_THAN;
  });
  config.environment.reserve(environmentUnits);
  for (size_t index = 0; index < entries.size(); ++index) {
    const auto& entry = entries[index];
    if (index && compareNames(entries[index - 1].first, entry.first) == CSTR_EQUAL) {
      throw Failure{"Duplicate environment name"};
    }
    config.environment.append(entry.first);
    config.environment.push_back(L'=');
    config.environment.append(entry.second);
    config.environment.push_back(L'\0');
  }
  if (entries.empty()) config.environment.push_back(L'\0');
  config.environment.push_back(L'\0');
  if (!remaining(deadline)) throw Failure{"Configuration timeout or EOF"};
  return config;
}

class Control {
 public:
  void poll(HANDLE input) {
    while (!stop) {
      const auto peek = available(input);
      if (peek.eof) {
        stop = true;
        return;
      }
      if (!peek.count) return;
      std::array<char, kControlBytes + 1> data{};
      const auto got = read(input, data.data(), std::min(peek.count, static_cast<DWORD>(data.size())));
      if (got.eof) {
        stop = true;
        return;
      }
      for (DWORD index = 0; index < got.count; ++index) {
        const auto character = data[index];
        if (character != '\n') {
          if (used_ == line_.size()) throw Failure{"Invalid control message"};
          line_[used_++] = character;
          continue;
        }
        const std::string_view line(line_.data(), used_);
        if (line == kStop) {
          stop = true;
          return;
        }
        if (resumed || line != kResume) throw Failure{"Invalid control message"};
        resumed = true;
        used_ = 0;
      }
    }
  }

  bool resumed = false;
  bool stop = false;

 private:
  std::array<char, kControlBytes> line_{};
  size_t used_ = 0;
};

bool writeStatus(HANDLE status, const char* bytes, int size) {
  if (!valid(status) || size <= 0 || size >= 256) return false;
  DWORD written = 0;
  return WriteFile(status, bytes, static_cast<DWORD>(size), &written, nullptr) &&
         written == static_cast<DWORD>(size);
}

template <typename... Args>
void emit(HANDLE status, const char* format, Args... args) {
  std::array<char, 256> line{};
  const int size = std::snprintf(line.data(), line.size(), format, args...);
  if (!writeStatus(status, line.data(), size)) throw Failure{"Write private status pipe"};
}

void startup(HANDLE status, DWORD step) {
  emit(status, "VECTOR_SHELL/1 {\"type\":\"startup\",\"step\":%lu}\n", step);
}

void reportFailure(HANDLE status, Failure failure, bool proven) {
  const char* message = failure.message;
  std::array<char, 160> detail{};
  if (failure.code != ERROR_SUCCESS) {
    const int size = std::snprintf(detail.data(), detail.size(), "%s (%lu)", message, failure.code);
    if (size > 0 && static_cast<size_t>(size) < detail.size()) message = detail.data();
  }
  std::array<char, 256> line{};
  const int size =
      std::snprintf(line.data(), line.size(),
                    "VECTOR_SHELL/1 {\"type\":\"error\",\"message\":\"%s\",\"terminationProven\":%s}\n",
                    message, proven ? "true" : "false");
  writeStatus(status, line.data(), size);
}

struct Job {
  Handle owner;
  Handle process;
  Handle thread;
  DWORD pid = 0;
};

void launch(Job& job, Config& config, HANDLE output, HANDLE status) {
  job.owner.capture(CreateJobObjectW(nullptr, nullptr));
  if (!valid(job.owner.get())) fail("Create job");
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  require(SetInformationJobObject(job.owner.get(), JobObjectExtendedLimitInformation, &limits,
                                  static_cast<DWORD>(sizeof(limits))),
          "Enable kill-on-close");

  SECURITY_ATTRIBUTES security{static_cast<DWORD>(sizeof(SECURITY_ATTRIBUTES)), nullptr, TRUE};
  const Handle input(CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_EXISTING,
                                 0, nullptr));
  if (!valid(input.get())) fail("Open null input");
  HANDLE outputCopy = nullptr;
  require(DuplicateHandle(GetCurrentProcess(), output, GetCurrentProcess(), &outputCopy, 0, TRUE,
                          DUPLICATE_SAME_ACCESS),
          "Duplicate payload output");
  const Handle payloadOutput(outputCopy);
  HANDLE inherited[]{input.get(), payloadOutput.get()};
  HANDLE jobs[]{job.owner.get()};
  Attributes attributes;
  require(UpdateProcThreadAttribute(attributes.get(), 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited,
                                    sizeof(inherited), nullptr, nullptr),
          "Whitelist payload handles");
  require(UpdateProcThreadAttribute(attributes.get(), 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, jobs, sizeof(jobs),
                                    nullptr, nullptr),
          "Set atomic job assignment");

  STARTUPINFOEXW start{};
  start.StartupInfo.cb = static_cast<DWORD>(sizeof(start));
  start.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  start.StartupInfo.hStdInput = input.get();
  start.StartupInfo.hStdOutput = payloadOutput.get();
  start.StartupInfo.hStdError = payloadOutput.get();
  start.lpAttributeList = attributes.get();
  PROCESS_INFORMATION child{};
  constexpr DWORD flags =
      CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW;
  startup(status, 6);
  require(CreateProcessW(config.file.c_str(), config.command.data(), nullptr, nullptr, TRUE, flags,
                         config.environment.data(), config.cwd.c_str(), &start.StartupInfo, &child),
          "Create suspended job process");
  job.process.capture(child.hProcess);
  job.thread.capture(child.hThread);
  job.pid = child.dwProcessId;
  startup(status, 7);
}

bool finish(Job& job) {
  if (!valid(job.process.get())) return true;
  TerminateJobObject(job.owner.get(), 1);
  const auto deadline = GetTickCount64() + kCleanupMs;
  while (true) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION activity{};
    if (!QueryInformationJobObject(job.owner.get(), JobObjectBasicAccountingInformation, &activity,
                                   static_cast<DWORD>(sizeof(activity)), nullptr)) {
      return false;
    }
    if (activity.ActiveProcesses == 0) return true;
    const DWORD wait = remaining(deadline);
    if (!wait) return false;
    Sleep(wait);
  }
}

DWORD waitForPayload(Job& job, HANDLE input, HANDLE status) {
  Control control;
  const auto deadline = GetTickCount64() + kAcknowledgmentMs;
  emit(status, "VECTOR_SHELL/1 {\"type\":\"ready\",\"pid\":%lu}\n", job.pid);
  while (true) {
    control.poll(input);
    const DWORD wait = remaining(deadline);
    if (control.stop || !wait) throw Failure{"PID acknowledgement refused or timed out"};
    if (control.resumed) break;
    Sleep(wait);
  }
  if (ResumeThread(job.thread.get()) == static_cast<DWORD>(-1)) fail("Resume process");
  emit(status, "VECTOR_SHELL/1 {\"type\":\"running\",\"pid\":%lu}\n", job.pid);

  while (true) {
    control.poll(input);
    if (control.stop) return 1;
    switch (WaitForSingleObject(job.process.get(), 25)) {
      case WAIT_OBJECT_0: {
        DWORD code = 1;
        require(GetExitCodeProcess(job.process.get(), &code), "Read exit status");
        return code;
      }
      case WAIT_TIMEOUT:
        break;
      default:
        fail("Wait for process");
    }
  }
}
}  // namespace

int wmain(int argc, wchar_t**) {
  const auto deadline = GetTickCount64() + kStartupMs;
  const HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  const HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
  const HANDLE status = GetStdHandle(STD_ERROR_HANDLE);
  Job job;
  bool attempted = false;
  bool proven = false;
  try {
    if (argc != 1 || !valid(input) || !valid(output) || !valid(status) || input == output || input == status ||
        output == status || GetFileType(input) != FILE_TYPE_PIPE || GetFileType(output) != FILE_TYPE_PIPE ||
        GetFileType(status) != FILE_TYPE_PIPE) {
      throw Failure{"Invalid private transport"};
    }
    startup(status, 4);
    Config config = decode(input, deadline);
    startup(status, 5);
    require(SetHandleInformation(input, HANDLE_FLAG_INHERIT, 0), "Isolate control pipe");
    require(SetHandleInformation(status, HANDLE_FLAG_INHERIT, 0), "Isolate status pipe");
    launch(job, config, output, status);
    const DWORD exitCode = waitForPayload(job, input, status);
    attempted = true;
    proven = finish(job);
    if (!proven) throw Failure{"Job termination could not be proven"};
    emit(status, "VECTOR_SHELL/1 {\"type\":\"exit\",\"exitCode\":%lu,\"terminationProven\":true}\n", exitCode);
    return 0;
  } catch (const Failure& failure) {
    if (!attempted) proven = finish(job);
    reportFailure(status, failure, proven);
  } catch (...) {
    if (!attempted) proven = finish(job);
    reportFailure(status, {"Windows containment failed"}, proven);
  }
  return 1;
}
