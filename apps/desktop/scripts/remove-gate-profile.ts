/**
 * Xoá profile mà gate proxied-launch để lại trong root thật.
 *
 * Gate chạy trên root đã cài (đó là cấu hình duy nhất mà chốt chặn WebRTC chấp nhận được), tạo một
 * profile, và **không xoá lại được** vì adapter MCP không có tool xoá. Trên guest dùng xong vứt thì
 * không sao. Trên máy thật thì nó ở lại.
 *
 * Script này đi đúng đường sản phẩm dùng: `deleteBrowserProfile` — vẫn khớp chuỗi xác nhận, vẫn từ
 * chối khi profile đang chạy, vẫn xoá 2 pha qua `deletePermanently`. KHÔNG sửa tay file SQLite.
 *
 *   node --experimental-strip-types scripts/remove-gate-profile.ts            # xem sẽ xoá gì
 *   node --experimental-strip-types scripts/remove-gate-profile.ts --apply    # xoá thật
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { ProfileManager } from "@mktbrowser/profile-manager";
import type { ProfileId } from "@mktbrowser/types";
import { deleteBrowserProfile } from "../src/main/profile-deletion-lifecycle.ts";
import { profileDeletionConfirmation } from "../src/shared/profile-deletion-contract.ts";

/** Tên mà gate đặt cho profile nó tạo. Không khớp mẫu này thì không phải của gate. */
const GATE_PROFILE_PATTERN = /^P0 proxy smoke \d+$/;

function assertProductClosed(): void {
  const running = execFileSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    "@(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('MKTBrowser.exe','MKTTool-Relay.exe') " +
      "-or $_.ExecutablePath -like '*chromium*runtime*chrome.exe' }).Count",
  ], { encoding: "utf8", windowsHide: true, timeout: 20_000 }).trim();
  if (running !== "0") {
    throw new Error(`Đóng hẳn MKT Browser trước đã; đang còn ${running} tiến trình.`);
  }
}

function main(): number {
  if (process.platform !== "win32") throw new Error("Chạy trên chính máy Windows đã cài sản phẩm.");
  const localAppData = process.env.LOCALAPPDATA?.trim();
  if (!localAppData) throw new Error("LOCALAPPDATA chưa được đặt.");
  const dataRoot = path.join(localAppData, "MKTTool", "MKTBrowser", "data");

  assertProductClosed();

  const profileManager = new ProfileManager({
    dbPath: path.join(dataRoot, "profiles.db"),
    profilesRoot: path.join(dataRoot, "profiles"),
  });

  const all = profileManager.list();
  const gateProfiles = all.filter((profile) => GATE_PROFILE_PATTERN.test(profile.name));
  process.stdout.write(`Sản phẩm đang có ${all.length} profile; ${gateProfiles.length} do gate tạo.\n`);
  for (const profile of gateProfiles) process.stdout.write(`  ${profile.id}  ${profile.name}\n`);

  if (!gateProfiles.length) {
    process.stdout.write("Không còn profile nào của gate. Không làm gì.\n");
    return 0;
  }
  if (!process.argv.includes("--apply")) {
    process.stdout.write("Đây là bản xem trước. Thêm --apply để xoá thật.\n");
    return 0;
  }

  for (const profile of gateProfiles) {
    // Đúng đường sản phẩm: chuỗi xác nhận phải khớp, và profile đang chạy thì bị từ chối.
    deleteBrowserProfile(
      { profileId: profile.id as ProfileId, confirmation: profileDeletionConfirmation(profile.id) },
      { profileManager, browserDriver: { isRunning: () => false } },
    );
    process.stdout.write(`Đã xoá ${profile.id} (${profile.name}).\n`);
  }

  const remaining = profileManager.list();
  if (remaining.length !== all.length - gateProfiles.length) {
    throw new Error("Số profile sau khi xoá không khớp; kiểm tra lại trước khi dùng tiếp.");
  }
  process.stdout.write(`Còn lại ${remaining.length} profile. Không profile nào khác bị đụng.\n`);
  return 0;
}

try { process.exitCode = main(); }
catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Xoá profile thất bại."}\n`);
  process.exitCode = 1;
}
