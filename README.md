# Paperclip Multi-Agent

Bản tùy biến (fork) của **[Paperclip](https://github.com/paperclipai/paperclip)**, một nền tảng điều khiển (control plane) để quản lý các AI agent như nhân viên của một công ty.

Repo này bổ sung vào Paperclip **7 chức năng mới** và **2 công cụ chạy kèm**. Chúng giúp người điều hành theo dõi trực quan đội agent, giữ agent làm việc liên tục khi hết token, xem agent đã thay đổi mã nguồn những gì, và điều khiển hệ thống an toàn qua Telegram. Toàn bộ thay đổi nằm trong 63 commit trên nền Paperclip gốc.

![Office 3D](multiagent/docs/images/office-3d.png)

## Mục lục

- [Tổng quan các chức năng đã thêm](#tổng-quan-các-chức-năng-đã-thêm)
- [1. Office 3D](#1-office-3d)
- [2. Analytics](#2-analytics)
- [3. Model connections: tự đổi model khi hết token](#3-model-connections-tự-đổi-model-khi-hết-token)
- [4. OpenCode watchdog](#4-opencode-watchdog)
- [5. Tab Changes: mỗi lượt chạy đã sửa gì](#5-tab-changes-mỗi-lượt-chạy-đã-sửa-gì)
- [6. Tab Code của dự án](#6-tab-code-của-dự-án)
- [7. Team feed](#7-team-feed)
- [8. Cổng webhook Telegram](#8-cổng-webhook-telegram)
- [9. Cost watcher](#9-cost-watcher)
- [Thay đổi cơ sở dữ liệu và API](#thay-đổi-cơ-sở-dữ-liệu-và-api)
- [Cài đặt và chạy](#cài-đặt-và-chạy)
- [Tài liệu thiết kế](#tài-liệu-thiết-kế)
- [Ghi công và giấy phép](#ghi-công-và-giấy-phép)

## Tổng quan các chức năng đã thêm

| # | Chức năng | Giải quyết vấn đề gì | Xem ở đâu |
|---|---|---|---|
| 1 | **Office 3D** | Nhìn một lần biết agent nào thuộc phòng ban nào, ai đang làm gì, ai cần người xử lý | Thanh bên → **Office** |
| 2 | **Analytics** | Thống kê thời gian làm việc theo agent và token theo model | Thanh bên → **Analytics** |
| 3 | **Model connections** | Agent hết token thì tự chuyển sang tài khoản hoặc nhà cung cấp khác, xong việc thì quay lại | Agent → tab **Model connections** |
| 4 | **OpenCode watchdog** | OpenCode treo im lặng khi hết hạn mức; watchdog phát hiện và kết thúc lượt chạy đúng lỗi | Tự động |
| 5 | **Tab Changes** | Xem từng lượt chạy của agent đã sửa tệp nào, dòng nào (diff xanh/đỏ) | Task → khung bên phải → **Changes** |
| 6 | **Tab Code** | Duyệt mã nguồn mới nhất của dự án ngay trong Paperclip, tự cập nhật | Project → tab **Code** |
| 7 | **Team feed** | Một bảng tin chỉ để đọc: task nào đổi trạng thái, agent ghi chú gì, tệp nào thay đổi | Thanh bên → **Team feed** |
| 8 | **Cổng webhook Telegram** | Nhận tin Telegram qua tunnel mà không lộ trang quản trị ra Internet | `multiagent/tools/webhook-gate.mjs` |
| 9 | **Cost watcher** | Ghi nhận token của những lượt chạy bị mất tiến trình, để báo cáo chi phí không bị thiếu | `multiagent/tools/cost-watcher.mjs` |

Chức năng 1–7 nằm trong mã nguồn Paperclip (server, giao diện, cơ sở dữ liệu). Hai công cụ 8–9 là chương trình Node.js chạy độc lập bên cạnh, nằm trong thư mục [`multiagent/`](multiagent/).

---

## 1. Office 3D

**Vấn đề.** Trang Agents của Paperclip là một danh sách. Khi có nhiều agent, rất khó trả lời nhanh ba câu: ai thuộc phòng ban nào, ai đang làm việc gì, đội đã làm được bao nhiêu và tốn bao nhiêu.

**Cách hoạt động.** Trang mới `/office` gồm ba cột:

- **Cột trái (Agent):** số agent đang làm / cần xử lý / rảnh, và thẻ agent chia ba nhóm:
  - **Cần bạn xử lý:** agent lỗi, bị tạm dừng vì ngân sách hoặc lỗi, có approval đang chờ, có task bị chặn cần người gỡ, hoặc có task chờ người review.
  - **Đang làm:** có lượt chạy đang chạy, kèm mã task, trạng thái hiện tại và đồng hồ đếm giờ.
  - **Rảnh:** lần hoạt động cuối, task đang chờ (nếu bị chặn bởi việc của agent khác).
- **Giữa:** mặt bằng văn phòng 3D (three.js) có thể xoay, kéo, phóng to. Có 4 phòng ban (Ban Điều hành, Phân tích & Thiết kế, Kỹ thuật, Kiểm định) và các khu dùng chung (phòng họp, phòng server, pantry). Mỗi agent là một nhân vật có nhãn tên, model đang dùng, mã task và bong bóng trạng thái. Agent rảnh tự về đúng phòng của mình. Thanh công cụ có các nút: về góc nhìn mặc định, chọn camera theo phòng, phóng to/thu nhỏ, toàn màn hình, bám theo agent đang chọn.
- **Cột phải:** thống kê tháng này (việc đã xong, token và chi phí, thời gian chạy, số agent đang làm), task gần đây và luồng hoạt động trực tiếp có bộ lọc.

Thẻ agent và nhãn trên sân khấu cũng hiển thị **kết nối model đang dùng**, kèm nhãn "Fallback" khi agent đang chạy bằng tầng dự phòng (xem chức năng 3).

**Mã nguồn:** `ui/src/pages/Office.tsx`, `ui/src/components/office/`.

## 2. Analytics

**Vấn đề.** Trang Costs của Paperclip tổng hợp chi phí, nhưng không cho thấy mỗi agent thực sự làm việc bao nhiêu giờ, và token phân bổ theo model ra sao.

**Cách hoạt động.** Trang mới `/analytics` có bộ chọn khoảng thời gian (Hôm qua, Hôm nay, 7 ngày, 30 ngày, hoặc từ ngày – đến ngày) và hai biểu đồ:

- **Thời gian làm việc của agent:** biểu đồ đường, mỗi agent một đường. Khoảng ngắn tính theo giờ (số phút làm việc mỗi giờ), khoảng dài tính theo ngày (số giờ làm việc mỗi ngày). Bấm tên agent để ẩn hoặc hiện đường của agent đó. Bên dưới là bảng tổng thời gian của từng agent.
- **Token theo model:** thanh ngang cho mỗi model đã dùng (Sonnet, Opus, DeepSeek, Kimi, GPT…). Bấm một model để xem những agent nào đã dùng model đó và dùng bao nhiêu.

Thời gian làm việc được tính từ thời điểm bắt đầu và kết thúc của các lượt chạy (heartbeat run). Token lấy từ số liệu sử dụng của từng lượt chạy.

**Mã nguồn:** `ui/src/pages/Analytics.tsx`, `ui/src/components/analytics/`, `ui/src/lib/analytics/`.

![Analytics](multiagent/docs/images/analytics.png)

## 3. Model connections: tự đổi model khi hết token

**Vấn đề.** Các gói thuê bao AI giới hạn token theo khung 5 giờ và theo tuần. Khi agent hết hạn mức, Paperclip gốc ghi lượt chạy thất bại (`provider_quota`) rồi **chờ tới giờ đặt lại** mới chạy lại trên đúng nhà cung cấp đó. Công việc đứng hàng giờ, trừ khi người điều hành tự vào đổi harness và model bằng tay.

**Cách hoạt động.** Mỗi agent có một **chuỗi kết nối** có thứ tự. Mỗi kết nối gồm harness (Claude Code, OpenCode, Codex), tài khoản và model. Vị trí 1 là kết nối **mặc định**, chính là cấu hình bình thường của agent ở tab Harness / Runtime. Các vị trí sau là **dự phòng**.

Quy tắc chuyển đổi:

1. **Hết token thì chuyển ngay.** Khi một lượt chạy thất bại vì `provider_quota`, **tài khoản** đó bị đánh dấu hết cho tới giờ đặt lại (đọc từ thông báo lỗi). Agent chuyển sang kết nối kế tiếp còn dùng được, và task bị gián đoạn được chạy lại ngay, không chờ.
2. **Hết hạn mức là của tài khoản, không phải của agent.** Mọi agent khác đang dùng chung tài khoản đó cũng coi như hết và chuyển trước lượt chạy kế tiếp, không cần thất bại thêm một lần.
3. **Không cắt ngang lượt đang chạy.** Việc chuyển chỉ áp dụng từ lượt chạy sau.
4. **Xong task rồi mới quay về.** Agent ở lại tầng dự phòng cho tới khi task đang làm kết thúc (`done`, `in_review`, `cancelled`, `blocked`), rồi quay về mặc định khi tài khoản mặc định đã qua giờ đặt lại.
5. **Bỏ qua tầng không dùng được.** Một kết nối lỗi xác thực hoặc cấu hình bị đánh dấu "không dùng được" và bị bỏ qua, chuỗi đi tiếp tầng sau thay vì dừng lại.

**Giao diện.** Tab **Model connections** trên trang agent hiển thị:

- kết nối đang dùng, task hiện tại, số lần chuyển trong ngày, kết nối mặc định;
- **bản đồ kết nối trực tiếp:** agent ở giữa, các tầng xếp theo thứ tự, đường nối sáng lên ở tầng đang dùng, mỗi tầng có trạng thái (Sẵn sàng / Đang dùng / Hết đến … / Không dùng được) và số lượt chạy, token trong ngày;
- **dòng thời gian** các lượt chạy và các lần chuyển hoặc quay về trong ngày;
- nút thêm kết nối (OpenCode Go, tài khoản Claude khác, Codex), sửa, kéo thả đổi thứ tự, đặt làm mặc định, và hộp **Switching settings**: bật/tắt tự chuyển, số phút chờ khi lỗi không cho biết giờ đặt lại, sắp xếp thứ tự chuỗi bằng bàn phím.

Header của agent và trang Office cũng hiển thị kết nối đang dùng.

**Mã nguồn:**
- Server: `server/src/services/model-fallback/` (`policy.ts` chọn tầng, `classify.ts` phân loại lỗi, `service.ts`, `dispatch-wiring.ts` nối vào luồng heartbeat), `server/src/routes/model-fallback.ts`
- Kiểu dữ liệu chung: `packages/shared/src/model-fallback.ts`
- Bảng mới: `agent_model_fallback_states`, `model_account_exhaustions`
- Giao diện: `ui/src/components/model-fallback/`

![Model connections](multiagent/docs/images/model-connections.png)

## 4. OpenCode watchdog

**Vấn đề.** Claude Code và Codex báo lỗi rõ ràng khi hết hạn mức. OpenCode thì không: khi gói OpenCode Go hết hạn mức, tiến trình ngừng in ra nhưng vẫn sống. Lượt chạy treo 15–30 phút cho tới khi có người huỷ tay, và model fallback không biết để chuyển tầng.

**Cách hoạt động.** Trong lúc lượt chạy OpenCode diễn ra, watchdog tìm phiên làm việc tương ứng (từ thông tin resume hoặc từ log của OpenCode) và theo dõi log đó. Khi thấy dấu hiệu hết hạn mức, nó kết thúc lượt chạy với mã lỗi `provider_quota`, để chức năng 3 chuyển agent sang tầng khác ngay.

**Mã nguồn:** `packages/adapters/opencode-local/src/server/usage-limit-watchdog.ts`.

## 5. Tab Changes: mỗi lượt chạy đã sửa gì

**Vấn đề.** Muốn biết agent đã thay đổi gì trong một lượt chạy, người điều hành phải mở pull request trên GitHub, hoặc đọc log dài của lượt chạy. Lượt chạy không mở PR (bị huỷ, đang làm dở) thì gần như không xem được.

**Cách hoạt động.**
- Trước và sau mỗi lượt chạy, server chụp trạng thái git của workspace, kể cả các repo lồng bên trong workspace.
- Từ hai ảnh chụp đó, server tính danh sách tệp thay đổi, số dòng thêm/xoá và diff của từng tệp.
- Server cũng trích danh sách lệnh agent đã chạy trong lượt đó.
- Khi nhiều lượt chạy dùng chung một workspace, mỗi lượt vẫn được ghi riêng.
- Việc ghi nhận chạy nền, không làm chậm lượt chạy.

**Giao diện.** Trong trang task, khung bên phải có tab **Changes**. Mỗi lượt chạy là một mục: agent, thời gian, trạng thái, số tệp, +/−. Mở ra sẽ thấy các lệnh đã chạy và diff từng tệp, dòng thêm màu xanh, dòng xoá màu đỏ. Lượt chạy không đổi mã hoặc chạy ngoài git workspace được tóm tắt riêng.

**Mã nguồn:**
- Server: `server/src/services/run-changes/` (`git-snapshot.ts`, `commands.ts`, `service.ts`, `worker.ts`)
- Bảng mới: `heartbeat_run_changes`, `heartbeat_run_change_files`
- Giao diện: `ui/src/components/task-side-panel/TaskRunChangesPanel.tsx`

![Tab Changes](multiagent/docs/images/changes-tab.png)

## 6. Tab Code của dự án

**Vấn đề.** Paperclip gốc chỉ cho duyệt tệp trong workspace riêng của từng agent, và đó thường là một nhánh đang làm dở. Không có chỗ nào xem **mã nguồn chính thức mới nhất** của dự án.

**Cách hoạt động.**
- Mỗi project trỏ tới một bản sao cục bộ của nhánh chính (ví dụ `main`).
- Server tự cập nhật bản sao này bằng `git fetch` + fast-forward vào ba lúc: khi một task của project chuyển sang `done`, khi mở tab (tối đa 1 lần mỗi phút), và khi bấm nút **Update**.
- Server chỉ fast-forward, không bao giờ ghi đè thay đổi cục bộ.
- Không gọi model, không tốn token, không cần giao việc cho agent.

**Giao diện.** Tab **Code** trên trang project hiện commit đang xem và thời điểm cập nhật. Bên trái là cây thư mục có ô tìm tệp, bên phải là nội dung tệp. Tệp Markdown có chế độ xem trước, và có nút tải tệp về.

**Mã nguồn:**
- Server: `server/src/services/project-code-view/`, `server/src/routes/project-code-view.ts`
- Kiểu dữ liệu chung: `packages/shared/src/project-code-view.ts`
- Giao diện: `ui/src/components/project-code/`

![Tab Code](multiagent/docs/images/code-tab.png)

## 7. Team feed

**Vấn đề.** Khi nhiều agent làm việc cùng lúc, người điều hành cần một nơi đọc lướt xem đội đã làm gì, mà không phải mở từng task.

**Cách hoạt động.** Trang `/team-feed` là một bảng tin **chỉ để đọc**. Mỗi lần một task đổi trạng thái là một mục, gồm:

- agent, mã và tên task, trạng thái cũ → trạng thái mới, thời gian;
- ghi chú của agent ở thời điểm đó (comment gần nhất);
- các tệp mà công việc đó đã thay đổi, với số dòng +/− (lấy từ dữ liệu của tab Changes), và link "View changes".

Trang chỉ đọc dữ liệu có sẵn, không gọi model và không thay đổi gì. Task riêng tư được lọc theo quyền của người xem.

**Mã nguồn:**
- Server: `server/src/services/team-feed/` (`derive.ts` dựng các mục từ lịch sử hoạt động), `server/src/routes/team-feed.ts`
- Kiểu dữ liệu chung: `packages/shared/src/team-feed.ts`
- Giao diện: `ui/src/pages/TeamFeed.tsx`

![Team feed](multiagent/docs/images/team-feed.png)

## 8. Cổng webhook Telegram

**Vấn đề.** Paperclip có sẵn kênh chat Telegram. Nhưng Telegram cần một địa chỉ công khai để gửi tin tới, trong khi Paperclip chạy ở chế độ `local_trusted`: ai gọi được cổng 3100 là có toàn quyền. Mở tunnel (ngrok) thẳng vào 3100 đồng nghĩa với việc đưa trang quản trị ra Internet.

**Cách hoạt động.** Một proxy nhỏ chạy ở cổng 3190 và là thứ duy nhất tunnel chạm tới.
- Nó chỉ chuyển tiếp đúng `POST /api/chat-webhooks/<id>/<provider>`, vốn được Paperclip tự xác thực. Mọi request khác nhận 404.
- Nó giới hạn thân request ở 1 MB và bỏ các header proxy.
- Nó ghi log những request bị chặn.

**Cách dùng:** xem [`multiagent/README.md`](multiagent/README.md#cổng-webhook-telegram).

## 9. Cost watcher

**Vấn đề.** Paperclip giữ một lượt chạy ở trạng thái "chờ biên nhận" cho tới khi nhà cung cấp gửi số liệu sử dụng cuối cùng. Nếu tiến trình agent chết giữa chừng, biên nhận không bao giờ tới, và token của lượt đó không bao giờ vào sổ chi phí. Trang Costs và Analytics vì thế báo thiếu.

**Cách hoạt động.**
- Watcher định kỳ hỏi API sức khoẻ kế toán của từng công ty.
- Khi một lượt chạy đã chờ biên nhận quá 3 phút, nó ghi lượng token Paperclip đã quan sát được thành một cost event loại *estimated*, thông qua API của chính Paperclip.
- Mỗi event có khoá idempotency, nên chạy lại không bị ghi trùng.

**Cách dùng:** xem [`multiagent/README.md`](multiagent/README.md#cost-watcher).

---

## Thay đổi cơ sở dữ liệu và API

**Migration mới** (`packages/db/src/migrations/`):

| Migration | Nội dung |
|---|---|
| `0432_aspiring_marauders.sql` | Bảng `agent_model_fallback_states` (agent đang ở tầng nào, vì sao) và `model_account_exhaustions` (tài khoản nào hết hạn mức đến khi nào) |
| `0433_lowly_stryfe.sql` | Bảng `heartbeat_run_changes` và `heartbeat_run_change_files` (thay đổi mã theo lượt chạy) |
| `0434_parched_sphinx.sql` | Thêm cột `start_snapshots`, `end_snapshots` để ghi được nhiều repo lồng nhau |

**API mới** (tiền tố `/api`):

| Phương thức | Đường dẫn | Chức năng |
|---|---|---|
| GET | `/agents/:id/model-fallback` | Chuỗi kết nối, tầng đang dùng, dòng thời gian của agent |
| GET | `/companies/:companyId/model-fallback/active` | Các agent đang chạy bằng tầng dự phòng |
| GET | `/issues/:id/run-changes` | Thay đổi mã của từng lượt chạy trong task |
| GET | `/issues/:id/run-changes/:runId/file` | Diff của một tệp trong một lượt chạy |
| GET | `/projects/:projectId/code-view` | Trạng thái bản sao mã nguồn của project |
| POST | `/projects/:projectId/workspaces/:workspaceId/code-view/refresh` | Cập nhật bản sao ngay (nút Update) |
| GET | `/projects/:projectId/workspaces/:workspaceId/file-resources/{list,resolve,content}` | Duyệt và đọc tệp trong tab Code |
| GET | `/companies/:companyId/team-feed` | Các mục của Team feed |

**Trang mới trong giao diện:** `/:company/office`, `/:company/analytics`, `/:company/team-feed`, `/:company/projects/:projectId/code`. Các link không có tiền tố công ty (`/team-feed`, `/projects/:id/code`) tự chuyển hướng về công ty đang chọn.

## Cài đặt và chạy

**Yêu cầu:** Node.js 24.11+, pnpm 9.15 (`corepack enable`), git. Trên Windows nên chạy trong WSL 2 (Ubuntu). Để agent làm việc cần ít nhất một CLI agent đã đăng nhập: Claude Code, OpenCode hoặc Codex.

```sh
git clone https://github.com/huuvietnguyen72/paperclip-multiagent.git
cd paperclip-multiagent
pnpm install
pnpm dev            # API + giao diện ở http://localhost:3100, dùng Postgres nhúng; migration tự chạy
```

Kiểm tra bằng `curl http://localhost:3100/api/health`, rồi mở http://localhost:3100.

**Chạy kèm Telegram:**

```sh
ngrok http 3190                      # chỉ trỏ vào cổng 3190, không bao giờ vào 3100
PAPERCLIP_CHAT_WEBHOOK_PUBLIC_URL=https://<tên-miền-ngrok> ./multiagent/scripts/start-local.sh
```

Script này chạy Paperclip cùng cổng webhook. Sau đó bật Chat connectors trong Instance settings, rồi kết nối bot Telegram ở trang Apps → Chat của công ty.

**Kiểm thử:** mỗi chức năng có test Vitest đi kèm (ví dụ `server/src/__tests__/model-fallback-*.test.ts`, `ui/src/pages/Office.test.tsx`, `ui/src/pages/TeamFeed.test.tsx`). Máy ít RAM nên chạy từng tệp test:

```sh
pnpm exec vitest run <đường-dẫn-test> --maxWorkers=2
```

## Tài liệu thiết kế

Mỗi chức năng có tài liệu thiết kế (mục tiêu, phạm vi, quyết định) và kế hoạch triển khai trong [`doc/plans/`](doc/plans/):

| Chức năng | Thiết kế | Kế hoạch |
|---|---|---|
| Office 3D (và Analytics) | [office-view-design](doc/plans/2026-11-10-office-view-design.md) | [office-view-plan](doc/plans/2026-11-10-office-view-plan.md) |
| Model connections + OpenCode watchdog | [agent-model-fallback-design](doc/plans/2026-11-12-agent-model-fallback-design.md) | [agent-model-fallback-plan](doc/plans/2026-11-12-agent-model-fallback-plan.md) |
| Tab Changes | [run-changes-design](doc/plans/2026-11-22-run-changes-design.md) | [run-changes-plan](doc/plans/2026-11-22-run-changes-plan.md) |
| Tab Code | [project-code-tab-design](doc/plans/2026-11-24-project-code-tab-design.md) | [project-code-tab-plan](doc/plans/2026-11-24-project-code-tab-plan.md) |
| Team feed | [team-feed-design](doc/plans/2026-11-25-team-feed-design.md) | [team-feed-plan](doc/plans/2026-11-25-team-feed-plan.md) |

Tài liệu gốc của Paperclip vẫn nằm trong [`doc/`](doc/), bắt đầu từ `doc/GOAL.md` và `doc/DEVELOPING.md`.

## Ghi công và giấy phép

- Nền tảng: **[Paperclip](https://github.com/paperclipai/paperclip)** © 2025 Paperclip AI, giấy phép MIT. README gốc: <https://github.com/paperclipai/paperclip#readme>.
- Các phần bổ sung trong repo này dùng cùng giấy phép [MIT](LICENSE).
