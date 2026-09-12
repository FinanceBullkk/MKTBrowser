!define MKT_BROWSER_INSTALLER_REPAIR_KEY "Software\MKTTool\MKTBrowser\InstallerRepair"
!define /ifndef UNINSTALL_REGISTRY_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}"
!include "LogicLib.nsh"

!macro stageFirewallScript
  InitPluginsDir
  File /oname=$PLUGINSDIR\windows-webrtc-firewall.ps1 "${PROJECT_DIR}\build\windows-webrtc-firewall.ps1"
!macroend

!macro stageRelayInstallScript
  InitPluginsDir
  File /oname=$PLUGINSDIR\windows-install-relay-payload.ps1 "${PROJECT_DIR}\build\windows-install-relay-payload.ps1"
!macroend

!macro stageStartupCoordinationScript
  InitPluginsDir
  File /oname=$PLUGINSDIR\windows-startup-coordination.ps1 "${PROJECT_DIR}\build\windows-startup-coordination.ps1"
!macroend

!macro inspectStartupShortcutOwnership
  !insertmacro stageStartupCoordinationScript
  nsExec::ExecToStack 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "$PLUGINSDIR\windows-startup-coordination.ps1" -Mode Preflight -ExpectedBrowserPath "$INSTDIR\${APP_FILENAME}.exe" -ExpectedRelayPath "$LOCALAPPDATA\MKTTool-Relay\MKTTool-Relay.exe" -StartupDirectory "$SMSTARTUP"'
  Pop $0
  Pop $1
!macroend

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
  !insertmacro inspectStartupShortcutOwnership
  ${If} $0 != 0
    Return
  ${EndIf}
  !insertmacro stageFirewallScript
  nsExec::ExecToStack 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "$PLUGINSDIR\windows-webrtc-firewall.ps1" -Mode CheckOwner -CftPath "$LOCALAPPDATA\MKTTool\MKTBrowser\chromium\cft\runtime\chrome.exe" -CloakBrowserPath "$LOCALAPPDATA\MKTTool\MKTBrowser\chromium\cloakbrowser\runtime\chrome.exe"'
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
  nsExec::ExecToStack 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "$PLUGINSDIR\windows-install-conflict-detection.ps1" -ExpectedBrowserPath "$INSTDIR\${APP_FILENAME}.exe" -ExpectedRelayPath "$LOCALAPPDATA\MKTTool-Relay\MKTTool-Relay.exe" -StartupDirectory "$SMSTARTUP" -RepairOwnedShortcuts'
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
  !insertmacro inspectStartupShortcutOwnership
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "$1$\r$\n$\r$\nExisting Startup entries were not changed. Resolve the ownership conflict before retrying."
    Abort
  ${EndIf}
  DetailPrint "Installing mandatory WebRTC containment rules"
  !insertmacro stageFirewallScript
  nsExec::ExecToStack 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "$PLUGINSDIR\windows-webrtc-firewall.ps1" -Mode CheckProfiles'
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
  ExecShellWait "runas" "powershell.exe" '-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "$PLUGINSDIR\windows-webrtc-firewall.ps1" -Mode Install -CftPath "$LOCALAPPDATA\MKTTool\MKTBrowser\chromium\cft\runtime\chrome.exe" -CloakBrowserPath "$LOCALAPPDATA\MKTTool\MKTBrowser\chromium\cloakbrowser\runtime\chrome.exe"' SW_HIDE $0
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
  nsExec::ExecToStack 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "$PLUGINSDIR\windows-webrtc-firewall.ps1" -Mode Verify -CftPath "$LOCALAPPDATA\MKTTool\MKTBrowser\chromium\cft\runtime\chrome.exe" -CloakBrowserPath "$LOCALAPPDATA\MKTTool\MKTBrowser\chromium\cloakbrowser\runtime\chrome.exe"'
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
  !insertmacro stageRelayInstallScript
  CreateDirectory "$PLUGINSDIR\mkttool-relay"
  nsExec::ExecToStack 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "$PLUGINSDIR\windows-install-relay-payload.ps1" -ArchivePath "$INSTDIR\resources\relay\MKTTool-Relay.zip" -StagingDirectory "$PLUGINSDIR\mkttool-relay"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "MKTTool Relay installation failed. The installer will stop without launching an unverified or incomplete payload.$\r$\n$\r$\n$1"
    Abort
  ${EndIf}
  WriteRegDWORD SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "RelayOwned" $2
  DeleteRegKey HKEY_CURRENT_USER "${MKT_BROWSER_INSTALLER_REPAIR_KEY}"

  !insertmacro stageStartupCoordinationScript
  nsExec::ExecToStack 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "$PLUGINSDIR\windows-startup-coordination.ps1" -Mode Takeover -ExpectedBrowserPath "$appExe" -ExpectedRelayPath "$LOCALAPPDATA\MKTTool-Relay\MKTTool-Relay.exe" -StartupDirectory "$SMSTARTUP"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "MKT Browser startup coordination could not be configured safely. Run installer repair after inspecting current-user Startup entries.$\r$\n$\r$\n$1"
    Abort
  ${EndIf}
  WriteRegDWORD SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "RelayStartupManaged" 1
  WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "Publisher" "Techieslab"
!macroend

!macro customUnInstall
  # Remove containment first. If later cleanup fails, Browser launch remains fail-closed because
  # its pre-launch check refuses to run without the exact firewall rules.
  DetailPrint "Removing MKT Browser WebRTC containment rules"
  !insertmacro stageFirewallScript
  ClearErrors
  ExecShellWait "runas" "powershell.exe" '-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "$PLUGINSDIR\windows-webrtc-firewall.ps1" -Mode Uninstall -CftPath "$LOCALAPPDATA\MKTTool\MKTBrowser\chromium\cft\runtime\chrome.exe" -CloakBrowserPath "$LOCALAPPDATA\MKTTool\MKTBrowser\chromium\cloakbrowser\runtime\chrome.exe"' SW_HIDE $0
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
  nsExec::ExecToStack 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "$PLUGINSDIR\windows-webrtc-firewall.ps1" -Mode VerifyAbsent'
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
    nsExec::ExecToStack 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "$PLUGINSDIR\windows-relay-cleanup.ps1"'
    Pop $0
    Pop $1
    ${If} $0 != 0
      MessageBox MB_ICONSTOP "MKTTool Relay could not be removed safely.$\r$\n$\r$\n$1"
      Abort
    ${EndIf}
  ${Else}
    DetailPrint "Preserving the pre-existing MKTTool Relay and relay-config.json"
    StrCpy $3 0
    ReadRegDWORD $3 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "RelayStartupManaged"
    ${If} $3 == 1
      !insertmacro stageStartupCoordinationScript
      nsExec::ExecToStack 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "$PLUGINSDIR\windows-startup-coordination.ps1" -Mode Restore -ExpectedBrowserPath "$INSTDIR\${APP_FILENAME}.exe" -ExpectedRelayPath "$LOCALAPPDATA\MKTTool-Relay\MKTTool-Relay.exe" -StartupDirectory "$SMSTARTUP"'
      Pop $0
      Pop $1
      ${If} $0 != 0
        MessageBox MB_ICONSTOP "The retained Relay startup entry could not be restored safely. Uninstall was stopped.$\r$\n$\r$\n$1"
        Abort
      ${EndIf}
    ${EndIf}
  ${EndIf}

  DetailPrint "Removing MKT Browser autostart entry"
  !insertmacro stageStartupCoordinationScript
  nsExec::ExecToStack 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "$PLUGINSDIR\windows-startup-coordination.ps1" -Mode RemoveBrowser -ExpectedBrowserPath "$INSTDIR\${APP_FILENAME}.exe" -ExpectedRelayPath "$LOCALAPPDATA\MKTTool-Relay\MKTTool-Relay.exe" -StartupDirectory "$SMSTARTUP"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "The MKT Browser startup entry could not be removed safely. Uninstall was stopped.$\r$\n$\r$\n$1"
    Abort
  ${EndIf}

  # Last, and deliberately not fail-closed. Every step above aborts when it cannot finish because
  # leaving a firewall rule, a foreign shortcut or a half-removed Relay behind is a correctness
  # problem. A retained engine cache is only disk usage, and it is what every earlier version left
  # behind, so a failure here must not turn a cleanup improvement into a new uninstall failure.
  # Profiles, settings and the engine pin are outside the removed directory and are preserved.
  DetailPrint "Removing the downloaded browser engine cache"
  InitPluginsDir
  File /oname=$PLUGINSDIR\windows-engine-cache-cleanup.ps1 "${PROJECT_DIR}\build\windows-engine-cache-cleanup.ps1"
  nsExec::ExecToStack 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "$PLUGINSDIR\windows-engine-cache-cleanup.ps1"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    DetailPrint "The downloaded engine cache was left in place and can be deleted manually: $LOCALAPPDATA\MKTTool\MKTBrowser\chromium"
  ${EndIf}
!macroend
