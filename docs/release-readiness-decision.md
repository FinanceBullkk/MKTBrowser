# 0.3.23 — còn lại gì, và bỏ qua thì đang chấp nhận gì

Báo cáo nghiệm thu dài hơn 1000 dòng. Trang này là thứ cần để **quyết**, không phải để tra cứu.

Ngày 14/09/2026. Team đang chạy Browser `0.3.17` / Relay `17` / sequence `21`. Ứng viên `0.3.23`
đã qua toàn bộ gate kỹ thuật.

## Đã đóng

Đóng gói, publish bất biến, đọc lại qua route sống, vòng đời installer (cài/sửa/gỡ), Relay đóng gói
(trọn vòng mật mã), **mở profile qua proxy thật kèm từ chối và phục hồi**, machine-integration,
backup + khôi phục thử. Hai bộ gate release xanh end-to-end: MKTBrowser 8/8 bước, MKTTool đủ 4 tầng.
Production khỏe.

Mọi thứ code, cấu hình hay đo đạc đóng được đều đã đóng.

## Còn lại sáu — và nghĩa thật của từng cái

Xếp theo **hậu quả nếu bỏ qua**, không theo thứ tự dễ làm.

### 1. Chưa ai ngoài máy build chạy thử — `admin-laptop` đang tắt

- **Bảo vệ khỏi**: "chạy được" hoá ra là "máy này tình cờ đã đủ điều kiện". Máy build có engine đã
  provision, rule WebRTC đã tạo từ lâu, Node/Yarn/biến môi trường đã có sẵn.
- **Bỏ qua thì**: người đầu tiên cài trên máy sạch có thể gặp lỗi mà chưa ai từng thấy, ở đúng
  bước đầu tiên.
- **Hồi phục được không**: được — gỡ ra, quay về 0.3.17.
- **Chi phí đóng**: bật laptop, chạy `second-machine-acceptance.md`. Vài giờ.
- **Đây là việc đáng làm trước nhất.** Nếu người chạy chưa từng dùng sản phẩm thì đóng luôn mục 2.

### 2. Chưa có người lạ nào cài thử

- **Bảo vệ khỏi**: sản phẩm chỉ dùng được bởi người đã biết nó hoạt động thế nào.
- **Bỏ qua thì**: mỗi lần onboard một người là một lần có người phải ngồi kèm. Không hỏng, nhưng
  đắt, và không ai đo được cái giá đó.
- **Hồi phục được không**: được — sửa câu chữ rồi phát lại.
- **Chi phí đóng**: một người + `unfamiliar-operator-acceptance.md`. Một buổi.

### 3. Installer chưa ký số

- **Bảo vệ khỏi**: SmartScreen chặn ở lần chạy đầu trên mọi máy.
- **Bỏ qua thì**: **chắc chắn xảy ra**, không phải rủi ro — mọi người cài đều gặp cảnh báo
  "Unknown publisher". Nội bộ thì dạy nhau bấm qua được; nhưng nó cũng dạy team thói quen bấm qua
  cảnh báo của Windows, và đó là thói quen tệ.
- **Hồi phục được không**: được, nhưng phải phát lại bản đã ký.
- **Chi phí đóng**: mua chứng chỉ. Wiring build đã xong — có `WIN_CSC_LINK`/`CSC_LINK` là tự ký.

### 4. Credential lộ chưa xoay xong

- **Bảo vệ khỏi**: ai đọc được log chẩn đoán hôm 13/09 vẫn đang cầm khoá R2, `DATABASE_URL`,
  secret OAuth, khoá ký vé, khoá vault server.
- **Bỏ qua thì**: **đây là mục nguy hiểm nhất trong sáu mục.** Không liên quan tới việc 0.3.23 có
  tốt hay không — nó đang mở **ngay bây giờ**, với cả `0.3.17` mà team đang dùng.
- **Hồi phục được không**: dữ liệu bị lấy thì không lấy lại được.
- **Chi phí đóng**: console Cloudflare/Railway/Google/Meta, theo
  `MKTTool/docs/credential-rotation-runbook.md`. Backup + khôi phục thử đã sẵn sàng.
- **Việc này không nên chờ 0.3.23.** Nó nên làm bất kể quyết định phát hành ra sao.

### 5. Canary 7 ngày mới được 1

- **Bảo vệ khỏi**: thứ chỉ hỏng theo thời gian — engine bị thay dưới chân, rule WebRTC mất sau một
  lần Windows Update, tiến trình rò rỉ dần, đĩa đầy dần.
- **Bỏ qua thì**: những cái đó vẫn sẽ lộ ra, chỉ là lộ ra ở máy team thay vì máy test.
- **Hồi phục được không**: được, tuỳ cái gì hỏng.
- **Chi phí đóng**: 6 ngày. Task đã tự chạy, không cần ai nhớ.

### 6. Một thư mục mồ côi trên máy build

- **Nội dung**: 18 MB, chỉ có `engines/`, **không cookie, không lịch sử, không đăng nhập**. Từ
  25/08, không đụng tới từ đó.
- **Bỏ qua thì**: không gì cả. Nó chỉ làm mọi phép đếm thư mục lệch 1.
- **Chi phí đóng**: xoá thư mục. Một giây.

## Ba đường đi

| Đường | Nghĩa là gì |
|---|---|
| **Chờ đủ** | Làm 1→5, rồi promote. Sạch nhất, chậm nhất. Nhưng mục 4 **phải làm ngay bất kể chọn đường nào** |
| **Nội bộ có điều kiện** | Phát 0.3.23 cho team, chấp nhận SmartScreen và chấp nhận rằng người đầu tiên cài trên máy sạch là người thử nghiệm. Chỉ nên chọn nếu 0.3.23 giải quyết một vấn đề mà team đang chịu đựng thật |
| **Giữ 0.3.17** | Không làm gì. Nhưng mục 4 vẫn mở, nên "không làm gì" **không phải** là an toàn |

Điểm quan trọng của bảng này: **không có đường nào khiến mục 4 tự biến mất.** Credential đang lộ là
vấn đề của hôm nay, không phải của lần phát hành sau.

## Ai làm gì

| Việc | Ai | Bao lâu |
|---|---|---|
| Xoay credential còn lại | người có quyền console | nửa ngày, cần cửa sổ bảo trì cho 2 bước |
| Bật `admin-laptop`, chạy nghiệm thu | chủ máy | vài giờ |
| Cho một người lạ cài thử | bất kỳ ai chưa dùng sản phẩm | một buổi |
| Mua chứng chỉ ký | chủ sở hữu | tuỳ nhà cung cấp |
| Canary | không ai cả — đã tự chạy | 6 ngày |
| Xoá thư mục mồ côi | chủ máy | một giây |

Không việc nào ở trên là việc kỹ thuật còn thiếu. Mọi công cụ, kịch bản và quy trình cho từng việc
đều đã có trong repo.
