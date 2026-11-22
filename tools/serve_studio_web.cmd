@echo off
rem Dashcam Studio in a browser, served from this PC only. Close this window to stop it.
cd /d "%~dp0..\web\studio"
start "" http://127.0.0.1:8765
py -m http.server 8765 --bind 127.0.0.1
