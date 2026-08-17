@echo off
setlocal enabledelayedexpansion

if "%~1"=="" (
    set /p MSG="Mensagem do commit: "
) else (
    set MSG=%*
)

if "!MSG!"=="" set MSG=update

echo === STATUS ===
git status --short

echo.
echo === ADD & COMMIT ===
git add -A
git commit -m "!MSG!"
if errorlevel 1 (
    echo Nada para commitar.
    goto :eof
)

echo.
echo === PUSH ===
git push -u origin master
echo.
echo Concluido.
