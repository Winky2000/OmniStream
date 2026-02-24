# Run OmniStream end-to-end test: start mock, start app, wait, test API, then stop both
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root\..\

function Resolve-NodeExe {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Path -and (Test-Path $cmd.Path)) { return $cmd.Path }

  $candidates = @(
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Program Files (x86)\\nodejs\\node.exe',
    "$env:LOCALAPPDATA\\Programs\\nodejs\\node.exe",
    'C:\\Program Files\\cursor\\resources\\app\\resources\\helpers\\node.exe'
  )
  foreach ($p in $candidates) {
    if ($p -and (Test-Path $p)) { return $p }
  }
  return $null
}

function Resolve-NpmCmd {
  $cmd = Get-Command npm -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Path -and (Test-Path $cmd.Path)) { return $cmd.Path }

  $nodeExe = Resolve-NodeExe
  if ($nodeExe) {
    $dir = Split-Path -Parent $nodeExe
    $npmCmd = Join-Path $dir 'npm.cmd'
    if (Test-Path $npmCmd) { return $npmCmd }
  }
  return $null
}

$nodeExe = Resolve-NodeExe
if (-not $nodeExe) {
  Write-Error "node.exe not found. Install Node.js or provide node on PATH."
  exit 1
}

$npmCmd = Resolve-NpmCmd

if (-not (Test-Path servers.test.json)) {
  Write-Error "servers.test.json not found in project root"
  exit 1
}

# Ensure test config
if (-not (Test-Path servers.json)) {
  Copy-Item servers.test.json servers.json
  Write-Output "Copied servers.test.json to servers.json"
}

# Install dependencies if needed
if (-not (Test-Path .\node_modules)) {
  if (-not $npmCmd) {
    Write-Error "node_modules is missing and npm was not found. Install Node.js (with npm) or add npm to PATH, then run npm install."
    exit 1
  }
  & $npmCmd install --silent | Out-Null
}

$mockProc = $null
$appProc = $null

try {
  Write-Output "Starting mock server..."
  $mockProc = Start-Process -FilePath $nodeExe -ArgumentList 'mock_server.js' -PassThru
  $mockProc.Id | Out-File -FilePath .\omnistream-mock.pid -Encoding ascii
  Write-Output "Mock PID: $($mockProc.Id)"

  Start-Sleep -Seconds 1

  Write-Output "Starting OmniStream..."
  $appProc = Start-Process -FilePath $nodeExe -ArgumentList 'server.js' -PassThru
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
