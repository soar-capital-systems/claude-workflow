$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Distro = 'Ubuntu-24.04'
$NodeVersion = '24.16.0'
$LinuxWorkspace = '/opt/claude-workflow-ci'
$env:WSL_UTF8 = '1'

function Invoke-NativeCommand {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$ArgumentList
  )

  & $FilePath @ArgumentList
  if ($LASTEXITCODE -ne 0) {
    throw "$FilePath exited with status $LASTEXITCODE"
  }
}

function Invoke-WslBash {
  param(
    [Parameter(Mandatory = $true)][string]$Script,
    [string[]]$ScriptArguments = @()
  )

  $normalizedScript = $Script.Replace("`r`n", "`n").Replace("`r", "`n")
  $arguments = @('-d', $Distro, '-u', 'root', '--', 'bash', '-s', '--')
  $arguments += $ScriptArguments
  $normalizedScript | & wsl.exe @arguments
  if ($LASTEXITCODE -ne 0) {
    throw "wsl.exe exited with status $LASTEXITCODE"
  }
}

function Get-WslVerboseListing {
  $listing = ((& wsl.exe --list --verbose | Out-String) -replace "`0", '')
  if ($LASTEXITCODE -ne 0) {
    throw "wsl.exe --list --verbose exited with status $LASTEXITCODE"
  }
  return $listing
}

function ConvertTo-WslPath {
  param(
    [Parameter(Mandatory = $true)][string]$WindowsPath
  )

  if ($WindowsPath -match "[`r`n]") {
    throw 'Windows workspace path must occupy one line.'
  }
  $translated = $WindowsPath |
    & wsl.exe -d $Distro -u root -- bash -lc 'IFS= read -r windows_path; wslpath -u "$windows_path"'
  $translationStatus = $LASTEXITCODE
  $linuxPath = (($translated | Out-String) -replace "`0", '').Trim()
  if ($translationStatus -ne 0 -or -not $linuxPath) {
    throw "Could not translate the Windows workspace into a WSL path (status $translationStatus)."
  }
  return $linuxPath
}

Invoke-NativeCommand -FilePath 'wsl.exe' -ArgumentList @('--set-default-version', '2')
$installedText = ((& wsl.exe --list --quiet | Out-String) -replace "`0", '').Trim()
if ($LASTEXITCODE -ne 0) {
  throw "wsl.exe --list --quiet exited with status $LASTEXITCODE"
}
$installedDistros = @($installedText -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($installedDistros -notcontains $Distro) {
  Invoke-NativeCommand -FilePath 'wsl.exe' -ArgumentList @(
    '--install',
    '--distribution', $Distro,
    '--web-download',
    '--no-launch'
  )
}

# Starting the distro once completes registration before version inspection.
Invoke-NativeCommand -FilePath 'wsl.exe' -ArgumentList @('-d', $Distro, '-u', 'root', '--', 'true')
$escapedDistro = [Regex]::Escape($Distro)
$wsl2Pattern = "(?m)^\s*\*?\s*$escapedDistro\s+\S+\s+2\s*$"
$verboseListing = Get-WslVerboseListing
if ($verboseListing -notmatch $wsl2Pattern) {
  Invoke-NativeCommand -FilePath 'wsl.exe' -ArgumentList @('--terminate', $Distro)
  & wsl.exe --set-version $Distro 2
  $conversionStatus = $LASTEXITCODE
  $verboseListing = Get-WslVerboseListing
  if ($conversionStatus -ne 0 -and $verboseListing -notmatch $wsl2Pattern) {
    throw "wsl.exe --set-version exited with status $conversionStatus and $Distro is not WSL 2:`n$verboseListing"
  }
}
if ($verboseListing -notmatch $wsl2Pattern) {
  throw "$Distro was not registered as WSL 2:`n$verboseListing"
}

$mountedWorkspace = ConvertTo-WslPath -WindowsPath $env:GITHUB_WORKSPACE

Invoke-WslBash -Script @'
set -euo pipefail
source_path="$1"
workspace="$2"
node_version="$3"
[[ -n "$source_path" && -n "$workspace" && -n "$node_version" ]] || {
  echo 'WSL smoke arguments must be nonempty.' >&2
  exit 1
}

export DEBIAN_FRONTEND=noninteractive
apt-get -o Acquire::Retries=3 update -qq
apt-get -o Acquire::Retries=3 install -y -qq --no-install-recommends ca-certificates curl git xz-utils

# Recreate the checked-out commit through Git so executable bits come from the
# index, not from the synthetic Unix modes exposed by the Windows mount.
rm -rf -- "$workspace"
mkdir -p -- "$workspace"
git config --global --add safe.directory "$source_path"
git -C "$source_path" archive --format=tar HEAD | tar -xf - -C "$workspace"
test -x "$workspace/scripts/claude-workflow-daemon.sh"
test ! -x "$workspace/package.json"

case "$(uname -m)" in
  x86_64)
    node_arch="x64"
    node_sha256="d804845d34eddc21dc1092b519d643ef40b1f58ec5dec5c22b1f4bd8fabde6c9"
    ;;
  aarch64|arm64)
    node_arch="arm64"
    node_sha256="524659219d6a207a7400f2bde15d19ba060ffbe0d32a8643319ad67e3bb64c78"
    ;;
  *) echo "unsupported WSL architecture: $(uname -m)" >&2; exit 1 ;;
esac
archive="node-v${node_version}-linux-${node_arch}.tar.xz"
download_root="https://nodejs.org/dist/v${node_version}"
temporary_directory="$(mktemp -d)"
trap 'rm -rf -- "$temporary_directory"' EXIT
cd "$temporary_directory"
curl \
  --fail \
  --silent \
  --show-error \
  --location \
  --retry 3 \
  --retry-delay 2 \
  --retry-all-errors \
  --remote-name \
  "${download_root}/${archive}"
printf '%s  %s\n' "$node_sha256" "$archive" | sha256sum --check --strict -
tar -xJf "$archive" -C /usr/local --strip-components=1

node --version
npm --version
cd "$workspace"
bash test/wsl-smoke.sh
'@ -ScriptArguments @($mountedWorkspace, $LinuxWorkspace, $NodeVersion)
