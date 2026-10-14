# VBuddy tray host: runs the bridge hidden and puts an icon in the notification area.
# Started by VBuddy.vbs (no console window). Windows PowerShell 5.1 compatible.
param([switch]$Quiet)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$root   = Split-Path -Parent $MyInvocation.MyCommand.Path
$app    = Join-Path $root 'app\vbuddy-bridge.mjs'
$web    = Join-Path $root 'web'
$data   = Join-Path $env:APPDATA 'VBuddy'
$logDir = Join-Path $data 'logs'
$log    = Join-Path $logDir 'bridge.log'
$errLog = Join-Path $logDir 'bridge-error.log'
$ico    = Join-Path $root 'VBuddy.ico'
$lnk    = Join-Path ([Environment]::GetFolderPath('Startup')) 'VBuddy.lnk'
$version = ''
try { $version = (Get-Content (Join-Path $root 'VERSION.txt') -ErrorAction Stop | Select-Object -First 1).Trim() } catch { }

function Show-Error([string]$text) {
    [void][System.Windows.Forms.MessageBox]::Show($text, 'VBuddy', 'OK', 'Error')
}

# The VBuddy window: the bridge's own page (pairing code, addresses, relay switch), in an app-style Edge or Chrome
# window when one is installed, otherwise in the default browser.
function Open-Window([string]$port) {
    $url = 'http://localhost:' + $port + '/console.html'
    $roots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA) | Where-Object { $_ }
    foreach ($rel in @('Microsoft\Edge\Application\msedge.exe', 'Google\Chrome\Application\chrome.exe')) {
        foreach ($r in $roots) {
            $exe = Join-Path $r $rel
            if (Test-Path $exe) {
                try { Start-Process $exe -ArgumentList @('--app=' + $url, '--window-size=1180,780'); return } catch { }
            }
        }
    }
    Start-Process $url
}

# One tray icon at a time: a second start just opens the window.
$created = $false
$script:mutex = New-Object System.Threading.Mutex($true, 'Local\VBuddyTrayHost', [ref]$created)
if (-not $created) {
    Open-Window '4789'
    exit 0
}

# The bundled Node.js, or the one on PATH when run from a source folder.
$nodeExe = Join-Path $root 'node\node.exe'
if (-not (Test-Path $nodeExe)) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { $nodeExe = $cmd.Source } else { Show-Error 'VBuddy cannot start: node.exe was not found next to this file.'; exit 1 }
}
if (-not (Test-Path $app)) { Show-Error "VBuddy cannot start: $app is missing."; exit 1 }

$script:proc = $null
$script:stopping = $false
$script:reported = $false

function Get-LogText([string]$path) {
    try {
        $fs = [System.IO.File]::Open($path, 'Open', 'Read', 'ReadWrite')
        try { $sr = New-Object System.IO.StreamReader($fs); return $sr.ReadToEnd() } finally { $fs.Dispose() }
    } catch { return '' }
}

function Get-Port {
    $m = [regex]::Match((Get-LogText $log), 'http://localhost:(\d+)')
    if ($m.Success) { return $m.Groups[1].Value }
    return '4789'
}

function Start-Bridge {
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    foreach ($f in @($log, $errLog)) {
        if (Test-Path $f) { Move-Item $f "$f.old" -Force -ErrorAction SilentlyContinue }
    }
    $script:stopping = $false
    $script:reported = $false
    $argLine = '"' + $app + '" --web "' + $web + '"'
    $script:proc = Start-Process -FilePath $nodeExe -ArgumentList $argLine -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput $log -RedirectStandardError $errLog
}

function Stop-Bridge {
    $script:stopping = $true
    if ($script:proc -and -not $script:proc.HasExited) {
        & taskkill.exe /PID $script:proc.Id /T /F 2>&1 | Out-Null
    }
}

function Test-Running { return ($script:proc -and -not $script:proc.HasExited) }

function Open-Console { Open-Window (Get-Port) }
function Open-App { Start-Process ('http://localhost:' + (Get-Port) + '/') }

function Get-PhoneAddress {
    foreach ($m in [regex]::Matches((Get-LogText $log), 'http://(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d+)')) {
        if (-not $m.Groups[1].Value.StartsWith('127.')) { return $m.Value }
    }
    return $null
}

function Test-Autostart { return (Test-Path $lnk) }

function Set-Autostart([bool]$on) {
    if ($on) {
        $ws = New-Object -ComObject WScript.Shell
        $s = $ws.CreateShortcut($lnk)
        $s.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
        $s.Arguments = '"' + (Join-Path $root 'VBuddy.vbs') + '" quiet'
        $s.WorkingDirectory = $root
        $s.IconLocation = $ico
        $s.Save()
    } elseif (Test-Path $lnk) {
        Remove-Item $lnk -Force
    }
}

try {
    Start-Bridge
} catch {
    Show-Error ("VBuddy could not start the bridge:`n" + $_.Exception.Message)
    exit 1
}

# ---- tray icon and menu
$script:notify = New-Object System.Windows.Forms.NotifyIcon
$script:notify.Icon = New-Object System.Drawing.Icon($ico)
$script:notify.Text = 'VBuddy: starting'
$menu = New-Object System.Windows.Forms.ContextMenuStrip

$title = $menu.Items.Add("VBuddy $version")
$title.Enabled = $false
$status = $menu.Items.Add('Starting...')
$status.Enabled = $false
[void]$menu.Items.Add('-')

$miOpen = $menu.Items.Add('Open VBuddy window')
$miOpen.Font = New-Object System.Drawing.Font($miOpen.Font, [System.Drawing.FontStyle]::Bold)
$miOpen.add_Click({ Open-Console })
$miApp = $menu.Items.Add('Open VBuddy app in browser')
$miApp.add_Click({ Open-App })

$miAddr = $menu.Items.Add('Copy address for phone')
$miAddr.add_Click({
    $a = Get-PhoneAddress
    if ($a) {
        [System.Windows.Forms.Clipboard]::SetText($a)
        $script:notify.ShowBalloonTip(3000, 'VBuddy', "Copied $a", 'Info')
    } else {
        $script:notify.ShowBalloonTip(4000, 'VBuddy', 'No network address found yet. Is this PC on Wi-Fi or Ethernet?', 'Warning')
    }
})

$miCode = $menu.Items.Add('Show pairing code')
$miCode.add_Click({
    $ms = [regex]::Matches((Get-LogText $log), 'Pairing code for a new device: (\d{6})')
    if ($ms.Count -gt 0) {
        [void][System.Windows.Forms.MessageBox]::Show("Pairing code: " + $ms[$ms.Count - 1].Groups[1].Value + "`n`nType it on your phone's Cockpit tab. A code works for 10 minutes after VBuddy starts; open VBuddy on this PC to see a fresh one.", 'VBuddy', 'OK', 'Information')
    } else {
        [void][System.Windows.Forms.MessageBox]::Show('No code yet. Open VBuddy on this PC and look at the Cockpit tab.', 'VBuddy')
    }
})
[void]$menu.Items.Add('-')

$miSettings = $menu.Items.Add('Settings...')
$miSettings.add_Click({
    $f = Join-Path $data 'config.env'
    if (Test-Path $f) { Start-Process notepad.exe ('"' + $f + '"') }
    else { [void][System.Windows.Forms.MessageBox]::Show('The settings file is created the first time VBuddy starts. Try again in a moment.', 'VBuddy') }
})
$miLog = $menu.Items.Add('View log')
$miLog.add_Click({ if (Test-Path $log) { Start-Process notepad.exe ('"' + $log + '"') } })
$miFolder = $menu.Items.Add('Open data folder')
$miFolder.add_Click({ New-Item -ItemType Directory -Force -Path $data | Out-Null; Start-Process explorer.exe ('"' + $data + '"') })
[void]$menu.Items.Add('-')

$miAuto = $menu.Items.Add('Start with Windows')
$miAuto.CheckOnClick = $false
$miAuto.add_Click({ Set-Autostart (-not (Test-Autostart)) })
$miRestart = $menu.Items.Add('Restart VBuddy')
$miRestart.add_Click({
    Stop-Bridge
    Start-Sleep -Milliseconds 800
    try { Start-Bridge } catch { Show-Error ("Could not restart:`n" + $_.Exception.Message) }
})
$miExit = $menu.Items.Add('Exit VBuddy')
$miExit.add_Click({
    Stop-Bridge
    $script:notify.Visible = $false
    $script:notify.Dispose()
    [System.Windows.Forms.Application]::Exit()
})

$menu.add_Opening({ $miAuto.Checked = (Test-Autostart) })
$script:notify.ContextMenuStrip = $menu
$script:notify.add_DoubleClick({ Open-Console })
$script:notify.Visible = $true
$script:notify.ShowBalloonTip(4000, 'VBuddy', 'Running in the notification area. Double-click the icon to open the VBuddy window.', 'Info')

# ---- watch the bridge
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$script:windowShown = [bool]$Quiet
$timer.add_Tick({
    # First start (not at sign-in): show the window once the bridge is up.
    if (-not $script:windowShown -and (Test-Running) -and ((Get-LogText $log) -match 'http://localhost:\d+')) {
        $script:windowShown = $true
        Open-Console
    }
    if (Test-Running) {
        $script:notify.Text = 'VBuddy: running'
        $status.Text = 'Running'
    } elseif (-not $script:stopping) {
        $script:notify.Text = 'VBuddy: stopped'
        $status.Text = 'Stopped (see log)'
        if (-not $script:reported) {
            $script:reported = $true
            $why = (Get-LogText $errLog).Trim()
            if (-not $why) { $why = ((Get-LogText $log).Trim() -split "`n" | Select-Object -Last 3) -join ' ' }
            if ($why.Length -gt 200) { $why = $why.Substring(0, 200) }
            $script:notify.ShowBalloonTip(8000, 'VBuddy stopped', "$why`nUse Restart, or View log.", 'Error')
        }
    }
})
$timer.Start()

[System.Windows.Forms.Application]::Run()
$script:mutex.ReleaseMutex()
