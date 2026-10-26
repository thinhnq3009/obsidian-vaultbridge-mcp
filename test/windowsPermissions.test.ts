import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { restrictWindowsAccess } from "../src/auth/windowsPermissions.js";

it.runIf(process.platform === "win32")("restricts real Windows directory/file DACLs to the current user", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vaultbridge-windows-acl-"));
  try {
    fs.writeFileSync(path.join(directory, "session.key"), "disposable ACL fixture");
    restrictWindowsAccess(directory, true);
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
foreach ($target in @($env:VAULTBRIDGE_ACL_TEST, (Join-Path $env:VAULTBRIDGE_ACL_TEST 'session.key'))) {
  $acl = Get-Acl -LiteralPath $target
  if (-not $acl.AreAccessRulesProtected) { throw 'DACL is not protected' }
  $rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
  if ($rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid -or $rules[0].AccessControlType -ne 'Allow') { throw 'DACL is not owner-only' }
}
'owner-only'
`], { env: { ...process.env, VAULTBRIDGE_ACL_TEST: directory }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000, windowsHide: true });
    expect(output.trim()).toBe("owner-only");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}, 30000);
