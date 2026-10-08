# Run OmniStream end-to-end test: start mock, start app, wait, test API, then stop both
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root\..\

$configPath = Join-Path (Get-Location) 'config.json'
$configBackupPath = "$configPath.bak"
$hadConfig = Test-Path $configPath
$originalConfigText = $null

$serversPath = Join-Path (Get-Location) 'servers.json'
$serversBackupPath = "$serversPath.bak"
$hadServers = Test-Path $serversPath
$originalServersText = $null

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
$npmCmd = Resolve-NpmCmd
try {
  $mockProc = $null
  $appProc = $null
  $oldPortEnv = $env:PORT
  $testPort = 3100
  $touchedConfig = $false
  $touchedServers = $false

  if (-not $nodeExe) {
    throw "node.exe not found. Install Node.js or provide node on PATH."
  }

  if (-not (Test-Path servers.test.json)) {
    throw "servers.test.json not found in project root"
  }

  # For E2E tests we want to avoid interactive login.
  # Temporarily force auth mode to "nginx" (internal auth disabled) and restore
  # the original config.json when done.
  try {
    if ($hadConfig) {
      $originalConfigText = Get-Content -Raw -Path $configPath -ErrorAction Stop
      Set-Content -Path $configBackupPath -Value $originalConfigText -Encoding UTF8 -ErrorAction Stop
    }

    $testConfig = @{
      auth = @{
        mode = 'nginx'
      }
    }
    $testConfigJson = $testConfig | ConvertTo-Json -Depth 6
    Set-Content -Path $configPath -Value $testConfigJson -Encoding UTF8 -ErrorAction Stop
    $touchedConfig = $true
  } catch {
    throw "Failed to prepare test config.json: $_"
  }

  # Ensure test servers.json (always use mock servers during E2E)
  try {
    if ($hadServers) {
      $originalServersText = Get-Content -Raw -Path $serversPath -ErrorAction Stop
      Set-Content -Path $serversBackupPath -Value $originalServersText -Encoding UTF8 -ErrorAction Stop
    }

    Copy-Item -Force servers.test.json servers.json
    Write-Output "Using servers.test.json for this E2E run"
    $touchedServers = $true
  } catch {
    throw "Failed to prepare servers.json for test run: $_"
  }

  # Install dependencies if needed
  if (-not (Test-Path .\node_modules)) {
    if (-not $npmCmd) {
      throw "node_modules is missing and npm was not found. Install Node.js (with npm) or add npm to PATH, then run npm install."
    }
    & $npmCmd install --silent | Out-Null
  }

  Write-Output "Starting mock server..."
  $mockProc = Start-Process -FilePath $nodeExe -ArgumentList 'mock_server.js' -PassThru -NoNewWindow -RedirectStandardOutput .\omnistream-mock.out.log -RedirectStandardError .\omnistream-mock.err.log
  $mockProc.Id | Out-File -FilePath .\omnistream-mock.pid -Encoding ascii
  Write-Output "Mock PID: $($mockProc.Id)"

  Start-Sleep -Seconds 1

  Write-Output "Starting OmniStream..."
  # Force a dedicated port for tests to avoid colliding with a locally running instance.
  $env:PORT = "$testPort"
  $appProc = Start-Process -FilePath $nodeExe -ArgumentList 'server.js' -PassThru -NoNewWindow -RedirectStandardOutput .\omnistream-app.out.log -RedirectStandardError .\omnistream-app.err.log
  $appProc.Id | Out-File -FilePath .\omnistream-app.pid -Encoding ascii
  Write-Output "App PID: $($appProc.Id)"

  Write-Output "Waiting for the app to become ready..."
  Start-Sleep -Seconds 6

  $actualPort = $testPort
  try {
    if (Test-Path .\omnistream-app.out.log) {
      $outLog = Get-Content -Raw -Path .\omnistream-app.out.log -ErrorAction SilentlyContinue
      $m = [regex]::Match([string]$outLog, 'listening on port\s+(\d+)')
      if ($m.Success) { $actualPort = [int]$m.Groups[1].Value }
    }
  } catch {
    # ignore
  }

  Write-Output "Querying API at http://localhost:$actualPort/api/status"
  try {
    $res = Invoke-RestMethod -Uri "http://localhost:$actualPort/api/status" -UseBasicParsing -ErrorAction Stop
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

  # Restore PORT env var
  try {
    if ($null -ne $oldPortEnv -and $oldPortEnv -ne '') {
      $env:PORT = $oldPortEnv
    } else {
      Remove-Item Env:PORT -ErrorAction SilentlyContinue
    }
  } catch {
    # ignore
  }

  # Restore original config.json
  try {
    if ($touchedConfig -and $hadConfig -and (Test-Path $configBackupPath)) {
      $restoreText = Get-Content -Raw -Path $configBackupPath -ErrorAction Stop
      Set-Content -Path $configPath -Value $restoreText -Encoding UTF8 -ErrorAction Stop
      Remove-Item -Path $configBackupPath -ErrorAction SilentlyContinue
    } elseif ($touchedConfig -and (-not $hadConfig)) {
      if (Test-Path $configPath) { Remove-Item -Path $configPath -ErrorAction SilentlyContinue }
    }
  } catch {
    Write-Warning "Failed to restore original config.json: $_"
  }

  # Restore original servers.json
  try {
    if ($touchedServers -and $hadServers -and (Test-Path $serversBackupPath)) {
      $restoreServersText = Get-Content -Raw -Path $serversBackupPath -ErrorAction Stop
      Set-Content -Path $serversPath -Value $restoreServersText -Encoding UTF8 -ErrorAction Stop
      Remove-Item -Path $serversBackupPath -ErrorAction SilentlyContinue
    } elseif ($touchedServers -and (-not $hadServers)) {
      if (Test-Path $serversPath) { Remove-Item -Path $serversPath -ErrorAction SilentlyContinue }
    }
  } catch {
    Write-Warning "Failed to restore original servers.json: $_"
  }

  Write-Output "Done."
}
