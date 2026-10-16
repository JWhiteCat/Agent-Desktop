param([Parameter(Mandatory = $true)][string]$ResultFile, [switch]$InjectOnly)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class ToolbarConsoleSmoke {
  [StructLayout(LayoutKind.Explicit, CharSet=CharSet.Unicode, Size=20)]
  public struct InputRecord {
    [FieldOffset(0)] public ushort EventType;
    [FieldOffset(4), MarshalAs(UnmanagedType.Bool)] public bool KeyDown;
    [FieldOffset(8)] public ushort Repeat;
    [FieldOffset(10)] public ushort VirtualKey;
    [FieldOffset(12)] public ushort ScanCode;
    [FieldOffset(14)] public char Character;
    [FieldOffset(16)] public uint ControlState;
  }
  [DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int id);
  [DllImport("kernel32.dll")] public static extern bool GetConsoleMode(IntPtr handle, out uint mode);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern bool ReadConsoleOutputCharacterW(IntPtr handle, StringBuilder text, uint length, uint origin, out uint read);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern bool WriteConsoleInputW(IntPtr handle, InputRecord[] records, uint length, out uint written);
  public static bool QueueEnter() {
    var record = new InputRecord { EventType=1, KeyDown=true, Repeat=1, VirtualKey=13, Character='\r' };
    uint written;
    return WriteConsoleInputW(GetStdHandle(-10), new[] {record}, 1, out written) && written == 1;
  }
}
'@
if ($InjectOnly) {
  Start-Sleep -Milliseconds 700
  $result = Get-Content -LiteralPath $ResultFile -Raw | ConvertFrom-Json
  $result.enterQueued = [ToolbarConsoleSmoke]::QueueEnter()
  [IO.File]::WriteAllText($ResultFile, ($result | ConvertTo-Json -Compress), [Text.Encoding]::UTF8)
  exit
}
Write-Host 'AGENT_DESKTOP_CONSOLE_SMOKE_OUTPUT'
[uint32]$mode = 0
[uint32]$read = 0
$text = New-Object Text.StringBuilder 120000
$stdinConsole = [ToolbarConsoleSmoke]::GetConsoleMode([ToolbarConsoleSmoke]::GetStdHandle(-10), [ref]$mode)
$stdoutConsole = [ToolbarConsoleSmoke]::GetConsoleMode([ToolbarConsoleSmoke]::GetStdHandle(-11), [ref]$mode)
$screenRead = [ToolbarConsoleSmoke]::ReadConsoleOutputCharacterW([ToolbarConsoleSmoke]::GetStdHandle(-11), $text, 120000, 0, [ref]$read)
$result = @{ stdinConsole=$stdinConsole; stdoutConsole=$stdoutConsole; visibleOutput=($screenRead -and $text.ToString().Contains('AGENT_DESKTOP_CONSOLE_SMOKE_OUTPUT')); enterQueued=$false }
[IO.File]::WriteAllText($ResultFile, ($result | ConvertTo-Json -Compress), [Text.Encoding]::UTF8)
$arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -ResultFile "' + $ResultFile + '" -InjectOnly'
$injector = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $arguments -NoNewWindow -PassThru
if (!$result.stdinConsole -or !$result.stdoutConsole -or !$result.visibleOutput) { exit 3 }
