# Thiết kế: Xem thay đổi code theo từng lượt chạy trong trang task ("Changes")

Ngày: 2026-11-22 · Người yêu cầu: chủ instance (board) · Trạng thái: chờ duyệt

## 1. Mục đích và lý do

Người điều hành không xem được agent đã sửa những gì nếu không sang GitHub. Họ muốn mở **một task** trong Paperclip và thấy, theo **từng lượt chạy** của agent:

- những file đã đổi (đường dẫn, số dòng `+/−`);
- nội dung thay đổi dạng Claude Code: dòng xoá nền đỏ, dòng thêm nền xanh;
- các lệnh agent đã chạy trong lượt đó, để hiểu agent đã làm gì để ra kết quả.

Phát hiện khi khảo sát: agent trong instance này **sửa file bằng lệnh terminal** (`cat > file <<EOF`, `sed`, lệnh sinh code), không dùng công cụ Edit có sẵn diff. Ví dụ một lượt chạy của Frontend có 67 lệnh `Terminal` và 0 sự kiện diff. Vì vậy diff phải lấy từ **git**, còn nhật ký chỉ dùng để liệt kê lệnh.

## 2. Mục tiêu / Không làm / Tuyệt đối tránh

**Mục tiêu**
- Mỗi lượt chạy có workspace git cục bộ sẽ được ghi lại "thay đổi của lượt": danh sách file, số dòng thêm/xoá, patch từng file, danh sách lệnh.
- Trang task có tab mới **Changes**, liệt kê các lượt chạy mới nhất trước. Mở một lượt sẽ thấy danh sách file; bấm vào file để xem diff đỏ/xanh (unified, có số dòng).
- Dữ liệu vẫn xem được sau khi workspace bị dọn.

**Không làm (trong đợt này)**
- Tách theo từng lần sửa nhỏ bên trong một lượt chạy.
- Xem dạng hai cột (split), sửa hoặc hoàn tác code từ giao diện, comment theo dòng.
- Diff lấy từ GitHub PR; workspace chạy từ xa hoặc trên cloud sandbox.
- Dựng lại thay đổi cho các lượt chạy cũ trước khi có tính năng (không có ảnh chụp ban đầu nên không làm được).

**Tuyệt đối tránh**
- Việc ghi nhận làm **chậm đáng kể hoặc làm hỏng lượt chạy** của agent. Mọi lỗi khi ghi nhận chỉ được ghi log, không bao giờ làm lượt chạy thất bại.
- Làm thay đổi git của agent: index, nhánh, HEAD, stash hay file trong working tree.
- Hiển thị bí mật: file bị `.gitignore` (ví dụ `.env`) không được ghi nhận; patch và lệnh phải đi qua bộ che bí mật của run log.

## 3. Ràng buộc

- Quy tắc `rules/heartbeat-execution-boundaries.mdc`: không làm phình `heartbeat.ts`. Logic mới nằm trong một module riêng `server/src/services/heartbeat/run-changes.ts`, heartbeat chỉ gọi qua một contract hẹp.
- AGENTS.md §5.2: đồng bộ hợp đồng giữa `packages/db`, `packages/shared`, `server` và `ui`. Bảng mới cần migration và phải được export từ schema index.
- AGENTS.md §5.7: dữ liệu nằm trong DB của instance, thuộc nhóm **run log**, nên không cần privacy review.
- AGENTS.md §8: API phải kiểm tra quyền theo công ty.
- DESIGN.md: chỉ dùng token màu và khoảng cách. Chạy `pnpm check:token-gates`.
- Máy WSL ít RAM: chạy vitest từng file một, `--maxWorkers=2`.
- Làm trong worktree `~/paperclip-run-changes` với instance thử nghiệm riêng. Bản đang chạy (`~/paperclip`) chỉ được merge khi chủ duyệt, và phải sao lưu DB trước.

## 4. Các cách đã cân nhắc

| Cách | Mô tả | Đánh đổi |
|---|---|---|
| 1. Ảnh chụp git đầu và cuối lượt | Chụp trạng thái working tree lúc bắt đầu và kết thúc, sau đó so sánh | Bắt được mọi kiểu sửa (terminal, sinh code, file mới hoặc bị xoá), không phụ thuộc loại agent. Chỉ ra kết quả tổng của cả lượt. |
| 2. Dựng lại từ nhật ký lệnh | Đọc từng lệnh trong run log | Thiếu nội dung cũ khi file bị ghi đè, bỏ sót `sed` và code sinh tự động, phải viết riêng cho từng adapter. Loại. |
| **3. Cách 1 + danh sách lệnh** ✅ | Diff lấy từ git; kèm danh sách lệnh đọc từ run log | Thấy cả kết quả lẫn cách agent làm ra kết quả. Tốn thêm một bộ đọc log cho hai định dạng. |

**Chủ instance chọn cách 3.**

## 5. Thiết kế

### 5.1 Ảnh chụp git

- **Điều kiện:** workspace của lượt chạy là `local_fs`, có `cwd`, và `cwd` nằm trong một repo git. Không thoả thì bỏ qua lặng lẽ, không có tab dữ liệu cho lượt đó.
- **Cách chụp mà không đụng vào git của agent:** dùng một index tạm, `GIT_INDEX_FILE=<tmp>`.
  1. `git read-tree HEAD`, vào index tạm.
  2. `git add -A`, vào index tạm. Bước này tôn trọng `.gitignore`, nên `node_modules` và `.env` bị loại.
  3. `git write-tree`. Kết quả là SHA của cây. Ghi lại cùng SHA của `HEAD`.
  4. Xoá index tạm.
  - Các object git tạo ra là object rời, không gắn ref nào. Git có thể dọn chúng sau này, điều đó không sao vì patch đã được lưu vào DB.
- **Thời điểm:**
  - *Đầu lượt:* ngay sau khi workspace được chuẩn bị xong, trước khi adapter chạy.
  - *Cuối lượt:* khi lượt chạy được chốt, với mọi trạng thái kết thúc: thành công, thất bại hoặc bị huỷ.
  - *Server chết giữa chừng:* nếu lượt được chốt lại qua đường recovery (`process_lost`) và workspace vẫn còn, thì chụp ảnh cuối khi chốt. Nếu workspace không còn, ghi trạng thái `incomplete`.
- **Giới hạn thời gian:** mỗi lần chụp tối đa 20 giây, quá thì bỏ (`skipped: timeout`). Chạy nền sao cho không chặn việc chốt trạng thái lượt chạy.

### 5.2 Tính diff

- `git diff --numstat -M <startTree> <endTree>` cho danh sách file: đường dẫn, trạng thái A/M/D/R kèm đường dẫn cũ, số dòng thêm/xoá, có phải file nhị phân không.
- `git diff -M --patch <startTree> <endTree> -- <file>` cho patch từng file.
- **Giới hạn lưu trữ:**
  - mỗi file tối đa 2.000 dòng hoặc 256 KB patch; vượt thì cắt và đánh dấu `truncated`;
  - mỗi lượt tối đa 300 file và 4 MB tổng; vượt thì chỉ giữ thống kê cho phần dư;
  - file nhị phân chỉ ghi "binary".
- **Che bí mật:** patch đi qua cùng bộ che bí mật của run log (`run-log.ts`) trước khi lưu.
- **File thường thu gọn trên giao diện** (nhưng vẫn lưu): lockfile (`package-lock.json`, `pnpm-lock.yaml`…) và file sinh tự động có header "generated". Ví dụ `apps/web/src/api/schema.d.ts`.
- **Lượt chạy song song trên cùng workspace:** ví dụ hai task dùng chung `shared_workspace`. Nếu trong khoảng thời gian của lượt có lượt khác cũng đang chạy trên workspace đó, lưu `overlappingRunIds`, và giao diện ghi chú "có thể gồm thay đổi của lượt chạy khác".

### 5.3 Danh sách lệnh

Đọc từ run log của lượt chạy khi chốt:

| Adapter | Sự kiện | Lấy gì |
|---|---|---|
| `claude_local` (ACP) | `acpx.tool_call` | `title` (chính là lệnh terminal) và loại công cụ (`Terminal`, `bash`…) |
| `opencode_local` | `tool_use` | `part.tool` (`bash`, `edit`, `write`…) và `part.state.input` (lệnh hoặc `filePath`) |

- Giữ tối đa 200 mục theo thứ tự thời gian. Mỗi mục cắt còn 500 ký tự, kèm thời điểm. Áp dụng cùng bộ che bí mật.
- Bỏ các công cụ chỉ đọc, gây nhiễu (`read`, `glob`, `ToolSearch`, `skill`). Giữ lệnh shell và các thao tác ghi hoặc sửa file.

### 5.4 Dữ liệu

Bảng mới `heartbeat_run_changes`, mỗi lượt chạy một dòng:

| Cột | Nội dung |
|---|---|
| `id`, `company_id`, `run_id` (unique), `issue_id`, `agent_id`, `execution_workspace_id` | Khoá và quan hệ |
| `status` | `captured` / `no_changes` / `skipped` / `incomplete` / `failed` |
| `start_head`, `start_tree`, `end_head`, `end_tree` | SHA |
| `files` (jsonb) | `[{path, oldPath?, status, additions, deletions, binary, truncated, collapsedByDefault}]` |
| `patches` | Lưu theo file, giới hạn như §5.2. Có thể là một bảng con `heartbeat_run_change_files`, việc chọn để builder quyết. |
| `commands` (jsonb) | `[{ts, tool, text}]` |
| `overlapping_run_ids` (jsonb), `note`, `created_at`, `updated_at` | |

### 5.5 API

Đều kiểm tra quyền xem task và công ty (board, hoặc agent có quyền với task):

- `GET /api/issues/:id/run-changes`: danh sách lượt chạy của task có dữ liệu thay đổi, mới nhất trước. Mỗi mục gồm: run, agent, thời gian, trạng thái lượt chạy, tổng `+/−`, số file, `files[]` (không kèm patch), `commands[]`, ghi chú.
- `GET /api/heartbeat-runs/:runId/changes/file?path=...`: patch của một file. Giao diện chỉ tải khi người dùng mở file đó.

### 5.6 Giao diện: tab "Changes" trong trang task

Đặt cạnh các tab hiện có của `IssueDetail` (chat, activity, related-work).

```
Changes
▾ 19/11 14:32 · FE · succeeded · 3 files  +120 −8
    Commands run (12) ▸
    apps/web/src/components/calendar/WeekCalendar.tsx   A  +96  −0
    apps/web/src/components/calendar/vi.json            A  +9   −0
    apps/web/src/pages/StudentBookings.tsx              M  +15  −8   ◀ đang mở
    ┌──────────────────────────────────────────────────────────┐
    │ @@ -40,8 +40,15 @@                                         │
    │ 40  40   const { data } = useBookings();                  │
    │ 41     − return <List items={data} />;          (nền đỏ)  │
    │     41 + const [view, setView] = useState('list');(xanh)  │
    └──────────────────────────────────────────────────────────┘
▸ 19/11 14:05 · FE · succeeded · 1 file  +4 −2
▸ 19/11 13:50 · FE · failed · no changes
```

- Diff dạng unified: hai cột số dòng (cũ, mới), dấu `+`/`−`, nền đỏ và xanh lấy từ token màu. Có header hunk `@@`. Phần không đổi dài thì thu gọn ("… 25 dòng không đổi").
- File thu gọn mặc định (lockfile, file sinh tự động) hiện một dòng "đã thu gọn", bấm để mở.
- Lượt `skipped`, `incomplete` hoặc `failed` hiện lý do ngắn. Lượt `no_changes` gom lại thành một dòng mờ.
- Tab hiện số lượt có thay đổi. Task không có dữ liệu nào thì hiện trạng thái trống giải thích ngắn.
- Nhãn giao diện bằng tiếng Anh, theo yêu cầu trước đây của chủ là giao diện tiếng Anh.

## 6. Kiểm thử

- **Server:** test với repo git tạm, gồm:
  - sửa, thêm, xoá, đổi tên file;
  - file nhị phân, file bị `.gitignore`;
  - có commit giữa lượt chạy;
  - workspace không phải git;
  - quá thời gian chụp, vượt giới hạn kích thước;
  - kiểm tra index, nhánh và HEAD của agent không đổi.
- **Bộ đọc lệnh:** fixture nhật ký thật (đã che bí mật) của cả `claude_local` (ACP) và `opencode_local`.
- **Route:** kiểm tra quyền giữa các công ty, task không tồn tại, file không có trong lượt.
- **UI:** component diff (hunk, thu gọn, nhị phân, cắt bớt) và tab (rỗng, nhiều lượt).
- **Kiểm chứng thực tế:** trên instance thử nghiệm, cho một agent sửa file bằng terminal, rồi xem tab Changes hiển thị đúng.

## 7. Các quyết định nhỏ đã chốt (người viết thiết kế tự quyết, chủ có thể sửa)

- **Phạm vi hiển thị:** tab của một task chỉ hiện các lượt chạy có ngữ cảnh là đúng task đó. Lượt chạy của task con hiện ở task con. Lượt chạy không gắn task (ví dụ heartbeat theo giờ) vẫn được ghi nhận nhưng không có chỗ hiện trong đợt này.
- **Đổi nhánh giữa lượt:** nếu nhánh hoặc `HEAD` lúc kết thúc khác lúc bắt đầu theo kiểu chuyển nhánh (không phải commit nối tiếp), vẫn lưu diff và hiện ghi chú "agent đã đổi nhánh trong lượt này; thay đổi có thể gồm khác biệt giữa hai nhánh".
- **Lưu trữ:** giữ vô thời hạn, có giới hạn kích thước như §5.2. Chưa có cơ chế dọn dẹp; sẽ thêm khi cần.
- **Quyền đọc:** board và agent có quyền với task đều đọc được, chỉ đọc. Tech Lead có thể dùng khi review.

## 8. Để builder quyết

- Patch lưu ở cột jsonb hay bảng con; cách gom lại khi tải.
- Vị trí gọi chính xác trong `workspace-preparation.ts` / `run-completion.ts` / recovery, miễn đúng thời điểm ở §5.1 và không làm phình coordinator.
- Thư viện hay tự viết bộ phân tích patch unified ở UI. Có thể tham khảo `ui/src/lib/line-diff.ts` và `DocumentDiffModal`.
