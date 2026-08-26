$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Test-ProjectDirectory([string]$Path) {
    $manifest = Join-Path $Path "package.json"
    if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { return $false }
    try {
        return (Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json).name -eq "pi-provider-manager-ui"
    } catch {
        return $false
    }
}

function Test-ManagerPort([int]$Port) {
    try {
        $state = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/state" -TimeoutSec 1
        return $state.compatibility.configMode -eq "preserve-unknown-fields"
    } catch {
        return $false
    }
}

# Set-StrictMode turns a reference to a property an object does not carry into a
# terminating error, and an instance older than this launcher need not carry
# every field it reads. Returns $null for anything absent.
function Read-Field($Object, [string]$Name) {
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if (-not $property) { return $null }
    return $property.Value
}

function Test-PortInUse([int]$Port) {
    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $connection = $client.ConnectAsync("127.0.0.1", $Port)
        return $connection.Wait(250) -and $client.Connected
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

$bundledProject = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
if ($env:PI_PROVIDER_MANAGER_PROJECT_DIR) {
    $projectDir = [System.IO.Path]::GetFullPath($env:PI_PROVIDER_MANAGER_PROJECT_DIR)
# ProviderPath, not Path: on a UNC location — `\\wsl.localhost\<distro>\...`, which
# is exactly how someone with a WSL checkout reaches it from PowerShell —
# `.Path` returns a `Microsoft.PowerShell.Core\FileSystem::`-prefixed string.
# Verified on PowerShell 7.6.3 that Test-Path and Join-Path both accept that
# form, so this is presentation, not behaviour: the prefix otherwise ends up in
# $projectDir and so in every path this script prints back.
} elseif (Test-ProjectDirectory (Get-Location).ProviderPath) {
    $projectDir = (Get-Location).ProviderPath
} elseif (Test-ProjectDirectory $bundledProject) {
    $projectDir = $bundledProject
} else {
    $projectDir = Join-Path $HOME "pi-provider-manager-ui"
}

$agentDirSource = "default-home"
if ($env:PI_CODING_AGENT_DIR) {
    $agentDir = [System.IO.Path]::GetFullPath($env:PI_CODING_AGENT_DIR)
    $agentDirSource = "PI_CODING_AGENT_DIR"
} else {
    $agentDir = Join-Path $HOME ".pi\agent"
}

# Handed to the detached process explicitly, for the same reason as the paths
# above: it does not inherit this session's environment.
$litellmBin = $env:PI_PROVIDER_MANAGER_LITELLM
if (-not $litellmBin) { $litellmBin = "" }

$codexDirSource = "default-home"
if ($env:PI_PROVIDER_MANAGER_CODEX_DIR) {
    $codexDir = [System.IO.Path]::GetFullPath($env:PI_PROVIDER_MANAGER_CODEX_DIR)
    $codexDirSource = "PI_PROVIDER_MANAGER_CODEX_DIR"
} elseif ($env:CODEX_HOME) {
    $codexDir = [System.IO.Path]::GetFullPath($env:CODEX_HOME)
    $codexDirSource = "CODEX_HOME"
} else {
    $codexDir = Join-Path $HOME ".codex"
}

$nodePath = $env:PI_PROVIDER_MANAGER_NODE
if (-not $nodePath) {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCommand) { $nodePath = $nodeCommand.Source }
}
if (-not $nodePath -or -not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
    throw "Node.js executable not found. Set PI_PROVIDER_MANAGER_NODE explicitly."
}

$serverPath = Join-Path $projectDir "server.mjs"
$clientPath = Join-Path $projectDir "dist\client\index.html"
if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) {
    # Naming only the path it settled on left the reader unable to tell which of
    # the four mechanisms above had chosen it, and so which one to correct. Kept
    # in step with the bash launcher deliberately: the two are read as one
    # command by anyone who moves between WSL and PowerShell.
    $tried = if ($env:PI_PROVIDER_MANAGER_PROJECT_DIR) { $env:PI_PROVIDER_MANAGER_PROJECT_DIR } else { "unset" }
    throw @"
Pi Provider Manager project not found: $projectDir
The launcher looks for the checkout in this order:
  1. PI_PROVIDER_MANAGER_PROJECT_DIR  ($tried)
  2. the current directory            ($((Get-Location).ProviderPath))
  3. the directory above this script  ($bundledProject)
  4. `$HOME\pi-provider-manager-ui      ($(Join-Path $HOME "pi-provider-manager-ui"))
Run it once against your checkout:
  `$env:PI_PROVIDER_MANAGER_PROJECT_DIR = "C:\path\to\checkout"; pwsh -File $PSCommandPath
"@
}

# The floor is declared once, in package.json's engines field, and read from
# there rather than repeated here — the same one-copy rule the bash launcher
# follows. Below it the failure being replaced is a syntax error from inside the
# server, which names neither Node nor its version.
$nodeFloor = $null
try {
    $declared = (Get-Content -LiteralPath (Join-Path $projectDir "package.json") -Raw | ConvertFrom-Json).engines.node
    if ($declared) {
        $majors = @()
        foreach ($alternative in ($declared -split "\|\|")) {
            $matched = [regex]::Match($alternative, "[0-9]+")
            if ($matched.Success) { $majors += [int]$matched.Value }
        }
        # The lowest major any alternative allows, so "^20 || ^18" is not read as
        # requiring 20.
        if ($majors.Count -gt 0) { $nodeFloor = ($majors | Measure-Object -Minimum).Minimum }
    }
} catch {
    # No engines field, or a manifest this script cannot parse. Inventing a floor
    # would turn every future Node into a refusal.
}
if ($nodeFloor) {
    $reportedVersion = & $nodePath --version
    $reportedMajor = [regex]::Match([string]$reportedVersion, "^v?([0-9]+)")
    if ($reportedMajor.Success -and [int]$reportedMajor.Groups[1].Value -lt $nodeFloor) {
        throw @"
Node.js $($reportedMajor.Groups[1].Value) is too old: this project needs $nodeFloor or newer.
  using: $nodePath
Upgrade Node, or point PI_PROVIDER_MANAGER_NODE at a newer one.
"@
    }
}
# The same trap the bash launcher warns about, and reachable the same way: a
# copy taken by hand keeps working after the checkout moves ahead of it, and a
# pre-0.3.0 copy still starts — it just stops handing the Codex directory and the
# LiteLLM path to the detached process. Content is compared rather than a version
# string, so there is no second copy of the version to maintain.
$checkoutLauncher = Join-Path $projectDir "bin\pi-provider-manager.ps1"
if ($PSCommandPath -and (Test-Path -LiteralPath $checkoutLauncher -PathType Leaf) -and
    [System.IO.Path]::GetFullPath($PSCommandPath) -ne [System.IO.Path]::GetFullPath($checkoutLauncher) -and
    (Get-Content -LiteralPath $PSCommandPath -Raw) -ne (Get-Content -LiteralPath $checkoutLauncher -Raw)) {
    Write-Warning @"
The launcher you ran is not the one in the checkout it is about to start.
  running:  $PSCommandPath
  checkout: $checkoutLauncher
An older copy still starts, but stops handing over the Codex directory and the
LiteLLM path, which breaks the managed bridge. Run the checkout's copy instead.
"@
}

if (-not (Test-Path -LiteralPath $clientPath -PathType Leaf)) {
    throw "Built UI not found. Download a release archive or run 'npm ci' and 'npm run build' in: $projectDir"
}

if ($env:PI_PROVIDER_MANAGER_PORT) {
    $parsedPort = 0
    if (-not [int]::TryParse($env:PI_PROVIDER_MANAGER_PORT, [ref]$parsedPort) -or $parsedPort -lt 1 -or $parsedPort -gt 65535) {
        throw "PI_PROVIDER_MANAGER_PORT must be an integer between 1 and 65535."
    }
    $port = $parsedPort
    if ((Test-PortInUse $port) -and -not (Test-ManagerPort $port)) {
        throw "Port $port is already used by another application. Choose a different PI_PROVIDER_MANAGER_PORT."
    }
} else {
    $port = 0
    foreach ($candidate in 43127..43146) {
        if ((Test-PortInUse $candidate) -and (Test-ManagerPort $candidate)) {
            $port = $candidate
            break
        }
    }
    if ($port -eq 0) {
        foreach ($candidate in 43127..43146) {
            if (-not (Test-PortInUse $candidate)) {
                $port = $candidate
                break
            }
        }
    }
    if ($port -eq 0) {
        throw "No free port found in 43127-43146. Set PI_PROVIDER_MANAGER_PORT explicitly."
    }
}

$url = "http://127.0.0.1:$port/"

# Reusing an already-running manager is the point of the port scan, but this
# launcher said nothing about it — and printed nothing at all when it opened a
# browser, so a blocked browser bridge left no port and no error on screen. The
# bash launcher reports both; someone who moves between WSL and PowerShell reads
# the two as one command.
$reused = Test-ManagerPort $port
if (-not $reused) {
    New-Item -ItemType Directory -Path $agentDir -Force | Out-Null
    $logOut = Join-Path $agentDir "pi-provider-manager-ui.log"
    $logError = Join-Path $agentDir "pi-provider-manager-ui.error.log"
    $previous = @{}
    $launchEnvironment = @{
        PI_PROVIDER_MANAGER_PORT = [string]$port
        PI_PROVIDER_MANAGER_SERVE_UI = "1"
        PI_PROVIDER_MANAGER_AGENT_DIR_SOURCE = $agentDirSource
        PI_CODING_AGENT_DIR = $agentDir
        PI_PROVIDER_MANAGER_CODEX_DIR = $codexDir
        PI_PROVIDER_MANAGER_CODEX_DIR_SOURCE = $codexDirSource
        PI_PROVIDER_MANAGER_LITELLM = $litellmBin
    }
    try {
        foreach ($entry in $launchEnvironment.GetEnumerator()) {
            $previous[$entry.Key] = [Environment]::GetEnvironmentVariable($entry.Key, "Process")
            [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, "Process")
        }
        Start-Process -FilePath $nodePath -ArgumentList "`"$serverPath`"" -WorkingDirectory $projectDir -WindowStyle Hidden -RedirectStandardOutput $logOut -RedirectStandardError $logError | Out-Null
    } finally {
        foreach ($entry in $previous.GetEnumerator()) {
            [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, "Process")
        }
    }

    $ready = $false
    foreach ($attempt in 1..40) {
        if (Test-ManagerPort $port) {
            $ready = $true
            break
        }
        Start-Sleep -Milliseconds 250
    }
    if (-not $ready) {
        throw "Pi Provider Manager failed to start. See $logOut and $logError"
    }
}

Write-Output "Pi Provider Manager is ready: $url"
if ($reused) {
    # A reused server is using whatever it was started with, which need not match
    # this shell. Report what it says about itself rather than what we computed,
    # or the directory lines would be a confident guess.
    $running = $null
    try {
        $running = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/state" -TimeoutSec 2
    } catch {}
    $compatibility = Read-Field $running "compatibility"
    $runningVersion = [string](Read-Field $compatibility "appVersion")
    $runningPid = [string](Read-Field $compatibility "servicePid")
    $suffix = ""
    if ($runningVersion) { $suffix = ", version $runningVersion" }
    Write-Output "  (reused the instance already running on this port$suffix)"
    Write-Output "  Pi config:    $([string](Read-Field $running 'agentDir'))"
    Write-Output "  Codex config: $([string](Read-Field (Read-Field $running 'codex') 'dir'))"
    Write-Output "  Restart it to pick up an upgrade: the version and directories above are the ones it started with."
    if ($runningPid) {
        Write-Output "    Stop-Process -Id $runningPid; & '$PSCommandPath'"
    } else {
        # An instance older than 0.3.0 does not report its process id, and
        # guessing one from this launcher's own directory names exactly the
        # directory a running instance is not in during an upgrade.
        Write-Output "    Could not determine its process id. Find it with: Get-Process node"
    }
} else {
    Write-Output "  Pi config:    $agentDir"
    Write-Output "  Codex config: $codexDir"
}
# Only worth a line when it is set: an empty value means "find litellm on PATH".
if ($litellmBin) { Write-Output "  LiteLLM:      $litellmBin" }

if ($env:PI_PROVIDER_MANAGER_OPEN_BROWSER -ne "0") {
    Start-Process $url
}
