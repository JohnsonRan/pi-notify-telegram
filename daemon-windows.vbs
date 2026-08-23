Option Explicit

Dim shell, nodePath, daemonPath, command, exitCode
Set shell = CreateObject("WScript.Shell")

If WScript.Arguments.Count < 2 Then WScript.Quit 2
nodePath = WScript.Arguments.Item(0)
daemonPath = WScript.Arguments.Item(1)
command = Chr(34) & nodePath & Chr(34) & " " & Chr(34) & daemonPath & Chr(34)

exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode
