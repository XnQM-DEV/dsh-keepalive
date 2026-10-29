' run-hidden.vbs -- start a program with NO console window (window style 0) and wait for it,
' so scheduled tasks never flash a window and steal focus from full-screen games.
' Used by dsh-keepalive tasks:  wscript.exe //B //Nologo run-hidden.vbs program [args...]
' Returns the program's exit code so the task result stays meaningful (9009 = could not start).
Option Explicit
Dim sh, i, cmd, rc
Set sh = CreateObject("WScript.Shell")
cmd = ""
For i = 0 To WScript.Arguments.Count - 1
  cmd = cmd & " """ & WScript.Arguments(i) & """"
Next
On Error Resume Next
rc = sh.Run(Trim(cmd), 0, True)
If Err.Number <> 0 Then rc = 9009
WScript.Quit rc
