; Best installer customisations.
; Sharp text on high-DPI screens (otherwise Windows bitmap-stretches the whole installer).
ManifestDPIAware true

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Welcome to Best"
  !define MUI_WELCOMEPAGE_TEXT "Best is a fast, private proxy client for Windows, built on Xray and sing-box.$\r$\n$\r$\nYour servers and subscriptions are stored encrypted on this computer only.$\r$\n$\r$\nClick Next to continue."
  !insertmacro MUI_PAGE_WELCOME
!macroend

; Updater task: lets Best install its own updates later without the administrator prompt (like
; Chrome / Edge). Its scripts are written straight from this installer into Program Files\Best Updater,
; which only administrators can change, wherever Best itself is installed.
!macro customInstall
  SetOutPath "$PROGRAMFILES64\Best Updater"
  File "${BUILD_RESOURCES_DIR}\updater\update-service.ps1"
  File "${BUILD_RESOURCES_DIR}\updater\task.ps1"
  SetOutPath "$INSTDIR"
  nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PROGRAMFILES64\Best Updater\task.ps1" -Register -Exe "$INSTDIR\${APP_EXECUTABLE_FILENAME}"`
  Pop $0
!macroend

!macro customUnInstall
  ; An update runs the old uninstaller first: the task stays (it may be the one installing).
  ${ifNot} ${isUpdated}
    nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Unregister-ScheduledTask -TaskPath '\Best\' -TaskName 'Updater' -Confirm:$$false -ErrorAction SilentlyContinue; Remove-Item -LiteralPath (Join-Path $$env:ProgramData 'Best\incoming') -Recurse -Force -ErrorAction SilentlyContinue"`
    Pop $0
    RMDir /r "$PROGRAMFILES64\Best Updater"
  ${endIf}
!macroend
