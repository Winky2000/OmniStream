# Start OmniStream and mock server (Windows PowerShell)
# Run from the repository scripts folder or call with full path.
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root\..\

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "node is not installed or not on PATH. Install Node.js first."
  exit 1
}

# Ensure test config present
if (-not (Test-Path servers.test.json)) {
  Write-Error "servers.test.json not found in project root"
  exit 1
}
if (-not (Test-Path servers.json)) {
  Copy-Item servers.test.json servers.json
  Write-Output "Copied servers.test.json to servers.json"
}

# install mock dependency (won't modify package.json)
npm install express --no-save 2>$null

# Start mock server in background and record PID
$mock = Start-Process -FilePath node -ArgumentList 'mock_server.js' -PassThru
$mock.Id | Out-File -FilePath .\omnistream-mock.pid -Encoding ascii
Write-Output "Started mock server (PID $($mock.Id))"

# Install app dependencies
npm install

# Start OmniStream (npm start) in background and record PID
$app = Start-Process -FilePath npm -ArgumentList 'start' -PassThru
$app.Id | Out-File -FilePath .\omnistream-app.pid -Encoding ascii
Write-Output "Started OmniStream (PID $($app.Id))"

Write-Output "Give the app a few seconds to start, then open http://localhost:3000"
