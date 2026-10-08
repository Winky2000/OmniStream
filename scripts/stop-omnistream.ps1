# Stop OmniStream and mock server (Windows PowerShell)
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root\..\

# Stop app
if (Test-Path .\omnistream-app.pid) {
  try {
    $procId = Get-Content .\omnistream-app.pid -ErrorAction Stop
    Stop-Process -Id $procId -ErrorAction SilentlyContinue
    Remove-Item .\omnistream-app.pid -ErrorAction SilentlyContinue
    Write-Output "Stopped OmniStream (PID $procId)"
  } catch {
    Write-Output "Failed to stop OmniStream: $_"
  }
} else { Write-Output "No OmniStream PID file found." }

# Stop mock
if (Test-Path .\omnistream-mock.pid) {
  try {
    $procId = Get-Content .\omnistream-mock.pid -ErrorAction Stop
    Stop-Process -Id $procId -ErrorAction SilentlyContinue
    Remove-Item .\omnistream-mock.pid -ErrorAction SilentlyContinue
    Write-Output "Stopped mock server (PID $procId)"
  } catch {
    Write-Output "Failed to stop mock server: $_"
  }
} else { Write-Output "No mock PID file found." }
