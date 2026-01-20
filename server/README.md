# ws-scrcpy-server

Dự án này là một server WebSocket cho scrcpy, cho phép streaming màn hình từ thiết bị Android qua WebSocket. Server được tách riêng và hỗ trợ nhiều tính năng như device tracking, remote shell, file listing, và recording actions.

## Mô tả

ws-scrcpy-server là một server Node.js cung cấp giao diện WebSocket để kết nối với scrcpy client. Nó hỗ trợ:

- Streaming video từ thiết bị Android
- Điều khiển thiết bị từ xa
- Theo dõi thiết bị (device tracking)
- Remote shell access
- File listing và transfer
- Recording và replay actions
- Hỗ trợ HTTPS và proxy

## Prerequisites

- Node.js (phiên bản 14 trở lên)
- npm hoặc yarn
- ADB (Android Debug Bridge) nếu muốn kết nối thiết bị Android
- Python 3 (cho script open.py)

## Setup

1. **Cài đặt dependencies:**

   ```bash
   npm install
   ```

2. **Cấu hình:**

   Sao chép file cấu hình mẫu:

   ```bash
   cp config.example.yaml config.yaml
   ```

   Chỉnh sửa `config.yaml` theo nhu cầu của bạn. Xem chi tiết trong file `src/types/Configuration.d.ts`.

   Các tùy chọn chính:
   - `runGoogTracker`: Bật tracking thiết bị Android (mặc định: true nếu INCLUDE_GOOG được bật)
   - `runApplTracker`: Bật tracking thiết bị iOS (mặc định: true nếu INCLUDE_APPL được bật)
   - `server`: Cấu hình HTTP/HTTPS servers

3. **Build dự án:**

   ```bash
   npm run build
   ```

   Lệnh này sẽ compile TypeScript và tạo bundle với webpack.

## Chạy server

Sau khi build, chạy server:

```bash
npm start
```

Server sẽ khởi động trên port được cấu hình trong `config.yaml` (mặc định: 8000 cho HTTP, 8443 cho HTTPS).

## Sử dụng

### Kết nối thiết bị

- Đảm bảo ADB được cài đặt và thiết bị Android được kết nối qua USB với debug mode bật.
- Server sẽ tự động phát hiện thiết bị.

### WebSocket endpoints

- `/ws`: WebSocket endpoint chính cho scrcpy streaming
- Các middleware khác như WebsocketProxy, DeviceTracker, etc.

### API endpoints

- `POST /api/recordings/start`: Bắt đầu recording
- `POST /api/recordings/stop`: Dừng recording
- `POST /api/recordings/run`: Chạy recording đã lưu

### Recordings

Action recordings được lưu trong thư mục `recordings/` dưới dạng JSON.

- Bắt đầu session với query: `action=proxy-ws&ws=<remote>&record=<id>`
- Replay: `...&replay=<id>`

## Build config

Dự án sử dụng conditional compilation. Cấu hình build trong `webpack/default.build.config.json`:

- `INCLUDE_GOOG`: Hỗ trợ Android devices
- `INCLUDE_APPL`: Hỗ trợ iOS devices
- Các tùy chọn khác cho video codecs, etc.

Để override, chỉnh sửa `build.config.override.json`.

## Phát triển

- `npm run build:dev`: Build với watch mode
- `npm run clean`: Xóa thư mục dist

## Script open.py

Script Python `open.py` có thể được sử dụng để tự động mở browser hoặc kết nối thiết bị. Chỉnh sửa danh sách SERIALS trong file để phù hợp với thiết bị của bạn.

## License

MIT
