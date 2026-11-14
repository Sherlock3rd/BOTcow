Option Explicit

Dim shell, fso, scriptDir, watchdogPath, command, exitCode

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
watchdogPath = fso.BuildPath(scriptDir, "ensure-bridge-running.ps1")

command = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & watchdogPath & """"
exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode
