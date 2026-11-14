import { scanImage } from "@/utils/qr/image"

// Scanning the computer's pairing QR code with this phone's camera, inside the phone app (WP A42). On iPhone the
// system camera would open the link in Safari, whose storage is not the installed app's, so pairing scans here. The
// camera is allowed only on the phone origin (`Permissions-Policy: camera=(self)`, vercel.json). Frames stay on the
// phone: the browser's own BarcodeDetector reads them where it has one, and Vector's decoder (utils/qr) elsewhere.

type Detector = { detect(source: CanvasImageSource): Promise<{ rawValue: string }[]> }
type DetectorConstructor = {
  new (options: { formats: string[] }): Detector
  getSupportedFormats?: () => Promise<string[]>
}

export class ScannerError extends Error {
  constructor(readonly problem: "denied" | "unavailable") {
    super(problem === "denied" ? "Vector cannot use the camera." : "This phone's camera is not available here.")
  }
}

const FRAME_MS = 200
const MAX_SIDE = 720

async function detector(): Promise<Detector | undefined> {
  const Barcode = (globalThis as { BarcodeDetector?: DetectorConstructor }).BarcodeDetector
  if (!Barcode) return undefined
  try {
    const formats = (await Barcode.getSupportedFormats?.()) ?? ["qr_code"]
    return formats.includes("qr_code") ? new Barcode({ formats: ["qr_code"] }) : undefined
  } catch {
    return undefined
  }
}

/**
 * Shows the back camera in `video` and calls `found` with each QR code's text until it answers true. Resolves with a
 * stop function, or rejects with a ScannerError when the camera cannot be used.
 */
export async function startScanner(video: HTMLVideoElement, found: (text: string) => boolean): Promise<() => void> {
  if (!navigator.mediaDevices?.getUserMedia) throw new ScannerError("unavailable")
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false })
  } catch (error) {
    const name = error instanceof Error ? error.name : ""
    throw new ScannerError(name === "NotAllowedError" || name === "SecurityError" ? "denied" : "unavailable")
  }
  video.muted = true
  video.setAttribute("playsinline", "")
  video.srcObject = stream
  await video.play().catch(() => {})
  const native = await detector()
  const canvas = document.createElement("canvas")
  const context = canvas.getContext("2d", { willReadFrequently: true })
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = () => {
    stopped = true
    if (timer) clearTimeout(timer)
    for (const track of stream.getTracks()) track.stop()
    video.srcObject = null
  }
  const tick = async () => {
    if (stopped) return
    try {
      if (video.readyState >= 2 && video.videoWidth > 0 && context) {
        const scale = Math.min(1, MAX_SIDE / Math.max(video.videoWidth, video.videoHeight))
        canvas.width = Math.round(video.videoWidth * scale)
        canvas.height = Math.round(video.videoHeight * scale)
        context.drawImage(video, 0, 0, canvas.width, canvas.height)
        const texts = native
          ? (await native.detect(canvas)).map((code) => code.rawValue)
          : [scanImage(context.getImageData(0, 0, canvas.width, canvas.height))].filter(
              (text): text is string => text !== undefined,
            )
        for (const text of texts)
          if (found(text)) {
            stop()
            return
          }
      }
    } catch {}
    if (!stopped) timer = setTimeout(() => void tick(), FRAME_MS)
  }
  void tick()
  return stop
}
