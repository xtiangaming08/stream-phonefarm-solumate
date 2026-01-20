# Hướng dẫn nhanh (docs)

> Không kèm hình minh họa vì phiên làm việc này không thể tự chụp. Bạn có thể mở app và chụp nếu cần.

## 1. Chạy ứng dụng
- Backend WS mặc định: `ws://127.0.0.1:11000/`. Thay bằng `?ws=<url>` nếu khác.
- Tham số `?device=<udid>` để mở 1 thiết bị duy nhất.

## 2. Lưới tile
- Mỗi tile hiển thị stream, badge “USB”, header với số thứ tự/udid/trạng thái.
- Nút header: `⠿` (kéo đổi chỗ), `↻` (reload stream), `⋯` (menu: reload, shell, file list, power/volume, screenshot, mở viewer 👁).
- Dưới cùng tile: Back/Home/Recent.
- Kích thước tile (width) chỉnh ở cột phải, height tự tính.
- Kéo nút `⠿` sang tile khác để đổi vị trí, thứ tự lưu trong localStorage (`tileOrder`).

## 3. Viewer (mở riêng)
- Mở qua menu `👁`. Viewer nổi, kéo bằng header, chỉ 1 viewer cùng lúc.
- Cấu hình viewer (width) và stream override nằm ở cột phải (tiêu đề “Cấu hình stream (viewer)”).
- Đóng viewer để trả config về global, tile gốc hết bị mờ.

## 4. Cột phải
- Header thương hiệu + ô search (trang trí), hàng tab/pill (trang trí).
- **Kích thước tile**: slider width.
- **Cấu hình stream**: View width (viewer), Bitrate, FPS, Chiều rộng stream (height auto), Khóa xoay, Đặt lại mặc định. Nếu viewer đang mở thì áp dụng riêng cho thiết bị đó.
- **Điều khiển nhanh**: Power, Vol +/-, Mute, Back, Home, Recent, Screenshot (device active hoặc nhóm sync).
- **Sync thiết bị**: bật/tắt sync, chọn device chính (radio), follower dạng lưới checkbox, nút dừng sync. Khối “thiết bị không có thẻ” là minh họa.
- **Bộ lọc/Thẻ**: Cục bộ/Trực tuyến, Tất cả/USB/WIFI/OTG/Tiếp cận, danh sách registeredUdids (trang trí).

## 5. Sync
- Bật sync → chọn main & follower trong cột phải. Tắt sync để điều khiển đơn lẻ.
- Trạng thái lưu trong ActiveContext (localStorage: syncAll, syncMain, syncTargets).

## 6. File & Shell
- Hash actions:
  - `#!action=shell&udid=<id>`: trang Shell (multiplex).
  - `#!action=list-files&udid=<id>&path=/...`: trang file listing.
- Trong menu tile (⋯) có mở shell/file list tab mới cho udid đó.

## 7. Điều khiển/Phím
- Quick controls gửi keycode tới device active hoặc nhóm sync.
- Canvas hỗ trợ touch/scroll; keyboard mapping từ `useDirectKeyboard`.

## 8. Lưu cục bộ
- `deviceDimensions`, `tileOrder`, `viewerWidthPx`, `sync*` trong ActiveContext.
- Config viewer override chỉ tồn tại runtime.

## 9. Troubleshooting
- Màn hình đen: kiểm tra backend WS, giảm bitrate/FPS, dùng nút `↻`.
- Không thấy device: thêm `?device=<udid>` hoặc kiểm tra tracker WS.
- Reorder không lưu: xoá/localStorage `tileOrder` rồi reload.

## 10. Tham khảo thêm
- Xem `docs/USER_GUIDE.md` để biết chi tiết hơn về từng tính năng.
