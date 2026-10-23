import path from "node:path";
import koffi from "koffi";
import type { Win32 } from "../core/focus.js";

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

export function loadWin32(): Win32 {
  const user32 = koffi.load("user32.dll");
  const kernel32 = koffi.load("kernel32.dll");
  const GetForegroundWindow = user32.func("intptr_t __stdcall GetForegroundWindow()");
  const SetForegroundWindow = user32.func("int __stdcall SetForegroundWindow(intptr_t hWnd)");
  const IsWindow = user32.func("int __stdcall IsWindow(intptr_t hWnd)");
  const GetWindowThreadProcessId = user32.func(
    "uint32_t __stdcall GetWindowThreadProcessId(intptr_t hWnd, _Out_ uint32_t *pid)",
  );
  const OpenProcess = kernel32.func(
    "intptr_t __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)",
  );
  const QueryFullProcessImageNameW = kernel32.func(
    "int __stdcall QueryFullProcessImageNameW(intptr_t h, uint32_t flags, _Out_ uint8_t *name, _Inout_ uint32_t *size)",
  );
  const CloseHandle = kernel32.func("int __stdcall CloseHandle(intptr_t h)");

  return {
    foreground: () => Number(GetForegroundWindow()),
    isWindow: (h) => IsWindow(h) !== 0,
    setForeground: (h) => SetForegroundWindow(h) !== 0,
    processName(h) {
      const pid = [0];
      GetWindowThreadProcessId(h, pid);
      if (!pid[0]) return null;
      const proc = Number(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid[0]));
      if (!proc) return null;
      try {
        const buf = Buffer.alloc(2048);
        const size = [1024];
        if (!QueryFullProcessImageNameW(proc, 0, buf, size)) return null;
        return path.win32.basename(buf.toString("utf16le", 0, size[0]! * 2));
      } finally {
        CloseHandle(proc);
      }
    },
  };
}
