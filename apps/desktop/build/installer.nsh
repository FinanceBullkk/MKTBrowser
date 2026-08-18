!define MKT_BROWSER_INSTALLER_REPAIR_KEY "Software\MKTTool\MKTBrowser\InstallerRepair"
!define /ifndef UNINSTALL_REGISTRY_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}"
!include "LogicLib.nsh"
!include "${PROJECT_DIR}\.installer-generated\windows-webrtc-firewall-commands.nsh"

!ifndef BUILD_UNINSTALLER
!macro preserveRelayOwnershipForUpgrade
  # Older MKB-03 uninstallers embedded Relay cleanup in a fragile quoted command. Preserve
  # ownership outside their uninstall key, then make that one cleanup block a no-op during upgrade.
  StrCpy $3 0
  ClearErrors
  ReadRegDWORD $3 HKEY_CURRENT_USER "${MKT_BROWSER_INSTALLER_REPAIR_KEY}" "RelayOwned"
  ${If} ${Errors}
    StrCpy $3 0
  ${EndIf}
  StrCpy $4 0
  ClearErrors
  ReadRegDWORD $4 HKEY_CURRENT_USER "${UNINSTALL_REGISTRY_KEY}" "RelayOwned"
  ${IfNot} ${Errors}
  ${AndIf} $4 == 1
    StrCpy $3 1
  ${EndIf}
  ${If} $3 == 1
    WriteRegDWORD HKEY_CURRENT_USER "${MKT_BROWSER_INSTALLER_REPAIR_KEY}" "RelayOwned" 1
    WriteRegDWORD HKEY_CURRENT_USER "${UNINSTALL_REGISTRY_KEY}" "RelayOwned" 0
  ${EndIf}
!macroend

Function MktBrowserInspectInstallConflicts
  nsExec::ExecToStack 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${MKT_BROWSER_FIREWALL_CHECK_OWNER_COMMAND}'
  Pop $0
  Pop $1
  ${If} $0 == 17
    StrCpy $1 "MKT Browser is already installed for another Windows user on this PC. Safe action: sign in as that user and uninstall MKT Browser first; existing firewall protection was not changed."
    Return
  ${ElseIf} $0 != 0
    StrCpy $1 "Existing MKT Browser firewall ownership could not be verified safely (code $0). No firewall rule was changed."
    Return
  ${EndIf}

  InitPluginsDir
  File /oname=$PLUGINSDIR\windows-install-conflict-detection.ps1 "${PROJECT_DIR}\build\windows-install-conflict-detection.ps1"
  nsExec::ExecToStack 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\windows-install-conflict-detection.ps1" -ExpectedBrowserPath "$INSTDIR\${APP_FILENAME}.exe" -ExpectedRelayPath "$LOCALAPPDATA\MKTTool-Relay\MKTTool-Relay.exe" -StartupDirectory "$SMSTARTUP" -RepairOwnedShortcuts'
  Pop $0
  Pop $1
FunctionEnd

Function MktBrowserNormalizeInstallPath
  StrCpy $0 ""
  StrCpy $1 0
  StrLen $2 "${APP_FILENAME}"
  StrLen $3 $INSTDIR

  MktBrowserFindAppFilename:
    IntCmp $1 $3 MktBrowserAppendAppFilename MktBrowserCheckAppFilename MktBrowserAppendAppFilename
  MktBrowserCheckAppFilename:
    StrCpy $4 $INSTDIR $2 $1
    StrCmp $4 "${APP_FILENAME}" MktBrowserInstallPathReady
    IntOp $1 $1 + 1
    Goto MktBrowserFindAppFilename
  MktBrowserAppendAppFilename:
    StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
  MktBrowserInstallPathReady:
FunctionEnd

!macro customInit
  # Silent installs have no page callbacks, so inspect after initMultiUser resolves $INSTDIR.
  ${If} ${Silent}
    Call MktBrowserInspectInstallConflicts
    ${If} $0 != 0
      DetailPrint "$1"
      SetErrorLevel $0
      Quit
    ${EndIf}
    !insertmacro preserveRelayOwnershipForUpgrade
  ${EndIf}
!macroend

!macro customPageAfterChangeDir
  Page custom MktBrowserInspectBeforeInstall
!macroend

Function MktBrowserInspectBeforeInstall
  DetailPrint "Checking existing local installations and fixed ports"
  # electron-builder normally appends APP_FILENAME in instFilesPre, which runs after this page.
  # Mirror that normalization so conflict ownership is checked against the actual install target.
  Call MktBrowserNormalizeInstallPath
  Call MktBrowserInspectInstallConflicts
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "$1$\r$\n$\r$\nMKT Browser did not install or remove a program or profile data. Follow the safe action above, then run this installer again."
    SetErrorLevel $0
    Quit
  ${EndIf}

  !insertmacro preserveRelayOwnershipForUpgrade
  Abort
FunctionEnd
!endif

!macro customInstall
  DetailPrint "Installing mandatory WebRTC containment rules"
  nsExec::ExecToStack 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${MKT_BROWSER_FIREWALL_CHECK_PROFILES_COMMAND}'
  Pop $0
  Pop $1
  ${If} $0 == 15
    MessageBox MB_ICONSTOP "Windows Firewall must be on for Domain, Private, and Public networks before MKT Browser can install WebRTC protection.$\r$\n$\r$\nOpen Windows Security > Firewall & network protection, turn on every network profile, then retry the installer."
    Abort
  ${ElseIf} $0 != 0
    MessageBox MB_ICONSTOP "Windows Firewall status could not be verified (code $0). MKT Browser was not installed."
    Abort
  ${EndIf}

  ClearErrors
  ExecShellWait "runas" "powershell.exe" "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${MKT_BROWSER_FIREWALL_INSTALL_COMMAND}" SW_HIDE $0
  ${If} ${Errors}
    MessageBox MB_ICONSTOP "Administrator approval is required to install WebRTC protection. MKT Browser was not installed."
    Abort
  ${ElseIf} $0 == 17
    MessageBox MB_ICONSTOP "MKT Browser was installed concurrently for another Windows user. Existing firewall protection was not changed. Sign in as that user and uninstall MKT Browser before retrying."
    Abort
  ${ElseIf} $0 != 0
    MessageBox MB_ICONSTOP "WebRTC protection installation failed (code $0). MKT Browser was not installed."
    Abort
  ${EndIf}
  nsExec::ExecToStack 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${MKT_BROWSER_FIREWALL_VERIFY_COMMAND}'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "WebRTC protection verification failed (code $0). MKT Browser will not install without the required outbound UDP containment.$\r$\n$\r$\nClose this installer and report the code. No IP address, proxy credential, or secret is included."
    Abort
  ${EndIf}

  ClearErrors
  ReadRegDWORD $2 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "RelayOwned"
  ${If} ${Errors}
    ${If} ${FileExists} "$LOCALAPPDATA\MKTTool-Relay\MKTTool-Relay.exe"
      StrCpy $2 0
    ${Else}
      StrCpy $2 1
    ${EndIf}
  ${EndIf}
  StrCpy $3 0
  ClearErrors
  ReadRegDWORD $3 HKEY_CURRENT_USER "${MKT_BROWSER_INSTALLER_REPAIR_KEY}" "RelayOwned"
  ${IfNot} ${Errors}
  ${AndIf} $3 == 1
    StrCpy $2 1
  ${EndIf}

  DetailPrint "Installing verified MKTTool Relay payload"
  CreateDirectory "$PLUGINSDIR\mkttool-relay"
  nsExec::ExecToStack 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath $\"$INSTDIR\resources\relay\MKTTool-Relay.zip$\" -DestinationPath $\"$PLUGINSDIR\mkttool-relay$\" -Force; $$env:RELAY_SKIP_BROWSER=$\"1$\"; & $\"$PLUGINSDIR\mkttool-relay\install-relay.ps1$\""'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "MKTTool Relay installation failed. The installer will stop without launching an unverified or incomplete payload.$\r$\n$\r$\n$1"
    Abort
  ${EndIf}
  WriteRegDWORD SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "RelayOwned" $2
  DeleteRegKey HKEY_CURRENT_USER "${MKT_BROWSER_INSTALLER_REPAIR_KEY}"

  CreateShortCut "$SMSTARTUP\MKT Browser.lnk" "$appExe" "" "$appExe" 0
  WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "Publisher" "Techieslab"
!macroend

!macro customUnInstall
  # Remove containment first. If later cleanup fails, Browser launch remains fail-closed because
  # its pre-launch check refuses to run without the exact firewall rules.
  DetailPrint "Removing MKT Browser WebRTC containment rules"
  ClearErrors
  ExecShellWait "runas" "powershell.exe" "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${MKT_BROWSER_FIREWALL_UNINSTALL_COMMAND}" SW_HIDE $0
  ${If} ${Errors}
    MessageBox MB_ICONSTOP "Administrator approval is required to remove MKT Browser WebRTC protection. Uninstall was stopped."
    Abort
  ${ElseIf} $0 == 17
    MessageBox MB_ICONSTOP "These WebRTC protection rules belong to another Windows user's MKT Browser installation. Uninstall was stopped without changing them."
    Abort
  ${ElseIf} $0 != 0
    MessageBox MB_ICONSTOP "MKT Browser WebRTC protection removal failed (code $0). Uninstall was stopped."
    Abort
  ${EndIf}
  nsExec::ExecToStack 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${MKT_BROWSER_FIREWALL_VERIFY_ABSENT_COMMAND}'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "MKT Browser WebRTC protection could not be removed safely (code $0).$\r$\n$\r$\nClose this uninstaller and report the code."
    Abort
  ${EndIf}

  StrCpy $2 0
  ClearErrors
  ReadRegDWORD $2 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "RelayOwned"
  ${If} $2 == 1
    DetailPrint "Removing the MKTTool Relay installed by MKT Browser"
    File /oname=$PLUGINSDIR\windows-relay-cleanup.ps1 "${PROJECT_DIR}\build\windows-relay-cleanup.ps1"
    nsExec::ExecToStack 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\windows-relay-cleanup.ps1"'
    Pop $0
    Pop $1
    ${If} $0 != 0
      MessageBox MB_ICONSTOP "MKTTool Relay could not be removed safely.$\r$\n$\r$\n$1"
      Abort
    ${EndIf}
  ${Else}
    DetailPrint "Preserving the pre-existing MKTTool Relay, its shortcuts, and relay-config.json"
  ${EndIf}

  DetailPrint "Removing MKT Browser autostart entry"
  Delete "$SMSTARTUP\MKT Browser.lnk"
!macroend
