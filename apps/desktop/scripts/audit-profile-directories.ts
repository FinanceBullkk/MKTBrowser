/**
 * Đối chiếu profile mà sản phẩm biết với thư mục thật trên đĩa.
 *
 * Hai bên lệch nhau là thứ không ai thấy cho tới lúc đọc nhầm một con số: ngày 14/09/2026 trên máy
 * dev có 20 thư mục nhưng chỉ 19 profile được đăng ký. Lệch kiểu đó có hai chiều, và ý nghĩa khác
 * hẳn nhau:
 *
 *  - **Thư mục mồ côi**: dữ liệu duyệt web của một profile sản phẩm không còn biết tới. Nó chiếm
 *    đĩa, và nó vẫn chứa cookie/phiên đăng nhập cũ. Không tự xoá — có thể là dấu vết của một lần
 *    xoá hỏng giữa chừng, mà cũng có thể là thứ ai đó cố ý giữ lại.
 *  - **Thiếu thư mục**: sản phẩm tin là có profile nhưng dữ liệu không còn. Mở nó ra sẽ hỏng.
 *
 * CHỈ ĐỌC. Không xoá, không sửa gì cả — báo cáo rồi để người quyết.
 *
 *   node <tsx> scripts/audit-profile-directories.ts
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { ProfileManager } from "@mktbrowser/profile-manager";

import {
  auditProfileDirectories,
} from "../src/main/profile-directory-audit.ts";

function main(): number {
  const localAppData = process.env.LOCALAPPDATA?.trim();
  if (!localAppData) throw new Error("LOCALAPPDATA chưa được đặt.");
  const dataRoot = path.join(localAppData, "MKTTool", "MKTBrowser", "data");
  const profilesRoot = path.join(dataRoot, "profiles");

  const profileManager = new ProfileManager({
    dbPath: path.join(dataRoot, "profiles.db"),
    profilesRoot,
  });
  const directories = readdirSync(profilesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  // Doc ten muc con cua tung thu muc de phan loai - chi ten, khong mo noi dung nao.
  const entriesByDirectory = new Map<string, string[]>();
  for (const name of directories) {
    try {
      entriesByDirectory.set(name, readdirSync(path.join(profilesRoot, name)));
    } catch {
      // Khong doc duoc thi de nguyen: classifyOrphan se bao "unknown" thay vi doan.
    }
  }
  const audit = auditProfileDirectories(
    profileManager.list().map((profile) => profile.id),
    directories,
    entriesByDirectory,
  );
  process.stdout.write(
    `Sản phẩm biết ${audit.registered.length} profile; trên đĩa có ${audit.directories.length} thư mục.\n`,
  );
  const label = {
    "browser-data": "CO DU LIEU DUYET WEB - can nhac truoc khi xoa",
    "engine-scaffold": "chi la cho lam viec cua engine, khong co du lieu nguoi dung",
    unknown: "khong xac dinh duoc - mo ra xem truoc khi quyet",
  };
  for (const orphan of audit.orphans) {
    process.stdout.write(`  MO COI   ${orphan.name}
`);
    process.stdout.write(`           ${label[orphan.kind]}
`);
    process.stdout.write(`           ${path.join(profilesRoot, orphan.name)}
`);
  }
  for (const id of audit.missingDirectories) {
    process.stdout.write(`  THIẾU    ${id}  — sản phẩm có profile này nhưng không có dữ liệu\n`);
  }
  if (!audit.orphanDirectories.length && !audit.missingDirectories.length) {
    process.stdout.write("Khớp hoàn toàn.\n");
    return 0;
  }
  process.stdout.write("Không xoá gì cả. Xem từng mục rồi quyết.\n");
  return 1;
}

if (process.argv[1]?.endsWith("audit-profile-directories.ts")) {
  try { process.exitCode = main(); }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Audit thất bại."}\n`);
    process.exitCode = 1;
  }
}
