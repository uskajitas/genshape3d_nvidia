Dim shell
Set shell = CreateObject("WScript.Shell")
shell.Run """C:\projects\genshape3d_nvidia\node_modules\electron\dist\electron.exe"" ""C:\projects\genshape3d_nvidia""", 0, False
Set shell = Nothing
