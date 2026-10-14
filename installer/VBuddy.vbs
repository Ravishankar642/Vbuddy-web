' Starts VBuddy in the notification area with no console window.
' "VBuddy.vbs quiet" (used at sign-in) doesn't open the VBuddy window.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
extra = ""
If WScript.Arguments.Count > 0 Then
  If LCase(WScript.Arguments(0)) = "quiet" Then extra = " -Quiet"
End If
sh.Run "powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & dir & "\tray.ps1""" & extra, 0, False
