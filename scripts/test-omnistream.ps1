# Test OmniStream API and print JSON result
$uri = 'http://localhost:3000/api/status'
try {
  $res = Invoke-RestMethod -Uri $uri -UseBasicParsing -ErrorAction Stop
  $res | ConvertTo-Json -Depth 6 | Write-Output
} catch {
  Write-Error "API request failed: $_"
}
