@echo off
setlocal DisableDelayedExpansion

rem The release token is permitted only for this fixed, pre-Corepack Relay fetch.
set "NODE_OPTIONS="
set "NODE_EXTRA_CA_CERTS="
set "NODE_USE_SYSTEM_CA="
set "NODE_TLS_REJECT_UNAUTHORIZED="
set "ELECTRON_RUN_AS_NODE="
set "MKTTOOL_RELAY_ARCHIVE="
set "MKT_BROWSER_RELAY_HANDOFF_PATH="

if not defined MKT_BROWSER_NODE22_EXE (
  >&2 echo MKT_BROWSER_NODE22_EXE is required for tokenized Windows packaging.
  exit /b 1
)
if not defined MKT_BROWSER_NODE22_SHA256 (
  >&2 echo MKT_BROWSER_NODE22_SHA256 is required for tokenized Windows packaging.
  exit /b 1
)
if not defined MKT_BROWSER_COREPACK22_ENTRYPOINT (
  >&2 echo MKT_BROWSER_COREPACK22_ENTRYPOINT is required for tokenized Windows packaging.
  exit /b 1
)
if not defined MKT_BROWSER_COREPACK22_SHA256 (
  >&2 echo MKT_BROWSER_COREPACK22_SHA256 is required for tokenized Windows packaging.
  exit /b 1
)
if not defined MKT_BROWSER_YARN_ENTRYPOINT (
  >&2 echo MKT_BROWSER_YARN_ENTRYPOINT is required for tokenized Windows packaging.
  exit /b 1
)
if not defined MKT_BROWSER_YARN_VERSION (
  >&2 echo MKT_BROWSER_YARN_VERSION is required for tokenized Windows packaging.
  exit /b 1
)
if not defined MKT_BROWSER_YARN_SHA256 (
  >&2 echo MKT_BROWSER_YARN_SHA256 is required for tokenized Windows packaging.
  exit /b 1
)
if not defined MKT_BROWSER_PACKAGE_ROOT (
  >&2 echo MKT_BROWSER_PACKAGE_ROOT is required for tokenized Windows packaging.
  exit /b 1
)

for %%I in ("%MKT_BROWSER_PACKAGE_ROOT%") do set "package_root=%%~fI"
for %%I in ("%~dp0..\..\..") do set "snapshot_root=%%~fI"
if /I "%package_root%"=="%snapshot_root%" (
  >&2 echo MKT_BROWSER_PACKAGE_ROOT must identify the original Browser checkout, not the token-consumer snapshot.
  exit /b 1
)
set "original_relay_fetcher=%package_root%\apps\desktop\scripts\fetch-pinned-relay.cjs"
if not exist "%original_relay_fetcher%" (
  >&2 echo The original checkout Relay fetcher is unavailable.
  exit /b 1
)

set "token_fetcher=%~dp0fetch-pinned-relay-for-tokenized-package.ps1"
if not exist "%token_fetcher%" (
  >&2 echo The isolated Relay fetcher is unavailable.
  exit /b 1
)
set "powershell_exe=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%powershell_exe%" (
  >&2 echo Windows PowerShell is required for tokenized Windows packaging.
  exit /b 1
)

rem Validate once before staging, but only in a scope where the token is absent. The fetch itself
rem is PowerShell-only so Corepack, Yarn, and every Node child stay outside the token boundary.
call :validate_toolchain_tokenless
if errorlevel 1 goto :validation_failed

call :verify_release_candidate_tokenless
if errorlevel 1 goto :candidate_ineligible

call :create_relay_handoff_path
if errorlevel 1 goto :handoff_failed
set "MKT_BROWSER_RELAY_HANDOFF_PATH=%relay_handoff_path%"
"%powershell_exe%" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%token_fetcher%"
set "download_exit_code=%ERRORLEVEL%"
set "MKTTOOL_RELEASE_TOKEN="
set "MKT_BROWSER_RELAY_HANDOFF_PATH="
if not "%download_exit_code%"=="0" goto :download_failed
if not exist "%relay_handoff_path%" (
  >&2 echo The tokenized Relay fetch did not produce a handoff receipt.
  set "handoff_exit_code=1"
  goto :handoff_failed
)
set "snapshot_relay_archive="
set /p "snapshot_relay_archive=" < "%relay_handoff_path%"
del /f /q "%relay_handoff_path%" >nul 2>nul
if not defined snapshot_relay_archive (
  >&2 echo The tokenized Relay handoff receipt was empty.
  set "handoff_exit_code=1"
  goto :handoff_failed
)
if not exist "%snapshot_relay_archive%" (
  >&2 echo The tokenized Relay handoff archive is unavailable.
  set "handoff_exit_code=1"
  goto :handoff_failed
)

rem The snapshot archive is rehashed into the original checkout before Yarn starts. The archive
rem path is scoped to this one tokenless Node process, then removed so package scripts use only cache.
call :validate_toolchain
if errorlevel 1 goto :validation_failed
set "MKTTOOL_RELAY_ARCHIVE=%snapshot_relay_archive%"
"%validated_node%" "%original_relay_fetcher%"
set "handoff_exit_code=%ERRORLEVEL%"
set "MKTTOOL_RELAY_ARCHIVE="
if not "%handoff_exit_code%"=="0" goto :handoff_failed

rem Recheck the complete receipt-bound toolchain after token removal and immediately before packaging
rem so a changed Yarn cannot replace the reviewed step.
call :validate_toolchain
if errorlevel 1 goto :validation_failed
pushd "%package_root%"
if errorlevel 1 (
  >&2 echo Unable to enter the original Browser checkout for packaging.
  set "handoff_exit_code=1"
  goto :handoff_failed
)
set "MKT_BROWSER_PACKAGE_ROOT="
"%validated_node%" "%validated_yarn%" workspace @mktbrowser/desktop build:win
set "package_exit_code=%ERRORLEVEL%"
popd
endlocal & exit /b %package_exit_code%

:validation_failed
set "validation_exit_code=%ERRORLEVEL%"
endlocal & exit /b %validation_exit_code%

:candidate_ineligible
set "candidate_exit_code=%ERRORLEVEL%"
set "MKTTOOL_RELEASE_TOKEN="
set "MKTTOOL_RELAY_ARCHIVE="
set "MKT_BROWSER_RELAY_HANDOFF_PATH="
endlocal & exit /b %candidate_exit_code%

:download_failed
set "MKTTOOL_RELEASE_TOKEN="
set "MKTTOOL_RELAY_ARCHIVE="
set "MKT_BROWSER_RELAY_HANDOFF_PATH="
if defined relay_handoff_path if exist "%relay_handoff_path%" del /f /q "%relay_handoff_path%" >nul 2>nul
endlocal & exit /b %download_exit_code%

:handoff_failed
set "MKTTOOL_RELEASE_TOKEN="
set "MKTTOOL_RELAY_ARCHIVE="
set "MKT_BROWSER_RELAY_HANDOFF_PATH="
if defined relay_handoff_path if exist "%relay_handoff_path%" del /f /q "%relay_handoff_path%" >nul 2>nul
if not defined handoff_exit_code set "handoff_exit_code=1"
endlocal & exit /b %handoff_exit_code%

:create_relay_handoff_path
rem A receipt belongs to one wrapper invocation. Keep its GUID generation tokenless so no child other
rem than the fixed downloader can inherit the release token.
set "relay_handoff_id="
setlocal DisableDelayedExpansion
set "MKTTOOL_RELEASE_TOKEN="
for /f "delims=" %%I in ('""%powershell_exe%" -NoLogo -NoProfile -NonInteractive -Command "New-Guid""') do set "relay_handoff_id=%%I"
set "relay_handoff_id_exit_code=%ERRORLEVEL%"
endlocal & set "relay_handoff_id=%relay_handoff_id%" & set "relay_handoff_id_exit_code=%relay_handoff_id_exit_code%"
if not "%relay_handoff_id_exit_code%"=="0" (
  >&2 echo Unable to allocate an invocation-specific Relay handoff receipt.
  exit /b 1
)
if not defined relay_handoff_id (
  >&2 echo Relay handoff receipt allocation returned no identifier.
  exit /b 1
)
if not defined TEMP (
  >&2 echo TEMP is required for an invocation-specific Relay handoff receipt.
  exit /b 1
)
set "relay_handoff_path=%TEMP%\mktbrowser-relay-archive-handoff-%relay_handoff_id%.txt"
set "relay_handoff_id="
if exist "%relay_handoff_path%" (
  >&2 echo The invocation-specific Relay handoff receipt already exists.
  exit /b 1
)
exit /b 0

:validate_toolchain_tokenless
set "validation_exit_code=1"
setlocal
set "MKTTOOL_RELEASE_TOKEN="
call :validate_toolchain
set "validation_exit_code=%ERRORLEVEL%"
endlocal & exit /b %validation_exit_code%

:verify_release_candidate_tokenless
set "candidate_exit_code=1"
setlocal
set "MKTTOOL_RELEASE_TOKEN="
call :validate_toolchain
if errorlevel 1 goto :verify_release_candidate_tokenless_done
"%validated_node%" "%package_root%\scripts\release-candidate-contract.cjs"
:verify_release_candidate_tokenless_done
set "candidate_exit_code=%ERRORLEVEL%"
endlocal & exit /b %candidate_exit_code%

:validate_toolchain
if not exist "%MKT_BROWSER_NODE22_EXE%" (
  >&2 echo The pinned Node.js executable is unavailable.
  exit /b 1
)
for %%I in ("%MKT_BROWSER_NODE22_EXE%") do if /I not "%%~xI"==".exe" (
  >&2 echo The pinned Node.js executable must be a node.exe path.
  exit /b 1
)
for %%I in ("%MKT_BROWSER_NODE22_EXE%") do set "validated_node=%%~fI"
for %%I in ("%MKT_BROWSER_NODE22_EXE%") do set "node_directory=%%~dpI"
set "derived_corepack=%node_directory%node_modules\corepack\dist\corepack.js"
for %%I in ("%derived_corepack%") do set "validated_corepack=%%~fI"
for %%I in ("%MKT_BROWSER_COREPACK22_ENTRYPOINT%") do set "declared_corepack=%%~fI"

if /I not "%validated_corepack%"=="%declared_corepack%" (
  >&2 echo The Corepack entrypoint does not match the one derived from the pinned Node.js executable.
  exit /b 1
)
if not exist "%validated_corepack%" (
  >&2 echo The Corepack entrypoint derived from the pinned Node.js executable is unavailable.
  exit /b 1
)

call :verify_sha256 "%validated_node%" "%MKT_BROWSER_NODE22_SHA256%" "Node.js executable"
if errorlevel 1 exit /b 1
call :verify_sha256 "%validated_corepack%" "%MKT_BROWSER_COREPACK22_SHA256%" "Corepack entrypoint"
if errorlevel 1 exit /b 1
if not exist "%MKT_BROWSER_YARN_ENTRYPOINT%" (
  >&2 echo The receipt-bound Yarn entrypoint is unavailable.
  exit /b 1
)
for %%I in ("%MKT_BROWSER_YARN_ENTRYPOINT%") do set "validated_yarn=%%~fI"
for %%I in ("%validated_yarn%") do set "yarn_extension=%%~xI"
if /I not "%yarn_extension%"==".js" if /I not "%yarn_extension%"==".cjs" (
  >&2 echo The receipt-bound Yarn entrypoint must be a JavaScript file.
  exit /b 1
)
if /I not "%MKT_BROWSER_YARN_VERSION%"=="4.5.0" (
  >&2 echo The receipt-bound Yarn version must be 4.5.0.
  exit /b 1
)
call :verify_sha256 "%validated_yarn%" "%MKT_BROWSER_YARN_SHA256%" "Yarn entrypoint"
if errorlevel 1 exit /b 1
call :verify_yarn_version
if errorlevel 1 exit /b 1
exit /b 0

:verify_yarn_version
set "MKT_BROWSER_VALIDATED_NODE=%validated_node%"
set "MKT_BROWSER_VALIDATED_YARN=%validated_yarn%"
"%powershell_exe%" -NoLogo -NoProfile -NonInteractive -Command "$actual = (& $env:MKT_BROWSER_VALIDATED_NODE $env:MKT_BROWSER_VALIDATED_YARN --version).Trim(); if ($actual -cne $env:MKT_BROWSER_YARN_VERSION) { exit 1 }" >nul 2>nul
set "yarn_version_exit_code=%ERRORLEVEL%"
set "MKT_BROWSER_VALIDATED_NODE="
set "MKT_BROWSER_VALIDATED_YARN="
if not "%yarn_version_exit_code%"=="0" (
  >&2 echo The receipt-bound Yarn entrypoint did not report version %MKT_BROWSER_YARN_VERSION%.
  exit /b 1
)
exit /b 0

:verify_sha256
set "hash_file=%~1"
set "expected_hash=%~2"
set "hash_label=%~3"
set "powershell_exe=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%powershell_exe%" (
  >&2 echo SHA-256 verification is unavailable for the pinned %hash_label%.
  exit /b 1
)
set "MKT_BROWSER_HASH_FILE=%hash_file%"
set "MKT_BROWSER_EXPECTED_HASH=%expected_hash%"
"%powershell_exe%" -NoLogo -NoProfile -NonInteractive -Command "$actual = (Get-FileHash -LiteralPath $env:MKT_BROWSER_HASH_FILE -Algorithm SHA256).Hash; if (-not [string]::Equals($actual, $env:MKT_BROWSER_EXPECTED_HASH, [System.StringComparison]::OrdinalIgnoreCase)) { exit 1 }" >nul 2>nul
set "hash_exit_code=%ERRORLEVEL%"
set "MKT_BROWSER_HASH_FILE="
set "MKT_BROWSER_EXPECTED_HASH="
if not "%hash_exit_code%"=="0" (
  >&2 echo The pinned %hash_label% did not match its expected SHA-256.
  exit /b 1
)
exit /b 0
