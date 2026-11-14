// The cloud computer's live view (contract WP A54): a small VNC client for the viewer proxy on the same origin. The
// viewer token is read from the URL fragment, removed from the address at once, and sent as the first message. The
// proxy decides what this page may do: in view mode it drops input, whatever this page sends.
;(function () {
  "use strict"
  var statusText = document.getElementById("status")
  var modeText = document.getElementById("mode")
  var canvas = document.getElementById("screen")
  var ctx = canvas.getContext("2d")
  var token = new URLSearchParams(location.hash.slice(1)).get("vt")
  history.replaceState(null, "", location.pathname)
  if (!token) {
    statusText.textContent = "This live view link has no pass. Open the live view again from Vector."
    return
  }
  var control = false
  try {
    control = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).mode === "control"
  } catch (error) {}
  modeText.textContent = control ? "You have control" : "Watching"

  var socket = new WebSocket("wss://" + location.host + "/socket")
  socket.binaryType = "arraybuffer"
  var buffer = new Uint8Array(0)
  var stage = "version"
  var rects = 0
  var rect = null
  var width = 1280
  var height = 800

  socket.onopen = function () {
    socket.send(token)
    token = null
  }
  socket.onmessage = function (event) {
    var bytes = new Uint8Array(event.data)
    var joined = new Uint8Array(buffer.length + bytes.length)
    joined.set(buffer)
    joined.set(bytes, buffer.length)
    buffer = joined
    try {
      while (step()) {}
    } catch (error) {
      socket.close()
    }
  }
  socket.onclose = function (event) {
    var reasons = {
      4001: "Control went back to Vector's agent. Open the live view again to watch.",
      4002: "The session ended.",
      4003: "This live view link has expired or was already used. Open the live view again from Vector.",
    }
    statusText.textContent = reasons[event.code] || "The live view closed."
  }

  function u16(at) { return (buffer[at] << 8) | buffer[at + 1] }
  function u32(at) { return ((buffer[at] << 24) >>> 0) + ((buffer[at + 1] << 16) | (buffer[at + 2] << 8) | buffer[at + 3]) }
  function take(n) { var part = buffer.slice(0, n); buffer = buffer.slice(n); return part }
  function send(bytes) { if (socket.readyState === 1) socket.send(new Uint8Array(bytes)) }
  function request(incremental) { send([3, incremental ? 1 : 0, 0, 0, 0, 0, width >> 8, width & 255, height >> 8, height & 255]) }

  function step() {
    switch (stage) {
      case "version":
        if (buffer.length < 12) return false
        take(12)
        send(Array.from("RFB 003.008\n", function (c) { return c.charCodeAt(0) }))
        stage = "security"
        return true
      case "security": {
        if (buffer.length < 1) return false
        var count = buffer[0]
        if (count === 0 || buffer.length < 1 + count) return count !== 0 ? false : fail()
        var types = take(1 + count).slice(1)
        if (Array.prototype.indexOf.call(types, 1) < 0) return fail()
        send([1])
        stage = "result"
        return true
      }
      case "result":
        if (buffer.length < 4) return false
        if (u32(0) !== 0) return fail()
        take(4)
        send([1])
        stage = "init"
        return true
      case "init": {
        if (buffer.length < 24) return false
        var nameLength = u32(20)
        if (buffer.length < 24 + nameLength) return false
        width = u16(0)
        height = u16(2)
        take(24 + nameLength)
        canvas.width = width
        canvas.height = height
        // 32 bits a pixel, true colour, little endian: blue, green, red, unused.
        send([0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0])
        send([2, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 1, 255, 255, 255, 33])
        request(false)
        statusText.textContent = ""
        stage = "message"
        return true
      }
      case "message":
        if (rects > 0) return rectangle()
        if (buffer.length < 1) return false
        switch (buffer[0]) {
          case 0:
            if (buffer.length < 4) return false
            rects = u16(2)
            take(4)
            if (rects === 0) request(true)
            return true
          case 2:
            if (buffer.length < 6 || buffer.length < 6 + 6 * u16(4)) return false
            take(6 + 6 * u16(4))
            return true
          case 3:
            take(1)
            return true
          case 4:
            if (buffer.length < 8 || buffer.length < 8 + u32(4)) return false
            take(8 + u32(4))
            return true
          default:
            return fail()
        }
    }
    return false
  }

  function rectangle() {
    if (!rect) {
      if (buffer.length < 12) return false
      rect = { x: u16(0), y: u16(2), w: u16(4), h: u16(6), encoding: u32(8) | 0 }
      take(12)
    }
    if (rect.encoding === 0) {
      var size = rect.w * rect.h * 4
      if (buffer.length < size) return false
      var pixels = take(size)
      var image = ctx.createImageData(rect.w, rect.h)
      for (var i = 0; i < size; i += 4) {
        image.data[i] = pixels[i + 2]
        image.data[i + 1] = pixels[i + 1]
        image.data[i + 2] = pixels[i]
        image.data[i + 3] = 255
      }
      ctx.putImageData(image, rect.x, rect.y)
    } else if (rect.encoding === 1) {
      if (buffer.length < 4) return false
      var sx = u16(0)
      var sy = u16(2)
      take(4)
      ctx.drawImage(canvas, sx, sy, rect.w, rect.h, rect.x, rect.y, rect.w, rect.h)
    } else if (rect.encoding === -223) {
      width = rect.w
      height = rect.h
      canvas.width = width
      canvas.height = height
    } else return fail()
    rect = null
    rects--
    if (rects === 0) request(true)
    return true
  }

  function fail() {
    socket.close()
    return false
  }

  if (!control) return

  var buttons = 0
  function pointer(event) {
    var box = canvas.getBoundingClientRect()
    var x = Math.max(0, Math.min(width - 1, Math.round(((event.clientX - box.left) / box.width) * width)))
    var y = Math.max(0, Math.min(height - 1, Math.round(((event.clientY - box.top) / box.height) * height)))
    send([5, buttons, x >> 8, x & 255, y >> 8, y & 255])
  }
  var map = [1, 2, 4]
  canvas.addEventListener("mousemove", pointer)
  canvas.addEventListener("mousedown", function (event) { canvas.focus(); buttons |= map[event.button] || 0; pointer(event); event.preventDefault() })
  canvas.addEventListener("mouseup", function (event) { buttons &= ~(map[event.button] || 0); pointer(event) })
  canvas.addEventListener("contextmenu", function (event) { event.preventDefault() })
  canvas.addEventListener("wheel", function (event) {
    var bit = event.deltaY < 0 ? 8 : 16
    buttons |= bit
    pointer(event)
    buttons &= ~bit
    pointer(event)
    event.preventDefault()
  }, { passive: false })

  var special = {
    Backspace: 0xff08, Tab: 0xff09, Enter: 0xff0d, Escape: 0xff1b, Delete: 0xffff, Home: 0xff50, ArrowLeft: 0xff51,
    ArrowUp: 0xff52, ArrowRight: 0xff53, ArrowDown: 0xff54, PageUp: 0xff55, PageDown: 0xff56, End: 0xff57,
    Insert: 0xff63, Shift: 0xffe1, Control: 0xffe3, Alt: 0xffe9, Meta: 0xffeb, CapsLock: 0xffe5,
  }
  function keysym(event) {
    if (special[event.key]) return special[event.key]
    var f = /^F(\d{1,2})$/.exec(event.key)
    if (f) return 0xffbd + Number(f[1])
    if (event.key.length === 1) {
      var code = event.key.codePointAt(0)
      return code < 256 ? code : 0x01000000 + code
    }
    return 0
  }
  function key(down) {
    return function (event) {
      var sym = keysym(event)
      if (!sym) return
      send([4, down ? 1 : 0, 0, 0, (sym >>> 24) & 255, (sym >>> 16) & 255, (sym >>> 8) & 255, sym & 255])
      event.preventDefault()
    }
  }
  canvas.addEventListener("keydown", key(true))
  canvas.addEventListener("keyup", key(false))
})()
