# Stop OmniStream and mock server (Windows PowerShell)
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root\..\

# Stop app
if (Test-Path .\omnistream-app.pid) {
  try {
    $pid = Get-Content .\omnistream-app.pid -ErrorAction Stop
    Stop-Process -Id $pid -ErrorAction SilentlyContinue
    Remove-Item .\omnistream-app.pid -ErrorAction SilentlyContinue
    Write-Output "Stopped OmniStream (PID $pid)"
  } catch {
    Write-Output "Failed to stop OmniStream: $_"
  }
} else { Write-Output "No OmniStream PID file found." }

# Stop mock
if (Test-Path .\omnistream-mock.pid) {
  try {
    $pid = Get-Content .\omnistream-mock.pid -ErrorAction Stop
    Stop-Process -Id $pid -ErrorAction SilentlyContinue
    Remove-Item .\omnistream-mock.pid -ErrorAction SilentlyContinue
    Write-Output "Stopped mock server (PID $pid)"
  } catch {
    Write-Output "Failed to stop mock server: $_"
  }
} else { Write-Output "No mock PID file found." }
