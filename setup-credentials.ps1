$ErrorActionPreference = "Stop"

$envFile = Join-Path $PSScriptRoot "env\.env"
if (-not (Test-Path $envFile)) {
    Write-Error "Arquivo env/.env nao encontrado. Cria-lo com GIT_TOKEN=seu_token_aqui"
    exit 1
}

$token = $null
Get-Content $envFile | ForEach-Object {
    $line = $_.Trim()
    if ($line -match '^GIT_TOKEN=(.+)$') {
        $token = $Matches[1].Trim()
    }
}

if ([string]::IsNullOrWhiteSpace($token)) {
    Write-Error "GIT_TOKEN nao encontrado no env/.env"
    exit 1
}

$remoteUrl = "https://$($token)@github.com/IASantos1/BET62APOSTASES.git"

& git remote set-url origin $remoteUrl
Write-Host "Remote 'origin' atualizado com token. git push deve funcionar agora." -ForegroundColor Green
