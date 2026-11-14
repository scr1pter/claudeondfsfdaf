// The sandbox witness must send a complete JSON-RPC line, not just JSON bytes before EOF.
export function mcpProbeCode(code: string) {
  if (code.split("JSON.stringify(result)").length !== 2)
    throw new Error("The fixed MCP probe expression is unavailable")
  return code.replace("JSON.stringify(result)", 'JSON.stringify({jsonrpc:"2.0",method:"probe",params:result})+"\\n"')
}
