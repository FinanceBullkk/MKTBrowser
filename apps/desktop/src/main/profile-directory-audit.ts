/**
 * Đối chiếu danh sách profile sản phẩm biết với danh sách thư mục trên đĩa.
 *
 * Tách riêng khỏi phần đọc đĩa/DB để nó chạy được như mọi contract test khác, và để chỗ dễ sai —
 * quy tắc phân loại — được kiểm mà không cần một máy thật.
 */

/** Thư mục dàn dựng của xoá 2 pha, nằm trong profilesRoot theo thiết kế, không phải profile. */
export const NON_PROFILE_DIRECTORIES: ReadonlySet<string> = new Set([".deleting"]);

/**
 * Một thư mục mồ côi có hai dạng, và hai dạng đó cần hai quyết định khác hẳn nhau:
 *
 *  - `browser-data`: có `Default` — tức Chromium đã thật sự chạy trong đó. Bên trong là cookie,
 *    lịch sử, phiên đăng nhập. Xoá là mất thật, và mất cái người ta có thể đang cần.
 *  - `engine-scaffold`: chỉ có `engines/`, không có `Default`. Engine dựng chỗ làm việc rồi phiên
 *    đó không đi tới đâu. Không có gì của người dùng trong đó.
 *  - `unknown`: không đọc được bên trong, hoặc hình dạng lạ. Không đoán — báo đúng là không biết.
 *
 * Gộp cả ba vào một chữ "mồ côi" là cách biến một thứ vô hại thành một câu hỏi treo, và một thứ
 * đáng giữ thành một dòng dễ bị xoá nhầm.
 */
export type OrphanKind = "browser-data" | "engine-scaffold" | "unknown";

export interface OrphanDirectory {
  name: string;
  kind: OrphanKind;
}

export interface DirectoryAudit {
  registered: string[];
  directories: string[];
  /** Thư mục không ứng với profile nào sản phẩm biết. */
  orphanDirectories: string[];
  /** Cùng danh sách trên, kèm phân loại để quyết được mà không cần mở ra xem. */
  orphans: OrphanDirectory[];
  /** Sản phẩm tin là có profile nhưng dữ liệu không còn; mở ra sẽ hỏng. */
  missingDirectories: string[];
}

/** Phân loại từ danh sách mục con ngay dưới thư mục đó. */
export function classifyOrphan(entries: readonly string[] | undefined): OrphanKind {
  if (!entries) return "unknown";
  const names = new Set(entries.map((entry) => entry.toLowerCase()));
  if (names.has("default") || names.has("cookies") || names.has("history")) return "browser-data";
  if (names.size && [...names].every((name) => name === "engines")) return "engine-scaffold";
  return "unknown";
}

export function auditProfileDirectories(
  registered: readonly string[],
  directories: readonly string[],
  /** Mục con của từng thư mục, để phân loại. Thiếu thì mọi mồ côi là "unknown". */
  entriesByDirectory: ReadonlyMap<string, readonly string[]> = new Map(),
): DirectoryAudit {
  const known = new Set(registered);
  const present = directories.filter((name) => !NON_PROFILE_DIRECTORIES.has(name));
  const orphanDirectories = present.filter((name) => !known.has(name));
  return {
    registered: [...registered],
    directories: present,
    orphanDirectories,
    orphans: orphanDirectories.map((name) => ({
      name,
      kind: classifyOrphan(entriesByDirectory.get(name)),
    })),
    missingDirectories: registered.filter((id) => !present.includes(id)),
  };
}

/**
 * Chỉ những thư mục mồ côi xoá được mà không mất gì của người dùng.
 *
 * `browser-data` không bao giờ nằm trong danh sách này — bên trong là cookie và phiên đăng nhập, và
 * quyết định xoá chúng là của người, không phải của một lệnh. `unknown` cũng không: không đọc được
 * thì không xoá, vì "không biết" khác "không có gì".
 */
export function removableOrphans(audit: DirectoryAudit): string[] {
  return audit.orphans.filter((orphan) => orphan.kind === "engine-scaffold").map((orphan) => orphan.name);
}
