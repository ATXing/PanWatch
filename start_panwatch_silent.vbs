' PanWatch autostart launcher - hidden window, no console flash
Option Explicit
Dim sh, fso, base, bat, q, lf, logdir
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
bat = base & "\start_panwatch_bg.bat"
If Not fso.FileExists(bat) Then
    WScript.Quit 1
End If
q = Chr(34)
' --- boot trace: prove this script actually fired ---
logdir = base & "\logs"
If Not fso.FolderExists(logdir) Then fso.CreateFolder logdir
Set lf = fso.OpenTextFile(logdir & "\vbs_boot.log", 8, True)
lf.WriteLine Now & "  [panwatch] vbs fired -> " & bat
lf.Close
' wait for network / Clash to settle (20000 ms)
WScript.Sleep 20000
sh.Run q & bat & q, 0, False
