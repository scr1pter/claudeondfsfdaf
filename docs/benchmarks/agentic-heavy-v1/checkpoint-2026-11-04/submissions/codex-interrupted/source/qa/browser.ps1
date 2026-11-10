function Invoke-QABrowser {
  param([hashtable]$Action)
  $raw = $Action | ConvertTo-Json -Depth 8 -Compress | & $env:NODE_EXE $env:BROWSER_DRIVER_CLIENT --endpoint $env:BROWSER_DRIVER_ENDPOINT
  $result = $raw | ConvertFrom-Json
  $evidence = Join-Path $env:DATA_DIR 'qa-browser-actions.jsonl'
  Add-Content -LiteralPath $evidence -Value $raw
  if ($result.ok -ne $true) { Write-Output $raw; return }
  if ($Action.action -eq 'screenshot' -and $result.result.file) {
    $destination = Join-Path $env:DATA_DIR $Action.evidenceName
    Copy-Item -LiteralPath $result.result.file -Destination $destination
    Write-Output "SCREENSHOT $destination"
  }
  Write-Output "PAGE $($result.snapshot.url)"
  Write-Output $result.snapshot.text
  $result.snapshot.controls | ForEach-Object { Write-Output "$($_.ref) | $($_.role) | $($_.name) | $($_.value)" }
  Write-Output ("FOCUS " + ($result.snapshot.focus | ConvertTo-Json -Compress))
}
