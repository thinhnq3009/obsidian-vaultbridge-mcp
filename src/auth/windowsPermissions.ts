import { execFileSync } from "node:child_process";

/** POSIX mode bits do not secure Windows files. Replace the DACL, do not merely add a grant. */
export function restrictWindowsAccess(target: string, directory: boolean): void {
  if (process.platform !== "win32") return;
  const script = `
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$target = $env:VAULTBRIDGE_PRIVATE_PATH
if ($env:VAULTBRIDGE_PRIVATE_DIRECTORY -eq 'true') {
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
} else {
  $acl = New-Object System.Security.AccessControl.FileSecurity
  $inherit = [System.Security.AccessControl.InheritanceFlags]::None
}
$acl.SetAccessRuleProtection($true, $false)
$acl.SetOwner($sid)
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $inherit, 'None', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $target -AclObject $acl
if ($env:VAULTBRIDGE_PRIVATE_DIRECTORY -eq 'true') {
  foreach ($name in @('session.key', 'auth.sqlite', 'auth.sqlite-wal', 'auth.sqlite-shm', 'setup-token')) {
    $file = Join-Path $target $name
    if (Test-Path -LiteralPath $file) {
      $fileAcl = New-Object System.Security.AccessControl.FileSecurity
      $fileAcl.SetAccessRuleProtection($true, $false)
      $fileAcl.SetOwner($sid)
      $fileRule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')
      $fileAcl.AddAccessRule($fileRule)
      Set-Acl -LiteralPath $file -AclObject $fileAcl
    }
  }
}
`;
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...process.env, VAULTBRIDGE_PRIVATE_PATH: target, VAULTBRIDGE_PRIVATE_DIRECTORY: String(directory) },
      stdio: "pipe", timeout: 15000, windowsHide: true,
    });
  } catch {
    throw new Error("Cannot restrict owner auth Windows ACLs. Use a per-user local NTFS app-data directory with PowerShell available.");
  }
}
