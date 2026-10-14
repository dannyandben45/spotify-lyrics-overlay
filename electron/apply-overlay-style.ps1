param(
  [Parameter(Mandatory = $true)]
  [string]$HwndValue,

  # Soft re-apply: update DWM colors / exstyles without SWP_FRAMECHANGED
  # (FRAMECHANGED briefly paints the Win11 caption strip).
  [switch]$Soft
)

$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class OverlayWin32 {
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW", SetLastError = true)]
  public static extern IntPtr GetWindowLongPtr64(IntPtr hWnd, int nIndex);

  [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW", SetLastError = true)]
  public static extern IntPtr SetWindowLongPtr64(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

  [DllImport("user32.dll", EntryPoint = "GetWindowLongW", SetLastError = true)]
  public static extern int GetWindowLong32(IntPtr hWnd, int nIndex);

  [DllImport("user32.dll", EntryPoint = "SetWindowLongW", SetLastError = true)]
  public static extern int SetWindowLong32(IntPtr hWnd, int nIndex, int dwNewLong);

  [DllImport("user32.dll")]
  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

  [DllImport("dwmapi.dll")]
  public static extern int DwmSetWindowAttribute(IntPtr hwnd, int dwAttribute, ref int pvAttribute, int cbAttribute);

  [DllImport("dwmapi.dll")]
  public static extern int DwmExtendFrameIntoClientArea(IntPtr hwnd, ref MARGINS pMarInset);

  [StructLayout(LayoutKind.Sequential)]
  public struct MARGINS {
    public int cxLeftWidth;
    public int cxRightWidth;
    public int cyTopHeight;
    public int cyBottomHeight;
  }

  public const int GWL_EXSTYLE = -20;
  public const int WS_EX_NOACTIVATE = 0x08000000;
  public const int WS_EX_TOOLWINDOW = 0x00000080;
  public const int WS_EX_APPWINDOW = 0x00040000;
  public const int WS_EX_LAYERED = 0x00080000;
  public const uint SWP_NOSIZE = 0x0001;
  public const uint SWP_NOMOVE = 0x0002;
  public const uint SWP_NOZORDER = 0x0004;
  public const uint SWP_FRAMECHANGED = 0x0020;
  public const uint SWP_NOACTIVATE = 0x0010;

  public const int DWMWA_NCRENDERING_POLICY = 2;
  public const int DWMWA_CAPTION_COLOR = 35;
  public const int DWMWA_BORDER_COLOR = 34;
  public const int DWMWA_COLOR_NONE = unchecked((int)0xFFFFFFFE);
  public const int DWMNCRP_DISABLED = 1;

  public static void Apply(IntPtr hwnd, bool soft) {
    long style;
    if (IntPtr.Size == 8) {
      style = GetWindowLongPtr64(hwnd, GWL_EXSTYLE).ToInt64();
    } else {
      style = GetWindowLong32(hwnd, GWL_EXSTYLE);
    }

    style |= WS_EX_NOACTIVATE;
    style |= WS_EX_TOOLWINDOW;
    style |= WS_EX_LAYERED;
    style &= ~((long)WS_EX_APPWINDOW);

    if (IntPtr.Size == 8) {
      SetWindowLongPtr64(hwnd, GWL_EXSTYLE, new IntPtr(style));
    } else {
      SetWindowLong32(hwnd, GWL_EXSTYLE, (int)style);
    }

    try {
      int policy = DWMNCRP_DISABLED;
      DwmSetWindowAttribute(hwnd, DWMWA_NCRENDERING_POLICY, ref policy, sizeof(int));
      int none = DWMWA_COLOR_NONE;
      DwmSetWindowAttribute(hwnd, DWMWA_CAPTION_COLOR, ref none, sizeof(int));
      DwmSetWindowAttribute(hwnd, DWMWA_BORDER_COLOR, ref none, sizeof(int));

      if (!soft) {
        MARGINS margins = new MARGINS {
          cxLeftWidth = -1,
          cxRightWidth = -1,
          cyTopHeight = -1,
          cyBottomHeight = -1
        };
        DwmExtendFrameIntoClientArea(hwnd, ref margins);
      }
    } catch {
      // Older Windows — ignore
    }

    uint flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE;
    if (!soft) {
      flags |= SWP_FRAMECHANGED;
    }

    SetWindowPos(hwnd, IntPtr.Zero, 0, 0, 0, 0, flags);
  }
}
"@

$hwnd = [IntPtr]::new([int64]$HwndValue)
[OverlayWin32]::Apply($hwnd, [bool]$Soft)
