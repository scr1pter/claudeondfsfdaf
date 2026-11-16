import { describe, expect, test } from "bun:test"
import { ComputerCommand } from "../src/util/computer-command"

describe("computer lease command requirements", () => {
  test.each([
    "screencapture -x screenshot.png",
    "/usr/sbin/screencapture screenshot.png",
    "cliclick p",
    "osascript task.scpt",
    "xdotool getmouselocation",
    "ydotool click 0xC0",
    "wtype hello",
    "wmctrl -l",
    "grim screen.png",
    "scrot screen.png",
    "gnome-screenshot -f screen.png",
    "flameshot full -p screen.png",
    "wf-recorder -f screen.mp4",
    '"C:\\Tools\\AutoHotkey64.exe" task.ahk',
    '& "C:\\Program Files\\AutoIt3\\AutoIt3.exe" task.au3',
    "NirCmd.EXE savescreenshot screen.png",
    "SnippingTool.exe",
    "computer-control-mcp",
  ])("known desktop utilities remain inside the computer boundary: %s", (command) => {
    expect(ComputerCommand.controls(command)).toBe(true)
  })

  test.each([
    "env DISPLAY=:0 xdotool getmouselocation",
    "env -u DISPLAY /usr/bin/xdotool getmouselocation",
    "sudo -n screencapture screen.png",
    "sudo -u fixture screencapture screen.png",
    "sudo -D /tmp screencapture screen.png",
    "time -p screencapture screen.png",
    "nice -n 5 screencapture screen.png",
    "timeout -s TERM 5s screencapture screen.png",
    "xcrun --sdk macosx screencapture screen.png",
    "xcrun screencapture -f screen.png",
    "command xdotool -v",
    "command -- xdotool -V",
    "env -S 'xdotool getmouselocation'",
    "env --split-string='xdotool getmouselocation'",
    "env -S'xdotool getmouselocation'",
    "xargs -d , screencapture screen.png",
    "npx --yes computer-control-mcp",
    "npm exec --yes -- computer-control-mcp",
    "bun x computer-control-mcp",
    "uvx --python 3.12 computer-control-mcp@0.3.14",
    "uv tool run --python 3.12 computer-control-mcp@0.3.14",
    "uvx --from computer-control-mcp==0.3.14 computer-control-mcp",
    "find . -name task.ahk -exec AutoHotkey.exe {} \\;",
    "echo ready && screencapture screen.png",
    'echo "$(screencapture screen.png)"',
    "bash -lc 'screencapture screen.png'",
    'cmd.exe /C "AutoHotkey.exe task.ahk"',
    "Start-Process AutoHotkey.exe -ArgumentList task.ahk",
    'Start-Process -workingdirectory "C:\\Tools" AutoHotkey.exe',
    'Start-Process -FilePath "C:\\Tools\\AutoHotkey.exe" -ArgumentList task.ahk',
    "echo '<<EOF'\nscreencapture screen.png",
    "echo '<<<EOF'\nscreencapture screen.png",
  ])("known controls are recognized in command positions and wrappers: %s", (command) => {
    expect(ComputerCommand.controls(command)).toBe(true)
  })

  test.each([
    `python3 -c 'import pyautogui; pyautogui.position()'`,
    `python3 -c 'from PIL import ImageGrab; ImageGrab.grab()'`,
    `python3 -m mss`,
    `node -e 'require("screenshot-desktop")()'`,
    `node --eval='require("robotjs").getMousePos()'`,
    `bun -e 'import { mouse } from "@nut-tree/nut-js"'`,
    `swift -e 'CGEventPost(nil, nil)'`,
    `powershell -NoProfile -Command '[System.Windows.Forms.SendKeys]::SendWait("a")'`,
    `pwsh -ExecutionPolicy RemoteSigned -Command '[Native]::SendInput(0, $null, 0)'`,
    `pwsh -Command '$result = [Native]::SendInput(0, $null, 0)'`,
    `[System.Windows.Forms.SendKeys]::SendWait("a")`,
    `$graphics.CopyFromScreen(0, 0, 0, 0, $size)`,
    `Add-Type 'public class Native { public static void SendInput() {} }'`,
    "python3 - <<'PY'\nimport pyautogui\npyautogui.position()\nPY",
    "bash <<'SH'\nscreencapture screen.png\nSH",
  ])("known inline desktop APIs remain inside the computer boundary: %s", (command) => {
    expect(ComputerCommand.controls(command)).toBe(true)
  })

  test.each([
    "ffmpeg -f gdigrab -i desktop screen.mp4",
    "ffmpeg -f x11grab -i :0 screen.mp4",
    "ffmpeg -f avfoundation -i 1 screen.mp4",
    "avconv -f kmsgrab -i - screen.mp4",
    "magick import -window root screen.png",
    "import screen.png",
  ])("screen capture modes of mixed-purpose tools require the computer tool: %s", (command) => {
    expect(ComputerCommand.controls(command)).toBe(true)
  })

  test.each([
    "git status --short",
    "git diff -- src/screencapture.ts",
    "bun test test/computer-command.test.ts",
    "npm run build",
    "python3 -m pytest",
    "node scripts/build.js",
    "swiftc Sources/Input.swift -o helper",
    'rg "CGEventPost|SendInput" Sources',
    "cat docs/xdotool.md",
    "echo 'screencapture screen.png'",
    "printf '%s' 'require(\"robotjs\")'",
    "# screencapture screen.png\ngit status",
    "ffmpeg -i input.mp4 output.webm",
    "ffmpeg -i gdigrab output.webm",
    "magick input.png -resize 640x480 output.png",
    "npx playwright test",
    "uvx --python 3.12 pyright",
    "uv tool run --python 3.12 pyright@1.1.400",
    "powershell -NoProfile -Command 'Get-ChildItem src'",
    "cat <<'DOC'\nscreencapture screen.png\nSendInput()\nDOC",
    "echo '<<EOF'\ngit status",
    "python3 scripts/format.py <<'DOC'\nimport pyautogui\nDOC",
    "node scripts/format.js <<'DOC'\nrequire(\"robotjs\")\nDOC",
    "bash scripts/format.sh <<'DOC'\nscreencapture screen.png\nDOC",
    "python3 -c 'print(1 + 1)'",
    "python3 -c 'from PIL import Image; Image.open(\"input.png\").resize((100, 100))'",
    "node -e 'console.log(\"robotjs\")'",
    "powershell -Command 'Write-Host \"SendInput()\"'",
    "env -u DISPLAY git status",
    "time -p npm run build",
    "command -v screencapture",
    "command -V xdotool",
    "xcrun --find screencapture",
    "Start-Process git.exe -ArgumentList status",
  ])("ordinary build, file and documentation commands retain their normal approval path: %s", (command) => {
    expect(ComputerCommand.controls(command)).toBe(false)
  })

  test("the parsed-word API accepts quoted executable paths without inspecting documentation arguments", () => {
    expect(ComputerCommand.controlsTokens(['"C:\\Tools\\AutoHotkey.exe"', "task.ahk"])).toBe(true)
    expect(ComputerCommand.controlsTokens(["sudo", "-n", "/usr/sbin/screencapture", "screen.png"])).toBe(true)
    expect(ComputerCommand.controlsTokens(["rg", "'screencapture'", "docs"])).toBe(false)
    expect(ComputerCommand.controlsTokens(["toString", "screencapture"])).toBe(false)
    expect(ComputerCommand.controls("")).toBe(false)
  })
})
