Option Explicit

Dim shell, nodePath, daemonPath, marker, command, exitCode
Set shell = CreateObject("WScript.Shell")

If WScript.Arguments.Count < 3 Then WScript.Quit 2
nodePath = WScript.Arguments.Item(0)
daemonPath = WScript.Arguments.Item(1)
marker = WScript.Arguments.Item(2)
command = Chr(34) & nodePath & Chr(34) & " " & Chr(34) & daemonPath & Chr(34) & " " & marker

exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode
