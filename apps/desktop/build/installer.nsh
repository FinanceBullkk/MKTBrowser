!macro customInstall
  ClearErrors
  ReadRegDWORD $2 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "RelayOwned"
  ${If} ${Errors}
    ${If} ${FileExists} "$LOCALAPPDATA\MKTTool-Relay\MKTTool-Relay.exe"
      StrCpy $2 0
    ${Else}
      StrCpy $2 1
    ${EndIf}
  ${EndIf}
  WriteRegDWORD SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "RelayOwned" $2

  DetailPrint "Installing verified MKTTool Relay payload"
  CreateDirectory "$PLUGINSDIR\mkttool-relay"
  nsExec::ExecToStack 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath $\"$INSTDIR\resources\relay\MKTTool-Relay.zip$\" -DestinationPath $\"$PLUGINSDIR\mkttool-relay$\" -Force; $$env:RELAY_SKIP_BROWSER=$\"1$\"; & $\"$PLUGINSDIR\mkttool-relay\install-relay.ps1$\""'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "MKTTool Relay installation failed. The installer will stop without launching an unverified or incomplete payload.$\r$\n$\r$\n$1"
    Abort
  ${EndIf}

  CreateShortCut "$SMSTARTUP\MKT Browser.lnk" "$appExe" "" "$appExe" 0
  WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "Publisher" "Techieslab"
!macroend

!macro customUnInstall
  DetailPrint "Removing MKT Browser autostart entry"
  Delete "$SMSTARTUP\MKT Browser.lnk"

  StrCpy $2 0
  ClearErrors
  ReadRegDWORD $2 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "RelayOwned"
  ${If} $2 == 1
    DetailPrint "Removing the MKTTool Relay installed by MKT Browser"
    nsExec::ExecToStack 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$$ErrorActionPreference=$\"Stop$\"; $$relayExe = [IO.Path]::GetFullPath((Join-Path $$env:LOCALAPPDATA $\"MKTTool-Relay\MKTTool-Relay.exe$\")); $$shell = New-Object -ComObject WScript.Shell; @([Environment]::GetFolderPath($\"Startup$\"), [Environment]::GetFolderPath($\"Desktop$\")) | ForEach-Object { Get-ChildItem -LiteralPath $$_ -Filter $\"*.lnk$\" -File -ErrorAction SilentlyContinue } | ForEach-Object { try { $$target = $$shell.CreateShortcut($$_.FullName).TargetPath; if ($$target -and [IO.Path]::GetFullPath($$target).Equals($$relayExe, [StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $$_.FullName -Force } } catch {} }; Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and [IO.Path]::GetFullPath($$_.ExecutablePath).Equals($$relayExe, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force }; Remove-Item -LiteralPath $$relayExe -Force -ErrorAction SilentlyContinue"'
    Pop $0
    Pop $1
    ${If} $0 != 0
      MessageBox MB_ICONSTOP "MKTTool Relay could not be removed safely.$\r$\n$\r$\n$1"
      Abort
    ${EndIf}
  ${Else}
    DetailPrint "Preserving the pre-existing MKTTool Relay, its shortcuts, and relay-config.json"
  ${EndIf}
!macroend
