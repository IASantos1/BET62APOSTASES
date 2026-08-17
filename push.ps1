$ErrorActionPreference = "Stop"

if ($args.Count -gt 0) {
    $msg = $args -join " "
} else {
    $msg = Read-Host "Mensagem do commit"
    if ([string]::IsNullOrWhiteSpace($msg)) { $msg = "update" }
}

Write-Host "=== STATUS ===" -ForegroundColor Cyan
git status --short

Write-Host "`n=== ADD & COMMIT ===" -ForegroundColor Cyan
git add -A
& git commit -m $msg
if ($LASTEXITCODE -ne 0) {
    Write-Host "Nada para commitar ou commit falhou."
    exit $LASTEXITCODE
}

Write-Host "`n=== PUSH ===" -ForegroundColor Cyan
& git push -u origin master
Write-Host "`nConcluido." -ForegroundColor Green
