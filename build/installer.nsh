; Best installer customisations.
; Sharp text on high-DPI screens (otherwise Windows bitmap-stretches the whole installer).
ManifestDPIAware true

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Welcome to Best"
  !define MUI_WELCOMEPAGE_TEXT "Best is a fast, private proxy client for Windows, built on Xray and sing-box.$\r$\n$\r$\nYour servers and subscriptions are stored encrypted on this computer only.$\r$\n$\r$\nClick Next to continue."
  !insertmacro MUI_PAGE_WELCOME
!macroend
