# Start OmniStream and mock server (Windows PowerShell)
# Run from the repository scripts folder or call with full path.
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

# Ensure test config present
if (-not (Test-Path servers.test.json)) {
  Write-Error "servers.test.json not found in project root"
  exit 1
}
if (-not (Test-Path servers.json)) {
  Copy-Item servers.test.json servers.json
  Write-Output "Copied servers.test.json to servers.json"
}

# Install app dependencies if possible (includes mock deps like express).
if (-not (Test-Path .\node_modules)) {
  if (-not $npmCmd) {
    Write-Error "node_modules is missing and npm was not found. Install Node.js (with npm) or add npm to PATH, then run npm install."
    exit 1
  }
  & $npmCmd install | Out-Null
}

# Start mock server in background and record PID
$mock = Start-Process -FilePath $nodeExe -ArgumentList 'mock_server.js' -PassThru
$mock.Id | Out-File -FilePath .\omnistream-mock.pid -Encoding ascii
Write-Output "Started mock server (PID $($mock.Id))"

# Start OmniStream in background and record PID
$app = Start-Process -FilePath $nodeExe -ArgumentList 'server.js' -PassThru
$app.Id | Out-File -FilePath .\omnistream-app.pid -Encoding ascii
Write-Output "Started OmniStream (PID $($app.Id))"

Write-Output "Give the app a few seconds to start, then open http://localhost:3000"
