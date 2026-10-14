# Stops a running VBuddy (tray host and bridge). Used by the installer before updating or removing it.
Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -and ($_.CommandLine -like '*vbuddy-bridge.mjs*' -or $_.CommandLine -like '*VBuddy*tray.ps1*') } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
