# Nghiệm thu trên máy Windows thứ hai

Gate này lâu nay bị ghi là "thiếu phần cứng". Không đúng: máy đã có — `admin-laptop`, chính chiếc đã
đăng ký làm CI runner `mkt-ci-windows` từ 8/9/2026. Ngày 14/9/2026 nó đang **offline**. Thứ còn
thiếu là bật máy lên và chạy, không phải mua máy.

Tài liệu này gộp mọi thứ đã dựng sẵn thành một lượt chạy.

## Vì sao phải là máy khác

Máy build hiện tại đã chạy qua toàn bộ gate kỹ thuật và đều đạt. Nhưng nó là máy **đã có sẵn mọi
thứ**: engine đã provision, rule WebRTC do installer tạo từ lâu, Node/Yarn/chứng chỉ đã cài, biến
môi trường đã có. Không có lượt chạy nào trên đó phân biệt được "sản phẩm chạy được" với "máy này
tình cờ đã đủ điều kiện". Máy thứ hai trả lời đúng câu đó.

Máy ảo trên chính host build **không** thay thế được — đã ghi trong `AGENTS.md`.

## Chuẩn bị mang sang

| Thứ | Lấy ở đâu |
|---|---|
| File cài đúng bản đã giữ | `local-test-artifacts/local-release-20260913/vm-gate/installer.exe` |
| SHA-256 của nó | `a0adfcc0727bd2241d32cad426e06931f64836d1e1f44786f0eb9a46504ba549` |
| Cache engine CloakBrowser | `%LOCALAPPDATA%\MKTTool\MKTBrowser\chromium\cloakbrowser` trên máy build (~516 MB) |
| Khoá licence engine | Biến `CLOAKBROWSER_LICENSE_KEY` — hai máy gate dùng chung **một khoá dev**, nên máy build phải đóng hẳn app trong lúc máy kia chạy |
| 1 dòng proxy sống | `host:port:user:pass` |
| Node 22 | Máy đích cần có để chạy gate |

## Thứ tự chạy

### 1. Cài bằng đúng file đã giữ

Đối chiếu SHA-256 trước khi chạy. **Ghi lại nguyên văn cảnh báo SmartScreen** — installer chưa ký,
và phản ứng trên một máy chưa từng cài là dữ liệu của gate người-lạ.

### 2. Xác nhận containment do installer tạo

```powershell
$p = New-Object -ComObject HNetCfg.FwPolicy2
$p.Rules | Where-Object { $_.Name -like 'MKT Browser WebRTC UDP Block*' } |
  Select-Object Name, ApplicationName, Enabled, Protocol
```

Phải có đúng một rule mỗi engine, trỏ đúng đường dẫn engine trên **máy đó**. Không có rule thì mọi
launch qua proxy sẽ bị từ chối — và từ chối đó là đúng.

### 3. Đưa engine vào đúng chỗ

Chép cache CloakBrowser vào `%LOCALAPPDATA%\MKTTool\MKTBrowser\chromium\cloakbrowser` trên máy đích.
Làm vậy để né bước kích hoạt engine phía máy mới (đang là blocker riêng); binary vẫn là bản đã ký
thật.

### 4. Gate mở profile qua proxy

Từ bản sao MKTTool trên máy đó:

```powershell
$handoff = Join-Path $env:LOCALAPPDATA 'MKTTool\mkb00-proxy.env'
# host:port:user:pass -> file handoff, KHÔNG BOM
npm run mkt-browser:proxy-smoke -- --proxy-file --installed-root --accept-real-machine `
  "--browser-exe=$env:LOCALAPPDATA\Programs\MKTBrowser\MKTBrowser.exe"
```

Chạy trọn: mở → đóng → mở lại → đóng → proxy cổng-đóng bị từ chối → phục hồi mở lại → đóng.

`--accept-real-machine` là bắt buộc vì đây là máy thật: nó tạo một profile **không xoá lại được**.
Dọn sau bằng `apps/desktop/scripts/remove-gate-profile.ts` (xem trước rồi `--apply`).

### 5. Gate machine-integration

```powershell
yarn workspace @mktbrowser/desktop test:packaging:windows-machine
```

Phải đóng hẳn MKT Browser, Relay và MultiZen trước — nếu không nó dừng ngay ở tiền điều kiện.

### 6. Đối chiếu thư mục profile

```powershell
node <tsx> apps/desktop/scripts/audit-profile-directories.ts
```

Máy mới cài phải khớp hoàn toàn. Lệch ngay từ đầu nghĩa là có gì đó sai trong lúc cài.

### 7. Mở canary trên chính máy đó

```powershell
node scripts/canary-daily-check.cjs
```

Canary chỉ chứng minh cho máy nó chạy, nên máy này cần cửa sổ 7 ngày riêng — xem
`seven-day-canary.md`. Máy build đang chạy cửa sổ của nó; hai cái không thay thế nhau.

### 8. Bài cho người lạ

Nếu chiếc máy này cũng là máy người đó dùng, chạy luôn `unfamiliar-operator-acceptance.md` — một
lượt cài đóng được hai gate. Nhưng phải là người **chưa từng dùng sản phẩm**, và họ phải tự đi từ
Bước 1 mà không ai hướng dẫn.

## Nộp gì

Mỗi bước một kết quả PASS/FAIL, kèm log của bước 4, 5, 6 và dòng canary đầu tiên. Lưu vào
`plans/reports/` theo mẫu `acceptance-{ngày}-second-machine.md`.

## Nó vẫn không chứng minh

- Ký số installer — cần chứng chỉ; build sẽ tự ký khi có `WIN_CSC_LINK`/`CSC_LINK`.
- Xoay credential còn lại — cần console nhà cung cấp.
- Canary — mới bắt đầu, chưa xong.

## Ghi chú về ghế licence

Đây là ràng buộc của **môi trường gate**, không phải của sản phẩm. Bản cài không kèm khoá nào; mỗi
operator tự đăng ký khoá CloakBrowser riêng và dán vào Settings, lưu riêng trên từng máy. Giới hạn
một-trình-duyệt-một-lúc là của gói free trên chính khoá đó.

Bài này thì khác: hai máy gate dùng chung một khoá dev, nên chỉ có một ghế. Bước 4 trên máy mới đòi
máy build đóng app hẳn — không thì nó bị từ chối ghế, và lỗi đó **trông y hệt một lần crash**
(`exit 76`). Xác nhận ghế trống trước khi kết luận bất cứ điều gì.
