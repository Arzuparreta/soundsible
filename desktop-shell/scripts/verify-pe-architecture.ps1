param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("x64", "arm64")]
    [string]$Architecture,

    [Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)]
    [string[]]$Paths
)

$ErrorActionPreference = "Stop"
$expected = if ($Architecture -eq "x64") { 0x8664 } else { 0xAA64 }

foreach ($path in $Paths) {
    $resolved = Resolve-Path $path
    $stream = [System.IO.File]::OpenRead($resolved)
    try {
        $reader = [System.IO.BinaryReader]::new($stream)
        if ($reader.ReadUInt16() -ne 0x5A4D) {
            throw "$resolved is not a PE executable"
        }
        $stream.Position = 0x3C
        $peOffset = $reader.ReadUInt32()
        $stream.Position = $peOffset
        if ($reader.ReadUInt32() -ne 0x00004550) {
            throw "$resolved has no PE signature"
        }
        $machine = $reader.ReadUInt16()
        if ($machine -ne $expected) {
            throw ("{0} has PE machine 0x{1:X4}; expected 0x{2:X4} ({3})" -f $resolved, $machine, $expected, $Architecture)
        }
        Write-Host ("Verified {0}: {1}" -f $Architecture, $resolved)
    }
    finally {
        $stream.Dispose()
    }
}
