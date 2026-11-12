#include "input_guardian.h"
#include "parent_identity.h"
#include "windows_identity.h"
#include <bcrypt.h>
#include <tlhelp32.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <limits>
#include <stdexcept>
#include <thread>
#include <utility>
#include <winrt/base.h>

namespace vector::computer {
std::optional<InputIoDeadlineSnapshot> InputIoDeadlineFence::arm(uint64_t deadline) noexcept {
  std::lock_guard lock(mutex_);
  if (generation_ == std::numeric_limits<uint64_t>::max()) { active_.reset(); return {}; }
  active_ = InputIoDeadlineSnapshot{++generation_, deadline}; return active_;
}
std::optional<InputIoDeadlineSnapshot> InputIoDeadlineFence::snapshot() const noexcept {
  std::lock_guard lock(mutex_); return active_;
}
bool InputIoDeadlineFence::retire(const InputIoDeadlineSnapshot& observed) noexcept {
  std::lock_guard lock(mutex_); if (!active_ || *active_ != observed) return false; active_.reset(); return true;
}

InputGuardianReceiptDiagnostic input_guardian_receipt_diagnostic(const InputGuardianReceiptEvidence& evidence, uint64_t pump_before, uint64_t pump_after) noexcept {
  if (!evidence.enabled) return InputGuardianReceiptDiagnostic::none;
  if (evidence.own_down_refused) return InputGuardianReceiptDiagnostic::own_down_refused;
  if (evidence.own_tag_unflagged) return InputGuardianReceiptDiagnostic::own_tag_unflagged;
  if (evidence.own_up) return InputGuardianReceiptDiagnostic::own_up_only;
  if (evidence.own_move) return InputGuardianReceiptDiagnostic::own_move_only;
  if (evidence.low32_tag_candidate) return InputGuardianReceiptDiagnostic::low32_tag_candidate;
  return pump_after > pump_before ? InputGuardianReceiptDiagnostic::no_callback_pump_progressed : InputGuardianReceiptDiagnostic::no_callback_pump_stalled;
}
InputGuardianLedger::InputGuardianLedger(uint64_t tag) : tag_(tag) {}
std::optional<InputGuardianTicket> InputGuardianLedger::reserve(const InputRelease& release, bool diagnostic) {
  if (!valid_input_release(release)) return {};
  std::lock_guard lock(mutex_);
  if (closed_ || tag_ == 0 || sequence_ == std::numeric_limits<uint64_t>::max()) return {};
  size_t keys = 0, buttons = 0; Entry* empty = nullptr;
  for (auto& entry : entries_) {
    if (entry.ticket.id == 0) { if (!empty) empty = &entry; continue; }
    if (entry.ticket.release == release) return {};
    if (entry.ticket.release.kind == InputReleaseKind::mouse_button) ++buttons; else ++keys;
  }
  if (!empty || (release.kind == InputReleaseKind::mouse_button ? buttons >= 8 : keys >= 128)) return {};
  empty->ticket = {++sequence_, release}; empty->diagnostic.enabled = diagnostic;
  if (diagnostic) diagnostic_entries_.fetch_add(1);
  return empty->ticket;
}
bool InputGuardianLedger::observe(const InputGuardianEvent& event) noexcept {
  // Only opted-in own-tag metadata precedes the unchanged injected receipt predicate.
  if (!event.injected && event.tag == tag_ && diagnostics_enabled() && valid_input_release(event.release)) {
    std::lock_guard lock(mutex_);
    for (auto& entry : entries_) if (entry.ticket.id && entry.diagnostic.enabled && entry.ticket.release == event.release)
      entry.diagnostic.own_tag_unflagged = true;
  }
  // A projected marker can correlate with another injector; retain one opted-in boolean only.
  // It never enters the full64 ownership predicate or changes down/up/order/release state.
  if (event.injected && event.tag != tag_ && diagnostics_enabled() && is_low32_tag_candidate(event.tag, true) && valid_input_release(event.release)) {
    std::lock_guard lock(mutex_);
    for (auto& entry : entries_) if (entry.ticket.id && entry.diagnostic.enabled && entry.ticket.release == event.release)
      entry.diagnostic.low32_tag_candidate = true;
  }
  if (!event.injected || event.tag != tag_ || !valid_input_release(event.release)) return false;
  std::lock_guard lock(mutex_);
  for (auto& entry : entries_) {
    if (entry.ticket.id == 0 || entry.ticket.release != event.release) continue;
    if (event.down) {
      if (entry.up || entry.down || order_ == std::numeric_limits<uint64_t>::max()) {
        if (entry.diagnostic.enabled) entry.diagnostic.own_down_refused = true;
        return false;
      }
      entry.down = true; entry.down_order = ++order_; entry.down_at_ms=event.observed_at_ms; return true;
    }
    if (entry.diagnostic.enabled) entry.diagnostic.own_up = true;
    if (!entry.down || entry.up) return false;
    entry.up = true; if (released_ != std::numeric_limits<uint64_t>::max()) ++released_;
    if (entry.retired) { completed_[completed_cursor_]=entry.ticket; completed_cursor_=(completed_cursor_+1)%completed_.size(); erase(entry); }
    return true;
  }
  return false;
}
bool InputGuardianLedger::observed(const InputGuardianTicket& ticket, bool down, InputGuardianReceiptDiagnostic* diagnostic, uint64_t pump_before, uint64_t pump_after) const noexcept {
  std::lock_guard lock(mutex_);
  if (diagnostic) *diagnostic = InputGuardianReceiptDiagnostic::none;
  for (const auto& entry : entries_) if (entry.ticket == ticket && ticket.id != 0) {
    const bool result = down ? entry.down : entry.up;
    if (diagnostic && down && !result) *diagnostic = input_guardian_receipt_diagnostic(entry.diagnostic, pump_before, pump_after);
    return result;
  }
  for (const auto& completed : completed_) if (completed==ticket && ticket.id!=0) return true;
  return false;
}
bool InputGuardianLedger::diagnostics_enabled() const noexcept { return diagnostic_entries_.load() != 0; }
bool InputGuardianLedger::is_low32_tag_candidate(uint64_t observed_tag, bool injected) const noexcept {
  return injected && (observed_tag >> 32) == 0 && (tag_ >> 32) != 0 &&
    static_cast<uint32_t>(tag_) != 0 && static_cast<uint32_t>(observed_tag) == static_cast<uint32_t>(tag_);
}
void InputGuardianLedger::observe_move(uint64_t tag, bool injected) noexcept {
  const bool candidate = is_low32_tag_candidate(tag, injected);
  if ((tag != tag_ && !candidate) || !diagnostics_enabled()) return;
  std::lock_guard lock(mutex_);
  for (auto& entry : entries_) if (entry.ticket.id && entry.diagnostic.enabled && entry.ticket.release.kind == InputReleaseKind::mouse_button) {
    if (candidate) entry.diagnostic.low32_tag_candidate = true;
    else if (injected) entry.diagnostic.own_move = true;
    else entry.diagnostic.own_tag_unflagged = true;
  }
}
void InputGuardianLedger::erase(Entry& entry) noexcept {
  if (entry.diagnostic.enabled) diagnostic_entries_.fetch_sub(1);
  entry = {};
}
void InputGuardianLedger::retire(const InputGuardianTicket& ticket,bool definitely_not_posted) noexcept {
  std::lock_guard lock(mutex_);
  for (auto& entry : entries_) if (entry.ticket == ticket && ticket.id != 0) {
    if (entry.up) { completed_[completed_cursor_]=entry.ticket; completed_cursor_=(completed_cursor_+1)%completed_.size(); erase(entry); }
    else if (definitely_not_posted && !entry.down) erase(entry); else entry.retired = true;
    return;
  }
}
std::vector<InputGuardianTicket> InputGuardianLedger::releases(bool retired_only,std::optional<uint64_t> now_ms) const {
  std::array<Entry,136> snapshot;
  { std::lock_guard lock(mutex_); snapshot=entries_; }
  std::vector<Entry> pending;
  for (const auto& entry : snapshot) if (entry.ticket.id != 0 && entry.down && !entry.up &&
      (!retired_only || entry.retired || (now_ms && *now_ms>=entry.down_at_ms && *now_ms-entry.down_at_ms>=input_guardian_held_limit_ms))) pending.push_back(entry);
  std::sort(pending.begin(), pending.end(), [](const Entry& a, const Entry& b) { return a.down_order > b.down_order; });
  std::vector<InputGuardianTicket> result; for (const auto& entry : pending) result.push_back(entry.ticket); return result;
}
uint64_t InputGuardianLedger::released_count() const noexcept { std::lock_guard lock(mutex_); return released_; }
bool InputGuardianLedger::pending() const noexcept {
  std::lock_guard lock(mutex_); for (const auto& entry : entries_) if (entry.ticket.id != 0 && entry.down && !entry.up) return true; return false;
}
void InputGuardianLedger::close() noexcept { std::lock_guard lock(mutex_); closed_ = true; }

namespace {
bool hex(std::wstring_view text, size_t count) {
  return text.size() == count && std::all_of(text.begin(),text.end(),[](wchar_t c) { return (c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f'); });
}
uint8_t nibble(wchar_t c) { return static_cast<uint8_t>(c >= L'a' ? c - L'a' + 10 : c - L'0'); }
std::wstring random_hex(size_t bytes) {
  std::vector<uint8_t> data(bytes); if (bytes > 64 || BCryptGenRandom(nullptr,data.data(),static_cast<ULONG>(data.size()),BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0) throw std::runtime_error("Guardian randomness unavailable.");
  constexpr wchar_t digits[] = L"0123456789abcdef"; std::wstring result;
  for (const auto c : data) { result.push_back(digits[c >> 4]); result.push_back(digits[c & 15]); } return result;
}
uint64_t hex_number(std::wstring_view value) { uint64_t result = 0; for (const auto c : value) result = (result << 4) | nibble(c); return result; }
enum class Op : uint8_t { ready, reserve, observed, retire, drain, close };
struct Packet {
  Op op = Op::ready;
  bool response = false, ok = false, down = false;
  uint64_t sequence = 0, ticket = 0, tag = 0;
  uint32_t budget = 0, count = 0;
  InputRelease release;
  InputGuardianReceiptDiagnostic diagnostic = InputGuardianReceiptDiagnostic::none;
  std::array<uint8_t,32> nonce{};
};
bool valid_diagnostic_shape(const Packet& packet) noexcept {
  if (packet.diagnostic==InputGuardianReceiptDiagnostic::none) return true;
  if (!packet.response) return packet.op==Op::reserve && !packet.ok && !packet.down && packet.diagnostic==InputGuardianReceiptDiagnostic::opt_in;
  return packet.op==Op::observed && !packet.ok && packet.down &&
    packet.diagnostic>=InputGuardianReceiptDiagnostic::no_callback_pump_stalled && packet.diagnostic<=InputGuardianReceiptDiagnostic::low32_tag_candidate;
}
constexpr size_t packet_size = 80;
using Bytes = std::array<uint8_t,packet_size>;
void put(Bytes& bytes, size_t start, uint64_t value, size_t count) { for (size_t index = 0; index < count; ++index) bytes[start + index] = static_cast<uint8_t>(value >> (index * 8)); }
uint64_t get(const Bytes& bytes,size_t start,size_t count) { uint64_t value = 0; for (size_t index = 0; index < count; ++index) value |= static_cast<uint64_t>(bytes[start + index]) << (index * 8); return value; }
Bytes encode(const Packet& packet) {
  Bytes bytes{}; bytes[0]='V'; bytes[1]='I'; bytes[2]='G'; bytes[3]='2'; bytes[4]=static_cast<uint8_t>(packet.op);
  bytes[5]=static_cast<uint8_t>(packet.response); bytes[6]=static_cast<uint8_t>(packet.ok); bytes[7]=static_cast<uint8_t>(packet.down);
  put(bytes,8,packet.sequence,8); put(bytes,16,packet.ticket,8); put(bytes,24,packet.tag,8);
  put(bytes,32,packet.budget,4); put(bytes,36,packet.count,4);
  bytes[40]=static_cast<uint8_t>(packet.release.kind); bytes[41]=static_cast<uint8_t>(packet.release.extended); bytes[42]=packet.release.button;
  bytes[43]=static_cast<uint8_t>(packet.diagnostic);
  put(bytes,44,packet.release.virtual_key,2); put(bytes,46,packet.release.scan,2);
  std::copy(packet.nonce.begin(),packet.nonce.end(),bytes.begin()+48); return bytes;
}
std::optional<Packet> decode(const Bytes& bytes) {
  if (bytes[0]!='V' || bytes[1]!='I' || bytes[2]!='G' || bytes[3]!='2' || bytes[4]>static_cast<uint8_t>(Op::close) || bytes[5]>1 || bytes[6]>1 || bytes[7]>1 || bytes[40]>static_cast<uint8_t>(InputReleaseKind::mouse_button) || bytes[41]>1 || bytes[43]>static_cast<uint8_t>(InputGuardianReceiptDiagnostic::low32_tag_candidate)) return {};
  Packet packet; packet.op=static_cast<Op>(bytes[4]); packet.response=bytes[5]!=0; packet.ok=bytes[6]!=0; packet.down=bytes[7]!=0;
  packet.sequence=get(bytes,8,8); packet.ticket=get(bytes,16,8); packet.tag=get(bytes,24,8);
  packet.budget=static_cast<uint32_t>(get(bytes,32,4)); packet.count=static_cast<uint32_t>(get(bytes,36,4));
  packet.release={static_cast<InputReleaseKind>(bytes[40]),static_cast<WORD>(get(bytes,44,2)),static_cast<WORD>(get(bytes,46,2)),bytes[41]!=0,bytes[42]};
  packet.diagnostic=static_cast<InputGuardianReceiptDiagnostic>(bytes[43]);
  std::copy(bytes.begin()+48,bytes.end(),packet.nonce.begin()); return valid_diagnostic_shape(packet) ? std::optional{packet} : std::nullopt;
}
std::array<uint8_t,32> nonce_bytes(std::wstring_view text) {
  std::array<uint8_t,32> result{}; for (size_t index=0; index<result.size(); ++index) result[index]=static_cast<uint8_t>((nibble(text[index*2])<<4)|nibble(text[index*2+1])); return result;
}
bool valid_request(const Packet& packet,const InputGuardianCommand& command,uint64_t previous) {
  if (packet.response || packet.ok || packet.op==Op::ready || packet.sequence==0 || packet.sequence<=previous ||
      packet.tag!=command.tag || packet.nonce!=nonce_bytes(command.nonce) || packet.count!=0 ||
      (packet.diagnostic!=InputGuardianReceiptDiagnostic::none && !(packet.op==Op::reserve && packet.diagnostic==InputGuardianReceiptDiagnostic::opt_in))) return false;
  switch (packet.op) {
    case Op::reserve: return packet.ticket==0 && packet.budget==0 && !packet.down && valid_input_release(packet.release);
    case Op::observed: return packet.ticket!=0 && packet.budget<=50 && valid_input_release(packet.release);
    case Op::retire: return packet.ticket!=0 && packet.budget==0 && valid_input_release(packet.release);
    case Op::drain: case Op::close: return packet.ticket==0 && packet.release==InputRelease{} && !packet.down && packet.budget>0 && packet.budget<=300;
    case Op::ready: return false;
  }
  return false;
}
bool valid_reply(const Packet& reply, const Packet& request, bool diagnostic) {
  if (!valid_diagnostic_shape(reply) || (!diagnostic && request.diagnostic!=InputGuardianReceiptDiagnostic::none) ||
      !reply.response || reply.op!=request.op || reply.sequence!=request.sequence || reply.tag!=request.tag || reply.nonce!=request.nonce ||
      reply.release!=request.release || (request.op!=Op::reserve && reply.ticket!=request.ticket) || reply.down!=request.down || reply.budget!=request.budget || reply.count>136 ||
      ((request.op!=Op::drain && request.op!=Op::close) && reply.count!=0)) return false;
  if (reply.diagnostic==InputGuardianReceiptDiagnostic::none) return true;
  return diagnostic && request.op==Op::observed && request.down && !reply.ok &&
    reply.diagnostic>=InputGuardianReceiptDiagnostic::no_callback_pump_stalled && reply.diagnostic<=InputGuardianReceiptDiagnostic::low32_tag_candidate;
}
// Anonymous pipes are synchronous. The independent watcher repeats cancellation after the absolute
// deadline, covering cancellation-before-ReadFile races without holding an authority/journal lock.
class IoCancellation final {
 public:
  void attach(HANDLE thread) {
    HANDLE raw=nullptr;
    if (!DuplicateHandle(GetCurrentProcess(),thread,GetCurrentProcess(),&raw,THREAD_TERMINATE,FALSE,0)) throw std::runtime_error("Guardian I/O cancellation unavailable.");
    winrt::handle handle{raw}; std::lock_guard lock(mutex_); active_=std::move(handle);
  }
  void detach() noexcept { std::lock_guard lock(mutex_); active_.close(); }
  void cancel() noexcept { std::lock_guard lock(mutex_); if (active_) (void)CancelSynchronousIo(active_.get()); }
 private:
  std::mutex mutex_;
  winrt::handle active_;
};
class IoWatch final {
 public:
  explicit IoWatch(const std::atomic<bool>* cancelled=nullptr,IoCancellation* cancellation=nullptr) : cancelled_(cancelled),cancellation_(cancellation) {
    HANDLE raw=nullptr; if (!DuplicateHandle(GetCurrentProcess(),GetCurrentThread(),GetCurrentProcess(),&raw,THREAD_TERMINATE,FALSE,0)) throw std::runtime_error("Guardian I/O unavailable.");
    thread_.attach(raw);
    if (cancellation_) cancellation_->attach(thread_.get());
    try {
      timer_=std::thread([this] { while (!closed_.load()) {
        if (const auto observed=deadlines_.snapshot()) {
          const auto cancelled=cancelled_ && cancelled_->load();
          if (cancelled || observed->deadline)
            (void)deadlines_.cancel_if_due(*observed,cancelled ? 0 : GetTickCount64(),cancelled,[this] { (void)CancelSynchronousIo(thread_.get()); });
        }
        Sleep(1);
      } });
    } catch (...) { if (cancellation_) cancellation_->detach(); throw; }
  }
  ~IoWatch() {
    closed_.store(true); if (const auto observed=deadlines_.snapshot()) (void)deadlines_.retire(*observed);
    if (timer_.joinable()) timer_.join(); if (cancellation_) cancellation_->detach();
  }
  bool transfer(HANDLE pipe, Bytes& bytes, bool write, uint64_t deadline) {
    auto ticket=deadlines_.arm(deadline); if (!ticket) return false;
    struct Retire { InputIoDeadlineFence& fence; std::optional<InputIoDeadlineSnapshot>& ticket; ~Retire() { if (ticket) (void)fence.retire(*ticket); } } retire{deadlines_,ticket};
    size_t offset=0;
    while (offset<bytes.size()) {
      if ((cancelled_ && cancelled_->load()) || (deadline && GetTickCount64()>=deadline)) return false;
      DWORD count=0; const bool ok=write ? WriteFile(pipe,bytes.data()+offset,static_cast<DWORD>(bytes.size()-offset),&count,nullptr)!=FALSE : ReadFile(pipe,bytes.data()+offset,static_cast<DWORD>(bytes.size()-offset),&count,nullptr)!=FALSE;
      if (!ok || count==0 || count>bytes.size()-offset) return false;
      offset+=count;
      if (!write && !deadline && offset<bytes.size()) { deadline=GetTickCount64()+100; ticket=deadlines_.arm(deadline); if (!ticket) return false; }
    }
    (void)deadlines_.retire(*ticket); ticket.reset();
    return (!cancelled_ || !cancelled_->load()) && (!deadline || GetTickCount64()<deadline);
  }
 private:
  winrt::handle thread_; std::thread timer_; InputIoDeadlineFence deadlines_; std::atomic<bool> closed_{false};
  const std::atomic<bool>* cancelled_;
  IoCancellation* cancellation_;
};
DWORD actual_parent() {
  const auto raw=CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS,0); if (raw==INVALID_HANDLE_VALUE) return 0; winrt::handle snapshot{raw};
  PROCESSENTRY32W process{}; process.dwSize=sizeof(process); if (!Process32FirstW(snapshot.get(),&process)) return 0;
  do { if (process.th32ProcessID==GetCurrentProcessId()) return process.th32ParentProcessID; } while (Process32NextW(snapshot.get(),&process)); return 0;
}
uint64_t created(HANDLE process) {
  FILETIME start{},end{},kernel{},user{}; if (!GetProcessTimes(process,&start,&end,&kernel,&user)) return 0;
  return (static_cast<uint64_t>(start.dwHighDateTime)<<32)|start.dwLowDateTime;
}
std::wstring own_path() {
  std::wstring value(32'768,L'\0'); const auto count=GetModuleFileNameW(nullptr,value.data(),static_cast<DWORD>(value.size()));
  if (count==0 || count>=value.size()) throw std::runtime_error("Guardian image unavailable."); value.resize(count); return value;
}
bool release_input(const InputRelease& release,uint64_t tag) {
  if (!valid_input_release(release)) return false;
  INPUT event{};
  if (release.kind==InputReleaseKind::mouse_button) {
    event.type=INPUT_MOUSE; event.mi.dwExtraInfo=static_cast<ULONG_PTR>(tag);
    event.mi.dwFlags=release.button==0 ? MOUSEEVENTF_LEFTUP : release.button==1 ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_MIDDLEUP;
  } else {
    event.type=INPUT_KEYBOARD; event.ki.wVk=0; event.ki.wScan=release.scan; event.ki.dwExtraInfo=static_cast<ULONG_PTR>(tag);
    event.ki.dwFlags=KEYEVENTF_KEYUP | (release.kind==InputReleaseKind::unicode_key ? KEYEVENTF_UNICODE : KEYEVENTF_SCANCODE);
    if (release.extended) event.ki.dwFlags|=KEYEVENTF_EXTENDEDKEY;
  }
  return SendInput(1,&event,sizeof(event))==1;
}
struct ChildState final : std::enable_shared_from_this<ChildState> {
  explicit ChildState(InputGuardianCommand value) : command(std::move(value)),ledger(command.tag) {}
  InputGuardianCommand command;
  InputGuardianLedger ledger;
  winrt::handle parent,stop_event,armed_event,shutdown_event,reader_thread,peeker_thread;
  HANDLE input=nullptr,output=nullptr;
  std::atomic<bool> stopping{false};
  std::atomic<uint64_t> now_ms{0};
  std::mutex drain_mutex;
  std::mutex reader_mutex;
  std::condition_variable changed;
  std::mutex changed_mutex;
  std::optional<WindowsOwner> parent_identity,self_identity;
  uint64_t last_sequence=0;
  std::array<uint64_t,136> release_in_flight{};
  void stop() noexcept {
    if (stopping.exchange(true)) return; ledger.close(); SetEvent(stop_event.get());
    { std::lock_guard lock(reader_mutex); if (reader_thread) (void)CancelSynchronousIo(reader_thread.get()); if (peeker_thread) (void)CancelSynchronousIo(peeker_thread.get()); }
    changed.notify_all();
  }
  uint32_t drain(uint32_t milliseconds,bool retired_only=false) {
    const auto deadline=GetTickCount64()+std::clamp<uint32_t>(milliseconds,1,300);
    std::unique_lock lock(drain_mutex,std::try_to_lock); if (!lock.owns_lock()) return 0;
    const auto before=ledger.released_count();
    do {
      const auto candidates=ledger.releases(retired_only,GetTickCount64());
      const auto all=ledger.releases();
      for (auto& id:release_in_flight) if (id && std::none_of(all.begin(),all.end(),[&](const auto& ticket) { return ticket.id==id; })) id=0;
      if (candidates.empty()) break;
      for (const auto& ticket:candidates) {
        if (GetTickCount64()>=deadline) break;
        if (ledger.observed(ticket,false)) continue;
        if (std::find(release_in_flight.begin(),release_in_flight.end(),ticket.id)!=release_in_flight.end()) continue;
        const auto slot=std::find(release_in_flight.begin(),release_in_flight.end(),0ULL);
        if (slot!=release_in_flight.end() && release_input(ticket.release,command.tag)) *slot=ticket.id;
      }
      std::unique_lock wait(changed_mutex); changed.wait_for(wait,std::chrono::milliseconds(2));
    } while (GetTickCount64()<deadline);
    const auto after=ledger.released_count(); return static_cast<uint32_t>(std::min<uint64_t>(after-before,136));
  }
  void control() {
    HANDLE raw=nullptr; if (!DuplicateHandle(GetCurrentProcess(),GetCurrentThread(),GetCurrentProcess(),&raw,THREAD_TERMINATE,FALSE,0)) { stop(); return; }
    {
      winrt::handle observed{raw}; std::lock_guard lock(reader_mutex);
      if (stopping.load()) return; reader_thread=std::move(observed);
    }
    IoWatch io;
    while (!stopping.load()) {
      Bytes bytes{}; if (!io.transfer(input,bytes,false,0)) { stop(); return; }
      auto request=decode(bytes);
      if (!request || !valid_request(*request,command,last_sequence)) { stop(); return; }
      last_sequence=request->sequence; Packet reply=*request; reply.response=true; reply.ok=false; reply.diagnostic=InputGuardianReceiptDiagnostic::none;
      const InputGuardianTicket ticket{request->ticket,request->release};
      if (request->op==Op::reserve) {
        if (request->ticket!=0 || request->budget!=0 || request->down || !valid_input_release(request->release)) { stop(); return; }
        if (const auto reserved=ledger.reserve(request->release,request->diagnostic==InputGuardianReceiptDiagnostic::opt_in)) { reply.ticket=reserved->id; reply.ok=true; }
      } else if (request->op==Op::observed) {
        if (request->ticket==0 || request->budget>50 || !valid_input_release(request->release)) { stop(); return; }
        const bool diagnose=request->down && ledger.diagnostics_enabled();
        const auto pump_before=diagnose ? now_ms.load() : 0;
        const auto deadline=GetTickCount64()+request->budget;
        do {
          if (ledger.observed(ticket,request->down,diagnose ? &reply.diagnostic : nullptr,pump_before,diagnose ? now_ms.load() : 0)) { reply.ok=true; break; }
          if (stopping.load() || GetTickCount64()>=deadline) break;
          std::unique_lock wait(changed_mutex); changed.wait_for(wait,std::chrono::milliseconds(1));
        } while (true);
      } else if (request->op==Op::retire) {
        if (request->ticket==0 || request->budget!=0 || !valid_input_release(request->release)) { stop(); return; }
        ledger.retire(ticket,request->down); reply.ok=true;
      } else {
        if (request->ticket!=0 || request->release!=InputRelease{} || request->down || request->budget==0 || request->budget>300) { stop(); return; }
        reply.count=drain(request->budget); reply.ok=!ledger.pending();
        if (request->op==Op::close) { stop(); }
      }
      auto answer=encode(reply); if (!io.transfer(output,answer,true,GetTickCount64()+50)) { stop(); return; }
    }
  }
  void watch_eof() {
    HANDLE raw=nullptr; if (!DuplicateHandle(GetCurrentProcess(),GetCurrentThread(),GetCurrentProcess(),&raw,THREAD_TERMINATE,FALSE,0)) { stop(); return; }
    {
      winrt::handle observed{raw}; std::lock_guard lock(reader_mutex); if (stopping.load()) return; peeker_thread=std::move(observed);
    }
    while (WaitForSingleObject(stop_event.get(),10)==WAIT_TIMEOUT) {
      DWORD available=0;
      if (!PeekNamedPipe(input,nullptr,0,nullptr,&available,nullptr)) { stop(); return; }
    }
  }
};
thread_local ChildState* hook_state=nullptr;
LRESULT CALLBACK keyboard_hook(int code,WPARAM message,LPARAM data) {
  if (code==HC_ACTION && hook_state) {
    const auto& actual=*reinterpret_cast<const KBDLLHOOKSTRUCT*>(data);
    if (message==WM_KEYDOWN || message==WM_SYSKEYDOWN || message==WM_KEYUP || message==WM_SYSKEYUP) {
      // Wine's Windows conformance oracle pins VK_PACKET plus the exact UTF-16 scan value for
      // zero-wVk KEYEVENTF_UNICODE down/up pairs. We still require these actual callback facts.
      // https://github.com/wine-mirror/wine/blob/c28e3a549fc76b9c3c2f92058db98a1c78a9325d/dlls/user32/tests/input.c#L1205-L1213
      InputRelease release; release.kind=actual.vkCode==VK_PACKET ? InputReleaseKind::unicode_key : InputReleaseKind::scan_key;
      release.virtual_key=static_cast<WORD>(actual.vkCode); release.scan=static_cast<WORD>(actual.scanCode); release.extended=(actual.flags&LLKHF_EXTENDED)!=0;
      if (actual.vkCode<=0xffff && actual.scanCode<=0xffff && hook_state->ledger.observe({release,static_cast<uint64_t>(actual.dwExtraInfo),(actual.flags&LLKHF_INJECTED)!=0,(actual.flags&LLKHF_UP)==0,hook_state->now_ms.load()})) hook_state->changed.notify_all();
    }
  }
  return CallNextHookEx(nullptr,code,message,data);
}
LRESULT CALLBACK mouse_hook(int code,WPARAM message,LPARAM data) {
  if (code==HC_ACTION && hook_state) {
    std::optional<uint8_t> button; bool down=false;
    switch (message) {
      case WM_LBUTTONDOWN:button=uint8_t{0};down=true;break; case WM_LBUTTONUP:button=uint8_t{0};break;
      case WM_RBUTTONDOWN:button=uint8_t{1};down=true;break; case WM_RBUTTONUP:button=uint8_t{1};break;
      case WM_MBUTTONDOWN:button=uint8_t{2};down=true;break; case WM_MBUTTONUP:button=uint8_t{2};break;
      default:break;
    }
    if (message==WM_MOUSEMOVE && hook_state->ledger.diagnostics_enabled()) {
      const auto& actual=*reinterpret_cast<const MSLLHOOKSTRUCT*>(data);
      hook_state->ledger.observe_move(static_cast<uint64_t>(actual.dwExtraInfo),(actual.flags&LLMHF_INJECTED)!=0);
    }
    if (button) {
      const auto& actual=*reinterpret_cast<const MSLLHOOKSTRUCT*>(data);
      if (hook_state->ledger.observe({InputRelease{InputReleaseKind::mouse_button,0,0,false,*button},static_cast<uint64_t>(actual.dwExtraInfo),(actual.flags&LLMHF_INJECTED)!=0,down,hook_state->now_ms.load()})) hook_state->changed.notify_all();
    }
  }
  return CallNextHookEx(nullptr,code,message,data);
}
void authenticate(const std::shared_ptr<ChildState>& state) {
  const auto before=created(state->parent.get());
  if (!before || actual_parent()!=state->command.parent || GetProcessId(state->parent.get())!=state->command.parent) throw std::runtime_error("Guardian parent unavailable.");
  state->parent_identity=observe_windows_process(state->command.parent); state->self_identity=observe_windows_process(GetCurrentProcessId());
  const auto& parent=*state->parent_identity; const auto& self=*state->self_identity;
  if (parent.process.creation_time!=before || parent.process.creation_time>self.process.creation_time ||
      !same_file(parent.process.image,self.process.image) || !helper_install_root(self.process.image.path) ||
      !same_token(parent.process.token,self.process.token) || !serving_token_allowed(parent.process.token) || !serving_token_allowed(self.process.token) ||
      !windows_owner_current(parent) || !windows_owner_current(self) || created(state->parent.get())!=before ||
      actual_parent()!=state->command.parent || WaitForSingleObject(state->parent.get(),0)!=WAIT_TIMEOUT || state->stopping.load()) throw std::runtime_error("Guardian parent did not verify.");
}

class NativeGuardian final : public InputGuardian, public std::enable_shared_from_this<NativeGuardian> {
 public:
  explicit NativeGuardian(std::shared_ptr<InputGuardianDiagnostic> diagnostic) : diagnostic_(std::move(diagnostic)),nonce_(random_hex(32)),tag_(hex_number(random_hex(8))) {
    if (!tag_) throw std::runtime_error("Guardian tag unavailable.");
    shutdown_event_.attach(CreateEventW(nullptr,TRUE,FALSE,nullptr));
    if (!shutdown_event_) throw std::runtime_error("Guardian shutdown unavailable.");
  }
  ~NativeGuardian() override { close(); }
  uint64_t tag() const noexcept override { return tag_; }
  bool alive() const noexcept override {
    if (!armed_.load() || closed_signal_.load() || failed_.load() || retire_failed_.load()) return false;
    std::lock_guard lock(process_mutex_);
    return !closed_signal_.load() && witness_ && WaitForSingleObject(witness_.get(),0)==WAIT_TIMEOUT;
  }
  bool exited() const noexcept override {
    std::lock_guard lock(process_mutex_); return witness_ && WaitForSingleObject(witness_.get(),0)==WAIT_OBJECT_0;
  }
  bool ready() override {
    std::lock_guard lock(mutex_);
    if (closed_ || closed_signal_.load() || failed_ || retire_failed_.load()) return false;
    if (child_) return WaitForSingleObject(child_.get(),0)==WAIT_TIMEOUT;
    try { start(); if (closed_signal_.load()) { input_.close(); output_.close(); return false; } return true; } catch (...) { failed_=true; input_.close(); output_.close(); return false; }
  }
  std::optional<InputGuardianTicket> reserve(const InputRelease& release) override {
    if (!valid_input_release(release) || !ready()) return {};
    const auto deadline=GetTickCount64()+50;
    std::unique_lock lock(mutex_,std::defer_lock); if (!lock.try_lock_for(std::chrono::milliseconds(50))) return {};
    flush_retired_locked(deadline);
    Packet packet; packet.op=Op::reserve; packet.release=release;
    if (diagnostic_) packet.diagnostic=InputGuardianReceiptDiagnostic::opt_in;
    const auto reply=exchange_locked(packet,deadline); if (!reply || !reply->ok || reply->ticket==0) return {};
    return InputGuardianTicket{reply->ticket,release};
  }
  bool observed(const InputGuardianTicket& ticket,bool down,uint32_t timeout) override {
    if (ticket.id==0 || !valid_input_release(ticket.release)) {
      if (diagnostic_) diagnostic_->phase.store(InputGuardianPhase::request_invalid,std::memory_order_relaxed);
      return false;
    }
    Packet packet; packet.op=Op::observed; packet.ticket=ticket.id; packet.release=ticket.release; packet.down=down;
    const auto budget=std::min<uint32_t>(timeout,50); packet.budget=budget>10 ? budget-10 : 0;
    auto phase=InputGuardianPhase::setup_failed;
    const auto reply=exchange(packet,budget,diagnostic_ ? &phase : nullptr);
    if (reply) phase=reply->ok ? InputGuardianPhase::confirmed :
      reply->budget==0 ? InputGuardianPhase::reply_negative_zero_budget :
      reply->budget<packet.budget ? InputGuardianPhase::reply_negative_short_budget : InputGuardianPhase::reply_negative_full_budget;
    if (reply && !reply->ok && reply->budget>0 && reply->budget==packet.budget && diagnostic_) {
      switch (reply->diagnostic) {
        case InputGuardianReceiptDiagnostic::no_callback_pump_stalled: phase=InputGuardianPhase::reply_negative_no_callback_pump_stalled; break;
        case InputGuardianReceiptDiagnostic::no_callback_pump_progressed: phase=InputGuardianPhase::reply_negative_no_callback_pump_progressed; break;
        case InputGuardianReceiptDiagnostic::own_move_only: phase=InputGuardianPhase::reply_negative_own_move_only; break;
        case InputGuardianReceiptDiagnostic::own_down_refused: phase=InputGuardianPhase::reply_negative_own_down_refused; break;
        case InputGuardianReceiptDiagnostic::own_up_only: phase=InputGuardianPhase::reply_negative_own_up_only; break;
        case InputGuardianReceiptDiagnostic::own_tag_unflagged: phase=InputGuardianPhase::reply_negative_own_tag_unflagged; break;
        case InputGuardianReceiptDiagnostic::low32_tag_candidate: phase=InputGuardianPhase::reply_negative_low32_tag_candidate; break;
        default: break;
      }
    }
    // Smoke observations are sequential. Only this returning caller publishes; cancellation,
    // hook, control and retirement workers never retain or write this caller-local phase.
    if (diagnostic_) diagnostic_->phase.store(phase,std::memory_order_relaxed);
    return reply && reply->ok;
  }
  void retire(const InputGuardianTicket& ticket,bool definitely_not_posted) noexcept override {
    if (!ticket.id || !valid_input_release(ticket.release) || closed_signal_.load()) return;
    std::lock_guard lock(retire_mutex_);
    for (size_t index=0; index<retire_count_; ++index) if (retired_[index].ticket==ticket) {
      retired_[index].definitely_not_posted=retired_[index].definitely_not_posted && definitely_not_posted; return;
    }
    if (retire_count_==retired_.size()) { retire_failed_.store(true); return; }
    retired_[retire_count_++]={ticket,definitely_not_posted};
  }
  uint32_t drain(uint32_t budget) noexcept override {
    try {
      const auto deadline=GetTickCount64()+std::clamp<uint32_t>(budget,1,300);
      std::unique_lock lock(mutex_,std::defer_lock); if (!lock.try_lock_for(std::chrono::milliseconds(std::clamp<uint32_t>(budget,1,300)))) return 0;
      const auto now=GetTickCount64(); if (now>=deadline || deadline-now<=10) return 0;
      Packet packet; packet.op=Op::drain; packet.budget=static_cast<uint32_t>(std::max<uint64_t>(1,deadline-now-10));
      const auto reply=exchange_locked(packet,deadline); return reply ? std::min<uint32_t>(reply->count,136) : 0;
    } catch (...) { return 0; }
  }
  void close() noexcept override {
    const auto deadline=GetTickCount64()+1000;
    closed_signal_.store(true);
    // A private wait-only duplicate is inherited by the child. This signal is independent of the
    // control mutex and provider cancellation, so cleanup starts even if a pipe operation stalls.
    (void)SetEvent(shutdown_event_.get());
    // The active thread is an independently duplicated handle, held under its own short metadata
    // lock. Request cancellation without touching a pipe that a concurrent native call still uses.
    io_cancellation_.cancel();
    { std::lock_guard lock(process_mutex_); armed_.store(false); witness_.close(); }
    std::unique_lock lock(mutex_,std::defer_lock);
    if (!lock.try_lock_for(std::chrono::milliseconds(300))) { io_cancellation_.cancel(); return; }
    if (closed_) return; closed_=true;
    input_.close(); output_.close();
    // The child keeps its held parent witness and release-only hooks after EOF. No kill job or
    // premature TerminateProcess can remove that independent cleanup obligation.
    const auto now=GetTickCount64();
    if (child_ && now<deadline) (void)WaitForSingleObject(child_.get(),static_cast<DWORD>(deadline-now));
    child_.close();
  }
  void start_retirement_worker() {
    std::thread([weak=weak_from_this()] {
      for (;;) {
        {
          const auto owner=weak.lock(); if (!owner || owner->closed_signal_.load()) return;
          std::unique_lock lock(owner->mutex_,std::defer_lock);
          if (lock.try_lock_for(std::chrono::milliseconds(1))) {
            if (owner->retire_failed_.load()) { owner->failed_=true; owner->input_.close(); return; }
            owner->flush_retired_locked(GetTickCount64()+50);
          }
        }
        Sleep(1);
      }
    }).detach();
  }
 private:
  const std::shared_ptr<InputGuardianDiagnostic> diagnostic_;
  std::wstring nonce_; uint64_t tag_=0,sequence_=0;
  std::timed_mutex mutex_; bool closed_=false;
  std::atomic<bool> failed_{false},armed_{false};
  mutable std::mutex process_mutex_;
  winrt::handle witness_;
  std::atomic<bool> closed_signal_{false},retire_failed_{false};
  IoCancellation io_cancellation_;
  std::mutex retire_mutex_;
  struct Retirement { InputGuardianTicket ticket; bool definitely_not_posted=false; };
  std::array<Retirement,136> retired_{};
  size_t retire_count_=0;
  winrt::handle child_,input_,output_,shutdown_event_;
  std::optional<Packet> exchange(Packet packet,uint32_t milliseconds,InputGuardianPhase* phase=nullptr) {
    const auto deadline=GetTickCount64()+milliseconds;
    std::unique_lock lock(mutex_,std::defer_lock);
    if (!lock.try_lock_for(std::chrono::milliseconds(milliseconds))) { if (phase) *phase=InputGuardianPhase::lock_expired; return {}; }
    // Normal UP confirmation follows queued retirement. Publish those retirements before waiting
    // for their observed UPs; the worker cannot acquire this same control lock while we wait.
    flush_retired_locked(deadline);
    const auto now=GetTickCount64(); if (now>=deadline) { if (phase) *phase=InputGuardianPhase::budget_expired; return {}; }
    if (packet.op==Op::observed) packet.budget=static_cast<uint32_t>(std::min<uint64_t>(packet.budget,deadline-now>10?deadline-now-10:0));
    return exchange_locked(packet,deadline,phase);
  }
  void flush_retired_locked(uint64_t deadline) {
    // The entire batch shares one deadline, including serialization and both pipe transfers.
    // A full retirement queue must never hold the control lock for 136 separate timeout budgets.
    while (!closed_signal_.load() && !failed_.load() && GetTickCount64()<deadline) {
      std::optional<Retirement> retired;
      {
        std::lock_guard lock(retire_mutex_); if (!retire_count_) return;
        retired=retired_[0]; for (size_t index=1; index<retire_count_; ++index) retired_[index-1]=retired_[index]; --retire_count_;
      }
      Packet packet; packet.op=Op::retire; packet.ticket=retired->ticket.id; packet.release=retired->ticket.release; packet.down=retired->definitely_not_posted;
      if (!exchange_locked(packet,deadline)) return;
    }
  }
  std::optional<Packet> exchange_locked(Packet packet,uint64_t deadline,InputGuardianPhase* phase=nullptr) {
    if (closed_ || closed_signal_.load() || failed_ || !child_) { if (phase) *phase=InputGuardianPhase::inactive; return {}; }
    if (GetTickCount64()>=deadline) { if (phase) *phase=InputGuardianPhase::budget_expired; return {}; }
    if (sequence_==std::numeric_limits<uint64_t>::max() || WaitForSingleObject(child_.get(),0)!=WAIT_TIMEOUT) { if (phase) *phase=InputGuardianPhase::inactive; return {}; }
    packet.sequence=++sequence_; packet.tag=tag_; packet.nonce=nonce_bytes(nonce_);
    try {
      if (phase) *phase=InputGuardianPhase::setup_failed;
      IoWatch io(&closed_signal_,&io_cancellation_); auto bytes=encode(packet);
      if (phase) *phase=InputGuardianPhase::write_refused;
      if (!io.transfer(input_.get(),bytes,true,deadline)) { failed_=true; input_.close(); return {}; }
      if (phase) *phase=InputGuardianPhase::read_refused;
      if (!io.transfer(output_.get(),bytes,false,deadline)) { failed_=true; input_.close(); return {}; }
      if (phase) *phase=InputGuardianPhase::reply_invalid;
      const auto reply=decode(bytes);
      if (!reply || !valid_reply(*reply,packet,static_cast<bool>(diagnostic_))) { failed_=true; input_.close(); return {}; }
      return reply;
    } catch (...) { failed_=true; input_.close(); return {}; }
  }
  void start() {
    if (closed_signal_.load()) throw std::runtime_error("Guardian is closed.");
    const auto path=own_path();
    SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES),nullptr,TRUE}; HANDLE read=nullptr,write=nullptr;
    if (!CreatePipe(&read,&write,&security,4096)) throw std::runtime_error("Guardian pipe unavailable."); winrt::handle child_input{read}; input_.attach(write);
    if (!SetHandleInformation(input_.get(),HANDLE_FLAG_INHERIT,0)) throw std::runtime_error("Guardian pipe unavailable.");
    if (!CreatePipe(&read,&write,&security,4096)) throw std::runtime_error("Guardian pipe unavailable."); output_.attach(read); winrt::handle child_output{write};
    if (!SetHandleInformation(output_.get(),HANDLE_FLAG_INHERIT,0)) throw std::runtime_error("Guardian pipe unavailable.");
    const auto null=CreateFileW(L"NUL",GENERIC_WRITE,FILE_SHARE_READ|FILE_SHARE_WRITE,&security,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr);
    if (null==INVALID_HANDLE_VALUE) throw std::runtime_error("Guardian pipe unavailable."); winrt::handle error{null};
    HANDLE shutdown=nullptr;
    if (!DuplicateHandle(GetCurrentProcess(),shutdown_event_.get(),GetCurrentProcess(),&shutdown,SYNCHRONIZE,TRUE,0)) throw std::runtime_error("Guardian shutdown unavailable.");
    winrt::handle child_shutdown{shutdown};
    SIZE_T size=0; (void)InitializeProcThreadAttributeList(nullptr,1,0,&size); if (!size || size>65'536) throw std::runtime_error("Guardian handles unavailable.");
    std::vector<uint8_t> buffer(size); const auto attributes=reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(buffer.data());
    if (!InitializeProcThreadAttributeList(attributes,1,0,&size)) throw std::runtime_error("Guardian handles unavailable.");
    struct Delete { LPPROC_THREAD_ATTRIBUTE_LIST value; ~Delete() { DeleteProcThreadAttributeList(value); } } cleanup{attributes};
    HANDLE handles[]={child_input.get(),child_output.get(),error.get(),child_shutdown.get()};
    if (!UpdateProcThreadAttribute(attributes,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,handles,sizeof(handles),nullptr,nullptr)) throw std::runtime_error("Guardian handles unavailable.");
    constexpr wchar_t digits[]=L"0123456789abcdef"; std::wstring tag(16,L'0'); for (size_t index=0; index<16; ++index) tag[15-index]=digits[(tag_>>(index*4))&15];
    std::wstring command=L"\""+path+L"\" --computer-input-guardian --parent-pid "+std::to_wstring(GetCurrentProcessId())+L" --input-nonce "+nonce_+L" --input-tag "+tag+L" --shutdown-event "+std::to_wstring(reinterpret_cast<uintptr_t>(child_shutdown.get())); command.push_back(0);
    STARTUPINFOEXW startup{}; startup.StartupInfo.cb=sizeof(startup); startup.lpAttributeList=attributes; startup.StartupInfo.dwFlags=STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput=child_input.get(); startup.StartupInfo.hStdOutput=child_output.get(); startup.StartupInfo.hStdError=error.get();
    PROCESS_INFORMATION process{};
    if (closed_signal_.load()) throw std::runtime_error("Guardian closed during startup.");
    if (!CreateProcessW(path.c_str(),command.data(),nullptr,nullptr,TRUE,EXTENDED_STARTUPINFO_PRESENT|CREATE_NO_WINDOW,nullptr,nullptr,&startup.StartupInfo,&process)) throw std::runtime_error("Guardian process unavailable.");
    child_.attach(process.hProcess); winrt::handle thread{process.hThread};
    HANDLE observed=nullptr;
    if (!DuplicateHandle(GetCurrentProcess(),child_.get(),GetCurrentProcess(),&observed,SYNCHRONIZE,FALSE,0)) throw std::runtime_error("Guardian lifetime unavailable.");
    {
      winrt::handle handle{observed}; std::lock_guard lock(process_mutex_);
      if (closed_signal_.load()) throw std::runtime_error("Guardian closed during startup."); witness_=std::move(handle);
    }
    // Closing the parent's copies is necessary for actual EOF when the helper closes its control pipe.
    child_input.close(); child_output.close(); error.close(); child_shutdown.close();
    IoWatch io(&closed_signal_,&io_cancellation_); Bytes bytes{};
    if (!io.transfer(output_.get(),bytes,false,GetTickCount64()+10'000)) throw std::runtime_error("Guardian did not become ready.");
    const auto reply=decode(bytes);
    if (!reply || reply->op!=Op::ready || !reply->response || !reply->ok || reply->sequence!=0 || reply->ticket!=0 || reply->tag!=tag_ || reply->nonce!=nonce_bytes(nonce_) || reply->release!=InputRelease{} || reply->count || reply->budget || reply->down || reply->diagnostic!=InputGuardianReceiptDiagnostic::none) throw std::runtime_error("Guardian readiness did not verify.");
    armed_.store(true);
  }
};
}

std::optional<InputGuardianCommand> parse_input_guardian(std::span<const std::wstring> args) {
  if (args.size()!=9 || args[0]!=L"--computer-input-guardian" || args[1]!=L"--parent-pid" || args[3]!=L"--input-nonce" || args[5]!=L"--input-tag" || args[7]!=L"--shutdown-event" ||
      args[2].empty() || args[2].size()>10 || args[8].empty() || args[8].size()>20 || !hex(args[4],64) || !hex(args[6],16)) return {};
  uint64_t pid=0; for (const auto c:args[2]) { if (c<L'0' || c>L'9') return {}; pid=pid*10+static_cast<uint64_t>(c-L'0'); if (pid>MAXDWORD) return {}; }
  const auto tag=hex_number(args[6]); if (pid==0 || std::to_wstring(pid)!=args[2] || !tag) return {};
  uintptr_t shutdown=0;
  for (const auto c:args[8]) {
    if (c<L'0' || c>L'9' || shutdown>(std::numeric_limits<uintptr_t>::max()-static_cast<uintptr_t>(c-L'0'))/10) return {};
    shutdown=shutdown*10+static_cast<uintptr_t>(c-L'0');
  }
  if (!shutdown || shutdown==std::numeric_limits<uintptr_t>::max() || std::to_wstring(shutdown)!=args[8]) return {};
  return InputGuardianCommand{static_cast<DWORD>(pid),args[4],tag,shutdown};
}
bool input_guardian_protocol_self_test() {
  const InputGuardianCommand command{42,std::wstring(64,L'a'),0x0102030405060708ULL};
  Packet packet; packet.op=Op::reserve; packet.sequence=1; packet.tag=command.tag; packet.nonce=nonce_bytes(command.nonce);
  packet.release={InputReleaseKind::scan_key,static_cast<WORD>('A'),0x1e,false,0};
  const auto bytes=encode(packet); const auto parsed=decode(bytes);
  if (!parsed || !valid_request(*parsed,command,0) || valid_request(*parsed,command,1) || bytes[3]!='2' || bytes[4]!=1 || bytes[8]!=1 || bytes[24]!=8 || bytes[31]!=1 || bytes[43]!=0 || bytes[44]!='A' || bytes[46]!=0x1e || bytes[48]!=0xaa || bytes[79]!=0xaa) return false;
  auto obsolete=bytes; obsolete[3]='1'; if (decode(obsolete)) return false;
  for (const auto position:{size_t(0),size_t(4),size_t(5),size_t(6),size_t(7),size_t(40),size_t(41),size_t(43)}) {
    auto malformed=bytes; malformed[position]=0xff; if (decode(malformed)) return false;
  }
  for (int field=0; field<6; ++field) {
    auto changed=*parsed;
    if (field==0) changed.nonce[0]=static_cast<uint8_t>(changed.nonce[0]^1U);
    if (field==1) ++changed.tag;
    if (field==2) changed.response=true;
    if (field==3) changed.ok=true;
    if (field==4) changed.count=1;
    if (field==5) changed.ticket=1;
    if (valid_request(changed,command,0)) return false;
  }
  packet.op=Op::observed; packet.ticket=1; packet.down=true; packet.budget=50;
  if (!valid_request(packet,command,0)) return false;
  packet.budget=51; if (valid_request(packet,command,0)) return false;
  packet.op=Op::retire; packet.budget=0;
  if (!valid_request(packet,command,0)) return false;
  packet.op=Op::drain; packet.ticket=0; packet.down=false; packet.release={}; packet.budget=300;
  if (!valid_request(packet,command,0)) return false;
  packet.budget=301; if (valid_request(packet,command,0)) return false;
  packet=*parsed; packet.diagnostic=InputGuardianReceiptDiagnostic::opt_in;
  const auto opted=decode(encode(packet));
  if (!opted || !valid_request(*opted,command,0) || encode(packet)[43]!=1) return false;
  Packet reserve_reply=packet; reserve_reply.response=true; reserve_reply.ok=true; reserve_reply.ticket=1; reserve_reply.diagnostic=InputGuardianReceiptDiagnostic::none;
  if (!valid_reply(reserve_reply,packet,true) || valid_reply(reserve_reply,packet,false)) return false;
  packet.op=Op::observed; packet.ticket=1; packet.down=true; packet.budget=40;
  if (valid_request(packet,command,0) || decode(encode(packet))) return false;
  packet.diagnostic=InputGuardianReceiptDiagnostic::none;
  Packet reply=packet; reply.response=true;
  if (!valid_reply(reply,packet,false)) return false;
  for (uint8_t code=static_cast<uint8_t>(InputGuardianReceiptDiagnostic::no_callback_pump_stalled);
       code<=static_cast<uint8_t>(InputGuardianReceiptDiagnostic::low32_tag_candidate); ++code) {
    reply.diagnostic=static_cast<InputGuardianReceiptDiagnostic>(code);
    const auto received=decode(encode(reply));
    if (!received || !valid_reply(*received,packet,true) || valid_reply(*received,packet,false)) return false;
    auto request=packet; request.diagnostic=reply.diagnostic;
    if (valid_request(request,command,0) || decode(encode(request))) return false;
    for (int field=0; field<8; ++field) {
      auto malformed=reply;
      if (field==0) malformed.response=false;
      if (field==1) malformed.ok=true;
      if (field==2) malformed.down=false;
      if (field==3) malformed.op=Op::reserve;
      if (field==4) malformed.op=Op::retire;
      if (field==5) malformed.diagnostic=InputGuardianReceiptDiagnostic::opt_in;
      if (field==6) malformed.diagnostic=static_cast<InputGuardianReceiptDiagnostic>(9);
      if (field==7) malformed.diagnostic=static_cast<InputGuardianReceiptDiagnostic>(255);
      if (decode(encode(malformed)) || valid_reply(malformed,packet,true)) return false;
    }
    for (int field=0; field<8; ++field) {
      auto malformed=reply;
      if (field==0) ++malformed.sequence;
      if (field==1) ++malformed.tag;
      if (field==2) malformed.nonce[0]^=1U;
      if (field==3) ++malformed.ticket;
      if (field==4) ++malformed.release.scan;
      if (field==5) ++malformed.budget;
      if (field==6) malformed.count=1;
      if (field==7) malformed.count=137;
      if (valid_reply(malformed,packet,true)) return false;
    }
  }
  for (const auto code : {uint8_t{9},uint8_t{255}}) {
    auto invalid=packet; invalid.diagnostic=static_cast<InputGuardianReceiptDiagnostic>(code);
    if (valid_request(invalid,command,0) || decode(encode(invalid))) return false;
  }
  reply.diagnostic=InputGuardianReceiptDiagnostic::none; reply.ok=true;
  if (!valid_reply(reply,packet,false)) return false;
  return true;
}
std::shared_ptr<InputGuardian> InputGuardian::native(std::shared_ptr<InputGuardianDiagnostic> diagnostic) { const auto guardian=std::make_shared<NativeGuardian>(std::move(diagnostic)); guardian->start_retirement_worker(); return guardian; }
int run_input_guardian(std::span<const std::wstring> args,HANDLE input,HANDLE output) noexcept {
  try { const auto command=parse_input_guardian(args); return command ? run_input_guardian(*command,input,output) : 2; } catch (...) { return 2; }
}
int run_input_guardian(const InputGuardianCommand& command,HANDLE input,HANDLE output) noexcept {
  std::shared_ptr<ChildState> state;
  HHOOK keyboard=nullptr,mouse=nullptr;
  try {
    if (!command.parent || !command.tag || !command.shutdown_event || !hex(command.nonce,64) || GetFileType(input)!=FILE_TYPE_PIPE || GetFileType(output)!=FILE_TYPE_PIPE) return 2;
    state=std::make_shared<ChildState>(command); state->input=input; state->output=output;
    state->parent.attach(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE,FALSE,command.parent)); state->stop_event.attach(CreateEventW(nullptr,TRUE,FALSE,nullptr)); state->armed_event.attach(CreateEventW(nullptr,TRUE,FALSE,nullptr));
    if (!state->parent || !state->stop_event || !state->armed_event) return 1;
    const auto inherited=reinterpret_cast<HANDLE>(command.shutdown_event); DWORD flags=0;
    if (inherited==input || inherited==output || inherited==GetStdHandle(STD_ERROR_HANDLE) ||
        !GetHandleInformation(inherited,&flags) || (flags&HANDLE_FLAG_INHERIT)==0) return 2;
    winrt::handle inherited_shutdown{inherited}; HANDLE shutdown=nullptr;
    if (!DuplicateHandle(GetCurrentProcess(),inherited,GetCurrentProcess(),&shutdown,SYNCHRONIZE,FALSE,0)) return 2;
    state->shutdown_event.attach(shutdown); inherited_shutdown.close();
    // Create the independent fuse before readiness/any down. Stop itself never needs a new thread.
    std::thread([state] { if (WaitForSingleObject(state->stop_event.get(),INFINITE)==WAIT_OBJECT_0) { Sleep(750); (void)TerminateProcess(GetCurrentProcess(),state->ledger.pending()?1U:0U); } }).detach();
    std::thread([state] {
      const HANDLE handles[]={state->stop_event.get(),state->parent.get(),state->shutdown_event.get()};
      const auto value=WaitForMultipleObjects(3,handles,FALSE,INFINITE); if (value!=WAIT_OBJECT_0) state->stop();
    }).detach();
    // EOF is watched before potentially slow trust/package observation. A synchronous peek may
    // wait behind the control reader, so it never shares the held-parent/fuse thread.
    std::thread([state] { try { state->watch_eof(); } catch (...) { state->stop(); } }).detach();
    // Startup also has an independent finite bound before any hook can observe or release an event.
    std::thread([state] { const HANDLE handles[]={state->stop_event.get(),state->armed_event.get()}; if (WaitForMultipleObjects(2,handles,FALSE,10'000)==WAIT_TIMEOUT) state->stop(); }).detach();
    authenticate(state);
    state->now_ms.store(GetTickCount64());
    MSG message{}; (void)PeekMessageW(&message,nullptr,0,0,PM_NOREMOVE); hook_state=state.get();
    keyboard=SetWindowsHookExW(WH_KEYBOARD_LL,keyboard_hook,GetModuleHandleW(nullptr),0);
    mouse=SetWindowsHookExW(WH_MOUSE_LL,mouse_hook,GetModuleHandleW(nullptr),0);
    if (!keyboard || !mouse) throw std::runtime_error("Guardian hooks unavailable.");
    Packet ready; ready.response=true; ready.ok=true; ready.tag=command.tag; ready.nonce=nonce_bytes(command.nonce);
    auto bytes=encode(ready); { IoWatch io; if (!io.transfer(output,bytes,true,GetTickCount64()+50)) throw std::runtime_error("Guardian readiness unavailable."); }
    SetEvent(state->armed_event.get());
    std::thread([state] { try { state->control(); } catch (...) { state->stop(); } }).detach();
    uint64_t quiet=0;
    for (;;) {
      // Conservative monotonic observation time is refreshed before dispatching hook messages.
      // The callback only loads metadata; no clock, process, pipe or discovery API runs inside it.
      state->now_ms.store(GetTickCount64());
      while (PeekMessageW(&message,nullptr,0,0,PM_REMOVE)) { if (message.message==WM_QUIT) state->stop(); else { TranslateMessage(&message); DispatchMessageW(&message); } }
      if (state->stopping.load()) {
        (void)state->drain(5);
        if (state->ledger.pending()) quiet=0; else if (!quiet) quiet=GetTickCount64();
        if (quiet && GetTickCount64()-quiet>=100) break;
      } else (void)state->drain(1,true);
      (void)MsgWaitForMultipleObjects(0,nullptr,FALSE,2,QS_ALLINPUT);
    }
    UnhookWindowsHookEx(keyboard); keyboard=nullptr; UnhookWindowsHookEx(mouse); mouse=nullptr; hook_state=nullptr;
    // No CRT/DLL teardown wait can delay the independent parent's one-second lifetime bound.
    (void)TerminateProcess(GetCurrentProcess(),state->ledger.pending()?1U:0U); return 0;
  } catch (...) {
    if (state) state->stop();
    if (state && keyboard && mouse) {
      const auto deadline=GetTickCount64()+300; MSG message{};
      do {
        state->now_ms.store(GetTickCount64());
        while (PeekMessageW(&message,nullptr,0,0,PM_REMOVE)) { TranslateMessage(&message); DispatchMessageW(&message); }
        try { (void)state->drain(2); } catch (...) {}
        (void)MsgWaitForMultipleObjects(0,nullptr,FALSE,2,QS_ALLINPUT);
      } while (GetTickCount64()<deadline);
    }
    hook_state=nullptr; if (keyboard) UnhookWindowsHookEx(keyboard); if (mouse) UnhookWindowsHookEx(mouse);
    return 1;
  }
}
}
