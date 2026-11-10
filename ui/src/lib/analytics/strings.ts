// User-visible copy of the Analytics page. The nav label and page title stay English (owner's choice);
// everything inside the page is Vietnamese like the Office page.
export const analyticsStrings = Object.freeze({
  pageTitle: "Analytics",
  presets: Object.freeze({ today: "Hôm nay", yesterday: "Hôm qua", "7d": "7 ngày", "30d": "30 ngày" }),
  from: "Từ ngày",
  to: "Đến ngày",
  work: Object.freeze({
    title: "Thời gian làm việc của agent",
    perHour: "Mỗi điểm = 1 giờ · số phút làm việc trong giờ đó",
    perDay: "Mỗi điểm = 1 ngày · số giờ làm việc trong ngày",
    legendHint: "Bấm tên agent để ẩn/hiện",
    tableAgent: "Agent",
    tableTotal: "Tổng thời gian",
    approximate: "Một số agent có quá nhiều lượt chạy trong khoảng này; số liệu những ngày đầu có thể thiếu.",
  }),
  models: Object.freeze({
    title: "Token theo model",
    subtitle: "Bấm một model để xem các agent đã dùng model đó",
    ranking: "Model đã dùng",
    topAgents: (label: string) => `Agent dùng ${label}`,
    tokens: "token",
  }),
  empty: "Chưa có dữ liệu trong khoảng thời gian này.",
  loading: "Đang tải…",
  loadError: "Không tải được dữ liệu thống kê.",
});

/** "50 phút", "2 giờ 05 phút". */
export function formatMinutes(minutes: number): string {
  const total = Math.round(Math.max(0, minutes));
  if (total < 60) return `${total} phút`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `${hours} giờ` : `${hours} giờ ${String(rest).padStart(2, "0")} phút`;
}
