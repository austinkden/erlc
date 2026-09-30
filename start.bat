@echo off
echo ========================================================
echo   Starting ERLC Road Network Studio
echo   URL: http://localhost:5173
echo ========================================================
start "" "http://localhost:5173"
python -m http.server 5173
pause
