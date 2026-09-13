!macro customInstall
  WriteRegStr SHCTX "Software\RegisteredApplications" "MailExpert" "Software\Clients\Mail\MailExpert\Capabilities"

  WriteRegStr SHCTX "Software\Clients\Mail\MailExpert" "" "MailExpert"
  WriteRegStr SHCTX "Software\Clients\Mail\MailExpert\Capabilities" "ApplicationName" "MailExpert"
  WriteRegStr SHCTX "Software\Clients\Mail\MailExpert\Capabilities" "ApplicationDescription" "A self-hosted, unified webmail client."
  WriteRegStr SHCTX "Software\Clients\Mail\MailExpert\Capabilities\URLAssociations" "mailto" "MailExpert.mailto"

  WriteRegStr SHCTX "Software\Classes\MailExpert.mailto" "" "URL:MailExpert MailTo Protocol"
  WriteRegStr SHCTX "Software\Classes\MailExpert.mailto" "URL Protocol" ""
  WriteRegStr SHCTX "Software\Classes\MailExpert.mailto\DefaultIcon" "" "$INSTDIR\MailExpert.exe,0"
  WriteRegStr SHCTX "Software\Classes\MailExpert.mailto\shell\open\command" "" '"$INSTDIR\MailExpert.exe" "%1"'
!macroend

!macro customUnInstall
  DeleteRegValue SHCTX "Software\RegisteredApplications" "MailExpert"
  DeleteRegKey SHCTX "Software\Clients\Mail\MailExpert"
  DeleteRegKey SHCTX "Software\Classes\MailExpert.mailto"
!macroend
