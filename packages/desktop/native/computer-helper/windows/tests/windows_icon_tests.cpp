#include "windows_icon.h"
#include <objidl.h>
#include <wincrypt.h>
#include <wincodec.h>
#include <array>
#include <algorithm>
#include <stdexcept>
#include <winrt/base.h>

namespace vector::computer {
namespace {
void require_icon(bool value, const char* reason) { if (!value) throw std::runtime_error(reason); }
std::vector<uint8_t> png(const std::string& value) {
  constexpr std::string_view prefix = "data:image/png;base64,";
  require_icon(value.starts_with(prefix) && value.size() <= prefix.size() + ((8192 + 2) / 3) * 4, "windows-icon.data-url-bound");
  const auto body = value.substr(prefix.size()); DWORD size = 0;
  require_icon(CryptStringToBinaryA(body.data(), static_cast<DWORD>(body.size()), CRYPT_STRING_BASE64 | CRYPT_STRING_STRICT, nullptr, &size, nullptr, nullptr) && size <= 8192, "windows-icon.base64-bound");
  std::vector<uint8_t> result(size);
  require_icon(CryptStringToBinaryA(body.data(), static_cast<DWORD>(body.size()), CRYPT_STRING_BASE64 | CRYPT_STRING_STRICT, result.data(), &size, nullptr, nullptr) != FALSE, "windows-icon.base64");
  return result;
}
void decode(const std::vector<uint8_t>& bytes, std::span<const uint8_t> original) {
  require_icon(bytes.size() >= 8 && bytes[0] == 137 && bytes[1] == 'P' && bytes[2] == 'N' && bytes[3] == 'G', "windows-icon.actual-png");
  winrt::com_ptr<IWICImagingFactory> factory;
  require_icon(SUCCEEDED(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(factory.put()))), "windows-icon.wic-factory");
  winrt::com_ptr<IWICStream> stream;
  require_icon(SUCCEEDED(factory->CreateStream(stream.put())) && SUCCEEDED(stream->InitializeFromMemory(const_cast<BYTE*>(bytes.data()), static_cast<DWORD>(bytes.size()))), "windows-icon.png-stream");
  winrt::com_ptr<IWICBitmapDecoder> decoder;
  require_icon(SUCCEEDED(factory->CreateDecoderFromStream(stream.get(), nullptr, WICDecodeMetadataCacheOnLoad, decoder.put())), "windows-icon.decode");
  winrt::com_ptr<IWICBitmapFrameDecode> frame; UINT width = 0, height = 0;
  require_icon(SUCCEEDED(decoder->GetFrame(0, frame.put())) && SUCCEEDED(frame->GetSize(&width, &height)) && width == 32 && height == 32, "windows-icon.fixed-size");
  winrt::com_ptr<IWICFormatConverter> converted;
  require_icon(SUCCEEDED(factory->CreateFormatConverter(converted.put())) && SUCCEEDED(converted->Initialize(frame.get(), GUID_WICPixelFormat32bppBGRA, WICBitmapDitherTypeNone, nullptr, 0, WICBitmapPaletteTypeCustom)), "windows-icon.normalized-pixels");
  std::array<uint8_t, 4096> pixels{};
  require_icon(SUCCEEDED(converted->CopyPixels(nullptr, 128, static_cast<UINT>(pixels.size()), pixels.data())) && std::equal(pixels.begin(), pixels.end(), original.begin(), original.end()), "windows-icon-generated-pixel-roundtrip");
}
}
// Grant-free WIC runs only in the actual Windows native unit executable. No UI, app/filesystem icon,
// display, input, clipboard, owner file or external image participates in these generated bitmap checks.
size_t run_windows_icon_tests() {
  size_t groups = 0;
  require_icon(!windows_png_icon({}), "windows-icon.empty-refusal"); ++groups;
  std::array<uint8_t, 4096> pixels{};
  require_icon(!windows_png_icon(std::span<const uint8_t>(pixels).first(4095)), "windows-icon.short-refusal"); ++groups;
  for (size_t offset = 0; offset < pixels.size(); offset += 4) { pixels[offset] = 192; pixels[offset + 1] = 128; pixels[offset + 2] = 32; pixels[offset + 3] = 255; }
  const auto uniform = windows_png_icon(pixels); require_icon(uniform.has_value(), "windows-icon.generated-encode"); decode(png(*uniform), pixels); ++groups;
  for (size_t offset = 0; offset < pixels.size(); ++offset) pixels[offset] = static_cast<uint8_t>((offset * 137 + 59) & 255);
  const auto varied = windows_png_icon(pixels); require_icon(varied.has_value(), "windows-icon.generated-varied-encode"); decode(png(*varied), pixels); ++groups;
  return groups;
}
}
