# Canary 7 ngày

Gate này bị nhắc tới như một điều kiện chặn phát hành từ lâu, nhưng **chưa từng được định nghĩa ở
đâu**: không có tiêu chí đạt, không có cách ghi nhận. Một gate như vậy không bao giờ đóng được, vì
không ai biết lúc nào thì nó xong. Tài liệu này là định nghĩa đó.

## Nó đo cái gì

Không phải "phần mềm có chạy không" — cái đó các gate khác đã đo rồi, trong vài phút.

Canary đo thứ **chỉ lộ ra theo thời gian**, trên một máy đang được dùng thật:

- Engine bị thay dưới chân (tự cập nhật, một bản cài khác, một lần dọn dẹp)
- Rule chặn WebRTC biến mất sau một lần Windows Update hoặc một phần mềm bảo mật
- Tiến trình rò rỉ dần qua mỗi lần mở/đóng profile
- Đĩa đầy dần vì cache engine hoặc dữ liệu profile
- Cấu hình trôi đi mà không ai bấm gì

Điểm chung: sáng nào cũng "vẫn chạy tốt", cho tới ngày thứ tư thì không.

## Điều kiện

| Yêu cầu | Vì sao |
|---|---|
| Đúng bản cài đã nghiệm thu | Cài lại giữa chừng là bắt đầu lại từ đầu |
| Máy được **dùng thật** hằng ngày | Máy để không thì không trôi đi đâu cả, và canary thành vô nghĩa |
| 7 ngày lịch **khác nhau** | Đo 7 lần trong một ngày là một ngày bằng chứng, không phải bảy |
| Mỗi ngày ít nhất một lần mở và đóng profile | Rò rỉ tiến trình chỉ đếm được qua vòng đời thật |

## Cách chạy

Mỗi ngày một lần, trên chính máy đó:

```powershell
node scripts/canary-daily-check.cjs
```

Script **chỉ đọc** — không sửa, không tắt, không cài gì. Nó ghi một dòng JSON vào
`scripts/canary-log.jsonl` gồm: phiên bản đã cài, engine và phiên bản engine, trạng thái rule WebRTC
đối chiếu đúng đường dẫn binary, số tiến trình đang sống, số profile, RAM và đĩa trống.

Thoát `0` là ngày sạch. Thoát `1` là có phát hiện, và nó in ra phát hiện đó.

Xem kết quả bất cứ lúc nào:

```powershell
node scripts/canary-daily-check.cjs --summary
```

## Tiêu chí đạt

**Bảy ngày lịch khác nhau, mỗi ngày sạch.** Không có điểm thành phần.

Một phát hiện ở bất kỳ ngày nào là canary **hỏng**, không phải "6/7". Sửa nguyên nhân, rồi bắt đầu
lại từ ngày một. Lý do: thứ đang được chứng minh là **tính liên tục**. Một chuỗi bị đứt rồi nối lại
không chứng minh được điều đó, và nhận nó là đạt thì gate chỉ còn là trang trí.

Nếu phải cài lại sản phẩm giữa chừng vì bất cứ lý do gì — cũng bắt đầu lại.

## Nó KHÔNG chứng minh điều gì

Đây là chỗ hay bị đọc quá lên:

- Chỉ đúng cho **một máy đó**. Không thay được gate máy độc lập thứ hai.
- Không đo trải nghiệm người mới — xem `unfamiliar-operator-acceptance.md`.
- Không liên quan tới việc ký số installer.
- Không nói gì về những máy khác cấu hình khác.

## Bàn giao

Nộp `canary-log.jsonl` cùng kết quả `--summary`. File log là bằng chứng; phần tường thuật không thay
được nó.

Lưu vào `plans/reports/` theo mẫu `acceptance-{ngày}-seven-day-canary.md`, đính kèm log.

## Ghi chú

- Đặt Task Scheduler chạy hằng ngày cũng được, nhưng **vẫn phải thật sự dùng máy** — một cái task
  chạy trên máy bỏ không tạo ra 7 dòng log và không chứng minh gì cả.
- Ngưỡng đĩa đang là 5 GB. Thấp hơn thì ghi phát hiện, vì cache engine và dữ liệu profile là thứ lớn
  dần theo ngày.
