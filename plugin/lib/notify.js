// Best-effort desktop notification. Never throws.
import { spawn } from "node:child_process";

export function notify(title, body) {
  if (process.env.ALR_NO_NOTIFY) return;
  try {
    if (process.platform === "darwin") {
      const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      spawn("osascript", ["-e", `display notification "${esc(body)}" with title "${esc(title)}"`],
        { stdio: "ignore", detached: true }).unref();
    } else if (process.platform === "linux") {
      spawn("notify-send", [title, body], { stdio: "ignore", detached: true }).unref();
    } else if (process.platform === "win32") {
      // Toast via the Windows.UI.Notifications API; no modules needed. Best effort.
      const ps = `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;
$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);
$x = $t.GetElementsByTagName('text'); $x.Item(0).AppendChild($t.CreateTextNode(${JSON.stringify(String(title))})) | Out-Null; $x.Item(1).AppendChild($t.CreateTextNode(${JSON.stringify(String(body))})) | Out-Null;
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('agent-limit-retry').Show([Windows.UI.Notifications.ToastNotification]::new($t))`;
      spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { stdio: "ignore", detached: true, windowsHide: true }).unref();
    }
  } catch { /* no notifier available */ }
}
