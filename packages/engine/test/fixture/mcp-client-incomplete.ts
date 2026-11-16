import { mock } from "bun:test"

// Reproduces a preceding OAuth test's deliberately incomplete Client module without running another test file.
// A warm snapshot fixture using this parent's SDK would fail before a real tools/list response.
mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    setRequestHandler() {}
    async connect() {}
    getServerCapabilities() {
      return { tools: {} }
    }
  },
}))
