param(
  [int]$Port = 3000,
  [int]$TimeoutSeconds = 45
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$projectPath = $PSScriptRoot.ToLowerInvariant()
$botPath = (Join-Path $PSScriptRoot 'bot.js').ToLowerInvariant()

function Get-FreeTcpPort {
  param(
    [int]$StartPort = 3000,
    [int]$MaxPort = 3100
  )

  for ($candidate = $StartPort; $candidate -le $MaxPort; $candidate++) {
    $isBusy = $false
    try {
      $connections = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalPort -eq $candidate }
      if ($connections) {
        $isBusy = $true
      }
    } catch {
      $netstatBusy = netstat -ano -p tcp | Select-String -Pattern ":$candidate\s" -SimpleMatch
      if ($netstatBusy) {
        $isBusy = $true
      }
    }

    if (-not $isBusy) {
      return $candidate
    }
  }

  throw "No free port found in range $StartPort-$MaxPort"
}

Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -eq 'node.exe' -and
    $_.CommandLine -and
    (
      $_.CommandLine.ToLowerInvariant().Contains('bot.js') -or
      $_.CommandLine.ToLowerInvariant().Contains($botPath) -or
      $_.CommandLine.ToLowerInvariant().Contains($projectPath)
    )
  } |
  ForEach-Object {
    Write-Host "Stopping previous bot process: $($_.ProcessId)" -ForegroundColor Yellow
    Stop-Process -Id $_.ProcessId -Force
  }

Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -eq 'cloudflared.exe' -and
    $_.CommandLine -and
    $_.CommandLine.ToLowerInvariant().Contains('tunnel') -and
    $_.CommandLine.ToLowerInvariant().Contains('http://127.0.0.1:')
  } |
  ForEach-Object {
    Write-Host "Stopping previous tunnel process: $($_.ProcessId)" -ForegroundColor Yellow
    Stop-Process -Id $_.ProcessId -Force
  }

Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -eq 'ssh.exe' -and
    $_.CommandLine -and
    $_.CommandLine.ToLowerInvariant().Contains('localhost.run')
  } |
  ForEach-Object {
    Write-Host "Stopping previous localhost.run process: $($_.ProcessId)" -ForegroundColor Yellow
    Stop-Process -Id $_.ProcessId -Force
  }

$selectedPort = Get-FreeTcpPort -StartPort $Port
Write-Host "Using local port: $selectedPort" -ForegroundColor Cyan

$cloudflaredCommand = Get-Command cloudflared -ErrorAction SilentlyContinue
$cloudflaredPath = if ($cloudflaredCommand) {
  $cloudflaredCommand.Source
} else {
  @(
    'C:\Program Files\cloudflared\cloudflared.exe',
    'C:\Program Files (x86)\cloudflared\cloudflared.exe'
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
}

if (-not $cloudflaredPath) {
  Write-Host 'cloudflared was not found.' -ForegroundColor Red
  Write-Host 'Install it with:' -ForegroundColor Yellow
  Write-Host '  winget install --id Cloudflare.cloudflared'
  exit 1
}

$cloudflaredProcess = $null
$localhostRunProcess = $null
$localTunnelProcess = $null
$publicUrl = $null
$lastLogPath = $null
$maxAttempts = 2

for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
  $runId = [guid]::NewGuid().ToString('N')
  $logPath = Join-Path $env:TEMP ("telegram-vacancy-cloudflared-$runId.log")
  $stdoutPath = Join-Path $env:TEMP ("telegram-vacancy-cloudflared-$runId.out.log")
  $stderrPath = Join-Path $env:TEMP ("telegram-vacancy-cloudflared-$runId.err.log")
  $lastLogPath = $logPath

  Write-Host "Starting cloudflared tunnel for http://127.0.0.1:$selectedPort ... (attempt $attempt/$maxAttempts)" -ForegroundColor Cyan

  $cloudflaredProcess = Start-Process -FilePath $cloudflaredPath -ArgumentList @(
    'tunnel',
    '--url',
    "http://127.0.0.1:$selectedPort",
    '--protocol',
    'http2',
    '--logfile',
    $logPath,
    '--no-autoupdate'
  ) -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)

  while ((Get-Date) -lt $deadline) {
    if (Test-Path $logPath) {
      $match = Select-String -Path $logPath -Pattern 'https://[-a-z0-9]+\.trycloudflare\.com' | Select-Object -First 1
      if ($match) {
        $publicUrl = $match.Matches[0].Value
        break
      }
    }

    if ($cloudflaredProcess.HasExited) {
      break
    }

    Start-Sleep -Milliseconds 500
  }

  if ($publicUrl) {
    break
  }

  $cloudflareTimeoutDetected = $false
  if (Test-Path $stderrPath) {
    $stderrText = Get-Content $stderrPath -Raw -ErrorAction SilentlyContinue
    if ($stderrText -and $stderrText -match 'context deadline exceeded|Client\.Timeout exceeded while awaiting headers') {
      $cloudflareTimeoutDetected = $true
    }
  }

  Write-Host 'cloudflared did not provide a public URL on this attempt.' -ForegroundColor Yellow
  if (Test-Path $logPath) {
    $tail = Get-Content $logPath -Tail 8 -ErrorAction SilentlyContinue
    if ($tail) {
      Write-Host 'Last cloudflared log lines:' -ForegroundColor DarkYellow
      $tail | ForEach-Object { Write-Host $_ -ForegroundColor DarkYellow }
    }
  }

  if (Test-Path $stderrPath) {
    $stderrTail = Get-Content $stderrPath -Tail 6 -ErrorAction SilentlyContinue
    if ($stderrTail) {
      Write-Host 'cloudflared stderr:' -ForegroundColor DarkYellow
      $stderrTail | ForEach-Object { Write-Host $_ -ForegroundColor DarkYellow }
    }
  }

  if (Test-Path $stdoutPath) {
    $stdoutTail = Get-Content $stdoutPath -Tail 6 -ErrorAction SilentlyContinue
    if ($stdoutTail) {
      Write-Host 'cloudflared stdout:' -ForegroundColor DarkYellow
      $stdoutTail | ForEach-Object { Write-Host $_ -ForegroundColor DarkYellow }
    }
  }

  if ($cloudflaredProcess -and -not $cloudflaredProcess.HasExited) {
    Stop-Process -Id $cloudflaredProcess.Id -Force
  }

  if ($attempt -lt $maxAttempts) {
    Start-Sleep -Seconds 2
  }

  if ($cloudflareTimeoutDetected) {
    Write-Host 'Cloudflare quick tunnel timeout detected. Switching to fallback tunnel.' -ForegroundColor Yellow
    break
  }
}

if (-not $publicUrl) {
  Write-Host 'Cloudflare quick tunnel is unavailable. Trying localhost.run fallback...' -ForegroundColor Yellow

  $sshRunId = [guid]::NewGuid().ToString('N')
  $sshStdoutPath = Join-Path $env:TEMP ("telegram-vacancy-localhostrun-$sshRunId.out.log")
  $sshStderrPath = Join-Path $env:TEMP ("telegram-vacancy-localhostrun-$sshRunId.err.log")

  $sshCommand = Get-Command ssh.exe -ErrorAction SilentlyContinue
  if (-not $sshCommand) {
    $sshCommand = Get-Command ssh -ErrorAction SilentlyContinue
  }

  if ($sshCommand) {
    $localhostRunProcess = Start-Process -FilePath $sshCommand.Source -ArgumentList @(
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ServerAliveInterval=30',
      '-R', "80:127.0.0.1:$selectedPort",
      'nokey@localhost.run'
    ) -PassThru -WindowStyle Hidden -RedirectStandardOutput $sshStdoutPath -RedirectStandardError $sshStderrPath

    $sshDeadline = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $sshDeadline) {
      if (Test-Path $sshStdoutPath) {
        $sshMatch = Select-String -Path $sshStdoutPath -Pattern 'https://[a-z0-9\.-]+' | Select-Object -First 1
        if ($sshMatch) {
          $publicUrl = $sshMatch.Matches[0].Value
          break
        }
      }

      if ($localhostRunProcess.HasExited) {
        break
      }

      Start-Sleep -Milliseconds 500
    }

    if (-not $publicUrl) {
      Write-Host 'localhost.run did not provide a public URL.' -ForegroundColor Yellow
      if (Test-Path $sshStderrPath) {
        $sshErr = Get-Content $sshStderrPath -Tail 10 -ErrorAction SilentlyContinue
        if ($sshErr) {
          Write-Host 'localhost.run stderr:' -ForegroundColor DarkYellow
          $sshErr | ForEach-Object { Write-Host $_ -ForegroundColor DarkYellow }
        }
      }

      if (Test-Path $sshStdoutPath) {
        $sshOut = Get-Content $sshStdoutPath -Tail 10 -ErrorAction SilentlyContinue
        if ($sshOut) {
          Write-Host 'localhost.run stdout:' -ForegroundColor DarkYellow
          $sshOut | ForEach-Object { Write-Host $_ -ForegroundColor DarkYellow }
        }
      }

      if ($localhostRunProcess -and -not $localhostRunProcess.HasExited) {
        Stop-Process -Id $localhostRunProcess.Id -Force
      }
    } else {
      Write-Host "Using localhost.run URL: $publicUrl" -ForegroundColor Green
    }
  }
}

if (-not $publicUrl) {
  Write-Host 'localhost.run is unavailable. Trying localtunnel fallback...' -ForegroundColor Yellow

  $ltRunId = [guid]::NewGuid().ToString('N')
  $ltStdoutPath = Join-Path $env:TEMP ("telegram-vacancy-localtunnel-$ltRunId.out.log")
  $ltStderrPath = Join-Path $env:TEMP ("telegram-vacancy-localtunnel-$ltRunId.err.log")

  $npxCommand = Get-Command npx.cmd -ErrorAction SilentlyContinue
  if (-not $npxCommand) {
    $npxCommand = Get-Command npx -ErrorAction SilentlyContinue
  }

  if (-not $npxCommand) {
    throw 'npx is not available, cannot start localtunnel fallback.'
  }

  $localTunnelProcess = Start-Process -FilePath $npxCommand.Source -ArgumentList @(
    '--yes',
    'localtunnel',
    '--port',
    "$selectedPort"
  ) -PassThru -WindowStyle Hidden -RedirectStandardOutput $ltStdoutPath -RedirectStandardError $ltStderrPath

  $ltDeadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $ltDeadline) {
    if (Test-Path $ltStdoutPath) {
      $ltMatch = Select-String -Path $ltStdoutPath -Pattern 'https://[a-z0-9-]+\.loca\.lt' | Select-Object -First 1
      if ($ltMatch) {
        $publicUrl = $ltMatch.Matches[0].Value
        break
      }
    }

    if ($localTunnelProcess.HasExited) {
      break
    }

    Start-Sleep -Milliseconds 500
  }

  if (-not $publicUrl) {
    Write-Host 'localtunnel did not provide a public URL.' -ForegroundColor Red
    if (Test-Path $ltStderrPath) {
      $ltErr = Get-Content $ltStderrPath -Tail 12 -ErrorAction SilentlyContinue
      if ($ltErr) {
        Write-Host 'localtunnel stderr:' -ForegroundColor DarkYellow
        $ltErr | ForEach-Object { Write-Host $_ -ForegroundColor DarkYellow }
      }
    }

    if (Test-Path $ltStdoutPath) {
      $ltOut = Get-Content $ltStdoutPath -Tail 12 -ErrorAction SilentlyContinue
      if ($ltOut) {
        Write-Host 'localtunnel stdout:' -ForegroundColor DarkYellow
        $ltOut | ForEach-Object { Write-Host $_ -ForegroundColor DarkYellow }
      }
    }

    throw "cloudflared, localhost.run and localtunnel could not generate a public URL. Last cloudflared log: $lastLogPath"
  }

  Write-Host "Using localtunnel URL: $publicUrl" -ForegroundColor Green
}

try {
  Write-Host "Public HTTPS URL: $publicUrl" -ForegroundColor Green
  Write-Host 'Starting Telegram bot with this MINIAPP_URL...' -ForegroundColor Cyan

  $env:PORT = [string]$selectedPort
  $env:MINIAPP_URL = $publicUrl

  npm start
}
finally {
  if ($localhostRunProcess -and -not $localhostRunProcess.HasExited) {
    Write-Host 'Stopping localhost.run tunnel...' -ForegroundColor Yellow
    Stop-Process -Id $localhostRunProcess.Id -Force
  }

  if ($localTunnelProcess -and -not $localTunnelProcess.HasExited) {
    Write-Host 'Stopping localtunnel...' -ForegroundColor Yellow
    Stop-Process -Id $localTunnelProcess.Id -Force
  }

  if ($cloudflaredProcess -and -not $cloudflaredProcess.HasExited) {
    Write-Host 'Stopping cloudflared...' -ForegroundColor Yellow
    Stop-Process -Id $cloudflaredProcess.Id -Force
  }
}