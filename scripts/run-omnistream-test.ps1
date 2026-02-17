# Run OmniStream end-to-end test: start mock, start app, wait, test API, then stop both
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root\..\

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "node is not installed or not on PATH. Install Node.js first."
  exit 1
}

if (-not (Test-Path servers.test.json)) {
  Write-Error "servers.test.json not found in project root"
  exit 1
}

# Ensure test config
if (-not (Test-Path servers.json)) {
  Copy-Item servers.test.json servers.json
  Write-Output "Copied servers.test.json to servers.json"
}

# Install mock dependency (won't modify package.json)
npm install express --no-save 2>$null

$mockProc = $null
$appProc = $null

try {
  Write-Output "Starting mock server..."
  $mockProc = Start-Process -FilePath node -ArgumentList 'mock_server.js' -PassThru
  $mockProc.Id | Out-File -FilePath .\omnistream-mock.pid -Encoding ascii
  Write-Output "Mock PID: $($mockProc.Id)"

  Start-Sleep -Seconds 1

  Write-Output "Installing app dependencies (if needed)..."
  npm install --silent

  Write-Output "Starting OmniStream..."
  $appProc = Start-Process -FilePath npm -ArgumentList 'start' -PassThru
  $appProc.Id | Out-File -FilePath .\omnistream-app.pid -Encoding ascii
  Write-Output "App PID: $($appProc.Id)"

  Write-Output "Waiting for the app to become ready..."
  Start-Sleep -Seconds 6

  Write-Output "Querying API at http://localhost:3000/api/status"
  try {
    $res = Invoke-RestMethod -Uri http://localhost:3000/api/status -UseBasicParsing -ErrorAction Stop
    $res | ConvertTo-Json -Depth 6 | Write-Output
  } catch {
    Write-Error "API request failed: $_"
  }

} finally {
  Write-Output "Stopping services..."
  if ($appProc -and ($appProc.HasExited -eq $false)) {
    try { Stop-Process -Id $appProc.Id -ErrorAction SilentlyContinue } catch {}
  }
  if (Test-Path .\omnistream-app.pid) { Remove-Item .\omnistream-app.pid -ErrorAction SilentlyContinue }

  if ($mockProc -and ($mockProc.HasExited -eq $false)) {
    try { Stop-Process -Id $mockProc.Id -ErrorAction SilentlyContinue } catch {}
  }
  if (Test-Path .\omnistream-mock.pid) { Remove-Item .\omnistream-mock.pid -ErrorAction SilentlyContinue }

  Write-Output "Done."
}
