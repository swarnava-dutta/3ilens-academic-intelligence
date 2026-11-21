# Process helper for start.bat / stop.bat (Windows PowerShell 5.1+).
#
#   -Action Stop                     stop the 3iLens backend (uvicorn) and frontend (next dev)
#   -Action IsOurs -Port N           exit 0 when every program listening on port N is a 3iLens
#                                    server from this folder
#   -Action Pick -From A -To B -Kind backend|frontend
#                                    choose the port for a server: a 3iLens server from this
#                                    folder already listening on A..B is reused, else the first
#                                    free port is taken. Exit code: the port to start on, the
#                                    port + 10000 to reuse a running server, 0 = all ports busy.
#   -Action Start -Kind backend|frontend -Port N
#                                    open the "3iLens API :N" / "3iLens Web :N" server window.
#                                    Started through the Windows shell, so the window does not
#                                    inherit start.bat's lock on .start.lock (see start.bat).
#
# Ownership is decided from the listening PROCESS, never from what the port answers (another
# app may proxy its requests to a 3iLens port): the listener, or one of its first parents,
# must have a command line pointing into <root>\backend or <root>\frontend. Another program
# on port 8000/3000 is reported and left running. Stop kills the whole 3iLens launch tree
# (server window -> npm/python -> workers), which also closes the server windows.
# Several processes can listen on one port (uvicorn sets SO_REUSEADDR), so every listener on a
# port is looked at, not only the first one.
param(
    [Parameter(Mandatory = $true)][string]$Root,
    [ValidateSet('Stop', 'IsOurs', 'Pick', 'Start')][string]$Action = 'Stop',
    [int]$Port = 0,
    [int]$From = 0,
    [int]$To = 0,
    [ValidateSet('', 'backend', 'frontend')][string]$Kind = '',
    [int[]]$Ports = @((8000..8009) + (3000..3009))
)

$ErrorActionPreference = 'Stop'
$rootFull = [IO.Path]::GetFullPath($Root.Trim('"')).TrimEnd('\')
$ourDirs = @("$rootFull\backend", "$rootFull\frontend")

if ($Action -eq 'Start') {
    if ($Kind -eq 'backend') {
        $dir = Join-Path $rootFull 'backend'
        $py = Join-Path $dir '.venv\Scripts\python.exe'
        $line = "title 3iLens API :$Port & `"$py`" -m uvicorn main:app --reload --port $Port"
    } elseif ($Kind -eq 'frontend') {
        $dir = Join-Path $rootFull 'frontend'
        # npm and node come from PATH, which this window inherits from start.bat.
        $line = "title 3iLens Web :$Port & npm run dev -- --port $Port"
    } else {
        Write-Host '  [error] -Kind backend or -Kind frontend is needed.'
        exit 1
    }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = Join-Path $env:SystemRoot 'System32\cmd.exe'
    # cmd /k "<line>": cmd removes the outer quotes and runs <line> as typed.
    $psi.Arguments = '/k "' + $line + '"'
    $psi.WorkingDirectory = $dir
    $psi.UseShellExecute = $true
    try { $null = [Diagnostics.Process]::Start($psi) } catch {
        Write-Host ('  [error] Could not open the server window: ' + $_.Exception.Message)
        exit 1
    }
    exit 0
}

if ($Action -eq 'IsOurs') { $Ports = @($Port) }
if ($Action -eq 'Pick') { $Ports = @($From..$To) }

$procs = @{}
foreach ($p in Get-CimInstance Win32_Process) { $procs[[int]$p.ProcessId] = $p }

function Get-Cmd([int]$procId) {
    $p = $procs[$procId]
    if ($null -eq $p -or $null -eq $p.CommandLine) { return '' }
    return [string]$p.CommandLine
}

function Test-Ours([int]$procId) {
    $cmd = Get-Cmd $procId
    foreach ($dir in $ourDirs) {
        if ($cmd.IndexOf($dir, [StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
    }
    return $false
}

function Test-ServerProcess([int]$procId) {
    # Part of a 3iLens server launch (not the launcher scripts, not the user's own shell).
    $p = $procs[$procId]
    if ($null -eq $p) { return $false }
    if (@('cmd.exe', 'node.exe', 'python.exe', 'pythonw.exe') -notcontains $p.Name.ToLower()) { return $false }
    $cmd = Get-Cmd $procId
    if ($cmd -match '(?i)start\.bat|stop\.bat|server-processes\.ps1') { return $false }
    if (Test-Ours $procId) { return $true }
    return $cmd -match '(?i)uvicorn\s+main:app|\brun\s+dev\b|\bnext"?\s+dev\b|next[\\/]dist[\\/]'
}

function Get-Parent([int]$procId) {
    $p = $procs[$procId]
    if ($null -eq $p) { return $null }
    $parent = $procs[[int]$p.ParentProcessId]
    # Guard against PID reuse: a real parent is older than its child.
    if ($null -eq $parent -or $parent.CreationDate -gt $p.CreationDate) { return $null }
    return [int]$parent.ProcessId
}

function Test-OurListener([int]$procId) {
    # The listener or one of its first four parents points into this project.
    $cur = $procId
    for ($i = 0; $i -lt 5 -and $null -ne $cur; $i++) {
        if (Test-Ours $cur) { return $true }
        $cur = Get-Parent $cur
    }
    return $false
}

# Listening TCP sockets on the candidate ports -> every owning PID. Both sources are read:
# Get-NetTCPConnection sometimes reports only one of several sockets on the same port.
$listeners = @{}
function Add-Listener([int]$LocalPort, [int]$procId) {
    if ($Ports -notcontains $LocalPort -or $procId -le 0) { return }
    if (-not $listeners.ContainsKey($LocalPort)) { $listeners[$LocalPort] = New-Object 'System.Collections.Generic.List[int]' }
    if (-not $listeners[$LocalPort].Contains($procId)) { $listeners[$LocalPort].Add($procId) }
}
try {
    foreach ($c in Get-NetTCPConnection -State Listen -ErrorAction Stop) { Add-Listener ([int]$c.LocalPort) ([int]$c.OwningProcess) }
} catch { }
try {
    foreach ($line in @(netstat.exe -ano -p TCP) + @(netstat.exe -ano -p TCPv6)) {
        # "  TCP  127.0.0.1:8000  0.0.0.0:0  LISTENING  1234" - the state word is translated on
        # non-English Windows, so a listener is recognised by its foreign address instead.
        $f = @(([string]$line).Trim() -split '\s+')
        if ($f.Count -lt 5 -or $f[0] -ne 'TCP') { continue }
        if ($f[2] -ne '0.0.0.0:0' -and $f[2] -ne '[::]:0') { continue }
        $lp = 0; $owner = 0
        if ([int]::TryParse(($f[1] -split ':')[-1], [ref]$lp) -and [int]::TryParse($f[-1], [ref]$owner)) { Add-Listener $lp $owner }
    }
} catch { }

function Test-PortOurs([int]$LocalPort) {
    # Every listener on the port belongs to this 3iLens folder.
    if (-not $listeners.ContainsKey($LocalPort)) { return $false }
    foreach ($procId in $listeners[$LocalPort]) { if (-not (Test-OurListener $procId)) { return $false } }
    return $true
}

if ($Action -eq 'IsOurs') {
    if (Test-PortOurs $Port) { exit 0 }
    exit 1
}

if ($Action -eq 'Pick') {
    $label = if ($Kind -eq 'frontend') { 'frontend' } else { 'backend' }
    # 1. A 3iLens server from this folder is already running: reuse it, even when a lower port
    #    has become free in the meantime (starting a second copy would split the app in two).
    foreach ($p in $From..$To) {
        if (Test-PortOurs $p) {
            Write-Host " [info]  A 3iLens $label is already running on port $p - reusing it."
            exit (10000 + $p)
        }
    }
    # 2. Otherwise the first free port.
    foreach ($p in $From..$To) {
        if (-not $listeners.ContainsKey($p)) { exit $p }
        Write-Host " [info]  Port $p is used by another program - trying the next port."
    }
    exit 0
}

$roots = [ordered]@{}
foreach ($port in ($listeners.Keys | Sort-Object)) {
    foreach ($procId in $listeners[$port]) {
        $name = if ($procs[$procId]) { $procs[$procId].Name } else { 'unknown' }
        if (-not (Test-OurListener $procId)) {
            if ($port -in 8000, 3000) {
                Write-Host "  [skip] Port $port is used by another program ($name, PID $procId) - left running."
            }
            continue
        }

        # Climb to the top of the 3iLens launch tree (e.g. the "3iLens API" window's cmd.exe).
        $top = $procId
        $parent = Get-Parent $top
        while ($null -ne $parent -and (Test-ServerProcess $parent)) {
            $top = $parent
            $parent = Get-Parent $top
        }
        $kindText = if ($name -eq 'node.exe') { 'frontend' } else { 'backend' }
        $key = [string]$top   # string keys: an [int] index on an ordered dictionary means "position"
        if (-not $roots.Contains($key)) { $roots[$key] = "$kindText on port $port" }
    }
}

if ($roots.Count -eq 0) {
    Write-Host "  No 3iLens servers are running."
    exit 0
}

$failed = 0
foreach ($key in @($roots.Keys)) {
    $label = $roots[$key]
    & taskkill.exe /PID ([int]$key) /T /F *> $null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  [ok]   Stopped the 3iLens $label (process tree $key)."
    } else {
        Write-Host "  [warn] Could not stop the 3iLens $label (PID $key) - close its window manually."
        $failed++
    }
}
exit $failed
