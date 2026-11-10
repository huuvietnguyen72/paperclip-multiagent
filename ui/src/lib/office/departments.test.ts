import { describe, expect, it } from "vitest";
import { DEPARTMENTS, departmentForRole } from "./departments";
import { strings } from "./strings";

describe("departmentForRole", () => {
  it("maps each team role to its functional department", () => {
    expect(departmentForRole("ceo")).toBe("executive");
    expect(departmentForRole("pm")).toBe("executive");
    expect(departmentForRole("cto")).toBe("analysis");
    expect(departmentForRole("researcher")).toBe("analysis");
    expect(departmentForRole("designer")).toBe("analysis");
    expect(departmentForRole("engineer")).toBe("engineering");
    expect(departmentForRole("devops")).toBe("engineering");
    expect(departmentForRole("qa")).toBe("quality");
    expect(departmentForRole("security")).toBe("quality");
  });

  it("sends unknown or missing roles to engineering", () => {
    expect(departmentForRole("general")).toBe("engineering");
    expect(departmentForRole(undefined)).toBe("engineering");
    expect(departmentForRole(null)).toBe("engineering");
  });

  it("lists departments in spec order", () => {
    expect(DEPARTMENTS.map((d) => d.id)).toEqual(["executive", "analysis", "engineering", "quality"]);
  });
});

describe("strings", () => {
  it("names the departments and shared areas in Vietnamese", () => {
    expect(strings.departments).toEqual({
      executive: "Ban Điều hành",
      analysis: "Phân tích & Thiết kế",
      engineering: "Phòng Kỹ thuật",
      quality: "Kiểm định",
    });
    expect(strings.areas).toEqual({ meeting: "Phòng họp", server: "Phòng server", pantry: "Pantry" });
    expect(strings.assignWork).toBe("Giao việc");
    expect(strings.pageTitle).toBe("Office");
  });
});
