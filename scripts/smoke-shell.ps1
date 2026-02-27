param(
  [string]$BaseUrl = 'http://localhost:3100',
  [string]$Username = 'admin',
  [string]$Password = '',
  [switch]$PromptPassword
)

$ErrorActionPreference = 'Stop'

$pages = @(
  'index.html','glance.html','history.html','reports.html','notifications.html',
  'admin.html','servers.html','display.html','notifiers.html','system.html','about.html',
  'overseerr.html','subscribers.html','templates.html','custom-header.html'
)

$assets = @('shell.css','shell.js','theme.css')

function ConvertFrom-SecureStringToPlain([securestring]$Secure) {
  if (-not $Secure) { return '' }
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    if ($bstr -ne [IntPtr]::Zero) {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
  }
}

function Get-Ok([string]$Url, $WebSession) {
  $lastErr = $null
  for ($i = 0; $i -lt 15; $i++) {
    try {
      return Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 10 -WebSession $WebSession
    } catch {
      $lastErr = $_
      Start-Sleep -Milliseconds 300
    }
  }
  throw $lastErr
}

$sess = New-Object Microsoft.PowerShell.Commands.WebRequestSession

if ($PromptPassword -or [string]::IsNullOrWhiteSpace($Password)) {
  try {
    $secure = Read-Host -Prompt "Password for $Username" -AsSecureString
    $Password = ConvertFrom-SecureStringToPlain $secure
  } catch {
    Write-Output "Failed to read password securely."
    exit 1
  }
}

try {
  $loginBody = @{ username = $Username; password = $Password } | ConvertTo-Json
  Invoke-RestMethod -Uri "$BaseUrl/api/auth/login" -Method Post -ContentType 'application/json' -Body $loginBody -WebSession $sess | Out-Null
} catch {
  Write-Output "Login failed for $Username at $BaseUrl/api/auth/login"
  Write-Output $_.Exception.Message
  exit 1
}

$mustChange = $false
try {
  $me = Invoke-RestMethod -Uri "$BaseUrl/api/auth/me" -Method Get -WebSession $sess
  $mustChange = ($me -and $me.mustChangePassword -eq $true)
} catch {
  # ignore; we'll just continue and validate by content checks.
}

if ($mustChange) {
  Write-Output "Auth is forcing password change (admin/$Password default). Validating change-password page only."
  try {
    $r = Get-Ok "$BaseUrl/change-password.html" $sess
    $hasThemeCss = ($r.Content -match 'href="theme\.css"')
    $isChangePw = ($r.Content -match '<title>OmniStream Change Password</title>')
    $row = [pscustomobject]@{ Kind='page'; Path='change-password.html'; Code=[int]$r.StatusCode; ThemeCss=[bool]$hasThemeCss; IsChangePassword=[bool]$isChangePw }
    $row | Format-Table -AutoSize | Out-String -Width 260 | Write-Output
    if ($r.StatusCode -ne 200 -or -not $hasThemeCss -or -not $isChangePw) {
      exit 1
    }
    Write-Output "\nSmoke sweep OK (password change required mode)."
    exit 0
  } catch {
    Write-Output $_.Exception.Message
    exit 1
  }
}

$results = @()

foreach ($p in $pages) {
  $url = "$BaseUrl/$p"
  try {
    $r = Get-Ok $url $sess
    $hasShellCss = ($r.Content -match 'href="shell\.css"')
    $hasShellJs  = ($r.Content -match 'src="shell\.js"')
    $isLogin = ($r.Content -match '<title>OmniStream Login</title>')
    $isChangePw = ($r.Content -match '<title>OmniStream Change Password</title>')

    $results += [pscustomobject]@{
      Kind     = 'page'
      Path     = $p
      Code     = [int]$r.StatusCode
      ShellCss = [bool]$hasShellCss
      ShellJs  = [bool]$hasShellJs
      Login    = [bool]$isLogin
      ChangePw = [bool]$isChangePw
    }
  } catch {
    $results += [pscustomobject]@{
      Kind     = 'page'
      Path     = $p
      Code     = 'ERR'
      ShellCss = $false
      ShellJs  = $false
      Login    = $false
      ChangePw = $false
      Error    = $_.Exception.Message
    }
  }
}

foreach ($a in $assets) {
  $url = "$BaseUrl/$a"
  try {
    $r = Get-Ok $url $sess
    $ct = ($r.Headers['Content-Type'] | Select-Object -First 1)
    $results += [pscustomobject]@{ Kind='asset'; Path=$a; Code=[int]$r.StatusCode; ContentType=$ct }
  } catch {
    $results += [pscustomobject]@{ Kind='asset'; Path=$a; Code='ERR'; ContentType=''; Error=$_.Exception.Message }
  }
}

$results | Sort-Object Kind, Path | Format-Table -AutoSize | Out-String -Width 260 | Write-Output

$bad = $results | Where-Object {
  $_.Code -ne 200 -or
  ($_.Kind -eq 'page' -and ($_.Login -or $_.ChangePw -or (-not $_.ShellCss) -or (-not $_.ShellJs)))
}

if ($bad) {
  Write-Output "\nFAILURES:"
  $bad | Format-Table -AutoSize | Out-String -Width 260 | Write-Output
  exit 1
}

Write-Output "\nSmoke sweep OK."
