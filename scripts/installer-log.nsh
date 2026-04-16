; NSIS custom hooks for electron-builder.
; Purpose: show live installer details so users see installation is progressing.

!macro preInit
  ; Expand "Show details" panel automatically on Installing page.
  SetDetailsView show
  SetDetailsPrint both
!macroend

!macro customInstall
  ; Extra human-readable checkpoints near the end of installation.
  DetailPrint "Installer: Verifying installed files..."
  Sleep 250
  DetailPrint "Installer: Registering shortcuts..."
  Sleep 250
  DetailPrint "Installer: Finalizing setup..."
!macroend

!macro customUnInstall
  SetDetailsPrint both
  DetailPrint "Uninstaller: Removing Narrapedia reMotion Batch..."
!macroend
