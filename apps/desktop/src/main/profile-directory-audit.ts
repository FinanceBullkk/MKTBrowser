/**
 * Đối chiếu danh sách profile sản phẩm biết với danh sách thư mục trên đĩa.
 *
 * Tách riêng khỏi phần đọc đĩa/DB để nó chạy được như mọi contract test khác, và để chỗ dễ sai —
 * quy tắc phân loại — được kiểm mà không cần một máy thật.
 */

/** Thư mục dàn dựng của xoá 2 pha, nằm trong profilesRoot theo thiết kế, không phải profile. */
export const NON_PROFILE_DIRECTORIES: ReadonlySet<string> = new Set([".deleting"]);

export interface DirectoryAudit {
  registered: string[];
  directories: string[];
  /** Dữ liệu duyệt web của profile sản phẩm không còn biết tới — vẫn giữ cookie và phiên cũ. */
  orphanDirectories: string[];
  /** Sản phẩm tin là có profile nhưng dữ liệu không còn; mở ra sẽ hỏng. */
  missingDirectories: string[];
}

export function auditProfileDirectories(
  registered: readonly string[],
  directories: readonly string[],
): DirectoryAudit {
  const known = new Set(registered);
  const present = directories.filter((name) => !NON_PROFILE_DIRECTORIES.has(name));
  return {
    registered: [...registered],
    directories: present,
    orphanDirectories: present.filter((name) => !known.has(name)),
    missingDirectories: registered.filter((id) => !present.includes(id)),
  };
}
