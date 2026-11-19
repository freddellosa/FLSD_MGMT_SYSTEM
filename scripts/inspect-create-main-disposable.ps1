#requires -Version 5.1
param([Parameter(Mandatory=$true)][ValidatePattern('^[a-z_][a-z0-9_]{0,62}$')][string]$DatabaseUser,[switch]$Create,[switch]$Interactive)
$ErrorActionPreference='Stop'
$taskRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if($taskRoot -cne 'D:\FLSD-Batch7-Validation'){throw 'Wrong workspace'}
. (Join-Path $PSScriptRoot 'main-disposable-safety.ps1')
$null=Assert-MainLocalPath $PSCommandPath
$taskRunner={param($tool,$user,$database,$extra,$interactive,$readOnly) Invoke-MainPg -Tool $tool -User $user -Database $database -Extra $extra -Interactive:$interactive -ReadOnly:$readOnly}
$taskResult=Invoke-MainCreationSequence -DatabaseUser $DatabaseUser -Create ([bool]$Create) -Interactive ([bool]$Interactive) -ArtifactDirectory (Join-Path $taskRoot 'artifacts') -Runner $taskRunner
Write-Output $taskResult.status
if($Create){Write-Output ('Limited application role: '+$taskResult.user+'; no password assigned or stored. No schema applied.')}
