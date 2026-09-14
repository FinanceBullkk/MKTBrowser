# Nghiệm thu bởi người chưa từng dùng sản phẩm

Dành cho người **chưa từng cài hoặc dùng MKT Browser**. Đó là điều kiện của bài này: nếu bạn đã quen
sản phẩm, bạn sẽ vô thức bỏ qua đúng những chỗ mà bài này cần tìm.

Đừng hỏi ai trong lúc làm. Chỗ nào bạn phải hỏi mới đi tiếp được — **đó chính là kết quả**, ghi lại
rồi mới hỏi.

## Người giao việc chuẩn bị trước

| Thứ | Ghi chú |
|---|---|
| File cài đặt | Đúng file đã giữ lại, không phải bản build mới |
| SHA-256 của file cài | Để người làm tự đối chiếu ở Bước 0 |
| 1 dòng proxy | Dạng `host:port:user:pass` |
| **Không** đưa khoá CloakBrowser | Người làm tự đăng ký khoá riêng — xem *Ghi cho người giao việc* |
| Máy Windows | Không phải máy đã từng cài sản phẩm |

## Cách ghi kết quả

Mỗi bước ghi **PASS**, **FAIL**, hoặc **STUCK** (không biết phải làm gì tiếp).

STUCK không phải là bạn dở. Đây là bài đo xem sản phẩm có tự giải thích được không.

Với FAIL/STUCK, ghi thêm:
- Bạn tưởng chuyện gì sẽ xảy ra
- Thực tế xảy ra gì (chụp màn hình nếu có chữ)
- Bạn đã thử gì trước khi bí

## Bước 0 — Trước khi cài

1. Đối chiếu SHA-256 của file cài với con số được giao:
   ```powershell
   Get-FileHash -Algorithm SHA256 "<đường dẫn file cài>"
   ```
   Không khớp thì **dừng lại**, đừng cài.
2. Ghi lại: Windows bản mấy, RAM bao nhiêu, máy này đã từng cài sản phẩm chưa.

## Bước 1 — Cài đặt

Chạy file cài.

Ghi lại **đúng nguyên văn** mọi cảnh báo của Windows (SmartScreen, "Unknown publisher", UAC). Ghi cả
việc bạn đã bấm gì để đi tiếp — và **bạn có thấy ngại khi bấm không**. Câu trả lời đó quan trọng:
sản phẩm hiện chưa được ký số, nên phản ứng thật của bạn chính là thứ cần đo.

Cài xong: có shortcut không? Nó nằm ở đâu?

## Bước 2 — Mở lần đầu

Mở MKT Browser.

- Bao lâu thì có gì đó hiện lên?
- Màn hình đầu tiên bảo bạn làm gì?
- Có phải chờ engine tải về không? Có thanh tiến trình không, hay chỉ đứng im?
- Nếu có màn hình đăng nhập hoặc kích hoạt: bạn có tự biết cần gì không?
- Sau khi qua màn chào, có dải nhắc nào nói bạn chưa có khoá CloakBrowser không? Nó có nói khoá là
  **của riêng bạn** và chỉ được chỗ đăng ký không? Đọc xong bạn có biết phải làm gì tiếp không, hay
  vẫn phải đoán? Không thấy dải đó, hoặc đọc xong vẫn không hiểu — ghi STUCK.
- Đừng xin khoá của người giao việc — dùng khoá người khác là hỏng bài, vì đúng chỗ đó mới là thứ
  cần đo.

**Không tự sửa file cấu hình nào.** Bí ở đâu thì ghi STUCK ở đó.

## Bước 3 — Tạo một profile

Tạo một profile mới, đặt tên `NGHIEM-THU-01`.

- Bạn có tự tìm ra nút tạo không? Mất bao lâu?
- Có mục nào bắt điền mà bạn không hiểu là gì không? Ghi tên đúng của mục đó.

## Bước 4 — Gắn proxy

Điền dòng proxy được giao vào profile.

- Ô nhập có nhận nguyên dòng `host:port:user:pass` không, hay phải tách ra từng ô?
- Có nút kiểm tra proxy không? Bấm thì nó nói gì?

## Bước 5 — Mở profile

Mở profile vừa tạo.

- Cửa sổ trình duyệt có hiện ra không? Bao lâu?
- Nếu báo lỗi: chép **nguyên văn** câu báo lỗi. Câu đó có nói cho bạn biết phải làm gì không, hay chỉ
  nói là hỏng?

Trình duyệt mở được thì vào `https://ipinfo.io/json` và ghi lại IP nó hiện.

## Bước 6 — Đối chiếu IP

Mở **Chrome hoặc Edge thường** trên cùng máy, vào cùng địa chỉ đó, ghi lại IP.

Hai IP **phải khác nhau**. Giống nhau nghĩa là profile đang chạy bằng mạng nhà bạn chứ không qua
proxy — ghi **FAIL** và dừng lại, báo ngay.

## Bước 7 — Đóng và mở lại

Đóng profile. Mở lại. Đóng lần nữa.

- Đóng xong tiến trình có thật sự tắt không? Mở Task Manager xem còn `chrome.exe` hoặc `MKTBrowser`
  nào sót lại không.
- Mở lại có nhanh hơn lần đầu không?

## Bước 8 — Tắt hẳn sản phẩm

Thoát MKT Browser hoàn toàn.

- Có icon nào còn nằm dưới khay hệ thống không?
- Task Manager còn tiến trình nào tên `MKTBrowser` hoặc `MKTTool-Relay` không? Ghi lại.

## Bước 9 — Gỡ cài đặt

Gỡ qua Settings → Apps của Windows.

- Gỡ có cần quyền admin không? Có hỏi gì không?
- Gỡ xong, thư mục cài còn sót lại gì không?
- Có bị hỏi "bạn có chắc không" một cách khó hiểu không?

## Bước 10 — Câu hỏi cuối

Trả lời ngắn, thật lòng:

1. Có lúc nào bạn tưởng mình làm hỏng sản phẩm không? Lúc nào?
2. Câu thông báo nào khiến bạn không biết phải làm gì tiếp?
3. Nếu không có ai hướng dẫn, bạn có tự đi hết được từ đầu tới cuối không?
4. Chỗ nào bạn phải đoán?

## Bàn giao

Gửi lại: bảng PASS/FAIL/STUCK từng bước, các ảnh chụp màn hình, hai IP ở Bước 6, và phần trả lời
Bước 10.

Một bước FAIL hoặc STUCK là đủ để gate này **chưa đạt**. Bài này không có điểm thành phần.

## Ghi cho người giao việc

- Bài này đo trải nghiệm người mới, **không** đo được máy độc lập, canary 7 ngày, hay việc ký số.
  Đó là các gate riêng.
- Cảnh báo SmartScreen ở Bước 1 là dự kiến cho tới khi installer được ký. Ghi nhận phản ứng, đừng
  dạy người làm cách bỏ qua nó — chính phản ứng chưa được dạy mới là dữ liệu.
- Sản phẩm là **mỗi operator một khoá riêng**: bản cài không kèm khoá nào, khoá do người dùng tự dán
  vào Settings và lưu riêng trên từng máy. Đưa khoá của mình cho người làm vừa che mất bước cần đo,
  vừa đụng giới hạn một-trình-duyệt-một-lúc của gói free trên khoá đó — và lần từ chối đó hiện ra
  trông y như một cú crash.
- Lưu kết quả vào `plans/reports/` theo mẫu `acceptance-{ngày}-unfamiliar-operator.md`.
