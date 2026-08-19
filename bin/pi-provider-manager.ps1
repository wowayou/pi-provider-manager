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
} elseif (Test-ProjectDirectory (Get-Location).Path) {
    $projectDir = (Get-Location).Path
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
    throw "Pi Provider Manager project not found: $projectDir"
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
if (-not (Test-ManagerPort $port)) {
    New-Item -ItemType Directory -Path $agentDir -Force | Out-Null
    $logOut = Join-Path $agentDir "pi-provider-manager-ui.log"
    $logError = Join-Path $agentDir "pi-provider-manager-ui.error.log"
    $previous = @{}
    $launchEnvironment = @{
        PI_PROVIDER_MANAGER_PORT = [string]$port
        PI_PROVIDER_MANAGER_SERVE_UI = "1"
        PI_PROVIDER_MANAGER_AGENT_DIR_SOURCE = $agentDirSource
        PI_CODING_AGENT_DIR = $agentDir
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

if ($env:PI_PROVIDER_MANAGER_OPEN_BROWSER -eq "0") {
    Write-Output "Pi Provider Manager is ready: $url"
} else {
    Start-Process $url
}
