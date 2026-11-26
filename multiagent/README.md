# Công cụ chạy kèm

Hai chương trình Node.js chạy độc lập bên cạnh Paperclip, cùng một script khởi động. Chúng không nằm trong mã nguồn Paperclip và không cần build. Xem các chức năng tùy biến trong Paperclip ở [README chính](../README.md).

```
multiagent/
├── tools/
│   ├── webhook-gate.mjs                 cổng webhook Telegram (cổng 3190)
│   ├── cost-watcher.mjs                 ghi nhận token của lượt chạy mất biên nhận
│   └── paperclip-cost-watcher.service   systemd user service cho cost watcher
├── scripts/
│   └── start-local.sh                   chạy Paperclip + cổng webhook
└── docs/images/                         ảnh chụp màn hình dùng trong README
```

## Cổng webhook Telegram

`tools/webhook-gate.mjs`

Paperclip chạy ở chế độ `local_trusted`: ai gọi được cổng 3100 là có toàn quyền điều khiển. Telegram cần một địa chỉ công khai để gửi tin tới, nên phải có tunnel (ngrok), nhưng tunnel **không được** trỏ thẳng vào Paperclip.

Cổng này là thứ duy nhất tunnel chạm tới.
- Chỉ chuyển tiếp `POST /api/chat-webhooks/<publicId>/<provider>`, vốn được Paperclip tự xác thực bằng secret của kênh chat.
- Mọi phương thức hoặc đường dẫn khác nhận `404`.
- Thân request lớn hơn 1 MB nhận `413`.
- Bỏ các header proxy (`x-forwarded-*`, `forwarded`…) trước khi chuyển tiếp.
- Ghi log mỗi request bị chặn hoặc được chuyển tiếp, với id kênh được che đi.

```sh
node multiagent/tools/webhook-gate.mjs
ngrok http 3190
```

| Biến môi trường | Mặc định | Ý nghĩa |
|---|---|---|
| `GATE_PORT` | `3190` | Cổng của cổng webhook |
| `PAPERCLIP_ORIGIN` | `http://127.0.0.1:3100` | Địa chỉ Paperclip để chuyển tiếp tới |

Paperclip phải được khởi động với `PAPERCLIP_CHAT_WEBHOOK_PUBLIC_URL=https://<tên-miền-ngrok>`, để đăng ký đúng địa chỉ webhook với Telegram. Token bot do người điều hành tự dán vào giao diện Paperclip (Apps → Chat).

## Cost watcher

`tools/cost-watcher.mjs`

Paperclip giữ một lượt chạy đã kết thúc ở trạng thái `waiting_for_receipt` cho tới khi nhà cung cấp gửi số liệu sử dụng cuối cùng. Nếu tiến trình của agent chết giữa chừng (bị huỷ khi treo, mất tiến trình), biên nhận không bao giờ tới, và token của lượt đó không vào sổ chi phí.

Cách watcher xử lý:
1. Định kỳ gọi `GET /api/companies/:id/accounting/health` cho từng công ty đang hoạt động.
2. Với mỗi lượt chạy đã chờ biên nhận lâu hơn thời gian ân hạn, đọc số liệu sử dụng mà Paperclip đã quan sát được trên lượt chạy. Nếu lượt chạy dùng nhiều model, đọc riêng từng model.
3. Ghi thành cost event `costStatus: "estimated"` qua `POST /api/companies/:id/cost-events`, với khoá idempotency `backfill:run:<runId>`. Chạy lại không ghi trùng. Lượt chạy thuộc gói thuê bao được ghi chi phí 0.

```sh
node multiagent/tools/cost-watcher.mjs --once --dry-run   # chỉ in ra những gì sẽ ghi
node multiagent/tools/cost-watcher.mjs --once             # ghi một lần rồi thoát
node multiagent/tools/cost-watcher.mjs                    # chạy liên tục
```

| Biến môi trường | Mặc định | Ý nghĩa |
|---|---|---|
| `PAPERCLIP_API` | `http://localhost:3100/api` | Địa chỉ API của Paperclip |
| `PAPERCLIP_ORIGIN` | `http://localhost:3100` | Header `Origin` gửi kèm request ghi |
| `COST_WATCH_POLL_MS` | `30000` | Chu kỳ kiểm tra (ms) |
| `COST_WATCH_GRACE_MS` | `180000` | Thời gian chờ biên nhận thật trước khi ghi ước tính (ms) |

Để chạy nền bằng systemd, xem hướng dẫn ở đầu `tools/paperclip-cost-watcher.service`.

## Script khởi động

`scripts/start-local.sh`

Script chạy Paperclip (`pnpm dev`) ở cổng 3100. Nếu có biến `PAPERCLIP_CHAT_WEBHOOK_PUBLIC_URL`, script chạy thêm cổng webhook ở nền (log ghi vào `~/webhook-gate.log`) và tự tắt cổng khi Paperclip dừng.

```sh
PAPERCLIP_CHAT_WEBHOOK_PUBLIC_URL=https://<tên-miền-ngrok> ./multiagent/scripts/start-local.sh
```

Nên chạy script trong một cửa sổ terminal riêng. Nếu server chạy dưới một công cụ khác, nó có thể bị tắt khi máy thiếu RAM.
