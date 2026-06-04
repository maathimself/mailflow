!macro customInstall
  WriteRegStr SHCTX "Software\RegisteredApplications" "MailFlow" "Software\Clients\Mail\MailFlow\Capabilities"

  WriteRegStr SHCTX "Software\Clients\Mail\MailFlow" "" "MailFlow"
  WriteRegStr SHCTX "Software\Clients\Mail\MailFlow\Capabilities" "ApplicationName" "MailFlow"
  WriteRegStr SHCTX "Software\Clients\Mail\MailFlow\Capabilities" "ApplicationDescription" "A self-hosted, unified webmail client."
  WriteRegStr SHCTX "Software\Clients\Mail\MailFlow\Capabilities\URLAssociations" "mailto" "MailFlow.mailto"

  WriteRegStr SHCTX "Software\Classes\MailFlow.mailto" "" "URL:MailFlow MailTo Protocol"
  WriteRegStr SHCTX "Software\Classes\MailFlow.mailto" "URL Protocol" ""
  WriteRegStr SHCTX "Software\Classes\MailFlow.mailto\DefaultIcon" "" "$INSTDIR\MailFlow.exe,0"
  WriteRegStr SHCTX "Software\Classes\MailFlow.mailto\shell\open\command" "" '"$INSTDIR\MailFlow.exe" "%1"'
!macroend

!macro customUnInstall
  DeleteRegValue SHCTX "Software\RegisteredApplications" "MailFlow"
  DeleteRegKey SHCTX "Software\Clients\Mail\MailFlow"
  DeleteRegKey SHCTX "Software\Classes\MailFlow.mailto"
!macroend
