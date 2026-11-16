import { expect, test } from "bun:test"
import { ReadBuffer } from "@modelcontextprotocol/sdk/shared/stdio.js"
import { localTransport } from "../../src/mcp/stdio"
import { mcpProbeCode } from "../fixture/sandbox-mcp-code"

const result = { visible: false, sent: false, pid: 123, ppid: 122 }
const source = `const result=${JSON.stringify(result)};process.stdout.write(JSON.stringify(result))`

test("the sandbox MCP source emits a complete line the actual SDK can decode before EOF", async () => {
  const node = Bun.which("node")
  expect(node).not.toBeNull()
  const child = Bun.spawn([node!, "-e", mcpProbeCode(source)], { stdout: "pipe", stderr: "pipe" })
  const [code, bytes, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
  ])
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
  const frame = Buffer.from(bytes)
  expect(frame.at(-1)).toBe(10)
  const buffer = new ReadBuffer()
  buffer.append(frame.subarray(0, -1))
  // This is the old failure: valid JSON without the protocol delimiter never emits, even after child EOF.
  expect(buffer.readMessage()).toBeNull()
  buffer.append(frame.subarray(-1))
  expect(buffer.readMessage()).toEqual({ jsonrpc: "2.0", method: "probe", params: result })
  expect(buffer.readMessage()).toBeNull()
})

test("the actual local MCP transport receives the fixed sandbox notification without a timeout", async () => {
  const node = Bun.which("node")
  expect(node).not.toBeNull()
  const transport = await localTransport({
    command: node!,
    args: ["-e", mcpProbeCode(source)],
    cwd: process.cwd(),
    env: {},
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const received = new Promise<unknown>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("The synthetic MCP line was not received")), 5_000)
    transport.onmessage = resolve
    transport.onerror = reject
    transport.onclose = () => reject(new Error("The synthetic MCP child closed before a complete line"))
  })
  void received.catch(() => {})
  try {
    await transport.start()
    expect(await received).toEqual({ jsonrpc: "2.0", method: "probe", params: result })
  } finally {
    clearTimeout(timer)
    await transport.close()
  }
}, 10_000)
