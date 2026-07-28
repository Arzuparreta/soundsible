param(
    [Parameter(Mandatory = $true)]
    [string]$Installer,

    [Parameter(Mandatory = $true)]
    [string]$ArtifactDirectory,

    [switch]$UiSmoke
)

$ErrorActionPreference = "Stop"
$installerPath = (Resolve-Path $Installer).Path
$artifactPath = [System.IO.Path]::GetFullPath($ArtifactDirectory)
$installPath = Join-Path $env:RUNNER_TEMP "soundsible-ci-install"
$configPath = Join-Path $env:RUNNER_TEMP "soundsible-ci-config"

New-Item -ItemType Directory -Force -Path $artifactPath | Out-Null
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $installPath, $configPath

try {
    $install = Start-Process -FilePath $installerPath -ArgumentList @("/S", "/D=$installPath") -Wait -PassThru
    if ($install.ExitCode -ne 0) {
        throw "NSIS installation failed with exit code $($install.ExitCode)"
    }

    $app = Get-ChildItem -Path $installPath -Filter "soundsible-desktop.exe" -Recurse | Select-Object -First 1
    if (-not $app) {
        $app = Get-ChildItem -Path $installPath -Filter "Soundsible.exe" -Recurse | Select-Object -First 1
    }
    if (-not $app) {
        throw "Installed Soundsible executable not found under $installPath"
    }
    $sidecar = Get-ChildItem -Path $installPath -Filter "soundsible-engine.exe" -Recurse | Select-Object -First 1
    $ffmpeg = Get-ChildItem -Path $installPath -Filter "ffmpeg.exe" -Recurse | Select-Object -First 1
    if (-not $sidecar -or -not $ffmpeg) {
        throw "Installed sidecar or FFmpeg is missing"
    }

    $manifest = @{
        installer = $installerPath
        app = $app.FullName
        sidecar = $sidecar.FullName
        ffmpeg = $ffmpeg.FullName
        install_dir = $installPath
    }
    $manifest | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $artifactPath "installed-files.json")

    if ($UiSmoke) {
        python (Join-Path $PSScriptRoot "windows_ui_smoke.py") `
            --app $app.FullName `
            --artifacts (Join-Path $artifactPath "ui")
        if ($LASTEXITCODE -ne 0) {
            throw "Windows UI smoke failed with exit code $LASTEXITCODE"
        }
        if (Get-Process "soundsible-engine" -ErrorAction SilentlyContinue) {
            throw "Engine process remained after Soundsible quit"
        }
    }
    else {
        $env:SOUNDSIBLE_CONFIG_DIR = $configPath
        $process = Start-Process -FilePath $app.FullName -PassThru
        Start-Sleep -Seconds 3
        if ($process.HasExited) {
            throw "Installed application exited during launch"
        }
        Stop-Process -Id $process.Id -Force
    }

    $uninstaller = Get-ChildItem -Path $installPath -Filter "uninstall.exe" -Recurse | Select-Object -First 1
    if (-not $uninstaller) {
        throw "NSIS uninstaller not found"
    }
    $uninstall = Start-Process -FilePath $uninstaller.FullName -ArgumentList "/S" -Wait -PassThru
    if ($uninstall.ExitCode -ne 0) {
        throw "NSIS uninstall failed with exit code $($uninstall.ExitCode)"
    }
    if (Test-Path $app.FullName) {
        throw "Application executable remains after uninstall"
    }
}
finally {
    Get-Process "soundsible-desktop", "soundsible-engine" -ErrorAction SilentlyContinue |
        Stop-Process -Force -ErrorAction SilentlyContinue
}
