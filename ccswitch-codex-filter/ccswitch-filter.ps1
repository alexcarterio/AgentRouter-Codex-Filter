[CmdletBinding()]
param(
    [ValidateSet('Start', 'Stop', 'Status', 'Logs', 'Run', 'Test')]
    [string]$Action = 'Status',
    [ValidateRange(1024, 65535)]
    [int]$Port = 18181,
    [string]$Upstream,
    [string]$Config,
    [string]$Runtime,
    [string]$CcDb
)
$ErrorActionPreference = 'Stop'
$nodeCommand = Get-Command node -ErrorAction Stop
if ($Action -eq 'Test') {
    & $nodeCommand.Source --test (Join-Path $PSScriptRoot 'filter.test.cjs') (Join-Path $PSScriptRoot 'retry.test.cjs') (Join-Path $PSScriptRoot 'dashboard.test.cjs')
} else {
    $operation = $Action.ToLowerInvariant()
    if ($Action -eq 'Run') { $operation = 'serve' }
    $filterArguments = @((Join-Path $PSScriptRoot 'filter.cjs'), $operation, '--port', $Port.ToString())
    if ($Upstream) { $filterArguments += @('--upstream', $Upstream) }
    if ($Config) { $filterArguments += @('--config', $Config) }
    if ($Runtime) { $filterArguments += @('--runtime', $Runtime) }
    if ($CcDb) { $filterArguments += @('--cc-db', $CcDb) }
    & $nodeCommand.Source @filterArguments
}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
