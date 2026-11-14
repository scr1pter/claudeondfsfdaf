#include "windows_icon.h"
#include "windows_enum.h"
#include "windows_com.h"
#include <objidl.h>
#include <ocidl.h>
#include <knownfolders.h>
#include <shellapi.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <wincodec.h>
#include <array>
#include <algorithm>
#include <cstring>
#include <winrt/base.h>

namespace vector::computer {
namespace {
std::string base64(std::span<const uint8_t> bytes) {
  constexpr std::string_view alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string value; value.reserve(((bytes.size() + 2) / 3) * 4);
  for (size_t offset = 0; offset < bytes.size(); offset += 3) {
    const auto a = uint32_t(bytes[offset]), b = offset + 1 < bytes.size() ? uint32_t(bytes[offset + 1]) : 0U;
    const auto c = offset + 2 < bytes.size() ? uint32_t(bytes[offset + 2]) : 0U;
    value += alphabet[a >> 2]; value += alphabet[((a & 3U) << 4) | (b >> 4)];
    value += offset + 1 < bytes.size() ? alphabet[((b & 15U) << 2) | (c >> 6)] : '=';
    value += offset + 2 < bytes.size() ? alphabet[c & 63U] : '=';
  }
  return value;
}
bool current(const WindowsApplication& app) {
  if (app.owner) return same_windows_identity(app.identity, app.owner->identity) && windows_owner_current(*app.owner);
  return app.installed && same_windows_identity(app.identity, app.installed->identity) && windows_file_current(*app.installed);
}
std::optional<std::array<uint8_t, 4096>> bitmap(const WindowsApplication& app) {
  if (!current(app)) return {};
  HICON icon = nullptr;
  HBITMAP packaged = nullptr;
  struct Images { HICON& icon; HBITMAP& bitmap; ~Images() { if (icon) DestroyIcon(icon); if (bitmap) DeleteObject(bitmap); } } images{icon, packaged};
  if (app.identity.kind == WindowsAppKind::aumid) {
    WindowsComCall call;
    winrt::com_ptr<IShellItemImageFactory> item;
    if (call.current() && SUCCEEDED(SHCreateItemInKnownFolder(FOLDERID_AppsFolder, KF_FLAG_DEFAULT, app.identity.aumid.c_str(), IID_PPV_ARGS(item.put()))) && call.current()) {
      const auto result = item->GetImage(SIZE{32, 32}, static_cast<SIIGBF>(SIIGBF_ICONONLY | SIIGBF_INCACHEONLY), &packaged);
      if (FAILED(result) || !call.current()) { if (packaged) DeleteObject(packaged); packaged = nullptr; }
    }
  }
  if (!packaged) {
    // Only the actual leased executable path is consulted. No shell icon-location property or friendly path.
    if (!current(app) || app.identity.exe.empty() || ExtractIconExW(app.identity.exe.c_str(), 0, nullptr, &icon, 1) != 1 || !icon) return {};
  }
  HDC dc = CreateCompatibleDC(nullptr); if (!dc) return {};
  struct DC { HDC value; ~DC() { DeleteDC(value); } } close_dc{dc};
  BITMAPINFO info{}; info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER); info.bmiHeader.biWidth = 32; info.bmiHeader.biHeight = -32;
  info.bmiHeader.biPlanes = 1; info.bmiHeader.biBitCount = 32; info.bmiHeader.biCompression = BI_RGB;
  void* pixels = nullptr;
  const auto target = CreateDIBSection(dc, &info, DIB_RGB_COLORS, &pixels, nullptr, 0);
  if (!target || !pixels) { if (target) DeleteObject(target); return {}; }
  struct DIB { HBITMAP value; ~DIB() { DeleteObject(value); } } close_dib{target};
  const auto old = SelectObject(dc, target); if (!old || old == HGDI_ERROR) return {};
  struct Selected { HDC dc; HGDIOBJ old; ~Selected() { SelectObject(dc, old); } } selected{dc, old};
  std::memset(pixels, 0, 4096);
  if (packaged) {
    BITMAP source{}; if (GetObjectW(packaged, static_cast<int>(sizeof(source)), &source) != static_cast<int>(sizeof(source)) || source.bmWidth <= 0 || source.bmHeight <= 0 || source.bmWidth > 256 || source.bmHeight > 256) return {};
    const auto other = CreateCompatibleDC(dc); if (!other) return {};
    DC close_other{other}; const auto previous = SelectObject(other, packaged); if (!previous || previous == HGDI_ERROR) return {};
    Selected previous_selection{other, previous};
    if (!StretchBlt(dc, 0, 0, 32, 32, other, 0, 0, source.bmWidth, source.bmHeight, SRCCOPY)) return {};
  } else if (!DrawIconEx(dc, 0, 0, icon, 32, 32, 0, nullptr, DI_NORMAL)) return {};
  if (!current(app)) return {};
  std::array<uint8_t, 4096> result{}; std::memcpy(result.data(), pixels, result.size());
  bool alpha = false;
  for (size_t offset = 3; offset < result.size(); offset += 4) alpha = alpha || result[offset] != 0;
  if (!alpha && icon) {
    std::memset(pixels, 0xff, 4096);
    if (!DrawIconEx(dc, 0, 0, icon, 32, 32, 0, nullptr, DI_MASK)) return {};
    const auto mask = static_cast<const uint8_t*>(pixels);
    for (size_t offset = 0; offset < result.size(); offset += 4) result[offset + 3] = mask[offset] >= 128 ? 0 : 255;
  } else if (alpha) {
    // GDI's icon surface is premultiplied; PNG BGRA is straight alpha.
    for (size_t offset = 0; offset < result.size(); offset += 4) {
      const auto opacity = uint32_t(result[offset + 3]);
      if (opacity > 0 && opacity < 255) for (size_t channel = 0; channel < 3; ++channel)
        result[offset + channel] = static_cast<uint8_t>(std::min<uint32_t>(255, uint32_t(result[offset + channel]) * 255 / opacity));
    }
  }
  return result;
}
}

std::optional<std::string> windows_png_icon(std::span<const uint8_t> bgra) {
  if (bgra.size() != 4096) return {};
  try {
    winrt::com_ptr<IWICImagingFactory> factory;
    if (FAILED(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(factory.put())))) return {};
    winrt::com_ptr<IStream> stream; if (FAILED(CreateStreamOnHGlobal(nullptr, TRUE, stream.put()))) return {};
    winrt::com_ptr<IWICBitmapEncoder> encoder; if (FAILED(factory->CreateEncoder(GUID_ContainerFormatPng, nullptr, encoder.put())) || FAILED(encoder->Initialize(stream.get(), WICBitmapEncoderNoCache))) return {};
    winrt::com_ptr<IWICBitmapFrameEncode> frame; winrt::com_ptr<IPropertyBag2> properties;
    if (FAILED(encoder->CreateNewFrame(frame.put(), properties.put())) || FAILED(frame->Initialize(properties.get())) || FAILED(frame->SetSize(32, 32))) return {};
    WICPixelFormatGUID format = GUID_WICPixelFormat32bppBGRA;
    if (FAILED(frame->SetPixelFormat(&format)) || format != GUID_WICPixelFormat32bppBGRA ||
        FAILED(frame->WritePixels(32, 128, 4096, const_cast<BYTE*>(bgra.data()))) || FAILED(frame->Commit()) || FAILED(encoder->Commit())) return {};
    STATSTG stat{}; if (FAILED(stream->Stat(&stat, STATFLAG_NONAME)) || stat.cbSize.QuadPart < 8 || stat.cbSize.QuadPart > 8192) return {};
    std::vector<uint8_t> bytes(static_cast<size_t>(stat.cbSize.QuadPart)); LARGE_INTEGER start{};
    ULONG read = 0;
    if (FAILED(stream->Seek(start, STREAM_SEEK_SET, nullptr)) || FAILED(stream->Read(bytes.data(), static_cast<ULONG>(bytes.size()), &read)) || read != bytes.size()) return {};
    return "data:image/png;base64," + base64(bytes);
  } catch (...) { return {}; }
}
std::optional<std::string> windows_application_icon(const WindowsApplication& app) {
  try {
    const auto pixels = bitmap(app); if (!pixels) return {};
    const auto icon = windows_png_icon(*pixels); if (!current(app)) return {}; return icon;
  } catch (...) { return {}; }
}
}
