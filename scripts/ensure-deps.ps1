# Dependency helper for start.bat (Windows PowerShell 5.1+). Needs no admin rights.
#
#   -Action Backend   Python 3.11+ (installs Python 3.13 for the current user when none is found),
#                     backend\.venv (created, or recreated when its python.exe does not run) and the
#                     packages from backend\requirements.txt. pip runs when the venv is new, when
#                     requirements.txt changed since the last successful install (SHA-256 stamp in
#                     backend\.venv\.requirements.sha256), or when scripts\check-requirements.py
#                     finds a required package (or one it needs) missing, at a wrong version or
#                     with missing files.
#   -Action Frontend  Node.js 20.9+ with npm: the system Node.js - the node.exe and npm that come
#                     first on PATH, because those are what "npm run dev" and Next.js will run on -
#                     else a portable Node.js in <root>\.tools\node (downloaded and
#                     SHA-256-verified on first use), and frontend\node_modules: npm ci / npm
#                     install when it is missing, when package.json / package-lock.json changed
#                     since the last successful install (stamp in
#                     frontend\node_modules\.3ilens-deps.sha256) or when "npm ls" reports missing
#                     packages.
#
# Exit codes: 0 = ready
#             1 = failed (the reason and what to do by hand are printed)
#             2 = ready, using the portable Node.js in .tools\node (start.bat puts it on PATH)
#             3 = Python dry run finished, nothing was installed
#
# Test switches (environment variables, documented in start.bat):
#   THREEILENS_FORCE_NODE_INSTALL=1      ignore the system Node.js, use/install .tools\node
#   THREEILENS_FORCE_PYTHON_MISSING=1    ignore every installed Python (the install then runs!)
#   THREEILENS_DRY_RUN_PYTHON_INSTALL=1  print the Python install commands instead of running them
param(
    [Parameter(Mandatory = $true)][ValidateSet('Backend', 'Frontend')][string]$Action,
    [string]$Root = ''
)

# Native programs report failures through exit codes; 'Stop' would turn their stderr into errors.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
$Root = [IO.Path]::GetFullPath($Root.Trim('"')).TrimEnd('\')
$Backend = Join-Path $Root 'backend'
$Frontend = Join-Path $Root 'frontend'
$Tools = Join-Path $Root '.tools'
$Downloads = Join-Path $Tools 'downloads'

function Test-Switch([string]$Name) {
    return ([string][Environment]::GetEnvironmentVariable($Name)).Trim() -eq '1'
}
$ForceNode = Test-Switch 'THREEILENS_FORCE_NODE_INSTALL'
$ForcePythonMissing = Test-Switch 'THREEILENS_FORCE_PYTHON_MISSING'
$DryRunPython = Test-Switch 'THREEILENS_DRY_RUN_PYTHON_INSTALL'

# ---------------------------------------------------------------------------------------------
# Pinned versions. Update the version AND its SHA-256 together.
# ---------------------------------------------------------------------------------------------
$MinPython = [version]'3.11'
$PyVersion = '3.13.17'                 # last 3.13 release with Windows installers (2026-10-21)
$PyWingetId = 'Python.Python.3.13'
$PyUrl = "https://www.python.org/ftp/python/$PyVersion/python-$PyVersion-amd64.exe"
# From https://www.python.org/downloads/release/python-31317/ (same value in the winget manifest)
$PySha256 = '5da012101ba2e17113a9a1cd901e9ce1441086f2b7ecb5de06ec94163899a190'
$PyInstallDir = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python313'
$PyInstallerArgs = @('/quiet', 'InstallAllUsers=0', 'PrependPath=1', 'Include_launcher=1',
    'InstallLauncherAllUsers=0', 'Include_test=0', 'Include_doc=0')

$MinNode = [version]'20.9.0'          # Next.js 16 needs Node.js >= 20.9
$NodeVersion = '24.22.3'               # LTS "Krypton" (2026-11-10 security release)
$NodeName = "node-v$NodeVersion-win-x64"
$NodeUrl = "https://nodejs.org/dist/v$NodeVersion/$NodeName.zip"
# From https://nodejs.org/dist/v24.22.3/SHASUMS256.txt
$NodeSha256 = 'e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f'
$PortableNodeDir = Join-Path $Tools 'node'

# Imported once after every pip install, as a final check that the packages really load.
$BackendImports = 'fastapi, uvicorn, sqlalchemy, pydantic, anthropic, openai, python_multipart, dotenv, PIL, pymupdf, httpx'
$CheckScript = Join-Path $PSScriptRoot 'check-requirements.py'

# A download that receives less than 1 KB/s for this many seconds is aborted (then retried).
$DownloadStallSec = 60

# ---------------------------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------------------------
function Say([string]$Tag, [string]$Text) {
    # Same layout as the echo lines in start.bat: " [tag]   text"
    Write-Host (' {0,-7} {1}' -f $Tag, $Text)
}

function Invoke-Probe([string]$Exe, [string]$Arguments, [int]$TimeoutSec = 60) {
    # Runs a program without a window and returns its exit code and output, or $null when it
    # cannot be started or does not finish in time.
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $Exe
    $psi.Arguments = $Arguments
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.WorkingDirectory = $Root
    try { $p = [Diagnostics.Process]::Start($psi) } catch { return $null }
    $out = $p.StandardOutput.ReadToEndAsync()
    $err = $p.StandardError.ReadToEndAsync()
    if (-not $p.WaitForExit($TimeoutSec * 1000)) {
        try { $p.Kill() } catch { }
        return $null
    }
    $p.WaitForExit()
    return [pscustomobject]@{ Code = $p.ExitCode; Out = [string]$out.Result; Err = [string]$err.Result }
}

function Invoke-Tool([string]$Exe, [string[]]$ArgList) {
    # Runs a console program in this window and returns its exit code. "| Out-Host" sends its
    # output to the console instead of into the caller's return value.
    $global:LASTEXITCODE = 1
    try { & $Exe @ArgList | Out-Host } catch { Say '[error]' $_.Exception.Message; return 1 }
    return $LASTEXITCODE
}

function Get-Sha256([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Read-Stamp([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return '' }
    return ([string](Get-Content -LiteralPath $Path -TotalCount 1)).Trim()
}

function Remove-Download([string]$Path) {
    # Deletes a download (used or bad), and .tools\downloads and .tools once they are empty.
    if ($Path) { Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue }
    foreach ($dir in $Downloads, $Tools) {
        if ((Test-Path -LiteralPath $dir) -and
            -not (Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue)) {
            Remove-Item -LiteralPath $dir -Force -ErrorAction SilentlyContinue
        }
    }
}

function Remove-Tree([string]$Path) {
    # Antivirus scanners briefly lock freshly written files, so retry a few times.
    for ($i = 0; $i -lt 4; $i++) {
        if (-not (Test-Path -LiteralPath $Path)) { return $true }
        Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
        if (-not (Test-Path -LiteralPath $Path)) { return $true }
        Start-Sleep -Seconds 2
    }
    return -not (Test-Path -LiteralPath $Path)
}

function Format-CommandLine([string]$Exe, [string[]]$ArgList) {
    $parts = @('"' + $Exe + '"')
    foreach ($a in $ArgList) {
        if ($a -match '\s' -and $a -notmatch '"') { $parts += '"' + $a + '"' } else { $parts += $a }
    }
    return $parts -join ' '
}

function Update-SessionPath {
    # An installer updates PATH in the registry only; pick that up for this process.
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = (@($env:Path, $user, $machine) | Where-Object { $_ }) -join ';'
}

function Save-Download([string]$Url, [string]$Dest) {
    $part = "$Dest.part"
    Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue
    $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
    if (Test-Path -LiteralPath $curl) {
        # --speed-limit/--speed-time: a stalled connection (captive portal, broken proxy) is
        # aborted instead of hanging; that counts as a timeout, so --retry tries again.
        $rc = Invoke-Tool $curl @('-fL', '-#', '--retry', '2', '--retry-delay', '2', '--connect-timeout', '30',
            '--speed-limit', '1024', '--speed-time', [string]$DownloadStallSec, '-o', $part, $Url)
        if ($rc -eq 0 -and (Test-Path -LiteralPath $part)) {
            Move-Item -LiteralPath $part -Destination $Dest -Force
            return $true
        }
        Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue
        Say '[info]' 'curl could not download it - retrying with PowerShell (uses the Windows proxy settings)...'
    }
    $resp = $null
    $in = $null
    $out = $null
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        $req = [Net.HttpWebRequest]::Create($Url)
        $req.Timeout = 30000                              # connect + response headers
        $req.ReadWriteTimeout = $DownloadStallSec * 1000  # each read of the body
        $req.UserAgent = '3iLens-launcher'
        if ($req.Proxy) { $req.Proxy.Credentials = [Net.CredentialCache]::DefaultNetworkCredentials }
        $resp = $req.GetResponse()
        $in = $resp.GetResponseStream()
        $out = [IO.File]::Create($part)
        $in.CopyTo($out)
        $out.Close(); $out = $null
        Move-Item -LiteralPath $part -Destination $Dest -Force
        return $true
    } catch {
        Say '[warn]' ('Download failed: ' + $_.Exception.Message)
        return $false
    } finally {
        if ($out) { $out.Close() }
        if ($in) { $in.Close() }
        if ($resp) { $resp.Close() }
        Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue
    }
}

function Get-VerifiedDownload([string]$Url, [string]$Sha256, [string]$What) {
    # Downloads $Url into .tools\downloads and returns its path, or $null when the download fails
    # or the file does not have the pinned SHA-256 (a bad file is deleted, never used).
    New-Item -ItemType Directory -Force -Path $Downloads | Out-Null
    $dest = Join-Path $Downloads ([IO.Path]::GetFileName($Url))
    if (Test-Path -LiteralPath $dest) {
        if ((Get-Sha256 $dest) -eq $Sha256) {
            Say '[info]' "Re-using the verified download $dest"
            return $dest
        }
        Remove-Item -LiteralPath $dest -Force -ErrorAction SilentlyContinue
    }
    Say '[....]' "Downloading $Url"
    if (-not (Save-Download $Url $dest)) {
        Remove-Download $null
        Say '[error]' "Could not download $What."
        Say '' 'Check the internet connection (proxy, firewall, offline?) and run start.bat again.'
        return $null
    }
    $actual = Get-Sha256 $dest
    if ($actual -ne $Sha256) {
        Remove-Download $dest
        Say '[error]' "The download of $What failed its SHA-256 check, so it was deleted and NOT used."
        Say '' "expected $Sha256"
        Say '' "got      $actual"
        Say '' 'The file was damaged in transit or changed by something on the network.'
        Say '' 'Run start.bat again; if this keeps happening, install it by hand (see below).'
        return $null
    }
    Say '[ok]' "Download verified (SHA-256 $Sha256)."
    return $dest
}

# ---------------------------------------------------------------------------------------------
# Python
# ---------------------------------------------------------------------------------------------
function Show-PythonManual {
    Say '' "To install Python by hand: download Python $PyVersion (64-bit) from"
    Say '' "  https://www.python.org/downloads/release/python-$($PyVersion -replace '\.', '')/"
    Say '' 'run it, tick "Add python.exe to PATH", then run start.bat again.'
}

function Test-PythonCandidate([string]$Exe, [string]$PrefixArgs = '') {
    # Returns @{ Version; Exe = sys.executable } when $Exe is a working Python, else $null.
    $code = "import sys; print('3ILENS-PY %d.%d.%d' % tuple(sys.version_info[:3])); print(sys.executable)"
    $r = Invoke-Probe $Exe ("$PrefixArgs -I -c `"$code`"").Trim() 60
    if ($null -eq $r -or $r.Code -ne 0) { return $null }
    $lines = @($r.Out -split "`r?`n" | Where-Object { $_.Trim() -ne '' })
    if ($lines.Count -lt 2) { return $null }
    if ($lines[0].Trim() -match '^3ILENS-PY (\d+)\.(\d+)\.(\d+)$') {
        return [pscustomobject]@{
            Version = [version]("{0}.{1}.{2}" -f $Matches[1], $Matches[2], $Matches[3])
            Exe     = $lines[1].Trim()
        }
    }
    return $null
}

function Test-StoreStub([string]$Exe) {
    # %LOCALAPPDATA%\Microsoft\WindowsApps\python.exe is only a shortcut that opens the Microsoft
    # Store, unless a Python app from the Store provides it: Python 3.x itself
    # (PythonSoftwareFoundation.Python.3.*) or the Python install manager
    # (PythonSoftwareFoundation.PythonManager_*), whose package folders then exist. Even when this
    # check misses, the shortcut is only ever run with arguments, which makes it exit with 9009
    # without opening the Store, so Test-PythonCandidate rejects it.
    $apps = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps'
    if (-not $Exe.StartsWith($apps + '\', [StringComparison]::OrdinalIgnoreCase)) { return $false }
    if ((Split-Path -Parent $Exe) -ne $apps) { return $false }
    $pkg = @(Get-ChildItem -LiteralPath $apps -Directory -Filter 'PythonSoftwareFoundation.Python*' -ErrorAction SilentlyContinue)
    return $pkg.Count -eq 0
}

function Get-PythonCandidates {
    $list = New-Object 'System.Collections.Generic.List[object]'
    $seen = @{}
    $add = {
        param([string]$Exe, [string]$Prefix)
        if (-not $Exe -or -not (Test-Path -LiteralPath $Exe)) { return }
        $key = ($Exe + '|' + $Prefix).ToLowerInvariant()
        if ($seen.ContainsKey($key)) { return }
        $seen[$key] = $true
        $list.Add([pscustomobject]@{ Exe = $Exe; Prefix = $Prefix })
    }
    # 1. the py launcher (newest Python 3), 2. python / python3 on PATH, 3. the usual folders
    foreach ($c in @(Get-Command py.exe -CommandType Application -All -ErrorAction SilentlyContinue)) { & $add $c.Source '-3' }
    & $add (Join-Path $env:LOCALAPPDATA 'Programs\Python\Launcher\py.exe') '-3'
    & $add (Join-Path $env:SystemRoot 'py.exe') '-3'
    foreach ($name in 'python.exe', 'python3.exe') {
        foreach ($c in @(Get-Command $name -CommandType Application -All -ErrorAction SilentlyContinue)) { & $add $c.Source '' }
    }
    # python.org installers: ...\Python313; Python install manager: %LOCALAPPDATA%\Python\pythoncore-3.14-64
    $dirs = @((Join-Path $env:LOCALAPPDATA 'Programs\Python'), (Join-Path $env:LOCALAPPDATA 'Python'), $env:ProgramFiles, "$env:SystemDrive\")
    $found = foreach ($d in $dirs) {
        if ($d -and (Test-Path -LiteralPath $d)) {
            foreach ($sub in @(Get-ChildItem -LiteralPath $d -Directory -ErrorAction SilentlyContinue)) {
                if ($sub.Name -match '^(Python3|pythoncore-3\.)(\d+)') {
                    [pscustomobject]@{ Minor = [int]$Matches[2]; Exe = Join-Path $sub.FullName 'python.exe' }
                }
            }
        }
    }
    foreach ($f in @($found | Sort-Object Minor -Descending)) { & $add $f.Exe '' }
    return $list
}

function Find-Python([switch]$Quiet) {
    foreach ($c in (Get-PythonCandidates)) {
        if (Test-StoreStub $c.Exe) {
            if (-not $Quiet) { Say '[info]' "Ignoring $($c.Exe) - it is the Microsoft Store shortcut, not an installed Python." }
            continue
        }
        $r = Test-PythonCandidate $c.Exe $c.Prefix
        if ($null -eq $r) { continue }
        if ($r.Version -lt $MinPython) {
            if (-not $Quiet) { Say '[info]' "Ignoring Python $($r.Version) at $($r.Exe) - $MinPython or newer is needed." }
            continue
        }
        return $r
    }
    return $null
}

function Find-InstalledPython {
    # Right after an install PATH is stale, so look in the install folder first.
    $exe = Join-Path $PyInstallDir 'python.exe'
    if (Test-Path -LiteralPath $exe) {
        $r = Test-PythonCandidate $exe
        if ($r -and $r.Version -ge $MinPython) { return $r }
    }
    # With THREEILENS_FORCE_PYTHON_MISSING=1 an already installed Python must not count as the
    # result of the install, or the python.org fallback would never be exercised.
    if ($ForcePythonMissing) { return $null }
    Update-SessionPath
    return Find-Python -Quiet
}

function Install-Python {
    $winget = Get-Command winget.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $wingetArgs = @('install', '-e', '--id', $PyWingetId, '--scope', 'user', '--architecture', 'x64', '--silent',
        '--accept-package-agreements', '--accept-source-agreements', '--source', 'winget',
        '--disable-interactivity', '--custom', '"InstallLauncherAllUsers=0 Include_test=0"')
    $installer = Join-Path $Downloads "python-$PyVersion-amd64.exe"
    # The log goes to %TEMP%, so .tools\downloads is left empty (and removed) after the install.
    $log = Join-Path ([IO.Path]::GetTempPath()) "3ilens-python-$PyVersion-install.log"
    $installerArgs = $PyInstallerArgs + @("/log `"$log`"")

    if ($DryRunPython) {
        Say '[dry-run]' 'THREEILENS_DRY_RUN_PYTHON_INSTALL=1 - showing the Python install, NOT running it.'
        if ($winget) {
            Say '[dry-run]' "Step 1 - winget was found ($($winget.Source)), it would run:"
            Say '' (Format-CommandLine 'winget' $wingetArgs)
            Say '[dry-run]' 'Step 2 - only if step 1 fails or finds no Python afterwards:'
        } else {
            Say '[dry-run]' 'winget is not available, so it would go straight to the python.org installer:'
        }
        Say '' "download  $PyUrl"
        Say '' "to        $installer"
        Say '' "verify    SHA-256 $PySha256"
        Say '' '          and the Authenticode signature (Python Software Foundation)'
        Say '' 'then run:'
        Say '' (Format-CommandLine $installer $installerArgs)
        Say '[dry-run]' "Afterwards it would use $(Join-Path $PyInstallDir 'python.exe') to create backend\.venv"
        Say '' '(only when backend\.venv is missing or broken - a working one is kept).'
        exit 3
    }

    if ($winget) {
        Say '[setup]' "Installing Python $PyVersion for the current user with winget - this can take a few minutes..."
        Say '' (Format-CommandLine 'winget' $wingetArgs)
        $p = Start-Process -FilePath $winget.Source -ArgumentList $wingetArgs -NoNewWindow -PassThru
        $null = $p.Handle   # keeps ExitCode available after the wait
        $p.WaitForExit()
        $py = Find-InstalledPython
        if ($py) { return $py }
        Say '[warn]' "winget did not install a usable Python (exit code $($p.ExitCode)) - using the python.org installer instead."
    } else {
        Say '[info]' 'winget is not available - using the official python.org installer.'
    }

    $exe = Get-VerifiedDownload $PyUrl $PySha256 "the Python $PyVersion installer"
    if (-not $exe) { Show-PythonManual; return $null }
    try {
        $sig = Get-AuthenticodeSignature -LiteralPath $exe
        if ($sig.Status -eq 'Valid' -and $sig.SignerCertificate.Subject -match 'Python Software Foundation') {
            Say '[ok]' 'Installer signature verified (Python Software Foundation).'
        } else {
            Say '[warn]' "Could not confirm the installer signature ($($sig.Status)); the SHA-256 matched, continuing."
        }
    } catch {
        Say '[warn]' 'Could not check the installer signature; the SHA-256 matched, continuing.'
    }
    Say '[setup]' "Running the Python $PyVersion installer for the current user (silent, no admin needed)..."
    Say '' (Format-CommandLine $exe $installerArgs)
    $p = Start-Process -FilePath $exe -ArgumentList $installerArgs -PassThru
    $null = $p.Handle
    $p.WaitForExit()
    if (@(0, 3010) -notcontains $p.ExitCode) {
        Say '[error]' "The Python installer failed with exit code $($p.ExitCode). Log: $log"
        Show-PythonManual
        return $null
    }
    $py = Find-InstalledPython
    if (-not $py) {
        Say '[error]' "Python $PyVersion was installed, but its python.exe was not found in $PyInstallDir."
        Show-PythonManual
        return $null
    }
    Remove-Download $exe
    return $py
}

function Resolve-BasePython {
    $py = $null
    if ($ForcePythonMissing) {
        Say '[test]' 'THREEILENS_FORCE_PYTHON_MISSING=1 - acting as if no Python were installed.'
    } else {
        $py = Find-Python
    }
    if ($py) {
        Say '[ok]' "Found Python $($py.Version): $($py.Exe)"
        return $py
    }
    Say '[setup]' "Python $MinPython or newer was not found - installing Python $PyVersion for the current user."
    $py = Install-Python
    if ($py) { Say '[ok]' "Python $($py.Version) is installed: $($py.Exe)" }
    return $py
}

function Install-BackendPackages([string]$VenvPy, [string]$Requirements, [string[]]$Reinstall = @()) {
    $pip = Invoke-Probe $VenvPy '-I -c "import pip"' 60
    if ($null -eq $pip -or $pip.Code -ne 0) {
        Say '[setup]' 'pip is missing in backend\.venv - adding it...'
        $null = Invoke-Tool $VenvPy @('-m', 'ensurepip', '--upgrade', '--default-pip')
    }
    $pipArgs = @('-m', 'pip', 'install', '--disable-pip-version-check', '--prefer-binary', '-r', $Requirements)
    if ((Invoke-Tool $VenvPy $pipArgs) -ne 0) {
        Say '[warn]' 'pip failed - upgrading pip and trying once more...'
        $null = Invoke-Tool $VenvPy @('-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', 'pip')
        if ((Invoke-Tool $VenvPy $pipArgs) -ne 0) { return $false }
    }
    $Reinstall = @($Reinstall | Where-Object { $_ })
    if ($Reinstall.Count -gt 0) {
        # Damaged packages count as installed for "pip install -r"; put back the same version.
        Say '[setup]' ('Reinstalling damaged packages: ' + ($Reinstall -join ', '))
        $fixArgs = @('-m', 'pip', 'install', '--disable-pip-version-check', '--prefer-binary', '--force-reinstall', '--no-deps') + $Reinstall
        if ((Invoke-Tool $VenvPy $fixArgs) -ne 0) { return $false }
    }
    return $true
}

function Get-BackendProblem([string]$VenvPy, [string]$Requirements) {
    # $null when every requirement (with what it needs, extras and version pins included) is
    # installed with all its files. Otherwise Text (for the "[setup] ... (reason)" line) and
    # Reinstall: "name==version" of damaged packages, which "pip install -r" would not repair.
    $r = Invoke-Probe $VenvPy "-I `"$CheckScript`" `"$Requirements`"" 120
    if ($null -eq $r) { return [pscustomobject]@{ Text = 'the package check did not finish'; Reinstall = @() } }
    if ($r.Code -eq 0) { return $null }
    $lines = @(($r.Out + "`n" + $r.Err) -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    $reinstall = @($lines | Where-Object { $_ -like 'REINSTALL *' } | ForEach-Object { $_.Substring(10).Trim() })
    $lines = @($lines | Where-Object { $_ -notlike 'REINSTALL *' })
    $text = 'some backend packages are missing or broken'
    if ($lines.Count -gt 0) {
        $text = 'missing or broken: ' + (($lines | Select-Object -First 3) -join '; ')
        if ($lines.Count -gt 3) { $text += '; ...' }
    }
    return [pscustomobject]@{ Text = $text; Reinstall = $reinstall }
}

function Invoke-Backend {
    $venvDir = Join-Path $Backend '.venv'
    $venvPy = Join-Path $venvDir 'Scripts\python.exe'
    $requirements = Join-Path $Backend 'requirements.txt'
    $stampFile = Join-Path $venvDir '.requirements.sha256'

    $venv = $null
    $state = 'missing'
    if (Test-Path -LiteralPath $venvPy) {
        $venv = Test-PythonCandidate $venvPy
        if ($venv -and $venv.Version -ge $MinPython) { $state = 'ok' } else { $state = 'broken' }
    } elseif (Test-Path -LiteralPath $venvDir) {
        $state = 'broken'
    }

    if ($state -ne 'ok' -or $ForcePythonMissing) {
        $base = Resolve-BasePython
        if (-not $base) { return 1 }
    }
    if ($state -ne 'ok') {
        if ($state -eq 'missing') {
            Say '[setup]' 'backend\.venv not found - creating the Python virtual environment...'
            $rc = Invoke-Tool $base.Exe @('-m', 'venv', $venvDir)
        } else {
            Say '[setup]' 'backend\.venv is broken (its python.exe does not run) - recreating it...'
            $rc = Invoke-Tool $base.Exe @('-m', 'venv', '--clear', $venvDir)
        }
        $venv = Test-PythonCandidate $venvPy
        if ($rc -ne 0 -or $null -eq $venv) {
            Say '[error]' 'Could not create the virtual environment in backend\.venv.'
            Say '' 'If a 3iLens API window is open, close it (or run stop.bat) and run start.bat again.'
            Say '' "Otherwise delete the folder $venvDir by hand and run start.bat again."
            return 1
        }
    }

    $want = Get-Sha256 $requirements
    $have = Read-Stamp $stampFile
    $reason = $null
    if ($state -ne 'ok') {
        $reason = 'new virtual environment'
    } elseif ($have -ne $want) {
        if ($have) { $reason = 'backend\requirements.txt changed since the last install' }
        else { $reason = 'checking backend\requirements.txt against backend\.venv' }
    }
    # Also after a requirements.txt change: pip install -r would not repair damaged packages.
    $problem = $null
    if ($state -eq 'ok') {
        $problem = Get-BackendProblem $venvPy $requirements
        if ($problem -and -not $reason) { $reason = $problem.Text }
    }
    $reinstall = @()
    if ($problem) { $reinstall = @($problem.Reinstall) }

    if ($reason) {
        Say '[setup]' "Installing backend packages from backend\requirements.txt ($reason)..."
        Say '' 'This can take a few minutes.'
        if (-not (Install-BackendPackages $venvPy $requirements $reinstall)) {
            Say '[error]' 'Installing the backend packages failed - see the pip output above.'
            Say '' 'Check the internet connection and run start.bat again. By hand:'
            Say '' "  `"$venvPy`" -m pip install -r `"$requirements`""
            return 1
        }
        $problem = Get-BackendProblem $venvPy $requirements
        $imports = Invoke-Probe $venvPy "-I -c `"import $BackendImports`"" 300
        if ($problem -or $null -eq $imports -or $imports.Code -ne 0) {
            Say '[error]' 'The backend packages were installed, but they are still incomplete:'
            if ($problem) { Say '' $problem.Text }
            if ($imports -and $imports.Code -ne 0) { ($imports.Err.Trim() -split "`r?`n") | Select-Object -Last 3 | ForEach-Object { Say '' $_ } }
            Say '' "Delete the folder $venvDir and run start.bat again."
            return 1
        }
        Set-Content -LiteralPath $stampFile -Value $want -Encoding Ascii
    }
    Say '[ok]' "Python environment ready (backend\.venv, Python $($venv.Version))."
    return 0
}

# ---------------------------------------------------------------------------------------------
# Node.js
# ---------------------------------------------------------------------------------------------
function Show-NodeManual {
    Say '' "To install Node.js by hand: install Node.js $($NodeVersion.Split('.')[0]) LTS from https://nodejs.org/"
    Say '' 'and run start.bat again. Or, without installing anything: download'
    Say '' "  $NodeUrl"
    Say '' "unzip it into $Tools and rename the unzipped folder $NodeName to node,"
    Say '' "so that $(Join-Path $PortableNodeDir 'node.exe') exists, then run start.bat again."
}

function Find-OnPath([string]$Name) {
    # The file cmd.exe runs for the command $Name: the first PATH folder that has $Name with one
    # of the PATHEXT extensions (tried in PATHEXT order). That is what "npm run dev" in the
    # frontend window and Next.js's node_modules\.bin\next.cmd ("node") will start.
    $exts = @(([string]$env:PATHEXT).Split(';') | Where-Object { $_ })
    if ($exts.Count -eq 0) { $exts = @('.COM', '.EXE', '.BAT', '.CMD') }
    foreach ($entry in ([string]$env:Path).Split(';')) {
        $dir = [Environment]::ExpandEnvironmentVariables($entry.Trim().Trim('"'))
        if (-not $dir) { continue }
        foreach ($ext in $exts) {
            try { $file = [IO.Path]::Combine($dir, $Name + $ext.ToLowerInvariant()) } catch { break }
            if ([IO.File]::Exists($file)) { return [IO.Path]::GetFullPath($file) }
        }
    }
    return $null
}

function Get-NodeVersion([string]$Exe) {
    $r = Invoke-Probe $Exe '--version' 30
    if ($null -eq $r -or $r.Code -ne 0) { return $null }
    if ($r.Out.Trim() -match '^v(\d+)\.(\d+)\.(\d+)') {
        return [version]("{0}.{1}.{2}" -f $Matches[1], $Matches[2], $Matches[3])
    }
    return $null
}

function Find-SystemNode {
    # Only the node and npm that come FIRST on PATH count: the frontend window runs "npm run dev"
    # and Next.js runs "node" from PATH, so a newer Node.js further down PATH would be checked
    # here but never used. When the first one is unsuitable, the portable Node.js is used and
    # start.bat puts it first on PATH (exit code 2).
    $exe = Find-OnPath 'node'
    if (-not $exe) { return $null }
    if ($exe.StartsWith($PortableNodeDir + '\', [StringComparison]::OrdinalIgnoreCase)) { return $null }
    $ver = Get-NodeVersion $exe
    if (-not $ver) {
        Say '[info]' "Ignoring $exe - it did not report a Node.js version."
        return $null
    }
    if ($ver -lt $MinNode) {
        Say '[info]' "Ignoring Node.js $ver at $exe (the first node on PATH) - $MinNode or newer is needed."
        return $null
    }
    $npm = Find-OnPath 'npm'
    if (-not $npm) {
        Say '[info]' "Ignoring Node.js $ver at $exe - npm is not on PATH."
        return $null
    }
    $npmDir = Split-Path -Parent $npm
    $cli = Join-Path $npmDir 'node_modules\npm\bin\npm-cli.js'
    if (-not (Test-Path -LiteralPath $cli)) {
        Say '[info]' "Ignoring Node.js $ver at $exe - the npm on PATH ($npm) is not a standard npm install."
        return $null
    }
    # npm.cmd runs the node.exe next to it when there is one, else the first node on PATH.
    $runner = $exe
    $npmNode = Join-Path $npmDir 'node.exe'
    if ((Test-Path -LiteralPath $npmNode) -and -not [string]::Equals($npmNode, $exe, [StringComparison]::OrdinalIgnoreCase)) {
        $npmVer = Get-NodeVersion $npmNode
        if (-not $npmVer -or $npmVer -lt $MinNode) {
            Say '[info]' "Ignoring Node.js $ver at $exe - the npm on PATH ($npm) runs on Node.js $npmVer at $npmNode; $MinNode or newer is needed."
            return $null
        }
        $runner = $npmNode
    }
    return [pscustomobject]@{ Exe = $runner; Dir = (Split-Path -Parent $exe); NpmCli = $cli; Version = $ver; Portable = $false }
}

function Get-PortableNode {
    $exe = Join-Path $PortableNodeDir 'node.exe'
    $cli = Join-Path $PortableNodeDir 'node_modules\npm\bin\npm-cli.js'
    if (-not (Test-Path -LiteralPath $exe) -or -not (Test-Path -LiteralPath $cli) -or
        -not (Test-Path -LiteralPath (Join-Path $PortableNodeDir 'npm.cmd'))) { return $null }
    $ver = Get-NodeVersion $exe
    if (-not $ver -or $ver -lt $MinNode) { return $null }
    return [pscustomobject]@{ Exe = $exe; Dir = $PortableNodeDir; NpmCli = $cli; Version = $ver; Portable = $true }
}

function Install-PortableNode {
    Say '[setup]' "Downloading a portable Node.js $NodeVersion LTS (about 36 MB) into .tools\node - no admin needed..."
    $zip = Get-VerifiedDownload $NodeUrl $NodeSha256 "Node.js $NodeVersion"
    if (-not $zip) { Show-NodeManual; return $null }

    $staging = Join-Path $Tools 'node-staging'
    if (-not (Remove-Tree $staging)) {
        Say '[error]' "Could not clear the folder $staging - delete it by hand and run start.bat again."
        return $null
    }
    Say '[....]' 'Unpacking Node.js...'
    try {
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [IO.Compression.ZipFile]::ExtractToDirectory($zip, $staging)
    } catch {
        Say '[error]' ('Could not unpack the Node.js zip: ' + $_.Exception.Message)
        $null = Remove-Tree $staging
        Show-NodeManual
        return $null
    }
    $unpacked = Join-Path $staging $NodeName
    if (-not (Remove-Tree $PortableNodeDir)) {
        Say '[error]' "Could not replace $PortableNodeDir - a program may still be using it."
        Say '' 'Close the 3iLens Web window (or run stop.bat) and run start.bat again.'
        return $null
    }
    $moved = $false
    for ($i = 0; $i -lt 5 -and -not $moved; $i++) {
        try {
            Move-Item -LiteralPath $unpacked -Destination $PortableNodeDir -ErrorAction Stop
            $moved = $true
        } catch {
            Start-Sleep -Seconds 2
        }
    }
    $null = Remove-Tree $staging
    $node = Get-PortableNode
    if (-not $moved -or -not $node) {
        Say '[error]' "The portable Node.js could not be set up in $PortableNodeDir."
        Show-NodeManual
        return $null
    }
    Remove-Download $zip
    Say '[ok]' "Portable Node.js $($node.Version) installed in .tools\node."
    return $node
}

function Resolve-Node {
    if ($ForceNode) {
        Say '[test]' 'THREEILENS_FORCE_NODE_INSTALL=1 - ignoring the system Node.js, using .tools\node.'
    } else {
        $node = Find-SystemNode
        if ($node) { return $node }
    }
    $node = Get-PortableNode
    if ($node) { return $node }
    if (-not $ForceNode) { Say '[setup]' "No usable Node.js $MinNode or newer with npm comes first on PATH - a portable Node.js is used instead." }
    return Install-PortableNode
}

function Get-NpmProblem($Node) {
    # Top-level packages that "npm ls" reports as missing or at a version package.json rejects.
    Push-Location -LiteralPath $Frontend
    $json = (& $Node.Exe $Node.NpmCli ls --depth=0 --json 2>$null) | Out-String
    Pop-Location
    try { $data = $json | ConvertFrom-Json } catch { return 'npm ls could not read frontend\node_modules' }
    if ($null -eq $data) { return 'npm ls could not read frontend\node_modules' }
    $bad = @()
    if ($data.dependencies) {
        foreach ($p in $data.dependencies.PSObject.Properties) {
            if ($p.Value.missing) { $bad += "$($p.Name) is missing" }
            elseif ($p.Value.invalid) { $bad += "$($p.Name) has a version package.json does not allow" }
        }
    }
    if ($bad.Count -gt 0) { return 'npm ls: ' + (($bad | Select-Object -First 3) -join ', ') }
    return $null
}

function Get-FrontendStamp {
    $lock = Join-Path $Frontend 'package-lock.json'
    $lockHash = 'none'
    if (Test-Path -LiteralPath $lock) { $lockHash = Get-Sha256 $lock }
    return 'package.json=' + (Get-Sha256 (Join-Path $Frontend 'package.json')) + ';package-lock.json=' + $lockHash
}

function Invoke-Frontend {
    $node = Resolve-Node
    if (-not $node) { return 1 }
    Say '[ok]' "Node.js $($node.Version): $($node.Exe)"
    # npm and the package install scripts must find this node.exe first.
    $env:Path = $node.Dir + ';' + $env:Path

    $lock = Join-Path $Frontend 'package-lock.json'
    $modules = Join-Path $Frontend 'node_modules'
    $stampFile = Join-Path $modules '.3ilens-deps.sha256'
    $want = Get-FrontendStamp
    $have = Read-Stamp $stampFile

    $cmd = $null
    $reason = $null
    if (-not (Test-Path -LiteralPath (Join-Path $modules 'next\package.json'))) {
        $reason = 'frontend\node_modules is missing'
        if ((Test-Path -LiteralPath $lock) -and -not (Test-Path -LiteralPath $modules)) { $cmd = 'ci' } else { $cmd = 'install' }
    } elseif ($have -and $have -ne $want) {
        $cmd = 'install'
        $reason = 'package.json or package-lock.json changed since the last install'
    } else {
        $problem = Get-NpmProblem $node
        if ($problem) {
            $cmd = 'install'
            $reason = $problem
        } elseif (-not $have) {
            Set-Content -LiteralPath $stampFile -Value $want -Encoding Ascii   # already complete
        }
    }

    if ($cmd) {
        Say '[setup]' "Installing frontend packages with npm $cmd ($reason)..."
        Say '' 'This can take a few minutes.'
        Push-Location -LiteralPath $Frontend
        $rc = Invoke-Tool $node.Exe @($node.NpmCli, $cmd, '--no-audit', '--no-fund')
        if ($rc -ne 0 -and $cmd -eq 'ci') {
            Say '[warn]' 'npm ci failed - trying npm install instead...'
            $rc = Invoke-Tool $node.Exe @($node.NpmCli, 'install', '--no-audit', '--no-fund')
        }
        Pop-Location
        if ($rc -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $modules 'next\package.json'))) {
            Say '[error]' "npm $cmd failed - see the npm output above."
            Say '' 'Check the internet connection and run start.bat again. By hand, in a new window:'
            Say '' "  cd /d `"$Frontend`""
            Say '' '  npm install'
            return 1
        }
        # Hashed again: npm install may have rewritten (or created) package-lock.json.
        Set-Content -LiteralPath $stampFile -Value (Get-FrontendStamp) -Encoding Ascii
    }
    Say '[ok]' 'Node.js environment ready (frontend\node_modules).'
    if ($node.Portable) { return 2 }
    return 0
}

# ---------------------------------------------------------------------------------------------
try {
    if ($Action -eq 'Backend') { $code = Invoke-Backend } else { $code = Invoke-Frontend }
} catch {
    Say '[error]' ('Unexpected problem in scripts\ensure-deps.ps1: ' + $_.Exception.Message)
    $code = 1
}
exit ([int]$code)
